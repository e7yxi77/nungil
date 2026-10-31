// The scroll film. Scroll position becomes a time T from 0 to 5 (one unit per scene),
// and everything on screen is a pure function of T, so scrubbing backwards just works.
// If anything here fails, the page stays a plain readable document (no .has-3d).
import * as THREE from './vendor/three.module.min.js';
import { createScreen, createPanel, paintUnified, RECTS, W, H, PANEL_W, PANEL_H, PANEL_STEP_Y } from './film-screen.js';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const COARSE = matchMedia('(pointer: coarse)').matches;
const LOW = COARSE || (navigator.hardwareConcurrency || 8) <= 4;
const STILLS = [0.2, 1.8, 2.96, 3.92, 5]; // Reduced motion shows one finished frame per scene.

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const smooth = (x) => x * x * (3 - 2 * x);
const ease = (t, a, b) => smooth(seg(t, a, b));
const mix = (a, b, x) => a + (b - a) * x;
const NAVY = 0x050a18;

const SCREEN = { w: 0.72, h: 0.405, x: 0, y: 1.13, z: -0.42 };
const HEAD = new THREE.Vector3(0, 1.21, 0.5);
const FINAL = new THREE.Vector3(0, 1.3, 0.2);

function start() {
  const gl = document.getElementById('gl');
  const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, powerPreference: 'high-performance' });
  document.documentElement.classList.add('has-3d');
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = !LOW;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  let dprCap = LOW ? 1.5 : 2;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(NAVY);
  scene.fog = new THREE.FogExp2(NAVY, 0.05);
  scene.environment = makeEnvironment(renderer);
  scene.environmentIntensity = 0.55;
  const camera = new THREE.PerspectiveCamera(38, 1, 0.02, 40);

  const room = buildRoom(scene);
  const person = buildPerson(scene);
  const screen = createScreen(LOW ? 1280 : 2048);
  const screenTex = canvasTexture(screen.canvas, renderer);
  buildMonitor(scene, screenTex);
  const fx = buildEffects(scene, renderer);
  const finale = buildFinale(scene, renderer);

  let keys = [];
  const size = { w: 1, h: 1 };
  // How much of the last shot the closing copy leaves free, as fractions of the screen height.
  function finalRoom() {
    const pin = document.querySelector('.beat-final .pin');
    const h = pin.offsetHeight || innerHeight;
    const top = 60 / h, bottom = (pin.querySelector('.copy').offsetTop - 16) / h;
    return { size: Math.max(0.12, bottom - top), center: (top + bottom) / 2 };
  }
  function resize() {
    const w = gl.parentElement.clientWidth, h = gl.parentElement.clientHeight;
    if (w === size.w && Math.abs(h - size.h) < 120 && keys.length) return; // mobile URL bar shouldn't re-frame the shot
    size.w = w; size.h = h;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    keys = cameraKeys(camera.aspect, finalRoom());
    measure();
    dirty = true;
  }

  // --- Scroll to T ---
  const beats = [...document.querySelectorAll('.beat')];
  const pins = beats.map((b) => b.querySelector('.pin'));
  const film = document.getElementById('film');
  const bar = document.getElementById('bar');
  const shade = document.getElementById('shade');
  const trail = [...document.querySelectorAll('#trail li')];
  const said = [...document.querySelectorAll('#said li')];
  const transcript = document.querySelector('#transcript span');
  let spans = [];
  function measure() {
    const top = film.getBoundingClientRect().top + scrollY;
    spans = beats.map((b, i) => {
      const r = b.getBoundingClientRect();
      const t0 = r.top + scrollY;
      return { t0, len: r.height - pins[i].offsetHeight };
    });
    filmEnd = top + film.offsetHeight;
  }
  let filmEnd = 0;
  function scrollT() {
    const y = scrollY;
    for (let i = spans.length - 1; i >= 0; i--) {
      if (y >= spans[i].t0) return Math.min(5, i + (y - spans[i].t0) / spans[i].len);
    }
    return 0;
  }
  function targetT() {
    const t = scrollT();
    return REDUCED ? STILLS[Math.min(4, Math.floor(t))] : t;
  }

  // --- The frame ---
  let T = targetT();
  let dirty = true;
  let visible = true;
  let parX = 0, parY = 0, pX = 0, pY = 0;
  if (!COARSE && !REDUCED) addEventListener('pointermove', (e) => {
    pX = e.clientX / innerWidth - 0.5;
    pY = e.clientY / innerHeight - 0.5;
  }, { passive: true });
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 }).observe(film);
  addEventListener('resize', resize);

  let last = performance.now(), slow = 0, seen = 0, lastUpload = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden) { last = now; return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const target = targetT();
    T = REDUCED ? target : T + (target - T) * (1 - Math.exp(-dt * 7));
    if (Math.abs(target - T) < 0.0003) T = target;
    if (REDUCED && !dirty && T === renderedT) return;
    renderedT = T;
    dirty = false;

    parX += (pX - parX) * (1 - Math.exp(-dt * 3));
    parY += (pY - parY) * (1 - Math.exp(-dt * 3));

    const time = REDUCED ? 2 : now / 1000;
    const s = storyAt(T, time);
    applyCamera(camera, keys, T, s, parX, parY, size);
    applyRoom(scene, room, T);
    applyPerson(person, T, s);
    if (now - lastUpload > 30 || REDUCED) {
      if (screen.draw(s.browser)) { screenTex.needsUpdate = true; lastUpload = now; }
    }
    applyEffects(fx, T, s, time);
    applyFinale(finale, T, time, fx);
    applyDom(T, s);
    renderer.render(scene, camera);
    if (!gl.classList.contains('ready')) gl.classList.add('ready');

    // Drop resolution once rather than let scrolling stutter on a slow GPU.
    if (!REDUCED && seen++ > 20) {
      slow = dt > 1 / 40 ? slow + 1 : Math.max(0, slow - 1);
      if (slow > 40 && dprCap > 1) {
        dprCap = dprCap > 1.5 ? 1.5 : 1;
        slow = 0;
        renderer.shadowMap.autoUpdate = false;
        renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
        renderer.setSize(size.w, size.h, false);
      }
    }
  }
  let renderedT = -1;

  let domKey = '';
  function applyDom(t, s) {
    bar.classList.toggle('tucked', t < 0.55 && scrollY < filmEnd - innerHeight);
    const shadeA = REDUCED ? (t < 1 ? 1 : 0) : 1 - ease(t, 0.28, 0.7);
    shade.style.setProperty('--shade', shadeA.toFixed(3));
    shade.toggleAttribute('data-off', shadeA < 0.004);
    pins.forEach((pin, i) => {
      const local = t - i;
      const a = REDUCED ? (Math.floor(t === 5 ? 4 : t) === i ? 1 : 0)
        : i === 0 ? 1 - ease(local, 0.28, 0.5)
        : i === 4 ? ease(local, 0.42, 0.62)
        : ease(local, 0.06, 0.18) * (1 - ease(local, 0.92, 0.99));
      pin.style.setProperty('--show', a.toFixed(3));
      if (a < 0.004) pin.setAttribute('data-off', ''); else pin.removeAttribute('data-off');
    });
    const key = `${s.trail}|${s.said}|${s.transcript}`;
    if (key === domKey) return;
    domKey = key;
    trail.forEach((li, i) => li.classList.toggle('on', i === s.trail));
    said.forEach((li, i) => li.classList.toggle('on', i === s.said));
    transcript.textContent = s.transcript;
  }

  // CTA and nav are in the DOM flow; only the pins need to stay above the canvas.
  resize();
  measure();
  // Pay for shaders and big textures now, not as a hitch the first time each scene scrolls in.
  scene.traverse((o) => { if (o.material?.map) renderer.initTexture(o.material.map); });
  [finale.group, fx.slab].forEach((g) => { g.visible = true; });
  renderer.compile(scene, camera);
  addEventListener('load', () => { measure(); dirty = true; });
  document.fonts?.ready.then(() => {
    screen.repaint(); fx.refresh(); measure();
    keys = cameraKeys(camera.aspect, finalRoom());
    dirty = true;
  });
  new ResizeObserver(() => measure()).observe(film);
  requestAnimationFrame(frame);
  setupSteps();

  // One gesture moves one stop; the film plays itself between stops. Each stop is a moment
  // where a scene's point has just landed, and ms is how long the way there takes.
  function setupSteps() {
    const stops = REDUCED
      ? [0, 1.5, 2.5, 3.5, 5].map((at) => ({ at, ms: 0 }))
      : [
        { at: 0, ms: 0 },
        { at: 1.35, ms: 2200 }, { at: 1.5, ms: 1000 }, { at: 1.86, ms: 1900 },
        { at: 2.335, ms: 2800 }, { at: 2.635, ms: 2200 }, { at: 2.88, ms: 2200 },
        { at: 3.38, ms: 2800 }, { at: 3.9, ms: 4000 },
        { at: 5, ms: 3000 },
      ];
    const yOf = (at) => {
      const i = Math.min(4, Math.floor(at));
      return Math.min(spans[i].t0 + (at - i) * spans[i].len, document.documentElement.scrollHeight - innerHeight);
    };
    const nearest = () => {
      const t = scrollT();
      return stops.reduce((best, stop, i) => (Math.abs(stop.at - t) < Math.abs(stops[best].at - t) ? i : best), 0);
    };
    const jump = (y) => scrollTo({ top: y, behavior: 'instant' });
    let index = nearest();
    let tween = null;
    let tweenEnd = 0;

    function go(next) {
      next = clamp(next, 0, stops.length - 1);
      if (next === index && !tween) return;
      const dir = Math.sign(next - index) || 1;
      const ms = next > index ? stops[next].ms : Math.min(1500, stops[index].ms);
      index = next;
      const from = scrollY, to = yOf(stops[next].at);
      if (!ms) { tween = null; jump(to); return; }
      const run = { dir };
      tween = run;
      const began = performance.now();
      const step = (now) => {
        if (tween !== run) return;
        const x = seg(now - began, 0, ms);
        jump(mix(from, to, smooth(x)));
        if (x < 1) { requestAnimationFrame(step); return; }
        tween = null;
        tweenEnd = now;
      };
      requestAnimationFrame(step);
    }
    function move(dir) {
      if (tween && tween.dir === dir) return;
      go(index + dir);
    }

    // A trackpad keeps sending shrinking events long after the fingers lift. A new gesture
    // is a pause in the stream, or a sudden rise in it; the rest is that same flick's coast.
    let lastWheel = 0, lastAbs = 0;
    addEventListener('wheel', (e) => {
      if (e.ctrlKey) return; // pinch zoom
      e.preventDefault();
      const abs = Math.abs(e.deltaY);
      if (abs < 2 || abs < Math.abs(e.deltaX)) return;
      const now = performance.now();
      const rising = abs > lastAbs * 1.6 && abs > 24 && now - tweenEnd > 200;
      const fresh = now - lastWheel > 140 || rising;
      lastWheel = now;
      lastAbs = abs;
      if (fresh) move(Math.sign(e.deltaY));
    }, { passive: false });

    let touchY = null;
    addEventListener('touchstart', (e) => { touchY = e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
    addEventListener('touchmove', (e) => { if (e.touches.length === 1) e.preventDefault(); }, { passive: false });
    addEventListener('touchend', (e) => {
      if (touchY === null) return;
      const dy = touchY - e.changedTouches[0].clientY;
      touchY = null;
      if (Math.abs(dy) > 36) move(Math.sign(dy));
    });

    addEventListener('keydown', (e) => {
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      const onControl = e.target.closest?.('a, button');
      const dir = { ArrowDown: 1, PageDown: 1, ArrowUp: -1, PageUp: -1 }[e.key]
        ?? (e.key === ' ' && !onControl ? (e.shiftKey ? -1 : 1) : 0);
      if (dir) { e.preventDefault(); move(dir); }
      if (e.key === 'Home') { e.preventDefault(); go(0); }
      if (e.key === 'End') { e.preventDefault(); go(stops.length - 1); }
    });
    // Tabbing to the closing buttons has to bring them into view: they're invisible until then.
    document.querySelector('.beat-final').addEventListener('focusin', () => go(stops.length - 1));

    // Anything else that moved the page (scrollbar, brand link, reload) settles on the closest stop.
    let held = false, settling = 0;
    addEventListener('pointerdown', () => { held = true; });
    addEventListener('pointerup', () => { held = false; });
    const settle = () => {
      clearTimeout(settling);
      settling = setTimeout(() => {
        if (tween || held) return;
        index = nearest();
        if (Math.abs(scrollY - yOf(stops[index].at)) > 2) jump(yOf(stops[index].at));
      }, 220);
    };
    addEventListener('scroll', settle, { passive: true });
    addEventListener('resize', settle);
    settle();
  }
}

// ---------------------------------------------------------------- story

const COMMANDS = ['"검색 버튼 클릭해 줘."', '"다음 페이지로 이동해 줘."', '"새 탭 열어 줘."'];
const AI_GOAL = 'Google에서 해커톤을 검색해 줘.';

function highlightFrom(rect, a = 1, press = 0, ring = 0, r) {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h, a: +a.toFixed(3), press: +press.toFixed(3), ring: +ring.toFixed(3), r };
}
function lerpRect(a, b, x) {
  return { x: mix(a.x, b.x, x), y: mix(a.y, b.y, x), w: mix(a.w, b.w, x), h: mix(a.h, b.h, x) };
}
const reveal = (text, x) => text.slice(0, Math.round(text.length * clamp(x)));

