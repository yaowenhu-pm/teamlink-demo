# TeamLink public experience

The primary experience is a directly editable landscape shared across devices.
Visitors open the public website or scan a room QR without installing Codex or
signing in. The scene and its changes must match the actual saved room state.
Do not simulate synchronization, model responses, online members or completed work.

## Source and hosting

- Author browser files in `web/`, portable API files in `worker/`, the Node host in `server/`, and schema in
  `db/schema.ts`. Keep generated Drizzle SQL and metadata in `drizzle/`.
- `npm run build` bundles browser files and same-origin media into `build/public/`.
  Do not hand-edit generated build output. Node.js 24 and SQLite run the primary site
  at `https://teamlink.yaowenhu.cn` on the user's Aliyun server.
- Preserve other sites on that server and existing apex/www/beauty/reader/ops DNS.
  Use isolated TeamLink releases, runtime, systemd service, database and Nginx vhost.
  Do not publish future updates to Sites by default. Keep its previous identity only
  as historical configuration; GitHub Pages should direct visitors to the primary domain.
- `npm run build:sites` retains the historical Worker build for compatibility.
- Generate migrations with `npm run db:generate`. Keep them bounded and schema-only;
  append rather than editing applied history. Never create or alter tables from
  visitor request handlers.

## Shared rooms and model calls

- The deployed SQLite database is the shared source of truth through the D1-compatible
  adapter. Preserve capability authorization, same-origin
  writes, payload limits, nonce idempotency and revision CAS. A stale response must
  not overwrite a newer scene.
- Rooms have no cumulative edit or per-room AI call ceiling. Keep six-hour expiry,
  bounded recent messages/history, creation throttles and the daily model budget.
  Durable operation receipts must outlive rolling messages for the room's lifetime.
  Persist a pending nonce before an external
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
fixtures and must not call paid providers or require real secrets. Verify local SQLite
through the Node/SQLite host, then check the published browser path: one device creates a
room, a second device opens its QR, and a successful message changes the same
scene on both. Cover direct editing, failure, expiry, conflicts and mobile layout.
Unit tests, API checks or a successful build alone do not prove that physical QR
scanning, cross-device UI, provider access or deployment works. Report any browser
verification limit without marking the unobserved path as passed.
