import { main } from "./main.mjs";

export async function handle() {
  // The listener already recorded the accepted request before invoking us.
  // A request for manual review is not a grant of network access.
  return { status: "recorded" };
}

await main(import.meta.url, handle);
