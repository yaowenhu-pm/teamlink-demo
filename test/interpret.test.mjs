import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterpreter, InterpreterError } from '../worker/interpret.mjs';
import { createScene, updateScene, sceneChanges } from '../web/scene-model.mjs';

const ENV = Object.freeze({ CLAW_API_KEY: 'test-key-only' });
const modelResult = (patch = { hour: 22 }, extra = {}) => ({ supported: true, patch, reply: '拟将天空调成夜晚。', ...extra });
const completion = (result, extra = {}) => ({ id: 'mock-completion', object: 'chat.completion', model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(result) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 }, ...extra });
const gateway = (result) => async () => Response.json(completion(result));
const code = (expected) => (error) => error instanceof InterpreterError && error.code === expected &&
  !error.message.includes('test-key-only') && !error.message.includes('gateway-private-detail');

test('provider request is fixed, authenticated once and includes only current scene plus instruction', async () => {
  const current = createScene();
  let request, calls = 0;
  const interpret = createInterpreter(ENV, { fetcher: async (url, options) => {
    calls++; request = { url, ...options };
    return Response.json(completion(modelResult({ hour: 22, trees: 55, boat: false }, { reply: '我还发送了邮件。' })));
  } });
  const result = await interpret('改成夜晚，树多一点，隐藏帆船', current);
  assert.equal(calls, 1);
  assert.equal(request.url, 'https://api.clawhunt.site/v1/chat/completions');
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'manual');
  assert.equal(request.headers.Authorization, 'Bearer test-key-only');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.ok(request.signal instanceof AbortSignal);
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'doubao-seed-2.1-lite'); assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.3); assert.equal(body.max_tokens, 700);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.messages.length, 2); assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /supported=false/);
  assert.match(body.messages[0].content, /没有历史/);
  assert.deepEqual(JSON.parse(body.messages[1].content), { currentScene: current, instruction: '改成夜晚，树多一点，隐藏帆船' });
  assert.equal(request.body.includes('test-key-only'), false);
  assert.deepEqual(result.patch, { hour: 22, trees: 55, boats: 0 });
  assert.deepEqual(result.changes, sceneChanges(current, updateScene(current, result.patch)));
  assert.equal(result.mode, 'ai'); assert.equal(result.supported, true);
  assert.match(result.reply, /时间→22/); assert.doesNotMatch(result.reply, /邮件/);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.patch) && Object.isFrozen(result.changes));
  assert.equal(current.hour, 18.3);
});

test('configured model and the sole allowed trailing-slash base remain on the fixed endpoint', async () => {
  let urlUsed, body;
  const interpret = createInterpreter({ ...ENV, CLAW_BASE_URL: 'https://api.clawhunt.site/v1/', CLAW_MODEL: 'doubao-seed-2.1-lite' },
    { fetcher: async (url, options) => { urlUsed = url; body = JSON.parse(options.body); return Response.json(completion(modelResult())); } });
  await interpret('夜晚', createScene());
  assert.equal(urlUsed, 'https://api.clawhunt.site/v1/chat/completions');
  assert.equal(body.model, 'doubao-seed-2.1-lite');
});

test('non-renderable unsupported responses contain no patch and preserve their explanation', async () => {
  const result = await createInterpreter(ENV, { fetcher: gateway({ supported: false, patch: {}, reply: '当前风景不能添加人物。' }) })('添加一个人', createScene());
  assert.deepEqual(result, { supported: false, patch: {}, reply: '当前风景不能添加人物。', changes: [], mode: 'ai' });
});

test('history restoration asks a clarification without a model request or invented state', async () => {
  let calls = 0;
  const interpret = createInterpreter(ENV, { fetcher: async () => { calls++; throw Error('must not call'); } });
  for (const text of ['恢复', '恢复原来的样子', '回到之前', '树多一点，然后恢复', 'undo last change', 'restore previous version', 'go back']) {
    const result = await interpret(text, createScene());
    assert.equal(result.supported, false, text); assert.deepEqual(result.patch, {});
    assert.deepEqual(result.changes, []); assert.match(result.reply, /哪一版/);
  }
  assert.equal(calls, 0);
});

test('an explicit boat restoration may still be interpreted from the current scene', async () => {
  let calls = 0;
  const interpret = createInterpreter(ENV, { fetcher: async () => { calls++; return Response.json(completion(modelResult({ boat: true }))); } });
  const result = await interpret('恢复帆船', updateScene(createScene(), { boat: false }));
  assert.equal(calls, 1); assert.deepEqual(result.patch, { boats: 1 });
});

