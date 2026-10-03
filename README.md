# Pi with OpenAI Codex

Run [Pi](https://github.com/earendil-works/pi) in a Docker Sandbox with Codex
access from your ChatGPT subscription. Uses OpenAI OAuth—not an API key or API
billing.

## Get started

On your **Linux host**, you need:

- Docker Sandboxes with `sbx` and schema-v2 OAuth credential-file support
- Node.js 22.19+ and npm
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
`~/pi-sessions-backup/<project-name>-<workspace-path-hash>/`. Each absolute
workspace path gets its own sandbox and session directory. Session files may
contain source code and secrets; keep them private.

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

Configuration changes are never applied automatically. The launcher warns about
known drift but still attaches; `--recreate` applies the effective configuration.
It does not check for new kit releases.

## Add tools with kits

Optional [mixin kits](https://docs.docker.com/ai/sandboxes/customize/kits/) add
language toolchains, CLIs, or project instructions while Pi remains the runtime.
For a new sandbox:

```console
sbx-pi --kit docker.io/acme/node-kit:1.2.0 --kit ./sandbox-kits/project-tools
```

Kits are fixed at creation. To change an existing sandbox, pass the **complete**
desired list:

```console
sbx-pi --recreate --kit docker.io/acme/node-kit:1.3.0
sbx-pi --recreate --no-kits
```

Repeated `--kit` options replace—not extend—the manifest's list. `--no-kits`
clears the list; any subsequent `--kit` adds to that empty list. Overrides do not
rewrite configuration. On ordinary reattachment, do not repeat kit arguments.

Supported references are local directories, OCI artifacts, and pinned Git
references, for example:

```console
sbx-pi --kit 'git+https://github.com/acme/sbx-kits.git#ref=v1.2.0&dir=node'
```

The `acme` references above are placeholders; choose real kits you trust. A local
example is in [`examples/mixins/project-bootstrap/`](examples/mixins/project-bootstrap/).

**Kits execute code, potentially as root.** Review them and pin versions or
commits; avoid `latest` and `main`. Docker Hub is allowed by default. Other
publishers need approval in Docker Sandbox's `kit.allowedSources` setting.

## Save project configuration

From your project root:

```console
sbx-pi init --kit docker.io/acme/node-kit:1.2.0 --kit ./sandbox-kits/project-tools
```

This creates and displays `sbx-pi.toml` without starting a sandbox. Review and
commit it:

```toml
schema_version = 1
kits = ["docker.io/acme/node-kit:1.2.0", "./sandbox-kits/project-tools"]
```

`init` never overwrites an existing file. Without `--kit`, it writes an empty
list; it does not copy a parent manifest or snapshot an existing sandbox. Local
kits must be inside the project so the manifest remains portable.

Normal launches discover the nearest `sbx-pi.toml` by walking upward from the
current directory. Its directory becomes the workspace, even when launching
from a subdirectory. Project kit paths beginning with `.` are relative to that
manifest; CLI paths are relative to where you invoke the launcher.

| Option | Effect |
| --- | --- |
| `--config PATH` | Select a manifest explicitly; use its directory as workspace. |
| `--no-config` | Ignore project discovery; use the current directory as workspace. |
| `--kit KIT` | Replace configured kits; repeat for multiple kits. |
| `--no-kits` | Use no mixins. |

`--config` and `--no-config` cannot be combined. Neither is accepted by `init`.
A launch without a manifest works normally and never creates one automatically.

### Personal aliases and notifications

Optional defaults live at `~/.config/sbx-pi/config.toml` (or
`$XDG_CONFIG_HOME/sbx-pi/config.toml`):

```toml
schema_version = 1
notifications = "auto"

[kit_aliases]
node = "docker.io/acme/node-kit:1.2.0"
```

You can create aliases from the CLI:

```console
sbx-pi config alias node docker.io/acme/node-kit:1.2.0
sbx-pi config alias node docker.io/acme/node-kit:1.3.0 --replace
sbx-pi init --kit @node
sbx-pi --kit @node
```

Aliases do not inject default kits. `init` expands them into concrete references
for sharing. Alias writes preserve settings but reformat TOML and remove comments.
See [configuration details](docs/configuration.md) for path and write behavior.

Desktop notifications are enabled automatically when host `notify-send` is
available (`libnotify-bin` or `libnotify` on most distributions). A notification
arrives when an agent job has fully settled, including retries and queued work.
Failures never interrupt Pi.

Disable them for a launch with:

```console
SBX_PI_NOTIFICATIONS=off sbx-pi
```

Or set `notifications = "off"` in personal or project TOML. Precedence is the
environment variable, project config, personal config, then `auto`. Values are
`auto`, `on` (require `notify-send`), or `off`.

### Inspect configuration

```console
sbx-pi config show
sbx-pi status
```

Both emit JSON and accept kit/configuration options. `config show` resolves
configuration without Docker; `status` lists sandboxes and reports `not-created`,
`unknown`, `current`, or `drifted`. Neither creates or changes a sandbox.
Reference comparison cannot detect edits inside local kits or changes behind
mutable remote references; recreate explicitly when those change.

Copyable TOML examples are in [`examples/config/`](examples/config/).

## Optional shell completion

Add to your interactive `~/.bashrc` (Bash 4+):

```bash
eval "$(sbx-pi completion bash)"
```

Or to `~/.zshrc`, **after** your framework or `compinit` initializes completion:

```zsh
eval "$(sbx-pi completion zsh)"
```

Without a framework, initialize Zsh completion with `autoload -Uz compinit` and
`compinit` first. Restart your shell. Use your installed command name if you
customized it. Completion suggests launcher flags, aliases, and paths; it stops
at Pi arguments. It makes no Docker or network calls and writes no state.

To disable it, remove the line and restart. Never put completion scripts in
`/etc/sandbox-persistent.sh`.

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
