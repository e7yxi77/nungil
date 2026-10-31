const test = require('node:test');
const assert = require('node:assert');
require('../extension/lib/gaze-model.js');
require('../extension/lib/commands.js');
require('../extension/lib/sound.js');
require('../extension/lib/codex.js');
const { fit, predict, crossValidate, pickTarget, createFilter, extractFeatures, createHoldGesture } = globalThis.GazeModel;
const { parseCommand } = globalThis.Commands;

// Deterministic noise so a failure is reproducible.
function rng(seed) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
}

// Synthetic user: iris offset maps linearly to the screen, head nearly still.
function makeSamples({ seed = 1, noise = 0.002 } = {}) {
  const r = rng(seed);
  const samples = [];
  let point = 0;
  for (const y of [100, 540, 980]) {
    for (const x of [150, 960, 1770]) {
      for (let i = 0; i < 20; i++) {
        samples.push({
          point, x, y,
          f: [
            (x - 960) / 960 * 0.06 + r() * noise,
            (y - 540) / 540 * 0.03 + r() * noise,
            0.01 + r() * 0.01, 0.02 + r() * 0.01,
            r() * 0.2, r() * 0.2, -50 + r() * 0.2,
          ],
        });
      }
      point++;
    }
  }
  return samples;
}

test('fit recovers screen position from iris features', () => {
  const samples = makeSamples();
  const { model } = fit(samples);
  const p = predict(model, [0.03, 0.015, 0.01, 0.02, 0, 0, -50]);
  assert.ok(Math.abs(p.x - 1440) < 60, `x=${p.x}`);
  assert.ok(Math.abs(p.y - 810) < 60, `y=${p.y}`);
});

test('cross-validated error is low on clean data and rises with noise', () => {
  const clean = crossValidate(makeSamples({ noise: 0.001 }));
  const noisy = crossValidate(makeSamples({ noise: 0.03 }));
  assert.ok(clean < 150, `clean=${clean}`);
  assert.ok(noisy > clean, `noisy=${noisy} clean=${clean}`);
});

test('pickTarget prefers containing rect, smallest when nested, and respects radius', () => {
  const big = { left: 0, top: 0, right: 500, bottom: 500 };
  const small = { left: 100, top: 100, right: 150, bottom: 150 };
  const far = { left: 900, top: 900, right: 950, bottom: 950 };
  assert.strictEqual(pickTarget([big, small, far], { x: 120, y: 120 }, 100), 1);
  assert.strictEqual(pickTarget([small, far], { x: 200, y: 125 }, 100), 0);
  assert.strictEqual(pickTarget([small, far], { x: 500, y: 500 }, 100), -1);
});

test('filter damps jitter but follows a real jump', () => {
  const f = createFilter();
  const r = rng(7);
  let out;
  for (let t = 0; t < 2000; t += 66) out = f(500 + r() * 100, 500 + r() * 100, t);
  assert.ok(Math.abs(out.x - 500) < 40, `jitter x=${out.x}`);
  for (let t = 2000; t < 3000; t += 66) out = f(1500, 500, t);
  assert.ok(out.x > 1350, `jump x=${out.x}`);
});

test('extractFeatures: iris moving right raises ex in both eyes, closed eyes flag a blink', () => {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const eye = (l, r, t, b, iris, cx, irisDx, open) => {
    lm[l] = { x: cx - 0.05, y: 0.5 };
    lm[r] = { x: cx + 0.05, y: 0.5 };
    lm[t] = { x: cx, y: 0.5 - open / 2 };
    lm[b] = { x: cx, y: 0.5 + open / 2 };
    for (let i = 0; i < 5; i++) lm[iris + i] = { x: cx + irisDx, y: 0.5 };
  };
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -50, 1];
  const build = (irisDx, open) => {
    eye(33, 133, 159, 145, 468, 0.4, irisDx, open);
    eye(362, 263, 386, 374, 473, 0.6, irisDx, open);
    return extractFeatures(lm, matrix, 1);
  };
  const center = build(0, 0.03);
  const right = build(0.01, 0.03);
  assert.strictEqual(center.blink, false);
  assert.ok(right.features[0] > center.features[0] + 0.05);
  assert.strictEqual(build(0, 0.005).blink, true);
});