function storyAt(T, time) {
  const s = {
    trail: -1, said: -1, transcript: '',
    voice: 0, gaze: null, gazeA: 0, flick: 0, ai: null, link: null,
    browser: { tabs: ['오늘의 소식'], activeTab: 0, url: 'news.example.kr', page: 'portal', scroll: 0, hl: null },
  };
  const b = s.browser;
  // Scene 1: nobody is touching anything, and the page drifts on its own.
  const drift = (1 - ease(T, 0.34, 0.8)) * (0.5 - 0.5 * Math.cos(time * 0.16));
  b.scroll = Math.round(drift * 300);

  if (T >= 1 && T < 2) {
    const t = T - 1, [a0, a1] = RECTS.tiles;
    const appear = ease(t, 0.14, 0.2), moved = ease(t, 0.42, 0.47);
    const ring = seg(t, 0.52, 0.82), pressed = ease(t, 0.82, 0.85);
    if (appear > 0) {
      b.hl = highlightFrom(lerpRect(a0, a1, moved), appear, pressed, ring >= 1 ? 0 : ring);
      s.gaze = centerOf(lerpRect(a0, a1, moved));
      s.gazeA = appear * (1 - ease(t, 0.88, 0.94));
    }
    s.flick = Math.sin(seg(t, 0.4, 0.5) * Math.PI);
    s.trail = t < 0.1 ? -1 : t < 0.4 ? 0 : t < 0.52 ? 1 : 2;
    if (t > 0.86) { b.next = 'search'; b.mix = +ease(t, 0.88, 0.97).toFixed(3); b.hl = b.mix < .5 ? b.hl : null; }
  }
  if (T >= 2 && T < 3) {
    const t = T - 2;
    b.page = 'search';
    const spans = [[0.1, 0.24], [0.38, 0.52], [0.68, 0.82]];
    const i = t < 0.34 ? 0 : t < 0.64 ? 1 : 2;
    s.said = i;
    const [a, z] = spans[i];
    s.transcript = reveal(COMMANDS[i], seg(t, a, z));
    s.voice = ease(t, a - 0.03, a + 0.01) * (1 - ease(t, z, z + 0.04));
    if (t >= 0.25 && t < 0.34) {
      const on = ease(t, 0.25, 0.27);
      b.hl = highlightFrom(RECTS.searchBtn, on * (1 - ease(t, 0.32, 0.34)), ease(t, 0.28, 0.3), 0, 44);
    }
    if (t >= 0.3) { b.page = t < 0.34 ? 'search' : 'results'; if (t < 0.34) { b.next = 'results'; b.mix = +seg(t, 0.3, 0.34).toFixed(3); } }
    if (t >= 0.53 && t < 0.64) {
      b.hl = highlightFrom(RECTS.nextBtn, ease(t, 0.53, 0.55) * (1 - ease(t, 0.61, 0.63)), ease(t, 0.56, 0.58), 0, 26);
    }
    if (t >= 0.59) { b.page = t < 0.63 ? 'results' : 'results2'; if (t < 0.63) { b.next = 'results2'; b.mix = +seg(t, 0.59, 0.63).toFixed(3); } }
    if (t >= 0.84) {
      b.tabs = ['오늘의 소식', '새 탭'];
      b.activeTab = 1;
      b.url = '새 탭';
      b.page = 'newtab';
    }
    if (t >= 0.3 && t < 0.84) b.url = 'news.example.kr/search?q=오늘의+날씨';
  }
  if (T >= 3) {
    const t = Math.min(T - 3, 1);
    b.tabs = ['오늘의 소식', '새 탭'];
    b.activeTab = 1;
    b.url = '새 탭';
    b.page = 'newtab';
    b.typed = null;
    const typed = reveal(AI_GOAL, seg(t, 0.14, 0.27));
    const planned = seg(t, 0.28, 0.38);
    const stage = t < 0.4 ? -1 : t < 0.5 ? 0 : t < 0.6 ? 1 : t < 0.7 ? 2 : t < 0.78 ? 3 : t < 0.88 ? 4 : 5;
    const steps = [0, 1, 2, 3, 4].map((i) => {
      if (planned <= i / 5) return 0;
      if (stage < 0) return 1;
      return i < stage ? 3 : i === stage ? 2 : 1;
    });
    s.ai = {
      a: ease(t, 0.03, 0.12),
      panel: {
        status: t < 0.28 ? '듣는 중' : t < 0.4 ? '단계 만드는 중' : t < 0.88 ? `${Math.min(stage + 1, 5)} / 5 실행 중` : '완료',
        typed, caret: t > 0.1 && t < 0.28 && Math.floor(time * 2) % 2 === 0,
        steps, stepA: steps.map((_, i) => +seg(planned, i / 5, (i + 1) / 5).toFixed(2)),
      },
      stage,
    };
    if (stage >= 0) {
      b.url = 'google.com';
      b.tabs = ['오늘의 소식', 'Google'];
      b.page = 'google';
      b.typed = '';
      if (t < 0.45) { b.page = 'newtab'; b.next = 'google'; b.mix = +seg(t, 0.41, 0.45).toFixed(3); b.typed = null; }
    }
    if (stage === 1) {
      b.hl = highlightFrom(RECTS.gBox, ease(t, 0.5, 0.53), 0, 0, 46);
    }
    if (stage >= 2) {
      b.typed = reveal('해커톤', seg(t, 0.61, 0.68));
      if (stage === 2) b.hl = highlightFrom(RECTS.gBox, 1, 0, 0, 46);
    }
    if (stage === 3) b.hl = highlightFrom(RECTS.gBtn, ease(t, 0.7, 0.71), ease(t, 0.74, 0.76), 0, 24);
    if (t >= 0.77) {
      b.page = t < 0.81 ? 'google' : 'gresults';
      if (t < 0.81) { b.next = 'gresults'; b.mix = +seg(t, 0.77, 0.81).toFixed(3); }
      b.url = t < 0.81 ? 'google.com' : 'google.com/search?q=해커톤';
      b.typed = t < 0.81 ? '해커톤' : null;
    }
    if (stage >= 4 && t >= 0.82) b.hl = highlightFrom(RECTS.gResult, ease(t, 0.82, 0.86), 0, 0, 22);
    if (s.ai.stage >= 0 && s.ai.stage < 5) {
      const r = [null, RECTS.gBox, RECTS.gBox, RECTS.gBtn, RECTS.gResult][s.ai.stage];
      s.link = { stage: s.ai.stage, target: r ? centerOf(r) : { x: 730, y: 76 } };
    }
  }
  return s;
}
const centerOf = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const screenWorld = (p, v = new THREE.Vector3()) => v.set(
  SCREEN.x + (p.x / W - 0.5) * SCREEN.w,
  SCREEN.y - (p.y / H - 0.5) * SCREEN.h,
  SCREEN.z + 0.004,
);

