import test from "node:test";
import type { TestContext } from "node:test";
import type { Preferences, ResolvedConfig, ConfigStatus } from "../scripts/launcher-types.mts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { parse as parseYaml } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-pi-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, "project");
  const subdir = path.join(workspace, "nested");
  const home = path.join(dir, "home");
  const configHome = path.join(dir, "config");
  const bin = path.join(dir, "bin");
  for (const directory of [subdir, home, bin, path.join(configHome, "sbx-pi")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const env: NodeJS.ProcessEnv & {
    HOME: string;
    XDG_CONFIG_HOME: string;
    XDG_STATE_HOME: string;
    MOCK_STATE: string;
    MOCK_LOG: string;
  } = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: path.join(dir, "state"),
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_STATE: path.join(dir, "sandbox"),
    MOCK_LOG: path.join(dir, "log"),
  };
  delete env.SBX_PI_HOST_RPC_ALLOW;
  fs.writeFileSync(
    path.join(bin, "sbx"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'ls') {
  if (fs.existsSync(process.env.MOCK_STATE)) console.log(fs.readFileSync(process.env.MOCK_STATE, 'utf8'));
} else if (args[0] === 'env') {
  if (args[1] === 'rm') fs.rmSync(process.env.MOCK_STATE, { force: true });
  if (args[1] === 'run') {
    if (process.env.MOCK_FAIL) process.exit(1);
    const yaml = require(${JSON.stringify(path.join(root, "node_modules/yaml"))});
    let name;
    for (const arg of args.slice(2)) {
      if (!arg.endsWith('.yaml')) continue;
      const value = yaml.parse(fs.readFileSync(arg, 'utf8'));
      name = value.name ?? name;
      if (process.env.MOCK_CODEX_AUTH && value.additionalWorkspaces?.[1]) {
        const copy = require('node:path').join(value.additionalWorkspaces[1].path, 'codex-auth.json');
        if (fs.readFileSync(copy, 'utf8') !== fs.readFileSync(process.env.MOCK_CODEX_AUTH, 'utf8')) process.exit(91);
        if ((fs.statSync(copy).mode & 0o777) !== 0o600) process.exit(92);
      }
    }
    fs.writeFileSync(process.env.MOCK_STATE, name || 'parameterized-name');
  }
}
`,
    { mode: 0o755 },
  );
  const manifest = path.join(workspace, "sbx-pi.toml");
  const global = path.join(configHome, "sbx-pi", "global.toml");
  const run = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(path.join(root, "scripts/run"), args, {
      cwd: subdir,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
  const show = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}): ResolvedConfig => {
    const result = run(["config-show", ...args], overrides);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const status = (): ConfigStatus => {
    const result = run(["status-show"]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const calls = (): string[][] =>
    fs
      .readFileSync(env.MOCK_LOG, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
  return { dir, workspace, subdir, manifest, global, env, run, show, status, calls };
}

test("host RPC policy is global-only with per-launch environment overrides", (t) => {
  const f = fixture(t);
  assert.equal(f.show().hostRpcAllow, "notification.send,network.request,file.access");
  assert.equal(f.show([], { SBX_PI_HOST_RPC_ALLOW: "git.commit" }).hostRpcAllow, "git.commit");
  fs.writeFileSync(f.global, 'schema_version = 1\n[host_rpc]\nallow = ["git.commit"]\n');
  assert.equal(f.show().hostRpcAllow, "git.commit");
  fs.writeFileSync(f.global, 'schema_version = 1\n[host_rpc]\nallow = ["network.request"]\n');
  assert.equal(f.show().hostRpcAllow, "network.request");
  assert.equal(
    f.show([], { SBX_PI_HOST_RPC_ALLOW: "notification.send" }).hostRpcAllow,
    "notification.send",
  );
  for (const value of ["off", ""]) {
    assert.equal(f.show([], { SBX_PI_HOST_RPC_ALLOW: value }).hostRpcAllow, "off");
  }
  assert.notEqual(f.run(["config-show"], { SBX_PI_HOST_RPC_ALLOW: "shell.run" }).status, 0);
  fs.writeFileSync(f.global, "schema_version = 1\n[host_rpc]\nallow = []\n");
  assert.equal(f.show().hostRpcAllow, "off");
  assert.equal(f.run().status, 0);
  assert.equal(fs.existsSync(path.join(f.env.XDG_STATE_HOME, "sbx-pi", "host-rpc")), false);
  fs.writeFileSync(f.manifest, "schema_version = 1\n[host_rpc]\nallow = []\n");
  assert.match(
    f.run(["config-show", "--config", "../sbx-pi.toml"]).stderr,
    /unknown setting host_rpc/,
  );
  fs.rmSync(f.manifest);
  for (const allow of ['["shell.run"]', '"off"']) {
    fs.writeFileSync(f.global, `schema_version = 1\n[host_rpc]\nallow = ${allow}\n`);
    assert.match(f.run(["config-show"]).stderr, /host_rpc must contain/);
  }
});

test("host RPC commands use global defaults and resolve relative executables outside the workspace", (t) => {
  const f = fixture(t);
  const defaults = f.show().hostRpcHandlers;
  assert.deepEqual(Object.keys(defaults), [
    "notification.send",
    "network.request",
    "file.access",
    "git.commit",
  ]);
  fs.writeFileSync(
    f.global,
    `schema_version = 1
[host_rpc.handlers]
"network.request" = [["default"], ["./review", "fixed argument"]]
"notification.send" = [["node", "./notify.mjs"]]
`,
  );
  const config = f.show();
  assert.equal(config.hostRpcHandlerCwd, path.dirname(f.global));
  assert.deepEqual(config.hostRpcHandlers["network.request"], [
    ...defaults["network.request"],
    [path.join(path.dirname(f.global), "review"), "fixed argument"],
  ]);
  assert.deepEqual(config.hostRpcHandlers["notification.send"], [["node", "./notify.mjs"]]);
  assert.deepEqual(config.hostRpcHandlers["file.access"], defaults["file.access"]);
  assert.equal(config.hostRpcAllow, "notification.send,network.request,file.access");
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  assert.equal(f.run(["alias-set", "node", "docker.io/acme/node:1"]).status, 0);
  assert.deepEqual(f.show().hostRpcHandlers, config.hostRpcHandlers);
  for (const table of [
    '"shell.run" = [["default"]]',
    '"git.commit" = [["default"], ["default"]]',
    '"network.request" = []',
    '"network.request" = ["./script"]',
    '"network.request" = [[""]]',
    '"network.request" = [["default", "extra"]]',
    '"network.request" = [["command\\nargument"]]',
  ]) {
    fs.writeFileSync(f.global, `schema_version = 1\n[host_rpc.handlers]\n${table}\n`);
    assert.equal(f.run(["config-show"]).status, 2, table);
  }
});

test("launcher connects configured consumers to the queue, including shutdown drain", (t) => {
  const f = fixture(t);
  const script = path.join(path.dirname(f.global), "consumer.mjs");
  const output = path.join(f.dir, "received.json");
  fs.writeFileSync(
    script,
    `
import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
fs.writeFileSync(${JSON.stringify(output)}, input);
console.log(JSON.stringify({ status: 'recorded' }));
`,
  );
  fs.writeFileSync(
    f.global,
    `schema_version = 1
[host_rpc]
allow = ["network.request"]
[host_rpc.handlers]
"network.request" = [["node", "./consumer.mjs"]]
`,
  );
  fs.writeFileSync(
    path.join(f.dir, "bin/sbx"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === 'env' && process.argv[3] === 'exec') {
  const base = path.join(process.env.HOME, 'pi-sessions-backup');
  const queue = path.join(base, fs.readdirSync(base)[0], '.host-rpc.requests.jsonl');
  fs.appendFileSync(queue, JSON.stringify({ jsonrpc: '2.0', sbxVersion: 1, id: 'consumer-test', session: 'test.jsonl', method: 'network.request', params: { host: 'example.com', reason: 'Review' } }) + '\\n');
}
`,
    { mode: 0o755 },
  );
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const received = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(received.request.id, "consumer-test");
  assert.equal(received.context.workspace, f.subdir);
  assert.equal(received.context.sandbox, f.show().sandboxName);
});

