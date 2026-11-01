import test from 'node:test';
import assert from 'node:assert/strict';
import {dragDecorOffset, mountGestureDecor} from '../web/gesture-decor.mjs';

const point = (x, y) => ({x, y});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('decor drag preserves an immutable grab-start snapshot for preview, cancel and undo', () => {
  const base = {'decor:flower:0': point(.1, -.2), 'decor:cloud:4': point(-.1, .2)};
  const before = structuredClone(base);
  const first = dragDecorOffset(base, 'decor:flower:0', point(.2, .5), point(.5, .3));
  assert.deepEqual(first, {'decor:flower:0': point(.4, -.4), 'decor:cloud:4': point(-.1, .2)});
  const second = dragDecorOffset(base, 'decor:flower:0', point(.2, .5), point(.3, .5));
  assert.deepEqual(second['decor:flower:0'], point(.2, -.2), 'each preview is relative to grab start');
  assert.deepEqual(base, before);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first['decor:flower:0']));
  assert.ok(Object.isFrozen(first['decor:cloud:4']));
  base['decor:cloud:4'].x = .8;
  assert.equal(first['decor:cloud:4'].x, -.1, 'history does not retain mutable caller points');
  assert.deepEqual(dragDecorOffset({}, 'decor:stars', point(.5, .5), point(.5, .5)), {'decor:stars': point(0, 0)});
});

test('offsets clamp in both directions without forbidding negative movement', () => {
  const high = dragDecorOffset({'decor:water': point(.9, -.9)}, 'decor:water', point(0, 1), point(1, 0));
  assert.deepEqual(high['decor:water'], point(1, -1));
  const low = dragDecorOffset(high, 'decor:water', point(1, 0), point(0, 1));
  assert.deepEqual(low['decor:water'], point(0, 0));
  const nullPrototype = Object.assign(Object.create(null), {'decor:reflection': point(0, 0)});
  assert.deepEqual(dragDecorOffset(nullPrototype, 'decor:reflection', point(.4, .4), point(.2, .3))['decor:reflection'], point(-.2, -.1));
});

test('strict plain-data validation rejects unsafe, nonfinite and malformed state without reading accessors', () => {
  let calls = 0;
  const accessorPoint = {y: 0};
  Object.defineProperty(accessorPoint, 'x', {enumerable: true, get() { calls++; return 0; }});
  const accessorState = {};
  Object.defineProperty(accessorState, 'decor:stars', {enumerable: true, get() { calls++; return point(0, 0); }});
  const nonEnumerable = Object.defineProperty({}, 'decor:stars', {value: point(0, 0)});
  for (const state of [null, [], new Date(), Object.create({}), accessorState, nonEnumerable,
    {[Symbol('state')]: point(0, 0)}, {'decor:stars': accessorPoint}, {'decor:stars': {x: 0, y: 0, extra: true}},
    {'decor:stars': point(NaN, 0)}, {'decor:stars': point(0, Infinity)}, {'decor:stars': point(1.1, 0)},
    {'decor:stars': point('0', 0)}, JSON.parse('{"__proto__":{"x":0,"y":0}}')]) {
    assert.throws(() => dragDecorOffset(state, 'decor:stars', point(0, 0), point(1, 1)));
  }
  for (const cursor of [[], accessorPoint, point(NaN, 0), point(-.1, .3), point(.2, 1.01), {x: 0, y: 0, extra: 0}]) {
    assert.throws(() => dragDecorOffset({}, 'decor:stars', cursor, point(0, 0)));
    assert.throws(() => dragDecorOffset({}, 'decor:stars', point(0, 0), cursor));
  }
  for (const id of ['sun', 'decor:unknown', 'decor:flower:-1', 'decor:flower:01', 'decor:cloud:1000', '__proto__', null]) {
    assert.throws(() => dragDecorOffset({}, id, point(0, 0), point(0, 0)));
  }
  assert.equal(calls, 0);
  assert.equal({}.x, undefined);
});

