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

## Code Style

These rules apply to the whole repository, including tests. Keep the four module responsibilities above and the earlier function naming rules; pure derivations keep noun names.

- Use Node.js 26, ESM, and the existing `js-yaml` dependency.
- Export at declaration with named `export function` or `export const`; no default or grouped bottom exports.
- Put imports first, use `node:` for built-ins and relative paths for project imports. Avoid deep parent imports.
- Use `function` declarations; reserve arrows for short callbacks.
- Use `for` / `for...of` rather than `.forEach()` / `.map()`. Use indexes only when needed.
- Precompile static regexes as `REGEX_NAME` constants. Compile input-dependent regexes once per operation.
- Use lookup objects for multi-action dispatch. Use guard clauses and early returns for validation.
- Validate inputs before filesystem/network side effects. Throw native `Error` objects and handle promise rejections.
- Use `instanceof` and structured error causes rather than matching error names or messages.
- Prefer `const`; use `let` only for reassigned state. Module constants use SCREAMING_SNAKE_CASE.
- Preserve caller inputs. Return new values; locally owned accumulators and cloned Compose state may be updated.
- Use `??` for defaults, `?.` for optional access, and `!= null` when checking both null and undefined. Otherwise use strict equality.
- Prefer async/await, template literals, rest/spread, and object shorthand.
- Use factory functions for service modules instead of classes. Avoid static members and getter/setter abstractions.
- Use tabs, braces around control flow, clear camelCase names, and short functions. Avoid nested ternaries.
- Keep one responsibility per function and one domain concept per module. Share repeated behavior when it simplifies the code; avoid speculative utilities and `Utils` names.
- Comments explain why. Never use eval, with, namespaces, debugger statements, or built-in prototype modifications.
- Log only useful CLI progress and sanitized errors. Never log passwords, tokens, PII, or raw upstream error bodies.

This is a JavaScript CLI repository, with no `ctx`, `HttpError`, or TypeScript runtime framework. Use native errors and console logging here. If TypeScript is introduced, use inferred types, `unknown` over `any`, interfaces for object shapes, readonly fields/arrays, tuples for fixed shapes, primitive types, and the requested array syntax. Avoid type assertions, non-null assertions, namespaces, and enums; restrict visibility and keep constructors simple. Framework-specific error/logging and route/template naming rules apply only if those components exist.

## Validation

- Keep tests beside their modules as `<name>.test.js`.
- Run `npm test`, validate changed workflow YAML with actionlint, and check code style across all source and tests.
- Update workflow invocations and docs when changing script names or CLI arguments.
- Avoid unrelated formatting changes and extra dependencies.

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
