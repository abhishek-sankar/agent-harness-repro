import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectRepoForSuggestions, suggestionsToWalkthroughSteps, type RepoSuggestion } from "./repo-inspector.js";
import type { IssueSummary } from "./types.js";
import type { WalkthroughStep } from "./ui-mapper.js";

export interface ImplementationPlan {
	runId: string;
	repo: string;
	repoRoot: string;
	createdAt: string;
	branchName: string;
	title: string;
	summary: string;
	filesToEdit: string[];
	acceptanceCriteria: string[];
	testCommands: string[];
	afterDemoState: string;
	demoSetupInstructions: string[];
	beforeSteps: WalkthroughStep[];
	afterSteps: WalkthroughStep[];
	selectedSuggestion?: RepoSuggestion;
	selectedIssue?: IssueSummary;
	issueNumber?: number;
	issueUrl?: string;
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 48) || "implementation";
}

function readPackageScripts(repoRoot: string): Record<string, string> {
	const pkgPath = resolve(repoRoot, "package.json");
	if (!existsSync(pkgPath)) return {};
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
		return pkg.scripts ?? {};
	} catch {
		return {};
	}
}

function inferTestCommands(repoRoot: string): string[] {
	const scripts = readPackageScripts(repoRoot);
	const commands: string[] = [];
	if (scripts.lint) commands.push("npm run lint");
	if (scripts.build) commands.push("npm run build");
	if (commands.length === 0 && existsSync(resolve(repoRoot, "package.json"))) {
		commands.push("npm install --ignore-scripts", "npm run build");
	}
	return commands;
}

function existingFiles(repoRoot: string, files: string[]): string[] {
	return files.filter((f) => existsSync(resolve(repoRoot, f)));
}

function filesForIssue(repoRoot: string, issue: IssueSummary): string[] {
	const text = `${issue.title}\n${issue.body}`.toLowerCase();
	if (/dark mode|theme|color|colour/.test(text)) {
		return existingFiles(repoRoot, ["src/App.tsx", "src/index.css", "src/App.css"]);
	}
	if (/blog|writing|post/.test(text)) {
		return existingFiles(repoRoot, ["src/components/BlogPages.tsx", "src/components/BlogSummary.tsx", "src/data/blogs.ts", "src/App.tsx"]);
	}
	if (/project|portfolio|work/.test(text)) {
		return existingFiles(repoRoot, ["src/components/ProjectPages.tsx", "src/components/ProjectPaper.tsx", "src/data/projects.ts", "src/App.tsx"]);
	}
	return existingFiles(repoRoot, ["src/App.tsx", "src/index.css", "src/App.css"]);
}

function isDarkModeIssue(issue: IssueSummary): boolean {
	return /dark mode|dark theme|theme toggle|color mode|colour mode/.test(`${issue.title}\n${issue.body}`.toLowerCase());
}

function issueRoute(issue: IssueSummary): string {
	const text = `${issue.title}\n${issue.body}`.toLowerCase();
	if (/blog|writing|post/.test(text)) return "/blogs";
	if (/project|portfolio|work/.test(text)) return "/projects";
	if (/reading|paper/.test(text)) return "/reading";
	if (/engagement|talk|event/.test(text)) return "/engagements";
	return "/";
}

function issueToWalkthroughStep(issue: IssueSummary, appBaseUrl: string): WalkthroughStep {
	const route = issueRoute(issue);
	return {
		id: `issue-${issue.number}`,
		url: `${appBaseUrl.replace(/\/$/, "")}${route}`,
		description: `Issue #${issue.number}: ${issue.title}`,
		scrollBehavior: "full",
		waitAfterNavMs: 1500,
		narrationHint: `Implementation for GitHub issue ${issue.number}: ${issue.title}`,
	};
}

function issueAfterStep(issue: IssueSummary, appBaseUrl: string): WalkthroughStep {
	const step = issueToWalkthroughStep(issue, appBaseUrl);
	if (!isDarkModeIssue(issue)) return step;
	return {
		...step,
		scrollBehavior: "top",
		selector: "[data-testid=theme-toggle]",
		waitAfterNavMs: 1200,
		narrationHint: `After implementation, activate dark mode for GitHub issue ${issue.number}: ${issue.title}`,
		preRecordActions: [
			{
				type: "click",
				description: "Enable dark mode for the after-state demo recording.",
				selectors: [
					"[data-testid=theme-toggle]",
					"[data-theme-toggle]",
					"button[aria-label*='theme' i]",
					"button[aria-label*='dark' i]",
					"button:has-text('Dark')",
					"button:has-text('Theme')",
				],
			},
		],
	};
}

