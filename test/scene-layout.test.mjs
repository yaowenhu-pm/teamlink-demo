import test from 'node:test';
import assert from 'node:assert/strict';
import {createScene, updateScene} from '../web/scene-model.mjs';
import {layoutSceneObjects, sceneCameraPoint, resolveSceneObjectAnchor, dragSceneObjectPoint, trajectoryPhaseAt} from '../web/scene-renderer.mjs';

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

test('placements mean the same camera-relative location across desktop, phone and repeated renders', () => {
  const scene=updateScene(createScene(),{placements:[{id:'boat:0',x:.27,y:.61},{id:'tree:0',x:.4,y:.8}]});
  for(const viewport of viewports){
    const fallback={x:970,y:708},anchor=resolveSceneObjectAnchor(scene,'boat:0',fallback,viewport);
    const point=sceneCameraPoint(viewport,anchor);
    assert.ok(Math.abs(point.x-.27)<1e-10&&Math.abs(point.y-.61)<1e-10);
    assert.deepEqual(resolveSceneObjectAnchor(scene,'boat:0',anchor,viewport),anchor,'a second render cannot add the drag delta again');
    assert.deepEqual(resolveSceneObjectAnchor(scene,'mountain:0',fallback,viewport),fallback,'unplaced artwork retains its default anchor');
  }
});

test('object dragging retains the original grab offset and clamps only at camera edges', () => {
  const viewport=viewports[3],anchor={x:800,y:700},grab={x:818,y:691};
  assert.deepEqual(dragSceneObjectPoint(viewport,anchor,grab,grab),sceneCameraPoint(viewport,anchor),'pointerdown cannot jump the object');
  const moved=dragSceneObjectPoint(viewport,anchor,grab,{x:858,y:721});
  assert.deepEqual(moved,sceneCameraPoint(viewport,{x:840,y:730}));
  assert.deepEqual(dragSceneObjectPoint(viewport,anchor,grab,{x:-10000,y:10000}),{x:0,y:1});
});

test('birds have stable individual anchors for every supported quantity and mobile camera', () => {
  for(const viewport of viewports)for(let count=0;count<=20;count++){
    const scene=updateScene(createScene(),{birds:count}),layout=layoutSceneObjects(scene,viewport);
    assert.equal(layout.birds.length,count);assert.equal(new Set(layout.birds.map(item=>item.id)).size,count);
    assert.deepEqual(layoutSceneObjects(scene,viewport).birds,layout.birds);
    for(const bird of layout.birds)assert.ok(bird.x>viewport.left&&bird.x<viewport.right&&bird.y>viewport.top&&bird.y<viewport.bottom);
  }
});

test('phase dragging projects to the actual piecewise trajectory with screen-distance weighting', () => {
  const points=[{t:0,x:.1,y:.2},{t:.5,x:.5,y:.2},{t:1,x:.5,y:.8}];
  const horizontal=trajectoryPhaseAt(points,{x:.3,y:.24});
  assert.ok(Math.abs(horizontal.t-.25)<1e-10);assert.ok(Math.abs(horizontal.point.x-.3)<1e-10);
  assert.equal(horizontal.point.y,.2);
  assert.deepEqual(trajectoryPhaseAt(points,{x:.5,y:.8}),{t:1,point:{x:.5,y:.8}});
  assert.ok(Object.isFrozen(horizontal)&&Object.isFrozen(horizontal.point));
});
