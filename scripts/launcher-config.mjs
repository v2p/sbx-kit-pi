#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";
import {
  inspectEnvironment,
  writeEnvironmentOverlay,
  initializeEnvironment,
  kitEntrypoint,
  writeNetworkKit,
} from "./launcher-environment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const home = os.homedir();

function string(value, label) {
  // Reject control characters before passing configuration through the NUL-delimited protocol.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be a nonempty string without control characters`);
  }
  return value;
}

function load(file, global = false) {
  let config;
  try {
    config = parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`, { cause: error });
  }
  const allowed = global
    ? ["schema_version", "notifications", "kit_aliases"]
    : ["schema_version", "notifications", "kits", "network"];
  for (const key of Object.keys(config)) {
    if (!allowed.includes(key)) {
      throw new Error(`${file}: unknown setting ${key}`);
    }
  }
  if (config.schema_version !== 1) {
    throw new Error(`${file}: schema_version must be 1`);
  }
  if (config.notifications !== undefined && !["auto", "on", "off"].includes(config.notifications)) {
    throw new Error(`${file}: notifications must be auto, on, or off`);
  }
  if (config.network !== undefined) {
    if (
      !config.network ||
      typeof config.network !== "object" ||
      Array.isArray(config.network) ||
      Object.keys(config.network).some((key) => key !== "allow") ||
      !Array.isArray(config.network.allow)
    ) {
      throw new Error(`${file}: network must contain only an allow array`);
    }
    config.network.allow.forEach((value) => string(value, `${file}: network host`));
  }
  if (config.kits !== undefined) {
    if (!Array.isArray(config.kits)) {
      throw new Error(`${file}: kits must be an array`);
    }
    config.kits.forEach((value) => string(value, `${file}: kit`));
  }
  if (config.kit_aliases !== undefined) {
    if (
      !config.kit_aliases ||
      typeof config.kit_aliases !== "object" ||
      Array.isArray(config.kit_aliases)
    ) {
      throw new Error(`${file}: kit_aliases must be a table`);
    }
    for (const [name, value] of Object.entries(config.kit_aliases)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error(`${file}: invalid alias ${name}`);
      }
      string(value, `${file}: alias ${name}`);
      if (value.startsWith("@")) {
        throw new Error(`${file}: aliases cannot reference aliases`);
      }
    }
  }
  return config;
}

function globalConfigFile() {
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
    "sbx-pi",
    "config.toml",
  );
}

function createAlias(args) {
  const replace = args.includes("--replace");
  const positional = args.filter((arg) => arg !== "--replace");
  if (positional.length !== 2 || args.length !== positional.length + Number(replace)) {
    throw new Error("Usage: sbx-pi config alias NAME KIT [--replace]");
  }
  const [name, reference] = positional;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      "Alias names must contain only letters, digits, underscores, or hyphens (without @)",
    );
  }
  string(reference, "Kit reference");
  if (reference.startsWith("@")) {
    throw new Error("Aliases cannot reference aliases");
  }
  if (name.startsWith("--") || reference.startsWith("--")) {
    throw new Error("Usage: sbx-pi config alias NAME KIT [--replace]");
  }
  // Unlike hand-written global TOML, command-line paths are invocation-relative.
  const ref =
    reference.startsWith(".") || path.isAbsolute(reference)
      ? path.resolve(fs.realpathSync(process.cwd()), reference)
      : reference;
  const file = globalConfigFile();
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Global configuration is locked: ${lock}. Retry, or remove a stale lock after checking no alias command is running.`,
        { cause: error },
      );
    }
    throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) {
      throw new Error(`Refusing to replace non-regular configuration file: ${file}`);
    }
    const config = existing ? load(file, true) : { schema_version: 1 };
    if (Object.hasOwn(config.kit_aliases ?? {}, name) && !replace) {
      throw new Error(`Kit alias @${name} already exists; use --replace to change it`);
    }
    config.kit_aliases = { ...config.kit_aliases, [name]: ref };
    fs.writeFileSync(temporary, stringify(config) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
  console.log(`Saved @${name} = ${JSON.stringify(ref)} in ${file}`);
}

