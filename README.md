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

The kit starts with `gpt-6.1-sol`. Use `/model` to select another Codex model.

## Token usage

After every LLM turn, Pi prints a compact usage line in the interactive
transcript:

```text
tokens · prompt 38,247 (new 2,100, cached 36,147) · output 1,402 (reasoning 920) · total 39,649
```

The prompt breakdown distinguishes newly processed tokens from cache reads and,
when reported by the provider, cache writes. Reasoning is a subset of output.
These per-turn lines complement Pi's cumulative token and context-window totals
in the footer and do not become part of the model context or persisted session.

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

Run `./scripts/run --update --no-kits` to return to the base Pi kit. Without
CLI overrides, `--update` uses the project manifest's kits (or no mixins if
there is no manifest). An already configured sandbox is reattached automatically;
do not repeat its kit arguments. Use `--` to end launcher options explicitly when needed:

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

## Global and project configuration

Copyable examples are in [`examples/config/`](examples/config/).

The Linux host launcher requires Node.js 22.19+ and its locked TOML dependency.
For direct checkout use, run `npm ci --ignore-scripts` first. Configuration is
host-side only: it does not modify Pi settings or Docker Sandbox's allowed
sources, network policies, or credentials.

Optional personal defaults live at
`$XDG_CONFIG_HOME/sbx-pi/config.toml` (default `~/.config/sbx-pi/config.toml`):

```toml
schema_version = 1
notifications = "auto"

[kit_aliases]
node = "docker.io/acme/node-kit:1.2.0"
github = "docker.io/acme/github-kit:2.3"
```

Create aliases without editing TOML manually:

```console
sbx-pi config alias node docker.io/acme/node-kit:1.2.0
sbx-pi config alias tools ./sandbox-kits/tools
sbx-pi config alias node docker.io/acme/node-kit:1.3.0 --replace
```

The command creates the global configuration if needed and preserves existing
settings and other aliases. Existing names require `--replace`. Names contain
letters, digits, underscores, or hyphens, without the `@` prefix; alias-to-alias
references are rejected. CLI local paths are resolved from the current directory
and stored as absolute paths in this personal configuration, not project files.
The command does not invoke Docker Sandbox or modify project manifests.

Writes are atomic, use private file permissions, and refuse symlinked configuration
files. A lock prevents concurrent alias commands from overwriting each other's
changes. TOML is reserialized when saving, so comments and custom formatting are
not retained; edit the file manually if those need to be preserved.

Use aliases explicitly: `sbx-pi --kit @node`. Aliases reference individual kits,
not other aliases. Relative alias paths beginning with `.` are resolved against
the global configuration directory. There are no globally injected default kits.

Create a project manifest explicitly from your project root:

```console
sbx-pi init
sbx-pi init --kit @node --kit ./sandbox-kits/project-tools
```

`init` creates and displays `sbx-pi.toml` in the **current directory**, without
starting Docker Sandbox or creating session/state directories. It never overwrites
an existing file, directory, or symlink. It does not discover or copy a parent
manifest, snapshot an existing sandbox, or persist personal notification settings.
Supply the complete desired mixin list with `--kit`; without kits it writes an
empty list. `--no-kits` can clear earlier kit arguments.

Aliases are expanded to concrete references. Project-local paths are stored
relative to the new manifest; local paths outside the current project are
rejected rather than persist host-specific locations. Remote references are
preserved as supplied, so pin their versions before sharing the manifest.
`--config`, `--no-project-config`, and sandbox/Pi runtime options are not accepted
by `init`. A normal first run without a manifest only prints an `init` hint; it
never creates configuration automatically.

Review and commit the resulting `sbx-pi.toml`, or write one yourself:

```toml
schema_version = 1
notifications = "auto"
kits = [
  "docker.io/acme/node-kit:1.2.0",
  "./sandbox-kits/project-tools",
]
```

The launcher walks upward from the current directory to find the nearest
manifest; that manifest's directory becomes the workspace, including when
launched from a subdirectory. Relative project kit paths beginning with `.`
are resolved against that directory. Prefer concrete pinned references in
shared manifests: `@aliases` depend on each user's personal configuration.

