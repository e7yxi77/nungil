// Page overlay: turns gaze frames into a highlighted target and runs voice commands.
{
  // An extension reload cuts off the running copy but keeps its isolated world, so
  // a plain "already loaded" flag would leave a dead copy in charge of this tab.
  // A newly injected copy always takes over instead.
  window.__nungilDispose?.();
  (() => {
    const { predict, createFilter, pickTarget, createHoldGesture, createHeadFlick, flickDirection, neighbourIn } = GazeModel;

    const SNAP_RADIUS = 140;
    const SWITCH_MS = 350;
    const DWELL_START_DELAY_MS = 500; // looking around shouldn't start a countdown
    const STICKY_PX = 50;
    const HOLD_RELEASE_PX = 220;
    const HEAD_SETTLE_MS = 400;
    const SPEECH_MAX_MS = 6000;
    const FLICK_FIND_RADIUS_PX = 260;
    const RAW_WINDOW = 5;
    const MAX_TARGET_VIEWPORT_SHARE = 0.4;
    const DWELL_COOLDOWN_MS = 1500;
    const GAZE_TIMEOUT_MS = 800;
    const EYES_CLOSED_RESET_MS = 400;
    const MOUTH_MS = 900;
    const MOUTH_REPEAT_MS = 1000;
    const READER_MAX_PARAGRAPHS = 200;
    const READER_MIN_CHARS = 20;
    const AI_MAX_CHARS = 30000;
    const FIND_MAX_ITEMS = 150;
    const FIND_LABEL_CHARS = 80;
    const CLICK_LEARN_RATE = 0.5;
    const CLICK_BIAS_LIMIT = 250;
    const RECENTER_SETTLE_MS = 900;
    const RECENTER_COLLECT_MS = 1100;
    const RECENTER_MIN_SAMPLES = 5;
    const RECENTER_MAX_PX = 500;
    const NUMBERS_NEAR_GAZE = 9;
    const NUMBERS_MAX = 40;
    const CLICKABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,label[for],'
      + '[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=radio],'
      + '[onclick],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
    const RISKY = /결제|구매|주문|송금|이체|삭제|탈퇴|전송|보내기|pay|buy|purchase|checkout|order|delete|remove|send|transfer/i;

    let settings = { ...NUNGIL_DEFAULTS };
    let eyeModel = null;
    const usable = (m) => (m?.version === NUNGIL_MODEL_VERSION ? m : null);
    const activeModel = () => usable(eyeModel);
    let bias = { x: 0, y: 0 }; // screen px, corrects drift since calibration
    let lastScreen = null; // smoothed gaze before bias
    let recentering = null; // { samples, collecting, point }
    const t = nungilStrings();

    let filter = createFilter();
    const mouthGesture = createHoldGesture(MOUTH_MS, { repeatMs: MOUTH_REPEAT_MS });
    let rawWindow = [];
    const headFlick = createHeadFlick();
    let holdAt = null; // where the gaze was when a flick chose the current item
    let gazeMutedUntil = 0;
    let speaking = false;
    let speakingTimer = 0;
    let eyesClosedAt = null;
    let calibrateHintShown = false;
    let reader = null; // { paragraphs, index, speakId, reading }
    let pendingAi = null; // { id, task, ...task details }
    let gaze = null;
    let gazeAt = 0;
    let paused = false;

    let targets = [];
    let target = null;
    let targetRisky = false;
    let targetSince = 0;
    let lastTarget = null;
    let lastTargetAt = 0;
    let candidate = null;
    let candidateSince = 0;
    let dwellBlockedUntil = 0;
    let numbered = [];
    let numbersTimer = 0;
    let toastTimer = 0;

    // ---- Overlay ----------------------------------------------------------
    const host = document.createElement('div');
    host.id = '__nungil-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Apple SD Gothic Neo', 'Pretendard', 'Noto Sans KR', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
        .box { position: fixed; display: none; border-radius: 10px; background: rgba(0, 113, 227, .10); box-shadow: 0 0 0 3px #0071e3, 0 0 0 7px rgba(0, 113, 227, .22); transition: left .22s cubic-bezier(.2, .8, .2, 1), top .22s cubic-bezier(.2, .8, .2, 1), width .22s cubic-bezier(.2, .8, .2, 1), height .22s cubic-bezier(.2, .8, .2, 1); }
        .box.risky { background: rgba(255, 59, 48, .10); box-shadow: 0 0 0 3px #ff3b30, 0 0 0 7px rgba(255, 59, 48, .22); }
        .box.fire { background: rgba(0, 113, 227, .35); }
        .ring { position: fixed; display: none; width: 40px; height: 40px; margin: -20px 0 0 -20px; border-radius: 50%; filter: drop-shadow(0 1px 3px rgba(0, 0, 0, .35));
          -webkit-mask: radial-gradient(farthest-side, transparent 72%, #000 74%); mask: radial-gradient(farthest-side, transparent 72%, #000 74%); }
        .recenter { position: fixed; display: none; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; background: #0071e3; border: 4px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .12), 0 8px 24px rgba(0, 0, 0, .3); }
        .toast { position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); max-width: min(80vw, 620px); padding: 13px 22px; border-radius: 22px; background: rgba(29, 29, 31, .78); -webkit-backdrop-filter: blur(24px) saturate(180%); backdrop-filter: blur(24px) saturate(180%); color: #fff; font-size: 16px; line-height: 1.4; font-weight: 500; letter-spacing: -.01em; text-align: center; display: none; box-shadow: 0 10px 34px rgba(0, 0, 0, .28); animation: rise .28s cubic-bezier(.2, .8, .2, 1); }
        .badge { position: fixed; min-width: 28px; height: 28px; padding: 0 8px; border-radius: 14px; background: #0071e3; color: #fff; font-size: 15px; line-height: 28px; font-weight: 600; text-align: center; box-shadow: 0 0 0 2px #fff, 0 4px 12px rgba(0, 0, 0, .28); }
        .help { position: fixed; top: 20px; right: 20px; width: 360px; max-width: calc(100vw - 32px); padding: 20px 22px; border-radius: 20px; background: rgba(255, 255, 255, .78); -webkit-backdrop-filter: blur(30px) saturate(180%); backdrop-filter: blur(30px) saturate(180%); color: #1d1d1f; display: none; box-shadow: 0 18px 50px rgba(0, 0, 0, .22); }
        .help h2 { margin: 0 0 10px; font-size: 19px; font-weight: 600; letter-spacing: -.02em; }
        .help div { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; font-size: 13px; border-top: .5px solid rgba(0, 0, 0, .14); }
        .help b { color: #0071e3; font-weight: 600; }
        .reader { position: fixed; inset: 0; overflow-y: auto; padding: 72px 16px 140px; background: #fff; color: #1d1d1f; font-size: 22px; line-height: 1.6; letter-spacing: -.005em; display: none; pointer-events: auto; animation: fade .24s cubic-bezier(.2, .8, .2, 1); }
        .reader > * { max-width: 700px; margin: 0 auto 22px; }
        .reader h1, .reader .heading { font-weight: 700; letter-spacing: -.02em; }
        .reader h1 { font-size: 40px; line-height: 1.12; margin-bottom: 36px; letter-spacing: -.03em; }
        .reader .current { background: rgba(0, 113, 227, .08); border-radius: 12px; box-shadow: 0 0 0 10px rgba(0, 113, 227, .08); }
        .reader mark { background: #0071e3; color: #fff; border-radius: 5px; padding: 0 2px; }
        @keyframes fade { from { opacity: 0; } }
        @keyframes rise { from { opacity: 0; transform: translate(-50%, 8px); } }
        @media (prefers-color-scheme: dark) {
          .reader { background: #000; color: #f5f5f7; }
          .reader .current { background: rgba(10, 132, 255, .2); box-shadow: 0 0 0 10px rgba(10, 132, 255, .2); }
          .reader mark { background: #0a84ff; }
          .help { background: rgba(44, 44, 46, .78); color: #f5f5f7; }
          .help div { border-top-color: rgba(255, 255, 255, .16); }
          .help b { color: #64aaff; }
        }
        @media (prefers-reduced-motion: reduce) {
          .box { transition: none; }
          .toast, .reader { animation: none; }
        }
        @media (prefers-reduced-transparency: reduce) {
          .toast { background: #1d1d1f; -webkit-backdrop-filter: none; backdrop-filter: none; }
          .help { background: #fff; -webkit-backdrop-filter: none; backdrop-filter: none; }
        }
        @media (prefers-contrast: more) {
          .box { box-shadow: 0 0 0 4px #000, 0 0 0 7px #fff; }
        }
      </style>
      <div class="reader"></div>
      <div class="box"></div>
      <div class="ring"></div>
      <div class="recenter"></div>
      <div class="badges"></div>
      <div class="help" role="dialog"></div>
      <div class="toast" role="status" aria-live="polite"></div>`;
    const $ = (s) => root.querySelector(s);
    const ui = { box: $('.box'), ring: $('.ring'), badges: $('.badges'), reader: $('.reader'), recenter: $('.recenter'), toast: $('.toast'), help: $('.help') };
    // After an extension reload the old script is cut off but its overlay stays in
    // the page, which would leave a frozen cursor on screen.
    document.getElementById(host.id)?.remove();
    document.documentElement.appendChild(host);

    function toast(text, ms = 2500) {
      if (!text) return;
      ui.toast.textContent = text;
      ui.toast.style.display = 'block';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { ui.toast.style.display = 'none'; }, ms);
    }

    // ---- Clickable elements ----------------------------------------------
    function isVisible(el, r) {
      if (r.width < 4 || r.height < 4) return false;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const top = document.elementFromPoint(cx, cy);
      return Boolean(top && (el === top || el.contains(top) || top.contains(el)));
    }

    function refreshTargets() {
      // The reader covers the page, so nothing underneath may be clicked.
      if (reader) {
        targets = [];
        return;
      }
      const next = [];
      for (const el of document.querySelectorAll(CLICKABLE)) {
        const r = el.getBoundingClientRect();
        if (!isVisible(el, r)) continue;
        // Only things that are themselves pressable: not a page section that happens
        // to have a tabindex, and not a wrapper around a real button or link.
        if (r.width * r.height > innerWidth * innerHeight * MAX_TARGET_VIEWPORT_SHARE) continue;
        if (el.querySelector(CLICKABLE)) continue;
        next.push({ el, rect: r });
      }
      targets = next;
    }

    // ---- Gaze -------------------------------------------------------------
    function screenToViewport(p) {
      return {
        x: p.x - window.screenX - (window.outerWidth - window.innerWidth) / 2,
        y: p.y - window.screenY - (window.outerHeight - window.innerHeight),
      };
    }

    function drawBox() {
      if (!target || !target.isConnected) {
        ui.box.style.display = 'none';
        return;
      }
      const r = target.getBoundingClientRect();
      ui.box.style.cssText = `display:block;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px`;
      ui.box.classList.toggle('risky', targetRisky);
    }

    const isRisky = (el) => RISKY.test(`${el.innerText || ''} ${el.value || ''} ${el.getAttribute('aria-label') || ''}`);

    function setTarget(el, now) {
      if (!el) holdAt = null;
      if (target) { lastTarget = target; lastTargetAt = now; }
      target = el;
      targetSince = now;
      targetRisky = Boolean(el && isRisky(el));
      if (el && targetRisky && settings.dwell) toast(t.risky);
      drawBox();
    }

    function moveByFlick(flick, now) {
      const list = targets;
      const rects = list.map((c) => c.rect);
      let from = list.find((c) => c.el === target)?.rect;
      if (!from) {
        const i = pickTarget(rects, gaze, FLICK_FIND_RADIUS_PX);
        if (i < 0) return;
        from = rects[i];
      }
      const next = neighbourIn(flickDirection(flick), from, rects);
      if (next < 0) return; // nothing that way: the highlight staying put says so
      // Choosing this item says the gaze was off by this much.
      learnDrift(gaze, list[next].el);
      setTarget(list[next].el, now);
      candidate = null;
      holdAt = { x: gaze.x, y: gaze.y };
    }

    function updateTarget(point, now) {
      const i = pickTarget(targets.map((c) => c.rect), point, SNAP_RADIUS);
      const el = i >= 0 ? targets[i].el : null;
      if (el === target) { candidate = null; return; }
      // Noise alone must not move the highlight. It leaves only once the gaze has
      // clearly left this item, and even then only for one the gaze settles on.
      if (target?.isConnected) {
        const r = target.getBoundingClientRect();
        const off = Math.hypot(Math.max(r.left - point.x, 0, point.x - r.right), Math.max(r.top - point.y, 0, point.y - r.bottom));
        if (off <= STICKY_PX) { candidate = null; return; }
      }
      if (el !== candidate) { candidate = el; candidateSince = now; return; }
      if (now - candidateSince >= SWITCH_MS) { candidate = null; setTarget(el, now); }
    }

    function drawRing(x, y, progress) {
      const deg = Math.round(progress * 360);
      ui.ring.style.cssText = `display:block;left:${x}px;top:${y}px;`
        + `background:conic-gradient(#0071e3 ${deg}deg, rgba(255,255,255,.75) ${deg}deg)`;
    }

    function updateDwell(now) {
      const idle = !settings.dwell || !target || targetRisky || agentRunning || numbered.length || recentering || reader || now < dwellBlockedUntil;
      if (idle) { ui.ring.style.display = 'none'; return; }
      const progress = (now - Math.max(targetSince, dwellBlockedUntil) - DWELL_START_DELAY_MS) / settings.dwellMs;
      if (progress < 0) { ui.ring.style.display = 'none'; return; }
      if (progress >= 1) {
        ui.ring.style.display = 'none';
        dwellBlockedUntil = now + DWELL_COOLDOWN_MS;
        activate(target); // a dwell can be accidental, so it teaches nothing about drift
        return;
      }
      const r = target.getBoundingClientRect();
      drawRing(r.left + r.width / 2, r.top + r.height / 2, progress);
    }

    function onFrame(msg) {
      const now = performance.now();
      if (settings.mouth && mouthGesture(Boolean(msg.face && msg.mouthOpen), now)) {
        dwellBlockedUntil = now + DWELL_COOLDOWN_MS; // what's under the gaze is about to move
        runCommand({ name: 'down' });
      }
      const model = activeModel();
      // Otherwise an uncalibrated tab just looks broken.
      if (msg.face && !model && !calibrateHintShown) {
        calibrateHintShown = true;
        toast(t.calibrateFirst, 5000);
      }
      if (!msg.face || paused || !model) {
        // Coming back must start a fresh dwell, not click on what the timer ran up.
        dwellBlockedUntil = now;
        if (target) setTarget(null, now);
        ui.ring.style.display = 'none';
        return;
      }
      // Normal blinks don't interrupt a dwell. Eyes shut for longer means the user
      // isn't looking at anything, so the timer must not keep running.
      if (msg.blink) {
        eyesClosedAt ??= now;
        if (now - eyesClosedAt > EYES_CLOSED_RESET_MS) dwellBlockedUntil = now;
        return; // hold position through blinks
      }
      eyesClosedAt = null;
      // Head motion throws the eye signals off, so gaze input stops until it's over:
      // the highlight, the dwell and the smoothing all carry on from before it.
      const motion = headFlick(msg.features[2], msg.features[3], now);
      if (motion.moving || motion.flick) gazeMutedUntil = now + HEAD_SETTLE_MS;
      // Talking moves the face and the eyes. The highlight stays, so "클릭" presses what
      // was being looked at. While the AI works the user may still be watching it.
      if (speaking && !agentRunning && !pendingAi) gazeMutedUntil = now + HEAD_SETTLE_MS;
      if (motion.flick && settings.flick && !msg.mouthOpen && !agentRunning && !recentering) moveByFlick(motion.flick, now);
      if (now < gazeMutedUntil) {
        dwellBlockedUntil = Math.max(dwellBlockedUntil, gazeMutedUntil);
        rawWindow = [];
        filter = createFilter();
        ui.ring.style.display = 'none';
        drawBox();
        return;
      }
      const raw = predict(model, msg.features);
      if (recentering?.collecting) recentering.samples.push(raw);
      // Median first: a single wild frame would otherwise jolt the highlight.
      rawWindow = [...rawWindow.slice(1 - RAW_WINDOW), raw];
      lastScreen = filter(median(rawWindow.map((p) => p.x)), median(rawWindow.map((p) => p.y)), now);
      const v = screenToViewport({ x: lastScreen.x + bias.x, y: lastScreen.y + bias.y });
      gaze = {
        x: Math.max(0, Math.min(innerWidth - 1, v.x)),
        y: Math.max(0, Math.min(innerHeight - 1, v.y)),
      };
      gazeAt = now;
      if (holdAt && Math.hypot(gaze.x - holdAt.x, gaze.y - holdAt.y) > HOLD_RELEASE_PX) holdAt = null;
      if (!holdAt) updateTarget(gaze, now);
      drawBox();
      updateDwell(now);
    }

    // ---- Actions ----------------------------------------------------------
    function activate(el) {
      if (!el?.isConnected) return;
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.focus?.({ preventScroll: true });
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      ui.box.classList.add('fire');
      setTimeout(() => ui.box.classList.remove('fire'), 200);
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40);
      toast(label ? `${t.clicked}: ${label}` : t.clicked, 1500);
      setTimeout(refreshTargets, 300);
    }

    // The click target, allowing for speech latency: by the time a command is
    // recognised the user may already have looked away from what they meant.
    function currentTarget() {
      if (target?.isConnected) return target;
      if (lastTarget?.isConnected && performance.now() - lastTargetAt < 2000) return lastTarget;
      return null;
    }

    // A gaze click tells us what the user was really looking at, so the gap between
    // the cursor and that item is measured drift. A cursor already on it teaches nothing.
    function clickByGaze(el) {
      if (lastScreen && gazeIsFresh()) learnDrift(gaze, el);
      activate(el);
    }

    function learnDrift(point, el) {
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left, Math.min(r.right, point.x)) - point.x;
      const dy = Math.max(r.top, Math.min(r.bottom, point.y)) - point.y;
      const limit = (v) => Math.max(-CLICK_BIAS_LIMIT, Math.min(CLICK_BIAS_LIMIT, v));
      // Capped: a run of clicks on wrong items must not walk the gaze off screen.
      if (dx || dy) saveBias({ x: limit(bias.x + dx * CLICK_LEARN_RATE), y: limit(bias.y + dy * CLICK_LEARN_RATE) });
    }

    function labelOf(el) {
      const isButtonInput = el.matches('input[type=button], input[type=submit]');
      const label = el.getAttribute('aria-label') || el.innerText?.trim() || (isButtonInput && el.value)
        || el.querySelector?.('img[alt]')?.alt || el.getAttribute('title') || el.getAttribute('placeholder') || '';
      return label.replace(/\s+/g, ' ');
    }

    function saveBias(next) {
      bias = next;
      chrome.storage.local.set({ gazeBias: next });
    }

    function median(values) {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }

    // One dot, two seconds: for when the user has shifted and the cursor is off.
    function recenter() {
      if (!activeModel()) { toast(t.calibrateFirst); return; }
      if (recentering) return;
      const point = { x: innerWidth / 2, y: innerHeight / 2 };
      hideNumbers();
      recentering = { samples: [], collecting: false };
      ui.recenter.style.cssText = `display:block;left:${point.x}px;top:${point.y}px`;
      toast(t.recenterLook, RECENTER_SETTLE_MS + RECENTER_COLLECT_MS);
      setTimeout(() => { if (recentering) recentering.collecting = true; }, RECENTER_SETTLE_MS);
      setTimeout(() => {
        const { samples } = recentering;
        recentering = null;
        ui.recenter.style.display = 'none';
        if (samples.length < RECENTER_MIN_SAMPLES) { toast(t.recenterFail); return; }
        // screenToViewport is a pure offset, so its inverse comes from a zero point.
        const origin = screenToViewport({ x: 0, y: 0 });
        const next = {
          x: point.x - origin.x - median(samples.map((s) => s.x)),
          y: point.y - origin.y - median(samples.map((s) => s.y)),
        };
        // An offset this big means the calibration itself is wrong. Saving it would
        // only hide that, and pin the gaze to a screen edge once anything changes.
        if (Math.hypot(next.x, next.y) > RECENTER_MAX_PX) { toast(t.recenterTooFar, 5000); return; }
        saveBias(next);
        toast(t.recenterDone);
      }, RECENTER_SETTLE_MS + RECENTER_COLLECT_MS);
    }

    // ---- Reader -----------------------------------------------------------
    function extractArticle() {
      const roots = [document.querySelector('article'), document.querySelector('main, [role=main]'), document.body];
      const read = (root) => {
        if (!root) return [];
        const out = [];
        for (const el of root.querySelectorAll('h1, h2, h3, p, li, blockquote')) {
          if (el.closest('nav, footer, aside, header, form, [role=navigation], [role=banner], [role=complementary]')) continue;
          if (el.parentElement?.closest('p, li, blockquote')) continue; // nested: the parent already has this text
          const text = el.innerText?.replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const heading = /^H[1-3]$/.test(el.tagName);
          if (!heading && text.length < READER_MIN_CHARS) continue;
          out.push({ text, heading });
          if (out.length >= READER_MAX_PARAGRAPHS) break;
        }
        return out;
      };
      return roots.map(read).find((list) => list.filter((p) => !p.heading).length >= 2) ?? [];
    }

    function renderParagraph(i, word = null) {
      const el = reader.els[i];
      if (!word) {
        el.textContent = reader.paragraphs[i].text;
        return;
      }
      const { text } = reader.paragraphs[i];
      const mark = document.createElement('mark');
      mark.textContent = text.slice(word.start, word.end);
      el.replaceChildren(text.slice(0, word.start), mark, text.slice(word.end));
    }

    function speakParagraph(i) {
      if (!reader) return;
      if (i >= reader.paragraphs.length) { reader.reading = false; return; }
      if (reader.index >= 0) {
        reader.els[reader.index].classList.remove('current');
        renderParagraph(reader.index);
      }
      reader.index = i;
      reader.reading = true;
      reader.speakId = `${Date.now()}-${i}`;
      reader.els[i].classList.add('current');
      reader.els[i].scrollIntoView({ block: 'center', behavior: scrollBehavior() });
      chrome.runtime.sendMessage({ type: 'tts-speak', id: reader.speakId, text: reader.paragraphs[i].text }).catch(() => {});
    }

    function onTtsEvent(msg) {
      if (!reader || msg.id !== reader.speakId) return; // stale paragraph
      if (msg.event === 'word') {
        const { text } = reader.paragraphs[reader.index];
        let end = msg.length ? msg.charIndex + msg.length : text.indexOf(' ', msg.charIndex);
        if (end < 0) end = text.length;
        renderParagraph(reader.index, { start: msg.charIndex, end });
      } else if (msg.event === 'end') {
        speakParagraph(reader.index + 1);
      } else if (msg.event === 'error') {
        reader.reading = false;
        toast(t.readerError);
      }
    }

    function openReader(speak) {
      if (reader) {
        if (speak && !reader.reading) speakParagraph(Math.max(reader.index, 0));
        return;
      }
      const paragraphs = extractArticle();
      if (!paragraphs.length) { toast(t.noArticle); return; }
      showInReader(paragraphs);
      if (speak) speakParagraph(0);
    }

    function showInReader(paragraphs) {
      if (reader?.reading) chrome.runtime.sendMessage({ type: 'tts-stop' }).catch(() => {});
      hideNumbers();
      setTarget(null, performance.now());
      lastTarget = null;
      const title = document.createElement('h1');
      title.textContent = document.title;
      const els = paragraphs.map((p) => {
        const el = document.createElement('div');
        if (p.heading) el.className = 'heading';
        el.textContent = p.text;
        return el;
      });
      ui.reader.replaceChildren(title, ...els);
      ui.reader.style.display = 'block';
      ui.reader.scrollTop = 0;
      reader = { paragraphs, els, index: -1, speakId: null, reading: false };
      refreshTargets();
    }

    // ---- AI (only runs on an explicit request, after ChatGPT sign-in) -------
    function startAi(task, text, extra = {}) {
      const id = `${Date.now()}`;
      pendingAi = { id, task, ...extra };
      chrome.runtime.sendMessage({ type: 'ai-request', id, task, text, count: extra.els?.length }).catch(() => {});
    }

    const articleText = (paragraphs) => `${document.title}\n\n${paragraphs.map((p) => p.text).join('\n')}`.slice(0, AI_MAX_CHARS);
    const toParagraphs = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => ({ text: line }));

    function requestSummary() {
      const paragraphs = extractArticle();
      if (!paragraphs.length) { toast(t.noArticle); return; }
      showInReader([{ text: t.summarizing }]);
      startAi('summary', articleText(paragraphs));
    }

    // The plain article shows at once and works without AI; easy wording replaces
    // it when ready. Not being signed in is a normal way to use this, not an error.
    function requestSimplify() {
      if (reader) return;
      const paragraphs = extractArticle();
      if (!paragraphs.length) { toast(t.noArticle); return; }
      showInReader(paragraphs);
      startAi('simplify', articleText(paragraphs));
    }

    // Only what the page shows as a label is sent. Never the value of a field,
    // which is what the user typed and could be a password.
    function describeElement(el) {
      return `[${el.tagName.toLowerCase()}] ${labelOf(el).slice(0, FIND_LABEL_CHARS)}`;
    }

    function requestFind({ query, click, text }) {
      refreshTargets();
      if (!targets.length) { toast(t.noElements); return; }
      const els = targets.slice(0, FIND_MAX_ITEMS).map((c) => c.el);
      const items = els.map((el, i) => `${i}: ${describeElement(el)}`).join('\n');
      toast(t.finding(query), 8000);
      startAi('find', `${query}\n\n${items}`, { els, query, click, text });
    }

    // A wrong guess must not be able to pay or delete something, so risky items
    // and ambiguous matches go through the numbered labels instead of a click.
    function finishFind({ els, query, click, text }, matches) {
      const found = matches.map((i) => els[i]).filter((el) => el?.isConnected);
      if (!found.length) {
        // "지메일 열어줘" isn't on this page, but it's still something the AI can do.
        if (click && text && settings.agent) startAgent(text);
        else toast(t.notFound(query), 4000);
        return;
      }
      if (click && found.length === 1 && !isRisky(found[0])) { activate(found[0]); return; }
      drawBadges(found);
      toast(found.length === 1 && isRisky(found[0]) ? t.riskyNumber : t.numbersHint, 6000);
    }

    // ---- AI task runner: the background script decides, this does and shows ----
    let agentEls = [];
    let agentRunning = false;

    function agentSnapshot() {
      refreshTargets();
      agentEls = targets.slice(0, FIND_MAX_ITEMS).map((c) => c.el);
      const describe = (el) => {
        if (isSensitiveField(el)) return `${describeElement(el)} (비밀번호·결제 칸: 입력 금지)`;
        return isEditable(el) ? `${describeElement(el)} (입력 칸)` : describeElement(el);
      };
      return {
        title: document.title,
        // No query string: it can hold tokens and search history the AI doesn't need.
        url: location.origin + location.pathname,
        items: agentEls.map((el, i) => `${i}: ${describe(el)}`),
      };
    }

    const isEditable = (e) => e && (e.isContentEditable || e.matches?.('textarea, input:not([type=button],[type=submit],[type=checkbox],[type=radio])'));
    const isSensitiveField = (e) => e.matches?.('input[type=password], [autocomplete^="cc-"], [autocomplete="current-password"], [autocomplete="new-password"]');

    function agentAct(act) {
      if (act.action === 'scroll') {
        scrollPage(innerHeight * 0.7);
        return { ok: true };
      }
      const el = agentEls[act.index];
      if (!el?.isConnected) return { ok: false };
      if (act.action === 'click') {
        if (isRisky(el)) {
          drawBadges([el]);
          toast(t.riskyNumber, 10000);
          return { blocked: 'risky' };
        }
        activate(el);
        return { ok: true };
      }
      if (isSensitiveField(el)) {
        toast(t.agentSensitive, 8000);
        return { blocked: 'sensitive' };
      }
      if (!isEditable(el)) return { ok: false };
      el.focus();
      if (!document.execCommand('insertText', false, act.text) && 'value' in el) {
        el.value += act.text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { ok: true };
    }

    function onAgentStatus(msg) {
      agentRunning = Boolean(msg.running);
      if (msg.running) hideNumbers();
      const text = msg.text ?? (msg.key && t[msg.key]);
      if (text) toast(text, msg.running ? 15000 : 8000);
      else if (!msg.running && !msg.blocked) ui.toast.style.display = 'none';
    }

    function startAgent(goal) {
      if (!settings.agent) { toast(t.agentOff); return; }
      chrome.runtime.sendMessage({ type: 'agent-start', goal }).catch(() => {});
    }

    function onAiEvent(msg) {
      if (msg.id !== pendingAi?.id) return; // cancelled, or a newer request
      const pending = pendingAi;
      if (msg.error) {
        pendingAi = null;
        const signIn = msg.error === 'not_signed_in';
        if (pending.task === 'summary') closeReader();
        if (!signIn || pending.task !== 'simplify') toast(signIn ? t.signInFirst : `${t.aiError} (${msg.error})`, 5000);
        return;
      }
      if (!msg.done) {
        if (pending.task === 'summary' && reader) reader.els[0].textContent = msg.text;
        if (pending.task === 'simplify' && !pending.announced) {
          pending.announced = true;
          toast(t.simplifying);
        }
        return;
      }
      pendingAi = null;
      if (pending.task === 'find') {
        finishFind(pending, msg.matches ?? []);
        return;
      }
      if (!reader) return;
      showInReader(toParagraphs(msg.text));
      if (pending.task === 'summary') speakParagraph(0);
    }

    function closeReader() {
      if (pendingAi?.task !== 'find') pendingAi = null;
      if (!reader) return;
      if (reader.reading) chrome.runtime.sendMessage({ type: 'tts-stop' }).catch(() => {});
      reader = null;
      ui.reader.style.display = 'none';
      ui.reader.replaceChildren();
      refreshTargets();
    }

    function scrollerAt(point) {
      if (reader) return ui.reader;
      let el = point ? document.elementFromPoint(point.x, point.y) : null;
      while (el && el !== document.body && el !== document.documentElement) {
        const { overflowY } = getComputedStyle(el);
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
        el = el.parentElement;
      }
      return document.scrollingElement || document.documentElement;
    }

    const scrollBehavior = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

    function scrollPage(amount) {
      scrollerAt(gazeIsFresh() ? gaze : null).scrollBy({ top: amount, behavior: scrollBehavior() });
    }

    function scrollEdge(toBottom) {
      const el = scrollerAt(gazeIsFresh() ? gaze : null);
      el.scrollTo({ top: toBottom ? el.scrollHeight : 0, behavior: scrollBehavior() });
    }

    const gazeIsFresh = () => gaze && performance.now() - gazeAt < GAZE_TIMEOUT_MS;

    function hideNumbers() {
      numbered = [];
      ui.badges.replaceChildren();
      clearTimeout(numbersTimer);
    }

    function addBadge(el, i) {
      const r = el.getBoundingClientRect();
      const b = document.createElement('div');
      b.className = 'badge';
      b.textContent = i + 1;
      b.style.left = `${Math.max(2, Math.min(innerWidth - 40, r.left - 6))}px`;
      b.style.top = `${Math.max(2, Math.min(innerHeight - 34, r.top - 10))}px`;
      ui.badges.appendChild(b);
    }

    function showNumbers() {
      refreshTargets();
      hideNumbers();
      if (!targets.length) { toast(t.noElements); return; }
      let list = targets;
      if (gazeIsFresh()) {
        const dist = ({ rect: r }) => Math.hypot(r.left + r.width / 2 - gaze.x, r.top + r.height / 2 - gaze.y);
        list = [...targets].sort((a, b) => dist(a) - dist(b)).slice(0, NUMBERS_NEAR_GAZE);
      } else {
        list = targets.slice(0, NUMBERS_MAX);
      }
      drawBadges(list.map((c) => c.el));
      toast(t.numbersHint);
    }

    function drawBadges(els) {
      hideNumbers();
      numbered = els;
      els.forEach(addBadge);
      numbersTimer = setTimeout(hideNumbers, 20000);
    }

    function typeText(text) {
      let el = document.activeElement;
      const editable = (e) => e && (e.isContentEditable || e.matches?.('textarea, input:not([type=button],[type=submit],[type=checkbox],[type=radio])'));
      if (!editable(el)) {
        const cur = currentTarget();
        if (!editable(cur)) { toast(t.noField); return; }
        el = cur;
        el.focus();
      }
      // execCommand goes through the browser's input path, so React-style
      // controlled inputs see it. Direct value assignment would be overwritten.
      if (!document.execCommand('insertText', false, text) && 'value' in el) {
        el.value += text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      toast(text);
    }

    function showHelp() {
      ui.help.replaceChildren();
      const h = document.createElement('h2');
      h.textContent = t.helpTitle;
      ui.help.appendChild(h);
      for (const [phrase, meaning] of t.help) {
        const row = document.createElement('div');
        const b = document.createElement('b');
        const s = document.createElement('span');
        b.textContent = phrase;
        s.textContent = meaning;
        row.append(b, s);
        ui.help.appendChild(row);
      }
      ui.help.style.display = 'block';
    }

    function runCommand(cmd) {
      if (paused && cmd.name !== 'resume') return;
      switch (cmd.name) {
        case 'click': {
          // A highlight left over from an unusable model says nothing about the gaze.
          if (!activeModel()) { toast(t.calibrateFirst); break; }
          const el = currentTarget();
          if (el) clickByGaze(el);
          else toast(activeModel() ? t.noTarget : t.calibrateFirst);
          break;
        }
        case 'number': {
          if (!numbered.length) break; // bare numbers mean nothing without badges
          const el = numbered[cmd.n - 1];
          if (el) { activate(el); hideNumbers(); } else toast(t.noNumber);
          break;
        }
        case 'down': scrollPage(innerHeight * 0.7); break;
        case 'up': scrollPage(-innerHeight * 0.7); break;
        case 'top': scrollEdge(false); break;
        case 'bottom': scrollEdge(true); break;
        case 'back': history.back(); break;
        case 'forward': history.forward(); break;
        case 'reload': location.reload(); break;
        case 'numbers': showNumbers(); break;
        case 'hide':
          hideNumbers();
          closeReader();
          ui.help.style.display = 'none';
          chrome.runtime.sendMessage({ type: 'agent-stop' }).catch(() => {});
          break;
        case 'read': openReader(true); break;
        case 'simplify': requestSimplify(); break;
        case 'summarize': requestSummary(); break;
        case 'find': requestFind(cmd); break;
        case 'recenter': recenter(); break;
        case 'agent': startAgent(cmd.goal); break;
        case 'pause':
          paused = true;
          chrome.runtime.sendMessage({ type: 'agent-stop' }).catch(() => {});
          hideNumbers();
          closeReader();
          setTarget(null, performance.now());
          toast(t.paused);
          break;
        case 'resume':
          if (paused) { paused = false; toast(t.resumed); }
          break;
        case 'type': typeText(cmd.text); break;
        case 'help': showHelp(); break;
      }
    }

    // ---- Wiring -----------------------------------------------------------
    const pageEvents = new AbortController();
    const diag = { frames: 0, face: 0, commands: 0 };

    const onRuntimeMessage = (msg, _sender, sendResponse) => {
      if (!settings.enabled) return;
      if (msg.type === 'agent-snapshot') { sendResponse(agentSnapshot()); return; }
      if (msg.type === 'agent-act') { sendResponse(agentAct(msg.act)); return; }
      if (msg.type === 'agent-status') { onAgentStatus(msg); return; }
      if (msg.type === 'frame') {
        diag.frames++;
        if (msg.face) diag.face++;
        onFrame(msg);
      } else if (msg.type === 'command') diag.commands++;
      if (msg.type === 'frame') return;
      if (msg.type === 'speech') {
        speaking = msg.active;
        clearTimeout(speakingTimer);
        // Chrome doesn't always report the end of speech; eyes must never stay off.
        if (speaking) speakingTimer = setTimeout(() => { speaking = false; }, SPEECH_MAX_MS);
        return;
      }
      if (msg.type === 'tts-event') onTtsEvent(msg);
      else if (msg.type === 'ai-event') onAiEvent(msg);
      else if (msg.type === 'command') {
        if (msg.command.name !== 'click' && msg.command.name !== 'number') toast(msg.transcript, 1500);
        runCommand(msg.command);
      } else if (msg.type === 'transcript') toast(msg.transcript, 1200);
      else if (msg.type === 'voice-error' && msg.error !== 'network') toast(msg.error === 'not-allowed' || msg.error === 'service-not-allowed' ? t.voiceDenied : `${t.voiceError} (${msg.error})`);
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    function clearOverlay() {
      hideNumbers();
      closeReader();
      setTarget(null, performance.now());
      ui.ring.style.display = 'none';
      ui.help.style.display = 'none';
    }

    function applyStored({ settings: s, model: m, gazeBias: b }) {
      if (b !== undefined) bias = b ?? { x: 0, y: 0 };
      if (s !== undefined) {
        // Start the dwell timer fresh, or switching dwell on would instantly
        // click whatever the user happens to be looking at.
        if (s.dwell && !settings.dwell) dwellBlockedUntil = performance.now();
        settings = { ...NUNGIL_DEFAULTS, ...s };
        if (!settings.enabled) clearOverlay();
      }
      if (m !== undefined) {
        eyeModel = m;
        filter = createFilter();
      }
    }

    chrome.storage.local.get(['settings', 'model', 'gazeBias']).then(applyStored);
    addEventListener('pagehide', () => {
      if (reader?.reading) chrome.runtime.sendMessage({ type: 'tts-stop' }).catch(() => {});
    }, { signal: pageEvents.signal });
    const onStorageChange = (changes, area) => {
      if (area !== 'local') return;
      if (changes.settings) applyStored({ settings: changes.settings.newValue ?? {} });
      if (changes.model) applyStored({ model: changes.model.newValue ?? null });
      if (changes.gazeBias) applyStored({ gazeBias: changes.gazeBias.newValue ?? null });
    };
    chrome.storage.onChanged.addListener(onStorageChange);

    refreshTargets();
    const refreshTimer = setInterval(() => { if (settings.enabled && !document.hidden) refreshTargets(); }, 400);
    addEventListener('scroll', () => { hideNumbers(); refreshTargets(); }, { capture: true, passive: true, signal: pageEvents.signal });
    addEventListener('resize', refreshTargets, { passive: true, signal: pageEvents.signal });

    // Numbers only, so a problem on the user's machine can be traced without guessing.
    const diagTimer = setInterval(() => {
      if (document.hidden) return;
      chrome.runtime.sendMessage({
        type: 'diag-page',
        page: {
          ...diag,
          enabled: settings.enabled,
          model: Boolean(activeModel()),
          calibration: { all: activeModel()?.errorPx, x: activeModel()?.errorX, y: activeModel()?.errorY },
          gaze: gaze && { x: Math.round(gaze.x), y: Math.round(gaze.y) },
          viewport: { w: innerWidth, h: innerHeight },
          targets: targets.length,
          hasTarget: Boolean(target),
          paused,
          bias,
        },
      }).catch(() => {});
    }, 2000);

    window.__nungilDispose = () => {
      clearInterval(refreshTimer);
      clearInterval(diagTimer);
      pageEvents.abort();
      try {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
        chrome.storage.onChanged.removeListener(onStorageChange);
      } catch { /* this copy is already cut off from the extension */ }
      host.remove();
    };
  })();
}
