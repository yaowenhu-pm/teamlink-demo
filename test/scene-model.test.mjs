import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneModelError, SCENE_LIMITS, createScene, validateScene, updateScene,
  sceneChanges, interpretInstruction, solarPosition, leafPath, moveSceneObject, duplicateSceneObject,
  removeSceneObject, SCENE_PLACEMENT_LIMIT, SCENE_LEAF_TRAIL_LIMIT } from '../web/scene-model.mjs';

const defaults = { schemaVersion: 1, seed: 72, hour: 18.3, trees: 40, rain: 0,
  wind: 0.3, branchAngle: 32, branchDepth: 5, boats: 1, mountains: 2, boat: true, flowers: 30,
  birds: 3, placements: [], leafOrigin: {x: 0.32, y: 0.24}, leafTarget: {x: 0.7, y: 0.94}, leafTrail: [] };
const apply = (text, scene = createScene()) => {
  const parsed = interpretInstruction(text, scene);
  assert.equal(parsed.supported, true, `${text}: ${parsed.reply}`);
  return updateScene(scene, parsed.patch);
};

test('defaults and every model result are immutable independent snapshots', () => {
  const original = createScene(), copy = validateScene(original);
  assert.deepEqual(original, defaults);
  assert.notEqual(original, copy);
  assert.equal(Object.isFrozen(original), true);
  assert.equal(Object.isFrozen(copy), true);
  const changed = updateScene(original, { hour: 12, wind: 0.9 });
  assert.equal(Object.isFrozen(changed), true);
  assert.equal(original.hour, 18.3);
  assert.equal(original.wind, 0.3);
  assert.equal(changed.trees, original.trees);
  assert.throws(() => { original.hour = 1; }, TypeError);
  const changes = sceneChanges(original, changed);
  assert.deepEqual(changes, [
    { key: 'hour', label: '时间', before: 18.3, after: 12 },
    { key: 'wind', label: '风力', before: 0.3, after: 0.9 },
  ]);
  assert.ok(Object.isFrozen(changes) && changes.every(Object.isFrozen));
});

test('strict scene and patch validation reject missing/extra/type/finite/bounds violations', () => {
  const scene = createScene();
  const invalidScenes = [null, [], 'scene', {}, { ...scene, extra: 1 }, { ...scene, schemaVersion: 2 },
    { ...scene, hour: '12' }, { ...scene, wind: Infinity }, { ...scene, rain: NaN },
    { ...scene, trees: 1.5 }, { ...scene, flowers: -1 }, { ...scene, branchDepth: 0 },
    { ...scene, branchAngle: 81 }, { ...scene, boat: 1 }, { ...scene, seed: 4294967296 },
    { ...scene, boats: 9 }, { ...scene, mountains: -1 }, { ...scene, boats: 0 }, { ...scene, boat: false }];
  const missing = { ...scene }; delete missing.hour; invalidScenes.push(missing);
  const hiddenExtra = { ...scene }; Object.defineProperty(hiddenExtra, 'extra', { value: 1 }); invalidScenes.push(hiddenExtra);
  const symbolExtra = { ...scene, [Symbol('extra')]: 1 }; invalidScenes.push(symbolExtra);
  for (const value of invalidScenes) assert.throws(() => validateScene(value), SceneModelError);
  for (const patch of [null, [], { unknown: 1 }, { schemaVersion: 1 }, { hour: undefined }, { seed: -1 },
    { hour: -0.1 }, { hour: 24.1 }, { trees: 101 }, { flowers: 2.5 }, { wind: -0.1 }, { rain: 1.1 },
    { branchDepth: 8.1 }, { branchAngle: 4 }, { boat: 'false' }, { boats: 1.5 }, { boats: 9 },
    { mountains: -1 }, { mountains: '2' }, { boat: true, boats: 0 }, { boat: false, boats: 1 }]) {
    assert.throws(() => updateScene(scene, patch), SceneModelError);
  }
  const hiddenPatch = {}; Object.defineProperty(hiddenPatch, 'unknown', { value: 1 });
  assert.throws(() => updateScene(scene, hiddenPatch), SceneModelError);
  const hiddenValue = {}; Object.defineProperty(hiddenValue, 'wind', { value: 1 });
  assert.throws(() => updateScene(scene, hiddenValue), SceneModelError);
  assert.deepEqual(updateScene(scene, {}), scene);
});

