/** A small, deterministic scene model. Instructions use local rules, never an LLM. */
export const SCENE_LIMITS = Object.freeze({
  seed: Object.freeze({ min: 0, max: 4294967295, integer: true }),
  hour: Object.freeze({ min: 0, max: 24 }),
  trees: Object.freeze({ min: 0, max: 100, integer: true }),
  boats: Object.freeze({ min: 0, max: 8, integer: true }),
  mountains: Object.freeze({ min: 0, max: 8, integer: true }),
  rain: Object.freeze({ min: 0, max: 1 }),
  wind: Object.freeze({ min: 0, max: 1 }),
  branchAngle: Object.freeze({ min: 5, max: 80 }),
  branchDepth: Object.freeze({ min: 1, max: 8, integer: true }),
  flowers: Object.freeze({ min: 0, max: 100, integer: true }),
});

const DEFAULT_SCENE = Object.freeze({ schemaVersion: 1, seed: 72, hour: 18.3, trees: 40,
  rain: 0, wind: 0.3, branchAngle: 32, branchDepth: 5, boats: 1, mountains: 2, boat: true, flowers: 30 });
const LABELS = Object.freeze({ seed: '场景种子', hour: '时间', trees: '树木', rain: '雨量', wind: '风力',
  branchAngle: '树枝角度', branchDepth: '树枝层数', boats: '帆船数量', mountains: '山峰数量', boat: '帆船', flowers: '花朵' });
const FIELDS = Object.keys(DEFAULT_SCENE);
const EDITABLE_FIELDS = FIELDS.filter((key) => key !== 'schemaVersion');
const CANONICAL_FIELDS = EDITABLE_FIELDS.filter((key) => key !== 'boat');
const LEGACY_OPTIONAL_FIELDS = ['boats', 'mountains'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const rounded = (value) => Math.round(value * 1e6) / 1e6;

export class SceneModelError extends Error {
  constructor(message, code = 'INVALID_SCENE') { super(message); this.name = 'SceneModelError'; this.code = code; }
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new SceneModelError(`${label}必须是普通对象。`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !own(descriptor, 'value')) {
      throw new SceneModelError(`${label}只能包含普通数据字段。`);
    }
  }
}

function assertValue(key, value) {
  if (key === 'schemaVersion') {
    if (value !== 1) throw new SceneModelError('仅支持场景版本 1。');
    return;
  }
  if (key === 'boat') {
    if (typeof value !== 'boolean') throw new SceneModelError('帆船必须为布尔值。');
    return;
  }
  const limit = SCENE_LIMITS[key];
  if (!limit || typeof value !== 'number' || !Number.isFinite(value) ||
      value < limit.min || value > limit.max || (limit.integer && !Number.isInteger(value))) {
    throw new SceneModelError(`${LABELS[key] || key}必须为 ${limit?.min}–${limit?.max} 之间的${limit?.integer ? '整数' : '数字'}。`);
  }
}

export function createScene() { return Object.freeze({ ...DEFAULT_SCENE }); }

/** Reject unknown, missing, inherited, accessor and non-finite fields; return a frozen copy. */
export function validateScene(scene) {
  assertRecord(scene, '场景');
  const keys = Object.getOwnPropertyNames(scene);
  if (keys.some((key) => !FIELDS.includes(key)) ||
      FIELDS.some((key) => !own(scene, key) && !LEGACY_OPTIONAL_FIELDS.includes(key))) throw new SceneModelError('场景字段不完整或含有未知字段。');
  const copy = {};
  for (const key of FIELDS) {
    const value = own(scene, key) ? scene[key] : key === 'boats' ? (scene.boat ? 1 : 0) : DEFAULT_SCENE[key];
    assertValue(key, value); copy[key] = value;
  }
  if (copy.boat !== (copy.boats > 0)) throw new SceneModelError('帆船显示状态必须与帆船数量一致。');
  return Object.freeze(copy);
}

export function updateScene(scene, patch) {
  const current = validateScene(scene);
  assertRecord(patch, '修改');
  for (const key of Object.getOwnPropertyNames(patch)) {
    if (!EDITABLE_FIELDS.includes(key)) throw new SceneModelError(`不允许修改字段：${key}。`, 'INVALID_PATCH');
    assertValue(key, patch[key]);
  }
  if (own(patch, 'boats') && own(patch, 'boat') && patch.boat !== (patch.boats > 0)) {
    throw new SceneModelError('帆船数量与显示状态矛盾。', 'INVALID_PATCH');
  }
  const next = { ...current, ...patch };
  if (own(patch, 'boats')) next.boat = patch.boats > 0;
  else if (own(patch, 'boat')) next.boats = patch.boat ? Math.max(1, current.boats) : 0;
  return validateScene(next);
}

