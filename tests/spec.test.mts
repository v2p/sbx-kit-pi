import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as YAML from "yaml";
import tokenUsage from "../extensions/token-usage.ts";
import { extensionHarness } from "./helpers/extension-harness.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "sbx-kit-pi.yaml"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version: string;
  devDependencies: Record<string, string>;
  overrides: Record<string, string>;
};
const runtimeMetadata = JSON.parse(
  fs.readFileSync(path.join(root, "runtime/package.json"), "utf8"),
);
const spec = YAML.parse(source);

function capability(name: string) {
  const entries = spec.capabilities.filter(
    (entry: { type: string }) => entry.type === `com.docker.sandbox/${name}@1`,
  );
  assert.equal(entries.length, 1, `the kit should declare one ${name} capability`);
  return entries[0];
}

test("uses a v3 workload with tier-agnostic OpenAI Codex naming", () => {
  // sbx treats spec.yaml as a legacy artifact, even with schemaVersion: "3".
  assert.equal(fs.existsSync(path.join(root, "spec.yaml")), false);
  assert.equal(spec.schemaVersion, "3");
  assert.equal(spec.kind, "workload");
  assert.equal(capability("sbx").config, undefined);
  assert.equal(spec.displayName, "Pi (OpenAI Codex)");
  assert.doesNotMatch(source, /ChatGPT (?:Plus|Pro)/i);
});

test("the image entrypoint applies Pi defaults and preserves caller overrides", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-pi-entrypoint-"));
  let result;
  try {
    fs.writeFileSync(
      path.join(directory, "pi"),
      "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n",
      { mode: 0o755 },
    );
    result = spawnSync(
      path.join(root, "scripts/container-entrypoint"),
      ["--model", "custom-model", "prompt with spaces"],
      {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        encoding: "utf8",
      },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "--provider",
    "openai-codex",
    "--model",
    "gpt-6.1-sol",
    "--extension",
    "/opt/sbx-kit-pi/extensions/agents-postprocessor.ts",
    "--extension",
    "/opt/sbx-kit-pi/extensions/host-rpc.ts",
    "--extension",
    "/opt/sbx-kit-pi/extensions/token-usage.ts",
    "--model",
    "custom-model",
    "prompt with spaces",
  ]);
});

test("keeps Pi and its security overrides aligned between tests and the image", () => {
  const imageVersion = dockerfile.match(/^ARG PI_AGENT_VERSION=(.+)$/m)?.[1];
  assert.equal(imageVersion, packageMetadata.devDependencies["@earendil-works/pi-coding-agent"]);
  assert.equal(imageVersion, runtimeMetadata.dependencies["@earendil-works/pi-coding-agent"]);
  assert.deepEqual(runtimeMetadata.overrides, packageMetadata.overrides);
});

test("Pi's modular runtime uses patched dependencies for model globs and HTTP", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts/check-pi-runtime.mts"), root],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
  assert.match(result.stdout, /Pi runtime:.*OK/);
});

test("reports detailed usage after each interactive LLM turn", () => {
  const { handlers } = extensionHarness(tokenUsage);
  const turnEnd = handlers.turn_end;
  assert.equal(typeof turnEnd, "function");

  const notifications: { message: string; type: string }[] = [];
  const event = {
    message: {
      role: "assistant",
      usage: {
        input: 2100,
        output: 1402,
        cacheRead: 36147,
        cacheWrite: 0,
        reasoning: 920,
        totalTokens: 39649,
      },
    },
  };
  turnEnd(event, {
    mode: "tui",
    ui: { notify: (message: string, type: string) => notifications.push({ message, type }) },
  });
  turnEnd(event, {
    mode: "json",
    ui: { notify: (message: string, type: string) => notifications.push({ message, type }) },
  });

  assert.deepEqual(notifications, [
    {
      message:
        "tokens · prompt 38,247 (new 2,100, cached 36,147) · output 1,402 (reasoning 920) · total 39,649",
      type: "info",
    },
  ]);
});

test("adds only concise, environment-specific agent instructions", () => {
  assert.equal(
    capability("agent-context").config.content.trim(),
    "This is a Docker Sandbox with Docker access and passwordless sudo.",
  );
});

test("keeps the network allowlist minimal and explicit", () => {
  assert.deepEqual(capability("network-policy").config, {
    runtime: { allow: ["auth.openai.com", "chatgpt.com"] },
  });
});

