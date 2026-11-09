import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GIT_REVIEW_COMMAND } from "../scripts/host-rpc-handlers.mts";

const [python, ...args] = GIT_REVIEW_COMMAND;
const gtk = spawnSync(python, [...args, "--check"], { timeout: 5000 });
const xvfb = spawnSync("xvfb-run", ["--help"], { timeout: 5000 });
const xauth = spawnSync("xauth", ["-V"], { timeout: 5000 });

test(
  "native GTK review supports safe coloring, selection/copy and explicit approval",
  {
    skip:
      gtk.status !== 0 || xvfb.status !== 0 || xauth.status !== 0
        ? "Requires python3-gi, gir1.2-gtk-4.0, xvfb and xauth for headless GTK tests"
        : false,
  },
  () => {
    const result = spawnSync(
      "xvfb-run",
      ["-a", python, "-I", fileURLToPath(new URL("./git-review.test.py", import.meta.url))],
      {
        env: { ...process.env, GDK_BACKEND: "x11" },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stderr}`);
  },
);
