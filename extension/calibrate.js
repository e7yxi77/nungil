// Grants camera/mic (offscreen documents can't show the prompt), then collects
// gaze samples on 9 screen points and stores the fitted model.
const SETTLE_MS = 900;
const COLLECT_MS = 1300;
const MAX_COLLECT_MS = 5000;
const MIN_SAMPLES = 8;
const MARGIN = 0.05; // close to the edges: navbars live there, and fits extrapolate badly
const GOOD_ERROR_PX = 150;
const OK_ERROR_PX = 280;

const params = new URLSearchParams(location.search);
const ONBOARDING = params.has('onboarding');
const PHASE_HOLD_MS = 3200;
const PHASE_FADE_MS = 900;
const $ = (id) => document.getElementById(id);
const sections = ['intro', 'ready', 'done'];
const show = (name) => sections.forEach((s) => { $(s).hidden = s !== name; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let previewStream = null;
let collecting = null;

// A ring of ticks around the camera, filled by holding the face in view for a moment.
const SCAN_TICKS = 72;
const SCAN_FILL_FRAMES = 30;
const SCAN_DECAY_FRAMES = 3;
let scanFrames = 0;

function buildTicks(svg, count) {
  const NS = 'http://www.w3.org/2000/svg';
  return Array.from({ length: count }, (_, i) => {
    const line = document.createElementNS(NS, 'line');
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    line.setAttribute('x1', 100 + Math.cos(angle) * 88);
    line.setAttribute('y1', 100 + Math.sin(angle) * 88);
    line.setAttribute('x2', 100 + Math.cos(angle) * 98);
    line.setAttribute('y2', 100 + Math.sin(angle) * 98);
    line.style.setProperty('--d', `${(i / count) * 2.2}s`);
    svg.appendChild(line);
    return line;
  });
}

const scanTicks = buildTicks($('scanTicks'), SCAN_TICKS);
const stageTicks = buildTicks($('stageRing'), SCAN_TICKS);

function lightTicks(ticks, share) {
  const lit = Math.round(share * ticks.length);
  ticks.forEach((tick, i) => tick.classList.toggle('lit', i < lit));
}

function updateScan(face) {
  scanFrames = face ? Math.min(SCAN_FILL_FRAMES, scanFrames + 1) : Math.max(0, scanFrames - SCAN_DECAY_FRAMES);
  lightTicks(scanTicks, scanFrames / SCAN_FILL_FRAMES);
  const full = scanFrames === SCAN_FILL_FRAMES;
  $('scan').classList.toggle('full', full);
  $('begin').disabled = !full;
  $('faceState').textContent = full
    ? '좋아요. 얼굴을 찾았어요'
    : face ? '그대로 잠시 있어 주세요…' : '얼굴을 찾는 중… 카메라를 바라봐 주세요';
}

// Whichever main button is showing, so "다음" works for people who can't press it.
function pressMain() {
  const button = ['allow', 'begin', 'finish'].map($).find((b) => b.offsetParent && !b.disabled);
  button?.click();
}

// One big message at a time on a dark screen, with the dots out of the way.
async function showPhase(title, sub) {
  $('dot').classList.add('off');
  $('stageRing').classList.add('off');
  $('stageText').textContent = '';
  $('phaseTitle').textContent = title;
  $('phaseSub').textContent = sub;
  $('phase').classList.add('on');
  await sleep(PHASE_FADE_MS + PHASE_HOLD_MS);
  $('phase').classList.remove('on');
  await sleep(PHASE_FADE_MS);
  $('dot').classList.remove('off');
  $('stageRing').classList.remove('off');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'command' && msg.command.name === 'next') { pressMain(); return; }
  if (msg.type !== 'frame') return;
  updateScan(msg.face);
  if (collecting && msg.face && !msg.blink) collecting.push(msg.features);
});

async function saveSettings(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...NUNGIL_DEFAULTS, ...settings, ...patch } });
}

function stopPreview() {
  previewStream?.getTracks().forEach((track) => track.stop());
  previewStream = null;
}

$('allow').addEventListener('click', async () => {
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (error) {
    $('error').hidden = false;
    $('error').textContent = `권한을 받지 못했어요 (${error.name}). `
      + '주소창의 설정과 시스템 설정의 카메라·마이크 권한을 확인해 주세요.';
    return;
  }
  previewStream.getAudioTracks().forEach((track) => track.stop());
  $('preview').srcObject = previewStream;
  show('ready');
  await saveSettings({ enabled: true });
  // The tracker may have started and failed before permission existed.
  chrome.runtime.sendMessage({ type: 'restart' }).catch(() => {});
});

// Stored in screen pixels, so the model still works in a differently sized window.
function toScreen(clientX, clientY) {
  return {
    x: window.screenX + (window.outerWidth - window.innerWidth) / 2 + clientX,
    y: window.screenY + (window.outerHeight - window.innerHeight) + clientY,
  };
}

function shuffledPoints() {
  const stops = [MARGIN, 0.5, 1 - MARGIN];
  const points = stops.flatMap((y) => stops.map((x) => ({ x, y })));
  return points.sort(() => Math.random() - 0.5);
}