// ---------------------------------------------------------------- camera

// Keys hold position, target and a screen-space shift that leaves room for the copy.
function cameraKeys(a, room) {
  const portrait = a < 1;
  const tan = Math.tan(THREE.MathUtils.degToRad(19));
  const fit = (w, h, fw = 1, fh = 1) => Math.max(h / (2 * tan * fh), w / (2 * tan * a * fw));
  const cover = Math.min(SCREEN.h / (2 * tan), SCREEN.w / (2 * tan * a)) * 0.965;
  const sz = SCREEN.z, sy = SCREEN.y;
  const k = (T, p, t, sh = [0, 0], hold = false) => ({ T, v: [...p, ...t, ...sh], hold });
  const c0 = [0, sy, sz + cover], t0 = [0, sy, sz];
  // The closing window sits in whatever space the closing copy leaves above itself.
  const end = fit(a < 1 ? 1 : 0.95, 0.54, 1, room.size);
  const endShift = [0, 0.5 - room.center];
  if (portrait) {
    const d = Math.max(fit(0.82, 0.5), 2.5);
    const voice = fit(0.8, 0.5);
    const ai = fit(0.86, 1.05);
    return [
      k(0, c0, t0, [0, 0], true), k(0.3, c0, t0, [0, 0], true),
      k(0.66, [-0.3, 1.3, 0.78], t0),
      k(1.06, [-0.16, 1.62, sz + d + 0.2], [0, 1.02, -0.2], [0, -0.13], true),
      k(1.88, [-0.12, 1.58, sz + d], [0, 1.02, -0.2], [0, -0.13], true),
      k(2.2, [0, sy + 0.04, sz + voice], [0, sy, sz], [0, -0.12], true),
      k(2.9, [0, sy + 0.04, sz + voice - 0.03], [0, sy, sz], [0, -0.12], true),
      k(3.16, [0, 1.36, sz + ai], [0, 1.34, -0.3], [0, -0.1], true),
      k(3.9, [0, 1.36, sz + ai - 0.03], [0, 1.34, -0.3], [0, -0.1], true),
      k(4.42, [0, FINAL.y, FINAL.z + end + 0.06], FINAL.toArray(), endShift, true),
      k(5, [0, FINAL.y, FINAL.z + end], FINAL.toArray(), endShift, true),
    ];
  }
  const voice = Math.max(fit(0.78, 0.5, 0.6), 0.74);
  const ai = Math.max(fit(1.1, 0.56, 0.6), 0.86);
  return [
    k(0, c0, t0, [0, 0], true), k(0.3, c0, t0, [0, 0], true),
    k(0.66, [-0.32, 1.27, 0.76], t0),
    k(1.06, [-0.6, 1.62, 1.98], [0.06, 1.05, -0.3], [0.15, 0], true),
    k(1.88, [-0.5, 1.57, 1.72], [0.06, 1.06, -0.3], [0.15, 0], true),
    k(2.2, [0.02, sy + 0.03, sz + voice], [0, sy, sz], [0.19, 0], true),
    k(2.9, [0.0, sy + 0.02, sz + voice - 0.03], [0, sy, sz], [0.19, 0], true),
    k(3.18, [-0.24, sy + 0.04, sz + ai], [-0.1, sy, -0.3], [0.21, 0], true),
    k(3.9, [-0.19, sy + 0.03, sz + ai - 0.04], [-0.1, sy, -0.3], [0.21, 0], true),
    k(4.42, [0, FINAL.y, FINAL.z + end + 0.06], FINAL.toArray(), endShift, true),
    k(5, [0, FINAL.y, FINAL.z + end], FINAL.toArray(), endShift, true),
  ];
}

// Hermite through the keys, with zero slope at holds, so shots settle and then move on.
function sampleKeys(keys, T, out) {
  let i = 0;
  while (i < keys.length - 2 && T > keys[i + 1].T) i++;
  const a = keys[i], b = keys[i + 1];
  const h = b.T - a.T, x = clamp((T - a.T) / h);
  const x2 = x * x, x3 = x2 * x;
  for (let c = 0; c < a.v.length; c++) {
    const slope = (k, n) => {
      if (keys[k].hold || k === 0 || k === keys.length - 1) return 0;
      return (keys[k + 1].v[c] - keys[k - 1].v[c]) / (keys[k + 1].T - keys[k - 1].T);
    };
    out[c] = (2 * x3 - 3 * x2 + 1) * a.v[c] + (x3 - 2 * x2 + x) * h * slope(i)
      + (-2 * x3 + 3 * x2) * b.v[c] + (x3 - x2) * h * slope(i + 1);
  }
  return out;
}