export function buildImplementationPlan(opts: {
	repo: string;
	repoRoot: string;
	appBaseUrl: string;
	runId: string;
	suggestionIndex?: number;
}): ImplementationPlan {
	const suggestions = inspectRepoForSuggestions(opts.repoRoot);
	const selected = suggestions[Math.max(0, Math.min(opts.suggestionIndex ?? 0, suggestions.length - 1))];
	const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	const branchName = `return-brief/${slugify(selected.title)}-${timestamp}`;
	const steps = suggestionsToWalkthroughSteps([selected], opts.appBaseUrl);

	return {
		runId: opts.runId,
		repo: opts.repo,
		repoRoot: opts.repoRoot,
		createdAt: new Date().toISOString(),
		branchName,
		title: selected.title,
		summary: selected.recommendedAction,
		filesToEdit: selected.files,
		acceptanceCriteria: [
			"The change is visible on the route recorded in the before/after walkthrough.",
			"The app still renders meaningful content at APP_BASE_URL.",
			"The implementation stays scoped to the selected suggestion and does not include unrelated rewrites.",
		],
		testCommands: inferTestCommands(opts.repoRoot),
		afterDemoState: "Show the implemented change in its most visible state before recording the after demo.",
		demoSetupInstructions: [
			"Before calling record_implementation_after, make sure the app is in the visible post-change state the demo is meant to prove.",
			"If the change adds a toggle, filter, modal, or stateful control, expose a stable data-testid and add or preserve a matching preRecordActions entry in afterSteps.",
		],
		beforeSteps: steps,
		afterSteps: steps,
		selectedSuggestion: selected,
	};
}

export function buildIssueImplementationPlan(opts: {
	repo: string;
	repoRoot: string;
	appBaseUrl: string;
	runId: string;
	issue: IssueSummary;
}): ImplementationPlan {
	const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	const branchName = `return-brief/issue-${opts.issue.number}-${slugify(opts.issue.title)}-${timestamp}`;
	const step = issueToWalkthroughStep(opts.issue, opts.appBaseUrl);
	const afterStep = issueAfterStep(opts.issue, opts.appBaseUrl);
	const body = opts.issue.body.trim();
	const darkModeIssue = isDarkModeIssue(opts.issue);

	return {
		runId: opts.runId,
		repo: opts.repo,
		repoRoot: opts.repoRoot,
		createdAt: new Date().toISOString(),
		branchName,
		title: `Issue #${opts.issue.number}: ${opts.issue.title}`,
		summary: body || `Implement GitHub issue #${opts.issue.number}.`,
		filesToEdit: filesForIssue(opts.repoRoot, opts.issue),
		acceptanceCriteria: [
			`The implementation addresses GitHub issue #${opts.issue.number}.`,
			"The change is visible in the recorded app demo.",
			...(darkModeIssue ? ["The after demo visibly activates and records the dark-mode state, not the default light state."] : []),
			"The app still renders meaningful content at APP_BASE_URL.",
			"The draft PR includes the implementation demo artifact.",
		],
		testCommands: inferTestCommands(opts.repoRoot),
		afterDemoState: darkModeIssue
			? "Dark mode enabled on the running app before and during the after-state recording."
			: "The implemented issue is shown in its most visible post-change state before and during the after-state recording.",
		demoSetupInstructions: darkModeIssue
			? [
					"Implement a visible theme control with data-testid=\"theme-toggle\".",
					"Before the after recording, the recorder will click the theme control through afterSteps[0].preRecordActions.",
					"Make sure that click activates dark mode and that the resulting page clearly differs from the baseline recording.",
			  ]
			: [
					"Before calling record_implementation_after, put the app into the state that proves the issue is implemented.",
					"If the proof requires a click or other setup, add a stable selector to the UI and preserve or refine afterSteps[].preRecordActions.",
			  ],
		beforeSteps: [step],
		afterSteps: [afterStep],
		selectedIssue: opts.issue,
		issueNumber: opts.issue.number,
		issueUrl: opts.issue.url,
	};
}
