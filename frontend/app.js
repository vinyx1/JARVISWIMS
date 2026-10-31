// Laptop HUD. Owner: Jogindar (A). Live feed via GET /latest, questions via voice or typing.
import { createApi } from './api.js';
import { createLatestPoller, formatSeenAt, safeFrameUrl } from './core.js';
import { createVoice } from './voice.js';

const $ = id => document.getElementById(id);
const api = createApi({ timeoutMs: 15000 });
const FILLERS = ['Checking the footage, sir.', 'One moment, sir. Reviewing the suit cameras.', 'Scanning your recent movements, sir.'];
let asking = false, askToken = 0, latest = null;

// ---------- live feed ----------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function showLatest(entry) {
  latest = entry;
  const path = entry && safeFrameUrl(entry.url, location.origin);
  $('frameChip').textContent = `FRAMES ${entry ? parseInt(entry.id.replace(/\D/g, ''), 10) + 1 : 0}`;
  $('linkChip').textContent = 'LINK OK'; $('linkChip').classList.add('ok'); $('linkChip').classList.remove('bad');
  if (!path) {
    if (!previewLive()) { $('live').hidden = true; $('idle').hidden = false; }
    $('room').textContent = 'ROOM —'; $('scene').textContent = ''; $('objects').replaceChildren();
    $('scanState').textContent = 'STANDBY'; return;
  }
  const src = `${path}?v=${entry.ts}`;
  if (!previewLive() && $('live').getAttribute('src') !== src) $('live').src = src;
  $('live').hidden = false; $('idle').hidden = true;
  $('age').textContent = formatSeenAt(entry.ts).toUpperCase();
  const c = entry.caption;
  if (!c) { $('scanState').textContent = 'ANALYZING…'; $('scanState').classList.add('busy'); return; }
  $('scanState').textContent = 'SCANNING'; $('scanState').classList.remove('busy');
  $('room').textContent = `ROOM ${(c.room_guess || 'unknown').toUpperCase()}`;
  $('scene').textContent = c.scene || '';
  $('objects').replaceChildren(
    ...(c.objects || []).slice(0, 6).map(o => el('span', 'tag obj', o)),
    ...(c.landmarks || []).slice(0, 4).map(l => el('span', 'tag mark', l)),
  );
}

// ---------- live preview (~5 fps from the phone, display only) ----------
let previewAt = 0, previewUrl = null;
const previewLive = () => Date.now() - previewAt < 1500;
async function pollPreview() {
  try {
    const r = await fetch('/preview.jpg', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (r.status === 200) {
      const url = URL.createObjectURL(await r.blob());
      $('live').src = url; $('live').hidden = false; $('idle').hidden = true;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = url; previewAt = Date.now();
    }
  } catch { /* fall back to /latest snapshots */ }
  $('liveChip').hidden = !previewLive();
  setTimeout(pollPreview, previewLive() ? 150 : 1000);
}
pollPreview();

const poller = createLatestPoller({
  load: () => api.getLatest(),
  onUpdate: showLatest,
  onError() { $('linkChip').textContent = 'LINK LOST'; $('linkChip').classList.add('bad'); $('linkChip').classList.remove('ok'); },
});

// ---------- transcript + evidence ----------
function say(who, text) {
  const line = el('p', `line ${who}`);
  line.append(el('b', null, who === 'you' ? 'YOU ' : 'JARVIS '), document.createTextNode(text));
  $('transcript').append(line);
  $('transcript').scrollTop = $('transcript').scrollHeight;
  return line;
}

function showEvidence(result) {
  const frames = (result.frames || []).filter(f => safeFrameUrl(f.url, location.origin));
  if (!frames.length) { $('evidence').hidden = true; return; }
  // find: first frame is the best match. retrace: ordered now -> target, so the target is last.
  const target = result.kind === 'retrace' ? frames[frames.length - 1] : frames[0];
  $('heroImg').src = safeFrameUrl(target.url, location.origin);
  $('heroCap').textContent = `${target.note || ''} · ${formatSeenAt(target.ts)}`;
  const steps = result.kind === 'retrace' ? frames : frames.slice(1);
  $('trailTitle').hidden = !steps.length;
  $('trail').replaceChildren(...steps.map((f, i) => {
    const li = el('li');
    const img = el('img'); img.src = safeFrameUrl(f.url, location.origin); img.alt = f.note || `step ${i + 1}`;
    li.append(img, el('span', null, `${i + 1}. ${f.note || ''}`));
    return li;
  }));
  $('evidence').hidden = false;
}

async function ask(question) {
  question = question.trim();
  if (!question || asking) return;
  asking = true; const token = ++askToken;
  say('you', question);
  voice.speak(FILLERS[Math.floor(Math.random() * FILLERS.length)], { interrupt: true });
  const pending = say('jarvis', 'Reviewing footage…'); pending.classList.add('pending');
  document.body.classList.add('thinking');
  try {
    const result = await api.askQuestion(question);
    if (token !== askToken) return;
    pending.remove();
    say('jarvis', result.answer);
    voice.speak(result.answer);
    showEvidence(result);
  } catch (error) {
    if (token !== askToken) return;
    pending.remove();
    const msg = "I'm afraid I've lost the connection to the suit cameras, sir.";
    say('jarvis', msg); voice.speak(msg);
    console.error(error);
  } finally {
    if (token === askToken) { asking = false; document.body.classList.remove('thinking'); }
  }
}

// ---------- voice ----------
const MIC = { listening: 'MIC LIVE · SAY "JARVIS"', armed: 'LISTENING…', ptt: 'PUSH-TO-TALK', denied: 'MIC BLOCKED', unsupported: 'NO VOICE · TYPE', off: 'MIC OFF' };
const voice = createVoice({
  onQuestion: ask,
  onState: s => { $('micChip').textContent = MIC[s] || s; $('micChip').classList.toggle('ok', s === 'listening' || s === 'armed' || s === 'ptt'); $('micChip').classList.toggle('hot', s === 'armed' || s === 'ptt'); },
  onHeard: (text, interim) => { $('heard').textContent = interim ? `… ${text}` : ''; },
});

// Chrome needs a user gesture before audio/mic: start on the first click or key press.
let started = false;
function boot() { if (started) return; started = true; voice.start(); voice.speak('Good evening, sir. Suit cameras online.'); }
document.addEventListener('click', boot);

// ---------- keys + typed fallback ----------
const typing = () => document.activeElement === $('q');
document.addEventListener('keydown', async e => {
  if (typing()) return;
  boot();
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) voice.pushToTalk(true); }
  if (e.key === 'r' || e.key === 'R') {
    try {
      await api.resetMemory();
      askToken++; asking = false; document.body.classList.remove('thinking');
      $('transcript').replaceChildren(); $('evidence').hidden = true; showLatest(null);
      toast('MEMORY CLEARED');
    } catch (err) { toast('RESET FAILED'); console.error(err); }
  }
  if (e.key === 'Escape') $('evidence').hidden = true;
});
document.addEventListener('keyup', e => { if (!typing() && e.code === 'Space') voice.pushToTalk(false); });
$('askForm').onsubmit = e => { e.preventDefault(); boot(); const q = $('q').value; $('q').value = ''; $('q').blur(); ask(q); };

function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').hidden = true), 1600); }

poller.start();
if (!voice.supported) $('micChip').textContent = MIC.unsupported;
