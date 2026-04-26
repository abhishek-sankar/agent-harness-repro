import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { loadSnapshot } from "./src/data-source.js";
import { assembleReport, scorePR } from "./src/heuristics.js";
import { writeReport, renderMarkdown } from "./src/reporter.js";
import { buildSceneGraph } from "./src/scenes.js";
import { mapFilesToWalkthroughSteps } from "./src/ui-mapper.js";
import {
	inspectRepoForSuggestions,
	suggestionsToFindings,
	suggestionsToWalkthroughSteps,
} from "./src/repo-inspector.js";
import { renderSceneHtml } from "./src/html.js";
import { narrateScene, ensureAudio } from "./src/voice.js";
import { recordScene, writeHtml } from "./src/record.js";
import { composeReturnVideo, loadQuestions } from "./src/compose.js";
import { getRuntimeConfig, loadEnvFiles, maskSet, normalizeBaseUrl } from "./src/config.js";
import { validateAppTarget } from "./src/app-target.js";
import { buildImplementationPlan, buildIssueImplementationPlan, type ImplementationPlan } from "./src/implementation-plan.js";
import { parsePrNumberFromUrl, waitForDeploymentUrl, type DeploymentLookupResult } from "./src/deployment.js";
import { createDraftPullRequest } from "./src/github.js";
import type { IssueSummary, Report, SceneGraph } from "./src/types.js";
import type { WalkthroughStep } from "./src/ui-mapper.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(HERE, "prompts");
const BASE_ENV_PATHS = [resolve(HERE, ".env"), resolve(HERE, "..", ".env")];
loadEnvFiles([...BASE_ENV_PATHS, resolve(process.cwd(), ".env")]);

function repoRoot(): string {
	return resolve(process.env.RETURN_BRIEF_ROOT ?? process.cwd());
}

function outputsDir(): string {
	return resolve(repoRoot(), "outputs");
}

function tasksPath(): string {
	return resolve(repoRoot(), "tasks.json");
}

function runtimeEnvPaths(): string[] {
	const root = repoRoot();
	return [...BASE_ENV_PATHS, resolve(process.cwd(), ".env"), resolve(root, ".env")];
}

function refreshRuntimeEnv(): void {
	loadEnvFiles(runtimeEnvPaths());
}

function outPath(...p: string[]): string {
	return resolve(outputsDir(), ...p);
}

