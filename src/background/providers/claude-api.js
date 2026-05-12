const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-4-7';

export function resetClaudeApiSession(state) {
  delete state.history;
}

export async function sendToClaudeApi(prompt, state, config) {
  const apiKey = config && config.anthropicApiKey;
  if (!apiKey) throw new Error('No Anthropic API key set. Add one in Clawverleaf settings.');
  const model = (config && config.anthropicModel) || DEFAULT_MODEL;

  if (!Array.isArray(state.history)) state.history = [];
  state.history.push({ role: 'user', content: prompt });

  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: state.history
    })
  });

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    state.history.pop();
    throw new Error(`Anthropic API -> ${r.status} ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const text = (Array.isArray(data.content) ? data.content : [])
    .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('');
  state.history.push({ role: 'assistant', content: text });
  return text.trim();
}
