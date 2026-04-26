/**
 * Playwright-based live-app walkthrough recorder.
 *
 * Unlike record.ts (which opens a local file:// HTML slide), this module
 * navigates to a real running web app (APP_BASE_URL) and records the result:
 *
 *   1. Navigate to the target URL.
 *   2. If a CSS selector is provided, scroll to that section and briefly
 *      highlight it with a subtle blue outline.
 *   3. For "full" scroll scenes, do a smooth auto-scroll through the whole page.
 *   4. Transcode the Playwright webm output → h264 mp4 for ffmpeg compatibility.
 *
 * The durationMs drives how long we record — it's set by the narration length
 * returned from ElevenLabs (or the silent fallback duration).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { WalkthroughStep } from "./ui-mapper.js";

export interface WalkthroughRecordResult {
	sceneId: string;
	videoPath: string;
	durationMs: number;
}

export async function recordWalkthroughScene(opts: {
	sceneId: string;
	step: WalkthroughStep;
	videoPath: string;
	/** Target recording duration; we pad the last frame if the page settles early */
	durationMs: number;
	diagnosticsPath?: string;
	label?: string;
	caption?: string;
}): Promise<WalkthroughRecordResult> {
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
	const consoleErrors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => consoleErrors.push(err.message));

	try {
		// ── 1. Navigate ────────────────────────────────────────────────────────
		await page.goto(opts.step.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
		await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
		await page.waitForFunction(
			() => {
				const text = document.body?.innerText?.trim() ?? "";
				const root = document.querySelector("#root");
				return text.length > 20 || (root?.children.length ?? 0) > 0;
			},
			undefined,
			{ timeout: 12_000 },
		);
		if (opts.label) await injectLabel(page, opts.label);
		if (opts.caption) await injectCaption(page, opts.caption);
		await page.waitForTimeout(opts.step.waitAfterNavMs);
		await runPreRecordActions(page, opts.step.preRecordActions ?? []);

		const elapsed = opts.step.waitAfterNavMs;
		const remaining = Math.max(opts.durationMs - elapsed, 2000);

		// ── 2. Section highlight (if a selector is provided) ──────────────────
		if (opts.step.scrollBehavior === "section" && opts.step.selector) {
			try {
				const locator = page.locator(opts.step.selector).first();
				await locator.scrollIntoViewIfNeeded({ timeout: 4000 });
				await page.waitForTimeout(600);

				// Subtle, temporary highlight so it's clear what changed.
				await page.evaluate((sel: string) => {
					const el = document.querySelector<HTMLElement>(sel);
					if (!el) return;
					const prev = el.style.outline;
					const prevTransition = el.style.transition;
					el.style.transition = "outline 200ms ease";
					el.style.outline = "2px solid rgba(99, 179, 237, 0.7)";
					setTimeout(() => {
						el.style.outline = prev;
						el.style.transition = prevTransition;
					}, 2500);
				}, opts.step.selector);

				await page.waitForTimeout(Math.max(remaining - 600, 1500));
			} catch {
				// Selector not found → fall through to slow scroll.
				await smoothScroll(page, remaining);
			}
		}

		// ── 3. Full-page slow scroll ───────────────────────────────────────────
		if (opts.step.scrollBehavior === "full" || opts.step.scrollBehavior === "top") {
			if (opts.step.scrollBehavior === "full") {
				await smoothScroll(page, remaining);
			} else {
				await page.waitForTimeout(remaining);
			}
		}

		// ── 4. Finalise recording ─────────────────────────────────────────────
		const video = page.video();
		await page.close();
		await context.close();
		await browser.close();

		const webm = video ? await video.path() : null;
		if (!webm) {
			rmSync(tmpDir, { recursive: true, force: true });
			throw new Error(`No video captured for walkthrough scene ${opts.sceneId}`);
		}

		// Transcode webm → mp4 (h264/yuv420p) for ffmpeg concat compatibility.
		const mp4 = opts.videoPath;
		const tx = spawnSync(
			"ffmpeg",
			["-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
				"-movflags", "+faststart", "-an", mp4],
			{ stdio: "ignore" },
		);

		rmSync(tmpDir, { recursive: true, force: true });
		if (tx.status !== 0) throw new Error(`ffmpeg transcode failed for ${opts.sceneId}`);

		return { sceneId: opts.sceneId, videoPath: mp4, durationMs: opts.durationMs };
	} catch (err) {
		const screenshotPath = resolve(dirname(opts.videoPath), `${opts.sceneId}.failure.png`);
		await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
		await page.close().catch(() => undefined);
		await context.close().catch(() => undefined);
		await browser.close().catch(() => undefined);
		rmSync(tmpDir, { recursive: true, force: true });
		const diagnostics = {
			sceneId: opts.sceneId,
			url: opts.step.url,
			preRecordActions: opts.step.preRecordActions ?? [],
			error: err instanceof Error ? err.message : String(err),
			consoleErrors,
			screenshotPath,
			checkedAt: new Date().toISOString(),
		};
		if (opts.diagnosticsPath) {
			mkdirSync(dirname(opts.diagnosticsPath), { recursive: true });
			writeFileSync(opts.diagnosticsPath, JSON.stringify(diagnostics, null, 2));
		}
		throw new Error(
			`Failed to record live app scene ${opts.sceneId} at ${opts.step.url}. ${diagnostics.error}. Diagnostics: ${opts.diagnosticsPath ?? screenshotPath}`,
		);
	}
}

