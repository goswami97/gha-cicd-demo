# gha-cicd-demo

A learning project for a real-world GitHub Actions CI/CD + GitOps pipeline: lint/test/build, SonarCloud quality gate, Docker build, Trivy vulnerability scan, GHCR registry, and ArgoCD-based deployment to Kubernetes (minikube), with three environments: development (auto), qa (on-demand), and production (gated, promotes only from qa).

## The app: Release Dashboard

A zero-dependency Node.js server (built-in `node:http` only) that shows what the pipeline deployed: environment (colour-coded — development blue, qa amber, production green), version, commit (linked to GitHub), build time, which pod served the request, uptime and live health.

| Endpoint | Purpose |
|---|---|
| `/` | Dashboard UI |
| `/api/info` | Same data as JSON — use it for post-deploy smoke tests |
| `/healthz` | Liveness probe |
| `/readyz` | Readiness probe — returns 503 during graceful shutdown (SIGTERM) |
| `/metrics` | Prometheus metrics (`app_info`, `http_requests_total`, uptime, memory) |
| `POST /api/chaos` | `{"failing": true}` makes `/healthz` fail so Kubernetes restarts the pod. Disabled in production unless `ALLOW_CHAOS=true` |

Runtime config (env vars): `DEPLOY_ENV`, `PORT` (3000 locally; the image sets 8080), `BANNER_MESSAGE`, `ALLOW_CHAOS`. The commit SHA and build time are baked in at build time (`scripts/build.js` → `dist/build-info.json`); the environment is read at runtime, because one image is promoted through all three tiers.

### Run locally

```bash
npm ci
npm test && npm run lint
npm run dev                                   # http://localhost:3000, restarts on file changes
DEPLOY_ENV=qa BANNER_MESSAGE="hello" npm start  # preview another environment's look
```

In Docker, exactly as Kubernetes runs it (non-root, read-only filesystem). Host port 3000, because 8080 is taken by the ArgoCD port-forward:

```bash
docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t gha-cicd-demo:local .
docker run --rm -p 3000:8080 -e DEPLOY_ENV=production --read-only --cap-drop ALL gha-cicd-demo:local
trivy image --severity CRITICAL,HIGH gha-cicd-demo:local   # same scan CI runs
```

## Repos

