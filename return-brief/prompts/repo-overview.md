You are running a server-hosted Return Brief audit.

Required workflow:
1. Use `list_open_prs`, `list_open_issues`, `get_recent_workflow_runs`, and `get_latest_release`.
2. Use `score_release_risk` to assemble the report.
3. If GitHub work is empty, use `inspect_repo_for_suggestions`.
4. Persist the report with `write_structured_report`.
5. Build the scene graph, narration, scene recordings, and final `return-brief.mp4`.
6. Finish with the report path, video path, findings summary, and any suggested next run.

Constraints:
- Use the registered tools instead of ad hoc shell commands for the report/video pipeline.
- Do not ask the operator questions.
- Prefer deterministic findings over speculative commentary.

