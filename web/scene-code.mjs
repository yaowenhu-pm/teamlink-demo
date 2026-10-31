import {createScene, validateScene, updateScene, sceneChanges} from './scene-model.mjs';

export const SCENE_CODE_MAX_BYTES = 32768;
export const SCENE_CODE_FIELDS = Object.freeze(Object.keys(createScene()).filter(key => !['schemaVersion', 'boat'].includes(key)));

// These reference real modules served by the site. Read their actual source text;
// never substitute a handwritten algorithm or execute an excerpt as visitor code.
export const SCENE_LOGIC_SOURCES = Object.freeze([
  Object.freeze({id: 'parameters', label: '真实参数与验证', path: './scene-model.mjs',
    exports: Object.freeze(['SCENE_LIMITS', 'validateScene', 'updateScene']), editable: false}),
  Object.freeze({id: 'motion', label: '太阳与落叶的真实计算', path: './scene-model.mjs',
    exports: Object.freeze(['solarPosition', 'leafPath']), editable: false}),
  Object.freeze({id: 'renderer', label: '真实 SVG 绘制', path: './scene-renderer.mjs',
    exports: Object.freeze(['mountLandscape']), editable: false}),
]);

export class SceneCodeError extends Error {
  constructor(message, code = 'INVALID_SCENE_CODE') { super(message); this.name = 'SceneCodeError'; this.code = code; }
}

/** Editable data, not executable JavaScript; field order follows the scene model. */
export function formatSceneCode(scene) {
  const checked = validateScene(scene);
  return JSON.stringify(Object.fromEntries(SCENE_CODE_FIELDS.map(key => [key, checked[key]])), null, 2);
}

/** A partial JSON object is an exact patch; unspecified fields keep their base value. */
export function parseSceneCode(text, baseScene) {
  if (typeof text !== 'string') throw new SceneCodeError('请输入一个 JSON 对象。');
  if (text.length > SCENE_CODE_MAX_BYTES || new TextEncoder().encode(text).byteLength > SCENE_CODE_MAX_BYTES) {
    throw new SceneCodeError('参数文本过长，请保留明确的场景参数。', 'SCENE_CODE_TOO_LARGE');
  }
  let patch;
  try { patch = JSON.parse(text); } catch {
    throw new SceneCodeError('参数必须是合法 JSON：字段名使用双引号，数值不能写成表达式。');
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || Object.getPrototypeOf(patch) !== Object.prototype) {
    throw new SceneCodeError('参数必须是一个 JSON 对象。');
  }
  let current;
  try { current = validateScene(baseScene); } catch {
    throw new SceneCodeError('当前场景无效，尚未应用参数。', 'INVALID_BASE_SCENE');
  }
  let scene;
  try { scene = updateScene(current, patch); } catch (error) {
    throw new SceneCodeError(error.message);
  }
  // Use validated values, retain exactly the submitted keys, and freeze the result.
  const checkedPatch = Object.freeze(Object.fromEntries(Object.keys(patch).map(key => [key, scene[key]])));
  return Object.freeze({patch: checkedPatch, scene});
}

/** Identical comparison semantics and labels to every other scene view. */
export function sceneCodeDiff(before, after) { return sceneChanges(before, after); }
