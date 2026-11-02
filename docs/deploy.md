# Deploy Workflow

`deploy.yaml` updates one service image tag in home-ops and tracks it as a GitHub Deployment. The image is resolved from ghcr.io and written as `<tag>@sha256:<digest>`.

`image.js` updates the Compose image and `git.js` commits it. Production tracking uses the workflow's native `environment: production`.

## Usage

Replace `RELEASE_COMMIT` with the released workflow commit. Follow [release coordination](reference.md#release-coordination) when changing caller pins.

```yaml
jobs:
  deploy:
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/deploy.yaml@RELEASE_COMMIT
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
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/deploy.yaml@RELEASE_COMMIT
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
| `runs-on` | No | `["ubuntu-latest"]` | Runner labels as JSON, e.g. `["self-hosted","linux","walker","docker"]` |
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
