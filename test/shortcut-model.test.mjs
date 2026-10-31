import test from 'node:test';
import assert from 'node:assert/strict';
import {SHORTCUTS,canvasShortcut} from '../web/shortcut-model.mjs';

const active={active:true,visible:true,selected:true,clipboard:true};
test('canvas shortcuts preserve browser editing, dialogs, IME and inactive or invisible canvases',()=>{
 for(const state of [{active:false},{visible:false},{editing:true},{dialog:true}])for(const key of ['r',' ','m','?','ArrowRight','Delete','z','c','v']){
  assert.equal(canvasShortcut({key,ctrlKey:['z','c','v'].includes(key)},{...active,...state}),null);
 }
 for(const event of [{isComposing:true},{keyCode:229},{altKey:true},{defaultPrevented:true}])assert.equal(canvasShortcut({key:'r',...event},active),null);
 assert.equal(canvasShortcut({key:' ',repeat:true},active),null);
 assert.equal(canvasShortcut({key:' '},{...active,nativeSpace:true}),null);
 assert.equal(canvasShortcut({key:'z',ctrlKey:true,shiftKey:true},active),null);
 assert.equal(canvasShortcut({key:'f'},active),null,'world keeps its existing fullscreen handler');
});

test('local canvas actions and global undo work without requiring an object selection',()=>{
 const state={active:true,visible:true};
 for(const [key,type] of [['r','draw'],[' ','motion'],['m','music'],['?','help']])assert.deepEqual(canvasShortcut({key},state),{type});
 assert.deepEqual(canvasShortcut({key:'z',metaKey:true},state),{type:'undo'});
 assert.equal(canvasShortcut({key:'c',metaKey:true},state),null);
 assert.equal(canvasShortcut({key:'v',metaKey:true},state),null);
 assert.ok(Object.isFrozen(SHORTCUTS)&&SHORTCUTS.every(Object.isFrozen));
});

test('busy and drawing states reject edits, and undo cancels a stroke without committing it',()=>{
 for(const status of [{busy:true},{drawing:true}])for(const event of [{key:'c',ctrlKey:true},{key:'v',ctrlKey:true},{key:'d',ctrlKey:true},{key:'Delete'},{key:'ArrowRight'}])assert.deepEqual(canvasShortcut(event,{...active,...status}),{type:'blocked'});
 assert.deepEqual(canvasShortcut({key:'z',ctrlKey:true},{...active,busy:true}),{type:'blocked'});
 assert.deepEqual(canvasShortcut({key:'z',ctrlKey:true},{...active,drawing:true}),{type:'cancel-draw'});
 assert.deepEqual(canvasShortcut({key:'r'},{...active,drawing:true}),{type:'cancel-draw'});
 assert.deepEqual(canvasShortcut({key:'m'},{...active,busy:true}),{type:'music'});
 assert.deepEqual(canvasShortcut({key:'?'},{...active,busy:true}),{type:'help'});
});

test('object shortcuts preserve clipboard intent and explicit normal or larger arrow steps',()=>{
 for(const [key,type] of [['c','copy'],['v','paste'],['d','duplicate']])assert.deepEqual(canvasShortcut({key,ctrlKey:true},active),{type});
 assert.deepEqual(canvasShortcut({key:'Delete'},active),{type:'remove'});
 assert.deepEqual(canvasShortcut({key:'ArrowLeft'},active),{type:'nudge',dx:-.01,dy:0});
 assert.deepEqual(canvasShortcut({key:'ArrowDown',shiftKey:true,repeat:true},active),{type:'nudge',dx:0,dy:.05});
});
