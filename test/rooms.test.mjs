import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {handleRooms, ROOM_LIMITS} from '../worker/rooms.mjs';
import {createScene, updateScene, moveSceneObject, duplicateSceneObject, removeSceneObject, leafPath} from '../web/scene-model.mjs';
import {defaultScenePatch} from '../web/direct-edit.mjs';

// Use real SQLite to execute production SQL; only the asynchronous D1 call shape is adapted.
class SqliteD1 {
  constructor({migrate = true} = {}) {
    this.database = new DatabaseSync(':memory:'); this.queries = [];
    this.database.exec('PRAGMA foreign_keys = ON');
    const directory = new URL('../drizzle/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      if (migrate || name.startsWith('0000_')) this.database.exec(readFileSync(new URL(name, directory), 'utf8'));
    }
  }
  prepare(sql) {
    this.queries.push(sql);
    return {bind: (...parameters) => ({
      first: async () => this.database.prepare(sql).get(...parameters) ?? null,
      run: async () => this.database.prepare(sql).run(...parameters),
    })};
  }
  row(id) { return this.database.prepare('SELECT * FROM rooms WHERE id = ?').get(id); }
  receipt(id, nonce) { return this.database.prepare('SELECT * FROM operation_receipts WHERE room_id = ? AND nonce = ?').get(id, nonce); }
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

test('restoring defaults confirms the same room, resets every field atomically, and remains undoable without a model call', async () => {
  await clock(async advance => {
    const env = environment(); let providerCalls = 0;
    const options = {interpret: async () => { providerCalls++; throw Error('Direct resets must not call a provider'); }};
    try {
      const room = await created(env);
      const leafTrail = [{x: 0.1, y: 0.2}, {x: 0.8, y: 0.4}, {x: 0.4, y: 0.9}];
      const changed = updateScene(createScene(), {seed: 188, hour: 4.5, trees: 8, rain: 0.8, wind: 0.9,
        branchAngle: 70, branchDepth: 7, boats: 0, mountains: 4, birds: 12, flowers: 4,
        placements: [{id: 'tree:0', x: 0.18, y: 0.72}, {id: 'mountain:3', x: 0.84, y: 0.62}],
        leafTrail, leafOrigin: leafTrail[0], leafTarget: leafTrail.at(-1)});
      const {schemaVersion, ...editedPatch} = changed;
      let response = await post(env, room, {nonce: 'before-default-reset', expectedRevision: 0, patch: editedPatch}, options);
      let state = await response.json(); assert.equal(response.status, 200); assert.deepEqual(state.scene, changed);
      const previousMessage = state.messages[0]; advance();

      const operation = {nonce: 'restore-whole-landscape', expectedRevision: state.revision, patch: defaultScenePatch()};
      response = await post(env, room, operation, options); state = await response.json();
      assert.equal(response.status, 200); assert.equal(state.id, room.id); assert.deepEqual(state.scene, createScene());
      assert.equal(state.receipt.kind, 'patch'); assert.equal(state.canUndo, true);
      assert.deepEqual(state.messages[0], previousMessage, 'reset retains the room conversation');
      assert.ok(state.messages.at(-1).changes.some(change => change.key === 'placements'));
      assert.ok(state.messages.at(-1).changes.some(change => change.key === 'leafTrail'));
      response = await post(env, room, operation, options);
      const replayed = await response.json(); assert.equal(response.status, 200); assert.equal(replayed.revision, state.revision);

      advance();
      response = await post(env, room, {nonce: 'confirm-already-default', expectedRevision: state.revision, patch: defaultScenePatch()}, options);
      state = await response.json(); assert.equal(response.status, 200); assert.deepEqual(state.scene, createScene());
      assert.deepEqual(state.messages.at(-1).changes, []);
      assert.equal(JSON.parse(env.DB.row(room.id).history_json).length, 2, 'confirmation does not add an empty undo step');

      advance();
      response = await post(env, room, {nonce: 'undo-default-reset', expectedRevision: state.revision}, options, '/undo');
      state = await response.json(); assert.equal(response.status, 200); assert.deepEqual(state.scene, changed);
      advance();
      response = await post(env, room, {nonce: 'stale-default-reset', expectedRevision: operation.expectedRevision, patch: defaultScenePatch()}, options);
      const conflict = await response.json(); assert.equal(response.status, 409); assert.deepEqual(conflict.current.scene, changed);
      assert.deepEqual(JSON.parse(env.DB.row(room.id).scene_json), changed); assert.equal(providerCalls, 0);
    } finally { env.DB.close(); }
  });
});

test('legacy room rows and undo snapshots normalize counts without dropping old boat visibility', async () => {
  await clock(async advance => {
    const env = environment();
    try {
      const room = await created(env);
      const legacy = { ...createScene() };
      for (const key of ['boats', 'mountains', 'birds', 'placements', 'leafOrigin', 'leafTarget', 'leafTrail']) delete legacy[key];
      const legacyHidden = { ...legacy, boat: false };
      env.DB.database.prepare('UPDATE rooms SET scene_json = ?, history_json = ? WHERE id = ?')
        .run(JSON.stringify(legacy), JSON.stringify([legacyHidden]), room.id);
      let response = await handleRooms(request(route(room), {token: room.token}), env), state = await response.json();
      assert.equal(response.status, 200); assert.equal(state.scene.boats, 1); assert.equal(state.scene.mountains, 2);
      assert.equal(state.scene.birds, 3); assert.deepEqual(state.scene.placements, []);
      assert.deepEqual(state.scene.leafOrigin, {x: 0.32, y: 0.24});
      assert.deepEqual(state.scene.leafTrail, []);
      response = await post(env, room, {nonce: 'new-counts', expectedRevision: 0, patch: {boats: 3, mountains: 5, trees: 0}});
      state = await response.json(); assert.equal(response.status, 200);
      assert.equal(state.scene.boats, 3); assert.equal(state.scene.mountains, 5); assert.equal(state.scene.boat, true);
      assert.deepEqual(state.messages.at(-1).changes.map(item => item.key), ['trees', 'boats', 'mountains']);
      advance();
      response = await post(env, room, {nonce: 'undo-counts', expectedRevision: state.revision}, undefined, '/undo');
      state = await response.json(); assert.equal(response.status, 200);
      assert.equal(state.scene.boats, 1); assert.equal(state.scene.mountains, 2); assert.equal(state.scene.trees, 40);
      advance();
      response = await post(env, room, {nonce: 'undo-old-hidden-boat', expectedRevision: state.revision}, undefined, '/undo');
      state = await response.json(); assert.equal(response.status, 200);
      assert.equal(state.scene.boats, 0); assert.equal(state.scene.boat, false); assert.equal(state.scene.mountains, 2);
      assert.deepEqual(state.messages.at(-1).changes, [{key: 'boats', label: '帆船数量', before: 1, after: 0}]);
      assert.equal(JSON.parse(env.DB.row(room.id).history_json).length, 0);
    } finally { env.DB.close(); }
  });
});

test('actual room patches preserve moved objects, duplicate/delete identity and leaf edits across undo', async () => {
  await clock(async advance => {
    const env = environment();
    try {
      const room = await created(env); let state = room, number = 0;
      const applyPatch = async patch => {
        const response = await post(env, room, {nonce: `direct-object-${number++}`, expectedRevision: state.revision, patch});
        state = await response.json(); assert.equal(response.status, 200); advance(); return state;
      };
      await applyPatch(moveSceneObject(state.scene, 'boat:0', {x: 0.4, y: 0.7}));
      await applyPatch(duplicateSceneObject(state.scene, 'boat:0'));
      assert.equal(state.scene.boats, 2);
      const duplicated = state.scene;
      await applyPatch({...moveSceneObject(state.scene, 'bird:1', {x: 0.5, y: 0.1}), leafOrigin: {x: 0.2, y: 0.3}, leafTarget: {x: 0.8, y: 0.85}});
      const movedLeaf = state.scene;
      await applyPatch(removeSceneObject(state.scene, 'boat:0'));
      assert.equal(state.scene.boats, 1);
      assert.deepEqual(state.scene.placements.find(item => item.id === 'boat:0'), {id: 'boat:0', x: 0.46, y: 0.76});
      let response = await post(env, room, {nonce: 'undo-object-delete', expectedRevision: state.revision}, undefined, '/undo');
      state = await response.json(); assert.equal(response.status, 200); assert.deepEqual(state.scene, movedLeaf); advance();
      response = await post(env, room, {nonce: 'undo-leaf-edit', expectedRevision: state.revision}, undefined, '/undo');
      state = await response.json(); assert.equal(response.status, 200); assert.deepEqual(state.scene, duplicated);
      assert.deepEqual(state.scene.leafTarget, {x: 0.7, y: 0.94});
    } finally { env.DB.close(); }
  });
});

test('hand-drawn loops persist through room GET, endpoint edits and undo back to a legacy empty trail', async () => {
  await clock(async advance => {
    const env = environment();
    try {
      const room = await created(env), legacy = {...room.scene}; delete legacy.leafTrail;
      env.DB.database.prepare('UPDATE rooms SET scene_json = ? WHERE id = ?').run(JSON.stringify(legacy), room.id);
      const leafTrail = [{x: 0.1, y: 0.1}, {x: 0.7, y: 0.1}, {x: 0.7, y: 0.7}, {x: 0.1, y: 0.7}, {x: 0.1, y: 0.1}];
      let response = await post(env, room, {nonce: 'draw-loop', expectedRevision: 0,
        patch: {leafTrail, leafOrigin: leafTrail[0], leafTarget: leafTrail.at(-1)}});
      let state = await response.json(); assert.equal(response.status, 200); const drawn = state.scene;
      assert.deepEqual(drawn.leafTrail, leafTrail);
      response = await handleRooms(request(route(room), {token: room.token}), env);
      assert.deepEqual((await response.json()).scene, drawn); advance();
      response = await post(env, room, {nonce: 'move-trail-end', expectedRevision: state.revision, patch: {leafTarget: {x: 0.2, y: 0.15}}});
      state = await response.json(); assert.equal(response.status, 200); assert.deepEqual(state.scene.leafTrail, leafTrail);
      const last = leafPath(state.scene).at(-1); assert.deepEqual({x: last.x, y: last.y}, {x: 0.2, y: 0.15}); advance();
      response = await post(env, room, {nonce: 'undo-trail-end', expectedRevision: state.revision}, undefined, '/undo');
      state = await response.json(); assert.equal(response.status, 200); assert.deepEqual(state.scene, drawn); advance();
      response = await post(env, room, {nonce: 'undo-trail-drawing', expectedRevision: state.revision}, undefined, '/undo');
      state = await response.json(); assert.equal(response.status, 200); assert.deepEqual(state.scene, createScene());
      assert.deepEqual(state.scene.leafTrail, []); assert.equal(env.DB.row(room.id).history_json, '[]');
    } finally { env.DB.close(); }
  });
});

test('the unchanged 8KB protocol accepts a maximum placement scene with forty normalized trail points', async () => {
  const env = environment();
  try {
    const placements = [];
    for (const [kind, count] of [['tree', 100], ['boat', 8], ['mountain', 8], ['bird', 20]]) {
      for (let index = 0; index < count; index++) placements.push({id: `${kind}:${index}`, x: 0.123456789, y: 0.987654321});
    }
    const scene = updateScene(createScene(), {trees: 100, boats: 8, mountains: 8, birds: 20, placements,
      leafTrail: Array.from({length: 40}, () => ({x: 0.123456789, y: 0.987654321}))});
    const room = await created(env, {body: {scene}}), patch = {...scene}; delete patch.schemaVersion;
    const body = {nonce: 'n'.repeat(80), expectedRevision: 0, patch};
    assert.ok(new TextEncoder().encode(JSON.stringify(body)).byteLength < ROOM_LIMITS.bodyBytes);
    const response = await post(env, room, body), state = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(state.scene, scene); assert.deepEqual(state.messages.at(-1).changes, []);
  } finally { env.DB.close(); }
});

test('creation rates, active room cap and room expiry are enforced by persisted state', async () => {
  const env = environment();
  try {
    let room;
    for (let index = 0; index < ROOM_LIMITS.creationsPerHour; index++) room = await created(env);
    assert.equal((await handleRooms(request('/api/rooms', {method: 'POST'}), env)).status, 429);
    await created(env, {ip: '192.0.2.2'});
    env.DB.database.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - 1, room.id);
    assert.equal((await handleRooms(request(route(room), {token: room.token}), env)).status, 410);
    const valid = await created(env, {ip: '192.0.2.3'});
    const insert = env.DB.database.prepare('INSERT INTO rooms (id,token_hash,scene_json,expires_at,created_at,creator_ip_hash) VALUES (?,?,?,?,?,?)');
    for (let index = 0; index < 500; index++) insert.run('seed-' + index, '0'.repeat(64), JSON.stringify(createScene()), Date.now() + 60000, Date.now(), 'seed');
    assert.equal((await handleRooms(request('/api/rooms', {method: 'POST', ip: '192.0.2.99'}), env)).status, 429);
  } finally { env.DB.close(); }
});

