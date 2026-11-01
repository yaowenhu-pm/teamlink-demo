import {SCENE_LIMITS, SCENE_LEAF_TRAIL_LIMIT, validateScene, updateScene, sceneChanges,
  moveSceneObject, leafPath} from './scene-model.mjs';
import {drawingPoints} from './motion-model.mjs';

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const round = value => Math.round(value * 1e6) / 1e6;
const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.y)
  && value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1;
const copyPoint = value => Object.freeze({x: value.x, y: value.y});
const OBJECTS = Object.freeze({tree: ['trees', '树'], boat: ['boats', '帆船'],
  mountain: ['mountains', '山峰'], bird: ['birds', '飞鸟']});
const COUNT_FIELDS = Object.freeze(Object.values(OBJECTS).map(([field]) => field));
const OPERATIONS = new Set(['object', 'hour', 'leaf', 'leafOrigin', 'leafTarget',
  'branches', 'flowers', 'wind', 'rain', 'water', 'count']);
const CONTROLS = Object.freeze([
  {id: 'sun', kind: 'sun', label: '太阳 / 月亮', operation: 'hour', instruction: '左右移动，改变时间。'},
  {id: 'leaf', kind: 'leaf', label: '落叶轨迹', operation: 'leaf', instruction: '移动整条落叶轨迹；也可重新手绘路径。'},
  {id: 'leafOrigin', kind: 'leafOrigin', label: '落叶起点', operation: 'leafOrigin', instruction: '移动落叶轨迹的起点。'},
  {id: 'leafTarget', kind: 'leafTarget', label: '落叶终点', operation: 'leafTarget', instruction: '移动落叶轨迹的终点。'},
  {id: 'branches', kind: 'branches', label: '树枝形态', operation: 'branches', requireExplicit: true,
    instruction: '左右改变枝角，上下改变枝树层数。'},
  {id: 'flowers', kind: 'flowers', label: '花朵数量', operation: 'flowers', requireExplicit: true,
    instruction: '左右移动，增减整片花朵。'},
  {id: 'sky', kind: 'environment', label: '天空时间', operation: 'hour', requireExplicit: true,
    instruction: '左右移动，改变天空时间与颜色。'},
  {id: 'water', kind: 'environment', label: '水面色彩', operation: 'water', requireExplicit: true,
    instruction: '左右改变时间与水色，上下改变雨量与水色。'},
  {id: 'wind', kind: 'environment', label: '风力', operation: 'wind', requireExplicit: true,
    instruction: '左右改变风力，影响落叶、云、飞鸟、船与雨的运动。'},
  {id: 'rain', kind: 'environment', label: '雨量', operation: 'rain', requireExplicit: true,
    instruction: '向上增加雨量，向下减少雨量。'},
  {id: 'clouds', kind: 'environment', label: '云层浓淡', operation: 'rain', requireExplicit: true,
    instruction: '向上增加雨量与云层浓度，向下减少。'},
  ...Object.values(OBJECTS).map(([field, label]) => ({id: `count:${field}`, kind: 'count',
    label: `${label}数量`, operation: 'count', field, requireExplicit: true,
    instruction: `左右移动，增减${label}数量。`})),
]);

function boundsOf(value) {
  if (!value || typeof value !== 'object') return null;
  const left = value.left ?? value.x, top = value.top ?? value.y;
  const right = value.right ?? (left + value.width), bottom = value.bottom ?? (top + value.height);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top
    || right <= 0 || bottom <= 0 || left >= 1 || top >= 1) return null;
  return Object.freeze({left: clamp(left), top: clamp(top), right: clamp(right), bottom: clamp(bottom)});
}

function geometryOf(value, fallback, radius) {
  if (value?.visible === false) return null;
  const rawBounds = value?.bounds ?? (value && ('left' in value || 'width' in value) ? value : null);
  const bounds = rawBounds && boundsOf(rawBounds);
  // A supplied invisible or malformed box must not become a made-up hit zone.
  if (rawBounds && !bounds) return null;
  const anchor = point(value?.anchor) ? value.anchor : point(fallback) ? fallback : bounds
    ? {x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2} : null;
  if (!anchor) return null;
  return {anchor: copyPoint(anchor), bounds: bounds || Object.freeze({left: clamp(anchor.x - radius),
    top: clamp(anchor.y - radius), right: clamp(anchor.x + radius), bottom: clamp(anchor.y + radius)})};
}

