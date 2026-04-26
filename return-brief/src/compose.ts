import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Scene } from "./types.js";

export interface ComposeInput {
	sceneId: string;
	videoPath: string;
	audioPath: string;
	durationMs: number;
	question?: Scene["question"];
}

export interface ComposeResult {
	videoPath: string;
	questionsPath: string;
	timeline: { sceneId: string; startMs: number; endMs: number; question?: Scene["question"] }[];
}

function run(bin: string, args: string[]): void {
	const r = spawnSync(bin, args, { stdio: "pipe" });
	if (r.status !== 0) {
		const err = (r.stderr?.toString() ?? "").slice(-1200);
		throw new Error(`${bin} failed (${r.status}): ${err}`);
	}
}

function muxSceneWithAudio(input: ComposeInput, outPath: string): void {
	// Pad the video with the last frame to audio length, then mux.
	const pad = input.question ? 800 : 0;
	const targetMs = Math.max(input.durationMs, 0) + pad;
	const targetSec = (targetMs / 1000).toFixed(2);
	run("ffmpeg", [
		"-y",
		"-i", input.videoPath,
		"-i", input.audioPath,
		"-filter_complex",
		`[0:v]tpad=stop_mode=clone:stop_duration=${targetSec}[v];[1:a]apad,atrim=0:${targetSec},loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
		"-map", "[v]",
		"-map", "[a]",
		"-c:v", "libx264",
		"-pix_fmt", "yuv420p",
		"-r", "30",
		"-c:a", "aac",
		"-b:a", "192k",
		"-shortest",
		"-movflags", "+faststart",
		outPath,
	]);
}

export function composeReturnVideo(
	inputs: ComposeInput[],
	outDir: string,
	finalPath: string,
	questionsPath: string,
): ComposeResult {
	mkdirSync(outDir, { recursive: true });
	const partPaths: string[] = [];
	const timeline: ComposeResult["timeline"] = [];
	let cursor = 0;

	for (const input of inputs) {
		const part = resolve(outDir, `${input.sceneId}.part.mp4`);
		muxSceneWithAudio(input, part);
		partPaths.push(part);
		const pad = input.question ? 800 : 0;
		const dur = input.durationMs + pad;
		timeline.push({
			sceneId: input.sceneId,
			startMs: cursor,
			endMs: cursor + dur,
			question: input.question,
		});
		cursor += dur;
	}

	const listPath = resolve(outDir, "concat.txt");
	writeFileSync(listPath, partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
	mkdirSync(dirname(finalPath), { recursive: true });
	run("ffmpeg", [
		"-y",
		"-f", "concat",
		"-safe", "0",
		"-i", listPath,
		"-c", "copy",
		"-movflags", "+faststart",
		finalPath,
	]);

	mkdirSync(dirname(questionsPath), { recursive: true });
	writeFileSync(
		questionsPath,
		JSON.stringify(
			{
				videoPath: finalPath,
				totalDurationMs: cursor,
				questions: timeline
					.filter((t) => t.question)
					.map((t) => ({
						sceneId: t.sceneId,
						timestampMs: t.startMs,
						endMs: t.endMs,
						question: t.question,
					})),
				timeline,
			},
			null,
			2,
		),
	);

	return { videoPath: finalPath, questionsPath, timeline };
}

export function loadQuestions(questionsPath: string): {
	videoPath: string;
	totalDurationMs: number;
	questions: { sceneId: string; timestampMs: number; endMs: number; question: Scene["question"] }[];
} {
	if (!existsSync(questionsPath)) throw new Error(`questions.json not found at ${questionsPath}`);
	return JSON.parse(readFileSync(questionsPath, "utf8"));
}
