import { createScene, validateScene, solarPosition, leafPath } from './scene-model.mjs';
import { drawingPoints, ambientMotion } from './motion-model.mjs';

const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 1600, HEIGHT = 1000, SKY_HEIGHT = 480;
const FOREGROUND_SCALE = .45, FOREGROUND_Y = 525;
const FALLING_LEAF_SIZE = 16, FALLING_LEAF_SCALE = FOREGROUND_SCALE;
const TAU = Math.PI * 2;
let nextMount = 0;
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const fixed = (value) => Number(value.toFixed(2));
const seeded = (seed) => {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
};

export function sceneCameraPoint(viewport, point) {
  return Object.freeze({x: clamp((point.x - viewport.left) / (viewport.right - viewport.left)),
    y: clamp((point.y - viewport.top) / (viewport.bottom - viewport.top))});
}
const worldCameraPoint = (viewport, point) => ({x: viewport.left + point.x * (viewport.right - viewport.left),
  y: viewport.top + point.y * (viewport.bottom - viewport.top)});
function resolveAnchor(scene, id, fallback, viewport) {
  const placement = scene.placements?.find(item => item.id === id);
  return placement ? worldCameraPoint(viewport, placement) : {x: fallback.x, y: fallback.y};
}
export function resolveSceneObjectAnchor(value, id, fallback, viewport) {
  return Object.freeze(resolveAnchor(validateScene(value), id, fallback, viewport));
}
/** Always use the original anchor and grab point, never the previous render's delta. */
export function dragSceneObjectPoint(viewport, anchor, grab, pointer) {
  return sceneCameraPoint(viewport, {x: anchor.x + pointer.x - grab.x, y: anchor.y + pointer.y - grab.y});
}
export function trajectoryPhaseAt(points, point, {scaleX = 1, scaleY = 1} = {}) {
  let best = null;
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index], b = points[index + 1], dx = (b.x-a.x)*WIDTH*scaleX, dy = (b.y-a.y)*HEIGHT*scaleY;
    const px = (point.x-a.x)*WIDTH*scaleX, py = (point.y-a.y)*HEIGHT*scaleY;
    const along = clamp((px*dx+py*dy)/(dx*dx+dy*dy || 1));
    const x = a.x+(b.x-a.x)*along, y = a.y+(b.y-a.y)*along;
    const distance = ((point.x-x)*WIDTH*scaleX)**2+((point.y-y)*HEIGHT*scaleY)**2;
    if (!best || distance < best.distance) best = {distance, t: a.t+(b.t-a.t)*along, point: {x,y}};
  }
  if (!best) throw new RangeError('Trajectory needs at least two points.');
  return Object.freeze({t: best.t, point: Object.freeze(best.point)});
}

/** Visible SVG coordinates, not CSS pixels. Counts stay readable after slice cropping. */
export function layoutSceneObjects(value, viewport = {}) {
  const scene = validateScene(value);
  const {left = 0, right = WIDTH, top = 0, bottom = HEIGHT} = viewport;
  if (![left, right, top, bottom].every(Number.isFinite) || left < 0 || right > WIDTH ||
    top < 0 || bottom > HEIGHT || right <= left || bottom <= top) throw new RangeError('Invalid scene viewport.');
  const width = right - left;
  const coastShifts = Object.freeze({left: Math.max(0, left + Math.min(90, width * .12) - 464),
    right: Math.min(0, right - Math.min(65, width * .1) - 1519)});
  const mountainRandom = seeded(scene.seed ^ 0x6a09), mountains = [];
  for (let index = 0; index < scene.mountains; index++) {
    // The original coastal templates end at the SVG edges. Keep them in their
    // original one/two-island composition; packed peaks need complete outlines.
    const template = scene.mountains > 2 ? 'generated' : index === 0 ? 'left' : 'right';
    if (scene.mountains <= 2) {
      const shift = coastShifts[template];
      mountains.push(Object.freeze({id: index, template, peakX: (template === 'left' ? 464 : 1519) + shift,
        baseY: template === 'left' ? 650 : 721, width: template === 'left' ? 910 : 548,
        height: template === 'left' ? 333 : 297, transform: 'translate(' + fixed(shift) + ' 0)'}));
    } else {
      const cell = width / scene.mountains, peakX = left + (index + .5) * cell + (mountainRandom() - .5) * cell * .1;
      const baseY = Math.min(598 + mountainRandom() * 12, bottom - 40);
      const height = Math.max(35, Math.min(130 + mountainRandom() * 90, baseY - top - 18));
      const mountainWidth = cell * (1.14 + mountainRandom() * .12);
      const transform = 'translate(' + fixed(peakX) + ' ' + fixed(baseY) + ')';
      mountains.push(Object.freeze({id: index, template, peakX: fixed(peakX), baseY: fixed(baseY),
        width: fixed(mountainWidth), height: fixed(height), lean: fixed((mountainRandom() - .5) * .3),
        shoulder: fixed(.55 + mountainRandom() * .15), transform}));
    }
  }
  const boatRandom = seeded(scene.seed ^ 0xb0a7), boats = [];
  const boat = (index, x, y, scale, phase) => Object.freeze({id: index, x: fixed(x), y: fixed(y),
    scale: fixed(scale), phase: fixed(phase), bounds: Object.freeze({left: x - 52 * scale, right: x + 52 * scale,
      top: y - 65 * scale, bottom: y + 47 * scale})});
  if (scene.boats === 1) {
    const scale = Math.min(.82, width / 140, (bottom - Math.max(top, 540)) / 140);
    const x = clamp(970, left + 52 * scale + 8, right - 52 * scale - 8);
    const y = clamp(708, Math.max(590, top + 65 * scale + 8), bottom - 47 * scale - 8);
    boats.push(boat(0, x, y, scale, 0));
  } else if (scene.boats > 1) {
    const foregroundEdge = 539 + Math.max(0, left - 330);
    let seaLeft = Math.max(left + 35, bottom < 820 ? 870 : 600, foregroundEdge + 21), seaRight = Math.min(right - 35, 1320);
    if (seaRight - seaLeft < 95) { seaLeft = left + width * .12; seaRight = right - width * .12; }
    const seaWidth = seaRight - seaLeft, columns = Math.min(3, Math.max(1, Math.floor(seaWidth / 95)));
    const rows = Math.ceil(scene.boats / columns), endY = Math.min(935, bottom - 52);
    const startY = Math.max(Math.min(625, endY - 35), Math.min(708, endY - (rows - 1) * 90));
    const gapY = rows > 1 ? (endY - startY) / (rows - 1) : 180;
    const jitterY = Math.min(5, gapY * .04);
    for (let index = 0; index < scene.boats; index++) {
      const row = Math.floor(index / columns), column = index % columns;
      const rowCount = Math.min(columns, scene.boats - row * columns), cell = seaWidth / rowCount;
      const jitterX = Math.min(14, cell * .08);
      const scale = Math.max(.08, Math.min(.9, (cell - 2 * jitterX - 16) / 104,
        (gapY - 2 * jitterY - 8) / 112)) * (.91 + boatRandom() * .08);
      const x = seaLeft + (column + .5) * cell + (boatRandom() - .5) * 2 * jitterX;
      const y = startY + row * gapY + (boatRandom() - .5) * 2 * jitterY;
      boats.push(boat(index, x, y, scale, boatRandom() * TAU));
    }
  }
  const birds = [], birdRandom = seeded(scene.seed ^ 0xb17d);
  const originalBirds = [{x:833,y:302,variant:0},{x:867.5,y:287,variant:1},{x:816,y:324,variant:2}];
  const birdCount = scene.birds ?? 3;
  const birdColumns = Math.max(1,Math.min(7,Math.ceil(Math.sqrt(birdCount*width/200))));
  const birdRows = Math.max(1,Math.ceil(birdCount/birdColumns));
  const skyTop = Math.max(top+28,100), skyBottom = Math.min(445,bottom-28);
  for(let index=0;index<birdCount;index++) {
    const item = birdCount <= 3 ? originalBirds[index] : {
      x:left+30+(index%birdColumns+.5)*(width-60)/birdColumns+(birdRandom()-.5)*14,
      y:skyTop+(Math.floor(index/birdColumns)+.5)*(skyBottom-skyTop)/birdRows+(birdRandom()-.5)*8,
      variant:index%3};
    birds.push(Object.freeze({id:index,...item}));
  }
  return Object.freeze({boats: Object.freeze(boats), mountains: Object.freeze(mountains), birds:Object.freeze(birds), coastShifts});
}

