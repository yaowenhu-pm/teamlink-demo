const clamp = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const round4 = n => Number(clamp(n).toFixed(4));

/** Bound a captured stroke by arc length, preserving its first and last points. */
export function drawingPoints(values, maxPoints = 40) {
  const points = [];
  for (const value of values) {
    if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) continue;
    const point = {x: round4(value.x), y: round4(value.y)}, last = points.at(-1);
    if (!last || point.x !== last.x || point.y !== last.y) points.push(point);
  }
  if (points.length <= maxPoints) return points;
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances.at(-1) + Math.hypot(points[i].x-points[i-1].x, points[i].y-points[i-1].y));
  const total = distances.at(-1), result = [points[0]];
  let cursor = 1;
  for (let i = 1; i < maxPoints-1; i++) {
    const distance = total*i/(maxPoints-1);
    while (cursor < distances.length-1 && distances[cursor] < distance) cursor++;
    const a = points[cursor-1], b = points[cursor], ratio = (distance-distances[cursor-1])/(distances[cursor]-distances[cursor-1] || 1);
    result.push({x: round4(a.x+(b.x-a.x)*ratio), y: round4(a.y+(b.y-a.y)*ratio)});
  }
  result.push(points.at(-1));
  return result;
}

/** Deterministic visual motion. No shared scene parameters or clocks are mutated. */
export function ambientMotion(kind, seconds, {wind = .3, index = 0, depth = .6, travelRange} = {}) {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const breeze = clamp(wind), offset = index*.83;
  const swing = (rate, phase = offset) => Math.sin(t*rate+phase)-Math.sin(phase);
  if (kind === 'sun') return {x: swing(.025, 0)*18, y: swing(.019, 0)*4.5};
  if (kind === 'boat') {
    const amplitude=78+breeze*14;
    const low=Math.min(0,Math.max(-amplitude,travelRange?.min??-amplitude));
    const high=Math.max(0,Math.min(amplitude,travelRange?.max??amplitude));
    const center=(low+high)/2,radius=(high-low)/2;
    // Start at the saved anchor, turning continuously inside the visible sea.
    const start=radius?Math.asin(clamp(-center/radius,-1,1)):0;
    const angle=high>=-low?start:Math.PI-start;
    return {x:radius?center+radius*Math.sin(t*.23+angle):0, y:swing(.8)*(1+breeze*2),
      rotation:swing(.7)*(1+breeze*2.2),wake:.38+.18*(.5+.5*Math.sin(t*1.3+offset))};
  }
  if (kind === 'bird') return {x: swing(.16)*(24+breeze*12)+swing(.045)*9, y: swing(.28)*7, rotation: swing(.19)*5, flap: Math.sin(t*5.6+index*1.4)};
  if (kind === 'water') {
    const distance=clamp(depth);
    return {x:Math.sin(t*(.22+distance*.1))*(18+distance*68),y:Math.sin(t*.37+distance)*(1+distance*2.5),
      highlight:.76+Math.sin(t*(.8+distance*.3)+distance*2)*.2,flow:t*(5+distance*17)};
  }
  if (kind === 'cloud') return {x: swing(.035, 0)*(8+breeze*12), y: 0};
  if (kind === 'rain') return {x: -(t*.8%1)*breeze*24, y: (t*.8%1)*55};
  return {x: 0, y: 0};
}
