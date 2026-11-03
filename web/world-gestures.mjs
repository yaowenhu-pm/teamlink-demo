import {PinchTracker,GestureTargetTracker,SelectorGestureTracker,ModeGestureTracker} from './gesture-model.mjs';
import {buildGestureTargets,hitTestGestureTargets,applyTargetDrag,drawLeafTrailPatch} from './gesture-targets.mjs';
import {mountGestureMenu} from './gesture-menu.mjs';

/** Optional camera input for the existing shared canvas. The host owns all scene,
 * renderer, clipboard, history, persistence, animation and music state. */
export function mountWorldGestures(stage,host) {
 const doc=stage.ownerDocument,win=doc.defaultView,svg=stage.querySelector('#landscape');
 if(!svg||!host||typeof host.getScene!=='function')throw new TypeError('A shared landscape host is required.');
 const root=doc.createElement('div');root.className='world-gesture-root';root.dataset.worldGesture='';
 root.innerHTML=`<section class="world-gesture-panel" aria-label="手势控制" hidden>
  <div class="world-gesture-heading"><strong>伸手，改变这片风景。</strong><button type="button" data-wg="collapse" aria-label="收起手势面板">×</button></div>
  <p class="world-gesture-status" data-wg="status" role="status" aria-live="polite">张开手掌靠近物体，捏合移动，松开同步。</p>
  <div class="world-gesture-actions"><button type="button" data-wg="start" class="world-gesture-primary">开启摄像头</button><button type="button" data-wg="stop" hidden>关闭摄像头</button><button type="button" data-wg="mode" aria-pressed="false">自动拾取</button><button type="button" data-wg="menu-open">选择 / 编辑</button></div>
  <div class="world-gesture-loading" data-wg="loading" hidden><progress data-wg="loading-meter" max="100" value="0" aria-label="识别文件准备进度"></progress><span data-wg="loading-detail">准备识别…</span></div>
  <p class="world-gesture-note" data-wg="note">首次准备约 10 MB，之后复用缓存。画面仅在本机识别。</p>
 </section>
 <div class="world-gesture-legend" data-wg="legend" hidden><button type="button" data-wg="compact-mode" aria-pressed="false">自动拾取</button><span>三指切模式 <progress data-wg="mode-meter" max="1" value="0" aria-label="三指切换进度"></progress></span><span>V 选对象 / 编辑 <progress data-wg="selector-meter" max="1" value="0" aria-label="V 手势进度"></progress></span><button type="button" data-wg="compact-stop" aria-label="关闭摄像头">×</button></div>
 <aside class="world-gesture-camera" data-wg="camera" hidden aria-label="仅本机识别的摄像头预览"><video data-wg="video" muted playsinline></video><svg data-wg="hand-overlay" xmlns="http://www.w3.org/2000/svg" hidden aria-hidden="true"></svg><span data-wg="hand-label">等待手掌</span></aside>
 <section class="world-gesture-menu" data-wg="menu" hidden aria-label="手势选择与编辑"></section>
 <div class="world-gesture-highlight" data-wg="highlight" hidden aria-hidden="true"><span></span></div>
 <div class="world-gesture-cursor" data-wg="cursor" hidden aria-hidden="true"><span></span></div>
 <div class="world-gesture-placement" data-wg="placement" hidden role="status">粘贴预览 · 捏合松开放下 · Esc 取消</div>`;
 stage.append(root);
 const $=name=>root.querySelector(`[data-wg="${name}"]`),video=$('video');
 const launch=doc.createElement('button');launch.type='button';launch.className='world-gesture-launch';launch.dataset.worldGesture='';launch.textContent='手势控制';launch.setAttribute('aria-expanded','false');launch.setAttribute('aria-controls','world-gesture-panel');root.querySelector('section').id='world-gesture-panel';
 (stage.querySelector('.canvas-tools')??stage).append(launch);
 const tracker=new PinchTracker(),selector=new SelectorGestureTracker(),modeTracker=new ModeGestureTracker(),targetTracker=new GestureTargetTracker();
 let cameraState='off',stream=null,detector=null,loadController=null,epoch=0,frameId=null,lastVideoTime=-1,lastInference=0,lastAssets=null;
 let selectionMode='auto',explicitId=null,lastManualId=null,hoverId=null,commandContext=null,targets=[],targetsAt=-Infinity,menuReleaseAt=null,lastCursor=null;
 let transaction=null,placing=false,pasteStarting=false,placementHeld=false,pending=false,selectingHost=false,pointerHeld=false,pointerId=null,focused=doc.hasFocus(),destroyed=false;
 let panelOpen=false,lastHostSelected=host.getSelectedId?.()??null,previewGeneration=0;
 const nativeId=id=>/^(tree|boat|mountain|bird):\d+$/u.test(id??'');
 const busy=()=>pending||host.isBusy();
 const status=message=>{if($('status').textContent!==message)$('status').textContent=message;};
 const menu=mountGestureMenu($('menu'),{onSelect:selectTarget,onAction:action,onModeChange:mode=>setMode(mode,{fromMenu:true})});
 function panel(open){panelOpen=open;root.querySelector('.world-gesture-panel').hidden=!open;launch.setAttribute('aria-expanded',String(open));root.classList.toggle('world-gesture-panel-open',open);}
 function cameraUI(next){cameraState=next;root.dataset.cameraState=next;stage.dataset.gestureCamera=next;
  $('start').hidden=next==='loading'||next==='tracking';$('stop').hidden=next!=='loading'&&next!=='tracking';$('stop').textContent=next==='loading'?'取消准备':'关闭摄像头';$('loading').hidden=next!=='loading';
  $('legend').hidden=next!=='tracking';launch.textContent=next==='tracking'?'手势已开启':next==='loading'?'准备手势…':'手势控制';$('start').textContent=next==='error'?'重试摄像头':'开启摄像头';
 }
 function update(){
  if(destroyed)return;targetsAt=-Infinity;
  const selected=host.getSelectedId?.()??null;
  if(selected!==lastHostSelected){lastHostSelected=selected;if(!selectingHost&&!transaction&&!placing){if(nativeId(selected)){selectionMode='manual';explicitId=selected;lastManualId=selected;}else if(nativeId(explicitId)){explicitId=null;}}}
  if(explicitId&&explicitId!=='draw:leaf'&&!collectTargets().some(t=>t.id===explicitId)){explicitId=null;}
  root.dataset.selectionMode=selectionMode;root.dataset.gestureTarget=explicitId??(selectionMode==='manual'?'manual:none':'auto');root.dataset.activeTarget=transaction?.target.id??hoverId??explicitId??'';root.dataset.placement=placing?'preview':'';
  $('placement').hidden=!placing;root.classList.toggle('world-gesture-grabbing',!!transaction||placementHeld);
  for(const name of ['mode','compact-mode']){$(name).textContent=selectionMode==='auto'?'自动拾取':'手动选择';$(name).setAttribute('aria-pressed',String(selectionMode==='manual'));$(name).disabled=busy()||!!transaction||placing;}
  $('menu-open').disabled=busy()||!!transaction;launch.disabled=false;
  if(menu.isOpen())menu.updateEditState(host.editState(commandContext??explicitId??hoverId));
  highlight();
 }
 function collectTargets(force=false){
  const now=performance.now();if(!force&&now-targetsAt<100)return targets;
  const r=svg.getBoundingClientRect();if(!r.width||!r.height)return targets;
  const geometry={},rect=node=>{if(!node||win.getComputedStyle(node).display==='none')return null;const b=node.getBoundingClientRect();return b.width&&b.height?{bounds:{left:(b.left-r.left)/r.width,top:(b.top-r.top)/r.height,right:(b.right-r.left)/r.width,bottom:(b.bottom-r.top)/r.height}}:null;};
  svg.querySelectorAll('[data-scene-object]').forEach(node=>{const box=rect(node);if(box)geometry[node.dataset.sceneObject]=box;});
  geometry.sun=rect(svg.querySelector('[data-role="sun-control"]'));geometry.leaf=rect(svg.querySelector('[data-layer="leaf"]'));
  const trajectory=svg.querySelector('[data-layer="trajectory"]'),rootMatrix=svg.getScreenCTM(),local=trajectory?.transform.baseVal.consolidate()?.matrix,scene=host.getScene();
  if(local&&rootMatrix){const m=rootMatrix.multiply(local);geometry.leafFrame={x:(m.e-r.left)/r.width,y:(m.f-r.top)/r.height,scaleX:m.a*1600/r.width,scaleY:m.d*1000/r.height};
   for(const id of ['leafOrigin','leafTarget']){const p=scene[id],f=geometry.leafFrame,x=f.x+p.x*f.scaleX,y=f.y+p.y*f.scaleY;geometry[id]={anchor:{x,y},bounds:{left:x-.018,top:y-.023,right:x+.018,bottom:y+.023}};}}
  for(const id of ['branches','flowers','sky','water','wind','rain','clouds','count:trees','count:boats','count:mountains','count:birds'])geometry[id]={anchor:{x:.5,y:id==='water'?.75:.3},bounds:{left:0,top:id==='water'?.5:0,right:1,bottom:id==='water'?1:.5}};
  targets=buildGestureTargets(scene,host.getObjects(),geometry).map(t=>['leafOrigin','leafTarget'].includes(t.id)?{...t,requireExplicit:true}:t);targetsAt=now;
  if(menu.isOpen())menu.updateTargets(targets);return targets;
 }
 function highlight(){
  const box=$('highlight'),id=transaction?.target.id??explicitId??hoverId,t=targets.find(t=>t.id===id);
  if(!t||menu.isOpen()||(t.requireExplicit&&t.operation!=='object')||cameraState!=='tracking'){box.hidden=true;return;}
  const s=stage.getBoundingClientRect(),r=svg.getBoundingClientRect(),b=t.bounds;box.hidden=false;
  box.style.left=r.left-s.left+b.left*r.width+'px';box.style.top=r.top-s.top+b.top*r.height+'px';box.style.width=(b.right-b.left)*r.width+'px';box.style.height=(b.bottom-b.top)*r.height+'px';box.firstElementChild.textContent=t.label;
 }
 function resetTrackers(){tracker.cancel();selector.cancel();modeTracker.cancel();targetTracker.cancel();hoverId=null;menuReleaseAt=null;$('mode-meter').value=0;$('selector-meter').value=0;}
 function closeMenu(){menu.close();root.classList.remove('world-gesture-menu-open');menuReleaseAt=null;commandContext=null;}
 function cancel(message=''){
  previewGeneration++;if(transaction){transaction=null;host.cancel();}
  if(placing||pasteStarting){placing=false;pasteStarting=false;placementHeld=false;Promise.resolve(host.command('paste-cancel')).catch(()=>{});}
  resetTrackers();$('cursor').hidden=true;$('hand-overlay').setAttribute('hidden','');$('hand-label').textContent='等待手掌';
  update();if(message)status(message);
 }
 function openMenu(){
  if(busy())return;
  const context=explicitId??hoverId??host.getSelectedId?.()??null;cancel();commandContext=context;
  menu.open({targets:collectTargets(true),selectedId:explicitId??context,scene:host.getScene(),selectionMode,editState:host.editState(context)});root.classList.add('world-gesture-menu-open');menuReleaseAt=null;status('张开手，将光标停在按钮上。也可直接点击。');highlight();
 }
 function toggleMenu(){if(menu.isOpen()){closeMenu();resetTrackers();}else openMenu();}
 function selectInHost(id){
  selectingHost=true;try{host.select(id);}finally{lastHostSelected=host.getSelectedId?.()??null;selectingHost=false;}
 }
 function setMode(next,{fromMenu=false}={}){
  if(!['auto','manual'].includes(next)||busy()||transaction||pointerHeld)return;
  const inventory=collectTargets(true),valid=id=>id==='draw:leaf'?host.getScene().trees>0:inventory.some(t=>t.id===id),context=hoverId??commandContext??host.getSelectedId?.();
  const fixed=valid(context)?context:valid(lastManualId)?lastManualId:null;
  if(explicitId&&valid(explicitId))lastManualId=explicitId;
  cancel();selectionMode=next;explicitId=next==='manual'?fixed:null;if(explicitId)lastManualId=explicitId;
  selectInHost(explicitId);
  if(next==='auto'){closeMenu();status('自动拾取：靠近物体，再捏合移动。');}
  else if(fromMenu&&menu.isOpen()){menu.updateMode(next,explicitId);status('手动选择：在菜单里固定一个对象。');}
  else if(!explicitId){openMenu();status('手动选择：请在菜单里选择对象。');}
  else{closeMenu();status('已固定对象，V 手势可更换，三指可回自动。');}
  update();
 }
 function selectTarget(id){
  if(busy())return;if(id==='auto'||id==='manual'){setMode(id,{fromMenu:menu.isOpen()});return;}
  cancel();selectionMode='manual';explicitId=id;lastManualId=id;closeMenu();selectInHost(id);
  status(id==='draw:leaf'?'捏合开始画线，松开保存新路线。':`${collectTargets(true).find(t=>t.id===id)?.label??'对象'}已固定。捏合调整，松开同步。`);update();
 }
 async function action(id){
  const target=commandContext??explicitId??hoverId??host.getSelectedId?.()??null;
  if(id==='close'){closeMenu();resetTrackers();return;}
  if(busy())return;
  if(id==='draw:leaf'){if(!host.getScene().trees){status('先增加一棵树，就可以画落叶路线。');return;}selectTarget(id);return;}
  if(id==='paste'&&cameraState==='tracking'){
   cancel();closeMenu();const generation=++previewGeneration;pending=true;pasteStarting=true;
   try{const point=lastCursor??{x:.55,y:.65};const result=await host.command('paste-preview',{id:target,point});pasteStarting=false;if(result!==false&&generation===previewGeneration){placing=true;placementHeld=false;status('移动手掌定位副本，捏合并松开放下。');}else if(result!==false)await host.command('paste-cancel');}
   catch(error){pasteStarting=false;await host.command('paste-cancel');status(error?.message??'暂时无法粘贴，请重试。');}
   finally{pending=false;resetTrackers();update();}return;
  }
  cancel();closeMenu();pending=true;update();
  try{
   let result;if(['copy','cut','paste','duplicate','delete'].includes(id))result=await host.command(id,{id:target});
   else if(id==='undo')result=await host.undo();else if(id==='redo')result=await host.redo();else if(id==='reset')result=await host.reset();
   else if(id==='motion')result=await host.toggleMotion();else if(id==='music')result=await host.music();else if(id==='immersive')result=await host.fullscreen();
   if(result!==false)status(id==='copy'?'已复制。V 菜单选择粘贴，或直接点击粘贴。':id==='paste'?'已粘贴，可直接拖动或撤销。':['cut','duplicate','delete'].includes(id)?'修改已应用，可撤销恢复。':'可以继续改变这片风景。');
  }catch(error){status(error?.message??'本次操作没有完成，请重试。');}
  finally{pending=false;resetTrackers();update();}
 }
 function move(cursor){
  if(!transaction||!cursor)return;
  const t=transaction;
  if(t.target.id==='draw:leaf'){
   if(!t.points.length||Math.hypot(cursor.x-t.points.at(-1).x,cursor.y-t.points.at(-1).y)>.003)t.points.push({...cursor});
   if(t.points.length>512)t.points=t.points.filter((_,i)=>i%2===0);
   t.patch=drawLeafTrailPatch(t.scene,t.points);
  }else t.patch=applyTargetDrag(t.scene,t.target,t.start,cursor);
  if(host.preview(t.patch)===false)throw new Error('画布状态已改变，请张开手后重试。');targetsAt=-Infinity;highlight();
 }
 async function finishDrag(cursor){
  if(!transaction)return;move(cursor);const t=transaction;transaction=null;pending=true;update();
  try{const saved=await host.commit(t.patch??{});status(saved===false?'这次修改尚未确认，请查看同步提示。':t.target.id==='draw:leaf'?'落叶路线已同步。再画一笔，会立即替换。':`${t.target.label}已同步到同一风景。`);}
  catch(error){host.cancel();status(error?.message??'本次修改没有保存。');}
  finally{pending=false;resetTrackers();update();}
 }
 async function finishPaste(point){
  if(!placing)return;placing=false;placementHeld=false;pending=true;update();
  try{const saved=await host.command('paste-commit',{point});status(saved===false?'这次粘贴尚未确认，请查看同步提示。':'副本已同步。V 菜单可继续复制、粘贴或删除。');}
  catch(error){await host.command('paste-cancel');status(error?.message??'本次粘贴没有保存。');}
  finally{pending=false;resetTrackers();update();}
 }
 const ns='http://www.w3.org/2000/svg',wire=doc.createElementNS(ns,'path'),dots=Array.from({length:21},(_,i)=>{const n=doc.createElementNS(ns,'circle');n.dataset.tip=String(i===4||i===8);return n;});$('hand-overlay').replaceChildren(wire,...dots);
 const edges=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
 function feedback(hand,frame){
  if(!frame.cursor||!hand||hand.length!==21){$('hand-overlay').setAttribute('hidden','');$('hand-label').textContent=frame.reason==='multiple-hands'?'请只留一只手':'等待手掌';return;}
  const w=video.videoWidth,h=video.videoHeight;$('hand-overlay').setAttribute('viewBox',`0 0 ${w} ${h}`);$('hand-overlay').removeAttribute('hidden');wire.setAttribute('d',edges.map(([a,b])=>`M${hand[a].x*w} ${hand[a].y*h}L${hand[b].x*w} ${hand[b].y*h}`).join(''));dots.forEach((dot,i)=>{dot.setAttribute('cx',hand[i].x*w);dot.setAttribute('cy',hand[i].y*h);dot.setAttribute('r',w*.01);});
  $('hand-label').textContent=frame.pinching?'已握住 · 松开同步':frame.ready?'张开 · 可捏合':'请先张开拇指和食指';$('cursor').firstElementChild.style.transform=`scale(${1+(frame.pinchProgress??0)*1.6})`;
 }
 function frame(result,now){
  const r0=svg.getBoundingClientRect(),editing=doc.activeElement?.closest?.('input,textarea,select,[contenteditable]'),blocked=!!doc.querySelector('dialog[open]')||!!editing||r0.width<=0||r0.height<=0||r0.bottom<=0||r0.top>=win.innerHeight;
  if(pending||host.isBusy()||pointerHeld||!focused||blocked){if(transaction||placing)cancel('当前操作暂停，未完成的预览已取消。');return;}
  const input={hands:result.landmarks??[],timestampMs:now,width:video.videoWidth,height:video.videoHeight,confidence:result.handedness?.[0]?.[0]?.score??1,handId:result.handedness?.[0]?.[0]?.categoryName??'single'};
  const pinch=tracker.update(input),mode=modeTracker.update({...input,pinching:pinch.pinching}),select=mode.pose?selector.cancel('mode-pose'):selector.update({...input,pinching:pinch.pinching});
  root.dataset.handPhase=pinch.phase;root.dataset.selectorPhase=select.phase;root.dataset.modeGesturePhase=mode.phase;feedback(result.landmarks?.[0],pinch);
  $('cursor').hidden=!pinch.cursor;
  if(pinch.cursor){lastCursor={...pinch.cursor};const s=stage.getBoundingClientRect(),r=svg.getBoundingClientRect();$('cursor').style.left=r.left-s.left+pinch.cursor.x*r.width+'px';$('cursor').style.top=r.top-s.top+pinch.cursor.y*r.height+'px';}
  $('mode-meter').value=mode.progress;$('selector-meter').value=select.progress;
  if(mode.triggered&&!transaction){setMode(selectionMode==='auto'?'manual':'auto');return;}
  if(select.triggered&&!transaction){toggleMenu();return;}
  if(menu.isOpen()){
   if(!pinch.cursor||select.pose||mode.pose||pinch.pinching||!pinch.ready)menuReleaseAt=null;else if(menuReleaseAt===null)menuReleaseAt=now;
   const r=svg.getBoundingClientRect();menu.update(pinch.cursor?{x:r.left+pinch.cursor.x*r.width,y:r.top+pinch.cursor.y*r.height}:null,now,{enabled:menuReleaseAt!==null&&now-menuReleaseAt>=160});return;
  }
  if(placing){
   if(pinch.phase==='cancel'||pinch.phase==='lost'){cancel('手掌丢失，已取消未放置的副本。');return;}
   if(select.pose||mode.pose)return;
   if(pinch.cursor){const generation=previewGeneration;Promise.resolve(host.command('paste-preview',{point:pinch.cursor})).catch(error=>{if(generation===previewGeneration)cancel(error?.message??'粘贴预览已取消。');});}
   if(pinch.phase==='start'){placementHeld=true;update();}
   if(pinch.phase==='end'&&placementHeld)void finishPaste(pinch.cursor);return;
  }
  if(pinch.phase==='cancel'||pinch.phase==='lost'){cancel(pinch.reason==='multiple-hands'?'镜头里留一只手，就能继续。':'先张开一只手，再捏合。');return;}
  if((mode.pose||select.pose)&&!transaction)return;
  const inventory=collectTargets(),r=svg.getBoundingClientRect(),at=pinch.cursor?doc.elementFromPoint(r.left+pinch.cursor.x*r.width,r.top+pinch.cursor.y*r.height):null,overUI=at?.closest('.world-gesture-panel,.world-gesture-camera,.world-gesture-legend,.canvas-tools,.object-tools,.inspector,.presentation-tools');
  const hit=(selectionMode==='manual'&&!explicitId)||(selectionMode==='auto'&&overUI)?null:explicitId==='draw:leaf'?{id:'draw:leaf',label:'落叶路线',operation:'draw'}:hitTestGestureTargets(inventory,pinch.cursor,{explicitId,slop:.009});
  if(pinch.phase==='start'&&!hit)targetTracker.cancel();
  const picked=targetTracker.update({timestampMs:now,targetId:hit?.id??null,phase:pinch.phase});hoverId=selectionMode==='auto'?(hit?.id===picked.targetId?hit.id:null):picked.targetId;
  if(pinch.phase==='start'){
   const chosen=picked.targetId==='draw:leaf'?hit:inventory.find(t=>t.id===picked.targetId);if(!chosen){status('靠近物体再捏合，或比 V 选择。');highlight();return;}
   if(!host.begin()){status('先完成当前同步，再捏合试试。');resetTrackers();return;}
   transaction={scene:host.getScene(),target:chosen,start:{...pinch.cursor},points:[{...pinch.cursor}],patch:{}};selectInHost(chosen.id);update();
  }
  if((pinch.phase==='move'||pinch.phase==='end')&&transaction){try{move(pinch.cursor);}catch(error){cancel(error?.message??'本次抓取已取消。');return;}}
  if(pinch.phase==='end'&&transaction)void finishDrag(pinch.cursor);else highlight();
 }
 function loading(progress){
  lastAssets=progress;const {phase,loaded,total,cacheLoaded=0}=progress,meter=$('loading-meter');
  if(phase==='download'||phase==='checking-cache'){const percent=total?Math.min(100,Math.floor(loaded/total*100)):0;meter.value=percent;$('loading-detail').textContent=phase==='checking-cache'?cacheLoaded?`读取缓存 ${percent}%`:'检查本机缓存…':`准备识别 ${percent}%`;}
  else{meter.removeAttribute('value');$('loading-detail').textContent=phase==='waiting'?'等待准备结束…':'初始化识别…';}
 }
 function wait(promise,signal,ms=30000,name='TimeoutError'){
  return new Promise((resolve,reject)=>{let finished=false;const abort=()=>done(signal.reason??new DOMException('Cancelled','AbortError')),timer=setTimeout(()=>done(new DOMException('Preparation timed out',name)),ms);
   function done(error,value){if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve(value);}
   signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(value=>done(null,value),error=>done(error));if(signal.aborted)abort();});
 }
 function stop(message='摄像头已关闭，鼠标和扫码仍可继续。',state='off'){
  epoch++;if(frameId!==null)cancelAnimationFrame(frameId);frameId=null;loadController?.abort();loadController=null;cancel();closeMenu();
  const old=detector;detector=null;try{old?.close();}catch{}stream?.getTracks().forEach(t=>t.stop());stream=null;video.pause();video.srcObject=null;$('camera').hidden=true;cameraUI(state);status(message);
 }
 function cameraError(error){
  if(['NotAllowedError','SecurityError'].includes(error?.name))return '未获得摄像头权限。允许后可重试，也能直接拖动。';
  if(error?.name==='NotFoundError')return '没有找到摄像头，鼠标和扫码仍可使用。';
  if(error?.name==='NotReadableError')return '摄像头暂时不可用，可能正被其他应用占用。';
  if(error?.name==='CameraTimeoutError')return '摄像头没有返回画面，已关闭，请重试。';
  if(error?.name==='TimeoutError')return '识别准备超时。请检查网络后重试。';
  if(['AssetIntegrityError','AssetSizeError'].includes(error?.name))return '识别文件未通过校验，请刷新后重试。';
  return '摄像头或识别文件未能加载，请重试。';
 }
 function infer(session){frameId=requestAnimationFrame(()=>{
  if(session!==epoch||!detector||cameraState!=='tracking')return;
  const now=performance.now();if((transaction||placing)&&now-lastInference>tracker.options.maxGapMs)cancel('镜头暂时没有新画面，已取消未完成预览。');
  if(focused&&!pointerHeld&&video.readyState>=2&&video.currentTime!==lastVideoTime&&now-lastInference>=55){lastVideoTime=video.currentTime;lastInference=now;try{frame(detector.detectForVideo(video,now),now);}catch{stop('识别暂时中断，重新开启试试。','error');return;}}
  infer(session);
 });}
 async function start(){
  if(cameraState==='loading'||cameraState==='tracking'||destroyed)return;panel(true);
  if(!win.isSecureContext||!navigator.mediaDevices?.getUserMedia){cameraUI('error');status('请在 HTTPS 下使用支持摄像头的浏览器。');return;}
  const session=++epoch,controller=new AbortController();loadController=controller;cameraUI('loading');loading({phase:'checking-cache',loaded:0,total:1});status('准备本机识别，完成后请求相机权限。');
  let pendingStream=null,pendingDetector=null;
  try{
   const loaderUrl='/vendor/hand-vision/loader.mjs?v=d84acb664ca0';
   const {createHandLandmarker}=await wait(import(loaderUrl),controller.signal);if(session!==epoch)return;
   pendingDetector=await createHandLandmarker({numHands:2},{signal:controller.signal,onProgress:p=>{if(session===epoch)loading(p);}});if(session!==epoch){pendingDetector.close();return;}
   detector=pendingDetector;pendingDetector=null;status('识别已准备好，请允许使用摄像头。');$('loading-detail').textContent='等待摄像头权限…';
   pendingStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640},height:{ideal:480},frameRate:{ideal:24,max:30}},audio:false});
   if(session!==epoch){pendingStream.getTracks().forEach(t=>t.stop());return;}stream=pendingStream;const track=stream.getVideoTracks()[0];if(!track||track.readyState!=='live')throw new DOMException('Camera ended','NotReadableError');
   track.addEventListener('ended',()=>{if(session===epoch)stop('摄像头连接已结束，可以重新开启。');},{once:true});video.srcObject=stream;$('camera').hidden=false;
   await wait(video.play(),controller.signal,10000,'CameraTimeoutError');if(session!==epoch)return;loadController=null;lastVideoTime=-1;lastInference=performance.now();resetTrackers();cameraUI('tracking');status('先张开一只手，再捏合。松开即同步。');
   $('note').textContent=(lastAssets?.total&&lastAssets.cacheLoaded===lastAssets.total?'已命中本机缓存。':'识别文件已就绪，可复用缓存。')+' V 选对象 / 编辑，三指切换模式。画面不上传。';infer(session);
  }catch(error){if(session!==epoch){pendingStream?.getTracks().forEach(t=>t.stop());try{pendingDetector?.close();}catch{}return;}stop(cameraError(error),'error');}
 }
 const onPointerDown=event=>{if(event.target.closest?.('[data-world-gesture]'))return;if(!stage.contains(event.target))return;pointerHeld=true;pointerId=event.pointerId;cancel();closeMenu();};
 const onPointerUp=event=>{if(event.pointerId!==pointerId)return;pointerHeld=false;pointerId=null;resetTrackers();};
 const onKey=event=>{
  if(event.defaultPrevented||event.repeat||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||doc.querySelector('dialog[open]')||event.target.closest?.('input,textarea,select,[contenteditable]'))return;
  const r=stage.getBoundingClientRect();if(!panelOpen&&cameraState!=='tracking'&&!placing&&!menu.isOpen())return;if(r.bottom<=0||r.top>=win.innerHeight)return;
  if(event.key==='Escape'&&(transaction||placing||menu.isOpen())){event.preventDefault();event.stopImmediatePropagation();cancel('已取消未完成的预览。');closeMenu();}
  else if(event.key.toLowerCase()==='v'){event.preventDefault();event.stopImmediatePropagation();toggleMenu();}
  else if(event.key.toLowerCase()==='t'){event.preventDefault();event.stopImmediatePropagation();setMode(selectionMode==='auto'?'manual':'auto');}
 };
 const onBlur=()=>{focused=false;pointerHeld=false;pointerId=null;cancel('已暂停手势；回到页面后先张开手。');closeMenu();};
 const onFocus=()=>{focused=true;resetTrackers();};
 const onVisibility=()=>{if(doc.hidden&&['loading','tracking'].includes(cameraState))stop('离开页面，摄像头已关闭。');};
 const onPageHide=()=>stop();const onResize=()=>{if(transaction||placing)cancel('画布尺寸已改变，未完成预览已取消。');targetsAt=-Infinity;update();};
 launch.addEventListener('click',()=>panel(!panelOpen));$('collapse').addEventListener('click',()=>panel(false));$('start').addEventListener('click',start);$('stop').addEventListener('click',()=>stop());$('compact-stop').addEventListener('click',()=>stop());$('mode').addEventListener('click',()=>setMode(selectionMode==='auto'?'manual':'auto'));$('compact-mode').addEventListener('click',()=>setMode(selectionMode==='auto'?'manual':'auto'));$('menu-open').addEventListener('click',toggleMenu);
 doc.addEventListener('keydown',onKey,true);doc.addEventListener('pointerdown',onPointerDown,true);win.addEventListener('pointerup',onPointerUp,true);win.addEventListener('pointercancel',onPointerUp,true);win.addEventListener('lostpointercapture',onPointerUp,true);win.addEventListener('blur',onBlur);win.addEventListener('focus',onFocus);win.addEventListener('pagehide',onPageHide);win.addEventListener('resize',onResize);doc.addEventListener('visibilitychange',onVisibility);
 cameraUI('off');update();
 return Object.freeze({update,cancel,stop,get busy(){return !!transaction||placing||pending;},select(id){selectTarget(id);},destroy(){if(destroyed)return;stop();destroyed=true;doc.removeEventListener('keydown',onKey,true);doc.removeEventListener('pointerdown',onPointerDown,true);win.removeEventListener('pointerup',onPointerUp,true);win.removeEventListener('pointercancel',onPointerUp,true);win.removeEventListener('lostpointercapture',onPointerUp,true);win.removeEventListener('blur',onBlur);win.removeEventListener('focus',onFocus);win.removeEventListener('pagehide',onPageHide);win.removeEventListener('resize',onResize);doc.removeEventListener('visibilitychange',onVisibility);root.remove();launch.remove();}});
}
