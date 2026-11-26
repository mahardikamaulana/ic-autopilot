// ============================================================================
// 0. SHARED CORE (window.idleCore)
// ============================================================================
// What the modules need: one cached walk of the game's React state, one socket listener
// (command confirmation + server tick), confirm-waiting, the activity ledger, alerts, the stop-all
// hotkey (Alt+Shift+X) and config export / import. Each module below still loads on its own.
// @@MODULE core
try {
  (() => {
    const W = typeof window !== 'undefined' ? window : globalThis;
    const HAS_DOM = typeof document !== 'undefined' && !!document.body;
    if (W.idleCore?._unload) W.idleCore._unload();
    const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
    // Chrome may run timers in a tab hidden 5+ minutes only once a minute, but socket messages (2 ticks/s) still
    // arrive, so every message also fires the timers that are due. after() is setTimeout with that rescue.
    const due = new Set();
    function after(ms, fn) {
      const d = { at: Date.now() + ms, fn: () => { clearTimeout(t); due.delete(d); fn(); } };
      const t = setTimeout(d.fn, ms);
      due.add(d);
      return () => { clearTimeout(t); due.delete(d); };
    }
    function runDue() { const now = Date.now(); for (const d of due) if (now >= d.at) { try { d.fn(); } catch (e) { console.error('[idleCore]', e); } } }
    const sleep = (ms) => new Promise((r) => after(ms, r));
    // setInterval with the same rescue; returns a stop function.
    function every(ms, fn) { let stop = null; const run = () => { stop = after(ms, run); fn(); }; stop = after(ms, run); return () => stop(); }
    let unloaded = false;

    // ---- game state: one walk of the React fiber tree --------------------------
    // Fibers are double-buffered and the state object is replaced on every update, so nothing
    // from the tree is kept: the result is only reused for WALK_TTL ms. Anything that sends a
    // command, or waits for the server to apply one, passes fresh = true.
    const WALK_TTL = 120;
    let walkOut = null, walkAt = 0;
    function walk(fresh = false) {
      const now = Date.now();
      if (!fresh && walkOut && now - walkAt < WALK_TTL) return walkOut;
      const out = { ws: null, st: null, catalog: null, deals: null, orders: null, engine: null, contracts: null, boardFilters: null, board: null };
      if (!HAS_DOM) return out;
      const root = document.getElementById('root');
      const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer'));
      if (!key) return out;
      const seen = new Set(), stack = [root[key]];
      while (stack.length) {
        const f = stack.pop();
        if (!f || seen.has(f)) continue;
        seen.add(f);
        let h = f.memoizedState, n = 0, hasWs = false, map = null;
        while (h && n < 50) {
          const v = h.memoizedState;
          if (v && v.current instanceof WebSocket) { out.ws = v.current; hasWs = true; }
          if (v && v.current instanceof Map) map = v.current;
          if (v && typeof v === 'object' && v.groups && v.stock && v.ssi) out.st = v;
          if (Array.isArray(v) && v[0] && v[0].side) {
            if (v[0].price !== undefined && v[0].poster === undefined) out.deals = v;
            else if (v[0].unit_price !== undefined && v[0].poster !== undefined) out.orders = v;
          }
          h = h.next; n++;
        }
        if (hasWs && map) out.boardFilters = map;   // the game's board filters (re-sent on every reconnect), a ref next to the socket's
        const p = f.memoizedProps;
        if (p && p.value?.setBoardFilter && p.value.deliveries && !out.board) out.board = p.value;   // { truncated, deliveries } per board
        if (p && p.catalog?.techs && !out.catalog) out.catalog = p.catalog;
        if (p && p.engine && typeof p.engine.evaluateLayout === 'function' && !out.engine) out.engine = p.engine;
        if (p && Array.isArray(p.contracts) && !out.contracts) out.contracts = p.contracts;
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
      walkOut = out; walkAt = now;
      if (out.ws?.readyState === 1) attach(out.ws, out);
      return out;
    }

    // ---- socket listener ----------------------------------------------------------
    // muts counts Diffs that carry a newer ssi.last_user_mutation_tick, i.e. the server applying
    // one of the player's commands (not production updates).
    // sendAt / ackAt: performance.now() at ws.send and when the first player-mutation Diff after it arrived
    // (sub-millisecond, unlike the confirm poll): their difference is the command's round trip.
    const sock = { ws: null, textMsgs: 0, diffs: 0, muts: 0, mutTick: 0, tick: 0, tickAt: 0, sendAt: 0, ackAt: 0, resyncing: false };
    const hrNow = () => globalThis.performance?.now?.() ?? Date.now();
    const wakers = new Set();
    function seeTick(t) { if (typeof t === 'number' && t > sock.tick) { sock.tick = t; sock.tickAt = Date.now(); } }
    function onMessage(e) {
      runDue();
      if (typeof e.data !== 'string') return;
      sock.textMsgs++;
      try {
        const m = JSON.parse(e.data);
        seeTick(m.tick ?? m.diff?.tick);
        if (m.kind === 'Diff') sock.diffs++;
        if (m.kind === 'Snapshot') sock.resyncing = false;
        if (m.kind === 'WorldEvents') sock.worldEvents = { raw: e.data, at: Date.now() };   // plan D5: kept for a readout only, nothing acts on it
        const u = m.diff?.ssi?.last_user_mutation_tick;
        if (typeof u === 'number' && u > sock.mutTick) { sock.mutTick = u; sock.muts++; if (sock.sendAt && !sock.ackAt) sock.ackAt = hrNow(); for (const w of [...wakers]) w(); }
        if (m.kind === 'Orders') Object.assign(sock.book, { at: Date.now(), pending: Math.max(0, sock.book.pending - 1), truncated: !!m.truncated });
      } catch { }
    }
    // ---- player order book ---------------------------------------------------------------
    // The server sends other players' orders only while this socket has an "Orders" board filter: the game
    // sets one while its Goods tab is open and null when it closes (the reply then holds only your own orders).
    // sock.book: the last Orders filter sent on this socket (by the game or by us, seen through a send hook),
    // whether we sent it, and when the reply came. Replies don't say which filter they answer, but each filter gets
    // exactly one (seen live), so pending counts filters not answered yet. The game re-sends its filters in onopen,
    // before we attach, so a new socket starts from the game's own store: its filter, answered if it counted a reply.
    const newBook = (g) => {
      const f = g?.boardFilters?.get('Orders') ?? null;
      return { filter: f, filterAt: 1, ours: false, pending: 0, at: f && g.board?.deliveries?.Orders > 0 ? 1 : 0, truncated: !!g?.board?.truncated?.Orders };
    };
    sock.book = newBook();
    let baseSend = null, sendingOurs = false;
    function hookSend(d) {
      if (typeof d === 'string' && d.includes('"Resync"')) sock.resyncing = true;
      if (typeof d === 'string' && d.includes('"SetBoardFilter"')) {
        try { const m = JSON.parse(d); if (m.board === 'Orders') Object.assign(sock.book, { filter: m.filter ?? null, filterAt: Date.now(), ours: sendingOurs, pending: sock.book.pending + 1 }); } catch { }
      }
      return baseSend.call(this, d);
    }
    function attach(ws, g) {
      if (ws === sock.ws) return;
      sock.ws?.removeEventListener('message', onMessage);
      if (sock.ws?.send === hookSend) sock.ws.send = baseSend;
      sock.ws = ws; sock.book = newBook(g);
      sock.resyncing = false;
      ws?.addEventListener('message', onMessage);
      if (ws && typeof ws.send === 'function') { baseSend = ws.send; ws.send = hookSend; }
    }
    const BOOK_IDLE_MS = 60000;   // well above Autopilot's longest idle sleep (maxIdleMs), so it can't drop between cycles
    const BOOK_SETTLE_MS = 200;
    let bookTimer = 0;
    const onGoodsTab = () => /^\/market\/goods/.test(W.location?.pathname ?? '');
    const orderBook = {
      // Loaded: the current filter shows every item in `region` (a Goods tab narrowed to some items or on another
      // region does not count) and its untruncated reply came at least BOOK_SETTLE_MS ago (the game puts it into its
      // React state on the next render). It may hold only your own orders, or none. A reply missing for 30 s no longer blocks.
      live(region) {
        const b = sock.book, f = b.filter;
        return !!f && b.at >= b.filterAt && Date.now() - b.at >= BOOK_SETTLE_MS && (!b.pending || Date.now() - b.filterAt > 30000) && !b.truncated && !f.items?.length && !f.sides?.length && !f.nums?.length && !f.quirks?.length
          && (!f.regions?.length || f.regions.includes(region));
      },
      // Autopilot wants prices: subscribe like the Goods tab with no filters, unless any filter is set (the game's
      // stays untouched) or the Goods tab is open (it owns the board, also right after a reconnect).
      need(region) {
        const ws = sock.ws;
        if (!ws || ws.readyState !== 1 || unloaded) return;
        if (!sock.book.filter && !onGoodsTab()) {
          sendingOurs = true;
          try { ws.send(JSON.stringify({ type: 'SetBoardFilter', board: 'Orders', filter: { items: [], sides: [], regions: [region], utilities: [], quirks: [], nums: [] } })); }
          finally { sendingOurs = false; }
        }
        clearTimeout(bookTimer); bookTimer = setTimeout(orderBook.release, BOOK_IDLE_MS);
      },
      // Drop our filter once nothing needs it (only ours, and only while it is still the current one).
      release() {
        clearTimeout(bookTimer);
        const ws = sock.ws;
        if (sock.book.ours && sock.book.filter && ws?.readyState === 1 && !onGoodsTab()) ws.send(JSON.stringify({ type: 'SetBoardFilter', board: 'Orders', filter: null }));
      },
    };
    // Server tick now: last tick seen plus elapsed time (2 ticks/s), so checks work between messages.
    const nowTick = () => (sock.tick ? sock.tick + Math.floor((Date.now() - sock.tickAt) / 500) : 0);
    // Call right before ws.send: only a later mutation confirms this command. Returns the Diff count to wait past.
    function markSend(stMutTick) { sock.mutTick = Math.max(sock.mutTick, stMutTick || 0); sock.sendAt = hrNow(); sock.ackAt = 0; return sock.muts; }
    // Round trip of the last marked command in ms (float), or null while its acknowledgement has not been seen.
    const lastRtt = () => (sock.sendAt && sock.ackAt >= sock.sendAt ? sock.ackAt - sock.sendAt : null);
    // What the tab really reports, even while keep-online spoofs document.hidden.
    const realHidden = () => { try { return Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get.call(document); } catch { return !!document.hidden; } };
    // The game socket as the modules see it: 'closed', 'resyncing' (a Resync was sent and no Snapshot came back yet) or 'open'.
    const link = () => ({ state: !sock.ws || sock.ws.readyState !== 1 ? 'closed' : sock.resyncing ? 'resyncing' : 'open' });
    // Sleep that ends early when the server applies a player command (yours, or one you click yourself).
    function sleepWake(ms) {
      return new Promise((res) => {
        const done = () => { cancel(); wakers.delete(done); res(); };
        const cancel = after(ms, done);
        wakers.add(done);
      });
    }

    // Waits until the server has applied a player command after this one was sent AND pred(state)
    // holds. The client applies commands locally first, and production Diffs arrive on their own, so
    // neither alone is proof. If the socket has never delivered a text frame the acknowledgement
    // can't be seen at all (e.g. the game moved to binary frames): then the state must hold steadily
    // for STEADY_MS instead of passing on the first look, and the first time is logged.
    const tune = { steadyMs: 1500, pollMs: 100 };   // tests shorten both: the steady hold and the poll step
    let warnedBlind = false;
    async function waitConfirm({ read, pred, d0, timeoutMs, closed }) {
      const t0 = Date.now();
      let okSince = 0;
      while (Date.now() - t0 < timeoutMs) {
        const r = read(true);
        if (!r || !r.wsOpen) closed();
        if (r && pred(r)) {
          if (sock.textMsgs > 0) { if (sock.muts > d0) return r; }
          else {
            okSince ||= Date.now();
            if (Date.now() - okSince >= tune.steadyMs) {
              if (!warnedBlind) { warnedBlind = true; console.warn('[idleCore] no text frames seen on the game socket: confirming from state alone (held for ' + tune.steadyMs + ' ms)'); }
              return r;
            }
          }
        } else okSince = 0;
        await sleep(tune.pollMs);
      }
      return null;
    }

    // ---- DOM helpers ----------------------------------------------------------------
    const h = (tag, props = {}, ...kids) => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v);
      }
      el.append(...kids);
      return el;
    };
    function makeDraggable(handle, getPanel, ui, place, saveUi) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button') || getPanel().classList.contains('idc-docked')) return;   // a docked panel stays put
        const r = getPanel().getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => { ui.x = ev.clientX - dx; ui.y = ev.clientY - dy; place(); };
        const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); saveUi(); };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });
    }
    // Toasts: up to 3 stacked, pause while hovered, optional action (Undo). opts: 'info' | 'success' | 'error' or { kind, undo }.
    let toastBox = null;
    const toasts = [];
    function toast(text, opts) {
      const o = typeof opts === 'string' ? { kind: opts } : opts || {};
      console.log('[idleCore] ' + text);
      if (!HAS_DOM || unloaded) return;
      ensureStyle();
      if (!toastBox || !toastBox.isConnected) { toastBox = h('div', { class: 'idc-toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); toasts.length = 0; }
      const t = { el: null, timer: 0 };
      const dismiss = () => { clearTimeout(t.timer); t.el.remove(); const i = toasts.indexOf(t); if (i >= 0) toasts.splice(i, 1); };
      const arm = (ms) => { clearTimeout(t.timer); t.timer = setTimeout(dismiss, ms); };
      const act = o.undo ? [h('button', { type: 'button', onclick: () => { dismiss(); o.undo(); } }, 'Undo')] : [];
      t.el = h('div', { class: 'idc-toast k-' + (o.kind || 'info') }, h('span', {}, text), ...act);
      for (const [on, off] of [['mouseenter', 'mouseleave'], ['focusin', 'focusout']]) {   // hovered or keyboard-focused: stay
        t.el.addEventListener(on, () => clearTimeout(t.timer));
        t.el.addEventListener(off, () => arm(1500));
      }
      toastBox.append(t.el);
      toasts.push(t);
      while (toasts.length > 3) { const old = toasts[0]; clearTimeout(old.timer); old.el.remove(); toasts.shift(); }
      arm(o.undo ? 7000 : 3500);
    }

    // ---- ledger: what the modules did, kept across reloads ------------------------------
    const LEDGER_KEY = 'idleCore.ledger.v1', LEDGER_MAX = 300;
    let ledger = [];
    try { const l = JSON.parse(store?.getItem(LEDGER_KEY) || '[]'); if (Array.isArray(l)) ledger = l.slice(-LEDGER_MAX); } catch { }
    let ledgerTimer = 0, ledgerRev = 0;
    const flushLedger = () => { ledgerTimer = 0; try { store?.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch { } };
    const ledgerApi = {
      // mod: 'AP' | 'CD' | 'LAB'; kind: 'action' | 'fail' | 'info' | 'alert'; extra: { money (cents or $ — whatever the module logs), ok }
      add(mod, kind, text, extra = {}) {
        ledgerRev++;
        ledger.push({ t: Date.now(), mod, kind, text: String(text).slice(0, 240), ...extra });
        if (ledger.length > LEDGER_MAX) ledger.splice(0, ledger.length - LEDGER_MAX);
        if (!ledgerTimer) ledgerTimer = setTimeout(flushLedger, 2000);
      },
      list: () => ledger.slice(),
      clear() { ledgerRev++; ledger = []; flushLedger(); },
      // Puts lines taken out by clear() back in front of whatever was logged since (the Undo for Clear log).
      restore(list) { ledgerRev++; ledger = list.concat(ledger).slice(-LEDGER_MAX); flushLedger(); },
      rev: () => ledgerRev,
      text: () => ledger.map((e) => new Date(e.t).toISOString() + ' ' + e.mod + ' ' + e.kind + ' ' + e.text + (e.dMoney != null ? ' (' + (e.dMoney >= 0 ? '+$' : '-$') + Math.abs(e.dMoney).toLocaleString('en-US') + ')' : '')).join('\n'),
      async copy() {
        const t = ledgerApi.text();
        try { await navigator.clipboard.writeText(t); toast('Copied ' + ledger.length + ' log lines', 'success'); return true; }
        catch { console.log(t); toast('Clipboard blocked: the log is in the console', 'error'); return false; }
      },
    };

    // ---- alerts: tab title badge + desktop notification when the tab is hidden ----------------
    const badges = new Map();
    const TITLE_RE = /^⚠ [^·]*· /;
    function applyTitle() {
      if (!HAS_DOM || unloaded) return;
      const base = document.title.replace(TITLE_RE, '');
      const want = badges.size ? '⚠ ' + [...badges.values()].join(', ') + ' · ' + base : base;
      if (document.title !== want) document.title = want;
    }
    function setBadge(mod, text) { if (text) badges.set(mod, text); else badges.delete(mod); applyTitle(); }
    const notifyPerm = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
    async function askNotify() {
      if (typeof Notification === 'undefined') return 'unsupported';
      try { return await Notification.requestPermission(); } catch { return 'denied'; }
    }
    function notify(mod, title, body = '') {
      ledgerApi.add(mod, 'alert', title + (body ? ': ' + body : ''));
      if (HAS_DOM && notifyPerm() === 'granted' && realHidden()) {
        try { new Notification(title, { body, tag: 'idlecorp-' + mod }); } catch { }
      }
    }

    // ---- stop everything (Alt+Shift+X) ------------------------------------------------------
    function stopAll(why = 'stop-all') {
      const live = [];
      try { if (W.earlyGame?.running) { W.earlyGame.stop(); live.push('Autopilot'); } } catch (e) { console.error(e); }
      try { if (W.cdFarm?.running) { W.cdFarm.stop(); live.push('CD Farm'); } else if (W.cdFarm?.pauseAuto?.()) live.push('CD Farm Auto'); } catch (e) { console.error(e); }
      try { if (W.corePlan?.running) { W.corePlan.stop(); live.push('Core plan'); } } catch (e) { console.error(e); }
      try { if (W.labRunner?.running) { W.labRunner.stop(); live.push('Lab'); } } catch (e) { console.error(e); }
      try { if (W.autoSell?.running) { W.autoSell.stop(); live.push('Auto ship'); } } catch (e) { console.error(e); }
      try { if (W.autoUtil?.running) { W.autoUtil.stop(); live.push('Auto utilities'); } } catch (e) { console.error(e); }
      ledgerApi.add('--', 'info', 'stop all (' + why + '): ' + (live.join(' + ') || 'nothing was running'));
      toast(live.length ? 'Stopped ' + live.join(' + ') + ' (' + why + ')' : 'Nothing was running');
      return live;
    }
    const onKey = (e) => { if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyX') { e.preventDefault(); stopAll('Alt+Shift+X'); } };
    if (HAS_DOM) addEventListener('keydown', onKey, true);

    // ---- config export / import ---------------------------------------------------------------
    // Each module offers exportCfg() / importCfg(obj); Infinity travels as the string "Infinity".
    const rep = (_k, v) => (v === Infinity ? 'Infinity' : v);
    const rev = (_k, v) => (v === 'Infinity' ? Infinity : v);
    const MODS = ['earlyGame', 'cdFarm', 'labRunner', 'autoUtil', 'corePlan', 'keepOnline'];
    function exportConfig() {
      const out = { app: 'idlecorp-toolkit', format: 1, exportedAt: new Date().toISOString() };
      for (const m of MODS) out[m] = W[m]?.exportCfg?.() ?? null;
      return JSON.stringify(out, rep, 2);
    }
    function importConfig(text) {
      let o;
      try { o = JSON.parse(text, rev); } catch { throw new Error('not valid JSON'); }
      if (!o || o.app !== 'idlecorp-toolkit' || o.format !== 1) throw new Error('not an IdleCorp Toolkit export');
      const report = [];
      for (const m of MODS) {
        if (!o[m]) continue;
        if (!W[m]?.importCfg) { report.push(m + ': module not loaded, skipped'); continue; }
        const r = W[m].importCfg(o[m]);
        report.push(m + ': ' + r.applied.length + ' applied' + (r.skipped.length ? ', skipped ' + r.skipped.join(', ') : ''));
      }
      return report.join(' · ');
    }
    function download(name, text) {
      const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    function exportFile() { download('idlecorp-toolkit-' + new Date().toISOString().slice(0, 10) + '.json', exportConfig()); toast('Exported settings', 'success'); }
    function importFile() {
      const input = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
      input.addEventListener('change', async () => {
        try { toast('Imported — ' + importConfig(await input.files[0].text()), 'success'); }
        catch (e) { toast('Import failed: ' + e.message, 'error'); }
        input.remove();
      });
      document.body.append(input); input.click();
    }

    // Required-field check for the game's state objects: [] when everything is there.
    function missingFields(obj, paths) {
      return paths.filter((p) => { let v = obj; for (const k of p.split('.')) { v = v?.[k]; if (v === undefined || v === null) return true; } return false; });
    }

