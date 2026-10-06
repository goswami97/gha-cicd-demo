import { mkdirSync, writeFileSync } from 'node:fs';
import { greet } from './greeting.js';

const outDir = 'dist';
mkdirSync(outDir, { recursive: true });

const buildTime = new Date().toISOString();
const sha = process.env.GITHUB_SHA ?? 'local';
const envName = process.env.DEPLOY_ENV ?? 'local';

const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>CI/CD Demo</title></head>
<body>
  <h1>${greet('DevOps Engineer')}</h1>
  <p>Environment: <strong>${envName}</strong></p>
  <p>Commit: <code>${sha}</code></p>
  <p>Built: ${buildTime}</p>
</body>
</html>
`;

writeFileSync(`${outDir}/index.html`, html);
console.log(`Built dist/index.html for env=${envName} sha=${sha}`);