test('untrusted records cannot invoke getters or inject prototypes', () => {
  let getterRan = false;
  const scene = createScene(), patch = {};
  Object.defineProperty(patch, 'wind', { enumerable: true, get() { getterRan = true; return 1; } });
  assert.throws(() => updateScene(scene, patch), SceneModelError);
  assert.equal(getterRan, false);
  assert.throws(() => updateScene(scene, JSON.parse('{"__proto__":{"polluted":true}}')), SceneModelError);
  assert.throws(() => validateScene(Object.assign(Object.create({ hidden: 1 }), scene)), SceneModelError);
  assert.equal({}.polluted, undefined);
});

test('all numeric boundaries are explicit and valid at both ends', () => {
  for (const [key, limit] of Object.entries(SCENE_LIMITS)) {
    assert.equal(updateScene(createScene(), { [key]: limit.min })[key], limit.min);
    assert.equal(updateScene(createScene(), { [key]: limit.max })[key], limit.max);
  }
});

test('Chinese compound instructions apply the actual combined patch atomically', () => {
  const original = createScene();
  const parsed = interpretInstruction('请把天空改成夜晚，树多一点，花少一点；下小雨，然后风大一点，隐藏帆船。', original);
  assert.equal(parsed.supported, true);
  assert.deepEqual(parsed.patch, { hour: 22, trees: 50, rain: 0.25, wind: 0.5, boats: 0, flowers: 20 });
  const result = updateScene(original, parsed.patch);
  assert.deepEqual(parsed.changes, sceneChanges(original, result));
  assert.match(parsed.reply, /本地调景规则已执行/);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.patch) && Object.isFrozen(parsed.changes));
  assert.deepEqual(original, defaults);
});

test('English rules support the same finite vocabulary and sequential relative actions', () => {
  const result = apply('make it night and more trees and more trees, fewer flowers; heavy rain then stronger wind and hide the boat');
  assert.equal(result.hour, 22); assert.equal(result.trees, 60); assert.equal(result.flowers, 20);
  assert.equal(result.rain, 0.85); assert.equal(result.wind, 0.5); assert.equal(result.boat, false);
  const numeric = apply('set trees to 65 and set flowers to 80 and branch angle to 45 and branch depth to 6 and rain to 70% and wind to 0.8 and show the boat');
  assert.equal(numeric.trees, 65); assert.equal(numeric.flowers, 80); assert.equal(numeric.branchAngle, 45);
  assert.equal(numeric.branchDepth, 6); assert.equal(numeric.rain, 0.7); assert.equal(numeric.wind, 0.8);
  const sentences = apply('make it night. wind to 0.8 and then more trees.');
  assert.equal(sentences.hour, 22); assert.equal(sentences.wind, 0.8); assert.equal(sentences.trees, 50);
});

test('period, solar height, branch shape, counts, rain, wind and boat rules are concrete', () => {
  const cases = [
    ['日出', 'hour', 6.3], ['中午', 'hour', 12], ['傍晚', 'hour', 18.3], ['午夜', 'hour', 0],
    ['时间调到15.5点', 'hour', 15.5], ['太阳高一点', 'hour', 17.6], ['太阳低一点', 'hour', 19],
    ['树六十棵', 'trees', 60], ['二十五棵树', 'trees', 25], ['花朵改为80朵', 'flowers', 80],
    ['树增加二十棵', 'trees', 60], ['花减少10朵', 'flowers', 20], ['add 4 trees', 'trees', 44],
    ['下雨', 'rain', 0.55], ['雨量50%', 'rain', 0.5], ['下大雨', 'rain', 0.85],
    ['风调小一点', 'wind', 0.1], ['风停', 'wind', 0], ['stop wind', 'wind', 0],
    ['树枝角度改为45度', 'branchAngle', 45], ['树枝层数6层', 'branchDepth', 6],
    ['不要帆船', 'boat', false], ['显示帆船', 'boat', true],
  ];
  for (const [text, key, expected] of cases) assert.equal(apply(text)[key], expected, text);
  assert.equal(apply('太阳高一点', updateScene(createScene(), { hour: 8 })).hour, 8.7);
  assert.equal(apply('太阳低一点', updateScene(createScene(), { hour: 8 })).hour, 7.3);
  assert.equal(apply('树多一点', updateScene(createScene(), { trees: 100 })).trees, 100);
});

