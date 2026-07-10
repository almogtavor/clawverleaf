(() => {
  if (window.__clawverleafContentInstalled) return;
  window.__clawverleafContentInstalled = true;

  injectPageBridge();

  const SESSION_ID = `cw-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const PROVIDER_LABELS = {
    'claude-session': 'Claude (session)',
    'claude-api': 'Claude (API key)',
    'chatgpt-session': 'ChatGPT (session)',
    'chatgpt-api': 'ChatGPT (API key)',
    'gemini-session': 'Gemini (session)'
  };
  const DEFAULT_CONFIG = {
    provider: 'claude-session',
    incognito: true,
    anthropicApiKey: '',
    anthropicModel: 'claude-opus-4-7',
    openaiApiKey: '',
    openaiModel: 'gpt-4o'
  };

  let pillEl = null;
  let panelHost = null;
  let activePanel = null;
  let selectionUpdateTimer = null;
  let selectionUpdateSeq = 0;

  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('mousedown', (e) => {
    if (panelHost && panelHost.contains(e.target)) return;
    if (pillEl && pillEl.contains(e.target)) return;
  });

  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return hidePill();
    const range = sel.getRangeAt(0);
    const anchor = range.startContainer && range.startContainer.parentElement;
    if (!anchor) return hidePill();
    const cmContent = anchor.closest && anchor.closest('.cm-content');
    if (!cmContent) return hidePill();
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return hidePill();
    if (activePanel) {
      showPill(rect, 'Use selection');
      schedulePanelSelectionUpdate();
      return;
    }
    showPill(rect, '✎  Edit');
  }

  function showPill(rect, label) {
    if (!pillEl) {
      pillEl = document.createElement('div');
      pillEl.id = 'clawverleaf-pill';
      pillEl.style.cssText = pillCss();
      pillEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      pillEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPanel();
      });
      document.body.appendChild(pillEl);
    }
    pillEl.textContent = label || '✎  Edit';
    const top = window.scrollY + rect.top - 36;
    const left = window.scrollX + rect.right - 70;
    pillEl.style.top = `${Math.max(window.scrollY + 8, top)}px`;
    pillEl.style.left = `${Math.max(8, left)}px`;
    pillEl.style.display = 'flex';
  }

  function hidePill() {
    if (pillEl) pillEl.style.display = 'none';
  }

  async function openPanel() {
    hidePill();
    const selection = await bridge('getSelection');
    if (!selection || !selection.text) {
      flash('No selection found in the editor.');
      return;
    }
    if (activePanel) {
      activePanel.setSelection(selection);
      activePanel.focusInput();
      return;
    }
    const fullDoc = await bridge('getDoc');
    if (typeof fullDoc !== 'string') {
      flash('Could not read document text.');
      return;
    }
    const config = await getConfig();
    mountPanel({ selection, fullDoc, config });
  }

  async function getConfig() {
    return new Promise((resolve) => {
      const storage = getStorageLocal();
      if (!storage || typeof storage.get !== 'function') {
        resolve(Object.assign({}, DEFAULT_CONFIG));
        return;
      }
      storage.get(DEFAULT_CONFIG, (cfg) => {
        const config = normalizeConfig(cfg);
        if (cfg && cfg.provider !== config.provider) setConfig({ provider: config.provider });
        resolve(config);
      });
    });
  }

  async function setConfig(values) {
    return new Promise((resolve) => {
      const storage = getStorageLocal();
      if (!storage || typeof storage.set !== 'function') return resolve();
      storage.set(values, resolve);
    });
  }

  function getStorageLocal() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
      ? chrome.storage.local
      : null;
  }

  function normalizeConfig(cfg) {
    const config = Object.assign({}, DEFAULT_CONFIG, cfg || {});
    if (!PROVIDER_LABELS[config.provider]) config.provider = DEFAULT_CONFIG.provider;
    return config;
  }

  function mountPanel(ctx) {
    if (panelHost) return;
    panelHost = document.createElement('div');
    panelHost.id = 'clawverleaf-host';
    panelHost.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    document.documentElement.appendChild(panelHost);
    const shadow = panelHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = panelMarkup();
    activePanel = new Panel(shadow, ctx, () => {
      panelHost && panelHost.remove();
      panelHost = null;
      activePanel = null;
      chrome.runtime.sendMessage({ type: 'clawverleaf/end', sessionId: SESSION_ID }).catch(() => {});
    });
    activePanel.start();
  }

  function schedulePanelSelectionUpdate() {
    clearTimeout(selectionUpdateTimer);
    const seq = ++selectionUpdateSeq;
    selectionUpdateTimer = setTimeout(async () => {
      try {
        const selection = await bridge('getSelection');
        if (seq !== selectionUpdateSeq || !activePanel || !selection || !selection.text.trim()) return;
        activePanel.setSelection(selection);
      } catch {}
    }, 120);
  }

  class Panel {
    constructor(shadow, ctx, onClose) {
      this.shadow = shadow;
      this.ctx = ctx;
      this.onClose = onClose;
      this.thread = shadow.getElementById('cw-thread');
      this.input = shadow.getElementById('cw-input');
      this.send = shadow.getElementById('cw-send');
      this.providerSel = shadow.getElementById('cw-provider');
      this.subtitle = shadow.getElementById('cw-subtitle');
      this.closeBtn = shadow.getElementById('cw-close');
      this.previewBox = shadow.getElementById('cw-selection-preview');
      this.selectionMeta = shadow.getElementById('cw-selection-meta');
      this.lastSuggestion = null;
      this.lastPromptSelectionKey = null;
      this.firstTurn = true;
    }

    start() {
      const { selection, config } = this.ctx;
      this.providerSel.value = config.provider;
      this.providerSel.addEventListener('change', () => {
        this.ctx.config.provider = this.providerSel.value;
        setConfig({ provider: this.providerSel.value });
        this.subtitle.textContent = PROVIDER_LABELS[this.providerSel.value] || this.providerSel.value;
        this.firstTurn = true;
        this.lastPromptSelectionKey = null;
      });
      this.subtitle.textContent = PROVIDER_LABELS[config.provider] || config.provider;

      this.renderSelection(selection);

      this.closeBtn.addEventListener('click', () => this.onClose());
      this.shadow.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.onClose();
      });
      this.send.addEventListener('click', () => this.submit());
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          this.submit();
        }
      });
      this.input.focus();
      this.makeDraggable();
      this.makeResizable();
    }

    focusInput() {
      this.input.focus();
    }

    setSelection(selection) {
      if (!selection || !selection.text || !selection.text.trim()) return;
      this.ctx.selection = selection;
      this.renderSelection(selection);
    }

    renderSelection(selection) {
      const collapse = selection.text.length > 600 ? selection.text.slice(0, 600) + '…' : selection.text;
      this.previewBox.textContent = collapse;
      this.selectionMeta.textContent = `${selection.text.length} chars · chars ${selection.from}–${selection.to}`;
    }

    makeDraggable() {
      const panel = this.shadow.getElementById('cw-panel');
      const handle = this.shadow.getElementById('cw-header');
      let dragging = false;
      let sx = 0, sy = 0, ox = 0, oy = 0;
      handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, select')) return;
        dragging = true;
        const rect = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        panel.style.left = `${ox + (e.clientX - sx)}px`;
        panel.style.top = `${oy + (e.clientY - sy)}px`;
      });
      window.addEventListener('mouseup', () => { dragging = false; });
    }

    makeResizable() {
      const panel = this.shadow.getElementById('cw-panel');
      const handles = this.shadow.querySelectorAll('[data-resize]');
      let resizing = false;
      let dir = '';
      let sx = 0, sy = 0, sw = 0, sh = 0, ox = 0, oy = 0;
      let prevCursor = '';
      let prevUserSelect = '';
      const minWidth = 360;
      const minHeight = 320;

      handles.forEach((handle) => {
        handle.addEventListener('mousedown', (e) => {
          resizing = true;
          dir = handle.dataset.resize || '';
          const rect = panel.getBoundingClientRect();
          sx = e.clientX; sy = e.clientY; sw = rect.width; sh = rect.height;
          ox = rect.left; oy = rect.top;
          panel.style.left = `${ox}px`;
          panel.style.top = `${oy}px`;
          panel.style.right = 'auto';
          panel.style.bottom = 'auto';
          panel.style.width = `${sw}px`;
          panel.style.height = `${sh}px`;
          prevCursor = document.body.style.cursor;
          prevUserSelect = document.body.style.userSelect;
          document.body.style.cursor = getComputedStyle(handle).cursor;
          document.body.style.userSelect = 'none';
          e.preventDefault();
          e.stopPropagation();
        });
      });

      window.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        const minLeft = 8;
        const minTop = 8;
        const maxRight = window.innerWidth - 8;
        const maxBottom = window.innerHeight - 8;
        let left = ox;
        let top = oy;
        let width = sw;
        let height = sh;

        if (dir.includes('e')) {
          width = Math.min(maxRight - ox, Math.max(minWidth, sw + dx));
        }
        if (dir.includes('s')) {
          height = Math.min(maxBottom - oy, Math.max(minHeight, sh + dy));
        }
        if (dir.includes('w')) {
          left = Math.min(ox + sw - minWidth, Math.max(minLeft, ox + dx));
          width = ox + sw - left;
        }
        if (dir.includes('n')) {
          top = Math.min(oy + sh - minHeight, Math.max(minTop, oy + dy));
          height = oy + sh - top;
        }

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
      });

      window.addEventListener('mouseup', () => {
        if (!resizing) return;
        resizing = false;
        dir = '';
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      });
    }

    async submit() {
      const text = this.input.value.trim();
      if (!text) return;
      const target = Object.assign({}, this.ctx.selection);
      const targetKey = selectionKey(target);
      this.input.value = '';
      this.input.disabled = true;
      this.send.disabled = true;
      this.appendUser(text);
      const loadingEl = this.appendLoading();
      try {
        const prompt = this.buildPrompt(text, target, targetKey);
        const reply = await this.callProvider(prompt);
        this.firstTurn = false;
        this.lastPromptSelectionKey = targetKey;
        loadingEl.remove();
        const replacement = parseEditBlock(reply);
        if (replacement === null) {
          this.appendError(
            'The model did not return an <<<EDIT>>>...<<</EDIT>>> block. Raw reply:',
            reply
          );
        } else {
          this.lastSuggestion = replacement;
          this.appendDiff(target.text, replacement, target);
        }
      } catch (err) {
        loadingEl.remove();
        this.appendError('Error: ', String(err && err.message ? err.message : err));
      } finally {
        this.input.disabled = false;
        this.send.disabled = false;
        this.input.focus();
      }
    }

    buildPrompt(instruction, selection, targetKey) {
      if (this.firstTurn) return this.buildFirstPrompt(instruction, selection);
      if (this.lastPromptSelectionKey === targetKey) return this.buildRefinePrompt(instruction);
      return this.buildNewSelectionPrompt(instruction, selection);
    }

    buildFirstPrompt(instruction, selection = this.ctx.selection) {
      return [
        'You are editing one selected snippet of a LaTeX document. The full document is provided for context, then the selected snippet, then the user instruction.',
        '',
        'Output rules (strict):',
        '- Output ONLY the replacement text for the selected snippet, nothing else.',
        '- Wrap the replacement between the exact markers <<<EDIT>>> and <<</EDIT>>> on their own lines.',
        '- Do not include backticks, code fences, comments, or explanation outside the markers.',
        '- Preserve LaTeX commands and environments unless the instruction asks otherwise.',
        '- Do not modify content outside the selected snippet.',
        '',
        '=== FULL DOCUMENT ===',
        this.ctx.fullDoc,
        '=== END FULL DOCUMENT ===',
        '',
        '=== SELECTED SNIPPET ===',
        selection.text,
        '=== END SELECTED SNIPPET ===',
        '',
        '=== INSTRUCTION ===',
        instruction,
        '=== END INSTRUCTION ===',
        '',
        'Reply with the replacement only, between <<<EDIT>>> and <<</EDIT>>>.'
      ].join('\n');
    }

    buildNewSelectionPrompt(instruction, selection) {
      return [
        'Continue editing the same LaTeX document from the earlier context.',
        'The user has selected a different snippet. The full document is not repeated; only the newly selected snippet is provided.',
        '',
        'Output rules (strict):',
        '- Output ONLY the replacement text for the selected snippet, nothing else.',
        '- Wrap the replacement between the exact markers <<<EDIT>>> and <<</EDIT>>> on their own lines.',
        '- Do not include backticks, code fences, comments, or explanation outside the markers.',
        '- Preserve LaTeX commands and environments unless the instruction asks otherwise.',
        '- Do not modify content outside the selected snippet.',
        '',
        '=== SELECTED SNIPPET ===',
        selection.text,
        '=== END SELECTED SNIPPET ===',
        '',
        '=== INSTRUCTION ===',
        instruction,
        '=== END INSTRUCTION ===',
        '',
        'Reply with the replacement only, between <<<EDIT>>> and <<</EDIT>>>.'
      ].join('\n');
    }

    buildRefinePrompt(instruction) {
      return [
        'Refine the previous suggested replacement for the same selection in the same LaTeX document.',
        'Same output rules: only the replacement text between <<<EDIT>>> and <<</EDIT>>> markers, nothing else.',
        '',
        'New instruction:',
        instruction
      ].join('\n');
    }

    callProvider(prompt) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'clawverleaf/send', sessionId: SESSION_ID, provider: this.ctx.config.provider, prompt },
          (resp) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || 'no response'));
            resolve(resp.reply);
          }
        );
      });
    }

    appendUser(text) {
      const row = document.createElement('div');
      row.className = 'cw-msg cw-msg-user';
      const bubble = document.createElement('div');
      bubble.className = 'cw-bubble';
      bubble.textContent = text;
      row.appendChild(bubble);
      this.thread.appendChild(row);
      this.thread.scrollTop = this.thread.scrollHeight;
    }

    appendLoading() {
      const row = document.createElement('div');
      row.className = 'cw-msg cw-msg-ai';
      const bubble = document.createElement('div');
      bubble.className = 'cw-bubble cw-loading';
      bubble.innerHTML = '<span class="cw-dot"></span><span class="cw-dot"></span><span class="cw-dot"></span>';
      row.appendChild(bubble);
      this.thread.appendChild(row);
      this.thread.scrollTop = this.thread.scrollHeight;
      return row;
    }

    appendError(label, raw) {
      const row = document.createElement('div');
      row.className = 'cw-msg cw-msg-ai';
      const bubble = document.createElement('div');
      bubble.className = 'cw-bubble cw-error';
      bubble.textContent = label;
      if (raw) {
        const pre = document.createElement('pre');
        pre.textContent = raw;
        bubble.appendChild(pre);
      }
      row.appendChild(bubble);
      this.thread.appendChild(row);
      this.thread.scrollTop = this.thread.scrollHeight;
    }

    appendDiff(before, after, target) {
      const targetKey = selectionKey(target);
      const row = document.createElement('div');
      row.className = 'cw-msg cw-msg-ai';
      const card = document.createElement('div');
      card.className = 'cw-diff-card';

      const head = document.createElement('div');
      head.className = 'cw-diff-head';
      head.textContent = 'Suggested edit';
      card.appendChild(head);

      const diffEl = document.createElement('pre');
      diffEl.className = 'cw-diff';
      renderDiff(before, after, diffEl);
      card.appendChild(diffEl);

      const actions = document.createElement('div');
      actions.className = 'cw-diff-actions';
      const approve = document.createElement('button');
      approve.className = 'cw-btn cw-btn-primary';
      approve.textContent = 'Approve';
      const reject = document.createElement('button');
      reject.className = 'cw-btn';
      reject.textContent = 'Reject';
      actions.appendChild(reject);
      actions.appendChild(approve);
      card.appendChild(actions);

      approve.addEventListener('click', async () => {
        approve.disabled = true;
        reject.disabled = true;
        try {
          await bridge('replaceRange', {
            from: target.from,
            to: target.to,
            text: after
          });
          this.updateStoredDocument(target, after);
          head.textContent = 'Applied';
          card.classList.add('cw-diff-applied');
          if (selectionKey(this.ctx.selection) === targetKey) {
            this.setSelection({
              from: target.from,
              to: target.from + after.length,
              text: after
            });
          }
        } catch (err) {
          this.appendError('Apply failed: ', String(err));
          approve.disabled = false;
          reject.disabled = false;
        }
      });
      reject.addEventListener('click', () => {
        head.textContent = 'Rejected · type a refinement below';
        card.classList.add('cw-diff-rejected');
        approve.disabled = true;
        reject.disabled = true;
        this.input.focus();
      });

      row.appendChild(card);
      this.thread.appendChild(row);
      this.thread.scrollTop = this.thread.scrollHeight;
    }

    updateStoredDocument(target, replacement) {
      if (typeof this.ctx.fullDoc !== 'string') return;
      if (this.ctx.fullDoc.slice(target.from, target.to) !== target.text) return;
      this.ctx.fullDoc = this.ctx.fullDoc.slice(0, target.from) + replacement + this.ctx.fullDoc.slice(target.to);
    }
  }

  function injectPageBridge() {
    const url = chrome.runtime.getURL('src/content/page-bridge.js');
    const s = document.createElement('script');
    s.src = url;
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.addEventListener('load', () => s.remove());
  }

  function bridge(type, extra) {
    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const onMsg = (e) => {
        const m = e.data;
        if (!m || m.source !== 'clawverleaf-bridge-resp' || m.requestId !== requestId) return;
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        if (m.error) reject(new Error(m.error));
        else resolve(m.result);
      };
      window.addEventListener('message', onMsg);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error('bridge timeout'));
      }, 5000);
      window.postMessage(Object.assign({ source: 'clawverleaf-bridge', type, requestId }, extra || {}), '*');
    });
  }

  function flash(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #0d0d0d; color: #ececec; padding: 8px 12px;
      border-radius: 8px; font: 500 13px/1.4 -apple-system, "Segoe UI", Inter, sans-serif;
      z-index: 2147483647; box-shadow: 0 1px 2px rgba(0,0,0,.2);
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  function parseEditBlock(text) {
    if (!text) return null;
    const m = text.match(/<<<EDIT>>>\r?\n?([\s\S]*?)\r?\n?<<<\/EDIT>>>/);
    if (m) return stripTrailingNewline(m[1]);
    const m2 = text.match(/<<<EDIT>>>([\s\S]*?)<<<\/EDIT>>>/);
    if (m2) return stripTrailingNewline(m2[1]);
    return null;
  }

  function stripTrailingNewline(s) {
    return s.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  }

  function selectionKey(selection) {
    return `${selection.from}:${selection.to}:${selection.text}`;
  }

  function tokenize(s) {
    return s.match(/\s+|[A-Za-z0-9]+|_+|[^\s\w]/g) || [];
  }

  function lcsDiff(ta, tb, same) {
    const isSame = same || ((a, b) => a === b);
    const m = ta.length, n = tb.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = isSame(ta[i], tb[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (isSame(ta[i], tb[j])) { out.push({ op: '=', text: ta[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', text: ta[i] }); i++; }
      else { out.push({ op: '+', text: tb[j] }); j++; }
    }
    while (i < m) out.push({ op: '-', text: ta[i++] });
    while (j < n) out.push({ op: '+', text: tb[j++] });
    return out;
  }

  function sameDiffToken(a, b) {
    return a === b && !/^\s+$/.test(a);
  }

  function renderDiff(before, after, container) {
    const al = before.split(/\r?\n/);
    const bl = after.split(/\r?\n/);
    if (al.length + bl.length > 400 || before.length + after.length > 20000) {
      renderLineFallback(before, after, container);
      return;
    }
    const lineDiff = lcsDiff(al, bl);
    let i = 0;
    while (i < lineDiff.length) {
      const cur = lineDiff[i];
      if (cur.op === '=') {
        const row = mkRow('ctx', ' ');
        appendTok(row, cur.text || ' ', 'cw-tok-eq');
        container.appendChild(row);
        i++;
        continue;
      }

      const delLines = [];
      const addLines = [];
      while (i < lineDiff.length && lineDiff[i].op !== '=') {
        if (lineDiff[i].op === '-') delLines.push(lineDiff[i].text);
        else addLines.push(lineDiff[i].text);
        i++;
      }
      renderChangedBlock(delLines, addLines, container);
    }
  }

  function renderChangedBlock(delLines, addLines, container) {
    const delText = delLines.join('\n');
    const addText = addLines.join('\n');
    if (delLines.length && addLines.length) {
      const inner = lcsDiff(tokenize(delText), tokenize(addText), sameDiffToken);
      renderTokenSide(inner, 'del', container);
      renderTokenSide(inner, 'add', container);
      return;
    }

    if (delLines.length) renderTextRows(delText, 'del', 'cw-tok-del', container);
    if (addLines.length) renderTextRows(addText, 'add', 'cw-tok-add', container);
  }

  function renderTokenSide(diff, kind, container) {
    const state = { row: null, kind, container };
    for (const t of diff) {
      if (kind === 'del' && t.op === '+') continue;
      if (kind === 'add' && t.op === '-') continue;
      const changed = t.op !== '=' && !/^\s+$/.test(t.text);
      const cls = changed ? `cw-tok-${kind}` : 'cw-tok-eq';
      appendSegment(state, t.text, cls);
    }
    ensureDiffRow(state);
  }

  function renderTextRows(text, kind, cls, container) {
    const state = { row: null, kind, container };
    for (const part of tokenize(text)) {
      appendSegment(state, part, /^\s+$/.test(part) ? 'cw-tok-eq' : cls);
    }
    ensureDiffRow(state);
  }

  function ensureDiffRow(state) {
    if (!state.row) {
      state.row = mkRow(state.kind, state.kind === 'del' ? '-' : '+');
      state.container.appendChild(state.row);
    }
    return state.row;
  }

  function appendSegment(state, text, cls) {
    const parts = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) state.row = null;
      if (parts[i]) appendTok(ensureDiffRow(state), parts[i], cls);
      else ensureDiffRow(state);
    }
  }

  function mkRow(kind, sigil) {
    const row = document.createElement('span');
    row.className = `cw-diff-line cw-diff-row-${kind}`;
    if (sigil != null) {
      const g = document.createElement('span');
      g.className = 'cw-diff-gutter';
      g.textContent = sigil + ' ';
      row.appendChild(g);
    }
    return row;
  }

  function appendTok(parent, text, cls) {
    if (!text) return;
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    parent.appendChild(s);
  }

  function renderLineFallback(before, after, container) {
    const al = before.split(/\r?\n/);
    const bl = after.split(/\r?\n/);
    const diff = lcsDiff(al, bl);
    for (const line of diff) {
      const kind = line.op === '=' ? 'ctx' : line.op === '-' ? 'del' : 'add';
      const sigil = line.op === '+' ? '+' : line.op === '-' ? '-' : ' ';
      const row = mkRow(kind, sigil);
      const cls = line.op === '=' ? 'cw-tok-eq' : line.op === '-' ? 'cw-tok-del' : 'cw-tok-add';
      appendTok(row, line.text, cls);
      container.appendChild(row);
    }
  }

  function pillCss() {
    return `
      position: absolute;
      display: none;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding: 0 12px;
      background: #0d0d0d;
      color: #ececec;
      border: 1px solid #2a2a2a;
      border-radius: 9999px;
      font: 500 12px/1 -apple-system, "Segoe UI", Inter, sans-serif;
      letter-spacing: 0.01em;
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(0,0,0,.08);
      z-index: 2147483647;
      user-select: none;
    `;
  }

  function panelMarkup() {
    return `
      <style>${panelCss()}</style>
      <div id="cw-panel" part="panel">
        <header id="cw-header">
          <div class="cw-title-block">
            <div class="cw-title">Clawverleaf</div>
            <div id="cw-subtitle" class="cw-subtitle">—</div>
          </div>
          <div class="cw-header-controls">
            <select id="cw-provider" title="Provider">
              <option value="claude-session">Claude (session)</option>
              <option value="claude-api">Claude (API key)</option>
              <option value="chatgpt-session">ChatGPT (session)</option>
              <option value="chatgpt-api">ChatGPT (API key)</option>
              <option value="gemini-session">Gemini (session)</option>
            </select>
            <button id="cw-close" class="cw-iconbtn" title="Close">✕</button>
          </div>
        </header>
        <details class="cw-selection" open>
          <summary>
            <span>Selection</span>
            <span id="cw-selection-meta" class="cw-meta"></span>
          </summary>
          <pre id="cw-selection-preview" class="cw-selection-preview"></pre>
        </details>
        <div id="cw-thread" class="cw-thread"></div>
        <footer class="cw-input-row">
          <textarea id="cw-input" rows="2" placeholder="What change should I make? (Cmd/Ctrl+Enter to send)"></textarea>
          <button id="cw-send" class="cw-btn cw-btn-primary">Send</button>
        </footer>
        <div class="cw-resize cw-resize-n" data-resize="n" title="Resize"></div>
        <div class="cw-resize cw-resize-e" data-resize="e" title="Resize"></div>
        <div class="cw-resize cw-resize-s" data-resize="s" title="Resize"></div>
        <div class="cw-resize cw-resize-w" data-resize="w" title="Resize"></div>
        <div class="cw-resize cw-resize-ne" data-resize="ne" title="Resize"></div>
        <div class="cw-resize cw-resize-se" data-resize="se" title="Resize"></div>
        <div class="cw-resize cw-resize-sw" data-resize="sw" title="Resize"></div>
        <div class="cw-resize cw-resize-nw" data-resize="nw" title="Resize"></div>
      </div>
    `;
  }

  function panelCss() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; }

      #cw-panel {
        pointer-events: auto;
        position: fixed;
        right: 24px;
        bottom: 24px;
        width: min(460px, calc(100vw - 32px));
        height: min(640px, calc(100vh - 48px));
        min-width: 360px;
        min-height: 320px;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: var(--bg);
        color: var(--fg);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.08);
        font: 500 13px/1.5 var(--font-sans);

        --bg: #ffffff;
        --surface: #f7f7f8;
        --border: #e5e5e5;
        --fg: #0d0d0d;
        --muted: #6e6e80;
        --accent: #0d0d0d;
        --accent-fg: #ffffff;
        --add-bg: #effaf2; --add-fg: #0e6b2b; --add-strong: #c8efd5;
        --del-bg: #fdeded; --del-fg: #8b1d1d; --del-strong: #f6c8c8;
        --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      }

      @media (prefers-color-scheme: dark) {
        #cw-panel {
          --bg: #0d0d0d;
          --surface: #171717;
          --border: #2a2a2a;
          --fg: #ececec;
          --muted: #a1a1aa;
          --accent: #ececec;
          --accent-fg: #0d0d0d;
          --add-bg: #122218; --add-fg: #6dd49a; --add-strong: #1f4a30;
          --del-bg: #281616; --del-fg: #f08a8a; --del-strong: #5a2424;
          box-shadow: 0 0 0 1px rgba(255,255,255,.04), 0 12px 32px rgba(0,0,0,.4);
        }
      }

      #cw-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        cursor: grab;
      }
      #cw-header:active { cursor: grabbing; }
      .cw-title { font-weight: 600; letter-spacing: -0.01em; }
      .cw-subtitle { color: var(--muted); font-size: 11px; margin-top: 2px; }
      .cw-header-controls { display: flex; gap: 6px; align-items: center; }

      select, textarea, button {
        font: inherit; color: inherit;
      }
      select {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 4px 6px;
        font-size: 11px;
      }
      .cw-iconbtn {
        background: transparent; border: 1px solid transparent;
        width: 24px; height: 24px; border-radius: 6px;
        cursor: pointer; color: var(--muted);
      }
      .cw-iconbtn:hover { background: var(--surface); color: var(--fg); }

      .cw-selection {
        border-bottom: 1px solid var(--border);
        padding: 8px 12px;
      }
      .cw-selection summary {
        list-style: none;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-size: 11px;
        color: var(--muted);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .cw-selection summary::-webkit-details-marker { display: none; }
      .cw-meta { font-weight: 500; text-transform: none; letter-spacing: 0; }
      .cw-selection-preview {
        margin: 8px 0 0;
        padding: 8px 10px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        font: 12px/1.5 var(--font-mono);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 160px;
        overflow: auto;
      }

      .cw-thread {
        flex: 1;
        overflow: auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .cw-msg { display: flex; }
      .cw-msg-user { justify-content: flex-end; }
      .cw-msg-ai { justify-content: flex-start; min-width: 0; }
      .cw-bubble {
        max-width: 90%;
        padding: 8px 10px;
        border-radius: 10px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cw-msg-user .cw-bubble {
        background: var(--accent);
        color: var(--accent-fg);
      }
      .cw-msg-ai .cw-bubble {
        background: var(--surface);
        border: 1px solid var(--border);
      }
      .cw-error { color: var(--del-fg); }
      .cw-error pre {
        margin-top: 6px;
        font: 11px/1.5 var(--font-mono);
        white-space: pre-wrap;
        max-height: 200px;
        overflow: auto;
        color: var(--fg);
      }

      .cw-loading { display: inline-flex; gap: 4px; align-items: center; padding: 10px 12px; }
      .cw-dot {
        width: 5px; height: 5px; border-radius: 9999px;
        background: var(--muted);
        animation: cw-pulse 1.2s infinite ease-in-out;
      }
      .cw-dot:nth-child(2) { animation-delay: 0.15s; }
      .cw-dot:nth-child(3) { animation-delay: 0.3s; }
      @keyframes cw-pulse {
        0%, 80%, 100% { opacity: 0.25; }
        40% { opacity: 1; }
      }

      .cw-diff-card {
        width: 100%;
        min-width: 0;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
      }
      .cw-diff-head {
        padding: 8px 12px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
        border-bottom: 1px solid var(--border);
      }
      .cw-diff {
        margin: 0;
        padding: 8px 0;
        background: var(--bg);
        font: 12px/1.55 var(--font-mono);
        max-height: 320px;
        overflow: auto;
        white-space: pre-wrap;
      }
      .cw-diff-line {
        display: block;
        padding: 1px 12px;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--fg);
      }
      .cw-diff-row-ctx { color: var(--muted); }
      .cw-diff-row-del { background: var(--del-bg); }
      .cw-diff-row-add { background: var(--add-bg); }
      .cw-diff-gutter {
        color: var(--muted);
        user-select: none;
        -webkit-user-select: none;
        margin-right: 2px;
        font-weight: 600;
      }
      .cw-tok-eq { color: var(--muted); }
      .cw-diff-row-del .cw-tok-eq, .cw-diff-row-add .cw-tok-eq { color: var(--fg); opacity: 0.55; }
      .cw-tok-del {
        background: var(--del-strong);
        color: var(--del-fg);
        border-radius: 3px;
        padding: 0 2px;
        font-weight: 700;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }
      .cw-tok-add {
        background: var(--add-strong);
        color: var(--add-fg);
        border-radius: 3px;
        padding: 0 2px;
        font-weight: 700;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
      }

      .cw-diff-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        padding: 8px 10px;
        border-top: 1px solid var(--border);
      }
      .cw-diff-applied { opacity: 0.6; }
      .cw-diff-rejected .cw-diff { opacity: 0.5; }

      .cw-btn {
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--bg);
        color: var(--fg);
        cursor: pointer;
        font-weight: 500;
        font-size: 12px;
      }
      .cw-btn:hover { background: var(--surface); }
      .cw-btn[disabled] { opacity: 0.5; cursor: default; }
      .cw-btn-primary {
        background: var(--accent);
        color: var(--accent-fg);
        border-color: var(--accent);
      }
      .cw-btn-primary:hover { opacity: 0.9; background: var(--accent); }

      .cw-resize {
        position: absolute;
        z-index: 3;
      }
      .cw-resize-n {
        top: 0;
        left: 14px;
        right: 14px;
        height: 8px;
        cursor: ns-resize;
      }
      .cw-resize-e {
        top: 14px;
        right: 0;
        bottom: 14px;
        width: 8px;
        cursor: ew-resize;
      }
      .cw-resize-s {
        left: 14px;
        right: 14px;
        bottom: 0;
        height: 8px;
        cursor: ns-resize;
      }
      .cw-resize-w {
        top: 14px;
        left: 0;
        bottom: 14px;
        width: 8px;
        cursor: ew-resize;
      }
      .cw-resize-ne, .cw-resize-se, .cw-resize-sw, .cw-resize-nw {
        width: 16px;
        height: 16px;
      }
      .cw-resize-ne {
        top: 0;
        right: 0;
        cursor: nesw-resize;
      }
      .cw-resize-se {
        right: 0;
        bottom: 0;
        cursor: nwse-resize;
      }
      .cw-resize-sw {
        left: 0;
        bottom: 0;
        cursor: nesw-resize;
      }
      .cw-resize-nw {
        top: 0;
        left: 0;
        cursor: nwse-resize;
      }
      .cw-resize-se::after {
        content: "";
        position: absolute;
        right: 4px;
        bottom: 4px;
        width: 8px;
        height: 8px;
        border-right: 2px solid var(--muted);
        border-bottom: 2px solid var(--muted);
        opacity: 0.8;
      }

      .cw-input-row {
        display: flex;
        gap: 8px;
        padding: 10px 12px;
        border-top: 1px solid var(--border);
        align-items: flex-end;
      }
      textarea#cw-input {
        flex: 1;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px 10px;
        resize: vertical;
        min-height: 36px;
        max-height: 140px;
        font: 13px/1.5 var(--font-sans);
        outline: none;
      }
      textarea#cw-input:focus { border-color: var(--fg); }
    `;
  }
})();
