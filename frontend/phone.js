// The suit camera (phone). Just the camera: Begin asks for camera + mic, then photos and the live
// preview stream to the laptop while it listens for "Jarvis". When he's addressed, a Siri-style
// panel with the Jarvis core slides up, shows what you asked and what he says, then fades away.
// Hold anywhere on the screen to talk without the wake word. Old controls: capture-debug.html.
import {createApi, clientId} from './api.js';
import {createCameraController, captureFrame} from './camera.js';
import {createCaptureLoop} from './core.js';
import {createPreviewSender} from './preview.js';
import {createMic} from './mic.js';
import {createConversation} from './listen.js';
import {createDeviceSpeaker} from './speaker.js';
import {createReactor} from './reactor.js';

const $ = id => document.getElementById(id);
const video = $('cam');
const api = createApi(), voiceApi = createApi({timeoutMs: 30000}), previewApi = createApi({timeoutMs: 2000});
const core = createReactor($('core'), {reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches});
core.readouts = false;
const WORDS_PER_S = 2.6;
const WAKE = /\b(?:(?:hey|ok|okay|hi)[\s,]+)?(?:jarvis|jarvi[sz]|j[ae]r?v[aeiu]s|jervis|javis|travis|garvis|jarbis)\b[\s,.!?]*/i;
const withoutWake = text => (text || '').replace(WAKE, '').trim().replace(/^./, c => c.toUpperCase());
let live = false, wakeLock = null, lastReply = '', replayOnTap = false;

function toast(text, ms = 2600) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').hidden = true), ms); }

// ---------- camera, photos every 3 s, live preview ----------
const camera = createCameraController({
  media: {getUserMedia: c => { c.video = {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1080}}; return navigator.mediaDevices.getUserMedia(c); }},
  attach(stream) { video.srcObject = stream; if (stream) video.play().catch(() => {}); },
  onEnded() { pause('The camera stopped. Tap Begin to restart.'); },
});
const loop = createCaptureLoop({
  sample: () => captureFrame(video, {width: 1024, quality: 0.8}),
  upload: (blob, ts) => api.uploadFrame(blob, ts),
  onSaved() {},
  onError(error, {stopped}) { if (stopped) pause('Lost the connection to the laptop. Tap Begin to retry.'); },
});
const preview = createPreviewSender({
  intervalMs: 66, maxInFlight: 5,
  sample: () => captureFrame(video, video.videoWidth > video.videoHeight ? {width: 640, quality: 0.5} : {width: 360, quality: 0.45}),
  send: (blob, ts, signal) => previewApi.uploadPreview(blob, ts, signal),
  canSend: () => loop.running && !document.hidden,
});
async function sharpStill() {
  if (!camera.stream || video.readyState < 2) return null;
  try { return (await captureFrame(video, {width: 1920, quality: 0.88}))?.blob || null; } catch { return null; }
}

// ---------- the Siri-style panel ----------
let hideTimer = null, revealTimer = null, speakingUntil = 0, micLevel = 0, panelOn = false;
function showPanel(mode, {heard, said} = {}) {
  clearTimeout(hideTimer);
  panelOn = true; document.body.dataset.mode = mode; core.state = mode;
  $('assist').classList.add('on'); $('assist').setAttribute('aria-hidden', 'false');
  if (heard !== undefined) $('heard').textContent = heard;
  if (said !== undefined) setSaid(said);
}
function hidePanel(delay = 0) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    panelOn = false; $('assist').classList.remove('on'); $('assist').setAttribute('aria-hidden', 'true');
    document.body.dataset.mode = 'idle'; core.state = 'idle';
  }, delay);
}
function setSaid(text) {
  clearInterval(revealTimer);
  const words = (text || '').split(/\s+/).filter(Boolean);
  $('said').replaceChildren(...words.flatMap(w => { const s = document.createElement('span'); s.className = 'w'; s.textContent = w; return [s, document.createTextNode(' ')]; }));
  const spans = [...$('said').querySelectorAll('.w')]; let i = 0;
  if (spans.length) revealTimer = setInterval(() => { spans[i++]?.classList.add('on'); if (i >= spans.length) clearInterval(revealTimer); }, 1000 / WORDS_PER_S);
  return words.length / WORDS_PER_S;
}
(function levels() {   // the core breathes with your voice, then with his
  const t = performance.now() / 1000, talking = performance.now() < speakingUntil;
  core.level = talking ? 0.35 + 0.45 * Math.abs(Math.sin(t * 7.3)) * (0.6 + 0.4 * Math.sin(t * 2.1)) : micLevel * 0.8;
  requestAnimationFrame(levels);
})();