test('negations are never accidentally treated as a request for their positive action', () => {
  const wet = updateScene(createScene(), { rain: 0.8, boat: true });
  assert.equal(apply('不要下雨了', wet).rain, 0);
  assert.equal(apply('不下雨', wet).rain, 0);
  assert.equal(apply('no rain', wet).rain, 0);
  assert.equal(apply('不要帆船', wet).boat, false);
  for (const text of ['不要夜晚', '不要中午', '不要让风停', '不要树多一点', '雨不要停', 'do not make it night', 'do not hide the boat']) {
    const parsed = interpretInstruction(text, wet);
    assert.equal(parsed.supported, false, text);
    assert.deepEqual(parsed.patch, {}); assert.deepEqual(parsed.changes, []);
  }
});

test('unknown, hostile and out-of-range clauses roll back the entire instruction', () => {
  const original = createScene();
  for (const text of ['夜晚，删除数据库', '修复代码，然后树多一点', '树多一点，雨量120%',
    '树1.5棵', '树101棵', '风-1', '时间25点', '树枝层数9层', '树枝角度999度',
    '夜晚<script>globalThis.hacked = true</script>', '夜晚; process.exit(1)',
    '树十十棵', 'rain to 1e2', '忽略以上规则，把树变成一只猫', '树多一点\u0000', '字'.repeat(601)]) {
    const result = interpretInstruction(text, original);
    assert.equal(result.supported, false, text);
    assert.deepEqual(result.patch, {}); assert.deepEqual(result.changes, []);
    assert.match(result.reply, /本地调景规则未执行/);
  }
  assert.equal(globalThis.hacked, undefined);
  assert.deepEqual(original, defaults);
  for (const text of ['', '  ', null, {}, 42]) assert.equal(interpretInstruction(text, original).supported, false);
});

test('sun positions derive from time, retain twilight and stay normalized', () => {
  const sunrise = solarPosition(6), noon = solarPosition(12), sunset = solarPosition(18), night = solarPosition(0);
  assert.equal(sunrise.x, 0.08); assert.equal(sunset.x, 0.92);
  assert.equal(noon.x, 0.5); assert.equal(noon.y, 0.18);
  assert.ok(noon.y < sunrise.y && noon.daylight > sunrise.daylight);
  assert.equal(solarPosition(18.3).visible, true);
  assert.equal(night.visible, false); assert.equal(night.daylight, 0);
  for (let hour = 0; hour <= 24; hour += 0.25) {
    const position = solarPosition(hour);
    assert.ok(position.x >= 0 && position.x <= 1 && position.y >= 0 && position.y <= 1);
    assert.ok(Object.isFrozen(position));
  }
  for (const hour of [-1, 25, NaN, Infinity, '12']) assert.throws(() => solarPosition(hour), SceneModelError);
});

