// Synthetic phone preview QA; no real camera or backend requests.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let browser;
(async()=>{
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const context=await browser.newContext({permissions:['camera'],viewport:{width:390,height:844}}),page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.previewEncodes=[];const original=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(callback,type,quality){window.previewEncodes.push({width:this.width,quality});return original.call(this,callback,type,quality);};});
 let requests=0,active=0,maxActive=0,saved=0;const timestamps=[];
 await page.route('**/frame',route=>{saved++;return route.fulfill({json:{id:'f_phone',caption:null}});});
 await page.route('**/preview',async route=>{
   requests++;active++;maxActive=Math.max(maxActive,active);
   const body=route.request().postDataBuffer().toString('latin1');const match=body.match(/name="ts"\r\n\r\n(\d+)/);if(match)timestamps.push(Number(match[1]));
   await new Promise(resolve=>setTimeout(resolve,350));active--;await route.fulfill({json:{ok:true}}).catch(()=>{});
 });
 await page.goto((process.env.HUD_URL||'http://127.0.0.1:8000')+'/capture.html');
 await page.getByRole('button',{name:'Start capture',exact:true}).click();await page.getByText('Snapshot saved. The laptop is analyzing it.',{exact:true}).waitFor();
 await page.waitForTimeout(1800);
 assert.ok(requests>=5,'preview should keep uploading independently of saved frames');assert.ok(maxActive>=2&&maxActive<=5,'preview overlap must be bounded at 5');
 assert.equal(timestamps.length,requests,'every preview must carry a timestamp');assert.ok(timestamps.every(ts=>Number.isFinite(ts)&&ts>0));
 const encodes=await page.evaluate(()=>window.previewEncodes);assert.ok(encodes.some(x=>x.width===360&&x.quality===.45));assert.ok(encodes.some(x=>x.width===640));
 await page.getByRole('button',{name:'Stop',exact:true}).click();const stopped=requests;await page.waitForTimeout(500);assert.equal(requests,stopped,'Stop must prevent new previews');assert.equal(await page.locator('#phoneVideo').evaluate(e=>e.srcObject),null);
 assert.ok(saved>=1);assert.deepEqual(errors,[]);
 console.log(`Synthetic phone preview passed: ${requests} preview requests, maximum ${maxActive} in flight; timestamps, 360px encoding and Stop cleanup verified. Real tunnel FPS remains unmeasured.`);
 await browser.close();
})().catch(async error=>{console.error(error);await browser?.close();process.exitCode=1;});
