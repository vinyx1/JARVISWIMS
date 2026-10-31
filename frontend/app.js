// Laptop HUD, design A "Arc Reactor". Owner: Jogindar (A); redesign by Paul with Jogindar's OK.
// Live feed via GET /latest, questions via voice (or / to type). Jarvis answers out loud;
// text appears only as optional subtitles (T).
import { createApi } from './api.js';
import { createLatestPoller, formatSeenAt, safeFrameUrl } from './core.js';
import { createVoice } from './voice.js';

const $ = id => document.getElementById(id);
const api = createApi({ timeoutMs: 15000 });
const GREETING = 'Good evening, sir. Suit cameras online.';
const FILLERS = ['Checking the footage, sir.', 'One moment, sir. Reviewing the suit cameras.', 'Scanning your recent movements, sir.'];
const LOST_LINK = "I'm afraid I've lost the connection to the suit cameras, sir.";
const MAX_OBJECTS = 5, MAX_LANDMARKS = 3;
let asking = false, askToken = 0;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function setStatus(text, busy = false) { $('status').textContent = text; $('status').classList.toggle('busy', busy); }

// ---------- live feed ----------
function showLatest(entry) {
  const path = entry && safeFrameUrl(entry.url, location.origin);
  $('linkChip').textContent = 'LINK OK'; $('linkChip').classList.add('ok'); $('linkChip').classList.remove('bad');
  if (!path) {
    for (const id of ['live', 'liveBg']) $(id).hidden = true;
    $('idle').hidden = false; $('room').textContent = '—'; $('frameChip').textContent = '—'; $('age').textContent = '—';
    $('objects').replaceChildren(); if (!asking) setStatus('STANDBY'); return;
  }
  const src = `${path}?v=${entry.ts}`;
  for (const id of ['live', 'liveBg']) { if ($(id).getAttribute('src') !== src) $(id).src = src; $(id).hidden = false; }
  $('idle').hidden = true;
  $('frameChip').textContent = entry.id.toUpperCase();
  $('age').textContent = formatSeenAt(entry.ts).toUpperCase();
  const c = entry.caption;
  if (!c) { if (!asking) setStatus('ANALYZING…', true); return; }
  if (!asking) setStatus('SCANNING');
  $('room').textContent = (c.room_guess || 'unknown').toUpperCase();
  renderObjects(c);
}

function renderObjects(caption) {
  const item = (kind, label, text) => {
    const li = el('li', kind); li.append(el('span', 'k', label), el('span', 'v', text)); return li;
  };
  $('objects').replaceChildren(
    ...(caption.objects || []).slice(0, MAX_OBJECTS).map((o, i) => item('obj', `OBJ ${String(i + 1).padStart(2, '0')}`, o)),
    ...(caption.landmarks || []).slice(0, MAX_LANDMARKS).map(l => item('mark', 'LANDMARK', l)),
  );
}

const poller = createLatestPoller({
  load: () => api.getLatest(),
  onUpdate: showLatest,
  onError() { $('linkChip').textContent = 'LINK LOST'; $('linkChip').classList.add('bad'); $('linkChip').classList.remove('ok'); },
});

// ---------- answer: evidence + way back ----------
function showEvidence(result) {
  const frames = (result.frames || []).filter(f => safeFrameUrl(f.url, location.origin));
  if (!frames.length) { $('evidence').hidden = true; return; }
  // find: first frame is the best match. retrace: ordered now -> target, so the target is last.
  const target = result.kind === 'retrace' ? frames[frames.length - 1] : frames[0];
  $('heroImg').src = safeFrameUrl(target.url, location.origin);
  $('heroNote').textContent = target.note || '';
  $('heroAge').textContent = formatSeenAt(target.ts);
  const steps = result.kind === 'retrace' ? frames : frames.slice(1);
  $('trailTitle').hidden = !steps.length;
  $('trail').replaceChildren(...steps.map(f => el('li', null, f.note || f.id)));
  $('evidence').hidden = false;
  // replay the lock-in animation for every new answer
  $('evidence').style.animation = 'none'; void $('evidence').offsetWidth; $('evidence').style.animation = '';
}

