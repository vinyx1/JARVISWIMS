// Laptop HUD: live feed (GET /latest + /preview.jpg) and the COMMS side panel.
// The phone asks by voice; the chat box here asks by typing. Every completed exchange,
// from either, arrives through GET /interaction and is shown in the chat.
import { createApi } from './api.js';
import { createLatestPoller, formatSeenAt, safeFrameUrl } from './core.js';
import { createMic } from './mic.js';
import { createConversation } from './listen.js';
import { createDeviceSpeaker } from './speaker.js';

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
    if (!previewLive()) { $('live').hidden = true; $('idle').hidden = false; }
    $('room').textContent = 'ROOM —'; $('scene').textContent = ''; $('objects').replaceChildren();
    $('scanState').textContent = 'STANDBY'; $('scanState').classList.remove('busy'); $('age').textContent = '—'; return;
  }
  const src = `${path}?v=${entry.ts}`;
  if (!previewLive() && $('live').getAttribute('src') !== src) setLive(src);
  $('live').hidden = false; $('idle').hidden = true;
  $('age').textContent = formatSeenAt(entry.ts).toUpperCase();
  const c = entry.caption;
  if (!c) { $('room').textContent = 'ROOM —'; $('scene').textContent = ''; $('objects').replaceChildren(); $('scanState').textContent = 'ANALYZING…'; $('scanState').classList.add('busy'); return; }
  $('scanState').textContent = 'SCANNING'; $('scanState').classList.remove('busy');
  $('room').textContent = `ROOM ${(c.room_guess || 'unknown').toUpperCase()}`;
  $('scene').textContent = c.scene || '';
  // gold = movable objects (things you can lose), cyan = landmarks
  $('objects').replaceChildren(
    ...(c.objects || []).slice(0, 6).map(o => el('span', 'tag obj', o)),
    ...(c.landmarks || []).slice(0, 4).map(l => el('span', 'tag mark', l)),
  );
}

function setLive(src) { $('live').src = src; }

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
        setLive(url); $('live').hidden = false; $('idle').hidden = true;
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

// ---------- Jarvis's voice on the laptop: V switches it on/off (off by default) ----------
// Every device with its audio on speaks every answer, whoever asked (the phone has its own switch).
let interactionId=null, firstExchange=true, laptopVoice=false;
try{laptopVoice=localStorage.getItem('jarvisLaptopAudio')==='1';}catch{}
function showVoiceChip(){$('micChip').textContent=laptopVoice?'🔊 LAPTOP AUDIO ON':'LAPTOP AUDIO OFF';$('micChip').classList.toggle('ok',laptopVoice);}
const speaker=createDeviceSpeaker();
async function speakOnLaptop(text){
  if(!laptopVoice)return;
  mic.pause();   // don't let the laptop mic hear Jarvis
  try{await speaker.play(text);}finally{await mic.resume();}
}

// ---------- laptop microphone: hold Space to talk, M for hands-free "Jarvis, …" ----------
const spokenHere=new Set();   // laptop-mic questions: their answer is spoken by the conversation itself
const earText={off:'MIC · HOLD SPACE',listening:()=>mic.auto?'MIC · SAY "JARVIS…"':'MIC · HOLD SPACE',recording:'● RECORDING',
  thinking:'MIC · THINKING',armed:'MIC · YES, SIR?',speaking:'MIC · SPEAKING','not-heard':'MIC · DIDN\'T CATCH THAT',denied:'MIC BLOCKED',error:'MIC ERROR'};
function showEar(state){const t=earText[state];if(!t)return;$('earChip').textContent=typeof t==='function'?t():t;
  $('earChip').classList.toggle('hot',state==='recording'||state==='armed');$('earChip').classList.toggle('bad',state==='denied'||state==='error');}
const mic=createMic({onUtterance:(wav,info)=>void convo.handle(wav,info),onState:showEar});
const convo=createConversation({
  listen:(wav,mode)=>api.listen(wav,mode), mic, speak:speakOnLaptop,
  onState:showEar,
  onHeard:text=>{$('heard').textContent=`Heard: “${text}”`;},
  onAnswer:(result,question)=>spokenHere.add(question),   // shown in the chat via /interaction
  onError:error=>toast(error.status===503?'SPEECH RECOGNITION UNAVAILABLE':'VOICE FAILED'),
});
async function talk(down){
  if(down){
    speaker.unlock();
    if(convo.busy){speaker.stop();return;}   // Space while Jarvis talks cuts him off
    mic.hold(true);
    if(!mic.on){try{await mic.start();}catch{mic.hold(false);toast('ALLOW THE MICROPHONE IN CHROME');}}
    else await mic.resume();
  }else{
    const outcome=mic.hold(false);   // the mic stays open, so the next Space starts instantly
    if(outcome==='not-ready')toast(mic.on?'MIC READY · HOLD SPACE AND SPEAK':'ALLOW THE MICROPHONE, THEN HOLD SPACE');
    if(outcome==='too-short')toast('KEEP HOLDING SPACE WHILE YOU SPEAK');
  }
}
async function toggleHandsFree(){
  speaker.unlock();
  if(mic.auto){mic.auto=false;convo.cancel();mic.stop();toast('HANDS-FREE OFF');return;}
  mic.auto=true;
  try{await mic.start();toast('HANDS-FREE · SAY "JARVIS, …"');}catch{mic.auto=false;toast('ALLOW THE MICROPHONE IN CHROME');}
}
const interactions=createLatestPoller({
  load:()=>api.getInteraction(),
  onUpdate(exchange){
    if(!exchange){interactionId=null;hideEvidence();return;}
    if(exchange.id===interactionId)return;
    interactionId=exchange.id;
    const alreadySpoken=spokenHere.has(exchange.question)||convo.busy;spokenHere.delete(exchange.question);
    // never replay an old answer on page load
    if(!alreadySpoken&&!firstExchange)void speakOnLaptop(exchange.result.answer);
    firstExchange=false;
    document.querySelectorAll('.line.pending').forEach(line=>line.remove());
    say('you',exchange.question);say('jarvis',exchange.result.answer);
    showEvidence(exchange.result);
  },
  onError(){ /* Camera status remains independent; a later poll can recover. */ }
});
// Keep the newest line in view: the evidence photo loads after the reply and shrinks the chat.
new ResizeObserver(()=>{$('transcript').scrollTop=$('transcript').scrollHeight;}).observe($('transcript'));

