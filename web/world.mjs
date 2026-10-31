import qrcode from 'qrcode-generator';
import {createScene,validateScene,updateScene,sceneChanges} from './scene-model.mjs';
import {mountLandscape} from './scene-renderer.mjs';
import {mountCodePanel} from './code-panel.mjs';
const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
if(location.hash.startsWith('#doc='))location.replace('/legacy/app/'+location.search+location.hash);
const STORAGE='teamlink-landscape-v1';
let scene=createScene(),room=null,busy=false,pollTimer=null,pollDelay=1400,polling=false,localHistory=[],latestChanges=[],lastReply='',lastRequest=null;
let selected=null,editBefore=null,leafCompare=null,phase=0,playing=true,lastFrame=performance.now(),toastTimer,hideOpening,stageVisible=true;
let codePanel=null,codeBefore=null,codeDraft=false,roomConnection=null,connecting=true,shareUnavailable=false,shareError='',inviteCache='',expiryTimer;
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;if(reduced)playing=false;
try{const raw=localStorage.getItem(STORAGE);if(raw)scene=validateScene(JSON.parse(raw));}catch{}
const hash=new URLSearchParams(location.hash.slice(1));
if(/^[0-9a-f]{32}$/.test(hash.get('room')??'')&&/^[0-9a-f]{64}$/.test(hash.get('key')??''))room={id:hash.get('room'),token:hash.get('key'),revision:0,connected:false,messages:[]};
if(new URLSearchParams(location.search).get('control')==='1')document.body.classList.add('controller');
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3200);}
function status(text){$('#compose-status').textContent=text;}
function quietOpening(){clearTimeout(hideOpening);$('#opening').classList.add('quiet');}
function saveLocal(){if(!room){try{localStorage.setItem(STORAGE,JSON.stringify(scene));}catch{}}}
function formatHour(hour){const total=Math.round((hour%24)*60);return String(Math.floor(total/60)).padStart(2,'0')+':'+String(total%60).padStart(2,'0');}
function value(key,value){if(key==='hour')return formatHour(value);if(key==='rain'||key==='wind')return Math.round(value*100)+'%';if(key==='branchAngle')return value+'°';if(typeof value==='boolean')return value?'有':'无';return String(value);}
function showChanges(changes){latestChanges=changes;$('#change-chips').innerHTML=changes.map(item=>`<span>${esc(item.label)} ${esc(value(item.key,item.before))} → ${esc(value(item.key,item.after))}</span>`).join('');}
function renderControls(){
 $('#time-label').textContent=formatHour(scene.hour);$('#hour-value').textContent=formatHour(scene.hour);$('#angle-value').textContent=scene.branchAngle+'°';$('#depth-value').textContent=scene.branchDepth;$('#wind-value').textContent=Math.round(scene.wind*100)+'%';
 for(const [id,key] of [['hour-range','hour'],['angle-range','branchAngle'],['depth-range','branchDepth'],['wind-range','wind']]){const input=$('#'+id);if(input!==document.activeElement)input.value=String(scene[key]);input.disabled=busy||connecting||codeDraft;}
 $('#undo-world').disabled=busy||connecting||codeDraft||(!room&&!localHistory.length)||(room&&!room.messages?.some(m=>m.changes?.length));
 $('#send').disabled=busy||connecting||codeDraft;$$('.suggestions button').forEach(button=>button.disabled=busy||connecting||codeDraft);$('#share-world').disabled=busy&&!room;
 $('#suggestions').hidden=!!lastReply||!!room?.messages?.length;
 $('#play-leaf').textContent=playing?'Ⅱ':'▶';
 document.body.classList.toggle('night-scene',scene.hour<6||scene.hour>=19.5);document.body.dataset.hour=String(scene.hour);document.body.dataset.trees=String(scene.trees);document.body.dataset.boats=String(scene.boats);document.body.dataset.mountains=String(scene.mountains);document.body.dataset.revision=String(room?.revision??0);
 codePanel?.update(scene,{before:codeBefore??scene,selected,busy:busy||connecting});
}
function render(){renderer.render(scene,{phase,showTrajectory:selected==='leaf',compareScene:leafCompare});if(document.body.classList.contains('mobile-code-open'))previewRenderer.render(scene,{phase,showTrajectory:selected==='leaf',compareScene:leafCompare});renderControls();}
function inspector(kind){selected=kind;$('#inspector').hidden=!kind;$$('[data-inspector]').forEach(node=>node.hidden=node.dataset.inspector!==kind);$('#inspector-title').textContent=kind==='tree'?'这棵树怎样生长':kind==='leaf'?'把落叶的过程摊开看':'太阳与时间';if(kind==='leaf')leafCompare=scene;render();quietOpening();}
const renderer=mountLandscape($('#landscape'),{onSunDrag(hour,dragPhase){if(busy||connecting||codeDraft)return;if(dragPhase==='start')editBefore=scene;scene=updateScene(scene,{hour});render();quietOpening();if(dragPhase==='end')finishDirect({hour});},onTreeSelect:()=>inspector('tree'),onLeafSelect:()=>inspector('leaf')});
const previewRenderer=mountLandscape($('#code-preview-landscape'));
function animate(now){const delta=Math.min((now-lastFrame)/1000,.1);lastFrame=now;if(playing&&stageVisible&&!document.hidden){phase=(phase+delta/7)%1;renderer.render(scene,{phase,showTrajectory:selected==='leaf',compareScene:leafCompare});if(selected==='leaf'&&$('#leaf-time')!==document.activeElement)$('#leaf-time').value=String(phase);}requestAnimationFrame(animate);}
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
 scene=validateScene(state.scene);room={...room,...state,connected:true};codeDraft=false;editBefore=null;
 const lastChange=[...(room.messages??[])].reverse().find(message=>message.changes?.length);
 codeBefore=lastChange?updateScene(scene,Object.fromEntries(lastChange.changes.map(change=>[change.key,change.before]))):scene;
 codePanel?.update(scene,{before:codeBefore,selected,busy:busy||connecting,resetDraft:true});
 if(lastRequest&&room.messages?.some(message=>message.nonce===lastRequest.nonce&&message.kind!=='pending'))$('#retry').hidden=true;
 shareUnavailable=false;setConnection('同一风景 · 已连接',true);renderMessages();render();renderInvite();
 return true;
}
async function request(path,{method='GET',body,timeout=29000}={}){
 const headers={};if(room?.token)headers.Authorization='Bearer '+room.token;if(body)headers['Content-Type']='application/json';
 const response=await fetch(path,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout),cache:'no-store'});
 const data=await response.json().catch(()=>({error:'服务暂时无法读取。'}));
 if(!response.ok){const error=Error(data.error??'请求没有完成。');error.status=response.status;error.current=data.current;error.code=data.code;throw error;}
 return {data,status:response.status};
}
async function ensureRoom(){
 if(room?.connected&&!shareUnavailable&&room.expiresAt>Date.now())return;
 if(roomConnection)return roomConnection;
 connecting=true;renderControls();renderInvite();
 roomConnection=(async()=>{
  if(room){const {data}=await request('/api/rooms/'+room.id,{timeout:10000});acceptState(data);}
  else{setConnection('正在连接…');const {data}=await request('/api/rooms',{method:'POST',body:{scene},timeout:12000});room={...data,connected:true};history.replaceState(null,'',location.pathname+location.search+'#'+new URLSearchParams({room:room.id,key:room.token}));acceptState(data);}
  clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{shareUnavailable=true;renderInvite();},Math.max(0,room.expiresAt-Date.now()));schedulePoll();
 })().catch(error=>{if(room)room.connected=false;shareUnavailable=true;renderInvite(error.message);throw error;}).finally(()=>{connecting=false;roomConnection=null;render();renderInvite();});
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
async function sendOperation(payload,undo=false,retryRequest=null){
 if(busy)return;busy=true;quietOpening();$('#retry').hidden=true;renderControls();
 const operation=retryRequest&&!retryRequest.retryAsNew?retryRequest:{payload,undo,nonce:crypto.randomUUID()};
 operation.inFlight=true;operation.retryAsNew=false;lastRequest=operation;const {nonce}=operation;
 try{await ensureRoom();operation.expectedRevision??=room.revision;const {data,status:httpStatus}=await request('/api/rooms/'+room.id+(undo?'/undo':''),{method:'POST',body:{nonce,expectedRevision:operation.expectedRevision,...operation.payload}});acceptState(data);if(httpStatus===202&&room.messages?.some(message=>message.nonce===nonce&&message.kind==='pending')){status('请求仍在处理中，正在同步实际结果。');busy=true;}else busy=false;
 }catch(error){if(error.current)acceptState(error.current);busy=false;if(error.status===409){status('风景刚在另一端变化了，已更新到最新状态。请再试这次修改。');}else{status(error.message==='The operation was aborted due to timeout'?'请求尚未确认，正在读取房间中的实际结果。':error.message);}
 if(room&&(!error.status||error.status>=500)){try{const {data}=await request('/api/rooms/'+room.id,{timeout:8000});acceptState(data);busy=data.messages?.some(m=>m.nonce===nonce&&m.kind==='pending')??false;}catch{}}
 const recorded=room?.messages?.find(message=>message.nonce===nonce);
 operation.retryAsNew=error.status===409&&!recorded;
 $('#retry').hidden=busy||!!(recorded&&recorded.kind!=='pending')||!!(error.status&&error.status<500&&![409,429].includes(error.status));
 }finally{operation.inFlight=false;renderControls();schedulePoll();}
}
async function sendText(text){if(!text.trim()||busy||codeDraft||connecting)return;$('#instruction').value='';await sendOperation({text:text.trim()});}
function finishDirect(patch){
 const before=editBefore??scene;editBefore=null;codeDraft=false;const next=updateScene(before,patch);const changes=sceneChanges(before,next);scene=next;if(!changes.length){render();return;}
 codeBefore=before;
 if(room){scene=before;render();sendOperation({patch});}
 else{localHistory.push(before);if(localHistory.length>15)localHistory.shift();saveLocal();showChanges(changes);lastReply='直接修改，结果已经在画面上。';status('当前为本机预览，重新连接后可以共享。');codePanel?.update(scene,{before,selected,resetDraft:true});render();}
}
for(const [id,key] of [['hour-range','hour'],['angle-range','branchAngle'],['depth-range','branchDepth'],['wind-range','wind']]){
 const input=$('#'+id);input.addEventListener('input',()=>{if(busy||connecting)return;if(!editBefore)editBefore=scene;scene=updateScene(scene,{[key]:Number(input.value)});render();quietOpening();});input.addEventListener('change',()=>{if(busy||connecting)return;finishDirect({[key]:Number(input.value)});});
}
$('#compose').addEventListener('submit',event=>{event.preventDefault();sendText($('#instruction').value);});
$('#instruction').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('#compose').requestSubmit();}});
$$('[data-prompt]').forEach(button=>button.addEventListener('click',()=>sendText(button.dataset.prompt)));
$('#retry').addEventListener('click',()=>{if(lastRequest&&!busy)sendOperation(lastRequest.payload,lastRequest.undo,lastRequest);});
$('#undo-world').addEventListener('click',()=>{if(busy)return;if(room)sendOperation({},true);else{const before=scene;scene=localHistory.pop()??scene;showChanges(sceneChanges(before,scene));saveLocal();render();toast('已撤销这次修改。');}});
$('#show-tree').addEventListener('click',()=>inspector('tree'));$('#show-time').addEventListener('click',()=>inspector('sun'));$('#show-leaf').addEventListener('click',()=>inspector('leaf'));$('#close-inspector').addEventListener('click',()=>{selected=null;leafCompare=null;$('#inspector').hidden=true;render();});
$('#play-leaf').addEventListener('click',()=>{playing=!playing;renderControls();});$('#leaf-time').addEventListener('input',event=>{playing=false;phase=Number(event.target.value);render();});
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
async function showShare(){if(busy&&!room)return;shareFocus=document.activeElement;try{await ensureRoom();renderInvite();$('#share-note').textContent='手机扫码后发一句话，这里的风景就会跟着变。';$('#share-dialog').showModal();}catch(error){status(error.message);toast('暂时没有连接成功，二维码尚未生成。');}}
$('#share-world').addEventListener('click',showShare);$('#inline-qr-open').addEventListener('click',showShare);
$('#inline-share-link').addEventListener('click',()=>$('#copy-room').click());
$('#inline-share-retry').addEventListener('click',()=>{if(connecting)return;if(shareUnavailable&&room){room=null;lastReply='';lastRequest=null;localHistory=[];history.replaceState(null,'',location.pathname+location.search);}ensureRoom().catch(error=>status(error.message));});
$('#close-share').addEventListener('click',()=>$('#share-dialog').close());$('#share-dialog').addEventListener('close',()=>shareFocus?.focus());
$('#copy-room').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#room-link').value);toast('已复制同一风景的编辑链接。');}catch{$('#room-link').select();toast('请手动复制上面的链接。');}});
$('#about').addEventListener('click',()=>{aboutFocus=document.activeElement;$('#about-dialog').showModal();});$('#close-about').addEventListener('click',()=>$('#about-dialog').close());$('#about-dialog').addEventListener('close',()=>aboutFocus?.focus());
document.addEventListener('visibilitychange',()=>{lastFrame=performance.now();if(document.hidden)clearTimeout(pollTimer);else if(room)pollRoom();});
window.addEventListener('hashchange',()=>{const next=new URLSearchParams(location.hash.slice(1));if(next.get('room')!==(room?.id??null)||next.get('key')!==(room?.token??null)||location.hash.startsWith('#doc='))location.reload();});
codePanel=mountCodePanel($('#code-editor-mount'),{
 onPreview(patch){if(busy||connecting)return;if(!editBefore)editBefore=scene;codeDraft=true;codeBefore=editBefore;scene=updateScene(editBefore,patch);render();status('参数预览 · 点击“应用并同步”共享这次修改。');},
 async onCommit(patch){if(busy||connecting)return;if(!Object.keys(patch).length)return;finishDirect(patch);},
 onCancel(){if(editBefore){scene=editBefore;editBefore=null;}codeDraft=false;render();status(room?'已取消预览 · 显示房间中的风景':'已取消预览。');}
});
render();requestAnimationFrame(animate);hideOpening=setTimeout(()=>$('#opening').classList.add('quiet'),12000);
if(room)quietOpening();ensureRoom().catch(error=>{setConnection('未连接');status(error.message);});
fetch('/api/health',{cache:'no-store'}).then(r=>r.json()).then(info=>{if(info.mode==='commands')$('#model-note').textContent='当前为调景指令模式，支持明确的时间、树木、风雨等命令，没有调用大模型。';}).catch(()=>{});

