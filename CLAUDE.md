# CLAUDE.md

## Project

Reusable GitHub Actions workflows update `wajeht/home-ops`. Docker-CD watches that repository and deploys containers.

## Responsibilities

| Module | Owns |
|---|---|
| `src/image.js` | Production image tags and digests |
| `src/preview.js` | Preview Compose files, environment overrides, and Tinyauth access rules |
| `src/git.js` | Committing requested paths and pushing with retry |
| `src/deployment.js` | GitHub deployment status and readiness checks |

Keep preview creation and cleanup together. Keep Git operations independent of app-specific paths and auth rules. Each module exports functions for tests and guards its CLI entrypoint.

## Workflows

- `deploy.yaml`: resolve the image digest, run `image.js`, then `git.js`. Production tracking uses the native GitHub environment.
- `temp-deploy.yaml`: request a deployment, run `preview.js --action create`, commit through `git.js`, then verify and report readiness through `deployment.js`.
- `temp-cleanup.yaml`: run `preview.js --action cleanup`, commit through `git.js`, then clean up the GitHub deployment.

Preview creation keeps the selected service and recursive `depends_on` services. It rewrites image tags, router names, hostnames, and bind mounts, removes unused networks/volumes and `container_name`, and writes `x-docker-cd.rolling_update: false`. PR `.env.sops` is copied as `.env.sops.override`.

Protected previews need exact-domain Tinyauth OAuth rules. Explicit auth uses `TINYAUTH_ADMIN_ALLOW`; inherited auth preserves the production admin/users allowlist. Cleanup removes only the preview's rule. Preserve Home Ops YAML comments and unrelated production rules; never log decrypted credentials.

## Naming Conventions

### Functions

| Pattern | When | Examples |
|---|---|---|
| `verbNoun()` | Has side effects or can fail | `removePreview()`, `parseAuthEnvironment()`, `runGit()` |
| `noun()` | Pure derivation from inputs | `hosts()`, `primaryHost()`, `imageRepository()` |
| `is/has/can/should` | Boolean predicate | `isObject()`, `hasTinyauth()`, `isDeploymentCurrent()` |
| `createX()` | Factory function | `createGitHubApi()` |

Drop `get`, `build`, and `format` prefixes on pure derivations. Keep `get` only for real work such as I/O, subprocesses, or parsing that can throw. Bare Docker verbs such as `pull()`, `down()`, and `inspect()` are fine when the noun is obvious.

### Variables

Use nouns, without `get` or `build` prefixes. When a local value would shadow a same-named function, rename the local value: `const commitLink = commitUrl(repo, sha)`.

## Style and Validation

- Use Node.js 26, ESM, and the existing `js-yaml` dependency.
- Prefer named `export function` declarations; no default exports.
- Use `for` or `for...of` instead of `forEach` in hot paths.
- Use factory functions for service modules instead of classes.
- Use the `node:` prefix for built-in imports.
- Use tabs, braces around control flow, clear names, and short functions.
- Avoid nested ternaries, speculative abstractions, and unrelated formatting changes.
- Keep tests beside their modules as `<name>.test.js`.
- Run `npm test` and validate changed workflow YAML with actionlint.
- Update workflow invocations and the docs when changing script names or CLI arguments.

## Releases

Published workflows currently check out scripts from `main`. Renaming entrypoints requires coordinated caller upgrades; see `docs/reference.md#release-coordination`. Creating a PR does not authorize a release or production cutover.

## Commits

- Use short conventional commit messages.
- Never add `Co-Authored-By:` trailers.

## Documentation

- `README.md`: overview and quick start.
- `docs/deploy.md`: production workflow usage.
- `docs/temp-deploy.md`: preview setup, auth, and cleanup.
- `docs/reference.md`: module responsibilities, CLI actions, secrets, and release coordination.
