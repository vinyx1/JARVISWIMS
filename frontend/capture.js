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
 if(!requested)constraints.video={facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}};
 return navigator.mediaDevices.getUserMedia(constraints);
}},attach(stream){video.srcObject=stream;if(stream)video.play().catch(()=>{});},onEnded(){stop();status('Camera disconnected. Tap Start to reconnect.',true);}});
const loop=createCaptureLoop({sample:()=>captureFrame(video,{width:1024,quality:.8}),/* sharp enough for small things */async upload(blob,ts){status('Uploading snapshot…');try{return await api.uploadFrame(blob,ts);}finally{setTimeout(controls,0);}},onSaved(result){status(result.caption===null?'Snapshot saved. The laptop is analyzing it.':'Snapshot saved to the laptop.');controls();},onError(error,{stopped}){if(!stopped){status(`Upload failed, retrying… (${error.message})`,true);return;}preview.stop();camera.stop();status(`Capture stopped after repeated upload failures: ${error.message} Tap Start to retry.`,true);controls();void releaseWake();}});
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

// ---------- voice: hands-free "Jarvis, …" (on by default), or hold to talk ----------
// Audio is recorded here (mic.js) and transcribed on the laptop by Whisper (POST /listen).
// Every device with its audio switched on speaks every answer, whoever asked.
import {createMic} from './mic.js';
import {createConversation} from './listen.js';
import {createDeviceSpeaker} from './speaker.js';
import {createLatestPoller} from './core.js';
const voiceApi=createApi({timeoutMs:30000});
let lastReply='';
const say=text=>{$('phoneVoiceStatus').textContent=text;};
// Replies play automatically; "Play reply" only appears if the phone blocked the sound.
const speaker=createDeviceSpeaker({onBlocked(){$('phoneReplay').hidden=false;say('The phone blocked the sound. Tap "Play reply" to hear Jarvis.');}});

// Phone audio: on by default, remembered on this phone.
const AUDIO_KEY='jarvisPhoneAudio';
try{if(localStorage.getItem(AUDIO_KEY)==='0')$('phoneAudio').checked=false;}catch{}
$('phoneAudio').onchange=()=>{try{localStorage.setItem(AUDIO_KEY,$('phoneAudio').checked?'1':'0');}catch{}if($('phoneAudio').checked)speaker.unlock();else speaker.stop();};
const audioOn=()=>$('phoneAudio').checked;
async function speakHere(text){
  if(!audioOn())return;
  mic.pause();   // the mic stays on, but ignores Jarvis's own voice
  try{await speaker.play(text);}finally{await mic.resume();}
}

const handsFree=()=>$('phoneHandsFree').checked;
const idle=()=>handsFree()?(mic.on?'Listening: say "Jarvis, …" (or hold the button).':'Tap anywhere to start listening for "Jarvis, …".'):'Hold the button and speak, or turn on hands-free.';
const states={
  listening:idle, recording:()=>'Listening… let go when you\'re done.', thinking:()=>'Checking the footage…',
  armed:()=>'Yes, sir? Go ahead.', speaking:()=>audioOn()?'Jarvis is replying.':'Answer below (phone audio is off).',
  'not-heard':()=>'I didn\'t catch that. Try again.', denied:()=>'Microphone blocked. Allow it in Settings → Safari → Microphone, then reload.',
  error:()=>'Something went wrong. Try again.', off:idle,
};
// Questions this phone asked (it speaks those itself), with when: the poll below skips them.
const askedHere=new Map();
const mine=q=>{const t=askedHere.get(q);return t!==undefined&&Date.now()-t<30000;};
function showAnswer(result){lastReply=result.answer;$('phoneAnswer').textContent=result.answer;$('phoneReplay').hidden=true;}
const mic=createMic({
  onUtterance:(wav,info)=>void convo.handle(wav,info),
  onLevel:level=>{$('phoneLevel').style.width=`${Math.round(level*100)}%`;},
  onState:s=>{if(states[s])say(states[s]());},
});
// A sharp, full-resolution photo of what the camera sees right now, sent with what sir says,
// so "Jarvis, this is my ___, remember it" gets a clear look at the item. Null if the camera is off.
async function sharpStill(){
  if(!camera.stream||video.readyState<2)return null;
  try{return (await captureFrame(video,{width:1920,quality:.88}))?.blob||null;}catch{return null;}
}
const convo=createConversation({
  listen:async(wav,mode)=>voiceApi.listen(wav,mode,await sharpStill()), mic, speak:speakHere,
  onState:s=>{if(states[s])say(states[s]());$('phoneTalk').disabled=s==='thinking';},
  onHeard:text=>{$('phoneHeard').textContent=`You: ${text}`;},
  onAnswer:(result,question)=>{askedHere.set(question,Date.now());showAnswer(result);},
  onError:error=>{$('phoneAnswer').textContent=error.message;},
});

