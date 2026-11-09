import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import type { HostRequest } from "../scripts/host-rpc-protocol.mts";
import { validParams } from "../scripts/host-rpc-protocol.mts";
import { createHandlers, resolveHandlers } from "../scripts/host-rpc-handlers.mts";
import { allowedMethods, createDispatcher } from "../scripts/host-rpc-listener.mts";

const execute = promisify(execFile);
const handler = new URL("../scripts/host-rpc-handlers/git.commit.mts", import.meta.url).pathname;

type Review = {
  input: { summary: string; message: string; diff: string; dryRun: boolean };
  args: string[];
};

async function fixture(t: TestContext, initial = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-host-commit-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  await Promise.all([repo, bin, home].map((p) => fs.mkdir(p)));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) {
      delete env[key];
    }
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    REVIEW: path.join(dir, "review"),
    REPO: repo,
  });
  const git = async (...args: string[]) =>
    (await execute("git", ["-C", repo, ...args], { env })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Host User");
  await git("config", "user.email", "host@example.test");
  await git("config", "commit.gpgSign", "false");
  if (!initial) {
    await fs.writeFile(path.join(repo, "tracked.txt"), "original\n");
    await git("add", "tracked.txt");
    await git("commit", "-m", "Initial");
  }
  await fs.writeFile(path.join(repo, "tracked.txt"), "approved staged version\n");
  await git("add", "tracked.txt");
  const expectedHead = initial ? "unborn" : await git("rev-parse", "HEAD");
  const expectedTree = await git("write-tree");
  const request: HostRequest<"git.commit"> = {
    jsonrpc: "2.0",
    sbxVersion: 1,
    id: "commit-test",
    session: "test.jsonl",
    method: "git.commit",
    params: {
      expectedHead,
      expectedTree,
      message: "Host commit $(touch forbidden)\n\nMultiline body <plain text>",
    },
  };
  await fs.writeFile(
    path.join(bin, "python3"),
    `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv.includes('--check')) process.exit(process.env.MISSING_GTK ? 2 : 0);
let input = '';
for await (const chunk of process.stdin) input += chunk;
fs.writeFileSync(process.env.REVIEW, JSON.stringify({ input: JSON.parse(input), args: process.argv.slice(2) }));
const env = { ...process.env };
delete env.GIT_INDEX_FILE;
delete env.GIT_WORK_TREE;
const git = (...args) => {
  const result = spawnSync('git', ['-C', process.env.REPO, ...args], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
if (process.env.CHANGE === 'index') {
  fs.writeFileSync(process.env.REPO + '/extra.txt', 'not approved');
  git('add', 'extra.txt');
}
if (process.env.CHANGE === 'branch') git('symbolic-ref', 'HEAD', 'refs/heads/other');
if (process.env.CHANGE === 'head') {
  const next = git('-c', 'commit.gpgSign=false', 'commit-tree', git('write-tree'), '-p', git('rev-parse', 'HEAD'), '-m', 'Concurrent');
  git('update-ref', 'HEAD', next);
}
if (process.env.REVIEW_NOISE) {
  console.error('GTK desktop warning: test diagnostic'.repeat(Number(process.env.REVIEW_NOISE)));
  console.error('End of GTK review diagnostics');
}
if (process.env.DELAY_REVIEW) await new Promise(r => setTimeout(r, Number(process.env.DELAY_REVIEW)));
process.exitCode = Number(process.env.REVIEW_EXIT || '0');
`,
    { mode: 0o700 },
  );
  // execFile's promisified form does not accept stdin, so use an explicit callback.
  const call = (overrides: NodeJS.ProcessEnv = {}) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [handler],
        { env: { ...env, ...overrides } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin?.end(
        JSON.stringify({ request, context: { workspace: repo, sandbox: "host-selected" } }),
      );
    });
  const diagnose = (args = ["git-commit"], overrides: NodeJS.ProcessEnv = {}) =>
    execute(new URL("../scripts/run", import.meta.url).pathname, ["test-rpc", ...args], {
      cwd: repo,
      env: { ...env, SBX_PI_HOST_RPC_ALLOW: "git.commit", ...overrides },
    });
  return { dir, repo, env, git, request, call, diagnose };
}

