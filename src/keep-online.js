// @@MODULE keep-online
// Keeps the game socket alive while the tab is hidden. The game's own dead-socket watchdog (every 2 s) and its new-build
// check act only while document.visibilityState is "visible", so a hidden tab with a half-open socket stays offline until
// you come back. This makes the page report "visible" to the game: document.hidden is false and visibilityState is
// "visible" (own properties on the document; the native getters stay on Document.prototype).
// visibilitychange is not blocked. After install, one bubbling visibilitychange is dispatched, so listeners that read the
// state at startup (Supabase auto-refresh, which starts only when visible) check again.
// Off: the own properties are removed and one visibilitychange is dispatched, so everything re-reads the real state.
//   keepOnline.set(true | false)   keepOnline.status()   // the switch; the socket gap and reconnects seen while hidden
// Saved in this browser (idc.keepOnline), on by default. Settings export/import carry it.
try {
  (() => {
    const W = typeof window !== 'undefined' ? window : globalThis;
    const core = W.idleCore;
    if (!core) throw new Error('the shared core did not load');
    const HAS_DOM = typeof document !== 'undefined' && !!document.body;
    const saved = core.settings('idc.keepOnline');
    const TAG = 'KO';
    const GAP_LOG_MS = 30000;
    if (W.keepOnline?._unload) W.keepOnline._unload();

    const s0 = saved.load();
    let on = typeof s0?.on === 'boolean' ? s0.on : true;

    // Socket watch: the longest stretch without a new text frame, and how often the game replaced its socket.
    const watch = { count: -1, changedAt: Date.now(), longestGapMs: 0, ws: null, reconnects: 0, logged: false };
    function check() {
      const s = core.sock, now = Date.now();
      if (s.textMsgs !== watch.count) { watch.count = s.textMsgs; watch.changedAt = now; watch.logged = false; }
      else {
        const gap = now - watch.changedAt;
        if (gap > watch.longestGapMs) watch.longestGapMs = gap;
        if (gap > GAP_LOG_MS && !watch.logged) { watch.logged = true; core.ledger.add(TAG, 'info', 'no game frame for ' + Math.round(gap / 1000) + ' s'); }
      }
      if (s.ws !== watch.ws) { if (watch.ws) watch.reconnects++; watch.ws = s.ws; }
    }
    const stopWatch = core.every(5000, check);

    // The spoof. Off removes the own properties; either way one bubbling visibilitychange goes out, so listeners re-read the state.
    function applySpoof(enable) {
      if (!HAS_DOM) return;
      if (enable) {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      } else {
        delete document.hidden;
        delete document.visibilityState;
      }
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    }

    function set(v) {
      on = !!v;
      saved.save({ on });
      applySpoof(on);
      core.ledger.add(TAG, 'info', 'keep online ' + (on ? 'on: the game sees the tab as visible' : 'off: the tab reports its real visibility'));
      return on;
    }
    function status() {
      check();
      return { on, realHidden: core.realHidden(), link: core.link().state, longestGapMs: watch.longestGapMs, reconnects: watch.reconnects };
    }

    if (on) applySpoof(true);
    W.keepOnline = {
      set, status,
      get on() { return on; },
      exportCfg: () => ({ on }),
      importCfg(o) {
        if (typeof o?.on !== 'boolean') return { applied: [], skipped: ['on'] };
        set(o.on);
        return { applied: ['on'], skipped: [] };
      },
      _unload() {
        stopWatch();
        if (HAS_DOM) { delete document.hidden; delete document.visibilityState; }
      },
    };
    console.log('[keepOnline] ready: ' + (on ? 'on (the game sees the tab as visible)' : 'off') + '. keepOnline.set(true|false), keepOnline.status()');
  })();
} catch (e) { console.error('[IdleCorp] keep-online failed to load:', e); }
// @@END keep-online
