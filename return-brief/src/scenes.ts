import type { Report, Scene, SceneGraph } from "./types.js";
import type { WalkthroughStep } from "./ui-mapper.js";

function mkId(i: number, kind: string): string {
	return `${String(i).padStart(2, "0")}-${kind}`;
}

export interface SceneGraphOptions {
	/**
	 * Per-PR walkthrough steps produced by map_pr_to_ui_routes.
	 * When present, PR scenes become live-app recordings instead of static cards.
	 * Map key is the PR number.
	 */
	prWalkthroughSteps?: Map<number, WalkthroughStep[]>;
	suggestionWalkthroughSteps?: WalkthroughStep[];
}

export function buildSceneGraph(report: Report, opts: SceneGraphOptions = {}): SceneGraph {
	const scenes: Scene[] = [];
	let i = 1;

	// ── Title ──────────────────────────────────────────────────────────────
	scenes.push({
		id: mkId(i++, "title"),
		kind: "title",
		data: {
			repo: report.repo,
			status: report.overallStatus,
			readiness: report.releaseReadiness,
			checked: report.checked,
		},
		narration: `While you were away, I ran an idle audit of ${report.repo}. I reviewed ${report.checked.pullRequests} open pull requests, ${report.checked.issues} open issues, ${report.checked.workflowRuns} recent workflow runs, and the release candidate ${report.checked.latestRelease ?? "on main"}. Overall status: ${report.overallStatus}. Release readiness: ${report.releaseReadiness.replace("_", " ")}.`,
		durationHintMs: 8000,
	});

	// ── PR findings ────────────────────────────────────────────────────────
	const prFindings = report.findings.filter((f) => f.prNumber !== undefined);
	for (const f of prFindings) {
		const steps = opts.prWalkthroughSteps?.get(f.prNumber!);

		if (steps && steps.length > 0) {
			// ── Walkthrough path: one walkthrough scene per changed section ──
			// Brief static card first (short duration — just establishes context).
			scenes.push({
				id: mkId(i++, `pr-${f.prNumber}`),
				kind: "pr_card",
				data: { finding: f },
				narration: `Pull request ${f.prNumber}: ${f.title}. ${f.evidence}`,
				durationHintMs: 5000,
			});

			// Then one live-app scene per section.
			for (const step of steps) {
				scenes.push({
					id: mkId(i++, `walk-${f.prNumber}-${step.id}`),
					kind: "app_walkthrough",
					data: { finding: f, step },
					narration: buildWalkthroughNarration(f, step),
					durationHintMs: 9000,
					walkthroughStep: step,
				});
			}
		} else {
			// ── Fallback path: static pr_card (no app URL configured) ────────
			scenes.push({
				id: mkId(i++, `pr-${f.prNumber}`),
				kind: "pr_card",
				data: { finding: f },
				narration: `Pull request ${f.prNumber}. ${f.title}. ${f.evidence} My recommendation: ${f.recommendedAction}`,
				durationHintMs: 7500,
			});

			// Keep question cards for high-severity findings in fallback mode.
			if (f.severity === "high") {
				const qPrompt = questionPrompt(f);
				if (qPrompt) {
					scenes.push({
						id: mkId(i++, `q-pr-${f.prNumber}`),
						kind: "question",
						data: { prNumber: f.prNumber, title: f.title },
						narration: qPrompt.narration,
						durationHintMs: 4500,
						question: {
							id: `pr-${f.prNumber}-action`,
							text: qPrompt.text,
							options: qPrompt.options,
						},
					});
				}
			}
		}
	}

	const issueFindings = report.findings.filter((f) => f.type === "issue_candidate");
	for (const f of issueFindings) {
		scenes.push({
			id: mkId(i++, `issue-${f.issueNumber}`),
			kind: "pr_card",
			data: { finding: f },
			narration: `${f.title}. ${f.evidence} My autonomous recommendation: ${f.recommendedAction}`,
			durationHintMs: 7500,
		});
	}

	const suggestionFindings = report.findings.filter((f) => f.type === "implementation_suggestion");
	for (const f of suggestionFindings) {
		scenes.push({
			id: mkId(i++, `suggestion-${scenes.length}`),
			kind: "pr_card",
			data: { finding: f },
			narration: `${f.title}. ${f.evidence} I can implement this on a separate branch and use the running app to show the result.`,
			durationHintMs: 7000,
		});
	}

	for (const step of opts.suggestionWalkthroughSteps ?? []) {
		scenes.push({
			id: mkId(i++, `walk-${step.id}`),
			kind: "app_walkthrough",
			data: { step },
			narration: `Here is the live app surface I would use for the autonomous implementation demo. ${step.narrationHint}`,
			durationHintMs: 9000,
			walkthroughStep: step,
		});
	}

	// ── CI findings ────────────────────────────────────────────────────────
	const ciFindings = report.findings.filter((f) => f.type === "ci_failure");
	if (ciFindings.length > 0) {
		scenes.push({
			id: mkId(i++, "ci"),
			kind: "ci_timeline",
			data: { findings: ciFindings },
			narration: `On CI, I found ${ciFindings.length} issue${ciFindings.length === 1 ? "" : "s"} on the release branch. ${ciFindings[0].evidence} This has repeated, so it is likely a real regression, not a flake.`,
			durationHintMs: 8000,
		});

		scenes.push({
			id: mkId(i++, "q-ci"),
			kind: "question",
			data: { finding: ciFindings[0] },
			narration: `Do you want me to investigate the failing integration test in a follow-up run, or hand it to the owning team?`,
			durationHintMs: 4500,
			question: {
				id: "ci-followup",
				text: `How should I handle "${ciFindings[0].title}"?`,
				options: ["Investigate in a follow-up run", "Open an issue for the team", "Leave it"],
			},
		});
	}

	// ── Release status ─────────────────────────────────────────────────────
	scenes.push({
		id: mkId(i++, "release"),
		kind: "release_status",
		data: { readiness: report.releaseReadiness, latestRelease: report.checked.latestRelease },
		narration: `For the release: the candidate is ${report.checked.latestRelease ?? "not cut yet"}. Readiness is ${report.releaseReadiness.replace("_", " ")}. ${
			report.releaseReadiness === "high_risk"
				? "I would not ship until required CI is green."
				: report.releaseReadiness === "medium_risk"
					? "Proceed with caution after review sign-off."
					: "Looks shippable on this axis."
		}`,
		durationHintMs: 7000,
	});

	// ── Outro ──────────────────────────────────────────────────────────────
	scenes.push({
		id: mkId(i++, "outro"),
		kind: "outro",
		data: { suggestedNextRuns: report.suggestedNextRuns },
		narration: `That's the brief. My top suggestion for a follow-up run: ${report.suggestedNextRuns[0]} Reply with your answers to the questions above and I'll launch the next run.`,
		durationHintMs: 7000,
	});

	return { runId: report.runId, scenes };
}