test("host dry run exercises desktop approval without changing refs, objects, index or working files", async (t) => {
  for (const state of ["staged", "clean", "unborn"]) {
    const f = await fixture(t, state === "unborn");
    if (state === "staged") {
      // Do not write-tree first: even newly constructed trees must stay temporary.
      await fs.writeFile(path.join(f.repo, "tracked.txt"), "new tree for dry run\n");
      await f.git("add", "tracked.txt");
    } else {
      // A clean index (including an unborn repository with no index) must work too.
      await f.git("reset");
      if (state === "unborn") {
        await fs.rm(path.join(f.repo, ".git/index"), { force: true });
      }
    }
    const index = await fs.readFile(path.join(f.repo, ".git/index")).catch(() => undefined);
    const objects = await fs.readdir(path.join(f.repo, ".git/objects"), { recursive: true });
    const refs = await f.git("show-ref", "--head").catch(() => "");
    const contents = await fs.readFile(path.join(f.repo, "tracked.txt"));
    const temporary = path.join(f.dir, "tmp");
    await fs.mkdir(temporary);
    for (const command of ["sbx", "docker"]) {
      await fs.writeFile(path.join(f.dir, "bin", command), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    }
    // Host diagnostics must ignore project/native environment parsing entirely.
    await fs.writeFile(path.join(f.repo, "sbx-pi.toml"), "invalid project TOML");
    const result = await f.diagnose(undefined, { TMPDIR: temporary });
    assert.match(result.stdout, /dry run passed/);
    assert.match(result.stderr, /signing\/pinentry NOT tested/);
    assert.deepEqual(
      await fs.readFile(path.join(f.repo, ".git/index")).catch(() => undefined),
      index,
    );
    assert.equal(await f.git("show-ref", "--head").catch(() => ""), refs);
    assert.deepEqual(
      await fs.readdir(path.join(f.repo, ".git/objects"), { recursive: true }),
      objects,
    );
    assert.deepEqual(await fs.readFile(path.join(f.repo, "tracked.txt")), contents);
    assert.deepEqual(await fs.readdir(temporary), []);
    await assert.rejects(fs.access(path.join(f.repo, "sbxenv.yaml")));
    const review = JSON.parse(await fs.readFile(f.env.REVIEW!, "utf8")) as Review;
    assert.match(review.input.summary, /DRY RUN/);
    assert.equal(review.input.dryRun, true);
    assert.equal(review.args[0], "-I");
  }
});

test("host dry run respects global permission, rejects custom handlers and validates arguments before desktop effects", async (t) => {
  const f = await fixture(t);
  const globalDir = path.join(f.env.XDG_CONFIG_HOME!, "sbx-pi");
  await fs.mkdir(globalDir);
  const global = path.join(globalDir, "global.toml");
  await assert.rejects(
    f.diagnose(undefined, { SBX_PI_HOST_RPC_ALLOW: undefined }),
    /git.commit is not allowed/,
  );
  await assert.rejects(
    f.diagnose(undefined, { MISSING_GTK: "1" }),
    /requires host.*PyGObject.*GTK 4/,
  );
  for (const args of [[], ["unknown"], ["git-commit", "extra"], ["git-commit", "--recreate"]]) {
    await assert.rejects(f.diagnose(args), /Usage: sbx-pi test-rpc git-commit/);
  }
  await fs.writeFile(global, 'schema_version = 1\n[host_rpc]\nallow = ["git.commit"]\n');
  await assert.rejects(f.diagnose(undefined, { SBX_PI_HOST_RPC_ALLOW: "off" }), /not allowed/);
  await fs.appendFile(global, '[host_rpc.handlers]\n"git.commit" = [["false"]]\n');
  await assert.rejects(f.diagnose(), /Cannot safely dry-run a custom/);
  await assert.rejects(fs.access(f.env.REVIEW!));
  await fs.writeFile(global, 'schema_version = 1\n[host_rpc]\nallow = ["git.commit"]\n');
  assert.match(
    (await f.diagnose(undefined, { SBX_PI_HOST_RPC_ALLOW: undefined })).stdout,
    /dry run passed/,
  );
});

test("host dry run reports cancellation and signing failures without committing", async (t) => {
  const f = await fixture(t);
  const index = await fs.readFile(path.join(f.repo, ".git/index"));
  for (const REVIEW_EXIT of ["1", "5"]) {
    await assert.rejects(f.diagnose(undefined, { REVIEW_EXIT }), /declined or expired/);
  }
  await f.git("config", "commit.gpgSign", "true");
  await f.git("config", "gpg.program", path.join(f.dir, "missing-gpg"));
  await assert.rejects(f.diagnose(), /missing-gpg|signing failed/);
  assert.equal(await f.git("rev-parse", "HEAD"), f.request.params.expectedHead);
  assert.deepEqual(await fs.readFile(path.join(f.repo, ".git/index")), index);
});

test("noisy desktop diagnostics do not abort host approval or hide GTK review failures", async (t) => {
  const f = await fixture(t);
  const index = await fs.readFile(path.join(f.repo, ".git/index"));
  const noisy = { REVIEW_NOISE: "1000" };
  const result = await f.diagnose(undefined, noisy);
  assert.match(result.stdout, /dry run passed/);
  assert.match(result.stderr, /GTK desktop warning/);
  assert.match(result.stderr, /truncated/);
  assert.match(result.stderr, /End of GTK review diagnostics/);
  assert.ok(Buffer.byteLength(result.stderr) < 4096);
  for (const REVIEW_EXIT of ["1", "5"]) {
    await assert.rejects(f.diagnose(undefined, { ...noisy, REVIEW_EXIT }), /declined or expired/);
  }
  await assert.rejects(f.diagnose(undefined, { ...noisy, REVIEW_EXIT: "2" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /python3/);
    assert.match(error.message, /GTK desktop warning/);
    assert.match(error.message, /End of GTK review diagnostics/);
    assert.doesNotMatch(error.message, /maxBuffer|output exceeds limit/);
    return true;
  });
  // Excessive output still fails closed rather than removing resource limits.
  await assert.rejects(
    f.diagnose(undefined, { REVIEW_NOISE: "100000" }),
    /python3: stderr maxBuffer length exceeded/,
  );
  assert.equal(await f.git("rev-parse", "HEAD"), f.request.params.expectedHead);
  assert.deepEqual(await fs.readFile(path.join(f.repo, ".git/index")), index);
  // Real commits share the same desktop subprocess path, not only the diagnostic.
  assert.deepEqual(JSON.parse(await f.call(noisy)), { status: "performed" });
});

test("host commit is opt-in and rejects arbitrary flags, paths and malformed snapshots", () => {
  assert.equal(allowedMethods(undefined, true).has("git.commit"), false);
  const params = {
    message: "Subject\n\nBody",
    expectedHead: "a".repeat(40),
    expectedTree: "b".repeat(40),
  };
  assert.ok(validParams("git.commit", params));
  assert.ok(validParams("git.commit", { ...params, expectedHead: "unborn" }));
  for (const bad of [
    { ...params, message: "  \n" },
    { ...params, message: "secret\rcontrol" },
    { ...params, message: "x".repeat(2001) },
    { ...params, expectedHead: "HEAD" },
    { ...params, expectedTree: "--help" },
    { ...params, args: ["--amend"] },
    { ...params, path: "/other/repository" },
    { ...params, passphrase: "never" },
  ]) {
    assert.equal(validParams("git.commit", bad), false);
  }
  assert.throws(
    () => resolveHandlers({ "git.commit": [["default"], ["default"]] }, "/tmp"),
    /exactly one/,
  );
});

test("approved host commit preserves the real index and unstaged work, with no hooks or shell interpretation", async (t) => {
  const f = await fixture(t);
  const index = await fs.readFile(path.join(f.repo, ".git/index"));
  await fs.writeFile(path.join(f.repo, "tracked.txt"), "unrelated unstaged edits\n");
  await fs.writeFile(path.join(f.repo, "untracked.txt"), "never stage me\n");
  await fs.writeFile(
    path.join(f.repo, ".git/hooks/pre-commit"),
    "#!/bin/sh\ntouch hook-ran\nexit 1\n",
    { mode: 0o700 },
  );
  await f.git("config", "filter.untrusted.clean", "touch filter-ran; cat");
  await f.git("config", "filter.untrusted.required", "true");
  await fs.writeFile(path.join(f.repo, ".gitattributes"), "*.txt filter=untrusted\n");
  assert.deepEqual(JSON.parse(await f.call()), { status: "performed" });
  assert.equal(await f.git("rev-parse", "HEAD^{tree}"), f.request.params.expectedTree);
  assert.equal(await f.git("show", "HEAD:tracked.txt"), "approved staged version");
  assert.equal(await f.git("log", "-1", "--format=%B"), f.request.params.message);
  assert.equal(await f.git("log", "-1", "--format=%an <%ae>"), "Host User <host@example.test>");
  assert.deepEqual(await fs.readFile(path.join(f.repo, ".git/index")), index);
  assert.equal(
    await fs.readFile(path.join(f.repo, "tracked.txt"), "utf8"),
    "unrelated unstaged edits\n",
  );
  for (const name of ["hook-ran", "filter-ran", "forbidden", ".git/index.lock"]) {
    await assert.rejects(fs.access(path.join(f.repo, name)));
  }
  const review = JSON.parse(await fs.readFile(f.env.REVIEW!, "utf8")) as Review;
  assert.equal(review.input.message, f.request.params.message);
  assert.ok(review.input.diff.includes("approved staged version"));
  assert.ok(!review.input.diff.includes("unrelated unstaged edits"));
  assert.equal(review.input.dryRun, false);
  assert.equal(review.args[0], "-I");
});

test("initial host commits use the approved staged tree", async (t) => {
  const f = await fixture(t, true);
  assert.deepEqual(JSON.parse(await f.call()), { status: "performed" });
  assert.equal(await f.git("rev-parse", "HEAD^{tree}"), f.request.params.expectedTree);
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "1");
});

