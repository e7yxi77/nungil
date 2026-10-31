// Speech transcript -> command. Only short, near-exact phrases match, so normal
// conversation near the mic doesn't trigger clicks.
(() => {
  const PHRASES = {
    click: ['클릭', '눌러', '선택', '이거', 'click', 'select', 'press'],
    down: ['아래로', '아래', '내려', '스크롤다운', '아래로스크롤', 'scrolldown', 'down'],
    up: ['위로', '올려', '스크롤업', '위로스크롤', 'scrollup', 'up'],
    top: ['맨위로', '맨위', 'top', 'gototop'],
    bottom: ['맨아래로', '맨아래', 'bottom', 'gotobottom'],
    back: ['뒤로', '뒤로가기', '이전', 'back', 'goback'],
    forward: ['앞으로', '앞으로가기', 'forward', 'goforward'],
    reload: ['새로고침', 'reload', 'refresh'],
    numbers: ['번호', '번호표시', '번호보여줘', 'numbers', 'shownumbers'],
    hide: ['번호숨기기', '숨기기', '취소', '닫기', '그만', '그만읽어', 'hide', 'hidenumbers', 'cancel', 'close', 'stopreading'],
    read: ['읽어줘', '읽어', '글읽기', '읽기', 'read', 'readaloud'],
    summarize: ['요약', '요약줘', '요약읽어줘', 'summarize', 'summary', 'summarizethis'],
    simplify: ['단순보기','간단히보기', '글만보기', 'simplify', 'readerview'],
    recenter: ['시선맞춤', '시선맞추기', '재교정', '영점', 'recenter', 'realign'],
    pause: ['멈춰', '정지', '일시정지', 'pause', 'stop'],
    resume: ['다시시작', '시작', '재개', 'resume', 'start'],
    help: ['도움말', '명령어', 'help'],
  };
  const LOOKUP = new Map(Object.entries(PHRASES).flatMap(([cmd, list]) => list.map((p) => [p, cmd])));

  const SINO = ['일', '이', '삼', '사', '오', '육', '칠', '팔', '구', '십',
    '십일', '십이', '십삼', '십사', '십오', '십육', '십칠', '십팔', '십구', '이십'];
  const NATIVE = ['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
  const COUNTER = ['한', '두', '세', '네'];
  const ENGLISH = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

  function parseNumber(s) {
    const digits = s.match(/^(\d{1,2})(번|번째)?$/);
    if (digits) return Number(digits[1]);
    const word = s.replace(/(번째|번)$/, '');
    const hasCounter = word !== s;
    for (const list of [SINO, NATIVE, ENGLISH]) {
      const i = list.indexOf(word);
      if (i >= 0) return i + 1;
    }
    if (hasCounter) {
      const i = COUNTER.indexOf(word);
      if (i >= 0) return i + 1;
    }
    return null;
  }

  // Free-form requests go to the AI, so they must end in an explicit action verb.
  // Anything else near the mic stays ignored, and is never sent anywhere.
  const FIND_KO = /^(.+?)\s*(눌러\s*줘|눌러\s*주세요|눌러|클릭\s*해\s*줘|클릭\s*해\s*주세요|클릭\s*해|열어\s*줘|열어\s*주세요|열어|찾아\s*줘|찾아\s*주세요|찾아)$/;
  const FIND_EN = /^(click|press|open|find)\s+(?:on\s+)?(.+)$/i;
  const DEMONSTRATIVES = new Set(['이거', '저거', '그거', '이것', '저것', '그것', '여기', 'this', 'that', 'it']);

  function parseFind(text) {
    const ko = text.match(FIND_KO);
    const en = text.match(FIND_EN);
    if (!ko && !en) return null;
    const query = (ko ? ko[1] : en[2]).trim();
    const verb = ko ? ko[2] : en[1].toLowerCase();
    if (DEMONSTRATIVES.has(query.toLowerCase())) return { name: 'click' };
    const n = parseNumber(query.replace(/\s/g, ''));
    if (n) return { name: 'number', n };
    return { name: 'find', query, text, click: !/^(찾아|find)/.test(verb) };
  }

  // A whole task for the AI to carry out. The same rule as above: it must be phrased
  // as a request, and long enough not to be a stray remark.
  const AGENT_KO = /(해\s*줘|해\s*주세요|줘|주세요)$/;
  const AGENT_EN = /^(go to|search for|compose|write an?)\s+\S/i;
  const AGENT_MIN_CHARS = 8;

  function parseAgent(text) {
    if (text.replace(/\s/g, '').length < AGENT_MIN_CHARS) return null;
    return AGENT_KO.test(text) || AGENT_EN.test(text) ? { name: 'agent', goal: text } : null;
  }

  function parseCommand(transcript) {
    const raw = transcript.trim();
    const typed = raw.match(/^(?:입력|타이핑|type)\s+(.+)$/i);
    if (typed) return { name: 'type', text: typed[1] };

    const s = raw.toLowerCase()
      .replace(/[\s.,!?。'"]/g, '')
      .replace(/(해줘|해주세요|하세요|해요|해)$/, '');
    if (LOOKUP.has(s)) return { name: LOOKUP.get(s) };

    // "클릭 5", "5번 클릭", "click 5"
    const clickWord = /^(?:클릭|click|select)(.+)$|^(.+?)(?:클릭|click|select)$/;
    const withClick = s.match(clickWord);
    const n = parseNumber(withClick ? withClick[1] ?? withClick[2] : s);
    if (n) return { name: 'number', n };
    const sentence = raw.replace(/[.!?。]+$/, '');
    return parseFind(sentence) ?? parseAgent(sentence);
  }

  globalThis.Commands = { parseCommand };
})();
