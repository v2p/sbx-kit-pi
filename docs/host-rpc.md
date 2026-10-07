# Sandbox-to-host RPC

The host launcher consumes an allowlisted JSON-RPC queue in the mounted session
directory. No network port or host Docker socket is needed.

## Overview and defaults

| Method | Parameters | Reference behavior |
| --- | --- | --- |
| `notification.send` | `title`, `body` | Run `notify-send` with fixed arguments, no shell. |
| `network.request` | `host`, `reason` | Record a domain for manual review. |
| `file.access` | `path`, `toolCallId`, `phase` | Record an observed Pi read attempt/result. |

All three methods are allowed by default. Set persistent permissions in host-owned
`~/.config/sbx-pi/global.toml` (honoring `XDG_CONFIG_HOME`):

```toml
[host_rpc]
allow = ["notification.send", "network.request", "file.access"]
```

An empty `allow` array disables the bridge. The host environment variable
`SBX_PI_HOST_RPC_ALLOW` overrides permissions for one launch, not handlers:

```console
SBX_PI_HOST_RPC_ALLOW=notification.send sbx-pi
SBX_PI_HOST_RPC_ALLOW=off sbx-pi
```

The override accepts an exact comma-separated list; `off` or an empty value
disables the bridge. Unknown methods fail startup. Project TOML rejects
`host_rpc` and cannot grant host capabilities.

Notification chains containing the reference handler require host `notify-send`;
if missing, that method is unavailable without failing startup. Custom-only
notification chains do not require it. Omit `notification.send` from `allow` to
disable notifications while keeping network/file reports.

Policy and handler changes require **relaunching**, not image rebuilds or sandbox
recreation.

## Attaching consumer handlers

Consumers attach handlers to the existing listener, not a second queue reader.
Each method defaults to a standalone script under `scripts/host-rpc-handlers/`.
Configure ordered command chains in global TOML:

```toml
[host_rpc.handlers]
# Extend the reference behavior.
"network.request" = [["default"], ["python3", "/home/me/rpc/review.py"]]
# Replace the reference behavior.
"notification.send" = [["node", "./handlers/notify.mjs"]]
```

- An omitted method uses its reference handler. An explicit chain replaces it;
  include `["default"]` to retain it.
- Chains are nonempty lists of command/argument arrays. Disable methods through
  `allow`, not empty chains; configuring a handler does not grant permission.
- Commands run without a shell. Executables containing `/` resolve relative to
  the global TOML directory; bare names use the host `PATH`. That directory is
  also the working directory for relative arguments (the host home when no
  global file exists). Prefer absolute paths for interpreters/scripts.
- `sbx-pi config show` exposes `hostRpcHandlers` and `hostRpcHandlerCwd` without
  executing handlers.

The listener validates calls, checks permissions, deduplicates IDs, applies rate
limits, and writes the accepted audit entry **before** invoking any handler. A
failed audit write prevents execution. Each command receives one JSON line on
stdin, shaped as follows:

```json
{
  "request": {
    "jsonrpc": "2.0",
    "sbxVersion": 1,
    "id": "request-123",
    "session": "session.jsonl",
    "method": "network.request",
    "params": {"host": "registry.npmjs.org", "reason": "Install locked dependencies"}
  },
  "context": {"sandbox": "host-selected-name", "workspace": "/host/project"}
}
```

`request` is the validated but untrusted report; `context` contains host-selected
labels. Exit successfully and write exactly one JSON object on stdout:
`{"status":"recorded"}` or `{"status":"performed"}`. Send diagnostics to stderr.
The chain result is `performed` if any handler reports it, otherwise `recorded`.

For example, `/home/me/rpc/review.py` could forward reports to a private log:

```python
#!/usr/bin/env python3
import json
import sys

data = json.load(sys.stdin)
with open("/home/me/.local/state/rpc-reports.jsonl", "a") as log:
    log.write(json.dumps(data) + "\n")
print(json.dumps({"status": "recorded"}))
```

## Inspect reports

The listener logs accepted requests, outcomes, and rejection metadata to:

```text
${XDG_STATE_HOME:-~/.local/state}/sbx-pi/host-rpc/<full-workspace-path-hash>.jsonl
```

This private directory is outside the session mount by default. Entries include
host receipt time and host-selected sandbox/workspace labels; unresolved native
sandbox names appear as empty. Accepted entries contain `status: "accepted"` and
`request`; outcomes contain `response`. Invalid/rejected raw payloads are omitted.
Audit logging remains active even when all reference handlers are replaced.

List requested domains or count observed read attempts (adjust for your state
directory if needed):

```console
jq -s '[.[] | select(.request.method == "network.request") | .request.params | {host, reason}] | unique' ~/.local/state/sbx-pi/host-rpc/*.jsonl
jq -s '[.[] | select(.request.method == "file.access" and .request.params.phase == "attempt") | .request.params.path] | group_by(.) | map({path: .[0], attempts: length})' ~/.local/state/sbx-pi/host-rpc/*.jsonl
```

