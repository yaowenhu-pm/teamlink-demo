// Same-origin, opt-in entry point for the pinned MediaPipe vision runtime.
// Import this module only after the visitor enables the camera experiment.
import { FilesetResolver, HandLandmarker } from './vision_bundle.mjs';
import { createGestureTaskLoader } from '../../gesture-loading.mjs?v=235a9d3bc167';

export { FilesetResolver, HandLandmarker };

export const handVisionAssets = Object.freeze({
  wasmRoot: new URL('./wasm', import.meta.url).href,
  modelAssetPath: new URL('./hand_landmarker.task', import.meta.url).href,
});

// These are the exact unmodified upstream bytes recorded in manifest.json.
const pinnedAssets = new Map([
  ['wasm/vision_wasm_internal.js', 334128, '85c1a342be70427987f900969a5f26e17557351111364e6585e97fb03e93e108'],
  ['wasm/vision_wasm_internal.wasm', 14466654, 'bcc13df22d3d69ec8cbe8e280989356d844ae00f4523eb82072d2484f44134dc'],
  ['wasm/vision_wasm_nosimd_internal.js', 333931, 'e9b2b799e0f1078f5538b300a57835b823742c37e2646308a03f0f25b39fdcdc'],
  ['wasm/vision_wasm_nosimd_internal.wasm', 12915401, 'ed5e5e5812490bd90d6a440290845ff9e4c516f696847a28a0c0e0573470d469'],
  ['hand_landmarker.task', 7819105, 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1'],
].map(([path, bytes, sha256]) => [new URL(path, import.meta.url).href, {bytes, sha256}]));

const loadTask = createGestureTaskLoader({
  persistentCache: true,
  // Keep useModule=false: this pinned copy includes the classic resolver pair.
  resolveFileset: () => FilesetResolver.forVisionTasks(handVisionAssets.wasmRoot),
  modelUrl: handVisionAssets.modelAssetPath,
  assetInfo: url => pinnedAssets.get(url),
  createTask: (fileset, options) => HandLandmarker.createFromOptions(fileset, {
    ...options,
    runningMode: options.runningMode ?? 'VIDEO',
    numHands: options.numHands ?? 1,
    baseOptions: {modelAssetBuffer: options.baseOptions.modelAssetBuffer, delegate: 'CPU'},
  }),
});

/**
 * Opt-in local CPU task; IMAGE and VIDEO options remain supported.
 * loadOptions: {signal, onProgress({phase, loaded, total, cacheLoaded,
 * fetchLoaded, cacheAvailable})}. Decoded byte counts cover the selected WASM
 * and pinned model. fetchLoaded can include browser HTTP-cache bytes; validated
 * CacheStorage hits appear in cacheLoaded during checking-cache. Cache access
 * starts only with this explicit call. No camera is requested here.
 */
export function createHandLandmarker(taskOptions = {}, loadOptions = {}) {
  return loadTask(taskOptions, loadOptions);
}
