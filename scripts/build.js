// Assembles the runnable artifact in dist/: app source, static assets, a trimmed package.json,
// and build-info.json with the commit SHA and build time. The environment name is NOT baked in:
// the same image is promoted development -> qa -> production and reads DEPLOY_ENV at runtime.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const outDir = 'dist';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync(outDir, { recursive: true, force: true });
cpSync('src', `${outDir}/src`, { recursive: true });
cpSync('public', `${outDir}/public`, { recursive: true });

const { name, version, type, repository } = pkg;
writeFileSync(`${outDir}/package.json`, `${JSON.stringify({ name, version, type, repository }, null, 2)}\n`);

const buildInfo = { commit: process.env.GITHUB_SHA ?? 'local', buildTime: new Date().toISOString() };
writeFileSync(`${outDir}/build-info.json`, `${JSON.stringify(buildInfo, null, 2)}\n`);

// Smoke-check the artifact: fails the build if the assembled app can't load.
const { createApp } = await import(pathToFileURL(`${outDir}/src/app.js`));
const { loadConfig } = await import(pathToFileURL(`${outDir}/src/config.js`));
createApp(loadConfig());

console.log(`Built ${outDir}/ for ${name}@${version} commit=${buildInfo.commit}`);
