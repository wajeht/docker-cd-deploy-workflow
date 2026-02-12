# docker-cd-deploy-workflow

Reusable GitHub Actions workflow for instant Docker deploys. When an app repo pushes a tag, this workflow updates the image tag in your home-ops repo, triggering [docker-cd](https://github.com/wajeht/docker-cd) to deploy.

```
App repo pushes tag v1.0.0
    → GitHub Actions builds image to ghcr.io
    → This workflow updates home-ops docker-compose.yml
    → docker-cd detects change and deploys
```

## Usage

In your app repo's release workflow:

```yaml
jobs:
  build-and-push:
    # ... build and push image to ghcr.io ...

  deploy:
    needs: build-and-push
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/deploy.yaml@main
    with:
      app-path: apps/your-app-name
      tag: ${{ needs.build-and-push.outputs.version }}
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo to update |
| `app-path` | Yes | - | Path to app dir (e.g., `apps/ufc`) |
| `tag` | Yes | - | Image tag (e.g., `v1.0.0`) |

## Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `GH_TOKEN` | Yes | GitHub PAT with `repo` and `packages` scope |

## How It Works

1. Checks out the target home-ops repo
2. Updates the `image:` tag in `<app-path>/docker-compose.yml` using sed
3. Commits and pushes if there are changes
4. docker-cd polls for changes and deploys automatically

Concurrent deploys from different app repos are serialized to prevent push races.

## Temp Deploys

Temporary PR-based deployments. Gives each PR its own live environment.

```
Add `temp-deploy` label to PR
    → Builds image from PR branch
    → Creates apps/<app>-pr-<N>/ in home-ops
    → docker-cd deploys to pr-<N>-<app>.jaw.dev
    → Posts deploy URL as PR comment

Push new commits to PR (with label)
    → Rebuilds image with new SHA
    → Updates temp stack in home-ops
    → docker-cd redeploys

Close PR or remove label
    → Removes apps/<app>-pr-<N>/ from home-ops
    → docker-cd garbage collects the stack
```

### Prerequisites

1. Wildcard DNS for `*.jaw.dev` (Cloudflare)
2. Wildcard TLS cert in Traefik (`*.jaw.dev`)
3. `GH_TOKEN` secret with `repo` and `packages` scope
4. Create `temp-deploy` label in your repo: `gh label create temp-deploy`

### Setup

Add `pull_request` types to your existing CI workflow and append the temp jobs. Full example:

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
      port: "3000"               # change this to your container port
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
| `domain` | No | `jaw.dev` | Base domain |
| `port` | Yes | - | Container port for traefik |

### Temp Cleanup Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo |
| `app-path` | Yes | - | Base app path (e.g., `apps/bang`) |

## License

MIT
