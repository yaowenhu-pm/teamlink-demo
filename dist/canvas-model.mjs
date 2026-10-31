/** An executable local model, not an API client or an inferred interpretation of prose. */
export class CanvasModelError extends Error {
  constructor(code, message) { super(message); this.name = 'CanvasModelError'; this.code = code; }
}
const fail = (code, message) => { throw new CanvasModelError(code, message); };
const ensure = (condition, message, code = 'INVALID_DOCUMENT') => { if (!condition) fail(code, message); };
const plain = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const clone = (value) => structuredClone(value);
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
export const LIMITS = freeze({ documentBytes: 18000, rows: 80, title: 120, subtitle: 300, buttonLabel: 60,
  errorMessage: 300, successMessage: 300, rowTitle: 160, networkMultiplier: 10, timeoutMs: 20000,
  baseLatencyMs: 5000, perRowLatencyMs: 2000 });
const CONTENT = ['title', 'subtitle', 'buttonLabel', 'errorMessage', 'successMessage'];
const EXPECTATIONS = ['preserveFilters', 'retryMatchesOriginal', 'fileMatchesOriginal'];
const ROOT = ['schemaVersion', 'content', 'data', 'filters', 'rules', 'networkMultiplier', 'retryNetworkMultiplier', 'expectations'];
const RULES = ['preserveFilters', 'retrySource', 'timeoutMs', 'baseLatencyMs', 'perRowLatencyMs'];
const own = (value, keys, label) => {
  ensure(plain(value) && Object.keys(value).every((key) => keys.includes(key)), `${label}包含不支持的字段。`);
};
const text = (value, max, label) => {
  ensure(typeof value === 'string' && value.length <= max, `${label}应为不超过 ${max} 字的文字。`);
  return value;
};
const bounded = (value, max, label, integer = false) => {
  ensure(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max && (!integer || Number.isSafeInteger(value)),
    `${label}应为 0 至 ${max} 的${integer ? '整数' : '数值'}。`);
  return value;
};
function stableJson(value) {
  const normalized = (item) => {
    if (item === null || ['string', 'boolean'].includes(typeof item)) return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalized);
    ensure(plain(item), '文档只能包含普通 JSON 数据。');
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalized(item[key])]));
  };
  return JSON.stringify(normalized(value));
}
const utf8Bytes = (text) => new TextEncoder().encode(text);
function filtersInput(value) {
  own(value, ['month', 'category'], '筛选条件');
  ensure(typeof value.month === 'string' && (value.month === 'all' || /^20\d\d-(?:0[1-9]|1[0-2])$/.test(value.month)), '月份应为有效的 20xx-MM 或 all。');
  return { month: value.month, category: categoryInput(value.category, true) };
}
function categoryInput(value, filter = false) {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 40, '分类应为 1 至 40 字的文字。');
  const category = value.trim();
  ensure(filter || category !== '全部', '“全部”仅用于筛选，请为数据行填写具体分类。');
  return category;
}
function rowsInput(value) {
  ensure(Array.isArray(value) && value.length <= LIMITS.rows, `数据最多 ${LIMITS.rows} 行。`);
  const ids = new Set();
  return value.map((row) => {
    own(row, ['id', 'date', 'category', 'title', 'amount'], '数据行');
    ensure(typeof row.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(row.id) && !ids.has(row.id), '每条数据需要不重复的稳定编号。');
    ids.add(row.id);
    ensure(typeof row.date === 'string' && /^20\d\d-\d\d-\d\d$/.test(row.date), '日期应为 YYYY-MM-DD。');
    const timestamp = Date.parse(`${row.date}T00:00:00Z`);
    ensure(Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === row.date, '日期不存在。');
    const result = { id: row.id, date: row.date, category: categoryInput(row.category), title: text(row.title, LIMITS.rowTitle, '事项') };
    if (row.amount !== undefined) result.amount = bounded(row.amount, 1_000_000_000, '金额');
    return result;
  });
}

