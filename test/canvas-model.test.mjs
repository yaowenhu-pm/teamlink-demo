import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasModelError, LIMITS, createDocument, validateDocument, updateDocument, evaluateExport,
  evaluateContexts, filterRows, toCsv, serializeDocument, parseDocument, encodeFragment, decodeFragment } from '../dist/canvas-model.mjs';

const errorCode = (code) => (error) => error instanceof CanvasModelError && error.code === code;
const ids = (rows) => rows.map((row) => row.id);
const statuses = (result) => Object.fromEntries(result.assertions.map((item) => [item.id, item.status]));
const row = (extra = {}) => ({ id: 'one', date: '2026-10-31', category: '产品', title: '原始事项', amount: 12.5, ...extra });

test('default defects arise from the actual filter/reset/retry computation and a recoverable network', () => {
  const document = createDocument(), result = evaluateExport(document);
  assert.equal(document.data.length, 10);
  assert.deepEqual(ids(result.rows), ['r01', 'r02', 'r03']);
  assert.equal(result.duration, (180 + 3 * 140) * 1.8);
  assert.equal(result.timedOut, true);
  assert.deepEqual(result.initialFilters, { month: '2026-10', category: '产品' });
  assert.deepEqual(result.afterTimeoutFilters, { month: 'all', category: '全部' });
  assert.deepEqual(result.retryFilters, result.afterTimeoutFilters);
  assert.equal(result.retryRows.length, 10);
  assert.equal(result.retryDuration, (180 + 10 * 140) * 0.35);
  assert.equal(result.completed, true); assert.equal(result.terminal, 'retry-success');
  assert.deepEqual(result.outputRows, document.data);
  assert.deepEqual(statuses(result), { 'input-preserved': 'failed', 'request-matches': 'failed', 'file-matches': 'failed' });
  assert.match(result.explanations.initial, /3 × 140/);
  assert.match(result.explanations.retry, /当前可见条件/);
});

test('preserving inputs changes the visible filters, actual retry request and actual file together', () => {
  const original = createDocument(), fixed = updateDocument(original, { rules: { preserveFilters: true } });
  const before = evaluateExport(original), after = evaluateExport(fixed);
  assert.deepEqual(after.afterTimeoutFilters, after.initialFilters);
  assert.deepEqual(after.retryFilters, after.initialFilters);
  assert.deepEqual(ids(after.outputRows), ['r01', 'r02', 'r03']);
  assert.equal(after.retryDuration, (180 + 3 * 140) * 0.35);
  assert.ok(after.retryDuration < before.retryDuration);
  assert.deepEqual(statuses(after), { 'input-preserved': 'passed', 'request-matches': 'passed', 'file-matches': 'passed' });
  assert.equal(original.rules.preserveFilters, false, 'updates never mutate earlier documents');
  assert.equal(fixed.rules.retrySource, 'visible', 'a nested patch retains unrelated rules');
});

test('request source is independent from input preservation and exposes a different partial repair', () => {
  const result = evaluateExport(createDocument({ rules: { retrySource: 'original' } }));
  assert.deepEqual(result.afterTimeoutFilters, { month: 'all', category: '全部' });
  assert.deepEqual(result.retryFilters, result.initialFilters);
  assert.deepEqual(ids(result.retryRows), ['r01', 'r02', 'r03']);
  assert.deepEqual(statuses(result), { 'input-preserved': 'failed', 'request-matches': 'passed', 'file-matches': 'passed' });
  const retry = result.trace.find((step) => step.id === 'retry-request');
  assert.equal(retry.rows.length, 10, 'the visible table still reflects cleared filters');
  assert.equal(retry.requestRows.length, 3, 'the actual retry request uses its explicitly chosen source');
});

