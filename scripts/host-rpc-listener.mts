import { constants } from "node:fs";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  METHODS,
  REQUEST_FILE,
  RESPONSE_FILE,
  MAX_QUEUE_BYTES,
  Records,
  validRequest,
  validHostRequest,
  isMethod,
} from "./host-rpc-protocol.mts";
import type { HostHandlers, HostRequest, Method, Response } from "./host-rpc-protocol.mts";
import { createHandlers, notificationAvailable } from "./host-rpc-handlers.mts";
import type { ResolvedConfig } from "./launcher-types.mts";
import { errorMessage } from "./runtime-validation.mts";

export type AuditEntry =
  | { request: HostRequest; status: "accepted" }
  | { id?: string; method?: string; session?: string; response: Response };
export interface DispatcherOptions {
  allowed: ReadonlySet<Method>;
  handlers: HostHandlers;
  record: (entry: AuditEntry) => Promise<void>;
  now?: () => number;
}
export interface ListenerOptions extends Pick<DispatcherOptions, "allowed" | "handlers"> {
  sessionDir: string;
  logFile: string;
  sandbox: string;
  workspace: string;
  readyFile: string;
  shouldStop: () => boolean;
}

const METHOD_NAMES = Object.values(METHODS);
const MAX_CALLS = 10000;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const NOTIFICATION_BURST = 3;
const NOTIFICATION_REFILL_MS = 10000;

