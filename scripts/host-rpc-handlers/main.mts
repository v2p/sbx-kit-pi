import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validRequest, validHostRequest } from "../host-rpc-protocol.mts";
import type { HostRequest, HandlerResult } from "../host-rpc-protocol.mts";
import { isObject, errorMessage } from "../runtime-validation.mts";

export interface HandlerInput {
  request: HostRequest;
  context: { sandbox: string; workspace: string };
}

// Reference handlers are importable for tests and runnable as standalone scripts.
export async function main(
  url: string,
  handle: (input: HandlerInput) => Promise<HandlerResult>,
): Promise<void> {
  if (!process.argv[1] || url !== pathToFileURL(resolve(process.argv[1])).href) {
    return;
  }
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    const value: unknown = JSON.parse(input);
    if (
      !isObject(value) ||
      !validRequest(value.request) ||
      !validHostRequest(value.request) ||
      !isObject(value.context) ||
      typeof value.context.sandbox !== "string" ||
      typeof value.context.workspace !== "string"
    ) {
      throw new Error("Invalid host handler input");
    }
    const result = await handle({
      request: value.request,
      context: { sandbox: value.context.sandbox, workspace: value.context.workspace },
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
