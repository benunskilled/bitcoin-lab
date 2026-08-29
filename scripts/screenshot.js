// Dev tooling, not part of the running app - see seed-demo-data.js for the
// full setup. Needs `npm install --no-save playwright` first; not a listed
// dependency because the running services never need a browser.
const fs = require('fs');
const { chromium } = require('playwright');

const OUT = process.env.SCREENSHOT_OUT || '/tmp/bitcoin-lab-screenshot-full.png';
// A pre-fetched Chromium (as in the sandbox this was authored in) saves a
// download; fall back to Playwright's own managed browser everywhere else.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';

(async () => {
  const launchOpts = fs.existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  await page.goto('http://127.0.0.1:8788/', { waitUntil: 'load', timeout: 15000 });
  await page.waitForTimeout(3000); // let the app.js polls populate the tables
  await page.screenshot({ path: OUT, fullPage: true });
  await browser.close();
  console.log('saved to', OUT);
})();
