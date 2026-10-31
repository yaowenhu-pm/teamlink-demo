import {SCENE_LIMITS, updateScene, duplicateSceneObject, removeSceneObject} from './scene-model.mjs';

const TYPES = Object.freeze({tree:{key:'trees',label:'树'},mountain:{key:'mountains',label:'山'},boat:{key:'boats',label:'船'},bird:{key:'birds',label:'鸟'}});
const bound = value => Math.round(Math.max(.02,Math.min(.98,value))*1e6)/1e6;
function button(text, label, action) {
 const node=document.createElement('button');node.type='button';node.textContent=text;node.setAttribute('aria-label',label);node.addEventListener('click',action);return node;
}

/** Canvas actions share the same validated scene and commit path as text and JSON. */
export function mountDirectEditor(stage,{getScene,getObjects,onCommit,onSelection,onInspect,onUndo,notify=()=>{}}) {
 let selectedId=null,clipboard=null,busy=false;
 const tools=document.createElement('div');tools.className='canvas-tools';tools.setAttribute('role','toolbar');tools.setAttribute('aria-label','画面内编辑工具');
 const menu=document.createElement('div');menu.className='canvas-add-menu';menu.hidden=true;
 const add=button('＋ 添加','添加风景对象',()=>{menu.hidden=!menu.hidden;add.setAttribute('aria-expanded',String(!menu.hidden));});add.setAttribute('aria-expanded','false');
 const trajectory=button('落叶轨迹','在画面中调整落叶轨迹',()=>onInspect('leaf'));
 tools.append(add,trajectory,menu);stage.append(tools);
 const dock=document.createElement('div');dock.className='object-tools';dock.hidden=true;dock.setAttribute('role','toolbar');dock.setAttribute('aria-label','选中对象操作');
 const label=document.createElement('span');label.className='object-tools-label';
 const copy=button('复制','复制选中对象（⌘/Ctrl+C）',copyObject),paste=button('粘贴','粘贴风景对象（⌘/Ctrl+V）',pasteObject);
 const duplicate=button('再来一个','再复制一个选中对象（⌘/Ctrl+D）',duplicateObject);
 const shape=button('枝形','直接调整树枝形态',()=>onInspect('tree'));
 const remove=button('删除','删除选中对象（Delete）',removeObject),undo=button('↶','撤销画面修改',onUndo),close=button('×','取消对象选择',()=>select(null));
 dock.append(label,copy,paste,duplicate,shape,remove,undo,close);stage.append(dock);
 const additions=[];
 for(const [kind,type] of Object.entries(TYPES)){
  const item=button(type.label,`在画面添加${type.label}`,()=>addObject(kind));menu.append(item);additions.push(item);
 }
 function editingAllowed(){if(busy){notify('正在同步，完成后可以继续修改。');return false;}return true;}
 function object(id=selectedId){return getObjects().find(item=>item.id===id);}
 function preserveKind(kind,base=getScene().placements){
  const positions=getObjects().filter(item=>item.kind===kind).map(item=>({id:item.id,x:bound(item.point.x),y:bound(item.point.y)}));
  return [...base.filter(item=>!item.id.startsWith(kind+':')),...positions];
 }
 function select(id){
  selectedId=id;const kind=id?.split(':')[0]??null;onSelection(id,kind);update(getScene(),{busy});
 }
 function copyObject(){
  const item=object();if(!item)return;
  clipboard={kind:item.kind,point:{...item.point}};notify(`已复制这${item.kind==='boat'?'艘':'个'}${TYPES[item.kind].label}，可点击粘贴。`);update(getScene(),{busy});
 }
 async function addObject(kind,point){
  if(!editingAllowed())return;const scene=getScene(),type=TYPES[kind],count=scene[type.key];
  if(count>=SCENE_LIMITS[type.key].max){notify(`${type.label}最多 ${SCENE_LIMITS[type.key].max} 个。`);return;}
  const start=point??({boat:{x:.65,y:.72},mountain:{x:.5,y:.57},tree:{x:.35,y:.72},bird:{x:.6,y:.27}}[kind]);
  const id=`${kind}:${count}`,placements=[...preserveKind(kind),{id,x:bound(start.x),y:bound(start.y)}];
  const patch={[type.key]:count+1,placements};updateScene(scene,patch);menu.hidden=true;add.setAttribute('aria-expanded','false');
  await onCommit(patch);if(getScene()[type.key]===count+1)select(id);
 }
 async function pasteObject(){if(clipboard)await addObject(clipboard.kind,{x:clipboard.point.x+.06,y:clipboard.point.y+.06});}
 async function duplicateObject(){
  if(!editingAllowed())return;const item=object();if(!item)return;
  try{
   const scene=getScene(),type=TYPES[item.kind],patch=duplicateSceneObject(scene,item.id,item.point);
   const nextId=`${item.kind}:${scene[type.key]}`,newItem=patch.placements.find(entry=>entry.id===nextId);
   const placements=[...preserveKind(item.kind),newItem];await onCommit({...patch,placements});
   if(getScene()[type.key]===scene[type.key]+1)select(nextId);
  }catch(error){notify(error.message);}
 }
 async function removeObject(){
  if(!editingAllowed())return;const item=object();if(!item)return;
  try{
   const scene=getScene(),kind=item.kind,index=Number(item.id.split(':')[1]);
   const patch=removeSceneObject(scene,item.id),preserved=preserveKind(kind).filter(entry=>entry.id!==item.id).map(entry=>{
    if(!entry.id.startsWith(kind+':'))return entry;const old=Number(entry.id.split(':')[1]);return {...entry,id:`${kind}:${old>index?old-1:old}`};
   });
   await onCommit({...patch,placements:preserved});if(getScene()[TYPES[kind].key]===scene[TYPES[kind].key]-1)select(null);
  }catch(error){notify(error.message);}
 }
 function update(scene,options={}){
  busy=!!options.busy;
  if(selectedId){const [kind,index]=selectedId.split(':');if(!TYPES[kind]||Number(index)>=scene[TYPES[kind].key])selectedId=null;}
  const kind=selectedId?.split(':')[0];label.textContent=kind?`${TYPES[kind].label} ${Number(selectedId.split(':')[1])+1} · 拖动调整`:'';
  dock.hidden=!selectedId&&!clipboard;shape.hidden=kind!=='tree';
  for(const node of [copy,duplicate,remove])node.disabled=busy||!selectedId;
  paste.disabled=busy||!clipboard;add.disabled=busy;trajectory.disabled=busy;undo.disabled=busy;
  additions.forEach((node,index)=>{const type=Object.values(TYPES)[index];node.disabled=busy||scene[type.key]>=SCENE_LIMITS[type.key].max;});
  stage.classList.toggle('has-object-selection',!!selectedId);stage.dataset.selectedObject=selectedId??'';
 }
 function keydown(event){
  if(event.target.closest('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open]'))return;
  if(!selectedId&&!clipboard)return;
  if(event.key==='Escape'&&selectedId){event.preventDefault();event.stopImmediatePropagation();select(null);return;}
  const modifier=event.metaKey||event.ctrlKey,key=event.key.toLowerCase();
  if(modifier&&['c','v','d'].includes(key)&&!event.altKey){event.preventDefault();event.stopImmediatePropagation();if(key==='c')copyObject();else if(key==='v')pasteObject();else duplicateObject();}
  else if(selectedId&&['Delete','Backspace'].includes(event.key)){event.preventDefault();removeObject();}
 }
 document.addEventListener('keydown',keydown);
 stage.addEventListener('pointerdown',event=>{
  if(event.target.closest('[data-scene-object],[data-select],[data-role="sun-control"],[data-trajectory-handle],.canvas-tools,.object-tools,.inspector,.presentation-tools'))return;
  if(selectedId)select(null);menu.hidden=true;add.setAttribute('aria-expanded','false');
 });
 update(getScene());
 return {select,update,get selectedId(){return selectedId;},destroy(){document.removeEventListener('keydown',keydown);tools.remove();dock.remove();}};
}
