import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { convertMixin, migrateProject } from "../scripts/launcher-migration.mts";

// The project-bootstrap mixin shipped before the v3 switch.
const legacy = `schemaVersion: "2"
kind: mixin
name: project-bootstrap
displayName: Node.js Project Bootstrap
description: Install locked Node.js dependencies and tell the agent how to verify the project.
setup:
  install:
    - command: npm ci
      user: "1000"
      description: Install the project's locked Node.js dependencies
permissions:
  network:
    allow:
      - registry.npmjs.org
agentInstructions:
  content: |
    Project dependencies are installed with npm ci when the sandbox is created.
`;

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-pi-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const kit = path.join(dir, "tools");
  fs.mkdirSync(kit);
  const spec = path.join(kit, "spec.yaml");
  fs.writeFileSync(spec, legacy, { mode: 0o640 });
  const env = path.join(dir, "sbxenv.yaml");
  const source =
    '# Keep this comment\nschemaVersion: "1"\nagent: pi-openai-codex\nworkspace: .\nkits: [./tools]\nports: [{sandbox: 3000, host: 8080}]\n';
  fs.writeFileSync(env, source);
  return { dir, kit, spec, env, source };
}

test("convert historical project mixin without losing install, network or instructions", () => {
  const converted = convertMixin(parse(legacy));
  assert.equal(converted.schemaVersion, "3");
  assert.equal(converted.kind, "mixin");
  const capabilities = converted.capabilities as { type: string; config: unknown }[];
  assert.deepEqual(capabilities[0], {
    type: "com.docker.sandbox/lifecycle@1",
    config: {
      install: [
        {
          command: 'cd "$WORKSPACE_DIR" && npm ci',
          user: "1000",
          description: "Install the project's locked Node.js dependencies",
          env: ["WORKSPACE_DIR"],
        },
      ],
    },
  });
  assert.deepEqual(capabilities[1], {
    type: "com.docker.sandbox/network-policy@1",
    config: {
      install: { allow: ["registry.npmjs.org"] },
      runtime: { allow: ["registry.npmjs.org"] },
    },
  });
  assert.deepEqual(capabilities[2], {
    type: "com.docker.sandbox/agent-context@1",
    config: {
      content: "Project dependencies are installed with npm ci when the sandbox is created.\n",
    },
  });
});

test("migrate environment and local kit in place once, keeping exact backups", (t) => {
  const f = fixture(t);
  migrateProject([f.env], [], "sbx-kit-pi");
  const content = fs.readFileSync(f.env, "utf8");
  assert.match(content, /# Keep this comment/);
  assert.deepEqual(parse(content), { ...parse(f.source), agent: "sbx-kit-pi" });
  assert.equal(fs.readFileSync(f.env + ".v2.bak", "utf8"), f.source);
  assert.equal(fs.readFileSync(f.spec + ".v2.bak", "utf8"), legacy);
  assert.equal(fs.existsSync(f.spec), false);
  const target = path.join(f.kit, "tools.yaml");
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.deepEqual(parse(fs.readFileSync(target, "utf8")), convertMixin(parse(legacy)));
  migrateProject([f.env], [], "sbx-kit-pi");
  assert.equal(fs.readFileSync(f.env, "utf8"), content);
});

test("unsupported settings fail before any environment or kit is changed", (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.spec, "volumes: []\n");
  assert.throws(() => migrateProject([f.env], [], "sbx-kit-pi"), /unsupported/);
  assert.equal(fs.readFileSync(f.env, "utf8"), f.source);
  assert.equal(fs.existsSync(f.env + ".v2.bak"), false);
  assert.match(fs.readFileSync(f.spec, "utf8"), /volumes/);
  assert.throws(
    () => convertMixin({ schemaVersion: "2", kind: "sandbox" }),
    /Only schema-v2 mixins/,
  );
});

test("refuse backup collisions, descriptor collisions and symlinked source files", (t) => {
  const f = fixture(t);
  for (const collision of [f.env + ".v2.bak", path.join(f.kit, "tools.yaml")]) {
    fs.writeFileSync(collision, "user data");
    assert.throws(() => migrateProject([f.env], [], "sbx-kit-pi"), /Refusing to overwrite/);
    assert.equal(fs.readFileSync(collision, "utf8"), "user data");
    assert.equal(fs.readFileSync(f.env, "utf8"), f.source);
    fs.unlinkSync(collision);
  }
  fs.renameSync(f.spec, f.spec + ".original");
  fs.symlinkSync(f.spec + ".original", f.spec);
  assert.throws(() => migrateProject([f.env], [], "sbx-kit-pi"), /non-regular/);
  assert.equal(fs.readFileSync(f.env, "utf8"), f.source);
});

test("TOML and CLI resolved paths migrate local kits, not remote references", (t) => {
  const f = fixture(t);
  migrateProject([], ["docker.io/acme/tools:1", "https://example.com/kit", f.kit], "sbx-kit-pi");
  assert.equal(fs.existsSync(f.spec), false);
  assert.equal(fs.readFileSync(f.env, "utf8"), f.source);
});