export function sceneChanges(before, after) {
  const a = validateScene(before), b = validateScene(after);
  return Object.freeze(CANONICAL_FIELDS.filter((key) => a[key] !== b[key])
    .map((key) => Object.freeze({ key, label: LABELS[key], before: a[key], after: b[key] })));
}

// Only decimal literals and common Chinese integer forms are accepted. No expressions or code.
const NUM = '[-+]?(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千]+)';
function number(value) {
  const english = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };
  if (own(english, value)) return english[value];
  if (/^[-+]?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^[零〇一二两三四五六七八九]+$/.test(value)) return Number([...value].map((c) => digits[c]).join(''));
  // Conventional descending units only, so malformed “十十” is not guessed.
  if (!/^(?:[一二两三四五六七八九]千)?(?:[一二两三四五六七八九]百)?零?(?:[一二两三四五六七八九]?十)?[一二两三四五六七八九]?$/.test(value)) return NaN;
  let total = 0, digit = 0;
  for (const char of value) {
    if (own(digits, char)) digit = digits[char];
    else { total += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char]); digit = 0; }
  }
  return total + digit;
}

const rx = (source) => new RegExp(`^(?:${source})$`, 'u');
const CH_SET = '(?:改成|改为|变成|设为|设置为|调到|调成|调整为|变为|到|为)';
const CH_END = '(?:吧|了)?';
const CH_SUBJECT = '(?:天空|场景|画面|时间|天气)';
const PERIODS = { 夜晚: 22, 夜间: 22, 夜色: 22, 晚上: 22, 午夜: 0, 日出: 6.3, 清晨: 6.3, 早晨: 7,
  中午: 12, 正午: 12, 白天: 13, 傍晚: 18.3, 黄昏: 18.3, 日落: 18.3, 夕阳: 18.3,
  night: 22, nighttime: 22, midnight: 0, sunrise: 6.3, dawn: 6.3, morning: 7,
  noon: 12, midday: 12, daytime: 13, day: 13, sunset: 18.3, dusk: 18.3, evening: 18.3 };

function relative(scene, key, amount) {
  const { min, max } = SCENE_LIMITS[key];
  return { [key]: rounded(clamp(scene[key] + amount, min, max)) };
}

const COUNT_NUM = `(?:${NUM}|zero|one|two|three|four|five|six|seven|eight|nine|ten|a|an)`;
const COUNT_OBJECTS = Object.freeze([
  { key: 'boats', chinese: '(?:帆船|小船|船)', measure: '(?:艘|只|条)', english: '(?:sailboats?|boats?)' },
  { key: 'mountains', chinese: '(?:山峰|山脉|高山|山)', measure: '(?:座|个)', english: 'mountains?' },
]);
const TREE_OBJECT = { key: 'trees', chinese: '(?:树木|树)', measure: '(?:棵)', english: 'trees?' };
function removesAll(clause, { chinese: object, english }) {
  return rx(`(?:移除|去掉|删除|清空|隐藏|不要|没有|不显示)(?:所有|全部|这些|任何)?(?:的)?${object}${CH_END}|(?:所有|全部)?${object}(?:全部|都)?(?:移除|去掉|删除|清空|隐藏|不要|没有|消失)${CH_END}|(?:remove|delete|clear|hide)(?: all)?(?: the)? ${english}|(?:no|zero) ${english}|${english} (?:are )?(?:gone|removed)`).test(clause);
}
function parseObjectCount(clause, scene, { key, chinese: object, measure, english }) {
  let match = clause.match(rx(`(?:再)?(增加|添加|加上|加|减少|移除|删掉|去掉|减|多|少)(${COUNT_NUM})${measure}?${object}${CH_END}|${object}(?:的数量|数量)?(?:再|变)?(增加|减少|加|减|多|少)(${COUNT_NUM})${measure}?${CH_END}|(add|remove) (${COUNT_NUM}) ${english}|(increase|decrease) (?:the )?${english} by (${COUNT_NUM})`));
  if (match) {
    const verb = match[1] ?? match[3] ?? match[5] ?? match[7];
    const amount = number(match[2] ?? match[4] ?? match[6] ?? match[8]);
    if (!Number.isInteger(amount) || amount < 0) return null;
    const decrease = ['减少', '移除', '删掉', '去掉', '减', '少', 'remove', 'decrease'].includes(verb);
    return { [key]: scene[key] + amount * (decrease ? -1 : 1) };
  }
  match = clause.match(rx(`${object}(?:的数量|数量)?(?:${CH_SET})?(${COUNT_NUM})${measure}?${CH_END}|(${COUNT_NUM})${measure}${object}${CH_END}|(?:set )?(?:the )?${english}(?: to)? (${COUNT_NUM})|(${COUNT_NUM}) ${english}`));
  if (match) return { [key]: number(match[1] ?? match[2] ?? match[3] ?? match[4]) };
  match = clause.match(rx(`(?:再)?(多|少|增加|减少|添加|移除)(?:几${measure}?|一?点|一些)${object}${CH_END}|${object}(?:的数量|数量)?(?:再|变)?(多|少|增加|减少)(?:几${measure}?|一?点|一些)?${CH_END}|(?:a few )?(more|fewer|less) ${english}|(?:make )?${english} (more|fewer|less)`));
  if (match) {
    const decrease = ['少', '减少', '移除', 'fewer', 'less'].includes(match[1] ?? match[2] ?? match[3] ?? match[4]);
    return relative(scene, key, decrease ? -2 : 2);
  }
  return null;
}

