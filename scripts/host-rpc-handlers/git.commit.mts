import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { COMMIT_TIMEOUT_MS } from "../host-rpc-protocol.mts";
import { GIT_REVIEW_COMMAND } from "../host-rpc-handlers.mts";
import type { HandlerResult } from "../host-rpc-protocol.mts";
import { hasErrorCode } from "../runtime-validation.mts";
import { main } from "./main.mts";
import type { HandlerInput } from "./main.mts";

const MAX_REVIEW_BYTES = 1024 * 1024;

// Keep the beginning and end of desktop diagnostics without overflowing the
// outer handler's 4 KiB stderr budget. Byte limits also cover non-ASCII output.
function diagnostics(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) {
    return text;
  }
  const half = Math.floor(limit / 2);
  return `${bytes.subarray(0, half).toString("utf8")}\n[diagnostics truncated]\n${bytes.subarray(-half).toString("utf8")}`;
}

function exited(error: unknown, code: number): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Plain text only: never interpret repository/message text as markup or commands.
function reviewText(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export async function handle({ request, context }: HandlerInput): Promise<HandlerResult> {
  if (request.method !== "git.commit") {
    throw new Error("Expected git.commit request");
  }
  return commit(context.workspace, request.params);
}

// Host-local diagnostic only; dry-run mode is never accepted from RPC parameters.
export async function testCommit(workspace: string): Promise<HandlerResult> {
  return commit(workspace);
}

async function commit(
  directory: string,
  params?: { message: string; expectedHead: string; expectedTree: string },
): Promise<HandlerResult> {
  const dryRun = params === undefined;
  const message = params?.message ?? "sbx-pi host Git commit readiness test (disposable)";
  const workspace = await realpath(directory);
  const env = { ...process.env };
  // The host-selected workspace, not inherited repository selectors, chooses Git state.
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  const run = (command: string, args: string[], input?: string, timeout = COMMIT_TIMEOUT_MS) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        command,
        args,
        { env, timeout, maxBuffer: MAX_REVIEW_BYTES },
        (error, stdout, stderr) => {
          if (error) {
            // Preserve exit codes for cancellation/unborn checks, but expose the
            // failing program and actual stderr instead of only a buffer error.
            error.message = diagnostics(
              `${command}: ${error.message.split("\n")[0]}\n${stderr}`,
              2048,
            );
            reject(error);
          } else {
            if (dryRun && command === GIT_REVIEW_COMMAND[0] && stderr) {
              console.error(diagnostics(`GTK review diagnostics:\n${stderr}`, 1024));
            }
            resolve(stdout);
          }
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  const gitArgs = [
    "--no-pager",
    "--literal-pathspecs",
    "-C",
    workspace,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.editor=false",
    "-c",
    "commit.status=false",
    "-c",
    "commit.verbose=false",
  ];
  const git = async (...args: string[]) => (await run("git", [...gitArgs, ...args])).trim();
  if ((await realpath(await git("rev-parse", "--show-toplevel"))) !== workspace) {
    throw new Error("Host workspace must be the Git working-tree root");
  }
  const gitDir = await git("rev-parse", "--absolute-git-dir");
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ]) {
    try {
      await stat(join(gitDir, name));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    throw new Error("Finish the host merge/rebase/sequencer operation first");
  }
  // Refuse detached HEAD: the reviewed branch must be explicit.
  const branch = await git("symbolic-ref", "--quiet", "HEAD");
  const head = async () => {
    try {
      return await git("rev-parse", "--verify", "--quiet", "HEAD");
    } catch (error) {
      if (exited(error, 1)) {
        return "unborn";
      }
      throw error;
    }
  };
  const index = await git("rev-parse", "--path-format=absolute", "--git-path", "index");
  // Never rewrite or lock the user's index across human interaction. The commit
  // uses a private index; concurrent staging cannot change the approved snapshot.
  let temporary: string | undefined;
  try {
    const expectedHead = params?.expectedHead ?? (await head());
    if ((await head()) !== expectedHead) {
      throw new Error("Host HEAD does not match the request");
    }
    const originalIndex = await readFile(index).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT") && expectedHead === "unborn") {
        return undefined;
      }
      throw error;
    });
    temporary = await mkdtemp(join(tmpdir(), "sbx-pi-commit-"));
    env.GIT_INDEX_FILE = join(temporary, "index");
    env.GIT_WORK_TREE = join(temporary, "worktree");
    await mkdir(env.GIT_WORK_TREE);
    if (originalIndex) {
      await writeFile(env.GIT_INDEX_FILE, originalIndex, { mode: 0o600 });
    }
    if (dryRun) {
      // All diagnostic objects, including the disposable signed commit, stay outside
      // the repository. Existing objects remain readable through the alternate.
      const objects = await git("rev-parse", "--path-format=absolute", "--git-path", "objects");
      env.GIT_OBJECT_DIRECTORY = join(temporary, "objects");
      // Git's quoted alternate syntax also handles ':' and quotes in host paths.
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = JSON.stringify(objects);
      await mkdir(env.GIT_OBJECT_DIRECTORY);
    }
    const tree = await git("write-tree");
    if (params && tree !== params.expectedTree) {
      throw new Error("Host staged tree does not match the request");
    }
    // Rebuild the private index from the immutable tree. Never stage working-tree files.
    await git("read-tree", tree);
    const diff = await git(
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--no-color",
      "--no-renames",
      "--",
    );
    if (!diff && !dryRun) {
      throw new Error("No staged changes to commit");
    }
    let signing = false;
    if (dryRun) {
      try {
        signing = (await git("config", "--bool", "--get", "commit.gpgSign")) === "true";
      } catch (error) {
        if (!exited(error, 1)) {
          throw error;
        }
      }
    }
    const summary = reviewText(
      [
        dryRun ? "HOST GIT COMMIT DRY RUN — NO REPOSITORY COMMIT" : "HOST GIT COMMIT REVIEW",
        ...(dryRun
          ? [
              "This host-only readiness test does not exercise the sandbox queue.",
              "HEAD, branches, the real index and working files will not be changed.",
              "A disposable commit object will be created outside the repository, then deleted.",
              signing
                ? "Signing is enabled: the configured host signer will be exercised."
                : "WARNING: commit.gpgSign is disabled; signing/pinentry will NOT be tested.",
              "",
            ]
          : []),
        `Repository: ${workspace}`,
        `Branch: ${branch}`,
        `HEAD: ${expectedHead}`,
        `Staged tree: ${tree}`,
        "",
        "This uses this repository's Git identity/signing configuration with host-user privileges.",
        "Only approve repositories whose Git configuration you trust. Git hooks are disabled.",
        "A separate GPG desktop dialog may ask for your passphrase. Never enter it in Pi.",
      ].join("\n"),
    );
    try {
      // Fixed host helper/flags; untrusted text travels only as JSON on stdin.
      const [python, ...args] = GIT_REVIEW_COMMAND;
      await run(
        python,
        args,
        JSON.stringify({
          summary,
          message: reviewText(message),
          diff: reviewText(diff || "(No staged changes; the dry run uses the current tree.)"),
          dryRun,
        }),
        125000,
      );
    } catch (error) {
      if (exited(error, 1) || exited(error, 5)) {
        return { status: "declined" };
      }
      throw error;
    }
    const currentIndex = await readFile(index).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (
      (await head()) !== expectedHead ||
      (await git("symbolic-ref", "--quiet", "HEAD")) !== branch ||
      (originalIndex ? !currentIndex?.equals(originalIndex) : currentIndex !== undefined)
    ) {
      throw new Error("Host Git state changed during review; refusing commit");
    }
    // A private, empty worktree avoids invoking clean filters on sandbox-controlled files.
    if (dryRun) {
      // commit-tree uses normal identity/signing configuration but never updates a ref.
      // Unlike git commit, it requires an explicit -S when commit.gpgSign is enabled.
      await git("var", "GIT_AUTHOR_IDENT");
      await git("var", "GIT_COMMITTER_IDENT");
      await run(
        "git",
        [
          ...gitArgs,
          "commit-tree",
          tree,
          ...(expectedHead === "unborn" ? [] : ["-p", expectedHead]),
          ...(signing ? ["-S"] : []),
          "-F",
          "-",
        ],
        message,
      );
      console.error(
        signing
          ? "Host Git identity and signing succeeded (a cached key may need no pinentry dialog)."
          : "Host Git identity succeeded; signing/pinentry NOT tested because commit.gpgSign is disabled.",
      );
    } else {
      // Normal Git commit performs signing and its own expected-HEAD ref transaction.
      await run("git", [...gitArgs, "commit", "--cleanup=verbatim", "--file=-"], message);
    }
    return { status: "performed" };
  } finally {
    if (temporary) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

await main(import.meta.url, async (input) => {
  // This flag comes only from the host command line, never from a queue request.
  return process.argv[2] === "--dry-run" ? testCommit(input.context.workspace) : handle(input);
});
