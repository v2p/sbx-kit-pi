import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const REQUEST_FILE = ".host-rpc.requests.jsonl";
export const RESPONSE_FILE = ".host-rpc.responses.jsonl";
export const MAX_RECORD_BYTES = 4096;
export const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
export const METHODS = Object.freeze({
  NOTIFICATION_SEND: "notification.send",
  NETWORK_REQUEST: "network.request",
  FILE_ACCESS: "file.access",
});

function object(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function text(value, max) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

export function validRequest(request) {
  return (
    object(request, ["jsonrpc", "sbxVersion", "id", "method", "params", "session"]) &&
    request.jsonrpc === "2.0" &&
    request.sbxVersion === 1 &&
    typeof request.id === "string" &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(request.id) &&
    text(request.method, 80) &&
    text(request.session, 256) &&
    request.params !== null &&
    typeof request.params === "object" &&
    !Array.isArray(request.params)
  );
}

export function validParams(method, params) {
  switch (method) {
    case METHODS.NOTIFICATION_SEND:
      return object(params, ["title", "body"]) && text(params.title, 160) && text(params.body, 320);
    case METHODS.NETWORK_REQUEST:
      return (
        object(params, ["host", "reason"]) &&
        text(params.reason, 1000) &&
        typeof params.host === "string" &&
        params.host.length <= 253 &&
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          params.host,
        )
      );
    case METHODS.FILE_ACCESS:
      return (
        object(params, ["path", "toolCallId", "phase"]) &&
        text(params.path, 2048) &&
        isAbsolute(params.path) &&
        text(params.toolCallId, 256) &&
        ["attempt", "success", "error"].includes(params.phase)
      );
    default:
      return false;
  }
}

// A bounded incremental decoder. Oversized lines are discarded through their
// newline; partial writes are retained rather than parsed prematurely.
export class Records {
  pending = Buffer.alloc(0);
  dropping = false;

  feed(chunk) {
    const records = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (!this.dropping) {
        if (this.pending.length + part.length > MAX_RECORD_BYTES) {
          this.pending = Buffer.alloc(0);
          this.dropping = true;
        } else {
          this.pending = Buffer.concat([this.pending, part]);
        }
      }
      if (newline < 0) {
        break;
      }
      records.push(this.dropping ? null : this.pending.toString("utf8"));
      this.pending = Buffer.alloc(0);
      this.dropping = false;
      start = newline + 1;
    }
    return records;
  }
}

export async function callHost(sessionDir, session, method, params, signal) {
  signal?.throwIfAborted();
  const replies = await open(
    join(sessionDir, RESPONSE_FILE),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await replies.stat();
    if (!stat.isFile() || stat.size > MAX_QUEUE_BYTES) {
      throw new Error("Invalid host RPC response queue");
    }
    let position = stat.size;
    signal?.throwIfAborted();
    const id = await enqueue(sessionDir, session, method, params);
    if (!id) {
      throw new Error("Host RPC listener is unavailable");
    }
    const decoder = new Records();
    const buffer = Buffer.alloc(16384);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const size = (await replies.stat()).size;
      if (size < position || size > MAX_QUEUE_BYTES) {
        throw new Error("Host RPC response queue truncated or full");
      }
      if (position < size) {
        const { bytesRead } = await replies.read(
          buffer,
          0,
          Math.min(buffer.length, size - position),
          position,
        );
        position += bytesRead;
        for (const line of decoder.feed(buffer.subarray(0, bytesRead))) {
          let response;
          try {
            response = JSON.parse(line ?? "");
          } catch {
            continue;
          }
          if (response?.jsonrpc === "2.0" && response.id === id) {
            if (response.error) {
              throw new Error(
                `Host rejected RPC (${response.error.code}): ${response.error.message}`,
              );
            }
            if (["recorded", "performed"].includes(response.result?.status)) {
              return { id, status: response.result.status };
            }
          }
        }
      } else {
        await delay(100, undefined, { signal });
      }
    }
    throw new Error(`Host RPC timed out (${id}); outcome unknown, do not automatically retry`);
  } finally {
    await replies.close();
  }
}

export async function enqueue(sessionDir, session, method, params) {
  if (!isAbsolute(sessionDir) || !validParams(method, params)) {
    throw new Error("Invalid host RPC request");
  }
  const id = randomUUID();
  const record =
    JSON.stringify({ jsonrpc: "2.0", sbxVersion: 1, id, session, method, params }) + "\n";
  if (!validRequest(JSON.parse(record)) || Buffer.byteLength(record) > MAX_RECORD_BYTES) {
    throw new Error("Host RPC request exceeds protocol limits");
  }
  let queue;
  try {
    queue = await open(
      join(sessionDir, REQUEST_FILE),
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await queue.stat();
    if (!stat.isFile() || stat.size + Buffer.byteLength(record) > MAX_QUEUE_BYTES) {
      throw new Error("Host RPC queue is not a regular file or is full");
    }
    // One append write per record; no producer creates an unattended queue.
    const { bytesWritten } = await queue.write(record);
    if (bytesWritten !== Buffer.byteLength(record)) {
      throw new Error("Incomplete host RPC append");
    }
    return id;
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  } finally {
    await queue?.close();
  }
}