function keyboardViewport(){const viewport=window.visualViewport;if(!viewport)return;const immersive=document.body.classList.contains('controller')||document.body.classList.contains('focus-mode');const lift=Math.max(0,innerHeight-viewport.height-viewport.offsetTop);document.documentElement.style.setProperty('--keyboard-offset',(immersive?lift:0)+'px');const wasOpen=document.body.classList.contains('keyboard-open');document.body.classList.toggle('keyboard-open',lift>80);if(!immersive&&lift>80&&!wasOpen&&document.activeElement===$('#instruction'))$('#compose').scrollIntoView({block:'center',behavior:reduced?'instant':'smooth'});}
window.visualViewport?.addEventListener('resize',keyboardViewport);window.visualViewport?.addEventListener('scroll',keyboardViewport);$('#instruction').addEventListener('focus',quietOpening);

const stage=$('#live-stage');
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
 if(document.querySelector('dialog[open]'))return;
 if(event.key==='Escape'&&document.body.classList.contains('focus-mode'))exitPresentation();
 if(event.key.toLowerCase()==='f'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.repeat&&!event.target.closest('input,textarea,select,[contenteditable]')){event.preventDefault();document.body.classList.contains('focus-mode')?exitPresentation():enterPresentation();}
});
new ResizeObserver(()=>render()).observe(stage);
new IntersectionObserver(entries=>{stageVisible=entries[0]?.isIntersecting??true;if(stageVisible){lastFrame=performance.now();render();}},{rootMargin:'100px'}).observe(stage);

