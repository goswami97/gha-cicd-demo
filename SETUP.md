# Setup guide — build this from scratch

For architecture/overview, see [README.md](./README.md). This doc is the step-by-step build.

## Prerequisites

- GitHub account, `gh` CLI authenticated (`gh auth login`)
- A SonarCloud account (free, sign up via GitHub at sonarcloud.io)
- Docker Desktop (or any Docker daemon) + `minikube` + `kubectl` + `argocd` CLI installed locally
- Node.js 22+ locally (for local testing before pushing)

## 1. Create the two repos

```bash
gh repo create <you>/gha-cicd-demo --public
gh repo create <you>/gha-cicd-demo-manifests --public --description "GitOps manifests, synced by ArgoCD"
```

Keep them separate from day one — don't build as one repo and split later (see README Gotchas #1).

## 2. App code (in `gha-cicd-demo`)

```
package.json            # scripts: start, dev, lint, test ("node --test \"test/**/*.test.js\""), build
src/index.js            # entry point: HTTP server on $PORT (3000 locally, 8080 in the image) + graceful SIGTERM shutdown
src/app.js              # routes: dashboard UI, /api/info, /healthz, /readyz, /metrics, POST /api/chaos
src/config.js           # runtime config from env (DEPLOY_ENV, BANNER_MESSAGE, ALLOW_CHAOS)
src/metrics.js          # tiny Prometheus text-format exporter
public/                 # dashboard UI (index.html, styles.css, app.js)
scripts/build.js        # assembles dist/ + build-info.json (commit SHA, build time)
test/app.test.js
eslint.config.js        # flat config — ESLint 9+ ignores .eslintrc.json
Dockerfile, .dockerignore
```

The app has no runtime npm dependencies (only `node:http`), so the image needs no `npm ci` and Trivy has very little to flag. See the repo's `Dockerfile`: a build stage runs `scripts/build.js`, and the runtime stage is `node:22-alpine` with npm/yarn removed, running as the built-in non-root `node` user on port 8080.

Commit and push to `main` directly once (before branch protection exists in step 4).

## 3. SonarCloud project

