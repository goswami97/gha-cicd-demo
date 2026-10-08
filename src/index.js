import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);
const server = createServer(app.handler);

server.listen(config.port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: `listening on http://localhost:${config.port}`,
      environment: config.environment,
      version: config.version,
      commit: config.commit,
      pod: config.pod,
    }),
  );
});

// Graceful shutdown: on SIGTERM, fail /readyz first so Kubernetes stops routing traffic here,
// give endpoint removal a moment to propagate, then stop accepting connections.
// Locally (outside Kubernetes) there's nothing to drain, so Ctrl+C exits immediately.
const drainMs = Number(process.env.SHUTDOWN_DELAY_MS ?? (process.env.KUBERNETES_SERVICE_HOST ? 5000 : 0));

function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', msg: `${signal} received, draining for ${drainMs}ms` }));
  app.state.ready = false;
  setTimeout(() => server.close(() => process.exit(0)), drainMs);
  setTimeout(() => process.exit(1), drainMs + 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
