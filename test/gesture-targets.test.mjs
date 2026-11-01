import test from 'node:test';
import assert from 'node:assert/strict';
import {createScene, updateScene, validateScene, leafPath} from '../web/scene-model.mjs';
import {buildGestureTargets, hitTestGestureTargets, applyTargetDrag, drawLeafTrailPatch} from '../web/gesture-targets.mjs';

const rect = (left, top, right, bottom) => ({bounds: {left, top, right, bottom}});
const cursor = {x: .4, y: .4};
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const frame = {x: .1, y: .5, scaleX: .45, scaleY: .45};
const controlGeometry = () => ({sun: rect(.5, .1, .56, .18), leaf: rect(.3, .6, .34, .65),
  leafOrigin: rect(.2, .58, .22, .6), leafTarget: rect(.4, .9, .42, .92), leafFrame: frame,
  branches: rect(.1, .5, .4, .95), flowers: rect(.1, .7, .3, .8),
  sky: rect(0, 0, 1, .48), water: rect(0, .48, 1, 1), wind: rect(0, 0, 1, 1),
  rain: rect(0, 0, 1, 1), clouds: rect(0, .1, 1, .3)});
const target = (id, scene = createScene(), geometry = controlGeometry()) => buildGestureTargets(scene, [], geometry).find(item => item.id === id);

test('inventory covers every supported object instance at scene limits using renderer anchors', () => {
  const scene = updateScene(createScene(), {trees: 100, mountains: 8, boats: 8, birds: 20});
  const positions = Object.entries({tree: 100, mountain: 8, boat: 8, bird: 20}).flatMap(([kind, count]) =>
    Array.from({length: count}, (_, index) => ({id: `${kind}:${index}`, kind, point: {x: .2 + index / 200, y: .7}})));
  const targets = buildGestureTargets(scene, positions, controlGeometry());
  assert.equal(targets.filter(item => item.operation === 'object').length, 136);
  for (const original of positions) {
    const item = targets.find(candidate => candidate.id === original.id);
    assert.deepEqual(item.modelAnchor, original.point);
    assert.equal(item.operation, 'object');
    assert.equal(item.requireExplicit, false);
  }
  assert.equal(targets.length, 147);
  assert.ok(Object.isFrozen(targets));
  assert.ok(targets.every(Object.isFrozen));
});

test('inventory uses actual DOM boxes, omits hidden and unknown instances, and never invents controls', () => {
  const positions = [{id: 'boat:0', point: {x: .6, y: .7}}, {id: 'tree:0', point: {x: .2, y: .9}},
    {id: 'mountain:0', point: {x: .2, y: .3}}, {id: 'bird:0', point: {x: .3, y: .3}},
    {id: 'boat:1', point: {x: .7, y: .7}}, {id: 'flower:0', point: {x: .1, y: .9}},
    {id: 'bird:1', point: {x: NaN, y: .1}}, {id: 'boat:0', point: {x: .8, y: .8}}];
  const geometry = {'boat:0': rect(.51, .55, .67, .8), 'tree:0': {visible: false},
    'mountain:0': rect(-.2, .2, -.1, .5), 'bird:0': rect(.2, .2, .3, .3)};
  const targets = buildGestureTargets(createScene(), positions, geometry);
  assert.deepEqual(targets.map(item => item.id), ['boat:0', 'bird:0']);
  assert.deepEqual(targets[0].bounds, geometry['boat:0'].bounds);
  assert.notEqual(targets[0].bounds, geometry['boat:0'].bounds);
  geometry['boat:0'].bounds.left = .9;
  positions[0].point.x = .9;
  assert.equal(targets[0].bounds.left, .51);
  assert.equal(targets[0].modelAnchor.x, .6);
  assert.equal(buildGestureTargets(createScene(), []).length, 0);
});

test('leaf and branch selection disappears when absent while flower quantity remains recoverable', () => {
  const empty = updateScene(createScene(), {trees: 0, flowers: 0, birds: 0, boats: 0, mountains: 0});
  const targets = buildGestureTargets(empty, [{id: 'tree:0', point: cursor}], controlGeometry());
  assert.deepEqual(targets.map(item => item.id), ['sun', 'flowers', 'sky', 'water', 'wind', 'rain', 'clouds']);
  const flowers = targets.find(item => item.id === 'flowers');
  assert.equal(flowers.requireExplicit, true);
  assert.equal(hitTestGestureTargets([flowers], {x: .2, y: .75}), null);
  assert.equal(hitTestGestureTargets([flowers], cursor, {explicitId: 'flowers'}), flowers);
  const restored = updateScene(empty, applyTargetDrag(empty, flowers, cursor, {x: .5, y: .4}));
  assert.equal(restored.flowers, 10);
  const noFrame = controlGeometry(); delete noFrame.leafFrame;
  assert.ok(buildGestureTargets(createScene(), [], noFrame).every(item => !item.id.startsWith('leaf')));
  const handDrawn = updateScene(createScene(), {leafTrail: [{x: .2, y: .3}, {x: .7, y: .8}]});
  assert.equal(buildGestureTargets(handDrawn, [], noFrame).find(item => item.id === 'leaf').frame.scaleX, 1);
});

