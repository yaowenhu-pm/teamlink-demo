import test from 'node:test';
import assert from 'node:assert/strict';
import {createScene, updateScene, validateScene, sceneChanges, SCENE_LIMITS} from '../web/scene-model.mjs';
import {captureSceneObject, pasteSceneObject, deleteSceneObject, cutSceneObject, duplicateSceneObjectForEdit} from '../web/gesture-edit.mjs';

const fields = {tree: 'trees', boat: 'boats', mountain: 'mountains', bird: 'birds'};
const sceneOf = patch => updateScene(createScene(), {trees: 3, boats: 3, mountains: 3, birds: 3, ...patch});
const positionsOf = scene => Object.entries(fields).flatMap(([kind, field]) => Array.from({length: scene[field]}, (_, i) => ({
  id: `${kind}:${i}`, kind, point: {x: Math.round((.12 + (i % 12) * .05) * 1e6) / 1e6, y: kind === 'bird' ? .3 : .7},
})));
const placementMap = scene => Object.fromEntries(scene.placements.map(({id, x, y}) => [id, {x, y}]));
const code = expected => error => error.code === expected;

function pinsExisting(before, positions, after, remap = {}) {
  const actual = placementMap(after), saved = placementMap(before);
  for (const item of positions) {
    const id = Object.hasOwn(remap, item.id) ? remap[item.id] : item.id;
    if (id !== null) assert.deepEqual(actual[id], saved[item.id] ?? item.point, item.id);
  }
}

test('copy captures an immutable scene and actual anchor without creating a scene change', () => {
  const scene = sceneOf({seed: 901, branchAngle: 57}), before = structuredClone(scene), positions = positionsOf(scene);
  const clip = captureSceneObject(scene, 'tree:0', positions);
  assert.deepEqual(Object.keys(clip), ['schemaVersion', 'kind', 'sourceId', 'point', 'sourceScene']);
  assert.equal(clip.kind, 'tree'); assert.equal(clip.sourceId, 'tree:0');
  assert.deepEqual(clip.point, positions.find(item => item.id === 'tree:0').point);
  assert.deepEqual(clip.sourceScene, scene); assert.deepEqual(scene, before); assert.deepEqual(sceneChanges(scene, clip.sourceScene), []);
  assert.ok(Object.isFrozen(clip)); assert.ok(Object.isFrozen(clip.point)); assert.ok(Object.isFrozen(clip.sourceScene));
  assert.ok(Object.isFrozen(clip.sourceScene.leafOrigin)); assert.ok(Object.isFrozen(clip.sourceScene.placements));
  positions[0].point.x = .9;
  assert.equal(clip.point.x, .12);
  const edited = updateScene(scene, {seed: 777, branchAngle: 20});
  assert.equal(clip.sourceScene.seed, 901); assert.equal(clip.sourceScene.branchAngle, 57); assert.equal(edited.seed, 777);
});

test('paste pins every existing native anchor and changes only count, placements and the boat compatibility flag', () => {
  for (const [kind, field] of Object.entries(fields)) {
    const scene = sceneOf(), positions = positionsOf(scene), clip = captureSceneObject(scene, `${kind}:1`, positions);
    const result = pasteSceneObject(scene, clip, {x: .81, y: .25}, positions);
    assert.equal(result.id, `${kind}:3`); assert.equal(result.scene[field], 4);
    assert.deepEqual(placementMap(result.scene)[result.id], {x: .81, y: .25});
    pinsExisting(scene, positions, result.scene);
    assert.deepEqual(sceneChanges(scene, result.scene).map(item => item.key).sort(), [field, 'placements'].sort());
    assert.deepEqual(result.clipboard, clip); assert.notEqual(result.scene, scene);
    assert.ok(Object.isFrozen(result)); assert.doesNotThrow(() => validateScene(result.scene));
  }
});

test('an explicit saved placement remains authoritative over a changed renderer position', () => {
  const scene = sceneOf({placements: [{id: 'boat:1', x: .91, y: .82}, {id: 'tree:1', x: .65, y: .71}]}), positions = positionsOf(scene);
  const clip = captureSceneObject(scene, 'boat:1', positions);
  assert.deepEqual(clip.point, {x: .91, y: .82});
  const pasted = pasteSceneObject(scene, clip, {x: .8, y: .6}, positions).scene;
  pinsExisting(scene, positions, pasted);
  assert.deepEqual(placementMap(pasted)['tree:1'], {x: .65, y: .71});
});

