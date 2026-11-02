import { it } from 'node:test';
import assert from 'node:assert/strict';
import { projectReady, validateApiConfig, waitForPreview } from './wait-preview.js';

const ready = {
  sync: 'synced', lastDeploy: { status: 'synced', commitSHA: 'a'.repeat(40) },
  health: { total: 1, running: 1, healthy: 1, unhealthy: 0 },
  containers: [{ State: 'running', Health: 'healthy' }],
};

it('rejects stale, failed, starting, and missing deployments', () => {
  assert.equal(projectReady(ready, () => true, true), true);
  assert.equal(projectReady(ready, () => false, true), false);
  assert.equal(projectReady({ ...ready, lastDeploy: { ...ready.lastDeploy, status: 'failed' } }, () => true), false);
  assert.equal(projectReady({ ...ready, containers: [{ State: 'running', Health: 'starting' }] }, () => true), false);
  assert.equal(projectReady(null, () => true), false);
  assert.equal(projectReady({ ...ready, health: { ...ready.health, healthy: 0 } }, () => true, true), false);
});

it('requires HTTPS and an API secret', () => {
  assert.throws(() => validateApiConfig({ DOCKER_CD_URL: 'http://cd.example.com', DOCKER_CD_API_SECRET: 'test' }), /HTTPS/);
  assert.throws(() => validateApiConfig({ DOCKER_CD_URL: 'https://cd.example.com' }), /secrets/);
});

it('waits for both deployments, never treating login HTML or an error as readiness/removal', async () => {
  const oldUrl = process.env.DOCKER_CD_URL;
  const oldSecret = process.env.DOCKER_CD_API_SECRET;
  process.env.DOCKER_CD_URL = 'https://cd.example.com';
  process.env.DOCKER_CD_API_SECRET = 'test';
  const opts = { appPath: 'apps/demo', prNumber: '42', commit: 'a'.repeat(40), matches: () => true, sleep: async () => {}, attempts: 2 };
  try {
    let calls = 0;
    await waitForPreview({ ...opts, fetchFn: async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer test');
      calls++;
      return Response.json({ success: true, data: calls <= 2 ? { ...ready, sync: 'out-of-sync' } : ready });
    } });
    assert.equal(calls, 4);
    await assert.rejects(() => waitForPreview({ ...opts, fetchFn: async () => new Response('<html>login</html>') }), /Timed out/);
    await assert.rejects(() => waitForPreview({ ...opts, fetchFn: async () => new Response('', { status: 401 }) }), /authentication/);
    const cleanupFetch = (status) => async (url) => url.endsWith('/tinyauth') ? Response.json({ success: true, data: ready }) : new Response('', { status });
    await waitForPreview({ ...opts, cleanup: true, fetchFn: cleanupFetch(404) });
    await assert.rejects(() => waitForPreview({ ...opts, cleanup: true, fetchFn: cleanupFetch(503) }), /Timed out/);
  } finally {
    if (oldUrl === undefined) delete process.env.DOCKER_CD_URL; else process.env.DOCKER_CD_URL = oldUrl;
    if (oldSecret === undefined) delete process.env.DOCKER_CD_API_SECRET; else process.env.DOCKER_CD_API_SECRET = oldSecret;
  }
});
