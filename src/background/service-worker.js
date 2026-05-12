import { sendToClaude, resetClaudeSession } from './providers/claude.js';
import { sendToChatGPT, resetChatGPTSession } from './providers/chatgpt.js';
import { sendToClaudeApi, resetClaudeApiSession } from './providers/claude-api.js';
import { sendToChatGPTApi, resetChatGPTApiSession } from './providers/chatgpt-api.js';

const sessions = new Map();

const DISPATCH = {
  'claude-session': { send: sendToClaude, reset: resetClaudeSession, needsConfig: false },
  'claude-api':     { send: sendToClaudeApi, reset: resetClaudeApiSession, needsConfig: true },
  'chatgpt-session':{ send: sendToChatGPT, reset: resetChatGPTSession, needsConfig: false },
  'chatgpt-api':    { send: sendToChatGPTApi, reset: resetChatGPTApiSession, needsConfig: true }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('clawverleaf/')) return false;

  if (msg.type === 'clawverleaf/send') {
    handleSend(msg)
      .then((reply) => sendResponse({ ok: true, reply }))
      .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
    return true;
  }

  if (msg.type === 'clawverleaf/end') {
    const session = sessions.get(msg.sessionId);
    if (session) {
      const d = DISPATCH[session.provider];
      if (d) d.reset(session.state);
      sessions.delete(msg.sessionId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'clawverleaf/probe') {
    probe(msg.provider)
      .then((info) => sendResponse({ ok: true, info }))
      .catch((err) => sendResponse({ ok: false, error: errMsg(err) }));
    return true;
  }
});

async function handleSend({ sessionId, provider, prompt }) {
  const dispatch = DISPATCH[provider];
  if (!dispatch) throw new Error(`Unknown provider: ${provider}`);
  let session = sessions.get(sessionId);
  if (!session || session.provider !== provider) {
    if (session) DISPATCH[session.provider] && DISPATCH[session.provider].reset(session.state);
    session = { provider, state: {} };
    sessions.set(sessionId, session);
  }
  const config = dispatch.needsConfig ? await getConfig() : null;
  return await dispatch.send(prompt, session.state, config);
}

async function probe(provider) {
  if (provider === 'claude-session') {
    const r = await fetch('https://claude.ai/api/organizations', { credentials: 'include' });
    if (!r.ok) throw new Error(`claude.ai /api/organizations -> ${r.status}. Log in to claude.ai first.`);
    const orgs = await r.json();
    return { orgs: Array.isArray(orgs) ? orgs.length : 0 };
  }
  if (provider === 'chatgpt-session') {
    const r = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
    if (!r.ok) throw new Error(`chatgpt.com /api/auth/session -> ${r.status}. Log in to chatgpt.com first.`);
    const data = await r.json();
    if (!data || !data.accessToken) throw new Error('No ChatGPT access token. Log in to chatgpt.com first.');
    return { user: data.user && data.user.email };
  }
  if (provider === 'claude-api') {
    const cfg = await getConfig();
    if (!cfg.anthropicApiKey) throw new Error('No Anthropic API key set.');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cfg.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.anthropicModel || 'claude-opus-4-7',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }]
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Anthropic API -> ${r.status} ${t.slice(0, 200)}`);
    }
    return { ok: true };
  }
  if (provider === 'chatgpt-api') {
    const cfg = await getConfig();
    if (!cfg.openaiApiKey) throw new Error('No OpenAI API key set.');
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${cfg.openaiApiKey}` }
    });
    if (!r.ok) throw new Error(`OpenAI API -> ${r.status}`);
    return { ok: true };
  }
  throw new Error(`unknown provider: ${provider}`);
}

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      {
        provider: 'claude-session',
        anthropicApiKey: '',
        anthropicModel: 'claude-opus-4-7',
        openaiApiKey: '',
        openaiModel: 'gpt-4o'
      },
      resolve
    );
  });
}

function errMsg(err) {
  return err && err.message ? err.message : String(err);
}
