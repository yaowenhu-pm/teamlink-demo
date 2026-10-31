import test from 'node:test';
import assert from 'node:assert/strict';
import {drawingPoints, ambientMotion, streamLeaf} from '../web/motion-model.mjs';

test('a captured stroke stays bounded, round4 and preserves both endpoints and turns', () => {
  const raw = Array.from({length: 800}, (_, i) => ({x: i/799, y: .5+Math.sin(i/799*Math.PI*2)*.4}));
  const result = drawingPoints(raw);
  assert.equal(result.length, 40);
  assert.deepEqual(result[0], {x: 0, y: .5});
  assert.deepEqual(result.at(-1), {x: 1, y: .5});
  assert.ok(result.some(p => p.y > .89) && result.some(p => p.y < .11));
  assert.ok(result.every(p => Object.values(p).every(n => n >= 0 && n <= 1 && Number(n.toFixed(4)) === n)));
  assert.deepEqual(drawingPoints([{x: .123456, y: -2}, {x: .123456, y: -2}, {x: NaN, y: 1}, {x: 2, y: 1}]), [{x: .1235, y: 0}, {x: 1, y: 1}]);
});

test('ambient movement is deterministic, bounded and independent of leaf phase', () => {
  for (const kind of ['sun', 'boat', 'bird', 'water', 'cloud', 'rain']) {
    const a = ambientMotion(kind, 8, {wind: .4, index: 2});
    assert.deepEqual(ambientMotion(kind, 8, {wind: .4, index: 2}), a);
    assert.notDeepEqual(ambientMotion(kind, 9, {wind: .4, index: 2}), a);
    for (let t = 0; t <= 1000; t+=7) {
      const value = ambientMotion(kind, t, {wind: 1, index: 2});
      assert.ok(Math.abs(value.x) <= 100 && Math.abs(value.y) <= 55);
    }
  }
  assert.deepEqual(ambientMotion('mountain', 100), {x: 0, y: 0});
});

test('leaf streams have staggered times and stable positions when time is held', () => {
  const leaves = Array.from({length: 28}, (_, i) => streamLeaf(i, 4));
  assert.ok(new Set(leaves.map(p => p.phase)).size > 25);
  for (const [i, leaf] of leaves.entries()) {
    assert.deepEqual(streamLeaf(i, 4), leaf);
    assert.ok(leaf.phase >= 0 && leaf.phase < 1 && leaf.opacity >= 0 && leaf.opacity <= 1);
    assert.ok(leaf.scale >= .29 && leaf.scale <= .62);
    assert.notDeepEqual(streamLeaf(i, 5), leaf);
  }
});
