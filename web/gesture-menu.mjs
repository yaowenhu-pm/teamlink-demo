const PAGE_SIZE = 5; // Five content items, up to three navigation buttons, plus two fixed mode controls and three editing shortcuts.
const CATEGORIES = Object.freeze([
  ['edit', '编辑对象'],
  ['sun', '太阳 / 月亮'], ['tree', '树'], ['mountain', '山'], ['boat', '船'],
  ['bird', '鸟'], ['flower', '花'], ['cloud', '云'], ['leaf', '落叶'],
  ['environment', '环境'], ['layers', '图层'], ['actions', '操作'],
]);
const ENVIRONMENT_IDS = new Set(['rain', 'wind', 'sky', 'water', 'branches', 'flowers', 'clouds']);
const LEAF_IDS = new Set(['leaf', 'leafOrigin', 'leafTarget']);
const ACTIONS = Object.freeze([
  ['undo', '撤销'], ['reset', '恢复默认'], ['motion', '动画开关'],
  ['music', '音乐开关'], ['immersive', '沉浸画布'], ['close', '关闭菜单'],
]);
const EDIT_ACTIONS = Object.freeze([
  ['copy', '复制'], ['cut', '剪切'], ['paste', '粘贴'], ['duplicate', '复制一份'],
  ['delete', '删除'], ['undo', '撤销'], ['redo', '重做'],
]);
const EDIT_FLAGS = Object.freeze({copy: 'canCopy', cut: 'canCut', paste: 'canPaste',
  duplicate: 'canDuplicate', delete: 'canDelete', undo: 'canUndo', redo: 'canRedo'});
const EDIT_STATE_KEYS = new Set(['selectedLabel', 'clipboardLabel', 'reason', ...Object.values(EDIT_FLAGS)]);

// The menu receives capability state, not clipboard contents or editable code.
// Copy only ordinary data fields so a stale or malformed state is rejected before
// changing the current page; external labels and reasons are never parsed as HTML.
function snapshotEditState(value = {}) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Gesture edit state must be a plain data object.');
  }
  const data = {};
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !EDIT_STATE_KEYS.has(key) || !property.enumerable || !Object.hasOwn(property, 'value')) {
      throw new TypeError('Unknown or unsafe gesture edit state field.');
    }
    data[key] = property.value;
  }
  const result = {};
  for (const key of ['selectedLabel', 'clipboardLabel']) {
    if (data[key] !== undefined && typeof data[key] !== 'string') throw new TypeError('Gesture edit labels must be text.');
    result[key] = (data[key] ?? '').trim();
  }
  for (const key of Object.values(EDIT_FLAGS)) {
    if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new TypeError('Gesture edit capabilities must be booleans.');
    result[key] = data[key] === true;
  }
  const reason = data.reason;
  if (reason !== undefined && typeof reason !== 'string'
    && (!reason || typeof reason !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(reason)))) {
    throw new TypeError('Gesture edit reasons must be text or an action map.');
  }
  const reasons = {};
  if (typeof reason === 'string') {
    for (const [id] of EDIT_ACTIONS) reasons[id] = reason.trim();
  } else if (reason) {
    for (const key of Reflect.ownKeys(reason)) {
      const property = Object.getOwnPropertyDescriptor(reason, key);
      if (typeof key !== 'string' || !Object.hasOwn(EDIT_FLAGS, key) || !property.enumerable
        || !Object.hasOwn(property, 'value') || typeof property.value !== 'string') {
        throw new TypeError('Unknown or unsafe gesture edit reason.');
      }
    }
    // Stable ordering keeps equivalent updates from replacing the measured DOM.
    for (const [id] of EDIT_ACTIONS) if (Object.hasOwn(reason, id)) reasons[id] = reason[id].trim();
  }
  result.reason = Object.freeze(reasons);
  return Object.freeze(result);
}
function editCommand(state, id, label, prefix = 'action') {
  const selected = Boolean(state.selectedLabel), clipboard = Boolean(state.clipboardLabel);
  const contextReady = id === 'paste' ? clipboard : ['undo', 'redo'].includes(id) || selected;
  const enabled = contextReady && state[EDIT_FLAGS[id]];
  const fallback = id === 'paste' ? clipboard ? '当前不能粘贴，请先减少同类对象数量。' : '先复制一个对象。'
    : id === 'undo' ? '还没有可撤销的操作。' : id === 'redo' ? '还没有可重做的操作。' : '先选择一个可编辑对象。';
  const reason = enabled ? '' : !contextReady ? fallback : state.reason[id] || fallback;
  return {key: `${prefix}:${id}`, label, type: 'action', id, disabled: !enabled, reason};
}
const clientPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const measuredRect = value => value && [value.left, value.top, value.right, value.bottom].every(Number.isFinite)
  && value.right > value.left && value.bottom > value.top;
