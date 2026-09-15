# Pi with OpenAI Codex

Run [Pi](https://github.com/earendil-works/pi) in a Docker Sandbox using Codex
access from a ChatGPT subscription. Authentication uses OpenAI OAuth, not an
OpenAI API key or API billing.

## Requirements

- Docker Sandboxes with `sbx` and schema v2 OAuth credential-file support
- A ChatGPT subscription with Codex access
- Optional on Linux: `notify-send` (usually provided by `libnotify-bin` or
  `libnotify`) for desktop completion notifications

## Run

```console
./scripts/run
```

The launcher checks for the workspace's deterministic sandbox name. If it
already exists, the launcher attaches to it; otherwise, Docker Sandbox creates
it from the public versioned image referenced by `spec.yaml`.

On the first launch, Pi can import the current Codex CLI login from
`${CODEX_HOME:-$HOME/.codex}/auth.json`:

```console
./scripts/run --import-codex-auth
```

The launcher copies the Codex file to a private staging directory rather than
mounting the original. The container extracts only the access token, refresh
token, expiration, and account ID into Pi's `~/.pi/agent/auth.json`, then both
the container entrypoint and host launcher remove the staged copy. Pi refreshes
its own credential afterward; it does not update the Codex CLI file.

The import option only applies while creating a sandbox. To import into an
existing workspace sandbox, recreate it:

```console
./scripts/run --update --import-codex-auth
```

Alternatively, use Pi's independent login flow:

1. Approve the `openai-codex` credential binding when prompted.
2. Run `/login openai-codex` in Pi.
3. Select **Device code login (headless)** and sign in.

Use `/model` to select another Codex model.

## Linux desktop notifications

When `notify-send` is available on the Linux host, the launcher enables desktop
notifications automatically. Pi sends one after an agent job has fully settled
(including automatic retries, compaction retries, and queued follow-ups). The
title contains the project name and the body contains the deterministic sandbox
name; a Pi session name is included when one has been set with `/name`.

The integration has two small components without opening a network port. The
bundled `linux-notifications.ts` Pi extension appends completion events to a
private queue file in the already mounted project session directory. A
lightweight listener inside `scripts/run` consumes that queue while Pi is
attached and calls `notify-send` in the host desktop session. The queue exists
only while the host listener is active, so unattended sandbox processes do not
accumulate notifications. The extension derives the project, sandbox, and
session directory from Docker Sandbox and Pi runtime
context, so no private Pi arguments are needed. Notification failures never
interrupt an agent job. Set
`SBX_PI_NOTIFICATIONS=off` to disable the integration, or set it to `on` to
require it and fail early when `notify-send` is unavailable. The default is
`auto`.

Existing sandboxes must be recreated once to pick up the bundled extension:

```console
./scripts/run --update
```

On later launches, run the same command to reattach automatically. Pi resume
flags can be passed directly:

```console
./scripts/run --resume
./scripts/run --continue
```

To replace the current workspace's existing sandbox with the image referenced by
the current kit, run:

```console
./scripts/run --update
```

This removes and recreates the sandbox under the same deterministic name. The
host-mounted Pi sessions remain available, and the OAuth credential binding can
restore the stored credential. Other sandbox-local changes are discarded. A
container image and its base image cannot be replaced in place, so recreation is
required to upgrade them.

## Add capability kits

Pi remains the sandbox runtime while optional [mixin
kits](https://docs.docker.com/ai/sandboxes/customize/kits/) add focused
capabilities such as a language toolchain, cloud CLI, package registry, or team
instructions. Pass `--kit` more than once to compose them when creating a
sandbox:

```console
./scripts/run \
  --kit docker.io/acme/java-kit:1.0 \
  --kit docker.io/acme/github-kit:2.3
```

The launcher accepts local directories, pinned Git references, and OCI
artifacts supported by `sbx`:

```console
./scripts/run --kit ./sandbox-kits/project-tools
./scripts/run --kit 'git+https://github.com/acme/sbx-kits.git#ref=v1.2.0&dir=node'
./scripts/run --kit docker.io/acme/node-kit:1.2.0
```

A local schema-v2 example is available at
[`examples/mixins/project-bootstrap/`](examples/mixins/project-bootstrap/).
Copy it into a project and adjust its install command, network access, and agent
instructions for that project.

Kits are fixed when a sandbox is created. To add, remove, or change mixins on an
existing workspace sandbox, recreate it with the complete desired set:

```console
./scripts/run --update --kit docker.io/acme/java-kit:1.1
```

Run `./scripts/run --update` without additional kits to return to the base Pi
kit. An already configured sandbox is reattached automatically; do not repeat
its kit arguments. Use `--` to end launcher options explicitly when needed:

```console
./scripts/run --kit ./sandbox-kits/project-tools -- --continue
```

Treat kits as executable dependencies: install commands can run as root. Review
local and Git-hosted kits, pin Git tags or commits and OCI versions, and avoid
mutable references such as `main` or `latest`. Docker Hub is allowed as a kit
source by default; other Git or registry publishers must be explicitly added to
Docker Sandbox's `kit.allowedSources` setting. Keep each mixin's network and
credential permissions narrow. Prefer proxy-managed credentials for external
services so secrets remain on the host; this kit's OpenAI OAuth passthrough is a
provider-specific exception.

## Install as a user command

For use from any project directory on Linux, install the launcher as a symlink
under `~/.local/bin`:

```console
make install
cd ~/Projects/another-project
sbx-pi
sbx-pi --resume
sbx-pi --update
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

The custom sandbox image installs Pi and copies this kit's extension into
`/opt/sbx-kit-pi/extensions/` at image build time. The sandbox entrypoint loads
it with `--extension`. The extension processes the Docker Sandbox-generated
ancestor `AGENTS.md` during `session_start`. When its source hash changes, the
extension starts an isolated Pi subprocess and asks the active model to classify
every source line as:

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

When changing this kit's extension code, rebuild the image and recreate the
sandbox so the updated bundled extension is present in
`/opt/sbx-kit-pi/extensions/`. Repeating OAuth login is not required unless Pi
reports missing provider authentication.

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
Other Pi state remains under `~/.pi/agent/` in the sandbox. Credentials
created through the Docker Sandbox OAuth binding can be restored when it is
recreated. A credential imported from Codex CLI is sandbox-local after the
one-time import; use `--update --import-codex-auth` to seed it again when
recreating that sandbox.

Additional workspaces are fixed when a sandbox is created, so remove an existing
sandbox before switching it to this launcher. Session files can contain prompts,
source excerpts, command output, and secrets; keep the host directory private.

## Security

Pi needs the real OAuth access-token JWT to determine the ChatGPT account ID, so
the kit enables OAuth passthrough. Access and refresh tokens are therefore
available inside the sandbox at `~/.pi/agent/auth.json` with mode `0600`. Keep
the sandbox private and do not copy or share this file.

Codex import is explicit because it gives the sandbox a copy of the host Codex
OAuth credential. Do not run Codex CLI and Pi concurrently from the same
imported refresh token: token rotation by either client can make the other
client's stored credential stale. An independent `/login openai-codex` remains
the safer option for concurrent use.

Network access is restricted in `spec.yaml`. Pi's update check and telemetry are
disabled, and the kit does not modify user settings.

## Development

Node.js 20 or newer and Docker are required for development. The Makefile is
limited to image release tasks and installation of the optional user command.
Build and smoke-test the image locally with:

```console
make image
```

The default publishing destination is derived from configurable Make variables:

```console
make publish
make publish DOCKERHUB_USERNAME=another-user
```

The checked-in `spec.yaml` references the concrete public image
`docker.io/vposvistelik/sbx-kit-pi:<kit-version>` so Docker Sandbox can pull it.
Changing the publishing namespace also requires updating that reference.

Run the full development check with:

```console
./scripts/check
```

This installs locked test dependencies, audits them, runs the tests, builds and
smoke-tests the custom image when Docker is available, and invokes
`sbx kit validate .` when `sbx` is available. Skipped checks must be run on a
Docker Sandbox host. For a quick static-test iteration, run `npm test`; audit
dependencies separately with `npm run audit`.

The custom image tag follows this kit's semver from `package.json`, independently
of Pi's version. To upgrade Pi, change the Dockerfile `PI_AGENT_VERSION` build
argument default. For a release, bump the kit version in `package.json`,
`package-lock.json`, and the `spec.yaml` image tag, rebuild the image, then test
a fresh sandbox and recreation of an existing one.

## Sign out

Run `/logout` in Pi to remove its local credential. Remove the corresponding
`openai-codex` credential binding with the `sbx` commands supported by your
Docker Sandboxes version if you also want to remove the host-side credential.
