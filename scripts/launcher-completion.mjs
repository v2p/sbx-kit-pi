#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

function aliases() {
  try {
    const file = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "sbx-pi",
      "config.toml",
    );
    const config = parse(fs.readFileSync(file, "utf8"));
    const table = config.kit_aliases;
    if (
      config.schema_version !== 1 ||
      !table ||
      typeof table !== "object" ||
      Array.isArray(table)
    ) {
      return [];
    }
    return Object.keys(table).filter(
      (name) =>
        /^[a-zA-Z0-9_-]+$/.test(name) &&
        typeof table[name] === "string" &&
        table[name].trim() &&
        !table[name].startsWith("@"),
    );
  } catch {
    // Missing or invalid personal configuration must not interrupt shell completion.
    return [];
  }
}

function complete(args) {
  const current = args.at(-1) ?? "";
  const previous = args.slice(0, -1);
  let mode = "run";
  if (previous[0] === "completion") {
    return ["words", previous.length === 1 ? ["zsh"] : []];
  }
  if (previous[0] === "config") {
    previous.shift();
    if (previous.length === 0) {
      return ["words", ["show", "alias"]];
    }
    mode = previous.shift();
    if (!["show", "alias"].includes(mode)) {
      return ["words", []];
    }
  } else if (["init", "status"].includes(previous[0])) {
    mode = previous.shift();
  }

  if (mode === "alias") {
    const positional = previous.filter((arg) => arg !== "--replace");
    if (positional.length > 2 || positional.some((arg) => arg.startsWith("--"))) {
      return ["words", []];
    }
    if (current.startsWith("-")) {
      return ["words", previous.includes("--replace") ? [] : ["--replace"]];
    }
    if (positional.length === 0) {
      return ["words", aliases()];
    }
    if (positional.length === 1) {
      return ["files", []];
    }
    return ["words", previous.includes("--replace") ? [] : ["--replace"]];
  }

  const options = ["--kit", "--no-kits", "--help"];
  if (mode !== "init") {
    options.push("--config", "--no-config");
  }
  if (mode === "run") {
    options.push("--recreate", "--import-codex-auth");
  }
  for (let i = 0; i < previous.length; i++) {
    const option = previous[i];
    if (!options.includes(option)) {
      // Stop at the Pi passthrough boundary, including an explicit -- separator.
      return ["words", []];
    }
    if (option === "--kit" || option === "--config") {
      if (i === previous.length - 1) {
        if (option === "--kit" && current.startsWith("@")) {
          return ["words", aliases().map((name) => `@${name}`)];
        }
        return ["files", []];
      }
      i++;
    }
  }
  return [
    "words",
    mode === "run" && previous.length === 0
      ? ["init", "config", "status", "completion", ...options]
      : options,
  ];
}

const args = process.argv.slice(2);
const [kind, candidates] = complete(args);
const prefix = args.at(-1) ?? "";
// Only the kind marker and safe single-line words cross the shell protocol.
console.log([kind, ...candidates.filter((word) => word.startsWith(prefix))].join("\n"));
