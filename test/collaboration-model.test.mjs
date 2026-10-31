import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, updateDocument, serializeDocument} from '../web/legacy/canvas-model.mjs';
import {CanvasCollaborationError, COLLAB_LIMITS, ANCHORS, createProject, validateProject, updateProject,
  revisionOf, saveVersion, removeVersion, addNote, removeNote, recordActivity, createAgentTask, validateProposal, parseProposal,
  previewProposal, applyProposal, exportProject, importProject} from '../web/legacy/collaboration-model.mjs';

const hasCode = code => error => error instanceof CanvasCollaborationError && error.code === code;
const proposalFor = (document, patch = {rules: {preserveFilters: true}}, extra = {}) => ({schemaVersion: 1,
  kind: 'teamlink-proposal', title: '保留输入条件', author: '外部 Agent 自填署名', rationale: '只修改明确的行为参数。',
  baseRevision: revisionOf(document), baseDocument: document, patch, ...extra});

test('project metadata stays local, strict and immutable without creating invented work', () => {
  const project = createProject({name: '共同打磨 🧪', goal: '让修改能被核对', author: '访客'});
  assert.deepEqual(project.versions, []); assert.deepEqual(project.notes, []); assert.deepEqual(project.activity, []);
  const changed = updateProject(project, {goal: '改进导出体验'});
  assert.equal(changed.goal, '改进导出体验'); assert.equal(project.goal, '让修改能被核对');
  assert.ok(Object.isFrozen(changed)); assert.ok(Object.isFrozen(changed.activity));
  assert.throws(() => updateProject(project, {members: ['假成员']}), hasCode('INVALID_PROJECT'));
  assert.throws(() => updateProject(project, {name: ''}), hasCode('INVALID_PROJECT'));
  assert.throws(() => validateProject({...project, token: 'untrusted'}), hasCode('INVALID_PROJECT'));
});

test('named versions retain exact snapshots and enforce the visible cap without silent eviction', () => {
  const document = createDocument(), original = createProject();
  const first = saveVersion(original, document, '修改前');
  const edited = updateDocument(document, {content: {title: '另一种想法'}});
  assert.deepEqual(first.versions[0].document, document);
  assert.equal(first.versions[0].revision, revisionOf(document));
  assert.notEqual(revisionOf(edited), first.versions[0].revision);
  assert.equal(original.versions.length, 0); assert.equal(first.activity.at(-1).kind, 'version-saved');
  assert.ok(Object.isFrozen(first.versions[0].document.data));
  let filled = first;
  while (filled.versions.length < COLLAB_LIMITS.versions) filled = saveVersion(filled, edited, '版本 ' + filled.versions.length);
  assert.throws(() => saveVersion(filled, document, '超出上限'), hasCode('PROJECT_LIMIT'));
  assert.equal(filled.versions.length, COLLAB_LIMITS.versions);
  const reopened = removeVersion(filled, filled.versions[0].id);
  assert.equal(saveVersion(reopened, document, '释放位置后保存').versions.length, COLLAB_LIMITS.versions);
  const forged = structuredClone(first); forged.versions[0].document = edited;
  assert.throws(() => validateProject(forged), hasCode('INVALID_PROJECT'));
});

test('anchored notes keep their author text and exact contemporary document for later inspection', () => {
  const document = createDocument(), project = createProject({author: '本地编辑者'});
  const noted = addNote(project, document, {anchor: 'rules', body: '<b>保持为字面文字</b> 🧪'});
  assert.deepEqual(ANCHORS, ['content', 'rules', 'data', 'expectations']);
  assert.equal(noted.notes[0].author, '本地编辑者'); assert.equal(noted.notes[0].anchor, 'rules');
  assert.equal(noted.notes[0].body, '<b>保持为字面文字</b> 🧪');
  assert.deepEqual(noted.notes[0].document, document); assert.equal(noted.notes[0].revision, revisionOf(document));
  assert.equal(project.notes.length, 0); assert.equal(noted.activity[0].kind, 'note-added');
  assert.throws(() => addNote(project, document, {anchor: 'remote-runtime', body: '不可用'}), hasCode('INVALID_PROJECT'));
  const wrong = structuredClone(noted); wrong.notes[0].revision = 'invented';
  assert.throws(() => validateProject(wrong), hasCode('INVALID_PROJECT'));
  let filled = project;
  while (filled.notes.length < COLLAB_LIMITS.notes) filled = addNote(filled, document, {anchor: 'data', body: '记录 ' + filled.notes.length});
  assert.throws(() => addNote(filled, document, {anchor: 'data', body: '超出上限'}), hasCode('PROJECT_LIMIT'));
  const reopened = removeNote(filled, filled.notes[0].id);
  assert.equal(addNote(reopened, document, {anchor: 'data', body: '释放位置后讨论'}).notes.length, COLLAB_LIMITS.notes);
});