test('delete pins survivors and reports exact identity reindexing without moving other kinds', () => {
  for (const kind of Object.keys(fields)) {
    const scene = sceneOf(), positions = positionsOf(scene), original = structuredClone(scene);
    const result = deleteSceneObject(scene, `${kind}:1`, positions);
    assert.equal(result.removedId, `${kind}:1`); assert.equal(result.scene[fields[kind]], 2);
    assert.equal(result.remap[`${kind}:0`], `${kind}:0`);
    assert.equal(result.remap[`${kind}:1`], null);
    assert.equal(result.remap[`${kind}:2`], `${kind}:1`);
    assert.equal(Object.keys(result.remap).length, positions.length);
    pinsExisting(scene, positions, result.scene, result.remap);
    assert.ok(Object.isFrozen(result.remap)); assert.deepEqual(scene, original);
  }
});

test('cut and then paste survives deletion of the original object and retains its appearance recipe', () => {
  const scene = sceneOf({boats: 1, seed: 879, branchAngle: 66}), positions = positionsOf(scene);
  const cut = cutSceneObject(scene, 'boat:0', positions);
  assert.equal(cut.scene.boats, 0); assert.equal(cut.scene.boat, false); assert.equal(cut.remap['boat:0'], null);
  assert.equal(cut.clipboard.sourceScene.boats, 1); assert.equal(cut.clipboard.sourceScene.seed, 879);
  const changed = updateScene(cut.scene, {seed: 42});
  const pasted = pasteSceneObject(changed, cut.clipboard, {x: .77, y: .62});
  assert.equal(pasted.id, 'boat:0'); assert.equal(pasted.scene.boats, 1); assert.equal(pasted.scene.boat, true);
  assert.deepEqual(placementMap(pasted.scene)['boat:0'], {x: .77, y: .62});
  assert.equal(pasted.clipboard.sourceScene.seed, 879); assert.equal(pasted.scene.seed, 42);
  assert.deepEqual(sceneChanges(scene, cut.clipboard.sourceScene), []);
});

test('a copied object can be pasted into a completely empty scene and reused without modifying the clipboard', () => {
  const source = sceneOf(), clip = captureSceneObject(source, 'mountain:2', positionsOf(source)), before = structuredClone(clip);
  const empty = updateScene(createScene(), {trees: 0, boats: 0, mountains: 0, birds: 0});
  const first = pasteSceneObject(empty, clip, {x: 0, y: 1});
  const second = pasteSceneObject(first.scene, clip, {x: 1, y: 0});
  assert.equal(first.id, 'mountain:0'); assert.equal(second.id, 'mountain:1');
  assert.deepEqual(placementMap(second.scene), {'mountain:0': {x: 0, y: 1}, 'mountain:1': {x: 1, y: 0}});
  assert.deepEqual(clip, before);
});

test('duplicate follows the same frozen-anchor contract and has a deterministic bounded offset', () => {
  const scene = sceneOf({placements: [{id: 'tree:0', x: .98, y: .97}]}), positions = positionsOf(scene);
  const result = duplicateSceneObjectForEdit(scene, 'tree:0', positions);
  assert.equal(result.id, 'tree:3'); assert.deepEqual(placementMap(result.scene)[result.id], {x: 1, y: 1});
  pinsExisting(scene, positions, result.scene);
  const elsewhere = duplicateSceneObjectForEdit(scene, 'tree:0', positions, {x: .3, y: .4});
  assert.deepEqual(placementMap(elsewhere.scene)[elsewhere.id], {x: .3, y: .4});
});

