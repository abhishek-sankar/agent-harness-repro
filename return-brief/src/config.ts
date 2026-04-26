import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RuntimeConfig {
	extensionRoot: string;
	repoRoot: string;
	outputsDir: string;
	appBaseUrl: string;
	githubTokenSet: boolean;
	elevenLabsKeySet: boolean;
	elevenLabsVoiceId: string;
	elevenLabsModelId: string;
	allowTtsFallback: boolean;
	loadedEnvFiles: string[];
}

const loaded = new Set<string>();
const initiallyDefined = new Set(Object.keys(process.env));

function parseEnvLine(line: string): [string, string] | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;
	const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
	if (!match) return undefined;
	const key = match[1];
	let value = match[2].trim();
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	return [key, value];
}

export function loadEnvFiles(paths: string[]): string[] {
	const seenThisCall: string[] = [];
	for (const raw of paths) {
		const path = resolve(raw);
		if (!existsSync(path)) continue;
		const lines = readFileSync(path, "utf8").split(/\r?\n/);
		for (const line of lines) {
			const parsed = parseEnvLine(line);
			if (!parsed) continue;
			const [key, value] = parsed;
			if (!initiallyDefined.has(key)) process.env[key] = value;
		}
		loaded.add(path);
		seenThisCall.push(path);
	}
	return seenThisCall;
}

export function getLoadedEnvFiles(): string[] {
	return Array.from(loaded.values());
}

export function normalizeBaseUrl(url: string | undefined): string {
	return (url || "http://localhost:3000").replace(/\/$/, "");
}

export function getRuntimeConfig(opts: {
	extensionRoot: string;
	repoRoot: string;
	outputsDir: string;
}): RuntimeConfig {
	return {
		extensionRoot: opts.extensionRoot,
		repoRoot: opts.repoRoot,
		outputsDir: opts.outputsDir,
		appBaseUrl: normalizeBaseUrl(process.env.APP_BASE_URL),
		githubTokenSet: !!process.env.GITHUB_TOKEN,
		elevenLabsKeySet: !!process.env.ELEVENLABS_API_KEY,
		elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
		elevenLabsModelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
		allowTtsFallback: process.env.RETURN_BRIEF_ALLOW_TTS_FALLBACK === "1",
		loadedEnvFiles: getLoadedEnvFiles(),
	};
}

export function maskSet(value: boolean): string {
	return value ? "<set>" : "<missing>";
}