test('explicit object count targets work at zero, restore objects, and respect integer limits', () => {
  const fields = {trees: 100, boats: 8, mountains: 8, birds: 20};
  const empty = updateScene(createScene(), Object.fromEntries(Object.keys(fields).map(field => [field, 0])));
  const geometry = Object.fromEntries(Object.keys(fields).map(field => [`count:${field}`, rect(0, 0, 1, 1)]));
  const targets = buildGestureTargets(empty, [], geometry);
  assert.equal(targets.length, 4);
  assert.equal(hitTestGestureTargets(targets, cursor), null, 'count controls require deliberate selection');
  for (const [field, max] of Object.entries(fields)) {
    const selected = hitTestGestureTargets(targets, cursor, {explicitId: `count:${field}`});
    assert.equal(selected.operation, 'count');
    assert.equal(selected.field, field);
    assert.equal(selected.requireExplicit, true);
    const patch = applyTargetDrag(empty, selected, {x: 0, y: .4}, {x: 1, y: .4});
    assert.equal(patch[field], max);
    const restored = updateScene(empty, patch);
    assert.equal(restored[field], max);
    if (field === 'boats') assert.equal(restored.boat, true);
    const halfway = applyTargetDrag(empty, selected, cursor, {x: .6, y: .4});
    assert.equal(halfway[field], Math.round(max * .2));
    assert.ok(Number.isInteger(halfway[field]));
    const cleared = updateScene(restored, applyTargetDrag(restored, selected, {x: 1, y: .4}, {x: 0, y: .4}));
    assert.equal(cleared[field], 0);
    if (field === 'boats') assert.equal(cleared.boat, false);
    assert.deepEqual(applyTargetDrag(empty, selected, {x: 1, y: .4}, {x: 0, y: .4}), {});
    assert.doesNotThrow(() => validateScene(restored));
    assert.doesNotThrow(() => validateScene(cleared));
  }
});

test('object count operation rejects unknown and non-count fields even without movement', () => {
  for (const field of [undefined, 'rain', 'hour', 'flowers', 'schemaVersion', 'placements', '__proto__', 'constructor']) {
    const invalid = {id: `count:${field}`, operation: 'count', field};
    assert.throws(() => applyTargetDrag(createScene(), invalid, cursor, {x: .5, y: .4}), /count field/u);
    assert.throws(() => applyTargetDrag(createScene(), invalid, cursor, cursor), /count field/u);
  }
});

test('small actual bounds win overlaps and environment controls require explicit selection', () => {
  const scene = createScene();
  const geometry = {...controlGeometry(), 'mountain:0': rect(.1, .1, .9, .9),
    'tree:0': rect(.2, .2, .5, .8), 'boat:0': rect(.3, .3, .4, .4), 'bird:0': rect(.33, .33, .35, .35)};
  const positions = ['mountain:0', 'tree:0', 'boat:0', 'bird:0'].map(id => ({id, point: cursor}));
  const targets = buildGestureTargets(scene, positions, geometry);
  assert.equal(hitTestGestureTargets(targets, {x: .34, y: .34}).id, 'bird:0');
  assert.equal(hitTestGestureTargets(targets, {x: .38, y: .38}).id, 'boat:0');
  assert.equal(hitTestGestureTargets(targets, {x: .01, y: .01}), null);
  assert.equal(hitTestGestureTargets(targets, {x: .01, y: .01}, {explicitId: 'water'}).id, 'water');
  assert.equal(hitTestGestureTargets(targets, cursor, {explicitId: 'missing'}), null);
  assert.equal(hitTestGestureTargets(targets, {x: NaN, y: .4}), null);
  assert.equal(hitTestGestureTargets(targets, cursor, {slop: Infinity}), null);
});

test('object dragging preserves the initial grab offset and never accumulates preview deltas', () => {
  const scene = createScene();
  for (const id of ['tree:0', 'mountain:0', 'boat:0', 'bird:0']) {
    const original = {x: .23, y: .62};
    const selected = buildGestureTargets(scene, [{id, point: original}])[0];
    assert.deepEqual(applyTargetDrag(scene, selected, cursor, cursor), {}, 'grabbing does not add a placement');
    const patch = applyTargetDrag(scene, selected, cursor, {x: .5, y: .6});
    assert.deepEqual(patch.placements, [{id, x: .33, y: .82}]);
    assert.deepEqual(applyTargetDrag(scene, selected, cursor, {x: .5, y: .6}), patch);
    assert.deepEqual(validateScene(updateScene(scene, patch)).placements, patch.placements);
    assert.deepEqual(original, {x: .23, y: .62});
  }
});

