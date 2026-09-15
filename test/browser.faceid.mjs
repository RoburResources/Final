/**
 * Drives the real UI in a real browser with a virtual platform authenticator,
 * so the whole Face ID path runs exactly as it will on the phone: the lock
 * screen, navigator.credentials, the server's ceremony, the unlocked console.
 *
 * Not part of `npm test`, because it needs Playwright and a Chromium:
 *
 *     npm install --no-save playwright && npx playwright install chromium
 *     npm run test:browser
 *
 * The host must be `localhost`, not 127.0.0.1: WebAuthn refuses an IP address
 * as a relying party ID, so an IP-based test fails for a reason the real
 * deployment will never hit.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.TALKBACK_SHOTS || path.join(os.tmpdir(), 'talkback-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const PORT = 3128, BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-faceid-'));
const server = spawn('node', ['server.js'], { cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TALKBACK_DATA_DIR: dir, TALKBACK_CLAIM_CODE: 'kettle-42' },
  stdio: ['ignore','ignore','ignore'] });
for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/api/state'); break; } catch { await new Promise(r=>setTimeout(r,100)); } }

let pass = 0, fail = 0;
const check = (n, ok, d) => ok ? (pass++, console.log(`  ok   ${n}`))
                               : (fail++, console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`));

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => m.type() === 'error' && errors.push('console: ' + m.text()));

// A virtual Face ID: internal transport, user verification on.
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
             hasUserVerification: true, isUserVerified: true,
             automaticPresenceSimulation: true },
});

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('button.btn');

  check('the lock screen offers setup', (await page.locator('button.btn').textContent()) === 'Set Up Face ID');
  check('the setup code is asked for', await page.locator('input.codefield').isVisible());
  check('setup is blocked until a code is entered', await page.locator('button.btn').isDisabled());
  await page.screenshot({ path: path.join(SHOTS, '1-lock.png') });

  // Wrong code first.
  await page.fill('input.codefield', 'not-the-code');
  await page.click('button.btn');
  await page.waitForSelector('.notice--bad');
  check('a wrong setup code is rejected in the UI',
    /Wrong setup code/.test(await page.locator('.notice--bad').first().textContent()),
    await page.locator('.notice--bad').first().textContent());

  // Right code: a real enrolment through navigator.credentials.create.
  await page.fill('input.codefield', 'kettle-42');
  await page.click('button.btn');
  await page.waitForSelector('.dock', { timeout: 15000 });
  check('the right code plus Face ID unlocks the line', await page.locator('.dock').isVisible());
  check('the voice console rendered', await page.locator('canvas.orb').isVisible());
  await page.screenshot({ path: path.join(SHOTS, '2-console.png') });

  const state = await page.evaluate(async () => (await (await fetch('/api/state')).json()));
  check('the server now considers it claimed and signed in',
    state.claimed === true && state.signedIn === true, JSON.stringify(state));

  // Lock, then unlock again — the verify ceremony, not the create one.
  const lockBtn = page.locator('button[title="Lock"], button[aria-label="Lock"]');
  if (await lockBtn.count()) { await lockBtn.first().click(); }
  else { await page.evaluate(() => fetch('/api/lock', { method: 'POST' })); await page.reload({ waitUntil: 'networkidle' }); }
  await page.waitForSelector('button.btn', { timeout: 15000 });
  check('locking returns to the lock screen',
    (await page.locator('button.btn').textContent()) === 'Unlock with Face ID',
    await page.locator('button.btn').textContent());
  check('no setup code is asked for once claimed',
    !(await page.locator('input.codefield').isVisible()));
  await page.screenshot({ path: path.join(SHOTS, '3-unlock.png') });

  await page.click('button.btn');
  await page.waitForSelector('.dock', { timeout: 15000 });
  check('Face ID unlocks it again', await page.locator('.dock').isVisible());

  // The two sheets.
  await page.locator('.bar .navbtn').first().click();
  await page.waitForTimeout(500);
  check('the transcript sheet opens', await page.locator('.sheet.open').isVisible());
  await page.screenshot({ path: path.join(SHOTS, '4-transcript.png') });
  await page.locator('.sheet.open .sheet__head .navbtn[aria-label="Close"]').click();
  await page.waitForTimeout(500);

  await page.locator('.bar .navbtn').last().click();
  await page.waitForTimeout(500);
  check('the settings sheet opens', await page.locator('.sheet.open').isVisible());
  check('settings offers a way to lock the device',
    await page.locator('.btn--destructive').isVisible());
  await page.screenshot({ path: path.join(SHOTS, '5-settings.png') });
  await page.locator('.sheet.open .sheet__head .navbtn[aria-label="Close"]').click();
  await page.waitForTimeout(500);

  // Dark mode, for the screenshot record.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, '6-console-dark.png') });

  // Chrome logs any non-2xx fetch as a console error; the 403 below is the
  // deliberate wrong-code attempt being correctly refused.
  const unexpected = errors.filter((e) => !/403 \(Forbidden\)/.test(e));
  check('no unexpected JavaScript errors anywhere in that flow', unexpected.length === 0,
    unexpected.join(' | '));
} catch (e) {
  fail++; console.log(`  FAIL harness — ${e?.message?.split('\n')[0]}`);
  console.log('  page notice:', await page.locator('.notice').allTextContents().catch(() => []));
  console.log('  page hint:', await page.locator('.lock__hint').textContent().catch(() => ''));
  console.log('  page errors:', errors);
  await page.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {});
} finally {
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => {});
  await browser.close(); server.kill(); fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
