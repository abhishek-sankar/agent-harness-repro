/**
 * Maps changed files from a GitHub PR → Playwright navigation steps for a React web app.
 *
 * Heuristics are tuned for a typical React portfolio site:
 *   src/pages/About.tsx  →  /about
 *   src/components/Hero  →  / (scroll to hero)
 *   src/App.tsx          →  /
 *   public/              →  /
 *
 * APP_BASE_URL env var (e.g. http://localhost:3000) anchors all URLs.
 */

export type WalkthroughAction =
	| {
			type: "click";
			/** Candidate selectors are tried in order until one succeeds. */
			selectors: string[];
			description: string;
			optional?: boolean;
	  }
	| {
			type: "evaluate";
			/** JavaScript body executed in the page after hydration and before scrolling. */
			script: string;
			description: string;
			optional?: boolean;
	  };

export interface WalkthroughStep {
	id: string;
	/** Fully-qualified URL to navigate to */
	url: string;
	/** Human description of what's being shown */
	description: string;
	/** How to move through the page after navigation */
	scrollBehavior: "full" | "top" | "section";
	/**
	 * CSS selector for the specific section that changed.
	 * When present, Playwright scrolls to it and briefly highlights it.
	 */
	selector?: string;
	/** ms to hold still after navigation before starting scroll/actions */
	waitAfterNavMs: number;
	/** Seed phrase for ElevenLabs narration */
	narrationHint: string;
	/** Actions that put the app into the state the demo is supposed to show. */
	preRecordActions?: WalkthroughAction[];
}

// ── Route inference rules ─────────────────────────────────────────────────
// Evaluated in order; first match wins.

interface RouteRule {
	pattern: RegExp;
	route: string; // may contain "$1" for captured group
	description: string; // may contain "$1"
	selector?: string;
}

