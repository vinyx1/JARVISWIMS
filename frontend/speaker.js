// Jarvis's voice on this device: POST /speak returns audio (ElevenLabs if configured, else the
// Mac's British "say" voice), played automatically. play() resolves when Jarvis stops talking.
//
// iPhone only plays audio that a tap has unlocked. Playback tries, in order:
//   1. an <audio> element unlocked by a tap: the phone's media player, which ignores the silent
//      switch and survives mic changes
//   2. Web Audio (muted by the silent switch on iPhone, so only a fallback)
//   3. the browser's own en-GB voice
// and only then calls onBlocked (the page shows "Play reply"). onEvent reports which path played
// or why it failed, so intermittent silence can be diagnosed from the server log.
import {encodeWav} from './mic.js';

const SILENCE = URL.createObjectURL?.(new Blob([encodeWav(new Float32Array(800))], {type: 'audio/wav'}));

/** The acknowledgement chime: two quick rising notes (C6 then G6) with soft attack and decay. */
export function chimeSamples(rate = 44100) {
  const notes = [[1046.5, 0, 0.11], [1568, 0.085, 0.2]], len = Math.round(rate * 0.3), out = new Float32Array(len);
  for (const [freq, start, dur] of notes) {
    const s0 = Math.round(start * rate), n = Math.round(dur * rate);
    for (let i = 0; i < n && s0 + i < len; i++) {
      const t = i / rate, env = Math.min(1, t / 0.006) * Math.exp(-t * 18);
      out[s0 + i] += 0.32 * env * (Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(4 * Math.PI * freq * t));
    }
  }
  return out;
}
const CHIME = URL.createObjectURL?.(new Blob([encodeWav(chimeSamples(), 44100)], {type: 'audio/wav'}));

export function createDeviceSpeaker({onBlocked = () => {}, onEvent = () => {}, fetchImpl = (...a) => fetch(...a)} = {}) {
  let context = null, source = null, controller = null, generation = 0, settle = null, speechTimer = null;
  let element = null, elementUnlocked = false, elementUrl = null, elementBusy = false;
  let chimeEl = null, chimeUnlocked = false;   // its own player, so a chime never cuts off a reply

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
      // never swap a reply that is playing for the silent unlock clip
      if (element && !elementUnlocked && !elementBusy && SILENCE) {
        element.src = SILENCE;
        element.play().then(() => { elementUnlocked = true; }).catch(() => {});
      }
    } catch { /* text and replay remain available */ }
    try {
      if (!chimeEl && typeof Audio !== 'undefined') { chimeEl = new Audio(); chimeEl.setAttribute('playsinline', ''); }
      if (chimeEl && !chimeUnlocked && SILENCE) { chimeEl.src = SILENCE; chimeEl.play().then(() => { chimeUnlocked = true; }).catch(() => {}); }
    } catch {}
  }

  /** "Got it, sir": a short acknowledgement the moment a question is accepted. Never throws. */
  function chime() {
    try {
      if (!chimeEl || !CHIME) return;
      chimeEl.src = CHIME; chimeEl.currentTime = 0; chimeEl.volume = 0.8;
      chimeEl.play().then(() => { chimeUnlocked = true; }).catch(() => {
        if (context?.state !== 'running') return;   // fallback: the same notes through Web Audio
        const now = context.currentTime;
        for (const [f, at] of [[1046.5, 0], [1568, 0.085]]) {
          const o = context.createOscillator(), g = context.createGain();
          o.frequency.value = f; g.gain.setValueAtTime(0.0001, now + at);
          g.gain.exponentialRampToValueAtTime(0.25, now + at + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.2);
          o.connect(g); g.connect(context.destination); o.start(now + at); o.stop(now + at + 0.22);
        }
      });
    } catch {}
  }

  function stop() {
    generation++; controller?.abort(); controller = null;
    try { source?.stop(); } catch {}
    source = null;
    try { element?.pause(); } catch {}
    elementBusy = false;
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
    if (typeof Audio === 'undefined') return false;
    element ??= new Audio(); element.setAttribute('playsinline', '');
    if (elementUrl) URL.revokeObjectURL(elementUrl);
    elementUrl = URL.createObjectURL(new Blob([bytes], {type}));
    elementBusy = true; element.src = elementUrl;
    try { await element.play(); } catch (err) { elementBusy = false; onEvent('element-failed', err?.name || String(err)); return false; }
    elementUnlocked = true;   // it played, so it's unlocked from now on
    if (token !== generation) { element.pause(); elementBusy = false; return true; }
    await new Promise(resolve => {
      settle = resolve;
      // ended can be missed on iOS: give up waiting a little after the clip's length
      const guard = setTimeout(() => done(), ((element.duration || 20) + 2) * 1000);
      function done() { clearTimeout(guard); element.onended = element.onerror = null; elementBusy = false; if (token === generation) settle = null; resolve(); }
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
    if (!bytes) onEvent('no-audio-from-laptop', 'falling back to the browser voice');
    if (bytes) {
      try { if (await viaElement(bytes, type, token)) { onEvent('played', 'media'); return; } } catch {}
      if (token !== generation) return;
      try { if (await viaWebAudio(bytes, token)) { onEvent('played', 'webaudio'); return; } } catch (err) { onEvent('webaudio-failed', err?.name || ''); }
      if (token !== generation) return;
    }
    if (await viaBrowserVoice(text, token)) { onEvent('played', 'browser-voice'); return; }
    if (token === generation) { onEvent('blocked', 'every playback path refused'); onBlocked(); }
  }

  return {unlock, stop, play, chime};
}