const containsPoint = (rect, point) => point.x >= rect.left && point.x < rect.right
  && point.y >= rect.top && point.y < rect.bottom;

function snapshotTargets(value) {
  if (!Array.isArray(value)) throw new TypeError('Gesture menu targets must be an array.');
  const seen = new Set();
  return value.flatMap(target => {
    if (!target || typeof target.id !== 'string' || !target.id || seen.has(target.id)) return [];
    seen.add(target.id);
    return [{id: target.id, label: typeof target.label === 'string' && target.label ? target.label : target.id,
      kind: typeof target.kind === 'string' ? target.kind : ''}];
  });
}

/** Pure menu inventory and navigation. No DOM, camera, network, or callbacks. */
export function createGestureMenuState() {
  let targets = [], selectedId = null, selectionMode = 'auto', scene = {}, category = 'root', page = 0, editState = snapshotEditState();
  const checkedMode = value => {
    if (!['auto', 'manual'].includes(value)) throw new RangeError('Unknown gesture selection mode.');
    return value;
  };
  const targetItem = target => ({key: `target:${target.id}`, label: target.label, type: 'select', id: target.id,
    selected: selectedId === target.id});
  function items() {
    if (category === 'root') return CATEGORIES.map(([id, label]) => ({key: `category:${id}`, label, type: 'category', id}));
    if (category === 'edit') return EDIT_ACTIONS.map(([id, label]) => editCommand(editState, id, label));
    if (category === 'actions') return ACTIONS.map(([id, label]) => id === 'undo' ? editCommand(editState, id, label) : {key: `action:${id}`, label, type: 'action', id});
    let filtered;
    if (category === 'leaf') filtered = targets.filter(target => LEAF_IDS.has(target.id));
    else if (category === 'environment') filtered = targets.filter(target => target.id.startsWith('count:') || ENVIRONMENT_IDS.has(target.id));
    else if (category === 'layers') filtered = targets.filter(target => target.id.startsWith('decor:') && !/^decor:(?:flower|cloud):/u.test(target.id));
    else filtered = targets.filter(target => target.kind === category
      || (category === 'sun' && target.id === 'sun'));
    if (['tree','mountain','boat','bird','flower','cloud'].includes(category)) filtered.sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));
    const result = filtered.map(targetItem);
    if (category === 'leaf') result.push({key: 'action:draw:leaf', label: '手绘落叶路线', type: 'action', id: 'draw:leaf',
      disabled: scene.trees === 0 && !targets.some(target => LEAF_IDS.has(target.id))});
    return result;
  }
  function view() {
    const all = items(), pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page), pageCount - 1);
    const footer = [];
    if (page > 0) footer.push({key: 'nav:previous', label: '上一页', type: 'nav', id: 'previous'});
    if (page < pageCount - 1) footer.push({key: 'nav:next', label: '下一页', type: 'nav', id: 'next'});
    footer.push(category === 'root'
      ? {key: 'action:close', label: '关闭菜单', type: 'action', id: 'close'}
      : {key: 'nav:back', label: '返回分类', type: 'nav', id: 'back'});
    const modeItems = [['auto', '自动拾取'], ['manual', '手动选择']].map(([id, label]) => ({
      key: `mode:${id}`, label, type: 'mode', id, selected: selectionMode === id,
    }));
    const editItems = EDIT_ACTIONS.filter(([id]) => ['copy', 'paste', 'delete'].includes(id))
      .map(([id, label]) => editCommand(editState, id, label, 'quick'));
    return {category, selectionMode, modeItems, editItems, editState, title: category === 'root' ? '选择要控制的内容'
      : CATEGORIES.find(([id]) => id === category)?.[1] ?? '选择内容',
    page, pageCount, items: all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), footer};
  }
  return Object.freeze({
    open(value = {}) {
      if (!value || typeof value !== 'object') throw new TypeError('Gesture menu options must be an object.');
      const nextTargets = snapshotTargets(value.targets ?? []);
      const nextSelectedId = typeof value.selectedId === 'string' ? value.selectedId : null;
      const nextMode = checkedMode(value.selectionMode ?? (nextSelectedId && nextSelectedId !== 'auto' ? 'manual' : 'auto'));
      const nextEditState = snapshotEditState(value.editState);
      editState = nextEditState;
      targets = nextTargets; selectedId = nextSelectedId; selectionMode = nextMode;
      scene = value.scene && typeof value.scene === 'object' ? {trees: value.scene.trees} : {};
      category = 'root'; page = 0;
      return view();
    },
    updateTargets(value) {targets = snapshotTargets(value); return view();},
    updateEditState(value) {editState = snapshotEditState(value); return view();},
    updateMode(mode, nextSelectedId = selectedId) {
      const nextMode = checkedMode(mode);
      if (nextSelectedId !== null && (typeof nextSelectedId !== 'string' || !nextSelectedId)) throw new TypeError('Invalid selected gesture target.');
      selectionMode = nextMode; selectedId = nextSelectedId; return view();
    },
    view,
    activate(key) {
      const current = view(), item = [...current.modeItems, ...current.editItems, ...current.items, ...current.footer].find(candidate => candidate.key === key);
      if (!item || item.disabled) return null;
      if (item.type === 'category') {category = item.id; page = 0; return {type: 'navigate'};}
      if (item.type === 'nav') {
        if (item.id === 'back') {category = 'root'; page = 0;}
        else page += item.id === 'next' ? 1 : -1;
        return {type: 'navigate'};
      }
      return {type: item.type, id: item.id};
    },
  });
}

