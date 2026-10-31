import {createApi} from './api.js';
import {createCameraController,listCameras,captureFrame} from './camera.js';
import {createCaptureLoop} from './core.js';
import {createPreviewSender} from './preview.js';
const $=id=>document.getElementById(id),video=$('phoneVideo'),api=createApi();
let generation=0,opening=false,uncertain=false,wakeLock=null;
function status(text,error=false){$('phoneStatus').textContent=text;$('phoneStatus').classList.toggle('error',error);}
function controls(){ $('phoneStart').disabled=opening||loop.running||loop.pending||uncertain;$('phoneStop').disabled=!opening&&!camera.stream;$('phoneDevice').disabled=opening||!!camera.stream;$('phoneBadge').textContent=loop.running?'CAPTURING':camera.stream?'PREVIEW':'CAMERA OFF';}
async function releaseWake(){const lock=wakeLock;wakeLock=null;if(lock)await lock.release().catch(()=>{});}
function stop(){generation++;opening=false;loop.stop();preview.stop();camera.stop();void releaseWake();status('Capture stopped. Saved photos remain on the laptop.');controls();}
const camera=createCameraController({media:{getUserMedia:constraints=>{
 const requested=$('phoneDevice').value;
 if(!requested)constraints.video={facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}};
 return navigator.mediaDevices.getUserMedia(constraints);
}},attach(stream){video.srcObject=stream;if(stream)video.play().catch(()=>{});},onEnded(){stop();status('Camera disconnected. Tap Start to reconnect.',true);}});
const loop=createCaptureLoop({sample:()=>captureFrame(video),async upload(blob,ts){status('Uploading snapshot…');try{return await api.uploadFrame(blob,ts);}catch(error){if(error.uncertain){uncertain=true;status(error.message,true);}throw error;}finally{setTimeout(controls,0);}},onSaved(result){status(result.caption===null?'Snapshot saved. The laptop is analyzing it.':'Snapshot saved to the laptop.');controls();},onError(error){preview.stop();status(error.message,true);controls();void releaseWake();}});
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

// Phone owns voice; the laptop polls completed exchanges without recording or speaking.
import {createPhoneConversation,createDeviceSpeaker} from './phone-voice.js';
import {createWakeListener} from './wake.js';
const questionApi=createApi({timeoutMs:25000});
let lastReply='',playbackBlocked=false;
const speaker=createDeviceSpeaker({onBlocked(){playbackBlocked=true;$('phoneVoiceStatus').textContent='Tap Play reply to allow audio, or read the answer below.';}});
const voiceStates={ready:'Ready. Tap Talk for your next question.',listening:'Listening… speak, then pause. Tap again to finish.',thinking:'Checking the footage…',speaking:'Jarvis is replying on this device.',denied:'Microphone blocked. Allow access in browser settings, or type below.',unsupported:'Speech recognition is unavailable here. Type your question below.', 'no-speech':'No speech captured. Tap Talk to try again.', 'recognition-error':'Speech recognition failed. Try again or type below.',error:'Could not complete the question. Try again.',off:'Microphone and reply audio are off.'};
const OUTPUT_KEY='jarvisOutput';
try{const saved=localStorage.getItem(OUTPUT_KEY);if(saved)$('phoneOutput').value=saved;}catch{}
$('phoneOutput').onchange=()=>{try{localStorage.setItem(OUTPUT_KEY,$('phoneOutput').value);}catch{}};
const onLaptop=()=>$('phoneOutput').value==='laptop';
const replySpeaker={unlock:()=>speaker.unlock(),stop:()=>speaker.stop(),play:text=>onLaptop()?Promise.resolve():speaker.play(text)};
const phoneVoice=createPhoneConversation({
 Recognition:window.SpeechRecognition||window.webkitSpeechRecognition,
 speaker:replySpeaker,ask:question=>questionApi.askQuestion(question),
 onState(state){
   if(!(state==='ready'&&playbackBlocked))$('phoneVoiceStatus').textContent=voiceStates[state]||state;
   if(state==='speaking'&&onLaptop())$('phoneVoiceStatus').textContent='Jarvis is replying on the laptop.';
   if(['ready','no-speech','recognition-error','error'].includes(state))resumeHandsFree();
   $('phoneTalk').textContent=state==='listening'?'Finish speaking':'Talk to Jarvis';
   const busy=state==='thinking'||state==='speaking';$('phoneTalk').disabled=busy;$('phoneAskForm').querySelector('button').disabled=busy;$('phoneReplay').disabled=busy;
 },
 onHeard(text){$('phoneHeard').textContent=`You: ${text}`;},
 onAnswer(result){lastReply=result.answer;playbackBlocked=false;$('phoneAnswer').textContent=result.answer;$('phoneReplay').hidden=false;},
 onError(error){$('phoneAnswer').textContent=error.message;}
});
$('phoneTalk').onclick=()=>{playbackBlocked=false;wake.stop();phoneVoice.listen();};
// Hands-free: keep listening for "Jarvis …". Paused while Jarvis answers (an open iPhone mic can
// route the reply to the quiet earpiece), resumed afterwards.
const wake=createWakeListener({
 Recognition:window.SpeechRecognition||window.webkitSpeechRecognition,
 isBusy:()=>phoneVoice.busy,
 onQuestion(question){wake.stop();playbackBlocked=false;$('phoneHandsFree').checked=true;void phoneVoice.submit(question);},
 onState(state){if(state==='hands-free')$('phoneVoiceStatus').textContent='Hands-free: say "Hey Jarvis, …"';
  if(state==='armed')$('phoneVoiceStatus').textContent='Yes, sir? Go ahead.';
  if(state==='denied'){$('phoneHandsFree').checked=false;$('phoneVoiceStatus').textContent=voiceStates.denied;}}
});
function resumeHandsFree(){if($('phoneHandsFree').checked&&!wake.on&&!document.hidden)wake.start();}
$('phoneHandsFree').onchange=()=>{speaker.unlock();if($('phoneHandsFree').checked)wake.start();else wake.stop();};
$('phoneVoiceOff').onclick=()=>{phoneVoice.cancel();wake.stop();$('phoneHandsFree').checked=false;};
$('phoneReplay').onclick=()=>{speaker.unlock();playbackBlocked=false;void speaker.play(lastReply);};
$('phoneAskForm').onsubmit=e=>{e.preventDefault();const question=$('phoneQuestion').value.trim();if(!question||phoneVoice.busy)return;$('phoneQuestion').value='';playbackBlocked=false;void phoneVoice.submit(question);};
if(!(window.SpeechRecognition||window.webkitSpeechRecognition)){$('phoneTalk').disabled=true;$('phoneVoiceStatus').textContent=voiceStates.unsupported;}
document.addEventListener('visibilitychange',()=>{if(document.hidden){phoneVoice.cancel();wake.stop();}});
window.addEventListener('pagehide',()=>{phoneVoice.cancel();wake.stop();});
