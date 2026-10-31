import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createScene, updateScene, sceneChanges, SCENE_LIMITS} from '../web/scene-model.mjs';
import {SceneCodeError, SCENE_CODE_MAX_BYTES, SCENE_CODE_FIELDS, SCENE_LOGIC_SOURCES,
  formatSceneCode, parseSceneCode, sceneCodeDiff} from '../web/scene-code.mjs';

test('formatted code contains fifteen canonical editable fields and roundtrips the actual scene', () => {
  const scene = updateScene(createScene(), {hour: 22, seed: 4294967295, boat: false, wind: 0.12});
  const text = formatSceneCode(scene), object = JSON.parse(text), restored = parseSceneCode(text, createScene());
  assert.equal(SCENE_CODE_FIELDS.length, 15);
  assert.deepEqual(Object.keys(object), Object.keys(scene).filter(key => !['schemaVersion', 'boat'].includes(key)));
  assert.equal(object.schemaVersion, undefined);
  assert.equal(object.boat, undefined); assert.equal(object.boats, 0); assert.equal(object.mountains, 2);
  assert.deepEqual(restored.patch, object); assert.deepEqual(restored.scene, scene);
  assert.ok(Object.isFrozen(restored)); assert.ok(Object.isFrozen(restored.patch)); assert.ok(Object.isFrozen(restored.scene));
});

test('scene JSON expresses the actual custom trail with round4 points and a truthful structural diff', () => {
  const base = createScene();
  const parsed = parseSceneCode('{"leafTrail":[{"x":0.12344999,"y":0.8},{"x":0.7,"y":0.2},{"x":0.1,"y":0.6}],"leafOrigin":{"x":0.1234,"y":0.8},"leafTarget":{"x":0.1,"y":0.6}}', base);
  assert.deepEqual(parsed.scene.leafTrail, [{x: 0.1234, y: 0.8}, {x: 0.7, y: 0.2}, {x: 0.1, y: 0.6}]);
  assert.deepEqual(sceneCodeDiff(base, parsed.scene).map(item => item.key), ['leafOrigin', 'leafTarget', 'leafTrail']);
  assert.deepEqual(sceneCodeDiff(parsed.scene, parseSceneCode(formatSceneCode(parsed.scene), parsed.scene).scene), []);
  assert.ok(Object.isFrozen(parsed.patch.leafTrail) && parsed.patch.leafTrail.every(Object.isFrozen));
  for (const text of ['{"leafTrail":[{"x":0.2,"y":0.3}]}', '{"leafTrail":[{"x":0.2,"y":0.3},{"x":0.4,"y":2}]}', '{"leafTrail":[{"x":0.2,"y":0.3},{"x":0.4,"y":0.5,"code":"run"}]}']) {
    assert.throws(() => parseSceneCode(text, base), SceneCodeError);
  }
});

test('partial patches preserve omitted values and an empty patch is a valid unchanged operation', () => {
  const base = updateScene(createScene(), {trees: 63, seed: 123, boat: false});
  const original = JSON.stringify(base), result = parseSceneCode('{"hour":6.5,"rain":0.75}', base);
  assert.deepEqual(result.patch, {hour: 6.5, rain: 0.75});
  assert.deepEqual(result.scene, updateScene(base, {hour: 6.5, rain: 0.75}));
  assert.equal(result.scene.trees, 63); assert.equal(result.scene.seed, 123); assert.equal(result.scene.boat, false);
  const unchanged = parseSceneCode('{}', base);
  assert.deepEqual(unchanged.patch, {}); assert.deepEqual(unchanged.scene, base);
  assert.deepEqual(sceneCodeDiff(base, unchanged.scene), []);
  assert.equal(JSON.stringify(base), original);
});

test('diffs identify only the actual changed fields, with the model labels and values', () => {
  const before = createScene(), after = updateScene(before, {trees: 0, boat: false, hour: 24});
  const diff = sceneCodeDiff(before, after);
  assert.deepEqual(diff, sceneChanges(before, after));
  assert.deepEqual(diff.map(item => item.key), ['hour', 'trees', 'boats']);
  assert.deepEqual(diff.find(item => item.key === 'trees'), {key: 'trees', label: '树木', before: 40, after: 0});
  assert.ok(Object.isFrozen(diff)); assert.ok(diff.every(Object.isFrozen));
  assert.deepEqual(sceneCodeDiff(before, before), []);
});

test('count parameters and old boat patches share the same normalized scene and actual diff', () => {
  const base = createScene();
  const counts = parseSceneCode('{"boats":4,"mountains":0}', base);
  assert.equal(counts.scene.boat, true); assert.equal(counts.scene.boats, 4); assert.equal(counts.scene.mountains, 0);
  const old = parseSceneCode('{"boat":false}', counts.scene);
  assert.deepEqual(old.patch, { boat: false }); assert.equal(old.scene.boats, 0);
  assert.deepEqual(sceneCodeDiff(counts.scene, old.scene), [{key: 'boats', label: '帆船数量', before: 4, after: 0}]);
  assert.throws(() => parseSceneCode('{"boats":4,"boat":false}', base), SceneCodeError);
  const legacy = { ...base }; delete legacy.boats; delete legacy.mountains;
  assert.equal(JSON.parse(formatSceneCode(legacy)).boats, 1);
  assert.deepEqual(parseSceneCode(formatSceneCode(legacy), legacy).scene, base);
});

