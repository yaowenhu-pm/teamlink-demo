import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, symlink, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createTeamLinkServer, readConfiguration, clientIp } from '../index.mjs';
import { SqliteD1 } from '../sqlite-d1.mjs';
import { backupDatabase } from '../backup.mjs';
import { byteRange, requestTarget } from '../static.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = 'https://teamlink.test';
async function fixture(options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'teamlink-node-'));
  const publicRoot = resolve(directory, 'public'), mediaRoot = resolve(publicRoot, 'media'), migrations = resolve(directory, 'drizzle');
  await mkdir(mediaRoot, { recursive: true });
  await cp(resolve(ROOT, 'drizzle'), migrations, { recursive: true });
  await writeFile(resolve(publicRoot, 'index.html'), '<!doctype html><title>fixture landscape</title>');
  await writeFile(resolve(publicRoot, 'world.mjs'), 'export const fixture = true;');
  await writeFile(resolve(mediaRoot, 'intro.mp4'), Buffer.from('0123456789'));
  await writeFile(resolve(mediaRoot, 'original-score.m4a'), Buffer.from('0123456789'));
  await mkdir(resolve(publicRoot, 'legacy/app'), { recursive: true });
  await writeFile(resolve(publicRoot, 'legacy/app/index.html'), 'legacy fixture');
  await writeFile(resolve(publicRoot, 'legacy/legacy.js'), 'legacy();');
  const environment = { PUBLIC_ORIGIN: ORIGIN, DATABASE_PATH: resolve(directory, 'data/rooms.sqlite'), ROOM_IP_SALT: 'fixture-only-salt-not-a-production-secret',
    HOST: '127.0.0.1', PORT: '0', STATIC_ROOT: publicRoot, MIGRATIONS_DIR: migrations, ...options.environment };
  const config = readConfiguration(environment);
  let application = await createTeamLinkServer({ config, interpret: options.interpret });
  let address = await application.listen();
  const request = (path, { method = 'GET', body, token, headers = {}, raw, signal } = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    ...(!['GET', 'HEAD'].includes(method) ? { body: raw ?? JSON.stringify(body ?? {}) } : {}), redirect: 'manual',
    ...(signal ? { signal } : {}),
  });
  const created = async () => { const response = await request('/api/rooms', { method: 'POST' }); assert.equal(response.status, 201); return response.json(); };
  return { directory, config, publicRoot, mediaRoot, migrations, request, created,
    get application() { return application; },
    async restart() { await application.close(); application = await createTeamLinkServer({ config, interpret: options.interpret }); address = await application.listen(); },
    async close() { await application.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('configuration requires an explicit origin, persistent path, salt and opt-in proxy trust', () => {
  const env = { PUBLIC_ORIGIN: ORIGIN, DATABASE_PATH: '/tmp/teamlink-fixture.sqlite', ROOM_IP_SALT: 'a-fixture-salt-of-sufficient-length' };
  assert.equal(readConfiguration(env).trustProxy, 'off');
  for (const value of [undefined, 'https://teamlink.test/path', 'https://user:pass@teamlink.test', 'file:///tmp/site', 'https://teamlink.test?query=1']) assert.throws(() => readConfiguration({ ...env, PUBLIC_ORIGIN: value }));
  assert.throws(() => readConfiguration({ ...env, DATABASE_PATH: 'relative.sqlite' }));
  assert.throws(() => readConfiguration({ ...env, STATIC_ROOT: '/tmp', DATABASE_PATH: '/tmp/public-room.sqlite' }), /outside all static/);
  assert.throws(() => readConfiguration({ ...env, ROOM_IP_SALT: 'short' }));
  assert.throws(() => readConfiguration({ ...env, TRUST_PROXY: 'all' }));
  assert.throws(() => readConfiguration({ ...env, REQUIRE_AI: 'true' }));
  assert.equal(readConfiguration({ ...env, REQUIRE_AI: 'true', CLAW_API_KEY: 'fixture-key' }).interpreterEnv.CLAW_API_KEY, 'fixture-key');
});

test('only an opted-in loopback proxy may set a single valid X-Real-IP', () => {
  const req = (peer, value) => ({ socket: { remoteAddress: peer }, headers: { 'x-real-ip': value, 'cf-connecting-ip': '198.51.100.5', 'x-forwarded-for': '198.51.100.6' } });
  assert.equal(clientIp(req('203.0.113.8', '198.51.100.1'), 'loopback'), '203.0.113.8');
  assert.equal(clientIp(req('127.0.0.1', '198.51.100.1')), '127.0.0.1');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '198.51.100.1'), 'loopback'), '198.51.100.1');
  assert.equal(clientIp(req('::1', '198.51.100.1, 192.0.2.1'), 'loopback'), '::1');
  assert.equal(clientIp(req('::1', 'not-an-ip'), 'loopback'), '::1');
});