Kit reports are separate from Docker approvals. Review authoritative network
evidence with `sbx policy log` and pending approvals with `sbx policy approval`
on the host. For permanent sandbox-scoped permissions, update project
`[network].allow` and recreate as described in
[Configuration](configuration.md#supplemental-network-permissions); Docker deny
rules and organization policy still apply.

## Safety and delivery guarantees

- **Reports are not authorization.** Neither `recorded`, `performed`, nor an
  error/timeout grants access. Reference network/file handlers only acknowledge
  the listener's log entry: they never fetch domains, open reported paths, or
  change policy. The `host_network_request` tool submits explicit domains/reasons;
  it does not infer denials from shell output or scrape Docker logs.
- **Handlers have host-user privileges.** Keep configuration, handler code,
  interpreters, working directories, listener code, and host state outside
  sandbox-writable mounts. Never evaluate report strings as shell code, blindly
  open reported paths, or automatically approve domains. Paths/reasons may be
  sensitive: manage log retention and never put secrets in request reasons.
- **Reports and replies are unauthenticated.** Any queue writer can forge calls
  or session labels; the sandbox can alter replies. IDs correlate calls, not
  callers. Records are not proof of identity, violations, or successful access.
- **Delivery is ephemeral, not exactly-once.** Duplicate IDs are rejected for one
  listener lifetime. There is no replay or automatic retry after restart; a
  timeout/crash leaves the outcome unknown. Handlers must not retry automatically.
  Host logs survive normal shutdown.
- **Chains run sequentially and stop on failure.** Nonzero exits, timeouts,
  oversized output, or invalid results return generic `-32603` errors without
  exposing host diagnostics. Earlier side effects are not rolled back. POSIX
  cleanup kills the handler process group, including ordinary descendants;
  do not spawn detached work that escapes it.
- **Telemetry is not enforcement.** Pi read hooks observe attempts/results,
  including nested calls when hooks reach the extension. They miss shell/direct
  filesystem reads, external processes, earlier blocking handlers, and disabled
  or tampered extensions. Later handlers can modify inputs; tool errors do not
  distinguish denial from missing files. No file contents or error bodies are
  logged. Use OS/Docker auditing for reliable malicious-access detection.

## Protocol reference

### Wire format (v1)

Private regular files in the session directory carry UTF-8 JSON objects, one per
line:

- `.host-rpc.requests.jsonl`: producers append the `request` object shown above.
- `.host-rpc.responses.jsonl`: the host appends correlated JSON-RPC 2.0 replies:

```jsonl
{"jsonrpc":"2.0","id":"request-123","result":{"status":"recorded"}}
{"jsonrpc":"2.0","id":"request-456","error":{"code":-32001,"message":"Method not allowed by host"}}
```

`sbxVersion: 1` versions the kit contract. IDs use `A–Z`, `a–z`, digits, `_`, or
`-`; the bundled client uses UUIDs. `session` is a label, not a host path. Batches,
missing IDs, and extra envelope/parameter fields are unsupported. Strings must
be nonempty and contain no ASCII controls.

Domains must be lowercase DNS names, not URLs, IP addresses, wildcards,
single-label hosts, or host/port pairs. File paths are absolute sandbox paths;
`phase` is `attempt`, `success`, or `error`. The extension expands relative paths
and `~/` lexically without resolving symlinks or verifying access.

Partial records wait for a newline; oversized records are discarded through the
next newline. Malformed envelopes receive `id: null`.

| Error | Meaning |
| --- | --- |
| `-32700` | Invalid JSON or oversized record |
| `-32600` | Invalid envelope |
| `-32601` | Unknown method |
| `-32602` | Invalid parameters |
| `-32603` | Handler failed |
| `-32001` | Method disallowed |
| `-32002` | Duplicate ID |
| `-32003` | Rate or request limit reached |

### Limits

| Resource | Limit |
| --- | --- |
| ID | 1–80 characters |
| Session / method | 256 / 80 characters |
| Notification title / body | 160 / 320 characters |
| Domain / reason | 253 / 1,000 characters |
| File path / tool-call ID | 2,048 / 256 characters |
| Record / each queue | 4 KiB / 8 MiB |
| Requests per launch / workspace log | 10,000 / 16 MiB |
| Commands per method / entire chain execution | 8 / 2 seconds |
| Each command's stdout / stderr | 4 KiB each |
| Notifications | Burst of 3; refill 1 slot every 10 seconds, up to 3 |
| Client response wait | 5 seconds |

Notification slots use host-monotonic time, shared by all callers/session labels.
Failed handler attempts consume slots; excess calls are rejected immediately,
not deferred. Idle time replenishes slots; there is no lifetime notification cap.
Other methods are unaffected.

The network tool waits for a reply; completion/file telemetry only enqueue and
do not block Pi on handler failures. Listener startup failures stop launch.
Resource exhaustion stops the listener visibly, not by changing policy. These
limits are not disk quotas; the sandbox can still fill its writable volume.
Archive/remove a full host log before relaunching.

### Lifecycle and crash recovery

One listener owns each session directory. A private host-side `<log-file>.lock`
contains its PID and prevents competing launches even if sandbox code unlinks
the queues. Exclusive creation refuses stale files/symlinks without truncating
another listener's endpoints. Queue/log descriptors stay pinned, so file
replacement cannot redirect host writes. Validated method names select only
host-configured chains; other report fields never select commands, logs, reply
paths, or Docker operations in the listener/reference handlers.

Normal shutdown drains complete calls and removes endpoints and the lock. After
a crash, remove stale queue files and the corresponding host lock **on the host,
only after confirming no launcher is active**.

To add a method, extend the registry, strict parameter validation, and explicit
host handler, with tests for the trust boundary. Do not add a generic
shell/command RPC.