test('local activity retains the latest bounded records and validates imported shapes', () => {
  let project = createProject();
  for (let index = 0; index < COLLAB_LIMITS.activity + 3; index++) {
    project = recordActivity(project, {kind: 'proposal-applied', summary: '本地应用 ' + index, revision: revisionOf(createDocument())});
  }
  assert.equal(project.activity.length, COLLAB_LIMITS.activity); assert.equal(project.activity[0].summary, '本地应用 3');
  assert.equal(new Set(project.activity.map(item => item.id)).size, COLLAB_LIMITS.activity);
  const duplicate = structuredClone(project); duplicate.activity[1].id = duplicate.activity[0].id;
  assert.throws(() => validateProject(duplicate), hasCode('INVALID_PROJECT'));
  const timestamp = structuredClone(project); timestamp.activity[0].createdAt = '2026-02-30T00:00:00.000Z';
  assert.throws(() => validateProject(timestamp), hasCode('INVALID_PROJECT'));
});

test('explicit deletion frees version and note capacity while preserving all other snapshots and the original project', () => {
  const document = createDocument(), edited = updateDocument(document, {content: {title: '继续保留的作品'}});
  let project = saveVersion(createProject({author: '执行删除的本地访客'}), document, '准备删除');
  project = saveVersion(project, edited, '继续保留');
  project = addNote(project, document, {author: '原批注署名', anchor: 'data', body: '准备删除的批注'});
  project = addNote(project, edited, {anchor: 'rules', body: '继续保留的批注'});
  const original = JSON.stringify(project), keepVersion = project.versions[1], keepNote = project.notes[1];
  const removedVersion = removeVersion(project, project.versions[0].id);
  const removedNote = removeNote(removedVersion, project.notes[0].id);
  assert.deepEqual(removedNote.versions, [keepVersion]); assert.deepEqual(removedNote.notes, [keepNote]);
  assert.deepEqual(removedNote.versions[0].document, edited); assert.deepEqual(removedNote.notes[0].document, edited);
  assert.equal(removedNote.activity.at(-2).kind, 'version-removed'); assert.equal(removedNote.activity.at(-1).kind, 'note-removed');
  assert.equal(removedNote.activity.at(-1).author, '执行删除的本地访客', 'the local deleter is distinct from the note author');
  assert.equal(JSON.stringify(project), original); assert.equal(document.content.title, createDocument().content.title);
  assert.throws(() => removeVersion(removedNote, project.versions[0].id), hasCode('INVALID_PROJECT'));
  assert.throws(() => removeNote(removedNote, 'missing-note'), hasCode('INVALID_PROJECT'));
  assert.throws(() => removeVersion(project, {id: project.versions[0].id}), hasCode('INVALID_PROJECT'));
  assert.equal(saveVersion(removedNote, document, '可再保存').versions.length, 2);
  assert.equal(addNote(removedNote, document, {anchor: 'data', body: '可再讨论'}).notes.length, 2);
});

test('external Agent tasks include full editable state, relevant notes and an explicit response contract', () => {
  const document = createDocument({content: {title: '带走完整上下文 👩🏽‍💻'}});
  let project = addNote(createProject({name: '一起改好导出', goal: '解释每个选择'}), document, {anchor: 'rules', body: '请保留输入'});
  project = addNote(project, document, {anchor: 'content', body: '另一处讨论'});
  const original = JSON.stringify(project);
  const task = createAgentTask(project, document, {anchor: 'rules', instruction: '提出可核对的修改，并解释原因。'});
  assert.equal(task.kind, 'teamlink-agent-task'); assert.equal(task.execution, 'external');
  assert.deepEqual(task.baseDocument, document); assert.equal(task.baseRevision, revisionOf(document));
  assert.deepEqual(task.baseDocument.data, document.data); assert.deepEqual(task.baseDocument.expectations, document.expectations);
  assert.equal(task.contextNotes.length, 1); assert.equal(task.contextNotes[0].body, '请保留输入');
  assert.deepEqual(task.responseFormat.baseDocument, document);
  assert.equal(task.responseFormat.kind, 'teamlink-proposal');
  assert.equal(JSON.stringify(project), original, 'exporting a task does not fabricate an Agent run or alter local records');
  assert.deepEqual(JSON.parse(JSON.stringify(task)).baseDocument, document);
});

test('a real imported proposal computes a preview before an explicit atomic application', () => {
  const document = createDocument(), original = serializeDocument(document);
  const proposal = parseProposal(JSON.stringify(proposalFor(document)));
  const preview = previewProposal(document, proposal);
  assert.equal(preview.conflict, false); assert.equal(preview.before.outputRows.length, 10); assert.equal(preview.after.outputRows.length, 3);
  assert.deepEqual(preview.changes, [{path: 'rules.preserveFilters', before: false, after: true}]);
  const applied = applyProposal(document, proposal);
  assert.deepEqual(applied, preview.document); assert.equal(applied.rules.preserveFilters, true);
  assert.equal(serializeDocument(document), original); assert.equal(document.rules.preserveFilters, false);
  assert.ok(Object.isFrozen(preview.changes));
});

