import {createApi} from './api.js';
import {createCameraController,listCameras,captureFrame} from './camera.js';
import {createCaptureLoop} from './core.js';
import {createPreviewSender} from './preview.js';
const $=id=>document.getElementById(id),video=$('phoneVideo'),api=createApi();
let generation=0,opening=false,wakeLock=null;
function status(text,error=false){$('phoneStatus').textContent=text;$('phoneStatus').classList.toggle('error',error);}
function controls(){ $('phoneStart').disabled=opening||loop.running||loop.pending;$('phoneStop').disabled=!opening&&!camera.stream;$('phoneDevice').disabled=opening||!!camera.stream;$('phoneBadge').textContent=loop.running?'CAPTURING':camera.stream?'PREVIEW':'CAMERA OFF';}
async function releaseWake(){const lock=wakeLock;wakeLock=null;if(lock)await lock.release().catch(()=>{});}
function stop(){generation++;opening=false;loop.stop();preview.stop();camera.stop();void releaseWake();status('Capture stopped. Saved photos remain on the laptop.');controls();}
const camera=createCameraController({media:{getUserMedia:constraints=>{
 const requested=$('phoneDevice').value;
 if(!requested)constraints.video={facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}};
 return navigator.mediaDevices.getUserMedia(constraints);
}},attach(stream){video.srcObject=stream;if(stream)video.play().catch(()=>{});},onEnded(){stop();status('Camera disconnected. Tap Start to reconnect.',true);}});
const loop=createCaptureLoop({sample:()=>captureFrame(video),async upload(blob,ts){status('Uploading snapshot…');try{return await api.uploadFrame(blob,ts);}finally{setTimeout(controls,0);}},onSaved(result){status(result.caption===null?'Snapshot saved. The laptop is analyzing it.':'Snapshot saved to the laptop.');controls();},onError(error,{stopped}){if(!stopped){status(`Upload failed, retrying… (${error.message})`,true);return;}preview.stop();camera.stop();status(`Capture stopped after repeated upload failures: ${error.message} Tap Start to retry.`,true);controls();void releaseWake();}});
$('phoneStart').onclick=async()=>{
 if(!navigator.mediaDevices?.getUserMedia){status('Camera access needs HTTPS (or localhost). Open the secure URL from the laptop.',true);return;}
 const token=++generation;opening=true;controls();status('Waiting for camera permission…');
 try{
  const stream=await camera.start($('phoneDevice').value);if(!stream||token!==generation)return;
  if(video.readyState<2)await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{cleanup();reject(Error('Camera preview did not become ready. Stop and retry.'));},10000);const done=()=>{cleanup();resolve();};function cleanup(){clearTimeout(timeout);video.removeEventListener('loadeddata',done);}video.addEventListener('loadeddata',done,{once:true});});
  if(token!==generation)return;
  const selected=stream.getVideoTracks()[0]?.getSettings().deviceId;
  const devices=await listCameras();if(token!==generation)return;
  $('phoneDevice').replaceChildren();for(const [i,device] of devices.entries()){const option=document.createElement('option');option.value=device.deviceId;option.textContent=device.label||`Camera ${i+1}`;$('phoneDevice').append(option);}if(selected)$('phoneDevice').value=selected;
  loop.start();preview.start();status('Capturing. Keep this page in the foreground.');
  if(navigator.wakeLock?.request){navigator.wakeLock.request('screen').then(lock=>{if(token===generation&&loop.running)wakeLock=lock;else void lock.release();}).catch(()=>{});}
 }catch(error){if(token===generation){camera.stop();status(error.name==='NotAllowedError'?'Camera permission denied. Allow access and retry.':error.message,true);}}
 finally{if(token===generation){opening=false;controls();}}
};
$('phoneStop').onclick=stop;
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(loop.running||opening||camera.stream)){stop();status('Capture paused because the page was hidden. Tap Start to resume.');}});
window.addEventListener('pagehide',stop);controls();

// Up to three preview uploads may overlap through the tunnel; timestamps let the backend reject stale arrivals.
const previewApi=createApi({timeoutMs:2000});
const preview=createPreviewSender({
 intervalMs:66, maxInFlight:5,   // ~15 fps target; the tunnel round trip is the real limit
 // Sideways phones fill the whole projector, so they need more pixels than an upright 360px strip.
 sample:()=>captureFrame(video,video.videoWidth>video.videoHeight?{width:640,quality:.5}:{width:360,quality:.45}),
 send:(blob,ts,signal)=>previewApi.uploadPreview(blob,ts,signal),
 canSend:()=>loop.running&&!document.hidden
});