test('the timeout budget changes the executed branch and equality finishes within budget', () => {
  const current = createDocument(), initial = evaluateExport(current);
  const enough = evaluateExport(updateDocument(current, { rules: { timeoutMs: 1080 } }));
  assert.equal(initial.terminal, 'retry-success');
  assert.equal(enough.duration, 1080); assert.equal(enough.timedOut, false); assert.equal(enough.retried, false);
  assert.equal(enough.terminal, 'initial-success');
  assert.deepEqual(ids(enough.outputRows), ['r01', 'r02', 'r03']);
  assert.deepEqual(enough.trace.map((step) => step.id), ['before', 'initial-request', 'initial-success']);
  assert.deepEqual(enough.trace.map((step) => step.atMs), [0, 0, 1080]);
});

test('a retry that is still too slow produces no file and cannot pass a file-content assertion', () => {
  const result = evaluateExport(createDocument({ retryNetworkMultiplier: 1.8 }));
  assert.equal(result.timedOut, true); assert.equal(result.retryTimedOut, true); assert.equal(result.completed, false);
  assert.equal(result.retryRows.length, 10); assert.deepEqual(result.outputRows, []);
  assert.equal(result.terminal, 'retry-timeout');
  const file = result.assertions.find((item) => item.id === 'file-matches');
  assert.equal(file.actual, null); assert.equal(file.status, 'not_tested');
  assert.deepEqual(result.trace.at(-1).outputRows, []);
  assert.equal(result.trace.at(-1).atMs, 1600);
  assert.match(result.explanations.file, /没有文件可核对/);
});

test('editing data changes filter membership, latency, actual exported content and its CSV', () => {
  const original = createDocument({ rules: { preserveFilters: true } });
  const changedRows = original.data.map((item) => item.id === 'r03' ? { ...item, category: '研发' } :
    item.id === 'r01' ? { ...item, title: '访客编辑的新内容', amount: 99 } : item);
  const changed = updateDocument(original, { data: changedRows });
  const before = evaluateExport(original), after = evaluateExport(changed);
  assert.equal(before.rows.length, 3); assert.equal(after.rows.length, 2);
  assert.equal(after.duration, (180 + 2 * 140) * 1.8);
  assert.deepEqual(ids(after.outputRows), ['r01', 'r02']);
  assert.equal(after.outputRows[0].title, '访客编辑的新内容'); assert.equal(after.outputRows[0].amount, 99);
  assert.match(toCsv(after.outputRows), /访客编辑的新内容,99/);
  assert.doesNotMatch(toCsv(after.outputRows), /筛选条件体验核对/);
});

test('changing source filters changes the target rows used by all three assertions', () => {
  const document = createDocument({ filters: { month: 'all', category: '研发' }, rules: { preserveFilters: true } });
  const result = evaluateExport(document);
  assert.deepEqual(ids(result.rows), ['r04', 'r05', 'r07', 'r09']);
  assert.deepEqual(result.initialFilters, { month: 'all', category: '研发' });
  assert.deepEqual(result.outputRows, result.rows);
  assert.ok(result.assertions.every((item) => item.status === 'passed'));
  assert.deepEqual(filterRows(document.data, document.filters), result.rows);
});

test('visitor-created months and categories drive exact rows, files and explanations', () => {
  const document = createDocument({ data: [
    row({ id: 'new-1', date: '2027-02-04', category: '设计研究', title: '新月份的新分类记录' }),
    row({ id: 'new-2', date: '2027-02-12', category: '运营', title: '同月其他分类' }),
    row({ id: 'new-3', date: '2026-11-18', category: '设计研究', title: '同分类其他月份' }),
  ], filters: { month: '2027-02', category: '设计研究' }, rules: { timeoutMs: 400, preserveFilters: true } });
  const result = evaluateExport(document);
  assert.deepEqual(ids(result.rows), ['new-1']);
  assert.deepEqual(ids(result.retryRows), ['new-1']);
  assert.deepEqual(ids(result.outputRows), ['new-1']);
  assert.match(result.explanations.initial, /2027 年 2 月 \/ 设计研究/);
  assert.match(result.explanations.retry, /2027 年 2 月 \/ 设计研究/);
  assert.doesNotMatch(result.explanations.initial, /2026 年 10 月/);
  assert.match(toCsv(result.outputRows), /2027-02-04,设计研究,新月份的新分类记录/);
  assert.deepEqual(ids(evaluateExport(updateDocument(document, { filters: { month: 'all' } })).rows), ['new-1', 'new-3']);
  assert.deepEqual(ids(evaluateExport(updateDocument(document, { filters: { category: '运营' } })).rows), ['new-2']);
  assert.deepEqual(decodeFragment(encodeFragment(document)), document);
});