const camOut = new Array(8).fill(0);
function applyCamera(camera, keys, T, s, parX, parY, size) {
  sampleKeys(keys, T, camOut);
  const far = ease(T, 0.3, 0.9); // Parallax is off while the screen fills the frame.
  camera.position.set(camOut[0] + parX * 0.05 * far, camOut[1] - parY * 0.03 * far, camOut[2]);
  // Scene 2: the camera leans with the head, as if it were following along.
  if (T > 1 && T < 2) camera.position.x += (s.headYaw ?? 0) * 0.08;
  camera.lookAt(camOut[3], camOut[4], camOut[5]);
  camera.setViewOffset(size.w, size.h, -camOut[6] * size.w, camOut[7] * size.h, size.w, size.h);
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- world

function canvasTexture(canvas, renderer) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,.72)');
  r.addColorStop(0.3, 'rgba(255,255,255,.34)');
  r.addColorStop(0.62, 'rgba(255,255,255,.08)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const GLOW = { tex: null };
function glow(color, size, opacity = 1) {
  GLOW.tex ??= glowTexture();
  const m = new THREE.SpriteMaterial({ map: GLOW.tex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const s = new THREE.Sprite(m);
  s.scale.set(size, size, 1);
  return s;
}

// A dim soft-box studio for reflections on the floor, desk and monitor.
function makeEnvironment(renderer) {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x03060f);
  const panel = (color, i, w, h, x, y, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(i), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(0x8fb2ee, 1.7, 6, 3, 0, 1, -6);
  panel(0xa8d8ea, 0.8, 2, 7, -6, 1, 0);
  panel(0xe6edfa, 1.8, 7, 1.2, 0, 6, 1);
  panel(0x6a8fd8, 0.5, 4, 3, 5, 1, 4);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(env, 0.05);
  pm.dispose();
  return rt.texture;
}

// Rounded plate, extruded along its depth and centered on the origin.
function rbox(w, h, d, r, bevel = 0.003) {
  const x = -w / 2, y = -h / 2;
  const sh = new THREE.Shape();
  sh.moveTo(x + r, y); sh.lineTo(x + w - r, y); sh.quadraticCurveTo(x + w, y, x + w, y + r);
  sh.lineTo(x + w, y + h - r); sh.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  sh.lineTo(x + r, y + h); sh.quadraticCurveTo(x, y + h, x, y + h - r);
  sh.lineTo(x, y + r); sh.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(sh, { depth: d - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -d / 2 + bevel);
  return g;
}

function mesh(geo, mat, parent, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow; m.receiveShadow = shadow;
  parent.add(m);
  return m;
}

function nightWindow() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0, '#040a1c'); sky.addColorStop(0.7, '#0c1d48'); sky.addColorStop(1, '#16306b');
  g.fillStyle = sky; g.fillRect(0, 0, 512, 512);
  g.filter = 'blur(3px)';
  for (let i = 0; i < 150; i++) {
    const x = (i * 197.3) % 512, y = 300 + ((i * 89.7) % 212);
    g.fillStyle = ['#5b98ff', '#7fe7ff', '#c8d8ff', '#2f7bff'][i % 4];
    g.globalAlpha = 0.25 + ((i * 37) % 60) / 100;
    g.beginPath(); g.arc(x, y, 2 + (i % 5), 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildRoom(scene) {
  const group = new THREE.Group();
  scene.add(group);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x0b1222, roughness: 0.42, metalness: 0.15 });
  const floor = mesh(new THREE.PlaneGeometry(14, 14), floorMat, group);
  floor.rotation.x = -Math.PI / 2;
  floor.castShadow = false;

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0c1428, roughness: 0.9 });
  const wall = (w, h, x, y, z, ry) => {
    const m = mesh(new THREE.PlaneGeometry(w, h), wallMat, group, x, y, z, false);
    m.rotation.y = ry;
    return m;
  };
  wall(14, 4, 0, 2, -1.05, 0);
  wall(14, 4, -2.6, 2, 2, Math.PI / 2);
  wall(14, 4, 2.9, 2, 2, -Math.PI / 2);
  const ceil = mesh(new THREE.PlaneGeometry(14, 14), wallMat, group, 0, 2.9, 0, false);
  ceil.rotation.x = Math.PI / 2;

  // Slatted acoustic wall behind the desk, lit from behind the monitor.
  const slatMat = new THREE.MeshStandardMaterial({ color: 0x121c36, roughness: 0.62, metalness: 0.2 });
  const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 2.9, 0.035), slatMat, 66);
  const o = new THREE.Object3D();
  for (let i = 0; i < 66; i++) {
    o.position.set(-2.55 + i * 0.083, 1.45, -1.02);
    o.updateMatrix();
    slats.setMatrixAt(i, o.matrix);
  }
  group.add(slats);

  // Cove light along the ceiling: the room's only ceiling fixture.
  const cove = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5b98ff).multiplyScalar(1.6), toneMapped: false });
  const strip = mesh(new THREE.BoxGeometry(5, 0.012, 0.03), cove, group, 0, 2.88, -0.94, false);
  strip.castShadow = false;

  // Night window on the left wall.
  const win = mesh(new THREE.PlaneGeometry(2.2, 1.7), new THREE.MeshBasicMaterial({ map: nightWindow(), toneMapped: false }), group, -2.58, 1.55, 0.9, false);
  win.rotation.y = Math.PI / 2;
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x18233f, roughness: 0.5, metalness: 0.6 });
  [[0, 2.24, 0.03], [0.86, 2.24, 0.03], [-0.86, 2.24, 0.03]].forEach(([y, w, d]) => mesh(new THREE.BoxGeometry(d, 0.03, w), frameMat, group, -2.57, 1.55 + y, 0.9, false));
  [-1.11, 0, 1.11].forEach((z) => mesh(new THREE.BoxGeometry(0.03, 1.72, 0.03), frameMat, group, -2.57, 1.55, 0.9 + z, false));

  // Desk. No keyboard and no mouse on it, on purpose.
  const deskMat = new THREE.MeshStandardMaterial({ color: 0x20242e, roughness: 0.62, metalness: 0.05 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a3550, roughness: 0.38, metalness: 0.85 });
  mesh(new THREE.BoxGeometry(1.7, 0.035, 0.82), deskMat, group, 0, 0.74, -0.32);
  [[-0.78, -0.66], [0.78, -0.66], [-0.78, 0.02], [0.78, 0.02]].forEach(([x, z]) => mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.72, 12), metal, group, x, 0.36, z));
  mesh(new THREE.CylinderGeometry(0.038, 0.032, 0.09, 24), new THREE.MeshStandardMaterial({ color: 0x2b3448, roughness: 0.45 }), group, -0.62, 0.803, -0.52);
  const pot = mesh(new THREE.CylinderGeometry(0.055, 0.042, 0.1, 24), new THREE.MeshStandardMaterial({ color: 0x1f2c4a, roughness: 0.6 }), group, 0.62, 0.808, -0.46);
  pot.castShadow = true;
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x1c5a58, roughness: 0.65, side: THREE.DoubleSide });
  for (let i = 0; i < 9; i++) {
    const leaf = mesh(new THREE.SphereGeometry(0.05, 10, 8), leafMat, group, 0.62, 0.9 + (i % 3) * 0.035, -0.46);
    leaf.scale.set(0.34, 1.5, 0.1);
    leaf.rotation.set(Math.sin(i * 2.1) * 0.55, i * 0.7, Math.cos(i * 1.7) * 0.6);
    leaf.position.x += Math.cos(i * 0.7) * 0.03;
    leaf.position.z += Math.sin(i * 0.7) * 0.03;
  }

  // Round rug under the chair, and a low shelf to give the room scale.
  const rug = mesh(new THREE.CircleGeometry(1.15, 48), new THREE.MeshStandardMaterial({ color: 0x131d38, roughness: 0.98 }), group, 0.05, 0.004, 0.75, false);
  rug.rotation.x = -Math.PI / 2; rug.receiveShadow = true;
  mesh(new THREE.BoxGeometry(1.1, 0.5, 0.32), new THREE.MeshStandardMaterial({ color: 0x141e36, roughness: 0.5, metalness: 0.2 }), group, 1.75, 0.25, -0.84);
  const bookColors = [0x2f7bff, 0xe4ecff, 0x1f2c4a, 0x7fe7ff, 0x3a4a70];
  for (let i = 0; i < 9; i++) {
    mesh(new THREE.BoxGeometry(0.035, 0.19 + (i % 3) * 0.022, 0.15), new THREE.MeshStandardMaterial({ color: bookColors[i % 5], roughness: 0.75 }), group, 1.36 + i * 0.042, 0.6 + (i % 3) * 0.011, -0.84, false);
  }

  // Lights.
  const lights = {
    hemi: new THREE.HemisphereLight(0xb9c8e6, 0x070b16, 0.42),
    key: new THREE.SpotLight(0xdde6f7, 7, 7, 0.6, 0.85, 1.6),
    screen: new THREE.PointLight(0xb4cbf5, 0.7, 2.6, 1.8),
    rimL: new THREE.SpotLight(0x6fa4ff, 2.2, 4, 0.7, 0.7, 1.5),
    rimR: new THREE.SpotLight(0x8fdcf5, 1.6, 4, 0.7, 0.7, 1.5),
  };
  lights.key.position.set(1.1, 2.75, 1.4);
  lights.key.target.position.set(0, 0.9, 0.2);
  lights.key.castShadow = !LOW;
  lights.key.shadow.mapSize.set(1024, 1024);
  lights.key.shadow.bias = -0.0006;
  lights.key.shadow.radius = 6;
  lights.screen.position.set(0, SCREEN.y, SCREEN.z + 0.16);
  lights.rimL.position.set(-1.2, 1.9, -0.15);
  lights.rimL.target.position.copy(HEAD);
  lights.rimR.position.set(1.2, 1.7, -0.15);
  lights.rimR.target.position.copy(HEAD);
  for (const l of Object.values(lights)) {
    group.add(l);
    if (l.target) group.add(l.target);
  }

  // Bias light glowing on the wall behind the monitor.
  const wallGlow = (color, size, opacity, z) => {
    GLOW.tex ??= glowTexture();
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: GLOW.tex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    m.position.set(0, SCREEN.y + 0.03, z);
    group.add(m);
    return m;
  };
  const bias = wallGlow(0x2f7bff, 2.9, 0.75, -0.995);
  const biasCore = wallGlow(0x7fe7ff, 1.3, 0.3, -0.994);

  return { group, lights, base: Object.fromEntries(Object.entries(lights).map(([k, l]) => [k, l.intensity])), bias, biasCore };
}

