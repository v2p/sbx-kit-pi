import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { main } from "./main.mjs";

const execute = promisify(execFile);

export async function handle({ request }) {
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
