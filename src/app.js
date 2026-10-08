import { readFileSync } from 'node:fs';
import { Metrics } from './metrics.js';

// Only these files are served, so there's no path-traversal surface. They're read once at
// startup, which also lets the container run with a read-only root filesystem.
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function createApp(config, { publicDir = new URL('../public/', import.meta.url) } = {}) {
  const metrics = new Metrics();
  const startedAt = Date.now();
  // ready=false during graceful shutdown; failing=true when chaos mode is switched on.
  const state = { ready: true, failing: false };

  const assets = Object.fromEntries(
    Object.entries(STATIC_FILES).map(([path, [file, type]]) => [path, { body: readFileSync(new URL(file, publicDir)), type }]),
  );

  const info = () => ({
    name: config.name,
    version: config.version,
    commit: config.commit,
    commitUrl: config.commitUrl,
    buildTime: config.buildTime,
    environment: config.environment,
    message: config.message,
    pod: config.pod,
    node: process.version,
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requestsServed: metrics.totalRequests,
    failing: state.failing,
    chaosEnabled: config.chaosEnabled,
  });

  async function route(req, path) {
    const key = `${req.method} ${path}`;
    switch (key) {
      case 'GET /api/info':
        return ['/api/info', 200, JSON.stringify(info()), JSON_TYPE];
      case 'GET /healthz':
        return state.failing
          ? ['/healthz', 503, JSON.stringify({ status: 'failing' }), JSON_TYPE]
          : ['/healthz', 200, JSON.stringify({ status: 'ok' }), JSON_TYPE];
      case 'GET /readyz': {
        const ok = state.ready && !state.failing;
        return ['/readyz', ok ? 200 : 503, JSON.stringify({ status: ok ? 'ready' : 'not ready' }), JSON_TYPE];
      }
      case 'GET /metrics':
        return ['/metrics', 200, metrics.render(config, startedAt), 'text/plain; version=0.0.4; charset=utf-8'];
      case 'POST /api/chaos': {
        if (!config.chaosEnabled) {
          return ['/api/chaos', 403, JSON.stringify({ error: `chaos mode is disabled in ${config.environment}` }), JSON_TYPE];
        }
        // Requiring a JSON content type stops plain cross-site form posts from toggling it.
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return ['/api/chaos', 415, JSON.stringify({ error: 'expected application/json' }), JSON_TYPE];
        }
        const body = await readJsonBody(req);
        state.failing = Boolean(body.failing);
        console.log(JSON.stringify({ level: 'warn', msg: `chaos mode ${state.failing ? 'ON' : 'OFF'}`, pod: config.pod }));
        return ['/api/chaos', 200, JSON.stringify({ failing: state.failing }), JSON_TYPE];
      }
    }
    if (req.method === 'GET' && assets[path]) {
      return [path, 200, assets[path].body, assets[path].type];
    }
    return ['other', 404, JSON.stringify({ error: 'not found' }), JSON_TYPE];
  }

  async function handler(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    let result;
    try {
      result = await route(req, path);
    } catch {
      result = ['other', 400, JSON.stringify({ error: 'bad request' }), JSON_TYPE];
    }
    const [routeName, status, body, type] = result;
    metrics.observe(routeName, req.method, status);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  }

  return { handler, state };
}
