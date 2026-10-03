# Development

Use Node.js 22.19+; image builds also require Docker. Install locked tools:

```console
npm ci --ignore-scripts
npm test
npm run lint
npm run format:check
```

Run the complete check with `./scripts/check`. It installs dependencies, audits,
checks formatting/lint, runs tests, builds and smoke-tests the image when Docker
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

JavaScript, MJS, and TypeScript use ESLint's recommended JavaScript and
typescript-eslint presets. Prettier owns formatting: 100-column width, two-space
indentation, double quotes, semicolons, and trailing commas. EditorConfig keeps
indentation and line endings consistent. `eslint-config-prettier` disables
conflicting lint rules; imports are not automatically reordered. Braces are
required for every `if`, `else`, and loop body.

```console
npm run lint:fix
npm run format
```

CI runs lint and formatting through `scripts/check`. The TypeScript preset is
not type-aware and is not a substitute for type checking. Use narrow inline
suppressions with explanations rather than disabling rules globally.

Keep tests focused on observable contracts and safety invariants, not arbitrary
file contents or implementation details. Keep OAuth authentication, the minimal
network allowlist, and the rule that the kit never writes Pi user settings.