function subtitle(question, answer) { $('subQ').textContent = question ? `“${question}”` : ''; $('subA').textContent = answer || ''; }

async function ask(question) {
  question = question.trim();
  if (!question || asking) return;
  asking = true; const token = ++askToken;
  voice.speak(FILLERS[Math.floor(Math.random() * FILLERS.length)], { interrupt: true });
  subtitle(question, '');
  document.body.classList.add('thinking'); setStatus('REVIEWING FOOTAGE', true);
  try {
    const result = await api.askQuestion(question);
    if (token !== askToken) return;
    voice.speak(result.answer);
    subtitle(question, result.answer);
    showEvidence(result);
  } catch (error) {
    if (token !== askToken) return;
    voice.speak(LOST_LINK); subtitle(question, LOST_LINK);
    console.error(error);
  } finally {
    if (token === askToken) { asking = false; document.body.classList.remove('thinking'); setStatus('SCANNING'); }
  }
}

// ---------- voice ----------
const MIC = { listening: 'MIC · SAY "JARVIS"', armed: 'LISTENING', ptt: 'PUSH-TO-TALK', denied: 'MIC BLOCKED', unsupported: 'NO MIC · PRESS /', off: 'MIC OFF' };
const voice = createVoice({
  onQuestion: ask,
  onState: s => {
    $('micChip').textContent = MIC[s] || s;
    $('micChip').classList.toggle('ok', s === 'listening');
    $('micChip').classList.toggle('hot', s === 'armed' || s === 'ptt');
    document.body.classList.toggle('listening', s === 'armed' || s === 'ptt');
    if ((s === 'armed' || s === 'ptt') && !asking) setStatus('LISTENING');
    else if (!asking) setStatus('SCANNING');
  },
  onHeard: (text, interim) => { if (interim) $('subQ').textContent = `… ${text}`; },
  onLevel: level => document.documentElement.style.setProperty('--level', level.toFixed(3)),
});

// Chrome needs a user gesture before audio and the mic: start on the first click or key.
let started = false;
function boot() {
  if (started) return;
  started = true; document.body.classList.remove('booting');
  voice.preload(['Sir?', ...FILLERS, LOST_LINK]);
  voice.start(); voice.speak(GREETING);
}
document.addEventListener('click', boot);

// ---------- keys ----------
const typing = () => document.activeElement === $('q');
function openAsk() { $('askForm').hidden = false; $('q').focus(); }
function closeAsk() { $('q').value = ''; $('q').blur(); $('askForm').hidden = true; }

document.addEventListener('keydown', async e => {
  if (typing()) { if (e.key === 'Escape') closeAsk(); return; }
  boot();
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) voice.pushToTalk(true); }
  else if (e.key === '/') { e.preventDefault(); openAsk(); }
  else if (e.key === 't' || e.key === 'T') { document.body.classList.toggle('subs-on'); toast(document.body.classList.contains('subs-on') ? 'SUBTITLES ON' : 'SUBTITLES OFF'); }
  else if (e.key === 'Escape') $('evidence').hidden = true;
  else if (e.key === 'r' || e.key === 'R') {
    try {
      await api.resetMemory();
      askToken++; asking = false; document.body.classList.remove('thinking');
      $('evidence').hidden = true; subtitle('', ''); showLatest(null);
      toast('MEMORY CLEARED');
    } catch (err) { toast('RESET FAILED'); console.error(err); }
  }
});
document.addEventListener('keyup', e => { if (!typing() && e.code === 'Space') voice.pushToTalk(false); });
$('askForm').onsubmit = e => { e.preventDefault(); const q = $('q').value; closeAsk(); ask(q); };

function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').hidden = true), 1400); }

poller.start();
if (!voice.supported) $('micChip').textContent = MIC.unsupported;
