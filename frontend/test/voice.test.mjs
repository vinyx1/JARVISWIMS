import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoice} from '../voice.js';
function setup(){
 const instances=[],spoken=[],states=[],questions=[];
 class Recognition {constructor(){instances.push(this);}start(){this.onstart?.();}stop(){this.onend?.();}emit(text){const row=[{transcript:text}];row.isFinal=true;this.onresult({resultIndex:0,results:[row]});}}
 const synth={speaking:false,getVoices:()=>[{name:'Daniel',lang:'en-GB'}],cancel(){this.speaking=false;},speak(u){spoken.push(u);}};
 globalThis.window={SpeechRecognition:Recognition,speechSynthesis:synth};globalThis.speechSynthesis=synth;globalThis.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
 const voice=createVoice({onState:s=>states.push(s),onQuestion:q=>questions.push(q)});
 return {voice,instances,spoken,states,questions,synth};
}
test('wake word submits only the question and uses British output',()=>{
 const {voice,instances,questions,spoken}=setup();voice.start();instances[0].emit('Jarvis, where is my helmet?');assert.deepEqual(questions,['where is my helmet?']);voice.speak('Very good, sir.');assert.equal(spoken[0].lang,'en-GB');voice.stop();
});
test('stopping during a queued recognition restart does not reopen the microphone',async()=>{
 const {voice,instances}=setup();voice.start();instances[0].onend();voice.stop();await new Promise(r=>setTimeout(r,300));assert.equal(instances.length,1);
});
test('permission denial stays visible after recognition ends',()=>{
 const {voice,instances,states}=setup();voice.start();instances[0].onerror({error:'not-allowed'});instances[0].onend();assert.equal(states.at(-1),'denied');voice.stop();
});
test('push-to-talk stops speech output and submits once after release',async()=>{
 const {voice,instances,questions,synth}=setup();voice.start();synth.speaking=true;voice.pushToTalk(true);assert.equal(synth.speaking,false);instances[0].emit('where are the keys');voice.pushToTalk(false);voice.pushToTalk(false);await new Promise(r=>setTimeout(r,950));assert.deepEqual(questions,['where are the keys']);voice.stop();
});
