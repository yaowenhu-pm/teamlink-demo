/** Keep the original score independent of the intro video's visibility/fullscreen. */
export function createMusicController(audio,{introVideo,isHidden=()=>false,onState=()=>{},enabled=true,savePreference=()=>{}}={}){
 let unlocked=false,blocked=false,pending=null,destroyed=false,epoch=0,retryPending=false,ignoreMute=false;
 const introAudible=()=>!!introVideo&&!introVideo.paused&&!introVideo.muted&&introVideo.volume>0;
 const allowed=()=>enabled&&unlocked&&!isHidden()&&!introAudible();
 const state=()=>({enabled,unlocked,playing:!audio.paused&&!audio.muted,videoPlaying:introAudible(),blocked});
 const emit=()=>onState(state());
 function reconcile(){
  if(destroyed)return;
  if(!allowed()){if(!audio.paused)audio.pause();emit();return;}
  if(pending){retryPending=true;emit();return;}
  if(!audio.paused){emit();return;}
  const attemptEpoch=epoch;
  try{
   pending=Promise.resolve(audio.play()).catch(()=>{if(attemptEpoch===epoch&&allowed())blocked=true;}).finally(()=>{
    pending=null;if(destroyed||!allowed()){if(!audio.paused)audio.pause();}emit();
    const retry=retryPending;retryPending=false;if(retry&&!destroyed&&allowed()&&!blocked&&audio.paused)reconcile();
   });
  }catch{blocked=true;}
  emit();
 }
 function activate(){if(!enabled||destroyed)return;epoch++;unlocked=true;if(blocked||audio.error)audio.load?.();blocked=false;reconcile();}
 function muteIntro(){if(introVideo&&!introVideo.muted){ignoreMute=true;introVideo.muted=true;}}
 function toggle(){
  if(destroyed)return;
  epoch++;
  if(enabled&&unlocked&&(!audio.paused||introAudible())){
   enabled=false;savePreference(false);muteIntro();
  }else{
   enabled=true;unlocked=true;if(blocked||audio.error)audio.load?.();blocked=false;savePreference(true);muteIntro();
  }
  reconcile();
 }
 function introChanged(event){
  if(introAudible())blocked=false;
  if(event?.type==='volumechange'&&introVideo){
   const programmatic=ignoreMute&&introVideo.muted;ignoreMute=false;
   if(!programmatic&&!introVideo.muted&&introVideo.volume>0){enabled=true;unlocked=true;blocked=false;savePreference(true);}
   else if(!programmatic&&unlocked){enabled=false;savePreference(false);}
  }
  reconcile();
 }
 const audioChanged=()=>emit();
 const events=['play','playing','pause','volumechange','ended'];
 for(const name of events)audio.addEventListener(name,audioChanged);
 for(const name of events)introVideo?.addEventListener(name,introChanged);
 const audioError=()=>{blocked=true;emit();};audio.addEventListener('error',audioError);
 emit();
 return {activate,toggle,visibilityChanged:reconcile,get state(){return state();},destroy(){destroyed=true;audio.pause();for(const name of events){audio.removeEventListener(name,audioChanged);introVideo?.removeEventListener(name,introChanged);}audio.removeEventListener('error',audioError);}};
}

export function mountLandscapeMusic(stage,{introVideo}={}){
 const document=stage.ownerDocument,storageKey='teamlink-music-enabled-v1';
 let enabled=true;try{enabled=localStorage.getItem(storageKey)!=='false';}catch{}
 const audio=document.createElement('audio');audio.id='landscape-music';audio.src='/media/teamlink-original-score.m4a';audio.preload='none';audio.loop=true;audio.hidden=true;audio.volume=.7;stage.append(audio);
 const button=document.createElement('button');button.type='button';button.className='music-toggle';button.textContent='♫ 开音乐';button.setAttribute('aria-keyshortcuts','M');
 stage.querySelector('.canvas-tools').append(button);
 const controller=createMusicController(audio,{introVideo,enabled,isHidden:()=>document.hidden,
  savePreference(value){try{localStorage.setItem(storageKey,String(value));}catch{}},
  onState(state){
   const audible=state.playing||state.videoPlaying;
   button.textContent=state.blocked?'♫ 重试':audible?'♫ 音乐开':state.enabled?'♫ 开音乐':'♫ 音乐关';
   button.setAttribute('aria-label',audible?'关闭背景音乐':'开启背景音乐');button.setAttribute('aria-pressed',String(audible));
   button.title=state.blocked?'音乐暂未播放，点击重试（M）':'原版配乐 · 全屏继续播放（M）';
   stage.dataset.musicState=state.blocked?'blocked':state.playing?'playing':state.videoPlaying?'video':state.enabled?'ready':'off';
  }
 });
 button.addEventListener('click',()=>controller.toggle());
 // A real user gesture unlocks sound; muted autoplay remains intact before that.
 const activate=event=>{if(event.target.closest?.('.music-toggle'))return;controller.activate();};
 stage.addEventListener('pointerdown',activate,{capture:true});
 const visibility=()=>controller.visibilityChanged();document.addEventListener('visibilitychange',visibility);
 return {activate:()=>controller.activate(),get state(){return controller.state;},destroy(){stage.removeEventListener('pointerdown',activate,{capture:true});document.removeEventListener('visibilitychange',visibility);controller.destroy();audio.remove();button.remove();}};
}
