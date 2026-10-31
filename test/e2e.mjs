// End-to-end smoke test in Chromium with the real extension loaded. A still face
// photo is the fake webcam, so MediaPipe runs for real. Gaze frames are injected
// because a photo can't look around. Speech recognition needs real Chrome, so
// recognised commands are injected too.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert';

const root = resolve(import.meta.dirname, '..');
const extension = join(root, 'extension');
const work = mkdtempSync(join(tmpdir(), 'nungil-'));

// Chrome's fake camera reads Y4M: decode the photo to BMP, convert to I420.
function photoToY4m(photo, out, width, height) {
  const bmpPath = join(work, 'face.bmp');
  execFileSync('sips', ['-s', 'format', 'bmp', '-z', String(height), String(width), photo, '--out', bmpPath], { stdio: 'ignore' });
  const bmp = readFileSync(bmpPath);
  const dataStart = bmp.readUInt32LE(10);
  const bytes = bmp.readUInt16LE(28) / 8;
  const stored = bmp.readInt32LE(22);
  const stride = Math.ceil((width * bytes) / 4) * 4;
  const rgb = (x, y) => {
    const row = stored > 0 ? height - 1 - y : y;
    const o = dataStart + row * stride + x * bytes;
    return [bmp[o + 2], bmp[o + 1], bmp[o]];
  };
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const frame = Buffer.alloc((width * height * 3) / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y);
      frame[y * width + x] = clamp(0.257 * r + 0.504 * g + 0.098 * b + 16);
      if (x % 2 === 0 && y % 2 === 0) {
        const c = width * height + (y / 2) * (width / 2) + x / 2;
        frame[c] = clamp(-0.148 * r - 0.291 * g + 0.439 * b + 128);
        frame[c + (width * height) / 4] = clamp(0.439 * r - 0.368 * g - 0.071 * b + 128);
      }
    }
  }
  const marker = Buffer.from('FRAME\n');
  writeFileSync(out, Buffer.concat([
    Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420\n`),
    ...Array(5).fill(0).flatMap(() => [marker, frame]),
  ]));
}
const y4m = join(work, 'face.y4m');
photoToY4m(join(root, 'test/fixtures/portrait.jpg'), y4m, 640, 800);

const server = createServer((_, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(readFileSync(join(root, 'test/fixtures/page.html')));
}).listen(0);
const pageUrl = `http://localhost:${server.address().port}/`;

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
  ],
});

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}\n     ${error.message}`);
  }
}
async function until(fn, label, ms = 30000) {
  const start = Date.now();
  let value;
  while (Date.now() - start < ms) {
    value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${label} (last: ${JSON.stringify(value)})`);
}

