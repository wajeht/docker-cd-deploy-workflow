# docker-cd-deploy-workflow

Reusable GitHub Actions workflows for [docker-cd](https://github.com/wajeht/docker-cd) deployments.

```
App repo builds image to ghcr.io
    -> deploy.yaml updates home-ops
    -> docker-cd deploys the changed stack
```

## Workflows

- `deploy.yaml` updates a production image tag in home-ops, pinned to the image digest.
- `temp-deploy.yaml` creates temporary PR environments, with optional Traefik auth.
- `temp-cleanup.yaml` removes temporary PR environments.

## Use

```yaml
jobs:
  deploy:
    uses: wajeht/docker-cd-deploy-workflow/.github/workflows/deploy.yaml@v0.0.25
    with:
      app-path: apps/your-app
      service-name: your-app
      tag: ${{ needs.build.outputs.tag }}
    secrets:
      GH_TOKEN: ${{ secrets.GH_TOKEN }}
```

For PR previews, app repos can use:

- `temp-deploy` for a normal temp app with production middleware labels
- `temp-deploy-with-auth` plus `auth-middleware: oauth2-admin@file` for an auth-protected temp app

## Docs

- [Deploy workflow](docs/deploy.md)
- [Temp deploys](docs/temp-deploy.md)
- [Workflow and script reference](docs/reference.md)

## License

Distributed under the MIT License © [wajeht](https://github.com/wajeht). See [LICENSE](./LICENSE) for more information.