- `--config PATH` selects a project manifest explicitly; its directory becomes
  the workspace.
- `--no-project-config` disables discovery and uses the current directory as the
  workspace. It cannot be combined with `--config`.
- Repeated `--kit` options replace the configured kit list, rather than merge
  with it. CLI relative paths are invocation-relative.
- `--no-kits` clears the selected mixins; subsequent `--kit` options add to that
  empty list. CLI overrides never rewrite configuration files.
- Notifications use `SBX_PI_NOTIFICATIONS`, then project configuration, then
  global configuration, then `auto`. TOML values are `auto`, `on`, or `off`.
- Unknown keys, unsupported schema versions, and invalid values fail before
  invoking Docker Sandbox.

Inspect the effective configuration or the current project's sandbox:

```console
sbx-pi config show
sbx-pi status
sbx-pi --update
```

The inspection commands emit JSON. `config show` does not invoke `sbx`; `status`
only lists sandboxes and reports `not-created`, `unknown` (no recorded launcher
state), `current`, or `drifted`. Both accept configuration-selection and kit
options. They do not create or recreate sandboxes.

Applied state is stored under `$XDG_STATE_HOME/sbx-pi/sandboxes/` (default
`~/.local/state/sbx-pi/sandboxes/`) after a successful creating run. The launcher
compares workspace, resolved kit references, and the base kit specification.
It warns about known configuration drift while attaching normally; changes are
**never applied automatically**. `--update` recreates using the effective
configuration and discards sandbox-local changes, while mounted sessions survive.
Kit references are printed before creation; review manifests and kits before
running them, as kit install commands may execute as root.

Reference comparison cannot detect changed contents inside local kits or behind
mutable Git/registry references. Pin versions and explicitly recreate when local
kits change. Image pulling, release checking, profiles, and bulk sandbox updates
are not implemented by this configuration layer.

## Install as a user command

For use from any project directory on Linux, install the launcher as a symlink
under `~/.local/bin`:

```console
npm ci --omit=dev --ignore-scripts
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
shell's `PATH`. This remains a per-user, checkout-backed installation: keep
Node.js, this checkout, and its runtime dependencies available. No sudo or
shell configuration changes are required by the installer.

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

Node.js 22.19 or newer and Docker are required for development. The Makefile is
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

This installs locked development dependencies, audits them, checks formatting and
lint, runs the tests, builds and smoke-tests the custom image when Docker is
available, and invokes
`sbx kit validate .` when `sbx` is available. Skipped checks must be run on a
Docker Sandbox host. For a quick static-test iteration, run `npm test`; audit
dependencies separately with `npm run audit`.

### Code style and linting

Install the development tools with `npm ci --ignore-scripts`. JavaScript, MJS,
and TypeScript use ESLint's recommended JavaScript and typescript-eslint presets.
Prettier owns formatting, with its standard defaults and a 100-column print
width: two spaces, double quotes, semicolons, and trailing commas. EditorConfig
keeps editor indentation and line endings consistent. `eslint-config-prettier`
disables conflicting lint rules; imports are not automatically reordered.
ESLint requires braces for every `if`, `else`, and loop body, even a single statement.

```console
npm run lint          # Check code; warnings fail the check
npm run lint:fix      # Apply safe ESLint fixes
npm run format:check # Check formatting without changing files
npm run format       # Format TS/MJS/JS and root JSON files
```

CI runs both checks through `scripts/check`. The TypeScript preset is intentionally
not type-aware: linting needs no Pi runtime or TypeScript project configuration,
and is not a substitute for type checking. Intentional exceptions should use
narrow inline suppressions with an explanation rather than disable rules globally.

The custom image tag follows this kit's semver from `package.json`, independently
of Pi's version. To upgrade Pi, change the Dockerfile `PI_AGENT_VERSION` build
argument default. For a release, bump the kit version in `package.json`,
`package-lock.json`, and the `spec.yaml` image tag, rebuild the image, then test
a fresh sandbox and recreation of an existing one.

## Sign out

Run `/logout` in Pi to remove its local credential. Remove the corresponding
`openai-codex` credential binding with the `sbx` commands supported by your
Docker Sandboxes version if you also want to remove the host-side credential.