const introVideo=$('#intro-video');
introVideo.defaultMuted=true;introVideo.muted=true;
let introVisible=false,introUserPaused=false,introSystemPause=false,introPlayRequest=null;
function introEligible(){return introVisible&&!document.hidden&&!document.body.classList.contains('controller')&&!document.body.classList.contains('focus-mode');}
function introCaption(){if(introVideo.error){$('#intro-video-status').textContent='视频暂未加载成功，可以使用播放控件重试。';return;}$('#intro-video-status').textContent=introVideo.paused?'已暂停 · 可使用播放控件继续':introVideo.muted?'静音自动播放 · 可直接开启声音':'正在播放 · 中文字幕与原创配乐';}
function updateIntroPlayback(){
 if(!introEligible()){if(!introVideo.paused){introSystemPause=true;introVideo.pause();}return;}
 if(introUserPaused||!introVideo.paused||introPlayRequest)return;
 introPlayRequest=introVideo.play().catch(()=>{$('#intro-video-status').textContent=introVideo.error?'视频暂未加载成功，可以使用播放控件重试。':'影片已直接展示，点击播放控件即可继续。';}).finally(()=>{introPlayRequest=null;if(!introEligible()&&!introVideo.paused){introSystemPause=true;introVideo.pause();}});
}
introVideo.addEventListener('play',()=>{introUserPaused=false;introCaption();});
introVideo.addEventListener('playing',introCaption);
introVideo.addEventListener('pause',()=>{if(introSystemPause)introSystemPause=false;else if(introEligible())introUserPaused=true;introCaption();});
introVideo.addEventListener('volumechange',introCaption);
introVideo.addEventListener('error',introCaption);
document.addEventListener('visibilitychange',updateIntroPlayback);
new IntersectionObserver(entries=>{introVisible=(entries[0]?.intersectionRatio??0)>=.15;updateIntroPlayback();},{threshold:[0,.15]}).observe(introVideo);
if(document.body.classList.contains('controller')){introVideo.autoplay=false;introVideo.removeAttribute('autoplay');updateIntroPlayback();}
