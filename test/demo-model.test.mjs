import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo, reduceDemo, validateSnapshot, scenarios, actors, DemoError } from '../dist/demo-model.mjs';

const code = (expected) => (error) => error instanceof DemoError && error.code === expected;
const results = (state, result = 'passed') => state.currentRevision.criteria.map((criterion) => ({ criterionId: criterion.id, result }));
const version = (state) => ({ expectedRevisionId: state.currentRevisionId });
const checked = (scenarioId) => {
  let state = reduceDemo(createDemo(scenarioId), { type: 'CONFIRM' });
  state = reduceDemo(state, { type: 'CLAIM', ...version(state) });
  return reduceDemo(state, { type: 'CHECK', ...version(state), fixture: 'passed' });
};
const submit = (state, extra = {}) => reduceDemo(state, { type: 'SUBMIT', ...version(state), expectedHeadSha: state.evidence.headSha,
  summary: '示例交付：已按本轮要求整理修改。', testEntry: '按列出的核对方法查看示例；没有执行真实代码。', criterionEvidence: results(state), ...extra });
const review = (state) => ({ ...version(state), expectedHeadSha: state.evidence.headSha, submissionId: state.currentSubmissionId });
const accept = (state, extra = {}) => reduceDemo(state, { type: 'ACCEPT', ...review(state), criterionResults: results(state), ...extra });

for (const scenario of scenarios) test(`${scenario.id}: editable draft → claim → sample checks → delivery → concrete return → resubmit → acceptance`, () => {
  let state = createDemo(scenario.id);
  assert.equal(state.status, 'draft'); assert.equal(state.draft.criteria.length, 3);
  const custom = `${state.draft.requirements}\n补充：只处理当前示例中的路径。`;
  state = reduceDemo(state, { type: 'EDIT_DRAFT', requirements: custom });
  state = reduceDemo(state, { type: 'CONFIRM', role: 'requester' });
  assert.equal(state.currentRevision.requirements, custom);
  assert.equal(state.status, 'ready'); assert.equal(state.draft, null);
  const firstRevision = state.currentRevision;
  state = reduceDemo(state, { type: 'CLAIM', role: 'owner', ...version(state) });
  assert.equal(state.ownerAckRevisionId, firstRevision.id);
  state = reduceDemo(state, { type: 'CHECK', ...version(state), fixture: 'pending' });
  assert.equal(state.status, 'in_progress'); assert.equal(state.currentSubmission, null);
  assert.throws(() => submit(state), code('EVIDENCE_NOT_READY'));
  state = reduceDemo(state, { type: 'CHECK', ...version(state), fixture: 'passed' });
  assert.equal(state.status, 'in_progress', 'showing a green sample check does not submit work');
  state = submit(state);
  assert.equal(state.status, 'awaiting_acceptance'); assert.equal(state.submissions.length, 1);
  const firstSubmission = state.currentSubmission;
  state = reduceDemo(state, { type: 'RETURN', role: 'requester', ...review(state),
    failedCriteria: [{ criterionId: 'AC2', result: 'failed', note: '示例失败路径仍未保留原来的输入。' }] });
  assert.equal(state.status, 'in_progress'); assert.equal(state.currentSubmission, null);
  assert.equal(state.decisions[0].criterionResults[0].criterionId, 'AC2');
  assert.equal(state.decisions[0].submissionId, firstSubmission.id);
  state = reduceDemo(state, { type: 'CHECK', ...version(state), fixture: 'passed', newHead: true });
  assert.notEqual(state.evidence.headSha, firstSubmission.headSha);
  assert.throws(() => submit(state, { expectedHeadSha: firstSubmission.headSha }), code('HEAD_CONFLICT'));
  state = submit(state);
  assert.equal(state.submissions.length, 2); assert.notEqual(state.currentSubmissionId, firstSubmission.id);
  assert.throws(() => accept(state, { submissionId: firstSubmission.id }), code('SUBMISSION_CONFLICT'));
  state = accept(state);
  assert.equal(state.status, 'accepted'); assert.equal(state.acceptance.submissionId, state.currentSubmissionId);
  assert.equal(state.decisions.length, 2); assert.equal(state.submissions[0].id, firstSubmission.id);
  assert.deepEqual(state.revisions[0], firstRevision);
  assert.deepEqual(validateSnapshot(JSON.stringify(state)), state);
});

