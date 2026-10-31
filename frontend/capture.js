import {createApi} from './api.js';
import {createCameraController,listCameras,captureFrame} from './camera.js';
import {createCaptureLoop} from './core.js';
const $=id=>document.getElementById(id),video=$('phoneVideo'),api=createApi();
let generation=0,opening=false,uncertain=false,wakeLock=null;
function status(text,error=false){$('phoneStatus').textContent=text;$('phoneStatus').classList.toggle('error',error);}
function controls(){ $('phoneStart').disabled=opening||loop.running||loop.pending||uncertain;$('phoneStop').disabled=!opening&&!camera.stream;$('phoneDevice').disabled=opening||!!camera.stream;$('phoneBadge').textContent=loop.running?'CAPTURING':camera.stream?'PREVIEW':'CAMERA OFF';}
async function releaseWake(){const lock=wakeLock;wakeLock=null;if(lock)await lock.release().catch(()=>{});}
function stop(){generation++;opening=false;loop.stop();camera.stop();void releaseWake();status('Capture stopped. Saved photos remain on the laptop.');controls();}
const camera=createCameraController({media:{getUserMedia:constraints=>{
 const requested=$('phoneDevice').value;
 if(!requested)constraints.video={facingMode:{ideal:'environment'},width:{ideal:1280}};
 return navigator.mediaDevices.getUserMedia(constraints);
}},attach(stream){video.srcObject=stream;if(stream)video.play().catch(()=>{});},onEnded(){stop();status('Camera disconnected. Tap Start to reconnect.',true);}});
const loop=createCaptureLoop({sample:()=>captureFrame(video),async upload(blob,ts){status('Uploading snapshot…');try{return await api.uploadFrame(blob,ts);}catch(error){if(error.uncertain){uncertain=true;status(error.message,true);}throw error;}finally{setTimeout(controls,0);}},onSaved(result){status(result.caption===null?'Snapshot saved. The laptop is analyzing it.':'Snapshot saved to the laptop.');controls();},onError(error){status(error.message,true);controls();void releaseWake();}});
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
  loop.start();status('Capturing. Keep this page in the foreground.');
  if(navigator.wakeLock?.request){navigator.wakeLock.request('screen').then(lock=>{if(token===generation&&loop.running)wakeLock=lock;else void lock.release();}).catch(()=>{});}
 }catch(error){if(token===generation){camera.stop();status(error.name==='NotAllowedError'?'Camera permission denied. Allow access and retry.':error.message,true);}}
 finally{if(token===generation){opening=false;controls();}}
};
$('phoneStop').onclick=stop;
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(loop.running||opening||camera.stream)){stop();status('Capture paused because the page was hidden. Tap Start to resume.');}});
window.addEventListener('pagehide',stop);controls();
