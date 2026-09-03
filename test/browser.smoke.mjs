/**
 * Browser smoke test: loads the built game, starts a race, drives a few
 * seconds, and reports what the simulation actually did. Verifies the whole
 * stack — WebGL, physics, AI, HUD — really runs in a browser.
 */
import { chromium } from 'playwright';

const URL = process.env.APEX_URL || 'http://localhost:8787/';
const errors = [];

// Use the browser already present in the environment rather than downloading
// one; the bundled Playwright expects a different build number.
const EXECUTABLE = process.env.APEX_CHROME ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist',
         '--enable-features=Vulkan', '--disable-gpu-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);

const started = await page.evaluate(() => !!window.__apex);
console.log('game object created:', started);

const webgl = await page.evaluate(() => {
  const c = document.getElementById('game-canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return gl ? gl.getParameter(gl.VERSION) : 'none';
});
console.log('WebGL:', webgl);

const menu = await page.textContent('.brand h1').catch(() => null);
console.log('menu title:', menu);

// Quick Race -> race setup -> start
await page.click('[data-act="quick"]');
await page.waitForTimeout(600);
console.log('race setup visible:', await page.isVisible('#laps'));

// Small field and few laps so the test is quick.
await page.evaluate(() => {
  const g = window.__apex;
  g.screens.state.settings.aiCount = 3;
  g.screens.state.settings.laps = 2;
  g.screens.state.settings.tireWearScale = 4;
});
await page.click('[data-act="go"]');
await page.waitForTimeout(4000);

const afterStart = await page.evaluate(() => {
  const g = window.__apex;
  return {
    hasSession: !!g.session,
    phase: g.session?.phase,
    cars: g.session?.vehicles.length,
    renderCars: g.renderer.carModels.size,
    hudVisible: !document.getElementById('hud').classList.contains('hidden'),
    fps: Math.round(g.loop.fps),
    triangles: g.renderer.renderer.info.render.triangles,
    drawCalls: g.renderer.renderer.info.render.calls
  };
});
console.log('after start:', JSON.stringify(afterStart));

// This environment renders in software, so simulated time advances slowly.
// Wait for the race to actually start rather than for a wall-clock duration.
const startWait = Date.now();
await page.waitForFunction(
  () => window.__apex?.session?.phase === 'racing', null,
  { timeout: 180000, polling: 500 }
);
console.log('lights out after', ((Date.now() - startWait) / 1000).toFixed(1), 's of wall time');
await page.evaluate(() => {
  const g = window.__apex;
  g._testDrive = true;
  const orig = g._applyPlayerControls.bind(g);
  g._applyPlayerControls = (c, dt) => {
    // Hold a moderate throttle and let the physics do the rest.
    orig({ ...c, throttle: 0.75, brake: 0, steer: 0 }, dt);
  };
});
// Drive until the car has covered real ground.
await page.waitForFunction(
  () => window.__apex?.playerVehicle?.speedKmh > 120, null,
  { timeout: 180000, polling: 400 }
).catch(() => console.log('(did not reach 120 km/h in time)'));
await page.waitForTimeout(3000);

const driving = await page.evaluate(() => {
  const g = window.__apex;
  const v = g.playerVehicle;
  const e = g.playerEntry;
  return {
    phase: g.session.phase,
    raceTime: +g.session.director.raceTime.toFixed(1),
    speedKmh: Math.round(v.speedKmh),
    gear: v.transmission.gear,
    rpm: Math.round(v.rpm),
    position: e.position,
    lap: e.lap,
    distance: Math.round(e.distance),
    tireTemp: Math.round(v.wheels[0].tire.surfaceTemp),
    tireWear: +(v.wheels[0].tire.wear * 100).toFixed(1),
    fuel: +v.fuel.toFixed(1),
    downforceN: Math.round(v.aero.totalDownforce),
    hudSpeed: document.getElementById('speed-val')?.textContent,
    hudGear: document.getElementById('hud-gear')?.textContent,
    hudPos: document.querySelector('#hud-position .pos')?.textContent,
    towerRows: document.querySelectorAll('.tower-row').length,
    simFps: Math.round(g.loop.fps),
    aiSpeeds: g.session.director.drivers.filter(d=>d.isAI).map(d=>Math.round(d.vehicle.speedKmh))
  };
});
console.log('while driving:', JSON.stringify(driving, null, 2));

await page.screenshot({ path: process.env.SHOT || '/tmp/apex-race.png' });
console.log('screenshot saved');

// Camera cycling
const cams = [];
for (let i = 0; i < 6; i++) {
  const m = await page.evaluate(() => window.__apex.renderer.cameraRig.cycle(1));
  cams.push(m);
  await page.waitForTimeout(120);
}
console.log('camera modes cycled:', cams.join(' -> '));

console.log('\nconsole errors:', errors.length ? errors.slice(0, 6) : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