test("desktop cancellation and review expiry never commit", async (t) => {
  const f = await fixture(t);
  for (const REVIEW_EXIT of ["1", "5"]) {
    assert.deepEqual(JSON.parse(await f.call({ REVIEW_EXIT })), { status: "declined" });
    assert.equal(await f.git("rev-parse", "HEAD"), f.request.params.expectedHead);
  }
});

test("mismatched HEAD or staged tree fails before opening a desktop review", async (t) => {
  const f = await fixture(t);
  for (const field of ["expectedHead", "expectedTree"] as const) {
    const old = f.request.params[field];
    f.request.params[field] = "0".repeat(40);
    await assert.rejects(f.call());
    f.request.params[field] = old;
    await assert.rejects(fs.access(f.env.REVIEW!));
  }
  assert.equal(await f.git("rev-parse", "HEAD"), f.request.params.expectedHead);
});

test("changes to HEAD, branch or real index during desktop review refuse execution", async (t) => {
  for (const CHANGE of ["head", "branch", "index"]) {
    const f = await fixture(t);
    await assert.rejects(f.call({ CHANGE }));
    assert.equal(
      (await f.git("rev-parse", "--verify", "--quiet", "refs/heads/main")) ===
        f.request.params.expectedHead,
      CHANGE !== "head",
    );
  }
});