// Inside the first round's grid, so each dot tests the model somewhere new.
const SECOND_ROUND = [
  { x: 0.5, y: 0.5 },
  { x: 0.27, y: 0.27 },
  { x: 0.5, y: 0.27 },
  { x: 0.73, y: 0.27 },
  { x: 0.73, y: 0.5 },
  { x: 0.73, y: 0.73 },
  { x: 0.5, y: 0.73 },
  { x: 0.27, y: 0.73 },
  { x: 0.27, y: 0.5 },
];

async function collectPoint(point, index, samples) {
  const clientX = point.x * window.innerWidth;
  const clientY = point.y * window.innerHeight;
  const dot = $('dot');
  dot.classList.remove('collect');
  dot.style.left = `${clientX}px`;
  dot.style.top = `${clientY}px`;
  await sleep(SETTLE_MS);
  dot.classList.add('collect');
  collecting = [];
  const started = performance.now();
  await sleep(COLLECT_MS);
  while (collecting.length < MIN_SAMPLES && performance.now() - started < MAX_COLLECT_MS) await sleep(100);
  const target = toScreen(clientX, clientY);
  for (const f of collecting) samples.push({ point: index, f, x: target.x, y: target.y });
  collecting = null;
}

function describeError(px) {
  if (px <= GOOD_ERROR_PX) return `정확도가 좋아요. 오차는 약 ${Math.round(px)}px이에요.`;
  if (px <= OK_ERROR_PX) return `쓸 수 있는 정도예요. 오차는 약 ${Math.round(px)}px이에요. 작은 링크는 "번호"로 고르세요.`;
  return `오차가 커요. 약 ${Math.round(px)}px이에요. 조명을 밝게 하고 다시 해 보세요.`;
}

async function runCalibration() {
  $('begin').disabled = true;
  stopPreview();
  await document.documentElement.requestFullscreen?.().catch(() => {});
  $('stage').hidden = false;
  await sleep(600);

  const samples = [];
  lightTicks(stageTicks, 0);
  const firstRound = shuffledPoints();
  const total = firstRound.length + SECOND_ROUND.length;
  const collectRound = async (points, offset) => {
    for (const [i, point] of points.entries()) {
      $('stageText').textContent = `눈으로만 점을 바라봐 주세요 (${offset + i + 1}/${total})`;
      await collectPoint(point, offset + i, samples);
      lightTicks(stageTicks, (offset + i + 1) / total);
    }
  };
  await showPhase('먼저 눈으로만 점을 바라봐 주세요', '머리는 움직이지 말고, 눈으로만 따라가요.');
  await collectRound(firstRound, 0);
  await showPhase('한 번 더 바라봐 주세요', '이번에도 머리는 그대로 두세요. 거의 끝났어요.');
  await collectRound(SECOND_ROUND, firstRound.length);

  $('stage').hidden = true;
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});

  const distinct = new Set(samples.map((s) => s.point)).size;
  $('success').toggleAttribute('hidden', true); // SVG elements have no .hidden property
  if (distinct < total) {
    show('done');
    $('resultText').textContent = '일부 점에서 얼굴을 찾지 못했어요. 다시 해 주세요.';
    return;
  }

  const { model } = GazeModel.fit(samples);
  const errorPx = GazeModel.crossValidate(samples);
  const everyDot = () => true;
  const errorX = GazeModel.crossValidate(samples, everyDot, GazeModel.errorX);
  const errorY = GazeModel.crossValidate(samples, everyDot, GazeModel.errorY);
  await chrome.storage.local.set({ model: { ...model, errorPx, errorX, errorY, version: NUNGIL_MODEL_VERSION, at: Date.now() } });
  await chrome.storage.local.remove('gazeBias');
  show('done');
  $('success').toggleAttribute('hidden', false);
  $('resultText').textContent = describeError(errorPx);
}

$('begin').addEventListener('click', runCalibration);
$('again').addEventListener('click', runCalibration);
$('finish').addEventListener('click', () => {
  if (ONBOARDING) location.href = 'guide.html?onboarding=1';
  else window.close();
});
$('later').addEventListener('click', async () => {
  await chrome.storage.local.set({ onboardingDone: true });
  window.close();
});

if (ONBOARDING) {
  document.title = '눈길 시작하기';
  $('introTitle').textContent = '시선 교정을 할게요';
  $('later').hidden = false;
  $('allow').textContent = '카메라·마이크 허용하고 시작';
  $('doneTitle').textContent = '등록이 완료됐어요';
  $('finish').textContent = '사용법 알아보기';
}

// Skip the permission step on a recalibration.
navigator.permissions.query({ name: 'camera' }).then(async (camera) => {
  const mic = await navigator.permissions.query({ name: 'microphone' });
  if (ONBOARDING || camera.state !== 'granted' || mic.state !== 'granted') return;
  previewStream = await navigator.mediaDevices.getUserMedia({ video: true });
  $('preview').srcObject = previewStream;
  show('ready');
  await saveSettings({ enabled: true });
});