const DEFAULT = freeze({
  schemaVersion: 1,
  content: { title: '把这次想法，导出成一份清楚的记录', subtitle: '选择月份与分类，导出你当前看到的数据。',
    buttonLabel: '导出记录', errorMessage: '这次导出超时了。你可以保留当前选择后重试。', successMessage: '导出完成，可以下载并核对数据。' },
  data: [
    { id: 'r01', date: '2026-10-03', category: '产品', title: '活动报名流程梳理', amount: 180 },
    { id: 'r02', date: '2026-10-12', category: '产品', title: '导出失败反馈整理', amount: 320 },
    { id: 'r03', date: '2026-10-26', category: '产品', title: '筛选条件体验核对', amount: 260 },
    { id: 'r04', date: '2026-10-08', category: '研发', title: '重试参数逻辑检查', amount: 420 },
    { id: 'r05', date: '2026-10-22', category: '研发', title: '导出文件字段调整', amount: 510 },
    { id: 'r06', date: '2026-09-07', category: '产品', title: '上月访谈记录汇总', amount: 160 },
    { id: 'r07', date: '2026-09-18', category: '研发', title: '上月数据接口整理', amount: 380 },
    { id: 'r08', date: '2026-11-02', category: '产品', title: '下月试用计划草稿', amount: 240 },
    { id: 'r09', date: '2026-11-05', category: '研发', title: '下月异常场景草稿', amount: 360 },
    { id: 'r10', date: '2026-11-11', category: '产品', title: '下月反馈分类草稿', amount: 290 },
  ],
  filters: { month: '2026-10', category: '产品' },
  rules: { preserveFilters: false, retrySource: 'visible', timeoutMs: 800, baseLatencyMs: 180, perRowLatencyMs: 140 },
  networkMultiplier: 1.8, retryNetworkMultiplier: 0.35,
  expectations: { preserveFilters: true, retryMatchesOriginal: true, fileMatchesOriginal: true },
});

export function validateDocument(value) {
  own(value, ROOT, '文档');
  ensure(value.schemaVersion === 1, '不支持这个文档版本。');
  own(value.content, CONTENT, '文案');
  const content = Object.fromEntries(CONTENT.map((key) => [key, text(value.content[key], LIMITS[key], key)]));
  own(value.rules, RULES, '行为规则');
  ensure(typeof value.rules.preserveFilters === 'boolean', '保留筛选条件应为明确的开关。');
  ensure(['original', 'visible'].includes(value.rules.retrySource), '重试应使用最初条件或当前可见条件。');
  const rules = { preserveFilters: value.rules.preserveFilters, retrySource: value.rules.retrySource,
    timeoutMs: bounded(value.rules.timeoutMs, LIMITS.timeoutMs, '超时预算', true),
    baseLatencyMs: bounded(value.rules.baseLatencyMs, LIMITS.baseLatencyMs, '基础耗时', true),
    perRowLatencyMs: bounded(value.rules.perRowLatencyMs, LIMITS.perRowLatencyMs, '每行耗时', true) };
  const expected = value.expectations === undefined ? {} : value.expectations;
  own(expected, EXPECTATIONS, '期望');
  const expectations = Object.fromEntries(EXPECTATIONS.map((key) => {
    const item = expected[key] === undefined ? true : expected[key];
    ensure(typeof item === 'boolean', '期望应为明确的布尔值。');
    return [key, item];
  }));
  const normalized = { schemaVersion: 1, content, data: rowsInput(value.data), filters: filtersInput(value.filters), rules,
    networkMultiplier: bounded(value.networkMultiplier, LIMITS.networkMultiplier, '首次网络系数'),
    retryNetworkMultiplier: bounded(value.retryNetworkMultiplier, LIMITS.networkMultiplier, '重试网络系数'), expectations };
  ensure(utf8Bytes(stableJson(normalized)).length <= LIMITS.documentBytes, '文档内容过长，请减少数据行或文字。', 'DOCUMENT_TOO_LARGE');
  return freeze(normalized);
}
export function updateDocument(document, patch) {
  const current = validateDocument(document);
  own(patch, ROOT.filter((key) => key !== 'schemaVersion'), '修改');
  for (const [key, allowed] of [['content', CONTENT], ['filters', ['month', 'category']], ['rules', RULES], ['expectations', EXPECTATIONS]]) {
    if (patch[key] !== undefined) own(patch[key], allowed, key);
  }
  return validateDocument({ ...current, ...patch,
    content: { ...current.content, ...patch.content }, filters: { ...current.filters, ...patch.filters },
    rules: { ...current.rules, ...patch.rules }, expectations: { ...current.expectations, ...patch.expectations } });
}
export function createDocument(patch = {}) { return updateDocument(DEFAULT, patch); }

