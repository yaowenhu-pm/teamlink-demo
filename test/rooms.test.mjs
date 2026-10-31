import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {handleRooms, ROOM_LIMITS} from '../worker/rooms.mjs';
import {createScene, updateScene} from '../web/scene-model.mjs';

// Use real SQLite to execute production SQL; only the asynchronous D1 call shape is adapted.
class SqliteD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:'); this.queries = [];
    this.database.exec('CREATE TABLE rooms (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, scene_json TEXT NOT NULL, messages_json TEXT NOT NULL DEFAULT \'[]\', history_json TEXT NOT NULL DEFAULT \'[]\', expires_at INTEGER NOT NULL, next_message_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, creator_ip_hash TEXT NOT NULL, ai_calls INTEGER NOT NULL DEFAULT 0, busy_nonce TEXT, busy_until INTEGER NOT NULL DEFAULT 0); CREATE INDEX rooms_expiry_idx ON rooms(expires_at); CREATE INDEX rooms_creator_hour_idx ON rooms(creator_ip_hash, created_at); CREATE TABLE ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0);');
  }
  prepare(sql) {
    this.queries.push(sql);
    return {bind: (...parameters) => ({
      first: async () => this.database.prepare(sql).get(...parameters) ?? null,
      run: async () => this.database.prepare(sql).run(...parameters),
    })};
  }
  row(id) { return this.database.prepare('SELECT * FROM rooms WHERE id = ?').get(id); }
  calls() { return this.database.prepare('SELECT SUM(calls) AS total FROM ai_usage').get().total ?? 0; }
  close() { this.database.close(); }
}
const origin = 'https://teamlink.test';
const environment = () => ({DB: new SqliteD1(), ROOM_IP_SALT: 'test-only-room-salt-of-sufficient-length'});
function request(path, {method = 'GET', token, body, ip = '192.0.2.1', requestOrigin = origin, raw} = {}) {
  const headers = new Headers({'cf-connecting-ip': ip});
  if (token) headers.set('authorization', 'Bearer ' + token);
  if (method === 'POST') { headers.set('origin', requestOrigin); headers.set('content-type', 'application/json'); }
  return new Request(origin + path, {method, headers, ...(method === 'POST' ? {body: raw ?? JSON.stringify(body ?? {})} : {})});
}
async function created(env, options = {}) {
  const response = await handleRooms(request('/api/rooms', {method: 'POST', ...options}), env);
  assert.equal(response.status, 201); return response.json();
}
const route = room => '/api/rooms/' + room.id;
const post = (env, room, value, options, suffix = '') => handleRooms(request(route(room) + suffix,
  {method: 'POST', token: room.token, body: value}), env, options);
async function clock(run) {
  const original = Date.now; let now = original();
  Date.now = () => now;
  try { await run(() => { now += 1100; }, amount => { now += amount; }); }
  finally { Date.now = original; }
}

test('capabilities authorize a real shared row without exposing tokens, IPs or internal nonce fingerprints', async () => {
  const env = environment();
  try {
    const room = await created(env);
    assert.match(room.id, /^[0-9a-f]{32}$/); assert.match(room.token, /^[0-9a-f]{64}$/);
    assert.equal(room.mode, 'commands'); assert.equal(room.revision, 0);
    const row = env.DB.row(room.id);
    assert.notEqual(row.token_hash, room.token); assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(row.creator_ip_hash, '192.0.2.1'); assert.equal(row.expires_at - row.created_at, ROOM_LIMITS.ttlMs);
    const response = await handleRooms(request(route(room), {token: room.token}), env), state = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(state.token, undefined);
    assert.equal(state.token_hash, undefined); assert.equal(state.creator_ip_hash, undefined);
    assert.equal((await handleRooms(request(route(room)), env)).status, 401);
    assert.equal((await handleRooms(request(route(room), {token: '0'.repeat(64)}), env)).status, 403);
    assert.equal(await handleRooms(request('/unrelated'), env), null);
    assert.ok(env.DB.queries.every(sql => !/^\s*(CREATE|ALTER)\s/i.test(sql)), 'request handling never creates schema');
  } finally { env.DB.close(); }
});

