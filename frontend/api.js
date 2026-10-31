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
    askQuestion(question, extra={}) {return json('/ask',{question,...extra},x=>typeof x?.answer==='string'&&['find','retrace','remember','other'].includes(x.kind)&&Array.isArray(x.frames));},
    getInteraction:()=>request('/interaction',{cache:'no-store'},x=>x===null||(typeof x.id==='string'&&typeof x.question==='string'&&typeof x.result?.answer==='string'&&Array.isArray(x.result.frames))),
    getMine:()=>request('/mine',{},x=>Array.isArray(x)&&x.every(item=>typeof item.item==='string'&&typeof item.description==='string'&&typeof item.frame_id==='string'&&typeof item.url==='string'&&Number.isFinite(item.ts))),
    uploadPreview(blob,ts,signal){const body=new FormData();body.append('image',blob,'preview.jpg');body.append('ts',String(ts));return request('/preview',{method:'POST',body,signal},x=>x?.ok===true);},
    getLog:()=>request('/log',{},Array.isArray),
    getLatest:()=>request('/latest',{},x=>x===null||(typeof x?.id==='string'&&typeof x.url==='string'&&Number.isFinite(x.ts)&&(x.caption===null||typeof x.caption?.scene==='string'))),
    resetMemory:()=>json('/reset',{},x=>x?.ok===true)
  };
}
