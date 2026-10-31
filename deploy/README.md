# TeamLink on Alibaba Cloud ECS

This target serves the public site, same-origin intro video and the existing room
API from one Node.js 24 process. SQLite stores fresh rooms on the ECS data disk;
the original `worker/rooms.mjs` still owns capability tokens, revision CAS,
nonce replay, expiry, rate limits, pending AI locks and provider budgets.
No old D1 records or personal configuration are read or imported.

## Build and release contents

On the build machine, install the repository's locked development dependencies,
then run:

```sh
node server/build.mjs
node --test server/test/*.test.mjs
```

`build/public` contains a copy of `web`, a bundled `world.mjs` including
`qrcode-generator`, and `media/`. The real renderer/model source files remain
available for the read-only source panel. `index.html` references content
fingerprints for JS/CSS. HTML revalidates; content-matching fingerprint URLs cache
for a year; other assets revalidate after five minutes. Video supports byte ranges.
The root-owned source change must use `/media/teamlink-intro-v1.mp4` in the video.

Copy only these release paths into a new directory such as
`/opt/teamlink/releases/20261101-01/`:

```text
server/             (tests/build script may be omitted at runtime)
worker/rooms.mjs
worker/interpret.mjs
web/scene-model.mjs  (server-side model import; do not omit)
drizzle/            (SQL and its migration history)
build/public/       (all prepared static assets and media)
```

Runtime uses built-in Node modules only. It does not need npm, esbuild,
`node_modules`, `.dev.vars`, a Sites account or Cloudflare credentials. Keep each
release owned by the deploy administrator and read-only to the service account.
Keep `/opt/teamlink/current` as a symlink to the active release. Do not keep any
database or secret inside a release or public directory.

## Environment and first start

Required: `PUBLIC_ORIGIN`, absolute `DATABASE_PATH`, and `ROOM_IP_SALT` with at
least 16 characters. The production example also sets `REQUIRE_AI=true`, making
`CLAW_API_KEY` mandatory. `CLAW_MODEL` defaults in the existing interpreter;
`CLAW_BASE_URL` can only be its fixed ClawHunt endpoint. Without the production
requirement and without a key, health truthfully reports `mode: "commands"`.
No `.env` or `.dev.vars` is auto-loaded.

`PUBLIC_ORIGIN` is the authoritative origin, for example
`https://teamlink.yaowenhu.cn`. Request URLs are built from that value, never a
client Host or forwarded scheme. POST still requires the matching Origin header.
Set the verified domain before testing QR links on phones.

Create a dedicated `teamlink` system user, `/etc/teamlink` owned by root, and
`/var/lib/teamlink` owned by `teamlink` with mode `0700`. Copy
`teamlink.env.example` to `/etc/teamlink/teamlink.env`, mode `0600`, then provision
the real salt and API key through the deployment owner's secure process. Do not
put their values into shell history, deployment logs or a release archive.

Verify `/opt/teamlink/runtime/bin/node --version` is Node.js 24; retain any system Node used by other services. Install the supplied unit as
`/etc/systemd/system/teamlink.service`, check its Node path, point `current` at
the prepared release, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now teamlink
curl --fail http://127.0.0.1:18086/api/health
curl --fail http://127.0.0.1:18086/api/ready
```

Direct manual start, when the environment is already securely injected:

```sh
node /opt/teamlink/current/server/index.mjs
```

Startup opens the persistent database with WAL, FULL synchronization, a 5-second
busy timeout and foreign keys. It applies pending `drizzle/*.sql` inside one
`BEGIN IMMEDIATE` transaction, records SHA-256 checksums, and refuses altered,
missing or out-of-order applied migrations. It never provisions schema from an
HTTP handler. Do not initialize over an unknown pre-existing untracked database.
Run one service process per database; atomic SQL CAS also protects against stale
requests while an AI request is waiting. SIGTERM drains current requests before
closing SQLite; the unit allows 40 seconds.

`/api/health` (`/healthz`) is liveness. `/api/ready` (`/readyz`) verifies that startup
completed and SQLite is readable. Neither returns secret values or the database
path. Provider reachability requires the separate real user-path check below.

## Nginx, TLS and client IPs

Use the supplied Nginx config after replacing the domain and installing a real
certificate. Bootstrap the port-80 ACME location first if using HTTP validation;
enable the TLS block only after certificate files exist. Then run `nginx -t`
before reloading. ECS security-group ingress should expose 80/443 and only the
administrator's required management access. Keep port 18086 bound to loopback.
The owner must finish applicable domain filing/availability checks before making
the mainland site public.

`TRUST_PROXY` defaults to `off`. With the example's explicit `loopback` setting,
only connections from a loopback peer may supply a single valid `X-Real-IP`;
Nginx overwrites it with `$remote_addr`. All client-supplied CF, Forwarded and XFF
identity headers are discarded. Public direct connections cannot impersonate an
IP through those headers. This config assumes Nginx is the internet-facing proxy;
do not add a CDN/proxy layer without separately defining and testing its trusted
address chain. Only trusted local processes should reach the Node socket.

Static resolution is confined to prepared public/media directories, rejects dot
segments/control bytes/encoded separators, checks real paths, and does not expose
server source, database files, deployment configuration or symlink escapes.

## Back up, update and roll back

Use SQLite's online backup API instead of copying an active `.sqlite` file alone;
committed changes may still be in `-wal`. For an already-injected database path:

```sh
node /opt/teamlink/current/server/backup.mjs /var/backups/teamlink/rooms-20261101-01.sqlite
```

The destination must be new. The script creates a consistent snapshot with mode
`0600` and refuses to overwrite an existing backup. Use a protected backup
directory and periodically copy snapshots off the ECS disk. Systemd does not
auto-load `EnvironmentFile` into an interactive shell; the administrator must
provide `DATABASE_PATH` to the backup process without exposing other secrets.

For an update: make a consistent backup, prepare a new immutable release,
atomically replace the `current` symlink, restart `teamlink`, and check readiness
plus the real browser journey. Retain the previous release and backup. Reverting
the symlink is enough only if its schema remains compatible: checksum/missing
migration guards deliberately refuse an older release after incompatible schema
changes. Otherwise stop the service, move the entire current data directory to a
protected rollback directory, restore the matching backup into a fresh data
directory with the original owner/mode, point to the matching release, and start.
Do not delete or separately restore an active database's WAL/SHM sidecars.

## Acceptance before changing the main domain

1. Confirm readiness, intended `mode: "ai"`, TLS and same-origin video seeking.
2. Create a room in a browser; open its actual QR link on a second device.
3. Submit a real instruction, observe the returned change and shared parameters,
   then undo; verify both devices agree.
4. Check a stale revision, repeated nonce, expired room and failed provider outcome.
5. Restart the service and verify an unexpired room remains readable with its key.

Automated tests use fixture directories/SQLite and a fake interpreter only. They
do not establish ECS availability, physical QR scanning, public DNS/TLS, real
provider access or cross-device UI delivery.
