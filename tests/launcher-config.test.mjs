import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t) {
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
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: path.join(dir, "state"),
    PATH: `${bin}:${process.env.PATH}`,
    SBX_PI_NOTIFICATIONS: "",
    MOCK_STATE: path.join(dir, "sandbox"),
    MOCK_LOG: path.join(dir, "log"),
  };
  delete env.SBX_PI_NOTIFICATIONS;
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
}
`,
    { mode: 0o755 },
  );
  const manifest = path.join(workspace, "sbx-pi.toml");
  const global = path.join(configHome, "sbx-pi", "config.toml");
  const run = (args = [], overrides = {}) =>
    spawnSync(path.join(root, "scripts/run"), args, {
      cwd: subdir,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
  const show = (args = [], overrides = {}) => {
    const result = run(["config", "show", ...args], overrides);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const status = () => {
    const result = run(["status"]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const calls = () => fs.readFileSync(env.MOCK_LOG, "utf8").trim().split("\n").map(JSON.parse);
  return { dir, workspace, subdir, manifest, global, env, run, show, status, calls };
}

test("config alias creates global aliases usable by show and init without invoking sbx", (t) => {
  const f = fixture(t);
  const result = f.run(["config", "alias", "node", "docker.io/acme/node:1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved @node/);
  assert.deepEqual(
    { ...parse(fs.readFileSync(f.global, "utf8")).kit_aliases },
    { node: "docker.io/acme/node:1" },
  );
  assert.equal(fs.statSync(f.global).mode & 0o777, 0o600);
  assert.deepEqual(f.show(["--kit", "@node"]).kits, ["docker.io/acme/node:1"]);
  assert.equal(f.run(["init", "--kit", "@node"]).status, 0);
  assert.deepEqual(f.show().kits, ["docker.io/acme/node:1"]);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("config alias preserves global settings, resolves CLI paths, and requires explicit replacement", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.global,
    'schema_version = 1\nnotifications = "off"\n[kit_aliases]\nnode = "docker.io/acme/node:1"',
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
  const config = parse(fs.readFileSync(f.global, "utf8"));
  assert.equal(config.notifications, "off");
  assert.equal(config.kit_aliases.node, "docker.io/acme/node:2");
  assert.equal(config.kit_aliases.local, path.join(f.subdir, 'kits/tools "quoted"'));
  assert.deepEqual(f.show(["--kit", "@local"]).kits, [config.kit_aliases.local]);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  assert.equal(fs.existsSync(`${f.global}.lock`), false);
});

test("config alias validates arguments and configuration without changing existing files", (t) => {
  const f = fixture(t);
  const original = 'schema_version = 1\nnotifications = "off"';
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

test("init creates a minimal manifest in the current directory without inheriting a parent", (t) => {
  const f = fixture(t);
  const parentContent = 'schema_version = 1\nkits = ["docker.io/acme/parent:1"]';
  fs.writeFileSync(f.manifest, parentContent);
  fs.writeFileSync(f.global, 'schema_version = 1\nnotifications = "on"');
  const result = f.run(["init"], { SBX_PI_NOTIFICATIONS: "off" });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(f.subdir, "sbx-pi.toml");
  const content = fs.readFileSync(file, "utf8");
  assert.deepEqual({ ...parse(content) }, { schema_version: 1, kits: [] });
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
  const config = parse(fs.readFileSync(path.join(f.subdir, "sbx-pi.toml"), "utf8"));
  assert.deepEqual(
    { ...config },
    {
      schema_version: 1,
      kits: ["docker.io/acme/node:1", './kits/tools "quoted"', remote, "./kits/project"],
    },
  );
  assert.deepEqual(f.show().kits, [
    "docker.io/acme/node:1",
    localKit,
    remote,
    path.join(f.subdir, "kits/project"),
  ]);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("init refuses existing files, directories, and symlinks without modifying them", (t) => {
  const f = fixture(t);
  const file = path.join(f.subdir, "sbx-pi.toml");
  const original = "not even valid TOML";
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
    ["--no-project-config"],
    ["--update"],
    ["--import-codex-auth"],
    ["--continue"],
    ["--kit"],
  ]) {
    const result = f.run(["init", ...args]);
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(fs.existsSync(path.join(f.subdir, "sbx-pi.toml")), false);
  }
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("first runs suggest init without creating a manifest; subsequent attachments do not", (t) => {
  const f = fixture(t);
  const first = f.run([], { SBX_PI_NOTIFICATIONS: "off" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /Run sbx-pi init to persist/);
  assert.equal(fs.existsSync(path.join(f.subdir, "sbx-pi.toml")), false);
  const attached = f.run([], { SBX_PI_NOTIFICATIONS: "off" });
  assert.equal(attached.status, 0, attached.stderr);
  assert.doesNotMatch(attached.stderr, /Run sbx-pi init to persist/);
});

test("installed user command resolves configuration from a different project", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, 'schema_version = 1\nnotifications = "off"');
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

test("discovers project root, resolves TOML paths and applies notification precedence", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.global,
    'schema_version = 1\nnotifications = "off"\n[kit_aliases]\nnode = "docker.io/acme/node:1"\nlocal = "./kits/tools"\n',
  );
  fs.writeFileSync(
    f.manifest,
    '# Shared project\nschema_version = 1\nnotifications = "on"\nkits = [\n "./kits/project",\n "docker.io/acme/java:2",\n]\n',
  );
  const config = f.show();
  assert.equal(config.workspace, f.workspace);
  assert.deepEqual(config.kits, [path.join(f.workspace, "kits/project"), "docker.io/acme/java:2"]);
  assert.equal(config.notifications, "on");
  assert.equal(f.show([], { SBX_PI_NOTIFICATIONS: "off" }).notifications, "off");
  const cli = f.show(["--kit", "@node", "--kit", "@local", "--kit", "./cli"]);
  assert.deepEqual(cli.kits, [
    "docker.io/acme/node:1",
    path.join(path.dirname(f.global), "kits/tools"),
    path.join(f.subdir, "cli"),
  ]);
  assert.deepEqual(f.show(["--no-kits"]).kits, []);
  const disabled = f.show(["--no-project-config"]);
  assert.equal(disabled.workspace, f.subdir);
  assert.equal(disabled.notifications, "off");
  assert.deepEqual(disabled.kits, []);
  assert.equal(f.show(["--config", "../sbx-pi.toml"]).workspace, f.workspace);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false, "config show must not invoke sbx");
});

test("validates manifests and aliases before invoking Docker Sandbox", (t) => {
  const f = fixture(t);
  for (const source of [
    "schema_version = 2",
    'schema_version = 1\nkits = "node"',
    'schema_version = 1\nnotifications = "maybe"',
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
  assert.equal(f.run(["--config", "../sbx-pi.toml", "--no-project-config"]).status, 2);
  assert.equal(f.run([], { SBX_PI_NOTIFICATIONS: "__proto__" }).status, 2);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("tracks applied kits, warns on drift, and recreates using the persisted manifest", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.manifest,
    'schema_version = 1\nnotifications = "off"\nkits = ["docker.io/acme/node:1"]',
  );
  assert.equal(f.status().status, "not-created");
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /docker.io\/acme\/node:1/);
  const create = f.calls().find((call) => call[0] === "run");
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
  fs.writeFileSync(
    f.manifest,
    'schema_version = 1\nnotifications = "off"\nkits = ["docker.io/acme/node:2", "./tools"]',
  );
  assert.equal(f.status().status, "drifted");
  const attached = f.run(["--continue"]);
  assert.equal(attached.status, 0, attached.stderr);
  assert.match(attached.stderr, /Attaching without changes/);
  const attachCall = f.calls().at(-1);
  assert.equal(attachCall.includes("--kit"), false);
  assert.equal(f.status().appliedKits[0], "docker.io/acme/node:1");
  const update = f.run(["--update"]);
  assert.equal(update.status, 0, update.stderr);
  assert.equal(f.status().status, "current");
  assert.deepEqual(f.status().appliedKits, [
    "docker.io/acme/node:2",
    path.join(f.workspace, "tools"),
  ]);
  assert.equal(f.calls().filter((call) => call[0] === "rm").length, 1);
  const cleared = f.run(["--update", "--no-kits"]);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(f.status().appliedKits, []);
  assert.equal(f.status().status, "drifted", "CLI overrides do not rewrite the manifest");
});

test("unknown legacy state and failed recreation never claim a current configuration", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.manifest, 'schema_version = 1\nnotifications = "off"');
  fs.writeFileSync(f.env.MOCK_STATE, f.show().sandboxName);
  assert.equal(f.status().status, "unknown");
  const attach = f.run();
  assert.equal(attach.status, 0, attach.stderr);
  assert.match(attach.stderr, /Applied configuration is unknown/);
  assert.equal(f.run(["--update"]).status, 0);
  assert.equal(f.status().status, "current");
  assert.equal(f.run(["--update"], { MOCK_FAIL: "1" }).status, 1);
  assert.equal(fs.existsSync(f.show().stateFile), false);
  assert.equal(f.status().status, "not-created");
});
