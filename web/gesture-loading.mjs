const error = (name, message) => Object.assign(new Error(message), {name});
const cancelled = () => error('AbortError', 'Hand recognition loading was cancelled.');
const persistentCacheName = 'teamlink-hand-vision-assets-v1';

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, {once: true});
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, reason => { cleanup(); reject(reason); });
    if (signal.aborted) onAbort();
  });
}

/**
 * Opt-in, pinned asset loading followed by serialized native task startup.
 * No requests, resolver, cache or digest calls happen until the returned function
 * is called. persistentCache enables a product/model-specific CacheStorage cache;
 * getCacheStorage and digestImpl are lazy and injectable. Cache keys contain the
 * full SHA, while fetch URLs preserve the existing HTTP-cache version suffix.
 * assetInfo(url) returns the pinned {bytes, sha256} for each resolver/model URL.
 * createTask(fileset, options) receives a local WASM Blob URL and model buffer.
 * Timers, fetch and object URLs are injectable for tests without real devices.
 */
export function createGestureTaskLoader({resolveFileset, createTask, assetInfo, modelUrl,
  fetchImpl = (...args) => globalThis.fetch(...args),
  persistentCache = false, getCacheStorage = () => globalThis.caches,
  digestImpl = (algorithm, bytes) => globalThis.crypto?.subtle?.digest(algorithm, bytes),
  createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url),
  idleTimeoutMs = 45_000, overallTimeoutMs = 180_000, initializationTimeoutMs = 30_000,
  setTimeoutImpl = (callback, ms) => setTimeout(callback, ms), clearTimeoutImpl = timer => clearTimeout(timer)} = {}) {
  if (![resolveFileset, createTask, assetInfo, fetchImpl, getCacheStorage, digestImpl, createObjectURL, revokeObjectURL, setTimeoutImpl, clearTimeoutImpl].every(fn => typeof fn === 'function')
    || typeof persistentCache !== 'boolean'
    || ![idleTimeoutMs, overallTimeoutMs, initializationTimeoutMs].every(ms => Number.isFinite(ms) && ms > 0)) {
    throw new TypeError('Invalid task loader configuration.');
  }
  let initializationTail = Promise.resolve(), initializationCount = 0;
  const pinned = url => {
    const info = assetInfo(String(url));
    if (!info || !Number.isSafeInteger(info.bytes) || info.bytes <= 0 || !/^[a-f0-9]{64}$/i.test(info.sha256)) {
      throw new TypeError('Missing pinned asset metadata.');
    }
    const sha256 = info.sha256.toLowerCase(), versioned = new URL(String(url));
    versioned.searchParams.set('v', sha256.slice(0, 12));
    const cacheKey = new URL(versioned); cacheKey.searchParams.set('v', sha256);
    const identity = new URL(versioned); identity.searchParams.delete('v');
    return {url: versioned.href, cacheKey: cacheKey.href, identity: identity.href, bytes: info.bytes, sha256};
  };

  return async function loadTask(taskOptions = {}, {signal: callerSignal, onProgress} = {}) {
    const controller = new AbortController(), signal = controller.signal;
    const abort = reason => { if (!signal.aborted) controller.abort(reason); };
    const onCallerAbort = () => abort(cancelled());
    if (callerSignal?.aborted) throw cancelled();
    callerSignal?.addEventListener('abort', onCallerAbort, {once: true});
    const overallTimer = setTimeoutImpl(() => abort(error('TimeoutError', 'Hand recognition loading exceeded its overall time limit.')), overallTimeoutMs);
    let loaded = 0, total = 0, cacheLoaded = 0, fetchLoaded = 0, cacheAvailable = false, cache;
    const emit = phase => {
      if (signal.aborted) return;
      // Progress is observational; UI callback errors must not leak native tasks.
      // fetchLoaded includes browser HTTP-cache responses, not just network I/O.
      try { onProgress?.({phase, loaded, total, cacheLoaded, fetchLoaded, cacheAvailable}); } catch {}
    };
    const throwIfAborted = () => { if (signal.aborted) throw signal.reason; };

    const disableCache = () => { cacheAvailable = false; cache = undefined; };
    async function openCache() {
      if (!persistentCache) return;
      emit('checking-cache'); throwIfAborted();
      try {
        const storage = getCacheStorage();
        if (!storage?.open) return;
        cache = await abortable(storage.open(persistentCacheName), signal);
        throwIfAborted();
        cacheAvailable = Boolean(cache && ['match', 'put', 'keys', 'delete'].every(method => typeof cache[method] === 'function'));
        if (!cacheAvailable) disableCache();
      } catch {
        throwIfAborted(); disableCache();
      }
    }

    async function verified(bytes, asset) {
      let digest;
      try {
        digest = await abortable(Promise.resolve().then(() => { throwIfAborted(); return digestImpl('SHA-256', bytes); }), signal);
        throwIfAborted();
        digest = ArrayBuffer.isView(digest) ? new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength)
          : digest instanceof ArrayBuffer ? new Uint8Array(digest) : undefined;
        if (digest?.byteLength !== 32) { disableCache(); return false; }
      } catch {
        throwIfAborted(); disableCache(); return false;
      }
      const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      if (sha256 !== asset.sha256) throw error('AssetIntegrityError', 'A hand recognition asset did not match its pinned SHA-256.');
      return true;
    }

    async function readBytes(response, asset, fromFetch) {
      let idleTimer, reader, complete = false;
      const refreshIdle = () => {
        if (!fromFetch) return;
        clearTimeoutImpl(idleTimer);
        idleTimer = setTimeoutImpl(() => abort(error('TimeoutError', 'A hand recognition asset stopped downloading.')), idleTimeoutMs);
      };
      const cancelReader = () => { try { Promise.resolve(reader?.cancel(signal.reason)).catch(() => {}); } catch {} };
      refreshIdle();
      signal.addEventListener('abort', cancelReader, {once: true});
      try {
        throwIfAborted();
        if (!response.ok || !response.body?.getReader) throw error('AssetDownloadError', `Unable to download hand recognition asset (${response.status}).`);
        reader = response.body.getReader();
        throwIfAborted();
        const bytes = new Uint8Array(asset.bytes);
        let offset = 0;
        while (true) {
          const {done, value} = await abortable(reader.read(), signal);
          throwIfAborted();
          if (done) break;
          if (!(value instanceof Uint8Array) || offset + value.byteLength > asset.bytes) throw error('AssetSizeError', 'A hand recognition asset exceeded its pinned decoded size.');
          if (value.byteLength) {
            bytes.set(value, offset); offset += value.byteLength;
            if (fromFetch) { fetchLoaded += value.byteLength; loaded += value.byteLength; refreshIdle(); emit('download'); }
          }
        }
        if (offset !== asset.bytes) throw error('AssetSizeError', 'A hand recognition asset was shorter than its pinned decoded size.');
        complete = true;
        return bytes;
      } finally {
        clearTimeoutImpl(idleTimer);
        signal.removeEventListener('abort', cancelReader);
        if (!complete || signal.aborted) cancelReader();
        try { reader?.releaseLock(); } catch {}
      }
    }

    async function removeStaleEntries(asset, targetCache) {
      // Only this dedicated cache and this exact asset path/query are touched.
      // Other products, model paths and the other SIMD variant remain untouched.
      try {
        const keys = await abortable(targetCache.keys(), signal);
        for (const key of keys) {
          throwIfAborted();
          const keyUrl = new URL(key.url); keyUrl.searchParams.delete('v');
          if (keyUrl.href === asset.identity && key.url !== asset.cacheKey) {
            await abortable(targetCache.delete(key), signal);
          }
        }
      } catch { throwIfAborted(); }
    }

    async function loadAsset(asset) {
      const targetCache = cache;
      if (targetCache) {
        let response;
        try { response = await abortable(targetCache.match(asset.cacheKey), signal); }
        catch { throwIfAborted(); disableCache(); }
        if (response) {
          try {
            const bytes = await readBytes(response, asset, false);
            if (await verified(bytes, asset)) {
              throwIfAborted();
              cacheLoaded += bytes.byteLength; loaded += bytes.byteLength; emit('checking-cache');
              await removeStaleEntries(asset, targetCache);
              return bytes;
            }
          } catch {
            throwIfAborted();
            // A wrong-size/hash entry cannot become a usable warm-cache hit.
            try { await abortable(targetCache.delete(asset.cacheKey), signal); } catch { throwIfAborted(); }
          }
        }
      }
      throwIfAborted(); emit('download'); throwIfAborted();
      let fetchTimer;
      try {
        // The fetch itself can stall before it provides a readable body.
        fetchTimer = setTimeoutImpl(() => abort(error('TimeoutError', 'A hand recognition asset stopped downloading.')), idleTimeoutMs);
        const response = await abortable(fetchImpl(asset.url, {signal, credentials: 'same-origin', cache: 'default'}), signal);
        clearTimeoutImpl(fetchTimer); fetchTimer = undefined;
        const bytes = await readBytes(response, asset, true);
        const isVerified = await verified(bytes, asset);
        throwIfAborted();
        if (cacheAvailable && cache && isVerified) {
          const writableCache = cache;
          try {
            // The response owns only complete, verified bytes. An in-flight put
            // may finish after cancellation, but no partial file is ever stored.
            await abortable(writableCache.put(asset.cacheKey, new Response(bytes, {
              headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength)},
            })), signal);
            throwIfAborted();
            await removeStaleEntries(asset, writableCache);
          } catch { throwIfAborted(); disableCache(); }
        }
        return bytes;
      } catch (reason) {
        abort(reason);
        throw signal.reason;
      } finally { clearTimeoutImpl(fetchTimer); }
    }

    async function initialize(fileset, wasmBytes, modelBytes) {
      const previous = initializationTail;
      let release, released = false, started = false, wasmUrl, initializationTimer;
      let ownedTask = null, delivered = false, closed = false;
      initializationTail = new Promise(resolve => { release = resolve; });
      const wasWaiting = initializationCount++ > 0;
      const releaseTurn = () => {
        if (released) return;
        released = true; initializationCount--; release();
      };
      const closeAbandoned = () => {
        if (ownedTask && signal.aborted && !delivered && !closed) {
          closed = true; try { ownedTask.close(); } catch {}
        }
      };
      signal.addEventListener('abort', closeAbandoned);
      try {
        if (wasWaiting) emit('waiting');
        await abortable(previous, signal);
        throwIfAborted();
        wasmUrl = createObjectURL(new Blob([wasmBytes], {type: 'application/wasm'}));
        const baseOptions = {...taskOptions.baseOptions, modelAssetBuffer: modelBytes};
        delete baseOptions.modelAssetPath;
        emit('initializing'); throwIfAborted();
        initializationTimer = setTimeoutImpl(() => abort(error('TimeoutError', 'Hand recognition initialization exceeded its time limit.')), initializationTimeoutMs);
        const pending = Promise.resolve().then(() => {
          throwIfAborted();
          return createTask({...fileset, wasmBinaryPath: wasmUrl}, {...taskOptions, baseOptions});
        }).then(task => { ownedTask = task; closeAbandoned(); return task; });
        started = true;
        // Keep the turn and Blob alive until the real native initialization
        // settles, even when this caller has already cancelled or timed out.
        const finish = () => {
          clearTimeoutImpl(initializationTimer);
          signal.removeEventListener('abort', closeAbandoned);
          try { revokeObjectURL(wasmUrl); } catch {}
          releaseTurn();
        };
        pending.then(finish, finish);
        const task = await abortable(pending, signal);
        throwIfAborted(); emit('ready'); throwIfAborted();
        delivered = true;
        return task;
      } finally {
        closeAbandoned();
        if (signal.aborted) clearTimeoutImpl(initializationTimer);
        if (!started) {
          clearTimeoutImpl(initializationTimer);
          signal.removeEventListener('abort', closeAbandoned);
          if (wasmUrl) { try { revokeObjectURL(wasmUrl); } catch {} }
          // An abandoned waiter must not let the next caller pass the still
          // running predecessor. Link its empty turn to that predecessor.
          previous.then(releaseTurn, releaseTurn);
        }
      }
    }

    try {
      throwIfAborted();
      const fileset = await abortable(Promise.resolve().then(() => { throwIfAborted(); return resolveFileset(); }), signal);
      throwIfAborted();
      const wasm = pinned(fileset.wasmBinaryPath), model = pinned(modelUrl), script = pinned(fileset.wasmLoaderPath);
      total = wasm.bytes + model.bytes;
      await openCache();
      throwIfAborted();
      const [wasmBytes, modelBytes] = await Promise.all([loadAsset(wasm), loadAsset(model)]);
      throwIfAborted();
      return await initialize({...fileset, wasmLoaderPath: script.url}, wasmBytes, modelBytes);
    } catch (reason) {
      abort(reason);
      throw signal.reason;
    } finally {
      clearTimeoutImpl(overallTimer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  };
}
