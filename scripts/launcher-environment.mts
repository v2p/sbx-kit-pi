import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import type { ResolvedConfig } from "./launcher-types.mts";
import { errorMessage, hasErrorCode, isObject } from "./runtime-validation.mts";

type EnvironmentMetadata = Partial<Record<"schemaVersion" | "agent" | "name", unknown>>;

// Inspect only the fields the launcher needs. Docker owns validation, merging,
// argument expansion, path resolution, approval, and provisioning.
export function inspectEnvironment(files: string[]): EnvironmentMetadata {
  const result: EnvironmentMetadata = {};
  for (const file of files) {
    let value: unknown;
    try {
      value = parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`${file}: ${errorMessage(error)}`, { cause: error });
    }
    if (!isObject(value)) {
      throw new Error(`${file}: environment must be a YAML mapping`);
    }
    for (const key of ["schemaVersion", "agent", "name"] as const) {
      if (Object.hasOwn(value, key)) {
        result[key] = value[key];
      }
    }
  }
  if (result.agent !== undefined && result.agent !== "pi-openai-codex") {
    throw new Error("sbx-pi requires agent: pi-openai-codex; use sbx env for other agents");
  }
  return result;
}

function writePrivateYaml(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function writeNetworkKit(config: ResolvedConfig, directory: string): string | null {
  if (!config.networkAllow.length) {
    return null;
  }
  const kit = path.join(directory, "network-kit");
  writePrivateYaml(path.join(kit, "spec.yaml"), {
    schemaVersion: "2",
    kind: "mixin",
    name: "sbx-pi-network",
    permissions: { network: { allow: config.networkAllow } },
  });
  return kit;
}

export function writeEnvironmentOverlay(
  config: ResolvedConfig,
  directory: string,
  sessionDir: string,
  importDir: string | null,
): string {
  const metadata = inspectEnvironment(config.environmentFiles);
  const overlay: {
    agent: string;
    kits: string[];
    additionalWorkspaces: { path: string }[];
    schemaVersion?: string;
    name?: string | null;
  } = {
    agent: "pi-openai-codex",
    kits: [config.baseKitDirectory],
    additionalWorkspaces: [{ path: sessionDir }],
  };
  if (metadata.schemaVersion === undefined) {
    overlay.schemaVersion = "1";
  }
  const networkKit = writeNetworkKit(config, directory);
  if (networkKit) {
    overlay.kits.push(networkKit);
  }
  if (metadata.name === undefined) {
    overlay.name = config.sandboxName;
  }
  // The entrypoint deletes the staged credential immediately after importing it.
  // Only this private copy is writable; the original Codex file is never mounted.
  if (importDir) {
    overlay.additionalWorkspaces.push({ path: importDir });
  }
  // Keep the path stable across launches: Docker records approval by environment
  // identity, including ordered file paths. Never write into the agent workspace.
  const file = path.join(directory, "pi.sbxenv.yaml");
  writePrivateYaml(file, overlay);
  return file;
}

export function kitEntrypoint(root: string): string[] {
  const spec: unknown = parse(fs.readFileSync(path.join(root, "spec.yaml"), "utf8"));
  if (
    !isObject(spec) ||
    !isObject(spec.sandbox) ||
    !Array.isArray(spec.sandbox.entrypoint) ||
    !spec.sandbox.entrypoint.every((arg: unknown) => typeof arg === "string")
  ) {
    throw new Error("Kit sandbox.entrypoint must be a string array");
  }
  return spec.sandbox.entrypoint;
}

export function initializeEnvironment(file: string, kits: string[]): string {
  const content =
    "# Docker Sandbox settings. sbx-pi adds its Pi kit and persistent session mount.\n" +
    stringify({ schemaVersion: "1", agent: "pi-openai-codex", workspace: ".", kits });
  try {
    fs.writeFileSync(file, content, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(`Refusing to overwrite ${file}`, { cause: error });
    }
    throw error;
  }
  return content;
}
