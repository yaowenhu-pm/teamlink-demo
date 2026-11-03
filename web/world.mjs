import qrcode from 'qrcode-generator';
import {createScene,validateScene,updateScene,sceneChanges,moveSceneObject} from './scene-model.mjs';
import {mountLandscape} from './scene-renderer.mjs';
import {mountCodePanel} from './code-panel.mjs';
import {mountDirectEditor,defaultScenePatch,SHORTCUTS} from './direct-edit.mjs';
import {mountLandscapeMusic} from './music.mjs';
import {mountWorldGestures} from './world-gestures.mjs';
const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
if(location.hash.startsWith('#doc='))location.replace('/legacy/app/'+location.search+location.hash);
const STORAGE='teamlink-landscape-v1';
let scene=createScene(),room=null,busy=false,pollTimer=null,pollDelay=1400,polling=false,localHistory=[],latestChanges=[],lastReply='',lastRequest=null,writeNotBefore=0;
let selected=null,editBefore=null,leafCompare=null,phase=0,playing=true,lastFrame=performance.now(),toastTimer,hideOpening,stageVisible=true;
let codePanel=null,codeBefore=null,codeDraft=false,roomConnection=null,connecting=true,shareUnavailable=false,shareError='',inviteCache='',expiryTimer,directEditor=null;
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;if(reduced)playing=false;
let drawingTrajectory=false,motionTime=0,motionPlaying=!reduced;
let backgroundMusic=null,worldGestures=null,gestureSession=null,redoStack=[],historyAction=null;
let drawingSnapshot=null,shortcutHelpFocus=null;
try{const raw=localStorage.getItem(STORAGE);if(raw)scene=validateScene(JSON.parse(raw));}catch{}
const hash=new URLSearchParams(location.hash.slice(1));
if(/^[0-9a-f]{32}$/.test(hash.get('room')??'')&&/^[0-9a-f]{64}$/.test(hash.get('key')??''))room={id:hash.get('room'),token:hash.get('key'),revision:0,connected:false,messages:[]};
if(new URLSearchParams(location.search).get('control')==='1')document.body.classList.add('controller');
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3200);}
function status(text){$('#compose-status').textContent=text;}
function quietOpening(){clearTimeout(hideOpening);$('#opening').classList.add('quiet');}
function saveLocal(){if(!room){try{localStorage.setItem(STORAGE,JSON.stringify(scene));}catch{}}}
function formatHour(hour){const total=Math.round((hour%24)*60);return String(Math.floor(total/60)).padStart(2,'0')+':'+String(total%60).padStart(2,'0');}
function value(key,value){if(key==='hour')return formatHour(value);if(key==='rain'||key==='wind')return Math.round(value*100)+'%';if(key==='branchAngle')return value+'°';if(key==='placements')return value.length+' 个位置';if(key==='leafTrail')return value.length?'手绘路线':'随风路线';if(key==='leafOrigin'||key==='leafTarget')return `${Math.round(value.x*100)}%, ${Math.round(value.y*100)}%`;if(typeof value==='boolean')return value?'有':'无';return String(value);}
function showChanges(changes){latestChanges=changes;$('#change-chips').innerHTML=changes.map(item=>`<span>${esc(item.label)} ${esc(value(item.key,item.before))} → ${esc(value(item.key,item.after))}</span>`).join('');}
function canUndo(){return room?(typeof room.canUndo==='boolean'?room.canUndo:!!room.messages?.some(m=>m.changes?.length)):localHistory.length>0;}
function renderControls(){
 const gestureBusy=!!gestureSession;
 $('#time-label').textContent=formatHour(scene.hour);$('#hour-value').textContent=formatHour(scene.hour);$('#angle-value').textContent=scene.branchAngle+'°';$('#depth-value').textContent=scene.branchDepth;$('#wind-value').textContent=Math.round(scene.wind*100)+'%';
 for(const [id,key] of [['hour-range','hour'],['angle-range','branchAngle'],['depth-range','branchDepth'],['wind-range','wind']]){const input=$('#'+id);if(input!==document.activeElement)input.value=String(scene[key]);input.disabled=busy||connecting||codeDraft||drawingTrajectory||gestureBusy;}
 const sharedCanUndo=typeof room?.canUndo==='boolean'?room.canUndo:room?.messages?.some(m=>m.changes?.length);
 $('#undo-world').disabled=busy||connecting||codeDraft||drawingTrajectory||gestureBusy||(!room&&!localHistory.length)||(room&&!sharedCanUndo);
 $('#send').disabled=busy||connecting||codeDraft||drawingTrajectory||gestureBusy;$$('.suggestions button').forEach(button=>button.disabled=busy||connecting||codeDraft||drawingTrajectory||gestureBusy);$('#share-world').disabled=busy&&!room;
 $('#suggestions').hidden=!!lastReply||!!room?.messages?.length;
 $('#play-leaf').textContent=playing&&motionPlaying?'Ⅱ':'▶';
 document.body.classList.toggle('night-scene',scene.hour<6||scene.hour>=19.5);document.body.dataset.hour=String(scene.hour);document.body.dataset.trees=String(scene.trees);document.body.dataset.boats=String(scene.boats);document.body.dataset.mountains=String(scene.mountains);document.body.dataset.revision=String(room?.revision??0);
 codePanel?.update(scene,{before:codeBefore??scene,selected,busy:busy||connecting||drawingTrajectory||gestureBusy});
 directEditor?.update(scene,{busy:busy||connecting||codeDraft||gestureBusy||!!editBefore,resetBusy:busy||connecting||gestureBusy,drawing:drawingTrajectory,motionPlaying});
 $('#draw-route-hint').hidden=!drawingTrajectory;$('#live-stage').classList.toggle('drawing-trajectory',drawingTrajectory);
 $('#reset-leaf-route').disabled=busy||connecting||codeDraft||gestureBusy||!scene.leafTrail?.length;
 worldGestures?.update();
}
function renderScene(){renderer.render(scene,{phase,showTrajectory:selected==='leaf',compareScene:leafCompare,selectedObject:directEditor?.selectedId,drawingTrajectory,motionTime,motionPlaying});if(document.body.classList.contains('mobile-code-open'))previewRenderer.render(scene,{phase,showTrajectory:selected==='leaf',compareScene:leafCompare,motionTime,motionPlaying});}
function render(){renderScene();renderControls();}
function restoreDrawing(){
 if(drawingSnapshot){scene=drawingSnapshot.scene;phase=drawingSnapshot.phase;playing=drawingSnapshot.playing;selected=drawingSnapshot.selected;leafCompare=drawingSnapshot.leafCompare;}
 drawingSnapshot=null;editBefore=null;
}
function setDrawing(enabled){
 if(enabled&&(busy||connecting||codeDraft||gestureSession))return;
 if(!enabled)restoreDrawing();else editBefore=null;
 drawingTrajectory=enabled;
 if(enabled){directEditor?.select(null);selected=null;leafCompare=null;$('#inspector').hidden=true;quietOpening();}
 render();
}
function pathDraw({points,phase:drawPhase}){
 if(drawPhase==='cancel'){restoreDrawing();drawingTrajectory=false;render();return;}
 if(busy||connecting||codeDraft||gestureSession)return false;
 if(drawPhase==='start'){drawingSnapshot={scene,phase,playing,selected,leafCompare};editBefore=scene;phase=1;playing=false;render();return;}
 if(drawPhase==='move'){
  if(Array.isArray(points)&&points.length>=2){scene=updateScene(editBefore??scene,{leafTrail:points,leafOrigin:points[0],leafTarget:points.at(-1)});selected='leaf';phase=1;render();}
  return;
 }
 if(drawPhase!=='end')return;
 drawingTrajectory=false;
 if(!Array.isArray(points)||points.length<2){restoreDrawing();render();return;}
 drawingSnapshot=null;
 selected='leaf';leafCompare=null;phase=0;playing=true;
 finishDirect({leafTrail:points,leafOrigin:points[0],leafTarget:points.at(-1)});
}
function inspector(kind){if(drawingTrajectory){drawingTrajectory=false;restoreDrawing();}selected=kind;$('#inspector').hidden=!kind;$$('[data-inspector]').forEach(node=>node.hidden=node.dataset.inspector!==kind);$('#inspector-title').textContent=kind==='tree'?'这棵树怎样生长':kind==='leaf'?'把落叶的过程摊开看':'太阳与时间';if(kind==='leaf')leafCompare=scene;render();quietOpening();}
function objectDrag({id,point,phase:dragPhase}){
 if(busy||connecting||codeDraft||gestureSession)return false;
 if(dragPhase==='start')editBefore=scene;
 const base=editBefore??scene,patch=moveSceneObject(base,id,point);scene=updateScene(base,patch);render();quietOpening();
 if(dragPhase==='end')finishDirect(patch);
}
function trajectoryDrag({handle,point,phase:dragPhase}){
 if(handle==='phase')return;
 if(busy||connecting||codeDraft||gestureSession)return false;
 if(dragPhase==='start')editBefore=scene;
 const patch={[handle==='origin'?'leafOrigin':'leafTarget']:point};scene=updateScene(editBefore??scene,patch);render();quietOpening();
 if(dragPhase==='end')finishDirect(patch);
}
const renderer=mountLandscape($('#landscape'),{
 onSunDrag(hour,dragPhase){if(busy||connecting||codeDraft||gestureSession)return false;if(dragPhase==='start')editBefore=scene;scene=updateScene(scene,{hour});render();quietOpening();if(dragPhase==='end')finishDirect({hour});},
 onObjectSelect({id}){directEditor?.select(id);},onObjectDrag:objectDrag,onTrajectoryDrag:trajectoryDrag,onPathDraw:pathDraw,
 onPhaseChange(value){playing=false;phase=value;render();},onTreeSelect:()=>inspector('tree'),onLeafSelect:()=>inspector('leaf')
});
const previewRenderer=mountLandscape($('#code-preview-landscape'));
directEditor=mountDirectEditor($('#live-stage'),{
 getScene:()=>scene,getObjects:()=>renderer.getObjectPositions(),onCommit:patch=>finishDirect(patch),
 onSelection(id,kind){if(kind==='tree'){inspector('tree');return;}selected=null;leafCompare=null;$('#inspector').hidden=true;render();quietOpening();},
 onInspect(kind){if(kind==='leaf')directEditor?.select(null);inspector(kind);},onUndo:undoWorld,onRedo:redoWorld,getCanUndo:canUndo,getCanRedo:()=>redoStack.length>0,notify:toast
 ,onDraw:()=>setDrawing(!drawingTrajectory),onReset:resetLandscape,onToggleMotion(){motionPlaying=!motionPlaying;render();},onHelp:showShortcuts,onNudge:delta=>renderer.nudgeSelected(delta)
});
function animate(now){const delta=Math.min((now-lastFrame)/1000,.1);lastFrame=now;if(motionPlaying&&stageVisible&&!document.hidden&&!gestureSession){motionTime+=delta;if(playing)phase=(phase+delta/7)%1;renderScene();if(selected==='leaf'&&$('#leaf-time')!==document.activeElement)$('#leaf-time').value=String(phase);}requestAnimationFrame(animate);}
function setConnection(text,connected=false){$('#connection').textContent=text;$('#connection').classList.toggle('connected',connected);}
function renderMessages(){
 const messages=room?.messages??[];const last=messages.at(-1);
 if(!last){$('#conversation').innerHTML=lastReply?`<div class="speech">${esc(lastReply)}</div>`:'';return;}
 lastReply=last.reply;
 $('#conversation').innerHTML=['patch','undo'].includes(last.kind)?'':`<div class="speech ${last.kind==='pending'?'pending':last.kind==='failed'?'failed':''}"><small>${esc(last.text.length>70?last.text.slice(0,70)+'…':last.text)}</small>${esc(last.reply)}</div>`;
 showChanges(last.changes??[]);
 if(last.kind==='pending')status('正在理解你的想法…');
 else if(last.kind==='failed')status('这次没有应用修改，可以换一句再试。');
 else if(last.kind==='patch')status('直接调整 · 已同步到同一风景');
 else if(last.kind==='undo')status('已撤销 · 同一风景已更新');
 else if(last.kind==='unsupported')status('可以再试试改变船、山、树木、时间或风雨。');
 else status(room.mode==='ai'?'豆包理解 · 修改已同步到同一风景':'调景指令模式 · 修改已同步');
}
function acceptState(state){
 if(!state||!state.scene||!Number.isSafeInteger(state.revision))throw Error('服务器状态无效');
 if(room&&state.id===room.id&&state.revision<room.revision)return false;
 if(room&&state.id===room.id&&state.revision!==room.revision&&!historyAction)redoStack=[];
 scene=validateScene(state.scene);room={...room,...state,receipt:state.receipt??null,connected:true};codeDraft=false;editBefore=null;
 const lastChange=[...(room.messages??[])].reverse().find(message=>message.changes?.length);
 codeBefore=lastChange?updateScene(scene,Object.fromEntries(lastChange.changes.map(change=>[change.key,change.before]))):scene;
 codePanel?.update(scene,{before:codeBefore,selected,busy:busy||connecting,resetDraft:true});
 if(lastRequest&&receiptFor(lastRequest.nonce)?.kind!=='pending'&&receiptFor(lastRequest.nonce))$('#retry').hidden=true;
 shareUnavailable=false;setConnection('同一风景 · 已连接',true);renderMessages();render();renderInvite();
 return true;
}
function receiptFor(nonce,state=room){return state?.receipt?.nonce===nonce?state.receipt:state?.messages?.find(message=>message.nonce===nonce);}
async function request(path,{method='GET',body,timeout=29000}={}){
 const headers={};if(room?.token)headers.Authorization='Bearer '+room.token;if(body)headers['Content-Type']='application/json';
 const response=await fetch(path,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout),cache:'no-store'});
 const data=await response.json().catch(()=>({error:'服务暂时无法读取。'}));
 if(!response.ok){const error=Error(data.error??'请求没有完成。');error.status=response.status;error.current=data.current;error.code=data.code;throw error;}
 return {data,status:response.status};
}
async function ensureRoom(){
 if(room?.connected&&!shareUnavailable&&room.expiresAt>Date.now())return;
 if(gestureSession||editBefore)throw Error('先松手保存或取消预览，再连接共享房间。');
 if(roomConnection)return roomConnection;
 connecting=true;renderControls();renderInvite();
 roomConnection=(async()=>{
  if(room){const {data}=await request('/api/rooms/'+room.id,{timeout:10000});acceptState(data);}
  else{setConnection('正在连接…');const {data}=await request('/api/rooms',{method:'POST',body:{scene},timeout:12000});room={...data,connected:true};history.replaceState(null,'',location.pathname+location.search+'#'+new URLSearchParams({room:room.id,key:room.token}));acceptState(data);}
  clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{shareUnavailable=true;renderInvite();},Math.max(0,room.expiresAt-Date.now()));schedulePoll();
 })().catch(error=>{if(room)room.connected=false;shareUnavailable=true;renderInvite(error.message);throw error;}).finally(()=>{connecting=false;roomConnection=null;render();renderInvite();updateIntroPlayback();});
 return roomConnection;
}
function schedulePoll(){clearTimeout(pollTimer);if(room&&!document.hidden)pollTimer=setTimeout(pollRoom,pollDelay);}
async function pollRoom(){
 if(!room||polling||document.hidden){schedulePoll();return;}polling=true;
 try{const {data}=await request('/api/rooms/'+room.id,{timeout:10000});pollDelay=1400;if(!editBefore&&(data.revision!==room.revision||!room.connected))acceptState(data);else if(data.revision===room.revision)setConnection('同一风景 · 已连接',true);
 if(!room.messages?.some(m=>m.kind==='pending')&&busy&&!lastRequest?.inFlight){busy=false;renderControls();}
 }catch(error){pollDelay=Math.min(pollDelay*1.7,8000);setConnection(error.status===410?'风景链接已到期':'连接暂时中断');if([401,403,404,410].includes(error.status)){shareUnavailable=true;renderInvite(error.message);clearTimeout(pollTimer);polling=false;status('这个房间暂时不可用，可以重新连接一片新的风景。');return;}}
 polling=false;schedulePoll();
}
async function sendOperation(payload,undo=false,retryRequest=null,onApplied=null){
 if(busy||gestureSession||editBefore)return false;busy=true;quietOpening();$('#retry').hidden=true;renderControls();
 const operation=retryRequest&&!retryRequest.retryAsNew?retryRequest:{payload,undo,nonce:crypto.randomUUID(),onApplied:retryRequest?.onApplied??onApplied};
 operation.inFlight=true;operation.retryAsNew=false;lastRequest=operation;const {nonce}=operation;
 try{await ensureRoom();operation.expectedRevision??=room.revision;const wait=Math.max(0,writeNotBefore-Date.now());if(wait)await new Promise(resolve=>setTimeout(resolve,wait));writeNotBefore=Date.now()+1050;
 let result;
 for(let attempt=0;;attempt++){
  try{result=await request('/api/rooms/'+room.id+(undo?'/undo':''),{method:'POST',body:{nonce,expectedRevision:operation.expectedRevision,...operation.payload}});break;}
  catch(error){if(attempt===0&&error.status===429&&error.code==='ROOM_RATE_LIMIT'){await new Promise(resolve=>setTimeout(resolve,1100));continue;}throw error;}
 }
 const {data,status:httpStatus}=result;acceptState(data);if(httpStatus===202&&receiptFor(nonce)?.kind==='pending'){status('请求仍在处理中，正在同步实际结果。');busy=true;}else busy=false;
 }catch(error){redoStack=[];if(error.current)acceptState(error.current);else if(room?.scene){scene=validateScene(room.scene);render();}busy=false;if(error.status===409){status('风景刚在另一端变化了，已更新到最新状态。请再试这次修改。');}else{status(error.message==='The operation was aborted due to timeout'?'请求尚未确认，正在读取房间中的实际结果。':error.message);}
 if(room&&(!error.status||error.status>=500)){try{const {data}=await request('/api/rooms/'+room.id,{timeout:8000});acceptState(data);busy=receiptFor(nonce,data)?.kind==='pending';}catch{}}
 const recorded=receiptFor(nonce);
 operation.retryAsNew=error.status===409&&!recorded;
 $('#retry').hidden=busy||!!(recorded&&recorded.kind!=='pending')||!!(error.status&&error.status<500&&![409,429].includes(error.status));
 }finally{writeNotBefore=Math.max(writeNotBefore,Date.now()+1050);operation.inFlight=false;renderControls();schedulePoll();}
 const receipt=receiptFor(nonce);
 if(receipt?.kind===(undo?'undo':Object.hasOwn(operation.payload,'patch')?'patch':'instruction')){operation.onApplied?.();return true;}
 return false;
}
async function sendText(text){if(!text.trim()||busy||codeDraft||connecting||drawingTrajectory||gestureSession||editBefore)return;$('#instruction').value='';await sendOperation({text:text.trim()});}
function finishDirect(patch,{onApplied=null,confirmRoom=false}={}){
 const before=editBefore??scene;editBefore=null;codeDraft=false;const next=updateScene(before,patch);const changes=sceneChanges(before,next);scene=next;if(!changes.length&&!(room&&confirmRoom)){render();onApplied?.();return true;}
 if(historyAction!=='redo')redoStack=[];
 codeBefore=before;
 if(room){status('正在同步这次直接修改…');render();return sendOperation({patch},false,null,onApplied);}
 else{localHistory.push(before);if(localHistory.length>15)localHistory.shift();saveLocal();showChanges(changes);lastReply='直接修改，结果已经在画面上。';status('当前为本机预览，重新连接后可以共享。');codePanel?.update(scene,{before,selected,resetDraft:true});render();onApplied?.();return true;}
}
async function undoWorld(){
 if(busy||connecting||codeDraft||drawingTrajectory||gestureSession||editBefore||!canUndo())return false;
 const target=scene;historyAction='undo';
 try{
  let applied=true;
  if(room)applied=await sendOperation({},true);
  else{scene=localHistory.pop()??scene;saveLocal();showChanges(sceneChanges(target,scene));}
  if(applied)redoStack.push({target,base:scene,revision:room?.revision??0});
  render();return applied;
 }finally{historyAction=null;renderControls();}
}
async function redoWorld(){
 if(busy||connecting||codeDraft||drawingTrajectory||gestureSession||editBefore||!redoStack.length)return false;
 const entry=redoStack.at(-1);
 if(entry.revision!==(room?.revision??0)||sceneChanges(entry.base,scene).length){redoStack=[];renderControls();toast('风景已变化，请继续基于当前画面修改。');return false;}
 const patch=Object.fromEntries(sceneChanges(scene,entry.target).map(change=>[change.key,change.after]));
 historyAction='redo';
 try{
  const applied=await finishDirect(patch);
  if(applied){redoStack.pop();if(redoStack.length)Object.assign(redoStack.at(-1),{base:scene,revision:room?.revision??0});}
  return applied;
 }finally{historyAction=null;renderControls();}
}
function beginGesture(){
 if(busy||connecting||codeDraft||drawingTrajectory||editBefore||gestureSession)return false;
 gestureSession={base:scene,phase,playing,kind:'drag'};editBefore=scene;quietOpening();renderControls();return true;
}
function cancelGesturePreview(){
 if(!gestureSession)return;
 scene=gestureSession.base;phase=gestureSession.phase;playing=gestureSession.playing;gestureSession=null;editBefore=null;
 $('#live-stage').dataset.placement='';$('#landscape').querySelectorAll('[data-edit-preview]').forEach(node=>node.removeAttribute('data-edit-preview'));render();
}
function previewGesture(patch){
 if(!gestureSession)return false;
 scene=updateScene(gestureSession.base,patch);gestureSession.patch=patch;
 if(patch.leafTrail){selected='leaf';phase=0;playing=true;}render();return true;
}
async function commitGesture(patch){
 if(!gestureSession)return false;
 const id=gestureSession.id;gestureSession=null;
 $('#live-stage').dataset.placement='';$('#landscape').querySelectorAll('[data-edit-preview]').forEach(node=>node.removeAttribute('data-edit-preview'));
 const applied=await finishDirect(patch);if(applied&&id)directEditor?.select(id);return applied;
}
function gestureCommand(command,options={}){
 if(command==='paste-cancel'){cancelGesturePreview();return true;}
 if(command==='paste-preview'){
  if(!gestureSession&&!beginGesture())return false;
  if(gestureSession.kind!=='paste'){
   try{gestureSession.kind='paste';gestureSession.paste=directEditor.preparePaste(options.point);}catch(error){cancelGesturePreview();toast(error.message);return false;}
  }
  const prepared=gestureSession.paste;if(!prepared){cancelGesturePreview();return false;}
  const patch={...prepared.patch,placements:prepared.patch.placements.map(item=>item.id===prepared.id?{...item,...options.point}:item)};
  gestureSession.id=prepared.id;previewGesture(patch);
  $('#live-stage').dataset.placement='preview';$('#landscape').querySelector(`[data-scene-object="${prepared.id}"]`)?.setAttribute('data-edit-preview','');return true;
 }
 if(command==='paste-commit')return gestureSession?commitGesture(gestureSession.patch):false;
 if(gestureSession)return false;
 return directEditor.command(command,options);
}
function resetLandscape(){
 if(busy||connecting||gestureSession)return;
 // Discard uncommitted JSON, slider/drag and hand-drawn previews before choosing
 // the same committed baseline used by the room's CAS and undo snapshot.
 renderer.cancelPathDraw();if(drawingTrajectory){drawingTrajectory=false;restoreDrawing();}
 scene=validateScene(room?.scene??editBefore??scene);editBefore=null;codeDraft=false;drawingSnapshot=null;
 codeBefore=scene;codePanel?.update(scene,{before:scene,selected,resetDraft:true});
 const patch=defaultScenePatch();
 return finishDirect(patch,{confirmRoom:true,onApplied(){
  selected=null;leafCompare=null;phase=0;motionTime=0;playing=!reduced;motionPlaying=!reduced;lastFrame=performance.now();
  $('#leaf-time').value='0';$('#inspector').hidden=true;directEditor?.reset();$('#instruction').value='';
  codePanel?.update(scene,{before:codeBefore??scene,selected,resetDraft:true});render();
  if(sceneChanges(scene,createScene()).length)status('默认风景已恢复，房间随后又有新的修改。');
  else status(room?'已恢复本房间默认风景 · 可撤销':'已恢复默认风景 · 当前为本机预览');
 }});
}
for(const [id,key] of [['hour-range','hour'],['angle-range','branchAngle'],['depth-range','branchDepth'],['wind-range','wind']]){
 const input=$('#'+id);input.addEventListener('input',()=>{if(busy||connecting||gestureSession)return;if(!editBefore)editBefore=scene;scene=updateScene(scene,{[key]:Number(input.value)});render();quietOpening();});input.addEventListener('change',()=>{if(busy||connecting||gestureSession)return;finishDirect({[key]:Number(input.value)});});
}
$('#compose').addEventListener('submit',event=>{event.preventDefault();sendText($('#instruction').value);});
$('#instruction').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('#compose').requestSubmit();}});
$$('[data-prompt]').forEach(button=>button.addEventListener('click',()=>sendText(button.dataset.prompt)));
$('#retry').addEventListener('click',()=>{if(lastRequest&&!busy)sendOperation(lastRequest.payload,lastRequest.undo,lastRequest);});
$('#undo-world').addEventListener('click',undoWorld);
$('#show-tree').addEventListener('click',()=>inspector('tree'));$('#show-time').addEventListener('click',()=>inspector('sun'));$('#show-leaf').addEventListener('click',()=>inspector('leaf'));$('#close-inspector').addEventListener('click',()=>{selected=null;leafCompare=null;$('#inspector').hidden=true;render();});
$('#play-leaf').addEventListener('click',()=>{if(gestureSession)return;if(!motionPlaying){playing=true;motionPlaying=true;}else playing=!playing;render();});$('#leaf-time').addEventListener('input',event=>{if(gestureSession)return;playing=false;phase=Number(event.target.value);render();});
$('#draw-leaf-route').addEventListener('click',()=>setDrawing(true));$('#cancel-draw-route').addEventListener('click',()=>setDrawing(false));
$('#reset-leaf-route').addEventListener('click',()=>{if(busy||connecting||codeDraft||gestureSession)return;const original=createScene();finishDirect({leafTrail:[],leafOrigin:original.leafOrigin,leafTarget:original.leafTarget});});
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if($('#shortcut-help').open){event.preventDefault();event.stopImmediatePropagation();$('#shortcut-help').close();return;}if(drawingTrajectory){event.preventDefault();event.stopImmediatePropagation();setDrawing(false);}},true);
let shareFocus,aboutFocus;
function qrSvg(text){const code=qrcode(0,'M');code.addData(text);code.make();const n=code.getModuleCount();let d='';for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(code.isDark(r,c))d+=`M${c+4} ${r+4}h1v1h-1z`;return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n+8} ${n+8}" shape-rendering="crispEdges" aria-hidden="true"><rect width="100%" height="100%" fill="white"/><path d="${d}" fill="#173847"/></svg>`;}
function inviteUrl(){const url=new URL(location.href);url.searchParams.set('control','1');url.hash=new URLSearchParams({room:room.id,key:room.token}).toString();return url.href;}
function renderInvite(error){
 if(error)shareError=error;
 const ready=room?.connected&&!shareUnavailable&&room.expiresAt>Date.now();
 $('#inline-qr-open').disabled=!ready;$('#inline-share-link').disabled=!ready;$('#copy-room').disabled=!ready;$('#inline-room-qr').setAttribute('aria-busy',String(connecting&&!ready));
 if(ready){const link=inviteUrl();if(inviteCache!==link){const svg=qrSvg(link);$('#inline-room-qr').innerHTML=svg;$('#room-qr').innerHTML=svg;inviteCache=link;}$('#room-link').value=link;$('#inline-share-status').textContent='扫一扫，和我修改同一片风景。';$('#inline-share-retry').hidden=true;shareError='';}
 else{inviteCache='';$('#inline-room-qr').replaceChildren();const label=document.createElement('span');label.className='qr-placeholder';label.textContent=connecting?'连接中':'暂未连接';$('#inline-room-qr').append(label);$('#room-qr').replaceChildren();$('#room-link').value='';$('#inline-share-status').textContent=connecting?'正在准备同一房间的二维码…':shareError||'连接已到期，请重新连接。';$('#inline-share-retry').hidden=connecting;}
}
async function showShare(){if(busy&&!room)return;worldGestures?.cancel();shareFocus=document.activeElement;try{await ensureRoom();renderInvite();$('#share-note').textContent='手机扫码后发一句话，这里的风景就会跟着变。';$('#share-dialog').showModal();}catch(error){status(error.message);toast('暂时没有连接成功，二维码尚未生成。');}}
$('#share-world').addEventListener('click',showShare);$('#inline-qr-open').addEventListener('click',showShare);
$('#inline-share-link').addEventListener('click',()=>$('#copy-room').click());
$('#inline-share-retry').addEventListener('click',()=>{if(connecting)return;worldGestures?.cancel();if(editBefore)return;if(shareUnavailable&&room){room=null;lastReply='';lastRequest=null;localHistory=[];history.replaceState(null,'',location.pathname+location.search);}ensureRoom().catch(error=>status(error.message));});
$('#close-share').addEventListener('click',()=>$('#share-dialog').close());$('#share-dialog').addEventListener('close',()=>shareFocus?.focus());
$('#copy-room').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#room-link').value);toast('已复制同一风景的编辑链接。');}catch{$('#room-link').select();toast('请手动复制上面的链接。');}});
$('#about').addEventListener('click',()=>{aboutFocus=document.activeElement;$('#about-dialog').showModal();});$('#close-about').addEventListener('click',()=>$('#about-dialog').close());$('#about-dialog').addEventListener('close',()=>aboutFocus?.focus());
document.addEventListener('visibilitychange',()=>{lastFrame=performance.now();if(document.hidden)clearTimeout(pollTimer);else if(room)pollRoom();});
window.addEventListener('hashchange',()=>{const next=new URLSearchParams(location.hash.slice(1));if(next.get('room')!==(room?.id??null)||next.get('key')!==(room?.token??null)||location.hash.startsWith('#doc='))location.reload();});
codePanel=mountCodePanel($('#code-editor-mount'),{
 onPreview(patch){if(busy||connecting||drawingTrajectory||gestureSession)return;if(!editBefore)editBefore=scene;codeDraft=true;codeBefore=editBefore;scene=updateScene(editBefore,patch);render();status('参数预览 · 点击“应用并同步”共享这次修改。');},
 async onCommit(patch){if(busy||connecting||gestureSession)return;if(!Object.keys(patch).length)return;finishDirect(patch);},
 onCancel(){if(editBefore){scene=editBefore;editBefore=null;}codeDraft=false;render();status(room?'已取消预览 · 显示房间中的风景':'已取消预览。');}
});
render();requestAnimationFrame(animate);hideOpening=setTimeout(()=>$('#opening').classList.add('quiet'),12000);
if(room)quietOpening();ensureRoom().catch(error=>{setConnection('未连接');status(error.message);});
fetch('/api/health',{cache:'no-store'}).then(r=>r.json()).then(info=>{if(info.mode==='commands')$('#model-note').textContent='当前为调景指令模式，支持明确的时间、树木、风雨等命令，没有调用大模型。';}).catch(()=>{});

