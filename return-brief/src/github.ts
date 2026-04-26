/**
 * Real GitHub REST API client.
 * Uses GITHUB_TOKEN from env when present; public repos can be read anonymously.
 * Maps GitHub API shapes → the internal types used throughout the pipeline.
 */
import type { IssueSummary, PRSummary, WorkflowRun, Release, RepoSnapshot } from "./types.js";

const BASE = "https://api.github.com";

function apiHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN;
	return {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "return-brief/0.1",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

async function apiGet<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		headers: apiHeaders(),
	});
	const json = (await res.json()) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} for ${path}: ${json.message ?? "(no message)"}`);
	}
	return json as T;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: {
			...apiHeaders(),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} for ${path}: ${json.message ?? "(no message)"}`);
	}
	return json as T;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: "PATCH",
		headers: {
			...apiHeaders(),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status} for ${path}: ${json.message ?? "(no message)"}`);
	}
	return json as T;
}

// ── Raw GitHub shapes ──────────────────────────────────────────────────────

interface GHPullRequest {
	number: number;
	title: string;
	user: { login: string };
	head: { ref: string; sha: string };
	base: { ref: string };
	created_at: string;
	updated_at: string;
	additions: number;
	deletions: number;
	draft: boolean;
	mergeable: boolean | null;
	labels: { name: string }[];
	requested_reviewers: { login: string }[];
}

export interface GHPRFile {
	filename: string;
	status: "added" | "removed" | "modified" | "renamed" | "copied";
	additions: number;
	deletions: number;
	patch?: string;
}

interface GHReview {
	state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
	user: { login: string };
}

interface GHCheckRun {
	name: string;
	conclusion: "success" | "failure" | "neutral" | "skipped" | "cancelled" | "timed_out" | null;
	// GitHub doesn't expose "required" on individual check runs; approximate later.
}

interface GHWorkflowRun {
	id: number;
	name: string;
	event: string;
	conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
	status: "completed" | "in_progress" | "queued";
	created_at: string;
	head_branch: string;
}

interface GHRelease {
	tag_name: string;
	name: string;
	draft: boolean;
	prerelease: boolean;
	published_at: string | null;
	target_commitish: string;
	body: string;
}

interface GHIssue {
	number: number;
	title: string;
	user: { login: string };
	state: "open" | "closed";
	created_at: string;
	updated_at: string;
	labels: { name: string }[];
	body: string | null;
	html_url: string;
	pull_request?: unknown;
}

interface GHIssueComment {
	id: number;
	user: { login: string };
	body: string;
	created_at: string;
	updated_at: string;
	html_url: string;
}

interface GHRepository {
	default_branch: string;
}

interface GHCreatedPullRequest {
	number: number;
	html_url: string;
}

interface GHComment {
	html_url: string;
}

export interface IssueComment {
	id: number;
	author: string;
	body: string;
	createdAt: string;
	updatedAt: string;
	url: string;
}

export interface CreateDraftPullRequestInput {
	repo: string;
	title: string;
	body: string;
	head: string;
	base?: string;
}

export interface CreatedPullRequest {
	number: number;
	url: string;
	baseBranch: string;
}

export interface CreatedIssueComment {
	url: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function fetchPRFiles(repo: string, prNumber: number): Promise<GHPRFile[]> {
	return apiGet<GHPRFile[]>(`/repos/${repo}/pulls/${prNumber}/files?per_page=100`);
}

async function fetchPRReviews(repo: string, prNumber: number): Promise<GHReview[]> {
	return apiGet<GHReview[]>(`/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
}

async function fetchCheckRuns(repo: string, ref: string): Promise<GHCheckRun[]> {
	try {
		const data = await apiGet<{ check_runs: GHCheckRun[] }>(
			`/repos/${repo}/commits/${ref}/check-runs?per_page=100`,
		);
		return data.check_runs ?? [];
	} catch {
		return [];
	}
}

