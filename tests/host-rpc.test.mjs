import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { allowedMethods, createDispatcher, listen } from "../scripts/host-rpc-listener.mjs";
import {
  REQUEST_FILE,
  RESPONSE_FILE,
  MAX_RECORD_BYTES,
  MAX_QUEUE_BYTES,
  Records,
  enqueue,
  callHost,
} from "../scripts/host-rpc-protocol.mjs";

const require = createRequire(import.meta.url);
const { createJiti } = require(
  require.resolve("jiti", {
    paths: [path.resolve("node_modules/@earendil-works/pi-coding-agent")],
  }),
);
const extension = createJiti(import.meta.url)(path.resolve("extensions/host-rpc.ts")).default;

function request(
  method = "notification.send",
  params = { title: "Done", body: "Project" },
  id = "call-1",
) {
  return JSON.stringify({
    jsonrpc: "2.0",
    sbxVersion: 1,
    id,
    session: "session.jsonl",
    method,
    params,
  });
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-rpc-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    dir,
    sessionDir: dir,
    logFile: path.join(dir, "host/log.jsonl"),
    readyFile: path.join(dir, "ready"),
    sandbox: "host-selected-sandbox",
    workspace: "/host/workspace",
  };
}

async function waitFor(check) {
  for (let n = 0; n < 200; n++) {
    if (await check()) {
      return;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for test condition");
}

async function exists(file) {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function running(t, options = {}) {
  const f = await fixture(t);
  let stop = false;
  const notifications = [];
  const task = listen({
    ...f,
    allowed: allowedMethods(undefined, true),
    shouldStop: () => stop,
    notify: async (...args) => {
      notifications.push(args);
    },
    ...options,
  });
  // Observe a failure immediately, even if startup never signals readiness.
  task.catch(() => {});
  t.after(async () => {
    stop = true;
    await task;
  });
  await waitFor(() => exists(f.readyFile));
  return {
    ...f,
    notifications,
    finish: async () => {
      stop = true;
      await task;
    },
  };
}

async function lines(file) {
  return (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("framing preserves partial Unicode records and recovers after oversized records", () => {
  const decoder = new Records();
  const input = Buffer.from("雪\ttext\n");
  assert.deepEqual(decoder.feed(input.subarray(0, 1)), []);
  assert.deepEqual(decoder.feed(input.subarray(1, 4)), []);
  assert.deepEqual(decoder.feed(input.subarray(4)), ["雪\ttext"]);
  assert.deepEqual(decoder.feed(Buffer.alloc(MAX_RECORD_BYTES + 1, 97)), []);
  assert.equal(decoder.pending.length, 0);
  assert.deepEqual(decoder.feed(Buffer.from("tail\nok\n")), [null, "ok"]);
});

test("dispatcher uses only host allowed methods and validates payloads before side effects", async () => {
  const performed = [];
  const log = [];
  const dispatch = await createDispatcher({
    allowed: allowedMethods("notification.send,network.request", true),
    notify: async (...args) => performed.push(args),
    record: async (entry) => log.push(entry),
  });
  assert.equal((await dispatch(request())).result.status, "performed");
  assert.equal((await dispatch(request())).error.code, -32002);
  assert.equal(
    (await dispatch(request("host.exec", { command: "touch /tmp/forbidden" }, "unknown"))).error
      .code,
    -32601,
  );
  assert.equal(
    (
      await dispatch(
        request("file.access", { path: "/private", toolCallId: "1", phase: "attempt" }, "denied"),
      )
    ).error.code,
    -32001,
  );
  for (const [n, params] of [
    { title: "Done\nInjected", body: "x" },
    { title: "Done", body: "x", command: "evil" },
    { title: "Done", body: "x".repeat(321) },
    { title: "", body: "x" },
  ].entries()) {
    assert.equal(
      (await dispatch(request("notification.send", params, `bad-${n}`))).error.code,
      -32602,
    );
  }
  assert.equal((await dispatch("not JSON")).error.code, -32700);
  assert.equal(
    (await dispatch(request().replace('"sbxVersion":1', '"sbxVersion":2'))).error.code,
    -32600,
  );
  assert.equal((await dispatch("[]")).error.code, -32600);
  assert.deepEqual(performed, [["Done", "Project"]]);
  assert.equal(JSON.stringify(log).includes("touch /tmp/forbidden"), false);
  assert.deepEqual([...allowedMethods(undefined, false)], ["network.request", "file.access"]);
  assert.equal(allowedMethods("off", true).size, 0);
  assert.throws(() => allowedMethods("host.exec", true), /unknown method/);
});

test("network requests are record-only, require concrete domains, and never grant access", async () => {
  const log = [];
  const dispatch = await createDispatcher({
    allowed: allowedMethods("network.request", false),
    notify: async () => assert.fail("network request must not notify/execute"),
    record: async (entry) => log.push(entry),
  });
  assert.equal(
    (
      await dispatch(
        request("network.request", {
          host: "registry.npmjs.org",
          reason: "Install locked dependencies",
        }),
      )
    ).result.status,
    "recorded",
  );
  for (const [n, host] of [
    "https://example.com/path?token=secret",
    "*.example.com",
    "example.com:443",
    "example.com\n",
    "--help",
    "localhost",
  ].entries()) {
    assert.equal(
      (await dispatch(request("network.request", { host, reason: "Needed" }, `invalid-${n}`))).error
        .code,
      -32602,
    );
  }
  assert.equal(log.filter((entry) => entry.status === "accepted").length, 1);
});

test("notifications permit small bursts, refill over time, and have no lifetime cap", async () => {
  let time = 0;
  let calls = 0;
  const log = [];
  const dispatch = await createDispatcher({
    allowed: allowedMethods(undefined, true),
    now: () => time,
    notify: async () => {
      calls++;
    },
    record: async (entry) => log.push(entry),
  });
  // Invalid calls do not consume slots.
  assert.equal(
    (await dispatch(request("notification.send", { title: "", body: "x" }, "invalid"))).error.code,
    -32602,
  );
  for (let n = 0; n < 3; n++) {
    assert.equal(
      (await dispatch(request(undefined, undefined, `burst-${n}`))).result.status,
      "performed",
    );
  }
  assert.equal((await dispatch(request(undefined, undefined, "burst-0"))).error.code, -32002);
  assert.deepEqual((await dispatch(request(undefined, undefined, "overflow"))).error, {
    code: -32003,
    message: "Notification rate limit reached",
  });
  assert.ok(log.some((entry) => entry.id === "overflow" && entry.response.error.code === -32003));
  // All session labels share the bucket; other handlers remain available.
  const otherSession = JSON.parse(request(undefined, undefined, "other-session"));
  otherSession.session = "other.jsonl";
  assert.equal((await dispatch(JSON.stringify(otherSession))).error.code, -32003);
  assert.equal(
    (
      await dispatch(
        request("network.request", { host: "example.com", reason: "Review" }, "network"),
      )
    ).result.status,
    "recorded",
  );
  assert.equal(
    (
      await dispatch(
        request(
          "file.access",
          { path: "/private/file", toolCallId: "read-1", phase: "attempt" },
          "read",
        ),
      )
    ).result.status,
    "recorded",
  );
  assert.equal(calls, 3);
  // Rejections during a partial refill must not postpone recovery.
  for (const partial of [5000, 9999]) {
    time = partial;
    assert.equal(
      (await dispatch(request(undefined, undefined, `partial-${partial}`))).error.code,
      -32003,
    );
  }
  time = 10000;
  assert.equal(
    (await dispatch(request(undefined, undefined, "refilled"))).result.status,
    "performed",
  );
  assert.equal(
    (await dispatch(request(undefined, undefined, "refilled-overflow"))).error.code,
    -32003,
  );
  // Long idle periods replenish at most the burst allowance.
  time += 60000;
  for (let n = 0; n < 3; n++) {
    assert.equal(
      (await dispatch(request(undefined, undefined, `idle-${n}`))).result.status,
      "performed",
    );
  }
  assert.equal((await dispatch(request(undefined, undefined, "idle-overflow"))).error.code, -32003);
  // A long-running launcher can send more than the former 60-call cap.
  for (let n = 0; n < 70; n++) {
    time += 10000;
    assert.equal(
      (await dispatch(request(undefined, undefined, `later-${n}`))).result.status,
      "performed",
    );
  }
  assert.equal(calls, 77);
});

test("concurrent notification calls cannot exceed the shared burst allowance", async () => {
  let calls = 0;
  const dispatch = await createDispatcher({
    allowed: allowedMethods("notification.send", true),
    now: () => 0,
    notify: async () => {
      calls++;
    },
    record: async () => {},
  });
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, n) =>
      dispatch(request(undefined, undefined, `concurrent-${n}`)),
    ),
  );
  assert.equal(responses.filter((response) => response.result?.status === "performed").length, 3);
  assert.equal(responses.filter((response) => response.error?.code === -32003).length, 17);
  assert.equal(calls, 3);
});

test("notification handler failures consume rate-limit slots and do not leak host details", async () => {
  let time = 0;
  let calls = 0;
  const dispatch = await createDispatcher({
    allowed: allowedMethods("notification.send", true),
    now: () => time,
    notify: async () => {
      calls++;
      throw new Error("host detail must not leak");
    },
    record: async () => {},
  });
  for (let n = 0; n < 3; n++) {
    const response = await dispatch(request(undefined, undefined, `n-${n}`));
    assert.equal(response.error.code, -32603);
    assert.equal(JSON.stringify(response).includes("host detail"), false);
  }
  assert.equal((await dispatch(request(undefined, undefined, "overflow"))).error.code, -32003);
  assert.equal(calls, 3);
  time = 10000;
  assert.equal((await dispatch(request(undefined, undefined, "refilled"))).error.code, -32603);
  assert.equal(
    (await dispatch(request(undefined, undefined, "overflow-again"))).error.code,
    -32003,
  );
  assert.equal(calls, 4);
});

test("failed audit writes fail closed before executing notifications", async () => {
  const dispatch = await createDispatcher({
    allowed: allowedMethods(undefined, true),
    notify: async () => assert.fail("must fail closed"),
    record: async () => {
      throw new Error("disk full");
    },
  });
  await assert.rejects(dispatch(request()), /disk full/);
});

test("listener handles partial writes, correlated concurrent calls, rejection, and shutdown drain", async (t) => {
  const f = await running(t);
  const queue = path.join(f.dir, REQUEST_FILE);
  assert.equal((await fs.stat(queue)).mode & 0o777, 0o600);
  const partial = request(undefined, undefined, "partial");
  await fs.appendFile(queue, partial.slice(0, 20));
  await delay(150);
  assert.deepEqual(f.notifications, []);
  await fs.appendFile(queue, partial.slice(20) + "\n");
  const results = await Promise.all([
    callHost(f.dir, "session.jsonl", "network.request", { host: "example.com", reason: "Review" }),
    callHost(f.dir, "other.jsonl", "file.access", {
      path: "/private/file",
      toolCallId: "read-1",
      phase: "attempt",
    }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["recorded", "recorded"],
  );
  assert.notEqual(results[0].id, results[1].id);
  await fs.appendFile(queue, request(undefined, undefined, "last") + "\n");
  await f.finish();
  assert.deepEqual(f.notifications, [
    ["Done", "Project"],
    ["Done", "Project"],
  ]);
  assert.equal(await exists(queue), false);
  assert.equal(await exists(path.join(f.dir, RESPONSE_FILE)), false);
  const log = await lines(f.logFile);
  assert.ok(
    log.every(
      (entry) => entry.sandbox === f.sandbox && entry.workspace === f.workspace && entry.receivedAt,
    ),
  );
  assert.equal(log.filter((entry) => entry.status === "accepted").length, 4);
  assert.equal((await fs.stat(f.logFile)).mode & 0o777, 0o600);
});

test("client reports denied methods and cancellation without implying approval", async (t) => {
  const f = await running(t, { allowed: allowedMethods("file.access", false) });
  await assert.rejects(
    callHost(f.dir, "s.jsonl", "network.request", { host: "example.com", reason: "Needed" }),
    /Method not allowed/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    callHost(
      f.dir,
      "s.jsonl",
      "file.access",
      { path: "/file", toolCallId: "x", phase: "attempt" },
      controller.signal,
    ),
    /abort/i,
  );
});

test("producers do not create unattended queues or follow queue symlinks", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await enqueue(f.dir, "s.jsonl", "notification.send", { title: "Done", body: "x" }),
    undefined,
  );
  assert.equal(await exists(path.join(f.dir, REQUEST_FILE)), false);
  const target = path.join(f.dir, "untouched");
  await fs.writeFile(target, "original");
  await fs.symlink(target, path.join(f.dir, REQUEST_FILE));
  await assert.rejects(
    enqueue(f.dir, "s.jsonl", "notification.send", { title: "Done", body: "x" }),
  );
  assert.equal(await fs.readFile(target, "utf8"), "original");
});

test("listener refuses stale or symlinked queues and never deletes another listener's files", async (t) => {
  const f = await running(t);
  await assert.rejects(
    listen({ ...f, shouldStop: () => true, allowed: new Set(), notify: async () => {} }),
    /EEXIST/,
  );
  assert.equal(await exists(path.join(f.dir, REQUEST_FILE)), true);
  await f.finish();
  await fs.symlink(f.logFile, path.join(f.dir, RESPONSE_FILE));
  await assert.rejects(
    listen({ ...f, shouldStop: () => true, allowed: new Set(), notify: async () => {} }),
    /EEXIST/,
  );
  assert.equal(await exists(path.join(f.dir, REQUEST_FILE)), false);
  assert.equal((await fs.lstat(path.join(f.dir, RESPONSE_FILE))).isSymbolicLink(), true);
});

test("host pins response descriptors rather than following sandbox replacements", async (t) => {
  const f = await running(t);
  const target = path.join(f.dir, "untouched");
  const responseFile = path.join(f.dir, RESPONSE_FILE);
  await fs.writeFile(target, "original");
  await fs.unlink(responseFile);
  await fs.symlink(target, responseFile);
  await enqueue(f.dir, "s.jsonl", "notification.send", { title: "Done", body: "x" });
  await f.finish();
  assert.equal(await fs.readFile(target, "utf8"), "original");
  assert.deepEqual(f.notifications, [["Done", "x"]]);
});

test("listener fails closed on queue size abuse and cleans its endpoints", async (t) => {
  const f = await fixture(t);
  let stop = false;
  const task = listen({
    ...f,
    allowed: allowedMethods(undefined, true),
    shouldStop: () => stop,
    notify: async () => assert.fail("oversized queue"),
  });
  task.catch(() => {});
  await waitFor(() => exists(f.readyFile));
  await fs.truncate(path.join(f.dir, REQUEST_FILE), MAX_QUEUE_BYTES + 1);
  await assert.rejects(task, /queue truncated or full/);
  stop = true;
  assert.equal(await exists(path.join(f.dir, REQUEST_FILE)), false);
});

test("extension emits only settled notifications and read metadata, never file contents", async (t) => {
  const f = await fixture(t);
  const queue = path.join(f.dir, REQUEST_FILE);
  await fs.writeFile(queue, "");
  const handlers = {};
  const tools = [];
  extension({
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerTool: (tool) => tools.push(tool),
    getSessionName: () => "Named session",
  });
  const ctx = {
    cwd: f.dir,
    isIdle: () => true,
    sessionManager: { getSessionFile: () => path.join(f.dir, "session.jsonl") },
  };
  await handlers.agent_settled({}, ctx);
  assert.equal((await fs.stat(queue)).size, 0);
  handlers.agent_start();
  await handlers.agent_settled({}, { ...ctx, isIdle: () => false });
  await handlers.agent_settled({}, ctx);
  await handlers.agent_settled({}, ctx);
  await handlers.tool_call(
    { toolName: "read", input: { path: "private.txt" }, toolCallId: "read-1" },
    ctx,
  );
  await handlers.tool_result(
    {
      toolName: "read",
      input: { path: "private.txt" },
      toolCallId: "read-1",
      isError: true,
      content: [{ type: "text", text: "PRIVATE SECRET" }],
    },
    ctx,
  );
  await handlers.tool_call(
    { toolName: "bash", input: { command: "cat private.txt" }, toolCallId: "shell" },
    ctx,
  );
  const events = await lines(queue);
  assert.deepEqual(
    events.map((event) => event.method),
    ["notification.send", "file.access", "file.access"],
  );
  assert.deepEqual(
    events.slice(1).map((event) => event.params.phase),
    ["attempt", "error"],
  );
  assert.equal(events[1].params.path, path.join(f.dir, "private.txt"));
  assert.equal(JSON.stringify(events).includes("PRIVATE SECRET"), false);
  assert.equal(tools[0].name, "host_network_request");
  await fs.rm(queue);
  await handlers.tool_call({ toolName: "read", input: { path: "x" }, toolCallId: "x" }, ctx);
  assert.equal(await exists(queue), false);
});
