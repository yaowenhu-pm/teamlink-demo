import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createGestureTaskLoader} from '../web/gesture-loading.mjs';

const root = 'https://fixture.invalid/vision/';
const fileset = {wasmLoaderPath: root + 'vision.js', wasmBinaryPath: root + 'vision.wasm'};
const wasmBytes = Uint8Array.from([1, 2, 3, 4]), modelBytes = Uint8Array.from([5, 6, 7]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digestImpl = (algorithm, bytes) => {assert.equal(algorithm, 'SHA-256'); return createHash('sha256').update(bytes).digest();};
const metadata = new Map([
  [fileset.wasmLoaderPath, {bytes: 2, sha256: 'a'.repeat(64)}],
  [fileset.wasmBinaryPath, {bytes: 4, sha256: sha256(wasmBytes)}],
  [root + 'model.task', {bytes: 3, sha256: sha256(modelBytes)}],
]);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) {
    if (i % 10 === 9) await new Promise(resolve => setImmediate(resolve));
    else await Promise.resolve();
  }
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
    digestImpl,
    fetchImpl(url, options) {
      fetches.push({url, options});
      const bytes = url.includes('vision.wasm') ? wasmBytes : modelBytes;
      return new Response(new ReadableStream({start(controller) {
        controller.enqueue(bytes); controller.close();
      }}), {headers: {'content-length': '1'}});
    },
    createObjectURL(blob) {const url = 'blob:fixture/' + (created.length + 1); created.push({url, blob}); return url;},
    revokeObjectURL(url) {revoked.push(url);},
    createTask(value, options) {const task = {value, options, closeCount: 0, close() {this.closeCount++;}}; tasks.push(task); return task;},
    ...clock, ...overrides,
  });
  return {loader, clock, fetches, created, revoked, tasks, get resolves() {return resolves;}};
}
function persistentFixture({openError, matchError, putError} = {}) {
  const entries = new Map(), opens = [], puts = [], deletes = [], matches = [];
  const keyUrl = key => typeof key === 'string' ? key : key.url;
  const cache = {
    async match(key) {
      matches.push(keyUrl(key));
      if (matchError) throw matchError;
      const bytes = entries.get(keyUrl(key));
      return bytes ? new Response(bytes.slice()) : undefined;
    },
    async put(key, response) {
      puts.push(keyUrl(key));
      if (putError) throw putError;
      entries.set(keyUrl(key), new Uint8Array(await response.arrayBuffer()));
    },
    async keys() {return [...entries.keys()].map(url => new Request(url));},
    async delete(key) {deletes.push(keyUrl(key)); return entries.delete(keyUrl(key));},
  };
  const storage = {
    async open(name) {opens.push(name); if (openError) throw openError; return cache;},
    keys() {assert.fail('must not inspect other cache namespaces');},
    delete() {assert.fail('must not delete other cache namespaces');},
  };
  return {entries, opens, puts, deletes, matches, cache, storage};
}
const persistentKey = url => url + '?v=' + metadata.get(url).sha256;

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
  assert.equal(new URL(wasmUrl).searchParams.get('v'), sha256(wasmBytes).slice(0, 12));
  assert.equal(new URL(modelUrl).searchParams.get('v'), sha256(modelBytes).slice(0, 12));
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
  assert.deepEqual(progress[0], {phase: 'download', loaded: 0, total: 7, cacheLoaded: 0, fetchLoaded: 0, cacheAvailable: false});
  assert.deepEqual(progress.at(-1), {phase: 'ready', loaded: 7, total: 7, cacheLoaded: 0, fetchLoaded: 7, cacheAvailable: false});
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

test('persistent cache is opt-in and lazy; real SHA-256-verified fetches warm exact WASM/model keys', async () => {
  let lookups = 0;
  const unused = fixture({getCacheStorage() {lookups++; throw new Error('must remain inert');}});
  await unused.loader();
  assert.equal(lookups, 0, 'factory defaults must not enable persistent caching');

  const local = persistentFixture(), progress = [];
  const f = fixture({persistentCache: true, getCacheStorage() {lookups++; return local.storage;}, digestImpl: undefined});
  assert.equal(lookups, 0); assert.deepEqual(local.opens, []);
  await f.loader({}, {onProgress: update => progress.push(update)});
  assert.equal(lookups, 1);
  assert.deepEqual(local.opens, ['teamlink-hand-vision-assets-v1']);
  assert.deepEqual([...local.entries.keys()].sort(), [persistentKey(fileset.wasmBinaryPath), persistentKey(root + 'model.task')].sort());
  assert.deepEqual(local.entries.get(persistentKey(fileset.wasmBinaryPath)), wasmBytes);
  assert.deepEqual(local.entries.get(persistentKey(root + 'model.task')), modelBytes);
  assert.ok(local.puts.every(url => new URL(url).searchParams.get('v').length === 64));
  assert.equal(local.puts.some(url => url.includes('vision.js')), false, 'loader scripts stay in normal HTTP caching');
  assert.equal(f.fetches.length, 2);
  assert.equal(progress[0].phase, 'checking-cache');
  assert.deepEqual(progress.at(-1), {phase: 'ready', loaded: 7, total: 7, cacheLoaded: 0, fetchLoaded: 7, cacheAvailable: true});

  const warmProgress = [];
  await f.loader({}, {onProgress: update => warmProgress.push(update)});
  assert.equal(f.fetches.length, 2, 'a warm load must not fetch the WASM/model again');
  assert.deepEqual(warmProgress.at(-1), {phase: 'ready', loaded: 7, total: 7, cacheLoaded: 7, fetchLoaded: 0, cacheAvailable: true});
  assert.ok(warmProgress.every(update => update.phase !== 'download'));
  assert.equal(f.tasks.length, 2); assert.equal(f.clock.pending.size, 0);
});