test('confirmed requirements and past deliveries are immutable; confirmed changes invalidate current acknowledgment and approval', () => {
  let state = accept(submit(checked()));
  const old = state, oldRevision = state.currentRevisionId, oldHead = state.evidence.headSha;
  assert.throws(() => { state.currentRevision.requirements = '静默篡改'; }, TypeError);
  assert.throws(() => { state.submissions[0].summary = '静默篡改'; }, TypeError);
  assert.throws(() => reduceDemo(state, { type: 'EDIT_DRAFT', requirements: '直接覆盖已确认需求' }), code('NO_DRAFT'));
  state = reduceDemo(state, { type: 'REVISE', ...version(state), requirements: '新版本：失败时保留输入，并给出重试方法。' });
  assert.equal(state.status, 'accepted', 'a proposed change does not silently rewrite the agreement');
  assert.equal(state.currentRevisionId, oldRevision); assert.deepEqual(state.acceptance, old.acceptance);
  state = reduceDemo(state, { type: 'CONFIRM' });
  assert.equal(state.status, 'ready'); assert.notEqual(state.currentRevisionId, oldRevision);
  assert.equal(state.ownerAckRevisionId, null); assert.equal(state.evidence, null);
  assert.equal(state.currentSubmission, null); assert.equal(state.acceptance, null);
  assert.equal(state.revisions.length, 2); assert.equal(state.submissions.length, 1); assert.equal(state.decisions.length, 1);
  assert.throws(() => reduceDemo(state, { type: 'CLAIM', expectedRevisionId: oldRevision }), code('REVISION_CONFLICT'));
  assert.throws(() => reduceDemo(state, { type: 'ACCEPT', expectedRevisionId: oldRevision, expectedHeadSha: oldHead,
    submissionId: old.currentSubmissionId, criterionResults: results(state) }), code('REVISION_CONFLICT'));
  assert.throws(() => reduceDemo(state, { type: 'CHECK', ...version(state), fixture: 'passed' }), code('OWNER_ACK_REQUIRED'));
  assert.equal(old.status, 'accepted', 'the reducer does not mutate previous snapshots');
});

test('head and check changes invalidate current delivery/acceptance without erasing history', () => {
  let state = accept(submit(checked()));
  const original = state;
  state = reduceDemo(state, { type: 'CHECK', ...version(state), fixture: 'passed' });
  assert.equal(state.status, 'accepted'); assert.equal(state.currentSubmissionId, original.currentSubmissionId);
  state = reduceDemo(state, { type: 'CHECK', ...version(state), fixture: 'passed', newHead: true });
  assert.equal(state.status, 'in_progress'); assert.equal(state.currentSubmission, null); assert.equal(state.acceptance, null);
  assert.equal(state.decisions.length, 1); assert.equal(state.submissions.length, 1);
  assert.throws(() => accept(state, { submissionId: original.currentSubmissionId }), code('SUBMISSION_CONFLICT'));
  state = submit(state);
  state = reduceDemo(state, { type: 'CHECK', ...version(state), fixture: 'failed' });
  assert.equal(state.status, 'in_progress'); assert.equal(state.currentSubmission, null);
  assert.throws(() => submit(state), code('EVIDENCE_NOT_READY'));
  assert.equal(state.submissions.length, 2);
});

test('business criteria require explicit results, with concrete failed items on return', () => {
  let state = checked();
  assert.throws(() => submit(state, { criterionEvidence: [] }), code('INVALID_CRITERION_RESULTS'));
  assert.throws(() => submit(state, { criterionEvidence: [{ criterionId: 'unknown', result: 'passed' }] }), code('INVALID_CRITERION_RESULTS'));
  state = submit(state, { criterionEvidence: results(state, 'not_tested') });
  assert.throws(() => accept(state), code('CRITERIA_NOT_PASSED'));
  assert.throws(() => reduceDemo(state, { type: 'RETURN', ...review(state), failedCriteria: [] }), code('INVALID_CRITERION_RESULTS'));
  assert.throws(() => reduceDemo(state, { type: 'RETURN', ...review(state), failedCriteria: [{ criterionId: 'AC1', result: 'failed', note: '失败' }] }), code('INVALID_CRITERION_RESULTS'));
  assert.throws(() => reduceDemo(state, { type: 'RETURN', ...review(state), failedCriteria: [{ criterionId: 'unknown', result: 'failed', note: '这一项仍未达到要求' }] }), code('INVALID_CRITERION_RESULTS'));
  state = reduceDemo(state, { type: 'RETURN', ...review(state), failedCriteria: [{ criterionId: 'AC1', result: 'not_tested', note: '尚未核对超时失败的示例路径' }] });
  state = submit(state);
  assert.throws(() => accept(state, { criterionResults: [] }), code('INVALID_CRITERION_RESULTS'));
  assert.throws(() => accept(state, { criterionResults: results(state, 'not_tested') }), code('CRITERIA_NOT_PASSED'));
  assert.equal(accept(state).status, 'accepted');
});

