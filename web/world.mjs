import qrcode from 'qrcode-generator';
import {createScene,validateScene,updateScene,sceneChanges} from './scene-model.mjs';
import {mountLandscape} from './scene-renderer.mjs';
const $=selector=>document.querySelector(selector),$$=selector=>[...document.querySelectorAll(selector)];
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
if(location.hash.startsWith('#doc='))location.replace('/legacy/app/'+location.search+location.hash);
const STORAGE='teamlink-landscape-v1';
let scene=createScene(),room=null,busy=false,pollTimer=null,pollDelay=1400,polling=false,localHistory=[],latestChanges=[],lastReply='',lastRequest=null;
let selected=null,editBefore=null,leafCompare=null,phase=0,playing=true,lastFrame=performance.now(),toastTimer,hideOpening,stageVisible=true;
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
 for(const [id,key] of [['hour-range','hour'],['angle-range','branchAngle'],['depth-range','branchDepth'],['wind-range','wind']]){const input=$('#'+id);if(input!==document.activeElement)input.value=String(scene[key]);input.disabled=busy;}
 $('#undo-world').disabled=busy||(!room&&!localHistory.length)||(room&&!room.messages?.some(m=>m.changes?.length));
 $('#send').disabled=busy;$$('.suggestions button').forEach(button=>button.disabled=busy);$('#share-world').disabled=busy&&!room;
 $('#suggestions').hidden=!!lastReply||!!room?.messages?.length;
 $('#play-leaf').textContent=playing?'Ⅱ':'▶';
 document.body.classList.toggle('night-scene',scene.hour<6||scene.hour>=19.5);document.body.dataset.hour=String(scene.hour);document.body.dataset.trees=String(scene.trees);document.body.dataset.revision=String(room?.revision??0);
}
function render(){renderer.render(scene,{phase,showTrajectory:selected==='leaf',compareScene:leafCompare});renderControls();}
function inspector(kind){selected=kind;$('#inspector').hidden=!kind;$$('[data-inspector]').forEach(node=>node.hidden=node.dataset.inspector!==kind);$('#inspector-title').textContent=kind==='tree'?'这棵树怎样生长':kind==='leaf'?'把落叶的过程摊开看':'太阳与时间';if(kind==='leaf')leafCompare=scene;render();quietOpening();}
const renderer=mountLandscape($('#landscape'),{onSunDrag(hour,dragPhase){if(busy)return;if(dragPhase==='start')editBefore=scene;scene=updateScene(scene,{hour});render();quietOpening();if(dragPhase==='end')finishDirect({hour});},onTreeSelect:()=>inspector('tree'),onLeafSelect:()=>inspector('leaf')});
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
 else if(last.kind==='unsupported')status('可以再试试改变时间、风雨或树木。');
 else status(room.mode==='ai'?'豆包理解 · 修改已同步到同一风景':'调景指令模式 · 修改已同步');
}
function acceptState(state){
 if(!state||!state.scene||!Number.isSafeInteger(state.revision))throw Error('服务器状态无效');
 if(room&&state.id===room.id&&state.revision<room.revision)return false;
 scene=validateScene(state.scene);room={...room,...state,connected:true};
 if(lastRequest&&room.messages?.some(message=>message.nonce===lastRequest.nonce&&message.kind!=='pending'))$('#retry').hidden=true;
 setConnection('同一风景 · 已连接',true);renderMessages();render();
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
 if(room?.connected)return;
 if(room){const {data}=await request('/api/rooms/'+room.id,{timeout:10000});acceptState(data);schedulePoll();return;}
 setConnection('正在连接…');
 const {data}=await request('/api/rooms',{method:'POST',body:{scene},timeout:12000});room={...data,connected:true};
 history.replaceState(null,'',location.pathname+location.search+'#'+new URLSearchParams({room:room.id,key:room.token}));
 acceptState(data);schedulePoll();
}
function schedulePoll(){clearTimeout(pollTimer);if(room&&!document.hidden)pollTimer=setTimeout(pollRoom,pollDelay);}
async function pollRoom(){
 if(!room||polling||document.hidden){schedulePoll();return;}polling=true;
 try{const {data}=await request('/api/rooms/'+room.id,{timeout:10000});pollDelay=1400;if(!editBefore&&(data.revision!==room.revision||!room.connected))acceptState(data);else if(data.revision===room.revision)setConnection('同一风景 · 已连接',true);
 if(!room.messages?.some(m=>m.kind==='pending')&&busy&&!lastRequest?.inFlight){busy=false;renderControls();}
 }catch(error){pollDelay=Math.min(pollDelay*1.7,8000);setConnection(error.status===410?'风景链接已到期':'连接暂时中断');if(error.status===410){clearTimeout(pollTimer);polling=false;status('房间已到期，刷新或回到首页创建新的风景。');return;}}
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
async function sendText(text){if(!text.trim()||busy)return;$('#instruction').value='';await sendOperation({text:text.trim()});}
function finishDirect(patch){
 const before=editBefore??scene;editBefore=null;const next=updateScene(before,patch);const changes=sceneChanges(before,next);scene=next;if(!changes.length){render();return;}
 if(room){scene=before;render();sendOperation({patch});}
 else{localHistory.push(before);if(localHistory.length>15)localHistory.shift();saveLocal();showChanges(changes);lastReply='直接修改，结果已经在画面上。';status('点“扫码一起改”，让手机也能修改这一幅。');render();}
}
for(const [id,key] of [['hour-range','hour'],['angle-range','branchAngle'],['depth-range','branchDepth'],['wind-range','wind']]){
 const input=$('#'+id);input.addEventListener('input',()=>{if(busy)return;if(!editBefore)editBefore=scene;scene=updateScene(scene,{[key]:Number(input.value)});render();quietOpening();});input.addEventListener('change',()=>{if(busy)return;finishDirect({[key]:Number(input.value)});});
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
$('#share-world').addEventListener('click',async()=>{if(busy&&!room)return;shareFocus=document.activeElement;try{await ensureRoom();const url=new URL(location.href);url.searchParams.set('control','1');$('#room-link').value=url.href;$('#room-qr').innerHTML=qrSvg(url.href);$('#share-note').textContent='手机扫码后发一句话，这里的风景就会跟着变。';$('#share-dialog').showModal();}catch(error){status(error.message);toast('暂时没有连接成功，二维码尚未生成。');}});
$('#close-share').addEventListener('click',()=>$('#share-dialog').close());$('#share-dialog').addEventListener('close',()=>shareFocus?.focus());
$('#copy-room').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#room-link').value);toast('已复制同一风景的编辑链接。');}catch{$('#room-link').select();toast('请手动复制上面的链接。');}});
$('#about').addEventListener('click',()=>{aboutFocus=document.activeElement;$('#about-dialog').showModal();});$('#close-about').addEventListener('click',()=>$('#about-dialog').close());$('#about-dialog').addEventListener('close',()=>aboutFocus?.focus());
document.addEventListener('visibilitychange',()=>{lastFrame=performance.now();if(document.hidden)clearTimeout(pollTimer);else if(room)pollRoom();});
window.addEventListener('hashchange',()=>{const next=new URLSearchParams(location.hash.slice(1));if(next.get('room')!==(room?.id??null)||next.get('key')!==(room?.token??null)||location.hash.startsWith('#doc='))location.reload();});
render();requestAnimationFrame(animate);hideOpening=setTimeout(()=>$('#opening').classList.add('quiet'),12000);
if(room){quietOpening();status('正在连接手机与大屏共享的风景…');ensureRoom().catch(error=>{setConnection('未连接');status(error.message);});}
fetch('/api/health',{cache:'no-store'}).then(r=>r.json()).then(info=>{if(info.mode==='commands')$('#model-note').textContent='当前为调景指令模式，支持明确的时间、树木、风雨等命令，没有调用大模型。';}).catch(()=>{});

function keyboardViewport(){const viewport=window.visualViewport;if(!viewport)return;const immersive=document.body.classList.contains('controller')||document.body.classList.contains('focus-mode');const lift=Math.max(0,innerHeight-viewport.height-viewport.offsetTop);document.documentElement.style.setProperty('--keyboard-offset',(immersive?lift:0)+'px');const wasOpen=document.body.classList.contains('keyboard-open');document.body.classList.toggle('keyboard-open',lift>80);if(!immersive&&lift>80&&!wasOpen&&document.activeElement===$('#instruction'))$('#compose').scrollIntoView({block:'center',behavior:reduced?'instant':'smooth'});}
window.visualViewport?.addEventListener('resize',keyboardViewport);window.visualViewport?.addEventListener('scroll',keyboardViewport);$('#instruction').addEventListener('focus',quietOpening);

const stage=$('#live-stage');
function scrollToElement(id){const element=document.getElementById(id);element?.scrollIntoView({block:id==='experience'?'center':'start',behavior:reduced?'instant':'smooth'});}
$$('[data-scroll]').forEach(button=>button.addEventListener('click',()=>scrollToElement(button.dataset.scroll)));
$$('[data-start]').forEach(button=>button.addEventListener('click',()=>{scrollToElement('experience');$('#instruction').focus({preventScroll:true});quietOpening();}));
$$('[data-share]').forEach(button=>button.addEventListener('click',()=>{scrollToElement('experience');$('#share-world').click();}));
$$('[data-explore]').forEach(button=>button.addEventListener('click',()=>{scrollToElement('experience');inspector(button.dataset.explore);}));
let focusScroll=0;
function setFocusMode(enabled){if(enabled)focusScroll=window.scrollY;document.body.classList.toggle('focus-mode',enabled);$('#focus-world').setAttribute('aria-pressed',String(enabled));$('#focus-world').setAttribute('aria-label',enabled?'收起风景':'展开风景');if(!enabled)window.scrollTo({top:focusScroll,behavior:'instant'});keyboardViewport();render();}
$('#focus-world').addEventListener('click',()=>setFocusMode(!document.body.classList.contains('focus-mode')));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')&&document.body.classList.contains('focus-mode'))setFocusMode(false);});
new ResizeObserver(()=>render()).observe(stage);
new IntersectionObserver(entries=>{stageVisible=entries[0]?.isIntersecting??true;if(stageVisible){lastFrame=performance.now();render();}},{rootMargin:'100px'}).observe(stage);
