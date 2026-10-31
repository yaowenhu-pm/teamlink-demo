import { validateScene, solarPosition, leafPath } from './scene-model.mjs';

const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 1600, HEIGHT = 1000, SKY_HEIGHT = 480;
const FOREGROUND_SCALE = .45, FOREGROUND_Y = 525;
const TAU = Math.PI * 2;
let nextMount = 0;
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const fixed = (value) => Number(value.toFixed(2));
const seeded = (seed) => {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
};
const mix = (left, right, ratio) => {
  const a = left.match(/\w\w/g).map((s) => parseInt(s, 16));
  const b = right.match(/\w\w/g).map((s) => parseInt(s, 16));
  return '#' + a.map((value, i) => Math.round(value + (b[i] - value) * ratio).toString(16).padStart(2, '0')).join('');
};
const PALETTES = [
  [0, ['07182f','253c57','23475d','102b44','25444e','21494d','163b40','344f45','81926d','203e3b']],
  [5, ['304667','d19c92','537d89','203f5b','768e97','486f6d','234a4f','667f59','b6ae78','34534b']],
  [6.3, ['91aebc','f5d1a4','76a5aa','2c617b','a1bdb6','71977c','38695f','9ba66a','d7c185','49664e']],
  [12, ['76adc8','e6ecdb','65a3b2','245c7b','8eb7b5','5b9278','2d6d60','719d63','b6c17b','355d49']],
  [16, ['83adbb','eedab2','719e9e','234f6b','95b8b1','779e7c','3e7463','94ab6b','dac181','42644b']],
  [18.3, ['567d99','f0d1a8','729d9e','193e58','91b2b1','5d8a78','315f5a','8fa26a','d6bd80','3a5b47']],
  [19.5, ['344c6c','c49a92','496d81','19354f','718997','41696c','274f52','647a57','ab9c6b','2a4942']],
  [22, ['0c203d','354965','2b5065','102d46','334f5f','294f54','1c4147','435d4c','8d9269','213f3d']],
  [24, ['07182f','253c57','23475d','102b44','25444e','21494d','163b40','344f45','81926d','203e3b']],
];
function palette(hour, rain) {
  let index = PALETTES.findIndex(([at]) => at >= hour);
  if (index <= 0) index = 1;
  const [start, colors] = PALETTES[index - 1], [end, next] = PALETTES[index];
  const ratio = clamp((hour - start) / (end - start));
  return colors.map((color, i) => mix(mix(color, next[i], ratio).slice(1), '455e68', rain * .15));
}
function pine(x, y, height) {
  const w = height * .32;
  return `M${fixed(x)} ${fixed(y-height)}q${fixed(-w*.3)} ${fixed(height*.28)} ${fixed(-w*.65)} ${fixed(height*.42)}l${fixed(w*.3)} ${fixed(-height*.01)}l${fixed(-w*.62)} ${fixed(height*.30)}l${fixed(w*.42)} ${fixed(-height*.04)}l${fixed(-w*.62)} ${fixed(height*.24)}q${fixed(w*1.18)} ${fixed(height*.12)} ${fixed(w*2.36)} 0l${fixed(-w*.62)} ${fixed(-height*.24)}l${fixed(w*.42)} ${fixed(height*.04)}l${fixed(-w*.62)} ${fixed(-height*.30)}l${fixed(w*.30)} ${fixed(height*.01)}q${fixed(-w*.35)} ${fixed(-height*.14)} ${fixed(-w*.65)} ${fixed(-height*.42)}Z`;
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
export function mountLandscape(svgElement, { onSunDrag, onTreeSelect, onLeafSelect } = {}) {
  if (!svgElement || svgElement.namespaceURI !== NS || svgElement.localName !== 'svg') throw new TypeError('mountLandscape requires an SVG element.');
  const id = 'landscape-' + ++nextMount;
  svgElement.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  svgElement.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svgElement.setAttribute('data-landscape-mount', id);
  svgElement.setAttribute('aria-label', '可直接改变太阳、枝树和落叶轨迹的山川海岛');
  svgElement.innerHTML = `
    <defs>
      <linearGradient id="${id}-sky" x2="0" y2="1"><stop data-stop="sky-top"/><stop offset="1" data-stop="sky-bottom"/></linearGradient>
      <linearGradient id="${id}-sea" x2="0" y2="1"><stop data-stop="sea-top"/><stop offset="1" data-stop="sea-bottom"/></linearGradient>
      <radialGradient id="${id}-halo"><stop stop-color="#ffe1a3" stop-opacity=".42"/><stop offset="1" stop-color="#ffe1a3" stop-opacity="0"/></radialGradient>
      <linearGradient id="${id}-island" x2=".8" y2="1"><stop stop-color="var(--land-mid)"/><stop offset="1" stop-color="var(--land-near)"/></linearGradient>
      <linearGradient id="${id}-front" x2=".8" y2="1"><stop stop-color="var(--land-near)"/><stop offset="1" stop-color="var(--sea-bottom)"/></linearGradient>
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
    </style>
    <rect width="1600" height="1000" fill="url(#${id}-sky)"/>
    <g data-layer="stars" pointer-events="none"></g>
    <g data-layer="clouds" pointer-events="none" fill="#f1eee0">
      <path d="M70 205q160-30 278 0q86 18 153-2q-129 47-280 24Q112 237 70 205Z"/>
      <path d="M696 137q125-27 250 0q95 10 175-5q-94 36-253 24q-98 12-172-19Z"/>
      <path d="M1270 177q148-24 330 0v21q-176-15-330-21Z"/>
    </g>
    <g data-layer="sun-visual" pointer-events="none">
      <circle data-part="sun-halo" r="230" fill="url(#${id}-halo)"/>
      <circle data-part="sun-core" r="57" fill="#ffe3a6"/>
      <circle data-part="moon-mark" cx="17" cy="-11" r="6" fill="#c4d6cf" opacity="0"/>
    </g>
    <path d="M0 465q90-30 165-7q95-37 170 2q90-33 163 0q105-34 190 2q97-29 191 0q113-31 205 0q110-30 210 0q120-28 306-7v110H0Z" fill="var(--land-far)"/>
    <rect x="0" y="480" width="1600" height="520" fill="url(#${id}-sea)"/>
    <g data-layer="reflection" clip-path="url(#${id}-water)" pointer-events="none"><ellipse rx="170" ry="330" fill="url(#${id}-halo)" opacity=".3"/></g>
    <g data-layer="water" clip-path="url(#${id}-water)" pointer-events="none"></g>
    <g data-layer="terrain" pointer-events="none">
      <path d="M-30 521Q76 485 150 412Q217 415 287 369Q350 373 417 306Q451 280 479 309Q518 353 550 344Q617 389 649 434Q694 445 737 497Q783 512 838 566Q801 604 712 617Q544 637 392 625Q224 649 91 614Q25 594-30 592Z" fill="url(#${id}-island)"/>
      <path d="M84 489Q154 448 201 447Q250 418 300 420Q353 383 397 383Q443 330 473 315Q445 373 429 429Q377 468 323 489Q243 506 179 537Z" fill="var(--leaf-light)" opacity=".24"/>
      <path d="M489 329q-15 100 44 169q62 32 101 104q-72-6-113-55q-37-62-55-109q-16-51 23-109Z" fill="var(--land-near)" opacity=".44"/>
      <path d="M0 568q155-29 294 3q143-13 235 28q145-26 308-33q-53 40-126 41q-145 30-290 17q-158 32-277-5Q61 613 0 588Z" fill="var(--leaf-light)" opacity=".35"/>
      <path d="M-24 596q156 36 288 36q151-11 259 3q158 8 311-58q-41 43-121 62q-162 33-298 20q-200 22-330-18q-59-14-109-45Z" fill="var(--land-near)"/>
      <path d="M80 639q161 38 338 24q182 16 399-47" stroke="#b7cbbb" stroke-opacity=".32" stroke-width="3" fill="none"/>
      <path d="M1334 536q62-38 115-85q32-4 66-49q45 12 85 50v265q-59-16-107-52q-77-15-117-62q-27-32-42-67Z" fill="url(#${id}-island)"/>
      <path d="M1344 583q50 16 86 54q70 56 170 66" fill="none" stroke="var(--leaf-light)" stroke-opacity=".55" stroke-width="6"/>
      <path d="M-30 764q126-49 199-52q81-38 150 2q66 16 105 71q14 77 89 147l25 88H-30Z" fill="url(#${id}-front)"/>
      <path d="M-10 761q123-49 185-38q80-36 143 1q56 15 99 61q-65-13-128-21q-68-19-125 4Q65 790-10 811Z" fill="var(--land-near)"/>
    </g>
    <g data-layer="pines"></g><g data-layer="boat" pointer-events="none"></g>
    <g data-layer="birds" pointer-events="none" fill="none" stroke="var(--land-near)" stroke-linecap="round" opacity=".65"><path d="M820 302q7-6 14 0q6-5 12-1"/><path d="M858 287q5-4 10 0q5-4 9-1"/><path d="M808 324q4-3 8 0q4-3 8 0"/></g>
    <g data-layer="hero" data-select="tree" role="button" tabindex="0" aria-label="选择前景枝树，修改枝角与递归深度"></g>
    <g data-layer="flowers" pointer-events="none"></g>
    <g data-layer="rain" pointer-events="none" stroke="#d8e5e4" stroke-width="1.15"></g>
    <g data-layer="trajectory" pointer-events="none"><path data-path="compare" fill="none" stroke="#b5ddd1" stroke-width="3" stroke-dasharray="10 12"/><path data-path="current" fill="none" stroke="#f3d99b" stroke-width="3.5"/><circle data-part="phase-dot" r="8" fill="#ffe6a7" stroke="#244a4d" stroke-width="2"/></g>
    <g data-layer="leaf" data-select="leaf" role="button" tabindex="0" aria-label="选择落叶，查看真实运动轨迹"><ellipse rx="36" ry="32" fill="transparent"/><path d="M-14 2Q-8-13 15-9Q18 9-4 12Q-12 10-14 2Z" fill="#ebc876"/><path d="M-15 10Q-3 1 11-6" fill="none" stroke="#9b8145" stroke-width="1.2"/></g>
    <g data-role="sun-control" role="slider" tabindex="0" aria-label="拖动太阳或月亮改变时间" aria-valuemin="0" aria-valuemax="24"><circle r="76" fill="transparent"/><circle class="sun-affordance" r="69" fill="none" stroke="#f8ecc8" stroke-width="1.5"/><text class="sun-affordance" data-part="time-label" text-anchor="middle" y="104" font-size="15" fill="#edf2df" font-family="system-ui,sans-serif"></text></g>`;

  const layer = (name) => svgElement.querySelector(`[data-layer="${name}"]`);
  const layers = Object.fromEntries(['stars','clouds','sun-visual','reflection','water','pines','boat','birds','hero','flowers','rain','trajectory','leaf'].map((name) => [name, layer(name)]));
  const sunControl = svgElement.querySelector('[data-role="sun-control"]');
  const stops = Object.fromEntries(['sky-top','sky-bottom','sea-top','sea-bottom'].map((name) => [name, svgElement.querySelector(`[data-stop="${name}"]`)]));
  let destroyed = false, current = null, drag = null, geometryKey = '', paletteKey = '', weatherKey = '', pathKey = '', compareKey = '', points = [], sunSpan = 1240;
  const disposers = [];
  const listen = (node, name, callback, options) => { node.addEventListener(name, callback, options); disposers.push(() => node.removeEventListener(name, callback, options)); };

  function geometry(scene) {
    const random = seeded(scene.seed), pineCount = Math.max(0, scene.trees - 1), pines = [];
    for (let i = 0; i < pineCount; i++) {
      const side = random();
      let x, y;
      if (side < .73) { x = 44 + random() * 685; y = 511 + x*.09 + random()*35; }
      else { x = 1400 + random()*235; y = 563+(x-1400)*.30+random()*27; }
      const height = 17 + random()*30;
      pines.push(`<path data-object="tree" data-select="tree" d="${pine(x,y,height)}" fill="var(--land-near)"/>`);
    }
    layers.pines.innerHTML = pines.join('');
    const stars = [];
    for (let i = 0; i < 84; i++) stars.push(`<circle cx="${fixed(random()*WIDTH)}" cy="${fixed(20+random()*390)}" r="${fixed(.6+random()*1.35)}" fill="#e4eddb" opacity="${fixed(.3+random()*.65)}"/>`);
    layers.stars.innerHTML = stars.join('');
    const wave = [];
    for (let i = 0; i < 70; i++) {
      const x = random()*WIDTH, y = 486+random()*510, width = 12+random()*88;
      wave.push(`<path d="M${fixed(x)} ${fixed(y)}q${fixed(width*.5)} -1 ${fixed(width)} 0" stroke="${i%4 ? '#bed0c4' : '#f0d39a'}" stroke-opacity="${fixed(.05+random()*.15)}" stroke-width="${fixed(.7+random()*1.2)}" fill="none"/>`);
    }
    layers.water.innerHTML = wave.join('');
    const flowers = [];
    for (let i = 0; i < scene.flowers; i++) {
      const x = 25+random()*480, y = 801+random()*192, r = 1.1+random()*1.6;
      flowers.push(`<path data-object="flower" d="M${fixed(x)} ${fixed(y+8)}v-9m${fixed(-r*2)} -1a${fixed(r)} ${fixed(r)} 0 1 0 ${fixed(r*4)} 0a${fixed(r)} ${fixed(r)} 0 1 0 ${fixed(-r*4)} 0" fill="var(--leaf-light)" stroke="var(--leaf-light)" stroke-opacity=".7" stroke-width=".8"/>`);
    }
    layers.flowers.innerHTML = flowers.join('');
    layers.boat.innerHTML = '<ellipse cx="0" cy="20" rx="37" ry="4" fill="#bfcebd" opacity=".16"/><path d="M-25 7H26L13 20H-12Z" fill="#28474d"/><path d="M0-49V9" stroke="#d5cfb4" stroke-width="2"/><path d="M-3-43V4H-29Z" fill="#efddab"/><path d="M3-33V4H21Z" fill="#bfcbb4"/>';
    hero(scene);
  }

  function hero(scene) {
    layers.hero.style.display = scene.trees ? '' : 'none';
    layers.hero.toggleAttribute('data-object', scene.trees > 0);
    if (scene.trees) layers.hero.setAttribute('data-object', 'tree');
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
    const origin = leafPath(scene,{samples:2})[0];
    const tx = origin.x*WIDTH-apex.x*scale, ty = origin.y*HEIGHT-apex.y*scale;
    const groups = [];
    for (let level=0;level<scene.branchDepth;level++) {
      const path = segments.filter(s=>s.level===level).map(s=>`M${fixed(tx+s.x1*scale)} ${fixed(ty+s.y1*scale)}Q${fixed(tx+(s.x1+s.x2)*.5*scale+3)} ${fixed(ty+(s.y1+s.y2)*.5*scale)} ${fixed(tx+s.x2*scale)} ${fixed(ty+s.y2*scale)}`).join('');
      groups.push(`<path d="${path}" fill="none" stroke="var(--branch)" stroke-width="${fixed(Math.max(1.1,20*Math.pow(.66,level)))}" stroke-linecap="round"/>`);
    }
    groups.unshift(`<path d="M${fixed(tx-135)} 1005q115-76 260 0Z" fill="var(--land-near)"/><path d="M${fixed(tx+15)} 1018Q${fixed(tx-22)} 818 ${fixed(tx)} ${fixed(ty)}" fill="none" stroke="var(--branch)" stroke-width="27" stroke-linecap="round"/>`);
    for (const tip of tips) {
      const x = tx+tip.x*scale, y = ty+tip.y*scale;
      const radius = tip.size*(tip.level===scene.branchDepth-1 ? 1.05 : .55);
      groups.push(`<ellipse cx="${fixed(x)}" cy="${fixed(y)}" rx="${fixed(radius*1.45)}" ry="${fixed(radius)}" transform="rotate(${fixed(tip.rotation)} ${fixed(x)} ${fixed(y)})" fill="${tip.level%3 ? 'var(--leaf)' : 'var(--leaf-light)'}" opacity=".92"/>`);
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

  function render(scene, { phase = 0, showTrajectory = false, compareScene = null } = {}) {
    if (destroyed) return;
    // Both the tree and every leaf sample share this visual camera. The model
    // stays in its original normalized coordinates, including comparison data.
    const bounds = svgElement.getBoundingClientRect?.();
    const visibleWidth = bounds?.width > 0 && bounds?.height > 0 ? Math.min(WIDTH, HEIGHT*bounds.width/bounds.height) : WIDTH;
    const visibleLeft = (WIDTH-visibleWidth)/2, visibleRight = WIDTH-visibleLeft;
    const foregroundX = Math.max(150, visibleLeft-180);
    const foregroundCamera = `translate(${fixed(foregroundX)} ${FOREGROUND_Y}) scale(${FOREGROUND_SCALE})`;
    const sunPadding = Math.min(84, visibleWidth*.18);
    const sunLeft = Math.max(180,visibleLeft+sunPadding), sunRight = Math.min(1420,visibleRight-sunPadding);
    sunSpan = sunRight-sunLeft;
    current = validateScene(scene);
    phase = Number.isFinite(phase) ? clamp(phase) : 0;
    const nextGeometry = [current.seed,current.trees,current.flowers,current.branchAngle,current.branchDepth].join(':');
    if (nextGeometry !== geometryKey) { geometry(current);geometryKey=nextGeometry; }
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
    const sx=sunLeft+body.x*sunSpan,sy=body.y*SKY_HEIGHT;
    layers['sun-visual'].setAttribute('transform',`translate(${fixed(sx)} ${fixed(sy)})`);
    sunControl.setAttribute('transform',`translate(${fixed(sx)} ${fixed(sy)})`);
    sunControl.setAttribute('aria-valuenow',String(current.hour));
    const totalMinutes=Math.round(current.hour*60)%1440,hour=Math.floor(totalMinutes/60),minute=totalMinutes%60;
    const label=`${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
    sunControl.setAttribute('aria-valuetext',label);
    sunControl.querySelector('[data-part="time-label"]').textContent=label;
    layers['sun-visual'].querySelector('[data-part="sun-core"]').setAttribute('fill',moon?'#e3e6cc':'#ffe3a6');
    layers['sun-visual'].querySelector('[data-part="sun-core"]').setAttribute('r',moon?'40':'57');
    layers['sun-visual'].querySelector('[data-part="moon-mark"]').setAttribute('opacity',moon?'.3':'0');
    layers['sun-visual'].querySelector('[data-part="sun-halo"]').setAttribute('opacity',moon?'.23':String(.68-current.rain*.3));
    layers.reflection.querySelector('ellipse').setAttribute('cx',String(sx));
    layers.reflection.querySelector('ellipse').setAttribute('cy','625');
    layers.reflection.setAttribute('opacity',moon?'.14':'.8');
    layers.water.setAttribute('transform',`translate(${fixed(Math.sin(phase*TAU)*current.wind*12)} ${fixed(Math.cos(phase*TAU)*current.wind*2)})`);
    layers.clouds.setAttribute('transform',`translate(${fixed(Math.sin(phase*TAU)*current.wind*20)} 0)`);
    layers.birds.setAttribute('transform',`translate(${fixed(Math.sin(phase*TAU)*current.wind*15)} ${fixed(Math.cos(phase*TAU)*current.wind*3)})`);
    layers.rain.setAttribute('transform',`translate(${fixed(-phase*current.wind*24)} ${fixed(phase*55)})`);
    layers.boat.style.display=current.boat?'':'none';
    layers.boat.setAttribute('transform',`translate(942 ${fixed(704+Math.sin(phase*TAU)*current.wind*5)}) rotate(${fixed(Math.sin(phase*TAU)*current.wind*5)})`);
    layers.hero.setAttribute('transform',foregroundCamera);
    layers.trajectory.setAttribute('transform',foregroundCamera);
    const nextPath=[current.seed,current.wind,current.rain].join(':');
    if(nextPath!==pathKey){points=leafPath(current,{samples:31});layers.trajectory.querySelector('[data-path="current"]').setAttribute('d',pointsPath(points));pathKey=nextPath;}
    const p=phasePoint(points,phase);
    layers.leaf.setAttribute('transform',`translate(${fixed(foregroundX+p.x*WIDTH*FOREGROUND_SCALE)} ${fixed(FOREGROUND_Y+p.y*HEIGHT*FOREGROUND_SCALE)}) rotate(${fixed(p.rotation)}) scale(.65)`);
    layers.trajectory.style.display=showTrajectory?'':'none';
    const dot=layers.trajectory.querySelector('[data-part="phase-dot"]');dot.setAttribute('cx',String(p.x*WIDTH));dot.setAttribute('cy',String(p.y*HEIGHT));
    const comparePath=layers.trajectory.querySelector('[data-path="compare"]');
    if(compareScene){const comparison=validateScene(compareScene),key=[comparison.seed,comparison.wind,comparison.rain].join(':');if(key!==compareKey){comparePath.setAttribute('d',pointsPath(leafPath(comparison,{samples:31})));compareKey=key;}comparePath.style.display='';}
    else comparePath.style.display='none';
    for(const [name,value] of Object.entries({hour:current.hour,trees:current.trees,rain:current.rain,wind:current.wind,'branch-angle':current.branchAngle,'branch-depth':current.branchDepth,flowers:current.flowers,phase,'leaf-x':p.x,'leaf-y':p.y,night:moon}))svgElement.setAttribute('data-'+name,String(value));
  }

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
    if(!current||event.button!==0||drag)return;
    const p=svgPoint(event);if(!p)return;event.preventDefault();
    drag={pointerId:event.pointerId,x:p.x,span:sunSpan,startHour:current.hour,hour:current.hour};
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
    const target=event.target.closest?.('[data-select]');if(!target||!svgElement.contains(target))return;
    if(target.dataset.select==='leaf'&&typeof onLeafSelect==='function')onLeafSelect();
    if(target.dataset.select==='tree'&&typeof onTreeSelect==='function')onTreeSelect();
  };
  listen(svgElement,'click',select);
  listen(svgElement,'keydown',(event)=>{if(event.target.closest?.('[data-select]')&&['Enter',' '].includes(event.key)){event.preventDefault();select(event);}});
  return {
    render,
    getSvgMarkup:()=>svgElement.outerHTML,
    destroy(){if(destroyed)return;destroyed=true;disposers.forEach(dispose=>dispose());if(drag&&sunControl.hasPointerCapture?.(drag.pointerId))sunControl.releasePointerCapture(drag.pointerId);drag=null;if(svgElement.getAttribute('data-landscape-mount')===id)svgElement.replaceChildren();},
  };
}
