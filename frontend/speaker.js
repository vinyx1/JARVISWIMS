// Jarvis's voice on this device: POST /speak returns audio (ElevenLabs if configured, else the
// Mac's British "say" voice), played automatically. play() resolves when Jarvis stops talking.
//
// iPhone only plays audio that a tap has unlocked, and microphone changes can suspend Web Audio.
// So playback tries, in order:
//   1. Web Audio, resuming the context if iOS suspended it
//   2. an <audio> element that was unlocked by the first tap (survives mic changes)
//   3. the browser's own en-GB voice
// and only then calls onBlocked (the page shows "Play reply").
import {encodeWav} from './mic.js';

const SILENCE = URL.createObjectURL?.(new Blob([encodeWav(new Float32Array(800))], {type: 'audio/wav'}));

export function createDeviceSpeaker({onBlocked = () => {}, fetchImpl = (...a) => fetch(...a)} = {}) {
  let context = null, source = null, controller = null, generation = 0, settle = null, speechTimer = null;
  let element = null, elementUnlocked = false, elementUrl = null;

  /** Call from every tap/keypress: (re)unlocks both players while we have the user's gesture. */
  function unlock() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        context ??= new AC();
        if (context.state !== 'running') void context.resume().catch(() => {});
        const primer = context.createBufferSource();
        primer.buffer = context.createBuffer(1, 1, context.sampleRate);
        primer.connect(context.destination); primer.start();
      }
    } catch { /* fall through to the element */ }
    try {
      if (!element && typeof Audio !== 'undefined') { element = new Audio(); element.setAttribute('playsinline', ''); }
      if (element && !elementUnlocked && SILENCE) {
        element.src = SILENCE;
        element.play().then(() => { elementUnlocked = true; }).catch(() => {});
      }
    } catch { /* text and replay remain available */ }
  }

  function stop() {
    generation++; controller?.abort(); controller = null;
    try { source?.stop(); } catch {}
    source = null;
    try { element?.pause(); } catch {}
    window.speechSynthesis?.cancel(); clearTimeout(speechTimer);
    settle?.(); settle = null;
  }

  async function viaWebAudio(bytes, token) {
    if (!context) return false;
    if (context.state !== 'running') {
      await Promise.race([context.resume().catch(() => {}), new Promise(r => setTimeout(r, 500))]);
      if (context.state !== 'running') return false;
    }
    const buffer = await context.decodeAudioData(bytes.slice(0));
    if (token !== generation) return true;
    await new Promise(resolve => {
      settle = resolve; source = context.createBufferSource(); source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => { if (token === generation) { source = null; settle = null; } resolve(); };
      source.start();
    });
    return true;
  }

  async function viaElement(bytes, type, token) {
    if (!element) return false;
    if (elementUrl) URL.revokeObjectURL(elementUrl);
    elementUrl = URL.createObjectURL(new Blob([bytes], {type}));
    element.src = elementUrl;
    try { await element.play(); } catch { return false; }
    if (token !== generation) { element.pause(); return true; }
    await new Promise(resolve => {
      settle = resolve;
      const done = () => { element.onended = element.onerror = null; if (token === generation) settle = null; resolve(); };
      element.onended = done; element.onerror = done;
    });
    return true;
  }

  function viaBrowserVoice(text, token) {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return Promise.resolve(false);
    return new Promise(resolve => {
      const u = new window.SpeechSynthesisUtterance(text); u.lang = 'en-GB';
      const voices = window.speechSynthesis.getVoices();
      u.voice = voices.find(v => /daniel/i.test(v.name)) || voices.find(v => v.lang === 'en-GB') || null;
      let started = false;
      u.onstart = () => { started = true; };
      const done = ok => { clearTimeout(speechTimer); if (token === generation) settle = null; resolve(ok); };
      settle = () => done(true);
      u.onend = () => done(true); u.onerror = () => done(started);
      // iOS silently drops speech it won't allow: if it never starts, report failure.
      speechTimer = setTimeout(() => done(started), started ? Math.max(6000, text.length * 100) : 2500);
      window.speechSynthesis.speak(u);
    });
  }

  async function play(text) {
    stop(); const token = generation; controller = new AbortController(); const signal = controller.signal;
    const timer = setTimeout(() => controller?.abort(), 15000);
    let bytes = null, type = 'audio/wav';
    try {
      const response = await fetchImpl('/speak', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({text}), signal});
      type = response.headers.get('content-type') || type;
      if (response.ok && type.startsWith('audio/')) bytes = await response.arrayBuffer();
    } catch {} finally { clearTimeout(timer); }
    if (token !== generation) return;
    if (bytes) {
      try { if (await viaWebAudio(bytes, token)) return; } catch {}
      if (token !== generation) return;
      try { if (await viaElement(bytes, type, token)) return; } catch {}
      if (token !== generation) return;
    }
    if (await viaBrowserVoice(text, token)) return;
    if (token === generation) onBlocked();
  }

  return {unlock, stop, play};
}
