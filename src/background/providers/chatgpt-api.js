const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o';

export function resetChatGPTApiSession(state) {
  delete state.history;
}

export async function sendToChatGPTApi(prompt, state, config) {
  const apiKey = config && config.openaiApiKey;
  if (!apiKey) throw new Error('No OpenAI API key set. Add one in Clawverleaf settings.');
  const model = (config && config.openaiModel) || DEFAULT_MODEL;

  if (!Array.isArray(state.history)) state.history = [];
  state.history.push({ role: 'user', content: prompt });

  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: state.history
    })
  });

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    state.history.pop();
    throw new Error(`OpenAI API -> ${r.status} ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? (data.choices[0].message.content || '')
    : '';
  state.history.push({ role: 'assistant', content: text });
  return text.trim();
}