function keyboardViewport(){const viewport=window.visualViewport;if(!viewport)return;const immersive=document.body.classList.contains('controller')||document.body.classList.contains('focus-mode');const lift=Math.max(0,innerHeight-viewport.height-viewport.offsetTop);document.documentElement.style.setProperty('--keyboard-offset',(immersive?lift:0)+'px');const wasOpen=document.body.classList.contains('keyboard-open');document.body.classList.toggle('keyboard-open',lift>80);if(!immersive&&lift>80&&!wasOpen&&document.activeElement===$('#instruction'))$('#compose').scrollIntoView({block:'center',behavior:reduced?'instant':'smooth'});}
window.visualViewport?.addEventListener('resize',keyboardViewport);window.visualViewport?.addEventListener('scroll',keyboardViewport);$('#instruction').addEventListener('focus',quietOpening);

const stage=$('#live-stage');
stage.append($('#inspector'));
const shortcutsDialog=$('#shortcut-help');stage.append(shortcutsDialog);
$('#shortcut-list').innerHTML=SHORTCUTS.map(item=>`<div><dt><kbd>${esc(item.key)}</kbd></dt><dd><strong>${esc(item.label)}</strong><span>${esc(item.description)}</span></dd></div>`).join('');
function showShortcuts(){shortcutHelpFocus=document.activeElement;if(!shortcutsDialog.open)shortcutsDialog.showModal();}
$('#close-shortcuts').addEventListener('click',()=>shortcutsDialog.close());shortcutsDialog.addEventListener('close',()=>shortcutHelpFocus?.focus({preventScroll:true}));
function scrollToElement(id){const element=document.getElementById(id);element?.scrollIntoView({block:id==='experience'?'center':'start',behavior:reduced?'instant':'smooth'});}
$$('[data-scroll]').forEach(button=>button.addEventListener('click',()=>scrollToElement(button.dataset.scroll)));
$$('[data-start]').forEach(button=>button.addEventListener('click',()=>{scrollToElement('experience');$('#instruction').focus({preventScroll:true});quietOpening();}));
$$('[data-share]').forEach(button=>button.addEventListener('click',()=>{scrollToElement('experience');$('#share-world').click();}));
$$('[data-explore]').forEach(button=>button.addEventListener('click',()=>{scrollToElement('experience');inspector(button.dataset.explore);}));
let focusScroll=0,nativePresentation=false,presentationTimer;
const fullscreenElement=()=>document.fullscreenElement??document.webkitFullscreenElement;
function revealPresentationTools(){
 clearTimeout(presentationTimer);stage.classList.add('presentation-ui-visible');
 presentationTimer=setTimeout(()=>{if(!$('#presentation-tools').contains(document.activeElement))stage.classList.remove('presentation-ui-visible');},2600);
}
function setFocusMode(enabled){
 const wasEnabled=document.body.classList.contains('focus-mode');if(enabled&&!wasEnabled)focusScroll=window.scrollY;
 document.body.classList.toggle('focus-mode',enabled);$('#focus-world').setAttribute('aria-pressed',String(enabled));
 $('#focus-world').setAttribute('aria-label',enabled?'退出风景全屏':'全屏展示风景');
 if(enabled){quietOpening();$('#inspector').hidden=true;revealPresentationTools();}
 else{clearTimeout(presentationTimer);stage.classList.remove('presentation-ui-visible');if(wasEnabled)window.scrollTo({top:focusScroll,behavior:'instant'});$('#focus-world').focus({preventScroll:true});}
 keyboardViewport();render();updateIntroPlayback();
}
async function enterPresentation(){
 setFocusMode(true);
 backgroundMusic?.activate();
 try{
  if(stage.requestFullscreen)await stage.requestFullscreen({navigationUI:'hide'});
  else if(stage.webkitRequestFullscreen)await stage.webkitRequestFullscreen();
  else toast('当前浏览器不支持整屏展示，已铺满网页；电脑可使用浏览器的全屏命令。');
 }catch{toast('浏览器未允许整屏展示，已铺满网页；可使用浏览器的全屏命令。');}
}
async function exitPresentation(){
 try{if(fullscreenElement()===stage){if(document.exitFullscreen)await document.exitFullscreen();else if(document.webkitExitFullscreen)await document.webkitExitFullscreen();}}catch{}
 if(fullscreenElement()!==stage){nativePresentation=false;setFocusMode(false);}
}
$('#focus-world').addEventListener('click',()=>document.body.classList.contains('focus-mode')?exitPresentation():enterPresentation());
$('#exit-presentation').addEventListener('click',exitPresentation);
function fullscreenChanged(){
 if(fullscreenElement()===stage){nativePresentation=true;setFocusMode(true);}
 else if(nativePresentation){nativePresentation=false;setFocusMode(false);}
}
document.addEventListener('fullscreenchange',fullscreenChanged);document.addEventListener('webkitfullscreenchange',fullscreenChanged);
for(const name of ['pointermove','pointerdown','focusin'])stage.addEventListener(name,()=>{if(document.body.classList.contains('focus-mode'))revealPresentationTools();});
$('#presentation-tools').addEventListener('focusout',()=>{if(document.body.classList.contains('focus-mode'))revealPresentationTools();});
function updateCodeToggle(){const mobile=matchMedia('(max-width:900px)').matches;const visible=mobile?document.body.classList.contains('mobile-code-open'):!document.body.classList.contains('code-hidden');$('#toggle-code').setAttribute('aria-pressed',String(visible));$('#toggle-code-label').textContent=mobile?(visible?'收起代码':'查看代码'):'代码对照';}
$('#toggle-code').addEventListener('click',()=>{if(matchMedia('(max-width:900px)').matches){document.body.classList.toggle('mobile-code-open');if(document.body.classList.contains('mobile-code-open'))$('.code-side').scrollIntoView({block:'start',behavior:reduced?'instant':'smooth'});}else document.body.classList.toggle('code-hidden');updateCodeToggle();render();});
matchMedia('(max-width:900px)').addEventListener('change',updateCodeToggle);updateCodeToggle();
document.addEventListener('keydown',event=>{
 if(event.defaultPrevented||document.querySelector('dialog[open]'))return;
 if(event.key==='Escape'&&document.body.classList.contains('focus-mode'))exitPresentation();
 if(event.key.toLowerCase()==='f'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.repeat&&!event.target.closest('input,textarea,select,[contenteditable]')){event.preventDefault();document.body.classList.contains('focus-mode')?exitPresentation():enterPresentation();}
});
new ResizeObserver(()=>render()).observe(stage);
new IntersectionObserver(entries=>{stageVisible=entries[0]?.isIntersecting??true;if(stageVisible){lastFrame=performance.now();render();}},{rootMargin:'100px'}).observe(stage);

