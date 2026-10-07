# Sandbox-to-host RPC

The host launcher starts a small allowlisted listener, replacing the old
notification-specific queue. It uses the existing mounted session directory;
it needs neither a network port nor access to the host Docker socket.

## Host policy and handlers

Host-owned `~/.config/sbx-pi/global.toml` (honoring `XDG_CONFIG_HOME`) can set
persistent permissions:

```toml
[host_rpc]
allow = ["notification.send", "network.request", "file.access"]
```

The host environment variable `SBX_PI_HOST_RPC_ALLOW` overrides that list for
one launch with an exact, comma-separated list of built-in methods. With neither
setting, all three methods below are permitted. `off`, an empty environment
value, or an empty TOML array disables the bridge completely. Unknown names fail
startup. Project TOML rejects `host_rpc`; workspace files and sandbox-supplied
records cannot set this policy. Keep global configuration outside sandbox-writable
mounts. Changing policy requires relaunching, not recreation.

| Method | Parameters | Host behavior |
| --- | --- | --- |
| `notification.send` | `title`, `body` | Run `notify-send` with fixed arguments, no shell. |
| `network.request` | `host`, `reason` | Record a concrete domain for manual review; never fetch it or grant access. |
| `file.access` | `path`, `toolCallId`, `phase` | Record an observed read attempt/result; never open the supplied path. |

`notification.send` also requires host `notify-send` to be available; if missing,
the method is unavailable without failing startup. Omit `notification.send` from
the allowlist to disable only notifications, keeping network/file logging.
For notifications only:

```console
SBX_PI_HOST_RPC_ALLOW=notification.send sbx-pi
```

The Pi extension exposes `host_network_request` for a domain such as
`registry.npmjs.org` and a reason. It waits up to five seconds for a correlated
response. "Recorded" means the request was logged, **not approved**. It does not
automatically infer denials from shell output, scrape Docker logs, or retry a
timed-out call. Errors/timeouts never imply approval. Completion and file
telemetry enqueue without waiting and cannot block the agent through a failed
handler; listener startup failures stop the launch with an error.

## Wire format (v1)

Both files are private regular files in the session directory:

- `.host-rpc.requests.jsonl`: sandbox producers append; host consumes.
- `.host-rpc.responses.jsonl`: host appends correlated results/errors.

Each record is one UTF-8 JSON object followed by a newline. For example:

```json
{"jsonrpc":"2.0","sbxVersion":1,"id":"request-123","session":"session.jsonl","method":"network.request","params":{"host":"registry.npmjs.org","reason":"Install locked dependencies"}}
```

Responses use JSON-RPC 2.0:

```jsonl
{"jsonrpc":"2.0","id":"request-123","result":{"status":"recorded"}}
{"jsonrpc":"2.0","id":"request-456","error":{"code":-32001,"message":"Method not allowed by host"}}
```

`sbxVersion: 1` versions the kit-specific request contract. `id` is a unique
1–80-character identifier (`A–Z`, `a–z`, digits, `_`, `-`); the bundled client uses
UUIDs. `session` is an untrusted label, not a host filesystem path. Batches,
requests without IDs, and extra request/parameter fields are unsupported.

Strings must be nonempty and contain no ASCII controls. Limits: session label
256 characters; method 80; title 160; body 320; reason 1,000; path 2,048;
tool-call ID 256. Domains are lowercase DNS names (maximum 253 characters), not
URLs, IP addresses, wildcard rules, single-label hosts, or host/port pairs.
File paths are absolute sandbox paths; phases are `attempt`, `success`, `error`.
The extension expands relative paths and `~/` lexically, without resolving
symlinks or reading files to verify the observation.

Standard errors are `-32700` (parse/oversized record), `-32600` (invalid envelope),
`-32601` (unknown method), `-32602` (invalid parameters), `-32603` (handler failed).
Kit errors are `-32001` (disallowed), `-32002` (duplicate ID), `-32003` (limit).
Malformed envelopes receive `id: null`. Partial records are buffered until a
newline; oversized records are discarded through their next newline.

## Host review log

The listener writes accepted requests and outcomes, plus rejection metadata, to:

```text
${XDG_STATE_HOME:-~/.local/state}/sbx-pi/host-rpc/<full-workspace-path-hash>.jsonl
```

