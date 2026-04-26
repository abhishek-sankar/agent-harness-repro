/**
 * Smoke test the Return Brief pipeline outside of pi.
 *
 * Modes:
 *   default (no APP_BASE_URL)
 *     → real GitHub metadata + static report scenes
 *
 *   GITHUB_TOKEN set
 *     → authenticated GitHub API for private repos / higher rate limits
 *
 *   APP_BASE_URL set (app must be running!)
 *     → live Playwright walkthrough scenes for each PR with findings
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, statSync } from "node:fs";

import { loadSnapshot } from "../src/data-source.js";
import { assembleReport } from "../src/heuristics.js";
import { writeReport } from "../src/reporter.js";
import { buildSceneGraph } from "../src/scenes.js";
import { mapFilesToWalkthroughSteps } from "../src/ui-mapper.js";
import {
	inspectRepoForSuggestions,
	suggestionsToFindings,
	suggestionsToWalkthroughSteps,
} from "../src/repo-inspector.js";
import { renderSceneHtml } from "../src/html.js";
import { narrateScene, ensureAudio } from "../src/voice.js";
import { recordScene, writeHtml } from "../src/record.js";
import { composeReturnVideo } from "../src/compose.js";
import type { WalkthroughStep } from "../src/ui-mapper.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const OUTPUTS = resolve(REPO_ROOT, "outputs");

function out(...p: string[]): string {
	return resolve(OUTPUTS, ...p);
}

function step(n: number, msg: string): void {
	console.log(`\n[${n}] ${msg}`);
}

async function main(): Promise<void> {
	mkdirSync(OUTPUTS, { recursive: true });

	const repo = process.env.SMOKE_REPO ?? "demo-org/demo-service";
	const appBaseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
	const hasLiveApp = !!appBaseUrl;

	step(1, `load live GitHub snapshot (${process.env.GITHUB_TOKEN ? "authenticated" : "anonymous"})`);
	const snap = await loadSnapshot(repo);
	console.log(`   PRs=${snap.prs.length}  issues=${snap.issues.length}  workflows=${snap.workflows.length}  releases=${snap.releases.length}`);

	step(2, "assemble report (deterministic scoring)");
	const report = assembleReport(snap, { runId: "smoke-1", mode: "idle_audit" });
	let suggestionWalkthroughSteps: WalkthroughStep[] | undefined;
	if (snap.prs.length === 0 && snap.issues.length === 0) {
		const suggestions = inspectRepoForSuggestions(REPO_ROOT);
		report.findings.push(...suggestionsToFindings(suggestions));
		report.suggestedNextRuns = [
			`Implement "${suggestions[0].title}" on a separate branch and record the app walkthrough.`,
			...report.suggestedNextRuns,
		];
		report.overallStatus = "yellow";
		if (hasLiveApp) suggestionWalkthroughSteps = suggestionsToWalkthroughSteps(suggestions, appBaseUrl);
	}
	console.log(`   status=${report.overallStatus}  readiness=${report.releaseReadiness}  findings=${report.findings.length}`);
	for (const f of report.findings) console.log(`   · ${f.severity.padEnd(6)} ${f.title}`);

	step(3, "write report.json + report.md");
	writeReport(report, out("report.json"), out("report.md"));

	// ── Walkthrough steps (only when APP_BASE_URL is set) ─────────────────
	let prWalkthroughSteps: Map<number, WalkthroughStep[]> | undefined;

	if (hasLiveApp) {
		step(4, `map PR changes → UI routes (APP_BASE_URL=${appBaseUrl})`);
		prWalkthroughSteps = new Map();
		const prFindings = report.findings.filter((f) => f.prNumber !== undefined);
		for (const finding of prFindings) {
			const pr = snap.prs.find((p) => p.number === finding.prNumber);
			if (!pr) continue;
			const steps = mapFilesToWalkthroughSteps(pr.changedFiles, appBaseUrl, pr.title);
			prWalkthroughSteps.set(pr.number, steps);
			console.log(`   PR #${pr.number}: ${steps.length} walkthrough step(s) → ${steps.map((s) => new URL(s.url).pathname).join(", ")}`);
		}
	} else {
		step(4, "map PR changes → UI routes (skipped — APP_BASE_URL not set, using static scenes)");
	}

	step(5, "build scene graph");
	const graph = buildSceneGraph(report, { prWalkthroughSteps, suggestionWalkthroughSteps });
	writeFileSync(out("scenes.json"), JSON.stringify(graph, null, 2));
	const walkthroughCount = graph.scenes.filter((s) => s.kind === "app_walkthrough").length;
	console.log(`   scenes=${graph.scenes.length}  walkthrough=${walkthroughCount}  questions=${graph.scenes.filter((s) => s.question).length}`);

	step(6, "render static scene HTML (app_walkthrough scenes skipped — Playwright records the live app)");
	const useCaption = !process.env.ELEVENLABS_API_KEY;
	for (const scene of graph.scenes) {
		if (scene.kind === "app_walkthrough") continue;
		const html = renderSceneHtml(scene, { showCaption: useCaption });
		writeHtml(out("scenes", `${scene.id}.html`), html);
	}

	step(7, "narrate scenes (silent fallback if no ELEVENLABS_API_KEY)");
	for (const scene of graph.scenes) {
		const r = await narrateScene({
			sceneId: scene.id,
			text: scene.narration,
			audioPath: out("scenes", `${scene.id}.mp3`),
			durationHintMs: scene.durationHintMs,
		});
		scene.durationHintMs = r.durationMs;
		if (r.usedFallback) console.log(`   ${scene.id}: FALLBACK (${r.reason})`);
	}
	writeFileSync(out("scenes.json"), JSON.stringify(graph, null, 2));

	step(8, "record scene videos (Playwright)");
	for (const scene of graph.scenes) {
		if (scene.kind === "app_walkthrough" && !hasLiveApp) {
			console.log(`   ⚠ skipping walkthrough scene ${scene.id} (APP_BASE_URL not set)`);
			// Write a 1-frame placeholder so compose doesn't fail.
			// In practice, if APP_BASE_URL is missing, buildSceneGraph won't emit walkthrough scenes.
			continue;
		}
		await recordScene({
			scene,
			htmlPath: out("scenes", `${scene.id}.html`),
			videoPath: out("scenes", `${scene.id}.mp4`),
			durationMs: scene.durationHintMs,
		});
		const kind = scene.kind === "app_walkthrough" ? "🎥 live-app" : "📄 static";
		console.log(`   ✓ ${scene.id}.mp4  [${kind}]`);
	}

	step(9, "compose return-brief.mp4 + questions.json");
	const inputs = graph.scenes.map((s) => ({
		sceneId: s.id,
		videoPath: out("scenes", `${s.id}.mp4`),
		audioPath: out("scenes", `${s.id}.mp3`),
		durationMs: ensureAudio(out("scenes", `${s.id}.mp3`), s.durationHintMs),
		question: s.question,
	}));
	const result = composeReturnVideo(inputs, out("scenes"), out("return-brief.mp4"), out("questions.json"));

	const finalSize = statSync(result.videoPath).size;
	console.log(`\n✅ DONE. Final video: ${result.videoPath} (${(finalSize / 1024 / 1024).toFixed(2)} MB)`);
	console.log(`   Questions file: ${result.questionsPath}`);
	console.log(`   Walkthrough scenes: ${walkthroughCount} (${hasLiveApp ? "recorded against live app" : "none — set APP_BASE_URL to enable"})`);
}

main().catch((err) => {
	console.error("SMOKE FAIL:", err);
	process.exit(1);
});
