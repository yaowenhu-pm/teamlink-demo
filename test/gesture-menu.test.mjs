import test from 'node:test';
import assert from 'node:assert/strict';
import {createGestureMenuState, createGestureMenuDwell, mountGestureMenu} from '../web/gesture-menu.mjs';

const targets = [
  {id: 'sun', kind: 'sun', label: '太阳 / 月亮'},
  ...['tree', 'mountain', 'boat', 'bird'].flatMap(kind => Array.from({length: 12}, (_, index) => ({id: `${kind}:${index}`, kind, label: `${kind} ${index + 1}`}))),
  ...['flower', 'cloud'].flatMap(kind => Array.from({length: 12}, (_, index) => ({id: `decor:${kind}:${index}`, kind, label: `${kind} ${index + 1}`}))),
  ...['leaf', 'leafOrigin', 'leafTarget'].map(id => ({id, kind: id, label: id})),
  ...['trees', 'mountains', 'boats', 'birds'].map(field => ({id: `count:${field}`, kind: 'count', label: `${field}数量`})),
  ...['rain', 'wind', 'sky', 'water', 'branches', 'flowers', 'clouds'].map(id => ({id, kind: 'environment', label: id})),
  ...['stars', 'distant', 'foreground', 'water', 'reflection'].map(kind => ({id: `decor:${kind}`, kind, label: kind})),
];

function category(state, id) {
  if (state.view().category !== 'root') state.activate('nav:back');
  while (!state.view().items.some(item => item.key === `category:${id}`)) {
    assert.ok(state.view().footer.some(item => item.key === 'nav:next'), `missing category ${id}`);
    state.activate('nav:next');
  }
  assert.deepEqual(state.activate(`category:${id}`), {type: 'navigate'});
  return state.view();
}
function allItems(state) {
  const items = [];
  while (true) {
    const view = state.view();
    assert.ok(view.items.length + view.footer.length <= 8, 'content and navigation stay bounded');
    assert.equal(view.modeItems.length, 2, 'both selection modes are available on every page');
    assert.equal(view.editItems.length, 3, 'copy, paste, and delete remain available on every page');
    assert.ok(view.modeItems.length + view.editItems.length + view.items.length + view.footer.length <= 13, 'content, navigation, and fixed controls remain bounded');
    const keys=[...view.modeItems,...view.editItems,...view.items,...view.footer].map(item=>item.key);
    assert.equal(new Set(keys).size,keys.length,'every measured button key is unique');
    items.push(...view.items);
    if (!view.footer.some(item => item.key === 'nav:next')) return items;
    state.activate('nav:next');
  }
}

test('all categories are paginated while both selection modes remain fixed', () => {
  const state = createGestureMenuState();
  state.open({targets, selectedId: 'auto', scene: {trees: 3}});
  assert.deepEqual(allItems(state).map(item => item.id), ['edit', 'sun', 'tree', 'mountain', 'boat', 'bird',
    'flower', 'cloud', 'leaf', 'environment', 'layers', 'actions']);
  assert.deepEqual(state.activate('mode:auto'), {type: 'mode', id: 'auto'});
  assert.deepEqual(state.activate('mode:manual'), {type: 'mode', id: 'manual'});
  assert.equal(state.activate('select:auto'), null);
  assert.equal(state.activate('not-a-key'), null);
});

test('object lists contain each individual target, with previous, next and return navigation', () => {
  for (const kind of ['sun', 'tree', 'mountain', 'boat', 'bird', 'flower', 'cloud']) {
    const state = createGestureMenuState();
    state.open({targets, selectedId: 'tree:0'});
    category(state, kind);
    const listed = allItems(state);
    assert.deepEqual(listed.map(item => item.id), targets.filter(target => target.kind === kind).map(target => target.id));
    if (kind !== 'sun') {
      assert.ok(state.view().footer.some(item => item.id === 'previous'));
      state.activate('nav:previous');
      assert.equal(state.view().page, 1);
    }
    state.activate('nav:back');
    assert.equal(state.view().category, 'root');
    assert.equal(state.view().page, 0);
  }
  const state = createGestureMenuState();
  state.open({targets, selectedId: 'tree:0'}); category(state, 'tree');
  assert.equal(state.view().items[0].selected, true);
  assert.deepEqual(state.activate('target:tree:0'), {type: 'select', id: 'tree:0'});
});