// ---------- Jarvis's voice on this phone ----------
const speaker = createDeviceSpeaker({
  onBlocked() { replayOnTap = true; toast('Tap the screen to hear Jarvis'); },
  onEvent: (event, detail) => { fetch('/client-log', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({event, detail})}).catch(() => {}); },
});
async function speakHere(text) {
  mic.pause();   // the mic stays on, but ignores his own voice
  try { await speaker.play(text); } finally { await mic.resume(); }
}
// ---------- the photo wheel: where he saw it ----------
// One photo at a time, ‹ › (or a swipe) to step through. The first is where he's sure it is
// ("sure", or simply the first of an ordinary answer); the rest are where it might be.
// Tap the photo: "that's it" (POST /confirm). ×: none of them, keep looking (POST /watch).
// For a retrace the target is the last breadcrumb, so only that one is shown.
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 5 ? 'JUST NOW' : s < 60 ? `${s}S AGO` : s < 3600 ? `${Math.round(s / 60)}M AGO` : `${Math.round(s / 3600)}H AGO`;
}
const wheel = {shots: [], i: 0, item: null, busy: false};
function hideFound() { $('found').hidden = true; document.body.classList.remove('has-found'); wheel.shots = []; wheel.item = null; }
function showShot(i) {
  const n = wheel.shots.length; wheel.i = (i + n) % n;
  const f = wheel.shots[wheel.i];
  const lead = wheel.i === 0 && f.sure !== false;
  $('foundCard').classList.toggle('sure', lead);
  $('foundImg').src = f.url; $('foundImg').alt = f.note || 'Sighting';
  $('foundTag').textContent = `${lead ? (f.sure ? 'FOUND' : 'LAST SEEN') : 'MIGHT BE HERE'} · ${Number.isFinite(f.ts) ? ago(f.ts) : ''}`;
  $('foundNote').textContent = f.note || '';
  $('foundHint').textContent = wheel.item ? "Tap the photo if that's it" : '';
  $('foundCount').textContent = n > 1 ? `${wheel.i + 1} / ${n}` : '';
  $('foundPrev').hidden = $('foundNext').hidden = n < 2;
}
function showFound(result) {
  const frames = (result?.frames || []).filter(f => f && typeof f.url === 'string');
  const shots = result?.kind === 'find' ? frames : result?.kind === 'retrace' ? frames.slice(-1) : [];
  if (!shots.length) { hideFound(); return; }
  wheel.shots = shots; wheel.item = result.kind === 'find' && typeof result.item === 'string' ? result.item : null;
  $('found').hidden = false; document.body.classList.add('has-found'); showShot(0);
}
// Jarvis says something outside a question (after a tap on the wheel).
async function jarvisSays(text) {
  lastReply = text;
  showPanel('speaking', {heard: '', said: ''});
  speakingUntil = performance.now() + setSaid(text) * 1000;
  await speakHere(text);
  hidePanel(Math.max(1800, speakingUntil - performance.now() + 1800));
}
async function wheelAction(call) {
  if (wheel.busy) return; wheel.busy = true;
  try { const reply = await call(); hideFound(); await jarvisSays(reply.answer); }
  catch (error) { toast(error.message); }
  finally { wheel.busy = false; }
}
$('foundPrev').onclick = () => showShot(wheel.i - 1);
$('foundNext').onclick = () => showShot(wheel.i + 1);
let swipeX = null, swiped = false;
$('foundCard').addEventListener('pointerdown', e => { swipeX = e.clientX; swiped = false; });
$('foundCard').addEventListener('pointerup', e => {
  if (swipeX === null) return;
  const dx = e.clientX - swipeX; swipeX = null;
  if (Math.abs(dx) > 40 && wheel.shots.length > 1) { swiped = true; showShot(wheel.i + (dx < 0 ? 1 : -1)); }
});
$('foundShot').onclick = () => {
  if (swiped || !wheel.item) return;
  const f = wheel.shots[wheel.i], item = wheel.item;
  void wheelAction(() => api.confirmSighting(item, f.id, f.where));
};
$('foundClose').onclick = () => {
  const item = wheel.item;
  if (!item) { hideFound(); return; }
  void wheelAction(() => api.keepLooking(item));
};

