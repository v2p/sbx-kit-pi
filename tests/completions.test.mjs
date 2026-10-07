import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zshAvailable = spawnSync("zsh", ["--version"]).status === 0;
if (process.env.SBX_PI_REQUIRE_ZSH === "1" && !zshAvailable) {
  throw new Error("Zsh is required for completion integration tests");
}

function generate(f, command = "my-pi") {
  const result = f.execute(command, ["completion", "zsh"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const directory = path.join(f.home, ".zfunc");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `_${command}`), result.stdout);
  return directory;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-pi-completion-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const workspace = path.join(dir, "workspace");
  const configHome = path.join(dir, "config");
  for (const directory of [bin, home, workspace, path.join(configHome, "sbx-pi")]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.symlinkSync(path.join(root, "scripts/run"), path.join(bin, "my-pi"));
  // Completion must never call Docker Sandbox or Git, even with broken project config.
  for (const command of ["sbx", "docker", "git"]) {
    fs.writeFileSync(
      path.join(bin, command),
      '#!/bin/sh\necho unexpected >> "$MOCK_LOG"\nexit 1\n',
      { mode: 0o755 },
    );
  }
  fs.writeFileSync(path.join(workspace, "sbx-pi.toml"), "invalid project TOML");
  const global = path.join(configHome, "sbx-pi", "global.toml");
  fs.writeFileSync(
    global,
    'schema_version = 1\n[kit_aliases]\nnode = "docker.io/acme/node:1"\nnode_tools = "./tools"\n',
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: path.join(dir, "state"),
    SBX_PI_HOST_RPC_ALLOW: "invalid",
    MOCK_LOG: path.join(dir, "log"),
  };
  const execute = (command, args) =>
    spawnSync(command, args, { cwd: workspace, env, encoding: "utf8" });
  const complete = (...words) => {
    const result = execute("my-pi", ["_complete", ...words]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout.trimEnd().split("\n");
  };
  return {
    dir,
    home,
    workspace,
    global,
    env,
    execute,
    complete,
  };
}

test("completion offers context-specific launcher commands and flags, not Pi arguments", (t) => {
  const f = fixture(t);
  assert.ok(f.complete("").includes("init"));
  assert.ok(f.complete("").includes("completion"));
  assert.deepEqual(f.complete("completion", ""), ["words", "zsh"]);
  assert.deepEqual(f.complete("completion", "z"), ["words", "zsh"]);
  assert.deepEqual(f.complete("completion", "zsh", ""), ["words"]);
  assert.deepEqual(f.complete("config", ""), ["words", "show", "alias"]);
  assert.deepEqual(f.complete("--rec"), ["words", "--recreate"]);
  assert.deepEqual(f.complete("init", "--"), ["words", "--kit", "--no-kits", "--help"]);
  assert.deepEqual(f.complete("status", "--rec"), ["words"]);
  assert.deepEqual(f.complete("config", "show", "--con"), ["words", "--config"]);
  assert.deepEqual(f.complete("--config", "a file"), ["files"]);
  assert.deepEqual(f.complete("--env", "a file"), ["files"]);
  assert.deepEqual(f.complete("--env-arg", "channel="), ["words"]);
  assert.deepEqual(f.complete("--allow-host", "api."), ["words"]);
  assert.ok(f.complete("plan", "--").includes("--env"));
  assert.deepEqual(f.complete("--kit", "./some dir"), ["files"]);
  assert.deepEqual(f.complete("--kit", "@node", "--"), [
    "words",
    "--kit",
    "--no-kits",
    "--help",
    "--config",
    "--no-config",
    "--env",
    "--env-arg",
    "--env-args-file",
    "--allow-host",
    "--recreate",
    "--import-codex-auth",
  ]);
  assert.deepEqual(f.complete("--", "--"), ["words"]);
  assert.deepEqual(f.complete("--model", "--"), ["words"]);
  assert.deepEqual(f.complete("--kit", "node", "").includes("init"), false);
  assert.deepEqual(f.complete("config", "alias", ""), ["words", "node", "node_tools"]);
  assert.deepEqual(f.complete("config", "alias", "node", ""), ["files"]);
  assert.deepEqual(f.complete("config", "alias", "node", "kit", "--"), ["words", "--replace"]);
  assert.deepEqual(f.complete("config", "alias", "--replace", "node", "kit", ""), ["words"]);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  assert.equal(fs.existsSync(f.env.XDG_STATE_HOME), false);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.equal(
    fs.readFileSync(path.join(f.workspace, "sbx-pi.toml"), "utf8"),
    "invalid project TOML",
  );
});

test("completion reads global aliases and tolerates missing or malformed personal config", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.complete("--kit", "@no"), ["words", "@node", "@node_tools"]);
  assert.deepEqual(f.complete("init", "--kit", "@node_"), ["words", "@node_tools"]);
  fs.writeFileSync(f.global, "invalid TOML");
  assert.deepEqual(f.complete("--kit", "@"), ["words"]);
  fs.rmSync(f.global);
  assert.deepEqual(f.complete("--kit", "@"), ["words"]);
  assert.deepEqual(f.complete("config", "alias", ""), ["words"]);
  assert.equal(fs.existsSync(f.global), false);
});

