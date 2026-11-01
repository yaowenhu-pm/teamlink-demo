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

const validTargetId = value => value === null || (typeof value === 'string' && value.length > 0)
  || (typeof value === 'number' && Number.isFinite(value));
const targetPhases = new Set(['hover', 'start', 'move', 'end', 'cancel', 'lost']);

/**
 * Pure target selection; the caller supplies its nearest eligible scene target.
 * Hover must remain on the same candidate for hoverMs before changing selection.
 * A pinch start immediately takes the current candidate, or the stable selection
 * when the current hit test is empty. The chosen target cannot change until end.
 * On end, targetId is the released target and lockedTargetId is already null.
 * cancel/lost clear all targets and never return a target to commit.
 */
export class GestureTargetTracker {
  constructor({hoverMs = 180, maxGapMs = 250} = {}) {
    if (![hoverMs, maxGapMs].every(Number.isFinite) || hoverMs < 0 || maxGapMs <= 0) {
      throw new RangeError('Invalid gesture target options');
    }
    this.options = {hoverMs, maxGapMs};
    this.cancel();
  }

  update(frame = {}) {
    if (!frame || typeof frame !== 'object') return this.cancel('invalid-frame');
    const {timestampMs, targetId = null, phase = 'hover'} = frame;
    if (!Number.isFinite(timestampMs) || timestampMs < 0) return this.cancel('invalid-time');
    if (!validTargetId(targetId)) return this.cancel('invalid-target');
    if (!targetPhases.has(phase)) return this.cancel('invalid-phase');
    if (phase === 'cancel' || phase === 'lost') return this.cancel(phase);
    if (this.timestampMs !== null) {
      if (timestampMs <= this.timestampMs) return this.cancel('non-monotonic-time');
      if (timestampMs - this.timestampMs > this.options.maxGapMs) return this.cancel('frame-gap');
    }
    if ((this.active && (phase === 'start' || phase === 'hover'))
      || (!this.active && (phase === 'move' || phase === 'end'))) return this.cancel('invalid-transition');
    this.timestampMs = timestampMs;
    const previous = this.selectedTargetId;
    let effectiveTarget = this.selectedTargetId, hoverProgress = 0;
    if (phase === 'start') {
      this.active = true;
      this.lockedTargetId = targetId ?? this.selectedTargetId;
      this.selectedTargetId = this.lockedTargetId;
      this.candidateTargetId = null;
      this.candidateSince = null;
      effectiveTarget = this.lockedTargetId;
    } else if (this.active) {
      effectiveTarget = this.lockedTargetId;
      if (phase === 'end') {
        this.active = false;
        this.lockedTargetId = null;
      }
    } else if (targetId === null) {
      this.candidateTargetId = null;
      this.candidateSince = null;
    } else {
      if (targetId !== this.candidateTargetId) {
        this.candidateTargetId = targetId;
        this.candidateSince = timestampMs;
      }
      hoverProgress = this.options.hoverMs === 0 ? 1 : clamp((timestampMs - this.candidateSince) / this.options.hoverMs);
      if (hoverProgress === 1) this.selectedTargetId = targetId;
      effectiveTarget = this.selectedTargetId;
    }
    return {targetId: effectiveTarget, selectedTargetId: this.selectedTargetId, lockedTargetId: this.lockedTargetId,
      hoverProgress, changed: previous !== this.selectedTargetId, reason: null};
  }

  cancel(reason = 'cancelled') {
    this.selectedTargetId = null;
    this.lockedTargetId = null;
    this.candidateTargetId = null;
    this.candidateSince = null;
    this.timestampMs = null;
    this.active = false;
    return {targetId: null, selectedTargetId: null, lockedTargetId: null, hoverProgress: 0, changed: false, reason};
  }
}

// Geometry is independent of screen orientation and hand size. A conservative
// V requires two straight, separated fingers and two visibly curled fingers;
// ambiguous foreshortened hands simply do not activate the selector.
const selectorPose = (landmarks, distance, palmWidth, kind) => {
  const vector = (a, b) => ({x: b.x - a.x, y: b.y - a.y});
  const aligned = (a, b, c) => {
    const u = vector(a, b), v = vector(b, c);
    return (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)) >= .6;
  };
  const finger = (mcp, pip, dip, tip) => {
    const points = [mcp, pip, dip, tip].map(index => landmarks[index]);
    const segments = points.slice(1).map((point, index) => distance(points[index], point));
    if (segments.some(length => length < palmWidth * .06)) return {straight: false, curled: false};
    const reach = distance(points[0], points[3]), path = segments.reduce((sum, length) => sum + length, 0);
    const tipFromWrist = distance(landmarks[0], points[3]), pipFromWrist = distance(landmarks[0], points[1]);
    return {
      straight: reach / path >= .86 && reach >= palmWidth * .75
        && aligned(points[0], points[1], points[2]) && aligned(points[1], points[2], points[3])
        && tipFromWrist >= pipFromWrist + palmWidth * .2,
      curled: reach / path <= .78 && reach <= palmWidth * .85
        && tipFromWrist <= pipFromWrist + palmWidth * .15,
    };
  };
  const common = finger(5, 6, 7, 8).straight && finger(9, 10, 11, 12).straight
    && finger(17, 18, 19, 20).curled
    && distance(landmarks[8], landmarks[12]) >= palmWidth * .55
    && distance(landmarks[4], landmarks[8]) >= palmWidth * .6;
  if (!common) return false;
  if (kind === 'three') return finger(13, 14, 15, 16).straight
    && distance(landmarks[12], landmarks[16]) >= palmWidth * .4
    && distance(landmarks[8], landmarks[16]) >= palmWidth * .8;
  return finger(13, 14, 15, 16).curled;
};