const ROUTE_RULES: RouteRule[] = [
	// ── Explicit page files ──────────────────────────────────────────────
	{ pattern: /src\/pages?\/index\.[jt]sx?$/i, route: "/", description: "homepage" },
	{ pattern: /src\/pages?\/about\.[jt]sx?$/i, route: "/about", description: "about page" },
	{
		pattern: /src\/pages?\/projects?\.[jt]sx?$/i,
		route: "/projects",
		description: "projects page",
	},
	{ pattern: /src\/pages?\/contact\.[jt]sx?$/i, route: "/contact", description: "contact page" },
	{ pattern: /src\/pages?\/blog\.[jt]sx?$/i, route: "/blog", description: "blog" },
	{
		pattern: /src\/pages?\/([a-z][a-z0-9-]+)\.[jt]sx?$/i,
		route: "/$1",
		description: "$1 page",
	},

	// ── Named component → homepage section ──────────────────────────────
	{
		pattern: /components?\/[Hh]ero/,
		route: "/",
		description: "hero section",
		selector: "[data-section=hero], .hero, #hero, header",
	},
	{
		pattern: /components?\/[Nn]av(bar|igation)?/,
		route: "/",
		description: "navigation bar",
		selector: "nav, header",
	},
	{
		pattern: /components?\/[Ff]ooter/,
		route: "/",
		description: "footer",
		selector: "footer",
	},
	{
		pattern: /components?\/[Pp]rojects?[Cc]ard/,
		route: "/projects",
		description: "project cards",
		selector: ".project-card, [data-testid=project-card]",
	},
	{
		pattern: /components?\/[Pp]rojects?/,
		route: "/",
		description: "projects section",
		selector: "[data-section=projects], .projects, #projects",
	},
	{
		pattern: /components?\/[Ss]kill/,
		route: "/",
		description: "skills section",
		selector: "[data-section=skills], .skills, #skills",
	},
	{
		pattern: /components?\/[Ee]xperience/,
		route: "/",
		description: "experience section",
		selector: "[data-section=experience], .experience, #experience",
	},
	{
		pattern: /components?\/[Aa]bout/,
		route: "/",
		description: "about section",
		selector: "[data-section=about], .about, #about",
	},
	{
		pattern: /components?\/[Cc]ontact/,
		route: "/",
		description: "contact section",
		selector: "[data-section=contact], .contact, #contact",
	},
	{
		pattern: /components?\/[Tt]imeline/,
		route: "/",
		description: "timeline",
		selector: ".timeline, [data-section=timeline]",
	},
	{
		pattern: /components?\/[Tt]heme/,
		route: "/",
		description: "theme / dark mode toggle",
		selector: "[data-testid=theme-toggle], .theme-toggle",
	},

	// ── App entry points → homepage ──────────────────────────────────────
	{ pattern: /src\/[Aa]pp\.[jt]sx?$/, route: "/", description: "app shell" },
	{ pattern: /src\/main\.[jt]sx?$/, route: "/", description: "app entry" },
	{ pattern: /src\/index\.[jt]sx?$/, route: "/", description: "homepage" },
	{ pattern: /src\/router\.[jt]sx?$/i, route: "/", description: "homepage (router change)" },

	// ── Styles ───────────────────────────────────────────────────────────
	{ pattern: /\.css$/, route: "/", description: "visual styling" },
	{ pattern: /\.scss$/, route: "/", description: "visual styling (SCSS)" },
	{ pattern: /tailwind\.config/, route: "/", description: "design tokens / Tailwind" },

	// ── Public / static assets → homepage ───────────────────────────────
	{ pattern: /^public\//, route: "/", description: "static assets (homepage)" },
	{ pattern: /^assets\//, route: "/", description: "static assets (homepage)" },

	// ── Config / build files (show homepage as the visible change) ───────
	{ pattern: /vite\.config/, route: "/", description: "build config (homepage)" },
	{ pattern: /package\.json$/, route: "/", description: "dependencies (homepage)" },
];

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Given a list of changed filenames (from a PR diff), return an ordered set of
 * Playwright navigation steps covering the UI surfaces those files affect.
 *
 * @param changedFiles  Array of filenames relative to repo root
 * @param baseUrl       Running app URL, e.g. "http://localhost:3000"
 * @param prTitle       Used to seed narration hints
 */
export function mapFilesToWalkthroughSteps(
	changedFiles: string[],
	baseUrl: string,
	prTitle: string,
): WalkthroughStep[] {
	// Deduplicate by (route + selector) so we don't show the same section twice.
	const seen = new Map<string, WalkthroughStep>();

	for (const file of changedFiles) {
		for (const rule of ROUTE_RULES) {
			const match = file.match(rule.pattern);
			if (!match) continue;

			let route = rule.route;
			let description = rule.description;
			if (match[1]) {
				route = rule.route.replace("$1", match[1].toLowerCase());
				description = rule.description.replace("$1", match[1]);
			}

			const key = `${route}||${rule.selector ?? ""}`;
			if (!seen.has(key)) {
				const slug = route.replace(/\//g, "") || "home";
				seen.set(key, {
					id: `step-${seen.size + 1}-${slug}`,
					url: `${baseUrl}${route}`,
					description,
					scrollBehavior: rule.selector ? "section" : "full",
					selector: rule.selector,
					waitAfterNavMs: 1500,
					narrationHint: `${prTitle} — changes visible in the ${description}`,
				});
			}
			break; // first matching rule wins for this file
		}
	}

	// Always include the homepage as an overview entry (goes first).
	const homepageKey = "/||";
	if (!seen.has(homepageKey)) {
		seen.set(homepageKey, {
			id: "step-0-home",
			url: `${baseUrl}/`,
			description: "homepage overview",
			scrollBehavior: "full",
			waitAfterNavMs: 2000,
			narrationHint: `Overview of "${prTitle}" changes on the portfolio site`,
		});
	}

	// Sort: homepage first, then by URL alphabetically.
	const steps = Array.from(seen.values());
	steps.sort((a, b) => {
		const aIsHome = new URL(a.url).pathname === "/";
		const bIsHome = new URL(b.url).pathname === "/";
		if (aIsHome && !bIsHome) return -1;
		if (!aIsHome && bIsHome) return 1;
		return a.url.localeCompare(b.url);
	});

	// Re-assign sequential IDs after sort.
	steps.forEach((s, i) => {
		s.id = `step-${i + 1}-${new URL(s.url).pathname.replace(/\//g, "") || "home"}`;
	});

	return steps;
}
