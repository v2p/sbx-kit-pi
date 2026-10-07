import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { METHODS, isMethod, validResult } from "./host-rpc-protocol.mts";
import type { Method, HostRequest, HostHandlers, HandlerResult } from "./host-rpc-protocol.mts";
import { isObject } from "./runtime-validation.mts";

export type Command = [executable: string, ...args: string[]];
export type HandlerCommands = Record<Method, Command[]>;

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "host-rpc-handlers");
const names = Object.values(METHODS);
const MAX_HANDLERS = 8;
const HANDLER_TIMEOUT_MS = 2000;
const MAX_OUTPUT_BYTES = 4096;

export function defaultCommand(method: Method): Command {
  return [process.execPath, path.join(directory, `${method}.mts`)];
}

function validCommand(value: unknown): value is Command {
  if (!Array.isArray(value)) {
    return false;
  }
  const argv: unknown[] = value;
  return (
    argv.length > 0 &&
    argv.every(
      (arg: unknown) =>
        typeof arg === "string" &&
        // eslint-disable-next-line no-control-regex
        !/[\x00-\x1f\x7f]/.test(arg),
    ) &&
    typeof argv[0] === "string" &&
    Boolean(argv[0].trim()) &&
    (argv[0] !== "default" || argv.length === 1)
  );
}

function validChain(value: unknown): value is Command[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_HANDLERS &&
    value.every(validCommand)
  );
}

// Only host-owned configuration can supply commands. Never derive argv from requests.
export function resolveHandlers(config: unknown = {}, cwd: string): HandlerCommands {
  if (!isObject(config)) {
    throw new Error("host_rpc handlers must be a table of built-in methods");
  }
  const validated: Partial<HandlerCommands> = {};
  for (const [method, chain] of Object.entries(config)) {
    if (!isMethod(method) || !validChain(chain)) {
      throw new Error("host_rpc handlers must contain 1–8 command arrays per built-in method");
    }
    validated[method] = chain;
  }
  return Object.fromEntries(
    names.map((method) => {
      const chain: Command[] = validated[method] ?? [["default"]];
      return [
        method,
        chain.map((command): Command => {
          if (command[0] === "default") {
            return defaultCommand(method);
          }
          const [executable, ...args] = command;
          return [executable.includes("/") ? path.resolve(cwd, executable) : executable, ...args];
        }),
      ];
    }),
  ) as HandlerCommands;
}

function executableAvailable(command: string): boolean {
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

export function notificationAvailable(commands: Command[]): boolean {
  const reference = defaultCommand(METHODS.NOTIFICATION_SEND);
  const usesReference = commands.some(
    (command) =>
      command.length === reference.length && command.every((arg, i) => arg === reference[i]),
  );
  return !usesReference || executableAvailable("notify-send");
}

function execute(command: Command, input: string, cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // execFile does not forward detached to spawn. Own a real process group.
    const child = spawn(command[0], command.slice(1), {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let settled = false;
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
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      terminate();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Host handler timed out")), timeout);
    for (const stream of [child.stdout, child.stderr]) {
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          fail(new Error("Host handler output exceeds limit"));
        } else if (stream === child.stdout) {
          output.push(chunk);
        }
      });
      stream.on("error", fail);
    }
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      // Clean up descendants even when the parent exits successfully early.
      terminate();
      if (code !== 0 || signal) {
        fail(new Error("Host handler exited unsuccessfully"));
      }
    });
    child.once("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        terminate();
        resolve(Buffer.concat(output).toString("utf8"));
      }
    });
    // An early exit may close stdin before the small input has been written.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function createHandlers(
  commands: HandlerCommands,
  { cwd, sandbox, workspace }: { cwd: string; sandbox: string; workspace: string },
): HostHandlers {
  return Object.fromEntries(
    names.map((method) => [
      method,
      async (request: HostRequest): Promise<HandlerResult> => {
        const input = JSON.stringify({ request, context: { sandbox, workspace } }) + "\n";
        const deadline = performance.now() + HANDLER_TIMEOUT_MS;
        let status: HandlerResult["status"] = "recorded";
        for (const command of commands[method]) {
          const remaining = Math.ceil(deadline - performance.now());
          if (remaining <= 0) {
            throw new Error("Host handler chain timed out");
          }
          const result: unknown = JSON.parse(await execute(command, input, cwd, remaining));
          if (!validResult(result)) {
            throw new Error("Invalid host handler result");
          }
          if (result.status === "performed") {
            status = "performed";
          }
        }
        return { status };
      },
    ]),
  ) as HostHandlers;
}
