export function createApi({fetchImpl=(...args)=>fetch(...args),timeoutMs=20000}={}) {
  async function request(path,init={},check=()=>true) {
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(path,{...init,signal:controller.signal});
      if(!response.ok) {
        const error=Error(response.status===404&&path.startsWith('/calibration')?'Calibration service is not connected yet.':`Service returned ${response.status}. Please try again.`);
        error.status=response.status; throw error;
      }
      let data; try {data=await response.json();} catch {throw Error('The service returned an unreadable response.');}
      if(!check(data)) throw Error('The service returned an invalid response.');
      return data;
    } catch(error) {
      if(error.name==='AbortError') {const timeout=Error('The request timed out. Processing may still be running on the server.');timeout.uncertain=true;throw timeout;}
      if(error instanceof TypeError) {error.uncertain=true;error.message='Cannot reach the service. Check the local backend.';}
      throw error;
    } finally {clearTimeout(timer);}
  }
  const json=(path,body,check)=>request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},check);
  return {
    uploadFrame(blob,ts) {const body=new FormData();body.append('image',blob,'frame.jpg');body.append('ts',String(ts));return request('/frame',{method:'POST',body},x=>typeof x?.id==='string'&&typeof x.caption?.scene==='string');},
    askQuestion(question) {return json('/ask',{question},x=>typeof x?.answer==='string'&&['find','retrace','other'].includes(x.kind)&&Array.isArray(x.frames));},
    getLog:()=>request('/log',{},Array.isArray),
    resetMemory:()=>json('/reset',{},x=>x?.ok===true),
    calibrationStatus:()=>request('/calibration/status'),
    startCalibration:body=>json('/calibration/start',body),
    calibrationFrame(id,blob,ts) {const body=new FormData();body.append('image',blob,'calibration.jpg');body.append('ts',String(ts));return request(`/calibration/${encodeURIComponent(id)}/frame`,{method:'POST',body});},
    finishCalibration:(id,body)=>json(`/calibration/${encodeURIComponent(id)}/finish`,body),
    cancelCalibration:id=>json(`/calibration/${encodeURIComponent(id)}/cancel`,{})
  };
}
