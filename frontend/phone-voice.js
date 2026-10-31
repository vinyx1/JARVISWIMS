// One explicit phone utterance at a time. No always-on microphone or wake word required.
export function createPhoneConversation({Recognition, speaker, ask, onState=()=>{}, onHeard=()=>{}, onAnswer=()=>{}, onError=()=>{}}) {
  let recognition=null, busy=false, generation=0;
  async function submit(question) {
    question=question.trim(); if(!question||busy)return;
    speaker.unlock(); speaker.stop(); busy=true; const token=++generation;
    const previous=recognition;recognition=null;previous?.abort();
    onHeard(question); onState('thinking');
    try {
      const result=await ask(question);
      if(token!==generation)return;
      onAnswer(result); onState('speaking'); await speaker.play(result.answer);
      if(token===generation)onState('ready');
    } catch(error) {if(token===generation){onError(error);onState('error');}}
    finally {if(token===generation)busy=false;}
  }
  function listen() {
    if(busy)return;
    speaker.unlock(); speaker.stop();
    if(recognition){recognition.stop();return;}
    if(!Recognition){onState('unsupported');return;}
    const token=++generation, rec=new Recognition(); recognition=rec;
    let finalText='',interim='',failed=false;
    rec.lang='en-US';rec.continuous=false;rec.interimResults=true;rec.maxAlternatives=1;
    rec.onstart=()=>{if(token===generation)onState('listening');};
    rec.onresult=e=>{
      if(token!==generation)return;
      interim='';for(let i=e.resultIndex;i<e.results.length;i++){
        if(e.results[i].isFinal)finalText+=' '+e.results[i][0].transcript;
        else interim+=' '+e.results[i][0].transcript;
      }
      onHeard((finalText+interim).trim());
    };
    rec.onerror=e=>{if(token!==generation)return;failed=true;onState(e.error==='not-allowed'||e.error==='service-not-allowed'?'denied':e.error==='no-speech'?'no-speech':'recognition-error');};
    rec.onend=()=>{
      if(token!==generation||recognition!==rec)return;
      recognition=null;
      if(failed)return;
      if(finalText.trim())void submit(finalText.trim());else onState('no-speech');
    };
    try{rec.start();}catch(error){recognition=null;onError(error);onState('error');}
  }
  function cancel(){generation++;busy=false;const previous=recognition;recognition=null;previous?.abort();speaker.stop();onState('off');}
  return {listen,submit,cancel,get busy(){return busy;}};
}

// Unlock Web Audio from a tap, then decode/play the backend's MP3 or WAV on this device.
export function createDeviceSpeaker({onBlocked=()=>{},fetchImpl=(...a)=>fetch(...a)}={}) {
  let context=null, source=null, controller=null, generation=0, settle=null, speechTimer=null;
  function unlock(){
    try{const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;context??=new AC();void context.resume().catch(()=>{});
      const primer=context.createBufferSource();primer.buffer=context.createBuffer(1,1,context.sampleRate);primer.connect(context.destination);primer.start();
    }catch{/* Text and replay remain available. */}
  }
  function stop(){generation++;controller?.abort();controller=null;try{source?.stop();}catch{}source=null;window.speechSynthesis?.cancel();clearTimeout(speechTimer);settle?.();settle=null;}
  async function browserSpeech(text,token){
    if(!window.speechSynthesis||!window.SpeechSynthesisUtterance){onBlocked();return;}
    await new Promise(resolve=>{
      settle=resolve;const u=new window.SpeechSynthesisUtterance(text);u.lang='en-GB';
      const voices=window.speechSynthesis.getVoices();u.voice=voices.find(v=>v.lang==='en-GB')||null;
      const done=()=>{clearTimeout(speechTimer);if(token===generation)settle=null;resolve();};u.onend=done;u.onerror=()=>{if(token===generation)onBlocked();done();};
      speechTimer=setTimeout(()=>{if(token===generation)onBlocked();done();},Math.max(6000,text.length*100));window.speechSynthesis.speak(u);
    });
  }
  async function play(text){
    stop();const token=generation;controller=new AbortController();const signal=controller.signal;
    const timer=setTimeout(()=>controller?.abort(),15000);
    let bytes=null;
    try{const response=await fetchImpl('/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text}),signal});if(response.ok&&response.headers.get('content-type')?.startsWith('audio/'))bytes=await response.arrayBuffer();}catch{}finally{clearTimeout(timer);}
    if(token!==generation)return;
    if(!bytes||!context){await browserSpeech(text,token);return;}
    try{
      const buffer=await context.decodeAudioData(bytes);
      if(token!==generation)return;
      if(context.state!=='running'){onBlocked();return;}
      await new Promise(resolve=>{settle=resolve;source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);source.onended=()=>{if(token===generation){source=null;settle=null;}resolve();};source.start();});
    }catch{if(token===generation)onBlocked();}
  }
  return {unlock,stop,play};
}