test("keeps the OAuth binding and protected credential file intact", () => {
  const binding = capability("credential").config;
  assert.equal(binding.service, "openai-codex");
  assert.equal(binding.phase, "runtime");
  assert.equal(binding.oauth.passthrough, true);
  assert.deepEqual(binding.oauth.tokenEndpoint, {
    host: "auth.openai.com",
    path: "/oauth/token",
  });
  assert.deepEqual(binding.oauth.responseFields, {
    accessToken: "access_token",
    refreshToken: "refresh_token",
    expiresIn: "expires_in",
  });
  assert.equal(binding.oauth.credentialFile.path, "~/.pi/agent/auth.json");
  assert.deepEqual(binding.oauth.credentialFile.structure, {
    "openai-codex": {
      type: "oauth",
      access: "{{.AccessToken}}",
      refresh: "{{.RefreshToken}}",
      expires: "{{.ExpiresAt}}",
    },
  });
});

test("disables update checks and telemetry at runtime", () => {
  assert.match(dockerfile, /ENV PI_SKIP_VERSION_CHECK=1 \\\n {4}PI_TELEMETRY=0/);
  assert.match(dockerfile, /ENTRYPOINT \["\/opt\/sbx-kit-pi\/scripts\/container-entrypoint"\]/);
  assert.match(dockerfile, /^CMD \[\]$/m);
});

test("uses the kit semver for the custom image with no runtime setup install step", () => {
  assert.equal(
    spec.build.trim(),
    `FROM docker.io/vposvistelik/sbx-kit-pi:${packageMetadata.version}`,
  );
  assert.equal(
    spec.capabilities.some(
      (entry: { type: string }) => entry.type === "com.docker.sandbox/lifecycle@1",
    ),
    false,
  );
  assert.equal(spec.setup, undefined);
});

test("does not create or overwrite user settings", () => {
  assert.equal(spec.setup, undefined);
  assert.doesNotMatch(source, /settings\.json/);
  assert.doesNotMatch(source, /defaultProvider/);
  assert.doesNotMatch(source, /enableInstallTelemetry/);
});

test("shell scripts have valid Bash syntax", () => {
  for (const script of ["run", "check", "container-entrypoint", "node-environment"]) {
    const syntax = spawnSync("bash", ["-n", path.join(root, "scripts", script)], {
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, `${script}: ${syntax.stderr}`);
  }
});

test("launcher help works without dependencies, configuration, or Docker", () => {
  for (const args of [
    ["--help"],
    ["-h"],
    ["status", "--help"],
    ["plan", "--help"],
    ["config", "show", "--help"],
    ["config", "alias", "--help"],
  ]) {
    const result = spawnSync(path.join(root, "scripts", "run"), args, {
      encoding: "utf8",
      env: { ...process.env, XDG_CONFIG_HOME: "/nonexistent", PATH: "/usr/bin:/bin" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: sbx-pi/);
    assert.match(result.stdout, /--recreate/);
    assert.match(result.stdout, /discard sandbox-local changes/);
    assert.equal(result.stderr, "");
  }
});

test("imports a Codex CLI OAuth credential into Pi's auth format", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-kit-pi-convert-auth-"));
  const sourcePath = path.join(temporary, "codex-auth.json");
  const targetPath = path.join(temporary, "pi", "auth.json");
  const expires = 1_800_000_000;
  const payload = Buffer.from(
    JSON.stringify({
      exp: expires,
      "https://api.openai.com/auth": { chatgpt_account_id: "account-from-claim" },
    }),
  ).toString("base64url");
  const access = `header.${payload}.signature`;

  fs.writeFileSync(
    sourcePath,
    JSON.stringify({
      tokens: {
        access_token: access,
        refresh_token: "refresh-token",
        account_id: "account-from-file",
      },
    }),
    { mode: 0o600 },
  );
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    targetPath,
    JSON.stringify({
      anthropic: { type: "api_key", key: "existing-key" },
    }),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "import-codex-auth.mts"), sourcePath, targetPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(targetPath, "utf8")), {
      anthropic: { type: "api_key", key: "existing-key" },
      "openai-codex": {
        type: "oauth",
        access,
        refresh: "refresh-token",
        expires: expires * 1000,
        accountId: "account-from-file",
      },
    });
    assert.equal(fs.statSync(targetPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("does not introduce API-key configuration", () => {
  assert.doesNotMatch(source, /OPENAI_API_KEY/);
});
