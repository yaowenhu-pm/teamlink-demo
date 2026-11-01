import test from 'node:test';
import assert from 'node:assert/strict';
import {PinchTracker, GestureTargetTracker, SelectorGestureTracker, createHourDrag, createObjectDrag} from '../web/gesture-model.mjs';

function hand({x = .5, y = .5, ratio = .7, scale = 1} = {}) {
  const points = Array.from({length: 21}, () => ({x, y}));
  for (const [index, dx, dy] of [[0, 0, .12], [5, -.1, -.05], [9, -.03, -.08], [13, .04, -.06], [17, .1, -.02]]) {
    points[index] = {x: x + dx * scale, y: y + dy * scale};
  }
  const width = Math.hypot(.2, .03) * scale;
  points[4] = {x: x - width * ratio / 2, y: y - .1 * scale};
  points[8] = {x: x + width * ratio / 2, y: y - .1 * scale};
  return points;
}
const frame = (timestampMs, options = {}) => ({timestampMs, width: 800, height: 800, landmarks: hand(options)});
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-10, message ?? `${actual} != ${expected}`);

test('a first closed hand must open; hysteresis produces one start and one release', () => {
  const tracker = new PinchTracker({smoothingMs: 0});
  let result = tracker.update(frame(0, {ratio: .2}));
  assert.equal(result.phase, 'hover');
  assert.equal(result.reason, 'release-to-arm');
  assert.equal(result.pinching, false);
  assert.equal(tracker.update(frame(16, {ratio: .7})).ready, true);
  assert.equal(tracker.update(frame(32, {ratio: .4})).phase, 'hover');
  assert.equal(tracker.update(frame(48, {ratio: .3})).phase, 'start');
  assert.equal(tracker.update(frame(64, {ratio: .4})).phase, 'move');
  assert.equal(tracker.update(frame(80, {ratio: .44})).phase, 'move');
  assert.equal(tracker.update(frame(96, {ratio: .46})).phase, 'end');
  assert.equal(tracker.update(frame(112, {ratio: .4})).phase, 'hover');
  assert.equal(tracker.update(frame(128, {ratio: .3})).phase, 'start');
});

test('palm cursor mirrors the preview, ignores fingertip motion, and pinch scales with the palm', () => {
  const mirrored = new PinchTracker({smoothingMs: 0});
  const unmirrored = new PinchTracker({mirrorX: false, smoothingMs: 0});
  const a = mirrored.update(frame(0, {x: .3}));
  const b = unmirrored.update(frame(0, {x: .3}));
  near(a.cursor.x + b.cursor.x, 1);
  near(a.cursor.y, b.cursor.y);
  const pinched = mirrored.update(frame(16, {x: .3, ratio: .2}));
  assert.deepEqual(pinched.cursor, a.cursor, 'closing the fingers leaves the stable palm cursor still');
  assert.equal(pinched.phase, 'start');
  for (const scale of [.5, 1, 1.7]) {
    const result = new PinchTracker().update(frame(0, {ratio: .3, scale}));
    near(result.pinchRatio, .3, 'moving nearer or farther does not change the pinch threshold');
  }
  const wide = frame(0);
  wide.width = 1600;
  wide.landmarks[4] = {x: .5, y: .4};
  wide.landmarks[8] = {x: .5, y: .5};
  near(new PinchTracker().update(wide).pinchRatio, .05 / Math.hypot(.2, .015), 'distance corrects for aspect ratio');
});

test('cursor smoothing follows elapsed time and behaves consistently at different frame rates', () => {
  const sample = (steps, duration) => {
    const tracker = new PinchTracker({mirrorX: false, smoothingMs: 60});
    const initial = tracker.update(frame(0, {x: .3})).cursor;
    let result;
    for (let i = 1; i <= steps; i++) result = tracker.update(frame(duration * i / steps, {x: .7}));
    return {initial, cursor: result.cursor};
  };
  const one = sample(1, 60), four = sample(4, 60);
  near(one.cursor.x, one.initial.x + .4 * (1 - Math.exp(-1)));
  near(one.cursor.x, four.cursor.x);
  assert.ok(one.cursor.x > one.initial.x && one.cursor.x < one.initial.x + .4);
});

