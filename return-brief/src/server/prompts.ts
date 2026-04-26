import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImplementationPlan } from "../implementation-plan.js";
import type { RepoTargetConfig, RunRequestInput } from "./types.js";

const PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

function loadPromptFile(name: string): string {
	const path = resolve(PROMPTS_DIR, name);
	return existsSync(path) ? readFileSync(path, "utf8") : `# Missing prompt\n${name}`;
}

export const SERVER_PROMPT_PATHS = [
	resolve(PROMPTS_DIR, "repo-overview.md"),
	resolve(PROMPTS_DIR, "implement-change.md"),
	resolve(PROMPTS_DIR, "revise-from-feedback.md"),
];

export function buildRepoOverviewPrompt(repo: RepoTargetConfig, input: RunRequestInput): string {
	const base = loadPromptFile("repo-overview.md");
	return `${base}

## Invocation
- repo: ${repo.repo}
- mode: ${input.task ? "task_run" : "idle_audit"}
${input.task ? `- task: ${input.task}` : ""}
${input.prompt ? `- operator_prompt: ${input.prompt}` : ""}

Begin now. Work through the tool sequence end-to-end without asking the operator questions.`;
}

export function buildImplementChangePrompt(repo: RepoTargetConfig, plan: ImplementationPlan): string {
	const base = loadPromptFile("implement-change.md");
	return `${base}

## Target
- repo: ${repo.repo}
- repo root: ${plan.repoRoot}
- branch: ${plan.branchName}
- app base url: ${process.env.APP_BASE_URL}
- plan path: ${resolve(plan.repoRoot, "outputs", "implementation-plan.json")}
- mode: implementation
${plan.issueNumber ? `- issue: #${plan.issueNumber} ${plan.issueUrl}` : "- issue: none found; using local suggestion"}

## Selected implementation
${JSON.stringify(plan, null, 2)}
`;
}

export function buildReviseFromFeedbackPrompt(repo: RepoTargetConfig, input: RunRequestInput): string {
	const base = loadPromptFile("revise-from-feedback.md");
	return `${base}

## Invocation
- repo: ${repo.repo}
- feedback: ${input.prompt ?? input.task ?? "No explicit feedback provided."}

Use the same report/video workflow and keep the changes scoped to the requested revision.`;
}

