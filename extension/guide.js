// How-to steps after calibration, each playing a demo. Content scripts don't run on extension pages, so
// gaze can't press these buttons: "다음" spoken, or the arrow keys, moves on as well.
const $ = (id) => document.getElementById(id);
const steps = [...document.querySelectorAll('.step')];
const PRACTICE_STEP = steps.findIndex((s) => s.querySelector('.pad'));
const HIT_MS = 900;
const WORDS = { up: '위', down: '아래', left: '왼쪽', right: '오른쪽' };
const params = new URLSearchParams(location.search);
let index = 0;

const dots = steps.map(() => $('dots').appendChild(document.createElement('i')));

function show(next) {
  index = Math.max(0, Math.min(steps.length - 1, next));
  steps.forEach((s, i) => s.classList.toggle('on', i === index));
  dots.forEach((d, i) => d.classList.toggle('on', i === index));
  $('prev').hidden = index === 0;
  $('nextLabel').textContent = index === steps.length - 1 ? '시작하기' : '다음';
  $('practiceText').textContent = '';
  GuideDemo.stop();
  const scene = steps[index].querySelector('.scene');
  if (scene) GuideDemo.play(scene, steps[index].querySelector('.caption'));
}

async function finish() {
  await chrome.storage.local.set({ onboardingDone: true });
  window.close();
}

const forward = () => (index === steps.length - 1 ? finish() : show(index + 1));
const backward = () => show(index - 1);

$('next').addEventListener('click', forward);
$('prev').addEventListener('click', backward);
addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') forward();
  if (e.key === 'ArrowLeft') backward();
});

// Practice uses the same detector and direction logic as real pages.
const flick = GazeModel.createHeadFlick();

function lightUp(direction) {
  const tile = document.querySelector(`.pad [data-dir=${direction}]`);
  tile.classList.add('hit');
  setTimeout(() => tile.classList.remove('hit'), HIT_MS);
  $('practiceText').textContent = `${WORDS[direction]}으로 까딱했어요`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'command') {
    if (msg.command.name === 'next' || msg.command.name === 'forward') forward();
    else if (msg.command.name === 'back') backward();
    return;
  }
  if (msg.type !== 'frame' || !msg.face || msg.blink || !msg.features) return;
  const { flick: seen } = flick(msg.features[2], msg.features[3], performance.now());
  if (seen && index === PRACTICE_STEP) lightUp(GazeModel.flickDirection(seen));
});

// Reopened from the popup, there is no calibration to congratulate.
show(params.has('onboarding') ? 0 : 1);
