# Return Brief — Async DevEx Agent on Pi

**Thesis:** internal developer agents should not be chat-first. When the developer is away, the agent should inspect engineering state, and when the developer comes back, hand off a **narrated video walkthrough with embedded questions** — not a transcript.

Return Brief is a [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) extension that:

- **Idle-audits** open PRs, CI runs, and the release candidate.
- **Implements GitHub issues** on a separate branch, records a before/after app walkthrough, and opens a draft PR.
- **Pulls live GitHub issues and PRs**; if there is no open GitHub work, it inspects the local repo and proposes autonomous implementation candidates.
- **Scores** PR + release risk deterministically — the LLM summarizes and prioritizes, it does not invent severity.
- **Renders a return brief as a video**: live app walkthrough scenes → Playwright recordings → ElevenLabs narration → ffmpeg composition.
- **Embeds questions** in the video. The developer answers after watching; the answers steer the next run.

## Pi-on-Railway MVP

The repo now also includes a Pi-backed service runtime inside [`return-brief/`](/Users/abhisheksankar/Documents/Development/agent-harness-repro/return-brief):

- `npm run api` starts the operator API.
- `npm run worker` starts the BullMQ worker that clones repos, starts apps, runs Pi in-process, records Playwright demos, and uploads artifacts.
- The worker loads only the local Return Brief extension plus three curated prompts: `repo-overview`, `implement-change`, and `revise-from-feedback`.
- The API exposes:
  - `GET /api/repos`
  - `GET /api/repos/:id/prs`
  - `GET /api/repos/:id/issues`
  - `POST /api/runs`
  - `GET /api/runs`
  - `GET /api/runs/:id`
  - `GET /api/runs/:id/events`
  - `POST /api/runs/:id/cancel`

For Railway, deploy two services from `return-brief/`:

- `Dockerfile.api`
- `Dockerfile.worker`

Both services need the same core env: `AGENT_API_TOKEN`, `DATABASE_URL`, `REDIS_URL`, provider API keys, `GITHUB_TOKEN`, and `RETURN_BRIEF_REPOS_JSON`. The worker also needs Playwright-compatible Chromium, `git`, and `ffmpeg`; the Dockerfiles install those.

## Quickstart

```bash
# 1. Install dependencies for the extension (Playwright, undici, etc.)
cd return-brief && npm install && npx playwright install chromium && cd ..

# 2. Copy env template
cp .env.example .env
# Fill in ANTHROPIC_API_KEY (required), GITHUB_TOKEN for private repos, and APP_BASE_URL for the running app.

# 3. Pick a mode for the demo
cp tasks.idle.json tasks.json       # idle audit (default demo path)
# or: cp tasks.assigned.json tasks.json   # task run

# 4. Launch pi with the extension loaded
pi -e ./return-brief/index.ts
```

Inside pi:

```
/away-start --repo owner/name
# Agent runs: get_runtime_config → list_open_prs → list_open_issues → get_pr_details → get_recent_workflow_runs
#           → get_latest_release → score_release_risk → write_structured_report
#           → inspect_repo_for_suggestions when GitHub has no work
#           → build_scene_graph → render_scenes_html → narrate_scenes
#           → record_scene_videos → compose_return_video
# Artifacts land in outputs/

/away-doctor
# Shows masked runtime config and verifies APP_BASE_URL renders real app content.

/away-implement --repo owner/name
# Pulls the top open issue, validates APP_BASE_URL, records before-state footage,
# creates return-brief/issue-<n>-<slug>-<timestamp>, seeds Pi to implement it,
# records after-state footage, commits outputs/implementation-demo.mp4, pushes,
# opens a draft PR, then polls PR comments for the Cloudflare preview URL.

/away-preview
# Re-checks the latest PR comments for the Cloudflare preview URL and opens it.

/away-watch
# Opens outputs/return-brief.mp4 and prompts you for answers at each question scene.

/away-feedback "Make it more technical; separate release blockers from nice-to-fix items."
# Regenerates report + scene graph + video.

/away-continue
# Launches the top suggested follow-up run, informed by any captured answers.
```

## Architecture

```
pi (minimal terminal harness)
  └── return-brief/                  ← pi extension
        ├── index.ts                   registers all tools + commands
        ├── prompts/                   away-system.md, feedback-to-plan.md
        └── src/
            ├── types.ts
            ├── config.ts              .env loading + runtime diagnostics
            ├── app-target.ts          APP_BASE_URL reachability + hydration checks
            ├── deployment.ts          Cloudflare preview URL extraction from PR comments
            ├── implementation-plan.ts branch/demo implementation planner
            ├── data-source.ts         live GitHub snapshot loader
            ├── github.ts              GitHub REST client for PRs, issues, CI, releases
            ├── repo-inspector.ts      local repo suggestions when GitHub has no issues
            ├── heuristics.ts          deterministic PR + release scoring
            ├── reporter.ts            Markdown + JSON writers
            ├── scenes.ts              report → scene graph
            ├── html.ts                scene → 1280×800 styled HTML
            ├── voice.ts               ElevenLabs TTS + local speech fallback
            ├── record.ts              Playwright static + live-app capture
            ├── walkthrough.ts         records APP_BASE_URL routes
            └── compose.ts             ffmpeg concat + audio mux + question index
```

