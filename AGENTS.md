# Project Notes

This repository is `sbx-kit-pi`: a Docker Sandbox kit that launches the Pi coding agent with the `openai-codex` provider using ChatGPT OAuth credentials rather than an OpenAI API key.

## Key files

- `sbx-kit-pi.yaml` defines the v3 workload kit: OAuth, network, agent-context, and sbx capabilities, plus an inline build using the published custom sandbox image. Workload identity comes from its consumption reference; local launches use the checkout directory name.
- `Dockerfile` builds the custom sandbox image with Pi and bundled extensions under `/opt/sbx-kit-pi/extensions/`, runtime safety environment, and the `scripts/container-entrypoint` launch command. The entrypoint owns the provider, model, and extension defaults.
- `runtime/package.json` and its lockfile define the image's production Pi install. Keep its Pi version and security overrides aligned with the root development package; the image uses modular `dist/cli.js`, not the prebuilt bundle.
- `scripts/run` is the host launcher. It derives a workspace-specific sandbox/session name and runs or attaches via `sbx run`; Docker Sandbox pulls the published custom image.
- `extensions/agents-postprocessor.ts` and `extensions/agents-classifier-output.ts` implement preprocessing for Docker Sandbox-generated `AGENTS.md` files and generated skills.
- `tests/spec.test.mts` contains static tests for the kit contract.
- `Makefile` is intentionally limited to building/publishing the image and installing/uninstalling the optional user command.

## Design policy: one current path

- This is a single-user project. Update the checkout, tooling, and sandbox together; do not maintain compatibility for hypothetical legacy users.
- Replace obsolete behavior in place. Remove superseded code, tests, and documentation instead of adding version detection, fallback branches, compatibility aliases, dual configuration paths, automatic migrations, or deprecation periods unless explicitly requested.
- Document the current requirements and canonical workflow, not upgrade history or speculative future migrations. Git history records past behavior.
- Name resource/action launcher commands as flat, hyphenated noun–verb pairs: `config-show`, `alias-set`, `status-show`, and `plan-show`. Follow this convention for new resource/action commands; avoid nested command groups such as `config show` or vague standalone verbs such as `show`. Keep help, completions, tests, and documentation aligned with the canonical names.
- Simplicity does not remove safety requirements: retain validation, approval boundaries, preservation of user options/data, and warnings about destructive operations. Test current observable behavior rather than emulating obsolete upstream releases.

## Development workflow

- Use an official Node.js 22.19+ build with native TypeScript stripping; some distro builds omit it.
- Runtime modules and tests use `.mts`; Pi extensions use `.ts`. Keep explicit import extensions, type-only imports, and erasable syntax so Node can run scripts without a build step or loader.
- Run `npm test` for static tests and `npm run typecheck` for strict checking of scripts, extensions, and tests.
- Run `./scripts/check` to install locked dependencies, audit, format-check, lint, type-check, test, and build/smoke-test the custom image and build v3 descriptors when Docker is available.
- Use `make image` for a local image build plus smoke test and `make publish` for a release push.
- Target Docker Sandboxes 0.50.0+. Use v3 workload/mixin manifests together; native environment files remain schema v1.
- Validate `sbx-kit-pi.yaml` with `docker build --file sbx-kit-pi.yaml .`; `sbx kit validate --offline` cannot build v3 source kits in 0.50.1. Never name v3 descriptors `spec.yaml`, which selects the legacy parser. Also test host policy/approval and fresh/existing-sandbox flows before release.
- Keep tests focused on observable kit contracts and safety invariants. Do not add tests that mirror arbitrary file contents or implementation details; they are brittle and mostly catch intentional refactors rather than user-visible regressions.

## Host RPC and commits

- Read `docs/host-rpc.md` before using or changing host RPC. Notifications, network reports, and host commit requests share the session-file queue; notifications are automatic extension events, not an agent tool.
- For a user-requested host-side commit, use `host_git_commit` when available. It requires explicit host `git.commit` permission, matching host HEAD/staged tree, and desktop approval. Stage only intended files; never transmit signing passphrases or automatically retry an uncertain outcome.
- Distinguish checkout code from the running installation: Pi loads bundled extensions and protocol code from `/opt/sbx-kit-pi/`, while the host launcher starts its listener from its own kit directory. A missing tool does not mean the checkout lacks the feature. Inspect the installed code and host configuration before diagnosing availability; do not bypass a missing tool or host permission by manually writing queue requests.
- Host handler/policy changes require a launcher relaunch. Bundled extension/protocol changes require deploying an updated image and recreating the sandbox for the normal image-based workflow; relaunching against an old image is insufficient. Warn that recreation deletes sandbox-local data before doing it.

## Important constraints

- Keep OAuth-based `openai-codex` authentication; do not add `OPENAI_API_KEY` configuration.
- Keep the network allowlist minimal and explicit.
- Do not write Pi user settings from the kit.
- Use the kit's own semver (`package.json`) for the custom image tag; do not use Pi's version as the image tag.
- Keep the default Docker Hub namespace configurable through `DOCKERHUB_USERNAME` in the Makefile, while `sbx-kit-pi.yaml` references the concrete public image that Docker Sandbox can pull.
- When changing Pi, update the Dockerfile `PI_AGENT_VERSION` build argument default and both package manifests/lockfiles. Security overrides must affect the modular runtime, not merely pass the checkout audit. Bump the kit semver in `package.json`, `package-lock.json`, and the `sbx-kit-pi.yaml` image tag for a release, then test fresh and existing-sandbox flows.
- Follow the parent Docker Sandbox guidance: never add shell completions to `/etc/sandbox-persistent.sh`.
