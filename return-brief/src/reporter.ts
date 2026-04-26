import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Report } from "./types.js";

export function writeReport(report: Report, jsonPath: string, mdPath: string): void {
	mkdirSync(dirname(jsonPath), { recursive: true });
	writeFileSync(jsonPath, JSON.stringify(report, null, 2));
	writeFileSync(mdPath, renderMarkdown(report));
}

export function renderMarkdown(r: Report): string {
	const statusEmoji = r.overallStatus === "green" ? "🟢" : r.overallStatus === "yellow" ? "🟡" : "🔴";
	const lines: string[] = [];
	lines.push(`# Return Brief — ${r.repo}`);
	lines.push("");
	lines.push(`- **Status:** ${statusEmoji} ${r.overallStatus.toUpperCase()}`);
	lines.push(`- **Release readiness:** ${r.releaseReadiness.replace("_", " ")}`);
	lines.push(`- **Mode:** ${r.mode.replace("_", " ")}`);
	lines.push(
		`- **Checked:** ${r.checked.pullRequests} PRs · ${r.checked.issues} issues · ${r.checked.workflowRuns} workflow runs · latest release \`${r.checked.latestRelease ?? "none"}\``,
	);
	lines.push(`- **Generated:** ${r.generatedAt}`);
	lines.push("");

	lines.push("## Findings");
	lines.push("");
	if (r.findings.length === 0) {
		lines.push("_No findings — all clear._");
	} else {
		for (const f of r.findings) {
			const sev = f.severity === "high" ? "🔴" : f.severity === "medium" ? "🟡" : "🟢";
			lines.push(`### ${sev} ${f.title}`);
			lines.push("");
			lines.push(`- **Type:** \`${f.type}\``);
			lines.push(`- **Evidence:** ${f.evidence}`);
			lines.push(`- **Recommended action:** ${f.recommendedAction}`);
			lines.push("");
		}
	}

	lines.push("## Suggested follow-up runs");
	lines.push("");
	for (const s of r.suggestedNextRuns) lines.push(`- ${s}`);
	lines.push("");

	return lines.join("\n");
}
