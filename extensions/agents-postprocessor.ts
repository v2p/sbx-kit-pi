import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CLASSIFIER_PROMPT = `For every instruction in the source, classify it as:

ALWAYS
Required before the agent can correctly reason about the sandbox,
or prevents a high-impact/recurrent mistake.

ON_DEMAND
Operational or troubleshooting information needed only for a
recognizable class of tasks. Move it to an Agent Skill.

DROP
Generic software-development guidance that the agent already knows,
or information that should be discovered from the repository itself.

Rules:
- Do not drop any Docker Sandbox-specific behavior.
- Preserve exact commands, paths, environment variables and error semantics.
- Prefer moving procedural explanations to skills rather than summarizing them.
- AGENTS.md must contain enough routing information for the model to know
  which skill to load and when.

Keep ALWAYS intentionally small. Normal environment persistence and PATH procedures,
login-shell recovery, Git/GitHub authentication, pushing and pull requests, and direct
versus clone workspace operation are recognizable task classes and belong in skills.
A short critical invariant may remain ALWAYS when violating it can break the sandbox;
move its explanation, examples, diagnosis, and recovery procedure to a skill.

Classify every numbered source line exactly once, including headings and blank lines.
Prefer 3–5 cohesive skills over many narrowly scoped skills: normally group related
networking procedures together and related Git/GitHub/workspace procedures together.
Use one concise sentence for each skill description, focused on when to load it.
Submit only line ranges through submit_agents_classification, then stop.`;

interface Range {
	startLine: number;
	endLine: number;
}

interface Classification {
	always: Range[];
	onDemand: Array<{ name: string; description: string; ranges: Range[] }>;
	drop: Array<{ reason: string; ranges: Range[] }>;
}

interface ClassifiedSource extends Classification {
	lines: string[];
}

interface GeneratedFiles {
	slim: string;
	skills: Record<string, string>;
}

interface State {
	sourceHash: string;
	processedHash: string;
	promptHash: string;
}

const promptHash = hash(CLASSIFIER_PROMPT);

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function atomicWrite(file: string, content: string, mode = 0o644): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, content, { mode });
	fs.renameSync(temporary, file);
}

function findAgentsFile(workspace: string): string | undefined {
	let directory = path.resolve(workspace);
	while (true) {
		const candidate = path.join(directory, "AGENTS.md");
		if (
			fs.existsSync(candidate) &&
			fs.readFileSync(candidate, "utf8").includes("This is a Docker Sandbox with Docker access and passwordless sudo.")
		) {
			return candidate;
		}
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function statePaths(agentsFile: string) {
	const key = hash(fs.realpathSync(agentsFile)).slice(0, 16);
	const directory = path.join(path.dirname(agentsFile), ".sbx-kit-pi", "agents", key);
	return {
		state: path.join(directory, "state.json"),
		source: path.join(directory, "AGENTS.original.md"),
		classification: path.join(directory, "classification.json"),
	};
}

function validateRange(range: Range, lineCount: number, coverage: number[]): void {
	if (
		!Number.isInteger(range.startLine) ||
		!Number.isInteger(range.endLine) ||
		range.startLine < 1 ||
		range.endLine < range.startLine ||
		range.endLine > lineCount
	) {
		throw new Error(`invalid line range ${range.startLine}-${range.endLine}`);
	}
	for (let line = range.startLine; line <= range.endLine; line++) coverage[line - 1]++;
}

function validateClassification(source: string, classification: Classification): ClassifiedSource {
	const lines = source.split("\n");
	const coverage = new Array(lines.length).fill(0);
	const names = new Set<string>();

	for (const range of classification.always) validateRange(range, lines.length, coverage);
	for (const skill of classification.onDemand) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64) {
			throw new Error(`invalid skill name: ${skill.name}`);
		}
		if (names.has(skill.name)) throw new Error(`duplicate skill name: ${skill.name}`);
		if (!skill.description.trim() || skill.description.length > 1024) {
			throw new Error(`invalid skill description: ${skill.name}`);
		}
		names.add(skill.name);
		for (const range of skill.ranges) validateRange(range, lines.length, coverage);
	}
	for (const dropped of classification.drop) {
		for (const range of dropped.ranges) validateRange(range, lines.length, coverage);
	}

	const invalid = coverage.flatMap((count, index) => (count === 1 ? [] : [index + 1]));
	if (invalid.length > 0) throw new Error(`source lines must be classified exactly once: ${invalid.join(", ")}`);
	return { ...classification, lines };
}

