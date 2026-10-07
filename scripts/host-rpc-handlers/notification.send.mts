import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { main } from "./main.mts";
import type { HandlerInput } from "./main.mts";
import type { HandlerResult } from "../host-rpc-protocol.mts";

const execute = promisify(execFile);

export async function handle({ request }: HandlerInput): Promise<HandlerResult> {
  if (request.method !== "notification.send") {
    throw new Error("Expected notification.send request");
  }
  const { title, body } = request.params;
  await execute(
    "notify-send",
    [
      "--app-name=Pi",
      "--",
      title,
      body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    ],
    { timeout: 2000, maxBuffer: 4096 },
  );
  return { status: "performed" };
}

await main(import.meta.url, handle);
