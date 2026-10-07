import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { METHODS, callHost, enqueue } from "../scripts/host-rpc-protocol.mts";
import type { MethodCall } from "../scripts/host-rpc-protocol.mts";

function clean(value: string | undefined, fallback: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value?.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return (cleaned || fallback).slice(0, max);
}

function observedPath(cwd: string, input: string): string {
  const path = input.startsWith("@") ? input.slice(1) : input;
  return resolve(
    cwd,
    path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path,
  );
}

function endpoint(ctx: ExtensionContext) {
  const file = ctx.sessionManager.getSessionFile();
  return file ? { dir: dirname(file), session: basename(file) } : undefined;
}

async function send(ctx: ExtensionContext, ...call: MethodCall) {
  const target = endpoint(ctx);
  if (!target) {
    return;
  }
  try {
    await enqueue(target.dir, target.session, ...call);
  } catch (error) {
    // Telemetry must never block an actual tool or completion.
    console.error(`[host-rpc] ${error instanceof Error ? error.message : String(error)}`);
  }
}

export default function (pi: ExtensionAPI) {
  let jobActive = false;
  pi.on("agent_start", () => {
    jobActive = true;
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (!jobActive || !ctx.isIdle()) {
      return;
    }
    jobActive = false;
    const sandbox = clean(process.env.SANDBOX_NAME, "Pi sandbox");
    const project = clean(basename(process.env.WORKSPACE_DIR || ctx.cwd), "project");
    const sessionName = clean(pi.getSessionName(), "");
    await send(ctx, METHODS.NOTIFICATION_SEND, {
      title: clean(`Pi finished · ${project}`, "Pi finished"),
      body: clean(sessionName ? `${sessionName} · ${sandbox}` : sandbox, sandbox, 320),
    });
  });

  pi.registerTool({
    name: "host_network_request",
    label: "Request host network review",
    description:
      "Record a blocked domain and reason for the Docker Host owner to review. Does NOT grant access or modify Docker policy. Use a concrete domain, not a URL or wildcard; do not include secrets in the reason.",
    parameters: Type.Object({
      host: Type.String({
        maxLength: 253,
        description: "Concrete domain, e.g. registry.npmjs.org",
      }),
      reason: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const target = endpoint(ctx);
      if (!target) {
        throw new Error("Host RPC requires a persisted session and an active host launcher");
      }
      const result = await callHost(
        target.dir,
        target.session,
        METHODS.NETWORK_REQUEST,
        {
          host: params.host.toLowerCase(),
          reason: params.reason,
        },
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: `Network request ${result.id} recorded for host review. Access has not been granted.`,
          },
        ],
        details: result,
      };
    },
  });

  // Observations, not enforcement: shell reads, external processes, and earlier
  // blocking handlers may not be observable. Never send file contents/errors.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "read" && typeof event.input.path === "string") {
      await send(ctx, METHODS.FILE_ACCESS, {
        path: observedPath(ctx.cwd, event.input.path),
        toolCallId: event.toolCallId,
        phase: "attempt",
      });
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "read" && typeof event.input.path === "string") {
      await send(ctx, METHODS.FILE_ACCESS, {
        path: observedPath(ctx.cwd, event.input.path),
        toolCallId: event.toolCallId,
        phase: event.isError ? "error" : "success",
      });
    }
  });
}