// Small structural SVG fixture: real wrappers, parent transforms, geometry
// replacement and clip bounds are exercised without a browser or camera.
class Element {
  constructor(name, document, attrs = {}, rect = null) {
    this.localName = name; this.namespaceURI = 'http://www.w3.org/2000/svg'; this.ownerDocument = document;
    this.nodeType = 1; this.attributes = new Map(Object.entries(attrs)); this.style = {}; this.childNodes = []; this.parentNode = null; this.rect = rect;
  }
  get children() { return this.childNodes; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    child.parentNode?.removeChild(child);
    const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(index, 0, child); child.parentNode = this; return child;
  }
  removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child; }
  replaceChildren(...children) { for (const child of [...this.childNodes]) this.removeChild(child); for (const child of children) this.appendChild(child); }
  contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
  querySelectorAll(selector) {
    const match = node => {
      const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/u);
      return attribute ? node.hasAttribute(attribute[1]) && (attribute[2] === undefined || node.getAttribute(attribute[1]) === attribute[2]) : node.localName === selector;
    };
    return this.childNodes.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  translation() {
    let x = 0, y = 0;
    for (let node = this; node; node = node.parentNode) {
      const match = node.getAttribute('transform')?.match(/^translate\(([-\d.]+) ([-\d.]+)\)$/u);
      if (match) { x += Number(match[1]); y += Number(match[2]); }
    }
    return {x, y};
  }
  getBoundingClientRect() {
    if (this.rect) { const delta = this.translation(); return {left: this.rect.x + delta.x, top: this.rect.y + delta.y, width: this.rect.width, height: this.rect.height}; }
    const boxes = this.children.map(child => child.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
    if (!boxes.length) return {left: 0, top: 0, width: 0, height: 0};
    const left = Math.min(...boxes.map(box => box.left)), top = Math.min(...boxes.map(box => box.top));
    return {left, top, width: Math.max(...boxes.map(box => box.left + box.width)) - left, height: Math.max(...boxes.map(box => box.top + box.height)) - top};
  }
  getScreenCTM() { const {x, y} = this.translation(); return {a: 1, b: 0, c: 0, d: 1, e: x, f: y}; }
}

function fixture() {
  const document = {createElementNS: (_namespace, name) => new Element(name, document), defaultView: {getComputedStyle: node => ({
    display: node.style.display || 'inline', opacity: node.style.opacity || node.getAttribute('opacity') || '1', visibility: node.style.visibility || 'visible',
  })}};
  const node = (name, attrs, rect) => new Element(name, document, attrs, rect);
  const svg = node('svg', {viewBox: '0 0 1600 1000'}, {x: 0, y: 0, width: 1600, height: 1000});
  const layer = (kind, rect) => { const result = node('g', {'data-layer': kind}); if (rect) result.appendChild(node('path', {}, rect)); svg.appendChild(result); return result; };
  const flowers = layer('flowers'), flower = node('g', {'data-object': 'flower'}, {x: 100, y: 800, width: 8, height: 14}); flowers.appendChild(flower);
  const clouds = layer('clouds', {x: 300, y: 100, width: 200, height: 20}); clouds.setAttribute('transform', 'translate(12 0)');
  const stars = layer('stars', {x: 40, y: 30, width: 1400, height: 300}); stars.setAttribute('opacity', '0');
  const distant = layer('distant', {x: -30, y: 400, width: 1660, height: 125});
  const foreground = layer('foreground', {x: -30, y: 730, width: 570, height: 300}); foreground.setAttribute('transform', 'translate(20 0)');
  const water = layer('water', {x: 0, y: 480, width: 1600, height: 520}); water.setAttribute('clip-path', 'url(#water-clip)');
  const reflection = layer('reflection', {x: 600, y: 400, width: 100, height: 500}); reflection.setAttribute('clip-path', 'url(#water-clip)');
  const defs = node('defs'), clip = node('clipPath', {id: 'water-clip'}); clip.appendChild(node('rect', {x: '0', y: '480', width: '1600', height: '520'})); defs.appendChild(clip); svg.appendChild(defs);
  return {svg, node, flowers, flower, clouds, stars, distant, foreground, water, reflection};
}