function generatedMountain(item, id) {
  const w = item.width / 2, h = item.height, p = item.lean * w, shoulder = item.shoulder, n = fixed;
  return '<g data-object="mountain" data-scene-object="mountain:' + item.id + '" data-mountain-id="' + item.id + '" transform="' + item.transform + '">' +
    '<path d="M' + n(-w) + ' 0C' + n(-w * .66) + ' ' + n(-h * .1) + ' ' + n(p - w * .48) + ' ' + n(-h * shoulder) +
    ' ' + n(p - w * .15) + ' ' + n(-h * .82) + 'Q' + n(p) + ' ' + n(-h * 1.06) + ' ' + n(p + w * .16) + ' ' + n(-h * .84) +
    'C' + n(p + w * .43) + ' ' + n(-h * (shoulder - .1)) + ' ' + n(w * .64) + ' ' + n(-h * .16) + ' ' + n(w) +
    ' 0Q0 22 ' + n(-w) + ' 0Z" fill="url(#' + id + '-island)"/>' +
    '<path d="M' + n(p) + ' ' + n(-h) + 'Q' + n(p - w * .03) + ' ' + n(-h * shoulder) + ' ' + n(p + w * .25) +
    ' ' + n(-h * .25) + 'L' + n(w * .55) + ' 7Q' + n(w * .12) + ' 4 ' + n(p) + ' ' + n(-h) +
    'Z" fill="var(--land-near)" opacity=".25"/>' +
    '<path d="M' + n(-w * .87) + ' 4Q0 21 ' + n(w * .88) +
    ' 3" fill="none" stroke="url(#' + id + '-shore)" stroke-width="2"/></g>';
}
const mix = (left, right, ratio) => {
  const a = left.match(/\w\w/g).map((s) => parseInt(s, 16));
  const b = right.match(/\w\w/g).map((s) => parseInt(s, 16));
  return '#' + a.map((value, i) => Math.round(value + (b[i] - value) * ratio).toString(16).padStart(2, '0')).join('');
};
const PALETTES = [
  [0, ['101f32','46566a','3c5863','142f42','566974','3b5b5d','25474a','4d695c','a5aa87','324a43']],
  [5, ['708293','d6bcb0','8eaaa9','31586a','a8b6b3','6b8c80','3b665c','829b77','c1ba8e','47644f']],
  [6.3, ['a7bdc5','f5e5cb','a3bebb','467788','bfcfc6','80a08b','497b68','96ad7f','d1c89c','526e55']],
  [12, ['8cb7c5','e7eee6','8db8b5','3c7884','bdcfc5','669c85','397c68','78a079','c1c896','3c6350']],
  [16, ['9bb7be','eee8d5','a3bcb4','3d6c78','c1cdc1','789e85','427664','92a87c','d2c69a','48694f']],
  [18.3, ['829fae','f3e3c8','98b5b1','345d6c','bcc9be','729887','3a6c60','83a17b','c4c18e','405e4e']],
  [19.5, ['6b7f94','cfb9b0','849d9f','2d5269','a6b4b4','617f79','375b58','718768','b0ad85','3d574b']],
  [22, ['1b2c42','536274','4b6875','1b3b51','657c82','456a67','2e5353','587563','9fa886','334f46']],
  [24, ['101f32','46566a','3c5863','142f42','566974','3b5b5d','25474a','4d695c','a5aa87','324a43']],
];
function palette(hour, rain) {
  let index = PALETTES.findIndex(([at]) => at >= hour);
  if (index <= 0) index = 1;
  const [start, colors] = PALETTES[index - 1], [end, next] = PALETTES[index];
  const ratio = clamp((hour - start) / (end - start));
  return colors.map((color, i) => mix(mix(color, next[i], ratio).slice(1), '455e68', rain * .15));
}
function pine(x, y, height) {
  const w = height * .25, p = (dx, dy) => `${fixed(x+dx*w)} ${fixed(y+dy*height)}`;
  return `M${p(0,-1)}Q${p(-.12,-.83)} ${p(-.39,-.73)}L${p(-.15,-.75)}Q${p(-.35,-.58)} ${p(-.63,-.49)}L${p(-.32,-.53)}Q${p(-.53,-.35)} ${p(-.88,-.26)}L${p(-.51,-.31)}Q${p(-.72,-.15)} ${p(-1,-.07)}Q${p(-.43,-.01)} ${p(-.04,-.06)}L${p(-.035,.045)}H${fixed(x+w*.035)}L${p(.045,-.055)}Q${p(.48,-.01)} ${p(.98,-.08)}Q${p(.64,-.18)} ${p(.47,-.32)}L${p(.83,-.27)}Q${p(.44,-.43)} ${p(.29,-.55)}L${p(.59,-.51)}Q${p(.30,-.66)} ${p(.13,-.77)}L${p(.35,-.74)}Q${p(.10,-.88)} ${p(0,-1)}Z`;
}
function singleLeafArtwork(r, fill = 'var(--leaf)') {
  const blade = `M0-2C${fixed(-r*.35)} ${fixed(-r*.78)} ${fixed(-r*.18)} ${fixed(-r*1.33)} ${fixed(r*.17)} ${fixed(-r*1.5)}C${fixed(r*.62)} ${fixed(-r*.94)} ${fixed(r*.43)} ${fixed(-r*.4)} 0-2Z`;
  const vein = `M0-2Q${fixed(r*.18)} ${fixed(-r*.66)} ${fixed(r*.17)} ${fixed(-r*1.38)}`;
  return `<path d="${blade}" fill="${fill}"/><path d="${vein}" fill="none" stroke="var(--branch)" stroke-width=".9" stroke-opacity=".3" stroke-linecap="round"/>`;
}
const pointsPath = (points) => points.map((p, i) => `${i ? 'L' : 'M'}${fixed(p.x * WIDTH)} ${fixed(p.y * HEIGHT)}`).join(' ');
function phasePoint(points, phase) {
  const position = clamp(phase) * (points.length - 1), index = Math.min(points.length - 2, Math.floor(position));
  const ratio = position - index, a = points[index], b = points[index + 1];
  return { x: a.x + (b.x-a.x)*ratio, y: a.y + (b.y-a.y)*ratio, rotation: a.rotation + (b.rotation-a.rotation)*ratio };
}

/**
 * Owns only the SVG contents. Rendering is synchronous and deterministic for
 * scene + phase. It never reads a wall clock, credentials, network or storage.
 */
