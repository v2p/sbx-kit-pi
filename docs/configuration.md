# Configuration details

See the [README](../README.md) for examples. Sandbox settings belong in
`sbxenv.yaml`; `sbx-pi.toml` supplies only Pi launcher preferences and capabilities
missing from Docker's environment schema. Configuration never writes Pi settings
or changes Docker's global allowed sources or network policy.

## Native environments

Discovery stops at the nearest ancestor containing either configuration file;
both files in that directory are loaded. `--env PATH` selects native YAML files
in merge order, or a directory's `sbxenv.yaml`. Pi TOML is loaded beside the first
file. `--config PATH` selects TOML and its sibling YAML.
`--env` and `--config` are mutually exclusive.

Every launch uses native YAML. If discovery finds no configuration, launch creates
`sbxenv.yaml` in the current directory. If only Pi TOML exists, launch creates YAML
beside it. Explicit `--env` files must already exist. Generated files select
`workspace: .`, the Pi agent, and an empty mixin list unless `--kit` is supplied.
Read-only `config show`, `status`, and `plan` never create project files; planning
requires existing YAML.

The first YAML file's directory is the project configuration directory, used for
session persistence and the default sandbox name. It need not be the mounted
workspace: Docker owns `workspace`, clone mode, additional mounts, and their
path resolution. Existing YAML names are honored, including expressions resolved
by Docker. Parameterized agent selection is not supported: this launcher requires
the checkout directory's name (`sbx-kit-pi` by default), or an omitted agent,
which it supplies. The private layer includes this checkout as the v3 workload;
all additional kits must be v3 mixins. Environment files remain schema v1.

The launcher appends a stable private YAML layer under
`$XDG_STATE_HOME/sbx-pi/sandboxes/` (default `~/.local/state/sbx-pi/sandboxes/`).
This supplies the installed checkout's Pi kit and session mount, plus default
agent and name values only when missing. Omitting `workspace` keeps native
mountless behavior. Native lists concatenate; user YAML is not copied or flattened.
Only explicit `--kit`/`--no-kits` options rewrite the project's kit list; other
settings and comments are preserved. Do not repeat the launcher's
Pi kit or its session mount in your project YAML.

Native files should remain outside writable workspace trees, following Docker's
[environment-file guidance](https://docs.docker.com/ai/sandboxes/configuration/environment-files/).
The private adapter is always outside the mounted project. Because the launcher
passes explicit file paths, Docker's implicit `~/.sbxenv.yaml` defaults are not
loaded; this matches native explicit-path behavior. Use ordered `--env` layers
for shared settings.

`--env-arg` and `--env-args-file` are forwarded to every native operation. Docker
owns argument expansion, deep merging, validation, resource reconciliation, and
approval. The launcher never supplies `--force` for planning or provisioning.
`sbx-pi plan` uses `sbx env plan`; `--recreate` removes resources with
`sbx env rm --force`, then runs the current environment. Forced removal is requested only by `--recreate`.

Launch uses `sbx env run --detach`, followed by `sbx env exec` with the kit's
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
`--recreate`. These references become a generated schema-v3 network-policy
mixin, granting the listed hosts during both installation and runtime, scoped
to the sandbox rather than global policy. Docker still enforces
deny rules and organization governance. Removing a host requires recreation;
removing the list does not remove the base kit's OAuth hosts or permissions from
other kits. The launcher warns when recorded Pi-kit/network settings differ.

Only project TOML can declare supplemental network permissions; personal config
cannot silently inject them. Unknown TOML settings, invalid values,
and unsupported TOML versions fail before Docker is invoked.

## Host RPC permissions and handlers

Global `global.toml` accepts `[host_rpc]` with an optional `allow` array of built-in
method names and a `[host_rpc.handlers]` table of per-method command chains. An
empty array disables the bridge. `SBX_PI_HOST_RPC_ALLOW` is a host-only,
comma-separated per-launch override; `off` or an empty value disables
the bridge. With neither setting, the three reporting methods are permitted;
`git.commit` is disabled and requires explicit host opt-in.
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
disable telemetry. The reference `git.commit` handler requires host `git`,
`python3`, PyGObject and GTK 4 for per-commit desktop approval with a colored,
read-only, selectable diff. Missing these dependencies while the reference commit
handler is enabled fails launcher startup; they are not needed with `git.commit`
disabled. Commit handlers require exactly one command, not a chain of actions.
The reference handler honors host Git signing configuration; GPG can use graphical
pinentry after approval. Only enable it for trusted repositories/configuration.

Run `sbx-pi test-rpc git-commit` from a trusted repository root in a host desktop
terminal to test permission, review and configured signing without creating a
repository commit. It loads only global host RPC configuration, not project TOML
or environment YAML; it does not start Docker/Pi or contact the live queue.
`SBX_PI_HOST_RPC_ALLOW` still overrides the global allowlist for this command.
See [Host Git commits](host-rpc.md#host-git-commits) before enabling it.

Handler/policy changes require relaunching, not recreation. Bundled Pi extension
or protocol changes require an updated image and sandbox recreation; save
sandbox-local data first.
See [Host RPC](host-rpc.md#attaching-consumer-handlers) for the command contract,
path resolution, limits, and examples, and the rest of that document for log
retention, protocol details, and auditing limitations.

## Aliases and saved kit selections

`sbx-pi config alias NAME KIT [--replace]` writes personal configuration at
`$XDG_CONFIG_HOME/sbx-pi/global.toml` (default `~/.config/sbx-pi/global.toml`).
Names contain letters, digits, underscores, or hyphens, without `@`. Existing
names require `--replace`; aliases cannot reference aliases. CLI local paths are
stored as absolute paths; relative alias paths in hand-written TOML resolve from
the personal configuration directory. No default kits are injected.

Writes are atomic, private, locked against concurrent writes, and refuse symlinked
personal files. TOML comments and formatting are not retained. Alias commands do
not invoke Docker or modify project files.

On launch, repeated `--kit KIT` options replace the saved YAML `kits` list;
`--no-kits` saves an empty list. Omitting both leaves existing selections untouched.
CLI paths resolve from the invocation directory and are saved relative to the
configuration directory. Aliases expand into concrete references; external local
paths are rejected for portability. Remote references are preserved. YAML itself
does not interpret aliases. TOML does not accept a `kits` setting.

With a single explicit `--env`, that file receives the edit. With multiple layers,
CLI kit edits are rejected rather than guessing which list to replace; edit YAML
manually. Updates refuse symlinks and non-regular files, use a writer lock and
atomic replacement, and retain file permissions and unrelated YAML settings.
Invalid references or launcher settings fail before writing; Docker validates
native sandbox settings during planning and provisioning.

If CLI kit selections change and the sandbox already exists, the new list is
saved but launch stops with a recreation instruction. Parameterized names also
require explicit `--recreate` when CLI kit selections change, since the launcher
cannot safely check existence. `--recreate --kit ...` saves and applies together.
Recreation always requires that explicit flag and deletes sandbox-local changes.
Manually edited YAML is reconciled by Docker; inspect `sbx-pi plan` before applying.

The generated file expects `sbx-pi` to add its Pi kit; to use `sbx env` directly,
include this checkout as a kit and configure session persistence yourself.

## Custom command name

```console
make install PREFIX="$HOME/.local" COMMAND=pi-sandbox
```

The launcher resolves its symlink to this checkout while discovering configuration
from the current project. Uninstall with the same overrides.
