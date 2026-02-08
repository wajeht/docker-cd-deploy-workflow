# Claude Instructions

## Commit Rules

- Never add `Co-Authored-By:` to commit messages
- Always use conventional commit messages in a very short and concise way

## Project Overview

Reusable GitHub Actions workflow for instant deploys. When an app repo pushes a tag, this workflow updates the image tag in `wajeht/home-ops` and commits, triggering docker-cd to deploy.

## How It Works

```
App repo pushes tag v1.0.0
    ↓
GitHub Actions builds image to ghcr.io
    ↓
This workflow updates home-ops docker-compose.yml
    ↓
docker-cd detects change and deploys
```

## Usage (in app repo's release.yml)

```yaml
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
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo |
| `app-path` | Yes | - | Path to app (e.g., `apps/ufc`) |
| `tag` | Yes | - | Image tag (e.g., `v1.0.0`) |

## Related Repos

- `wajeht/docker-cd` - GitOps deployer that watches home-ops
- `wajeht/home-ops` - Target repo where image tags are updated