test("completion generator rejects invalid arguments and only writes code to stdout", (t) => {
  const f = fixture(t);
  for (const args of [[], ["fish"], ["bash"], ["zsh", "extra"], ["--recreate"]]) {
    const result = f.execute("my-pi", ["completion", ...args]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: sbx-pi completion zsh/);
  }
  const result = f.execute("my-pi", ["completion", "zsh"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.length > 0);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  assert.equal(fs.existsSync(f.env.XDG_STATE_HOME), false);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test(
  "Zsh compinit discovers generated files for default and custom command names",
  { skip: !zshAvailable },
  (t) => {
    const f = fixture(t);
    fs.symlinkSync(path.join(root, "scripts/run"), path.join(f.dir, "bin", "sbx-pi"));
    generate(f, "sbx-pi");
    const directory = generate(f);
    // Runner images can include insecure completion directories. Ignore them rather
    // than prompting on a nonexistent terminal, and exercise that case explicitly.
    const insecure = path.join(f.dir, "insecure-completions");
    fs.mkdirSync(insecure);
    fs.chmodSync(insecure, 0o777);
    f.env.SBX_PI_TEST_FPATH = directory;
    f.env.SBX_PI_TEST_INSECURE = insecure;
    const result = f.execute("zsh", [
      "-f",
      "-c",
      'fpath=($SBX_PI_TEST_FPATH $SBX_PI_TEST_INSECURE $fpath); autoload -Uz compinit; compinit -i -D; [[ ${_comps[sbx-pi]} == _sbx-pi && ${_comps[my-pi]} == _my-pi ]] || exit 1; function compadd { while [[ $1 != -- ]]; do shift; done; shift; printf "%s\\0" "$@"; }; for command in sbx-pi my-pi; do words=($command --kit @node_); CURRENT=${#words}; ${_comps[$command]}; done',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.stdout.split("\0").filter(Boolean), ["@node_tools", "@node_tools"]);
    assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
    assert.deepEqual(fs.readdirSync(f.home), [".zfunc"]);
  },
);

test("Zsh autoload completion dispatches words versus files", { skip: !zshAvailable }, (t) => {
  const f = fixture(t);
  f.env.SBX_PI_TEST_FPATH = generate(f);
  const zshComplete = (...input) => {
    const result = f.execute("zsh", [
      "-f",
      "-c",
      'fpath=($SBX_PI_TEST_FPATH $fpath); autoload -Uz compinit; compinit -i -D; function compadd { while [[ $1 != -- ]]; do shift; done; shift; printf "%s\\0" "$@"; }; function _files { printf "files\\0"; }; words=(my-pi "$@"); CURRENT=${#words}; ${_comps[my-pi]}',
      "test",
      ...input,
    ]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split("\0").filter(Boolean);
  };
  assert.deepEqual(zshComplete("config", "s"), ["show"]);
  assert.deepEqual(zshComplete("--kit", "@node_"), ["@node_tools"]);
  assert.deepEqual(zshComplete("--config", "project"), ["files"]);
  assert.deepEqual(zshComplete("--", "--"), []);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});

test("Zsh displays help without inserting descriptions", { skip: !zshAvailable }, (t) => {
  const f = fixture(t);
  f.env.SBX_PI_TEST_FPATH = generate(f);
  const suggest = (...input) => {
    const result = f.execute("zsh", [
      "-f",
      "-c",
      'fpath=($SBX_PI_TEST_FPATH $fpath); autoload -Uz compinit; compinit -i -D; function compadd { local -a labels; while [[ $1 != -- ]]; do if [[ $1 == -d ]]; then shift; labels=("${(@P)1}"); fi; shift; done; shift; printf "%s\\0" "${labels[@]}" "INSERT" "$@"; }; words=(my-pi "$@"); CURRENT=${#words}; ${_comps[my-pi]}',
      "test",
      ...input,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.split("\0").filter(Boolean);
    const separator = output.indexOf("INSERT");
    return { labels: output.slice(0, separator), words: output.slice(separator + 1) };
  };
  for (const input of [[""], ["--rec"], ["config", "s"], ["completion", "z"]]) {
    const { labels, words } = suggest(...input);
    assert.ok(words.length > 0);
    assert.equal(labels.length, words.length);
    for (let i = 0; i < words.length; i++) {
      assert.ok(labels[i].startsWith(`${words[i]} -- `), labels[i]);
      assert.ok(!words[i].includes(" -- "));
    }
  }
  const alias = suggest("config", "alias", "node");
  assert.deepEqual(alias.words, ["node", "node_tools"]);
  assert.deepEqual(alias.labels, alias.words);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
});
