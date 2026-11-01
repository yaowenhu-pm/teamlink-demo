import {createScene, updateScene, sceneChanges} from '../scene-model.mjs';
import {mountLandscape} from '../scene-renderer.mjs';
import {mountLandscapeMusic} from '../music.mjs';
import {PinchTracker, createHourDrag} from '../gesture-model.mjs';

const $ = selector => document.querySelector(selector);
const stage = $('#gesture-stage'), video = $('#camera-video');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const tracker = new PinchTracker(), hourDrag = createHourDrag();
let scene = createScene(), history = [], gestureBefore = null, pointerBefore = null;
let stream = null, detector = null, frameId = null, epoch = 0, lastVideoTime = -1, lastInference = 0;
let loadController = null, motionTime = 0, leafPhase = 0, previousFrame = performance.now(), lastPaint = 0, cameraState = 'off';

function formatHour(hour) {
  const minutes = Math.round((hour % 24) * 60);
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}
function status(message) { if ($('#gesture-status').textContent !== message) $('#gesture-status').textContent = message; }
function render() {
  renderer.render(scene, {phase: leafPhase, motionTime, motionPlaying: !reduced});
  stage.classList.toggle('night', scene.hour < 6 || scene.hour >= 19.5);
  stage.dataset.hour = String(scene.hour);
  $('#hour-label').textContent = formatHour(scene.hour);
  if ($('#hour-control') !== document.activeElement) $('#hour-control').value = String(scene.hour);
  $('#undo-lab').disabled = !history.length;
}
function commit(before) {
  if (before && sceneChanges(before, scene).length) { history.push(before); if (history.length > 15) history.shift(); }
  render();
}
function cancelGesture(message = '') {
  if (gestureBefore) scene = gestureBefore;
  gestureBefore = null; hourDrag.cancel(); tracker.cancel('cancelled');
  stage.classList.remove('gesture-grabbing'); $('#hand-cursor').hidden = true;
  if (message) status(message);
  render();
}
const renderer = mountLandscape($('#landscape'), {
  onSunDrag(hour, phase) {
    if (phase === 'start') { cancelGesture(); pointerBefore = scene; }
    scene = updateScene(scene, {hour}); render();
    if (phase === 'end') { const before = pointerBefore; pointerBefore = null; commit(before); }
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
}
function loadingProgress({phase, loaded, total}) {
  const meter = $('#loading-meter'), detail = $('#loading-detail');
  if (phase === 'download') {
    const percent = total ? Math.min(100, Math.floor(loaded / total * 100)) : 0;
    meter.value = percent;
    detail.textContent = `下载识别文件 ${percent}%`;
    status('正在准备手部识别，完成后再开启摄像头。');
  } else {
    meter.removeAttribute('value');
    detail.textContent = phase === 'waiting' ? '等待上一次准备结束…' : phase === 'ready' ? '识别已准备好' : '下载完成，正在初始化识别…';
    status(phase === 'waiting' ? '等待上一次识别准备结束，请稍候。' : '下载完成，正在启动手部识别。');
  }
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
  const cursor = $('#hand-cursor'); cursor.hidden = !frame.cursor;
  if (frame.cursor) { cursor.style.left = (frame.cursor.x * 100) + '%'; cursor.style.top = (frame.cursor.y * 100) + '%'; }
  if (frame.phase === 'cancel' || frame.phase === 'lost') {
    if (gestureBefore) { scene = gestureBefore; gestureBefore = null; hourDrag.cancel(); render(); }
    stage.classList.remove('gesture-grabbing');
    status(frame.reason === 'multiple-hands' ? '镜头里留一只手，就可以继续玩。' : hand ? '先张开手，让手势重新准备好。' : '把一只手放进镜头，先张开，再捏合。');
    return;
  }
  if (frame.phase === 'start') {
    gestureBefore = scene; hourDrag.start(frame.cursor, scene.hour); stage.classList.add('gesture-grabbing');
  }
  if (frame.phase === 'move' && gestureBefore) {
    const hour = hourDrag.move(frame.cursor); if (hour !== null) { scene = updateScene(scene, {hour}); render(); }
  }
  if (frame.phase === 'end' && gestureBefore) {
    const hour = hourDrag.move(frame.cursor); if (hour !== null) scene = updateScene(scene, {hour});
    const before = gestureBefore; gestureBefore = null; hourDrag.end(); stage.classList.remove('gesture-grabbing'); commit(before);
    status('已松开。再捏合，可以继续拨动太阳。');
  } else if (frame.pinching) status('握住了。左右移动，让天色跟着变化。');
  else status(frame.ready ? '已看到你的手，捏合拇指和食指抓住太阳。' : '先张开拇指和食指，再捏合。');
}
function inferenceFrame(session) {
  frameId = requestAnimationFrame(() => {
    if (session !== epoch || !detector || cameraState !== 'tracking') return;
    const now = performance.now();
    if (gestureBefore && now - lastInference > tracker.options.maxGapMs) cancelGesture('镜头暂时没有新画面，已取消抓取。张开手后重试。');
    if (!pointerBefore && video.readyState >= 2 && video.currentTime !== lastVideoTime && now - lastInference >= 55) {
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
  cancelGesture(); pointerBefore = null;
  const activeDetector = detector; detector = null; try { activeDetector?.close(); } catch {}
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.pause(); video.srcObject = null; $('#camera-preview').hidden = true;
  updateCameraState(state); status(message);
}
function cameraError(error) {
  if (error?.name === 'CameraTimeoutError') return '摄像头没有返回画面，已关闭。请确认设备可用后重新开启。';
  if (error?.name === 'TimeoutError') return '识别准备超时，已停止等待。请检查网络并刷新页面后重试，也可以直接拖动太阳。';
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
  $('#camera-note').textContent = '首次下载约 10 MB，慢网可能需 1–2 分钟。进度完成后再请求相机权限；可随时取消。';
  let pendingStream = null, pendingDetector = null;
  try {
    const {createHandLandmarker} = await waitForPreparation(import('../vendor/hand-vision/loader.mjs?v=9932db2a4039'), controller.signal);
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
    updateCameraState('tracking'); status('把一只手放进镜头，先张开，再捏合。');
    $('#camera-note').textContent = '捏合时只控制太阳；松开确认。手离开镜头会取消当前抓取，画面不上传。';
    inferenceFrame(session);
  } catch (error) {
    if (session !== epoch) { pendingStream?.getTracks().forEach(track => track.stop()); try { pendingDetector?.close(); } catch {} return; }
    stopCamera(cameraError(error), 'error');
  }
}
function reset() {
  cancelGesture(); pointerBefore = null;
  const before = scene; scene = createScene(); motionTime = 0; leafPhase = 0; commit(before);
  status(cameraState === 'tracking' ? '回到夕阳了。先张开手，再捏合试试。' : '回到夕阳了，开启摄像头或直接拖动太阳。');
}
function undo() {
  cancelGesture(); pointerBefore = null;
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
$('#hour-control').addEventListener('input', event => {
  if (!pointerBefore) { cancelGesture(); pointerBefore = scene; }
  scene = updateScene(scene, {hour: Number(event.target.value)}); render();
});
$('#hour-control').addEventListener('change', () => { const before = pointerBefore; pointerBefore = null; commit(before); });
document.addEventListener('keydown', event => {
  if (event.target.closest('input,textarea,select,[contenteditable]') || event.repeat) return;
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === 'z') { event.preventDefault(); undo(); }
  else if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    if (key === 'r') reset(); else if (key === 'm') stage.querySelector('.music-toggle').click(); else if (key === 'f') fullscreen();
    else if (key === 'escape' && gestureBefore) cancelGesture('已取消抓取，张开手后可重试。');
  }
});
document.addEventListener('visibilitychange', () => { previousFrame = performance.now(); if (document.hidden && ['loading', 'tracking'].includes(cameraState)) stopCamera('已离开实验页，摄像头已关闭。'); });
window.addEventListener('pagehide', () => stopCamera());
function animate(now) {
  const delta = Math.min((now - previousFrame) / 1000, .1); previousFrame = now;
  if (!reduced && !document.hidden && cameraState !== 'loading') {
    motionTime += delta; leafPhase = (leafPhase + delta / 7) % 1;
    if (now - lastPaint >= 33) { lastPaint = now; render(); }
  }
  requestAnimationFrame(animate);
}
updateCameraState('off'); render(); requestAnimationFrame(animate);