test('individual lists number the hero tree before later renderer-created instances', () => {
  const state=createGestureMenuState();
  state.open({targets:[{id:'tree:1',kind:'tree'},{id:'tree:10',kind:'tree'},{id:'tree:0',kind:'tree'}]});
  category(state,'tree');
  assert.deepEqual(allItems(state).map(item=>item.id),['tree:0','tree:1','tree:10']);
});

test('leaf, environment, layers, and actions expose the intended independent controls', () => {
  const state = createGestureMenuState(); state.open({targets, scene: {trees: 3}});
  category(state, 'leaf');
  assert.deepEqual(allItems(state).map(item => item.id), ['leaf', 'leafOrigin', 'leafTarget', 'draw:leaf']);
  assert.deepEqual(state.activate('action:draw:leaf'), {type: 'action', id: 'draw:leaf'});
  category(state, 'environment');
  const environment = allItems(state).map(item => item.id);
  assert.deepEqual(environment, ['count:trees', 'count:mountains', 'count:boats', 'count:birds',
    'rain', 'wind', 'sky', 'water', 'branches', 'flowers', 'clouds']);
  category(state, 'layers');
  assert.deepEqual(allItems(state).map(item => item.id), ['decor:stars', 'decor:distant', 'decor:foreground', 'decor:water', 'decor:reflection']);
  category(state, 'actions');
  assert.deepEqual(allItems(state).map(item => item.id), ['undo', 'reset', 'motion', 'music', 'immersive', 'close']);
  assert.deepEqual(state.activate('action:close'), {type: 'action', id: 'close'});
});

test('inventory snapshots cannot be changed externally; removing targets clamps pagination safely', () => {
  const state = createGestureMenuState(), source = [{id: 'tree:0', kind: 'tree', label: 'Original'}, ...targets.filter(target => target.kind === 'tree' && target.id !== 'tree:0')];
  const scene = {trees: 3}; state.open({targets: source, scene});
  source[0].label = 'Changed'; scene.trees = 0;
  category(state, 'tree');
  assert.equal(state.view().items[0].label, 'Original');
  state.view().items[0].label = 'Mutated view';
  assert.equal(state.view().items[0].label, 'Original');
  allItems(state);
  state.updateTargets([{id: 'tree:0', kind: 'tree', label: 'New'}]);
  assert.equal(state.view().page, 0);
  assert.equal(state.view().items[0].label, 'New');
  assert.equal(state.activate('target:tree:11'), null);
  state.open({targets: [], scene: {trees: 0}}); category(state, 'leaf');
  assert.equal(state.view().items[0].disabled, true);
  assert.equal(state.activate('action:draw:leaf'), null);
  assert.throws(() => state.updateTargets({}), TypeError);
});

function hold(dwell, key, start = 0) {
  let result;
  for (let elapsed = 0; elapsed <= 500; elapsed += 125) result = dwell.update(key, start + elapsed);
  return result;
}
test('dwell requires 500ms and leaving a fired button before repeating', () => {
  const dwell = createGestureMenuDwell();
  assert.equal(dwell.update('target:a', 0).progress, 0);
  assert.equal(dwell.update('target:a', 125).progress, .25);
  dwell.update('target:a', 250); dwell.update('target:a', 375);
  assert.equal(dwell.update('target:a', 499).triggered, false);
  assert.equal(dwell.update('target:a', 500).triggered, true);
  assert.equal(hold(dwell, 'target:a', 625).triggered, false);
  dwell.reset();
  assert.equal(hold(dwell, 'target:a', 1141).triggered, false, 'a reset is not a physical button exit');
  dwell.update(null, 1657);
  assert.equal(hold(dwell, 'target:a', 1673).triggered, true);
});

