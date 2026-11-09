# Sandbox-to-host RPC

The host launcher consumes an allowlisted JSON-RPC queue in the mounted session
directory. No network port or host Docker socket is needed.

## Overview and defaults

| Method | Parameters | Reference behavior |
| --- | --- | --- |
| `notification.send` | `title`, `body` | Run `notify-send` with fixed arguments, no shell. |
| `network.request` | `host`, `reason` | Record a domain for manual review. |
| `file.access` | `path`, `toolCallId`, `phase` | Record an observed Pi read attempt/result. |
| `git.commit` | `message`, `expectedHead`, `expectedTree` | Review and commit a staged snapshot on the host; **opt-in**. |

The three reporting methods are allowed by default; `git.commit` is not. Set
persistent permissions in host-owned `~/.config/sbx-pi/global.toml` (honoring
`XDG_CONFIG_HOME`):

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

Host policy and handler changes require **relaunching**, not image rebuilds or
sandbox recreation. The launcher runs listener/handler code from its own kit
directory, while Pi loads the bundled extension and protocol from
`/opt/sbx-kit-pi/` inside the sandbox. Editing the checkout does not update those
bundled files or register tools in a running Pi instance. For bundled
extension/protocol changes, deploy the updated image and recreate the sandbox
in the normal image-based workflow; relaunching against an old image is not
enough. Preserve sandbox-local data first: recreation deletes it.

## Host Git commits

On a Linux desktop, install host `git`, `python3`, PyGObject and GTK 4. On
Debian/Ubuntu:

```console
sudo apt install git python3 python3-gi gir1.2-gtk-4.0
```

`python3` on the host PATH must have those system bindings available; the review
helper runs in Python isolated mode, without user/workspace import paths. Ensure
normal host Git signing works with your graphical GPG pinentry. Start `sbx-pi`
from your desktop session so its listener inherits the display/session environment.
Enable the capability in **host-owned global TOML**:

```toml
[host_rpc]
allow = ["notification.send", "network.request", "file.access", "git.commit"]
```

Or enable just committing for one launch:

```console
SBX_PI_HOST_RPC_ALLOW=git.commit sbx-pi
```

