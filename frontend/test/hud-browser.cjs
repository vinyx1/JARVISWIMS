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
 let latest=null,offline=false,resetCount=0,latestCalls=0,previewCalls=0,previewMode='empty',askMode='find',mine=[];
 const entry=(id,caption)=>({id,ts:Date.now()-5000,url:`/frames/${id}.jpg`,caption});
 const caption={scene:'A red helmet is on the workbench by the exit.',room_guess:'workshop',objects:['red helmet'],landmarks:['exit sign','workbench']};
 const first={...entry('f_000001',caption),box:[.35,.33,.51,.53]};
 await page.route('**/preview.jpg',r=>{previewCalls++;return r.fulfill(previewMode==='live'?{body:photo,contentType:'image/svg+xml'}:{status:204});});
 await page.route('**/latest',r=>{latestCalls++;return r.fulfill(offline?{status:503,json:{detail:'test offline'}}:{json:latest});});
 await page.route('**/mine',r=>r.fulfill({json:mine}));
 await page.route('**/log',r=>r.fulfill({json:latest?[latest]:[]}));
 await page.route('**/reset',async r=>{resetCount++;mine=[];await new Promise(resolve=>setTimeout(resolve,600));latest=null;await r.fulfill({json:{ok:true}});});
 const answer='Sir, your helmet was last seen on the workbench beside the exit sign.';
 await page.route('**/ask',async r=>{
   if(askMode==='error'){await r.fulfill({status:503,json:{detail:'test error'}});return;}
   await new Promise(resolve=>setTimeout(resolve,askMode==='slow'?1100:350));
   const remembering=['remember','rememberBag'].includes(askMode);const description=askMode==='rememberBag'?'Black bag with red strap':'Red helmet with gold faceplate';
   const frames=remembering?[{...first,note:description}]:askMode==='candidates'?[{...first,note:'Red helmet on bench'},{...entry('f_000003',caption),box:[.1,.1,.3,.3],note:'Second helmet by the door'}]:askMode==='invalid'?[{...first,box:[100,100,200,200],note:'Invalid localization'}]:askMode==='retrace'?[{...entry('f_000003',caption),note:'Stage'},{...first,note:'Helmet on workbench'}]:askMode==='empty'?[]:[{...first,note:'Helmet on workbench'}];
   if(remembering)mine.push({item:askMode==='rememberBag'?'bag':'helmet',description,frame_id:first.id,url:first.url,ts:first.ts});
   await r.fulfill({json:{answer:askMode==='empty'?'I have not seen that object, sir.':answer,kind:remembering?'remember':askMode==='retrace'?'retrace':'find',frames}});
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
 async function ask(question){await page.locator('#q').fill(question);await page.locator('#askForm').evaluate(e=>e.requestSubmit());}
 await ask('Where is my helmet?');await page.getByText(answer,{exact:false}).waitFor();
 check(await page.locator('#evidence').isVisible(),'find answer must include evidence');
 check(new URL(await page.locator('#heroImg').getAttribute('src'),'http://localhost').pathname==='/frames/f_000001.jpg','find must show matched photo');
 check(await page.locator('#transcript').textContent().then(t=>t.includes(answer)),"Paul's full find answer must remain visible");
 await page.locator('#objectOutline').waitFor({state:'visible',timeout:3000});
 async function checkOutline(){
   return page.evaluate(()=>{
     const img=document.getElementById('heroImg'),box=img.getBoundingClientRect(),rect=document.querySelector('#objectOutline rect').getBoundingClientRect();
     const scale=Math.min(box.width/img.naturalWidth,box.height/img.naturalHeight);
     const left=box.left+(box.width-img.naturalWidth*scale)/2,top=box.top+(box.height-img.naturalHeight*scale)/2;
     return Math.abs(rect.left-(left+.35*img.naturalWidth*scale))<1&&Math.abs(rect.top-(top+.33*img.naturalHeight*scale))<1&&Math.abs(rect.width-.16*img.naturalWidth*scale)<1&&Math.abs(rect.height-.20*img.naturalHeight*scale)<1;
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
 askMode='error';await ask('Where is my screwdriver?');await page.waitForTimeout(500);
 check(!await page.locator('#evidence').isVisible(),'failed new question must not leave previous object evidence visible');check(await page.locator('#objectOutline').getAttribute('hidden')!==null,'new request must clear the object outline');
 check(!await page.locator('body').evaluate(e=>e.classList.contains('thinking')),'failed request must exit thinking state');
 askMode='retrace';await ask('Retrace my steps');await page.waitForTimeout(600);
 check(await page.locator('#trail li').count()===2,'retrace should preserve breadcrumb sequence');
 check(new URL(await page.locator('#heroImg').getAttribute('src'),'http://localhost').pathname==='/frames/f_000001.jpg','retrace target is the last returned frame');
 askMode='invalid';await ask('Find object with invalid coordinates');await page.waitForTimeout(600);check(!await page.locator('#objectOutline').isVisible(),'invalid boxes must not draw an outline');
 askMode='empty';await ask('Find the missing wrench');await page.waitForTimeout(600);check(!await page.locator('#evidence').isVisible(),'empty results must hide evidence');
 askMode='find';await page.locator('#q').blur();
 await page.evaluate(()=>window.testSpeech.recognizers.at(-1).emit('Jarvis, where is my helmet?'));await page.waitForTimeout(600);
 check(await page.locator('#transcript').textContent().then(t=>t.includes('where is my helmet?')),'wake word must submit a question');
 await page.keyboard.down('Space');await page.evaluate(()=>window.testSpeech.recognizers.at(-1).emit('find the helmet'));await page.keyboard.up('Space');await page.waitForTimeout(1400);
 check(await page.locator('#transcript').textContent().then(t=>t.includes('find the helmet')),'hold-Space must submit once released');
 check(await page.evaluate(()=>window.testSpeech.spoken.some(u=>u.text=== 'Sir, your helmet was last seen on the workbench beside the exit sign.'&&u.lang==='en-GB')),'answer should be spoken with British voice configuration');
 previewMode='live';await page.locator('#liveChip').waitFor({state:'visible'});check((await page.locator('#live').getAttribute('src')).startsWith('blob:'),'live preview must use received frame');
 previewMode='empty';await page.locator('#liveChip').waitFor({state:'hidden'});await page.waitForFunction(()=>document.getElementById('live').getAttribute('src')?.startsWith('/frames/'));
 offline=true;await page.getByText('LINK LOST',{exact:true}).waitFor();offline=false;await page.getByText('LINK OK',{exact:true}).waitFor();
 await page.locator('#q').fill('remember');await page.locator('#q').focus();await page.keyboard.press('r');check(resetCount===0,'R typed into question must not clear memory');await page.locator('#q').blur();
 askMode='slow';await ask('slow answer');await page.locator('#q').blur();
 await page.keyboard.press('r');await page.waitForTimeout(50);check(resetCount===0,'reset must wait until a pending answer/registration finishes');
 await page.waitForTimeout(1300);await page.keyboard.press('r');await page.waitForTimeout(50);check(await page.locator('#q').isDisabled(),'reset should block new questions until complete');
 await page.waitForTimeout(800);check(resetCount===1,'one accepted R keypress should issue one reset');check(await page.locator('#myItems').textContent().then(t=>t.includes('No items registered')),'reset must refresh My Items');check(!await page.locator('#transcript').textContent().then(t=>t.includes(answer)),'late pre-reset reply must not restore answer');
 const previewAtHide=previewCalls;const atHide=latestCalls;await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await page.waitForTimeout(1100);const before=latestCalls;check(before===atHide,'leaving page must stop feed polling');check(previewCalls===previewAtHide,'leaving page must stop preview polling');
 await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await page.waitForTimeout(1100);check(latestCalls>before,'restored page must resume polling');
 for(const viewport of [{width:1280,height:720},{width:1024,height:768},{width:390,height:844}]){await page.setViewportSize(viewport);check(!await page.locator('body').evaluate(e=>e.scrollWidth>innerWidth),`HUD overflows horizontally at ${viewport.width}`);}
 await page.locator('#q').click(); // New gesture resumes recognition after page restoration.
 await page.evaluate(()=>window.testSpeech.recognizers.at(-1)?.onerror({error:'not-allowed'}));
 check(await page.locator('#micChip').textContent()==='MIC BLOCKED','permission-denied microphone must be indicated');
 check(await page.locator('#q').isEnabled(),'typed fallback must work when microphone is blocked');
 assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
 console.log('HUD browser QA passed: live-preview fallback and feed transitions, remember/My Items/candidate selection, selected-object outline alignment and full answers/photos/breadcrumbs, errors, synthetic wake/PTT/TTS, reset races, page restoration, layouts and microphone denial. No API key or real microphone used.');
 await browser.close();
})().catch(async error=>{console.error(error);await browser?.close();process.exitCode=1;});
