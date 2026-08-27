# Project Notes

This repository is `sbx-kit-pi`: a Docker Sandbox kit that launches the Pi coding agent with the `openai-codex` provider using ChatGPT OAuth credentials rather than an OpenAI API key.

## Key files

- `spec.yaml` defines the sandbox kit: Pi entrypoint, OAuth credential binding, minimal network allowlist, runtime Pi safety environment, and custom sandbox image reference.
- `Dockerfile` builds the custom sandbox image with Pi and bundled extensions under `/opt/sbx-kit-pi/extensions/`.
- `scripts/run` is the host launcher. It derives a workspace-specific sandbox/session name, builds the custom image when missing, and runs or attaches via `sbx run`.
- `extensions/agents-postprocessor.ts` and `extensions/agents-classifier-output.ts` implement preprocessing for Docker Sandbox-generated `AGENTS.md` files and generated skills.
- `tests/spec.test.js` contains static tests for the kit contract.
- `Makefile` exposes common shortcuts (`make test`, `make audit`, `make check`, `make run`, `make attach`, etc.).

## Development workflow

- Use Node.js 20+.
- Run `npm test` for static tests.
- Run `./scripts/check` (or `make check`) to install locked dependencies, audit, test, and run `sbx kit validate .` when `sbx` is available.
- Run `sbx kit validate .` on a Docker Sandbox host when changing `spec.yaml`.
- Keep tests focused on observable kit contracts and safety invariants. Do not add tests that mirror arbitrary file contents or implementation details; they are brittle and mostly catch intentional refactors rather than user-visible regressions.

## Important constraints

- Keep OAuth-based `openai-codex` authentication; do not add `OPENAI_API_KEY` configuration.
- Keep the network allowlist minimal and explicit.
- Do not write Pi user settings from the kit.
- When changing the Pi version, update the `spec.yaml` image tag and Dockerfile `PI_AGENT_VERSION` build argument default, then test fresh and existing-sandbox flows.
- Follow the parent Docker Sandbox guidance: never add shell completions to `/etc/sandbox-persistent.sh`.
