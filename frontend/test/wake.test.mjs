import test from 'node:test';
import assert from 'node:assert/strict';
import {questionAfterWake, createWakeListener} from '../wake.js';

test('finds the question after "Jarvis" anywhere in the sentence, including common mishearings', () => {
  assert.equal(questionAfterWake('Hey Jarvis, where is my wallet?'), 'where is my wallet?');
  assert.equal(questionAfterWake('so jarvis where did I leave my helmet'), 'where did I leave my helmet');
  assert.equal(questionAfterWake('Travis find my phone'), 'find my phone');
  assert.equal(questionAfterWake('Jarvis'), '');
  assert.equal(questionAfterWake('what a great service'), null);
});

function fakeRecognition() {
  const made = [];
  class Rec { constructor() { made.push(this); this.started = 0; } start() { this.started++; this.onstart?.(); } stop() { this.onend?.(); } abort() { this.onend?.(); }
    say(text) { const row = [{transcript: text}]; row.isFinal = true; this.onresult({resultIndex: 0, results: [row]}); } }
  return {Rec, made};
}

test('hands-free: "Hey Jarvis, <question>" submits the question once', () => {
  const {Rec, made} = fakeRecognition(); const asked = [];
  const wake = createWakeListener({Recognition: Rec, onQuestion: q => asked.push(q), isBusy: () => false});
  wake.start(); made[0].say('hey Jarvis where is my wallet'); made[0].say('this is just chatter');
  assert.deepEqual(asked, ['where is my wallet']); wake.stop();
});

test('hands-free: "Jarvis" alone arms the next sentence as the question', () => {
  const {Rec, made} = fakeRecognition(); const asked = [], states = [];
  const wake = createWakeListener({Recognition: Rec, onQuestion: q => asked.push(q), isBusy: () => false, onState: s => states.push(s)});
  wake.start(); made[0].say('Jarvis'); made[0].say('where did I put my keys');
  assert.deepEqual(asked, ['where did I put my keys']); assert.ok(states.includes('armed')); wake.stop();
});

test('hands-free ignores what it hears while Jarvis is busy answering', () => {
  const {Rec, made} = fakeRecognition(); const asked = []; let busy = true;
  const wake = createWakeListener({Recognition: Rec, onQuestion: q => asked.push(q), isBusy: () => busy});
  wake.start(); made[0].say('Jarvis where is my wallet'); assert.deepEqual(asked, []);
  busy = false; made[0].say('Jarvis where is my wallet'); assert.deepEqual(asked, ['where is my wallet']); wake.stop();
});

test('stopping hands-free does not restart the microphone', async () => {
  const {Rec, made} = fakeRecognition();
  const wake = createWakeListener({Recognition: Rec, onQuestion: () => {}, isBusy: () => false});
  wake.start(); wake.stop(); await new Promise(r => setTimeout(r, 400));
  assert.equal(made.length, 1);
});
