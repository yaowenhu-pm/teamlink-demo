// Same-origin, opt-in entry point for the pinned MediaPipe vision runtime.
// Import this module only after the visitor enables the camera experiment.
import { FilesetResolver, HandLandmarker } from './vision_bundle.mjs';

export { FilesetResolver, HandLandmarker };

export const handVisionAssets = Object.freeze({
  wasmRoot: new URL('./wasm', import.meta.url).href,
  modelAssetPath: new URL('./hand_landmarker.task', import.meta.url).href,
});

/** Create the local CPU task. This function never requests a camera stream. */
export async function createHandLandmarker(options = {}) {
  // The default non-module resolver selects the SIMD or no-SIMD pair vendored
  // beside this entry point. Do not pass useModule=true without its extra pair.
  const fileset = await FilesetResolver.forVisionTasks(handVisionAssets.wasmRoot);
  return HandLandmarker.createFromOptions(fileset, {
    ...options,
    runningMode: options.runningMode ?? 'VIDEO',
    numHands: options.numHands ?? 1,
    baseOptions: {
      modelAssetPath: handVisionAssets.modelAssetPath,
      delegate: 'CPU',
    },
  });
}
