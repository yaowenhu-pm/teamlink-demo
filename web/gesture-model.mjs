const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const palmIndices = [0, 5, 9, 13, 17];
const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y)
  && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;

/**
 * Pure, single-hand gesture recognition. Coordinates follow the mirrored preview
 * by default. The cursor uses the palm, so opening the fingers does not drag it.
 * Call update for every detector result, including missing hands; call cancel on
 * stop/blur. This model never starts a camera, hits a scene target or saves data.
 */
export class PinchTracker {
  constructor({mirrorX = true, closeRatio = .32, openRatio = .45, smoothingMs = 60,
    maxGapMs = 250, minConfidence = .65, minPalmSize = .025} = {}) {
    if (typeof mirrorX !== 'boolean' || ![closeRatio, openRatio, smoothingMs, maxGapMs, minConfidence, minPalmSize].every(Number.isFinite)
      || closeRatio <= 0 || openRatio <= closeRatio || smoothingMs < 0 || maxGapMs <= 0
      || minConfidence < 0 || minConfidence > 1 || minPalmSize <= 0 || minPalmSize > 1) {
      throw new RangeError('Invalid pinch tracker options');
    }
    this.options = {mirrorX, closeRatio, openRatio, smoothingMs, maxGapMs, minConfidence, minPalmSize};
    this.active = false;
    this.armed = false;
    this.cursor = null;
    this.timestampMs = null;
    this.handId = null;
  }

  /**
   * Input: {landmarks: [21 normalized {x,y}], timestampMs, width, height,
   * confidence?: 0..1, handId?: string|number}. Alternatively pass hands:[...].
   * Only one hand is accepted. A first closed hand must open before starting.
   * phase: hover | start | move | end | cancel | lost. Only end is a release;
   * cancel/lost must never be interpreted by the caller as a completed drag.
   * pinchProgress is 0 for open and 1 for closed, or null when tracking is lost.
   */
  update(frame = {}) {
    if (!frame || typeof frame !== 'object') return this.cancel('invalid-frame');
    const {timestampMs, width, height, confidence = 1, handId = 'single'} = frame;
    if (!Number.isFinite(timestampMs) || timestampMs < 0) return this.cancel('invalid-time');
    if (this.timestampMs !== null) {
      if (timestampMs <= this.timestampMs) return this.cancel('non-monotonic-time');
      if (timestampMs - this.timestampMs > this.options.maxGapMs) return this.cancel('frame-gap');
    }
    if (![width, height].every(n => Number.isFinite(n) && n > 0)) return this.cancel('invalid-viewport');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return this.cancel('invalid-confidence');
    if (confidence < this.options.minConfidence) return this.cancel('low-confidence');
    if (!['string', 'number'].includes(typeof handId) || (typeof handId === 'number' && !Number.isFinite(handId))) return this.cancel('invalid-hand');
    let landmarks = frame.landmarks;
    if (frame.hands !== undefined) {
      if (!Array.isArray(frame.hands)) return this.cancel('invalid-hands');
      if (frame.hands.length !== 1) return this.cancel(frame.hands.length ? 'multiple-hands' : 'no-hand');
      landmarks = frame.hands[0];
    }
    if (!landmarks) return this.cancel('no-hand');
    if (!Array.isArray(landmarks) || landmarks.length !== 21 || !Array.from(landmarks).every(validPoint)) return this.cancel('invalid-landmarks');
    if (this.handId !== null && this.handId !== handId) return this.cancel('hand-changed');

    // Correct for video aspect ratio without depending on camera distance or
    // overflowing when callers provide very large (but finite) dimensions.
    const longest = Math.max(width, height), sx = width / longest, sy = height / longest;
    const distance = (a, b) => Math.hypot((a.x - b.x) * sx, (a.y - b.y) * sy);
    const palmWidth = distance(landmarks[5], landmarks[17]);
    const palmHeight = distance(landmarks[0], landmarks[9]);
    if (palmWidth < this.options.minPalmSize || palmHeight < this.options.minPalmSize / 2) return this.cancel('unstable-palm');
    const pinchRatio = distance(landmarks[4], landmarks[8]) / palmWidth;
    const palm = palmIndices.reduce((sum, index) => ({x: sum.x + landmarks[index].x / 5, y: sum.y + landmarks[index].y / 5}), {x: 0, y: 0});
    const raw = {x: this.options.mirrorX ? 1 - palm.x : palm.x, y: palm.y};
    const dt = this.timestampMs === null ? 0 : timestampMs - this.timestampMs;
    const alpha = this.options.smoothingMs === 0 ? 1 : -Math.expm1(-dt / this.options.smoothingMs);
    this.cursor = this.cursor ? {x: this.cursor.x + (raw.x - this.cursor.x) * alpha, y: this.cursor.y + (raw.y - this.cursor.y) * alpha} : raw;
    this.timestampMs = timestampMs;
    this.handId = handId;
    let phase = 'hover';
    if (this.active) {
      if (pinchRatio >= this.options.openRatio) {
        this.active = false;
        this.armed = true;
        phase = 'end';
      } else phase = 'move';
    } else if (pinchRatio >= this.options.openRatio) this.armed = true;
    else if (this.armed && pinchRatio <= this.options.closeRatio) {
      this.active = true;
      this.armed = false;
      phase = 'start';
    }
    return {cursor: {...this.cursor}, phase, pinching: this.active, ready: this.armed,
      confidence, lost: false, reason: !this.active && !this.armed ? 'release-to-arm' : null, pinchRatio,
      pinchProgress: clamp((this.options.openRatio - pinchRatio) / (this.options.openRatio - this.options.closeRatio))};
  }

