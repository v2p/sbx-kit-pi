import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const environment = fileURLToPath(new URL("../scripts/node-environment", import.meta.url));

function run(script: string, options?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, BASH_ENV: "", NODE_USE_ENV_PROXY: "1" };
  // Do not let ambient warning suppression make these checks pass accidentally.
  delete env.NODE_OPTIONS;
  delete env.NODE_NO_WARNINGS;
  if (options !== undefined) {
    env.NODE_OPTIONS = options;
  }
  return spawnSync(
    "bash",
    ["-euc", script, "node-environment-test", environment, process.execPath],
    {
      encoding: "utf8",
      env,
    },
  );
}

test("Node environment preserves options and proxy support without accumulating flags", () => {
  for (const options of [undefined, "", "--stack-trace-limit=37"]) {
    const result = run(
      'source "$1"; source "$1"; "$2" -e \'console.log(JSON.stringify({ options: process.env.NODE_OPTIONS, proxy: process.env.NODE_USE_ENV_PROXY, limit: Error.stackTraceLimit }))\'',
      options,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.options, `${options ? `${options} ` : ""}--disable-warning=UNDICI-EHPA`);
    assert.equal(actual.proxy, "1");
    if (options) {
      assert.equal(actual.limit, 37);
    }
  }
});

test("Node environment hides only UNDICI-EHPA and leaves other warnings visible", () => {
  const result = run(
    'source "$1"; "$2" -e \'process.emitWarning("proxy notice", { code: "UNDICI-EHPA" }); process.emitWarning("keep this diagnostic", { code: "SBX_TEST_WARNING" })\'',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /UNDICI-EHPA|proxy notice|EnvHttpProxyAgent/);
  assert.match(result.stderr, /\[SBX_TEST_WARNING\].*keep this diagnostic/);
});
