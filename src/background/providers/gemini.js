const BASE = 'https://gemini.google.com';
const GENERATE = `${BASE}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`;

export function resetGeminiSession(state) {
  delete state.accessToken;
  delete state.history;
  delete state.incognito;
}

export async function sendToGemini(prompt, state, config) {
  const incognito = !config || config.incognito !== false;
  if (state.incognito !== undefined && state.incognito !== incognito) delete state.history;
  state.incognito = incognito;
  if (!state.accessToken) state.accessToken = await fetchAccessToken();
  if (!Array.isArray(state.history)) state.history = [];

  const promptWithHistory = buildPromptWithHistory(state.history, prompt);
  const text = await generate(promptWithHistory, state.accessToken);
  state.history.push({ role: 'user', content: prompt });
  state.history.push({ role: 'assistant', content: text });
  return text;
}

async function fetchAccessToken() {
  const r = await fetch(`${BASE}/app`, {
    credentials: 'include',
    headers: { 'Accept': 'text/html' }
  });
  if (!r.ok) throw new Error(`gemini.google.com/app -> ${r.status}. Log in to Gemini first.`);

  const html = await r.text();
  const match = html.match(/"SNlM0e":"([^"]+)"/) || html.match(/\\"SNlM0e\\":\\"([^"\\]+)\\"/);
  if (!match) throw new Error('Could not read Gemini session token. Open gemini.google.com/app, finish sign-in, then retry.');
  return decodeEscaped(match[1]);
}

async function generate(prompt, accessToken) {
  const inner = JSON.stringify([[prompt], null, null]);
  const body = new URLSearchParams({
    at: accessToken,
    'f.req': JSON.stringify([null, inner])
  });

  const r = await fetch(GENERATE, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      'Accept': '*/*',
      'X-Same-Domain': '1'
    },
    body
  });

  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`gemini.google.com StreamGenerate -> ${r.status} ${errBody.slice(0, 300)}`);
  }

  const responseText = await r.text();
  const text = parseGeminiText(responseText);
  if (!text) throw new Error(`Gemini returned no text. Raw response: ${responseText.slice(0, 300)}`);
  return text.trim();
}

function buildPromptWithHistory(history, prompt) {
  if (!history.length) return prompt;
  return [
    'Continue the same editing conversation. Prior turns are provided for context.',
    '',
    ...history.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}:\n${m.content}`),
    '',
    `User:\n${prompt}`
  ].join('\n\n');
}

function parseGeminiText(raw) {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== ")]}'" && !/^\d+$/.test(line));

  for (const line of lines) {
    if (!line.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(line);
      const text = extractFromBatch(parsed);
      if (text) return text;
    } catch {}
  }
  return '';
}

function extractFromBatch(value) {
  if (!Array.isArray(value)) return '';
  for (const item of value) {
    if (Array.isArray(item) && typeof item[2] === 'string') {
      try {
        const body = JSON.parse(item[2]);
        const text = extractFromBody(body);
        if (text) return text;
      } catch {}
    }
    const nested = extractFromBatch(item);
    if (nested) return nested;
  }
  return '';
}

function extractFromBody(body) {
  const candidates = body && body[4];
  if (!Array.isArray(candidates)) return '';
  for (const candidate of candidates) {
    const text = candidate && candidate[1] && candidate[1][0];
    if (typeof text === 'string' && text.trim()) return text;
  }
  return '';
}

function decodeEscaped(value) {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return value;
  }
}
