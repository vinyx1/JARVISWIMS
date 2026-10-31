// Laptop HUD. Owner: Jogindar (A); glass redesign by Paul. Live feed via GET /latest + /preview.jpg,
// questions via voice (or / to type). Jarvis answers out loud; text shows only as subtitles (T).
import { createApi } from './api.js';
import { createLatestPoller, formatSeenAt, safeFrameUrl } from './core.js';
import { createVoice } from './voice.js';
import { createObjectOverlay } from './overlay.js';

const $ = id => document.getElementById(id);
const api = createApi({ timeoutMs: 15000 });
const objectOverlay = createObjectOverlay($('heroImg'), $('objectOutline'));
const FILLERS = ['Checking the footage, sir.', 'One moment, sir. Reviewing the suit cameras.', 'Scanning your recent movements, sir.'];
let asking = false, askToken = 0, latest = null, resetting = false;
let rememberedItems = [], mineGeneration = 0, activeEvidence = null;

// ---------- live feed ----------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function showLatest(entry, { linked = true } = {}) {
  latest = entry;
  const path = entry && safeFrameUrl(entry.url, location.origin);
  $('frameChip').textContent = `FRAMES ${entry ? parseInt(entry.id.replace(/\D/g, ''), 10) + 1 : 0}`;
  if (linked) { $('linkChip').textContent = 'LINK OK'; $('linkChip').classList.add('ok'); $('linkChip').classList.remove('bad'); }
  if (!path) {
    if (!previewLive()) { $('live').hidden = true; $('liveBg').hidden = true; $('idle').hidden = false; }
    $('room').textContent = 'ROOM —'; $('scene').textContent = ''; $('objects').replaceChildren();
    $('scanState').textContent = 'STANDBY'; $('scanState').classList.remove('busy'); $('age').textContent = '—'; return;
  }
  const src = `${path}?v=${entry.ts}`;
  if (!previewLive() && $('live').getAttribute('src') !== src) setLive(src);
  $('live').hidden = false; $('liveBg').hidden = false; $('idle').hidden = true;
  $('age').textContent = formatSeenAt(entry.ts).toUpperCase();
  const c = entry.caption;
  if (!c) { $('room').textContent = 'ROOM —'; $('scene').textContent = ''; $('objects').replaceChildren(); $('scanState').textContent = 'ANALYZING…'; $('scanState').classList.add('busy'); return; }
  $('scanState').textContent = 'SCANNING'; $('scanState').classList.remove('busy');
  $('room').textContent = `ROOM ${(c.room_guess || 'unknown').toUpperCase()}`;
  $('scene').textContent = c.scene || '';
  // gold squares = movable objects (things you can lose), cyan outlines = landmarks
  $('objects').replaceChildren(
    ...(c.objects || []).slice(0, 5).map(o => el('li', 'obj', o)),
    ...(c.landmarks || []).slice(0, 3).map(l => el('li', 'mark', l)),
  );
}

// the frame on top plus its blurred copy that fills the rest of the screen
function setLive(src) { $('live').src = src; $('liveBg').src = src; }

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
        setLive(url); $('live').hidden = false; $('liveBg').hidden = false; $('idle').hidden = true;
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
      previewTimer = setTimeout(() => pollPreview(token), previewLive() ? 70 : 1000);
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

function renderMine() {
  $('myItems').replaceChildren(...rememberedItems.map(item => {
    const row = el('li'); row.append(el('strong', null, item.item), el('span', null, item.description)); return row;
  }));
  if (!rememberedItems.length) $('myItems').append(el('li', 'empty-item', 'No items registered yet.'));
}
async function refreshMine() {
  const token = ++mineGeneration;
  try {
    const items = await api.getMine(); if (token !== mineGeneration) return;
    rememberedItems = items; renderMine(); $('mineStatus').hidden = true;
    if (activeEvidence?.kind === 'remember') updateEvidenceTitle(activeEvidence.frames[0], activeEvidence);
  } catch {
    if (token !== mineGeneration) return;
    $('mineStatus').textContent = 'Registered items unavailable.'; $('mineStatus').hidden = false;
  }
}
function updateEvidenceTitle(frame, result) {
  const matches = rememberedItems.filter(item => item.frame_id === frame.id);
  const item = matches.findLast(item => item.description === frame.note) || matches.at(-1);
  $('evidenceTitle').textContent = result.kind === 'remember' ? `REGISTERED · MY ${(item?.item || 'ITEM').toUpperCase()}` : result.kind === 'find' && result.frames.length > 1 ? 'POSSIBLE MATCHES · SELECT AN ITEM' : 'LAST SEEN';
  $('evidenceTitle').classList.toggle('registered', result.kind === 'remember');
}
function hideEvidence() {
  objectOverlay.clear(); activeEvidence = null; $('evidence').hidden = true;
  $('candidates').replaceChildren(); $('candidates').hidden = true;
}
function showHero(target, result) {
  objectOverlay.clear(); updateEvidenceTitle(target, result);
  $('heroImg').src = `${safeFrameUrl(target.url, location.origin)}?v=${encodeURIComponent(target.ts)}`;
  $('heroImg').alt = target.note || 'Where Jarvis last saw the selected object';
  objectOverlay.set(target.box);
  $('heroCap').textContent = `${target.note || ''} · ${formatSeenAt(target.ts)}`;
}
function showEvidence(result) {
  hideEvidence();
  const frames = (result.frames || []).filter(frame => frame && safeFrameUrl(frame.url, location.origin));
  if (!frames.length) return;
  activeEvidence = {...result, frames}; const evidence = activeEvidence;
  const target = result.kind === 'retrace' ? frames[frames.length - 1] : frames[0];
  showHero(target, evidence);
  const options = $('candidates');
  if (result.kind === 'find' && frames.length > 1) {
    options.hidden = false;
    frames.forEach((frame, index) => {
      const button = el('button', 'candidate-option'); button.type = 'button'; button.setAttribute('aria-pressed', String(index === 0));
      const image = el('img'); image.src = `${safeFrameUrl(frame.url, location.origin)}?v=${encodeURIComponent(frame.ts)}`; image.alt = frame.note || `Match ${index + 1}`;
      button.append(image, el('span', null, `${index + 1}. ${frame.note || 'Possible match'}`));
      button.onclick = () => {
        if (activeEvidence !== evidence) return;
        showHero(frame, evidence);
        for (const candidate of options.children) candidate.setAttribute('aria-pressed', String(candidate === button));
      };
      options.append(button);
    });
  }
  const steps = result.kind === 'retrace' ? frames : [];
  $('trailTitle').hidden = !steps.length;
  $('trail').replaceChildren(...steps.map((frame, index) => {
    const li = el('li'), image = el('img'); image.src = safeFrameUrl(frame.url, location.origin); image.alt = frame.note || `step ${index + 1}`;
    li.append(image, el('span', null, `${index + 1}. ${frame.note || ''}`)); return li;
  }));
  $('evidence').hidden = false;
  if (result.kind === 'remember') void refreshMine();
}

