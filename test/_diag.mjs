import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
         '--no-sandbox','--disable-dev-shm-usage','--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport:{width:1280,height:720} });
const logs=[];
page.on('console', m=>logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e=>logs.push('PAGEERROR: '+e.message+'\n'+(e.stack||'').split('\n').slice(0,4).join('\n')));
page.on('requestfailed', r=>logs.push('REQFAIL: '+r.url()+' '+r.failure()?.errorText));
const resp = await page.goto('http://localhost:8787/', { waitUntil:'load', timeout:30000 });
console.log('status:', resp?.status(), 'url:', page.url());
console.log('title:', await page.title());
await page.waitForTimeout(4000);
console.log('body length:', (await page.content()).length);
console.log('canvas present:', await page.evaluate(()=>!!document.getElementById('game-canvas')));
console.log('apex present:', await page.evaluate(()=>!!window.__apex));
console.log('--- console/page logs ---');
console.log(logs.slice(0,25).join('\n') || '(none)');
await browser.close();
