// One spoken exchange at a time: utterance -> POST /listen (Whisper) -> answer -> Jarvis speaks.
// Shared by the phone and the laptop HUD. See mic.js for how utterances are captured.

export const ARMED_MS = 8000;   // after "Jarvis" on its own, the next sentence is the question

/**
 * askWithPhoto(question): optional; when the reply says need_still ("this is my X, remember it"),
 * take a sharp photo, send it, ask the question and return the /ask result.
 * ask(question): optional; when given, /listen only transcribes and this asks the question, so
 * onAccepted() (the acknowledgement chime) plays as soon as Jarvis knows he's being addressed,
 * before the answer is ready. Push-to-talk acknowledges even earlier: on release.
 * @param {{listen: (wav: Uint8Array, mode: 'ask'|'wake') => Promise<any>,
 *          mic: {pause(): void, resume(): Promise<void>},
 *          speak: (text: string) => Promise<void>,
 *          onState?: (s: string) => void, onHeard?: (text: string) => void,
 *          onAnswer?: (result: any, question: string) => void, onError?: (e: Error) => void,
 *          now?: () => number}} opts
 */
export function createConversation({listen, ask = null, askWithPhoto = null, onAccepted = () => {}, mic, speak, onState = () => {}, onHeard = () => {}, onAnswer = () => {}, onError = () => {}, now = () => Date.now()}) {
  let busy = false, armedUntil = 0, generation = 0;

  async function handle(wav, {manual}) {
    if (busy) return;                         // one question at a time; Jarvis is busy
    busy = true; const token = ++generation;
    const mode = manual || now() < armedUntil ? 'ask' : 'wake';
    if (mode === 'ask') onState('thinking');
    if (manual) onAccepted();   // push-to-talk: it's for Jarvis, acknowledge on release
    try {
      const reply = await listen(wav, mode);
      if (token !== generation) return;
      if (reply.heard) onHeard(reply.heard);
      if (reply.armed) { armedUntil = now() + ARMED_MS; onState('armed'); return; }
      armedUntil = 0;
      let result = reply.result;
      if (!result && reply.question && (reply.need_still ? askWithPhoto : ask)) {
        if (!manual) onAccepted();   // hands-free: "Jarvis" confirmed, acknowledge before the wait
        onState('thinking');
        result = await (reply.need_still ? askWithPhoto : ask)(reply.question);
        if (token !== generation) return;
      }
      if (!result) { onState(manual ? 'not-heard' : 'listening'); return; }
      onState('thinking');
      onAnswer(result, reply.question);
      mic.pause(); onState('speaking');
      try { await speak(result.answer); } finally { if (token === generation) await mic.resume(); }
      if (token === generation) onState('listening');
    } catch (error) {
      if (token === generation) { onError(error); onState('error'); }
    } finally {
      if (token === generation) busy = false;
    }
  }

  return {
    handle,
    get busy() { return busy; },
    get armed() { return now() < armedUntil; },
    /** Drop whatever is in flight (mute, page hidden, memory reset). */
    cancel() { generation++; busy = false; armedUntil = 0; },
  };
}