test("empty stages, corrupt indexes and in-progress Git operations fail without desktop approval", async (t) => {
  for (const state of ["empty", "corrupt", "merge", "detached"]) {
    const f = await fixture(t);
    if (state === "empty") {
      await f.git("reset", "--mixed", "HEAD");
      f.request.params.expectedTree = await f.git("write-tree");
    } else if (state === "corrupt") {
      await fs.writeFile(path.join(f.repo, ".git/index"), "invalid index");
    } else if (state === "merge") {
      await fs.writeFile(path.join(f.repo, ".git/MERGE_HEAD"), f.request.params.expectedHead);
    } else {
      await f.git("checkout", "--detach");
    }
    await assert.rejects(f.call());
    await assert.rejects(fs.access(f.env.REVIEW!));
    assert.equal(await f.git("rev-parse", "HEAD"), f.request.params.expectedHead);
  }
});

test("review launch failures and oversized staged diffs never commit", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call({ REVIEW_EXIT: "2" }));
  await fs.rm(f.env.REVIEW!);
  await fs.writeFile(path.join(f.repo, "large.txt"), "large staged line\n".repeat(100000));
  await f.git("add", "large.txt");
  f.request.params.expectedTree = await f.git("write-tree");
  await assert.rejects(f.call());
  await assert.rejects(fs.access(f.env.REVIEW!));
  assert.equal(await f.git("rev-parse", "HEAD"), f.request.params.expectedHead);
});

test("failed signing leaves the host branch and index unchanged", async (t) => {
  const f = await fixture(t);
  const index = await fs.readFile(path.join(f.repo, ".git/index"));
  await f.git("config", "commit.gpgSign", "true");
  await f.git("config", "gpg.program", path.join(f.dir, "missing-gpg"));
  await assert.rejects(f.call());
  assert.equal(await f.git("rev-parse", "HEAD"), f.request.params.expectedHead);
  assert.deepEqual(await fs.readFile(path.join(f.repo, ".git/index")), index);
});

