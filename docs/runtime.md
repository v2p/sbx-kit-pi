# Runtime behavior

## Token usage

After every LLM turn, Pi prints a compact interactive usage line:

```text
tokens · prompt 38,247 (new 2,100, cached 36,147) · output 1,402 (reasoning 920) · total 39,649
```

Prompt usage distinguishes new tokens from cache reads and, when reported,
cache writes. Reasoning is a subset of output. These lines complement the
cumulative token/context totals in Pi's footer and are not included in model
context or persisted sessions.

## Desktop notifications

The bundled `host-rpc.ts` extension queues a `notification.send` JSON-RPC call
in the mounted session directory. `scripts/run` starts a host listener that
validates and dispatches explicitly allowed methods, then writes a correlated
response. The notification handler calls host `notify-send` without a shell.
No network port is opened, and queues exist only while the listener is active.

The same bridge records network review requests and observed Pi read attempts.
See [Host RPC](host-rpc.md) for the wire format, host allowlist, review commands,
limits, and important telemetry/security limitations.

The title contains the project name; the body contains the sandbox name and,
when set with `/name`, the Pi session name. Runtime context supplies project,
sandbox, and session directory information without private Pi arguments.

## Docker Sandbox instruction preprocessing

The image bundles extensions under `/opt/sbx-kit-pi/extensions/` and loads them
at startup. The instruction processor handles Docker Sandbox-generated ancestor
`AGENTS.md` files during `session_start`. When the source hash changes, it starts
an isolated Pi subprocess to classify every source line:

- **Always:** required sandbox reasoning or prevention of high-impact/recurrent mistakes.
- **On demand:** operational guidance moved verbatim, by line range, to an Agent Skill.
- **Drop:** generic guidance or repository-discoverable facts.

The child has context files, skills, normal extensions, and built-in tools
disabled; it can only submit a structured classification. Missing, overlapping,
out-of-range, or invalid classifications are rejected before anything is written.

Generated skills live in the project session directory's `skills/` folder and
are exposed during startup through `resources_discover`. Original/processed
SHA-256 hashes, the private source backup, and validated classification live at:

```text
<AGENTS-directory>/.sbx-kit-pi/agents/<AGENTS-path-hash>/
```

When the file matches the processed hash, no model call is made; missing skills
are regenerated from cache. Changed source is classified again. Authentication,
model, or validation failures are reported and leave the current file unchanged.

To pick up extension changes, rebuild the image and recreate the sandbox.
Repeating OAuth login is unnecessary unless Pi reports missing authentication.

## Persistence and credential import

The launcher mounts a workspace-specific host session directory and passes it
to Pi with `--session-dir`:

```text
~/pi-sessions-backup/<project-name>-<workspace-path-hash>/
```

The workspace-path hash avoids collisions and is also part of the sandbox name:
`pi-openai-codex-<project>-<workspace-path-hash>`. Other Pi state stays in the
sandbox under `~/.pi/agent/`. Additional mounts are fixed at sandbox creation;
recreate an existing sandbox to change them.

For Codex import, the launcher stages a private copy of the host auth file.
The container extracts only access token, refresh token, expiration, and account
ID into Pi's auth file. The entrypoint and host launcher remove the staged copy.
Pi refreshes its own credential afterward, without updating Codex CLI's file.

Docker Sandbox OAuth bindings can restore host-stored credentials after
recreation. A Codex-imported credential is sandbox-local after import; seed it
again with `--recreate --import-codex-auth` if needed.