| Repo | Purpose |
|---|---|
| [`gha-cicd-demo`](https://github.com/goswami97/gha-cicd-demo) (this repo) | App code + CI pipeline |
| [`gha-cicd-demo-manifests`](https://github.com/goswami97/gha-cicd-demo-manifests) | Kubernetes manifests only — the GitOps source of truth ArgoCD watches |

Split into two repos deliberately: app code has branch protection + full CI gates; the manifests repo has none, so automated tag-bump commits don't fight branch protection. This mirrors how EG's internal RCP/ArgoCD setup works (app repo → GitOps repo → ArgoCD).

## Pipeline flow

```
PR opened  ──▶  CI (lint, test, build, sonar, docker-build-scan-push, trivy)
                      │
Merge to main ──▶  CI (same jobs) ──▶ image pushed to GHCR
                      │
              update-manifest job
                      │
                      ▼
    gha-cicd-demo-manifests: development/deployment.yaml bumped
                      │
                      ▼
   ArgoCD auto-syncs (gha-cicd-demo-development) ──▶ development namespace


Promote to QA (auto-triggered after every successful development deploy,
               OR manual workflow_dispatch for an ad-hoc tag):
  CI succeeds on main ──▶ Promote to QA fires automatically
                      │
         GitHub "qa" environment approval required (pauses here)
                      │
      image existence verified against GHCR before writing anything
                      │
                      ▼
       gha-cicd-demo-manifests: qa/deployment.yaml bumped
                      │
                      ▼
      ArgoCD auto-syncs (gha-cicd-demo-qa) ──▶ qa namespace


Promote to Production (gated — only ever promotes what QA validated):
  git tag vX.Y.Z && git push origin vX.Y.Z   (or workflow_dispatch)
                      │
         GitHub "production" environment approval required
                      │
      image existence verified against GHCR before writing anything
                      │
                      ▼
      gha-cicd-demo-manifests: production/deployment.yaml bumped
   (defaults to QA's current tag, not development's — prod can't skip QA)
                      │
                      ▼
   ArgoCD does NOT auto-sync — manual `argocd app sync gha-cicd-demo-production`
   (or UI) required before it actually reaches the production namespace
```

## Workflows (in `gha-cicd-demo`)

- **`CI`** (`.github/workflows/ci.yml`) — runs on every PR and push to `main`:
  - `lint`, `test`, `build` — required status checks for branch protection
  - `sonar` — SonarCloud quality gate (`sonar.qualitygate.wait=true`, so a failed gate fails the job; needs `SONAR_TOKEN` secret; **Automatic Analysis must be disabled** on sonarcloud.io or it conflicts with CI-based analysis)
  - `docker-build-scan-push` — needs `build` **and** `sonar`, so nothing reaches GHCR or development without passing the quality gate. Builds the image (commit SHA baked in via the `GIT_SHA` build arg; the environment is read at runtime from the Deployment's `DEPLOY_ENV`, since one image is promoted through all three tiers), scans it with Trivy (fails on CRITICAL/HIGH CVEs), pushes to GHCR only on `push` events
  - `update-manifest` — only on `push` to `main`; bumps `development/deployment.yaml` in the manifests repo and pushes directly (no PR — that repo has no protection)
- **`Promote to QA`** (`.github/workflows/promote-qa.yml`) — auto-triggers whenever `CI` succeeds on `main` (i.e. right after a development deploy), or manual dispatch for an ad-hoc tag:
  - Gated by the `qa` GitHub environment (required reviewer — pauses here regardless of trigger type)
  - Verifies the resolved image actually exists in GHCR (`docker manifest inspect`) before writing anything — bumps `qa/deployment.yaml`
- **`Promote to Production`** (`.github/workflows/promote-production.yml`) — on a `v*` tag or manual dispatch:
  - Gated by the `production` GitHub environment (required reviewer)
  - Defaults to **QA's** currently-deployed tag (not development's) — production can never ship something QA didn't see
  - On a `v*` tag, promotes the image for **the commit the tag points at**, and refuses (before the approval gate) unless QA is currently running that exact commit — promote it to QA first, then re-run
  - Same GHCR existence check as `promote-qa` before writing `production/deployment.yaml` — an explicit `image_tag` input must be a real commit SHA that was actually pushed, not an arbitrary version string

Pushes to the manifests repo from all three workflows retry with `git pull --rebase` on rejection (each touches a different file, so rebases never conflict). CI only cancels superseded runs on PRs — runs on `main` queue instead, so a deploy is never killed mid-push.

## Secrets required

| Secret | Used for |
|---|---|
| `SONAR_TOKEN` | SonarCloud analysis |
| `DEPLOY_PAT` | Classic PAT (`repo` scope) — `update-manifest` and `promote-production` push to the separate manifests repo. **Must be a PAT, not `GITHUB_TOKEN`** — GitHub Actions' recursion guard means `GITHUB_TOKEN`-authored pushes don't trigger downstream workflows, which caused a real self-triggering loop earlier (see Gotchas below) |

## Branch protection (`main-protection` ruleset, on `gha-cicd-demo` only)

- No direct push, no force-push, no deletion
- PR required, 0 required approvals (solo repo)
- Required status checks: `lint`, `test`, `build` (must match actual job names, not the workflow name — a common mistake)

The manifests repo (`gha-cicd-demo-manifests`) has **no branch protection** — automated commits need to land there without a PR.

## ArgoCD

Three Applications, all watching `gha-cicd-demo-manifests`:

| Application | Path | Namespace | Sync policy |
|---|---|---|---|
| `gha-cicd-demo-development` | `development/` | `development` | Automated (prune + self-heal) |
| `gha-cicd-demo-qa` | `qa/` | `qa` | Automated (prune + self-heal) — the gate is the GitHub `qa` environment approval on `Promote to QA`, not ArgoCD itself; once that manifest changes, ArgoCD applies it without another click |
| `gha-cicd-demo-production` | `production/` | `production` | **Manual only** — `argocd app sync gha-cicd-demo-production` or via UI |

ArgoCD UI: `kubectl port-forward svc/argocd-server -n argocd 8080:443`, then `https://localhost:8080` (admin password: `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`).

## Local setup notes (corporate network / Zscaler)

If pulling images into minikube fails with `x509: certificate signed by unknown authority`, minikube's internal Docker daemon doesn't trust the corporate root CA (Zscaler). Fix:
```bash
security find-certificate -c "Zscaler Root CA" -p /Library/Keychains/System.keychain > /tmp/zscaler-root-ca.pem
minikube cp /tmp/zscaler-root-ca.pem /usr/local/share/ca-certificates/zscaler-root-ca.crt
minikube ssh -- "sudo update-ca-certificates && sudo systemctl restart docker"
```
Same fix applies to ArgoCD's `repo-server` pod trusting GitHub — add the cert to the `argocd-tls-certs-cm` ConfigMap under the `github.com` key instead.

## Gotchas hit while building this (worth knowing before changing the pipeline)

1. **Self-triggering loop (real incident):** an early version of `update-manifest` pushed commits back into *this* repo's `main`. Every "chore: deploy" commit re-triggered CI, which built a new image and bumped the manifest again — an infinite loop that ran ~15 minutes and created 6+ needless PRs/images before being caught. Root cause fixed by moving manifests to a separate repo with no CI at all, so there's no path back to re-trigger anything.
2. **`GITHUB_TOKEN`-authored pushes don't trigger downstream workflows** — GitHub's anti-recursion guard. If `update-manifest`'s auto-created PR needs its own CI to run (for required-status-check gating), it must push using a PAT, not the default token.
3. **SonarCloud "Automatic Analysis" conflicts with CI-based analysis** — must be disabled per-project on sonarcloud.io or every CI scan fails with `EXECUTION FAILURE`.
4. **Required status checks must match job names, not the workflow name** — `context: "CI"` never satisfies anything; it must be `lint`/`test`/`build` etc.
5. **Promotion `image_tag` input must be a real GHCR tag** — typing `v1.0.0` when the pipeline only ever tags images by commit SHA silently wrote a broken image reference into the production manifest once (ArgoCD then showed `ImagePullBackOff`). Fixed by validating with `docker manifest inspect` before writing the manifest in both `promote-qa` and `promote-production` — a bad tag now fails the workflow loudly instead of corrupting the manifest.
6. **`actions/checkout` in a `workflow_run`-triggered job defaults to the default branch tip, not the commit that triggered the original run** — always pin `ref: ${{ github.event.workflow_run.head_sha }}` explicitly.
7. **`Promote to QA` auto-triggers on every successful `CI` run on `main`**, including doc-only or workflow-only changes that didn't actually change app code — each one still prompts a `qa` environment approval request. Harmless (the `git diff --staged --quiet` check skips the commit if the image tag didn't actually change), but it does mean an approval notification can fire for a no-op promotion.
