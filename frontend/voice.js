// Jarvis voice: wake word ("Jarvis, ..."), hold-space push-to-talk, and British speech out.
// Chrome on the Mac only (webkitSpeechRecognition). Everything degrades to the typed box.

const WAKE = /^\s*(?:hey|ok|okay)?\s*j[ae]rv[iu]s\b[\s,.!?]*/i;

export function createVoice({ onQuestion, onState = () => {}, onHeard = () => {} }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, wanted = false, ptt = false, pttText = '', armedUntil = 0, voice = null;

  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    voice = voices.find(v => /daniel/i.test(v.name)) ||
            voices.find(v => v.lang === 'en-GB') ||
            voices.find(v => v.lang?.startsWith('en')) || null;
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  function speak(text, { interrupt = false } = {}) {
    if (!('speechSynthesis' in window) || !text) return;
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'en-GB';
    u.rate = 1.02; u.pitch = 0.9;
    speechSynthesis.speak(u);
  }

  function handleFinal(text) {
    text = text.trim();
    if (!text) return;
    onHeard(text);
    if (ptt) { pttText += ' ' + text; return; }
    if (speechSynthesis.speaking) return;            // don't hear Jarvis talking to himself
    const m = text.match(WAKE);
    if (m) {
      const rest = text.slice(m[0].length).trim();
      if (rest.length > 2) { armedUntil = 0; onQuestion(rest); }
      else { armedUntil = Date.now() + 7000; onState('armed'); speak('Sir?'); }
    } else if (Date.now() < armedUntil) {
      armedUntil = 0; onQuestion(text);
    }
  }

  function start() {
    if (!SR) { onState('unsupported'); return; }
    wanted = true;
    if (rec) return;
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) handleFinal(r[0].transcript);
        else onHeard(r[0].transcript, true);
      }
    };
    rec.onstart = () => onState(ptt ? 'ptt' : 'listening');
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wanted = false; onState('denied'); }
    };
    rec.onend = () => { rec = null; if (wanted) setTimeout(start, 250); else onState('off'); };
    try { rec.start(); } catch { /* already started */ }
  }

  function stop() { wanted = false; rec?.stop(); }

  // Hold space: everything said until release is the question, no wake word needed.
  function pushToTalk(down) {
    if (!SR) return;
    if (down && !ptt) { ptt = true; pttText = ''; onState('ptt'); start(); }
    if (!down && ptt) {
      setTimeout(() => {                                // let the last final result arrive
        ptt = false; onState('listening');
        const q = pttText.replace(WAKE, '').trim();
        if (q.length > 2) onQuestion(q);
      }, 900);
    }
  }

  return { start, stop, speak, pushToTalk, supported: !!SR };
}
