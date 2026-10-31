// Plays the guide's demos: a virtual pointer moving over a mock screen and pressing
// what the user would press. Each runs on a loop, and stops the moment the step changes.
(() => {
  const CURSOR_SVG = '<svg viewBox="0 0 24 24"><path d="M5 2 L5 20 L10 15.5 L13.5 22.5 L16.5 21 L13 14 L20 14 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const REPEAT_PAUSE_MS = 3000;
  const PACE = 1.5; // everything in a demo waits this much longer than written
  const CAPTION_FADE_MS = 300;
  // Long enough to read a caption before the next one replaces it.
  const CAPTION_MIN_MS = 2600;
  const CAPTION_MS_PER_CHAR = 95;
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  class Stopped extends Error {}

  function director(scene, caption, isCurrent) {
    const instant = reducedMotion();
    const $ = (id) => scene.querySelector(`#${id}`);
    const cursor = document.createElement('div');
    cursor.className = 'vcursor';
    cursor.innerHTML = CURSOR_SVG;
    scene.appendChild(cursor);
    if (instant) cursor.style.display = 'none';

    const wait = async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, instant ? Math.min(ms, 400) : ms * PACE * GuideDemo.speed));
      if (!isCurrent()) throw new Stopped();
    };
    const rawWait = async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, instant ? 0 : ms));
      if (!isCurrent()) throw new Stopped();
    };
    let captionShownAt = 0;
    const pointOf = (el) => {
      const s = scene.getBoundingClientRect(), r = el.getBoundingClientRect();
      return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
    };
    const place = (x, y) => { cursor.style.transform = `translate(${x}px, ${y}px)`; };
    place(scene.clientWidth * 0.5, scene.clientHeight * 0.75);

    return {
      $,
      wait,
      // Holds until the current caption has been readable for long enough, then cross-fades.
      say: async (text) => {
        const read = Math.max(CAPTION_MIN_MS, caption.textContent.length * CAPTION_MS_PER_CHAR) * GuideDemo.speed;
        const remaining = caption.textContent ? read - (performance.now() - captionShownAt) : 0;
        if (remaining > 0) await rawWait(remaining);
        if (!instant && caption.textContent) {
          caption.classList.add('fading');
          await rawWait(CAPTION_FADE_MS);
        }
        caption.textContent = text;
        caption.classList.remove('fading');
        captionShownAt = performance.now();
      },
      asPointer: () => { cursor.classList.remove('gaze'); cursor.innerHTML = CURSOR_SVG; },
      asGaze: () => { cursor.classList.add('gaze'); cursor.innerHTML = ''; },
      hide: () => { cursor.style.opacity = 0; },
      appear: () => { cursor.style.opacity = 1; },
      moveTo: async (id) => {
        const el = $(id), p = pointOf(el);
        place(p.x, p.y);
        await wait(800);
      },
      click: async (id) => {
        const el = $(id), p = pointOf(el);
        place(p.x, p.y);
        await wait(800);
        cursor.classList.add('press');
        el.classList.add('pressed');
        const ripple = document.createElement('div');
        ripple.className = 'ripple';
        ripple.style.left = `${p.x}px`;
        ripple.style.top = `${p.y}px`;
        scene.appendChild(ripple);
        setTimeout(() => ripple.remove(), 500);
        await wait(170);
        cursor.classList.remove('press');
        el.classList.remove('pressed');
        await wait(220);
      },
      put: (id, cls, on = true) => $(id).classList.toggle(cls, on),
      type: async (id, text) => {
        const el = $(id);
        el.textContent = '';
        for (const ch of text) {
          el.textContent += ch;
          await wait(45);
        }
      },
      speak: async (id, text) => {
        const b = $(id);
        b.textContent = text;
        b.classList.add('show');
        await wait(1100);
      },
      silence: (id) => $(id).classList.remove('show'),
      countAt: (id, target) => {
        const c = $(id), p = pointOf($(target));
        c.style.left = `${p.x}px`;
        c.style.top = `${p.y}px`;
        c.classList.remove('run');
        c.style.opacity = 1;
        void c.offsetWidth; // restart the transition
        c.classList.add('run');
      },
      countOff: (id) => { const c = $(id); c.style.opacity = 0; c.classList.remove('run'); },
    };
  }

  const DEMOS = {
    async toolbar(d) {
      await d.say('먼저 주소창 오른쪽의 퍼즐 조각을 눌러요.');
      await d.wait(500);
      await d.click('d-puzzle');
      d.put('d-menu', 'show');
      await d.wait(600);
      await d.say('눈길 옆의 핀을 눌러 툴바에 고정해요.');
      await d.click('d-pin');
      d.put('d-pin', 'done');
      d.put('d-pinned', 'shown');
      await d.wait(900);
      d.put('d-menu', 'show', false);
      await d.say('이제 툴바의 눈길 아이콘을 누르면 설정창이 열려요.');
      await d.wait(500);
      await d.click('d-pinned');
      d.put('d-mini', 'show');
      await d.wait(1600);
    },

    async settings(d) {
      const visit = async (row, text, toggle) => {
        await d.say(text);
        await d.moveTo(toggle ?? row);
        d.put(row, 'hl');
        if (toggle) {
          await d.wait(700);
          await d.click(toggle);
          d.put(toggle, 'on', false);
          await d.wait(500);
          await d.click(toggle);
          d.put(toggle, 'on');
        }
        await d.wait(900);
        d.put(row, 'hl', false);
      };
      await visit('r-on', '켜기: 눈길 전체를 켜고 꺼요. 누를 때마다 바뀌어요.', 't-on');
      await visit('r-dwell', '응시 클릭: 바라보기만 해도 눌러요. 끄면 말로만 눌러요.', 't-dwell');
      await visit('r-assist', '머리 보조: 머리 방향을 함께 써서 시선을 더 정확하게 잡아요.');
      await visit('r-mouth', '입 벌리기: 입을 1초쯤 벌리면 아래로 스크롤해요.');
      await visit('r-flick', '고개 까딱: 빠르게 까딱한 쪽의 옆 항목으로 옮겨요.');
      await visit('r-ai', 'AI 자동 수행: 기본 명령이 아닌 말을 AI가 대신 처리해요. 주변이 시끄러우면 꺼 두세요.');
      await visit('r-sound', '소리 조작: 말이 어려우면 팝 소리와 허밍으로 조작해요.');
      await visit('b-center', '시선 맞춤: 시선이 조금 어긋났을 때 눌러요.');
      await visit('b-cal', '시선 교정: 자리나 조명이 바뀌면 다시 해요.');
    },

    async dwell(d) {
      d.asGaze();
      await d.say('누르고 싶은 항목을 바라보면 파란 테두리가 생겨요. 파란 점이 내 시선이에요.');
      await d.moveTo('i2');
      d.put('i2', 'hl');
      await d.wait(600);
      await d.say('0.5초 뒤 동그란 카운트다운이 시작돼요.');
      d.countAt('d-count', 'i2');
      await d.wait(1500);
      d.countOff('d-count');
      d.put('i2', 'done');
      await d.say('다 차면 눌려요. 눈을 돌리면 취소돼요.');
      await d.wait(1500);
      d.put('i2', 'done', false);
      d.put('i2', 'hl', false);
      await d.say('결제나 삭제처럼 중요한 버튼은 빨간 테두리가 뜨고, 바라봐도 눌리지 않아요.');
      await d.moveTo('i3');
      d.put('i3', 'risky');
      await d.wait(1600);
      await d.say('말로 확인해야 눌려요.');
      await d.speak('d-bubble', '클릭');
      d.put('i3', 'risky', false);
      d.put('i3', 'done');
      await d.wait(1300);
      d.silence('d-bubble');
    },

    async flick(d) {
      const head = d.$('d-head');
      const nod = async (x, y) => {
        head.style.transform = `translate(${x}px, ${y}px) rotate(${x / 2}deg)`;
        await d.wait(190);
        head.style.transform = '';
        await d.wait(240);
      };
      d.hide();
      d.put('f1', 'hl');
      await d.say('원하는 버튼이 아니면, 그쪽으로 고개를 빠르게 까딱하고 돌아오세요.');
      await d.wait(1800);
      await nod(26, 0);
      d.put('f1', 'hl', false);
      d.put('f2', 'hl');
      await d.say('테두리가 오른쪽 항목으로 옮겨 가요.');
      await d.wait(1500);
      await nod(26, 0);
      d.put('f2', 'hl', false);
      d.put('f3', 'hl');
      await d.wait(1200);
      await nod(-26, 0);
      d.put('f3', 'hl', false);
      d.put('f2', 'hl');
      await d.say('왼쪽, 위, 아래도 같아요. 천천히 돌리면 움직이지 않아요. 옆에서 직접 해 보세요.');
      await d.wait(2800);
    },

    async recenter(d) {
      d.asGaze();
      await d.say('자세가 바뀌면 보는 곳과 테두리가 어긋날 수 있어요.');
      await d.moveTo('r-a');
      d.put('r-b', 'hl');
      await d.wait(1700);
      d.appear();
      d.asPointer();
      await d.say('눈길 아이콘을 눌러 설정창을 열고, 시선 맞춤을 눌러요. "교정"이라고 말해도 돼요.');
      await d.click('r-icon');
      d.put('r-mini', 'show');
      await d.wait(500);
      await d.click('r-btn');
      d.put('r-mini', 'show', false);
      d.put('r-b', 'hl', false);
      d.hide();
      await d.say('가운데 점을 2초 동안 바라보세요.');
      d.put('r-dot', 'show');
      await d.wait(2000);
      d.put('r-dot', 'show', false);
      d.put('r-a', 'hl');
      await d.say('다시 맞았어요. 그래도 어긋나면 설정창에서 시선 교정을 다시 해요.');
      await d.wait(2200);
    },

    async voice(d) {
      d.asGaze();
      await d.say('항목을 바라보면서 "클릭"이라고 말하면 바로 눌러요.');
      await d.moveTo('v2');
      d.put('v2', 'hl');
      await d.wait(500);
      await d.speak('v-bubble', '클릭');
      d.put('v2', 'done');
      await d.wait(1000);
      d.silence('v-bubble');
      d.put('v2', 'done', false);
      d.put('v2', 'hl', false);
      d.hide();
      await d.say('"번호"라고 말하면 항목마다 번호가 붙어요. 작은 링크도 쉽게 고를 수 있어요.');
      await d.speak('v-bubble', '번호');
      d.silence('v-bubble');
      ['v1', 'v2', 'v3'].forEach((id, i) => {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = i + 1;
        d.$(id).appendChild(b);
      });
      await d.wait(900);
      await d.speak('v-bubble', '3번');
      d.put('v3', 'done');
      await d.wait(900);
      d.silence('v-bubble');
      await d.say('"아래로", "뒤로", "입력 안녕하세요", "눈길 꺼줘"도 돼요. "도움말"이라고 하면 전체 목록이 나와요.');
      await d.speak('v-bubble', '아래로');
      d.$('v-page').style.transform = 'translateY(-70px)';
      await d.wait(1800);
      d.silence('v-bubble');
    },

    async ai(d) {
      await d.say('먼저 설정창에서 ChatGPT에 로그인해요. 처음 한 번이면 돼요.');
      await d.click('a-icon');
      d.put('a-mini', 'show');
      await d.wait(400);
      await d.click('a-login');
      d.put('a-mini', 'show', false);
      d.hide();
      await d.wait(400);
      await d.say('그다음 할 일을 그대로 말하면 돼요. 기본 명령이 아닌 말은 AI가 처리해요.');
      await d.speak('a-bubble', '메일 작성해줘');
      await d.wait(500);
      d.silence('a-bubble');
      await d.say('AI가 알아서 사이트로 이동해요.');
      await d.type('a-address', 'mail.google.com');
      d.put('a-mail', 'show');
      await d.wait(700);
      d.appear();
      await d.say('누르고, 내용을 입력해요. 파란 포인터처럼 AI가 직접 움직여요.');
      await d.click('a-compose');
      d.put('a-draft', 'show');
      await d.wait(500);
      await d.moveTo('a-body');
      await d.type('a-body', '안녕하세요, 내일 회의 시간을 확인하고 싶어요.');
      await d.wait(600);
      d.hide();
      await d.say('보내기 같은 중요한 버튼은 먼저 물어봐요. 멈추려면 "취소"라고 말하세요.');
      d.put('a-send', 'risky');
      await d.wait(2600);
    },
  };

  let session = 0;

  // Restores the scene's original markup each round, so every loop starts clean.
  async function play(scene, caption) {
    const mine = ++session;
    caption.textContent = '';
    const script = DEMOS[scene.dataset.demo];
    const original = scene.innerHTML;
    const isCurrent = () => mine === session;
    while (isCurrent()) {
      scene.innerHTML = original;
      try {
        await script(director(scene, caption, isCurrent));
        await new Promise((resolve) => setTimeout(resolve, REPEAT_PAUSE_MS * GuideDemo.speed));
      } catch (error) {
        if (error instanceof Stopped) break;
        throw error;
      }
    }
    if (!isCurrent()) scene.innerHTML = original;
  }

  globalThis.GuideDemo = {
    speed: 1, // below 1 runs faster; tests use it
    play,
    stop: () => { session++; },
  };
})();
