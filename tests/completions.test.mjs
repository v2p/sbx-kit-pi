import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zshAvailable = spawnSync("zsh", ["--version"]).status === 0;

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
  const global = path.join(configHome, "sbx-pi", "config.toml");
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
    SBX_PI_NOTIFICATIONS: "invalid",
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
  assert.deepEqual(f.complete("completion", ""), ["words", "bash", "zsh"]);
  assert.deepEqual(f.complete("completion", "z"), ["words", "zsh"]);
  assert.deepEqual(f.complete("completion", "zsh", ""), ["words"]);
  assert.deepEqual(f.complete("config", ""), ["words", "show", "alias"]);
  assert.deepEqual(f.complete("--rec"), ["words", "--recreate"]);
  assert.deepEqual(f.complete("init", "--"), ["words", "--kit", "--no-kits", "--help"]);
  assert.deepEqual(f.complete("status", "--rec"), ["words"]);
  assert.deepEqual(f.complete("config", "show", "--con"), ["words", "--config"]);
  assert.deepEqual(f.complete("--config", "a file"), ["files"]);
  assert.deepEqual(f.complete("--kit", "./some dir"), ["files"]);
  assert.deepEqual(f.complete("--kit", "@node", "--"), [
    "words",
    "--kit",
    "--no-kits",
    "--help",
    "--config",
    "--no-config",
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

test("completion initialization rejects invalid shells without emitting code or writing files", (t) => {
  const f = fixture(t);
  for (const args of [[], ["fish"], ["bash", "extra"], ["--recreate"]]) {
    const result = f.execute("my-pi", ["completion", ...args]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: sbx-pi completion bash\|zsh/);
  }
  for (const shell of ["bash", "zsh"]) {
    const result = f.execute("my-pi", ["completion", shell]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.length > 0);
  }
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  assert.equal(fs.existsSync(f.env.XDG_STATE_HOME), false);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test("Bash eval initialization registers custom names and can run repeatedly", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, "project config.toml"), "");
  const bashComplete = (...words) => {
    const result = f.execute("bash", [
      "-c",
      'eval "$(my-pi completion bash)"; eval "$(my-pi completion bash)"; complete -p my-pi >/dev/null || exit 1; COMP_WORDS=("my-pi" "$@"); COMP_CWORD=$((${#COMP_WORDS[@]} - 1)); _sbx_pi_complete; if ((${#COMPREPLY[@]})); then printf "%s\\0" "${COMPREPLY[@]}"; fi',
      "test",
      ...words,
    ]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split("\0").filter(Boolean);
  };
  assert.deepEqual(bashComplete("--kit", "@node_"), ["@node_tools"]);
  assert.deepEqual(bashComplete("--config", "project"), ["project config.toml"]);
  assert.deepEqual(bashComplete("--", "--"), []);
  assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test(
  "Zsh eval initialization requires compinit and supports repeated registration",
  { skip: !zshAvailable },
  (t) => {
    const f = fixture(t);
    const missing = f.execute("zsh", [
      "-f",
      "-c",
      'eval "$(my-pi completion zsh)"; (( $+functions[_sbx_pi_complete] )) && exit 1; exit 0',
    ]);
    assert.equal(missing.status, 0);
    assert.match(missing.stderr, /initialize compinit/);
    // Runner images can include insecure completion directories. Ignore them rather
    // than prompting on a nonexistent terminal, and exercise that case explicitly.
    const insecure = path.join(f.dir, "insecure-completions");
    fs.mkdirSync(insecure);
    fs.chmodSync(insecure, 0o777);
    f.env.SBX_PI_TEST_FPATH = insecure;
    const result = f.execute("zsh", [
      "-f",
      "-c",
      'fpath=($SBX_PI_TEST_FPATH $fpath); autoload -Uz compinit; compinit -i -D; eval "$(my-pi completion zsh)"; eval "$(my-pi completion zsh)"; [[ ${_comps[my-pi]} == _sbx_pi_complete ]] || exit 1; function compadd { shift 2; printf "%s\\0" "$@"; }; words=(my-pi --kit @node_); CURRENT=${#words}; _sbx_pi_complete',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.stdout.split("\0").filter(Boolean), ["@node_tools"]);
    assert.equal(fs.existsSync(f.env.MOCK_LOG), false);
    assert.deepEqual(fs.readdirSync(f.home), []);
  },
);

test("Zsh eval completion dispatches words versus files", { skip: !zshAvailable }, (t) => {
  const f = fixture(t);
  const zshComplete = (...input) => {
    const result = f.execute("zsh", [
      "-f",
      "-c",
      'autoload -Uz compinit; compinit -i -D; eval "$(my-pi completion zsh)"; function compadd { shift 2; printf "%s\\0" "$@"; }; function _files { printf "files\\0"; }; words=(my-pi "$@"); CURRENT=${#words}; _sbx_pi_complete',
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
