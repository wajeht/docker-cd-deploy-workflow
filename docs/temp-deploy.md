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
4. `temp-deploy` and `temp-deploy-with-auth` labels:

```bash
gh label create temp-deploy
gh label create temp-deploy-with-auth
```

## Setup

Add `pull_request` types to CI and append temp build/deploy jobs:

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
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/temp-deploy.yaml@v0.0.25
    with:
      app-path: apps/your-app
      service-name: your-app
      tag: ${{ needs.temp-build.outputs.tag }}
      auth-middleware: ${{ contains(github.event.pull_request.labels.*.name, 'temp-deploy-with-auth') && 'oauth2-admin@file' || '' }}
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
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
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/temp-cleanup.yaml@v0.0.25
    with:
      app-path: apps/your-app
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
```

## What Gets Rewritten

`src/temp-compose.js` copies the prod app directory and changes:

- service set: keeps `service-name` plus recursive `depends_on` services
- image tag: updates only `ghcr.io/<owner>/*` images
- Traefik labels: rewrites router/service names and hostname
- optional auth: replaces/adds router middleware labels when `auth-middleware` is set
- volumes: converts bind mounts to named Docker volumes
- networks/volumes: removes unused top-level declarations
- `container_name`: strips names to avoid conflicts
- `docker-cd.yml`: forces `rolling_update: false`
- env overrides: copies PR branch `.env.sops` as `.env.sops.override`

Everything else on kept services is preserved. If a temp deploy needs a database, Redis, or another local service, declare it in `depends_on`.

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
  auth-middleware: oauth2-admin@file
```

If omitted, temp deploys keep the production middleware labels.

For per-PR auth, gate the input from labels:

```yaml
auth-middleware: ${{ contains(github.event.pull_request.labels.*.name, 'temp-deploy-with-auth') && 'oauth2-admin@file' || '' }}
```

Recommended label behavior:

- `temp-deploy`: deploy a temp app with the production middleware labels
- `temp-deploy-with-auth`: deploy the same temp app with `oauth2-admin@file`
- if both labels are present, auth wins because the auth label sets `auth-middleware`
- removing one temp label redeploys with the remaining mode
- removing the last temp label runs cleanup

## Inputs

### Temp Deploy

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo |
| `app-path` | Yes | - | Base app path, like `apps/bang` |
| `service-name` | Yes | - | Compose service to deploy, like `bang` |
| `tag` | Yes | - | Image tag |
| `auth-middleware` | No | empty | Optional Traefik middleware for temp routers, like `oauth2-admin@file` |

### Temp Cleanup

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo |
| `app-path` | Yes | - | Base app path, like `apps/bang` |
