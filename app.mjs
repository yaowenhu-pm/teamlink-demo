import {createDocument,validateDocument,updateDocument,evaluateExport,evaluateContexts,filterRows,toCsv,serializeDocument,parseDocument,encodeFragment,decodeFragment,LIMITS} from './canvas-model.mjs';
const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ENTRY='https://yaowenhu.cn/teamlink-demo/';
const STORAGE='teamlink-creative-canvas-v1';
let spec=createDocument(),baseline=null,undo=[],redo=[],stepId='before',lastGroup='',lastEdit=0;
let fromShared=false,storageOkay=true,playing=null,toastTimer,errorTimer,drag=null;
const composing=new WeakSet();
try{
 if(location.hash.startsWith('#doc=')){
  spec=decodeFragment(location.hash);fromShared=true;try{const saved=JSON.parse(sessionStorage.getItem(STORAGE+'-shared')||'null');if(saved&&serializeDocument(validateDocument(saved.document))===serializeDocument(spec))baseline=saved.baseline?validateDocument(saved.baseline):null;}catch{}
  $('#recovery').textContent='已打开分享的作品副本。你可以直接继续改，原作者的版本不会被覆盖。';$('#recovery').hidden=false;
 }else{
  const raw=localStorage.getItem(STORAGE);
  if(raw){if(raw.length>100000)throw Error();const saved=JSON.parse(raw);spec=validateDocument(saved.document);baseline=saved.baseline?validateDocument(saved.baseline):null;}
 }
}catch{
 $('#recovery').textContent='这份存档或分享链接无法读取，已打开默认作品。你仍可导入有效的 JSON 备份。';$('#recovery').hidden=false;
}
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3200);}
function problem(message){$('#edit-error').textContent=message;$('#edit-error').hidden=false;clearTimeout(errorTimer);errorTimer=setTimeout(()=>$('#edit-error').hidden=true,5000);}
function persist(){
 try{(fromShared?sessionStorage:localStorage).setItem(STORAGE+(fromShared?'-shared':''),JSON.stringify({document:spec,baseline}));}catch{storageOkay=false;}
 if(fromShared){try{history.replaceState(null,'',location.pathname+location.search+encodeFragment(spec));}catch{}}
}
function commit(next,{group='',element=null}={}){
 try{
  const validated=validateDocument(next);if(playing)stopPlaying();
  if(serializeDocument(spec)===serializeDocument(validated)){if(element){delete element.dataset.invalidMessage;element.removeAttribute('aria-invalid');}return true;}
  const now=Date.now();
  if(!group||group!==lastGroup||now-lastEdit>900){undo.push(spec);if(undo.length>60)undo.shift();}
  redo=[];lastGroup=group;lastEdit=now;spec=validated;
  if(element){delete element.dataset.invalidMessage;element.removeAttribute('aria-invalid');}
  persist();render();return true;
 }catch(error){if(element){element.dataset.invalidMessage=error.message;element.setAttribute('aria-invalid','true');}else problem(error.message);return false;}
}
function change(patch,options={}){try{return commit(updateDocument(spec,patch),options);}catch(error){if(options.element){options.element.dataset.invalidMessage=error.message;options.element.setAttribute('aria-invalid','true');}else problem(error.message);return false;}}
function patchPath(path,value){const bits=path.split('.');return bits.length===1?{[bits[0]]:value}:{[bits[0]]:{[bits[1]]:value}};}
function atPath(path){return path.split('.').reduce((v,key)=>v?.[key],spec);}
const monthLabel=month=>month==='all'?'全部月份':month.replace(/^(\d{4})-(\d{2})$/,(m,y,n)=>y+'年'+Number(n)+'月');
const filterLabel=f=>monthLabel(f.month)+' / '+f.category;
const shortFilter=f=>(f.month==='all'?'全部月份':Number(f.month.slice(5))+'月')+' / '+f.category;
const ms=value=>Number.isInteger(value)?value.toLocaleString('zh-CN'):String(Math.round(value*10)/10);
function updateText(node,text){if(node!==document.activeElement&&!node.dataset.invalidMessage&&node.textContent!==String(text))node.textContent=String(text);}
function selectOptions(node,values,selected,label=x=>x){
 const content=values.map(v=>`<option value="${esc(v)}">${esc(label(v))}</option>`).join('');
 if(node.dataset.options!==content){node.innerHTML=content;node.dataset.options=content;}
 node.value=selected;
}
function currentFrame(result){let index=result.trace.findIndex(t=>t.id===stepId);if(index<0)index=result.trace.length-1;stepId=result.trace[index].id;return {frame:result.trace[index],index};}
function updateProduct(result){
 const {frame,index}=currentFrame(result);
 $$('[data-content]').forEach(node=>updateText(node,spec.content[node.dataset.content]));
 const months=Array.from(new Set(['all',...spec.data.map(r=>r.date.slice(0,7)),spec.filters.month,frame.filters.month]));
 const categories=Array.from(new Set(['全部',...spec.data.map(r=>r.category),spec.filters.category,frame.filters.category]));
 selectOptions($('#filter-month'),months,frame.filters.month,monthLabel);selectOptions($('#filter-category'),categories,frame.filters.category);
 $('#original-selection').textContent='第一次选择：'+filterLabel(result.initialFilters)+' · '+result.rows.length+' 条。现在停在第 '+(index+1)+' / '+result.trace.length+' 个状态。';
 const mode=frame.status==='timeout'?'error':frame.status==='success'?'success':'';
 $('#product-status').className='product-status '+mode;
 $('#status-icon').textContent=frame.status==='timeout'?'!':frame.status==='success'?'✓':frame.status==='pending'?'↗':'○';
 const names={before:'操作之前','initial-request':'第一次请求','initial-timeout':'第一次超时','retry-request':'再次请求','retry-success':'收到文件','retry-timeout':'重试仍超时','initial-success':'直接完成'};
 $('#state-kicker').textContent=(names[frame.id]??frame.id)+' · '+ms(frame.atMs)+' ms';
 const key=frame.status==='timeout'?'errorMessage':frame.status==='success'?'successMessage':frame.status==='idle'?'subtitle':null;
 const msg=$('#state-message');
 if(key){msg.dataset.content=key;msg.setAttribute('contenteditable','plaintext-only');msg.setAttribute('role','textbox');msg.setAttribute('aria-label','当前状态的可编辑文案');msg.classList.add('editable');updateText(msg,spec.content[key]);}
 else{delete msg.dataset.content;msg.removeAttribute('contenteditable');msg.removeAttribute('role');msg.classList.remove('editable');msg.textContent=frame.message;}
 $('#state-detail').textContent=frame.status==='success'?'文件含 '+frame.outputRows.length+' 条。对照下方原本选择的记录，检查是否有多出或遗漏。':frame.status==='timeout'?'当前界面显示：'+filterLabel(frame.filters)+'。实际请求参数在下方轨迹中可见。':frame.status==='pending'?'请求使用：'+filterLabel(frame.requestFilters)+'，请求 '+frame.requestRows.length+' 条。':'可以先改文案、规则或数据，也可以点箭头回放一次。';
 $('#download').disabled=!result.completed;$('#download').title=result.completed?'下载由当前规则实际计算的文件':'两次尝试都超时，没有文件';
 $('#product-matches').textContent='当前画面匹配 '+frame.rows.length+' / '+spec.data.length+' 条';
 $('#time-scrub').max=String(result.trace.length-1);$('#time-scrub').value=String(index);$('#time-label').textContent=ms(frame.atMs)+' ms · '+(index+1)+'/'+result.trace.length;
}
function cardValues(result){
 return [
  {id:'before',name:'01 第一次选择',main:shortFilter(result.initialFilters),detail:'请求 '+result.rows.length+' 条',reason:'filter-row'},
  {id:result.timedOut?'initial-timeout':'initial-success',name:'02 发生了什么',main:result.timedOut?ms(spec.rules.timeoutMs)+' ms 后超时':ms(result.duration)+' ms 内完成',detail:result.timedOut?'画面变成 '+shortFilter(result.afterTimeoutFilters):'没有触发超时规则',reason:'rule-timeout'},
  {id:result.timedOut?'retry-request':'initial-success',name:'03 再次请求',main:result.retried?(spec.rules.retrySource==='original'?'使用第一次条件':'使用屏幕上的条件'):'没有进入重试',detail:result.retried?shortFilter(result.retryFilters)+' → '+result.retryRows.length+' 条':'第一次请求已完成',reason:'rule-retry'},
  {id:result.terminal,name:'04 收到的文件',main:result.completed?result.outputRows.length+' 条记录':'没有文件',detail:result.completed?(result.assertions.find(a=>a.id==='file-matches').actual?'与第一次选择一致':'与第一次选择不同'):'重试仍超过等待预算',reason:'output-section'}
 ];
}
function updateTrace(result){
 const values=cardValues(result);let prior=null;
 if(baseline){const old=evaluateExport(baseline);prior=[shortFilter(old.initialFilters)+' · '+old.rows.length+' 条',old.timedOut?ms(baseline.rules.timeoutMs)+' ms 超时，画面 '+shortFilter(old.afterTimeoutFilters):ms(old.duration)+' ms 完成',old.retried?shortFilter(old.retryFilters)+' → '+old.retryRows.length+' 条':'未进入重试',old.completed?old.outputRows.length+' 条文件':'没有文件'];}
 $('#trace-cards').innerHTML=values.map((c,i)=>`<button class="trace-card ${c.id===stepId?'active':''}" data-step="${c.id}" data-reason="${c.reason}" aria-pressed="${c.id===stepId}"><span class="trace-name">${c.name}</span><span class="trace-main">${esc(c.main)}</span><span class="trace-detail">${esc(c.detail)}</span>${prior?`<span class="trace-baseline">对照：${esc(prior[i])}</span>`:''}</button>`).join('');
 $('#baseline-label').hidden=!baseline;$('#clear-baseline').hidden=!baseline;$('#baseline').textContent=baseline?'更新保留的对照':'保留这一版作对照';
}
function updateRules(result){
 $$('[data-path]').forEach(input=>{const value=atPath(input.dataset.path);if(input.type==='checkbox')input.checked=value;else if(input!==document.activeElement&&!input.dataset.invalidMessage)input.value=String(value);});
 $$('[data-retry]').forEach(button=>{button.classList.toggle('selected',button.dataset.retry===spec.rules.retrySource);button.setAttribute('aria-pressed',String(button.dataset.retry===spec.rules.retrySource));});
 if(!result.timedOut)$('#insight').textContent='这组数据在预算内就完成了。缩短等待预算、增加数据或改变网络倍数，可以看见异常分支。';
 else if(!result.completed)$('#insight').textContent='重试也超时了，因此没有文件。调整重试的耗时假设或等待预算，观察哪些结果才真正发生。';
 else if(!result.assertions.find(a=>a.id==='request-matches').actual)$('#insight').textContent='第一次选了 '+result.rows.length+' 条，重试却请求了 '+result.retryRows.length+' 条。点“再次请求”，可以顺着参数找到原因。';
 else if(!result.assertions.find(a=>a.id==='input-preserved').actual)$('#insight').textContent='文件已经与原选择一致，但界面仍清空了输入。这是两件可以分别决定的事。';
 else $('#insight').textContent='现在界面、请求和文件保持一致。试着只改一条数据，或换一个等待预算，继续检验这个想法。';
}
function updateContexts(){
 const contexts=evaluateContexts(spec);
 $('#contexts').innerHTML=contexts.map(c=>`<button class="context" data-context="${c.id}" title="采用这组耗时假设"><strong>${esc(c.label)}</strong><span>首次 ×${c.networkMultiplier} / 重试 ×${c.retryNetworkMultiplier}</span><span>${c.result.timedOut?'首次超时':'首次完成'} · ${ms(c.result.duration)} ms</span><span class="result ${!c.result.completed||c.result.assertions.some(a=>a.status==='failed')?'problem':''}">${c.result.completed?'得到 '+c.result.outputRows.length+' 条':'没有生成文件'}</span></button>`).join('');
}
function updateAssertions(result){
 $('#assertions').innerHTML=result.assertions.map(a=>`<div class="assertion ${a.status}"><b aria-label="${a.status==='passed'?'符合期望':a.status==='failed'?'与期望不同':'未发生'}">${a.status==='passed'?'✓':a.status==='failed'?'!':'○'}</b><div><strong>${esc(a.label)}${!a.expected?'（期望不一致）':''}</strong><small>${esc(a.explanation)}</small></div></div>`).join('');
}
let dataSignature='';
function updateData(result){
 const selected=new Set(result.rows.map(r=>r.id));
 const signature=JSON.stringify(spec.data);
 if(signature!==dataSignature&&!$('#data-body').contains(document.activeElement)&&!$('#data-body [data-invalid-message]')){
  $('#data-body').innerHTML=spec.data.map(row=>`<tr data-row="${esc(row.id)}"><td><span contenteditable="plaintext-only" data-cell="date" role="textbox" aria-label="记录 ${esc(row.id)} 日期" spellcheck="false">${esc(row.date)}</span></td><td><span contenteditable="plaintext-only" data-cell="category" role="textbox" aria-label="记录 ${esc(row.id)} 分类" spellcheck="false">${esc(row.category)}</span></td><td><span contenteditable="plaintext-only" data-cell="title" role="textbox" aria-label="记录 ${esc(row.id)} 内容" spellcheck="false">${esc(row.title)}</span></td><td><span contenteditable="plaintext-only" data-cell="amount" role="textbox" aria-label="记录 ${esc(row.id)} 金额" spellcheck="false">${esc(row.amount??'')}</span></td><td class="match"></td><td><button class="delete-row" data-delete="${esc(row.id)}" aria-label="删除记录 ${esc(row.id)}">×</button></td></tr>`).join('');dataSignature=signature;
 }
 $$('#data-body tr').forEach(row=>{const included=selected.has(row.dataset.row);row.classList.toggle('excluded',!included);row.querySelector('.match').textContent=included?'包含':'不包含';});
}
function updateOutput(result){
 $('#file-explanation').textContent=result.explanations.file;
 const selected=new Set(result.rows.map(r=>r.id));
 if(!result.completed){$('#output-preview').innerHTML='<p class="empty-output">没有生成文件。这里不把“候选的数据”当成已经交付的结果。</p>';return;}
 if(!result.outputRows.length){$('#output-preview').innerHTML='<p class="empty-output">筛选结果为空。当前文件只会包含表头，你仍可以实际下载核对。</p>';return;}
 $('#output-preview').innerHTML='<table class="file-table"><thead><tr><th>日期</th><th>分类</th><th>文件里的实际内容</th><th>金额</th><th>与初始选择比较</th></tr></thead><tbody>'+result.outputRows.map(row=>`<tr class="${selected.has(row.id)?'':'extra'}"><td>${esc(row.date)}</td><td>${esc(row.category)}</td><td>${esc(row.title)}</td><td>${esc(row.amount??'')}</td><td>${selected.has(row.id)?'原本选中':'多出的一条'}</td></tr>`).join('')+'</tbody></table><p class="output-caption">这些行直接构成下载文件。浅色标出原选择之外的内容；它们没有被隐藏或自动纠正。</p>';
}
function render(){
 const result=evaluateExport(spec);document.body.dataset.completed=String(result.completed);document.body.dataset.outputCount=String(result.outputRows.length);document.body.dataset.inputPreserved=String(result.assertions[0].actual);
 $('#mobile-result').textContent='首次 '+result.rows.length+' 条 → 请求 '+(result.retried?result.retryRows.length:result.rows.length)+' 条 → '+(result.completed?'文件 '+result.outputRows.length+' 条':'没有文件');
 updateProduct(result);updateRules(result);updateTrace(result);updateContexts();updateAssertions(result);updateData(result);updateOutput(result);
 $('#undo').disabled=!undo.length;$('#redo').disabled=!redo.length;$('#storage-state').textContent=storageOkay?'本浏览器保存 · 无需登录':'暂未保存 · 可导出 JSON 留存';
}
function readEditor(node){
 if(node.dataset.content)return change({content:{[node.dataset.content]:node.textContent.replace(/\r?\n/g,' ')}},{group:'content.'+node.dataset.content,element:node});
 if(node.dataset.cell){const id=node.closest('[data-row]').dataset.row;const field=node.dataset.cell;const text=node.textContent.trim();const rows=spec.data.map(r=>{if(r.id!==id)return r;const next={...r};if(field==='amount'){if(!text)delete next.amount;else next.amount=Number(text);}else next[field]=text;return next;});return change({data:rows},{group:'data.'+id+'.'+field,element:node});}
}
document.addEventListener('focusin',event=>{if(event.target.matches('[data-content],[data-cell],input[type="number"]'))stopPlaying();});
document.addEventListener('compositionstart',event=>composing.add(event.target));
document.addEventListener('compositionend',event=>{composing.delete(event.target);if(event.target.matches('[data-content],[data-cell]'))readEditor(event.target);});
document.addEventListener('input',event=>{
 const node=event.target;if(composing.has(node)||event.isComposing)return;
 if(node.matches('[data-content],[data-cell]'))readEditor(node);
 if(node.matches('input[type="number"][data-path]')){if(!Number.isFinite(node.valueAsNumber))return;change(patchPath(node.dataset.path,node.valueAsNumber),{group:node.dataset.path,element:node});}
});
document.addEventListener('focusout',event=>{
 const node=event.target;if(node.dataset?.invalidMessage)problem('这一处尚未生效：'+node.dataset.invalidMessage);
 if(node.matches?.('[data-content],[data-cell],input[type="number"]')){lastGroup='';requestAnimationFrame(()=>render());}
});
document.addEventListener('change',event=>{
 const node=event.target;if(node.matches('input[type="checkbox"][data-path]'))change(patchPath(node.dataset.path,node.checked));
 if(node.id==='filter-month'||node.id==='filter-category'){const filters={month:$('#filter-month').value,category:$('#filter-category').value};stepId='before';change({filters});}
});
document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button||button.disabled)return;
 if(button.dataset.retry)change({rules:{retrySource:button.dataset.retry}});
 if(button.dataset.step){stepId=button.dataset.step;render();if(innerWidth<761)$('#product-status').scrollIntoView({block:'center',behavior:'smooth'});}
 if(button.dataset.context){const context=evaluateContexts(spec).find(c=>c.id===button.dataset.context);change({networkMultiplier:context.networkMultiplier,retryNetworkMultiplier:context.retryNetworkMultiplier});}
 if(button.dataset.delete){clearPendingEditors();change({data:spec.data.filter(r=>r.id!==button.dataset.delete)});}
});
function clearPendingEditors(){const active=document.activeElement;if($('#data-body').contains(active))active.blur();$$('[data-invalid-message]').forEach(n=>{delete n.dataset.invalidMessage;n.removeAttribute('aria-invalid');if(n.dataset.content)n.textContent=spec.content[n.dataset.content];else if(n.dataset.cell){const row=spec.data.find(r=>r.id===n.closest('[data-row]').dataset.row);if(row)n.textContent=String(row[n.dataset.cell]??'');}else if(n.dataset.path)n.value=String(atPath(n.dataset.path));});dataSignature='';}
function syncActiveAfterHistory(){const n=document.activeElement;if(n.dataset?.content)n.textContent=spec.content[n.dataset.content];else if(n.dataset?.path&&n.type==='number')n.value=String(atPath(n.dataset.path));else if(n.dataset?.cell){const r=spec.data.find(r=>r.id===n.closest('[data-row]').dataset.row);if(r)n.textContent=String(r[n.dataset.cell]??'');}if(n.matches?.('[contenteditable]')){const range=document.createRange();range.selectNodeContents(n);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}}
$('#undo').addEventListener('click',()=>{if(!undo.length)return;clearPendingEditors();redo.push(spec);spec=undo.pop();lastGroup='';syncActiveAfterHistory();persist();dataSignature='';render();});
$('#redo').addEventListener('click',()=>{if(!redo.length)return;clearPendingEditors();undo.push(spec);spec=redo.pop();lastGroup='';syncActiveAfterHistory();persist();dataSignature='';render();});
$('#baseline').addEventListener('click',()=>{baseline=validateDocument(spec);persist();render();toast('已保留当前作品。继续修改时，这个对照保持不变。');});
$('#clear-baseline').addEventListener('click',()=>{baseline=null;persist();render();});
$('#reset').addEventListener('click',()=>{stepId='before';$$('[data-invalid-message]').forEach(n=>{delete n.dataset.invalidMessage;n.removeAttribute('aria-invalid');});clearPendingEditors();if(commit(createDocument())){syncActiveAfterHistory();dataSignature='';render();toast('已回到最初的作品。撤销可以找回刚才的想法。');}});
function stopPlaying(){clearInterval(playing);playing=null;$('#play').textContent='▶';}
function play(){stopPlaying();const result=evaluateExport(spec);stepId=result.trace[0].id;render();$('#play').textContent='Ⅱ';playing=setInterval(()=>{const result=evaluateExport(spec);const index=result.trace.findIndex(t=>t.id===stepId);if(index>=result.trace.length-1){stopPlaying();return;}stepId=result.trace[index+1].id;render();},650);}
$('#show-process').addEventListener('click',()=>$('.process-section').scrollIntoView({block:'start',behavior:'smooth'}));
$('#play').addEventListener('click',()=>playing?stopPlaying():play());$('#run').addEventListener('click',play);
$('#time-scrub').addEventListener('input',event=>{stopPlaying();const trace=evaluateExport(spec).trace;stepId=trace[Number(event.target.value)].id;render();});
function download(name,text,type){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('#download').addEventListener('click',()=>{const result=evaluateExport(spec);if(!result.completed)return;const title=spec.content.title.replace(/[\\/:*?"<>|]/g,'_').trim().slice(0,60)||'TeamLink导出';download(title+'.csv',toCsv(result.outputRows,{bom:true}),'text/csv;charset=utf-8');toast('下载的就是下面这些行，由当前规则与数据算出。');});
$('#add-row').addEventListener('click',()=>{if(spec.data.length>=LIMITS.rows){problem('这张作品最多支持 '+LIMITS.rows+' 条记录。');return;}clearPendingEditors();let n=spec.data.length+1;while(spec.data.some(r=>r.id==='row-'+n))n++;change({data:[...spec.data,{id:'row-'+n,date:'2026-10-31',category:'产品',title:'直接修改这条新记录',amount:0}]});});
async function copy(text){try{await navigator.clipboard.writeText(text);return true;}catch{return false;}}
$('#copy-spec').addEventListener('click',async()=>{
 const r=evaluateExport(spec);const text=['# '+spec.content.title,'',spec.content.subtitle,'','## 当前规则',`- 超时预算：${spec.rules.timeoutMs} ms`,`- 超时后${spec.rules.preserveFilters?'保留':'清空'}筛选`,`- 重试读取${spec.rules.retrySource==='original'?'第一次':'界面当前'}的条件`,`- 基础耗时 ${spec.rules.baseLatencyMs} ms + 每条 ${spec.rules.perRowLatencyMs} ms；首次倍数 ${spec.networkMultiplier}，重试倍数 ${spec.retryNetworkMultiplier}`,'','## 按当前模型复现',r.explanations.initial,r.explanations.input,r.explanations.retry,r.explanations.file,'','## 仍需在真实产品中验证','这里是可执行计算模型，未调用真实导出服务。实际实现、性能与验收须另行核对。'].join('\n');
 if(await copy(text))toast('这版的具体规则与案例已复制，可带回 Codex 或团队文档。');else{download('TeamLink-规则与案例.md',text,'text/markdown;charset=utf-8');toast('剪贴板不可用，已下载规则与案例。');}
});
$('#export-document').addEventListener('click',()=>download('TeamLink-可继续编辑的作品.json',serializeDocument(spec),'application/json'));
$('#import-document').addEventListener('click',()=>$('#import-file').click());
$('#import-file').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>LIMITS.documentBytes)throw Error('文件过大。');const next=parseDocument(await file.text());clearPendingEditors();if(commit(next)){stepId='before';dataSignature='';render();toast('作品已导入，可以直接继续改。');}}catch(error){problem(error.message);}event.target.value='';});
const dialog=$('#share-dialog');let shareFocus;
$('#share').addEventListener('click',()=>{try{$('#share-url').value=ENTRY+encodeFragment(spec);shareFocus=document.activeElement;dialog.showModal();}catch(error){problem(error.message);}});
$('#close-share').addEventListener('click',()=>{dialog.close();shareFocus?.focus();});
$('#copy-link').addEventListener('click',async()=>{if(await copy($('#share-url').value))toast('已复制。链接打开的是这一版可继续编辑的作品。');else{$('#share-url').select();toast('请手动复制上面的作品链接。');}});
document.addEventListener('keydown',event=>{
 if(event.isComposing)return;
 if(event.key==='Enter'&&event.target.matches('[data-content],[data-cell]')){event.preventDefault();event.target.blur();return;}
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&!dialog.open){event.preventDefault();(event.shiftKey?$('#redo'):$('#undo')).click();}
});
function clearHighlight(){$$('.highlight').forEach(n=>n.classList.remove('highlight'));}
$('#trace-cards').addEventListener('pointerover',event=>{const card=event.target.closest('[data-reason]');if(!card)return;clearHighlight();const target=card.dataset.reason==='filter-row'?$('.filter-row'):card.dataset.reason==='output-section'?$('.output-section'):$('#'+card.dataset.reason);target?.classList.add('highlight');});
$('#trace-cards').addEventListener('pointerleave',clearHighlight);
$('#timeout').addEventListener('pointerdown',event=>{if(event.button!==0)return;drag={x:event.clientX,value:spec.rules.timeoutMs,moved:false,pointer:event.pointerId};event.target.setPointerCapture(event.pointerId);lastGroup='';});
$('#timeout').addEventListener('pointermove',event=>{if(!drag||drag.pointer!==event.pointerId)return;const delta=event.clientX-drag.x;if(Math.abs(delta)<5&&!drag.moved)return;drag.moved=true;const next=Math.max(0,Math.min(LIMITS.timeoutMs,Math.round((drag.value+delta*10)/10)*10));event.target.value=String(next);change({rules:{timeoutMs:next}},{group:'scrub-timeout',element:event.target});});
$('#timeout').addEventListener('pointerup',()=>{drag=null;lastGroup='';});$('#timeout').addEventListener('pointercancel',()=>{drag=null;lastGroup='';});
window.addEventListener('hashchange',()=>{if(!location.hash.startsWith('#doc='))return;try{const next=decodeFragment(location.hash);fromShared=true;stepId='before';commit(next);}catch(error){problem(error.message);}});
render();