test('capacity checks retain the original scene and do not publish a cut clipboard on failure', () => {
  for (const [kind, field] of Object.entries(fields)) {
    const source = sceneOf(), clip = captureSceneObject(source, `${kind}:0`, positionsOf(source));
    const full = sceneOf({[field]: SCENE_LIMITS[field].max}), before = structuredClone(full);
    assert.throws(() => pasteSceneObject(full, clip, {x: .5, y: .5}, positionsOf(full)), code('OBJECT_LIMIT'));
    assert.throws(() => duplicateSceneObjectForEdit(full, `${kind}:0`, positionsOf(full)), code('OBJECT_LIMIT'));
    assert.deepEqual(full, before);
  }
  const scene = sceneOf(), before = structuredClone(scene);
  assert.throws(() => cutSceneObject(scene, 'boat:0', [{id: 'boat:0', point: {x: .2, y: .5}}]), code('EDIT_POSITION_REQUIRED'));
  assert.deepEqual(scene, before);
});

test('missing anchors, stale or duplicate identities and unsupported targets fail instead of inventing positions', () => {
  const scene = sceneOf(), inventory = positionsOf(scene), clip = captureSceneObject(scene, 'boat:0', inventory);
  assert.throws(() => captureSceneObject(scene, 'boat:0'), code('EDIT_POSITION_REQUIRED'));
  assert.throws(() => pasteSceneObject(scene, clip, {x: .5, y: .5}), code('EDIT_POSITION_REQUIRED'));
  assert.throws(() => deleteSceneObject(scene, 'tree:1'), code('EDIT_POSITION_REQUIRED'));
  for (const id of ['sun', 'leaf', 'decor:flower:0', 'boat:99', 'tree:100', 'tree:01', null, '__proto__']) {
    assert.throws(() => captureSceneObject(scene, id, inventory));
    assert.throws(() => deleteSceneObject(scene, id, inventory));
  }
  assert.throws(() => captureSceneObject(scene, 'boat:0', [...inventory, inventory[0]]));
  assert.throws(() => captureSceneObject(scene, 'boat:0', [{id: 'boat:3', point: {x: .5, y: .5}}]));
  assert.throws(() => captureSceneObject(scene, 'boat:0', [{id: 'boat:0', kind: 'bird', point: {x: .5, y: .5}}]));
});

test('malformed and executable-looking clipboard, coordinates and inventories never invoke getters or coercions', () => {
  const scene = sceneOf(), positions = positionsOf(scene), clip = captureSceneObject(scene, 'boat:0', positions);
  for (const invalid of [null, [], {...clip, schemaVersion: 2}, {...clip, kind: 'flower'}, {...clip, sourceId: 'tree:0'},
    {...clip, extra: true}, {...clip, sourceScene: {...scene, boats: 0, boat: false}}, Object.assign(Object.create({}), clip)]) {
    assert.throws(() => pasteSceneObject(scene, invalid, {x: .5, y: .5}, positions));
  }
  for (const invalid of [{x: NaN, y: .5}, {x: .5, y: Infinity}, {x: -1, y: .5}, {x: 1.1, y: .5}, {x: .5, y: .5, z: 0}]) {
    assert.throws(() => pasteSceneObject(scene, clip, invalid, positions));
  }
  let calls = 0;
  const accessor = {...clip}; Object.defineProperty(accessor, 'kind', {enumerable: true, get() {calls++; throw Error('must not run');}});
  assert.throws(() => pasteSceneObject(scene, accessor, {x: .5, y: .5}, positions));
  const coercion = {...clip, kind: {toString() {calls++; throw Error('must not coerce');}}};
  assert.throws(() => pasteSceneObject(scene, coercion, {x: .5, y: .5}, positions));
  const inventory = []; Object.defineProperty(inventory, '0', {enumerable: true, get() {calls++; return positions[0];}});
  assert.throws(() => captureSceneObject(scene, 'boat:0', inventory));
  const coordinate = {y: .5}; Object.defineProperty(coordinate, 'x', {enumerable: true, get() {calls++; return .5;}});
  assert.throws(() => pasteSceneObject(scene, clip, coordinate, positions));
  assert.equal(calls, 0);
});

