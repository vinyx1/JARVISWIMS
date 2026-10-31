// Hands-free "Hey Jarvis" on the phone (Paul). Opt-in: the phone keeps listening and submits
// whatever follows "Jarvis". Tap-to-talk stays the default and the fallback.

// Anywhere in the sentence, plus the ways speech recognition commonly mishears "Jarvis".
export const WAKE = /\b(?:(?:hey|ok|okay)\s+)?(?:j[ae]r?v[aeiu]s|jarvi[sz]|jervis|javis|travis|garvis|jarbis)\b[\s,.!?]*/i;
const ARMED_MS = 7000;      // after "Jarvis" alone, the next sentence is the question
const RESTART_MS = 300;     // recognition ends on its own (silence, iOS limits); start it again

/** The words after "Jarvis", '' if nothing follows, or null if "Jarvis" wasn't said. */
export function questionAfterWake(text) {
  const m = String(text).match(WAKE);
  return m ? text.slice(m.index + m[0].length).trim() : null;
}

/**
 * @param {{Recognition: any, onQuestion: (q: string) => void, isBusy: () => boolean,
 *          onState?: (s: string) => void}} opts
 */
export function createWakeListener({Recognition, onQuestion, isBusy, onState = () => {}}) {
  let rec = null, wanted = false, armedUntil = 0, restartTimer = null;

  function handle(text) {
    text = text.trim();
    if (!text || isBusy()) return;                  // ignore Jarvis's own reply and anything mid-answer
    const rest = questionAfterWake(text);
    if (rest !== null && rest.length > 2) { armedUntil = 0; onQuestion(rest); return; }
    if (rest !== null) { armedUntil = Date.now() + ARMED_MS; onState('armed'); return; }
    if (Date.now() < armedUntil) { armedUntil = 0; onQuestion(text); }
  }

  function connect() {
    if (!wanted || rec || !Recognition) return;
    const r = new Recognition(); rec = r;
    r.lang = 'en-US'; r.continuous = true; r.interimResults = false; r.maxAlternatives = 3;
    r.onstart = () => { if (rec === r) onState('hands-free'); };
    r.onresult = e => {
      if (rec !== r) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res.isFinal) continue;
        const alt = [...res].find(a => WAKE.test(a.transcript)) || res[0];
        handle(alt.transcript);
      }
    };
    r.onerror = e => {
      if (rec !== r) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wanted = false; onState('denied'); }
    };
    r.onend = () => {
      if (rec !== r) return;
      rec = null;
      if (wanted) restartTimer = setTimeout(connect, RESTART_MS);
    };
    try { r.start(); } catch { rec = null; }
  }

  function start() { if (!Recognition) { onState('unsupported'); return; } wanted = true; clearTimeout(restartTimer); connect(); }
  function stop() {
    wanted = false; armedUntil = 0; clearTimeout(restartTimer);
    const r = rec; rec = null;
    if (r?.abort) r.abort(); else r?.stop();
    onState('off');
  }
  return {start, stop, get on() { return wanted; }};
}
