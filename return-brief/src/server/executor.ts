import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { buildImplementationPlan, buildIssueImplementationPlan, type ImplementationPlan } from "../implementation-plan.js";
import { loadSnapshot } from "../data-source.js";
import { normalizeBaseUrl } from "../config.js";
import { waitForDeploymentUrl } from "../deployment.js";
import type { DeploymentLookupResult } from "../deployment.js";
import { createIssueComment } from "../github.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { createServerPiSession, summarizeSessionEvent } from "./pi-runtime.js";
import { buildImplementChangePrompt, buildRepoOverviewPrompt, buildReviseFromFeedbackPrompt } from "./prompts.js";
import { createWorkspace, runShell, startWorkspaceApp, type ManagedApp, type ManagedWorkspace } from "./workspace.js";
import type { ArtifactStore } from "./artifacts.js";
import type { ReturnBriefStore } from "./db.js";
import type { QueueRunJob, RepoTargetConfig, RunRequestInput } from "./types.js";
import type { ReturnBriefQueue } from "./queue.js";

class CancelledError extends Error {
	constructor(message = "Run cancelled") {
		super(message);
		this.name = "CancelledError";
	}
}

export interface ExecutionContext {
	store: ReturnBriefStore;
	artifactStore: ArtifactStore;
	queue: ReturnBriefQueue;
	agentDir: string;
	activeSessions: Map<string, AgentSession>;
	publicBaseUrl: string;
}

function outputsDir(workspacePath: string): string {
	return resolve(workspacePath, "outputs");
}

function outPath(workspacePath: string, ...parts: string[]): string {
	return resolve(outputsDir(workspacePath), ...parts);
}

function runPath(workspacePath: string, runId: string, ...parts: string[]): string {
	return resolve(outputsDir(workspacePath), "runs", runId.replace(/[^a-zA-Z0-9_.-]/g, "-"), ...parts);
}

function copyPlanToOutputs(workspacePath: string, plan: ImplementationPlan): void {
	const scoped = runPath(workspacePath, plan.runId, "implementation-plan.json");
	mkdirSync(dirname(scoped), { recursive: true });
	writeFileSync(scoped, JSON.stringify(plan, null, 2));
	writeFileSync(outPath(workspacePath, "implementation-plan.json"), JSON.stringify(plan, null, 2));
}

function extractAssistantText(session: AgentSession): string {
	const messages = session.messages.filter((message) => message.role === "assistant");
	const lastAssistant = messages.at(-1);
	if (!lastAssistant || !Array.isArray(lastAssistant.content)) return "";
	return lastAssistant.content
		.map((entry) => {
			if (entry.type !== "text") return "";
			return typeof entry.text === "string" ? entry.text : "";
		})
		.join("")
		.trim();
}

function getLastAssistantMessage(session: AgentSession): Record<string, unknown> | undefined {
	const messages = session.messages.filter((message) => message.role === "assistant");
	const lastAssistant = messages.at(-1);
	return lastAssistant ? (lastAssistant as unknown as Record<string, unknown>) : undefined;
}