The override replaces the entire allowlist, so this disables reporting methods
for that launch. Relaunch after changing permissions. With the reference commit
handler enabled, missing Git/Python/GTK dependencies fail launcher startup rather
than silently disabling committing. They are not required when `git.commit` is
disabled. See the [README review screenshot](../README.md#host-git-commits).

### Test host readiness without committing

From the trusted repository root in a host desktop terminal, run:

```console
sbx-pi test-rpc git-commit
```

This checks the same global permission (including `SBX_PI_HOST_RPC_ALLOW`), host
Git/Python/GTK availability, repository state, desktop approval and Git identity.
It uses the current working directory, not environment-file workspace discovery;
project TOML/YAML and launcher configuration-selection options are not used.
To opt in for this test alone, use
`SBX_PI_HOST_RPC_ALLOW=git.commit sbx-pi test-rpc git-commit`.
The dialog is explicitly labeled **dry run** with a **Test** button. On approval,
it creates a disposable commit object in a private temporary object directory,
using the repository's configured signer when `commit.gpgSign` is enabled, then
deletes it. HEAD, branches, repository objects, the real index and working files
are left unchanged. No staged changes are required, and unborn repositories work.
If signing is disabled, output explicitly says signing/pinentry was **not tested**;
an unlocked signing key may need no pinentry dialog even when signing succeeds.
GTK warnings are shown as bounded diagnostic excerpts without aborting an
otherwise successful review. Subprocess failures identify the program and include
a bounded stderr excerpt; large diagnostics retain both the beginning and end.

Cancellation, expiry and errors exit nonzero. The command never starts Docker or
Pi, creates environment YAML, submits a real commit request, or touches a live
listener's queues. It tests the reference host handler, **not sandbox-to-host
transport or the running launcher's environment**. Run it from the same desktop
session used to launch `sbx-pi`. Custom commit handlers are rejected because their
dry-run behavior cannot be guaranteed. The same trusted-repository/configuration
requirement applies; temporary objects are removed on normal completion/failure,
while a hard kill can leave `sbx-pi-commit-*` directories in the host temp directory.
GPG may unlock/cache the host key as a side effect of a successful signing test.

### Request a commit from Pi

Pi's `host_git_commit` tool takes a commit message, the full current HEAD object
ID (`git rev-parse HEAD`, or `unborn` for the initial commit), and the full staged
tree object ID (`git write-tree`). Stage only intended changes first. The host
must have the same HEAD and staged tree; a clone's separate index is not synced
by this RPC. The host workspace must be the repository root on a named branch,
with no merge/rebase/cherry-pick/revert in progress. For example, ask Pi to stage
only the files you intend to commit and request a host commit. It obtains the
snapshot IDs inside the sandbox before calling the tool:

```console
git rev-parse HEAD
git write-tree
```

For an initial commit, use `unborn` instead of the missing HEAD ID. Unstaged and
untracked changes are not included. The tool accepts only the message and snapshot
IDs, not a repository path, Git options or signing credentials.

The reference handler:

1. Verifies the requested snapshot against the host and builds a private index.
2. Opens a **native GTK review** containing the repository, branch, commit message
   and full staged diff. Text is monospace, read-only and selectable/copyable
   (Ctrl+C); additions are green, deletions red and hunk headers blue. Repository
   text is inserted literally, never interpreted as markup or links. You must
   check the approval box and click Commit. Cancel, Escape, closing the dialog or
   its two-minute expiry returns `declined`.
3. Rechecks HEAD, branch and the original index, then runs host `git commit` with
   the private index. Only the reviewed staged tree is committed. It never stages
   files, amends, pushes, or rewrites the user's index/working tree.

Git uses the repository's normal host identity and signing configuration. If
`commit.gpgSign` is enabled, GPG uses your existing host agent and desktop
pinentry; an already-unlocked key may need no prompt. **Never send a passphrase
through Pi, tool arguments or the queue.** The approval dialog is separate from
GPG key unlocking; an unlocked key is not approval. Signing is not forced if your
Git configuration disables it.

Git hooks and filesystem-monitor commands are disabled. A private, empty
worktree avoids invoking clean filters on sandbox files. This is **not a safe
Git service for malicious repositories**: Git metadata/configuration (including
signing programs and config includes), executables and the host installation must
be trusted. Only enable this for trusted repositories; sandbox-writable Git
metadata is not a host authorization boundary. Custom handlers can replace this
review behavior and run with host-user privileges.

Avoid concurrent Git operations while review/signing is pending. The private
snapshot prevents later staging from changing the committed tree, and Git's ref
transaction detects ref changes during signing, but review is not a lock on the
repository. A crash/timeout can leave the outcome unknown: inspect host Git state
before explicitly requesting another commit. Do not retry automatically. Pi tool
cancellation stops waiting; it does not retract an already-enqueued request or
close the host dialog. Launcher shutdown terminates running handlers and ordinary
descendants; the separately running GPG agent/pinentry may remain open. A hard
kill may leave private `sbx-pi-commit-*` temporary directories under the host temp
directory, but the reference handler does not hold the user's index lock.

Commit handling has a three-minute total deadline and a 185-second client wait.
The queue is sequential: an active review/signing operation delays other reports
and may cause short-wait network calls to time out. Diffs exceeding 1 MiB fail
closed rather than showing an incomplete review. Commit messages/snapshot IDs,
but not diffs or passphrases, appear in the host audit log.

`npm test` also exercises the real GTK widgets headlessly when Python/GTK plus
`xvfb` and `xauth` are installed. These tests cover selection/copy, read-only
literal text, diff coloring, approval gating, cancellation and expiry; otherwise
that GUI test is explicitly skipped.

### Troubleshooting host commits

- **Tool missing:** the bundled Pi extension registers `host_git_commit`; checkout
  edits alone do not update a running sandbox. Deploy the updated image and
  recreate it after preserving sandbox-local data. Do not write requests to the
  queue manually to bypass a missing tool or host permission.
- **Method disallowed:** check the host global `allow` array and
  `SBX_PI_HOST_RPC_ALLOW`, then relaunch. Project configuration cannot enable it.
- **Bindings unavailable:** `python3` on the launcher's PATH must import system
  PyGObject/GTK 4 in isolated mode. A virtual environment's Python may not see
  distribution packages. Check on the host with
  `python3 -I /path/to/sbx-kit-pi/scripts/host-rpc-handlers/git-review.py --check`.
- **Display or signing fails:** run the readiness command from the same desktop
  session as the launcher. Check normal host Git signing/pinentry independently.
  A passing dry run does not verify sandbox transport or a running listener.
- **Snapshot mismatch:** verify the host repository root, branch, HEAD and staged
  tree. Clone mode does not synchronize the sandbox's index; this tool does not
  transfer or stage changes. Avoid concurrent staging while review is open.
- **Uncertain outcome:** inspect host HEAD/log and index before another request.
  Cancelling Pi's wait does not close the host review or revoke an enqueued call.

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
  include `["default"]` to retain it. `git.commit` requires exactly one command
  to prevent executing multiple commit handlers for one request.
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
`{"status":"recorded"}`, `{"status":"performed"}`, or `{"status":"declined"}`.
Send diagnostics to stderr. A `declined` result stops the chain; otherwise the
chain result is `performed` if any handler reports it, or `recorded`.

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
  error/timeout grants access. `git.commit` is an explicitly enabled action with
  a separate reference-handler desktop approval, not a reporting permission.
  Reference network/file handlers only acknowledge
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
be nonempty and contain no ASCII controls, except line feeds in commit messages.
Commit HEAD/tree IDs are full lowercase 40- or 64-character object IDs; HEAD may
also be `unborn` for an initial commit. Commit requests cannot specify repository
paths, flags, signing secrets, staging, amend or push options.

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
| Commands per reporting method / entire chain execution | 8 / 2 seconds |
| Commit handlers / entire execution | 1 / 180 seconds |
| Commit message / staged diff review | 2,000 characters / 1 MiB |
| Each command's stdout / stderr | 4 KiB each |
| Reference Git handler's internal subprocess stdout / stderr | 1 MiB each |
| Notifications | Burst of 3; refill 1 slot every 10 seconds, up to 3 |
| Client response wait | 5 seconds; 185 seconds for commits |

Notification slots use host-monotonic time, shared by all callers/session labels.
Failed handler attempts consume slots; excess calls are rejected immediately,
not deferred. Idle time replenishes slots; there is no lifetime notification cap.
Other methods are unaffected.

The network and commit tools wait for a reply; completion/file telemetry only
enqueue and do not block Pi on handler failures. Listener startup failures stop launch.
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
