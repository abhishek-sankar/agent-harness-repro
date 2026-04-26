export type RiskLevel = "low" | "medium" | "high";
export type OverallStatus = "green" | "yellow" | "red";
export type ReleaseReadiness = "low_risk" | "medium_risk" | "high_risk";

export interface PRSummary {
	number: number;
	title: string;
	author: string;
	branch: string;
	targetBranch: string;
	createdAt: string;
	updatedAt: string;
	changedFiles: string[];
	additions: number;
	deletions: number;
	reviewState: "approved" | "changes_requested" | "pending" | "no_reviewer";
	reviewers: string[];
	labels: string[];
	checks: { required: boolean; name: string; conclusion: "success" | "failure" | "pending" }[];
	draft: boolean;
	mergeable: boolean | null;
}

export interface WorkflowRun {
	id: number;
	name: string;
	event: string;
	conclusion: "success" | "failure" | "cancelled" | null;
	status: "completed" | "in_progress" | "queued";
	createdAt: string;
	branch: string;
	required: boolean;
	failingJob?: string;
	failingReason?: string;
}

export interface Release {
	tag: string;
	name: string;
	draft: boolean;
	prerelease: boolean;
	publishedAt: string | null;
	target: string;
	body: string;
}

export interface IssueSummary {
	number: number;
	title: string;
	author: string;
	state: "open" | "closed";
	createdAt: string;
	updatedAt: string;
	labels: string[];
	body: string;
	url: string;
}

export interface RepoSnapshot {
	repo: string;
	prs: PRSummary[];
	issues: IssueSummary[];
	workflows: WorkflowRun[];
	releases: Release[];
}

export interface PRRisk {
	number: number;
	score: number;
	level: RiskLevel;
	reasons: string[];
}

export interface Finding {
	id: string;
	type:
		| "pr_ready"
		| "pr_blocked"
		| "pr_stale"
		| "pr_risky"
		| "ci_failure"
		| "release_risk"
		| "issue_candidate"
		| "implementation_suggestion";
	severity: "low" | "medium" | "high";
	title: string;
	evidence: string;
	recommendedAction: string;
	prNumber?: number;
	issueNumber?: number;
	workflowRunId?: number;
	files?: string[];
}

export interface Report {
	runId: string;
	generatedAt: string;
	repo: string;
	mode: "idle_audit" | "task_run";
	overallStatus: OverallStatus;
	releaseReadiness: ReleaseReadiness;
	checked: {
		pullRequests: number;
		issues: number;
		workflowRuns: number;
		latestRelease: string | null;
	};
	findings: Finding[];
	suggestedNextRuns: string[];
}

export type SceneKind =
	| "title"
	| "pr_card"
	| "ci_timeline"
	| "release_status"
	| "question"
	| "outro"
	/** Playwright recording of the live running app, showing what changed */
	| "app_walkthrough";

export interface Scene {
	id: string;
	kind: SceneKind;
	data: Record<string, unknown>;
	narration: string;
	durationHintMs: number;
	question?: { id: string; text: string; options?: string[] };
	/** Set for app_walkthrough scenes — drives recordWalkthroughScene */
	walkthroughStep?: import("./ui-mapper.js").WalkthroughStep;
}

export interface SceneGraph {
	runId: string;
	scenes: Scene[];
}
