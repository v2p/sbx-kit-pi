import test from "node:test";
import assert from "node:assert/strict";
import {
  validRequest,
  validHostRequest,
  validResult,
  validResponse,
} from "../scripts/host-rpc-protocol.mts";

function envelope(method: string, params: unknown) {
  return { jsonrpc: "2.0", sbxVersion: 1, id: "call-1", session: "s.jsonl", method, params };
}

test("runtime validation correlates built-in methods and parameters", () => {
  for (const request of [
    envelope("notification.send", { title: "Done", body: "Project" }),
    envelope("network.request", { host: "example.com", reason: "Review" }),
    envelope("file.access", { path: "/private/file", toolCallId: "read-1", phase: "success" }),
  ]) {
    assert.ok(validRequest(request));
    assert.ok(validHostRequest(request));
  }
  for (const request of [
    envelope("notification.send", { host: "example.com", reason: "Review" }),
    envelope("network.request", { title: "Done", body: "Project" }),
    envelope("file.access", { path: "/file", toolCallId: "read-1", phase: "approved" }),
    envelope("shell.exec", { command: "never run" }),
  ]) {
    assert.ok(validRequest(request));
    assert.equal(validHostRequest(request), false);
  }
  for (const request of [null, [], 1, "request", envelope("file.access", null)]) {
    assert.equal(validRequest(request), false);
  }
});

test("handler results and RPC replies remain validated at runtime", () => {
  for (const status of ["recorded", "performed"]) {
    assert.ok(validResult({ status }));
    assert.ok(validResponse({ jsonrpc: "2.0", id: "call-1", result: { status } }));
  }
  assert.ok(
    validResponse({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON" },
    }),
  );
  for (const result of [
    null,
    [],
    "recorded",
    { status: "approved" },
    { status: "recorded", extra: true },
  ]) {
    assert.equal(validResult(result), false);
    assert.equal(validResponse({ jsonrpc: "2.0", id: "call-1", result }), false);
  }
  for (const response of [
    null,
    [],
    { jsonrpc: "1.0", id: "call-1", result: { status: "recorded" } },
    { jsonrpc: "2.0", id: null, result: { status: "recorded" } },
    { jsonrpc: "2.0", id: "call-1", error: { code: "-32603", message: "Failed" } },
    { jsonrpc: "2.0", id: "call-1", error: { code: -32603, message: {} } },
    {
      jsonrpc: "2.0",
      id: "call-1",
      result: { status: "recorded" },
      error: { code: -32603, message: "Failed" },
    },
  ]) {
    assert.equal(validResponse(response), false);
  }
});
