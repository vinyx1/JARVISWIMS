import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversation, ARMED_MS} from '../listen.js';

function setup(replies) {
  const calls = [], states = [], spoken = [], mic = {paused: 0, resumed: 0, pause() { this.paused++; }, async resume() { this.resumed++; }};
  let t = 0;
  const convo = createConversation({
    listen: async (wav, mode) => { calls.push(mode); return replies.shift(); },
    mic, speak: async text => { spoken.push(text); },
    onState: s => states.push(s), now: () => t,
  });
  return {convo, calls, states, spoken, mic, advance: ms => { t += ms; }};
}
const answer = text => ({heard: `Jarvis, ${text}`, question: text, armed: false, result: {answer: 'On the chair, sir.', kind: 'find', frames: []}});

test('push-to-talk asks, speaks the answer, and pauses the mic while speaking', async () => {
  const s = setup([answer('where is my helmet')]);
  await s.convo.handle(new Uint8Array(), {manual: true});
  assert.deepEqual(s.calls, ['ask']);
  assert.deepEqual(s.spoken, ['On the chair, sir.']);
  assert.equal(s.mic.paused, 1); assert.equal(s.mic.resumed, 1);
  assert.equal(s.states.at(-1), 'listening');
});

test('hands-free sends in wake mode and ignores chatter without "Jarvis"', async () => {
  const s = setup([{heard: 'nice costume', question: null, armed: false, result: null}]);
  await s.convo.handle(new Uint8Array(), {manual: false});
  assert.deepEqual(s.calls, ['wake']);
  assert.deepEqual(s.spoken, []);
  assert.ok(!s.states.includes('thinking'), 'no thinking flash for background chatter');
});

test('"Jarvis" alone arms: the next utterance is the question, until it times out', async () => {
  const s = setup([{heard: 'Jarvis', question: null, armed: true, result: null}, answer('where are my keys'),
                   {heard: 'Jarvis', question: null, armed: true, result: null}, {heard: 'hello', question: null, armed: false, result: null}]);
  await s.convo.handle(new Uint8Array(), {manual: false});
  assert.ok(s.convo.armed);
  await s.convo.handle(new Uint8Array(), {manual: false});
  assert.deepEqual(s.calls, ['wake', 'ask']);
  await s.convo.handle(new Uint8Array(), {manual: false});
  s.advance(ARMED_MS + 1);
  await s.convo.handle(new Uint8Array(), {manual: false});
  assert.deepEqual(s.calls, ['wake', 'ask', 'wake', 'wake']);
});

test('one exchange at a time; cancel drops the reply in flight', async () => {
  let release;
  const mic = {pause() {}, async resume() {}}, spoken = [];
  const convo = createConversation({listen: () => new Promise(r => { release = r; }), mic, speak: async t => { spoken.push(t); }});
  const first = convo.handle(new Uint8Array(), {manual: true});
  await convo.handle(new Uint8Array(), {manual: true});   // ignored while busy
  convo.cancel();
  release(answer('where is my helmet')); await first;
  assert.deepEqual(spoken, []);
  assert.equal(convo.busy, false);
});

test('"this is my X" from a camera device: take a photo, then answer from it', async () => {
  const photoAsks = [], spoken = [];
  const convo = createConversation({
    listen: async () => ({heard: 'Jarvis, this is my mug, remember it', question: 'this is my mug, remember it', armed: false, result: null, need_still: true}),
    askWithPhoto: async q => { photoAsks.push(q); return {answer: 'Noted, sir.', kind: 'remember', frames: []}; },
    mic: {pause() {}, async resume() {}}, speak: async t => { spoken.push(t); },
  });
  await convo.handle(new Uint8Array(), {manual: false});
  assert.deepEqual(photoAsks, ['this is my mug, remember it']);
  assert.deepEqual(spoken, ['Noted, sir.']);
});

test('hands-free: the chime plays once "Jarvis" is confirmed, before the answer is fetched', async () => {
  const order = [];
  const convo = createConversation({
    listen: async (wav, mode) => { order.push(`listen:${mode}`); return {heard: 'Jarvis, where is my mug', question: 'where is my mug', armed: false, result: null, need_still: false}; },
    ask: async q => { order.push(`ask:${q}`); return {answer: 'On the desk, sir.', kind: 'find', frames: []}; },
    onAccepted: () => order.push('chime'),
    mic: {pause() {}, async resume() {}}, speak: async t => { order.push(`speak:${t}`); },
  });
  await convo.handle(new Uint8Array(), {manual: false});
  assert.deepEqual(order, ['listen:wake', 'chime', 'ask:where is my mug', 'speak:On the desk, sir.']);
});

test('push-to-talk chimes on release; chatter never chimes', async () => {
  const chimes = [];
  const make = reply => createConversation({listen: async () => reply, ask: async () => ({answer: 'x', kind: 'other', frames: []}),
    onAccepted: () => chimes.push(1), mic: {pause() {}, async resume() {}}, speak: async () => {}});
  await make({heard: 'where is my mug', question: 'where is my mug', armed: false, result: null}).handle(new Uint8Array(), {manual: true});
  assert.equal(chimes.length, 1);   // once, on release (not again after transcribing)
  await make({heard: 'nice costume', question: null, armed: false, result: null}).handle(new Uint8Array(), {manual: false});
  assert.equal(chimes.length, 1);
});

test('filler: speaks while the answer is worked out, finishes its line, then the answer', async () => {
  const spoken = [], shown = [], mic = {paused: 0, resumed: 0, pause() { this.paused++; }, async resume() { this.resumed++; }};
  let answerReady;
  const convo = createConversation({
    listen: async () => ({heard: 'Jarvis, where is my bottle', question: 'where is my bottle', armed: false, result: null}),
    ask: () => new Promise(r => { answerReady = r; }),
    filler: () => [{after: 0, text: 'Let me think, sir.'}, {after: 60000, text: 'Still looking, sir.'}],
    onFiller: t => shown.push(t),
    mic, speak: async t => { spoken.push(t); await new Promise(r => setTimeout(r, 20)); },
  });
  const done = convo.handle(new Uint8Array(), {manual: true});
  await new Promise(r => setTimeout(r, 5));
  answerReady({answer: 'Aha, there it is, sir.', kind: 'find', frames: []});
  await done;
  assert.deepEqual(spoken, ['Let me think, sir.', 'Aha, there it is, sir.'], 'the later line is dropped once the answer is in');
  assert.deepEqual(shown, ['Let me think, sir.']);
  assert.equal(mic.paused, mic.resumed, 'the mic is resumed as often as it was paused');
});

test('filler: a fast answer means no filler at all', async () => {
  const spoken = [];
  const convo = createConversation({
    listen: async () => ({heard: 'Jarvis, hi', question: 'hi', armed: false, result: null}),
    ask: async () => ({answer: 'Good evening, sir.', kind: 'other', frames: []}),
    filler: () => [{after: 500, text: 'One moment, sir.'}],
    mic: {pause() {}, async resume() {}}, speak: async t => { spoken.push(t); },
  });
  await convo.handle(new Uint8Array(), {manual: true});
  assert.deepEqual(spoken, ['Good evening, sir.']);
});