test('movement, disabled input, long gaps, and bad time restart dwell without activation', () => {
  for (const interrupt of [
    dwell => dwell.update(null, 200), dwell => dwell.update('other', 200),
    dwell => dwell.update('a', 200, {enabled: false}), dwell => dwell.update('a', 500),
    dwell => dwell.update('a', 100), dwell => dwell.update('a', NaN),
  ]) {
    const dwell = createGestureMenuDwell(); dwell.update('a', 0); dwell.update('a', 125);
    assert.equal(interrupt(dwell).triggered, false);
    assert.equal(dwell.update('a', 900).progress, 0);
    let completed;
    for (const timestampMs of [1025, 1150, 1275, 1400]) completed = dwell.update('a', timestampMs);
    assert.equal(completed.triggered, true);
  }
  const dwell = createGestureMenuDwell();
  assert.equal(hold(dwell, 'a').triggered, true);
  dwell.update('a', 625, {enabled: false});
  assert.equal(hold(dwell, 'a', 750).triggered, false, 'disabled input preserves the held-button latch');
  for (const options of [{holdMs: 0}, {holdMs: NaN}, {maxGapMs: 0}]) assert.throws(() => createGestureMenuDwell(options), RangeError);
});

// Small DOM fixture: models text, attributes, event listeners, and measured hit
// boxes. It never starts a browser or accesses camera/provider APIs.
class Element {
  constructor(tag, document) {
    this.tagName = tag; this.ownerDocument = document; this.children = []; this.dataset = {};
    this.attributes = {}; this.listeners = {}; this.style = {setProperty: (key, value) => {this.style[key] = value;}};
    this.hidden = false; this.disabled = false;
    this.rect = {left: 0, top: 0, right: 0, bottom: 0};
  }
  setAttribute(key, value) {this.attributes[key] = value;}
  appendChild(child) {this.children.push(child); return child;}
  replaceChildren(...children) {this.children = children;}
  addEventListener(name, callback) {this.listeners[name] = callback;}
  getBoundingClientRect() {return this.rect;}
  click() {if (!this.disabled) this.listeners.click?.();}
  set innerHTML(value) {throw new Error(`HTML parsing is forbidden: ${value}`);}
}
function fixture(callbacks = {}) {
  const document = {createElement: tag => new Element(tag, document)};
  const root = new Element('section', document), menu = mountGestureMenu(root, callbacks);
  const buttons = () => root.children.flatMap(child => child.children).filter(child => child.tagName === 'button');
  function layout() {
    buttons().forEach((button, index) => {button.rect = {left: 10, right: 210, top: 20 + 60 * index, bottom: 70 + 60 * index};});
  }
  function click(key) {const button = buttons().find(item => item.dataset.menuKey === key); assert.ok(button, `missing button ${key}`); button.click(); layout();}
  return {root, menu, buttons, layout, click};
}

function cursorFor(ui, key) {
  const button = ui.buttons().find(item => item.dataset.menuKey === key);
  assert.ok(button, `missing button ${key}`);
  const r = button.rect;
  return {x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2};
}

test('mounted menu supports client-pixel dwell navigation and closes before selection callback', () => {
  const selected = [], ui = fixture({onSelect: id => {assert.equal(ui.menu.isOpen(), false); selected.push(id);}});
  ui.menu.open({targets}); ui.layout();
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.root.attributes.role, 'dialog');
  const cursor = cursorFor(ui, 'category:tree');
  for (let timestampMs = 0; timestampMs <= 500; timestampMs += 125) ui.menu.update(cursor, timestampMs, {enabled: true});
  ui.layout();
  assert.match(ui.root.children[0].textContent, /^树/u);
  assert.equal(ui.menu.isOpen(), true);
  const target = ui.buttons().find(button => button.dataset.menuKey === 'target:tree:0');
  assert.ok(target);
  const targetCursor = cursorFor(ui, 'target:tree:0');
  ui.menu.update(targetCursor, 625);
  ui.menu.update(targetCursor, 750);
  assert.equal(target.dataset.dwell, '0.25');
  assert.equal(target.style['--dwell'], '0.25');
  for (const timestampMs of [875, 1000, 1125]) ui.menu.update(targetCursor, timestampMs);
  assert.deepEqual(selected, ['tree:0']);
  assert.equal(ui.root.hidden, true);
  assert.equal(target.dataset.dwell, '0');
});

