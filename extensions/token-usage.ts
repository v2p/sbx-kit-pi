import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}

export default function (pi: ExtensionAPI) {
	pi.on("turn_end", (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "assistant") return;

		const usage = event.message.usage;
		const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
		const total = usage.totalTokens || prompt + usage.output;
		let promptBreakdown = "";

		if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
			const parts = [`new ${formatTokens(usage.input)}`];
			if (usage.cacheRead > 0) parts.push(`cached ${formatTokens(usage.cacheRead)}`);
			if (usage.cacheWrite > 0) parts.push(`cache write ${formatTokens(usage.cacheWrite)}`);
			promptBreakdown = ` (${parts.join(", ")})`;
		}

		const reasoning = usage.reasoning ? ` (reasoning ${formatTokens(usage.reasoning)})` : "";
		ctx.ui.notify(
			`tokens · prompt ${formatTokens(prompt)}${promptBreakdown}` +
				` · output ${formatTokens(usage.output)}${reasoning}` +
				` · total ${formatTokens(total)}`,
			"info",
		);
	});
}
