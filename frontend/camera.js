export function createCameraController({media,attach,onEnded=()=>{}}) {
  let active=null,generation=0;
  const release=s=>s?.getTracks().forEach(track=>track.stop());
  function stop() { generation++; release(active); active=null; attach(null); }
  return {
    async start(deviceId) {
      stop(); const current=generation;
      const video=deviceId?{deviceId:{exact:deviceId},width:{ideal:1280},height:{ideal:720}}:{width:{ideal:1280},height:{ideal:720}};
      const stream=await media.getUserMedia({video,audio:false});
      if(current!==generation) { release(stream); return null; }
      active=stream;
      stream.getTracks().forEach(track=>track.addEventListener('ended',()=>{if(active===stream){stop();onEnded();}},{once:true}));
      attach(stream); return stream;
    },stop,get stream(){return active;}
  };
}
export async function listCameras(media=navigator.mediaDevices) {
  return (await media.enumerateDevices()).filter(device=>device.kind==='videoinput');
}
export async function captureFrame(video, {width=640, quality=.75}={}) {
  if(video.readyState<2||!video.videoWidth) return null;
  const ts=Date.now(), canvas=document.createElement('canvas');
  canvas.width=Math.min(width,video.videoWidth); canvas.height=Math.round(canvas.width*video.videoHeight/video.videoWidth);
  canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
  if(!blob) throw Error('Could not capture this frame. Try restarting the camera.');
  return {blob,ts};
}