test('pinch feedback is bounded across hysteresis without changing gesture phases', () => {
  const tracker = new PinchTracker({smoothingMs: 0});
  assert.equal(tracker.update(frame(0, {ratio: .7})).pinchProgress, 0);
  const middle = tracker.update(frame(16, {ratio: (.32 + .45) / 2}));
  near(middle.pinchProgress, .5);
  assert.equal(middle.phase, 'hover');
  const closed = tracker.update(frame(32, {ratio: .1}));
  assert.equal(closed.pinchProgress, 1);
  assert.equal(closed.phase, 'start');
  const held = tracker.update(frame(48, {ratio: .4}));
  assert.equal(held.phase, 'move');
  assert.ok(held.pinchProgress > 0 && held.pinchProgress < 1);
  const lost = tracker.cancel();
  assert.equal(lost.pinchRatio, null);
  assert.equal(lost.pinchProgress, null);
});

test('a brief confidence dip cannot turn an uncertain release into a commit', () => {
  const tracker = new PinchTracker();
  tracker.update(frame(0));
  tracker.update(frame(16, {ratio: .2}));
  const uncertainRelease = tracker.update({...frame(32), confidence: .64});
  assert.equal(uncertainRelease.phase, 'cancel');
  assert.equal(uncertainRelease.reason, 'low-confidence');
  assert.equal(tracker.update({...frame(48, {ratio: .2}), confidence: .66}).phase, 'hover');
  assert.equal(tracker.update(frame(64)).phase, 'hover', 'an open hand rearms without committing the cancelled drag');
  assert.equal(tracker.update(frame(80, {ratio: .2})).phase, 'start');
});

test('loss, frame gaps, two hands and changed identities cancel without a release or implicit restart', () => {
  for (const interrupt of [
    {timestampMs: 32, width: 800, height: 800, landmarks: null},
    frame(300, {ratio: .2}),
    {...frame(32), hands: [hand(), hand()]},
    {...frame(32), handId: 'another'},
    {...frame(32), confidence: .4},
  ]) {
    const tracker = new PinchTracker();
    tracker.update(frame(0));
    assert.equal(tracker.update(frame(16, {ratio: .2})).phase, 'start');
    const lost = tracker.update(interrupt);
    assert.equal(lost.phase, 'cancel');
    assert.equal(lost.lost, true);
    assert.equal(lost.cursor, null);
    const closed = tracker.update(frame(320, {ratio: .2}));
    assert.equal(closed.phase, 'hover');
    assert.equal(closed.ready, false);
    assert.equal(tracker.update(frame(336)).phase, 'hover');
    assert.equal(tracker.update(frame(352, {ratio: .2})).phase, 'start');
    assert.equal(tracker.cancel('disabled').phase, 'cancel');
    assert.equal(tracker.cancel('disabled').phase, 'lost');
  }
});

test('bad normalized input, invalid viewport/time and degenerate palms never emit unsafe coordinates', () => {
  const badPoint = hand(); badPoint[8].x = NaN;
  const outside = hand(); outside[5].y = 2;
  const flat = Array.from({length: 21}, () => ({x: .5, y: .5}));
  const sparse = hand(); delete sparse[4];
  const cases = [null, {}, {...frame(0), width: 0}, {...frame(0), height: Infinity},
    {...frame(0), timestampMs: NaN}, {...frame(0), confidence: NaN},
    {...frame(0), landmarks: badPoint}, {...frame(0), landmarks: outside},
    {...frame(0), landmarks: flat}, {...frame(0), landmarks: sparse},
    {...frame(0), landmarks: [hand()]}, {...frame(0), hands: []}];
  for (const input of cases) {
    const result = new PinchTracker().update(input);
    assert.equal(result.phase, 'lost');
    assert.equal(result.cursor, null);
    assert.equal(result.pinching, false);
  }
  const tracker = new PinchTracker();
  tracker.update(frame(16));
  tracker.update(frame(32, {ratio: .2}));
  assert.equal(tracker.update(frame(16)).phase, 'cancel', 'time moving backwards cancels');
  assert.throws(() => new PinchTracker({closeRatio: .5, openRatio: .4}), RangeError);
});

