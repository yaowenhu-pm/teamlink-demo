import {validateDocument, updateDocument, serializeDocument, evaluateExport} from './canvas-model.mjs';

/** Local records and a transport format for work performed by an external Agent. */
export class CanvasCollaborationError extends Error {
  constructor(code, message) { super(message); this.name = 'CanvasCollaborationError'; this.code = code; }
}
export const COLLAB_LIMITS = Object.freeze({projectBytes: 1000000, envelopeBytes: 1030000, proposalBytes: 50000,
  versions: 12, notes: 30, activity: 100, name: 100, goal: 3000, author: 80,
  versionName: 120, noteBody: 2000, instruction: 4000, title: 160, rationale: 3000});
export const ANCHORS = Object.freeze(['content', 'rules', 'data', 'expectations']);
const PROJECT_KEYS = ['schemaVersion', 'name', 'goal', 'author', 'versions', 'notes', 'activity'];
const PATCH_KEYS = ['content', 'data', 'filters', 'rules', 'networkMultiplier', 'retryNetworkMultiplier', 'expectations'];
const fail = (code, message) => { throw new CanvasCollaborationError(code, message); };
const ensure = (condition, message, code = 'INVALID_PROJECT') => { if (!condition) fail(code, message); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const bytes = value => new TextEncoder().encode(value).length;
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
function own(value, keys, label, code = 'INVALID_PROJECT') {
  ensure(plain(value) && Object.keys(value).every(key => keys.includes(key)), label + '包含不支持的字段。', code);
}
function text(value, max, label, code = 'INVALID_PROJECT', required = false) {
  ensure(typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0),
    label + '应为' + (required ? '非空、' : '') + '不超过 ' + max + ' 字的文字。', code);
  return value;
}
function jsonData(value, code, depth = 0) {
  ensure(depth <= 8, 'JSON 数据嵌套过深。', code);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item => jsonData(item, code, depth + 1)); return; }
  ensure(plain(value), '只能包含普通 JSON 数据。', code);
  Object.values(value).forEach(item => jsonData(item, code, depth + 1));
}
function checkedDocument(value, code = 'INVALID_PROJECT') {
  try { return validateDocument(value); } catch (error) { fail(code, '作品无效：' + error.message); }
}
function anchorInput(value, code = 'INVALID_PROJECT') {
  ensure(ANCHORS.includes(value), '讨论位置应为内容、规则、数据或判断期望。', code); return value;
}
function timestamp(value) {
  ensure(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, '记录时间无效。');
  return value;
}
function recordId(value, ids) {
  ensure(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value) && !ids.has(value), '记录编号无效或重复。');
  ids.add(value); return value;
}
function shortRevision(value) {
  ensure(typeof value === 'string' && /^doc-v1-[0-9a-z]+-[0-9a-f]{8}$/.test(value), '作品版本标识无效。'); return value;
}
/** Display identifier only. Conflict checks always compare the entire canonical document. */
export function revisionOf(document) {
  const canonical = serializeDocument(document), encoded = new TextEncoder().encode(canonical);
  let hash = 2166136261;
  for (const item of encoded) hash = Math.imul(hash ^ item, 16777619) >>> 0;
  return 'doc-v1-' + encoded.length.toString(36) + '-' + hash.toString(16).padStart(8, '0');
}
function records(value, max, label) {
  ensure(Array.isArray(value) && value.length <= max, label + '最多 ' + max + ' 条。'); return value;
}
export function validateProject(value) {
  own(value, PROJECT_KEYS, '项目'); ensure(value.schemaVersion === 1, '不支持这个项目版本。');
  const versionIds = new Set(), noteIds = new Set(), activityIds = new Set();
  const versions = records(value.versions, COLLAB_LIMITS.versions, '命名版本').map(item => {
    own(item, ['id', 'name', 'createdAt', 'revision', 'document'], '命名版本');
    const document = checkedDocument(item.document);
    ensure(item.revision === revisionOf(document), '命名版本与作品快照不一致。');
    return {id: recordId(item.id, versionIds), name: text(item.name, COLLAB_LIMITS.versionName, '版本名称', 'INVALID_PROJECT', true),
      createdAt: timestamp(item.createdAt), revision: item.revision, document};
  });
  const notes = records(value.notes, COLLAB_LIMITS.notes, '讨论记录').map(item => {
    own(item, ['id', 'author', 'anchor', 'body', 'createdAt', 'revision', 'document'], '讨论记录');
    const document = checkedDocument(item.document);
    ensure(item.revision === revisionOf(document), '讨论记录与作品快照不一致。');
    return {id: recordId(item.id, noteIds), author: text(item.author, COLLAB_LIMITS.author, '署名', 'INVALID_PROJECT', true),
      anchor: anchorInput(item.anchor), body: text(item.body, COLLAB_LIMITS.noteBody, '讨论内容', 'INVALID_PROJECT', true),
      createdAt: timestamp(item.createdAt), revision: item.revision, document};
  });
  const activity = records(value.activity, COLLAB_LIMITS.activity, '本地活动').map(item => {
    own(item, ['id', 'createdAt', 'author', 'kind', 'summary', 'revision'], '本地活动');
    return {id: recordId(item.id, activityIds), createdAt: timestamp(item.createdAt),
      author: text(item.author, COLLAB_LIMITS.author, '署名', 'INVALID_PROJECT', true),
      kind: text(item.kind, 60, '活动类型', 'INVALID_PROJECT', true), summary: text(item.summary, 300, '活动说明', 'INVALID_PROJECT', true),
      revision: item.revision === '' ? '' : shortRevision(item.revision)};
  });
  const result = {schemaVersion: 1, name: text(value.name, COLLAB_LIMITS.name, '项目名称', 'INVALID_PROJECT', true),
    goal: text(value.goal, COLLAB_LIMITS.goal, '项目目标'), author: text(value.author, COLLAB_LIMITS.author, '本地署名', 'INVALID_PROJECT', true),
    versions, notes, activity};
  ensure(bytes(JSON.stringify(result)) <= COLLAB_LIMITS.projectBytes, '项目内容过大，请导出备份后减少记录。');
  return freeze(result);
}
export function createProject(patch = {}) {
  own(patch, ['name', 'goal', 'author'], '项目设置');
  return validateProject({schemaVersion: 1, name: '一起打磨的新项目', goal: '围绕同一件作品，提出想法、验证变化并继续改进。',
    author: '我', versions: [], notes: [], activity: [], ...patch});
}
export function updateProject(project, patch) {
  const current = validateProject(project); own(patch, ['name', 'goal', 'author'], '项目设置');
  return validateProject({...current, ...patch});
}
function nextId(prefix, collection) {
  let suffix = collection.length + 1, id;
  do { id = prefix + '-' + Date.now().toString(36) + '-' + suffix++; } while (collection.some(item => item.id === id));
  return id;
}
function withActivity(project, {author = project.author, kind, summary, revision = ''}) {
  const entry = {id: nextId('activity', project.activity), createdAt: new Date().toISOString(), author, kind, summary, revision};
  return {...project, activity: [...project.activity, entry].slice(-COLLAB_LIMITS.activity)};
}
export function recordActivity(project, event) {
  const current = validateProject(project); own(event, ['author', 'kind', 'summary', 'revision'], '本地活动');
  return validateProject(withActivity(current, event));
}
export function saveVersion(project, value, name) {
  const current = validateProject(project), document = checkedDocument(value);
  ensure(current.versions.length < COLLAB_LIMITS.versions, '命名版本已达到 ' + COLLAB_LIMITS.versions + ' 份，请先导出项目备份。', 'PROJECT_LIMIT');
  const version = {id: nextId('version', current.versions), name: text(name, COLLAB_LIMITS.versionName, '版本名称', 'INVALID_PROJECT', true),
    createdAt: new Date().toISOString(), revision: revisionOf(document), document};
  return validateProject(withActivity({...current, versions: [...current.versions, version]},
    {kind: 'version-saved', summary: '保留版本：' + version.name, revision: version.revision}));
}
export function removeVersion(project, id) {
  const current = validateProject(project);
  text(id, 80, '版本编号', 'INVALID_PROJECT', true);
  const version = current.versions.find(item => item.id === id);
  ensure(version !== undefined, '找不到这份命名版本，未删除任何记录。');
  return validateProject(withActivity({...current, versions: current.versions.filter(item => item.id !== id)},
    {kind: 'version-removed', summary: '删除命名版本：' + version.name, revision: version.revision}));
}
export function addNote(project, value, options) {
  const current = validateProject(project), document = checkedDocument(value);
  own(options, ['author', 'anchor', 'body'], '讨论');
  ensure(current.notes.length < COLLAB_LIMITS.notes, '讨论记录已达到 ' + COLLAB_LIMITS.notes + ' 条，请先导出项目备份。', 'PROJECT_LIMIT');
  const note = {id: nextId('note', current.notes), author: options.author === undefined ? current.author : options.author,
    anchor: anchorInput(options.anchor), body: text(options.body, COLLAB_LIMITS.noteBody, '讨论内容', 'INVALID_PROJECT', true),
    createdAt: new Date().toISOString(), revision: revisionOf(document), document};
  return validateProject(withActivity({...current, notes: [...current.notes, note]},
    {author: note.author, kind: 'note-added', summary: '在' + ({content: '内容', rules: '规则', data: '数据', expectations: '判断期望'})[note.anchor] + '处留下讨论', revision: note.revision}));
}
export function removeNote(project, id) {
  const current = validateProject(project);
  text(id, 80, '讨论编号', 'INVALID_PROJECT', true);
  const note = current.notes.find(item => item.id === id);
  ensure(note !== undefined, '找不到这条讨论，未删除任何记录。');
  return validateProject(withActivity({...current, notes: current.notes.filter(item => item.id !== id)},
    {kind: 'note-removed', summary: '删除一条定位讨论', revision: note.revision}));
}
export function createAgentTask(project, value, options) {
  const current = validateProject(project), document = checkedDocument(value);
  own(options, ['instruction', 'anchor'], '外部 Agent 任务');
  const instruction = text(options.instruction, COLLAB_LIMITS.instruction, '任务说明', 'INVALID_PROJECT', true);
  const anchor = anchorInput(options.anchor), baseRevision = revisionOf(document);
  return freeze({schemaVersion: 1, kind: 'teamlink-agent-task', execution: 'external',
    project: {name: current.name, goal: current.goal, author: current.author}, instruction, anchor, baseRevision, baseDocument: document,
    contextNotes: current.notes.filter(note => note.anchor === anchor).map(({id, author, body, createdAt, revision}) => ({id, author, body, createdAt, revision})),
    instructions: ['这是供你在外部执行的任务包，网页没有启动或完成任何 Agent 工作。',
      '基于 baseDocument 给出明确修改，保持 baseDocument 与 baseRevision 原样返回。',
      '仅返回一个 JSON 提案；patch 只可包含 ' + PATCH_KEYS.join(', ') + '。data 使用完整替换数组。',
      '文案是字面内容；行为通过 rules、筛选、网络假设与数据表达。不要加入代码、凭证、HTML 执行或未发生的测试结果。',
      '署名只是提案作者自填，用户将在本地核对修改，再决定是否应用。'],
    responseFormat: {schemaVersion: 1, kind: 'teamlink-proposal', title: '填写这次修改的标题', author: '填写你的署名',
      rationale: '解释修改依据与仍需核对的地方', baseRevision, baseDocument: document, patch: {}}});
}
export function validateProposal(value) {
  const code = 'INVALID_PROPOSAL';
  own(value, ['schemaVersion', 'kind', 'title', 'author', 'rationale', 'baseRevision', 'baseDocument', 'patch'], 'Agent 提案', code);
  ensure(value.schemaVersion === 1 && value.kind === 'teamlink-proposal', '不支持这个提案格式。', code);
  const baseDocument = checkedDocument(value.baseDocument, code), baseRevision = revisionOf(baseDocument);
  if (value.baseRevision !== undefined) ensure(value.baseRevision === baseRevision, '提案版本标识与基准作品不一致。', code);
  own(value.patch, PATCH_KEYS, '修改提议', code); jsonData(value.patch, code);
  ensure(Object.keys(value.patch).length > 0, '提案需要至少一项明确修改。', code);
  try { updateDocument(baseDocument, value.patch); } catch (error) { fail(code, '修改提议无效：' + error.message); }
  const proposal = {schemaVersion: 1, kind: 'teamlink-proposal', title: text(value.title, COLLAB_LIMITS.title, '提案标题', code, true),
    author: text(value.author, COLLAB_LIMITS.author, '提案署名', code, true), rationale: text(value.rationale, COLLAB_LIMITS.rationale, '修改依据', code),
    baseRevision, baseDocument, patch: structuredClone(value.patch)};
  ensure(bytes(JSON.stringify(proposal)) <= COLLAB_LIMITS.proposalBytes, '提案内容过大。', code);
  return freeze(proposal);
}
function parseJson(json, max, code, label) {
  ensure(typeof json === 'string' && bytes(json) <= max, label + '文本无效或过大。', code);
  try { return JSON.parse(json); } catch { fail(code, label + '不是有效 JSON。'); }
}
export function parseProposal(json) { return validateProposal(parseJson(json, COLLAB_LIMITS.proposalBytes, 'INVALID_PROPOSAL', '提案')); }
function difference(before, after, path = '', changes = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return changes;
  if (Array.isArray(before) && Array.isArray(after) && path === 'data') {
    const oldIds = before.map(row => row.id), newIds = after.map(row => row.id);
    for (const id of new Set([...oldIds, ...newIds])) {
      difference(before.find(row => row.id === id), after.find(row => row.id === id), 'data[' + id + ']', changes);
    }
    if (JSON.stringify(oldIds) !== JSON.stringify(newIds)) changes.push({path: 'data.order', before: oldIds, after: newIds});
  } else if (plain(before) && plain(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      difference(before[key], after[key], path ? path + '.' + key : key, changes);
    }
  } else changes.push({path, before: before === undefined ? null : structuredClone(before), after: after === undefined ? null : structuredClone(after)});
  return changes;
}
export function previewProposal(value, input) {
  const current = checkedDocument(value), proposal = validateProposal(input);
  const document = updateDocument(proposal.baseDocument, proposal.patch);
  const conflict = serializeDocument(current) !== serializeDocument(proposal.baseDocument);
  return freeze({conflict, changes: difference(proposal.baseDocument, document), before: evaluateExport(current),
    after: evaluateExport(document), document, baseRevision: proposal.baseRevision, currentRevision: revisionOf(current)});
}
export function applyProposal(document, proposal) {
  const preview = previewProposal(document, proposal);
  ensure(!preview.conflict, '当前作品已经改变。请保留本地修改，并基于当前作品重新向 Agent 导出任务；此提案未应用。', 'PROPOSAL_CONFLICT');
  return preview.document;
}
export function exportProject(project, value) {
  const document = checkedDocument(value), checked = validateProject(project);
  const json = JSON.stringify({schemaVersion: 1, kind: 'teamlink-project', document, project: checked});
  ensure(bytes(json) <= COLLAB_LIMITS.envelopeBytes, '项目包过大，请减少记录后再导出。'); return json;
}
export function importProject(json) {
  const value = parseJson(json, COLLAB_LIMITS.envelopeBytes, 'INVALID_PROJECT', '项目包');
  own(value, ['schemaVersion', 'kind', 'document', 'project'], '项目包');
  ensure(value.schemaVersion === 1 && value.kind === 'teamlink-project', '不支持这个项目包格式。');
  const document = checkedDocument(value.document), project = validateProject(value.project);
  return freeze({document, project});
}
