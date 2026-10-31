import { formatSceneCode, parseSceneCode, sceneCodeDiff } from './scene-code.mjs';

let panelCount = 0;
const FIELDS = Object.freeze({ sun: ['hour'], tree: ['trees', 'branchAngle', 'branchDepth', 'flowers', 'seed'], leaf: ['wind', 'rain', 'seed', 'leafTrail', 'leafOrigin', 'leafTarget'] });
const HINTS = Object.freeze({ sun: '太阳对应 hour；拖动太阳和修改这个字段使用同一个时间值。',
  tree: '树木对应 trees、branchAngle、branchDepth、flowers；seed 控制确定的布局。',
  leaf: 'leafTrail 保存手绘路线；leafOrigin / leafTarget 可调整两端。空路线使用 wind、rain、seed 计算随风轨迹。' });
const SOURCES = Object.freeze([{ path: '/scene-model.mjs', label: 'scene-model.mjs · 参数与运动计算' },
  { path: '/scene-renderer.mjs', label: 'scene-renderer.mjs · 实际 SVG 绘制' },
  { path: '/motion-model.mjs', label: 'motion-model.mjs · 落叶、流水与飞鸟动画' }]);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function display(value) { return value!==null&&typeof value==='object'?JSON.stringify(value,null,2):typeof value==='boolean'?(value?'true':'false'):String(value); }