/**
 * Shared timer for the built-in V and three-finger poses. Input matches
 * PinchTracker's frame, with optional pinching:boolean from that tracker.
 * Initial appearance and tracking loss require a valid non-matching release before
 * arming. A held pose cannot repeat; releaseMs and cooldownMs must both pass.
 * A pinch suppresses recognition and discards the pending hold. This tracker
 * never changes PinchTracker's state or treats a lost hand as a release.
 */
class HeldGestureTracker {
  #poseKind;
  constructor({holdMs = 500, releaseMs = 160, cooldownMs = 700, maxGapMs = 250,
    minConfidence = .65, minPalmSize = .025} = {}, poseKind) {
    if (![holdMs, releaseMs, cooldownMs, maxGapMs, minConfidence, minPalmSize].every(Number.isFinite)
      || holdMs <= 0 || releaseMs <= 0 || cooldownMs < 0 || maxGapMs <= 0
      || minConfidence < 0 || minConfidence > 1 || minPalmSize <= 0 || minPalmSize > 1) {
      throw new RangeError('Invalid selector gesture options');
    }
    this.#poseKind = poseKind;
    this.options = {holdMs, releaseMs, cooldownMs, maxGapMs, minConfidence, minPalmSize};
    this.lastTriggeredAt = null;
    this.cancel();
  }

  update(frame = {}) {
    if (!frame || typeof frame !== 'object') return this.cancel('invalid-frame');
    const {timestampMs, width, height, confidence = 1, handId = 'single', pinching = false} = frame;
    if (!Number.isFinite(timestampMs) || timestampMs < 0) return this.cancel('invalid-time');
    if (this.timestampMs !== null) {
      if (timestampMs <= this.timestampMs) return this.cancel('non-monotonic-time');
      if (timestampMs - this.timestampMs > this.options.maxGapMs) return this.cancel('frame-gap');
    }
    if (![width, height].every(value => Number.isFinite(value) && value > 0)) return this.cancel('invalid-viewport');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return this.cancel('invalid-confidence');
    if (confidence < this.options.minConfidence) return this.cancel('low-confidence');
    if (typeof pinching !== 'boolean') return this.cancel('invalid-pinch');
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
    const longest = Math.max(width, height), sx = width / longest, sy = height / longest;
    const corrected = landmarks.map(point => ({x: point.x * sx, y: point.y * sy}));
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const palmWidth = distance(corrected[5], corrected[17]);
    if (palmWidth < this.options.minPalmSize || distance(corrected[0], corrected[9]) < this.options.minPalmSize / 2) return this.cancel('unstable-palm');
    this.timestampMs = timestampMs;
    this.handId = handId;
    if (pinching) {
      this.armed = false;
      this.holdSince = null;
      this.releaseSince = null;
      return {phase: 'idle', triggered: false, progress: 0, ready: false, pose: false, reason: 'pinching'};
    }
    const pose = selectorPose(corrected, distance, palmWidth, this.#poseKind);
    if (!pose) {
      this.holdSince = null;
      if (this.releaseSince === null) this.releaseSince = timestampMs;
      if (timestampMs - this.releaseSince >= this.options.releaseMs) this.armed = true;
      return {phase: 'idle', triggered: false, progress: 0, ready: this.armed, pose: false,
        reason: this.armed ? null : 'release-to-arm'};
    }
    this.releaseSince = null;
    if (!this.armed) return {phase: 'held', triggered: false, progress: 0, ready: false, pose: true, reason: 'release-to-arm'};
    if (this.holdSince === null) this.holdSince = timestampMs;
    const progress = clamp((timestampMs - this.holdSince) / this.options.holdMs);
    const cooling = this.lastTriggeredAt !== null && timestampMs - this.lastTriggeredAt < this.options.cooldownMs;
    if (progress === 1 && !cooling) {
      this.lastTriggeredAt = timestampMs;
      this.armed = false;
      this.holdSince = null;
      return {phase: 'trigger', triggered: true, progress: 1, ready: false, pose: true, reason: null};
    }
    return {phase: 'holding', triggered: false, progress, ready: true, pose: true, reason: cooling ? 'cooldown' : null};
  }

  cancel(reason = 'cancelled') {
    this.timestampMs = null;
    this.handId = null;
    this.armed = false;
    this.holdSince = null;
    this.releaseSince = null;
    return {phase: 'lost', triggered: false, progress: 0, ready: false, pose: false, reason};
  }
}

/** V gesture: the existing selector timing and result contract. */
export class SelectorGestureTracker extends HeldGestureTracker {
  constructor(options = {}) { super(options, 'v'); }
}

/**
 * Three separated, straight fingers (index, middle, ring), curled little finger,
 * and thumb away from the index tip. Holds for 650ms to request a mode change.
 * Shares the selector's release, cooldown, confidence and cancellation contract;
 * it does not choose a scene mode or modify the pinch tracker itself.
 */
export class ModeGestureTracker extends HeldGestureTracker {
  constructor({holdMs = 650, ...options} = {}) { super({holdMs, ...options}, 'three'); }
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
