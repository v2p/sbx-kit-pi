# Project Notes

This repository is `sbx-kit-pi`: a Docker Sandbox kit that launches the Pi coding agent with the `openai-codex` provider using ChatGPT OAuth credentials rather than an OpenAI API key.

## Key files

- `spec.yaml` defines the sandbox kit: Pi entrypoint, OAuth credential binding, minimal network allowlist, pinned `PI_AGENT_VERSION`, and setup install command.
- `scripts/run` is the host launcher. It derives a workspace-specific sandbox/session name, copies the agent-instruction postprocessor extension into the session runtime directory, and runs or attaches via `sbx run`.
- `extensions/agents-postprocessor.ts` and `extensions/agents-classifier-output.ts` implement preprocessing for Docker Sandbox-generated `AGENTS.md` files and generated skills.
- `tests/spec.test.js` contains static tests for the kit contract.
- `Makefile` exposes common shortcuts (`make test`, `make audit`, `make check`, `make run`, `make attach`, etc.).

## Development workflow

- Use Node.js 20+.
- Run `npm test` for static tests.
- Run `./scripts/check` (or `make check`) to install locked dependencies, audit, test, and run `sbx kit validate .` when `sbx` is available.
- Run `sbx kit validate .` on a Docker Sandbox host when changing `spec.yaml`.

## Important constraints

- Keep OAuth-based `openai-codex` authentication; do not add `OPENAI_API_KEY` configuration.
- Keep the network allowlist minimal and explicit.
- Do not write Pi user settings from the kit.
- When changing the Pi version, update `PI_AGENT_VERSION` in `spec.yaml` and test fresh and existing-sandbox flows.
- Follow the parent Docker Sandbox guidance: never add shell completions to `/etc/sandbox-persistent.sh`.
