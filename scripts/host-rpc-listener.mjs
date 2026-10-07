import { constants } from "node:fs";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
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
  validParams,
} from "./host-rpc-protocol.mjs";

import { createHandlers, notificationAvailable } from "./host-rpc-handlers.mjs";

const METHOD_NAMES = Object.values(METHODS);
const MAX_CALLS = 10000;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const NOTIFICATION_BURST = 3;
const NOTIFICATION_REFILL_MS = 10000;

function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function allowedMethods(value, notificationAvailable) {
  const names =
    value === undefined ? METHOD_NAMES : value === "off" || value === "" ? [] : value.split(",");
  if (names.some((name) => !METHOD_NAMES.includes(name))) {
    throw new Error("SBX_PI_HOST_RPC_ALLOW contains an unknown method");
  }
  return new Set(
    names.filter((name) => name !== METHODS.NOTIFICATION_SEND || notificationAvailable),
  );
}

export async function createDispatcher({
  allowed,
  handlers,
  record,
  now = () => performance.now(),
}) {
  const seen = new Set();
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
    let request;
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
    const { id, method, params } = request;
    let response;
    if (seen.has(id)) {
      response = failure(id, -32002, "Duplicate request ID");
    } else if (seen.size >= MAX_CALLS) {
      response = failure(id, -32003, "Request limit reached");
    } else {
      seen.add(id);
      if (!METHOD_NAMES.includes(method)) {
        response = failure(id, -32601, "Unknown method");
      } else if (!allowed.has(method)) {
        response = failure(id, -32001, "Method not allowed by host");
      } else if (!validParams(method, params)) {
        response = failure(id, -32602, "Invalid parameters");
      } else if (method === METHODS.NOTIFICATION_SEND && !takeNotificationToken()) {
        response = failure(id, -32003, "Notification rate limit reached");
      } else {
        // Record before any host side effect; a failed/full log fails closed.
        await record({ request, status: "accepted" });
        try {
          const result = await handlers[method](request);
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
}) {
  const paths = [join(sessionDir, REQUEST_FILE), join(sessionDir, RESPONSE_FILE)];
  const handles = [];
  let log;
  let lock;
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
    const record = async (data) => {
      const line =
        JSON.stringify({ receivedAt: new Date().toISOString(), sandbox, workspace, ...data }) +
        "\n";
      logBytes += Buffer.byteLength(line);
      if (logBytes > MAX_LOG_BYTES) {
        throw new Error("Host RPC log is full; archive it on the host before relaunching");
      }
      await log.writeFile(line);
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
    const config = JSON.parse(await readFile(configFile, "utf8"));
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
    console.error(`sbx-pi host RPC: ${error.message}`);
    process.exitCode = 2;
  }
}