test('adapter preserves renderer transforms and fixed clipping, wraps once, and restores on reset/destroy', () => {
  const f = fixture(), adapter = mountGestureDecor(f.svg);
  const cloud = f.clouds.querySelector('path'), originalWater = f.water.querySelector('path');
  adapter.apply({'decor:flower:0': point(.1, -.1), 'decor:cloud:0': point(.2, .1), 'decor:water': point(0, -.2)});
  assert.equal(f.clouds.getAttribute('transform'), 'translate(12 0)');
  assert.equal(cloud.parentNode.getAttribute('transform'), 'translate(320 100)');
  assert.equal(f.foreground.getAttribute('transform'), 'translate(20 0)');
  assert.equal(f.water.getAttribute('clip-path'), 'url(#water-clip)');
  assert.equal(originalWater.parentNode.getAttribute('transform'), 'translate(0 -200)');
  const count = f.svg.querySelectorAll('[data-gesture-decor]').length;
  adapter.apply(adapter.getOffsets()); adapter.apply(adapter.getOffsets());
  assert.equal(f.svg.querySelectorAll('[data-gesture-decor]').length, count, 'animation frames do not add nested wrappers');
  const targets = adapter.getTargets();
  const flowerBox = targets.find(target => target.id === 'decor:flower:0').bbox;
  for (const [key, expected] of Object.entries({x: .1625, y: .7, width: .005, height: .014})) near(flowerBox[key], expected);
  const water = targets.find(target => target.id === 'decor:water');
  assert.equal(water.bounds.top, .48, 'moving water upwards does not move its fixed clip');
  assert.equal(water.bounds.bottom, .8);
  assert.equal(water.requireExplicit, true);
  assert.equal(targets.find(target => target.id === 'decor:cloud:0').requireExplicit, false);
  assert.equal(targets.some(target => target.id === 'decor:stars'), false, 'zero-opacity night layer cannot be grabbed in daytime');
  assert.ok(Object.isFrozen(targets)); assert.ok(Object.isFrozen(water.bounds));
  assert.deepEqual(adapter.reset(), {});
  assert.equal(f.flower.parentNode.getAttribute('transform'), 'translate(0 0)');
  adapter.destroy();
  assert.equal(f.flower.parentNode, f.flowers); assert.equal(cloud.parentNode, f.clouds);
  assert.equal(originalWater.parentNode, f.water);
  assert.equal(f.svg.querySelectorAll('[data-gesture-decor]').length, 0);
  assert.deepEqual(adapter.getTargets(), []);
});

test('renderer geometry replacement preserves offset identity without reusing detached nodes', () => {
  const f = fixture(), adapter = mountGestureDecor(f.svg);
  const saved = adapter.apply({'decor:flower:0': point(.1, -.1), 'decor:water': point(.1, 0)});
  const oldWrapper = f.flower.parentNode;
  const replacement = f.node('g', {'data-object': 'flower'}, {x: 200, y: 850, width: 10, height: 10});
  f.flowers.replaceChildren(replacement);
  const water = f.node('g', {'data-water-depth': '0'}); water.setAttribute('transform', 'translate(3 0)'); water.appendChild(f.node('path', {}, {x: 20, y: 600, width: 400, height: 20}));
  f.water.replaceChildren(water);
  adapter.apply(saved);
  assert.notEqual(replacement.parentNode, oldWrapper);
  assert.equal(replacement.parentNode.getAttribute('transform'), 'translate(160 -100)');
  assert.equal(water.getAttribute('transform'), 'translate(3 0)', 'renderer-owned animation transform is intact');
  assert.equal(water.parentNode.getAttribute('transform'), 'translate(160 0)');
  assert.equal(adapter.getTargets().filter(target => target.id === 'decor:flower:0').length, 1);
  assert.equal(f.svg.querySelectorAll('[data-gesture-decor]').length, 7);
  f.clouds.style.display = 'none'; f.distant.style.opacity = '0'; f.foreground.style.visibility = 'hidden';
  replacement.rect.x = -500;
  const ids = adapter.getTargets().map(target => target.id);
  assert.equal(ids.includes('decor:cloud:0'), false);
  assert.equal(ids.includes('decor:distant'), false);
  assert.equal(ids.includes('decor:foreground'), false);
  assert.equal(ids.includes('decor:flower:0'), false, 'outside-canvas geometry is not a made-up target');
});

test('viewport inference follows slice cropping and invalid apply is atomic', () => {
  const f = fixture(); f.svg.rect.width = 500; f.svg.rect.height = 1000;
  const adapter = mountGestureDecor(f.svg);
  const saved = adapter.apply({'decor:flower:0': point(.1, .1)});
  assert.equal(f.flower.parentNode.getAttribute('transform'), 'translate(50 100)');
  assert.throws(() => adapter.apply({'decor:flower:0': point(Infinity, 0)}));
  assert.deepEqual(adapter.getOffsets(), saved);
  assert.throws(() => adapter.apply({}, {camera: {left: 3, right: 2, top: 0, bottom: 1}}));
  assert.throws(() => adapter.apply({}, {camera: {left: -Number.MAX_VALUE, right: Number.MAX_VALUE, top: 0, bottom: 1}}));
  assert.deepEqual(adapter.getOffsets(), saved);
  adapter.apply(saved, {camera: {left: 100, right: 900, top: 100, bottom: 700}});
  assert.equal(f.flower.parentNode.getAttribute('transform'), 'translate(80 60)');
  adapter.apply(saved, {width: 1600, height: 1000});
  assert.equal(f.flower.parentNode.getAttribute('transform'), 'translate(160 100)');
});

