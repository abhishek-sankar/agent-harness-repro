import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding } from "./types.js";
import type { WalkthroughStep } from "./ui-mapper.js";

const IGNORE = new Set([".git", "node_modules", "outputs", "dist", "build", ".next", "coverage"]);
const SOURCE_EXT = /\.(tsx?|jsx?|css|scss|html|md)$/i;

export interface RepoSuggestion {
	title: string;
	kind: "visible_ui" | "quality" | "docs";
	evidence: string;
	recommendedAction: string;
	files: string[];
	route: string;
	selector?: string;
}

function walk(dir: string, root: string, out: string[], depth = 0): void {
	if (depth > 5) return;
	for (const name of readdirSync(dir)) {
		if (IGNORE.has(name)) continue;
		const abs = resolve(dir, name);
		const rel = abs.slice(root.length + 1);
		const st = statSync(abs);
		if (st.isDirectory()) walk(abs, root, out, depth + 1);
		else if (SOURCE_EXT.test(name)) out.push(rel);
	}
}

function readMaybe(root: string, file: string): string {
	const p = resolve(root, file);
	if (!existsSync(p)) return "";
	return readFileSync(p, "utf8").slice(0, 20_000);
}

export function inspectRepoForSuggestions(root: string): RepoSuggestion[] {
	const files: string[] = [];
	walk(root, root, files);

	const suggestions: RepoSuggestion[] = [];
	const hasReadme = existsSync(resolve(root, "README.md"));
	const packageJson = readMaybe(root, "package.json") || readMaybe(root, "return-brief/package.json");
	const appFiles = files.filter((f) => /src\/.*\.(tsx|jsx|css|scss)$/i.test(f));
	const hasTests = files.some((f) => /\.(test|spec)\.(tsx?|jsx?)$/i.test(f));
	const hasA11yHints = appFiles.some((f) => /aria-|role=|alt=/.test(readMaybe(root, f)));
	const appShell = readMaybe(root, "src/App.tsx");

	if (/ProfileSummary|BlogSummary|ReadingSummary|PublicEngagements/.test(appShell)) {
		suggestions.push({
			title: "Add a demo-friendly homepage jump nav",
			kind: "visible_ui",
			evidence:
				"The homepage already has multiple content sections, but no compact way to jump between them during a walkthrough.",
			recommendedAction:
				"Add a small sticky or inline section nav for Profile, Reading, Writing, and Engagements so the demo has visible interaction points.",
			files: ["src/App.tsx", "src/index.css", "src/App.css"].filter((f) => existsSync(resolve(root, f))),
			route: "/",
			selector: "main",
		});
	}

	if (/projects|blogs|reading|engagements/i.test(appShell)) {
		suggestions.push({
			title: "Add a featured work callout to the homepage",
			kind: "visible_ui",
			evidence:
				"The app exposes project, blog, reading, and engagement routes; a visible callout would make the homepage clearer in a demo recording.",
			recommendedAction:
				"Add a compact highlighted callout linking to the strongest project or latest writing route.",
			files: ["src/App.tsx", "src/data/projects.ts", "src/index.css"].filter((f) => existsSync(resolve(root, f))),
			route: "/",
			selector: "main",
		});
	}

	if (appFiles.length > 0 && !hasA11yHints) {
		suggestions.push({
			title: "Add accessibility affordances to the main app surfaces",
			kind: "visible_ui",
			evidence: "Source files exist for a rendered app, but sampled UI files do not include aria roles, labels, or image alt text.",
			recommendedAction: "Add semantic labels to navigation, buttons, and key media, then record the improved walkthrough.",
			files: appFiles.slice(0, 5),
			route: "/",
			selector: "nav, main, button, a",
		});
	}

	if (appFiles.length > 0 && !hasTests) {
		suggestions.push({
			title: "Add a smoke test for the primary rendered route",
			kind: "quality",
			evidence: "The repo has app source files but no detected test/spec files.",
			recommendedAction: "Add a minimal app smoke test or Playwright check covering the homepage load.",
			files: appFiles.slice(0, 5),
			route: "/",
		});
	}

	if (!hasReadme || !/demo|run|start|dev/i.test(readMaybe(root, "README.md"))) {
		suggestions.push({
			title: "Document the local demo run path",
			kind: "docs",
			evidence: "README does not clearly document how to run the app and produce the return brief demo.",
			recommendedAction: "Add concise setup, APP_BASE_URL, GitHub token, and video generation steps.",
			files: ["README.md", ...(packageJson ? ["package.json"] : [])],
			route: "/",
		});
	}

	if (suggestions.length === 0) {
		suggestions.push({
			title: "Polish the homepage walkthrough for demo clarity",
			kind: "visible_ui",
			evidence: "No GitHub issues were found; the highest-value autonomous work is a small visual/demo polish pass.",
			recommendedAction: "Make the first screen clearer, then record a before/after walkthrough.",
			files: appFiles.slice(0, 5),
			route: "/",
		});
	}

	return suggestions
		.sort((a, b) => {
			const rank = { visible_ui: 0, quality: 1, docs: 2 } as const;
			return rank[a.kind] - rank[b.kind];
		})
		.slice(0, 3);
}

export function suggestionsToFindings(suggestions: RepoSuggestion[]): Finding[] {
	return suggestions.map((s, i) => ({
		id: `suggestion-${i + 1}`,
		type: "implementation_suggestion",
		severity: i === 0 ? "medium" : "low",
		title: s.title,
		evidence: s.evidence,
		recommendedAction: s.recommendedAction,
		files: s.files,
	}));
}

export function suggestionsToWalkthroughSteps(
	suggestions: RepoSuggestion[],
	baseUrl: string,
): WalkthroughStep[] {
	return suggestions.map((s, i) => ({
		id: `suggestion-${i + 1}`,
		url: `${baseUrl.replace(/\/$/, "")}${s.route}`,
		description: s.title,
		scrollBehavior: s.selector ? "section" : "full",
		selector: s.selector,
		waitAfterNavMs: 1500,
		narrationHint: `${s.title} — ${s.recommendedAction}`,
	}));
}