function applyRoom(scene, room, T) {
  const dim = ease(T, 4.04, 4.46);
  scene.fog.density = mix(0.05, 3.2, dim * dim);
  room.group.visible = dim < 1;
  scene.environmentIntensity = mix(0.55, 0.2, dim);
  for (const [k, l] of Object.entries(room.lights)) l.intensity = room.base[k] * (1 - dim);
  room.bias.material.opacity = 0.75 * (1 - dim);
  room.biasCore.material.opacity = 0.3 * (1 - dim);
}

function buildMonitor(scene, tex) {
  const g = new THREE.Group();
  g.name = 'monitor';
  const shell = new THREE.MeshStandardMaterial({ color: 0x151d30, roughness: 0.3, metalness: 0.75 });
  const bw = SCREEN.w + 0.024, bh = SCREEN.h + 0.024;
  mesh(rbox(bw, bh, 0.026, 0.012), shell, g, 0, SCREEN.y, SCREEN.z - 0.014);
  const screenMesh = mesh(new THREE.PlaneGeometry(SCREEN.w, SCREEN.h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), g, 0, SCREEN.y, SCREEN.z, false);
  screenMesh.name = 'screen';
  mesh(new THREE.BoxGeometry(0.06, 0.2, 0.024), shell, g, 0, 0.84, SCREEN.z - 0.05);
  mesh(rbox(0.26, 0.18, 0.012, 0.03), shell, g, 0, 0.764, SCREEN.z - 0.02).rotation.x = Math.PI / 2;

  // Just a webcam: the only hardware the product needs.
  const camBody = mesh(rbox(0.07, 0.024, 0.024, 0.01, 0.002), new THREE.MeshStandardMaterial({ color: 0x0a0e18, roughness: 0.35, metalness: 0.5 }), g, 0, SCREEN.y + SCREEN.h / 2 + 0.026, SCREEN.z - 0.006);
  camBody.name = 'webcam';
  const lens = mesh(new THREE.SphereGeometry(0.006, 14, 10), new THREE.MeshStandardMaterial({ color: 0x0a1630, roughness: 0.08, metalness: 0.9 }), g, 0, SCREEN.y + SCREEN.h / 2 + 0.026, SCREEN.z + 0.007, false);
  lens.scale.z = 0.5;
  const led = glow(0x7fe7ff, 0.028, 0.95);
  led.position.set(0.019, SCREEN.y + SCREEN.h / 2 + 0.026, SCREEN.z + 0.009);
  g.add(led);
  scene.add(g);
}

// Catmull-Rom between the hand-placed rings, so a body doesn't show its construction.
function smoothRings(rings, steps) {
  const out = [];
  const at = (i) => rings[clamp(i, 0, rings.length - 1)];
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < (i === rings.length - 2 ? steps + 1 : steps); k++) {
      const t = k / steps, ring = {};
      for (const f of ['y', 'rx', 'rz', 'z', 'x', 'n']) {
        const v = (r) => r[f] ?? (f === 'n' ? 2 : 0);
        ring[f] = cr(v(at(i - 1)), v(at(i)), v(at(i + 1)), v(at(i + 2)), t);
      }
      out.push(ring);
    }
  }
  return out;
}

// Fine grain for cloth and hair, so they catch light like material and not like plastic.
function grainTexture(streak) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i++) {
    const x = (i * 73.13) % 256, y = (i * 191.77) % 256, v = 90 + ((i * 47) % 90);
    g.fillStyle = `rgba(${v},${v},${v},.5)`;
    g.fillRect(x, y, streak ? 1 : 2, streak ? 10 + (i % 18) : 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(streak ? 5 : 7, streak ? 2 : 7);
  return t;
}

// Lofts elliptical rings up a spine. Fine for anything soft and roughly round: torso, skull.
function loft(coarse, seg = 48) {
  const rings = smoothRings(coarse, 5);
  const pos = [], idx = [], uvs = [];
  rings.forEach(({ y, rx, rz, z = 0, x = 0, n = 2 }, r) => {
    for (let i = 0; i <= seg; i++) {
      uvs.push(i / seg, r / (rings.length - 1));
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const px = Math.sign(c) * Math.abs(c) ** (2 / n) * rx;
      const pz = Math.sign(s) * Math.abs(s) ** (2 / n) * rz;
      pos.push(x + px, y, z + pz);
    }
  });
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < seg; i++) {
      const a = r * (seg + 1) + i, b = a + seg + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // The seam at i = 0 and i = seg shares a position; average it so no crease runs down the back.
  const nrm = g.attributes.normal;
  for (let r = 0; r < rings.length; r++) {
    const a = r * (seg + 1), b = a + seg;
    const nx = nrm.getX(a) + nrm.getX(b), ny = nrm.getY(a) + nrm.getY(b), nz = nrm.getZ(a) + nrm.getZ(b);
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / l, ny / l, nz / l);
    nrm.setXYZ(b, nx / l, ny / l, nz / l);
  }
  return g;
}