/** Editable JSON data, actual before/after values and the served renderer source. Never eval. */
export function mountCodePanel(root, { onPreview = () => {}, onCommit = () => {}, onCancel = () => {} } = {}) {
  if (!root?.replaceChildren) throw new TypeError('代码面板需要一个 DOM 根节点。');
  const id = `scene-code-${++panelCount}`, cleanups = [], panel = element('section', 'code-panel');
  const tabs = element('div', 'code-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '风景代码');
  const tabNodes = new Map(), panes = new Map();
  for (const [name, title] of [['parameters', '参数'], ['diff', '前后对比'], ['source', '渲染源码']]) {
    const button = element('button', 'code-tab', title); button.type = 'button'; button.dataset.tab = name;
    button.id = `${id}-tab-${name}`; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `${id}-pane-${name}`);
    const pane = element('div', 'code-pane'); pane.dataset.pane = name; pane.id = `${id}-pane-${name}`;
    pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', button.id);
    tabs.append(button); tabNodes.set(name, button); panes.set(name, pane);
  }
  const note = element('p', 'code-parameter-note', '有效 JSON 会即时预览；点击“应用并同步”后，同一房间才会更新。');
  const hint = element('p', 'code-field-hint', '这些参数直接驱动当前风景。');
  const editorShell = element('div', 'code-editor-shell');
  const highlight = element('pre', 'code-highlight'); highlight.setAttribute('aria-hidden', 'true');
  const textarea = element('textarea', 'code-textarea'); textarea.setAttribute('aria-label', '风景参数 JSON');
  textarea.spellcheck = false; textarea.autocapitalize = 'off'; textarea.autocomplete = 'off'; textarea.rows = 13;
  textarea.setAttribute('wrap', 'off'); textarea.setAttribute('autocorrect', 'off');
  editorShell.append(highlight, textarea);
  const error = element('p', 'code-error'); error.id = `${id}-error`; error.setAttribute('role', 'status');
  textarea.setAttribute('aria-describedby', error.id);
  const actions = element('div', 'code-actions'), apply = element('button', 'code-apply', '应用并同步'), cancel = element('button', 'code-cancel', '取消预览');
  apply.type = cancel.type = 'button'; actions.append(apply, cancel);
  panes.get('parameters').append(note, hint, editorShell, error, actions);
  const diffList = element('div', 'code-diff-list'); panes.get('diff').append(diffList);
  const sourceNote = element('p', 'code-parameter-note', '以下是本站实际提供的模块源码，只读查看，不会执行你输入的代码。');
  const sourceSelect = element('select', 'code-source-select'); sourceSelect.setAttribute('aria-label', '选择真实源码文件');
  for (const item of SOURCES) { const option = element('option', '', item.label); option.value = item.path; sourceSelect.append(option); }
  const sourceStatus = element('p', 'code-source-status'); sourceStatus.setAttribute('role', 'status');
  const source = element('pre', 'code-source'); source.setAttribute('tabindex', '0'); source.setAttribute('aria-label', '真实模块源码，只读');
  const sourceRetry = element('button', 'code-source-retry', '重新读取源码'); sourceRetry.type = 'button'; sourceRetry.hidden = true;
  panes.get('source').append(sourceNote, sourceSelect, sourceStatus, sourceRetry, source);
  panel.append(tabs, ...panes.values()); root.replaceChildren(panel);

  let current = null, baseline = null, draftBase = null, draftScene = null, draftPatch = null;
  let dirty = false, busy = false, committing = false, selected = null, activeTab = 'parameters', destroyed = false;
  let sourceController = null, sourceVersion = 0, draftVersion = 0;
  let highlightedText = null;
  const sourceCache = new Map();
  function listen(node, event, callback) { node.addEventListener(event, callback); cleanups.push(() => node.removeEventListener(event, callback)); }
  function showError(message) { error.textContent = message || ''; textarea.setAttribute('aria-invalid', String(!!message)); }
  function controls() {
    textarea.disabled = busy || committing || !current;
    apply.disabled = busy || committing || !dirty || !draftPatch || !Object.keys(draftPatch).length;
    cancel.disabled = busy || committing || !dirty;
    panel.classList.toggle('has-draft', dirty); panel.classList.toggle('is-busy', busy || committing);
  }
  function relatedKeys() { return FIELDS[selected] ?? []; }
  function syncHighlightScroll() { highlight.scrollTop = textarea.scrollTop; highlight.scrollLeft = textarea.scrollLeft; }
  function paintParameters() {
    if (highlightedText !== textarea.value) {
      highlightedText = textarea.value; highlight.replaceChildren();
      textarea.value.split('\n').forEach((line, index) => {
        const row = element('span', 'code-row'); row.dataset.line = String(index + 1);
        let offset = 0;
        // Tokenize strings first, so digits/booleans inside quoted text stay literal.
        for (const match of line.matchAll(/"(?:\\.|[^"\\])*(?:"|$)|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false)\b/gu)) {
          if (match.index > offset) row.append(document.createTextNode(line.slice(offset, match.index)));
          const token = match[0], isKey = token.startsWith('"') && token.endsWith('"') && /^\s*:/u.test(line.slice(match.index + token.length));
          const className = isKey ? 'code-token-key' : /^(?:true|false)$/u.test(token) ? 'code-token-boolean' : !token.startsWith('"') ? 'code-token-number' : '';
          row.append(element('span', className, token));
          if (isKey && row.dataset.key === undefined) { try { row.dataset.key = JSON.parse(token); } catch {} }
          offset = match.index + token.length;
        }
        if (offset < line.length) row.append(document.createTextNode(line.slice(offset)));
        if (!line.length) row.append(document.createTextNode('\u200b'));
        highlight.append(row);
      });
    }
    for (const row of highlight.children) row.classList.toggle('is-related', relatedKeys().includes(row.dataset.key));
    syncHighlightScroll();
  }
  function renderDiff() {
    diffList.replaceChildren();
    if (!current || !baseline) { diffList.append(element('p', 'code-empty', '还没有可以比较的场景。')); return; }
    const changes = sceneCodeDiff(baseline, draftScene ?? current);
    if (!changes.length) { diffList.append(element('p', 'code-empty', '参数没有变化。调整后，这里会显示实际前后值。')); return; }
    for (const change of changes) {
      const row = element('div', 'code-diff-row'); row.dataset.key = change.key;
      row.classList.toggle('is-related', relatedKeys().includes(change.key));
      row.append(element('span', 'code-diff-key', `${change.label} · ${change.key}`),
        element('code', 'code-diff-before', `- ${JSON.stringify(change.key)}: ${display(change.before)}`), element('span', 'code-diff-arrow', '→'),
        element('code', 'code-diff-after', `+ ${JSON.stringify(change.key)}: ${display(change.after)}`));
      diffList.append(row);
    }
  }
  function highlightParameters() {
    hint.textContent = HINTS[selected] ?? '这些参数直接驱动当前风景。';
    textarea.dataset.selectedFields = relatedKeys().join(' ');
    paintParameters();
    if (dirty || document.activeElement === textarea || !relatedKeys().length) return;
    const lines = textarea.value.split('\n'); let offset = 0;
    for (const line of lines) {
      if (relatedKeys().some((key) => line.includes(`"${key}"`))) { textarea.setSelectionRange(offset, offset + line.length); return; }
      offset += line.length + 1;
    }
  }
  function paintSource(text) {
    source.replaceChildren();
    const patterns = selected === 'sun' ? /solarPosition|hour|altitude|daylight/u : selected === 'tree' ? /branch|trees|flowers|seed/iu : selected === 'leaf' ? /leafPath|wind|rain|rotation|samples/u : null;
    text.split('\n').forEach((line, index) => {
      const span = element('span', 'code-source-line', line + '\n'); span.dataset.line = String(index + 1);
      span.classList.toggle('is-related', !!patterns?.test(line)); source.append(span);
    });
  }
  async function loadSource(force = false) {
    const path = sourceSelect.value;
    if (!SOURCES.some((item) => item.path === path)) return;
    sourceController?.abort(); const version = ++sourceVersion;
    sourceRetry.hidden = true;
    if (!force && sourceCache.has(path)) { paintSource(sourceCache.get(path)); sourceStatus.textContent = `真实文件：${path} · 只读`; return; }
    sourceController = new AbortController(); sourceStatus.textContent = '正在读取真实模块源码…'; source.replaceChildren();
    try {
      const response = await fetch(path, { cache: 'no-store', signal: sourceController.signal });
      if (!response.ok) throw Error('无法读取源码。');
      const text = await response.text();
      if (destroyed || version !== sourceVersion) return;
      sourceCache.set(path, text); paintSource(text); sourceStatus.textContent = `真实文件：${path} · 只读`;
    } catch (failure) {
      if (destroyed || version !== sourceVersion || failure.name === 'AbortError') return;
      sourceStatus.textContent = '源码读取失败，当前没有显示替代代码。'; sourceRetry.hidden = false;
    }
  }
  function chooseTab(name, focus = false) {
    activeTab = name;
    for (const [key, button] of tabNodes) {
      const active = key === name; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      button.classList.toggle('is-active', active); panes.get(key).hidden = !active;
    }
    if (focus) tabNodes.get(name).focus();
    if (name === 'source') loadSource();
  }
  function resetDraft(next) {
    draftVersion++; draftBase = null; draftScene = null; draftPatch = null; dirty = false;
    textarea.value = formatSceneCode(next); paintParameters(); showError('');
  }
  for (const [name, button] of tabNodes) {
    listen(button, 'click', () => chooseTab(name));
    listen(button, 'keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const names = [...tabNodes.keys()], index = names.indexOf(name);
      chooseTab(event.key === 'Home' ? names[0] : event.key === 'End' ? names.at(-1) : names[(index + (event.key === 'ArrowRight' ? 1 : 2)) % names.length], true);
    });
  }
  listen(textarea, 'input', () => {
    if (busy || committing || !current) return;
    if (!dirty) draftBase = current;
    dirty = true; draftVersion++; const version = draftVersion;
    paintParameters();
    try {
      const parsed = parseSceneCode(textarea.value, draftBase);
      draftScene = parsed.scene;
      draftPatch = Object.freeze(Object.fromEntries(sceneCodeDiff(draftBase, draftScene).map(({ key, after }) => [key, after])));
      showError(''); controls(); renderDiff();
      const result = onPreview(draftPatch);
      if (result?.catch) result.catch((failure) => { if (!destroyed && version === draftVersion) { draftPatch = null; showError(failure?.message || '预览未能应用。'); controls(); } });
    } catch (failure) {
      draftPatch = null; showError(`${failure?.message || '参数格式无效。'} 当前保留上一次有效预览，尚未同步。`);
      controls(); renderDiff();
    }
  });
  listen(textarea, 'scroll', syncHighlightScroll);
  listen(apply, 'click', async () => {
    if (apply.disabled || !draftPatch) return;
    committing = true; controls();
    try { await onCommit(draftPatch); }
    catch (failure) { showError(failure?.message || '同步未能完成，参数尚未确认。'); }
    finally { if (!destroyed) { committing = false; controls(); } }
  });
  listen(cancel, 'click', () => {
    if (cancel.disabled) return;
    const restore = draftBase ?? current; current = restore; resetDraft(restore); controls(); renderDiff(); highlightParameters();
    onCancel();
  });
  listen(sourceSelect, 'change', () => loadSource()); listen(sourceRetry, 'click', () => loadSource(true));
  chooseTab('parameters'); controls();
  return Object.freeze({
    update(scene, options = {}) {
      if (destroyed) return;
      // Validate through the same serializer before taking a new scene snapshot.
      const formatted = formatSceneCode(scene); current = scene;
      if (options.before !== undefined) { formatSceneCode(options.before); baseline = options.before; }
      else if (!baseline || options.resetDraft) baseline = scene;
      if (Object.hasOwn(options, 'busy')) busy = !!options.busy;
      const previousSelected = selected;
      if (Object.hasOwn(options, 'selected')) selected = options.selected;
      if (options.resetDraft) resetDraft(scene);
      else if (!dirty) textarea.value = formatted;
      controls(); renderDiff(); highlightParameters();
      if (activeTab === 'source' && previousSelected !== selected && sourceCache.has(sourceSelect.value)) paintSource(sourceCache.get(sourceSelect.value));
    },
    destroy() {
      destroyed = true; sourceVersion++; sourceController?.abort(); cleanups.forEach((cleanup) => cleanup()); root.replaceChildren();
    },
  });
}