// ---------- voice: hold to talk, or hands-free "Jarvis, …" ----------
// Audio is recorded here (mic.js) and transcribed on the laptop by Whisper (POST /listen).
import {createMic} from './mic.js';
import {createConversation} from './listen.js';
import {createDeviceSpeaker} from './speaker.js';
const voiceApi=createApi({timeoutMs:30000});
let lastReply='';
const say=text=>{$('phoneVoiceStatus').textContent=text;};
const speaker=createDeviceSpeaker({onBlocked(){say('Tap "Play reply" to hear Jarvis, or read the answer below.');}});
const OUTPUT_KEY='jarvisOutput';
try{const saved=localStorage.getItem(OUTPUT_KEY);if(saved)$('phoneOutput').value=saved;}catch{}
$('phoneOutput').onchange=()=>{try{localStorage.setItem(OUTPUT_KEY,$('phoneOutput').value);}catch{}};
const onLaptop=()=>$('phoneOutput').value==='laptop';
const handsFree=()=>$('phoneHandsFree').checked;
const idle=()=>handsFree()?'Hands-free: say "Jarvis, …" (or hold the button).':'Hold the button and speak, or turn on hands-free.';
const states={
  listening:idle, recording:()=>'Listening… let go when you\'re done.', thinking:()=>'Checking the footage…',
  armed:()=>'Yes, sir? Go ahead.', speaking:()=>onLaptop()?'Jarvis is replying on the laptop.':'Jarvis is replying.',
  'not-heard':()=>'I didn\'t catch that. Hold the button and try again.', denied:()=>'Microphone blocked. Allow it in Settings → Safari → Microphone, then reload.',
  error:()=>'Something went wrong. Try again.', off:idle,
};
const mic=createMic({
  onUtterance:(wav,info)=>void convo.handle(wav,info),
  onLevel:level=>{$('phoneLevel').style.width=`${Math.round(level*100)}%`;},
  onState:s=>{if(states[s])say(states[s]());},
});
const convo=createConversation({
  listen:(wav,mode)=>voiceApi.listen(wav,mode), mic,
  speak:text=>onLaptop()?Promise.resolve():speaker.play(text),   // the laptop HUD speaks it itself
  onState:s=>{if(states[s])say(states[s]());$('phoneTalk').disabled=s==='thinking';},
  onHeard:text=>{$('phoneHeard').textContent=`You: ${text}`;},
  onAnswer:result=>{lastReply=result.answer;$('phoneAnswer').textContent=result.answer;$('phoneReplay').hidden=false;},
  onError:error=>{$('phoneAnswer').textContent=error.message;},
});

// Hold to talk: press = record, release = send. Works with hands-free on or off.
async function talkDown(e){
  e.preventDefault();
  if(convo.busy){speaker.stop();return;}   // tapping while Jarvis talks cuts him off
  speaker.unlock(); speaker.stop();
  $('phoneTalk').classList.add('held');
  mic.hold(true);
  if(!mic.on){try{await mic.start();}catch{$('phoneTalk').classList.remove('held');mic.hold(false);return;}}
  else await mic.resume();
}
function talkUp(e){
  e?.preventDefault(); if(!$('phoneTalk').classList.contains('held'))return;
  $('phoneTalk').classList.remove('held');
  // The mic stays open after the first hold, so later holds start instantly (no new prompt).
  const outcome=mic.hold(false);
  if(outcome==='not-ready')say(mic.on?'Microphone ready. Now hold the button while you speak.':'Allow the microphone, then hold the button while you speak.');
  if(outcome==='too-short')say('Too short. Keep holding the button while you speak.');
}
$('phoneTalk').addEventListener('pointerdown',talkDown);
for(const ev of ['pointerup','pointercancel','pointerleave'])$('phoneTalk').addEventListener(ev,talkUp);
$('phoneTalk').addEventListener('contextmenu',e=>e.preventDefault());

$('phoneHandsFree').onchange=async()=>{
  speaker.unlock();
  if(handsFree()){mic.auto=true;try{await mic.start();}catch{$('phoneHandsFree').checked=false;mic.auto=false;}}
  else{mic.auto=false;convo.cancel();mic.stop();}
};
$('phoneReplay').onclick=()=>{speaker.unlock();void speaker.play(lastReply);};
$('phoneAskForm').onsubmit=async e=>{
  e.preventDefault();const question=$('phoneQuestion').value.trim();if(!question)return;
  $('phoneQuestion').value='';speaker.unlock();say(states.thinking());$('phoneHeard').textContent=`You: ${question}`;
  try{const result=await voiceApi.askQuestion(question);lastReply=result.answer;$('phoneAnswer').textContent=result.answer;$('phoneReplay').hidden=false;
    say(states.speaking());if(!onLaptop()){mic.pause();await speaker.play(result.answer);await mic.resume();}}
  catch(error){$('phoneAnswer').textContent=error.message;}
  say(idle());
};
if(!navigator.mediaDevices?.getUserMedia){$('phoneTalk').disabled=true;$('phoneHandsFree').disabled=true;say('The microphone needs HTTPS. Open the link from the laptop\'s QR code.');}
function hush(){convo.cancel();speaker.stop();mic.stop();$('phoneHandsFree').checked=false;mic.auto=false;}
document.addEventListener('visibilitychange',()=>{if(document.hidden)hush();});
window.addEventListener('pagehide',hush);
