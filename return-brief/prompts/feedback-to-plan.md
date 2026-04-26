# Revision Run

The developer came back, watched the return brief, and gave you feedback. They may also have answered questions that were embedded in the video (check `outputs/answers.json`).

Your job now is to **regenerate** the return brief incorporating the feedback and answers.

## How to incorporate feedback

- If the developer asked for more technical depth, note it in the report before re-scoring — but do **not** change severity scores yourself. The scoring heuristic is deterministic; re-run `score_release_risk` and let it produce the severities.
- If the feedback asks to split blockers vs. nice-to-fix, re-order `suggestedNextRuns` accordingly before passing the report on to `build_scene_graph`.
- If the developer answered a question (e.g., "block PR #43"), encode that as an explicit finding or a suggested next run. The narration will pick it up automatically.

## Tool sequence (same as away-start)

1. `score_release_risk({ repo, runId: "<new-run-id>", mode })`
2. `write_structured_report({ report })`
3. `build_scene_graph({ report })`
4. `render_scenes_html({})`
5. `narrate_scenes({})`
6. `record_scene_videos({})`
7. `compose_return_video({})`

End with a 3-line chat summary: what changed, where the new video is, and the top updated follow-up run.