function failure(id: string | null, code: number, message: string): Response {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function allowedMethods(
  value: string | undefined,
  notificationAvailable: boolean,
): Set<Method> {
  const names =
    value === undefined ? METHOD_NAMES : value === "off" || value === "" ? [] : value.split(",");
  if (!names.every(isMethod)) {
    throw new Error("SBX_PI_HOST_RPC_ALLOW contains an unknown method");
  }
  return new Set(
    names.filter((name) => name !== METHODS.NOTIFICATION_SEND || notificationAvailable),
  );
}

function invokeHandler<M extends Method>(
  handlers: HostHandlers,
  method: M,
  request: HostRequest<M>,
) {
  return handlers[method](request);
}

export async function createDispatcher({
  allowed,
  handlers,
  record,
  now = () => performance.now(),
}: DispatcherOptions): Promise<(line: string | null) => Promise<Response>> {
  const seen = new Set<string>();
  let notificationTokens = NOTIFICATION_BURST;
  let notificationUpdatedAt = now();
  const takeNotificationToken = () => {
    // Use host monotonic time, never timestamps or session labels from callers.
    const time = Math.max(notificationUpdatedAt, now());
    const tokens = Math.min(
      NOTIFICATION_BURST,
      notificationTokens + (time - notificationUpdatedAt) / NOTIFICATION_REFILL_MS,
    );
    if (tokens < 1) {
      return false;
    }
    notificationTokens = tokens - 1;
    notificationUpdatedAt = time;
    return true;
  };
  return async (line) => {
    let request: unknown;
    try {
      request = JSON.parse(line ?? "");
    } catch {
      const response = failure(null, -32700, "Invalid JSON or oversized record");
      await record({ response });
      return response;
    }
    if (!validRequest(request)) {
      const response = failure(null, -32600, "Invalid request");
      await record({ response });
      return response;
    }
    const { id, method } = request;
    let response: Response;
    if (seen.has(id)) {
      response = failure(id, -32002, "Duplicate request ID");
    } else if (seen.size >= MAX_CALLS) {
      response = failure(id, -32003, "Request limit reached");
    } else {
      seen.add(id);
      if (!isMethod(method)) {
        response = failure(id, -32601, "Unknown method");
      } else if (!allowed.has(method)) {
        response = failure(id, -32001, "Method not allowed by host");
      } else if (!validHostRequest(request)) {
        response = failure(id, -32602, "Invalid parameters");
      } else if (method === METHODS.NOTIFICATION_SEND && !takeNotificationToken()) {
        response = failure(id, -32003, "Notification rate limit reached");
      } else {
        // Record before any host side effect; a failed/full log fails closed.
        await record({ request, status: "accepted" });
        try {
          const result = await invokeHandler(handlers, request.method, request);
          response = { jsonrpc: "2.0", id, result };
        } catch {
          response = failure(id, -32603, "Host handler failed");
        }
      }
    }
    // Invalid/rejected payloads are never retained verbatim.
    await record({ id, method, session: request.session, response });
    return response;
  };
}

export async function listen({
  sessionDir,
  logFile,
  sandbox,
  workspace,
  allowed,
  readyFile,
  shouldStop,
  handlers,
}: ListenerOptions): Promise<void> {
  const paths = [join(sessionDir, REQUEST_FILE), join(sessionDir, RESPONSE_FILE)];
  const handles: FileHandle[] = [];
  let log: FileHandle | undefined;
  let lock: FileHandle | undefined;
  try {
    // The host-side lock is outside the session mount: unlinking shared queue
    // files cannot allow another listener to take over an active bridge.
    await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
    lock = await open(
      `${logFile}.lock`,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await lock.writeFile(`${process.pid}\n`);
    // O_EXCL prevents competing listeners and refuses stale files/symlinks.
    // Keep descriptors pinned: sandbox replacement cannot redirect host writes.
    for (const file of paths) {
      handles.push(
        await open(
          file,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_RDWR |
            constants.O_APPEND |
            constants.O_NOFOLLOW,
          0o600,
        ),
      );
    }
    log = await open(
      logFile,
      constants.O_CREAT |
        constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    if (!(await log.stat()).isFile()) {
      throw new Error("Host RPC log must be a regular file");
    }
    let logBytes = (await log.stat()).size;
    if (logBytes >= MAX_LOG_BYTES) {
      throw new Error("Host RPC log is full; archive it on the host before relaunching");
    }
    const auditLog = log;
    const record = async (data: AuditEntry) => {
      const line =
        JSON.stringify({ receivedAt: new Date().toISOString(), sandbox, workspace, ...data }) +
        "\n";
      logBytes += Buffer.byteLength(line);
      if (logBytes > MAX_LOG_BYTES) {
        throw new Error("Host RPC log is full; archive it on the host before relaunching");
      }
      await auditLog.writeFile(line);
    };
    const dispatch = await createDispatcher({ allowed, record, handlers });
    const decoder = new Records();
    const buffer = Buffer.alloc(16384);
    let position = 0;
    let responseBytes = 0;
    let count = 0;
    await writeFile(readyFile, "ready\n", { flag: "wx", mode: 0o600 });
    const drain = async () => {
      // Snapshot EOF so a flooding producer cannot prevent shutdown.
      const size = (await handles[0].stat()).size;
      if (size < position || size > MAX_QUEUE_BYTES) {
        throw new Error("Host RPC queue truncated or full");
      }
      while (position < size) {
        const { bytesRead } = await handles[0].read(
          buffer,
          0,
          Math.min(buffer.length, size - position),
          position,
        );
        if (!bytesRead) {
          throw new Error("Host RPC queue changed while reading");
        }
        position += bytesRead;
        for (const line of decoder.feed(buffer.subarray(0, bytesRead))) {
          if (++count > MAX_CALLS) {
            throw new Error("Host RPC request limit reached");
          }
          const response = JSON.stringify(await dispatch(line)) + "\n";
          responseBytes += Buffer.byteLength(response);
          if (responseBytes > MAX_QUEUE_BYTES) {
            throw new Error("Host RPC response queue full");
          }
          await handles[1].writeFile(response);
        }
      }
    };
    while (!shouldStop()) {
      await drain();
      await delay(100);
    }
    await drain();
  } finally {
    await log?.close();
    for (let index = 0; index < handles.length; index++) {
      await handles[index].close();
      await unlink(paths[index]).catch(() => {});
    }
    if (lock) {
      await lock.close();
      await unlink(`${logFile}.lock`).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      stopping = true;
    });
  }
  const [sessionDir, logFile, sandbox, workspace, readyFile, configFile] = process.argv.slice(2);
  try {
    if (
      !sessionDir ||
      !logFile ||
      sandbox === undefined ||
      !workspace ||
      !readyFile ||
      !configFile
    ) {
      throw new Error(
        "Usage: host-rpc-listener.mts SESSION_DIR LOG_FILE SANDBOX WORKSPACE READY_FILE CONFIG_FILE",
      );
    }
    // This private file is produced by the host launcher, not the sandbox.
    const config = JSON.parse(await readFile(configFile, "utf8")) as ResolvedConfig;
    const commands = config.hostRpcHandlers;
    await listen({
      sessionDir,
      logFile,
      sandbox,
      workspace,
      readyFile,
      allowed: allowedMethods(
        config.hostRpcAllow,
        notificationAvailable(commands[METHODS.NOTIFICATION_SEND]),
      ),
      shouldStop: () => stopping,
      handlers: createHandlers(commands, { cwd: config.hostRpcHandlerCwd, sandbox, workspace }),
    });
  } catch (error) {
    console.error(`sbx-pi host RPC: ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
