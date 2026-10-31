// Chrome can run new extension code under permissions granted for an older
// manifest. The worker must survive that: if its top level throws, gaze relay and
// sign-in all die together. Loads the current code with the newer permissions removed.
import { chromium } from 'playwright';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'nungil-upgrade-'));
const ext = join(work, 'ext');
cpSync(join(root, 'extension'), ext, { recursive: true, filter: (p) => !p.includes('/wasm') });
const manifestPath = join(ext, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.permissions = manifest.permissions.filter((p) => !['webNavigation', 'tts'].includes(p));
writeFileSync(manifestPath, JSON.stringify(manifest));

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

async function until(fn, label, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${label}`);
}

let failed = false;
try {
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  assert.strictEqual(await sw.evaluate(() => Boolean(chrome.webNavigation)), false, 'test setup: permission must be missing');
  await sw.evaluate(() => chrome.storage.local.set({ onboardingDone: true }));
  const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup.html`;
  // Stands in for the real reload, which would end this test's extension.
  await context.addInitScript(() => {
    if (globalThis.chrome?.runtime?.reload) chrome.runtime.reload = () => { globalThis.__reloaded = true; };
  });

  const healing = await context.newPage();
  await healing.goto(popupUrl);
  await until(() => healing.evaluate(() => globalThis.__reloaded === true), 'popup reloads the extension to pick up permissions');
  await healing.close();
  console.log('PASS opening the popup reloads an extension missing its permissions');

  // Once per minute only, so a reload that doesn't help can't become a loop.
  const again = await context.newPage();
  await again.goto(popupUrl);
  await again.waitForTimeout(800);
  assert.strictEqual(await again.evaluate(() => globalThis.__reloaded === true), false, 'no reload loop');
  await again.close();
  console.log('PASS self-heal never loops');

  const popup = await context.newPage();
  await popup.goto(popupUrl);
  const opened = context.waitForEvent('page', { timeout: 8000 });
  await popup.click('#codex');
  const tab = await opened;
  await until(async () => /chrome:\/\/extensions/.test(await tab.textContent('#message').catch(() => '')), 'sign-in explains the reload');
  console.log('PASS worker survives missing permissions, and sign-in explains the reload');
} catch (error) {
  failed = true;
  console.log(`FAIL ${error.message}`);
} finally {
  await context.close();
  rmSync(work, { recursive: true, force: true });
}
if (failed) process.exit(1);
