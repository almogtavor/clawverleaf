const DEFAULTS = {
  provider: 'claude-session',
  anthropicApiKey: '',
  anthropicModel: 'claude-opus-4-7',
  openaiApiKey: '',
  openaiModel: 'gpt-4o'
};

const $ = (sel) => document.querySelector(sel);

function load() {
  chrome.storage.local.get(DEFAULTS, (cfg) => {
    document.querySelectorAll('input[name="provider"]').forEach((el) => {
      el.checked = el.value === cfg.provider;
    });
    $('#anthropicApiKey').value = cfg.anthropicApiKey || '';
    $('#anthropicModel').value = cfg.anthropicModel || DEFAULTS.anthropicModel;
    $('#openaiApiKey').value = cfg.openaiApiKey || '';
    $('#openaiModel').value = cfg.openaiModel || DEFAULTS.openaiModel;
  });
}

function save() {
  const provider = (document.querySelector('input[name="provider"]:checked') || {}).value || DEFAULTS.provider;
  const cfg = {
    provider,
    anthropicApiKey: $('#anthropicApiKey').value.trim(),
    anthropicModel: $('#anthropicModel').value.trim() || DEFAULTS.anthropicModel,
    openaiApiKey: $('#openaiApiKey').value.trim(),
    openaiModel: $('#openaiModel').value.trim() || DEFAULTS.openaiModel
  };
  chrome.storage.local.set(cfg, () => setStatus('Saved.', 'ok'));
}

function probe() {
  const provider = (document.querySelector('input[name="provider"]:checked') || {}).value || DEFAULTS.provider;
  setStatus('Testing…');
  chrome.runtime.sendMessage({ type: 'clawverleaf/probe', provider }, (resp) => {
    if (chrome.runtime.lastError) return setStatus(chrome.runtime.lastError.message, 'err');
    if (!resp || !resp.ok) return setStatus(resp && resp.error ? resp.error : 'failed', 'err');
    setStatus(`OK — ${JSON.stringify(resp.info || {})}`, 'ok');
  });
}

function setStatus(text, kind) {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${kind || ''}`.trim();
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('#save').addEventListener('click', save);
  $('#probe').addEventListener('click', probe);
});
