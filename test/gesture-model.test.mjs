import test from 'node:test';
import assert from 'node:assert/strict';
import {PinchTracker, createHourDrag, createObjectDrag} from '../web/gesture-model.mjs';

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