// Hands-free needs one tap first (iPhone only opens the mic from a tap): Start capture,
// the switch, or a tap anywhere on the page.
async function startHandsFree(){
  if(!handsFree()||mic.on||!navigator.mediaDevices?.getUserMedia)return;
  speaker.unlock(); mic.auto=true;
  try{await mic.start();}catch{/* onState already explained (e.g. denied) */}
}
// Every tap also re-unlocks audio, so a later reply can play by itself.
document.addEventListener('pointerdown',()=>{speaker.unlock();void startHandsFree();},{capture:true});
$('phoneHandsFree').onchange=async()=>{
  speaker.unlock();
  if(handsFree()){mic.auto=true;if(mic.on)await mic.resume();else await startHandsFree();say(idle());}
  else{mic.auto=false;convo.cancel();mic.stop();}
};

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

$('phoneReplay').onclick=()=>{$('phoneReplay').hidden=true;speaker.unlock();void speaker.play(lastReply);};
$('phoneAskForm').onsubmit=async e=>{
  e.preventDefault();const question=$('phoneQuestion').value.trim();if(!question)return;
  $('phoneQuestion').value='';speaker.unlock();say(states.thinking());$('phoneHeard').textContent=`You: ${question}`;
  askedHere.set(question,Date.now());
  try{const still=await sharpStill();if(still)await voiceApi.uploadStill(still).catch(()=>{});
    const result=await voiceApi.askQuestion(question);showAnswer(result);say(states.speaking());await speakHere(result.answer);}
  catch(error){askedHere.delete(question);$('phoneAnswer').textContent=error.message;}
  say(idle());
};

// Answers to questions asked elsewhere (the laptop's mic or chat box): show them, and speak
// them here too if phone audio is on. Never replay an answer that existed before this page loaded.
let seenExchange=null, firstPoll=true;
const exchanges=createLatestPoller({
  load:()=>voiceApi.getInteraction(),
  onUpdate(exchange){
    const first=firstPoll; firstPoll=false;
    if(!exchange||exchange.id===seenExchange)return;
    seenExchange=exchange.id;
    if(first)return;
    // Ours (or ours still in flight: /listen's reply can land after this poll): we speak it ourselves.
    if(mine(exchange.question)||convo.busy)return;
    $('phoneHeard').textContent=`Laptop: ${exchange.question}`;showAnswer(exchange.result);
    if(!convo.busy)void speakHere(exchange.result.answer);
  },
  onError(){/* the next poll retries */},
});
exchanges.start();

if(!navigator.mediaDevices?.getUserMedia){$('phoneTalk').disabled=true;$('phoneHandsFree').disabled=true;say('The microphone needs HTTPS. Open the link from the laptop\'s QR code.');}
else say(idle());
// Page hidden: release the mic. Hands-free stays switched on and restarts on the next tap.
function hush(){convo.cancel();speaker.stop();mic.stop();say(idle());}
document.addEventListener('visibilitychange',()=>{if(document.hidden)hush();});
window.addEventListener('pagehide',()=>{hush();exchanges.stop();});