test('hover targets must dwell continuously before replacing a stable selection', () => {
  const tracker = new GestureTargetTracker();
  const hover = (timestampMs, targetId) => tracker.update({timestampMs, targetId});
  assert.equal(hover(0, 'sun').selectedTargetId, null);
  near(hover(90, 'sun').hoverProgress, .5);
  assert.equal(hover(179, 'sun').selectedTargetId, null);
  assert.equal(hover(180, 'sun').selectedTargetId, 'sun');
  const candidate = hover(200, 'tree');
  assert.equal(candidate.selectedTargetId, 'sun');
  assert.equal(candidate.changed, false);
  hover(300, 'sun');
  hover(350, 'tree');
  assert.equal(hover(529, 'tree').selectedTargetId, 'sun', 'candidate changes restart the dwell');
  const selected = hover(530, 'tree');
  assert.equal(selected.selectedTargetId, 'tree');
  assert.equal(selected.changed, true);
  assert.equal(hover(550, null).selectedTargetId, 'tree', 'empty background preserves the stable selection');
  hover(600, 'sun');
  hover(650, null);
  assert.equal(hover(780, 'sun').hoverProgress, 0, 'background interrupts the pending dwell');
});

test('a pinch immediately locks the nearest candidate through moves and release', () => {
  const tracker = new GestureTargetTracker();
  tracker.update({timestampMs: 0, targetId: 'sun'});
  tracker.update({timestampMs: 180, targetId: 'sun'});
  const start = tracker.update({timestampMs: 200, targetId: 'tree', phase: 'start'});
  assert.equal(start.selectedTargetId, 'tree', 'a new nearest candidate need not finish a dwell before grabbing');
  assert.equal(start.lockedTargetId, 'tree');
  assert.equal(start.targetId, 'tree');
  assert.equal(tracker.update({timestampMs: 216, targetId: 'house', phase: 'move'}).targetId, 'tree');
  assert.equal(tracker.update({timestampMs: 232, targetId: null, phase: 'move'}).lockedTargetId, 'tree');
  const end = tracker.update({timestampMs: 248, targetId: 'house', phase: 'end'});
  assert.equal(end.targetId, 'tree', 'the release returns the same target for committing');
  assert.equal(end.lockedTargetId, null);
  assert.equal(end.selectedTargetId, 'tree');
  assert.equal(tracker.update({timestampMs: 264, targetId: 'house'}).selectedTargetId, 'tree');
  assert.equal(tracker.update({timestampMs: 444, targetId: 'house'}).selectedTargetId, 'house');
});

test('target locking accepts zero IDs, uses the stable fallback, and cancels without a release target', () => {
  const tracker = new GestureTargetTracker({hoverMs: 0});
  assert.equal(tracker.update({timestampMs: 0, targetId: 0}).selectedTargetId, 0);
  assert.equal(tracker.update({timestampMs: 16, phase: 'start'}).targetId, 0);
  assert.equal(tracker.update({timestampMs: 32, phase: 'cancel'}).targetId, null);
  assert.equal(tracker.update({timestampMs: 48, phase: 'start'}).targetId, null);
  assert.equal(tracker.update({timestampMs: 64, targetId: 'tree', phase: 'move'}).targetId, null, 'a missing start target cannot jump to a new object');
  assert.equal(tracker.update({timestampMs: 80, targetId: 'tree', phase: 'end'}).targetId, null);
  assert.equal(tracker.cancel('disabled').selectedTargetId, null);
});

