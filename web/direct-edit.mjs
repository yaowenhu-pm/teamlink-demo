import {SCENE_LIMITS, createScene, updateScene, sceneChanges} from './scene-model.mjs';
import {captureSceneObject, pasteSceneObject, deleteSceneObject, cutSceneObject, duplicateSceneObjectForEdit} from './gesture-edit.mjs';
import {canvasShortcut,SHORTCUTS as BASE_SHORTCUTS} from './shortcut-model.mjs';
export const SHORTCUTS=Object.freeze([...BASE_SHORTCUTS,
 Object.freeze({key:'⌘ / Ctrl + X',label:'剪切选中对象',description:'剪切后仍可粘贴。'}),
 Object.freeze({key:'⌘ / Ctrl + Shift + Z',label:'重做',description:'恢复刚刚撤销的修改。'})]);

/** All editable defaults, including paths and placements, travel as one room patch. */
export function defaultScenePatch() {
 const {schemaVersion,...patch}=createScene();return patch;
}

const TYPES = Object.freeze({tree:{key:'trees',label:'树'},mountain:{key:'mountains',label:'山'},boat:{key:'boats',label:'船'},bird:{key:'birds',label:'鸟'}});
const bound = value => Math.round(Math.max(.02,Math.min(.98,value))*1e6)/1e6;
function button(text, label, action) {
 const node=document.createElement('button');node.type='button';node.textContent=text;node.setAttribute('aria-label',label);node.addEventListener('click',action);return node;
}