// ---------- chat box: typed questions from the laptop ----------
$('askForm').onsubmit=async e=>{
  e.preventDefault();
  const question=$('q').value.trim();
  if(!question||resetting)return;
  $('q').value='';speaker.unlock();
  const pending=say('jarvis','Checking the footage, sir…');pending.classList.add('pending');
  try{await api.askQuestion(question);}   // the answer itself arrives via /interaction
  catch(error){pending.classList.remove('pending');pending.textContent=`JARVIS ${error.message}`;}
};

// ---------- phone link QR: the tunnel URL changes every run, so keep asking ----------
let phoneUrl=null;
async function refreshPhoneLink(){
  try{
    const {url}=await (await fetch('/phone',{cache:'no-store'})).json();
    if(url===phoneUrl)return; phoneUrl=url;
    document.querySelectorAll('[data-qr]').forEach(img=>{img.hidden=!url;if(url)img.src=`/qr.svg?u=${encodeURIComponent(url)}`;});
    document.querySelectorAll('[data-qr-url]').forEach(p=>{p.textContent=url||'Waiting for the tunnel… (start it with ./start)';});
    document.querySelectorAll('[data-qr-hint]').forEach(p=>{p.textContent=url?'Scan with the iPhone camera, then press Start.':'Open the capture page on the iPhone and press Start.';});
  }catch{/* backend restarting; try again next time */}
}
void refreshPhoneLink(); setInterval(refreshPhoneLink,3000);

// the first poll may return an answer from before this page loaded: never speak that one
setTimeout(()=>{firstExchange=false;},2500);
showVoiceChip();
document.body.classList.remove('booting');
// Any click or key unlocks audio (browsers only allow sound after a gesture), so replies play by themselves.
for(const ev of ['pointerdown','keydown'])document.addEventListener(ev,()=>speaker.unlock(),{capture:true});
const typingInField=e=>e.target instanceof HTMLInputElement||e.target instanceof HTMLTextAreaElement||e.target.isContentEditable;
document.addEventListener('keyup',e=>{if(e.code==='Space'&&!typingInField(e)){e.preventDefault();void talk(false);}});
window.addEventListener('blur',()=>{mic.hold(false);});   // Space released outside the window
document.addEventListener('keydown',async e=>{
  if(typingInField(e)||resetting)return;
  const plain=!e.repeat&&!e.metaKey&&!e.ctrlKey&&!e.altKey;
  if(e.code==='Space'){e.preventDefault();if(plain)await talk(true);return;}
  if((e.key==='m'||e.key==='M')&&plain)await toggleHandsFree();
  if((e.key==='v'||e.key==='V')&&plain){laptopVoice=!laptopVoice;try{localStorage.setItem('jarvisLaptopAudio',laptopVoice?'1':'0');}catch{}
    if(laptopVoice)speaker.unlock();else speaker.stop();showVoiceChip();toast(laptopVoice?'LAPTOP AUDIO ON':'LAPTOP AUDIO OFF');}
  if((e.key==='q'||e.key==='Q')&&plain){$('qrOverlay').hidden=!$('qrOverlay').hidden;void refreshPhoneLink();}
  if((e.key==='r'||e.key==='R')&&plain)await reset();
  if(e.key==='Escape'){$('evidence').hidden=true;$('qrOverlay').hidden=true;}
});

async function reset() {
  if (resetting) return;
  resetting = true; mineGeneration++; hideEvidence(); $('q').disabled = true; convo.cancel(); speaker.stop();
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
    resetting = false; $('q').disabled = false;
    poller.start(); startPreview(); interactions.start(); void refreshMine();
  }
}

window.addEventListener('pagehide', () => { poller.stop(); stopPreview(); interactions.stop(); mineGeneration++; convo.cancel(); mic.stop(); speaker.stop(); });
window.addEventListener('pageshow', event => { if (event.persisted) { poller.start(); startPreview(); interactions.start(); void refreshMine(); } });

function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => ($('toast').hidden = true), 1600); }

poller.start(); startPreview(); interactions.start(); void refreshMine();
