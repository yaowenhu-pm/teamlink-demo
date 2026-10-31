import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicController} from '../web/music.mjs';

class Media extends EventTarget{
 paused=true;_muted=false;volume=1;plays=0;loads=0;next=null;
 get muted(){return this._muted;}
 set muted(value){if(this._muted!==value){this._muted=value;this.dispatchEvent(new Event('volumechange'));}}
 play(){this.plays++;this.paused=false;this.dispatchEvent(new Event('play'));return this.next??Promise.resolve();}
 pause(){if(!this.paused){this.paused=true;this.dispatchEvent(new Event('pause'));}}
 load(){this.loads++;this.error=null;}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('music waits for a real gesture and user-off intent survives future fullscreens',async()=>{
 const audio=new Media(),intro=new Media(),saved=[];
 const c=createMusicController(audio,{introVideo:intro,savePreference:value=>saved.push(value)});
 assert.equal(audio.plays,0);c.activate();await settle();assert.equal(audio.paused,false);
 intro.pause();c.activate();await settle();assert.equal(audio.paused,false);
 c.toggle();await settle();assert.equal(audio.paused,true);assert.deepEqual(saved,[false]);
 c.activate();await settle();assert.equal(audio.plays,1);assert.equal(c.state.enabled,false);
 c.toggle();await settle();assert.equal(audio.paused,false);c.destroy();
});

test('an audible intro holds background music and fullscreen video pause hands it back',async()=>{
 const audio=new Media(),intro=new Media();intro.muted=true;
 const c=createMusicController(audio,{introVideo:intro});c.activate();await settle();
 intro.paused=false;intro.muted=false;intro.dispatchEvent(new Event('volumechange'));await settle();
 assert.equal(audio.paused,true);assert.equal(c.state.videoPlaying,true);
 intro.pause();c.activate();await settle();assert.equal(audio.paused,false);
 assert.equal(c.state.videoPlaying,false);c.destroy();
});

test('background visibility pauses audio and resumes only previously enabled intent',async()=>{
 let hidden=false;const audio=new Media();const c=createMusicController(audio,{isHidden:()=>hidden});
 c.activate();await settle();hidden=true;c.visibilityChanged();assert.equal(audio.paused,true);
 hidden=false;c.visibilityChanged();await settle();assert.equal(audio.paused,false);
 c.toggle();hidden=true;c.visibilityChanged();hidden=false;c.visibilityChanged();await settle();
 assert.equal(audio.paused,true);c.destroy();
});

test('a rejected playback is retryable and a late promise cannot turn music back on',async()=>{
 const audio=new Media();audio.play=function(){this.plays++;return Promise.reject(Error('blocked'));};
 const c=createMusicController(audio);c.activate();await settle();assert.equal(c.state.blocked,true);
 audio.play=Media.prototype.play;c.activate();await settle();assert.equal(audio.loads,1);assert.equal(audio.paused,false);
 c.toggle();await settle();assert.equal(audio.paused,true);c.destroy();
});

test('rapid off then on while play is pending follows the latest user choice',async()=>{
 let resolve;const audio=new Media();audio.next=new Promise(r=>{resolve=r;});
 const c=createMusicController(audio);c.activate();c.toggle();assert.equal(audio.paused,true);
 c.toggle();audio.next=null;resolve();await settle();await settle();
 assert.equal(audio.paused,false);assert.equal(c.state.enabled,true);assert.equal(audio.plays,2);
 c.destroy();
});

test('explicit music-off silences an already audible intro as well',async()=>{
 const audio=new Media(),intro=new Media();const c=createMusicController(audio,{introVideo:intro});
 intro.paused=false;intro.dispatchEvent(new Event('volumechange'));await settle();c.toggle();
 assert.equal(intro.muted,true);assert.equal(audio.paused,true);assert.equal(c.state.enabled,false);c.destroy();
});

test('muting the native video cannot silently start a second background soundtrack',async()=>{
 const audio=new Media(),intro=new Media();intro.muted=true;
 const c=createMusicController(audio,{introVideo:intro});c.activate();await settle();
 intro.paused=false;intro.muted=false;await settle();assert.equal(audio.paused,true);
 intro.muted=true;await settle();assert.equal(audio.paused,true);assert.equal(c.state.enabled,false);
 intro.pause();c.activate();await settle();assert.equal(audio.paused,true);
 c.toggle();await settle();assert.equal(audio.paused,false);c.destroy();
});