function parseClause(raw, scene) {
  const clause = raw.replace(/^(?:请|麻烦)?(?:帮我)?(?:把|将|让)?/u, '').replace(/[!！?？]+$/u, '').trim();
  let match;
  for (const object of [TREE_OBJECT, ...COUNT_OBJECTS]) if (removesAll(clause, object)) return { [object.key]: 0 };
  for (const object of COUNT_OBJECTS) { const patch = parseObjectCount(clause, scene, object); if (patch) return patch; }
  // These are explicit negated commands; other negations never reach positive patterns.
  if (rx(`(?:不要|不用|别|停止|取消|关闭)(?:再)?下雨${CH_END}|不下雨${CH_END}|雨(?:停|停下|停止|取消)${CH_END}|(?:stop|remove|disable|no) (?:the )?rain|(?:turn|switch) (?:the )?rain off`).test(clause)) return { rain: 0 };
  if (rx(`(?:风停|停风|无风|风停下|风停止)${CH_END}|(?:不要|停止|关闭)(?:吹风|风)${CH_END}|(?:stop|disable|no) (?:the )?wind|(?:turn|switch) (?:the )?wind off`).test(clause)) return { wind: 0 };
  if (rx(`(?:隐藏|去掉|移除|关闭|不要|不显示)(?:那艘|这艘|一艘)?(?:帆船|小船|船)${CH_END}|(?:帆船|小船|船)(?:隐藏|消失|去掉|关闭|不显示)${CH_END}|(?:hide|remove|disable)(?: the)? (?:sailboat|boat)|(?:no boat|boat off)`).test(clause)) return { boat: false };
  if (rx(`(?:显示|添加|加上|打开|恢复)(?:一艘)?(?:帆船|小船|船)${CH_END}|(?:帆船|小船|船)(?:显示|出现|打开)${CH_END}|(?:show|add|enable)(?: a| the)? (?:sailboat|boat)|boat on`).test(clause)) return { boat: true };

  match = clause.match(rx(`(?:${CH_SUBJECT})?(?:${CH_SET})?(${Object.keys(PERIODS).filter((key) => /[\u4e00-\u9fff]/u.test(key)).join('|')})${CH_END}`));
  if (match) return { hour: PERIODS[match[1]] };
  match = clause.match(/^(?:(?:make|set|change|switch)(?: the)?(?: scene| sky| time| it)?(?: to| at)? )?(night|nighttime|midnight|sunrise|dawn|morning|noon|midday|daytime|day|sunset|dusk|evening)$/u);
  if (match) return { hour: PERIODS[match[1]] };
  match = clause.match(rx(`(?:时间|小时)(?:${CH_SET})?(${NUM})(?:点|时|小时)?${CH_END}|(?:set )?(?:the )?(?:time|hour)(?: to| at)? (${NUM})(?: hours?)?`));
  if (match) return { hour: number(match[1] ?? match[2]) };

  match = clause.match(rx(`太阳(?:再|变|调|升|降)?(?:得)?(高|低)(?:一?点|一些|一点点)?${CH_END}|(?:raise|lower)(?: the)? sun|(?:sun|the sun)(?: a little)? (higher|lower)`));
  if (match) {
    const higher = match[1] === '高' || match[2] === 'higher' || /^raise /u.test(clause);
    const direction = scene.hour < 12 ? 1 : -1;
    return relative(scene, 'hour', (higher ? 1 : -1) * direction * 0.7);
  }

  match = clause.match(rx(`(?:树木|树)(?:的数量|数量)?(?:${CH_SET})?(${NUM})(?:棵)?${CH_END}|(${NUM})棵(?:树木|树)${CH_END}|(?:set )?(?:the )?trees(?: to)? (${NUM})`));
  if (match) return { trees: number(match[1] ?? match[2] ?? match[3]) };
  match = clause.match(rx(`(?:花朵|花)(?:的数量|数量)?(?:${CH_SET})?(${NUM})(?:朵)?${CH_END}|(${NUM})朵(?:花朵|花)${CH_END}|(?:set )?(?:the )?flowers(?: to)? (${NUM})`));
  if (match) return { flowers: number(match[1] ?? match[2] ?? match[3]) };
  match = clause.match(rx(`(树木|树|花朵|花)(?:的数量|数量)?(?:再|变)?(多|少|增加|减少|加|减)(?:一?点|一些|一点点)?${CH_END}|(more|fewer|less) (trees|flowers)|(?:make )?(trees|flowers)(?: a little)? (more|fewer|less)`));
  if (match) {
    const key = /树/u.test(match[1] || '') || match[4] === 'trees' || match[5] === 'trees' ? 'trees' : 'flowers';
    const decrease = ['少', '减少', '减', 'fewer', 'less'].includes(match[2] || match[3] || match[6]);
    return relative(scene, key, decrease ? -10 : 10);
  }
  match = clause.match(rx(`(树木|树|花朵|花)(?:的数量|数量)?(?:再)?(增加|减少|加|减|多|少)(${NUM})(?:棵|朵)?${CH_END}|(add|remove) (${NUM}) (trees|flowers)`));
  if (match) {
    const key = /树/u.test(match[1] || '') || match[6] === 'trees' ? 'trees' : 'flowers';
    const amount = number(match[3] ?? match[5]);
    if (amount < 0 || !Number.isInteger(amount)) return null;
    const decrease = ['减少', '减', '少', 'remove'].includes(match[2] || match[4]);
    return relative(scene, key, amount * (decrease ? -1 : 1));
  }

  if (rx(`(?:开始)?下雨${CH_END}|(?:加|来)(?:一?点|一些)?雨${CH_END}|(?:start|add|enable)(?: the)? rain|rain(?: on)?`).test(clause)) return { rain: Math.max(scene.rain, 0.55) };
  if (rx(`(?:下)?大雨${CH_END}|heavy rain`).test(clause)) return { rain: 0.85 };
  if (rx(`(?:下)?(?:小雨|毛毛雨)${CH_END}|light rain|drizzle`).test(clause)) return { rain: 0.25 };
  match = clause.match(rx(`(?:雨量|雨|风力|风)(?:${CH_SET})?(${NUM})(%)?${CH_END}|(?:set )?(?:the )?(rain|wind)(?: to)? (${NUM})(%)?`));
  if (match) {
    const key = /^(?:雨量|雨)/u.test(clause) || match[3] === 'rain' ? 'rain' : 'wind';
    return { [key]: number(match[1] ?? match[4]) / ((match[2] || match[5]) ? 100 : 1) };
  }
  match = clause.match(rx(`(雨量|雨|风力|风)(?:再|变|调)?(?:得)?(大|小|强|弱)(?:一?点|一些|一点点)?${CH_END}|(more|less|stronger|weaker|heavier|lighter) (rain|wind)|(?:make )?(rain|wind)(?: a little)? (stronger|weaker|heavier|lighter)`));
  if (match) {
    const key = /^雨/u.test(match[1] || '') || match[4] === 'rain' || match[5] === 'rain' ? 'rain' : 'wind';
    const decrease = ['小', '弱', 'less', 'weaker', 'lighter'].includes(match[2] || match[3] || match[6]);
    return relative(scene, key, decrease ? -0.2 : 0.2);
  }

  match = clause.match(rx(`(?:树枝|枝条|枝)?(?:的)?(?:角度|分叉角)(?:${CH_SET})?(${NUM})(?:度|°)?${CH_END}|(?:set )?(?:the )?branch angle(?: to)? (${NUM})(?: degrees?)?`));
  if (match) return { branchAngle: number(match[1] ?? match[2]) };
  match = clause.match(rx(`(?:树枝|树|枝条)?(?:的)?(?:递归)?(?:层数|层级|深度)(?:${CH_SET})?(${NUM})(?:层)?${CH_END}|(?:树枝|枝条)(${NUM})层${CH_END}|(?:set )?(?:the )?branch (?:depth|layers)(?: to)? (${NUM})`));
  if (match) return { branchDepth: number(match[1] ?? match[2] ?? match[3]) };
  return null;
}

