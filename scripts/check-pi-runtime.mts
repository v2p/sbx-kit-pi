import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

// Exercise the actual Pi install, both in checkout tests and the image smoke test.
const manifest = path.resolve(process.argv[2] ?? ".", "package.json");
const metadata = JSON.parse(fs.readFileSync(manifest, "utf8"));
const entry = path.join(
  path.dirname(manifest),
  "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
);
const piRequire = createRequire(entry);
for (const dependency of ["minimatch", "undici"]) {
  assert.equal(piRequire(`${dependency}/package.json`).version, metadata.overrides[dependency]);
}
const moduleUrl = (relative: string) =>
  pathToFileURL(path.join(path.dirname(entry), relative)).href;
const { isBundledNode } = await import(moduleUrl("config.js"));
assert.equal(isBundledNode, false);

// These are Pi's model-scope glob semantics, not just direct minimatch calls.
const { resolveModelScopeFromModels } = await import(moduleUrl("core/model-resolver.js"));
const models = [
  { provider: "openai-codex", id: "gpt-example" },
  { provider: "openai", id: "gpt-other" },
  { provider: "anthropic", id: "claude-example" },
];
for (const [pattern, expected] of [
  ["OPENAI-CODEX/GPT-*:high", [models[0]]],
  ["{openai-codex,anthropic}/*:high", [models[0], models[2]]],
  ["gpt-*:high", [models[0], models[1]]],
] as const) {
  const result = resolveModelScopeFromModels([pattern], models);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.scopedModels,
    expected.map((model) => ({ model, thinkingLevel: "high" })),
  );
}
assert.equal(resolveModelScopeFromModels(["missing/*"], models).diagnostics[0].code, "no-match");

const { loadExtensions } = await import(moduleUrl("core/extensions/loader.js"));
const extensionPaths = [
  "agents-postprocessor",
  "agents-classifier-output",
  "host-rpc",
  "token-usage",
].map((name) => fileURLToPath(new URL(`../extensions/${name}.ts`, import.meta.url)));
const loaded = await loadExtensions(extensionPaths, process.cwd());
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, extensionPaths.length);

// Pi installs npm Undici's fetch and its environment-proxy dispatcher together.
// Only the local smoke server bypasses the ambient proxy, inside this process.
process.env.NO_PROXY = `${process.env.NO_PROXY ?? process.env.no_proxy ?? ""},127.0.0.1`;
process.env.no_proxy = process.env.NO_PROXY;
const { configureHttpDispatcher } = await import(moduleUrl("core/http-dispatcher.js"));
configureHttpDispatcher();
const undici = piRequire("undici");
assert.equal(globalThis.fetch, undici.fetch);
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
  response.end(gzipSync(JSON.stringify({ ok: true })));
});
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await undici.getGlobalDispatcher().close();
}
console.log("Pi runtime: patched dependencies, model globs, extensions, and HTTP transport OK");