// ── Smooth-scroll helper ───────────────────────────────────────────────────

async function runPreRecordActions(
	page: import("playwright").Page,
	actions: NonNullable<WalkthroughStep["preRecordActions"]>,
): Promise<void> {
	for (const action of actions) {
		if (action.type === "evaluate") {
			try {
				await page.evaluate((source) => {
					const fn = new Function(source);
					return fn();
				}, action.script);
			} catch (err) {
				if (!action.optional) {
					throw new Error(`Pre-record action failed (${action.description}): ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			continue;
		}

		let clicked = false;
		const errors: string[] = [];
		for (const selector of action.selectors) {
			try {
				const locator = page.locator(selector).first();
				await locator.click({ timeout: 3500 });
				clicked = true;
				await page.waitForTimeout(700);
				break;
			} catch (err) {
				errors.push(`${selector}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (!clicked && !action.optional) {
			throw new Error(`Pre-record click failed (${action.description}). Tried: ${errors.join(" | ")}`);
		}
	}
}

async function smoothScroll(page: import("playwright").Page, durationMs: number): Promise<void> {
	await page.evaluate((ms: number) => {
		return new Promise<void>((resolve) => {
			const totalHeight = document.body.scrollHeight - window.innerHeight;
			if (totalHeight <= 0) {
				setTimeout(resolve, ms);
				return;
			}
			const start = performance.now();
			function step() {
				const elapsed = performance.now() - start;
				const progress = Math.min(elapsed / ms, 1);
				// Ease-in-out cubic
				const eased =
					progress < 0.5
						? 4 * progress * progress * progress
						: 1 - Math.pow(-2 * progress + 2, 3) / 2;
				window.scrollTo(0, eased * totalHeight);
				if (progress < 1) requestAnimationFrame(step);
				else resolve();
			}
			requestAnimationFrame(step);
		});
	}, durationMs);
}

async function injectLabel(page: import("playwright").Page, label: string): Promise<void> {
	await page.evaluate((text: string) => {
		const badge = document.createElement("div");
		badge.textContent = text;
		badge.style.position = "fixed";
		badge.style.top = "18px";
		badge.style.right = "18px";
		badge.style.zIndex = "2147483647";
		badge.style.padding = "8px 12px";
		badge.style.borderRadius = "999px";
		badge.style.background = "rgba(10, 15, 25, 0.82)";
		badge.style.color = "white";
		badge.style.font = "600 13px -apple-system, BlinkMacSystemFont, sans-serif";
		badge.style.letterSpacing = "0.08em";
		badge.style.textTransform = "uppercase";
		badge.style.boxShadow = "0 8px 28px rgba(0,0,0,0.22)";
		document.body.appendChild(badge);
	}, label);
}

async function injectCaption(page: import("playwright").Page, caption: string): Promise<void> {
	await page.evaluate((text: string) => {
		const box = document.createElement("div");
		box.textContent = text;
		box.style.position = "fixed";
		box.style.left = "50%";
		box.style.bottom = "28px";
		box.style.transform = "translateX(-50%)";
		box.style.zIndex = "2147483647";
		box.style.maxWidth = "900px";
		box.style.padding = "14px 18px";
		box.style.borderRadius = "16px";
		box.style.background = "rgba(10, 15, 25, 0.84)";
		box.style.color = "white";
		box.style.font = "500 20px/1.35 -apple-system, BlinkMacSystemFont, sans-serif";
		box.style.boxShadow = "0 12px 40px rgba(0,0,0,0.24)";
		document.body.appendChild(box);
	}, caption);
}
