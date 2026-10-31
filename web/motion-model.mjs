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

/** Small deterministic visual offsets. No scene parameters or clocks are mutated. */
export function ambientMotion(kind, seconds, {wind = .3, index = 0} = {}) {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const breeze = clamp(wind), offset = index*.83;
  const swing = (rate, phase = offset) => Math.sin(t*rate+phase)-Math.sin(phase);
  if (kind === 'sun') return {x: swing(.025, 0)*18, y: swing(.019, 0)*4.5};
  if (kind === 'boat') return {x: swing(.075)*(12+breeze*15), y: swing(.62)*(.7+breeze*1.5), rotation: swing(.54)*(.7+breeze*1.7), wake: .2+.16*(.5+.5*Math.sin(t*.8+offset))};
  if (kind === 'bird') return {x: swing(.16)*(24+breeze*12)+swing(.045)*9, y: swing(.28)*7, rotation: swing(.19)*5, flap: Math.sin(t*5.6+index*1.4)};
  if (kind === 'water') return {x: swing(.19, 0)*(4+breeze*8), y: swing(.13, 0)*.9, highlight: .78+Math.sin(t*.47)*.13};
  if (kind === 'cloud') return {x: swing(.035, 0)*(8+breeze*12), y: 0};
  if (kind === 'rain') return {x: -(t*.8%1)*breeze*24, y: (t*.8%1)*55};
  return {x: 0, y: 0};
}

export function streamLeaf(index, seconds, count = 28) {
  const time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const duration = 10+(index%5)*.9;
  const phase = ((time/duration+index/count)%1+1)%1;
  const fade = Math.min(1, phase*12, (1-phase)*10);
  return {phase, opacity: fade*(.38+(index%4)*.12), scale: .29+(index%6)*.065,
    rotation: Math.sin(time*1.3+index*2.1)*12};
}
