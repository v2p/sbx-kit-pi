# Development

This is a single-user kit: keep one current implementation and update the tooling
and sandbox with it. Replace obsolete behavior rather than supporting parallel
old/new paths. See the [design policy](../AGENTS.md#design-policy-one-current-path).

Use an official Node.js 22.19+ build with native TypeScript stripping; some distro
builds omit it. Check with `node -p process.features.typescript` (expect `strip`
or `transform`). The sandbox image includes an official Node runtime. Image builds
also require Docker. Install locked tools:

```console
npm ci --ignore-scripts
npm test
npm run typecheck
npm run lint
npm run format:check
```

Run the complete check with `./scripts/check`. It installs dependencies, audits,
checks formatting/lint and types, runs tests, builds and smoke-tests the image when Docker
is available, and runs `sbx kit validate --offline .` when `sbx` is available. Run skipped
checks on a Docker Sandbox host. Offline validation does not start the daemon or
require sign-in; it does not check host source or signature policies.
For a quick iteration use `npm test`; audit separately with `npm run audit`.

The launcher, `scripts/check`, and sandbox Bash environment source
`scripts/node-environment` to suppress only Node's experimental proxy-agent notice
(`UNDICI-EHPA`). Before running npm directly on a proxy-enabled host, run
`source scripts/node-environment`. This preserves existing
`NODE_OPTIONS`, other diagnostics, and `NODE_USE_ENV_PROXY`; do not disable proxy
support or use blanket warning suppression.

Install Zsh to run the generated `.zfunc` completion integration tests locally.
Without Zsh those tests are skipped; `SBX_PI_REQUIRE_ZSH=1 npm test` requires them.
GitHub Actions installs Zsh and sets this flag so autoload registration and
completion dispatch are tested automatically, without editing shell startup files.

## Images and releases

The Makefile is limited to image release tasks and optional command installation:

```console
make image
make publish
make publish DOCKERHUB_USERNAME=another-user
```

`spec.yaml` references the concrete public image
`docker.io/vposvistelik/sbx-kit-pi:<kit-version>`. Changing the publishing namespace
also requires changing that reference.

Image tags follow this kit's semver, independently of Pi's version. To upgrade
Pi, update the Dockerfile `PI_AGENT_VERSION` default and Pi dependencies in both
`package.json` and `runtime/package.json`, then regenerate both lockfiles with
`npm install --ignore-scripts` and `npm --prefix runtime install --package-lock-only --ignore-scripts`.
For a release, bump the version in `package.json`, `package-lock.json`, and the
`spec.yaml` image tag;
rebuild and test both a fresh sandbox and recreation of an existing one.

Publish the versioned image before recreating the sandbox. Recreation discards
sandbox-local changes; save them first. See the [recreation workflow](../README.md#recreate-or-upgrade-a-sandbox).

## Dependency audit

`npm run audit` checks both the development and production runtime lockfiles.
The image installs `runtime/` with `npm ci --omit=dev --ignore-scripts` and audits
that installation too. Keep these gates; do not use `npm audit fix --force`.

Both manifests override `undici` to **8.12.3** and `minimatch` to **11.0.3** to fix
[Undici's advisories](https://github.com/nodejs/undici/security/advisories) and
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
The Minimatch override crosses a major version; tests exercise Pi's model glob
matching, and lint runs against the same override. Keep the pins aligned (tested)
and review them when upgrading Pi.

The image's `pi` command points at modular `dist/cli.js`; the prebuilt bundle is
removed because its embedded dependencies bypass npm overrides. Smoke tests check
the entrypoint, resolved dependency versions, model globs, compressed HTTP through
Pi's dispatcher, and extension loading. Auditing only the host production
packages is insufficient: Pi is a dev dependency here but runs in the image.

## Code style

Runtime modules and tests use `.mts` (explicit ESM); Pi extensions use `.ts`.
Node executes the scripts directly without a build step or runtime loader. Keep
explicit `.mts`/`.ts` import extensions and type-only imports. `tsconfig.json`
enforces strict checking and erasable syntax: no enums, parameter properties, or
other constructs that require code generation. The tooling-only ESLint config
remains JavaScript so ESLint does not need an additional loader.

TypeScript and the ESLint config use ESLint's recommended JavaScript and
typescript-eslint presets. Prettier owns formatting: 100-column width, two-space
indentation, double quotes, semicolons, and trailing commas. EditorConfig keeps
indentation and line endings consistent. `eslint-config-prettier` disables
conflicting lint rules; imports are not automatically reordered. Braces are
required for every `if`, `else`, and loop body.

```console
npm run lint:fix
npm run format
```

CI runs lint, formatting, and `tsc --noEmit` through `scripts/check`, including
the extensions and test fixtures. Keep parsed external data `unknown` until
runtime validation narrows it; static types do not validate JSON, TOML, YAML,
handler output, or RPC records. Share protocol/configuration types rather than
redeclaring contracts in consumers. The lint preset is not type-aware; `tsc`
provides the type checking. Use narrow inline
suppressions with explanations rather than disabling rules globally.

Keep tests focused on observable contracts and safety invariants, not arbitrary
file contents or implementation details. Keep OAuth authentication, the minimal
network allowlist, and the rule that the kit never writes Pi user settings.