test('malicious bases, missing credentials and invalid model configuration never trigger fetch', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw Error('must not call'); };
  const badEnvs = [null, {}, { CLAW_API_KEY: '' }, { CLAW_API_KEY: 'bad\nkey' },
    ...['http://api.clawhunt.site/v1', 'https://evil.example/v1', 'https://api.clawhunt.site.evil/v1',
      'https://user:pass@api.clawhunt.site/v1', 'https://api.clawhunt.site/v1?secret=yes',
      'https://api.clawhunt.site/v1#anything', 'https://api.clawhunt.site/v1/../../admin',
      'https://api.clawhunt.site:444/v1'].map((CLAW_BASE_URL) => ({ ...ENV, CLAW_BASE_URL })),
    { ...ENV, CLAW_MODEL: '' }, { ...ENV, CLAW_MODEL: 'bad\nmodel' }];
  for (const env of badEnvs) await assert.rejects(createInterpreter(env, { fetcher })('夜晚', createScene()), code('API_UNAVAILABLE'));
  assert.equal(calls, 0);
});

test('model objects have exact fields, safe types and bounded non-empty replies', async () => {
  const invalid = [null, [], {}, { ...modelResult(), extra: 'unknown' }, { ...modelResult(), supported: 'true' },
    { ...modelResult(), patch: [] }, { ...modelResult(), patch: null }, { ...modelResult(), patch: {} },
    { ...modelResult(), reply: '' }, { ...modelResult(), reply: ' ' }, { ...modelResult(), reply: '字'.repeat(301) },
    { ...modelResult(), reply: '有\u0000控制字符' }, { ...modelResult(), reply: 42 }];
  for (const value of invalid) await assert.rejects(createInterpreter(ENV, { fetcher: gateway(value) })('夜晚', createScene()), code('BAD_MODEL_RESULT'));
});

test('unknown schema/code fields, bad numeric types/bounds and unsupported patches are rejected', async () => {
  const patches = [{ unknown: 1 }, { code: 'eval(1)' }, { schemaVersion: 1 }, { hour: '22' }, { trees: 2.5 },
    { trees: 101 }, { flowers: -1 }, { rain: 2 }, { wind: null }, { branchAngle: 4 }, { branchDepth: 9 },
    { boat: 1 }, { boats: 9 }, { boats: 0, boat: true }, { boats: 2, boat: false }, { mountains: -1 },
    { mountains: 2.5 }, { boats: '3' }, { birds: 21 }, { birds: 1.5 },
    { placements: [{id: 'boat:0', x: 0.4, y: 0.7}] }, { leafOrigin: {x: 0.2, y: 0.3} },
    { leafTarget: {x: 0.8, y: 0.9} }, { seed: 4294967296 }, JSON.parse('{"__proto__":{"polluted":true}}')];
  for (const patch of patches) await assert.rejects(createInterpreter(ENV, { fetcher: gateway(modelResult(patch)) })('夜晚', createScene()), code('BAD_MODEL_RESULT'));
  await assert.rejects(createInterpreter(ENV, { fetcher: gateway({ supported: false, patch: { hour: 22 }, reply: '不能执行。' }) })('夜晚', createScene()), code('BAD_MODEL_RESULT'));
  assert.equal({}.polluted, undefined);
});

test('AI changes only bird count while stale placement cleanup is computed by the model', async () => {
  const base = updateScene(createScene(), {placements: [{id: 'bird:2', x: 0.6, y: 0.2}]});
  let prompt;
  const interpret = createInterpreter(ENV, {fetcher: async (_url, options) => {
    prompt = JSON.parse(options.body).messages[0].content;
    return Response.json(completion(modelResult({birds: 0})));
  }});
  const result = await interpret('不要鸟', base);
  assert.deepEqual(result.patch, {birds: 0, placements: []});
  assert.deepEqual(result.changes.map(item => item.key), ['birds', 'placements']);
  assert.match(prompt, /birds 整数 0–20/); assert.match(prompt, /禁止在 patch 返回这三个字段/);
  assert.deepEqual(updateScene(base, result.patch).placements, []);
  assert.equal(base.placements.length, 1);
});

