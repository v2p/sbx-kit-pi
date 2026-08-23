# Pi with OpenAI Codex

Run [Pi](https://github.com/earendil-works/pi) in a Docker Sandbox using Codex
access from a ChatGPT subscription. Authentication uses OpenAI OAuth, not an
OpenAI API key or API billing.

## Requirements

- Docker Sandboxes with `sbx` and schema v2 OAuth credential-file support
- A ChatGPT subscription with Codex access

## Run

```console
sbx kit validate .
./scripts/run
```

On the first launch:

1. Approve the `openai-codex` credential binding when prompted.
2. Run `/login openai-codex` in Pi.
3. Select **Device code login (headless)** and sign in.

Use `/model` to select another Codex model.

To reattach to the same sandbox later, run:

```console
./scripts/run --attach
```

Pass Pi resume flags after `--attach`:

```console
./scripts/run --attach --resume
./scripts/run --attach --continue
```

## Session persistence

The launcher stores sessions in a project-specific host directory:

```text
~/pi-sessions-backup/<project-name>-<workspace-path-hash>/
```

The hash avoids collisions between projects with the same directory name. The
launcher mounts only that directory and passes it to Pi with `--session-dir`.
Other Pi state remains under `~/.pi/agent/` in the sandbox; refreshed OAuth
credentials can be restored when it is recreated.

Additional workspaces are fixed when a sandbox is created, so remove an existing
sandbox before switching it to this launcher. Session files can contain prompts,
source excerpts, command output, and secrets; keep the host directory private.

## Security

Pi needs the real OAuth access-token JWT to determine the ChatGPT account ID, so
the kit enables OAuth passthrough. Access and refresh tokens are therefore
available inside the sandbox at `~/.pi/agent/auth.json` with mode `0600`. Keep
the sandbox private and do not copy or share this file.

Network access is restricted in `spec.yaml`. Pi's update check and telemetry are
disabled, and the kit does not modify user settings.

## Development

Node.js 20 or newer is required. Run:

```console
./scripts/check
```

This installs locked test dependencies, audits them, runs the tests, and invokes
`sbx kit validate .` when `sbx` is available. Otherwise, validation must be run
on the Docker Sandbox host.

To upgrade Pi, change `PI_AGENT_VERSION` in `spec.yaml`, then test a fresh
sandbox and recreation of an existing one.

## Sign out

Run `/logout` in Pi to remove its local credential. Remove the corresponding
`openai-codex` credential binding with the `sbx` commands supported by your
Docker Sandboxes version if you also want to remove the host-side credential.
