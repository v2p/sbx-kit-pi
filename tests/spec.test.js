const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const YAML = require("yaml");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "spec.yaml"), "utf8");
const spec = YAML.parse(source);

function credential() {
  assert.equal(spec.credentials.length, 1, "the kit should expose one credential binding");
  return spec.credentials[0];
}

test("uses tier-agnostic OpenAI Codex naming and provider configuration", () => {
  assert.equal(spec.schemaVersion, "2");
  assert.equal(spec.kind, "sandbox");
  assert.equal(spec.name, "pi-openai-codex");
  assert.equal(spec.displayName, "Pi (OpenAI Codex)");
  assert.doesNotMatch(source, /ChatGPT (?:Plus|Pro)/i);
  assert.deepEqual(spec.sandbox.entrypoint, [
    "pi",
    "--provider",
    "openai-codex",
    "--extension",
    "/opt/sbx-kit-pi/extensions/agents-postprocessor.ts",
  ]);
});

test("adds only concise, environment-specific agent instructions", () => {
  assert.equal(
    spec.agentInstructions.content.trim(),
    "This is a Docker Sandbox with Docker access and passwordless sudo.",
  );
});

test("keeps the network allowlist minimal and explicit", () => {
  assert.deepEqual(spec.permissions.network.allow, [
    "auth.openai.com",
    "chatgpt.com",
  ]);
});

test("keeps the OAuth binding and protected credential file intact", () => {
  const binding = credential();
  assert.equal(binding.service, "openai-codex");
  assert.equal(binding.oauth.passthrough, true);
  assert.deepEqual(binding.oauth.tokenEndpoint, {
    host: "auth.openai.com",
    path: "/oauth/token",
  });
  assert.deepEqual(binding.oauth.responseFields, {
    accessToken: "access_token",
    refreshToken: "refresh_token",
    expiresIn: "expires_in",
    scope: "scope",
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
  assert.deepEqual(spec.environment.variables, {
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  });
});

test("uses a versioned custom image with no runtime setup install step", () => {
  assert.match(spec.sandbox.image, /^sbx-kit-pi:\d+\.\d+\.\d+$/);
  assert.equal(spec.setup, undefined);
});

test("does not create or overwrite user settings", () => {
  assert.equal(spec.setup, undefined);
  assert.doesNotMatch(source, /settings\.json/);
  assert.doesNotMatch(source, /defaultProvider/);
  assert.doesNotMatch(source, /enableInstallTelemetry/);
});

test("host launcher has valid Bash syntax", () => {
  const syntax = spawnSync("bash", ["-n", path.join(root, "scripts", "run")], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("does not introduce API-key configuration", () => {
  assert.doesNotMatch(source, /OPENAI_API_KEY/);
});
