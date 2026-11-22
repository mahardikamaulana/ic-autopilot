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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    const out = { ws: null, st: null, catalog: null, deals: null, orders: null, engine: null, contracts: null };
    if (!HAS_DOM) return out;
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer'));
    if (!key) return out;
    const seen = new Set(), stack = [root[key]];
    while (stack.length) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      let h = f.memoizedState, n = 0;
      while (h && n < 50) {
        const v = h.memoizedState;
        if (v && v.current instanceof WebSocket) out.ws = v.current;
        if (v && typeof v === 'object' && v.groups && v.stock && v.ssi) out.st = v;
        if (Array.isArray(v) && v[0] && v[0].side) {
          if (v[0].price !== undefined && v[0].poster === undefined) out.deals = v;
          else if (v[0].unit_price !== undefined && v[0].poster !== undefined) out.orders = v;
        }
        h = h.next; n++;
      }
      const p = f.memoizedProps;
      if (p && p.catalog?.techs && !out.catalog) out.catalog = p.catalog;
      if (p && p.engine && typeof p.engine.evaluateLayout === 'function' && !out.engine) out.engine = p.engine;
      if (p && Array.isArray(p.contracts) && !out.contracts) out.contracts = p.contracts;
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    walkOut = out; walkAt = now;
    if (out.ws?.readyState === 1) attach(out.ws);
    return out;
  }

  // ---- socket listener ----------------------------------------------------------
  // muts counts Diffs that carry a newer ssi.last_user_mutation_tick, i.e. the server applying
  // one of the player's commands (not production updates).
  const sock = { ws: null, textMsgs: 0, diffs: 0, muts: 0, mutTick: 0, tick: 0, tickAt: 0 };
  const wakers = new Set();
  function seeTick(t) { if (typeof t === 'number' && t > sock.tick) { sock.tick = t; sock.tickAt = Date.now(); } }
  function onMessage(e) {
    if (typeof e.data !== 'string') return;
    sock.textMsgs++;
    try {
      const m = JSON.parse(e.data);
      seeTick(m.tick ?? m.diff?.tick);
      if (m.kind === 'Diff') sock.diffs++;
      const u = m.diff?.ssi?.last_user_mutation_tick;
      if (typeof u === 'number' && u > sock.mutTick) { sock.mutTick = u; sock.muts++; for (const w of [...wakers]) w(); }
    } catch {}
  }
  function attach(ws) {
    if (ws === sock.ws) return;
    sock.ws?.removeEventListener('message', onMessage);
    sock.ws = ws;
    ws?.addEventListener('message', onMessage);
  }
  // Server tick now: last tick seen plus elapsed time (2 ticks/s), so checks work between messages.
  const nowTick = () => (sock.tick ? sock.tick + Math.floor((Date.now() - sock.tickAt) / 500) : 0);
  // Call right before ws.send: only a later mutation confirms this command. Returns the Diff count to wait past.
  function markSend(stMutTick) { sock.mutTick = Math.max(sock.mutTick, stMutTick || 0); return sock.muts; }
  // Sleep that ends early when the server applies a player command (yours, or one you click yourself).
  function sleepWake(ms) {
    return new Promise((res) => {
      const done = () => { clearTimeout(t); wakers.delete(done); res(); };
      const t = setTimeout(done, ms);
      wakers.add(done);
    });
  }

  // Waits until the server has applied a player command after this one was sent AND pred(state)
  // holds. The client applies commands locally first, and production Diffs arrive on their own, so
  // neither alone is proof. If the socket has never delivered a text frame the acknowledgement
  // can't be seen at all (e.g. the game moved to binary frames): then the state must hold steadily
  // for STEADY_MS instead of passing on the first look, and the first time is logged.
  const STEADY_MS = 1500;
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
          if (Date.now() - okSince >= STEADY_MS) {
            if (!warnedBlind) { warnedBlind = true; console.warn('[idleCore] no text frames seen on the game socket: confirming from state alone (held for ' + STEADY_MS + ' ms)'); }
            return r;
          }
        }
      } else okSince = 0;
      await sleep(100);
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
      if (e.target.closest('button')) return;
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
  try { const l = JSON.parse(store?.getItem(LEDGER_KEY) || '[]'); if (Array.isArray(l)) ledger = l.slice(-LEDGER_MAX); } catch {}
  let ledgerTimer = 0, ledgerRev = 0;
  const flushLedger = () => { ledgerTimer = 0; try { store?.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch {} };
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
    if (HAS_DOM && notifyPerm() === 'granted' && document.hidden) {
      try { new Notification(title, { body, tag: 'idlecorp-' + mod }); } catch {}
    }
  }

  // ---- stop everything (Alt+Shift+X) ------------------------------------------------------
  function stopAll(why = 'stop-all') {
    const live = [];
    try { if (W.earlyGame?.running) { W.earlyGame.stop(); live.push('Autopilot'); } } catch (e) { console.error(e); }
    try { if (W.cdFarm?.running) { W.cdFarm.stop(); live.push('CD Farm'); } } catch (e) { console.error(e); }
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
  const MODS = ['earlyGame', 'cdFarm', 'labRunner', 'autoUtil'];
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

  // ---- UI kit (core.ui): one stylesheet, panel shell, tabs, sidebar tab + top-bar chip, log view -------------
  // Both modules build their panels from this; each keeps only its own content and settings.
  const UI_CSS = `
.idc-panel,.idc-toasts{--idc-muted:color-mix(in srgb,var(--muted,#808086),#fff 18%);--idc-focus:var(--accent,#5b8def)}
.idc-panel{position:fixed;z-index:9999;display:flex;flex-direction:column;width:340px;max-width:calc(100vw - 32px);max-height:calc(100vh - 40px);overflow:auto;background:var(--surface,#151517);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px;box-shadow:var(--shadow,0 4px 16px rgba(0,0,0,.4));color:var(--ink,#ededee);font:13px/1.5 "Inter Variable",system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}
.idc-panel:focus{outline:none}
.idc-panel :focus-visible,.idc-chip:focus-visible,.idc-tab:focus-visible,.idc-toasts :focus-visible{outline:2px solid var(--idc-focus);outline-offset:1px}
.idc-panel [hidden],.idc-pill[hidden],.idc-toasts [hidden]{display:none!important}
.idc-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 8px 10px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.09));cursor:move;user-select:none}
.idc-panel.min .idc-head{border-bottom-color:transparent}
.idc-title{flex:1;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.idc-panel button.idc-ib{flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;background:transparent;color:var(--idc-muted)}
.idc-panel button.idc-ib:hover{background:var(--surface-2,#1d1d20);color:var(--ink,#ededee)}
.idc-badge{padding:0 7px;border-radius:999px;font-size:11px;line-height:18px;background:var(--surface-2,#1d1d20);color:var(--ink-2,#b6b6ba)}
.idc-badge.live{background:rgba(34,181,115,.14);color:var(--status-good,#22b573)}
.idc-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--muted,#808086)}
.idc-dot.run{background:var(--status-good,#22b573);box-shadow:0 0 0 3px rgba(34,181,115,.18)}
.idc-dot.wait{background:var(--status-warn,#f2a93b)}
.idc-dot.err{background:var(--status-crit,#ef5b45)}
@media (prefers-reduced-motion:no-preference){.idc-dot.run{animation:idc-pulse 2.4s ease-in-out infinite}}
@keyframes idc-pulse{50%{box-shadow:0 0 0 5px rgba(34,181,115,.06)}}
.idc-tabs{flex:none;display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--border,rgba(255,255,255,.09))}
.idc-panel.min .idc-tabs,.idc-panel.min .idc-scroll,.idc-panel.min .idc-foot{display:none}
.idc-panel button.idc-tabbtn{position:relative;display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 10px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--idc-muted);font:inherit;font-size:12.5px}
.idc-panel button.idc-tabbtn:hover{color:var(--ink,#ededee);background:transparent}
.idc-panel button.idc-tabbtn[aria-selected="true"]{color:var(--ink,#ededee);border-bottom-color:var(--accent,#5b8def)}
.idc-tabdot{min-width:6px;height:6px;border-radius:999px;background:var(--accent,#5b8def)}
.idc-tabdot.warn{background:var(--status-warn,#f2a93b)}
.idc-scroll{flex:1 1 auto;min-height:96px;overflow:auto;overscroll-behavior:contain}
.idc-pane{display:grid;gap:14px;align-content:start;padding:12px 14px 14px}
.idc-label{color:var(--idc-muted);font-size:12.5px}
.idc-hero{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.idc-big{font-size:24px;font-weight:600;letter-spacing:-.01em}
.idc-bar{height:6px;border-radius:3px;background:var(--surface-3,#27272a);overflow:hidden;margin:8px 0 0}
.idc-bar>i{display:block;height:100%;width:0;background:var(--accent,#5b8def);transition:width .4s}
.idc-rows{display:grid;gap:3px}
.idc-row{display:flex;justify-content:space-between;gap:12px}
.idc-row>span:first-child{color:var(--idc-muted);flex:none}
.idc-row>span:last-child{text-align:right;min-width:0;overflow-wrap:anywhere}
.idc-state{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;background:var(--surface-2,#1d1d20);color:var(--ink-2,#b6b6ba);font-size:12.5px;line-height:1.45}
.idc-state .idc-dot{margin-top:5px}
.idc-note{display:grid;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid rgba(242,169,59,.35);font-size:12.5px;line-height:1.45;color:var(--ink,#ededee)}
.idc-note button{justify-self:start}
.idc-recent{display:grid;gap:2px;font-size:12px;line-height:1.4;color:var(--idc-muted)}
.idc-recent>div{overflow-wrap:anywhere}
.idc-group{display:grid;gap:10px;min-width:0}
.idc-group+.idc-group{padding-top:14px;border-top:1px solid var(--border,rgba(255,255,255,.09))}
.idc-gh{margin:0;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--idc-muted)}
.idc-sub>summary,.idc-sec>summary{cursor:pointer;color:var(--ink-2,#b6b6ba);font-size:12.5px;list-style:none;display:flex;justify-content:space-between}
.idc-sub>summary::-webkit-details-marker,.idc-sec>summary::-webkit-details-marker{display:none}
.idc-sub>summary::after,.idc-sec>summary::after{content:"›";display:inline-block;transition:transform .15s}
.idc-sub[open]>summary::after,.idc-sec[open]>summary::after{transform:rotate(90deg)}
.idc-sub[open]>summary,.idc-sec[open]>summary{margin-bottom:12px}
.idc-sub>.idc-group{gap:12px}
fieldset.idc-form{border:0;margin:0;padding:0;min-width:0;display:grid;gap:14px}
fieldset.idc-form:disabled .idc-field,fieldset.idc-form:disabled .idc-check,fieldset.idc-form:disabled .idc-sub{opacity:.6}
.idc-lock{display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:8px;background:var(--surface-2,#1d1d20);font-size:12px;color:var(--ink-2,#b6b6ba)}
.idc-field{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;min-width:0}
.idc-fl{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:18px}
.idc-flabel{font-size:12px;color:var(--idc-muted)}
.idc-panel button.idc-rst{display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--idc-muted)}
.idc-panel button.idc-rst:hover{background:var(--surface-2,#1d1d20);color:var(--ink,#ededee)}
.idc-desc{font-size:12px;line-height:1.45;color:var(--idc-muted)}
.idc-seg{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:2px;padding:2px;border-radius:8px;background:var(--surface-2,#1d1d20);border:1px solid var(--border,rgba(255,255,255,.09))}
.idc-panel .idc-seg button{height:26px;padding:0 4px;border:0;border-radius:6px;background:transparent;color:var(--ink-2,#b6b6ba);font-size:12.5px;white-space:nowrap}
.idc-panel .idc-seg button:hover{color:var(--ink,#ededee)}
.idc-panel .idc-seg button[aria-checked="true"]{background:var(--surface-3,#27272a);color:var(--ink,#ededee);box-shadow:0 1px 2px rgba(0,0,0,.35)}
.idc-panel .idc-seg button:disabled{opacity:.5;cursor:default}
.idc-inp{display:flex;align-items:center;gap:4px;height:30px;padding:0 9px;border-radius:6px;background:var(--surface-2,#1d1d20);border:1px solid var(--border,rgba(255,255,255,.09));box-sizing:border-box}
.idc-inp:focus-within{border-color:var(--accent,#5b8def);outline:1px solid var(--accent,#5b8def)}
.idc-inp.bad{border-color:var(--status-crit,#ef5b45)}
.idc-inp>span{color:var(--idc-muted)}
.idc-inp input{flex:1;min-width:0;width:0;height:100%;padding:0;border:0;outline:none;background:transparent;color:var(--ink,#ededee);font:inherit;font-size:13px;font-variant-numeric:tabular-nums}
.idc-inp input::placeholder{color:var(--idc-muted)}
.idc-msg{font-size:12px;line-height:1.4}
.idc-msg.error{color:var(--status-crit,#ef5b45)}
.idc-msg.warn{color:var(--status-warn,#f2a93b)}
.idc-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
.idc-check{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--ink,#ededee);cursor:pointer}
.idc-check input{flex:none;margin:2px 0 0;accent-color:var(--accent,#5b8def)}
.idc-check.mod>span::after{content:"";display:inline-block;width:6px;height:6px;margin-left:6px;border-radius:50%;background:var(--accent,#5b8def);vertical-align:middle}
.idc-check small{display:block;margin-top:1px;font-size:12px;color:var(--idc-muted)}
.idc-inline{display:flex;gap:8px;align-items:center}
.idc-inline .idc-inp{flex:1}
.idc-quicks{display:flex;flex-wrap:wrap;gap:4px}
.idc-panel .idc-quicks button{height:22px;padding:0 9px;border-radius:999px;border:1px solid transparent;background:var(--surface-2,#1d1d20);color:var(--ink-2,#b6b6ba);font-size:11.5px;font-variant-numeric:tabular-nums}
.idc-panel .idc-quicks button:hover{border-color:var(--border,rgba(255,255,255,.09));color:var(--ink,#ededee)}
.idc-panel .idc-quicks button.on,.idc-panel .idc-quicks button[aria-pressed="true"]{background:var(--accent-wash,rgba(91,141,239,.14));color:var(--accent,#5b8def)}
.idc-sel{min-width:0;height:28px;padding:0 6px;border-radius:6px;border:1px solid var(--border,rgba(255,255,255,.09));background:var(--surface-2,#1d1d20);color:var(--ink,#ededee);font:inherit;font-size:12.5px;box-sizing:border-box}
.idc-lrow{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;padding:8px;border-radius:8px;border:1px solid var(--border,rgba(255,255,255,.09))}
.idc-lrow.skip{border-style:dashed;opacity:.75}
.idc-lrow .idc-two{gap:6px}
.idc-lrow .idc-two .idc-sel{width:100%}
.idc-lctl{display:flex;align-items:center;gap:4px;min-width:0}
.idc-lctl .idc-sel{flex:1 1 0}
.idc-tools{display:flex;flex-wrap:wrap;gap:6px}
.idc-panel button.danger{color:var(--status-crit,#ef5b45);border-color:rgba(239,91,69,.35)}
.idc-panel button.danger:hover:not(:disabled){background:rgba(239,91,69,.12)}
.idc-panel button.danger.armed{background:var(--status-crit,#ef5b45);border-color:transparent;color:#fff}
.idc-foot{flex:none;display:grid;gap:10px;padding:12px 14px 14px;border-top:1px solid var(--border,rgba(255,255,255,.09));background:var(--surface,#151517)}
.idc-plan{padding:9px 10px;border-radius:8px;border:1px solid var(--border,rgba(255,255,255,.09));font-size:12.5px;line-height:1.45;color:var(--ink-2,#b6b6ba)}
.idc-plan.hot{border-color:var(--accent,#5b8def);background:var(--accent-wash,rgba(91,141,239,.14));color:var(--ink,#ededee)}
.idc-plan.bad{border-color:rgba(239,91,69,.4);color:var(--status-crit,#ef5b45)}
.idc-btns{display:flex;gap:8px}
.idc-btns button{flex:1}
.idc-pill{margin-left:auto;padding:0 6px;border-radius:999px;font-size:11px;line-height:18px;background:var(--accent-wash,rgba(91,141,239,.14));color:var(--accent,#5b8def);font-variant-numeric:tabular-nums}
.idc-pill.wait{background:rgba(242,169,59,.14);color:var(--status-warn,#f2a93b)}
.idc-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;border:1px solid transparent;background:var(--surface-2,#1d1d20);color:var(--ink,#ededee);font:12.5px "Inter Variable",system-ui,sans-serif;font-variant-numeric:tabular-nums;cursor:pointer}
.idc-chip:hover,.idc-chip[aria-expanded="true"]{border-color:var(--border,rgba(255,255,255,.09))}
.idc-led{display:grid;gap:1px;font-size:12px;line-height:1.4;color:var(--idc-muted)}
.idc-ll{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:6px;align-items:baseline;padding:3px 6px;border-radius:5px;border-left:2px solid transparent;overflow-wrap:anywhere}
.idc-ll.k-action{color:var(--ink-2,#b6b6ba)}
.idc-ll.k-fail{border-left-color:var(--status-crit,#ef5b45);background:rgba(239,91,69,.08);color:var(--ink,#ededee)}
.idc-ll.k-alert{border-left-color:var(--status-warn,#f2a93b);background:rgba(242,169,59,.08);color:var(--ink,#ededee)}
.idc-ll time{font-size:11px;white-space:nowrap}
.idc-tag{padding:0 5px;border-radius:4px;background:var(--surface-2,#1d1d20);font-size:10.5px;letter-spacing:.03em;color:var(--ink-2,#b6b6ba)}
.idc-empty{padding:14px 6px;text-align:center;color:var(--idc-muted);font-size:12px}
.idc-toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;display:grid;gap:8px;justify-items:center;width:max-content;max-width:min(520px,calc(100vw - 32px));pointer-events:none}
.idc-toast{display:flex;align-items:center;gap:12px;pointer-events:auto;padding:9px 12px 9px 14px;border-radius:8px;background:var(--surface-3,#27272a);color:var(--ink,#ededee);border:1px solid var(--border,rgba(255,255,255,.09));border-left:3px solid var(--accent,#5b8def);font:13px/1.4 "Inter Variable",system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.idc-toast.k-success{border-left-color:var(--status-good,#22b573)}
.idc-toast.k-error{border-left-color:var(--status-crit,#ef5b45)}
.idc-toast button{height:24px;padding:0 8px;font-size:12px}
@media (prefers-reduced-motion:no-preference){.idc-toast{animation:idc-in .18s ease-out}@keyframes idc-in{from{opacity:0;transform:translateY(6px)}}}
@keyframes idc-panel-in{from{opacity:0;transform:translateY(10px) scale(.97)}}
@keyframes idc-panel-out{to{opacity:0;transform:translateY(6px) scale(.97)}}
@keyframes idc-pane-in{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:no-preference){
.idc-panel{animation:idc-panel-in .24s cubic-bezier(.2,.8,.2,1);transform-origin:50% 100%}
.idc-panel.idc-ghost{animation:idc-panel-out .16s ease-in forwards;pointer-events:none}
.idc-pane{animation:idc-pane-in .22s cubic-bezier(.2,.8,.2,1)}
.idc-chip,.idc-tab{transition:background-color .15s,border-color .15s,color .15s}
.idc-panel button.idc-tabbtn{transition:color .15s,border-color .2s}
.idc-dot{transition:background-color .25s,box-shadow .25s}
.idc-pill{transition:background-color .2s,color .2s}
}
`;
  let uiStyleEl = null;
  function ensureStyle() {
    if (!HAS_DOM || unloaded) return;
    if (!uiStyleEl || !uiStyleEl.isConnected) { uiStyleEl = h('style', { id: 'idc-style' }, UI_CSS); document.head.append(uiStyleEl); }
  }
  const svg = (d) => '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const ICONS = {
    close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
    min: svg('<path d="M4 8h8"/>'),
    expand: svg('<path d="M4 10l4-4 4 4"/>'),
    reset: svg('<path d="M3 8a5 5 0 1 0 1.8-3.8M3 3v3h3"/>'),
    lock: svg('<rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7"/>'),
  };
  const iconBtn = (icon, label, onclick) => { const b = h('button', { type: 'button', class: 'idc-ib', title: label, 'aria-label': label, onclick }); b.innerHTML = ICONS[icon]; return b; };
  const isTyping = (t) => /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || '');

  // Small builders -------------------------------------------------------------------------------
  const row = (k, v) => h('div', { class: 'idc-row' }, h('span', {}, k), h('span', {}, v));
  const group = (title, ...kids) => h('div', { class: 'idc-group' }, ...(title ? [h('h4', { class: 'idc-gh' }, title)] : []), ...kids);
  function field(label, ...kids) {
    const rst = h('button', { type: 'button', class: 'idc-rst', hidden: true, 'aria-label': 'Reset ' + label + ' to its default' });
    rst.innerHTML = ICONS.reset;
    const el = h('div', { class: 'idc-field' }, h('div', { class: 'idc-fl' }, h('span', { class: 'idc-flabel' }, label), rst), ...kids);
    el._rst = rst;
    return el;
  }
  // Shows the per-field "back to default" button when the value differs from its default.
  function setModified(el, modified, hint, onReset) {
    if (!el?._rst) return;
    el._rst.hidden = !modified;
    if (modified) {
      el._rst.title = hint;
      // The button hides itself once the field is back at its default: hand focus to the field first.
      el._rst.onclick = () => { onReset(); (el.querySelector('input') || el.querySelector('.idc-seg button[aria-checked="true"]'))?.focus(); };
    }
  }
  function inputBox({ label, prefix, suffix, placeholder = '' }) {
    const input = h('input', { type: 'text', inputMode: 'decimal', autocomplete: 'off', spellcheck: false, placeholder, 'aria-label': label });
    const box = h('div', { class: 'idc-inp' }, ...(prefix ? [h('span', {}, prefix)] : []), input, ...(suffix ? [h('span', {}, suffix)] : []));
    return { input, box };
  }
  function check(input, text, hint) { return h('label', { class: 'idc-check' }, input, h('span', {}, text, ...(hint ? [h('small', {}, hint)] : []))); }
  // Segmented radio group with roving tabindex and arrow keys.
  function seg(opts, cur, onPick, label = '') {
    const btns = opts.map((o) => h('button', { type: 'button', role: 'radio', onclick: () => onPick(o.id) }, o.label));
    const el = h('div', { class: 'idc-seg', role: 'radiogroup', 'aria-label': label }, ...btns);
    el.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      const i = btns.indexOf(document.activeElement);
      if (!d || i < 0) return;
      for (let n = 1; n <= btns.length; n++) {
        const b = btns[(i + d * n + btns.length * n) % btns.length];
        if (!b.disabled) { e.preventDefault(); b.focus(); b.click(); return; }
      }
    });
    return { el, btns, sync() { opts.forEach((o, i) => { const on = cur() === o.id; btns[i].setAttribute('aria-checked', String(on)); btns[i].tabIndex = on ? 0 : -1; }); } };
  }
  // Two-step button for things you can't take back: first click arms it, the second does it.
  function confirmBtn(label, onConfirm, armed = 'Click again to confirm') {
    let t = 0;
    const b = h('button', { type: 'button', class: 'danger' }, label);
    const disarm = () => { clearTimeout(t); t = 0; b.textContent = label; b.classList.remove('armed'); };
    b.addEventListener('click', () => { if (t) { disarm(); onConfirm(); } else { b.textContent = armed; b.classList.add('armed'); t = setTimeout(disarm, 4000); } });
    b.addEventListener('blur', disarm);
    return b;
  }

  // A closed panel leaves a non-interactive copy that fades out, so switching menus cross-fades instead of popping.
  function fadeOut(ghost) {
    ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    ghost.removeAttribute('id'); ghost.inert = true; ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('idc-ghost'); ghost.style.zIndex = 9997;
    document.body.append(ghost);
    ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
    setTimeout(() => ghost.remove(), 500);
  }

  // Panel shell: sticky header (drag, minimize, close), tabs, scrolling body, sticky footer ----------
  const livePanels = new Set();
  const motionOK = () => HAS_DOM && matchMedia('(prefers-reduced-motion: no-preference)').matches;
  const EASE = 'cubic-bezier(.2,.8,.2,1)';
  function createPanel(o) {
    const st = o.state, save = o.save || (() => {});
    const dot = h('span', { class: 'idc-dot' });
    const minBtn = iconBtn('min', 'Minimize', () => setMin(!st.min));
    const closeBtn = iconBtn('close', 'Close', () => o.onClose());
    const head = h('div', { class: 'idc-head' }, dot, h('span', { class: 'idc-title' }, o.title), ...(o.headExtra || []), minBtn, closeBtn);
    head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) setMin(!st.min); });

    const tabBtns = {}, panes = {}, order = o.tabs.map((t) => t.id);
    const tablist = h('div', { class: 'idc-tabs', role: 'tablist', 'aria-label': o.title + ' sections' });
    const scroll = h('div', { class: 'idc-scroll' });
    for (const t of o.tabs) {
      const badge = h('span', { class: 'idc-tabdot', hidden: true });
      const b = h('button', { type: 'button', class: 'idc-tabbtn', role: 'tab', id: 'idc-' + o.id + '-t-' + t.id, 'aria-controls': 'idc-' + o.id + '-p-' + t.id, onclick: () => setTab(t.id) }, t.label, badge);
      b._badge = badge;
      tabBtns[t.id] = b;
      panes[t.id] = h('div', { class: 'idc-pane', role: 'tabpanel', id: 'idc-' + o.id + '-p-' + t.id, 'aria-labelledby': b.id, hidden: true }, ...t.content);
      tablist.append(b); scroll.append(panes[t.id]);
    }
    tablist.addEventListener('keydown', (e) => {
      const i = order.indexOf(order.find((id) => tabBtns[id] === document.activeElement));
      const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: order.length - 1 }[e.key];
      if (i < 0 || j == null) return;
      e.preventDefault();
      const id = order[(j + order.length) % order.length];
      setTab(id); tabBtns[id].focus();
    });

    const el = h('div', { class: 'idc-panel ' + (o.cls || ''), role: 'dialog', 'aria-label': o.label || o.title, tabindex: '-1' }, head, tablist, scroll, ...(o.foot ? [o.foot] : []));
    if (o.width) el.style.width = o.width + 'px';
    el.addEventListener('pointerdown', () => raise(), true);
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !isTyping(e.target)) { e.preventDefault(); o.onClose(); } });
    makeDraggable(head, () => el, st, place, save);

    // Two levels only (the one you used last is on top), so the panels never climb above the game's own dialogs.
    function raise() { for (const p of livePanels) p.el.style.zIndex = p === api ? 9999 : 9998; el.style.zIndex = 9999; }
    function setTab(id) {
      if (!panes[id]) id = order[0];
      st.tab = id; save();
      for (const k of order) {
        const on = k === id;
        tabBtns[k].setAttribute('aria-selected', String(on)); tabBtns[k].tabIndex = on ? 0 : -1; panes[k].hidden = !on;
      }
      o.onTab?.(id);
    }
    function setMin(v, instant) {
      const from = !instant && el.isConnected && motionOK() ? el.offsetHeight : 0;
      st.min = !!v; save();
      el.classList.toggle('min', st.min);
      minBtn.innerHTML = ICONS[st.min ? 'expand' : 'min'];
      const lab = st.min ? 'Expand' : 'Minimize';
      minBtn.title = lab; minBtn.setAttribute('aria-label', lab); minBtn.setAttribute('aria-expanded', String(!st.min));
      place();
      if (from && el.offsetHeight !== from) el.animate({ height: [from + 'px', el.offsetHeight + 'px'], overflow: ['hidden', 'hidden'] }, { duration: 220, easing: EASE });
      if (!st.min) o.onTab?.(st.tab);
    }
    function place() {
      if (st.x == null) {
        const d = o.defaultPlace?.() || { right: 20 };
        Object.assign(el.style, { left: d.left != null ? d.left + 'px' : 'auto', right: d.right != null ? d.right + 'px' : 'auto', top: 'auto', bottom: '20px', maxHeight: 'calc(100vh - 40px)' });
        return;
      }
      // Keep the header, tabs and footer on screen: the top can't be so low that they no longer fit.
      const fixed = head.offsetHeight + (st.min ? 0 : tablist.offsetHeight + (o.foot?.offsetHeight || 0) + 96);
      const x = Math.min(Math.max(8, st.x), innerWidth - 80);
      const y = Math.max(8, Math.min(st.y, innerHeight - Math.max(40, fixed) - 8));
      Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto', maxHeight: Math.max(160, innerHeight - y - 8) + 'px' });
    }
    // Two default-placed panels that would cover each other (narrow window): the one you opened last wins.
    function avoidOverlap() {
      if (st.x != null || st.min) return;
      const a = el.getBoundingClientRect();
      for (const p of livePanels) {
        if (p === api || p.state.x != null || p.state.min) continue;
        const b = p.el.getBoundingClientRect();
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) p.setMin(true);
      }
    }
    const api = {
      el, dot, state: st, setTab, setMin, place,
      reveal() { if (st.min) setMin(false); raise(); el.focus({ preventScroll: true }); },
      setTabBadge(id, text, warn = false) {
        const b = tabBtns[id]?._badge; if (!b) return;
        b.hidden = !text; b.title = text || ''; b.classList.toggle('warn', warn);
        const btn = tabBtns[id], label = o.tabs.find((t) => t.id === id).label;
        if (text) btn.setAttribute('aria-label', label + ', ' + text); else btn.removeAttribute('aria-label');
      },
      mount({ focus = false } = {}) {
        ensureStyle();
        if (!el.isConnected) document.body.append(el);
        livePanels.add(api);
        setTab(st.tab); setMin(st.min, true); raise();
        if (focus) { avoidOverlap(); el.focus({ preventScroll: true }); }
      },
      close() { o.onClose(); },
      unmount() {
        const had = el.contains(document.activeElement);
        const ghost = motionOK() && el.isConnected ? el.cloneNode(true) : null;
        el.remove(); livePanels.delete(api);
        if (ghost) fadeOut(ghost);
        if (had) o.opener?.()?.focus?.();
      },
    };
    return api;
  }

  // Header chip / sidebar tab click: opening (or revealing) a panel closes the other panels, like switching menus; clicking the open one closes it.
  function togglePanel(p, st, show) {
    const live = !!p?.el.isConnected;
    if (live && st.min) { closeOthers(p); p.reveal(); return; }
    if (!live) closeOthers(p);
    show(!live, { focus: true });
  }
  function closeOthers(except) { for (const p of [...livePanels]) if (p !== except) p.close(); }

  // Sidebar tab + top-bar chip. React re-renders those containers, so they are re-inserted when missing.
  function createChrome(o) {
    let navEl = null, chipEl = null, pillEl = null, chipDot = null, chipText = null, observer = null, dead = false;
    const view = { pill: { text: '', tone: '', hidden: true }, chip: { text: o.label, tone: '', title: o.label }, open: false };
    // Write text only when it changed: a rewrite replaces the text node, which the observer below would see as a mutation.
    const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
    function paint() {
      if (pillEl) { pillEl.hidden = view.pill.hidden; pillEl.className = 'idc-pill' + (view.pill.tone === 'run' ? '' : ' wait'); setText(pillEl, view.pill.text); }
      if (chipEl) { chipDot.className = 'idc-dot ' + view.chip.tone; setText(chipText, view.chip.text); chipEl.title = view.chip.title; }
      navEl?.setAttribute('aria-expanded', String(view.open)); chipEl?.setAttribute('aria-expanded', String(view.open));
    }
    function ensure() {
      if (unloaded || dead) return;   // a re-render queued just before unmount must not bring the tab back
      const nav = document.querySelector('.primary-navigation');
      if (nav && (!navEl || !nav.contains(navEl))) {
        pillEl = h('span', { class: 'idc-pill', hidden: true });
        navEl = h('button', { class: 'page-tab idc-tab ' + o.navClass, title: o.navTitle, onclick: () => o.onToggle() });
        navEl.innerHTML = o.icon;
        navEl.append(h('span', { class: 'nav-text' }, o.label), pillEl);
        (o.navInsert || ((n, e) => n.append(e)))(nav, navEl);
        paint();
      }
      const tools = document.querySelector('.topbar-tools');
      if (tools && (!chipEl || !tools.contains(chipEl))) {
        chipDot = h('span', { class: 'idc-dot' }); chipText = h('span');
        chipEl = h('button', { class: 'idc-chip ' + o.chipClass, onclick: () => o.onToggle() }, chipDot, chipText);
        (o.chipInsert || ((t, e) => t.append(e)))(tools, chipEl);
        paint();
      }
    }
    return {
      get opener() { return chipEl?.isConnected ? chipEl : navEl; },
      mount() {
        dead = false; ensureStyle(); ensure();
        let queued = false;
        observer = new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; ensure(); }); });
        observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
      },
      unmount() { dead = true; observer?.disconnect(); observer = null; navEl?.remove(); chipEl?.remove(); navEl = chipEl = pillEl = chipDot = chipText = null; },
      setPill(text, tone, hidden) { view.pill = { text, tone, hidden }; paint(); },
      setChip(text, tone, title) { view.chip = { text, tone, title }; paint(); },
      setOpen(b) { view.open = !!b; paint(); },
    };
  }

  // Log view: the shared ledger with kind tint, module tag and All / Actions / Problems filter; { mod } shows one module's lines only ----------
  function createLogView({ limit = 60, mod = null } = {}) {
    let filter = 'all', seenAt = Date.now();
    let lastSig = '';
    const list = h('div', { class: 'idc-led' });
    const FILTERS = [['all', 'All'], ['actions', 'Actions'], ['problems', 'Problems']];
    const chips = FILTERS.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(id === filter), onclick: () => { filter = id; render(); } }, label));
    const bar = h('div', { class: 'idc-quicks', role: 'group', 'aria-label': 'Filter log' }, ...chips);
    const bad = (e) => e.kind === 'fail' || e.kind === 'alert';
    const mine = (e) => !mod || e.mod === mod;
    const money = (e) => (e.dMoney != null ? ' (' + (e.dMoney < 0 ? '−' : '+') + '$' + Math.abs(e.dMoney).toLocaleString('en-US') + ')' : '');
    function render() {
      const sig = filter + '|' + ledgerApi.rev();
      if (sig === lastSig) return;   // nothing new: keep the DOM (and any text selection) as it is
      lastSig = sig;
      chips.forEach((b, i) => b.setAttribute('aria-pressed', String(FILTERS[i][0] === filter)));
      const all = ledgerApi.list().filter((e) => mine(e) && (filter === 'all' || (filter === 'actions' ? e.kind === 'action' : bad(e))));
      const rows = all.slice(-limit).reverse().map((e) => h('div', { class: 'idc-ll k-' + e.kind },
        h('time', { title: new Date(e.t).toLocaleString() }, new Date(e.t).toLocaleTimeString()),
        h('span', { class: 'idc-tag' }, e.mod),
        h('span', {}, e.text + money(e))));
      list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'idc-empty' }, filter === 'all' ? 'Nothing logged yet.' : 'Nothing here.')]));
    }
    return {
      el: h('div', { class: 'idc-group' }, bar, list), render,
      unseen: () => ledgerApi.list().filter((e) => mine(e) && e.t > seenAt && bad(e)).length,
      markSeen() { seenAt = Date.now(); },
    };
  }

  const ui = { ensureStyle, ICONS, row, group, field, setModified, inputBox, check, seg, confirmBtn, createPanel, createChrome, createLogView, togglePanel };

  const titleTimer = HAS_DOM ? setInterval(applyTitle, 2000) : 0;
  addEventListener?.('pagehide', flushLedger);

  W.idleCore = {
    version: 1,
    walk, sleep, sleepWake, waitConfirm, markSend, nowTick, seeTick, sock,
    h, makeDraggable, toast, ledger: ledgerApi, ui,
    setBadge, notify, askNotify, notifyPerm, stopAll,
    exportConfig, importConfig, exportFile, importFile, missingFields,
    _unload() {
      unloaded = true;
      sock.ws?.removeEventListener('message', onMessage); sock.ws = null;
      if (HAS_DOM) removeEventListener('keydown', onKey, true);
      clearInterval(titleTimer);
      flushLedger();
      if (HAS_DOM) { uiStyleEl?.remove(); toastBox?.remove(); uiStyleEl = toastBox = null; }
    },
  };
})();
} catch (e) { console.error('[IdleCorp] shared core failed to load:', e); }
// @@END core