test('valid cache survives a new loader and works offline with truthful cached-byte progress', async () => {
  const local = persistentFixture();
  const first = fixture({persistentCache: true, getCacheStorage: () => local.storage});
  await first.loader();
  const progress = [], f = fixture({persistentCache: true, getCacheStorage: () => local.storage,
    fetchImpl() {assert.fail('offline persistent hits must not call fetch');}});
  await f.loader({}, {onProgress: update => progress.push(update)});
  assert.equal(f.tasks.length, 1);
  assert.deepEqual(progress.filter(update => update.loaded > 0 && update.loaded < 7).map(update => update.loaded), [4]);
  assert.equal(progress.at(-1).cacheLoaded, 7);
  assert.equal(progress.at(-1).fetchLoaded, 0);
  assert.equal(f.clock.pending.size, 0);
});

test('wrong SHA or size in persistent cache is removed and falls back without counting corrupt bytes', async () => {
  for (const badBytes of [Uint8Array.from([9, 9, 9, 9]), Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3, 4, 5])]) {
    const local = persistentFixture(), progress = [];
    local.entries.set(persistentKey(fileset.wasmBinaryPath), badBytes);
    local.entries.set(persistentKey(root + 'model.task'), modelBytes);
    const f = fixture({persistentCache: true, getCacheStorage: () => local.storage});
    await f.loader({}, {onProgress: update => progress.push(update)});
    assert.equal(f.fetches.length, 1);
    assert.ok(f.fetches[0].url.includes('vision.wasm'));
    assert.deepEqual(local.deletes, [persistentKey(fileset.wasmBinaryPath)]);
    assert.deepEqual(local.entries.get(persistentKey(fileset.wasmBinaryPath)), wasmBytes);
    assert.deepEqual(progress.at(-1), {phase: 'ready', loaded: 7, total: 7, cacheLoaded: 3, fetchLoaded: 4, cacheAvailable: true});
    assert.ok(progress.every((update, i) => update.loaded <= 7 && update.loaded === update.cacheLoaded + update.fetchLoaded
      && (!i || update.loaded >= progress[i - 1].loaded)));
  }
});

test('cache cleanup removes only older versions of the selected paths in the dedicated namespace', async () => {
  const local = persistentFixture(), oldWasm = fileset.wasmBinaryPath + '?v=' + '0'.repeat(64), oldModel = root + 'model.task?v=' + '0'.repeat(64);
  const retained = [root + 'other-model.task?v=' + '0'.repeat(64), root + 'vision.wasm?variant=other&v=' + '0'.repeat(64),
    root + 'nosimd.wasm?v=' + '0'.repeat(64), 'https://another.invalid/vision/vision.wasm?v=' + '0'.repeat(64)];
  for (const key of [oldWasm, oldModel, ...retained]) local.entries.set(key, Uint8Array.from([0]));
  const f = fixture({persistentCache: true, getCacheStorage: () => local.storage});
  await f.loader();
  assert.deepEqual(local.deletes.sort(), [oldWasm, oldModel].sort());
  assert.ok(retained.every(key => local.entries.has(key)));
  assert.ok(local.opens.every(name => name === 'teamlink-hand-vision-assets-v1'));
});

