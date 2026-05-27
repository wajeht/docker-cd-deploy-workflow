# Workflow and Script Reference

## Workflows

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `deploy.yaml` | Push to main | Updates the digest-pinned image tag in home-ops and creates a GitHub Deployment |
| `temp-deploy.yaml` | PR labeled `temp-deploy` or new commits | Creates a temporary PR environment |
| `temp-cleanup.yaml` | PR closed or label removed | Removes a temporary PR environment |

## Scripts

Node.js 26 ESM scripts. YAML parsing uses `js-yaml`.

| Script | Used by | Description |
|--------|---------|-------------|
| `src/update-tag.js` | `deploy.yaml` | Updates a `ghcr.io` image tag in a compose file, pinned to the digest |
| `src/temp-compose.js` | `temp-deploy.yaml` | Builds the temp deploy compose file |
| `src/deployment.js` | `temp-deploy.yaml`, `temp-cleanup.yaml` | Creates or cleans up GitHub Deployments for PR environments |
| `src/temp-cleanup.js` | `temp-cleanup.yaml` | Removes the temp deploy app directory |
| `src/git-push.js` | all deploy workflows | Commits and pushes with retry on conflict |

## Secrets

| Secret | Required by | Description |
|--------|-------------|-------------|
| `GH_TOKEN` | All workflows | GitHub PAT with `repo` and `packages` scope |
