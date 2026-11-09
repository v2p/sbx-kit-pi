import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { allowedMethods } from "./host-rpc-listener.mts";
import {
  COMMIT_REQUIREMENTS,
  commitAvailable,
  createHandlers,
  defaultCommand,
} from "./host-rpc-handlers.mts";
import type { HandlerCommands } from "./host-rpc-handlers.mts";

export async function testGitCommit(
  allow: string,
  commands: HandlerCommands,
  cwd: string,
): Promise<void> {
  if (!allowedMethods(allow, true).has("git.commit")) {
    throw new Error(
      'git.commit is not allowed. Add "git.commit" to host-owned global.toml [host_rpc].allow, or set SBX_PI_HOST_RPC_ALLOW=git.commit for this test.',
    );
  }
  const reference = defaultCommand("git.commit");
  const chain = commands["git.commit"];
  if (
    chain.length !== 1 ||
    chain[0].length !== reference.length ||
    !chain[0].every((arg, i) => arg === reference[i])
  ) {
    throw new Error(
      "Cannot safely dry-run a custom git.commit handler; the reference handler is required.",
    );
  }
  if (!commitAvailable(chain)) {
    throw new Error(COMMIT_REQUIREMENTS);
  }
  console.log("Testing host git.commit permission, desktop approval and Git identity/signing.");
  console.log(
    "Host-only dry run: no live listener or sandbox queue is exercised; no repository commit will be made.",
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) {
    process.on(signal, abort);
  }
  try {
    const handlers = createHandlers(
      { ...commands, "git.commit": [[...reference, "--dry-run"]] },
      {
        cwd,
        workspace: await realpath(process.cwd()),
        sandbox: "host-dry-run",
        signal: controller.signal,
        // This is host-local output, never exposed through a sandbox reply.
        diagnostics: (text) => process.stderr.write(text),
      },
    );
    const result = await handlers["git.commit"]({
      jsonrpc: "2.0",
      sbxVersion: 1,
      id: randomUUID(),
      session: "host-dry-run",
      method: "git.commit",
      // The host-only dry-run flag selects the snapshot locally. These valid
      // envelope fields are ignored; no request is enqueued or logged as a commit.
      params: {
        message: "Host readiness test",
        expectedHead: "unborn",
        expectedTree: "0".repeat(40),
      },
    });
    if (result.status !== "performed") {
      throw new Error("Host Git dry run declined or expired; readiness was not confirmed.");
    }
    console.log("Host Git dry run passed. No repository commit was created.");
  } finally {
    for (const signal of signals) {
      process.off(signal, abort);
    }
  }
}
