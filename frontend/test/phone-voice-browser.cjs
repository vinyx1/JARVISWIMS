// Two browser pages, synthetic speech only. No real microphone, provider calls or demo data.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
(async()=>{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext();
 await context.addInitScript(()=>{
   window.voiceQA={recognizers:[],spoken:[]};
   class Recognition{constructor(){window.voiceQA.recognizers.push(this);}start(){this.onstart?.();}stop(){this.onend?.();}abort(){this.onend?.();}emit(text){const row=[{transcript:text}];row.isFinal=true;this.onresult({resultIndex:0,results:[row]});this.onend?.();}}
   Object.defineProperty(window,'SpeechRecognition',{configurable:true,value:Recognition});
   Object.defineProperty(window,'AudioContext',{configurable:true,value:undefined});Object.defineProperty(window,'webkitAudioContext',{configurable:true,value:undefined});
   Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{getVoices:()=>[{lang:'en-GB'}],cancel(){},speak(u){window.voiceQA.spoken.push(u.text);setTimeout(()=>u.onend?.(),20);}}});
   Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(text){this.text=text;}}});
 });
 let exchange=null,asks=0,slow=false;
 const result={answer:'Your helmet was on the grey chair, sir.',kind:'find',frames:[{id:'f_000001',url:'/frames/f_000001.jpg',ts:Date.now(),note:'Helmet on chair',box:[.2,.2,.5,.5]}]};
 await context.route('https://fonts.googleapis.com/**',r=>r.fulfill({body:'',contentType:'text/css'}));
 await context.route('**/latest',r=>r.fulfill({json:null}));await context.route('**/mine',r=>r.fulfill({json:[]}));await context.route('**/preview.jpg',r=>r.fulfill({status:204}));
 await context.route('**/interaction',r=>r.fulfill({json:exchange}));await context.route('**/speak',r=>r.fulfill({status:204}));
 await context.route('**/frames/**',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#284858"/></svg>'}));
 await context.route('**/ask',async r=>{asks++;if(slow)await new Promise(resolve=>setTimeout(resolve,500));exchange={id:String(asks),question:r.request().postDataJSON().question,result};await r.fulfill({json:result});});
 const hud=await context.newPage(),phone=await context.newPage(),errors=[];hud.on('pageerror',e=>errors.push(e.message));phone.on('pageerror',e=>errors.push(e.message));
 await hud.goto(process.env.HUD_URL||'http://127.0.0.1:8001');await phone.setViewportSize({width:390,height:844});await phone.goto((process.env.HUD_URL||'http://127.0.0.1:8001')+'/capture.html');
 await phone.getByRole('button',{name:'Talk to Jarvis',exact:true}).click();await phone.evaluate(()=>window.voiceQA.recognizers.at(-1).emit('Where is my helmet?'));
 await phone.locator('#phoneAnswer').filter({hasText:result.answer}).waitFor();await phone.waitForFunction(()=>window.voiceQA.spoken.length===1);
 await hud.locator('#heroCap').filter({hasText:'Helmet on chair'}).waitFor();await hud.locator('#objectOutline').waitFor({state:'visible'});
 assert.equal(asks,1);await hud.locator('body').click({position:{x:100,y:100}});await hud.keyboard.press('Space');assert.deepEqual(await hud.evaluate(()=>window.voiceQA),{recognizers:[],spoken:[]});
 await phone.getByRole('button',{name:'Play reply',exact:true}).click();await phone.waitForFunction(()=>window.voiceQA.spoken.length===2);
 for(const [width,height] of [[390,844],[844,390],[320,568]]){await phone.setViewportSize({width,height});assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const panel=await phone.locator('.phone-panel').boundingBox();assert.ok(panel.x>=0&&panel.y>=0&&panel.x+panel.width<=width+1&&panel.y+panel.height<=height+1);if(process.env.SCREENSHOT_PATH&&width===390)await phone.screenshot({path:process.env.SCREENSHOT_PATH});}
 await phone.getByRole('button',{name:'Talk to Jarvis',exact:true}).click();await phone.evaluate(()=>{const r=window.voiceQA.recognizers.at(-1);r.onerror({error:'not-allowed'});r.onend();});await phone.locator('#phoneVoiceStatus').filter({hasText:'Microphone blocked'}).waitFor();
 await phone.locator('#phoneQuestion').fill('Where are my keys?');await phone.getByRole('button',{name:'Send',exact:true}).click();await phone.waitForFunction(()=>window.voiceQA.spoken.length===3);assert.equal(asks,2);
 slow=true;await phone.locator('#phoneQuestion').fill('Late question');await phone.getByRole('button',{name:'Send',exact:true}).click();await phone.waitForTimeout(50);await phone.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));await phone.waitForTimeout(650);assert.equal(await phone.evaluate(()=>window.voiceQA.spoken.length),3);
 const unsupported=await browser.newContext();await unsupported.addInitScript(()=>{window.SpeechRecognition=undefined;window.webkitSpeechRecognition=undefined;});const fallback=await unsupported.newPage();await fallback.goto((process.env.HUD_URL||'http://127.0.0.1:8001')+'/capture.html');assert.ok(await fallback.locator('#phoneTalk').isDisabled());assert.ok(await fallback.locator('#phoneQuestion').isEnabled());await unsupported.close();
 assert.deepEqual(errors,[]);console.log('PASS: phone recognition → answer → phone speech → silent HUD evidence/box; replay, typed fallback, denial, unsupported browser, page-hide cancellation and 3 layouts. Real iPhone audio remains unverified.');
 await browser.close();
})().catch(async e=>{console.error(e);await browser?.close();process.exitCode=1;});
