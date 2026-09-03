// Capture the game from several viewpoints to check the visuals.
import { chromium } from 'playwright';
const OUT = process.env.OUT || '/tmp';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
         '--no-sandbox','--disable-dev-shm-usage','--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport:{width:1280,height:720} });
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto('http://localhost:8787/', { waitUntil:'load', timeout:60000 });
await page.waitForFunction(()=>!!window.__apex, null, {timeout:30000});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/01-menu.png` });

await page.click('[data-act="quick"]');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/02-setup.png` });

await page.click('[data-act="cars"]');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/03-cars.png` });
await page.click('[data-act="confirm"]');
await page.waitForTimeout(500);

await page.evaluate(()=>{ const g=window.__apex;
  g.screens.state.settings.aiCount=7; g.screens.state.settings.laps=3; });
await page.click('[data-act="go"]');
await page.waitForFunction(()=>window.__apex?.session, null, {timeout:60000});
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/04-grid.png` });

await page.waitForFunction(()=>window.__apex?.session?.phase==='racing', null, {timeout:200000, polling:500});
// Let the AI run and put the player among them.
await page.evaluate(()=>{ const g=window.__apex;
  const orig=g._applyPlayerControls.bind(g);
  g._applyPlayerControls=(c,dt)=>orig({...c, throttle:0.8, brake:0, steer:0}, dt);
});
await page.waitForFunction(()=>window.__apex?.playerVehicle?.speedKmh>200, null, {timeout:200000, polling:400}).catch(()=>{});
await page.screenshot({ path: `${OUT}/05-racing-chase.png` });

for (const [mode, file] of [['cockpit','06-cockpit'],['tv','07-tv'],['nose','08-nose']]) {
  await page.evaluate((m)=>window.__apex.renderer.cameraRig.setMode(m), mode);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${file}.png` });
}
// Wet weather
await page.evaluate(()=>{ window.__apex.session.weather.setState('heavyRain', 4); });
await page.waitForTimeout(6000);
await page.evaluate(()=>window.__apex.renderer.cameraRig.setMode('chase'));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/09-rain.png` });

const state = await page.evaluate(()=>{
  const g=window.__apex, v=g.playerVehicle;
  return { speed:Math.round(v.speedKmh), wet:+g.session.weather.averageWetness.toFixed(2),
    compound:v.compound, drawCalls:g.renderer.renderer.info.render.calls,
    tris:g.renderer.renderer.info.render.triangles, standings:g.session.standings.length };
});
console.log('state:', JSON.stringify(state));
console.log('errors:', errs.length?errs.slice(0,4):'none');
await browser.close();