// A soft blue edge, as if the screen in front were wrapping the figure in its light.
function rimMaterial(params, rim = 0.5) {
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
       float rimF = pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), 3.2);
       totalEmissiveRadiance += vec3(0.24, 0.5, 1.0) * rimF * ${rim.toFixed(3)};`,
    );
  };
  return m;
}

function tube(points, radius, mat, parent, radial = 14) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const m = mesh(new THREE.TubeGeometry(curve, 16, radius, radial, false), mat, parent);
  return m;
}

function buildPerson(scene) {
  const root = new THREE.Group();
  root.position.set(0, 0, HEAD.z);
  scene.add(root);
  const clothGrain = grainTexture(false), hairGrain = grainTexture(true);
  const cloth = rimMaterial({ color: 0x46526e, roughness: 0.96, bumpMap: clothGrain, bumpScale: 0.6 }, 0.1);
  const skin = rimMaterial({ color: 0xb0917f, roughness: 0.66 }, 0.1);
  const hair = rimMaterial({ color: 0x15161d, roughness: 0.82, bumpMap: hairGrain, bumpScale: 1.4 }, 0.2);
  const pants = rimMaterial({ color: 0x1a2030, roughness: 0.9 }, 0.12);
  const mats = [cloth, skin, hair, pants];

  // Torso, from the seat up the trapezius into a crew collar.
  const torso = loft([
    { y: 0.5, rx: 0.15, rz: 0.11, n: 2.3 }, { y: 0.64, rx: 0.152, rz: 0.104, n: 2.3 },
    { y: 0.78, rx: 0.166, rz: 0.104, n: 2.3 }, { y: 0.9, rx: 0.186, rz: 0.112, n: 2.4 },
    { y: 0.98, rx: 0.2, rz: 0.108, n: 2.5 }, { y: 1.025, rx: 0.186, rz: 0.094, n: 2.4 },
    { y: 1.06, rx: 0.128, rz: 0.076 }, { y: 1.09, rx: 0.074, rz: 0.062 }, { y: 1.108, rx: 0.055, rz: 0.054 },
  ]);
  mesh(torso, cloth, root);
  const collar = mesh(new THREE.TorusGeometry(0.052, 0.0085, 10, 32), cloth, root, 0, 1.11, 0);
  collar.rotation.x = Math.PI / 2;
  // Neck.
  mesh(new THREE.CylinderGeometry(0.044, 0.05, 0.09, 24), skin, root, 0, 1.135, 0);

  // Arms hang relaxed with hands in the lap. Nothing here reaches for the desk.
  for (const side of [-1, 1]) {
    const deltoid = mesh(new THREE.SphereGeometry(0.052, 20, 16), cloth, root, side * 0.178, 0.985, 0);
    deltoid.scale.set(1.15, 1, 1.1);
    tube([[side * 0.185, 0.99, 0], [side * 0.212, 0.86, 0.012], [side * 0.222, 0.73, -0.01]], 0.044, cloth, root);
    mesh(new THREE.SphereGeometry(0.044, 16, 12), cloth, root, side * 0.222, 0.73, -0.01);
    tube([[side * 0.222, 0.73, -0.01], [side * 0.2, 0.66, -0.12], [side * 0.12, 0.6, -0.24]], 0.037, cloth, root);
    const hand = mesh(new THREE.SphereGeometry(0.04, 14, 10), skin, root, side * 0.1, 0.59, -0.27);
    hand.scale.set(0.8, 0.55, 1.2);
    // Legs under the desk.
    tube([[side * 0.09, 0.47, 0.02], [side * 0.1, 0.47, -0.2], [side * 0.11, 0.46, -0.4]], 0.068, pants, root);
    mesh(new THREE.SphereGeometry(0.068, 14, 10), pants, root, side * 0.11, 0.46, -0.4);
    tube([[side * 0.11, 0.46, -0.4], [side * 0.11, 0.25, -0.44], [side * 0.11, 0.06, -0.46]], 0.05, pants, root);
    const shoe = mesh(new THREE.SphereGeometry(0.05, 14, 10), new THREE.MeshStandardMaterial({ color: 0x0a0e18, roughness: 0.5 }), root, side * 0.11, 0.035, -0.52);
    shoe.scale.set(0.85, 0.6, 1.7);
  }

  // Head turns on its own pivot at the top of the neck.
  const head = new THREE.Group();
  head.position.set(0, 1.155, 0);
  root.add(head);
  const skull = loft([
    { y: -0.05, rx: 0.018, rz: 0.018, z: -0.01 }, { y: -0.04, rx: 0.052, rz: 0.06, z: -0.012 },
    { y: -0.01, rx: 0.068, rz: 0.083, z: -0.012 }, { y: 0.03, rx: 0.076, rz: 0.094, z: -0.008 },
    { y: 0.07, rx: 0.079, rz: 0.098 }, { y: 0.105, rx: 0.074, rz: 0.092 },
    { y: 0.135, rx: 0.056, rz: 0.07 }, { y: 0.15, rx: 0.028, rz: 0.036 }, { y: 0.155, rx: 0.004, rz: 0.004 },
  ]);
  mesh(skull, skin, head);
  // Short hair: a slightly larger shell on the crown and the back of the head.
  const hairShell = loft([
    { y: 0.012, rx: 0.058, rz: 0.08, z: 0.02 }, { y: 0.035, rx: 0.08, rz: 0.1, z: 0.006 },
    { y: 0.07, rx: 0.085, rz: 0.106, z: 0.003 }, { y: 0.11, rx: 0.081, rz: 0.1, z: 0.001 },
    { y: 0.142, rx: 0.062, rz: 0.078 }, { y: 0.16, rx: 0.033, rz: 0.042 }, { y: 0.166, rx: 0.004, rz: 0.004 },
  ]);
  mesh(hairShell, hair, head);
  const crown = mesh(new THREE.SphereGeometry(0.04, 16, 10), hair, head, 0, 0.142, 0);
  crown.scale.set(1, 0.6, 1.2);
  for (const side of [-1, 1]) {
    const ear = mesh(new THREE.SphereGeometry(0.021, 12, 10), skin, head, side * 0.08, 0.038, 0.004);
    ear.scale.set(0.34, 1, 0.68);
  }

  // Chair: a low back, so the person's shoulders stay visible.
  const dark = new THREE.MeshStandardMaterial({ color: 0x10172a, roughness: 0.62 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x2a3550, roughness: 0.32, metalness: 0.9 });
  const seat = mesh(rbox(0.46, 0.44, 0.07, 0.07, 0.012), dark, root, 0, 0.42, -0.04);
  seat.rotation.x = Math.PI / 2;
  mesh(rbox(0.38, 0.28, 0.035, 0.07, 0.008), dark, root, 0, 0.7, 0.155).rotation.x = 0.07;
  mesh(new THREE.BoxGeometry(0.04, 0.26, 0.02), steel, root, 0, 0.5, 0.17);
  mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.28, 16), steel, root, 0, 0.25, -0.04);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const spoke = mesh(new THREE.BoxGeometry(0.26, 0.018, 0.034), steel, root, Math.cos(a) * 0.13, 0.085, -0.04 + Math.sin(a) * 0.13);
    spoke.rotation.y = -a;
    mesh(new THREE.SphereGeometry(0.026, 12, 8), dark, root, Math.cos(a) * 0.26, 0.03, -0.04 + Math.sin(a) * 0.26);
  }

  root.traverse((o) => { if (o.isMesh && !mats.includes(o.material)) mats.push(o.material); });
  mats.forEach((m) => { m.transparent = true; }); // Set for good: switching mid-scroll recompiles the shader.
  return { root, head, mats };
}

function applyPerson(person, T, s) {
  // Leaves once the camera has gone past, so the later shots see only the screen.
  const fade = 1 - ease(T, 2.02, 2.16);
  person.root.visible = fade > 0.001;
  if (!person.root.visible) return;
  person.mats.forEach((m) => { m.opacity = fade; });
  // The head follows the gaze target, and flicks when asked to.
  let yaw = 0, pitch = 0;
  if (s.gaze) {
    const dx = (s.gaze.x / W - 0.5) * SCREEN.w;
    const dy = -(s.gaze.y / H - 0.5) * SCREEN.h + SCREEN.y - HEAD.y;
    const dist = HEAD.z - SCREEN.z;
    yaw = -Math.atan2(dx, dist) * 0.5 * s.gazeA;
    pitch = Math.atan2(dy, dist) * 0.45 * s.gazeA;
  }
  yaw -= s.flick * 0.36;
  person.head.rotation.set(-pitch, yaw, 0);
  s.headYaw = yaw;
}

// ---------------------------------------------------------------- effects

// Thin shimmering tube whose light travels along its length.
function beamMaterial(color, opacity = 1) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    uniforms: { uTime: { value: 0 }, uA: { value: opacity }, uColor: { value: new THREE.Color(color) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec2 vUv; uniform float uTime; uniform float uA; uniform vec3 uColor;
      void main(){
        float d = fract(vUv.x * 2.0 - uTime * 0.9);
        float pulse = smoothstep(0.0, 0.25, d) * smoothstep(0.55, 0.25, d);
        float fade = smoothstep(0.0, 0.1, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
        gl_FragColor = vec4(uColor * (0.5 + pulse * 1.6), (0.3 + pulse * 0.7) * fade * uA);
      }`,
  });
}

class Beam {
  constructor(scene, color, radius) {
    this.radius = radius;
    this.mat = beamMaterial(color);
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.key = '';
    scene.add(this.mesh);
  }
  set(a, b, sag, opacity, time) {
    this.mesh.visible = opacity > 0.002;
    if (!this.mesh.visible) return;
    this.mat.uniforms.uA.value = opacity;
    this.mat.uniforms.uTime.value = time;
    const key = [a.x, a.y, a.z, b.x, b.y, b.z].map((n) => n.toFixed(3)).join();
    if (key === this.key) return;
    this.key = key;
    const mid = a.clone().lerp(b, 0.5);
    mid.y += sag;
    mid.z += Math.abs(sag) * 0.6;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 20, this.radius, 6, false);
  }
}