function persistAssistantResponse(workspacePath: string, runId: string, content: string): void {
	if (!content.trim()) return;
	const path = runPath(workspacePath, runId, "assistant-response.md");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function restoreEnv(previous: Map<string, string | undefined>): void {
	for (const [key, value] of previous) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function applyRepoEnvironment(repo: RepoTargetConfig, workspacePath: string): Map<string, string | undefined> {
	const previous = new Map<string, string | undefined>();
	const setValue = (key: string, value: string) => {
		if (!previous.has(key)) previous.set(key, process.env[key]);
		process.env[key] = value;
	};
	setValue("RETURN_BRIEF_ROOT", workspacePath);
	for (const [key, value] of Object.entries(repo.env ?? {})) {
		setValue(key, value);
	}
	for (const key of repo.envAllowlist ?? []) {
		if (process.env[key] !== undefined) setValue(key, process.env[key]!);
	}
	return previous;
}

async function ensureNotCancelled(store: ReturnBriefStore, runId: string): Promise<void> {
	const run = await store.getRun(runId);
	if (!run) throw new Error(`Run ${runId} not found`);
	if (run.status === "cancelling" || run.status === "cancelled") throw new CancelledError();
}

async function emit(store: ReturnBriefStore, runId: string, type: string, payload: Record<string, unknown>): Promise<void> {
	await store.appendRunEvent(runId, type, payload);
}

async function uploadArtifacts(
	store: ReturnBriefStore,
	artifactStore: ArtifactStore,
	runId: string,
	workspacePath: string,
): Promise<Array<{ id: string; kind: Parameters<ArtifactStore["putFile"]>[1]; mimeType: string }>> {
	const candidates: Array<{ kind: Parameters<ArtifactStore["putFile"]>[1]; path: string; mimeType: string }> = [
		{ kind: "report_json", path: runPath(workspacePath, runId, "report.json"), mimeType: "application/json" },
		{ kind: "report_md", path: runPath(workspacePath, runId, "report.md"), mimeType: "text/markdown" },
		{ kind: "assistant_response", path: runPath(workspacePath, runId, "assistant-response.md"), mimeType: "text/markdown" },
		{ kind: "return_video", path: runPath(workspacePath, runId, "return-brief.mp4"), mimeType: "video/mp4" },
		{ kind: "questions_json", path: runPath(workspacePath, runId, "questions.json"), mimeType: "application/json" },
		{ kind: "implementation_plan", path: runPath(workspacePath, runId, "implementation-plan.json"), mimeType: "application/json" },
		{ kind: "implementation_demo", path: runPath(workspacePath, runId, "implementation-demo.mp4"), mimeType: "video/mp4" },
		{ kind: "diagnostic_json", path: outPath(workspacePath, "deployment-url.json"), mimeType: "application/json" },
	];
	const uploaded: Array<{ id: string; kind: Parameters<ArtifactStore["putFile"]>[1]; mimeType: string }> = [];
	for (const candidate of candidates) {
		if (!existsSync(candidate.path)) continue;
		const stored = await artifactStore.putFile(runId, candidate.kind, candidate.path, candidate.mimeType);
		await store.upsertArtifact({
			id: stored.id,
			runId,
			kind: stored.kind,
			storageKey: stored.storageKey,
			mimeType: stored.mimeType,
			sizeBytes: stored.sizeBytes,
			checksum: stored.checksum,
		});
		await emit(store, runId, "artifact_ready", {
			kind: stored.kind,
			storageKey: stored.storageKey,
			fileName: basename(candidate.path),
		});
		uploaded.push({ id: stored.id, kind: stored.kind, mimeType: stored.mimeType });
	}
	return uploaded;
}

function githubBlobUrl(repo: string, branch: string, path: string): string {
	return `https://github.com/${repo}/blob/${branch}/${path}`;
}

async function postImplementationArtifactsComment(opts: {
	repo: string;
	prNumber: number;
	branch: string;
	runId: string;
	assistantText: string;
	uploadedArtifacts: Array<{ id: string; kind: string }>;
	publicBaseUrl: string;
}): Promise<string | undefined> {
	const outputsLinks = [
		`- [implementation-demo.mp4](${githubBlobUrl(opts.repo, opts.branch, "outputs/implementation-demo.mp4")})`,
		`- [implementation-plan.json](${githubBlobUrl(opts.repo, opts.branch, "outputs/implementation-plan.json")})`,
		`- [outputs/](${`https://github.com/${opts.repo}/tree/${opts.branch}/outputs`})`,
	];
	const apiLinks = opts.uploadedArtifacts.map((artifact) => {
		const fileName =
			artifact.kind === "assistant_response"
				? "assistant-response.md"
				: artifact.kind === "implementation_demo"
					? "implementation-demo.mp4"
					: artifact.kind === "implementation_plan"
						? "implementation-plan.json"
						: artifact.kind;
		return `- ${artifact.kind}: ${opts.publicBaseUrl}/api/artifacts/${artifact.id}/download (${fileName})`;
	});
	const assistantSection = opts.assistantText.trim()
		? `## Agent Summary\n\n${opts.assistantText.trim()}`
		: "## Agent Summary\n\nNo assistant summary was captured.";
	const body = [
		"## Return Brief Artifacts",
		"",
		`Run ID: \`${opts.runId}\``,
		"",
		"### In Branch",
		...outputsLinks,
		"",
		"### Service Artifacts",
		...apiLinks,
		"",
		assistantSection,
	].join("\n");
	const comment = await createIssueComment(opts.repo, opts.prNumber, body);
	return comment.url;
}

async function prepareWorkspace(repo: RepoTargetConfig, workspacePath: string, store: ReturnBriefStore, runId: string): Promise<void> {
	const env = { ...process.env };
	if (repo.installCommand) {
		await emit(store, runId, "status", { step: "installing_dependencies", command: repo.installCommand });
		await runShell(repo.installCommand, workspacePath, env);
	}
	if (repo.buildCommand) {
		await emit(store, runId, "status", { step: "building_repo", command: repo.buildCommand });
		await runShell(repo.buildCommand, workspacePath, env);
	}
}

async function runPiPrompt(opts: {
	runId: string;
	workspacePath: string;
	agentDir: string;
	allowWrite: boolean;
	prompt: string;
	store: ReturnBriefStore;
	activeSessions: Map<string, AgentSession>;
}): Promise<string> {
	const handle = await createServerPiSession({
		cwd: opts.workspacePath,
		agentDir: opts.agentDir,
		allowWrite: opts.allowWrite,
		onEvent: async (event) => {
			const summary = summarizeSessionEvent(event);
			if (!summary) return;
			await emit(opts.store, opts.runId, summary.type, summary.payload);
		},
	});
	opts.activeSessions.set(opts.runId, handle.session);
	try {
		await handle.session.prompt(opts.prompt);
		const lastAssistant = getLastAssistantMessage(handle.session);
		const assistantError = typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : undefined;
		if (assistantError) {
			throw new Error(`Pi session failed: ${assistantError}`);
		}
		const assistantText = extractAssistantText(handle.session);
		if (!assistantText) {
			throw new Error("Pi session returned no assistant output.");
		}
		persistAssistantResponse(opts.workspacePath, opts.runId, assistantText);
		return assistantText;
	} finally {
		opts.activeSessions.delete(opts.runId);
		handle.dispose();
	}
}

async function prepareImplementationPlan(runId: string, repo: RepoTargetConfig, workspacePath: string, input: RunRequestInput): Promise<ImplementationPlan> {
	const snapshot = await loadSnapshot(repo.repo);
	const selectedIssue = input.issueNumber
		? snapshot.issues.find((issue) => issue.number === input.issueNumber)
		: snapshot.issues[0];
	const appBaseUrl = normalizeBaseUrl(process.env.APP_BASE_URL);
	const plan = selectedIssue
		? buildIssueImplementationPlan({
				repo: repo.repo,
				repoRoot: workspacePath,
				appBaseUrl,
				runId,
				issue: selectedIssue,
			})
		: buildImplementationPlan({
				repo: repo.repo,
				repoRoot: workspacePath,
				appBaseUrl,
				runId,
				suggestionIndex: 0,
			});
	copyPlanToOutputs(workspacePath, plan);
	return plan;
}

function tryReadJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export async function executeRun(context: ExecutionContext, job: QueueRunJob): Promise<void> {
	const run = await context.store.getRun(job.runId);
	if (!run) throw new Error(`Run ${job.runId} not found`);
	const repo = await context.store.getRepo(run.repoId);
	if (!repo) throw new Error(`Repo ${run.repoId} not found`);

		let workspace: ManagedWorkspace | undefined;
		let app: ManagedApp | undefined;
		const previousCwd = process.cwd();
		let previousEnv = new Map<string, string | undefined>();
		let finalAssistantText = "";

	try {
		await context.store.patchRun(run.id, { status: "running", startedAt: new Date(), errorMessage: null });
		await emit(context.store, run.id, "status", { status: "running" });
		workspace = await createWorkspace(repo.config);
		await emit(context.store, run.id, "status", { step: "workspace_ready", path: workspace.path });
		previousEnv = applyRepoEnvironment(repo.config, workspace.path);
		await ensureNotCancelled(context.store, run.id);
		await prepareWorkspace(repo.config, workspace.path, context.store, run.id);
		process.chdir(workspace.path);
		app = await startWorkspaceApp(repo.config, workspace.path, { ...process.env, PORT: String(repo.config.port) });
		if (!previousEnv.has("APP_BASE_URL")) previousEnv.set("APP_BASE_URL", process.env.APP_BASE_URL);
		process.env.APP_BASE_URL = app.baseUrl;
		await emit(context.store, run.id, "status", { step: "app_ready", appBaseUrl: app.baseUrl });

		const input = run.input as unknown as RunRequestInput;
		if (run.mode === "repo-overview") {
			const assistantText = await runPiPrompt({
				runId: run.id,
				workspacePath: workspace.path,
				agentDir: resolve(context.agentDir, run.id),
				allowWrite: false,
				prompt: buildRepoOverviewPrompt(repo.config, input),
				store: context.store,
				activeSessions: context.activeSessions,
			});
			if (assistantText) {
				finalAssistantText = assistantText;
				await emit(context.store, run.id, "assistant_message", { content: assistantText });
			}
		} else if (run.mode === "revise-from-feedback") {
			const assistantText = await runPiPrompt({
				runId: run.id,
				workspacePath: workspace.path,
				agentDir: resolve(context.agentDir, run.id),
				allowWrite: false,
				prompt: buildReviseFromFeedbackPrompt(repo.config, input),
				store: context.store,
				activeSessions: context.activeSessions,
			});
			if (assistantText) {
				finalAssistantText = assistantText;
				await emit(context.store, run.id, "assistant_message", { content: assistantText });
			}
		} else if (run.mode === "implement-change") {
			const plan = await prepareImplementationPlan(run.id, repo.config, workspace.path, input);
			await emit(context.store, run.id, "status", { step: "implementation_planned", branch: plan.branchName, title: plan.title });
			const assistantText = await runPiPrompt({
				runId: run.id,
				workspacePath: workspace.path,
				agentDir: resolve(context.agentDir, run.id),
				allowWrite: true,
				prompt: buildImplementChangePrompt(repo.config, plan),
				store: context.store,
				activeSessions: context.activeSessions,
			});
			if (assistantText) {
				finalAssistantText = assistantText;
				await emit(context.store, run.id, "assistant_message", { content: assistantText });
			}
			const pr = tryReadJson<{ url: string; branch: string }>(outPath(workspace.path, "pr.json"));
			if (pr?.url) {
				await context.store.patchRun(run.id, { draftPrUrl: pr.url, branch: pr.branch });
				await emit(context.store, run.id, "external_link", { kind: "draft_pr", url: pr.url, branch: pr.branch });
				await context.queue.enqueuePreviewWatch(run.id, 60_000);
			}
		}

		await ensureNotCancelled(context.store, run.id);
		const uploadedArtifacts = await uploadArtifacts(context.store, context.artifactStore, run.id, workspace.path);
		if (run.mode === "implement-change") {
			const pr = tryReadJson<{ url: string; branch: string; number?: number }>(outPath(workspace.path, "pr.json"));
			const prNumber = pr?.number ?? Number(pr?.url?.match(/\/pull\/(\d+)/)?.[1]);
			if (pr?.branch && Number.isFinite(prNumber) && prNumber > 0) {
				const commentUrl = await postImplementationArtifactsComment({
					repo: repo.repo,
					prNumber,
					branch: pr.branch,
					runId: run.id,
					assistantText: finalAssistantText,
					uploadedArtifacts,
					publicBaseUrl: context.publicBaseUrl,
				});
				if (commentUrl) {
					await emit(context.store, run.id, "external_link", { kind: "pr_comment", url: commentUrl, prUrl: pr.url });
				}
			}
		}
		await context.store.patchRun(run.id, { status: "succeeded", finishedAt: new Date() });
		await emit(context.store, run.id, "status", { status: "succeeded" });
	} catch (error) {
		if (error instanceof CancelledError) {
			await context.store.patchRun(run.id, { status: "cancelled", finishedAt: new Date(), errorMessage: error.message });
			await emit(context.store, run.id, "status", { status: "cancelled" });
		} else {
			const message = error instanceof Error ? error.message : String(error);
			await context.store.patchRun(run.id, { status: "failed", finishedAt: new Date(), errorMessage: message });
			await emit(context.store, run.id, "error", { message });
			throw error;
		}
	} finally {
		restoreEnv(previousEnv);
		process.chdir(previousCwd);
		await app?.stop().catch(() => undefined);
		await workspace?.cleanup().catch(() => undefined);
	}
}

export async function executePreviewWatch(context: ExecutionContext, job: QueueRunJob): Promise<void> {
	const run = await context.store.getRun(job.runId);
	if (!run?.draftPrUrl) return;
	const repo = await context.store.getRepo(run.repoId);
	if (!repo) return;
	const prNumber = Number(run.draftPrUrl.match(/\/pull\/(\d+)/)?.[1]);
	if (!Number.isFinite(prNumber) || prNumber <= 0) return;
	const result: DeploymentLookupResult = await waitForDeploymentUrl({
		repo: repo.repo,
		prNumber,
		prUrl: run.draftPrUrl,
		maxWaitMs: Number(process.env.RETURN_BRIEF_DEPLOYMENT_WAIT_MS ?? 360_000),
		pollIntervalMs: Number(process.env.RETURN_BRIEF_DEPLOYMENT_POLL_MS ?? 30_000),
	});
	if (result.found && result.url) {
		await context.store.patchRun(run.id, { previewUrl: result.url });
		await emit(context.store, run.id, "external_link", { kind: "preview", url: result.url, prUrl: run.draftPrUrl });
	}
}
