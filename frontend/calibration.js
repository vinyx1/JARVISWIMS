import {validateCalibration} from './core.js';
export function createCalibrationWizard({api,video,getSettings,onComplete,onPause,onInvalidate}) {
  const $=id=>document.getElementById(id), dialog=$('calibrationDialog');
  let generation=0,session=null,step='reference',busy=false,available=false;
  function status(text,error=false){$('setupStatus').textContent=text;$('setupStatus').classList.toggle('error',error);}
  function screen(next){step=next;for(const [i,key] of ['reference','scan','check'].entries()){ $('setup'+key[0].toUpperCase()+key.slice(1)).hidden=key!==next;$('setupStep'+(i+1)).classList.toggle('active',key===next);}}
  function buttons(label,disabled=false){$('setupNext').textContent=label;$('setupNext').disabled=disabled;}
  function current(token){return token===generation&&dialog.open;}
  async function cancel(){generation++;const old=session;session=null;busy=false;if(dialog.open)dialog.close();if(old)api.cancelCalibration(old).catch(()=>{});}
  async function open(){
    onPause(); generation++; const token=generation;session=null;busy=false;available=false;screen('reference');$('markerDownload').hidden=true;buttons('Check setup service',true);dialog.showModal();
    if(!video.srcObject){status('Enable your camera first, then return to calibration.');buttons('Check setup service');return;}
    status('Checking location setup…');
    try{
      const result=await api.calibrationStatus();if(!current(token))return;
      available=true;
      if(validateCalibration(result,getSettings())){onComplete(result);status('This camera already has a validated profile. You can recalibrate if the reference moved.');}
      else status('Place the reference board in view. A new camera needs multiple board views before the room scan.');
      if(typeof result.marker_url==='string'){
        const url=new URL(result.marker_url,location.origin);
        if(url.origin===location.origin&&/^\/calibration\/[a-zA-Z0-9/_-]+\.(pdf|png|svg)$/.test(url.pathname)){$('markerDownload').href=url.href;$('markerDownload').hidden=false;}
      }
      buttons('Begin calibration');
    }catch(error){if(current(token)){status(error.message+' You can keep using the camera and chat; metric directions will remain unavailable.',true);buttons('Retry connection');}}
  }
  async function next(){
    if(busy)return;
    if(!available){await openAgain();return;}
    if(!video.srcObject){status('The camera is off. Close setup and enable it first.',true);return;}
    const token=generation;busy=true;buttons('Working…',true);
    try{
      if(step==='reference'){
        const cm=Number($('markerSize').value);if(!Number.isFinite(cm)||cm<1||cm>500)throw Error('Enter a measured marker edge between 1 and 500 centimetres.');
        onInvalidate();
        const result=await api.startCalibration({...getSettings(),marker_edge_m:cm/100,reference:'glasses'});
        if(!current(token)) {if(result.session_id)api.cancelCalibration(result.session_id).catch(()=>{});return;}
        if(typeof result.session_id!=='string')throw Error('The calibration service did not return a session.');
        session=result.session_id;screen('scan');status(result.message||'Move sideways slowly with the reference in view.');buttons('Capture scan');
      }else if(step==='scan'){
        const {captureFrame}=await import('./camera.js');
        for(let i=0;i<12;i++){
          if(!current(token))return;
          const frame=await captureFrame(video);if(!frame)throw Error('Wait for a live camera image, then try again.');
          const result=await api.calibrationFrame(session,frame.blob,frame.ts);if(!current(token))return;
          $('scanProgress').value=i+1;$('scanCount').textContent=`${i+1} / 12 frames submitted`;
          if(result.message)status(result.message);
          if(result.status==='ready_to_validate'){screen('check');status('Show the second marker at an independent checkpoint.');buttons('Validate setup');return;}
          await new Promise(resolve=>setTimeout(resolve,650));
        }
        status('More views are needed. Translate sideways, keep the board visible and scan again.');buttons('Scan again');
      }else{
        const cm=Number($('checkSize').value);if(!Number.isFinite(cm)||cm<1||cm>500)throw Error('Enter the measured second marker edge.');
        const {captureFrame}=await import('./camera.js');const frame=await captureFrame(video);if(!frame)throw Error('A live camera frame is required.');
        await api.calibrationFrame(session,frame.blob,frame.ts);if(!current(token))return;
        const result=await api.finishCalibration(session,{checkpoint_marker_edge_m:cm/100});if(!current(token))return;
        if(!validateCalibration(result,getSettings()))throw Error(result.message||'Validation did not pass. Check the camera settings and references, then retry.');
        onComplete(result);session=null;status(result.message||'Calibration validated. Keep the reference visible to maintain localization.');$('validationSummary').textContent=typeof result.summary==='string'?result.summary:'Profile saved by the calibration service.';buttons('Return to chat');step='done';
      }
    }catch(error){if(current(token)){status(error.message,true);buttons(step==='scan'?'Retry scan':step==='check'?'Retry validation':'Retry setup');}}
    finally{if(current(token))busy=false;}
  }
  async function openAgain(){if(dialog.open)dialog.close();await open();}
  $('setupNext').onclick=()=>{if(step==='done'){void cancel();return;}void next();};
  $('cancelSetup').onclick=cancel;$('closeSetup').onclick=cancel;
  dialog.addEventListener('cancel',event=>{event.preventDefault();void cancel();});
  return {open,cancel,invalidate(reason){onInvalidate();if(dialog.open){void cancel();}return reason;}};
}