test('missing or denied cache APIs, quota errors and missing digest gracefully use ordinary HTTP caching', async () => {
  const securityError = Object.assign(new Error('fixture unavailable'), {name: 'SecurityError'});
  const quotaError = Object.assign(new Error('fixture quota'), {name: 'QuotaExceededError'});
  const deniedOpen = persistentFixture({openError: securityError}), deniedRead = persistentFixture({matchError: securityError}), full = persistentFixture({putError: quotaError});
  for (const cacheOptions of [
    {getCacheStorage: () => undefined},
    {getCacheStorage() {throw securityError;}},
    {getCacheStorage: () => deniedOpen.storage},
    {getCacheStorage: () => deniedRead.storage},
    {getCacheStorage: () => full.storage},
    {getCacheStorage: () => persistentFixture().storage, digestImpl: () => undefined},
    {getCacheStorage: () => persistentFixture().storage, digestImpl: () => Promise.reject(securityError)},
  ]) {
    const progress = [], f = fixture({persistentCache: true, ...cacheOptions});
    await f.loader({}, {onProgress: update => progress.push(update)});
    assert.equal(f.fetches.length, 2); assert.equal(f.tasks.length, 1);
    assert.ok(f.fetches.every(({options}) => options.cache === 'default'));
    assert.deepEqual(progress.at(-1), {phase: 'ready', loaded: 7, total: 7, cacheLoaded: 0, fetchLoaded: 7, cacheAvailable: false});
    assert.equal(f.clock.pending.size, 0);
  }
  assert.equal(full.entries.size, 0);
});

test('wrong fetched SHA rejects before native initialization and never persists the corrupt file', async () => {
  const local = persistentFixture();
  const f = fixture({persistentCache: true, getCacheStorage: () => local.storage, digestImpl: undefined,
    fetchImpl(url) {return new Response(url.includes('vision.wasm') ? Uint8Array.from([8, 8, 8, 8]) : modelBytes);}});
  await assert.rejects(f.loader(), {name: 'AssetIntegrityError'});
  assert.equal(f.tasks.length, 0); assert.equal(f.created.length, 0);
  assert.equal(local.entries.has(persistentKey(fileset.wasmBinaryPath)), false);
  assert.equal(f.clock.pending.size, 0);
});

test('cancellation aborts persistent-cache miss readers and never writes their partial data', async () => {
  const local = persistentFixture(), active = new AbortController(), streams = [], progress = [];
  const f = fixture({persistentCache: true, getCacheStorage: () => local.storage,
    fetchImpl() {const stream = responseStream(); streams.push(stream); return stream.response;}});
  const loading = f.loader({}, {signal: active.signal, onProgress: update => progress.push(update)});
  const rejected = assert.rejects(loading, {name: 'AbortError'});
  await until(() => streams.length === 2 && streams.every(stream => stream.response.body.locked));
  streams[0].push([1]); streams[1].push([5]);
  await until(() => progress.some(update => update.loaded === 2));
  active.abort(); await rejected;
  const count = progress.length;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(streams.map(stream => stream.cancellations), [1, 1]);
  assert.equal(local.puts.length, 0); assert.equal(local.entries.size, 0);
  assert.equal(progress.length, count); assert.equal(f.tasks.length, 0);
  assert.equal(f.clock.pending.size, 0);
});

test('cancellation while hashing suppresses late cache writes and native startup', async () => {
  const local = persistentFixture(), hash = deferred(), active = new AbortController(), progress = [];
  let hashes = 0;
  const f = fixture({persistentCache: true, getCacheStorage: () => local.storage,
    digestImpl(algorithm, bytes) {hashes++; return hash.promise.then(() => digestImpl(algorithm, bytes));}});
  const loading = f.loader({}, {signal: active.signal, onProgress: update => progress.push(update)});
  const rejected = assert.rejects(loading, {name: 'AbortError'});
  await until(() => hashes === 2);
  active.abort(); await rejected;
  const count = progress.length;
  hash.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(local.puts.length, 0); assert.equal(local.entries.size, 0);
  assert.equal(progress.length, count); assert.equal(f.tasks.length, 0);
  assert.equal(f.clock.pending.size, 0);
});

test('cancellation during a cache put permits only its complete verified bytes and starts no late task', async () => {
  const local = persistentFixture(), gate = deferred(), active = new AbortController(), progress = [];
  const put = local.cache.put.bind(local.cache);
  let pendingPuts = 0;
  local.cache.put = async (key, response) => {pendingPuts++; await gate.promise; return put(key, response);};
  const f = fixture({persistentCache: true, getCacheStorage: () => local.storage});
  const loading = f.loader({}, {signal: active.signal, onProgress: update => progress.push(update)});
  const rejected = assert.rejects(loading, {name: 'AbortError'});
  await until(() => pendingPuts === 2);
  active.abort(); await rejected;
  const count = progress.length;
  gate.resolve(); await until(() => local.entries.size === 2);
  assert.deepEqual(local.entries.get(persistentKey(fileset.wasmBinaryPath)), wasmBytes);
  assert.deepEqual(local.entries.get(persistentKey(root + 'model.task')), modelBytes);
  assert.equal(progress.length, count); assert.equal(f.tasks.length, 0); assert.equal(f.created.length, 0);
  assert.equal(f.clock.pending.size, 0);
});
