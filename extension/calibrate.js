// Grants camera/mic (offscreen documents can't show the prompt), then collects
// gaze samples on 9 screen points and stores the fitted model.
const SETTLE_MS = 900;
const HEAD_SETTLE_MS = 1500; // a head arrives much later than the eyes do
const COLLECT_MS = 1300;
const MAX_COLLECT_MS = 5000;
const MIN_SAMPLES = 8;
const MARGIN = 0.05; // close to the edges: navbars live there, and fits extrapolate badly
const GOOD_ERROR_PX = 150;
const OK_ERROR_PX = 280;

const HEAD_MODE = new URLSearchParams(location.search).get('mode') === 'head';
const $ = (id) => document.getElementById(id);
const sections = ['intro', 'ready', 'done'];
const show = (name) => sections.forEach((s) => { $(s).hidden = s !== name; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let previewStream = null;
let collecting = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'frame') return;
  $('faceState').textContent = msg.face
    ? '얼굴을 찾았어요 / Face found'
    : '얼굴을 찾는 중… 카메라를 바라봐 주세요 / Looking for your face…';
  $('begin').disabled = !msg.face;
  if (collecting && msg.face && !msg.blink) collecting.push(HEAD_MODE ? GazeModel.headOnly(msg.features) : msg.features);
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
    $('error').textContent = `권한을 받지 못했어요 / Permission failed: ${error.name}. `
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

// Looking at dots with the head still teaches the model nothing about the head,
// so turning it later wouldn't move the cursor. These dots are looked at by
// turning the head, which gives the fit real head-pose variation to learn from.
const HEAD_TURN_POINTS = [
  { x: 0.5, y: 0.5 },
  { x: MARGIN, y: MARGIN },
  { x: 0.5, y: MARGIN },
  { x: 1 - MARGIN, y: MARGIN },
  { x: 1 - MARGIN, y: 0.5 },
  { x: 1 - MARGIN, y: 1 - MARGIN },
  { x: 0.5, y: 1 - MARGIN },
  { x: MARGIN, y: 1 - MARGIN },
  { x: MARGIN, y: 0.5 },
];

async function collectPoint(point, index, samples, settleMs = SETTLE_MS) {
  const clientX = point.x * window.innerWidth;
  const clientY = point.y * window.innerHeight;
  const dot = $('dot');
  dot.classList.remove('collect');
  dot.style.left = `${clientX}px`;
  dot.style.top = `${clientY}px`;
  await sleep(settleMs);
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
  if (px <= GOOD_ERROR_PX) return `정확도가 좋아요 / Good accuracy: about ${Math.round(px)}px.`;
  if (px <= OK_ERROR_PX) return `쓸 수 있는 정도예요 / Usable: about ${Math.round(px)}px. 작은 링크는 "번호"로 고르세요. Use "numbers" for small links.`;
  return `오차가 커요 / High error: about ${Math.round(px)}px. 조명을 밝게 하고 다시 해 보세요. Try better lighting and redo.`;
}

async function runCalibration() {
  $('begin').disabled = true;
  stopPreview();
  await document.documentElement.requestFullscreen?.().catch(() => {});
  $('stage').hidden = false;
  await sleep(600);

  const samples = [];
  const eyePoints = shuffledPoints();
  const headPoints = HEAD_MODE ? [] : HEAD_TURN_POINTS;
  const total = eyePoints.length + headPoints.length;
  for (const [i, point] of eyePoints.entries()) {
    $('stageText').textContent = HEAD_MODE
      ? `머리를 돌려 코끝으로 점을 가리켜 주세요 · Turn your head to point your nose at the dot (${i + 1}/${total})`
      : `눈으로만 점을 바라봐 주세요 · Look at the dot with your eyes only (${i + 1}/${total})`;
    await collectPoint(point, i, samples, HEAD_MODE ? HEAD_SETTLE_MS : SETTLE_MS);
  }
  for (const [i, point] of headPoints.entries()) {
    const index = eyePoints.length + i;
    $('stageText').textContent = `이번엔 머리를 돌려서 점을 바라봐 주세요 · Now turn your head to face the dot (${index + 1}/${total})`;
    await collectPoint(point, index, samples, HEAD_SETTLE_MS);
  }

  $('stage').hidden = true;
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});

  const distinct = new Set(samples.map((s) => s.point)).size;
  if (distinct < total) {
    show('done');
    $('resultText').textContent = '일부 점에서 얼굴을 찾지 못했어요. 다시 해 주세요. / Your face was lost on some dots. Please redo.';
    return;
  }

  const { model } = GazeModel.fit(samples);
  const errorPx = GazeModel.crossValidate(samples);
  const eyeErrorPx = GazeModel.crossValidate(samples, (s) => s.point < eyePoints.length);
  const headErrorPx = headPoints.length ? GazeModel.crossValidate(samples, (s) => s.point >= eyePoints.length) : null;
  await chrome.storage.local.set({ [HEAD_MODE ? 'modelHead' : 'model']: { ...model, errorPx, eyeErrorPx, headErrorPx, version: NUNGIL_MODEL_VERSION, at: Date.now() } });
  await chrome.storage.local.remove('gazeBias');
  show('done');
  const parts = headErrorPx === null ? '' : ` (눈 ${Math.round(eyeErrorPx)}px · 머리 ${Math.round(headErrorPx)}px)`;
  $('resultText').textContent = describeError(errorPx) + parts;
}

$('begin').addEventListener('click', runCalibration);
$('again').addEventListener('click', runCalibration);
$('finish').addEventListener('click', () => window.close());

// Skip the permission step on a recalibration.
navigator.permissions.query({ name: 'camera' }).then(async (camera) => {
  const mic = await navigator.permissions.query({ name: 'microphone' });
  if (camera.state !== 'granted' || mic.state !== 'granted') return;
  previewStream = await navigator.mediaDevices.getUserMedia({ video: true });
  $('preview').srcObject = previewStream;
  show('ready');
  await saveSettings({ enabled: true });
});
