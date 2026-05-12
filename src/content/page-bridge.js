(function () {
  if (window.__clawverleafBridgeInstalled) return;
  window.__clawverleafBridgeInstalled = true;

  function findEditorView() {
    const nodes = document.querySelectorAll('.cm-content');
    for (const el of nodes) {
      if (el.cmView && el.cmView.view) return el.cmView.view;
      if (el.parentElement && el.parentElement.cmView && el.parentElement.cmView.view) {
        return el.parentElement.cmView.view;
      }
    }
    return null;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.source !== 'clawverleaf-bridge' || e.source !== window) return;
    const reply = (payload) => {
      window.postMessage(
        Object.assign({ source: 'clawverleaf-bridge-resp', requestId: m.requestId }, payload),
        '*'
      );
    };
    try {
      const view = findEditorView();
      if (!view) return reply({ error: 'editor-not-found' });

      if (m.type === 'getDoc') {
        return reply({ result: view.state.doc.toString() });
      }
      if (m.type === 'getSelection') {
        const r = view.state.selection.main;
        return reply({
          result: {
            from: r.from,
            to: r.to,
            text: view.state.sliceDoc(r.from, r.to)
          }
        });
      }
      if (m.type === 'replaceRange') {
        view.dispatch({ changes: { from: m.from, to: m.to, insert: m.text } });
        view.focus();
        return reply({ result: true });
      }
      reply({ error: 'unknown-type' });
    } catch (err) {
      reply({ error: String(err && err.message ? err.message : err) });
    }
  });
})();