function fakeJwt(claims) {
  return `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
}
const ACCESS = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' }, name: '한글' });

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

function sseResponse(chunks, init = { status: 200 }) {
  const body = new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });
  return new Response(body, init);
}

test('PKCE challenge is the base64url SHA-256 of the verifier', async () => {
  const { createPkce } = globalThis.Codex;
  const { verifier, challenge } = await createPkce();
  const expected = require('node:crypto').createHash('sha256').update(verifier).digest('base64url');
  assert.strictEqual(challenge, expected);
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
});

test('authorize URL carries the PKCE challenge, state and redirect', () => {
  const { buildAuthorizeUrl, OAUTH } = globalThis.Codex;
  const url = new URL(buildAuthorizeUrl({ challenge: 'CH', state: 'ST' }));
  assert.strictEqual(url.origin, 'https://auth.openai.com');
  assert.strictEqual(url.searchParams.get('code_challenge'), 'CH');
  assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(url.searchParams.get('state'), 'ST');
  assert.strictEqual(url.searchParams.get('redirect_uri'), OAUTH.redirectUri);
});

test('callback: wrong state never yields a code', () => {
  const { parseCallback } = globalThis.Codex;
  const base = 'http://localhost:1455/auth/callback';
  assert.deepStrictEqual(parseCallback(`${base}?code=C&state=S`, 'S'), { code: 'C' });
  assert.deepStrictEqual(parseCallback(`${base}?code=C&state=EVIL`, 'S'), { error: 'state_mismatch' });
  assert.deepStrictEqual(parseCallback(`${base}?state=S`, 'S'), { error: 'no_code' });
  assert.deepStrictEqual(parseCallback(`${base}?error=access_denied&state=S`, 'S'), { error: 'access_denied' });
});

test('token exchange returns the account id, and rejects an incomplete response', async () => {
  const { exchangeCode } = globalThis.Codex;
  let sent;
  await withFetch(async (url, init) => {
    sent = init.body;
    return Response.json({ access_token: ACCESS, refresh_token: 'R', expires_in: 3600 });
  }, async () => {
    const auth = await exchangeCode('CODE', 'VERIFIER');
    assert.strictEqual(auth.accountId, 'acct_1');
    assert.strictEqual(auth.refresh, 'R');
    assert.ok(auth.expires > Date.now());
  });
  assert.strictEqual(sent.get('code_verifier'), 'VERIFIER');
  assert.strictEqual(sent.get('grant_type'), 'authorization_code');
  await withFetch(async () => Response.json({ access_token: ACCESS }), async () => {
    await assert.rejects(exchangeCode('C', 'V'), /token_response_incomplete/);
  });
});

test('token refresh keeps the old refresh token and account when omitted', async () => {
  const { refreshTokens } = globalThis.Codex;
  await withFetch(async () => Response.json({ access_token: 'not-a-jwt', expires_in: 60 }), async () => {
    const fresh = await refreshTokens({ refresh: 'OLD', accountId: 'acct_1' });
    assert.strictEqual(fresh.refresh, 'OLD');
    assert.strictEqual(fresh.accountId, 'acct_1');
  });
});

test('response stream yields deltas across split chunks and sends auth headers', async () => {
  const { streamResponse } = globalThis.Codex;
  let headers;
  const event = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const full = event({ type: 'response.output_text.delta', delta: '안녕' }) + event({ type: 'response.created' }) + event({ type: 'response.output_text.delta', delta: '하세요' });
  await withFetch(async (url, init) => {
    headers = init.headers;
    return sseResponse([full.slice(0, 20), full.slice(20)]);
  }, async () => {
    const out = [];
    for await (const d of streamResponse({ auth: { access: 'A', accountId: 'acct_1' }, instructions: 'i', text: 't' })) out.push(d);
    assert.strictEqual(out.join(''), '안녕하세요');
  });
  assert.strictEqual(headers.Authorization, 'Bearer A');
  assert.strictEqual(headers['chatgpt-account-id'], 'acct_1');
});

test('response stream surfaces OpenAI failures and HTTP errors', async () => {
  const { streamResponse } = globalThis.Codex;
  const run = async () => {
    for await (const _ of streamResponse({ auth: { access: 'A', accountId: 'x' }, instructions: 'i', text: 't' })) { /* drain */ }
  };
  await withFetch(async () => sseResponse([`data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'quota' } } })}\n\n`]), async () => {
    await assert.rejects(run, /quota/);
  });
  await withFetch(async () => new Response('nope', { status: 401 }), async () => {
    await assert.rejects(run, /http_401/);
  });
});

test('free-form requests need an action verb, and say whether to press', () => {
  assert.deepStrictEqual(parseCommand('로그인 버튼 눌러줘'), { name: 'find', query: '로그인 버튼', text: '로그인 버튼 눌러줘', click: true });
  assert.deepStrictEqual(parseCommand('날씨 링크 열어 주세요.'), { name: 'find', query: '날씨 링크', text: '날씨 링크 열어 주세요', click: true });
  assert.deepStrictEqual(parseCommand('뉴스 찾아줘'), { name: 'find', query: '뉴스', text: '뉴스 찾아줘', click: false });
  assert.deepStrictEqual(parseCommand('click the login button'), { name: 'find', query: 'the login button', text: 'click the login button', click: true });
  assert.deepStrictEqual(parseCommand('find news'), { name: 'find', query: 'news', text: 'find news', click: false });
});

test('free-form parsing leaves exact commands, numbers and conversation alone', () => {
  assert.strictEqual(parseCommand('이거 눌러줘').name, 'click');
  assert.deepStrictEqual(parseCommand('3번 눌러줘'), { name: 'number', n: 3 });
  assert.deepStrictEqual(parseCommand('click 5'), { name: 'number', n: 5 });
  assert.strictEqual(parseCommand('클릭해줘').name, 'click');
  for (const s of ['오늘 점심 뭐 먹을까', '이거 클릭하면 어떻게 되는 거야', '그 버튼 눌렀어', 'i will click later on']) {
    const parsed = parseCommand(s);
    assert.ok(parsed === null || s.startsWith('i will') ? parsed === null : false, `${s} -> ${JSON.stringify(parsed)}`);
  }
});

test('a spoken task goes to the agent, and short or casual speech does not', () => {
  assert.deepStrictEqual(parseCommand('지메일 들어가서 메일 작성해줘'), { name: 'agent', goal: '지메일 들어가서 메일 작성해줘' });
  assert.strictEqual(parseCommand('유튜브에서 고양이 영상 틀어 주세요.').name, 'agent');
  assert.strictEqual(parseCommand('go to gmail and write an email').name, 'agent');
  for (const s of ['물 좀 줘', '오늘 점심 뭐 먹을까', '그거 어떻게 했어', '아까 메일 작성했어']) assert.strictEqual(parseCommand(s), null, s);
  assert.strictEqual(parseCommand('아래로 스크롤해줘').name, 'down');
  assert.strictEqual(parseCommand('요약해줘').name, 'summarize');
});

test('agent replies are validated, so a bad one can never drive the browser', () => {
  const { parseAgentAction: p } = globalThis.Codex;
  assert.deepStrictEqual(p('{"action":"click","index":2,"say":"눌러요"}', 5), { action: 'click', index: 2, say: '눌러요' });
  assert.deepStrictEqual(p('```json\n{"action":"navigate","url":"https://mail.google.com"}\n```', 0), { action: 'navigate', url: 'https://mail.google.com', say: '' });
  assert.strictEqual(p('{"action":"navigate","url":"javascript:alert(1)"}', 5), null);
  assert.strictEqual(p('{"action":"navigate","url":"chrome://settings"}', 5), null);
  assert.strictEqual(p('{"action":"navigate","url":"file:///etc/passwd"}', 5), null);
  assert.strictEqual(p('{"action":"click","index":9}', 5), null);
  assert.strictEqual(p('{"action":"click","index":"1"}', 5), null);
  assert.strictEqual(p('{"action":"type","index":1}', 5), null);
  assert.strictEqual(p('{"action":"eval","code":"x"}', 5), null);
  assert.strictEqual(p('no json here', 5), null);
  assert.strictEqual(p('{"action":"done","say":"끝"}', 0).action, 'done');
});

test('parseMatches keeps only real indexes from the model reply', () => {
  const { parseMatches } = globalThis.Codex;
  assert.deepStrictEqual(parseMatches('{"matches":[2,0]}', 3), [2, 0]);
  assert.deepStrictEqual(parseMatches('```json\n{"matches":[1]}\n```', 3), [1]);
  assert.deepStrictEqual(parseMatches('{"matches":[1,1,99,-1,"2",0.5]}', 3), [1]);
  assert.deepStrictEqual(parseMatches('{"matches":[]}', 3), []);
  assert.deepStrictEqual(parseMatches('sorry, no idea', 3), []);
  assert.deepStrictEqual(parseMatches('{"matches":"all"}', 3), []);
  assert.strictEqual(parseMatches(JSON.stringify({ matches: [...Array(20).keys()] }), 20).length, 9);
});

test('a refused model moves to the next one and reports the one that worked', async () => {
  const { streamWithFallback, MODELS } = globalThis.Codex;
  const tried = [];
  await withFetch(async (url, init) => {
    const { model } = JSON.parse(init.body);
    tried.push(model);
    if (model !== MODELS[1]) return Response.json({ detail: `The '${model}' model is not supported` }, { status: 400 });
    return sseResponse([`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`]);
  }, async () => {
    let used = null;
    let out = '';
    for await (const d of streamWithFallback({ auth: { access: 'A', accountId: 'x' }, instructions: 'i', text: 't', preferred: 'retired-model', onModel: (m) => { used = m; } })) out += d;
    assert.strictEqual(out, 'ok');
    assert.strictEqual(used, MODELS[1]);
  });
  assert.deepStrictEqual(tried, ['retired-model', MODELS[0], MODELS[1]]);
});

test('sign-in and server failures stop at once, with the server\'s reason', async () => {
  const { streamWithFallback } = globalThis.Codex;
  const run = async () => {
    for await (const _ of streamWithFallback({ auth: { access: 'A', accountId: 'x' }, instructions: 'i', text: 't' })) { /* drain */ }
  };
  let calls = 0;
  await withFetch(async () => { calls++; return Response.json({ detail: 'token expired' }, { status: 401 }); }, async () => {
    await assert.rejects(run, /http_401: token expired/);
  });
  assert.strictEqual(calls, 1);
  calls = 0;
  await withFetch(async () => { calls++; return Response.json({ detail: 'no such model' }, { status: 400 }); }, async () => {
    await assert.rejects(run, /http_400: no such model/);
  });
  assert.strictEqual(calls, globalThis.Codex.MODELS.length, 'every model tried before giving up');
});

test('parseCommand understands summarize', () => {
  for (const s of ['요약', '요약해줘', '요약 해 주세요', 'summarize']) assert.strictEqual(parseCommand(s)?.name, 'summarize', s);
});

// A person in camera space. Screen is 40px per cm with the webcam at top centre,
// looking back at them, so screen-right is camera-left and screen-down is camera-down.
function physicalFrame(px, py, { x = 0, y = -20, distance = 50, headShare = 0, r = () => 0 } = {}) {
  const wantX = Math.atan((-(px - 960) / 40 - x) / distance);
  const wantY = Math.atan((-py / 40 - y) / distance);
  const yaw = wantX * headShare;
  const headY = wantY * headShare;
  const eyeGain = 0.4; // iris offset per radian of eye rotation
  return [
    Math.sin(wantX - yaw) * eyeGain + r() * 0.002,
    Math.sin(wantY - headY) * eyeGain + r() * 0.002,
    yaw + r() * 0.005,
    -Math.atan(Math.tan(headY) * Math.cos(yaw)) + r() * 0.005,
    x + r() * 0.2, y + r() * 0.2, -distance + r() * 0.2,
  ];
}

function physicalCalibration(seed = 21) {
  const r = rng(seed);
  const samples = [];
  let point = 0;
  const add = (px, py, headShare) => {
    for (let i = 0; i < 25; i++) samples.push({ point, x: px, y: py, f: physicalFrame(px, py, { headShare, r }) });
    point++;
  };
  for (const py of [100, 540, 980]) for (const px of [150, 960, 1770]) add(px, py, 0);
  for (const [px, py] of [[960, 540], [500, 300], [1420, 300], [1420, 780], [500, 780]]) add(px, py, 0);
  return samples;
}

// Replays a head motion at 25fps. path(ms) gives [yaw, pitch] offsets from rest.
function replayHead(path, durationMs, { noise = 0.004, seed = 41 } = {}) {
  const { createHeadFlick } = globalThis.GazeModel;
  const detect = createHeadFlick();
  const r = rng(seed);
  const fired = [];
  for (let t = 0; t < 1500 + durationMs + 1500; t += 40) {
    const [y, p] = t < 1500 ? [0, 0] : path(t - 1500);
    const { flick } = detect(0.1 + y + r() * noise, -0.05 + p + r() * noise, 10000 + t);
    if (flick) fired.push(flick);
  }
  return fired;
}
// A flick shape: out in outMs, straight back in backMs.
const flickPath = (y, p, outMs = 120, backMs = 160) => (t) => {
  const k = t < outMs ? t / outMs : t < outMs + backMs ? 1 - (t - outMs) / backMs : 0;
  return [y * k, p * k];
};

test('head flick: a quick nod in each of the four directions fires exactly once', () => {
  for (let seed = 1; seed < 12; seed++) {
    assert.deepStrictEqual(replayHead(flickPath(0.13, 0), 400, { seed }), ['yaw+'], `right, seed ${seed}`);
    assert.deepStrictEqual(replayHead(flickPath(-0.13, 0), 400, { seed }), ['yaw-'], `left, seed ${seed}`);
    assert.deepStrictEqual(replayHead(flickPath(0, 0.1), 400, { seed }), ['pitch+'], `pitch up, seed ${seed}`);
    assert.deepStrictEqual(replayHead(flickPath(0, -0.1), 400, { seed }), ['pitch-'], `pitch down, seed ${seed}`);
  }
});

test('head flick: looking around, turning and staying, and tremor fire nothing', () => {
  for (let seed = 1; seed < 12; seed++) {
    const slow = (t) => [0.25 * Math.min(1, t / 1500), 0];
    assert.deepStrictEqual(replayHead(slow, 3000, { seed }), [], `slow turn, seed ${seed}`);
    const stay = (t) => [0.2 * Math.min(1, t / 120), 0];
    assert.deepStrictEqual(replayHead(stay, 3000, { seed }), [], `quick turn that stays, seed ${seed}`);
    const slowThere = (t) => [0.2 * Math.sin(Math.PI * Math.min(1, t / 2000)), 0];
    assert.deepStrictEqual(replayHead(slowThere, 2500, { seed }), [], `slow there and back, seed ${seed}`);
    const nodSmall = flickPath(0.025, 0.012);
    assert.deepStrictEqual(replayHead(nodSmall, 400, { seed }), [], `small movement, seed ${seed}`);
    assert.deepStrictEqual(replayHead(() => [0, 0], 4000, { seed, noise: 0.03 }), [], `noisy still head, seed ${seed}`);
  }
});

test('head flick: a diagonal is ambiguous and fires nothing', () => {
  assert.deepStrictEqual(replayHead(flickPath(0.1, 0.08), 400), []);
});

test('head flick: two flicks in a row both count, once the cooldown has passed', () => {
  const path = (t) => (t < 400 ? flickPath(0.13, 0)(t) : t > 1500 ? flickPath(-0.13, 0)(t - 1500) : [0, 0]);
  assert.deepStrictEqual(replayHead(path, 2200), ['yaw+', 'yaw-']);
});

test('neighbourIn prefers the same row or column, and respects direction', () => {
  const { neighbourIn } = globalThis.GazeModel;
  const box = (x, y) => ({ left: x, right: x + 80, top: y, bottom: y + 40 });
  const grid = [box(100, 100), box(300, 100), box(500, 100), box(100, 300), box(300, 300), box(320, 150)];
  assert.strictEqual(neighbourIn('right', grid[0], grid), 1, 'same row beats closer but lower');
  assert.strictEqual(neighbourIn('left', grid[1], grid), 0);
  assert.strictEqual(neighbourIn('down', grid[1], grid), 5);
  assert.strictEqual(neighbourIn('up', grid[4], grid), 5);
  assert.strictEqual(neighbourIn('left', grid[0], grid), -1, 'nothing that way');
  assert.strictEqual(neighbourIn('up', grid[0], grid), -1);
  assert.strictEqual(neighbourIn('right', grid[2], grid), -1);
});

test('the cursor learns from the eyes only: the head can never move it', () => {
  const r = rng(77);
  const samples = physicalCalibration(77).map((s) => ({ ...s, f: s.f.map((v) => v + r() * 0.002) }));
  const { model } = fit(samples);
  assert.strictEqual(model.wx[1], 0);
  assert.strictEqual(model.wx[2], 0);
  assert.strictEqual(model.wy[1], 0);
  assert.strictEqual(model.wy[2], 0);
  const eyes = samples[0].f.slice(0, 2);
  const a = predict(model, [...eyes, 0, 0, 0, -20, -50]);
  const b = predict(model, [...eyes, 0.3, 0.2, 8, -10, -50]);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.001, 'turning or shifting the head changes nothing');
});

test('the eye-look signal rescues vertical gaze when the iris position is nearly useless', () => {
  const r = rng(91);
  const makeSamples = (useLook) => physicalCalibration(91).map((s) => {
    const trueY = s.f[1];
    const f = [...s.f];
    f[1] = trueY * 0.15 + r() * 0.02; // eyelids hide most of the vertical movement
    if (useLook) { f[7] = r() * 0.02; f[8] = trueY * 1.5 + r() * 0.03; }
    return { ...s, f };
  });
  const plain = crossValidate(makeSamples(false), undefined, globalThis.GazeModel.errorY);
  const withLook = crossValidate(makeSamples(true), undefined, globalThis.GazeModel.errorY);
  assert.ok(withLook < plain * 0.7, `vertical error ${Math.round(plain)}px without, ${Math.round(withLook)}px with`);
});

test('extractFeatures adds eye-look signals, signed so opposite directions are opposite', () => {
  const lm = Array.from({ length: 478 }, (_, i) => ({ x: 0.3 + (i % 7) * 0.05, y: 0.4 + (i % 5) * 0.05 }));
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -50, 1];
  const shapes = (entries) => Object.entries(entries).map(([categoryName, score]) => ({ categoryName, score }));
  const up = extractFeatures(lm, matrix, 1, shapes({ eyeLookUpLeft: 0.6, eyeLookUpRight: 0.6 })).features;
  const down = extractFeatures(lm, matrix, 1, shapes({ eyeLookDownLeft: 0.6, eyeLookDownRight: 0.6 })).features;
  assert.ok(Math.abs(up[8] - 0.6) < 1e-9 && Math.abs(down[8] + 0.6) < 1e-9, `${up[8]} ${down[8]}`);
  const one = extractFeatures(lm, matrix, 1, shapes({ eyeLookOutLeft: 0.4, eyeLookInRight: 0.4 })).features;
  const other = extractFeatures(lm, matrix, 1, shapes({ eyeLookInLeft: 0.4, eyeLookOutRight: 0.4 })).features;
  assert.ok(one[7] > 0 && other[7] < 0);
  assert.strictEqual(extractFeatures(lm, matrix, 1).features.length, 9, 'still works without them');
});

test('hold gesture fires once per hold and re-arms after release', () => {
  const hold = createHoldGesture(300);
  const run = (active, from, to) => {
    let count = 0;
    for (let t = from; t < to; t += 66) if (hold(active, t)) count++;
    return count;
  };
  assert.strictEqual(run(true, 1000, 1200), 0, 'too short');
  assert.strictEqual(run(false, 1200, 1400), 0);
  assert.strictEqual(run(true, 1400, 2500), 1, 'one fire per hold');
  assert.strictEqual(run(false, 2500, 2600), 0);
  assert.strictEqual(run(true, 2600, 3200), 1, 're-armed');
});

test('hold gesture with repeatMs keeps firing while held', () => {
  const hold = createHoldGesture(900, { repeatMs: 1000 });
  let count = 0;
  for (let t = 1000; t < 4100; t += 50) if (hold(true, t)) count++;
  assert.strictEqual(count, 3);
});

test('an open mouth is detected from landmarks', () => {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const eye = (l, r, t, b, iris, cx, open) => {
    lm[l] = { x: cx - 0.05, y: 0.5 };
    lm[r] = { x: cx + 0.05, y: 0.5 };
    lm[t] = { x: cx, y: 0.5 - open / 2 };
    lm[b] = { x: cx, y: 0.5 + open / 2 };
    lm[iris] = { x: cx, y: 0.5 };
  };
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -50, 1];
  const build = (subjectRight, subjectLeft, mouthGap) => {
    eye(33, 133, 159, 145, 468, 0.4, subjectRight);
    eye(362, 263, 386, 374, 473, 0.6, subjectLeft);
    lm[78] = { x: 0.45, y: 0.7 };
    lm[308] = { x: 0.55, y: 0.7 };
    lm[13] = { x: 0.5, y: 0.7 - mouthGap / 2 };
    lm[14] = { x: 0.5, y: 0.7 + mouthGap / 2 };
    return extractFeatures(lm, matrix, 1);
  };
  assert.strictEqual(build(0.03, 0.03, 0).mouthOpen, false);
  assert.strictEqual(build(0.03, 0.03, 0.06).mouthOpen, true);
});

test('sound detector: a short burst is a pop, a sustained tone is a repeating hum', () => {
  const { createSoundDetector } = globalThis.NungilSound;
  const run = (levels) => {
    const detect = createSoundDetector();
    const fired = [];
    levels.forEach((level, i) => {
      const s = detect(level, 1000 + i * 50);
      if (s) fired.push(s);
    });
    return fired;
  };
  const quiet = (n) => Array(n).fill(0.002);
  const loud = (n) => Array(n).fill(0.2);
  assert.deepStrictEqual(run([...quiet(20), ...quiet(20)]), []);
  assert.deepStrictEqual(run([...quiet(20), ...loud(3), ...quiet(10)]), ['pop']);
  assert.deepStrictEqual(run([...quiet(20), ...loud(8), ...quiet(10)]), [], 'mid-length sound like a word is neither');
  assert.deepStrictEqual(run([...quiet(20), ...loud(14), ...quiet(10)]), ['hum']);
  assert.deepStrictEqual(run([...quiet(20), ...loud(60), ...quiet(10)]), ['hum', 'hum', 'hum']);
});

test('parseCommand understands "click 5" in every word order', () => {
  for (const s of ['클릭 5', '5번 클릭', '삼번 클릭해줘', 'click 5', '5 click']) {
    assert.strictEqual(parseCommand(s)?.name, 'number', s);
  }
  assert.strictEqual(parseCommand('클릭 5').n, 5);
  assert.strictEqual(parseCommand('삼번 클릭해줘').n, 3);
  assert.strictEqual(parseCommand('click').name, 'click');
});

test('parseCommand understands reader commands', () => {
  assert.strictEqual(parseCommand('읽어줘').name, 'read');
  assert.strictEqual(parseCommand('단순 보기').name, 'simplify');
  assert.strictEqual(parseCommand('그만').name, 'hide');
});

test('parseCommand understands Korean and English phrases', () => {
  const cases = {
    '클릭': 'click', '클릭해줘': 'click', 'Click.': 'click',
    '아래로 스크롤': 'down', '위로': 'up', '뒤로 가기': 'back',
    '새로고침': 'reload', '번호 표시': 'numbers', '멈춰': 'pause', '다시 시작': 'resume',
    'scroll down': 'down', 'go back': 'back',
  };
  for (const [input, name] of Object.entries(cases)) {
    assert.strictEqual(parseCommand(input)?.name, name, input);
  }
});

test('parseCommand reads numbers in every form speech recognition returns', () => {
  const cases = { '3': 3, '3번': 3, '삼번': 3, '세 번': 3, '셋': 3, 'three': 3, '12번': 12, '이십': 20, '열': 10 };
  for (const [input, n] of Object.entries(cases)) {
    assert.deepStrictEqual(parseCommand(input), { name: 'number', n }, input);
  }
});

test('parseCommand extracts dictation text and keeps its spacing', () => {
  assert.deepStrictEqual(parseCommand('입력 안녕하세요 반갑습니다'), { name: 'type', text: '안녕하세요 반갑습니다' });
  assert.deepStrictEqual(parseCommand('type hello world'), { name: 'type', text: 'hello world' });
});

test('parseCommand ignores ordinary conversation', () => {
  for (const s of ['오늘 점심 뭐 먹을까', '이거 클릭하면 어떻게 되는 거야', 'please go down the road']) {
    assert.strictEqual(parseCommand(s), null, s);
  }
});

test('a flick maps to the side the user actually moved toward', () => {
  const { flickDirection } = globalThis.GazeModel;
  assert.strictEqual(flickDirection('yaw-'), 'right', "the user's right is the camera's left");
  assert.strictEqual(flickDirection('yaw+'), 'left');
  assert.strictEqual(flickDirection('pitch+'), 'down');
  assert.strictEqual(flickDirection('pitch-'), 'up');
});

test('head assist keeps gaze accurate when the seat shifts or the head turns', () => {
  const { createHeadAssist } = globalThis.GazeModel;
  const { model } = fit(physicalCalibration(55));
  const POINTS = [[300, 200], [960, 540], [1600, 300], [500, 850], [1500, 900]];
  const errorAt = (position, assisted) => POINTS.reduce((sum, [px, py]) => {
    const f = physicalFrame(px, py, position);
    const p = predict(model, f);
    const assist = createHeadAssist(model);
    const shift = assisted ? assist(f, 0, false) : { x: 0, y: 0 };
    return sum + Math.hypot(p.x + shift.x - px, p.y + shift.y - py);
  }, 0) / POINTS.length;
  for (const [name, position] of Object.entries({
    'shifted sideways': { x: 6 },
    'sitting higher': { y: -15 },
    'head partly turned toward the point': { headShare: 0.5 },
    'both': { x: 4, headShare: 0.4 },
  })) {
    const without = errorAt(position, false), withAssist = errorAt(position, true);
    assert.ok(withAssist < without * 0.6, `${name}: ${Math.round(without)}px without, ${Math.round(withAssist)}px with`);
  }
});

test('head assist: turning with the eyes held moves the point the same way, and quick swings are ignored', () => {
  const { createHeadAssist } = globalThis.GazeModel;
  const { model } = fit(physicalCalibration(55));
  const assist = createHeadAssist(model);
  const rest = physicalFrame(960, 540);
  const base = assist(rest, 0, false).x;
  const turned = [...rest];
  turned[2] -= 0.05; // toward the user's right, with the eyes unmoved
  let shift = base;
  for (let t = 40; t < 2000; t += 40) shift = assist(turned, t, false).x;
  assert.ok(shift - base > 40, `moved right by ${Math.round(shift - base)}px`);
  const frozen = assist(rest, 2040, true).x;
  assert.strictEqual(assist(rest, 2080, true).x, frozen, 'frozen during a swing');
});

test('a model with no eye weights gets no head assist', () => {
  const { createHeadAssist } = globalThis.GazeModel;
  const assist = createHeadAssist({ mean: [0, 0, 0, 0], wx: [0, 5, 0, 0], wy: [0, 0, 5] });
  const shift = assist([0, 0, 0, 0, 500, 500, -40], 0, false);
  assert.ok(Math.abs(shift.x) < 1e-9 && Math.abs(shift.y) < 1e-9);
});

test('"눈길 켜줘" and "눈길 꺼줘" turn it on and off, in the ways people say them', () => {
  for (const say of ['눈길 켜줘', '눈길 켜 줘', '눈길 켜', '눈길 켜 주세요', '눈길 시작', '눈길 켜기']) assert.strictEqual(parseCommand(say)?.name, 'powerOn', say);
  for (const say of ['눈길 꺼줘', '눈길 꺼 줘', '눈길 꺼', '눈길 꺼 주세요', '눈길 종료', '눈길 끄기']) assert.strictEqual(parseCommand(say)?.name, 'powerOff', say);
  assert.strictEqual(parseCommand('불 꺼줘'), null);
});

test('resting head sway never counts as head movement', () => {
  const { createHeadFlick } = globalThis.GazeModel;
  for (let seed = 1; seed < 12; seed++) {
    const detect = createHeadFlick();
    const r = rng(seed);
    let moving = 0;
    for (let t = 0; t < 20000; t += 40) {
      // A slow sway of about 1.5 degrees, plus pose noise.
      const yaw = 0.026 * Math.sin(t / 900) + r() * 0.008;
      const pitch = 0.018 * Math.sin(t / 1300) + r() * 0.008;
      if (detect(yaw, pitch, t).moving) moving++;
    }
    assert.strictEqual(moving, 0, `seed ${seed}`);
  }
});

test('a modest flick of about 4 degrees still counts', () => {
  assert.deepStrictEqual(replayHead(flickPath(0.075, 0, 130, 180), 400), ['yaw+']);
  assert.deepStrictEqual(replayHead(flickPath(0, -0.055, 130, 180), 400), ['pitch-']);
});
