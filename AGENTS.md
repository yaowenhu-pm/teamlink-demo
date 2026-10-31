# TeamLink public experience

The primary experience is a directly editable landscape shared across devices.
Visitors open the public website or scan a room QR without installing Codex or
signing in. The scene and its changes must match the actual saved room state.
Do not simulate synchronization, model responses, online members or completed work.

## Source and hosting

- Author browser files in `web/`, server files in `worker/`, and schema in
  `db/schema.ts`. Keep generated Drizzle SQL and metadata in `drizzle/`.
- `npm run build` embeds frontend assets in the Worker and generates `dist/`,
  including `.openai/hosting.json` and `.openai/drizzle`. Do not hand-edit `dist/`.
- Preserve the existing hosted Sites project identity, repository, audience and DB
  binding. The Sites owner handles source synchronization and publication. Public
  mirrors use the hosting example rather than private deployment identity.
  GitHub Pages is a static entry; shared room APIs run on the Sites origin.
- Generate migrations with `npm run db:generate`. Keep them bounded and schema-only;
  append rather than editing applied history. Never create or alter tables from
  visitor request handlers.

## Shared rooms and model calls

- D1 is the shared source of truth. Preserve capability authorization, same-origin
  writes, payload limits, nonce idempotency and revision CAS. A stale response must
  not overwrite a newer scene.
- Preserve six-hour expiry, bounded messages/history, creation limits, per-room AI
  limits and the daily model budget. Persist a pending nonce before an external
  request; replay must not call the model again. Show actual pending, failed,
  unsupported and applied outcomes.
- Conversations use ClawHunt and the configured Doubao model through the server
  adapter. Each call sends the current instruction and scene. Make this third-party
  transfer and shared-room visibility clear to visitors.
- Validate every proposed patch with the scene model and compute actual changes
  before applying. Never execute generated code or accept arbitrary tool/URL
  requests. If no model is configured, label the limited command parser honestly.
- CLAW_API_KEY and ROOM_IP_SALT are server-only configuration. Never read, print,
  commit or embed secret values in frontend assets, QR links or exports. Do not
  route public requests through personal Codex credentials.

## Isolation and compatibility

Use independent fictional demo content. Do not copy the private team-relay
database, configuration, member IDs, Feishu documents, credentials or test reports
into the public project.

The previous website and export workspace live in `web/legacy/`. Preserve old
#doc= links, legacy routes, local storage keys and stable shared-copy project
identity. Their local editable-copy sharing is distinct from the current D1 room;
do not claim the legacy tool automatically shares a live document.

## Verification

Use Node.js 24. Run npm test, source syntax checks and npm run build; tests must use
fixtures and must not call paid providers or require real secrets. Verify local D1
through Wrangler, then check the published browser path: one device creates a
room, a second device opens its QR, and a successful message changes the same
scene on both. Cover direct editing, failure, expiry, conflicts and mobile layout.
Unit tests, API checks or a successful build alone do not prove that physical QR
scanning, cross-device UI, provider access or deployment works. Report any browser
verification limit without marking the unobserved path as passed.