test('content editing is literal and does not silently infer or alter behavior rules', () => {
  const original = createDocument(), changed = updateDocument(original, { content: {
    title: '', subtitle: '保留筛选条件，但这里只是我写的文字。', errorMessage: '<script>globalThis.secret = 1</script>',
  } });
  assert.equal(changed.content.title, '');
  assert.deepEqual(changed.rules, original.rules);
  const result = evaluateExport(changed);
  assert.equal(result.assertions[0].actual, false);
  assert.equal(result.trace.find((step) => step.id === 'initial-timeout').message, changed.content.errorMessage);
  assert.equal(globalThis.secret, undefined, 'the engine treats markup as text and never executes it');
});

test('expectations are editable assumptions, compared independently against computed reality', () => {
  const actual = evaluateExport(createDocument());
  const revised = evaluateExport(createDocument({ expectations: { preserveFilters: false, retryMatchesOriginal: false, fileMatchesOriginal: false } }));
  assert.deepEqual(revised.outputRows, actual.outputRows);
  assert.ok(revised.assertions.every((item) => item.actual === false && item.expected === false && item.status === 'passed'));
  const without = structuredClone(createDocument()); delete without.expectations;
  assert.deepEqual(validateDocument(without).expectations, { preserveFilters: true, retryMatchesOriginal: true, fileMatchesOriginal: true });
});

test('current, slower and faster contexts all derive their results from the same engine', () => {
  const document = createDocument(), contexts = evaluateContexts(document);
  assert.deepEqual(contexts.map((item) => item.id), ['current', 'slow', 'fast']);
  for (const context of contexts) assert.deepEqual(context.result, evaluateExport(document, {
    networkMultiplier: context.networkMultiplier, retryNetworkMultiplier: context.retryNetworkMultiplier,
  }));
  assert.equal(contexts[0].result.terminal, 'retry-success');
  assert.equal(contexts[1].result.terminal, 'retry-timeout');
  assert.equal(contexts[2].result.terminal, 'initial-success');
});

test('the full trace exposes changing visible state, request parameters and final actual file', () => {
  const result = evaluateExport(createDocument());
  assert.deepEqual(result.trace.map((step) => step.id), ['before', 'initial-request', 'initial-timeout', 'retry-request', 'retry-success']);
  assert.deepEqual(result.trace.map((step) => step.atMs), [0, 0, 800, 800, 1353]);
  assert.deepEqual(result.trace[0].filters, result.initialFilters);
  assert.deepEqual(result.trace[2].filters, result.afterTimeoutFilters);
  assert.deepEqual(result.trace[3].requestFilters, result.retryFilters);
  assert.deepEqual(result.trace.at(-1).outputRows, result.outputRows);
  assert.ok(result.trace.every((step, index, trace) => !index || step.atMs >= trace[index - 1].atMs));
});

test('CSV has exact RFC 4180 escaping, stable columns and literal spreadsheet-formula text', () => {
  const rows = [row({ title: '包含,逗号和"引号"\n第二行' }), row({ id: 'two', date: '2026-09-01', category: '研发', title: '=1+1', amount: undefined })];
  const expected = '日期,分类,事项,金额\r\n2026-10-31,产品,"包含,逗号和""引号""\n第二行",12.5\r\n2026-09-01,研发,\'=1+1,\r\n';
  assert.equal(toCsv(rows), expected);
  assert.equal(toCsv(rows, { bom: true }), '\uFEFF' + expected);
  assert.equal(toCsv([]), '日期,分类,事项,金额\r\n');
});

