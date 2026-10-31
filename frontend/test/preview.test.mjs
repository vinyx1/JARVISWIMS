import test from 'node:test';
import assert from 'node:assert/strict';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
test('preview uploads overlap to a maximum of three and resume when a slot opens',async()=>{
 const {createPreviewSender}=await import('../preview.js');let tick,uploads=0;const pending=deferred();
 const sender=createPreviewSender({sample:async()=>({blob:new Blob(),ts:123}),send:()=>{uploads++;return pending.promise;},schedule:fn=>{tick=fn;return 1;},cancel:()=>{}});
 sender.start();for(let i=0;i<8;i++)void tick();await new Promise(r=>setTimeout(r,0));assert.equal(uploads,3);
 pending.resolve();await new Promise(r=>setTimeout(r,0));await tick();assert.equal(uploads,4);sender.stop();
});
test('stop prevents late encoded preview from being uploaded',async()=>{
 const {createPreviewSender}=await import('../preview.js');const pending=deferred();let uploads=0;
 const sender=createPreviewSender({sample:()=>pending.promise,send:()=>{uploads++;},schedule:()=>1,cancel:()=>{}});
 sender.start();sender.stop();pending.resolve({blob:new Blob(),ts:123});await new Promise(r=>setTimeout(r,0));assert.equal(uploads,0);
});
