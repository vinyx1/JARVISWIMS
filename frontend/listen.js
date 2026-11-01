// One spoken exchange at a time: utterance -> POST /listen (Whisper) -> answer -> Jarvis speaks.
// Shared by the phone and the laptop HUD. See mic.js for how utterances are captured.

export const ARMED_MS = 8000;   // after "Jarvis" on its own, the next sentence is the question

/**
 * @param {{listen: (wav: Uint8Array, mode: 'ask'|'wake') => Promise<any>,
 *          mic: {pause(): void, resume(): Promise<void>},
 *          speak: (text: string) => Promise<void>,
 *          onState?: (s: string) => void, onHeard?: (text: string) => void,
 *          onAnswer?: (result: any, question: string) => void, onError?: (e: Error) => void,
 *          now?: () => number}} opts
 */
export function createConversation({listen, mic, speak, onState = () => {}, onHeard = () => {}, onAnswer = () => {}, onError = () => {}, now = () => Date.now()}) {
  let busy = false, armedUntil = 0, generation = 0;

  async function handle(wav, {manual}) {
    if (busy) return;                         // one question at a time; Jarvis is busy
    busy = true; const token = ++generation;
    const mode = manual || now() < armedUntil ? 'ask' : 'wake';
    if (mode === 'ask') onState('thinking');
    try {
      const reply = await listen(wav, mode);
      if (token !== generation) return;
      if (reply.heard) onHeard(reply.heard);
      if (reply.armed) { armedUntil = now() + ARMED_MS; onState('armed'); return; }
      armedUntil = 0;
      if (!reply.result) { onState(manual ? 'not-heard' : 'listening'); return; }
      onState('thinking');
      onAnswer(reply.result, reply.question);
      mic.pause(); onState('speaking');
      try { await speak(reply.result.answer); } finally { if (token === generation) await mic.resume(); }
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
