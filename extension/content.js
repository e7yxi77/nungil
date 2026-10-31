// Page overlay: turns gaze frames into a highlighted target and runs voice commands.
{
  // An extension reload cuts off the running copy but keeps its isolated world, so
  // a plain "already loaded" flag would leave a dead copy in charge of this tab.
  // A newly injected copy always takes over instead.
  window.__nungilDispose?.();
  (() => {
    const { predict, createFilter, pickTarget, createHoldGesture, createHeadFlick, createHeadAssist, flickDirection, neighbourIn, applyCorrection, fitCorrection, isSteady } = GazeModel;

    const SNAP_MIN_PX = 150;
    const SNAP_MAX_PX = 300;
    const SWITCH_MS = 220;
    const DWELL_START_DELAY_MS = 500; // looking around shouldn't start a countdown
    const STICKY_PX = 80;
    const HOLD_RELEASE_PX = 220;
    const HEAD_SETTLE_MS = 250;
    const SPOKEN_CLICK_GAZE_MS = 6000;
    const SPOKEN_CLICK_RADIUS_PX = 400;
    const SPEECH_MAX_MS = 4000;
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
    const PRESS_AFTER_FIND_MS = 450;
    const NAMED_MAX_CHOICES = 9;
    const RECENTER_SETTLE_MS = 900;
    const RECENTER_COLLECT_MS = 1100;
    const RECENTER_KEEP_SAMPLES = 12;
    const RECENTER_GIVE_UP_MS = 4000;
    const RECENTER_MAX_ATTEMPTS = 3;
    const RECENTER_RETRY_MS = 1500;
    const QUICK_DOTS = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
    const FACE_GONE_MS = 2000;
    const RECENTER_MAX_PX = 500;
    const NUMBERS_NEAR_GAZE = 9;
    const NUMBERS_MAX = 40;
    const CLICKABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,label[for],'
      + '[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=radio],'
      + '[onclick],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
    // Word boundaries on the English ones: "display" contains "pay", "border" contains "order".
    const RISKY = /결제|구매|주문|송금|이체|삭제|탈퇴|전송|보내기|\b(pay|buy|purchase|checkout|order|delete|remove|send|transfer)\b/i;

    let settings = { ...NUNGIL_DEFAULTS };
    let eyeModel = null;
    const usable = (m) => (m?.version === NUNGIL_MODEL_VERSION ? m : null);
    const activeModel = () => usable(eyeModel);
    let bias = { x: 0, y: 0 }; // corrects drift since calibration: offset, and optionally scale
    let lastScreen = null; // smoothed gaze before bias
    let recentering = null; // { samples, collecting, point }
    const t = nungilStrings();

    let filter = createFilter();
    const mouthGesture = createHoldGesture(MOUTH_MS, { repeatMs: MOUTH_REPEAT_MS });
    let rawWindow = [];
    const headFlick = createHeadFlick();
    let holdAt = null; // where the gaze was when a flick chose the current item
    let gazeMutedUntil = 0;
    let needsRecenter = false;
    let recenterAttempts = 0;
    let lastRealign = null;
    let faceGoneAt = null;
    let recenterRetryAt = 0;
    let headAssist = null;
    let assistFor = null;
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
        .veil { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); -webkit-backdrop-filter: blur(16px) saturate(120%); backdrop-filter: blur(16px) saturate(120%); opacity: 0; visibility: hidden; transition: opacity .3s ease, visibility .3s; }
        .veil.on { opacity: 1; visibility: visible; }
        .recenter { transition: left .4s cubic-bezier(.2, .8, .2, 1), top .4s cubic-bezier(.2, .8, .2, 1); position: fixed; display: none; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; background: #0a84ff; border: 4px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .3), 0 0 32px rgba(10, 132, 255, .9); }
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
          .veil { background: rgba(0, 0, 0, .8); -webkit-backdrop-filter: none; backdrop-filter: none; }
          .help { background: #fff; -webkit-backdrop-filter: none; backdrop-filter: none; }
        }
        @media (prefers-contrast: more) {
          .box { box-shadow: 0 0 0 4px #000, 0 0 0 7px #fff; }
        }
      </style>
      <div class="reader"></div>
      <div class="box"></div>
      <div class="ring"></div>
      <div class="veil"></div>
      <div class="recenter"></div>
      <div class="badges"></div>
      <div class="help" role="dialog"></div>
      <div class="toast" role="status" aria-live="polite"></div>`;
    const $ = (s) => root.querySelector(s);
    const ui = { box: $('.box'), ring: $('.ring'), badges: $('.badges'), reader: $('.reader'), recenter: $('.recenter'), veil: $('.veil'), toast: $('.toast'), help: $('.help') };
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
      setTarget(list[next].el, now);
      candidate = null;
      holdAt = { x: gaze.x, y: gaze.y };
    }

    // As forgiving as this user's calibration needs: gaze is only ever this close.
    const snapRadius = () => Math.max(SNAP_MIN_PX, Math.min(SNAP_MAX_PX, (activeModel()?.errorPx ?? 0) * 1.3));

    function updateTarget(point, now) {
      const i = pickTarget(targets.map((c) => c.rect), point, snapRadius());
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
        activate(target);
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
      // Someone who left the camera's view comes back sitting differently.
      if (!msg.face) faceGoneAt ??= now;
      else if (faceGoneAt !== null) {
        if (now - faceGoneAt >= FACE_GONE_MS && model && !paused && !agentRunning) {
          needsRecenter = true;
          chrome.storage.local.set({ needsRecenter: true });
        }
        faceGoneAt = null;
      }
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
      if (assistFor !== model) {
        assistFor = model;
        headAssist = createHeadAssist(model);
      }
      const shift = headAssist(msg.features, now, motion.moving || Boolean(motion.flick));
      if (motion.moving || motion.flick) gazeMutedUntil = now + HEAD_SETTLE_MS;
      // Talking moves the face and the eyes. The highlight stays, so "클릭" presses what
      // was being looked at. While the AI works the user may still be watching it.
      if (speaking && !agentRunning && !pendingAi) gazeMutedUntil = now + HEAD_SETTLE_MS;
      if (motion.flick && settings.flick && !msg.mouthOpen && !agentRunning && !recentering) moveByFlick(motion.flick, now);
      if (now < gazeMutedUntil) {
        diag.muted = (diag.muted ?? 0) + 1;
        dwellBlockedUntil = Math.max(dwellBlockedUntil, gazeMutedUntil);
        rawWindow = [];
        filter = createFilter();
        ui.ring.style.display = 'none';
        drawBox();
        return;
      }
      const eyes = predict(model, msg.features);
      const raw = settings.headAssist ? { x: eyes.x + shift.x, y: eyes.y + shift.y } : eyes;
      if (recentering?.collecting) recentering.samples.push(raw);
      // Required after being turned back on: no gaze clicks until it's done.
      if (needsRecenter) {
        if (target) setTarget(null, now);
        ui.ring.style.display = 'none';
        if (!recentering && now >= recenterRetryAt && !document.hidden) {
          if (needsRecenter === 'quick') quickCalibrate();
          else recenter(t.recenterRequired);
        }
        return;
      }
      // Median first: a single wild frame would otherwise jolt the highlight.
      rawWindow = [...rawWindow.slice(1 - RAW_WINDOW), raw];
      lastScreen = filter(median(rawWindow.map((p) => p.x)), median(rawWindow.map((p) => p.y)), now);
      const v = screenToViewport(applyCorrection(bias, lastScreen));
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

    function labelOf(el) {
      const isButtonInput = el.matches('input[type=button], input[type=submit]');
      const label = el.getAttribute('aria-label') || el.innerText?.trim() || (isButtonInput && el.value)
        || el.querySelector?.('img[alt]')?.alt || el.getAttribute('title') || el.getAttribute('placeholder') || '';
      return label.replace(/\s+/g, ' ');
    }

    // "클릭" with nothing highlighted still means the closest thing being looked at. Gaze
    // pauses during speech, so its last reading counts for a while after it stops updating.
    function nearestToGaze() {
      if (!gaze || performance.now() - gazeAt > SPOKEN_CLICK_GAZE_MS) return null;
      const i = pickTarget(targets.map((c) => c.rect), gaze, SPOKEN_CLICK_RADIUS_PX);
      return i >= 0 ? targets[i].el : null;
    }

    function saveBias(next) {
      bias = next;
      chrome.storage.local.set({ gazeBias: next });
    }

    function median(values) {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }

    function hideDot() {
      ui.recenter.style.display = 'none';
      ui.veil.classList.remove('on');
    }

    // Shows a dot and waits until the gaze has actually settled, keeping only those
    // readings. Measuring on a timer alone records wherever the user happened to be
    // looking, and saves that as a correction. Resolves false if it never settles.
    async function collectAt(point, samples) {
      ui.veil.classList.add('on');
      ui.recenter.style.cssText = `display:block;left:${point.x}px;top:${point.y}px`;
      recentering = { samples: [], collecting: false };
      await new Promise((resolve) => setTimeout(resolve, RECENTER_SETTLE_MS));
      recentering.collecting = true;
      const started = performance.now();
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const seen = recentering.samples;
        const elapsed = performance.now() - started;
        if (elapsed >= RECENTER_COLLECT_MS && isSteady(seen)) {
          samples.push(...seen.slice(-RECENTER_KEEP_SAMPLES));
          return true;
        }
        if (elapsed > RECENTER_GIVE_UP_MS) return false;
      }
    }

    const viewportToScreen = (p) => {
      const origin = screenToViewport({ x: 0, y: 0 });
      return { x: p.x - origin.x, y: p.y - origin.y };
    };

    // A failed attempt tries again, but never forever: that would lock the user out.
    function retryLater() {
      recenterAttempts += 1;
      recenterRetryAt = performance.now() + RECENTER_RETRY_MS;
      if (recenterAttempts >= RECENTER_MAX_ATTEMPTS) {
        recenterAttempts = 0;
        chrome.storage.local.remove('needsRecenter');
        toast(t.recenterTooFar, 5000);
        return;
      }
      toast(t.recenterFail);
    }

    function finishRealign(kind, next, ok) {
      lastRealign = { kind, ok, at: Date.now(), ...(next ?? {}) };
      recenterAttempts = 0;
      chrome.storage.local.remove('needsRecenter');
      if (ok) {
        saveBias(next);
        toast(t.recenterDone);
      }
    }

    // One dot, two seconds: fixes an offset, for when the user has only shifted a little.
    async function recenter(prompt = t.recenterLook) {
      if (!activeModel()) { toast(t.calibrateFirst); return; }
      if (recentering) return;
      hideNumbers();
      toast(prompt, RECENTER_SETTLE_MS + RECENTER_COLLECT_MS);
      const samples = [];
      const point = { x: innerWidth / 2, y: innerHeight / 2 };
      const settled = await collectAt(point, samples);
      recentering = null;
      hideDot();
      if (!settled) { retryLater(); return; }
      const target = viewportToScreen(point);
      const seen = { x: median(samples.map((p) => p.x)), y: median(samples.map((p) => p.y)) };
      const scaled = applyCorrection({ ...bias, x: 0, y: 0 }, seen);
      const next = { ...bias, x: target.x - scaled.x, y: target.y - scaled.y };
      // An offset this big means the eyes weren't on the dot, or the calibration itself is
      // off. Saving it would only pin the gaze to a screen edge.
      if (Math.hypot(next.x, next.y) > RECENTER_MAX_PX) {
        lastRealign = { kind: 'dot', ok: false, ...next };
        if (needsRecenter) retryLater();
        else toast(t.recenterTooFar, 5000); // asked for by hand: say so, don't keep at it
        return;
      }
      finishRealign('dot', next, true);
    }

    // Four dots, about six seconds: fixes offset and scale without redoing calibration,
    // for when the user has sat down again or come back after a while.
    async function quickCalibrate() {
      if (!activeModel()) { toast(t.calibrateFirst); return; }
      if (recentering) return;
      hideNumbers();
      const pairs = [];
      for (const [i, [fx, fy]] of QUICK_DOTS.entries()) {
        toast(t.quickLook(i + 1, QUICK_DOTS.length), RECENTER_SETTLE_MS + RECENTER_COLLECT_MS);
        const point = { x: innerWidth * fx, y: innerHeight * fy };
        const samples = [];
        const settled = await collectAt(point, samples);
        if (!settled) {
          recentering = null;
          hideDot();
          retryLater();
          return;
        }
        const target = viewportToScreen(point);
        pairs.push({ seenX: median(samples.map((p) => p.x)), seenY: median(samples.map((p) => p.y)), x: target.x, y: target.y });
      }
      recentering = null;
      hideDot();
      const next = fitCorrection(pairs);
      if (!next) { lastRealign = { kind: 'four', ok: false, pairs: pairs.length }; retryLater(); return; }
      finishRealign('four', next, true);
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

    // Everything pressable on the page, on screen or not, and whether or not something
    // happens to sit above it. Looser than what gaze may land on, with on-screen items
    // first: a list that misses real buttons leaves the AI with nothing to press.
    function findPool() {
      const seen = [];
      for (const el of document.querySelectorAll(CLICKABLE)) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (r.width * r.height > innerWidth * innerHeight * MAX_TARGET_VIEWPORT_SHARE) continue;
        if (el.querySelector(CLICKABLE)) continue;
        seen.push({ el, onScreen: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth });
      }
      return [...seen.filter((c) => c.onScreen), ...seen.filter((c) => !c.onScreen)].map((c) => c.el);
    }

    const squash = (text) => text.toLowerCase().replace(/[\s"'.,!?·:()[\]]/g, '');
    const NOUN_ENDINGS = /(버튼|링크|메뉴|항목|탭|페이지|을|를|으로|로)+$/;

    // A button named out loud needs no AI: the page already says what it's called.
    function matchByName(query, pool) {
      const wanted = squash(query).replace(NOUN_ENDINGS, '') || squash(query);
      const named = pool.map((el) => ({ el, label: squash(labelOf(el)) })).filter((c) => c.label);
      const exact = named.filter((c) => c.label === wanted);
      const hits = exact.length ? exact : named.filter((c) => c.label.includes(wanted));
      return hits.map((c) => c.el);
    }

    // Goes to a button that may be off screen, and shows which one before pressing it.
    function goAndPress(el) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      refreshTargets();
      setTarget(el, performance.now());
      holdAt = gaze && { x: gaze.x, y: gaze.y };
      setTimeout(() => activate(el), PRESS_AFTER_FIND_MS);
    }

    function pressFound(found, click) {
      if (click && found.length === 1 && !isRisky(found[0])) { goAndPress(found[0]); return; }
      found[0].scrollIntoView({ block: 'nearest', behavior: 'instant' });
      drawBadges(found);
      toast(found.length === 1 && isRisky(found[0]) ? t.riskyNumber : t.numbersHint, 6000);
    }

    function requestFind({ query, click, text }) {
      const pool = findPool();
      if (!pool.length) {
        if (click && text && settings.agent) startAgent(text);
        else toast(t.noElements);
        return;
      }
      const named = matchByName(query, pool);
      if (named.length === 1 || (named.length > 1 && named.length <= NAMED_MAX_CHOICES && !click)) {
        pressFound(named, click);
        return;
      }
      const els = pool.slice(0, FIND_MAX_ITEMS);
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
      pressFound(found, click);
    }

    // ---- AI task runner: the background script decides, this does and shows ----
    let agentEls = [];
    let agentRunning = false;

    function agentSnapshot() {
      agentEls = findPool().slice(0, FIND_MAX_ITEMS);
      const describe = (el) => {
        if (isSensitiveField(el)) return `${describeElement(el)} (비밀번호·결제 칸: 입력 금지)`;
        return isEditable(el) ? `${describeElement(el)} (입력 칸)` : describeElement(el);
      };
      return {
        title: document.title,
        // No query string: it can hold tokens and search history the AI doesn't need.
        url: location.origin + location.pathname,
        scrollY: Math.round(scrollY),
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
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
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

    // Unprompted speech must stay out of the way: no replacing a running task, and no
    // nagging about settings for what may just have been someone talking nearby.
    function startAgent(goal, explicit = true) {
      if (!explicit && (agentRunning || !settings.agent)) return;
      if (!settings.agent) { toast(t.agentOff); return; }
      chrome.runtime.sendMessage({ type: 'agent-start', goal, quiet: !explicit }).catch(() => {});
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
          // Until the gaze is realigned, it can't say what "this" is.
          if (needsRecenter) { toast(t.recenterRequired); break; }
          const el = currentTarget() ?? nearestToGaze();
          if (el) activate(el);
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
        case 'quickCalibrate': quickCalibrate(); break;
        case 'agent': startAgent(cmd.goal, cmd.wake !== false); break;
        case 'wake': toast(settings.agent ? t.wakeListening : t.agentOff, 8000); break;
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
      if (msg.type === 'notice') { toast(t[msg.key], 5000); return; }
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

    function applyStored({ settings: s, model: m, gazeBias: b, needsRecenter: n }) {
      if (n !== undefined) needsRecenter = n || false;
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

    chrome.storage.local.get(['settings', 'model', 'gazeBias', 'needsRecenter']).then(applyStored);
    addEventListener('pagehide', () => {
      if (reader?.reading) chrome.runtime.sendMessage({ type: 'tts-stop' }).catch(() => {});
    }, { signal: pageEvents.signal });
    const onStorageChange = (changes, area) => {
      if (area !== 'local') return;
      if (changes.settings) applyStored({ settings: changes.settings.newValue ?? {} });
      if (changes.model) applyStored({ model: changes.model.newValue ?? null });
      if (changes.gazeBias) applyStored({ gazeBias: changes.gazeBias.newValue ?? null });
      if (changes.needsRecenter) applyStored({ needsRecenter: changes.needsRecenter.newValue ?? false });
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
          lastRealign,
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
