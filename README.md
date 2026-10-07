# Pi with OpenAI Codex

Run [Pi](https://github.com/earendil-works/pi) in a Docker Sandbox with Codex
access from your ChatGPT subscription. Uses OpenAI OAuth—not an API key or API
billing.

## Get started

On your **Linux host**, you need:

- Docker Sandboxes with experimental `sbx env` commands and schema-v2 OAuth credential-file support
- An official Node.js 22.19+ build with native TypeScript support, and npm
- A ChatGPT subscription with Codex access

From this checkout, install the launcher:

```console
npm ci --omit=dev --ignore-scripts
make install
```

Ensure `~/.local/bin` is in your `PATH`, then launch from your project:

```console
cd ~/Projects/my-project
sbx-pi
```

Docker Sandbox creates a sandbox using the public image in `spec.yaml`. On later
runs, the same command attaches to that project's sandbox automatically.

For first-time authentication:

1. Approve the `openai-codex` credential binding when prompted.
2. Run `/login openai-codex` in Pi.
3. Select **Device code login (headless)** and sign in.

The default model is `gpt-6.1-sol`; use `/model` to change it.

Already signed in with Codex CLI? You can instead seed a **new** sandbox with
that login:

```console
sbx-pi --import-codex-auth
```

This copies `${CODEX_HOME:-$HOME/.codex}/auth.json` through a private temporary
file; it does not mount or update the original. Do not use Codex CLI and Pi
concurrently with the imported credential: refresh-token rotation can invalidate
one client's login. Independent Pi login is safer for concurrent use.

Installation is per-user and checkout-backed: keep this checkout, Node.js, and
its dependencies available. No sudo is needed. To try without installing, run
`npm ci --omit=dev --ignore-scripts` and invoke `/path/to/sbx-kit-pi/scripts/run`
from your project. `make uninstall` removes the installed command.

## Everyday use

```console
sbx-pi                  # Create or attach
sbx-pi --continue       # Continue the latest Pi session
sbx-pi --resume         # Choose a saved Pi session
sbx-pi --help           # Launcher help
sbx-pi -- --help        # Pi help
```

Put launcher options before Pi arguments. The first unrecognized argument starts
Pi passthrough; `--` makes that boundary explicit.

Sessions live on the host in
`~/pi-sessions-backup/<project-name>-<project-path-hash>/`. Each absolute
project configuration directory gets its own default sandbox and session directory.
A native YAML `name` overrides the sandbox name; its `workspace` may point elsewhere
or use clone mode. Session files may contain source code and secrets; keep them private.

### Recreate or upgrade a sandbox

After updating this checkout, replace an existing sandbox with the image and
configuration selected by the current kit:

```console
sbx-pi --recreate
```

**This deletes sandbox-local changes**, including installed tools and local Pi
state. Your mounted project files and saved sessions survive. Docker Sandbox's
OAuth binding can restore its stored credential; a Codex-imported login must be
seeded again with `--recreate --import-codex-auth`.

For native environments, Docker owns planning, approval, and reconciliation.
Workspace, kit, port, credential, and resource changes require recreation;
environment/session changes follow `sbx env` behavior. Changes to the Pi kit or
supplemental allowed hosts also require recreation. Run `sbx-pi plan` to inspect
the native plan. The launcher does not check for new kit releases.

## Configure the sandbox

Use Docker's native [sandbox environment file](https://docs.docker.com/ai/sandboxes/configuration/environment-files/)
for everything it supports: kits, workspaces, read-only mounts, environment
variables, ports, resources, credentials, MCP, and host lifecycle commands.
`sbx env` is experimental; use a version supporting layered YAML, `run --detached`,
and `exec` with environment arguments.

From your project configuration directory:

```console
sbx-pi init --kit docker.io/acme/node-kit:1.2.0 --kit ./sandbox-kits/project-tools
```

This creates and displays **`sbxenv.yaml`**, without Docker or an automatic launch:

```yaml
schemaVersion: "1"
agent: pi-openai-codex
workspace: .
kits:
  - docker.io/acme/node-kit:1.2.0
  - ./sandbox-kits/project-tools
additionalWorkspaces:
  - path: ../reference-docs
    readOnly: true
ports:
  - sandbox: 3000
    host: 8080
sandboxOptions:
  cpus: 2
  memory: 4g
```

The example includes optional settings to add after initialization. `init` never
overwrites an existing YAML file, inherits a parent configuration, or persists
global host RPC policy. Local kit paths must remain inside the project
for a portable generated file. The `acme` references are placeholders; choose
real reviewed kits. A local example is in
[`examples/mixins/project-bootstrap/`](examples/mixins/project-bootstrap/).

**Kits and lifecycle commands execute code, including on the host.** Review them,
pin versions/commits, and inspect the approval plan. Docker's source restrictions,
credential approvals, and organization policies remain in force.

Launches walk upward to the nearest directory containing `sbxenv.yaml` or
`sbx-pi.toml`, loading both when present. Docker resolves paths and merges YAML;
the launcher does not flatten YAML into CLI flags. It adds a stable, private YAML
layer outside the workspace containing its Pi kit and persistent session mount.
Only missing `agent` and `name` values receive launcher defaults. Omitting
`workspace` retains Docker's mountless behavior.
The agent must be `pi-openai-codex`; use `sbx env` directly for other agents.

| Option | Effect |
| --- | --- |
| `--env PATH` | Select native YAML or its directory; repeat for ordered layers. |
| `--env-arg NAME=VALUE` | Forward a declared environment argument to Docker. |
| `--env-args-file PATH` | Forward an argument file; repeat as needed. |
| `--config PATH` | Select Pi TOML and its sibling `sbxenv.yaml`. |
| `--no-config` | Disable project discovery; retain the legacy current-directory launch. |
| `--allow-host HOST` | Replace supplemental allowed hosts; repeat for multiple hosts. |

`--env` and `--config` cannot be combined, nor combined with `--no-config`.
With explicit YAML layers, Pi TOML is loaded beside the first layer. As with native
`sbx env` using explicit paths, `~/.sbxenv.yaml` is not implicitly loaded.
YAML argument expressions are resolved by Docker, not by the launcher.

### Pi-only and missing native settings

Optional **`sbx-pi.toml`** holds settings not covered by `sbx env`:

```toml
schema_version = 1

[network]
allow = ["registry.npmjs.org", "api.github.com"]
```

Docker currently has no direct environment-file allowed-hosts field. The launcher
turns this list into a permission-only mixin for this sandbox; it never adds global
policy rules. Explicit denies and organization policy still take precedence.
Changing this list requires `--recreate`. An empty list removes supplemental
permissions on recreation, not the base Pi kit's required hosts.

### Legacy projects

TOML-only projects and launches without configuration keep their existing behavior.
Legacy `kits`, `--kit`, and `--no-kits` remain supported there. Once YAML exists,
move `kits` into YAML and remove the TOML key; CLI kit overrides are rejected to
avoid two sources of truth. `init --kit` remains the convenient way to generate
YAML, including expansion of personal aliases. See [configuration details](docs/configuration.md).

### Global configuration

Optional defaults live at `~/.config/sbx-pi/global.toml` (or
`$XDG_CONFIG_HOME/sbx-pi/global.toml`). Keep this file outside sandbox-writable
mounts:

```toml
schema_version = 1

[kit_aliases]
node = "docker.io/acme/node-kit:1.2.0"
```

You can create aliases from the CLI:

```console
sbx-pi config alias node docker.io/acme/node-kit:1.2.0
sbx-pi config alias node docker.io/acme/node-kit:1.3.0 --replace
sbx-pi init --kit @node
```

Aliases do not inject default kits. `init` expands them into concrete YAML references
for sharing; native YAML does not interpret `@aliases`. Alias writes preserve
settings but reformat TOML and remove comments.
See [configuration details](docs/configuration.md) for path and write behavior.

### Sandbox-to-host requests

Notifications now use a versioned, allowlisted JSON-RPC file queue. The bridge
also records domains submitted through Pi's `host_network_request` tool and
metadata about observed Pi `read` calls in a private host-side log. Network
requests do **not** grant access; read telemetry is **not** a tamper-proof or
system-wide security audit. No file contents are logged and no port is opened.

Set persistent host permissions in global TOML (not project TOML):

```toml
[host_rpc]
allow = ["notification.send", "network.request", "file.access"]
```

An empty array disables the bridge. Override global defaults for one launch
using host-only environment settings (for example, `off` for untrusted sources):

```console
SBX_PI_HOST_RPC_ALLOW=notification.send,network.request sbx-pi
SBX_PI_HOST_RPC_ALLOW=off sbx-pi
```

By default, all three built-in handlers are allowed. Desktop notifications work
when `notification.send` is allowed and host `notify-send` is available
(`libnotify-bin` or `libnotify` on most distributions). They arrive when an agent
job has fully settled, including retries and queued work; failures never
interrupt Pi. To disable only notifications, omit `notification.send`:

```console
SBX_PI_HOST_RPC_ALLOW=network.request,file.access sbx-pi
```

Consumers can attach ordered handler scripts through host-owned global config:

```toml
[host_rpc.handlers]
"network.request" = [["default"], ["python3", "/home/me/rpc/review.py"]]
```

Each method has a standalone reference handler, used by default. Commands receive
validated reports as JSON on stdin and return a status as JSON on stdout.
See [Host RPC](docs/host-rpc.md#attaching-consumer-handlers) for handler configuration,
the protocol, log location, review commands, and limitations.

### Inspect configuration

```console
sbx-pi config show
sbx-pi status
sbx-pi plan
```

`config show` emits launcher configuration as JSON without invoking Docker.
`status` emits JSON; native environments report `not-created`, `exists`, or
`unknown` (for parameterized names), without claiming complete drift detection.
`plan` delegates to `sbx env plan` with the same layers used for launch; it writes
only the private launcher adapter, not session directories or sandbox resources.
These commands accept configuration options. Neither `status` nor `plan` starts Pi.
Docker's plan does not detect all changes inside local kits or mutable references;
recreate explicitly when those change.

Copyable TOML examples are in [`examples/config/`](examples/config/).

## Optional Zsh completion

Generate an autoload file manually on the host:

```zsh
mkdir -p ~/.zfunc
sbx-pi completion zsh > ~/.zfunc/_sbx-pi
```

Add to `~/.zshrc`, **before** your framework initializes completion:

```zsh
fpath=(~/.zfunc $fpath)
```

Without a framework, add `autoload -Uz compinit` and `compinit` after that line.
Restart your shell; if you use a cached completion dump, remove `~/.zcompdump`
(or your framework's configured dump) so `compinit` discovers the new file.
If you customized the installed command name, use it in both the generator call
and filename: `my-pi completion zsh > ~/.zfunc/_my-pi`.

The generator only prints to stdout; it does not install files or change shell
configuration. Regenerate the file after updating the launcher. Completion suggests
launcher commands and flags with short descriptions, plus aliases and paths;
it stops at Pi arguments. It makes no Docker
or network calls and writes no state. Bash completion is not provided.

To disable it, delete the generated file and refresh the completion dump before
restarting.

## Security and sign out

OpenAI OAuth access and refresh tokens are available inside the sandbox at
`~/.pi/agent/auth.json` with mode `0600`: Pi needs the real access-token JWT to
identify your ChatGPT account. Keep the sandbox private and never share that
file. Prefer proxy-managed credentials for other services.

Network access is restricted by `spec.yaml`. Pi's update check and telemetry are
disabled. The kit does not write Pi user settings.

Run `/logout` in Pi to remove its local credential. To also remove a host-stored
credential, remove the `openai-codex` binding using the `sbx` commands supported
by your Docker Sandboxes version.

## More details

- [Runtime behavior](docs/runtime.md): token usage, notifications, instruction preprocessing, and persistence
- [Configuration details](docs/configuration.md): aliases and applied state
- [Development](docs/development.md): checks, image builds, and releases
