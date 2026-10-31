const $ = (id) => document.getElementById(id);
const TOGGLES = ['mouth', 'flick', 'agent', 'sound'];
let signedIn = false;
const SELF_HEAL_INTERVAL_MS = 60_000;
const PING_TIMEOUT_MS = 3000;

// Chrome doesn't retry a worker that crashed at startup, and new permissions only
// arrive on a reload, so either state stays broken until something reloads the
// extension. Pages like this one still run then, so this can do it.
async function selfHeal() {
  const timeout = new Promise((resolve) => setTimeout(resolve, PING_TIMEOUT_MS, false));
  const ping = chrome.runtime.sendMessage({ type: 'ping' }).then((r) => r?.ok === true, () => false);
  const alive = await Promise.race([ping, timeout]);
  // Reading the file shows what's on disk; getManifest shows what's actually running.
  const onDisk = await fetch(chrome.runtime.getURL('manifest.json')).then((r) => r.json()).catch(() => null);
  const current = onDisk?.version === chrome.runtime.getManifest().version;
  if (alive && current && chrome.webNavigation && chrome.tts) return;
  const { selfHealAt = 0 } = await chrome.storage.local.get('selfHealAt');
  if (Date.now() - selfHealAt < SELF_HEAL_INTERVAL_MS) return;
  await chrome.storage.local.set({ selfHealAt: Date.now() });
  chrome.runtime.reload();
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...NUNGIL_DEFAULTS, ...settings };
}

async function patchSettings(patch) {
  await chrome.storage.local.set({ settings: { ...(await getSettings()), ...patch } });
}

function setCell(id, text, bad = false) {
  $(id).textContent = text;
  $(id).classList.toggle('bad', bad);
}

async function render() {
  const settings = await getSettings();
  $('enabled').checked = settings.enabled;
  $('dwell').checked = settings.dwell;
  for (const id of TOGGLES) $(id).checked = settings[id];
  $('cursor').value = settings.cursor;
  $('dwellMs').value = settings.dwellMs;
  $('dwellValue').textContent = `${(settings.dwellMs / 1000).toFixed(1)}초`;

  const { status = {} } = await chrome.storage.session.get('status');
  const stored = await chrome.storage.local.get(['model', 'modelHead', 'oauth:chatgpt']);
  signedIn = Boolean(stored['oauth:chatgpt']?.access);
  $('codex').textContent = signedIn ? 'ChatGPT 로그아웃' : 'ChatGPT 로그인 (AI 기능)';
  const model = settings.cursor === 'head' ? stored.modelHead : stored.model;
  const failed = (v) => String(v ?? '').startsWith('error');
  const STATES = { on: '켜짐', listening: '듣는 중' };
  const say = (v) => STATES[v] ?? (failed(v) ? `오류 (${String(v).slice(6)})` : v ?? '-');
  setCell('camera', say(status.camera), failed(status.camera));
  setCell('face', status.face === undefined ? '-' : status.face ? '인식됨' : '안 보임', status.face === false);
  const voice = String(status.voice ?? '').startsWith('sound:') ? '소리 조작 중' : say(status.voice);
  setCell('voice', voice, failed(status.voice));
  const stale = model && model.version !== NUNGIL_MODEL_VERSION;
  setCell('model', !model ? '교정 필요' : stale ? '다시 교정 필요' : `약 ${Math.round(model.errorPx)}px`, !model || stale);
}

$('enabled').addEventListener('change', async (e) => {
  const camera = await navigator.permissions.query({ name: 'camera' });
  // Popups can't show the permission prompt, so first run goes through the setup page.
  if (e.target.checked && camera.state !== 'granted') {
    chrome.tabs.create({ url: 'calibrate.html' });
    return;
  }
  await patchSettings({ enabled: e.target.checked });
});
$('dwell').addEventListener('change', (e) => patchSettings({ dwell: e.target.checked }));
for (const id of TOGGLES) $(id).addEventListener('change', (e) => patchSettings({ [id]: e.target.checked }));
$('cursor').addEventListener('change', (e) => patchSettings({ cursor: e.target.value }));
$('dwellMs').addEventListener('input', (e) => patchSettings({ dwellMs: Number(e.target.value) }));
$('codex').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: signedIn ? 'codex-logout' : 'codex-login' }).catch(() => {});
});
$('recenter').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'command', command: { name: 'recenter' }, transcript: '' }).catch(() => {});
  window.close();
});
$('calibrate').addEventListener('click', async () => {
  const { cursor } = await getSettings();
  chrome.tabs.create({ url: cursor === 'head' ? 'calibrate.html?mode=head' : 'calibrate.html' });
});

chrome.storage.onChanged.addListener(render);
render();
selfHeal();
