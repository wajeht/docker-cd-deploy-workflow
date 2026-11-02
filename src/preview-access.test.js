import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { adminAllow, usersAllow, authEnvironment, inheritedAllowlist, previewId, updateAccess } from './preview-access.js';
import { main as deploy } from './temp-compose.js';
import { main as cleanup } from './temp-cleanup.js';

export const config = `x-docker-cd:
  rolling_update: false
services:
  tinyauth:
    # lint-ignore: backup
    image: tinyauth:v5
    environment:
      TINYAUTH_AUTH_ACLS_POLICY: deny
      TINYAUTH_APPS_ADMIN_CONFIG_DOMAIN: admin.example.com
      TINYAUTH_APPS_ADMIN_OAUTH_WHITELIST: \${TINYAUTH_ADMIN_ALLOW:?required}
      TINYAUTH_APPS_USERS_CONFIG_DOMAIN: users.example.com
      TINYAUTH_APPS_USERS_OAUTH_WHITELIST: \${TINYAUTH_USERS_ALLOW:?required}
      TZ: America/Chicago
`;
const options = { appPath: 'apps/demo', prNumber: '42', hostname: 'pr-42-demo.example.com', allowlist: adminAllow };
const app = (host = 'admin.example.com', middleware = 'tinyauth@file') => ({ services: { demo: { image: 'ghcr.io/test/demo:old', labels: [
  `traefik.http.routers.demo.rule=Host(\`${host}\`)`,
  `traefik.http.routers.demo.middlewares=${middleware}`,
] } } });

describe('preview access rules', () => {
  it('registers exactly one OAuth rule and preserves all production text', () => {
    const result = updateAccess(config, options);
    const env = authEnvironment(result);
    const id = previewId(options.appPath, options.prNumber);
    assert.equal(env[`TINYAUTH_APPS_${id}_CONFIG_DOMAIN`], options.hostname);
    assert.equal(env[`TINYAUTH_APPS_${id}_OAUTH_WHITELIST`], adminAllow);
    assert.equal(updateAccess(result, { ...options, allowlist: null }), config);
    assert.equal(updateAccess(result, options), result);
    assert.ok(!result.includes('BASICAUTH'));
  });
  it('removes only the owned rule and rejects an unowned collision', () => {
    const other = { ...options, prNumber: '43', hostname: 'pr-43-demo.example.com' };
    const second = updateAccess(config, other);
    const both = updateAccess(second, options);
    assert.equal(updateAccess(both, { ...options, allowlist: null }), second);
    const unowned = updateAccess(config, options).split('\n').filter((line) => !line.includes('# preview-access:')).join('\n');
    assert.throws(() => updateAccess(unowned, options), /unowned/);
  });
  it('inherits admin and users allowlists, including middleware chains and map labels', () => {
    const env = authEnvironment(config);
    assert.equal(inheritedAllowlist(app().services, env), adminAllow);
    const users = app('users.example.com', 'rate-limit@file,tinyauth-no-ratelimit@file');
    users.services.demo.labels = Object.fromEntries(users.services.demo.labels.map((label) => label.split('=')));
    assert.equal(inheritedAllowlist(users.services, env), usersAllow);
    assert.equal(inheritedAllowlist(app('users.example.com', 'rate-limit@file').services, env), null);
    assert.throws(() => inheritedAllowlist(app('unknown.example.com').services, env), /Expected one/);
    assert.throws(() => inheritedAllowlist({ ...app().services, users: app('users.example.com').services.demo }, env), /different/);
  });
  it('fails closed for default allow or rolling updates', () => {
    assert.throws(() => updateAccess(config.replace('POLICY: deny', 'POLICY: allow'), options), /deny/);
    assert.throws(() => updateAccess(config.replace('rolling_update: false', 'rolling_update: true'), options), /recreation/);
  });
  it('handles inherited auth, explicit admin, public transitions, and cleanup after a missing stack', async () => {
    const cwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-access-'));
    try {
      process.chdir(dir);
      fs.mkdirSync('apps/tinyauth', { recursive: true });
      fs.mkdirSync('apps/demo', { recursive: true });
      fs.writeFileSync('apps/tinyauth/docker-compose.yml', config);
      const run = async (doc, middleware = '') => {
        fs.writeFileSync('apps/demo/docker-compose.yml', yaml.dump(doc));
        return deploy(['--manage-access', '--app-path', 'apps/demo', '--service-name', 'demo', '--pr-number', '42', '--tag', 'new', '--repo-owner', 'test', '--auth-middleware', middleware]);
      };
      const read = () => fs.readFileSync('apps/tinyauth/docker-compose.yml', 'utf8');
      const key = `TINYAUTH_APPS_${previewId('apps/demo', '42')}_OAUTH_WHITELIST`;
      await run(app('users.example.com'));
      assert.equal(authEnvironment(read())[key], usersAllow);
      await run(app('users.example.com'), 'tinyauth@file');
      assert.equal(authEnvironment(read())[key], adminAllow);
      await run(app('users.example.com', 'rate-limit@file'));
      assert.equal(read(), config);
      await run(app('users.example.com', 'rate-limit@file'), 'tinyauth@file');
      fs.rmSync('apps/demo-pr-42', { recursive: true });
      await cleanup(['--manage-access', '--app-path', 'apps/demo', '--pr-number', '42']);
      await cleanup(['--manage-access', '--app-path', 'apps/demo', '--pr-number', '42']);
      assert.equal(read(), config);
      fs.rmSync('apps/tinyauth', { recursive: true });
      await assert.rejects(() => run(app()), /missing/);
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
