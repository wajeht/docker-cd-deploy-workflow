# docker-cd-deploy-workflow

Reusable GitHub Actions workflows for [docker-cd](https://github.com/wajeht/docker-cd) deployments.

```
App repo pushes to main
    → GitHub Actions builds image to ghcr.io
    → deploy.yaml updates image tag in home-ops
    → docker-cd detects change and deploys
```

## Workflows

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `deploy.yaml` | Push to main | Updates image tag in home-ops compose file |
| `temp-deploy.yaml` | PR labeled `temp-deploy` / new commits | Creates temporary PR environment |
| `temp-cleanup.yaml` | PR closed / label removed | Removes temporary PR environment |

## Scripts

Node.js (ESM), uses `js-yaml` for YAML parsing.

| Script | Used by | Description |
|--------|---------|-------------|
| `src/update-tag.js` | `deploy.yaml` | Updates `ghcr.io` image tag in a compose file |
| `src/rewrite-compose.js` | `temp-deploy.yaml` | Copies app stack, rewrites image/labels/volumes for temp env |
| `src/deployment.js` | `temp-deploy.yaml`, `temp-cleanup.yaml` | Creates/cleans up GitHub Deployments for "View deployment" button on PRs |
| `src/comment.js` | - | Posts/updates PR comments (legacy, replaced by `deployment.js`) |
| `src/utils.js` | all | Shared helpers (`parseArgs`, `createGitHubApi`) |

## Deploy

Updates the image tag for a single app in home-ops.

```yaml
jobs:
  deploy:
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/deploy.yaml@main
    with:
      app-path: apps/your-app
      tag: ${{ needs.build.outputs.tag }}
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
```

### Deploy Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo |
| `app-path` | Yes | - | Path to app dir (e.g., `apps/bang`) |
| `tag` | Yes | - | Image tag |

## Temp Deploys

Temporary PR-based environments. Each PR gets its own live instance.

```
Add `temp-deploy` label to PR
    → Builds image from PR branch
    → Copies apps/<app>/ → apps/<app>-pr-<N>/ in home-ops
    → Rewrites image tag, traefik labels, converts bind mounts to named volumes
    → docker-cd deploys to pr-<N>-<app>.jaw.dev
    → Creates a GitHub Deployment with "View deployment" button linking to the URL

Push new commits (with label present)
    → Rebuilds image with new SHA
    → Updates temp stack with new image
    → docker-cd redeploys

Close PR or remove label
    → Removes apps/<app>-pr-<N>/ from home-ops
    → Cleans up GitHub Deployment
    → docker-cd garbage collects the stack
```

### What gets rewritten

The `src/rewrite-compose.js` script copies the full prod stack and modifies:

- **Image tag** — only `ghcr.io/<owner>/*` images, third-party images (postgres, redis) stay untouched
- **Traefik labels** — router/service names and hostname rewritten to avoid conflicts with prod
- **Volumes** — bind mounts (`/home/jaw/data/app/...`) converted to named Docker volumes (no permission issues, ephemeral)
- **docker-cd.yml** — forces `rolling_update: false`
- **env overrides** — if `.env.sops` exists in the app repo's PR branch, overwrites the home-ops `.env.sops` (per-PR secrets)

Everything else is preserved: healthchecks, sidecars, networks, resource limits.

### Custom env overrides

To override env values for temp deploys, add `.env.sops` to the app repo's PR branch:

```bash
# Create your overrides
cat > .env.sops.yaml << 'EOF'
APP_ENV=staging
APP_URL=pr-174-bang.jaw.dev
STRIPE_KEY=sk_test_xxx
EOF

# Encrypt and commit to your PR branch
sops -e .env.sops.yaml > .env.sops
rm .env.sops.yaml
git add .env.sops && git commit -m "add temp deploy env overrides"
```

The temp deploy workflow checks out `.env.sops` from the PR branch and copies it into the temp stack, overwriting the home-ops version. docker-cd decrypts it as usual. Each PR can have different secrets.

### Prerequisites

1. Wildcard DNS for `*.jaw.dev` (Cloudflare)
2. Wildcard TLS cert in Traefik (`*.jaw.dev`)
3. `GH_TOKEN` secret with `repo` and `packages` scope
4. Create `temp-deploy` label: `gh label create temp-deploy`

### Setup

Add `pull_request` types to your existing CI and append temp jobs:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled, closed]

jobs:
  # ... your existing test/lint/build/deploy jobs ...

  temp-build:
    name: Temp Build
    if: >
      (github.event.action == 'labeled' && github.event.label.name == 'temp-deploy') ||
      (github.event.action == 'synchronize' && contains(github.event.pull_request.labels.*.name, 'temp-deploy'))
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
      (github.event.action == 'labeled' && github.event.label.name == 'temp-deploy') ||
      (github.event.action == 'synchronize' && contains(github.event.pull_request.labels.*.name, 'temp-deploy'))
    needs: temp-build
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/temp-deploy.yaml@main
    with:
      app-path: apps/your-app    # change this
      tag: ${{ needs.temp-build.outputs.tag }}
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}

  temp-cleanup:
    name: Temp Cleanup
    if: >
      github.event.action == 'closed' ||
      (github.event.action == 'unlabeled' && github.event.label.name == 'temp-deploy')
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/temp-cleanup.yaml@main
    with:
      app-path: apps/your-app    # change this
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
```

### Temp Deploy Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo |
| `app-path` | Yes | - | Base app path (e.g., `apps/bang`) |
| `tag` | Yes | - | Image tag |

### Temp Cleanup Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo |
| `app-path` | Yes | - | Base app path (e.g., `apps/bang`) |

## Secrets

| Secret | Required by | Description |
|--------|-------------|-------------|
| `GH_TOKEN` | All workflows | GitHub PAT with `repo` and `packages` scope |

GitHub Deployments use `GH_TOKEN` so they show as your user instead of github-actions bot.

## License

MIT
