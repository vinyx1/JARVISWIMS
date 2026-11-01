// Jarvis's voice on this device: POST /speak returns audio (ElevenLabs if configured, else the
// Mac's British "say" voice); we play it through Web Audio, unlocked by a tap. If /speak has
// nothing, the browser's own en-GB voice reads it. play() resolves when Jarvis stops talking.
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
      const voices=window.speechSynthesis.getVoices();u.voice=voices.find(v=>/daniel/i.test(v.name))||voices.find(v=>v.lang==='en-GB')||null;
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