export function filterRows(rows, filters) {
  const checkedRows = rowsInput(rows), checkedFilters = filtersInput(filters);
  return checkedRows.filter((row) => (checkedFilters.month === 'all' || row.date.startsWith(`${checkedFilters.month}-`)) &&
    (checkedFilters.category === '全部' || row.category === checkedFilters.category));
}
const sameFilters = (a, b) => a.month === b.month && a.category === b.category;
const sameRows = (a, b) => stableJson(a) === stableJson(b);
const filterLabel = (filters) => `${filters.month === 'all' ? '全部月份' : `${filters.month.slice(0, 4)} 年 ${Number(filters.month.slice(5))} 月`} / ${filters.category}`;
const latency = (document, rows, multiplier) => (document.rules.baseLatencyMs + rows.length * document.rules.perRowLatencyMs) * multiplier;
const formula = (document, rows, multiplier, duration) => `（${document.rules.baseLatencyMs} + ${rows.length} × ${document.rules.perRowLatencyMs}）× ${multiplier} = ${Math.round(duration * 100) / 100} 毫秒`;
const assertion = (id, label, expected, actual, explanation) => ({ id, label, expected, actual,
  status: actual === null ? 'not_tested' : actual === expected ? 'passed' : 'failed', explanation });

/** Both attempts and every context use this exact filter/latency/export computation. */
export function evaluateExport(value, overrides = {}) {
  const document = validateDocument(value);
  own(overrides, ['networkMultiplier', 'retryNetworkMultiplier'], '环境覆盖');
  const networkMultiplier = overrides.networkMultiplier === undefined ? document.networkMultiplier : overrides.networkMultiplier;
  const retryNetworkMultiplier = overrides.retryNetworkMultiplier === undefined ? document.retryNetworkMultiplier : overrides.retryNetworkMultiplier;
  bounded(networkMultiplier, LIMITS.networkMultiplier, '首次网络系数');
  bounded(retryNetworkMultiplier, LIMITS.networkMultiplier, '重试网络系数');
  const initialFilters = clone(document.filters), rows = filterRows(document.data, initialFilters);
  const duration = latency(document, rows, networkMultiplier), timedOut = duration > document.rules.timeoutMs;
  const afterTimeoutFilters = timedOut && !document.rules.preserveFilters ? { month: 'all', category: '全部' } : clone(initialFilters);
  const retryFilters = clone(document.rules.retrySource === 'original' ? initialFilters : afterTimeoutFilters);
  const retryRows = filterRows(document.data, retryFilters), retryDuration = latency(document, retryRows, retryNetworkMultiplier);
  const retryTimedOut = timedOut && retryDuration > document.rules.timeoutMs;
  const completed = !timedOut || !retryTimedOut;
  const outputRows = !timedOut ? rows : retryTimedOut ? [] : retryRows;
  const requestFilters = timedOut ? retryFilters : initialFilters;
  const actualPreserved = sameFilters(initialFilters, afterTimeoutFilters);
  const actualRequestMatches = sameFilters(initialFilters, requestFilters);
  const actualFileMatches = completed ? sameRows(rows, outputRows) : null;
  const explanations = {
    initial: `最初选择 ${filterLabel(initialFilters)}，匹配 ${rows.length} 行。耗时按同一公式计算：${formula(document, rows, networkMultiplier, duration)}；预算 ${document.rules.timeoutMs} 毫秒，${timedOut ? '触发超时' : '在预算内完成'}。`,
    retry: !timedOut ? '首次已经完成，没有实际进入重试分支；重试条件和耗时只作为可比较的候选。' :
      `重试读取${document.rules.retrySource === 'original' ? '最初提交的条件' : '界面当前可见条件'}：${filterLabel(retryFilters)}，匹配 ${retryRows.length} 行。${formula(document, retryRows, retryNetworkMultiplier, retryDuration)}；${retryTimedOut ? '重试仍超时，没有生成文件' : '重试完成，文件使用这次请求的行'}。`,
    input: !timedOut ? '本次未超时，没有触发重置；界面仍保留最初选择。' :
      `${document.rules.preserveFilters ? '保留开关开启' : '保留开关关闭'}，超时后界面显示 ${filterLabel(afterTimeoutFilters)}，${actualPreserved ? '与最初选择一致' : '与最初选择不同'}。`,
    request: `${timedOut ? '重试' : '首次'}实际请求 ${filterLabel(requestFilters)}，${actualRequestMatches ? '与最初选择一致' : '已偏离最初选择'}。`,
    file: completed ? `实际文件含 ${outputRows.length} 行；最初选择对应 ${rows.length} 行，${actualFileMatches ? '内容一致' : '内容不一致'}。` : '两次尝试均超时，没有文件可核对；不能把候选数据当成已生成文件。',
  };
  const trace = [];
  const step = (id, phase, atMs, status, filters, requestFilters, visibleRows, outputRows, message) => {
    trace.push({ id, phase, atMs, status, filters: clone(filters), requestFilters: clone(requestFilters),
      rows: clone(visibleRows), requestRows: clone(filterRows(document.data, requestFilters)), outputRows: clone(outputRows), message });
  };
  step('before', 'initial', 0, 'idle', initialFilters, initialFilters, rows, [], document.content.subtitle);
  step('initial-request', 'initial', 0, 'pending', initialFilters, initialFilters, rows, [], document.content.buttonLabel);
  if (!timedOut) {
    step('initial-success', 'initial', duration, 'success', initialFilters, initialFilters, rows, outputRows, document.content.successMessage);
  } else {
    const visibleRows = filterRows(document.data, afterTimeoutFilters);
    step('initial-timeout', 'initial', document.rules.timeoutMs, 'timeout', afterTimeoutFilters, initialFilters, visibleRows, [], document.content.errorMessage);
    step('retry-request', 'retry', document.rules.timeoutMs, 'pending', afterTimeoutFilters, retryFilters, visibleRows, [], '按所选重试规则再次请求');
    step(retryTimedOut ? 'retry-timeout' : 'retry-success', 'retry', document.rules.timeoutMs + Math.min(retryDuration, document.rules.timeoutMs),
      retryTimedOut ? 'timeout' : 'success', afterTimeoutFilters, retryFilters, visibleRows, outputRows,
      retryTimedOut ? document.content.errorMessage : document.content.successMessage);
  }
  return freeze({ rows: clone(rows), initialFilters, afterTimeoutFilters, retryFilters, retryRows: clone(retryRows),
    outputRows: clone(outputRows), duration, retryDuration, timedOut, retryTimedOut, retried: timedOut, completed,
    terminal: !timedOut ? 'initial-success' : retryTimedOut ? 'retry-timeout' : 'retry-success',
    networkMultiplier, retryNetworkMultiplier,
    assertions: [
      assertion('input-preserved', '界面输入与最初条件一致', document.expectations.preserveFilters, actualPreserved, explanations.input),
      assertion('request-matches', '请求条件与最初条件一致', document.expectations.retryMatchesOriginal, actualRequestMatches, explanations.request),
      assertion('file-matches', '文件内容与最初选择一致', document.expectations.fileMatchesOriginal, actualFileMatches, explanations.file),
    ], trace, explanations });
}