try {
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await check('a fresh install opens the guided start, not settings', async () => {
    const opened = await until(() => context.pages().find((p) => p.url().includes('calibrate.html?onboarding=1')), 'onboarding tab', 8000);
    await opened.close();
  });
  await sw.evaluate(() => chrome.storage.local.set({ onboardingDone: true }));

  const page = await context.newPage();
  page.on('pageerror', (e) => results.push(`PAGE ERROR ${e.message}`));
  await page.goto(pageUrl);
  await page.bringToFront();

  const status = () => sw.evaluate(async () => (await chrome.storage.session.get('status')).status ?? null);
  const setSettings = (patch) => sw.evaluate(async (p) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...NUNGIL_DEFAULTS, ...settings, ...p } });
    // Most tests aren't about the realignment that follows turning back on.
    if (p.enabled) {
      await new Promise((r) => setTimeout(r, 150));
      await chrome.storage.local.remove('needsRecenter');
    }
  }, patch);

  await check('tracker starts: camera on, model loaded, real face detected', async () => {
    await setSettings({ enabled: true });
    let seen = null;
    const s = await until(async () => {
      seen = await status();
      return seen?.camera && seen?.tracker && seen?.face ? seen : null;
    }, 'camera + tracker + face', 45000).catch((error) => {
      throw new Error(`${error.message} status=${JSON.stringify(seen)}`);
    });
    assert.strictEqual(s.camera, 'on');
    assert.ok(!String(s.tracker).startsWith('error'), s.tracker);
    results.push(`INFO delegate=${s.tracker} voice=${s.voice ?? 'none'}`);
  });

  await check('offscreen produces plausible features from the face', async () => {
    const offscreenUrl = (await sw.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })))[0]?.documentUrl;
    assert.ok(offscreenUrl?.includes('offscreen.html'), `no offscreen doc: ${offscreenUrl}`);
    const frame = await sw.evaluate(() => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('no frame in 15s')), 15000);
      chrome.runtime.onMessage.addListener(function on(m) {
        if (m.type === 'frame' && m.face) { clearTimeout(timer); chrome.runtime.onMessage.removeListener(on); res(m); }
      });
    }));
    assert.strictEqual(frame.features.length, 9);
    assert.ok(frame.features.every(Number.isFinite), JSON.stringify(frame.features));
    assert.ok(Math.abs(frame.features[0]) < 0.3, `ex=${frame.features[0]}`);
    assert.ok(frame.features[6] < 0, `tz=${frame.features[6]}`);
    results.push(`INFO features=${frame.features.map((v) => v.toFixed(3)).join(',')} blink=${frame.blink}`);
  });

  // A model whose output is simply head position x and y as screen pixels,
  // so tests can aim gaze by sending coordinates.
  await sw.evaluate(() => chrome.storage.local.set({
    model: {
      mean: [0, 0, 0, 0],
      wx: [0, 5, 0, 0, 0, 0, 0, 0],
      wy: [0, 0, 5, 0, 0, 0, 0, 0],
      errorPx: 100,
      version: 5,
    },
  }));
  // Stop the real tracker's frames from fighting the injected ones.
  await sw.evaluate(() => chrome.offscreen.closeDocument());

  const offset = await page.evaluate(() => ({
    x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
    y: window.screenY + (window.outerHeight - window.innerHeight),
  }));
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  const lookAt = async (selector, durationMs = 500) => {
    const box = await page.locator(selector).boundingBox();
    const x = box.x + box.width / 2 + offset.x, y = box.y + box.height / 2 + offset.y;
    const end = Date.now() + durationMs;
    while (Date.now() < end) {
      await sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, [0, 0, 0, 0, x, y, -40]]);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  const say = (command, transcript = 'x') => sw.evaluate(([id, c, t]) => chrome.tabs.sendMessage(id, { type: 'command', command: c, transcript: t }), [tabId, command, transcript]);
  const clicks = () => page.evaluate(() => JSON.parse(document.getElementById('log').textContent || '{"a":0,"b":0,"pay":0}'));
  const boxStyle = () => page.evaluate(() => {
    const b = document.getElementById('__nungil-host').shadowRoot.querySelector('.box');
    return { display: getComputedStyle(b).display, left: parseFloat(b.style.left), top: parseFloat(b.style.top), width: parseFloat(b.style.width) };
  });

  await check('dwell click is off by default, and there is no moving pointer', async () => {
    assert.strictEqual(await sw.evaluate(() => NUNGIL_DEFAULTS.dwell), false);
    assert.strictEqual(await page.evaluate(() => document.getElementById('__nungil-host').shadowRoot.querySelector('.cursor')), null);
  });
  await setSettings({ dwell: false });
  await page.waitForTimeout(100);

  await check('gaze highlights the element under it, and snaps from nearby', async () => {
    await lookAt('#b', 800);
    const b = await page.locator('#b').boundingBox();
    const box = await boxStyle();
    assert.strictEqual(box.display, 'block');
    assert.ok(Math.abs(box.left - (b.x - 4)) < 3, `box.left=${box.left} b.x=${b.x}`);
  });

  await check('voice "click" clicks the gazed element exactly once', async () => {
    await say({ name: 'click' });
    await until(async () => (await clicks()).b === 1, 'b clicked');
    await page.waitForTimeout(200);
    assert.deepStrictEqual(await clicks(), { a: 0, b: 1, pay: 0 });
  });

  await check('the countdown only starts 0.5s after looking, and clicks after it finishes', async () => {
    await setSettings({ dwell: true, dwellMs: 800 });
    await page.waitForTimeout(1600);
    await lookAt('#link', 1200); // settle elsewhere, so the highlight has to switch
    await page.evaluate(() => { location.hash = ''; });
    const box = await page.locator('#b').boundingBox();
    const f = [0, 0, 0, 0, box.x + box.width / 2 + offset.x, box.y + box.height / 2 + offset.y, -40];
    const before = await clicks();
    const ringShown = () => page.evaluate(() => getComputedStyle(document.getElementById('__nungil-host').shadowRoot.querySelector('.ring')).display === 'block');
    let highlightedAt = null, ringAt = null, clickedAt = null;
    const end = Date.now() + 5000;
    while (Date.now() < end && !clickedAt) {
      await sw.evaluate(([id, g]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: g }), [tabId, f]);
      const drawn = await boxStyle();
      if (!highlightedAt && drawn.display === 'block' && Math.abs(drawn.left - (box.x - 4)) < 3) highlightedAt = Date.now();
      if (highlightedAt && !ringAt && await ringShown()) ringAt = Date.now();
      if ((await clicks()).b > before.b) clickedAt = Date.now();
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(highlightedAt && ringAt && clickedAt, JSON.stringify({ highlightedAt, ringAt, clickedAt }));
    assert.ok(ringAt - highlightedAt >= 400, `ring after ${ringAt - highlightedAt}ms`);
    assert.ok(clickedAt - ringAt >= 600, `clicked ${clickedAt - ringAt}ms after the ring`);
    await setSettings({ dwell: false });
  });

  await check('dwell clicks after holding gaze', async () => {
    await setSettings({ dwell: true, dwellMs: 800 });
    await lookAt('#a', 3500);
    assert.ok((await clicks()).a >= 1, JSON.stringify(await clicks()));
  });

  await check('eyes shut or face gone restarts the dwell instead of clicking on return', async () => {
    await new Promise((r) => setTimeout(r, 1600)); // let the click cooldown pass
    await lookAt('#b', 300);
    const box = await page.locator('#b').boundingBox();
    const f = [0, 0, 0, 0, box.x + box.width / 2 + offset.x, box.y + box.height / 2 + offset.y, -40];
    const send = (extra) => sw.evaluate(([id, features, e]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features, ...e }), [tabId, f, extra]);
    const before = await clicks();
    for (const extra of [{ blink: true }, { face: false }]) {
      const end = Date.now() + 1200;
      while (Date.now() < end) {
        await send(extra);
        await new Promise((r) => setTimeout(r, 40));
      }
      for (let i = 0; i < 3; i++) {
        await send({});
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.deepStrictEqual(await clicks(), before, JSON.stringify(extra));
      await lookAt('#a', 100);
      await lookAt('#b', 200);
    }
  });

  await check('a normal blink does not interrupt a dwell', async () => {
    await new Promise((r) => setTimeout(r, 300));
    await lookAt('#a', 300);
    const box = await page.locator('#b').boundingBox();
    const f = [0, 0, 0, 0, box.x + box.width / 2 + offset.x, box.y + box.height / 2 + offset.y, -40];
    const send = (blink) => sw.evaluate(([id, features, b]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: b, features }), [tabId, f, blink]);
    const before = await clicks();
    const end = Date.now() + 2300;
    let i = 0;
    while (Date.now() < end) {
      await send(i++ % 10 < 2); // two closed frames out of every ten
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok((await clicks()).b > before.b, JSON.stringify(await clicks()));
  });

  await check('dwell never clicks a risky button, but voice can', async () => {
    await lookAt('#pay', 2000);
    assert.strictEqual((await clicks()).pay, 0);
    await say({ name: 'click' });
    await until(async () => (await clicks()).pay === 1, 'pay clicked by voice');
    await setSettings({ dwell: false });
  });

  await check('numbers: badges appear, saying a number clicks that element', async () => {
    await new Promise((r) => setTimeout(r, 1000)); // let gaze go stale so numbering covers the page
    await say({ name: 'numbers' });
    const count = await page.evaluate(() => document.getElementById('__nungil-host').shadowRoot.querySelectorAll('.badge').length);
    assert.ok(count >= 4, `badges=${count}`);
    const before = await clicks();
    await say({ name: 'number', n: 1 });
    await until(async () => (await clicks()).a === before.a + 1, 'badge 1 clicks A');
  });

  await check('bare number with no badges does nothing', async () => {
    const before = await clicks();
    await say({ name: 'number', n: 1 });
    await page.waitForTimeout(200);
    assert.deepStrictEqual(await clicks(), before);
  });

  await check('type command fills the field', async () => {
    await page.locator('#field').focus();
    await say({ name: 'type', text: '안녕하세요' });
    await until(async () => (await page.inputValue('#field')) === '안녕하세요', 'text typed');
  });

  await check('scroll down moves the page', async () => {
    await page.locator('#field').blur();
    await say({ name: 'down' });
    await until(() => page.evaluate(() => scrollY > 100), 'scrolled');
    await say({ name: 'top' });
    await until(() => page.evaluate(() => scrollY === 0), 'back at top');
  });

  await check('pause blocks clicks until resume', async () => {
    await lookAt('#b', 600);
    await say({ name: 'pause' });
    const before = await clicks();
    await say({ name: 'click' });
    await page.waitForTimeout(200);
    assert.deepStrictEqual(await clicks(), before);
    await say({ name: 'resume' });
    await lookAt('#b', 600);
    await say({ name: 'click' });
    await until(async () => (await clicks()).b === before.b + 1, 'click after resume');
  });

  const face = (extra, x = 500, y = 500) => sw.evaluate(([id, e, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f, ...e }), [tabId, extra, [0, 0, 0, 0, x, y, -40]]);
  const hold = async (extra, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await face(extra);
      await new Promise((r) => setTimeout(r, 40));
    }
    for (let i = 0; i < 4; i++) {
      await face({});
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  await check('open mouth scrolls down and keeps going, and does not pause', async () => {
    await page.evaluate(() => scrollTo(0, 0));
    await hold({ mouthOpen: true }, 1100);
    await until(() => page.evaluate(() => scrollY > 100), 'scrolled once');
    const first = await page.evaluate(() => scrollY);
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await hold({ mouthOpen: true }, 2300);
    await until(() => page.evaluate((f) => scrollY > f * 1.5, first), 'held mouth scrolls repeatedly');
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(600);
    await lookAt('#b', 800);
    const before = await clicks();
    await say({ name: 'click' });
    await until(async () => (await clicks()).b === before.b + 1, 'still not paused');
  });

  await check('highlight holds still under noise, and moves when the gaze really leaves', async () => {
    await lookAt('#b', 800);
    const home = await boxStyle();
    const box = await page.locator('#b').boundingBox();
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const jitter = [-90, 80, -60, 95, -75, 70][i % 6];
      await sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, [0, 0, 0, 0, box.x + box.width / 2 + offset.x + jitter, box.y + box.height / 2 + offset.y + jitter / 2, -40]]);
      seen.add(Math.round((await boxStyle()).left));
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.deepStrictEqual([...seen], [Math.round(home.left)], 'never moved');
    await lookAt('#link', 1500);
    const moved = await boxStyle();
    const link = await page.locator('#link').boundingBox();
    assert.ok(Math.abs(moved.left - (link.x - 4)) < 3, `moved to link: ${moved.left} vs ${link.x}`);
  });

  await check('head flick: moves to the neighbour that way, and stays there', async () => {
    await lookAt('#b', 900);
    const box = await page.locator('#b').boundingBox();
    const gazeX = box.x + box.width / 2 + offset.x, gazeY = box.y + box.height / 2 + offset.y;
    const send = (yaw, pitch) => sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, [0, 0, yaw, pitch, gazeX, gazeY, -40]]);
    const flick = async (yaw, pitch) => {
      for (const k of [0, 0, 0, 0, 0, 0, 0.6, 1, 1, 0.5, 0, 0, 0]) {
        await send(yaw * k, pitch * k);
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    const highlightOn = async (selector) => {
      const b = await page.locator(selector).boundingBox();
      return Math.abs((await boxStyle()).left - (b.x - 4)) < 3;
    };
    await sw.evaluate(() => chrome.storage.local.remove('gazeBias'));
    await flick(-0.14, 0); // the user's right is the camera's left
    assert.ok(await highlightOn('#link'), JSON.stringify(await boxStyle()));
    for (let i = 0; i < 25; i++) {
      await send(0, 0);
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(await highlightOn('#link'), 'gaze still near B must not pull it back');
    await page.waitForTimeout(800); // cooldown
    await flick(0.14, 0);
    assert.ok(await highlightOn('#b'), `back to B: ${JSON.stringify(await boxStyle())}`);
    await page.waitForTimeout(800);
    await flick(0, -0.1); // a lower pitch value is up
    assert.ok(await highlightOn('#a'), `up to A: ${JSON.stringify(await boxStyle())}`);
    await sw.evaluate(() => chrome.storage.local.remove('gazeBias'));
    await page.waitForTimeout(100);
  });

  await check('gaze input stops while the head moves, whatever the eyes seem to say', async () => {
    await lookAt('#b', 900);
    const before = await boxStyle();
    const box = await page.locator('#b').boundingBox();
    const x = box.x + box.width / 2 + offset.x, y = box.y + box.height / 2 + offset.y;
    const send = (yaw, gazeX) => sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, [0, 0, yaw, 0, gazeX, y, -40]]);
    await sw.evaluate(() => chrome.storage.local.set({ settings: { ...NUNGIL_DEFAULTS, enabled: true, dwell: false, flick: false } }));
    await page.waitForTimeout(100);
    for (let i = 0; i < 6; i++) { await send(0, x); await new Promise((r) => setTimeout(r, 40)); }
    // A wild gaze reading the moment the head starts moving, far over the link.
    const link = await page.locator('#link').boundingBox();
    for (const k of [0.6, 1, 1, 1, 0.6, 0.2, 0]) {
      await send(0.14 * k, link.x + offset.x + 10);
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.strictEqual((await boxStyle()).left, before.left, 'highlight did not chase the error');
    await sw.evaluate(() => chrome.storage.local.set({ settings: { ...NUNGIL_DEFAULTS, enabled: true, dwell: false } }));
    await page.waitForTimeout(600);
    await lookAt('#link', 1500);
    assert.notStrictEqual((await boxStyle()).left, before.left, 'gaze works again once the head settles');
  });

  await check('only pressable items highlight: a section wrapping a button never does', async () => {
    await lookAt('#section', 1000);
    const inner = await page.locator('#inner').boundingBox();
    const drawn = await boxStyle();
    assert.ok(Math.abs(drawn.width - (inner.width + 8)) < 3, `box fits the button, width ${drawn.width} vs ${inner.width}`);
  });

  await check('"click 5" picks a labelled item directly', async () => {
    await new Promise((r) => setTimeout(r, 1000));
    await say({ name: 'numbers' });
    const before = await clicks();
    await say({ name: 'number', n: 1 });
    await until(async () => (await clicks()).a === before.a + 1, 'labelled item clicked');
  });

  const readerState = () => page.evaluate(() => {
    const r = document.getElementById('__nungil-host').shadowRoot.querySelector('.reader');
    return { display: getComputedStyle(r).display, text: r.textContent, current: r.querySelector('.current')?.textContent ?? null, mark: r.querySelector('mark')?.textContent ?? null };
  });

  await check('simplify shows the article only, without page links or speech', async () => {
    await say({ name: 'simplify' });
    const r = await readerState();
    assert.strictEqual(r.display, 'block');
    assert.ok(r.text.includes('첫 번째 문단'), r.text);
    assert.ok(!r.text.includes('A 버튼'), r.text);
    assert.strictEqual(r.current, null);
  });

  await check('page underneath the reader cannot be clicked by gaze', async () => {
    const before = await clicks();
    await lookAt('#a', 600);
    await say({ name: 'click' });
    await page.waitForTimeout(200);
    assert.deepStrictEqual(await clicks(), before);
  });

  await check('reading highlights the word and advances to the next paragraph', async () => {
    const spoken = await sw.evaluate(() => {
      globalThis.__spoken = [];
      chrome.tts.speak = (text, options) => { globalThis.__spoken.push({ text, options }); };
      return true;
    });
    assert.ok(spoken);
    await say({ name: 'read' });
    await until(() => sw.evaluate(() => globalThis.__spoken.length === 1), 'first paragraph sent to tts');
    const fire = (index, event) => sw.evaluate(([i, e]) => globalThis.__spoken[i].options.onEvent(e), [index, event]);
    await fire(0, { type: 'word', charIndex: 0, length: 2 });
    await until(async () => (await readerState()).mark === '기사', 'word highlighted');
    await fire(0, { type: 'end' });
    await until(() => sw.evaluate(() => globalThis.__spoken.length === 2), 'advanced to next paragraph');
    assert.ok((await readerState()).current.includes('첫 번째'));
  });

  await check('"그만" closes the reader and stops speech', async () => {
    await sw.evaluate(() => {
      globalThis.__stopped = 0;
      chrome.tts.stop = () => { globalThis.__stopped++; };
    });
    await say({ name: 'hide' });
    await until(async () => (await readerState()).display === 'none', 'reader closed');
    await until(() => sw.evaluate(() => globalThis.__stopped === 1), 'tts stopped');
  });

  await check('summary without sign-in explains how to sign in', async () => {
    await say({ name: 'summarize' });
    await until(() => page.evaluate(() => document.getElementById('__nungil-host').shadowRoot.querySelector('.toast').textContent.includes('로그인')), 'sign-in hint');
    assert.strictEqual((await readerState()).display, 'none');
  });

  await check('ChatGPT sign-in: popup opens login, callback is redeemed, forged state is refused', async () => {
    const jwt = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } })).toString('base64url')}.y`;
    await sw.evaluate((token) => {
      globalThis.__realFetch ??= fetch;
      globalThis.__calls = [];
      globalThis.fetch = async (url, init) => {
        globalThis.__calls.push({ url: String(url), body: String(init?.body ?? ''), headers: init?.headers });
        if (String(url).includes('/oauth/token')) return Response.json({ access_token: token, refresh_token: 'R', expires_in: 3600 });
        if (String(url).includes('/codex/responses')) {
          const e = (d) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: d })}\n\n`;
          const reply = globalThis.__aiReply ?? ['첫 번째 요약 문장입니다.\n', '두 번째 요약 문장입니다.'];
          return new Response(reply.map(e).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        return globalThis.__realFetch(url, init);
      };
    }, jwt);
    await context.route('https://auth.openai.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'login' }));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
    await popup.waitForTimeout(500);
    assert.strictEqual(await sw.evaluate(async () => (await chrome.storage.local.get('selfHealAt')).selfHealAt), undefined, 'a healthy extension is not reloaded');

    const login = async () => {
      const [tab] = await Promise.all([context.waitForEvent('page'), popup.click('#codex')]);
      const pending = await until(() => sw.evaluate(async () => (await chrome.storage.session.get('oauth:pending'))['oauth:pending']), 'pending login');
      assert.ok(tab.url().startsWith('https://auth.openai.com/oauth/authorize'), tab.url());
      assert.ok(tab.url().includes(`state=${pending.state}`));
      return { tab, pending };
    };

    const forged = await login();
    await forged.tab.goto('http://localhost:1455/auth/callback?code=EVIL&state=WRONG').catch(() => {});
    await until(() => /signin\.html\?error=state_mismatch/.test(forged.tab.url()), 'forged callback lands on error page');
    const stored = await sw.evaluate(async () => chrome.storage.local.get(['oauth:chatgpt']));
    assert.strictEqual(stored['oauth:chatgpt'], undefined, 'forged callback must not sign in');
    assert.ok(!(await sw.evaluate(() => globalThis.__calls.some((c) => c.body.includes('EVIL')))), 'forged code never redeemed');
    await forged.tab.close();

    const real = await login();
    await real.tab.goto(`http://localhost:1455/auth/callback?code=GOOD&state=${real.pending.state}`).catch(() => {});
    await until(() => /signin\.html/.test(real.tab.url()), 'callback lands on signin page');
    await until(async () => (await real.tab.textContent('#title')).includes('완료'), 'signed in page');
    const call = await sw.evaluate(() => globalThis.__calls.find((c) => c.url.includes('/oauth/token')));
    assert.ok(call.body.includes('code=GOOD'));
    assert.ok(call.body.includes(`code_verifier=${real.pending.verifier}`));
    await real.tab.close();
    await until(async () => (await popup.textContent('#codex')).includes('로그아웃'), 'popup shows logout');
    await popup.close();
    await page.bringToFront();
  });

  await check('"요약해줘" sends the article, shows the summary, and reads it aloud', async () => {
    await sw.evaluate(() => { globalThis.__spoken = []; globalThis.__calls = []; });
    await say({ name: 'summarize' });
    await until(async () => (await readerState()).text.includes('두 번째 요약 문장'), 'summary shown');
    const request = await sw.evaluate(() => globalThis.__calls.find((c) => c.url.includes('/codex/responses')));
    assert.ok(request.body.includes('첫 번째 문단은'), 'article text sent');
    assert.strictEqual(request.headers['chatgpt-account-id'], 'acct_1');
    await until(() => sw.evaluate(() => globalThis.__spoken[0]?.text === '첫 번째 요약 문장입니다.'), 'first sentence read aloud');
    await say({ name: 'hide' });
  });

  const aiRequest = () => sw.evaluate(() => globalThis.__calls.filter((c) => c.url.includes('/codex/responses')).at(-1));
  const setReply = (reply) => sw.evaluate((r) => { globalThis.__aiReply = r; globalThis.__calls = []; }, reply);
  // Reply for "pick this element": finds its index from the labels actually sent.
  const replyPicking = (labels) => sw.evaluate((wanted) => {
    globalThis.__calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/codex/responses')) {
        const text = JSON.parse(init.body).input[0].content[0].text;
        const lines = text.split('\n').filter((l) => /^\d+: /.test(l));
        const matches = wanted.map((w) => lines.findIndex((l) => l.includes(w)));
        globalThis.__aiReply = [JSON.stringify({ matches })];
      }
      return real(url, init);
    };
    globalThis.__restoreFetch = () => { globalThis.fetch = real; };
  }, labels);
  const badges = () => page.evaluate(() => document.getElementById('__nungil-host').shadowRoot.querySelectorAll('.badge').length);

  await check('simplify shows the original at once, then swaps in easy wording, without speaking', async () => {
    await setReply(['쉬운 말 첫 문단입니다.\n', '쉬운 말 둘째 문단입니다.']);
    await sw.evaluate(() => { globalThis.__spoken = []; });
    await say({ name: 'simplify' });
    await until(async () => (await readerState()).text.includes('쉬운 말 둘째 문단'), 'easy wording shown');
    assert.ok(!(await readerState()).text.includes('첫 번째 문단은'), 'original replaced');
    assert.ok((await aiRequest()).body.includes('첫 번째 문단은'), 'article sent');
    await page.waitForTimeout(200);
    assert.strictEqual(await sw.evaluate(() => globalThis.__spoken.length), 0);
    await say({ name: 'hide' });
  });

  await check('simplify keeps the original when the AI fails', async () => {
    await sw.evaluate(() => {
      globalThis.__beforeFail = globalThis.fetch;
      globalThis.fetch = async () => new Response('nope', { status: 500 });
    });
    await say({ name: 'simplify' });
    await until(() => page.evaluate(() => document.getElementById('__nungil-host').shadowRoot.querySelector('.toast').textContent.includes('http_500')), 'error shown');
    assert.ok((await readerState()).text.includes('첫 번째 문단은'), 'original still readable');
    await say({ name: 'hide' });
    await sw.evaluate(() => { globalThis.fetch = globalThis.__beforeFail; });
  });

  await check('"B 버튼 눌러줘" finds and clicks the item, and sends labels but no typed text', async () => {
    await replyPicking(['B 버튼']);
    const before = await clicks();
    await say({ name: 'find', query: '두 번째로 큰 것', click: true });
    await until(async () => (await clicks()).b === before.b + 1, 'B clicked by AI');
    const body = (await aiRequest()).body;
    assert.ok(body.includes('A 버튼'), 'labels sent');
    assert.strictEqual(await page.inputValue('#field') !== '', true, 'field has typed text');
    assert.ok(!body.includes(await page.inputValue('#field')), 'typed text not sent');
    await sw.evaluate(() => globalThis.__restoreFetch());
  });

  await check('AI never presses a risky button directly: it asks for a number', async () => {
    await replyPicking(['결제하기']);
    const before = await clicks();
    await say({ name: 'find', query: '결제', click: true });
    await until(async () => (await badges()) === 1, 'confirmation badge');
    assert.deepStrictEqual(await clicks(), before);
    await say({ name: 'number', n: 1 });
    await until(async () => (await clicks()).pay === before.pay + 1, 'confirmed by number');
    await sw.evaluate(() => globalThis.__restoreFetch());
  });

  await check('several matches, or "find", label items without pressing', async () => {
    await replyPicking(['A 버튼', 'B 버튼']);
    const before = await clicks();
    await say({ name: 'find', query: '둘 중 하나', click: true });
    await until(async () => (await badges()) === 2, 'two badges');
    assert.deepStrictEqual(await clicks(), before);
    await say({ name: 'hide' });
    await sw.evaluate(() => globalThis.__restoreFetch());

    await replyPicking(['B 버튼']);
    await say({ name: 'find', query: '두 번째', click: false });
    await until(async () => (await badges()) === 1, 'one badge');
    assert.deepStrictEqual(await clicks(), before);
    await say({ name: 'hide' });
    await sw.evaluate(() => globalThis.__restoreFetch());
  });

  await check('a nonsense or empty AI reply clicks nothing', async () => {
    const before = await clicks();
    for (const reply of ['{"matches":[]}', '{"matches":[9999]}', 'not json at all']) {
      await setReply([reply]);
      await say({ name: 'find', query: '없는 항목', click: true });
      await until(() => page.evaluate(() => document.getElementById('__nungil-host').shadowRoot.querySelector('.toast').textContent.includes('찾지 못했어요')), `not found: ${reply}`);
      await page.evaluate(() => { document.getElementById('__nungil-host').shadowRoot.querySelector('.toast').textContent = ''; });
    }
    assert.deepStrictEqual(await clicks(), before);
    assert.strictEqual(await badges(), 0);
    await sw.evaluate(() => { globalThis.__aiReply = undefined; });
  });

  // Scripts the AI one step at a time. A step can name an item by label.
  const scriptAgent = (steps) => sw.evaluate((queue) => {
    globalThis.__agentBodies = [];
    globalThis.__agentReal ??= globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/codex/responses')) {
        const text = JSON.parse(init.body).input[0].content[0].text;
        globalThis.__agentBodies.push(text);
        const step = { ...(queue.shift() ?? { action: 'scroll', say: '계속' }) };
        if (step.label) {
          step.index = text.split('\n').filter((l) => /^\d+: /.test(l)).findIndex((l) => l.includes(step.label));
          delete step.label;
        }
        globalThis.__aiReply = [JSON.stringify(step)];
      }
      return globalThis.__agentReal(url, init);
    };
  }, steps);
  const toastText = () => page.evaluate(() => document.getElementById('__nungil-host').shadowRoot.querySelector('.toast').textContent);

  await check('AI task: goes to another page, presses and types, then reports back', async () => {
    await page.goto(pageUrl);
    await page.bringToFront();
    await page.waitForTimeout(300);
    await scriptAgent([
      { action: 'navigate', url: `${pageUrl}second`, say: '이동해요' },
      { action: 'click', label: 'B 버튼', say: '눌러요' },
      { action: 'type', label: '입력 칸', text: '안녕하세요 메일', say: '입력해요' },
      { action: 'done', say: '초안을 작성했어요' },
    ]);
    await say({ name: 'agent', goal: '메일 작성해줘' }, '메일 작성해줘');
    await until(async () => page.url().endsWith('/second'), 'navigated');
    await until(() => page.evaluate(() => window.clicks?.b === 1), 'pressed on the new page', 15000);
    await until(async () => (await page.inputValue('#field')) === '안녕하세요 메일', 'typed', 15000);
    await until(async () => (await toastText()).includes('초안을 작성했어요'), 'reported', 15000);
    const bodies = await sw.evaluate(() => globalThis.__agentBodies);
    assert.strictEqual(bodies.length, 4);
    assert.ok(bodies[0].includes('목표: 메일 작성해줘'));
    assert.ok(bodies[2].includes('눌러요'), 'each step knows what came before');
    assert.ok(!bodies[3].includes('안녕하세요 메일'), 'typed text is not read back from the field');
  });

  await check('AI task: never presses a risky button itself, and waits for a spoken number', async () => {
    await scriptAgent([{ action: 'click', label: '결제하기', say: '결제해요' }, { action: 'click', label: 'B 버튼', say: '계속' }]);
    const before = await page.evaluate(() => ({ ...window.clicks }));
    await say({ name: 'agent', goal: '결제해줘' }, 'x');
    await until(async () => (await badges()) === 1, 'confirmation badge', 10000);
    await page.waitForTimeout(1500);
    assert.deepStrictEqual(await page.evaluate(() => ({ ...window.clicks })), before, 'pressed nothing, and the run ended');
    await say({ name: 'number', n: 1 });
    await until(() => page.evaluate((b) => window.clicks.pay === b + 1, before.pay), 'confirmed by voice');
  });

  await check('AI task: password fields are refused', async () => {
    await page.evaluate(() => { document.getElementById('field').type = 'password'; });
    await scriptAgent([{ action: 'type', label: '입력 칸', text: 'hunter2', say: '입력해요' }]);
    await say({ name: 'agent', goal: '로그인해줘' }, 'x');
    await until(async () => (await toastText()).includes('직접 입력'), 'refused', 10000);
    assert.strictEqual(await page.inputValue('#field') === 'hunter2', false);
    assert.ok((await sw.evaluate(() => globalThis.__agentBodies[0])).includes('입력 금지'));
    await page.goto(pageUrl);
    await page.bringToFront();
    await page.waitForTimeout(300);
  });

  await check('AI task: "cancel" stops it, a bad reply stops it, and it gives up after 12 steps', async () => {
    await scriptAgent([]);
    await say({ name: 'agent', goal: '계속 스크롤해줘' }, 'x');
    await until(() => sw.evaluate(() => globalThis.__agentBodies.length >= 1), 'running', 10000);
    await say({ name: 'hide' });
    await page.waitForTimeout(300);
    const stoppedAt = await sw.evaluate(() => globalThis.__agentBodies.length);
    await page.waitForTimeout(2500);
    assert.strictEqual(await sw.evaluate(() => globalThis.__agentBodies.length), stoppedAt, 'no steps after cancel');

    await sw.evaluate(() => {
      globalThis.fetch = async () => {
        const e = (d) => `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: d })}\n\n`;
        return new Response(e('아무 말이나 합니다'), { status: 200 });
      };
    });
    await say({ name: 'agent', goal: '해줘' }, 'x');
    await until(async () => (await toastText()).includes('이해하지 못해서'), 'stops on nonsense', 10000);
    await sw.evaluate(() => { globalThis.fetch = globalThis.__agentReal; });

    await sw.evaluate(() => { globalThis.__agentSteps = 0; });
    await scriptAgent(Array.from({ length: 14 }, (_, i) => ({ action: 'click', label: i % 2 ? 'A 버튼' : 'B 버튼', say: '눌러요' })));
    await say({ name: 'agent', goal: '끝없는 일 해줘' }, 'x');
    await until(async () => (await toastText()).includes('단계가 너무 많아서'), 'step limit', 40000);
    assert.strictEqual(await sw.evaluate(() => globalThis.__agentBodies.length), 12);
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  });

  await check('"클릭" with nothing highlighted presses the nearest thing to the gaze', async () => {
    await page.goto(pageUrl);
    await page.bringToFront();
    await page.waitForTimeout(400);
    const box = await page.locator('#b').boundingBox();
    const f = [0, 0, 0, 0, box.x + box.width + 240 + offset.x, box.y + box.height / 2 + offset.y, -40]; // out of snap range
    const end = Date.now() + 700;
    while (Date.now() < end) {
      await sw.evaluate(([id, g]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: g }), [tabId, f]);
      await new Promise((r) => setTimeout(r, 40));
    }
    const before = await page.evaluate(() => window.clicks.b);
    await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'speech', active: true }), tabId);
    await page.waitForTimeout(1200); // gaze has gone stale while speaking
    await say({ name: 'click' });
    await until(() => page.evaluate((b) => window.clicks.b > b || location.hash === '#linked', before), 'something pressed', 4000);
    await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'speech', active: false }), tabId);
    await page.goto(pageUrl);
    await page.bringToFront();
    await page.waitForTimeout(300);
  });

  await check('speech with no name runs the AI, but never replaces a running task or nags', async () => {
    await scriptAgent([{ action: 'done', say: '처리했어요' }]);
    await say({ name: 'agent', goal: '오늘 날씨 알려줘', wake: false }, '오늘 날씨 알려줘');
    await until(async () => (await toastText()).includes('처리했어요'), 'unprompted speech handled', 10000);

    await scriptAgent([]);
    await say({ name: 'agent', goal: '계속 스크롤해줘', wake: true }, 'x');
    await until(() => sw.evaluate(() => globalThis.__agentBodies.length >= 1), 'running', 10000);
    await page.waitForTimeout(200);
    await say({ name: 'agent', goal: '옆 사람의 잡담', wake: false }, 'x');
    await page.waitForTimeout(1500);
    const bodies = await sw.evaluate(() => globalThis.__agentBodies);
    assert.ok(bodies.every((b) => !b.includes('옆 사람의 잡담')), 'chatter ignored during a task');
    await say({ name: 'hide' });
    await page.waitForTimeout(1200); // let a step already under way finish being cancelled
    await sw.evaluate(() => { globalThis.fetch = globalThis.__agentReal; });
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.goto(pageUrl);
    await page.bringToFront();
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(300);
  });

  await check('saying a button name presses it directly, with no AI call', async () => {
    await page.goto(pageUrl);
    await page.bringToFront();
    await page.waitForTimeout(300);
    await sw.evaluate(() => { globalThis.__agentBodies = []; });
    await say({ name: 'find', query: '뉴스 버튼', text: '뉴스 버튼 눌러줘', click: true }, 'x');
    await until(() => page.evaluate(() => window.nav.n2 === 1), 'pressed by name', 4000);
    assert.strictEqual((await sw.evaluate(() => globalThis.__agentBodies)).length, 0, 'AI never called');
  });

  await check('a named button off screen is scrolled to and pressed', async () => {
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.textContent = '저 아래 버튼';
      b.onclick = () => { window.farClicked = (window.farClicked || 0) + 1; };
      b.style.cssText = 'position:absolute;top:2600px;left:40px';
      document.body.appendChild(b);
      scrollTo({ top: 0, behavior: 'instant' });
    });
    await say({ name: 'find', query: '저 아래', text: '저 아래 눌러줘', click: true }, 'x');
    await until(() => page.evaluate(() => window.farClicked === 1), 'pressed after scrolling', 4000);
    assert.ok(await page.evaluate(() => scrollY > 1000), 'went to it');
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  });

  await check('a button under an overlay is still found, and "display" is not a risky word', async () => {
    await page.evaluate(() => {
      const cover = document.createElement('div');
      cover.id = 'cover';
      cover.style.cssText = 'position:fixed;inset:0;z-index:50;background:transparent';
      document.body.appendChild(cover);
      const d = document.createElement('button');
      d.textContent = 'display settings';
      d.onclick = () => { window.dispClicked = 1; };
      d.style.cssText = 'position:absolute;top:180px;left:40px';
      document.body.appendChild(d);
    });
    await say({ name: 'find', query: 'display settings', text: 'x', click: true }, 'x');
    await until(() => page.evaluate(() => window.dispClicked === 1), 'pressed', 4000);
    await page.evaluate(() => document.getElementById('cover').remove());
  });

  await check('AI task: repeating the same move stops early instead of using all 12 steps', async () => {
    await page.goto(pageUrl);
    await page.bringToFront();
    await page.waitForTimeout(300);
    await scriptAgent(Array(12).fill({ action: 'click', label: 'B 버튼', say: '눌러요' }));
    await say({ name: 'agent', goal: '반복해줘', wake: true }, 'x');
    await until(async () => (await toastText()).includes('반복돼서'), 'stopped', 15000);
    assert.ok((await sw.evaluate(() => globalThis.__agentBodies.length)) <= 4);
    await page.goto(pageUrl);
    await page.bringToFront();
    await page.waitForTimeout(300);
  });

  await check('a request not on screen falls through to the AI task runner', async () => {
    await sw.evaluate(() => { globalThis.__agentBodies = []; });
    const queue = [{ matches: [] }, { action: 'done', say: '지메일을 열었어요' }];
    await scriptAgent(queue);
    await say({ name: 'find', query: '지메일', text: '지메일 열어줘', click: true }, 'x');
    await until(async () => (await toastText()).includes('지메일을 열었어요'), 'agent took over', 12000);
  });

  await check('logout clears the tokens', async () => {
    await context.route('https://auth.openai.com/oauth/revoke', (route) => route.fulfill({ status: 200, body: '{}' }));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
    await until(async () => (await popup.textContent('#codex')).includes('로그아웃'), 'logout shown');
    await popup.click('#codex');
    await until(() => sw.evaluate(async () => !(await chrome.storage.local.get('oauth:chatgpt'))['oauth:chatgpt']), 'tokens removed');
    await popup.close();
    await page.bringToFront();
  });

  await check('recenter: looking at the dot removes a measured offset', async () => {
    const shifted = (x, y) => sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, [0, 0, 0, 0, x, y, -40]]);
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const drift = { x: 180, y: -90 };
    await say({ name: 'recenter' });
    const end = Date.now() + 2300;
    while (Date.now() < end) {
      await shifted(size.w / 2 + offset.x + drift.x, size.h / 2 + offset.y + drift.y);
      await new Promise((r) => setTimeout(r, 40));
    }
    const { gazeBias } = await sw.evaluate(() => chrome.storage.local.get('gazeBias'));
    assert.ok(Math.abs(gazeBias.x + drift.x) < 2 && Math.abs(gazeBias.y + drift.y) < 2, JSON.stringify(gazeBias));
    await page.reload();
    await page.waitForTimeout(500);
    await page.bringToFront();
    const box = await page.locator('#b').boundingBox();
    const end2 = Date.now() + 900;
    while (Date.now() < end2) {
      await shifted(box.x + box.width / 2 + offset.x + drift.x, box.y + box.height / 2 + offset.y + drift.y);
      await new Promise((r) => setTimeout(r, 40));
    }
    const drawn = await boxStyle();
    assert.ok(Math.abs(drawn.left - (box.x - 4)) < 3, `corrected cursor highlights B after reload: ${drawn.left} vs ${box.x}`);
  });

  await check('pressing never changes the gaze offset', async () => {
    await sw.evaluate(() => chrome.storage.local.remove('gazeBias'));
    await page.waitForTimeout(100);
    const box = await page.locator('#b').boundingBox();
    const x = box.x + box.width + 60 + offset.x, y = box.y + box.height / 2 + offset.y;
    const end = Date.now() + 900;
    while (Date.now() < end) {
      await sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, [0, 0, 0, 0, x, y, -40]]);
      await new Promise((r) => setTimeout(r, 40));
    }
    const before = await clicks();
    await say({ name: 'click' });
    await until(async () => (await clicks()).b === before.b + 1, 'clicked');
    await page.waitForTimeout(150);
    assert.strictEqual((await sw.evaluate(() => chrome.storage.local.get('gazeBias'))).gazeBias, undefined);
  });

  await check('recenter refuses a huge offset instead of pinning the gaze to an edge', async () => {
    await sw.evaluate(() => chrome.storage.local.remove('gazeBias'));
    await page.waitForTimeout(100);
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await say({ name: 'recenter' });
    const end = Date.now() + 2300;
    while (Date.now() < end) {
      await sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, [0, 0, 0, 0, size.w / 2 + offset.x, size.h / 2 + offset.y - 1368, -40]]);
      await new Promise((r) => setTimeout(r, 40));
    }
    const { gazeBias } = await sw.evaluate(() => chrome.storage.local.get('gazeBias'));
    assert.strictEqual(gazeBias, undefined, JSON.stringify(gazeBias));
    assert.ok((await page.evaluate(() => document.getElementById('__nungil-host').shadowRoot.querySelector('.toast').textContent)).includes('교정'));
  });

  await check('a model from before this update is ignored, not used', async () => {
    await sw.evaluate(async () => {
      const { model } = await chrome.storage.local.get('model');
      globalThis.__model = model;
      await chrome.storage.local.set({ model: { ...model, version: undefined, wx: new Array(11).fill(0), wy: new Array(11).fill(0) } });
    });
    await page.waitForTimeout(150);
    const before = await clicks();
    await say({ name: 'click' });
    await page.waitForTimeout(200);
    assert.deepStrictEqual(await clicks(), before);
    await sw.evaluate(() => chrome.storage.local.set({ model: globalThis.__model }));
  });

  const sendFrameAtB = async (ms) => {
    const box = await page.locator('#b').boundingBox();
    const x = box.x + box.width / 2 + offset.x, y = box.y + box.height / 2 + offset.y;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sw.evaluate(async (f) => {
        // The same relay real frames use, so a dead tab goes through its recovery.
        await toActiveTab({ type: 'frame', face: true, blink: false, features: f });
      }, [0, 0, 0, 0, x, y, -40]);
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  const aimAt = async (selector, ms) => {
    const box = await page.locator(selector).boundingBox();
    const f = [0, 0, 0, 0, box.x + box.width / 2 + offset.x, box.y + box.height / 2 + offset.y, -40];
    const end = Date.now() + ms;
    let i = 0;
    while (Date.now() < end) {
      // Noise far bigger than these buttons, flipping the nearest item all the time.
      const jitter = [-50, 40, -20, 55, -35, 25][i++ % 6];
      await sw.evaluate(([id, g]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: g }), [tabId, [f[0], f[1], f[2], f[3], f[4] + jitter, f[5], f[6]]]);
      await new Promise((r) => setTimeout(r, 40));
    }
  };
  const navClicks = () => page.evaluate(() => window.nav);

  await check('navbar: noisy gaze holds one item and dwell presses it, with no popup', async () => {
    await page.evaluate(() => scrollTo(0, 0));
    await setSettings({ dwell: true, dwellMs: 800 });
    await new Promise((r) => setTimeout(r, 1600));
    await aimAt('#n2', 4000);
    const pressed = await navClicks();
    assert.strictEqual(Object.values(pressed).reduce((a, b) => a + b, 0) >= 1, true, JSON.stringify(pressed));
    assert.strictEqual(Object.keys(pressed).length, 1, `one item only: ${JSON.stringify(pressed)}`);
    assert.strictEqual(await page.evaluate(() => document.getElementById('__nungil-host').shadowRoot.querySelector('.panel')), null);
    await setSettings({ dwell: false, dwellMs: 1500 });
    await page.waitForTimeout(200);
  });

  const toB = async () => {
    const box = await page.locator('#b').boundingBox();
    return [0, 0, 0, 0, box.x + box.width / 2 + offset.x, box.y + box.height / 2 + offset.y, -40];
  };
  const speech = (active) => sw.evaluate(([id, a]) => chrome.tabs.sendMessage(id, { type: 'speech', active: a }), [tabId, active]);
  const stream = async (features, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, features]);
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  await check('speaking freezes the highlight, and "click" presses what was being looked at', async () => {
    await lookAt('#b', 900);
    const before = await boxStyle();
    const link = await page.locator('#link').boundingBox();
    await speech(true);
    await stream([0, 0, 0, 0, link.x + offset.x + 10, link.y + offset.y + 5, -40], 900);
    assert.strictEqual((await boxStyle()).left, before.left, 'gaze ignored while speaking');
    const counts = await clicks();
    await say({ name: 'click' });
    await until(async () => (await clicks()).b === counts.b + 1, 'clicked the frozen item');
    await speech(false);
    await page.waitForTimeout(500);
    await lookAt('#link', 1500);
    assert.notStrictEqual((await boxStyle()).left, before.left, 'gaze back after speech');
  });

  await check('speech never leaves the eyes off, even if its end is not reported', async () => {
    await lookAt('#b', 900);
    const before = await boxStyle();
    await speech(true);
    await page.waitForTimeout(6300);
    await lookAt('#link', 1500);
    assert.notStrictEqual((await boxStyle()).left, before.left);
    await page.waitForTimeout(100);
  });

  await check('while an AI task runs, speech does not stop the eyes', async () => {
    await lookAt('#b', 900);
    const before = await boxStyle();
    await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'agent-status', running: true }), tabId);
    await speech(true);
    await lookAt('#link', 1500);
    assert.notStrictEqual((await boxStyle()).left, before.left);
    await speech(false);
    await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'agent-status', running: false }), tabId);
  });

  await check('a second injected copy takes over: one overlay, and one click per command', async () => {
    await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: CONTENT_FILES }), tabId);
    await page.waitForTimeout(300);
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#__nungil-host').length), 1);
    await sendFrameAtB(700);
    const before = await clicks();
    await say({ name: 'click' });
    await until(async () => (await clicks()).b === before.b + 1, 'clicked');
    await page.waitForTimeout(200);
    assert.strictEqual((await clicks()).b, before.b + 1, 'exactly one click');
  });

  await check('a tab whose content script died recovers by itself on the next frame', async () => {
    await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => window.__nungilDispose() }), tabId);
    await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#__nungil-host').length), 0);
    await until(async () => {
      await sendFrameAtB(200);
      return page.evaluate(() => {
        const b = document.getElementById('__nungil-host')?.shadowRoot.querySelector('.box');
        return b && getComputedStyle(b).display === 'block';
      });
    }, 'highlight back without reloading the page', 12000);
  });

  await check('diagnostics record the relay, and contain no page address', async () => {
    await page.waitForTimeout(2200);
    await sendFrameAtB(100);
    const { diag } = await sw.evaluate(() => chrome.storage.local.get('diag'));
    assert.ok(diag.relayed > 0, JSON.stringify(diag));
    assert.strictEqual(diag.page.model, true);
    assert.ok(!JSON.stringify(diag).includes('localhost:'), JSON.stringify(diag));
  });

  await check('turning off clears the overlay and ignores commands', async () => {
    await setSettings({ enabled: false });
    await page.waitForTimeout(200);
    assert.strictEqual((await boxStyle()).display, 'none');
    const before = await clicks();
    await say({ name: 'click' });
    await page.waitForTimeout(200);
    assert.deepStrictEqual(await clicks(), before);
  });

  await check('voice status from real recognizer in offscreen (informational)', async () => {
    await setSettings({ enabled: true });
    await new Promise((r) => setTimeout(r, 4000));
    const s = await status();
    results.push(`INFO after restart voice=${s?.voice ?? 'none'} tabs=${(await context.pages()).map((p) => p.url()).join(' | ')}`);
  });

  await check('coming back after leaving the camera view triggers a recenter; a brief loss does not', async () => {
    // Real tracker frames would say the photo's face is still there.
    await sw.evaluate(() => chrome.offscreen.hasDocument().then((open) => open && chrome.offscreen.closeDocument()));
    await sw.evaluate(() => chrome.storage.local.remove(['needsRecenter', 'gazeBias']));
    await page.waitForTimeout(600);
    const flag = async () => (await sw.evaluate(() => chrome.storage.local.get('needsRecenter'))).needsRecenter;
    const away = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'frame', face: false }), tabId);
        await new Promise((r) => setTimeout(r, 40));
      }
    };
    await lookAt('#b', 300);
    await away(800);
    await lookAt('#b', 300);
    assert.strictEqual(await flag(), undefined, 'a brief loss is nothing');
    await away(2300);
    await lookAt('#b', 200);
    await until(flag, 'recenter required on return', 3000);
    await sw.evaluate(() => chrome.storage.local.remove('needsRecenter'));
    await page.waitForTimeout(2300); // let the started recenter finish
    await sw.evaluate(() => chrome.storage.local.remove(['needsRecenter', 'gazeBias']));
    await sw.evaluate(() => restart());
    await page.waitForTimeout(100);
  });

  await check('recenter ignores a gaze that never settles on the dot', async () => {
    await sw.evaluate(() => chrome.offscreen.hasDocument().then((open) => open && chrome.offscreen.closeDocument()));
    await sw.evaluate(() => chrome.storage.local.remove(['needsRecenter', 'gazeBias']));
    await page.waitForTimeout(4600); // an earlier attempt may still be running out its time
    await say({ name: 'recenter' });
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const end = Date.now() + 5400;
    let i = 0;
    while (Date.now() < end) {
      // Looking all over the page, not at the dot.
      const x = size.w / 2 + offset.x + (i % 2 ? 300 : -300);
      i++;
      await sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, [0, 0, 0, 0, x, size.h / 2 + offset.y, -40]]);
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.strictEqual((await sw.evaluate(() => chrome.storage.local.get('gazeBias'))).gazeBias, undefined, 'nothing saved');
    await page.waitForTimeout(100);
  });

  await check('quick calibration: four dots fix offset and scale, and the model is untouched', async () => {
    await sw.evaluate(() => chrome.offscreen.hasDocument().then((open) => open && chrome.offscreen.closeDocument()));
    await sw.evaluate(() => chrome.storage.local.remove(['needsRecenter', 'gazeBias']));
    await page.waitForTimeout(600);
    const modelBefore = await sw.evaluate(async () => JSON.stringify((await chrome.storage.local.get('model')).model));
    await say({ name: 'quickCalibrate' });
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    for (const [fx, fy] of [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]) {
      const end = Date.now() + 2000;
      const tx = size.w * fx + offset.x, ty = size.h * fy + offset.y;
      while (Date.now() < end) {
        // A user whose gaze reads 80% of the true spread, shifted 60px.
        await sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, [0, 0, 0, 0, tx * 0.8 + 60, ty * 0.8 + 60, -40]]);
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    const fix = await until(async () => (await sw.evaluate(() => chrome.storage.local.get('gazeBias'))).gazeBias, 'correction saved', 3000);
    assert.ok(fix.sx > 1.08 && fix.sx < 1.3 && fix.sy > 1.08 && fix.sy < 1.3, JSON.stringify(fix));
    assert.strictEqual(await sw.evaluate(async () => JSON.stringify((await chrome.storage.local.get('model')).model)), modelBefore);
    await sw.evaluate(() => chrome.storage.local.remove('gazeBias'));
    await sw.evaluate(() => restart());
    await page.waitForTimeout(100);
  });

  await check('coming back to Chrome: a quick switch nudges, a long absence runs four dots', async () => {
    const needs = async () => (await sw.evaluate(() => chrome.storage.local.get('needsRecenter'))).needsRecenter;
    await sw.evaluate(async () => {
      await chrome.storage.session.set({ asleep: true, sleptAt: Date.now() - 5000 });
      await onWindowFocus(1);
    });
    assert.strictEqual(await needs(), true);
    await sw.evaluate(async () => {
      await chrome.storage.local.remove('needsRecenter');
      await chrome.storage.session.set({ asleep: true, sleptAt: Date.now() - 120000 });
      await onWindowFocus(1);
    });
    assert.strictEqual(await needs(), 'quick');
    await sw.evaluate(() => chrome.storage.local.remove(['needsRecenter', 'gazeBias']));
    await page.waitForTimeout(200);
  });

  await check('turning back on requires a recenter: no gaze clicks until it is done', async () => {
    await page.bringToFront();
    const setRaw = (enabled) => sw.evaluate(async (on) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, enabled: on, standby: false, dwell: false } });
    }, enabled);
    const flag = async () => (await sw.evaluate(() => chrome.storage.local.get('needsRecenter'))).needsRecenter;
    await setRaw(false);
    await page.waitForTimeout(300);
    await sw.evaluate(() => chrome.storage.local.remove('gazeBias'));
    await setRaw(true);
    assert.strictEqual(await until(flag, 'recenter required', 5000), 'quick', 'turning on asks for four dots');
    try {
    // The real tracker reopens after turning on, and its frames must not mix with these.
    await until(() => sw.evaluate(() => chrome.offscreen.hasDocument()), 'tracker reopened', 15000);
    await sw.evaluate(() => chrome.offscreen.closeDocument());
    // Real frames may already have started the recenter on a photo. Let that finish, then
    // require it again so this test controls every frame.
    await page.waitForTimeout(3000);
    await sw.evaluate(() => chrome.storage.local.remove('gazeBias'));
    await sw.evaluate(() => chrome.storage.local.set({ needsRecenter: true }));
    await page.waitForTimeout(100);

    const dot = () => page.evaluate(() => getComputedStyle(document.getElementById('__nungil-host').shadowRoot.querySelector('.recenter')).display);
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const before = await clicks();
    // An earlier attempt on no frames may still be waiting out its retry delay.
    await until(async () => {
      await lookAt('#b', 200);
      return (await dot()) === 'block';
    }, 'dot appears by itself', 6000);
    assert.strictEqual((await boxStyle()).display, 'none', 'nothing highlights yet');
    const veil = () => page.evaluate(() => document.getElementById('__nungil-host').shadowRoot.querySelector('.veil').classList.contains('on'));
    assert.strictEqual(await veil(), true, 'background blurred behind the dot');
    await say({ name: 'click' });
    await page.waitForTimeout(150);
    assert.deepStrictEqual(await clicks(), before, 'nothing can be pressed');

    const end = Date.now() + 2300;
    while (Date.now() < end) {
      await sw.evaluate(([id, f]) => chrome.tabs.sendMessage(id, { type: 'frame', face: true, blink: false, features: f }), [tabId, [0, 0, 0, 0, size.w / 2 + offset.x + 40, size.h / 2 + offset.y, -40]]);
      await new Promise((r) => setTimeout(r, 40));
    }
    await until(async () => !(await flag()), 'requirement cleared', 3000);
    assert.strictEqual(await dot(), 'none');
    assert.strictEqual(await veil(), false, 'background clears afterwards');
    await sw.evaluate(() => chrome.storage.local.remove('gazeBias'));
    await page.waitForTimeout(100);
    await lookAt('#b', 900);
    assert.strictEqual((await boxStyle()).display, 'block', 'gaze works again');
    } finally {
      await sw.evaluate(() => restart());
    }
  });

  await check('"눈길 꺼줘" turns the camera off but keeps listening, "눈길 켜줘" turns it back on', async () => {
    await setSettings({ enabled: true, standby: false });
    await until(() => sw.evaluate(() => chrome.offscreen.hasDocument()), 'tracker running', 15000);
    const speaker = await context.newPage();
    await speaker.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
    const say = (name) => speaker.evaluate((n) => chrome.runtime.sendMessage({ type: 'command', command: { name: n }, transcript: '' }), name).catch(() => {});
    const offscreenUrl = () => sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))[0]?.documentUrl ?? null);
    await say('powerOff');
    await until(async () => (await offscreenUrl())?.includes('camera=0'), 'mic only', 10000);
    const stored = (await sw.evaluate(() => chrome.storage.local.get('settings'))).settings;
    assert.strictEqual(stored.enabled, false);
    assert.strictEqual(stored.standby, true);
    await say('powerOn');
    await until(async () => (await offscreenUrl())?.includes('camera=1'), 'camera back', 10000);
    assert.strictEqual((await sw.evaluate(() => chrome.storage.local.get('settings'))).settings.standby, false);

    // The popup's switch turns everything off, mic included.
    await say('powerOff');
    await until(async () => (await offscreenUrl())?.includes('camera=0'), 'standby', 10000);
    await setSettings({ enabled: false, standby: false });
    await until(async () => (await offscreenUrl()) === null, 'fully off', 10000);
    await speaker.close();
    await setSettings({ enabled: true });
    await until(() => sw.evaluate(() => chrome.offscreen.hasDocument()), 'tracker running again', 15000);
    await page.bringToFront();
  });

  await check('leaving Chrome turns the camera off, and coming back turns it on', async () => {
    await setSettings({ enabled: true });
    await until(() => sw.evaluate(() => chrome.offscreen.hasDocument()), 'tracker running', 15000);
    // Headless Chrome has no other apps to leave for, so focus reports are simulated.
    const hasFocusStub = await sw.evaluate(async () => {
      const real = chrome.windows.getAll;
      globalThis.__realGetAll = real;
      chrome.windows.getAll = async () => [];
      return true;
    });
    assert.ok(hasFocusStub);
    const focus = (id) => sw.evaluate((w) => onWindowFocus(w ?? chrome.windows.WINDOW_ID_NONE), id);
    const running = () => sw.evaluate(() => chrome.offscreen.hasDocument());

    // A brief switch between windows must not touch the camera.
    await focus(null);
    await page.waitForTimeout(1000);
    await focus(1);
    await page.waitForTimeout(2600);
    assert.strictEqual(await running(), true, 'a short blip keeps it on');

    await focus(null);
    await until(async () => !(await running()), 'camera off after leaving', 8000);
    await focus(1);
    await until(running, 'camera back on return', 8000);
    assert.strictEqual(await sw.evaluate(async () => (await chrome.storage.session.get('asleep')).asleep), undefined);

    // Settings changed while away must not wake it.
    await focus(null);
    await until(async () => !(await running()), 'asleep again', 8000);
    await setSettings({ dwell: false, sound: false });
    await sw.evaluate(() => restart());
    await page.waitForTimeout(800);
    assert.strictEqual(await running(), false, 'stays asleep');
    await focus(1);
    await until(running, 'awake', 8000);
    await sw.evaluate(() => { chrome.windows.getAll = globalThis.__realGetAll; });
  });

  await check('a window still in focus cancels the sleep', async () => {
    const focused = await sw.evaluate(async () => {
      chrome.windows.getAll = async () => [{ focused: true }];
      await onWindowFocus(chrome.windows.WINDOW_ID_NONE);
      return true;
    });
    assert.ok(focused);
    await page.waitForTimeout(3500);
    assert.strictEqual(await sw.evaluate(() => chrome.offscreen.hasDocument()), true);
    await sw.evaluate(() => { chrome.windows.getAll = globalThis.__realGetAll; });
  });

  await check('sound mode starts mic analysis instead of speech recognition', async () => {
    await setSettings({ sound: true });
    const s = await until(async () => {
      const v = await status();
      return String(v?.voice ?? '').startsWith('sound:') ? v : null;
    }, 'sound status', 20000);
    assert.strictEqual(s.voice, 'sound:running');
    await setSettings({ sound: false });
    await until(async () => (await status())?.voice === 'listening', 'speech restored', 20000);
  });

  await check('first run: popup leads to onboarding, then calibration in two phases, then the guide', async () => {
    await sw.evaluate(() => chrome.storage.local.remove(['model', 'onboardingDone']));
    const extensionId = new URL(sw.url()).host;
    const opened = context.waitForEvent('page', { timeout: 8000 });
    const popup = await context.newPage();
    popup.on('close', () => {});
    await popup.goto(`chrome-extension://${extensionId}/popup.html`).catch(() => {});
    const first = await opened;
    let cal = first.url().includes('popup.html') ? await until(() => context.pages().find((p) => p.url().includes('onboarding=1')), 'onboarding tab') : first;
    if (!cal.url().includes('onboarding=1')) cal = await until(() => context.pages().find((p) => p.url().includes('onboarding=1')), 'onboarding tab');
    cal.on('pageerror', (e) => results.push(`PAGE ERROR onboarding: ${e.message}`));
    await cal.bringToFront();
    await cal.waitForSelector('#allow');
    assert.strictEqual(await cal.textContent('#introTitle'), '시선 교정을 할게요');
    await cal.click('#allow');
    await cal.waitForSelector('#begin:not([disabled])', { timeout: 45000 });
    assert.strictEqual(await cal.evaluate(() => document.querySelectorAll('#scanTicks line.lit').length), 72, 'ring full before starting');
    await cal.click('#begin');
    await cal.waitForFunction(() => document.getElementById('phase').classList.contains('on') && document.getElementById('phaseTitle').textContent.includes('눈으로만'), null, { timeout: 8000 });
    assert.ok(await cal.evaluate(() => document.getElementById('dot').classList.contains('off')), 'dots wait for the message');
    await cal.waitForFunction(() => document.getElementById('stageText').textContent.includes('눈으로만'), null, { timeout: 12000 });
    await cal.waitForFunction(() => document.getElementById('phaseTitle').textContent.includes('한 번 더') && document.getElementById('phase').classList.contains('on'), null, { timeout: 60000 });
    await cal.waitForSelector('#done:not([hidden])', { timeout: 90000 });
    assert.strictEqual(await cal.textContent('#doneTitle'), '등록이 완료됐어요');
    assert.strictEqual(await cal.evaluate(() => getComputedStyle(document.getElementById('success')).display), 'block', 'check mark shows');
    assert.strictEqual(await cal.evaluate(() => document.querySelectorAll('#stageRing line.lit').length), 72, 'progress ring reached the end');
    const { model } = await sw.evaluate(() => chrome.storage.local.get('model'));
    assert.ok(Number.isFinite(model.errorPx) && Number.isFinite(model.errorX) && Number.isFinite(model.errorY), JSON.stringify(model));
    assert.strictEqual(model.wx.length, 10);
    assert.strictEqual(model.version, 5);
    results.push(`INFO calibration result: ${await cal.textContent('#resultText')}`);

    // Voice-only: "다음" presses the main button, and walks the guide.
    const sayNext = () => sw.evaluate(() => chrome.runtime.sendMessage({ type: 'command', command: { name: 'next' }, transcript: '다음' }).catch(() => {}));
    await sayNext();
    await cal.waitForURL(/guide\.html/);
    await cal.waitForSelector('.step.on');
    assert.ok((await cal.textContent('.step.on h1')).includes('등록이 완료'));
    await sayNext();
    await cal.waitForFunction(() => document.querySelector('.step.on h1').textContent.includes('여기 있어요'));
    await cal.keyboard.press('ArrowRight');
    await cal.keyboard.press('ArrowRight');
    await cal.keyboard.press('ArrowLeft');
    await cal.waitForFunction(() => document.querySelector('.step.on h1').textContent.includes('설정창'));
    // The demo plays: a pointer moves, captions change, and the mock screen reacts.
    const toolbarHere = await cal.evaluate(() => document.querySelector('.step.on .scene')?.dataset.demo);
    if (toolbarHere !== 'toolbar') await cal.keyboard.press('ArrowLeft');
    await cal.waitForFunction(() => document.querySelector('.step.on .scene')?.dataset.demo === 'toolbar');
    await cal.waitForFunction(() => globalThis.GuideDemo);
    const pointer = () => cal.evaluate(() => document.querySelector('.step.on .vcursor')?.style.transform);
    const start = await pointer();
    await cal.waitForFunction(() => document.querySelector('.step.on .caption').textContent.includes('핀을'), null, { timeout: 20000 });
    assert.notStrictEqual(await pointer(), start, 'pointer moved');
    assert.ok(await cal.evaluate(() => document.querySelector('#d-menu').classList.contains('show')), 'menu opened by the click');
    await cal.waitForFunction(() => document.querySelector('#d-pinned').classList.contains('shown'), null, { timeout: 20000 });

    // Leaving the step stops its demo; coming back starts it over.
    // Captions cross-fade, and stay long enough to read.
    assert.ok((await cal.evaluate(() => getComputedStyle(document.querySelector('.step.on .caption')).transitionDuration)).includes('0.3s'));
    await cal.keyboard.press('ArrowRight');
    await cal.waitForFunction(() => document.querySelector('.step.on .scene')?.dataset.demo === 'settings');
    await cal.waitForFunction(() => document.querySelector('.step.on .caption').textContent.includes('켜기'), null, { timeout: 4000 });
    assert.strictEqual(await cal.evaluate(() => document.querySelector('[data-demo=toolbar] .vcursor')), null, 'old demo cleaned up');
    await cal.keyboard.press('ArrowLeft');
    await cal.waitForFunction(() => document.querySelector('.step.on .scene')?.dataset.demo === 'toolbar');
    await cal.keyboard.press('ArrowRight');

    const titles = await cal.evaluate(() => [...document.querySelectorAll('.step h1')].map((h) => h.textContent));
    for (const want of ['여기 있어요', '설정창', '바라보면', '까딱', '어긋나면', '말로', 'AI']) assert.ok(titles.some((t) => t.includes(want)), want);

    // Every demo runs through to its last caption without an error.
    await cal.evaluate(() => { GuideDemo.speed = 0.2; });
    const demoErrors = [];
    cal.on('pageerror', (e) => demoErrors.push(e.message));
    const scenes = await cal.evaluate(() => [...document.querySelectorAll('.step')].map((s) => s.querySelector('.scene')?.dataset.demo ?? null));
    const lastWords = { toolbar: '설정창이 열려요', settings: '시선 교정:', dwell: '말로 확인해야', flick: '직접 해 보세요', recenter: '다시 맞았어요', voice: '도움말', ai: '먼저 물어봐요' };
    let at = await cal.evaluate(() => [...document.querySelectorAll('.step')].findIndex((s) => s.classList.contains('on')));
    for (const [i, name] of scenes.entries()) {
      if (!name) continue;
      await cal.bringToFront();
      await cal.evaluate((n) => show(n), i);
      at = i;
      await cal.waitForFunction((w) => document.querySelector('.step.on .caption').textContent.includes(w), lastWords[name], { timeout: 60000, polling: 100 }).catch(async (error) => {
        throw new Error(`demo ${name} never reached "${lastWords[name]}", caption: ${await cal.textContent('.step.on .caption')}`);
      });
    }
    assert.deepStrictEqual(demoErrors, []);

    // Flick practice lights the matching tile. The real tracker has to stop first:
    // its frames, from a still photo, would be mixed in with these.
    await setSettings({ enabled: false });
    await cal.waitForTimeout(500);
    const practice = titles.findIndex((t) => t.includes('까딱'));
    await cal.evaluate((n) => show(n), practice);
    const frame = (yaw) => sw.evaluate((y) => chrome.runtime.sendMessage({ type: 'frame', face: true, blink: false, features: [0, 0, y, 0, 0, 0, -40, 0, 0] }).catch(() => {}), yaw);
    for (const k of [0, 0, 0, 0, 0, 0, 0.6, 1, 1, 0.5, 0, 0, 0]) {
      await frame(0.14 * k);
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok((await cal.textContent('#practiceText')).includes('까딱했어요'), await cal.textContent('#practiceText'));

    for (let i = practice; i < titles.length - 1; i++) await cal.click('#next');
    assert.strictEqual(await cal.textContent('#nextLabel'), '시작하기');
    await cal.click('#next').catch(() => {});
    await until(() => sw.evaluate(async () => (await chrome.storage.local.get('onboardingDone')).onboardingDone === true), 'finished');
  });

  await check('after onboarding the popup opens settings, with the guide one press away', async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
    await popup.waitForTimeout(400);
    assert.ok(!popup.isClosed());
    const opened = context.waitForEvent('page', { timeout: 8000 });
    await popup.click('#guide');
    const guide = await opened;
    await guide.waitForSelector('.step.on');
    assert.ok((await guide.textContent('.step.on h1')).includes('여기 있어요'), 'reopened guide skips the congratulations');
    await guide.close();
    await popup.close();
  });
} finally {
  await context.close();
  server.close();
}

console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL') || r.startsWith('PAGE ERROR'))) process.exit(1);
