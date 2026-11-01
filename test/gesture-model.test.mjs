import test from 'node:test';
import assert from 'node:assert/strict';
import {PinchTracker, createHourDrag} from '../web/gesture-model.mjs';

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