### Return-video pipeline

```
live GitHub + repo inspection → outputs/runs/<runId>/report.json → scenes.json
                                                           → static cards + APP_BASE_URL walkthrough recordings
                                                           → scenes/<id>.mp3 narration
                                                           → return-brief.mp4 + questions.json

GitHub issue → implementation plan → before app recording → branch + code edits
             → after app recording → implementation-demo.mp4 → draft PR
             → PR comment polling → Cloudflare preview URL
```

### Pi tools (MCP-style boundary)

Audit tools are **read-only** and schema-typed (TypeBox). The `/away-implement` path is intentionally write-capable: it branches, lets Pi edit code, records the app, commits the demo artifact, pushes, and opens a draft PR. Other destructive variants (rerun CI, comment on PR) are intentionally not implemented — they would live behind an approval gate in a real deployment.

| Tool | Purpose |
|---|---|
| `get_runtime_config` | Masked env/repo/output diagnostics |
| `validate_app_target` | Fails fast if `APP_BASE_URL` is unreachable or unhydrated |
| `list_open_prs` | Live GitHub open PR summaries |
| `list_open_issues` | Live GitHub open issues, excluding PRs |
| `get_pr_details` | Full PR with reviews, checks, and deterministic risk score |
| `get_recent_workflow_runs` | Last N workflow runs |
| `get_latest_release` | Latest release / RC |
| `score_release_risk` | Assembles the full `Report` |
| `inspect_repo_for_suggestions` | Local repo implementation candidates when GitHub has no open work |
| `map_pr_to_ui_routes` | Maps changed files to live app walkthrough routes |
| `write_structured_report` | `outputs/report.{json,md}` |
| `build_scene_graph` | `outputs/scenes.json` |
| `render_scenes_html` | `outputs/scenes/<id>.html` |
| `narrate_scenes` | `outputs/scenes/<id>.mp3` + measured durations |
| `record_scene_videos` | `outputs/scenes/<id>.mp4` |
| `compose_return_video` | `outputs/return-brief.mp4` + `outputs/questions.json` |
| `write_implementation_plan` | Demoable autonomous implementation plan |
| `record_implementation_baseline` | Before-state app footage |
| `record_implementation_after` | After-state app footage |
| `compose_implementation_demo` | `outputs/implementation-demo.mp4` |
| `create_draft_issue_pr` | Commit code + demo artifact, push branch, open draft PR |
| `wait_for_pr_deployment_url` | Poll PR comments for the Cloudflare preview URL and write `outputs/deployment-url.json` |
| `save_feedback` | Appends to `outputs/feedback.log` |
| `launch_followup_run` | Seeds `tasks.json` for the next run |

## Narrative anchors

- **Async-first, not chat-first.** `/away-start` is the front door, not free-form chat.
- **Tool-bounded.** Every action is a named, schema'd tool; idle mode is read-only.
- **Evidence-backed.** Risk scoring is deterministic; the LLM summarizes and prioritizes but does not invent severity.
- **Actual demos.** Walkthrough scenes open `APP_BASE_URL` and record the running app, not just generated HTML cards.
- **Branch-and-build happy path.** `/away-implement` pulls an issue, records before, creates a branch, lets Pi edit code, records after, and opens a draft PR.
- **Preview handoff.** After the draft PR opens, Return Brief waits for the Cloudflare bot comment, extracts the preview URL, and saves it so the developer can open the running PR deployment directly.
- **The return experience is a video.** The developer *watches* the handoff. The video asks questions at moments that need judgment.
- **Feedback → next run.** The revision loop is first-class.

## Dependencies

- `pi` (`@mariozechner/pi-coding-agent`) — terminal harness
- `playwright` + Chromium — headless scene recording
- `undici` — ElevenLabs REST calls
- `ffmpeg` / `ffprobe` — composition (install via Homebrew: `brew install ffmpeg`)
- `fastify`, `bullmq`, `pg`, `ioredis` — service runtime
- S3-compatible bucket support via AWS SDK, with a local artifact-store fallback for development

## Known limits (intentional — scoped for a demo)

- No local GitHub mocks. Public repos work anonymously; private repos need `GITHUB_TOKEN`.
- If GitHub has no open PRs or issues, the agent generates implementation suggestions from local code/docs and records the app surface it would change.
- `APP_BASE_URL` must already be running; the extension validates it but does not start the app server.
- Run artifacts are scoped under `outputs/runs/<runId>/`, with latest aliases copied to `outputs/return-brief.mp4` and `outputs/implementation-demo.mp4`.
- No MCP server; the pi tool registry *is* the tool-boundary story for now.
- No destructive actions. Future work: approval-gated `rerun_workflow`, `comment_on_pr`, `request_review`.
