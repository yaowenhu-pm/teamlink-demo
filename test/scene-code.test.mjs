import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createScene, updateScene, sceneChanges, SCENE_LIMITS} from '../web/scene-model.mjs';
import {SceneCodeError, SCENE_CODE_MAX_BYTES, SCENE_CODE_FIELDS, SCENE_LOGIC_SOURCES,
  formatSceneCode, parseSceneCode, sceneCodeDiff} from '../web/scene-code.mjs';

test('formatted code contains all nine editable fields and roundtrips the actual scene', () => {
  const scene = updateScene(createScene(), {hour: 22, seed: 4294967295, boat: false, wind: 0.12});
  const text = formatSceneCode(scene), object = JSON.parse(text), restored = parseSceneCode(text, createScene());
  assert.equal(SCENE_CODE_FIELDS.length, 9);
  assert.deepEqual(Object.keys(object), Object.keys(scene).filter(key => key !== 'schemaVersion'));
  assert.equal(object.schemaVersion, undefined);
  assert.deepEqual(restored.patch, object); assert.deepEqual(restored.scene, scene);
  assert.ok(Object.isFrozen(restored)); assert.ok(Object.isFrozen(restored.patch)); assert.ok(Object.isFrozen(restored.scene));
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
  assert.deepEqual(diff.map(item => item.key), ['hour', 'trees', 'boat']);
  assert.deepEqual(diff.find(item => item.key === 'trees'), {key: 'trees', label: '树木', before: 40, after: 0});
  assert.ok(Object.isFrozen(diff)); assert.ok(diff.every(Object.isFrozen));
  assert.deepEqual(sceneCodeDiff(before, before), []);
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
  assert.throws(() => parseSceneCode('{"标题":"' + '文'.repeat(3000) + '"}', scene),
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
