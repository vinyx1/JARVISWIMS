// Framework-free state/validation shared by the UI and its tests.
export function createCaptureLoop({sample, upload, onSaved, onError, schedule=setInterval, cancel=clearInterval, intervalMs=3000}) {
  let timer=null, generation=0, busy=false, running=false;
  async function tick() {
    if (!running || busy) return;
    const current=generation; busy=true;
    try {
      const frame=await sample();
      if (!frame || current!==generation || !running) return;
      const result=await upload(frame.blob,frame.ts);
      if(current===generation && running) onSaved(result);
    } catch(error) {
      if(current===generation && running) { stop(); onError(error); }
    } finally { busy=false; }
  }
  function stop() { running=false; generation++; if(timer!==null) cancel(timer); timer=null; }
  return {start() { if(running || busy) return false; running=true; generation++; timer=schedule(tick,intervalMs); void tick(); return true; },stop,get running(){return running;},get pending(){return busy;}};
}
export function validateCalibration(profile, settings) {
  return !!(profile && profile.status==='ready' && profile.valid===true && profile.calibration_id && profile.map_id &&
    profile.camera_id===settings.deviceId && profile.width===settings.width && profile.height===settings.height);
}
export function formatSeenAt(ts, now=Date.now()) {
  if(typeof ts!=='number'||!Number.isFinite(ts)||ts<=0||ts>now) return 'Time unavailable';
  const seconds=Math.floor((now-ts)/1000);
  if(seconds<60) return `${seconds} seconds ago`;
  if(seconds<3600) return `${Math.floor(seconds/60)} minutes ago`;
  if(seconds<86400) return `${Math.floor(seconds/3600)} hours ago`;
  return new Date(ts).toLocaleString();
}
export function formatDirection(d, profile, now=Date.now()) {
  if(!d||!profile||profile.valid!==true||profile.status!=='ready'||d.status!=='located'||d.valid!==true||d.reference!=='glasses'||
    d.calibration_id!==profile.calibration_id||d.map_id!==profile.map_id) return null;
  const numbers=[d.bearing_deg,d.horizontal_distance_m,d.query_pose_ts,d.bearing_error_deg,d.distance_error_m];
  if(!numbers.every(x=>typeof x==='number'&&Number.isFinite(x))) return null;
  if(Math.abs(d.bearing_deg)>180||d.horizontal_distance_m<0||d.query_pose_ts>now||now-d.query_pose_ts>1000||
    d.bearing_error_deg<0||d.bearing_error_deg>15||d.distance_error_m<0||d.distance_error_m>.5) return null;
  if(d.historical!==false && (typeof d.last_seen_ts!=='number'||d.last_seen_ts<=0||d.last_seen_ts>now)) return null;
  const b=d.bearing_deg, a=Math.abs(b), range=Math.round(d.horizontal_distance_m*2)/2;
  if(range<.5) return 'The object is nearby.';
  if(a<=d.bearing_error_deg) return `Roughly ${range} metres away; left/right is uncertain.`;
  const angle=Math.round(a/5)*5;
  return `About ${angle}° ${b>0?'left':'right'}${a>90?' (behind you)':''}, roughly ${range} metres away.`;
}
