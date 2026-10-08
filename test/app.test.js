import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const SHA = 'a0beafdebda236e0f105cb052eab7d1afdeb1209';

async function startServer(env, buildInfo = { commit: SHA, buildTime: '2026-10-08T12:00:00.000Z' }) {
  const app = createApp(loadConfig(env, buildInfo));
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  return { app, server, base };
}

const postChaos = (base, failing, headers = { 'Content-Type': 'application/json' }) =>
  fetch(`${base}/api/chaos`, { method: 'POST', headers, body: JSON.stringify({ failing }) });

describe('loadConfig', () => {
  test('defaults to local when DEPLOY_ENV is unset', () => {
    const config = loadConfig({}, { commit: 'local', buildTime: null });
    assert.equal(config.environment, 'local');
    assert.equal(config.port, 3000);
    assert.equal(config.commitUrl, null);
  });

  test('links the commit only for a real SHA', () => {
    assert.match(loadConfig({}, { commit: SHA }).commitUrl, new RegExp(`/commit/${SHA}$`));
    assert.equal(loadConfig({}, { commit: 'abc123' }).commitUrl, null);
  });

  test('disables chaos in production unless explicitly allowed', () => {
    assert.equal(loadConfig({ DEPLOY_ENV: 'qa' }, {}).chaosEnabled, true);
    assert.equal(loadConfig({ DEPLOY_ENV: 'production' }, {}).chaosEnabled, false);
    assert.equal(loadConfig({ DEPLOY_ENV: 'production', ALLOW_CHAOS: 'true' }, {}).chaosEnabled, true);
    assert.equal(loadConfig({ DEPLOY_ENV: 'qa', ALLOW_CHAOS: 'false' }, {}).chaosEnabled, false);
  });
});

describe('http app (qa)', () => {
  let ctx;
  before(async () => {
    ctx = await startServer({ DEPLOY_ENV: 'qa', HOSTNAME: 'gha-cicd-demo-abc12', BANNER_MESSAGE: 'hi' });
  });
  after(() => ctx.server.close());

  test('GET /api/info reports build and runtime metadata', async () => {
    const res = await fetch(`${ctx.base}/api/info`);
    assert.equal(res.status, 200);
    const info = await res.json();
    assert.equal(info.environment, 'qa');
    assert.equal(info.commit, SHA);
    assert.equal(info.pod, 'gha-cicd-demo-abc12');
    assert.equal(info.message, 'hi');
    assert.equal(info.failing, false);
    assert.equal(typeof info.version, 'string');
  });

  test('GET / serves the dashboard with security headers', async () => {
    const res = await fetch(`${ctx.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await res.text(), /Release Dashboard/);
  });

  test('unknown and traversal paths return 404', async () => {
    assert.equal((await fetch(`${ctx.base}/nope`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/%2e%2e/package.json`)).status, 404);
  });

  test('chaos mode fails health and readiness, and can be healed', async () => {
    assert.equal((await fetch(`${ctx.base}/healthz`)).status, 200);
    assert.equal((await postChaos(ctx.base, true)).status, 200);
    assert.equal((await fetch(`${ctx.base}/healthz`)).status, 503);
    assert.equal((await fetch(`${ctx.base}/readyz`)).status, 503);
    assert.equal((await postChaos(ctx.base, false)).status, 200);
    assert.equal((await fetch(`${ctx.base}/healthz`)).status, 200);
  });

  test('chaos requires a JSON content type', async () => {
    assert.equal((await postChaos(ctx.base, true, { 'Content-Type': 'text/plain' })).status, 415);
  });

  test('readiness fails while shutting down, liveness stays up', async () => {
    ctx.app.state.ready = false;
    try {
      assert.equal((await fetch(`${ctx.base}/readyz`)).status, 503);
      assert.equal((await fetch(`${ctx.base}/healthz`)).status, 200);
    } finally {
      ctx.app.state.ready = true;
    }
  });

  test('GET /metrics exposes Prometheus metrics', async () => {
    await fetch(`${ctx.base}/healthz`);
    const body = await (await fetch(`${ctx.base}/metrics`)).text();
    assert.match(body, /^app_info\{version="[^"]+",commit="[0-9a-f]{40}",environment="qa"\} 1$/m);
    assert.match(body, /^http_requests_total\{route="\/healthz",method="GET",status="200"\} \d+$/m);
    assert.match(body, /^process_uptime_seconds \d/m);
  });
});

describe('http app (production)', () => {
  let ctx;
  before(async () => {
    ctx = await startServer({ DEPLOY_ENV: 'production' });
  });
  after(() => ctx.server.close());

  test('chaos is forbidden', async () => {
    assert.equal((await postChaos(ctx.base, true)).status, 403);
    assert.equal((await fetch(`${ctx.base}/healthz`)).status, 200);
  });
});
