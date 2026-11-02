import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pushPreview } from './temp-push.js';
import { authPath, adminAllow, updateAccess, authEnvironment, previewId } from './preview-access.js';
import { deployedRevisionMatches } from './wait-preview.js';

it('reapplies concurrent registration and cleanup against main without losing other rules', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-git-'));
  const cwd = process.cwd();
  const git = (where, ...args) => execFileSync('git', args, { cwd: where, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = path.join(dir, 'remote.git');
  const first = path.join(dir, 'first');
  const second = path.join(dir, 'second');
  const original = 'x-docker-cd:\n  rolling_update: false\nservices:\n  tinyauth:\n    environment:\n      TINYAUTH_AUTH_ACLS_POLICY: deny\n';
  const rule = (pr, allowlist = adminAllow) => ({ appPath: 'apps/demo', prNumber: pr, hostname: `pr-${pr}-demo.example.com`, allowlist });
  try {
    git(dir, 'init', '--bare', '--initial-branch=main', remote);
    git(dir, 'clone', remote, first);
    git(first, 'config', 'user.name', 'Test');
    git(first, 'config', 'user.email', 'test@example.com');
    fs.mkdirSync(path.join(first, 'apps/tinyauth'), { recursive: true });
    fs.writeFileSync(path.join(first, authPath), original);
    git(first, 'add', '.'); git(first, 'commit', '-m', 'initial'); git(first, 'push', 'origin', 'main');
    git(dir, 'clone', remote, second);
    git(second, 'config', 'user.name', 'Test'); git(second, 'config', 'user.email', 'test@example.com');
    process.chdir(first);
    let attempts = 0;
    const result = await pushPreview({ paths: [authPath], message: 'preview 42', prepare: async () => {
      attempts++;
      fs.writeFileSync(authPath, updateAccess(fs.readFileSync(authPath, 'utf8'), rule('42')));
      if (attempts === 1) {
        fs.writeFileSync(path.join(second, authPath), updateAccess(original, rule('43')));
        git(second, 'add', '.'); git(second, 'commit', '-m', 'preview 43'); git(second, 'push', 'origin', 'main');
      }
      return {};
    } });
    assert.equal(attempts, 2);
    const env = authEnvironment(fs.readFileSync(authPath, 'utf8'));
    for (const pr of ['42', '43']) assert.equal(env[`TINYAUTH_APPS_${previewId('apps/demo', pr)}_OAUTH_WHITELIST`], adminAllow);
    const repeat = await pushPreview({ paths: [authPath], message: 'repeat', prepare: async () => {
      fs.writeFileSync(authPath, updateAccess(fs.readFileSync(authPath, 'utf8'), rule('42')));
    } });
    assert.equal(repeat.commit, result.commit);
    git(second, 'pull', '--ff-only');
    let removals = 0;
    const removed = await pushPreview({ paths: [authPath], message: 'remove 42', prepare: async () => {
      removals++;
      fs.writeFileSync(authPath, updateAccess(fs.readFileSync(authPath, 'utf8'), rule('42', null)));
      if (removals === 1) {
        const file = path.join(second, authPath);
        fs.writeFileSync(file, updateAccess(fs.readFileSync(file, 'utf8'), rule('44')));
        git(second, 'add', '.'); git(second, 'commit', '-m', 'preview 44'); git(second, 'push', 'origin', 'main');
      }
    } });
    assert.equal(removals, 2);
    const after = authEnvironment(fs.readFileSync(authPath, 'utf8'));
    assert.equal(after[`TINYAUTH_APPS_${previewId('apps/demo', '42')}_CONFIG_DOMAIN`], undefined);
    for (const pr of ['43', '44']) assert.equal(after[`TINYAUTH_APPS_${previewId('apps/demo', pr)}_OAUTH_WHITELIST`], adminAllow);
    assert.equal(deployedRevisionMatches(result.commit, removed.commit, { appPath: 'apps/demo', prNumber: '43', auth: true }), true);
    assert.equal(deployedRevisionMatches(result.commit, removed.commit, { appPath: 'apps/demo', prNumber: '42', auth: true }), false);
    assert.equal(deployedRevisionMatches(removed.commit, result.commit, { appPath: 'apps/demo', prNumber: '42', auth: true }), false);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
