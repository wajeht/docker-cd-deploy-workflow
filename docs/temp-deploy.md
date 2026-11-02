# Temp Deploys

Temporary PR-based environments. Each PR gets its own live instance.

```
Add temp-deploy label to PR
    -> normal temp app, keeping production middleware labels

Add temp-deploy-with-auth label to PR
    -> auth-protected temp app

For either temp label
    -> build image from PR branch
    -> copy apps/<app>/ to apps/<app>-pr-<N>/ in home-ops
    -> rewrite compose for the PR stack
    -> docker-cd deploys to pr-<N>-<app>.jaw.dev
    -> GitHub Deployment gets a "View deployment" link

Push new commits while label is present
    -> rebuild image
    -> update temp stack
    -> docker-cd redeploys

Close PR or remove the last temp deploy label
    -> remove apps/<app>-pr-<N>/ from home-ops
    -> clean up GitHub Deployment
    -> docker-cd garbage collects the stack
```

## Prerequisites

1. Wildcard DNS for `*.jaw.dev`
2. Wildcard TLS cert in Traefik for `*.jaw.dev`
3. `GH_TOKEN` secret with `repo` and `packages` scope
4. For Home Ops with Tinyauth: `DOCKER_CD_URL` (HTTPS API origin) and `DOCKER_CD_API_SECRET` secrets in the caller repo, forwarded to the deploy workflow
5. `temp-deploy` and `temp-deploy-with-auth` labels:

```bash
gh label create temp-deploy
gh label create temp-deploy-with-auth
```

## Setup

Replace `RELEASE_COMMIT` below with the released commit containing Tinyauth preview support. Add `pull_request` types to CI and append temp build/deploy jobs:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

jobs:
  temp-build:
    name: Temp Build
    if: >
      (github.event.action == 'labeled' &&
        (github.event.label.name == 'temp-deploy' ||
         github.event.label.name == 'temp-deploy-with-auth')) ||
      (github.event.action != 'labeled' &&
        (contains(github.event.pull_request.labels.*.name, 'temp-deploy') ||
         contains(github.event.pull_request.labels.*.name, 'temp-deploy-with-auth')))
    runs-on: ubuntu-latest
    outputs:
      tag: ${{ steps.image-name.outputs.TAG }}
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.repository_owner }}
          password: ${{ secrets.GH_TOKEN }}

      - name: Generate Image Name
        id: image-name
        run: |
          TAG=$(echo ${{ github.event.pull_request.head.sha }} | cut -c1-7)
          IMAGE_URL=$(echo ghcr.io/${{ github.repository_owner }}/${{ github.event.repository.name }}:$TAG | tr '[:upper:]' '[:lower:]')
          echo "IMAGE_URL=$IMAGE_URL" >> $GITHUB_OUTPUT
          echo "TAG=$TAG" >> $GITHUB_OUTPUT

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.image-name.outputs.IMAGE_URL }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  temp-deploy:
    name: Temp Deploy
    if: >
      (github.event.action == 'labeled' &&
        (github.event.label.name == 'temp-deploy' ||
         github.event.label.name == 'temp-deploy-with-auth')) ||
      (github.event.action != 'labeled' &&
        (contains(github.event.pull_request.labels.*.name, 'temp-deploy') ||
         contains(github.event.pull_request.labels.*.name, 'temp-deploy-with-auth')))
    needs: temp-build
    permissions:
      deployments: write
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/temp-deploy.yaml@RELEASE_COMMIT
    with:
      app-path: apps/your-app
      service-name: your-app
      tag: ${{ needs.temp-build.outputs.tag }}
      auth-middleware: ${{ contains(github.event.pull_request.labels.*.name, 'temp-deploy-with-auth') && 'tinyauth@file' || '' }}
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
      DOCKER_CD_URL: ${{ secrets.DOCKER_CD_URL }}
      DOCKER_CD_API_SECRET: ${{ secrets.DOCKER_CD_API_SECRET }}
```

Put cleanup in its own workflow so CI deploy jobs cannot cancel it.

`.github/workflows/temp-cleanup.yml`:

```yaml
name: Temp Cleanup

on:
  pull_request:
    types: [closed, unlabeled]

permissions:
  contents: read
  deployments: write