test(
  "host signing uses host GPG configuration",
  { skip: spawnSync("gpg", ["--version"]).status !== 0 },
  async (t) => {
    const f = await fixture(t);
    const gnupg = path.join(f.dir, "gnupg");
    await fs.mkdir(gnupg, { mode: 0o700 });
    const env = { ...f.env, GNUPGHOME: gnupg };
    try {
      await execute(
        "gpg",
        [
          "--batch",
          "--pinentry-mode",
          "loopback",
          "--passphrase",
          "",
          "--quick-generate-key",
          "Host Test <host@example.test>",
          "ed25519",
          "sign",
          "0",
        ],
        { env },
      );
      await f.git("config", "commit.gpgSign", "true");
      await f.git("config", "user.signingKey", "host@example.test");
      const index = await fs.readFile(path.join(f.repo, ".git/index"));
      const objects = await fs.readdir(path.join(f.repo, ".git/objects"), { recursive: true });
      const diagnostic = await f.diagnose(undefined, { GNUPGHOME: gnupg });
      assert.match(diagnostic.stderr, /identity and signing succeeded/);
      assert.equal(await f.git("rev-parse", "HEAD"), f.request.params.expectedHead);
      assert.deepEqual(await fs.readFile(path.join(f.repo, ".git/index")), index);
      assert.deepEqual(
        await fs.readdir(path.join(f.repo, ".git/objects"), { recursive: true }),
        objects,
      );
      assert.deepEqual(JSON.parse(await f.call({ GNUPGHOME: gnupg })), { status: "performed" });
      await execute("git", ["-C", f.repo, "verify-commit", "HEAD"], { env });
    } finally {
      await execute("gpgconf", ["--kill", "gpg-agent"], { env }).catch(() => {});
    }
  },
);

test("commit handlers may wait for humans beyond the telemetry timeout and can be aborted on launcher shutdown", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbx-commit-wait-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "wait.mjs");
  await fs.writeFile(
    script,
    'setTimeout(() => console.log(JSON.stringify({ status: "performed" })), 2200);',
  );
  const controller = new AbortController();
  const handlers = createHandlers(
    resolveHandlers({ "git.commit": [[process.execPath, script]] }, dir),
    {
      cwd: dir,
      sandbox: "test",
      workspace: dir,
      signal: controller.signal,
    },
  );
  const request: HostRequest<"git.commit"> = {
    jsonrpc: "2.0",
    sbxVersion: 1,
    id: "wait",
    session: "test",
    method: "git.commit",
    params: { message: "Subject", expectedHead: "a".repeat(40), expectedTree: "b".repeat(40) },
  };
  assert.deepEqual(await handlers["git.commit"](request), { status: "performed" });
  const pending = handlers["git.commit"](request);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  await assert.rejects(handlers["git.commit"](request), /abort/i);
});

test("commit dispatch requires host permission and a successful audit; failures do not invite automatic retries", async () => {
  let calls = 0;
  const handlers = createHandlers(resolveHandlers({}, "/tmp"), {
    cwd: "/tmp",
    workspace: "/tmp",
    sandbox: "test",
  });
  handlers["git.commit"] = async () => {
    calls++;
    throw new Error("private signing error");
  };
  const request: HostRequest<"git.commit"> = {
    jsonrpc: "2.0",
    sbxVersion: 1,
    id: "commit",
    session: "test",
    method: "git.commit",
    params: { message: "Subject", expectedHead: "a".repeat(40), expectedTree: "b".repeat(40) },
  };
  const line = JSON.stringify(request);
  const denied = await createDispatcher({
    allowed: allowedMethods(undefined, true),
    handlers,
    record: async () => {},
  });
  assert.equal((await denied(line)).error?.code, -32001);
  assert.equal(calls, 0);
  const unaudited = await createDispatcher({
    allowed: new Set(["git.commit"]),
    handlers,
    record: async () => {
      throw new Error("audit failed");
    },
  });
  await assert.rejects(unaudited(line), /audit failed/);
  assert.equal(calls, 0);
  const allowed = await createDispatcher({
    allowed: new Set(["git.commit"]),
    handlers,
    record: async () => {},
  });
  const error = (await allowed(line)).error;
  assert.equal(error?.code, -32603);
  assert.match(error!.message, /outcome unknown/);
  assert.ok(!error!.message.includes("private signing error"));
  assert.equal((await allowed(line)).error?.code, -32002);
  assert.equal(calls, 1);
});