test('saved placement remains authoritative and movement clamps both axes without losing unrelated objects', () => {
  const scene = updateScene(createScene(), {placements: [{id: 'boat:0', x: .8, y: .8}, {id: 'tree:0', x: .3, y: .9}]});
  const selected = buildGestureTargets(scene, [{id: 'boat:0', point: {x: .1, y: .1}}])[0];
  const moved = updateScene(scene, applyTargetDrag(scene, selected, {x: .1, y: .1}, {x: .9, y: .9}));
  assert.deepEqual(moved.placements, [{id: 'tree:0', x: .3, y: .9}, {id: 'boat:0', x: 1, y: 1}]);
  assert.equal(scene.placements.find(item => item.id === 'boat:0').x, .8);
  const removed = updateScene(scene, {boats: 0});
  assert.throws(() => applyTargetDrag(removed, selected, cursor, {x: .5, y: .4}), /对象编号/u);
});

test('sun, environment, flowers and tree shape map to real bounded model parameters', () => {
  const scene = updateScene(createScene(), {hour: 12, wind: .3, rain: .2, flowers: 30, branchAngle: 32, branchDepth: 5});
  const moved = {x: .6, y: .2};
  const patches = Object.fromEntries(['sun', 'sky', 'water', 'wind', 'rain', 'clouds', 'flowers', 'branches']
    .map(id => [id, applyTargetDrag(scene, target(id, scene), cursor, moved)]));
  near(patches.sun.hour, 16.8);
  assert.deepEqual(patches.sky, patches.sun);
  assert.deepEqual(patches.water, {hour: 16.8, rain: .4});
  assert.deepEqual(patches.wind, {wind: .5});
  assert.deepEqual(patches.rain, {rain: .4});
  assert.deepEqual(patches.clouds, patches.rain);
  assert.deepEqual(patches.flowers, {flowers: 50});
  assert.deepEqual(patches.branches, {branchAngle: 47, branchDepth: 6});
  for (const patch of Object.values(patches)) assert.doesNotThrow(() => validateScene(updateScene(scene, patch)));
  const maxed = updateScene(scene, {hour: 24, rain: 1, wind: 1, flowers: 100, branchAngle: 80, branchDepth: 8});
  for (const id of ['sun', 'sky', 'water', 'wind', 'rain', 'clouds', 'flowers', 'branches']) {
    assert.deepEqual(applyTargetDrag(maxed, target(id, maxed), cursor, moved), {});
  }
});

test('leaf endpoint drag converts camera deltas back through the actual tree-relative frame', () => {
  const scene = createScene();
  for (const id of ['leafOrigin', 'leafTarget']) {
    const selected = target(id, scene);
    assert.deepEqual(applyTargetDrag(scene, selected, cursor, cursor), {});
    const patch = applyTargetDrag(scene, selected, cursor, {x: .445, y: .355});
    near(patch[id].x, scene[id].x + .1);
    near(patch[id].y, scene[id].y - .1);
    assert.doesNotThrow(() => validateScene(updateScene(scene, patch)));
    assert.equal(patch.leafTrail, undefined, 'moving an endpoint preserves the existing path mode');
    const rendered = leafPath(updateScene(scene, patch));
    assert.deepEqual({x: (id === 'leafOrigin' ? rendered[0] : rendered.at(-1)).x,
      y: (id === 'leafOrigin' ? rendered[0] : rendered.at(-1)).y}, patch[id]);
  }
});

test('hand-drawn endpoint drags change rendered endpoints and interpolate across the existing trail', () => {
  const scene = updateScene(createScene(), {leafTrail: [{x: .2, y: .3}, {x: .4, y: .6}, {x: .8, y: .7}],
    leafOrigin: {x: .2, y: .3}, leafTarget: {x: .8, y: .7}});
  const geometry = controlGeometry(); delete geometry.leafFrame;
  const beforePath = leafPath(scene, {samples: 41});
  for (const id of ['leafOrigin', 'leafTarget']) {
    const patch = applyTargetDrag(scene, target(id, scene, geometry), cursor, {x: .456789, y: .323456});
    const next = updateScene(scene, patch), rendered = leafPath(next, {samples: 41});
    assert.equal(patch.leafTrail, undefined, 'the model keeps its original endpoint interpolation semantics');
    assert.deepEqual(next.leafTrail, scene.leafTrail);
    assert.deepEqual({x: rendered[0].x, y: rendered[0].y}, next.leafOrigin);
    assert.deepEqual({x: rendered.at(-1).x, y: rendered.at(-1).y}, next.leafTarget);
    near(next[id].x, scene[id].x + .056789);
    near(next[id].y, scene[id].y - .076544);
    for (const index of [10, 20, 30]) {
      const weight = id === 'leafOrigin' ? 1 - index / 40 : index / 40;
      near(rendered[index].x - beforePath[index].x, .056789 * weight, .000002);
      near(rendered[index].y - beforePath[index].y, -.076544 * weight, .000002);
    }
    assert.notDeepEqual(next[id], scene[id]);
    assert.doesNotThrow(() => validateScene(next));
  }
});

