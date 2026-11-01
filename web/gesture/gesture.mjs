import {createScene, updateScene, sceneChanges, moveSceneObject} from '../scene-model.mjs';
import {mountLandscape} from '../scene-renderer.mjs';
import {mountLandscapeMusic} from '../music.mjs';
import {PinchTracker, GestureTargetTracker, SelectorGestureTracker} from '../gesture-model.mjs?v=a7086b54c0c6';
import {buildGestureTargets, hitTestGestureTargets, applyTargetDrag, drawLeafTrailPatch} from '../gesture-targets.mjs?v=f8abf25eb931';
import {mountGestureDecor, dragDecorOffset} from '../gesture-decor.mjs?v=f4f5c63fdcf3';
import {mountGestureMenu} from '../gesture-menu.mjs?v=dc1f6a9279db';

const $ = selector => document.querySelector(selector);
const stage = $('#gesture-stage'), video = $('#camera-video'), svg = $('#landscape');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const tracker = new PinchTracker(), selector = new SelectorGestureTracker(), targetTracker = new GestureTargetTracker();
let scene = createScene(), decorOffsets = Object.freeze({}), history = [], gestureBefore = null, pointerBefore = null;
let labDefault = null, explicitId = null, activeTarget = null, grabStart = null, drawPoints = [], hoverId = null;
let lastTargets = [], targetsAt = -Infinity, menuReleaseAt = null, motionPlaying = !reduced, lastAssets = null;
let inputGeneration = 0, lastInputGeneration = -1, pointerSession = null;
let pointerHeld = false, pointerId = null, pageFocused = document.hasFocus(), selectedObject = null;
let stream = null, detector = null, frameId = null, epoch = 0, lastVideoTime = -1, lastInference = 0;
let loadController = null, motionTime = 0, leafPhase = 0, previousFrame = performance.now(), lastPaint = 0, cameraState = 'off';
const snapshot = () => ({scene, decorOffsets});
function restore(value) { if (value) { scene = value.scene; decorOffsets = value.decorOffsets; targetsAt = -Infinity; } }
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
  decor.apply(decorOffsets);
  stage.classList.toggle('night', scene.hour < 6 || scene.hour >= 19.5);
  stage.dataset.hour = String(scene.hour); stage.dataset.gestureTarget = explicitId ?? 'auto';
  stage.dataset.activeTarget = activeTarget?.id ?? hoverId ?? explicitId ?? '';
  stage.dataset.decorOffsets = JSON.stringify(decorOffsets);
  stage.dataset.historyCount = String(history.length);
  stage.dataset.leafTrail = JSON.stringify(scene.leafTrail);
  const boat = renderer.getObjectPositions().find(item => item.id === 'boat:0')?.point;
  if (boat) { stage.dataset.boatX = String(boat.x); stage.dataset.boatY = String(boat.y); }
  $('#hour-label').textContent = formatHour(scene.hour);
  if ($('#hour-control') !== document.activeElement) $('#hour-control').value = String(scene.hour);
  $('#undo-lab').disabled = !history.length;
  $('#target-mode').textContent = explicitId === 'draw:leaf' ? '画落叶路线' : explicitId ? '固定对象' : '自动拾取';
  $('#current-target').textContent = activeTarget?.label ?? lastTargets.find(t => t.id === (explicitId ?? hoverId))?.label ?? (explicitId === 'draw:leaf' ? '捏合画线 · 松开保存' : '抬手，靠近一个物体');
  updateHighlight();
}
function commit(before) {
  if (before && (sceneChanges(before.scene, scene).length || JSON.stringify(before.decorOffsets) !== JSON.stringify(decorOffsets))) {
    history.push(before); if (history.length > 25) history.shift();
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
  if (target.operation === 'decor') decorOffsets = Object.freeze(Object.fromEntries(Object.entries(dragDecorOffset(before.decorOffsets,target.id,start,current)).filter(([,p])=>p.x!==0||p.y!==0)));
  else scene = updateScene(before.scene,applyTargetDrag(before.scene,target,start,current));
  targetsAt = -Infinity;
}
stage.addEventListener('pointerdown',event=>{
  if (!event.isPrimary || event.button !== 0 || !event.target.closest('#landscape,#hour-control')) return;
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
  if (event.pointerId !== pointerId || pointerSession?.kind !== 'custom' || !pointerBefore || pointerSession.generation !== inputGeneration) return;
  applyDrag(pointerBefore,pointerSession.target,pointerSession.start,normalizedCursor(event)); render();
},{capture:true});
window.addEventListener('pointerup',event=>{
  if (event.pointerId !== pointerId) return;
  if (pointerSession?.kind === 'custom' && pointerBefore && pointerSession.generation === inputGeneration) {
    applyDrag(pointerBefore,pointerSession.target,pointerSession.start,normalizedCursor(event));
    const before = pointerBefore; pointerBefore = null; pointerSession = null; commit(before);
  }
  pointerHeld = false; pointerId = null;
},{capture:true});
window.addEventListener('pointercancel',event=>{
  if (event.pointerId !== pointerId) return;
  restore(pointerBefore); pointerHeld = false; pointerId = null; invalidatePointer(); render();
},{capture:true});
stage.addEventListener('keydown',event=>{
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key) && event.target.closest('#landscape,input[type=range]')) {
    if (pointerHeld) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    cancelGesture(); lastInputGeneration = inputGeneration;
  }
},{capture:true});
function cancelGesture(message = '') {
  restore(gestureBefore); gestureBefore = null; activeTarget = null; grabStart = null; drawPoints = [];
  tracker.cancel('cancelled'); selector.cancel(); targetTracker.cancel(); hoverId = null;
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
    if(pointerBefore)return;cancelGesture();explicitId=id;selectedObject=id;menu.close();stage.classList.remove('menu-open');collectTargets(true);render();
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
const decor = mountGestureDecor(svg), music = mountLandscapeMusic(stage);
const menu = mountGestureMenu($('#gesture-menu'), {onSelect:setTarget,onAction:menuAction});
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
function setTarget(id) {
  if (cameraState === 'loading') return;
  cancelPointer();cancelGesture(); explicitId=id==='auto'?null:id;
  selectedObject=isObject(explicitId)?explicitId:null;
  menu.close();stage.classList.remove('menu-open');menuReleaseAt=null;collectTargets(true);render();
  status(explicitId ? `${lastTargets.find(t=>t.id===explicitId)?.label ?? '落叶路线'}：${lastTargets.find(t=>t.id===explicitId)?.instruction ?? '捏合画线，松开保存。'}` : '自动拾取：抬手靠近物体，捏合抓取。V 手势可以选更多内容。');
}
function toggleMenu() {
  const wasOpen=menu.isOpen();cancelPointer();cancelGesture();
  if (wasOpen) {menu.close();stage.classList.remove('menu-open');}
  else {menu.open({targets:collectTargets(true),selectedId:explicitId,scene});stage.classList.add('menu-open');menuReleaseAt=null;status('先放下 V 手势，再将光标停在按钮上选择。');}
}
function menuAction(id) {
  cancelPointer();menu.close();stage.classList.remove('menu-open');menuReleaseAt=null;
  if (id==='draw:leaf') {if (!scene.trees) {status('先增加一棵树，就可以画落叶路线。');return;}setTarget('draw:leaf');}
  else if (id==='undo') undo(); else if (id==='reset') reset();
  else if (id==='motion') {cancelGesture();motionPlaying=!motionPlaying;render();status(motionPlaying?'风景继续流动。':'风景已暂停，可以慢慢调整。');}
  else if (id==='music') {stage.querySelector('.music-toggle').click();}
  else if (id==='immersive') {cancelGesture();stage.classList.toggle('immersive');status(stage.classList.contains('immersive')?'已进入沉浸画布。V 手势仍可打开菜单。':'已退出沉浸画布。');}
  else cancelGesture();
}
function moveGesture(cursor) {
  if (activeTarget.id==='draw:leaf') {
    if (!drawPoints.length || Math.hypot(cursor.x-drawPoints.at(-1).x,cursor.y-drawPoints.at(-1).y)>.003) drawPoints.push({...cursor});
    if (drawPoints.length>512) drawPoints=drawPoints.filter((_,i)=>i%2===0);
    scene=updateScene(gestureBefore.scene,drawLeafTrailPatch(gestureBefore.scene,drawPoints));leafPhase=0;
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
  handOverlay.setAttribute('hidden',''); $('#pinch-feedback').value = 0; $('#hand-feedback-label').textContent = '等待手掌';
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
  const frame=tracker.update(input), select=selector.update({...input,pinching:frame.pinching});
  stage.dataset.handPhase=frame.phase;stage.dataset.selectorPhase=select.phase;
  handFeedback(result.landmarks?.[0],frame);
  const cursor=$('#hand-cursor');cursor.hidden=!frame.cursor;
  if (frame.cursor) {cursor.style.left=frame.cursor.x*100+'%';cursor.style.top=frame.cursor.y*100+'%';}
  $('#selector-progress').value=select.progress; $('#selector-hint').textContent=select.pose ? '保持 V · 打开对象菜单' : 'V 手势选对象';
  if (select.triggered && !gestureBefore) {toggleMenu();return;}
  if (menu.isOpen()) {
    if (!frame.cursor || select.pose || frame.pinching || !frame.ready) menuReleaseAt=null;
    else if (menuReleaseAt===null) menuReleaseAt=now;
    const r=stage.getBoundingClientRect();
    menu.update(frame.cursor?{x:r.left+frame.cursor.x*r.width,y:r.top+frame.cursor.y*r.height}:null,now,
      {enabled:menuReleaseAt!==null&&now-menuReleaseAt>=160});
    return;
  }
  if (frame.phase==='cancel'||frame.phase==='lost') {
    restore(gestureBefore);gestureBefore=null;activeTarget=null;grabStart=null;drawPoints=[];targetTracker.cancel();hoverId=null;
    stage.classList.remove('gesture-grabbing');render();
    status(frame.reason==='multiple-hands'?'镜头里留一只手，就可以继续玩。':'先张开一只手，再捏合。');return;
  }
  if (select.pose && !gestureBefore) {status('保持 V 手势，选择图中的更多内容。');return;}
  const targets=collectTargets();
  const bounds=stage.getBoundingClientRect();
  const overUI=frame.cursor&&document.elementFromPoint(bounds.left+frame.cursor.x*bounds.width,bounds.top+frame.cursor.y*bounds.height)?.closest('.experiment-panel,.lab-header,.camera-preview,.gesture-legend,#exit-immersive');
  const hit=!explicitId&&overUI?null:explicitId==='draw:leaf'?{id:'draw:leaf',label:'落叶路线',operation:'draw'}:hitTestGestureTargets(targets,frame.cursor,{explicitId,slop:.009});
  // An empty automatic hit must never grab a previously hovered object elsewhere.
  if (frame.phase==='start'&&!hit) targetTracker.cancel();
  const selection=targetTracker.update({timestampMs:now,targetId:hit?.id??null,phase:frame.phase});
  hoverId=selection.targetId;
  if (frame.phase==='start') {
    const chosen=selection.targetId==='draw:leaf'?hit:targets.find(t=>t.id===selection.targetId);
    if (!chosen) {status('靠近一个物体再捏合，或比 V 选择对象。');render();return;}
    gestureBefore=snapshot();activeTarget=chosen;grabStart={...frame.cursor};drawPoints=[{...frame.cursor}];
    selectedObject=isObject(chosen.id)?chosen.id:null;stage.classList.add('gesture-grabbing');render();
  }
  if ((frame.phase==='move'||frame.phase==='end')&&gestureBefore) moveGesture(frame.cursor);
  if (frame.phase==='end'&&gestureBefore) {
    const before=gestureBefore,label=activeTarget.label,wasDraw=activeTarget.id==='draw:leaf';
    gestureBefore=null;activeTarget=null;grabStart=null;drawPoints=[];stage.classList.remove('gesture-grabbing');commit(before);
    status(wasDraw?'新落叶路线已保存。再画一条，会立即替换。':`${label}已保存。V 手势可以换一个对象。`);
  } else if (gestureBefore) status(activeTarget.id==='draw:leaf'?'捏合画出落叶路线，松开保存。':'握住了，移动调整；松开保存。');
  else status(frame.ready?(hit?`${hit.label}：捏合抓取。V 手势可切换对象。`:'抬手靠近物体，或比 V 选择对象。'):'先张开拇指和食指，再捏合。');
  render();
}
function inferenceFrame(session) {
  frameId = requestAnimationFrame(() => {
    if (session !== epoch || !detector || cameraState !== 'tracking') return;
    const now = performance.now();
    if (gestureBefore && now - lastInference > tracker.options.maxGapMs) cancelGesture('镜头暂时没有新画面，已取消抓取。张开手后重试。');
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
  cancelPointer();cancelGesture();
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
    loadController = null; tracker.cancel('start'); selector.cancel(); targetTracker.cancel(); lastVideoTime = -1; lastInference = 0;
    updateCameraState('tracking'); status('先张开一只手，再捏合。');
    $('#camera-note').textContent = (lastAssets?.total && lastAssets.cacheLoaded === lastAssets.total ? '本次读取本机缓存，没有重新下载模型。' : '识别文件已准备好，之后可复用浏览器缓存。') + ' V 手势选对象，捏合移动；松开保存，丢手取消。画面不上传。';
    inferenceFrame(session);
  } catch (error) {
    if (session !== epoch) { pendingStream?.getTracks().forEach(track => track.stop()); try { pendingDetector?.close(); } catch {} return; }
    stopCamera(cameraError(error), 'error');
  }
}
function reset() {
  cancelPointer();cancelGesture();const before=snapshot();
  scene=labDefault??createScene();decorOffsets=Object.freeze({});selectedObject=null;explicitId=null;
  motionTime=0;leafPhase=0;motionPlaying=!reduced;menu.close();stage.classList.remove('menu-open');commit(before);collectTargets(true);render();
  status('已恢复初始风景。抬手靠近物体，或比 V 切换对象。');
}
function undo() {
  cancelPointer();cancelGesture();const previous=history.pop();
  if(previous){restore(previous);collectTargets(true);render();status('已撤销上一次调整。');}else status('还没有需要撤销的调整。');
}
async function fullscreen() {
  try { if(document.fullscreenElement)await document.exitFullscreen();else await stage.requestFullscreen({navigationUI:'hide'}); }
  catch {status('当前浏览器未允许全屏，可以用菜单里的沉浸画布。');}
}
$('#start-camera').addEventListener('click',startCamera);
$('#stop-camera').addEventListener('click',()=>{menu.close();stage.classList.remove('menu-open');stopCamera();});
$('#reset-lab').addEventListener('click',reset);$('#undo-lab').addEventListener('click',undo);
$('#fullscreen-lab').addEventListener('click',fullscreen);$('#open-targets').addEventListener('click',toggleMenu);
$('#auto-target').addEventListener('click',()=>setTarget('auto'));
$('#exit-immersive').addEventListener('click',()=>{stage.classList.remove('immersive');status('已退出沉浸画布。');});
$('#hour-control').addEventListener('input',event=>{
  if(lastInputGeneration!==inputGeneration)return;
  if(!pointerBefore&&!beginPointer('range','hour'))return;
  if(!acceptsPointer('range','hour'))return;
  scene=updateScene(scene,{hour:Number(event.target.value)});render();
});
$('#hour-control').addEventListener('change',()=>{if(!acceptsPointer('range','hour'))return;const before=pointerBefore;pointerBefore=null;pointerSession=null;commit(before);});
document.addEventListener('keydown',event=>{
  if(event.target.closest('input,textarea,select,[contenteditable]')||event.repeat)return;
  const key=event.key.toLowerCase();
  if((event.metaKey||event.ctrlKey)&&key==='z'){event.preventDefault();undo();}
  else if(!event.metaKey&&!event.ctrlKey&&!event.altKey){
    if(key==='r')reset();else if(key==='m')stage.querySelector('.music-toggle').click();else if(key==='f')fullscreen();
    else if(key==='v')toggleMenu();else if(key==='a')setTarget('auto');else if(key==='l')menuAction('draw:leaf');else if(key===' ') {event.preventDefault();menuAction('motion');}
    else if(key==='escape'){menu.close();stage.classList.remove('menu-open','immersive');cancelPointer();cancelGesture('已取消调整。');}
  }
});
document.addEventListener('visibilitychange',()=>{previousFrame=performance.now();if(document.hidden&&['loading','tracking'].includes(cameraState))stopCamera('已离开实验页，摄像头已关闭。');});
window.addEventListener('blur',()=>{
  pageFocused=false;cancelPointer();menu.resetDwell();menuReleaseAt=null;
  cancelGesture(cameraState==='tracking'?'已暂停手势。返回页面、张开手后继续。':'');
});
window.addEventListener('focus',()=>{pageFocused=true;});
window.addEventListener('pagehide',()=>stopCamera());
window.addEventListener('resize',()=>{targetsAt=-Infinity;render();});
function animate(now){
  const delta=Math.min((now-previousFrame)/1000,.1);previousFrame=now;
  if(motionPlaying&&!gestureBefore&&!document.hidden&&cameraState!=='loading'){
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
