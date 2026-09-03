/**
 * Frame profiler.
 *
 * Answers the question "why is it not smooth on this machine?" with numbers
 * rather than guesses: it starts a race, then reports where each frame's time
 * actually goes and what the renderer is being asked to draw.
 *
 * Run against a built game (`npm run build && npm run preview`):
 *
 *     npm run profile
 *
 * Read it like this:
 *   - `wallPerFrame` far above the sum of the parts means the GPU is the
 *     limit, not JavaScript. Turn the quality down; the biggest lever is
 *     resolution, then shadows.
 *   - `physics` climbing means CPU: fewer cars, or a machine also running the
 *     race server.
 *   - `calls` in the high hundreds means draw calls, which is what the
 *     geometry merging in `mergeStatic.js` exists to keep down.
 */
import { chromium } from 'playwright';

const URL = process.env.APEX_URL || 'http://localhost:8080/';
const EXECUTABLE = process.env.APEX_CHROME ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const AI = Number(process.env.APEX_AI ?? 3);

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);
await page.evaluate((ai) => {
  const g = window.__apex;
  g.screens.state.settings.aiCount = ai;
  g.startSinglePlayer('quick');
}, AI);
await page.waitForTimeout(8000);

console.log(`--- scene composition (${AI + 1} cars) ---`);
console.table(await page.evaluate(() => {
  const rows = [];
  for (const child of window.__apex.renderer.scene.children) {
    let meshes = 0, tris = 0;
    child.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      if (g?.index) tris += g.index.count / 3;
      else if (g?.attributes?.position) tris += g.attributes.position.count / 3;
    });
    if (meshes) rows.push({ name: child.name || child.type, meshes, triangles: Math.round(tris) });
  }
  return rows.sort((a, b) => b.meshes - a.meshes).slice(0, 12);
}));

console.log('--- where each frame goes (ms, averaged over 60 frames) ---');
console.log(await page.evaluate(async () => {
  const g = window.__apex;
  const t = { physics: 0, render: 0, visuals: 0, hud: 0, audio: 0, camera: 0 };
  const original = {
    session: g.session.update.bind(g.session),
    render: g.renderer.render.bind(g.renderer),
    visuals: g._updateVisuals.bind(g),
    hud: g._updateHud.bind(g),
    audio: g._updateAudio.bind(g),
    camera: g._updateCamera.bind(g)
  };
  const time = (key, fn) => (...args) => {
    const a = performance.now();
    const r = fn(...args);
    t[key] += performance.now() - a;
    return r;
  };
  g.session.update = time('physics', original.session);
  g.renderer.render = time('render', original.render);
  g._updateVisuals = time('visuals', original.visuals);
  g._updateHud = time('hud', original.hud);
  g._updateAudio = time('audio', original.audio);
  g._updateCamera = time('camera', original.camera);

  const start = performance.now();
  await new Promise((resolve) => {
    let n = 0;
    const tick = () => { if (++n >= 60) return resolve(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const wall = performance.now() - start;

  g.session.update = original.session;
  g.renderer.render = original.render;
  g._updateVisuals = original.visuals;
  g._updateHud = original.hud;
  g._updateAudio = original.audio;
  g._updateCamera = original.camera;

  const per = (x) => +(x / 60).toFixed(2);
  const info = g.renderer.renderer.info.render;
  return {
    physics: per(t.physics), render: per(t.render), visuals: per(t.visuals),
    hud: per(t.hud), audio: per(t.audio), camera: per(t.camera),
    javascriptTotal: per(Object.values(t).reduce((a, b) => a + b, 0)),
    wallPerFrame: +(wall / 60).toFixed(2),
    fps: +(1000 / (wall / 60)).toFixed(1),
    drawCalls: info.calls, triangles: info.triangles
  };
}));

await browser.close();
