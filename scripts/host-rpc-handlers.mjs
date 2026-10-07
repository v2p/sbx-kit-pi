import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { METHODS } from "./host-rpc-protocol.mjs";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "host-rpc-handlers");
const names = Object.values(METHODS);
const MAX_HANDLERS = 8;
const HANDLER_TIMEOUT_MS = 2000;
const MAX_OUTPUT_BYTES = 4096;

export function defaultCommand(method) {
  return [process.execPath, path.join(directory, `${method}.mjs`)];
}

// Only host-owned configuration can supply commands. Never derive argv from requests.
export function resolveHandlers(config = {}, cwd) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("host_rpc handlers must be a table of built-in methods");
  }
  for (const [method, chain] of Object.entries(config)) {
    if (
      !names.includes(method) ||
      !Array.isArray(chain) ||
      chain.length < 1 ||
      chain.length > MAX_HANDLERS ||
      chain.some(
        (command) =>
          !Array.isArray(command) ||
          command.length < 1 ||
          command.some(
            (arg) =>
              typeof arg !== "string" ||
              // eslint-disable-next-line no-control-regex
              /[\x00-\x1f\x7f]/.test(arg),
          ) ||
          !command[0].trim() ||
          (command[0] === "default" && command.length !== 1),
      )
    ) {
      throw new Error("host_rpc handlers must contain 1–8 command arrays per built-in method");
    }
  }
  return Object.fromEntries(
    names.map((method) => [
      method,
      (config[method] ?? [["default"]]).map((command) => {
        if (command[0] === "default") {
          return defaultCommand(method);
        }
        const [executable, ...args] = command;
        return [executable.includes("/") ? path.resolve(cwd, executable) : executable, ...args];
      }),
    ]),
  );
}

function executableAvailable(command) {
  return (process.env.PATH ?? "").split(path.delimiter).some((directory) => {
    // Ignore relative PATH entries: the workspace must not supply host executables.
    if (!path.isAbsolute(directory)) {
      return false;
    }
    const file = path.join(directory, command);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

export function notificationAvailable(commands) {
  const reference = defaultCommand(METHODS.NOTIFICATION_SEND);
  const usesReference = commands.some(
    (command) =>
      command.length === reference.length && command.every((arg, i) => arg === reference[i]),
  );
  return !usesReference || executableAvailable("notify-send");
}

function execute(command, input, cwd, timeout) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command[0],
      command.slice(1),
      { cwd, timeout, detached: true, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout) => {
        clearTimeout(timer);
        terminate();
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
    // On POSIX, own the process group too: a child retaining a pipe must not
    // keep a timed-out handler alive. Also clean up descendants on early exit.
    const terminate = () => {
      if (!child.pid) {
        return;
      }
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      } catch {
        // The process/group may already have exited.
      }
    };
    const timer = setTimeout(terminate, timeout);
    // An early exit may close stdin before the small input has been written.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function createHandlers(commands, { cwd, sandbox, workspace }) {
  return Object.fromEntries(
    names.map((method) => [
      method,
      async (request) => {
        const input = JSON.stringify({ request, context: { sandbox, workspace } }) + "\n";
        const deadline = performance.now() + HANDLER_TIMEOUT_MS;
        let status = "recorded";
        for (const command of commands[method]) {
          const remaining = Math.ceil(deadline - performance.now());
          if (remaining <= 0) {
            throw new Error("Host handler chain timed out");
          }
          const result = JSON.parse(await execute(command, input, cwd, remaining));
          if (
            !result ||
            Object.keys(result).length !== 1 ||
            !["recorded", "performed"].includes(result.status)
          ) {
            throw new Error("Invalid host handler result");
          }
          if (result.status === "performed") {
            status = "performed";
          }
        }
        return { status };
      },
    ]),
  );
}
