// Laptop HUD. Owner: Jogindar (A). Live feed via GET /latest, questions via voice or typing.
import { createApi } from './api.js';
import { createLatestPoller, formatSeenAt, safeFrameUrl } from './core.js';
import { createVoice } from './voice.js';

const $ = id => document.getElementById(id);
const api = createApi({ timeoutMs: 15000 });
const FILLERS = ['Checking the footage, sir.', 'One moment, sir. Reviewing the suit cameras.', 'Scanning your recent movements, sir.'];
let asking = false, askToken = 0, latest = null, resetting = false;

// ---------- live feed ----------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function showLatest(entry, { linked = true } = {}) {
  latest = entry;
  const path = entry && safeFrameUrl(entry.url, location.origin);
  $('frameChip').textContent = `FRAMES ${entry ? parseInt(entry.id.replace(/\D/g, ''), 10) + 1 : 0}`;
  if (linked) { $('linkChip').textContent = 'LINK OK'; $('linkChip').classList.add('ok'); $('linkChip').classList.remove('bad'); }
  if (!path) {
    if (!previewLive()) { $('live').hidden = true; $('idle').hidden = false; }
    $('room').textContent = 'ROOM —'; $('scene').textContent = ''; $('objects').replaceChildren();
    $('scanState').textContent = 'STANDBY'; $('scanState').classList.remove('busy'); $('age').textContent = '—'; return;
  }
  const src = `${path}?v=${entry.ts}`;
  if (!previewLive() && $('live').getAttribute('src') !== src) $('live').src = src;
  $('live').hidden = false; $('idle').hidden = true;
  $('age').textContent = formatSeenAt(entry.ts).toUpperCase();
  const c = entry.caption;
  if (!c) { $('room').textContent = 'ROOM —'; $('scene').textContent = ''; $('objects').replaceChildren(); $('scanState').textContent = 'ANALYZING…'; $('scanState').classList.add('busy'); return; }
  $('scanState').textContent = 'SCANNING'; $('scanState').classList.remove('busy');
  $('room').textContent = `ROOM ${(c.room_guess || 'unknown').toUpperCase()}`;
  $('scene').textContent = c.scene || '';
  $('objects').replaceChildren(
    ...(c.objects || []).slice(0, 6).map(o => el('span', 'tag obj', o)),
    ...(c.landmarks || []).slice(0, 4).map(l => el('span', 'tag mark', l)),
  );
}

// ---------- live preview (~5 fps from the phone, display only) ----------
let previewAt = 0, previewUrl = null, previewTimer = null, previewController = null;
let previewWanted = false, previewGeneration = 0;
const previewLive = () => Date.now() - previewAt < 1500;
function stopPreview() {
  previewWanted = false; previewGeneration++; clearTimeout(previewTimer); previewController?.abort();
  previewController = null; previewAt = 0;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null; $('liveChip').hidden = true;
}
function startPreview() {
  if (previewWanted) return;
  previewWanted = true; void pollPreview(++previewGeneration);
}
async function pollPreview(token) {
  if (!previewWanted || token !== previewGeneration) return;
  const controller = new AbortController(); previewController = controller;
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch('/preview.jpg', { cache: 'no-store', signal: controller.signal });
    if (response.status === 200) {
      const blob = await response.blob();
      if (!previewWanted || token !== previewGeneration) return;
      if (blob.type.startsWith('image/')) {
        const url = URL.createObjectURL(blob);
        $('live').src = url; $('live').hidden = false; $('idle').hidden = true;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = url; previewAt = Date.now();
      }
    }
  } catch { /* fall back to the last saved snapshot */ }
  finally {
    clearTimeout(timeout);
    if (previewWanted && token === previewGeneration) {
      previewController = null; $('liveChip').hidden = !previewLive();
      if (!previewLive()) showLatest(latest, { linked: false });
      previewTimer = setTimeout(() => pollPreview(token), previewLive() ? 150 : 1000);
    }
  }
}

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
  if (!question || asking || resetting) return;
  asking = true; const token = ++askToken; $('evidence').hidden = true;
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
function boot() { if (started || resetting) return; started = true; voice.start(); voice.speak('Good evening, sir. Ready when you are.'); }
document.addEventListener('click', boot);

// ---------- keys + typed fallback ----------
const typing = () => document.activeElement === $('q');
document.addEventListener('keydown', async e => {
  if (typing() || resetting) return;
  boot();
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) voice.pushToTalk(true); }
  if ((e.key === 'r' || e.key === 'R') && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) await reset();
  if (e.key === 'Escape') $('evidence').hidden = true;
});
document.addEventListener('keyup', e => { if (!typing() && e.code === 'Space') voice.pushToTalk(false); });
$('askForm').onsubmit = e => { e.preventDefault(); if (asking || resetting) return; boot(); const q = $('q').value.trim(); if (!q) return; $('q').value = ''; $('q').blur(); ask(q); };

async function reset() {
  if (resetting) return;
  resetting = true; askToken++; asking = false;
  document.body.classList.remove('thinking'); poller.stop(); stopPreview(); voice.stop();
  $('q').disabled = true; $('askForm').querySelector('button').disabled = true;
  $('evidence').hidden = true;
  document.querySelectorAll('.line.pending').forEach(line => { line.classList.remove('pending'); line.textContent = 'JARVIS Question cancelled by memory reset.'; });
  try {
    const log = await api.getLog();
    if (log.some(entry => entry.caption === null)) { toast('STOP CAPTURE · WAIT FOR ANALYSIS'); return; }
    await api.resetMemory();
    $('transcript').replaceChildren(); $('trail').replaceChildren(); $('heroImg').removeAttribute('src'); $('heard').textContent = ''; showLatest(null);
    toast('MEMORY CLEARED');
  } catch (error) { toast('RESET FAILED'); console.error(error); }
  finally {
    resetting = false; $('q').disabled = false; $('askForm').querySelector('button').disabled = false;
    poller.start(); startPreview(); if (started && !document.hidden) voice.start();
  }
}

window.addEventListener('pagehide', () => { poller.stop(); stopPreview(); voice.stop(); });
window.addEventListener('pageshow', event => { if (event.persisted) { poller.start(); startPreview(); started = false; } });
window.addEventListener('blur', () => voice.pushToTalk(false));

function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').hidden = true), 1600); }

poller.start(); startPreview();
if (!voice.supported) $('micChip').textContent = MIC.unsupported;