test('renderer-shaped reflection selectors and star rebuilds survive internal wrappers', () => {
  const f = fixture();
  const ellipse = f.node('ellipse', {'data-part': 'reflection-glow'}, {x: 400, y: 345, width: 320, height: 560});
  const ripples = f.node('g', {'data-part': 'reflection-ripples'});
  ripples.appendChild(f.node('path', {}, {x: 450, y: 487, width: 200, height: 400}));
  f.reflection.replaceChildren(ellipse, ripples);
  const adapter = mountGestureDecor(f.svg);
  const snapshot = adapter.apply({'decor:reflection': point(.1, .1), 'decor:stars': point(.1, .1), 'decor:foreground': point(.1, 0)});
  const reflectionWrapper = ripples.parentNode;
  // These are the renderer's exact descendant selectors. It updates the glow
  // and rebuilds ripple children while retaining the layer and ripple group.
  assert.equal(f.reflection.querySelector('ellipse'), ellipse);
  assert.equal(f.reflection.querySelector('[data-part="reflection-ripples"]'), ripples);
  ellipse.setAttribute('cx', '700');
  ripples.setAttribute('transform', 'translate(700 2)');
  const replacementRipple = f.node('path', {}, {x: -50, y: 487, width: 100, height: 400});
  ripples.replaceChildren(replacementRipple);
  // A geometry change instead replaces the stars layer's entire innerHTML.
  const newStar = f.node('circle', {opacity: '.8'}, {x: 80, y: 60, width: 2, height: 2});
  f.stars.replaceChildren(newStar); f.stars.setAttribute('opacity', '1');
  f.foreground.setAttribute('transform', 'translate(40 0)');
  adapter.apply(snapshot);
  assert.equal(ripples.parentNode, reflectionWrapper, 'partial reflection rebuild must not wrap a second time');
  assert.equal(ripples.getAttribute('transform'), 'translate(700 2)', 'reflection ambient transform stays renderer-owned');
  assert.equal(reflectionWrapper.getAttribute('transform'), 'translate(160 100)');
  assert.equal(newStar.parentNode.getAttribute('transform'), 'translate(160 100)');
  assert.equal(f.foreground.getAttribute('transform'), 'translate(40 0)');
  assert.equal(f.foreground.children[0].getAttribute('transform'), 'translate(160 0)');
  const targets = adapter.getTargets();
  assert.ok(targets.some(target => target.id === 'decor:stars'));
  assert.ok(targets.find(target => target.id === 'decor:reflection').bounds.top >= .48);
  assert.equal(f.svg.querySelectorAll('[data-gesture-decor]').length, 7);
  adapter.apply(snapshot);
  assert.equal(f.svg.querySelectorAll('[data-gesture-decor]').length, 7);
});

test('foreground grain in the separate renderer layer moves with its shore and survives rebuild', () => {
  const f = fixture(), details = f.node('g', {'data-layer': 'land-details'});
  const grain = f.node('g', {'data-detail': 'foreground'});
  grain.appendChild(f.node('path', {}, {x: 60, y: 810, width: 80, height: 5}));
  grain.setAttribute('transform', 'translate(20 0)'); details.appendChild(grain); f.svg.appendChild(details);
  const adapter = mountGestureDecor(f.svg), snapshot = adapter.apply({'decor:foreground': point(.1, -.1)});
  assert.equal(details.querySelector('[data-detail="foreground"]'), grain);
  assert.equal(grain.getAttribute('transform'), 'translate(20 0)');
  assert.equal(grain.parentNode.getAttribute('transform'), 'translate(160 -100)');
  assert.equal(f.foreground.children[0].getAttribute('transform'), 'translate(160 -100)');
  const newGrain = f.node('g', {'data-detail': 'foreground'}); newGrain.setAttribute('transform', 'translate(40 0)');
  details.replaceChildren(newGrain);
  adapter.apply(snapshot); adapter.apply(snapshot);
  assert.equal(newGrain.getAttribute('transform'), 'translate(40 0)');
  assert.equal(newGrain.parentNode.getAttribute('transform'), 'translate(160 -100)');
  assert.equal(details.querySelectorAll('[data-gesture-decor]').length, 1);
  adapter.destroy();
  assert.equal(newGrain.parentNode, details);
  assert.equal(newGrain.getAttribute('transform'), 'translate(40 0)');
});
