// Hologram HUD (the projector). Jarvis as an animated core on the left; what he hears and says
// (hold Space to talk through the laptop mic; hands-free listening lives on the phone)
// on the right. He reacts like Siri: "Jarvis" (phone or laptop) locks the rings amber, a question
// spins them up, his answer pulses them. D switches to the debug view (debug.html).
import {createApi, clientId} from './api.js';
import {formatSeenAt, safeFrameUrl} from './core.js';
import {createMic} from './mic.js';
import {createConversation} from './listen.js';
import {createDeviceSpeaker} from './speaker.js';
import {createReactor} from './reactor.js';

const $ = id => document.getElementById(id);
const api = createApi({timeoutMs: 20000});
const core = createReactor($('reactor'), {reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches});
const WORDS_PER_S = 2.6;     // roughly Jarvis's speaking pace: the reply is revealed at this speed
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- modes: idle → armed → thinking → speaking → idle ----------
const STATUS = {idle: 'STANDING BY', armed: 'YES, SIR?', listening: 'LISTENING', thinking: 'ANALYSING FOOTAGE', speaking: 'RESPONDING'};
let mode = 'idle', idleTimer = null;
function setMode(next) {
  mode = next; document.body.dataset.mode = next; core.state = next;
  $('statusText').textContent = STATUS[next] || next.toUpperCase();
  clearTimeout(idleTimer);
  if (next === 'armed') idleTimer = setTimeout(() => { if (mode === 'armed') setMode('idle'); }, 8000);
}

