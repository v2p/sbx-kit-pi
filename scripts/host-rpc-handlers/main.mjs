import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Reference handlers are importable for tests and runnable as standalone scripts.
export async function main(url, handle) {
  if (!process.argv[1] || url !== pathToFileURL(resolve(process.argv[1])).href) {
    return;
  }
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    const result = await handle(JSON.parse(input));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
