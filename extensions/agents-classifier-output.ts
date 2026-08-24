import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Range = Type.Object({
	startLine: Type.Integer({ minimum: 1 }),
	endLine: Type.Integer({ minimum: 1 }),
});

const Classification = Type.Object({
	always: Type.Array(Range, { description: "Source line ranges classified as ALWAYS" }),
	onDemand: Type.Array(
		Type.Object({
			name: Type.String({ description: "Agent Skill name using lowercase letters, digits, and hyphens" }),
			description: Type.String({ description: "What the skill contains and exactly when it must be loaded" }),
			ranges: Type.Array(Range, { minItems: 1 }),
		}),
	),
	drop: Type.Array(
		Type.Object({
			reason: Type.String({ description: "Why these instructions are generic or repository-discoverable" }),
			ranges: Type.Array(Range, { minItems: 1 }),
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "submit_agents_classification",
		label: "Submit AGENTS.md classification",
		description:
			"Submit the final, exhaustive line-range classification. Every source line must occur exactly once across ALWAYS, ON_DEMAND, and DROP. Call this tool as the final action.",
		parameters: Classification,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: "AGENTS.md classification submitted" }],
				details: params,
				terminate: true,
			};
		},
	});
}