function unsupported(reason) {
  return Object.freeze({ supported: false, patch: Object.freeze({}), changes: Object.freeze([]),
    reply: `本地调景规则未执行：${reason} 可试「改成夜晚，树多一点，增加两艘船」；目前支持时间、太阳高低、树花船山数量、移除全部树、雨、风和树枝角度/层数。` });
}

/** Complete clause matching is intentional: no silent partial application of unknown instructions. */
export function interpretInstruction(text, scene) {
  let current = validateScene(scene);
  if (typeof text !== 'string' || !text.trim()) return unsupported('请输入一条调景指令。');
  if (text.length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) return unsupported('指令过长或含有不支持的字符。');
  const clauses = text.normalize('NFKC').toLowerCase().trim()
    .split(/[,，。;；、\n]+|\.(?!\d)|\s+(?:and(?:\s+then)?|then)\s+|并且|而且|然后|同时|以及|还有|并|和/u)
    .map((part) => part.trim()).filter(Boolean);
  if (!clauses.length || clauses.length > 20) return unsupported('请使用不超过 20 条简短指令。');
  for (const clause of clauses) {
    const patch = parseClause(clause, current);
    if (!patch) return unsupported('有子句不在支持的规则中，整条指令均未应用。');
    try { current = updateScene(current, patch); }
    catch { return unsupported('有数值超出范围，整条指令均未应用。'); }
  }
  const changes = sceneChanges(scene, current);
  const patch = Object.freeze(Object.fromEntries(changes.map(({ key, after }) => [key, after])));
  const summary = changes.map(({ label, after }) => `${label}→${typeof after === 'boolean' ? (after ? '显示' : '隐藏') : after}`).join('，');
  return Object.freeze({ supported: true, patch, changes,
    reply: `本地调景规则已执行：${summary || '当前场景已符合指令，无需更改'}。` });
}

