import test from "node:test";
import assert from "node:assert/strict";
import { buildImplementChangePrompt, buildRepoOverviewPrompt, buildReviseFromFeedbackPrompt } from "./prompts.js";
import type { RepoTargetConfig } from "./types.js";
import type { ImplementationPlan } from "../implementation-plan.js";

const repo: RepoTargetConfig = {
	id: "demo",
	name: "Demo",
	repo: "owner/demo",
	cloneUrl: "https://github.com/owner/demo.git",
	defaultBranch: "main",
	installCommand: "npm ci",
	startCommand: "npm run dev",
	port: 3000,
};

test("repo overview prompt embeds the requested task", () => {
	const prompt = buildRepoOverviewPrompt(repo, { repoId: "demo", mode: "repo-overview", task: "Check the open PRs" });
	assert.match(prompt, /Check the open PRs/);
	assert.match(prompt, /owner\/demo/);
});

test("implement prompt includes the branch and selected plan", () => {
	const plan: ImplementationPlan = {
		runId: "run-1",
		repo: repo.repo,
		repoRoot: "/tmp/workspace",
		createdAt: new Date().toISOString(),
		branchName: "return-brief/test",
		title: "Issue #1",
		summary: "Implement the issue",
		filesToEdit: ["src/App.tsx"],
		acceptanceCriteria: ["It works"],
		testCommands: ["npm test"],
		afterDemoState: "Visible",
		demoSetupInstructions: [],
		beforeSteps: [],
		afterSteps: [],
		issueNumber: 1,
		issueUrl: "https://github.com/owner/demo/issues/1",
	};
	const prompt = buildImplementChangePrompt(repo, plan);
	assert.match(prompt, /return-brief\/test/);
	assert.match(prompt, /Issue #1/);
});

test("revise prompt embeds operator feedback", () => {
	const prompt = buildReviseFromFeedbackPrompt(repo, { repoId: "demo", mode: "revise-from-feedback", prompt: "Make it more technical." });
	assert.match(prompt, /Make it more technical/);
});

