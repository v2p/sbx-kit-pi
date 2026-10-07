import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  createHandlers,
  resolveHandlers,
  defaultCommand,
  notificationAvailable,
} from "../scripts/host-rpc-handlers.mjs";
import { createDispatcher, allowedMethods } from "../scripts/host-rpc-listener.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-rpc-handlers-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "consumer.mjs");
  await fs.writeFile(
    script,
    `
import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const data = JSON.parse(input);
fs.appendFileSync('received.jsonl', JSON.stringify({ name: process.argv[2], ...data }) + '\\n');
console.log(JSON.stringify({ status: 'recorded' }));
`,
  );
  return { dir, script };
}

function envelope(
  id = "request-1",
  method = "network.request",
  params = { host: "example.com", reason: "Manual review" },
) {
  return { jsonrpc: "2.0", sbxVersion: 1, id, session: "session.jsonl", method, params };
}

function handlers(config, dir) {
  return createHandlers(resolveHandlers(config, dir), {
    cwd: dir,
    sandbox: "sandbox",
    workspace: "/host/workspace",
  });
}

test("reference handlers are configured by default and record network/file reports without acting on them", async (t) => {
  const { dir } = await fixture(t);
  const commands = resolveHandlers(undefined, dir);
  for (const method of ["notification.send", "network.request", "file.access"]) {
    assert.deepEqual(commands[method], [defaultCommand(method)]);
  }
  const run = handlers(undefined, dir);
  assert.deepEqual(await run["network.request"](envelope()), { status: "recorded" });
  assert.deepEqual(
    await run["file.access"](
      envelope("file-1", "file.access", {
        path: "/not-a-host-file",
        toolCallId: "read-1",
        phase: "attempt",
      }),
    ),
    { status: "recorded" },
  );
});

test("consumers receive validated data and host context in order, after audit, without shell interpolation", async (t) => {
  const { dir, script } = await fixture(t);
  const run = handlers(
    {
      "network.request": [
        ["default"],
        [process.execPath, script, "first"],
        [process.execPath, script, "second"],
      ],
    },
    dir,
  );
  let audited = false;
  const dispatch = await createDispatcher({
    allowed: allowedMethods("network.request", true),
    handlers: {
      ...run,
      "network.request": async (request) => {
        assert.equal(audited, true);
        return run["network.request"](request);
      },
    },
    record: async (entry) => {
      if (entry.status === "accepted") {
        audited = true;
      }
    },
  });
  const request = envelope();
  request.params.reason = 'Review $(touch forbidden); "quoted" & <data>';
  assert.equal((await dispatch(JSON.stringify(request))).result.status, "recorded");
  const received = (await fs.readFile(path.join(dir, "received.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    received.map((entry) => entry.name),
    ["first", "second"],
  );
  assert.deepEqual(received[0].request, request);
  assert.deepEqual(received[0].context, { sandbox: "sandbox", workspace: "/host/workspace" });
  await assert.rejects(fs.access(path.join(dir, "forbidden")));
  assert.equal((await dispatch(JSON.stringify(request))).error.code, -32002);
  assert.equal(
    (
      await dispatch(
        JSON.stringify(envelope("invalid", "network.request", { host: "--help", reason: "x" })),
      )
    ).error.code,
    -32602,
  );
  assert.equal(
    (
      await dispatch(
        JSON.stringify(
          envelope("denied", "file.access", {
            path: "/file",
            toolCallId: "read",
            phase: "attempt",
          }),
        ),
      )
    ).error.code,
    -32001,
  );
  assert.equal(
    (await fs.readFile(path.join(dir, "received.jsonl"), "utf8")).trim().split("\n").length,
    2,
  );
});

test("custom notification handlers do not depend on notify-send and results reflect the chain", async (t) => {
  const { dir, script } = await fixture(t);
  const config = { "notification.send": [[process.execPath, script, "notify"]] };
  const commands = resolveHandlers(config, dir);
  assert.equal(notificationAvailable(commands["notification.send"]), true);
  const run = handlers(config, dir);
  assert.deepEqual(
    await run["notification.send"](
      envelope("notify", "notification.send", { title: "Done", body: "Project" }),
    ),
    { status: "recorded" },
  );
  const performed = path.join(dir, "performed.mjs");
  await fs.writeFile(performed, 'console.log(JSON.stringify({ status: "performed" }));');
  const chain = handlers({ "network.request": [[process.execPath, performed], ["default"]] }, dir);
  assert.deepEqual(await chain["network.request"](envelope()), { status: "performed" });
});

test("failed, malformed, oversized and timed-out handlers fail the call without running later consumers or leaking details", async (t) => {
  const { dir, script } = await fixture(t);
  for (const [name, source] of Object.entries({
    failed: 'console.error("private host detail"); process.exitCode = 1;',
    malformed: 'console.log(JSON.stringify({ status: "approved" }));',
    oversized: 'console.log("x".repeat(5000));',
    timeout: 'setTimeout(() => console.log("private host detail"), 10000);',
  })) {
    const failing = path.join(dir, `${name}.mjs`);
    await fs.writeFile(failing, source);
    const dispatch = await createDispatcher({
      allowed: allowedMethods("network.request", true),
      handlers: handlers(
        {
          "network.request": [
            [process.execPath, failing],
            [process.execPath, script, "must-not-run"],
          ],
        },
        dir,
      ),
      record: async () => {},
    });
    assert.deepEqual((await dispatch(JSON.stringify(envelope(name)))).error, {
      code: -32603,
      message: "Host handler failed",
    });
  }
  await assert.rejects(fs.access(path.join(dir, "received.jsonl")));
});

test("reference notifications are unavailable without notify-send, but custom-only chains remain available", () => {
  const module = new URL("../scripts/host-rpc-handlers.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import { defaultCommand, notificationAvailable } from ${JSON.stringify(module)};
console.log(JSON.stringify([
  notificationAvailable([defaultCommand('notification.send')]),
  notificationAvailable([['/custom/notify']]),
]));
`,
    ],
    { env: { ...process.env, PATH: "" }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [false, true]);
});

test(
  "timeouts terminate ordinary descendants that retain handler pipes",
  { skip: process.platform === "win32" },
  async (t) => {
    const { dir } = await fixture(t);
    const script = path.join(dir, "descendants.mjs");
    const marker = path.join(dir, "descendant-side-effect");
    await fs.writeFile(
      script,
      `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'), 2500);`)}], { stdio: 'inherit' });
setTimeout(() => {}, 10000);
`,
    );
    const dispatch = await createDispatcher({
      allowed: allowedMethods("network.request", true),
      handlers: handlers({ "network.request": [[process.execPath, script]] }, dir),
      record: async () => {},
    });
    const started = performance.now();
    assert.equal((await dispatch(JSON.stringify(envelope()))).error.code, -32603);
    assert.ok(performance.now() - started < 4000, "descendant pipes must not delay the timeout");
    await delay(800);
    await assert.rejects(fs.access(marker));
  },
);

test("a failed audit never invokes configured consumers", async (t) => {
  const { dir, script } = await fixture(t);
  const dispatch = await createDispatcher({
    allowed: allowedMethods("network.request", true),
    handlers: handlers({ "network.request": [[process.execPath, script]] }, dir),
    record: async () => {
      throw new Error("audit full");
    },
  });
  await assert.rejects(dispatch(JSON.stringify(envelope())), /audit full/);
  await assert.rejects(fs.access(path.join(dir, "received.jsonl")));
});