/** Canvas actions share the same validated scene and commit path as text and JSON. */
export function mountDirectEditor(stage,{getScene,getObjects,onCommit,onSelection,onInspect,onUndo,onRedo,getCanUndo=()=>true,getCanRedo=()=>false,onDraw,onReset,onToggleMotion,onHelp,onNudge,notify=()=>{}}) {
 let selectedId=null,clipboard=null,busy=false,resetBusy=null,drawing=false,motionPlaying=true,canvasActive=false;
 const addedTabIndex=!stage.hasAttribute('tabindex');if(addedTabIndex)stage.tabIndex=-1;
 const tools=document.createElement('div');tools.className='canvas-tools';tools.setAttribute('role','toolbar');tools.setAttribute('aria-label','画面内编辑工具');
 const menu=document.createElement('div');menu.className='canvas-add-menu';menu.hidden=true;
 const add=button('＋ 添加','添加风景对象',()=>{menu.hidden=!menu.hidden;add.setAttribute('aria-expanded',String(!menu.hidden));});add.setAttribute('aria-expanded','false');
 const trajectory=button('落叶轨迹','在画面中调整落叶轨迹',()=>onInspect('leaf'));
 const draw=button('画落叶路线','直接手绘落叶飞行路线',()=>onDraw());draw.setAttribute('aria-pressed','false');
 const reset=button('恢复默认','恢复本房间默认风景，可撤销',()=>onReset?.());reset.id='reset-world';reset.title='恢复本房间默认风景，可撤销';
 const motion=button('Ⅱ','暂停风景动画',()=>onToggleMotion());motion.className='motion-toggle';
 const help=button('?','查看画布快捷键（?）',()=>onHelp?.());help.className='shortcut-help';
 tools.append(draw,trajectory,add,reset,motion,help,menu);stage.append(tools);
 const dock=document.createElement('div');dock.className='object-tools';dock.hidden=true;dock.setAttribute('role','toolbar');dock.setAttribute('aria-label','选中对象操作');
 const label=document.createElement('span');label.className='object-tools-label';
 const copy=button('复制','复制选中对象（⌘/Ctrl+C）',copyObject),cut=button('剪切','剪切选中对象（⌘/Ctrl+X）',()=>command('cut')),paste=button('粘贴','粘贴风景对象（⌘/Ctrl+V）',pasteObject);
 const duplicate=button('再来一个','再复制一个选中对象（⌘/Ctrl+D）',duplicateObject);
 const shape=button('枝形','直接调整树枝形态',()=>onInspect('tree'));
 const remove=button('删除','删除选中对象（Delete）',removeObject),undo=button('↶','撤销画面修改',()=>command('undo')),redo=button('↷','重做画面修改',()=>command('redo')),close=button('×','取消对象选择',()=>select(null));
 for(const [node,keys,tip] of [[draw,'r','R'],[motion,'Space','Space'],[help,'Shift+/','?'],[copy,'Meta+c Control+c','⌘/Ctrl+C'],[cut,'Meta+x Control+x','⌘/Ctrl+X'],[paste,'Meta+v Control+v','⌘/Ctrl+V'],[duplicate,'Meta+d Control+d','⌘/Ctrl+D'],[remove,'Delete Backspace','Delete'],[undo,'Meta+z Control+z','⌘/Ctrl+Z'],[redo,'Meta+Shift+z Control+Shift+z Control+y','⌘/Ctrl+Shift+Z'],[close,'Escape','Esc']]){
  node.setAttribute('aria-keyshortcuts',keys);node.title=node.getAttribute('aria-label')+' · '+tip;
 }
 dock.append(label,copy,cut,paste,duplicate,shape,remove,undo,redo,close);stage.append(dock);
 const additions=[];
 for(const [kind,type] of Object.entries(TYPES)){
  const item=button(type.label,`在画面添加${type.label}`,()=>addObject(kind));menu.append(item);additions.push(item);
 }
 function editingAllowed(){if(busy||drawing){notify(drawing?'先完成这一笔，或取消绘制。':'正在同步，完成后可以继续修改。');return false;}return true;}
 function preservePositions(scene=getScene()){
  const saved=new Map(scene.placements.map(item=>[item.id,item]));
  for(const item of getObjects())if(Number.isFinite(item.point?.x)&&Number.isFinite(item.point?.y)&&item.point.x>=0&&item.point.x<=1&&item.point.y>=0&&item.point.y<=1&&!saved.has(item.id))saved.set(item.id,{id:item.id,x:item.point.x,y:item.point.y});
  return [...saved.values()];
 }
 function select(id){
  selectedId=id;const kind=id?.split(':')[0]??null;onSelection?.(id,kind);update(getScene(),{busy});
 }
 const patchBetween=(before,after)=>Object.freeze(Object.fromEntries(sceneChanges(before,after).map(change=>[change.key,change.after])));
 const labelFor=id=>{const [kind,index]=String(id??'').split(':');return TYPES[kind]?`${TYPES[kind].label} ${Number(index)+1}`:'';};
 function exists(id,scene=getScene()){
  const match=/^(tree|boat|mountain|bird):(0|[1-9]\d?)$/u.exec(id??'');return !!match&&Number(match[2])<scene[TYPES[match[1]].key];
 }
 function editState(id=selectedId){
  const scene=getScene(),editable=exists(id,scene),blocked=busy||drawing,kind=id?.split(':')[0];
  const maxed=editable&&scene[TYPES[kind].key]>=SCENE_LIMITS[TYPES[kind].key].max;
  const pasteMaxed=clipboard&&scene[TYPES[clipboard.kind].key]>=SCENE_LIMITS[TYPES[clipboard.kind].key].max;
  const unsupported=editable?'':'请先选择画布内的树、山、船或鸟。',blockReason=drawing?'先完成当前落叶路线。':'正在同步，完成后可以继续修改。';
  return {selectedLabel:labelFor(id),clipboardLabel:clipboard?labelFor(clipboard.sourceId):'',canCopy:editable&&!blocked,canCut:editable&&!blocked,canPaste:!!clipboard&&!pasteMaxed&&!blocked,canDuplicate:editable&&!maxed&&!blocked,canDelete:editable&&!blocked,canUndo:!blocked&&!!getCanUndo(),canRedo:!blocked&&!!onRedo&&!!getCanRedo(),
   reason:{copy:blocked?blockReason:unsupported,cut:blocked?blockReason:unsupported,delete:blocked?blockReason:unsupported,duplicate:blocked?blockReason:maxed?'这一类对象已达到数量上限。':unsupported,paste:blocked?blockReason:!clipboard?'先复制一个风景对象。':pasteMaxed?'这一类对象已达到数量上限，可先删除一个。':'',undo:blocked?blockReason:'还没有可撤销的修改。',redo:blocked?blockReason:'还没有可重做的修改。'}};
 }
 function preparePaste(point,{scene=getScene(),objects=getObjects()}={}){
  if(!clipboard)return null;
  const destination=point??{x:bound(clipboard.point.x+.06),y:bound(clipboard.point.y+.06)};
  const result=pasteSceneObject(scene,clipboard,destination,objects);
  return Object.freeze({patch:patchBetween(scene,result.scene),id:result.id,scene:result.scene});
 }
 async function command(name,{id=selectedId,point}={}){
  const state=editState(id),flag={copy:'canCopy',cut:'canCut',paste:'canPaste',duplicate:'canDuplicate',delete:'canDelete',undo:'canUndo',redo:'canRedo'}[name];
  if(!flag||!state[flag]){notify(state.reason[name]??'当前无法执行这次操作。');return false;}
  try{
   if(name==='undo')return (await onUndo?.())!==false;
   if(name==='redo')return (await onRedo?.())!==false;
   const before=getScene(),positions=getObjects();
   if(name==='copy'){clipboard=captureSceneObject(before,id,positions);select(id);notify(`已复制${labelFor(id)}，可点击粘贴。`);return true;}
   let result,newClipboard=clipboard;
   if(name==='paste')result=preparePaste(point,{scene:before,objects:positions});
   else if(name==='duplicate'){const value=duplicateSceneObjectForEdit(before,id,positions,point);result={...value,patch:patchBetween(before,value.scene)};}
   else if(name==='cut'){const value=cutSceneObject(before,id,positions);newClipboard=value.clipboard;result={...value,patch:patchBetween(before,value.scene)};}
   else {const value=deleteSceneObject(before,id,positions);result={...value,patch:patchBetween(before,value.scene)};}
   const applied=await onCommit(result.patch);
   if(applied===false)return false;
   clipboard=newClipboard;
   if(name==='cut'||name==='delete')select(null);else select(result.id);
   return true;
  }catch(error){notify(error.message);return false;}
 }
 function copyObject(){return command('copy');}
 function pasteObject(){return command('paste');}
 function duplicateObject(){return command('duplicate');}
 function removeObject(){return command('delete');}
 async function addObject(kind,point){
  if(!editingAllowed())return false;const scene=getScene(),type=TYPES[kind],count=scene[type.key];
  if(count>=SCENE_LIMITS[type.key].max){notify(`${type.label}最多 ${SCENE_LIMITS[type.key].max} 个。`);return false;}
  const start=point??({boat:{x:.65,y:.72},mountain:{x:.5,y:.57},tree:{x:.35,y:.72},bird:{x:.6,y:.27}}[kind]);
  const id=`${kind}:${count}`,placements=[...preservePositions(scene),{id,x:bound(start.x),y:bound(start.y)}];
  const patch={[type.key]:count+1,placements};updateScene(scene,patch);menu.hidden=true;add.setAttribute('aria-expanded','false');
  if(await onCommit(patch)===false)return false;if(getScene()[type.key]===count+1)select(id);return true;
 }
 function update(scene,options={}){
  busy=!!options.busy;
  if(Object.hasOwn(options,'resetBusy'))resetBusy=!!options.resetBusy;
  if(Object.hasOwn(options,'drawing'))drawing=!!options.drawing;
  if(Object.hasOwn(options,'motionPlaying'))motionPlaying=!!options.motionPlaying;
  if(selectedId){const [kind,index]=selectedId.split(':');if(!TYPES[kind]||Number(index)>=scene[TYPES[kind].key])selectedId=null;}
  const kind=selectedId?.split(':')[0];label.textContent=kind?`${TYPES[kind].label} ${Number(selectedId.split(':')[1])+1} · 拖动调整`:'';
  dock.hidden=!selectedId&&!clipboard;shape.hidden=kind!=='tree';
  const state=editState();
  copy.disabled=!state.canCopy;cut.disabled=!state.canCut;duplicate.disabled=!state.canDuplicate;remove.disabled=!state.canDelete;
  paste.disabled=!state.canPaste;add.disabled=busy||drawing;trajectory.disabled=busy;undo.disabled=!state.canUndo;redo.disabled=!state.canRedo;
  // A reset cancels previews itself; only actual synchronization blocks it.
  reset.disabled=resetBusy??busy;
  draw.disabled=busy;draw.textContent=drawing?'取消绘制':'画落叶路线';draw.setAttribute('aria-pressed',String(drawing));
  motion.textContent=motionPlaying?'Ⅱ':'▶';motion.setAttribute('aria-label',motionPlaying?'暂停风景动画':'播放风景动画');motion.setAttribute('aria-pressed',String(motionPlaying));
  additions.forEach((node,index)=>{const type=Object.values(TYPES)[index];node.disabled=busy||drawing||scene[type.key]>=SCENE_LIMITS[type.key].max;});
  stage.classList.toggle('has-object-selection',!!selectedId);stage.dataset.selectedObject=selectedId??'';
 }
 function keydown(event){
  const target=event.target,rect=stage.getBoundingClientRect(),view=stage.ownerDocument.defaultView;
  const fullscreen=document.fullscreenElement===stage||document.webkitFullscreenElement===stage||document.body.classList.contains('focus-mode');
  const context={
   active:canvasActive||fullscreen||stage.contains(document.activeElement),
   visible:!document.hidden&&rect.width>0&&rect.height>0&&rect.bottom>0&&rect.right>0&&rect.top<(view?.innerHeight??innerHeight)&&rect.left<(view?.innerWidth??innerWidth),
   editing:target.isContentEditable||!!target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'),
   dialog:!!document.querySelector('dialog[open]'),busy,drawing,selected:!!selectedId,clipboard:!!clipboard,
   nativeSpace:stage.contains(target)&&!!target.closest?.('button,a[href],[role="button"]')
  };
  const key=String(event.key??'').toLowerCase(),modifier=event.metaKey||event.ctrlKey;
  const shortcutEligible=context.active&&context.visible&&!context.editing&&!context.dialog&&!event.defaultPrevented&&!event.isComposing&&!event.repeat&&!event.altKey&&event.keyCode!==229;
  let action=canvasShortcut(event,context);
  if(shortcutEligible&&modifier){
   if((key==='z'&&event.shiftKey)||(key==='y'&&!event.shiftKey)){if(onRedo)action={type:busy||drawing?'blocked':'redo'};}
   else if(key==='x'&&!event.shiftKey&&selectedId)action={type:busy||drawing?'blocked':'cut'};
  }
  if(!action||(action.type==='nudge'&&typeof onNudge!=='function'))return;
  event.preventDefault();event.stopImmediatePropagation();
  if(action.type==='draw'||action.type==='cancel-draw')onDraw?.();
  else if(action.type==='motion')onToggleMotion?.();
  else if(action.type==='music')stage.querySelector('.music-toggle')?.click();
  else if(action.type==='help')onHelp?.();
  else if(action.type==='undo')onUndo?.();
  else if(action.type==='redo')command('redo');
  else if(action.type==='cut')command('cut');
  else if(action.type==='copy')copyObject();
  else if(action.type==='paste')pasteObject();
  else if(action.type==='duplicate')duplicateObject();
  else if(action.type==='remove')removeObject();
  else if(action.type==='cancel-selection')select(null);
  else if(action.type==='nudge')onNudge({dx:action.dx,dy:action.dy});
 }
 document.addEventListener('keydown',keydown);
 const activate=event=>{canvasActive=stage.contains(event.target);if(canvasActive&&event.type==='pointerdown'&&event.target.closest?.('#landscape,#world'))stage.focus({preventScroll:true});};
 document.addEventListener('pointerdown',activate,{capture:true});document.addEventListener('focusin',activate,{capture:true});
 const clearSelection=event=>{
  if(event.target.closest('[data-scene-object],[data-select],[data-role="sun-control"],[data-trajectory-handle],.canvas-tools,.object-tools,.inspector,.presentation-tools,.world-gesture-panel,.world-gesture-menu,.world-gesture-toggle,.world-gesture-root,.world-gesture-launch,[data-world-gesture]'))return;
  if(selectedId)select(null);menu.hidden=true;add.setAttribute('aria-expanded','false');
 };
 stage.addEventListener('pointerdown',clearSelection);
 update(getScene());
 return {select,update,command,editState,preparePaste,get clipboardKind(){return clipboard?.kind??null;},reset(){clipboard=null;menu.hidden=true;add.setAttribute('aria-expanded','false');select(null);},get selectedId(){return selectedId;},destroy(){document.removeEventListener('keydown',keydown);document.removeEventListener('pointerdown',activate,{capture:true});document.removeEventListener('focusin',activate,{capture:true});stage.removeEventListener('pointerdown',clearSelection);if(addedTabIndex)stage.removeAttribute('tabindex');tools.remove();dock.remove();}};
}
