import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// build-info.json is written by scripts/build.js (commit SHA + build time). It doesn't exist
// when running straight from the repo with `npm start`, so fall back to local values.
function readBuildInfo() {
  try {
    return JSON.parse(readFileSync(new URL('../build-info.json', import.meta.url), 'utf8'));
  } catch {
    return { commit: 'local', buildTime: null };
  }
}

export function loadConfig(env = process.env, buildInfo = readBuildInfo()) {
  const environment = env.DEPLOY_ENV || 'local';
  const repoUrl = pkg.repository?.url?.replace(/\.git$/, '') ?? null;
  const commit = buildInfo.commit ?? 'local';

  return {
    // 3000 for local runs (8080 is usually taken by the ArgoCD port-forward); the Dockerfile sets PORT=8080.
    port: Number(env.PORT) || 3000,
    environment,
    // Kubernetes sets HOSTNAME to the pod name, which shows which replica served the request.
    pod: env.HOSTNAME || hostname(),
    message: env.BANNER_MESSAGE ?? '',
    // The "break this pod" button is on everywhere except production, unless explicitly allowed.
    chaosEnabled: env.ALLOW_CHAOS ? env.ALLOW_CHAOS === 'true' : environment !== 'production',
    name: pkg.name,
    version: pkg.version,
    commit,
    commitUrl: repoUrl && /^[0-9a-f]{40}$/.test(commit) ? `${repoUrl}/commit/${commit}` : null,
    buildTime: buildInfo.buildTime ?? null,
  };
}
