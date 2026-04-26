import { fetchIssueComments, type IssueComment } from "./github.js";

export interface DeploymentLookupResult {
	repo: string;
	prNumber: number;
	prUrl?: string;
	found: boolean;
	url?: string;
	urls: string[];
	sourceComment?: {
		id: number;
		author: string;
		url: string;
		createdAt: string;
		snippet: string;
	};
	commentsChecked: number;
	attempts: number;
	elapsedMs: number;
	timedOut: boolean;
	checkedAt: string;
}

interface Candidate {
	url: string;
	score: number;
	comment: IssueComment;
}

const URL_RE = /https?:\/\/[^\s)<>"']+/g;

export function parsePrNumberFromUrl(url: string | undefined): number | undefined {
	if (!url) return undefined;
	const match = url.match(/\/pull\/(\d+)(?:\b|[/?#])/);
	return match ? Number(match[1]) : undefined;
}

function cleanUrl(url: string): string {
	return url.replace(/[.,;:!?]+$/g, "");
}

function scoreUrl(url: string, comment: IssueComment): number {
	const lowerUrl = url.toLowerCase();
	const lowerBody = comment.body.toLowerCase();
	const lowerAuthor = comment.author.toLowerCase();
	let score = 0;
	if (/\.pages\.dev\b/.test(lowerUrl)) score += 100;
	if (/\.workers\.dev\b/.test(lowerUrl)) score += 90;
	if (/trycloudflare\.com\b/.test(lowerUrl)) score += 80;
	if (/cloudflare/.test(lowerUrl)) score += 70;
	if (/cloudflare/.test(lowerBody) || /cloudflare/.test(lowerAuthor)) score += 30;
	if (/preview|deployment|deploy|visit|view/.test(lowerBody)) score += 15;
	return score;
}

function extractCandidates(comments: IssueComment[]): Candidate[] {
	const candidates: Candidate[] = [];
	for (const comment of comments) {
		for (const raw of comment.body.match(URL_RE) ?? []) {
			const url = cleanUrl(raw);
			const score = scoreUrl(url, comment);
			if (score <= 0) continue;
			candidates.push({ url, score, comment });
		}
	}
	candidates.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return Date.parse(b.comment.createdAt) - Date.parse(a.comment.createdAt);
	});
	return candidates;
}

function uniqueUrls(candidates: Candidate[]): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.url)) continue;
		seen.add(candidate.url);
		urls.push(candidate.url);
	}
	return urls;
}

function snippet(body: string): string {
	return body.replace(/\s+/g, " ").trim().slice(0, 280);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDeploymentUrl(opts: {
	repo: string;
	prNumber: number;
	prUrl?: string;
	maxWaitMs: number;
	pollIntervalMs: number;
}): Promise<DeploymentLookupResult> {
	const startedAt = Date.now();
	let attempts = 0;
	let lastComments: IssueComment[] = [];

	while (true) {
		attempts += 1;
		lastComments = await fetchIssueComments(opts.repo, opts.prNumber);
		const candidates = extractCandidates(lastComments);
		const urls = uniqueUrls(candidates);
		if (candidates.length > 0) {
			const best = candidates[0];
			return {
				repo: opts.repo,
				prNumber: opts.prNumber,
				prUrl: opts.prUrl,
				found: true,
				url: best.url,
				urls,
				sourceComment: {
					id: best.comment.id,
					author: best.comment.author,
					url: best.comment.url,
					createdAt: best.comment.createdAt,
					snippet: snippet(best.comment.body),
				},
				commentsChecked: lastComments.length,
				attempts,
				elapsedMs: Date.now() - startedAt,
				timedOut: false,
				checkedAt: new Date().toISOString(),
			};
		}

		const elapsedMs = Date.now() - startedAt;
		if (elapsedMs >= opts.maxWaitMs) {
			return {
				repo: opts.repo,
				prNumber: opts.prNumber,
				prUrl: opts.prUrl,
				found: false,
				urls: [],
				commentsChecked: lastComments.length,
				attempts,
				elapsedMs,
				timedOut: true,
				checkedAt: new Date().toISOString(),
			};
		}

		await sleep(Math.min(opts.pollIntervalMs, opts.maxWaitMs - elapsedMs));
	}
}
