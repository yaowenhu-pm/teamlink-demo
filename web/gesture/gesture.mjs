import {SCENE_LIMITS, createScene, updateScene, sceneChanges, moveSceneObject} from '../scene-model.mjs';
import {mountLandscape} from '../scene-renderer.mjs';
import {mountLandscapeMusic} from '../music.mjs';
import {PinchTracker, GestureTargetTracker, SelectorGestureTracker, ModeGestureTracker} from '../gesture-model.mjs?v=d83ab1d088a4';
import {buildGestureTargets, hitTestGestureTargets, applyTargetDrag, drawLeafTrailPatch} from '../gesture-targets.mjs?v=f8abf25eb931';
import {mountGestureDecor, dragDecorOffset} from '../gesture-decor.mjs?v=f4f5c63fdcf3';
import {mountGestureMenu} from '../gesture-menu.mjs?v=aabf30c5899b';
import {captureSceneObject, pasteSceneObject, deleteSceneObject} from '../gesture-edit.mjs?v=062c419d48e4';
import {mountGestureAppearance} from '../gesture-appearance.mjs?v=a354137a225c';

const $ = selector => document.querySelector(selector);
const stage = $('#gesture-stage'), video = $('#camera-video'), svg = $('#landscape');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const tracker = new PinchTracker(), selector = new SelectorGestureTracker(), modeTracker = new ModeGestureTracker(), targetTracker = new GestureTargetTracker();
let appearances=Object.freeze({}), clipboard=null, placement=null, future=[], commandTargetId=null, lastHandCursor=null;
let scene = createScene(), decorOffsets = Object.freeze({}), history = [], gestureBefore = null, pointerBefore = null;
let selectionMode = 'auto', lastManualId = null;
let labDefault = null, explicitId = null, activeTarget = null, grabStart = null, drawPoints = [], hoverId = null;
let lastTargets = [], targetsAt = -Infinity, menuReleaseAt = null, motionPlaying = !reduced, lastAssets = null;
let inputGeneration = 0, lastInputGeneration = -1, pointerSession = null;
let pointerHeld = false, pointerId = null, pageFocused = document.hasFocus(), selectedObject = null;
let stream = null, detector = null, frameId = null, epoch = 0, lastVideoTime = -1, lastInference = 0;
let loadController = null, motionTime = 0, leafPhase = 0, previousFrame = performance.now(), lastPaint = 0, cameraState = 'off';
const snapshot = () => ({scene, decorOffsets, leafPhase, appearances, selectionId:explicitId??commandTargetId??hoverId});
function restore(value) { if (value) { scene = value.scene; decorOffsets = value.decorOffsets; appearances=value.appearances??Object.freeze({}); if(Number.isFinite(value.leafPhase))leafPhase=value.leafPhase; targetsAt = -Infinity; } }
function formatHour(hour) {
  const minutes = Math.round((hour % 24) * 60);
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}
function status(message) { if ($('#gesture-status').textContent !== message) $('#gesture-status').textContent = message; }
function isObject(id) { return /^(tree|boat|mountain|bird):\d+$/u.test(id ?? ''); }
function render() {
  lastPaint = performance.now();
  const leafSelected = ['leaf','leafOrigin','leafTarget','draw:leaf'].includes(explicitId ?? hoverId);
  renderer.render(scene, {phase: leafPhase, motionTime, motionPlaying, selectedObject,
    showTrajectory: leafSelected, drawingTrajectory: explicitId === 'draw:leaf' && !gestureBefore});
  appearance.apply(appearances,renderer.getObjectPositions());
  if(appearances[selectedObject])svg.querySelector('[data-layer="selection"]').style.display='none';
  decor.apply(decorOffsets);
  svg.querySelectorAll('[data-edit-preview]').forEach(node=>node.removeAttribute('data-edit-preview'));
  if(placement)svg.querySelector(`[data-scene-object="${placement.id}"]`)?.setAttribute('data-edit-preview','');
  stage.classList.toggle('night', scene.hour < 6 || scene.hour >= 19.5);
  stage.dataset.hour = String(scene.hour); stage.dataset.selectionMode = selectionMode; stage.dataset.gestureTarget = explicitId ?? (selectionMode === 'manual' ? 'manual:none' : 'auto');
  stage.dataset.activeTarget = activeTarget?.id ?? hoverId ?? explicitId ?? '';
  stage.dataset.decorOffsets = JSON.stringify(decorOffsets);
  stage.dataset.historyCount = String(history.length);stage.dataset.redoCount=String(future.length);
  stage.dataset.objectCounts=JSON.stringify({trees:scene.trees,boats:scene.boats,mountains:scene.mountains,birds:scene.birds});
  stage.dataset.placement=placement?'preview':'';stage.dataset.clipboard=clipboard?.object.kind??'';stage.dataset.appearanceIds=JSON.stringify(Object.keys(appearances));
  stage.dataset.leafTrail = JSON.stringify(scene.leafTrail);
  const boat = renderer.getObjectPositions().find(item => item.id === 'boat:0')?.point;
  if (boat) { stage.dataset.boatX = String(boat.x); stage.dataset.boatY = String(boat.y); }
  $('#hour-label').textContent = formatHour(scene.hour);$('#hour-control').disabled=!!placement;
  if ($('#hour-control') !== document.activeElement) $('#hour-control').value = String(scene.hour);
  $('#undo-lab').disabled = !history.length&&!placement;$('#redo-lab').disabled=!future.length||!!placement;
  $('#placement-tip').hidden=!placement;if(menu.isOpen())menu.updateEditState(editState());
  const modeLabel=selectionMode==='manual'?'手动选择':'自动拾取';
  $('#target-mode').textContent=modeLabel;$('#selection-mode-label').textContent=modeLabel;
  $('#toggle-mode').setAttribute('aria-pressed',String(selectionMode==='manual'));
  $('#toggle-mode').setAttribute('aria-label',`${modeLabel}，切换到${selectionMode==='manual'?'自动拾取':'手动选择'}`);
  $('#current-target').textContent = activeTarget?.label ?? lastTargets.find(t => t.id === (explicitId ?? hoverId))?.label ?? (explicitId === 'draw:leaf' ? '捏合画线 · 松开保存' : selectionMode==='manual'?'请用 V 菜单选择对象':'抬手，靠近一个物体');
  updateHighlight();
}
function commit(before) {
  if (before && (sceneChanges(before.scene, scene).length || JSON.stringify(before.decorOffsets) !== JSON.stringify(decorOffsets) || before.appearances!==appearances)) {
    history.push(before);future=[]; if (history.length > 25) history.shift();
  }
  targetsAt = -Infinity; render();
}
function invalidatePointer() { inputGeneration++; lastInputGeneration = -1; pointerBefore = null; pointerSession = null; }
function cancelPointer() {
  restore(pointerBefore);pointerHeld=false;pointerId=null;invalidatePointer();renderer.cancelPathDraw();
}
function beginPointer(kind, id) {
  if (lastInputGeneration !== inputGeneration) return false;
  cancelGesture(); pointerBefore = snapshot(); pointerSession = {kind,id,generation:inputGeneration}; return true;
}
function acceptsPointer(kind,id) { return pointerSession?.generation === inputGeneration && pointerSession.kind === kind && pointerSession.id === id; }
function normalizedCursor(event) {
  const r = stage.getBoundingClientRect();
  return {x:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))};
}
function applyDrag(before,target,start,current) {
  appearances=before.appearances;
  if (target.operation === 'decor') decorOffsets = Object.freeze(Object.fromEntries(Object.entries(dragDecorOffset(before.decorOffsets,target.id,start,current)).filter(([,p])=>p.x!==0||p.y!==0)));
  else scene = updateScene(before.scene,applyTargetDrag(before.scene,target,start,current));
  targetsAt = -Infinity;
}
stage.addEventListener('pointerdown',event=>{
  if (!event.isPrimary || event.button !== 0 || !event.target.closest('#landscape,#hour-control')) return;
  if(placement&&event.target.closest('#landscape')){
    event.preventDefault();event.stopImmediatePropagation();placement.pointerId=event.pointerId;pointerHeld=true;pointerId=event.pointerId;previewPlacement(normalizedCursor(event));svg.setPointerCapture(event.pointerId);return;
  }
  cancelGesture(); pointerHeld = true; pointerId = event.pointerId; lastInputGeneration = inputGeneration;
  if (!event.target.closest('#landscape') || explicitId === 'draw:leaf') return;
  const start = normalizedCursor(event), target = hitTestGestureTargets(collectTargets(true),start,{explicitId,slop:.006});
  if (!target || (['object','hour','leafOrigin','leafTarget'].includes(target.operation) && !explicitId) || (target.operation === 'object' && event.target.closest('[data-scene-object]'))) return;
  // Lab-only layers and explicit parameter targets also keep a direct mouse path.
  event.preventDefault(); event.stopImmediatePropagation();
  if (!beginPointer('custom',target.id)) return;
  pointerSession.target = target; pointerSession.start = start;
  svg.setPointerCapture(event.pointerId);
},{capture:true});
window.addEventListener('pointermove',event=>{
  if(placement&&event.target.closest?.('#landscape')){previewPlacement(normalizedCursor(event));return;}
  if (event.pointerId !== pointerId || pointerSession?.kind !== 'custom' || !pointerBefore || pointerSession.generation !== inputGeneration) return;
  applyDrag(pointerBefore,pointerSession.target,pointerSession.start,normalizedCursor(event)); render();
},{capture:true});
window.addEventListener('pointerup',event=>{
  if (event.pointerId !== pointerId) return;
  if(placement?.pointerId===event.pointerId){finishPlacement(normalizedCursor(event));pointerHeld=false;pointerId=null;return;}
  if (pointerSession?.kind === 'custom' && pointerBefore && pointerSession.generation === inputGeneration) {
    applyDrag(pointerBefore,pointerSession.target,pointerSession.start,normalizedCursor(event));
    const before = pointerBefore; pointerBefore = null; pointerSession = null; commit(before);
  }
  pointerHeld = false; pointerId = null;
},{capture:true});
window.addEventListener('pointercancel',event=>{
  if (event.pointerId !== pointerId) return;
  if(placement)cancelPlacement('已取消未放置的副本。');
  restore(pointerBefore); pointerHeld = false; pointerId = null; invalidatePointer(); render();
},{capture:true});
window.addEventListener('lostpointercapture',event=>{
  if(event.pointerId!==pointerId)return;
  cancelPlacement('已取消未放置的副本。');restore(pointerBefore);pointerHeld=false;pointerId=null;invalidatePointer();render();
},{capture:true});
stage.addEventListener('keydown',event=>{
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key) && event.target.closest('#landscape,input[type=range]')) {
    if (pointerHeld) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    cancelGesture(); lastInputGeneration = inputGeneration;
  }
},{capture:true});
function cancelGesture(message = '') {
  restore(gestureBefore); gestureBefore = null; activeTarget = null; grabStart = null; drawPoints = [];
  tracker.cancel('cancelled'); selector.cancel(); modeTracker.cancel(); targetTracker.cancel(); hoverId = null;
  stage.classList.remove('gesture-grabbing'); $('#hand-cursor').hidden = true;
  clearHandFeedback();
  if (message) status(message);
  render();
}
const renderer = mountLandscape(svg, {
  onSunDrag(hour, phase) {
    if (phase === 'start' && !beginPointer('sun','sun')) return false;
    if (!acceptsPointer('sun','sun')) return false;
    selectedObject = null; scene = updateScene(scene, {hour}); render();
    if (phase === 'end') { const before = pointerBefore; pointerBefore = null; pointerSession = null; commit(before); }
  },
  onObjectSelect({id}) {
    if(pointerBefore)return;cancelPlacement();cancelGesture();selectionMode='manual';lastManualId=id;explicitId=id;selectedObject=id;menu.close();stage.classList.remove('menu-open');collectTargets(true);render();
  },
  onObjectDrag({id, point, phase}) {
    if (phase === 'start' && !beginPointer('object',id)) return false;
    if (!acceptsPointer('object',id)) return false;
    selectedObject = id; scene = updateScene(scene, moveSceneObject(pointerBefore?.scene ?? scene, id, point)); render();
    if (phase === 'end') { const before = pointerBefore; pointerBefore = null; pointerSession = null; commit(before); }
  },
  onLeafSelect() { if (!pointerBefore) setTarget('leaf'); },
  onTrajectoryDrag({handle,point,phase}) {
    if (!['origin','target'].includes(handle)) return;
    if (phase === 'start' && !beginPointer('trajectory',handle)) return false;
    if (!acceptsPointer('trajectory',handle)) return false;
    scene = updateScene(pointerBefore.scene,{[handle === 'origin' ? 'leafOrigin' : 'leafTarget']:point}); render();
    if (phase === 'end') { const before=pointerBefore;pointerBefore=null;pointerSession=null;commit(before); }
  },
  onPathDraw({points,phase}) {
    if (phase === 'start' && !beginPointer('draw','leaf')) return false;
    if (!acceptsPointer('draw','leaf')) return false;
    if (phase === 'cancel') { restore(pointerBefore); pointerBefore=null;pointerSession=null;render();return; }
    if (phase === 'end') {
      scene=updateScene(pointerBefore.scene,drawLeafTrailPatch(pointerBefore.scene,points));
      const before=pointerBefore;pointerBefore=null;pointerSession=null;leafPhase=0;commit(before);status('落叶路线已保存，可继续画下一条。');
    }
  }
});
const appearance=mountGestureAppearance(svg);
const decor = mountGestureDecor(svg), music = mountLandscapeMusic(stage);
const menu = mountGestureMenu($('#gesture-menu'), {onSelect:setTarget,onAction:menuAction,onModeChange:next=>setSelectionMode(next,{fromMenu:true})});
function updateCameraState(next) {
  cameraState = next; stage.dataset.cameraState = next;
  stage.classList.toggle('camera-running', next === 'tracking');
  stage.classList.toggle('loading', next === 'loading');
  stage.classList.toggle('camera-error', next === 'error');
  $('#start-camera').hidden = next === 'loading' || next === 'tracking';
  $('#stop-camera').hidden = next !== 'loading' && next !== 'tracking';
  $('#start-camera').innerHTML = next === 'error' ? '重新准备并开启 <span aria-hidden="true">↗</span>' : '开启摄像头 <span aria-hidden="true">↗</span>';
  $('#stop-camera').textContent = next === 'loading' ? '取消准备' : '关闭摄像头';
  $('#loading-progress').hidden = next !== 'loading';
}
function collectTargets(force = false) {
  const now = performance.now();
  if (!force && now-targetsAt < 100) return lastTargets;
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return lastTargets;
  const geometry = {};
  const rectOf = node => {
    if (!node || getComputedStyle(node).display === 'none') return null;
    const b = node.getBoundingClientRect();
    return b.width && b.height ? {bounds:{left:(b.left-r.left)/r.width,top:(b.top-r.top)/r.height,right:(b.right-r.left)/r.width,bottom:(b.bottom-r.top)/r.height}} : null;
  };
  svg.querySelectorAll('[data-scene-object]').forEach(node=>{const box=rectOf(node);if(box)geometry[node.dataset.sceneObject]=box;});
  geometry.sun = rectOf(svg.querySelector('[data-role="sun-control"]'));
  geometry.leaf = rectOf(svg.querySelector('[data-layer="leaf"]'));
  const path = svg.querySelector('[data-layer="trajectory"]'), rootMatrix = svg.getScreenCTM(), local = path?.transform.baseVal.consolidate()?.matrix;
  if (local && rootMatrix) {
    const m = rootMatrix.multiply(local);
    geometry.leafFrame = {x:(m.e-r.left)/r.width,y:(m.f-r.top)/r.height,scaleX:m.a*1600/r.width,scaleY:m.d*1000/r.height};
    for (const [id,key] of [['leafOrigin','leafOrigin'],['leafTarget','leafTarget']]) {
      const p=scene[key], f=geometry.leafFrame, x=f.x+p.x*f.scaleX,y=f.y+p.y*f.scaleY;
      geometry[id]={anchor:{x,y},bounds:{left:x-.018,top:y-.023,right:x+.018,bottom:y+.023}};
    }
  }
  // These broad regions are explicit-menu controls, never automatic hits.
  for (const id of ['branches','flowers','sky','water','wind','rain','clouds','count:trees','count:boats','count:mountains','count:birds']) {
    geometry[id]={anchor:{x:.5,y:id==='water'?.75:.3},bounds:{left:0,top:id==='water'?.5:0,right:1,bottom:id==='water'?1:.5}};
  }
  const targets=[...buildGestureTargets(scene,renderer.getObjectPositions(),geometry).map(target=>['leafOrigin','leafTarget'].includes(target.id)?{...target,requireExplicit:true}:target),...decor.getTargets()];
  lastTargets=targets; targetsAt=now; stage.dataset.targetCount=String(targets.length);
  if(appearances['tree:0']){const i=targets.findIndex(t=>t.id==='branches');if(i>=0)targets.splice(i,1);}
  if (menu.isOpen()) menu.updateTargets(targets);
  return targets;
}
function updateHighlight() {
  const box=$('#target-highlight'), id=activeTarget?.id ?? explicitId ?? hoverId;
  const target=lastTargets.find(item=>item.id===id);
  if (!target || menu.isOpen() || (target.requireExplicit && target.operation !== 'decor')) { box.hidden=true; return; }
  const b=target.bounds;
  box.hidden=false;box.style.left=b.left*100+'%';box.style.top=b.top*100+'%';box.style.width=(b.right-b.left)*100+'%';box.style.height=(b.bottom-b.top)*100+'%';
  box.querySelector('span').textContent=target.label;
}
function closeTargetMenu() {menu.close();stage.classList.remove('menu-open');menuReleaseAt=null;commandTargetId=null;}
function openTargetMenu(message='先张开手，再将光标停在按钮上选择。') {
  menu.open({targets:collectTargets(true),selectedId:explicitId??commandTargetId,scene,selectionMode,editState:editState()});
  stage.classList.add('menu-open');menuReleaseAt=null;status(message);render();
}
function availableTarget(id,targets) {return id==='draw:leaf'?scene.trees>0:targets.some(target=>target.id===id);}
function setSelectionMode(next,{fromMenu=false}={}) {
  if(placement)cancelPlacement();
  if(!['auto','manual'].includes(next)||cameraState==='loading'||gestureBefore||pointerBefore||pointerHeld)return;
  const targets=collectTargets(true),candidate=hoverId??commandTargetId;
  if(next===selectionMode){
    if(next==='manual'&&!explicitId&&!menu.isOpen())openTargetMenu('手动选择：请在菜单中选一个对象。');
    else if(next==='auto')closeTargetMenu();
    if(menu.isOpen())menu.updateMode(next,explicitId);render();return;
  }
  if(explicitId&&availableTarget(explicitId,targets))lastManualId=explicitId;
  const fixed=availableTarget(candidate,targets)?candidate:availableTarget(lastManualId,targets)?lastManualId:null;
  cancelPointer();cancelGesture();selectionMode=next;
  explicitId=next==='manual'?fixed:null;selectedObject=isObject(explicitId)?explicitId:null;
  if(explicitId)lastManualId=explicitId;
  if(next==='auto'){
    closeTargetMenu();status('已切到自动拾取：靠近哪个物体，就能捏合抓取哪个。');
  }else if(fromMenu&&menu.isOpen()){
    menu.updateMode(next,explicitId);menuReleaseAt=null;
    status(explicitId?'已切到手动选择，可以在菜单中更换固定对象。':'已切到手动选择，请在菜单中选一个对象。');
  }else if(explicitId){
    closeTargetMenu();status(`已切到手动选择：${targets.find(t=>t.id===explicitId)?.label??'落叶路线'}已固定，V 手势可换对象。`);
  }else if(menu.isOpen()){
    menu.updateMode(next,null);menuReleaseAt=null;status('已切到手动选择，请在菜单中选一个对象。');
  }else openTargetMenu('已切到手动选择，请在菜单中选一个对象。');
  render();
}
function toggleSelectionMode() {setSelectionMode(selectionMode==='auto'?'manual':'auto');}
function setTarget(id) {
  if(cameraState==='loading')return;
  if(id==='auto'){setSelectionMode('auto');return;}
  if(id==='manual'){setSelectionMode('manual',{fromMenu:menu.isOpen()});return;}
  cancelPlacement();cancelPointer();cancelGesture();selectionMode='manual';lastManualId=id;explicitId=id;
  selectedObject=isObject(explicitId)?explicitId:null;
  closeTargetMenu();collectTargets(true);render();
  status(`${lastTargets.find(t=>t.id===explicitId)?.label??'落叶路线'}已固定：${lastTargets.find(t=>t.id===explicitId)?.instruction??'捏合画线，松开保存。'} 三指保持可回到自动拾取。`);
}
function toggleMenu() {
  const wasOpen=menu.isOpen();cancelPlacement();const context=explicitId??hoverId;cancelPointer();cancelGesture();commandTargetId=context;
  if(wasOpen)closeTargetMenu();else openTargetMenu('先放下 V 手势，再将光标停在按钮上选择。');
}
const NATIVE_FIELDS={tree:'trees',boat:'boats',mountain:'mountains',bird:'birds'};
const NATIVE_LABELS={tree:'树',boat:'帆船',mountain:'山峰',bird:'飞鸟'};
function nativeExists(id,value=scene){const match=/^(tree|boat|mountain|bird):(\d+)$/u.exec(id??'');return !!match&&+match[2]<value[NATIVE_FIELDS[match[1]]];}
function objectLabel(id){const [kind,index]=String(id).split(':');return NATIVE_LABELS[kind]?`${NATIVE_LABELS[kind]} ${+index+1}`:lastTargets.find(t=>t.id===id)?.label??'';}
function editTarget(){return explicitId??commandTargetId??hoverId;}
function editState(){
  const id=editTarget(),editable=nativeExists(id),busy=!!placement||cameraState==='loading';
  const kind=clipboard?.object.kind,field=NATIVE_FIELDS[kind],canPaste=!!clipboard&&scene[field]<SCENE_LIMITS[field].max;
  const selectedLabel=objectLabel(id),unsupported=selectedLabel?'此项是环境或轨迹；请先选择树、山、船或鸟。':'请先在画布或 V 菜单中选择树、山、船或鸟。';
  const maxed=editable&&scene[NATIVE_FIELDS[id.split(':')[0]]]===SCENE_LIMITS[NATIVE_FIELDS[id.split(':')[0]]].max;
  return {selectedLabel,clipboardLabel:clipboard?objectLabel(clipboard.object.sourceId):'',canCopy:editable&&!busy,canCut:editable&&!busy,canDelete:editable&&!busy,canDuplicate:editable&&!maxed&&!busy,canPaste:canPaste&&!busy,canUndo:history.length>0||!!placement,canRedo:future.length>0&&!busy,
    reason:{copy:busy?'先放下或取消当前副本。':unsupported,cut:busy?'先放下或取消当前副本。':unsupported,delete:busy?'先放下或取消当前副本。':unsupported,duplicate:maxed?'这一类对象已达到数量上限。':unsupported,paste:!clipboard?'先复制一个风景对象。':!canPaste?'这一类对象已达到数量上限，可先删除一个。':'先放下或取消当前副本。',undo:'还没有可撤销的编辑。',redo:'还没有可重做的编辑。'}};
}
function captureAppearances(positions){
  const result={...appearances};for(const item of positions){if(item.point.x<0||item.point.x>1||item.point.y<0||item.point.y>1)continue;result[item.id]=appearances[item.id]??appearance.capture(item.id,item.point);}return Object.freeze(result);
}
function editedAppearances(captured,kind,remap=null,newId=null,newToken=null){
  const next={};
  for(const [id,token] of Object.entries(appearances)){const target=remap?remap[id]:id;if(target&&nativeExists(target))next[target]=token;}
  for(const [id,token] of Object.entries(captured)){const target=remap?remap[id]:id;if(!target||!nativeExists(target))continue;if(target!==id||(['boat','mountain'].includes(kind)&&id.startsWith(kind+':')))next[target]=token;}
  if(newId)next[newId]=newToken;
  return Object.freeze(next);
}
function flowerAnchors(){
  const r=svg.getBoundingClientRect();return Object.fromEntries(Array.from(svg.querySelectorAll('[data-gesture-decor^="decor:flower:"]')).map(node=>{const b=node.getBoundingClientRect();return [node.getAttribute('data-gesture-decor'),{x:(b.left+b.width/2-r.left)/r.width,y:(b.top+b.height/2-r.top)/r.height}];}));
}
function stabilizeFlowers(before){
  const current=flowerAnchors(),next={...decorOffsets};let changed=false;
  for(const [id,p] of Object.entries(before)){const n=current[id];if(!n)continue;const dx=p.x-n.x,dy=p.y-n.y;if(Math.abs(dx)<1e-5&&Math.abs(dy)<1e-5)continue;const old=next[id]??{x:0,y:0};next[id]=Object.freeze({x:Math.max(-1,Math.min(1,Math.round((old.x+dx)*1e6)/1e6)),y:Math.max(-1,Math.min(1,Math.round((old.y+dy)*1e6)/1e6))});changed=true;}
  if(changed){decorOffsets=Object.freeze(next);render();}
}
function copyForEdit(id,positions){return Object.freeze({object:captureSceneObject(scene,id,positions),appearance:appearances[id]??appearance.capture(id,positions.find(p=>p.id===id).point)});}
function setEditedSelection(id){selectionMode='manual';explicitId=id;lastManualId=id;selectedObject=isObject(id)?id:null;commandTargetId=null;hoverId=null;}
function performEdit(command){
  const id=editTarget(),state=editState(),flag={copy:'canCopy',cut:'canCut',paste:'canPaste',duplicate:'canDuplicate',delete:'canDelete'}[command];
  if(!flag||!state[flag]){status(state.reason[command]??'请先选择一个可编辑对象。');return;}
  cancelPointer();cancelGesture();closeTargetMenu();
  const before=snapshot(),positions=renderer.getObjectPositions(),inputBefore={selectionMode,explicitId,lastManualId,selectedObject},clipboardBefore=clipboard;before.selectionId=id;
  try{
    if(command==='copy'){clipboard=copyForEdit(id,positions);setEditedSelection(id);render();status(`已复制${objectLabel(id)}。选择“粘贴”，再捏合松开放下副本。`);return;}
    if(command==='paste'){beginPlacement();return;}
    const copied=command==='cut'||command==='duplicate'?copyForEdit(id,positions):null;
    const captured=captureAppearances(positions),flowers=flowerAnchors(),kind=id.split(':')[0];
    if(command==='duplicate'){
      const point={x:Math.min(1,copied.object.point.x+.06),y:Math.min(1,copied.object.point.y+.06)};
      const result=pasteSceneObject(scene,copied.object,point,positions);scene=result.scene;
      appearances=editedAppearances(captured,kind,null,result.id,copied.appearance);setEditedSelection(result.id);
    }else{
      const result=deleteSceneObject(scene,id,positions);scene=result.scene;appearances=editedAppearances(captured,kind,result.remap);
      if(command==='cut')clipboard=copied;
      setEditedSelection(null);
    }
    render();if(kind==='tree')stabilizeFlowers(flowers);commit(before);collectTargets(true);render();
    status(command==='duplicate'?'已复制一份，可继续移动或撤销。':command==='cut'?'已剪切到风景剪贴板，可以在新位置粘贴。':'已删除对象，可撤销恢复。');
  }catch(error){cancelPlacement();restore(before);({selectionMode,explicitId,lastManualId,selectedObject}=inputBefore);clipboard=clipboardBefore;render();status(error?.message??'本次编辑未完成。');}
}
function beginPlacement(){
  const before=snapshot(),positions=renderer.getObjectPositions(),captured=captureAppearances(positions),flowers=flowerAnchors();
  const point=lastHandCursor??{x:Math.min(.88,clipboard.object.point.x+.06),y:Math.min(.85,clipboard.object.point.y+.06)};
  const result=pasteSceneObject(scene,clipboard.object,point,positions);
  placement={before,positions,captured,clip:clipboard,id:result.id,held:false,point,flowers,decorOffsets:null,input:{selectionMode,explicitId,lastManualId,selectedObject}};
  scene=result.scene;appearances=editedAppearances(captured,clipboard.object.kind,null,result.id,clipboard.appearance);setEditedSelection(result.id);
  render();if(clipboard.object.kind==='tree')stabilizeFlowers(flowers);placement.decorOffsets=decorOffsets;collectTargets(true);render();
  status('粘贴预览：移动手掌定位，捏合后松开放下。也可按住鼠标拖放；Esc 取消。');
}
function previewPlacement(point){
  if(!placement||!point)return;
  const result=pasteSceneObject(placement.before.scene,placement.clip.object,point,placement.positions);
  scene=result.scene;placement.point={...point};decorOffsets=placement.decorOffsets;render();
}
function finishPlacement(point){
  if(!placement)return;previewPlacement(point);const before=placement.before,id=placement.id;placement=null;stage.classList.remove('gesture-grabbing');
  tracker.cancel('placed');selector.cancel();modeTracker.cancel();setEditedSelection(id);commit(before);collectTargets(true);render();status('副本已放下。V 菜单可继续粘贴、复制或删除。');
}
function cancelPlacement(message=''){
  if(!placement)return false;const old=placement,before=old.before,capturedPointer=old.pointerId;placement=null;pointerHeld=false;pointerId=null;
  if(capturedPointer!=null&&svg.hasPointerCapture?.(capturedPointer))svg.releasePointerCapture(capturedPointer);restore(before);stage.classList.remove('gesture-grabbing');
  tracker.cancel('cancelled');selector.cancel();modeTracker.cancel();targetTracker.cancel();
  ({selectionMode,explicitId,lastManualId,selectedObject}=old.input);commandTargetId=null;hoverId=null;render();if(message)status(message);return true;
}
function menuAction(id) {
  if(['copy','cut','paste','duplicate','delete'].includes(id)){performEdit(id);return;}
  cancelPointer();closeTargetMenu();
  if (id==='draw:leaf') {if (!scene.trees) {status('先增加一棵树，就可以画落叶路线。');return;}setTarget('draw:leaf');}
  else if(id==='redo')redo();else if (id==='undo') undo(); else if (id==='reset') reset();
  else if (id==='motion') {cancelGesture();motionPlaying=!motionPlaying;render();status(motionPlaying?'风景继续流动。':'风景已暂停，可以慢慢调整。');}
  else if (id==='music') {stage.querySelector('.music-toggle').click();}
  else if (id==='immersive') {cancelGesture();stage.classList.toggle('immersive');status(stage.classList.contains('immersive')?'已进入沉浸画布。V 手势仍可打开菜单。':'已退出沉浸画布。');}
  else cancelGesture();
}
function moveGesture(cursor) {
  if (activeTarget.id==='draw:leaf') {
    if (!drawPoints.length || Math.hypot(cursor.x-drawPoints.at(-1).x,cursor.y-drawPoints.at(-1).y)>.003) drawPoints.push({...cursor});
    if (drawPoints.length>512) drawPoints=drawPoints.filter((_,i)=>i%2===0);
    scene=updateScene(gestureBefore.scene,drawLeafTrailPatch(gestureBefore.scene,drawPoints));leafPhase=1;
  } else applyDrag(gestureBefore,activeTarget,grabStart,cursor);
  render();
}
function loadingProgress(progress) {
  const {phase, loaded, total, cacheLoaded = 0, fetchLoaded = 0} = progress;
  lastAssets = progress;
  const meter = $('#loading-meter'), detail = $('#loading-detail');
  if (phase === 'download' || phase === 'checking-cache') {
    const percent = total ? Math.min(100, Math.floor(loaded / total * 100)) : 0;
    meter.value = percent;
    detail.textContent = phase === 'checking-cache' ? cacheLoaded ? `读取本机缓存 ${percent}%` : '检查本机缓存…' : `准备识别文件 ${percent}%`;
    $('#asset-cache-state').textContent = cacheLoaded ? '已读取本机缓存' : fetchLoaded ? '正在读取识别文件' : '检查本机缓存';
    status('正在准备手部识别，完成后再开启摄像头。');
  } else {
    meter.removeAttribute('value');
    detail.textContent = phase === 'waiting' ? '等待上一次准备结束…' : phase === 'ready' ? '识别已准备好' : '文件已就绪，正在初始化识别…';
    status(phase === 'waiting' ? '等待上一次识别准备结束，请稍候。' : '文件已就绪，正在启动手部识别。');
    if (phase === 'initializing' || phase === 'ready') {
      $('#asset-cache-state').textContent = total && cacheLoaded === total ? '本机缓存已命中' : '识别文件已就绪';
      status('文件已就绪，正在启动手部识别。');
    }
  }
}
const handOverlay = $('#hand-overlay'), handNS = 'http://www.w3.org/2000/svg';
const handWire = document.createElementNS(handNS, 'path');
handWire.setAttribute('fill','none'); handWire.setAttribute('vector-effect','non-scaling-stroke');
const handDots = Array.from({length:21}, (_,index) => {
  const dot = document.createElementNS(handNS,'circle'); dot.dataset.tip = String(index === 4 || index === 8); return dot;
});
handOverlay.replaceChildren(handWire, ...handDots);
const handEdges = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
function clearHandFeedback() {
  handOverlay.setAttribute('hidden',''); $('#pinch-feedback').value = 0;$('#mode-progress').value=0;$('#selector-progress').value=0;$('#mode-hint').textContent='三指切模式';$('#selector-hint').textContent='V 选对象'; $('#hand-feedback-label').textContent = '等待手掌';
}
function handFeedback(hand, frame) {
  if (!frame.cursor || !hand || hand.length !== 21) {
    clearHandFeedback(); $('#hand-feedback-label').textContent = frame.reason === 'multiple-hands' ? '请只留一只手' : '等待手掌'; return;
  }
  const width = video.videoWidth, height = video.videoHeight;
  handOverlay.setAttribute('viewBox', `0 0 ${width} ${height}`); handOverlay.removeAttribute('hidden');
  handWire.setAttribute('d',handEdges.map(([a,b])=>`M${hand[a].x*width} ${hand[a].y*height}L${hand[b].x*width} ${hand[b].y*height}`).join(''));
  handDots.forEach((dot,index) => { dot.setAttribute('cx',String(hand[index].x*width)); dot.setAttribute('cy',String(hand[index].y*height)); dot.setAttribute('r',String(width*.01)); });
  $('#pinch-feedback').value = frame.pinchProgress ?? 0;
  $('#hand-feedback-label').textContent = frame.pinching ? '已握住 · 松开确认' : frame.ready ? '张开 · 可以捏合' : '请先张开拇指和食指';
  $('#hand-cursor').firstElementChild.style.transform = `scale(${1+(frame.pinchProgress??0)*1.6})`;
}
function waitForPreparation(promise, signal, timeoutMs = 30000, timeoutName = 'TimeoutError') {
  return new Promise((resolve, reject) => {
    const abort = () => finish(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new DOMException('Preparation timed out', timeoutName)), timeoutMs);
    function finish(error, value) { clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value); }
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
    if (signal.aborted) abort();
  });
}
function handleFrame(result, now) {
  const input={hands:result.landmarks??[],timestampMs:now,width:video.videoWidth,height:video.videoHeight,
    confidence:result.handedness?.[0]?.[0]?.score??1,handId:result.handedness?.[0]?.[0]?.categoryName??'single'};
  const frame=tracker.update(input), mode=modeTracker.update({...input,pinching:frame.pinching});
  const select=mode.pose?selector.cancel('mode-pose'):selector.update({...input,pinching:frame.pinching});
  stage.dataset.handPhase=frame.phase;stage.dataset.selectorPhase=select.phase;stage.dataset.modeGesturePhase=mode.phase;
  handFeedback(result.landmarks?.[0],frame);
  const cursor=$('#hand-cursor');cursor.hidden=!frame.cursor;
  if(frame.cursor)lastHandCursor={...frame.cursor};
  if (frame.cursor) {cursor.style.left=frame.cursor.x*100+'%';cursor.style.top=frame.cursor.y*100+'%';}
  $('#mode-progress').value=mode.progress;$('#mode-hint').textContent=mode.pose?'保持三指 · 切换模式':'三指切模式';
  $('#selector-progress').value=select.progress; $('#selector-hint').textContent=select.pose ? '保持 V · 打开对象菜单' : 'V 手势选对象';
  if(mode.triggered&&!gestureBefore&&!pointerHeld&&!pointerBefore){toggleSelectionMode();return;}
  if (select.triggered && !gestureBefore) {toggleMenu();return;}
  if (menu.isOpen()) {
    if (!frame.cursor || select.pose || mode.pose || frame.pinching || !frame.ready) menuReleaseAt=null;
    else if (menuReleaseAt===null) menuReleaseAt=now;
    const r=stage.getBoundingClientRect();
    menu.update(frame.cursor?{x:r.left+frame.cursor.x*r.width,y:r.top+frame.cursor.y*r.height}:null,now,
      {enabled:menuReleaseAt!==null&&now-menuReleaseAt>=160});
    return;
  }
  if(placement){
    if(frame.phase==='cancel'||frame.phase==='lost'){cancelPlacement('手掌丢失，已取消未放置的副本。');return;}
    if(select.pose||mode.pose)return;
    if(frame.cursor)previewPlacement(frame.cursor);
    if(frame.phase==='start'){placement.held=true;stage.classList.add('gesture-grabbing');}
    if(frame.phase==='end'&&placement?.held)finishPlacement(frame.cursor);
    return;
  }
  if (frame.phase==='cancel'||frame.phase==='lost') {
    restore(gestureBefore);gestureBefore=null;activeTarget=null;grabStart=null;drawPoints=[];targetTracker.cancel();hoverId=null;
    stage.classList.remove('gesture-grabbing');render();
    status(frame.reason==='multiple-hands'?'镜头里留一只手，就可以继续玩。':'先张开一只手，再捏合。');return;
  }
  if(mode.pose&&!gestureBefore){status(`保持三指，切换到${selectionMode==='auto'?'手动选择':'自动拾取'}。`);return;}
  if (select.pose && !gestureBefore) {status('保持 V 手势，选择图中的更多内容。');return;}
  const targets=collectTargets();
  const bounds=stage.getBoundingClientRect();
  const overUI=frame.cursor&&document.elementFromPoint(bounds.left+frame.cursor.x*bounds.width,bounds.top+frame.cursor.y*bounds.height)?.closest('.experiment-panel,.lab-header,.camera-preview,.gesture-legend,#exit-immersive');
  const hit=(selectionMode==='manual'&&!explicitId)||(selectionMode==='auto'&&overUI)?null:explicitId==='draw:leaf'?{id:'draw:leaf',label:'落叶路线',operation:'draw'}:hitTestGestureTargets(targets,frame.cursor,{explicitId,slop:.009});
  // An empty automatic hit must never grab a previously hovered object elsewhere.
  if (frame.phase==='start'&&!hit) targetTracker.cancel();
  const selection=targetTracker.update({timestampMs:now,targetId:hit?.id??null,phase:frame.phase});
  hoverId=selectionMode==='auto'?(hit?.id===selection.targetId?hit.id:null):selection.targetId;
  if (frame.phase==='start') {
    const chosen=selection.targetId==='draw:leaf'?hit:targets.find(t=>t.id===selection.targetId);
    if (!chosen) {status('靠近一个物体再捏合，或比 V 选择对象。');render();return;}
    gestureBefore=snapshot();activeTarget=chosen;grabStart={...frame.cursor};drawPoints=[{...frame.cursor}];
    selectedObject=isObject(chosen.id)?chosen.id:null;stage.classList.add('gesture-grabbing');render();
  }
  if ((frame.phase==='move'||frame.phase==='end')&&gestureBefore) moveGesture(frame.cursor);
  if (frame.phase==='end'&&gestureBefore) {
    const before=gestureBefore,label=activeTarget.label,wasDraw=activeTarget.id==='draw:leaf';
    gestureBefore=null;activeTarget=null;grabStart=null;drawPoints=[];stage.classList.remove('gesture-grabbing');if(wasDraw)leafPhase=0;commit(before);
    status(wasDraw?'新落叶路线已保存。再画一条，会立即替换。':`${label}已保存。V 手势可以换一个对象。`);
  } else if (gestureBefore) status(activeTarget.id==='draw:leaf'?'捏合画出落叶路线，松开保存。':'握住了，移动调整；松开保存。');
  else status(frame.ready?(hit?`${hit.label}：捏合抓取。V 手势可切换对象。`:'抬手靠近物体，或比 V 选择对象。'):'先张开拇指和食指，再捏合。');
  render();
}
function inferenceFrame(session) {
  frameId = requestAnimationFrame(() => {
    if (session !== epoch || !detector || cameraState !== 'tracking') return;
    const now = performance.now();
    if((gestureBefore||(placement&&!pointerHeld&&pageFocused))&&now-lastInference>tracker.options.maxGapMs){if(placement)cancelPlacement('镜头暂时没有新画面，已取消粘贴预览。');else cancelGesture('镜头暂时没有新画面，已取消抓取。张开手后重试。');}
    if (pageFocused && !pointerHeld && !pointerBefore && video.readyState >= 2 && video.currentTime !== lastVideoTime && now - lastInference >= 55) {
      lastVideoTime = video.currentTime; lastInference = now;
      try { handleFrame(detector.detectForVideo(video, now), now); }
      catch { stopCamera('识别暂时中断了，重新开启试试。', 'error'); return; }
    }
    inferenceFrame(session);
  });
}
function stopCamera(message = '摄像头已关闭。你仍可直接拖动风景。', state = 'off') {
  epoch++; if (frameId !== null) cancelAnimationFrame(frameId); frameId = null;
  loadController?.abort(); loadController = null;
  cancelPlacement();closeTargetMenu();cancelPointer();cancelGesture();
  const activeDetector = detector; detector = null; try { activeDetector?.close(); } catch {}
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.pause(); video.srcObject = null; $('#camera-preview').hidden = true;
  updateCameraState(state); status(message);
}
function cameraError(error) {
  if (error?.name === 'CameraTimeoutError') return '摄像头没有返回画面，已关闭。请确认设备可用后重新开启。';
  if (error?.name === 'TimeoutError') return '识别准备超时，已停止等待。请检查网络并刷新页面后重试，也可以直接拖动风景。';
  if (error?.name === 'AssetIntegrityError') return '识别文件校验未通过，已停止使用。请刷新页面后重试。';
  if (error?.name === 'AssetSizeError') return '识别文件下载不完整，请重新准备；也可以直接拖动风景。';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return '未获得摄像头权限。允许后可重试，也能直接拖动风景。';
  if (error?.name === 'NotFoundError') return '没有找到摄像头。你仍可用鼠标或滑杆玩这个实验。';
  if (error?.name === 'NotReadableError') return '摄像头暂时无法使用，可能正在被其他应用占用。';
  return '摄像头或识别文件未能加载，请检查连接后重试。';
}
async function startCamera() {
  if (cameraState === 'loading' || cameraState === 'tracking') return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { updateCameraState('error'); status('当前浏览器不支持摄像头实验，请使用 HTTPS 下的 Chrome、Edge 或 Safari。'); return; }
  const session = ++epoch, controller = new AbortController(); loadController = controller;
  updateCameraState('loading'); loadingProgress({phase:'download', loaded:0, total:1}); music.activate();
  $('#camera-note').textContent = '优先读取本机缓存；首次可能下载约 10 MB。文件准备好后仍需初始化识别，然后才请求相机权限。';
  let pendingStream = null, pendingDetector = null;
  try {
    const {createHandLandmarker} = await waitForPreparation(import('../vendor/hand-vision/loader.mjs?v=d84acb664ca0'), controller.signal);
    if (session !== epoch) return;
    pendingDetector = await createHandLandmarker({numHands: 2}, {signal:controller.signal, onProgress:progress => { if (session === epoch) loadingProgress(progress); }});
    if (session !== epoch) { pendingDetector.close(); return; }
    detector = pendingDetector; pendingDetector = null;
    status('识别已准备好，请在浏览器里允许使用摄像头。');
    $('#loading-detail').textContent = '等待摄像头权限…';
    pendingStream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'user', width: {ideal: 640}, height: {ideal: 480}, frameRate: {ideal: 24, max: 30}}, audio: false});
    if (session !== epoch) { pendingStream.getTracks().forEach(track => track.stop()); return; }
    stream = pendingStream;
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') throw new DOMException('Camera has ended', 'NotReadableError');
    track.addEventListener('ended', () => { if (session === epoch) stopCamera('摄像头连接已结束，可以重新开启。'); }, {once: true});
    video.srcObject = stream; $('#camera-preview').hidden = false; $('#stop-camera').textContent = '关闭摄像头';
    await waitForPreparation(video.play(), controller.signal, 10000, 'CameraTimeoutError');
    if (session !== epoch) return;
    loadController = null; tracker.cancel('start'); selector.cancel();modeTracker.cancel(); targetTracker.cancel(); lastVideoTime = -1; lastInference = 0;
    updateCameraState('tracking'); status('先张开一只手，再捏合。');
    $('#camera-note').textContent = (lastAssets?.total && lastAssets.cacheLoaded === lastAssets.total ? '本次读取本机缓存，没有重新下载模型。' : '识别文件已准备好，之后可复用浏览器缓存。') + ' V 菜单可选择、复制、粘贴和删除；三指（食／中／无名）切模式。松开保存，丢手取消，画面不上传。';
    inferenceFrame(session);
  } catch (error) {
    if (session !== epoch) { pendingStream?.getTracks().forEach(track => track.stop()); try { pendingDetector?.close(); } catch {} return; }
    stopCamera(cameraError(error), 'error');
  }
}
function reset() {
  cancelPlacement();cancelPointer();cancelGesture();const before=snapshot();
  scene=labDefault??createScene();decorOffsets=Object.freeze({});appearances=Object.freeze({});clipboard=null;commandTargetId=null;selectedObject=null;explicitId=null;selectionMode='auto';lastManualId=null;
  motionTime=0;leafPhase=0;motionPlaying=!reduced;menu.close();stage.classList.remove('menu-open');commit(before);collectTargets(true);render();
  status('已恢复初始风景。抬手靠近物体，或比 V 切换对象。');
}
function restoreSelection(saved) {
  render();collectTargets(true);
  if(selectionMode==='manual'){
    explicitId=availableTarget(saved.selectionId,lastTargets)?saved.selectionId:null;
    selectedObject=isObject(explicitId)?explicitId:null;
    if(explicitId)lastManualId=explicitId;
  }else{explicitId=null;selectedObject=null;}
  commandTargetId=null;render();
}
function undo() {
  if(placement){cancelPlacement('已取消粘贴预览。');return;}
  cancelPointer();cancelGesture();const previous=history.pop();
  if(previous){future.push(snapshot());restore(previous);restoreSelection(previous);status('已撤销上一次编辑。');}else status('还没有需要撤销的编辑。');
}
function redo() {
  if(placement){status('先放下或取消当前副本。');return;}
  cancelPointer();cancelGesture();const next=future.pop();
  if(next){history.push(snapshot());restore(next);restoreSelection(next);status('已重做上一次编辑。');}else status('还没有需要重做的编辑。');
}
async function fullscreen() {
  try { if(document.fullscreenElement)await document.exitFullscreen();else await stage.requestFullscreen({navigationUI:'hide'}); }
  catch {status('当前浏览器未允许全屏，可以用菜单里的沉浸画布。');}
}
$('#start-camera').addEventListener('click',startCamera);
$('#stop-camera').addEventListener('click',()=>{menu.close();stage.classList.remove('menu-open');stopCamera();});
$('#reset-lab').addEventListener('click',reset);$('#undo-lab').addEventListener('click',undo);$('#redo-lab').addEventListener('click',redo);
$('#fullscreen-lab').addEventListener('click',fullscreen);$('#open-targets').addEventListener('click',toggleMenu);
$('#auto-target').addEventListener('click',()=>setTarget('auto'));
$('#toggle-mode').addEventListener('click',toggleSelectionMode);
$('#exit-immersive').addEventListener('click',()=>{stage.classList.remove('immersive');status('已退出沉浸画布。');});
$('#hour-control').addEventListener('input',event=>{
  if(placement)return;
  if(lastInputGeneration!==inputGeneration)return;
  if(!pointerBefore&&!beginPointer('range','hour'))return;
  if(!acceptsPointer('range','hour'))return;
  scene=updateScene(scene,{hour:Number(event.target.value)});render();
});
$('#hour-control').addEventListener('change',()=>{if(placement)return;if(!acceptsPointer('range','hour'))return;const before=pointerBefore;pointerBefore=null;pointerSession=null;commit(before);});
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.target.closest('input,textarea,select,[contenteditable]')||event.repeat||event.isComposing||event.keyCode===229)return;
  const key=event.key.toLowerCase();
  if((event.metaKey||event.ctrlKey)&&!event.altKey){
    if(key==='z'){event.preventDefault();event.shiftKey?redo():undo();}
    else if(key==='y'){event.preventDefault();redo();}
    else if(!event.shiftKey&&!window.getSelection()?.toString()&&['c','x','v','d'].includes(key)){const command={c:'copy',x:'cut',v:'paste',d:'duplicate'}[key];if(placement||nativeExists(editTarget())||(command==='paste'&&clipboard)){event.preventDefault();performEdit(command);}}
  }
  else if(!event.metaKey&&!event.ctrlKey&&!event.altKey){
    if((key==='delete'||key==='backspace')&&editState().canDelete){event.preventDefault();performEdit('delete');}else if(key==='t')toggleSelectionMode();else if(key==='r')reset();else if(key==='m')stage.querySelector('.music-toggle').click();else if(key==='f')fullscreen();
    else if(key==='v')toggleMenu();else if(key==='a')setTarget('auto');else if(key==='l')menuAction('draw:leaf');else if(key===' '&&!event.target.closest('button,a,summary,[role=button],[role=slider]')) {event.preventDefault();menuAction('motion');}
    else if(key==='escape'){if(placement){cancelPlacement('已取消粘贴预览。');return;}closeTargetMenu();stage.classList.remove('immersive');cancelPointer();cancelGesture('已取消调整。');}
  }
});
document.addEventListener('visibilitychange',()=>{previousFrame=performance.now();if(document.hidden&&['loading','tracking'].includes(cameraState))stopCamera('已离开实验页，摄像头已关闭。');});
window.addEventListener('blur',()=>{
  pageFocused=false;cancelPlacement();cancelPointer();menu.resetDwell();menuReleaseAt=null;
  cancelGesture(cameraState==='tracking'?'已暂停手势。返回页面、张开手后继续。':'');
});
window.addEventListener('focus',()=>{pageFocused=true;});
window.addEventListener('pagehide',()=>stopCamera());
window.addEventListener('resize',()=>{targetsAt=-Infinity;render();});
function animate(now){
  const delta=Math.min((now-previousFrame)/1000,.1);previousFrame=now;
  if(motionPlaying&&!gestureBefore&&!placement&&!document.hidden&&cameraState!=='loading'){
    motionTime+=delta;leafPhase=(leafPhase+delta/7)%1;
    if(now-lastPaint>=33)render();
  }
  requestAnimationFrame(animate);
}
updateCameraState('off');render();collectTargets(true);render();
const initialBoat=renderer.getObjectPositions().find(item=>item.id==='boat:0')?.point;
const initialBounds=stage.getBoundingClientRect(),panelTop=$('.experiment-panel').getBoundingClientRect().top;
if(initialBoat&&initialBounds.height>0){
  const visibleY=Math.max(.5,Math.min(initialBoat.y,(panelTop-initialBounds.top-48)/initialBounds.height));
  labDefault=updateScene(scene,moveSceneObject(scene,'boat:0',{x:initialBoat.x,y:visibleY}));scene=labDefault;render();
}else labDefault=scene;
requestAnimationFrame(animate);
