# Project Notes

This repository is `sbx-kit-pi`: a Docker Sandbox kit that launches the Pi coding agent with the `openai-codex` provider using ChatGPT OAuth credentials rather than an OpenAI API key.

## Key files

- `spec.yaml` defines the sandbox kit: Pi entrypoint, OAuth credential binding, minimal network allowlist, runtime Pi safety environment, and custom sandbox image reference.
- `Dockerfile` builds the custom sandbox image with Pi and bundled extensions under `/opt/sbx-kit-pi/extensions/`.
- `scripts/run` is the host launcher. It derives a workspace-specific sandbox/session name and runs or attaches via `sbx run`; Docker Sandbox pulls the published custom image.
- `extensions/agents-postprocessor.ts` and `extensions/agents-classifier-output.ts` implement preprocessing for Docker Sandbox-generated `AGENTS.md` files and generated skills.
- `tests/spec.test.js` contains static tests for the kit contract.
- `Makefile` is intentionally limited to building/publishing the image and installing/uninstalling the optional user command.

## Development workflow

- Use Node.js 20+.
- Run `npm test` for static tests.
- Run `./scripts/check` to install locked dependencies, audit, test, build and smoke-test the custom image when Docker is available, and run `sbx kit validate .` when `sbx` is available.
- Use `make image` for a local image build plus smoke test and `make publish` for a release push.
- Run `sbx kit validate .` on a Docker Sandbox host when changing `spec.yaml`.
- Keep tests focused on observable kit contracts and safety invariants. Do not add tests that mirror arbitrary file contents or implementation details; they are brittle and mostly catch intentional refactors rather than user-visible regressions.

## Important constraints

- Keep OAuth-based `openai-codex` authentication; do not add `OPENAI_API_KEY` configuration.
- Keep the network allowlist minimal and explicit.
- Do not write Pi user settings from the kit.
- Use the kit's own semver (`package.json`) for the custom image tag; do not use Pi's version as the image tag.
- Keep the default Docker Hub namespace configurable through `DOCKERHUB_USERNAME` in the Makefile, while `spec.yaml` references the concrete public image that Docker Sandbox can pull.
- When changing Pi, update the Dockerfile `PI_AGENT_VERSION` build argument default. Bump the kit semver in `package.json`, `package-lock.json`, and the `spec.yaml` image tag for a release, then test fresh and existing-sandbox flows.
- Follow the parent Docker Sandbox guidance: never add shell completions to `/etc/sandbox-persistent.sh`.