function answered(result, heard) {
  lastReply = result.answer; replayOnTap = false;
  showFound(result);
  showPanel('speaking', {heard, said: ''});
  const seconds = setSaid(result.answer);
  speakingUntil = performance.now() + seconds * 1000;
}

// ---------- what he says while he searches ----------
const FINDING = /\b(where|find|found|lost|left|leave|put|seen|misplaced?|missing)\b/i;
const FILLER_FIRST = [
  'Let me have a think about where it is, sir. One moment.',
  'Give me a second, sir. Going through the footage.',
  'Hmm, let me think where I last saw it, sir.',
  'One moment, sir. Checking where I saw it.',
];
const FILLER_LATER = [
  'Still looking, sir. Just checking the latest footage.',
  'Bear with me, sir. Nearly there.',
  'Taking a closer look at the last few frames, sir.',
];
const FILLER_SLOW = ['One moment, sir.', 'Bear with me, sir.'];
const pick = list => list[Math.floor(Math.random() * list.length)];

// ---------- listening: hands-free "Jarvis, …", or hold anywhere ----------
let pendingHeard = '';
const mic = createMic({
  onUtterance: (wav, info) => void convo.handle(wav, info),
  onLevel: v => { micLevel = v; },
  onState: s => { if (s === 'denied') toast('Microphone blocked: allow it in Settings › Safari › Microphone'); },
});
const convo = createConversation({
  listen: (wav, mode) => voiceApi.listen(wav, mode, !!camera.stream, {answer: false}),
  ask: question => voiceApi.askQuestion(question, {mine: true}),
  async askWithPhoto(question) { const still = await sharpStill(); if (still) await voiceApi.uploadStill(still).catch(() => {}); return voiceApi.askQuestion(question, {mine: true}); },
  filler: question => {   // he talks while he searches, so the wait never feels dead
    const finding = FINDING.test(question || '');
    return [
      ...(finding ? [{after: 400, text: pick(FILLER_FIRST)}] : []),
      {after: finding ? 6500 : 4500, text: pick(finding ? FILLER_LATER : FILLER_SLOW)},
    ];
  },
  onFiller: text => { showPanel('thinking', {said: text}); },
  onAccepted: () => { speaker.chime(); hideFound(); showPanel('thinking', {heard: withoutWake(pendingHeard), said: ''}); },
  mic, speak: speakHere,
  onHeard: text => { pendingHeard = text; if (panelOn) $('heard').textContent = withoutWake(text); },
  onState: s => {
    if (s === 'armed') showPanel('armed', {heard: 'Yes, sir?', said: ''});
    if (s === 'thinking' && panelOn) core.state = 'thinking';
    if (s === 'listening' && panelOn) hidePanel(Math.max(2600, speakingUntil - performance.now() + 2200));
    if (s === 'not-heard' || s === 'error') hidePanel(900);
  },
  onAnswer: result => answered(result, $('heard').textContent),
  onError: error => toast(error.message),
});

