// Framework-free state/validation shared by the UI and its tests.
// A dropped upload (tunnel blip) keeps capturing; only maxFailures in a row stop the loop.
// onError(error, {stopped}) says which happened.
export function createCaptureLoop({sample, upload, onSaved, onError, schedule=setInterval, cancel=clearInterval, intervalMs=3000, maxFailures=5}) {
  let timer=null, generation=0, busy=false, running=false, failures=0;
  async function tick() {
    if (!running || busy) return;
    const current=generation; busy=true;
    try {
      const frame=await sample();
      if (!frame || current!==generation || !running) return;
      const result=await upload(frame.blob,frame.ts);
      if(current===generation && running) { failures=0; onSaved(result); }
    } catch(error) {
      if(current===generation && running) {
        const stopped=++failures>=maxFailures; if(stopped) stop();
        onError(error,{stopped});
      }
    } finally { busy=false; }
  }
  function stop() { running=false; generation++; if(timer!==null) cancel(timer); timer=null; }
  return {start() { if(running || busy) return false; running=true; failures=0; generation++; timer=schedule(tick,intervalMs); void tick(); return true; },stop,get running(){return running;},get pending(){return busy;}};
}
export function formatSeenAt(ts, now=Date.now()) {
  if(typeof ts!=='number'||!Number.isFinite(ts)||ts<=0||ts>now) return 'Time unavailable';
  const seconds=Math.floor((now-ts)/1000);
  if(seconds<60) return `${seconds} seconds ago`;
  if(seconds<3600) return `${Math.floor(seconds/60)} minutes ago`;
  if(seconds<86400) return `${Math.floor(seconds/3600)} hours ago`;
  return new Date(ts).toLocaleString();
}

// Poll the remote feed independently of local camera capture. Stop invalidates old responses.
export function createLatestPoller({load,onUpdate,onError,schedule=setInterval,cancel=clearInterval}) {
  let timer=null,generation=0,busy=false,running=false;
  async function tick() {
    if(!running||busy)return;
    busy=true;const current=generation;
    try {const entry=await load();if(running&&current===generation)onUpdate(entry);}
    catch(error){if(running&&current===generation)onError(error);}
    finally{busy=false;}
  }
  return {start(){if(running)return;running=true;generation++;timer=schedule(tick,1000);void tick();},stop(){running=false;generation++;if(timer!==null)cancel(timer);timer=null;}};
}
export function safeFrameUrl(raw,origin) {
  try {const u=new URL(raw,origin);return u.origin===origin&&/^\/frames\/f_\d+\.jpg$/.test(u.pathname)&&!u.search&&!u.hash?u.pathname:null;}catch{return null;}
}
