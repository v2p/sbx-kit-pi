# Development

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
is available, and runs `sbx kit validate .` when `sbx` is available. Run skipped
checks on a Docker Sandbox host. For a quick iteration use `npm test`; audit
separately with `npm run audit`.

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
Pi, change the Dockerfile `PI_AGENT_VERSION` default. For a release, bump the
version in `package.json`, `package-lock.json`, and the `spec.yaml` image tag;
rebuild and test both a fresh sandbox and recreation of an existing one.

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