/** Pure time-based activation. A fired button must be left before it can fire again. */
export function createGestureMenuDwell({holdMs = 500, maxGapMs = 250} = {}) {
  if (![holdMs, maxGapMs].every(Number.isFinite) || holdMs <= 0 || maxGapMs <= 0) throw new RangeError('Invalid menu dwell options.');
  let candidate = null, since = null, previousTime = null, blocked = null;
  const reset = ({release = false} = {}) => {
    candidate = null; since = null; previousTime = null;
    if (release) blocked = null;
  };
  return Object.freeze({reset,
    update(key, timestampMs, {enabled = true} = {}) {
      if ((key !== null && (typeof key !== 'string' || !key)) || !Number.isFinite(timestampMs) || timestampMs < 0) {
        reset(); return {key: null, progress: 0, triggered: false};
      }
      if (key !== blocked) blocked = null;
      if (!enabled) {reset(); return {key: null, progress: 0, triggered: false};}
      if (previousTime !== null && (timestampMs <= previousTime || timestampMs - previousTime > maxGapMs)) reset();
      previousTime = timestampMs;
      if (key === null || key === blocked) {
        candidate = null; since = null;
        return {key, progress: 0, triggered: false};
      }
      if (candidate !== key) {candidate = key; since = timestampMs;}
      const progress = Math.min(1, (timestampMs - since) / holdMs);
      if (progress === 1) {blocked = key; candidate = null; since = null;}
      return {key, progress, triggered: progress === 1};
    },
  });
}

/**
 * Mount into an existing panel. Cursor x/y are viewport client pixels, matching
 * getBoundingClientRect(), not scene-normalized coordinates. update returns the
 * dwell feedback. enabled=false clears progress while preserving the held-button
 * latch. Gesture navigation and mode activation also lock the old button's physical rectangle until
 * a valid enabled cursor leaves it, preventing a new page from selecting whatever
 * appears in the same slot. Gaps, missing cursors, and resetDwell preserve this
 * lock; close/open clear it. Mouse clicks remain immediately available.
 * Every external label is written with textContent, never parsed as HTML.
 */