concurrency:
  group: temp-cleanup-${{ github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  temp-cleanup:
    name: Temp Cleanup
    if: >
      github.event.action == 'closed' ||
      (github.event.action == 'unlabeled' &&
        (github.event.label.name == 'temp-deploy' ||
         github.event.label.name == 'temp-deploy-with-auth') &&
        !contains(github.event.pull_request.labels.*.name, 'temp-deploy') &&
        !contains(github.event.pull_request.labels.*.name, 'temp-deploy-with-auth'))
    permissions:
      deployments: write
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/temp-cleanup.yaml@RELEASE_COMMIT
    with:
      app-path: apps/your-app
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
```

## What Gets Rewritten

`src/preview.js --action create` copies the prod app directory and changes:

- service set: keeps `service-name` plus recursive `depends_on` services
- image tag: updates only `ghcr.io/<owner>/*` images
- Traefik labels: rewrites router/service names and hostname
- optional auth: replaces/adds router middleware labels when `auth-middleware` is set
- volumes: converts bind mounts to named Docker volumes
- networks/volumes: removes unused top-level declarations
- `container_name`: strips names to avoid conflicts
- `x-docker-cd.rolling_update`: forces `false`
- env overrides: copies PR branch `.env.sops` as `.env.sops.override`

Everything else on kept services is preserved. If a temp deploy needs a database, Redis, or another local service, declare it in `depends_on`.

Cleanup uses `preview.js --action cleanup` with `app-path` and `pr-number`. It removes the preview directory and its access rule, including when the directory is already gone. Both actions commit through `git.js`; deployment status is handled by `deployment.js`.

## Custom Env Overrides

Add `.env.sops` to the app repo PR branch:

```bash
cat > .env.sops.yaml << 'EOF'
APP_ENV=staging
APP_URL=pr-174-bang.jaw.dev
STRIPE_KEY=sk_test_xxx
EOF

sops -e .env.sops.yaml > .env.sops
rm .env.sops.yaml
git add .env.sops
git commit -m "add temp deploy env overrides"
```

The workflow copies `.env.sops` into the temp stack as `.env.sops.override`.
docker-cd merges it over the home-ops base `.env.sops`.

## Optional Auth

Set `auth-middleware` to protect a temp PR site with an existing Traefik middleware:

```yaml
with:
  app-path: apps/bang
  service-name: bang
  tag: ${{ needs.temp-build.outputs.tag }}
  auth-middleware: tinyauth@file
```

If omitted, temp deploys keep production middleware and its `TINYAUTH_ADMIN_ALLOW` or `TINYAUTH_USERS_ALLOW` allowlist. Explicit `tinyauth@file` previews use `TINYAUTH_ADMIN_ALLOW`. Missing or conflicting inherited rules fail closed.

`preview.js` owns creation and cleanup, including adding or removing only that preview's exact-domain OAuth rule. `git.js` commits the stack and rule together. Conflicting concurrent edits fail safely; rerun the workflow from the latest Home Ops main.

`deployment.js` checks docker-cd's deployed revisions and container health before marking a Tinyauth preview ready. Home Ops must use `rolling_update: false` to recreate Tinyauth after environment changes. A timeout fails the deployment; a login redirect does not count as readiness.

For per-PR auth, gate the input from labels:

```yaml
auth-middleware: ${{ contains(github.event.pull_request.labels.*.name, 'temp-deploy-with-auth') && 'tinyauth@file' || '' }}
```

Recommended label behavior:

- `temp-deploy`: deploy a temp app with the production middleware labels
- `temp-deploy-with-auth`: deploy the same temp app with `tinyauth@file`
- if both labels are present, auth wins because the auth label sets `auth-middleware`
- removing one temp label redeploys with the remaining mode
- removing the last temp label runs cleanup

## Inputs

### Temp Deploy

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `runs-on` | No | `["ubuntu-latest"]` | Runner labels as a JSON array |
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo |
| `app-path` | Yes | - | Base app path, like `apps/bang` |
| `service-name` | Yes | - | Compose service to deploy, like `bang` |
| `tag` | Yes | - | Image tag |
| `auth-middleware` | No | empty | Optional Traefik middleware for temp routers, like `tinyauth@file` |

### Temp Cleanup

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `runs-on` | No | `["ubuntu-latest"]` | Runner labels as a JSON array |
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo |
| `app-path` | Yes | - | Base app path, like `apps/bang` |

## Rollout

Follow [release coordination](reference.md#release-coordination), then update both preview workflow pins in `bang`, `jaw.dev`, and `videos`. Change their auth input to `tinyauth@file` and pass the two docker-cd secrets to the deploy workflow during the Home Ops cutover. Verify Google admin/users access, Basic rejection, public mode, and cleanup before completing the migration.