test('gesture category navigation locks the old physical slot until an enabled cursor leaves', () => {
  const selected = [], ui = fixture({onSelect: id => selected.push(id)});
  ui.menu.open({targets}); ui.layout();
  const cursor = cursorFor(ui, 'category:tree');
  for (const timestampMs of [0, 125, 250, 375, 500]) ui.menu.update(cursor, timestampMs);
  ui.layout();
  const originalTitle = ui.root.children[0].textContent;
  const replacement = ui.buttons().find(button => contains(button.rect, cursor)).dataset.menuKey;
  assert.match(replacement, /^target:tree:/u);
  assert.match(originalTitle, /^树/u);
  for (const timestampMs of [625, 750, 875, 1000, 1125, 1250]) {
    assert.equal(ui.menu.update(cursor, timestampMs).progress, 0);
  }
  ui.menu.resetDwell();
  ui.menu.update(cursor, 4000); // a frame gap cannot clear the physical lock
  ui.menu.update({x: 300, y: 210}, 4125, {enabled: false}); // disabled motion is not an observed exit
  ui.menu.update(null, 4250); // loss is not an observed exit either
  ui.menu.update({x: 300, y: 210}, NaN);
  ui.menu.update({x: 300, y: 210}, 1000); // regressed time cannot unlock it
  ui.menu.updateTargets(targets.map(target => ({...target, label: `${target.label} updated`})));
  ui.layout();
  for (const timestampMs of [4375, 4500, 4625, 4750, 4875]) {
    assert.equal(ui.menu.update(cursor, timestampMs).triggered, false);
  }
  assert.deepEqual(selected, []);
  assert.equal(ui.menu.isOpen(), true);
  assert.equal(ui.root.children[0].textContent, originalTitle);
  ui.menu.update({x: 300, y: 210}, 5000); // valid exit releases the old rectangle
  for (const timestampMs of [5125, 5250, 5375, 5500, 5625]) ui.menu.update(cursor, timestampMs);
  assert.deepEqual(selected, [replacement.slice('target:'.length)]);
  assert.equal(ui.menu.isOpen(), false);
});

test('gesture pagination cannot bounce or skip pages while the cursor stays in its old rectangle', () => {
  const ui = fixture(); ui.menu.open({targets}); ui.layout();
  const next = ui.buttons().find(button => button.dataset.menuKey === 'nav:next');
  const cursor = {x: next.rect.left + 5, y: next.rect.top + 5};
  for (const timestampMs of [0, 125, 250, 375, 500]) ui.menu.update(cursor, timestampMs);
  ui.layout();
  assert.match(ui.root.children[0].textContent, /2\/3/u);
  assert.equal(ui.buttons().find(button => contains(button.rect, cursor)).dataset.menuKey, 'nav:previous');
  for (const timestampMs of [625, 750, 875, 1000, 1125, 1250, 3000]) {
    assert.equal(ui.menu.update(cursor, timestampMs).triggered, false);
  }
  assert.match(ui.root.children[0].textContent, /2\/3/u);
  ui.click('nav:next'); // the physical lock does not restrict mouse navigation
  assert.match(ui.root.children[0].textContent, /3\/3/u);
  ui.click('nav:previous');
  assert.match(ui.root.children[0].textContent, /2\/3/u);
});

test('closing and reopening clears the navigation region lock', () => {
  const ui = fixture(); ui.menu.open({targets}); ui.layout();
  const cursor = cursorFor(ui, 'category:tree');
  for (const timestampMs of [0, 125, 250, 375, 500]) ui.menu.update(cursor, timestampMs);
  ui.layout(); assert.match(ui.root.children[0].textContent, /^树/u);
  ui.menu.close(); ui.menu.open({targets}); ui.layout();
  for (const timestampMs of [625, 750, 875, 1000, 1125]) ui.menu.update(cursor, timestampMs);
  assert.match(ui.root.children[0].textContent, /^树/u);
});

function contains(rect, cursor) {
  return cursor.x >= rect.left && cursor.x < rect.right && cursor.y >= rect.top && cursor.y < rect.bottom;
}

