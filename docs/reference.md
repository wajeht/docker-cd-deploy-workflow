# Workflow and Script Reference

## Workflows

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `ci.yml` | Push, PR, tag `v*` | Runs tests; on tag, generates a changelog and creates a GitHub Release |
| `deploy.yaml` | Push to main | Updates the digest-pinned image tag in home-ops and creates a GitHub Deployment |
| `temp-deploy.yaml` | App repo PR workflow | Creates a temporary PR environment; `auth-middleware` can protect temp routers |
| `temp-cleanup.yaml` | PR closed or label removed | Removes a temporary PR environment |

## Scripts

Node.js 26 ESM scripts. YAML parsing uses `js-yaml`.

| Script | Used by | Description |
|--------|---------|-------------|
| `src/update-tag.js` | `deploy.yaml` | Updates a `ghcr.io` image tag in a compose file, pinned to the digest |
| `src/temp-compose.js` | `temp-deploy.yaml` | Builds the temp deploy compose file, including optional auth middleware rewrites |
| `src/deployment.js` | `temp-deploy.yaml`, `temp-cleanup.yaml` | Creates or cleans up GitHub Deployments for PR environments |
| `src/temp-cleanup.js` | `temp-cleanup.yaml` | Removes the temp deploy app directory |
| `src/git-push.js` | all deploy workflows | Commits and pushes with retry on conflict |

## Secrets

| Secret | Required by | Description |
|--------|-------------|-------------|
| `GH_TOKEN` | All workflows | GitHub PAT with `repo` and `packages` scope |
