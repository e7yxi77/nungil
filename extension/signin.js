// Where the OAuth tab lands. The worker parks it here before redeeming the code,
// so success is only claimed once a token actually exists in storage.
const $ = (id) => document.getElementById(id);
let settled = false;

function succeed() {
  if (settled) return;
  settled = true;
  $('title').textContent = '로그인 완료';
  $('message').textContent = '이제 "로그인 버튼 눌러줘"라고 말해 보세요. 이 탭은 닫아도 돼요.';
}

function fail(reason) {
  if (settled) return;
  settled = true;
  $('title').textContent = '로그인 실패';
  $('message').textContent = reason === 'reload_extension'
    ? 'chrome://extensions 에서 눈길을 새로고침한 뒤 다시 시도해 주세요. 계속 이 화면이 나오면 삭제하고 다시 로드해 주세요.'
    : `확장 프로그램 팝업에서 다시 시도해 주세요. (${reason})`;
}

const initialError = new URLSearchParams(location.search).get('error');
if (initialError) fail(initialError);

chrome.storage.local.get(['oauth:chatgpt', 'oauth:error']).then((got) => {
  if (got['oauth:error']) fail(got['oauth:error']);
  else if (got['oauth:chatgpt']?.access) succeed();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes['oauth:error']?.newValue) fail(changes['oauth:error'].newValue);
  if (changes['oauth:chatgpt']?.newValue?.access) succeed();
});