test('opening or disabling does not immediately activate; unchanged target updates preserve dwell', () => {
  const ui = fixture(); ui.menu.open({targets}); ui.layout();
  const first = ui.buttons().find(button => button.dataset.menuKey === 'category:sun'), cursor = cursorFor(ui, 'category:sun');
  assert.equal(ui.menu.update(cursor, 10000, {enabled: false}).progress, 0);
  assert.equal(ui.menu.update(cursor, 10125).progress, 0);
  ui.menu.update(cursor, 10250);
  ui.menu.updateTargets(targets.map(target => ({...target, bounds: {left: 0}})));
  assert.equal(ui.buttons().find(button => button.dataset.menuKey === 'category:sun'), first, 'geometry-only inventory changes do not replace menu buttons');
  assert.equal(ui.menu.update(cursor, 10375).progress, .5);
  ui.menu.resetDwell();
  assert.equal(first.dataset.dwell, '0');
  assert.equal(ui.menu.update(cursor, 10500).progress, 0);
  ui.menu.update(null, 10625);
  assert.equal(ui.menu.update(cursor, 10750).progress, 0);
  ui.menu.close();
  assert.equal(ui.menu.update(cursor, 10875).triggered, false);
});

test('mouse selection and actions match gesture behavior, with safe external text rendering', () => {
  const selected = [], actions = [], modes = [], label = '<img src=x onerror=alert(1)>';
  const ui = fixture({onSelect: id => selected.push(id), onAction: id => actions.push(id), onModeChange: id => modes.push(id)});
  ui.menu.open({targets: [{id: 'tree:0', kind: 'tree', label}]}); ui.layout();
  ui.click('category:tree');
  const treeButton = ui.buttons().find(button => button.dataset.menuKey === 'target:tree:0');
  assert.equal(treeButton.textContent, label);
  assert.equal(treeButton.attributes['aria-label'], label);
  ui.click('target:tree:0');
  assert.deepEqual(selected, ['tree:0']); assert.equal(ui.menu.isOpen(), false);
  ui.menu.open({targets, editState: {canUndo: true}}); ui.layout();
  ui.click('nav:next'); ui.click('nav:next'); ui.click('category:actions');
  ui.click('action:undo');
  assert.deepEqual(actions, ['undo']); assert.equal(ui.menu.isOpen(), false);
  ui.menu.open({targets}); ui.layout();
  ui.click('nav:next'); ui.click('nav:next'); ui.click('mode:auto');
  assert.deepEqual(selected, ['tree:0']);
  assert.deepEqual(modes, ['auto']);
  assert.equal(ui.menu.isOpen(), true, 'mode callbacks own whether the picker stays open');
  ui.menu.open({targets}); ui.layout(); ui.click('action:close');
  assert.deepEqual(actions, ['undo', 'close']);
  assert.throws(() => mountGestureMenu({}), TypeError);
});

test('fixed mode controls remain on every page and updating them preserves object navigation', () => {
  const state = createGestureMenuState(); state.open({targets, selectionMode: 'auto'});
  for (const kind of ['sun', 'tree', 'mountain', 'boat', 'bird', 'flower', 'cloud', 'leaf', 'environment', 'layers', 'actions']) {
    category(state, kind);
    while (true) {
      const view = state.view();
      assert.deepEqual(view.modeItems.map(item => [item.key, item.type]), [['mode:auto', 'mode'], ['mode:manual', 'mode']]);
      assert.equal(view.modeItems.find(item => item.id === 'auto').selected, true);
      if (!view.footer.some(item => item.id === 'next')) break;
      state.activate('nav:next');
    }
  }
  category(state, 'tree'); state.activate('nav:next'); state.activate('nav:next');
  const before = state.view();
  const manual = state.updateMode('manual', 'tree:10');
  assert.equal(manual.category, before.category); assert.equal(manual.page, before.page);
  assert.equal(manual.selectionMode, 'manual');
  assert.equal(manual.modeItems.find(item => item.id === 'manual').selected, true);
  assert.equal(manual.items.find(item => item.id === 'tree:10').selected, true);
  const automatic = state.updateMode('auto', null);
  assert.equal(automatic.page, before.page);
  assert.equal(automatic.items.some(item => item.selected), false);
  assert.throws(() => state.updateMode('unknown'), RangeError);
  assert.throws(() => state.updateMode('manual', {}), TypeError);
  assert.deepEqual(state.view(), automatic, 'invalid mode state is atomic');
  state.open({targets, selectedId: 'boat:0'});
  assert.equal(state.view().selectionMode, 'manual', 'legacy explicit selection infers manual mode');
  state.open({targets, selectedId: 'boat:0', selectionMode: 'auto'});
  assert.equal(state.view().selectionMode, 'auto', 'explicit mode overrides inference');
});

