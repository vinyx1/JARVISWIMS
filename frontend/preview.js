// Independent, best-effort preview transport. It never blocks the captioned 3-second capture loop.
export function createPreviewSender({sample, send, canSend=()=>true, schedule=setInterval, cancel=clearInterval}) {
  let running=false, generation=0, timer=null;
  const active=new Set();
  async function tick() {
    if(!running || !canSend() || active.size>=3)return;
    const token=generation, controller=new AbortController();active.add(controller);
    try {
      const frame=await sample();
      if(!frame || !running || token!==generation)return;
      await send(frame.blob,frame.ts,controller.signal);
    }catch { /* A dropped preview must not stop saved-frame capture. */ }
    finally {active.delete(controller);}
  }
  return {
    start(){if(running)return;running=true;generation++;timer=schedule(tick,100);void tick();},
    stop(){running=false;generation++;if(timer!==null)cancel(timer);timer=null;for(const controller of active)controller.abort();}
  };
}