test('invalid target frames, gaps, and impossible pinch transitions clear selection and locks', () => {
  for (const invalid of [null, {}, {timestampMs: NaN}, {timestampMs: -1},
    {timestampMs: 32, targetId: ''}, {timestampMs: 32, targetId: {}}, {timestampMs: 32, targetId: Infinity},
    {timestampMs: 32, phase: 'unknown'}, {timestampMs: 32, phase: 'hover'},
    {timestampMs: 32, phase: 'start'}, {timestampMs: 0, phase: 'move'},
    {timestampMs: 300, phase: 'move'}, {timestampMs: 32, phase: 'lost'}]) {
    const tracker = new GestureTargetTracker({hoverMs: 0});
    tracker.update({timestampMs: 0, targetId: 'sun'});
    tracker.update({timestampMs: 16, targetId: 'sun', phase: 'start'});
    const result = tracker.update(invalid);
    assert.equal(result.targetId, null);
    assert.equal(result.selectedTargetId, null);
    assert.equal(result.lockedTargetId, null);
    assert.ok(result.reason);
  }
  for (const phase of ['move', 'end']) {
    assert.equal(new GestureTargetTracker().update({timestampMs: 0, targetId: 'sun', phase}).reason, 'invalid-transition');
  }
  for (const options of [{hoverMs: -1}, {hoverMs: Infinity}, {maxGapMs: 0}, {maxGapMs: NaN}]) {
    assert.throws(() => new GestureTargetTracker(options), RangeError);
  }
});

function selectorHand({pose = 'v', angle = 0, scale = 1, mirror = false, aspect = 1} = {}) {
  const points = [
    [.5, .8], [.43, .76], [.38, .73], [.36, .7], [.34, .67],
    [.42, .62], [.4, .46], [.38, .36], [.36, .27],
    [.49, .59], [.5, .43], [.51, .32], [.52, .22],
    [.56, .61], [.58, .48], [.6, .56], [.57, .61],
    [.63, .65], [.66, .55], [.67, .62], [.64, .67],
  ];
  if (pose === 'open') {
    points[14] = [.58, .47]; points[15] = [.6, .37]; points[16] = [.62, .28];
    points[18] = [.67, .52]; points[19] = [.7, .43]; points[20] = [.73, .35];
  } else if (pose === 'fist') {
    points[6] = [.4, .48]; points[7] = [.4, .56]; points[8] = [.43, .64];
    points[10] = [.49, .45]; points[11] = [.49, .53]; points[12] = [.5, .61];
  } else if (pose === 'point') {
    points[10] = [.49, .45]; points[11] = [.49, .53]; points[12] = [.5, .61];
  } else if (pose === 'pinch') {
    points[4] = [.36, .29];
  } else if (pose === 'unseparated') {
    points[6] = [.45, .46]; points[7] = [.47, .34]; points[8] = [.49, .23];
  }
  return points.map(([x, y]) => {
    const dx = (x - .5) * scale * (mirror ? -1 : 1), dy = (y - .5) * scale;
    return {x: .5 + (dx * Math.cos(angle) - dy * Math.sin(angle)) / aspect,
      y: .5 + dx * Math.sin(angle) + dy * Math.cos(angle)};
  });
}
const selectorFrame = (timestampMs, options = {}) => ({timestampMs, width: 800 * (options.aspect ?? 1), height: 800,
  landmarks: selectorHand(options)});
const armSelector = (tracker, start = 0) => {
  tracker.update(selectorFrame(start, {pose: 'open'}));
  return tracker.update(selectorFrame(start + 160, {pose: 'open'}));
};
const holdSelector = (tracker, start = 176, options = {}) => {
  let result;
  for (let elapsed = 0; elapsed <= 500; elapsed += 125) result = tracker.update(selectorFrame(start + elapsed, options));
  return result;
};

test('a V must first release, then hold for 500ms, and cannot retrigger while held', () => {
  const tracker = new SelectorGestureTracker();
  for (let timestampMs = 0; timestampMs <= 625; timestampMs += 125) {
    const result = tracker.update(selectorFrame(timestampMs));
    assert.equal(result.triggered, false);
    assert.equal(result.reason, 'release-to-arm');
  }
  assert.equal(armSelector(tracker, 641).ready, true);
  const start = tracker.update(selectorFrame(817));
  assert.equal(start.phase, 'holding');
  assert.equal(start.progress, 0);
  near(tracker.update(selectorFrame(942)).progress, .25);
  tracker.update(selectorFrame(1067));
  tracker.update(selectorFrame(1192));
  assert.equal(tracker.update(selectorFrame(1316)).triggered, false);
  const triggered = tracker.update(selectorFrame(1317));
  assert.equal(triggered.phase, 'trigger');
  assert.equal(triggered.triggered, true);
  assert.equal(triggered.progress, 1);
  for (let timestampMs = 1442; timestampMs < 2817; timestampMs += 125) {
    assert.equal(tracker.update(selectorFrame(timestampMs)).triggered, false);
  }
});

