import {createDocument,updateDocument,evaluateExport,encodeFragment} from './canvas-model.mjs';
const $=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const initial=createDocument({content:{title:'导出项目记录'}});
let documentModel=initial,composing=false;
function setText(node,value){if(node.textContent!==String(value))node.textContent=String(value);}
function render(){
 const result=evaluateExport(documentModel),selected=new Set(result.rows.map(row=>row.id));
 const matches=result.assertions.find(item=>item.id==='file-matches').actual;
 if(document.activeElement!==$('#demo-title')&&!$('#demo-title').hasAttribute('aria-invalid'))setText($('#demo-title'),documentModel.content.title);
 $('#demo-preserve').checked=documentModel.rules.preserveFilters;
 document.querySelectorAll('[data-demo-retry]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.demoRetry===documentModel.rules.retrySource)));
 setText($('#demo-initial'),result.rows.length);setText($('#demo-request'),result.retried?result.retryRows.length:result.rows.length);setText($('#demo-output'),result.completed?result.outputRows.length:'—');
 $('#demo-result').classList.toggle('good',matches===true);
 const insight=!matches?'超时清空了筛选，重试导出了额外的 '+(result.outputRows.length-result.rows.length)+' 条记录。':!result.assertions[0].actual?'文件正确了，界面却仍清空了输入。两个问题，可以分别决定。':'界面、请求和文件，都和最初的选择一致。';
 setText($('#demo-insight'),insight);$('#demo-insight').classList.toggle('good',result.assertions.every(item=>item.status==='passed'));
 setText($('#demo-file-count'),result.outputRows.length+' 条 · 节选');
 const extra=result.outputRows.find(row=>!selected.has(row.id));
 const previewRows=result.outputRows.length>3?[...result.outputRows.slice(0,2),extra??result.outputRows[2]]:result.outputRows;
 $('#demo-file-rows').innerHTML=previewRows.map(row=>`<div class="demo-file-row ${selected.has(row.id)?'':'extra'}"><span>${escape(row.title)}</span><small>${selected.has(row.id)?'原选择':'多出的一条'}</small></div>`).join('');
 if(!$('#demo-title').hasAttribute('aria-invalid')){$('#continue-demo').href='./app/'+encodeFragment(documentModel);$('#continue-demo').removeAttribute('aria-disabled');}
 document.body.dataset.demoOutput=String(result.outputRows.length);
}
function change(patch){try{documentModel=updateDocument(documentModel,patch);if(patch.content?.title!==undefined||!$('#demo-title').hasAttribute('aria-invalid')){$('#demo-error').hidden=true;$('#demo-title').removeAttribute('aria-invalid');}render();}catch(error){$('#demo-error').textContent=error.message;$('#demo-error').hidden=false;$('#demo-title').setAttribute('aria-invalid','true');$('#continue-demo').removeAttribute('href');$('#continue-demo').setAttribute('aria-disabled','true');}}
$('#demo-preserve').addEventListener('change',event=>change({rules:{preserveFilters:event.target.checked}}));
document.querySelectorAll('[data-demo-retry]').forEach(button=>button.addEventListener('click',()=>change({rules:{retrySource:button.dataset.demoRetry}})));
$('#demo-title').addEventListener('compositionstart',()=>composing=true);
$('#demo-title').addEventListener('compositionend',()=>{composing=false;change({content:{title:$('#demo-title').textContent.replace(/\r?\n/g,' ')}});});
$('#demo-title').addEventListener('input',event=>{if(!composing&&!event.isComposing)change({content:{title:event.target.textContent.replace(/\r?\n/g,' ')}});});
$('#demo-title').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();event.target.blur();}});
$('#demo-title').addEventListener('blur',()=>{if(!$('#demo-title').hasAttribute('aria-invalid'))render();});
$('#demo-reset').addEventListener('click',()=>{documentModel=initial;$('#demo-error').hidden=true;$('#demo-title').removeAttribute('aria-invalid');setText($('#demo-title'),documentModel.content.title);render();});
const qr=$('#qr-dialog');let qrFocus;
$('#open-qr').addEventListener('click',()=>{qrFocus=document.activeElement;qr.showModal();});
$('#close-qr').addEventListener('click',()=>qr.close());
qr.addEventListener('close',()=>qrFocus?.focus());
render();