function extract(lines: string[], ranges: Range[]): string {
	return ranges.map(({ startLine, endLine }) => lines.slice(startLine - 1, endLine).join("\n")).join("\n\n").trim();
}

function render(classified: ClassifiedSource): GeneratedFiles {
	const always = extract(classified.lines, classified.always);
	const routing = classified.onDemand
		.map(({ name, description }) => `- \`${name}\`: ${description.trim()}`)
		.join("\n");
	const skills: Record<string, string> = {};
	for (const skill of classified.onDemand) {
		skills[skill.name] = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description.trim())}\n---\n\n# ${skill.name}\n\n${extract(classified.lines, skill.ranges)}\n`;
	}
	return {
		slim: `# Docker Sandbox Guidance\n\n${always}\n\n## Load on demand\n\n${routing}\n`,
		skills,
	};
}

function writeSkills(skillsDirectory: string, skills: Record<string, string>): void {
	fs.rmSync(skillsDirectory, { recursive: true, force: true });
	for (const [name, content] of Object.entries(skills)) {
		atomicWrite(path.join(skillsDirectory, name, "SKILL.md"), content);
	}
}

function loadCache(agentsFile: string, skillsDirectory: string): { source: string; slim: string } | undefined {
	const files = statePaths(agentsFile);
	if (![files.state, files.source, files.classification].every(fs.existsSync)) return undefined;
	const state = JSON.parse(fs.readFileSync(files.state, "utf8")) as State;
	const current = fs.readFileSync(agentsFile, "utf8");
	if (state.promptHash !== promptHash || hash(current) !== state.processedHash) return undefined;
	const source = fs.readFileSync(files.source, "utf8");
	if (hash(source) !== state.sourceHash) return undefined;
	const classified = validateClassification(
		source,
		JSON.parse(fs.readFileSync(files.classification, "utf8")) as Classification,
	);
	const generated = render(classified);
	writeSkills(skillsDirectory, generated.skills);
	return { source, slim: generated.slim };
}

function sourceToClassify(agentsFile: string): string {
	const files = statePaths(agentsFile);
	if (fs.existsSync(files.state) && fs.existsSync(files.source)) {
		const state = JSON.parse(fs.readFileSync(files.state, "utf8")) as State;
		const current = fs.readFileSync(agentsFile, "utf8");
		if (hash(current) === state.processedHash) return fs.readFileSync(files.source, "utf8");
	}
	return fs.readFileSync(agentsFile, "utf8");
}

function applyClassification(
	agentsFile: string,
	skillsDirectory: string,
	source: string,
	classification: Classification,
): { source: string; slim: string } {
	const generated = render(validateClassification(source, classification));
	const files = statePaths(agentsFile);
	atomicWrite(files.source, source, 0o600);
	atomicWrite(files.classification, `${JSON.stringify(classification, null, 2)}\n`, 0o600);
	writeSkills(skillsDirectory, generated.skills);
	atomicWrite(agentsFile, generated.slim, fs.statSync(agentsFile).mode & 0o777);
	atomicWrite(
		files.state,
		`${JSON.stringify({ sourceHash: hash(source), processedHash: hash(generated.slim), promptHash }, null, 2)}\n`,
		0o600,
	);
	return { source, slim: generated.slim };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return /^(node|bun)(\.exe)?$/.test(path.basename(process.execPath).toLowerCase())
		? { command: "pi", args }
		: { command: process.execPath, args };
}

function numberedSource(source: string): string {
	return source
		.split("\n")
		.map((line, index) => `${index + 1}: ${JSON.stringify(line)}`)
		.join("\n");
}

function selectedModel(model: { provider?: string; id?: string } | undefined): string | undefined {
	if (!model?.provider || !model?.id) return undefined;
	if (model.provider === "unknown" || model.id === "unknown") return undefined;
	return `${model.provider}/${model.id}`;
}

