/** Lab-only presentation offsets. They never enter the shared scene schema. */
const NS = 'http://www.w3.org/2000/svg';
const GROUPS = Object.freeze({stars: '星群', distant: '远山', foreground: '前岸', water: '水纹', reflection: '倒影'});
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = value => (Math.abs(value) < 1e9 ? Math.round(value * 1e6) / 1e6 : value) || 0;
const empty = () => Object.freeze({});

function record(value, label) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain data object.`);
  }
  const fields = Reflect.ownKeys(value);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} must contain only enumerable data properties.`);
    }
  }
  return fields;
}

function targetId(id) {
  if (typeof id !== 'string' || !/^decor:(?:(?:flower|cloud):(0|[1-9]\d{0,2})|stars|distant|foreground|water|reflection)$/u.test(id)) {
    throw new RangeError('Unknown decor target.');
  }
  return id;
}

function checkedPoint(value, label, low, high) {
  const fields = record(value, label);
  if (fields.length !== 2 || !fields.includes('x') || !fields.includes('y')
    || ![value.x, value.y].every(number => Number.isFinite(number) && number >= low && number <= high)) {
    throw new RangeError(`${label} must contain finite x/y in ${low}..${high}.`);
  }
  return Object.freeze({x: round(value.x), y: round(value.y)});
}

function checkedOffsets(value) {
  const keys = record(value, 'Decor offsets');
  // Bounded independently of the renderer; rejects unexpectedly large snapshots.
  if (keys.length > 2005) throw new RangeError('Too many decor offsets.');
  return Object.freeze(Object.fromEntries(keys.map(key => [targetId(key), checkedPoint(value[key], 'Decor offset', -1, 1)])));
}

/**
 * Always pass the offsets and cursor captured at grab start. Returned snapshots
 * are deeply frozen and independent, so undo/cancel can retain them directly.
 * Offset components are signed fractions of the visible canvas, limited to one
 * canvas in either direction; cursor points themselves must be inside 0..1.
 */
export function dragDecorOffset(baseOffsets, id, start, current) {
  const offsets = checkedOffsets(baseOffsets), key = targetId(id);
  const from = checkedPoint(start, 'Start cursor', 0, 1), to = checkedPoint(current, 'Current cursor', 0, 1);
  const before = offsets[key] ?? {x: 0, y: 0};
  return Object.freeze({...offsets, [key]: Object.freeze({
    x: round(clamp(before.x + to.x - from.x, -1, 1)),
    y: round(clamp(before.y + to.y - from.y, -1, 1)),
  })});
}

function visibleCamera(svg, options) {
  if (!options || typeof options !== 'object') throw new TypeError('Decor viewport must be an object.');
  const supplied = options.camera;
  if (supplied !== undefined) {
    const fields = record(supplied, 'Decor camera');
    if (fields.length !== 4 || !['left', 'right', 'top', 'bottom'].every(key => fields.includes(key) && Number.isFinite(supplied[key]))
      || supplied.right <= supplied.left || supplied.bottom <= supplied.top) throw new RangeError('Invalid decor camera.');
    const width = supplied.right - supplied.left, height = supplied.bottom - supplied.top;
    if (![width, height].every(Number.isFinite)) throw new RangeError('Invalid decor camera span.');
    return {width, height};
  }
  if (options.width !== undefined || options.height !== undefined) {
    if (![options.width, options.height].every(value => Number.isFinite(value) && value > 0)) throw new RangeError('Invalid decor viewport dimensions.');
    return {width: options.width, height: options.height};
  }
  const viewBox = svg.viewBox?.baseVal;
  const raw = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/u).map(Number);
  const width = viewBox?.width > 0 ? viewBox.width : raw.length === 4 && raw[2] > 0 ? raw[2] : 1600;
  const height = viewBox?.height > 0 ? viewBox.height : raw.length === 4 && raw[3] > 0 ? raw[3] : 1000;
  const bounds = svg.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0
    ? {width: Math.min(width, height * bounds.width / bounds.height), height: Math.min(height, width * bounds.height / bounds.width)}
    : {width, height};
}

function intersect(a, b) {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? {left, top, right, bottom} : null;
}

