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
    powerOn: ['눈길켜줘', '눈길켜', '눈길켜기', '눈길켜주세요', '눈길시작', '눈낄켜줘'],
    powerOff: ['눈길꺼줘', '눈길꺼', '눈길끄기', '눈길꺼주세요', '눈길종료', '눈낄꺼줘'],
    next: ['다음', '다음으로', '넘어가', '시작하기', 'next'],
    quickCalibrate: ['빠른교정', '빠른보정', '4점교정', '네점교정', '다시맞춤'],
    recenter: ['교정', '시선교정', '시선맞춤', '시선맞추기', '재교정', '영점', 'recenter', 'realign'],
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

  // Requests ending in an action verb, which name something on screen.
  // Any ending on a press word near the end of the sentence, because people say
  // 눌러줘, 눌러봐, 눌러 주세요, 클릭하세요, 클릭 좀 해줘 and more, not a fixed list.
  const FIND_KO = /^(.+?)\s*((?:눌러|누르|누를|클릭|선택|열어|들어가|찾아)[가-힣\s]{0,6})$/;
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

  const AGENT_MIN_CHARS = 4; // shorter than this is usually "네", "음", or a misheard word
  const withoutEnd = (text) => text.replace(/[.!?。]+$/, '');
  const WAKE = /^(?:헤이|해이|에이|hey|hi)[\s,]*(?:눈\s*길|눈낄|nungil)[\s,.!?]*(.*)$/i;

  // Whatever isn't one of the commands above goes to the AI as a task. Saying the name
  // first only makes it explicit, which matters in the few places silence is otherwise kept.
  function parseCommand(transcript) {
    const heard = transcript.trim();
    const wake = heard.match(WAKE);
    if (wake) return parseRequest(wake[1].trim());
    const local = parseLocal(heard);
    if (local) return local;
    return heard.replace(/[\s.,!?。]/g, '').length >= AGENT_MIN_CHARS ? { name: 'agent', goal: withoutEnd(heard), wake: false } : null;
  }

  function parseRequest(request) {
    if (!request) return { name: 'wake' };
    return parseLocal(request) ?? { name: 'agent', goal: withoutEnd(request), wake: true };
  }

  function parseLocal(transcript) {
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
    return parseFind(sentence);
  }

  // Saying the name alone opens a short window for the request itself.
  function createListener({ windowMs = 8000 } = {}) {
    let awakeUntil = 0;
    return (alternatives, now) => {
      const awake = now < awakeUntil;
      awakeUntil = 0;
      const parse = (heard) => (awake && !WAKE.test(heard.trim()) ? parseRequest(heard.trim()) : parseCommand(heard));
      // A plain command in any alternative beats the AI reading of the best guess.
      const AI_READINGS = new Set(['agent', 'find']);
      const plain = alternatives.find((heard) => {
        const command = parse(heard);
        return command && !AI_READINGS.has(command.name);
      });
      const chosen = plain ?? alternatives[0];
      const command = parse(chosen);
      if (command?.name === 'wake') awakeUntil = now + windowMs;
      return { command, transcript: chosen.trim() };
    };
  }

  globalThis.Commands = { parseCommand, createListener };
})();