function deriveReviewState(
	reviews: GHReview[],
	requested: { login: string }[],
): PRSummary["reviewState"] {
	if (requested.length === 0 && reviews.length === 0) return "no_reviewer";
	// Latest review per reviewer wins.
	const latest = new Map<string, GHReview>();
	for (const r of reviews) latest.set(r.user.login, r);
	const states = Array.from(latest.values()).map((r) => r.state);
	if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
	if (states.includes("APPROVED")) return "approved";
	return "pending";
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch all open PRs for `repo`, enriching each with files, reviews, and checks.
 * This issues several sub-requests per PR so pace accordingly.
 */
export async function fetchSnapshot(repo: string): Promise<RepoSnapshot> {
	const [rawPRs, rawIssues, workflowData, rawReleases] = await Promise.all([
		apiGet<GHPullRequest[]>(`/repos/${repo}/pulls?state=open&per_page=30`),
		apiGet<GHIssue[]>(`/repos/${repo}/issues?state=open&per_page=30`),
		apiGet<{ workflow_runs: GHWorkflowRun[] }>(
			`/repos/${repo}/actions/runs?per_page=30`,
		).catch(() => ({ workflow_runs: [] })),
		apiGet<GHRelease[]>(`/repos/${repo}/releases?per_page=10`).catch(() => [] as GHRelease[]),
	]);

	const prs: PRSummary[] = await Promise.all(
		rawPRs.map(async (pr) => {
			const [files, reviews, checks] = await Promise.all([
				fetchPRFiles(repo, pr.number),
				fetchPRReviews(repo, pr.number),
				fetchCheckRuns(repo, pr.head.sha),
			]);
			return {
				number: pr.number,
				title: pr.title,
				author: pr.user.login,
				branch: pr.head.ref,
				targetBranch: pr.base.ref,
				createdAt: pr.created_at,
				updatedAt: pr.updated_at,
				changedFiles: files.map((f) => f.filename),
				additions: pr.additions,
				deletions: pr.deletions,
				reviewState: deriveReviewState(reviews, pr.requested_reviewers),
				reviewers: pr.requested_reviewers.map((r) => r.login),
				labels: pr.labels.map((l) => l.name),
				checks: checks.map((c) => ({
					required: false, // approximation — GitHub's "required" needs branch protection API
					name: c.name,
					conclusion: (["success", "failure", "pending"].includes(c.conclusion ?? "")
						? c.conclusion
						: "pending") as "success" | "failure" | "pending",
				})),
				draft: pr.draft,
				mergeable: pr.mergeable,
			} satisfies PRSummary;
		}),
	);

	const workflows: WorkflowRun[] = workflowData.workflow_runs.map((w) => ({
		id: w.id,
		name: w.name,
		event: w.event,
		conclusion: (w.conclusion as WorkflowRun["conclusion"]) ?? null,
		status: w.status as WorkflowRun["status"],
		createdAt: w.created_at,
		branch: w.head_branch,
		required: false,
	}));

	const releases: Release[] = rawReleases.map((r) => ({
		tag: r.tag_name,
		name: r.name,
		draft: r.draft,
		prerelease: r.prerelease,
		publishedAt: r.published_at,
		target: r.target_commitish,
		body: r.body ?? "",
	}));

	const issues: IssueSummary[] = rawIssues
		.filter((i) => !i.pull_request)
		.map((i) => ({
			number: i.number,
			title: i.title,
			author: i.user.login,
			state: i.state,
			createdAt: i.created_at,
			updatedAt: i.updated_at,
			labels: i.labels.map((l) => l.name),
			body: i.body ?? "",
			url: i.html_url,
		}));

	return { repo, prs, issues, workflows, releases };
}

export async function fetchRepositoryDefaultBranch(repo: string): Promise<string> {
	const data = await apiGet<GHRepository>(`/repos/${repo}`);
	return data.default_branch;
}

/**
 * Fetch just the changed files for a single PR.
 * Used by `map_pr_to_ui_routes` after the initial snapshot is assembled.
 */
export async function fetchPRFilesForPR(repo: string, prNumber: number): Promise<GHPRFile[]> {
	return fetchPRFiles(repo, prNumber);
}

export async function fetchIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
	const comments = await apiGet<GHIssueComment[]>(
		`/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
	);
	return comments.map((comment) => ({
		id: comment.id,
		author: comment.user.login,
		body: comment.body ?? "",
		createdAt: comment.created_at,
		updatedAt: comment.updated_at,
		url: comment.html_url,
	}));
}

export async function createDraftPullRequest(input: CreateDraftPullRequestInput): Promise<CreatedPullRequest> {
	const baseBranch = input.base ?? (await fetchRepositoryDefaultBranch(input.repo));
	const created = await apiPost<GHCreatedPullRequest>(`/repos/${input.repo}/pulls`, {
		title: input.title,
		body: input.body,
		head: input.head,
		base: baseBranch,
		draft: true,
	});
	return {
		number: created.number,
		url: created.html_url,
		baseBranch,
	};
}

export async function updatePullRequestBody(repo: string, pullNumber: number, body: string): Promise<void> {
	await apiPatch(`/repos/${repo}/pulls/${pullNumber}`, { body });
}

export async function createIssueComment(repo: string, issueNumber: number, body: string): Promise<CreatedIssueComment> {
	const created = await apiPost<GHComment>(`/repos/${repo}/issues/${issueNumber}/comments`, { body });
	return { url: created.html_url };
}
