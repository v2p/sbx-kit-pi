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
const source = fs.readFileSync(path.join(root, "spec.yaml"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version: string;
  devDependencies: Record<string, string>;
};
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
    "/opt/sbx-kit-pi/scripts/container-entrypoint",
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
  ]);
});

test("uses the same Pi version for tests and the sandbox image", () => {
  const imageVersion = dockerfile.match(/^ARG PI_AGENT_VERSION=(.+)$/m)?.[1];
  assert.equal(imageVersion, packageMetadata.devDependencies["@earendil-works/pi-coding-agent"]);
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
    spec.agentInstructions.content.trim(),
    "This is a Docker Sandbox with Docker access and passwordless sudo.",
  );
});

test("keeps the network allowlist minimal and explicit", () => {
  assert.deepEqual(spec.permissions.network.allow, ["auth.openai.com", "chatgpt.com"]);
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

test("uses the kit semver for the custom image with no runtime setup install step", () => {
  assert.equal(spec.sandbox.image, `docker.io/vposvistelik/sbx-kit-pi:${packageMetadata.version}`);
  assert.equal(spec.setup, undefined);
});

test("does not create or overwrite user settings", () => {
  assert.equal(spec.setup, undefined);
  assert.doesNotMatch(source, /settings\.json/);
  assert.doesNotMatch(source, /defaultProvider/);
  assert.doesNotMatch(source, /enableInstallTelemetry/);
});

test("shell scripts have valid Bash syntax", () => {
  for (const script of ["run", "container-entrypoint"]) {
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
    ["init", "--help"],
    ["status", "--help"],
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

test("host launcher stages Codex credentials only while creating a sandbox", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-kit-pi-import-auth-"));
  const workspace = path.join(temporary, "project");
  const home = path.join(temporary, "home");
  const stateHome = path.join(temporary, "state");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "sbx.log");
  const codexDir = path.join(home, ".codex");
  const codexAuth = path.join(codexDir, "auth.json");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.mkdirSync(codexDir);
  fs.writeFileSync(codexAuth, '{"tokens":{"access_token":"a","refresh_token":"r"}}\n', {
    mode: 0o600,
  });

  const hash = spawnSync("git", ["hash-object", "--stdin"], {
    input: workspace,
    encoding: "utf8",
  });
  assert.equal(hash.status, 0, hash.stderr);
  const suffix = hash.stdout.trim().slice(0, 12);
  const sandboxName = `pi-openai-codex-project-${suffix}`;
  const sessionDir = path.join(home, "pi-sessions-backup", `project-${suffix}`);
  const importDir = path.join(stateHome, "sbx-kit-pi", "import", sandboxName);
  const importFile = path.join(importDir, "codex-auth.json");

  fs.writeFileSync(
    path.join(bin, "sbx"),
    `#!/usr/bin/env bash\nprintf '<call>\\n' >> "$SBX_LOG"\nprintf '%s\\n' "$@" >> "$SBX_LOG"\nprintf '</call>\\n' >> "$SBX_LOG"\nif [[ $1 == ls ]]; then exit 0; fi\nfound=0\nfor arg in "$@"; do\n  if [[ $arg == */codex-auth.json ]]; then\n    cmp "$arg" "$CODEX_AUTH" || exit 91\n    found=1\n  fi\ndone\n(( found )) || exit 92\n`,
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(path.join(root, "scripts", "run"), ["--import-codex-auth"], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: stateHome,
        PATH: `${bin}:${process.env.PATH}`,
        CODEX_AUTH: codexAuth,
        SBX_LOG: log,
        SBX_PI_HOST_RPC_ALLOW: "off",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const calls = fs
      .readFileSync(log, "utf8")
      .split("<call>\n")
      .slice(1)
      .map((call) => call.slice(0, call.indexOf("</call>\n")).trimEnd().split("\n"));
    assert.deepEqual(calls, [
      ["ls", "-q"],
      [
        "run",
        "--name",
        sandboxName,
        "--kit",
        root,
        "pi-openai-codex",
        workspace,
        sessionDir,
        importDir,
        "--",
        "--session-dir",
        sessionDir,
        "--sbx-pi-import-codex-auth",
        importFile,
      ],
    ]);
    assert.equal(fs.existsSync(importFile), false);
    assert.equal(
      fs.readFileSync(codexAuth, "utf8"),
      '{"tokens":{"access_token":"a","refresh_token":"r"}}\n',
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("host launcher automatically attaches to the current workspace sandbox", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-kit-pi-attach-"));
  const workspace = path.join(temporary, "project");
  const home = path.join(temporary, "home");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "sbx.log");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  fs.mkdirSync(bin);

  const hash = spawnSync("git", ["hash-object", "--stdin"], {
    input: workspace,
    encoding: "utf8",
  });
  assert.equal(hash.status, 0, hash.stderr);
  const suffix = hash.stdout.trim().slice(0, 12);
  const sandboxName = `pi-openai-codex-project-${suffix}`;
  const sessionDir = path.join(home, "pi-sessions-backup", `project-${suffix}`);

  fs.writeFileSync(
    path.join(bin, "sbx"),
    `#!/usr/bin/env bash\nprintf '<call>\\n' >> "$SBX_LOG"\nprintf '%s\\n' "$@" >> "$SBX_LOG"\nprintf '</call>\\n' >> "$SBX_LOG"\nif [[ $1 == ls ]]; then printf '%s\\n' "$SBX_LIST"; fi\n`,
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(path.join(root, "scripts", "run"), ["--continue"], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        SBX_LIST: sandboxName,
        SBX_LOG: log,
        SBX_PI_HOST_RPC_ALLOW: "off",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const calls = fs
      .readFileSync(log, "utf8")
      .split("<call>\n")
      .slice(1)
      .map((call) => call.slice(0, call.indexOf("</call>\n")).trimEnd().split("\n"));
    assert.deepEqual(calls, [
      ["ls", "-q"],
      ["run", "--name", sandboxName, "--", "--session-dir", sessionDir, "--continue"],
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("host launcher enables notifications without adding private Pi arguments", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-kit-pi-notification-launcher-"));
  const workspace = path.join(temporary, "project");
  const home = path.join(temporary, "home");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "sbx.log");
  const notifyLog = path.join(temporary, "notify.log");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  fs.mkdirSync(bin);

  const hash = spawnSync("git", ["hash-object", "--stdin"], {
    input: workspace,
    encoding: "utf8",
  });
  assert.equal(hash.status, 0, hash.stderr);
  const suffix = hash.stdout.trim().slice(0, 12);
  const sandboxName = `pi-openai-codex-project-${suffix}`;
  const sessionDir = path.join(home, "pi-sessions-backup", `project-${suffix}`);
  const notificationFile = path.join(sessionDir, ".host-rpc.requests.jsonl");

  fs.writeFileSync(
    path.join(bin, "notify-send"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$NOTIFY_LOG"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "sbx"),
    `#!/usr/bin/env bash\nprintf '<call>\\n' >> "$SBX_LOG"\nprintf '%s\\n' "$@" >> "$SBX_LOG"\nprintf '</call>\\n' >> "$SBX_LOG"\nif [[ $1 == ls ]]; then\n  printf '%s\\n' "$SBX_LIST"\nelif [[ $1 == run ]]; then\n  [[ -f $NOTIFICATION_FILE ]] || exit 3\n  printf '{"jsonrpc":"2.0","sbxVersion":1,"id":"notify-1","session":"session.jsonl","method":"notification.send","params":{"title":"Pi finished · project","body":"%s"}}\\n' "$SBX_LIST" >> "$NOTIFICATION_FILE"\nfi\n`,
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(path.join(root, "scripts", "run"), [], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        SBX_LIST: sandboxName,
        SBX_LOG: log,
        SBX_PI_HOST_RPC_ALLOW: "notification.send",
        NOTIFICATION_FILE: notificationFile,
        NOTIFY_LOG: notifyLog,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const calls = fs
      .readFileSync(log, "utf8")
      .split("<call>\n")
      .slice(1)
      .map((call) => call.slice(0, call.indexOf("</call>\n")).trimEnd().split("\n"));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ["ls", "-q"]);

    assert.deepEqual(calls[1], ["run", "--name", sandboxName, "--", "--session-dir", sessionDir]);
    assert.deepEqual(fs.readFileSync(notifyLog, "utf8").trimEnd().split("\n"), [
      "--app-name=Pi",
      "--",
      "Pi finished · project",
      sandboxName,
    ]);
    assert.equal(fs.existsSync(notificationFile), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("host launcher recreates the current workspace sandbox with selected mixins", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-kit-pi-update-"));
  const workspace = path.join(temporary, "project");
  const home = path.join(temporary, "home");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "sbx.log");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  fs.mkdirSync(bin);

  const hash = spawnSync("git", ["hash-object", "--stdin"], {
    input: workspace,
    encoding: "utf8",
  });
  assert.equal(hash.status, 0, hash.stderr);
  const sandboxName = `pi-openai-codex-project-${hash.stdout.trim().slice(0, 12)}`;
  const sessionDir = path.join(
    home,
    "pi-sessions-backup",
    `project-${hash.stdout.trim().slice(0, 12)}`,
  );

  const mockSbx = path.join(bin, "sbx");
  fs.writeFileSync(
    mockSbx,
    `#!/usr/bin/env bash\nprintf '<call>\\n' >> "$SBX_LOG"\nprintf '%s\\n' "$@" >> "$SBX_LOG"\nprintf '</call>\\n' >> "$SBX_LOG"\nif [[ $1 == ls ]]; then printf '%s\\n' "$SBX_LIST"; fi\n`,
    { mode: 0o755 },
  );

  try {
    const update = spawnSync(
      path.join(root, "scripts", "run"),
      [
        "--recreate",
        "--kit",
        "docker.io/acme/java-kit:1.1",
        "--kit",
        "./sandbox-kits/project-tools",
        "--continue",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          SBX_LIST: sandboxName,
          SBX_LOG: log,
          SBX_PI_HOST_RPC_ALLOW: "off",
        },
        encoding: "utf8",
      },
    );
    assert.equal(update.status, 0, update.stderr);

    const calls = fs
      .readFileSync(log, "utf8")
      .split("<call>\n")
      .slice(1)
      .map((call) => call.slice(0, call.indexOf("</call>\n")).trimEnd().split("\n"));
    assert.deepEqual(calls, [
      ["ls", "-q"],
      ["rm", "-f", sandboxName],
      [
        "run",
        "--name",
        sandboxName,
        "--kit",
        root,
        "--kit",
        "docker.io/acme/java-kit:1.1",
        "--kit",
        "./sandbox-kits/project-tools",
        "pi-openai-codex",
        workspace,
        sessionDir,
        "--",
        "--session-dir",
        sessionDir,
        "--continue",
      ],
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("host launcher requires recreation before applying mixins to an existing sandbox", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-kit-pi-mixin-"));
  const workspace = path.join(temporary, "project");
  const home = path.join(temporary, "home");
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "sbx.log");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  fs.mkdirSync(bin);

  const hash = spawnSync("git", ["hash-object", "--stdin"], {
    input: workspace,
    encoding: "utf8",
  });
  assert.equal(hash.status, 0, hash.stderr);
  const sandboxName = `pi-openai-codex-project-${hash.stdout.trim().slice(0, 12)}`;

  fs.writeFileSync(
    path.join(bin, "sbx"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "$SBX_LOG"\nif [[ $1 == ls ]]; then printf '%s\\n' "$SBX_LIST"; fi\n`,
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(
      path.join(root, "scripts", "run"),
      ["--kit", "docker.io/acme/java-kit:1.1"],
      {
        cwd: workspace,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          SBX_LIST: sandboxName,
          SBX_LOG: log,
          SBX_PI_HOST_RPC_ALLOW: "off",
        },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /use --recreate to change its kits/);
    assert.equal(fs.readFileSync(log, "utf8"), "ls\n-q\n");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("does not introduce API-key configuration", () => {
  assert.doesNotMatch(source, /OPENAI_API_KEY/);
});