test('V geometry handles rotation, mirroring, hand size, and camera aspect ratio', () => {
  for (const options of [{}, {angle: Math.PI / 2}, {angle: Math.PI}, {angle: -Math.PI / 3},
    {mirror: true}, {scale: .5}, {scale: 1.4}, {aspect: 2}, {aspect: .75, mirror: true}]) {
    const tracker = new SelectorGestureTracker();
    armSelector(tracker);
    assert.equal(holdSelector(tracker, 176, options).triggered, true, JSON.stringify(options));
  }
});

test('an open hand, fist, point, pinch, or two unseparated fingers cannot open the selector', () => {
  for (const pose of ['open', 'fist', 'point', 'pinch', 'unseparated']) {
    const tracker = new SelectorGestureTracker();
    armSelector(tracker);
    const result = holdSelector(tracker, 176, {pose});
    assert.equal(result.pose, false, pose);
    assert.equal(result.triggered, false, pose);
  }
  const tracker = new SelectorGestureTracker();
  armSelector(tracker);
  const collapsed = selectorHand(); collapsed[7] = collapsed[6];
  assert.equal(tracker.update({...selectorFrame(176), landmarks: collapsed}).pose, false, 'collapsed finger segments are ambiguous');
});

test('short pose interruptions restart the full hold and short release flickers do not rearm it', () => {
  const tracker = new SelectorGestureTracker();
  armSelector(tracker);
  tracker.update(selectorFrame(176));
  tracker.update(selectorFrame(301));
  tracker.update(selectorFrame(426, {pose: 'open'}));
  assert.equal(tracker.update(selectorFrame(442)).progress, 0);
  tracker.update(selectorFrame(567));
  tracker.update(selectorFrame(692));
  tracker.update(selectorFrame(817));
  assert.equal(tracker.update(selectorFrame(942)).triggered, true);
  tracker.update(selectorFrame(958, {pose: 'open'}));
  tracker.update(selectorFrame(1100, {pose: 'open'}));
  assert.equal(tracker.update(selectorFrame(1110)).ready, false, 'a release shorter than 160ms cannot rearm');
  assert.equal(tracker.update(selectorFrame(1235)).triggered, false);
});

test('release and cooldown both gate another trigger, and losing tracking cannot bypass cooldown', () => {
  const tracker = new SelectorGestureTracker({cooldownMs: 1500});
  armSelector(tracker);
  assert.equal(holdSelector(tracker).triggered, true); // 676ms
  tracker.cancel('no-hand');
  armSelector(tracker, 692);
  assert.equal(holdSelector(tracker, 868).triggered, false); // 1368ms
  let result;
  for (let timestampMs = 1493; timestampMs <= 2118; timestampMs += 125) result = tracker.update(selectorFrame(timestampMs));
  assert.equal(result.reason, 'cooldown');
  assert.equal(tracker.update(selectorFrame(2175)).triggered, false);
  assert.equal(tracker.update(selectorFrame(2176)).triggered, true);
  tracker.update(selectorFrame(2192, {pose: 'open'}));
  assert.equal(tracker.update(selectorFrame(2352, {pose: 'open'})).ready, true);
});

test('pinching cancels a pending selector and requires a fresh non-V release', () => {
  const tracker = new SelectorGestureTracker();
  armSelector(tracker);
  tracker.update(selectorFrame(176));
  tracker.update(selectorFrame(301));
  const pinching = tracker.update({...selectorFrame(426), pinching: true});
  assert.equal(pinching.phase, 'idle');
  assert.equal(pinching.reason, 'pinching');
  assert.equal(pinching.ready, false);
  assert.equal(tracker.update(selectorFrame(551)).phase, 'held');
  assert.equal(holdSelector(tracker, 676).triggered, false);
  armSelector(tracker, 1192);
  assert.equal(holdSelector(tracker, 1368).triggered, true);
});