/** Sun follows the same daily arc for rendering, dragging and timeline inspection. */
export function solarPosition(hour) {
  assertValue('hour', hour);
  const altitude = Math.sin((hour - 6) * Math.PI / 12);
  return Object.freeze({ x: rounded(0.08 + 0.84 * clamp((hour - 6) / 12, 0, 1)),
    y: rounded(clamp(0.82 - 0.64 * altitude, 0.02, 0.98)), altitude: rounded(altitude),
    visible: altitude >= -0.12, daylight: rounded(clamp((altitude + 0.1) / 1.1, 0, 1)) });
}

/** Deterministic normalized trajectory; t is 0..1 and rotation is in degrees. No wall clock. */
export function leafPath(scene, { samples = 31 } = {}) {
  const value = validateScene(scene);
  if (!Number.isInteger(samples) || samples < 2 || samples > 241) throw new SceneModelError('轨迹采样数必须为 2–241 的整数。');
  let state = value.seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const phase = random() * Math.PI * 2, frequency = 1.4 + random() * 0.8;
  const origin = 0.28 + random() * 0.1;
  return Object.freeze(Array.from({ length: samples }, (_, index) => {
    const t = index / (samples - 1);
    const sway = Math.sin(t * frequency * Math.PI * 2 + phase) * (0.012 + value.wind * 0.065) * t;
    return Object.freeze({ t: rounded(t), x: rounded(clamp(origin + value.wind * 0.38 * t + sway, 0.02, 0.98)),
      y: rounded(0.24 + 0.7 * Math.pow(t, 0.9 - value.rain * 0.3)),
      rotation: rounded(Math.sin(t * frequency * Math.PI * 2 + phase) * (10 + value.wind * 55) * t + t * value.wind * 90) });
  }));
}
