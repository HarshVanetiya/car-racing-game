/**
 * Game-mode flow test: starts every single-player mode in a real browser and
 * then drives a race weekend from practice through to the race, checking that
 * each session is configured the way its mode requires and that the hand-off
 * between weekend stages actually works.
 */
import { chromium } from 'playwright';

const URL = process.env.APEX_URL || 'http://localhost:8080/';
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

/** Start a mode and report how the session came out. */
async function start(mode) {
  await page.evaluate(() => window.__apex.quitToMenu?.());
  await page.waitForTimeout(300);
  await page.evaluate((m) => {
    const g = window.__apex;
    g.screens.state.settings.aiCount = 3;
    g.screens.state.settings.laps = 2;
    g._pendingMode = m;
    g.startSinglePlayer(m);
  }, mode);
  await page.waitForTimeout(5000);
  return page.evaluate(() => {
    const g = window.__apex, s = g.session;
    if (!s) return null;
    const d = s.director;
    return {
      mode: g.mode, sessionType: d.sessionType, phase: d.phase,
      cars: s.vehicles.length, totalLaps: d.totalLaps, duration: d.sessionDuration,
      weekendStage: g.weekend ? g.weekend.stage.key : null
    };
  });
}

// --- every mode starts a session of the right shape ------------------------
const quick = await start('quick');
check('quick race starts a race', quick?.sessionType === 'race', JSON.stringify(quick));
check('  with the AI field on the grid', quick?.cars === 4);
check('  over the chosen distance', quick?.totalLaps === 2);
check('  behind the starting lights', quick?.phase === 'countdown');

const practice = await start('practice');
check('practice runs solo', practice?.sessionType === 'practice' && practice?.cars === 1);
check('  and is not lap limited', practice?.totalLaps > 900);
check('  and runs until the player leaves', practice?.duration === 0);

const timetrial = await start('timetrial');
check('time trial runs solo', timetrial?.sessionType === 'timeTrial' && timetrial?.cars === 1);
check('  with no countdown', timetrial?.phase === 'racing');

const qualifying = await start('qualifying');
check('qualifying runs against rivals',
  qualifying?.sessionType === 'qualifying' && qualifying?.cars === 4);
check('  on a session clock', qualifying?.duration > 0,
  `duration ${qualifying?.duration}`);
check('  and is not lap limited', qualifying?.totalLaps > 900);

const weekend = await start('weekend');
check('a weekend opens with practice',
  weekend?.weekendStage === 'practice' && weekend?.sessionType === 'practice');
check('  on a session clock', weekend?.duration > 0);

// --- the weekend runs through all three of its sessions --------------------
/** End the running session on the clock, the way the game itself would. */
async function endSession() {
  await page.evaluate(() => {
    const d = window.__apex.session.director;
    d.drivers.forEach((e, i) => { e.timing.bestLap = 84 + i * 0.55; });
    d.sessionDuration = d.raceTime + 0.2;
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const d = window.__apex.session.director;
    d.drivers.forEach((e) => { if (e.flagLap != null) e.lap = e.flagLap + 1; });
  });
  await page.waitForTimeout(1500);
  return page.evaluate(() => ({
    screen: window.__apex.screens.current,
    acts: [...document.querySelectorAll('[data-act]')].map((b) => b.dataset.act),
    text: document.querySelector('#screens').textContent.replace(/\s+/g, ' ')
  }));
}

const expected = [
  { stage: 'practice', type: 'practice', next: 'Qualifying' },
  { stage: 'qualifying', type: 'qualifying', next: 'Race' }
];

for (const step of expected) {
  const state = await page.evaluate(() => ({
    stage: window.__apex.weekend.stage.key,
    type: window.__apex.session.director.sessionType
  }));
  check(`weekend stage is ${step.stage}`,
    state.stage === step.stage && state.type === step.type, JSON.stringify(state));

  const results = await endSession();
  check(`  ${step.stage} ends on the results screen`, results.screen === 'results');
  check(`  and offers ${step.next}`,
    results.acts.includes('next') && results.text.includes(`Up next: ${step.next}`));

  await page.click('[data-act="next"]');
  await page.waitForTimeout(2500);
}

const race = await page.evaluate(() => ({
  stage: window.__apex.weekend.stage.key,
  type: window.__apex.session.director.sessionType,
  cars: window.__apex.session.vehicles.length,
  laps: window.__apex.session.director.totalLaps,
  grid: window.__apex.weekend.grid
}));
check('the weekend finishes with the race',
  race.stage === 'race' && race.type === 'race', JSON.stringify(race));
check('  over the chosen distance', race.laps === 2);
check('  with the qualifying field on the grid', race.cars === 4);
check('  and a grid set by qualifying', Array.isArray(race.grid) && race.grid.length === 4,
  `grid ${JSON.stringify(race.grid)}`);

console.log('\nconsole errors:', errors.length ? errors : 'none');
if (errors.length) failures++;
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