export function mountGestureMenu(root, {onSelect = () => {}, onAction = () => {}, onModeChange = () => {}} = {}) {
  if (!root?.ownerDocument?.createElement || typeof root.replaceChildren !== 'function'
    || typeof onSelect !== 'function' || typeof onAction !== 'function' || typeof onModeChange !== 'function') throw new TypeError('Gesture menu requires a DOM root and callbacks.');
  const document = root.ownerDocument, model = createGestureMenuState(), dwell = createGestureMenuDwell();
  let opened = false, buttons = [], rendered = null, blockedRegion = null;
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '手势内容选择器');
  root.setAttribute('aria-modal', 'false');

  function clearProgress() {
    for (const button of buttons) {
      button.dataset.dwell = '0';
      button.dataset.dwelling = 'false';
      button.style.setProperty('--dwell', '0');
    }
  }
  function resetDwell() {dwell.reset(); clearProgress();}
  function close() {
    opened = false; root.hidden = true; blockedRegion = null;
    dwell.reset({release: true}); clearProgress();
  }
  function activate(key, {gesture = false, timestampMs = null} = {}) {
    if (!opened) return;
    // Capture before model navigation replaces the measured button nodes.
    const rect = gesture && buttons.find(button => button.dataset.menuKey === key)?.getBoundingClientRect();
    const event = model.activate(key);
    if (!event) return;
    if (event.type === 'navigate' || event.type === 'mode') {
      if (measuredRect(rect)) blockedRegion = {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, lastTime: timestampMs};
      if (event.type === 'mode') onModeChange(event.id);
      if (opened) render();
      return;
    }
    close();
    if (event.type === 'select') onSelect(event.id);
    else if (event.type === 'action') onAction(event.id);
  }
  function makeButton(item) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'gesture-menu-item';
    button.dataset.menuKey = item.key;
    button.dataset.dwell = '0'; button.dataset.dwelling = 'false';
    button.style.setProperty('--dwell', '0');
    button.textContent = item.label;
    button.setAttribute('aria-label', item.label);
    button.setAttribute('aria-pressed', String(Boolean(item.selected)));
    button.disabled = Boolean(item.disabled);
    if (item.reason) {button.setAttribute('title', item.reason); button.setAttribute('aria-description', item.reason);}
    button.addEventListener('click', () => activate(item.key));
    buttons.push(button);
    return button;
  }
  function render() {
    const view = model.view(), signature = JSON.stringify(view);
    if (signature === rendered) return;
    resetDwell(); buttons = []; rendered = signature;
    const title = document.createElement('h2'); title.className = 'title';
    title.textContent = `${view.title}${view.pageCount > 1 ? ` · ${view.page + 1}/${view.pageCount}` : ''}`;
    const modeSwitch = document.createElement('div'); modeSwitch.className = 'gesture-mode-switch';
    modeSwitch.setAttribute('role', 'group'); modeSwitch.setAttribute('aria-label', '选择方式');
    for (const item of view.modeItems) modeSwitch.appendChild(makeButton(item));
    const editSummary = document.createElement('p'); editSummary.className = 'gesture-edit-summary';
    editSummary.setAttribute('aria-live', 'polite');
    for (const [className, label] of [['gesture-edit-selected', `选中：${view.editState.selectedLabel || '未选择可编辑对象'}`],
      ['gesture-edit-clipboard', `剪贴板：${view.editState.clipboardLabel || '空'}`]]) {
      const span = document.createElement('span'); span.className = className; span.textContent = label; editSummary.appendChild(span);
    }
    const editShortcuts = document.createElement('div'); editShortcuts.className = 'gesture-edit-shortcuts';
    editShortcuts.setAttribute('role', 'group'); editShortcuts.setAttribute('aria-label', '编辑选中对象');
    for (const item of view.editItems) editShortcuts.appendChild(makeButton(item));
    const grid = document.createElement('div'); grid.className = 'gesture-menu-grid';
    for (const item of view.items) grid.appendChild(makeButton(item));
    if (!view.items.length) {
      const empty = document.createElement('p'); empty.className = 'gesture-menu-empty'; empty.textContent = '当前没有可选择的内容。';
      grid.appendChild(empty);
    }
    const footer = document.createElement('div'); footer.className = 'gesture-menu-footer';
    for (const item of view.footer) footer.appendChild(makeButton(item));
    root.replaceChildren(title, modeSwitch, editSummary, editShortcuts, grid, footer);
  }
  return Object.freeze({
    open(options = {}) {
      model.open(options); rendered = null; blockedRegion = null; dwell.reset({release: true});
      opened = true; root.hidden = false; render();
    },
    close,
    isOpen: () => opened,
    resetDwell,
    updateTargets(targets) {model.updateTargets(targets); if (opened) render();},
    updateEditState(state) {model.updateEditState(state); if (opened) render();},
    updateMode(mode, selectedId) {model.updateMode(mode, selectedId); if (opened) render();},
    update(cursor, timestampMs, {enabled = true} = {}) {
      const validCursor = clientPoint(cursor);
      let hit = null;
      if (opened && validCursor) hit = buttons.find(button => {
        if (button.disabled || button.hidden) return false;
        const rect = button.getBoundingClientRect();
        return measuredRect(rect) && containsPoint(rect, cursor);
      }) ?? null;
      if (blockedRegion) {
        const validTime = Number.isFinite(timestampMs) && timestampMs >= 0
          && (blockedRegion.lastTime === null || timestampMs > blockedRegion.lastTime);
        if (validTime) blockedRegion.lastTime = timestampMs;
        if (opened && enabled === true && validCursor && validTime && !containsPoint(blockedRegion, cursor)) {
          blockedRegion = null;
          dwell.reset({release: true});
        } else {
          resetDwell();
          return {key: hit?.dataset.menuKey ?? null, progress: 0, triggered: false};
        }
      }
      const result = dwell.update(hit?.dataset.menuKey ?? null, timestampMs, {enabled: opened && enabled && Boolean(validCursor)});
      clearProgress();
      if (hit && result.key === hit.dataset.menuKey) {
        hit.dataset.dwell = String(result.progress);
        hit.dataset.dwelling = String(result.progress > 0);
        hit.style.setProperty('--dwell', String(result.progress));
      }
      if (result.triggered) activate(result.key, {gesture: true, timestampMs});
      return result;
    },
  });
}
