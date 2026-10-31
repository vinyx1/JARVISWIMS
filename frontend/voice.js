// Jarvis voice: wake word ("Jarvis, ..."), hold-space push-to-talk, and British speech out.
// Chrome on the Mac only (webkitSpeechRecognition). Everything degrades to the typed box.
//
// Speech out: the ElevenLabs "Jarvis" voice via POST /speak (backend/voice.py), but only after
// preload() has proved /speak returns audio. Until then, and whenever /speak is slow or fails,
// the browser's British voice speaks, synchronously, exactly as before.
// onLevel(0..1) reports how loud Jarvis is, for the HUD's voice indicator.

// Anywhere in the sentence, plus the ways Chrome commonly mishears "Jarvis".
const WAKE = /\b(?:(?:hey|ok|okay)\s+)?(?:j[ae]r?v[aeiu]s|jarvi[sz]|jervis|javis|travis|garvis|jarbis)\b[\s,.!?]*/i;
const SPEAK_TIMEOUT_MS = 2500;

export function createVoice({ onQuestion, onState = () => {}, onHeard = () => {}, onLevel = () => {} }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, wanted = false, ptt = false, pttText = '', armedUntil = 0, voice = null, restartTimer = null, releaseTimer = null, blocked = false;
  let remote = false, queue = Promise.resolve(), generation = 0, playing = null, levelRaf = 0, audioCtx = null, analyser = null;
  const preloaded = new Map();   // text -> Promise<Blob|null>

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    voice = voices.find(v => /daniel/i.test(v.name)) ||
            voices.find(v => v.lang === 'en-GB') ||
            voices.find(v => v.lang?.startsWith('en')) || null;
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  // ---------- browser voice (always available, synchronous) ----------
  function speakBrowser(text, onDone = () => {}) {
    if (!('speechSynthesis' in window) || !text) { onDone(); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'en-GB';
    u.rate = 1.02; u.pitch = 0.9;
    u.onstart = trackLevel; u.onend = onDone; u.onerror = onDone;
    speechSynthesis.speak(u);
  }

  // ---------- ElevenLabs voice via /speak ----------
  async function requestSpeech(text) {
    if (typeof fetch !== 'function') return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SPEAK_TIMEOUT_MS);
    try {
      const r = await fetch('/speak', { method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (r.status !== 200) return null;
      const blob = await r.blob();
      return blob.type.startsWith('audio/') ? blob : null;
    } catch { return null; }                          // offline or too slow: browser voice
    finally { clearTimeout(timer); }
  }

  // Fetch lines we know in advance (fillers, "Sir?"). The first success switches on the ElevenLabs voice.
  function preload(texts) {
    for (const t of texts) {
      if (preloaded.has(t)) continue;
      const p = requestSpeech(t); preloaded.set(t, p);
      p.then(blob => { if (blob) remote = true; });
    }
  }

  function connectAnalyser(audio) {
    try {
      audioCtx ??= new AudioContext();
      if (!analyser) { analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; analyser.connect(audioCtx.destination); }
      audioCtx.createMediaElementSource(audio).connect(analyser);
      audioCtx.resume().catch(() => {});
    } catch { /* no Web Audio: audio still plays, the indicator just pulses */ }
  }

  function playBlob(blob) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob), audio = new Audio(url);
      playing = audio; connectAnalyser(audio);
      const done = () => { if (playing === audio) playing = null; URL.revokeObjectURL(url); resolve(); };
      audio.onended = done; audio.onerror = done; audio.onpause = done;
      audio.play().then(trackLevel, done);
    });
  }

  const isSpeaking = () => !!playing || !!window.speechSynthesis?.speaking;

  function trackLevel() {
    if (levelRaf || typeof requestAnimationFrame !== 'function') return;
    const buf = new Uint8Array(512);
    const tick = t => {
      let level = 0;
      if (playing && analyser) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2;
        level = Math.min(1, Math.sqrt(sum / buf.length) * 5);
      } else if (isSpeaking()) {
        level = 0.35 + 0.3 * Math.abs(Math.sin(t / 95));              // browser voice: a speaking pulse
      }
      onLevel(level);
      if (isSpeaking()) levelRaf = requestAnimationFrame(tick); else { levelRaf = 0; onLevel(0); }
    };
    levelRaf = requestAnimationFrame(tick);
  }

  function silence() {
    generation++; queue = Promise.resolve();
    playing?.pause(); playing = null;
    window.speechSynthesis?.cancel();
  }

  function speak(text, { interrupt = false } = {}) {
    if (!text) return;
    if (interrupt) silence();
    if (!remote) { speakBrowser(text); return; }      // /speak not proven: same as before, no delay
    const gen = generation;
    const audio = preloaded.get(text) ?? requestSpeech(text);   // fetch now, play in order
    queue = queue.then(async () => {
      const blob = await audio;
      if (gen !== generation) return;
      if (blob) await playBlob(blob);
      else await new Promise(done => speakBrowser(text, done));
    });
  }

  function handleFinal(text) {
    text = text.trim();
    if (!text) return;
    onHeard(text);
    if (ptt) { pttText += ' ' + text; return; }
    if (isSpeaking()) return;                                  // don't hear Jarvis talking to himself
    const m = text.match(WAKE);
    if (m) {
      const rest = text.slice(m.index + m[0].length).trim();
      if (rest.length > 2) { armedUntil = 0; onQuestion(rest); }
      else { armedUntil = Date.now() + 7000; onState('armed'); speak('Sir?'); }
    } else if (Date.now() < armedUntil) {
      armedUntil = 0; onQuestion(text);
    }
  }

  function connect() {
    if (!wanted) return;
    if (!SR) { onState('unsupported'); return; }
    if (rec) return;
    rec = new SR();
    const recognition = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.lang = 'en-US';
    rec.onresult = e => {
      if (!wanted || rec !== recognition) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) handleFinal(([...r].find(alt => WAKE.test(alt.transcript)) || r[0]).transcript);
        else onHeard(r[0].transcript, true);
      }
    };
    rec.onstart = () => { if (wanted && rec === recognition) onState(ptt ? 'ptt' : 'listening'); };
    rec.onerror = e => {
      if (rec !== recognition) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wanted = false; blocked = true; clearTimeout(restartTimer); onState('denied'); }
    };
    rec.onend = () => { if (rec !== recognition) return; rec = null; if (wanted) restartTimer = setTimeout(() => { if (wanted) connect(); }, 250); else onState(blocked ? 'denied' : 'off'); };
    try { rec.start(); } catch { /* already started */ }
  }

  function start() { wanted = true; blocked = false; clearTimeout(restartTimer); connect(); }
  function stop() {
    wanted = false; blocked = false; ptt = false; pttText = ''; armedUntil = 0;
    clearTimeout(restartTimer); clearTimeout(releaseTimer); releaseTimer = null;
    silence();
    const previous = rec; rec = null;
    if (previous?.abort) previous.abort(); else previous?.stop();
    onState('off');
  }

  // Hold space: everything said until release is the question, no wake word needed.
  function pushToTalk(down) {
    if (!SR) return;
    if (down && !ptt) { clearTimeout(releaseTimer); releaseTimer = null; silence(); ptt = true; pttText = ''; onState('ptt'); start(); }
    if (!down && ptt && releaseTimer === null) {
      releaseTimer = setTimeout(() => {                                // let the last final result arrive
        releaseTimer = null; ptt = false; onState(blocked ? 'denied' : wanted ? 'listening' : 'off');
        const q = pttText.replace(WAKE, '').trim();
        if (wanted && q.length > 2) onQuestion(q);
      }, 900);
    }
  }

  return { start, stop, speak, preload, pushToTalk, isSpeaking, supported: !!SR };
}