test('mounted mode buttons use the same callback for mouse and dwell without closing the picker', () => {
  const modes = [];
  const ui = fixture({onModeChange: mode => {
    assert.equal(ui.menu.isOpen(), true);
    modes.push(mode); ui.menu.updateMode(mode, mode === 'manual' ? 'tree:0' : null); ui.layout();
  }});
  ui.menu.open({targets, selectionMode: 'auto'}); ui.layout();
  assert.equal(ui.root.children[1].className, 'gesture-mode-switch');
  assert.equal(ui.root.children[1].attributes.role, 'group');
  assert.equal(ui.root.children[1].attributes['aria-label'], '选择方式');
  ui.click('category:tree'); ui.click('nav:next');
  const title = ui.root.children[0].textContent;
  ui.click('mode:manual');
  assert.equal(ui.menu.isOpen(), true); assert.equal(ui.root.children[0].textContent, title);
  assert.equal(ui.buttons().find(button => button.dataset.menuKey === 'mode:manual').attributes['aria-pressed'], 'true');
  assert.equal(ui.buttons().find(button => button.dataset.menuKey === 'mode:auto').attributes['aria-pressed'], 'false');
  const auto = ui.buttons().find(button => button.dataset.menuKey === 'mode:auto');
  const cursor = {x: auto.rect.left + 5, y: auto.rect.top + 5};
  for (const timestampMs of [0, 125, 250, 375, 500]) ui.menu.update(cursor, timestampMs);
  assert.deepEqual(modes, ['manual', 'auto']);
  assert.equal(ui.menu.isOpen(), true); assert.equal(ui.root.children[0].textContent, title);
});

test('a held mode button cannot repeat after its callback rebuilds the selected mode', () => {
  const modes = [], selected = [];
  const ui = fixture({onSelect: id => selected.push(id), onModeChange: mode => {
    modes.push(mode); ui.menu.updateMode(mode, mode === 'manual' ? 'tree:0' : null); ui.layout();
  }});
  ui.menu.open({targets, selectionMode: 'auto'}); ui.layout();
  const manual = ui.buttons().find(button => button.dataset.menuKey === 'mode:manual');
  const cursor = {x: manual.rect.left + 5, y: manual.rect.top + 5};
  for (const timestampMs of [0, 125, 250, 375, 500]) ui.menu.update(cursor, timestampMs);
  assert.deepEqual(modes, ['manual']);
  for (const timestampMs of [625, 750, 875, 1000, 1125]) assert.equal(ui.menu.update(cursor, timestampMs).triggered, false);
  ui.menu.resetDwell();
  ui.menu.update({x: 300, y: cursor.y}, 3000, {enabled: false});
  ui.menu.update(null, 3125);
  for (const timestampMs of [3250, 3375, 3500, 3625, 3750]) assert.equal(ui.menu.update(cursor, timestampMs).triggered, false);
  assert.deepEqual(modes, ['manual']); assert.deepEqual(selected, []);
  ui.menu.update({x: 300, y: cursor.y}, 3875);
  const auto = ui.buttons().find(button => button.dataset.menuKey === 'mode:auto');
  const next = {x: auto.rect.left + 5, y: auto.rect.top + 5};
  for (const timestampMs of [4000, 4125, 4250, 4375, 4500]) ui.menu.update(next, timestampMs);
  assert.deepEqual(modes, ['manual', 'auto']);
  assert.equal(ui.menu.isOpen(), true);
});


