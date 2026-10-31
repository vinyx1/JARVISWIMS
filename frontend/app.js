import {createApi} from './api.js';
import {createCameraController,listCameras,captureFrame} from './camera.js';
import {createCaptureLoop,validateCalibration,formatSeenAt} from './core.js';
import {addMessage,renderAnswer} from './render.js';
import {createCalibrationWizard} from './calibration.js';
const $=id=>document.getElementById(id), api=createApi(), video=$('camera');
let profile=null,calibrationGeneration=0,resetBusy=false,pendingMessage=null,uiGeneration=0,queryGeneration=0,queryBusy=false,captureUncertain=false,frameProgress=-1,lastProgressAt=0,opening=false,pendingUpload=null;
const storedDevice=()=>{try{return localStorage.getItem('visual-memory.camera')||'';}catch{return '';}};
function saveDevice(value){try{localStorage.setItem('visual-memory.camera',value);}catch{}}
function status(text,error=false){$('captureStatus').textContent=text;$('captureStatus').classList.toggle('error',error);}
function settings(){const s=video.srcObject?.getVideoTracks()[0]?.getSettings()||{};return {deviceId:s.deviceId||$('device').value,width:s.width||video.videoWidth,height:s.height||video.videoHeight};}
function invalidate(){calibrationGeneration++;profile=null;$('calibrationBadge').textContent='NOT SET UP';}
function applyProfile(value){if(validateCalibration(value,settings())){profile=value;$('calibrationBadge').textContent='CALIBRATED';}}
function controls(){
  const hasCamera=!!camera.stream;
  $('enableCamera').disabled=opening||resetBusy;
  $('enableCamera').textContent=opening?'Connecting…':hasCamera?'Reconnect preview':'Enable camera';
  $('start').disabled=!hasCamera||loop.running||loop.pending||captureUncertain||opening||resetBusy;
  $('stop').disabled=!hasCamera&&!opening;
  $('device').disabled=opening||loop.running||resetBusy;
  $('calibrate').disabled=resetBusy;
  $('refreshDevices').disabled=resetBusy;
  $('clearMemory').disabled=resetBusy;
  $('question').disabled=resetBusy;
  $('send').disabled=queryBusy||resetBusy;
  $('cameraBadge').textContent=loop.running?'CAPTURING':hasCamera?'PREVIEW':'OFFLINE';
  $('cameraBadge').classList.toggle('active',hasCamera);
  $('liveLabel').hidden=!hasCamera;$('liveLabel').innerHTML='';
  if(hasCamera){const dot=document.createElement('span');dot.className='dot';$('liveLabel').append(dot,document.createTextNode(loop.running?' CAPTURING':' PREVIEW ONLY'));}
}
const camera=createCameraController({media:navigator.mediaDevices,attach(stream){video.srcObject=stream;$('cameraPlaceholder').hidden=!!stream;if(stream)video.play().catch(()=>{});},onEnded(){loop.stop();opening=false;uiGeneration++;invalidate();void wizard.cancel();status('Camera disconnected. Reconnect it and enable the preview again.',true);controls();}});
const loop=createCaptureLoop({
  async sample(){
    if(document.hidden)return null;
    if(Date.now()-lastProgressAt>8000){throw Error('The preview has stopped updating. Reconnect the camera before capturing again.');}
    return captureFrame(video);
  },
  async upload(blob,ts){
    status('Saving sighting…');
    pendingUpload=api.uploadFrame(blob,ts);
    try{return await pendingUpload;}catch(error){if(error.uncertain){captureUncertain=true;status(error.message+' Upload completion needs to be resolved before another capture session.',true);}throw error;}
    finally{pendingUpload=null;setTimeout(controls,0);}
  },
  onSaved(result){$('lastSaved').textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});status(/\bstub\b/i.test(result.caption.scene)?'Frame saved. Recognition is still using a placeholder.':'Sighting saved. Capturing when processing is ready.');controls();},
  onError(error){status(error.message,true);controls();}
});
const wizard=createCalibrationWizard({api,video,getSettings:settings,onComplete:applyProfile,onPause(){loop.stop();controls();},onInvalidate:invalidate});
async function refreshDevices(){
  if(!navigator.mediaDevices?.enumerateDevices){status('Camera access requires localhost or HTTPS in a supported browser.',true);return;}
  const preferred=$('device').value||settings().deviceId||storedDevice();
  try{
    const devices=await listCameras();const select=$('device');select.replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=devices.length?'Choose a camera':'No cameras found';select.append(placeholder);
    devices.forEach((device,index)=>{const option=document.createElement('option');option.value=device.deviceId;option.textContent=device.label||`Camera ${index+1}`;select.append(option);});
    if(devices.some(d=>d.deviceId===preferred))select.value=preferred;
    if(camera.stream&&!devices.some(d=>d.deviceId===settings().deviceId)){stopAll();status('The selected camera is no longer available. Choose it again after reconnecting.',true);}
  }catch(error){status(error.message,true);}
}
async function enable(){
  if(!navigator.mediaDevices?.getUserMedia){status('Open this app on localhost or HTTPS to enable camera access.',true);return;}
  const token=++uiGeneration;loop.stop();invalidate();opening=true;controls();status('Waiting for camera permission…');
  try{
    const stream=await camera.start($('device').value);if(!stream||token!==uiGeneration)return;
    lastProgressAt=Date.now();frameProgress=-1;await refreshDevices();if(token!==uiGeneration)return;
    const id=settings().deviceId;if(id){$('device').value=id;saveDevice(id);}
    status('Preview ready. Align the phone like glasses, then press Start.');
    const profileToken=calibrationGeneration;
    api.calibrationStatus().then(p=>{if(token===uiGeneration&&profileToken===calibrationGeneration)applyProfile(p);}).catch(()=>{});
  }catch(error){if(token===uiGeneration){const messages={NotAllowedError:'Camera permission was denied. Allow camera access in your browser settings and retry.',NotFoundError:'No camera found. Connect your iPhone with Continuity Camera and refresh.',OverconstrainedError:'That camera is unavailable. Refresh the list and select it again.',NotReadableError:'The camera could not open. Close other camera apps and retry.'};status(messages[error.name]||error.message,true);}}
  finally{if(token===uiGeneration){opening=false;controls();}}
}
function stopAll(){uiGeneration++;opening=false;loop.stop();camera.stop();invalidate();void wizard.cancel();status('Capture stopped. Saved memories are retained.');controls();}
$('enableCamera').onclick=enable;$('refreshDevices').onclick=refreshDevices;
$('device').onchange=()=>{if(camera.stream)stopAll();saveDevice($('device').value);status('Camera selected. Enable the preview to connect.');};
$('start').onclick=()=>{if(document.hidden)return;if(loop.start()){status('Capturing every 3 seconds when processing is ready.');controls();}};
$('stop').onclick=stopAll;$('calibrate').onclick=()=>wizard.open();
video.addEventListener('loadeddata',()=>{lastProgressAt=Date.now();});
setInterval(()=>{
  if(!camera.stream||document.hidden)return;
  const progress=video.getVideoPlaybackQuality?.().totalVideoFrames??video.currentTime;
  if(progress!==frameProgress){frameProgress=progress;lastProgressAt=Date.now();}
  if(loop.running&&Date.now()-lastProgressAt>8000){loop.stop();invalidate();status('The camera view appears frozen. Reconnect before resuming.',true);controls();}
  if(profile&&!validateCalibration(profile,settings()))invalidate();
},1000);
navigator.mediaDevices?.addEventListener?.('devicechange',refreshDevices);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&loop.running){loop.stop();invalidate();status('Capture paused while this tab is hidden. Press Start to resume.');controls();}});
window.addEventListener('pagehide',stopAll);
function resizeInput(){$('question').style.height='auto';$('question').style.height=Math.min($('question').scrollHeight,140)+'px';}
$('question').addEventListener('input',resizeInput);
$('question').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('askForm').requestSubmit();}});
document.querySelectorAll('[data-question]').forEach(button=>button.onclick=()=>{$('question').value=button.dataset.question;resizeInput();$('question').focus();});
$('askForm').onsubmit=async event=>{
  event.preventDefault();const question=$('question').value.trim();if(!question||queryBusy||resetBusy)return;
  const token=++queryGeneration;queryBusy=true;$('send').disabled=true;$('welcome')?.remove();
  addMessage($('chat'),'user',question);$('question').value='';resizeInput();
  const message=addMessage($('chat'),'assistant','Looking through saved sightings…',{pending:true});pendingMessage=message;
  try{
    const result=await api.askQuestion(question);if(token!==queryGeneration)return;
    renderAnswer(message,result,camera.stream?profile:null);$('serviceStatus').textContent=/\bstub\b/i.test(result.answer)?'Recognition placeholder':'Backend connected';
  }catch(error){if(token===queryGeneration)message.update(error.message,true);}
  finally{if(token===queryGeneration){queryBusy=false;pendingMessage=null;controls();$('question').focus();}}
};
$('clearMemory').onclick=()=>{
  stopAll();
  $('resetStatus').textContent=captureUncertain?'An upload may still be processing. Wait for it to finish on the backend before clearing; a browser timeout cannot cancel server work.':'';
  $('confirmReset').disabled=captureUncertain;$('resetDialog').showModal();
};
$('cancelReset').onclick=()=>{if(!resetBusy)$('resetDialog').close();};
$('resetDialog').addEventListener('cancel',event=>{if(resetBusy)event.preventDefault();});
$('confirmReset').onclick=async()=>{
  if(resetBusy)return;resetBusy=true;queryGeneration++;queryBusy=false;
  pendingMessage?.update('Request cancelled because memories are being cleared.');pendingMessage=null;controls();
  $('confirmReset').disabled=true;$('cancelReset').disabled=true;$('resetStatus').textContent='Waiting for accepted uploads to finish…';
  try{
    if(pendingUpload)await pendingUpload;
    if(captureUncertain)throw Error('Upload completion is uncertain. Resolve it on the backend before clearing.');
    $('resetStatus').textContent='Clearing saved sightings…';await api.resetMemory();
    $('chat').replaceChildren();addMessage($('chat'),'assistant','Saved memories cleared. Enable your camera and start a fresh session.');$('lastSaved').textContent='No sightings yet';$('resetDialog').close();
  }catch(error){$('resetStatus').textContent=error.message;}
  finally{resetBusy=false;$('confirmReset').disabled=captureUncertain;$('cancelReset').disabled=false;controls();}
};
async function connection(){try{const log=await api.getLog();$('serviceStatus').textContent='Backend connected';const newest=log.filter(x=>typeof x.ts==='number').sort((a,b)=>b.ts-a.ts)[0];if(newest)$('lastSaved').textContent=formatSeenAt(newest.ts);}catch{$('serviceStatus').textContent='Backend not connected';}}
void refreshDevices();void connection();controls();
