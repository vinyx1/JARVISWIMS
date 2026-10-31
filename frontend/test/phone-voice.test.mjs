import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhoneConversation} from '../phone-voice.js';
function setup(){
 const instances=[],questions=[],spoken=[],states=[];let resolve;
 class Recognition{constructor(){instances.push(this);}start(){this.onstart?.();}stop(){this.onend?.();}abort(){this.onend?.();}emit(text,final=true){const row=[{transcript:text}];row.isFinal=final;this.onresult({resultIndex:0,results:[row]});}}
 const speaker={unlock(){},stop(){},play:async t=>spoken.push(t)};
 const controller=createPhoneConversation({Recognition,speaker,ask:q=>{questions.push(q);return new Promise(r=>resolve=r);},onState:s=>states.push(s)});
 return {controller,instances,questions,spoken,states,resolve:r=>resolve(r)};
}
test('phone submits one completed utterance and plays the answer on its own speaker',async()=>{
 const s=setup();s.controller.listen();s.instances[0].emit('Jarvis, where is my helmet?');s.instances[0].onend();s.instances[0].onend();assert.deepEqual(s.questions,['Jarvis, where is my helmet?']);s.resolve({answer:'On the chair, sir.',frames:[],kind:'find'});await new Promise(r=>setTimeout(r,0));assert.deepEqual(s.spoken,['On the chair, sir.']);s.controller.cancel();
});
test('leaving the phone page ignores a late answer and recognition result',async()=>{
 const s=setup();s.controller.listen();const r=s.instances[0];r.emit('find my bag');r.onend();s.controller.cancel();s.resolve({answer:'Old answer'});r.emit('late question');await new Promise(r=>setTimeout(r,0));assert.deepEqual(s.spoken,[]);assert.equal(s.questions.length,1);
});
test('microphone permission denial stays visible and never submits interim words',()=>{
 const s=setup();s.controller.listen();s.instances[0].emit('wrong words',false);s.instances[0].onerror({error:'not-allowed'});s.instances[0].onend();assert.equal(s.questions.length,0);assert.equal(s.states.at(-1),'denied');
});
test('typed fallback works without a speech recognition API',async()=>{
 const spoken=[];const c=createPhoneConversation({Recognition:null,speaker:{unlock(){},stop(){},play:async t=>spoken.push(t)},ask:async()=>({answer:'Here, sir.'})});await c.submit('Where is it?');assert.deepEqual(spoken,['Here, sir.']);
});

test('device speaker decodes backend audio and plays through the unlocked local audio context',async()=>{
 const {createDeviceSpeaker}=await import('../phone-voice.js');const played=[];
 class Context{constructor(){this.state='running';this.sampleRate=44100;}resume(){return Promise.resolve();}createBuffer(){return 'primer';}createBufferSource(){return {connect(){},stop(){},start(){played.push(this.buffer);queueMicrotask(()=>this.onended?.());}};}decodeAudioData(){return Promise.resolve('reply-audio');}}
 globalThis.window={AudioContext:Context};
 const speaker=createDeviceSpeaker({fetchImpl:async()=>({ok:true,headers:{get:()=> 'audio/mpeg'},arrayBuffer:async()=>new ArrayBuffer(1)})});speaker.unlock();await speaker.play('Here, sir.');assert.deepEqual(played,['primer','reply-audio']);speaker.stop();
});
test('suspended device audio exposes replay instead of silently claiming playback',async()=>{
 const {createDeviceSpeaker}=await import('../phone-voice.js');let blocked=0;
 class Context{constructor(){this.state='suspended';this.sampleRate=44100;}resume(){return Promise.resolve();}createBuffer(){}createBufferSource(){return {connect(){},start(){}};}decodeAudioData(){return Promise.resolve({});}}
 globalThis.window={AudioContext:Context};const speaker=createDeviceSpeaker({onBlocked:()=>blocked++,fetchImpl:async()=>({ok:true,headers:{get:()=> 'audio/wav'},arrayBuffer:async()=>new ArrayBuffer(1)})});speaker.unlock();await speaker.play('Here, sir.');assert.equal(blocked,1);speaker.stop();
});
test('ending before the phone finalises still submits the words it heard (no false "no speech")',()=>{
 const s=setup();s.controller.listen();s.instances[0].emit('where is my wallet',false);s.instances[0].onend();
 assert.deepEqual(s.questions,['where is my wallet']);assert.ok(!s.states.includes('no-speech'));
});
test('silence still reports no speech',()=>{
 const s=setup();s.controller.listen();s.instances[0].onend();assert.deepEqual(s.questions,[]);assert.equal(s.states.at(-1),'no-speech');
});