export function evaluateContexts(value) {
  const document = validateDocument(value);
  return freeze([
    { id: 'current', label: '当前假设', networkMultiplier: document.networkMultiplier, retryNetworkMultiplier: document.retryNetworkMultiplier },
    { id: 'slow', label: '较慢网络', networkMultiplier: Math.max(document.networkMultiplier, 2.4), retryNetworkMultiplier: Math.max(document.retryNetworkMultiplier, 1.4) },
    { id: 'fast', label: '较快网络', networkMultiplier: Math.min(document.networkMultiplier, 0.15), retryNetworkMultiplier: Math.min(document.retryNetworkMultiplier, 0.15) },
  ].map((context) => ({ ...context, result: evaluateExport(document, { networkMultiplier: context.networkMultiplier, retryNetworkMultiplier: context.retryNetworkMultiplier }) })));
}

/** RFC 4180 rows; string cells that could be spreadsheet formulas stay literal. */
export function toCsv(value, { bom = false } = {}) {
  const rows = rowsInput(value);
  const cell = (value) => {
    let text = value === undefined ? '' : String(value);
    if (/^[\t\r\n ]*[=+@-]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return (bom ? '\uFEFF' : '') + [['日期', '分类', '事项', '金额'], ...rows.map((row) => [row.date, row.category, row.title, row.amount])]
    .map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
export function serializeDocument(value) { return stableJson(validateDocument(value)); }
export function parseDocument(json) {
  ensure(typeof json === 'string' && utf8Bytes(json).length <= LIMITS.documentBytes, '文档文本无效或过长。', 'INVALID_DOCUMENT');
  let value;
  try { value = JSON.parse(json); } catch { fail('INVALID_DOCUMENT', '文档不是有效 JSON。'); }
  return validateDocument(value);
}
function base64url(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function encodeFragment(value) { return `#doc=${base64url(utf8Bytes(serializeDocument(value)))}`; }
export function decodeFragment(hash) {
  ensure(typeof hash === 'string' && hash.startsWith('#doc=') && hash.length <= Math.ceil(LIMITS.documentBytes / 3) * 4 + 5,
    '分享链接格式无效或过长。', 'INVALID_FRAGMENT');
  const encoded = hash.slice(5);
  ensure(encoded.length > 0 && /^[A-Za-z0-9_-]+$/.test(encoded), '分享链接内容无效。', 'INVALID_FRAGMENT');
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    ensure(bytes.length <= LIMITS.documentBytes && base64url(bytes) === encoded, '分享链接编码无效。', 'INVALID_FRAGMENT');
    return parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof CanvasModelError) throw error;
    fail('INVALID_FRAGMENT', '分享链接无法解码。');
  }
}