test('moving a leaf preserves the actual path and the leaf position at every animation phase', () => {
  const scene = createScene(), selected = target('leaf', scene);
  const source = leafPath(scene, {samples: 40});
  const patch = applyTargetDrag(scene, selected, cursor, {x: .42, y: .41});
  assert.equal(patch.leafTrail, undefined, 'default path mode and its phase timing stay intact');
  const next = updateScene(scene, patch), moved = leafPath(next, {samples: 40});
  for (const index of [0, 9, 20, 39]) {
    near((moved[index].x - source[index].x) * frame.scaleX, .02, .000001);
    near((moved[index].y - source[index].y) * frame.scaleY, .01, .000001);
  }
  assert.deepEqual(next.leafOrigin, patch.leafOrigin);
  assert.deepEqual(next.leafTarget, patch.leafTarget);
  assert.doesNotThrow(() => validateScene(next));
  assert.equal(scene.leafTrail.length, 0);
});

test('whole-trajectory translation preserves its shape at canvas edges and endpoint editing keeps custom points', () => {
  const scene = updateScene(createScene(), {leafTrail: [{x: .2, y: .3}, {x: .4, y: .5}, {x: .8, y: .7}],
    leafOrigin: {x: .2, y: .3}, leafTarget: {x: .8, y: .7}});
  const geometry = controlGeometry(); delete geometry.leafFrame;
  const selected = target('leaf', scene, geometry);
  const patch = applyTargetDrag(scene, selected, {x: .1, y: .1}, {x: .9, y: .9});
  near(patch.leafOrigin.x, .4);
  near(patch.leafOrigin.y, .6);
  near(patch.leafTarget.x, 1);
  near(patch.leafTarget.y, 1);
  near(patch.leafTarget.x - patch.leafOrigin.x, .6);
  const endpoint = applyTargetDrag(scene, target('leafOrigin', scene, geometry), cursor, {x: .5, y: .4});
  const next = updateScene(scene, endpoint);
  assert.deepEqual(next.leafTrail, scene.leafTrail);
  near(next.leafOrigin.x, .3);
});

test('drawing a leaf path bounds long strokes, preserves endpoints and ignores a simple click', () => {
  const scene = createScene();
  const points = Array.from({length: 201}, (_, i) => ({x: .1 + .8 * i / 200, y: .2 + .7 * i / 200}));
  const patch = drawLeafTrailPatch(scene, points);
  assert.equal(patch.leafTrail.length, 40);
  assert.deepEqual(patch.leafOrigin, points[0]);
  near(patch.leafTarget.x, .9); near(patch.leafTarget.y, .9);
  assert.deepEqual(drawLeafTrailPatch(scene, [cursor, cursor]), {});
  assert.deepEqual(drawLeafTrailPatch(scene, []), {});
  assert.doesNotThrow(() => validateScene(updateScene(scene, patch)));
  assert.throws(() => drawLeafTrailPatch(scene, [{x: -1, y: 0}, cursor]), RangeError);
  assert.throws(() => drawLeafTrailPatch(scene, [, cursor]), RangeError);
  assert.throws(() => drawLeafTrailPatch(updateScene(scene, {trees: 0}), points), RangeError);
});

test('bad scene, cursor, target and leaf-frame inputs cannot create unchecked patches', () => {
  assert.throws(() => buildGestureTargets({...createScene(), unknown: 1}), /未知字段/u);
  for (const value of [null, {}, {x: NaN, y: .3}, {x: .3, y: 1.1}]) {
    assert.throws(() => applyTargetDrag(createScene(), target('sun'), value, cursor), RangeError);
    assert.throws(() => applyTargetDrag(createScene(), target('sun'), cursor, value), RangeError);
  }
  assert.throws(() => applyTargetDrag(createScene(), {operation: 'execute'}, cursor, {x: .5, y: .5}), RangeError);
  assert.throws(() => applyTargetDrag(createScene(), {...target('leaf'), frame: null}, cursor, {x: .5, y: .5}), RangeError);
  const geometry = controlGeometry(); geometry.leafFrame.scaleX = 0;
  assert.ok(buildGestureTargets(createScene(), [], geometry).every(item => !item.id.startsWith('leaf')));
});
