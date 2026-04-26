import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { Scene } from "./types.js";

export interface RecordResult {
	sceneId: string;
	videoPath: string;
	durationMs: number;
}

export async function recordSceneVideo(opts: {
	sceneId: string;
	htmlPath: string;
	videoPath: string;
	durationMs: number;
}): Promise<RecordResult> {
	const { chromium } = await import("playwright");
	mkdirSync(dirname(opts.videoPath), { recursive: true });
	const tmpDir = resolve(dirname(opts.videoPath), `.rec-${opts.sceneId}`);
	mkdirSync(tmpDir, { recursive: true });

	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		recordVideo: { dir: tmpDir, size: { width: 1280, height: 800 } },
	});
	const page = await context.newPage();
	await page.goto(pathToFileURL(opts.htmlPath).toString());
	await page.waitForLoadState("networkidle");
	await page.waitForTimeout(opts.durationMs);
	const video = page.video();
	await page.close();
	await context.close();
	await browser.close();

	const webm = video ? await video.path() : null;
	if (!webm) {
		rmSync(tmpDir, { recursive: true, force: true });
		throw new Error(`No video captured for ${opts.sceneId}`);
	}

	// Transcode webm → mp4 (h264) for concat compatibility.
	const mp4 = opts.videoPath;
	const tx = spawnSync("ffmpeg", [
		"-y",
		"-i", webm,
		"-c:v", "libx264",
		"-pix_fmt", "yuv420p",
		"-r", "30",
		"-movflags", "+faststart",
		"-an",
		mp4,
	], { stdio: "ignore" });

	rmSync(tmpDir, { recursive: true, force: true });
	if (tx.status !== 0) throw new Error(`ffmpeg transcode failed for ${opts.sceneId}`);

	return { sceneId: opts.sceneId, videoPath: mp4, durationMs: opts.durationMs };
}

export function writeHtml(htmlPath: string, html: string): void {
	mkdirSync(dirname(htmlPath), { recursive: true });
	writeFileSync(htmlPath, html);
}

/**
 * Unified recorder that dispatches to the right implementation based on scene kind:
 *  - app_walkthrough → recordWalkthroughScene (live app via Playwright)
 *  - everything else → recordSceneVideo (static local HTML file)
 *
 * @param scene   The scene to record
 * @param htmlPath  Path to the pre-rendered HTML (used for non-walkthrough scenes)
 * @param videoPath  Destination mp4 path
 * @param durationMs  Recording duration (set by narration length)
 */
export async function recordScene(opts: {
	scene: Scene;
	htmlPath: string;
	videoPath: string;
	durationMs: number;
	diagnosticsPath?: string;
}): Promise<RecordResult> {
	if (opts.scene.kind === "app_walkthrough" && opts.scene.walkthroughStep) {
		const { recordWalkthroughScene } = await import("./walkthrough.js");
		return recordWalkthroughScene({
			sceneId: opts.scene.id,
			step: opts.scene.walkthroughStep,
			videoPath: opts.videoPath,
			durationMs: opts.durationMs,
			diagnosticsPath: opts.diagnosticsPath,
			caption: process.env.ELEVENLABS_API_KEY ? undefined : opts.scene.narration,
		});
	}
	return recordSceneVideo({
		sceneId: opts.scene.id,
		htmlPath: opts.htmlPath,
		videoPath: opts.videoPath,
		durationMs: opts.durationMs,
	});
}
