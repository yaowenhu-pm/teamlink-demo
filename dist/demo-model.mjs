/** Deterministic, local-only sample state. No API, model or code execution occurs here. */
export class DemoError extends Error {
  constructor(code, message) { super(message); this.name = 'DemoError'; this.code = code; }
}
const fail = (code, message) => { throw new DemoError(code, message); };
const ensure = (condition, code, message) => { if (!condition) fail(code, message); };
const plain = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const copy = (value) => structuredClone(value);
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const canonical = (value) => {
  const normalize = (item) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (plain(item)) return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    fail('INVALID_SNAPSHOT', '演示存档包含不支持的数据。');
  };
  return JSON.stringify(normalize(value));
};
const wording = (value, label, max = 2000, min = 1) => {
  ensure(typeof value === 'string' && value.trim().length >= min && value.trim().length <= max,
    'INVALID_DRAFT', `${label}需填写 ${min} 至 ${max} 个字符。`);
  return value.trim();
};

export const scenarios = freeze([
  { id: 'export-retry', title: '导出失败后，保留输入并允许重试',
    description: '小林和小周一起处理一条虚构的 Excel 导出需求。',
    requirements: '用户导出 Excel 遇到超时时，要看懂失败原因，保留已经填写的筛选条件，并能直接重试。成功后应拿到所选数据的文件。',
    criteria: [
      { id: 'AC1', description: '导出超时时，显示明确原因和“重试”入口', verification: '在示例超时状态中核对原因文案和重试按钮', required: true },
      { id: 'AC2', description: '失败后保留已填写的筛选条件', verification: '对比示例导出前后的日期和分类筛选值', required: true },
      { id: 'AC3', description: '再次导出成功后，文件包含所选数据', verification: '核对示例成功提示与示例文件中的筛选范围', required: true },
    ] },
  { id: 'login-return', title: '登录后，回到刚才想访问的页面',
    description: '小林和小周一起处理一条虚构的登录返回需求。',
    requirements: '未登录用户从活动详情进入报名时，先完成登录，再回到原活动的报名页。取消或登录失败时，应说明下一步，并保留原活动。',
    criteria: [
      { id: 'AC1', description: '登录成功后回到原活动的报名页', verification: '从示例活动进入登录，核对成功后的活动和页面', required: true },
      { id: 'AC2', description: '登录失败时提示原因，并允许再次登录', verification: '打开示例失败状态，核对原因提示和再次登录入口', required: true },
      { id: 'AC3', description: '取消登录后保留原活动，不跳到无关首页', verification: '在示例中取消登录，核对返回位置和活动信息', required: true },
    ] },
]);

const labels = freeze({
  mode: '公开演示 · 全部为虚构样例',
  artifact: '示例 PR / 示例文件，未连接真实仓库或飞书',
  checks: '演示检查结果，未实际执行代码',
  teammates: '小林与小周为虚构成员；这里不代表真人接单或验收',
});
export const actors = freeze({ requester: { name: '小林', role: '产品' }, owner: { name: '小周', role: '研发' } });
const scenarioFor = (id) => {
  const scenario = scenarios.find((item) => item.id === id);
  ensure(scenario, 'INVALID_SCENARIO', '请选择一个演示场景。');
  return scenario;
};
function base(scenarioId) {
  const scenario = scenarioFor(scenarioId);
  return {
    schemaVersion: 1, scenarioId, simulated: true, labels: copy(labels), actors: copy(actors), status: 'draft',
    draft: { title: scenario.title, requirements: scenario.requirements, criteria: copy(scenario.criteria), basedOnRevisionId: null },
    currentRevision: null, currentRevisionId: null, revisions: [], ownerAckRevisionId: null,
    evidence: null, evidenceHistory: [], currentSubmission: null, currentSubmissionId: null,
    submissions: [], acceptance: null, decisions: [],
    sequence: { revision: 0, head: 0, evidence: 0, submission: 0, decision: 0 }, events: [],
  };
}
export function createDemo(scenarioId = 'export-retry') { return freeze(base(scenarioId)); }