test('explicit roles cannot claim or review for the other teammate', () => {
  let state = createDemo();
  assert.deepEqual(actors, { requester: { name: '小林', role: '产品' }, owner: { name: '小周', role: '研发' } });
  assert.throws(() => reduceDemo(state, { type: 'CONFIRM', role: 'owner' }), code('FORBIDDEN'));
  state = reduceDemo(state, { type: 'CONFIRM' });
  assert.throws(() => reduceDemo(state, { type: 'CLAIM', role: 'requester', ...version(state) }), code('FORBIDDEN'));
  assert.throws(() => reduceDemo(state, { type: 'CLAIM', actorId: '小周', ...version(state) }), code('INVALID_ACTION'));
  state = checked();
  assert.throws(() => submit(state, { role: 'requester' }), code('FORBIDDEN'));
  state = submit(state);
  assert.throws(() => accept(state, { role: 'owner' }), code('FORBIDDEN'));
  assert.throws(() => reduceDemo(state, { type: 'RETURN', role: 'owner', ...review(state),
    failedCriteria: [{ criterionId: 'AC1', result: 'failed', note: '失败提示没有给出重试入口' }] }), code('FORBIDDEN'));
});

test('draft validation accepts custom text but rejects blank, oversized or invalid criterion input', () => {
  let state = createDemo();
  assert.throws(() => reduceDemo(state, { type: 'EDIT_DRAFT', requirements: '  ' }), code('INVALID_DRAFT'));
  assert.throws(() => reduceDemo(state, { type: 'EDIT_DRAFT', title: '字'.repeat(81) }), code('INVALID_DRAFT'));
  assert.throws(() => reduceDemo(state, { type: 'EDIT_DRAFT', criteria: [] }), code('INVALID_DRAFT'));
  assert.throws(() => reduceDemo(state, { type: 'EDIT_DRAFT', criteria: [state.draft.criteria[0], state.draft.criteria[0]] }), code('INVALID_DRAFT'));
  state = reduceDemo(state, { type: 'EDIT_DRAFT', title: '  我的示例需求  ', requirements: '  这是用户自行输入的虚构需求内容。  ' });
  assert.equal(state.draft.title, '我的示例需求'); assert.equal(state.draft.requirements, '这是用户自行输入的虚构需求内容。');
  assert.equal(state.currentRevision, null);
});

test('version-1 recovery replays valid snapshots and rejects forged or stale serialized approval', () => {
  const state = accept(submit(checked('login-return')));
  assert.deepEqual(validateSnapshot(copy(state)), state);
  for (const tamper of [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.status = 'in_progress'; },
    (value) => { value.currentRevision.requirements = '改写已确认版本'; },
    (value) => { value.acceptance.headSha = 'forged-head'; },
    (value) => { value.events = []; },
    (value) => { value.actorId = 'real-private-member'; },
  ]) {
    const forged = copy(state); tamper(forged);
    assert.throws(() => validateSnapshot(JSON.stringify(forged)), code('INVALID_SNAPSHOT'));
  }
  for (const malformed of ['{broken json', null, [], undefined]) assert.throws(() => validateSnapshot(malformed), code('INVALID_SNAPSHOT'));
  assert.deepEqual(reduceDemo(state, { type: 'RESET' }), createDemo('login-return'));
  assert.deepEqual(reduceDemo(null, { type: 'RESET', scenarioId: 'export-retry' }), createDemo());
});

test('all generated artifacts disclose sample data and transitions are deterministic', () => {
  const first = accept(submit(checked())), second = accept(submit(checked()));
  assert.deepEqual(first, second);
  assert.equal(first.simulated, true);
  assert.match(first.labels.mode, /虚构样例/); assert.match(first.labels.checks, /未实际执行代码/);
  assert.match(first.evidence.headSha, /^sample-/);
  assert.equal(first.evidence.simulated, true); assert.equal(first.currentSubmission.simulated, true);
  assert.match(first.currentSubmission.artifactLabel, /未连接真实仓库或飞书/);
  assert.match(first.currentSubmission.testEntry, /没有执行真实代码/);
  assert.throws(() => createDemo('private-project'), code('INVALID_SCENARIO'));
  assert.throws(() => reduceDemo(first, { type: 'CALL_EXTERNAL_API' }), code('INVALID_ACTION'));
});

function copy(value) { return structuredClone(value); }