function buildEffects(scene, renderer) {
  const gazeBeam = new Beam(scene, 0x7fe7ff, 0.0028);
  const gazeSpot = glow(0x2f7bff, 0.3, 0);
  scene.add(gazeSpot);

  // Webcam watching the head: a very faint cone that says "just this camera".
  const coneGeo = new THREE.ConeGeometry(0.2, 1, 32, 1, true);
  coneGeo.translate(0, -0.5, 0);
  const cone = new THREE.Mesh(coneGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    uniforms: { uA: { value: 0 }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec2 vUv; uniform float uA; uniform float uTime;
      void main(){
        float band = 0.5 + 0.5 * sin(vUv.y * 42.0 + uTime * 2.2);
        gl_FragColor = vec4(vec3(0.5, 0.9, 1.0), (0.016 + band * 0.022) * vUv.y * uA);
      }`,
  }));
  scene.add(cone);

  // The voice: a low arc of bars floating in front of the screen.
  const BARS = 56;
  const barGeo = new THREE.CapsuleGeometry(0.0042, 1, 4, 10);
  const barMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, opacity: 0 });
  const bars = new THREE.InstancedMesh(barGeo, barMat, BARS);
  bars.frustumCulled = false;
  const col = new THREE.Color();
  for (let i = 0; i < BARS; i++) {
    col.setHex(0x2f7bff).lerp(new THREE.Color(0x9ff0ff), Math.abs(i / (BARS - 1) - 0.5) < 0.2 ? 0.9 : 0.25);
    bars.setColorAt(i, col);
  }
  scene.add(bars);
  const barsGlow = glow(0x2f7bff, 0.9, 0);
  scene.add(barsGlow);

  // The AI panel: a glass slab in front of the browser, with light tying it to the page.
  const panel = createPanel(LOW ? 512 : 900);
  const panelTex = canvasTexture(panel.canvas, renderer);
  const pW = 0.33, pH = pW * (PANEL_H / PANEL_W);
  const slab = new THREE.Group();
  const face = new THREE.Mesh(new THREE.PlaneGeometry(pW, pH), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true, toneMapped: false, depthWrite: false, opacity: 0 }));
  slab.add(face);
  const aura = glow(0x2f7bff, 0.95, 0);
  aura.position.z = -0.02;
  slab.add(aura);
  scene.add(slab);

  // The AI's core: a small wire crystal in the panel's corner. It later flies out to the finale.
  const core = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x7fe7ff, wireframe: true, transparent: true, toneMapped: false, opacity: 0 }));
  const heart = new THREE.Mesh(new THREE.IcosahedronGeometry(0.52, 2), new THREE.MeshBasicMaterial({ color: 0x8fc0ff, transparent: true, toneMapped: false, opacity: 0 }));
  const coreGlow = glow(0x2f7bff, 4.5, 0);
  core.add(shell, heart, coreGlow);
  core.scale.setScalar(0.016);
  slab.add(core);

  const link = new Beam(scene, 0x7fe7ff, 0.0026);
  const planLink = new Beam(scene, 0x5b98ff, 0.0018);
  const linkSpot = glow(0x7fe7ff, 0.2, 0);
  scene.add(linkSpot);

  const placement = () => (innerWidth / innerHeight < 1
    ? { x: 0, y: 1.655, z: -0.3, ry: 0, s: 1.02 }
    : { x: -0.3, y: SCREEN.y + 0.005, z: -0.1, ry: 0.24, s: 1 });

  return {
    gazeBeam, gazeSpot, cone, bars, barMat, barsGlow, BARS, panel, panelTex, slab, face, aura, core, shell, heart, coreGlow,
    link, planLink, linkSpot, pW, pH, placement, refresh: () => { panel.draw({ status: '', typed: '', steps: [], stepA: [], caret: false, nonce: Math.random() }); },
  };
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _o = new THREE.Object3D(), _eye = new THREE.Vector3();

function applyEffects(fx, T, s, time) {
  // Gaze beam from between the eyes to what the eyes have landed on.
  if (s.gaze && s.gazeA > 0) {
    _eye.set(0, HEAD.y + 0.01, HEAD.z - 0.1);
    screenWorld(s.gaze, _b);
    fx.gazeBeam.set(_eye.clone(), _b.clone(), 0, s.gazeA, time);
    fx.gazeSpot.position.copy(_b); fx.gazeSpot.position.z += 0.01;
    fx.gazeSpot.material.opacity = s.gazeA * 0.8;
  } else {
    fx.gazeBeam.set(_a, _b, 0, 0, time);
    fx.gazeSpot.material.opacity = 0;
  }
  const camA = ease(T, 0.95, 1.12) * (1 - ease(T, 1.86, 1.98));
  fx.cone.visible = camA > 0.001;
  if (fx.cone.visible) {
    const top = new THREE.Vector3(0, SCREEN.y + SCREEN.h / 2 + 0.026, SCREEN.z + 0.01);
    const dir = HEAD.clone().add(new THREE.Vector3(0, 0.03, 0)).sub(top);
    const len = dir.length();
    fx.cone.position.copy(top);
    fx.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
    fx.cone.scale.set(0.78, len, 0.78);
    fx.cone.material.uniforms.uA.value = camA;
    fx.cone.material.uniforms.uTime.value = time;
  }

  // Waveform: quiet between phrases, shaped like speech while talking.
  const barsOn = ease(T, 2.05, 2.18) * (1 - ease(T, 2.9, 3.0));
  fx.bars.visible = barsOn > 0.001;
  fx.barMat.opacity = barsOn * (0.4 + 0.6 * s.voice);
  fx.barsGlow.material.opacity = barsOn * (0.15 + s.voice * 0.32);
  fx.barsGlow.position.set(0, SCREEN.y - 0.115, SCREEN.z + 0.18);
  if (fx.bars.visible) {
    const n = fx.BARS;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1) - 0.5;
      const env = Math.exp(-u * u * 13);
      const a = Math.sin(time * 6.1 + i * 0.5) * 0.5 + Math.sin(time * 9.7 - i * 0.83) * 0.3 + Math.sin(time * 3.3 + i * 0.21) * 0.4;
      const speech = (0.22 + Math.abs(a)) * env * s.voice;
      const h = 0.003 + speech * 0.11 + Math.sin(time * 1.2 + i * 0.32) * 0.0015 + 0.002;
      _o.position.set(u * SCREEN.w * 0.84, SCREEN.y - 0.115, SCREEN.z + 0.1 + (0.25 - u * u) * 0.34);
      _o.rotation.set(0, 0, 0);
      _o.scale.set(1, Math.max(0.0001, h), 1);
      _o.updateMatrix();
      fx.bars.setMatrixAt(i, _o.matrix);
    }
    fx.bars.instanceMatrix.needsUpdate = true;
  }

  // The AI panel, and the light joining it to whatever the browser is doing.
  const flyOut = ease(T, 4.0, 4.12);
  const panelA = (s.ai?.a ?? (T >= 4 ? 1 : 0)) * (1 - flyOut);
  fx.slab.visible = panelA > 0.001 || (T >= 3 && T < 4.5);
  const place = fx.placement();
  fx.slab.position.set(place.x, place.y + (1 - ease(T, 3.03, 3.14)) * -0.03, place.z);
  fx.slab.rotation.y = place.ry;
  fx.slab.scale.setScalar(place.s);
  fx.face.material.opacity = panelA;
  fx.aura.material.opacity = panelA * 0.32;
  fx.face.visible = panelA > 0.001;
  fx.shell.material.opacity = T >= 3 && T < 4 ? panelA * 0.95 : 0;
  fx.heart.material.opacity = T >= 3 && T < 4 ? panelA * 0.95 : 0;
  fx.coreGlow.material.opacity = T >= 3 && T < 4 ? panelA * 0.8 : 0;
  fx.core.position.set(-fx.pW * 0.405, fx.pH * 0.5 - (74 / PANEL_H) * fx.pH, 0.006);
  if (!REDUCED) fx.core.rotation.set(time * 0.4, time * 0.6, 0);
  if (s.ai) {
    if (fx.panel.draw(s.ai.panel)) fx.panelTex.needsUpdate = true;
  }
  if (s.link && panelA > 0.2) {
    const yFrac = PANEL_STEP_Y(s.link.stage) / PANEL_H;
    const portrait = innerWidth / innerHeight < 1;
    _a.set(portrait ? -fx.pW * 0.3 : fx.pW * 0.48, fx.pH * (0.5 - yFrac), 0.004);
    fx.slab.localToWorld(_a);
    screenWorld(s.link.target, _b);
    fx.link.set(_a.clone(), _b.clone(), portrait ? -0.02 : 0.03, panelA, time);
    fx.linkSpot.position.copy(_b); fx.linkSpot.position.z += 0.012;
    fx.linkSpot.material.opacity = 0.8 * panelA;
  } else {
    fx.link.set(_a, _b, 0, 0, time);
    fx.linkSpot.material.opacity = 0;
  }
  // A second, steady link from the panel body to the screen while the plan is forming.
  const forming = T >= 3 ? ease(T, 3.28, 3.34) * (1 - ease(T, 3.38, 3.42)) : 0;
  if (forming > 0) {
    const portrait = innerWidth / innerHeight < 1;
    _a.set(portrait ? 0 : fx.pW * 0.49, portrait ? -fx.pH * 0.48 : 0, 0.004);
    fx.slab.localToWorld(_a);
    _b.set(SCREEN.x, SCREEN.y, SCREEN.z + 0.004);
    fx.planLink.set(_a.clone(), _b.clone(), 0, forming, time);
  } else {
    fx.planLink.set(_a, _b, 0, 0, time);
  }
}

// ---------------------------------------------------------------- finale

function buildFinale(scene, renderer) {
  const basic = (color, o = {}) => new THREE.MeshBasicMaterial({ color, transparent: true, toneMapped: false, fog: false, depthWrite: false, ...o });
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  // The eye: a ring and a pupil. Input one.
  const eye = new THREE.Group();
  const eyeMats = [basic(0x7fe7ff), basic(0xeaf6ff), basic(0x2f7bff, { side: THREE.DoubleSide, opacity: 0.2 })];
  const ringGeo = new THREE.TorusGeometry(0.1, 0.0065, 12, 72);
  eye.add(new THREE.Mesh(ringGeo, eyeMats[0]));
  const iris = new THREE.Mesh(new THREE.SphereGeometry(0.038, 24, 18), eyeMats[1]);
  eye.add(iris);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.094, 48), eyeMats[2]);
  disc.position.z = -0.003;
  eye.add(disc);
  const eyeGlow = glow(0x2f7bff, 0.5, 0.5);
  eyeGlow.material.fog = false;
  eye.add(eyeGlow);
  group.add(eye);

  // The voice: a small waveform. Input two.
  const voice = new THREE.Group();
  const VB = 9;
  const vMat = basic(0x7fe7ff);
  const vGeo = new THREE.CapsuleGeometry(0.0095, 1, 4, 10);
  const vBars = [];
  for (let i = 0; i < VB; i++) {
    const m = new THREE.Mesh(vGeo, vMat);
    m.position.x = (i - (VB - 1) / 2) * 0.03;
    voice.add(m);
    vBars.push(m);
  }
  const vGlow = glow(0x2f7bff, 0.5, 0.5);
  vGlow.material.fog = false;
  voice.add(vGlow);
  group.add(voice);

  // The AI: the wire crystal from the panel. Input three.
  const ai = new THREE.Group();
  const aiMats = [basic(0x7fe7ff, { wireframe: true }), basic(0x8fc0ff)];
  ai.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 1), aiMats[0]));
  ai.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.046, 2), aiMats[1]));
  const aGlow = glow(0x2f7bff, 0.5, 0.5);
  aGlow.material.fog = false;
  ai.add(aGlow);
  group.add(ai);

  // The window they become.
  const winW = 0.86, winH = winW * 0.6;
  const winTex = canvasTexture(paintUnified(LOW ? 900 : 1500), renderer);
  const winMat = new THREE.MeshBasicMaterial({ map: winTex, transparent: true, toneMapped: false, fog: false, depthWrite: false, opacity: 0, side: THREE.DoubleSide });
  const win = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH), winMat);
  win.renderOrder = -1;
  group.add(win);
  const winAura = glow(0x2f7bff, 1.6, 0);
  winAura.material.fog = false;
  winAura.position.z = -0.08;
  winAura.renderOrder = -2;
  group.add(winAura);

  const lines = [0, 1, 2].map(() => {
    const b = new Beam(scene, 0x7fe7ff, 0.0024);
    b.mat.fog = false;
    return b;
  });

  return { group, eye, voice, ai, vBars, win, winAura, winMat, winW, winH, lines, eyeMats, vMat, aiMats, iris };
}

const _p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _start = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _slot = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

function applyFinale(f, T, time, fx) {
  const t = T - 4;
  f.group.visible = t > 0;
  if (t <= 0) { f.lines.forEach((l) => l.set(_a, _b, 0, 0, time)); return; }

  // Each object begins where its input lived in the film: at the head, the waveform, the panel.
  _start[0].copy(HEAD).setZ(HEAD.z - 0.14);
  _start[1].set(0, SCREEN.y - 0.1, SCREEN.z + 0.2);
  fx.slab.getWorldPosition(_start[2]);

  const portrait = innerWidth / innerHeight < 1;
  const R = portrait ? 0.21 : 0.26;
  _tri[0].set(FINAL.x - R, FINAL.y - R * 0.3, FINAL.z);
  _tri[1].set(FINAL.x, FINAL.y + R * 0.72, FINAL.z);
  _tri[2].set(FINAL.x + R, FINAL.y - R * 0.3, FINAL.z);
  // Their last home: three slots in the unified window's toolbar.
  const topY = FINAL.y + f.winH * 0.5 - f.winH * (51 / 720);
  [0.76, 0.84, 0.92].forEach((u, i) => _slot[i].set(FINAL.x + (u - 0.5) * f.winW, topY, FINAL.z + 0.006));

  const gather = ease(t, 0.08, 0.36);
  const merge = ease(t, 0.5, 0.74);
  const arrive = ease(t, 0, 0.05);
  [f.eye, f.voice, f.ai].forEach((o, i) => {
    _p[i].copy(_start[i]).lerp(_tri[i], gather).lerp(_slot[i], merge);
    if (!REDUCED) _p[i].y += Math.sin(time * 0.9 + i * 2.1) * 0.006 * gather * (1 - merge);
    o.position.copy(_p[i]);
    o.scale.setScalar(mix(mix(0.5, 1, gather), 0.15, merge) * arrive);
    o.visible = arrive > 0.001;
  });
  const shine = 1 - merge * 0.2;
  f.eyeMats[0].opacity = shine; f.eyeMats[1].opacity = shine; f.eyeMats[2].opacity = 0.2 * shine;
  f.vMat.opacity = shine;
  f.aiMats[0].opacity = shine; f.aiMats[1].opacity = shine;
  f.iris.position.set(Math.sin(time * 0.6) * 0.022 * (REDUCED ? 0 : 1), Math.cos(time * 0.47) * 0.012 * (REDUCED ? 0 : 1), 0.004);
  if (!REDUCED) f.ai.rotation.set(time * 0.35, time * 0.5, 0);
  f.vBars.forEach((m, i) => {
    const u = i / (f.vBars.length - 1) - 0.5;
    const amp = REDUCED ? 0.5 : 0.5 + 0.5 * Math.sin(time * 3.1 + i * 0.9);
    m.scale.y = 0.012 + (0.03 + amp * 0.09) * Math.exp(-u * u * 7);
  });

  // Lines draw between the three, then give way to the window.
  const lineA = ease(t, 0.26, 0.38) * (1 - ease(t, 0.5, 0.64));
  f.lines.forEach((l, i) => l.set(_p[i].clone(), _p[(i + 1) % 3].clone(), 0, lineA * 0.9, time));

  const winA = ease(t, 0.52, 0.76);
  f.winMat.opacity = winA;
  f.win.position.copy(FINAL);
  f.win.position.z -= 0.002;
  if (!REDUCED) f.win.position.y += Math.sin(time * 0.6) * 0.004 * winA;
  f.win.scale.setScalar(mix(0.78, 1, winA));
  f.winAura.position.set(FINAL.x, FINAL.y, FINAL.z - 0.08);
  f.winAura.material.opacity = winA * 0.3;
}

// ---------------------------------------------------------------- boot

try {
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2')) throw new Error('no webgl2');
  start();
} catch (error) {
  // Stays as a readable page with the same copy, just without the film.
  document.documentElement.classList.remove('has-3d');
  console.warn('film disabled:', error);
}
