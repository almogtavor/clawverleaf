import { solveProofOfWork } from './chatgpt-pow.js';

const BASE = 'https://chatgpt.com';

export function resetChatGPTSession(state) {
  delete state.token;
  delete state.tokenExpires;
  delete state.deviceId;
  delete state.convId;
  delete state.parentId;
  delete state.model;
}

export async function sendToChatGPT(prompt, state) {
  if (!state.deviceId) state.deviceId = crypto.randomUUID();
  if (!state.token || (state.tokenExpires && Date.now() > state.tokenExpires - 60_000)) {
    const t = await fetchSession();
    state.token = t.accessToken;
    state.tokenExpires = t.expires;
  }
  if (!state.parentId) state.parentId = crypto.randomUUID();
  if (!state.model) state.model = 'auto';

  const requirements = await fetchRequirements(state.token, state.deviceId);
  const sentinelToken = requirements && requirements.token;
  let proofToken = null;
  if (requirements && requirements.proofofwork && requirements.proofofwork.required) {
    proofToken = solveProofOfWork(
      requirements.proofofwork.seed,
      requirements.proofofwork.difficulty,
      state.deviceId
    );
  }
  if (requirements && (requirements.arkose && requirements.arkose.required)) {
    throw new Error('ChatGPT is asking for an Arkose/captcha challenge this build cannot solve. Open chatgpt.com, send one message, then retry.');
  }
  if (requirements && (requirements.turnstile && requirements.turnstile.required)) {
    throw new Error('ChatGPT is asking for a Cloudflare Turnstile challenge this build cannot solve. Open chatgpt.com, send one message, then retry.');
  }

  const reply = await postConversation({
    token: state.token,
    deviceId: state.deviceId,
    sentinelToken,
    proofToken,
    model: state.model,
    parentId: state.parentId,
    convId: state.convId,
    prompt
  });

  if (reply.convId) state.convId = reply.convId;
  if (reply.lastMessageId) state.parentId = reply.lastMessageId;
  return reply.text;
}

async function fetchSession() {
  const r = await fetch(`${BASE}/api/auth/session`, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`chatgpt.com /api/auth/session -> ${r.status}. Log in to chatgpt.com first.`);
  const data = await r.json();
  if (!data || !data.accessToken) throw new Error('No ChatGPT access token. Log in to chatgpt.com first.');
  const expires = data.expires ? Date.parse(data.expires) : Date.now() + 30 * 60_000;
  return { accessToken: data.accessToken, expires };
}

async function fetchRequirements(token, deviceId) {
  const r = await fetch(`${BASE}/backend-api/sentinel/chat-requirements`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'OAI-Device-Id': deviceId,
      'OAI-Language': 'en-US'
    },
    body: JSON.stringify({ p: '' })
  });
  if (!r.ok) {
    if (r.status === 401) throw new Error('chatgpt.com session is unauthorized. Log in to chatgpt.com again.');
    return null;
  }
  return await r.json().catch(() => null);
}

async function postConversation({ token, deviceId, sentinelToken, proofToken, model, parentId, convId, prompt }) {
  const messageId = crypto.randomUUID();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'OAI-Device-Id': deviceId,
    'OAI-Language': 'en-US'
  };
  if (sentinelToken) headers['OpenAI-Sentinel-Chat-Requirements-Token'] = sentinelToken;
  if (proofToken) headers['OpenAI-Sentinel-Proof-Token'] = proofToken;

  const body = {
    action: 'next',
    messages: [
      {
        id: messageId,
        author: { role: 'user' },
        content: { content_type: 'text', parts: [prompt] },
        metadata: {}
      }
    ],
    parent_message_id: parentId,
    model,
    timezone_offset_min: new Date().getTimezoneOffset(),
    suggestions: [],
    history_and_training_disabled: false,
    websocket_request_id: crypto.randomUUID()
  };
  if (convId) body.conversation_id = convId;

  const r = await fetch(`${BASE}/backend-api/conversation`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body)
  });

  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '');
    if (r.status === 403 && /proof|pow|sentinel/i.test(t)) {
      throw new Error('ChatGPT blocked the request with a proof-of-work challenge. Use the Claude provider for now.');
    }
    throw new Error(`chatgpt.com conversation -> ${r.status} ${t.slice(0, 200)}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let outConvId = convId;
  let outLastId = parentId;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const evt = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const data = JSON.parse(payload);
        if (data.conversation_id) outConvId = data.conversation_id;
        if (data.message && data.message.id) outLastId = data.message.id;
        const piece = extractChatGPTText(data);
        if (piece) text = piece;
      } catch {}
    }
  }

  return { text: text.trim(), convId: outConvId, lastMessageId: outLastId };
}

function extractChatGPTText(data) {
  const m = data && data.message;
  if (!m) return '';
  const parts = m.content && m.content.parts;
  if (Array.isArray(parts)) {
    return parts.map((p) => (typeof p === 'string' ? p : '')).join('');
  }
  return '';
}