const editable = Object.freeze({selectedLabel: '帆船 1', clipboardLabel: '帆船副本',
  canCopy: true, canCut: true, canPaste: true, canDuplicate: true, canDelete: true, canUndo: true, canRedo: true});

test('editing is the first root entry and fixed shortcuts work on every object page without duplicate keys', () => {
  const state=createGestureMenuState();state.open({targets,editState:editable});
  assert.equal(state.view().items[0].key,'category:edit');
  for(const kind of ['edit','sun','tree','boat','flower','cloud','leaf','environment','layers','actions']){
    category(state,kind);
    while(true){
      const view=state.view();
      assert.deepEqual(view.editItems.map(item=>[item.key,item.id,item.disabled]),[
        ['quick:copy','copy',false],['quick:paste','paste',false],['quick:delete','delete',false],
      ]);
      assert.equal(view.editState.selectedLabel,'帆船 1');assert.equal(view.editState.clipboardLabel,'帆船副本');
      const keys=[...view.modeItems,...view.editItems,...view.items,...view.footer].map(item=>item.key);
      assert.equal(new Set(keys).size,keys.length);
      if(!view.footer.some(item=>item.id==='next'))break;
      state.activate('nav:next');
    }
  }
  category(state,'edit');
  assert.deepEqual(allItems(state).map(item=>item.id),['copy','cut','paste','duplicate','delete','undo','redo']);
  assert.deepEqual(state.activate('action:redo'),{type:'action',id:'redo'});
  assert.deepEqual(state.activate('quick:copy'),{type:'action',id:'copy'});
});

test('editing capabilities disable empty selection, empty clipboard, capacity, undo, and redo with reasons', () => {
  const state=createGestureMenuState();state.open({targets});
  assert.ok(state.view().editItems.every(item=>item.disabled));
  assert.equal(state.activate('quick:paste'),null);
  category(state,'edit');
  assert.ok(allItems(state).every(item=>item.disabled));
  state.updateEditState({canCopy:true,canCut:true,canDelete:true,canDuplicate:true,canPaste:true});
  assert.ok(state.view().editItems.every(item=>item.disabled),'true flags cannot invent an object or clipboard');
  state.updateEditState({...editable,canPaste:false,canUndo:false,canRedo:false,reason:{paste:'帆船数量已到上限。'}});
  const paste=state.view().editItems.find(item=>item.id==='paste');
  assert.equal(paste.disabled,true);assert.equal(paste.reason,'帆船数量已到上限。');assert.equal(state.activate('quick:paste'),null);
  assert.equal(state.activate('action:undo'),null);assert.equal(state.activate('action:redo'),null);
  category(state,'actions');assert.equal(state.view().items.find(item=>item.id==='undo').disabled,true,'legacy undo uses the same capability');
  state.updateEditState({...editable,canCopy:false,canCut:false,canDelete:false,canDuplicate:false,reason:'环境图层不能作为独立对象编辑。'});
  assert.equal(state.view().editItems.find(item=>item.id==='copy').reason,'环境图层不能作为独立对象编辑。');
});

test('edit state snapshots are safe, immutable, atomic, and retain navigation when updated', () => {
  const state=createGestureMenuState(),source={...editable,reason:{paste:' 已满 '}};
  state.open({targets,editState:source});category(state,'tree');state.activate('nav:next');state.activate('nav:next');
  const before=state.view();source.selectedLabel='Changed';source.reason.paste='Changed';
  assert.equal(before.editState.selectedLabel,'帆船 1');assert.equal(before.editState.reason.paste,'已满');
  assert.equal(Object.isFrozen(before.editState),true);assert.equal(Object.isFrozen(before.editState.reason),true);
  const next=state.updateEditState({...editable,clipboardLabel:'另一艘船',canRedo:false});
  assert.equal(next.category,before.category);assert.equal(next.page,before.page);assert.equal(next.editState.clipboardLabel,'另一艘船');
  let getterCalls=0;
  const hostile=Object.defineProperty({},'canCopy',{enumerable:true,get(){getterCalls++;throw Error('getter executed');}});
  const badReason=Object.defineProperty({},'paste',{enumerable:true,get(){getterCalls++;throw Error('reason getter executed');}});
  for(const invalid of [null,[],{canCopy:1},{selectedLabel:{}},{reason:[]},{reason:{unknown:'no'}},{reason:badReason},hostile,{unknown:'field'}]){
    assert.throws(()=>state.updateEditState(invalid),TypeError);assert.deepEqual(state.view(),next);
  }
  assert.equal(getterCalls,0);
});