const fields = {
  EDIT_DRAFT: ['title', 'requirements', 'criteria'], CONFIRM: [], CLAIM: ['expectedRevisionId'],
  CHECK: ['expectedRevisionId', 'fixture', 'newHead'],
  SUBMIT: ['expectedRevisionId', 'expectedHeadSha', 'summary', 'testEntry', 'criterionEvidence'],
  RETURN: ['expectedRevisionId', 'expectedHeadSha', 'submissionId', 'failedCriteria'],
  ACCEPT: ['expectedRevisionId', 'expectedHeadSha', 'submissionId', 'criterionResults'],
  REVISE: ['expectedRevisionId', 'title', 'requirements', 'criteria'], RESET: ['scenarioId'],
};
const normalRole = { EDIT_DRAFT: 'requester', CONFIRM: 'requester', CLAIM: 'owner', CHECK: 'owner',
  SUBMIT: 'owner', RETURN: 'requester', ACCEPT: 'requester', REVISE: 'requester' };
function actionInput(input) {
  ensure(plain(input) && typeof input.type === 'string' && Object.hasOwn(fields, input.type), 'INVALID_ACTION', '未知演示操作。');
  ensure(Object.keys(input).every((key) => ['type', 'role', ...fields[input.type]].includes(key)), 'INVALID_ACTION', '操作包含不支持的字段。');
  const value = JSON.parse(canonical(input));
  if (value.type !== 'RESET') {
    value.role ??= normalRole[value.type];
    ensure(value.role === normalRole[value.type], 'FORBIDDEN', `此操作应由${actors[normalRole[value.type]].name}（${actors[normalRole[value.type]].role}）完成。`);
  }
  return value;
}
function criteriaInput(criteria) {
  ensure(Array.isArray(criteria) && criteria.length > 0 && criteria.length <= 8, 'INVALID_DRAFT', '请填写 1 至 8 个验收项。');
  const seen = new Set();
  return criteria.map((item) => {
    ensure(plain(item) && typeof item.id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(item.id) && !seen.has(item.id), 'INVALID_DRAFT', '验收项需要不重复的稳定编号。');
    ensure(typeof item.required === 'boolean', 'INVALID_DRAFT', '请明确验收项是否必需。');
    seen.add(item.id);
    return { id: item.id, description: wording(item.description, '验收条件', 300), verification: wording(item.verification, '核对方法', 300), required: item.required };
  });
}
function editDraft(draft, action) {
  return { ...draft,
    title: wording(action.title ?? draft.title, '需求标题', 80),
    requirements: wording(action.requirements ?? draft.requirements, '需求内容', 4000),
    criteria: criteriaInput(action.criteria ?? draft.criteria),
  };
}
function currentVersion(state, action) {
  ensure(state.currentRevisionId && action.expectedRevisionId === state.currentRevisionId, 'REVISION_CONFLICT', '共享需求版本已变化，请先查看当前版本。');
}
function claimed(state) {
  ensure(state.ownerAckRevisionId === state.currentRevisionId && state.currentRevisionId, 'OWNER_ACK_REQUIRED', '请先由小周接下当前版本。');
}
function resultsInput(value, criteria, { failedOnly = false } = {}) {
  ensure(Array.isArray(value), 'INVALID_CRITERION_RESULTS', '请逐项填写实际核对结果。');
  const known = new Set(criteria.map((criterion) => criterion.id)), seen = new Set();
  const result = value.map((item) => {
    ensure(plain(item) && known.has(item.criterionId) && !seen.has(item.criterionId), 'INVALID_CRITERION_RESULTS', '核对结果需要对应当前验收项，且不能重复。');
    ensure((failedOnly ? ['failed', 'not_tested'] : ['passed', 'failed', 'not_tested']).includes(item.result), 'INVALID_CRITERION_RESULTS', '请选择通过、未通过或未核对。');
    ensure(item.note === undefined || (typeof item.note === 'string' && item.note.length <= 500), 'INVALID_CRITERION_RESULTS', '核对说明应为 500 字以内的文字。');
    if (failedOnly) ensure(typeof item.note === 'string' && item.note.trim().length >= 4, 'INVALID_CRITERION_RESULTS', '退回时请指出具体失败项，并填写至少 4 个字的原因。');
    seen.add(item.criterionId);
    return { criterionId: item.criterionId, result: item.result, ...(item.note === undefined ? {} : { note: item.note.trim() }) };
  });
  ensure(failedOnly ? result.length > 0 : criteria.every((criterion) => !criterion.required || seen.has(criterion.id)),
    'INVALID_CRITERION_RESULTS', failedOnly ? '至少选择一个具体失败或未核对的验收项。' : '每个必需验收项都要明确填写结果。');
  return result;
}
const artifactMatches = (a, b) => a && b && a.revisionId === b.revisionId && a.headSha === b.headSha;
function currentDelivery(state, action) {
  currentVersion(state, action);
  ensure(state.currentSubmission && action.submissionId === state.currentSubmissionId, 'SUBMISSION_CONFLICT', '交付已变化，请查看当前交付。');
  ensure(state.evidence && action.expectedHeadSha === state.evidence.headSha, 'HEAD_CONFLICT', '示例提交版本已变化，请重新核对。');
  ensure(artifactMatches(state.currentSubmission, state.evidence), 'SUBMISSION_CONFLICT', '这次交付与当前示例提交不一致。');
}
function apply(state, action) {
  const next = copy(state);
  switch (action.type) {
    case 'EDIT_DRAFT':
      ensure(next.draft, 'NO_DRAFT', '已确认的版本不能直接修改，请先发起需求变更。');
      next.draft = editDraft(next.draft, action);
      break;
    case 'CONFIRM': {
      ensure(next.draft, 'NO_DRAFT', '没有待确认的需求草稿。');
      ensure(next.draft.basedOnRevisionId === next.currentRevisionId, 'REVISION_CONFLICT', '草稿不是基于当前版本，请重新整理变更。');
      const draft = editDraft(next.draft, {}), number = ++next.sequence.revision;
      const revision = { id: `revision-${number}`, number, title: draft.title, requirements: draft.requirements, criteria: draft.criteria, confirmedBy: '小林', simulated: true };
      next.revisions.push(revision); next.currentRevision = revision; next.currentRevisionId = revision.id;
      next.draft = null; next.ownerAckRevisionId = null; next.evidence = null;
      next.currentSubmission = null; next.currentSubmissionId = null; next.acceptance = null; next.status = 'ready';
      break;
    }
    case 'CLAIM':
      currentVersion(next, action);
      ensure(['ready', 'in_progress'].includes(next.status), 'INVALID_TASK_STATE', '当前状态无需再次接单。');
      next.ownerAckRevisionId = next.currentRevisionId; next.status = 'in_progress';
      break;
    case 'CHECK': {
      currentVersion(next, action); claimed(next);
      ensure(['passed', 'failed', 'pending'].includes(action.fixture), 'INVALID_ACTION', '请选择一个明确的演示检查样例。');
      ensure(action.newHead === undefined || typeof action.newHead === 'boolean', 'INVALID_ACTION', '示例版本变化需要明确的布尔值。');
      if (!next.sequence.head || action.newHead) next.sequence.head++;
      const evidence = { id: `evidence-${++next.sequence.evidence}`, revisionId: next.currentRevisionId,
        headSha: `sample-${next.scenarioId}-${String(next.sequence.head).padStart(3, '0')}`,
        fixture: action.fixture, ready: action.fixture === 'passed', simulated: true,
        artifactLabel: '示例 PR #7 · 不存在真实仓库写入', checksLabel: labels.checks,
        checks: [{ name: '示例自动检查', result: action.fixture, simulated: true }] };
      next.evidence = evidence; next.evidenceHistory.push(evidence);
      if (!evidence.ready || !artifactMatches(next.currentSubmission, evidence)) {
        next.currentSubmission = null; next.currentSubmissionId = null; next.acceptance = null; next.status = 'in_progress';
      }
      break;
    }
    case 'SUBMIT': {
      currentVersion(next, action); claimed(next);
      ensure(['in_progress', 'awaiting_acceptance'].includes(next.status), 'INVALID_TASK_STATE', '当前状态不能提交交付。');
      ensure(next.evidence?.ready && next.evidence.revisionId === next.currentRevisionId, 'EVIDENCE_NOT_READY', '先查看通过的演示检查样例；失败或等待中不能交付。');
      ensure(action.expectedHeadSha === next.evidence.headSha, 'HEAD_CONFLICT', '请提交刚核对的示例版本。');
      const evidence = resultsInput(action.criterionEvidence, next.currentRevision.criteria);
      const submission = { id: `submission-${++next.sequence.submission}`, revisionId: next.currentRevisionId, evidenceId: next.evidence.id,
        headSha: next.evidence.headSha, criterionEvidence: evidence,
        summary: wording(action.summary ?? '示例交付：按当前需求版本整理修改。', '交付说明', 1000),
        testEntry: wording(action.testEntry ?? '演示复现：按验收项核对示例；这里未执行真实代码。', '体验或复现方法', 1000),
        submittedBy: '小周', simulated: true, artifactLabel: labels.artifact };
      next.submissions.push(submission); next.currentSubmission = submission; next.currentSubmissionId = submission.id;
      next.acceptance = null; next.status = 'awaiting_acceptance';
      break;
    }
    case 'RETURN': {
      currentDelivery(next, action);
      ensure(['awaiting_acceptance', 'accepted'].includes(next.status), 'INVALID_TASK_STATE', '当前没有可退回的交付。');
      const criterionResults = resultsInput(action.failedCriteria, next.currentRevision.criteria, { failedOnly: true });
      next.decisions.push({ id: `decision-${++next.sequence.decision}`, verdict: 'returned', revisionId: next.currentRevisionId,
        submissionId: next.currentSubmissionId, headSha: next.evidence.headSha, criterionResults, decidedBy: '小林', simulated: true });
      next.currentSubmission = null; next.currentSubmissionId = null; next.acceptance = null; next.status = 'in_progress';
      break;
    }
    case 'ACCEPT': {
      currentDelivery(next, action);
      ensure(next.evidence.ready, 'EVIDENCE_NOT_READY', '演示检查尚未通过。');
      const criterionResults = resultsInput(action.criterionResults, next.currentRevision.criteria);
      ensure(next.currentRevision.criteria.every((criterion) => !criterion.required ||
        (criterionResults.find((item) => item.criterionId === criterion.id)?.result === 'passed' &&
         next.currentSubmission.criterionEvidence.find((item) => item.criterionId === criterion.id)?.result === 'passed')),
      'CRITERIA_NOT_PASSED', '所有必需项都要在交付和验收中明确核对通过。');
      if (next.status === 'accepted') return state;
      ensure(next.status === 'awaiting_acceptance', 'INVALID_TASK_STATE', '当前没有待验收的交付。');
      const decision = { id: `decision-${++next.sequence.decision}`, verdict: 'accepted', revisionId: next.currentRevisionId,
        submissionId: next.currentSubmissionId, headSha: next.evidence.headSha, criterionResults, decidedBy: '小林', simulated: true };
      next.decisions.push(decision); next.acceptance = decision; next.status = 'accepted';
      break;
    }
    case 'REVISE':
      currentVersion(next, action);
      next.draft = editDraft({ title: next.currentRevision.title, requirements: next.currentRevision.requirements,
        criteria: copy(next.currentRevision.criteria), basedOnRevisionId: next.currentRevisionId }, action);
      break;
    default: fail('INVALID_ACTION', '未知演示操作。');
  }
  next.events.push(copy(action));
  return next;
}

