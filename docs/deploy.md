# Deploy Workflow

`deploy.yaml` updates one service image tag in home-ops and tracks it as a GitHub Deployment. The image is resolved from ghcr.io and written as `<tag>@sha256:<digest>`.

## Usage

```yaml
jobs:
  deploy:
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/deploy.yaml@v0.0.22
    with:
      app-path: apps/your-app
      service-name: your-app
      tag: ${{ needs.build.outputs.tag }}
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
```

With a custom URL:

```yaml
jobs:
  deploy:
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/deploy.yaml@v0.0.22
    with:
      app-path: apps/close-powerlifting
      service-name: close-powerlifting
      tag: ${{ needs.build.outputs.tag }}
      url: https://closepowerlifting.com
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `home-ops-repo` | No | `wajeht/home-ops` | Target repo |
| `app-path` | Yes | - | App directory, like `apps/bang` |
| `service-name` | Yes | - | Compose service to update, like `bang` |
| `tag` | Yes | - | Image tag |
| `url` | No | `https://<repo-name>.jaw.dev` | Production URL shown in GitHub Deployments |

## Deployment Tracking

The workflow uses native GitHub Actions `environment: production`, giving you:

- a `production` entry in the repo Deployments sidebar
- a clickable URL for the deployed app
- serialized deploys via `concurrency: deploy-home-ops`