test('shortcut mouse and dwell actions close before callback and disabled actions cannot fire', () => {
  const actions=[],ui=fixture({onAction:id=>{assert.equal(ui.menu.isOpen(),false);actions.push(id);}});
  ui.menu.open({targets,editState:editable});ui.layout();ui.click('quick:copy');
  assert.deepEqual(actions,['copy']);assert.equal(ui.menu.isOpen(),false);
  ui.menu.open({targets,editState:{...editable,canPaste:false,reason:{paste:'已满'}}});ui.layout();
  const paste=ui.buttons().find(button=>button.dataset.menuKey==='quick:paste'),cursor=cursorFor(ui,'quick:paste');
  assert.equal(paste.disabled,true);assert.equal(paste.attributes.title,'已满');assert.equal(paste.attributes['aria-description'],'已满');
  paste.click();for(const timestamp of [0,125,250,375,500])assert.equal(ui.menu.update(cursor,timestamp).triggered,false);
  assert.deepEqual(actions,['copy']);
  ui.menu.updateEditState(editable);ui.layout();
  const enabledCursor=cursorFor(ui,'quick:paste');
  for(const timestamp of [625,750,875,1000,1125])ui.menu.update(enabledCursor,timestamp);
  assert.deepEqual(actions,['copy','paste']);assert.equal(ui.menu.isOpen(),false);
  ui.menu.open({targets,editState:editable});ui.layout();ui.click('category:edit');
  ui.click('action:cut');assert.deepEqual(actions,['copy','paste','cut']);
});

test('equivalent edit state updates keep DOM and dwell, while real changes keep the current page', () => {
  const ui=fixture();ui.menu.open({targets,editState:{...editable,reason:{copy:'A',paste:'B'}}});ui.layout();
  ui.click('category:tree');ui.click('nav:next');const title=ui.root.children[0].textContent;
  const button=ui.buttons().find(item=>item.dataset.menuKey==='quick:copy'),cursor=cursorFor(ui,'quick:copy');
  ui.menu.update(cursor,0);ui.menu.update(cursor,125);
  ui.menu.updateEditState({...editable,reason:{paste:'B',copy:'A'}});
  assert.equal(ui.buttons().find(item=>item.dataset.menuKey==='quick:copy'),button,'semantically identical data does not replace measured nodes');
  assert.equal(ui.menu.update(cursor,250).progress,.5);
  ui.menu.updateEditState({...editable,clipboardLabel:'新副本'});ui.layout();
  assert.equal(ui.root.children[0].textContent,title);
  const replacement=ui.buttons().find(item=>item.dataset.menuKey==='quick:copy');assert.notEqual(replacement,button);
  assert.equal(replacement.dataset.dwell,'0');assert.equal(ui.menu.update(cursor,375).progress,0);
});

test('editing summary renders labels as literal text and contains no clipboard payload', () => {
  const label='<img src=x onerror=alert(1)>',ui=fixture();ui.menu.open({targets,editState:{...editable,selectedLabel:label,clipboardLabel:'<svg onload=alert(2)>'}});ui.layout();
  const summary=ui.root.children.find(child=>child.className==='gesture-edit-summary');
  assert.ok(summary);assert.equal(summary.children[0].textContent,`选中：${label}`);
  assert.equal(summary.children[1].textContent,'剪贴板：<svg onload=alert(2)>');
  const shortcuts=ui.root.children.find(child=>child.className==='gesture-edit-shortcuts');
  assert.equal(shortcuts.attributes.role,'group');assert.equal(shortcuts.attributes['aria-label'],'编辑选中对象');
  assert.deepEqual(shortcuts.children.map(button=>button.dataset.menuKey),['quick:copy','quick:paste','quick:delete']);
});