test('request shape, same-origin writes, UTF-8 body limits and configuration are enforced before mutation', async () => {
  const env = environment();
  try {
    assert.equal((await handleRooms(request('/api/rooms', {method: 'POST', requestOrigin: 'https://other.test'}), env)).status, 403);
    assert.equal((await handleRooms(request('/api/rooms', {method: 'POST', body: {token: 'untrusted'}}), env)).status, 400);
    assert.equal((await handleRooms(request('/api/rooms', {method: 'POST', raw: '{"broken"'}), env)).status, 400);
    assert.equal((await handleRooms(request('/api/rooms', {method: 'POST', raw: JSON.stringify({scene: '文'.repeat(3000)})}), env)).status, 413);
    assert.equal((await handleRooms(request('/api/rooms', {method: 'POST'}), {...env, ROOM_IP_SALT: undefined})).status, 503);
    const room = await created(env);
    assert.equal((await post(env, room, {nonce: 'bad', expectedRevision: 0, patch: {unknown: true}})).status, 400);
    assert.equal((await post(env, room, {nonce: 'both', expectedRevision: 0, text: '下雨', patch: {rain: 1}})).status, 400);
    assert.equal((await post(env, room, {nonce: 'extra', expectedRevision: 0, patch: {rain: 1}, credential: 'not-accepted'})).status, 400);
    assert.equal(env.DB.row(room.id).revision, 0);
  } finally { env.DB.close(); }
});

test('actual commands, unsupported replies, exact nonce replay and stale revisions preserve shared scene integrity', async () => {
  await clock(async advance => {
    const env = environment();
    try {
      const room = await created(env);
      const body = {nonce: 'set-rain', expectedRevision: 0, patch: {rain: 0.6}};
      let response = await post(env, room, body), state = await response.json();
      assert.equal(response.status, 200); assert.equal(state.scene.rain, 0.6); assert.equal(state.revision, 1);
      assert.equal(state.messages.length, 1); assert.equal(state.messages[0]._requestHash, undefined);
      assert.equal((await post(env, room, body)).status, 200, 'nonce replay precedes rate and revision checks');
      assert.equal(env.DB.row(room.id).revision, 1);
      response = await post(env, room, {...body, patch: {rain: 0.2}});
      assert.equal(response.status, 409); assert.equal((await response.json()).code, 'NONCE_REUSED');
      advance();
      response = await post(env, room, {nonce: 'stale', expectedRevision: 0, patch: {wind: 0.9}});
      assert.equal(response.status, 409); assert.equal((await response.json()).current.scene.rain, 0.6);
      response = await post(env, room, {nonce: 'unknown', expectedRevision: 1, text: '做一个没有定义的新宇宙'});
      state = await response.json();
      assert.equal(response.status, 200); assert.equal(state.messages.at(-1).kind, 'unsupported');
      assert.equal(state.scene.rain, 0.6); assert.deepEqual(state.messages.at(-1).changes, []);
      advance();
      response = await post(env, room, {nonce: 'instruction', expectedRevision: 2, text: '把树木改成12棵'});
      state = await response.json(); assert.equal(response.status, 200); assert.equal(state.scene.trees, 12);
      assert.equal(state.mode, 'commands'); assert.equal(state.messages.at(-1).kind, 'instruction');
    } finally { env.DB.close(); }
  });
});

test('undo uses the bounded server snapshot stack and never rewinds unrelated message history', async () => {
  await clock(async advance => {
    const env = environment();
    try {
      const room = await created(env); let revision = 0;
      for (let trees = 1; trees <= 18; trees++) {
        const response = await post(env, room, {nonce: 'trees-' + trees, expectedRevision: revision, patch: {trees}});
        const state = await response.json(); assert.equal(response.status, 200); revision = state.revision; advance();
      }
      assert.equal(JSON.parse(env.DB.row(room.id).history_json).length, 15);
      let state;
      for (let index = 0; index < 15; index++) {
        const response = await post(env, room, {nonce: 'undo-' + index, expectedRevision: revision}, undefined, '/undo');
        state = await response.json(); assert.equal(response.status, 200); revision = state.revision; advance();
      }
      assert.equal(state.scene.trees, 3); assert.equal(state.messages.length, 33);
      assert.equal(JSON.parse(env.DB.row(room.id).history_json).length, 0);
      const response = await post(env, room, {nonce: 'undo-empty', expectedRevision: revision}, undefined, '/undo');
      state = await response.json(); assert.equal(state.scene.trees, 3); assert.deepEqual(state.messages.at(-1).changes, []);
    } finally { env.DB.close(); }
  });
});

test('creation rates, active room cap, command cap and room expiry are enforced by persisted state', async () => {
  const env = environment();
  try {
    let room;
    for (let index = 0; index < ROOM_LIMITS.creationsPerHour; index++) room = await created(env);
    assert.equal((await handleRooms(request('/api/rooms', {method: 'POST'}), env)).status, 429);
    await created(env, {ip: '192.0.2.2'});
    env.DB.database.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - 1, room.id);
    assert.equal((await handleRooms(request(route(room), {token: room.token}), env)).status, 410);
    const valid = await created(env, {ip: '192.0.2.3'});
    const full = Array.from({length: 64}, (_, index) => ({nonce: 'done-' + index}));
    env.DB.database.prepare('UPDATE rooms SET messages_json = ? WHERE id = ?').run(JSON.stringify(full), valid.id);
    assert.equal((await post(env, valid, {nonce: 'new', expectedRevision: 0, patch: {wind: 0.5}})).status, 429);
    const insert = env.DB.database.prepare('INSERT INTO rooms (id,token_hash,scene_json,expires_at,created_at,creator_ip_hash) VALUES (?,?,?,?,?,?)');
    for (let index = 0; index < 500; index++) insert.run('seed-' + index, '0'.repeat(64), JSON.stringify(createScene()), Date.now() + 60000, Date.now(), 'seed');
    assert.equal((await handleRooms(request('/api/rooms', {method: 'POST', ip: '192.0.2.99'}), env)).status, 429);
  } finally { env.DB.close(); }
});

