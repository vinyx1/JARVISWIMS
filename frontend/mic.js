// Jarvis's ears in the browser, shared by the phone (capture.js) and the laptop HUD (app.js).
//
// No browser speech recognition (it's unreliable on iPhone). Instead we record raw audio,
// find where speech starts and stops by loudness (with a short pre-roll so the first word
// isn't clipped), and hand each utterance to the caller as a 16 kHz mono WAV. The backend
// transcribes it with Whisper (POST /listen).
//
//   const mic = createMic({onUtterance(wav, {manual}) {...}, onLevel(0..1) {...}, onState(s) {...}});
//   await mic.start();        // from a tap/click: asks for the microphone
//   mic.hold(true/false);     // push-to-talk: record exactly while held
//   mic.auto = true;          // hands-free: emit every utterance the VAD finds
//   mic.pause() / mic.resume()   // ignore what the mic hears while Jarvis speaks; the mic stays on

export const RATE = 16000;

/** Average `input` (at `fromRate`) down to 16 kHz. */
export function downsample(input, fromRate, toRate = RATE) {
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = fromRate / toRate, out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = a; j < b; j++) sum += input[j];
    out[i] = b > a ? sum / (b - a) : 0;
  }
  return out;
}

/** 16-bit PCM mono WAV bytes for float samples in [-1, 1]. */
export function encodeWav(samples, rate = RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function rms(frame) { let s = 0; for (const x of frame) s += x * x; return Math.sqrt(s / (frame.length || 1)); }

/**
 * Loudness-based speech detector over 16 kHz frames. push(frame) returns a finished
 * utterance (Float32Array, including pre-roll) when speech ends, else null.
 * The threshold follows the background noise, so it works in a quiet room and a loud venue.
 */
export function createVad({preRollMs = 400, startMs = 120, endSilenceMs = 800, maxMs = 12000, minMs = 350,
                           floorInit = 0.004, ratio = 3, minThreshold = 0.012} = {}) {
  let floor = floorInit, speaking = false, loudMs = 0, quietMs = 0, spokenMs = 0;
  let pre = [], preLen = 0, chunks = [];
  const preMax = RATE * preRollMs / 1000;
  const join = parts => { const n = parts.reduce((a, p) => a + p.length, 0), out = new Float32Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  function reset() { speaking = false; loudMs = quietMs = spokenMs = 0; chunks = []; }
  return {
    get speaking() { return speaking; },
    get threshold() { return Math.max(minThreshold, floor * ratio); },
    push(frame) {
      const level = rms(frame), ms = frame.length / RATE * 1000, loud = level > this.threshold;
      if (!speaking) {
        floor = loud ? floor : floor * 0.95 + level * 0.05;  // learn the room while nobody talks
        pre.push(frame); preLen += frame.length;
        while (preLen - pre[0].length >= preMax) preLen -= pre.shift().length;
        loudMs = loud ? loudMs + ms : 0;
        if (loudMs >= startMs) { speaking = true; chunks = pre; pre = []; preLen = 0; spokenMs = loudMs; quietMs = 0; }
        return null;
      }
      chunks.push(frame); spokenMs += ms; quietMs = loud ? 0 : quietMs + ms;
      if (quietMs >= endSilenceMs || spokenMs >= maxMs) {
        const out = spokenMs - quietMs >= minMs ? join(chunks) : null;
        reset(); return out;
      }
      return null;
    },
    reset() { reset(); pre = []; preLen = 0; },
  };
}

export function createMic({onUtterance, onLevel = () => {}, onState = () => {}, media = () => navigator.mediaDevices}) {
  let ctx = null, stream = null, source = null, node = null, vad = createVad();
  let held = false, heldChunks = [], paused = false, auto = false, wanted = false;

  function frame(input) {
    const pcm = downsample(input, ctx.sampleRate);
    onLevel(Math.min(1, rms(pcm) * 12));
    if (paused) return;
    if (held) { heldChunks.push(pcm); return; }
    if (!auto) return;
    const utterance = vad.push(pcm);
    if (utterance) onUtterance(encodeWav(utterance), {manual: false});
  }

  // iPhone Safari only lets audio start inside the tap itself: create/resume the context
  // synchronously, before awaiting the microphone permission, or it stays silent forever.
  function wakeAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx ??= new AC();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }
  async function open() {
    // Safari 17+: record and play at once, keeping Jarvis on the loudspeaker while the mic is on.
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
    stream = await media().getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1}});
    wakeAudio();
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but works everywhere, including iOS Safari, with no extra file.
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = e => frame(e.inputBuffer.getChannelData(0));
    const sink = ctx.createGain(); sink.gain.value = 0;   // keep the graph running without echoing the mic
    source.connect(node); node.connect(sink); sink.connect(ctx.destination);
  }
  function close() {
    try { source?.disconnect(); node?.disconnect(); } catch {}
    stream?.getTracks().forEach(t => t.stop());
    stream = source = node = null;
  }

  return {
    get on() { return wanted; },
    get auto() { return auto; },
    set auto(v) { auto = !!v; vad.reset(); },
    /** Must be called from a user gesture the first time. Throws if the mic is denied. */
    async start() {
      wakeAudio();   // first, while we're still inside the tap/keypress
      if (wanted && stream) return;
      wanted = true; paused = false; vad.reset();
      try { await open(); onState(held ? 'recording' : 'listening'); }
      catch (e) { wanted = false; close(); onState(e?.name === 'NotAllowedError' ? 'denied' : 'error'); throw e; }
    },
    stop() { wanted = false; held = false; heldChunks = []; close(); vad.reset(); onState('off'); onLevel(0); },
    /** True once the microphone is open and audio is flowing. */
    get ready() { return !!stream && ctx?.state === 'running'; },
    /**
     * Push-to-talk. Releasing sends everything recorded while held.
     * hold(false) returns 'sent', 'too-short' (released almost at once, or silence),
     * or 'not-ready' (the mic was still opening, e.g. during the permission prompt).
     */
    hold(down) {
      if (down === held) return down ? undefined : 'not-ready';
      held = down;
      if (down) { heldChunks = []; vad.reset(); onState('recording'); return; }
      const n = heldChunks.reduce((a, c) => a + c.length, 0);
      const all = new Float32Array(n); let o = 0; for (const c of heldChunks) { all.set(c, o); o += c.length; }
      heldChunks = []; onState(wanted ? 'listening' : 'off');
      if (n >= RATE * 0.3) { onUtterance(encodeWav(all), {manual: true}); return 'sent'; }
      return n === 0 ? 'not-ready' : 'too-short';
    },
    /** Ignore what the mic hears while Jarvis talks (so he doesn't answer himself). The mic stays open. */
    pause() { paused = true; held = false; heldChunks = []; vad.reset(); onLevel(0); },
    async resume() {
      if (!wanted) return;
      paused = false; vad.reset();
      if (!stream) { try { await open(); } catch { wanted = false; onState('error'); return; } }
      onState('listening');
    },
  };
}