// ---------- the stage ----------
function showIdle() { $('idlePanel').hidden = false; $('talk').hidden = true; $('evidence').hidden = true; }
function showQuestion(question) {
  $('idlePanel').hidden = true; $('talk').hidden = false; $('evidence').hidden = true;
  $('query').textContent = `“${question}”`; $('reply').replaceChildren(); $('reply').classList.add('typing');
}
let revealTimer = null;
function revealReply(text) {
  clearInterval(revealTimer);
  const words = text.split(/\s+/).filter(Boolean);
  $('reply').classList.remove('typing');
  $('reply').replaceChildren(...words.map(w => { const s = el('span', 'w', w); return [s, document.createTextNode(' ')]; }).flat());
  const spans = [...$('reply').querySelectorAll('.w')];
  let i = 0;
  revealTimer = setInterval(() => { spans[i++]?.classList.add('on'); if (i >= spans.length) clearInterval(revealTimer); }, 1000 / WORDS_PER_S);
  return words.length / WORDS_PER_S;
}
function frameSrc(frame) { const p = safeFrameUrl(frame?.url, location.origin); return p ? `${p}?v=${encodeURIComponent(frame.ts)}` : null; }
function showEvidence(result) {
  const frames = (result.frames || []).filter(f => frameSrc(f));
  $('cands').replaceChildren(); $('route').replaceChildren();
  if (!frames.length) { $('evidence').hidden = true; return; }
  const target = result.kind === 'retrace' ? frames.at(-1) : frames[0];
  const pick = f => {
    $('evImg').src = frameSrc(f); $('evImg').alt = f.note || 'Where Jarvis last saw it';
    $('evCap').textContent = `${f.note || ''} · ${formatSeenAt(f.ts)}`;
  };
  pick(target);
  $('evTag').textContent = result.kind === 'remember' ? 'REGISTERED' : result.kind === 'retrace' ? 'TARGET' : frames.length > 1 && result.kind === 'find' ? 'POSSIBLE MATCH' : 'LAST SEEN';
  if (result.kind === 'find' && frames.length > 1) {
    $('cands').append(...frames.map((f, i) => {
      const b = el('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(i === 0));
      const img = el('img'); img.src = frameSrc(f); img.alt = f.note || `Match ${i + 1}`;
      b.append(img, document.createTextNode(`${i + 1} · ${f.note || ''}`));
      b.onclick = () => { pick(f); for (const c of $('cands').children) c.setAttribute('aria-pressed', String(c === b)); };
      return b;
    }));
  }
  if (result.kind === 'retrace') {
    $('route').append(...frames.map((f, i) => { const li = el('li'), img = el('img'); img.src = frameSrc(f); img.alt = f.note || ''; li.append(img, document.createTextNode(`${i + 1} · ${f.note || ''}`)); return li; }));
  }
  $('evidence').hidden = false;
}

// ---------- Jarvis's voice on the laptop (V; off by default) and a speaking pulse ----------
let laptopAudio = false;
try { laptopAudio = localStorage.getItem('jarvisLaptopAudio') === '1'; } catch {}
const speaker = createDeviceSpeaker();
let speakingUntil = 0;
async function speakOnLaptop(text) {
  if (!laptopAudio) return;
  mic.pause();
  try { await speaker.play(text); } finally { await mic.resume(); }
}
// The core breathes with whatever is loudest: the laptop mic while you talk, a speech-like
// envelope while Jarvis talks (on whichever device), or nothing.
let micLevel = 0;
const vuBars = [...document.querySelectorAll('.vu i')];
(function levels() {
  const t = performance.now() / 1000;
  const talking = performance.now() < speakingUntil;
  const syllables = talking ? 0.35 + 0.45 * Math.abs(Math.sin(t * 7.3)) * (0.6 + 0.4 * Math.sin(t * 2.1)) : 0;
  core.level = Math.max(syllables, mode === 'listening' ? micLevel : micLevel * 0.4);
  const v = mode === 'listening' ? micLevel : 0;
  vuBars.forEach((bar, i) => { bar.style.height = `${Math.round(18 + 82 * Math.min(1, v * (1.6 - i * 0.22)))}%`; });
  requestAnimationFrame(levels);
})();

function answer(exchange, {speak}) {
  if ($('talk').hidden || !$('query').textContent.includes(exchange.question)) showQuestion(exchange.question);
  const seconds = revealReply(exchange.result.answer);
  showEvidence(exchange.result);
  setMode('speaking');
  speakingUntil = performance.now() + seconds * 1000;
  if (speak) void speakOnLaptop(exchange.result.answer);
  setTimeout(() => { if (mode === 'speaking' && performance.now() >= speakingUntil - 50) setMode('idle'); }, seconds * 1000 + 300);
}

// ---------- the laptop's own mic: hold Space to talk ----------
const TALK = {off: 'Hold space to talk', listening: 'Hold space to talk', recording: 'Listening \u2014 let go to send',
              denied: 'Microphone blocked \u2014 allow it in Chrome', error: 'Microphone error'};
const mic = createMic({
  onUtterance: (wav, info) => void convo.handle(wav, info),
  onLevel: v => { micLevel = v; },
  onState: s => {
    if (TALK[s]) $('talkText').textContent = TALK[s];
    if (s === 'recording') setMode('listening');
  },
});
const convo = createConversation({
  listen: (wav, mode) => api.listen(wav, mode, false, {answer: false}), mic, speak: speakOnLaptop,
  ask: question => api.askQuestion(question, {mine: true}),
  onAccepted: () => { if (laptopAudio) speaker.chime(); },
  onState: s => { if (s === 'thinking') setMode('thinking'); else if (s === 'armed') setMode('armed'); else if (s === 'not-heard' || s === 'error') setMode('idle'); },
  onHeard: text => { if (mode !== 'speaking') showQuestion(text); },
  onAnswer: () => {},
  onError: () => toast('VOICE FAILED'),
});
async function talk(down) {
  if (down) {
    speaker.unlock();
    if (convo.busy) { speaker.stop(); return; }
    mic.hold(true);
    if (!mic.on) { try { await mic.start(); } catch { mic.hold(false); toast('ALLOW THE MICROPHONE IN CHROME'); setMode('idle'); } }
    else await mic.resume();
  } else if (mode === 'listening' || mic.on) {
    const outcome = mic.hold(false);
    if (mode === 'listening') setMode(outcome === 'sent' ? 'thinking' : 'idle');
    if (outcome === 'too-short') toast('KEEP HOLDING SPACE WHILE YOU SPEAK');
  }
}

// ---------- what the phone (or anyone) is doing: GET /activity, fast ----------
let activityId = null;
async function pollActivity() {
  try {
    const a = await (await fetch('/activity', {cache: 'no-store'})).json();
    if (a.id !== activityId) {
      const first = activityId === null; activityId = a.id;
      if (!first && mode !== 'listening') {
        if (a.state === 'armed') setMode('armed');
        if (a.state === 'thinking') {
          if (mode !== 'thinking' && laptopAudio) speaker.chime();   // a question from the phone: acknowledge here too
          showQuestion(a.question || ''); setMode('thinking');
        }
        if (a.state === 'answered') void exchanges.refresh?.();
      }
    }
  } catch { /* backend restarting */ }
  setTimeout(pollActivity, 300);
}

// ---------- completed exchanges: GET /interaction ----------
let exchangeId = null, firstExchange = true;
async function checkExchange() {
  try {
    const ex = await api.getInteraction();
    const first = firstExchange; firstExchange = false;   // the first poll only learns what already existed
    if (!ex) { exchangeId = null; return; }
    if (ex.id === exchangeId) return;
    exchangeId = ex.id;
    if (first) return;   // never replay an answer from before this page loaded
    const already = ex.source === clientId;   // the laptop's own mic question: its conversation speaks it
    answer(ex, {speak: !already});
  } catch { /* next poll */ }
}
const exchanges = {refresh: checkExchange};
setInterval(checkExchange, 1000);

// ---------- readouts: clock, optics, memory, items, phone link ----------
function clock() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  $('roClock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('roSec').textContent = pad(d.getSeconds());
  $('roDate').textContent = d.toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'});
}
setInterval(clock, 1000); clock();
function greetingFor(d = new Date()) { const h = d.getHours(); return h < 5 ? 'Up late again, sir.' : h < 12 ? 'Good morning, sir.' : h < 18 ? 'Good afternoon, sir.' : 'Good evening, sir.'; }
$('greeting').textContent = greetingFor();
let opticsLive = false, phoneUrl = null;
async function readouts() {
  try {
    const [latest, health] = await Promise.all([api.getLatest(), (await fetch('/health', {cache: 'no-store'})).json()]);
    opticsLive = !!latest && Date.now() - latest.ts < 20000;
    $('roOptics').textContent = opticsLive ? 'live' : 'offline'; $('roOptics').className = `v ${opticsLive ? 'on' : ''}`;
    $('roMem').textContent = String(health.frames).padStart(3, '0');
    $('roItems').textContent = String(health.items ?? 0);
    if (!health.ai_ok) { $('roOptics').textContent = 'ai fault'; $('roOptics').className = 'v warn'; }
  } catch { $('roOptics').textContent = 'no link'; $('roOptics').className = 'v warn'; }
  try {
    const {url} = await (await fetch('/phone', {cache: 'no-store'})).json();
    if (url !== phoneUrl) { phoneUrl = url; document.querySelectorAll('[data-qr]').forEach(img => { if (url) img.src = `/qr.svg?u=${encodeURIComponent(url)}`; }); }
  } catch {}
  $('link').hidden = opticsLive || !phoneUrl;
}
setInterval(readouts, 2500);
function showAudio() {
  $('roAudio').textContent = laptopAudio ? 'on' : 'off'; $('roAudio').className = `v ${laptopAudio ? 'on' : ''}`;
  $('audioBtn').setAttribute('aria-pressed', String(laptopAudio));
}
function toggleAudio() {
  laptopAudio = !laptopAudio;
  try { localStorage.setItem('jarvisLaptopAudio', laptopAudio ? '1' : '0'); } catch {}
  if (laptopAudio) speaker.unlock(); else speaker.stop();
  showAudio(); toast(laptopAudio ? 'LAPTOP AUDIO ON' : 'LAPTOP AUDIO OFF');
}
$('audioBtn').onclick = e => { toggleAudio(); e.currentTarget.blur(); };   // blur: Space must stay "talk"
showAudio();

function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').hidden = true), 1700); }

// ---------- intro: plays, then waits on Engage (a key or click fast-forwards to it) ----------
let booted = false, introReady = false, fast = false;
const wait = ms => fast ? Promise.resolve() : sleep(ms);
async function intro() {
  $('title').replaceChildren(...'J.A.R.V.I.S.'.split('').map((ch, i) => { const s = el('span', null, ch); s.style.animationDelay = `${0.5 + i * 0.07}s`; return s; }));
  const t0 = performance.now(), BOOT_MS = 2600;
  (function grow() { const k = (performance.now() - t0) / BOOT_MS; core.boot = booted || fast ? 1 : k; if (k < 1 && !booted && !fast) requestAnimationFrame(grow); })();
  core.state = 'thinking'; core.readouts = false;
  const [health, latest, mine] = await Promise.all([
    fetch('/health', {cache: 'no-store'}).then(r => r.json()).catch(() => null),
    api.getLatest().catch(() => null), api.getMine().catch(() => []),
  ]);
  const live = latest && Date.now() - latest.ts < 20000;
  const checks = [
    ['OPTICAL FEED', live ? 'ONLINE' : 'AWAITING', live],
    ['SPEECH RECOGNITION', health?.speech_ready ? 'READY' : 'WARMING', !!health?.speech_ready],
    ['LANGUAGE CORE', health ? (health.ai_ok ? 'ONLINE' : 'FAULT') : 'NO LINK', !!health?.ai_ok],
    ['VISUAL MEMORY', `${health?.frames ?? 0} FRAMES`, true],
    ['REGISTERED ITEMS', `${mine.length}`, true],
  ];
  await wait(1300);
  for (const [name, value, ok] of checks) {
    if (booted) return;
    const li = el('li'); li.append(el('span', null, name), el('span', 'leader'), el('span', ok ? 'ok' : 'warn', value));
    if (fast) li.style.animationDuration = '0s';
    $('checks').append(li); await wait(260);
  }
  if (booted) return;
  await wait(300);
  $('introGreet').textContent = `${greetingFor()} All systems ${checks.every(c => c[2]) ? 'nominal' : 'standing by'}.`;
  $('introGreet').classList.add('on');
  await wait(600);
  introReady = true;
  $('skip').hidden = true; $('engage').hidden = false; $('engage').focus();
}
$('engage').onclick = () => finishIntro();
function finishIntro() {
  if (booted) return;
  booted = true; core.boot = 1; core.readouts = true; core.interactive = true; $('engage').hidden = true;
  document.body.dataset.phase = 'ready'; setMode('idle'); showIdle(); void readouts();
}

// ---------- keys ----------
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => speaker.unlock(), {capture: true});
const typing = e => e.target instanceof HTMLInputElement;
document.addEventListener('keyup', e => { if (e.code === 'Space' && !typing(e) && booted) { e.preventDefault(); void talk(false); } });
window.addEventListener('blur', () => { if (mode === 'listening') void talk(false); });
document.addEventListener('keydown', async e => {
  if (!booted) {   // intro: Enter/Space on Engage continues; any other key fast-forwards to it
    if (introReady && (e.key === 'Enter' || e.code === 'Space')) { e.preventDefault(); finishIntro(); } else fast = true;
    return;
  }
  if (typing(e)) { if (e.key === 'Escape') { $('cmd').hidden = true; $('cmdInput').blur(); } return; }
  const plain = !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey;
  if (e.code === 'Space') { e.preventDefault(); if (plain) await talk(true); return; }
  if (!plain) return;
  const k = e.key.toLowerCase();
  if (k === 'enter') { e.preventDefault(); $('cmd').hidden = false; $('cmdInput').focus(); }
  if (k === 'v') toggleAudio();
  if (k === 'q') $('qrOverlay').hidden = !$('qrOverlay').hidden;
  if (k === 'escape') $('qrOverlay').hidden = true;
  if (k === 'd') location.href = '/debug.html';
  if (k === 'r') {
    convo.cancel(); speaker.stop();
    try { await api.resetMemory(); showIdle(); setMode('idle'); toast('MEMORY CLEARED'); void readouts(); }
    catch (err) { toast(err.status === 409 ? 'WAIT FOR THE QUESTION TO FINISH' : 'RESET FAILED'); }
  }
});
document.addEventListener('pointerdown', e => { if (!booted && !introReady && e.target !== $('engage')) fast = true; });
$('cmd').onsubmit = async e => {
  e.preventDefault();
  const q = $('cmdInput').value.trim(); if (!q) return;
  $('cmdInput').value = ''; $('cmd').hidden = true; $('cmdInput').blur();
  showQuestion(q); setMode('thinking'); if (laptopAudio) speaker.chime();
  try { await api.askQuestion(q); void checkExchange(); } catch (err) { setMode('idle'); toast('NO ANSWER'); }
};
window.addEventListener('pagehide', () => { convo.cancel(); mic.stop(); speaker.stop(); });

void checkExchange();   // learn the current exchange id so it isn't replayed
void pollActivity();
void intro();
