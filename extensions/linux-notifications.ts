import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const sandboxName = clean(process.env.SANDBOX_NAME, "Pi sandbox");

function clean(value: string | undefined, fallback: string): string {
	const cleaned = value?.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
	return (cleaned || fallback).slice(0, 160);
}

async function enqueueNotification(notificationFile: string, title: string, body: string): Promise<void> {
	if (!isAbsolute(notificationFile)) return;

	let queue;
	try {
		queue = await open(notificationFile, constants.O_WRONLY | constants.O_APPEND);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
		throw error;
	}

	try {
		await queue.writeFile(`${clean(title, "Pi finished")}\t${clean(body, sandboxName)}\n`);
	} finally {
		await queue.close();
	}
}

export default function (pi: ExtensionAPI) {
	let jobActive = false;

	pi.on("agent_start", () => {
		jobActive = true;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!jobActive || !ctx.isIdle()) return;
		jobActive = false;

		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		const projectName = clean(basename(process.env.WORKSPACE_DIR || ctx.cwd), "project");
		const sessionName = clean(pi.getSessionName(), "");
		const body = sessionName ? `${sessionName} · ${sandboxName}` : sandboxName;

		try {
			await enqueueNotification(
				join(dirname(sessionFile), ".notifications.queue"),
				`Pi finished · ${projectName}`,
				body,
			);
		} catch (error) {
			console.error(`[linux-notifications] ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