function screenRect(rect) {
  const left = rect?.left ?? rect?.x, top = rect?.top ?? rect?.y;
  const right = rect?.right ?? left + rect?.width, bottom = rect?.bottom ?? top + rect?.height;
  return [left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top ? {left, top, right, bottom} : null;
}

/**
 * Adds only new wrapper groups. Renderer-owned nodes keep their own transforms,
 * names, listeners and descendant selectors. Whole-layer wrappers go INSIDE the
 * layer, leaving water/reflection clip paths fixed. Call apply after render:
 * geometry innerHTML replacements are detected by identity and wrapped once.
 */
export function mountGestureDecor(svg) {
  if (svg?.namespaceURI !== NS || svg.localName !== 'svg' || !svg.ownerDocument?.createElementNS) {
    throw new TypeError('mountGestureDecor requires an SVG element.');
  }
  let offsets = empty(), viewport = visibleCamera(svg, {}), destroyed = false;
  let entries = [];
  const makeWrapper = id => {
    const wrapper = svg.ownerDocument.createElementNS(NS, 'g');
    wrapper.setAttribute('data-gesture-decor', id);
    return wrapper;
  };
  const ownWrapper = (node, id) => node?.localName === 'g' && node.getAttribute('data-gesture-decor') === id;

  function wrapItem(node, id) {
    const parent = node.parentNode;
    if (ownWrapper(parent, id)) return parent;
    const wrapper = makeWrapper(id);
    parent.insertBefore(wrapper, node); wrapper.appendChild(node);
    return wrapper;
  }

  function wrapLayer(layer, id) {
    let wrapper = Array.from(layer.children).find(child => ownWrapper(child, id));
    if (!wrapper) { wrapper = makeWrapper(id); layer.appendChild(wrapper); }
    for (const child of Array.from(layer.children)) if (child !== wrapper) wrapper.appendChild(child);
    return wrapper;
  }

  function reconcile() {
    const next = [];
    for (const [layerName, kind, label, selector] of [
      ['flowers', 'flower', '花朵', '[data-object="flower"]'],
      ['clouds', 'cloud', '云', 'path'],
    ]) {
      const layer = svg.querySelector(`[data-layer="${layerName}"]`);
      if (!layer) continue;
      Array.from(layer.querySelectorAll(selector)).forEach((node, index) => {
        const id = `decor:${kind}:${index}`;
        next.push({id, kind, label: `${label} ${index + 1}`, wrapper: wrapItem(node, id), requireExplicit: false});
      });
    }
    for (const [kind, label] of Object.entries(GROUPS)) {
      const layer = svg.querySelector(`[data-layer="${kind}"]`);
      if (!layer) continue;
      const id = `decor:${kind}`, companions = [];
      // The renderer keeps the foreground's grass/grain in another layer, and
      // writes its responsive shift directly to this named descendant. Move an
      // outer wrapper with the shore so these marks do not float in mid-water.
      if (kind === 'foreground') {
        const detailLayer = svg.querySelector('[data-layer="land-details"]');
        const detail = detailLayer?.querySelector('[data-detail="foreground"]');
        if (detail) companions.push(wrapItem(detail, id));
      }
      next.push({id, kind, label, wrapper: wrapLayer(layer, id), companions, requireExplicit: true});
    }
    entries = next;
  }

  function apply(nextOffsets = {}, options = {}) {
    const snapshot = checkedOffsets(nextOffsets), nextViewport = visibleCamera(svg, options);
    if (destroyed) throw new Error('Gesture decor has been destroyed.');
    offsets = snapshot; viewport = nextViewport; reconcile();
    for (const {id, wrapper, companions = []} of entries) {
      const offset = offsets[id] ?? {x: 0, y: 0};
      const transform = `translate(${round(offset.x * viewport.width)} ${round(offset.y * viewport.height)})`;
      for (const node of [wrapper, ...companions]) if (node.getAttribute('transform') !== transform) node.setAttribute('transform', transform);
    }
    return offsets;
  }

  function visible(node, cache) {
    for (let current = node; current; current = current.parentNode) {
      if (current.nodeType !== 1) continue;
      let result = cache.get(current);
      if (result === undefined) {
        const computed = svg.ownerDocument.defaultView?.getComputedStyle?.(current);
        const opacity = computed?.opacity || current.style?.opacity || current.getAttribute('opacity');
        result = !current.hasAttribute('hidden') && current.style?.display !== 'none'
          && computed?.display !== 'none' && !['hidden', 'collapse'].includes(computed?.visibility || current.style?.visibility)
          && !(opacity !== null && opacity !== '' && Number(opacity) === 0);
        cache.set(current, result);
      }
      if (!result) return false;
      if (current === svg) break;
    }
    return true;
  }

  // Clip paths do not change getBoundingClientRect. The scene uses fixed,
  // axis-aligned userSpaceOnUse water rectangles; include those in hit geometry.
  function clippedRect(entry, rect) {
    for (let node = entry.wrapper.parentNode; node && node !== svg; node = node.parentNode) {
      const reference = node.getAttribute?.('clip-path')?.match(/^url\(["']?#([^"')]+)["']?\)$/u);
      if (!reference) continue;
      const clip = Array.from(svg.querySelectorAll('clipPath')).find(candidate => candidate.getAttribute('id') === reference[1]);
      const clipRect = clip?.querySelector('rect'), matrix = node.getScreenCTM?.();
      if (!clipRect || !matrix || clip.getAttribute('clipPathUnits') === 'objectBoundingBox') continue;
      const x = Number(clipRect.getAttribute('x') || 0), y = Number(clipRect.getAttribute('y') || 0);
      const width = Number(clipRect.getAttribute('width')), height = Number(clipRect.getAttribute('height'));
      if (![x, y, width, height, matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)) continue;
      const corners = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]]
        .map(([px, py]) => ({x: matrix.a * px + matrix.c * py + matrix.e, y: matrix.b * px + matrix.d * py + matrix.f}));
      rect = intersect(rect, {left: Math.min(...corners.map(point => point.x)), right: Math.max(...corners.map(point => point.x)),
        top: Math.min(...corners.map(point => point.y)), bottom: Math.max(...corners.map(point => point.y))});
      if (!rect) return null;
    }
    return rect;
  }

  function getTargets() {
    if (destroyed) return Object.freeze([]);
    const canvas = screenRect(svg.getBoundingClientRect());
    if (!canvas) return Object.freeze([]);
    const width = canvas.right - canvas.left, height = canvas.bottom - canvas.top, cache = new WeakMap();
    return Object.freeze(entries.flatMap(entry => {
      if (!svg.contains(entry.wrapper) || !visible(entry.wrapper, cache)) return [];
      const measured = screenRect(entry.wrapper.getBoundingClientRect());
      const actual = measured && clippedRect(entry, measured), clipped = actual && intersect(actual, canvas);
      if (!clipped) return [];
      const bounds = Object.freeze({left: clamp((clipped.left - canvas.left) / width, 0, 1),
        top: clamp((clipped.top - canvas.top) / height, 0, 1), right: clamp((clipped.right - canvas.left) / width, 0, 1),
        bottom: clamp((clipped.bottom - canvas.top) / height, 0, 1)});
      return [Object.freeze({id: entry.id, label: entry.label, kind: entry.kind, operation: 'decor',
        requireExplicit: entry.requireExplicit, priority: entry.kind === 'flower' ? 35 : 5,
        instruction: '捏合移动，松开确认。', bounds,
        bbox: Object.freeze({x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top}),
        anchor: Object.freeze({x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2})})];
    }));
  }

  apply();
  return Object.freeze({apply, getTargets, reset: () => apply(), getOffsets: () => offsets,
    destroy() {
      if (destroyed) return;
      // Find surviving wrappers, including ones detached from the current list
      // by an external renderer rebuild. Unwrapping preserves renderer nodes.
      for (const wrapper of Array.from(svg.querySelectorAll('[data-gesture-decor]'))) {
        const parent = wrapper.parentNode;
        for (const child of Array.from(wrapper.childNodes)) parent.insertBefore(child, wrapper);
        parent.removeChild(wrapper);
      }
      entries = []; offsets = empty(); destroyed = true;
    },
  });
}
