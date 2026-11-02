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
| `src/image.js` | `deploy.yaml` | Updates a service image tag and digest |
| `src/preview.js` | Preview workflows | `--action create` prepares a preview; `--action cleanup` removes it and its access rule |
| `src/git.js` | All deploy workflows | Commits selected files and pushes with rebase/retry |
| `src/deployment.js` | Preview workflows | `--action request`, `deploy`, or `cleanup` manages GitHub deployments and readiness |

Each script exports its functions for tests and runs its CLI only when invoked directly. Tests live beside each module as `<name>.test.js`.

`preview.js --action create` requires `--app-path`, `--pr-number`, `--service-name`, `--tag`, and `--repo-owner`. It also accepts `--auth-middleware` and `--app-repo-path`. Cleanup requires only `--app-path` and `--pr-number`.

`git.js` accepts repeated `--paths` arguments or `--all`, plus `--message`. Preview workflows explicitly select the preview directory and Tinyauth Compose file so both changes are committed together.

## Secrets

| Secret | Required by | Description |
|--------|-------------|-------------|
| `GH_TOKEN` | All workflows | GitHub PAT with `repo` and `packages` scope |
| `DOCKER_CD_URL`, `DOCKER_CD_API_SECRET` | Tinyauth preview deploys | HTTPS docker-cd API origin and bearer token for readiness checks |

## Release Coordination

Published workflows currently check out scripts from this repository's `main` branch. Older workflow pins still use the previous script paths, so renaming entrypoints requires a coordinated upgrade.

Pause caller deployment workflows before merging this refactor. Merge and release it, update production deploy and both preview workflow pins in every caller, then resume. Do not merge and leave callers on the old workflow entrypoints. The Tinyauth cutover also requires the preview secrets and access checks described in [Temp Deploys](temp-deploy.md#rollout).