export function mountLandscape(svgElement, { onSunDrag, onTreeSelect, onLeafSelect, onObjectSelect, onObjectDrag, onTrajectoryDrag, onPhaseChange, onPathDraw } = {}) {
  if (!svgElement || svgElement.namespaceURI !== NS || svgElement.localName !== 'svg') throw new TypeError('mountLandscape requires an SVG element.');
  const id = 'landscape-' + ++nextMount;
  svgElement.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  svgElement.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svgElement.setAttribute('data-landscape-mount', id);
  svgElement.setAttribute('aria-label', '可直接改变太阳、枝树和落叶轨迹的山川海岛');
  svgElement.innerHTML = `
    <defs>
      <linearGradient id="${id}-sky" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="530"><stop data-stop="sky-top"/><stop offset="1" data-stop="sky-bottom"/></linearGradient>
      <linearGradient id="${id}-sea" x2="0" y2="1"><stop data-stop="sea-top"/><stop offset="1" data-stop="sea-bottom"/></linearGradient>
      <radialGradient id="${id}-halo"><stop stop-color="#fff0c7" stop-opacity=".55"/><stop offset=".32" stop-color="#fff0d6" stop-opacity=".18"/><stop offset="1" stop-color="#ffebc7" stop-opacity="0"/></radialGradient>
      <radialGradient id="${id}-sun" cx=".43" cy=".38" r=".7"><stop stop-color="#fff9e4"/><stop offset="1" stop-color="#ffe1a9"/></radialGradient>
      <linearGradient id="${id}-island" x1=".85" y1="0" x2=".15" y2="1"><stop stop-color="var(--land-mid)"/><stop offset="1" stop-color="var(--land-near)"/></linearGradient>
      <linearGradient id="${id}-front" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="var(--land-near)"/><stop offset="1" stop-color="var(--sea-bottom)"/></linearGradient>
      <linearGradient id="${id}-distant" x2="0" y2="1"><stop stop-color="var(--land-far)"/><stop offset="1" stop-color="var(--sea-top)" stop-opacity=".3"/></linearGradient>
      <linearGradient id="${id}-haze" x2="0" y2="1"><stop stop-color="var(--sky-bottom)" stop-opacity="0"/><stop offset=".5" stop-color="var(--sky-bottom)" stop-opacity=".38"/><stop offset="1" stop-color="var(--sky-bottom)" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}-shore" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#d8d4af" stop-opacity=".12"/><stop offset=".5" stop-color="#e1d8b7" stop-opacity=".65"/><stop offset="1" stop-color="#d8d4af" stop-opacity=".12"/></linearGradient>
      <filter id="${id}-soft" x="-.2" y="-.5" width="1.4" height="2"><feGaussianBlur stdDeviation="7"/></filter>
      <clipPath id="${id}-water"><rect x="0" y="480" width="1600" height="520"/></clipPath>
    </defs>
    <style>
      [data-landscape-mount="${id}"] [data-select], [data-landscape-mount="${id}"] [data-role="sun-control"]{cursor:pointer;outline:none}
      [data-landscape-mount="${id}"] [data-role="sun-control"]{cursor:grab;touch-action:none}
      [data-landscape-mount="${id}"] [data-role="sun-control"]:active{cursor:grabbing}
      [data-landscape-mount="${id}"] .sun-affordance{opacity:0;transition:opacity .16s}
      [data-landscape-mount="${id}"] [data-role="sun-control"]:hover .sun-affordance,
      [data-landscape-mount="${id}"] [data-role="sun-control"]:focus .sun-affordance{opacity:1}
      [data-landscape-mount="${id}"] [data-select]:focus{filter:drop-shadow(0 0 5px #f4d88e88)}
      [data-scene-object]{pointer-events:visiblePainted;touch-action:none;cursor:grab;outline:none}
      [data-scene-object]:active,[data-trajectory-handle]:active{cursor:grabbing}
      [data-trajectory-handle]{pointer-events:all;touch-action:none;cursor:grab;outline:none}
      [data-landscape-mount="${id}"][data-drawing-trajectory="true"],
      [data-landscape-mount="${id}"][data-drawing-trajectory="true"] *{touch-action:none;cursor:crosshair}
    </style>
    <rect width="1600" height="1000" fill="url(#${id}-sky)"/>
    <g data-layer="stars" pointer-events="none"></g>
    <g data-layer="clouds" pointer-events="none" fill="#f8f4e6">
      <path d="M-90 172C46 154 130 178 240 165S432 158 532 175C397 177 309 186 196 184S13 186-90 172Z" opacity=".65"/>
      <path d="M623 119C734 113 806 129 875 125S1004 108 1109 122C947 133 773 139 623 119Z" opacity=".46"/>
      <path d="M1173 246C1307 224 1454 239 1646 220L1660 235C1451 255 1320 250 1173 246Z" opacity=".55"/>
      <path d="M779 290C900 278 1003 286 1137 275C1028 295 899 302 779 290Z" opacity=".32"/>
      <path d="M89 316C185 309 253 318 327 310" stroke="#fff5df" stroke-width="2" stroke-linecap="round" fill="none" opacity=".3"/>
    </g>
    <g data-layer="sun-visual" pointer-events="none">
      <circle data-part="sun-halo" r="290" fill="url(#${id}-halo)"/>
      <circle r="51" fill="#ffedc9" opacity=".12"/>
      <circle data-part="sun-core" r="45" fill="url(#${id}-sun)"/>
      <circle data-part="moon-mark" cx="17" cy="-11" r="6" fill="#c4d6cf" opacity="0"/>
    </g>
    <g data-layer="distant" pointer-events="none">
    <path d="M-30 459C72 446 121 422 187 421S286 447 340 436S421 398 481 400S599 442 676 436S787 409 853 417S964 453 1040 447S1120 420 1191 426S1324 466 1413 443S1544 427 1630 449V510H-30Z" fill="var(--land-far)" opacity=".36"/>
    <path d="M-30 485C79 465 146 453 211 460S305 477 383 463S461 435 520 443S631 477 697 464S808 439 873 451S990 481 1080 465S1211 452 1296 467S1494 452 1630 476V525H-30Z" fill="url(#${id}-distant)" opacity=".65"/>
    </g>
    <rect x="0" y="431" width="1600" height="94" fill="url(#${id}-haze)"/>
    <rect x="0" y="480" width="1600" height="520" fill="url(#${id}-sea)"/>
    <path d="M0 480H1600" stroke="var(--sky-bottom)" stroke-width="2" opacity=".22"/>
    <g data-layer="reflection" clip-path="url(#${id}-water)" pointer-events="none"><ellipse rx="160" ry="280" fill="url(#${id}-halo)" opacity=".3"/><g data-part="reflection-ripples"></g></g>
    <g data-layer="water" clip-path="url(#${id}-water)" pointer-events="none"></g>
    <g pointer-events="none" fill="var(--sky-bottom)" opacity=".17" filter="url(#${id}-soft)"><ellipse cx="787" cy="491" rx="578" ry="9"/><ellipse cx="1077" cy="519" rx="369" ry="7" opacity=".5"/></g>
    <g data-layer="terrain" pointer-events="none">
      <g data-layer="mountain-extras"></g>
      <g data-layer="mountain-left">
      <path d="M-70 543C13 524 73 476 139 454C194 438 224 399 279 390C334 381 361 339 406 317C431 304 451 301 477 317C518 347 533 371 570 386C603 399 619 440 661 462C697 480 717 509 751 523C778 536 812 552 840 577C802 606 746 619 683 630C573 649 474 638 385 650C272 664 185 651 101 636C32 624-26 601-70 583Z" fill="url(#${id}-island)"/>
      <path d="M89 514C168 478 205 465 270 445S362 399 405 356C427 338 445 320 464 314C454 353 432 390 412 422C375 477 315 499 254 510C203 521 150 526 89 533Z" fill="var(--leaf-light)" opacity=".19"/>
      <path d="M466 320C467 365 483 394 506 431C528 467 532 493 566 519C587 536 607 566 622 599C572 579 552 563 532 532C506 494 497 465 476 426C458 389 455 349 466 320Z" fill="var(--land-near)" opacity=".34"/>
      <path d="M484 329C497 365 526 394 548 407S590 444 609 468" fill="none" stroke="var(--leaf-light)" stroke-width="2.1" stroke-opacity=".2"/>
      <path d="M170 483C237 477 283 465 332 440M189 499C244 494 286 487 317 476M510 470C523 505 548 526 569 538M354 415C374 397 391 386 404 370" fill="none" stroke="var(--leaf-light)" stroke-width="1" stroke-opacity=".18"/>
      <path d="M-35 575C98 559 164 568 247 573C324 579 360 597 432 603C516 610 555 602 628 592S763 575 834 577C783 614 722 622 661 632C548 650 471 635 384 648C263 662 143 644 68 622C25 609-10 590-35 575Z" fill="var(--leaf-light)" opacity=".36"/>
      <path d="M-34 593C69 633 166 644 275 648C372 650 408 632 490 642C603 655 724 631 829 585C803 613 748 639 695 649C592 671 510 665 431 665C336 671 288 679 195 661C96 650 18 627-34 610Z" fill="var(--land-near)"/>
      <path d="M-12 600C98 644 198 652 281 653C369 654 408 640 478 647C600 661 733 634 823 592" fill="none" stroke="url(#${id}-shore)" stroke-width="3"/>
      <path d="M86 653C205 680 286 682 391 674C529 668 645 686 775 634" fill="none" stroke="#c0d1c4" stroke-width="1.1" opacity=".3"/>
      <path d="M154 670C258 688 316 687 389 684M520 680C608 681 667 666 722 649" fill="none" stroke="#ced9c8" stroke-width=".8" opacity=".14"/>
      </g>
      <g data-layer="mountain-right">
      <path d="M1322 567C1371 535 1404 503 1438 484C1475 466 1491 427 1519 424C1547 422 1570 455 1615 468C1666 493 1710 590 1775 610C1810 628 1844 665 1870 680Q1790 746 1700 739Q1654 733 1615 721C1557 703 1527 681 1491 670C1428 653 1367 612 1322 567Z" fill="url(#${id}-island)"/>
      <path d="M1518 427C1510 470 1483 509 1473 540C1461 572 1458 604 1471 637C1434 609 1404 583 1388 558C1444 514 1486 466 1518 427Z" fill="var(--leaf-light)" opacity=".14"/>
      <path d="M1325 572C1378 605 1421 636 1470 653C1524 673 1565 703 1611 710C1698 746 1795 744 1864 685" fill="none" stroke="url(#${id}-shore)" stroke-width="3"/>
      <path d="M1382 627C1452 669 1515 700 1609 727" fill="none" stroke="#c0d1c4" stroke-width="1" opacity=".28"/>
      </g>
      <g data-layer="support">
        <g data-support="left"><path d="M-70 638C90 609 255 610 410 624S702 627 840 644C689 675 535 666 392 675S93 664-70 651Z" fill="var(--land-mid)"/><path d="M-50 650C210 681 546 686 824 649" fill="none" stroke="var(--leaf-light)" stroke-width="2" opacity=".24"/></g>
        <g data-support="right"><path d="M1322 687C1400 662 1518 668 1630 689V736C1507 731 1416 715 1322 687Z" fill="var(--land-mid)"/></g>
      </g>
      <g data-layer="foreground">
      <path d="M-48 783C57 757 100 729 164 733C211 737 233 713 280 728C337 747 370 759 410 797C440 824 445 873 476 914C493 939 522 969 539 1028H-48Z" fill="url(#${id}-front)"/>
      <path d="M-30 783C76 749 118 742 165 744C219 746 239 728 275 738C326 750 365 773 405 802C352 787 313 781 271 785C227 783 192 770 153 780C91 792 35 800-30 818Z" fill="var(--land-mid)" opacity=".32"/>
      <path d="M-19 819C83 793 136 794 196 800M255 796C315 792 351 810 385 829M16 867C83 839 135 836 182 845" fill="none" stroke="var(--leaf-light)" stroke-width="1.3" opacity=".13"/>
      </g>
    </g>
    <g data-layer="land-details" pointer-events="none"></g>
    <g data-layer="pines"></g><g data-layer="boat" pointer-events="none"></g>
    <g data-layer="birds" fill="none" stroke="var(--land-near)" stroke-linecap="round" opacity=".65"></g>
    <g data-layer="hero" data-select="tree" role="button" tabindex="0" aria-label="选择前景枝树，修改枝角与递归深度"></g>
    <g data-layer="flowers" pointer-events="none"></g>
    <g data-layer="rain" pointer-events="none" stroke="#d8e5e4" stroke-width="1.15"></g>
    <g data-layer="trajectory" pointer-events="none"><path data-path="compare" fill="none" stroke="#b5ddd1" stroke-width="3" stroke-dasharray="10 12"/><path data-path="current" fill="none" stroke="#f3d99b" stroke-width="3.5"/>
      <g data-trajectory-handle="origin" role="slider" tabindex="0" aria-label="拖动落叶轨迹起点"><circle data-handle-hit fill="transparent"/><circle data-handle-dot fill="#f5fcff" stroke="#2479b3" stroke-width="2" vector-effect="non-scaling-stroke"/></g>
      <g data-trajectory-handle="target" role="slider" tabindex="0" aria-label="拖动落叶轨迹终点"><circle data-handle-hit fill="transparent"/><circle data-handle-dot fill="#f5fcff" stroke="#2479b3" stroke-width="2" vector-effect="non-scaling-stroke"/></g>
      <g data-trajectory-handle="phase" role="slider" tabindex="0" aria-label="沿轨迹拖动落叶时间" aria-valuemin="0" aria-valuemax="1"><circle data-handle-hit fill="transparent"/><circle data-part="phase-dot" data-handle-dot fill="none" stroke="#244a4d" stroke-width="1.25" vector-effect="non-scaling-stroke"/></g>
    </g>
    <g data-layer="leaf" data-select="leaf" role="button" tabindex="0" aria-label="选择落叶，查看真实运动轨迹"><ellipse rx="52" ry="46" fill="transparent"/><g opacity=".94">${singleLeafArtwork(FALLING_LEAF_SIZE)}</g></g>
    <g data-role="sun-control" role="slider" tabindex="0" aria-label="拖动太阳或月亮改变时间" aria-valuemin="0" aria-valuemax="24"><circle r="76" fill="transparent"/><circle class="sun-affordance" r="69" fill="none" stroke="#f8ecc8" stroke-width="1.5"/><text class="sun-affordance" data-part="time-label" text-anchor="middle" y="104" font-size="15" fill="#edf2df" font-family="system-ui,sans-serif"></text></g>`;

  const layer = (name) => svgElement.querySelector(`[data-layer="${name}"]`);
  const layers = Object.fromEntries(['stars','clouds','sun-visual','reflection','water','distant','mountain-left','mountain-right','mountain-extras','support','foreground','land-details','pines','boat','birds','hero','flowers','rain','trajectory','leaf'].map((name) => [name, layer(name)]));
  // Keep trajectory handles above the falling leaf's transparent hit ellipse.
  svgElement.append(layers.trajectory);
  const drawingLayer=document.createElementNS(NS,'g');drawingLayer.setAttribute('data-layer','drawing');drawingLayer.setAttribute('pointer-events','none');
  drawingLayer.innerHTML='<path data-drawing-path fill="none" stroke="#fff0b3" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
  drawingLayer.style.display='none';svgElement.append(drawingLayer);
  const drawingPath=drawingLayer.querySelector('[data-drawing-path]');
  const selectionLayer = document.createElementNS(NS,'g');
  selectionLayer.setAttribute('data-layer','selection');selectionLayer.setAttribute('pointer-events','none');
  selectionLayer.innerHTML = '<rect data-selection-box fill="none" stroke="#3d91d8" stroke-width="1.5" stroke-dasharray="6 4" rx="5" vector-effect="non-scaling-stroke"/>';
  selectionLayer.style.display='none';svgElement.append(selectionLayer);
  const selectionBox=selectionLayer.querySelector('[data-selection-box]');
  const trajectoryHandles=Object.fromEntries(['origin','target','phase'].map(handle=>[handle,layers.trajectory.querySelector('[data-trajectory-handle="'+handle+'"]')]));
  for(const [handle,node] of Object.entries(trajectoryHandles))node.style.pointerEvents=
    typeof onTrajectoryDrag==='function'||(handle==='phase'&&typeof onPhaseChange==='function')?'all':'none';
  const sunControl = svgElement.querySelector('[data-role="sun-control"]');
  const stops = Object.fromEntries(['sky-top','sky-bottom','sea-top','sea-bottom'].map((name) => [name, svgElement.querySelector(`[data-stop="${name}"]`)]));
  let destroyed = false, current = null, drag = null, geometryKey = '', paletteKey = '', weatherKey = '', pathKey = '', compareKey = '', points = [], sunSpan = 1240;
  let objectLayout = null, boatNodes = [], birdNodes = [],waterNodes=[], heroAnchorLocal = {x:512,y:1010};
  let camera={left:0,right:WIDTH,top:0,bottom:HEIGHT}, trajectoryFrame={x:150,y:525,scaleX:FOREGROUND_SCALE,scaleY:FOREGROUND_SCALE};
  let interactiveDrag=null, selectedId=null, currentPhase=0, skipClickUntil=0;
  let drawingMode=false,pathStroke=null,motionNow=0,lastMotionTime=null,motionDelta=0,selectionKey='';
  const objectClocks=new Map();
  const objectRecords=new Map();
  const disposers = [];
  const listen = (node, name, callback, options) => { node.addEventListener(name, callback, options); disposers.push(() => node.removeEventListener(name, callback, options)); };

  function rememberObject(node,objectId,kind,anchor,transform) {
    node.setAttribute('data-scene-object',objectId);node.setAttribute('data-object',kind);
    node.setAttribute('role','button');node.setAttribute('tabindex','0');
    node.setAttribute('aria-label',({tree:'树',boat:'帆船',mountain:'山',bird:'鸟'})[kind]+' '+(Number(objectId.split(':')[1])+1)+'，可选择和拖动');
    const art=kind==='boat'?node.querySelector('[data-boat-art]'):kind==='bird'?node.querySelector('[data-bird-art]'):null;
    objectRecords.set(objectId,{id:objectId,kind,node,baseAnchor:anchor,anchor,baseTransform:transform,art,
      wing:kind==='bird'?art.querySelector('path'):null,wake:kind==='boat'?node.querySelector('[data-boat-wake]'):null});
    if(!objectClocks.has(objectId))objectClocks.set(objectId,motionNow-motionDelta);
  }
  function geometry(scene, objects) {
    objectRecords.clear();
    objectLayout = objects;
    const random = seeded(scene.seed), pineCount = Math.max(0, scene.trees - 1), pines = [];
    for (let i = 0; i < pineCount; i++) {
      const left = random() < .73, side = left ? 'left' : 'right';
      const highGround = scene.mountains === 2 || (scene.mountains === 1 && left);
      const x = left ? 44 + random() * 685 : 1400 + random() * 180;
      const y = highGround ? (left ? 511 + x * .09 + random() * 35 : 563 + (x-1400) * .30 + random() * 27) :
        (left ? 622 + Math.sin(x/730*Math.PI) * 15 + random() * 10 : 681 + (x-1400) * .12 + random() * 8);
      const height = 16 + random() * 29;
      const shift=objects.coastShifts[side];
      const baseX=x+shift;
      pines.push('<g data-object="tree" data-scene-object="tree:'+(i+1)+'" data-select="tree" data-base-x="'+fixed(baseX)+'" data-base-y="'+fixed(y)+'" transform="translate('+fixed(baseX)+' '+fixed(y)+')"><path d="'+pine(0,0,height)+'" fill="var(--land-near)" opacity="'+fixed(.67+random()*.3)+'"/></g>');
    }
    layers.pines.innerHTML = pines.join('');
    const stars = [];
    for (let i = 0; i < 84; i++) stars.push(`<circle cx="${fixed(random()*WIDTH)}" cy="${fixed(20+random()*390)}" r="${fixed(.6+random()*1.35)}" fill="#e4eddb" opacity="${fixed(.3+random()*.65)}"/>`);
    layers.stars.innerHTML = stars.join('');
    const wave = [[],[],[]],sparkle=[[],[],[]];
    for (let i = 0; i < 240; i++) {
      const x = -130+random()*(WIDTH+260), depth = Math.pow(random(),1.65), y = 484+depth*510;
      const width = 5+depth*15+random()*(16+depth*64);
      const level=depth<.27?0:depth<.62?1:2,d=`M${fixed(x)} ${fixed(y)}q${fixed(width*.45)} ${fixed(-.7-depth*1.7)} ${fixed(width)} 0`;
      wave[level].push(`<path d="${d}" stroke="${i%7 ? '#d2dfd2' : '#f5e6c8'}" stroke-opacity="${fixed(.12+random()*.18)}" stroke-width="${fixed(.65+depth*.8+random()*.35)}" stroke-linecap="round" fill="none"/>`);
      if(i%3===0)sparkle[level].push(`<path d="${d}" stroke="#f5edcf" stroke-width="${fixed(.8+depth*.9)}" stroke-opacity=".4" stroke-linecap="round" fill="none"/>`);
    }
    layers.water.innerHTML = wave.map((paths,level)=>'<g data-water-depth="'+level+'">'+paths.join('')+'<g data-water-sparkles stroke-dasharray="18 86">'+sparkle[level].join('')+'</g></g>').join('');
    waterNodes=Array.from(layers.water.querySelectorAll('[data-water-depth]')).map(node=>({node,sparkles:node.querySelector('[data-water-sparkles]')}));
    const reflection = [];
    for(let i=0;i<66;i++) {
      const depth = i/65, y = 487+Math.pow(depth,1.5)*403;
      const spread = 13+depth*103, x = (random()-.5)*spread*2, width = 7+random()*(22+depth*73);
      reflection.push(`<path d="M${fixed(x-width/2)} ${fixed(y)}q${fixed(width*.48)} ${fixed(-.3-depth*.65)} ${fixed(width)} 0" fill="none" stroke="#fff0cb" stroke-width="${fixed(.6+random()*1.8)}" stroke-linecap="round" opacity="${fixed((.15+random()*.32)*(1-depth*.65))}"/>`);
    }
    layers.reflection.querySelector('[data-part="reflection-ripples"]').innerHTML=reflection.join('');
    const ground = [], meadow = [];
    for(let i=0;i<75;i++) {
      const foreground = i<35;
      const x = foreground ? random()*395 : 70+random()*651;
      const y = foreground ? 806+random()*143 : 593+Math.sin(x/700*Math.PI)*21+random()*8;
      const width=2+random()*8;
      (foreground?ground:meadow).push(`<path d="M${fixed(x)} ${fixed(y)}q${fixed(width*.5)} ${fixed(-1-random()*2)} ${fixed(width)} -1" fill="none" stroke="var(--leaf-light)" stroke-width="${foreground?'.8':'.65'}" opacity="${fixed(.1+random()*.13)}"/>`);
    }
    layers['land-details'].innerHTML=`<g data-detail="foreground">${ground.join('')}</g>${meadow.join('')}`;
    const flowers = [];
    for (let i = 0; i < scene.flowers; i++) {
      const x = 25+random()*420, y = 806+random()*180, r = 1.1+random()*1.4;
      flowers.push(`<g data-object="flower"><path d="M${fixed(x-1)} ${fixed(y+8)}q3-4 1-8m-1 4q-4-4-4-1" fill="none" stroke="var(--leaf)" stroke-width=".8" opacity=".8"/><path d="M${fixed(x-r)} ${fixed(y)}q${fixed(-r*1.8)} ${fixed(-r*1.8)} 0 ${fixed(-r*2)}q${fixed(r*1.1)} ${fixed(-r*1.9)} ${fixed(r*2)} 0q${fixed(r*2)} ${fixed(r*.3)} ${fixed(r)} ${fixed(r*1.8)}q0 ${fixed(r*2)} ${fixed(-r*2)} ${fixed(r*.2)}Z" fill="var(--leaf-light)" opacity=".85"/></g>`);
    }
    layers.flowers.innerHTML = flowers.join('');
    const boatMarkup = '<path d="M-42 25q44-4 86 0m-67 7h48m-35 5h21" fill="none" stroke="#d2dfd1" stroke-width=".9" opacity=".24"/><path d="M-27 11Q-2 16 28 10L18 20Q1 24-16 20Z" fill="#304e52"/><path d="M-23 12Q2 17 24 12" fill="none" stroke="#b3bea6" stroke-width="1.3"/><path d="M1-53L0 13" stroke="#d5d1b7" stroke-width="1.4"/><path d="M-3-49Q-8-21-28 8L-3 6Z" fill="#f4e9cc"/><path d="M5-39Q20-15 25 7L5 5Z" fill="#d8dfca"/><path d="M-5-36L-22 5M8-27L20 3" fill="none" stroke="#fff9e5" stroke-opacity=".4" stroke-width=".8"/>';
    layers.boat.innerHTML = objects.boats.map(item => '<g data-object="boat" data-scene-object="boat:'+item.id+'" data-boat-id="'+item.id+'"><g data-boat-art><path data-boat-wake d="M-31 23Q-65 27-99 23M-25 29Q-55 34-82 31" fill="none" stroke="#e2e7c9" stroke-width="1" pointer-events="none"/><rect x="-40" y="-60" width="80" height="100" fill="transparent" pointer-events="all"/>'+boatMarkup+'</g></g>').join('');
    boatNodes = Array.from(layers.boat.querySelectorAll('[data-object="boat"]'));
    layers.distant.style.display = scene.mountains ? '' : 'none';
    for (const side of ['left','right']) {
      const node = layers['mountain-' + side], item = objects.mountains.find(mountain => mountain.template === side);
      node.style.display = item ? '' : 'none';
      if (item) { node.setAttribute('data-object','mountain');node.setAttribute('data-mountain-id',String(item.id));node.setAttribute('transform',item.transform); }
      else { node.removeAttribute('data-object');node.removeAttribute('data-mountain-id');node.removeAttribute('data-scene-object'); }
    }
    layers['mountain-extras'].innerHTML = objects.mountains.filter(item => item.template === 'generated').map(item => generatedMountain(item,id)).join('');
    layers.support.style.display = scene.mountains === 2 ? 'none' : '';
    for (const side of ['left','right']) layers.support.querySelector('[data-support="' + side + '"]').setAttribute('transform','translate(' + fixed(objects.coastShifts[side]) + ' 0)');

    const birdPaths=['M-13 0q7-6 14 0q6-5 12-1','M-9.5 0q5-4 10 0q5-4 9-1','M-8 0q4-3 8 0q4-3 8 0'];
    layers.birds.innerHTML=objects.birds.map(item=>'<g data-object="bird" data-scene-object="bird:'+item.id+'"><g data-bird-art><ellipse rx="20" ry="14" fill="transparent" stroke="none" pointer-events="all"/><path d="'+birdPaths[item.variant]+'"/></g></g>').join('');
    birdNodes=Array.from(layers.birds.querySelectorAll('[data-scene-object]'));
    hero(scene);
    for(const node of layers.pines.querySelectorAll('[data-scene-object]'))rememberObject(node,node.dataset.sceneObject,'tree',{x:Number(node.dataset.baseX),y:Number(node.dataset.baseY)},node.getAttribute('transform'));
    for(const item of objects.boats)rememberObject(boatNodes[item.id],'boat:'+item.id,'boat',{x:item.x,y:item.y},'translate('+item.x+' '+item.y+')');
    for(const item of objects.birds)rememberObject(birdNodes[item.id],'bird:'+item.id,'bird',{x:item.x,y:item.y},'translate('+item.x+' '+item.y+')');
    for(const item of objects.mountains){const node=item.template==='generated'?layers['mountain-extras'].querySelector('[data-mountain-id="'+item.id+'"]'):layers['mountain-'+item.template];rememberObject(node,'mountain:'+item.id,'mountain',{x:item.peakX,y:item.baseY-item.height},item.transform);}
    if(scene.trees)rememberObject(layers.hero,'tree:0','tree',null,null);
    for(const objectId of objectClocks.keys())if(!objectRecords.has(objectId))objectClocks.delete(objectId);
  }

  function hero(scene) {
    layers.hero.style.display = scene.trees ? '' : 'none';
    layers.hero.toggleAttribute('data-object', scene.trees > 0);
    if (scene.trees) layers.hero.setAttribute('data-object', 'tree');else layers.hero.removeAttribute('data-scene-object');
    const random = seeded(scene.seed ^ 0xa32e39), segments = [], tips = [];
    const angle = scene.branchAngle * Math.PI/180;
    function branch(x, y, direction, length, depth, level) {
      const end = { x:x+Math.cos(direction)*length, y:y+Math.sin(direction)*length };
      segments.push({x,y,...end, x1:x,y1:y,x2:end.x,y2:end.y,level});
      tips.push({...end, level, rotation:direction*180/Math.PI+90, size:10+random()*10});
      if (depth > 1) {
        branch(end.x,end.y,direction-angle,length*.73,depth-1,level+1);
        branch(end.x,end.y,direction+angle,length*.72,depth-1,level+1);
      }
    }
    branch(0,0,-Math.PI/2,170,scene.branchDepth,0);
    const all = segments.flatMap((s) => [{x:s.x1,y:s.y1},{x:s.x2,y:s.y2}]);
    const apex = all.reduce((best,p) => p.y < best.y ? p : best, all[0]);
    const minX = Math.min(...all.map(p=>p.x)), maxX = Math.max(...all.map(p=>p.x));
    const scale = Math.min(700/Math.max(1,-apex.y),830/Math.max(1,maxX-minX));
    const origin = createScene().leafOrigin ?? leafPath(createScene(),{samples:2})[0];
    const tx = origin.x*WIDTH-apex.x*scale, ty = origin.y*HEIGHT-apex.y*scale;
    heroAnchorLocal={x:tx,y:1010};
    const groups = [];
    for (let level=0;level<scene.branchDepth;level++) {
      const path = segments.filter(s=>s.level===level).map(s=>`M${fixed(tx+s.x1*scale)} ${fixed(ty+s.y1*scale)}Q${fixed(tx+(s.x1+s.x2)*.5*scale+3)} ${fixed(ty+(s.y1+s.y2)*.5*scale)} ${fixed(tx+s.x2*scale)} ${fixed(ty+s.y2*scale)}`).join('');
      groups.push(`<path d="${path}" fill="none" stroke="var(--branch)" stroke-width="${fixed(Math.max(1.1,20*Math.pow(.66,level)))}" stroke-linecap="round"/>`);
    }
    groups.unshift(`<path d="M${fixed(tx-135)} 1005q115-76 260 0Z" fill="var(--land-near)"/><path d="M${fixed(tx+15)} 1018Q${fixed(tx-22)} 818 ${fixed(tx)} ${fixed(ty)}" fill="none" stroke="var(--branch)" stroke-width="23" stroke-linecap="round"/><path d="M${fixed(tx+10)} 1005Q${fixed(tx-13)} 828 ${fixed(tx+2)} ${fixed(ty+6)}" fill="none" stroke="var(--leaf-light)" stroke-opacity=".19" stroke-width="2"/>`);
    for (const tip of tips) {
      if(tip.level<Math.max(0,scene.branchDepth-2))continue;
      const x = tx+tip.x*scale, y = ty+tip.y*scale;
      const r = tip.size*(tip.level===scene.branchDepth-1 ? .92 : .52);
      const sides=`M0 4C${fixed(-r*1.18)} ${fixed(r*.2)} ${fixed(-r*.96)} ${fixed(-r*.7)} ${fixed(-r*.24)} ${fixed(-r*.82)}C${fixed(-r*.18)} ${fixed(-r*.28)} -1 0 0 4ZM1 1C${fixed(r*.12)} ${fixed(-r*.55)} ${fixed(r*.85)} ${fixed(-r*.84)} ${fixed(r*1.04)} ${fixed(-r*.72)}C${fixed(r*1.11)} ${fixed(-r*.16)} ${fixed(r*.49)} 2 1 1Z`;
      const fill=tip.level%3 ? 'var(--leaf)' : 'var(--leaf-light)';
      groups.push(`<g transform="translate(${fixed(x)} ${fixed(y)}) rotate(${fixed(tip.rotation)})" opacity=".94"><path d="${sides}" fill="${fill}"/>${singleLeafArtwork(r,fill)}</g>`);
    }
    layers.hero.innerHTML = groups.join('');
  }

  function weather(scene) {
    const random = seeded(scene.seed ^ 0x3ae2), count = Math.round(scene.rain*180), paths = [];
    for(let i=0;i<count;i++) {
      const x=random()*(WIDTH+80),y=random()*1100-80,len=9+scene.rain*15;
      paths.push(`M${fixed(x)} ${fixed(y)}l${fixed(-2-scene.wind*len*.8)} ${fixed(len)}`);
    }
    layers.rain.innerHTML = `<path d="${paths.join('')}"/>`;
    layers.rain.setAttribute('opacity', String(.12+scene.rain*.48));
    svgElement.setAttribute('data-rain-particles', String(count));
  }

  function render(scene, { phase = 0, showTrajectory = false, compareScene = null, selectedObject = null,
    drawingTrajectory = false, motionTime = 0, motionPlaying = true } = {}) {
    if (destroyed) return;
    // Both the tree and every leaf sample share this visual camera. The model
    // stays in its original normalized coordinates, including comparison data.
    const bounds = svgElement.getBoundingClientRect?.();
    const visibleWidth = bounds?.width > 0 && bounds?.height > 0 ? Math.min(WIDTH, HEIGHT*bounds.width/bounds.height) : WIDTH;
    const visibleHeight = bounds?.width > 0 && bounds?.height > 0 ? Math.min(HEIGHT, WIDTH*bounds.height/bounds.width) : HEIGHT;
    const visibleLeft = (WIDTH-visibleWidth)/2, visibleRight = WIDTH-visibleLeft;
    const visibleTop = (HEIGHT-visibleHeight)/2, visibleBottom = HEIGHT-visibleTop;
    const foregroundX = Math.max(150, visibleLeft-180);
    const foregroundY = Math.min(FOREGROUND_Y,visibleBottom-16-1018*FOREGROUND_SCALE);
    const foregroundCamera = `translate(${fixed(foregroundX)} ${fixed(foregroundY)}) scale(${FOREGROUND_SCALE})`;
    const sunPadding = Math.min(84, visibleWidth*.18);
    const sunLeft = Math.max(180,visibleLeft+sunPadding), sunRight = Math.min(1420,visibleRight-sunPadding);
    sunSpan = sunRight-sunLeft;
    camera={left:visibleLeft,right:visibleRight,top:visibleTop,bottom:visibleBottom};
    current = validateScene(scene);selectedId=typeof selectedObject==='string'?selectedObject:selectedObject?.id??null;
    drawingMode=Boolean(drawingTrajectory)&&typeof onPathDraw==='function';
    svgElement.setAttribute('data-drawing-trajectory',String(drawingMode));
    if(!drawingMode&&pathStroke)finishPathDraw(null,true);
    const requestedTime=Number.isFinite(motionTime)?Math.max(0,motionTime):0;
    if(motionPlaying||lastMotionTime===null)motionNow=requestedTime;
    motionDelta=Math.max(0,motionNow-(lastMotionTime??motionNow));lastMotionTime=motionNow;
    phase = Number.isFinite(phase) ? clamp(phase) : 0;currentPhase=phase;
    const nextGeometry = [current.seed,current.trees,current.flowers,current.branchAngle,current.branchDepth,current.boats,current.mountains,current.birds,fixed(visibleLeft),fixed(visibleRight),fixed(visibleTop),fixed(visibleBottom)].join(':');
    if (nextGeometry !== geometryKey) { geometry(current,layoutSceneObjects(current,{left:visibleLeft,right:visibleRight,top:visibleTop,bottom:visibleBottom}));geometryKey=nextGeometry; }
    const nextWeather = [current.seed,current.rain,current.wind].join(':');
    if (nextWeather !== weatherKey) { weather(current);weatherKey=nextWeather; }
    const nextPalette = [current.hour,current.rain].join(':');
    if (nextPalette !== paletteKey) {
      const colors=palette(current.hour,current.rain), names=['sky-top','sky-bottom','sea-top','sea-bottom','land-far','land-mid','land-near','leaf','leaf-light','branch'];
      names.forEach((name,i)=>{svgElement.style.setProperty('--'+name,colors[i]);if(stops[name])stops[name].setAttribute('stop-color',colors[i]);});
      const night=clamp((Math.abs(current.hour-12)-6.5)/2);
      layers.stars.setAttribute('opacity',String(night*(1-current.rain*.8)));
      layers.clouds.setAttribute('opacity',String(.13+current.rain*.34));
      paletteKey=nextPalette;
    }
    const solar=solarPosition(current.hour), moon=!solar.visible;
    const body=moon?solarPosition((current.hour+12)%24):solar;
    const sunTop=visibleTop>0?visibleTop+18:0;
    const sunMotion=ambientMotion('sun',drag?.motionTime??motionNow);
    const sx=sunLeft+body.x*sunSpan+sunMotion.x,sy=sunTop+body.y*(SKY_HEIGHT-sunTop)+sunMotion.y;
    layers['sun-visual'].setAttribute('transform',`translate(${fixed(sx)} ${fixed(sy)})`);
    sunControl.setAttribute('transform',`translate(${fixed(sx)} ${fixed(sy)})`);
    sunControl.setAttribute('aria-valuenow',String(current.hour));
    const totalMinutes=Math.round(current.hour*60)%1440,hour=Math.floor(totalMinutes/60),minute=totalMinutes%60;
    const label=`${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
    sunControl.setAttribute('aria-valuetext',label);
    sunControl.querySelector('[data-part="time-label"]').textContent=label;
    layers['sun-visual'].querySelector('[data-part="sun-core"]').setAttribute('fill',moon?'#e9ecd9':`url(#${id}-sun)`);
    layers['sun-visual'].querySelector('[data-part="sun-core"]').setAttribute('r',moon?'33':'45');
    layers['sun-visual'].querySelector('[data-part="moon-mark"]').setAttribute('opacity',moon?'.3':'0');
    layers['sun-visual'].querySelector('[data-part="sun-halo"]').setAttribute('opacity',moon?'.23':String(.68-current.rain*.3));
    layers.reflection.querySelector('ellipse').setAttribute('cx',String(sx));
    layers.reflection.querySelector('ellipse').setAttribute('cy','625');
    const waterMotion=ambientMotion('water',motionNow,current),cloudMotion=ambientMotion('cloud',motionNow,current),rainMotion=ambientMotion('rain',motionNow,current);
    const reflectionRipples=layers.reflection.querySelector('[data-part="reflection-ripples"]');
    reflectionRipples.setAttribute('transform',`translate(${fixed(sx+waterMotion.x*.4)} ${fixed(waterMotion.y)})`);
    reflectionRipples.setAttribute('stroke-dasharray','18 34');reflectionRipples.setAttribute('stroke-dashoffset',String(-waterMotion.flow*.8));
    layers.reflection.setAttribute('opacity',String((moon ? .14 : .8)*waterMotion.highlight));
    for(const [index,{node,sparkles}] of waterNodes.entries()){
      const movement=ambientMotion('water',motionNow,{wind:current.wind,depth:[.15,.55,1][index]});
      node.setAttribute('transform',`translate(${fixed(movement.x)} ${fixed(movement.y)})`);
      sparkles.setAttribute('stroke-dashoffset',String(-movement.flow));sparkles.setAttribute('opacity',String(movement.highlight));
    }
    layers.clouds.setAttribute('transform',`translate(${fixed(cloudMotion.x)} 0)`);
    layers.rain.setAttribute('transform',`translate(${fixed(rainMotion.x)} ${fixed(rainMotion.y)})`);
    const foregroundShift=`translate(${fixed(foregroundX-150)} 0)`;
    layers.foreground.setAttribute('transform',foregroundShift);
    layers.flowers.setAttribute('transform',foregroundShift);
    layers['land-details'].querySelector('[data-detail="foreground"]').setAttribute('transform',foregroundShift);
    let heroDelta={x:0,y:0};
    for(const record of objectRecords.values()) {
      if(record.id==='tree:0'){record.baseAnchor={x:foregroundX+heroAnchorLocal.x*FOREGROUND_SCALE,y:foregroundY+heroAnchorLocal.y*FOREGROUND_SCALE};record.baseTransform=foregroundCamera;}
      const anchor=resolveAnchor(current,record.id,record.baseAnchor,camera);
      const delta={x:anchor.x-record.baseAnchor.x,y:anchor.y-record.baseAnchor.y};
      record.anchor=anchor;record.point=sceneCameraPoint(camera,anchor);
      const transform='translate('+fixed(delta.x)+' '+fixed(delta.y)+') '+record.baseTransform,pressed=record.id===selectedId;
      if(record.transform!==transform){record.node.setAttribute('transform',transform);record.transform=transform;}
      if(record.pressed!==pressed){record.node.setAttribute('aria-pressed',String(pressed));record.pressed=pressed;}
      if(record.art){
        const held=interactiveDrag?.id===record.id;
        const time=(objectClocks.get(record.id)??motionNow)+(held?0:motionDelta);objectClocks.set(record.id,time);
        const index=Number(record.id.split(':')[1]);
        if(record.kind==='boat'&&!record.travelRange){const margin=45*objectLayout.boats[index].scale+8;record.travelRange={min:Math.min(0,camera.left+margin-anchor.x),max:Math.max(0,camera.right-margin-anchor.x)};}
        const motion=ambientMotion(record.kind,time,{wind:current.wind,index,travelRange:record.travelRange});record.motion=motion;
        record.artTransform='translate('+fixed(motion.x)+' '+fixed(motion.y)+') rotate('+fixed(motion.rotation)+')'+(record.kind==='boat'?' scale('+objectLayout.boats[index].scale+')':'');
        record.art.setAttribute('transform',record.artTransform);
        if(record.wake)record.wake.setAttribute('opacity',String(motion.wake));
        if(record.wing){const span=[13,9.5,8][objectLayout.birds[index].variant],height=-3-motion.flap*4;record.wing.setAttribute('d','M'+(-span)+' 0Q'+fixed(-span*.5)+' '+fixed(height)+' 0 0Q'+fixed(span*.5)+' '+fixed(height*.9)+' '+span+' -1');}
      }
      if(record.id==='tree:0')heroDelta=delta;
    }
    const defaultFrame={x:foregroundX+heroDelta.x,y:foregroundY+heroDelta.y,scaleX:FOREGROUND_SCALE,scaleY:FOREGROUND_SCALE};
    const cameraFrame={x:visibleLeft,y:visibleTop,scaleX:visibleWidth/WIDTH,scaleY:visibleHeight/HEIGHT};
    trajectoryFrame=current.leafTrail?.length||drawingMode?cameraFrame:defaultFrame;
    layers.trajectory.setAttribute('transform','translate('+fixed(trajectoryFrame.x)+' '+fixed(trajectoryFrame.y)+') scale('+trajectoryFrame.scaleX+' '+trajectoryFrame.scaleY+')');
    const nextPath=[current.seed,current.wind,current.rain,JSON.stringify(current.leafOrigin),JSON.stringify(current.leafTarget),JSON.stringify(current.leafTrail)].join(':');
    if(nextPath!==pathKey){points=leafPath(current,{samples:81});layers.trajectory.querySelector('[data-path="current"]').setAttribute('d',pointsPath(points));pathKey=nextPath;}
    const p=phasePoint(points,phase),tip=drawingMode?pathStroke?.points.at(-1):null,mainLeaf=tip?{...tip,rotation:p.rotation}:p;
    layers.leaf.setAttribute('transform',`translate(${fixed(trajectoryFrame.x+mainLeaf.x*WIDTH*trajectoryFrame.scaleX)} ${fixed(trajectoryFrame.y+mainLeaf.y*HEIGHT*trajectoryFrame.scaleY)}) rotate(${fixed(mainLeaf.rotation)}) scale(${FALLING_LEAF_SCALE})`);
    layers.leaf.style.display=current.trees?'':'none';
    layers.trajectory.style.display=showTrajectory&&current.trees&&!drawingMode?'':'none';
    const pixelsPerWorld=bounds?.width>0&&bounds?.height>0?Math.max(bounds.width/WIDTH,bounds.height/HEIGHT):1;
    for(const [handle,point] of Object.entries({origin:points[0],target:points.at(-1),phase:p})){
      const node=trajectoryHandles[handle];node.setAttribute('transform','translate('+fixed(point.x*WIDTH)+' '+fixed(point.y*HEIGHT)+') scale('+(1/trajectoryFrame.scaleX)+' '+(1/trajectoryFrame.scaleY)+')');
      node.querySelector('[data-handle-hit]').setAttribute('r',String(20/pixelsPerWorld));
      node.querySelector('[data-handle-dot]').setAttribute('r',String((handle==='phase'?7:6)/pixelsPerWorld));
      node.setAttribute('aria-valuenow',String(handle==='phase'?phase:point.x));
    }
    const comparePath=layers.trajectory.querySelector('[data-path="compare"]');
    if(compareScene){const comparison=validateScene(compareScene),key=[comparison.seed,comparison.wind,comparison.rain,JSON.stringify(comparison.leafOrigin),JSON.stringify(comparison.leafTarget),JSON.stringify(comparison.leafTrail)].join(':');if(key!==compareKey){comparePath.setAttribute('d',pointsPath(leafPath(comparison,{samples:81})));compareKey=key;}const frame=comparison.leafTrail?.length?cameraFrame:defaultFrame;comparePath.setAttribute('transform','translate('+((frame.x-trajectoryFrame.x)/trajectoryFrame.scaleX)+' '+((frame.y-trajectoryFrame.y)/trajectoryFrame.scaleY)+') scale('+(frame.scaleX/trajectoryFrame.scaleX)+' '+(frame.scaleY/trajectoryFrame.scaleY)+')');comparePath.style.display='';}
    else comparePath.style.display='none';
    updateSelection();
    svgElement.setAttribute('data-birds',String(current.birds??3));
    svgElement.setAttribute('data-boats',String(current.boats));
    svgElement.setAttribute('data-mountains',String(current.mountains));
    svgElement.setAttribute('data-motion-time',String(motionNow));svgElement.setAttribute('data-motion-playing',String(Boolean(motionPlaying)));
    for(const [name,value] of Object.entries({hour:current.hour,trees:current.trees,rain:current.rain,wind:current.wind,'branch-angle':current.branchAngle,'branch-depth':current.branchDepth,flowers:current.flowers,phase,'leaf-x':mainLeaf.x,'leaf-y':mainLeaf.y,night:moon}))svgElement.setAttribute('data-'+name,String(value));
  }

  function updateSelection() {
    const record=objectRecords.get(selectedId);
    if(!record){selectionKey='';selectionLayer.style.display='none';svgElement.removeAttribute('data-selected-scene-object');return;}
    svgElement.setAttribute('data-selected-scene-object',record.id);
    const key=[record.id,geometryKey,record.node.getAttribute('transform'),record.artTransform??''].join('|');
    if(key===selectionKey)return;
    try {
      let corners;
      if(record.art){
        // Artwork is rigid inside its anchor. Cache its local box once, then
        // follow movement with arithmetic instead of forcing layout every frame.
        const box=record.artBox??(record.artBox=record.art.getBBox()),motion=record.motion;
        const scale=record.kind==='boat'?objectLayout.boats[Number(record.id.split(':')[1])].scale:1;
        const angle=motion.rotation*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
        corners=[[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]].map(([x,y])=>({
          x:record.anchor.x+motion.x+(x*cos-y*sin)*scale,y:record.anchor.y+motion.y+(x*sin+y*cos)*scale}));
      }else{
        const box=record.node.getBBox(),rootMatrix=svgElement.getScreenCTM(),nodeMatrix=record.node.getScreenCTM();
        if(!rootMatrix||!nodeMatrix)throw Error();
        const matrix=rootMatrix.inverse().multiply(nodeMatrix);
        corners=[[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]].map(([x,y])=>{
          const point=svgElement.createSVGPoint();point.x=x;point.y=y;return point.matrixTransform(matrix);
        });
      }
      const left=Math.min(...corners.map(point=>point.x)),top=Math.min(...corners.map(point=>point.y));
      const right=Math.max(...corners.map(point=>point.x)),bottom=Math.max(...corners.map(point=>point.y));
      for(const [name,value] of Object.entries({x:left-8,y:top-8,width:right-left+16,height:bottom-top+16}))selectionBox.setAttribute(name,String(fixed(value)));
      selectionLayer.style.display='';selectionKey=key;
    } catch {selectionLayer.style.display='none';}
  }
  function announceSelection(record) {
    selectedId=record.id;updateSelection();
    const detail={id:record.id,kind:record.kind,point:{...record.point}};
    if(typeof onObjectSelect==='function')onObjectSelect(detail);
    else if(record.kind==='tree'&&typeof onTreeSelect==='function')onTreeSelect();
  }
  function leafScenePoint(point,frame=trajectoryFrame) {
    return {x:clamp((point.x-frame.x)/(WIDTH*frame.scaleX)),y:clamp((point.y-frame.y)/(HEIGHT*frame.scaleY))};
  }
  function appendDrawPoint(event) {
    const active=pathStroke,point=svgPoint(event);if(!active||!point)return;
    const local=sceneCameraPoint(active.camera,point),last=active.raw.at(-1);
    if(last&&Math.hypot((local.x-last.x)*active.cssWidth,(local.y-last.y)*active.cssHeight)<1.5)return;
    if(last)active.length+=Math.hypot((local.x-last.x)*active.cssWidth,(local.y-last.y)*active.cssHeight);
    active.raw.push(local);
    if(active.raw.length>2048)active.raw=drawingPoints(active.raw,512);
    active.points=drawingPoints(active.raw);
    drawingPath.setAttribute('d',pointsPath(active.points));
    const tip=active.points.at(-1);
    if(tip&&current.trees){const point=worldCameraPoint(active.camera,tip);layers.leaf.setAttribute('transform','translate('+fixed(point.x)+' '+fixed(point.y)+') rotate('+(points.at(-1)?.rotation??0)+') scale('+FALLING_LEAF_SCALE+')');layers.leaf.style.display='';svgElement.setAttribute('data-leaf-x',String(tip.x));svgElement.setAttribute('data-leaf-y',String(tip.y));}
  }
  function emitPathDraw(phase,active=pathStroke) {
    onPathDraw?.({points:active.points.map(point=>({...point})),phase});
  }
  function finishPathDraw(event,cancel=false) {
    const active=pathStroke;if(!active||(event&&event.pointerId!==active.pointerId))return;
    if(event&&!cancel)appendDrawPoint(event);
    pathStroke=null;drawingLayer.style.display='none';drawingPath.removeAttribute('d');
    if(svgElement.hasPointerCapture?.(active.pointerId))svgElement.releasePointerCapture(active.pointerId);
    skipClickUntil=(event?.timeStamp??0)+500;
    emitPathDraw(cancel||active.points.length<2||active.length<8?'cancel':'end',active);
  }
  function emitTrajectory(active,eventPhase,point,t) {
    if(typeof onTrajectoryDrag==='function')onTrajectoryDrag({handle:active.handle,point:{...point},phase:eventPhase,...(active.handle==='phase'?{t}:{})});
    if(active.handle==='phase'&&typeof onPhaseChange==='function')onPhaseChange(t);
  }
  function moveInteractive(event) {
    const active=interactiveDrag;if(!active||event.pointerId!==active.pointerId)return;
    const point=svgPoint(event);if(!point)return;
    event.preventDefault();
    if(!active.started){
      if(Math.hypot(event.clientX-active.clientX,event.clientY-active.clientY)<3)return;
      active.started=true;
      if(active.type==='object')onObjectDrag?.({id:active.id,kind:active.kind,point:{...active.initialPoint},phase:'start'});
      else emitTrajectory(active,'start',active.start,active.t);
    }
    if(active.type==='object'){
      active.point=dragSceneObjectPoint(active.camera,active.anchor,active.grab,point);
      onObjectDrag?.({id:active.id,kind:active.kind,point:{...active.point},phase:'move'});
    }else{
      const local=leafScenePoint(point,active.frame);
      if(active.handle==='phase'){const projected=trajectoryPhaseAt(points,local,active.frame);active.point=projected.point;active.t=projected.t;}
      else active.point={x:clamp(active.start.x+local.x-active.grab.x),y:clamp(active.start.y+local.y-active.grab.y)};
      emitTrajectory(active,'move',active.point,active.t);
    }
  }
  function endInteractive(event) {
    const active=interactiveDrag;if(!active||event.pointerId!==active.pointerId)return;
    interactiveDrag=null;
    if(svgElement.hasPointerCapture?.(event.pointerId))svgElement.releasePointerCapture(event.pointerId);
    if(!active.started)return;
    skipClickUntil=event.timeStamp+500;
    if(active.type==='object')onObjectDrag?.({id:active.id,kind:active.kind,point:{...active.point},phase:'end'});
    else emitTrajectory(active,'end',active.point,active.t);
  }
  // Capture before the sun's target handler: drawing is an explicit temporary mode.
  listen(svgElement,'pointerdown',event=>{
    if(!drawingMode||!current||event.button!==0)return;
    event.preventDefault();event.stopImmediatePropagation();
    if(pathStroke||drag||interactiveDrag)return;
    const bounds=svgElement.getBoundingClientRect();
    pathStroke={pointerId:event.pointerId,camera:{...camera},cssWidth:bounds.width,cssHeight:bounds.height,raw:[],points:[],length:0};
    drawingLayer.setAttribute('transform','translate('+camera.left+' '+camera.top+') scale('+((camera.right-camera.left)/WIDTH)+' '+((camera.bottom-camera.top)/HEIGHT)+')');
    drawingLayer.style.display='';appendDrawPoint(event);svgElement.setPointerCapture?.(event.pointerId);emitPathDraw('start');
  },{capture:true});
  listen(svgElement,'pointermove',event=>{
    if(!pathStroke||event.pointerId!==pathStroke.pointerId)return;
    event.preventDefault();event.stopImmediatePropagation();
    const samples=event.getCoalescedEvents?.()??[];
    for(const sample of samples)appendDrawPoint(sample);
    appendDrawPoint(event);emitPathDraw('move');
  },{capture:true});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])listen(svgElement,name,event=>{
    if(!pathStroke||event.pointerId!==pathStroke.pointerId)return;
    event.preventDefault();event.stopImmediatePropagation();finishPathDraw(event,name!=='pointerup');
  },{capture:true});
  listen(svgElement,'pointerdown',event=>{
    if(!current||event.button!==0||drag||interactiveDrag)return;
    const point=svgPoint(event);if(!point)return;
    const handle=event.target.closest?.('[data-trajectory-handle]');
    if(handle&&svgElement.contains(handle)&&(typeof onTrajectoryDrag==='function'||typeof onPhaseChange==='function')){
      const key=handle.dataset.trajectoryHandle,start=key==='phase'?phasePoint(points,currentPhase):points[key==='origin'?0:points.length-1];
      interactiveDrag={type:'trajectory',handle:key,pointerId:event.pointerId,clientX:event.clientX,clientY:event.clientY,
        frame:{...trajectoryFrame},grab:leafScenePoint(point),start:{x:start.x,y:start.y},point:{x:start.x,y:start.y},t:currentPhase,started:false};
    }else{
      const node=event.target.closest?.('[data-scene-object]'),record=node&&objectRecords.get(node.dataset.sceneObject);
      if(!record||(typeof onObjectSelect!=='function'&&typeof onObjectDrag!=='function'))return;
      announceSelection(record);skipClickUntil=event.timeStamp+500;
      if(typeof onObjectDrag!=='function')return;
      interactiveDrag={type:'object',id:record.id,kind:record.kind,pointerId:event.pointerId,
        clientX:event.clientX,clientY:event.clientY,camera:{...camera},anchor:{...record.anchor},grab:{x:point.x,y:point.y},
        point:{...record.point},initialPoint:{...record.point},started:false};
    }
    event.preventDefault();event.stopPropagation();svgElement.setPointerCapture?.(event.pointerId);
  });
  listen(svgElement,'pointermove',moveInteractive);listen(svgElement,'pointerup',endInteractive);
  listen(svgElement,'pointercancel',endInteractive);listen(svgElement,'lostpointercapture',endInteractive);

  function svgPoint(event) {
    const matrix=svgElement.getScreenCTM();
    if(!matrix)return null;
    const point=svgElement.createSVGPoint();point.x=event.clientX;point.y=event.clientY;
    return point.matrixTransform(matrix.inverse());
  }
  function endDrag(event) {
    if(!drag||event.pointerId!==drag.pointerId)return;
    const finished=drag;drag=null;
    if(sunControl.hasPointerCapture?.(event.pointerId))sunControl.releasePointerCapture(event.pointerId);
    if(typeof onSunDrag==='function')onSunDrag(finished.hour,'end');
  }
  listen(sunControl,'pointerdown',(event)=>{
    if(!current||event.button!==0||drag||interactiveDrag)return;
    const p=svgPoint(event);if(!p)return;event.preventDefault();
    drag={pointerId:event.pointerId,x:p.x,span:sunSpan,startHour:current.hour,hour:current.hour,motionTime:motionNow};
    sunControl.setPointerCapture?.(event.pointerId);
    if(typeof onSunDrag==='function')onSunDrag(current.hour,'start');
  });
  listen(sunControl,'pointermove',(event)=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    const p=svgPoint(event);if(!p)return;event.preventDefault();
    drag.hour=fixed(clamp(drag.startHour+(p.x-drag.x)/(drag.span*.84)*12,0,24));
    if(typeof onSunDrag==='function')onSunDrag(drag.hour,'move');
  });
  listen(sunControl,'pointerup',endDrag);listen(sunControl,'pointercancel',endDrag);listen(sunControl,'lostpointercapture',endDrag);
  listen(sunControl,'keydown',(event)=>{
    if(!current||!['ArrowLeft','ArrowDown','ArrowRight','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();let hour=current.hour;
    if(event.key==='Home')hour=6;else if(event.key==='End')hour=18;else hour=clamp(hour+(['ArrowLeft','ArrowDown'].includes(event.key)?-.25:.25),0,24);
    if(typeof onSunDrag==='function'){onSunDrag(current.hour,'start');onSunDrag(hour,'move');onSunDrag(hour,'end');}
  });
  const select=(event)=>{
    if(drawingMode||pathStroke)return;
    if(event.type==='click'&&event.detail!==0&&event.timeStamp<=skipClickUntil)return;
    const handle=event.target.closest?.('[data-trajectory-handle]');if(handle)return;
    const object=event.target.closest?.('[data-scene-object]'),record=object&&objectRecords.get(object.dataset.sceneObject);
    if(record){announceSelection(record);return;}
    const target=event.target.closest?.('[data-select]');if(!target||!svgElement.contains(target))return;
    if(target.dataset.select==='leaf'&&typeof onLeafSelect==='function')onLeafSelect();
  };
  function nudgeSelected({dx=0,dy=0}={}){
    const record=objectRecords.get(selectedId);
    if(!record||drawingMode||pathStroke||interactiveDrag||drag||typeof onObjectDrag!=='function'||!Number.isFinite(dx)||!Number.isFinite(dy))return false;
    const before={...record.point},point={x:clamp(before.x+dx),y:clamp(before.y+dy)};
    for(const phase of ['start','move','end'])onObjectDrag({id:record.id,kind:record.kind,point:phase==='start'?{...before}:{...point},phase});
    return true;
  }
  listen(svgElement,'click',select);
  listen(svgElement,'keydown',event=>{
    if(event.defaultPrevented||event.isComposing||event.keyCode===229)return;
    const handle=event.target.closest?.('[data-trajectory-handle]');
    if(handle&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){
      event.preventDefault();const name=handle.dataset.trajectoryHandle;
      const step=event.shiftKey?.05:.01;
      if(name==='phase'){const t=clamp(currentPhase+(['ArrowLeft','ArrowDown'].includes(event.key)?-step:step));const point=phasePoint(points,t);emitTrajectory({handle:name},'move',point,t);}
      else{const before=points[name==='origin'?0:points.length-1],point={x:clamp(before.x+({'ArrowLeft':-step,'ArrowRight':step}[event.key]??0)),y:clamp(before.y+({'ArrowUp':-step,'ArrowDown':step}[event.key]??0))};emitTrajectory({handle:name},'start',before);emitTrajectory({handle:name},'move',point);emitTrajectory({handle:name},'end',point);}
      return;
    }
    const node=event.target.closest?.('[data-scene-object]'),record=node&&objectRecords.get(node.dataset.sceneObject);
    if(record&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)&&typeof onObjectDrag==='function'){
      event.preventDefault();announceSelection(record);const step=event.shiftKey?.05:.01;
      nudgeSelected({dx:({'ArrowLeft':-step,'ArrowRight':step}[event.key]??0),dy:({'ArrowUp':-step,'ArrowDown':step}[event.key]??0)});
    }else if((record||event.target.closest?.('[data-select]'))&&['Enter',' '].includes(event.key)){event.preventDefault();select(event);}
  });
  return {
    render,
    nudgeSelected,
    cancelPathDraw:()=>finishPathDraw(null,true),
    getObjectPositions:()=>Object.freeze(Array.from(objectRecords.values()).map(record=>Object.freeze({id:record.id,kind:record.kind,point:Object.freeze({...record.point})}))),
    getSvgMarkup:()=>svgElement.outerHTML,
    destroy(){if(destroyed)return;if(pathStroke)finishPathDraw(null,true);destroyed=true;disposers.forEach(dispose=>dispose());if(drag&&sunControl.hasPointerCapture?.(drag.pointerId))sunControl.releasePointerCapture(drag.pointerId);if(interactiveDrag&&svgElement.hasPointerCapture?.(interactiveDrag.pointerId))svgElement.releasePointerCapture(interactiveDrag.pointerId);drag=null;interactiveDrag=null;objectRecords.clear();objectClocks.clear();if(svgElement.getAttribute('data-landscape-mount')===id)svgElement.replaceChildren();},
  };
}
