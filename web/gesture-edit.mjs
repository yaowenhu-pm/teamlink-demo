import {SCENE_LIMITS, SceneModelError, validateScene, updateScene, removeSceneObject} from './scene-model.mjs';

const FIELDS = Object.freeze({tree: 'trees', boat: 'boats', mountain: 'mountains', bird: 'birds'});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const round = value => Math.round(value * 1e6) / 1e6;
const clamp = value => Math.max(0, Math.min(1, value));
const fail = (message, code = 'INVALID_EDIT') => {throw new SceneModelError(message, code);};

function record(value, label, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(`${label}必须为普通数据。`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !own(descriptor, 'value')) {
      fail(`${label}含有未知字段或访问器。`);
    }
  }
  if (required.some(key => !own(value, key))) fail(`${label}字段不完整。`);
  return value;
}

function point(value, label = '位置') {
  record(value, label, ['x', 'y']);
  if (![value.x, value.y].every(number => Number.isFinite(number) && number >= 0 && number <= 1)) {
    fail(`${label}须位于画布范围内。`, 'INVALID_EDIT_POINT');
  }
  return Object.freeze({x: round(value.x), y: round(value.y)});
}

function identity(id, scene) {
  const match = typeof id === 'string' && id.match(/^(tree|boat|mountain|bird):(0|[1-9]\d?)$/u);
  if (!match) fail('请选择一棵树、一座山、一艘船或一只鸟。', 'UNSUPPORTED_EDIT_TARGET');
  const kind = match[1], index = Number(match[2]), field = FIELDS[kind];
  if (index >= SCENE_LIMITS[field].max || (scene && index >= scene[field])) {
    fail('这个对象已不存在，请重新选择。', 'INVALID_EDIT_TARGET');
  }
  return {kind, index, field};
}

function nativeIds(scene) {
  return Object.entries(FIELDS).flatMap(([kind, field]) => Array.from({length: scene[field]}, (_, index) => `${kind}:${index}`));
}

const normalized = value => value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1;

function renderedPoint(value) {
  record(value, '渲染对象位置', ['x', 'y']);
  if (![value.x, value.y].every(Number.isFinite)) fail('渲染对象位置须为有限数字。', 'INVALID_EDIT_POINT');
  // Slice cropping can put an unplaced native anchor outside the viewport.
  // Preserve that fact instead of clamping it onto a visible screen edge.
  return Object.freeze({x: value.x, y: value.y});
}

/** Read the renderer inventory without invoking accessors or accepting stale identities. */
function positionMap(value, scene) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 136
    || Reflect.ownKeys(value).length !== value.length + 1) fail('渲染位置必须为完整的数据数组。');
  const map = new Map();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !own(descriptor, 'value')) fail('渲染位置不能包含空项或访问器。');
    const item = record(descriptor.value, '渲染对象', ['id', 'kind', 'point'], ['id', 'point']);
    const itemIdentity = identity(item.id, scene);
    if (own(item, 'kind') && item.kind !== itemIdentity.kind) fail('渲染对象类型与编号不一致。');
    if (map.has(item.id)) fail('渲染位置编号不能重复。');
    map.set(item.id, renderedPoint(item.point));
  }
  return map;
}

function anchor(scene, id, positions) {
  const saved = scene.placements.find(item => item.id === id);
  if (saved) return point({x: saved.x, y: saved.y});
  const rendered = positions.get(id);
  if (!rendered) fail('对象位置尚未准备好，请等风景显示后重试。', 'EDIT_POSITION_REQUIRED');
  if (!normalized(rendered)) fail('请选择画布内可见的对象。', 'EDIT_POSITION_REQUIRED');
  return point(rendered);
}

/** Pin existing anchors before a count change regenerates the renderer layout. */
function frozenPlacements(scene, positions) {
  const result = [];
  for (const id of nativeIds(scene)) {
    const saved = scene.placements.find(item => item.id === id);
    if (saved) {result.push({id, x: saved.x, y: saved.y}); continue;}
    const rendered = positions.get(id);
    if (!rendered) fail('对象位置尚未准备好，请等风景显示后重试。', 'EDIT_POSITION_REQUIRED');
    if (normalized(rendered)) result.push({id, ...point(rendered)});
    // Keep cropped, unplaced native objects unplaced after an edit.
  }
  return result;
}