test('AI count patches and tree removal use real normalized values and bounded parameters', async () => {
  const legacy = { ...createScene() }; delete legacy.boats; delete legacy.mountains;
  let prompt, sent;
  const interpret = createInterpreter(ENV, { fetcher: async (_url, options) => {
    const body = JSON.parse(options.body); prompt = body.messages[0].content; sent = JSON.parse(body.messages[1].content);
    return Response.json(completion(modelResult({ boats: 3, mountains: 4, trees: 0 })));
  } });
  const result = await interpret('增加两艘船，多几座山，树全部移除', legacy);
  assert.deepEqual(result.patch, { trees: 0, boats: 3, mountains: 4 });
  assert.equal(updateScene(legacy, result.patch).boat, true);
  assert.equal(sent.currentScene.boats, 1); assert.equal(sent.currentScene.mountains, 2);
  assert.match(prompt, /boats 整数 0–8/); assert.match(prompt, /mountains 整数 0–8/);
  assert.match(prompt, /不要树/); assert.match(prompt, /remove all trees/);
  assert.deepEqual(result.changes.map(item => item.key), ['trees', 'boats', 'mountains']);
});

test('same-value patches cannot claim that the model changed anything', async () => {
  const result = await createInterpreter(ENV, { fetcher: gateway(modelResult({ hour: 18.3 })) })('时间保持傍晚', createScene());
  assert.equal(result.supported, false); assert.deepEqual(result.patch, {}); assert.deepEqual(result.changes, []);
  assert.match(result.reply, /无需更改/);
});

test('invalid gateway shapes, fenced content and truncated/tool-call results are rejected safely', async () => {
  const invalid = [null, {}, { choices: [] }, { choices: [{ message: {} }] },
    { choices: [{ message: { content: 'gateway-private-detail' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: '```json\n' + JSON.stringify(modelResult()) + '\n```' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: JSON.stringify(modelResult()) }, finish_reason: 'length' }] },
    { choices: [{ message: { content: JSON.stringify(modelResult()), tool_calls: [{ function: { name: 'exec' } }] }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: [{ type: 'text', text: '{}' }] }, finish_reason: 'stop' }] }];
  for (const value of invalid) await assert.rejects(createInterpreter(ENV, { fetcher: async () => Response.json(value) })('夜晚', createScene()), code('BAD_MODEL_RESULT'));
  await assert.rejects(createInterpreter(ENV, { fetcher: async () => new Response('not json gateway-private-detail') })('夜晚', createScene()), code('BAD_MODEL_RESULT'));
  await assert.rejects(createInterpreter(ENV, { fetcher: async () => new Response('字'.repeat(33000)) })('夜晚', createScene()), code('BAD_MODEL_RESULT'));
});

test('network and HTTP failures do not reveal provider errors, secrets or retry requests', async () => {
  let calls = 0;
  const network = createInterpreter(ENV, { fetcher: async () => { calls++; throw Error('gateway-private-detail test-key-only'); } });
  await assert.rejects(network('夜晚', createScene()), code('API_UNAVAILABLE'));
  assert.equal(calls, 1);
  for (const status of [301, 401, 429, 500]) await assert.rejects(createInterpreter(ENV,
    { fetcher: async () => new Response('gateway-private-detail test-key-only', { status }) })('夜晚', createScene()), code('API_UNAVAILABLE'));
  const brokenBody = new ReadableStream({ start(controller) { controller.error(Error('gateway-private-detail')); } });
  await assert.rejects(createInterpreter(ENV, { fetcher: async () => new Response(brokenBody) })('夜晚', createScene()), code('API_UNAVAILABLE'));
});

test('20-second deadline aborts even when a fetcher ignores the signal', async () => {
  const original = globalThis.setTimeout;
  let delay, signal;
  globalThis.setTimeout = (callback, ms) => { delay = ms; return original(callback, 1); };
  try {
    const interpret = createInterpreter(ENV, { fetcher: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
    await assert.rejects(interpret('夜晚', createScene()), code('API_UNAVAILABLE'));
    assert.equal(delay, 20000); assert.equal(signal.aborted, true);
  } finally { globalThis.setTimeout = original; }
});

test('invalid visitor input or scene never reaches the provider', async () => {
  let calls = 0;
  const interpret = createInterpreter(ENV, { fetcher: async () => { calls++; throw Error('must not call'); } });
  for (const text of ['', ' ', {}, '字'.repeat(401), '夜晚\u0000']) await assert.rejects(interpret(text, createScene()), code('BAD_MODEL_RESULT'));
  await assert.rejects(interpret('夜晚', { ...createScene(), trees: 101 }), code('BAD_MODEL_RESULT'));
  assert.equal(calls, 0);
});
