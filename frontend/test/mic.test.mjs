import test from 'node:test';
import assert from 'node:assert/strict';
import {RATE, createVad, downsample, encodeWav, rms} from '../mic.js';

const FRAME = 1024;   // ~64 ms at 16 kHz
const tone = (amp, n = FRAME) => Float32Array.from({length: n}, (_, i) => amp * Math.sin(i / 3));
const quiet = (n = FRAME) => Float32Array.from({length: n}, () => (Math.random() - .5) * 0.004);

test('downsample 48 kHz to 16 kHz keeps a third of the samples and the level', () => {
  const out = downsample(tone(0.5, 4800), 48000);
  assert.equal(out.length, 1600);
  assert.ok(rms(out) > 0.2);
});

test('encodeWav writes a 16 kHz mono 16-bit header and clamps samples', () => {
  const wav = encodeWav(Float32Array.from([0, 1, -1, 2]));
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(v.getUint16(22, true), 1);          // mono
  assert.equal(v.getUint32(24, true), RATE);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 8);          // 4 samples * 2 bytes
  assert.equal(v.getInt16(46, true), 32767);       // 1.0
  assert.equal(v.getInt16(50, true), 32767);       // 2.0 clamped
  assert.equal(wav.length, 52);
});

test('VAD: speech after quiet comes out as one utterance, with pre-roll, after the pause', () => {
  const vad = createVad();
  let out = null;
  for (let i = 0; i < 20; i++) assert.equal(vad.push(quiet()), null);   // learn the room
  for (let i = 0; i < 20; i++) assert.equal(vad.push(tone(0.2)), null); // ~1.3 s of speech
  assert.ok(vad.speaking);
  for (let i = 0; i < 20 && !out; i++) out = vad.push(quiet());         // pause ends it
  assert.ok(out, 'utterance emitted after silence');
  assert.ok(out.length > 20 * FRAME, 'includes pre-roll before the speech started');
  assert.ok(out.length < 20 * FRAME + RATE * 1.4);
  assert.equal(vad.speaking, false);
});

test('VAD ignores a short click and steady background noise', () => {
  const vad = createVad();
  for (let i = 0; i < 20; i++) vad.push(quiet());
  vad.push(tone(0.2)); // one 64 ms click: too short to start
  for (let i = 0; i < 30; i++) assert.equal(vad.push(quiet()), null);
  assert.equal(vad.speaking, false);
});

test('VAD adapts to a loud room: steady noise is the floor, speech above it still counts', () => {
  const vad = createVad();
  const noise = () => Float32Array.from({length: FRAME}, () => (Math.random() - .5) * 0.02); // rms ~.006
  for (let i = 0; i < 60; i++) assert.equal(vad.push(noise()), null);
  let out = null;
  for (let i = 0; i < 15; i++) vad.push(tone(0.3));
  for (let i = 0; i < 20 && !out; i++) out = vad.push(noise());
  assert.ok(out);
});

test('VAD cuts very long speech at the maximum length', () => {
  const vad = createVad({maxMs: 2000});
  let out = null, frames = 0;
  while (!out && frames < 100) { out = vad.push(tone(0.2)); frames++; }
  assert.ok(out && frames < 40);
});

test('releasing push-to-talk before the mic opened reports not-ready and sends nothing', async () => {
  const {createMic} = await import('../mic.js');
  const sent = [];
  const mic = createMic({onUtterance: w => sent.push(w)});
  mic.hold(true);
  assert.equal(mic.hold(false), 'not-ready');
  assert.equal(mic.hold(false), 'not-ready');   // a second release is harmless
  assert.deepEqual(sent, []);
});
