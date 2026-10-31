// Synthetic HUD QA: intercept every backend route and emulate speech APIs. No microphone or AI calls.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
(async()=>{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
 const errors=[],failures=[];page.on('pageerror',e=>errors.push(e.message));
 const check=(ok,message)=>{if(!ok)failures.push(message);};
 await page.addInitScript(()=>{
   window.testSpeech={spoken:[],recognizers:[]};
   const synthesis={speaking:false,getVoices:()=>[{name:'Daniel',lang:'en-GB'}],cancel(){this.speaking=false;},speak(u){window.testSpeech.spoken.push({text:u.text,lang:u.lang});}};
   Object.defineProperty(window,'speechSynthesis',{configurable:true,value:synthesis});
   Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:class {constructor(text){this.text=text;}}});
   class Recognition{constructor(){window.testSpeech.recognizers.push(this);}start(){this.onstart?.();}stop(){this.onend?.();}emit(text){const row=[{transcript:text}];row.isFinal=true;this.onresult({resultIndex:0,results:[row]});}}
   Object.defineProperty(window,'SpeechRecognition',{configurable:true,value:Recognition});
 });
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({body:'',contentType:'text/css'}));
 const photo=`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="960" viewBox="0 0 1280 960"><rect width="1280" height="960" fill="#17272e"/><path d="M0 680H1280M180 0V680M1060 0V680" stroke="#344b55" stroke-width="3"/><rect x="250" y="520" width="600" height="60" rx="8" fill="#785a41"/><path d="M290 580V830M800 580V830" stroke="#785a41" stroke-width="24"/><path d="M455 500V425Q455 320 550 320Q645 320 645 425V500Z" fill="#b6362f"/><path d="M485 398H615V470H485Z" fill="#c5a75d"/><path d="M495 418H530M565 418H600" stroke="#82e4f5" stroke-width="10"/><rect x="890" y="200" width="150" height="60" fill="#246e54"/><text x="915" y="240" fill="white" font-size="28" font-family="sans-serif">EXIT →</text><text x="40" y="60" fill="#b9cbd1" font-size="24" font-family="sans-serif">SYNTHETIC QA FRAME · NO LIVE CAMERA</text></svg>`;
 await page.route('**/frames/**',r=>r.fulfill({body:photo,contentType:'image/svg+xml'}));
 let latest=null,offline=false,resetCount=0,latestCalls=0,previewCalls=0,previewMode='empty',askMode='find',mine=[],exchange=null;
 const entry=(id,caption)=>({id,ts:Date.now()-5000,url:`/frames/${id}.jpg`,caption});
 const caption={scene:'A red helmet is on the workbench by the exit.',room_guess:'workshop',objects:['red helmet'],landmarks:['exit sign','workbench']};
 const first={...entry('f_000001',caption),box:[.35,.33,.51,.53]};
 await page.route('**/preview.jpg',r=>{previewCalls++;return r.fulfill(previewMode==='live'?{body:photo,contentType:'image/svg+xml'}:{status:204});});
 await page.route('**/latest',r=>{latestCalls++;return r.fulfill(offline?{status:503,json:{detail:'test offline'}}:{json:latest});});
 await page.route('**/interaction',r=>r.fulfill({json:exchange}));
 await page.route('**/mine',r=>r.fulfill({json:mine}));
 await page.route('**/speak',r=>r.fulfill({status:404})); // no ElevenLabs in tests: browser voice
 await page.route('**/log',r=>r.fulfill({json:latest?[latest]:[]}));
 await page.route('**/reset',async r=>{resetCount++;mine=[];exchange=null;await new Promise(resolve=>setTimeout(resolve,600));latest=null;await r.fulfill({json:{ok:true}});});
 const answer='Sir, your helmet was last seen on the workbench beside the exit sign.';
 await page.route('**/ask',async r=>{
   if(askMode==='error'){await r.fulfill({status:503,json:{detail:'test error'}});return;}
   await new Promise(resolve=>setTimeout(resolve,askMode==='slow'?1100:350));
   const remembering=['remember','rememberBag'].includes(askMode);const description=askMode==='rememberBag'?'Black bag with red strap':'Red helmet with gold faceplate';
   const frames=remembering?[{...first,note:description}]:askMode==='candidates'?[{...first,note:'Red helmet on bench'},{...entry('f_000003',caption),box:[.1,.1,.3,.3],note:'Second helmet by the door'}]:askMode==='invalid'?[{...first,box:[100,100,200,200],note:'Invalid localization'}]:askMode==='retrace'?[{...entry('f_000003',caption),note:'Stage'},{...first,note:'Helmet on workbench'}]:askMode==='empty'?[]:[{...first,note:'Helmet on workbench'}];
   if(remembering)mine.push({item:askMode==='rememberBag'?'bag':'helmet',description,frame_id:first.id,url:first.url,ts:first.ts});
   const result={answer:askMode==='empty'?'I have not seen that object, sir.':answer,kind:remembering?'remember':askMode==='retrace'?'retrace':'find',frames};
   exchange={id:String(Date.now()),question:r.request().postDataJSON().question,result};
   await r.fulfill({json:result});
 });
 await page.goto(process.env.HUD_URL||'http://127.0.0.1:8000');await page.getByText('LINK OK',{exact:true}).waitFor();
 check(await page.locator('#idle').isVisible(),'empty feed should show standby');
 latest=first;await page.getByText('red helmet',{exact:true}).waitFor();
 latest=entry('f_000002',null);await page.getByText('ANALYZING…',{exact:true}).waitFor();
 check(await page.locator('#objects').textContent()==='','pending caption must clear previous object labels');
 check(await page.locator('#scene').textContent()==='','pending caption must clear previous scene');
 check(await page.locator('#room').textContent()==='ROOM —','pending caption must clear previous room');
 latest=null;await page.waitForTimeout(1200);check(!await page.locator('#scanState').evaluate(e=>e.classList.contains('busy')),'standby must clear analyzing styling');
 latest=first;await page.getByText('red helmet',{exact:true}).waitFor();
 async function ask(question){await page.evaluate(async question=>{await fetch('/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question})});},question);await page.waitForFunction(q=>document.getElementById('transcript').textContent.includes(q),question);}
 await ask('Where is my helmet?');await page.waitForFunction(a=>document.getElementById('transcript').textContent.includes(a),answer);
 check(!await page.locator('.subs').isVisible(),'subtitles must be hidden by default');
 await page.keyboard.press('t');check(await page.locator('.subs').isVisible()&&await page.locator('.subs').textContent().then(t=>t.includes(answer)),'T must show the answer as a subtitle');await page.keyboard.press('t');
 check(await page.locator('#evidence').isVisible(),'find answer must include evidence');
 check(new URL(await page.locator('#heroImg').getAttribute('src'),'http://localhost').pathname==='/frames/f_000001.jpg','find must show matched photo');
 check(await page.locator('#transcript').textContent().then(t=>t.includes(answer)),"Paul's full find answer must remain visible");
 await page.locator('#objectOutline').waitFor({state:'visible',timeout:3000});
 async function checkOutline(){
   return page.evaluate(()=>{
     // The hologram tilts the evidence card in 3D; the outline shares the photo's plane, so measure it flat.
     const ev=document.getElementById('evidence');ev.style.transform='none';ev.style.animation='none';
     const img=document.getElementById('heroImg'),box=img.getBoundingClientRect(),rect=document.querySelector('#objectOutline rect').getBoundingClientRect();
     const scale=Math.min(box.width/img.naturalWidth,box.height/img.naturalHeight);
     const left=box.left+(box.width-img.naturalWidth*scale)/2,top=box.top+(box.height-img.naturalHeight*scale)/2;
     const ok=Math.abs(rect.left-(left+.35*img.naturalWidth*scale))<1&&Math.abs(rect.top-(top+.33*img.naturalHeight*scale))<1&&Math.abs(rect.width-.16*img.naturalWidth*scale)<1&&Math.abs(rect.height-.20*img.naturalHeight*scale)<1;
     ev.style.transform='';ev.style.animation='';return ok;
   });
 }
 for(const viewport of [{width:1440,height:900},{width:1280,height:720},{width:390,height:844}]){await page.setViewportSize(viewport);check(await checkOutline(),`selected object box is misaligned at ${viewport.width}`);}
 await page.setViewportSize({width:1440,height:900});
 if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
 askMode='remember';await ask('This is my helmet, remember it');await page.getByText('REGISTERED · MY HELMET',{exact:true}).waitFor();
 check(await page.locator('#myItems').textContent().then(t=>t.includes('Red helmet with gold faceplate')),'registered items must refresh after remember');
 check(await page.locator('#trail li').count()===0,'registration must not show route breadcrumbs');
 askMode='rememberBag';await ask('This is my bag, remember it');await page.waitForTimeout(600);check(await page.locator('#evidenceTitle').textContent()==='REGISTERED · MY BAG','registration must select the right item when two share one frame');
 askMode='candidates';await ask('Which helmet?');await page.waitForTimeout(600);
 check(await page.locator('#candidates button').count()===2,'multiple find matches must appear as side-by-side options');
 await page.locator('#candidates button').nth(1).click();
 check(new URL(await page.locator('#heroImg').getAttribute('src'),'http://localhost').pathname==='/frames/f_000003.jpg','selecting a candidate must change the hero photo');
 check(await page.locator('#candidates button').nth(1).getAttribute('aria-pressed')==='true','selected candidate must be indicated');
 askMode='retrace';await ask('Retrace my steps');await page.waitForTimeout(600);
 check(await page.locator('#trail li').count()===2,'retrace should preserve breadcrumb sequence');
 check(new URL(await page.locator('#heroImg').getAttribute('src'),'http://localhost').pathname==='/frames/f_000001.jpg','retrace target is the last returned frame');
 askMode='invalid';await ask('Find object with invalid coordinates');await page.waitForTimeout(600);check(!await page.locator('#objectOutline').isVisible(),'invalid boxes must not draw an outline');
 askMode='empty';await ask('Find the missing wrench');await page.waitForTimeout(600);check(!await page.locator('#evidence').isVisible(),'empty results must hide evidence');
 await page.locator('body').click({position:{x:100,y:100}});await page.keyboard.press('Space');
 check(await page.evaluate(()=>window.testSpeech.recognizers.length===0&&window.testSpeech.spoken.length===0),'display HUD must never start recognition or speech, even after clicks and Space');
 previewMode='live';await page.locator('#liveChip').waitFor({state:'visible'});check((await page.locator('#live').getAttribute('src')).startsWith('blob:'),'live preview must use received frame');
 previewMode='empty';await page.locator('#liveChip').waitFor({state:'hidden'});await page.waitForFunction(()=>document.getElementById('live').getAttribute('src')?.startsWith('/frames/'));
 offline=true;await page.getByText('LINK LOST',{exact:true}).waitFor();offline=false;await page.getByText('LINK OK',{exact:true}).waitFor();
 await page.keyboard.press('r');await page.waitForTimeout(1000);check(resetCount===1,'R should issue one reset');check(await page.locator('#myItems').textContent().then(t=>t.includes('No items registered')),'reset must refresh My Items');check(await page.locator('#transcript').textContent()==='','reset must clear transcript');
 const previewAtHide=previewCalls;const atHide=latestCalls;await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await page.waitForTimeout(1100);const before=latestCalls;check(before===atHide,'leaving page must stop feed polling');check(previewCalls===previewAtHide,'leaving page must stop preview polling');
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await page.waitForTimeout(1100);check(latestCalls>before,'restored page must resume polling');
 for(const viewport of [{width:1280,height:720},{width:1024,height:768},{width:390,height:844}]){await page.setViewportSize(viewport);check(!await page.locator('body').evaluate(e=>e.scrollWidth>innerWidth),`HUD overflows horizontally at ${viewport.width}`);}
 check(await page.locator('#micChip').textContent()==='VOICE ON PHONE','HUD must identify the phone as the voice device');
 assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
 console.log('HUD browser QA passed: live-preview fallback and feed transitions, remember/My Items/candidate selection, selected-object outline alignment and full answers/photos/breadcrumbs, relay deduplication, silent laptop, reset, page restoration and layouts. No API key or real microphone used.');
 await browser.close();
})().catch(async error=>{console.error(error);await browser?.close();process.exitCode=1;});