test('AI reservation is durable: pending replay and busy writes never repeat the provider call', async () => {
  const env = environment(); let release, started;
  const began = new Promise(resolve => { started = resolve; }); let calls = 0;
  const interpret = () => { calls++; started(); return new Promise(resolve => { release = resolve; }); };
  try {
    const room = await created(env), body = {nonce: 'ai-once', expectedRevision: 0, text: '加一些树'};
    const pending = post(env, room, body, {interpret, mode: 'ai'});
    await began;
    const duplicate = await post(env, room, body, {interpret, mode: 'ai'}), current = await duplicate.json();
    assert.equal(duplicate.status, 202); assert.equal(current.messages[0].kind, 'pending'); assert.equal(current.revision, 1);
    assert.equal((await post(env, room, {nonce: 'patch-while-busy', expectedRevision: 1, patch: {rain: 1}}, {interpret})).status, 409);
    assert.equal((await post(env, room, {nonce: 'undo-while-busy', expectedRevision: 1}, {interpret}, '/undo')).status, 409);
    assert.equal(calls, 1); assert.equal(env.DB.calls(), 1);
    release({supported: true, patch: {trees: 55}, reply: '已把树木改为55棵。'});
    const completed = await pending, state = await completed.json();
    assert.equal(completed.status, 200); assert.equal(state.scene.trees, 55); assert.equal(state.revision, 2);
    assert.equal(state.messages.length, 1); assert.equal(state.messages[0].kind, 'instruction');
    assert.equal((await post(env, room, body, {interpret})).status, 200); assert.equal(calls, 1); assert.equal(env.DB.calls(), 1);
    assert.equal(env.DB.row(room.id).ai_calls, 1); assert.equal(env.DB.row(room.id).busy_nonce, null);
  } finally { env.DB.close(); }
});

test('AI failures and invalid model patches leave a durable non-retryable nonce without changing scene', async () => {
  await clock(async advance => {
    const env = environment(); let calls = 0;
    try {
      const room = await created(env);
      const interpret = async () => { calls++; throw Error('provider detail must stay private'); };
      const body = {nonce: 'failed-ai', expectedRevision: 0, text: '改变场景'};
      const response = await post(env, room, body, {interpret}), result = await response.json();
      assert.equal(response.status, 503); assert.equal(result.code, 'INTERPRETATION_UNAVAILABLE');
      assert.deepEqual(result.current.scene, createScene()); assert.equal(result.current.messages[0].kind, 'failed');
      assert.ok(!JSON.stringify(result).includes('provider detail'));
      assert.equal((await post(env, room, body, {interpret})).status, 200); assert.equal(calls, 1);
      advance();
      const invalid = await post(env, room, {nonce: 'invalid-ai', expectedRevision: 2, text: '树变多'},
        {interpret: async () => ({supported: true, patch: {trees: 999999}, reply: '不能相信未经验证的数值'})});
      assert.equal(invalid.status, 503); assert.deepEqual((await invalid.json()).current.scene, createScene());
      assert.equal(env.DB.calls(), 2);
    } finally { env.DB.close(); }
  });
});

test('daily and room AI budgets reject before a provider call; direct scene editing stays available', async () => {
  await clock(async advance => {
    const env = environment(); let calls = 0;
    const interpret = async () => { calls++; return {supported: true, patch: {rain: 1}, reply: '下雨了'}; };
    try {
      const room = await created(env);
      env.DB.database.prepare('INSERT INTO ai_usage(day,calls) VALUES (?,?)').run(new Date().toISOString().slice(0, 10), 200);
      const response = await post(env, room, {nonce: 'daily-limit', expectedRevision: 0, text: '下雨'}, {interpret});
      const result = await response.json();
      assert.equal(response.status, 429); assert.equal(result.code, 'DAILY_AI_LIMIT'); assert.equal(calls, 0);
      assert.equal(env.DB.calls(), 200); assert.equal(env.DB.row(room.id).ai_calls, 0);
      advance();
      const direct = await post(env, room, {nonce: 'direct-still-works', expectedRevision: result.current.revision, patch: {rain: 0.8}}, {interpret});
      assert.equal(direct.status, 200); assert.equal((await direct.json()).scene.rain, 0.8); assert.equal(calls, 0);
      advance();
      env.DB.database.prepare('UPDATE rooms SET ai_calls = 20 WHERE id = ?').run(room.id);
      const blocked = await post(env, room, {nonce: 'room-limit', expectedRevision: 3, text: '下雨'}, {interpret});
      assert.equal(blocked.status, 429); assert.equal((await blocked.json()).code, 'ROOM_AI_LIMIT'); assert.equal(calls, 0);
    } finally { env.DB.close(); }
  });
});

