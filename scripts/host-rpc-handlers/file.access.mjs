import { main } from "./main.mjs";

export async function handle() {
  // The listener already recorded this untrusted observation. Never open its path.
  return { status: "recorded" };
}

await main(import.meta.url, handle);
