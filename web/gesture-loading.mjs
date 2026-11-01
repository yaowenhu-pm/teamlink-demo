const error = (name, message) => Object.assign(new Error(message), {name});
const cancelled = () => error('AbortError', 'Hand recognition loading was cancelled.');

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
 * Opt-in, exact-size asset downloads followed by serialized native task startup.
 * No requests or resolver calls happen until the returned function is called.
 * assetInfo(url) returns the pinned {bytes, sha256} for each resolver/model URL.
 * createTask(fileset, options) receives a local WASM Blob URL and model buffer.
 * Timers, fetch and object URLs are injectable for tests without real devices.
 */
export function createGestureTaskLoader({resolveFileset, createTask, assetInfo, modelUrl,
  fetchImpl = (...args) => globalThis.fetch(...args),
  createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url),
  idleTimeoutMs = 45_000, overallTimeoutMs = 180_000, initializationTimeoutMs = 30_000,
  setTimeoutImpl = (callback, ms) => setTimeout(callback, ms), clearTimeoutImpl = timer => clearTimeout(timer)} = {}) {
  if (![resolveFileset, createTask, assetInfo, fetchImpl, createObjectURL, revokeObjectURL, setTimeoutImpl, clearTimeoutImpl].every(fn => typeof fn === 'function')
    || ![idleTimeoutMs, overallTimeoutMs, initializationTimeoutMs].every(ms => Number.isFinite(ms) && ms > 0)) {
    throw new TypeError('Invalid task loader configuration.');
  }
  let initializationTail = Promise.resolve(), initializationCount = 0;
  const pinned = url => {
    const info = assetInfo(String(url));
    if (!info || !Number.isSafeInteger(info.bytes) || info.bytes <= 0 || !/^[a-f0-9]{64}$/i.test(info.sha256)) {
      throw new TypeError('Missing pinned asset metadata.');
    }
    const versioned = new URL(String(url));
    versioned.searchParams.set('v', info.sha256.slice(0, 12).toLowerCase());
    return {url: versioned.href, bytes: info.bytes};
  };

  return async function loadTask(taskOptions = {}, {signal: callerSignal, onProgress} = {}) {
    const controller = new AbortController(), signal = controller.signal;
    const abort = reason => { if (!signal.aborted) controller.abort(reason); };
    const onCallerAbort = () => abort(cancelled());
    if (callerSignal?.aborted) throw cancelled();
    callerSignal?.addEventListener('abort', onCallerAbort, {once: true});
    const overallTimer = setTimeoutImpl(() => abort(error('TimeoutError', 'Hand recognition loading exceeded its overall time limit.')), overallTimeoutMs);
    let loaded = 0, total = 0;
    const emit = phase => {
      if (signal.aborted) return;
      // Progress is observational; UI callback errors must not leak native tasks.
      try { onProgress?.({phase, loaded, total}); } catch {}
    };
    const throwIfAborted = () => { if (signal.aborted) throw signal.reason; };

    async function download(asset) {
      let idleTimer, reader;
      const refreshIdle = () => {
        clearTimeoutImpl(idleTimer);
        idleTimer = setTimeoutImpl(() => abort(error('TimeoutError', 'A hand recognition asset stopped downloading.')), idleTimeoutMs);
      };
      const cancelReader = () => { try { Promise.resolve(reader?.cancel(signal.reason)).catch(() => {}); } catch {} };
      refreshIdle();
      signal.addEventListener('abort', cancelReader, {once: true});
      try {
        throwIfAborted();
        const response = await abortable(fetchImpl(asset.url, {signal, credentials: 'same-origin', cache: 'default'}), signal);
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
            bytes.set(value, offset); offset += value.byteLength; loaded += value.byteLength;
            refreshIdle(); emit('download');
          }
        }
        if (offset !== asset.bytes) throw error('AssetSizeError', 'A hand recognition asset was shorter than its pinned decoded size.');
        return bytes;
      } catch (reason) {
        abort(reason);
        throw signal.reason;
      } finally {
        clearTimeoutImpl(idleTimer);
        signal.removeEventListener('abort', cancelReader);
        if (signal.aborted) cancelReader();
        try { reader?.releaseLock(); } catch {}
      }
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
      emit('download'); throwIfAborted();
      const [wasmBytes, modelBytes] = await Promise.all([download(wasm), download(model)]);
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
