import type {
	Finding,
	IssueSummary,
	OverallStatus,
	PRRisk,
	PRSummary,
	RepoSnapshot,
	Report,
	ReleaseReadiness,
	RiskLevel,
	WorkflowRun,
} from "./types.js";

const SENSITIVE_PATH_PATTERNS = [/auth\//i, /payment/i, /billing/i, /release/i, /config\//i, /session/i];
const STALE_DAYS = 7;

function daysBetween(iso: string, now: Date): number {
	return (now.getTime() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

export function scorePR(pr: PRSummary, now: Date): PRRisk {
	const reasons: string[] = [];
	let score = 0;

	const sensitive = pr.changedFiles.some((f) => SENSITIVE_PATH_PATTERNS.some((re) => re.test(f)));
	if (sensitive) {
		score += 2;
		reasons.push("Touches release-sensitive code (auth/payment/billing/release/session).");
	}

	const total = pr.additions + pr.deletions;
	if (total > 500) {
		score += 1;
		reasons.push(`Large diff (${total} lines changed).`);
	}

	const failingRequired = pr.checks.some((c) => c.required && c.conclusion === "failure");
	if (failingRequired) {
		score += 3;
		reasons.push("A required check is failing.");
	}

	const staleDays = daysBetween(pr.updatedAt, now);
	if (staleDays > STALE_DAYS) {
		score += 1;
		reasons.push(`Stale: no activity for ${Math.floor(staleDays)} days.`);
	}

	if (pr.reviewState === "changes_requested") {
		score += 2;
		reasons.push("Reviewer requested changes.");
	}
	if (pr.reviewState === "no_reviewer") {
		score += 1;
		reasons.push("No reviewer assigned.");
	}

	const level: RiskLevel = score >= 5 ? "high" : score >= 3 ? "medium" : "low";
	return { number: pr.number, score, level, reasons };
}

export function findingsFromPR(pr: PRSummary, risk: PRRisk, now: Date): Finding[] {
	const findings: Finding[] = [];
	const staleDays = daysBetween(pr.updatedAt, now);
	const failingRequired = pr.checks.filter((c) => c.required && c.conclusion === "failure");

	if (failingRequired.length > 0) {
		findings.push({
			id: `pr-${pr.number}-ci-fail`,
			type: "pr_blocked",
			severity: "high",
			title: `PR #${pr.number} has failing required checks`,
			evidence: `${failingRequired.map((c) => c.name).join(", ")} failing on ${pr.branch}.`,
			recommendedAction: "Investigate the failing check before further review.",
			prNumber: pr.number,
		});
		return findings;
	}

	if (staleDays > STALE_DAYS) {
		findings.push({
			id: `pr-${pr.number}-stale`,
			type: "pr_stale",
			severity: risk.level === "high" ? "high" : "medium",
			title: `PR #${pr.number} stale for ${Math.floor(staleDays)} days`,
			evidence: `Last update ${pr.updatedAt}. Reviewers: ${pr.reviewers.join(", ") || "none"}.`,
			recommendedAction:
				pr.reviewers.length === 0
					? "Assign a reviewer or close if abandoned."
					: "Ping reviewers or reassign.",
			prNumber: pr.number,
		});
		return findings;
	}

	if (risk.level === "high") {
		findings.push({
			id: `pr-${pr.number}-risky`,
			type: "pr_risky",
			severity: "high",
			title: `PR #${pr.number} is high-risk for this release`,
			evidence: risk.reasons.join(" "),
			recommendedAction: "Hold merge until reviewer sign-off and CI green.",
			prNumber: pr.number,
		});
		return findings;
	}

	const allGreen = pr.checks.every((c) => c.conclusion === "success");
	if (allGreen && pr.reviewState === "pending") {
		findings.push({
			id: `pr-${pr.number}-ready`,
			type: "pr_ready",
			severity: "low",
			title: `PR #${pr.number} is mergeable — waiting on review`,
			evidence: `All checks passing. Reviewer: ${pr.reviewers.join(", ") || "unassigned"}.`,
			recommendedAction: "Nudge reviewer; likely safe to merge today.",
			prNumber: pr.number,
		});
	}

	return findings;
}

export function findingsFromWorkflows(workflows: WorkflowRun[]): Finding[] {
	const findings: Finding[] = [];
	const failed = workflows.filter((w) => w.conclusion === "failure");
	const releaseFails = failed.filter((w) => w.branch.startsWith("release/"));

	const grouped = new Map<string, WorkflowRun[]>();
	for (const w of releaseFails) {
		const key = `${w.name}:${w.failingJob ?? w.name}`;
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key)!.push(w);
	}

	for (const [key, runs] of grouped) {
		const latest = runs[0];
		findings.push({
			id: `ci-${key.replace(/[^a-z0-9]/gi, "-")}`,
			type: "ci_failure",
			severity: latest.required ? "high" : "medium",
			title: `${latest.name} failing on ${latest.branch} (${runs.length}× in 48h)`,
			evidence: latest.failingReason ?? "See workflow logs.",
			recommendedAction: runs.length > 1
				? "Not a one-off. Open an issue and assign to the owning team."
				: "Rerun once; if it reproduces, flag as blocker.",
			workflowRunId: latest.id,
		});
	}

	return findings;
}

export function findingsFromIssues(issues: IssueSummary[]): Finding[] {
	return issues.slice(0, 5).map((issue) => {
		const labels = issue.labels.map((l) => l.toLowerCase());
		const severity =
			labels.some((l) => /bug|regression|security|sev|p0|p1/.test(l))
				? "medium"
				: "low";
		return {
			id: `issue-${issue.number}`,
			type: "issue_candidate",
			severity,
			title: `Issue #${issue.number}: ${issue.title}`,
			evidence:
				`${issue.url} · labels: ${issue.labels.join(", ") || "none"} · updated ${issue.updatedAt}. ` +
				(issue.body ? issue.body.slice(0, 180).replace(/\s+/g, " ") : "No body provided."),
			recommendedAction: "Implement this on a separate branch if it is small; otherwise produce a scoped plan.",
			issueNumber: issue.number,
		} satisfies Finding;
	});
}

export function assembleReport(
	snapshot: RepoSnapshot,
	opts: { runId: string; mode: "idle_audit" | "task_run"; now?: Date } = {
		runId: "run-1",
		mode: "idle_audit",
	},
): Report {
	const now = opts.now ?? new Date();
	const risks = snapshot.prs.map((pr) => scorePR(pr, now));
	const findings: Finding[] = [];

	for (const pr of snapshot.prs) {
		const risk = risks.find((r) => r.number === pr.number)!;
		findings.push(...findingsFromPR(pr, risk, now));
	}
	findings.push(...findingsFromIssues(snapshot.issues));
	findings.push(...findingsFromWorkflows(snapshot.workflows));

	const latestRelease = snapshot.releases[0] ?? null;
	const anyHighRiskOnRelease =
		latestRelease &&
		snapshot.prs.some((pr) => {
			const r = risks.find((x) => x.number === pr.number)!;
			return r.level === "high" && pr.targetBranch === "main";
		});
	const releaseBranchFailing = snapshot.workflows.some(
		(w) => w.required && w.conclusion === "failure" && w.branch.startsWith("release/"),
	);

	const releaseReadiness: ReleaseReadiness = releaseBranchFailing
		? "high_risk"
		: anyHighRiskOnRelease
			? "medium_risk"
			: "low_risk";

	const severityRank = { low: 0, medium: 1, high: 2 } as const;
	const maxSeverity = findings.reduce((m, f) => Math.max(m, severityRank[f.severity]), 0);
	const overallStatus: OverallStatus =
		maxSeverity >= 2 || releaseReadiness === "high_risk"
			? "yellow"
			: maxSeverity >= 1
				? "yellow"
				: "green";

	const nextRuns = buildSuggestedNextRuns(findings);

	return {
		runId: opts.runId,
		generatedAt: now.toISOString(),
		repo: snapshot.repo,
		mode: opts.mode,
		overallStatus,
		releaseReadiness,
		checked: {
			pullRequests: snapshot.prs.length,
			issues: snapshot.issues.length,
			workflowRuns: snapshot.workflows.length,
			latestRelease: latestRelease?.tag ?? null,
		},
		findings,
		suggestedNextRuns: nextRuns,
	};
}

function buildSuggestedNextRuns(findings: Finding[]): string[] {
	const runs: string[] = [];
	const ciFails = findings.filter((f) => f.type === "ci_failure" && f.severity === "high");
	if (ciFails.length > 0) {
		runs.push(
			`Investigate "${ciFails[0].title}" and produce a patch or issue summary with the failing job logs.`,
		);
	}
	const risky = findings.filter((f) => f.type === "pr_risky");
	for (const f of risky) {
		runs.push(`Review PR #${f.prNumber} with a focus on release-sensitive code paths and produce a risk memo.`);
	}
	const stale = findings.filter((f) => f.type === "pr_stale");
	if (stale.length > 0) {
		runs.push("Triage stale PRs: ping reviewers or mark as abandoned.");
	}
	const issues = findings.filter((f) => f.type === "issue_candidate");
	if (issues.length > 0) {
		runs.push(`Implement ${issues[0].title} on a separate branch and record the app walkthrough.`);
	}
	const suggestions = findings.filter((f) => f.type === "implementation_suggestion");
	if (suggestions.length > 0) {
		runs.push(`Implement "${suggestions[0].title}" on a separate branch and record the app walkthrough.`);
	}
	if (runs.length === 0) {
		runs.push("No GitHub work detected — inspect the local app and implement the highest-confidence UX improvement.");
	}
	return runs;
}