test('an AI result cannot overwrite a newer scene after waiting', async () => {
  const env = environment(); let release, started;
  const began = new Promise(resolve => { started = resolve; });
  try {
    const room = await created(env);
    const pending = post(env, room, {nonce: 'late', expectedRevision: 0, text: '树木改成2棵'},
      {interpret: () => { started(); return new Promise(resolve => { release = resolve; }); }});
    await began;
    const newer = updateScene(createScene(), {wind: 0.9});
    env.DB.database.prepare('UPDATE rooms SET scene_json = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(newer), room.id);
    release({supported: true, patch: {trees: 2}, reply: '旧版本上的结果'});
    const response = await pending, result = await response.json();
    assert.equal(response.status, 409); assert.equal(result.code, 'AI_RESULT_STALE'); assert.deepEqual(result.current.scene, newer);
    assert.deepEqual(JSON.parse(env.DB.row(room.id).scene_json), newer);
  } finally { env.DB.close(); }
});

test('polling reclaims an expired pending lease and its nonce cannot trigger another model call', async () => {
  await clock(async (advance, elapse) => {
    const env = environment(); let release, started, calls = 0;
    const began = new Promise(resolve => { started = resolve; });
    const interpret = () => { calls++; started(); return new Promise(resolve => { release = resolve; }); };
    try {
      const room = await created(env), body = {nonce: 'lease-expired', expectedRevision: 0, text: '树木改成2棵'};
      const pending = post(env, room, body, {interpret});
      await began; elapse(ROOM_LIMITS.busyMs + 1);
      const poll = await handleRooms(request(route(room), {token: room.token}), env, {interpret});
      const state = await poll.json();
      assert.equal(state.messages[0].kind, 'failed'); assert.equal(state.revision, 2);
      assert.equal(env.DB.row(room.id).busy_nonce, null);
      assert.equal((await post(env, room, body, {interpret})).status, 200); assert.equal(calls, 1);
      release({supported: true, patch: {trees: 2}, reply: '这个结果已经太晚'});
      const result = await (await pending).json();
      assert.deepEqual(result.scene, createScene()); assert.equal(result.messages[0].kind, 'failed');
      assert.equal(env.DB.calls(), 1);
    } finally { env.DB.close(); }
  });
});

test('two writes from the same scene revision have one winner and one explicit conflict', async () => {
  const env = environment();
  try {
    const room = await created(env);
    const responses = await Promise.all([
      post(env, room, {nonce: 'concurrent-a', expectedRevision: 0, patch: {trees: 11}}),
      post(env, room, {nonce: 'concurrent-b', expectedRevision: 0, patch: {trees: 22}}),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const states = await Promise.all(responses.map(response => response.json()));
    const winner = states[responses.findIndex(response => response.status === 200)];
    const conflict = states[responses.findIndex(response => response.status === 409)];
    assert.equal(conflict.code, 'REVISION_CONFLICT'); assert.equal(conflict.current.scene.trees, winner.scene.trees);
    const row = env.DB.row(room.id);
    assert.equal(row.revision, 1); assert.equal(JSON.parse(row.messages_json).length, 1);
  } finally { env.DB.close(); }
});

test('concurrent rooms cannot spend the final daily model allowance twice', async () => {
  const env = environment(); let providerCalls = 0;
  const interpret = async () => { providerCalls++; return {supported: true, patch: {wind: 0.8}, reply: '按明确数值修改风力。'}; };
  try {
    const first = await created(env), second = await created(env);
    env.DB.database.prepare('INSERT INTO ai_usage(day,calls) VALUES (?,?)').run(new Date().toISOString().slice(0, 10), 199);
    const responses = await Promise.all([
      post(env, first, {nonce: 'last-first', expectedRevision: 0, text: '风大一些'}, {interpret}),
      post(env, second, {nonce: 'last-second', expectedRevision: 0, text: '风大一些'}, {interpret}),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 429]);
    assert.equal(providerCalls, 1); assert.equal(env.DB.calls(), 200);
    const blocked = await responses.find(response => response.status === 429).json();
    assert.equal(blocked.code, 'DAILY_AI_LIMIT');
  } finally { env.DB.close(); }
});
