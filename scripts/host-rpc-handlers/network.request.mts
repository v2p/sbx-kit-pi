import { main } from "./main.mts";
import type { HandlerResult } from "../host-rpc-protocol.mts";

export async function handle(): Promise<HandlerResult> {
  // The listener already recorded the accepted request before invoking us.
  // A request for manual review is not a grant of network access.
  return { status: "recorded" };
}

await main(import.meta.url, handle);
