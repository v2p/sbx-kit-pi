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

## Make shortcuts

Run `make help` to list the project shortcuts. Common targets are:

```console
make validate
make test
make audit
make check
make run ARGS="--model gpt-5.6-sol"
make attach
make resume
make continue
```

## Install as a user command

For use from any project directory on Linux, install the launcher as a symlink
under `~/.local/bin`:

```console
make install
cd ~/Projects/another-project
sbx-pi
sbx-pi --attach --resume
```

Override the destination or command name when needed:

```console
make install PREFIX="$HOME/.local" COMMAND=pi-sandbox
```

The launcher resolves its symlink back to this kit checkout, while treating the
current directory as the project workspace. Run `make uninstall` from the same
checkout to remove its installed command. Ensure `~/.local/bin` is in the host
shell's `PATH`.

## Docker Sandbox instruction preprocessing

`scripts/run` installs a temporary Pi extension that processes the Docker
Sandbox-generated ancestor `AGENTS.md` during `session_start`. When its source
hash changes, the extension starts an isolated Pi subprocess and asks the
active model to classify every source line as:

- **Always:** required for correct sandbox reasoning or prevention of a
  high-impact/recurrent mistake.
- **On demand:** operational guidance moved verbatim, by source line range, to
  an Agent Skill.
- **Drop:** generic development guidance or repository-discoverable facts.

The child has context files, skills, normal extensions, and built-in tools
disabled. It can only submit a structured classification. The processor rejects
missing, overlapping, out-of-range, or invalid skill classifications before
writing anything.

Generated skills are stored under the project session directory's `skills/`
folder and exposed during the same startup through `resources_discover`.
Original and processed SHA-256 hashes, the private source backup,
and the validated classification are stored beside the generated context file
so host and sandbox users share the same state:

```text
<AGENTS-directory>/.sbx-kit-pi/agents/<AGENTS-path-hash>/
```

If the current file matches the processed hash, no model call is made and
missing skill files are regenerated from the cached classification. A changed
source is classified again. If authentication, model execution, or validation
fails, Pi reports the error and leaves the current file unchanged.

When changing this kit's extension code, restart the Pi process (exit and run
`./scripts/run --attach` again) to load the updated extension; recreating the
sandbox or repeating OAuth login is not required unless Pi reports missing
provider authentication.

## Session persistence

The launcher stores sessions in a project-specific host directory:

```text
~/pi-sessions-backup/<project-name>-<workspace-path-hash>/
```

The hash avoids collisions between projects with the same directory name. It is
also included in the sandbox name, for example
`pi-openai-codex-<project>-<workspace-path-hash>`, so each absolute workspace
gets a distinct sandbox. The launcher mounts only the session directory and
passes it to Pi with `--session-dir`.
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