test("alias writes preserve global host policy", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.global, 'schema_version = 1\n[host_rpc]\nallow = ["file.access"]\n');
  assert.equal(f.run(["alias-set", "node", "docker.io/acme/node:1"]).status, 0);
  assert.equal(f.show().hostRpcAllow, "file.access");
});

test("alias-set saves global aliases without invoking sbx", (t) => {
  const f = fixture(t);
  const result = f.run(["alias-set", "node", "docker.io/acme/node:1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved @node/);
  assert.deepEqual(
    { ...(parse(fs.readFileSync(f.global, "utf8")) as unknown as Preferences).kit_aliases },
    { node: "docker.io/acme/node:1" },
  );
  assert.equal(fs.statSync(f.global).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("alias-set preserves global settings, resolves CLI paths, and requires explicit replacement", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.global,
    'schema_version = 1\n[host_rpc]\nallow = []\n[kit_aliases]\nnode = "docker.io/acme/node:1"',
  );
  const original = fs.readFileSync(f.global, "utf8");
  const refused = f.run(["alias-set", "node", "docker.io/acme/node:2"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /already exists; use --replace/);
  assert.equal(fs.readFileSync(f.global, "utf8"), original);
  const replaced = f.run(["alias-set", "node", "docker.io/acme/node:2", "--replace"]);
  assert.equal(replaced.status, 0, replaced.stderr);
  const local = f.run(["alias-set", "local", './kits/tools "quoted"']);
  assert.equal(local.status, 0, local.stderr);
  const config = parse(fs.readFileSync(f.global, "utf8")) as unknown as Preferences;
  assert.deepEqual(config.host_rpc?.allow, []);
  assert.equal(config.kit_aliases?.node, "docker.io/acme/node:2");
  assert.equal(config.kit_aliases?.local, path.join(f.subdir, 'kits/tools "quoted"'));
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  assert.equal(fs.existsSync(`${f.global}.lock`), false);
});

test("alias-set validates arguments and configuration without changing existing files", (t) => {
  const f = fixture(t);
  const original = "schema_version = 1\n[host_rpc]\nallow = []";
  fs.writeFileSync(f.global, original);
  for (const args of [
    [],
    ["node"],
    ["@node", "kit"],
    ["bad.name", "kit"],
    ["node", "@other"],
    ["node", ""],
    ["node", "bad\nkit"],
    ["node", "kit", "extra"],
    ["node", "kit", "--replace", "--replace"],
    ["--kit", "kit"],
  ]) {
    assert.equal(f.run(["alias-set", ...args]).status, 2, JSON.stringify(args));
    assert.equal(fs.readFileSync(f.global, "utf8"), original);
  }
  for (const source of [
    "invalid TOML",
    "schema_version = 2",
    "schema_version = 1\nunknown = true",
  ]) {
    fs.writeFileSync(f.global, source);
    assert.equal(f.run(["alias-set", "node", "kit"]).status, 2);
    assert.equal(fs.readFileSync(f.global, "utf8"), source);
    assert.equal(fs.existsSync(`${f.global}.lock`), false);
  }
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("alias-set refuses locked files and symlinks without touching their targets", (t) => {
  const f = fixture(t);
  fs.writeFileSync(`${f.global}.lock`, "another writer");
  assert.equal(f.run(["alias-set", "node", "kit"]).status, 2);
  assert.equal(fs.readFileSync(`${f.global}.lock`, "utf8"), "another writer");
  assert.equal(fs.existsSync(f.global), false);
  fs.rmSync(`${f.global}.lock`);
  const target = path.join(f.dir, "target.toml");
  fs.writeFileSync(target, "schema_version = 1");
  fs.symlinkSync(target, f.global);
  assert.equal(f.run(["alias-set", "node", "kit"]).status, 2);
  assert.equal(fs.readlinkSync(f.global), target);
  assert.equal(fs.readFileSync(target, "utf8"), "schema_version = 1");
  assert.equal(fs.existsSync(`${f.global}.lock`), false);
});

test("first launch saves a native environment; later launches reuse it without rewriting", (t) => {
  const f = fixture(t);
  const file = path.join(f.subdir, "sbxenv.yaml");
  assert.equal(fs.existsSync(file), false);
  const result = f.run([], { SBX_PI_HOST_RPC_ALLOW: "off" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Created/);
  const content = fs.readFileSync(file, "utf8");
  assert.deepEqual(parseYaml(content), {
    schemaVersion: "1",
    agent: path.basename(root),
    workspace: ".",
    kits: [],
  });
  assert.equal(fs.existsSync(path.join(f.subdir, "sbx-pi.toml")), false);
  assert.equal(parseYaml(content).host_rpc, undefined);
  const modified = fs.statSync(file).mtimeMs;
  const again = f.run(["--continue"], { SBX_PI_HOST_RPC_ALLOW: "off" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), content);
  assert.equal(fs.statSync(file).mtimeMs, modified);
  assert.equal(
    f.calls().some((call) => call[0] === "run" || call[1] === "rm"),
    false,
  );
  assert.deepEqual(f.calls().at(-1)?.slice(-1), ["--continue"]);
  assert.equal(f.status().status, "exists");
});

test("launch expands aliases and saves portable kit references for subsequent launches", (t) => {
  const f = fixture(t);
  const localKit = path.join(f.subdir, "kits", 'tools "quoted"');
  fs.mkdirSync(localKit, { recursive: true });
  const remote = "git+https://github.com/acme/kits.git#ref=v1.2.0&dir=node";
  fs.writeFileSync(
    f.global,
    `schema_version = 1\n[kit_aliases]\nnode = "docker.io/acme/node:1"\nlocal = ${JSON.stringify(localKit)}\n`,
  );
  const result = f.run([
    "--kit",
    "@node",
    "--kit",
    "@local",
    "--kit",
    remote,
    "--kit",
    "./kits/project",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const config = parseYaml(fs.readFileSync(path.join(f.subdir, "sbxenv.yaml"), "utf8"));
  assert.deepEqual(
    { ...config },
    {
      schemaVersion: "1",
      agent: path.basename(root),
      workspace: ".",
      kits: ["docker.io/acme/node:1", './kits/tools "quoted"', remote, "./kits/project"],
    },
  );
  assert.deepEqual(f.show().environmentFiles, [path.join(f.subdir, "sbxenv.yaml")]);
  const file = path.join(f.subdir, "sbxenv.yaml");
  const saved = fs.readFileSync(file, "utf8");
  fs.rmSync(f.global);
  assert.equal(f.run([], { SBX_PI_HOST_RPC_ALLOW: "off" }).status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), saved);
});

test("kit edits refuse malformed YAML, directories, symlinks, and locks without modifying data", (t) => {
  const f = fixture(t);
  const file = path.join(f.subdir, "sbxenv.yaml");
  const original = "not even valid YAML: [";
  fs.writeFileSync(file, original);
  assert.equal(f.run(["--kit", "tools"]).status, 2);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(f.run(["--kit", "tools"]).status, 2);
  assert.ok(fs.statSync(file).isDirectory());
  fs.rmdirSync(file);
  for (const exists of [false, true]) {
    const target = path.join(f.dir, "target.yaml");
    if (exists) {
      fs.writeFileSync(target, 'schemaVersion: "1"\nworkspace: .\n');
    }
    fs.symlinkSync(target, file);
    assert.equal(f.run(["--kit", "tools"]).status, 2);
    assert.equal(fs.readlinkSync(file), target);
    if (exists) {
      assert.equal(fs.readFileSync(target, "utf8"), 'schemaVersion: "1"\nworkspace: .\n');
    } else {
      assert.equal(fs.existsSync(target), false);
    }
    fs.unlinkSync(file);
  }
  fs.writeFileSync(`${file}.lock`, "another writer");
  assert.equal(f.run(["--kit", "tools"]).status, 2);
  assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), "another writer");
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("launch rejects invalid kit references before creating configuration or invoking Docker", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.global, 'schema_version = 1\n[kit_aliases]\nhost = "./private-tools"');
  for (const args of [
    ["--kit", "@host"],
    ["--kit", "../outside"],
    ["--kit", path.join(f.dir, "host-tools")],
    ["--kit", "@missing"],
    ["--kit", "bad\nkit"],
    ["--kit", "--recreate"],
    ["--kit"],
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(fs.existsSync(path.join(f.subdir, "sbxenv.yaml")), false);
  }
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("inspection never creates project configuration and rejects mutation options", (t) => {
  const f = fixture(t);
  const file = path.join(f.subdir, "sbxenv.yaml");
  assert.equal(f.show().workspace, f.subdir);
  assert.equal(f.status().status, "not-created");
  assert.equal(f.run(["plan-show"]).status, 2);
  for (const command of [["config-show"], ["status-show"], ["plan-show"]]) {
    for (const option of [["--kit", "tools"], ["--no-kits"]]) {
      const result = f.run([...command, ...option]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /only accepted when launching/);
    }
  }
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(f.env.XDG_STATE_HOME), false);
  assert.equal(fs.existsSync(path.join(f.env.HOME, "pi-sessions-backup")), false);
  assert.deepEqual(f.calls(), [["ls", "-q"]]);
});

test("installed user command resolves configuration from a different project", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, "schema_version = 1");
  const bindir = path.join(f.dir, "installed-bin");
  const install = spawnSync("make", ["install", `BINDIR=${bindir}`], {
    cwd: root,
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr);
  const result = spawnSync(path.join(bindir, "sbx-pi"), ["config-show"], {
    cwd: f.subdir,
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).workspace, f.workspace);
  const uninstall = spawnSync("make", ["uninstall", `BINDIR=${bindir}`], {
    cwd: root,
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(fs.existsSync(path.join(bindir, "sbx-pi")), false);
});

test("kit edits use the discovered project root, resolving CLI paths from the invocation directory", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, "schema_version = 1\n");
  assert.equal(f.show().workspace, f.workspace);
  assert.equal(f.show(["--config", "../sbx-pi.toml"]).workspace, f.workspace);
  const result = f.run(["--kit", "./tools"], { SBX_PI_HOST_RPC_ALLOW: "off" });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(f.workspace, "sbxenv.yaml");
  assert.deepEqual(parseYaml(fs.readFileSync(file, "utf8")).kits, ["./nested/tools"]);
  assert.equal(fs.existsSync(path.join(f.subdir, "sbxenv.yaml")), false);
});

test("validates manifests and aliases before invoking Docker Sandbox", (t) => {
  const f = fixture(t);
  for (const source of [
    "schema_version = 2",
    'schema_version = 1\nkits = "node"',
    'schema_version = 1\nnotifications = "auto"',
    'schema_version = 1\ncommand = "touch /tmp/no"',
    'schema_version = 1\nkits = ["@missing"]',
    "schema_version = [",
    'schema_version = 1\nkits = ["bad\\u0000ref"]',
  ]) {
    fs.writeFileSync(f.manifest, source);
    const result = f.run();
    assert.equal(result.status, 2, source);
    assert.match(result.stderr, /sbx-pi:/);
  }
  fs.writeFileSync(f.manifest, "schema_version = 1");
  fs.writeFileSync(f.global, 'schema_version = 1\n[kit_aliases]\na = "@b"');
  assert.match(f.run().stderr, /aliases cannot reference aliases/);
  fs.rmSync(f.global);
  assert.equal(f.run(["--config", "../sbx-pi.toml", "--env", ".."]).status, 2);
  assert.equal(f.run([], { SBX_PI_HOST_RPC_ALLOW: "__proto__" }).status, 2);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("kit replacement persists before refusing to change an existing sandbox without recreation", (t) => {
  const f = fixture(t);
  const file = path.join(f.subdir, "sbxenv.yaml");
  assert.equal(f.run(["--kit", "docker.io/acme/node:1"]).status, 0);
  const before = f.calls().length;
  const result = f.run(["--kit", "docker.io/acme/node:2", "--kit", "./tools"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Kit selection saved.*--recreate/);
  assert.deepEqual(parseYaml(fs.readFileSync(file, "utf8")).kits, [
    "docker.io/acme/node:2",
    "./tools",
  ]);
  assert.deepEqual(f.calls().slice(before), [["ls", "-q"]]);
  const recreated = f.run(["--recreate"]);
  assert.equal(recreated.status, 0, recreated.stderr);
  assert.equal(f.calls().filter((call) => call[0] === "env" && call[1] === "rm").length, 1);
  const cleared = f.run(["--recreate", "--no-kits"]);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(parseYaml(fs.readFileSync(file, "utf8")).kits, []);
  assert.equal(f.run().status, 0);
  assert.deepEqual(parseYaml(fs.readFileSync(file, "utf8")).kits, []);
});

test("kit edits preserve unrelated YAML settings, comments, and file permissions", (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, "sbxenv.yaml");
  const source =
    '# Project configuration\nschemaVersion: "1"\nworkspace: . # keep this comment\nports: [{sandbox: 3000, host: 8080}]\nkits:\n  - source: ./old-kit\n    args: {version: pinned}\n';
  fs.writeFileSync(file, source, { mode: 0o600 });
  // Editing from a more restrictive shell must not change existing permissions.
  fs.chmodSync(file, 0o640);
  const result = spawnSync(
    "bash",
    [
      "-c",
      'umask 077; exec "$@"',
      "test",
      path.join(root, "scripts/run"),
      "--kit",
      "./tools",
      "--kit",
      "docker.io/acme/node:2",
    ],
    { cwd: f.subdir, env: f.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const saved = fs.readFileSync(file, "utf8");
  assert.match(saved, /# Project configuration/);
  assert.match(saved, /# keep this comment/);
  assert.deepEqual(parseYaml(saved), {
    ...parseYaml(source),
    kits: ["./nested/tools", "docker.io/acme/node:2"],
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  const modified = fs.statSync(file).mtimeMs;
  const same = f.run(["--kit", "./tools", "--kit", "docker.io/acme/node:2"]);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(fs.statSync(file).mtimeMs, modified);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("an explicit single environment file receives kit edits instead of the invocation directory", (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, "custom.yaml");
  fs.writeFileSync(file, 'schemaVersion: "1"\nworkspace: ./src\n');
  const result = f.run(["--env", "../custom.yaml", "--kit", "./tools"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseYaml(fs.readFileSync(file, "utf8")), {
    schemaVersion: "1",
    workspace: "./src",
    kits: ["./nested/tools"],
  });
  assert.equal(fs.existsSync(path.join(f.subdir, "sbxenv.yaml")), false);
});

test("layered kit edits fail without rewriting any layer or invoking Docker", (t) => {
  const f = fixture(t);
  const base = path.join(f.workspace, "base.yaml");
  const local = path.join(f.workspace, "local.yaml");
  const source = 'schemaVersion: "1"\nkits: [./tools]\n';
  fs.writeFileSync(base, source);
  fs.writeFileSync(local, "env: {LOG_LEVEL: debug}\n");
  for (const option of [["--kit", "tools"], ["--no-kits"]]) {
    const result = f.run(["--env", base, "--env", local, ...option]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /single environment file/);
  }
  assert.equal(fs.readFileSync(base, "utf8"), source);
  assert.equal(fs.readFileSync(local, "utf8"), "env: {LOG_LEVEL: debug}\n");
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("parameterized sandbox names require explicit recreation when saving changed kits", (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, "sbxenv.yaml");
  fs.writeFileSync(file, 'schemaVersion: "1"\nname: "${{ env.args.name }}"\nkits: []\n');
  const result = f.run(["--kit", "tools"], { SBX_PI_HOST_RPC_ALLOW: "off" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Kit selection saved.*--recreate/);
  assert.deepEqual(parseYaml(fs.readFileSync(file, "utf8")).kits, ["tools"]);
  assert.deepEqual(f.calls(), [["ls", "-q"]]);
});

test("launcher delivers default notifications without private Pi arguments", (t) => {
  const f = fixture(t);
  const output = path.join(f.dir, "notification.json");
  fs.writeFileSync(
    path.join(f.dir, "bin/notify-send"),
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(f.dir, "bin/sbx"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === 'env' && process.argv[3] === 'exec') {
  const base = path.join(process.env.HOME, 'pi-sessions-backup');
  const queue = path.join(base, fs.readdirSync(base)[0], '.host-rpc.requests.jsonl');
  fs.appendFileSync(queue, JSON.stringify({ jsonrpc: '2.0', sbxVersion: 1, id: 'notify-test', session: 'test.jsonl', method: 'notification.send', params: { title: 'Pi finished', body: 'Done' } }) + '\\n');
  if (process.argv.some((arg) => arg.startsWith('--sbx-pi-'))) process.exit(93);
}
`,
    { mode: 0o755 },
  );
  const result = f.run([], { SBX_PI_HOST_RPC_ALLOW: "notification.send" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), [
    "--app-name=Pi",
    "--",
    "Pi finished",
    "Done",
  ]);
});

test("native YAML owns sandbox settings while TOML supplies only Pi preferences", (t) => {
  const f = fixture(t);
  const environment = path.join(f.workspace, "sbxenv.yaml");
  const source = `schemaVersion: "1"
name: native-project
agent: ${path.basename(root)}
workspace:
  path: ./src
  clone: true
kits:
  - source: ./kits/tools
    args:
      version: pinned
additionalWorkspaces:
  - path: ../reference docs
    readOnly: true
env:
  LOG_LEVEL: debug
ports:
  - sandbox: 3000
    host: 8080
sandboxOptions:
  cpus: 2
  memory: 4g
lifecycle:
  initialize:
    - command: ./setup.sh
`;
  fs.writeFileSync(environment, source);
  fs.writeFileSync(f.manifest, "schema_version = 1");
  const config = f.show();
  assert.equal(config.sandboxName, "native-project");
  assert.equal(config.workspace, f.workspace);
  assert.deepEqual(config.environmentFiles, [environment]);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  const result = f.run(["--continue", "prompt with spaces"]);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const provision = calls.find((args) => args[0] === "env" && args[1] === "run");
  assert.ok(provision);
  assert.equal(provision[2], environment);
  assert.equal(provision.at(-1), "--detach");
  assert.equal(provision.includes("--force"), false);
  const overlayFile = provision[3];
  const overlay = parseYaml(fs.readFileSync(overlayFile, "utf8"));
  assert.equal(overlay.workspace, undefined, "do not override native workspace or clone mode");
  assert.equal(overlay.name, undefined, "do not override native name");
  assert.deepEqual(overlay.kits, [root]);
  assert.equal(overlay.additionalWorkspaces.length, 1);
  assert.match(overlay.additionalWorkspaces[0].path, /pi-sessions-backup/);
  assert.equal(fs.statSync(overlayFile).mode & 0o777, 0o600);
  assert.equal(overlayFile.startsWith(f.workspace + path.sep), false);
  const attach = calls.find((args) => args[0] === "env" && args[1] === "exec");
  assert.ok(attach);
  assert.ok(attach.includes("/opt/sbx-kit-pi/scripts/container-entrypoint"));
  assert.ok(attach.includes("--session-dir"));
  assert.deepEqual(attach.slice(-2), ["--continue", "prompt with spaces"]);
  assert.equal(
    calls.some((args) => args[0] === "run"),
    false,
  );
  assert.equal(fs.readFileSync(environment, "utf8"), source);
  assert.equal(f.status().status, "exists");
  const second = f.run();
  assert.equal(second.status, 0, second.stderr);
  const lastProvision = f
    .calls()
    .filter((args) => args[0] === "env" && args[1] === "run")
    .at(-1);
  assert.ok(lastProvision);
  assert.equal(lastProvision[3], overlayFile);
});

test("explicit native layers and arguments are passed to Docker without local expansion", (t) => {
  const f = fixture(t);
  const base = path.join(f.workspace, "base.yaml");
  const local = path.join(f.workspace, "local.yaml");
  const argsFile = path.join(f.subdir, "environment.args");
  fs.writeFileSync(
    base,
    'schemaVersion: "1"\nagent: ' +
      path.basename(root) +
      '\nworkspace: "${{ env.projectDir }}/src"\n',
  );
  fs.writeFileSync(local, 'name: "${{ env.args.name }}"\nargs:\n  name:\n    required: true\n');
  fs.writeFileSync(argsFile, "name=custom\n");
  const args = [
    "--env",
    "../base.yaml",
    "--env",
    "../local.yaml",
    "--env-arg",
    "name=custom",
    "--env-args-file",
    "environment.args",
  ];
  const config = f.show(args);
  assert.deepEqual(config.environmentFiles, [base, local]);
  assert.equal(config.sandboxName, null, "Docker resolves parameterized names");
  assert.deepEqual(config.nativeArguments, [
    "--env-arg",
    "name=custom",
    "--env-args-file",
    argsFile,
  ]);
  const result = f.run(args);
  assert.equal(result.status, 0, result.stderr);
  for (const call of f.calls().filter((call) => call[0] === "env")) {
    assert.ok(call.includes(base));
    assert.ok(call.includes(local));
    assert.ok(call.includes(argsFile));
    assert.equal(call.includes("--name"), false);
    assert.ok(call.indexOf(base) < call.indexOf(local));
  }
});

test("plan-show delegates to Docker without starting Pi or creating session directories", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, "sbxenv.yaml"), 'schemaVersion: "1"\n');
  const result = f.run(["plan-show"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(f.env.HOME, "pi-sessions-backup")), false);
  assert.equal(fs.existsSync(f.env.MOCK_STATE), false);
  assert.deepEqual(
    f.calls().map((call) => call.slice(0, 2)),
    [["env", "plan"]],
  );
  const overlay = parseYaml(fs.readFileSync(f.calls()[0][3], "utf8"));
  assert.equal(overlay.workspace, undefined, "native workspace omission must remain mountless");
  assert.match(overlay.name, /^pi-openai-codex-project-/);
  assert.equal(overlay.agent, path.basename(root));
});

test("native recreation delegates resource cleanup and does not attach after provisioning fails", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, "sbxenv.yaml"), 'schemaVersion: "1"\n');
  assert.equal(f.run([], { SBX_PI_HOST_RPC_ALLOW: "off" }).status, 0);
  const recreated = f.run(["--recreate"], { SBX_PI_HOST_RPC_ALLOW: "off" });
  assert.equal(recreated.status, 0, recreated.stderr);
  const removal = f.calls().find((call) => call[0] === "env" && call[1] === "rm");
  assert.ok(removal);
  assert.equal(removal.at(-1), "--force");
  assert.equal(
    f.calls().some((call) => call[0] === "rm"),
    false,
  );
  const count = f.calls().filter((call) => call[0] === "env" && call[1] === "exec").length;
  const failed = f.run(["--recreate"], { MOCK_FAIL: "1", SBX_PI_HOST_RPC_ALLOW: "off" });
  assert.equal(failed.status, 1);
  assert.equal(f.calls().filter((call) => call[0] === "env" && call[1] === "exec").length, count);
});

test("supplemental allowed hosts become sandbox-only permissions and require recreation", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, "sbxenv.yaml"), 'schemaVersion: "1"\n');
  fs.writeFileSync(
    f.manifest,
    'schema_version = 1\n[network]\nallow = ["api.github.com", "registry.npmjs.org"]',
  );
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const provision = f.calls().find((call) => call[0] === "env" && call[1] === "run");
  assert.ok(provision);
  const overlay = parseYaml(fs.readFileSync(provision[3], "utf8"));
  assert.equal(fs.existsSync(path.join(overlay.kits[1], "spec.yaml")), false);
  const kit = parseYaml(fs.readFileSync(path.join(overlay.kits[1], "network-policy.yaml"), "utf8"));
  assert.equal(kit.kind, "mixin");
  assert.equal(kit.schemaVersion, "3");
  assert.deepEqual(kit.capabilities, [
    {
      type: "com.docker.sandbox/network-policy@1",
      config: {
        install: { allow: ["api.github.com", "registry.npmjs.org"] },
        runtime: { allow: ["api.github.com", "registry.npmjs.org"] },
      },
    },
  ]);
  assert.equal(kit.setup, undefined);
  assert.equal(
    f.calls().some((call) => call[0] === "policy"),
    false,
  );
  assert.equal(f.run(["--allow-host", "other.example"]).status, 2);
  fs.writeFileSync(f.manifest, 'schema_version = 1\n[network]\nallow = ["other.example"]');
  const attached = f.run();
  assert.equal(attached.status, 0, attached.stderr);
  assert.match(attached.stderr, /supplemental network settings changed/);
  const recreated = f.run(["--recreate"]);
  assert.equal(recreated.status, 0, recreated.stderr);
  const current = parseYaml(
    fs.readFileSync(path.join(overlay.kits[1], "network-policy.yaml"), "utf8"),
  );
  assert.deepEqual(current.capabilities[0].config, {
    install: { allow: ["other.example"] },
    runtime: { allow: ["other.example"] },
  });
  fs.writeFileSync(f.manifest, 'schema_version = 1\n[network]\nallow = "invalid"');
  assert.equal(f.run().status, 2);
});

test("native Codex import mounts only a temporary private copy and is creation-only", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, "sbxenv.yaml"), 'schemaVersion: "1"\n');
  const codexHome = path.join(f.dir, "codex");
  fs.mkdirSync(codexHome);
  const auth = JSON.stringify({
    tokens: { access_token: "private-token", refresh_token: "private-refresh" },
  });
  fs.writeFileSync(path.join(codexHome, "auth.json"), auth);
  const result = f.run(["--import-codex-auth"], {
    CODEX_HOME: codexHome,
    MOCK_CODEX_AUTH: path.join(codexHome, "auth.json"),
    SBX_PI_HOST_RPC_ALLOW: "off",
  });
  assert.equal(result.status, 0, result.stderr);
  const provision = f.calls().find((call) => call[0] === "env" && call[1] === "run");
  assert.ok(provision);
  const content = fs.readFileSync(provision[3], "utf8");
  assert.equal(content.includes("private-token"), false);
  const mounts = parseYaml(content).additionalWorkspaces;
  assert.equal(mounts[1].readOnly, undefined, "entrypoint must be able to remove the private copy");
  assert.notEqual(mounts[1].path, codexHome);
  assert.equal(fs.existsSync(path.join(mounts[1].path, "codex-auth.json")), false);
  assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), auth);
  const refused = f.run(["--import-codex-auth"], { CODEX_HOME: codexHome });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /use --recreate to import/);
  const failed = f.run(["--recreate", "--import-codex-auth"], {
    CODEX_HOME: codexHome,
    MOCK_FAIL: "1",
    SBX_PI_HOST_RPC_ALLOW: "off",
  });
  assert.equal(failed.status, 1);
  assert.equal(fs.existsSync(path.join(mounts[1].path, "codex-auth.json")), false);
  assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), auth);
  assert.equal(fs.existsSync(f.show().stateFile), false);
});

test("projects reject TOML kits and unsupported agents before Docker without rewriting files", (t) => {
  const f = fixture(t);
  const environment = path.join(f.workspace, "sbxenv.yaml");
  fs.writeFileSync(environment, `schemaVersion: "1"\nagent: ${path.basename(root)}\n`);
  fs.writeFileSync(f.manifest, "schema_version = 1\nkits = []");
  assert.match(f.run().stderr, /unknown setting kits/);
  fs.writeFileSync(f.manifest, "schema_version = 1");
  for (const agent of ["claude", "pi-openai-codex"]) {
    const source = `schemaVersion: "1"\nagent: ${agent}\n`;
    fs.writeFileSync(environment, source);
    assert.match(f.run(["--kit", "tools"]).stderr, /use sbx env for other agents/);
    assert.equal(fs.readFileSync(environment, "utf8"), source);
  }
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});