test('editing after task export conflicts even when the Agent patches a different field', () => {
  const base = createDocument(), proposal = proposalFor(base);
  const current = updateDocument(base, {content: {title: '本地刚刚改过'}}), original = serializeDocument(current);
  const preview = previewProposal(current, proposal);
  assert.equal(preview.conflict, true); assert.notEqual(preview.baseRevision, preview.currentRevision);
  assert.equal(preview.document.content.title, base.content.title, 'preview shows the proposal anchored to its actual base');
  assert.throws(() => applyProposal(current, proposal), hasCode('PROPOSAL_CONFLICT'));
  assert.equal(serializeDocument(current), original);
  const missingRevision = {...proposal}; delete missingRevision.baseRevision;
  assert.equal(validateProposal(missingRevision).baseRevision, revisionOf(base));
  assert.throws(() => parseProposal(JSON.stringify({...proposal, baseRevision: revisionOf(current)})), hasCode('INVALID_PROPOSAL'));
});

test('full data replacement produces stable row diffs, additions, removals and order changes', () => {
  const document = createDocument();
  const data = [{...document.data[1], title: '真正的新内容', amount: 999},
    {id: 'new-row', date: '2026-10-31', category: '产品', title: '新增记录', amount: 0}, ...document.data.slice(2)];
  const preview = previewProposal(document, proposalFor(document, {data}));
  assert.ok(preview.changes.some(item => item.path === 'data[r01]' && item.after === null));
  assert.ok(preview.changes.some(item => item.path === 'data[r02].title' && item.after === '真正的新内容'));
  assert.ok(preview.changes.some(item => item.path === 'data[new-row]' && item.before === null));
  assert.ok(preview.changes.some(item => item.path === 'data.order'));
  assert.deepEqual(preview.document.data, data); assert.equal(document.data[0].id, 'r01');
});

test('unknown, invalid, oversized and deeply nested proposals never mutate the current document', () => {
  const document = createDocument(), original = serializeDocument(document);
  const rejected = [
    proposalFor(document, {runtime: 'execute-code'}), proposalFor(document, {content: {unknown: 'untrusted'}}),
    proposalFor(document, {rules: {timeoutMs: -1}}), proposalFor(document, {}),
    proposalFor(document, {data: [{id: 'invalid'}]}), {...proposalFor(document), kind: 'agent-completed'},
    {...proposalFor(document), secret: 'untrusted'}, {...proposalFor(document), author: ''},
    proposalFor(document, {content: {title: '<script>not executed</script>'}}, {rationale: '字'.repeat(COLLAB_LIMITS.rationale + 1)}),
  ];
  for (const value of rejected) assert.throws(() => parseProposal(JSON.stringify(value)), hasCode('INVALID_PROPOSAL'));
  assert.throws(() => validateProposal(proposalFor(document, {rules: undefined})), hasCode('INVALID_PROPOSAL'));
  let deep = 'x'; for (let index = 0; index < 20; index++) deep = {nested: deep};
  assert.throws(() => validateProposal(proposalFor(document, {content: {title: deep}})), hasCode('INVALID_PROPOSAL'));
  assert.throws(() => parseProposal('not JSON'), hasCode('INVALID_PROPOSAL'));
  assert.throws(() => parseProposal(' '.repeat(COLLAB_LIMITS.proposalBytes + 1)), hasCode('INVALID_PROPOSAL'));
  assert.equal(serializeDocument(document), original); assert.equal({}.polluted, undefined);
});

test('Unicode project envelopes roundtrip full versions, anchored snapshots and current state', () => {
  const document = createDocument({content: {title: '中文与 👩🏽‍💻 & 字面 <b>文本</b>'}});
  let project = saveVersion(createProject({name: '团队项目 🧪', author: '访客自填'}), document, '初稿');
  project = addNote(project, document, {anchor: 'expectations', body: '这条判断还需要实际核对。'});
  const edited = updateDocument(document, {rules: {retrySource: 'original'}});
  const exported = exportProject(project, edited), restored = importProject(exported);
  assert.deepEqual(restored, {document: edited, project}); assert.equal(exportProject(restored.project, restored.document), exported);
  assert.deepEqual(restored.project.notes[0].document, document); assert.deepEqual(restored.project.versions[0].document, document);
  assert.ok(Object.isFrozen(restored.project.notes[0])); assert.ok(Object.isFrozen(restored.document));
});

test('invalid envelopes fail as a whole without partially replacing valid state', () => {
  const document = createDocument(), project = createProject();
  const valid = JSON.parse(exportProject(project, document)), before = JSON.stringify({document, project});
  const wrongProject = structuredClone(valid); wrongProject.project.notes = [{body: '缺少所需字段'}];
  const wrongDocument = structuredClone(valid); wrongDocument.document.rules.timeoutMs = -1;
  const wrongKind = {...valid, kind: 'teamlink-proposal'};
  for (const value of [wrongProject, wrongDocument, wrongKind, {...valid, credentials: 'untrusted'}]) {
    assert.throws(() => importProject(JSON.stringify(value)), hasCode('INVALID_PROJECT'));
  }
  assert.throws(() => importProject(' '.repeat(COLLAB_LIMITS.envelopeBytes + 1)), hasCode('INVALID_PROJECT'));
  assert.equal(JSON.stringify({document, project}), before);
});
