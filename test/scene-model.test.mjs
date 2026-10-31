import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneModelError, SCENE_LIMITS, createScene, validateScene, updateScene,
  sceneChanges, interpretInstruction, solarPosition, leafPath } from '../web/scene-model.mjs';

const defaults = { schemaVersion: 1, seed: 72, hour: 18.3, trees: 40, rain: 0,
  wind: 0.3, branchAngle: 32, branchDepth: 5, boats: 1, mountains: 2, boat: true, flowers: 30 };
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
  assert.notEqual(leafPath(updateScene(scene, { seed: 73 }))[0].x, original[0].x);
  assert.deepEqual(leafPath(scene, { samples: 61 })[30], original[15], 'same time produces the same state at a different sampling density');
  for (const samples of [0, 1, 242, 2.5, NaN, '31']) assert.throws(() => leafPath(scene, { samples }), SceneModelError);
});

test('legacy scenes normalize only the two added count fields without mutating old snapshots', () => {
  const legacy = { ...createScene() }; delete legacy.boats; delete legacy.mountains;
  const original = JSON.stringify(legacy), normalized = validateScene(legacy);
  assert.equal(normalized.boats, 1); assert.equal(normalized.mountains, 2); assert.equal(normalized.boat, true);
  assert.equal(Object.isFrozen(normalized), true); assert.equal(JSON.stringify(legacy), original);
  const hiddenBoat = validateScene({ ...legacy, boat: false });
  assert.equal(hiddenBoat.boats, 0); assert.equal(hiddenBoat.boat, false);
  assert.deepEqual(sceneChanges(legacy, normalized), []);
  const partialLegacy = { ...normalized }; delete partialLegacy.mountains;
  assert.equal(validateScene(partialLegacy).mountains, 2);
  const missingRequired = { ...legacy }; delete missingRequired.boat;
  assert.throws(() => validateScene(missingRequired), SceneModelError);
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
