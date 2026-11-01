// Laptop HUD. Owner: Jogindar (A); glass redesign by Paul. Live feed via GET /latest + /preview.jpg,
// Phone owns input and speech; this page displays completed exchanges and evidence.
import { createApi } from './api.js';
import { createLatestPoller, formatSeenAt, safeFrameUrl } from './core.js';

const $ = id => document.getElementById(id);
const api = createApi({ timeoutMs: 15000 });
let latest = null, resetting = false;
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
      previewTimer = setTimeout(() => pollPreview(token), previewLive() ? 45 : 1000);
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
  activeEvidence = null; $('evidence').hidden = true;
  $('candidates').replaceChildren(); $('candidates').hidden = true;
}
function showHero(target, result) {
  updateEvidenceTitle(target, result);
  $('heroImg').src = `${safeFrameUrl(target.url, location.origin)}?v=${encodeURIComponent(target.ts)}`;
  $('heroImg').alt = target.note || 'Where Jarvis last saw the selected object';
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
    const li = el('li'), image = el('img'); image.src = `${safeFrameUrl(frame.url, location.origin)}?v=${encodeURIComponent(frame.ts)}`; image.alt = frame.note || `step ${index + 1}`;
    li.append(image, el('span', null, `${index + 1}. ${frame.note || ''}`)); return li;
  }));
  $('evidence').hidden = false;
  if (result.kind === 'remember') void refreshMine();
}

// ---------- phone exchanges: display only, never open the HUD microphone ----------
let interactionId=null, firstExchange=true;
// Optional: the laptop speaks the reply (Mac speakers / projector) instead of the phone. Key V.
// The phone then picks "Jarvis speaks on: The laptop" so the reply isn't heard twice.
let laptopVoice=false, laptopAudio=null;
try{laptopVoice=localStorage.getItem('jarvisLaptopVoice')==='1';}catch{}
function showVoiceChip(){$('micChip').textContent=laptopVoice?'VOICE ON LAPTOP':'VOICE ON PHONE';$('micChip').classList.toggle('ok',laptopVoice);}
async function speakOnLaptop(text){
  laptopAudio?.pause();window.speechSynthesis?.cancel();
  try{
    const r=await fetch('/speak',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    if(r.ok&&r.headers.get('content-type')?.startsWith('audio/')){
      const url=URL.createObjectURL(await r.blob());laptopAudio=new Audio(url);laptopAudio.onended=()=>URL.revokeObjectURL(url);
      await laptopAudio.play();return;
    }
  }catch{/* fall back to the browser voice */}
  if(window.speechSynthesis&&window.SpeechSynthesisUtterance){const u=new SpeechSynthesisUtterance(text);u.lang='en-GB';window.speechSynthesis.speak(u);}
}
const interactions=createLatestPoller({
  load:()=>api.getInteraction(),
  onUpdate(exchange){
    if(!exchange){interactionId=null;hideEvidence();return;}
    if(exchange.id===interactionId)return;
    interactionId=exchange.id;
    if(laptopVoice&&!firstExchange)void speakOnLaptop(exchange.result.answer);   // never replay an old answer on page load
    firstExchange=false;
    say('you',exchange.question);say('jarvis',exchange.result.answer);
    showEvidence(exchange.result);
  },
  onError(){ /* Camera status remains independent; a later poll can recover. */ }
});
// the first poll may return an answer from before this page loaded: never speak that one
setTimeout(()=>{firstExchange=false;},2500);
showVoiceChip();
document.body.classList.remove('booting');
document.addEventListener('keydown',async e=>{
  if(e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement||e.target.isContentEditable||resetting)return;
  const plain=!e.repeat&&!e.metaKey&&!e.ctrlKey&&!e.altKey;
  if((e.key==='v'||e.key==='V')&&plain){laptopVoice=!laptopVoice;try{localStorage.setItem('jarvisLaptopVoice',laptopVoice?'1':'0');}catch{}showVoiceChip();toast(laptopVoice?'VOICE ON LAPTOP':'VOICE ON PHONE');}
  if((e.key==='t'||e.key==='T')&&plain){const on=document.body.classList.toggle('subs-on');toast(on?'SUBTITLES ON':'SUBTITLES OFF');}
  if((e.key==='r'||e.key==='R')&&plain)await reset();
  if(e.key==='Escape')$('evidence').hidden=true;
});

async function reset() {
  if (resetting) return;
  resetting = true; mineGeneration++; hideEvidence();
  document.body.classList.remove('thinking'); poller.stop(); stopPreview(); interactions.stop();
  $('evidence').hidden = true;
  document.querySelectorAll('.line.pending').forEach(line => { line.classList.remove('pending'); line.textContent = 'JARVIS Question cancelled by memory reset.'; });
  try {
    // The backend drops captions that finish after a reset, so no need to wait for analysis.
    await api.resetMemory();
    rememberedItems = []; renderMine();
    $('transcript').replaceChildren(); $('trail').replaceChildren(); $('heroImg').removeAttribute('src'); $('heard').textContent = ''; showLatest(null);
    toast('MEMORY CLEARED');
  } catch (error) { toast(error.status===409?'WAIT FOR PHONE QUESTION TO FINISH':'RESET FAILED'); console.error(error); }
  finally {
    resetting = false;
    poller.start(); startPreview(); interactions.start(); void refreshMine();
  }
}

window.addEventListener('pagehide', () => { poller.stop(); stopPreview(); interactions.stop(); mineGeneration++; });
window.addEventListener('pageshow', event => { if (event.persisted) { poller.start(); startPreview(); interactions.start(); void refreshMine(); } });

function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').hidden = true), 1600); }

poller.start(); startPreview(); interactions.start(); void refreshMine();
