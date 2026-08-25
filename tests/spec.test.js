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
  assert.deepEqual(spec.sandbox.entrypoint, ["pi", "--provider", "openai-codex"]);
});

test("adds only concise, environment-specific agent instructions", () => {
  assert.equal(
    spec.agentInstructions.content.trim(),
    "This is a Docker Sandbox with Docker access and passwordless sudo.",
  );
});

test("keeps the network allowlist minimal and explicit", () => {
  assert.deepEqual(spec.permissions.network.allow, [
    "registry.npmjs.org",
    "pi.dev",
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

test("defines a pinned Pi version and disables update checks and telemetry", () => {
  assert.match(spec.environment.variables.PI_AGENT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(spec.environment.variables.PI_SKIP_VERSION_CHECK, "1");
  assert.equal(spec.environment.variables.PI_TELEMETRY, "0");
});

test("installs the configured Pi release as the unprivileged user", () => {
  const installs = spec.setup.install;
  assert.equal(installs.length, 1);
  assert.equal(installs[0].user, "1000");
  assert.match(
    installs[0].command,
    /"@earendil-works\/pi-coding-agent@\$\{PI_AGENT_VERSION}"/,
  );
  assert.doesNotMatch(installs[0].command, /pi-coding-agent@(?:latest|next)(?:\s|;|$)/);
  assert.match(installs[0].command, /installed_version=\$\(pi --version\)/);
  assert.match(installs[0].command, /"\$installed_version" != "\$PI_AGENT_VERSION"/);

  // Docker Sandboxes executes setup.install commands with `sh -c`.
  const syntax = spawnSync("sh", ["-n", "-c", installs[0].command], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("does not create or overwrite user settings", () => {
  assert.equal(spec.setup.files, undefined);
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

test("AGENTS classifier waits for a resolved authenticated model", () => {
  const extension = fs.readFileSync(path.join(root, "extensions", "agents-postprocessor.ts"), "utf8");
  assert.match(extension, /function selectedModel/);
  assert.match(extension, /model\.provider === "unknown"/);
  assert.match(extension, /model\.id === "unknown"/);
  assert.match(extension, /getProviderAuthStatus\(ctx\.model!\.provider\)\.configured/);
  assert.match(extension, /pi\.on\("model_select"/);
  assert.match(extension, /pi\.on\("before_agent_start"/);
  assert.doesNotMatch(extension, /ctx\.model \? `\$\{ctx\.model\.provider}\/\$\{ctx\.model\.id}`/);
});

test("does not introduce API-key configuration", () => {
  assert.doesNotMatch(source, /OPENAI_API_KEY/);
});
