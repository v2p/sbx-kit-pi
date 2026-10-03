# Configuration details

See the [README](../README.md) for everyday commands and manifest examples.
Configuration is host-side only: it does not modify Pi settings or Docker
Sandbox's allowed sources, network policies, or credentials. Unknown TOML keys,
unsupported schema versions, and invalid values fail before invoking Docker.

## Aliases

`sbx-pi config alias NAME KIT [--replace]` writes the personal configuration at
`$XDG_CONFIG_HOME/sbx-pi/config.toml` (default `~/.config/sbx-pi/config.toml`).
Names contain letters, digits, underscores, or hyphens, without the `@` prefix.
An existing name requires `--replace`. Aliases cannot reference other aliases.

CLI local paths are resolved from the current directory and stored as absolute
paths. Relative alias paths beginning with `.` in hand-written TOML are resolved
against the personal configuration directory. No default kits are injected.
Prefer concrete pinned references in shared manifests; `@aliases` depend on
each user's personal configuration.

Alias writes are atomic, use private permissions, refuse symlinked configuration
files, and use a lock to prevent concurrent writes. TOML is reserialized, so
comments and custom formatting are not retained. The command does not invoke
Docker Sandbox or modify project manifests.

`init` expands aliases. Project-local paths are stored relative to the manifest;
paths outside the project are rejected. Remote references are preserved as
supplied. It never creates session/state directories or persists personal
notification settings.

## Applied state

After a successful creating run, state is stored under
`$XDG_STATE_HOME/sbx-pi/sandboxes/` (default
`~/.local/state/sbx-pi/sandboxes/`). The launcher compares workspace, resolved kit
references, and the base kit specification.

`status` reports:

- `not-created`: the workspace sandbox does not exist.
- `unknown`: it exists but has no recorded launcher state.
- `current`: recorded state matches the effective configuration.
- `drifted`: recorded state differs.

Attaching never applies configuration changes automatically. `--recreate`
replaces the sandbox using the effective configuration, not the recorded mixin
list. With no CLI overrides, it uses the discovered manifest's kits, or none
when no manifest exists.

Comparison cannot detect changed contents inside local kits or behind mutable
Git/registry references. Pin versions and recreate explicitly when local kits
change. This layer does not implement image pulling, release checking, profiles,
or bulk sandbox updates.

## Custom command name

```console
make install PREFIX="$HOME/.local" COMMAND=pi-sandbox
```

The launcher resolves its symlink back to this checkout, while using the current
project as workspace. Run `make uninstall` with the same overrides to remove it.