/** Replay a version-1 snapshot rather than trusting serialized status/approval fields. */
export function validateSnapshot(value) {
  try {
    const snapshot = typeof value === 'string' ? JSON.parse(value) : value;
    ensure(plain(snapshot) && snapshot.schemaVersion === 1 && Array.isArray(snapshot.events) && snapshot.events.length <= 1000,
      'INVALID_SNAPSHOT', '演示存档版本不兼容或内容损坏。');
    let restored = base(snapshot.scenarioId);
    for (const event of snapshot.events) {
      const action = actionInput(event);
      ensure(action.type !== 'RESET', 'INVALID_SNAPSHOT', '重置操作不应出现在演示存档中。');
      restored = apply(restored, action);
    }
    ensure(canonical(restored) === canonical(snapshot), 'INVALID_SNAPSHOT', '演示存档与操作记录不一致。');
    return freeze(restored);
  } catch {
    fail('INVALID_SNAPSHOT', '演示存档无法恢复，请重置此演示；不会影响任何真实项目。');
  }
}

export function reduceDemo(state, input) {
  const action = actionInput(input);
  if (action.type === 'RESET') return createDemo(action.scenarioId ?? state?.scenarioId ?? 'export-retry');
  const current = validateSnapshot(state);
  return freeze(apply(current, action));
}