The directory is private, outside the session mount by default. Each record has
host receipt time and host-selected sandbox/workspace labels. A parameterized
native sandbox name is recorded as empty when the launcher cannot resolve it.
Accepted calls have an entry with `status: "accepted"` and `request`; outcomes
have `response`. Rejected/invalid raw payloads are not retained.

List requested domains (use your configured state directory if different):

```console
jq -s '[.[] | select(.request.method == "network.request") | .request.params | {host, reason}] | unique' ~/.local/state/sbx-pi/host-rpc/*.jsonl
```

Count observed read attempts by path:

```console
jq -s '[.[] | select(.request.method == "file.access" and .request.params.phase == "attempt") | .request.params.path] | group_by(.) | map({path: .[0], attempts: length})' ~/.local/state/sbx-pi/host-rpc/*.jsonl
```

Review Docker's authoritative network evidence using `sbx policy log` on the
host. For pending Docker approvals, inspect/respond with `sbx policy approval`
commands. A recorded kit request is separate from a Docker approval. Do not
blindly add an allow rule: explicit denies and organization policy may apply.
For permanent sandbox-scoped permissions, update project `[network].allow` and
recreate as described in [Configuration](configuration.md#supplemental-network-permissions).
There is intentionally no automatic approval handler or policy modification.

## Lifecycle, limits, and trust boundary

- One listener per session directory. A private host-side `<log-file>.lock`
  (containing the listener PID) prevents concurrent launches even if sandbox
  code unlinks the shared queues. Exclusive queue creation also refuses stale
  files and symlinks without truncating another listener's files. Normal
  shutdown drains complete queued calls, then removes endpoints and the lock.
  After a crash, remove stale queue files and the corresponding host lock
  **on the host only after confirming no launcher is active**. Queues are
  ephemeral, not a durable job system.
- No retries or replay after restart. Duplicate IDs are rejected during one
  listener lifetime. A timeout/crash can leave the outcome unknown; this is not
  exactly-once delivery. Host logs survive normal shutdown.
- Records are capped at 4 KiB, queues at 8 MiB, and processing at 10,000 records
  per launch. Notifications use a host-monotonic token bucket per listener:
  a burst of three, refilling one slot every ten seconds (up to three). All
  callers/session labels share it; failed handler attempts consume slots too.
  Excess notification calls receive `-32003` immediately and are not deferred or
  retried automatically. Slots refill during idle time, so there is no separate
  lifetime notification cap. Other handlers are unaffected. The notification
  handler still has a two-second timeout. Each workspace log is capped at
  16 MiB: archive/remove it on the host before relaunching when full. Resource exhaustion stops the listener
  with a visible error, not a policy change. The sandbox can still fill its
  writable volume; these limits are not disk quotas.
- Host queue/log descriptors stay open, so replacing a file with a symlink
  cannot redirect host writes. The host never uses request fields to select
  commands, handlers, logs, reply paths, or Docker policy operations.
- Any process that can write the mounted queue can forge requests or session
  labels. The sandbox can also alter responses; client acknowledgments are not
  authenticated. Treat records as **untrusted reports**, not proof of identity,
  permission violations, or successful access. IDs correlate calls, not callers.
- Read telemetry observes Pi's `read` tool hooks, including nested calls when
  hooks reach this extension. It does not see shell reads, direct filesystem
  access, external processes, earlier blocking handlers, or disabled/tampered
  extensions. Other handlers may modify inputs afterward. A tool error does
  not distinguish denial from a missing file. No file contents or error bodies
  are logged. Use OS/Docker-level auditing for reliable malicious-access
  detection; this bridge is not an enforcement boundary.
- Paths and request reasons may themselves contain sensitive information. Keep
  host state and listener code outside sandbox-writable mounts, and manage log
  retention on the host. Never put secrets in network request reasons.

To add a method, extend the known-method registry, strict parameter validation,
and an explicit host handler, with tests proving that untrusted input cannot
select arbitrary host capabilities. Do not add a generic shell/command RPC.

The image bundles the client protocol and `host-rpc.ts`; rebuild/publish the
0.5.0 image and recreate sandboxes to migrate from the old notification extension.
Existing sessions and OAuth bindings remain intact.