1. sonarcloud.io → log in via GitHub → import `gha-cicd-demo`
2. **Administration → Analysis Method → disable "Automatic Analysis"** — do this now, before any CI run, or every scan fails with `EXECUTION FAILURE`
3. My Account → Security → generate a Project Analysis Token
4. `gh secret set SONAR_TOKEN -R <you>/gha-cicd-demo` (paste the token)
5. Note your org key and project key (shown on the project's URL/settings) for `sonar-project.properties`:
```properties
sonar.organization=<org-key>
sonar.projectKey=<project-key>
sonar.sources=src
sonar.tests=test
sonar.exclusions=dist/**,node_modules/**
```

## 4. Deploy PAT (required — `GITHUB_TOKEN` will not work)

Create a classic PAT with `repo` scope: github.com/settings/tokens → Generate new token (classic).

```bash
gh secret set DEPLOY_PAT -R <you>/gha-cicd-demo
```

Why it must be a PAT: GitHub's anti-recursion guard means commits pushed using the default `GITHUB_TOKEN` don't trigger other workflow runs. Anything that needs its own CI to fire (the auto-promotion PRs below) will hang forever without a real PAT.

## 5. `.github/workflows/ci.yml`

Jobs, in order: `lint`, `test`, `build` (needs lint+test), `sonar` (needs lint+test), `docker-build-scan-push` (needs build), `update-manifest` (needs docker-build-scan-push).

Key details that aren't obvious:
- Pin `node-version: 22` everywhere — the test script's glob syntax needs it
- `docker-build-scan-push`: build with `push: false, load: true` first, run Trivy against the **local** image (fails on CRITICAL/HIGH), upload the SARIF with `if: always()`, and only then login+push — both gated on `if: github.event_name == 'push'`. This builds+scans on every PR but only pushes to the registry after merge.
- `update-manifest`: `if: github.event_name == 'push'` only. Checkout **the manifests repo** (`repository: <you>/gha-cicd-demo-manifests`, `token: ${{ secrets.DEPLOY_PAT }}`), sed the image tag into `development/deployment.yaml`, commit, push to that repo's `main` directly. Guard with `git diff --staged --quiet` to skip no-op commits.

Full reference: copy `.github/workflows/ci.yml` from this repo.

## 6. Branch protection on `gha-cicd-demo`

```bash
gh api repos/<you>/gha-cicd-demo/rulesets -X POST -f name=main-protection -f target=branch \
  -f 'enforcement=active' \
  -f 'conditions[ref_name][include][]=refs/heads/main' \
  -f 'rules[][type]=deletion' \
  -f 'rules[][type]=non_fast_forward'
```
(Easier in practice: Settings → Rules → New ruleset → target `main` → require a PR, require status checks.)

**Required status checks must be the literal job names** — `lint`, `test`, `build` — **not** `CI` (the workflow name). Requiring `CI` as a context never resolves and permanently blocks every PR.

The manifests repo gets **no protection at all** — automated pushes need to land without a PR there.

## 7. GitOps manifests (in `gha-cicd-demo-manifests`)

```
development/deployment.yaml   # namespace: development, nodePort: 30080
development/service.yaml
qa/deployment.yaml             # namespace: qa, nodePort: 30082
qa/service.yaml
production/deployment.yaml     # namespace: production, nodePort: 30081
production/service.yaml
```

Each `deployment.yaml` is a 2-replica Deployment with `image: ghcr.io/<you>/gha-cicd-demo:<some-initial-sha>` (any already-pushed tag), `DEPLOY_ENV` set to the environment name, a named `http` port on 8080, readiness (`/readyz`) and liveness (`/healthz`) probes, and a restricted `securityContext` (non-root, read-only root filesystem, all capabilities dropped). Services use `targetPort: http`. Each `service.yaml` is `type: NodePort` with the port above — **ports must differ per namespace**, NodePort is cluster-wide unique.

## 8. minikube + ArgoCD

```bash
minikube start
kubectl create namespace argocd
kubectl apply -n argocd --server-side -f \
  https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
# if you see field-manager conflicts on a retry:
kubectl apply -n argocd --server-side --force-conflicts -f \
  https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

**Corporate network with TLS-inspecting proxy (e.g. Zscaler)?** Both minikube's internal Docker daemon and ArgoCD's `repo-server` pod will fail with `x509: certificate signed by unknown authority` until you add the corporate root CA to both:

```bash
# macOS: export the corporate root CA
security find-certificate -c "<Your Corporate Root CA Name>" -p /Library/Keychains/System.keychain > /tmp/corp-ca.pem

# trust it inside minikube's docker daemon
minikube cp /tmp/corp-ca.pem /usr/local/share/ca-certificates/corp-ca.crt
minikube ssh -- "sudo update-ca-certificates && sudo systemctl restart docker"

# trust it inside ArgoCD's repo-server (so it can fetch from github.com)
python3 -c "
import json
with open('/tmp/corp-ca.pem') as f: cert = f.read()
json.dump({'data': {'github.com': cert}}, open('/tmp/patch.json','w'))
"
kubectl patch configmap argocd-tls-certs-cm -n argocd --type merge --patch-file /tmp/patch.json
```

Get the ArgoCD UI password and port-forward:
```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
kubectl port-forward svc/argocd-server -n argocd 8080:443
argocd login localhost:8080 --username admin --password '<password>' --insecure
```

Create the three Applications:
```bash
for env in development qa production; do
cat <<EOF | kubectl apply -f -
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: gha-cicd-demo-$env
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/<you>/gha-cicd-demo-manifests.git
    targetRevision: main
    path: $env
  destination:
    server: https://kubernetes.default.svc
    namespace: $env
  syncPolicy:
$( [ "$env" != "production" ] && echo "    automated:
      prune: true
      selfHeal: true" )
    syncOptions:
      - CreateNamespace=true
EOF
done
```

Note: `production` deliberately has **no** `automated` block — it stays manual-sync only.

## 9. GitHub Environments (approval gates)

```bash
gh api repos/<you>/gha-cicd-demo/environments/qa -X PUT \
  -f "reviewers[][type]=User" -F "reviewers[][id]=$(gh api user --jq .id)"
gh api repos/<you>/gha-cicd-demo/environments/production -X PUT \
  -f "reviewers[][type]=User" -F "reviewers[][id]=$(gh api user --jq .id)"
```

## 10. Promotion workflows

`.github/workflows/promote-qa.yml` and `.github/workflows/promote-production.yml` — copy from this repo. Non-obvious details:

- Both have an explicit `run-name:` — without it, the run's display title defaults to whatever commit message the triggering ref happens to point at, which is confusing and unrelated to what's being promoted.
- `promote-qa.yml` triggers on `workflow_run` (workflows:[CI], completed, branches:[main]) **and** `workflow_dispatch` — it auto-fires after every successful development deploy, but still pauses at the `qa` environment approval either way.
- Both verify the resolved image tag actually exists in GHCR with `docker manifest inspect <image>` **before** writing anything to the manifest — skipping this lets a typo'd tag (e.g. manually typing `v1.0.0` when the pipeline only tags images by commit SHA) silently corrupt the manifest; ArgoCD then just shows `ImagePullBackOff` with no indication why.
- `promote-production.yml` defaults to reading **QA's** current tag, not development's — this is what enforces development → qa → production as a strict order.

## 11. Repo settings housekeeping

```bash
gh api repos/<you>/gha-cicd-demo-manifests --jq .allow_auto_merge   # not needed with the final direct-push design, but useful to know
gh api repos/<you>/gha-cicd-demo/actions/permissions/workflow -X PUT \
  -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true
```

## Verify it all works

```bash
# 1. Open a PR, confirm lint/test/build/sonar/docker-build-scan-push/trivy all run
# 2. Merge it, confirm an image lands in GHCR:
gh api user/packages/container/gha-cicd-demo/versions --jq '.[0].metadata.container.tags'
# 3. Confirm development auto-deployed:
kubectl get application gha-cicd-demo-development -n argocd
# 4. Confirm Promote to QA auto-triggered and is waiting:
gh run list -R <you>/gha-cicd-demo --workflow=promote-qa.yml --limit 1
# 5. Approve it in the Actions tab, confirm qa synced:
kubectl get application gha-cicd-demo-qa -n argocd
# 6. Tag a release, confirm Promote to Production pauses, approve it, then sync manually:
git tag v1.0.0 && git push origin v1.0.0
argocd app sync gha-cicd-demo-production
kubectl get pods -n production
```

All three `kubectl get application` checks should show `Synced`/`Healthy`, each running a distinct, correct image tag for its tier.