test('server and backup CLI start through deployment symlinks', { timeout: 10000 }, async () => {
  const f = await fixture();
  let child;
  try {
    const entry = resolve(f.directory, 'server-entry.mjs'), backupEntry = resolve(f.directory, 'backup-entry.mjs');
    const databasePath = resolve(f.directory, 'cli-data/rooms.sqlite'), destination = resolve(f.directory, 'cli-backup/rooms.sqlite');
    await symlink(resolve(ROOT, 'server/index.mjs'), entry);
    await symlink(resolve(ROOT, 'server/backup.mjs'), backupEntry);
    const environment = { PATH: process.env.PATH, PUBLIC_ORIGIN: ORIGIN, DATABASE_PATH: databasePath,
      ROOM_IP_SALT: 'fixture-cli-salt-no-production-secret', HOST: '127.0.0.1', PORT: '0',
      STATIC_ROOT: f.publicRoot, MIGRATIONS_DIR: f.migrations };
    child = spawn(process.execPath, [entry], { cwd: f.directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let output = '', errors = '';
    child.stderr.on('data', part => { errors += part; });
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI did not listen through its symlink')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('CLI exited before listening: ' + errors)); });
      child.stdout.on('data', part => {
        output += part;
        const match = output.match(/listening on port (\d+)/);
        if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
      });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/ready`);
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
    assert.ok(!output.includes(environment.ROOM_IP_SALT));
    child.kill('SIGTERM'); assert.equal((await exited)[0], 0); child = null;
    const backupProcess = spawn(process.execPath, [backupEntry, destination], {
      cwd: f.directory, env: { PATH: process.env.PATH, DATABASE_PATH: databasePath }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal((await once(backupProcess, 'exit'))[0], 0);
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM _teamlink_migrations').get().count, 2); snapshot.close();
  } finally { child?.kill('SIGKILL'); await f.close(); }
});

test('startup applies real Drizzle SQL once, rejects drift and rolls back a failed pending migration', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'teamlink-migration-'));
  const migrations = resolve(directory, 'migrations'), databasePath = resolve(directory, 'rooms.sqlite');
  await cp(resolve(ROOT, 'drizzle'), migrations, { recursive: true });
  try {
    let db = new SqliteD1(databasePath, { migrationsDir: migrations });
    assert.equal(db.ready(), true); assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM _teamlink_migrations').get().count, 2);
    db.close(); db = new SqliteD1(databasePath, { migrationsDir: migrations });
    assert.equal(db.database.prepare('SELECT COUNT(*) AS count FROM _teamlink_migrations').get().count, 2); db.close();
    const bad = resolve(migrations, '0001_fixture_invalid.sql');
    await writeFile(bad, 'CREATE TABLE fixture_partial(id INTEGER); INVALID SQL;');
    assert.throws(() => new SqliteD1(databasePath, { migrationsDir: migrations }));
    const raw = new DatabaseSync(databasePath);
    assert.equal(raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'fixture_partial'").get(), undefined); raw.close();
    await rm(bad);
    await appendFile(resolve(migrations, '0000_legal_annihilus.sql'), '\n-- fixture change\n');
    assert.throws(() => new SqliteD1(databasePath, { migrationsDir: migrations }), /history changed/);
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real HTTP room requests retain authorization, nonce replay, CAS, undo and restart persistence', async () => {
  const f = await fixture();
  try {
    const room = await f.created(), route = '/api/rooms/' + room.id;
    assert.equal((await f.request('/api/ready')).status, 200);
    assert.equal((await f.request(route)).status, 401);
    const post = { method: 'POST', token: room.token, body: { nonce: 'once', expectedRevision: 0, patch: { trees: 0, boats: 3, mountains: 4 } } };
    let response = await f.request(route, post), state = await response.json();
    assert.equal(response.status, 200); assert.equal(state.scene.trees, 0); assert.equal(state.scene.boats, 3); assert.equal(state.scene.mountains, 4);
    response = await f.request(route, post); assert.equal(response.status, 200); assert.equal((await response.json()).revision, 1);
    response = await f.request(route, { ...post, body: { ...post.body, patch: { trees: 2 } } });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'NONCE_REUSED');
    response = await f.request(route, { ...post, body: { nonce: 'stale', expectedRevision: 0, patch: { wind: .8 } } });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'REVISION_CONFLICT');
    await f.restart();
    response = await f.request(route, { token: room.token }); state = await response.json();
    assert.equal(state.scene.boats, 3); assert.equal(state.scene.trees, 0);
    f.application.db.database.prepare('UPDATE rooms SET next_message_at = 0 WHERE id = ?').run(room.id);
    response = await f.request(route + '/undo', { method: 'POST', token: room.token, body: { nonce: 'undo-once', expectedRevision: state.revision } });
    state = await response.json(); assert.equal(response.status, 200); assert.equal(state.scene.trees, 40); assert.equal(state.scene.boats, 1);
    f.application.db.database.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - 1, room.id);
    assert.equal((await f.request(route, { token: room.token })).status, 410);
  } finally { await f.close(); }
});

test('simultaneous writes execute atomic CAS and never overwrite the winning version', async () => {
  const f = await fixture();
  try {
    const room = await f.created(), route = '/api/rooms/' + room.id;
    const responses = await Promise.all([21, 33].map(trees => f.request(route, { method: 'POST', token: room.token,
      body: { nonce: 'race-' + trees, expectedRevision: 0, patch: { trees } } })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const state = await (await f.request(route, { token: room.token })).json();
    assert.equal(state.revision, 1); assert.equal(state.messages.length, 1); assert.ok([21, 33].includes(state.scene.trees));
  } finally { await f.close(); }
});

test('AI pending nonce and global budgets persist before the external wait; replay calls no provider twice', async () => {
  let started, release, calls = 0;
  const began = new Promise(resolveStarted => { started = resolveStarted; });
  const f = await fixture({ interpret: () => { calls++; started(); return new Promise(resolveResult => { release = resolveResult; }); } });
  try {
    const room = await f.created(), route = '/api/rooms/' + room.id;
    const command = { method: 'POST', token: room.token, body: { nonce: 'ai-one', expectedRevision: 0, text: '增加两艘船，多两座山，把树全部移除' } };
    const pending = f.request(route, command); await began;
    let response = await f.request(route, command), state = await response.json();
    assert.equal(response.status, 202); assert.equal(state.messages[0].kind, 'pending'); assert.equal(calls, 1);
    assert.equal(f.application.db.database.prepare('SELECT calls FROM ai_usage').get().calls, 1);
    response = await f.request(route, { ...command, body: { nonce: 'while-busy', expectedRevision: 1, patch: { wind: 1 } } });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'ROOM_BUSY');
    release({ supported: true, patch: { boats: 3, mountains: 4, trees: 0 }, reply: 'fixture provider reply' });
    response = await pending; state = await response.json();
    assert.equal(response.status, 200); assert.equal(state.scene.boats, 3); assert.equal(state.scene.mountains, 4); assert.equal(state.scene.trees, 0);
    assert.equal((await f.request(route, command)).status, 200); assert.equal(calls, 1);
    assert.equal(f.application.db.database.prepare('SELECT busy_nonce FROM rooms WHERE id = ?').get(room.id).busy_nonce, null);
  } finally { release?.({ supported: false, patch: {}, reply: 'fixture cleanup' }); await f.close(); }
});

test('HTTP rooms exceed both old caps and retain rolled-out direct and AI receipts across restart', async () => {
  let calls = 0;
  const f = await fixture({interpret: async () => { calls++; return {supported: true, patch: {rain: 0.4}, reply: 'fixture AI applied'}; }});
  try {
    const room = await f.created(), route = '/api/rooms/' + room.id;
    const send = body => f.request(route, {method: 'POST', token: room.token, body});
    const permitNext = () => f.application.db.database.prepare('UPDATE rooms SET next_message_at = 0 WHERE id = ?').run(room.id);
    const oldPatch = {nonce: 'http-before-rolling', expectedRevision: 0,
      patch: {boats: 8, placements: [{id: 'boat:7', x: 0.4, y: 0.7}]}};
    let response = await send(oldPatch), state = await response.json();
    assert.equal(response.status, 200); assert.equal(state.receipt.revision, 1);
    const oldAi = {nonce: 'http-ai-before-rolling', expectedRevision: 1, text: '下点雨'};
    for (let index = 0; index < 25; index++) {
      permitNext(); response = await send(index ? {nonce: 'http-ai-' + index, expectedRevision: state.revision, text: '下点雨'} : oldAi);
      state = await response.json(); assert.equal(response.status, 200);
    }
    assert.equal(calls, 25); assert.equal(state.revision, 51);
    for (let index = 0; index < 120; index++) {
      permitNext(); response = await send({nonce: 'http-rolling-' + index, expectedRevision: state.revision, patch: {boats: 0, wind: index % 2}});
      state = await response.json(); assert.equal(response.status, 200);
    }
    assert.equal(state.revision, 171); assert.equal(state.messages.length, 64);
    assert.equal(state.messages.some(message => [oldAi.nonce, oldPatch.nonce].includes(message.nonce)), false);
    assert.equal(JSON.parse(f.application.db.database.prepare('SELECT history_json FROM rooms WHERE id = ?').get(room.id).history_json).length, 15);
    await f.restart();
    const database = f.application.db.database, before = database.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM operation_receipts WHERE room_id = ?').get(room.id).count, 146);
    for (const [body, kind, revision] of [[oldPatch, 'patch', 1], [oldAi, 'instruction', 3]]) {
      response = await send(body); const replayed = await response.json();
      assert.equal(response.status, 200); assert.equal(replayed.revision, 171); assert.deepEqual(replayed.scene, state.scene);
      assert.equal(replayed.receipt.nonce, body.nonce); assert.equal(replayed.receipt.kind, kind);
      assert.equal(replayed.receipt.revision, revision); assert.equal(replayed.receipt.replayed, true);
      assert.equal(replayed.receipt._requestHash, undefined);
    }
    response = await send({...oldAi, text: '改成另一条消息'});
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'NONCE_REUSED');
    assert.equal(calls, 25); assert.equal(database.prepare('SELECT calls FROM ai_usage').get().calls, 25);
    assert.deepEqual(database.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id), before);
  } finally { await f.close(); }
});

test('Origin is the configured public origin; forged CF/X-Real-IP cannot bypass direct creation limits', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/rooms', { method: 'POST', headers: { Origin: 'https://forged.test', Host: 'forged.test' } })).status, 403);
    assert.equal((await f.request('/api/rooms', { method: 'POST', raw: 'x'.repeat(8193) })).status, 413);
    for (let index = 0; index < 10; index++) {
      const response = await f.request('/api/rooms', { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.' + index, 'X-Real-IP': '198.51.100.' + index } });
      assert.equal(response.status, 201);
    }
    const response = await f.request('/api/rooms', { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.200', 'X-Real-IP': '198.51.100.200' } });
    assert.equal(response.status, 429); assert.equal((await response.json()).code, 'ROOM_CREATION_LIMIT');
  } finally { await f.close(); }
});

test('the daily AI limit and failed provider replays retain the protocol without a per-room cap', async () => {
  let calls = 0;
  const f = await fixture({ interpret: async () => { calls++; throw new Error('fixture provider unavailable'); } });
  try {
    const room = await f.created(), route = '/api/rooms/' + room.id;
    const today = new Date().toISOString().slice(0, 10), sql = f.application.db.database;
    sql.prepare('INSERT INTO ai_usage(day, calls) VALUES (?, 200)').run(today);
    const post = (nonce, expectedRevision) => f.request(route, { method: 'POST', token: room.token, body: { nonce, expectedRevision, text: '下点小雨' } });
    let response = await post('budget-exhausted', 0), result = await response.json();
    assert.equal(response.status, 429); assert.equal(result.code, 'DAILY_AI_LIMIT'); assert.equal(calls, 0);
    assert.equal(sql.prepare('SELECT ai_calls FROM rooms WHERE id = ?').get(room.id).ai_calls, 0);
    sql.prepare('UPDATE ai_usage SET calls = 0 WHERE day = ?').run(today);
    sql.prepare('UPDATE rooms SET ai_calls = 20, next_message_at = 0 WHERE id = ?').run(room.id);
    const revision = result.current.revision;
    response = await post('provider-failed', revision); result = await response.json();
    assert.equal(response.status, 503); assert.equal(result.code, 'INTERPRETATION_UNAVAILABLE'); assert.equal(calls, 1);
    assert.equal(result.current.scene.rain, 0); assert.equal(result.current.messages.at(-1).kind, 'failed');
    assert.equal((await post('provider-failed', revision)).status, 200); assert.equal(calls, 1);
    assert.equal(sql.prepare('SELECT calls FROM ai_usage WHERE day = ?').get(today).calls, 1);
    assert.equal(sql.prepare('SELECT ai_calls FROM rooms WHERE id = ?').get(room.id).ai_calls, 21);
  } finally { await f.close(); }
});

test('graceful close waits for an AI handler even after its browser connection disconnects', async () => {
  let started, release;
  const began = new Promise(resolveStarted => { started = resolveStarted; });
  const f = await fixture({ interpret: () => { started(); return new Promise(resolveResult => { release = resolveResult; }); } });
  try {
    const room = await f.created(), controller = new AbortController();
    const pending = f.request('/api/rooms/' + room.id, { method: 'POST', token: room.token, signal: controller.signal,
      body: { nonce: 'disconnect-during-ai', expectedRevision: 0, text: '把树改成三棵' } });
    await began; controller.abort(); await assert.rejects(pending);
    const closing = f.application.close();
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
    assert.equal(f.application.db.closed, false, 'SQLite stays open while the detached handler finishes');
    release({ supported: true, patch: { trees: 3 }, reply: 'fixture completed' }); await closing;
    const snapshot = new DatabaseSync(f.config.databasePath, { readOnly: true });
    const row = snapshot.prepare('SELECT scene_json, busy_nonce FROM rooms WHERE id = ?').get(room.id);
    assert.equal(JSON.parse(row.scene_json).trees, 3); assert.equal(row.busy_nonce, null); snapshot.close();
  } finally { release?.({ supported: false, patch: {}, reply: 'fixture cleanup' }); await f.close(); }
});

test('readiness requires durable nonce receipts and every atomicity/cleanup trigger', async t => {
  for (const [type, name] of [
    ['TABLE', 'operation_receipts'],
    ['TRIGGER', 'rooms_receipts_insert'],
    ['TRIGGER', 'rooms_receipts_update'],
    ['TRIGGER', 'operation_receipts_guard_update'],
    ['TRIGGER', 'rooms_receipts_delete'],
  ]) {
    await t.test(name, async () => {
      const f = await fixture();
      try {
        assert.equal(f.application.db.ready(), true);
        assert.equal((await f.request('/api/ready')).status, 200);
        f.application.db.database.exec(`DROP ${type} ${name}`);
        assert.equal(f.application.db.ready(), false);
        const response = await f.request('/api/ready');
        assert.equal(response.status, 503);
        assert.equal((await response.json()).ok, false);
        assert.equal((await f.request('/api/health')).status, 200, 'liveness is distinct from schema readiness');
      } finally { await f.close(); }
    });
  }
});

test('readiness reports a SQLite failure without exposing its path or secrets', async () => {
  const f = await fixture();
  try {
    f.application.db.close();
    let response = await f.request('/api/ready'); assert.equal(response.status, 503); assert.equal((await response.json()).ok, false);
    response = await f.request('/api/health'); assert.equal(response.status, 200);
    const result = await response.text(); assert.ok(!result.includes(f.config.databasePath)); assert.ok(!result.includes(f.config.roomIpSalt));
  } finally { await f.close(); }
});

test('static media provides byte ranges, strong fingerprints, HEAD/304, legacy routes and no path/symlink escape', async () => {
  const f = await fixture();
  try {
    let response = await f.request('/media/intro.mp4'); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(await response.text(), '0123456789');
    const etag = response.headers.get('etag'); assert.match(etag, /^"sha256-[0-9a-f]{64}"$/);
    response = await f.request('/media/intro.mp4', { headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await response.text(), '2345');
    response = await f.request('/media/intro.mp4', { headers: { Range: 'bytes=-3' } }); assert.equal(await response.text(), '789');
    response = await f.request('/media/intro.mp4', { headers: { Range: 'bytes=15-20' } }); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */10');
    response = await f.request('/media/intro.mp4', { method: 'HEAD', headers: { Range: 'bytes=2-5' } }); assert.equal(response.status, 206); assert.equal(response.headers.get('content-length'), '4'); assert.equal(await response.text(), '');
    response = await f.request('/media/intro.mp4', { headers: { 'If-None-Match': etag } }); assert.equal(response.status, 304);
    response = await f.request('/media/intro.mp4', { headers: { Range: 'bytes=2-5', 'If-Range': '"wrong"' } }); assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
    const digest = etag.slice('"sha256-'.length, -1);
    response = await f.request('/media/intro.mp4?v=' + digest.slice(0, 12)); assert.match(response.headers.get('cache-control'), /immutable/); await response.arrayBuffer();
    response = await f.request('/'); assert.equal(response.headers.get('cache-control'), 'no-cache'); await response.text();
    response = await f.request('/app'); assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/legacy/app/');
    assert.equal(await (await f.request('/legacy.js')).text(), 'legacy();');
    await writeFile(resolve(f.directory, 'private.txt'), 'outside fixture secret');
    await symlink(resolve(f.directory, 'private.txt'), resolve(f.publicRoot, 'escape.txt'));
    assert.equal((await f.request('/escape.txt')).status, 404);
    assert.equal((await f.request('/server/index.mjs')).status, 404);
    assert.equal((await f.request('/%2fetc/passwd')).status, 400);
    assert.equal((await f.request('/%00.txt')).status, 400);
    assert.throws(() => requestTarget('/%2e%2e/private.txt'), /Bad path/);
    assert.throws(() => requestTarget('/assets/../private.txt'), /Bad path/);
    assert.throws(() => requestTarget('//evil.test/file'), /Bad request target/);
  } finally { await f.close(); }
});

test('M4A soundtrack uses audio/mp4 and preserves HTTP Range and HEAD semantics', async () => {
  const f = await fixture();
  try {
    let response = await f.request('/media/original-score.m4a');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mp4');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(await response.text(), '0123456789');
    response = await f.request('/media/original-score.m4a', { headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'audio/mp4');
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(response.headers.get('content-length'), '4');
    assert.equal(await response.text(), '2345');
    response = await f.request('/media/original-score.m4a', { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'audio/mp4');
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(response.headers.get('content-length'), '4');
    assert.equal(await response.text(), '');
  } finally { await f.close(); }
});

test('SQLite backup includes committed WAL rows and never overwrites an existing backup', async () => {
  const f = await fixture();
  try {
    const room = await f.created(), destination = resolve(f.directory, 'backup/rooms.sqlite');
    await backupDatabase(f.config.databasePath, destination);
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    assert.equal(snapshot.prepare('SELECT id FROM rooms WHERE id = ?').get(room.id).id, room.id); snapshot.close();
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    const before = await readFile(destination);
    await assert.rejects(backupDatabase(f.config.databasePath, destination), /EEXIST/);
    assert.deepEqual(await readFile(destination), before);
  } finally { await f.close(); }
});

test('range parser rejects invalid/multipart requests and clamps valid open/suffix requests', () => {
  assert.deepEqual(byteRange('bytes=2-', 10), { start: 2, end: 9 });
  assert.deepEqual(byteRange('bytes=-30', 10), { start: 0, end: 9 });
  for (const value of ['bytes=8-2', 'bytes=1-2,4-5', 'items=1-2', 'bytes=-0', 'bytes=-', 'bytes=999999999999999999999-']) assert.throws(() => byteRange(value, 10));
});
