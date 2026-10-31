import test from 'node:test';
import assert from 'node:assert/strict';
import {createScene, updateScene} from '../web/scene-model.mjs';
import {layoutSceneObjects} from '../web/scene-renderer.mjs';

const full = {left: 0, right: 1600, top: 0, bottom: 1000};
const viewports = [
  full,
  {left: 0, right: 1600, top: 50, bottom: 950}, // 16:9 fullscreen.
  {left: 0, right: 1600, top: 275, bottom: 725}, // Wide 32:9 screen.
  {left: (1600 - 1000 * 390 / 844) / 2, right: (1600 + 1000 * 390 / 844) / 2, top: 0, bottom: 1000},
  {left: (1600 - 1000 * 390 / 360) / 2, right: (1600 + 1000 * 390 / 360) / 2, top: 0, bottom: 1000},
];
const separated = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

test('every allowed count produces the requested number of independent scene objects', () => {
  for (let boats = 0; boats <= 8; boats++) for (let mountains = 0; mountains <= 8; mountains++) {
    const result = layoutSceneObjects(updateScene(createScene(), {boats, mountains}));
    assert.equal(result.boats.length, boats); assert.equal(result.mountains.length, mountains);
    assert.equal(new Set(result.boats.map(item => item.id)).size, boats);
    assert.equal(new Set(result.mountains.map(item => item.id)).size, mountains);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.boats)); assert.ok(Object.isFrozen(result.mountains));
  }
});

test('boats remain inside the actually visible sea and their full motion envelopes do not overlap', () => {
  for (const viewport of viewports) for (const seed of [0, 72, 4294967295]) for (let count = 1; count <= 8; count++) {
    const objects = layoutSceneObjects(updateScene(createScene(), {seed, boats: count}), viewport);
    for (const item of objects.boats) {
      assert.ok(item.bounds.left >= viewport.left && item.bounds.right <= viewport.right, 'boat stays inside horizontal crop');
      assert.ok(item.bounds.top >= Math.max(480, viewport.top) && item.bounds.bottom <= viewport.bottom, 'boat stays on visible water');
      assert.ok(item.bounds.left > 539 + Math.max(0, viewport.left - 330), 'boat avoids the foreground coast after its mobile camera shift');
      assert.ok(item.scale > 0 && item.scale <= .9);
    }
    for (let a = 0; a < objects.boats.length; a++) for (let b = a + 1; b < objects.boats.length; b++) {
      assert.ok(separated(objects.boats[a].bounds, objects.boats[b].bounds), 'independent boats cannot cover each other');
    }
  }
});

test('every main mountain peak remains distinct and visible on narrow phones and wide screens', () => {
  for (const viewport of viewports) for (let count = 1; count <= 8; count++) {
    const objects = layoutSceneObjects(updateScene(createScene(), {mountains: count}), viewport);
    const peaks = objects.mountains.map(item => item.peakX).sort((a, b) => a - b);
    assert.ok(peaks.every(x => x > viewport.left && x < viewport.right));
    for (let index = 1; index < peaks.length; index++) assert.ok(peaks[index] - peaks[index - 1] > 30);
    for (const mountain of objects.mountains) assert.ok(mountain.height > 0 && mountain.width > 0);
  }
});

test('default artwork positions survive and legacy boat booleans normalize to real quantities', () => {
  const scene = createScene(), result = layoutSceneObjects(scene);
  assert.deepEqual(result.boats.map(({x, y, scale}) => ({x, y, scale})), [{x: 970, y: 708, scale: .82}]);
  assert.deepEqual(result.mountains.map(({template, transform}) => ({template, transform})), [
    {template: 'left', transform: 'translate(0 0)'}, {template: 'right', transform: 'translate(0 0)'},
  ]);
  const legacy = {...scene}; delete legacy.boats; delete legacy.mountains;
  legacy.boat = false;
  assert.equal(layoutSceneObjects(legacy).boats.length, 0);
  legacy.boat = true;
  assert.equal(layoutSceneObjects(legacy).boats.length, 1);
});

test('layout is deterministic for scene and viewport while seed changes yield new natural arrangements', () => {
  const scene = updateScene(createScene(), {boats: 8, mountains: 8}), viewport = viewports[3];
  assert.deepEqual(layoutSceneObjects(scene, viewport), layoutSceneObjects(scene, {...viewport}));
  const alternative = layoutSceneObjects(updateScene(scene, {seed: scene.seed + 1}), viewport);
  assert.notDeepEqual(alternative.boats, layoutSceneObjects(scene, viewport).boats);
  assert.notDeepEqual(alternative.mountains, layoutSceneObjects(scene, viewport).mountains);
  assert.throws(() => layoutSceneObjects(scene, {left: 900, right: 800}), RangeError);
  assert.throws(() => layoutSceneObjects(scene, {bottom: NaN}), RangeError);
});

test('packed mountain ranges never relocate a template whose coast was cut by the original screen edge', () => {
  for (const viewport of viewports) for (let count = 3; count <= 8; count++) {
    const mountains = layoutSceneObjects(updateScene(createScene(), {mountains: count}), viewport).mountains;
    assert.ok(mountains.every(item => item.template === 'generated'));
    assert.ok(mountains.every(item => Number.isFinite(item.lean) && item.shoulder >= .55 && item.shoulder <= .7));
    assert.ok(new Set(mountains.map(item => item.lean + ':' + item.shoulder)).size > 1, 'complete silhouettes have distinct deterministic profiles');
  }
  assert.equal(layoutSceneObjects(updateScene(createScene(), {mountains: 1})).mountains[0].template, 'left');
  assert.deepEqual(layoutSceneObjects(createScene()).mountains.map(item => item.template), ['left', 'right']);
});
