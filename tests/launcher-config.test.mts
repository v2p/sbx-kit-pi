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
} else if (args[0] === 'rm') fs.rmSync(process.env.MOCK_STATE, { force: true });
else if (args[0] === 'run') {
  if (process.env.MOCK_FAIL) process.exit(1);
  fs.writeFileSync(process.env.MOCK_STATE, args[args.indexOf('--name') + 1]);
} else if (args[0] === 'env') {
  if (args[1] === 'rm') fs.rmSync(process.env.MOCK_STATE, { force: true });
  if (args[1] === 'run') {
    if (process.env.MOCK_FAIL) process.exit(1);
    const yaml = require(${JSON.stringify(path.join(root, "node_modules/yaml"))});
    let name;
    for (const arg of args.slice(2)) {
      if (arg.endsWith('.yaml')) name = yaml.parse(fs.readFileSync(arg, 'utf8')).name ?? name;
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
    const result = run(["config", "show", ...args], overrides);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const status = (): ConfigStatus => {
    const result = run(["status"]);
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
  fs.writeFileSync(f.global, 'schema_version = 1\n[host_rpc]\nallow = ["network.request"]\n');
  assert.equal(f.show().hostRpcAllow, "network.request");
  assert.equal(
    f.show([], { SBX_PI_HOST_RPC_ALLOW: "notification.send" }).hostRpcAllow,
    "notification.send",
  );
  for (const value of ["off", ""]) {
    assert.equal(f.show([], { SBX_PI_HOST_RPC_ALLOW: value }).hostRpcAllow, "off");
  }
  assert.notEqual(f.run(["config", "show"], { SBX_PI_HOST_RPC_ALLOW: "shell.run" }).status, 0);
  fs.writeFileSync(f.global, "schema_version = 1\n[host_rpc]\nallow = []\n");
  assert.equal(f.show().hostRpcAllow, "off");
  assert.equal(f.run().status, 0);
  assert.equal(fs.existsSync(path.join(f.env.XDG_STATE_HOME, "sbx-pi", "host-rpc")), false);
  fs.writeFileSync(f.manifest, "schema_version = 1\n[host_rpc]\nallow = []\n");
  assert.match(f.run(["config", "show"]).stderr, /unknown setting host_rpc/);
  fs.rmSync(f.manifest);
  for (const allow of ['["shell.run"]', '"off"']) {
    fs.writeFileSync(f.global, `schema_version = 1\n[host_rpc]\nallow = ${allow}\n`);
    assert.match(f.run(["config", "show"]).stderr, /host_rpc must contain/);
  }
});

test("host RPC commands use global defaults and resolve relative executables outside the workspace", (t) => {
  const f = fixture(t);
  const defaults = f.show().hostRpcHandlers;
  assert.deepEqual(Object.keys(defaults), ["notification.send", "network.request", "file.access"]);
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
  assert.equal(f.run(["config", "alias", "node", "docker.io/acme/node:1"]).status, 0);
  assert.deepEqual(f.show().hostRpcHandlers, config.hostRpcHandlers);
  for (const table of [
    '"shell.run" = [["default"]]',
    '"network.request" = []',
    '"network.request" = ["./script"]',
    '"network.request" = [[""]]',
    '"network.request" = [["default", "extra"]]',
    '"network.request" = [["command\\nargument"]]',
  ]) {
    fs.writeFileSync(f.global, `schema_version = 1\n[host_rpc.handlers]\n${table}\n`);
    assert.equal(f.run(["config", "show"]).status, 2, table);
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
if (process.argv[2] === 'run') {
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
  assert.equal(f.run(["config", "alias", "node", "docker.io/acme/node:1"]).status, 0);
  assert.equal(f.show().hostRpcAllow, "file.access");
});

test("config alias creates global aliases usable by show and init without invoking sbx", (t) => {
  const f = fixture(t);
  const result = f.run(["config", "alias", "node", "docker.io/acme/node:1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved @node/);
  assert.deepEqual(
    { ...(parse(fs.readFileSync(f.global, "utf8")) as unknown as Preferences).kit_aliases },
    { node: "docker.io/acme/node:1" },
  );
  assert.equal(fs.statSync(f.global).mode & 0o777, 0o600);
  assert.deepEqual(f.show(["--kit", "@node"]).kits, ["docker.io/acme/node:1"]);
  assert.equal(f.run(["init", "--kit", "@node"]).status, 0);
  const environmentFile = f.show().environmentFiles[0];
  assert.deepEqual(parseYaml(fs.readFileSync(environmentFile, "utf8")).kits, [
    "docker.io/acme/node:1",
  ]);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("config alias preserves global settings, resolves CLI paths, and requires explicit replacement", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.global,
    'schema_version = 1\n[host_rpc]\nallow = []\n[kit_aliases]\nnode = "docker.io/acme/node:1"',
  );
  const original = fs.readFileSync(f.global, "utf8");
  const refused = f.run(["config", "alias", "node", "docker.io/acme/node:2"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /already exists; use --replace/);
  assert.equal(fs.readFileSync(f.global, "utf8"), original);
  const replaced = f.run(["config", "alias", "node", "docker.io/acme/node:2", "--replace"]);
  assert.equal(replaced.status, 0, replaced.stderr);
  const local = f.run(["config", "alias", "local", './kits/tools "quoted"']);
  assert.equal(local.status, 0, local.stderr);
  const config = parse(fs.readFileSync(f.global, "utf8")) as unknown as Preferences;
  assert.deepEqual(config.host_rpc?.allow, []);
  assert.equal(config.kit_aliases?.node, "docker.io/acme/node:2");
  assert.equal(config.kit_aliases?.local, path.join(f.subdir, 'kits/tools "quoted"'));
  assert.deepEqual(f.show(["--kit", "@local"]).kits, [config.kit_aliases?.local]);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  assert.equal(fs.existsSync(`${f.global}.lock`), false);
});

test("config alias validates arguments and configuration without changing existing files", (t) => {
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
    assert.equal(f.run(["config", "alias", ...args]).status, 2, JSON.stringify(args));
    assert.equal(fs.readFileSync(f.global, "utf8"), original);
  }
  for (const source of [
    "invalid TOML",
    "schema_version = 2",
    "schema_version = 1\nunknown = true",
  ]) {
    fs.writeFileSync(f.global, source);
    assert.equal(f.run(["config", "alias", "node", "kit"]).status, 2);
    assert.equal(fs.readFileSync(f.global, "utf8"), source);
    assert.equal(fs.existsSync(`${f.global}.lock`), false);
  }
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("config alias refuses locked files and symlinks without touching their targets", (t) => {
  const f = fixture(t);
  fs.writeFileSync(`${f.global}.lock`, "another writer");
  assert.equal(f.run(["config", "alias", "node", "kit"]).status, 2);
  assert.equal(fs.readFileSync(`${f.global}.lock`, "utf8"), "another writer");
  assert.equal(fs.existsSync(f.global), false);
  fs.rmSync(`${f.global}.lock`);
  const target = path.join(f.dir, "target.toml");
  fs.writeFileSync(target, "schema_version = 1");
  fs.symlinkSync(target, f.global);
  assert.equal(f.run(["config", "alias", "node", "kit"]).status, 2);
  assert.equal(fs.readlinkSync(f.global), target);
  assert.equal(fs.readFileSync(target, "utf8"), "schema_version = 1");
  assert.equal(fs.existsSync(`${f.global}.lock`), false);
});

test("init creates a native environment in the current directory without inheriting a parent", (t) => {
  const f = fixture(t);
  const parentContent = 'schema_version = 1\nkits = ["docker.io/acme/parent:1"]';
  fs.writeFileSync(f.manifest, parentContent);
  fs.writeFileSync(f.global, 'schema_version = 1\n[host_rpc]\nallow = ["notification.send"]');
  const result = f.run(["init"], { SBX_PI_HOST_RPC_ALLOW: "off" });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(f.subdir, "sbxenv.yaml");
  const content = fs.readFileSync(file, "utf8");
  assert.deepEqual(parseYaml(content), {
    schemaVersion: "1",
    agent: "pi-openai-codex",
    workspace: ".",
    kits: [],
  });
  assert.equal(fs.existsSync(path.join(f.subdir, "sbx-pi.toml")), false);
  assert.ok(result.stdout.includes(file));
  assert.ok(result.stdout.includes(content));
  assert.equal(fs.readFileSync(f.manifest, "utf8"), parentContent);
  assert.equal(f.show().workspace, f.subdir);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  assert.equal(fs.existsSync(f.env.XDG_STATE_HOME), false);
  assert.equal(fs.existsSync(path.join(f.env.HOME, "pi-sessions-backup")), false);
});

test("init expands aliases and serializes portable kit references that round-trip", (t) => {
  const f = fixture(t);
  const localKit = path.join(f.subdir, "kits", 'tools "quoted"');
  fs.mkdirSync(localKit, { recursive: true });
  const remote = "git+https://github.com/acme/kits.git#ref=v1.2.0&dir=node";
  fs.writeFileSync(
    f.global,
    `schema_version = 1\n[kit_aliases]\nnode = "docker.io/acme/node:1"\nlocal = ${JSON.stringify(localKit)}\n`,
  );
  const result = f.run([
    "init",
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
      agent: "pi-openai-codex",
      workspace: ".",
      kits: ["docker.io/acme/node:1", './kits/tools "quoted"', remote, "./kits/project"],
    },
  );
  assert.deepEqual(f.show().environmentFiles, [path.join(f.subdir, "sbxenv.yaml")]);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("init refuses existing files, directories, and symlinks without modifying them", (t) => {
  const f = fixture(t);
  const file = path.join(f.subdir, "sbxenv.yaml");
  const original = "not even valid YAML: [";
  fs.writeFileSync(file, original);
  let result = f.run(["init"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing to overwrite/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  fs.rmSync(file);
  fs.mkdirSync(file);
  result = f.run(["init"]);
  assert.equal(result.status, 2);
  assert.ok(fs.statSync(file).isDirectory());
  fs.rmdirSync(file);
  const target = path.join(f.dir, "absent-target");
  fs.symlinkSync(target, file);
  result = f.run(["init"]);
  assert.equal(result.status, 2);
  assert.equal(fs.readlinkSync(file), target);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("init rejects host-only paths and unsupported options before writing", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.global, 'schema_version = 1\n[kit_aliases]\nhost = "./private-tools"');
  for (const args of [
    ["--kit", "@host"],
    ["--kit", "../outside"],
    ["--kit", path.join(f.dir, "host-tools")],
    ["--kit", "@missing"],
    ["--config", "../sbx-pi.toml"],
    ["--no-config"],
    ["--recreate"],
    ["--import-codex-auth"],
    ["--continue"],
    ["--kit"],
  ]) {
    const result = f.run(["init", ...args]);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(fs.existsSync(path.join(f.subdir, "sbxenv.yaml")), false);
  }
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("first runs suggest init without creating a manifest; subsequent attachments do not", (t) => {
  const f = fixture(t);
  const first = f.run([], { SBX_PI_HOST_RPC_ALLOW: "off" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /Run sbx-pi init to persist/);
  assert.equal(fs.existsSync(path.join(f.subdir, "sbx-pi.toml")), false);
  const attached = f.run([], { SBX_PI_HOST_RPC_ALLOW: "off" });
  assert.equal(attached.status, 0, attached.stderr);
  assert.doesNotMatch(attached.stderr, /Run sbx-pi init to persist/);
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
  const result = spawnSync(path.join(bindir, "sbx-pi"), ["config", "show"], {
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

test("discovers project root and resolves TOML paths", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.global,
    'schema_version = 1\n[kit_aliases]\nnode = "docker.io/acme/node:1"\nlocal = "./kits/tools"\n',
  );
  fs.writeFileSync(
    f.manifest,
    '# Shared project\nschema_version = 1\nkits = [\n "./kits/project",\n "docker.io/acme/java:2",\n]\n',
  );
  const config = f.show();
  assert.equal(config.workspace, f.workspace);
  assert.deepEqual(config.kits, [path.join(f.workspace, "kits/project"), "docker.io/acme/java:2"]);
  const cli = f.show(["--kit", "@node", "--kit", "@local", "--kit", "./cli"]);
  assert.deepEqual(cli.kits, [
    "docker.io/acme/node:1",
    path.join(path.dirname(f.global), "kits/tools"),
    path.join(f.subdir, "cli"),
  ]);
  assert.deepEqual(f.show(["--no-kits"]).kits, []);
  const disabled = f.show(["--no-config"]);
  assert.equal(disabled.workspace, f.subdir);
  assert.deepEqual(disabled.kits, []);
  assert.equal(f.show(["--config", "../sbx-pi.toml"]).workspace, f.workspace);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false, "config show must not invoke sbx");
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
  assert.equal(f.run(["--config", "../sbx-pi.toml", "--no-config"]).status, 2);
  assert.equal(f.run([], { SBX_PI_HOST_RPC_ALLOW: "__proto__" }).status, 2);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("tracks applied kits, warns on drift, and recreates using the persisted manifest", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, 'schema_version = 1\nkits = ["docker.io/acme/node:1"]');
  assert.equal(f.status().status, "not-created");
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /docker.io\/acme\/node:1/);
  const create = f.calls().find((call) => call[0] === "run");
  assert.ok(create);
  assert.ok(create.includes(f.workspace));
  assert.deepEqual(create.slice(create.indexOf("--kit"), create.indexOf("pi-openai-codex")), [
    "--kit",
    root,
    "--kit",
    "docker.io/acme/node:1",
  ]);
  assert.equal(f.status().status, "current");
  fs.appendFileSync(f.manifest, "\n# A comment does not require recreation\n");
  assert.equal(f.status().status, "current");
  const stateFile = f.show().stateFile;
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  fs.writeFileSync(f.manifest, 'schema_version = 1\nkits = ["docker.io/acme/node:2", "./tools"]');
  assert.equal(f.status().status, "drifted");
  const attached = f.run(["--continue"]);
  assert.equal(attached.status, 0, attached.stderr);
  assert.match(attached.stderr, /Attaching without changes/);
  const attachCall = f.calls().at(-1);
  assert.ok(attachCall);
  assert.equal(attachCall.includes("--kit"), false);
  assert.equal(f.status().appliedKits?.[0], "docker.io/acme/node:1");
  const update = f.run(["--recreate"]);
  assert.equal(update.status, 0, update.stderr);
  assert.equal(f.status().status, "current");
  assert.deepEqual(f.status().appliedKits, [
    "docker.io/acme/node:2",
    path.join(f.workspace, "tools"),
  ]);
  assert.equal(f.calls().filter((call) => call[0] === "rm").length, 1);
  const cleared = f.run(["--recreate", "--no-kits"]);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(f.status().appliedKits, []);
  assert.equal(f.status().status, "drifted", "CLI overrides do not rewrite the manifest");
});

test("unknown legacy state and failed recreation never claim a current configuration", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, "schema_version = 1");
  fs.writeFileSync(f.env.MOCK_STATE, f.show().sandboxName!);
  assert.equal(f.status().status, "unknown");
  const attach = f.run();
  assert.equal(attach.status, 0, attach.stderr);
  assert.match(attach.stderr, /Applied configuration is unknown/);
  assert.equal(f.run(["--recreate"]).status, 0);
  assert.equal(f.status().status, "current");
  assert.equal(f.run(["--recreate"], { MOCK_FAIL: "1" }).status, 1);
  assert.equal(fs.existsSync(f.show().stateFile), false);
  assert.equal(f.status().status, "not-created");
});

test("native YAML owns sandbox settings while TOML supplies only Pi preferences", (t) => {
  const f = fixture(t);
  const environment = path.join(f.workspace, "sbxenv.yaml");
  const source = `schemaVersion: "1"
name: native-project
agent: pi-openai-codex
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
  assert.equal(provision.at(-1), "--detached");
  assert.equal(provision.includes("--auto-approve"), false);
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
    'schemaVersion: "1"\nagent: pi-openai-codex\nworkspace: "${{ env.projectDir }}/src"\n',
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

test("native plan delegates to Docker without starting Pi or creating session directories", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, "sbxenv.yaml"), 'schemaVersion: "1"\n');
  const result = f.run(["plan"]);
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
  assert.equal(overlay.agent, "pi-openai-codex");
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
  const kit = parseYaml(fs.readFileSync(path.join(overlay.kits[1], "spec.yaml"), "utf8"));
  assert.equal(kit.kind, "mixin");
  assert.deepEqual(kit.permissions.network.allow, ["api.github.com", "registry.npmjs.org"]);
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
  const current = parseYaml(fs.readFileSync(path.join(overlay.kits[1], "spec.yaml"), "utf8"));
  assert.deepEqual(current.permissions.network.allow, ["other.example"]);
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
});

test("native projects reject duplicate sandbox configuration and unsupported agents before Docker", (t) => {
  const f = fixture(t);
  const environment = path.join(f.workspace, "sbxenv.yaml");
  fs.writeFileSync(environment, 'schemaVersion: "1"\nagent: pi-openai-codex\n');
  fs.writeFileSync(f.manifest, "schema_version = 1\nkits = []");
  assert.match(f.run().stderr, /configure kits in YAML/);
  fs.writeFileSync(f.manifest, "schema_version = 1");
  for (const args of [["--kit", "node"], ["--no-kits"]]) {
    assert.equal(f.run(args).status, 2);
  }
  fs.writeFileSync(environment, 'schemaVersion: "1"\nagent: claude\n');
  assert.match(f.run().stderr, /use sbx env for other agents/);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  fs.rmSync(environment);
  assert.equal(f.run(["--env-arg", "name=test"]).status, 2);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});
