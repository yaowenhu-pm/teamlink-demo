import {createScene, updateScene, sceneChanges, moveSceneObject} from '../scene-model.mjs';
import {mountLandscape} from '../scene-renderer.mjs';
import {mountLandscapeMusic} from '../music.mjs';
import {PinchTracker, createHourDrag, createObjectDrag} from '../gesture-model.mjs?v=127746be27f3';

const $ = selector => document.querySelector(selector);
const stage = $('#gesture-stage'), video = $('#camera-video');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const tracker = new PinchTracker(), hourDrag = createHourDrag();
const boatDrag = createObjectDrag();
let scene = createScene(), history = [], gestureBefore = null, pointerBefore = null;
let labDefault = null;
let gestureTarget = 'sun', lastAssets = null;
let inputGeneration = 0, lastInputGeneration = -1, pointerSession = null;
let pointerHeld = false, pointerId = null, pageFocused = document.hasFocus(), selectedObject = null;
let stream = null, detector = null, frameId = null, epoch = 0, lastVideoTime = -1, lastInference = 0;
let loadController = null, motionTime = 0, leafPhase = 0, previousFrame = performance.now(), lastPaint = 0, cameraState = 'off';

function formatHour(hour) {
  const minutes = Math.round((hour % 24) * 60);
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}
function status(message) { if ($('#gesture-status').textContent !== message) $('#gesture-status').textContent = message; }
function render() {
  lastPaint = performance.now();
  renderer.render(scene, {phase: leafPhase, motionTime, motionPlaying: !reduced, selectedObject});
  stage.classList.toggle('night', scene.hour < 6 || scene.hour >= 19.5);
  stage.dataset.hour = String(scene.hour);
  stage.dataset.gestureTarget = gestureTarget;
  const boat = renderer.getObjectPositions().find(item => item.id === 'boat:0')?.point;
  if (boat) { stage.dataset.boatX = String(boat.x); stage.dataset.boatY = String(boat.y); }
  $('#hour-label').textContent = formatHour(scene.hour);
  if ($('#hour-control') !== document.activeElement) $('#hour-control').value = String(scene.hour);
  $('#undo-lab').disabled = !history.length;
}
function commit(before) {
  if (before && sceneChanges(before, scene).length) { history.push(before); if (history.length > 15) history.shift(); }
  render();
}
function invalidatePointer() { inputGeneration++; lastInputGeneration = -1; pointerBefore = null; pointerSession = null; }
function beginPointer(kind, id) {
  if (lastInputGeneration !== inputGeneration) return false;
  cancelGesture(); pointerBefore = scene; pointerSession = {kind,id,generation:inputGeneration}; return true;
}
function acceptsPointer(kind,id) { return pointerSession?.generation === inputGeneration && pointerSession.kind === kind && pointerSession.id === id; }
stage.addEventListener('pointerdown',event=>{
  if (event.isPrimary && event.button === 0 && event.target.closest('#landscape,#hour-control')) {
    cancelGesture(); pointerHeld = true; pointerId = event.pointerId; lastInputGeneration = inputGeneration;
  }
},{capture:true});
window.addEventListener('pointerup',event=>{ if (event.pointerId === pointerId) { pointerHeld = false; pointerId = null; } },{capture:true});
window.addEventListener('pointercancel',event=>{
  if (event.pointerId !== pointerId) return;
  if (pointerBefore) scene = pointerBefore;
  pointerHeld = false; pointerId = null; invalidatePointer(); render();
},{capture:true});
stage.addEventListener('keydown',event=>{
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) && event.target.closest('#landscape,input[type=range]')) {
    if (pointerHeld) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    cancelGesture(); lastInputGeneration = inputGeneration;
  }
},{capture:true});
function cancelGesture(message = '') {
  if (gestureBefore) scene = gestureBefore;
  gestureBefore = null; hourDrag.cancel(); boatDrag.cancel(); tracker.cancel('cancelled');
  stage.classList.remove('gesture-grabbing'); $('#hand-cursor').hidden = true;
  clearHandFeedback();
  if (message) status(message);
  render();
}
const renderer = mountLandscape($('#landscape'), {
  onSunDrag(hour, phase) {
    if (phase === 'start' && !beginPointer('sun','sun')) return false;
    if (!acceptsPointer('sun','sun')) return false;
    selectedObject = null; scene = updateScene(scene, {hour}); render();
    if (phase === 'end') { const before = pointerBefore; pointerBefore = null; pointerSession = null; commit(before); }
  },
  onObjectSelect({id}) { if (pointerBefore) return; if (id === 'boat:0') setTarget('boat'); else { cancelGesture(); selectedObject = id; render(); } },
  onObjectDrag({id, point, phase}) {
    if (phase === 'start' && !beginPointer('object',id)) return false;
    if (!acceptsPointer('object',id)) return false;
    selectedObject = id; scene = updateScene(scene, moveSceneObject(pointerBefore ?? scene, id, point)); render();
    if (phase === 'end') { const before = pointerBefore; pointerBefore = null; pointerSession = null; commit(before); }
  }
});
const music = mountLandscapeMusic(stage);
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
  $('#target-sun').disabled = next === 'loading'; $('#target-boat').disabled = next === 'loading';
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
function setTarget(next) {
  if (!['sun','boat'].includes(next) || cameraState === 'loading' || pointerBefore) return;
  cancelGesture(); gestureTarget = next;
  selectedObject = next === 'boat' ? 'boat:0' : null;
  $('#target-sun').setAttribute('aria-pressed',String(next === 'sun')); $('#target-boat').setAttribute('aria-pressed',String(next === 'boat'));
  status(next === 'sun' ? '控制太阳：捏合后左右移动。' : '控制帆船：捏合移动，松开确认。'); render();
}
function moveGesture(cursor) {
  if (gestureTarget === 'sun') { const hour = hourDrag.move(cursor); if (hour !== null) scene = updateScene(scene,{hour}); }
  else { const point = boatDrag.move(cursor); if (point) scene = updateScene(scene,moveSceneObject(gestureBefore ?? scene,'boat:0',point)); }
  render();
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
  const hand = result.landmarks?.[0];
  const frame = tracker.update({hands: result.landmarks ?? [], timestampMs: now,
    width: video.videoWidth, height: video.videoHeight,
    confidence: result.handedness?.[0]?.[0]?.score ?? 1,
    handId: result.handedness?.[0]?.[0]?.categoryName ?? 'single'});
  stage.dataset.handPhase = frame.phase;
  handFeedback(hand, frame);
  const cursor = $('#hand-cursor'); cursor.hidden = !frame.cursor;
  if (frame.cursor) { cursor.style.left = (frame.cursor.x * 100) + '%'; cursor.style.top = (frame.cursor.y * 100) + '%'; }
  if (frame.phase === 'cancel' || frame.phase === 'lost') {
    if (gestureBefore) { scene = gestureBefore; gestureBefore = null; hourDrag.cancel(); boatDrag.cancel(); render(); }
    stage.classList.remove('gesture-grabbing');
    status(frame.reason === 'multiple-hands' ? '镜头里留一只手，就可以继续玩。' : hand ? '先张开手，让手势重新准备好。' : '先张开一只手，再捏合。');
    return;
  }
  if (frame.phase === 'start') {
    gestureBefore = scene;
    selectedObject = gestureTarget === 'boat' ? 'boat:0' : null;
    if (gestureTarget === 'sun') hourDrag.start(frame.cursor, scene.hour);
    else boatDrag.start(frame.cursor,renderer.getObjectPositions().find(item=>item.id==='boat:0')?.point ?? {x:.6,y:.7});
    stage.classList.add('gesture-grabbing');
  }
  if (frame.phase === 'move' && gestureBefore) {
    moveGesture(frame.cursor);
  }
  if (frame.phase === 'end' && gestureBefore) {
    moveGesture(frame.cursor);
    const before = gestureBefore; gestureBefore = null; hourDrag.end(); boatDrag.end(); stage.classList.remove('gesture-grabbing'); commit(before);
    status(`已松开。再捏合，可以继续${gestureTarget === 'sun' ? '拨动太阳' : '移动帆船'}。`);
  } else if (frame.pinching) status(gestureTarget === 'sun' ? '握住了，左右移动；松开确认。' : '握住了，移动帆船；松开确认。');
  else status(frame.ready ? `已看到你的手，捏合抓住${gestureTarget === 'sun' ? '太阳' : '帆船'}。` : '先张开拇指和食指，再捏合。');
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
function stopCamera(message = '摄像头已关闭。你仍可直接拖动太阳。', state = 'off') {
  epoch++; if (frameId !== null) cancelAnimationFrame(frameId); frameId = null;
  loadController?.abort(); loadController = null;
  cancelGesture(); invalidatePointer();
  const activeDetector = detector; detector = null; try { activeDetector?.close(); } catch {}
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.pause(); video.srcObject = null; $('#camera-preview').hidden = true;
  updateCameraState(state); status(message);
}
function cameraError(error) {
  if (error?.name === 'CameraTimeoutError') return '摄像头没有返回画面，已关闭。请确认设备可用后重新开启。';
  if (error?.name === 'TimeoutError') return '识别准备超时，已停止等待。请检查网络并刷新页面后重试，也可以直接拖动太阳。';
  if (error?.name === 'AssetIntegrityError') return '识别文件校验未通过，已停止使用。请刷新页面后重试。';
  if (error?.name === 'AssetSizeError') return '识别文件下载不完整，请重新准备；也可以直接拖动太阳。';
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return '未获得摄像头权限。允许后可重试，也能直接拖动太阳。';
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
    loadController = null; tracker.cancel('start'); lastVideoTime = -1; lastInference = 0;
    updateCameraState('tracking'); status('先张开一只手，再捏合。');
    $('#camera-note').textContent = (lastAssets?.total && lastAssets.cacheLoaded === lastAssets.total ? '本次读取本机缓存，没有重新下载模型。' : '识别文件已准备好，之后可复用浏览器缓存。') + ' 松开确认，丢手取消；画面不上传。';
    inferenceFrame(session);
  } catch (error) {
    if (session !== epoch) { pendingStream?.getTracks().forEach(track => track.stop()); try { pendingDetector?.close(); } catch {} return; }
    stopCamera(cameraError(error), 'error');
  }
}
function reset() {
  cancelGesture(); invalidatePointer();
  selectedObject = gestureTarget === 'boat' ? 'boat:0' : null;
  const before = scene; scene = labDefault ?? createScene(); motionTime = 0; leafPhase = 0; commit(before);
  status(cameraState === 'tracking' ? '回到夕阳了。先张开手，再捏合试试。' : '回到夕阳了，开启摄像头或直接拖动太阳。');
}
function undo() {
  cancelGesture(); invalidatePointer();
  const previous = history.pop(); if (previous) { scene = previous; render(); status('已撤销上一次调整。'); }
}
async function fullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await stage.requestFullscreen({navigationUI: 'hide'}); }
  catch { status('当前浏览器未允许全屏，可以继续在网页里体验。'); }
}
$('#start-camera').addEventListener('click', startCamera);
$('#stop-camera').addEventListener('click', () => stopCamera());
$('#reset-lab').addEventListener('click', reset); $('#undo-lab').addEventListener('click', undo);
$('#fullscreen-lab').addEventListener('click', fullscreen);
$('#target-sun').addEventListener('click',()=>setTarget('sun')); $('#target-boat').addEventListener('click',()=>setTarget('boat'));
$('#hour-control').addEventListener('input', event => {
  if (lastInputGeneration !== inputGeneration) return;
  if (!pointerBefore && !beginPointer('range','hour')) return;
  if (!acceptsPointer('range','hour')) return;
  scene = updateScene(scene, {hour: Number(event.target.value)}); render();
});
$('#hour-control').addEventListener('change', () => { if (!acceptsPointer('range','hour')) return; const before = pointerBefore; pointerBefore = null; pointerSession = null; commit(before); });
document.addEventListener('keydown', event => {
  if (event.target.closest('input,textarea,select,[contenteditable]') || event.repeat) return;
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === 'z') { event.preventDefault(); undo(); }
  else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    if (key === 'r') reset(); else if (key === 'm') stage.querySelector('.music-toggle').click(); else if (key === 'f') fullscreen();
    else if (key === '1') setTarget('sun'); else if (key === '2') setTarget('boat');
    else if (key === 'escape' && gestureBefore) cancelGesture('已取消抓取，张开手后可重试。');
  }
});
document.addEventListener('visibilitychange', () => { previousFrame = performance.now(); if (document.hidden && ['loading', 'tracking'].includes(cameraState)) stopCamera('已离开实验页，摄像头已关闭。'); });
window.addEventListener('blur',()=>{
  pageFocused = false;
  if (pointerBefore) scene = pointerBefore;
  pointerHeld = false; pointerId = null; invalidatePointer();
  cancelGesture(cameraState === 'tracking' ? '已暂停手势。返回页面、张开手后继续。' : '');
});
window.addEventListener('focus',()=>{ pageFocused = true; });
window.addEventListener('pagehide', () => stopCamera());
function animate(now) {
  const delta = Math.min((now - previousFrame) / 1000, .1); previousFrame = now;
  if (!reduced && !document.hidden && cameraState !== 'loading') {
    motionTime += delta; leafPhase = (leafPhase + delta / 7) % 1;
    if (now - lastPaint >= 33) { lastPaint = now; render(); }
  }
  requestAnimationFrame(animate);
}
updateCameraState('off'); render();
// Keep the initial boat above the floating controls, including wide displays.
const initialBoat = renderer.getObjectPositions().find(item=>item.id==='boat:0')?.point;
const initialBounds = stage.getBoundingClientRect(), panelTop = $('.experiment-panel').getBoundingClientRect().top;
if (initialBoat && initialBounds.height > 0) {
  const visibleY = Math.max(.5,Math.min(initialBoat.y,(panelTop-initialBounds.top-48)/initialBounds.height));
  labDefault = updateScene(scene,moveSceneObject(scene,'boat:0',{x:initialBoat.x,y:visibleY}));
  scene = labDefault; render();
} else labDefault = scene;
requestAnimationFrame(animate);
