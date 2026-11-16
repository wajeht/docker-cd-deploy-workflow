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

`preview.js --action create` requires `--app-path`, `--pr-number`, `--service-name`, `--tag`, and `--repo-owner`. It also accepts `--auth-middleware` and `--app-repo-path`. Cleanup requires only `--app-path` and `--pr-number`. App paths must be direct children of an `apps` directory. Absolute paths are accepted and normalized. PR numbers must be positive integers. Both actions emit the canonical preview directory as `temp-path` through `GITHUB_OUTPUT`.

Both preview workflows pass `--message` to publish the preview directory and Tinyauth Compose file together. On a concurrent push, the preview operation runs again from the latest Home Ops `main`. Without `--message`, `preview.js` only writes the local files. The standalone `git.js` CLI accepts repeated `--paths` arguments or `--all`, plus `--message`.

## Secrets

| Secret | Required by | Description |
|--------|-------------|-------------|
| `GH_TOKEN` | All workflows | GitHub PAT with `repo` and `packages` scope |
| `DOCKER_CD_URL`, `DOCKER_CD_API_SECRET` | All preview deploys | HTTPS Docker-CD API origin and bearer token for readiness checks |

## Release Coordination

Workflows pinned before `v0.0.29` fetch scripts from `main` and can fail because the script names changed. Upgrade your deploy and preview workflow pins to `v0.0.29` or later.
