// One id per open page: answers to this page's own questions come back tagged with it, so the page
// knows to speak those itself and other devices know they're someone else's.
export const clientId = globalThis.crypto?.randomUUID?.() || `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

export function createApi({fetchImpl=(...args)=>fetch(...args),timeoutMs=20000}={}) {
  async function request(path,init={},check=()=>true) {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
    const external=init.signal, abort=()=>controller.abort();
    if(external?.aborted)controller.abort(); else external?.addEventListener('abort',abort,{once:true});
    try {
      const response=await fetchImpl(path,{...init,signal:controller.signal});
      if(!response.ok) {
        const error=Error(`Service returned ${response.status}. Please try again.`);
        error.status=response.status; throw error;
      }
      let data; try {data=await response.json();} catch {throw Error('The service returned an unreadable response.');}
      if(!check(data)) throw Error('The service returned an invalid response.');
      return data;
    } catch(error) {
      if(error.name==='AbortError') {const timeout=Error('The request timed out. Processing may still be running on the server.');timeout.uncertain=true;throw timeout;}
      if(error instanceof TypeError) {error.uncertain=true;error.message='Cannot reach the service. Check the local backend.';}
      throw error;
    } finally {clearTimeout(timer);external?.removeEventListener('abort',abort);}
  }
  const json=(path,body,check)=>request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},check);
  return {
    uploadFrame(blob,ts) {const body=new FormData();body.append('image',blob,'frame.jpg');body.append('ts',String(ts));return request('/frame',{method:'POST',body},x=>typeof x?.id==='string'&&(x.caption===null||typeof x.caption?.scene==='string'));},
    // One spoken utterance (16 kHz WAV from mic.js) -> {heard, question, armed, result}. See POST /listen.
    // still: optional sharp photo of what the camera sees now ("remember this" uses it).
    // canSendStill: this device has a camera; the reply may then ask for a photo (need_still).
    // answer=false: only transcribe (the page chimes, then asks the returned question via /ask)
    listen(wav,mode='ask',canSendStill=false,{answer=true}={}) {const body=new FormData();body.append('audio',new Blob([wav],{type:'audio/wav'}),'utterance.wav');body.append('mode',mode);body.append('source',clientId);if(canSendStill)body.append('can_send_still','true');if(!answer)body.append('answer','false');return request('/listen',{method:'POST',body},x=>typeof x?.heard==='string'&&typeof x.armed==='boolean'&&(x.result===null||typeof x.result?.answer==='string'));},
    // mine: tag the answer as this page's (the page then speaks it itself, not via /interaction)
    askQuestion(question,{mine=false}={}) {return json('/ask',mine?{question,source:clientId}:{question},x=>typeof x?.answer==='string'&&['find','retrace','remember','other'].includes(x.kind)&&Array.isArray(x.frames));},
    getInteraction:()=>request('/interaction',{cache:'no-store'},x=>x===null||(typeof x.id==='string'&&typeof x.question==='string'&&typeof x.result?.answer==='string'&&Array.isArray(x.result.frames))),
    getMine:()=>request('/mine',{},x=>Array.isArray(x)&&x.every(item=>typeof item.item==='string'&&typeof item.description==='string'&&typeof item.frame_id==='string'&&typeof item.url==='string'&&Number.isFinite(item.ts))),
    uploadPreview(blob,ts,signal){const body=new FormData();body.append('image',blob,'preview.jpg');body.append('ts',String(ts));return request('/preview',{method:'POST',body,signal},x=>x?.ok===true);},
    uploadStill(blob){const body=new FormData();body.append('image',blob,'still.jpg');return request('/still',{method:'POST',body},x=>x?.ok===true);},
    getLog:()=>request('/log',{},Array.isArray),
    getLatest:()=>request('/latest',{},x=>x===null||(typeof x?.id==='string'&&typeof x.url==='string'&&Number.isFinite(x.ts)&&(x.caption===null||typeof x.caption?.scene==='string'))),
    resetMemory:()=>json('/reset',{},x=>x?.ok===true),
    // the photo wheel: "that's it" (this photo is where it is) / "keep looking" (none of them)
    confirmSighting:(item,frameId,where)=>json('/confirm',{item,frame_id:frameId,where:where||null},x=>typeof x?.answer==='string'),
    keepLooking:item=>json('/watch',{item},x=>typeof x?.answer==='string')
  };
}