async function classify(source: string, cwd: string, model?: string): Promise<Classification> {
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agents-classifier-"));
	const promptFile = path.join(temporary, "SYSTEM.md");
	await fs.promises.writeFile(promptFile, CLASSIFIER_PROMPT, { mode: 0o600 });
	const classifierExtension = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents-classifier-output.ts");
	const args = [
		"--mode", "json", "--print", "--no-session",
		"--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
		"--no-extensions", "--no-builtin-tools",
		"--extension", classifierExtension,
		"--tools", "submit_agents_classification",
		"--system-prompt", promptFile,
		"--thinking", "max",
	];
	if (model) args.push("--model", model);
	args.push(`Classify this AGENTS.md source:\n\n${numberedSource(source)}`);

	try {
		return await new Promise<Classification>((resolve, reject) => {
			const invocation = getPiInvocation(args);
			const child = spawn(invocation.command, invocation.args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";
			let stderr = "";
			let result: Classification | undefined;
			const consume = (record: string) => {
				if (!record.trim()) return;
				const event = JSON.parse(record);
				if (event.message?.toolName === "submit_agents_classification") result = event.message.details;
			};
			child.stdout.on("data", (chunk) => {
				buffer += chunk.toString();
				const records = buffer.split("\n");
				buffer = records.pop() ?? "";
				for (const record of records) consume(record);
			});
			child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
			child.on("error", reject);
			child.on("close", (code) => {
				if (buffer.trim()) consume(buffer);
				if (code !== 0) reject(new Error(`classifier exited ${code}: ${stderr.trim()}`));
				else if (!result) reject(new Error(`classifier returned no structured result: ${stderr.trim()}`));
				else resolve(result);
			});
		});
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true });
	}
}

export default function (pi: ExtensionAPI) {
	const sessionDirectory = argument("--session-dir") ?? path.join(os.homedir(), ".pi", "agent", "sessions");
	const skillsDirectory = path.join(sessionDirectory, "skills");
	let replacement: { source: string; slim: string } | undefined;
	let pending: Promise<{ source: string; slim: string } | undefined> | undefined;
	let authNoticeShown = false;

	const notifyError = (ctx: ExtensionContext, error: unknown) => {
		const message = `AGENTS.md classification failed: ${(error as Error).message}`;
		console.error(message);
		ctx.ui.notify(message, "error");
	};

	const processAgentsFile = async (ctx: ExtensionContext): Promise<{ source: string; slim: string } | undefined> => {
		if (replacement) return replacement;
		const agentsFile = findAgentsFile(ctx.cwd);
		if (!agentsFile) return undefined;
		const cached = loadCache(agentsFile, skillsDirectory);
		if (cached) return cached;

		const model = selectedModel(ctx.model);
		if (!model) return undefined;
		if (!ctx.modelRegistry.getProviderAuthStatus(ctx.model!.provider).configured) {
			if (!authNoticeShown) {
				ctx.ui.notify(
					"Docker Sandbox AGENTS.md classification will run after /login openai-codex and model selection.",
					"info",
				);
				authNoticeShown = true;
			}
			return undefined;
		}

		const source = sourceToClassify(agentsFile);
		ctx.ui.notify("Classifying Docker Sandbox AGENTS.md with Pi… this can take a minute.", "info");
		const progress = setTimeout(() => {
			ctx.ui.notify("Still classifying Docker Sandbox AGENTS.md…", "info");
		}, 30_000);
		try {
			replacement = applyClassification(agentsFile, skillsDirectory, source, await classify(source, ctx.cwd, model));
			ctx.ui.notify("Docker Sandbox AGENTS.md classification complete; guidance moved to on-demand skills.", "info");
			return replacement;
		} catch (error) {
			if (/No API key found for the selected model/.test((error as Error).message)) {
				ctx.ui.notify(
					"Docker Sandbox AGENTS.md classification will run after /login openai-codex and model selection.",
					"info",
				);
				authNoticeShown = true;
				return undefined;
			}
			throw error;
		} finally {
			clearTimeout(progress);
		}
	};

	const ensureProcessed = (ctx: ExtensionContext): Promise<{ source: string; slim: string } | undefined> => {
		pending ??= processAgentsFile(ctx).finally(() => {
			pending = undefined;
		});
		return pending;
	};

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload") return;
		try {
			await ensureProcessed(ctx);
		} catch (error) {
			notifyError(ctx, error);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		try {
			await ensureProcessed(ctx);
		} catch (error) {
			notifyError(ctx, error);
		}
	});

	pi.on("resources_discover", () => ({ skillPaths: [skillsDirectory] }));
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const processed = replacement ?? (await ensureProcessed(ctx));
			if (processed && event.systemPrompt.includes(processed.source)) {
				return { systemPrompt: event.systemPrompt.replace(processed.source, processed.slim) };
			}
		} catch (error) {
			notifyError(ctx, error);
		}
	});
}
