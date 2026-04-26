import type { Finding, Scene } from "./types.js";

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
	width: 1280px; height: 800px;
	font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
	background: #0b0d10; color: #e8eaed; overflow: hidden;
	-webkit-font-smoothing: antialiased;
}
.stage { position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; padding: 72px 80px; }
.chip { display: inline-block; padding: 6px 14px; border-radius: 999px; font-size: 14px; font-weight: 500; letter-spacing: 0.02em; }
.chip.green { background: rgba(52, 199, 89, 0.15); color: #5dd879; }
.chip.yellow { background: rgba(255, 204, 0, 0.15); color: #ffd24a; }
.chip.red { background: rgba(255, 69, 58, 0.15); color: #ff6b61; }
.chip.muted { background: rgba(255,255,255,0.08); color: #aab0b7; }
.eyebrow { font-size: 14px; letter-spacing: 0.18em; color: #8b93a1; text-transform: uppercase; font-weight: 600; }
.title { font-size: 72px; font-weight: 600; letter-spacing: -0.03em; line-height: 1.05; margin-top: 20px; }
.subtitle { font-size: 28px; font-weight: 400; color: #aab0b7; margin-top: 20px; line-height: 1.4; }
.stat-row { display: flex; gap: 28px; margin-top: 48px; }
.stat { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 20px 24px; flex: 1; }
.stat .k { font-size: 13px; color: #8b93a1; letter-spacing: 0.08em; text-transform: uppercase; }
.stat .v { font-size: 36px; font-weight: 600; margin-top: 8px; letter-spacing: -0.02em; }
.caption { position: absolute; bottom: 40px; left: 80px; right: 80px; font-size: 22px; font-weight: 400; line-height: 1.4; color: #e8eaed; opacity: 0; transition: opacity 300ms ease; }
.caption.show { opacity: 1; }
.pr-header { display: flex; align-items: center; gap: 16px; }
.pr-num { font-size: 20px; font-weight: 600; color: #8b93a1; }
.pr-title { font-size: 42px; font-weight: 600; letter-spacing: -0.02em; margin-top: 12px; }
.pr-meta { margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap; }
.panel { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 24px 28px; margin-top: 24px; }
.panel h3 { font-size: 14px; color: #8b93a1; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; }
.panel p { font-size: 20px; line-height: 1.45; margin-top: 10px; }
.q-card { margin: auto; max-width: 900px; width: 100%; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); border-radius: 24px; padding: 48px 56px; }
.q-eyebrow { font-size: 13px; letter-spacing: 0.2em; color: #ffd24a; text-transform: uppercase; font-weight: 600; }
.q-text { font-size: 38px; font-weight: 600; letter-spacing: -0.02em; margin-top: 18px; line-height: 1.2; }
.q-options { margin-top: 32px; display: flex; flex-direction: column; gap: 12px; }
.q-option { padding: 16px 22px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; font-size: 20px; }
.ci-row { display: flex; align-items: flex-start; gap: 16px; padding: 16px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
.ci-row:last-child { border-bottom: none; }
.ci-icon { width: 12px; height: 12px; border-radius: 50%; margin-top: 8px; flex-shrink: 0; }
.ci-icon.fail { background: #ff6b61; }
.ci-icon.pass { background: #5dd879; }
.ci-name { font-size: 22px; font-weight: 600; }
.ci-reason { font-size: 17px; color: #aab0b7; margin-top: 4px; }
.list { margin-top: 20px; }
.list li { font-size: 20px; line-height: 1.55; margin-top: 10px; padding-left: 24px; position: relative; list-style: none; }
.list li::before { content: "→"; position: absolute; left: 0; color: #8b93a1; }
.footer-brand { position: absolute; top: 40px; right: 80px; font-size: 13px; letter-spacing: 0.18em; color: #6b7280; text-transform: uppercase; }
`;

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function captionFallback(scene: Scene, useCaption: boolean): string {
	if (!useCaption) return "";
	return `<div class="caption show">${escapeHtml(scene.narration)}</div>`;
}

function body(scene: Scene): string {
	const d = scene.data as any;
	switch (scene.kind) {
		case "title": {
			const statusClass = d.status === "green" ? "green" : d.status === "red" ? "red" : "yellow";
			return `
				<div class="eyebrow">Return Brief</div>
				<div class="title">${escapeHtml(d.repo)}</div>
				<div class="subtitle">While you were away, I ran an idle audit of your open work.</div>
				<div class="stat-row">
					<div class="stat"><div class="k">Status</div><div class="v"><span class="chip ${statusClass}">${d.status.toUpperCase()}</span></div></div>
					<div class="stat"><div class="k">Release</div><div class="v" style="font-size:22px;font-weight:500">${d.readiness.replace("_", " ")}</div></div>
					<div class="stat"><div class="k">PRs</div><div class="v">${d.checked.pullRequests}</div></div>
					<div class="stat"><div class="k">Issues</div><div class="v">${d.checked.issues ?? 0}</div></div>
					<div class="stat"><div class="k">CI runs</div><div class="v">${d.checked.workflowRuns}</div></div>
				</div>`;
		}
		case "pr_card": {
			const f: Finding = d.finding;
			const sev = f.severity === "high" ? "red" : f.severity === "medium" ? "yellow" : "green";
			const subject = f.prNumber ? `#${f.prNumber}` : f.issueNumber ? `Issue #${f.issueNumber}` : "Suggestion";
			const eyebrow = f.prNumber ? "Pull Request" : f.issueNumber ? "GitHub Issue" : "Implementation Candidate";
			return `
				<div class="eyebrow">${eyebrow}</div>
				<div class="pr-header"><span class="pr-num">${subject}</span><span class="chip ${sev}">${f.severity.toUpperCase()}</span><span class="chip muted">${f.type.replace("_", " ")}</span></div>
				<div class="pr-title">${escapeHtml(f.title)}</div>
				<div class="panel"><h3>Evidence</h3><p>${escapeHtml(f.evidence)}</p></div>
				<div class="panel"><h3>Recommended action</h3><p>${escapeHtml(f.recommendedAction)}</p></div>`;
		}
		case "ci_timeline": {
			const findings: Finding[] = d.findings ?? [];
			return `
				<div class="eyebrow">CI Health</div>
				<div class="title" style="font-size:48px">Release branch signals</div>
				<div class="panel" style="margin-top:32px">
					${findings
						.map(
							(f) => `<div class="ci-row"><div class="ci-icon fail"></div><div><div class="ci-name">${escapeHtml(f.title)}</div><div class="ci-reason">${escapeHtml(f.evidence)}</div></div></div>`,
						)
						.join("")}
				</div>`;
		}
		case "release_status": {
			const readinessClass = d.readiness === "low_risk" ? "green" : d.readiness === "high_risk" ? "red" : "yellow";
			return `
				<div class="eyebrow">Release</div>
				<div class="title">${escapeHtml(d.latestRelease ?? "No candidate cut")}</div>
				<div class="subtitle">Readiness: <span class="chip ${readinessClass}">${String(d.readiness).replace("_", " ")}</span></div>`;
		}
		case "question": {
			const q = scene.question!;
			const opts = q.options ?? [];
			return `
				<div class="q-card">
					<div class="q-eyebrow">Question</div>
					<div class="q-text">${escapeHtml(q.text)}</div>
					<div class="q-options">
						${opts.map((o, i) => `<div class="q-option"><strong style="color:#ffd24a">${i + 1}.</strong> &nbsp;${escapeHtml(o)}</div>`).join("")}
					</div>
				</div>`;
		}
		case "outro": {
			const runs: string[] = d.suggestedNextRuns ?? [];
			return `
				<div class="eyebrow">Next Runs</div>
				<div class="title" style="font-size:56px">Suggested follow-ups</div>
				<ul class="list">
					${runs.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}
				</ul>`;
		}
		case "app_walkthrough":
			return "";
	}
}

export function renderSceneHtml(scene: Scene, opts: { showCaption: boolean }): string {
	return `<!doctype html>
<html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body>
	<div class="stage">
		<div class="footer-brand">Return Brief · Pi Away Mode</div>
		${body(scene)}
		${captionFallback(scene, opts.showCaption)}
	</div>
</body></html>`;
}
