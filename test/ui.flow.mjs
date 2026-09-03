/**
 * UI flow test: walks the menu screens that are not covered by the driving
 * smoke test — qualifying setup, and the race-weekend results screen with its
 * "continue to the next session" hand-off.
 */
import { chromium } from 'playwright';

const URL = process.env.APEX_URL || 'http://localhost:8787/';
const EXECUTABLE = process.env.APEX_CHROME ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const errors = [];
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);

// --- every mode advertised on the menu reaches its setup screen -------------
for (const [act, title] of [['quick', 'Quick Race'], ['weekend', 'Race Weekend'],
                            ['practice', 'Practice'], ['timetrial', 'Time Trial'],
                            ['qualifying', 'Qualifying']]) {
  await page.click(`[data-act="${act}"]`);
  await page.waitForTimeout(120);
  const heading = await page.textContent('.section');
  const fields = await page.evaluate(() => ({
    laps: !!document.querySelector('#laps'),
    ai: !!document.querySelector('#ai'),
    weather: !!document.querySelector('#weather')
  }));
  const wantLaps = act === 'quick' || act === 'weekend';
  const wantAi = wantLaps || act === 'qualifying';
  check(`menu:${act} opens "${title}"`, heading.trim() === title, `got "${heading.trim()}"`);
  check(`  ${act} lap selector ${wantLaps ? 'shown' : 'hidden'}`, fields.laps === wantLaps);
  check(`  ${act} opponent selector ${wantAi ? 'shown' : 'hidden'}`, fields.ai === wantAi);
  check(`  ${act} weather selector shown`, fields.weather);
  await page.click('[data-act="back"]');
  await page.waitForTimeout(120);
}

// --- results screen: plain race vs. mid-weekend -----------------------------
const rows = [
  { id: 'a', name: 'A. Nyman', colour: '#e8503a', position: 1, classified: true, laps: 3,
    totalTime: 254.1, gapToWinner: 0, bestLap: 83.2, pitStops: 1, tireStrategy: [{ compound: 'soft' }],
    penaltySeconds: 0, positionsGained: 2, status: 'finished', fastestLap: true },
  { id: 'b', name: 'K. Sato', colour: '#3a7de8', position: 2, classified: true, laps: 3,
    totalTime: 256.4, gapToWinner: 2.3, bestLap: 83.9, pitStops: 1, tireStrategy: [{ compound: 'medium' }],
    penaltySeconds: 5, positionsGained: -1, status: 'finished' },
  { id: 'c', name: 'L. Moreau', colour: '#3ae87d', position: 3, classified: true, laps: 3,
    totalTime: 259.0, gapToWinner: 4.9, bestLap: 84.4, pitStops: 2, tireStrategy: [{ compound: 'hard' }],
    penaltySeconds: 0, positionsGained: 0, status: 'finished' }
];

const plain = await page.evaluate((classification) => {
  window.__apex.screens.show('results', { classification, selfId: 'b', fastestLap: 83.2 });
  const acts = [...document.querySelectorAll('[data-act]')].map((b) => b.dataset.act);
  return { acts, body: document.querySelector('#ui-root').textContent };
}, rows);
check('race results show the classification', plain.body.includes('K. Sato'));
check('race results offer "Race again"', plain.acts.includes('restart'));
check('race results have no next-session button', !plain.acts.includes('next'));

const weekend = await page.evaluate((classification) => {
  window.__apex.screens.show('results', {
    classification, selfId: 'b', fastestLap: 83.2,
    nextStage: 'Qualifying',
    nextStageDescription: 'One flying lap sets your place on the grid.'
  });
  const acts = [...document.querySelectorAll('[data-act]')].map((b) => b.dataset.act);
  return { acts, body: document.querySelector('#ui-root').textContent };
}, rows);
check('weekend results offer the next session', weekend.acts.includes('next'));
check('weekend results name the next session',
  weekend.body.includes('Up next: Qualifying') &&
  weekend.body.includes('One flying lap sets your place on the grid.'));
check('weekend results still allow a restart', weekend.acts.includes('restart'));

// --- the button actually reaches the weekend hand-off in main.js -----------
const dispatched = await page.evaluate(() => new Promise((resolve) => {
  const game = window.__apex;
  const original = game._handleAction.bind(game);
  let seen = null;
  game._handleAction = (screen, action) => { seen = `${screen}:${action}`; };  // intercept
  document.querySelector('[data-act="next"]').click();
  game._handleAction = original;
  resolve(seen);
}));
check('the button dispatches results:next', dispatched === 'results:next', `got ${dispatched}`);

await page.evaluate(() => window.__apex.screens.show('menu'));
await page.waitForTimeout(150);

console.log('\nconsole errors:', errors.length ? errors : 'none');
if (errors.length) failures++;
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
