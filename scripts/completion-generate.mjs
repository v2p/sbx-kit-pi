#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const [command, shell, ...extra] = process.argv.slice(2);
  if (shell !== "zsh" || extra.length) {
    throw new Error("Usage: sbx-pi completion zsh");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(command ?? "")) {
    throw new Error("Completion requires a simple installed executable name");
  }
  const source = fs.readFileSync(path.join(root, "completions/zsh/_sbx-pi"), "utf8");
  // compinit discovers this header in the user-generated autoload file.
  process.stdout.write(`#compdef ${command}\n\n${source}`);
} catch (error) {
  console.error(`sbx-pi: ${error.message}`);
  process.exitCode = 2;
}
