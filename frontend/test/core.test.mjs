import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraController } from '../camera.js';
import { createCaptureLoop, formatSeenAt } from '../core.js';
import { createApi } from '../api.js';
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise, resolve}; };
const stream = () => ({ stopped: false, getTracks() { return [{stop: () => {this.stopped=true;}, addEventListener() {}}]; } });

test('late camera permission cannot reopen a stopped preview', async () => {
  const pending=deferred(), frames=[];
  const camera=createCameraController({media:{getUserMedia:()=>pending.promise}, attach:s=>frames.push(s)});
  const opening=camera.start('iphone'); camera.stop(); const s=stream(); pending.resolve(s); await opening;
  assert.equal(s.stopped,true); assert.equal(frames.filter(Boolean).length,0);
});
test('camera switch releases previous tracks and requests the selected ID', async () => {
  const first=stream(), second=stream(), constraints=[];
  const camera=createCameraController({media:{getUserMedia:async c=>{constraints.push(c);return constraints.length===1?first:second;}},attach:()=>{}});
  await camera.start('first'); await camera.start('iphone');
  assert.equal(first.stopped,true); assert.equal(constraints[1].video.deviceId.exact,'iphone'); camera.stop(); assert.equal(second.stopped,true);
});
test('capture remains bounded and ignores a stopped session result', async () => {
  let callback, uploads=0; const pending=deferred(), saved=[];
  const loop=createCaptureLoop({sample:async()=>({blob:new Blob(['x']),ts:1}),upload:()=>{uploads++;return pending.promise;},onSaved:x=>saved.push(x),onError:()=>{},schedule:f=>{callback=f;return 1;},cancel:()=>{}});
  loop.start(); await new Promise(r=>setTimeout(r,0)); await callback(); assert.equal(uploads,1);
  loop.stop(); pending.resolve({id:'old'}); await new Promise(r=>setTimeout(r,0)); assert.equal(saved.length,0);
});
test('capture errors stop automatic retries', async () => {
  let failures=0;
  const loop=createCaptureLoop({sample:async()=>({blob:new Blob(),ts:1}),upload:async()=>{throw Error('offline');},onSaved:()=>{},onError:()=>failures++,schedule:()=>1,cancel:()=>{}});
  loop.start(); await new Promise(r=>setTimeout(r,0)); assert.equal(loop.running,false); assert.equal(failures,1);
});
test('unknown and future times never look recent',()=>{
 assert.equal(formatSeenAt(null,10000),'Time unavailable'); assert.equal(formatSeenAt(20000,10000),'Time unavailable'); assert.equal(formatSeenAt(5000,10000),'5 seconds ago');
});
test('API sends multipart image and preserves the sampled timestamp',async()=>{
 let body;
 const api=createApi({fetchImpl:async(url,init)=>{assert.equal(url,'/frame');body=init.body;return new Response(JSON.stringify({id:'f_1',caption:{scene:'bench'}}));}});
 await api.uploadFrame(new Blob(['jpeg'],{type:'image/jpeg'}),1234); assert.equal(body.get('ts'),'1234'); assert.equal(body.get('image').type,'image/jpeg');
});
test('API rejects HTTP failures and malformed successful answers',async()=>{
 const offline=createApi({fetchImpl:async()=>new Response('oops',{status:503})}); await assert.rejects(()=>offline.askQuestion('keys'),/503/);
 const bad=createApi({fetchImpl:async()=>new Response('{}')}); await assert.rejects(()=>bad.askQuestion('keys'),/response/i);
});

test('upload accepts Vincent background-caption response',async()=>{
 const api=createApi({fetchImpl:async()=>new Response(JSON.stringify({id:'f_000123',caption:null}))});
 assert.deepEqual(await api.uploadFrame(new Blob(['jpeg']),1234),{id:'f_000123',caption:null});
});
test('latest distinguishes empty memory, pending caption and completed caption',async()=>{
 const pending={id:'f_000123',url:'/frames/f_000123.jpg',ts:1234,caption:null};
 let response=null;const api=createApi({fetchImpl:async()=>new Response(JSON.stringify(response))});
 assert.equal(await api.getLatest(),null);
 response=pending;assert.deepEqual(await api.getLatest(),pending);
 response={...pending,caption:{scene:'bench',room_guess:'workshop',objects:['helmet'],landmarks:['door']}};
 assert.equal((await api.getLatest()).caption.objects[0],'helmet');
 response={id:'x'};await assert.rejects(()=>api.getLatest(),/invalid response/i);
});
test('latest polling ignores pre-reset responses and accepts caption completion for the same frame',async()=>{
 const {createLatestPoller}=await import('../core.js');
 let tick;const old=deferred(),updates=[];let entry={id:'f_1',caption:null},first=true;
 const poller=createLatestPoller({load:()=>{if(first){first=false;return old.promise;}return Promise.resolve(entry);},onUpdate:x=>updates.push(x),onError:()=>{},schedule:f=>{tick=f;return 1;},cancel:()=>{}});
 poller.start();poller.stop();old.resolve({id:'stale',caption:null});await new Promise(r=>setTimeout(r,0));assert.equal(updates.length,0);
 poller.start();await new Promise(r=>setTimeout(r,0));assert.equal(updates[0].caption,null);
 entry={id:'f_1',caption:{scene:'helmet on chair'}};await tick();assert.equal(updates.at(-1).caption.scene,'helmet on chair');poller.stop();
});