function frameOf(value, scene) {
  if (value === undefined && scene.leafTrail.length) value = {x: 0, y: 0, scaleX: 1, scaleY: 1};
  if (!value || ![value.x, value.y, value.scaleX, value.scaleY].every(Number.isFinite)
    || value.scaleX <= 0 || value.scaleY <= 0) return null;
  return Object.freeze({x: value.x, y: value.y, scaleX: value.scaleX, scaleY: value.scaleY});
}

/**
 * Pure target inventory. All coordinates use the visible canvas, normalized to
 * 0..1 after SVG slice cropping. Geometry is keyed by target id; each entry is
 * {bounds:{left,top,right,bottom}, anchor?:{x,y}, visible?:boolean}. Objects can
 * use their real renderer anchor when a DOM box is unavailable. Optional control
 * targets require supplied geometry, so this function never invents their location.
 *
 * geometry.leafFrame maps model leaf points to the visible canvas:
 * screen = {x: frame.x + model.x * frame.scaleX, y: frame.y + model.y * frame.scaleY}.
 * It is required for the renderer's default tree-relative trajectory; a saved
 * leafTrail already uses visible-canvas coordinates. Freeze a target with the
 * base scene at grab start, and keep both snapshots throughout the drag.
 */
export function buildGestureTargets(value, objectPositions = [], geometry = {}) {
  const scene = validateScene(value);
  if (!Array.isArray(objectPositions) || !geometry || typeof geometry !== 'object') {
    throw new TypeError('Gesture targets require renderer positions and geometry.');
  }
  const targets = [], seen = new Set();
  for (const object of objectPositions) {
    const match = typeof object?.id === 'string' && object.id.match(/^(tree|boat|mountain|bird):(0|[1-9]\d?)$/u);
    if (!match || seen.has(object.id) || !point(object.point)) continue;
    const [countKey, label] = OBJECTS[match[1]], index = Number(match[2]);
    if (index >= scene[countKey]) continue;
    const actual = geometryOf(geometry[object.id], object.point, .018);
    if (!actual) continue;
    seen.add(object.id);
    targets.push(Object.freeze({id: object.id, kind: match[1], label: `${label} ${index + 1}`,
      operation: 'object', requireExplicit: false, priority: 20, ...actual,
      modelAnchor: copyPoint(object.point), instruction: '捏合移动，松开确认。'}));
  }
  for (const descriptor of CONTROLS) {
    const supplied = geometry[descriptor.id];
    if (!supplied) continue;
    if (['leaf', 'leafOrigin', 'leafTarget', 'branches'].includes(descriptor.id) && !scene.trees) continue;
    const actual = geometryOf(supplied, null, .018);
    if (!actual) continue;
    const isLeaf = ['leaf', 'leafOrigin', 'leafTarget'].includes(descriptor.id);
    const frame = isLeaf && frameOf(supplied.frame ?? geometry.leafFrame, scene);
    if (isLeaf && !frame) continue;
    targets.push(Object.freeze({...descriptor, requireExplicit: Boolean(descriptor.requireExplicit),
      priority: isLeaf ? 40 : descriptor.id === 'sun' ? 30 : 10, ...actual, ...(frame ? {frame} : {})}));
  }
  return Object.freeze(targets);
}

/**
 * Small actual hit boxes win overlapping hits; priority resolves equal areas.
 * Broad environment controls and tree shape are never automatically grabbed.
 * An explicitId means the user deliberately selected that control in the UI;
 * that selected target can then be operated from anywhere on the canvas.
 */