test('AI reservation is durable: pending replay and busy writes never repeat the provider call', async () => {
  const env = environment(); let release, started;
  const began = new Promise(resolve => { started = resolve; }); let calls = 0;
  const interpret = () => {
    assert.equal(env.DB.database.prepare('SELECT kind FROM operation_receipts WHERE nonce = ?').get('ai-once').kind, 'pending');
    assert.equal(env.DB.calls(), 1);
    calls++; started(); return new Promise(resolve => { release = resolve; });
  };
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

test('an AI completion racing a replay never mixes pending and terminal database snapshots', async () => {
  const env = environment(); let release, started, calls = 0;
  const began = new Promise(resolve => { started = resolve; });
  const interpret = () => { calls++; started(); return new Promise(resolve => { release = resolve; }); };
  try {
    const room = await created(env), body = {nonce: 'completion-race', expectedRevision: 0, text: '把树改成2棵'};
    const pending = post(env, room, body, {interpret}); await began;
    const prepare = env.DB.prepare.bind(env.DB); let intercepted = false;
    env.DB.prepare = sql => {
      const statement = prepare(sql);
      return {bind: (...parameters) => {
        const bound = statement.bind(...parameters);
        return {...bound, first: async () => {
          const row = await bound.first();
          if (!intercepted && sql.includes('operation_receipts') && row) {
            intercepted = true;
            release({supported: true, patch: {trees: 2}, reply: 'fixture completed during replay read'});
            assert.equal((await pending).status, 200);
          }
          return row;
        }};
      }};
    };
    const response = await post(env, room, body, {interpret}), replayed = await response.json();
    assert.equal(intercepted, true);
    const message = replayed.messages.find(message => message.nonce === body.nonce);
    assert.equal(replayed.receipt.kind, message.kind);
    assert.equal(response.status, message.kind === 'pending' ? 202 : 200);
    assert.equal(replayed.scene.trees, message.kind === 'pending' ? 40 : 2);
    const current = await (await handleRooms(request(route(room), {token: room.token}), env)).json();
    assert.equal(current.scene.trees, 2); assert.equal(calls, 1); assert.equal(env.DB.calls(), 1);
  } finally { env.DB.close(); }
});

test('the daily AI budget rejects before a provider call; direct scene editing stays available', async () => {
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
      env.DB.database.prepare('UPDATE ai_usage SET calls = 0').run();
      const allowed = await post(env, room, {nonce: 'over-old-room-limit', expectedRevision: 3, text: '下雨'}, {interpret});
      assert.equal(allowed.status, 200); assert.equal((await allowed.json()).scene.rain, 1); assert.equal(calls, 1);
      assert.equal(env.DB.row(room.id).ai_calls, 21);
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
    assert.equal(env.DB.database.prepare('SELECT COUNT(*) AS count FROM operation_receipts WHERE room_id = ?').get(room.id).count, 1);
    const loser = winner.receipt.nonce === 'concurrent-a' ? 'concurrent-b' : 'concurrent-a';
    assert.equal(env.DB.receipt(room.id, loser), undefined);
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

test('a room accepts over 100 operations while old patch and undo receipts survive its rolling log', async () => {
  await clock(async advance => {
    const env = environment();
    try {
      const room = await created(env, {body: {scene: updateScene(createScene(), {boats: 8})}});
      const oldPatch = {nonce: 'place-last-boat', expectedRevision: 0, patch: {placements: [{id: 'boat:7', x: 0.4, y: 0.6}]}};
      let response = await post(env, room, oldPatch), state = await response.json();
      assert.equal(response.status, 200); assert.equal(state.receipt.revision, 1); assert.equal(state.receipt.replayed, false); advance();
      const oldUndo = {nonce: 'undo-old-placement', expectedRevision: 1};
      response = await post(env, room, oldUndo, undefined, '/undo'); state = await response.json();
      assert.equal(response.status, 200); assert.equal(state.receipt.revision, 2); advance();
      for (let index = 0; index < 120; index++) {
        response = await post(env, room, {nonce: 'rolling-' + index, expectedRevision: state.revision,
          patch: {boats: 0, wind: (index % 10) / 10}});
        state = await response.json(); assert.equal(response.status, 200); advance();
      }
      assert.equal(state.messages.length, 64); assert.equal(state.revision, 122);
      assert.equal(JSON.parse(env.DB.row(room.id).history_json).length, 15);
      assert.equal(state.messages.some(message => message.nonce === oldPatch.nonce), false);
      const before = env.DB.row(room.id);
      response = await post(env, room, oldPatch); const replayed = await response.json();
      assert.equal(response.status, 200); assert.equal(replayed.revision, 122); assert.deepEqual(replayed.scene, state.scene);
      assert.equal(replayed.receipt.nonce, oldPatch.nonce); assert.equal(replayed.receipt.revision, 1);
      assert.equal(replayed.receipt.kind, 'patch'); assert.equal(replayed.receipt.replayed, true);
      assert.equal(replayed.receipt._requestHash, undefined); assert.equal(replayed.receipt.mode, 'commands');
      response = await post(env, room, oldUndo, undefined, '/undo');
      assert.equal(response.status, 200); assert.equal((await response.json()).receipt.revision, 2);
      response = await post(env, room, {...oldPatch, patch: {boats: 2}});
      assert.equal(response.status, 409); assert.equal((await response.json()).code, 'NONCE_REUSED');
      assert.deepEqual(env.DB.row(room.id), before);
      assert.equal(env.DB.database.prepare('SELECT COUNT(*) AS count FROM operation_receipts WHERE room_id = ?').get(room.id).count, 122);
    } finally { env.DB.close(); }
  });
});

test('more than 20 AI calls work in one room and rolled-out AI successes and failures never run again', async () => {
  await clock(async advance => {
    const env = environment(); let calls = 0;
    const interpret = async () => { calls++; return {supported: true, patch: {rain: 0.4}, reply: '真实测试解释结果'}; };
    try {
      const room = await created(env), oldAi = {nonce: 'first-ai', expectedRevision: 0, text: '下雨'};
      let state = room;
      for (let index = 0; index < 25; index++) {
        const response = await post(env, room, index === 0 ? oldAi : {nonce: 'ai-' + index, expectedRevision: state.revision, text: '下雨'}, {interpret});
        state = await response.json(); assert.equal(response.status, 200); advance();
      }
      assert.equal(calls, 25); assert.equal(env.DB.calls(), 25); assert.equal(env.DB.row(room.id).ai_calls, 25);
      const oldFailure = {nonce: 'failed-before-roll', expectedRevision: state.revision, text: '无法完成的解释'};
      let response = await post(env, room, oldFailure, {interpret: async () => { calls++; throw Error('fixture failure'); }});
      const failure = await response.json(); assert.equal(response.status, 503); state = failure.current; advance();
      for (let index = 0; index < 70; index++) {
        response = await post(env, room, {nonce: 'after-ai-' + index, expectedRevision: state.revision, patch: {wind: index % 2}});
        state = await response.json(); assert.equal(response.status, 200); advance();
      }
      assert.equal(state.messages.some(message => [oldAi.nonce, oldFailure.nonce].includes(message.nonce)), false);
      const before = env.DB.row(room.id);
      for (const [body, kind, revision] of [[oldAi, 'instruction', 2], [oldFailure, 'failed', 52]]) {
        response = await post(env, room, body, {interpret}); const replayed = await response.json();
        assert.equal(response.status, 200); assert.equal(replayed.receipt.kind, kind); assert.equal(replayed.receipt.revision, revision);
        assert.equal(replayed.receipt.replayed, true); assert.deepEqual(replayed.scene, state.scene);
      }
      assert.equal(calls, 26); assert.equal(env.DB.calls(), 26); assert.deepEqual(env.DB.row(room.id), before);
    } finally { env.DB.close(); }
  });
});

test('a terminal timeout receipt survives log rollover and rejects a late provider result', async () => {
  await clock(async (advance, elapse) => {
    const env = environment(); let release, started, calls = 0;
    const began = new Promise(resolve => { started = resolve; });
    const interpret = () => { calls++; started(); return new Promise(resolve => { release = resolve; }); };
    try {
      const room = await created(env), body = {nonce: 'timeout-before-roll', expectedRevision: 0, text: '把树改成2棵'};
      const pending = post(env, room, body, {interpret}); await began;
      assert.equal(env.DB.receipt(room.id, body.nonce).kind, 'pending');
      elapse(ROOM_LIMITS.busyMs + 1);
      let state = await (await handleRooms(request(route(room), {token: room.token}), env)).json();
      assert.equal(state.revision, 2); assert.equal(env.DB.receipt(room.id, body.nonce).kind, 'failed');
      for (let index = 0; index < 70; index++) {
        const response = await post(env, room, {nonce: 'after-timeout-' + index, expectedRevision: state.revision, patch: {wind: index % 2}});
        state = await response.json(); assert.equal(response.status, 200); advance();
      }
      const before = env.DB.row(room.id), finalReceipt = env.DB.receipt(room.id, body.nonce);
      release({supported: true, patch: {trees: 2}, reply: '这个解释已经超时'});
      const response = await pending, late = await response.json();
      assert.equal(response.status, 200); assert.equal(late.receipt.kind, 'failed'); assert.equal(late.receipt.revision, 2);
      assert.equal(late.scene.trees, 40); assert.equal(late.revision, state.revision);
      const replayed = await post(env, room, body, {interpret}); assert.equal(replayed.status, 200);
      assert.equal((await replayed.json()).receipt.kind, 'failed'); assert.equal(calls, 1); assert.equal(env.DB.calls(), 1);
      assert.deepEqual(env.DB.row(room.id), before); assert.deepEqual(env.DB.receipt(room.id, body.nonce), finalReceipt);
    } finally { env.DB.close(); }
  });
});

test('receipt persistence failures roll back room CAS before a model call or budget charge', async () => {
  const env = environment(); let calls = 0;
  try {
    const room = await created(env), before = env.DB.row(room.id);
    env.DB.database.exec("CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON operation_receipts BEGIN SELECT RAISE(ABORT, 'fixture receipt failed'); END");
    for (const value of [{nonce: 'blocked-patch', expectedRevision: 0, patch: {rain: 1}}, {nonce: 'blocked-ai', expectedRevision: 0, text: '下雨'}]) {
      const response = await post(env, room, value, {interpret: async () => { calls++; return {supported: true, patch: {rain: 1}, reply: 'fixture'}; }});
      assert.equal(response.status, 500); assert.deepEqual(env.DB.row(room.id), before);
      assert.equal(env.DB.receipt(room.id, value.nonce), undefined);
    }
    assert.equal(calls, 0); assert.equal(env.DB.calls(), 0);
    env.DB.database.exec('DROP TRIGGER fixture_receipt_failure');
    const response = await post(env, room, {nonce: 'allowed-patch', expectedRevision: 0, patch: {rain: 1}});
    assert.equal(response.status, 200); const final = env.DB.row(room.id), messages = JSON.parse(final.messages_json);
    messages[0].reply = 'altered terminal reply';
    assert.throws(() => env.DB.database.prepare('UPDATE rooms SET revision = revision + 1, messages_json = ?, scene_json = ? WHERE id = ?')
      .run(JSON.stringify(messages), JSON.stringify(createScene()), room.id), /immutable/);
    assert.deepEqual(env.DB.row(room.id), final);
    assert.throws(() => env.DB.database.prepare('UPDATE operation_receipts SET request_hash = ? WHERE room_id = ?').run('different', room.id), /immutable/);
  } finally { env.DB.close(); }
});

test('a rolled-out global-budget rejection remains terminal even after budget becomes available', async () => {
  await clock(async advance => {
    const env = environment(); let calls = 0;
    const interpret = async () => { calls++; return {supported: true, patch: {rain: 1}, reply: 'fixture'}; };
    try {
      const room = await created(env), body = {nonce: 'budget-before-roll', expectedRevision: 0, text: '下雨'};
      env.DB.database.prepare('INSERT INTO ai_usage(day,calls) VALUES (?,?)').run(new Date().toISOString().slice(0, 10), 200);
      let response = await post(env, room, body, {interpret}), result = await response.json();
      assert.equal(response.status, 429); assert.equal(result.current.receipt.kind, 'failed');
      let state = result.current; advance();
      for (let index = 0; index < 70; index++) {
        response = await post(env, room, {nonce: 'after-budget-' + index, expectedRevision: state.revision, patch: {wind: index % 2}});
        state = await response.json(); assert.equal(response.status, 200); advance();
      }
      env.DB.database.prepare('UPDATE ai_usage SET calls = 0').run();
      const before = env.DB.row(room.id);
      response = await post(env, room, body, {interpret}); result = await response.json();
      assert.equal(response.status, 200); assert.equal(result.receipt.kind, 'failed'); assert.equal(result.receipt.revision, 2);
      assert.equal(result.receipt.replayed, true); assert.equal(calls, 0); assert.equal(env.DB.calls(), 0);
      assert.equal(env.DB.row(room.id).ai_calls, 0); assert.deepEqual(env.DB.row(room.id), before);
    } finally { env.DB.close(); }
  });
});

test('the append-only migration preserves historical nonces and fails closed for missing legacy fingerprints', async () => {
  const env = {DB: new SqliteD1({migrate: false}), ROOM_IP_SALT: 'fixture-only-salt-of-sufficient-length'};
  try {
    const room = await created(env), body = {nonce: 'before-migration', expectedRevision: 0, patch: {rain: 0.5}};
    const message = {id: 'old-id', nonce: body.nonce, text: '旧修改', reply: '已修改', changes: [], at: new Date().toISOString(), kind: 'patch',
      _mode: 'commands', _requestHash: createHash('sha256').update('{"patch":{"rain":0.5}}').digest('hex')};
    env.DB.database.prepare('UPDATE rooms SET messages_json = ?, revision = 12 WHERE id = ?')
      .run(JSON.stringify([message, {...message, nonce: 'missing-hash', _requestHash: undefined}]), room.id);
    env.DB.database.exec(readFileSync(new URL('../drizzle/0001_open_marvel_apes.sql', import.meta.url), 'utf8'));
    assert.equal(env.DB.receipt(room.id, body.nonce).revision, null);
    let response = await post(env, room, body), state = await response.json();
    assert.equal(response.status, 200); assert.equal(state.revision, 12); assert.equal(state.receipt.revision, null);
    response = await post(env, room, {...body, nonce: 'missing-hash'});
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'NONCE_REUSED');
    response = await post(env, room, {nonce: 'after-migration', expectedRevision: 12, patch: {wind: 1}});
    assert.equal(response.status, 200); assert.equal(env.DB.receipt(room.id, body.nonce).revision, null);
  } finally { env.DB.close(); }
});

test('expired-room cleanup deletes receipts with foreign keys enabled or disabled', async () => {
  for (const foreignKeys of ['ON', 'OFF']) {
    const env = environment();
    try {
      const room = await created(env);
      assert.equal((await post(env, room, {nonce: 'expired-operation', expectedRevision: 0, patch: {rain: 1}})).status, 200);
      assert.ok(env.DB.receipt(room.id, 'expired-operation'));
      env.DB.database.exec('PRAGMA foreign_keys = ' + foreignKeys);
      env.DB.database.prepare('UPDATE rooms SET expires_at = ? WHERE id = ?').run(Date.now() - ROOM_LIMITS.ttlMs - 1, room.id);
      await created(env);
      assert.equal(env.DB.row(room.id), undefined); assert.equal(env.DB.receipt(room.id, 'expired-operation'), undefined);
    } finally { env.DB.close(); }
  }
});

test('canUndo reflects retained snapshots after more than 64 unchanged operations roll the edit out of messages', async () => {
  await clock(async advance => {
    const env = environment();
    try {
      const room = await created(env);
      assert.equal(room.canUndo, false);
      let response = await post(env, room, {nonce: 'only-scene-change', expectedRevision: 0, patch: {trees: 2}});
      let state = await response.json(); assert.equal(response.status, 200); assert.equal(state.canUndo, true); advance();
      for (let index = 0; index < 70; index++) {
        response = await post(env, room, {nonce: 'unchanged-' + index, expectedRevision: state.revision, patch: {trees: 2}});
        state = await response.json(); assert.equal(response.status, 200); advance();
      }
      assert.equal(state.messages.length, 64); assert.ok(state.messages.every(message => message.changes.length === 0));
      assert.equal(state.canUndo, true); assert.equal(JSON.parse(env.DB.row(room.id).history_json).length, 1);
      const polled = await (await handleRooms(request(route(room), {token: room.token}), env)).json();
      assert.equal(polled.canUndo, true);
      response = await post(env, room, {nonce: 'undo-after-noops', expectedRevision: state.revision}, undefined, '/undo');
      state = await response.json(); assert.equal(response.status, 200); assert.equal(state.scene.trees, 40);
      assert.equal(state.receipt.kind, 'undo'); assert.equal(state.canUndo, false);
      assert.equal(env.DB.row(room.id).history_json, '[]');
    } finally { env.DB.close(); }
  });
});