test('leaf time is deterministic, wind changes trajectory and rain changes progress', () => {
  const scene = createScene(), original = leafPath(scene);
  assert.deepEqual(leafPath(scene), original);
  assert.equal(original.length, 31); assert.equal(original[0].t, 0); assert.equal(original.at(-1).t, 1);
  assert.equal(original[0].y, 0.24); assert.equal(original.at(-1).y, 0.94);
  assert.ok(Object.isFrozen(original) && original.every(Object.isFrozen));
  assert.ok(original.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
  const wind = leafPath(updateScene(scene, { wind: 1 }));
  assert.equal(wind[0].x, original[0].x);
  assert.notEqual(wind[15].x, original[15].x);
  assert.notEqual(wind[15].rotation, original[15].rotation);
  assert.equal(wind[15].y, original[15].y);
  const rain = leafPath(updateScene(scene, { rain: 1 }));
  assert.equal(rain[15].x, original[15].x);
  assert.ok(rain[15].y > original[15].y);
  assert.notEqual(leafPath(updateScene(scene, { seed: 73 }))[15].x, original[15].x);
  assert.deepEqual(leafPath(scene, { samples: 61 })[30], original[15], 'same time produces the same state at a different sampling density');
  for (const samples of [0, 1, 242, 2.5, NaN, '31']) assert.throws(() => leafPath(scene, { samples }), SceneModelError);
});

test('legacy scenes normalize only known added fields without mutating old snapshots', () => {
  const legacy = { ...createScene() };
  for (const key of ['boats', 'mountains', 'birds', 'placements', 'leafOrigin', 'leafTarget', 'leafTrail']) delete legacy[key];
  const original = JSON.stringify(legacy), normalized = validateScene(legacy);
  assert.equal(normalized.boats, 1); assert.equal(normalized.mountains, 2); assert.equal(normalized.boat, true);
  assert.equal(normalized.birds, 3); assert.deepEqual(normalized.placements, []);
  assert.deepEqual(normalized.leafOrigin, defaults.leafOrigin); assert.deepEqual(normalized.leafTarget, defaults.leafTarget);
  assert.deepEqual(normalized.leafTrail, []);
  assert.equal(Object.isFrozen(normalized), true); assert.equal(JSON.stringify(legacy), original);
  const hiddenBoat = validateScene({ ...legacy, boat: false });
  assert.equal(hiddenBoat.boats, 0); assert.equal(hiddenBoat.boat, false);
  assert.deepEqual(sceneChanges(legacy, normalized), []);
  const partialLegacy = { ...normalized }; delete partialLegacy.mountains;
  assert.equal(validateScene(partialLegacy).mountains, 2);
  const missingRequired = { ...legacy }; delete missingRequired.boat;
  assert.throws(() => validateScene(missingRequired), SceneModelError);
});

test('placements and leaf points are deeply immutable, canonical and compared by value', () => {
  const raw = [{id: 'bird:1', x: 0.12345678912345, y: 0.812345678912}, {id: 'boat:0', x: 0.4, y: 0.6}];
  const scene = updateScene(createScene(), {placements: raw, leafOrigin: {x: 0.111111111, y: 0.222222222}});
  assert.deepEqual(scene.placements, [{id: 'boat:0', x: 0.4, y: 0.6}, {id: 'bird:1', x: 0.123457, y: 0.812346}]);
  assert.deepEqual(scene.leafOrigin, {x: 0.111111, y: 0.222222});
  assert.ok(Object.isFrozen(scene.placements) && scene.placements.every(Object.isFrozen));
  assert.ok(Object.isFrozen(scene.leafOrigin) && Object.isFrozen(scene.leafTarget));
  raw[0].x = 0.9; assert.equal(scene.placements[1].x, 0.123457);
  assert.deepEqual(sceneChanges(scene, validateScene(scene)), []);
  assert.deepEqual(sceneChanges(scene, updateScene(scene, {})), []);
  assert.deepEqual(sceneChanges(scene, updateScene(scene, {placements: [...scene.placements].reverse(), leafTarget: {...scene.leafTarget}})), []);
});

test('placements reject duplicate/out-of-count IDs, invalid nested types and accessor or array payloads', () => {
  const base = createScene(), valid = {id: 'boat:0', x: 0.2, y: 0.6};
  const cases = [null, {}, [valid, valid], [{...valid, id: 'boat:1'}], [{...valid, id: 'boat:8'}],
    [{...valid, id: 'tree:40'}], [{...valid, id: 'bird:3'}], [{...valid, id: 'bird:20'}],
    [{...valid, id: 'mountain:2'}], [{...valid, id: 'boat:00'}], [{...valid, id: '__proto__'}],
    [{...valid, x: Infinity}], [{...valid, y: -0.1}], [{...valid, x: '0.2'}], [{...valid, extra: true}],
    Array(2), Array.from({length: 137}, () => valid)];
  let accessed = false;
  const getterItem = {...valid}; Object.defineProperty(getterItem, 'x', {enumerable: true, get() { accessed = true; return 0.2; }}); cases.push([getterItem]);
  const getterArray = [valid]; Object.defineProperty(getterArray, '0', {enumerable: true, get() { accessed = true; return valid; }}); cases.push(getterArray);
  const extraArray = [valid]; extraArray.extra = true; cases.push(extraArray);
  for (const placements of cases) assert.throws(() => updateScene(base, {placements}), SceneModelError);
  for (const key of ['leafOrigin', 'leafTarget']) {
    for (const point of [null, [], {x: 0.2}, {x: 0.2, y: 1.1}, {x: NaN, y: 0.3}, {x: true, y: 0.3}, {x: 0.2, y: 0.3, extra: 1}]) {
      assert.throws(() => updateScene(base, {[key]: point}), SceneModelError);
    }
    const point = {y: 0.3}; Object.defineProperty(point, 'x', {enumerable: true, get() { accessed = true; return 0.2; }});
    assert.throws(() => updateScene(base, {[key]: point}), SceneModelError);
  }
  assert.equal(accessed, false); assert.deepEqual(base.placements, []);
});

test('counts prune only previously valid placements and explicit invalid placements still reject', () => {
  const placed = updateScene(createScene(), {boats: 3, placements: [
    {id: 'boat:0', x: 0.2, y: 0.7}, {id: 'boat:2', x: 0.6, y: 0.7},
    {id: 'tree:39', x: 0.1, y: 0.4}, {id: 'bird:2', x: 0.5, y: 0.2},
  ]});
  const fewer = updateScene(placed, {boats: 1, trees: 0, birds: 2});
  assert.deepEqual(fewer.placements, [{id: 'boat:0', x: 0.2, y: 0.7}]);
  assert.equal(placed.placements.length, 4);
  assert.throws(() => updateScene(placed, {boats: 1, placements: placed.placements}), SceneModelError);
  assert.deepEqual(updateScene(placed, {boat: false}).placements.map(item => item.id), ['tree:39', 'bird:2']);
});

test('moving, duplicating and deleting instances produce exact patches and preserve surviving placements', () => {
  const base = createScene(), move = moveSceneObject(base, 'boat:0', {x: 0.4, y: 0.7});
  assert.ok(Object.isFrozen(move) && Object.isFrozen(move.placements));
  const moved = updateScene(base, move), duplicated = updateScene(moved, duplicateSceneObject(moved, 'boat:0'));
  assert.equal(duplicated.boats, 2); assert.equal(duplicated.boat, true);
  assert.deepEqual(duplicated.placements, [{id: 'boat:0', x: 0.4, y: 0.7}, {id: 'boat:1', x: 0.46, y: 0.76}]);
  const removed = updateScene(duplicated, removeSceneObject(duplicated, 'boat:0'));
  assert.equal(removed.boats, 1); assert.deepEqual(removed.placements, [{id: 'boat:0', x: 0.46, y: 0.76}]);
  const empty = updateScene(removed, removeSceneObject(removed, 'boat:0'));
  assert.equal(empty.boats, 0); assert.equal(empty.boat, false); assert.deepEqual(empty.placements, []);
  const fromRenderer = updateScene(base, duplicateSceneObject(base, 'boat:0', {x: 0.98, y: 0.99}));
  assert.deepEqual(fromRenderer.placements, [{id: 'boat:0', x: 0.98, y: 0.99}, {id: 'boat:1', x: 1, y: 1}]);
  for (const [kind, countKey] of [['tree', 'trees'], ['mountain', 'mountains'], ['bird', 'birds']]) {
    const copy = updateScene(base, duplicateSceneObject(base, `${kind}:0`, {x: 0.2, y: 0.3}));
    assert.equal(copy[countKey], base[countKey] + 1);
    const gone = updateScene(copy, removeSceneObject(copy, `${kind}:0`));
    assert.equal(gone[countKey], base[countKey]);
    assert.deepEqual(gone.placements, [{id: `${kind}:${base[countKey] - 1}`, x: 0.26, y: 0.36}]);
  }
  assert.throws(() => duplicateSceneObject(base, 'boat:0'), error => error.code === 'OBJECT_POSITION_REQUIRED');
  assert.throws(() => duplicateSceneObject(updateScene(base, {boats: 8}), 'boat:0', {x: 0.2, y: 0.7}), error => error.code === 'OBJECT_LIMIT');
  assert.throws(() => moveSceneObject(base, 'boat:1', {x: 0.2, y: 0.7}), SceneModelError);
  assert.throws(() => removeSceneObject(base, 'bird:3'), SceneModelError);
});

test('leaf endpoints directly determine every path with stable seed, time and weather causality', () => {
  const base = updateScene(createScene(), {leafOrigin: {x: 0.1, y: 0.2}, leafTarget: {x: 0.9, y: 0.8}});
  const path = leafPath(base), windy = leafPath(updateScene(base, {wind: 1})), rainy = leafPath(updateScene(base, {rain: 1}));
  for (const value of [path, windy, rainy]) {
    assert.deepEqual({x: value[0].x, y: value[0].y}, base.leafOrigin);
    assert.deepEqual({x: value.at(-1).x, y: value.at(-1).y}, base.leafTarget);
  }
  assert.notEqual(path[15].x, windy[15].x); assert.ok(rainy[15].y > path[15].y);
  assert.deepEqual(path, leafPath(validateScene(base)));
  assert.deepEqual(path[15], leafPath(base, {samples: 61})[30]);
  assert.notEqual(path[15].x, leafPath(updateScene(base, {leafTarget: {x: 0.4, y: 0.8}}))[15].x);
});

test('136 placements and 40 trail points fit the unchanged 8KB room request bound', () => {
  const placements = [];
  for (const [kind, count] of [['tree', 100], ['boat', 8], ['mountain', 8], ['bird', 20]]) {
    for (let index = 0; index < count; index++) placements.push({id: `${kind}:${index}`, x: 0.12345678912345678, y: 0.9876543219876543});
  }
  assert.equal(placements.length, SCENE_PLACEMENT_LIMIT);
  const leafTrail = Array.from({length: SCENE_LEAF_TRAIL_LIMIT}, () => ({x: 0.123456789, y: 0.987654321}));
  const scene = updateScene(createScene(), {trees: 100, boats: 8, mountains: 8, birds: 20, placements, leafTrail});
  assert.equal(scene.placements[0].x, 0.123457); assert.equal(scene.placements[0].y, 0.987654);
  assert.equal(scene.leafTrail.length, 40); assert.deepEqual(scene.leafTrail[0], {x: 0.1235, y: 0.9877});
  const creation = JSON.stringify({scene}), patch = {...scene}; delete patch.schemaVersion;
  const operation = JSON.stringify({nonce: 'n'.repeat(80), expectedRevision: Number.MAX_SAFE_INTEGER, patch});
  assert.ok(new TextEncoder().encode(creation).byteLength < 8192);
  assert.ok(new TextEncoder().encode(operation).byteLength < 8192);
});

test('custom trail validation is strict, round4, deeply immutable and compatible with old scenes', () => {
  const base = createScene(), raw = [{x: 0.12344999, y: 0.987654321}, {x: 1, y: 0}];
  const scene = updateScene(base, {leafTrail: raw});
  assert.deepEqual(scene.leafTrail, [{x: 0.1234, y: 0.9877}, {x: 1, y: 0}]);
  assert.ok(Object.isFrozen(scene.leafTrail) && scene.leafTrail.every(Object.isFrozen));
  raw[0].x = 0.8; assert.equal(scene.leafTrail[0].x, 0.1234);
  assert.deepEqual(sceneChanges(scene, updateScene(scene, {leafTrail: scene.leafTrail.map(point => ({...point}))})), []);
  assert.deepEqual(sceneChanges(base, scene).map(item => item.key), ['leafTrail']);
  const legacy = {...base}; delete legacy.leafTrail;
  assert.deepEqual(validateScene(legacy).leafTrail, []); assert.deepEqual(sceneChanges(legacy, base), []);
  assert.equal(updateScene(scene, {leafTrail: []}).leafTrail.length, 0);
  assert.equal(updateScene(base, {leafTrail: Array.from({length: 40}, () => ({x: 0.2, y: 0.3}))}).leafTrail.length, 40);
});

test('custom trails reject malicious shapes, sparse arrays and accessors before reading their values', () => {
  const base = createScene(), point = {x: 0.2, y: 0.3}; let accessed = false;
  const invalid = [null, {}, [point], Array(2), Array.from({length: 41}, () => point),
    [point, null], [point, []], [point, {x: 0.2}], [point, {x: 0.2, y: 0.3, code: 'execute'}],
    [point, {x: Infinity, y: 0.3}], [point, {x: NaN, y: 0.3}], [point, {x: -0.1, y: 0.3}],
    [point, {x: 1.1, y: 0.3}], [point, {x: '0.2', y: 0.3}], [point, {x: 0.2, y: false}],
    [point, Object.assign(Object.create({secret: true}), point)]];
  const extra = [point, point]; extra.extra = true; invalid.push(extra);
  const symbolic = [point, point]; symbolic[Symbol('extra')] = true; invalid.push(symbolic);
  const derived = [point, point]; Object.setPrototypeOf(derived, Object.create(Array.prototype)); invalid.push(derived);
  const arrayGetter = [point, point]; Object.defineProperty(arrayGetter, '0', {enumerable: true, get() { accessed = true; return point; }}); invalid.push(arrayGetter);
  const pointGetter = {y: 0.3}; Object.defineProperty(pointGetter, 'x', {enumerable: true, get() { accessed = true; return 0.2; }}); invalid.push([point, pointGetter]);
  const hidden = {y: 0.3}; Object.defineProperty(hidden, 'x', {value: 0.2}); invalid.push([point, hidden]);
  for (const leafTrail of invalid) assert.throws(() => updateScene(base, {leafTrail}), SceneModelError);
  assert.equal(accessed, false); assert.deepEqual(base.leafTrail, []);
});

test('custom paths sample by arc length instead of input index, with repeated points safely skipped', () => {
  for (const leafTrail of [[{x: 0.1, y: 0.2}, {x: 0.2, y: 0.2}, {x: 0.9, y: 0.2}],
    [{x: 0.1, y: 0.2}, {x: 0.1, y: 0.2}, {x: 0.9, y: 0.2}]]) {
    const scene = updateScene(createScene(), {leafTrail, leafOrigin: leafTrail[0], leafTarget: leafTrail.at(-1)});
    assert.deepEqual(leafPath(scene, {samples: 5}).map(({x, y}) => ({x, y})), [
      {x: 0.1, y: 0.2}, {x: 0.3, y: 0.2}, {x: 0.5, y: 0.2}, {x: 0.7, y: 0.2}, {x: 0.9, y: 0.2},
    ]);
  }
  const point = {x: 0.4, y: 0.3};
  const still = updateScene(createScene(), {leafTrail: [point, point], leafOrigin: point, leafTarget: point});
  assert.ok(leafPath(still).every(({x, y}) => x === 0.4 && y === 0.3));
});

test('custom trails preserve closed loops and reverse motion without weather or seed reshaping them', () => {
  const leafTrail = [{x: 0.1, y: 0.1}, {x: 0.7, y: 0.1}, {x: 0.7, y: 0.7}, {x: 0.1, y: 0.7}, {x: 0.1, y: 0.1}];
  const scene = updateScene(createScene(), {leafTrail, leafOrigin: leafTrail[0], leafTarget: leafTrail.at(-1)});
  assert.deepEqual(leafPath(scene, {samples: 5}).map(({x, y}) => ({x, y})), leafTrail);
  const original = leafPath(scene), xy = path => path.map(({x, y}) => ({x, y}));
  for (const patch of [{wind: 0}, {wind: 1, rain: 1}, {seed: 10000}]) assert.deepEqual(xy(leafPath(updateScene(scene, patch))), xy(original));
  assert.notEqual(leafPath(updateScene(scene, {wind: 1, rain: 1}))[15].rotation, original[15].rotation);
  assert.deepEqual(leafPath(scene, {samples: 61})[30], original[15]);
  assert.ok(original.some((point, index) => index && point.y < original[index - 1].y), 'upward motion remains part of the hand-drawn line');
  assert.ok(original.some((point, index) => index && point.x < original[index - 1].x), 'backward motion is retained');
});

test('custom trail endpoint handles deform the saved curve by blended offsets while leaving its points intact', () => {
  const leafTrail = [{x: 0.1, y: 0.1}, {x: 0.7, y: 0.1}, {x: 0.7, y: 0.7}, {x: 0.1, y: 0.7}, {x: 0.1, y: 0.1}];
  const base = updateScene(createScene(), {leafTrail, leafOrigin: leafTrail[0], leafTarget: leafTrail.at(-1)});
  const moved = updateScene(base, {leafOrigin: {x: 0.15, y: 0.12}, leafTarget: {x: 0.2, y: 0.15}}), path = leafPath(moved, {samples: 5});
  assert.deepEqual({x: path[0].x, y: path[0].y}, moved.leafOrigin);
  assert.deepEqual({x: path.at(-1).x, y: path.at(-1).y}, moved.leafTarget);
  assert.deepEqual({x: path[2].x, y: path[2].y}, {x: 0.775, y: 0.735});
  assert.deepEqual(moved.leafTrail, leafTrail);
  assert.deepEqual(sceneChanges(base, moved).map(item => item.key), ['leafOrigin', 'leafTarget']);
});

test('bird counts retain atomic finite-language behavior', () => {
  for (const [text, expected] of [['增加两只鸟', 5], ['鸟少一只', 2], ['没有鸟', 0], ['add two birds', 5], ['more birds', 5], ['set birds to twenty', 20]]) {
    assert.equal(apply(text).birds, expected, text);
  }
  for (const text of ['鸟21只', '增加二十只鸟', 'add two birds and generate a new app']) {
    assert.equal(interpretInstruction(text, createScene()).supported, false, text);
  }
});

test('boat compatibility derives one canonical count and rejects explicitly contradictory patches', () => {
  const three = updateScene(createScene(), { boats: 3 });
  assert.equal(three.boat, true); assert.equal(three.boats, 3);
  assert.equal(updateScene(three, { boat: true }).boats, 3);
  const none = updateScene(three, { boat: false });
  assert.equal(none.boat, false); assert.equal(none.boats, 0);
  assert.equal(updateScene(none, { boat: true }).boats, 1);
  assert.equal(updateScene(three, { boats: 0 }).boat, false);
  assert.equal(updateScene(three, { boats: 0, boat: false }).boats, 0);
  assert.deepEqual(sceneChanges(three, none), [{ key: 'boats', label: '帆船数量', before: 3, after: 0 }]);
  assert.throws(() => updateScene(three, { boats: 2, boat: false }), SceneModelError);
  assert.throws(() => updateScene(three, { boats: 0, boat: true }), SceneModelError);
  let read = false;
  for (const field of ['boats', 'mountains']) {
    const patch = {}; Object.defineProperty(patch, field, { enumerable: true, get() { read = true; return 2; } });
    assert.throws(() => updateScene(three, patch), SceneModelError);
    const scene = { ...three }; Object.defineProperty(scene, field, { enumerable: true, get() { read = true; return 2; } });
    assert.throws(() => validateScene(scene), SceneModelError);
  }
  assert.equal(read, false);
});

test('boat and mountain counts support exact and relative Chinese and English instructions', () => {
  const base = updateScene(createScene(), { boats: 4, mountains: 4 });
  const cases = [
    ['增加两艘船', 'boats', 6], ['添加一艘帆船', 'boats', 5], ['船少两艘', 'boats', 2],
    ['船改为三艘', 'boats', 3], ['两艘船', 'boats', 2], ['船0艘', 'boats', 0],
    ['多几座山', 'mountains', 6], ['少几座山', 'mountains', 2], ['山少两座', 'mountains', 2],
    ['山峰设为8座', 'mountains', 8], ['没有山', 'mountains', 0], ['不要船', 'boats', 0],
    ['add two boats', 'boats', 6], ['remove two boats', 'boats', 2], ['set boats to three', 'boats', 3],
    ['more mountains', 'mountains', 6], ['fewer mountains', 'mountains', 2], ['a few more mountains', 'mountains', 6],
    ['decrease mountains by two', 'mountains', 2], ['set mountains to 0', 'mountains', 0],
    ['no mountains', 'mountains', 0], ['remove all boats', 'boats', 0],
  ];
  for (const [text, key, expected] of cases) {
    const result = apply(text, base); assert.equal(result[key], expected, text);
    assert.equal(result.boat, result.boats > 0, text);
  }
  const compound = apply('树全部移除，增加两艘船，然后多几座山', createScene());
  assert.equal(compound.trees, 0); assert.equal(compound.boats, 3); assert.equal(compound.mountains, 4);
});

test('all-tree removal is literal while unsupported, negated and impossible compound requests stay atomic', () => {
  for (const text of ['树全部移除', '不要树', '树没有了', '树都没有了', '移除所有树木', 'remove all trees', 'no trees', 'trees are gone']) {
    assert.equal(apply(text).trees, 0, text);
  }
  const base = createScene();
  for (const text of ['增加九艘船', '山9座', '船2.5艘', '山-1座', 'add ten boats', '山十十座',
    '不要移除树', 'do not remove all trees', '不要树，然后增加一只猫', '增加两艘船，生成代码',
    '树全部移除，船9艘', '多几座山，删除数据库']) {
    const result = interpretInstruction(text, base);
    assert.equal(result.supported, false, text); assert.deepEqual(result.patch, {}); assert.deepEqual(result.changes, []);
  }
  assert.equal(apply('多几座山', updateScene(base, { mountains: 8 })).mountains, 8);
  assert.equal(apply('少几座山', updateScene(base, { mountains: 0 })).mountains, 0);
  assert.deepEqual(base, defaults);
});
