import {createScene, validateScene, updateScene, sceneChanges, interpretInstruction} from '../web/scene-model.mjs';

export const ROOM_LIMITS = Object.freeze({bodyBytes: 8192, text: 400, messages: 64, history: 15,
  ttlMs: 6 * 60 * 60 * 1000, activeRooms: 500, creationsPerHour: 10, intervalMs: 1000,
  dailyAiCalls: 200, aiTimeoutMs: 25000, busyMs: 30000});
const GET_ROOM = 'SELECT * FROM rooms WHERE id = ?';
// Read the room and its receipt in one SQLite snapshot, including during an AI
// finalization race. A pending receipt must never accompany a terminal room row.
const GET_OPERATION = 'SELECT rooms.*, receipt.request_hash AS receipt_request_hash, receipt.message_json AS receipt_message_json, receipt.kind AS receipt_kind, receipt.revision AS receipt_revision FROM rooms JOIN operation_receipts AS receipt ON receipt.room_id = rooms.id WHERE rooms.id = ? AND receipt.nonce = ?';
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
class RoomError extends Error {
  constructor(status, code, message, current) { super(message); this.status = status; this.code = code; this.current = current; }
}
const fail = (status, code, message, current) => { throw new RoomError(status, code, message, current); };
const requireValue = (condition, message, code = 'INVALID_REQUEST') => {
  if (!condition) fail(400, code, message);
};
function own(value, fields) {
  requireValue(plain(value) && Object.keys(value).every(key => fields.includes(key)), '请求包含不支持的字段。');
}
function json(value, status = 200) {
  return Response.json(value, {status, headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}});
}
function randomHex(length) {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), item => item.toString(16).padStart(2, '0')).join('');
}
async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    item => item.toString(16).padStart(2, '0')).join('');
}
function equalHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function readBody(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
  }
  if (Number(request.headers.get('content-length')) > ROOM_LIMITS.bodyBytes) fail(413, 'BODY_TOO_LARGE', '请求内容过大。');
  const chunks = [], reader = request.body?.getReader();
  let size = 0;
  if (reader) {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > ROOM_LIMITS.bodyBytes) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', '请求内容过大。'); }
      chunks.push(part.value);
    }
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer)); }
  catch { fail(400, 'INVALID_JSON', '请求不是有效 JSON。'); }
}
function sceneInput(value, patch = false, scene) {
  try { return patch ? updateScene(scene, value) : validateScene(value); }
  catch (error) { fail(400, 'INVALID_SCENE', error.message); }
}
function contents(row) {
  try {
    const scene = validateScene(JSON.parse(row.scene_json)), messages = JSON.parse(row.messages_json), history = JSON.parse(row.history_json);
    if (!Array.isArray(messages) || messages.length > ROOM_LIMITS.messages || !Array.isArray(history) || history.length > ROOM_LIMITS.history) throw Error();
    return {scene, messages, history: history.map(validateScene)};
  } catch { fail(500, 'ROOM_STATE_INVALID', '房间记录暂时无法读取。'); }
}
function publicState(row, mode) {
  const {scene, messages, history} = contents(row);
  return {id: row.id, revision: row.revision, scene, canUndo: history.length > 0,
    messages: messages.map(({id, nonce, text, reply, changes, at, kind}) => ({id, nonce, text, reply, changes, at, kind})),
    expiresAt: row.expires_at, mode: messages.at(-1)?._mode ?? mode};
}
async function first(db, sql, ...parameters) { return db.prepare(sql).bind(...parameters).first(); }
async function authenticated(db, id, request) {
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (!token) fail(401, 'ROOM_TOKEN_REQUIRED', '需要房间编辑链接中的访问凭证。');
  const row = await first(db, GET_ROOM, id);
  if (!row) fail(404, 'ROOM_NOT_FOUND', '找不到这个房间。');
  if (!equalHash(await hash(token), row.token_hash)) fail(403, 'ROOM_TOKEN_INVALID', '房间访问凭证无效。');
  if (row.expires_at <= Date.now()) fail(410, 'ROOM_EXPIRED', '这个房间已到期，请创建新房间。');
  return row;
}
function commandInput(value, undo) {
  own(value, undo ? ['nonce', 'expectedRevision'] : ['nonce', 'expectedRevision', 'text', 'patch']);
  requireValue(typeof value.nonce === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.nonce), '请求需要有效且唯一的 nonce。');
  requireValue(Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0, '请求需要当前版本号。');
  if (!undo) {
    requireValue(Object.hasOwn(value, 'text') !== Object.hasOwn(value, 'patch'), '请只提供一条调景消息或一份直接修改。');
    if (Object.hasOwn(value, 'text')) requireValue(typeof value.text === 'string' && value.text.trim().length > 0 &&
      value.text.length <= ROOM_LIMITS.text, '调景消息应为 1 至 400 字。');
    else requireValue(plain(value.patch) && Object.keys(value.patch).length > 0, '请提供明确的场景修改。');
  }
}
function publicReceipt(row, replayed) {
  const {id, nonce, text, reply, changes, at, kind, _mode} = JSON.parse(row.receipt_message_json);
  return {id, nonce, text, reply, changes, at, kind, revision: row.receipt_revision, mode: _mode, replayed};
}
async function operationState(db, row, nonce, mode, replayed = false) {
  const current = await first(db, GET_OPERATION, row.id, nonce);
  if (!current) fail(500, 'ROOM_STATE_INVALID', '操作回执暂时无法读取。');
  return {...publicState(current, mode), receipt: publicReceipt(current, replayed)};
}
async function replay(db, row, nonce, requestHash, mode) {
  let current = await first(db, GET_OPERATION, row.id, nonce);
  if (!current) return null;
  if (current.expires_at <= Date.now()) fail(410, 'ROOM_EXPIRED', '这个房间已到期，请创建新房间。');
  if (current.receipt_request_hash !== requestHash) fail(409, 'NONCE_REUSED', '这个请求编号已用于另一项操作，请使用新编号。', publicState(current, mode));
  if (current.receipt_kind === 'pending' && current.busy_nonce === nonce && current.busy_until <= Date.now()) {
    await expireBusy(db, current);
    current = await first(db, GET_OPERATION, row.id, nonce);
    if (!current) fail(410, 'ROOM_EXPIRED', '这个房间已到期，请创建新房间。');
  }
  return json({...publicState(current, mode), receipt: publicReceipt(current, true)}, current.receipt_kind === 'pending' ? 202 : 200);
}
function writable(row, value, mode) {
  const current = publicState(row, mode);
  if (row.revision !== value.expectedRevision) fail(409, 'REVISION_CONFLICT', '房间已有更新，请先查看最新场景。', current);
  if (row.busy_nonce) fail(409, 'ROOM_BUSY', '房间正在处理一条消息，请稍后查看结果。', current);
  if (row.next_message_at > Date.now()) fail(429, 'ROOM_RATE_LIMIT', '操作有些频繁，请稍等一秒。', current);
}
async function expireBusy(db, row) {
  if (!row.busy_nonce || row.busy_until > Date.now()) return row;
  const state = contents(row), messages = state.messages.map(message => message.nonce === row.busy_nonce && message.kind === 'pending' ?
    {...message, kind: 'failed', reply: '这条请求未能及时完成，没有应用场景修改。可使用新请求重新尝试。', changes: []} : message);
  return await first(db, 'UPDATE rooms SET revision = revision + 1, messages_json = ?, busy_nonce = NULL, busy_until = 0 WHERE id = ? AND revision = ? AND busy_nonce = ? AND busy_until <= ? RETURNING *',
    JSON.stringify(messages), row.id, row.revision, row.busy_nonce, Date.now()) ?? await first(db, GET_ROOM, row.id);
}
async function createRoom(request, env, mode) {
  if (typeof env.ROOM_IP_SALT !== 'string' || env.ROOM_IP_SALT.length < 16) fail(503, 'ROOMS_NOT_CONFIGURED', '房间服务尚未配置完成。');
  const body = await readBody(request); own(body, ['scene']);
  const scene = body.scene === undefined ? createScene() : sceneInput(body.scene), now = Date.now(), hour = Math.floor(now / 3600000) * 3600000;
  const ipHash = await hash(env.ROOM_IP_SALT + '|' + hour + '|' + (request.headers.get('cf-connecting-ip') ?? 'unknown'));
  // Keep a short expired-room grace period for 410 responses; cleanup remains bounded.
  await env.DB.prepare('DELETE FROM rooms WHERE id IN (SELECT id FROM rooms WHERE expires_at < ? LIMIT 25)').bind(now - ROOM_LIMITS.ttlMs).run();
  const id = randomHex(16), token = randomHex(32), tokenHash = await hash(token);
  const row = await first(env.DB, 'INSERT INTO rooms (id, token_hash, revision, scene_json, messages_json, history_json, expires_at, next_message_at, created_at, creator_ip_hash, ai_calls, busy_nonce, busy_until) SELECT ?, ?, 0, ?, ?, ?, ?, 0, ?, ?, 0, NULL, 0 WHERE (SELECT COUNT(*) FROM rooms WHERE expires_at > ?) < ? AND (SELECT COUNT(*) FROM rooms WHERE creator_ip_hash = ? AND created_at >= ?) < ? RETURNING *',
    id, tokenHash, JSON.stringify(scene), '[]', '[]', now + ROOM_LIMITS.ttlMs, now, ipHash,
    now, ROOM_LIMITS.activeRooms, ipHash, hour, ROOM_LIMITS.creationsPerHour);
  if (!row) fail(429, 'ROOM_CREATION_LIMIT', '暂时无法再创建房间，请稍后尝试。');
  return json({...publicState(row, mode), token}, 201);
}
function interpreted(result, scene, mode) {
  if (!plain(result) || typeof result.supported !== 'boolean' || typeof result.reply !== 'string' || result.reply.length > 1600 ||
    !plain(result.patch)) fail(502, 'INVALID_INTERPRETATION', '这条解释未通过场景校验，没有应用修改。');
  let next;
  try { next = updateScene(scene, result.patch); } catch { fail(502, 'INVALID_INTERPRETATION', '这条解释包含不支持的修改，没有应用。'); }
  if (!result.supported && sceneChanges(scene, next).length) fail(502, 'INVALID_INTERPRETATION', '这条解释未能明确确认修改，没有应用。');
  return {scene: result.supported ? next : scene, reply: result.reply,
    kind: result.supported ? 'instruction' : 'unsupported', mode: ['ai', 'commands'].includes(result.mode) ? result.mode : mode};
}
function newMessage(value, requestHash, mode, kind, reply, changes) {
  return {id: randomHex(16), nonce: value.nonce, text: value.text ?? (kind === 'undo' ? '撤销最近一次场景修改' : '直接调景：' + canonical(value.patch)),
    reply, changes, at: new Date().toISOString(), kind, _requestHash: requestHash, _mode: mode};
}
async function commitChange(db, row, value, requestHash, mode, next, reply, kind) {
  const state = contents(row), changes = sceneChanges(state.scene, next);
  const history = changes.length && kind !== 'undo' ? [...state.history, state.scene].slice(-ROOM_LIMITS.history) :
    kind === 'undo' && state.history.length ? state.history.slice(0, -1) : state.history;
  const messages = [...state.messages, newMessage(value, requestHash, mode, kind, reply, changes)].slice(-ROOM_LIMITS.messages), now = Date.now();
  const updated = await first(db, 'UPDATE rooms SET revision = revision + 1, scene_json = ?, messages_json = ?, history_json = ?, next_message_at = ? WHERE id = ? AND revision = ? AND expires_at > ? AND next_message_at <= ? AND busy_nonce IS NULL RETURNING *',
    JSON.stringify(next), JSON.stringify(messages), JSON.stringify(history), now + ROOM_LIMITS.intervalMs,
    row.id, row.revision, now, now);
  if (!updated) fail(409, 'REVISION_CONFLICT', '房间已有更新，本次操作未覆盖它。', publicState(await first(db, GET_ROOM, row.id), mode));
  return json(await operationState(db, updated, value.nonce, mode));
}
async function finishAi(db, row, nonce, next, reply, kind, mode, refund = false) {
  const state = contents(row), changes = sceneChanges(state.scene, next);
  const messages = state.messages.map(message => message.nonce === nonce ? {...message, reply, kind, changes, _mode: mode} : message);
  const history = changes.length ? [...state.history, state.scene].slice(-ROOM_LIMITS.history) : state.history;
  return first(db, 'UPDATE rooms SET revision = revision + 1, scene_json = ?, messages_json = ?, history_json = ?, busy_nonce = NULL, busy_until = 0, ai_calls = ai_calls - ? WHERE id = ? AND revision = ? AND busy_nonce = ? AND expires_at > ? RETURNING *',
    JSON.stringify(next), JSON.stringify(messages), JSON.stringify(history), refund ? 1 : 0, row.id, row.revision, nonce, Date.now());
}
async function timedInterpret(interpret, text, scene) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(() => interpret(text, scene)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), ROOM_LIMITS.aiTimeoutMs); })]); }
  finally { clearTimeout(timer); }
}
async function aiCommand(db, row, value, requestHash, mode, interpret) {
  const state = contents(row), now = Date.now();
  const pending = newMessage(value, requestHash, mode, 'pending', '请求已提交，正在等待实际解释结果；场景尚未改变。', []);
  const reserved = await first(db, 'UPDATE rooms SET revision = revision + 1, messages_json = ?, ai_calls = ai_calls + 1, busy_nonce = ?, busy_until = ?, next_message_at = ? WHERE id = ? AND revision = ? AND expires_at > ? AND next_message_at <= ? AND busy_nonce IS NULL RETURNING *',
    JSON.stringify([...state.messages, pending].slice(-ROOM_LIMITS.messages)), value.nonce, now + ROOM_LIMITS.busyMs, now + ROOM_LIMITS.intervalMs,
    row.id, row.revision, now, now);
  if (!reserved) fail(409, 'REVISION_CONFLICT', '房间已有更新，请先查看最新状态。', publicState(await first(db, GET_ROOM, row.id), mode));
  let budget;
  try { budget = await first(db, 'INSERT INTO ai_usage (day, calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET calls = ai_usage.calls + 1 WHERE ai_usage.calls < ? RETURNING calls',
    new Date().toISOString().slice(0, 10), ROOM_LIMITS.dailyAiCalls); }
  catch {
    const failed = await finishAi(db, reserved, value.nonce, state.scene, '服务预算暂时无法核对，没有调用模型或修改场景。', 'failed', mode, true);
    fail(503, 'AI_BUDGET_UNAVAILABLE', '服务预算暂时不可用。', await operationState(db, failed ?? reserved, value.nonce, mode));
  }
  if (!budget) {
    const failed = await finishAi(db, reserved, value.nonce, state.scene, '今天的模型调用额度已用完，没有调用模型。直接调景仍可使用。', 'failed', mode, true);
    fail(429, 'DAILY_AI_LIMIT', '今天已达到 200 次模型请求。', await operationState(db, failed ?? reserved, value.nonce, mode));
  }
  let result;
  try { result = interpreted(await timedInterpret(interpret, value.text, state.scene), state.scene, mode); }
  catch {
    const latest = await first(db, GET_ROOM, row.id);
    const failed = latest?.busy_nonce === value.nonce ? await finishAi(db, latest, value.nonce, contents(latest).scene,
      '解释请求未能完成，没有修改场景。同一请求不会再次调用模型；可使用新请求再试。', 'failed', mode) : latest;
    fail(503, 'INTERPRETATION_UNAVAILABLE', '这次解释未完成，场景未被修改。', failed ? await operationState(db, failed, value.nonce, mode) : undefined);
  }
  // Re-read after the external wait: a nonce result or a newer revision takes precedence.
  const latest = await first(db, GET_OPERATION, row.id, value.nonce);
  if (!latest || latest.expires_at <= Date.now()) fail(410, 'ROOM_EXPIRED', '这个房间已到期，解释结果未应用。');
  if (latest.receipt_kind !== 'pending') return json(await operationState(db, latest, value.nonce, mode, true));
  if (latest.busy_nonce !== value.nonce || latest.revision !== reserved.revision || latest.busy_until <= Date.now()) {
    const expired = await expireBusy(db, latest);
    fail(409, 'AI_RESULT_STALE', '等待期间房间已更新或请求已超时，解释结果未应用。', publicState(expired, mode));
  }
  const updated = await finishAi(db, latest, value.nonce, result.scene, result.reply, result.kind, result.mode);
  if (!updated) fail(409, 'REVISION_CONFLICT', '房间已有更新，解释结果未覆盖它。', publicState(await first(db, GET_ROOM, row.id), mode));
  return json(await operationState(db, updated, value.nonce, result.mode));
}
/** Same-origin guest capability API. It neither provisions tables nor reads personal credentials. */
export async function handleRooms(request, env, {interpret, mode = interpret ? 'ai' : 'commands'} = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/rooms' && !url.pathname.startsWith('/api/rooms/')) return null;
  try {
    if (!env?.DB?.prepare) fail(503, 'ROOMS_NOT_CONFIGURED', '房间数据库尚未配置。');
    const match = url.pathname.match(/^\/api\/rooms(?:\/([0-9a-f]{32})(?:\/(undo))?)?\/?$/);
    if (!match) fail(404, 'ROOM_ROUTE_NOT_FOUND', '找不到这个房间接口。');
    if (!['GET', 'POST'].includes(request.method)) fail(405, 'METHOD_NOT_ALLOWED', '这个接口不支持该请求方法。');
    if (request.method === 'POST' && request.headers.get('origin') !== url.origin) fail(403, 'ORIGIN_REJECTED', '请从本站打开房间后再操作。');
    const [, id, undo] = match;
    if (!id) {
      if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '请使用创建房间接口。');
      return await createRoom(request, env, mode);
    }
    let row = await authenticated(env.DB, id, request);
    if (request.method === 'GET') {
      if (undo) fail(405, 'METHOD_NOT_ALLOWED', '撤销需要明确提交操作。');
      row = await expireBusy(env.DB, row);
      return json(publicState(row, mode));
    }
    const value = await readBody(request); commandInput(value, !!undo);
    const requestHash = await hash(canonical(undo ? {kind: 'undo'} : Object.hasOwn(value, 'text') ? {text: value.text} : {patch: value.patch}));
    const previous = await replay(env.DB, row, value.nonce, requestHash, mode); if (previous) return previous;
    row = await expireBusy(env.DB, row);
    writable(row, value, mode);
    const state = contents(row);
    if (undo) {
      const next = state.history.at(-1) ?? state.scene;
      return await commitChange(env.DB, row, value, requestHash, mode, next,
        state.history.length ? '已撤销最近一次场景修改。' : '还没有可撤销的场景修改，场景保持原样。', 'undo');
    }
    if (Object.hasOwn(value, 'patch')) {
      const next = sceneInput(value.patch, true, state.scene);
      return await commitChange(env.DB, row, value, requestHash, mode, next, '已按你提交的明确数值修改场景。', 'patch');
    }
    if (interpret) return await aiCommand(env.DB, row, value, requestHash, mode, interpret);
    const result = interpreted(interpretInstruction(value.text, state.scene), state.scene, 'commands');
    return await commitChange(env.DB, row, value, requestHash, result.mode, result.scene, result.reply, result.kind);
  } catch (error) {
    if (error instanceof RoomError) return json({error: error.message, code: error.code, ...(error.current ? {current: error.current} : {})}, error.status);
    return json({error: '房间服务暂时不可用，请稍后重试。', code: 'ROOM_SERVICE_ERROR'}, 500);
  }
}
