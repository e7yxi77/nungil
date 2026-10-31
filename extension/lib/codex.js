// ChatGPT sign-in and Codex responses, using the OpenAI Codex CLI's OAuth client.
// This is an interface OpenAI publishes for its own tooling, not for third
// parties, so it may change without notice. Only runs after an explicit sign-in.
(() => {
  const OAUTH = {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    revokeUrl: 'https://auth.openai.com/oauth/revoke',
    redirectUri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access',
    claimPath: 'https://api.openai.com/auth',
    originator: 'nungil',
  };
  const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
  // Lightest first, from the Codex CLI's model list. OpenAI retires these over time,
  // so a model the server refuses just moves on to the next one.
  const MODELS = ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-6.1-terra', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-5.5', 'gpt-6.1-sol'];

  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function randomToken(size) {
    return b64url(crypto.getRandomValues(new Uint8Array(size)));
  }

  async function createPkce() {
    const verifier = randomToken(32);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: b64url(digest) };
  }

  function decodeJwt(token) {
    try {
      const payload = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))));
    } catch {
      return null;
    }
  }

  const accountIdOf = (access) => decodeJwt(access)?.[OAUTH.claimPath]?.chatgpt_account_id ?? null;

  function buildAuthorizeUrl({ challenge, state }) {
    const url = new URL(OAUTH.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: OAUTH.clientId,
      redirect_uri: OAUTH.redirectUri,
      scope: OAUTH.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: OAUTH.originator,
    });
    return url.toString();
  }

  // A forged callback's code must never be redeemed, so state is checked first.
  function parseCallback(callbackUrl, expectedState) {
    const params = new URL(callbackUrl).searchParams;
    if (params.get('error')) return { error: params.get('error') };
    if (params.get('state') !== expectedState) return { error: 'state_mismatch' };
    const code = params.get('code');
    return code ? { code } : { error: 'no_code' };
  }

  async function postToken(body) {
    return fetch(OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: OAUTH.clientId, ...body }),
    });
  }

  async function exchangeCode(code, verifier) {
    const res = await postToken({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: OAUTH.redirectUri });
    if (!res.ok) throw new Error(`token_exchange_${res.status}`);
    const json = await res.json();
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') throw new Error('token_response_incomplete');
    const accountId = accountIdOf(json.access_token);
    if (!accountId) throw new Error('no_account_id');
    return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000, accountId };
  }

  // A refresh response may omit a new refresh token; the account id is stable.
  async function refreshTokens(prev) {
    const res = await postToken({ grant_type: 'refresh_token', refresh_token: prev.refresh });
    if (!res.ok) throw new Error(`token_refresh_${res.status}`);
    const json = await res.json();
    if (!json.access_token) throw new Error('refresh_response_incomplete');
    const expiresIn = json.expires_in > 0 ? json.expires_in : 3600;
    return {
      access: json.access_token,
      refresh: json.refresh_token || prev.refresh,
      expires: Date.now() + expiresIn * 1000,
      accountId: accountIdOf(json.access_token) || prev.accountId,
    };
  }

  async function revoke(token) {
    if (!token) return;
    await fetch(OAUTH.revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: OAUTH.clientId, token }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {}); // clearing local state is what matters
  }

  async function* sseEvents(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const dataOf = (block) => block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? '\n\n' : decoder.decode(value, { stream: true });
      const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
      buffer = blocks.pop();
      for (const block of blocks) {
        const data = dataOf(block);
        if (data) yield data;
      }
      if (done) return;
    }
  }

  // Yields text deltas. Throws with OpenAI's message on a failed response.
  async function* streamResponse({ auth, instructions, text, model = MODELS[0] }) {
    const res = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.access}`,
        'chatgpt-account-id': auth.accountId,
        originator: OAUTH.originator,
        'OpenAI-Beta': 'responses=experimental',
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
        stream: true,
        store: false,
        parallel_tool_calls: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let reason = body;
      try {
        const parsed = JSON.parse(body);
        reason = parsed.detail || parsed.error?.message || parsed.message || body;
      } catch { /* not JSON: keep the raw text */ }
      const error = new Error(`http_${res.status}${reason ? `: ${String(reason).slice(0, 160)}` : ''}`);
      error.status = res.status;
      throw error;
    }
    if (!res.body) throw new Error('empty_response');

    let sawText = false;
    let failure = '';
    for await (const data of sseEvents(res.body)) {
      if (data === '[DONE]') break;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === 'response.output_text.delta' && event.delta) {
        sawText = true;
        yield event.delta;
      } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        failure = event.response?.error?.message || event.response?.incomplete_details?.reason || event.type;
      } else if (event.type === 'error') {
        failure = event.error?.message || event.message || 'stream_error';
      }
    }
    if (!sawText) throw new Error(failure || 'empty_response');
  }

  // One step of an agent run. Anything malformed is rejected, which stops the run:
  // this reply steers a browser, so nothing is guessed from it.
  function parseAgentAction(reply, count) {
    let a;
    try {
      a = JSON.parse(String(reply).match(/\{[\s\S]*\}/)?.[0] ?? '');
    } catch {
      return null;
    }
    const say = typeof a?.say === 'string' ? a.say.slice(0, 200) : '';
    const validIndex = Number.isInteger(a?.index) && a.index >= 0 && a.index < count;
    switch (a?.action) {
      case 'navigate':
        return /^https?:\/\//i.test(a.url ?? '') ? { action: 'navigate', url: a.url, say } : null;
      case 'click':
        return validIndex ? { action: 'click', index: a.index, say } : null;
      case 'type':
        return validIndex && typeof a.text === 'string' && a.text ? { action: 'type', index: a.index, text: a.text, say } : null;
      case 'scroll':
        return { action: 'scroll', say };
      case 'done':
      case 'ask':
        return { action: a.action, say: say || a.action };
      default:
        return null;
    }
  }

  // Tries `preferred` first. 400 and 404 are how the server refuses a model; anything
  // else (expired sign-in, rate limit, outage) would fail on every model, so it stops.
  async function* streamWithFallback({ preferred, onModel, ...request }) {
    const order = [...new Set([preferred, ...MODELS].filter(Boolean))];
    for (const [i, model] of order.entries()) {
      try {
        let announced = false;
        for await (const delta of streamResponse({ ...request, model })) {
          if (!announced) {
            announced = true;
            await onModel?.(model);
          }
          yield delta;
        }
        return;
      } catch (error) {
        const refused = error.status === 400 || error.status === 404;
        if (!refused || i === order.length - 1) throw error;
      }
    }
  }

  // The model's choice of on-screen items. Anything that isn't a real index is
  // dropped, so a bad reply can only ever select nothing.
  function parseMatches(reply, count, max = 9) {
    let parsed;
    try {
      parsed = JSON.parse(String(reply).match(/\{[\s\S]*\}/)?.[0] ?? '');
    } catch {
      return [];
    }
    const list = Array.isArray(parsed?.matches) ? parsed.matches : [];
    return [...new Set(list)].filter((i) => Number.isInteger(i) && i >= 0 && i < count).slice(0, max);
  }

  globalThis.Codex = { parseAgentAction, parseMatches, OAUTH,randomToken, createPkce, decodeJwt, accountIdOf, buildAuthorizeUrl, parseCallback, exchangeCode, refreshTokens, revoke, streamResponse, streamWithFallback, MODELS };
})();
