import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import { isObject } from "./runtime-validation.mts";

function mapping(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${label}: unsupported v2 settings; convert manually before launching`);
  }
  return value;
}

export function convertMixin(value: unknown): Record<string, unknown> {
  const spec = mapping(
    value,
    [
      "schemaVersion",
      "kind",
      "name",
      "displayName",
      "description",
      "setup",
      "permissions",
      "agentInstructions",
    ],
    "Kit",
  );
  if (spec.schemaVersion !== "2" || spec.kind !== "mixin") {
    throw new Error("Only schema-v2 mixins can be converted automatically");
  }
  const capabilities: Record<string, unknown>[] = [];
  if (spec.setup !== undefined) {
    const setup = mapping(spec.setup, ["install"], "setup");
    if (!Array.isArray(setup.install)) {
      throw new Error("setup.install must be an array");
    }
    const install = setup.install.map((value: unknown) => {
      const step = mapping(value, ["command", "user", "description"], "setup.install step");
      if (typeof step.command !== "string") {
        throw new Error("Install command must be a string");
      }
      // v2 ran project hooks in the workspace; v3 hooks start outside it.
      return { ...step, command: `cd "$WORKSPACE_DIR" && ${step.command}`, env: ["WORKSPACE_DIR"] };
    });
    capabilities.push({ type: "com.docker.sandbox/lifecycle@1", config: { install } });
  }
  if (spec.permissions !== undefined) {
    const permissions = mapping(spec.permissions, ["network"], "permissions");
    const network = mapping(permissions.network, ["allow"], "permissions.network");
    if (
      !Array.isArray(network.allow) ||
      !network.allow.every((host: unknown) => typeof host === "string")
    ) {
      throw new Error("permissions.network.allow must be a string array");
    }
    capabilities.push({
      type: "com.docker.sandbox/network-policy@1",
      config: { install: network, runtime: network },
    });
  }
  if (spec.agentInstructions !== undefined) {
    const context = mapping(spec.agentInstructions, ["filename", "content"], "agentInstructions");
    if (Object.values(context).some((value) => typeof value !== "string")) {
      throw new Error("agentInstructions values must be strings");
    }
    capabilities.push({ type: "com.docker.sandbox/agent-context@1", config: context });
  }
  return {
    schemaVersion: "3",
    kind: "mixin",
    ...(spec.displayName !== undefined ? { displayName: spec.displayName } : {}),
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    capabilities,
  };
}

function readDocument(file: string) {
  const source = fs.readFileSync(file, "utf8");
  const document = parseDocument(source);
  if (document.errors.length) {
    throw new Error(`${file}: ${document.errors[0].message}`);
  }
  return { source, document };
}

// Prepare every conversion before writing anything. Never overwrite backups or
// existing v3 descriptors. A backup remains even if a subsequent write fails.
export function migrateProject(files: string[], kits: string[], agent: string): void {
  const changes = new Map<string, { source: string; target: string; content: string }>();
  const inspectKit = (reference: string, directory: string) => {
    if (!reference.startsWith(".") && !path.isAbsolute(reference)) {
      return;
    }
    const kit = path.resolve(directory, reference);
    const file = path.join(kit, "spec.yaml");
    if (changes.has(file) || !fs.existsSync(file)) {
      return;
    }
    const { source, document } = readDocument(file);
    const value: unknown = document.toJS();
    if (!isObject(value) || value.schemaVersion !== "2") {
      return;
    }
    if (path.basename(kit) === "spec") {
      throw new Error(`Rename kit directory ${kit} before migration: spec.yaml is reserved for v2`);
    }
    const content = "# syntax=docker/sandbox-kit:3\n" + stringify(convertMixin(value));
    changes.set(file, { source, target: path.join(kit, `${path.basename(kit)}.yaml`), content });
  };
  for (const file of files) {
    const { source, document } = readDocument(file);
    const value: unknown = document.toJS();
    if (!isObject(value)) {
      throw new Error(`${file}: environment must be a mapping`);
    }
    if (value.agent === "pi-openai-codex") {
      document.set("agent", agent);
      changes.set(file, { source, target: file, content: document.toString() });
    }
    if (Array.isArray(value.kits)) {
      for (const kit of value.kits) {
        if (typeof kit === "string") {
          inspectKit(kit, path.dirname(file));
        }
      }
    }
  }
  for (const kit of kits) {
    inspectKit(kit, process.cwd());
  }
  for (const [file, change] of changes) {
    if (!fs.lstatSync(file).isFile()) {
      throw new Error(`Refusing to migrate non-regular file: ${file}`);
    }
    for (const target of [file + ".v2.bak", ...(change.target !== file ? [change.target] : [])]) {
      if (fs.lstatSync(target, { throwIfNoEntry: false })) {
        throw new Error(`Refusing to overwrite ${target} during migration`);
      }
    }
  }
  for (const [file, change] of changes) {
    fs.writeFileSync(file + ".v2.bak", change.source, { flag: "wx", mode: fs.statSync(file).mode });
    if (change.target === file) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, change.content, { flag: "wx", mode: fs.statSync(file).mode });
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    } else {
      fs.writeFileSync(change.target, change.content, { flag: "wx", mode: fs.statSync(file).mode });
      // spec.yaml would select Docker's legacy parser even alongside v3 YAML.
      fs.unlinkSync(file);
    }
    console.error(`Migrated ${file} to ${change.target} (backup: ${file}.v2.bak)`);
  }
}
