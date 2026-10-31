// The monitor's picture and the AI panel, painted to 2D canvases that become textures.
// Pages are painted once to offscreen canvases; each frame only composites them.

const FONT = "'Pretendard Variable', Pretendard, -apple-system, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif";
export const W = 1600;
export const H = 900;
const CHROME = 104;

const C = {
  page: '#0b1222', card: '#141e34', card2: '#1b2743', line: '#25324f',
  text: '#eef3ff', muted: '#8fa0bf', blue: '#2f7bff', cyan: '#7fe7ff', tabs: '#080d1a', bar: '#141c30',
};

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
function text(g, s, x, y, size, color, weight = 500, align = 'left') {
  g.font = `${weight} ${size}px ${FONT}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}
function bars(g, x, y, w, color = C.line, h = 14) {
  g.fillStyle = color;
  rr(g, x, y, w, h, h / 2);
  g.fill();
}

// Rectangles below are in screen coordinates (chrome included) so a highlight can use them as is.
const TILES = [72, 444, 816, 1188].map((x) => ({ x, y: CHROME + 190, w: 340, h: 300 }));
export const RECTS = {
  tiles: TILES,
  searchBox: { x: 380, y: CHROME + 262, w: 840, h: 76 },
  searchBtn: { x: 690, y: CHROME + 366, w: 220, h: 72 },
  nextBtn: { x: 1000, y: CHROME + 690, w: 150, h: 64 },
  gBox: { x: 340, y: CHROME + 292, w: 920, h: 76 },
  gBtn: { x: 680, y: CHROME + 396, w: 240, h: 68 },
  gResult: { x: 180, y: CHROME + 96, w: 1000, h: 128 },
};
const TILE_ART = [
  ['#16408f', '#2f7bff', '뉴스 읽기', '오늘의 주요 소식'],
  ['#0f5a78', '#3fc3e8', '검색하기', '찾고 싶은 것을 찾아요'],
  ['#2a2f7d', '#5a6cff', '동영상 보기', '이어서 보기'],
  ['#174a5e', '#2fa4a8', '지도 찾기', '가까운 길 안내'],
];

function canvas(w, h, scale) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const g = c.getContext('2d');
  g.scale(scale, scale);
  return [c, g];
}

function paintPortal(scale) {
  const h = 1320;
  const [c, g] = canvas(W, h, scale);
  g.fillStyle = C.page; g.fillRect(0, 0, W, h);
  text(g, '오늘의 소식', 72, 44, 30, C.text, 700);
  ['뉴스', '경제', '문화', '기술'].forEach((s, i) => text(g, s, 300 + i * 92, 44, 22, C.muted));
  rr(g, 1140, 22, 388, 44, 22); g.fillStyle = C.card; g.fill();
  text(g, '검색', 1168, 44, 19, C.muted);
  text(g, '오늘 무엇을 볼까요?', 72, 138, 48, C.text, 700);
  TILES.forEach((t, i) => {
    const y = t.y - CHROME, [a, b, title, sub] = TILE_ART[i];
    const grad = g.createLinearGradient(t.x, y, t.x + t.w, y + t.h);
    grad.addColorStop(0, a); grad.addColorStop(1, b);
    rr(g, t.x, y, t.w, t.h, 26); g.fillStyle = grad; g.fill();
    g.save(); rr(g, t.x, y, t.w, t.h, 26); g.clip();
    g.fillStyle = 'rgba(255,255,255,.1)';
    g.beginPath(); g.arc(t.x + t.w - 50, y + 60, 110 + i * 14, 0, 7); g.fill();
    g.fillStyle = 'rgba(4,10,28,.2)';
    g.beginPath(); g.arc(t.x + 40, y + t.h + 20, 150, 0, 7); g.fill();
    g.restore();
    text(g, title, t.x + 28, y + t.h - 76, 38, '#fff', 700);
    text(g, sub, t.x + 28, y + t.h - 34, 21, 'rgba(255,255,255,.78)');
  });
  const stories = [
    '시각장애인용 음성 지도, 전국 지하철로 넓어져', '장애인 고용 박람회, 다음 달 온라인으로 열려',
    '웹 접근성 인증 기관, 올해 지원 항목 발표', '동네 도서관 큰 글자 책 서비스 시작',
    '대학생 팀이 만든 시선 입력 도구, 해커톤 수상', '가을 날씨 맑고 일교차 커, 외투 챙기세요',
    '휠체어 여행 지도 앱 사용자 10만 명 돌파', '보조공학기기 지원 신청 이달 말까지',
  ];
  stories.forEach((s, i) => {
    const col = i % 2, row = (i - col) / 2;
    const x = 72 + col * 744, y = 540 + row * 180;
    const grad = g.createLinearGradient(x, y, x + 180, y + 140);
    grad.addColorStop(0, C.card2); grad.addColorStop(1, ['#1e3a7a', '#154f66', '#29306f', '#185260'][(i + row) % 4]);
    rr(g, x, y, 180, 140, 18); g.fillStyle = grad; g.fill();
    text(g, s.slice(0, 22), x + 204, y + 34, 26, C.text, 600);
    bars(g, x + 204, y + 72, 440); bars(g, x + 204, y + 100, 320);
  });
  return c;
}

function paintSearch(scale) {
  const [c, g] = canvas(W, H - CHROME, scale);
  g.fillStyle = C.page; g.fillRect(0, 0, W, H);
  text(g, '오늘의 소식', 72, 44, 30, C.text, 700);
  text(g, '무엇을 찾을까요?', W / 2, 186, 58, C.text, 700, 'center');
  const b = RECTS.searchBox;
  rr(g, b.x, b.y - CHROME, b.w, b.h, 38); g.fillStyle = C.card; g.fill();
  text(g, '오늘의 날씨', b.x + 40, b.y - CHROME + b.h / 2, 30, C.text);
  const s = RECTS.searchBtn;
  rr(g, s.x, s.y - CHROME, s.w, s.h, 36); g.fillStyle = C.card2; g.fill();
  text(g, '검색', s.x + s.w / 2, s.y - CHROME + s.h / 2, 30, C.text, 600, 'center');
  return c;
}

function paintResults(scale, query, lines, pageNo) {
  const [c, g] = canvas(W, H - CHROME, scale);
  g.fillStyle = C.page; g.fillRect(0, 0, W, H);
  text(g, '오늘의 소식', 72, 44, 30, C.text, 700);
  rr(g, 340, 18, 640, 54, 27); g.fillStyle = C.card; g.fill();
  text(g, query, 372, 45, 24, C.text);
  lines.forEach((s, i) => {
    const y = 110 + i * 112;
    text(g, s, 180, y + 16, 32, C.cyan, 600);
    bars(g, 180, y + 48, 900); bars(g, 180, y + 72, 640);
  });
  const n = RECTS.nextBtn, ny = n.y - CHROME;
  [1, 2, 3].forEach((p, i) => {
    const x = 720 + i * 88;
    rr(g, x, ny, 64, 64, 18); g.fillStyle = p === pageNo ? C.blue : C.card; g.fill();
    text(g, String(p), x + 32, ny + 33, 26, C.text, 600, 'center');
  });
  rr(g, n.x, ny, n.w, n.h, 18); g.fillStyle = C.card2; g.fill();
  text(g, '다음', n.x + n.w / 2, ny + 33, 26, C.text, 600, 'center');
  return c;
}

function paintNewTab(scale) {
  const [c, g] = canvas(W, H - CHROME, scale);
  g.fillStyle = C.page; g.fillRect(0, 0, W, H);
  text(g, '새 탭', W / 2, 220, 56, C.text, 700, 'center');
  rr(g, 340, 292, 920, 76, 38); g.fillStyle = C.card; g.fill();
  text(g, '검색하거나 주소를 입력하세요', 384, 330, 28, C.muted);
  ['소식', '메일', '지도', '영상', '은행', '쇼핑'].forEach((s, i) => {
    const x = 420 + i * 152;
    g.beginPath(); g.arc(x, 480, 46, 0, 7); g.fillStyle = C.card2; g.fill();
    text(g, s, x, 560, 22, C.muted, 500, 'center');
  });
  return c;
}

function paintGoogle(scale) {
  const [c, g] = canvas(W, H - CHROME, scale);
  g.fillStyle = '#10131a'; g.fillRect(0, 0, W, H);
  text(g, 'Google', W / 2, 190, 110, '#f2f4f8', 600, 'center');
  const b = RECTS.gBox;
  rr(g, b.x, b.y - CHROME, b.w, b.h, 38); g.fillStyle = '#1e222c'; g.fill();
  g.strokeStyle = '#3a404e'; g.lineWidth = 2; g.stroke();
  const s = RECTS.gBtn;
  rr(g, s.x, s.y - CHROME, s.w, s.h, 16); g.fillStyle = '#272b36'; g.fill();
  text(g, 'Google 검색', s.x + s.w / 2, s.y - CHROME + s.h / 2 + 1, 26, '#e6e9f0', 500, 'center');
  return c;
}

function paintGoogleResults(scale) {
  const [c, g] = canvas(W, H - CHROME, scale);
  g.fillStyle = '#10131a'; g.fillRect(0, 0, W, H);
  text(g, 'Google', 60, 48, 40, '#f2f4f8', 600);
  rr(g, 200, 16, 760, 60, 30); g.fillStyle = '#1e222c'; g.fill();
  text(g, '해커톤', 236, 47, 26, '#f2f4f8');
  ['2026 접근성 해커톤 참가 안내', '해커톤이란? 처음 나가는 사람을 위한 가이드', '대학생 해커톤 일정 모음', '올해의 해커톤 수상작 살펴보기', '온라인 해커톤 준비 체크리스트'].forEach((s, i) => {
    const y = 110 + i * 132;
    text(g, s, 200, y + 34, 34, '#8ab4ff', 500);
    bars(g, 200, y + 70, 860, '#2a2f3b'); bars(g, 200, y + 96, 620, '#2a2f3b');
  });
  return c;
}

export function createScreen(texWidth) {
  const scale = texWidth / W;
  const [cv, g] = canvas(W, H, scale);
  let pages = {};
  let lastKey = '';
  const paintAll = () => {
    pages = {
      portal: paintPortal(scale),
      search: paintSearch(scale),
      results: paintResults(scale, '오늘의 날씨', ['오늘의 날씨: 맑고 일교차 커요', '주간 날씨 전망', '미세먼지와 자외선 지수', '지역별 날씨 한눈에'], 1),
      results2: paintResults(scale, '오늘의 날씨', ['가을 옷차림 추천', '이번 주말 나들이 날씨', '비 소식은 언제쯤', '날씨 앱 비교'], 2),
      newtab: paintNewTab(scale),
      google: paintGoogle(scale),
      gresults: paintGoogleResults(scale),
    };
    lastKey = '';
  };
  paintAll();

  function drawPage(name, alpha, scroll) {
    if (!pages[name] || alpha <= 0) return;
    g.globalAlpha = alpha;
    const pic = pages[name];
    g.save();
    g.beginPath(); g.rect(0, CHROME, W, H - CHROME); g.clip();
    g.drawImage(pic, 0, CHROME - scroll, W, pic.height / scale);
    g.restore();
    g.globalAlpha = 1;
  }

  function drawChrome(s) {
    g.fillStyle = C.tabs; g.fillRect(0, 0, W, 48);
    g.fillStyle = C.bar; g.fillRect(0, 48, W, 56);
    ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
      g.beginPath(); g.arc(28 + i * 26, 25, 7.5, 0, 7); g.fillStyle = col; g.fill();
    });
    s.tabs.forEach((title, i) => {
      const x = 118 + i * 256;
      if (i === s.activeTab) {
        rr(g, x, 8, 248, 40, [12, 12, 0, 0]); g.fillStyle = C.bar; g.fill();
      }
      text(g, title, x + 20, 28, 18, i === s.activeTab ? C.text : C.muted);
    });
    text(g, '←', 34, 76, 24, C.muted); text(g, '→', 74, 76, 24, C.muted);
    rr(g, 120, 56, 1200, 40, 20); g.fillStyle = C.tabs; g.fill();
    text(g, s.url, 146, 76, 19, C.text);
    // The one extension badge in the toolbar; lit while Nungil is on.
    g.beginPath(); g.arc(1540, 76, 15, 0, 7); g.fillStyle = C.blue; g.fill();
    g.beginPath(); g.arc(1540, 76, 5, 0, 7); g.fillStyle = '#fff'; g.fill();
  }

  function drawHighlight(h) {
    const pad = 8, { x, y, w, h: rh } = h;
    g.save();
    g.globalAlpha = h.a;
    rr(g, x - pad, y - pad, w + pad * 2, rh + pad * 2, h.r ?? 32);
    g.fillStyle = `rgba(47,123,255,${0.14 + h.press * 0.5})`; g.fill();
    g.shadowColor = C.blue; g.shadowBlur = 44;
    g.strokeStyle = C.blue; g.lineWidth = 7; g.stroke();
    g.shadowBlur = 0;
    g.strokeStyle = 'rgba(127,190,255,.4)'; g.lineWidth = 1;
    rr(g, x - pad - 11, y - pad - 11, w + pad * 2 + 22, rh + pad * 2 + 22, (h.r ?? 32) + 11); g.stroke();
    if (h.ring > 0) {
      const cx = x + w / 2, cy = y + rh / 2;
      g.lineCap = 'round';
      g.beginPath(); g.arc(cx, cy, 44, 0, 7); g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 9; g.stroke();
      g.beginPath(); g.arc(cx, cy, 44, -Math.PI / 2, -Math.PI / 2 + h.ring * Math.PI * 2);
      g.strokeStyle = C.cyan; g.stroke();
    }
    g.restore();
  }

  function draw(s) {
    const key = JSON.stringify(s);
    if (key === lastKey) return false;
    lastKey = key;
    g.fillStyle = C.page; g.fillRect(0, 0, W, H);
    drawPage(s.page, 1, s.scroll || 0);
    if (s.next) drawPage(s.next, s.mix, 0);
    if (s.typed != null) {
      const b = RECTS.gBox, focused = s.page === 'google' && !s.next;
      if (focused || s.mix < 1) {
        g.globalAlpha = s.next ? 1 - s.mix : 1;
        text(g, s.typed, b.x + 44, b.y + b.h / 2 + 1, 30, '#f2f4f8');
        g.globalAlpha = 1;
      }
    }
    drawChrome(s);
    if (s.hl && s.hl.a > 0) drawHighlight(s.hl);
    if (s.toast) {
      g.font = `600 26px ${FONT}`;
      const tw = g.measureText(s.toast).width + 64;
      g.globalAlpha = s.toastA;
      rr(g, W / 2 - tw / 2, H - 92, tw, 60, 30); g.fillStyle = 'rgba(16,26,52,.92)'; g.fill();
      text(g, s.toast, W / 2, H - 61, 26, C.text, 600, 'center');
      g.globalAlpha = 1;
    }
    return true;
  }

  return { canvas: cv, draw, repaint: paintAll };
}

// The AI panel: the request, then the plan it made, ticking off as the browser runs it.
export const PANEL_W = 720;
export const PANEL_H = 860;
export const PANEL_STEP_Y = (i) => 372 + i * 86;
const STEPS = ['Google 검색 페이지 접속', '검색창 인식', "'해커톤' 입력", '검색 실행', '검색 결과 표시'];

export function createPanel(texWidth) {
  const scale = texWidth / PANEL_W;
  const [cv, g] = canvas(PANEL_W, PANEL_H, scale);
  let lastKey = '';

  function draw(s) {
    const key = JSON.stringify(s);
    if (key === lastKey) return false;
    lastKey = key;
    g.clearRect(0, 0, PANEL_W, PANEL_H);
    rr(g, 4, 4, PANEL_W - 8, PANEL_H - 8, 48);
    const fill = g.createLinearGradient(0, 0, PANEL_W, PANEL_H);
    fill.addColorStop(0, 'rgba(30,50,100,.86)'); fill.addColorStop(1, 'rgba(10,18,42,.9)');
    g.fillStyle = fill; g.fill();
    const edge = g.createLinearGradient(0, 0, PANEL_W, PANEL_H);
    edge.addColorStop(0, 'rgba(190,225,255,.75)'); edge.addColorStop(.5, 'rgba(90,150,255,.25)'); edge.addColorStop(1, 'rgba(127,231,255,.5)');
    g.strokeStyle = edge; g.lineWidth = 3; g.stroke();

    text(g, '눈길 AI', 124, 74, 32, C.text, 700);
    text(g, s.status, PANEL_W - 44, 74, 24, C.cyan, 500, 'right');

    rr(g, 40, 132, PANEL_W - 80, 124, 28); g.fillStyle = 'rgba(47,123,255,.2)'; g.fill();
    text(g, '말한 내용', 72, 166, 20, C.muted);
    text(g, s.typed + (s.caret ? '|' : ''), 72, 212, 30, C.text, 600);

    STEPS.forEach((label, i) => {
      const y = PANEL_STEP_Y(i), st = s.steps[i] ?? 0; // 0 hidden, 1 planned, 2 running, 3 done
      if (!st) return;
      g.globalAlpha = s.stepA[i] ?? 1;
      if (i < STEPS.length - 1 && st && s.steps[i + 1]) {
        g.fillStyle = st === 3 ? 'rgba(127,231,255,.55)' : 'rgba(150,190,255,.25)';
        g.fillRect(70, y + 24, 3, 38);
      }
      g.beginPath(); g.arc(71, y, 19, 0, 7);
      g.fillStyle = st === 3 ? C.cyan : st === 2 ? C.blue : 'rgba(150,190,255,.14)'; g.fill();
      if (st === 3) {
        g.beginPath(); g.moveTo(62, y); g.lineTo(69, y + 8); g.lineTo(81, y - 7);
        g.strokeStyle = '#06122a'; g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke();
      } else {
        text(g, String(i + 1), 71, y + 1, 19, st === 2 ? '#fff' : C.muted, 600, 'center');
      }
      text(g, label, 112, y + 1, 29, st === 1 ? C.muted : C.text, st === 2 ? 700 : 500);
      g.globalAlpha = 1;
    });
    return true;
  }
  return { canvas: cv, draw };
}

// The last frame: one browser window that carries all three inputs in its toolbar.
export function paintUnified(texWidth) {
  const w = 1200, h = 720, scale = texWidth / w;
  const [c, g] = canvas(w, h, scale);
  rr(g, 4, 4, w - 8, h - 8, 44);
  const fill = g.createLinearGradient(0, 0, w, h);
  fill.addColorStop(0, 'rgba(34,58,116,.72)'); fill.addColorStop(1, 'rgba(8,16,38,.82)');
  g.fillStyle = fill; g.fill();
  const edge = g.createLinearGradient(0, 0, w, h);
  edge.addColorStop(0, 'rgba(200,230,255,.8)'); edge.addColorStop(.55, 'rgba(70,130,255,.25)'); edge.addColorStop(1, 'rgba(127,231,255,.6)');
  g.strokeStyle = edge; g.lineWidth = 3; g.stroke();
  ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
    g.beginPath(); g.arc(46 + i * 30, 50, 9, 0, 7); g.fillStyle = col; g.fill();
  });
  rr(g, 170, 26, 560, 48, 24); g.fillStyle = 'rgba(4,10,28,.55)'; g.fill();
  text(g, '어디든, 원하는 곳으로', 200, 51, 22, C.muted);
  g.fillStyle = 'rgba(150,190,255,.14)'; g.fillRect(4, 100, w - 8, 2);
  // Page body: the highlight the whole film has been about.
  [0, 1, 2].forEach((i) => {
    const x = 60 + i * 368;
    rr(g, x, 150, 344, 220, 24); g.fillStyle = 'rgba(150,190,255,.12)'; g.fill();
    if (i === 1) {
      g.save(); g.shadowColor = C.blue; g.shadowBlur = 34;
      rr(g, x - 6, 144, 356, 232, 28); g.strokeStyle = C.blue; g.lineWidth = 6; g.stroke();
      g.restore();
    }
  });
  bars(g, 60, 420, 760, 'rgba(150,190,255,.18)', 20);
  bars(g, 60, 462, 560, 'rgba(150,190,255,.12)', 20);
  bars(g, 60, 504, 660, 'rgba(150,190,255,.12)', 20);
  return c;
}
