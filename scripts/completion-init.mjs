#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const [command, shell, ...extra] = process.argv.slice(2);
  if (!shell || extra.length || !["bash", "zsh"].includes(shell)) {
    throw new Error("Usage: sbx-pi completion bash|zsh");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(command ?? "")) {
    throw new Error("Completion requires a simple installed executable name");
  }
  // Executable names are validated above before interpolation into shell code.
  if (shell === "bash") {
    const source = fs.readFileSync(path.join(root, "completions/bash/sbx-pi"), "utf8");
    process.stdout.write(`${source}\ncomplete -F _sbx_pi_complete '${command}'\n`);
  } else {
    const source = fs.readFileSync(path.join(root, "completions/zsh/_sbx-pi"), "utf8");
    process.stdout.write(
      `if (( $+functions[compdef] )); then\n` +
        `_sbx_pi_complete() {\n${source}}\n` +
        `compdef _sbx_pi_complete '${command}'\n` +
        `else\nprint -u2 -- 'sbx-pi completion: initialize compinit before evaluating Zsh integration'\nfi\n`,
    );
  }
} catch (error) {
  console.error(`sbx-pi: ${error.message}`);
  process.exitCode = 2;
}
