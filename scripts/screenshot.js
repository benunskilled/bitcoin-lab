// Dev tooling, not part of the running app - see seed-demo-data.js for the
// full setup. Needs `npm install --no-save playwright` first; not a listed
// dependency because the running services never need a browser.
const fs = require('fs');
const { chromium } = require('playwright');

const OUT = process.env.SCREENSHOT_OUT || '/tmp/bitcoin-lab-screenshot-full.png';
// A pre-fetched Chromium (as in the sandbox this was authored in) saves a
// download; fall back to Playwright's own managed browser everywhere else.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';

// The demo database is seeded once and screenshotted whenever; the three
// worker heartbeats it writes go stale after two minutes, at which point the
// dashboard correctly reports "3 background services are not reporting in".
// That is true of a demo stack running no workers and completely false of the
// app - and it has already shipped once in a store screenshot. Refresh them
// here so the picture shows a healthy node rather than a red banner.
function refreshDemoHeartbeats() {
  if (!process.env.DATA_DIR && !process.env.SQLITE_PATH) return;
  try {
    const db = require('../src/lib/db');
    const health = require('../src/lib/health');
    db.open();
    for (const service of ['peer-profiler', 'relay-profiler', 'stratum-race']) health.write(db, service);
    db.instance.close();
  } catch (err) {
    console.warn('could not refresh demo heartbeats:', err.message);
  }
}

(async () => {
  refreshDemoHeartbeats();
  const launchOpts = fs.existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  await page.goto('http://127.0.0.1:8788/', { waitUntil: 'load', timeout: 15000 });
  await page.waitForTimeout(3000); // let the app.js polls populate the tables
  await page.screenshot({ path: OUT, fullPage: true });
  await browser.close();
  console.log('saved to', OUT);
})();