test('maximum placement scenes remain valid through removal and paste without growing beyond 136 placements', () => {
  const full = updateScene(createScene(), {trees: 100, boats: 8, mountains: 8, birds: 20});
  const positions = positionsOf(full).map((item, i) => ({...item, point: {x: i / 136, y: .7}}));
  const cut = cutSceneObject(full, 'tree:3', positions);
  assert.equal(cut.scene.placements.length, 135);
  const pasted = pasteSceneObject(cut.scene, cut.clipboard, {x: .42, y: .8});
  assert.equal(pasted.scene.placements.length, 136); assert.equal(pasted.scene.trees, 100);
  assert.doesNotThrow(() => validateScene(pasted.scene));
});

test('portrait-cropped pines stay unplaced while a visible boat is pasted, deleted, cut and restored', () => {
  const scene = sceneOf({boats: 1}), positions = positionsOf(scene).map(item => item.id === 'tree:1'
    ? {...item, point: {x: -.35, y: .72}} : item.id === 'tree:2'
      ? {...item, point: {x: 1.45, y: .76}} : item);
  const clip = captureSceneObject(scene, 'boat:0', positions);
  const pasted = pasteSceneObject(scene, clip, {x: .58, y: .68}, positions);
  assert.equal(pasted.id, 'boat:1'); assert.equal(pasted.scene.boats, 2);
  assert.ok(!pasted.scene.placements.some(item => ['tree:1', 'tree:2'].includes(item.id)));
  assert.deepEqual(placementMap(pasted.scene)['boat:0'], {x: .12, y: .7});
  assert.deepEqual(placementMap(pasted.scene)['boat:1'], {x: .58, y: .68});
  const afterPositions = [...positions, {id: 'boat:1', kind: 'boat', point: {x: .58, y: .68}}];
  const deleted = deleteSceneObject(pasted.scene, 'boat:0', afterPositions);
  assert.equal(deleted.scene.boats, 1); assert.equal(deleted.remap['boat:1'], 'boat:0');
  assert.deepEqual(placementMap(deleted.scene)['boat:0'], {x: .58, y: .68});
  assert.ok(!deleted.scene.placements.some(item => ['tree:1', 'tree:2'].includes(item.id)));
  const cut = cutSceneObject(scene, 'boat:0', positions);
  assert.equal(cut.scene.boats, 0);
  const cutPositions = positions.filter(item => item.id !== 'boat:0');
  const restored = pasteSceneObject(cut.scene, cut.clipboard, {x: .7, y: .7}, cutPositions);
  assert.equal(restored.scene.boats, 1);
  assert.ok(!restored.scene.placements.some(item => ['tree:1', 'tree:2'].includes(item.id)));
  for (const id of ['tree:1', 'tree:2']) assert.throws(() => captureSceneObject(scene, id, positions), code('EDIT_POSITION_REQUIRED'));
});

test('cropped anchors cannot become selected copy points, while existing placements still win during count changes', () => {
  const scene = sceneOf({placements: [{id: 'tree:1', x: .4, y: .8}]}), positions = positionsOf(scene)
    .map(item => item.id === 'tree:1' ? {...item, point: {x: -2, y: .9}} : item);
  const clip = captureSceneObject(scene, 'boat:0', positions);
  const pasted = pasteSceneObject(scene, clip, {x: .7, y: .6}, positions);
  assert.deepEqual(placementMap(pasted.scene)['tree:1'], {x: .4, y: .8});
  assert.throws(() => captureSceneObject(scene, 'tree:1', positions), code('EDIT_POSITION_REQUIRED'));
  assert.throws(() => captureSceneObject(scene, 'boat:0', []), code('EDIT_POSITION_REQUIRED'));
  const missing = positions.filter(item => item.id !== 'tree:2');
  assert.throws(() => pasteSceneObject(scene, clip, {x: .7, y: .6}, missing), code('EDIT_POSITION_REQUIRED'));
  const invalid = positions.map(item => item.id === 'tree:2' ? {...item, point: {x: NaN, y: .6}} : item);
  assert.throws(() => pasteSceneObject(scene, clip, {x: .7, y: .6}, invalid), code('INVALID_EDIT_POINT'));
  const invalidInfinite = positions.map(item => item.id === 'tree:2' ? {...item, point: {x: Infinity, y: .6}} : item);
  assert.throws(() => deleteSceneObject(scene, 'boat:0', invalidInfinite), code('INVALID_EDIT_POINT'));
});
