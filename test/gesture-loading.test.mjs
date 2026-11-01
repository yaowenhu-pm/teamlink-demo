import test from 'node:test';
import assert from 'node:assert/strict';
import {createGestureTaskLoader} from '../web/gesture-loading.mjs';

const root = 'https://fixture.invalid/vision/';
const fileset = {wasmLoaderPath: root + 'vision.js', wasmBinaryPath: root + 'vision.wasm'};
const metadata = new Map([
  [fileset.wasmLoaderPath, {bytes: 2, sha256: 'a'.repeat(64)}],
  [fileset.wasmBinaryPath, {bytes: 4, sha256: 'b'.repeat(64)}],
  [root + 'model.task', {bytes: 3, sha256: 'c'.repeat(64)}],
]);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
  assert.ok(predicate(), 'expected asynchronous stage was reached');
}
function timers() {
  let next = 0;
  const pending = new Map();
  return {
    setTimeoutImpl(callback, ms) {const id = ++next; pending.set(id, {callback, ms}); return id;},
    clearTimeoutImpl(id) {pending.delete(id);},
    fire(ms) {for (const [id, value] of [...pending]) if (value.ms === ms && pending.delete(id)) value.callback();},
    pending,
  };
}
function responseStream() {
  let controller, cancellations = 0;
  const body = new ReadableStream({start(value) {controller = value;}, cancel() {cancellations++;}});
  return {response: new Response(body, {headers: {'content-length': '999'}}),
    push: values => controller.enqueue(Uint8Array.from(values)), finish: () => controller.close(),
    get cancellations() {return cancellations;}};
}
function fixture(overrides = {}) {
  const clock = timers(), fetches = [], created = [], revoked = [], tasks = [];
  let resolves = 0;
  const loader = createGestureTaskLoader({
    resolveFileset() {resolves++; return {...fileset};},
    assetInfo: url => metadata.get(url), modelUrl: root + 'model.task',
    fetchImpl(url, options) {
      fetches.push({url, options});
      const count = url.includes('vision.wasm') ? 4 : 3;
      return new Response(new ReadableStream({start(controller) {
        controller.enqueue(new Uint8Array(count).fill(count)); controller.close();
      }}), {headers: {'content-length': '1'}});
    },
    createObjectURL(blob) {const url = 'blob:fixture/' + (created.length + 1); created.push({url, blob}); return url;},
    revokeObjectURL(url) {revoked.push(url);},
    createTask(value, options) {const task = {value, options, closeCount: 0, close() {this.closeCount++;}}; tasks.push(task); return task;},
    ...clock, ...overrides,
  });
  return {loader, clock, fetches, created, revoked, tasks, get resolves() {return resolves;}};
}

test('opt-in downloads report decoded stream bytes, version only selected files, and preserve task options', async () => {
  const streams = new Map(), fetches = [], progress = [];
  const f = fixture({fetchImpl(url) {const stream = responseStream(); streams.set(url, stream); fetches.push(url); return stream.response;}});
  assert.equal(f.resolves, 0);
  assert.equal(fetches.length, 0);
  const loading = f.loader({runningMode: 'IMAGE', numHands: 2, baseOptions: {modelAssetPath: 'untrusted.task'}}, {onProgress: update => progress.push(update)});
  await until(() => fetches.length === 2);
  assert.equal(f.created.length, 0, 'both downloads start before native initialization');
  const wasmUrl = fetches.find(url => url.includes('vision.wasm'));
  const modelUrl = fetches.find(url => url.includes('model.task'));
  assert.equal(new URL(wasmUrl).searchParams.get('v'), 'b'.repeat(12));
  assert.equal(new URL(modelUrl).searchParams.get('v'), 'c'.repeat(12));
  streams.get(wasmUrl).push([1, 2]);
  streams.get(modelUrl).push([5]);
  await until(() => progress.some(update => update.loaded === 3));
  streams.get(wasmUrl).push([3, 4]); streams.get(wasmUrl).finish();
  streams.get(modelUrl).push([6, 7]); streams.get(modelUrl).finish();
  const task = await loading;
  assert.equal(task.options.runningMode, 'IMAGE');
  assert.equal(task.options.numHands, 2);
  assert.equal(task.options.baseOptions.modelAssetPath, undefined);
  assert.deepEqual([...task.options.baseOptions.modelAssetBuffer], [5, 6, 7]);
  assert.equal(task.value.wasmLoaderPath, root + 'vision.js?v=' + 'a'.repeat(12));
  assert.equal(task.value.wasmBinaryPath, f.created[0].url);
  assert.equal(f.created[0].blob.type, 'application/wasm');
  assert.deepEqual([...new Uint8Array(await f.created[0].blob.arrayBuffer())], [1, 2, 3, 4]);
  assert.deepEqual(progress[0], {phase: 'download', loaded: 0, total: 7});
  assert.deepEqual(progress.at(-1), {phase: 'ready', loaded: 7, total: 7});
  assert.ok(progress.every((update, i) => update.loaded <= 7 && update.total === 7 && (!i || update.loaded >= progress[i - 1].loaded)));
  assert.deepEqual(progress.slice(-2).map(update => update.phase), ['initializing', 'ready']);
  assert.deepEqual(f.revoked, [f.created[0].url]);
  assert.equal(task.closeCount, 0, 'successful task ownership belongs to the caller');
  assert.equal(f.clock.pending.size, 0);
});

