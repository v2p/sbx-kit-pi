# Configuration details

See the [README](../README.md) for examples. Sandbox settings belong in
`sbxenv.yaml`; `sbx-pi.toml` supplies only Pi launcher preferences and capabilities
missing from Docker's environment schema. Configuration never writes Pi settings
or changes Docker's global allowed sources or network policy.

## Native environments

Discovery stops at the nearest ancestor containing either configuration file;
both files in that directory are loaded. `--env PATH` selects native YAML files
in merge order, or a directory's `sbxenv.yaml`. Pi TOML is loaded beside the first
file. `--config PATH` selects TOML and its sibling YAML. `--no-config` disables
project discovery. Explicit paths and `--no-config` are mutually exclusive;
`--env` and `--config` are also mutually exclusive.

The first YAML file's directory is the project configuration directory, used for
session persistence and the default sandbox name. It need not be the mounted
workspace: Docker owns `workspace`, clone mode, additional mounts, and their
path resolution. Existing YAML names are honored, including expressions resolved
by Docker. Parameterized agent selection is not supported: this launcher requires
`pi-openai-codex` (or an omitted agent, which it supplies).

The launcher appends a stable private YAML layer under
`$XDG_STATE_HOME/sbx-pi/sandboxes/` (default `~/.local/state/sbx-pi/sandboxes/`).
This supplies the installed checkout's Pi kit and session mount, plus default
agent and name values only when missing. Omitting `workspace` keeps native
mountless behavior; `init` explicitly selects `workspace: .`. Native lists concatenate;
user YAML is never copied, flattened, or rewritten. Do not repeat the launcher's
Pi kit or its session mount in your project YAML.

Native files should remain outside writable workspace trees, following Docker's
[environment-file guidance](https://docs.docker.com/ai/sandboxes/configuration/environment-files/).
The private adapter is always outside the mounted project. Because the launcher
passes explicit file paths, Docker's implicit `~/.sbxenv.yaml` defaults are not
loaded; this matches native explicit-path behavior. Use ordered `--env` layers
for shared settings.

`--env-arg` and `--env-args-file` are forwarded to every native operation. Docker
owns argument expansion, deep merging, validation, resource reconciliation, and
approval. The launcher never supplies `--auto-approve`. `sbx-pi plan` uses
`sbx env plan`; `--recreate` removes resources with `sbx env rm --force`, then
runs the current environment. Forced removal is requested only by `--recreate`.

Launch uses `sbx env run --detached`, followed by `sbx env exec` with the kit's
entrypoint and Pi arguments, since native `env run` has no agent argument
passthrough. An interactive terminal is allocated when stdin/stdout are terminals.
Verify this flow on the host's experimental `sbx` release, including OAuth login
and session environment values.

`status` lists sandboxes and reports `not-created` or `exists` for literal names,
and `unknown` for names requiring Docker argument expansion. It does not claim
native configuration is current: inspect `plan`. Workspace, kit, port, credential,
and resource changes take effect on recreation. Local kit contents and mutable
references may change without a detectable plan difference.

## Supplemental network permissions

Project TOML accepts:

```toml
schema_version = 1

[network]
allow = ["api.github.com", "registry.npmjs.org"]
```

`--allow-host HOST` replaces the TOML list for that launch; repeat for several
hosts. With an existing literal-name sandbox, explicit overrides require
`--recreate`. These references become a generated schema-v2 permission-only
mixin, scoped to the sandbox rather than global policy. Docker still enforces
deny rules and organization governance. Removing a host requires recreation;
removing the list does not remove the base kit's OAuth hosts or permissions from
other kits. The launcher warns when recorded Pi-kit/network settings differ.

Only project TOML can declare supplemental network permissions; personal config
cannot silently inject them. Unknown TOML settings, invalid values, conflicting
YAML/TOML kits, and unsupported TOML versions fail before Docker is invoked.

## Host RPC permissions and handlers

Global `global.toml` accepts `[host_rpc]` with an optional `allow` array of built-in
method names and a `[host_rpc.handlers]` table of per-method command chains. An empty array disables the bridge. `SBX_PI_HOST_RPC_ALLOW` is a
host-only comma-separated per-launch override; `off` or an empty value disables
the bridge. With neither setting, all three built-in methods are permitted.
Project TOML rejects `host_rpc` and cannot grant host RPC capabilities.
Keep global configuration and handler code outside sandbox-writable mounts.
Each method defaults to its standalone reference script. Custom chains replace
that method's default; include `["default"]` to retain the reference behavior:

```toml
[host_rpc.handlers]
"network.request" = [["default"], ["python3", "/home/me/rpc/review.py"]]
```

Handlers receive validated calls as JSON on stdin and return a status as JSON on
stdout. Handler configuration does not grant method permissions. Notifications
require `notification.send` in the allowlist; chains using its reference handler
also require host `notify-send` availability. Omitting that method does not
disable telemetry. Handler/policy changes require relaunching, not recreation.
See [Host RPC](host-rpc.md#attaching-consumer-handlers) for the command contract,
path resolution, limits, and examples, and the rest of that document for log
retention, protocol details, and auditing limitations.

## Aliases and initialization

`sbx-pi config alias NAME KIT [--replace]` writes personal configuration at
`$XDG_CONFIG_HOME/sbx-pi/global.toml` (default `~/.config/sbx-pi/global.toml`).
Names contain letters, digits, underscores, or hyphens, without `@`. Existing
names require `--replace`; aliases cannot reference aliases. CLI local paths are
stored as absolute paths; relative alias paths in hand-written TOML resolve from
the personal configuration directory. No default kits are injected.

Writes are atomic, private, locked against concurrent writes, and refuse symlinked
personal files. TOML comments and formatting are not retained. Alias commands do
not invoke Docker or modify project files.

`init` exclusively creates `sbxenv.yaml` in the current directory. It expands
aliases into concrete references, stores project-local paths relatively, rejects
external local kit paths, and preserves remote references. It never copies parent
settings, creates sessions/state directories, or writes personal preferences.
The generated file expects `sbx-pi` to add its Pi kit; to use `sbx env` directly,
include this checkout as a kit and configure session persistence yourself.

## Legacy compatibility

Without YAML, existing TOML kits and CLI `--kit`/`--no-kits` retain their original
behavior. Move kits to YAML and remove TOML `kits` before combining both files.
There are no new TOML fields for mounts, ports, variables, resources, secrets,
or lifecycle commands; use native YAML instead.

Legacy applied state records workspace, resolved kit references, the Pi kit
specification, and supplemental network permissions. Its status values remain
`not-created`, `unknown`, `current`, and `drifted`. Attaching does not apply
creation-time changes; `--recreate` uses effective configuration, not recorded
kits. Reference comparison cannot detect changes inside local kits or mutable
Git/registry references.

## Custom command name

```console
make install PREFIX="$HOME/.local" COMMAND=pi-sandbox
```

The launcher resolves its symlink to this checkout while discovering configuration
from the current project. Uninstall with the same overrides.