function safeRunId(runId: string): string {
	return runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function runPath(runId: string, ...p: string[]): string {
	return resolve(outputsDir(), "runs", safeRunId(runId), ...p);
}

function copyLatest(src: string, ...latestParts: string[]): void {
	if (!existsSync(src)) return;
	const latest = outPath(...latestParts);
	mkdirSync(dirname(latest), { recursive: true });
	copyFileSync(src, latest);
}

function loadPrompt(name: string): string {
	const p = resolve(PROMPTS_DIR, name);
	return existsSync(p) ? readFileSync(p, "utf8") : `# ${name} (missing)`;
}

function nowId(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function loadJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function inferRepoFromGitRemote(): string | null {
	const root = repoRoot();
	try {
		const url = spawnSync("git", ["remote", "get-url", "origin"], {
			cwd: root,
			encoding: "utf8",
		}).stdout.trim();
		const match = url.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

function ok(text: string, details: Record<string, unknown> = {}): any {
	return { content: [{ type: "text", text }], details };
}

function numberFromParamOrEnv(value: number | undefined, envName: string, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	const env = Number(process.env[envName]);
	return Number.isFinite(env) && env > 0 ? env : fallback;
}

function loadLatestGraph(): SceneGraph {
	return JSON.parse(readFileSync(outPath("scenes.json"), "utf8")) as SceneGraph;
}

function loadLatestImplementationPlan(): ImplementationPlan {
	return JSON.parse(readFileSync(outPath("implementation-plan.json"), "utf8")) as ImplementationPlan;
}

interface DraftPrResult {
	url: string;
	number?: number;
	repo: string;
	branch: string;
	files: string[];
}

function loadLatestDraftPr(): DraftPrResult | undefined {
	const p = outPath("pr.json");
	if (!existsSync(p)) return undefined;
	return JSON.parse(readFileSync(p, "utf8")) as DraftPrResult;
}

function trackedDirtyFiles(repoRoot: string): string[] {
	const result = spawnSync("git", ["status", "--porcelain"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (result.status !== 0) return [`git status failed: ${result.stderr || result.stdout}`];
	return result.stdout
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter(Boolean)
		.filter((line) => !line.startsWith("??"));
}

function git(repoRoot: string, args: string[]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function changedFilesForCommit(repoRoot: string): string[] {
	const status = git(repoRoot, ["status", "--porcelain"]);
	if (status.status !== 0) throw new Error(status.stderr || status.stdout || "git status failed");
	const files: string[] = [];
	for (const line of status.stdout.split(/\r?\n/).filter(Boolean)) {
		const path = line.slice(3).trim();
		if (!path) continue;
		if (path.startsWith("outputs/")) {
			if (path === "outputs/implementation-demo.mp4" || path === "outputs/implementation-plan.json") {
				files.push(path);
			}
			continue;
		}
		files.push(path);
	}
	return files;
}

function githubBlobUrl(repo: string, branch: string, path: string): string {
	return `https://github.com/${repo}/blob/${branch}/${path}`;
}

function githubTreeUrl(repo: string, branch: string, path: string): string {
	return `https://github.com/${repo}/tree/${branch}/${path}`;
}

async function createDraftPr(plan: ImplementationPlan): Promise<DraftPrResult> {
	const root = repoRoot();
	const demoPath = outPath("implementation-demo.mp4");
	if (!existsSync(demoPath)) {
		throw new Error(`Cannot create draft PR: demo video is missing at ${demoPath}`);
	}
	const planAlias = outPath("implementation-plan.json");
	if (!existsSync(planAlias)) {
		writeFileSync(planAlias, JSON.stringify(plan, null, 2));
	}
	const files = changedFilesForCommit(root);
	if (files.length === 0) throw new Error("Cannot create draft PR: no changed files to commit.");

	const add = git(root, ["add", "--", ...files]);
	if (add.status !== 0) throw new Error(`git add failed: ${add.stderr || add.stdout}`);

	const commitTitle = plan.issueNumber
		? `Implement issue #${plan.issueNumber}: ${plan.selectedIssue?.title ?? plan.title}`
		: `Implement ${plan.title}`;
	const commit = git(root, ["commit", "-m", commitTitle]);
	if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);

	const push = git(root, ["push", "-u", "origin", plan.branchName]);
	if (push.status !== 0) throw new Error(`git push failed: ${push.stderr || push.stdout}`);

	const demoArtifactUrl = githubBlobUrl(plan.repo, plan.branchName, "outputs/implementation-demo.mp4");
	const implementationPlanUrl = githubBlobUrl(plan.repo, plan.branchName, "outputs/implementation-plan.json");
	const outputsTreeUrl = githubTreeUrl(plan.repo, plan.branchName, "outputs");

	const body = [
		"## Return Brief implementation",
		"",
		plan.issueNumber ? `Closes #${plan.issueNumber}` : undefined,
		plan.issueUrl ? `Issue: ${plan.issueUrl}` : undefined,
		"",
		"## Demo artifact",
		"",
		`- [implementation-demo.mp4](${demoArtifactUrl})`,
		`- [implementation-plan.json](${implementationPlanUrl})`,
		`- [outputs/](${outputsTreeUrl})`,
		"",
		"## Acceptance criteria",
		"",
		...plan.acceptanceCriteria.map((c) => `- ${c}`),
		"",
		"## Verification",
		"",
		...plan.testCommands.map((c) => `- \`${c}\``),
	].filter((line): line is string => line !== undefined).join("\n");

	const pr = await createDraftPullRequest({
		repo: plan.repo,
		title: commitTitle,
		body,
		head: plan.branchName,
	});
	const result = { url: pr.url, number: pr.number, repo: plan.repo, branch: plan.branchName, files };
	const resultPath = runPath(plan.runId, "pr.json");
	mkdirSync(dirname(resultPath), { recursive: true });
	writeFileSync(resultPath, JSON.stringify(result, null, 2));
	copyLatest(resultPath, "pr.json");
	return result;
}

function writeDeploymentLookup(plan: ImplementationPlan | undefined, result: DeploymentLookupResult): void {
	const latestPath = outPath("deployment-url.json");
	mkdirSync(dirname(latestPath), { recursive: true });
	writeFileSync(latestPath, JSON.stringify(result, null, 2));
	if (plan) {
		const runScoped = runPath(plan.runId, "deployment-url.json");
		mkdirSync(dirname(runScoped), { recursive: true });
		writeFileSync(runScoped, JSON.stringify(result, null, 2));
	}
}

async function recordImplementationFootage(plan: ImplementationPlan, phase: "before" | "after"): Promise<string> {
	const { recordWalkthroughScene } = await import("./src/walkthrough.js");
	const step = phase === "before" ? plan.beforeSteps[0] : plan.afterSteps[0];
	const text =
		phase === "before"
			? `Before: ${plan.title}. This is the current app surface before the autonomous implementation.`
			: `After: ${plan.title}. This walkthrough shows the implemented change in the running app.`;
	const videoPath = runPath(plan.runId, "implementation", `${phase}.mp4`);
	await recordWalkthroughScene({
		sceneId: `implementation-${phase}`,
		step,
		videoPath,
		durationMs: 9000,
		label: phase,
		caption: process.env.ELEVENLABS_API_KEY ? undefined : text,
		diagnosticsPath: runPath(plan.runId, "implementation", `${phase}-diagnostics.json`),
	});
	return videoPath;
}

async function composeImplementationDemo(plan: ImplementationPlan): Promise<{ videoPath: string; questionsPath: string }> {
	const beforeText = `Before: ${plan.title}. This is the current app surface before the autonomous implementation.`;
	const afterText = `After: ${plan.title}. I implemented the scoped change on a separate branch. The running app now shows the result.`;
	const beforeAudio = runPath(plan.runId, "implementation", "before.mp3");
	const afterAudio = runPath(plan.runId, "implementation", "after.mp3");
	const beforeNarration = await narrateScene({
		sceneId: "implementation-before",
		text: beforeText,
		audioPath: beforeAudio,
		durationHintMs: 9000,
	});
	const afterNarration = await narrateScene({
		sceneId: "implementation-after",
		text: afterText,
		audioPath: afterAudio,
		durationHintMs: 9000,
	});
	const manifest = {
		runId: plan.runId,
		segments: [beforeNarration, afterNarration],
		captionsOnly: !process.env.ELEVENLABS_API_KEY,
	};
	writeFileSync(runPath(plan.runId, "implementation", "narration-manifest.json"), JSON.stringify(manifest, null, 2));
	copyLatest(runPath(plan.runId, "implementation", "narration-manifest.json"), "implementation-narration-manifest.json");
	const result = composeReturnVideo(
		[
			{
				sceneId: "implementation-before",
				videoPath: runPath(plan.runId, "implementation", "before.mp4"),
				audioPath: beforeAudio,
				durationMs: ensureAudio(beforeAudio, beforeNarration.durationMs),
			},
			{
				sceneId: "implementation-after",
				videoPath: runPath(plan.runId, "implementation", "after.mp4"),
				audioPath: afterAudio,
				durationMs: ensureAudio(afterAudio, afterNarration.durationMs),
			},
		],
		runPath(plan.runId, "implementation"),
		runPath(plan.runId, "implementation-demo.mp4"),
		runPath(plan.runId, "implementation-questions.json"),
	);
	copyLatest(result.videoPath, "implementation-demo.mp4");
	copyLatest(result.questionsPath, "implementation-questions.json");
	return { videoPath: result.videoPath, questionsPath: result.questionsPath };
}

export default function returnBriefExtension(pi: ExtensionAPI) {
	// ---------- Data inspection tools ----------

	pi.registerTool({
		name: "get_runtime_config",
		label: "Runtime Config",
		description:
			"Return masked runtime diagnostics: loaded .env files, repo root, APP_BASE_URL, GitHub token, ElevenLabs key, and output directory.",
		parameters: Type.Object({}),
		async execute() {
			refreshRuntimeEnv();
			const cfg = getRuntimeConfig({ extensionRoot: HERE, repoRoot: repoRoot(), outputsDir: outputsDir() });
			const dirty = trackedDirtyFiles(repoRoot());
			const details = {
				extensionRoot: cfg.extensionRoot,
				repoRoot: cfg.repoRoot,
				outputsDir: cfg.outputsDir,
				appBaseUrl: cfg.appBaseUrl,
				githubToken: maskSet(cfg.githubTokenSet),
				elevenLabsKey: maskSet(cfg.elevenLabsKeySet),
				elevenLabsVoiceId: cfg.elevenLabsVoiceId,
				elevenLabsModelId: cfg.elevenLabsModelId,
				allowTtsFallback: cfg.allowTtsFallback,
				loadedEnvFiles: cfg.loadedEnvFiles,
				trackedDirtyFiles: dirty,
			};
			return ok(JSON.stringify(details, null, 2), details);
		},
	});

	pi.registerTool({
		name: "validate_app_target",
		label: "Validate App Target",
		description:
			"Validate that APP_BASE_URL is reachable and renders hydrated app content before recording any live walkthrough scenes.",
		parameters: Type.Object({
			runId: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const runId = params.runId ?? nowId();
			const result = await validateAppTarget({
				baseUrl: process.env.APP_BASE_URL,
				diagnosticsPath: runPath(runId, "app-target.json"),
				screenshotPath: runPath(runId, "app-target.png"),
			});
			copyLatest(runPath(runId, "app-target.json"), "app-target.json");
			copyLatest(runPath(runId, "app-target.png"), "app-target.png");
			return ok(JSON.stringify(result, null, 2), { ...result });
		},
	});

	pi.registerTool({
		name: "list_open_prs",
		label: "List Open PRs",
		description:
			"List open pull requests from the real GitHub repository. No bundled mock fallback is used.",
		parameters: Type.Object({
			repo: Type.String({ description: "owner/name, e.g. octocat/hello-world" }),
		}),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const snap = await loadSnapshot(params.repo);
			const rows = snap.prs.map((pr) => ({
				number: pr.number,
				title: pr.title,
				author: pr.author,
				updatedAt: pr.updatedAt,
				reviewState: pr.reviewState,
				labels: pr.labels,
				branch: pr.branch,
				changedFiles: pr.changedFiles,
			}));
			return ok(JSON.stringify(rows, null, 2), { count: rows.length });
		},
	});

	pi.registerTool({
		name: "list_open_issues",
		label: "List Open Issues",
		description:
			"List open GitHub issues from the real repository. Pull requests are excluded. If this returns zero, call inspect_repo_for_suggestions.",
		parameters: Type.Object({
			repo: Type.String({ description: "owner/name, e.g. octocat/hello-world" }),
		}),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const snap = await loadSnapshot(params.repo);
			const rows = snap.issues.map((issue) => ({
				number: issue.number,
				title: issue.title,
				author: issue.author,
				updatedAt: issue.updatedAt,
				labels: issue.labels,
				url: issue.url,
			}));
			return ok(JSON.stringify(rows, null, 2), { count: rows.length });
		},
	});

	pi.registerTool({
		name: "get_pr_details",
		label: "Get PR Details",
		description: "Full details for one PR: changed files, diff size, reviews, checks, risk score.",
		parameters: Type.Object({
			repo: Type.String(),
			number: Type.Number(),
		}),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const snap = await loadSnapshot(params.repo);
			const pr = snap.prs.find((p) => p.number === params.number);
			if (!pr) return ok(`PR #${params.number} not found`, { error: "not_found" });
			const risk = scorePR(pr, new Date());
			return ok(JSON.stringify({ pr, risk }, null, 2), { number: pr.number, risk });
		},
	});

	pi.registerTool({
		name: "get_recent_workflow_runs",
		label: "Recent Workflow Runs",
		description: "Last N CI workflow runs with conclusions.",
		parameters: Type.Object({
			repo: Type.String(),
			limit: Type.Optional(Type.Number({ default: 20 })),
		}),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const snap = await loadSnapshot(params.repo);
			const rows = snap.workflows.slice(0, params.limit ?? 20);
			return ok(JSON.stringify(rows, null, 2), { count: rows.length });
		},
	});

	pi.registerTool({
		name: "get_latest_release",
		label: "Get Latest Release",
		description: "Latest release (or RC) for the repo.",
		parameters: Type.Object({ repo: Type.String() }),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const snap = await loadSnapshot(params.repo);
			const r = snap.releases[0];
			return ok(JSON.stringify(r, null, 2), { tag: r?.tag ?? null });
		},
	});

	pi.registerTool({
		name: "score_release_risk",
		label: "Score Release Risk",
		description:
			"Runs the deterministic scoring heuristic over the snapshot and returns the assembled report.",
		parameters: Type.Object({
			repo: Type.String(),
			runId: Type.Optional(Type.String()),
			mode: Type.Optional(Type.Union([Type.Literal("idle_audit"), Type.Literal("task_run")])),
		}),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const snap = await loadSnapshot(params.repo);
			const report = assembleReport(snap, {
				runId: params.runId ?? nowId(),
				mode: params.mode ?? "idle_audit",
			});
			if (snap.issues.length === 0 && snap.prs.length === 0) {
				const suggestions = inspectRepoForSuggestions(repoRoot());
				report.findings.push(...suggestionsToFindings(suggestions));
				report.suggestedNextRuns = [
					`Implement "${suggestions[0].title}" on a separate branch and record the app walkthrough.`,
					...report.suggestedNextRuns,
				];
				report.overallStatus = "yellow";
			}
			return ok(JSON.stringify(report, null, 2), {
				status: report.overallStatus,
				readiness: report.releaseReadiness,
				findings: report.findings.length,
			});
		},
	});

	pi.registerTool({
		name: "inspect_repo_for_suggestions",
		label: "Inspect Repo Suggestions",
		description:
			"When GitHub has no open issues, inspect local code/docs and return autonomous implementation candidates plus live-app walkthrough routes. Does not ask the user.",
		parameters: Type.Object({}),
		async execute() {
			refreshRuntimeEnv();
			const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
			const suggestions = inspectRepoForSuggestions(repoRoot());
			const steps = suggestionsToWalkthroughSteps(suggestions, baseUrl);
			return ok(JSON.stringify({ suggestions, walkthroughSteps: steps }, null, 2), {
				count: suggestions.length,
				routes: steps.map((s) => s.url),
			});
		},
	});

	pi.registerTool({
		name: "map_pr_to_ui_routes",
		label: "Map PR to UI Routes",
		description:
			"Given a PR's changed files, returns an ordered list of Playwright walkthrough steps that cover the UI surfaces those files affect. APP_BASE_URL env var sets the running app URL (default: http://localhost:3000). Call this for each PR you want to show in the walkthrough video before calling build_scene_graph.",
		parameters: Type.Object({
			repo: Type.String(),
			prNumber: Type.Number(),
			prTitle: Type.String({ description: "Used to seed narration hints" }),
		}),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const snap = await loadSnapshot(params.repo);
			const pr = snap.prs.find((p) => p.number === params.prNumber);
			if (!pr) return ok(`PR #${params.prNumber} not found`, { error: "not_found" });
			const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
			const steps = mapFilesToWalkthroughSteps(pr.changedFiles, baseUrl, params.prTitle);
			return ok(JSON.stringify(steps, null, 2), {
				prNumber: params.prNumber,
				routes: steps.map((s) => s.url),
				stepCount: steps.length,
			});
		},
	});

	pi.registerTool({
		name: "write_structured_report",
		label: "Write Report",
		description: "Writes outputs/report.json and outputs/report.md from the scored report.",
		parameters: Type.Object({
			report: Type.Any({ description: "The Report object from score_release_risk." }),
		}),
		async execute(_id, params) {
			const report = params.report as Report;
			const jsonPath = runPath(report.runId, "report.json");
			const mdPath = runPath(report.runId, "report.md");
			writeReport(report, jsonPath, mdPath);
			copyLatest(jsonPath, "report.json");
			copyLatest(mdPath, "report.md");
			return ok(`Wrote outputs/report.json and outputs/report.md (${report.findings.length} findings)`, {
				report: jsonPath,
				markdown: mdPath,
				latestReport: outPath("report.json"),
			});
		},
	});

	// ---------- Video pipeline tools ----------

	pi.registerTool({
		name: "build_scene_graph",
		label: "Build Scene Graph",
		description:
			"Turns a report into an ordered scene list. If prWalkthroughSteps are provided (from map_pr_to_ui_routes), PR scenes become live-app recordings instead of static cards. Writes outputs/scenes.json.",
		parameters: Type.Object({
			report: Type.Any(),
			/**
			 * Optional map of PR number → walkthrough steps from map_pr_to_ui_routes.
			 * Pass as an object: { "43": [...steps], "44": [...steps] }
			 */
			prWalkthroughSteps: Type.Optional(
				Type.Record(Type.String(), Type.Array(Type.Any())),
			),
			suggestionWalkthroughSteps: Type.Optional(Type.Array(Type.Any())),
		}),
		async execute(_id, params) {
			const stepsMap = params.prWalkthroughSteps
				? new Map<number, WalkthroughStep[]>(
						Object.entries(params.prWalkthroughSteps).map(([k, v]) => [
							Number(k),
							v as WalkthroughStep[],
						]),
					)
				: undefined;

			const graph = buildSceneGraph(params.report as Report, {
				prWalkthroughSteps: stepsMap,
				suggestionWalkthroughSteps: params.suggestionWalkthroughSteps as WalkthroughStep[] | undefined,
			});
			mkdirSync(runPath(graph.runId), { recursive: true });
			const graphPath = runPath(graph.runId, "scenes.json");
			writeFileSync(graphPath, JSON.stringify(graph, null, 2));
			copyLatest(graphPath, "scenes.json");
			const walkthroughCount = graph.scenes.filter((s) => s.kind === "app_walkthrough").length;
			return ok(
				`Wrote outputs/scenes.json with ${graph.scenes.length} scenes (${walkthroughCount} live-app walkthrough scenes).`,
				{
					count: graph.scenes.length,
					walkthroughScenes: walkthroughCount,
					ids: graph.scenes.map((s) => s.id),
				},
			);
		},
	});

	pi.registerTool({
		name: "render_scenes_html",
		label: "Render Scenes HTML",
		description:
			"Renders HTML for every scene in outputs/scenes.json into outputs/scenes/<id>.html. Captions shown when useCaption=true or ELEVENLABS_API_KEY is absent.",
		parameters: Type.Object({
			useCaption: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const graph = loadLatestGraph();
			const caption = params.useCaption ?? !process.env.ELEVENLABS_API_KEY;
			const written: string[] = [];
			for (const scene of graph.scenes) {
				// Walkthrough scenes don't need an HTML file — the live app IS the visual.
				if (scene.kind === "app_walkthrough") continue;
				const html = renderSceneHtml(scene, { showCaption: caption });
				const p = runPath(graph.runId, "scenes", `${scene.id}.html`);
				writeHtml(p, html);
				written.push(p);
			}
			return ok(`Wrote ${written.length} scene HTML files (app_walkthrough scenes skipped). Captions: ${caption}.`, {
				count: written.length,
			});
		},
	});

	pi.registerTool({
		name: "narrate_scenes",
		label: "Narrate Scenes",
		description:
			"Calls ElevenLabs TTS for every scene. Missing ELEVENLABS_API_KEY uses local system speech when available; configured API failures fail unless RETURN_BRIEF_ALLOW_TTS_FALLBACK=1. Writes a narration manifest.",
		parameters: Type.Object({}),
		async execute() {
			refreshRuntimeEnv();
			const graph = loadLatestGraph();
			const notes: string[] = [];
			const manifest: unknown[] = [];
			for (const scene of graph.scenes) {
				const audioPath = runPath(graph.runId, "scenes", `${scene.id}.mp3`);
				const result = await narrateScene({
					sceneId: scene.id,
					text: scene.narration,
					audioPath,
					durationHintMs: scene.durationHintMs,
				});
				scene.durationHintMs = result.durationMs;
				if (result.usedFallback) notes.push(`${scene.id}: ${result.reason}`);
				manifest.push(result);
			}
			const graphPath = runPath(graph.runId, "scenes.json");
			writeFileSync(graphPath, JSON.stringify(graph, null, 2));
			copyLatest(graphPath, "scenes.json");
			const manifestPath = runPath(graph.runId, "narration-manifest.json");
			writeFileSync(
				manifestPath,
				JSON.stringify(
					{ runId: graph.runId, captionsOnly: !process.env.ELEVENLABS_API_KEY, scenes: manifest },
					null,
					2,
				),
			);
			copyLatest(manifestPath, "narration-manifest.json");
			return ok(
				`Narrated ${graph.scenes.length} scenes.${notes.length ? ` ${notes.length} used fallback narration.` : ""}`,
				{ fallbackNotes: notes, manifest: manifestPath },
			);
		},
	});

	pi.registerTool({
		name: "record_scene_videos",
		label: "Record Scene Videos",
		description:
			"Records each scene as a 1280×800 mp4. Static scenes (title, pr_card, etc.) are captured from local HTML. app_walkthrough scenes launch Playwright against APP_BASE_URL and record the live web app navigating through the changed sections.",
		parameters: Type.Object({}),
		async execute() {
			refreshRuntimeEnv();
			const graph = loadLatestGraph();
			const written: string[] = [];
			if (graph.scenes.some((s) => s.kind === "app_walkthrough")) {
				await validateAppTarget({
					baseUrl: process.env.APP_BASE_URL,
					diagnosticsPath: runPath(graph.runId, "app-target.json"),
					screenshotPath: runPath(graph.runId, "app-target.png"),
				});
			}
			for (const scene of graph.scenes) {
				const htmlPath = runPath(graph.runId, "scenes", `${scene.id}.html`);
				const videoPath = runPath(graph.runId, "scenes", `${scene.id}.mp4`);
				await recordScene({
					scene,
					htmlPath,
					videoPath,
					durationMs: scene.durationHintMs,
					diagnosticsPath: runPath(graph.runId, "scenes", `${scene.id}.diagnostics.json`),
				});
				written.push(videoPath);
			}
			return ok(`Recorded ${written.length} scene videos.`, { count: written.length });
		},
	});

	pi.registerTool({
		name: "compose_return_video",
		label: "Compose Return Video",
		description:
			"Concatenates scene videos with their narration audio via ffmpeg. Pads question scenes and writes outputs/return-brief.mp4 + outputs/questions.json.",
		parameters: Type.Object({}),
		async execute() {
			refreshRuntimeEnv();
			const graph = loadLatestGraph();
			const inputs = graph.scenes.map((s) => ({
				sceneId: s.id,
				videoPath: runPath(graph.runId, "scenes", `${s.id}.mp4`),
				audioPath: runPath(graph.runId, "scenes", `${s.id}.mp3`),
				durationMs: ensureAudio(runPath(graph.runId, "scenes", `${s.id}.mp3`), s.durationHintMs),
				question: s.question,
			}));
			const result = composeReturnVideo(
				inputs,
				runPath(graph.runId, "scenes"),
				runPath(graph.runId, "return-brief.mp4"),
				runPath(graph.runId, "questions.json"),
			);
			copyLatest(result.videoPath, "return-brief.mp4");
			copyLatest(result.questionsPath, "questions.json");
			return ok(
				`Composed return-brief.mp4 (${inputs.length} scenes, ${result.timeline.at(-1)?.endMs ?? 0} ms total).`,
				{ video: result.videoPath, latestVideo: outPath("return-brief.mp4"), questions: result.questionsPath },
			);
		},
	});

	// ---------- Implementation demo tools ----------

	pi.registerTool({
		name: "write_implementation_plan",
		label: "Write Implementation Plan",
		description:
			"Builds the demo-first autonomous implementation plan. Prefer passing a GitHub issue; otherwise it selects a visible UI suggestion.",
		parameters: Type.Object({
			repo: Type.String(),
			runId: Type.Optional(Type.String()),
			suggestionIndex: Type.Optional(Type.Number({ default: 0 })),
			issue: Type.Optional(Type.Any()),
		}),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const runId = params.runId ?? nowId();
			const plan = params.issue
				? buildIssueImplementationPlan({
						repo: params.repo,
						repoRoot: repoRoot(),
						appBaseUrl: normalizeBaseUrl(process.env.APP_BASE_URL),
						runId,
						issue: params.issue as IssueSummary,
					})
				: buildImplementationPlan({
						repo: params.repo,
						repoRoot: repoRoot(),
						appBaseUrl: normalizeBaseUrl(process.env.APP_BASE_URL),
						runId,
						suggestionIndex: params.suggestionIndex ?? 0,
					});
			const planPath = runPath(runId, "implementation-plan.json");
			mkdirSync(dirname(planPath), { recursive: true });
			writeFileSync(planPath, JSON.stringify(plan, null, 2));
			copyLatest(planPath, "implementation-plan.json");
			return ok(JSON.stringify(plan, null, 2), { planPath, latestPlanPath: outPath("implementation-plan.json") });
		},
	});

	pi.registerTool({
		name: "checkout_branch",
		label: "Checkout Branch",
		description: "Switch to an existing branch or create it when requested.",
		parameters: Type.Object({
			branch: Type.String(),
			create: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_id, params) {
			const root = repoRoot();
			const result = git(root, params.create ? ["switch", "-c", params.branch] : ["switch", params.branch]);
			if (result.status !== 0) {
				throw new Error(`git switch failed: ${result.stderr || result.stdout}`);
			}
			return ok(`Checked out ${params.branch}`, { branch: params.branch, repoRoot: root, created: params.create ?? false });
		},
	});

	pi.registerTool({
		name: "record_implementation_baseline",
		label: "Record Implementation Baseline",
		description:
			"Records the before-state live app footage for the latest implementation plan. Requires APP_BASE_URL to be reachable.",
		parameters: Type.Object({}),
		async execute() {
			refreshRuntimeEnv();
			const plan = loadLatestImplementationPlan();
			await validateAppTarget({
				baseUrl: process.env.APP_BASE_URL,
				diagnosticsPath: runPath(plan.runId, "implementation", "app-target-before.json"),
				screenshotPath: runPath(plan.runId, "implementation", "app-target-before.png"),
			});
			const videoPath = await recordImplementationFootage(plan, "before");
			copyLatest(videoPath, "implementation-before.mp4");
			return ok(`Recorded implementation baseline: ${videoPath}`, { videoPath });
		},
	});

	pi.registerTool({
		name: "record_implementation_after",
		label: "Record Implementation After",
		description:
			"Records the after-state live app footage for the latest implementation plan after code edits have been made.",
		parameters: Type.Object({}),
		async execute() {
			refreshRuntimeEnv();
			const plan = loadLatestImplementationPlan();
			await validateAppTarget({
				baseUrl: process.env.APP_BASE_URL,
				diagnosticsPath: runPath(plan.runId, "implementation", "app-target-after.json"),
				screenshotPath: runPath(plan.runId, "implementation", "app-target-after.png"),
			});
			const videoPath = await recordImplementationFootage(plan, "after");
			copyLatest(videoPath, "implementation-after.mp4");
			return ok(`Recorded implementation after footage: ${videoPath}`, { videoPath });
		},
	});

	pi.registerTool({
		name: "compose_implementation_demo",
		label: "Compose Implementation Demo",
		description:
			"Composes before/after app walkthrough footage into outputs/implementation-demo.mp4 with ElevenLabs narration or caption-only fallback.",
		parameters: Type.Object({}),
		async execute() {
			refreshRuntimeEnv();
			const plan = loadLatestImplementationPlan();
			const result = await composeImplementationDemo(plan);
			return ok(`Composed implementation demo: ${result.videoPath}`, {
				video: result.videoPath,
				latestVideo: outPath("implementation-demo.mp4"),
				questions: result.questionsPath,
				captionsOnly: !process.env.ELEVENLABS_API_KEY,
			});
		},
	});

	pi.registerTool({
		name: "create_draft_issue_pr",
		label: "Create Draft Issue PR",
		description:
			"Stages implementation changes plus outputs/implementation-demo.mp4, commits them, pushes the branch, and opens a GitHub draft PR linked to the issue.",
		parameters: Type.Object({}),
		async execute() {
			const plan = loadLatestImplementationPlan();
			const result = await createDraftPr(plan);
			return ok(`Created draft PR: ${result.url}`, { ...result });
		},
	});

	pi.registerTool({
		name: "wait_for_pr_deployment_url",
		label: "Wait for PR Deployment URL",
		description:
			"Polls GitHub PR comments for a Cloudflare deployment preview URL, saves outputs/deployment-url.json, and optionally opens the URL.",
		parameters: Type.Object({
			repo: Type.Optional(Type.String()),
			prUrl: Type.Optional(Type.String()),
			prNumber: Type.Optional(Type.Number()),
			maxWaitMs: Type.Optional(Type.Number({ default: 360_000 })),
			pollIntervalMs: Type.Optional(Type.Number({ default: 30_000 })),
			openWhenFound: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_id, params) {
			refreshRuntimeEnv();
			const plan = existsSync(outPath("implementation-plan.json")) ? loadLatestImplementationPlan() : undefined;
			const latestPr = loadLatestDraftPr();
			const repo = params.repo ?? plan?.repo ?? latestPr?.repo;
			const prUrl = params.prUrl ?? latestPr?.url;
			const prNumber = params.prNumber ?? parsePrNumberFromUrl(prUrl) ?? latestPr?.number;
			if (!repo) throw new Error("wait_for_pr_deployment_url requires repo, or a latest implementation plan.");
			if (!prNumber) throw new Error("wait_for_pr_deployment_url requires prNumber or a parseable prUrl.");
			const result = await waitForDeploymentUrl({
				repo,
				prNumber,
				prUrl,
				maxWaitMs: numberFromParamOrEnv(params.maxWaitMs, "RETURN_BRIEF_DEPLOYMENT_WAIT_MS", 360_000),
				pollIntervalMs: numberFromParamOrEnv(params.pollIntervalMs, "RETURN_BRIEF_DEPLOYMENT_POLL_MS", 30_000),
			});
			writeDeploymentLookup(plan, result);
			if (result.found && result.url && params.openWhenFound) {
				spawnSync("open", [result.url], { stdio: "ignore" });
			}
			return ok(
				result.found
					? `Found Cloudflare deployment URL: ${result.url}`
					: `No Cloudflare deployment URL found after ${Math.round(result.elapsedMs / 1000)}s (${result.commentsChecked} comments checked).`,
				{ ...result, latestPath: outPath("deployment-url.json") },
			);
		},
	});

	// ---------- Feedback / followups ----------

	pi.registerTool({
		name: "save_feedback",
		label: "Save Feedback",
		description:
			"Appends user feedback to outputs/feedback.log. Returns the feedback so the model can incorporate it in the revision plan.",
		parameters: Type.Object({ feedback: Type.String() }),
		async execute(_id, params) {
			mkdirSync(outputsDir(), { recursive: true });
			const entry = `\n---\n${new Date().toISOString()}\n${params.feedback}\n`;
			appendFileSync(outPath("feedback.log"), entry);
			return ok("Feedback saved.", { path: outPath("feedback.log") });
		},
	});

	pi.registerTool({
		name: "launch_followup_run",
		label: "Launch Follow-up Run",
		description:
			"Writes the next task into tasks.json so the next /away-start picks it up. Incorporates captured answers.",
		parameters: Type.Object({ task: Type.String() }),
		async execute(_id, params) {
			writeFileSync(tasksPath(), JSON.stringify({ tasks: [{ description: params.task }] }, null, 2));
			return ok(`Seeded tasks.json with: ${params.task}`, { path: tasksPath() });
		},
	});

	// ---------- Commands ----------

	pi.registerCommand("away-doctor", {
		description: "Show Return Brief runtime config and validate APP_BASE_URL.",
		handler: async (_args, ctx) => {
			refreshRuntimeEnv();
			const cfg = getRuntimeConfig({ extensionRoot: HERE, repoRoot: repoRoot(), outputsDir: outputsDir() });
			ctx.ui.notify(
				`Return Brief: APP_BASE_URL=${cfg.appBaseUrl}, GitHub=${maskSet(cfg.githubTokenSet)}, ElevenLabs=${maskSet(cfg.elevenLabsKeySet)}, repo=${cfg.repoRoot}`,
				"info",
			);
			await validateAppTarget({
				baseUrl: cfg.appBaseUrl,
				diagnosticsPath: outPath("app-target.json"),
				screenshotPath: outPath("app-target.png"),
			});
			ctx.ui.notify("APP_BASE_URL is reachable and rendered app content.", "info");
		},
	});

	pi.registerCommand("away-preview", {
		description: "Fetch the Cloudflare preview URL from the latest PR comments and open it.",
		handler: async (args, ctx) => {
			refreshRuntimeEnv();
			const repoMatch = args.match(/--repo\s+(\S+)/);
			const prMatch = args.match(/--pr\s+(\S+)/);
			const plan = existsSync(outPath("implementation-plan.json")) ? loadLatestImplementationPlan() : undefined;
			const latestPr = loadLatestDraftPr();
			const prArg = prMatch?.[1];
			const repo = repoMatch?.[1] ?? plan?.repo ?? latestPr?.repo;
			const prUrl = prArg?.startsWith("http") ? prArg : latestPr?.url;
			const prNumber = prArg && /^\d+$/.test(prArg) ? Number(prArg) : parsePrNumberFromUrl(prUrl) ?? latestPr?.number;
			if (!repo || !prNumber) {
				ctx.ui.notify("No PR context found. Pass /away-preview --repo owner/name --pr <number-or-url>.", "warning");
				return;
			}
			const result = await waitForDeploymentUrl({
				repo,
				prNumber,
				prUrl,
				maxWaitMs: numberFromParamOrEnv(undefined, "RETURN_BRIEF_DEPLOYMENT_WAIT_MS", 360_000),
				pollIntervalMs: numberFromParamOrEnv(undefined, "RETURN_BRIEF_DEPLOYMENT_POLL_MS", 30_000),
			});
			writeDeploymentLookup(plan, result);
			if (!result.found || !result.url) {
				ctx.ui.notify(`No Cloudflare preview URL found yet after checking ${result.commentsChecked} comments.`, "warning");
				return;
			}
			spawnSync("open", [result.url], { stdio: "ignore" });
			ctx.ui.notify(`Opened Cloudflare preview: ${result.url}`, "info");
		},
	});

	async function seedAwayStart(
		pi: ExtensionAPI,
		args: string,
	): Promise<void> {
		const repoMatch = args.match(/--repo\s+(\S+)/);
		const taskMatch = args.match(/--task\s+"([^"]+)"/);
		const repo = repoMatch?.[1] ?? inferRepoFromGitRemote() ?? "owner/name";
		const tasks = loadJson<{ tasks?: { description: string }[] }>(tasksPath(), { tasks: [] });
		const hasTask = taskMatch || (tasks.tasks && tasks.tasks.length > 0);
		const task = taskMatch?.[1] ?? tasks.tasks?.[0]?.description;
		const answers = loadJson<{ answers?: { questionId: string; answer: string }[] }>(
			outPath("answers.json"),
			{ answers: [] },
		);
		const answerBlock =
			answers.answers && answers.answers.length > 0
				? `\n\n## Prior answers from the developer\n${answers.answers.map((a) => `- ${a.questionId}: ${a.answer}`).join("\n")}`
				: "";

		const system = loadPrompt("away-system.md");
		const prompt = `${system}

## Invocation
- repo: ${repo}
- mode: ${hasTask ? "task_run" : "idle_audit"}
${hasTask ? `- task: ${task}` : ""}${answerBlock}

Begin now. Work through the tool sequence end-to-end without asking me questions until the video is composed.`;

		pi.sendUserMessage(prompt);
	}

	pi.registerCommand("away-implement", {
		description: "Pull an open issue, create a branch, record before-state footage, implement it, record demo, and open a draft PR.",
		handler: async (args, ctx) => {
			refreshRuntimeEnv();
			const repoMatch = args.match(/--repo\s+(\S+)/);
			const issueMatch = args.match(/--issue\s+(\d+)/);
			const indexMatch = args.match(/--suggestion\s+(\d+)/);
			const repo = repoMatch?.[1] ?? inferRepoFromGitRemote() ?? "owner/name";
			const runId = nowId();
			const root = repoRoot();
			const cfg = getRuntimeConfig({ extensionRoot: HERE, repoRoot: root, outputsDir: outputsDir() });

			const dirty = trackedDirtyFiles(root);
			if (dirty.length > 0) {
				ctx.ui.notify(`Target repo has tracked changes. Commit/stash them first:\n${dirty.join("\n")}`, "warning");
				return;
			}

			const app = await validateAppTarget({
				baseUrl: cfg.appBaseUrl,
				diagnosticsPath: runPath(runId, "implementation", "app-target-before.json"),
				screenshotPath: runPath(runId, "implementation", "app-target-before.png"),
			});

			const snap = await loadSnapshot(repo);
			const selectedIssue = issueMatch
				? snap.issues.find((issue) => issue.number === Number(issueMatch[1]))
				: snap.issues[0];
			const plan = selectedIssue
				? buildIssueImplementationPlan({
						repo,
						repoRoot: root,
						appBaseUrl: app.url,
						runId,
						issue: selectedIssue,
					})
				: buildImplementationPlan({
						repo,
						repoRoot: root,
						appBaseUrl: app.url,
						runId,
						suggestionIndex: indexMatch ? Number(indexMatch[1]) : 0,
					});
			const planPath = runPath(runId, "implementation-plan.json");
			mkdirSync(dirname(planPath), { recursive: true });
			writeFileSync(planPath, JSON.stringify(plan, null, 2));
			copyLatest(planPath, "implementation-plan.json");

			const beforeVideo = await recordImplementationFootage(plan, "before");
			copyLatest(beforeVideo, "implementation-before.mp4");

			const branch = spawnSync("git", ["switch", "-c", plan.branchName], {
				cwd: root,
				encoding: "utf8",
			});
			if (branch.status !== 0) {
				ctx.ui.notify(`Could not create branch ${plan.branchName}: ${branch.stderr || branch.stdout}`, "warning");
				return;
			}

			ctx.ui.notify(`Created ${plan.branchName}; baseline recorded. Seeding issue implementation run.`, "info");
			const prompt = `# Return Brief Implementation Run

You are implementing a GitHub issue on a separate branch and must end by opening a draft PR.

## Target
- repo: ${repo}
- repo root: ${root}
- branch: ${plan.branchName}
- APP_BASE_URL: ${app.url}
- plan path: ${outPath("implementation-plan.json")}
- before video: ${beforeVideo}
${plan.issueNumber ? `- issue: #${plan.issueNumber} ${plan.issueUrl}` : "- issue: none found; using local implementation suggestion"}

## Selected implementation
${JSON.stringify(plan, null, 2)}

## Instructions
1. Implement the selected suggestion directly in the target repo.
2. Keep the change scoped to \`filesToEdit\` unless a small adjacent edit is required.
3. Do not ask the user questions.
4. Make the after-demo prove the change, not just show the same route again. Follow \`afterDemoState\`, \`demoSetupInstructions\`, and any \`afterSteps[].preRecordActions\` in the plan.
5. If the issue is dark mode or another stateful UI change, expose a stable selector for the control. For dark mode, prefer \`data-testid="theme-toggle"\`; the after recorder will click it before capturing footage, so the recorded video must show the dark state.
6. Run each command in \`testCommands\` that exists for this repo.
7. After the app still renders at APP_BASE_URL and the demo state can be activated by the planned actions, call \`record_implementation_after({})\`.
8. Then call \`compose_implementation_demo({})\`.
9. Then call \`create_draft_issue_pr({})\`. This commits the code plus \`outputs/implementation-demo.mp4\`, pushes the branch, and opens a draft PR.
10. Then call \`wait_for_pr_deployment_url({})\`. Cloudflare usually comments with the preview URL a few minutes after the PR is opened. Poll PR comments, save \`outputs/deployment-url.json\`, and include the preview URL in the final summary if found.
11. Finish with the branch name, draft PR URL, Cloudflare preview URL if found, changed files, test results, and \`outputs/implementation-demo.mp4\`.
`;
			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("away-start", {
		description: "Run the async audit and produce a narrated return-brief video.",
		handler: async (args, _ctx) => {
			await seedAwayStart(pi, args);
		},
	});

	pi.registerCommand("away-feedback", {
		description: 'Revise the report + video based on feedback: /away-feedback "text"',
		handler: async (args, _ctx) => {
			const m = args.match(/^\s*"([^"]+)"\s*$/) ?? args.match(/^\s*(.+)$/);
			const feedback = m?.[1] ?? "";
			if (!feedback) return;
			const prompt = `${loadPrompt("feedback-to-plan.md")}

## Feedback from the developer
${feedback}

Regenerate the report, scene graph, narration, scene videos, and the composed return-brief.mp4. Use the existing outputs/report.json as your starting point. Work through the full tool sequence.`;
			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("away-continue", {
		description: "Launch the top suggested follow-up run from the latest report.",
		handler: async (_args, ctx) => {
			const report = loadJson<Report | null>(outPath("report.json"), null);
			const answers = loadJson<{ answers?: { questionId: string; answer: string }[] }>(
				outPath("answers.json"),
				{ answers: [] },
			);
			const task = report?.suggestedNextRuns?.[0];
			if (!task) {
				ctx.ui.notify("No report.json found — run /away-start first.", "warning");
				return;
			}
			writeFileSync(tasksPath(), JSON.stringify({ tasks: [{ description: task }] }, null, 2));
			await seedAwayStart(pi, `--repo ${report!.repo} --task "${task}"`);
		},
	});

	pi.registerCommand("away-watch", {
		description: "Play the return-brief video and capture answers at question scenes.",
		handler: async (_args, ctx) => {
			const questionsPath = outPath("questions.json");
			if (!existsSync(questionsPath)) {
				ctx.ui.notify("No questions.json yet — run /away-start first.", "warning");
				return;
			}
			const q = loadQuestions(questionsPath);
			ctx.ui.notify(`Opening ${q.videoPath} (${Math.round(q.totalDurationMs / 1000)}s)`, "info");
			await ctx.waitForIdle();

			const child = spawn("open", [q.videoPath], { stdio: "ignore", detached: true });
			child.unref();

			const rl = readline.createInterface({ input: stdin, output: stdout });
			const answers: { questionId: string; answer: string }[] = [];
			try {
				for (const item of q.questions) {
					const opts = item.question?.options ?? [];
					const optsText = opts.length
						? opts.map((o, i) => `  ${i + 1}. ${o}`).join("\n")
						: "  (free text)";
					stdout.write(`\n— Question at ~${Math.round(item.timestampMs / 1000)}s —\n${item.question?.text}\n${optsText}\n`);
					const raw = (await rl.question("Your answer: ")).trim();
					if (!raw) continue;
					const answer =
						opts.length && /^\d+$/.test(raw) ? opts[Math.min(Number(raw) - 1, opts.length - 1)] : raw;
					answers.push({ questionId: item.question!.id, answer });
				}
			} finally {
				rl.close();
			}

			mkdirSync(outputsDir(), { recursive: true });
			writeFileSync(
				outPath("answers.json"),
				JSON.stringify({ capturedAt: new Date().toISOString(), answers }, null, 2),
			);
			ctx.ui.notify(
				`Captured ${answers.length} answer${answers.length === 1 ? "" : "s"} to outputs/answers.json.`,
				"info",
			);
		},
	});
}
