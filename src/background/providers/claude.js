const BASE = 'https://claude.ai';
const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

export function resetClaudeSession(state) {
  delete state.orgId;
  delete state.convId;
  delete state.parentId;
}

export async function sendToClaude(prompt, state) {
  if (!state.orgId) state.orgId = await fetchOrgId();
  if (!state.convId) {
    state.convId = await createConversation(state.orgId);
    state.parentId = ROOT_PARENT;
  }
  const text = await sendMessage(state.orgId, state.convId, prompt);
  return text;
}

async function fetchOrgId() {
  const r = await fetch(`${BASE}/api/organizations`, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`claude.ai /api/organizations -> ${r.status}. Log in to claude.ai first.`);
  const orgs = await r.json();
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('No Claude organizations found on this account.');
  const chat = orgs.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')) || orgs[0];
  return chat.uuid;
}

async function createConversation(orgId) {
  const uuid = crypto.randomUUID();
  const r = await fetch(`${BASE}/api/organizations/${orgId}/chat_conversations?incognito=true`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'anthropic-client-platform': 'web_claude_ai'
    },
    body: JSON.stringify({
      uuid,
      name: 'Clawverleaf edit',
      message: '',
      is_incognito: true,
      incognito: true,
      include_conversation_preferences: true
    })
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`claude.ai create conversation -> ${r.status} ${body.slice(0, 200)}`);
  }
  return uuid;
}

async function sendMessage(orgId, convId, prompt) {
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  const body = {
    prompt,
    parent_message_uuid: ROOT_PARENT,
    timezone: tz,
    personalized_styles: [{
      type: 'default',
      key: 'Default',
      name: 'Normal',
      nameKey: 'normal_style_name',
      prompt: 'Normal',
      summary: 'Default responses from Claude',
      summaryKey: 'normal_style_summary',
      isDefault: true
    }],
    locale: 'en-US',
    rendering_mode: 'messages',
    tools: [],
    attachments: [],
    files: [],
    sync_sources: []
  };

  const r = await fetch(`${BASE}/api/organizations/${orgId}/chat_conversations/${convId}/completion`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'anthropic-client-platform': 'web_claude_ai'
    },
    body: JSON.stringify(body)
  });

  if (!r.ok || !r.body) {
    const errBody = await r.text().catch(() => '');
    throw new Error(`claude.ai completion -> ${r.status} ${errBody.slice(0, 300)}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const seenTypes = new Set();
  let lastError = null;
  let eventCount = 0;
  let lastEventSample = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let sep;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const evt = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLines = evt
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart());
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n');
      try {
        const data = JSON.parse(payload);
        eventCount++;
        if (data && data.type) seenTypes.add(data.type);
        if (data && (data.type === 'error' || data.error)) {
          lastError = data.error || data.message || JSON.stringify(data).slice(0, 200);
        }
        const piece = extractText(data);
        if (piece) {
          text += piece;
        } else if (!lastEventSample && data && typeof data === 'object') {
          lastEventSample = JSON.stringify(data).slice(0, 300);
        }
      } catch {}
    }
  }

  if (!text) {
    if (lastError) throw new Error(`claude.ai error: ${typeof lastError === 'string' ? lastError : JSON.stringify(lastError)}`);
    const types = [...seenTypes].join(', ') || 'none';
    const ct = r.headers.get('content-type') || 'none';
    const remaining = buf.slice(0, 400);
    throw new Error(
      `claude.ai returned no text (status=${r.status}, content-type=${ct}, events=${eventCount}, types=[${types}], rawBuf=${JSON.stringify(remaining)}, sample=${lastEventSample || 'none'})`
    );
  }
  return text.trim();
}

function extractText(data) {
  if (!data || typeof data !== 'object') return '';
  let out = '';
  if (typeof data.completion === 'string') out += data.completion;
  if (data.delta) {
    if (typeof data.delta.text === 'string') out += data.delta.text;
    else if (typeof data.delta.completion === 'string') out += data.delta.completion;
    else if (data.delta.partial_json && typeof data.delta.partial_json === 'string') {}
  }
  if (data.content_block && typeof data.content_block.text === 'string') out += data.content_block.text;
  if (Array.isArray(data.content)) {
    for (const c of data.content) {
      if (c && typeof c.text === 'string') out += c.text;
    }
  }
  if (data.message && Array.isArray(data.message.content)) {
    for (const c of data.message.content) {
      if (c && typeof c.text === 'string') out += c.text;
    }
  }
  return out;
}