export function hitTestGestureTargets(targets, cursor, {explicitId = null, slop = 0} = {}) {
  if (!Array.isArray(targets) || !point(cursor) || !Number.isFinite(slop) || slop < 0 || slop > .1) return null;
  if (typeof explicitId === 'string') return targets.find(target => target.id === explicitId) ?? null;
  const candidates = targets.filter(target => !target.requireExplicit && target.bounds
    && cursor.x >= target.bounds.left - slop && cursor.x <= target.bounds.right + slop
    && cursor.y >= target.bounds.top - slop && cursor.y <= target.bounds.bottom + slop);
  const area = target => (target.bounds.right - target.bounds.left) * (target.bounds.bottom - target.bounds.top);
  candidates.sort((a, b) => area(a) - area(b) || (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  return candidates[0] ?? null;
}

function checkedPatch(scene, patch) {
  const next = updateScene(scene, patch);
  return Object.freeze(Object.fromEntries(sceneChanges(scene, next).map(change => [change.key, next[change.key]])));
}

function parameter(scene, key, delta) {
  const limit = SCENE_LIMITS[key], value = clamp(scene[key] + delta, limit.min, limit.max);
  return limit.integer ? Math.round(value) : round(value);
}

/**
 * Relative, stateless dragging. Always pass the scene and target captured at
 * grab start, not the previous preview. Even a pinch away from the anchor keeps
 * the original cursor-to-object offset. Every returned patch passes updateScene.
 */
export function applyTargetDrag(value, target, startCursor, currentCursor) {
  const scene = validateScene(value);
  if (!point(startCursor) || !point(currentCursor)) throw new RangeError('Drag cursors must be normalized points.');
  if (!target || !OPERATIONS.has(target.operation)) throw new RangeError('Unknown gesture target.');
  if (target.operation === 'count' && !COUNT_FIELDS.includes(target.field)) throw new RangeError('Unknown object count field.');
  const dx = currentCursor.x - startCursor.x, dy = currentCursor.y - startCursor.y;
  if (dx === 0 && dy === 0) return checkedPatch(scene, {});
  let patch;
  switch (target.operation) {
    case 'object': {
      const anchor = scene.placements.find(item => item.id === target.id) ?? target.modelAnchor;
      if (!point(anchor)) throw new RangeError('A rendered object anchor is required.');
      patch = moveSceneObject(scene, target.id, {x: round(clamp(anchor.x + dx)), y: round(clamp(anchor.y + dy))});
      break;
    }
    case 'hour': patch = {hour: parameter(scene, 'hour', dx * 24)}; break;
    case 'wind': patch = {wind: parameter(scene, 'wind', dx)}; break;
    case 'rain': patch = {rain: parameter(scene, 'rain', -dy)}; break;
    case 'water': patch = {hour: parameter(scene, 'hour', dx * 24), rain: parameter(scene, 'rain', -dy)}; break;
    case 'flowers': patch = {flowers: parameter(scene, 'flowers', dx * 100)}; break;
    case 'count': patch = {[target.field]: parameter(scene, target.field, dx * SCENE_LIMITS[target.field].max)}; break;
    case 'branches': patch = {branchAngle: parameter(scene, 'branchAngle', dx * 75),
      branchDepth: parameter(scene, 'branchDepth', -dy * 7)}; break;
    case 'leafOrigin':
    case 'leafTarget': {
      if (!scene.trees) throw new RangeError('There is no visible falling leaf.');
      const frame = frameOf(target.frame, scene);
      if (!frame) throw new RangeError('A rendered leaf frame is required.');
      const anchor = scene[target.operation];
      patch = {[target.operation]: {x: round(clamp(anchor.x + dx / frame.scaleX)),
        y: round(clamp(anchor.y + dy / frame.scaleY))}};
      break;
    }
    case 'leaf': {
      if (!scene.trees) throw new RangeError('There is no visible falling leaf.');
      const frame = frameOf(target.frame, scene);
      if (!frame) throw new RangeError('A rendered leaf frame is required.');
      // Keep the default path's time parameterization. Converting it to a custom
      // trail would re-sample by arc length and jump the leaf at the same phase.
      // For custom paths, keep the original samples and their relative offsets.
      const path = [...leafPath(scene, {samples: SCENE_LEAF_TRAIL_LIMIT}), ...scene.leafTrail];
      const shiftX = clamp(dx / frame.scaleX, -Math.min(...path.map(p => p.x)), 1 - Math.max(...path.map(p => p.x)));
      const shiftY = clamp(dy / frame.scaleY, -Math.min(...path.map(p => p.y)), 1 - Math.max(...path.map(p => p.y)));
      if (shiftX === 0 && shiftY === 0) return checkedPatch(scene, {});
      const move = p => ({x: round(clamp(p.x + shiftX)), y: round(clamp(p.y + shiftY))});
      patch = {leafOrigin: move(scene.leafOrigin), leafTarget: move(scene.leafTarget),
        ...(scene.leafTrail.length ? {leafTrail: scene.leafTrail.map(move)} : {})};
      break;
    }
  }
  return checkedPatch(scene, patch);
}

/** Hand-drawn paths use visible-canvas coordinates and preserve both endpoints. */
export function drawLeafTrailPatch(value, points) {
  const scene = validateScene(value);
  if (!scene.trees) throw new RangeError('There is no visible falling leaf.');
  if (!Array.isArray(points) || !Array.from(points).every(point)) throw new RangeError('Leaf strokes require normalized points.');
  const trail = drawingPoints(points, SCENE_LEAF_TRAIL_LIMIT);
  if (trail.length < 2) return checkedPatch(scene, {});
  return checkedPatch(scene, {leafTrail: trail, leafOrigin: trail[0], leafTarget: trail.at(-1)});
}