function resolve(args, initialize = false) {
  const cwd = fs.realpathSync(process.cwd());
  let projectFile,
    disabled = initialize,
    cliKits;
  const environmentFiles = [];
  const nativeArguments = [];
  let cliHosts;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--config":
        if (initialize) {
          throw new Error(
            "init always creates sbxenv.yaml in the current directory; --config is not supported",
          );
        }
        projectFile = path.resolve(cwd, string(args[++i], "--config"));
        break;
      case "--allow-host":
        if (initialize) {
          throw new Error("init does not accept --allow-host; use sbx-pi.toml");
        }
        (cliHosts ??= []).push(string(args[++i], "--allow-host"));
        break;
      case "--env-arg":
      case "--env-args-file": {
        if (initialize) {
          throw new Error("init does not accept environment arguments");
        }
        const option = args[i];
        const value = string(args[++i], option);
        nativeArguments.push(
          option,
          option === "--env-args-file" ? path.resolve(cwd, value) : value,
        );
        break;
      }
      case "--env": {
        if (initialize) {
          throw new Error("init does not accept --env");
        }
        let file = path.resolve(cwd, string(args[++i], "--env"));
        if (fs.statSync(file).isDirectory()) {
          file = path.join(file, "sbxenv.yaml");
        }
        environmentFiles.push(file);
        break;
      }
      case "--no-config":
        if (initialize) {
          throw new Error("init does not discover project manifests; --no-config is not supported");
        }
        disabled = true;
        break;
      case "--kit":
        (cliKits ??= []).push(string(args[++i], "--kit"));
        break;
      case "--no-kits":
        cliKits = [];
        break;
      default:
        throw new Error(`Unknown configuration option: ${args[i]}`);
    }
  }
  if (disabled && (projectFile || environmentFiles.length)) {
    throw new Error("--config/--env and --no-config cannot be combined");
  }
  if (projectFile && environmentFiles.length) {
    throw new Error("--config and --env cannot be combined; put sbx-pi.toml beside sbxenv.yaml");
  }
  let projectDirectory = projectFile ? path.dirname(projectFile) : cwd;
  if (environmentFiles.length) {
    projectDirectory = path.dirname(environmentFiles[0]);
    const candidate = path.join(projectDirectory, "sbx-pi.toml");
    if (fs.existsSync(candidate)) {
      projectFile = candidate;
    }
  } else if (!disabled && !projectFile) {
    let dir = cwd;
    while (true) {
      const candidate = path.join(dir, "sbx-pi.toml");
      const environment = path.join(dir, "sbxenv.yaml");
      if (fs.existsSync(candidate) || fs.existsSync(environment)) {
        projectDirectory = dir;
        if (fs.existsSync(candidate)) {
          projectFile = candidate;
        }
        if (fs.existsSync(environment)) {
          environmentFiles.push(environment);
        }
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  if (!disabled && projectFile && !environmentFiles.length) {
    const sibling = path.join(path.dirname(projectFile), "sbxenv.yaml");
    if (fs.existsSync(sibling)) {
      environmentFiles.push(sibling);
    }
  }
  const globalFile = globalConfigFile();
  const global = fs.existsSync(globalFile) ? load(globalFile, true) : {};
  const project = projectFile ? load(projectFile) : {};
  const workspace = fs.realpathSync(projectDirectory);
  const environment = environmentFiles.length ? inspectEnvironment(environmentFiles) : null;
  const networkAllow = cliHosts ?? project.network?.allow ?? [];
  if (!environment && nativeArguments.length) {
    throw new Error("Environment arguments require sbxenv.yaml or --env");
  }
  if (environment && (project.kits !== undefined || cliKits !== undefined)) {
    throw new Error(
      "With sbxenv.yaml, configure kits in YAML; remove TOML kits and do not use --kit/--no-kits",
    );
  }
  const resolveReference = (ref, dir) => {
    if (ref.startsWith("@")) {
      const alias = ref.slice(1);
      if (!Object.hasOwn(global.kit_aliases ?? {}, alias)) {
        throw new Error(`Unknown kit alias: ${ref}`);
      }
      return resolveReference(global.kit_aliases[alias], path.dirname(globalFile));
    }
    return ref.startsWith(".") || path.isAbsolute(ref) ? path.resolve(dir, ref) : ref;
  };
  // CLI paths are relative to the invocation directory.
  const kits = (cliKits ?? project.kits ?? []).map((ref) => {
    if (cliKits !== undefined && !ref.startsWith("@")) {
      return workspace !== cwd && ref.startsWith(".") ? path.resolve(cwd, ref) : ref;
    }
    return resolveReference(ref, workspace);
  });
  let notifications =
    process.env.SBX_PI_NOTIFICATIONS ?? project.notifications ?? global.notifications ?? "auto";
  notifications = String(notifications).toLowerCase();
  const notificationValues = new Map([
    ["1", "on"],
    ["true", "on"],
    ["on", "on"],
    ["0", "off"],
    ["false", "off"],
    ["off", "off"],
    ["auto", "auto"],
  ]);
  notifications = notificationValues.get(notifications);
  if (!notifications) {
    throw new Error("Invalid SBX_PI_NOTIFICATIONS value (expected auto, on, or off)");
  }
  const suffix = execFileSync("git", ["hash-object", "--stdin"], {
    input: workspace,
    encoding: "utf8",
  })
    .trim()
    .slice(0, 12);
  const projectName = path.basename(workspace);
  const defaultSandboxName = `pi-openai-codex-${projectName}-${suffix}`;
  // Parameterized names are resolved by Docker, never by this launcher.
  const sandboxName =
    environment?.name === undefined
      ? defaultSandboxName
      : typeof environment.name === "string" && !environment.name.includes("${{")
        ? string(environment.name, "Environment name")
        : null;
  const baseKitFingerprint = hash(fs.readFileSync(path.join(root, "spec.yaml")));
  const fingerprint = hash(
    JSON.stringify({
      workspace,
      kits: kits.map((ref) => resolveReference(ref, workspace)),
      baseKitFingerprint,
      networkAllow,
    }),
  );
  return {
    schemaVersion: 1,
    workspace,
    projectFile: projectFile ?? null,
    globalFile: fs.existsSync(globalFile) ? globalFile : null,
    kits,
    environmentFiles,
    nativeArguments,
    networkAllow,
    baseKitDirectory: root,
    notifications,
    sandboxName,
    baseKitVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
    baseKitFingerprint,
    fingerprint,
    stateFile: path.join(
      process.env.XDG_STATE_HOME || path.join(home, ".local", "state"),
      "sbx-pi",
      "sandboxes",
      `${environment ? `${defaultSandboxName}-env-${hash(JSON.stringify(environmentFiles)).slice(0, 12)}` : defaultSandboxName}.json`,
    ),
  };
}

function initializeProject(args) {
  const config = resolve(args, true);
  const file = path.join(config.workspace, "sbxenv.yaml");
  const kits = config.kits.map((ref) => {
    if (!ref.startsWith(".") && !path.isAbsolute(ref)) {
      return ref;
    }
    const relative = path.relative(config.workspace, path.resolve(config.workspace, ref));
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error(
        `Cannot persist host-only kit path: ${ref}. Place local kits inside the project or use a pinned remote reference.`,
      );
    }
    return `./${relative.split(path.sep).join("/")}`;
  });
  const content = initializeEnvironment(file, kits);
  console.log(`Created ${file}\n\n${content}`);
}

function applied(config) {
  try {
    return JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "entrypoint") {
    process.stdout.write(kitEntrypoint(root).join("\0") + "\0");
  } else if (command === "alias") {
    createAlias(args);
  } else if (command === "init") {
    initializeProject(args);
  } else if (
    ["fields", "environment", "network-kit", "record", "compare", "forget"].includes(command)
  ) {
    const config = JSON.parse(fs.readFileSync(args[0], "utf8"));
    if (command === "fields") {
      process.stdout.write(
        [
          config.workspace,
          config.notifications,
          config.sandboxName,
          config.projectFile ?? "",
          config.environmentFiles.length ? "native" : "legacy",
          ...config.kits,
        ].join("\0") + "\0",
      );
    } else if (command === "network-kit") {
      process.stdout.write(
        writeNetworkKit(
          config,
          path.join(path.dirname(config.stateFile), path.basename(config.stateFile, ".json")),
        ) ?? "",
      );
    } else if (command === "environment") {
      const overlay = writeEnvironmentOverlay(
        config,
        path.join(path.dirname(config.stateFile), path.basename(config.stateFile, ".json")),
        args[1],
        args[2] || null,
      );
      process.stdout.write([...config.environmentFiles, overlay].join("\0") + "\0");
    } else if (command === "forget") {
      fs.rmSync(config.stateFile, { force: true });
    } else if (command === "record") {
      fs.mkdirSync(path.dirname(config.stateFile), { recursive: true, mode: 0o700 });
      const temporary = `${config.stateFile}.${randomUUID()}.tmp`;
      fs.writeFileSync(
        temporary,
        JSON.stringify({ ...config, appliedAt: new Date().toISOString() }, null, 2) + "\n",
        { mode: 0o600 },
      );
      fs.renameSync(temporary, config.stateFile);
    } else {
      const previous = applied(config);
      if (config.environmentFiles.length) {
        if (previous && previous.fingerprint !== config.fingerprint) {
          console.error(
            "Pi kit or supplemental network settings changed; run sbx-pi --recreate to apply. Docker manages native environment changes.",
          );
        }
      } else if (!previous && config.projectFile) {
        console.error(
          "Applied configuration is unknown for this sandbox. Attaching without changes; run sbx-pi --recreate to apply the project manifest.",
        );
      } else if (previous && previous.fingerprint !== config.fingerprint) {
        console.error(
          "Project configuration differs from this sandbox. Attaching without changes; run sbx-pi --recreate to apply.",
        );
      }
    }
  } else {
    const config = resolve(args);
    if (command === "resolve" || command === "show") {
      console.log(JSON.stringify(config, null, 2));
    } else if (command === "status") {
      const names = execFileSync("sbx", ["ls", "-q"], { encoding: "utf8" }).split(/\r?\n/);
      if (config.environmentFiles.length) {
        console.log(
          JSON.stringify(
            {
              sandbox: config.sandboxName,
              projectDirectory: config.workspace,
              status:
                config.sandboxName === null
                  ? "unknown"
                  : names.includes(config.sandboxName)
                    ? "exists"
                    : "not-created",
              managedBy: "sbx env",
              environmentFiles: config.environmentFiles,
              hint: "Use sbx-pi plan to inspect Docker's environment plan; creation-only changes require --recreate.",
            },
            null,
            2,
          ),
        );
        process.exit(0);
      }
      const previous = applied(config);
      console.log(
        JSON.stringify(
          {
            sandbox: config.sandboxName,
            workspace: config.workspace,
            status: !names.includes(config.sandboxName)
              ? "not-created"
              : !previous
                ? "unknown"
                : previous.fingerprint === config.fingerprint
                  ? "current"
                  : "drifted",
            appliedAt: previous?.appliedAt ?? null,
            desiredKits: config.kits,
            appliedKits: previous?.kits ?? null,
          },
          null,
          2,
        ),
      );
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  }
} catch (error) {
  console.error(`sbx-pi: ${error.message}`);
  process.exitCode = 2;
}