  cancel(reason = 'cancelled') {
    const phase = this.active ? 'cancel' : 'lost';
    this.active = false;
    this.armed = false;
    this.cursor = null;
    this.timestampMs = null;
    this.handId = null;
    return {cursor: null, phase, pinching: false, ready: false, confidence: 0, lost: true, reason, pinchRatio: null, pinchProgress: null};
  }
}

/** Relative hour dragging preserves the initial cursor-to-sun grab offset. */
export function createHourDrag({hoursPerWidth = 24} = {}) {
  if (!Number.isFinite(hoursPerWidth) || hoursPerWidth <= 0) throw new RangeError('Invalid hour drag scale');
  let anchor = null, hour = null;
  const cancel = () => {anchor = null; hour = null; return null;};
  return {
    start(cursor, currentHour) {
      if (!validPoint(cursor) || !Number.isFinite(currentHour) || currentHour < 0 || currentHour > 24) return cancel();
      anchor = {x: cursor.x, hour: currentHour};
      hour = currentHour;
      return hour;
    },
    move(cursor) {
      if (!anchor || !validPoint(cursor)) return cancel();
      hour = clamp(anchor.hour + (cursor.x - anchor.x) * hoursPerWidth, 0, 24);
      return hour;
    },
    end() {const result = hour; cancel(); return result;},
    cancel,
  };
}

/**
 * Relative 2D dragging preserves the cursor-to-object grab offset. Bounds and
 * coordinates are normalized; an initial object outside its bounds is clamped.
 * Only end returns a completed position. Call cancel for a lost/changed hand.
 */
export function createObjectDrag({xBounds = [0, 1], yBounds = [0, 1]} = {}) {
  const validBounds = bounds => Array.isArray(bounds) && bounds.length === 2
    && Array.from(bounds).every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    && bounds[0] <= bounds[1];
  if (!validBounds(xBounds) || !validBounds(yBounds)) throw new RangeError('Invalid object drag bounds');
  const [minX, maxX] = xBounds, [minY, maxY] = yBounds;
  let grab = null, position = null;
  const cancel = () => {grab = null; position = null; return null;};
  return {
    start(cursor, currentAnchor) {
      if (!validPoint(cursor) || !validPoint(currentAnchor)) return cancel();
      position = {x: clamp(currentAnchor.x, minX, maxX), y: clamp(currentAnchor.y, minY, maxY)};
      grab = {cursor: {x: cursor.x, y: cursor.y}, anchor: {...position}};
      return {...position};
    },
    move(cursor) {
      if (!grab || !validPoint(cursor)) return cancel();
      position = {
        x: clamp(grab.anchor.x + (cursor.x - grab.cursor.x), minX, maxX),
        y: clamp(grab.anchor.y + (cursor.y - grab.cursor.y), minY, maxY),
      };
      return {...position};
    },
    end() {const result = position && {...position}; cancel(); return result;},
    cancel,
  };
}