test('Unicode JSON and URL-fragment roundtrips preserve the exact editable document', () => {
  const document = createDocument({ content: { title: '一起试试 👩🏽‍💻 / 方案 A & B', subtitle: '空格\n换行\t也保留' },
    data: [row({ title: '中文、emoji 🧪 与 <b>字面文本</b>' })] });
  assert.deepEqual(parseDocument(serializeDocument(document)), document);
  const fragment = encodeFragment(document);
  assert.match(fragment, /^#doc=[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeFragment(fragment), document);
  assert.equal(encodeFragment(decodeFragment(fragment)), fragment);
  assert.deepEqual(evaluateExport(decodeFragment(fragment)), evaluateExport(document));
});

test('hostile shapes, invalid bounds and oversized shares are rejected with controlled errors', () => {
  const original = createDocument();
  const invalid = [
    (doc) => { doc.schemaVersion = 2; }, (doc) => { doc.token = 'private-value'; },
    (doc) => { doc.rules.retrySource = 'arbitrary-code'; }, (doc) => { doc.rules.timeoutMs = -1; },
    (doc) => { doc.networkMultiplier = Infinity; }, (doc) => { doc.retryNetworkMultiplier = '0.3'; },
    (doc) => { doc.data = [row({ date: '2026-02-30' })]; }, (doc) => { doc.data = [row(), row()]; },
    (doc) => { doc.data = [row({ category: '全部' })]; }, (doc) => { doc.data = [row({ amount: NaN })]; },
    (doc) => { doc.filters.month = '2026-13'; }, (doc) => { doc.expectations.preserveFilters = null; },
    (doc) => { doc.filters.category = ' '; }, (doc) => { doc.data = [row({ category: '字'.repeat(41) })]; },
    (doc) => { doc.content.title = '字'.repeat(LIMITS.title + 1); },
  ];
  for (const mutate of invalid) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => validateDocument(value), errorCode('INVALID_DOCUMENT'));
  }
  assert.throws(() => validateDocument(JSON.parse('{"__proto__":{"polluted":true}}')), errorCode('INVALID_DOCUMENT'));
  assert.equal({}.polluted, undefined);
  const huge = { ...structuredClone(original), data: Array.from({ length: 80 }, (_, index) => row({ id: `x${index}`, title: '文'.repeat(160) })) };
  assert.throws(() => validateDocument(huge), errorCode('DOCUMENT_TOO_LARGE'));
  for (const fragment of ['', '#wrong=abc', '#doc=!', '#doc=A', '#doc=' + 'A'.repeat(25000)]) {
    assert.throws(() => decodeFragment(fragment), (error) => error instanceof CanvasModelError);
  }
  const malicious = '#doc=' + btoa('{"schemaVersion":1,"content":{"constructor":{"prototype":{"polluted":true}}}}').replace(/=+$/, '');
  assert.throws(() => decodeFragment(malicious), errorCode('INVALID_DOCUMENT'));
  assert.throws(() => updateDocument(original, { schemaVersion: 2 }), errorCode('INVALID_DOCUMENT'));
  assert.throws(() => evaluateExport(original, { url: 'https://private.example' }), errorCode('INVALID_DOCUMENT'));
});

test('an empty selected dataset can complete a real empty CSV and stays distinct from timeout/no-file', () => {
  const result = evaluateExport(createDocument({ data: [], networkMultiplier: 1, rules: { timeoutMs: 800 } }));
  assert.equal(result.completed, true); assert.deepEqual(result.outputRows, []);
  assert.equal(result.assertions.find((item) => item.id === 'file-matches').actual, true);
  assert.equal(toCsv(result.outputRows), '日期,分类,事项,金额\r\n');
});
