export const SHORTCUTS=Object.freeze([
 {key:'R',label:'画 / 取消落叶路线',description:'在画布上手绘，松手保存。'},
 {key:'Space',label:'播放 / 暂停风景',description:'仅影响本机动画。'},
 {key:'M',label:'开 / 关音乐',description:'切换原版背景音乐。'},
 {key:'F',label:'进入 / 退出全屏',description:'展示同一片可编辑风景。'},
 {key:'⌘ / Ctrl + Z',label:'撤销',description:'绘制中取消当前一笔，其他时候撤销最近修改。'},
 {key:'⌘ / Ctrl + C',label:'复制选中对象',description:'点选对象后复制。'},
 {key:'⌘ / Ctrl + V',label:'粘贴对象',description:'在原对象旁添加副本。'},
 {key:'⌘ / Ctrl + D',label:'再来一个',description:'添加选中对象的同类。'},
 {key:'Delete / Backspace',label:'删除选中对象',description:'可用撤销恢复。'},
 {key:'↑ ↓ ← →',label:'微调选中对象',description:'按住 Shift 可加大步长。'},
 {key:'Esc',label:'取消绘制 / 选择',description:'绘制时优先取消当前笔。'},
 {key:'?',label:'快捷键帮助',description:'输入框、弹窗或画布外不接管快捷键。'},
].map(Object.freeze));

/** Pure routing: ordinary browser editing stays untouched outside an active canvas. */
export function canvasShortcut(event,{active=false,visible=false,editing=false,dialog=false,busy=false,drawing=false,selected=false,clipboard=false,nativeSpace=false}={}){
 if(!active||!visible||editing||dialog||event.defaultPrevented||event.isComposing||event.keyCode===229||event.key==='Process'||event.altKey)return null;
 const key=String(event.key??'').toLowerCase(),modifier=event.metaKey||event.ctrlKey;
 if(event.repeat&&!key.startsWith('arrow'))return null;
 if(modifier){
  if(event.shiftKey)return null;
  if(key==='z')return drawing?{type:'cancel-draw'}:busy?{type:'blocked'}:{type:'undo'};
  if(busy||drawing)return ['c','v','d'].includes(key)&&(selected||clipboard||drawing)?{type:'blocked'}:null;
  if(key==='c'&&selected)return {type:'copy'};
  if(key==='v'&&clipboard)return {type:'paste'};
  if(key==='d'&&selected)return {type:'duplicate'};
  return null;
 }
 if(key==='?')return {type:'help'};
 if(key==='m')return {type:'music'};
 if((key===' '||key==='spacebar')&&!nativeSpace)return {type:'motion'};
 if(key==='r')return drawing?{type:'cancel-draw'}:busy?{type:'blocked'}:{type:'draw'};
 if(key==='escape')return drawing?{type:'cancel-draw'}:selected?{type:'cancel-selection'}:null;
 if(busy||drawing)return (selected||drawing)&&['delete','backspace','arrowleft','arrowright','arrowup','arrowdown'].includes(key)?{type:'blocked'}:null;
 if(!selected)return null;
 if(key==='delete'||key==='backspace')return {type:'remove'};
 const step=event.shiftKey?.05:.01;
 if(key==='arrowleft')return {type:'nudge',dx:-step,dy:0};
 if(key==='arrowright')return {type:'nudge',dx:step,dy:0};
 if(key==='arrowup')return {type:'nudge',dx:0,dy:-step};
 if(key==='arrowdown')return {type:'nudge',dx:0,dy:step};
 return null;
}