const introVideo=$('#intro-video');
introVideo.defaultMuted=true;introVideo.muted=true;
backgroundMusic=mountLandscapeMusic(stage,{introVideo});
let introVisible=false,introUserPaused=false,introSystemPause=false,introPlayRequest=null,introAbortRetries=0,introReadyRetried=false,introGestureRetried=false;
function introEligible(){return introVisible&&!connecting&&!document.hidden&&!document.body.classList.contains('controller')&&!document.body.classList.contains('focus-mode');}
function introCaption(){if(introVideo.error){$('#intro-video-status').textContent='视频暂未加载成功，可以使用播放控件重试。';return;}$('#intro-video-status').textContent=introVideo.paused?'已暂停 · 可使用播放控件继续':introVideo.muted?'15 秒真实操作 · 可开启原版配乐':'15 秒真实操作 · 原版配乐';}
function updateIntroPlayback(){
 if(!introEligible()){if(!introVideo.paused){introSystemPause=true;introVideo.pause();}return;}
 if(introUserPaused||!introVideo.paused||introPlayRequest)return;
 let aborted=false;
 introVideo.autoplay=true;introPlayRequest=introVideo.play().catch(error=>{aborted=error?.name==='AbortError';$('#intro-video-status').textContent=introVideo.error?'视频暂未加载成功，可以使用播放控件重试。':'影片已直接展示，点击播放控件即可继续。';}).finally(()=>{
  introPlayRequest=null;
  if(!introEligible()){if(!introVideo.paused){introSystemPause=true;introVideo.pause();}return;}
  if(aborted&&!introUserPaused&&introVideo.paused&&introAbortRetries<1){introAbortRetries++;updateIntroPlayback();}
 });
}
introVideo.addEventListener('play',()=>{introUserPaused=false;introCaption();});
introVideo.addEventListener('playing',introCaption);
introVideo.addEventListener('pause',()=>{if(introSystemPause)introSystemPause=false;else if(introEligible())introUserPaused=true;introCaption();});
introVideo.addEventListener('volumechange',introCaption);
introVideo.addEventListener('error',introCaption);
const retryIntroWhenReady=()=>{if(introReadyRetried||introUserPaused||introPlayRequest||!introVideo.paused||!introEligible())return;introReadyRetried=true;updateIntroPlayback();};
introVideo.addEventListener('loadeddata',retryIntroWhenReady);introVideo.addEventListener('canplay',retryIntroWhenReady);
const retryIntroAfterGesture=event=>{if(!event.isTrusted||introGestureRetried||introUserPaused||introPlayRequest||!introVideo.paused||!introEligible()||event.target.closest?.('#intro-video'))return;introGestureRetried=true;updateIntroPlayback();};
document.addEventListener('pointerdown',retryIntroAfterGesture,{capture:true});document.addEventListener('keydown',retryIntroAfterGesture,{capture:true});
document.addEventListener('visibilitychange',updateIntroPlayback);
new IntersectionObserver(entries=>{introVisible=(entries[0]?.intersectionRatio??0)>=.15;updateIntroPlayback();},{threshold:[0,.15]}).observe(introVideo);
if(document.body.classList.contains('controller')){introVideo.autoplay=false;introVideo.removeAttribute('autoplay');updateIntroPlayback();}

worldGestures=mountWorldGestures(stage,{
 getScene:()=>scene,getObjects:()=>renderer.getObjectPositions(),getSelectedId:()=>directEditor.selectedId,
 isBusy:()=>busy||connecting||codeDraft||drawingTrajectory||(!gestureSession&&!!editBefore),
 begin:beginGesture,preview:previewGesture,commit:commitGesture,cancel:cancelGesturePreview,
 select(id){directEditor.select(/^(tree|boat|mountain|bird):\d+$/.test(id??'')?id:null);if(['leaf','leafOrigin','leafTarget','draw:leaf'].includes(id)){selected='leaf';leafCompare=scene;render();}},
 command:gestureCommand,editState:id=>directEditor.editState(id),undo:undoWorld,redo:redoWorld,reset:resetLandscape,
 toggleMotion(){motionPlaying=!motionPlaying;render();},
 fullscreen:()=>document.body.classList.contains('focus-mode')?exitPresentation():enterPresentation(),
 music:()=>stage.querySelector('.music-toggle')?.click()
});
renderControls();
