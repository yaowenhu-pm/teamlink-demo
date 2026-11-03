import test from 'node:test';
import assert from 'node:assert/strict';
import {mountDirectEditor} from '../web/direct-edit.mjs';
import {createScene,updateScene} from '../web/scene-model.mjs';

class Element {
 constructor(tag,doc){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.dataset={};this.attributes={};this.listeners={};this.classList={toggle(){},contains(){return false;}};this.hidden=false;}
 hasAttribute(key){return key in this.attributes;}
 setAttribute(key,value){this.attributes[key]=String(value);}
 getAttribute(key){return this.attributes[key]??null;}
 removeAttribute(key){delete this.attributes[key];}
 append(...children){this.children.push(...children);}
 addEventListener(key,fn){(this.listeners[key]??=[]).push(fn);}
 removeEventListener(key,fn){this.listeners[key]=(this.listeners[key]??[]).filter(value=>value!==fn);}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 closest(){return null;}
 getBoundingClientRect(){return {left:0,right:800,top:0,bottom:500,width:800,height:500};}
 remove(){}
}
function fixture(){
 const document={listeners:{},hidden:false,defaultView:{innerWidth:1000,innerHeight:800},querySelector(){return null;},createElement(tag){return new Element(tag,this);},addEventListener(key,fn){(this.listeners[key]??=[]).push(fn);},removeEventListener(key,fn){this.listeners[key]=(this.listeners[key]??[]).filter(value=>value!==fn);}};
 document.body=new Element('body',document);globalThis.document=document;
 const stage=new Element('section',document);document.activeElement=stage;
 let scene=updateScene(createScene(),{trees:2,mountains:1,boats:1,birds:1,flowers:0}),accepted=true,commits=0,undos=0,redos=0;
 const getObjects=()=>Object.entries({tree:'trees',boat:'boats',mountain:'mountains',bird:'birds'}).flatMap(([kind,key],k)=>Array.from({length:scene[key]},(_,index)=>({id:`${kind}:${index}`,kind,point:(()=>{const saved=scene.placements.find(p=>p.id===`${kind}:${index}`);return saved?{x:saved.x,y:saved.y}:{x:.15+k*.15+index*.03,y:.6};})()})));
 const editor=mountDirectEditor(stage,{getScene:()=>scene,getObjects,onCommit:async patch=>{commits++;if(!accepted)return false;scene=updateScene(scene,patch);return true;},onSelection(){},onInspect(){},onUndo:()=>{undos++;return true;},onRedo:()=>{redos++;return true;},getCanUndo:()=>true,getCanRedo:()=>true,onDraw(){},onReset(){},onToggleMotion(){}});
 function key(key,options={}){const event={key,target:stage,ctrlKey:true,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){},...options};document.listeners.keydown.forEach(fn=>fn(event));return event;}
 return {editor,getObjects,key,get scene(){return scene;},get commits(){return commits;},get redos(){return redos;},get undos(){return undos;},set accepted(value){accepted=value;},set scene(value){scene=value;}};
}

test('direct object editing shares a clipboard that survives source deletion',async()=>{
 const f=fixture(),original=f.getObjects();
 f.editor.select('boat:0');assert.equal(await f.editor.command('copy'),true);assert.equal(f.commits,0);
 assert.equal(await f.editor.command('delete'),true);assert.equal(f.scene.boats,0);assert.equal(f.editor.clipboardKind,'boat');
 assert.equal(await f.editor.command('paste',{point:{x:.8,y:.7}}),true);assert.equal(f.scene.boats,1);assert.equal(f.editor.selectedId,'boat:0');
 assert.deepEqual(f.scene.placements.find(p=>p.id==='boat:0'),{id:'boat:0',x:.8,y:.7});
 for(const item of original.filter(p=>p.kind!=='boat')){const saved=f.scene.placements.find(p=>p.id===item.id);assert.ok(Math.abs(saved.x-item.point.x)<1e-6);assert.ok(Math.abs(saved.y-item.point.y)<1e-6);}
});

test('paste previews use a frozen baseline and never commit or change selection',async()=>{
 const f=fixture();f.editor.select('tree:0');await f.editor.command('copy');
 const scene=f.scene,objects=f.getObjects();
 const first=f.editor.preparePaste({x:.3,y:.4},{scene,objects}),second=f.editor.preparePaste({x:.8,y:.9},{scene,objects});
 assert.equal(first.id,second.id);assert.equal(first.scene.trees,3);assert.equal(second.scene.trees,3);assert.equal(f.scene,scene);assert.equal(f.commits,0);assert.equal(f.editor.selectedId,'tree:0');
 assert.deepEqual(second.patch.placements.find(p=>p.id===second.id),{id:'tree:2',x:.8,y:.9});
});

test('failed commits keep selection and the previous clipboard',async()=>{
 const f=fixture();await f.editor.command('copy',{id:'boat:0'});f.editor.select('tree:0');f.accepted=false;
 assert.equal(await f.editor.command('cut'),false);assert.equal(f.editor.selectedId,'tree:0');assert.equal(f.editor.clipboardKind,'boat');assert.equal(f.scene.trees,2);
 assert.equal(await f.editor.command('duplicate'),false);assert.equal(f.editor.selectedId,'tree:0');assert.equal(f.scene.trees,2);
 f.accepted=true;assert.equal(await f.editor.command('cut'),true);assert.equal(f.editor.clipboardKind,'tree');assert.equal(f.scene.trees,1);assert.equal(f.editor.selectedId,null);
});

test('capacity and shared synchronization block mutating commands',async()=>{
 const f=fixture();f.scene=updateScene(f.scene,{boats:8});f.editor.select('boat:0');await f.editor.command('copy');
 assert.equal(f.editor.editState().canPaste,false);assert.equal(await f.editor.command('paste'),false);assert.equal(f.commits,0);
 f.editor.update(f.scene,{busy:true});assert.equal(await f.editor.command('cut'),false);assert.equal(await f.editor.command('undo'),false);assert.equal(f.undos,0);
 f.editor.update(f.scene,{busy:false});assert.equal(await f.editor.command('undo'),true);assert.equal(await f.editor.command('redo'),true);assert.equal(f.redos,1);
});

test('cut and redo keyboard shortcuts respect input fields and canvas scope',async()=>{
 const f=fixture();f.editor.select('bird:0');const event=f.key('x');assert.equal(event.defaultPrevented,true);await Promise.resolve();await Promise.resolve();assert.equal(f.scene.birds,0);assert.equal(f.editor.clipboardKind,'bird');
 f.key('z',{shiftKey:true});await Promise.resolve();assert.equal(f.redos,1);
 const input={isContentEditable:false,closest(selector){return selector.startsWith('input')?this:null;}};
 const native=f.key('y',{target:input});assert.notEqual(native.defaultPrevented,true);assert.equal(f.redos,1);
});