test('lost, uncertain, changed, or multiple hands discard the selector hold without triggering', () => {
  for (const interrupt of [
    {...selectorFrame(320), landmarks: null}, selectorFrame(600),
    {...selectorFrame(320), hands: [selectorHand(), selectorHand()]},
    {...selectorFrame(320), confidence: .64}, {...selectorFrame(320), handId: 'other'},
    {...selectorFrame(320), timestampMs: 176},
  ]) {
    const tracker = new SelectorGestureTracker();
    armSelector(tracker);
    tracker.update(selectorFrame(176));
    tracker.update(selectorFrame(301));
    const result = tracker.update(interrupt);
    assert.equal(result.phase, 'lost');
    assert.equal(result.triggered, false);
    assert.equal(result.progress, 0);
    assert.equal(tracker.update(selectorFrame(700)).phase, 'held', 'a recovered V does not count as release');
    assert.equal(holdSelector(tracker, 825).triggered, false);
    armSelector(tracker, 1341);
    assert.equal(holdSelector(tracker, 1517).triggered, true);
  }
});

test('selector rejects malformed normalized landmarks, metadata, and timing', () => {
  const bad = selectorHand(); bad[12].x = NaN;
  const outside = selectorHand(); outside[5].y = 1.1;
  const sparse = selectorHand(); delete sparse[4];
  const flat = Array.from({length: 21}, () => ({x: .5, y: .5}));
  const cases = [null, {}, {...selectorFrame(0), width: 0}, {...selectorFrame(0), height: Infinity},
    {...selectorFrame(0), timestampMs: NaN}, {...selectorFrame(0), timestampMs: -1},
    {...selectorFrame(0), confidence: NaN}, {...selectorFrame(0), confidence: 1.1},
    {...selectorFrame(0), handId: {}}, {...selectorFrame(0), handId: Infinity},
    {...selectorFrame(0), pinching: 'true'}, {...selectorFrame(0), landmarks: bad},
    {...selectorFrame(0), landmarks: outside}, {...selectorFrame(0), landmarks: sparse},
    {...selectorFrame(0), landmarks: flat}, {...selectorFrame(0), landmarks: [selectorHand()]},
    {...selectorFrame(0), hands: []}, {...selectorFrame(0), hands: {}},
  ];
  for (const input of cases) {
    const result = new SelectorGestureTracker().update(input);
    assert.equal(result.phase, 'lost');
    assert.equal(result.triggered, false);
    assert.equal(result.ready, false);
    assert.equal(result.progress, 0);
  }
  const tracker = new SelectorGestureTracker();
  tracker.update({...selectorFrame(0), hands: [selectorHand({pose: 'open'})]});
  assert.equal(tracker.update({...selectorFrame(160), hands: [selectorHand({pose: 'open'})]}).ready, true, 'one-hand array input is supported');
  for (const options of [{holdMs: 0}, {holdMs: NaN}, {releaseMs: 0}, {cooldownMs: -1},
    {maxGapMs: 0}, {minConfidence: 1.1}, {minPalmSize: 0}]) {
    assert.throws(() => new SelectorGestureTracker(options), RangeError);
  }
});

test('hour dragging preserves the grab offset, clamps 0–24, and cancels without returning a saved hour', () => {
  const drag = createHourDrag();
  assert.equal(drag.move({x: .5, y: .5}), null);
  assert.equal(drag.start({x: .7, y: .3}, 13), 13);
  assert.equal(drag.move({x: .7, y: .3}), 13, 'first pinch does not jump to an absolute hour');
  near(drag.move({x: .8, y: .3}), 15.4);
  assert.equal(drag.move({x: 0, y: .3}), 0);
  near(drag.move({x: 1, y: .3}), 20.2);
  assert.equal(drag.cancel(), null);
  assert.equal(drag.end(), null);
  drag.start({x: .1, y: .3}, 23);
  assert.equal(drag.move({x: .9, y: .3}), 24);
  assert.equal(drag.end(), 24);
  assert.equal(drag.move({x: .5, y: .5}), null);
  assert.equal(drag.start({x: NaN, y: .3}, 13), null);
  assert.equal(drag.start({x: .5, y: .3}, -1), null);
});