// Hold anywhere (a third of a second) to talk without the wake word. A short tap while he talks
// stops him; a short tap after the phone blocked his voice plays it.
let holdTimer = null, holding = false;
document.addEventListener('pointerdown', e => {
  speaker.unlock();
  if (!live || e.target.closest('button, #found')) return;   // swiping the photo wheel isn't a hold
  holdTimer = setTimeout(async () => {
    holding = true; document.body.classList.add('holding'); speaker.stop();
    mic.hold(true); if (mic.on) await mic.resume(); else try { await mic.start(); } catch {}
  }, 320);
});
function release(e) {
  clearTimeout(holdTimer);
  if (!holding) {   // a short tap
    if (e?.target?.closest?.('#found')) return;   // a swipe or tap on the photos doesn't cut him off
    if (replayOnTap && lastReply) { replayOnTap = false; void speaker.play(lastReply); }
    else if (performance.now() < speakingUntil) { speaker.stop(); speakingUntil = 0; }
    return;
  }
  holding = false; document.body.classList.remove('holding');
  const outcome = mic.hold(false);
  if (outcome === 'too-short') toast('Keep holding while you speak');
}
for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, release);
document.addEventListener('contextmenu', e => e.preventDefault());

// ---------- answers to questions asked on the laptop ----------
let exchangeId = null, firstPoll = true;
async function pollExchanges() {
  try {
    const ex = await api.getInteraction();
    const first = firstPoll; firstPoll = false;
    if (ex && ex.id !== exchangeId) {
      exchangeId = ex.id;
      if (!first && live && ex.source !== clientId) {   // our own questions are spoken by the conversation
        answered(ex.result, ex.question);
        await speakHere(ex.result.answer);
        hidePanel(Math.max(2600, speakingUntil - performance.now() + 2200));
      }
    }
  } catch { /* next poll */ }
  setTimeout(pollExchanges, 1000);
}
void pollExchanges();

// ---------- start / pause ----------
function videoReady() {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error('The camera did not start. Tap Begin to retry.')), 10000);
    video.addEventListener('loadeddata', () => { clearTimeout(t); resolve(); }, {once: true});
  });
}
$('begin').onclick = async () => {
  $('begin').disabled = true; $('startText').classList.remove('error'); $('startText').textContent = 'Waiting for permission…';
  speaker.unlock(); mic.prime();   // inside the tap: iPhone only unlocks audio here
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Error('Open this page from the QR code on the laptop (it needs the secure link).');
    await camera.start('');
    await videoReady();
    loop.start(); preview.start();
    navigator.wakeLock?.request?.('screen').then(lock => { wakeLock = lock; }).catch(() => {});
    mic.auto = true;   // then the mic, once the camera is settled (asking for both at once confuses iOS)
    try { await mic.start(); } catch { toast('No microphone: Jarvis can still see, but not hear you'); }
    live = true; document.body.dataset.phase = 'live';
  } catch (error) {
    camera.stop();
    $('startText').classList.add('error');
    $('startText').textContent = error.name === 'NotAllowedError'
      ? 'Camera access was denied. Allow it in Settings › Safari › Camera, then tap Begin.' : error.message;
  } finally { $('begin').disabled = false; }
};
function pause(reason) {
  live = false; convo.cancel(); speaker.stop(); mic.stop(); loop.stop(); preview.stop(); camera.stop();
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
  hidePanel(0); hideFound(); document.body.dataset.phase = 'start';
  $('startText').classList.remove('error'); $('startText').textContent = reason; $('begin').textContent = 'Resume';
}
document.addEventListener('visibilitychange', () => { if (document.hidden && live) pause('Paused while the screen was away. Tap Resume to continue.'); });
window.addEventListener('pagehide', () => { if (live) pause('Paused.'); });
