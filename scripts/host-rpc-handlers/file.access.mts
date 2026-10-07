import { main } from "./main.mts";
import type { HandlerResult } from "../host-rpc-protocol.mts";

export async function handle(): Promise<HandlerResult> {
  // The listener already recorded this untrusted observation. Never open its path.
  return { status: "recorded" };
}

await main(import.meta.url, handle);
