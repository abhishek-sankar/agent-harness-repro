import test from "node:test";
import assert from "node:assert/strict";
import { assembleReport } from "./heuristics.js";
import type { RepoSnapshot } from "./types.js";

test("assembleReport marks a failing release workflow as high risk", () => {
	const snapshot: RepoSnapshot = {
		repo: "owner/repo",
		prs: [
			{
				number: 12,
				title: "Tighten auth flow",
				author: "alice",
				branch: "feature/auth",
				targetBranch: "main",
				createdAt: "2026-04-20T00:00:00.000Z",
				updatedAt: "2026-04-24T00:00:00.000Z",
				changedFiles: ["src/auth.ts"],
				additions: 120,
				deletions: 20,
				reviewState: "pending",
				reviewers: ["bob"],
				labels: ["auth"],
				checks: [{ required: true, name: "ci", conclusion: "failure" }],
				draft: false,
				mergeable: true,
			},
		],
		issues: [],
		workflows: [
			{
				id: 99,
				name: "release",
				event: "push",
				conclusion: "failure",
				status: "completed",
				createdAt: "2026-04-24T12:00:00.000Z",
				branch: "release/2026.04.24",
				required: true,
			},
		],
		releases: [
			{
				tag: "v1.2.3",
				name: "v1.2.3",
				draft: false,
				prerelease: false,
				publishedAt: "2026-04-23T00:00:00.000Z",
				target: "main",
				body: "",
			},
		],
	};

	const report = assembleReport(snapshot, { runId: "run-1", mode: "idle_audit" });
	assert.equal(report.overallStatus, "yellow");
	assert.equal(report.releaseReadiness, "high_risk");
	assert.ok(report.findings.some((finding) => finding.type === "ci_failure"));
});
