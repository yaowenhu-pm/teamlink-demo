# TeamLink public experience

An isolated, public hackathon demo. Latest user direction explicitly requires a
website/QR/GitHub entry point for strangers, with approved fictional demo data.
Do not copy the private team-relay database, configuration, real member IDs,
Feishu documents, tokens, or test reports into this project.

This experience uses deterministic demo rules, not a live LLM or real coding
execution. Label sample Feishu/GitHub artifacts and role switching clearly.
The current primary experience is direct product co-creation: edits to content,
data and behavior must drive the actual computed preview, traces and downloaded
files. Do not restore sequential role/confirmation gates or repair by replay count.
Keep undo, frozen baselines and editable-copy sharing truthful. Visitors do not install Codex or authenticate to try the demo.
Their input stays in their own browser; no analytics or server submission.

Use buildless HTML/CSS/native ESM, no runtime dependencies. Node tests exercise
state transitions; verify full journey and mobile layout in a real browser.
The Sites owner handles source sync and publication. Do not publish credentials.

The root index is the official website; the full workspace lives at app/index.html
and reuses the root ESM modules. Keep legacy root #doc= links redirecting to app/
without dropping query/hash data. The homepage example uses canvas-model.mjs and
passes the exact document to the workspace; do not replace it with canned values.
Preserve normal local storage keys and stable per-session shared project identity.