function clipboardValue(value) {
  record(value, '对象剪贴板', ['schemaVersion', 'kind', 'sourceId', 'point', 'sourceScene']);
  if (value.schemaVersion !== 1 || typeof value.kind !== 'string' || !own(FIELDS, value.kind)) fail('对象剪贴板版本或类型无效。', 'INVALID_EDIT_CLIPBOARD');
  const sourceScene = validateScene(value.sourceScene), source = identity(value.sourceId, sourceScene);
  if (source.kind !== value.kind) fail('对象剪贴板类型不一致。', 'INVALID_EDIT_CLIPBOARD');
  return Object.freeze({schemaVersion: 1, kind: source.kind, sourceId: value.sourceId,
    point: point(value.point, '复制位置'), sourceScene});
}

/**
 * Copy a native object into the lab's internal clipboard. No system clipboard,
 * DOM, scene mutation, history entry, or network access is involved. sourceScene
 * and sourceId are a frozen appearance recipe even after the original is cut.
 */
export function captureSceneObject(value, id, rendererPositions = []) {
  const scene = validateScene(value), object = identity(id, scene), positions = positionMap(rendererPositions, scene);
  const rendered = positions.get(id);
  if (!rendered || !normalized(rendered)) fail('请选择画布内可见的对象。', 'EDIT_POSITION_REQUIRED');
  return Object.freeze({schemaVersion: 1, kind: object.kind, sourceId: id,
    point: anchor(scene, id, positions), sourceScene: scene});
}

/**
 * Paste at an explicit visible-canvas anchor. All existing native anchors are
 * pinned before changing the count; this prevents unrelated visible objects jumping
 * to the renderer's new automatic layout. Cropped unplaced anchors remain unplaced,
 * rather than being clamped into view. The source may already have been deleted.
 */
export function pasteSceneObject(value, clipboard, destination, rendererPositions = []) {
  const scene = validateScene(value), copied = clipboardValue(clipboard), field = FIELDS[copied.kind];
  if (scene[field] >= SCENE_LIMITS[field].max) fail('这一类对象已达到数量上限，请先删除一个。', 'OBJECT_LIMIT');
  const location = point(destination, '粘贴位置'), positions = positionMap(rendererPositions, scene);
  const id = `${copied.kind}:${scene[field]}`;
  const next = updateScene(scene, {[field]: scene[field] + 1,
    placements: [...frozenPlacements(scene, positions), {id, ...location}]});
  return Object.freeze({scene: next, id, clipboard: copied});
}

/** Delete and report every old identity, so selection and appearance maps can follow reindexing. */
export function deleteSceneObject(value, id, rendererPositions = []) {
  const scene = validateScene(value), deleted = identity(id, scene), positions = positionMap(rendererPositions, scene);
  const pinned = updateScene(scene, {placements: frozenPlacements(scene, positions)});
  const next = updateScene(pinned, removeSceneObject(pinned, id));
  const remap = Object.freeze(Object.fromEntries(nativeIds(scene).map(originalId => {
    const original = identity(originalId, scene);
    return [originalId, originalId === id ? null : original.kind === deleted.kind && original.index > deleted.index
      ? `${original.kind}:${original.index - 1}` : originalId];
  })));
  return Object.freeze({scene: next, removedId: id, remap});
}

/** Cut is one atomic pure result: a failed delete never publishes a new clipboard or scene. */
export function cutSceneObject(value, id, rendererPositions = []) {
  const clipboard = captureSceneObject(value, id, rendererPositions);
  const deleted = deleteSceneObject(value, id, rendererPositions);
  return Object.freeze({...deleted, clipboard});
}

/** Duplicate beside the source, or at a caller-provided anchor, using the same paste contract. */
export function duplicateSceneObjectForEdit(value, id, rendererPositions = [], destination) {
  const clipboard = captureSceneObject(value, id, rendererPositions);
  const location = destination ?? {x: clamp(clipboard.point.x + .06), y: clamp(clipboard.point.y + .06)};
  return pasteSceneObject(value, clipboard, location, rendererPositions);
}