async function ask(question) {
  question = question.trim();
  if (!question || asking || resetting) return;
  asking = true; const token = ++askToken; hideEvidence();
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
  onState: s => {
    $('micChip').textContent = MIC[s] || s;
    $('micChip').classList.toggle('ok', s === 'listening' || s === 'armed' || s === 'ptt');
    $('micChip').classList.toggle('hot', s === 'armed' || s === 'ptt');
    document.body.classList.toggle('listening', s === 'armed' || s === 'ptt');
  },
  onHeard: (text, interim) => { $('heard').textContent = interim ? `… ${text}` : ''; },
  onLevel: level => document.documentElement.style.setProperty('--level', level.toFixed(3)),
});

// Chrome needs a user gesture before audio/mic: start on the first click or key press.
let started = false;
const GREETING = 'Good evening, sir. Ready when you are.';
function boot() {
  if (started || resetting) return;
  started = true; document.body.classList.remove('booting');
  voice.preload(['Sir?', ...FILLERS, "I'm afraid I've lost the connection to the suit cameras, sir."]);
  voice.start(); voice.speak(GREETING);
}
document.addEventListener('click', boot);

// ---------- keys + typed fallback ----------
// Space hold-to-talk · / type a question · T subtitles · R reset · Esc close
const typing = () => document.activeElement === $('q');
function openAsk() { $('askForm').hidden = false; $('q').focus(); }
function closeAsk() { $('q').blur(); $('askForm').hidden = true; }
document.addEventListener('keydown', async e => {
  if (typing()) { if (e.key === 'Escape') closeAsk(); return; }
  if (resetting) return;
  boot();
  const plain = !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) voice.pushToTalk(true); }
  if (e.key === '/' && plain) { e.preventDefault(); openAsk(); }
  if ((e.key === 't' || e.key === 'T') && plain) {
    const on = document.body.classList.toggle('subs-on');
    toast(on ? 'SUBTITLES ON' : 'SUBTITLES OFF');
  }
  if ((e.key === 'r' || e.key === 'R') && plain) await reset();
  if (e.key === 'Escape') { $('evidence').hidden = true; closeAsk(); }
});
document.addEventListener('keyup', e => { if (!typing() && e.code === 'Space') voice.pushToTalk(false); });
$('askForm').onsubmit = e => { e.preventDefault(); if (asking || resetting) return; boot(); const q = $('q').value.trim(); if (!q) return; $('q').value = ''; closeAsk(); ask(q); };

async function reset() {
  if (resetting) return;
  if (asking) { toast('WAIT FOR ANSWER BEFORE RESET'); return; }
  resetting = true; askToken++; asking = false; mineGeneration++; hideEvidence();
  document.body.classList.remove('thinking'); poller.stop(); stopPreview(); voice.stop();
  $('q').disabled = true; $('askForm').querySelector('button').disabled = true;
  $('evidence').hidden = true;
  document.querySelectorAll('.line.pending').forEach(line => { line.classList.remove('pending'); line.textContent = 'JARVIS Question cancelled by memory reset.'; });
  try {
    const log = await api.getLog();
    if (log.some(entry => entry.caption === null)) { toast('STOP CAPTURE · WAIT FOR ANALYSIS'); return; }
    await api.resetMemory();
    rememberedItems = []; renderMine();
    $('transcript').replaceChildren(); $('trail').replaceChildren(); $('heroImg').removeAttribute('src'); $('heard').textContent = ''; showLatest(null);
    toast('MEMORY CLEARED');
  } catch (error) { toast('RESET FAILED'); console.error(error); }
  finally {
    resetting = false; $('q').disabled = false; $('askForm').querySelector('button').disabled = false;
    poller.start(); startPreview(); void refreshMine(); if (started && !document.hidden) voice.start();
  }
}

window.addEventListener('pagehide', () => { poller.stop(); stopPreview(); voice.stop(); mineGeneration++; });
window.addEventListener('pageshow', event => { if (event.persisted) { poller.start(); startPreview(); void refreshMine(); started = false; } });
window.addEventListener('blur', () => voice.pushToTalk(false));

function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').hidden = true), 1600); }

poller.start(); startPreview(); void refreshMine();
if (!voice.supported) $('micChip').textContent = MIC.unsupported;