// ── Narration builder for walkthrough scenes ───────────────────────────────

function buildWalkthroughNarration(
	finding: import("./types.js").Finding,
	step: WalkthroughStep,
): string {
	const severity =
		finding.severity === "high"
			? "This is a high-severity change."
			: finding.severity === "medium"
				? "Worth reviewing before merge."
				: "";

	return `Here's the ${step.description}. ${step.narrationHint}. ${finding.evidence} ${severity}`.trim();
}

// ── Question prompts (used in fallback / no-app mode) ─────────────────────

function questionPrompt(
	f: import("./types.js").Finding,
): { narration: string; text: string; options: string[] } | undefined {
	const prompts: Record<string, { narration: string; text: string; options: string[] }> = {
		pr_blocked: {
			narration: `This PR is blocking itself with a failing required check on release-sensitive code. Should I flag pull request ${f.prNumber} as a release blocker?`,
			text: `Flag PR #${f.prNumber} as a release blocker?`,
			options: ["Yes, block the release", "No, let the PR owner fix it", "Defer — not touching this release"],
		},
		pr_risky: {
			narration: `This one touches release-sensitive code. Should I flag pull request ${f.prNumber} as a release blocker?`,
			text: `Flag PR #${f.prNumber} as a release blocker?`,
			options: ["Yes, block the release", "No, allow merge", "Defer to PR owner"],
		},
		pr_stale: {
			narration: `Pull request ${f.prNumber} has been stale for a while. Want me to chase the reviewers, or close it out as abandoned?`,
			text: `How should I handle stale PR #${f.prNumber}?`,
			options: ["Chase the reviewers", "Close as abandoned", "Leave it"],
		},
	};
	return prompts[f.type];
}