test('real JSON edits validate nested placements and leaf endpoints without false diffs', () => {
  const base = createScene();
  const result = parseSceneCode('{"birds":5,"placements":[{"id":"bird:4","x":0.7,"y":0.2}],"leafOrigin":{"x":0.1,"y":0.3},"leafTarget":{"x":0.8,"y":0.9}}', base);
  assert.equal(result.scene.birds, 5); assert.equal(result.scene.placements[0].id, 'bird:4');
  assert.deepEqual(result.scene.leafOrigin, {x: 0.1, y: 0.3}); assert.deepEqual(result.scene.leafTarget, {x: 0.8, y: 0.9});
  assert.deepEqual(sceneCodeDiff(result.scene, parseSceneCode(formatSceneCode(result.scene), result.scene).scene), []);
  assert.deepEqual(sceneCodeDiff(base, result.scene).map(item => item.key), ['birds', 'placements', 'leafOrigin', 'leafTarget']);
  for (const text of ['{"placements":[{"id":"bird:3","x":0.5,"y":0.2}]}', '{"leafOrigin":{"x":-0.1,"y":0.2}}',
    '{"placements":[{"id":"boat:0","x":0.4,"y":0.7},{"id":"boat:0","x":0.5,"y":0.8}]}']) {
    assert.throws(() => parseSceneCode(text, base), SceneCodeError);
  }
  const all = [];
  for (const [kind, count] of [['tree', 100], ['boat', 8], ['mountain', 8], ['bird', 20]]) {
    for (let index = 0; index < count; index++) all.push({id: `${kind}:${index}`, x: 0.123456, y: 0.987654});
  }
  const full = updateScene(base, {trees: 100, boats: 8, mountains: 8, birds: 20, placements: all,
    leafTrail: Array.from({length: 40}, (_, index) => ({x: index / 40, y: 0.987654321}))});
  assert.deepEqual(parseSceneCode(formatSceneCode(full), base).scene, full, 'largest valid pretty JSON still roundtrips');
});

test('both limits for every numeric field parse through the real model and out-of-range values reject', () => {
  const scene = createScene();
  for (const [key, limit] of Object.entries(SCENE_LIMITS)) {
    for (const value of [limit.min, limit.max]) {
      const result = parseSceneCode(JSON.stringify({[key]: value}), scene);
      assert.equal(result.scene[key], value); assert.deepEqual(result.patch, {[key]: value});
    }
    for (const value of [limit.min - 1, limit.max + 1]) {
      assert.throws(() => parseSceneCode(JSON.stringify({[key]: value}), scene), SceneCodeError);
    }
  }
  assert.throws(() => parseSceneCode('{"trees":2.5}', scene), SceneCodeError);
  assert.throws(() => parseSceneCode('{"boat":1}', scene), SceneCodeError);
  assert.throws(() => parseSceneCode('{"hour":1e999}', scene), SceneCodeError);
});

test('expressions, executable-looking input, unknown fields and prototype payloads cannot execute or partially apply', () => {
  const scene = createScene(), original = JSON.stringify(scene);
  const invalid = [
    '', 'null', '[]', '12', '"文字"', '{hour:12}', '{"hour":6+6}', '{"hour":12,}', '{"hour":NaN}',
    '{"hour":Infinity}', '{"hour":"12"}', '{"schemaVersion":1}', '{"hour":12,"unknown":3}',
    '{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"polluted":true}}}',
    '{"hour":12}; globalThis.sceneCodeInjected = true', '(()=>({"hour":12}))()',
    '{"wind":{"valueOf":"untrusted"}}', '{"rain":true}', '{"boat":null}',
  ];
  for (const text of invalid) assert.throws(() => parseSceneCode(text, scene), SceneCodeError);
  assert.equal(JSON.stringify(scene), original); assert.equal({}.polluted, undefined);
  assert.equal(globalThis.sceneCodeInjected, undefined);
});

test('Unicode escaped known keys are JSON, while Unicode unknown keys and values remain invalid scene data', () => {
  const scene = createScene();
  assert.equal(parseSceneCode('{"\\u0068our":12}', scene).scene.hour, 12);
  for (const text of ['{"时间":12}', '{"title":"一起改 🧪"}', '{"hour":"十二"}', '{"boat":"真"}']) {
    assert.throws(() => parseSceneCode(text, scene), SceneCodeError);
  }
  assert.throws(() => parseSceneCode(' '.repeat(SCENE_CODE_MAX_BYTES + 1), scene),
    error => error instanceof SceneCodeError && error.code === 'SCENE_CODE_TOO_LARGE');
  assert.throws(() => parseSceneCode('{"标题":"' + '文'.repeat(SCENE_CODE_MAX_BYTES) + '"}', scene),
    error => error instanceof SceneCodeError && error.code === 'SCENE_CODE_TOO_LARGE');
  assert.throws(() => parseSceneCode({}, scene), SceneCodeError);
  assert.throws(() => parseSceneCode('{}', {}), error => error.code === 'INVALID_BASE_SCENE');
});

test('read-only logic references point to actual exported source rather than invented renderer excerpts', async () => {
  assert.ok(Object.isFrozen(SCENE_LOGIC_SOURCES));
  for (const reference of SCENE_LOGIC_SOURCES) {
    assert.equal(reference.editable, false);
    const source = await readFile(new URL('../web/' + reference.path.slice(2), import.meta.url), 'utf8');
    for (const name of reference.exports) assert.match(source, new RegExp('export (?:function|const) ' + name + '\\b'));
  }
});