test('short or oversized decoded streams reject and never create a native task', async () => {
  for (const count of [3, 5]) {
    const f = fixture({fetchImpl(url) {
      const size = url.includes('vision.wasm') ? count : 3;
      return new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(size)); controller.close();}}));
    }});
    await assert.rejects(f.loader(), {name: 'AssetSizeError'});
    assert.equal(f.created.length, 0);
    assert.equal(f.tasks.length, 0);
    assert.equal(f.clock.pending.size, 0);
  }
});

test('an already cancelled request is inert; cancelling live streams stops both readers and suppresses later progress', async () => {
  const aborted = new AbortController(); aborted.abort();
  const first = fixture();
  await assert.rejects(first.loader({}, {signal: aborted.signal}), {name: 'AbortError'});
  assert.equal(first.resolves, 0); assert.equal(first.fetches.length, 0);
  const active = new AbortController(), streams = [], progress = [];
  const f = fixture({fetchImpl() {const stream = responseStream(); streams.push(stream); return stream.response;}});
  const loading = f.loader({}, {signal: active.signal, onProgress: update => progress.push(update)});
  const rejected = assert.rejects(loading, {name: 'AbortError'});
  await until(() => streams.length === 2);
  await until(() => streams.every(stream => stream.response.body.locked));
  active.abort(); await rejected;
  const count = progress.length;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(progress.length, count);
  assert.deepEqual(streams.map(stream => stream.cancellations), [1, 1]);
  assert.equal(f.tasks.length, 0); assert.equal(f.clock.pending.size, 0);
});

test('idle and overall deadlines reject even if a fetch or resolver never settles', async () => {
  for (const phase of ['idle', 'overall']) {
    const streams = [];
    const f = fixture(phase === 'idle' ? {fetchImpl() {const stream = responseStream(); streams.push(stream); return stream.response;}}
      : {resolveFileset: () => new Promise(() => {})});
    const loading = f.loader();
    const rejected = assert.rejects(loading, {name: 'TimeoutError'});
    if (phase === 'idle') await until(() => streams.length === 2 && streams.every(stream => stream.response.body.locked));
    f.clock.fire(phase === 'idle' ? 45_000 : 180_000);
    await rejected;
    assert.equal(f.tasks.length, 0); assert.equal(f.clock.pending.size, 0);
    if (phase === 'idle') assert.deepEqual(streams.map(stream => stream.cancellations), [1, 1]);
  }
});

test('abort during native initialization closes a late task and revokes its Blob only after it settles', async () => {
  const native = deferred(), active = new AbortController();
  let calls = 0, closes = 0;
  const f = fixture({createTask() {calls++; return native.promise;}});
  const loading = f.loader({}, {signal: active.signal});
  const rejected = assert.rejects(loading, {name: 'AbortError'});
  await until(() => calls === 1);
  active.abort(); await rejected;
  assert.equal(f.revoked.length, 0);
  native.resolve({close() {closes++;}});
  await until(() => f.revoked.length === 1);
  assert.equal(closes, 1); assert.equal(f.clock.pending.size, 0);
});

test('initialization timeout releases the UI but serializes retries and closes the late first task', async () => {
  const firstNative = deferred(), secondNative = deferred(), progress = [];
  let calls = 0, active = 0, maxActive = 0, firstClosed = 0, secondClosed = 0;
  const f = fixture({createTask() {
    calls++; active++; maxActive = Math.max(active, maxActive);
    return (calls === 1 ? firstNative.promise : secondNative.promise).finally(() => active--);
  }});
  const first = f.loader();
  const firstRejected = assert.rejects(first, {name: 'TimeoutError'});
  await until(() => calls === 1);
  f.clock.fire(30_000); await firstRejected;
  const second = f.loader({}, {onProgress: update => progress.push(update)});
  await until(() => progress.some(update => update.phase === 'waiting'));
  assert.equal(calls, 1); assert.equal(f.revoked.length, 0);
  firstNative.resolve({close() {firstClosed++;}});
  await until(() => calls === 2);
  assert.equal(firstClosed, 1); assert.equal(f.revoked.length, 1);
  secondNative.resolve({close() {secondClosed++;}});
  await second;
  assert.equal(maxActive, 1); assert.equal(secondClosed, 0);
  assert.equal(progress.at(-1).phase, 'ready');
  assert.equal(f.revoked.length, 2); assert.equal(f.clock.pending.size, 0);
});

test('cancelling a queued caller cannot let the next initialization overtake an active one', async () => {
  const native = deferred(), waitingAbort = new AbortController(), secondProgress = [], thirdProgress = [];
  let calls = 0;
  const f = fixture({createTask() {calls++; return calls === 1 ? native.promise : {close() {}};}});
  const first = f.loader();
  await until(() => calls === 1);
  const second = f.loader({}, {signal: waitingAbort.signal, onProgress: update => secondProgress.push(update)});
  const secondRejected = assert.rejects(second, {name: 'AbortError'});
  await until(() => secondProgress.some(update => update.phase === 'waiting'));
  waitingAbort.abort(); await secondRejected;
  const third = f.loader({}, {onProgress: update => thirdProgress.push(update)});
  await until(() => thirdProgress.some(update => update.phase === 'waiting'));
  assert.equal(calls, 1);
  native.resolve({close() {}});
  await first; await third;
  assert.equal(calls, 2); assert.equal(f.created.length, 2);
  assert.equal(f.clock.pending.size, 0);
});

test('native rejection cleans resources and does not poison the following initialization', async () => {
  let calls = 0;
  const f = fixture({createTask() {calls++; if (calls === 1) throw new Error('fixture native failure'); return {close() {}};}});
  await assert.rejects(f.loader(), /fixture native failure/);
  await f.loader();
  assert.equal(calls, 2); assert.equal(f.revoked.length, 2);
  assert.equal(f.clock.pending.size, 0);
});
