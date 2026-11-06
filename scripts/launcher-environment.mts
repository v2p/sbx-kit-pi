import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isMap, parse, parseDocument, stringify } from "yaml";
import type { ResolvedConfig } from "./launcher-types.mts";
import { errorMessage, hasErrorCode, isObject } from "./runtime-validation.mts";

type EnvironmentMetadata = Partial<Record<"schemaVersion" | "agent" | "name", unknown>>;

// Inspect only the fields the launcher needs. Docker owns validation, merging,
// argument expansion, path resolution, approval, and provisioning.
export function inspectEnvironment(files: string[], agent: string): EnvironmentMetadata {
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
  if (result.agent !== undefined && result.agent !== agent) {
    throw new Error(`sbx-pi requires agent: ${agent}; use sbx env for other agents`);
  }
  return result;
}

function writePrivateYaml(file: string, value: unknown, header = ""): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, header + stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function writeNetworkKit(config: ResolvedConfig, directory: string): string | null {
  if (!config.networkAllow.length) {
    return null;
  }
  // Keep v3 sources separate from persisted network-kit/spec.yaml artifacts:
  // that reserved filename would force sbx to use its legacy parser.
  const kit = path.join(directory, "network-policy");
  writePrivateYaml(
    path.join(kit, "network-policy.yaml"),
    {
      schemaVersion: "3",
      kind: "mixin",
      capabilities: [
        {
          type: "com.docker.sandbox/network-policy@1",
          config: {
            install: { allow: config.networkAllow },
            runtime: { allow: config.networkAllow },
          },
        },
      ],
    },
    "# syntax=docker/sandbox-kit:3\n",
  );
  return kit;
}

export function writeEnvironmentOverlay(
  config: ResolvedConfig,
  directory: string,
  sessionDir: string,
  importDir: string | null,
): string {
  const agent = path.basename(config.baseKitDirectory);
  const metadata = inspectEnvironment(config.environmentFiles, agent);
  const overlay: {
    agent: string;
    kits: string[];
    additionalWorkspaces: { path: string }[];
    schemaVersion?: string;
    name?: string | null;
  } = {
    agent,
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

// Only launches write project configuration. Preserve all unrelated YAML fields
// and comments; refuse indirect writes and concurrent launcher edits.
export function saveEnvironment(file: string, kits: string[] | undefined, agent: string): boolean {
  const lock = `${file}.lock`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new Error(
        `Configuration is locked: ${lock}. Check for another launcher or a stale lock.`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) {
      throw new Error(`Refusing to replace non-regular environment file: ${file}`);
    }
    let content: string;
    let changed = false;
    if (existing) {
      const source = fs.readFileSync(file, "utf8");
      const document = parseDocument(source);
      if (document.errors.length || !isMap(document.contents)) {
        throw new Error(`${file}: environment must be valid YAML with a mapping`);
      }
      if (
        kits === undefined ||
        JSON.stringify(document.toJS().kits ?? []) === JSON.stringify(kits)
      ) {
        return false;
      }
      document.set("kits", kits);
      content = document.toString();
      changed = true;
    } else {
      content =
        "# Docker Sandbox settings. sbx-pi adds its Pi kit and persistent session mount.\n" +
        stringify({ schemaVersion: "1", agent, workspace: ".", kits: kits ?? [] });
      changed = kits !== undefined && kits.length > 0;
    }
    fs.writeFileSync(temporary, content, {
      flag: "wx",
      mode: existing ? existing.mode & 0o777 : 0o644,
    });
    if (existing) {
      // writeFileSync's mode is filtered by the current umask.
      fs.chmodSync(temporary, existing.mode & 0o777);
      fs.renameSync(temporary, file);
    } else {
      // Publish without overwriting a file created since the existence check.
      fs.linkSync(temporary, file);
    }
    console.error(`${existing ? "Updated" : "Created"} ${file}`);
    return changed;
  } finally {
    fs.rmSync(temporary, { force: true });
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}