test('object dragging keeps the grab offset and returns a completed relative 2D position', () => {
  const drag = createObjectDrag();
  assert.equal(drag.move({x: .5, y: .5}), null);
  const cursor = {x: .7, y: .3}, anchor = {x: .4, y: .6};
  assert.deepEqual(drag.start(cursor, anchor), anchor);
  assert.deepEqual(drag.move(cursor), anchor, 'pinching away from the anchor does not jump the object');
  const moved = drag.move({x: .8, y: .5});
  near(moved.x, .5);
  near(moved.y, .8);
  assert.deepEqual(drag.end(), moved);
  assert.equal(drag.end(), null);
  assert.equal(drag.move(cursor), null);
});

test('object bounds clamp both axes while keeping the original grab offset at edges', () => {
  const drag = createObjectDrag({xBounds: [.1, .9], yBounds: [.52, .9]});
  drag.start({x: .5, y: .5}, {x: .6, y: .7});
  assert.deepEqual(drag.move({x: 1, y: 1}), {x: .9, y: .9});
  assert.deepEqual(drag.move({x: 0, y: 0}), {x: .1, y: .52});
  const returned = drag.move({x: .5, y: .5});
  near(returned.x, .6);
  near(returned.y, .7);
  assert.deepEqual(drag.start({x: .4, y: .4}, {x: 0, y: 1}), {x: .1, y: .9}, 'a normalized initial anchor is constrained to the visible area');
  assert.deepEqual(drag.move({x: .4, y: .4}), {x: .1, y: .9});
});

test('object drag snapshots cannot be mutated by the caller', () => {
  const xBounds = [.1, .9], yBounds = [.52, .9];
  const drag = createObjectDrag({xBounds, yBounds});
  const cursor = {x: .5, y: .5}, anchor = {x: .6, y: .7};
  const start = drag.start(cursor, anchor);
  cursor.x = 0; anchor.y = 0; start.x = 0; xBounds[1] = .2; yBounds[1] = .6;
  const moved = drag.move({x: 1, y: 1});
  assert.deepEqual(moved, {x: .9, y: .9});
  moved.x = 0;
  assert.deepEqual(drag.end(), {x: .9, y: .9});
});

test('object dragging rejects invalid coordinates and cancels without completing a drag', () => {
  const drag = createObjectDrag();
  const point = {x: .5, y: .5};
  for (const invalid of [null, {}, {x: NaN, y: .5}, {x: .5, y: Infinity}, {x: -.1, y: .5}, {x: .5, y: 1.1}]) {
    drag.start(point, point);
    assert.equal(drag.move(invalid), null);
    assert.equal(drag.end(), null, 'invalid motion discards the last valid position');
    drag.start(point, point);
    assert.equal(drag.start(invalid, point), null);
    assert.equal(drag.end(), null);
    drag.start(point, point);
    assert.equal(drag.start(point, invalid), null);
    assert.equal(drag.end(), null);
  }
  drag.start(point, point);
  drag.move({x: .6, y: .7});
  assert.equal(drag.cancel(), null);
  assert.equal(drag.end(), null);
  assert.equal(drag.move(point), null);
  assert.equal(drag.cancel(), null);
});

test('object dragging rejects malformed bounds and supports a fixed axis', () => {
  for (const bounds of [null, {}, [], [0], [0, 1, 1], [, 1], [NaN, 1], [0, Infinity], [-.1, 1], [0, 1.1], [.9, .1]]) {
    assert.throws(() => createObjectDrag({xBounds: bounds}), RangeError);
    assert.throws(() => createObjectDrag({yBounds: bounds}), RangeError);
  }
  const drag = createObjectDrag({xBounds: [.5, .5]});
  assert.deepEqual(drag.start({x: .3, y: .5}, {x: .2, y: .6}), {x: .5, y: .6});
  const moved = drag.move({x: .9, y: .7});
  assert.equal(moved.x, .5);
  near(moved.y, .8);
});
