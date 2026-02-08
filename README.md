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

## License

MIT
