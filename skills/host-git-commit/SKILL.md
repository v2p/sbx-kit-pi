---
name: host-git-commit
description: "Use when the user asks to commit changes in a Docker Sandbox, especially with the host's Git identity or signing. Review and stage intended changes, then request a host commit through the host_git_commit RPC tool."
compatibility: "Requires Git in the sandbox, the sbx-kit-pi host_git_commit tool, a persisted Pi session, and an active host launcher with git.commit permission. The reference handler requires a Linux desktop with Git, Python, PyGObject and GTK 4."
---

# Host Git commit

Use `host_git_commit` for a user-requested commit in the launcher's host
workspace. The reference handler opens a desktop review and uses the host's
normal Git identity and signing configuration. This skill supplies instructions,
not the RPC implementation or permission to commit.

## Check readiness and scope

- Commit only when the user requests it. A request to edit or test is not a
  request to commit. Do not amend, push, or change signing configuration as part
  of this workflow.
- Confirm that `host_git_commit` is available. If it is missing or permission is
  denied, explain the host setup below; do not write queue requests manually or
  fall back to a sandbox-local commit to bypass approval.
- Inspect `git status --short --branch`, the working diff and staged diff before
  staging. Preserve unrelated edits and existing staged changes. If unrelated
  changes are already staged, ask how to handle them; the RPC commits the entire
  staged tree, not a list of files. Never reset or unstage the user's work
  silently. Do not stage secrets.
- The host workspace must be the trusted repository root on a named branch,
  without a merge, rebase, cherry-pick or revert in progress. Do not alter Git
  configuration or repository state merely to get past a rejected request.
- Direct workspace mode shares the host's working tree and Git state. In clone
  mode (`/run/sandbox/source` exists), the sandbox has a separate index. This RPC
  does not transfer files, stage host changes or synchronize clones. Stop if the
  intended host snapshot cannot be verified; ask the user to prepare it on the
  host rather than attempting writes to the read-only source mount.

## Prepare and request the snapshot

1. Run the appropriate checks for the intended changes and report any failures.
2. Stage only the approved files or hunks, using explicit paths, for example
   `git add -- path/to/file`. Avoid blanket staging of unrelated changes.
3. Review `git diff --cached --stat` and `git diff --cached`, along with
   `git status --short`. Verify the complete staged snapshot matches the user's
   intent. If there are no staged changes, report that there is nothing to commit.
4. Obtain the full snapshot IDs immediately before requesting the commit:

   ```bash
   git rev-parse --verify HEAD
   git write-tree
   ```

   Set `expectedHead` to the full HEAD object ID. Use the literal `unborn` only
   after confirming this is an initial commit on an unborn branch; a failed Git
   command is not by itself evidence of an unborn repository. Set `expectedTree`
   to the full staged tree object ID. If either command fails for another reason,
   stop and diagnose it instead of guessing IDs. The host must match both IDs.
5. Call the **tool** `host_git_commit` once with:

   - `message`: a meaningful commit message (at most 2,000 characters).
   - `expectedHead`: the verified full HEAD ID, or `unborn`.
   - `expectedTree`: the full ID returned by `git write-tree`.

   These are tool arguments, not a shell command. Do not include repository
   paths, Git flags, credentials or signing secrets. The tool does not stage,
   amend, push or run Git hooks.
6. Wait for desktop approval and signing (up to about three minutes). Avoid
   concurrent Git operations while the request is pending. The user must review
   the diff, check the approval box and click Commit. If signing is enabled,
   host GPG may open its own pinentry. **Never request, read or transmit a signing
   passphrase through the agent, tool arguments or RPC queue.** An unlocked key
   is not approval, and signing is not forced when disabled in host Git config.

## Handle the result

- On reported success, inspect host HEAD/log and index, where accessible, before
  claiming a verified commit hash. In direct mode, use `git log -1 --format=fuller`,
  `git rev-parse HEAD^{tree}` and `git status --short`; check the new commit's
  message, parent and tree against the requested snapshot. In clone mode, local
  HEAD is not proof of host state. If host state cannot be inspected, say the
  host reported success rather than claiming independent verification.
- Respect declined approval. Do not submit another request unless the user asks.
- After an error, cancellation or timeout, the outcome may be unknown. Cancelling
  the tool's wait does not retract an enqueued request or close the host dialog.
  Inspect host HEAD/log and index before considering another request; if that is
  not possible, ask the user to inspect them. **Never automatically retry.**
- A snapshot mismatch requires checking the host repository, branch, HEAD and
  staged tree, not resubmitting stale IDs or synchronizing user data silently.

## Host setup when unavailable

Ask the user to perform setup on the trusted Linux host, not inside the sandbox:

1. Install Git, Python, PyGObject and GTK 4. On Debian/Ubuntu:

   ```bash
   sudo apt install git python3 python3-gi gir1.2-gtk-4.0
   ```

2. Add `git.commit` to the existing `[host_rpc].allow` array in host-owned
   `${XDG_CONFIG_HOME:-$HOME/.config}/sbx-pi/global.toml`, preserving other permissions
   the user wants. Project configuration cannot grant this capability. For a
   one-launch opt-in, `SBX_PI_HOST_RPC_ALLOW=git.commit sbx-pi` replaces the entire
   allowlist and disables the other reporting methods for that launch.
3. From the trusted host repository root in a desktop terminal, run
   `sbx-pi test-rpc git-commit`. This tests the reference handler's review,
   identity and configured signing without changing HEAD or the real index.
   It does not test the live sandbox transport.
4. Launch or relaunch `sbx-pi` from that desktop session after policy or handler
   changes. Host Python must have the system GTK bindings available in isolated
   mode, and normal host signing/pinentry must work independently.

Pi loads bundled extensions from `/opt/sbx-kit-pi/`; editing a checkout does not
register a missing tool in the running agent. If the installed image lacks the
RPC tool, deploy an updated image and recreate the sandbox. Warn that recreation
deletes sandbox-local data and have the user preserve it first; do not recreate
a sandbox merely to install this instruction-only skill. Only enable host commit
handling for trusted repositories and Git configuration.
