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

Temporary PR-based deployments. Add `temp-deploy` label to a PR → deploys to `pr-<N>-<app>.jaw.dev`. Close PR or remove label → auto-cleanup.

### Setup (in app repo CI)

```yaml
on:
  pull_request:
    types: [labeled, closed, unlabeled]

jobs:
  build:
    if: github.event.action == 'labeled' && github.event.label.name == 'temp-deploy'
    runs-on: ubuntu-latest
    outputs:
      tag: ${{ steps.tag.outputs.TAG }}
    steps:
      # ... build and push image ...

  temp-deploy:
    if: github.event.action == 'labeled' && github.event.label.name == 'temp-deploy'
    needs: build
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/temp-deploy.yaml@main
    with:
      app-path: apps/your-app
      tag: ${{ needs.build.outputs.tag }}
      port: "3000"
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}

  temp-cleanup:
    if: >
      github.event.action == 'closed' ||
      (github.event.action == 'unlabeled' && github.event.label.name == 'temp-deploy')
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/temp-cleanup.yaml@main
    with:
      app-path: apps/your-app
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
