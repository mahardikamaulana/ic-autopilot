// ==UserScript==
// @name         IC Autopilot
// @namespace    idlecorp-toolkit
// @version      2.8.5
// @author       XPARAD0X
// @description  Early-game Autopilot, CD Farm (Construction Data by building and demolishing buildings; Auto picks the cheapest source itself), Lab runner (keeps the Manufacturing Labs researching), Auto ship (an "Auto ship" button on every distributor bid) and Auto utilities (an "Auto" switch that keeps the power and water subscriptions at what the groups need) for IdleCorp, each with a panel, menu or switch in the game UI.
// @homepageURL  https://github.com/mahardikamaulana/ic-autopilot
// @supportURL   https://github.com/mahardikamaulana/ic-autopilot/issues
// @updateURL    https://raw.githubusercontent.com/mahardikamaulana/ic-autopilot/main/ic-autopilot.user.js
// @downloadURL  https://raw.githubusercontent.com/mahardikamaulana/ic-autopilot/main/ic-autopilot.user.js
// @match        https://idlecorp.net/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==
//
// Generated from src/*.js by build.js: edit those, then run
//   bun build.js            (bun build.js --bump  raises @version first: Tampermonkey only updates when it goes up)
//
// Parts in one file; Core plan (window.corePlan, console only for now) reads the stage of the core game plan and sends its unlocks and early land.
// CD Farm and Autopilot talk through window.cdFarm and window.earlyGame,
// all of them use the shared core, and each part is wrapped separately.
//   0. Core      (window.idleCore)  one cached read of the game state, one socket listener, confirm
//                                   waiting, activity log, alerts, Alt+Shift+X stops everything,
//                                   settings export / import, UI kit (idleCore.ui: panel shell with
//                                   tabs, sidebar tab + chip, log view, toasts, one stylesheet)
//   1. CD Farm   (window.cdFarm)    sidebar tab "CD Farm"
//   2. Autopilot (window.earlyGame) sidebar tab "Autopilot"
//   3. Lab       (window.labRunner) sidebar tab "Lab": StartResearch whenever a Manufacturing Lab's
//                                   slot is free, ClaimResearch for finished results (dry run by default)
//   4. Auto ship (window.autoSell)  "Auto ship" button left of Sell on every distributor bid in the Market table:
//                                   a menu like the game's auto-ship menu, selling by FillDeal over the socket
//                                   (no slot limit), plus an "Auto ship" jobs table on the Market page
//   5. Auto utilities (window.autoUtil) an "Auto" switch on the Load tile (power) and the Supply tile (water) of the
//                                   Utilities pages: the grid service / waterworks subscription follows the load
// File order is core, CD Farm, Lab, Auto ship, Auto utilities, Autopilot: Autopilot stays last (the simulator evals it to the end of the file).
// This replaces the separate cd-farm.user.js and early-game.user.js: uninstall those two first, or both copies run side by side.// ============================================================================
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
  // sendAt / ackAt: performance.now() at ws.send and when the first player-mutation Diff after it arrived
  // (sub-millisecond, unlike the confirm poll): their difference is the command's round trip.
  const sock = { ws: null, textMsgs: 0, diffs: 0, muts: 0, mutTick: 0, tick: 0, tickAt: 0, sendAt: 0, ackAt: 0 };
  const hrNow = () => globalThis.performance?.now?.() ?? Date.now();
  const wakers = new Set();
  function seeTick(t) { if (typeof t === 'number' && t > sock.tick) { sock.tick = t; sock.tickAt = Date.now(); } }
  function onMessage(e) {
    if (typeof e.data !== 'string') return;
    sock.textMsgs++;
    try {
      const m = JSON.parse(e.data);
      seeTick(m.tick ?? m.diff?.tick);
      if (m.kind === 'Diff') sock.diffs++;
      if (m.kind === 'WorldEvents') sock.worldEvents = { raw: e.data, at: Date.now() };   // plan D5: kept for a readout only, nothing acts on it
      const u = m.diff?.ssi?.last_user_mutation_tick;
      if (typeof u === 'number' && u > sock.mutTick) { sock.mutTick = u; sock.muts++; if (sock.sendAt && !sock.ackAt) sock.ackAt = hrNow(); for (const w of [...wakers]) w(); }
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
  function markSend(stMutTick) { sock.mutTick = Math.max(sock.mutTick, stMutTick || 0); sock.sendAt = hrNow(); sock.ackAt = 0; return sock.muts; }
  // Round trip of the last marked command in ms (float), or null while its acknowledgement has not been seen.
  const lastRtt = () => (sock.sendAt && sock.ackAt >= sock.sendAt ? sock.ackAt - sock.sendAt : null);
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
  const MODS = ['earlyGame', 'cdFarm', 'labRunner', 'autoUtil', 'corePlan'];
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

// continues the core closure from core-1.js (same try / IIFE)
  // ---- UI kit (core.ui): one stylesheet, panel shell, tabs, sidebar tab + top-bar chip, log view -------------
  // Both modules build their panels from this; each keeps only its own content and settings.
  const UI_CSS = `
.idc-panel,.idc-toasts{--idc-muted:var(--muted,#808086);--idc-focus:var(--accent,#5b8def)}
.idc-panel{--kind:var(--accent,#5b8def)}.cdf-panel{--kind:#d9a637}.lab-panel{--kind:#8e6fd8}.cp-panel{--kind:#4fbf6a}
.idc-panel{position:fixed;z-index:9999;display:flex;flex-direction:column;width:var(--idc-w,340px);max-width:calc(100vw - 32px);max-height:calc(100vh - 40px);overflow:auto;background:var(--surface,#151517);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);color:var(--ink,#ededee);font:inherit;font-variant-numeric:tabular-nums}
.idc-panel.idc-docked{inset:0 0 0 auto;width:var(--idc-dock,360px);max-width:100vw;max-height:none;z-index:40;border-width:0 0 0 1px;border-radius:0;box-shadow:none;background:var(--page,#0d0d0f)}
.idc-docked .idc-head{cursor:default}
body:has(>.idc-docked:not(.idc-ghost)) .shell{padding-right:var(--idc-dock,360px)}
@media (max-width:700px){
.idc-panel.idc-docked{inset:auto 0 var(--chrome-h,120px) 0;width:auto;max-height:calc(100dvh - var(--chrome-h,120px) - 3rem);z-index:41;border-width:1px 0 0;border-radius:12px 12px 0 0}
body:has(>.idc-docked:not(.idc-ghost)) .shell{padding-right:0}
body:has(.shell)>.idc-panel{--idc-bottom:calc(var(--chrome-h,120px) + 8px)}
}
.idc-panel:focus{outline:none}
.idc-panel :focus-visible,.idc-chip:focus-visible,.idc-tab:focus-visible,.idc-toasts :focus-visible{outline:2px solid var(--idc-focus);outline-offset:1px}
.idc-panel [hidden],.idc-pill[hidden],.idc-toasts [hidden]{display:none!important}
.idc-head{flex:none;display:flex;align-items:center;gap:8px;min-height:40px;padding:4px 4px 4px 1rem;box-sizing:border-box;border-bottom:1px solid var(--border,rgba(255,255,255,.09));cursor:move;user-select:none}
.idc-panel.min .idc-head{border-bottom-color:transparent}
.idc-title{flex:1;font-size:15px;font-weight:600;letter-spacing:-.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.idc-panel button.idc-ib{flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--idc-muted)}
.idc-panel button.idc-ib:hover{background:rgba(255,255,255,.1);color:var(--ink,#ededee)}
.idc-badge{padding:0 7px;border-radius:999px;font-size:11px;line-height:18px;background:var(--surface-2,#1d1d20);color:var(--ink-2,#b6b6ba)}
.idc-badge.live{background:rgba(34,181,115,.14);color:var(--status-good,#22b573)}
.idc-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--muted,#808086)}
.idc-dot.run{background:var(--status-good,#22b573);box-shadow:0 0 0 3px rgba(34,181,115,.18)}
.idc-dot.wait{background:var(--status-warn,#f2a93b)}
.idc-dot.err{background:var(--status-crit,#ef5b45)}
@media (prefers-reduced-motion:no-preference){.idc-dot.run{animation:idc-pulse 2.4s ease-in-out infinite}}
@keyframes idc-pulse{50%{box-shadow:0 0 0 5px rgba(34,181,115,.06)}}
.idc-tabs{flex:none;display:flex;gap:0;padding:0 6px;border-bottom:1px solid var(--border,rgba(255,255,255,.09))}
.idc-panel.min .idc-tabs,.idc-panel.min .idc-scroll,.idc-panel.min .idc-foot{display:none}
.idc-panel button.idc-tabbtn{position:relative;display:inline-flex;align-items:center;gap:.4rem;height:auto;padding:.55rem .9rem;line-height:1.4;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--ink-2,#b6b6ba);font:inherit}
.idc-panel button.idc-tabbtn:hover{color:var(--ink,#ededee);background:transparent;border-bottom-color:var(--border,rgba(255,255,255,.09))}
.idc-panel button.idc-tabbtn[aria-selected="true"]{color:var(--ink,#ededee);font-weight:600;border-bottom-color:var(--accent,#5b8def)}
.idc-tl{display:inline-flex;flex-direction:column;align-items:center}
.idc-tl::after{content:attr(data-label);font-weight:600;height:0;overflow:hidden;visibility:hidden}
.idc-tabdot{min-width:6px;height:6px;border-radius:999px;background:var(--accent,#5b8def)}
.idc-tabdot.warn{background:var(--status-warn,#f2a93b)}
.idc-scroll{flex:1 1 auto;min-height:96px;overflow:auto;overscroll-behavior:contain}
.idc-pane{display:grid;gap:14px;align-content:start;padding:12px 16px 16px}
.idc-label{color:var(--idc-muted);font-size:13px}
.idc-hero{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.idc-big{font-size:24px;font-weight:500;letter-spacing:-.02em;line-height:1.2}
.idc-bar{height:6px;border-radius:999px;background:var(--ring-off,rgba(255,255,255,.16));overflow:hidden;margin:10px 0 0}
.idc-bar>i{display:block;height:100%;width:0;border-radius:999px;background:var(--kind);transition:width .4s}
.idc-rows{display:grid}
.idc-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--border,rgba(255,255,255,.09))}
.idc-row:last-child{border-bottom:0}
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
.idc-gh{margin:0;font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--idc-muted)}
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
.idc-seg{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:2px;padding:2px;border-radius:8px;background:var(--surface-2,#1d1d20)}
.idc-panel .idc-seg button{height:28px;padding:0 4px;border:0;border-radius:6px;background:transparent;color:var(--ink-2,#b6b6ba);font-size:12.5px;white-space:nowrap}
.idc-panel .idc-seg button:hover{background:var(--surface-3,#27272a);color:var(--ink,#ededee)}
.idc-panel .idc-seg button[aria-checked="true"]{background:var(--accent-wash,rgba(91,141,239,.14));color:var(--accent,#5b8def);font-weight:500}
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
.idc-panel button.danger{color:var(--status-crit,#ef5b45);border-color:rgba(208,59,59,.6)}
.idc-panel button.danger:hover:not(:disabled){background:rgba(239,91,69,.12)}
.idc-panel button.danger.armed{background:var(--status-crit,#ef5b45);border-color:transparent;color:#fff}
.idc-foot{flex:none;display:grid;gap:10px;padding:12px 14px 14px;border-top:1px solid var(--border,rgba(255,255,255,.09));background:inherit}
.idc-plan{padding:0 2px;border-radius:8px;border:1px solid transparent;font-size:12.5px;line-height:1.45;color:var(--idc-muted)}
.idc-plan.hot,.idc-plan.bad{padding:9px 10px}
.idc-plan.hot{border-color:var(--accent,#5b8def);background:var(--accent-wash,rgba(91,141,239,.14));color:var(--ink,#ededee)}
.idc-plan.bad{border-color:rgba(239,91,69,.4);color:var(--status-crit,#ef5b45)}
.idc-btns{display:flex;gap:8px}
.idc-btns button{flex:1}
.idc-pill{margin-left:auto;padding:0 .4rem;border:1px solid var(--accent,#5b8def);border-radius:999px;font-size:11px;font-weight:400;line-height:16px;color:var(--accent,#5b8def);font-variant-numeric:tabular-nums}
.idc-pill.wait{border-color:var(--status-warn,#f2a93b);color:var(--status-warn,#f2a93b)}
.primary-navigation .idc-tab[aria-expanded="true"]{background:var(--surface,#151517);color:var(--ink,#ededee)}
.primary-navigation .idc-tab[aria-expanded="true"] .nav-icon{color:var(--accent,#5b8def)}
.idc-chip{display:inline-flex;align-items:center;gap:.35rem;height:24px;padding:0 .6rem;border-radius:999px;border:1px solid transparent;background:var(--surface-2,#1d1d20);color:var(--ink-2,#b6b6ba);font:inherit;font-size:12.5px;line-height:22px;white-space:nowrap;font-variant-numeric:tabular-nums;cursor:pointer}
.idc-chip:hover{color:var(--ink,#ededee);background:var(--surface-2,#1d1d20)}
.idc-chip[aria-expanded="true"]{color:var(--ink,#ededee);border-color:var(--border,rgba(255,255,255,.09))}
.idc-led{display:grid;gap:1px;font-size:12px;line-height:1.4;color:var(--idc-muted)}
.idc-ll{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:6px;align-items:baseline;padding:3px 6px;border-radius:5px;border-left:2px solid transparent;overflow-wrap:anywhere}
.idc-ll.k-action{color:var(--ink-2,#b6b6ba)}
.idc-ll.k-fail{border-left-color:var(--status-crit,#ef5b45);background:rgba(239,91,69,.08);color:var(--ink,#ededee)}
.idc-ll.k-alert{border-left-color:var(--status-warn,#f2a93b);background:rgba(242,169,59,.08);color:var(--ink,#ededee)}
.idc-ll time{font-size:11px;white-space:nowrap}
.idc-tag{padding:0 5px;border-radius:4px;background:var(--surface-2,#1d1d20);font-size:10.5px;letter-spacing:.07em;color:var(--ink-2,#b6b6ba)}
.idc-empty{padding:14px 6px;text-align:center;color:var(--idc-muted);font-size:12px}
.idc-toasts{position:fixed;top:calc(var(--chrome-h,56px) + 12px);right:24px;z-index:2147483000;display:grid;gap:8px;justify-items:end;width:max-content;max-width:min(380px,calc(100vw - 32px));pointer-events:none}
body:has(>.idc-docked:not(.idc-ghost)) .idc-toasts{right:calc(var(--idc-dock,360px) + 24px)}
.idc-toast{display:flex;align-items:center;gap:.6rem;pointer-events:auto;padding:.5rem .5rem .5rem .75rem;border-radius:8px;background:var(--surface-2,#1d1d20);color:var(--ink,#ededee);border:1px solid var(--border,rgba(255,255,255,.09));font-size:13px;line-height:1.4;box-shadow:0 12px 32px rgba(0,0,0,.5)}
.idc-toast::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--accent,#5b8def)}
.idc-toast.k-success::before{background:var(--status-good,#22b573)}
.idc-toast.k-error::before{background:var(--status-crit,#ef5b45)}
@media (max-width:700px){.idc-toasts,body:has(>.idc-docked:not(.idc-ghost)) .idc-toasts{top:auto;bottom:calc(var(--chrome-h,120px) + 12px);left:16px;right:16px;width:auto;max-width:none;justify-items:center}}
.idc-toast button{height:24px;padding:0 8px;font-size:12px}
@media (prefers-reduced-motion:no-preference){.idc-toast{animation:idc-in .18s ease-out}@keyframes idc-in{from{opacity:0;transform:translateY(-6px)}}}
@keyframes idc-panel-in{from{opacity:0;transform:translateY(10px) scale(.97)}}
@keyframes idc-panel-out{to{opacity:0;transform:translateY(6px) scale(.97)}}
@keyframes idc-dock-in{from{opacity:0;transform:translateX(16px)}}
@keyframes idc-pane-in{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:no-preference){
.idc-panel{animation:idc-panel-in .24s cubic-bezier(.2,.8,.2,1);transform-origin:50% 100%}
.idc-panel.idc-docked:not(.idc-ghost){animation-name:idc-dock-in}
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
  // React can drop or bring back the game's layout: re-place the panels whose docked state no longer matches it.
  let dockObs = null;
  function watchDock() {
    if (dockObs) return;
    let queued = false;
    dockObs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; const can = !!document.querySelector('.shell'); for (const p of livePanels) if (!p.state.min && p.el.classList.contains('idc-docked') !== can) p.place(); });
    });
    dockObs.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
  }
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
      const b = h('button', { type: 'button', class: 'idc-tabbtn', role: 'tab', id: 'idc-' + o.id + '-t-' + t.id, 'aria-controls': 'idc-' + o.id + '-p-' + t.id, onclick: () => setTab(t.id) }, h('span', { class: 'idc-tl', 'data-label': t.label }, t.label), badge);
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
    if (o.width) el.style.setProperty('--idc-w', o.width + 'px');
    el.addEventListener('pointerdown', () => raise(), true);
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !isTyping(e.target)) { e.preventDefault(); o.onClose(); } });
    makeDraggable(head, () => el, st, place, save);

    // Two levels only (the one you used last is on top), so the panels never climb above the game's own dialogs.
    // A docked panel keeps the stylesheet's z-index (the game's sidebar level, under its modals and popovers).
    function raise() {
      for (const p of livePanels) if (p !== api) p.el.style.zIndex = p.el.classList.contains('idc-docked') ? '' : 9998;
      el.style.zIndex = el.classList.contains('idc-docked') ? '' : 9999;
    }
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
      // Dock beside the game's layout root (.shell) like its own sidebar; minimized, or with no anchor, it floats as before.
      const dock = !st.min && !!document.querySelector('.shell');
      el.classList.toggle('idc-docked', dock);
      if (dock) {
        Object.assign(el.style, { left: '', right: '', top: '', bottom: '', maxHeight: '', zIndex: '' });
        for (const p of livePanels) if (p !== api && p.el.classList.contains('idc-docked')) p.setMin(true);   // one dock: the panel shown last takes it
        return;
      }
      if (st.x == null) {
        const d = o.defaultPlace?.() || { right: 20 };
        Object.assign(el.style, { left: d.left != null ? d.left + 'px' : 'auto', right: d.right != null ? d.right + 'px' : 'auto', top: 'auto', bottom: 'var(--idc-bottom,20px)', maxHeight: 'calc(100vh - 40px)' });
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
      if (st.x != null || st.min || el.classList.contains('idc-docked')) return;
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
        livePanels.add(api); watchDock();
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

// continues the core closure from core-2.js (same try / IIFE)
  // ---- reserves: what each spending module keeps back, shared by CD Farm Auto --------------------------------------
  // A provider is { reserve(): { moneyFloor (cents), items: {id: n}, nextTech, phase } | null, busy(): bool, hold?(who): Promise, release?(who) }.
  // Autopilot registers itself; Core plan registers its own. CD Farm reads the merged view instead of asking Autopilot alone:
  // money floor = the highest, item reserves add up (Infinity stays Infinity), the first provider with a next unlock wins.
  const reserveProviders = new Map();
  const reserves = {
    register(name, p) { reserveProviders.set(String(name), p); return () => { if (reserveProviders.get(String(name)) === p) reserveProviders.delete(String(name)); }; },
    unregister(name) { reserveProviders.delete(String(name)); },
    names: () => [...reserveProviders.keys()],
    anyBusy() { for (const p of reserveProviders.values()) { try { if (p.busy?.()) return true; } catch (e) { console.error(e); } } return false; },
    merged() {
      let any = false, moneyFloor = 0, nextTech = null, phase = null;
      const items = {}, by = {};
      for (const [name, p] of reserveProviders) {
        let r = null;
        try { r = p.reserve?.() ?? null; } catch (e) { console.error(e); }
        if (!r) continue;
        any = true; by[name] = r;
        moneyFloor = Math.max(moneyFloor, r.moneyFloor ?? 0);
        for (const [i, n] of Object.entries(r.items ?? {})) items[i] = (items[i] ?? 0) + n;
        nextTech ||= r.nextTech ?? null;
        if (phase == null && r.phase != null) phase = r.phase;
      }
      return any ? { moneyFloor, items, nextTech, phase, by } : null;
    },
    // Every provider pauses after its current step (CD Farm takes its baseline of unassigned buildings after this).
    // `except` names a provider that must not be held (a module holding the others while it spends must not wait for itself).
    async holdAll(who, except) { await Promise.all([...reserveProviders].filter(([n]) => n !== except).map(async ([, p]) => { try { await p.hold?.(who); } catch (e) { console.error(e); } })); },
    releaseAll(who, except) { for (const [n, p] of reserveProviders) { if (n === except) continue; try { p.release?.(who); } catch (e) { console.error(e); } } },
  };

  // ---- saved floor designs shared by Autopilot (floor upgrades) and Core plan (furniture floors) --------------------------
  // "x,y:item:rot" cells. Scored with the game's engine.evaluateLayout on 2026-11-22: Workshop v1 = x5 on Frame Timber, Make Bookshelf,
  // Make Table, Make Chair (one input); Rivet x3 = x3 on Rivet Iron Frame, Make Bench, Make Desk (two inputs).
  // mineX3 = x3 merge on a 5x2 Mine (Extract, no inputs; proven max), smeltX3 = Smelt x3 on the Smelter: both moved from Autopilot's floor library.
  const floorDesigns = Object.freeze({
    workshopV1: '0,0:114:0 0,1:114:0 0,2:114:0 0,3:114:0 0,4:114:0 10,1:123:0 10,2:116:2 10,4:123:0 11,0:123:0 11,1:126:0 11,4:123:0 12,0:123:0 12,1:123:0 12,4:123:0 13,0:123:0 13,1:126:0 13,2:123:1 13,3:123:2 13,4:123:0 14,0:123:0 14,1:123:1 14,2:123:0 14,4:123:0 15,0:116:0 15,2:116:0 15,4:123:0 16,4:123:0 17,4:123:0 2,0:123:0 2,1:123:0 2,2:123:0 2,3:123:0 2,4:123:0 3,0:123:0 3,1:123:1 3,2:127:0 3,3:123:3 3,4:123:0 4,0:116:0 4,2:123:0 4,3:116:0 5,2:123:0 6,2:123:0 7,0:123:0 7,1:123:0 7,2:123:3 7,3:123:0 8,0:123:1 8,1:128:0 8,2:123:1 8,3:127:1 8,4:123:0 9,1:123:0 9,3:123:1 9,4:127:0',
    rivetX3: '0,0:123:0 0,1:123:1 0,2:123:1 0,3:123:1 0,4:123:0 1,0:123:0 1,4:123:0 10,1:123:0 10,2:123:0 10,4:123:0 11,1:123:0 11,2:123:0 11,4:123:0 12,1:123:0 12,2:116:0 12,4:123:0 13,1:123:0 13,4:123:0 14,1:123:0 14,4:123:0 15,0:116:0 15,2:123:0 15,3:116:0 16,2:123:0 17,2:123:0 2,0:126:0 2,1:123:1 2,2:126:1 2,3:123:0 2,4:123:0 3,0:123:0 3,2:123:0 3,3:114:0 3,4:123:0 4,0:114:0 4,2:114:0 4,4:123:0 5,3:123:0 5,4:123:0 6,0:123:0 6,2:123:0 6,3:127:0 6,4:123:3 7,0:123:1 7,1:123:1 7,2:127:0 7,3:123:3 8,2:123:0 9,1:123:0 9,2:126:0 9,3:123:1 9,4:123:0',
    mineX3: '0,0:121:0 0,1:121:0 1,0:123:0 1,1:123:0 2,0:127:0 2,1:123:3 3,0:123:0 4,0:123:0 4,1:121:0',
    smeltX3: '0,0:123:1 0,1:127:1 0,2:123:1 0,3:123:0 1,0:113:0 1,2:123:3 1,3:126:0 2,3:123:0 3,0:123:0 3,2:123:0 3,3:126:0 4,0:123:0 4,1:113:0 4,3:123:0 5,0:123:0 5,3:123:0 6,0:123:0 6,1:123:0 6,2:113:0 7,0:123:0 7,1:123:0 8,0:123:0 8,1:123:0 8,2:123:0 9,0:114:0 9,1:114:0 9,2:114:0',
  });

  const ui = { ensureStyle, ICONS, row, group, field, setModified, inputBox, check, seg, confirmBtn, createPanel, createChrome, createLogView, togglePanel };

  const titleTimer = HAS_DOM ? setInterval(applyTitle, 2000) : 0;
  addEventListener?.('pagehide', flushLedger);

  W.idleCore = {
    version: 1,
    walk, sleep, sleepWake, waitConfirm, tune, markSend, lastRtt, nowTick, seeTick, sock,
    h, makeDraggable, toast, ledger: ledgerApi, ui,
    setBadge, notify, askNotify, notifyPerm, stopAll, reserves, floorDesigns,
    exportConfig, importConfig, exportFile, importFile, missingFields,
    _unload() {
      unloaded = true;
      sock.ws?.removeEventListener('message', onMessage); sock.ws = null;
      if (HAS_DOM) removeEventListener('keydown', onKey, true);
      clearInterval(titleTimer);
      flushLedger();
      if (HAS_DOM) { uiStyleEl?.remove(); toastBox?.remove(); uiStyleEl = toastBox = null; dockObs?.disconnect(); dockObs = null; }
    },
  };
})();
} catch (e) { console.error('[IdleCorp] shared core failed to load:', e); }
// @@END core

// ============================================================================
// 1b. PACER AND MEASURE (window.idleCore.pacer, window.idleCore.measure)
// ============================================================================
// Human-looking waits and a command budget for every module that sends commands, plus the robust
// statistics the planner measures with. Everything is injectable (clock, sleep, rng) so tests run
// without real time.
//   const p = core.pacer({ now, sleep, rng, cmdsPerMin })   // core.pacer.default: real time
//   p.draw(kind) / await p.wait(kind) / await p.beforeCommand() / p.noteResult(ok) / p.noteConfirm({ ok, rtt })
//   core.measure.get(name).add(x) / .median / .mad / .p90;  slope(points);  estimate(name, prior)
// @@MODULE pacer
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');

  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // ---- measure: rolling robust statistics ------------------------------------
  const all = new Map();
  function series(name, { window = 40 } = {}) {
    if (all.has(name)) return all.get(name);
    let vals = [];
    const s = {
      add(x) { if (Number.isFinite(x)) { vals.push(x); if (vals.length > window) vals.shift(); } },
      get n() { return vals.length; },
      get median() { return median(vals); },
      // median absolute deviation: one slow reply barely moves it
      get mad() { const m = median(vals); return m === null ? null : median(vals.map((v) => Math.abs(v - m))); },
      // nearest rank
      get p90() { if (!vals.length) return null; return [...vals].sort((a, b) => a - b)[Math.ceil(0.9 * vals.length) - 1]; },
      get mean() { return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; },
      get last() { return vals.length ? vals[vals.length - 1] : null; },
      values: () => [...vals],
      toJSON: () => ({ window, values: [...vals] }),
      load(json) { vals = (json?.values ?? []).filter(Number.isFinite).slice(-window); },
    };
    all.set(name, s);
    return s;
  }

  // Theil-Sen: median of all pairwise slopes, so a few outliers (a purchase, a sale) do not bend it.
  // Per hour; null when there is too little to say anything.
  const MAX_SLOPE_POINTS = 60;   // pairwise work is quadratic: 360 samples would sort ~65k slopes every few seconds
  function slope(points) {
    if (!points || points.length < 3) return null;
    if (points.length > MAX_SLOPE_POINTS) {
      const step = (points.length - 1) / (MAX_SLOPE_POINTS - 1);
      points = Array.from({ length: MAX_SLOPE_POINTS }, (_, i) => points[Math.round(i * step)]);   // evenly spaced, first and last kept
    }
    const ts = points.map((p) => p.t);
    if (Math.max(...ts) - Math.min(...ts) < 60000) return null;
    const out = [];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dt = points[j].t - points[i].t;
        if (dt !== 0) out.push(((points[j].v - points[i].v) / dt) * 3600000);
      }
    }
    return median(out);
  }

  function estimate(name, prior, minN = 8) {
    const s = series(name);
    return s.n >= minN ? { value: s.median, n: s.n, source: 'measured' } : { value: prior, n: s.n, source: 'prior' };
  }

  // Round-trip time of one command: start at ws.send, end when the confirming Diff arrives. A reply
  // that never came (ok = false) has no round trip, so it is returned but not recorded.
  const rttStart = (tag) => ({ tag, t: clock() });
  function rttEnd(token, ok = true) {
    const rtt = clock() - token.t;
    if (ok) {
      series('rtt').add(rtt);
      if (token.tag) series('rtt:' + token.tag).add(rtt);
    }
    return rtt;
  }

  core.measure = {
    series, get: (name) => series(name), slope, estimate, rttStart, rttEnd,
    snapshot: () => Object.fromEntries([...all].map(([k, s]) => [k, { n: s.n, median: s.median, p90: s.p90, mad: s.mad, last: s.last }])),
    save: () => Object.fromEntries([...all].map(([k, s]) => [k, s.toJSON()])),
    restore(obj) { for (const [k, json] of Object.entries(obj ?? {})) series(k, { window: json?.window ?? 40 }).load(json); },
  };

  // ---- pacer -------------------------------------------------------------------
  const DRIFT_STEP = 0.02;   // per draw; ~400 draws (about 10 min of cycles) to wander across the band
  const POLL_SIGMA = 0.25;   // poll: roughly +-40% around 3 s
  const THINK_P = 1 / 22;    // chance that a cycle gap gets a 4-20 s think pause
  const WINDOW_MS = 60000;
  const SHORT_MS = 0.25;     // a sleep this much short of its target is topped up once

  function createPacer(opts = {}) {
    const now = opts.now ?? clock;
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const rng = opts.rng ?? Math.random;
    const cmdsPerMin = opts.cmdsPerMin ?? 20;
    const medianMs = { before: 500, step: 400, cycle: 600, poll: 3000, reconnect: 1000, ...opts.medianMs };
    const sigma = opts.sigma ?? 0.55, minMs = opts.minMs ?? 120, maxMs = opts.maxMs ?? 12000, thinkP = opts.thinkP ?? THINK_P;

    let drift = 1, debt = 0, factor = 1, okRun = 0, trips = 0;
    const cmds = [];                       // issue times inside the last minute
    let fails = 0, recent = [], tripped = null;

    const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

    function draw(kind) {
      const base = medianMs[kind];
      if (!(base > 0)) throw new Error('unknown pacer kind: ' + kind);
      drift = clamp(drift + (rng() * 2 - 1) * DRIFT_STEP, 0.75, 1.25);
      const sig = kind === 'poll' ? POLL_SIGMA : sigma;
      // poll keeps its mean (not its median) on target, it is a rate
      const centre = base * drift * factor * (kind === 'poll' ? Math.exp(-sig * sig / 2) : 1);
      const hi = maxMs * factor;
      let v;
      // redraw instead of clipping: a clip would pile many draws on one exact value
      for (let i = 0; i < 16; i++) { v = centre * Math.exp(sig * gauss()); if (v >= minMs && v <= hi) break; }
      v = clamp(v, minMs, hi);
      if (kind === 'cycle' && rng() < thinkP) v += 4000 + rng() * 16000;
      return v;
    }

    // setTimeout only does whole milliseconds: sleep the floor, top up the shortfall once, and carry
    // what is still over or under into the next wait so the average matches the drawn delays.
    async function wait(kind) {
      const drawn = draw(kind);
      const target = Math.max(0, drawn - debt);
      const t0 = now();
      await sleep(Math.floor(target));
      let actual = now() - t0;
      if (target - actual > SHORT_MS) { await sleep(target - actual); actual = now() - t0; }
      debt = clamp(actual - drawn, -5, 5);
      core.measure.get('own-wait').add(actual);
      return { drawn, actual };
    }

    function prune(t) { while (cmds.length && t - cmds[0] >= WINDOW_MS) cmds.shift(); }

    async function beforeCommand() {
      const start = now();
      for (;;) {
        const t = now();
        prune(t);
        if (cmds.length < cmdsPerMin) { cmds.push(t); return t - start; }
        await sleep(cmds[0] + WINDOW_MS - t + 1);   // +1 ms: whole-ms sleeps must still clear the window
      }
    }

    function noteResult(ok) {
      if (!ok) { factor = Math.min(8, factor * 1.5); okRun = 0; return; }
      if (++okRun >= 20) { factor = Math.max(1, factor / 1.5); okRun = 0; }
    }

    // The breaker keeps its own rtt window so a fresh pacer starts clean; it latches until resetBreaker.
    function noteConfirm({ ok, rtt }) {
      if (ok) { fails = 0; if (Number.isFinite(rtt)) { recent.push(rtt); if (recent.length > 40) recent.shift(); } } else fails++;
      if (tripped) return;
      if (fails >= 3) tripped = fails + ' unconfirmed commands in a row';
      else if (recent.length >= 8) {
        const lastFive = median(recent.slice(-5)), base = median(recent.slice(0, -5));
        if (lastFive > 5 * base) tripped = 'rtt median ' + Math.round(lastFive) + ' ms is over 5x its baseline ' + Math.round(base) + ' ms';
      }
      if (tripped) trips++;
    }

    function resetBreaker() { fails = 0; recent = []; tripped = null; }
    function clearTrips() { trips = 0; }   // a new run starts with no trips behind it

    function load(s) {
      factor = clamp(Number(s?.factor) || 1, 1, 8);
      drift = clamp(Number(s?.drift) || 1, 0.75, 1.25);
      debt = clamp(Number(s?.debt) || 0, -5, 5);
      trips = Number(s?.trips) | 0;
    }

    return {
      draw, wait, beforeCommand, noteResult, noteConfirm, resetBreaker, clearTrips, load,
      cmdsInLastMinute() { prune(now()); return cmds.length; },
      breaker: () => ({ open: !!tripped, reason: tripped }),
      state: () => ({ factor, drift, debt, trips }),
      get factor() { return factor; },
      get tripCount() { return trips; },
    };
  }

  core.pacer = Object.assign(createPacer, { default: createPacer() });
})();
} catch (e) { console.error('[IdleCorp] pacer failed to load:', e); }
// @@END pacer
// ============================================================================
// PLANNER (window.idleCore.planner)
// ============================================================================
// Pure decision functions for the CD farm's Auto mode: CD per type, price ladders, item surplus,
// the greedy batch plan, the gates and the land check. No DOM, sockets or timers. Money is integer cents.
// @@MODULE planner
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');

  // Frame CD weights, by item name (ids differ between catalogs).
  const FRAME_CD = { 'Wooden Frame': 2, 'Iron Frame': 4, 'Wired Frame': 8, 'Light Frame': 16, 'Machine Frame': 32, 'Automated Frame': 64, 'Smart Frame': 128 };
  const STARTERS = [0, 10];
  const dollars = (c) => '$' + (c / 100).toFixed(2);

  const normCache = new WeakMap();
  function normalize(raw) {
    if (raw.byId) return raw;
    if (normCache.has(raw)) return normCache.get(raw);
    const key = (arr) => Object.fromEntries((arr ?? []).map((x) => [x.id, x]));
    const c = { byId: true, items: key(raw.items), buildings: key(raw.buildings), recipes: key(raw.recipes) };
    normCache.set(raw, c);
    return c;
  }

  function cdOf(catalog, b) {
    const C = normalize(catalog);
    const bld = typeof b === 'object' ? b : C.buildings[b];
    let cd = 0;
    for (const { item, amount } of bld?.build_items ?? []) cd += amount * (FRAME_CD[C.items[item]?.name] ?? 0);
    return Math.max(1, cd);
  }

  const price = (baseCents, owned, i) => Math.floor(baseCents * (20 + owned + i) / 20);
  function batchCost(baseCents, owned, n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += price(baseCents, owned, i);
    return s;
  }
  // n = 0-based index among bought acres (the starter acres are free and not counted).
  function acrePrice(first, n) {
    let p = first;
    for (let i = 0; i < n; i++) p = Math.floor(p * 41 / 40);
    return p;
  }
  function landCost(first, landBought, k) {
    let s = 0;
    for (let j = 0; j < k; j++) s += acrePrice(first, landBought + j);
    return s;
  }

  // Best open bid, else base value while a running recipe consumes it, else 0.
  function itemValues({ catalog, bids = {}, runningInputs = [] }) {
    const C = normalize(catalog);
    const inUse = new Set([...runningInputs].map(Number));
    const out = {};
    for (const it of Object.values(C.items)) out[it.id] = Math.max(bids[it.id] ?? 0, inUse.has(it.id) ? it.base_value : 0);
    return out;
  }

  function surplus({ stock = {}, reserve = {} }) {
    const out = {};
    for (const [item, n] of Object.entries(stock)) out[item] = Math.max(0, n - (reserve[item] ?? 0));
    return out;
  }

  // A draining item is only usable while the surplus left after this need still covers 2 h of the farm's burn.
  function itemOk({ need, stock = 0, reserve = 0, netSupply, burn = 0 }) {
    const sur = Math.max(0, stock - reserve);
    if (sur < need) return { ok: false, reason: 'short' };
    if (netSupply !== undefined && netSupply < 0 && sur - need < 2 * burn) return { ok: false, reason: 'draining' };
    return { ok: true, reason: null };
  }
  const itemCheck = (input, item, need) => itemOk({
    need, stock: input.stock?.[item] ?? 0, reserve: input.reserve?.[item] ?? 0,
    netSupply: input.netSupply?.[item], burn: input.burn?.[item] ?? 0,
  });

  function candidates(input) {
    const C = normalize(input.catalog);
    const unlocked = new Set([...(input.unlocked ?? []), ...STARTERS].map(Number));
    const usable = input.usableAcres ?? 0;
    return Object.values(C.buildings).sort((a, b) => a.id - b.id).map((bld) => {
      const items = (bld.build_items ?? []).map(({ item, amount }) => ({ item, amount }));
      const matCents = items.reduce((a, { item, amount }) => a + amount * (input.itemValue?.[item] ?? 0), 0);
      let dropped = null;
      if (!unlocked.has(bld.id)) dropped = 'locked';
      else if (input.quarantine?.[bld.id]) dropped = 'quarantined';
      else if (bld.acres > usable) dropped = 'no-acres';
      else for (const { item, amount } of items) {
        const r = itemCheck(input, item, amount);
        if (!r.ok) { dropped = 'item:' + item + ':' + r.reason; break; }
      }
      return { b: bld.id, name: bld.name, cd: cdOf(C, bld), acres: bld.acres, base: bld.cost, items, matCents, dropped };
    });
  }

  function plan(input) {
    const C = normalize(input.catalog);
    const { money = 0, floor = 0, R = Infinity, T = 0, TperType = 0, I = 0, minUnits = 1, maxBatch = 100, maxTypes = 2 } = input;
    const cands = candidates(input);
    const live = cands.filter((c) => !c.dropped);
    const owned = (b) => input.owned?.[b] ?? 0;
    const n = {}, order = [], barred = new Set();
    let acresLeft = input.usableAcres ?? 0, gross = 0, cdTotal = 0, units = 0, binding = null, blocked = null;
    const Reff = Math.min(R, 1e9);
    const notes = [];

    while (true) {
      if (cdTotal >= R) { binding = 'target'; break; }
      if (units >= maxBatch) { binding = 'batch'; break; }
      const steps = live.map((c) => {
        const k = n[c.b] ?? 0;
        const unitGross = price(c.base, owned(c.b), k);
        const unitCost = unitGross - Math.floor(c.base / 2) + c.matCents;
        let block = null;
        if (c.acres > acresLeft) block = 'acres';
        else if (money - (gross + unitGross) < floor) block = 'money';
        else if (c.items.some(({ item, amount }) => !itemCheck(input, item, (k + 1) * amount).ok)) block = 'items';
        else if (!k && order.length >= maxTypes) block = 'types';
        else if (!k && barred.has(c.b)) block = 'time';
        return { c, k, unitGross, unitCost, perCd: unitCost / c.cd, block };
      }).sort((a, b) => a.perCd - b.perCd || a.c.b - b.c.b);
      const best = steps.find((s) => !s.block);
      if (!best) { blocked = steps[0] ?? null; binding = blocked?.block ?? null; break; }
      const types = order.length + (best.k ? 0 : 1);
      // Time value of shortening every remaining cycle by growing the batch from N to N + cd.
      const N = cdTotal;
      // Cycle time is T plus a step per extra type; a new type lengthens every cycle, so compare the real before and after.
      const T0 = T + TperType * Math.max(0, order.length - 1), T1 = T + TperType * (types - 1);
      const worth = N === 0 || units < minUnits
        || best.unitCost <= I / 3600 * Reff * (T0 / N - T1 / (N + best.c.cd));
      if (!worth) {
        // A new type pays an extra step on every cycle; the next unit of a type already in the plan does not, so try that instead.
        if (!best.k) { barred.add(best.c.b); continue; }
        binding = 'time'; break;
      }
      if (!best.k) order.push(best.c);
      n[best.c.b] = best.k + 1;
      gross += best.unitGross; cdTotal += best.c.cd; acresLeft -= best.c.acres; units++;
    }

    // No live candidate at all: say whether acres or items emptied the list.
    if (!live.length) binding = cands.some((c) => c.dropped === 'no-acres') ? 'acres' : cands.some((c) => c.dropped?.startsWith('item:')) ? 'items' : null;

    const out = order.map((c) => {
      const g = batchCost(c.base, owned(c.b), n[c.b]);
      return { b: c.b, name: c.name, n: n[c.b], cd: c.cd, grossCents: g, netCents: g - n[c.b] * Math.floor(c.base / 2), matCents: n[c.b] * c.matCents };
    });
    const netCents = out.reduce((a, u) => a + u.netCents, 0);
    const matCents = out.reduce((a, u) => a + u.matCents, 0);

    let wait = null;
    if (!units) {
      if (binding === 'money') {
        const shortfallCents = floor + blocked.unitGross - money;
        wait = { gate: 'G5', reason: 'need ' + dollars(shortfallCents) + ' more above the floor', shortfallCents };
      } else if (binding === 'acres') wait = { gate: 'G5', reason: 'no free acres above the spare' };
      else if (binding === 'items') {
        const why = cands.filter((c) => c.dropped?.startsWith('item:')).map((c) => {
          const [, item, reason] = c.dropped.split(':');
          return c.name + ' needs ' + (C.items[item]?.name ?? 'item ' + item) + ' (' + reason + ')';
        });
        wait = { gate: 'G5', reason: 'no candidate has its build items: ' + why.join(', ') };
      }
    }
    for (const c of cands) if (c.dropped && c.dropped !== 'locked') notes.push(c.name + ' skipped: ' + c.dropped);
    if (binding) notes.push('bound by ' + binding);

    return {
      units: out, cdTotal, grossCents: gross, netCents,
      perCdCents: cdTotal ? Math.round((netCents + matCents) / cdTotal) : 0,
      wait, binding, candidates: cands, notes,
    };
  }

  function gates({ need, cd = 0, prereqsMet = true, prereqNote = '', organicCdPerHour = null, maxHours = 6 }) {
    if (!Number.isFinite(need) || need - cd <= 0) return { run: false, gate: 'G2', reason: 'no CD needed' };
    if (!prereqsMet) return { run: false, gate: 'G3', reason: 'waiting on ' + prereqNote + ', cash is better spent there' };
    if (organicCdPerHour > 0) {
      const h = (need - cd) / organicCdPerHour;
      if (h <= maxHours) return { run: false, gate: 'G4', reason: 'organic CD will cover it in ' + h.toFixed(1) + ' h' };
    }
    return { run: true };
  }

  // Extra acres pay back through faster cycles, so they are only bought while acres cap the batch.
  function land(input) {
    const { allow = 'off', landBought = 0, firstAcre, wall = Infinity, hoursUntilBought = () => Infinity, paybackHours = 1,
      plan: p, unitNeed, R = Infinity, T = 0, I = 0, money = 0, floor = 0 } = input;
    const N = p?.cdTotal ?? 0;
    const none = (note) => ({ buy: 0, priceCents: 0, realCostCents: 0, savingCents: 0, note });
    if (!N || !unitNeed) return none('no farm plan yet');
    const acresBind = p.binding === 'acres';
    const Reff = Math.min(R, 1e9), cdPerAcre = unitNeed.cd / unitNeed.acres;
    const opts = [1, 2, 3, 4].map((k) => {
      const priceCents = landCost(firstAcre, landBought, k);
      const unitPrice = acrePrice(firstAcre, landBought + k - 1);
      const h = hoursUntilBought(k);
      const realCostCents = Number.isFinite(h) ? Math.round(priceCents * Math.min(1, h / paybackHours)) : priceCents;
      const hoursSaved = T / 3600 * Reff * (1 / N - 1 / (N + k * cdPerAcre));
      const savingCents = Math.round(I * hoursSaved);
      const allowed = acresBind && allow !== 'off' && unitPrice <= wall
        && (allow === 'plan' ? Number.isFinite(h) : unitPrice <= allow)
        && money - priceCents >= floor + p.grossCents;
      return { k, priceCents, realCostCents, savingCents, hoursSaved, value: savingCents - realCostCents, allowed };
    });
    const pick = opts.filter((o) => o.allowed && o.value > 0).sort((a, b) => b.value - a.value || a.k - b.k)[0];
    const best = pick ?? [...opts].sort((a, b) => b.value - a.value || a.k - b.k)[0];
    const line = best.k + ' more acre' + (best.k > 1 ? 's' : '') + ' would save ' + best.hoursSaved.toFixed(1) + ' h for ' + dollars(best.priceCents);
    const { priceCents, realCostCents, savingCents } = best;
    return { buy: pick ? pick.k : 0, priceCents, realCostCents, savingCents, note: pick ? 'buying: ' + line : acresBind ? line : line + ' (acres are not the cap)' };
  }

  // FNV-1a over a canonical form, so the regime detector sees order-independent equality.
  function signature({ unlocked = [], running = [], retail = false, bids = [], phase = null }) {
    const sorted = (a) => [...a].map(Number).sort((x, y) => x - y);
    const s = JSON.stringify([sorted(unlocked), sorted(running), !!retail, sorted(bids), phase]);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  }

  core.planner = { normalize, cdOf, price, batchCost, acrePrice, landCost, itemValues, surplus, itemOk, candidates, plan, gates, land, signature, FRAME_CD };
})();
} catch (e) { console.error('[IdleCorp] planner failed to load:', e); }
// @@END planner
// ============================================================================
// CORE MATH (window.idleCore.coreMath)
// ============================================================================
// Pure fixed-point model of the Core Game Plan (scripts/core-plan/my-plan.js, wiki/guides/core-game-plan.md 4.2, 4.3, 4.6, 11.4):
// the Farm/Camp/Dock/Pasture CD ladder, the engine constants from the live catalog, and the land rule
// (income -> T_wall -> last acre inside the rule -> engine acres -> income). No DOM, sockets or timers.
// Money is in dollars (like the spec script). opts.cyclesPerHour overrides the state's CD rate (a measured CD-farm rate).
// opts.planksCap (planks per hour, a failed retail checkpoint): the engine, its Camps / Sawmills and the last acre stop at those planks.
// opts.cdPerHour (a measured CD-farm rate, CD/h): T_wall comes from it instead of the modelled batch (T_wall moves with income).
// @@MODULE core-math
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');

  // Floors the plan assumes: Camp x3, Sawmill x2, Workshop v1 x5.
  const M = { camp: 3, sawmill: 2, workshop: 5 };
  const MIX = [0.4, 0.3, 0.3];                       // Bookshelf, Table, Chair share of planks
  const RETAIL = 1.52, WALL_CD = 755000, BLD_ACRE = 1200, FIXED_EXTRA = 3 + 5;   // Retail Store 3 + Assembly Plant 5
  const FURNITURE = ['Make Bookshelf', 'Make Table', 'Make Chair'];

  // CD ladder: price of the i-th building in a batch = base x (20 + owned + i) / 20, refund 50% of base.
  const TYPES = { farm: { base: 41, cd: 1, items: 0 }, camp: { base: 41, cd: 1, items: 0 }, dock: { base: 150, cd: 1, items: 20 * 1.0 }, pasture: { base: 250, cd: 1, items: 30 * 1.0 } };
  const batchCost = (type, owned, k) => {
    const t = TYPES[type];
    let c = 0;
    for (let i = 0; i < k; i++) c += Math.floor(t.base * 100 * (20 + owned + i) / 20) / 100 - t.base / 2 + t.items;
    return c;
  };
  function bestBatch(type, owned, income, cycles) {
    let best = { k: 1, perCd: batchCost(type, owned, 1), cdH: cycles };
    for (let k = 1; k <= 200; k++) {
      const c = batchCost(type, owned, k);
      if (cycles * c > income) break;
      best = { k, perCd: c / (k * TYPES[type].cd), cdH: cycles * k * TYPES[type].cd, spendH: cycles * c };
    }
    return best;
  }

  // Price of the next acre after n bought ones, starting at `first`.
  function acrePrice(first, n) {
    let p = first;
    for (let i = 0; i < n; i++) p = Math.floor(p * 100 * 41 / 40) / 100;
    return p;
  }

  const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));

  // Engine constants from a raw catalog ({items, recipes} arrays or id-keyed objects). Recipes are found by NAME, items re-keyed by id.
  const modelCache = new WeakMap();
  function engineModel(catalog) {
    if (modelCache.has(catalog)) return modelCache.get(catalog);
    const items = Object.fromEntries(list(catalog.items).map((i) => [i.id, i]));
    const recipes = list(catalog.recipes);
    const R = (n) => {
      const r = recipes.find((x) => x.name === n);
      if (!r) throw new Error('recipe not in catalog: ' + n);
      return r;
    };
    const wood = R('Fell Wood'), saw = R('Saw Planks');
    const campWoodH = wood.outputs[0].amount * M.camp * 3600 / (wood.ticks / 2);
    const smPlanksH = saw.outputs[0].amount * M.sawmill * 3600 / (saw.ticks / 2);
    const woodPerPlank = saw.inputs[0].amount / saw.outputs[0].amount;
    const furn = FURNITURE.map((n) => {
      const r = R(n), o = r.outputs[0];
      const unitsH = M.workshop * o.amount * 3600 / (r.ticks / 2);
      return { name: n.replace('Make ', ''), planksH: unitsH * r.inputs[0].amount, unitsH, rev: unitsH * items[o.item].base_value / 100 * RETAIL };
    });
    const perPlank = furn[0].rev / furn[0].planksH;
    const wsPerPlank = MIX.reduce((a, s, i) => a + s / furn[i].planksH, 0);
    const acresOf = (p) => p * woodPerPlank / campWoodH + p / smPlanksH + 2 * (p * wsPerPlank + 2);
    const planksFor = (E) => {
      let lo = 0, hi = 1e6;
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (acresOf(mid) > E) hi = mid; else lo = mid; }
      return lo;
    };
    const m = { campWoodH, smPlanksH, woodPerPlank, furn, perPlank, wsPerPlank, acresOf, planksFor };
    modelCache.set(catalog, m);
    return m;
  }

  // Cost of buying `want - have` more of a building whose base price is `base` (price ladder base x (20 + n) / 20).
  const costTo = (base, have, want) => {
    let c = 0;
    for (let n = have; n < want; n++) c += Math.floor(base * 100 * (20 + n) / 20) / 100;
    return c;
  };

  // The engine target and land rule as data. state: acres, acrePrice, camps, sawmills, workshops, fixedAcres, fixedExtra (acres of the Retail Store / Assembly Plant not built yet, default 8), cyclesPerHour, cdBufferAcres.
  function landRule(state, catalog, opts = {}) {
    const m = engineModel(catalog);
    const st = state;
    const cycles = opts.cyclesPerHour ?? st.cyclesPerHour ?? 600;
    const fixed = (st.fixedAcres ?? 0) + (st.fixedExtra ?? FIXED_EXTRA), buffer = st.cdBufferAcres ?? 16;
    const Ecap = opts.planksCap != null ? m.acresOf(Math.max(0, opts.planksCap)) : Infinity;   // engine acres the capped planks need
    let E = Math.min(150, Ecap), rule = null;
    for (let it = 0; it < 40; it++) {
      const planks = m.planksFor(E), income = planks * m.perPlank;
      const b = bestBatch('farm', 0, income, cycles), tWall = WALL_CD / (opts.cdPerHour > 0 ? opts.cdPerHour : b.cdH);
      let price = st.acrePrice, last = st.acres;
      const rev = planks * m.perPlank / (E - 4);   // marginal furniture acre: reserve Workshops (Frame Timber, Rivet) excluded
      for (let a = st.acres; a < 360; a++) {
        if ((price + BLD_ACRE) / rev <= tWall / 3) last = a + 1; else break;
        price = Math.floor(price * 100 * 41 / 40) / 100;
      }
      rule = { planks, income, b, tWall, last };
      const Enew = Math.min(Ecap, Math.max(0, Math.max(last, st.acres) - fixed - buffer));
      if (Math.abs(Enew - E) < 0.5) { E = Enew; break; }
      E = (E + Enew) / 2;
    }
    if (Ecap < Infinity) rule.last = Math.min(rule.last, Math.max(st.acres, Math.ceil(Ecap + fixed + buffer)));   // no acre the capped engine cannot fill
    const acreN = Math.max(rule.last, st.acres);
    const planks = m.planksFor(E);
    const camps = Math.ceil(planks * m.woodPerPlank / m.campWoodH), saws = Math.ceil(planks / m.smPlanksH);
    const ws = MIX.map((s, i) => Math.ceil(planks * s / m.furn[i].planksH));
    const wsTotal = ws.reduce((a, b) => a + b) + 2;   // + Frame Timber, Rivet
    const buildingCost = costTo(41, st.camps, Math.max(st.camps, camps)) + costTo(400, st.sawmills, Math.max(st.sawmills, saws)) + costTo(5000, st.workshops, Math.max(st.workshops, wsTotal));
    let landCost = 0, pr = st.acrePrice;
    for (let a = st.acres; a < acreN; a++) { landCost += pr; pr = Math.floor(pr * 100 * 41 / 40) / 100; }
    return {
      fixedAcres: fixed, bufferAcres: buffer,
      income: rule.income, batch: rule.b.k, perCd: rule.b.perCd, cdPerHour: rule.b.cdH,
      tWall: rule.tWall, limitHours: rule.tWall / 3, tWallFrom: opts.cdPerHour > 0 ? 'measured' : 'model',
      lastAcre: rule.last, acresToBuy: Math.max(0, rule.last - st.acres), landCost,
      targetAcres: acreN, engineAcres: E, planksH: planks, camps, sawmills: saws,
      workshops: { bookshelf: ws[0], table: ws[1], chair: ws[2], frameTimber: 1, rivet: 1, total: wsTotal },
      revenueH: planks * m.perPlank, buildingCost,
      need: { camps: Math.max(0, camps - st.camps), sawmills: Math.max(0, saws - st.sawmills), workshops: Math.max(0, wsTotal - st.workshops) },
    };
  }

  core.coreMath = { TYPES, batchCost, bestBatch, acrePrice, engineModel, landRule };
})();
} catch (e) { console.error('[IdleCorp] core-math failed to load:', e); }
// @@END core-math// ============================================================================
// 1. CD FARM
// ============================================================================
// Open "CD Farm" in the game's sidebar (or click the CD chip in the top bar).
// Settings there map to cfg below; the console API also works:
//   cdFarm.start({ budget: 'floor', minMoney: 100000, fullBatch: true, targetCd: 20000 })
//   cdFarm.stop() / cdFarm.resume() / cdFarm.status() / cdFarm.reset()
//
// Each Lumber Camp or Farm (Settings > Building, or start({ building: 10 })) earns 1 CD on build;
// CD is kept after demolish. Both cost $41 base, refund 50% of base ($20.50) and need 1 free acre.
// The i-th one costs base x (20 + owned + i) / 20, where owned counts every building of that type
// you hold, so pick the type you own fewer of (the wiki's CD farm section has the table).
// While running, any unassigned buildings of the chosen type above the count at start are
// treated as the farm's own and may be demolished.
//
// With Autopilot (same file): before taking that count, CD Farm asks Autopilot to pause
// after its current step (earlyGame.hold) and lets it go on when the run ends. Autopilot also
// starts CD Farm itself when its CD booster is set to "CD Farm" (start({ runOnly: true, by })):
// those settings apply to that run only and yours come back when it stops.

try {
(() => {
  const core = window.idleCore;
  if (!core) throw new Error('the shared core did not load');
  const KEY = 'cdFarm.v1';
  if (window.cdFarm) {
    // Replace a previous copy without letting it overwrite the saved state.
    if (window.cdFarm._unload) window.cdFarm._unload();
    else { window.cdFarm.stop(); window.cdFarm.panel(false); }
  }

  const REGION = 0;        // Heartland
  const MONEY = 0;         // items[0], cents
  const CD = 24;           // items[24], Construction Data
  // Buildings the farm can cycle: money only (no build items), 1 acre and 1 CD each, same price curve.
  const BUILDINGS = [
    { id: 0, name: 'Lumber Camp', plural: 'camps', base: 41 },
    { id: 10, name: 'Farm', plural: 'farms', base: 41 },
  ];
  const STARTER_ACRES = 25;
  const RATE_WINDOW_MS = 15 * 60 * 1000;

  // Acres per building id (wiki/data/buildings.md).
  const ACRES = [1, 2, 2, 3, 1, 2, 2, 6, 2, 5, 1, 1, 2, 4, 2, 3, 1, 5, 1, 3, 8, 1, 2, 2, 3, 1, 1, 1, 6, 1, 2, 1, 1, 1, 3, 1, 1, 2, 3];

  const cfg = {
    building: 'auto',      // 'auto': the planner picks types and batch every cycle; or an id to cycle: 0 Lumber Camp, 10 Farm
    batch: 10,             // max buildings per cycle
    fullBatch: false,      // true: only build when all `batch` camps fit (land + money); never a smaller batch
    cycles: Infinity,      // stop after this many cycles
    reserveAcres: 10,      // free acres never used by the farm (always kept spare)
    minMoney: 30000,       // cash reserve ($): never spend below this
    // 'reserve': floor is minMoney; stops when the next batch would go below it.
    // 'floor':   floor is minMoney; waits for income instead of stopping (also waits to start if money is below it).
    // 'income':  floor is max(minMoney, money at start); waits for income instead of stopping.
    budget: 'reserve',
    maxSpendPerMin: Infinity, // net build spend cap per rolling minute ($)
    maxSpend: Infinity,    // stop once net spend ($) reaches this
    targetCd: Infinity,    // stop once CD reaches this (ETA uses 20,000 if unset)
    existingPool: 'keep',  // unassigned camps found at start: 'keep' or 'demolish'
    autoResume: false,     // resume an interrupted run automatically when the script loads
    pace: 'balanced',      // Auto: 'thrifty' | 'balanced' | 'fast' (how much waiting for CD costs)
    land: 'plan',          // Auto: 'off' | 'plan' (acres only inside Autopilot's own land plan) | max $ per acre
    autoStart: true,       // Auto: start by itself when the engine needs CD (switched off when you press Stop)
    autoFloor: 0,          // Auto: money floor ($) on top of Autopilot's power-bill floor
    maxTypes: 2,           // Auto: building types per cycle (each adds a Buy and a Demolish round trip)
    cmdsPerMin: 20,        // command budget per rolling minute (shared pacer)
    dryRun: false,         // Auto: log what it would build, send nothing
    timeoutMs: 8000,       // max wait for the server to confirm a step
    reconnectMs: 60000,    // max wait for the socket to come back
    maxReconnects: 3,      // consecutive reconnects before giving up
  };

  const DEFAULTS = { ...cfg };

  class ConnError extends Error {}

  const freshStats = () => ({
    cycles: 0, built: 0, spent: 0, refunded: 0,
    cdStart: 0, moneyStart: 0, startedAt: 0, baselinePool: 0,
    samples: [], spends: [], last: '', by: '', building: null,
    baseline: {}, types: [], byType: {}, land: 0, acresBought: 0, holding: {},   // Auto: per-type pool baseline, types touched, spend per type
  });

  let running = false;
  let active = false;      // a run (loop) is still executing, even after stop()
  let unloaded = false;
  let resumable = false;
  let stopReason = '';
  let phase = 'idle';
  let inFlight = null;
  let stats = freshStats();
  let restoreCfg = null;   // your settings, kept while a runOnly run (e.g. started by Autopilot) uses its own

  // The building the farm cycles. A run (even an interrupted one) keeps the building it started with,
  // so changing the setting can never make cleanup touch the wrong buildings.
  const farmId = () => { const b = runBuilding(); return typeof b === 'number' ? b : 0; };   // Auto: the shared read() just looks at Lumber Camps
  const isAuto = () => runBuilding() === 'auto';
  const bld = () => BUILDINGS.find((b) => b.id === farmId()) ?? BUILDINGS[0];
  const unitRefund = () => bld().base / 2; // demolish refunds 50% of base ($)

  // ---- persistence (#5) --------------------------------------------------

  const replacer = (_k, v) => (v === Infinity ? 'Infinity' : v);
  const reviver = (_k, v) => (v === 'Infinity' ? Infinity : v);

  function save() {
    if (unloaded) return;
    try { localStorage.setItem(KEY, JSON.stringify({ cfg, stats, running, inFlight, stopReason, restoreCfg, quarantine, measure: core.measure?.save() }, replacer)); } catch {}
  }
  function load() {
    try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s, reviver) : null; } catch { return null; }
  }

  // ---- socket listener (#6) ----------------------------------------------
  // Shared with Autopilot: core.sock holds the Diff / mutation counters, core.walk() reads the game state.

  // ---- state access ------------------------------------------------------
  // (core.walk: one cached walk of the game's React state)

  function campCost(owned, n) {
    let c = 0;
    for (let i = 0; i < n; i++) c += bld().base * (20 + owned + i) / 20;
    return c;
  }

  const moneyFloor = () => (cfg.budget === 'income' ? Math.max(cfg.minMoney, stats.moneyStart) : cfg.minMoney);

  // Live snapshot. Every decision in the script goes through this.
  function read(fresh = false) {
    const { ws, st } = core.walk(fresh);
    if (!st) return null;
    const regionPool = st.building_pool?.[REGION] ?? {};
    const unassignedCamps = regionPool[farmId()] ?? 0;

    let campsInGroups = 0, acresUsed = 0;
    for (const g of Object.values(st.groups)) {
      if ((g.region ?? REGION) !== REGION) continue;
      if (g.building === farmId()) campsInGroups += g.count;
      acresUsed += (ACRES[g.building] ?? 1) * g.count;
    }
    for (const [b, n] of Object.entries(regionPool)) acresUsed += (ACRES[b] ?? 1) * n;

    const acresOwned = STARTER_ACRES + (st.land_bought?.[REGION] ?? 0);
    const money = (st.items?.[MONEY] ?? 0) / 100;
    const ownedCamps = campsInGroups + unassignedCamps;
    const freeAcres = Math.max(0, acresOwned - acresUsed);
    const usableAcres = Math.max(0, freeAcres - cfg.reserveAcres);
    // 'income' keeps the money you have at Start; with no run on, that is the money now (stats.moneyStart is from the last run).
    const floor = cfg.budget === 'income' && !(running || active || resumable) ? Math.max(cfg.minMoney, money) : moneyFloor();

    let affordable = 0;
    while (affordable < cfg.batch && money - campCost(ownedCamps, affordable + 1) >= floor) affordable++;
    const nextBatch = Math.min(cfg.batch, usableAcres, affordable);

    return {
      money, cd: st.items?.[CD] ?? 0,
      unassignedCamps, campsInGroups, ownedCamps,
      acresOwned, acresUsed, freeAcres, usableAcres, moneyFloor: floor,
      nextBatch, nextBatchCost: campCost(ownedCamps, nextBatch),
      mutTick: st.ssi?.last_user_mutation_tick ?? 0,
      wsOpen: ws?.readyState === 1, ws,
    };
  }

  // read() that treats a missing game state as a connection problem.
  function mustRead(fresh = false) {
    const r = read(fresh);
    if (!r) throw new ConnError('game state not found');
    return r;
  }

  // ---- actions -----------------------------------------------------------

  const sleep = core.sleep;

  // ---- pacing and measurement ----------------------------------------------
  // Every wait goes through the shared pacer (core.pacer): log-normal, fractional-millisecond, drifting
  // delays plus a command budget per minute. Round trips are timed from ws.send to the confirming Diff.
  const hr = () => globalThis.performance?.now?.() ?? Date.now();
  let pacer = null;
  const getPacer = () => (pacer ||= core.pacer({ cmdsPerMin: cfg.cmdsPerMin }));
  const acc = { wait: 0 };   // own waiting inside the current cycle (ms), to tell it from server time
  async function pause(kind) { const w = await getPacer().wait(kind); acc.wait += w.actual; return w; }
  async function jitter() { await getPacer().beforeCommand(); await pause('before'); }

  // Sends a command; returns the mutation-Diff count at send time.
  function send(msg) {
    const r = mustRead(true);
    if (!r.wsOpen) throw new ConnError('socket not open');
    const d = core.markSend(r.mutTick); // only a later mutation confirms this command
    r.ws.send(JSON.stringify(msg));
    return d;
  }

  // Waits until the server has applied a player command after this one was sent
  // AND the state matches. The client applies commands locally first, and
  // production Diffs arrive on their own, so neither alone is proof.
  // Falls back to state polling if no text messages have been seen on the socket.
  // Waits for the server to confirm a command, and feeds the round trip (core.lastRtt: ws.send to the
  // confirming Diff, sub-millisecond) to the measurements and the pacer's backoff / breaker.
  async function waitConfirm(pred, d0, rd = read) {
    const r = await core.waitConfirm({ read: rd, pred, d0, timeoutMs: cfg.timeoutMs, closed: () => { throw new ConnError('socket closed while waiting'); } });
    const rtt = r ? core.lastRtt() : null;
    const p = getPacer();
    p.noteConfirm({ ok: !!r, rtt }); p.noteResult(!!r);
    if (rtt != null) core.measure.get('rtt').add(rtt);
    return r;
  }

  // Returns the observed money change (includes passive income during the wait).
  async function demolish(n, { count = true } = {}) {
    await jitter();
    const r0 = mustRead();
    inFlight = { action: 'demolish', amount: n, at: Date.now() }; save();
    const d = send({ type: 'DemolishBuilding', building: farmId(), amount: n, region: REGION });
    const r1 = await waitConfirm((r) => r.unassignedCamps <= r0.unassignedCamps - n, d);
    if (!r1) throw new Error(`demolish of ${n} not confirmed`);
    if (count) stats.refunded += n * unitRefund();
    inFlight = null; save();
    return r1.money - r0.money;
  }

  // ---- reconnect (#4) ----------------------------------------------------

  async function waitForSocket() {
    const t0 = Date.now();
    while (running && Date.now() - t0 < cfg.reconnectMs) {
      const r = read();
      if (r?.wsOpen) { await sleep(2000); return true; } // let the fresh Snapshot land
      await sleep(1000);
    }
    return false;
  }

  // Demolish any farm camps left over from an interrupted step. If the
  // interruption hit an unaccounted build, count those camps as built.
  async function reconcile() {
    const pending = inFlight;
    inFlight = null;
    if (isAuto()) return reconcileAuto(pending);
    const r = read();
    if (!r) return;
    const extra = r.unassignedCamps - stats.baselinePool;
    if (extra > 0) {
      if (pending?.action === 'build') {
        const n = Math.min(extra, pending.amount);
        stats.built += n;
        stats.spent += campCost(r.ownedCamps - n, n);
      }
      console.log(`[cdFarm] cleanup: demolishing ${extra} leftover farm ${bld().plural}`);
      await demolish(extra);
    }
    save();
  }

// continues the cd-farm closure from cd-farm-1.js (same try / IIFE)
  // ---- cycle -------------------------------------------------------------

  const netSpend = () => stats.spent - stats.refunded;
  const stopWith = (reason) => { stopReason = reason; return 'stop'; };

  // Returns 'ok' | 'wait' | 'stop'.
  async function cycle() {
    const r0 = read();
    if (!r0) throw new ConnError('game state not found');
    if (r0.cd >= cfg.targetCd) return stopWith(`reached target CD ${fmt(cfg.targetCd)}`);
    if (netSpend() >= cfg.maxSpend) return stopWith(`reached max spend $${fmt(cfg.maxSpend)}`);
    if (r0.usableAcres === 0) return stopWith(`no free acres above the ${cfg.reserveAcres}-acre reserve (${r0.freeAcres} free)`);
    if (cfg.fullBatch && r0.usableAcres < cfg.batch) return stopWith(`need ${cfg.batch} free acres above the ${cfg.reserveAcres}-acre reserve for a full batch, have ${r0.usableAcres}`);
    if (cfg.fullBatch ? r0.nextBatch < cfg.batch : r0.nextBatch === 0) {
      const want = cfg.fullBatch ? cfg.batch : 1;
      const need = campCost(r0.ownedCamps, want) + r0.moneyFloor - r0.money;
      if (cfg.budget === 'income' || cfg.budget === 'floor') { phase = `waiting for income: $${fmt(need)} more`; return 'wait'; }
      return stopWith(`below cash reserve ($${fmt(r0.money)}, floor $${fmt(r0.moneyFloor)})`);
    }
    const now = Date.now();
    // Build only the camps still needed for the target (r0.cd < targetCd here); a full batch keeps its size.
    const campsToTarget = Number.isFinite(cfg.targetCd) ? Math.max(1, Math.ceil(cfg.targetCd - r0.cd)) : Infinity;
    const n = cfg.fullBatch ? r0.nextBatch : Math.min(r0.nextBatch, campsToTarget);
    const cost = n === r0.nextBatch ? r0.nextBatchCost : campCost(r0.ownedCamps, n);
    const netCost = cost - n * unitRefund();
    stats.spends = stats.spends.filter((s) => now - s.t < 60000);
    const lastMin = stats.spends.reduce((a, s) => a + s.amount, 0);
    if (lastMin > 0 && lastMin + netCost > cfg.maxSpendPerMin) { phase = 'waiting: spend limit'; return 'wait'; }

    // Build. Confirmed on the pool count; CD can be spent on research at the same time.
    phase = 'building';
    await jitter();
    if (!running) return 'stop'; // stopped during the wait; nothing sent yet
    const rb = mustRead();       // fresh baseline after the wait
    if (rb.nextBatch < n) { phase = 'waiting: money or land changed'; return 'wait'; } // the plan above no longer fits
    inFlight = { action: 'build', amount: n, at: Date.now() }; save();
    const d = send({ type: 'BuyBuilding', building: farmId(), amount: n, region: REGION });
    const r1 = await waitConfirm((r) => r.unassignedCamps >= rb.unassignedCamps + n, d);
    if (!r1) {
      const r = mustRead();
      const got = r.unassignedCamps - rb.unassignedCamps;
      if (got > 0) await reconcile();
      throw new Error(`build not confirmed: ${got}/${n} built, CD +${r.cd - rb.cd}`);
    }
    if (r1.cd < rb.cd + n) console.warn(`[cdFarm] CD +${r1.cd - rb.cd} after building ${n} (research spending?)`);
    // Account with the price formula; the money delta also includes passive income.
    const paid = rb.money - r1.money;
    stats.spent += cost;
    stats.built += n;
    stats.spends.push({ t: Date.now(), amount: netCost });
    inFlight = null;
    if (Math.abs(paid - cost) > Math.max(5, cost * 0.05)) {
      console.warn(`[cdFarm] money fell $${fmt(paid)}, expected ~$${fmt(cost)}`);
    }
    save();
    await pause('step');

    // Demolish
    phase = 'demolishing';
    const refund = await demolish(n);
    if (Math.abs(refund - n * unitRefund()) > Math.max(5, n * unitRefund() * 0.2)) {
      console.warn(`[cdFarm] money rose $${fmt(refund)}, expected ~$${fmt(n * unitRefund())} refund`);
    }

    stats.cycles++;
    sample();
    const r2 = mustRead();
    const rt = rates(r2);
    stats.last = `#${stats.cycles} | built ${n} | CD ${fmt(r2.cd)} (+${stats.built}) | $${fmt(r2.money)} | pool ${r2.unassignedCamps} | $/CD ${perCd()}`;
    console.log('[cdFarm] ' + stats.last + (stats.cycles % 10 === 0 ? ` | ${fmtRate(rt.cdh15 ?? rt.cdhAll)} CD/h | ETA ${etaText(rt)}` : ''));
    save();
    if (stats.cycles === 1 || stats.cycles % 10 === 0) core.ledger.add('CD', 'action', stats.last);
    phase = 'running';
    await pause('cycle');
    return 'ok';
  }

  async function runLoop() {
    let reconnects = 0;
    while (running && stats.cycles < cfg.cycles) {
      try {
        const res = isAuto() ? await autoCycle() : await cycle();
        if (res === 'stop') break;
        if (res === 'wait') { save(); await pause('poll'); continue; }
        reconnects = 0;
      } catch (e) {
        if (e instanceof ConnError && reconnects < cfg.maxReconnects) {
          reconnects++;
          phase = `reconnecting (${reconnects}/${cfg.maxReconnects})`;
          console.warn(`[cdFarm] ${e.message}; ${phase}`);
          save();
          if (await waitForSocket()) {
            try { await reconcile(); } catch (e2) { console.warn('[cdFarm] cleanup failed:', e2.message); }
          }
          continue;
        }
        stopReason = 'error: ' + e.message;
        break;
      }
    }
  }

  // ---- Auto mode ---------------------------------------------------------
  // cfg.building === 'auto': core.planner picks the types and the batch every cycle from the live state
  // (see .omc/plans/cd-farm-auto-mode.md). This section only reads state, asks the planner, and sends the
  // same BuyBuilding / DemolishBuilding commands (plus BuyLand) as the manual path.

  const PACE = {
    thrifty: { mult: 0, minUnits: 4, maxHours: 24 },     // cheapest CD, slow
    balanced: { mult: 0.25, minUnits: 1, maxHours: 6 },
    fast: { mult: 1, minUnits: 1, maxHours: 1 },         // as fast as cash and acres allow
  };
  const PL = () => core.planner;
  const FIRST_ACRE = 5000;
  const MIN_FLOOR_C = 10000;          // Auto never spends the last $100, whatever the other floors say
  let graceMs = 2000;                 // a timed-out Demolish gets this long to land before the retry looks again
  let waitMaxMs = 600000;             // a run waits this long for cash/items inside the run, then ends and lets Autopilot go
  const RUN_MAX_MS = 900000;          // a run ends after 15 min so Autopilot gets its turn (sales, power, resuming groups); the controller restarts it
  const ERR_COOLDOWN_MS = 300000;     // after an error stop: 5 min, doubling, off after 3 in a row               // cents: first bought acre in Heartland
  const HIST_MS = 30 * 60 * 1000;        // window for income, organic CD, net supply
  const SAMPLE_MS = 5000;
  const BOOT_DELAY_MS = 15000;           // let the first snapshot and Autopilot settle before Auto starts itself
  const IDLE_COOLDOWN_MS = 60000;        // after a run ends, wait before starting another
  const QUARANTINE_MS = 30 * 60 * 1000;
  const BREAKER_WAIT_MS = 5 * 60 * 1000;
  // Mean of the pacer's log-normal waits is median x exp(sigma^2 / 2); used to estimate the cycle time.
  const WAIT_MEAN = Math.exp(0.55 * 0.55 / 2);

  const hist = { at: 0, money: [], cd: [], stock: {}, use: {}, slopes: {}, cum: { net: 0, farmCd: 0, items: {} } };
  const quarantine = {};                 // building id -> until (ms)
  let lastEval = null, regimeKey = null, lastDrop = '', idleNote = '', cooldownUntil = 0, bootAt = Date.now() + BOOT_DELAY_MS;
  let strikes = 0, recovering = 0, lastDry = '', lastLandLog = 0, dryCycles = 0, waitSince = 0, errStreak = 0;
  const mismatch = {};   // consecutive price/CD mismatches per type: a power bill or sale inside one confirm window is not a strike
  // Units of a type that this run built and has not demolished yet (plus the ones a Buy may still deliver late). It caps every
  // cleanup, so nothing the farm did not build (a plan Mine, your own camps) can be demolished.
  const holding = (b, d) => { const h = (stats.holding ||= {}); h[b] = Math.max(0, (h[b] ?? 0) + d); };
  const owedCap = (b, pending = inFlight) => (stats.holding?.[b] ?? 0) + (pending?.action === 'build' ? (pending.units?.find((u) => u.b === b)?.n ?? 0) : 0);

  const runBuilding = () => ((running || active || resumable) && stats.building != null ? stats.building : cfg.building);
  const activeQuarantine = () => Object.fromEntries(Object.entries(quarantine).filter(([, t]) => t > Date.now()).map(([b]) => [b, true]));

  // Light state for confirming commands: no catalog needed.
  function readPool(fresh = false) {
    const { ws, st } = core.walk(fresh);
    if (!st) return null;
    return {
      ws, wsOpen: ws?.readyState === 1, pool: { ...(st.building_pool?.[REGION] ?? {}) }, money: st.items?.[MONEY] ?? 0, cd: st.items?.[CD] ?? 0,
      landBought: st.land_bought?.[REGION] ?? 0, mutTick: st.ssi?.last_user_mutation_tick ?? 0,
    };
  }

  // Everything the planner needs from the game state (money in cents).
  function readAuto(fresh = false) {
    const { ws, st, catalog, deals } = core.walk(fresh);
    if (!st || !catalog || !PL()) return null;
    const cat = PL().normalize(catalog);
    const pool = { ...(st.building_pool?.[REGION] ?? {}) };   // a copy: confirms compare against what it was before the command
    const owned = { ...pool }, running = new Set(), recipes = [];
    let acresUsed = 0;
    for (const [b, n] of Object.entries(pool)) acresUsed += (cat.buildings[b]?.acres ?? 1) * n;
    for (const g of Object.values(st.groups ?? {})) {
      if ((g.region ?? REGION) !== REGION) continue;
      owned[g.building] = (owned[g.building] ?? 0) + g.count;
      acresUsed += (cat.buildings[g.building]?.acres ?? 1) * g.count;
      if (g.paused) continue;
      recipes.push(g.recipe);
      for (const i of cat.recipes[g.recipe]?.inputs ?? []) running.add(i.item);
    }
    // Best open bid per unit (side 'Sell' rows are bids you can sell into).
    const bids = {};
    for (const d of deals ?? []) if (d.region === REGION && d.side === 'Sell' && d.amount > 0) bids[d.item] = Math.max(bids[d.item] ?? 0, d.price / d.amount);
    const unlocked = st.unlocked_buildings ?? [];
    const landBought = st.land_bought?.[REGION] ?? 0;
    const acresOwned = STARTER_ACRES + landBought;
    return {
      ws, wsOpen: ws?.readyState === 1, cat, pool, owned, running, recipes, bids, unlocked, landBought, acresOwned, acresUsed,
      freeAcres: Math.max(0, acresOwned - acresUsed), stock: st.stock?.[REGION] ?? {},
      money: st.items?.[MONEY] ?? 0, cd: st.items?.[CD] ?? 0, retail: unlocked.includes(RETAIL) || (owned[RETAIL] ?? 0) > 0,
      mutTick: st.ssi?.last_user_mutation_tick ?? 0,
    };
  }
  const RETAIL = 38;   // Retail Store

  // Items whose stock matters: the build items of every type that is not a starter.
  function watchItems(c) {
    const out = new Set();
    for (const b of Object.values(c.cat.buildings)) for (const i of b.build_items ?? []) out.add(i.item);
    return [...out];
  }

  // Rolling samples, compensated for what the farm itself spent and consumed, so the slopes are the
  // economy's own: income (cents/h), organic CD (CD/h), net supply and the farm's burn (items/h).
  function sampleHist(c) {
    const t = Date.now();
    if (t - hist.at < SAMPLE_MS) return;
    hist.at = t;
    const push = (arr, v) => { arr.push({ t, v }); while (arr.length && t - arr[0].t > HIST_MS) arr.shift(); };
    push(hist.money, c.money + hist.cum.net);
    push(hist.cd, c.cd - hist.cum.farmCd);
    for (const it of watchItems(c)) {
      push((hist.stock[it] ||= []), (c.stock[it] ?? 0) + (hist.cum.items[it] ?? 0));
      push((hist.use[it] ||= []), hist.cum.items[it] ?? 0);
    }
    const s = core.measure.slope;
    hist.slopes = { money: s(hist.money), cd: s(hist.cd) };
    for (const it of Object.keys(hist.stock)) { hist.slopes['s' + it] = s(hist.stock[it]); hist.slopes['u' + it] = s(hist.use[it]); }
  }

  // Expected seconds of one cycle with one type, and of each further type: measured round trips and
  // loop overhead (priors until 8 samples), plus the pacer's mean waits and its think pauses.
  function expectedCycle() {
    const rtt = core.measure.estimate('rtt', 350).value, over = core.measure.estimate('overhead', 250).value;
    const f = getPacer().factor;
    const pair = 2 * (500 * WAIT_MEAN * f + rtt) + over / 2;                 // one Buy and one Demolish
    const fixed = (400 + 600) * WAIT_MEAN * f + over / 2 + (4000 + 8000) / 22; // step + cycle gap + think pauses
    return { T: (pair + fixed) / 1000, perType: pair / 1000, rtt, over };
  }

  // The regime detector: a change in what is unlocked, in Retail, in the recipes that run or in the bid items
  // changes item values and candidate types. Planning is stateless so it adapts at once; this only restarts
  // the price-dependent windows and says what changed.
  function detectRegime(c, ap) {
    const sig = PL().signature({ unlocked: c.unlocked, running: c.recipes, retail: c.retail, bids: Object.keys(c.bids), phase: ap?.phase });
    const key = JSON.stringify([[...c.unlocked].sort((a, b) => a - b), c.retail]);
    if (sig === lastEval?.sig) return sig;
    if (regimeKey != null && key !== regimeKey) { hist.money.length = 0; hist.cd.length = 0; hist.slopes = {}; }
    regimeKey = key;
    return sig;
  }
  function reportDrops(plan) {
    const drops = plan.candidates.filter((x) => x.dropped && !['locked', 'no-acres'].includes(x.dropped)).map((x) => x.name + ' (' + (x.dropped === 'quarantined' ? 'quarantined' : x.dropped.split(':').slice(2).join('')) + ')').sort().join(', ');
    if (drops === lastDrop) return;
    if (lastDrop !== '' || drops !== '') core.ledger.add('CD', 'info', drops ? 'Auto: not using ' + drops : 'Auto: every unlocked type is usable again');
    lastDrop = drops;
  }

  // Item values flip when something starts using an item (Retail's furniture groups eat frames and planks) or when it
  // gets a buyer: say so once, so a type dropping out of the plan is explained.
  const lastValues = {};
  function reportValues(c, values) {
    for (const it of watchItems(c)) {
      const v = values[it] ?? 0, was = lastValues[it];
      lastValues[it] = v;
      if (was === undefined || v === was) continue;
      if ((was === 0) !== (v === 0) || v > 2 * was || was > 2 * v) {
        core.ledger.add('CD', 'info', `Auto: ${c.cat.items[it]?.name ?? 'item ' + it} is now worth $${fmt(v / 100)} each (was $${fmt(was / 100)})${c.retail ? ', Retail is open' : ''}`);
      }
    }
  }

  // Other modules that spend (Autopilot, Core plan) register with core.reserves; without any registered, fall back to Autopilot alone.
  const rsv = () => core.reserves;
  const hasProviders = () => (rsv()?.names().length ?? 0) > 0;
  const othersBusy = () => (hasProviders() ? rsv().anyBusy() : !!window.earlyGame?.busy);
  const canHold = () => hasProviders() || !!window.earlyGame?.hold;
  const holdOthers = async (who) => { if (hasProviders()) await rsv().holdAll(who); else if (window.earlyGame?.hold) await window.earlyGame.hold(who); };
  const releaseOthers = (who) => { if (hasProviders()) rsv().releaseAll(who); else window.earlyGame?.release?.(who); };
  const autopilotInfo = () => { try { return (hasProviders() ? rsv().merged() : window.earlyGame?.reserve?.()) ?? null; } catch { return null; } };

  // One look at the world: the gates, then the plan, then land. Pure apart from sampling and log lines.
  function evaluateAuto(fresh = false) {
    const c = readAuto(fresh);
    if (!c) return { idle: true, gate: 'G0', reason: 'game state or catalog not found' };
    if (!c.wsOpen) return { c, idle: true, gate: 'G0', reason: 'socket not open' };
    sampleHist(c);
    const ap = autopilotInfo();
    const sig = detectRegime(c, ap);
    const pace = PACE[cfg.pace] ?? PACE.balanced;
    const userTarget = Number.isFinite(cfg.targetCd) ? cfg.targetCd : null;
    const next = userTarget == null ? ap?.nextTech : null;
    const need = userTarget ?? next?.cd ?? null;
    const base = { c, ap, sig, need, pace };
    if (userTarget == null && !othersBusy()) return { ...base, idle: true, gate: 'G0', reason: 'waiting for Autopilot or Core plan to run live (or set a Target CD)' };
    const g = PL().gates({ need: need ?? 0, cd: c.cd, prereqsMet: next ? next.prereqsMet !== false : true, prereqNote: next?.note || 'its prerequisites', organicCdPerHour: hist.slopes.cd ?? null, maxHours: pace.maxHours });
    if (!g.run) return { ...base, idle: true, gate: g.gate, reason: g.reason };

    // Autopilot's own floor (power bills, next purchase) or $100, plus whatever you add on top.
    const floorC = Math.max(MIN_FLOOR_C, ap?.moneyFloor ?? 0) + Math.round(cfg.autoFloor * 100);
    const income = hist.slopes.money ?? null;
    const I = pace.mult * Math.max(0, income ?? 0);
    const t = expectedCycle();
    const netSupply = {}, burn = {};
    for (const it of watchItems(c)) { const s = hist.slopes['s' + it]; if (s != null) netSupply[it] = s; burn[it] = Math.max(0, hist.slopes['u' + it] ?? 0); }
    const input = {
      catalog: c.cat, unlocked: c.unlocked, owned: c.owned, usableAcres: Math.max(0, c.freeAcres - cfg.reserveAcres), money: c.money, floor: floorC,
      stock: c.stock, reserve: ap?.items ?? {}, netSupply, burn, itemValue: PL().itemValues({ catalog: c.cat, bids: c.bids, runningInputs: [...c.running] }),
      quarantine: activeQuarantine(), R: need - c.cd, T: t.T, TperType: t.perType, I,
      minUnits: recovering ? 1 : pace.minUnits, maxBatch: recovering ? 1 : cfg.batch, maxTypes: recovering ? 1 : cfg.maxTypes,
    };
    reportValues(c, input.itemValue);
    const plan = PL().plan(input);
    reportDrops(plan);

    // Land only matters while acres cap the batch. With no free acre at all, ask what one acre would buy.
    let landR = { buy: 0, note: '' };
    if (plan.binding === 'acres' || plan.wait?.reason === 'no free acres above the spare') {
      const p2 = plan.units.length ? plan : PL().plan({ ...input, usableAcres: 1 });
      const u = p2.units[0];
      if (u) {
        const wallC = cfg.land === 'plan' ? (window.earlyGame?.cfg?.maxAcrePrice ?? 0) * 100 : Infinity;
        const share = window.earlyGame?.cfg?.landCashShare ?? 0.02;   // Autopilot's own pace of land buying
        landR = PL().land({
          allow: cfg.land === 'plan' || cfg.land === 'off' ? cfg.land : cfg.land * 100, landBought: c.landBought, firstAcre: FIRST_ACRE, wall: wallC, paybackHours: 20,
          hoursUntilBought: (k) => (income > 0 ? PL().landCost(FIRST_ACRE, c.landBought, k) / (income * share) : Infinity),
          plan: p2, unitNeed: { cd: u.cd, acres: c.cat.buildings[u.b].acres }, R: need - c.cd, T: t.T, I, money: c.money, floor: floorC,
        });
      }
    }
    // Land is the one irreversible spend: when it is off (or not worth it), say once an hour what it would have bought.
    if (landR.note && !landR.buy && Date.now() - lastLandLog > 3600000) { lastLandLog = Date.now(); core.ledger.add('CD', 'info', 'Auto: ' + landR.note); }
    return { ...base, plan, land: landR, floorC, I, income, t };
  }

  const shuffle = (a) => { const o = [...a]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };
  const unitsText = (units) => units.map((u) => u.n + ' ' + u.name).join(' + ');

  // Right before a Buy: the state must still match the plan (nothing changed it, cash and items still hold).
  function recheck(rb, u, ev) {
    const base = rb.cat.buildings[u.b];
    if ((rb.owned[u.b] ?? 0) !== (ev.c.owned[u.b] ?? 0)) return u.name + ' count changed since the plan';
    if (rb.money - PL().batchCost(base.cost, rb.owned[u.b] ?? 0, u.n) < ev.floorC) return 'money would fall below the floor';
    for (const { item, amount } of base.build_items ?? []) {
      if (!PL().itemOk({ need: u.n * amount, stock: rb.stock[item] ?? 0, reserve: ev.ap?.items?.[item] ?? 0 }).ok) return (rb.cat.items[item]?.name ?? 'an item') + ' surplus is gone';
    }
    return '';
  }

  // A price or CD that does not match the catalog: skip that type for 30 min; a second one stops the run.
  function strike(b, name, why) {
    quarantine[b] = Date.now() + QUARANTINE_MS;
    strikes++;
    core.ledger.add('CD', 'fail', `Auto: ${name}: ${why}; skipping it for 30 min`);
    if (strikes >= 2) throw new Error('prices or CD did not match the catalog twice (' + why + '): the game may have changed');
  }

  function accountBuild(u, n, owned, base) {
    const gross = PL().batchCost(base.cost, owned, n);
    const row = (stats.byType[u.b] ||= { built: 0, spent: 0, refunded: 0 });
    row.built += n; row.spent += gross / 100;
    stats.spent += gross / 100; stats.built += n * u.cd;
    hist.cum.net += gross; hist.cum.farmCd += n * u.cd;
    for (const { item, amount } of base.build_items ?? []) hist.cum.items[item] = (hist.cum.items[item] ?? 0) + n * amount;
    stats.spends.push({ t: Date.now(), amount: (gross - n * Math.floor(base.cost / 2)) / 100 });
    return gross;
  }

  async function buyLand(ev) {
    const k = ev.land.buy;
    await jitter();
    if (!running) return;
    const rb = readAuto(true);
    if (!rb) throw new ConnError('game state not found');
    // Land is never refunded: send only if nothing moved since the plan and the floor still holds.
    if (rb.landBought !== ev.c.landBought || rb.money - ev.land.priceCents < ev.floorC) return;
    inFlight = { action: 'land', amount: k, at: Date.now() }; save();
    const d = send({ type: 'BuyLand', amount: k, region: REGION });
    const r1 = await waitConfirm((r) => r.landBought >= rb.landBought + k, d, readPool);
    inFlight = null;
    if (!r1) throw new Error(`land purchase of ${k} acre(s) not confirmed`);
    stats.land += ev.land.priceCents / 100; stats.acresBought += k; hist.cum.net += ev.land.priceCents;
    core.ledger.add('CD', 'action', `Auto: bought ${k} acre(s) for $${fmt(ev.land.priceCents / 100)} (real cost $${fmt(ev.land.realCostCents / 100)}): ${ev.land.note}`);
    save();
    await pause('cycle');
  }

  // Three failed commands in a row, or a latency spike: clean up, wait, retry once at batch 1; a second trip stops.
  async function breakerRecover(br) {
    if (getPacer().tripCount >= 2) { stopReason = 'error: commands keep failing (' + br.reason + ')'; return 'stop'; }
    phase = 'breaker open, waiting 5 min: ' + br.reason;
    core.ledger.add('CD', 'fail', `Auto: ${br.reason}; cleaning up and pausing 5 min`);
    try { await reconcile(); } catch (e) { console.warn('[cdFarm] cleanup failed:', e.message); }
    for (let t = 0; t < BREAKER_WAIT_MS && running; t += 250) await sleep(250);   // short steps: Stop must not wait seconds for this loop
    getPacer().resetBreaker();
    recovering = 3;
    return running ? 'ok' : 'stop';
  }

  // Returns 'ok' | 'stop'.
  async function autoCycle() {
    const pace = getPacer();
    const br = pace.breaker();
    if (br.open) return breakerRecover(br);
    if (Object.values(stats.holding ?? {}).some((n) => n > 0)) await reconcileAuto(null);   // a late Buy from the last cycle
    const ev = evaluateAuto(true);
    lastEval = ev;
    if (ev.idle) return stopWith(ev.reason);
    if (netSpend() >= cfg.maxSpend) return stopWith(`reached max spend $${fmt(cfg.maxSpend)}`);
    if (Date.now() - stats.startedAt > RUN_MAX_MS) return stopWith('giving Autopilot its turn');
    if (cfg.dryRun) {
      // Nothing is sent, land included. Log the plan a few times, then end (a dry run must not hold Autopilot forever).
      const u = ev.plan.units;
      const line = (ev.land.buy > 0 ? ev.land.buy + ' acre(s), then ' : '') + (u.length ? `${unitsText(u)} (${fmt(ev.plan.cdTotal)} CD, $${fmt(ev.plan.netCents / 100)} net)` : 'nothing yet (' + (ev.plan.wait?.reason ?? 'no plan') + ')');
      if (line !== lastDry) { lastDry = line; console.log('[cdFarm] dry run, would build ' + line); core.ledger.add('CD', 'info', 'dry run: would build ' + line); }
      if (++dryCycles >= 3) { cfg.autoStart = false; save(); return stopWith('dry run: plan logged (Auto is off until you switch it on)'); }
      await pause('cycle'); await pause('poll');
      return 'ok';
    }
    if (ev.land.buy > 0) { waitSince = 0; await buyLand(ev); return 'ok'; }
    const units = ev.plan.units;
    if (ev.plan.wait || !units.length) {
      // Cash or items are short: wait inside the run (Autopilot stays held, so cash only grows) up to 10 min, then end it.
      const why = ev.plan.wait?.reason ?? 'nothing to build right now';
      waitSince ||= Date.now();
      if (Date.now() - waitSince > waitMaxMs) { waitSince = 0; return stopWith(why); }
      phase = 'waiting: ' + why;
      await pause('poll');
      return 'ok';
    }
    waitSince = 0;
    const net = ev.plan.netCents / 100;
    const now = Date.now();
    stats.spends = stats.spends.filter((s) => now - s.t < 60000);
    if (stats.spends.reduce((a, s) => a + s.amount, 0) + net > cfg.maxSpendPerMin && stats.spends.length) { phase = 'waiting: spend limit'; await pause('poll'); return 'ok'; }
    // Build every type of the plan (in random order), then demolish what was built.
    const t0 = hr(); acc.wait = 0; let rttSum = 0;
    phase = 'building';
    for (const u of units) if (!stats.types.includes(u.b)) stats.types.push(u.b);
    inFlight = { action: 'build', units: [], at: Date.now() }; save();
    const built = [];
    let halted = '';
    for (const u of shuffle(units)) {
      if (!running) { halted = 'stopped'; break; }
      await jitter();
      const rb = readAuto(true);
      if (!rb) throw new ConnError('game state not found');
      halted = recheck(rb, u, ev);
      if (halted) break;
      const base = rb.cat.buildings[u.b], owned = rb.owned[u.b] ?? 0;
      inFlight.units.push({ b: u.b, n: u.n }); save();   // from here on a reload or error counts these as possibly built
      const d = send({ type: 'BuyBuilding', building: u.b, amount: u.n, region: REGION });
      const r1 = await waitConfirm((r) => (r.pool[u.b] ?? 0) >= (rb.pool[u.b] ?? 0) + u.n, d, readPool);
      if (!r1) {
        const got = Math.max(0, (readPool(true)?.pool[u.b] ?? 0) - (rb.pool[u.b] ?? 0));
        if (got > 0) { accountBuild(u, got, owned, base); built.push({ u, got, base }); }
        holding(u.b, u.n); (stats.late ||= {})[u.b] = (stats.late[u.b] ?? 0) + (u.n - got);   // the rest may still arrive: cleanup looks again
        (stats.holdAt ||= {})[u.b] = Date.now();
        inFlight.units = inFlight.units.filter((x) => x.b !== u.b); save();
        halted = `build of ${u.n} ${u.name} not confirmed (${got} appeared)`;
        break;
      }
      const rtt = core.lastRtt(); rttSum += rtt ?? 0;
      const gross = accountBuild(u, u.n, owned, base);
      built.push({ u, got: u.n, base });
      holding(u.b, u.n);
      inFlight.units = inFlight.units.filter((x) => x.b !== u.b); save();
      // F2: what the game charged and gave must match the catalog.
      const paid = rb.money - r1.money, allow = Math.max(500, gross * 0.05, Math.max(0, hist.slopes.money ?? 0) * ((rtt ?? 500) + 2000) / 3.6e6);
      const bad = Math.abs(paid - gross) > allow ? `paid $${fmt(paid / 100)}, catalog says $${fmt(gross / 100)}` : r1.cd - rb.cd === 0 ? 'no Construction Data came with the build' : '';
      if (!bad) mismatch[u.b] = 0;
      else if ((mismatch[u.b] = (mismatch[u.b] ?? 0) + 1) >= 2) { mismatch[u.b] = 0; strike(u.b, u.name, bad); }
      else core.ledger.add('CD', 'info', `Auto: ${u.name}: ${bad}; checking once more`);
    }
    inFlight = { action: 'demolish', units: [], at: Date.now() }; save();
    if (built.length) { phase = 'demolishing'; await pause('step'); }
    for (const x of shuffle(built)) {
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        // A Demolish that timed out may still be applied: give it time to land before looking again and retrying.
        if (attempt) await sleep(Math.max(graceMs, 4 * (core.measure.get('rtt').p90 ?? 0)));
        await jitter();
        const r0 = readPool(true);
        if (!r0) throw new ConnError('game state not found');
        // Never more than the farm holds: a first attempt that the server applied late must not make the retry eat your own buildings.
        const amt = Math.min(x.got, (r0.pool[x.u.b] ?? 0) - (stats.baseline?.[x.u.b] ?? 0));
        if (amt <= 0) done = true;
        else {
          const d = send({ type: 'DemolishBuilding', building: x.u.b, amount: amt, region: REGION });
          done = !!(await waitConfirm((r) => (r.pool[x.u.b] ?? 0) <= (r0.pool[x.u.b] ?? 0) - amt, d, readPool));
        }
        if (done) {
          holding(x.u.b, -x.got); save();
          if (amt > 0) rttSum += core.lastRtt() ?? 0;
          const refund = Math.floor(x.base.cost / 2) * x.got;
          stats.refunded += refund / 100; stats.byType[x.u.b].refunded += refund / 100; hist.cum.net -= refund;
        }
      }
      if (!done) throw new Error(`demolish of ${x.got} ${x.u.name} not confirmed`);
    }
    inFlight = null;
    if (halted && halted !== 'stopped') { phase = 'waiting: ' + halted; core.ledger.add('CD', 'info', 'Auto: ' + halted); }
    if (halted) { await pause('poll'); await reconcileAuto(null); }   // a Buy that confirms late must not stay in the pool

    if (!built.length) await pause('poll');   // nothing could be built (state moved): do not spin
    if (built.length) {
      stats.cycles++; sample();
      const wall = hr() - t0;
      core.measure.get('cycle').add(wall);
      core.measure.get('overhead').add(Math.max(0, wall - acc.wait - rttSum));
      const r2 = readPool();
      stats.last = `#${stats.cycles} | ${built.map((x) => x.got + ' ' + x.u.name).join(' + ')} | CD ${fmt(r2?.cd ?? 0)} (+${fmt(stats.built)}) | $${fmt((r2?.money ?? 0) / 100)} | $/CD ${perCd()}`;
      console.log('[cdFarm] ' + stats.last);
      if (stats.cycles === 1 || stats.cycles % 10 === 0) core.ledger.add('CD', 'action', stats.last);
      if (recovering) recovering--;
    }
    save();
    phase = 'running';
    await pause('cycle');
    return 'ok';
  }

  // Demolish whatever an interrupted Auto run still holds above its baseline; count a build that was not accounted.
  async function reconcileAuto(pending) {
    const rp = readPool();
    const c = readAuto();
    if (!rp || !c) return;
    const types = new Set([...(stats.types ?? []), ...(pending?.units ?? []).map((u) => u.b)]);
    for (const b of types) {
      // A Buy that has not shown up in 2 minutes is not coming: forget it, so the cap cannot reach buildings you add later.
      if ((stats.holding?.[b] ?? 0) > 0 && (rp.pool[b] ?? 0) - (stats.baseline?.[b] ?? 0) <= 0 && Date.now() - (stats.holdAt?.[b] ?? 0) > 120000) { stats.holding[b] = 0; if (stats.late) stats.late[b] = 0; }
      const extra = Math.min((rp.pool[b] ?? 0) - (stats.baseline?.[b] ?? 0), owedCap(b, pending));
      if (extra <= 0) continue;
      const base = c.cat.buildings[b];
      const unaccounted = pending?.action === 'build' ? (pending.units.find((u) => u.b === b)?.n ?? 0) : 0;
      if (unaccounted) {
        const n = Math.min(extra, unaccounted);
        const row = (stats.byType[b] ||= { built: 0, spent: 0, refunded: 0 });
        const gross = PL().batchCost(base.cost, (c.owned[b] ?? 0) - n, n);
        row.built += n; row.spent += gross / 100; stats.spent += gross / 100; stats.built += n * PL().cdOf(c.cat, b); hist.cum.net += gross;
      }
      const late = Math.min(extra - unaccounted, stats.late?.[b] ?? 0);   // a Buy that confirmed after the timeout: now it counts as built
      if (late > 0) {
        const row = (stats.byType[b] ||= { built: 0, spent: 0, refunded: 0 });
        const gross = PL().batchCost(base.cost, (c.owned[b] ?? 0) - late, late);
        row.built += late; row.spent += gross / 100; stats.spent += gross / 100; stats.built += late * PL().cdOf(c.cat, b); hist.cum.net += gross;
        stats.late[b] -= late;
      }
      console.log(`[cdFarm] cleanup: demolishing ${extra} leftover ${base.name}`);
      await jitter();
      const d = send({ type: 'DemolishBuilding', building: b, amount: extra, region: REGION });
      const r1 = await waitConfirm((r) => (r.pool[b] ?? 0) <= (rp.pool[b] ?? 0) - extra, d, readPool);
      if (!r1) throw new Error(`cleanup demolish of ${extra} ${base.name} not confirmed`);
      const refund = Math.floor(base.cost / 2) * extra;
      stats.refunded += refund / 100; hist.cum.net -= refund;
      if (stats.byType[b]) stats.byType[b].refunded += refund / 100;
      holding(b, -extra);
    }
    save();
  }

// continues the cd-farm closure from cd-farm-2.js (same try / IIFE)
  // ---- always-on controller ----------------------------------------------
  // Every 2 s: when Auto is on and idle, look at the world; when the engine needs CD and the plan has
  // something to build, start a run. The run ends when the need is met or a gate closes, then a cooldown.
  function setIdle(note) { if (note !== idleNote) { idleNote = note; render(); } }
  async function controllerTick() {
    if (unloaded || running || active || cfg.building !== 'auto' || !cfg.autoStart) { if (!running && !active) setIdle(''); return; }
    if (Date.now() < bootAt) return;
    if (resumable) { if (runBuilding() === 'auto') resume(); return; }
    if (Date.now() < cooldownUntil) return;
    let ev;
    try { ev = evaluateAuto(); } catch (e) { setIdle('error: ' + e.message); return; }
    lastEval = ev;
    if (ev.idle) return setIdle(ev.reason);
    if ((ev.plan.wait || !ev.plan.units.length) && !(ev.land?.buy > 0)) return setIdle(ev.plan.wait?.reason ?? 'nothing to build right now');
    setIdle('');
    start({ by: 'Auto' });
  }

  // ---- control -----------------------------------------------------------

  const fmt = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const perCd = () => (stats.built ? (netSpend() / stats.built).toFixed(2) : '-');

  async function start(opts = {}) {
    if (running) return console.warn('[cdFarm] already running');
    if (active) return console.warn('[cdFarm] previous run is still finishing its step; try again in a moment');
    const { resume: resumeFlag, runOnly, by, ...rest } = opts;
    const resume = !!resumeFlag;
    let r = read();
    if (!r) return console.error('[cdFarm] game state not found');
    const miss = core.missingFields(core.walk(true).st, ['groups', 'items']);
    if (miss.length) return console.error('[cdFarm] the game state no longer has ' + miss.join(', ') + ': refusing to run (did the game update?)');
    if (rest.building != null && rest.building !== 'auto' && !BUILDINGS.some((b) => b.id === rest.building)) {
      return console.error(`[cdFarm] building must be 'auto' or one of: ${BUILDINGS.map((b) => `${b.id} (${b.name})`).join(', ')}`);
    }
    // runOnly: these settings are for this run only; yours come back when it stops.
    if (runOnly && !restoreCfg) restoreCfg = { ...cfg };
    // cycles and maxSpend apply to one run only; other settings are remembered.
    if (!resume) { cfg.cycles = Infinity; cfg.maxSpend = Infinity; }
    Object.assign(cfg, rest);

    active = true;
    running = true; stopReason = '';
    phase = canHold() ? 'waiting for Autopilot to finish its step' : (resume ? 'resuming' : 'running');
    let began = false;
    try {
      // Autopilot must not send anything between our baseline and the end of the run
      // (a camp it builds would look like ours). hold() resolves once its current step is done.
      if (canHold()) { await holdOthers('CD Farm'); r = mustRead(); }
      if (!running) throw new Error(STOPPED_EARLY);
      phase = resume ? 'resuming' : 'running';
      getPacer().resetBreaker(); getPacer().clearTrips();
      if (!resume) {
        if (resumable) {
          // Clean up the interrupted run's camps (with its own baseline) before starting fresh.
          await reconcile();
          r = mustRead();
        }
        stats = freshStats();
        stats.building = cfg.building;
        r = mustRead(); // re-read: the pool count must be for the building this run uses
        Object.assign(stats, { cdStart: r.cd, moneyStart: r.money, startedAt: Date.now(), baselinePool: r.unassignedCamps, by: by || '' });
        stats.baseline = { ...(readPool()?.pool ?? {}) }; strikes = 0; recovering = 0; dryCycles = 0; waitSince = 0;
        for (const k of Object.keys(mismatch)) delete mismatch[k];

        sample();
      }
      resumable = false; began = true;
      save(); render();

      if (resume) {
        await reconcile();
        console.log(`[cdFarm] resumed after ${stats.cycles} cycles`);
      } else if (!isAuto() && r.unassignedCamps > 0) {
        if (cfg.existingPool === 'demolish') {
          const got = await demolish(r.unassignedCamps, { count: false });
          stats.baselinePool = 0;
          console.log(`[cdFarm] demolished ${r.unassignedCamps} existing unassigned ${bld().plural} (+$${fmt(got)})`);
        } else {
          console.log(`[cdFarm] keeping ${r.unassignedCamps} existing unassigned ${bld().plural} (start({ existingPool: 'demolish' }) to clear them)`);
        }
      }
      const r1 = mustRead();
      console.log(isAuto() ? `[cdFarm] start | Auto (${cfg.pace}) | CD ${fmt(r1.cd)} | $${fmt(r1.money)} | free acres ${r1.freeAcres}`
        : `[cdFarm] start | CD ${fmt(r1.cd)} | $${fmt(r1.money)} | floor $${fmt(r1.moneyFloor)} | free acres ${r1.freeAcres} | next batch ${r1.nextBatch}`);
      phase = 'running';
      await runLoop();
      if (!stopReason) stopReason = running ? `finished ${stats.cycles} cycles` : 'stopped by user';
      // An error can leave a batch in the pool: take it down before giving up.
      // An Auto run also cleans up after a normal stop: a late Buy or an interrupted step must never leave buildings behind.
      if (isAuto() && Object.values(stats.holding ?? {}).some((n) => n > 0)) await sleep(graceMs);   // a Buy may still be on its way
      if (/^error/.test(stopReason) || isAuto()) { try { await reconcile(); } catch (e2) { console.warn('[cdFarm] cleanup failed:', e2.message); } }
    } catch (e) {
      stopReason = e.message === STOPPED_EARLY ? 'stopped by user' : 'error: ' + e.message;
    } finally {
      const wasAuto = stats.building === 'auto';
      running = false;
      active = false;
      phase = 'idle';
      cooldownUntil = Date.now() + IDLE_COOLDOWN_MS;
      if (began && !wasAuto) { hist.cum.net += Math.round(netSpend() * 100); hist.cum.farmCd += stats.built; }   // a manual run's CD and spending are not organic: take them out of the windows
      if (wasAuto) {
        if (/^error/.test(stopReason)) {
          errStreak++;
          cooldownUntil = Date.now() + Math.min(1800000, ERR_COOLDOWN_MS * 2 ** (errStreak - 1));
          if (errStreak >= 3) { cfg.autoStart = false; core.ledger.add('CD', 'fail', 'Auto switched off after 3 errors in a row; switch it on again to retry'); }
        } else if (stats.cycles > 0) errStreak = 0;
      }
      if (restoreCfg) { Object.assign(cfg, restoreCfg); restoreCfg = null; }
      releaseOthers('CD Farm');
    }
    save();
    console.log(`[cdFarm] stopped: ${stopReason}`);
    core.ledger.add('CD', /^error/.test(stopReason) ? 'fail' : 'info', `stopped: ${stopReason} (${stats.cycles} cycles, +${stats.built} CD)${stats.by ? ' · ' + stats.by : ''}`);
    // Autopilot starts its own CD Farm runs all the time: only tell about errors and runs you started.
    if (/^error/.test(stopReason) || (!stats.by && stopReason !== 'stopped by user')) core.notify('CD', 'CD Farm stopped', stopReason);
    status();
  }

  const STOPPED_EARLY = 'stopped before the first cycle';
  const resume = (opts = {}) => start({ ...opts, resume: true });

  function stop() {
    if (running) {
      console.log('[cdFarm] stopping after current step');
      // You stopped an Auto run: it stays off until you switch it on again (Settings > Run by itself, or Start).
      if ((isAuto() || cfg.building === 'auto') && cfg.autoStart) { cfg.autoStart = false; core.ledger.add('CD', 'info', 'Auto switched off because you stopped it'); }
    }
    running = false;
    save();
  }

  // Alt+Shift+X: switch Auto off even while it is idle.
  function pauseAuto() {
    if (cfg.building !== 'auto' || !cfg.autoStart) return false;
    cfg.autoStart = false; save(); render();
    core.ledger.add('CD', 'info', 'Auto switched off (stop all)');
    return true;
  }

  function reset() {
    if (running || active) return console.warn('[cdFarm] stop the run (and let it finish its step) before reset()');
    try { localStorage.removeItem(KEY); } catch {}
    stats = freshStats(); resumable = false; stopReason = ''; inFlight = null;
    if (restoreCfg) { Object.assign(cfg, restoreCfg); restoreCfg = null; }
    save(); render();
  }

  // ---- rates (#7) --------------------------------------------------------

  // Net spend per sample, across runs (stats reset at every run start): rates().spendH sums its last hour (Core plan E5).
  let spendLog = [];
  function sample(now = Date.now()) {
    const net = netSpend(), prev = stats.netLogged ?? 0;
    if (net !== prev) spendLog.push({ t: now, amount: net - prev });
    stats.netLogged = net;
    spendLog = spendLog.filter((s) => now - s.t <= 3600000);
    stats.samples.push({ t: now, cycles: stats.cycles, built: stats.built, net });
    stats.samples = stats.samples.filter((s) => now - s.t <= RATE_WINDOW_MS);
  }

  // Uses camps built (not the CD balance) so research spending doesn't skew it.
  // Rates stay hidden until MIN_RATE_CYCLES cycles are in, since one fast cycle
  // extrapolates to absurd hourly figures.
  const MIN_RATE_CYCLES = 3;
  function rates(r = read(), now = Date.now()) {
    const s = stats.samples.filter((x) => now - x.t <= RATE_WINDOW_MS);
    let cdh15 = null, spendh15 = null, cyclesh15 = null;
    if (s.length >= 2) {
      const a = s[0], b = s[s.length - 1];
      const h = (b.t - a.t) / 3.6e6;
      if (h > 0 && b.cycles - a.cycles >= MIN_RATE_CYCLES) {
        cdh15 = (b.built - a.built) / h;
        spendh15 = (b.net - a.net) / h;
        cyclesh15 = (b.cycles - a.cycles) / h;
      }
    }
    const hAll = stats.startedAt ? (now - stats.startedAt) / 3.6e6 : 0;
    const cdhAll = hAll > 0 && stats.cycles >= MIN_RATE_CYCLES ? stats.built / hAll : null;
    const target = Number.isFinite(cfg.targetCd) ? cfg.targetCd : 20000;
    const rate = cdh15 ?? cdhAll;

    // In reserve mode, cash above the floor caps how much CD the farm can buy.
    let reachableCd = null, capped = false;
    if (r && !isAuto()) {
      const perCd = (campCost(r.ownedCamps, cfg.batch) - cfg.batch * unitRefund()) / cfg.batch;
      reachableCd = r.cd + Math.max(0, Math.floor((r.money - r.moneyFloor) / perCd));
      capped = cfg.budget === 'reserve' && reachableCd < target;
    }
    const goal = capped ? reachableCd : target;
    const etaH = r && rate > 0 ? Math.max(0, goal - r.cd) / rate : null;
    // spendH: dollars net spent in the last 60 min, across runs (Core plan adds it back to the cash trend for net income).
    const spendH = spendLog.filter((x) => now - x.t <= 3600000).reduce((a, x) => a + x.amount, 0);
    return { cdh15, spendh15, cyclesh15, spendH, cdhAll, target, etaH, reachableCd, capped };
  }

  // "1h 10m" to the target, or where cash runs out first.
  function etaText(rt) {
    if (rt.capped) return `cash runs out at ~${fmt(rt.reachableCd)} CD${rt.etaH != null ? ` (${fmtH(rt.etaH)})` : ''}`;
    return rt.etaH == null ? 'after 3 cycles' : fmtH(rt.etaH);
  }

  const fmtRate = (x) => (x == null ? '-' : fmt(Math.round(x)));
  const fmtH = (h) => {
    if (h == null) return '-';
    if (h === 0) return 'done';
    const m = Math.round(h * 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };

  function status() {
    const r = read();
    if (!r) return console.error('[cdFarm] game state not found');
    const rt = rates(r);
    console.table({
      Money: `$${fmt(r.money)} (floor $${fmt(r.moneyFloor)}, ${cfg.budget})`,
      CD: `${fmt(r.cd)}${stats.built ? ` (+${stats.built} farmed)` : ''}`,
      [`Unassigned ${bld().plural}`]: `${r.unassignedCamps} (baseline ${stats.baselinePool})`,
      [`${cap(bld().plural)} in groups`]: r.campsInGroups,
      Acres: `${r.acresUsed} / ${r.acresOwned} (${r.freeAcres} free)`,
      'Next batch': `${r.nextBatch} ${bld().plural}, $${fmt(r.nextBatchCost)}`,
      Cycles: stats.cycles,
      'Net $/CD': perCd(),
      'CD/h (15m / run)': `${fmtRate(rt.cdh15)} / ${fmtRate(rt.cdhAll)}`,
      'Spend/h (15m)': rt.spendh15 == null ? '-' : `$${fmt(Math.round(rt.spendh15))}`,
      [`ETA to ${fmt(rt.target)} CD`]: etaText(rt),
      State: running ? phase : (resumable ? 'interrupted (resume available)' : (stopReason || 'idle')),
    });
  }

// continues the cd-farm closure from cd-farm-3.js (same try / IIFE)
  // ---- game UI -----------------------------------------------------------
  // Styled with the game's own CSS variables and button classes so it reads as
  // part of the app: a "CD Farm" tab in the sidebar, a chip in the top bar, and
  // a card that opens from either.

  const UI_KEY = 'cdFarm.ui';
  const ui = (() => { try { return { open: false, x: null, y: null, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch { return { open: false, x: null, y: null }; } })();
  const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };


  const ICON = '<svg class="nav-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="6" height="6" rx="1" fill="currentColor"></rect><rect x="11" y="11" width="6" height="6" rx="1"></rect><rect x="7" y="3" width="6" height="6" rx="1" style="stroke:var(--nav-accent)"></rect></svg>';

  const h = core.h;
  const K = core.ui;

  let P = null, chrome = null, timer = null, ctlTimer = null, discardUntil = 0;
  const refs = {};

  // 'run' | 'wait' | 'err' | '' for the status dot.
  function tone() {
    if (running) return /waiting|reconnect/.test(phase) ? 'wait' : 'run';
    if (resumable || /^error/.test(stopReason)) return 'err';
    return '';
  }
  const stateText = () => (running ? phase + (stats.by ? ` · ${stats.by}` : '') : resumable ? 'Interrupted — resume available' : (isAuto() && cfg.autoStart && idleNote ? 'Auto: ' + idleNote : stopReason || 'Idle'));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ---- settings form ----
  // Amounts accept "100k", "1.5m", "$100,000". Every change is checked against
  // the live game state, problems show next to the field they come from, and
  // Start needs a second click after reading the plan summary.

  const parseAmount = (s) => {
    const m = String(s).trim().replace(/[$,\s_]/g, '').match(/^(\d*\.?\d+)([kmb])?$/i);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1));
  };
  const short = (x) => (x >= 1e6 ? `${+(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${+(x / 1e3).toFixed(1)}k` : String(Math.round(x)));

  const MODES = [
    { id: 'floor', label: 'Keep a floor', desc: 'Spends money above the floor. At the floor it waits for income, then keeps going.' },
    { id: 'income', label: 'Income only', desc: 'Spends only money earned after you press Start. What you have at Start (or the floor, if higher) is kept.' },
    { id: 'reserve', label: 'Spend down', desc: 'Spends money above the floor once, then stops.' },
  ];

  const FIELDS = {
    minMoney: { kind: 'money', label: 'Money floor' },
    autoFloor: { kind: 'money', label: 'Extra money floor', min: 0 },
    targetCd: { kind: 'count', label: 'Target CD', optional: true, empty: 'No target' },
    batch: { kind: 'count', label: 'Buildings per cycle', min: 1, max: 100 },
    reserveAcres: { kind: 'count', label: 'Spare acres', min: 0 },
    maxSpendPerMin: { kind: 'money', label: 'Max spend per minute', optional: true, empty: 'No limit' },
  };
  const FLOOR_CHIPS = [50000, 100000, 250000, 1000000];
  const TARGET_STEPS = [1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6];

  const parseErr = {};
  let confirmUntil = 0;

  function parseField(key, text) {
    const f = FIELDS[key];
    const s = text.trim();
    if (s === '') return f.optional ? { v: Infinity } : { err: 'Required.' };
    const v = parseAmount(s);
    if (v == null) return { err: f.kind === 'money' ? 'Use an amount like 100k, 1.5m or 100,000.' : 'Use a number like 20k or 20,000.' };
    if (f.min != null && v < f.min) return { err: `Must be at least ${fmt(f.min)}.` };
    if (f.max != null && v > f.max) return { err: `Must be at most ${fmt(f.max)}.` };
    return { v };
  }
  const shown = (key) => (Number.isFinite(cfg[key]) ? fmt(cfg[key]) : '');
  function setCfg(key, v) { cfg[key] = v; confirmUntil = 0; save(); render(); }

  function textField(key) {
    const f = FIELDS[key];
    const { input, box } = K.inputBox({ label: f.label, prefix: f.kind === 'money' ? '$' : '', placeholder: f.empty || '' });
    const msg = h('div', { class: 'idc-msg', hidden: true });
    const revert = () => { delete parseErr[key]; input.value = shown(key); };
    input.addEventListener('input', () => {
      const p = parseField(key, input.value);
      if (p.err) { parseErr[key] = p.err; confirmUntil = 0; render(); } else { delete parseErr[key]; setCfg(key, p.v); }
    });
    input.addEventListener('blur', () => { revert(); render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { revert(); input.blur(); }
    });
    refs.fields[key] = { input, box, msg };
    return { box, msg };
  }

  const fieldBox = K.field;
  const same = Object.is;
  const setOn = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
  const chip = (text, onclick) => h('button', { type: 'button', onclick }, text);
  function setMsg(el, m) {
    el.hidden = !m;
    el.className = 'idc-msg ' + (m?.level || '');
    el.textContent = m?.text || '';
  }

  // Floor the run would use if started now.
  const plannedFloor = (r) => (cfg.budget === 'income' ? Math.max(cfg.minMoney, r.money) : cfg.minMoney);
  const netPerCd = (r) => (campCost(r.ownedCamps, cfg.batch) - cfg.batch * unitRefund()) / cfg.batch;

  // [{ field, level: 'error' | 'warn', text }]. Errors block Start.
  function checkPlan(r) {
    const out = [];
    const floor = plannedFloor(r);
    if (Number.isFinite(cfg.targetCd) && cfg.targetCd <= r.cd) {
      out.push({ field: 'targetCd', level: 'error', text: `You already have ${fmt(r.cd)} CD. Pick a higher target.` });
    }
    const usable = Math.max(0, r.freeAcres - cfg.reserveAcres);
    const want = cfg.fullBatch ? cfg.batch : 1;
    if (usable < want) {
      out.push({ field: 'land', level: 'error', text: usable === 0
        ? `No free acres beyond the ${cfg.reserveAcres} spare (${r.freeAcres} free). Buy land or lower Spare acres in Advanced.`
        : `A full batch needs ${cfg.batch} free acres beyond the ${cfg.reserveAcres} spare; you have ${usable}. Buy ${cfg.batch - usable} acres, lower Spare acres, or turn off Full batches.` });
    }
    const batchCost = campCost(r.ownedCamps, want);
    const room = r.money - floor;
    if (cfg.budget === 'reserve' && room < batchCost) {
      out.push({ field: 'minMoney', level: 'error', text: `Only $${fmt(Math.max(0, room))} above the floor, and a batch costs $${fmt(batchCost)}. Spend down would stop right away.` });
    } else if (cfg.budget === 'floor' && room < batchCost) {
      out.push({ field: 'minMoney', level: 'warn', text: `It will wait until you earn $${fmt(batchCost - room)} more before the first batch.` });
    } else if (cfg.budget === 'income' && cfg.minMoney > r.money) {
      out.push({ field: 'minMoney', level: 'warn', text: `Money is below this floor; it will wait until money passes $${fmt(cfg.minMoney)}.` });
    }
    if (cfg.budget !== 'income' && cfg.minMoney < r.money * 0.1) {
      out.push({ field: 'minMoney', level: 'warn', text: `Low floor: up to $${fmt(r.money - cfg.minMoney)} of your $${fmt(r.money)} can be spent.` });
    }
    return out;
  }

  function planText(r) {
    const floor = plannedFloor(r);
    const per = netPerCd(r);
    const camps = `${cfg.fullBatch ? 'exactly' : 'up to'} ${cfg.batch} ${bld().plural}`;
    const parts = [cfg.budget === 'income'
      ? `Builds ${camps} at a time from new income only, keeping $${fmt(floor)}.`
      : `Builds ${camps} at a time while money is above $${fmt(floor)}.`];
    if (cfg.budget === 'reserve') parts.push(`Stops at the floor, about ${fmt(Math.max(0, Math.floor((r.money - floor) / per)))} CD from current cash.`);
    else parts.push('At the floor it waits for income.');
    if (Number.isFinite(cfg.targetCd) && cfg.targetCd > r.cd) {
      const left = cfg.targetCd - r.cd;
      parts.push(`Stops at ${fmt(cfg.targetCd)} CD: ${fmt(left)} more, about $${short(left * per)} net.`);
    } else if (!Number.isFinite(cfg.targetCd)) parts.push('No target: runs until you stop it.');
    return parts.join(' ');
  }

  const bldLabel = (id) => (id === 'auto' ? 'Auto' : BUILDINGS.find((b) => b.id === id)?.name ?? '');
  function autoRows() {
    const ev = lastEval, c = ev?.c, m = core.measure.snapshot();
    const rows = [['Mode', `Auto · ${cap(cfg.pace)}${cfg.autoStart ? '' : ' · off'}`]];
    rows.push(['Why', cap(running ? phase : (idleNote || (ev?.idle ? ev.reason : '') || stopReason || 'idle'))]);
    if (ev?.need != null && c) rows.push(['Need', `${fmt(c.cd)} of ${fmt(ev.need)} CD${ev.ap?.nextTech ? ' (' + ev.ap.nextTech.name + ')' : ''}`]);
    if (ev?.plan?.units?.length) rows.push(['Next cycle', `${unitsText(ev.plan.units)} · ${fmt(ev.plan.cdTotal)} CD · $${fmt(ev.plan.netCents / 100)} net`]);
    if (c) rows.push(['Free acres', `${c.freeAcres} of ${c.acresOwned} (${cfg.reserveAcres} spare)`]);
    if (ev?.floorC != null) rows.push(['Floor', `$${fmt(ev.floorC / 100)}`]);
    rows.push(['Cycles', `${fmt(stats.cycles)}${stats.built ? ` · +${fmt(stats.built)} CD` : ''}`], ['Net cost', stats.built ? `$${perCd()} / CD` : '—']);
    const rtt = m.rtt;
    rows.push(['Measured', rtt?.n ? `round trip ${Math.round(rtt.median)} ms (n=${rtt.n}) · cycle ${ev?.t ? ev.t.T.toFixed(1) : '—'} s · income $${fmt(Math.round((ev?.income ?? 0) / 100))}/h` : 'collecting samples…']);
    if (ev?.land?.note) rows.push(['Land', ev.land.note]);
    return rows;
  }
  function autoPlanText() {
    const ev = lastEval;
    const head = `Auto (${cap(cfg.pace)}): picks the cheapest CD source each cycle from what is unlocked, in surplus and affordable.`;
    if (!ev) return head;
    if (ev.idle) return `${head} Waiting: ${ev.reason}.`;
    if (ev.plan?.units.length) return `${head} Next: ${unitsText(ev.plan.units)} for $${fmt(ev.plan.netCents / 100)} net.`;
    return `${head} Waiting: ${ev.plan?.wait?.reason ?? 'nothing to build'}.`;
  }

  function onMain() {
    if (running) return stop();
    const arm = () => { if (cfg.building === 'auto' && !cfg.autoStart) { cfg.autoStart = true; save(); } };
    if (resumable) { arm(); return resume(); }
    if (Date.now() < confirmUntil) { confirmUntil = 0; arm(); return start(); }
    confirmUntil = Date.now() + 6000;
    render();
    setTimeout(render, 6100);
  }
  function onAlt() {
    if (Date.now() < confirmUntil) { confirmUntil = 0; return render(); }
    if (running || active) return;
    if (Date.now() < discardUntil) { discardUntil = 0; reset(); refs.main?.focus(); return; }   // second click: really do it; this button hides, so focus moves on
    discardUntil = Date.now() + 4000;
    render();
    setTimeout(render, 4100);
  }
  function doClearLog() {
    const snap = core.ledger.list();
    core.ledger.clear(); render();
    core.toast('Log cleared', { undo: () => { if (unloaded) return; core.ledger.restore(snap); render(); } });
  }

  function buildPanel() {
    // ---- Status tab
    refs.cd = h('span', { class: 'idc-big' });
    refs.target = h('span', { class: 'idc-label' });
    refs.bar = h('i');
    refs.rows = h('div', { class: 'idc-rows' });
    refs.state = h('span');
    refs.stateDot = h('span', { class: 'idc-dot' });
    const status = [
      h('div', {}, h('div', { class: 'idc-label' }, 'Construction Data'), h('div', { class: 'idc-hero' }, refs.cd, refs.target), h('div', { class: 'idc-bar' }, refs.bar)),
      refs.rows,
      h('div', { class: 'idc-state' }, refs.stateDot, refs.state)];

    // ---- Settings tab
    refs.fields = {};
    refs.fieldEl = {};
    refs.seg = K.seg(MODES, () => cfg.budget, (id) => setCfg('budget', id), 'Budget');
    refs.modeDesc = h('div', { class: 'idc-desc' });
    refs.bldSeg = K.seg([{ id: 'auto', label: 'Auto' }, ...BUILDINGS.map((b) => ({ id: b.id, label: b.name }))], () => cfg.building, (id) => setCfg('building', id), 'Building');
    refs.bldDesc = h('div', { class: 'idc-desc' });
    refs.paceSeg = K.seg([{ id: 'thrifty', label: 'Thrifty' }, { id: 'balanced', label: 'Balanced' }, { id: 'fast', label: 'Fast' }], () => cfg.pace, (id) => setCfg('pace', id), 'Pace');
    refs.paceDesc = h('div', { class: 'idc-desc' });
    refs.landSeg = K.seg([{ id: 'off', label: 'Off' }, { id: 'plan', label: 'Within the plan' }], () => (cfg.land === 'off' ? 'off' : 'plan'), (id) => setCfg('land', id), 'Buy land');
    refs.landDesc = h('div', { class: 'idc-desc' });
    const autoFloor = textField('autoFloor');
    refs.autoOn = h('input', { type: 'checkbox', onchange: () => { cfg.autoStart = refs.autoOn.checked; save(); render(); } });
    refs.autoOnLabel = K.check(refs.autoOn, 'Run by itself', 'Starts whenever Autopilot needs CD. Pressing Stop turns it off.');
    const floor = textField('minMoney');
    refs.floorChips = FLOOR_CHIPS.map((v) => [v, chip('$' + short(v), () => setCfg('minMoney', v))]);
    const target = textField('targetCd');
    refs.targetChips = h('div', { class: 'idc-quicks' });
    refs.targetKey = '';
    refs.full = h('input', { type: 'checkbox', onchange: () => setCfg('fullBatch', refs.full.checked) });
    refs.fullText = h('small');
    refs.fullLabel = h('label', { class: 'idc-check' }, refs.full, h('span', {}, 'Full batches only', refs.fullText));
    refs.landMsg = h('div', { class: 'idc-msg', hidden: true });
    const batch = textField('batch');
    const spare = textField('reserveAcres');
    const rate = textField('maxSpendPerMin');
    refs.auto = h('input', { type: 'checkbox', onchange: () => { cfg.autoResume = refs.auto.checked; save(); render(); } });
    refs.autoLabel = K.check(refs.auto, 'Resume after reload', 'Continues an interrupted run when the page loads again.');
    refs.fieldEl.building = fieldBox('Building', refs.bldSeg.el, refs.bldDesc);
    refs.fieldEl.pace = fieldBox('Pace', refs.paceSeg.el, refs.paceDesc);
    refs.fieldEl.land = fieldBox('Buy land', refs.landSeg.el, refs.landDesc);
    refs.fieldEl.autoFloor = fieldBox('Extra money floor', autoFloor.box, autoFloor.msg);
    refs.fieldEl.budget = fieldBox('Budget', refs.seg.el, refs.modeDesc);
    refs.fieldEl.minMoney = fieldBox('Money floor', floor.box, h('div', { class: 'idc-quicks' }, ...refs.floorChips.map(([, b]) => b)), floor.msg);
    refs.fieldEl.targetCd = fieldBox('Target CD', target.box, refs.targetChips, target.msg);
    refs.fieldEl.batch = fieldBox('Buildings per cycle', batch.box, batch.msg);
    refs.fieldEl.reserveAcres = fieldBox('Spare acres', spare.box, spare.msg);
    refs.fieldEl.maxSpendPerMin = fieldBox('Max spend per minute', rate.box, rate.msg);
    const lockIcon = h('span', { 'aria-hidden': 'true' });
    lockIcon.innerHTML = K.ICONS.lock;
    refs.lock = h('div', { class: 'idc-lock' }, lockIcon, 'Stop the farm to change settings.');
    refs.fs = h('fieldset', { class: 'idc-form' },
      K.group('Building', refs.fieldEl.building),
      refs.grpAuto = K.group('Auto', refs.autoOnLabel, refs.fieldEl.pace, refs.fieldEl.land, refs.fieldEl.autoFloor),
      refs.grpBudget = K.group('Budget', refs.fieldEl.budget, refs.fieldEl.minMoney),
      K.group('Goal', refs.fieldEl.targetCd),
      refs.grpBatches = K.group('Batches', refs.fullLabel, refs.landMsg),
      h('details', { class: 'idc-sub', open: !!ui.advOpen, ontoggle: (e) => { ui.advOpen = e.target.open; saveUi(); } }, h('summary', {}, 'Advanced'),
        K.group(null, h('div', { class: 'idc-two' }, refs.fieldEl.batch, refs.fieldEl.reserveAcres), refs.fieldEl.maxSpendPerMin, refs.autoLabel)));

    // ---- Log tab
    refs.logv = K.createLogView();
    const logTab = [
      refs.logv.el,
      h('div', { class: 'idc-tools' },
        h('button', { type: 'button', onclick: () => core.ledger.copy() }, 'Copy log'),
        h('button', { type: 'button', class: 'danger', onclick: doClearLog }, 'Clear log')),
      h('div', { class: 'idc-desc' }, 'Alt+Shift+X stops Autopilot, CD Farm and the Lab runner from anywhere on the page.')];

    // ---- Footer (always visible)
    refs.pilot = h('div', { class: 'idc-msg warn', hidden: true });
    refs.plan = h('div', { class: 'idc-plan' });
    refs.main = h('button', { class: 'primary', onclick: onMain });
    refs.alt = h('button', { onclick: onAlt });
    const foot = h('div', { class: 'idc-foot' }, refs.pilot, refs.plan, h('div', { class: 'idc-btns' }, refs.alt, refs.main));

    P = K.createPanel({
      id: 'cd', title: 'CD Farm', cls: 'cdf-panel', state: ui, save: saveUi, foot,
      tabs: [{ id: 'status', label: 'Status', content: status }, { id: 'settings', label: 'Settings', content: [refs.lock, refs.fs] }, { id: 'log', label: 'Log', content: logTab }],
      onClose: () => panel(false), onTab: () => render(), opener: () => chrome?.opener,
      defaultPlace: () => ({ right: 20 }),
    });
    refs.dot = P.dot;
  }

  function renderForm(r) {
    const busy = running || active;
    refs.fs.disabled = busy;
    refs.lock.hidden = !busy;
    refs.seg.sync();
    refs.bldSeg.sync(); refs.paceSeg.sync(); refs.landSeg.sync();
    const auto = isAuto();
    const show = (el, on) => { el.style.display = on ? '' : 'none'; };
    show(refs.grpAuto, auto); show(refs.grpBudget, !auto); show(refs.grpBatches, !auto); show(refs.fieldEl.maxSpendPerMin, !auto);
    refs.autoOn.checked = !!cfg.autoStart;
    refs.paceDesc.textContent = { thrifty: 'Cheapest CD, small batches, slow.', balanced: 'Bigger batches while the time saved is worth the cash.', fast: 'As fast as cash and free acres allow.' }[cfg.pace] || '';
    refs.landDesc.textContent = cfg.land === 'off' ? 'Never buys acres. Logs what more land would save.' : 'Buys an acre only while acres limit the batch, the CD it saves is worth more than the acre, the price is under Autopilot\'s land price limit, and the cash floor holds.';
    if (auto) refs.bldDesc.textContent = 'Picks the cheapest CD source every cycle from what is unlocked, in surplus and affordable. Never buys materials.';
    else if (r) refs.bldDesc.textContent = `${bld().name}: $${fmt(bld().base)} base, 1 CD and 1 acre each. You own ${r.ownedCamps}, so the next one costs $${fmt(campCost(r.ownedCamps, 1))} and each one you own adds $${fmt(bld().base / 20)}. Pick the one you own fewer of.`;
    refs.modeDesc.textContent = MODES.find((m) => m.id === cfg.budget)?.desc || '';
    for (const [key, f] of Object.entries(refs.fields)) if (document.activeElement !== f.input) f.input.value = shown(key);
    for (const [v, b] of refs.floorChips) setOn(b, cfg.minMoney === v);

    // Target chips: the next round numbers above the current CD, plus "None".
    if (r) {
      const steps = TARGET_STEPS.filter((v) => v > r.cd).slice(0, 5);
      const key = steps.join();
      if (key !== refs.targetKey) {
        refs.targetKey = key;
        refs.targetChips.replaceChildren(...steps.map((v) => chip(short(v), () => setCfg('targetCd', v))), chip('None', () => setCfg('targetCd', Infinity)));
      }
      const btns = [...refs.targetChips.children];
      steps.forEach((v, i) => setOn(btns[i], cfg.targetCd === v));
      setOn(btns[btns.length - 1], !Number.isFinite(cfg.targetCd));
    }

    const issues = r && !busy && !auto ? checkPlan(r) : [];
    const msgFor = (key) => (parseErr[key] ? { level: 'error', text: parseErr[key] } : issues.find((i) => i.field === key));
    for (const [key, f] of Object.entries(refs.fields)) {
      const m = msgFor(key);
      setMsg(f.msg, m);
      f.box.classList.toggle('bad', m?.level === 'error');
    }
    setMsg(refs.landMsg, msgFor('land'));
    refs.full.checked = !!cfg.fullBatch;
    refs.fullText.textContent = cfg.fullBatch
      ? `Always ${cfg.batch} ${bld().plural} per cycle; waits instead of building fewer.`
      : `Builds fewer than ${cfg.batch} when money or land is short.`;
    refs.auto.checked = !!cfg.autoResume;

    // Which settings differ from the defaults: a reset button on each field, a dot on the tab.
    let changed = 0;
    const defShown = (key) => (Number.isFinite(DEFAULTS[key]) ? fmt(DEFAULTS[key]) : FIELDS[key]?.empty || 'none');
    const mod = (key, hint) => {
      const m = !same(cfg[key], DEFAULTS[key]);
      if (m) changed++;
      K.setModified(refs.fieldEl[key], m, 'Reset to the default (' + hint + ')', () => { delete parseErr[key]; setCfg(key, DEFAULTS[key]); });
    };
    mod('building', bldLabel(DEFAULTS.building));
    mod('pace', 'Balanced');
    mod('land', 'Within the plan');
    mod('budget', MODES.find((m) => m.id === DEFAULTS.budget).label);
    for (const key of ['minMoney', 'autoFloor', 'targetCd', 'batch', 'reserveAcres', 'maxSpendPerMin']) mod(key, defShown(key));
    for (const [key, label] of [['fullBatch', refs.fullLabel], ['autoResume', refs.autoLabel], ['autoStart', refs.autoOnLabel]]) {
      const m = !!cfg[key] !== !!DEFAULTS[key];
      label.classList.toggle('mod', m); label.title = m ? 'Changed from the default' : '';
      if (m) changed++;
    }
    P.setTabBadge('settings', changed ? changed + ' setting' + (changed > 1 ? 's' : '') + ' changed from the defaults' : '');

    const blocking = Object.keys(parseErr).length > 0 || issues.some((i) => i.level === 'error');
    const confirming = !busy && !resumable && !blocking && Date.now() < confirmUntil;
    const pilot = window.earlyGame;
    refs.pilot.hidden = busy || !pilot?.busy;
    refs.pilot.textContent = 'Autopilot is running live. Starting pauses it after its current step; it goes on when the farm stops.';
    refs.plan.hidden = busy || resumable || !r;
    if (!refs.plan.hidden) refs.plan.textContent = blocking ? 'Fix the settings marked in red to start.' : auto ? autoPlanText() : planText(r);
    refs.plan.classList.toggle('hot', confirming);
    refs.plan.classList.toggle('bad', blocking);
    refs.main.textContent = running ? 'Stop' : resumable ? 'Resume' : confirming ? 'Confirm start' : 'Start';
    refs.main.disabled = !running && (active || !r || (!resumable && blocking));
    refs.alt.hidden = !confirming && (running || !(resumable || stats.cycles));
    const arming = !confirming && Date.now() < discardUntil;
    refs.alt.textContent = confirming ? 'Cancel' : arming ? 'Click again to confirm' : resumable ? 'Discard run' : 'Clear stats';
    refs.alt.classList.toggle('danger', !confirming && (resumable || arming));
    refs.alt.classList.toggle('armed', arming);
  }

  const onResize = () => P?.place();

  function renderPanel(r, rt) {
    const t = tone();
    refs.dot.className = refs.stateDot.className = 'idc-dot ' + t;
    if (!r) {
      refs.cd.textContent = '—'; refs.target.textContent = ''; refs.rows.replaceChildren();
      refs.state.textContent = 'Waiting for the game to load…';
    } else {
      refs.cd.textContent = fmt(r.cd);
      const hasTarget = Number.isFinite(cfg.targetCd);
      refs.target.textContent = hasTarget ? `of ${fmt(cfg.targetCd)}` : (stats.built ? `+${fmt(stats.built)} farmed` : 'no target');
      refs.bar.style.width = hasTarget ? Math.min(100, (r.cd / cfg.targetCd) * 100) + '%' : '0%';
      const rows = isAuto() ? autoRows() : [
        ['Money', `$${fmt(r.money)}`],
        ['Floor', `$${fmt(r.moneyFloor)}`],
        ['Next batch', r.nextBatch ? `${r.nextBatch} ${bld().plural} · $${fmt(r.nextBatchCost)}` : 'none affordable'],
        ['Free acres', `${r.freeAcres} of ${r.acresOwned} (${cfg.reserveAcres} spare)`],
        ['Cycles', `${fmt(stats.cycles)}${stats.built ? ` · +${fmt(stats.built)} CD` : ''}`],
        ['Net cost', stats.built ? `$${perCd()} / CD` : '—'],
        ['Rate', rt.cdh15 ?? rt.cdhAll ? `${fmtRate(rt.cdh15 ?? rt.cdhAll)} CD/h` : '—'],
        [`ETA ${fmt(rt.target)}`, etaText(rt)],
      ];
      refs.rows.replaceChildren(...rows.map(([k, v]) => K.row(k, v)));
      refs.state.textContent = cap(stateText());
    }
    renderForm(r);
    if (ui.tab === 'log' && !ui.min) { refs.logv.render(); refs.logv.markSeen(); }
    const unseen = ui.tab === 'log' ? 0 : refs.logv.unseen();
    P.setTabBadge('log', unseen ? unseen + ' new problem' + (unseen > 1 ? 's' : '') : '', true);
  }

  function render() {
    const r = read();
    const rt = rates(r);
    const t = tone();
    chrome?.setPill(!running ? 'Paused' : t === 'wait' ? 'Waiting' : (rt.etaH != null && !rt.capped ? fmtH(rt.etaH) : 'On'), t, !running && !resumable);
    chrome?.setChip(r ? `${fmt(r.cd)} CD` : 'CD Farm', t, `CD Farm · ${cap(stateText())}`);
    const open = !!P?.el.isConnected;
    chrome?.setOpen(open);
    if (open) renderPanel(r, rt);
  }

  function panel(show = true, opts = {}) {
    if (show) { if (!P) buildPanel(); P.mount(opts); } else P?.unmount();
    ui.open = !!show; saveUi();
    render();
  }

  function mountUi() {
    chrome = K.createChrome({
      label: 'CD Farm', navTitle: 'Build and demolish Lumber Camps or Farms for Construction Data', icon: ICON, navClass: 'cdf-tab', chipClass: 'cdf-chip',
      onToggle: () => K.togglePanel(P, ui, panel),
      chipInsert: (tools, el) => tools.insertBefore(el, tools.querySelector('.tip-anchor') || null),
    });
    chrome.mount();
    timer = setInterval(render, 1000);
    if (ui.open) panel(true); else render();
    addEventListener('resize', onResize);
  }

  function unmountUi() {
    clearInterval(timer); timer = null;
    P?.unmount(); chrome?.unmount();
    P = chrome = null;
    removeEventListener('resize', onResize);
  }

// continues the cd-farm closure from cd-farm-4.js (same try / IIFE)
  // ---- load --------------------------------------------------------------

  const saved = load();
  if (saved) {
    Object.assign(cfg, saved.cfg || {});
    stats = { ...freshStats(), ...(saved.stats || {}) };
    stopReason = saved.stopReason || '';
    restoreCfg = saved.restoreCfg || null;
    if (saved.measure) core.measure.restore(saved.measure);
    Object.assign(quarantine, saved.quarantine || {});
    // Saved before Auto existed: the old building value was only the default, so move to Auto. Drop retired settings.
    if (saved.cfg && !('pace' in saved.cfg)) {
      cfg.building = 'auto';
      if (typeof saved.cfg.minMoney === 'number' && saved.cfg.minMoney !== DEFAULTS.minMoney) cfg.autoFloor = saved.cfg.minMoney;   // your old Money floor now sits on top of Autopilot's
    }
    for (const k of ['delayMs', 'jitterMinMs', 'jitterMaxMs']) delete cfg[k];
    if (saved.running) { resumable = true; stopReason = 'interrupted (page reloaded)'; inFlight = saved.inFlight ?? null; }   // what was being sent when the page went away
  }

  // Settings out and in (the toolkit's Export / Import). cycles and maxSpend are per-run and never saved.
  const RUN_ONLY = ['cycles', 'maxSpend'];
  function exportCfg() { return { cfg: Object.fromEntries(Object.entries(cfg).filter(([k]) => !RUN_ONLY.includes(k))) }; }
  function importCfg(o) {
    if (running || active) throw new Error('stop the CD Farm run first');
    const applied = [], skipped = [];
    for (const [k, v] of Object.entries(o?.cfg ?? {})) {
      if (k in cfg && !RUN_ONLY.includes(k) && (k === 'building' ? v === 'auto' || BUILDINGS.some((b) => b.id === v) : typeof v === typeof cfg[k] && !Number.isNaN(v)) && (k !== 'pace' || v in PACE) && (k !== 'land' || v === 'off' || v === 'plan') && (!['batch', 'maxTypes'].includes(k) || v >= 1)) { cfg[k] = v; applied.push(k); } else skipped.push(k);
    }
    save(); render();
    return { applied, skipped };
  }

  window.cdFarm = {
    read, status, start, resume, stop, reset, panel, rates, cfg, exportCfg, importCfg, pauseAuto,
    get running() { return running; },
    get active() { return active; },        // a run is still executing (maybe finishing a step after stop())
    get resumable() { return resumable; },  // an interrupted run waits for Resume / Discard
    // Unassigned camps that belong to a running or interrupted run (Autopilot leaves them alone).
    get farmPool() { return Object.values(this.farmUnits).reduce((a, n) => a + n, 0); },
    // Unassigned buildings per type that belong to a running or interrupted run (Autopilot leaves them alone).
    get farmUnits() {
      if (!(running || active || resumable)) return {};
      const p = readPool();
      if (!p) return {};
      const out = {};
      if (isAuto()) for (const b of stats.types ?? []) out[b] = Math.max(0, Math.min((p.pool[b] ?? 0) - (stats.baseline?.[b] ?? 0), owedCap(b)));
      else out[farmId()] = Math.max(0, (p.pool[farmId()] ?? 0) - stats.baselinePool);
      return out;
    },
    evaluate: () => evaluateAuto(true),                     // the Auto planner's view right now (gates, plan, land)
    measure: () => console.table(core.measure.snapshot()),  // round trips, overhead, own waits: n, median, p90, MAD
    _setPacer: (p) => { pacer = p; },
    _hist: hist,
    _quarantine: quarantine,
    _waitMax: (ms) => { waitMaxMs = ms; },
    _graceMs: (ms) => { graceMs = ms; },
    _tick: () => controllerTick(),                         // tests: one pass of the always-on controller, without waiting for its timer
    _skipWaits: () => { bootAt = 0; cooldownUntil = 0; },   // tests: no boot delay or cooldown before the controller starts a run
    _sample: sample,                                       // tests: log net spend at a given time
    _newRun: () => { stats = freshStats(); },              // tests: reset stats as a run start does
    get stats() { return stats; },
    get building() { return farmId(); },    // id of the building the farm cycles (the run's own while one is on)
    _debug: () => ({ ...core.sock, ws: undefined, attached: !!core.sock.ws, inFlight, phase, active }),
    _unload: () => { unloaded = true; running = false; clearInterval(ctlTimer); unmountUi(); },
  };

  // Wait for the game to render and connect before mounting or resuming.
  (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    mountUi();
    ctlTimer = setInterval(() => controllerTick().catch((e) => console.error('[cdFarm]', e)), 2000);
    console.log('[cdFarm] ready. Open "CD Farm" in the sidebar, or use cdFarm.start() / cdFarm.stop()' + (resumable ? ' / cdFarm.resume()' : ''));
    if (resumable && cfg.autoResume) {
      while (!read()?.wsOpen) { if (unloaded) return; await sleep(500); }
      await sleep(2000); // let the fresh snapshot land
      resume();
    }
  })();
})();
} catch (e) { console.error('[IdleCorp] CD Farm failed to load:', e); }

// ============================================================================
// 3. LAB RUNNER
// ============================================================================
// Keeps every Manufacturing Lab busy: whenever a region's Lab slot is free it starts a research
// project (StartResearch), and it claims finished results (ClaimResearch). Open "Lab" in the game's
// sidebar (or click the Lab chip in the top bar). Settings there map to cfg below; the console API
// also works:
//   labRunner.start()                          // DRY RUN: logs "would send ...", sends nothing
//   labRunner.start({ dryRun: false })         // live
//   labRunner.start({ mode: 'list', list: [{ product: 41, focus: 1, tier: 'default' }] })
//   labRunner.stop() / status() / panel(true) / exportCfg() / importCfg(obj) / resetCfg()
//
// A project is a product (any good some recipe makes from inputs: 91 of them), a focus (0 Process
// study, 1 Module fabrication, 2 Quality engineering) and a tier (I, II, III; 0-2 on the wire). Paid at
// start: Tier I 1,000 MD; II 10,000 MD + 5 RD; III 100,000 MD + 1 Research Catalyst from that
// region's stock. One project per region that has a Lab. Success % = min(95, floor((90 / 70 / 50
// - 5 x focus) x (100 + bonus) / 100)), bonus = Labs owned + Insightful module quirks on Lab groups
// (+10 more while the Research Database megaproject is active: the game state doesn't show it, so
// the panel's figure leaves it out and says so).
//
// What it never sends: QueueResearch. The research queue is shared with the construction slot, and
// Autopilot treats anything in it as "research busy", so a project is only ever started (StartResearch)
// when that region's Lab slot is free. dryRun is on by default and is never remembered or imported:
// nothing is sent until you turn it off and confirm the start.
// @@MODULE lab
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');
  const HAS_DOM = typeof document !== 'undefined' && !!document.body;
  const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
  const KEY = 'labRunner.v1';
  const TAG = 'LAB';
  if (W.labRunner) {
    // Replace a previous copy without letting it overwrite the saved state.
    if (W.labRunner._unload) W.labRunner._unload();
    else { W.labRunner.stop(); W.labRunner.panel(false); }
  }

  // ---- game facts (read from the live client) -----------------------------------------------
  const LAB = 14;                          // Manufacturing Lab (building id)
  const MD = 25, RD = 26;                  // Manufacturing Data, Research Data: global, st.items
  const CATALYST = 63;                     // Research Catalyst: regional, st.stock[region]
  // Wire tier 0..2 = Tier I..III. md / rd are paid from st.items, cat from the project's region.
  const TIERS = [
    { name: 'I', base: 90, md: 1000, rd: 0, cat: 0 },
    { name: 'II', base: 70, md: 10000, rd: 5, cat: 0 },
    { name: 'III', base: 50, md: 100000, rd: 0, cat: 1 },
  ];
  const FOCUS = ['Process study', 'Module fabrication', 'Quality engineering'];   // StartResearch.context
  const REGION_NAMES = ['Heartland', 'Industrial Basin', 'Coastal Cities', 'Frontier'];
  const regionName = (r) => REGION_NAMES[r] ?? 'Region ' + r;
  const LIST_MAX = 50;
  const MAX_FAILS = 5;                     // sends (or errors) in a row before the run stops itself

  // ---- settings -----------------------------------------------------------------------------
  const MODE_IDS = ['process', 'modules', 'list'];
  const cfg = {
    mode: 'process',       // 'process' (focus 0) | 'modules' (focus 1) | 'list' (your own list)
    tierMode: 'best',      // 'best' (highest tier you can pay for) | 1 | 2 | 3 (that tier only: waits, never falls back)
    mdReserve: 5000,       // MD never spent below this
    autoClaim: true,       // claim finished results
    dryRun: true,          // log "would send ..." instead of sending (session-only: never remembered or imported)
    list: [],              // [{ product, focus: 0 | 1 | 2, tier: 'default' | 1 | 2 | 3 }], cycled in order
    intervalMs: 10000,     // look this often
    delayMs: 500,          // look again this soon after sending something
    jitterMinMs: 150,      // random extra wait before each command (min)
    jitterMaxMs: 900,      // random extra wait before each command (max)
    timeoutMs: 8000,       // max wait for the server to confirm a command
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const DEFAULTS = clone(cfg);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const validEntry = (e) => !!e && typeof e === 'object' && Number.isInteger(e.product) && e.product >= 0
    && [0, 1, 2].includes(e.focus) && (e.tier === 'default' || [1, 2, 3].includes(e.tier));
  const VALID = {
    mode: (v) => MODE_IDS.includes(v),
    tierMode: (v) => v === 'best' || v === 1 || v === 2 || v === 3,
    mdReserve: (v) => isNum(v) && v >= 0,
    autoClaim: (v) => typeof v === 'boolean',
    list: (v) => Array.isArray(v) && v.length <= LIST_MAX && v.every(validEntry),
    intervalMs: (v) => isNum(v) && v >= 500 && v <= 600000,
    delayMs: (v) => isNum(v) && v >= 0 && v <= 60000,
    jitterMinMs: (v) => isNum(v) && v >= 0 && v <= 60000,
    jitterMaxMs: (v) => isNum(v) && v >= 0 && v <= 60000,
    timeoutMs: (v) => isNum(v) && v >= 500 && v <= 120000,
  };
  const entryOf = (e) => ({ product: e.product, focus: e.focus, tier: e.tier });
  const take = (k, v) => (k === 'list' ? v.map(entryOf) : clone(v));   // a validated value, kept as a private copy (list entries: known fields only)

  // ---- persistence: settings, and what this runner has already done -------------------------------
  const SESSION_ONLY = ['dryRun'];
  const persistable = () => clone(Object.fromEntries(Object.entries(cfg).filter(([k]) => !SESSION_ONLY.includes(k))));
  let saved = {};
  try { saved = JSON.parse(store?.getItem(KEY) || '{}') ?? {}; } catch {}
  for (const [k, v] of Object.entries(saved.cfg || {})) if (k in cfg && !SESSION_ONLY.includes(k) && VALID[k]?.(v)) cfg[k] = take(k, v);
  // counts: projects started per product (what the Process / Modules pick rotates on); next: the next custom-list entry.
  const mem = { counts: {}, next: 0 };
  for (const [k, v] of Object.entries(saved.mem?.counts || {})) if (Number.isInteger(+k) && isNum(v) && v > 0) mem.counts[k] = v;
  if (Number.isInteger(saved.mem?.next) && saved.mem.next >= 0) mem.next = saved.mem.next;

  let unloaded = false;
  function save() {
    if (unloaded) return;
    try { store?.setItem(KEY, JSON.stringify({ cfg: persistable(), mem })); } catch {}
  }

  // ---- the Lab, as the game state shows it ---------------------------------------------------
  const fmt = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const asMap = (x) => (Array.isArray(x) ? new Map(x.map((o) => [o.id, o])) : new Map(Object.entries(x ?? {}).map(([k, o]) => [+k, o])));
  const ixCache = new WeakMap();
  // Catalog lookups, built once per catalog object. products = what the Lab's picker lists: base value above 0,
  // not a floor piece, and some recipe makes it from inputs (extraction doesn't count).
  function index(catalog) {
    let ix = ixCache.get(catalog);
    if (ix) return ix;
    const items = asMap(catalog.items), recipes = asMap(catalog.recipes), buildings = asMap(catalog.buildings);
    const fromInputs = new Set();
    for (const r of recipes.values()) if (r.inputs?.length > 0) for (const o of r.outputs ?? []) fromInputs.add(o.item);
    const products = new Map();
    for (const [id, it] of items) if (it.base_value > 0 && !it.floor_piece && fromInputs.has(id)) products.set(id, it);
    const byName = [...products.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    ix = { items, recipes, buildings, products, byName };
    ixCache.set(catalog, ix);
    return ix;
  }
  const pname = (ix, id) => ix.items.get(id)?.name ?? 'item ' + id;
  const focusName = (c) => FOCUS[c] ?? 'focus ' + c;
  const tierLabel = (t) => 'Tier ' + (TIERS[t]?.name ?? t);
  // Project time left: remaining is in ticks, 2 per second.
  function fmtLeft(ticks) {
    const m = Math.ceil(ticks / 120);
    if (!(m >= 1)) return '<1m';
    return m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : m + 'm';
  }
  function rewardText(rw) {
    if (rw == null || rw === '') return '';
    let s = '';
    try { s = typeof rw === 'string' ? rw : JSON.stringify(rw); } catch { return ''; }
    return s.length > 80 ? s.slice(0, 79) + '…' : s;
  }

  // Region ids the state mentions, ascending.
  function regionIds(st) {
    const ids = new Set(Object.keys(st.building_pool ?? {}).map(Number));
    for (const g of Object.values(st.groups ?? {})) ids.add(g.region ?? 0);
    return [...ids].filter(Number.isInteger).sort((a, b) => a - b);
  }
  // Labs in a region: the unassigned pool plus every Lab group there.
  function labsIn(st, region) {
    let n = st.building_pool?.[region]?.[LAB] ?? 0;
    for (const g of Object.values(st.groups ?? {})) if (g.building === LAB && (g.region ?? 0) === region) n += g.count ?? 0;
    return n;
  }
  // The project holding a region's Lab slot, or null. Construction research ({ building, remaining }) is a different slot.
  function slotOf(st, region) {
    const m = st.mfg_research?.[String(region)];
    if (m != null) return m;
    if (region === 0 && st.research?.product != null) return st.research;   // old saves keep a Heartland project in the construction slot
    return (st.research_queue ?? []).find((q) => q?.product != null && q.region === region) ?? null;
  }
  // Insightful module quirks installed in Lab groups: +pct each.
  function insightful(st) {
    let pct = 0;
    for (const g of Object.values(st.groups ?? {})) {
      if (g.building !== LAB) continue;
      for (const m of Object.values(g.modules ?? {})) {
        const def = st.module_defs?.[m && typeof m === 'object' ? m.id : m];
        for (const q of def?.quirks ?? []) if (q?.kind === 'Insightful') pct += Number(q.pct) || 0;
      }
    }
    return pct;
  }
  const successPct = (tier, focus, bonus) => Math.min(95, Math.floor((TIERS[tier].base - 5 * focus) * (100 + bonus) / 100));

  // Items the groups make now (output of each group's current recipe) that the Lab accepts.
  function produced(st, ix) {
    const out = new Set();
    for (const g of Object.values(st.groups ?? {})) {
      if (g.recipe == null || !(g.count > 0)) continue;
      for (const o of ix.recipes.get(g.recipe)?.outputs ?? []) if (ix.products.has(o.item)) out.add(o.item);
    }
    return out;
  }
  // Which project comes next: { product, focus, tier: 'default' | 1 | 2 | 3, index? } or { wait }.
  function pick(st, ix, c, counts, next) {
    if (c.mode === 'list') {
      const n = c.list.length;
      if (!n) return { wait: 'the custom list is empty' };
      const from = Number.isInteger(next) && next >= 0 ? next % n : 0;
      for (let k = 0; k < n; k++) {
        const i = (from + k) % n, e = c.list[i];
        if (e && ix.products.has(e.product) && FOCUS[e.focus] && (e.tier === 'default' || TIERS[e.tier - 1])) return { product: e.product, focus: e.focus, tier: e.tier, index: i };
      }
      return { wait: 'no list entry is a qualifying product' };
    }
    const focus = c.mode === 'modules' ? 1 : 0;
    const pool = [...produced(st, ix)];
    if (!pool.length) {
      // Module fabrication doesn't care which product; Process study needs one the corp actually makes.
      const top = focus === 1 ? [...ix.products.values()].sort((a, b) => b.base_value - a.base_value || a.id - b.id)[0] : null;
      return top ? { product: top.id, focus, tier: 'default' } : { wait: 'no produced product qualifies' };
    }
    // Fewest projects started so far; the pricier product on a tie.
    pool.sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0) || ix.products.get(b).base_value - ix.products.get(a).base_value || a - b);
    return { product: pool[0], focus, tier: 'default' };
  }
  // Why tier t (0-2) can't be paid now ('' = it can): its cost against what is left, with the reserve kept back.
  function shortfall(t, have, region, reserve) {
    const k = TIERS[t];
    if (k.cat && have.cat < k.cat) return `Tier ${k.name} needs a Catalyst in ${regionName(region)}`;
    if (k.rd && have.rd < k.rd) return `Tier ${k.name} needs ${k.rd} Research Data (have ${fmt(have.rd)})`;
    if (have.md - k.md < reserve) return `MD ${fmt(have.md)} < ${fmt(k.md)} + reserve ${fmt(reserve)}`;
    return '';
  }

  // The next step, from state alone: no I/O, no side effects (the test seam, also what the panel shows).
  // Returns { msg, kind, reason, ... } for the first thing to send, or { wait } when there is nothing to do,
  // and in both cases actions (everything that would be sent, in order, each region counting what the
  // ones before it will have used), regions (one row per region with a Lab) and the totals the panel shows.
  // Order: claim the oldest finished result, then one StartResearch per region whose slot is free.
  function decide(st, catalog, cfgIn = cfg, memIn = mem) {
    const c = { ...DEFAULTS, ...cfgIn };
    if (!Array.isArray(c.list)) c.list = [];
    const ix = index(catalog);
    const ids = regionIds(st);
    const labs = {};
    let owned = 0;
    for (const r of ids) { labs[r] = labsIn(st, r); owned += labs[r]; }
    const insight = insightful(st);
    const bonus = owned + insight;
    const md = st.items?.[MD] ?? 0, rd = st.items?.[RD] ?? 0;
    const left = { md, rd, cat: {} };
    const counts = { ...(memIn?.counts ?? {}) };
    let next = memIn?.next ?? 0;
    const pending = (st.pending_results ?? []).filter((p) => Number.isFinite(p?.tick)).sort((a, b) => a.tick - b.tick);
    const actions = [], regions = [];

    if (c.autoClaim && pending.length) {
      const p = pending[0];
      const label = `${pname(ix, p.product)} · ${focusName(p.context)} · ${tierLabel(p.tier)}`, reward = rewardText(p.reward);
      actions.push({ kind: 'claim', key: 'claim:' + p.tick, tick: p.tick, label, reward,
        msg: { type: 'ClaimResearch', tick: p.tick }, reason: 'claim ' + label + (reward ? ' (' + reward + ')' : '') });
    }
    for (const r of ids) {
      if (!labs[r]) continue;
      const slot = slotOf(st, r);
      const row = { region: r, name: regionName(r), labs: labs[r], slot, wait: '', start: null, catalyst: st.stock?.[r]?.[CATALYST] ?? 0 };
      regions.push(row);
      if (slot) {
        row.wait = `slot busy: ${pname(ix, slot.product)} ${focusName(slot.context)}, ` + (slot.remaining != null ? fmtLeft(slot.remaining) + ' left' : 'queued');
        continue;
      }
      const p = pick(st, ix, c, counts, next);
      if (p.wait) { row.wait = p.wait; continue; }
      const have = { md: left.md, rd: left.rd, cat: left.cat[r] ?? row.catalyst };
      const setting = p.tier === 'default' ? c.tierMode : p.tier;
      const ladder = setting === 'best' || !TIERS[setting - 1] ? [2, 1, 0] : [setting - 1];
      const tier = ladder.find((t) => !shortfall(t, have, r, c.mdReserve));
      if (tier === undefined) { row.wait = shortfall(ladder[ladder.length - 1], have, r, c.mdReserve); continue; }
      const k = TIERS[tier], pct = successPct(tier, p.focus, bonus);
      const label = `${pname(ix, p.product)} · ${focusName(p.focus)} · Tier ${k.name}`;
      const a = { kind: 'start', key: 'start:' + r, region: r, regionName: row.name, product: p.product, focus: p.focus, tier, index: p.index, pct, label,
        msg: { type: 'StartResearch', product: p.product, context: p.focus, tier, region: r },
        reason: `start ${label} in ${row.name} (${pct}% success)` };
      row.start = a;
      actions.push(a);
      // The next region sees what this one will have used.
      left.md -= k.md; left.rd -= k.rd; left.cat[r] = have.cat - k.cat;
      counts[p.product] = (counts[p.product] ?? 0) + 1;
      if (p.index != null) next = (p.index + 1) % c.list.length;
    }
    const info = { actions, regions, pending: pending.length, md, rd, labs: owned, insight, bonus };
    if (actions.length) return { ...actions[0], ...info };
    const wait = regions.length ? regions.map((x) => (regions.length > 1 ? x.name + ': ' : '') + x.wait).join(' | ') : 'no Manufacturing Lab built yet';
    return { wait, ...info };
  }

  // Does the game still look like what this script was written against? Live mode needs it.
  function checkGame(st, catalog) {
    const bad = [];
    const miss = core.missingFields(st, ['groups', 'stock', 'ssi', 'items']);
    if (miss.length) bad.push('state is missing ' + miss.join(', '));
    const ix = index(catalog);
    if (!ix.items.size) bad.push('catalog.items is empty');
    if (!ix.recipes.size) bad.push('catalog.recipes is empty');
    if (!/lab/i.test(ix.buildings.get(LAB)?.name ?? '')) bad.push(`building ${LAB} is not the Manufacturing Lab`);
    for (const [id, word] of [[MD, 'Manufacturing Data'], [RD, 'Research Data'], [CATALYST, 'Catalyst']]) {
      if (!String(ix.items.get(id)?.name ?? '').includes(word)) bad.push(`item ${id} is not ${word}`);
    }
    if (!ix.products.size) bad.push('no product qualifies for research');
    return bad;
  }

// continues the lab closure from lab-1.js (same try / IIFE)
  // ---- state access -----------------------------------------------------------------------------
  class ConnError extends Error {}

  function read(fresh = false) {
    const { ws, st, catalog } = core.walk(fresh);
    if (!st || !catalog) return null;
    return { st, catalog, mutTick: st.ssi?.last_user_mutation_tick ?? 0, wsOpen: ws?.readyState === 1, ws };
  }
  function mustRead(fresh = false) {
    const r = read(fresh);
    if (!r) throw new ConnError('game state not found');
    return r;
  }
  // Why Live must not run right now ('' = fine). Dry runs and the offline tests (no DOM) are never blocked.
  function liveBlocked() {
    if (!HAS_DOM || cfg.dryRun) return '';
    const r = read(true);
    if (!r) return 'the game state was not found';
    const bad = checkGame(r.st, r.catalog);
    return bad.length ? 'the game data no longer looks like what this script expects (' + bad.join('; ') + ')' : '';
  }

  // ---- sending -----------------------------------------------------------------------------------
  const sleep = core.sleep;
  const jitter = () => {
    const lo = Math.max(0, cfg.jitterMinMs || 0), hi = Math.max(lo, cfg.jitterMaxMs || 0);
    return sleep(lo + Math.random() * (hi - lo));
  };
  // Sleep that stop() (or unload) ends at once.
  let kick = null;
  const nap = (ms) => new Promise((res) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (kick === done) kick = null; res(); }
    kick = done;
  });
  // Sends a command; returns the mutation-Diff count at send time.
  function send(msg) {
    const r = mustRead(true);
    if (!r.wsOpen) throw new ConnError('socket not open');
    const d = core.markSend(r.mutTick);   // only a later mutation confirms this command
    r.ws.send(JSON.stringify(msg));
    return d;
  }
  // Waits until the server has applied a player command after this one was sent AND the state shows it.
  const waitConfirm = (pred, d0) => core.waitConfirm({ read, pred, d0, timeoutMs: cfg.timeoutMs, closed: () => { throw new ConnError('socket closed while waiting'); } });
  const confirmed = (a) => (a.kind === 'claim'
    ? (r) => !(r.st.pending_results ?? []).some((p) => p.tick === a.tick)
    : (r) => slotOf(r.st, a.region) != null);

  // ---- run loop ----------------------------------------------------------------------------------
  let running = false, active = false, stopReason = '', stopFailed = false, fails = 0, lastNote = '', wouldSig = '';
  const cool = new Map();   // action key → { n, until }: an action the server didn't apply waits before it is tried again
  const cooling = (key) => (cool.get(key)?.until ?? 0) > Date.now();
  const sess = { started: 0, claimed: 0 };
  const note = (line) => { if (line !== lastNote) { lastNote = line; console.log('[labRunner] ' + line); } };

  const doneText = (a) => (a.kind === 'claim' ? 'claimed ' + a.label + (a.reward ? ': ' + a.reward : '') : `started ${a.label} in ${a.regionName} (${a.pct}% success)`);

  // Dry run: say what would be sent, once per change.
  function wouldSend(d) {
    const sig = d.actions.map((a) => JSON.stringify(a.msg)).join('|');
    if (sig === wouldSig) return;
    wouldSig = sig;
    for (const a of d.actions) {
      const line = 'would send ' + JSON.stringify(a.msg) + ' — ' + a.reason;
      console.log('[labRunner] ' + line);
      core.ledger.add(TAG, 'info', line);
    }
  }

  // One look at the game: send the first thing that is due. Returns 'sent' (something went out, confirmed or not) or 'idle'.
  async function pass() {
    const r = mustRead();
    if (!r.wsOpen) throw new ConnError('socket not open');
    const d = decide(r.st, r.catalog);
    if (cfg.dryRun) { wouldSend(d); return 'idle'; }
    if (!d.actions.some((x) => !cooling(x.key))) return 'idle';
    await jitter();
    if (!running) return 'idle';
    // The state may have moved during the wait: decide again on fresh state and send only what is still due.
    const r2 = mustRead(true);
    const a = decide(r2.st, r2.catalog).actions.find((x) => !cooling(x.key));
    if (!a) return 'idle';
    const d0 = send(a.msg);
    if (await waitConfirm(confirmed(a), d0)) {
      fails = 0;
      cool.delete(a.key);
      if (a.kind === 'claim') sess.claimed++;
      else {
        sess.started++;
        mem.counts[a.product] = (mem.counts[a.product] ?? 0) + 1;
        if (a.index != null) mem.next = (a.index + 1) % cfg.list.length;
      }
      save();
      console.log('[labRunner] ' + doneText(a));
      core.ledger.add(TAG, 'action', doneText(a));
      return 'sent';
    }
    // Not applied: back off on this action (30 s, doubling to 10 min) so it can't hold up the others.
    const c = cool.get(a.key) ?? { n: 0 };
    c.n++; c.until = Date.now() + Math.min(600000, 30000 * 2 ** (c.n - 1));
    cool.set(a.key, c);
    core.ledger.add(TAG, 'fail', `not confirmed: ${a.reason}; trying again in ${Math.round((c.until - Date.now()) / 1000)} s`);
    if (++fails >= MAX_FAILS) { stopReason = `${MAX_FAILS} commands in a row were not confirmed`; stopFailed = true; running = false; }
    return 'sent';
  }

  async function loop() {
    active = true;
    let errors = 0;
    while (running) {
      let pause = cfg.intervalMs;
      try {
        if ((await pass()) === 'sent') pause = cfg.delayMs;
        errors = 0;
      } catch (e) {
        if (e instanceof ConnError) { note(e.message + ': waiting for the game connection'); pause = 2000; }
        else {
          console.warn('[labRunner]', e);
          core.ledger.add(TAG, 'fail', 'error: ' + e.message);
          if (++errors >= MAX_FAILS) { stopReason = 'error: ' + e.message; stopFailed = true; running = false; break; }
        }
      }
      if (running) await nap(pause);
    }
    running = false; active = false;
    if (unloaded) return;
    save();
    console.log(`[labRunner] stopped: ${stopReason}`);
    core.ledger.add(TAG, stopFailed ? 'fail' : 'info', `stopped: ${stopReason}`);
    if (stopFailed) core.notify(TAG, 'Lab runner stopped', stopReason);
    render();
  }

  // ---- control -----------------------------------------------------------------------------------
  function start(opts = {}) {
    if (running) return console.warn('[labRunner] already running');
    if (active) return console.warn('[labRunner] the previous run is still finishing its step; try again in a moment');
    for (const [k, v] of Object.entries(opts)) {
      const ok = k === 'dryRun' ? typeof v === 'boolean' : k in cfg && !!VALID[k]?.(v);
      if (ok) cfg[k] = take(k, v); else console.warn(`[labRunner] ignored ${k}: not a setting, or not a valid value for it`);
    }
    if (!cfg.dryRun) {
      const why = liveBlocked();
      if (why) {
        cfg.dryRun = true;
        console.warn('[labRunner] Live refused: ' + why + '. Starting as a dry run.');
        core.toast('Live refused: the game data changed. Started as a dry run (see the console).', 'error');
        core.ledger.add(TAG, 'fail', 'Live refused: ' + why);
      }
    }
    running = true; stopReason = ''; stopFailed = false; fails = 0; lastNote = ''; wouldSig = '';
    cool.clear(); sess.started = sess.claimed = 0;
    save();
    console.log(`[labRunner] start (${cfg.dryRun ? 'DRY RUN: start({ dryRun: false }) to send' : 'LIVE'})`);
    core.ledger.add(TAG, 'info', `started (${cfg.dryRun ? 'dry run' : 'live'}): ${cfg.mode === 'list' ? 'custom list' : cfg.mode === 'modules' ? 'module fabrication' : 'process study'}, ${cfg.tierMode === 'best' ? 'best affordable tier' : 'Tier ' + TIERS[cfg.tierMode - 1].name}, keeps ${fmt(cfg.mdReserve)} MD`);
    loop();
    render();
  }

  function stop() {
    if (running) { stopReason = 'stopped by you'; console.log('[labRunner] stopping'); }
    running = false;
    kick?.();
    render();
  }

  // Settings out and in (the toolkit's Export / Import). dryRun is never exported or imported.
  function exportCfg() { return { cfg: persistable() }; }
  function importCfg(o) {
    if (running && !cfg.dryRun) throw new Error('stop the live run first');
    const applied = [], skipped = [];
    for (const [k, v] of Object.entries(o?.cfg ?? {})) {
      if (k in cfg && !SESSION_ONLY.includes(k) && VALID[k]?.(v)) { cfg[k] = take(k, v); applied.push(k); } else skipped.push(k);
    }
    save(); render();
    return { applied, skipped };
  }
  function resetCfg() {
    if (running && !cfg.dryRun) throw new Error('stop the live run first');
    for (const k of Object.keys(DEFAULTS)) if (!SESSION_ONLY.includes(k)) cfg[k] = clone(DEFAULTS[k]);
    save(); render();
  }

  // ---- what the panel and status() show -------------------------------------------------------------
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const slotLine = (ix, p) => `${pname(ix, p.product)} · ${focusName(p.context)} · ${tierLabel(p.tier)} · ` + (p.remaining != null ? fmtLeft(p.remaining) + ' left' : 'queued');

  function summary(r) {
    const d = decide(r.st, r.catalog);
    const ix = index(r.catalog);
    const rows = d.regions.map((x) => ({ name: x.name, busy: !!x.slot, catalyst: x.catalyst, text: x.slot ? slotLine(ix, x.slot) : x.start ? 'ready: ' + x.start.label : x.wait }));
    return { d, ix, rows, busy: rows.filter((x) => x.busy).length, total: rows.length };
  }
  // Success chance for the current setting, as the client works it out (no Research Database bonus: the state doesn't say).
  function successInfo(r, sum) {
    const d = sum.d;
    const p = cfg.mode === 'list' ? pick(r.st, sum.ix, cfg, mem.counts, mem.next) : null;
    const focus = p && !p.wait ? p.focus : cfg.mode === 'modules' ? 1 : 0;
    const setting = p && !p.wait && p.tier !== 'default' ? p.tier : cfg.tierMode;
    const pct = (t) => successPct(t, focus, d.bonus);
    const fixed = TIERS[setting - 1];
    return {
      text: fixed ? `${pct(setting - 1)}% (Tier ${fixed.name})` : 'Tier ' + TIERS.map((k, t) => `${k.name} ${pct(t)}%`).join(' · '),
      note: `${focusName(focus)}; bonus +${d.bonus}% (${d.labs} Lab${d.labs === 1 ? '' : 's'}${d.insight ? ` + ${d.insight}% Insightful` : ''}). Leaves out the Research Database megaproject bonus (+10).`,
    };
  }
  // 'run' | 'wait' | 'err' | '' for the status dot.
  function tone() {
    if (running) return cfg.dryRun ? 'wait' : 'run';
    return stopFailed ? 'err' : '';
  }
  function stateText(sum) {
    if (running) {
      const d = sum?.d;
      const next = !d ? 'running' : d.actions.length ? 'next: ' + d.actions[0].reason : 'waiting: ' + d.wait;
      return (cfg.dryRun ? 'Dry run. ' : '') + cap(next);
    }
    return stopReason ? 'Stopped: ' + stopReason : 'Idle. Press Start.';
  }

  function status() {
    const r = read();
    if (!r) return console.error('[labRunner] game state not found');
    const sum = summary(r), info = successInfo(r, sum), t = {};
    if (sum.total) for (const x of sum.rows) t[x.name] = x.text; else t.Labs = 'none built yet';
    t['Results waiting'] = sum.d.pending + (cfg.autoClaim ? '' : ' (auto-claim off)');
    t.MD = `${fmt(sum.d.md)} (keeps ${fmt(cfg.mdReserve)})`;
    t.RD = fmt(sum.d.rd);
    t.Catalyst = sum.rows.map((x) => `${x.name} ${fmt(x.catalyst)}`).join(', ') || '-';
    t.Success = info.text + ' · ' + info.note;
    t.State = stateText(sum);
    console.table(t);
  }

// continues the lab closure from lab-2.js (same try / IIFE)
  // ---- game UI -------------------------------------------------------------------------------------
  // Same look as CD Farm (core.ui): a "Lab" tab in the sidebar, a chip in the top bar, and a card that
  // opens from either. Nothing here runs without a DOM, so the offline tests are unaffected.

  const UI_KEY = 'labRunner.ui';
  const ui = (() => { try { return { open: false, x: null, y: null, ...JSON.parse(store?.getItem(UI_KEY) || '{}') }; } catch { return { open: false, x: null, y: null }; } })();
  const saveUi = () => { try { store?.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };

  const ICON = '<svg class="nav-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h4"></path><path d="M9 3v5.2L4.7 15.3a1.5 1.5 0 0 0 1.3 2.2h8a1.5 1.5 0 0 0 1.3-2.2L11 8.2V3"></path><path d="M6.6 13h6.8" style="stroke:var(--nav-accent)"></path></svg>';
  const svg16 = (d) => '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const ARROWS = { up: svg16('<path d="M4 10l4-4 4 4"/>'), down: svg16('<path d="M4 6l4 4 4-4"/>') };

  const h = core.h;
  const K = core.ui;
  let P = null, chrome = null, timer = null;
  const refs = {};
  let confirmUntil = 0;
  const parseErr = {};

  const MODES = [
    { id: 'process', label: 'Process study', desc: 'Process study on products your groups make: the one studied least so far, the pricier one on a tie.' },
    { id: 'modules', label: 'Modules', desc: 'Module fabrication (5 points less likely to succeed). Products picked the same way; if none of yours qualifies, the most valuable one.' },
    { id: 'list', label: 'Custom list', desc: 'Your own list, in order, round and round. Entries that are not Lab products are skipped.' },
  ];
  const TIER_OPTS = [{ id: 'best', label: 'Best' }, { id: 1, label: 'I' }, { id: 2, label: 'II' }, { id: 3, label: 'III' }];
  const TIER_DESC = {
    best: 'Best affordable: Tier III with 100,000 MD and a Catalyst in that region, else II (10,000 MD + 5 RD), else I (1,000 MD). The reserve stays untouched.',
    1: 'Tier I only (1,000 MD). Waits when it can\'t pay; never moves to another tier.',
    2: 'Tier II only (10,000 MD + 5 RD). Waits when it can\'t pay; never moves to another tier.',
    3: 'Tier III only (100,000 MD + a Catalyst in that region). Waits when it can\'t pay; never moves to another tier.',
  };
  const RESERVE_CHIPS = [0, 1000, 5000, 20000, 100000];
  const short = (x) => (x >= 1e6 ? `${+(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${+(x / 1e3).toFixed(1)}k` : String(Math.round(x)));
  const FIELDS = { mdReserve: { label: 'MD reserve', min: 0, max: 1e9 } };
  const parseAmount = (s) => {
    const m = String(s).trim().replace(/[$,\s_]/g, '').match(/^(\d*\.?\d+)([kmb])?$/i);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1));
  };
  function parseField(key, text) {
    const f = FIELDS[key], s = text.trim();
    if (s === '') return { err: 'Required.' };
    const v = parseAmount(s);
    if (v == null) return { err: 'Use a number like 5000, 5k or 50,000.' };
    if (v < f.min) return { err: `Must be at least ${fmt(f.min)}.` };
    if (v > f.max) return { err: `Must be at most ${fmt(f.max)}.` };
    return { v };
  }
  const shown = (key) => fmt(cfg[key]);
  function setCfg(key, v) { cfg[key] = v; confirmUntil = 0; save(); render(); }
  const setOn = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
  const chip = (text, onclick) => h('button', { type: 'button', onclick }, text);
  function setMsg(el, m) { el.hidden = !m; el.className = 'idc-msg ' + (m?.level || ''); el.textContent = m?.text || ''; }

  function textField(key) {
    const f = FIELDS[key];
    const { input, box } = K.inputBox({ label: f.label, suffix: 'MD' });
    const msg = h('div', { class: 'idc-msg', hidden: true });
    const revert = () => { delete parseErr[key]; input.value = shown(key); };
    input.addEventListener('input', () => {
      const p = parseField(key, input.value);
      if (p.err) { parseErr[key] = p.err; render(); } else { delete parseErr[key]; setCfg(key, p.v); }
    });
    input.addEventListener('blur', () => { revert(); render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { revert(); input.blur(); }
    });
    refs.fields[key] = { input, box, msg };
    return { box, msg };
  }

  // ---- custom list editor ----
  // The rows are rebuilt only when the list (or the product catalog) changes, never while you are choosing in a select.
  const listSig = (r) => (r ? index(r.catalog).products.size : 0) + '|' + JSON.stringify(cfg.list);
  function setList(list, rebuild = true) {
    cfg.list = list; confirmUntil = 0; save();
    if (!rebuild) refs.listSig = listSig(read());   // the controls already show it
    render();
  }
  function editEntry(i, patch) {
    if (!cfg.list[i]) return;
    setList(cfg.list.map((e, j) => (j === i ? { ...e, ...patch } : e)), false);
  }
  function moveEntry(i, d) {
    const j = i + d;
    if (j < 0 || j >= cfg.list.length) return;
    const l = cfg.list.slice();
    [l[i], l[j]] = [l[j], l[i]];
    refs.focusRow = [j, d < 0 ? 'up' : 'down'];
    setList(l);
  }
  function removeEntry(i) {
    refs.focusRow = [Math.min(i, cfg.list.length - 2), 'del'];
    setList(cfg.list.filter((_, j) => j !== i));
  }
  function addEntry() {
    const r = read();
    if (!r || cfg.list.length >= LIST_MAX) return;
    const ix = index(r.catalog);
    const made = [...produced(r.st, ix)].map((id) => ix.products.get(id));
    const best = (made.length ? made : [...ix.products.values()]).sort((a, b) => b.base_value - a.base_value || a.id - b.id)[0];
    if (!best) return;
    refs.focusRow = [cfg.list.length, 'del'];
    setList([...cfg.list, { product: best.id, focus: 0, tier: 'default' }]);
  }
  function rowBtn(icon, label, act, onclick, disabled) {
    const b = h('button', { type: 'button', class: 'idc-ib', title: label, 'aria-label': label, onclick, disabled });
    b.setAttribute('data-act', act);
    b.innerHTML = icon;
    return b;
  }
  function listRow(ix, e, i, n) {
    const known = ix.products.has(e.product);
    const prod = h('select', { class: 'idc-sel', 'aria-label': `Product, entry ${i + 1}`, onchange: () => editEntry(i, { product: +prod.value }) },
      ...(known ? [] : [h('option', { value: String(e.product) }, `Not a Lab product (#${e.product})`)]),
      ...ix.byName.map((it) => h('option', { value: String(it.id) }, it.name)));
    prod.value = String(e.product);
    const foc = h('select', { class: 'idc-sel', 'aria-label': `Focus, entry ${i + 1}`, onchange: () => editEntry(i, { focus: +foc.value }) },
      ...FOCUS.map((f, k) => h('option', { value: String(k) }, f)));
    foc.value = String(e.focus);
    const tier = h('select', { class: 'idc-sel', 'aria-label': `Tier, entry ${i + 1}`, onchange: () => editEntry(i, { tier: tier.value === 'default' ? 'default' : +tier.value }) },
      h('option', { value: 'default' }, 'Default tier'), ...TIERS.map((k, t) => h('option', { value: String(t + 1) }, 'Tier ' + k.name)));
    tier.value = String(e.tier);
    return h('div', { class: 'idc-lrow' + (known ? '' : ' skip'), title: known ? '' : 'Skipped: not a product the Lab accepts' },
      h('div', { class: 'idc-lctl' }, prod,
        rowBtn(ARROWS.up, 'Move up', 'up', () => moveEntry(i, -1), i === 0),
        rowBtn(ARROWS.down, 'Move down', 'down', () => moveEntry(i, 1), i === n - 1),
        rowBtn(K.ICONS.close, 'Remove entry', 'del', () => removeEntry(i))),
      h('div', { class: 'idc-two' }, foc, tier));
  }
  function renderList(r) {
    const sig = listSig(r);
    if (sig !== refs.listSig) {
      refs.listSig = sig;
      const ix = r ? index(r.catalog) : null;
      refs.list.replaceChildren(...(ix ? cfg.list.map((e, i) => listRow(ix, e, i, cfg.list.length)) : []));
      if (refs.focusRow) {
        const [j, act] = refs.focusRow;
        const row = refs.list.children[j];
        (row?.querySelector(`[data-act="${act}"]:not(:disabled)`) ?? row?.querySelector('select') ?? refs.addBtn).focus();
      }
    }
    refs.focusRow = null;   // one-shot: only for the rebuild it was asked for
    const n = cfg.list.length;
    refs.addBtn.disabled = !r || n >= LIST_MAX;
    refs.listNote.textContent = !n ? 'The list is empty: nothing starts until you add an entry.'
      : `Cycles in order. Next up: #${(Number.isInteger(mem.next) ? mem.next % n : 0) + 1}.`;
  }

  // ---- panel ----
  function onMain() {
    if (running) return stop();
    if (cfg.dryRun) return start();
    if (Date.now() < confirmUntil) { confirmUntil = 0; return start(); }
    confirmUntil = Date.now() + 6000;
    render();
    setTimeout(render, 6100);
  }
  function doReset() {
    try {
      const snap = exportCfg();
      resetCfg();
      core.toast('Lab settings are back to their defaults', { undo: () => { if (unloaded) return; try { importCfg(snap); } catch (e) { core.toast(e.message, 'error'); } } });
    } catch (e) { core.toast(e.message, 'error'); }
  }

  function buildPanel() {
    refs.badge = h('span', { class: 'idc-badge' });

    // ---- Status tab
    refs.big = h('span', { class: 'idc-big' });
    refs.sub = h('span', { class: 'idc-label' });
    refs.bar = h('i');
    refs.rows = h('div', { class: 'idc-rows' });
    refs.successNote = h('div', { class: 'idc-desc' });
    refs.stateDot = h('span', { class: 'idc-dot' });
    refs.state = h('span');
    const status = [
      h('div', {}, h('div', { class: 'idc-label' }, 'Lab slots busy'), h('div', { class: 'idc-hero' }, refs.big, refs.sub), h('div', { class: 'idc-bar' }, refs.bar)),
      refs.rows, refs.successNote,
      h('div', { class: 'idc-state' }, refs.stateDot, refs.state)];

    // ---- Settings tab
    refs.fields = {};
    refs.mode = K.seg(MODES, () => cfg.mode, (id) => setCfg('mode', id), 'Research focus');
    refs.modeDesc = h('div', { class: 'idc-desc' });
    refs.tier = K.seg(TIER_OPTS, () => cfg.tierMode, (id) => setCfg('tierMode', id), 'Tier');
    // The shell is 340 px wide: the buttons carry short labels, the full names are the tooltip and the accessible name.
    const fullNames = (seg, names) => seg.btns.forEach((b, i) => { b.title = names[i]; b.setAttribute('aria-label', names[i]); });
    fullNames(refs.mode, ['Process study', 'Module fabrication', 'Custom list']);
    fullNames(refs.tier, ['Best affordable', 'Tier I', 'Tier II', 'Tier III']);
    refs.tierDesc = h('div', { class: 'idc-desc' });
    const reserve = textField('mdReserve');
    refs.reserveChips = RESERVE_CHIPS.map((v) => [v, chip(short(v), () => setCfg('mdReserve', v))]);
    refs.autoClaim = h('input', { type: 'checkbox', onchange: () => setCfg('autoClaim', refs.autoClaim.checked) });
    refs.autoLabel = K.check(refs.autoClaim, 'Claim finished results', 'Claims the oldest waiting result first, one per check.');
    refs.dry = h('input', { type: 'checkbox', onchange: () => { cfg.dryRun = refs.dry.checked; confirmUntil = 0; render(); } });
    refs.dryLabel = K.check(refs.dry, 'Dry run', 'Works out every step and logs "would send …", but sends nothing. Not remembered after a reload.');
    refs.fieldEl = {
      mode: K.field('Research focus', refs.mode.el, refs.modeDesc),
      tier: K.field('Tier', refs.tier.el, refs.tierDesc),
      mdReserve: K.field('MD reserve', reserve.box, h('div', { class: 'idc-quicks' }, ...refs.reserveChips.map(([, b]) => b)), reserve.msg),
    };
    refs.list = h('div', { class: 'idc-group' });
    refs.addBtn = h('button', { type: 'button', onclick: addEntry }, 'Add entry');
    refs.listNote = h('div', { class: 'idc-desc' });
    refs.listBox = K.group('Custom list', refs.list, h('div', { class: 'idc-tools' }, refs.addBtn), refs.listNote);
    const lockIcon = h('span', { 'aria-hidden': 'true' });
    lockIcon.innerHTML = K.ICONS.lock;
    refs.lock = h('div', { class: 'idc-lock' }, lockIcon, 'Stop the live run to change settings.');
    refs.fs = h('fieldset', { class: 'idc-form' },
      K.group('Research', refs.fieldEl.mode, refs.fieldEl.tier),
      refs.listBox,
      K.group('Spending', refs.fieldEl.mdReserve),
      K.group('Automation', refs.autoLabel, refs.dryLabel));
    refs.importBtn = h('button', { type: 'button', onclick: () => core.importFile() }, 'Import settings');
    refs.resetBtn = K.confirmBtn('Reset settings', doReset, 'Click again to reset');
    const backup = K.group('Backup', h('div', { class: 'idc-tools' }, h('button', { type: 'button', onclick: () => core.exportFile() }, 'Export settings'), refs.importBtn, refs.resetBtn));

    // ---- Log tab (this module's lines only)
    refs.logv = K.createLogView({ mod: TAG });
    const logTab = [
      refs.logv.el,
      h('div', { class: 'idc-tools' }, h('button', { type: 'button', onclick: () => core.ledger.copy() }, 'Copy log')),
      h('div', { class: 'idc-desc' }, 'Shows Lab lines only; Copy log copies every module\'s lines. Alt+Shift+X stops Autopilot, CD Farm and the Lab runner from anywhere on the page.')];

    // ---- Footer (always visible)
    refs.plan = h('div', { class: 'idc-plan' });
    refs.alt = h('button', { onclick: () => { confirmUntil = 0; render(); } }, 'Cancel');
    refs.main = h('button', { class: 'primary', onclick: onMain });
    const foot = h('div', { class: 'idc-foot' }, refs.plan, h('div', { class: 'idc-btns' }, refs.alt, refs.main));

    P = K.createPanel({
      id: 'lab', title: 'Lab', cls: 'lab-panel', state: ui, save: saveUi, headExtra: [refs.badge], foot,
      tabs: [{ id: 'status', label: 'Status', content: status }, { id: 'settings', label: 'Settings', content: [refs.lock, refs.fs, backup] }, { id: 'log', label: 'Log', content: logTab }],
      onClose: () => panel(false), onTab: () => render(), opener: () => chrome?.opener,
      defaultPlace: () => ({ right: 20 }),
    });
    refs.dot = P.dot;
  }

  function renderForm(r) {
    const locked = running && !cfg.dryRun;
    refs.fs.disabled = locked;
    refs.lock.hidden = !locked;
    refs.dry.disabled = running || active;   // Live is chosen before Start, behind its confirm step
    refs.importBtn.disabled = refs.resetBtn.disabled = locked;
    refs.mode.sync(); refs.tier.sync();
    refs.modeDesc.textContent = MODES.find((m) => m.id === cfg.mode)?.desc || '';
    refs.tierDesc.textContent = TIER_DESC[cfg.tierMode] || '';
    refs.listBox.hidden = cfg.mode !== 'list';
    for (const [key, f] of Object.entries(refs.fields)) {
      if (document.activeElement !== f.input) f.input.value = shown(key);
      setMsg(f.msg, parseErr[key] ? { level: 'error', text: parseErr[key] } : null);
      f.box.classList.toggle('bad', !!parseErr[key]);
    }
    for (const [v, b] of refs.reserveChips) setOn(b, cfg.mdReserve === v);
    refs.autoClaim.checked = !!cfg.autoClaim;
    refs.dry.checked = !!cfg.dryRun;
    if (cfg.mode === 'list') renderList(r);

    // Which settings differ from the defaults: a reset button on each field, a dot on the tab.
    let changed = 0;
    const mod = (el, differs, hint, reset) => { if (differs) changed++; K.setModified(el, differs, 'Reset to the default (' + hint + ')', reset); };
    mod(refs.fieldEl.mode, cfg.mode !== DEFAULTS.mode, MODES.find((m) => m.id === DEFAULTS.mode).label, () => setCfg('mode', DEFAULTS.mode));
    mod(refs.fieldEl.tier, cfg.tierMode !== DEFAULTS.tierMode, TIER_OPTS.find((o) => o.id === DEFAULTS.tierMode).label, () => setCfg('tierMode', DEFAULTS.tierMode));
    mod(refs.fieldEl.mdReserve, cfg.mdReserve !== DEFAULTS.mdReserve, fmt(DEFAULTS.mdReserve), () => { delete parseErr.mdReserve; setCfg('mdReserve', DEFAULTS.mdReserve); });
    const claimMod = !!cfg.autoClaim !== !!DEFAULTS.autoClaim;
    refs.autoLabel.classList.toggle('mod', claimMod); refs.autoLabel.title = claimMod ? 'Changed from the default' : '';
    if (claimMod) changed++;
    P.setTabBadge('settings', changed ? changed + ' setting' + (changed > 1 ? 's' : '') + ' changed from the defaults' : '');

    // Footer
    const confirming = !running && !cfg.dryRun && Date.now() < confirmUntil;
    refs.plan.hidden = running;
    refs.plan.classList.toggle('hot', confirming);
    refs.plan.textContent = cfg.dryRun
      ? 'Dry run: works out every step and writes "would send …" to the log, but sends nothing.'
      : `Live: starts research and claims results for you, one confirmed step at a time, keeping ${fmt(cfg.mdReserve)} MD.${confirming ? ' Click Confirm start to go.' : ''}`;
    refs.main.textContent = running ? 'Stop' : active ? 'Stopping…' : cfg.dryRun ? 'Start dry run' : confirming ? 'Confirm start' : 'Start live';
    refs.main.disabled = !running && (active || !r);
    refs.alt.hidden = !confirming;
  }

  const onResize = () => P?.place();

  function renderPanel(r, sum) {
    const t = tone();
    refs.dot.className = refs.stateDot.className = 'idc-dot ' + t;
    refs.badge.textContent = cfg.dryRun ? 'Dry run' : 'Live';
    refs.badge.className = 'idc-badge' + (cfg.dryRun ? '' : ' live');
    if (!sum) {
      refs.big.textContent = '—'; refs.sub.textContent = ''; refs.bar.style.width = '0%';
      refs.rows.replaceChildren(); refs.successNote.textContent = '';
      refs.state.textContent = 'Waiting for the game to load…';
    } else {
      const info = successInfo(r, sum), d = sum.d;
      refs.big.textContent = sum.total ? `${sum.busy} of ${sum.total}` : '—';
      refs.sub.textContent = sum.total ? (sum.total === 1 ? 'Lab' : 'Labs') : 'no Lab built yet';
      refs.bar.style.width = (sum.total ? (sum.busy / sum.total) * 100 : 0) + '%';
      const rows = [
        ...(sum.total ? sum.rows.map((x) => [x.name, x.text]) : [['Labs', 'none built yet']]),
        ['Results waiting', d.pending + (cfg.autoClaim ? '' : ' (auto-claim off)')],
        ['MD', `${fmt(d.md)} · keeps ${fmt(cfg.mdReserve)}`],
        ['RD', fmt(d.rd)],
        ['Catalyst', sum.total ? sum.rows.map((x) => `${x.name} ${fmt(x.catalyst)}`).join(' · ') : '—'],
        ['Success', info.text],
        ['This run', `${sess.started} started · ${sess.claimed} claimed`],
      ];
      refs.rows.replaceChildren(...rows.map(([k, v]) => K.row(k, v)));
      refs.successNote.textContent = info.note;
      refs.state.textContent = stateText(sum);
    }
    renderForm(r);
    if (ui.tab === 'log' && !ui.min) { refs.logv.render(); refs.logv.markSeen(); }
    const unseen = ui.tab === 'log' ? 0 : refs.logv.unseen();
    P.setTabBadge('log', unseen ? unseen + ' new problem' + (unseen > 1 ? 's' : '') : '', true);
  }

  function render() {
    if (!HAS_DOM || unloaded) return;
    const r = read();
    const sum = r ? summary(r) : null;
    const t = tone();
    chrome?.setPill(cfg.dryRun ? 'Dry run' : 'Live', t, !running);
    chrome?.setChip(sum?.total ? `Lab ${sum.busy}/${sum.total}` : 'Lab', t, `Lab · ${stateText(sum)}`);
    const open = !!P?.el.isConnected;
    chrome?.setOpen(open);
    if (open) renderPanel(r, sum);
  }

  function panel(show = true, opts = {}) {
    if (!HAS_DOM || unloaded) return;
    if (show) { if (!P) buildPanel(); P.mount(opts); } else P?.unmount();
    ui.open = !!show; saveUi();
    render();
  }

  function mountUi() {
    chrome = K.createChrome({
      label: 'Lab', navTitle: 'Keep the Manufacturing Lab researching', icon: ICON, navClass: 'lab-tab', chipClass: 'lab-chip',
      onToggle: () => K.togglePanel(P, ui, panel),
      navInsert: (nav, el) => nav.insertBefore(el, nav.querySelector('.cdf-tab')?.nextSibling ?? null),   // below CD Farm's tab
      chipInsert: (tools, el) => tools.insertBefore(el, tools.querySelector('.tip-anchor') || null),
    });
    chrome.mount();
    timer = setInterval(render, 1000);
    if (ui.open) panel(true); else render();
    addEventListener('resize', onResize);
  }
  function unmountUi() {
    clearInterval(timer); timer = null;
    P?.unmount(); chrome?.unmount();
    P = chrome = null;
    removeEventListener('resize', onResize);
  }

// continues the lab closure from lab-3.js (same try / IIFE)
  // ---- load ----------------------------------------------------------------------------------------

  W.labRunner = {
    start, stop, status, panel, read, cfg, exportCfg, importCfg, resetCfg,
    get running() { return running; },
    get active() { return active; },        // a run is still executing (maybe finishing a step after stop())
    get stopReason() { return stopReason; },
    get mem() { return mem; },
    // Pure decision for the tests: no I/O, no side effects.
    _decide: decide,
    _unload: () => { unloaded = true; running = false; kick?.(); if (HAS_DOM) unmountUi(); },
  };

  // Wait for the game to render and connect before mounting.
  if (HAS_DOM) (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    if (unloaded) return;
    mountUi();
    console.log('[labRunner] ready (dry run by default). Open "Lab" in the sidebar, or labRunner.status() / labRunner.start()');
  })();
})();
} catch (e) { console.error('[IdleCorp] Lab runner failed to load:', e); }
// @@END lab

// ============================================================================
// 3b. AUTO SHIP (window.autoSell)
// ============================================================================
// An "Auto ship" button on every distributor bid in the Market table, left of Sell. It opens a menu
// like the game's own auto-ship menu, but the selling is done here: each time the courier is free it
// sends the same FillDeal the Sell dialog sends, straight down the game's WebSocket, so it is not
// limited to the game's single auto-ship slot (any number of bids can run together; they share the
// one courier). The game's own auto-ship (KeepFilling) is never touched.
//   autoSell.start({ deal, total, keep, fullLoads })   // deal = bid id; total: number | null (until stopped)
//   autoSell.stop(deal) / stop()                      // one job / every job
//   autoSell.jobs() / status() / items() / open(deal)
//
// Rules a job follows (autoSell._decide is the pure version of them, used by the tests):
//   - hire must be null, as the game's Sell dialog sends it: the server silently ignores hire:false
//   - one FillDeal per courier run: min(stock above "keep", one free courier load, what is left to sell, the lot)
//   - nothing is sent while the courier is busy, the stock is short, or the game's own auto-ship runs on that bid
//   - the job ends when the target is reached, or after 24 h with no bid that qualifies. When its bid is gone (filled,
//     withdrawn, expired) it moves to the best open bid for the same item in the same region (highest unit price, never
//     below the item's est. cost per unit, not one another job holds); with none it waits. A bid board that is not
//     loaded (Market page not open) never ends a job, it only waits
//   - every send must be confirmed by the server (next_shipment_id goes up); 5 unconfirmed sends in a row pause the job
// Profit: every job shows an estimated profit (what it makes if it runs to its target or until the bid is used up) and the
// actual profit so far. Cost of a unit = the inputs of the recipe that makes it, at catalog base value (cheapest recipe if
// several make it; raw materials cost nothing to extract, so they are pure profit). Actual profit = what the shipments
// sent so far are worth minus that cost; it is booked when a shipment is sent (the money lands with the shipment).
// Jobs are saved in this browser and resume after a reload (a job whose bid is gone moves on). Autopilot is not touched: if it
// sells the same item, pick "Keep in stock" so both leave enough. Alt+Shift+X stops every job.
// @@MODULE autosell
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');
  const HAS_DOM = typeof document !== 'undefined' && !!document.body;
  const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
  const KEY = 'autoSell.v1';
  const TAG = 'AS';
  if (W.autoSell?._unload) W.autoSell._unload();
  let unloaded = false;
  const sleep = core.sleep;

  // ---- game facts ------------------------------------------------------------------------------
  const COURIER_CU = 10000;                 // free courier allowance per run (upgrades are ignored: shipping less is safe)
  const REGION_NAMES = ['Heartland', 'Industrial Basin', 'Coastal Cities', 'Frontier'];
  const regionName = (r) => REGION_NAMES[r] ?? 'Region ' + r;
  const MAX_FAILS = 5;
  const cfg = { cycleMs: 1000, confirmMs: 10000, jitterMs: 450, backoffMs: 5000, bidWaitMs: 24 * 3600 * 1000, switchFloorPct: 90 };   // timings (the tests shorten them); switchFloorPct: a moved job never takes a bid below this % of the bid you picked
  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n) => Math.round(n).toLocaleString('en-US');
  const profitTxt = (c) => (c < 0 ? '−' : '') + usd(Math.abs(c));

  let catRef = null, itemMap = null;
  function itemOf(catalog, id) {
    if (catalog !== catRef) { catRef = catalog; itemMap = new Map((catalog?.items ?? []).map((i) => [i.id, i])); }
    return itemMap.get(id);
  }
  const loadOf = (it) => Math.floor(COURIER_CU / Math.max(1, it?.cargo_weight || 1));

  // Estimated cost of one unit, in cents: the inputs of the recipe that makes it, at catalog base value (the cheapest recipe
  // when several make it). A recipe with several outputs shares its inputs by the outputs' base value. Raw materials have no
  // inputs, so they cost 0 (pure profit); so does an item no catalog recipe makes.
  let recRef = null, costMap = null;
  function unitCost(catalog, id) {
    catalog = catalog ?? recRef;                 // game state briefly unreadable: keep using the last catalog, never read "no catalog" as "free"
    if (!catalog) return 0;
    if (catalog !== recRef) { recRef = catalog; costMap = new Map(); }
    if (costMap.has(id)) return costMap.get(id);
    const base = (i) => itemOf(catalog, i)?.base_value ?? 0;
    let best = null;
    for (const rc of catalog.recipes ?? []) {
      const out = (rc.outputs ?? []).find((o) => o.item === id);
      if (!out || !(out.amount > 0)) continue;
      const inCost = (rc.inputs ?? []).reduce((s, x) => s + x.amount * base(x.item), 0);
      const outValue = (rc.outputs ?? []).reduce((s, o) => s + o.amount * base(o.item), 0);
      const c = outValue > 0 ? inCost * base(id) / outValue : inCost / out.amount;
      if (best == null || c < best) best = c;
    }
    costMap.set(id, best ?? 0);
    return best ?? 0;
  }

  // ---- jobs --------------------------------------------------------------------------------------
  // job: { deal, item, region, unit (cents per unit), left (units still to sell, null = until stopped),
  //        sold, revenue + cogs (cents: what the sent units are worth, what they cost), lot (units the bid still wants, last seen),
  //        keep, fullLoads, expiresAt (tick), fails, retryAt, status, tone, last (ms of the last send),
//        from (the bid it moved from, or null), waitSince (ms since no bid qualified, 0 = not waiting for one) }
  const jobs = new Map();
  const toInt = (v, min, max, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
  function clean(j) {
    if (!j || !Number.isFinite(+j.deal) || !Number.isFinite(+j.item)) return null;
    return {
      deal: +j.deal, item: +j.item, region: toInt(j.region, 0, 99, 0), unit: Math.max(0, Number(j.unit) || 0),
      unit0: Math.max(0, Number(j.unit0 ?? j.unit) || 0),   // unit price of the bid you picked: the floor for a move, kept through every move
      left: j.left == null ? null : toInt(j.left, 1, 1e9, null), sold: toInt(j.sold, 0, 1e12, 0), keep: toInt(j.keep, 0, 1e12, 0),
      fullLoads: !!j.fullLoads, expiresAt: Number.isFinite(+j.expiresAt) ? +j.expiresAt : 0,
      revenue: toInt(j.revenue, 0, 1e15, 0), cogs: toInt(j.cogs, 0, 1e15, 0), lot: toInt(j.lot, 0, 1e12, 0),
      from: Number.isFinite(j.from) ? j.from : null, waitSince: toInt(j.waitSince, 0, 1e15, 0),
      fails: 0, retryAt: 0, status: 'Starting', tone: '', last: 0,
    };
  }
  function save() {
    try { store?.setItem(KEY, JSON.stringify({ jobs: [...jobs.values()].map(({ deal, item, region, unit, unit0, left, sold, revenue, cogs, lot, keep, fullLoads, expiresAt, from, waitSince }) => ({ deal, item, region, unit, unit0, left, sold, revenue, cogs, lot, keep, fullLoads, expiresAt, from, waitSince })) })); } catch {}
  }
  function restore() {
    try {
      const o = JSON.parse(store?.getItem(KEY) || 'null');
      for (const j of Array.isArray(o?.jobs) ? o.jobs : []) { const c = clean(j); if (c && jobs.size < 50) jobs.set(c.deal, c); }
    } catch {}
  }

  // ---- reading the game ---------------------------------------------------------------------------
  function read(fresh = false) {
    const { ws, st, catalog, deals } = core.walk(fresh);
    if (!st || !catalog) return null;
    core.seeTick(st.ssi?.last_user_mutation_tick);
    return { st, catalog, deals, ws, wsOpen: ws?.readyState === 1, tick: core.nowTick(), shipId: st.next_shipment_id ?? 0, mutTick: st.ssi?.last_user_mutation_tick ?? 0 };
  }

  // ---- profit (cents) ---------------------------------------------------------------------------------------------------------
  const profitOf = (job) => job.revenue - job.cogs;                                       // actual, for what was sent so far
  // What the job makes in the end: the actual profit so far plus the margin on what it will still send (the target, or the
  // part of the bid that is still open when it runs until stopped).
  function estProfitOf(job, r) {
    const togo = Math.min(job.left ?? Infinity, job.lot || (job.left ?? 0));
    return Math.round(profitOf(job) + (job.unit - unitCost(r?.catalog, job.item)) * togo);
  }

  // ---- the decision (pure: no I/O) -------------------------------------------------------------------
  // r: { st, catalog, deals (array | null = board not loaded), tick, now }. Returns
  //   { kind: 'send', n, deal } | { kind: 'switch', deal } | { kind: 'wait', why, tone?, noBid? } | { kind: 'end', why }
  // r.taken (optional): ids of the bids other jobs hold. A 'switch' deal is the bid the job moves to.
  function decide(job, r) {
    if (job.left != null && job.left < 1) return { kind: 'end', why: 'target reached' };
    const tick = r.tick || 0;
    // A move never goes below cfg.switchFloorPct of the bid you picked (unit cost alone is 0 for raw goods).
    const floor = Math.max(unitCost(r.catalog, job.item), (job.unit0 ?? job.unit ?? 0) * cfg.switchFloorPct / 100), name = nameOf(r, job.item);
    // No qualifying bid: wait, and give up once the job has waited cfg.bidWaitMs (cycle() keeps job.waitSince).
    const noBid = (why) => job.waitSince && r.now != null && r.now - job.waitSince >= cfg.bidWaitMs
      ? { kind: 'end', why: 'no ' + name + ' bid at ≥ ' + usd(floor) + ' for 24 h' }
      : { kind: 'wait', why, tone: 'muted', noBid: true };
    if (!Array.isArray(r.deals)) {
      if (tick && job.expiresAt && tick > job.expiresAt + 4) return noBid('bid expired: open the Market page so it can pick another bid');
      return { kind: 'wait', why: 'Market board not loaded (open the Market page once)' };
    }
    const deal = r.deals.find((d) => d.id === job.deal);
    if (!deal || deal.side !== 'Sell') {
      let best = null;
      for (const d of r.deals) {
        if (d.side !== 'Sell' || d.item !== job.item || d.region !== job.region || r.taken?.has(d.id) || r.st.standing_fills?.[d.id]) continue;
        if (!(d.amount > 0) || (tick && d.expires_at && d.expires_at <= tick) || d.price / d.amount < floor) continue;
        if (!best || d.price / d.amount > best.price / best.amount) best = d;
      }
      return best ? { kind: 'switch', deal: best } : noBid('waiting for a ' + name + ' bid at ≥ ' + usd(floor) + ' in ' + regionName(job.region));
    }
    if (r.st.standing_fills?.[job.deal]) return { kind: 'wait', why: "the game's own auto-ship is running on this bid" };
    const it = itemOf(r.catalog, deal.item);
    const load = loadOf(it);
    const stock = r.st.stock?.[deal.region]?.[deal.item] ?? 0;
    const spare = Math.floor(stock - job.keep);
    const want = Math.min(load, job.left ?? Infinity, deal.amount);
    const n = Math.min(want, spare);
    if (n < 1) return { kind: 'wait', why: 'waiting for ' + (it?.name ?? 'stock') + (job.keep ? ' above ' + num(job.keep) : '') + ' in stock', tone: 'muted' };
    if (job.fullLoads && n < want) return { kind: 'wait', why: 'waiting for a full load (' + num(n) + ' of ' + num(want) + ')', tone: 'muted' };
    const ready = r.st.courier_ready_at ?? 0;
    if (tick && tick < ready) return { kind: 'wait', why: 'courier ready in ' + Math.max(1, Math.ceil((ready - tick) / 2)) + ' s', tone: 'good' };
    if (r.now != null && r.now < job.retryAt) return { kind: 'wait', why: 'retrying in ' + Math.ceil((job.retryAt - r.now) / 1000) + ' s', tone: 'warn' };
    return { kind: 'send', n, deal };
  }

  // ---- the engine --------------------------------------------------------------------------------------
  let loopOn = false, wake = null;
  class ConnError extends Error {}
  const nameOf = (r, id) => itemOf(r?.catalog, id)?.name ?? 'item ' + id;

  function endJob(job, why, kind = 'info') {
    if (!jobs.delete(job.deal)) return;
    save();
    const name = nameOf(read(), job.item);
    core.ledger.add(TAG, kind, 'auto ship ' + name + ' ended: ' + why + ' (' + num(job.sold) + ' sold)' + (job.sold ? ', profit ' + profitTxt(profitOf(job)) : ''));
    core.toast('Auto ship ' + name + ' ended: ' + why, kind === 'fail' ? 'error' : 'info');
    renderAll();
  }

  // The job's bid is gone: the same job (sold, left, profit carry over) continues on bid d.
  function moveJob(job, d, r) {
    const old = job.deal, oldUnit = job.unit, name = nameOf(r, job.item);
    jobs.delete(old);
    Object.assign(job, { from: old, deal: d.id, unit: d.price / d.amount, lot: d.amount, expiresAt: d.expires_at, region: d.region, fails: 0, retryAt: 0, waitSince: 0 });
    jobs.set(d.id, job);
    save();
    core.ledger.add(TAG, 'info', 'auto ship ' + name + ' moved: bid #' + old + ' @ ' + usd(oldUnit) + ' → #' + d.id + ' @ ' + usd(job.unit));
    core.toast('Auto ship ' + name + ': moved to a bid at ' + usd(job.unit), 'info');
    if (modal && (modal.deal === old || modal.deal === d.id)) closeMenu(false);   // its Update / Stop / Start would act on the wrong job
    renderAll();
  }

  async function send(job, d, n) {
    const r = read(true);
    if (!r) throw new ConnError('game state not found');
    if (!r.wsOpen) throw new ConnError('socket not open');
    const id0 = r.shipId;
    const d0 = core.markSend(r.mutTick);
    const unit = d.price / d.amount;
    r.ws.send(JSON.stringify({ type: 'FillDeal', deal: d.id, amount: n >= d.amount ? null : n, hire: null, region: d.region, courier: true }));
    const ok = await core.waitConfirm({
      read, d0, timeoutMs: cfg.confirmMs,
      pred: (x) => x.shipId > id0,
      closed: () => { throw new ConnError('socket closed while waiting'); },
    });
    if (!ok) {
      // Lost the courier to someone else (Autopilot, the game's auto-ship, a click): not a failure, it goes again.
      const after = read();
      if (after && after.st.courier_ready_at > after.tick) { job.status = 'courier was taken: waiting'; job.tone = 'muted'; return false; }
      job.fails++;
      job.retryAt = Date.now() + Math.min(60000, cfg.backoffMs * 2 ** job.fails);
      core.ledger.add(TAG, 'fail', 'not confirmed: sell ' + num(n) + ' ' + nameOf(r, job.item) + ' (' + job.fails + '/' + MAX_FAILS + ')');
      if (job.fails >= MAX_FAILS) endJob(job, 'the server did not apply ' + MAX_FAILS + ' sends in a row', 'fail');
      return false;
    }
    job.fails = 0; job.retryAt = 0; job.last = Date.now();
    job.sold += n;
    if (job.left != null) job.left -= n;
    job.lot = Math.max(0, job.lot - n);       // what the bid still wants; the next cycle re-reads it
    const cost = unitCost(r.catalog, job.item) * n;
    job.revenue += Math.round(unit * n); job.cogs += Math.round(cost);
    save();
    core.ledger.add(TAG, 'action', 'auto ship ' + num(n) + ' ' + nameOf(r, job.item) + ' @ ' + usd(unit) + ' = ' + usd(unit * n) + (cost ? ', profit ' + profitTxt(unit * n - cost) : ''), { dMoney: Math.round(unit * n / 100) });
    return true;
  }

  async function cycle() {
    const r = read();
    if (!r) { for (const j of jobs.values()) { j.status = 'Waiting for the game'; j.tone = 'muted'; } return; }
    r.now = Date.now();
    // Least recently served first, so jobs share the courier.
    const order = [...jobs.values()].sort((a, z) => a.last - z.last || z.unit - a.unit);
    let sent = false;
    for (const job of order) {
      if (unloaded || !jobs.has(job.deal)) continue;
      const live = Array.isArray(r.deals) ? r.deals.find((d) => d.id === job.deal) : null;
      if (live?.side === 'Sell') job.lot = live.amount;
      r.taken = new Set([...jobs.keys()].filter((id) => id !== job.deal));
      const v = decide(job, r);
      const was = job.waitSince;
      job.waitSince = v.noBid ? (job.waitSince || r.now) : 0;
      if (!was !== !job.waitSince) save();   // so a reload does not restart the give-up clock
      if (v.kind === 'switch') { moveJob(job, v.deal, r); continue; }
      if (v.kind === 'end') { endJob(job, v.why); continue; }
      if (v.kind === 'wait') { job.status = v.why.charAt(0).toUpperCase() + v.why.slice(1); job.tone = v.tone || 'muted'; continue; }
      if (sent) { job.status = 'Waiting for the courier'; job.tone = 'good'; continue; }
      if (cfg.jitterMs) await sleep(150 + Math.random() * cfg.jitterMs);   // not the same millisecond every time
      if (unloaded || !jobs.has(job.deal)) continue;
      job.status = 'Shipping'; job.tone = 'good';
      renderAll();
      await send(job, v.deal, v.n);
      sent = true;
      const x = read(true);
      if (x) { r.st = x.st; r.tick = x.tick; r.deals = x.deals ?? r.deals; }
    }
  }

  async function loop() {
    if (loopOn) return;
    loopOn = true;
    try {
      while (!unloaded && jobs.size) {
        try { await cycle(); }
        catch (e) {
          if (!(e instanceof ConnError)) console.error('[autoSell]', e);
          for (const j of jobs.values()) { j.status = 'Connection lost: ' + (e.message || e); j.tone = 'warn'; }
          renderAll();
          await sleep(5000);
        }
        renderAll();
        await new Promise((res) => { wake = res; core.sleepWake(cfg.cycleMs).then(res); });
        wake = null;
      }
    } finally { loopOn = false; renderAll(); }
  }

// continues the autosell closure from autosell-1.js (same try / IIFE)
  // ---- public control ----------------------------------------------------------------------------------------
  function start({ deal, total = null, keep = 0, fullLoads = false } = {}) {
    const r = read();
    const d = Array.isArray(r?.deals) ? r.deals.find((x) => x.id === +deal) : null;
    const prev = jobs.get(+deal);
    if (!d && !prev) throw new Error('bid ' + deal + ' not found (open the Market page)');
    const base = prev ?? clean({ deal: d.id, item: d.item, region: d.region, unit: d.price / d.amount, expiresAt: d.expires_at });
    if (!base) throw new Error('bad bid');
    if (d && d.side !== 'Sell') throw new Error('bid ' + deal + ' is an ask: auto ship sells into bids only');
    if (d) base.lot = d.amount;
    base.left = total == null ? null : toInt(total, 1, 1e9, null);
    base.keep = toInt(keep, 0, 1e12, 0);
    base.fullLoads = !!fullLoads;
    base.fails = 0; base.retryAt = 0;
    jobs.set(base.deal, base);
    save();
    core.ledger.add(TAG, 'info', (prev ? 'updated' : 'started') + ' auto ship ' + nameOf(r, base.item) + ' @ ' + usd(base.unit) + (base.left == null ? ', until stopped' : ', ' + num(base.left) + ' to sell') + (base.keep ? ', keeping ' + num(base.keep) : ''));
    loop();
    renderAll();
    return base.deal;
  }
  function stop(deal) {
    const list = deal == null ? [...jobs.values()] : [jobs.get(+deal)].filter(Boolean);
    for (const j of list) endJob(j, 'stopped');
    return list.length;
  }
  const publicJob = (j, r) => ({ deal: j.deal, from: j.from ?? null, item: j.item, region: j.region, unit: j.unit, unit0: j.unit0, left: j.left, sold: j.sold, keep: j.keep, fullLoads: j.fullLoads, status: j.status,
    revenue: j.revenue, cost: j.cogs, profit: profitOf(j), estProfit: estProfitOf(j, r) });   // cents
  const listJobs = () => { const r = read(); return [...jobs.values()].map((j) => publicJob(j, r)); };
  const status = () => listJobs().map((j) => nameOf(read(), j.item) + ' #' + j.deal + ': ' + num(j.sold) + ' sold, ' + (j.left == null ? 'until stopped' : num(j.left) + ' left') + ', profit ' + profitTxt(j.profit) + ' (est. ' + profitTxt(j.estProfit) + ') - ' + j.status).join('\n') || 'no jobs';
  const items = () => [...new Set([...jobs.values()].map((j) => j.item))];

  // ---- DOM: button, menu, jobs table ---------------------------------------------------------------------------------
  const h = core.h;
  const fiberKey = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k]?.key : null; };
  let styleEl = null, modal = null, panelEl = null, panelSig = '', obs = null, passTimer = 0, tickTimer = 0;

  const CSS = '.as-btn{margin-right:6px}.as-btn.on::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#3fb950;margin-right:6px;vertical-align:middle}' +
    '.as-modal .as-note{margin-top:6px}.as-modal input[type=number]:disabled{opacity:.5}.as-neg{color:#f85149}.as-panel tfoot td{font-weight:600}';

  function dealRow(tr) {
    const id = +fiberKey(tr);
    return Number.isFinite(id) && tr.querySelector('.side-pill.bid') ? id : null;
  }
  function inject() {
    if (!HAS_DOM || unloaded) return;
    for (const tr of document.querySelectorAll('.market-table tbody tr')) {
      const id = dealRow(tr);
      let btn = tr.querySelector('.as-btn');
      if (id == null) { btn?.remove(); continue; }
      const td = tr.lastElementChild;
      if (!td) continue;
      if (!btn) {
        btn = h('button', { type: 'button', class: 'as-btn' }, 'Auto ship');
        btn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(+btn.dataset.deal, btn); });
        td.insertBefore(btn, td.firstChild);
      }
      btn.dataset.deal = String(id);
      const on = jobs.has(id);
      btn.classList.toggle('on', on);
      const t = on ? 'Auto ship is running on this bid: click to edit or stop' : 'Sell this bid automatically: ships again every time the courier is free';
      if (btn.title !== t) btn.title = t;
    }
    injectPanel();
  }

  // The jobs table is rebuilt only when the set of jobs changes; the numbers and the status are updated in place,
  // so a click on Edit / Stop is never lost to a rebuild between mouse down and up.
  let panelRefs = new Map();
  function injectPanel() {
    const marketSection = document.querySelector('.market-table')?.closest('section.panel');
    if (!marketSection || !jobs.size) { panelEl?.remove(); panelEl = null; panelSig = ''; panelRefs.clear(); return; }
    const r = read();
    const sig = [...jobs.keys()].join(',');
    if (!panelEl?.isConnected || sig !== panelSig) {
      panelSig = sig;
      panelRefs = new Map();
      const tr = [...jobs.values()].map((j) => {
        const ref = { sold: h('td', { class: 'num' }), left: h('td', { class: 'num' }), est: h('td', { class: 'num' }), act: h('td', { class: 'num' }), badge: h('span', { class: 'badge' }) };
        panelRefs.set(j.deal, ref);
        return h('tr', {},
          h('td', {}, nameOf(r, j.item)),
          h('td', { class: 'muted' }, regionName(j.region)),
          h('td', { class: 'num muted' }, usd(j.unit)),
          ref.sold, ref.left, ref.est, ref.act,
          h('td', { class: 'nowrap' }, ref.badge),
          h('td', { class: 'num' }, h('span', { class: 'row-actions' },
            h('button', { type: 'button', onclick: () => openMenu(j.deal) }, 'Edit'),
            h('button', { type: 'button', onclick: () => stop(j.deal) }, 'Stop'))));
      });
      const tot = { est: h('td', { class: 'num' }), act: h('td', { class: 'num' }) };
      if (jobs.size > 1) panelRefs.set('tot', tot);
      panelEl?.remove();
      panelEl = h('section', { class: 'panel as-panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Auto ship (IC Autopilot)'), h('span', { class: 'spacer' }), h('span', { class: 'muted as-count' })),
        h('div', { class: 'panel-body' },
          h('div', { class: 'table-bleed' }, h('table', { class: 'data-table steady autoship-table' },
            h('thead', {}, h('tr', {}, ...['Item', 'Route', 'Unit', 'Sold', 'Left', 'Est. profit', 'Actual profit', 'Status', ''].map((t, i) => h('th', { class: i >= 2 && i <= 6 ? 'num' : '', ...(i === 5 ? { title: 'What the job makes in the end: the actual profit so far plus the margin on what it still has to ship (the target, or the part of the bid that is still open)' } : i === 6 ? { title: 'What the units shipped so far earned, minus what they cost to make. Booked when a shipment is sent; the money lands with the shipment' } : {}) }, t)))),
            h('tbody', {}, ...tr),
            ...(jobs.size > 1 ? [h('tfoot', {}, h('tr', {}, h('td', { colspan: '5' }, 'Total'), tot.est, tot.act, h('td', {}), h('td', {})))] : []))),
          h('p', { class: 'panel-note' }, 'Ships from here, so it only works while this tab is open and online. The game\'s own auto-ship slot is not used. Cost of a unit is its recipe\'s inputs at base value (raw materials are free), so profit is an estimate.')));
    }
    if (panelEl.nextElementSibling !== marketSection) marketSection.parentNode.insertBefore(panelEl, marketSection);
    const set = (el, t) => { if (el.textContent !== t) el.textContent = t; };
    set(panelEl.querySelector('.as-count'), jobs.size + ' running · no slot limit');
    const money = (el, c) => { set(el, profitTxt(c)); const cls = c < 0 ? 'num as-neg' : 'num'; if (el.className !== cls) el.className = cls; };
    let totEst = 0, totAct = 0;
    for (const j of jobs.values()) {
      const ref = panelRefs.get(j.deal);
      if (!ref) continue;
      set(ref.sold, num(j.sold));
      set(ref.left, j.left == null ? 'Until stopped' : num(j.left));
      const est = estProfitOf(j, r), act = profitOf(j);
      totEst += est; totAct += act;
      money(ref.est, est); money(ref.act, act);
      set(ref.badge, j.status);
      const cls = 'badge ' + (j.tone === 'good' ? 'good' : '');
      if (ref.badge.className !== cls) ref.badge.className = cls;
    }
    const tot = panelRefs.get('tot');
    if (tot) { money(tot.est, totEst); money(tot.act, totAct); }
  }

  function closeMenu(restore = true) {
    if (!modal) return;
    const { el, from, onKey } = modal;
    removeEventListener('keydown', onKey, true);
    el.remove(); modal = null;
    if (restore && from?.isConnected) from.focus();
  }

  function openMenu(dealId, from = null) {
    if (!HAS_DOM || unloaded) return;
    closeMenu(false);
    const r = read();
    const live = Array.isArray(r?.deals) ? r.deals.find((d) => d.id === dealId) : null;
    const job = jobs.get(dealId);
    if (!live && !job) { core.toast('That bid is gone', 'error'); return; }
    const item = job?.item ?? live.item, region = job?.region ?? live.region;
    const lot = live?.amount ?? Math.max(job?.left ?? 1, 1);
    const unit = live ? live.price / live.amount : job.unit;
    const it = itemOf(r?.catalog, item);
    const name = it?.name ?? 'item ' + item;
    const load = loadOf(it);
    const cpu = unitCost(r?.catalog, item);

    const total = h('input', { type: 'number', inputMode: 'numeric', min: '1', max: String(lot), value: String(job?.left ?? lot), 'aria-label': 'Total to sell' });
    const keep = h('input', { type: 'number', inputMode: 'numeric', min: '0', value: String(job?.keep ?? 0), 'aria-label': 'Keep in stock' });
    const untilStopped = h('input', { type: 'checkbox', checked: job ? job.left == null : true });
    const full = h('input', { type: 'checkbox', checked: !!job?.fullLoads });
    const clamp = (el, lo, hi) => { el.value = String(toInt(el.value, lo, hi, lo)); };
    const step = (el, d, lo, hi) => h('button', { type: 'button', onclick: () => { el.value = String(toInt(Number(el.value || 0) + d, lo, hi, lo)); sync(); } }, (d > 0 ? '+' : '−') + (Math.abs(d) >= 1000 ? Math.abs(d) / 1000 + 'k' : Math.abs(d)));
    const bulk = (el, lo, hi, maxLabel, maxVal) => h('div', { class: 'stepper-bulk' },
      ...[-10000, -1000, -100, 100, 1000, 10000].map((d) => step(el, d, lo, hi)),
      h('span', { class: 'stepper-scale' }, h('button', { type: 'button', title: maxLabel, onclick: () => { el.value = String(maxVal); sync(); } }, 'Max')));

    const recv = h('td', { class: 'num' }), estCell = h('td', { class: 'num' }), stockCell = h('td', { class: 'num' });
    const totalRow = h('div', { class: 'field' }, h('label', {}, 'Total to sell (lot of ' + num(lot) + ')'), total, bulk(total, 1, lot, 'Fill quantity to the lot', lot));
    function sync() {
      total.disabled = untilStopped.checked;
      totalRow.style.opacity = untilStopped.checked ? '.5' : '';
      const n = untilStopped.checked ? lot : toInt(total.value, 1, lot, lot);
      recv.textContent = (untilStopped.checked ? 'Up to ' : '') + usd(unit * n);
      estCell.textContent = (untilStopped.checked ? 'Up to ' : '') + profitTxt(Math.round((unit - cpu) * n));
      const x = read();
      stockCell.textContent = num(x?.st.stock?.[region]?.[item] ?? 0);
    }
    total.addEventListener('input', sync); untilStopped.addEventListener('change', sync);
    total.addEventListener('blur', () => { clamp(total, 1, lot); sync(); });
    keep.addEventListener('blur', () => { clamp(keep, 0, 1e12); });

    const confirm = h('button', { type: 'button', class: 'primary', 'data-modal-confirm': 'true', onclick: () => {
      try {
        start({ deal: dealId, total: untilStopped.checked ? null : toInt(total.value, 1, lot, lot), keep: toInt(keep.value, 0, 1e12, 0), fullLoads: full.checked });
        closeMenu();
      } catch (e) { core.toast(String(e.message || e), 'error'); }
    } }, job ? 'Update auto ship' : 'Start auto ship');

    const strip = job ? h('div', { class: 'autoship-strip' },
      h('span', { class: 'badge good' }, 'Auto-shipping'),
      h('span', { class: 'muted' }, num(job.sold) + ' sold · ' + profitTxt(profitOf(job)) + ' profit'),
      h('button', { type: 'button', onclick: () => { stop(dealId); closeMenu(); } }, 'Stop auto ship')) : null;

    const el = h('div', { class: 'modal-backdrop as-modal' },
      h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Auto ship ' + name },
        h('div', { class: 'modal-head' },
          h('button', { type: 'button', class: 'modal-x', title: 'Close', 'aria-label': 'Close', onclick: () => closeMenu() }, '×'),
          h('h3', {}, 'Auto ship ' + name)),
        h('div', { class: 'modal-body' },
          ...(strip ? [strip] : []),
          totalRow,
          h('div', { class: 'field check-row' },
            h('label', { class: 'inline-check' }, untilStopped, h('span', {}, 'Until stopped')),
            h('span', { class: 'hint' }, 'Ships again each time the courier is free. Waits for more when you run out of ' + name + '. Moves to the best bid for the same item in this region when this one is gone, and stops after 24 h with no bid.')),
          h('div', { class: 'field' }, h('label', {}, 'Keep in stock'), keep,
            h('div', { class: 'hint as-note' }, 'Never ships the last units of ' + name + ': they stay in stock.')),
          h('div', { class: 'field check-row' },
            h('label', { class: 'inline-check' }, full, h('span', {}, 'Full courier loads only')),
            h('span', { class: 'hint' }, 'Waits for ' + num(load) + ' ' + name + ' (one free courier run) instead of shipping what is there.')),
          h('table', { class: 'data-table stats' }, h('tbody', {},
            h('tr', {}, h('td', { class: 'muted' }, 'Unit price'), h('td', { class: 'num' }, usd(unit))),
            h('tr', {}, h('td', { class: 'muted' }, 'You receive in total'), recv),
            h('tr', {}, h('td', { class: 'muted', title: 'The inputs of the recipe that makes it, at base value. Raw materials cost nothing to extract.' }, 'Est. cost per unit'), h('td', { class: 'num' }, usd(cpu))),
            h('tr', {}, h('td', { class: 'muted' }, job ? 'Est. profit on the rest' : 'Est. profit in total'), estCell),
            ...(job ? [h('tr', {}, h('td', { class: 'muted' }, 'Actual profit so far'), h('td', { class: 'num' }, profitTxt(profitOf(job))))] : []),
            h('tr', {}, h('td', { class: 'muted' }, 'In stock'), stockCell),
            h('tr', {}, h('td', { class: 'muted' }, 'Region'), h('td', { class: 'num' }, regionName(region))),
            h('tr', {}, h('td', { class: 'muted' }, 'Cargo each'), h('td', { class: 'num' }, (it?.cargo_weight ?? '?') + ' CU')))),
          h('div', { class: 'hint' }, 'Goods leave in courier shipments. You are paid as each shipment is complete. The game\'s own auto-ship slot is not used.')),
        h('div', { class: 'modal-actions' }, h('button', { type: 'button', onclick: () => closeMenu() }, 'Cancel'), confirm)));
    el.addEventListener('mousedown', (e) => { if (e.target === el) closeMenu(); });
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenu(); } };
    addEventListener('keydown', onKey, true);
    modal = { el, from, onKey, deal: dealId };
    document.body.append(el);
    sync();
    (untilStopped.checked ? keep : total).focus();
  }

  let mounted = false;
  const renderAll = () => { if (mounted && !unloaded) { clearTimeout(passTimer); passTimer = setTimeout(inject, 60); } };

  function mountUi() {
    mounted = true;
    styleEl = h('style', { id: 'as-style' }, CSS);
    document.head.append(styleEl);
    obs = new MutationObserver(renderAll);
    obs.observe(document.body, { childList: true, subtree: true });
    tickTimer = setInterval(inject, 1000);
    inject();
  }
  function unmountUi() {
    mounted = false;
    obs?.disconnect(); obs = null;
    clearInterval(tickTimer); clearTimeout(passTimer);
    closeMenu(false);
    styleEl?.remove(); panelEl?.remove(); styleEl = panelEl = null;
    document.querySelectorAll('.as-btn').forEach((b) => b.remove());
  }

// continues the autosell closure from autosell-2.js (same try / IIFE)
  // ---- load ---------------------------------------------------------------------------------------------------------------
  W.autoSell = {
    start, stop, jobs: listJobs, status, items, open: openMenu, cfg,
    get running() { return jobs.size > 0; },
    _decide: decide, _unitCost: unitCost,
    _unload() { unloaded = true; jobs.clear(); wake?.(); if (mounted) unmountUi(); },
  };

  restore();
  if (HAS_DOM) (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    if (unloaded) return;
    mountUi();
    if (jobs.size) { core.ledger.add(TAG, 'info', 'resumed ' + jobs.size + ' auto ship job' + (jobs.size > 1 ? 's' : '') + ' from the last session'); loop(); }
    console.log('[autoSell] ready: "Auto ship" button on every bid in the Market table, or autoSell.start({ deal, total, keep })');
  })();
})();
} catch (e) { console.error('[IdleCorp] Auto ship failed to load:', e); }
// @@END autosell
// ============================================================================
// 3c. AUTO UTILITIES (window.autoUtil)
// ============================================================================
// An "Auto" switch on the Load tile (power, Utilities page) and the Supply tile (water, Utilities > Water). While it is on, the
// grid service (power) or waterworks (water) subscription follows what the Corporation needs: it is raised at once when the groups
// need more than the capacity, and lowered when the load has stayed down. Nothing else is touched.
//   autoUtil.set('power', true) / autoUtil.set('water', false)   // the same switches, from the console
//   autoUtil.status() / autoUtil.stop()                          // what it does now / both switches off
//   autoUtil.cfg                                                 // timings; autoUtil.conf: spare per utility, hold minutes
//
// What it follows (the same numbers the game's own page shows; autoUtil._measure is the pure version, used by the tests):
//   need = load (running groups' building draw + recipe draw) + power sold on contracts (the promised amount) + what stalled groups wait for
//          - self-generated (generators, at the day/night rate) - storage that can discharge - bought on contracts
//   The subscription is set to ceil(need) plus the spare you set (default 0), at most 200 MW / 500 kL, one region at a time.
// Money rules, from how the game bills (power $10 per MW, water $4 per kL, every 10 minutes):
//   - raising charges the extra level for the current period up front; lowering refunds nothing. So a raise is made at once,
//     but a lower only when the highest need of the last "hold" minutes (default 10) is below the level, and only in the minute
//     before a bill, so the level never drops and has to be bought again inside one period. It never lowers the first hold minutes.
//   - cash must cover the raise now AND the next bill, which is for the higher level (every subscription is billed together): a raise
//     the cash cannot cover is cut to what it can, and nothing is sent when it cannot cover one unit.
//   - while Autopilot sends live actions (not a dry run, not held), power never goes below what Autopilot itself would subscribe
//     (all its unpaused groups at full draw), so the two do not undo each other.
//   - every change is confirmed by the subscription value in the game state; 3 unconfirmed sends in a row switch that utility off
//     (a closed game socket is waited out, it is not a failed send).
// The switches are saved in this browser. Alt+Shift+X switches them off with everything else.
// @@MODULE utilities
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');
  const HAS_DOM = typeof document !== 'undefined' && !!document.body;
  const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
  const KEY = 'autoUtil.v1';
  const TAG = 'AU';
  if (W.autoUtil?._unload) W.autoUtil._unload();
  let unloaded = false;
  const h = core.h;

  // ---- game facts (from the game's own bundle) -----------------------------------------------------------------
  // rate: cents per unit per 10-minute bill; tile: the label of the tile the switch sits on.
  const UTILS = {
    power: { unit: 'MW', rate: 1000, max: 200, tile: 'Load', noun: 'grid service' },
    water: { unit: 'kL', rate: 400, max: 500, tile: 'Supply', noun: 'waterworks' },
  };
  const NAMES = Object.keys(UTILS);
  const RATES = { power: 1000, water: 400, bandwidth: 1500 };   // cents per unit per bill: what the game bills together (ISP: st.isp, 15 per Mbps)
  const DAY = 28800, DAYLIGHT = 21600, NIGHT_PCT = 25;       // ticks; diurnal generators make 25% of their output at night
  const BILL_TICKS = 1200;                                   // a bill every 10 minutes at 2 ticks a second
  const INTANGIBLE = new Set([0, 24, 25, 26, 106, 107, 108, 109, 110, 111]);   // items held in st.items, not in stock
  const MAX_FAILS = 3;
  const cfg = { cycleMs: 2000, confirmMs: 10000, backoffMs: 5000, lowerWindowTicks: 120 };   // timings; the tests shorten them
  const conf = { power: { on: false, spare: 0 }, water: { on: false, spare: 0 }, holdMin: 10 };
  const REGION_NAMES = ['Heartland', 'Industrial Basin', 'Coastal Cities', 'Frontier'];
  const regionName = (r) => REGION_NAMES[r] ?? 'Region ' + r;
  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };

  // ---- saved switches ------------------------------------------------------------------------------------------------
  const persistable = () => ({ power: { ...conf.power }, water: { ...conf.water }, holdMin: conf.holdMin });
  function apply(o) {
    const applied = [], skipped = [];
    if (!o || typeof o !== 'object') return { applied, skipped: ['not an object'] };
    for (const u of NAMES) {
      const x = o[u];
      if (x == null) continue;
      if (typeof x !== 'object') { skipped.push(u); continue; }
      if (typeof x.on === 'boolean') { if (conf[u].on !== x.on) { conf[u].on = x.on; resetUtil(u); } applied.push(u + '.on'); } else if ('on' in x) skipped.push(u + '.on');
      if ('spare' in x) { const n = toInt(x.spare, 0, UTILS[u].max, null); if (n == null) skipped.push(u + '.spare'); else { conf[u].spare = n; applied.push(u + '.spare'); } }
    }
    if ('holdMin' in o) { const n = toInt(o.holdMin, 1, 120, null); if (n == null) skipped.push('holdMin'); else { conf.holdMin = n; applied.push('holdMin'); } }
    return { applied, skipped };
  }
  function save() { try { store?.setItem(KEY, JSON.stringify(persistable())); } catch {} }
  function restore() { try { apply(JSON.parse(store?.getItem(KEY) || 'null')); } catch {} }

  // ---- reading the game ----------------------------------------------------------------------------------------------
  let lastContracts = null;    // contracts are a prop of the page router: unreadable while a Corporation profile is open, so keep the last look
  function read(fresh = false) {
    const { ws, st, catalog, contracts } = core.walk(fresh);
    if (!st || !catalog) return null;
    core.seeTick(st.ssi?.last_user_mutation_tick);
    if (Array.isArray(contracts)) lastContracts = contracts;
    return { st, catalog, contracts: lastContracts, ws, wsOpen: ws?.readyState === 1, tick: core.nowTick(), mutTick: st.ssi?.last_user_mutation_tick ?? 0 };
  }

  const ixRef = new WeakMap();
  function idx(catalog) {
    let x = ixRef.get(catalog);
    if (!x) { x = { b: new Map((catalog.buildings ?? []).map((b) => [b.id, b])), r: new Map((catalog.recipes ?? []).map((r) => [r.id, r])) }; ixRef.set(catalog, x); }
    return x;
  }
  const diurnal = (p, tick) => (((tick % DAY) + DAY) % DAY < DAYLIGHT ? p : Math.floor(p * NIGHT_PCT / 100));

  // ---- what is needed (pure: no I/O) -----------------------------------------------------------------------------------
  // The page's numbers for one utility in one region. Returns what the groups draw, what is generated, stored or bought, what
  // stalled groups wait for, and need: the subscription that covers all of it (can be negative: the Corporation has a surplus).
  function measure(util, region, st, catalog, tick, contracts) {
    const R = String(region), ix = idx(catalog);
    const have = st.subscriptions?.[R]?.[util] ?? 0;
    const groups = Object.values(st.groups ?? {}).filter((g) => (g.region ?? 0) === region);
    const stockOf = (item) => (INTANGIBLE.has(item) ? (st.items?.[item] ?? 0) : (st.stock?.[R]?.[item] ?? 0));
    let load = 0, gen = 0;
    for (const g of groups) {
      const work = g.work ?? [];
      if (work.length) load += (ix.b.get(g.building)?.draws?.[util] ?? 0) * g.count;
      for (const w of work) {
        const rc = ix.r.get(w.recipe);
        if (!rc) continue;
        load += (rc.draws?.[util] ?? 0) * w.runs;
        const p = (rc.generates?.[util] ?? 0) * w.runs;
        gen += rc.diurnal ? diurnal(p, tick) : p;
      }
    }
    const owned = (id) => (st.building_pool?.[R]?.[id] ?? 0) + groups.filter((g) => g.building === id).reduce((a, g) => a + g.count, 0);
    let dischargeCap = 0;
    for (const b of catalog.buildings ?? []) { const s = b.storage?.[util]; if (s) dischargeCap += (s.discharge_limit ?? 0) * owned(b.id); }
    const discharge = Math.min(dischargeCap, st.stored?.[R]?.[util] ?? 0);
    const corp = st.ssi?.corp_id;
    const deal = (who, field) => (contracts ?? []).filter((c) => c.utility === util && c.region === region && c.state === 'Active' && c[who] === corp).reduce((a, c) => a + (c[field] ?? 0), 0);
    const imported = deal('buyer', 'delivered'), sold = deal('seller', 'amount');   // what is promised to others is owed, whatever has got through so far
    // A group that could start but whose draw is more than the free capacity is stalled; it starts once that much more is free.
    // A group with no machines yet (equipped 0) cannot start whatever the power: the game calls it "unequipped", not stalled.
    const free = Math.max(0, have + gen + discharge + imported - load - sold);
    let waiting = 0;
    for (const g of groups) {
      if (g.paused || g.equipped === 0 || (g.work ?? []).length) continue;
      const draw = (ix.b.get(g.building)?.draws?.[util] ?? 0) * g.count;
      if (!(draw > 0) || draw <= free) continue;
      const rc = (g.recipe != null && (st.recipes?.[String(g.recipe)] ?? ix.r.get(g.recipe))) || null;
      if (!rc || !(rc.inputs ?? []).every((i) => stockOf(i.item) >= i.amount)) continue;
      waiting += draw;
    }
    return { util, region, have, load, sold, gen, discharge, imported, waiting, need: load + sold + waiting - gen - discharge - imported };
  }

  // The level that covers a measurement: ceil(need) plus the spare (only when something needs it), not below floor, over the cap flagged.
  function wantOf(m, spare = 0, floor = 0) {
    const u = UTILS[m.util];
    const raw = Math.max(m.need > 0 ? Math.ceil(m.need - 1e-9) + spare : 0, floor);
    return { want: Math.min(u.max, raw), over: raw > u.max ? raw : 0 };
  }

  // Autopilot subscribes power for every unpaused group at full draw (never lowering): while it sends live actions, that is the least to keep.
  function autopilotFloor(util, region, st, catalog) {
    if (util !== 'power' || region !== 0 || !W.earlyGame?.busy || W.earlyGame.held) return 0;
    const ix = idx(catalog);
    return Object.values(st.groups ?? {}).filter((g) => (g.region ?? 0) === 0 && !g.paused)
      .reduce((a, g) => a + (ix.b.get(g.building)?.draws?.power ?? 0) * g.count, 0);
  }

  // What the game bills at the next bill, all subscriptions together (cents).
  function billsOf(st) {
    let t = (st.isp ?? 0) * RATES.bandwidth;
    for (const o of Object.values(st.subscriptions ?? {})) for (const [k, l] of Object.entries(o ?? {})) t += (l ?? 0) * (RATES[k] ?? 0);
    return t;
  }

  // What to do about one level. peak: the highest want over the hold window; observedMs: how long it has been watched;
  // ticksToBill: ticks until the next bill (null: unknown); bills: what that bill is now. Returns { kind: 'ok' | 'raise' | 'lower' | 'hold' | 'broke', ... }.
  function decide({ util, have, want, peak, observedMs, holdMs, money, bills = 0, ticksToBill, canLower = true, lowerWindowTicks = cfg.lowerWindowTicks }) {
    const rate = UTILS[util].rate;
    if (want > have) {
      // Each extra unit costs its rate now and again in the next bill: cash left after the bill as it is must pay both.
      const afford = have + Math.floor(Math.max(0, money - bills) / (2 * rate));
      const level = Math.min(want, afford);
      if (level <= have) return { kind: 'broke', level: want };
      return { kind: 'raise', level, partial: level < want };
    }
    if (peak < have) {
      if (!canLower) return { kind: 'hold', why: 'contracts not readable' };
      if (observedMs < holdMs) return { kind: 'hold', why: 'watching the load first' };
      if (ticksToBill != null && ticksToBill > lowerWindowTicks) return { kind: 'hold', why: 'lowering just before the next bill', level: peak };
      return { kind: 'lower', level: peak };
    }
    return { kind: 'ok' };
  }

  // ---- the engine --------------------------------------------------------------------------------------------------------
  const ctl = new Map();                 // util:region -> { samples: [{t, want}], first, fails, retryAt }
  const info = { power: [], water: [] }; // the last look, for the page
  let loopTimer = 0, busy = false;
  const anyOn = () => NAMES.some((u) => conf[u].on);
  const unit = (u) => UTILS[u].unit;

  function resetUtil(util) { for (const k of [...ctl.keys()]) if (k.startsWith(util + ':')) ctl.delete(k); info[util] = []; }

  function regionsOf(util, st) {
    const s = new Set();
    for (const g of Object.values(st.groups ?? {})) s.add(g.region ?? 0);
    for (const [r, o] of Object.entries(st.subscriptions ?? {})) if ((o?.[util] ?? 0) > 0) s.add(Number(r));
    return [...s].sort((a, b) => a - b);
  }

  async function setLevel(util, region, level) {
    const r = read(true);
    if (!r || !r.wsOpen) return 'down';                         // nothing was sent: not a failed change
    const d0 = core.markSend(r.mutTick);
    r.ws.send(JSON.stringify({ type: 'SetSubscription', region, utility: util, level }));
    const ok = await core.waitConfirm({
      read, d0, timeoutMs: cfg.confirmMs,
      pred: (x) => (x.st.subscriptions?.[String(region)]?.[util] ?? 0) === level,
      closed: () => { throw new Error('socket closed while waiting'); },
    });
    return !!ok;
  }

  async function step(now = Date.now()) {
    if (busy || unloaded) return;
    busy = true;
    try {
      let r = read(true);
      for (const util of NAMES) {
        if (!conf[util].on) { info[util] = []; continue; }
        if (!r) { info[util] = [{ text: 'Waiting for the game', tone: 'muted' }]; continue; }
        const out = [];
        for (const region of regionsOf(util, r.st)) {
          if (unloaded || !conf[util].on) break;                    // switched off while an earlier change was being confirmed
          const row = await tend(util, region, r, now);
          out.push(row);
          if (row.sent) r = read(true) ?? r;                        // the cash and levels changed: the next one is decided on the new state
        }
        info[util] = conf[util].on ? out : [];
      }
      render();
    } catch (e) { console.error('[autoUtil]', e); }
    finally { busy = false; }
  }

  async function tend(util, region, r, now) {
    const key = util + ':' + region, u = UTILS[util];
    let c = ctl.get(key);
    if (!c) ctl.set(key, c = { samples: [], first: now, fails: 0, retryAt: 0 });
    const m = measure(util, region, r.st, r.catalog, r.tick, r.contracts);
    const { want, over } = wantOf(m, conf[util].spare, autopilotFloor(util, region, r.st, r.catalog));
    const holdMs = conf.holdMin * 60000;
    c.samples.push({ t: now, want });
    while (c.samples.length > 1 && c.samples[0].t < now - holdMs) c.samples.shift();
    const peak = Math.max(...c.samples.map((s) => s.want));
    const money = r.st.items?.[0] ?? 0, bills = billsOf(r.st);
    const ticksToBill = r.tick > 0 ? BILL_TICKS - (r.tick % BILL_TICKS) : null;
    const d = decide({ util, have: m.have, want, peak, observedMs: now - c.first, holdMs, money, bills, ticksToBill, canLower: Array.isArray(r.contracts) });
    const where = regionName(region);
    const row = { region, util, have: m.have, need: m.need, want, kind: d.kind };
    if (d.kind === 'raise' || d.kind === 'lower') {
      if (now < c.retryAt) return { ...row, text: 'Retrying in ' + Math.ceil((c.retryAt - now) / 1000) + ' s', tone: 'warn' };
      const was = m.have;
      const res = await setLevel(util, region, d.level);
      if (res === 'down') return { ...row, text: 'Waiting for the game connection', tone: 'muted' };
      if (res === true) {
        c.fails = 0; c.retryAt = 0;
        const why = d.kind === 'raise' ? 'need ' + Math.ceil(m.need) + (d.partial ? ', cash pays for ' + d.level + ' only' : '') : 'highest need in the last ' + conf.holdMin + ' min: ' + peak;
        core.ledger.add(TAG, 'action', where + ' ' + util + ' ' + u.noun + ' ' + was + ' → ' + d.level + ' ' + unit(util) + ' (' + why + ')');
        return { ...row, have: d.level, sent: true, text: (d.kind === 'raise' ? 'Raised to ' : 'Lowered to ') + d.level + ' ' + unit(util), tone: 'good' };
      }
      c.fails++;
      c.retryAt = now + Math.min(60000, cfg.backoffMs * 2 ** c.fails);
      core.ledger.add(TAG, 'fail', 'not confirmed: ' + util + ' to ' + d.level + ' ' + unit(util) + ' (' + c.fails + '/' + MAX_FAILS + ')');
      if (c.fails >= MAX_FAILS) {
        conf[util].on = false; save(); ctl.delete(key);
        core.ledger.add(TAG, 'fail', 'Auto ' + util + ' switched off: the server did not apply ' + MAX_FAILS + ' changes in a row');
        core.toast('Auto ' + util + ' switched off: the game did not apply the change', 'error');
        renderAll();
      }
      return { ...row, sent: true, text: 'Change not confirmed (' + c.fails + '/' + MAX_FAILS + ')', tone: 'warn' };
    }
    c.fails = 0; c.retryAt = 0;                                   // nothing to send: earlier failures are not "in a row" any more
    const lowNote = m.need < 0 ? ' (surplus ' + Math.round(-m.need) + ')' : '';
    if (d.kind === 'broke') return { ...row, text: 'Needs ' + want + ' ' + unit(util) + ' but cash cannot cover the upfront ' + usd((want - m.have) * u.rate) + ' and the next bill', tone: 'warn' };
    if (over) return { ...row, text: 'Needs ' + Math.ceil(over) + ' ' + unit(util) + ', the cap is ' + u.max, tone: 'warn' };
    if (d.kind === 'hold') return { ...row, text: 'Holding ' + m.have + ' ' + unit(util) + ': ' + d.why, tone: 'muted' };
    return { ...row, text: 'Following the load: ' + m.have + ' ' + unit(util) + ' for ' + Math.max(0, Math.ceil(m.need)) + ' needed' + lowNote, tone: 'muted' };
  }

  function ensureLoop() {
    if (anyOn() && !loopTimer && !unloaded) { loopTimer = setInterval(step, cfg.cycleMs); }
    else if (!anyOn() && loopTimer) { clearInterval(loopTimer); loopTimer = 0; }
  }

  function set(util, on) {
    if (!UTILS[util]) throw new Error('utility must be one of ' + NAMES.join(', '));
    on = !!on;
    if (conf[util].on === on) return on;
    conf[util].on = on; save();
    resetUtil(util);
    core.ledger.add(TAG, 'info', 'Auto ' + util + (on ? ' on' : ' off'));
    ensureLoop();
    renderAll();
    return on;
  }
  function stop() { for (const u of NAMES) set(u, false); }
  function status() { return NAMES.map((u) => u + ': ' + (conf[u].on ? (info[u].map((x) => (x.region != null ? regionName(x.region) + ' ' : '') + x.text).join('; ') || 'on') : 'off')).join(' | '); }

  // ---- the page ------------------------------------------------------------------------------------------------------
  const CSS = '.au-host{position:relative}' +
    '.au-sw{position:absolute;top:8px;right:10px;display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-2,#b6b6ba);cursor:pointer;user-select:none}' +
    '.au-sw input{position:absolute;opacity:0;width:0;height:0}' +
    '.au-track{width:26px;height:14px;border-radius:7px;background:var(--surface-3,#27272a);border:1px solid var(--border,rgba(255,255,255,.18));position:relative;transition:background .15s}' +
    '.au-track::after{content:"";position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;background:var(--ink-2,#b6b6ba);transition:transform .15s}' +
    '.au-sw input:checked+.au-track{background:var(--status-good,#22b573);border-color:transparent}' +
    '.au-sw input:checked+.au-track::after{transform:translateX(12px);background:#fff}' +
    '.au-sw input:focus-visible+.au-track{outline:2px solid var(--accent,#5b8def);outline-offset:2px}' +
    '.au-note{margin-top:6px;font-size:11px;line-height:1.4;color:var(--muted,#808086)}.au-note.warn{color:var(--status-warn,#f2a93b)}.au-note.good{color:var(--status-good,#22b573)}' +
    '@media (prefers-reduced-motion:reduce){.au-track,.au-track::after{transition:none}}';

  let styleEl = null, obs = null, tickTimer = 0, passTimer = 0, mounted = false;
  const tileOf = (util) => [...document.querySelectorAll('.stat-grid > .tile')].find((t) => t.querySelector(':scope > .label')?.textContent.trim() === UTILS[util].tile);

  function inject() {
    if (!HAS_DOM || unloaded || !mounted) return;
    for (const util of NAMES) {
      const tile = tileOf(util);
      for (const el of document.querySelectorAll('[data-au="' + util + '"],[data-au-note="' + util + '"]')) if (el.parentElement !== tile) el.remove();
      if (!tile) continue;
      tile.classList.add('au-host');
      let sw = tile.querySelector(':scope > [data-au="' + util + '"]'), note = tile.querySelector(':scope > [data-au-note="' + util + '"]');
      if (!sw) {
        const box = h('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Auto ' + UTILS[util].noun + ' (' + util + ')', onchange: (e) => set(util, e.target.checked) });
        sw = h('label', { class: 'au-sw', 'data-au': util, title: 'Keep the ' + UTILS[util].noun + ' subscription at what the groups need: up at once, down when the load has stayed low' },
          box, h('span', { class: 'au-track' }), h('span', {}, 'Auto'));
        tile.append(sw);
      }
      if (!note) { note = h('div', { class: 'au-note', 'data-au-note': util }); tile.append(note); }
      const box = sw.querySelector('input');
      if (box.checked !== conf[util].on) box.checked = conf[util].on;
      const rows = info[util];
      const text = !conf[util].on ? '' : (rows.length ? rows.map((x) => (rows.length > 1 && x.region != null ? regionName(x.region) + ': ' : '') + x.text).join(' · ') : 'Auto is on');
      const tone = rows.find((x) => x.tone === 'warn') ? 'warn' : rows.find((x) => x.tone === 'good') ? 'good' : '';
      if (note.textContent !== text) note.textContent = text;
      note.className = 'au-note' + (tone ? ' ' + tone : '');
      note.hidden = !text;
    }
  }
  const render = () => { if (mounted && !unloaded) inject(); };
  const renderAll = () => { if (mounted && !unloaded) { clearTimeout(passTimer); passTimer = setTimeout(inject, 60); } };

  function mountUi() {
    mounted = true;
    styleEl = h('style', { id: 'au-style' }, CSS);
    document.head.append(styleEl);
    obs = new MutationObserver(renderAll);
    obs.observe(document.body, { childList: true, subtree: true });
    tickTimer = setInterval(inject, 1000);
    inject();
  }
  function unmountUi() {
    mounted = false;
    obs?.disconnect(); obs = null;
    clearInterval(tickTimer); clearTimeout(passTimer);
    styleEl?.remove(); styleEl = null;
    document.querySelectorAll('[data-au],[data-au-note]').forEach((e) => e.remove());
    document.querySelectorAll('.au-host').forEach((e) => e.classList.remove('au-host'));
  }

  // ---- load --------------------------------------------------------------------------------------------------------------
  W.autoUtil = {
    set, stop, status, cfg, conf,
    get running() { return anyOn(); },
    exportCfg: () => ({ cfg: persistable() }),
    importCfg(o) { const r = apply(o?.cfg ?? o); save(); ensureLoop(); renderAll(); return r; },
    _measure: measure, _want: wantOf, _decide: decide, _step: step, _floor: autopilotFloor, _info: info,
    _unload() { unloaded = true; clearInterval(loopTimer); loopTimer = 0; if (mounted) unmountUi(); },
  };

  restore();
  if (anyOn()) ensureLoop();
  if (HAS_DOM) (async () => {
    for (;;) {
      if (unloaded) return;
      if (document.querySelector('.primary-navigation') && read()) break;
      await core.sleep(500);
    }
    mountUi();
    if (anyOn()) core.ledger.add(TAG, 'info', 'resumed: Auto ' + NAMES.filter((u) => conf[u].on).join(' + ') + ' from the last session');
    console.log('[autoUtil] ready: "Auto" switch on the Load tile (power) and the Supply tile (water) of the Utilities pages, or autoUtil.set("power", true)');
  })();
})();
} catch (e) { console.error('[IdleCorp] Auto utilities failed to load:', e); }
// @@END utilities// ============================================================================
// 3d. CORE PLAN (window.corePlan)
// ============================================================================
// Coordinator for wiki/guides/core-game-plan.md: reads the game, says which stage (A-D) the Corporation is in and which of the start
// conditions S1-S7 and end conditions E1-E5 hold (with the reason for each that does not), and sends the few purchases it owns.
//   corePlan.status() / corePlan.plan()        // what it sees and would do now (nothing is sent)
//   corePlan.start({ dryRun: false })          // dry run unless told otherwise; Live resumes after a page reload (60 s to cancel)
//   corePlan.stop() / hold(who) / release(who) // like earlyGame; CD Farm holds every registered module while it buys
//   corePlan.duties()                          // what Autopilot still does that Core plan has not taken over
// What it sends today (everything else is read-out only):
//   - Hand-off at Plan done: the engine items go onto Autopilot's neverSell list and its CD booster is switched off (earlyGame.tune);
//     then Autopilot is stopped once (earlyGame.stop), as Core plan resumes bill-paused groups itself (plan D-4, D7), once Auto utilities
//     power is on too (Autopilot also raises the power subscription).
//   - Unlock director: StartTech for Assembly Plant, then Retail Store, then Oil Rig, only when the research slot is idle, the previous
//     unlock is in, the CD and the prototype items are in stock, and (Oil Rig) the retail checkpoint has passed.
//   - Land, Stage A-B: an acre plus a Cotton Farm while (acre + Farm) / Cotton Farm income <= 20 h. Autopilot is held around it.
//     Not while CD alone holds up the next unlock (Stage A, wiki 11.1), nor while buildout has a block to buy or saves cash for one (Stage B, plan D-1).
//   Stage C-D land and the engine build-out are shown (landRule) but not bought yet.
// The pure part (corePlan._view / _decide) has no DOM, sockets or timers; the tests drive it with saved boards.
// @@MODULE core-plan
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');
  if (!core.planner || !core.coreMath) throw new Error('planner / core-math did not load');
  const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
  const sstore = (() => { try { return W.sessionStorage ?? null; } catch { return null; } })();
  const KEY = 'corePlan.v1', LIVE_KEY = KEY + '.live', LOCK_KEY = KEY + '.lock';
  const TAG = 'CP';
  const TAB = Math.random().toString(36).slice(2, 8);
  if (W.corePlan?._unload) W.corePlan._unload();
  let unloaded = false;
  const P = core.planner, M = core.coreMath;
  const REGION = 0, MONEY = 0, CD = 24, STARTER_ACRES = 25, FIRST_ACRE = 5000, ACRE_CAP = 360;   // FIRST_ACRE in cents

  const DEFAULTS = {
    dryRun: true,
    intervalMs: 5000, confirmMs: 8000, maxFails: 3, cmdsPerMin: 20,
    landPaybackAB: 20,            // Stage A-B: buy an acre + Cotton Farm while payback <= this many hours (wiki 4.6)
    cottonFarmHourly: 790,        // dollars per hour one Cotton Farm earns (wiki 4.6)
    landPaybackFraction: 1 / 3,   // Stage C-D: payback <= T_wall x this
    cashReserve: 0,               // cents kept on top of the other modules' money floors
    ifReserve: 44,                // upper cap on the Iron Frames kept back for the prototypes and first builds (ifNeed counts what is still needed)
    bufferAcres: 16,              // acres kept free for the CD farm (my-plan.js cdBufferAcres)
    cyclesPerHour: 600,           // the CD rate the land rule assumes until a measured one exists
    handoff: true,                // at Plan done: engine items to Autopilot's neverSell, its CD booster off
    handoffStopAutopilot: true,   // ... then stop Autopilot once (Core plan resumes bill-paused groups); a user restart is left alone
    unlocks: true, land: true,    // the two directors that send
    liveResume: true,             // after a reload Live resumes (60 s countdown); off = it comes back as a dry run
    resumeSeconds: 60,
  };
  const SESSION_ONLY = ['dryRun'];
  const cfg = { ...DEFAULTS };
  const ENGINE_ITEMS = ['Wood', 'Planks', 'Iron Sheet', 'Concrete', 'Glass', 'Bookshelf', 'Table', 'Chair', 'Bench', 'Wooden Frame', 'Iron Frame',
    'Iron Ore', 'Coal', 'Limestone', 'Sand', 'Copper Ore', 'Copper Wire', 'Wired Frame'];   // cp-cadence NEVER plus the ores the kits use
  const UNLOCKS = ['Assembly Plant', 'Retail Store', 'Oil Rig'];   // in this order (wiki 9)
  const S2_NEEDS = ['Mine', 'Quarry', 'Sawmill', 'Smelter', 'Workshop', 'Kiln', 'Factory', 'Paper Mill', 'Manufacturing Lab'];

  // ---- ids by name (the client catalog array is not indexed by id) ------------------------------------------------------
  const idxRef = new WeakMap();
  function names(raw) {
    let x = idxRef.get(raw);
    if (!x) {
      const C = P.normalize(raw);
      const by = (m) => Object.fromEntries(Object.values(m ?? {}).map((e) => [e.name, e.id]));
      const pieces = Object.fromEntries([...(raw.machines ?? []), ...(raw.belts ?? [])].map((p) => [p.item, p]));   // floor pieces, for parts lists
      x = { C, techs: raw.techs ?? [], pieces, b: by(C.buildings), r: by(C.recipes), i: by(C.items) };   // planner.normalize drops the tech list
      idxRef.set(raw, x);
    }
    return x;
  }
  const acrePriceCents = (n) => { let p = FIRST_ACRE; for (let i = 0; i < n; i++) p = Math.floor(p * 41 / 40); return p; };
  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  // ---- purchase and floor pieces shared by the buildout, lab and endgame directors ----------------------------------------------------
  const billNeed = (v, newMW) => newMW * 2000 + (v.st.subscriptions?.[REGION]?.power ?? 0) * 12000;   // cents: $20 per new MW + 2 h of bills ($60/MW/h)
  // One purchase: BuyLand (if acres), BuyBuilding, then the building into group g, else a new group of `amount` named `name`.
  function buySteps(v, b, acres, g, name, amount = 1) {
    const p0 = v.pool[b] ?? 0, l0 = v.landBought, steps = [];
    if (acres) steps.push({ msg: { type: 'BuyLand', amount: acres, region: REGION }, until: (x) => x.landBought >= l0 + acres });
    steps.push({ msg: { type: 'BuyBuilding', building: b, amount: 1, region: REGION }, until: (x) => (x.pool[b] ?? 0) >= p0 + 1 });
    if (g) { const c0 = g.count; steps.push({ msg: { type: 'AssignBuildings', group: g.id, amount: 1 }, until: (x) => (x.groups.find((y) => y.id === g.id)?.count ?? 0) >= c0 + 1 }); }
    else { const ids = new Set(v.groups.map((x) => x.id)); steps.push({ msg: { type: 'CreateGroup', building: b, amount, name, region: REGION }, until: (x) => x.groups.some((y) => !ids.has(y.id) && y.building === b) }); }
    return steps;
  }
  const floorObj = (design) => {   // a floor design string from the core as EditLayout cells, or null when the core has none
    const cells = W.idleCore?.floorDesigns?.[design];
    return cells ? Object.fromEntries(cells.split(' ').map((t) => { const [x, y, item, rot] = t.split(/[,:]/).map(Number); return [x + ',' + y, { item, rot }]; })) : null;
  };
  // An EditLayout the server did not apply: floors under the same key wait cfg.floorRetryMin (endgame: the recipe id, so a failed floor never blocks
  // another; buildout: one key for all). mem(memName).floorFail holds the time per key; the module copy covers no browser storage.
  const floorFail = new Map();
  function floorAction(ctx, memName, key, r, obj, waitPre, act) {
    const mm = ctx.mem?.(memName), mk = memName + ':' + key, m = mm?.get?.() ?? {}, now = ctx.now ?? Date.now();
    const failAt = m.floorFail?.[key] ?? floorFail.get(mk) ?? null, retryMs = Math.max(0, cfg.floorRetryMin ?? 10) * 60000;
    if (failAt != null && now - failAt < retryMs) return { wait: waitPre + ': retry in ' + Math.ceil((retryMs - (now - failAt)) / 60000) + ' min' };
    let marked = false;
    const until = (x) => {   // the first look after the send marks the try; a confirm clears it
      const ok = !!x.st.layouts?.[r.id];
      if (ok || !marked) { const t = ok ? null : Date.now(); floorFail.set(mk, t); if (mm) mm.set({ floorFail: { ...mm.get().floorFail, [key]: t } }); }
      marked = true;
      return ok;
    };
    return { action: { ...act, steps: [{ msg: { type: 'EditLayout', recipe: r.id, cells: obj }, until }] } };
  }

  // ---- a small pure view of the game state ---------------------------------------------------------------------------------
  function view(st, raw, deals = []) {
    const N = names(raw), C = N.C;
    const groups = Object.entries(st.groups ?? {}).map(([id, g]) => ({ id: +id, ...g })).filter((g) => (g.region ?? REGION) === REGION);
    const pool = st.building_pool?.[REGION] ?? {};
    const stock = st.stock?.[REGION] ?? {}, items = st.items ?? {};
    const bld = (b) => C.buildings[b] ?? { name: 'building ' + b, cost: 0, acres: 1, build_items: [] };
    const idB = (n) => N.b[n], idI = (n) => N.i[n], idR = (n) => N.r[n];
    const ownedId = (b) => groups.filter((g) => g.building === b).reduce((a, g) => a + g.count, 0) + (pool[b] ?? 0);
    const owned = (n) => (N.b[n] == null ? 0 : ownedId(N.b[n]));
    const landBought = st.land_bought?.[REGION] ?? 0;
    let acresUsed = 0;
    for (const g of groups) acresUsed += bld(g.building).acres * g.count;
    for (const [b, n] of Object.entries(pool)) acresUsed += bld(+b).acres * n;
    const acresOwned = STARTER_ACRES + landBought;
    const unlockedList = st.unlocked_buildings ?? [];
    const unlocked = (n) => N.b[n] != null && (n === 'Lumber Camp' || n === 'Farm' || unlockedList.includes(N.b[n]));
    const has = (n) => { const i = N.i[n]; return i == null ? 0 : (stock[i] ?? items[i] ?? 0); };
    const running = (bn, rn) => groups.filter((g) => g.building === N.b[bn] && g.recipe === N.r[rn] && !g.paused && g.count > 0).reduce((a, g) => a + g.count, 0);
    const cottonGroup = groups.find((g) => g.building === N.b.Farm && g.recipe === N.r['Grow Cotton'] && !g.paused);
    const engineAcres = ['Lumber Camp', 'Farm', 'Sawmill', 'Workshop'].reduce((a, n) => a + owned(n) * (N.b[n] == null ? 0 : bld(N.b[n]).acres), 0);
    const cottonBid = deals.some((d) => d.side === 'Sell' && d.item === N.i.Cotton && (d.region ?? REGION) === REGION);
    return {
      N, C, st, groups, pool, bld, idB, idI, idR, owned, has, unlocked, running, cottonGroup, cottonBid,
      money: items[MONEY] ?? 0, cd: items[CD] ?? 0,
      landBought, acresUsed, acresOwned, freeAcres: Math.max(0, acresOwned - acresUsed), fixedAcres: Math.max(0, acresUsed - engineAcres),
      nextAcreCents: acrePriceCents(landBought),
      research: st.research ?? null, researchIdle: !st.research && !(st.research_queue ?? []).length,
      mutTick: st.ssi?.last_user_mutation_tick ?? 0,
    };
  }

// continues the core-plan closure from core-plan-1.js (same try / IIFE)
  // ---- start and end conditions, stage ----------------------------------------------------------------------------------------
  const cond = (id, ok, why) => ({ id, ok, why });
  function startConditions(v, ctx) {
    const miss2 = S2_NEEDS.filter((n) => !v.unlocked(n));
    const s2 = cond('S2', !miss2.length, miss2.length ? 'not unlocked: ' + miss2.join(', ') : 'all unlocked');
    const need3 = [['Smelter', 'Roll Iron Sheet'], ['Workshop', 'Rivet Iron Frame'], ['Workshop', 'Frame Timber']].filter(([b, r]) => !v.running(b, r));
    const ifs = v.has('Iron Frame');
    const s3 = cond('S3', !need3.length && ifs >= 16, need3.length ? 'not running: ' + need3.map(([b, r]) => b + ' on ' + r).join(', ') : ifs < 16 ? 'Iron Frame stock ' + ifs + ' < 16' : 'running, Iron Frames ' + ifs);
    const lab = v.owned('Manufacturing Lab'), kiln = v.owned('Kiln'), mine = v.owned('Mine'), quarry = v.owned('Quarry');
    const s4 = cond('S4', lab >= 1 && kiln >= 1 && mine >= 1 && quarry >= 1, lab >= 1 && kiln >= 1 && mine >= 1 && quarry >= 1 ? 'built' : 'missing: ' + [['Manufacturing Lab', lab], ['Kiln', kiln], ['Mine', mine], ['Quarry', quarry]].filter(([, n]) => n < 1).map(([n]) => n).join(', '));
    const s1 = cond('S1', ctx.planDone === true || (s2.ok && s3.ok && s4.ok), ctx.planDone === true ? 'Autopilot: Plan done' : (s2.ok && s3.ok && s4.ok) ? 'S2-S4 hold' : 'Autopilot has not finished the Early-Game Plan, and S2-S4 do not all hold');
    const s5 = cond('S5', !v.unlocked('Assembly Plant'), v.unlocked('Assembly Plant') ? 'Assembly Plant is already unlocked (join at stage B or later)' : 'not unlocked yet');
    const c10 = ctx.cashDelta10;
    const s6 = cond('S6', c10 == null ? null : c10 > 0, c10 == null ? 'not enough cash samples yet (needs 10 min)' : 'money ' + (c10 > 0 ? 'rose ' : 'fell ') + usd(Math.abs(c10)) + ' over 10 min');
    const s7 = cond('S7', v.cottonBid, v.cottonBid ? 'Cotton bid in Heartland' : 'no Cotton bid in Heartland');
    return [s1, s2, s3, s4, s5, s6, s7];
  }
  function stageOf(v, S) {
    if (v.owned('Retail Store') >= 1) return 'D';
    if (v.unlocked('Assembly Plant')) return 'C';
    if (v.research && v.research.building === v.idB('Assembly Plant')) return 'B';
    const ok = S.filter((c) => c.id !== 'S5').every((c) => c.ok !== false);
    return ok && S[0].ok ? 'A' : null;
  }
  function landInput(v, ctx) {
    const o = (n) => v.owned(n);
    return { acres: v.acresOwned, acrePrice: v.nextAcreCents / 100, camps: o('Lumber Camp'), farms: o('Farm'), sawmills: o('Sawmill'), workshops: o('Workshop'),
      docks: 0, pastures: 0, fixedAcres: v.fixedAcres,
      // v.fixedAcres already holds a built Retail Store (3 acres) and Assembly Plant (5): only the unbuilt ones are extra
      fixedExtra: (v.owned('Retail Store') ? 0 : 3) + (v.owned('Assembly Plant') ? 0 : 5), cyclesPerHour: ctx.cyclesPerHour ?? cfg.cyclesPerHour, cdBufferAcres: cfg.bufferAcres };
  }
  // Iron Frames (or `item`) the three unlocks still need (wiki 9): the prototype until its research starts, the first build until the building
  // stands. `except` is the building being bought now: its own first build is not kept back from itself.
  function ifNeed(v, except, item = 'Iron Frame') {
    const ifId = v.idI(item);
    if (ifId == null) return 0;
    const queued = (v.st.research_queue ?? []).map((q) => q.building);
    let n = 0;
    for (const name of UNLOCKS) {
      const b = v.idB(name);
      if (b == null) continue;
      const per = (v.bld(b).build_items ?? []).find((i) => i.item === ifId)?.amount ?? 0;
      if (!v.unlocked(name) && v.research?.building !== b && !queued.includes(b)) n += per;
      if (v.owned(name) === 0 && name !== except) n += per;
    }
    return n;
  }
  // E3 (plan C3): 0 Farms, Wooden Frames < 20, CD Farm on Auto with its batch within 1 of core-math bestBatch('farm', 0) at the measured
  // income and cycles (what the ladder tunes it to), and a Farm-only plan. Retail fail path: the Farms stay on Cotton (wiki 4.7), so Auto on,
  // frames at most the keep line + 20 (one free courier load) and the same batch check for the plan CD Farm runs.
  function e3Of(v, ctx) {
    const fail = !!ctx.retailFailPath, pre = fail ? 'fail path: ' : '';
    const no = (why) => cond('E3', false, pre + why);
    const lad = ctx.ladder ?? {}, fc = ctx.mods?.cdFarm?.cfg;
    const held = (n) => lad.held?.[v.idB(n)] ?? 0;   // units a CD Farm run holds mid-cycle are its own, not owned ones
    const farms = v.owned('Farm') - held('Farm'), wf = v.has('Wooden Frame');
    if (!fail && farms > 0) return no(farms + ' Farms owned');
    if (!fail && wf >= 20) return no('Wooden Frame stock ' + wf + ' >= 20');
    let keep = null;
    if (fail) {
      try { keep = W.corePlan._buildout?.wfKeep?.(v, ctx) ?? null; } catch {}
      if (keep == null) return no('Wooden Frame keep line unknown (build-out director not loaded)');
      if (wf > keep + 20) return no('Wooden Frame stock ' + wf + ' > keep line ' + keep + ' + 20');
    }
    if (!fc) return no('CD Farm is not loaded');
    if (fc.building !== 'auto') return no('CD Farm Building is ' + fc.building + ', not Auto');
    if (fail && !fc.autoStart) return no('CD Farm Auto is off');
    const units = lad.plan?.units ?? [];
    if (!units.length) return no('CD Farm plan not measured yet');
    if (!fail && !units.every((u) => u.b === v.idB('Farm'))) return no('CD Farm plan is ' + units.map((u) => u.n + ' ' + u.name).join(' + ') + ', not Farm-only');
    const income = lad.income > 0 ? lad.income / 100 : null, cycles = lad.rates?.cyclesh15 > 0 ? lad.rates.cyclesh15 : null;   // CD Farm measures cents/h
    if (!income || !cycles) return no('batch not measured yet (no ' + [!income && 'income', !cycles && 'cycles per hour'].filter(Boolean).join(' or ') + ')');
    const best = M.bestBatch('farm', 0, income, cycles).k;
    if (!(Math.abs(fc.batch - best) <= 1)) return no('CD Farm batch ' + fc.batch + ', measured best ' + best + ' (within 1)');
    return cond('E3', true, pre + (fail ? 'Auto on, frames ' + wf + ' <= keep line ' + keep + ' + 20, ' + units.map((u) => u.n + ' ' + u.name).join(' + ') + ' plan' : '0 Farms, frames ' + wf + ', Farm-only plan') + ', batch ' + fc.batch + ' (measured best ' + best + ')');
  }
  // E5 (plan C5): money >= 3 h of net income (cash trend over 60 min + CD Farm's spend in it), and nothing left to buy that pays back inside
  // T_wall/3: the land rule's acres and blocks plus what directors report (ctx.pendingInvest). Net income <= 0 does not pass.
  function e5Of(v, rule, ctx) {
    const inc = ctx.netIncomeH;   // cents per hour
    if (inc == null) return cond('E5', false, 'income not measured yet (needs 60 min of cash samples)');
    if (!(inc > 0)) return cond('E5', false, 'net income ' + usd(inc) + '/h is not positive');
    if (v.money < inc * 3) return cond('E5', false, 'money ' + usd(v.money) + ' < 3 h of net income ' + usd(inc * 3));
    const left = rule.acresToBuy ? [rule.acresToBuy + ' acres'] : [];
    for (const [k, n] of [['camps', 'Camps'], ['sawmills', 'Sawmills'], ['workshops', 'Workshops']]) if (rule.need[k]) left.push(rule.need[k] + ' ' + n);
    for (const p of ctx.pendingInvest ?? []) if (!(p.paybackH > rule.limitHours)) left.push(p.what);
    if (left.length) return cond('E5', false, 'still to buy: ' + left.join(', '));
    return cond('E5', true, 'money ' + usd(v.money) + ' >= 3 h of net income ' + usd(inc * 3) + ', nothing left to buy');
  }
  function endConditions(v, rule, ctx) {
    const retail = v.owned('Retail Store') >= 1;
    const e1 = cond('E1', retail && ctx.retailE1 === true, !retail ? 'Retail Store not built' : ctx.retailE1 === true ? 'selling 6 h in a row with the checkpoint rows passing' : ctx.retailOk === true ? 'checkpoint passed, not yet 6 h in a row' : ctx.retailOk === false ? 'retail checkpoint failed' : 'retail checkpoint not decided yet');
    const miss = UNLOCKS.filter((n) => !v.unlocked(n));
    const e2 = cond('E2', !miss.length, miss.length ? 'not unlocked: ' + miss.join(', ') : 'Assembly Plant, Retail Store and Oil Rig unlocked');
    const e3 = e3Of(v, ctx);
    // C4: T_wall from the measured CD rate when CD Farm has one, else the model (the readout says which)
    const tw = rule ? ' (T_wall ' + rule.tWall.toFixed(1) + ' h from the ' + rule.tWallFrom + ' CD rate)' : '';
    const e4 = rule ? cond('E4', v.acresOwned >= rule.lastAcre && v.freeAcres <= cfg.bufferAcres, (v.acresOwned < rule.lastAcre ? v.acresOwned + ' acres, rule closes at #' + rule.lastAcre : v.freeAcres > cfg.bufferAcres ? v.freeAcres + ' free acres, buffer ' + cfg.bufferAcres : 'rule closed, acres built') + tw)
      : cond('E4', false, 'land rule unavailable');
    const e5 = rule ? e5Of(v, rule, ctx) : cond('E5', false, 'land rule unavailable');
    return [e1, e2, e3, e4, e5];
  }

  // ---- directors ------------------------------------------------------------------------------------------------------------------------
  // Next unlock Core plan owns, with what is still missing. null when all three are in.
  function nextUnlock(v) {
    for (const n of UNLOCKS) {
      if (v.unlocked(n)) continue;
      const b = v.idB(n), tech = v.N.techs.find((t) => t.building === b);
      const out = { b, name: n, cd: tech?.cost ?? 0, prereqsMet: true, note: '', tech };
      if (!tech) { out.prereqsMet = false; out.note = 'not in the tech tree'; return out; }
      if (tech.requires != null && !v.st.unlocked_buildings?.includes(tech.requires) && v.C.buildings[tech.requires]?.name !== 'Lumber Camp') { out.prereqsMet = false; out.note = 'needs ' + (v.C.buildings[tech.requires]?.name ?? 'building ' + tech.requires) + ' first'; }
      return out;
    }
    return null;
  }
  function unlockAction(v, ctx, nx) {
    if (!nx) return { wait: 'all three unlocks are in' };
    const why = 'unlock ' + nx.name;
    if (nx.name === 'Oil Rig' && ctx.retailOk !== true) return { wait: why + ': waits for the retail checkpoint' + (ctx.retailOk === false ? ' (failed: a new run measures the capped output)' : '') };   // only on a pass, of either run (plan D-2)
    if (ctx.apNextTech) return { wait: why + ': Autopilot still owns "' + ctx.apNextTech.name + '"' };
    if (!nx.prereqsMet) return { wait: why + ': ' + nx.note };
    if (v.research) return { wait: why + ': research slot busy' };
    if (v.cd < nx.cd) return { wait: why + ': ' + Math.floor(v.cd) + ' / ' + nx.cd + ' CD' };
    const proto = v.bld(nx.b).build_items ?? [];
    const lack = proto.filter((i) => (v.st.stock?.[REGION]?.[i.item] ?? v.st.items?.[i.item] ?? 0) < i.amount);
    if (lack.length) return { wait: why + ': need ' + lack.map((i) => Math.ceil(i.amount - (v.st.stock?.[REGION]?.[i.item] ?? v.st.items?.[i.item] ?? 0)) + ' more ' + (v.C.items[i.item]?.name ?? 'item ' + i.item)).join(', ') };
    return { action: { id: 'tech:' + nx.b, text: why + ' (' + nx.cd + ' CD' + (proto.length ? ' + ' + proto.map((i) => i.amount + ' ' + (v.C.items[i.item]?.name ?? i.item)).join(', ') : '') + ')',
      steps: [{ msg: { type: 'StartTech', building: nx.b, region: REGION }, until: (x) => x.research?.building === nx.b || x.unlocked(nx.name) }] } };
  }
  // Stage A-B land: an acre plus a Cotton Farm while (acre + Farm) / hourly income <= cfg.landPaybackAB; one purchase per call.
  // block: why another use of the cash goes first (B1, B2).
  function landAction(v, stage, floorCents, block) {
    if (stage !== 'A' && stage !== 'B') return { wait: 'land: stage ' + stage + ' land is bought by the buildout director with its blocks' };
    if (block) return { wait: 'land: ' + block };
    if (!v.cottonGroup) return { wait: 'land: no running Cotton Farm group to add to' };
    if (v.acresOwned >= ACRE_CAP) return { wait: 'land: Heartland cap (' + ACRE_CAP + ' acres)' };
    const farm = v.idB('Farm'), farmCents = P.price(v.bld(farm).cost, v.owned('Farm'), 0);
    const needAcre = v.freeAcres - cfg.bufferAcres < 1;   // the CD farm's spare acres stay free
    const cost = farmCents + (needAcre ? v.nextAcreCents : 0);
    const payback = cost / 100 / cfg.cottonFarmHourly;
    const line = (needAcre ? 'acre #' + (v.acresOwned + 1) + ' ' + usd(v.nextAcreCents) + ' + ' : '') + 'Cotton Farm ' + usd(farmCents) + ', payback ' + payback.toFixed(1) + ' h';
    if (payback > cfg.landPaybackAB) return { wait: 'land: ' + line + ' > ' + cfg.landPaybackAB + ' h, rule closed' };
    if (v.money - cost < floorCents) return { wait: 'land: ' + line + ': need ' + usd(floorCents + cost - v.money) + ' more above the floor' };
    const g = v.cottonGroup, c0 = g.count, p0 = v.pool[farm] ?? 0, l0 = v.landBought;
    const steps = [];
    if (needAcre) steps.push({ msg: { type: 'BuyLand', amount: 1, region: REGION }, until: (x) => x.landBought >= l0 + 1 });
    steps.push({ msg: { type: 'BuyBuilding', building: farm, amount: 1, region: REGION }, until: (x) => (x.pool[farm] ?? 0) >= p0 + 1 });
    steps.push({ msg: { type: 'AssignBuildings', group: g.id, amount: 1 }, until: (x) => (x.groups.find((y) => y.id === g.id)?.count ?? 0) >= c0 + 1 });
    return { action: { id: 'land:' + (v.acresOwned + 1), text: 'buy ' + line, steps, hold: true } };
  }
  function handoffAction(v, ctx) {
    if (!cfg.handoff || !ctx.ap) return null;
    const ids = ENGINE_ITEMS.map((n) => v.idI(n)).filter((i) => i != null);
    const never = ctx.ap.neverSell ?? [];
    const lacking = ids.filter((i) => !never.includes(i));
    if (!lacking.length && ctx.ap.cdBooster === false) {
      // Then stop Autopilot (plan D-4), only once Core plan resumes bill-paused groups (D7), and only once: a restart by the user is left alone.
      const m = ctx.mem?.('handoff');
      if (!m || m.get().stopped || cfg.handoffStopAutopilot === false) return null;
      if (!directors.some((d) => d.name === 'resume') || cfg.dir_resume === false) return null;
      // Autopilot also raises the power subscription: it keeps running until Auto utilities power has that job (plan D1).
      if (ctx.mods?.autoUtil?.conf?.power?.on !== true) return { wait: 'hand-off: Autopilot keeps running until Auto utilities power is on (it raises the power subscription)' };
      // "Stopped once" lives in browser storage: a write must read back through a fresh handle, or a user restart would be stopped again.
      const t = ctx.now ?? Date.now();
      m.set({ chk: t });
      if (ctx.mem('handoff').get().chk !== t) return { wait: 'hand-off: Autopilot keeps running: browser storage does not save, so its stop could not be kept to once' };
      const on = !!ctx.ap.running;   // not running: only recorded, so a later start by the user is not stopped either
      return { id: 'handoff:stop', text: on ? 'hand-off: stop Autopilot (Core plan resumes bill-paused groups now)' : 'hand-off: Autopilot is not running; recorded (a later start is left alone)',
        run: async () => {
          if (on && !W.earlyGame?.stop) return false;
          m.set({ stopped: t });
          if (ctx.mem('handoff').get().stopped !== t) return false;   // recorded first: no stop that is not remembered
          if (on) W.earlyGame.stop();
          return true;
        } };
    }
    return { id: 'handoff', text: 'hand-off: ' + (lacking.length ? lacking.length + ' engine items to Autopilot neverSell' : '') + (ctx.ap.cdBooster !== false ? (lacking.length ? ', ' : '') + 'CD booster off' : ''),
      patch: { neverSell: ids, cdBooster: false } };
  }

  // ---- plug-in directors (steps 5-10 live in their own files: src/cp-*.js) ------------------------------------------------
  // A director is { name, order, always?, defaults?, context?(v, ctx), decide(v, ctx, out) -> { action?, actions?, wait?, readout? }, duties?() }.
  //   always: it also decides when no stage holds (out.stage null).
  //   whenOff(v, ctx, out): decides instead of decide while cfg.dir_<name> is false (endgame: resume what its gate paused).
  //   context(v, ctx, stage): adds facts to ctx before any director decides (e.g. the retail sampler sets ctx.retailOk).
  //   decide: pure; an action is { id, text, steps: [{ msg, until(view) }], hold? } or { id, text, run: async () => true|false|null }.
  //   defaults: cfg keys (validated and saved like the built-in ones). ctx.mem(name) is a small saved object per director.
  //   pendingInvest(v, ctx, rule, stage) -> [{ what, paybackH }]: purchases it still plans; E5 waits while one pays back inside T_wall/3 (null = counts).
  const directors = [];
  function addDirector(d) {
    if (!d?.name || typeof d.decide !== 'function') throw new Error('addDirector: name and decide() are required');
    const i = directors.findIndex((x) => x.name === d.name);
    if (i >= 0) directors.splice(i, 1);
    directors.push(d); directors.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    for (const [k, val] of Object.entries({ ['dir_' + d.name]: true, ...(d.defaults ?? {}) })) { if (!(k in DEFAULTS)) { DEFAULTS[k] = val; cfg[k] = val; } }
    restore();
    return () => { const j = directors.indexOf(d); if (j >= 0) directors.splice(j, 1); };
  }

  // The whole decision, from a view: stage, S/E conditions, the land rule, what to send next (first action) and what it is waiting for.
  function decide(v, ctx = {}) {
    const S = startConditions(v, ctx);
    const stage = stageOf(v, S);
    for (const dir of directors) { try { dir.context?.(v, ctx, stage); } catch (e) { console.error('[corePlan] ' + dir.name + '.context', e); } }
    // After the directors' context: a failed retail checkpoint (ctx.retailFail) caps the planks at the furniture blocks sales carry (plan A2).
    let rule = null;
    try {
      const planksCap = ctx.retailFail && typeof ctx.retailCap === 'number' ? ctx.retailCap / M.engineModel(v.C).wsPerPlank : undefined;
      // C4: the measured CD rate sets T_wall once CD Farm has measured 30 min (landCdRate); the model before
      rule = M.landRule(landInput(v, ctx), v.C, { cyclesPerHour: ctx.cyclesPerHour ?? cfg.cyclesPerHour, planksCap, cdPerHour: landCdRate(ctx) ?? undefined });
    } catch (e) { console.error(e); }
    ctx.pendingInvest = [];
    for (const dir of directors) {
      if (!dir.pendingInvest || cfg['dir_' + dir.name] === false) continue;
      try { ctx.pendingInvest.push(...(dir.pendingInvest(v, ctx, rule, stage) ?? [])); } catch (e) { console.error('[corePlan] ' + dir.name + '.pendingInvest', e); }
    }
    const E = endConditions(v, rule, ctx);
    const out = { stage, S, E, rule, actions: [], waits: [], nextUnlock: null, finished: stage === 'D' && E.every((c) => c.ok), readouts: {} };
    if (out.finished) out.stage = 'END';
    if (!stage) { out.waits.push('stage: start conditions do not hold (' + S.filter((c) => c.ok === false).map((c) => c.id + ': ' + c.why).join('; ') + ')'); return decideDirectors(v, ctx, out, true); }
    out.nextUnlock = nextUnlock(v);
    out._ifId = v.idI('Iron Frame'); out._ifNeed = ifNeed(v); out._wfId = v.idI('Wooden Frame'); out._plId = v.idI('Planks');
    out._failPath = !!ctx.retailFailPath;
    try { out._wfKeep = W.corePlan._buildout?.wfKeep?.(v, ctx) ?? null; } catch { out._wfKeep = null; }   // null: the reserve keeps every frame
    const ho = ctx.planDone === true ? handoffAction(v, ctx) : null;
    if (ho?.wait) out.waits.push(ho.wait); else if (ho) out.actions.push(ho);
    if (ctx.ap?.running && ctx.mem?.('handoff')?.get?.()?.stopped) out.readouts.handoff = { alert: 'Autopilot was started again after the hand-off: left running (it also sells and resumes groups)' };
    const u = unlockAction(v, ctx, out.nextUnlock);
    if (cfg.unlocks) { if (u.action) out.actions.push(u.action); else out.waits.push(u.wait); }
    let block = null;
    // B2 (wiki 11.1): Stage A, the next unlock waits on CD alone (it would start with the CD in hand): no cash into Cotton Farms
    if (stage === 'A' && !u.action && out.nextUnlock && unlockAction({ ...v, cd: Infinity }, ctx, out.nextUnlock).action) block = 'CD is the bottleneck: cash goes to the CD farm';
    // B1 (plan D-1): Stage B, a block buildout can buy now, or is saving cash for, goes before an acre + Cotton Farm
    if (stage === 'B' && cfg.dir_buildout !== false && W.corePlan._buildout?.nextBuildStep) {
      try { const nb = W.corePlan._buildout.nextBuildStep(v, ctx, rule, stage); if (nb?.pick) block = 'build-out goes first (' + nb.why + ')'; else if (nb?.saving) block = 'build-out is saving for ' + nb.saving; } catch (e) { console.error('[corePlan] buildout.nextBuildStep', e); }
    }
    if (cfg.land) { const l = landAction(v, stage, ctx.floorCents ?? 0, block); if (l.action) out.actions.push(l.action); else out.waits.push(l.wait); }
    return decideDirectors(v, ctx, out, false);
  }
  // CD rate for the land rule: CD Farm's 15-min rate, kept in mem one sample per 30 s. Only after 30 min of samples with no gap over
  // 5 min (a null rate or a stop breaks it), as the mean of the last 30 min, so a short dip does not move the land rule. Else null (the model).
  function landCdRate(ctx) {
    const m = ctx.mem?.('landRate'), r = ctx.ladder?.rates?.cdh15, t = ctx.now;
    if (!m || t == null) return null;
    let { since = null, s = [] } = m.get();
    if (!(r > 0)) { if (since != null) m.set({ since: null, s: [] }); return null; }
    if (!s.length || t - s[s.length - 1].t > 300000) { since = t; s = []; }
    if (!s.length || t - s[s.length - 1].t >= 30000) { s = [...s, { t, r }].filter((x) => t - x.t <= 1800000); m.set({ since, s }); }
    return t - since >= 1800000 ? s.reduce((a, x) => a + x.r, 0) / s.length : null;
  }
  // Directors in order; with no stage only those marked always (D7 resume) decide.
  function decideDirectors(v, ctx, out, noStage) {
    for (const dir of directors) {
      if (noStage && !dir.always) continue;
      const off = cfg['dir_' + dir.name] === false;
      if (off) { out.waits.push(dir.name + ': off'); if (!dir.whenOff) continue; }
      let r = null;
      try { r = (off ? dir.whenOff : dir.decide)(v, ctx, out); } catch (e) { console.error('[corePlan] ' + dir.name, e); out.waits.push(dir.name + ': error ' + (e.message ?? e)); continue; }
      if (!r) continue;
      for (const a of [...(r.actions ?? []), ...(r.action ? [r.action] : [])]) out.actions.push({ ...a, director: dir.name });
      if (r.wait) out.waits.push(dir.name + ': ' + r.wait);
      if (r.readout !== undefined) out.readouts[dir.name] = r.readout;
    }
    return out;
  }

// continues the core-plan closure from core-plan-2.js (same try / IIFE)
  // ---- reading the game, sending, confirming ---------------------------------------------------------------------------------
  let pacer = core.pacer ? core.pacer({ cmdsPerMin: cfg.cmdsPerMin }) : null;
  function read(fresh = false) {
    const { ws, st, catalog, deals, engine } = core.walk(fresh);
    lastEngine = engine ?? lastEngine;
    if (!st || !catalog) return null;
    core.seeTick(st.ssi?.last_user_mutation_tick);
    return { st, catalog, ws, deals: deals ?? [], wsOpen: ws?.readyState === 1, mutTick: st.ssi?.last_user_mutation_tick ?? 0, v: view(st, catalog, deals ?? []) };
  }
  const cash = [];
  const pauseSent = new Map();   // group id -> when Core plan last sent SetPaused true for it (D7 reads it: a late confirm is not a bill pause)
  let lastEngine = null;
  const memOf = (name) => { const k = KEY + '.mem.' + name; let o = {}; try { o = JSON.parse(store?.getItem(k) || '{}') ?? {}; } catch {} return { get: () => o, set: (patch) => { o = { ...o, ...patch }; try { store?.setItem(k, JSON.stringify(o)); } catch {} return o; } }; };
  // Keeps one sample at least 60 min old, for E5's hourly trend. A gap over 5 min (stopped, tab asleep) drops the older samples, so the trend
  // is null until 60 min of contiguous samples (not 2 x the 30 s period: a hidden tab steps about once a minute).
  function trackCash(v, t = Date.now()) { if (cash.length && t - cash[cash.length - 1].t > 300000) cash.length = 0; if (!cash.length || t - cash[cash.length - 1].t >= 30000) cash.push({ t, m: v.money }); while (cash.length > 1 && t - cash[1].t >= 3600000) cash.shift(); }
  // Cash trend over the last 60 min in cents per hour; null until a sample is 60 min old.
  function cashTrend60(t = Date.now()) { const base = [...cash].reverse().find((c) => t - c.t >= 3600000), last = cash[cash.length - 1]; return base && last.t > base.t ? (last.m - base.m) * 3600000 / (last.t - base.t) : null; }
  function cashDelta10() { const t = Date.now(), base = [...cash].reverse().find((c) => t - c.t >= 600000); return base && cash.length ? cash[cash.length - 1].m - base.m : null; }
  function context(r) {
    const ap = W.earlyGame;
    let apRes = null; try { apRes = ap?.reserve?.() ?? null; } catch {}
    const others = core.reserves.merged();
    let floor = 0;
    for (const [n, x] of Object.entries(others?.by ?? {})) if (n !== 'corePlan') floor = Math.max(floor, x.moneyFloor ?? 0);
    return {
      planDone: apRes ? apRes.phase === 'done' : null,
      ap: ap?.cfg ? { neverSell: [...(ap.cfg.neverSell ?? [])], cdBooster: ap.cfg.cdBooster, running: !!ap.running } : null,
      apNextTech: apRes?.nextTech && ap?.busy ? apRes.nextTech : null,
      cashDelta10: cashDelta10(), floorCents: floor + cfg.cashReserve,
      // E5 net income (cents/h): the cash trend plus what CD Farm spent in the same hour (rates().spendH, dollars)
      netIncomeH: (() => { const c = cashTrend60(); if (c == null) return null; let s = 0; try { s = W.cdFarm?.rates?.()?.spendH ?? 0; } catch {} return c + s * 100; })(),
      retailOk: null,   // set by the retail director's checkpoint sampler (ctx is mutable for directors' context())
      tick: Math.max(core.nowTick(), r?.st?.ssi?.last_user_mutation_tick ?? 0),
      reserveItems: (() => { const o = {}; for (const [n, x] of Object.entries(others?.by ?? {})) if (n !== 'corePlan') for (const [i, k] of Object.entries(x.items ?? {})) o[i] = (o[i] ?? 0) + k; return o; })(),
      now: Date.now(), premium: !!r?.st?.premium, deals: r?.deals ?? [],
      retailBoard: (() => { try { const j = lastEngine?.retailJson?.(); return typeof j === 'string' ? JSON.parse(j) : j ?? null; } catch { return null; } })(),
      mem: memOf, live: running && !cfg.dryRun, dryRun: cfg.dryRun, pauseSent: Object.fromEntries(pauseSent),
      mods: { cdFarm: W.cdFarm ?? null, labRunner: W.labRunner ?? null, autoSell: W.autoSell ?? null, autoUtil: W.autoUtil ?? null, earlyGame: W.earlyGame ?? null },
    };
  }

  const ledgerNote = (kind, text) => core.ledger.add(TAG, kind, text);
  let running = false, stepping = false, loopTimer = 0, last = null, fails = 0, lastSig = '', lastWait = '', lastWouldAt = {}, stopReason = '';
  const holds = new Set();

  async function sendStep(st) {
    const r = read(true);
    if (!r || !r.wsOpen) return 'down';
    await pacer?.beforeCommand?.();
    const d0 = core.markSend(r.mutTick);
    r.ws.send(JSON.stringify(st.msg));
    const ok = await core.waitConfirm({ read, d0, timeoutMs: cfg.confirmMs, pred: (x) => st.until(x.v), closed: () => { throw new Error('socket closed while waiting'); } });
    pacer?.noteConfirm?.({ ok: !!ok, rtt: core.lastRtt() });
    return !!ok;
  }
  async function perform(a) {
    if (a.run) {
      const ok = await a.run();
      if (ok === true) ledgerNote('action', a.text);
      else if (ok === false) ledgerNote('fail', 'did not work: ' + a.text + ' (' + (fails + 1) + '/' + cfg.maxFails + ')');
      return ok;
    }
    if (a.patch) {
      if (!W.earlyGame?.tune) return false;
      const rep = W.earlyGame.tune(a.patch);
      ledgerNote('action', a.text + ' (' + rep.applied.join(', ') + (rep.skipped.length ? '; skipped ' + rep.skipped.join(', ') : '') + ')');
      return true;
    }
    if (a.hold) await core.reserves.holdAll('corePlan', 'corePlan');
    try {
      for (const st of a.steps) {
        if (st.msg?.type === 'SetPaused' && st.msg.paused) pauseSent.set(st.msg.group, Date.now());
        const ok = await sendStep(st);
        if (ok === 'down') return null;           // nothing was sent
        if (!ok) { ledgerNote('fail', 'not confirmed: ' + a.text + ' (' + (fails + 1) + '/' + cfg.maxFails + ')'); return false; }
      }
      ledgerNote('action', a.text);
      return true;
    } finally { if (a.hold) core.reserves.releaseAll('corePlan', 'corePlan'); }
  }

  const sigOf = (d) => [d.stage, ...d.S.map((c) => c.ok), ...d.E.map((c) => c.ok)].join('|');
  function report(d) {
    const sig = sigOf(d);
    if (sig === lastSig) return;
    lastSig = sig;
    ledgerNote('info', 'stage ' + (d.stage ?? '-') + ' | ' + d.S.map((c) => c.id + (c.ok === null ? '?' : c.ok ? '+' : '-')).join(' ') + ' | ' + d.E.map((c) => c.id + (c.ok ? '+' : '-')).join(' '));
  }

  async function step() {
    if (stepping || unloaded) return;
    stepping = true;
    try {
      const r = read(true);
      if (!r) { last = { waits: ['waiting for the game'] }; return; }
      trackCash(r.v);
      const d = decide(r.v, context(r));
      last = d; report(d);
      if (running && !cfg.dryRun) heartbeat();
      if (holds.size || !running) return;
      const a = d.actions[0];
      if (!a) { const w = d.waits.join(' | '), key = w.replace(/[\d,.$]+/g, '#'); if (key !== lastWait) { lastWait = key; ledgerNote('info', 'waiting: ' + w); } return; }   // amounts move every step: log a wait once per reason
      if (cfg.dryRun) { const t = Date.now(); if (!(lastWouldAt[a.id] > t - 60000)) { lastWouldAt[a.id] = t; ledgerNote('info', 'dry run, would: ' + a.text); } return; }
      const ok = await perform(a);
      if (ok === true) fails = 0;
      else if (ok === false && ++fails >= cfg.maxFails) { stopReason = 'the server did not apply ' + cfg.maxFails + ' actions in a row'; ledgerNote('fail', 'stopped: ' + stopReason); core.notify('CP', 'Core plan stopped', stopReason); stop(); }
    } catch (e) {
      ledgerNote('fail', 'error: ' + (e.message ?? e));
      if (/socket closed/.test(e.message ?? '')) return;
    } finally { stepping = false; }
  }

// continues the core-plan closure from core-plan-3.js (same try / IIFE)
  // ---- lifecycle -------------------------------------------------------------------------------------------------------------------------
  const heartbeat = () => { try { sstore?.setItem(LIVE_KEY, JSON.stringify({ t: Date.now() })); } catch {} ; takeLock(); };
  const clearLive = () => { try { sstore?.removeItem(LIVE_KEY); } catch {} };
  const lockOwner = () => { try { const l = JSON.parse(store?.getItem(LOCK_KEY) || 'null'); return l && Date.now() - l.t < 15000 ? l.tab : null; } catch { return null; } };
  const takeLock = () => { try { store?.setItem(LOCK_KEY, JSON.stringify({ tab: TAB, t: Date.now() })); } catch {} };
  const dropLock = () => { try { if (lockOwner() === TAB) store?.removeItem(LOCK_KEY); } catch {} };

  function start(o = {}) {
    if (running && !(o.dryRun === false && cfg.dryRun)) return status();   // already running; a dry run may still be taken live
    const dry = o.dryRun !== undefined ? !!o.dryRun : cfg.dryRun;
    if (!dry) {
      const owner = lockOwner();
      if (owner && owner !== TAB) { ledgerNote('fail', 'Live refused: another tab is running Core plan'); return status(); }
      const r = read(true);
      if (r) { const miss = core.missingFields(r.st, ['groups', 'stock', 'ssi', 'items']); const bad = []; if (miss.length) bad.push('state is missing ' + miss.join(', ')); for (const n of [...UNLOCKS, 'Farm']) if (r.v.idB(n) == null) bad.push('no building named ' + n); if (bad.length) { cfg.dryRun = true; ledgerNote('fail', 'Live refused: the game data no longer looks right (' + bad.join('; ') + ')'); running = true; ensureLoop(); return status(); } }
    }
    if (!running) cash.length = 0;   // samples from before a stop span the gap
    cfg.dryRun = dry; running = true; stopReason = ''; fails = 0; lastSig = ''; lastWait = '';
    ledgerNote('info', 'started' + (dry ? ' (dry run)' : ' LIVE'));
    if (!dry) heartbeat();
    ensureLoop(); step();
    return status();
  }
  function stop() {
    if (!running) return status();
    running = false; clearInterval(loopTimer); loopTimer = 0; clearLive(); dropLock(); cancelResume();
    ledgerNote('info', 'stopped');
    return status();
  }
  function ensureLoop() { if (!loopTimer) loopTimer = setInterval(() => { step(); }, cfg.intervalMs); }
  async function hold(who) { holds.add(who); while (stepping) await core.sleep(25); }
  function release(who) { holds.delete(who); }

  // After a page reload Live resumes by itself, after a countdown the user can cancel (stop(), cancelResume() or Alt+Shift+X).
  let resumeTimer = 0, resumeLeft = 0;
  function cancelResume() { if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = 0; resumeLeft = 0; } }
  function scheduleResume() {
    resumeLeft = cfg.resumeSeconds;
    ledgerNote('info', 'resuming Live after the reload in ' + resumeLeft + ' s (corePlan.cancelResume() or Alt+Shift+X cancels; it then runs as a dry run)');
    resumeTimer = setInterval(() => {
      if (unloaded) return cancelResume();
      if (--resumeLeft > 0) return;
      cancelResume(); start({ dryRun: false });
    }, 1000);
  }

  function duties() {
    return [
      { duty: 'engine items kept off the shelf (neverSell, CD booster)', owner: 'Core plan', done: true },
      { duty: 'unlocks: Assembly Plant, Retail Store, Oil Rig', owner: 'Core plan', done: true },
      { duty: 'Stage A-B land and Cotton Farms', owner: 'Core plan', done: true },
      ...directors.flatMap((d) => { try { return d.duties?.() ?? []; } catch { return []; } }),
    ];
  }
  function status() {
    const d = last;
    return {
      running, live: running && !cfg.dryRun, dryRun: cfg.dryRun, stage: d?.stage ?? null, stopReason,
      start: d?.S?.map((c) => c.id + ' ' + (c.ok === null ? '?' : c.ok ? 'ok' : 'NO') + ': ' + c.why) ?? [],
      end: d?.E?.map((c) => c.id + ' ' + (c.ok ? 'ok' : 'NO') + ': ' + c.why) ?? [],
      next: d?.actions?.[0]?.text ?? null, waits: d?.waits ?? [], readouts: d?.readouts ?? {},
      land: d?.rule ? { lastAcre: d.rule.lastAcre, acresToBuy: d.rule.acresToBuy, landCost: Math.round(d.rule.landCost), tWallHours: +d.rule.tWall.toFixed(1), tWallFrom: d.rule.tWallFrom, income: Math.round(d.rule.income) } : null,
      holds: [...holds],
    };
  }

  // ---- settings -----------------------------------------------------------------------------------------------------------------------------
  function apply(o) {
    const applied = [], skipped = [];
    for (const [k, v] of Object.entries(o ?? {})) {
      const ok = k in DEFAULTS && !SESSION_ONLY.includes(k) && typeof v === typeof DEFAULTS[k] && !(typeof v === 'number' && !Number.isFinite(v))
        && !(typeof v === 'number' && v < 0);
      if (ok) { cfg[k] = v; applied.push(k); } else skipped.push(k);
    }
    return { applied, skipped };
  }
  const save = () => { try { store?.setItem(KEY, JSON.stringify({ cfg: Object.fromEntries(Object.entries(cfg).filter(([k]) => !SESSION_ONLY.includes(k))) })); } catch {} };
  function restore() { try { const o = JSON.parse(store?.getItem(KEY) || 'null'); if (o?.cfg) apply(o.cfg); } catch {} }

  // What CD Farm and the other spenders see: the next unlock and the Iron Frames kept for the prototypes. Null while not running.
  core.reserves.register('corePlan', {
    reserve: () => {
      if (!running || !last?.stage) return null;
      // A director may set out.cdNeed: an object { b, name, cd, prereqsMet, note } replaces the next unlock as the CD need, false = no CD need now.
      const v = last.cdNeed === false ? null : (last.cdNeed ?? last.nextUnlock), ifId = last._ifId;
      // Before the store: Iron Frames for the prototypes. Once it is built: every Wooden Frame and Plank, so CD Farm's planner never
      // burns them on Mines / Quarries (wiki 11.4, the $294-per-CD mistake).
      const items = {};
      // Retail fail path (plan A2): Wooden Frames only down to their keep line and Planks free, so CD Farm cycles the frames above it.
      if (last.stage === 'D' || last.stage === 'END') {
        if (last._failPath) { if (last._wfId != null) items[last._wfId] = last._wfKeep ?? Infinity; }
        else for (const id of [last._wfId, last._plId]) if (id != null) items[id] = Infinity;
      }
      else if (ifId != null) { const k = Math.min(cfg.ifReserve, last._ifNeed ?? Infinity); if (k > 0) items[ifId] = k; }
      return { moneyFloor: 0, items, nextTech: v ? { b: v.b, name: v.name, cd: v.cd, prereqsMet: v.prereqsMet, note: v.note } : null, phase: null };
    },
    busy: () => running && !cfg.dryRun,
    hold: (w) => hold(w), release: (w) => release(w),
  });

  W.corePlan = {
    cfg, DEFAULTS,
    get running() { return running; }, get busy() { return running && !cfg.dryRun; }, get active() { return stepping; },
    status, plan: () => last, start, stop, addDirector, ENGINE_ITEMS, directors: () => directors.map((d) => d.name), _usd: usd, _acrePriceCents: acrePriceCents, _billNeed: billNeed, _buySteps: buySteps, _floorObj: floorObj, _floorAction: floorAction, hold, release, duties, cancelResume,
    importCfg(o) { const r = apply(o?.cfg ?? o); save(); return r; },
    exportCfg() { return { cfg: Object.fromEntries(Object.entries(cfg).filter(([k]) => !SESSION_ONLY.includes(k))) }; },
    resetCfg() { Object.assign(cfg, DEFAULTS); save(); },
    _ifNeed: ifNeed, _view: view, _decide: decide, _step: step, _names: names, _startConditions: startConditions, _endConditions: endConditions, _nextUnlock: nextUnlock, _trackCash: trackCash, _cashTrend60: cashTrend60, _setPacer(p) { pacer = p; },
    _unload() { unloaded = true; running = false; clearInterval(loopTimer); cancelResume(); loopTimer = 0; core.reserves?.unregister('corePlan'); dropLock(); },
  };

  restore();
  try { const f = JSON.parse(sstore?.getItem(LIVE_KEY) || 'null'); if (cfg.liveResume && f && Date.now() - f.t < 10 * 60000) { start({ dryRun: true }); cfg.dryRun = true; scheduleResume(); } } catch {}
  console.log('[corePlan] ready: corePlan.status() reads the stage and conditions; corePlan.start() is a dry run, corePlan.start({ dryRun: false }) goes live');
})();
} catch (e) { console.error('[IdleCorp] Core plan failed to load:', e); }
// @@END core-plan
// ============================================================================
// CORE PLAN DIRECTOR: 5. Engine build-out and Farm conversion
// ============================================================================
// Director "buildout" (wiki/guides/core-game-plan.md 4.2-4.5, 4.8, 8.1, 11.2-11.3, 14 R8). One message (or one purchase) per step:
//   - pool tidy: own Camps / Sawmills / Workshops left in the pool go into their group (never cdFarm's units), named groups get their recipe;
//   - Kiln stock gate: unpause / switch the Kiln until Glass and Concrete reach their gates, pause again after;
//   - Wooden Frame gate: pause Frame Timber at the WF keep line (Rivet use for cfg.ftKeepHours), resume below half (plan D-3);
//   - Stage B-D: spare Frame Timber Workshops switch to furniture (split from the retail board), keeping 1 on Frame Timber;
//   - Stage C-D: Farms go in 4 waves 3 h apart (UnassignBuildings + DemolishBuilding), only when the last wave's acres are built and running;
//   - build-out toward core-math landRule: a consumer only when its supplier covers it, each buy gated by acre, kit, wood (R8), bill floor
//     and the money floor; Stage C-D buys the acre too while the land rule is open, Stage B while (acre + $1,200) / $1,444 <= 20 h (plan D-1).
//   - Stage B-D: furniture Workshops follow the board: a recipe 1+ Workshops over / under the split for cfg.rebalanceHours moves one (plan D3);
//   - Stage D after a checkpoint pass (never on the fail path): cfg.benchWorkshops Bench Workshop(s), the 4th shelf, on the Rivet x3 floor, once
//     Concrete covers the Kiln gate + 48 h of Bench use; while a Bench group exists the Kiln gate's Concrete target rises by that use (plan D4).
// Pure helpers for tests: corePlan._buildout.furnitureSplit / nextBuildStep / waveState / waveStep; wfKeep is the keep line Core plan's reserve uses.
// nextBuildStep's saving (a bill / money floor wait) makes the Stage B land director wait too; pendingInvest feeds Core plan's E5.
// @@MODULE cp-buildout
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const cp = W.corePlan, cfg = cp.cfg, usd = cp._usd;
  const REGION = 0, ACRE_CAP = 360;
  const FURN = [['bookshelf', 'Bookshelf', 'Make Bookshelf'], ['table', 'Table', 'Make Table'], ['chair', 'Chair', 'Make Chair']];
  const MIX = { bookshelf: 0.4, table: 0.3, chair: 0.3 };     // plank shares when the board has no appetite (wiki 4.3)
  const FLOOR = { 'Lumber Camp': 3, Sawmill: 2, Workshop: 5 }; // floor rate the plan assumes (wiki 4.5)
  const ENGINE = ['Lumber Camp', 'Sawmill', 'Workshop'];
  const HOUR = 3600000;
  const BENCH_FLOOR = 3, BENCH_HOURS = 48;                    // Make Bench on the Rivet x3 floor; Concrete kept for this many hours of Bench use (plan D4)
  const BLOCK_SHARE = 1200, BLOCK_HOURLY = 1444;               // dollars: a block's buildings per acre, and what an engine acre earns an hour (plan D-1)

  const DEFAULTS = {
    keepFrameTimber: 1,          // Workshops kept on Frame Timber (wiki 4.8 step 1)
    needFurnitureFloor: true,    // furniture Workshops wait until the recipe has a saved floor (wiki 4.8 pre-condition)
    applyFurnitureFloor: true,   // ...and Core plan applies the Workshop v1 floor itself (EditLayout); Autopilot keeps recipes already running while it sends live
    floorRetryMin: 10,           // after an EditLayout the server did not apply, floors wait this long (one bad floor cannot run into maxFails)
    conversionWaves: 4,          // Farm conversion waves (wiki 4.8 step 5)
    waveGapHours: 3,
    waveSlackAcres: 4,           // a wave waits while more than buffer + this many acres are still empty
    waveCashAhead: 3,            // a wave waits until cash covers this many of the buildings that replace its Farms
    woodRunsPerSawmill: 2,       // R8: Wood stock >= Sawmills x this x Wood per run before more Sawmills
    glassGate: 100,              // Kiln: Glass before the store research ends (wiki 4.8 step 6)
    concreteGate: 400,           // Kiln: Concrete by the gate
    ftKeepHours: 2,              // Wooden Frame keep line: this many hours of Rivet use (plan D-3); Frame Timber pauses at it, resumes below half
    ftKeepMax: 19,               // ... capped here, so stock settles under 20 and E3 can hold (a Rivet Workshop takes 6 per wave start)
    rebalanceHours: 6,           // a furniture recipe's gap to the board's split must hold this long before a Workshop moves (plan D3)
    benchWorkshops: 1,           // Bench Workshops in Stage D after a checkpoint pass (wiki 4.7 step 2)
  };

  // ---- small pure helpers ------------------------------------------------------------------------------------------------------
  const runsH = (r, rate) => (r ? rate * 3600 / (r.ticks / 2) : 0);           // runs per hour per building (2 ticks a second)
  const recipeOf = (C, name) => Object.values(C.recipes).find((r) => r.name === name) ?? null;
  const itemOf = (C, name) => Object.values(C.items).find((i) => i.name === name) ?? null;
  const amt = (list, item) => (list ?? []).filter((x) => x.item === item).reduce((a, x) => a + x.amount, 0);

  // Largest-remainder rounding of fractional counts to n whole Workshops.
  function allocate(frac, n) {
    const keys = Object.keys(frac), sum = keys.reduce((a, k) => a + frac[k], 0);
    const out = {};
    if (!(sum > 0) || n <= 0) { for (const k of keys) out[k] = 0; return out; }
    const raw = keys.map((k) => ({ k, x: frac[k] * n / sum }));
    for (const r of raw) out[r.k] = Math.floor(r.x);
    let left = n - raw.reduce((a, r) => a + out[r.k], 0);
    for (const r of [...raw].sort((a, b) => (b.x - Math.floor(b.x)) - (a.x - Math.floor(a.x)) || b.x - a.x)) { if (left <= 0) break; out[r.k]++; left--; }
    return out;
  }

  // Bookshelf / Table / Chair Workshops for planksH planks per hour, sized by retail appetite in Heartland (wiki 4.7 step 3).
  // Plank share of an item = appetite x planks per unit; Workshops = that share / planks one Workshop eats at the v1 floor.
  function furnitureSplit(board, planksH, catalog) {
    const C = catalog?.byId ? catalog : cp._names(catalog).C;
    const shelf = board?.shelves?.[REGION] ?? board?.shelves?.[String(REGION)] ?? null;
    const rows = FURN.map(([k, item, rec]) => {
      const r = recipeOf(C, rec), it = itemOf(C, item);
      if (!r || !it) throw new Error('furnitureSplit: ' + rec + ' / ' + item + ' not in the catalog');
      const ppu = amt(r.inputs, itemOf(C, 'Planks')?.id) / (r.outputs[0]?.amount || 1);
      const unitsH = (r.outputs[0]?.amount ?? 1) * runsH(r, FLOOR.Workshop);
      return { k, appetite: Math.max(0, +(shelf?.[it.id]?.appetite ?? 0) || 0), ppu, planksPerWs: unitsH * ppu };
    });
    const fromBoard = rows.some((r) => r.appetite > 0);
    const w = Object.fromEntries(rows.map((r) => [r.k, fromBoard ? r.appetite * r.ppu : MIX[r.k]]));
    const ws = Object.values(w).reduce((a, x) => a + x, 0);
    const shares = Object.fromEntries(rows.map((r) => [r.k, w[r.k] / ws]));
    const frac = Object.fromEntries(rows.map((r) => [r.k, Math.max(0, planksH || 0) * shares[r.k] / r.planksPerWs]));
    const total = Math.round(Object.values(frac).reduce((a, x) => a + x, 0));   // capped by planks: no Workshop past what planks feed
    const counts = allocate(frac, total);
    const perWs = Object.fromEntries(rows.map((r) => [r.k, r.planksPerWs]));
    // Workshops per item for any total n (the Stage B switch has a fixed number of spare Workshops).
    const unitFrac = Object.fromEntries(rows.map((r) => [r.k, shares[r.k] / r.planksPerWs]));
    return { source: fromBoard ? 'board' : 'default 40/30/30', shares, frac, ...counts, total, planksPerWs: perWs, alloc: (n) => allocate(unitFrac, n) };
  }

  // ---- reading the engine from a view ---------------------------------------------------------------------------------------------
  function engine(v, ctx) {
    const N = v.N, C = v.C, st = v.st;
    const id = { camp: v.idB('Lumber Camp'), saw: v.idB('Sawmill'), ws: v.idB('Workshop'), farm: v.idB('Farm'), kiln: v.idB('Kiln') };
    const rec = (n) => recipeOf(C, n);
    const R = { wood: rec('Fell Wood'), planks: rec('Saw Planks'), ft: rec('Frame Timber'), rivet: rec('Rivet Iron Frame'), cotton: rec('Grow Cotton'),
      glass: rec('Blow Glass'), concrete: rec('Mix Concrete'), bookshelf: rec('Make Bookshelf'), table: rec('Make Table'), chair: rec('Make Chair') };
    const missing = [...Object.entries(id).filter(([, x]) => x == null).map(([k]) => 'building ' + k), ...Object.entries(R).filter(([, x]) => !x).map(([k]) => 'recipe ' + k)];
    if (missing.length) return { missing };
    const units = ctx.boFarmUnits ?? {};
    const ownPool = (b) => Math.max(0, (v.pool[b] ?? 0) - (units[b] ?? 0));
    const layout = (r) => st.layouts?.[r.id] ?? null;
    const rateNow = (r) => layout(r)?.fx?.rate ?? 1;                         // what it runs at today (default floor = 1)
    const ratePlan = (r, b) => Math.max(rateNow(r), FLOOR[b] ?? 1);          // what it will eat once the floor is applied
    const planksId = v.idI('Planks'), woodId = v.idI('Wood');
    const groupsOf = (b, r) => v.groups.filter((g) => g.building === b && (r === undefined || g.recipe === (r?.id ?? r)));
    const sum = (gs) => gs.reduce((a, g) => a + g.count, 0);
    const furnKeys = FURN.map(([k]) => k);
    const wsGroups = groupsOf(id.ws);
    const furnNow = Object.fromEntries(furnKeys.map((k) => [k, sum(wsGroups.filter((g) => g.recipe === R[k].id))]));
    const ftNow = sum(wsGroups.filter((g) => g.recipe === R.ft.id));
    const planksPerSaw = (R.planks.outputs[0]?.amount ?? 1) * runsH(R.planks, rateNow(R.planks));
    const woodPerSaw = amt(R.planks.inputs, woodId) * runsH(R.planks, ratePlan(R.planks, 'Sawmill'));
    const woodPerCamp = (R.wood.outputs[0]?.amount ?? 1) * runsH(R.wood, rateNow(R.wood));
    const wsPlanksH = (r) => amt(r.inputs, planksId) * runsH(r, ratePlan(r, 'Workshop'));
    const live = (g) => !g.paused && g.count > 0;
    const ftHeld = new Set(ctx.mem?.('buildout')?.get?.()?.ftMine ?? []);   // Frame Timber the WF gate paused comes back: its planks stay spoken for
    const planksSupply = sum(groupsOf(id.saw, R.planks).filter(live)) * planksPerSaw;
    // Each group at the floor it really runs (Make Bench x3, not furniture's x5); one with no floor yet at the floor it will get.
    const runPlanksH = (r) => (layout(r) ? amt(r.inputs, planksId) * runsH(r, rateNow(r)) : wsPlanksH(r));
    const planksDemand = wsGroups.filter((g) => live(g) || (ftHeld.has(g.id) && g.count > 0)).reduce((a, g) => a + g.count * (C.recipes[g.recipe] ? runPlanksH(C.recipes[g.recipe]) : 0), 0);
    const woodSupply = sum(groupsOf(id.camp, R.wood).filter(live)) * woodPerCamp;
    const woodDemand = sum(groupsOf(id.saw, R.planks).filter(live)) * woodPerSaw;
    const kitOf = (b, r) => [...(v.bld(b).build_items ?? []), ...((r && layout(r)?.bom) ?? v.bld(b).default_kit ?? [])];
    // Make Bench is optional (no Bench in the catalog: no Bench Workshop); it runs on the Rivet x3 floor, not v1's x5.
    R.bench = rec('Make Bench');
    const benchNow = R.bench ? sum(wsGroups.filter((g) => g.recipe === R.bench.id)) : 0;
    const benchRuns = R.bench ? runsH(R.bench, Math.max(rateNow(R.bench), BENCH_FLOOR)) : 0;
    const benchConcreteH = (n) => n * benchRuns * (R.bench ? amt(R.bench.inputs, v.idI('Concrete')) : 0);
    const benchPlanksH = R.bench ? benchRuns * amt(R.bench.inputs, planksId) : 0;
    return { id, R, ownPool, benchNow, benchConcreteH, benchPlanksH, layout, rateNow, groupsOf, sum, furnNow, ftNow, wsGroups, planksPerSaw, woodPerSaw, woodPerCamp, wsPlanksH,
      planksSupply, planksDemand, woodSupply, woodDemand, kitOf, woodId, planksId,
      camps: v.owned('Lumber Camp'), saws: v.owned('Sawmill'), workshops: v.owned('Workshop'), farms: v.owned('Farm') };
  }
  const short = (v, list, n = 1) => {   // what is missing from stock for n x list
    const need = {};
    for (const x of list) need[x.item] = (need[x.item] ?? 0) + x.amount * n;
    const st = v.st.stock?.[REGION] ?? {}, items = v.st.items ?? {};
    return Object.entries(need).filter(([i, a]) => (st[i] ?? items[i] ?? 0) < a).map(([i, a]) => Math.ceil(a - (st[i] ?? items[i] ?? 0)) + ' ' + (v.C.items[i]?.name ?? 'item ' + i));
  };

  // A measured retail fail: per good, the keep the fail path cuts to (ceil of its capBy, as cp-retail failAction), so buildout never adds
  // above it and the two never undo each other. Goods not on the measured shelf keep `want`.
  function failKeep(ctx, want) {
    const by = ctx.retailFail ? ctx.retail?.capDecision?.capBy : null;
    return by ? Object.fromEntries(FURN.map(([k, n]) => [k, n in by ? Math.min(want[k], Math.ceil(by[n] - 1e-9)) : want[k]])) : want;
  }
  // Bench (wiki 4.7 step 2): Stage D, the checkpoint passed, not on the retail fail path (its per-good caps rule then).
  const benchWanted = (v, ctx, e) => !!e.R.bench && v.owned('Retail Store') >= 1 && ctx.retailOk === true && !ctx.retailFail && !ctx.retailFailPath;
  // Why the wanted Bench Workshop cannot be placed yet (its floor, Concrete for the gate + 48 h of its use, planks), or null.
  function benchHeld(v, e, tg) {
    const r = e.R.bench, need = cfg.concreteGate + Math.ceil(e.benchConcreteH(tg.bench) * BENCH_HOURS);
    if (floorMissing(e, r)) return 'waits for the Rivet x3 floor';
    if (v.has('Concrete') < need) return 'Concrete ' + Math.floor(v.has('Concrete')) + ' < ' + need + ' (gate ' + cfg.concreteGate + ' + 48 h of Bench use)';
    if (e.planksSupply < e.planksDemand + e.benchPlanksH) return 'planks ' + Math.round(e.planksSupply) + '/h cannot feed ' + Math.round(e.planksDemand + e.benchPlanksH) + '/h';
    return null;
  }
  // Targets: Camps / Sawmills from the land rule, Workshops from the furniture split of the rule's planks, capped by ctx.retailCap.
  function targets(v, ctx, rule, e) {
    const split = furnitureSplit(ctx.retailBoard, rule.planksH, v.C);
    const furn = { bookshelf: split.bookshelf, table: split.table, chair: split.chair };
    let ft = cfg.keepFrameTimber;
    const kept = failKeep(ctx, furn);
    if (kept !== furn || (typeof ctx.retailCap === 'number' && split.total > ctx.retailCap)) {
      // Over the retail cap: the per-good keep on a measured fail, else the board's mix inside the cap; the planks left over go to Frame Timber.
      const capped = kept !== furn ? kept : split.alloc(Math.max(0, Math.floor(ctx.retailCap)));
      const extra = Object.keys(furn).reduce((a, k) => a + (furn[k] - capped[k]) * split.planksPerWs[k], 0);
      Object.assign(furn, capped);
      ft += Math.ceil(extra / e.wsPlanksH(e.R.ft) - 1e-9);
    }
    const rivet = Math.max(1, e.sum(e.groupsOf(e.id.ws, e.R.rivet)));
    const bench = benchWanted(v, ctx, e) ? Math.max(0, cfg.benchWorkshops) : 0;
    // A wanted Bench eats planks at its Rivet x3 rate on top of the rule's: Camps / Sawmills for them, sized as core-math sizes the rule's (the rule is unchanged).
    let camps = rule.camps, sawmills = rule.sawmills;
    if (bench > 0) {
      const m = W.idleCore.coreMath.engineModel(v.C), p = Math.max(0, rule.planksH || 0), q = p + bench * e.benchPlanksH;
      camps += Math.ceil(q * m.woodPerPlank / m.campWoodH) - Math.ceil(p * m.woodPerPlank / m.campWoodH);
      sawmills += Math.ceil(q / m.smPlanksH) - Math.ceil(p / m.smPlanksH);
    }
    return { split, furn, ft, rivet, bench, camps, sawmills, workshops: furn.bookshelf + furn.table + furn.chair + ft + rivet + bench };
  }
  // The furniture recipe the next Workshop should run (largest gap to target), or Frame Timber when furniture is at its cap.
  function nextWorkshopRecipe(e, tg) {
    let best = null;
    for (const [k] of FURN) { const gap = tg.furn[k] - e.furnNow[k]; if (gap > 0 && (!best || gap > best.gap)) best = { k, gap }; }
    if (best) return { key: best.k, r: e.R[best.k] };
    if (e.ftNow < tg.ft) return { key: 'ft', r: e.R.ft };
    return null;
  }
  const floorMissing = (e, r) => cfg.needFurnitureFloor && (FURN.some(([k]) => e.R[k].id === r.id) || r.id === e.R.bench?.id) && !e.layout(r);

// continues the cp-buildout closure from cp-buildout-1.js (same try / IIFE)
  // ---- actions (one message, or one purchase with hold) ---------------------------------------------------------------------------
  const groupById = (x, id) => x.groups.find((g) => g.id === id);
  function assignAction(v, b, g, n, why) {
    const c0 = g.count;
    return { id: 'bo:assign:' + g.id, text: why + ': assign ' + n + ' ' + v.bld(b).name + ' to group ' + g.id + (g.name ? ' (' + g.name + ')' : ''),
      steps: [{ msg: { type: 'AssignBuildings', group: g.id, amount: n }, until: (x) => (groupById(x, g.id)?.count ?? 0) >= c0 + n }] };
  }
  function createAction(v, b, n, name, why) {
    const ids = new Set(v.groups.map((g) => g.id));
    return { id: 'bo:create:' + b + ':' + name, text: why + ': new group "' + name + '" with ' + n + ' ' + v.bld(b).name,
      steps: [{ msg: { type: 'CreateGroup', building: b, amount: n, name, region: REGION }, until: (x) => x.groups.some((g) => !ids.has(g.id) && g.building === b && g.count >= n) }] };
  }
  function recipeAction(v, g, r, why) {
    return { id: 'bo:recipe:' + g.id + ':' + r.id, text: why + ': group ' + g.id + ' (' + g.count + ' ' + v.bld(g.building).name + ') to ' + r.name,
      steps: [{ msg: { type: 'SetRecipe', group: g.id, recipe: r.id }, until: (x) => groupById(x, g.id)?.recipe === r.id }] };
  }
  function pauseAction(v, g, paused, why) {
    return { id: 'bo:pause:' + g.id + ':' + paused, text: why + ': ' + (paused ? 'pause' : 'resume') + ' group ' + g.id + ' (' + (v.C.recipes[g.recipe]?.name ?? 'no recipe') + ')',
      steps: [{ msg: { type: 'SetPaused', group: g.id, paused }, until: (x) => !!groupById(x, g.id)?.paused === paused }] };
  }
  // Group a building of type b on recipe r goes into: the biggest one on that recipe.
  // A group made by CreateGroup has no recipe until SetRecipe lands; it counts by its name, so a second Workshop joins it instead of a new group.
  const homeGroup = (e, b, r) => e.groupsOf(b, r).sort((a, c) => c.count - a.count)[0]
    ?? e.groupsOf(b).filter((g) => g.recipe == null && g.name === r.name).sort((a, c) => c.count - a.count)[0] ?? null;
  // Where a Workshop from the pool goes: a wanted Bench that is ready (as the buy path, Bench first), else the biggest furniture gap that has its floor and that the spare planks feed, else Frame Timber.
  // Same checks as the switch, so a Workshop the switch freed is never sent back to Frame Timber while the switch still wants it.
  function poolWorkshopRecipe(v, ctx, e, tg, n) {
    if (tg && tg.bench > e.benchNow && !benchHeld(v, e, tg)) return e.R.bench;
    const furnTotal = FURN.reduce((a, [k]) => a + e.furnNow[k], 0);
    const want = failKeep(ctx, tg ? tg.furn : furnitureSplit(ctx.retailBoard, 0, v.C).alloc(furnTotal + n));
    const headroom = e.planksSupply - e.planksDemand;
    const gaps = FURN.map(([k]) => ({ k, gap: want[k] - e.furnNow[k] })).filter((x) => x.gap > 0).sort((a, b) => b.gap - a.gap);
    const ok = gaps.find((x) => !floorMissing(e, e.R[x.k]) && headroom + 1e-9 >= e.wsPlanksH(e.R[x.k]));
    return ok ? e.R[ok.k] : e.R.ft;
  }

  // 1. Pool tidy: own engine buildings sitting in the pool, and engine groups without a recipe.
  function tidy(v, ctx, e, tg) {
    for (const bn of ENGINE) {
      const b = v.idB(bn);
      if (bn === 'Lumber Camp' && ctx.boCdBusy) continue;            // a CD run may be cycling Camps through the pool
      const n = e.ownPool(b);
      if (!n) continue;
      let r = bn === 'Lumber Camp' ? e.R.wood : bn === 'Sawmill' ? e.R.planks : null;
      if (bn === 'Workshop') r = poolWorkshopRecipe(v, ctx, e, tg, n);
      const g = homeGroup(e, b, r);
      const k = bn === 'Workshop' ? 1 : n;                            // Workshops one at a time: each goes where the split is shortest
      return g ? assignAction(v, b, g, k, 'pool') : createAction(v, b, k, r.name, 'pool');
    }
    for (const bn of ENGINE) {
      const b = v.idB(bn);
      const g = v.groups.find((x) => x.building === b && x.count > 0 && (x.recipe == null || !v.C.recipes[x.recipe]));
      if (!g) continue;
      const named = Object.values(v.C.recipes).find((r) => r.building === b && r.name === g.name);
      const r = named ?? (bn === 'Lumber Camp' ? e.R.wood : bn === 'Sawmill' ? e.R.planks : (tg ? nextWorkshopRecipe(e, tg)?.r : null) ?? e.R.ft);
      return recipeAction(v, g, r, 'new group');
    }
    return null;
  }

  const confirmed = (a, fn) => { const u = a.steps[0].until; a.steps[0].until = (x) => { const ok = u(x); if (ok) fn(); return ok; }; return a; };
  // 2. Kiln stock gate: Glass >= glassGate and Concrete >= concreteGate, then pause.
  // Only Kilns this director paused are resumed (ids in mem kilnMine, written when the pause is confirmed); a Kiln the user resumed after
  // that is left alone for good (kilnUser, from context()). A resume also needs the bill floor and the money floor for its draw.
  function kilnStep(v, ctx, e) {
    const kilns = e.groupsOf(e.id.kiln).filter((g) => g.count > 0);
    if (!kilns.length) return { wait: 'no Kiln group' };
    const km = ctx.mem?.('buildout')?.get?.() ?? {};
    const mine = new Set(km.kilnMine ?? []), user = new Set(km.kilnUser ?? []);
    const note = (gid, add) => () => {   // runs when the server confirms the pause / resume
      const m = ctx.mem?.('buildout'); if (!m) return;
      const s = new Set(m.get().kilnMine ?? []);
      if (add) s.add(gid); else s.delete(gid);
      m.set({ kilnMine: [...s] });
    };
    const manual = [];
    // + 48 h of Bench use while a Bench group exists, and already while one is wanted: the Kiln is the only Concrete source, so a gate
    // that stopped at concreteGate would keep the Bench's own Concrete gate from ever opening.
    const benchN = Math.max(e.benchNow, benchWanted(v, ctx, e) ? Math.max(0, cfg.benchWorkshops) : 0);
    const cGate = cfg.concreteGate + (benchN > 0 ? Math.ceil(e.benchConcreteH(benchN) * BENCH_HOURS) : 0);
    const want = { [e.R.glass.id]: v.has('Glass') < cfg.glassGate, [e.R.concrete.id]: v.has('Concrete') < cGate };
    const making = (rid) => kilns.some((g) => !g.paused && g.recipe === rid);
    for (const g of kilns) {
      if (user.has(g.id)) continue;
      const low = want[g.recipe];
      if (g.paused && low) {
        if (!mine.has(g.id)) { manual.push('manual: Kiln group ' + g.id + ' is paused (not by Core plan): resume it for ' + v.C.recipes[g.recipe].name); continue; }
        const mw = (v.bld(g.building).draws?.power ?? 0) * g.count, bill = cp._billNeed(v, mw), floor = ctx.floorCents ?? 0;
        if (v.money < floor + bill) return { wait: 'Kiln gate: resume group ' + g.id + ' waits: cash ' + usd(v.money) + ' < ' + usd(floor + bill) + ' (money floor + ' + mw + ' MW bills)' };
        return { action: confirmed(pauseAction(v, g, false, 'Kiln gate (' + v.C.recipes[g.recipe].name + ' below its gate)'), note(g.id, false)) };
      }
      if (!g.paused && low === false) {
        const other = [e.R.glass, e.R.concrete].find((r) => r.id !== g.recipe && want[r.id] && !making(r.id));
        if (other) return { action: recipeAction(v, g, other, 'Kiln gate (' + other.name + ' below its gate)') };
        return { action: confirmed(pauseAction(v, g, true, 'Kiln gate reached'), note(g.id, true)) };
      }
      if (g.paused && low === false && mine.has(g.id)) {
        const other = [e.R.glass, e.R.concrete].find((r) => want[r.id] && !making(r.id));
        if (other) return { action: recipeAction(v, g, other, 'Kiln gate (' + other.name + ' below its gate)') };
      }
    }
    return { wait: (manual.length ? manual.join('; ') + '; ' : '') + 'Glass ' + Math.floor(v.has('Glass')) + '/' + cfg.glassGate + ', Concrete ' + Math.floor(v.has('Concrete')) + '/' + cGate + (cGate > cfg.concreteGate ? ' (gate ' + cfg.concreteGate + ' + 48 h of Bench use)' : '') };
  }

  // Wooden Frame keep line (plan D-3): what the running Rivet Workshops eat in cfg.ftKeepHours, plus the frames the unlocks' prototypes and
  // first builds still need (corePlan ifNeed), at most cfg.ftKeepMax (E3: stock < 20). Buildout never buys Mines or Quarries, so their 4 frames each are not in it.
  function wfKeep(v, ctx = {}, e = engine(v, ctx)) {
    if (e.missing) return null;
    const rivetH = e.sum(e.groupsOf(e.id.ws, e.R.rivet).filter((g) => !g.paused)) * runsH(e.R.rivet, e.rateNow(e.R.rivet)) * amt(e.R.rivet.inputs, v.idI('Wooden Frame'));
    return Math.min(cfg.ftKeepMax, Math.ceil(rivetH * cfg.ftKeepHours) + cp._ifNeed(v, null, 'Wooden Frame'));
  }
  // 2b. Wooden Frame gate: pause Frame Timber at or above the keep line, resume below half of it (planks above the line are worth more as
  // furniture, wiki 11.4). Kiln-gate bookkeeping: only groups paused here come back (mem ftMine), one the user resumed is left alone
  // (ftUser, from context()). On the retail fail path after a pass CD Farm burns the frames above the line: nothing is paused, ours come
  // back. That holds only while the ladder has a CD need (ctx.ladderNeed) and CD Farm runs Auto; otherwise the gate bounds the frames.
  function ftStep(v, ctx, e) {
    const keep = wfKeep(v, ctx, e), wf = v.has('Wooden Frame');
    const km = ctx.mem?.('buildout')?.get?.() ?? {};
    const mine = new Set(km.ftMine ?? []), user = new Set(km.ftUser ?? []);
    const note = (gid, add) => () => {   // runs when the server confirms the pause / resume
      const m = ctx.mem?.('buildout'); if (!m) return;
      const s = new Set(m.get().ftMine ?? []);
      if (add) s.add(gid); else s.delete(gid);
      m.set({ ftMine: [...s] });
    };
    const line = 'Wooden Frame ' + Math.floor(wf) + ', keep line ' + keep;
    const paused = v.groups.filter((g) => mine.has(g.id) && g.paused && g.count > 0);
    // a paused group the switch or the retail fail path moved off Frame Timber comes back at once
    const cf = ctx.mods?.cdFarm?.cfg;   // CD Farm farms (the ladder's Oil Rig / Refinery need) only after a pass, with Auto on
    const burn = !!(ctx.retailFailPath && ctx.retailOk === true && ctx.ladderNeed && typeof ctx.ladderNeed === 'object' && cf?.building === 'auto' && cf.autoStart);
    const back = paused.find((g) => g.recipe !== e.R.ft.id) ?? (burn || wf < keep / 2 ? paused[0] : null);
    if (back) {
      const mw = (v.bld(back.building).draws?.power ?? 0) * back.count, bill = cp._billNeed(v, mw), floor = ctx.floorCents ?? 0;
      if (v.money < floor + bill) return { wait: 'WF gate: resume group ' + back.id + ' waits: cash ' + usd(v.money) + ' < ' + usd(floor + bill) + ' (money floor + ' + mw + ' MW bills)' };
      return { action: confirmed(pauseAction(v, back, false, 'Wooden Frame gate (' + line + ')'), note(back.id, false)) };
    }
    if (burn) return { wait: line + ' (retail fail path after a pass: CD Farm burns the frames above it)' };
    if (!(keep > 0) || wf < keep) return { wait: line };
    if (!ctx.boMemOk) return { wait: line + ': Frame Timber not paused, browser storage does not save (a pause it forgets would starve Rivet)' };
    const g = e.groupsOf(e.id.ws, e.R.ft).find((x) => !x.paused && x.count > 0 && !user.has(x.id));
    if (!g) return { wait: line };
    return { action: confirmed(pauseAction(v, g, true, 'Wooden Frame gate (' + line + ')'), note(g.id, true)) };
  }

  // 3. Spare Frame Timber Workshops to furniture (Stage B on), keeping cfg.keepFrameTimber (and the Rivet group, never touched).
  // EditLayout for each furniture recipe without a floor that something will run soon: Workshops already on it, spare Frame Timber to
  // switch, or the buy path's next Workshop. A recipe with Workshops on it: Autopilot owns the upgrade while it sends live with floor
  // upgrades on; otherwise the added parts for every building must be in stock (net of other modules' reserves), as Autopilot's
  // floorBlock asks. A recipe with none costs nothing. After an EditLayout the server did not apply, floors wait cfg.floorRetryMin.
  const pieceBom = (v, cells) => {   // parts per building: each piece's materials, null when the catalog has no floor pieces
    const pieces = v.N.pieces ?? {};
    if (!Object.keys(pieces).length) return null;
    const out = {};
    for (const c of Object.values(cells)) for (const m of pieces[c.item]?.materials ?? []) out[m.item] = (out[m.item] ?? 0) + m.amount;
    return out;
  };
  function floorStep(v, ctx, e, tg) {
    if (!cfg.applyFurnitureFloor || !cfg.needFurnitureFloor) return null;
    const nx = tg ? nextWorkshopRecipe(e, tg) : null;
    const soon = (k) => e.furnNow[k] > 0 || e.ftNow > cfg.keepFrameTimber || nx?.r?.id === e.R[k].id;
    const want = FURN.filter(([k]) => floorMissing(e, e.R[k]) && soon(k)).map(([k]) => ({ r: e.R[k], n: e.furnNow[k], design: 'workshopV1', label: 'Workshop v1 floor (x5)' }));
    // Bench, while wanted: the Rivet x3 floor goes on before its Workshop is assigned (or on Benches already running without one).
    if (e.R.bench && tg?.bench > 0 && floorMissing(e, e.R.bench)) want.push({ r: e.R.bench, n: e.benchNow, design: 'rivetX3', label: 'Rivet x3 floor' });
    if (!want.length) return null;
    const ap = ctx.mods?.earlyGame, apFloors = !!(ap && ap.busy && ap.cfg?.floorUpgrades !== false);
    const waits = [];
    for (const { r, n, design, label } of want) {
      const obj = cp._floorObj(design);
      if (!obj) { waits.push('floors: no ' + label + ' design in the core'); continue; }
      if (n > 0 && apFloors) { waits.push('floors: Autopilot applies the ' + r.name + ' floor upgrade while it runs live'); continue; }
      if (n > 0) {
        const bom = pieceBom(v, obj);
        if (!bom) { waits.push('floors: ' + r.name + ': the catalog has no floor pieces, parts for its ' + n + ' Workshop(s) cannot be checked'); continue; }
        const cur = Object.fromEntries((v.bld(e.id.ws).default_kit ?? []).map((i) => [i.item, i.amount]));
        const st = v.st.stock?.[REGION] ?? {}, items = v.st.items ?? {}, res = ctx.reserveItems ?? {};
        const lack = Object.entries(bom).map(([i, a]) => [i, Math.max(0, a - (cur[i] ?? 0)) * n - Math.max(0, (st[i] ?? items[i] ?? 0) - (res[i] ?? 0))]).filter(([, d]) => d > 0);
        if (lack.length) { waits.push('floors: ' + r.name + ' (' + n + ' Workshops) waits for parts: ' + lack.map(([i, d]) => Math.ceil(d) + ' more ' + (v.C.items[i]?.name ?? 'item ' + i)).join(', ')); continue; }
      }
      const f = cp._floorAction(ctx, 'buildout', 'floors', r, obj, 'floors: the server did not apply the last floor', { id: 'floor:' + r.id, text: 'apply the ' + label + ' to ' + r.name + (n > 0 ? ' (' + n + ' Workshops pay the added parts)' : '') });
      if (f.action) return f;
      waits.push(f.wait);
    }
    return { wait: [...new Set(waits)].join('; ') };   // the shared retry wait is the same for every floor
  }

  function switchStep(v, ctx, e, tg) {
    // Keep only the reserve here: the retail cap already limits n, and extra Frame Timber for leftover planks is the purchase path's job.
    const keep = cfg.keepFrameTimber;
    const spare = e.ftNow - keep;
    if (spare <= 0) return null;
    const split = tg?.split ?? furnitureSplit(ctx.retailBoard, 0, v.C);
    const furnTotal = FURN.reduce((a, [k]) => a + e.furnNow[k], 0);
    const cap = typeof ctx.retailCap === 'number' ? Math.max(0, Math.floor(ctx.retailCap)) : Infinity;
    const n = Math.min(furnTotal + spare, cap);
    if (n <= furnTotal) return { wait: 'switch: furniture at the retail cap (' + cap + '), spare Frame Timber stays' };
    const want = failKeep(ctx, split.alloc(n));   // a measured fail: never above the per-good keep the fail path cuts to
    const gaps = FURN.map(([k]) => ({ k, gap: want[k] - e.furnNow[k] })).filter((x) => x.gap > 0).sort((a, b) => b.gap - a.gap);
    if (!gaps.length) return null;
    // Planks cap: a switch may not push plank use past what the Sawmills make (a Bookshelf eats more than Frame Timber).
    const headroom = e.planksSupply - e.planksDemand, ftUse = e.wsPlanksH(e.R.ft);
    const fits = (k) => { const d = e.wsPlanksH(e.R[k]) - ftUse; return d <= 0 ? Infinity : Math.floor((headroom + 1e-9) / d); };
    // Skip recipes without a saved floor: the switch moves what it can now and asks for the floor of the rest.
    const noFloor = gaps.filter((x) => floorMissing(e, e.R[x.k]));
    const pickGap = gaps.find((x) => fits(x.k) > 0 && !floorMissing(e, e.R[x.k]));
    if (!pickGap && noFloor.length) return { wait: 'switch: manual: apply the v1 floor for ' + noFloor.map((x) => e.R[x.k].name).join(', ') + ' (furniture Workshops wait for it)' };
    if (!pickGap) return { wait: 'switch: planks ' + Math.round(e.planksSupply) + '/h made, ' + Math.round(e.planksDemand) + '/h used: more Sawmills before more furniture' };
    const { k } = pickGap, r = e.R[k], gap = Math.min(pickGap.gap, fits(k));
    const room = Math.min(gap, spare);
    const fts = e.groupsOf(e.id.ws, e.R.ft).filter((g) => g.count > 0).sort((a, b) => b.count - a.count);
    const whole = fts.filter((g) => g.count <= room).sort((a, b) => b.count - a.count)[0];
    const kit = (cnt) => short(v, e.kitOf(e.id.ws, r).filter((x) => !(v.bld(e.id.ws).build_items ?? []).includes(x)), cnt);
    if (whole) {
      const lack = kit(whole.count);
      if (lack.length) return { wait: 'switch: kit short for ' + whole.count + ' x ' + r.name + ': ' + lack.join(', ') };
      return { action: recipeAction(v, whole, r, 'switch spare Frame Timber to furniture (' + split.source + ')') };
    }
    const g = fts[0];
    const take = Math.min(room, g.count - (fts.length === 1 ? keep : 0));
    if (take <= 0) return null;
    const lack = kit(take);
    if (lack.length) return { wait: 'switch: kit short for ' + take + ' x ' + r.name + ': ' + lack.join(', ') };
    const c0 = g.count;
    // One action: free the Workshops and put them straight on r, so the pool tidy never has to guess the recipe the switch chose.
    const home = homeGroup(e, e.id.ws, r), ids = new Set(v.groups.map((x) => x.id));
    const place = home
      ? { msg: { type: 'AssignBuildings', group: home.id, amount: take }, until: ((h0) => (x) => (groupById(x, home.id)?.count ?? 0) >= h0 + take)(home.count) }
      : { msg: { type: 'CreateGroup', building: e.id.ws, amount: take, name: r.name, region: REGION }, until: (x) => x.groups.some((y) => !ids.has(y.id) && y.building === e.id.ws && y.count >= take) };
    return { action: { id: 'bo:split:' + g.id, text: 'switch spare Frame Timber to furniture (' + split.source + '): move ' + take + ' Workshop(s) from group ' + g.id + ' to ' + r.name + (home ? ' (group ' + home.id + ')' : ' (new group)'),
      steps: [{ msg: { type: 'UnassignBuildings', group: g.id, amount: take }, until: (x) => (groupById(x, g.id)?.count ?? 0) <= c0 - take }, place] } };
  }

  // 3b. Furniture rebalance (wiki 4.7 step 3, plan D3): today's furniture Workshops against the board's split of the same total.
  // Gap per recipe (+ under, - over); none without a board (the 40/30/30 default is no reason to move a Workshop).
  function furnGaps(v, ctx, e) {
    const split = furnitureSplit(ctx.retailBoard, 0, v.C);
    if (split.source !== 'board') return null;
    const want = split.alloc(FURN.reduce((a, [k]) => a + e.furnNow[k], 0));
    return Object.fromEntries(FURN.map(([k]) => [k, want[k] - e.furnNow[k]]));
  }
  const modCount = (g) => Object.values(g.modules ?? {}).filter((m) => (m != null && typeof m === 'object' ? m.id : m) != null).length;
  // One move per step, once an over and an under recipe have each held their gap cfg.rebalanceHours (mem rebal, written by context()):
  // UnassignBuildings 1 from the over group with the fewest modules, then into the under recipe's group. The under recipe needs its floor,
  // its kit and the plank headroom for the swap. Never on the retail fail path: its per-good caps rule then.
  function rebalanceStep(v, ctx, e) {
    const gaps = ctx.retailFail ? null : furnGaps(v, ctx, e);
    if (!gaps) return null;
    const keys = FURN.map(([k]) => k).filter((k) => gaps[k]);
    if (!keys.some((k) => gaps[k] > 0) || !keys.some((k) => gaps[k] < 0)) return null;
    const seen = ctx.mem?.('buildout')?.get?.()?.rebal ?? {}, now = ctx.now ?? Date.now(), holdMs = Math.max(0, cfg.rebalanceHours) * HOUR;
    const ready = (k) => seen[k]?.dir === (gaps[k] > 0 ? 'under' : 'over') && now - seen[k].at >= holdMs;
    const line = keys.map((k) => e.R[k].name + ' ' + (gaps[k] > 0 ? '+' : '') + gaps[k]).join(', ');
    const under = keys.filter((k) => gaps[k] > 0 && ready(k)).sort((a, b) => gaps[b] - gaps[a]);
    const over = keys.filter((k) => gaps[k] < 0 && ready(k)).sort((a, b) => gaps[a] - gaps[b]);
    if (!under.length || !over.length) return { wait: 'rebalance: ' + line + ' (moves once held ' + cfg.rebalanceHours + ' h)' };
    const headroom = e.planksSupply - e.planksDemand, why = [];
    for (const to of under) {
      const r = e.R[to];
      if (floorMissing(e, r)) { why.push(r.name + ' has no floor'); continue; }
      const lack = short(v, e.kitOf(e.id.ws, r).filter((x) => !(v.bld(e.id.ws).build_items ?? []).includes(x)));
      if (lack.length) { why.push(r.name + ' kit short: ' + lack.join(', ')); continue; }
      for (const from of over) {
        if (e.wsPlanksH(r) - e.wsPlanksH(e.R[from]) > headroom + 1e-9) { why.push('planks cannot feed ' + e.R[from].name + ' -> ' + r.name); continue; }
        const g = e.groupsOf(e.id.ws, e.R[from]).filter((x) => x.count > 0).sort((a, b) => modCount(a) - modCount(b) || b.count - a.count)[0];
        if (!g) continue;
        const c0 = g.count, home = homeGroup(e, e.id.ws, r), ids = new Set(v.groups.map((x) => x.id));
        const place = home
          ? { msg: { type: 'AssignBuildings', group: home.id, amount: 1 }, until: ((h0) => (x) => (groupById(x, home.id)?.count ?? 0) >= h0 + 1)(home.count) }
          : { msg: { type: 'CreateGroup', building: e.id.ws, amount: 1, name: r.name, region: REGION }, until: (x) => x.groups.some((y) => !ids.has(y.id) && y.building === e.id.ws) };
        return { action: { id: 'bo:rebal:' + g.id, text: 'rebalance furniture to the board (' + line + '): move 1 Workshop from group ' + g.id + ' (' + e.R[from].name + ') to ' + r.name + (home ? ' (group ' + home.id + ')' : ' (new group)'),
          steps: [{ msg: { type: 'UnassignBuildings', group: g.id, amount: 1 }, until: (x) => (groupById(x, g.id)?.count ?? 0) <= c0 - 1 }, place] } };
      }
    }
    return { wait: 'rebalance: ' + line + ' waits: ' + why.join('; ') };
  }

  // 4. Farm conversion waves. Wave memory lives in ctx.mem('buildout'): base (Farms at the first Stage C look), wave, at (ms).
  const cottonFarms = (v, e) => e.sum(e.groupsOf(e.id.farm, e.R.cotton));
  function waveState(v, ctx, e) {
    const m = ctx.mem?.('buildout')?.get?.() ?? {};
    const base = m.base ?? cottonFarms(v, e), waves = Math.max(1, cfg.conversionWaves);
    const size = Math.ceil(base / waves);
    return { base, waves, size, wave: m.wave ?? 0, at: m.at ?? null, farms: cottonFarms(v, e), targetAfter: (k) => Math.max(0, base - (k + 1) * size) };
  }
  function blocksRunning(v, ctx, e) {
    const ftHeld = new Set(ctx.mem?.('buildout')?.get?.()?.ftMine ?? []);   // paused by the WF gate on purpose
    for (const bn of ENGINE) {
      const b = v.idB(bn);
      if (e.ownPool(b) > 0) return v.bld(b).name + ' in the pool';
      const g = v.groups.find((x) => x.building === b && x.count > 0 && !ftHeld.has(x.id) && (x.paused || (x.equipped ?? x.count) < x.count));
      if (g) return 'group ' + g.id + ' (' + (g.name ?? v.bld(b).name) + ') ' + (g.paused ? 'paused' : 'equipped ' + g.equipped + '/' + g.count);
    }
    return null;
  }
  // Before a wave: the first buildings for the freed acres must pass the build gates (kit, wood, bill floor, money floor) as if the acres
  // were free now, and stock (kits) and cash must cover cfg.waveCashAhead of them (plan step 5: bill floor and
  // kit gate first). Otherwise the Farms would go with nothing to rebuild the acres.
  function waveGate(v, ctx, e, rule, stage, n) {
    const freed = n * (v.bld(e.id.farm).acres || 1);
    const s = nextBuildStep({ ...v, freeAcres: v.freeAcres + freed }, { ...ctx, _boEngine: e, _boNoCash: true }, rule, stage);
    if (!s.pick) return { wait: 'nothing can be built on the ' + freed + ' freed acres yet (' + s.wait + ')' };
    const bd = v.bld(s.b), blocks = Math.max(1, Math.floor(freed / (bd.acres || 1)));
    const ahead = Math.max(1, Math.min(blocks, cfg.waveCashAhead));
    const lack = short(v, e.kitOf(s.b, s.pick.r), ahead);
    if (lack.length) return { wait: 'kit short for ' + ahead + ' x ' + s.pick.label + ': ' + lack.join(', ') };
    let cost = 0;
    for (let i = 0; i < ahead; i++) cost += W.idleCore.planner.price(bd.cost, v.owned(s.pick.bn), i);
    const bill = cp._billNeed(v, (bd.draws?.power ?? 0) * ahead), floor = ctx.floorCents ?? 0;
    if (v.money - cost < floor + bill) return { wait: 'cash ' + usd(v.money) + ' < ' + usd(cost + floor + bill) + ' for ' + ahead + ' x ' + s.pick.label + ' + bill floor + money floor', need: cost + floor + bill };
    return { ok: true, need: cost + floor + bill };
  }
  function waveStep(v, ctx, e, tg, rule, stage) {
    const w = waveState(v, ctx, e);
    const status = 'wave ' + Math.min(w.wave, w.waves) + '/' + w.waves + ', ' + w.farms + ' cotton Farms';
    const ownFarms = e.ownPool(e.id.farm);
    if (ownFarms > 0 && !ctx.boCdBusy) {   // a wave whose demolish did not land: finish it
      const p0 = v.pool[e.id.farm] ?? 0;
      return { status, action: { id: 'bo:demolish', text: 'Farm conversion: demolish ' + ownFarms + ' Farm(s) left in the pool',
        steps: [{ msg: { type: 'DemolishBuilding', building: e.id.farm, amount: ownFarms, region: REGION }, until: (x) => (x.pool[e.id.farm] ?? 0) <= p0 - ownFarms }] } };
    }
    if (!w.farms) return { status: 'conversion done (0 cotton Farms)' };
    if (w.wave >= w.waves) return { status, wait: 'conversion: all ' + w.waves + ' waves done, ' + w.farms + ' Farms left' };
    if (ctx.retailOk === false) return { status, wait: 'retail checkpoint failed: remaining Farms stay on Cotton' };   // plan A2: any fail, measured or not; the capped engine needs no more acres
    if (ctx.retailFail) return { status, wait: 'retail fail path: Farms stay on Cotton' };   // a pass of the re-run proves only the capped output sells
    if (ctx.boCdBusy) return { status, wait: 'conversion: CD Farm is running' };
    // Fail closed: without saved wave memory every step would look like wave 1 and demolish another quarter of the Farms.
    if (!ctx.boMemOk || ctx.mem?.('buildout')?.get?.()?.base == null) return { status, wait: 'conversion: wave memory not saved (browser storage), no wave' };
    if (w.wave > 0 && w.at != null && ctx.now - w.at < cfg.waveGapHours * HOUR) return { status, wait: 'conversion: next wave in ' + ((cfg.waveGapHours * HOUR - (ctx.now - w.at)) / 60000).toFixed(0) + ' min' };
    if (w.wave > 0) {
      const busy = blocksRunning(v, ctx, e);
      if (busy) return { status, wait: 'conversion: last wave not running yet: ' + busy };
      const left = v.freeAcres - cfg.bufferAcres;
      const need = rule && (rule.need.camps || rule.need.sawmills || rule.need.workshops);
      if (need && left > cfg.waveSlackAcres) return { status, wait: 'conversion: ' + left + ' acres of the last wave not built yet' };
    }
    const g = homeGroup(e, e.id.farm, e.R.cotton);
    const n = Math.min(g.count, w.farms - w.targetAfter(w.wave));
    if (n <= 0) return { status };
    const gate = waveGate(v, ctx, e, rule, stage, n);
    if (!gate.ok) return { status, wait: 'conversion: wave ' + (w.wave + 1) + ' waits: ' + gate.wait };
    const c0 = g.count, o0 = v.owned('Farm');
    return { status, action: { id: 'bo:wave:' + w.wave, text: 'Farm conversion wave ' + (w.wave + 1) + '/' + w.waves + ': unassign and demolish ' + n + ' Farms', hold: true,
      steps: [{ msg: { type: 'UnassignBuildings', group: g.id, amount: n }, until: (x) => (groupById(x, g.id)?.count ?? 0) <= c0 - n },
        { msg: { type: 'DemolishBuilding', building: e.id.farm, amount: n, region: REGION }, until: (x) => x.owned('Farm') <= o0 - n }] } };
  }

  // 5. The next purchase: a consumer only when its supplier covers it; otherwise its supplier.
  function nextBuildStep(v, ctx, rule, stage) {
    const e = ctx._boEngine ?? engine(v, ctx);
    if (e.missing) return { wait: 'catalog lacks ' + e.missing.join(', ') };
    if (!rule) return { wait: 'land rule unavailable' };
    const tg = ctx._boTargets ?? targets(v, ctx, rule, e);
    const gap = { camp: tg.camps - e.camps, saw: tg.sawmills - e.saws };
    const nx = nextWorkshopRecipe(e, tg);
    const wsWhy = (r) => 'Workshop (' + r.name + ')';
    let pick = null, held = [], planksHolds = 0, planksNeed = 0;   // holds that only more planks would lift, and the planks/h they need
    // Bench first: one Workshop, the 4th shelf; a Bench that waits (floor, Concrete, planks) holds nothing else back.
    if (tg.bench > e.benchNow) {
      const label = 'Workshop (' + e.R.bench.name + ')', why = benchHeld(v, e, tg);
      if (why) { held.push(label + ': ' + why); if (why.startsWith('planks ')) { planksHolds++; planksNeed = Math.max(planksNeed, e.planksDemand + e.benchPlanksH); } }
      else pick = { bn: 'Workshop', r: e.R.bench, label };
    }
    if (!pick && nx && e.ftNow > tg.ft) held.push('Workshop: switch the spare Frame Timber Workshops first');
    else if (!pick && nx) {
      const extra = e.wsPlanksH(nx.r);
      const covered = e.planksSupply >= e.planksDemand + extra;
      if (floorMissing(e, nx.r)) held.push(wsWhy(nx.r) + ': manual: apply the v1 floor for ' + nx.r.name);
      else if (!covered) { held.push(wsWhy(nx.r) + ': planks ' + Math.round(e.planksSupply) + '/h cannot feed ' + Math.round(e.planksDemand + extra) + '/h'); planksHolds++; planksNeed = Math.max(planksNeed, e.planksDemand + extra); }
      else pick = { bn: 'Workshop', r: nx.r, label: wsWhy(nx.r) };
    }
    if (!pick && gap.saw > 0) {
      const woodShort = e.woodSupply < e.woodDemand + e.woodPerSaw;
      if (woodShort && gap.camp > 0) pick = { bn: 'Lumber Camp', r: e.R.wood, label: 'Lumber Camp (Wood ' + Math.round(e.woodSupply) + '/h short of Sawmills)' };
      else pick = { bn: 'Sawmill', r: e.R.planks, label: 'Sawmill' };
    }
    if (!pick && gap.camp > 0) pick = { bn: 'Lumber Camp', r: e.R.wood, label: 'Lumber Camp' };
    // Held only by planks with the Camps / Sawmills at their targets: closed when the targets at their floor rates (as the rule sizes them) cannot
    // feed it either, so E5 is not held forever. Planks short only now (paused Sawmills, a floor not on yet) stay pending.
    if (!pick && held.length && planksHolds === held.length) {
      const m = W.idleCore.coreMath.engineModel(v.C), cap = Math.min(tg.sawmills * m.smPlanksH, tg.camps * m.campWoodH / m.woodPerPlank);
      if (cap < planksNeed) return { closed: true, wait: held.join('; ') + ' (the targets, ' + tg.camps + ' Camps / ' + tg.sawmills + ' Sawmills, make ' + Math.round(cap) + '/h: closed)' };
    }
    if (!pick) return { wait: held.length ? held.join('; ') : 'build-out at target (' + e.camps + ' Camps, ' + e.saws + ' Sawmills, ' + e.workshops + ' Workshops)', done: !held.length };
    const b = v.idB(pick.bn), bd = v.bld(b);
    const why = 'next ' + pick.label;
    // Acre: keep the CD-farm buffer free; Stage C-D buys acres while the land rule is open, Stage B while the Stage A-B payback rule holds
    // for the dearest acre bought (plan D-1: a block earns more an acre than a Cotton Farm).
    // Stage B buys only the block's own acres (like the land director: the buffer is never used, nor refilled here).
    const acres = stage === 'B' ? Math.max(0, bd.acres - Math.max(0, v.freeAcres - cfg.bufferAcres)) : Math.max(0, cfg.bufferAcres + bd.acres - v.freeAcres);
    let landCents = 0;
    if (acres > 0) {
      if (stage === 'B') {
        const last = cp._acrePriceCents(v.landBought + acres - 1), pb = (last / 100 + BLOCK_SHARE) / BLOCK_HOURLY;
        if (pb > cfg.landPaybackAB) return { closed: true, wait: why + ': acre #' + (v.acresOwned + acres) + ' ' + usd(last) + ' + block ' + usd(BLOCK_SHARE * 100) + ' pays back in ' + pb.toFixed(1) + ' h > ' + cfg.landPaybackAB + ' h (Stage A-B rule closed)' };
        if (v.acresOwned + acres > ACRE_CAP) return { closed: true, wait: why + ': no free acre and Heartland is at its cap (' + ACRE_CAP + ' acres)' };
      } else {
        if (stage !== 'C' && stage !== 'D') return { wait: why + ': no free acre (stage ' + stage + ' builds on free land only, ' + v.freeAcres + ' free, buffer ' + cfg.bufferAcres + ')' };
        if (v.acresOwned + acres > Math.min(rule.lastAcre, ACRE_CAP)) return { closed: true, wait: why + ': no free acre and the land rule closes at #' + Math.min(rule.lastAcre, ACRE_CAP) };
      }
      for (let i = 0; i < acres; i++) landCents += cp._acrePriceCents(v.landBought + i);
    }
    const lack = short(v, e.kitOf(b, pick.r));
    if (lack.length) return { wait: why + ': kit short: ' + lack.join(', ') };
    if (pick.bn === 'Sawmill') {
      const need = (e.saws + 1) * cfg.woodRunsPerSawmill * amt(e.R.planks.inputs, e.woodId);
      if (v.has('Wood') < need) return { wait: why + ': wood gate: Wood ' + Math.floor(v.has('Wood')) + ' < ' + need + ' (Sawmills x ' + cfg.woodRunsPerSawmill + ' runs)' };
    }
    const price = W.idleCore.planner.price(bd.cost, v.owned(pick.bn), 0), cost = price + landCents;
    const mw = bd.draws?.power ?? 0, bill = cp._billNeed(v, mw), floor = ctx.floorCents ?? 0;
    if (ctx._boNoCash) return { pick, b, acres, cost, landCents, price, why };   // the wave gate checks cash itself, for several buildings
    if (v.money - cost < bill) return { saving: pick.label, wait: why + ': bill floor: cash ' + usd(v.money) + ' - ' + usd(cost) + ' < ' + usd(bill) + ' (' + mw + ' new MW x $20 + 2 h of bills)' };
    if (v.money - cost < floor + bill) return { saving: pick.label, wait: why + ': money floor: needs ' + usd(floor + bill + cost - v.money) + ' more above the floor ' + usd(floor) };
    return { pick, b, acres, cost, landCents, price, why };
  }
  function buyAction(v, e, s) {
    const { b, pick, acres } = s;
    const g = homeGroup(e, b, pick.r), steps = cp._buySteps(v, b, acres, g, pick.r.name);
    const text = 'build-out: buy ' + (acres ? acres + ' acre(s) #' + (v.acresOwned + 1) + ' ' + usd(s.landCents) + ' + ' : '') + pick.label + ' ' + usd(s.price) + (g ? ' into group ' + g.id : ' (new group)');
    return { id: 'bo:buy:' + pick.bn + ':' + v.owned(pick.bn), text, steps, hold: true };
  }

// continues the cp-buildout closure from cp-buildout-2.js (same try / IIFE)
  // ---- the director --------------------------------------------------------------------------------------------------------------
  const conversionStage = (v) => v.unlocked('Assembly Plant');   // Stage C or D
  const dir = {
    name: 'buildout', order: 40, defaults: DEFAULTS,
    furnitureSplit, nextBuildStep, targets: (v, ctx, rule) => targets(v, ctx, rule, engine(v, ctx)), benchHeld: (v, ctx, rule) => { const e = engine(v, ctx); return benchHeld(v, e, targets(v, ctx, rule, e)); }, rebalanceStep: (v, ctx) => rebalanceStep(v, ctx, engine(v, ctx)), waveState: (v, ctx) => waveState(v, ctx, engine(v, ctx)), allocate,
    waveStep: (v, ctx, rule, stage) => waveStep(v, ctx, engine(v, ctx), null, rule, stage), wfKeep: (v, ctx) => wfKeep(v, ctx ?? {}),
    waveGate: (v, ctx, rule, stage, n) => waveGate(v, ctx, engine(v, ctx), rule, stage, n),
    buyAction: (v, ctx, s) => buyAction(v, engine(v, ctx), s),
    // E5 (plan C5): the build-out is an investment still to make until it is at target, or its next block is past the land rule (closed).
    pendingInvest(v, ctx, rule, stage) {
      if (!rule || (stage !== 'B' && stage !== 'C' && stage !== 'D')) return [];
      const nb = nextBuildStep(v, ctx, rule, stage);
      return nb.done || nb.closed ? [] : [{ what: 'build-out (' + (nb.pick?.label ?? nb.wait) + ')', paybackH: null }];
    },
    context(v, ctx) {
      const cd = ctx.mods?.cdFarm;
      let units = {};
      try { units = cd?.farmUnits ?? {}; } catch {}
      ctx.boFarmUnits = units;
      ctx.boCdBusy = !!(cd && (cd.running || cd.active));
      if (!ctx.mem) return;
      const m = ctx.mem('buildout');
      // Storage check: write and read back through a fresh handle. Waves (which demolish Farms) need memory that survives; fail closed.
      m.set({ chk: ctx.now });
      ctx.boMemOk = ctx.mem('buildout').get().chk === ctx.now;
      // A Kiln this director paused that is running now was resumed by the user: hands off from then on.
      const kilnId = v.idB('Kiln');
      const mine = m.get().kilnMine ?? [];
      const resumed = mine.filter((id) => { const g = v.groups.find((x) => x.id === id); return !g || g.building !== kilnId || !g.paused; });
      if (resumed.length) m.set({ kilnMine: mine.filter((id) => !resumed.includes(id)), kilnUser: [...new Set([...(m.get().kilnUser ?? []), ...resumed])] });
      // Frame Timber the WF gate paused: one running again on Frame Timber was resumed by the user (hands off); one gone, emptied or
      // running on another recipe just drops out (a paused one on another recipe stays: ftStep resumes it).
      const ftR = v.idR('Frame Timber'), ftMine = m.get().ftMine ?? [], ftKeep = [], ftUser = [];
      for (const id of ftMine) { const g = v.groups.find((x) => x.id === id); if (g && g.count > 0 && g.paused) ftKeep.push(id); else if (g && g.recipe === ftR) ftUser.push(id); }
      if (ftKeep.length !== ftMine.length) m.set({ ftMine: ftKeep, ...(ftUser.length ? { ftUser: [...new Set([...(m.get().ftUser ?? []), ...ftUser])] } : {}) });
      const e = engine(v, ctx);
      if (e.missing) return;
      // Rebalance hysteresis (plan D3): per recipe, the direction of its gap to the board's split and when that was first seen.
      const gaps = furnGaps(v, ctx, e), old = m.get().rebal ?? {}, rebal = {};   // no board read: the times are kept as they are
      if (gaps) for (const [k, g] of Object.entries(gaps)) if (g) { const dir = g > 0 ? 'under' : 'over'; rebal[k] = old[k]?.dir === dir ? old[k] : { dir, at: ctx.now }; }
      if (gaps && JSON.stringify(rebal) !== JSON.stringify(old)) m.set({ rebal });
      // Wave bookkeeping from state (right under chaos, dry run and reloads): base at the first Stage C look, a wave counts once the
      // cotton Farms are at or below its target, and its time is when that is first seen.
      if (!conversionStage(v)) return;
      const farms = cottonFarms(v, e);
      if (m.get().base == null) { if (farms > 0) m.set({ base: farms, wave: 0, at: null }); return; }
      const w = waveState(v, ctx, e);
      let k = w.wave;
      while (k < w.waves && farms <= w.targetAfter(k)) k++;
      if (k > w.wave) m.set({ wave: k, at: ctx.now });
    },
    decide(v, ctx, out) {
      const stage = out.stage;
      if (stage !== 'B' && stage !== 'C' && stage !== 'D') return { wait: 'waits for stage B (now ' + (stage ?? '-') + ')' };
      const e = engine(v, ctx);
      if (e.missing) return { wait: 'off: catalog lacks ' + e.missing.join(', ') };
      const rule = out.rule;
      const tg = rule ? targets(v, ctx, rule, e) : null;
      const readout = {
        camps: e.camps + '/' + (tg?.camps ?? '?'), sawmills: e.saws + '/' + (tg?.sawmills ?? '?'), workshops: e.workshops + '/' + (tg?.workshops ?? '?'),
        furniture: tg ? FURN.map(([k, n]) => n + ' ' + e.furnNow[k] + '/' + tg.furn[k]).join(', ') + ', Frame Timber ' + e.ftNow + '/' + tg.ft + ' (' + tg.split.source + ')' : null,
        planks: Math.round(e.planksSupply) + '/h made, ' + Math.round(e.planksDemand) + '/h used',
      };
      const never = ctx.ap?.neverSell;
      if (never && ['Wood', 'Planks', 'Bookshelf', 'Table', 'Chair'].some((n) => !never.includes(v.idI(n)))) readout.selling = 'hand-off pending: Autopilot may still sell Wood, Planks or furniture';
      const waits = [];
      const done = (action, extra) => ({ action, readout: { ...readout, ...extra, next: action.text } });
      const t1 = tidy(v, ctx, e, tg);
      if (t1) return done(t1);
      const k = kilnStep(v, ctx, e);
      readout.kiln = k.wait ?? k.action?.text;
      if (k.action) return done(k.action);
      const fs = ftStep(v, ctx, e);
      readout.frames = fs.wait ?? fs.action?.text;
      if (fs.action) return done(fs.action);
      // Furniture floors first (wiki 4.5: Workshop v1 = x5, scored live): a switch or a furniture Workshop needs its recipe's floor.
      const fl = floorStep(v, ctx, e, tg);
      if (fl?.action) return done(fl.action);
      if (fl?.wait) waits.push(fl.wait);
      const sw = switchStep(v, ctx, e, tg);
      if (sw?.action) return done(sw.action);
      if (sw?.wait) waits.push(sw.wait);
      const rb = rebalanceStep(v, ctx, e);
      if (rb?.action) return done(rb.action);
      if (rb?.wait) waits.push(rb.wait);
      if (conversionStage(v)) {
        const ws = waveStep(v, ctx, e, tg, rule, stage);
        readout.waves = ws.status;
        if (ws.action) return done(ws.action);
        if (ws.wait) waits.push(ws.wait);
      } else readout.waves = 'Stage C: ' + cottonFarms(v, e) + ' cotton Farms to convert';
      const nb = nextBuildStep(v, { ...ctx, _boEngine: e, _boTargets: tg ?? undefined }, rule, stage);
      if (nb.pick) return done(buyAction(v, e, nb));
      waits.push('build-out: ' + nb.wait);
      readout.next = waits[waits.length - 1];
      return { wait: waits.join(' | '), readout };
    },
    duties: () => [
      { duty: 'Stage C-D land, engine build-out, Farm conversion', owner: 'Core plan', done: true },
      { duty: 'spare Frame Timber Workshops to furniture, Kiln Glass / Concrete gate, Wooden Frame gate', owner: 'Core plan', done: true },
    ],
  };
  cp.addDirector(dir);
  cp._buildout = dir;
})();
} catch (e) { console.error('[IdleCorp] cp-buildout failed to load:', e); }
// @@END cp-buildout
// ============================================================================
// CORE PLAN DIRECTOR: 6. Retail (wiki core-game-plan 4.7, wiki retail.md)
// ============================================================================
// Director "retail" (order 45):
//   - Pre-store gate: once the Retail Store is unlocked, every made shelf good needs cfg.stockHoursPerShelf hours of what will sell
//     in stock: min(modelled demand, measured output) per hour (sales are capped by output, wiki 4.7). Held-only goods skip the gate.
//   - Builds 1 store (BuyBuilding, then CreateGroup amount 1 "Retail"; an empty Retail group is reused), then SetAssortment with up
//     to 4 of Bookshelf, Table, Chair, Bench (made, assigned or held, best appetite x price first), only when the shelf set differs.
//     A shelved good leaves only after cfg.retailShelfDropMin minutes absent, so pauses do not churn the shelf.
//   - Money gate: floor + store price + bill floor (new MW x $20 + 2 h of bills, plan 8.1); Iron Frames keep cfg.ifReserve back.
//   - Checkpoint sampler (context): every cfg.retailSampleMin minutes after the shelves are set it records the shelf rows, the rating
//     and the stock, then judges the four rows of wiki 4.7. Sets ctx.retailOk (true / false / null), ctx.retailCap (furniture blocks the
//     measured sales can carry, on a fail), ctx.retailE1 (cfg.retailE1Hours in a row against the streak's first appetite).
//     Samples live in localStorage "corePlan.v1.mem.retail"; removing that key starts the checkpoint over.
//   - Fail path (plan step 6): furniture Workshops above the cap move to Frame Timber (SetRecipe a whole group, or Unassign and put the
//     pooled Workshops in a Frame Timber group). Farms are left on Cotton. Once the cap holds, one new checkpoint run starts at the capped
//     output (old decision kept as prevDecision, its cap in force); a pass of it sets ctx.retailOk = true (plan B3) and opens only the Oil Rig
//     gate: that pass proves the capped output sells, so the cap stays. ctx.retailFail / retailFailPath tell the other directors a measured
//     cap is in force (reserve, waves, land rule, ladder).
// @@MODULE cp-retail
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const P = W.idleCore?.planner;
  const REGION = 0, TPS = 2, TICKS_H = 3600 * TPS;
  const GOODS = ['Bookshelf', 'Table', 'Chair', 'Bench'];
  const RECIPE = { Bookshelf: 'Make Bookshelf', Table: 'Make Table', Chair: 'Make Chair', Bench: 'Make Bench' };
  const STORE = 'Retail Store', GROUP_NAME = 'Retail', WORKSHOP = 'Workshop', FT = 'Frame Timber', FT_GROUP = 'Frame Timber';
  const RATES = { power: 1000, water: 400, bandwidth: 1500 };   // cents per unit per 10-min bill (same as autoUtil billsOf)
  const Q0 = 0.952;                    // quality factor at quality 0 (wiki retail.md, Price)
  const PRICE_X = 1.52;                // retail price / base value expected at quality 0, board price 160%
  const cfg = () => W.corePlan.cfg;
  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const pct = (x) => (x * 100).toFixed(0) + '%';
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  // ---- the board ------------------------------------------------------------------------------------------------------------------
  // Asserts the shape seen on 2026-11-22 (shelves[region][itemId] = { appetite, held, standard, price }); never guesses past it.
  // Only appetite and price are required: held is just a note on the appetite row.
  function checkBoard(board, ids) {
    if (!board || typeof board !== 'object') return 'no board from engine.retailJson()';
    const rows = board.shelves?.[REGION] ?? board.shelves?.[String(REGION)];
    if (!board.shelves || typeof board.shelves !== 'object') return 'board has no "shelves"';
    if (!rows || typeof rows !== 'object') return 'board has no region ' + REGION + ' under "shelves"';
    for (const [n, id] of Object.entries(ids)) {
      const r = rows[id];
      if (!r) return 'no shelf row for ' + n + ' (item ' + id + ')';
      const miss = ['appetite', 'price'].filter((k) => !num(r[k]));
      if (miss.length) return n + ' row lacks ' + miss.join(', ');
    }
    return null;
  }
  // share = (1,000 + mine) / sum over store owners (1,000 + theirs) (wiki retail.md). ratings[region] = { corpId: rating } is assumed;
  // an empty or missing object means nobody else has a store. Anything else returns null (unknown shape, no guess).
  function shareOf(board, mine, corpId) {
    const all = board.ratings;
    if (all == null || (typeof all === 'object' && !Object.keys(all).length)) return 1;
    const rows = all[REGION] ?? all[String(REGION)];
    if (rows == null) return Object.values(all).every((x) => x && typeof x === 'object') ? 1 : null;
    if (typeof rows !== 'object' || !Object.values(rows).every(num)) return null;
    const me = 1000 + (mine ?? 0);
    const others = Object.entries(rows).filter(([k]) => String(k) !== String(corpId)).reduce((a, [, r]) => a + 1000 + r, 0);
    return me / (me + others);
  }
  function ratingOf(st) {
    const r = st.retail_ratings?.[REGION] ?? st.retail_ratings?.[String(REGION)];
    if (num(r)) return r;
    if (r && typeof r === 'object') { const x = r[st.ssi?.corp_id]; return num(x) ? x : null; }
    return null;
  }

  // ---- what the Corporation makes ---------------------------------------------------------------------------------------------------
  // Units per tick from the groups on the good's recipe: runs per wave x output / recipe ticks (the live "work" rows hold the runs).
  function output(v, recipeId) {
    const rc = v.C.recipes[recipeId];
    if (!rc) return { perTick: 0, runsPerB: null };
    const amt = (rc.outputs ?? [])[0]?.amount ?? 1;
    let perTick = 0, runs = 0, blds = 0;
    for (const g of v.groups) {
      if (g.recipe !== recipeId || g.paused || !(g.count > 0)) continue;
      const w = (g.work ?? []).filter((x) => x.recipe === recipeId);
      if (w.length) for (const x of w) { perTick += x.runs * amt * (x.outputs_pct ?? 100) / 100 / rc.ticks; runs += x.runs; blds += x.buildings ?? g.count; }
      else perTick += g.count * cfg().retailRunsPerWave * amt / rc.ticks;
    }
    return { perTick, runsPerB: blds ? runs / blds : null, amt, ticks: rc.ticks };
  }
  // Units per hour one block (1 Workshop on the recipe) makes; the measured runs per building when a group runs it.
  const perBlockH = (o) => (o.ticks ? (o.runsPerB ?? cfg().retailRunsPerWave) * o.amt * TICKS_H / o.ticks : 0);

  // ---- facts for this step ----------------------------------------------------------------------------------------------------------
  function facts(v, ctx) {
    const c = cfg();
    const storeB = v.idB(STORE);
    const ids = {}, miss = [];
    for (const n of GOODS) { const i = v.idI(n), r = v.idR(RECIPE[n]); if (i == null || r == null) miss.push(i == null ? n : RECIPE[n]); else ids[n] = i; }
    if (storeB == null) miss.push(STORE);
    if (miss.length) return { err: 'name not in the catalog: ' + miss.join(', ') + ' (director off until the names match)' };
    const badBoard = checkBoard(ctx.retailBoard, ids);
    const storeGroup = v.groups.find((g) => g.building === storeB && g.count > 0) ?? null;
    const emptyGroup = storeGroup ? null : v.groups.find((g) => g.building === storeB) ?? null;
    const f = { storeB, ids, storeGroup, emptyGroup, pooled: v.pool[storeB] ?? 0, owned: v.owned(STORE), unlocked: v.unlocked(STORE), rating: ratingOf(v.st), badBoard };
    if (badBoard) return f;
    const rows = ctx.retailBoard.shelves[REGION] ?? ctx.retailBoard.shelves[String(REGION)];
    f.share = shareOf(ctx.retailBoard, f.rating, v.st.ssi?.corp_id);
    f.goods = GOODS.map((n) => {
      const id = ids[n], rid = v.idR(RECIPE[n]), row = rows[id], base = v.C.items[id]?.base_value ?? 0, o = output(v, rid);
      return { name: n, id, rid, appetite: row.appetite, held: row.held, boardPrice: row.price, base, unit: base * row.price / 10000 * Q0,
        stock: v.has(n), outTick: o.perTick, blockH: perBlockH(o), made: o.perTick > 0,
        // a paused or retuning group still counts: it comes back, and the shelf should not churn meanwhile
        assigned: v.groups.some((g) => g.recipe === rid && g.count > 0) };
    });
    f.eligible = (g) => g.made || g.assigned || g.stock > 0;
    f.demandH = (g) => demandH(g, f.share);
    // Before the store: the shelf is what is eligible now (shelfPick() adds the keep-on-shelf rule once the store exists).
    f.chosen = pickOrder(f.goods.filter(f.eligible));
    needOf(f, c);
    return f;
  }

  // Units per hour the shelf sells: appetite per 240 ticks x this store's share.
  const demandH = (g, share) => g.appetite / 240 * (share ?? 0) * TICKS_H;
  // Hours the stock lasts: it drains by demand minus what the groups make (Infinity when output keeps up). The board's `held` is not used.
  function shelfHours(g, share) {
    const drain = demandH(g, share) - g.outTick * TICKS_H;
    return drain > 0 ? g.stock / drain : Infinity;
  }
  const pickOrder = (gs) => [...gs].sort((a, b) => b.appetite * b.unit - a.appetite * a.unit).slice(0, 4);
  // 1 h of what will sell: sales stop at output once output is below demand, so stock past an hour of output adds nothing.
  // Only made goods: a held-only good cannot grow, it just sells out.
  function needOf(f, c) {
    f.need = f.chosen.filter((g) => g.made).map((g) => ({ g, need: Math.ceil(Math.min(f.demandH(g), g.outTick * TICKS_H) * c.stockHoursPerShelf) }));
  }
  // Once the store exists: a shelved good stays while it is eligible, and for cfg.retailShelfDropMin minutes after it stops being so.
  function shelfPick(f, ctx, m) {
    if (!f.storeGroup || f.badBoard || !f.goods) return;
    const c = cfg(), shelf = f.storeGroup.assortment ?? [], now = ctx.now;
    const absent = { ...(m.get().absentSince ?? {}) };
    let changed = false;
    const keep = f.goods.filter((g) => {
      if (f.eligible(g)) { if (absent[g.id] != null) { delete absent[g.id]; changed = true; } return true; }
      if (!shelf.includes(g.id)) { if (absent[g.id] != null) { delete absent[g.id]; changed = true; } return false; }
      if (absent[g.id] == null) { absent[g.id] = now; changed = true; }
      return now - absent[g.id] < c.retailShelfDropMin * 60000;
    });
    if (changed) m.set({ absentSince: absent });
    f.chosen = pickOrder(keep);
    needOf(f, c);
  }
  // What the next bill is now, every subscription together (cents).
  function billsOf(st) {
    let t = (st.isp ?? 0) * RATES.bandwidth;
    for (const o of Object.values(st.subscriptions ?? {})) for (const [k, l] of Object.entries(o ?? {})) t += (l ?? 0) * (RATES[k] ?? 0);
    return t;
  }

  // ---- the checkpoint (wiki 4.7) -----------------------------------------------------------------------------------------------------
  // Sold between samples = modelled output - stock change; model = appetite / 240 x share, up to what was there to sell.
  function salesOver(samples, ids) {
    let sold = 0, model = 0;
    const by = {};
    for (const id of ids) by[id] = { sold: 0, model: 0, ticks: 0 };
    for (let k = 1; k < samples.length; k++) {
      const a = samples[k - 1], b = samples[k], ticks = (b.t - a.t) / 1000 * TPS;
      for (const id of ids) {
        const ga = a.g[id], gb = b.g[id];
        if (!ga || !gb) continue;
        const made = ga.out * ticks;
        const s = Math.max(0, made - (gb.s - ga.s));
        const m = Math.min(ga.a / 240 * (a.share ?? 1) * ticks, made + Math.max(0, ga.s));
        by[id].sold += s; by[id].model += m; by[id].ticks += ticks; sold += s; model += m;
      }
    }
    return { sold, model, by };
  }
  // base: appetite per item the drift is measured from (the E1 streak's first sample); default the first sample here.
  function rowsOf(samples, mem, c, now, e1 = false, base = null) {
    const s0 = samples[0], sN = samples[samples.length - 1], ids = Object.keys(s0?.g ?? {});
    const out = [];
    // 1. appetite steady within +-tol of the baseline (a fixed one, so a slow slide adds up instead of hiding in a rolling window)
    let worst = 0, worstName = '';
    for (const id of ids) {
      const a0 = base?.[id] ?? s0.g[id].a;
      for (const s of samples) { const d = a0 && s.g[id] ? Math.abs(s.g[id].a / a0 - 1) : 0; if (d > worst) { worst = d; worstName = s0.g[id].n; } }
    }
    const held0 = ids.reduce((a, id) => a + (s0.g[id].h ?? 0), 0), heldN = ids.reduce((a, id) => a + (sN.g[id]?.h ?? 0), 0);
    out.push({ id: 'appetite', ok: samples.length < 2 ? null : worst <= c.retailAppetiteTol / 100, why: 'max drift ' + pct(worst) + (worstName ? ' (' + worstName + ')' : '') + ', limit ' + c.retailAppetiteTol + '%; held ' + held0 + ' -> ' + heldN });
    // 2. sales >= pass% of the model
    // per good (wiki E1): every shelved good with a model must pass, so one dead good cannot hide behind the others; the worst is named
    const sv = salesOver(samples, ids);
    const per = ids.filter((id) => sv.by[id].model > 0).map((id) => ({ n: s0.g[id].n, ...sv.by[id], x: sv.by[id].sold / sv.by[id].model })).sort((a, b) => a.x - b.x);
    const w = per[0];
    out.push({ id: 'sales', ok: per.length ? per.every((p) => p.x >= c.retailSamplePassPct / 100) : null,
      why: (w ? 'worst ' + w.n + ' sold ' + Math.round(w.sold) + ' of model ' + Math.round(w.model) + ' (' + pct(w.x) + ')' : 'no model yet') + ', all goods ' + Math.round(sv.sold) + ' of ' + Math.round(sv.model) + ', pass ' + c.retailSamplePassPct + '%' });
    // 3. price about 1.52 x base at quality 0
    let pw = 0, pName = '';
    for (const s of samples) for (const id of ids) { const x = s.g[id]; if (!x) continue; const d = Math.abs(x.p / 10000 * Q0 / PRICE_X - 1); if (d > pw) { pw = d; pName = x.n + ' ' + (x.p / 10000 * Q0).toFixed(2) + 'x'; } }
    out.push({ id: 'price', ok: pw <= c.retailPriceTol / 100, why: 'worst ' + (pName || '-') + ' vs ' + PRICE_X + 'x base, drift ' + pct(pw) + ', limit ' + c.retailPriceTol + '%' });
    // 4. rating >= target within cfg.retailRatingMin minutes of the shelves being set (+1 per tick from 0 gives 9,000 in 75 min)
    const rated = samples.filter((s) => num(s.r));
    const dl = mem.shelvedAt + c.retailRatingMin * 60000;
    const hit = rated.find((s) => s.r >= c.retailRating && s.t <= dl + c.retailSampleMin * 60000);
    const rate = rated.length >= 2 ? (rated[rated.length - 1].r - rated[0].r) / ((rated[rated.length - 1].t - rated[0].t) / 1000 * TPS) : null;
    // E1 run (after the checkpoint): the rating stays at the target at every sample of the run, not only the last one
    const okR = !rated.length ? null : e1 ? rated.every((s) => s.r >= c.retailRating) : hit ? true : now > dl + c.retailSampleMin * 60000 ? false : null;
    out.push({ id: 'rating', ok: okR,
      why: !rated.length ? 'no rating in st.retail_ratings' : 'rating ' + rated[rated.length - 1].r + (rate != null ? ', ' + rate.toFixed(2) + ' per tick' : '') + ', needs ' + c.retailRating + ' within ' + c.retailRatingMin + ' min' + (hit ? ' (reached at ' + Math.round((hit.t - mem.shelvedAt) / 60000) + ' min)' : '') });
    return { rows: out, sales: sv };
  }
  // Blocks the measured sales can carry: per good min(sold per hour over the last hour, latest demand per hour) / block units per hour.
  function capOf(samples, blockH) {
    const lastT = samples[samples.length - 1].t;
    const win = samples.filter((s) => s.t >= lastT - 3600000);
    const w = win.length >= 2 ? win : samples.slice(-2);
    const sN = samples[samples.length - 1];
    const sv = salesOver(w, Object.keys(sN.g));
    let blocks = 0;
    const by = {};
    for (const [id, x] of Object.entries(sv.by)) {
      const soldH = x.ticks ? x.sold / x.ticks * TICKS_H : 0;
      const demandH = sN.g[id].a / 240 * (sN.share ?? 1) * TICKS_H;
      const rateH = Math.min(soldH, demandH), bh = blockH[id] || 0;
      const b = bh ? rateH / bh : 0;
      by[sN.g[id].n] = +b.toFixed(2); blocks += b;
    }
    return { cap: Math.floor(blocks), by };
  }
  // Last 3 samples within +-5% of their mean: demand found a level (saturating); else it is still falling (decaying).
  function shapeOf(samples) {
    const tot = (s) => Object.values(s.g).reduce((a, x) => a + x.a, 0);
    const last = samples.slice(-3).map(tot), mean = last.reduce((a, b) => a + b, 0) / last.length;
    return last.every((x) => Math.abs(x / mean - 1) <= 0.05) ? 'saturating' : 'decaying';
  }

  const appetites = (smp) => Object.fromEntries(Object.entries(smp.g).map(([id, x]) => [id, x.a]));
  function sampler(v, ctx, f) {
    const c = cfg(), m = ctx.mem('retail');
    let mem = m.get();
    if (!f.storeGroup) {
      // Start over only when the store is really gone: none owned in a non-empty state, for cfg.retailGoneMin minutes.
      // One bad frame (empty groups, reconnect) or a store waiting in the pool keeps the samples.
      if (f.owned > 0) { if (mem.goneSince != null) mem = m.set({ goneSince: null }); }
      else if (v.groups.length && mem.shelvedAt) {
        if (mem.goneSince == null) mem = m.set({ goneSince: ctx.now });
        else if (ctx.now - mem.goneSince >= c.retailGoneMin * 60000)
          mem = m.set({ shelvedAt: null, samples: [], decision: null, prevDecision: null, streakStart: null, e1Base: null, e1: false, goneSince: null });
      }
      return { mem, n: 0 };
    }
    if (mem.goneSince != null) mem = m.set({ goneSince: null });
    // Re-checkpoint after a fail (plan B3, D-2): once the fail path has applied the cap (nothing left for failAction), or nothing was measured,
    // a new run starts at the capped output (again after each fail). The old decision stays as prevDecision: its cap holds meanwhile and
    // the readout shows it.
    const d0 = mem.decision;
    if (d0 && !d0.ok && !f.badBoard && (!d0.measured || !failAction(v, f, d0)))
      mem = m.set({ prevDecision: d0, decision: null, shelvedAt: ctx.now, samples: [], streakStart: ctx.now, e1Base: null, e1: false });
    const shelf = f.storeGroup.assortment ?? [];
    // The clock starts when the store can sell: the first read with shelves set, not the group's creation.
    if (!mem.shelvedAt) {
      if (!shelf.length || f.badBoard) return { mem, n: 0 };
      mem = m.set({ shelvedAt: ctx.now, samples: [], decision: null, streakStart: ctx.now, e1Base: null, e1: false });
    }
    const samples = mem.samples ?? [];
    const lastT = samples.length ? samples[samples.length - 1].t : -Infinity;
    if (!f.badBoard && ctx.now - lastT >= c.retailSampleMin * 60000 && shelf.length) {
      const g = {};
      for (const x of f.goods) if (shelf.includes(x.id)) g[x.id] = { n: x.name, a: x.appetite, h: x.held, p: x.boardPrice, s: x.stock, out: x.outTick };
      samples.push({ t: ctx.now, r: f.rating, share: f.share, g });
      // enough to cover the checkpoint and a whole E1 streak
      const keep = Math.max(60, Math.ceil(c.retailE1Hours * 60 / c.retailSampleMin) + 2);
      while (samples.length > keep) samples.shift();
      mem = m.set({ samples, ...(mem.e1Base ? {} : { e1Base: appetites(samples[samples.length - 1]) }) });
    }
    const res = { mem, n: samples.length };
    if (samples.length < 1) return res;
    const ev = rowsOf(mem.decision ? samples.filter((x) => x.t >= (mem.streakStart ?? 0)) : samples, mem, c, ctx.now, !!mem.decision, mem.decision ? mem.e1Base : null);
    res.rows = ev.rows;
    const blockH = Object.fromEntries(f.goods.map((x) => [x.id, x.blockH]));
    const age = ctx.now - mem.shelvedAt;
    if (!mem.decision && age >= c.retailCheckHours * 3600000) {
      const bad = ev.rows.filter((r) => r.ok === false), open = ev.rows.filter((r) => r.ok === null);
      let d = null;
      if (!bad.length && !open.length) d = { ok: true, kind: 'pass', at: ctx.now };
      else if (bad.length || age >= c.retailMaxHours * 3600000) {
        const kind = bad.some((r) => r.id === 'appetite') ? shapeOf(samples) : bad.length ? bad.map((r) => r.id).join('+') : 'undecided';
        const cp = samples.length >= 2 ? capOf(samples, blockH) : { cap: 0, by: {} };
        // measured: the cap comes from sales, so the fail path may act on it (an undecided run has no sales figure to trust)
        d = { ok: false, kind, cap: cp.cap, capBy: cp.by, measured: samples.length >= 2 && kind !== 'undecided', at: ctx.now, why: (bad.length ? bad : open).map((r) => r.id + ': ' + r.why).join('; ') };
      }
      if (d) mem = m.set({ decision: d });
      res.mem = mem;
    }
    // E1: rows (appetite vs the streak's first appetite, sales, price; rating once reached) passing for cfg.retailE1Hours in a row.
    // A failing sample restarts the run from that sample.
    if (mem.decision) {
      const run = ev.rows.filter((r) => r.id !== 'rating' || mem.decision.ok);
      if (run.some((r) => r.ok === false)) mem = m.set({ streakStart: ctx.now, e1Base: appetites(samples[samples.length - 1]), e1: false });
      else if (ctx.now - (mem.streakStart ?? mem.shelvedAt) >= c.retailE1Hours * 3600000 && mem.decision.ok) mem = m.set({ e1: true });
      res.mem = mem;
    }
    return res;
  }

  function context(v, ctx) {
    const f = facts(v, ctx);
    ctx.retail = f;
    if (f.err) return;
    shelfPick(f, ctx, ctx.mem('retail'));
    const s = sampler(v, ctx, f);
    f.sampler = s;
    // a re-run (B3) keeps the old fail in force until it decides: retailOk false, its cap, its fail path
    const prev = s.mem.prevDecision ?? null, d = s.mem.decision ?? prev;
    f.decision = d;
    // The measured fail whose cap is in force: the decision itself, or the fail before a re-run's pass. That pass proves only that the
    // capped output sells, so it opens the Oil Rig gate (retailOk) and nothing else: cap, land rule, Farms on Cotton and the ladder waiver stay.
    const capD = d && !d.ok && d.measured ? d : d?.ok && prev && !prev.ok && prev.measured ? prev : null;   // an undecided fail has no sales figure to cap at
    f.capDecision = capD;
    ctx.retailOk = f.storeGroup ? (d ? d.ok : null) : null;
    ctx.retailCap = capD ? capD.cap : null;
    ctx.retailE1 = !!(f.storeGroup && s.mem.e1);
    ctx.retailDecided = !!d;
    // fail path (plan A2): a measured cap in force (Farms stay, engine capped, CD from Wooden Frames)
    ctx.retailFail = !!(f.storeGroup && capD);
    ctx.retailFailPath = ctx.retailFail;
  }

  // ---- what to send ----------------------------------------------------------------------------------------------------------------
  function readoutOf(f) {
    if (!f || f.err) return { error: f?.err ?? 'no facts' };
    const s = f.sampler ?? {}, d = s.mem?.decision, p = s.mem?.prevDecision, capP = d?.ok && f.capDecision === p;
    return {
      board: f.badBoard ? 'BAD: ' + f.badBoard : 'ok', share: f.share, rating: f.rating,
      shelf: (f.chosen ?? []).map((g) => g.name + ' appetite ' + g.appetite + '/2min, ' + usd(g.unit) + ', stock ' + Math.floor(g.stock) + (g.made ? ', ' + (g.outTick * TICKS_H).toFixed(1) + '/h made' : '')),
      samples: s.n ?? 0, shelvedAt: s.mem?.shelvedAt ?? null,
      rows: (s.rows ?? []).map((r) => r.id + ' ' + (r.ok === null ? '?' : r.ok ? 'pass' : 'FAIL') + ': ' + r.why),
      decision: d ? (d.ok ? (capP ? 'PASS at the capped output: Oil Rig opens; the cap of ' + p.cap + ' furniture blocks stays, Farms stay on Cotton' : 'PASS (scale to the land rule)') : 'FAIL ' + d.kind + ': cap ' + d.cap + ' furniture blocks ' + JSON.stringify(d.capBy) + ', excess Workshops to Frame Timber, Farms stay on Cotton (' + d.why + ')')
        : p ? 're-checkpoint at the capped output: sampling (the earlier FAIL holds meanwhile)' : f.storeGroup ? 'sampling' : 'store not built',
      prevDecision: p ? 'FAIL ' + p.kind + ': cap ' + p.cap + ' furniture blocks (' + p.why + ')' : null,
      e1: !!s.mem?.e1,
    };
  }
  const workshopGroups = (v, wsB) => v.groups.filter((g) => g.building === wsB);
  // Fail path: furniture Workshops above the measured cap go to Frame Timber -> CD. One action per step, each gated on the state it
  // changes, so a slow confirm never moves twice. Order: name the new Frame Timber group's recipe, place pooled Workshops, then cut.
  function failAction(v, f, d) {
    const wsB = v.idB(WORKSHOP), ftR = v.idR(FT);
    if (wsB == null || ftR == null) return { wait: 'retail fail path: name not in the catalog: ' + (wsB == null ? WORKSHOP : FT) };
    const wg = workshopGroups(v, wsB);
    const unnamed = wg.find((g) => g.name === FT_GROUP && g.recipe == null);   // the group this path just made
    if (unnamed) return { action: { id: 'retail:ft:recipe:' + unnamed.id, text: 'retail fail: group "' + FT_GROUP + '" on Frame Timber', hold: true,
      steps: [{ msg: { type: 'SetRecipe', group: unnamed.id, recipe: ftR }, until: (x) => x.groups.find((g) => g.id === unnamed.id)?.recipe === ftR }] } };
    const pooled = v.pool[wsB] ?? 0;
    if (pooled > 0) {
      const ft = wg.filter((g) => g.recipe === ftR).sort((a, b) => b.count - a.count)[0];
      if (ft) {
        const c0 = ft.count;
        return { action: { id: 'retail:ft:assign:' + ft.id + ':' + c0, text: 'retail fail: ' + pooled + ' idle Workshop(s) to Frame Timber (group ' + ft.id + ')', hold: true,
          steps: [{ msg: { type: 'AssignBuildings', group: ft.id, amount: pooled }, until: (x) => (x.groups.find((g) => g.id === ft.id)?.count ?? 0) >= c0 + pooled }] } };
      }
      return { action: { id: 'retail:ft:create', text: 'retail fail: new group "' + FT_GROUP + '" with ' + pooled + ' idle Workshop(s)', hold: true,
        steps: [{ msg: { type: 'CreateGroup', building: wsB, amount: pooled, name: FT_GROUP, region: REGION }, until: (x) => x.groups.some((g) => g.building === wsB && g.name === FT_GROUP) }] } };
    }
    for (const g of f.goods) {
      if (!(g.name in (d.capBy ?? {}))) continue;   // not on the measured shelf: no sales figure for it
      const on = wg.filter((x) => x.recipe === g.rid && x.count > 0);
      const blocks = on.reduce((a, x) => a + x.count, 0), keep = Math.ceil(d.capBy[g.name] - 1e-9), excess = blocks - keep;
      if (excess <= 0) continue;
      // a whole group that fits in the excess just changes recipe; otherwise unassign the excess from the largest group
      const whole = on.filter((x) => x.count <= excess).sort((a, b) => b.count - a.count)[0];
      if (whole) return { action: { id: 'retail:ft:switch:' + whole.id, text: 'retail fail: ' + g.name + ' group ' + whole.id + ' (' + whole.count + ' Workshops) to Frame Timber, keeping ' + keep + ' on ' + g.name, hold: true,
        steps: [{ msg: { type: 'SetRecipe', group: whole.id, recipe: ftR }, until: (x) => x.groups.find((y) => y.id === whole.id)?.recipe === ftR }] } };
      const big = [...on].sort((a, b) => b.count - a.count)[0], c0 = big.count;
      // The cut goes straight on to Frame Timber, so nothing waits in the pool for buildout's tidy to put back on furniture.
      // No Frame Timber group: a new one; its recipe comes from the branch above on the next step (its id is not known before).
      const ft = wg.filter((x) => x.recipe === ftR).sort((a, b) => b.count - a.count)[0], f0 = ft?.count ?? 0;
      const to = ft ? { msg: { type: 'AssignBuildings', group: ft.id, amount: excess }, until: (x) => (x.groups.find((y) => y.id === ft.id)?.count ?? 0) >= f0 + excess }
        : { msg: { type: 'CreateGroup', building: wsB, amount: excess, name: FT_GROUP, region: REGION }, until: (x) => x.groups.some((y) => y.building === wsB && y.name === FT_GROUP) };
      return { action: { id: 'retail:ft:cut:' + big.id + ':' + c0, text: 'retail fail: move ' + excess + ' Workshops off ' + g.name + ' (group ' + big.id + ') to Frame Timber, keeping ' + keep, hold: true,
        steps: [{ msg: { type: 'UnassignBuildings', group: big.id, amount: excess }, until: (x) => (x.groups.find((y) => y.id === big.id)?.count ?? 0) <= c0 - excess }, to] } };
    }
    return null;
  }
  function decide(v, ctx, out) {
    const f = ctx.retail;
    const readout = readoutOf(f);
    if (!f || f.err) return { wait: f?.err ?? 'no facts (context did not run)', readout };
    if (f.badBoard) return { wait: 'RETAIL BOARD SHAPE CHANGED: ' + f.badBoard + '; not building or shelving until it is checked', readout };
    if (f.share == null) return { wait: 'RETAIL BOARD: unknown "ratings" shape, share not computed; not acting', readout };
    if (!f.unlocked && !f.storeGroup && !f.pooled && !f.emptyGroup) return { wait: 'Retail Store not unlocked', readout };
    if (!f.chosen.length) return { wait: 'no shelf good: the Corporation makes or holds none of ' + GOODS.join(', '), readout };
    const want = f.chosen.map((g) => g.id);
    const storeB = f.storeB, p0 = f.pooled;
    if (!f.storeGroup && f.emptyGroup) {
      // reuse the empty Retail group (its shelves stay); never a second group or a rebuy behind the user's back
      const eg = f.emptyGroup;
      if (!p0) return { wait: 'manual: empty Retail group ' + eg.id + ' and no store in the pool (assign or delete it)', readout };
      return { action: { id: 'retail:store:assign:' + eg.id, text: 'put the pooled Retail Store into group ' + eg.id, hold: true,
        steps: [{ msg: { type: 'AssignBuildings', group: eg.id, amount: 1 }, until: (x) => (x.groups.find((g) => g.id === eg.id)?.count ?? 0) >= 1 }] }, readout };
    }
    if (!f.storeGroup) {
      const bd = v.bld(storeB);
      const steps = [];
      if (!p0) {
        const short = f.need.filter((x) => x.g.stock < x.need);
        if (short.length) return { wait: 'pre-store gate: ' + short.map((x) => x.g.name + ' ' + Math.floor(x.g.stock) + ' / ' + x.need).join(', ') + ' (' + cfg().stockHoursPerShelf + ' h of sales at min(demand, output))', readout };
        const cost = P ? P.price(bd.cost, v.owned(STORE), 0) : bd.cost;
        // Iron Frames: until Stage D the prototypes and first builds still to pay are kept back (corePlan ifNeed, capped by cfg.ifReserve); this build's own frames are not
        const ifId = v.idI('Iron Frame'), late = out?.stage === 'D' || out?.stage === 'END';
        const keepOf = (i) => (i === ifId && !late ? Math.min(cfg().ifReserve ?? 0, W.corePlan._ifNeed(v, STORE)) : 0);
        const lack = (bd.build_items ?? []).filter((i) => (v.st.stock?.[REGION]?.[i.item] ?? 0) - i.amount < keepOf(i.item));
        if (lack.length) return { wait: 'store needs ' + lack.map((i) => i.amount + ' ' + (v.C.items[i.item]?.name ?? i.item) + (keepOf(i.item) ? ' (+' + keepOf(i.item) + ' kept for prototypes)' : '')).join(', '), readout };
        if (v.freeAcres < bd.acres) return { wait: 'store needs ' + bd.acres + ' free acres (' + v.freeAcres + ' free)', readout };
        // bill floor (plan 8.1): the store's always-on draw goes on every bill from now on
        const mw = bd.draws?.power ?? 0, billFloor = mw * 2000 + 12 * billsOf(v.st);
        const need = (ctx.floorCents ?? 0) + cost + billFloor;
        if (v.money < need) return { wait: 'store ' + usd(cost) + ' + bill floor ' + usd(billFloor) + ' (' + mw + ' MW x $20 + 2 h of bills): need ' + usd(need - v.money) + ' more above the floor', readout };
        steps.push({ msg: { type: 'BuyBuilding', building: storeB, amount: 1, region: REGION }, until: (x) => (x.pool[storeB] ?? 0) >= 1 || x.groups.some((g) => g.building === storeB && g.count > 0) });
      }
      steps.push({ msg: { type: 'CreateGroup', building: storeB, amount: 1, name: GROUP_NAME, region: REGION }, until: (x) => x.groups.some((g) => g.building === storeB && g.count > 0) });
      return { action: { id: 'retail:store', text: (p0 ? '' : 'build 1 Retail Store, then ') + 'group it as "' + GROUP_NAME + '"', steps, hold: true }, readout };
    }
    const g = f.storeGroup, have = g.assortment ?? [];
    if (!sameSet(have, want)) {
      return { action: { id: 'retail:shelf:' + want.join(','), text: 'shelves: ' + f.chosen.map((x) => x.name).join(', '),
        steps: [{ msg: { type: 'SetAssortment', group: g.id, items: want }, until: (x) => sameSet(x.groups.find((y) => y.id === g.id)?.assortment ?? [], want) }] }, readout };
    }
    const d = f.capDecision;   // a re-run, and its pass, keep cutting to the earlier fail's cap
    if (d) {
      const fa = failAction(v, f, d);
      if (fa) return { ...fa, readout };
    }
    return { wait: readout.decision, readout };
  }

  W.corePlan.addDirector({
    name: 'retail', order: 45,
    defaults: {
      stockHoursPerShelf: 1,       // hours of modelled sales in stock per shelf good before the store is built (wiki 4.7)
      retailSampleMin: 10,         // minutes between checkpoint samples
      retailCheckHours: 2,         // decide the checkpoint after this many hours
      retailMaxHours: 4,           // give up (fail) when a row still has no data by then
      retailAppetiteTol: 15,       // % appetite may move while the store sells
      retailSamplePassPct: 70,     // % of the modelled sales that must sell
      retailPriceTol: 3,           // % around 1.52 x base
      retailRating: 9000,          // rating the store must reach ...
      retailRatingMin: 90,         // ... within this many minutes of the build (75 at +1 per tick, plus slack)
      retailE1Hours: 6,            // E1: hours in a row with the rows passing
      retailShelfDropMin: 60,      // minutes a shelved good may be unmade and out of stock before it leaves the shelf
      retailGoneMin: 10,           // minutes with no store owned before the checkpoint starts over
      retailRunsPerWave: 5,        // runs per wave per Workshop when no group runs a recipe yet (wiki 2.1)
    },
    context, decide,
    duties: () => [{ duty: 'Retail Store, shelves and the retail checkpoint (wiki 4.7)', owner: 'Core plan', done: true }],
  });
  W.corePlan._retail = { facts, demandH, shelfHours, checkBoard, shareOf, salesOver, rowsOf, capOf, shapeOf };
})();
} catch (e) { console.error('[IdleCorp] cp-retail failed to load:', e); }
// @@END cp-retail
// ============================================================================
// CORE PLAN DIRECTOR: 7. Lab preset and module installer (wiki core-game-plan.md section 10)
// ============================================================================
// Director "lab" (order 55), one action per step:
//   0. Second Lab (wiki 10 "build one", plan D2): with 1 Lab owned and cfg.labTarget 2, buy one on free acres above the buffer (else its own acres while the land rule is open) once the
//      Iron Frames the unlocks still need are kept back and cash covers the money floor, the Lab and its bill floor; then into the Lab group.
//   1. Lab group: a Manufacturing Lab sitting in the building pool gets its own group (CreateGroup), so modules can sit on it.
//   2. Lab preset: while Core plan is live, a dry-run or reloaded Lab runner is started live with the Tier I list from wiki 10
//      step 1 (Bookshelf / Table / Chair on Quality engineering, Planks on Process study), or on your own setting once you have
//      changed it. A live Lab runner is never touched. A dry-run or stopped Lab runner is an alert, never silent.
//   3. Modules: each free module (in no group, not in the fleet) goes by the install table: Overclock (kind 61) -> Fell Wood,
//      Refiner (kind 62) -> furniture Workshops (never an Overclock on a Workshop: it raises plank use), Insightful quirk -> Lab.
//      A quirk that names a cell (e.g. CornerTuned "1,-1") is installed only in that cell. Stacking is unverified (risk R2), so
//      after the first module of a kind on a group no second one goes there until cfg.modulesStackOk is true.
// Manual only (no message in the protocol, or spends money on the market): adopting Process / Quality results, Module Exchange.
// @@MODULE cp-lab
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const REGION = 0, SOCKETS = 6, ACRE_CAP = 360;
  const CELLS = ['0,-1', '1,-1', '-1,0', '1,0', '-1,1', '0,1'];
  const OVERCLOCK = 61, REFINER = 62;
  const KIND_NAME = { [OVERCLOCK]: 'Overclock', [REFINER]: 'Refiner' };
  const FURNITURE = ['Make Bookshelf', 'Make Table', 'Make Chair', 'Make Bench'];
  // wiki 10 step 1: product name, focus (0 Process study, 2 Quality engineering), Tier I pinned.
  const PRESET = [['Bookshelf', 2], ['Planks', 0], ['Table', 2], ['Chair', 2]];
  const PRESET_BACKOFF = 10 * 60000;   // after a failed preset, leave the Lab runner alone this long (so modules still get their turn)
  const LAB = 'lab';

  // A socket holds a module id (a number, possibly 0) or an object with an id.
  const modId = (m) => (m != null && typeof m === 'object' ? m.id : m);
  const same = (a, b) => a != null && b != null && String(a) === String(b);
  const fleetIds = (st) => {
    const f = st.fleet_modules;
    if (f == null) return [];
    const vals = Array.isArray(f) ? f : Object.values(f);
    return vals.map(modId).filter((x) => x != null);
  };
  const usedCells = (g) => Object.entries(g.modules ?? {}).filter(([, m]) => modId(m) != null);
  const defOf = (v, id) => v.st.module_defs?.[id] ?? Object.values(v.st.module_defs ?? {}).find((d) => same(d.id, id)) ?? null;
  const modName = (d) => d.name ?? (KIND_NAME[d.kind] ?? 'kind ' + d.kind) + ' module #' + d.id;

  // Free modules: defined, in no group's sockets (any region) and not in a fleet socket.
  function freeModules(v) {
    const used = new Set(fleetIds(v.st).map(String));
    for (const g of Object.values(v.st.groups ?? {})) for (const [, m] of usedCells(g)) used.add(String(modId(m)));
    return Object.values(v.st.module_defs ?? {}).filter((d) => d?.id != null && !used.has(String(d.id))).sort((a, b) => a.id - b.id);
  }
  const groupLabel = (v, g) => 'group ' + g.id + ' (' + (g.name || v.bld(g.building).name) + ')';

  // The groups a module may go to, by the install table, and the reason when none qualifies.
  function targetsFor(v, d) {
    const lab = v.idB('Manufacturing Lab'), ws = v.idB('Workshop'), camp = v.idB('Lumber Camp'), fell = v.idR('Fell Wood');
    const furn = FURNITURE.map((n) => v.idR(n)).filter((x) => x != null);
    if ((d.quirks ?? []).some((q) => q?.kind === 'Insightful')) return { kind: 'Lab', groups: v.groups.filter((g) => g.building === lab && lab != null) };
    if (d.kind === OVERCLOCK) return { kind: 'Fell Wood', groups: v.groups.filter((g) => g.building === camp && g.recipe === fell && camp != null && fell != null) };
    if (d.kind === REFINER) return { kind: 'furniture Workshop', groups: v.groups.filter((g) => g.building === ws && ws != null && furn.includes(g.recipe)) };
    return null;
  }

  // The next install, or the reasons nothing can be installed. Pure.
  function planInstall(v, cfg) {
    const ws = v.idB('Workshop');
    const notes = [];
    for (const d of freeModules(v)) {
      const t = targetsFor(v, d);
      const name = modName(d);
      if (!t) { notes.push('manual: ' + name + ' (kind ' + d.kind + ') has no rule in the install table, install it by hand'); continue; }
      const cellQ = (d.quirks ?? []).find((q) => q && typeof q.cell === 'string' && CELLS.includes(q.cell));
      const why = [];
      const ok = [];
      for (const g of t.groups) {
        if (!(g.count > 0)) continue;
        if (d.kind === OVERCLOCK && g.building === ws) continue;   // never: an Overclock on a Workshop raises plank use
        const cells = usedCells(g);
        if (cells.length >= SOCKETS) { why.push(groupLabel(v, g) + ' has all ' + SOCKETS + ' sockets full'); continue; }
        const stacked = cells.some(([, m]) => defOf(v, modId(m))?.kind === d.kind);
        if (stacked && !cfg.modulesStackOk) { why.push(groupLabel(v, g) + ' already has a ' + (KIND_NAME[d.kind] ?? 'kind ' + d.kind) + ': stacking is unverified, read its speed, then corePlan.importCfg({ modulesStackOk: true })'); continue; }
        const taken = new Set(cells.map(([c]) => c));
        const cell = cellQ ? (taken.has(cellQ.cell) ? null : cellQ.cell) : CELLS.find((c) => !taken.has(c));
        if (cell == null) { why.push(groupLabel(v, g) + ': cell ' + cellQ.cell + ' (' + cellQ.kind + ') is taken'); continue; }
        ok.push({ g, cell });
      }
      if (!ok.length) { notes.push(name + ': ' + (why.length ? why.join('; ') : 'no ' + t.kind + ' group yet')); continue; }
      ok.sort((a, b) => b.g.count - a.g.count || a.g.id - b.g.id);   // a module is worth more on a bigger group
      const { g, cell } = ok[0];
      return { install: { d, g, cell, name, text: 'install ' + name + ' in ' + groupLabel(v, g) + ' cell ' + cell + (cellQ ? ' (' + cellQ.kind + ')' : '') }, notes };
    }
    return { install: null, notes };
  }

  // The Tier I list with ids by name; null when a name is missing (the preset is then off, with a readout).
  function presetList(v) {
    const list = PRESET.map(([n, focus]) => ({ product: v.idI(n), focus, tier: 1 }));
    return list.some((e) => e.product == null) ? null : list;
  }
  const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((e, i) => e && e.product === b[i].product && e.focus === b[i].focus && e.tier === b[i].tier);

  // Lab preset: what to do with the Lab runner. Returns { action?, alert?, note }.
  // Rule: a live Lab runner is never touched (whatever its setting: the list is yours to edit, wiki 10 step 2).
  // Only a dry run or a reload (stopped, no stop reason) is (re)started live.
  function presetStep(v, ctx, cfg) {
    const lr = ctx.mods?.labRunner;
    if (!cfg.labPreset) return { note: 'preset off (cfg.labPreset)', alert: lr && lr.running && lr.cfg?.dryRun && ctx.live ? 'ALERT: the Lab runner is a dry run while Core plan is live, the Lab sends nothing' : null };
    if (!lr) return { note: 'Lab runner not loaded' };
    if (v.owned('Manufacturing Lab') < 1) return { note: 'no Manufacturing Lab yet' };
    const list = presetList(v);
    if (!list) return { note: 'preset off: an item of the Tier I list is missing from the catalog', alert: 'ALERT: Lab preset items not found by name' };
    const c = lr.cfg ?? {};
    if (lr.running && !c.dryRun) return { note: c.mode === 'list' && sameList(c.list, list) ? 'Lab runner live on the Tier I list' : 'Lab runner live on your own setting (' + (c.mode ?? '?') + '): left alone' };
    const state = lr.running ? 'running as a dry run' : 'stopped';
    const alert = lr.running ? 'ALERT: the Lab runner is a dry run' + (ctx.live ? ' while Core plan is live: the Lab sits idle' : '') : null;
    if (!ctx.live) return { note: 'Lab runner ' + state + '; the preset is applied once Core plan runs live', alert };
    const mark = marks.get(lr) ?? {};
    // An explicit stop (by you, or the Lab runner's own failure stop) is respected: only a reload (no stop reason) or our own stop is re-armed.
    if (!lr.running && lr.stopReason && !mark.selfStopped) return { note: 'Lab runner stopped (' + lr.stopReason + '): not restarting it', alert: 'ALERT: the Lab runner is stopped (' + lr.stopReason + '), the Lab sits idle' };
    // Live was refused by the Lab runner itself (its game-data check): retrying only re-fires its refusal, so wait for you.
    if (mark.refused && lr.running) return { note: 'Lab runner refused Live: left as a dry run', alert: 'ALERT: the Lab runner refuses Live (see its ledger: game data check); start it live by hand once fixed' };
    const m = ctx.mem?.(LAB)?.get?.() ?? {};
    if (m.presetFailAt != null && ctx.now - m.presetFailAt < PRESET_BACKOFF) return { note: 'preset failed recently, trying again in ' + Math.ceil((PRESET_BACKOFF - (ctx.now - m.presetFailAt)) / 60000) + ' min', alert: alert ?? 'ALERT: the Lab preset did not take' };
    // Mode and list survive a reload (only dryRun resets). If they differ from what this director last applied, you changed them: keep yours.
    const own = m.applied != null && sigOf(c) !== m.applied;
    const verb = lr.running ? 'restart' : 'start';
    const text = own ? 'Lab runner: ' + verb + ' live on your own setting (' + (c.mode ?? '?') + ')' : 'Lab runner: ' + verb + ' live on the Tier I list (Bookshelf, Planks, Table, Chair)';
    return { alert, note: 'Lab runner ' + state, action: { id: 'lab:preset', text, run: () => applyPreset(lr, own ? null : list, ctx) } };
  }
  const sigOf = (c) => JSON.stringify([c.mode ?? null, c.mode === 'list' ? (c.list ?? []).map((e) => [e?.product, e?.focus, e?.tier]) : null]);
  // Per Lab runner, in memory only (a reload resets the runner's stopReason too): did we stop it, did it refuse Live.
  const marks = new WeakMap();
  const mark = (lr, patch) => marks.set(lr, { ...(marks.get(lr) ?? {}), ...patch });
  const timing = { pollMs: 100, polls: 100 };   // wait up to 10 s for the runner to finish its step after stop()
  // The only impure part: stop the Lab runner (it finishes its step first), then start it live, with the list or on its own setting.
  // Returns true when it ends up live, else null: the server is not involved, so a refusal must not count toward Core plan's fail stop.
  async function applyPreset(lr, list, ctx) {
    const mem = ctx.mem(LAB);
    const sleep = W.idleCore?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (lr.running) { mark(lr, { selfStopped: true }); lr.stop(); }
    for (let i = 0; i < timing.polls && lr.active; i++) await sleep(timing.pollMs);
    if (lr.active || lr.running) { mem.set({ presetFailAt: Date.now() }); return null; }   // still finishing a step: selfStopped stays, retry after the back-off
    lr.start(list ? { dryRun: false, mode: 'list', list: list.map((e) => ({ ...e })) } : { dryRun: false });
    if (!lr.running) { mem.set({ presetFailAt: Date.now() }); return null; }
    mark(lr, { selfStopped: false });
    if (lr.cfg?.dryRun) { mark(lr, { refused: true }); return null; }
    if (list && !(lr.cfg?.mode === 'list' && sameList(lr.cfg.list, list))) { mem.set({ presetFailAt: Date.now() }); return null; }
    mem.set({ presetFailAt: null, presetAt: Date.now(), ...(list ? { applied: sigOf(lr.cfg) } : {}) });
    return true;
  }

  // Second Lab (wiki 10 "build one", plan D2), only while one is owned and cfg.labTarget asks for 2 (never more). Pure. Gates: the Iron Frames the
  // unlocks still need (ifNeed) stay back; acres above the CD-farm buffer, else its own acres bought in the same action while the land rule is
  // open (as buildout Stage C-D: acresOwned + acres <= min(rule.lastAcre, 360)); cash for the money floor + land + the Lab + its bill floor.
  // No free acre and the rule closed: not wanted, so E5 is never held by a Lab that cannot be placed.
  function labBuy(v, ctx, cfg, rule, stage) {
    const lab = v.idB('Manufacturing Lab');
    if (lab == null) return { note: 'no Manufacturing Lab in the catalog' };
    const owned = v.owned('Manufacturing Lab');
    if (owned !== 1 || cfg.labTarget < 2) return { note: owned + ' Manufacturing Lab' + (owned === 1 ? '' : 's') + ' (target ' + cfg.labTarget + ')' };
    const usd = W.corePlan._usd, bd = v.bld(lab), floor = ctx.floorCents ?? 0;
    const free = v.freeAcres - cfg.bufferAcres, acres = Math.max(0, bd.acres - Math.max(0, free)), cap = Math.min(rule?.lastAcre ?? 0, ACRE_CAP);
    // Land for the Lab only in Stage C-D: in Stage A-B free land goes to engine blocks first (plan D-1).
    if (acres && !['C', 'D', 'END'].includes(stage)) return { note: 'second Lab: no free acre above the ' + cfg.bufferAcres + '-acre buffer (stage ' + (stage ?? '-') + ' buys no land for it)' };
    if (acres && v.acresOwned + acres > cap) return { note: 'second Lab: land rule closed (' + Math.max(0, free) + ' free acre(s) above the ' + cfg.bufferAcres + '-acre buffer, needs ' + bd.acres + '; ' + (rule ? 'acre #' + (v.acresOwned + acres) + ' is past #' + cap : 'no land rule') + ')' };
    const per = (bd.build_items ?? []).find((i) => i.item === v.idI('Iron Frame'))?.amount ?? 0, keep = W.corePlan._ifNeed(v, null), frames = v.has('Iron Frame');
    if (frames < keep + per) return { want: true, note: 'second Lab waits: Iron Frame ' + Math.floor(frames) + ' < ' + (keep + per) + ' (' + keep + ' kept for the unlocks + ' + per + ')' };
    let land = 0;
    for (let i = 0; i < acres; i++) land += W.corePlan._acrePriceCents(v.landBought + i);
    const price = W.idleCore.planner.price(bd.cost, owned, 0);
    const mw = bd.draws?.power ?? 0, bill = W.corePlan._billNeed(v, mw);
    const landTxt = acres ? acres + ' acre(s) ' + usd(land) + ' + ' : '';
    if (v.money < floor + land + price + bill) return { want: true, note: 'second Lab waits: cash ' + usd(v.money) + ' < ' + usd(floor + land + price + bill) + ' (money floor + ' + landTxt + 'Lab ' + usd(price) + ' + ' + mw + ' MW bills)' };
    const g = v.groups.find((x) => x.building === lab), steps = W.corePlan._buySteps(v, lab, acres, g, 'Manufacturing Lab', (v.pool[lab] ?? 0) + 1);
    const text = 'second Manufacturing Lab: buy ' + landTxt + usd(price) + (g ? ' into ' + groupLabel(v, g) : ' (new group)');
    return { want: true, note: text, action: { id: 'lab:buy:' + owned, text, steps, hold: true } };
  }

  const pendingInvest = (v, ctx, rule, stage) => (labBuy(v, ctx, W.corePlan.cfg, rule, stage).want ? [{ what: 'second Manufacturing Lab', paybackH: null }] : []);

  W.corePlan.addDirector({
    name: LAB, order: 55,
    defaults: { labPreset: true, labGroup: true, labModules: true, modulesStackOk: false, labTarget: 2 },
    // E5: the second Lab is an investment still to make while it is wanted and not bought.
    pendingInvest,
    // Records every installed module once (group, kind, cell, first seen) for the readout. Stacking (R2) is not measured here:
    // what group.work fields mean is unverified, so you read the group's speed and set modulesStackOk.
    context(v, ctx) {
      // A refusal mark lasts while the runner stays a dry run; once it stops or goes live, the preset may try again.
      const lr = ctx.mods?.labRunner;
      if (lr && marks.get(lr)?.refused && !(lr.running && lr.cfg?.dryRun)) mark(lr, { refused: false });
      const mem = ctx.mem?.(LAB);
      if (!mem) return;
      const seen = mem.get().installs ?? [];
      const add = [];
      for (const g of v.groups) for (const [cell, m] of usedCells(g)) {
        const id = modId(m);
        if (seen.some((x) => same(x.module, id) && x.group === g.id)) continue;
        add.push({ module: id, group: g.id, kind: defOf(v, id)?.kind ?? null, cell, at: ctx.now });
      }
      if (add.length) mem.set({ installs: [...seen, ...add] });
    },
    decide(v, ctx, out) {
      const cfg = W.corePlan.cfg;
      const readout = {};
      const waits = [];
      const actions = [];
      const lab = v.idB('Manufacturing Lab');

      // 0. Second Lab.
      const buy = labBuy(v, ctx, cfg, out?.rule, out?.stage);
      readout.secondLab = buy.note;
      if (buy.action) actions.push(buy.action);

      // 1. Lab group.
      const labGroup = lab != null && v.groups.find((g) => g.building === lab);
      const inPool = lab != null ? v.pool[lab] ?? 0 : 0;
      if (cfg.labGroup && lab != null && !labGroup && inPool > 0) {
        actions.push({ id: 'lab:group', text: 'create a group for the ' + inPool + ' Manufacturing Lab' + (inPool > 1 ? 's' : '') + ' in the pool',
          steps: [{ msg: { type: 'CreateGroup', building: lab, amount: inPool, name: 'Manufacturing Lab', region: REGION }, until: (x) => x.groups.some((g) => g.building === lab) }] });
      } else if (cfg.labGroup && labGroup && inPool > 0) {   // a bought Lab whose assign did not land joins the group
        const c0 = labGroup.count;
        actions.push({ id: 'lab:assign', text: 'assign the ' + inPool + ' Manufacturing Lab' + (inPool > 1 ? 's' : '') + ' in the pool to ' + groupLabel(v, labGroup),
          steps: [{ msg: { type: 'AssignBuildings', group: labGroup.id, amount: inPool }, until: (x) => (x.groups.find((g) => g.id === labGroup.id)?.count ?? 0) >= c0 + inPool }] });
      }
      readout.labGroup = labGroup ? groupLabel(v, labGroup) : inPool ? inPool + ' Lab in the pool, no group' : 'no Manufacturing Lab';

      // 2. Lab preset.
      const p = presetStep(v, ctx, cfg);
      readout.preset = p.note;
      if (p.alert) { readout.alert = p.alert; waits.push(p.alert); }
      if (p.action) actions.push(p.action);

      // 3. Modules.
      if (cfg.labModules) {
        const { install, notes } = planInstall(v, cfg);
        readout.modules = notes;
        if (install) {
          const { d, g, cell } = install;
          actions.push({ id: 'lab:module:' + d.id, text: install.text,
            steps: [{ msg: { type: 'InstallModule', group: g.id, cell, module: d.id }, until: (x) => same(modId(x.groups.find((y) => y.id === g.id)?.modules?.[cell]), d.id) }] });
        } else if (notes.length) waits.push('modules: ' + notes[0]);
        readout.installs = (ctx.mem?.(LAB)?.get?.().installs ?? []).map((x) => {
          const d = defOf(v, x.module);
          // formulas.md: Overclock speed +25% - ticks_bonus, Refiner -10% - ticks_bonus (raw ticks_bonus shown: its unit is unverified).
          const exp = d?.kind === OVERCLOCK ? ' (expected speed +25% - ticks_bonus ' + d.ticks_bonus + ')' : d?.kind === REFINER ? ' (expected speed -10% - ticks_bonus ' + d.ticks_bonus + ')' : '';
          return (KIND_NAME[x.kind] ?? 'kind ' + x.kind) + ' #' + x.module + ' on group ' + x.group + ' cell ' + x.cell + exp;
        });
      } else readout.modules = ['module installer off (cfg.labModules)'];

      // Manual work: no "adopt process" message exists in the protocol, and the Module Exchange spends money on unverified rows.
      const furn = FURNITURE.map((n) => v.idR(n)).filter((x) => x != null);
      const qg = v.groups.filter((g) => furn.includes(g.recipe)), pg = v.groups.filter((g) => g.recipe != null && g.recipe === v.idR('Saw Planks'));
      const results = (v.st.pending_results ?? []).length;
      readout.manual = [
        'adopt by hand: Quality engineering results on ' + (qg.length ? qg.map((g) => groupLabel(v, g)).join(', ') + ' (one group first)' : 'the furniture groups, none yet'),
        'adopt by hand: Process study results for Planks on ' + (pg.length ? pg.map((g) => groupLabel(v, g)).join(', ') : 'the Planks group, none yet') + ' if output per acre-second rises >= 3%',
        'Module Exchange: search "overclock" and buy modules for free Fell Wood sockets by hand',
        ...(results ? [results + ' Lab result' + (results > 1 ? 's' : '') + ' waiting to be claimed'] : []),
      ];
      if (out) out.labAlert = readout.alert ?? null;
      // One action per step: the first is the one the runner sends; the rest show up as waits so the readout says what comes next.
      return { action: actions[0], wait: [...actions.slice(1).map((a) => 'next: ' + a.text), ...waits].join(' | ') || undefined, readout };
    },
    duties: () => [
      { duty: 'Lab: Tier I list re-armed live after each reload', owner: 'Core plan', done: true },
      { duty: 'modules: install free modules by the wiki 10 table', owner: 'Core plan', done: true },
      { duty: 'confirm module stacking (R2): read the group speed after the first Overclock, then corePlan.importCfg({ modulesStackOk: true })', owner: 'you', done: false },
    ],
  });
  W.corePlan._lab = { freeModules, planInstall, presetList, CELLS, timing, labBuy, pendingInvest };
})();
} catch (e) { console.error('[IdleCorp] cp-lab failed to load:', e); }
// @@END cp-lab// ============================================================================
// CORE PLAN DIRECTOR: 8. Stage D ladder (window.corePlan director "ladder")
// ============================================================================
// Feeds and tunes CD Farm's Auto mode per stage (wiki/guides/core-game-plan.md section 11); it never cycles buildings itself.
//   CD need (out.cdNeed): A = next unlock (Assembly Plant 20,000), B = Retail Store 5,000 banked, C = none (pause Auto once),
//   D = none until the retail checkpoint passes, then Oil Rig 5,000, then Refinery 750,000 (11.4: 755,000 farmed in Stage D).
//   Auto tuning through cdFarm.importCfg, only between runs and only for keys that differ, read back after:
//   land 'off' (Core plan owns land), pace, batch (core-math bestBatch at the measured income), reserveAcres, maxTypes 1 in D,
//   autoStart: armed when Auto is off and nothing says the user wants it off. The user's Stop (or unticking it) is sticky until
//   they switch it on again; Alt+Shift+X, CD Farm's own error / dry-run switch-off wait for Core plan's next Live session
//   (the live-resume countdown after a reload); the ladder's own Stage C pause ends with the stage.
//   Stage D gates (11.4): checkpoint passed (a pass of either run, plan D-2), 0 Farms owned (waived on the retail fail path, where Wooden
//   Frames are the CD source), free acres >= batch + spare; alert when Auto's plan is not Farm-only.
// @@MODULE cp-ladder
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const M = W.idleCore?.coreMath;
  if (!M) throw new Error('core-math did not load');
  const NAME = 'ladder', WALL_CD = 755000;
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const cfgOf = () => W.corePlan.cfg;
  // A Live session = Core plan stepping live without a long gap; a reload starts a new one (new LOAD token).
  const LOAD = Math.random().toString(36).slice(2, 8);
  let session = 0, liveAt = 0;

  // Why Auto went off, from CD Farm's own ledger lines since it was last seen on. No line = unticked by hand = the user's.
  function offWhy(since) {
    let list = [];
    try { list = W.idleCore?.ledger?.list?.() ?? []; } catch {}
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (since && e.t < since) break;
      if (e.mod !== 'CD') continue;
      if (/Auto switched off because you stopped it/.test(e.text)) return 'user';
      if (/Auto switched off \(stop all\)/.test(e.text)) return 'pause';
      if (/Auto switched off after \d+ errors/.test(e.text)) return 'error';
      if (/dry run: plan logged/.test(e.text)) return 'dry';
    }
    return 'user';
  }

  // An unlock counts as done once its research runs or waits in the queue: its CD is already spent.
  const researching = (v, b) => b != null && (v.research?.building === b || (v.st.research_queue ?? []).some((q) => q?.building === b));
  const gone = (v, name) => v.unlocked(name) || researching(v, v.idB(name));
  // A deliberate banking target: prereqsMet is true on purpose (Retail Store needs the Assembly Plant that is still researching;
  // the Refinery needs the Oil Rig whose research runs). Otherwise CD Farm's gate G3 would keep Auto idle.
  function needOf(v, name, note = '') {
    const b = v.idB(name), tech = b == null ? null : v.N.techs.find((t) => t.building === b);
    if (!tech) return { missing: name };
    return { b, name, cd: tech.cost, prereqsMet: true, note };
  }

  // What the stage asks of the CD farm. need: undefined = keep the next unlock, false = no CD need, object = this target.
  function phaseOf(v, stage, ctx) {
    if (stage === 'A') return { key: 'A', arm: true };
    if (stage === 'B') {
      if (gone(v, 'Retail Store')) return { key: 'B-done', need: false, why: 'Retail Store already unlocked or researching' };
      return { key: 'B', need: needOf(v, 'Retail Store', 'banked while the Assembly Plant researches'), arm: true };
    }
    if (stage === 'C') {
      // stageOf says C as soon as the Assembly Plant is in; the wiki's C (pause) starts with the Retail research.
      if (gone(v, 'Retail Store')) return { key: 'C', need: false, pause: true, why: 'stage C: no CD cycling until the store passes the checkpoint (11.3)' };
      const n = needOf(v, 'Retail Store', 'not banked in stage B');
      if (n.missing || v.cd < n.cd) return { key: 'C-bank', need: n, arm: true, why: 'stage C: Retail Store research not started, ' + fmt(v.cd) + ' / ' + fmt(n.cd ?? 0) + ' CD' };
      return { key: 'C', need: false, pause: true, why: 'stage C: Retail Store CD is in hand, no CD cycling (11.3)' };
    }
    if (stage === 'D' || stage === 'END') {
      if (ctx.retailOk !== true) return { key: 'D-wait', need: false, pause: true, why: 'stage D: the store has not passed the retail checkpoint' + (ctx.retailOk === false ? ' (it failed: a new run measures the capped output)' : ' yet') };
      if (!gone(v, 'Oil Rig')) return { key: 'D', need: needOf(v, 'Oil Rig'), arm: true, ladder: true };
      if (!gone(v, 'Refinery')) return { key: 'D', need: needOf(v, 'Refinery', v.unlocked('Oil Rig') ? '' : 'Oil Rig research running'), arm: true, ladder: true };
      return { key: 'D-done', need: false, why: 'Refinery research started: no CD need left' };
    }
    return null;
  }

  // CD Farm reads are not pure (rates() reads the page, evaluate() samples its history), so they happen here, before decide.
  function context(v, ctx, stage) {
    // The phase's CD need, published before any decide: buildout (order 40) reads it for the Wooden Frame gate.
    const ph = phaseOf(v, stage, ctx);
    ctx.ladderNeed = ph?.need && !ph.need.missing ? ph.need : false;
    const gap = 3 * (cfgOf().intervalMs ?? 5000);
    if (ctx.live) { if (!liveAt || ctx.now - liveAt > gap) session++; liveAt = ctx.now; }
    else liveAt = 0;   // dry run: going Live again is a new session
    const cf = ctx.mods?.cdFarm;
    if (!cf) return;
    const lad = { rates: null, plan: null, income: null, held: null, session: LOAD + ':' + session };
    try { lad.held = cf.farmUnits ?? null; } catch {}   // buildings a CD Farm run holds in the pool between its Buy and Demolish
    // Record Auto going off (and back on) here, where reading the ledger is allowed; decide only reads mem.
    if (cf.cfg?.building === 'auto') {
      const mm = ctx.mem(NAME), m = mm.get();
      if (cf.cfg.autoStart) { if (m.off || !m.onAt) mm.set({ off: null, onAt: ctx.now }); }
      else if (!m.off && (m.armed || m.onAt)) mm.set({ off: { why: offWhy(m.onAt), session: lad.session } });
    }
    try { lad.rates = cf.rates?.() ?? null; } catch {}
    try { const ev = cf.evaluate?.(); lad.plan = ev?.plan ?? null; lad.income = ev?.income ?? null; lad.gate = ev?.idle ? (ev.gate + ': ' + ev.reason) : null; } catch {}
    ctx.ladder = lad;
  }

  function decide(v, ctx, out) {
    const c = cfgOf(), stage = out.stage;
    const ph = phaseOf(v, stage, ctx);
    if (!ph) return { wait: 'no stage yet' };
    const waits = [], alerts = [];
    if (ph.need?.missing) {
      out.cdNeed = false;
      return { wait: 'off: no tech named ' + ph.need.missing + ' in the catalog (the game changed?)', readout: { phase: ph.key, alerts: ['no tech named ' + ph.need.missing] } };
    }
    const lad = ctx.ladder ?? {};
    const cycles = lad.rates?.cyclesh15 > 0 ? lad.rates.cyclesh15 : ctx.cyclesPerHour ?? c.cyclesPerHour;   // measured CD Farm cycles first: E3 checks the batch against them
    const incomeH = lad.income > 0 ? lad.income / 100 : out.rule?.income ?? null;   // CD Farm measures cents/h; core-math works in dollars
    const batch = incomeH > 0 && cycles > 0 ? M.bestBatch('farm', 0, incomeH, cycles).k : null;
    const spare = c.ladderSpareAcres;

    // Stage D ladder gates (11.4); while one fails there is no CD need, so Auto cannot farm on dear types meanwhile.
    if (ph.ladder) {
      // The gates are entry checks: Farms and acres a CD Farm run holds mid-cycle are its own, not owned ones.
      const cf0 = ctx.mods?.cdFarm, inRun = !!(cf0 && (cf0.running || cf0.active));
      const held = lad.held, farmId0 = v.idB('Farm');
      const heldAll = held ? Object.values(held).reduce((a, n) => a + (n > 0 ? n : 0), 0) : 0;
      const farms = inRun && !held ? 0 : v.owned('Farm') - (held?.[farmId0] ?? 0);
      // Fail path (plan A2): the remaining Farms stay on Cotton and CD Farm burns Wooden Frames above the keep line instead
      if (ctx.retailFailPath) alerts.push('fail path: CD from Wooden Frames');
      else if (farms > 0) waits.push(farms + ' Farms owned: the ladder needs 0 (each one raises the next Farm price by $2.05)');
      const want = (batch ?? 1) + spare;
      if (!inRun && v.freeAcres + heldAll < want) waits.push('free acres ' + (v.freeAcres + heldAll) + ' < batch ' + (batch ?? '?') + ' + spare ' + spare);
      if (waits.length) { ph.need = false; ph.arm = false; }
      const units = lad.plan?.units ?? [];
      const farmId = v.idB('Farm');
      if (!ctx.retailFailPath && units.length && (!units.some((u) => u.b === farmId) || units.length > 2)) alerts.push('CD Farm plan is ' + units.map((u) => u.n + ' ' + u.name).join(' + ') + ', not Farm-only (or Farm + 1 type): check Farms owned and the Wooden Frame reserve');
    }
    if (ph.need !== undefined) out.cdNeed = ph.need;
    const need = ph.need || (ph.need === undefined ? out.nextUnlock : null);

    // T_wall from the measured CD rate and from the model rate (R4: the 600 cycles/h is a claim).
    const measured = lad.rates ? (lad.rates.cdh15 ?? lad.rates.cdhAll ?? null) : null;
    const model = out.rule?.cdPerHour ?? null;
    const readout = {
      phase: ph.key, need: need ? need.name + ' ' + fmt(need.cd) + ' CD (' + fmt(Math.max(0, need.cd - v.cd)) + ' to go)' : 'none',
      cdPerHour: { measured: measured == null ? null : Math.round(measured), model: model == null ? null : Math.round(model) },
      tWallHours: { measured: measured > 0 ? +(WALL_CD / measured).toFixed(1) : null, model: model > 0 ? +(WALL_CD / model).toFixed(1) : null },
      batch, alerts,
    };
    if (ph.why) waits.push(ph.why);

    const cf = ctx.mods?.cdFarm;
    if (!cf?.cfg) { waits.push('CD Farm is not loaded'); return { wait: waits.join('; '), readout }; }
    if (lad.gate) readout.auto = lad.gate;
    const m = ctx.mem(NAME).get();
    const fc = cf.cfg;
    const isAuto = fc.building === 'auto';
    // Manual Building: none of the ladder's settings apply (batch and reserveAcres steer manual runs too).
    if (!isAuto) { alerts.push('CD Farm Building is ' + fc.building + ', not Auto: Core plan leaves it as you set it'); return { wait: waits.join('; ') || undefined, readout }; }

    // Pause once per stage entry; if the user switches Auto on again in that stage, that is their call.
    if (ph.pause && fc.autoStart && m.paused !== ph.key) {
      const key = ph.key;
      return { wait: waits.join('; ') || undefined, readout, action: { id: 'ladder:pause:' + key, text: 'CD Farm: pause Auto (' + ph.why + ')',
        run: async () => { const ok = cf.pauseAuto(); ctx.mem(NAME).set({ paused: key, off: { why: 'ladder' } }); return ok ? true : null; } } };
    }

    // Plan step 1 tuning: 'fast' on the Stage D ladder (CD is worth full income there), cfg.ladderPace before.
    const want = { land: 'off', pace: ph.ladder ? c.ladderPaceD : c.ladderPace, reserveAcres: spare };
    // batch follows a noisy income slope: only move it by 2 or more, so tune actions do not flip back and forth.
    if (batch && !(typeof fc.batch === 'number' && Math.abs(batch - fc.batch) < 2)) want.batch = batch;
    // Farm-only: each extra type adds a Buy and a Demolish round trip. Not on the fail path: Farms stay on Cotton, CD comes from frames.
    if ((stage === 'D' || stage === 'END') && !ctx.retailFailPath) want.maxTypes = 1;
    const sid = lad.session, off = m.off;
    if (ph.arm && !fc.autoStart) {
      if (!off || (off.why === 'ladder' && m.paused !== ph.key)) want.autoStart = true;
      else if (off.why === 'user') alerts.push('Auto was switched off by you: Core plan does not switch it back on (switch it on in CD Farm)');
      else if (off.session !== sid) want.autoStart = true;   // Alt+Shift+X / its own error or dry-run stop: re-armed in a new Live session
      else alerts.push('Auto was switched off (' + (off.why === 'pause' ? 'Alt+Shift+X' : off.why === 'error' ? 'its own error stop' : off.why === 'dry' ? 'its dry run' : 'the Stage C pause') + '): Core plan switches it on again only after it resumes Live');
    }
    // A key CD Farm did not take (read back) is not sent again with the same value; other keys still go.
    const rej = m.rejected ?? {};
    const diff = {};
    for (const [k, x] of Object.entries(want)) {
      if (fc[k] === x) continue;
      if (Object.prototype.hasOwnProperty.call(rej, k) && rej[k] === x) { alerts.push('CD Farm did not take ' + k + ' ' + x + ' (read back after importCfg); not retried until the wanted value changes'); continue; }
      diff[k] = x;
    }
    const keys = Object.keys(diff).sort(), sig = keys.map((k) => k + '=' + diff[k]).join(',');
    readout.tune = keys.length ? diff : 'in sync';
    const phKey = ph.key;
    if (keys.length) {
      if (cf.running || cf.active) waits.push('settings wait for the CD Farm run to end (' + keys.join(', ') + ')');
      else {
        const text = 'CD Farm settings: ' + keys.map((k) => k + ' ' + diff[k]).join(', ');
        return { wait: waits.join('; ') || undefined, readout, action: { id: 'ladder:tune:' + sig, text,
          run: async () => {
            if (cf.running || cf.active) return null;   // a run started since decide: try again between runs
            try { cf.importCfg({ cfg: diff }); } catch { return null; }
            const bad = keys.filter((k) => cf.cfg[k] !== diff[k]);
            const mm = ctx.mem(NAME), r = { ...(mm.get().rejected ?? {}) };
            for (const k of keys) { if (bad.includes(k)) r[k] = diff[k]; else delete r[k]; }
            const patch = { rejected: r };
            if (diff.autoStart && !bad.includes('autoStart')) Object.assign(patch, { armed: phKey, off: null, onAt: ctx.now });
            mm.set(patch);
            return bad.length ? false : true;
          } } };
      }
    }
    if (ph.arm && !fc.autoStart && need) waits.push('Auto is off while ' + need.name + ' needs CD: switch it on in CD Farm');
    return { wait: waits.join('; ') || undefined, readout };
  }

  W.corePlan.addDirector({
    name: NAME, order: 60,
    defaults: {
      ladderPace: 'balanced',   // CD Farm pace before the Stage D ladder (balanced: bigger batches while the time saved pays)
      ladderPaceD: 'fast',      // CD Farm pace on the Stage D ladder (plan step 1: CD is worth full income there)
      ladderSpareAcres: 0,      // CD Farm reserveAcres: the land rule already keeps cfg.bufferAcres free for the batch itself
    },
    context, decide,
    duties: () => [{ duty: 'CD farm per stage: need, Auto tuning, Stage C pause, Stage D Farm ladder gates', owner: 'Core plan', done: true }],
  });
})();
} catch (e) { console.error('[IdleCorp] cp-ladder failed to load:', e); }
// @@END cp-ladder// ============================================================================
// CORE PLAN DIRECTORS 9-10: bill resume, utilities, Cotton slot, sell jobs, cadence, offline checklist (corePlan directors)
// ============================================================================
// Five directors on top of corePlan (wiki/guides/core-game-plan.md sections 5, 6, 8.1, 8.2, 12, 13):
//   resume   SetPaused false on a group an unpaid bill paused, once bills are affordable (plan D7, Autopilot's rule; yours stay paused).
//   utilities  Auto utilities power on once per Live session, water while a running group draws water (plan D1); your switch-off is sticky.
//   slot     KeepFilling on the best Heartland Cotton bid while Farms exist (5.1), then a surplus bid or nothing (5.2).
//            Autopilot's autoShipCotton does the same job: while Autopilot runs with it on, this director only reads out.
//   sell     autoSell jobs for ore, stone, sheets and saturated shelves above the keep line (section 6). Live only.
//   cadence  hourly and 6-hour checklists (section 13); a browser alert only when a check newly fails.
// The endgame director (wiki 12) is in cp-endgame.js; it reads TARGETS from here.
// Also: corePlan.offline(hours) (checklist before going away), corePlan.canSaveDesign(st, recipe) and corePlan.worldEvents() (the last
// WorldEvents socket message, raw, plan D5).
// The pure pieces are on corePlan._cadence for the tests.
// @@MODULE cp-cadence
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const core = W.idleCore;
  const cp = W.corePlan, cfg = cp.cfg;
  const REGION = 0, TPH = 7200;                  // 2 server ticks per second
  const HOUR = 3600000, SIX = 6 * HOUR;
  const COURIER_CU = 10000;                      // one free courier load
  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const num = (n) => Math.round(n).toLocaleString('en-US');
  const usd2 = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });   // unit prices
  // Engine inputs and the endgame prototypes: never sold, never in the slot (wiki 5.2, 6).
  const NEVER = ['Wood', 'Planks', 'Iron Sheet', 'Concrete', 'Glass', 'Bookshelf', 'Table', 'Chair', 'Bench', 'Wooden Frame', 'Iron Frame', 'Copper Wire', 'Wired Frame'];
  const UNLOCKS = ['Assembly Plant', 'Retail Store', 'Oil Rig'];
  // Endgame stock (wiki 12): kept back from every sale and the surplus slot.
  const TARGETS = [['Iron Frame', 80], ['Wired Frame', 12], ['Copper Wire', 200], ['Copper Ore', 2000]];

  // ---- shared reads (pure) ----------------------------------------------------------------------------------------------------
  const tickOf = (v, ctx) => ctx.tick ?? v.mutTick ?? 0;
  const deals = (ctx) => (Array.isArray(ctx.deals) ? ctx.deals : []);
  const unit = (d) => d.price / Math.max(1, d.amount);
  const stockOf = (v, i) => v.st.stock?.[REGION]?.[i] ?? v.st.items?.[i] ?? 0;
  const itemName = (v, i) => v.C.items[i]?.name ?? 'item ' + i;
  const neverIds = (v) => new Set(NEVER.map((n) => v.idI(n)).filter((i) => i != null));
  // A Heartland fill counts while its bid is still on the board and it has not expired.
  function activeFills(v, ctx) {
    const t = tickOf(v, ctx), board = deals(ctx);
    return Object.entries(v.st.standing_fills ?? {}).map(([id, f]) => ({ deal: +id, ...f, bid: board.find((d) => d.id === +id) ?? null }))
      .filter((f) => (f.region ?? REGION) === REGION && f.bid && (f.expires_at ?? f.bid.expires_at ?? 0) > t)
      .map((f) => ({ ...f, left: (f.expires_at ?? f.bid.expires_at) - t }));
  }
  // Items a group eats, with the amount per hour (runs per wave x input / wave length). Paused groups count too:
  // they restart (an unpaid bill, a Kiln paused for now) and their inputs must still be there.
  function consumption(v) {
    const per = {};
    for (const g of v.groups) {
      if (!g.count || g.recipe == null) continue;
      const rc = v.C.recipes[g.recipe];
      if (!rc?.ticks) continue;
      const runs = g.work?.find((w) => w.recipe === g.recipe)?.runs ?? g.count;
      for (const i of rc.inputs ?? []) per[i.item] = (per[i.item] ?? 0) + runs * i.amount * TPH / rc.ticks;
    }
    return per;
  }
  // The next builds the land rule still wants (Workshops first: they are most of the engine), at most n.
  function nextBuilds(v, rule, n) {
    const need = rule?.need ?? {};
    const out = [];
    for (const [k, name] of [['workshops', 'Workshop'], ['sawmills', 'Sawmill'], ['camps', 'Lumber Camp']]) for (let i = 0; i < (need[k] ?? 0) && out.length < n; i++) out.push(name);
    while (out.length < n) out.push('Workshop');
    return out;
  }
  const kitOf = (v, names) => {
    const k = {};
    for (const n of names) { const b = v.bld(v.idB(n)); for (const it of [...(b.default_kit ?? []), ...(b.build_items ?? [])]) k[it.item] = (k[it.item] ?? 0) + it.amount; }
    return k;
  };
  // Keep line (wiki 6): >= 2x the next three builds' kit, >= 48 h of the groups' own use, and the endgame stock (wiki 12).
  function keepLine(v, rule, item, use = consumption(v)) {
    const kit = kitOf(v, nextBuilds(v, rule, cfg.sellKitBuilds))[item] ?? 0;
    const target = TARGETS.find(([n]) => v.idI(n) === item)?.[1] ?? 0;
    return Math.ceil(Math.max(2 * kit, cfg.sellKeepHours * (use[item] ?? 0), target));
  }
  const storeItems = (v) => [...new Set(v.groups.filter((g) => g.building === v.idB('Retail Store')).flatMap((g) => g.assortment ?? []))];
  // Hours a shelf's stock lasts, from the retail facts (stock, output, appetite x share); Infinity for a good the store does not shelve.
  const shelfHours = (f, i) => { const g = f?.goods?.find((x) => x.id === i); return g ? cp._retail.shelfHours(g, f.share) : Infinity; };

  // ---- slot (wiki 5.1, 5.2) -----------------------------------------------------------------------------------------------------
  function apOwnsSlot(ctx) { const eg = ctx.mods?.earlyGame; return !!(eg && eg.running && eg.cfg?.autoShipCotton !== false); }
  function bidOk(v, ctx, d) { return d.side === 'Sell' && (d.region ?? REGION) === REGION && d.amount >= cfg.slotLotMin && d.expires_at - tickOf(v, ctx) >= cfg.slotMinMinutes * 120; }
  // Every fill with who armed it (mem('slot').armed: deal -> { item, mode }), ticks left (null: unknown) and whether it is ours to
  // touch (Heartland). The game has one auto-ship slot per corp (wiki market.md, formulas.md), so a fill in any region holds it.
  function slotFills(v, ctx) {
    const t = tickOf(v, ctx), board = deals(ctx), armed = ctx.mem('slot').get().armed ?? {};
    return Object.entries(v.st.standing_fills ?? {}).map(([id, f]) => {
      const deal = +id, bid = board.find((d) => d.id === deal) ?? null, exp = f.expires_at ?? bid?.expires_at ?? null;
      const here = (f.region ?? REGION) === REGION;
      return { ...f, deal, bid, here, mine: here ? armed[deal] ?? null : null, left: exp == null ? null : exp - t };
    });
  }
  // Saved once the server shows the change, so a dry run or an unconfirmed send never claims a fill.
  const setArmed = (m, fn) => { const a = { ...(m.get().armed ?? {}) }; fn(a); m.set({ armed: a }); };
  function slotDecide(v, ctx, out) {
    const farms = v.owned('Farm');
    if (farms > 0 && apOwnsSlot(ctx)) return { wait: 'Autopilot keeps the Cotton slot', readout: 'Autopilot keeps the Cotton slot (autoShipCotton)' };
    if (!deals(ctx).length) return { wait: 'market board not loaded (open the Market page once)' };
    const m = ctx.mem('slot'), rearm = cfg.slotRearmMinutes * 120, fills = slotFills(v, ctx);
    const cotton = v.idI('Cotton'), never = neverIds(v), use = consumption(v);
    const expired = (f) => f.left != null && f.left <= 0;
    // Ours: the board is loaded, so a bid missing from it was filled or withdrawn.
    const ours = fills.filter((f) => f.mine), oursDone = (f) => !f.bid || expired(f) || f.left <= rearm;
    // A surplus fill ends at the keep line or once the item is an engine input (5.2 "Until"): the native slot ignores both.
    for (const f of ours.filter((x) => x.mine.mode === 'surplus' && !oursDone(x))) {
      const it = f.mine.item, spare = stockOf(v, it) - keepLine(v, out.rule, it, use);
      if (spare > 0 && !use[it] && !never.has(it)) continue;
      const why = never.has(it) || use[it] ? 'engine input now' : 'at the keep line';
      return { action: { id: 'slot:stop:' + f.deal, text: 'stop auto-ship slot: ' + itemName(v, it) + ' (' + why + ')',
        steps: [{ msg: { type: 'StopFilling', deal: f.deal }, until: (x) => { const ok = !x.st.standing_fills?.[f.deal]; if (ok) setArmed(m, (a) => delete a[f.deal]); return ok; } }] } };
    }
    const live = ours.find((f) => !oursDone(f));
    if (live) return { readout: 'slot: ' + itemName(v, live.mine.item) + ' bid #' + live.deal + ', ' + Math.floor(live.left / 120) + ' min left' };
    // A fill Core plan did not arm (the user, Autopilot, any region) holds the one slot until its own expiry, on the board or not.
    const user = fills.find((f) => !f.mine && !expired(f));
    if (user) {
      const txt = 'slot held by user fill #' + user.deal + (user.bid ? ' (' + itemName(v, user.bid.item) + ')' : '') + (user.left != null ? ', ' + Math.floor(user.left / 120) + ' min left' : '');
      return { wait: txt, readout: txt };
    }
    let pick = null, why = '', mode = 'cotton', amount = null;
    if (farms > 0) {
      pick = deals(ctx).filter((d) => d.item === cotton && bidOk(v, ctx, d)).sort((a, z) => unit(z) - unit(a))[0] ?? null;
      why = pick ? 'Cotton @ ' + usd2(unit(pick)) : 'no Cotton bid with a lot >= ' + num(cfg.slotLotMin) + ' and >= ' + cfg.slotMinMinutes + ' min left';
    } else {
      // Surplus slot: retail sells, the item is above its keep line and nothing in the plan eats it.
      if (ctx.retailOk !== true) return { wait: 'no Farms: slot left empty until retail sells (5.2)' };
      const cands = deals(ctx).filter((d) => !never.has(d.item) && d.item !== cotton && !use[d.item] && bidOk(v, ctx, d))
        .map((d) => ({ d, spare: Math.floor(stockOf(v, d.item) - keepLine(v, out.rule, d.item, use)) })).filter((c) => c.spare > 0)
        .sort((a, z) => z.spare * unit(z.d) - a.spare * unit(a.d));
      pick = cands[0]?.d ?? null; mode = 'surplus';
      // The native slot ships everything it is given: cap it at the spare above the keep line.
      amount = cands[0] ? Math.max(1, cands[0].spare) : null;
      why = pick ? 'surplus ' + num(amount) + ' ' + itemName(v, pick.item) + ' @ ' + usd2(unit(pick)) : 'no surplus item with a bid: slot left empty';
    }
    if (!pick) return { wait: why };
    // Re-arm. Same bid: KeepFilling again refreshes the fill (live 2026-11-22: since and expires_at reset to the renewed bid).
    // Another bid: clear our old fill and any expired entry first (one slot; a lingering entry would otherwise hold it).
    const stale = fills.filter((f) => f.here && f.deal !== pick.id && (f.mine || expired(f))).map((f) => f.deal);
    const steps = stale.map((id) => ({ msg: { type: 'StopFilling', deal: id }, until: (x) => { const ok = !x.st.standing_fills?.[id]; if (ok) setArmed(m, (a) => delete a[id]); return ok; } }));
    const item = pick.item;
    steps.push({ msg: { type: 'KeepFilling', deal: pick.id, region: REGION, amount },
      until: (x) => { const ok = !!x.st.standing_fills?.[pick.id]; if (ok) setArmed(m, (a) => { a[pick.id] = { item, mode }; }); return ok; } });
    return { action: { id: 'slot:' + pick.id, text: 'auto-ship slot: ' + why + (stale.length ? ' (re-arm)' : ''), steps } };
  }

  // ---- sell (wiki 6) ----------------------------------------------------------------------------------------------------------------
  function sellPlan(v, ctx, out) {
    const never = neverIds(v), cotton = v.idI('Cotton'), wood = v.idI('Wood');
    const use = consumption(v), rf = ctx.retail, t = tickOf(v, ctx);
    const filled = new Set(Object.keys(v.st.standing_fills ?? {}).map(Number));
    const jobs = ctx.sellJobs ?? [];
    const jobItems = new Set(jobs.map((j) => j.item)), jobDeals = new Set(jobs.map((j) => j.deal));
    const cool = ctx.mem?.('sell').get().cool ?? {}, now = ctx.now ?? 0;
    const kind = (i) => {
      if (never.has(i) || i === cotton || i === wood) return null;
      const it = v.C.items[i];
      if (!it) return null;
      if (it.category === 'Raw') return 'raw';
      if (/ Sheet$/.test(it.name)) return 'sheet';
      // Saturated: output keeps up with demand and the stock is a stretch of demand deep (wiki 6).
      const g = rf?.share != null ? rf.goods?.find((x) => x.id === i) : null;
      if (g) { const dem = cp._retail.demandH(g, rf.share); if (g.outTick * TPH >= dem && g.stock >= cfg.sellSaturatedHours * dem) return 'saturated shelf'; }
      return null;
    };
    const best = {};
    for (const d of deals(ctx)) {
      if (d.side !== 'Sell' || (d.region ?? REGION) !== REGION || filled.has(d.id) || d.expires_at - t < cfg.slotMinMinutes * 120) continue;
      if (!kind(d.item) || jobItems.has(d.item) || jobDeals.has(d.id) || (cool[d.id] ?? 0) > now) continue;
      if (!best[d.item] || unit(d) > unit(best[d.item])) best[d.item] = d;
    }
    const out2 = [];
    for (const d of Object.values(best)) {
      const keep = keepLine(v, out?.rule, d.item, use), load = Math.floor(COURIER_CU / Math.max(1, v.C.items[d.item]?.cargo_weight || 1));
      const spare = stockOf(v, d.item) - keep;
      if (spare < load) continue;   // full loads only: less than one load would just wait
      out2.push({ deal: d.id, item: d.item, name: itemName(v, d.item), kind: kind(d.item), keep, spare, unit: unit(d), value: spare * unit(d) });
    }
    return out2.sort((a, z) => z.value - a.value);
  }
  function sellDecide(v, ctx, out) {
    const as = ctx.mods?.autoSell, mem = ctx.mem('sell'), mine = mem.get().mine ?? [];
    const never = neverIds(v), use = consumption(v);
    // Our jobs follow the keep line (wiki 6 "Until"): a group that starts eating the item, or the next builds' kit, raises it.
    // autoSell keeps the keep it was started with, so a higher line restarts the job with it (start() updates an existing job).
    if (as && ctx.live) for (const j of (ctx.sellJobs ?? []).filter((x) => mine.includes(x.deal))) {
      if (never.has(j.item)) return { action: { id: 'sell:stop:' + j.deal, text: 'stop auto ship ' + itemName(v, j.item) + ' (engine input now)',
        run: async () => { try { as.stop(j.deal); mem.set({ mine: (mem.get().mine ?? []).filter((d) => d !== j.deal) }); return true; } catch { return null; } } } };
      const keep = keepLine(v, out?.rule, j.item, use), had = j.keep ?? 0;
      if (keep > Math.ceil(had * 1.02)) return { action: { id: 'sell:keep:' + j.deal + ':' + keep, text: 'auto ship ' + itemName(v, j.item) + ': keep ' + num(had) + ' -> ' + num(keep),
        run: async () => {
          try { as.start({ deal: j.deal, total: j.left ?? null, keep, fullLoads: j.fullLoads ?? true }); } catch { return null; }
          return (as.jobs?.() ?? []).some((x) => x.deal === j.deal && x.keep >= keep) ? true : null;
        } } };
    }
    const plan = sellPlan(v, ctx, out);
    const readout = plan.map((p) => p.name + ' #' + p.deal + ' keep ' + num(p.keep) + ' spare ' + num(p.spare) + ' (' + p.kind + ')');
    if (!plan.length) return { readout: [] };
    if (!as) return { wait: 'Auto ship (autoSell) is not loaded', readout };
    if (!ctx.live) return { wait: 'dry run: would auto ship ' + plan[0].name + ' above ' + num(plan[0].keep), readout };
    const p = plan[0];
    return { readout, action: { id: 'sell:' + p.deal, text: 'auto ship ' + p.name + ' @ ' + usd2(p.unit) + ', keep ' + num(p.keep) + ', full loads',
      run: async () => {
        try { as.start({ deal: p.deal, total: null, keep: p.keep, fullLoads: true }); }
        catch { return null; }           // bid gone or Market page not loaded: not a server failure
        const ok = (as.jobs?.() ?? []).some((j) => j.deal === p.deal);
        if (ok) mem.set({ mine: [...new Set([...(mem.get().mine ?? []), p.deal])] });
        return ok ? true : null;
      } } };
  }

// continues the cp-cadence closure from cp-cadence-1.js (same try / IIFE)
  // ---- cadence (wiki 13) -------------------------------------------------------------------------------------------------------------
  // Fires once per period; the clock is anchored at first sight, so a sleep gives one catch-up fire, not several.
  function tickPeriods(m, now) {
    const o = m.get(), fired = { hourly: false, six: false }, patch = {};
    for (const [k, last, per, cnt] of [['hourly', 'hLast', HOUR, 'hFires'], ['six', 'sLast', SIX, 'sFires']]) {
      const l = o[last];
      if (l == null || now - l >= per) { fired[k] = true; patch[last] = l == null ? now : now - ((now - l) % per); patch[cnt] = (o[cnt] ?? 0) + 1; }
    }
    if (Object.keys(patch).length) m.set(patch);
    return fired;
  }
  const chk = (id, ok, why) => ({ id, ok, why });
  function powerLoad(v) {
    let mw = 0;
    for (const g of v.groups) if (!g.paused && g.count > 0) mw += (v.bld(g.building).draws?.power ?? 0) * g.count;
    return mw;
  }
  function hourlyChecks(v, ctx, out) {
    const c = [];
    const lr = ctx.mods?.labRunner;
    if (v.owned('Manufacturing Lab') > 0) c.push(chk('lab', !!(lr?.running && lr.cfg?.dryRun === false), !lr ? 'Lab runner not loaded' : !lr.running ? 'Lab runner stopped' : lr.cfg?.dryRun !== false ? 'Lab runner is a dry run' : 'Lab runner live'));
    if (v.owned('Farm') > 0 && !deals(ctx).length) c.push(chk('autoship', null, 'market board not loaded (open the Market page once)'));
    else if (v.owned('Farm') > 0) {
      const f = activeFills(v, ctx).sort((a, z) => z.left - a.left)[0];
      c.push(chk('autoship', !!f && f.left >= cfg.slotRearmMinutes * 120, !f ? 'no auto-ship running' : itemName(v, f.bid.item) + ' auto-ship, ' + Math.floor(f.left / 120) + ' min left'));
    }
    const sub = v.st.subscriptions?.[REGION]?.power ?? 0, load = powerLoad(v), au = ctx.mods?.autoUtil;
    if (load > 0) c.push(chk('power', !!au?.conf?.power?.on && sub >= load, (au?.conf?.power?.on ? 'Auto power on' : 'Auto power off') + ', ' + sub + ' MW subscribed for ' + load + ' MW load'));
    const floor = sub * 12000;
    c.push(chk('cash', v.money >= floor, 'money ' + usd(v.money) + (v.money >= floor ? ' >= ' : ' < ') + 'bill floor ' + usd(floor) + ' (2 h of bills)'));
    if (out.stage === 'D' || out.stage === 'END') {
      const rf = ctx.retail;
      if (!rf?.goods) c.push(chk('shelves', null, 'retail board unreadable'));
      else if (rf.share == null) c.push(chk('shelves', null, 'retail share unknown'));
      else {
        const low = storeItems(v).filter((i) => shelfHours(rf, i) < cfg.shelfHours);
        c.push(chk('shelves', !low.length, low.length ? 'under ' + cfg.shelfHours + ' h: ' + low.map((i) => itemName(v, i)).join(', ') : 'every shelf >= ' + cfg.shelfHours + ' h'));
      }
    }
    return c;
  }
  function sixHourChecks(v, ctx, out) {
    const r = out.rule, c = [];
    c.push(chk('land', !!r, r ? 'land rule: last acre #' + r.lastAcre + ', T_wall ' + (+r.tWall).toFixed(1) + ' h, ' + (r.acresToBuy ?? 0) + ' acres to buy' : 'land rule unavailable'));
    const fm = cp._lab.freeModules(v);
    c.push(chk('modules', !fm.length, fm.length ? fm.length + ' module(s) not installed: ' + fm.map((d) => d.name ?? '#' + d.id).join(', ') : 'all modules installed'));
    const builds = nextBuilds(v, r, cfg.kitWaveBuilds), kit = kitOf(v, builds);
    const short = Object.entries(kit).filter(([i, n]) => stockOf(v, +i) < n);
    c.push(chk('kit', !short.length, short.length ? 'next wave (' + builds.join(', ') + ') short of ' + short.map(([i, n]) => num(n - stockOf(v, +i)) + ' ' + itemName(v, +i)).join(', ') : 'kit stock covers the next ' + builds.length + ' builds'));
    // shortcut: readout only, the payload shape is unverified; act on it once a live capture shows its fields.
    const we = ctx.worldEvents, ago = we ? Math.max(0, (ctx.now ?? Date.now()) - we.at) : 0;
    c.push(chk('world', null, we ? 'world events: last WorldEvents message ' + (ago < HOUR ? Math.round(ago / 60000) + ' min' : (ago / HOUR).toFixed(1) + ' h') + ' ago: ' + String(we.raw).slice(0, 200) : 'no WorldEvents message seen'));
    return c;
  }
  // Each check set runs when its period fires (and once on first sight); between fires the readout shows the saved results.
  function cadenceDecide(v, ctx, out) {
    const o = ctx.mem('cadence').get(), fired = ctx.cadenceFired ?? { hourly: false, six: false };
    const evaluated = { hourly: !!fired.hourly || !o.hourly, six: !!fired.six || !o.six };
    const hourly = evaluated.hourly ? hourlyChecks(v, ctx, out) : o.hourly;
    const six = evaluated.six ? sixHourChecks(v, ctx, out) : o.six;
    const failing = [...hourly, ...six].filter((x) => x.ok === false);
    return { readout: { fired, evaluated, fires: { hourly: o.hFires ?? 0, six: o.sFires ?? 0 }, failing: failing.map((x) => x.id + ': ' + x.why), hourly, six, at: o.at ?? null } };
  }
  // Runs in the next step's context on the last plan: saves fresh check results and alerts on a check that newly fails.
  // Outside the action queue on purpose: a dry run alerts too, and no other director's pending action delays it.
  function cadenceSettle(prev, m, now, notify = (...a) => core?.notify?.(...a)) {
    const rc = prev?.readouts?.cadence;
    if (!rc?.evaluated || (!rc.evaluated.hourly && !rc.evaluated.six)) return null;
    const o = m.get(), patch = { at: now };
    if (rc.evaluated.hourly) patch.hourly = rc.hourly;
    if (rc.evaluated.six) patch.six = rc.six;
    const failing = [...(patch.hourly ?? o.hourly ?? []), ...(patch.six ?? o.six ?? [])].filter((x) => x.ok === false);
    const ids = failing.map((x) => x.id).sort(), fresh = ids.filter((id) => !(o.notified ?? []).includes(id));
    if (fresh.length) try { notify('CP', 'Core plan check failing', failing.filter((x) => fresh.includes(x.id)).map((x) => x.why).join('; ')); } catch {}
    m.set({ ...patch, notified: ids });
    return { ids, fresh };
  }

  // ---- offline (wiki 13 "Before going offline", account-and-offline.md) ---------------------------------------------------------
  function canSaveDesign(st, recipe) { return Object.keys(st?.designs?.[recipe] ?? st?.designs?.[String(recipe)] ?? {}).length < (st?.premium ? 10 : 4); }
  function offlinePlan(v, hours, opts = {}) {
    const premium = opts.premium ?? !!v.st.premium, cap = premium ? 168 : 24, list = [], sends = [];
    const add = (id, ok, text) => list.push({ id, ok, text });
    add('cap', hours <= cap, hours <= cap ? hours + ' h is inside the ' + cap + ' h offline cap' : hours + ' h is over the ' + cap + ' h offline cap (' + (premium ? 'premium' : 'free plan') + '): production stops after ' + cap + ' h');
    // Unlocks: queueing charges CD and the prototype at once, so they are budgeted together. Oil Rig is never queued (retail checkpoint first).
    const queue = v.st.research_queue ?? [], busyB = v.research?.building ?? null;
    const pending = new Set([busyB, ...queue.map((q) => q.building)].filter((b) => b != null));
    const retailGo = opts.retailOk === true;   // Oil Rig only on a pass, of either checkpoint run (plan D-2), as the live plan
    let cd = v.cd; const stock = { ...(v.st.stock?.[REGION] ?? {}) };
    const tech = (b) => v.N.techs.find((t) => t.building === b);
    const affordable = (b) => { const t = tech(b); if (!t || cd < t.cost) return false; return (v.bld(b).build_items ?? []).every((i) => (stock[i.item] ?? 0) >= i.amount); };
    const take = (b) => { cd -= tech(b).cost; for (const i of v.bld(b).build_items ?? []) stock[i.item] = (stock[i.item] ?? 0) - i.amount; };
    const reqOk = (b, allowPending) => { const t = tech(b); if (!t || t.requires == null) return !!t; return v.st.unlocked_buildings?.includes(t.requires) || v.C.buildings[t.requires]?.name === 'Lumber Camp' || (allowPending && pending.has(t.requires)); };
    const names = [];
    if (premium) {
      let slots = 5 - queue.length - (busyB != null ? 1 : 0), idle = busyB == null;
      for (const n of UNLOCKS) {
        const b = v.idB(n);
        if (b == null || v.unlocked(n) || pending.has(b) || slots <= 0) continue;
        // Oil Rig: started on an idle slot once retail passed, never queued behind the store (wiki 13 step 1, plan Decisions).
        if (n === 'Oil Rig' && !(idle && retailGo)) break;
        if (!reqOk(b, true) || !affordable(b)) break;
        sends.push({ type: idle ? 'StartTech' : 'QueueTech', building: b, region: REGION });
        take(b); pending.add(b); names.push(n); slots--; idle = false;
      }
    } else if (busyB == null) {
      // Free plan: StartTech only (a busy StartTech is ignored). Of the unlocks that can start now, the longest.
      const due = UNLOCKS.filter((n) => n !== 'Oil Rig' || retailGo).map((n) => v.idB(n))
        .filter((b) => b != null && !v.unlocked(v.C.buildings[b].name) && reqOk(b, false) && affordable(b)).sort((a, z) => (tech(z)?.ticks ?? 0) - (tech(a)?.ticks ?? 0));
      if (due.length) { sends.push({ type: 'StartTech', building: due[0], region: REGION }); names.push(v.C.buildings[due[0]].name); }
    }
    const busyName = busyB != null ? v.C.buildings[busyB]?.name ?? 'building ' + busyB : null;
    // Only the Oil Rig is left and retail has not passed: that is the plan waiting, not a missed start.
    const oilWaits = !retailGo && !v.unlocked('Oil Rig') && UNLOCKS.slice(0, 2).every((n) => v.unlocked(n));
    add('unlock', names.length > 0 || busyB != null || oilWaits || UNLOCKS.every((n) => v.unlocked(n)),
      names.length ? (premium ? 'queue ' : 'start ') + names.join(' -> ') : busyName ? 'research running: ' + busyName : UNLOCKS.every((n) => v.unlocked(n)) ? 'all three unlocks are in'
        : oilWaits ? 'Oil Rig waits for the retail checkpoint' : 'no unlock can start (CD, prototype or prerequisite missing)');
    const mw = v.st.subscriptions?.[REGION]?.power ?? 0, need = mw * 6000 * hours;
    add('cash', v.money >= need, 'cash ' + usd(v.money) + (v.money >= need ? ' >= ' : ' < ') + mw + ' MW x $60 x ' + hours + ' h = ' + usd(need));
    if (v.owned('Retail Store') > 0) {
      const rf = opts.retail?.goods ? opts.retail : null, items = storeItems(v);
      const low = rf ? items.filter((i) => shelfHours(rf, i) < hours) : [];
      if (rf && rf.share == null) add('shelves', null, 'retail share unknown: stock the shelves for ' + hours + ' h');
      else add('shelves', rf ? !low.length : null, !rf ? 'retail board unreadable: stock the shelves for ' + hours + ' h' : low.length ? 'shelves run dry before ' + hours + ' h: ' + low.map((i) => itemName(v, i)).join(', ') : 'every shelf holds ' + hours + ' h');
    } else add('shelves', true, 'no Retail Store yet');
    add('autoship', true, 'auto-ship and distributor sales stop while away');
    return { hours, premium, capHours: cap, ok: list.every((x) => x.ok !== false), checklist: list, sends };
  }
  function offline(hours) {
    const w = core.walk(true);
    if (!w?.st || !w.catalog) return { error: 'game state not readable' };
    const v = cp._view(w.st, w.catalog, w.deals ?? []);
    let retail = null;
    try { const j = w.engine?.retailJson?.(); retail = cp._retail.facts(v, { retailBoard: typeof j === 'string' ? JSON.parse(j) : j }); } catch {}
    // The retail checkpoint as the last step saw it (the retail director's context sets it; saved by the cadence context).
    const cm = memRef?.('cadence').get() ?? {};
    return offlinePlan(v, +hours, { retail, retailOk: cm.retailOk ?? null });
  }

  // ---- resume groups paused by an unpaid bill (plan D7, D-4: Autopilot's observe() + resume step, moved here) -------------
  // A powered group seen running, then paused while cash is under ~2 bills (or the subscription is below the load), was paused by an
  // unpaid bill; any other pause, and a group already paused when first seen, is the user's and is never touched (Autopilot's rule).
  // The load is the one before the pause (groups seen running last step): Auto utilities sizes the subscription to running groups, so
  // counting paused ones would read every pause as a bill. Judged once, when the pause is first seen. A pause Core plan sent in the last
  // cfg.resumeGraceMin minutes (ctx.pauseSent) is a director's even before its own mem says so (the Kiln / FT gates write on confirm).
  const lastPaused = new Map();                  // this session only, like Autopilot: a group paused before the load counts as yours
  const drawOf = (v, g) => v.bld(g.building).draws?.power ?? 0;
  const powerHave = (v) => v.st.subscriptions?.[REGION]?.power ?? 0;
  function resumeObserve(v, m, ctx = {}) {
    const before = v.groups.reduce((a, g) => a + (lastPaused.get(g.id) === false ? drawOf(v, g) * g.count : 0), 0), have = powerHave(v);
    const billShort = have < before || v.money < Math.max(have, before) * 1000 * 2;
    const sent = ctx.pauseSent ?? {}, grace = (cfg.resumeGraceMin ?? 2) * 60000;
    const o = m.get(), bill = new Set(o.bill ?? []), user = new Set(o.user ?? []);
    let changed = false;
    for (const g of v.groups) {
      const prev = lastPaused.get(g.id);
      if (g.paused && prev !== true && !bill.has(g.id) && !user.has(g.id)) { (prev === false && billShort && drawOf(v, g) > 0 && !(ctx.now - sent[g.id] < grace) ? bill : user).add(g.id); changed = true; }
      if (!g.paused && (bill.delete(g.id) | user.delete(g.id))) changed = true;
      lastPaused.set(g.id, !!g.paused);
    }
    if (changed) m.set({ bill: [...bill], user: [...user] });
  }
  // Groups Autopilot's earlyGame.keepPaused(id) marked: never resumed. Autopilot does not expose the list; it saves it in localStorage
  // 'earlyGame.v2' (.keptPaused). Read at call time; a missing key, bad JSON or a non-array is an empty list.
  function keptPaused() {
    try { const a = JSON.parse(W.localStorage?.getItem('earlyGame.v2') ?? 'null')?.keptPaused; return Array.isArray(a) ? a.map(Number) : []; } catch { return []; }
  }
  // One SetPaused false per step once the bills are affordable: cash >= Autopilot's floor (1 h of bills, min $100, the group counted)
  // + one bill for it, and the subscription covers the load with it. Groups a director paused on purpose (Kiln gate, WF gate,
  // endgame stock gate) and Autopilot's kept-paused ones stay.
  function resumeDecide(v, ctx) {
    if (!ctx.mem) return null;
    const bo = ctx.mem('buildout').get(), em = ctx.mem('endgame').get();
    const mine = new Set([...(bo.kilnMine ?? []), ...(bo.ftMine ?? []), ...(em.egMine ?? []), ...(ctx.apKept ?? [])]);
    const bill = new Set(ctx.mem('resume').get().bill ?? []);
    const list = v.groups.filter((g) => g.paused && g.count > 0 && bill.has(g.id) && !mine.has(g.id));
    if (!list.length) return null;
    const eg = ctx.mods?.earlyGame;
    if (eg?.running && eg.cfg?.resumePaused !== false) return { wait: 'Autopilot resumes the ' + list.length + ' bill-paused group(s) while it runs' };   // one driver per job
    const have = powerHave(v), load = powerLoad(v), waits = [];
    for (const g of list) {
      const mw = drawOf(v, g) * g.count, name = '"' + (g.name ?? v.bld(g.building).name) + '"';
      if (have < load + mw) { waits.push(name + ' is paused (unpaid bill?): power subscription ' + have + ' MW < ' + (load + mw) + ' MW with it'); continue; }
      const need = Math.max(10000, (Math.max(have, load) + mw) * 1000 * 6) + mw * 1000;
      if (v.money < need) { waits.push(name + ' is paused (unpaid bill?): waiting for cash ' + usd(v.money) + ' / ' + usd(need) + ' to resume'); continue; }
      return { action: { id: 'resume:' + g.id, text: 'resume ' + name + ' (paused by an unpaid bill, bills affordable again)',
        steps: [{ msg: { type: 'SetPaused', group: g.id, paused: false }, until: (x) => !x.groups.find((y) => y.id === g.id)?.paused }] } };
    }
    return { wait: waits.join(' | ') };
  }

// continues the cp-cadence closure from cp-cadence-2.js (same try / IIFE)
  // ---- Auto utilities on from Stage A (plan D1, wiki 8.1 step 1, 8.2) ------------------------------------------------------------------
  // Like the ladder's autoStart: switched on once per Live session. Why it went off comes from autoUtil's ledger lines: "Auto <u> off" with no
  // stop-all line right after it is the user's (sticky until they switch it on again); with one it is Alt+Shift+X, and "switched off" is its
  // own 3-failure stop: both wait for Core plan's next Live session.
  // The ledger is read only while Core plan steps. A switch-off while it was stopped, whose line has left the ledger, is read from state at
  // the start of a Live session: power off, no ledger line why, and mem says Core plan had switched it on (cpOn) = the user's (sticky).
  // Never switched on by Core plan: it is switched on.
  const UTIL_LOAD = Math.random().toString(36).slice(2, 8);
  let utilSession = 0, utilLiveAt = 0;
  function utilOffWhy(util, list) {
    let stopAt = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.mod === '--' && /^stop all/.test(e.text)) { stopAt = e.t; continue; }
      if (e.mod !== 'AU') continue;
      if (e.text === 'Auto ' + util + ' on') return null;
      if (e.text.startsWith('Auto ' + util + ' switched off')) return 'error';
      if (e.text === 'Auto ' + util + ' off') return stopAt && stopAt - e.t < 5000 ? 'pause' : 'user';
    }
    return null;   // no switch-off in the ledger
  }
  // Reading the ledger is not pure: done here, and the switch-off kept in mem (the ledger holds 300 lines) until the switch is seen on.
  function utilContext(v, ctx) {
    const gap = 3 * (cfg.intervalMs ?? 5000);
    let fresh = false;   // the first step of a Live session
    if (ctx.live) { if (!utilLiveAt || ctx.now - utilLiveAt > gap) { utilSession++; fresh = true; } utilLiveAt = ctx.now; }
    else utilLiveAt = 0;   // dry run: going Live again is a new session
    ctx.utilSession = UTIL_LOAD + ':' + utilSession;
    const au = ctx.mods?.autoUtil;
    if (!au?.conf || !ctx.mem) return;
    let list = [];
    try { list = core?.ledger?.list?.() ?? []; } catch {}
    const mm = ctx.mem('utilities');
    for (const u of ['power', 'water']) {
      const off = mm.get().off ?? {};
      if (au.conf[u]?.on) { if (off[u]) mm.set({ off: { ...off, [u]: null } }); continue; }
      if (off[u]) continue;
      const why = utilOffWhy(u, list) ?? (fresh && mm.get().cpOn?.[u] ? 'user' : null);
      // first step of a session: a stop-all or error stop happened while Core plan was stopped too, so it belongs to a past session
      if (why) mm.set({ off: { ...off, [u]: { why, session: fresh && why !== 'user' ? null : ctx.utilSession } } });
    }
  }
  function utilDecide(v, ctx) {
    const au = ctx.mods?.autoUtil;
    if (!au?.conf || !ctx.mem) return null;
    const m = ctx.mem('utilities').get(), sid = ctx.utilSession, alerts = [];
    const water = v.groups.some((g) => !g.paused && g.count > 0 && (v.bld(g.building).draws?.water ?? 0) > 0);
    const readout = { power: au.conf.power?.on ? 'on' : 'off', water: au.conf.water?.on ? 'on' : water ? 'off' : 'off (no running group draws water)', alerts };
    for (const u of ['power', 'water']) {
      if (au.conf[u]?.on || (u === 'water' && !water)) continue;
      const off = m.off?.[u];
      if (off?.why === 'user') { alerts.push('Auto ' + u + ' was switched off by you: Core plan does not switch it back on'); continue; }
      if (off ? off.session === sid : m.armed?.[u] === sid) { alerts.push('Auto ' + u + ' went off (' + (off?.why === 'pause' ? 'Alt+Shift+X' : off?.why === 'error' ? 'the game did not apply its changes' : 'not by a switch') + '): switched on again in the next Live session'); continue; }
      return { readout, action: { id: 'utilities:' + u, text: 'Auto utilities: ' + u + ' on (wiki 8.1' + (u === 'water' ? ', a running group draws water' : '') + ')',
        run: async () => {
          au.set(u, true);
          const mm = ctx.mem('utilities'), ok = au.conf[u]?.on === true;
          mm.set({ armed: { ...(mm.get().armed ?? {}), [u]: sid }, off: { ...(mm.get().off ?? {}), [u]: null }, ...(ok ? { cpOn: { ...(mm.get().cpOn ?? {}), [u]: true } } : {}) });
          return ok;
        } } };
    }
    return { readout };
  }

  // ---- registration ------------------------------------------------------------------------------------------------------------------
  // The server tick now: the core's clock (last tick seen + elapsed), never behind the last mutation tick.
  let memRef = null;                             // ctx.mem, for corePlan.offline() outside a step
  const setTick = (v, ctx) => { if (ctx.tick == null) { let t = 0; try { t = core?.nowTick?.() ?? 0; } catch {} ctx.tick = Math.max(t, v.mutTick ?? 0); } };
  cp.addDirector({
    name: 'resume', order: 10, always: true,   // always: a bill pause can make cash fall (S6) and drop the stage
    defaults: { resumeGraceMin: 2 },   // minutes after a SetPaused Core plan sent in which a pause of that group is the director's
    context(v, ctx) { ctx.apKept = keptPaused(); if (ctx.mem) resumeObserve(v, ctx.mem('resume'), ctx); },
    decide: resumeDecide,
    duties: () => [{ duty: 'resume groups paused by an unpaid bill (waits while Autopilot runs with resumePaused on)', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'utilities', order: 12, always: true,   // always: from the first step, before a stage holds (wiki 8.1 step 1)
    context: utilContext, decide: utilDecide,
    duties: () => [{ duty: 'Auto utilities: power on, water on while a group draws water', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'slot', order: 70,
    defaults: { dir_slot: true, slotLotMin: 150000, slotMinMinutes: 60, slotRearmMinutes: 15 },
    context(v, ctx) {
      setTick(v, ctx);
      // Forget fills that are gone from the server.
      const m = ctx.mem('slot'), a = m.get().armed ?? {}, sf = v.st.standing_fills ?? {};
      const gone = Object.keys(a).filter((id) => !sf[id]);
      if (gone.length) setArmed(m, (x) => { for (const id of gone) delete x[id]; });
    },
    decide: slotDecide,
    duties: () => [{ duty: 'native Cotton auto-ship slot (Core plan acts only while Autopilot is stopped or autoShipCotton is off)', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'sell', order: 75,
    defaults: { dir_sell: true, sellKeepHours: 48, sellKitBuilds: 3, sellSaturatedHours: 24, sellCooldownMinutes: 60 },
    context(v, ctx) {
      setTick(v, ctx);
      let read = false;
      if (ctx.sellJobs == null) { try { ctx.sellJobs = ctx.mods?.autoSell?.jobs?.() ?? null; read = Array.isArray(ctx.sellJobs); } catch {} ctx.sellJobs ??= []; } else read = true;
      if (!read || !ctx.mods?.autoSell) return;
      // A job we started that autoSell ended by itself (5 unconfirmed sends, bid filled, user stop) cools down before that bid
      // is tried again: an instant restart would loop unconfirmed sends forever without tripping the 3-fail stop.
      const m = ctx.mem('sell'), o = m.get(), now = ctx.now ?? 0, have = new Set(ctx.sellJobs.map((j) => j.deal));
      // A job autoSell moved to another bid (its `from` is our old id) is still ours. shortcut: only the last move is remembered, so a job that moves twice between two ticks is lost; upgrade to a chain if that is ever seen.
      const was = o.mine ?? [], mine = was.map((d) => ctx.sellJobs.find((j) => j.from === d)?.deal ?? d), ended = mine.filter((d) => !have.has(d));
      const cool = Object.fromEntries(Object.entries(o.cool ?? {}).filter(([, until]) => until > now));
      for (const d of ended) cool[d] = now + cfg.sellCooldownMinutes * 60000;
      if (ended.length || mine.some((d, i) => d !== was[i]) || Object.keys(cool).length !== Object.keys(o.cool ?? {}).length) m.set({ mine: mine.filter((d) => have.has(d)), cool });
    },
    decide: sellDecide,
    duties: () => [{ duty: 'Auto ship jobs for ore, stone, sheets and saturated shelves (keep line)', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'cadence', order: 80,
    defaults: { dir_cadence: true, shelfHours: 1, kitWaveBuilds: 3 },
    context(v, ctx) {
      setTick(v, ctx); memRef = ctx.mem;
      ctx.worldEvents ??= core?.sock?.worldEvents ?? null;
      const m = ctx.mem('cadence');
      if ((m.get().retailOk ?? null) !== (ctx.retailOk ?? null)) m.set({ retailOk: ctx.retailOk ?? null });
      cadenceSettle(cp.plan?.(), m, ctx.now ?? 0);
      ctx.cadenceFired = tickPeriods(m, ctx.now ?? 0);
    },
    decide: cadenceDecide,
    duties: () => [{ duty: 'hourly and 6-hour checks (alerts on a new failure)', owner: 'Core plan', done: true }],
  });
  cp.offline = offline;
  cp.canSaveDesign = canSaveDesign;
  cp.worldEvents = () => core?.sock?.worldEvents ?? null;
  cp._cadence = { utilDecide, utilOffWhy, slotDecide, sellPlan, sellDecide, cadenceDecide, cadenceSettle, tickPeriods, hourlyChecks, sixHourChecks, offlinePlan, canSaveDesign, resumeObserve, keptPaused, resumeDecide, keepLine, consumption, activeFills, slotFills, NEVER, TARGETS };
})();
} catch (e) { console.error('[IdleCorp] cp-cadence failed to load:', e); }
// @@END cp-cadence// ============================================================================
// CORE PLAN DIRECTOR 11: endgame prep and the Refinery start (corePlan director)
// ============================================================================
// Director "endgame" (wiki/guides/core-game-plan.md 12, plan D6). Off by default (cfg.dir_endgame) until a live run has checked it.
// Only once E1-E5 hold (out.finished / out.E), the Refinery start first when it can go, then one step at a time, each waiting on the one before it:
//   1. 1 Assembly Plant, bought into a new group "Wire Frame"; 2. that group on Wire Frame (default floor, x1);
//   3. Copper Mines on Mine Copper Ore, 5 per Smelter, the x3 merge floor applied before the first one;
//   4. one Smelter on Draw Copper Wire, the Smelt x3 floor applied before it;
//   5. stock gates: a production group pauses once every endgame target its output feeds is met and resumes when one is below
//      (Kiln-gate bookkeeping in mem('endgame'): egMine = paused here, egUser = resumed by you, left alone; the resume director skips egMine);
//   6. StartTech Refinery once 750,000 CD and its prototype are in hand, checked before steps 1-5. Its CD need is published from the moment E1-E5 hold.
// Before E1-E5 hold, or with cfg.dir_endgame off, only the resume half of step 5 runs (off: every group it paused), so no pause is stranded.
// Purchases: acres above the CD-farm buffer, BuyLand for the rest (E4 leaves no acre above the buffer), kit in stock, cash >= the money
// floor + land + price + bill floor. These buildings are not pending investments for E5: they come after the gate.
// Pure pieces on corePlan._endgame for the tests.
// @@MODULE cp-endgame
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const cp = W.corePlan, cfg = cp.cfg, usd = cp._usd;
  const TARGETS = cp._cadence?.TARGETS;          // the endgame stock (wiki 12), shared with the sell keep line
  if (!TARGETS) throw new Error('cp-cadence did not load');
  const REGION = 0, ACRE_CAP = 360;
  const MINES_PER_SMELTER = 5, SMELTERS = 1;     // Smelt x3 eats 600 Ore/h, a Mine on the x3 merge makes 144 (plan D6)
  // Each production group with every target downstream of it: it pauses only when all of them hold.
  const CHAIN = [
    { b: 'Assembly Plant', r: 'Wire Frame', feeds: ['Wired Frame'] },
    { b: 'Smelter', r: 'Draw Copper Wire', feeds: ['Copper Wire', 'Wired Frame'] },
    { b: 'Mine', r: 'Mine Copper Ore', feeds: ['Copper Ore', 'Copper Wire', 'Wired Frame'] },
  ];
  const num = (n) => Math.round(n).toLocaleString('en-US');
  const stockOf = (v, i) => v.st.stock?.[REGION]?.[i] ?? v.st.items?.[i] ?? 0;
  const itemName = (v, i) => v.C.items[i]?.name ?? 'item ' + i;
  const groupsOn = (v, b, r) => v.groups.filter((g) => g.building === b && g.recipe === r && g.count > 0);
  const setRecipe = (v, g, r) => ({ id: 'eg:recipe:' + g.id + ':' + r.id, text: 'endgame: group ' + g.id + ' (' + g.count + ' ' + v.bld(g.building).name + ') to ' + r.name,
    steps: [{ msg: { type: 'SetRecipe', group: g.id, recipe: r.id }, until: (x) => x.groups.find((y) => y.id === g.id)?.recipe === r.id }] });

  // One building bn for recipe r, into the biggest group on r, else a new group named after r (held: CD Farm and the pool tidy keep off it).
  function buyStep(v, ctx, bn, r, label) {
    const b = v.idB(bn), bd = v.bld(b);
    const acres = Math.max(0, cfg.bufferAcres + bd.acres - v.freeAcres);
    if (v.acresOwned + acres > ACRE_CAP) return { wait: label + ': no free acre and Heartland is at its cap (' + ACRE_CAP + ' acres)' };
    let land = 0;
    for (let i = 0; i < acres; i++) land += cp._acrePriceCents(v.landBought + i);
    const need = {};
    for (const x of [...(bd.build_items ?? []), ...(v.st.layouts?.[r.id]?.bom ?? bd.default_kit ?? [])]) need[x.item] = (need[x.item] ?? 0) + x.amount;
    const lack = Object.entries(need).filter(([i, a]) => stockOf(v, +i) < a).map(([i, a]) => Math.ceil(a - stockOf(v, +i)) + ' ' + itemName(v, +i));
    if (lack.length) return { wait: label + ': kit short: ' + lack.join(', ') };
    const price = W.idleCore.planner.price(bd.cost, v.owned(bn), 0), mw = bd.draws?.power ?? 0, bill = cp._billNeed(v, mw), floor = ctx.floorCents ?? 0;
    const want = floor + land + price + bill;
    if (v.money < want) return { wait: label + ': cash ' + usd(v.money) + ' < ' + usd(want) + ' (money floor + ' + (land ? acres + ' acre(s) ' + usd(land) + ' + ' : '') + usd(price) + ' + ' + mw + ' MW bills)' };
    const g = groupsOn(v, b, r.id).sort((a, z) => z.count - a.count)[0], steps = cp._buySteps(v, b, acres, g, r.name);
    return { action: { id: 'eg:buy:' + bn + ':' + v.owned(bn), text: 'endgame: buy ' + (acres ? acres + ' acre(s) ' + usd(land) + ' + ' : '') + label + ' ' + usd(price) + (g ? ' into group ' + g.id : ' (new group "' + r.name + '")'), steps, hold: true } };
  }
  // n buildings bn on recipe rn: a group named after rn that has no recipe yet gets it, the floor goes on before the first building
  // (no building on the recipe: no parts to pay), then one purchase per step. null once n run it.
  // After an EditLayout the server did not apply, that recipe's floor waits cfg.floorRetryMin (cp._floorAction), as buildout's floorStep.
  function buildStep(v, ctx, bn, rn, n, floor) {
    const b = v.idB(bn), r = v.C.recipes[v.idR(rn)];
    if (b == null || !r) return { wait: 'manual: the catalog has no ' + (b == null ? bn : rn) };
    const bare = v.groups.find((g) => g.building === b && g.count > 0 && g.recipe == null && g.name === r.name);
    if (bare) return { action: setRecipe(v, bare, r) };
    const have = groupsOn(v, b, r.id).reduce((a, g) => a + g.count, 0);
    if (have >= n) return null;
    const label = bn + ' (' + rn + ') ' + (have + 1) + '/' + n;
    if (floor && !v.st.layouts?.[r.id]) {
      const obj = cp._floorObj(floor.key);
      if (!obj) return { wait: label + ': no ' + floor.label + ' design in the core' };
      if (have > 0) return { wait: label + ': manual: apply the ' + floor.label + ' to ' + rn + ' (' + have + ' ' + bn + ' already run it without)' };
      return cp._floorAction(ctx, 'endgame', r.id, r, obj, label + ': the server did not apply the ' + floor.label, { id: 'eg:floor:' + r.id, text: 'endgame: apply the ' + floor.label + ' to ' + rn + ' (before its first ' + bn + ')' });
    }
    return buyStep(v, ctx, bn, r, label);
  }
  // Steps 1-2: an Assembly Plant you own already counts; one with no recipe goes on Wire Frame, one on another recipe is left to you.
  function plantStep(v, ctx) {
    const b = v.idB('Assembly Plant'), r = v.C.recipes[v.idR('Wire Frame')];
    if (b == null || !r) return { wait: 'manual: the catalog has no ' + (b == null ? 'Assembly Plant' : 'Wire Frame') };
    if (groupsOn(v, b, r.id).length) return null;
    const idle = v.groups.find((g) => g.building === b && g.count > 0 && g.recipe == null);
    if (idle) return { action: setRecipe(v, idle, r) };
    if (v.owned('Assembly Plant') > 0) return { wait: 'manual: your Assembly Plant runs another recipe or sits in the pool: put one on Wire Frame' };
    return buyStep(v, ctx, 'Assembly Plant', r, 'Assembly Plant');
  }

  // Step 5: pause at the targets, resume below (only groups paused here; one you resumed is yours from then on).
  // mode 'resume': the resume half alone (E1-E5 not holding: a pause is never stranded); 'off' (cfg.dir_endgame false): every group it paused comes back.
  const confirmed = (a, fn) => { const u = a.steps[0].until; a.steps[0].until = (x) => { const ok = u(x); if (ok) fn(); return ok; }; return a; };
  function gateStep(v, ctx, mode) {
    const m = ctx.mem?.('endgame');
    if (!m) return null;
    const o = m.get(), mine = new Set(o.egMine ?? []), user = new Set(o.egUser ?? []);
    const note = (gid, add) => () => { const s = new Set(m.get().egMine ?? []); if (add) s.add(gid); else s.delete(gid); m.set({ egMine: [...s] }); };
    const met = (n) => v.has(n) >= TARGETS.find(([x]) => x === n)[1];
    const act = (g, why, paused) => ({ id: 'eg:pause:' + g.id + ':' + paused, text: 'endgame stock gate (' + why + '): ' + (paused ? 'pause' : 'resume') + ' group ' + g.id,
      steps: [{ msg: { type: 'SetPaused', group: g.id, paused }, until: (x) => !!x.groups.find((y) => y.id === g.id)?.paused === paused }] });
    const resume = (g, why) => {
      const mw = (v.bld(g.building).draws?.power ?? 0) * g.count, need = (ctx.floorCents ?? 0) + cp._billNeed(v, mw);
      if (v.money < need) return { wait: 'stock gate: resume group ' + g.id + ' waits: cash ' + usd(v.money) + ' < ' + usd(need) + ' (money floor + ' + mw + ' MW bills)' };
      return { action: confirmed(act(g, why, false), note(g.id, false)) };
    };
    if (mode === 'off') {
      const g = v.groups.find((x) => mine.has(x.id) && !user.has(x.id) && x.paused && x.count > 0);
      return g ? resume(g, 'endgame off') : null;
    }
    for (const c of CHAIN) {
      const full = c.feeds.every(met), why = c.r + (full ? ': ' + c.feeds.join(', ') + ' at target' : ': ' + c.feeds.filter((n) => !met(n)).join(', ') + ' below target');
      for (const g of groupsOn(v, v.idB(c.b), v.idR(c.r))) {
        if (user.has(g.id)) continue;
        if (!g.paused && full && mode !== 'resume') return { action: confirmed(act(g, why, true), note(g.id, true)) };
        if (g.paused && !full && mine.has(g.id)) return resume(g, why);
      }
    }
    return null;
  }

  function endgameDecide(v, ctx, out) {
    const checklist = TARGETS.map(([n, want]) => ({ item: n, have: Math.floor(v.has(n)), want, ok: v.has(n) >= want }));
    const finished = !!out.finished || (Array.isArray(out.E) && out.E.length > 0 && out.E.every((c) => c.ok));
    if (!finished) {
      const r = gateStep(v, ctx, 'resume');
      return { ...(r ?? {}), wait: r?.wait ?? (r?.action ? undefined : 'end conditions E1-E5 not all true'), readout: { checklist } };
    }
    const b = v.idB('Refinery'), t = b == null ? null : v.N.techs.find((x) => x.building === b), cost = t?.cost ?? 750000;
    const preOk = !t?.requires || !!v.st.unlocked_buildings?.includes(t.requires);
    // The CD for the Refinery takes days to farm: asked for from the start, not after the builds.
    if (b != null && !v.unlocked('Refinery') && v.research?.building !== b) out.cdNeed = { b, name: 'Refinery', cd: cost, prereqsMet: preOk, note: preOk ? '' : 'needs Oil Rig first' };
    const ref = refineryStep(v, b, t, cost, preOk);
    if (ref.action) return { ...ref, readout: { checklist } };   // first: the slot, CD and frames in hand start it whatever the builds wait for
    for (const step of [() => plantStep(v, ctx),
      () => buildStep(v, ctx, 'Mine', 'Mine Copper Ore', MINES_PER_SMELTER * SMELTERS, { key: 'mineX3', label: 'x3 merge floor' }),
      () => buildStep(v, ctx, 'Smelter', 'Draw Copper Wire', SMELTERS, { key: 'smeltX3', label: 'Smelt x3 floor' }),
      () => gateStep(v, ctx)]) {
      const r = step();
      if (r) return { ...r, readout: { checklist } };
    }
    return { ...ref, readout: { checklist } };
  }
  // Step 6: StartTech Refinery, or why not yet.
  function refineryStep(v, b, t, cost, preOk) {
    if (b == null) return { wait: 'manual: no building named Refinery' };
    if (v.unlocked('Refinery')) return { wait: 'Refinery unlocked' };
    const proto = v.bld(b).build_items ?? [];
    const lack = proto.filter((i) => stockOf(v, i.item) < i.amount);
    const why = 'Refinery';
    if (v.research?.building === b) return { wait: why + ': research running' };
    if (!preOk) return { wait: why + ': needs Oil Rig first' };
    if (v.research) return { wait: why + ': research slot busy' };
    if (v.cd < cost) return { wait: why + ': ' + num(v.cd) + ' / ' + num(cost) + ' CD' };
    if (lack.length) return { wait: why + ': need ' + lack.map((i) => Math.ceil(i.amount - stockOf(v, i.item)) + ' more ' + itemName(v, i.item)).join(', ') };
    return { action: { id: 'tech:' + b, text: 'unlock Refinery (' + num(cost) + ' CD + ' + proto.map((i) => i.amount + ' ' + itemName(v, i.item)).join(', ') + ')',
      steps: [{ msg: { type: 'StartTech', building: b, region: REGION }, until: (x) => x.research?.building === b || x.unlocked('Refinery') }] } };
  }

  // A group the gate paused that runs again was resumed by you: hands off from then on. One gone or emptied drops out.
  function egContext(v, ctx) {
    if (!ctx.mem) return;
    const m = ctx.mem('endgame'), o = m.get(), mine = o.egMine ?? [];
    if (!mine.length) return;
    const keep = [], user = [];
    for (const id of mine) { const g = v.groups.find((x) => x.id === id); if (g && g.count > 0 && g.paused) keep.push(id); else if (g && g.count > 0) user.push(id); }
    if (keep.length !== mine.length) m.set({ egMine: keep, ...(user.length ? { egUser: [...new Set([...(o.egUser ?? []), ...user])] } : {}) });
  }

  cp.addDirector({
    name: 'endgame', order: 90, always: true,   // always: the resume half of the stock gates runs with no stage too
    defaults: { dir_endgame: false },
    context: egContext,
    decide: endgameDecide,
    whenOff: (v, ctx) => gateStep(v, ctx, 'off'),   // turned off: the groups its gate paused come back
    duties: () => [{ duty: 'endgame: Assembly Plant, copper Mines, wire Smelter, stock gates, Refinery start (off unless cfg.dir_endgame)', owner: 'Core plan', done: cfg.dir_endgame === true }],
  });
  cp._endgame = { endgameDecide, gateStep, egContext, CHAIN, MINES_PER_SMELTER };
})();
} catch (e) { console.error('[IdleCorp] cp-endgame failed to load:', e); }
// @@END cp-endgame
// ============================================================================
// 2. AUTOPILOT
// ============================================================================
// @@MODULE early-game (test/early-game-sim.js evals everything from this line down)
//
// IdleCorp early-game autopilot: plays wiki/guides/early-game-plan.md, Phase 1 → Phase 5, over the game WebSocket.
// Install as a userscript (Tampermonkey / Violentmonkey) and open "Autopilot" in the game's sidebar,
// or paste into the DevTools console on https://idlecorp.net (logged in). Console API:
//
//   earlyGame.status()              // current phase, plan checklist, blockers, starved groups
//   earlyGame.plan()                 // the next action and why (sends nothing)
//   earlyGame.start()                // DRY RUN by default: logs actions, sends nothing
//   earlyGame.start({ dryRun: false })   // live
//   earlyGame.stop()
//   earlyGame.offline(8)             // before going offline: keep 8 h of power bills, show checklist
//   earlyGame.keepPaused(groupId)    // never auto-resume this group
//   earlyGame.panel(false)           // hide the on-page panel
//   earlyGame.hold('me') / earlyGame.release('me')   // pause after the current step / go on
//   earlyGame.exportCfg() / importCfg(obj) / resetCfg()   // settings (also: Export / Import / Reset in the panel)
//   idleCore.ledger.text()           // what Autopilot and CD Farm did, kept across reloads (panel: the Log tab)
//   idleCore.stopAll()               // same as Alt+Shift+X: stop Autopilot, CD Farm and the Lab runner
//
// Watching it: a stall alert (no plan progress for cfg.stallMinutes while actions keep coming) shows a banner,
// a tab-title badge and, once you press "Enable alerts", a desktop notification; so do phase changes and
// stops. With cfg.liveResume on, a reload of a tab that was running Live resumes Live after a 60 s cancel
// window (otherwise always as a dry run). Live also refuses to run when the game's data no longer looks
// like what this script expects.
//
// With CD Farm (the CD Farm module in this file): Autopilot pauses while CD Farm runs or finishes a step (CD Farm
// calls earlyGame.hold before it takes its baseline), never assigns or builds over the camps of an
// interrupted CD Farm run, and with cfg.boosterVia = 'cdFarm' hands its CD booster to CD Farm.
//
// Phases (each step is a check on live state, so it starts wherever the corp is):
//   1-2  Lumber Camps + Farms (Cotton), always the cheaper; part loads until 25 acres are full
//   2    Sawmill unlock + build (kit bought if needed); auto-ship Cotton
//   all  every item's full courier loads above its reserve are sold, best-paying first (like
//        auto-ship, for everything): Wood, Cotton, Gold Ore, surplus ore… never Planks or frames
//   3    buy land, 3 Sawmills, Workshop unlock at 155 CD + 205 Planks
//   4    2 Workshops on Frame Timber, 6 Sawmills, Mine → Quarry → Smelter;
//        4 Iron + 2 Coal Mines, Limestone Quarry, Smelter on Iron Sheet, leftover frames → Gold Mines
//   5    Workshop on Rivet Iron Frame; unlock Factory → Kiln → Paper Mill → Manufacturing Lab
//        (→ Dispatch Office if cfg.dispatchOffice). Never the Drafting Bureau.
//        CD for these comes from Gold Mines and, when land gets too dear, the plan's
//        build-and-demolish booster (tested on 1 building first, off if it doesn't work).
//
// Safety: one confirmed action at a time; failed actions back off (15 s → 10 min) so they
// never block the rest; cash never drops below the power-bill floor; land walls; buy-price cap;
// bill-paused groups resumed (groups you pause, any time, stay paused); waits through socket
// drops; after a reload resumes as a DRY RUN (dryRun is never remembered); one copy per browser;
// one buy order per item per 24 h; pauses while cdFarm runs; never sells Planks or frames;
// courier busy (freight cooldown, auto-ship) → courier work waits, with no back-off or errors.
// Floorplans: every task a group runs is scored (the game's own scorer when the page has it,
// else known rates) against a library of the best known designs plus your saved designs; the
// best is applied automatically with EditLayout as soon as every part it adds (for every
// building on the task) is in stock. Missing parts are bought only from the player market at
// up to cfg.floorBuyUsd ($1) per unit, or ordered at that price.
//   earlyGame.floors()             // table: task, buildings, current x, best x, parts, status
// Offline test from a $100 start: bun test/early-game-sim.js [rich|live|chaos] [hours]


try {
(() => {
  const core = typeof window !== 'undefined' ? window.idleCore : globalThis.idleCore;
  if (!core) throw new Error('the shared core did not load');
  const KEY = 'earlyGame.v2';
  const W = typeof window !== 'undefined' ? window : globalThis;
  const HAS_DOM = typeof document !== 'undefined' && !!document.body;
  const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
  if (W.earlyGame) W.earlyGame._unload?.();

  const REGION = 0;                 // Heartland
  const MONEY = 0, CD = 24, LD = 111;
  const WOOD = 1, PLANKS = 9, COTTON = 76, WFRAME = 41, IFRAME = 42;
  const STARTER_ACRES = 25;
  const FIRST_ACRE = 5000;          // cents; next = floor(prev * 41 / 40)
  const COURIER_CU = 10000;
  const MAX_POWER = 200;

  const B = {
    CAMP: 0, MINE: 1, QUARRY: 2, SAWMILL: 4, SMELTER: 5, KILN: 6, WORKSHOP: 8, FARM: 10,
    LAB: 14, FACTORY: 15, PAPER_MILL: 23, DISPATCH: 36,
  };
  const R = {
    FELL_WOOD: 0, MINE_IRON: 1, MINE_COAL: 2, LIMESTONE: 5, SAW_PLANKS: 8, IRON_SHEET: 9,
    FRAME_TIMBER: 37, RIVET: 38, GROW_COTTON: 79, MINE_GOLD: 95, MIX_CONCRETE: 13,
  };
  const TASK = {
    [B.CAMP]: R.FELL_WOOD, [B.FARM]: R.GROW_COTTON, [B.SAWMILL]: R.SAW_PLANKS,
    [B.QUARRY]: R.LIMESTONE, [B.SMELTER]: R.IRON_SHEET,
  };
  const NAMES = {
    [R.FELL_WOOD]: 'Fell Wood', [R.GROW_COTTON]: 'Grow Cotton', [R.SAW_PLANKS]: 'Planks',
    [R.FRAME_TIMBER]: 'Frame Timber', [R.RIVET]: 'Iron Frames', [R.MINE_IRON]: 'Iron', [R.MINE_COAL]: 'Coal',
    [R.MINE_GOLD]: 'Gold', [R.LIMESTONE]: 'Limestone', [R.IRON_SHEET]: 'Iron Sheet',
    [R.MIX_CONCRETE]: 'Concrete',
  };
  // Items the plan makes itself: never bought for prototypes, never sold.
  const HOME_MADE = [WOOD, PLANKS, WFRAME, IFRAME];

  const cfg = {
    dryRun: true,            // log actions instead of sending them
    autoResume: true,        // after a page reload, resume a run that was going
    sawmills: 6,             // once the Workshop is unlocked (1 before, 3 from 50 buildings); at least 2 per Frame Timber Workshop
    workshops: 2,            // on Frame Timber
    ironFrameWorkshops: 1,   // Phase 5: on Rivet Iron Frame, once the Smelter runs
    ironMines: 4, coalMines: 2, quarries: 1, smelters: 1, kilns: 1, labs: 1,
    goldMines: Infinity,     // leftover frames → Gold Mines (+8 CD each; the CD source for Smelter and Phase 5)
    dispatchOffice: false,   // Phase 5 optional unlock
    workshopPlanks: 205,     // planks before unlocking the Workshop (100 prototype + 100 build + 5 kit)
    maxAcrePrice: 500,       // $: land wall for camps/farms once the Workshop unlock has started
    maxAcrePriceEarly: 3000, // $: camps/farms before that (the plan pushes land until 155 CD)
    maxAcrePriceCritical: 5000, // $: land for plan buildings (Sawmill, Workshop, Mines, Smelter) ...
    landCashShare: 0.02,     // ... or up to this share of cash per acre, whichever is higher (money sitting still is wasted)
    // CD booster (the plan's "build-and-demolish CD"): once the Workshop is unlocked, when a plan
    // unlock waits only on CD and cash is idle, build cheap camps/farms and demolish them
    // (+1 CD each, 50% base refunded). Starts with a 1-building probe; disabled for good if the
    // CD isn't kept or the refund doesn't arrive (e.g. patched).
    cdBooster: true,
    boosterVia: 'builtin',   // 'cdFarm': start CD Farm (Lumber Camps, its own checks) up to the tech's CD instead;
                             // falls back to 'builtin' when CD Farm isn't loaded
    boosterBatch: 10,       // buildings per build+demolish cycle (limited by free acres)
    boosterFarmGapMs: 30000, // via CD Farm: wait this long after it stops before starting it again
    boosterMinCash: 20000,   // $: only above this much cash
    boosterKeepCash: 10000,  // $: never spend below this
    boosterAcres: 5,         // acres kept free for it (bought once, reused)
    woodReserve: 60,         // never sell below this (plus 10 min of what groups eat, kits and upcoming builds)
    sellAll: true,           // auto-sell every item's full courier loads above its reserve (like auto-ship)
    sellKeepMinutes: 30,     // keep this many minutes of what your groups eat of an item
    neverSell: [],           // extra item ids never sold (Planks, Wooden/Iron Frames, data are never sold anyway)
    smallLoadsUntil: 25,     // sell part loads until this many camps+farms exist
    minSmallLoad: 20,
    autoShipCotton: true,
    buyKits: true,           // buy kit / prototype parts the corp can't make yet
    maxBuyPrice: 3,          // × base value: most paid per unit for those parts
    postBuyOrders: true,     // no seller at all → post a player buy order for the part ...
    buyOrderUsd: 1,          // ... at this many $ per unit (money is escrowed; one open order per item)
    orderHoldHours: 24,      // never post another buy order for the same item within this time
    saveForCritical: true,   // stop buying camps/farms while saving for a ready plan building
    maxUnequippedCamps: 3,   // camps/farms waiting for their Wood kit before buying more
    resumePaused: true,      // resume powered groups paused by an unpaid bill
    floorUpgrades: true,     // switch tasks to the best-scoring known floorplan
    floorBuyUsd: 1,          // missing floorplan parts: fill player sell orders at up to this many $ per unit,
                             // else post a buy order at this price (parts you don't make); 0 = never buy
    billHours: 1,            // cash floor = this many hours of power bills (min $100 once powered)
    maxActionsPerMin: 20,       // halved (down to a quarter) after an action the server doesn't apply
    intervalMs: 3000,
    maxIdleMs: 9000,         // while there is nothing to do the loop slows from intervalMs up to this
    stallMinutes: 20,        // alert when the plan hasn't moved for this long while actions keep coming (0 = off)
    liveResume: false,       // after a reload, resume Live (with a 60 s cancel) if this tab was running Live
    jitterMinMs: 150, jitterMaxMs: 900,
    timeoutMs: 8000,
  };
  const DEFAULTS = { ...cfg, neverSell: [...cfg.neverSell] };

  // ---- persistence ----------------------------------------------------------

  // dryRun and billHours are never remembered: every paste/reload starts as a dry run with 1 h of bills.
  const SESSION_ONLY = ['dryRun', 'billHours'];
  const persistable = () => Object.fromEntries(Object.entries(cfg).filter(([k]) => !SESSION_ONLY.includes(k)));
  let saved = {};
  try { saved = JSON.parse(store?.getItem(KEY) || '{}'); } catch {}
  for (const [k, v] of Object.entries(saved.cfg || {})) if (!SESSION_ONLY.includes(k) && k in cfg) cfg[k] = v === null ? Infinity : v; // JSON has no Infinity
  const userPaused = new Set(saved.userPaused || []);   // groups you paused: never resumed
  const billPaused = new Set(saved.billPaused || []);   // groups paused by an unpaid bill: resumed when cash allows
  const keptPaused = new Set(saved.keptPaused || []);   // earlyGame.keepPaused(id): never resumed, never cleared
  const posted = { ...(saved.posted || {}) };           // item → when we last posted a buy order for it
  const wasRunning = !!saved.running;
  let running = false;
  const save = () => {
    try {
      store?.setItem(KEY, JSON.stringify({ cfg: persistable(), userPaused: [...userPaused], billPaused: [...billPaused], keptPaused: [...keptPaused], posted, running, boosterLeft, boosterBad }));
    } catch {}
  };

  // One running copy per browser: a heartbeat lock in localStorage (another browser can't be seen).
  const TAB = Math.random().toString(36).slice(2);
  const LOCK = KEY + '.lock';
  function lockOwner() {
    try { const l = JSON.parse(store?.getItem(LOCK) || 'null'); return l && Date.now() - l.t < 60000 ? l.id : null; } catch { return null; }
  }
  const takeLock = () => { try { store?.setItem(LOCK, JSON.stringify({ id: TAB, t: Date.now() })); } catch {} };
  const dropLock = () => { try { if (lockOwner() === TAB) store?.removeItem(LOCK); } catch {} };

  // ---- clock, cooldowns -----------------------------------------------------

  let nowMs = () => Date.now();
  const cooldowns = new Map();      // action key → { until, n, why }
  const successes = new Map();      // action key → confirmed count
  const failures = new Map();       // action key → failed count (never reset)
  function report(key, ok, why = '') {
    if (!key) return;
    if (ok) { cooldowns.delete(key); successes.set(key, (successes.get(key) ?? 0) + 1); return; }
    failures.set(key, (failures.get(key) ?? 0) + 1);
    const c = cooldowns.get(key) ?? { n: 0 };
    c.n++;
    c.until = nowMs() + Math.min(600000, 15000 * 2 ** (c.n - 1));
    c.why = why;
    cooldowns.set(key, c);
  }
  const cooling = (key) => (cooldowns.get(key)?.until ?? 0) > nowMs();

  // ---- CD Farm coordination -------------------------------------------------
  // CD Farm (the module above) builds and demolishes Lumber Camps or Farms (its Building setting); any unassigned one above its
  // baseline is treated as its own. So: while it runs (or finishes a step) we send nothing;
  // while it has an interrupted run, its leftover pool camps are never assigned and no new
  // camps/farms are built (they would look like its camps). window.cdFarm is re-read every time,
  // so either module can be reloaded (or be missing) at any time.
  const holds = new Set();          // earlyGame.hold(who): pause after the current step
  let inStep = false;               // an action is being sent / confirmed
  function farmInfo() {
    const f = W.cdFarm;
    if (!f) return null;
    return { busy: !!(f.running || f.active), resumable: !!f.resumable, baseline: f.stats?.baselinePool ?? 0, building: f.building ?? B.CAMP, units: f.farmUnits ?? null, f };
  }
  // Unassigned buildings (Lumber Camps or Farms, whichever the run cycles) that belong to a running or interrupted CD Farm run.
  function farmCamps(s, b = B.CAMP) {
    const fi = farmInfo();
    if (!fi || !(fi.busy || fi.resumable)) return 0;
    if (fi.units) return fi.units[b] ?? 0;   // CD Farm Auto: units of every type it holds above the baseline
    return b === fi.building ? Math.max(0, (s.pool[b] ?? 0) - fi.baseline) : 0;
  }
  let farmSeenBusyAt = -Infinity;   // last time CD Farm was seen running (a gap before the booster restarts it)
  function heldReason() {
    if (farmInfo()?.busy) { farmSeenBusyAt = nowMs(); return 'CD Farm is running (it demolishes unassigned camps)'; }
    if (holds.size) return `held by ${[...holds].join(', ')}`;
    return '';
  }

  // CD booster bookkeeping: buildings it built whose demolish got lost (cleaned up next, never
  // put to work), and probes where the demolish happened but CD/refund didn't check out.
  const boosterLeft = { ...(saved.boosterLeft || {}) };
  let boosterBad = saved.boosterBad || 0;
  const boosterOff = () => boosterBad >= 2;

  // Called every loop. A powered group that becomes paused while cash is under ~2 bills (or
  // the power service dropped) was paused by an unpaid bill; any other pause is yours.
  const lastPaused = new Map();
  function observe(s) {
    const needAll = s.groups.reduce((a, g) => a + s.drawOf(g.building) * g.count, 0);
    const billShort = s.powerHave < needAll || s.money < Math.max(s.powerHave, needAll) * 1000 * 2;
    let changed = false;
    for (const g of s.groups) {
      const prev = lastPaused.get(g.id);
      if (g.paused && prev !== true && !billPaused.has(g.id) && !userPaused.has(g.id)) {
        if (prev === false && billShort && s.drawOf(g.building) > 0) billPaused.add(g.id);
        else userPaused.add(g.id); // paused by you, or already paused when first seen
        changed = true;
      }
      if (!g.paused && (billPaused.delete(g.id) | userPaused.delete(g.id))) changed = true;
      lastPaused.set(g.id, !!g.paused);
    }
    // Buy-order hold: once our order was seen on the board and then left it (filled or
    // cancelled), the item may be ordered again. Never seen → the full orderHoldHours hold.
    for (const item of s.ordersKnown ? Object.keys(posted) : []) {
      const onBoard = s.myOrders?.some((o) => o.side === 'Buy' && o.item === +item);
      if (onBoard && !postedSeen.has(item)) postedSeen.add(item);
      else if (!onBoard && postedSeen.has(item)) { delete posted[item]; postedSeen.delete(item); changed = true; }
    }
    if (changed) save();
  }
  const postedSeen = new Set();

  // Courier conflicts: a shipment that didn't go because the courier was busy (auto-ship took it,
  // turnaround cooldown, or our tick estimate was early) is not the deal's fault. No back-off,
  // no failure count: courier work just waits until the courier is back.
  let courierHoldUntil = 0, courierMisses = 0;
  const usesCourier = (a) => a.steps.some((st) => st.msg.courier === true || st.msg.type === 'KeepFilling');

  // Result of an action: `stepsDone` steps were confirmed; `s` is the state afterwards.
  // Returns 'courier' when it failed only because the courier was busy.
  function finish(a, ok, stepsDone, s, why = '') {
    if (ok && usesCourier(a)) courierMisses = 0;
    if (!ok && usesCourier(a) && a.steps[0].msg.type !== 'KeepFilling' && s) {
      const busy = s.courierWaitTicks > 0 || (s.courierReadyAt ?? 0) > (a.meta?.courierReadyAt ?? Infinity);
      if (busy || courierMisses < 2) {
        const knownMs = (s.courierWaitTicks ?? 0) * 500;
        if (knownMs > 0) {
          // Freight cooldown with a known end (courier_ready_at): retry 1 s after it ends,
          // no escalation, since this was not a lost race.
          courierHoldUntil = nowMs() + knownMs + 1000;
        } else {
          // End unknown: hold at least 10 s, longer after repeated misses.
          courierMisses++;
          courierHoldUntil = nowMs() + Math.max(10000, 5000 * 2 ** Math.min(courierMisses, 6));
        }
        return 'courier';
      }
    }
    report(a.key, ok, why);
    const m = a.meta;
    if (!m) return;
    // A buy order may have been posted even if the board didn't show it: never post twice.
    if (a.key.startsWith('post:')) { posted[m.item] = nowMs(); save(); return; }
    if (a.key === 'booster' && ok) boosterBad = 0; // only consecutive bad probes turn it off
    if (a.key === 'booster' && !ok && stepsDone >= 1) {
      const left = Math.max(0, (s?.pool?.[m.b] ?? 0) - m.p0);
      if (left > 0) boosterLeft[m.b] = (boosterLeft[m.b] ?? 0) + left; // demolish lost: clean up next loop
      else boosterBad++;                                               // demolished, but CD/refund wrong
    }
    if (a.key.startsWith('booster:cleanup') && ok) boosterLeft[m.b] = Math.max(0, (boosterLeft[m.b] ?? 0) - m.n);
    save();
  }

// continues the autopilot closure from autopilot-1.js (same try / IIFE)
  // ---- socket listener ------------------------------------------------------
  // Shared with CD Farm (core.sock): command confirmation counters and the server tick.
  const seeTick = core.seeTick, nowTick = core.nowTick;

  // ---- state ----------------------------------------------------------------

  // (core.walk: one cached walk of the game's React state)

  // The client's catalog arrays are NOT indexed by id (items[41] is Light Frame, not Wooden
  // Frame). Re-key by id once per catalog object.
  const normCache = new WeakMap();
  function normalize(raw) {
    if (raw.byId) return raw;
    if (normCache.has(raw)) return normCache.get(raw);
    const key = (arr) => Object.fromEntries((arr ?? []).map((x) => [x.id, x]));
    const pieces = Object.fromEntries([...(raw.machines ?? []), ...(raw.belts ?? [])].map((x) => [x.item, x]));
    const c = { byId: true, items: key(raw.items), buildings: key(raw.buildings), recipes: key(raw.recipes), techs: raw.techs ?? [], pieces };
    normCache.set(raw, c);
    return c;
  }

  // Everything decide() needs, from raw game state. Pure: also used by the offline simulator.
  function snapshot(st, rawCatalog, tickNow) {
    const catalog = normalize(rawCatalog);
    const bld = (b) => catalog.buildings[b] ?? { name: `building ${b}`, cost: 0, acres: 1, build_items: [] };
    const recipe = (r) => catalog.recipes[r];
    const groups = Object.entries(st.groups ?? {}).map(([id, g]) => ({ id: +id, ...g }))
      .filter((g) => (g.region ?? REGION) === REGION);
    const pool = st.building_pool?.[REGION] ?? {};
    const stock = st.stock?.[REGION] ?? {};

    const owned = (b) => groups.filter((g) => g.building === b).reduce((a, g) => a + g.count, 0) + (pool[b] ?? 0);
    const equipped = (b) => groups.filter((g) => g.building === b).reduce((a, g) => a + (g.equipped ?? 0), 0);
    const running = (b, r) => groups.filter((g) => g.building === b && g.recipe === r).reduce((a, g) => a + g.count, 0);
    const runningEquipped = (b, r) => groups.filter((g) => g.building === b && g.recipe === r && !g.paused)
      .reduce((a, g) => a + (g.equipped ?? 0), 0);
    let acresUsed = 0;
    for (const g of groups) acresUsed += bld(g.building).acres * g.count;
    for (const [b, n] of Object.entries(pool)) acresUsed += bld(+b).acres * n;
    const landBought = st.land_bought?.[REGION] ?? 0;
    const drawOf = (b) => bld(b).draws?.power ?? 0;
    const powerNeed = groups.filter((g) => !g.paused).reduce((a, g) => a + drawOf(g.building) * g.count, 0);
    const powerHave = st.subscriptions?.[REGION]?.power ?? 0;
    const inbound = {};
    for (const s of st.shipments ?? []) if (s.amount > 0 && !s.returning && s.inbound !== false) inbound[s.item] = (inbound[s.item] ?? 0) + s.amount;
    // Floor kit per building: the active layout's bill of materials for that recipe, else the default kit.
    const kitFor = (b, r) => st.layouts?.[r]?.bom ?? bld(b).default_kit ?? [];
    const items = st.items ?? {};
    return {
      st, catalog, bld, recipe, groups, pool, stock, items, inbound, kitFor, landBought, acresUsed,
      owned, equipped, running, runningEquipped, drawOf, powerNeed, powerHave, tickNow,
    };
  }

  // Derived values that need poolRecipe (defined with the plan below) are added here.
  function enrich(s) {
    const { st, groups, pool, recipe, kitFor, items, stock } = s;
    const kitOwed = {};
    const owe = (list, n) => { for (const k of list) kitOwed[k.item] = (kitOwed[k.item] ?? 0) + k.amount * n; };
    for (const g of groups) if (g.count > (g.equipped ?? 0)) owe(kitFor(g.building, g.recipe), g.count - (g.equipped ?? 0));
    // Items made at home by equipped, running groups; what they eat per minute; starved groups.
    const madeHere = new Set(), eatPerMin = {}, starved = [];
    for (const g of groups) {
      if (!(g.equipped > 0) || g.paused || g.recipe == null) continue;
      const r = recipe(g.recipe);
      if (!r) continue;
      for (const o of r.outputs) madeHere.add(o.item);
      const rate = st.layouts?.[g.recipe]?.fx?.rate ?? 1; // runs per wave from the floorplan
      for (const i of r.inputs) eatPerMin[i.item] = (eatPerMin[i.item] ?? 0) + i.amount * g.equipped * rate * 120 / r.ticks;
      if ((g.work ?? []).some((w) => w.inputs_pct != null && w.inputs_pct < 100)) starved.push(g);
    }
    Object.assign(s, {
      kitOwed, madeHere, eatPerMin, starved,
      money: items[MONEY] ?? 0, cd: items[CD] ?? 0,
      // Regional stock first; global items (CD, MD, Logistics Data) live in items.
      has: (item) => stock[item] ?? items[item] ?? 0,
      totalBuildings: groups.reduce((a, g) => a + g.count, 0) + Object.values(pool).reduce((a, n) => a + n, 0),
      unlocked: (b) => b === B.CAMP || b === B.FARM || (st.unlocked_buildings ?? []).includes(b),
      acresOwned: STARTER_ACRES + s.landBought,
      freeAcres: Math.max(0, STARTER_ACRES + s.landBought - s.acresUsed),
      // Courier (one run per 10,000 CU, then a turnaround cooldown). Unknown tick → assume free:
      // a run that loses the race is harmless (see finish), it just waits for the courier.
      courierReadyAt: st.courier_ready_at ?? 0,
      courierWaitTicks: s.tickNow > 0 ? Math.max(0, (st.courier_ready_at ?? 0) - s.tickNow) : 0,
      courierFree: (s.tickNow === 0 || s.tickNow >= (st.courier_ready_at ?? 0)) && nowMs() >= courierHoldUntil,
      research: st.research, queue: st.research_queue ?? [],
      researchIdle: !st.research && !(st.research_queue ?? []).length,
      nextGroupId: st.next_group_id ?? 0,
      shipId: st.next_shipment_id ?? 0, standing: st.standing_fills ?? {},
      mutTick: st.ssi?.last_user_mutation_tick ?? 0,
    });
    for (const [b, n] of Object.entries(pool)) { const r = poolRecipe(s, +b); if (n && r != null) owe(kitFor(+b, r), poolTake(s, +b, n)); }
    return s;
  }

  function fullSnapshot(st, catalog, deals, orders, tickNow, engine = null) {
    const s = snapshot(st, catalog, tickNow);
    s.engine = engine;
    // A board missing from React state is unknown, not empty (Market page not mounted, reload).
    s.dealsKnown = Array.isArray(deals);
    s.ordersKnown = Array.isArray(orders);
    s.deals = (deals ?? []).filter((d) => d.region === REGION);
    s.orders = (orders ?? []).filter((o) => o.region === REGION && o.poster !== st.ssi?.corp_id);
    s.myOrders = (orders ?? []).filter((o) => o.region === REGION && o.poster === st.ssi?.corp_id);
    return enrich(s);
  }

  function read(fresh = false) {
    const { ws, st, catalog, deals, orders, engine } = core.walk(fresh);
    if (!st || !catalog) return null;
    seeTick(st.ssi?.last_user_mutation_tick);
    const s = fullSnapshot(st, catalog, deals, orders, nowTick(), engine);
    s.ws = ws; s.wsOpen = ws?.readyState === 1;
    return s;
  }

  // ---- prices -----------------------------------------------------------------

  const buildCost = (s, b) => Math.round(s.bld(b).cost * (20 + s.owned(b)) / 20);
  function acrePrice(n) { let p = FIRST_ACRE; for (let i = 0; i < n; i++) p = Math.floor(p * 41 / 40); return p; }
  function landCost(s, n) { let c = 0; for (let i = 0; i < n; i++) c += acrePrice(s.landBought + i); return c; }
  // No floor before anything draws power (the plan spends down to ~$18 at the start); then
  // max($100, billHours × $10/MW per 10 min), counting a powered building about to be added.
  function moneyFloor(s, extraMW = 0) {
    const mw = Math.max(s.powerHave, s.powerNeed) + extraMW;
    return mw > 0 ? Math.max(10000, mw * 1000 * 6 * cfg.billHours) : 0;
  }
  // " — nothing is making it (…)" when no running group produces the item.
  function whyNoneMade(s, item) {
    if (s.madeHere.has(item)) return '';
    const makers = s.groups.filter((g) => s.recipe(g.recipe)?.outputs.some((o) => o.item === item));
    if (!makers.length) return '';
    const paused = makers.filter((g) => g.paused);
    if (paused.length) return ` — nothing is making it: "${paused[0].name}" is paused${userPaused.has(paused[0].id) ? ' by you' : ''}`;
    return ` — nothing is making it: "${makers[0].name}" has no floor kit yet`;
  }
  // "$1,234.5": same text as toLocaleString('en-US', { maximumFractionDigits: 2 }) without its cost (it was 30% of a simulation).
  const usd = (c) => {
    if (!Number.isFinite(c)) return '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const cents = Math.round(Math.abs(c)), whole = Math.floor(cents / 100), rem = cents % 100;
    let s = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (rem) s += '.' + (rem < 10 ? '0' + rem : rem % 10 ? rem : rem / 10);
    return '$' + (c < 0 && cents ? '-' : '') + s;
  };
  const iname = (s, i) => s.catalog.items[i]?.name ?? `item ${i}`;
  const bname = (s, b) => s.bld(b)?.name ?? `building ${b}`;

  // ---- plan data ----------------------------------------------------------------

  // Techs the plan spends CD on, in order (golden rule 5). `gate` adds extra conditions.
  const techPlan = () => [
    { b: B.SAWMILL, phase: 2 },
    { b: B.WORKSHOP, phase: 3, gate: (s) => s.has(PLANKS) >= cfg.workshopPlanks || `need ${cfg.workshopPlanks} Planks on hand` },
    { b: B.MINE, phase: 4 },
    { b: B.QUARRY, phase: 4 },
    { b: B.SMELTER, phase: 4 },
    { b: B.FACTORY, phase: 5 },
    { b: B.KILN, phase: 5 },
    { b: B.PAPER_MILL, phase: 5 },
    { b: B.LAB, phase: 5 },
    ...(cfg.dispatchOffice ? [{ b: B.DISPATCH, phase: 5, optional: true }] : []),
  ];

  function nextTech(s) {
    for (const t of techPlan()) {
      if (s.unlocked(t.b)) continue;
      if (s.research?.building === t.b || s.queue.some((q) => q.building === t.b)) return null; // in progress
      return t;
    }
    return null;
  }

  function sawTarget(s) {
    if (!(s.unlocked(B.WORKSHOP) || s.research?.building === B.WORKSHOP)) return s.totalBuildings >= 50 ? 3 : 1;
    // Enough Sawmills for what the running groups eat (Frame Timber x5 eats 5× the Planks),
    // plus 25% so Planks build up for Workshops and prototypes. A Saw Planks run makes 1 Plank
    // per minute per building, times the floorplan's runs per wave.
    const perSawmill = s.st.layouts?.[R.SAW_PLANKS]?.fx?.rate ?? 1;
    const eat = s.eatPerMin[PLANKS] ?? 0;
    // Only grow while Plank stock is under 1 hour of use (a big stockpile can carry the gap).
    const forDemand = s.has(PLANKS) >= eat * 60 ? 0 : Math.ceil(eat * 1.25 / perSawmill);
    return Math.max(cfg.sawmills, 2 * cfg.workshops, forDemand);
  }

  function mineRecipe(s) {
    if (s.running(B.MINE, R.MINE_IRON) < cfg.ironMines) return R.MINE_IRON;
    if (s.running(B.MINE, R.MINE_COAL) < cfg.coalMines) return R.MINE_COAL;
    return R.MINE_GOLD;
  }
  const smelting = (s) => s.runningEquipped(B.SMELTER, R.IRON_SHEET) > 0;
  function workshopRecipe(s) {
    if (s.running(B.WORKSHOP, R.FRAME_TIMBER) < cfg.workshops) return R.FRAME_TIMBER;
    if (smelting(s) && s.running(B.WORKSHOP, R.RIVET) < cfg.ironFrameWorkshops) return R.RIVET;
    return R.FRAME_TIMBER;
  }
  // Kilns: Autopilot keeps cfg.kilns on Concrete; any other Kiln is Core plan's and stays unassigned.
  const kilnFree = (s) => Math.max(0, cfg.kilns - s.running(B.KILN, R.MIX_CONCRETE));
  const poolTake = (s, b, n) => (b === B.KILN ? Math.min(n, kilnFree(s)) : n);
  function poolRecipe(s, b) {
    if (b === B.KILN) return kilnFree(s) > 0 ? R.MIX_CONCRETE : null;
    return b === B.MINE ? mineRecipe(s) : b === B.WORKSHOP ? workshopRecipe(s) : TASK[b];
  }
  // Unassigned Workshops count toward the recipe they'll be given.
  const workshopPool = (s, r) => ((s.pool[B.WORKSHOP] ?? 0) > 0 && workshopRecipe(s) === r ? s.pool[B.WORKSHOP] : 0);

  // Plan buildings still wanted, in priority order.
  function criticalTargets(s) {
    const out = [];
    const add = (b, recipe, target, have) => { if (s.unlocked(b) && have < target) out.push({ b, recipe, target, have }); };
    add(B.SAWMILL, R.SAW_PLANKS, sawTarget(s), s.owned(B.SAWMILL));
    add(B.WORKSHOP, R.FRAME_TIMBER, cfg.workshops, s.running(B.WORKSHOP, R.FRAME_TIMBER) + workshopPool(s, R.FRAME_TIMBER));
    add(B.MINE, R.MINE_IRON, cfg.ironMines, s.running(B.MINE, R.MINE_IRON));
    add(B.MINE, R.MINE_COAL, cfg.coalMines, s.running(B.MINE, R.MINE_COAL));
    add(B.QUARRY, R.LIMESTONE, cfg.quarries, s.owned(B.QUARRY));
    add(B.SMELTER, R.IRON_SHEET, cfg.smelters, s.owned(B.SMELTER));
    add(B.KILN, R.MIX_CONCRETE, cfg.kilns, s.owned(B.KILN));
    add(B.LAB, null, cfg.labs, s.owned(B.LAB)); // no recipe: Core plan's Lab group takes it from the pool
    // Phase 5: Iron Frames once Iron Sheet is being made.
    if (smelting(s)) add(B.WORKSHOP, R.RIVET, cfg.ironFrameWorkshops, s.running(B.WORKSHOP, R.RIVET) + workshopPool(s, R.RIVET));
    const basicsDone = s.running(B.MINE, R.MINE_IRON) >= cfg.ironMines && s.running(B.MINE, R.MINE_COAL) >= cfg.coalMines
      && s.owned(B.QUARRY) >= cfg.quarries;
    if (basicsDone) add(B.MINE, R.MINE_GOLD, cfg.goldMines, s.running(B.MINE, R.MINE_GOLD));
    return out;
  }

  // ---- floorplans ----------------------------------------------------------------

  // Best known designs (found with the game's scorer; see wiki/dev/floorplan-search.md).
  // Cells as "x,y:item:rot". Pieces: 113 Furnace, 114 Cutter, 116 Assembler, 121 Digging Eq.,
  // 122 Field Eq., 123 Conveyor, 126 Splitter, 127 Merger, 128 Crossing.
  // Library designs never change: unpack each string once and freeze it, so cellsKey can remember its key too.
  const unpackCache = new Map();
  const unpack = (str) => {
    let o = unpackCache.get(str);
    if (!o) {
      o = Object.freeze(Object.fromEntries(str.split(' ').map((t) => {
        const [x, y, item, rot] = t.split(/[,:]/).map(Number);
        return [`${x},${y}`, Object.freeze({ item, rot })];
      })));
      unpackCache.set(str, o);
    }
    return o;
  };
  const X3_MERGE = (eq) => unpack(`0,0:${eq}:0 0,1:${eq}:0 1,0:123:0 1,1:123:0 2,0:127:0 2,1:123:3 3,0:123:0 4,0:123:0 4,1:${eq}:0`);
  const SMELT_X3 = '0,0:123:1 0,1:127:1 0,2:123:1 0,3:123:0 1,0:113:0 1,2:123:3 1,3:126:0 2,3:123:0 3,0:123:0 3,2:123:0 3,3:126:0 4,0:123:0 4,1:113:0 4,3:123:0 5,0:123:0 5,3:123:0 6,0:123:0 6,1:123:0 6,2:113:0 7,0:123:0 7,1:123:0';
  const isLive = () => running && !cfg.dryRun;   // sending live actions: what `busy` reports and what the reserve registry asks
  const WORKSHOP_V1 = core.floorDesigns.workshopV1;
  const RIVET_X3 = core.floorDesigns.rivetX3;
  const FURNITURE_V1 = new Set(['Make Bookshelf', 'Make Table', 'Make Chair']);   // one-input Workshop recipes of the core plan (rate 5)
  const FURNITURE_RIVET = new Set(['Make Bench', 'Make Desk']);                  // two-input ones (rate 3)
  const FLOOR_LIBRARY = [
    { // proven max on every 5x2 floor with no inputs (26,864 layouts scored)
      name: 'x3 merge', rate: 3,
      fits: (s, r) => {
        const rc = s.recipe(r), b = rc && s.bld(rc.building);
        if (!rc || rc.inputs.length || b.floor_w !== 5 || b.floor_h !== 2) return null;
        return b.operations?.includes('Extract') ? unpack(core.floorDesigns.mineX3) : b.operations?.includes('Cultivate') ? X3_MERGE(122) : null;
      },
    },
    { name: 'Saw x2', rate: 2, recipes: [R.SAW_PLANKS], // proven max on the 6x2 Sawmill
      cells: '0,0:123:1 0,1:123:0 1,0:123:0 1,1:126:0 2,0:123:0 2,1:123:0 3,0:114:0 3,1:114:0 5,0:123:0 5,1:123:0' },
    { name: 'Smelt x3', rate: 3, recipes: [R.IRON_SHEET, 10, 11], // Iron, Steel, Aluminum Sheet
      cells: core.floorDesigns.smeltX3 },
    { name: 'Kiln x3', rate: 3, recipes: [13, 14], cells: SMELT_X3 }, // Mix Concrete, Blow Glass
    { name: 'Frame Timber x5', rate: 5, recipes: [R.FRAME_TIMBER], cells: WORKSHOP_V1 },
    // Scored with the game's engine on 2026-11-22: x5 on Make Bookshelf / Table / Chair. Layouts are per recipe, so each gets its own
    // EditLayout; the live scorer (engineRate) still decides, the library rate is only a fallback when no scorer is reachable.
    { name: 'Workshop v1 x5', rate: 5, fits: (s, r) => (FURNITURE_V1.has(s.recipe(r)?.name) ? unpack(WORKSHOP_V1) : null) },
    { name: 'Rivet x3', rate: 3, recipes: [R.RIVET], cells: RIVET_X3 },
    // Scored x3 on Make Bench and Make Desk (2026-11-22).
    { name: 'Rivet x3 (two inputs)', rate: 3, fits: (s, r) => (FURNITURE_RIVET.has(s.recipe(r)?.name) ? unpack(RIVET_X3) : null) },
  ];

  // Only a frozen set of cells (a library design) can be remembered: the game's own cells may change in place.
  const keyCache = new WeakMap();
  const cellsKey = (cells) => {
    const frozen = cells && Object.isFrozen(cells);
    if (frozen) { const k = keyCache.get(cells); if (k !== undefined) return k; }
    const k = JSON.stringify(Object.entries(cells ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    if (frozen) keyCache.set(cells, k);
    return k;
  };
  // Parts per building = sum of each piece's materials (matches the game's bom on every saved design).
  function bomOf(s, cells) {
    const out = {};
    for (const c of Object.values(cells ?? {})) for (const m of s.catalog.pieces?.[c.item]?.materials ?? []) out[m.item] = (out[m.item] ?? 0) + m.amount;
    return out;
  }
  const listToMap = (list) => Object.fromEntries((list ?? []).map((i) => [i.item, i.amount]));

  // The game's scorer, cached (it can crash after ~500k calls; a failure turns it off for the session).
  const scoreCache = new Map();
  let scorerBroken = false;
  function engineRate(s, r, cells) {
    if (!s.engine || scorerBroken) return null;
    const k = `${r}|${cellsKey(cells)}`;
    if (scoreCache.has(k)) return scoreCache.get(k);
    try {
      const out = s.engine.evaluateLayout(r, JSON.stringify(cells));
      const rate = (typeof out === 'string' ? JSON.parse(out) : out)?.fx?.rate ?? null;
      scoreCache.set(k, rate);
      return rate;
    } catch { scorerBroken = true; return null; }
  }

  // Every running task: current plan vs. the best candidate. Memoised per snapshot.
  function floorPlans(s) {
    if (s._floors) return s._floors;
    const tasks = new Map();
    for (const g of s.groups) if (g.recipe != null && g.count > 0) tasks.set(g.recipe, (tasks.get(g.recipe) ?? 0) + g.count);
    const out = [];
    for (const [r, buildings] of tasks) {
      const rc = s.recipe(r);
      if (!rc) continue;
      const lay = s.st.layouts?.[r];
      const curBom = lay?.bom ? listToMap(lay.bom) : listToMap(s.bld(rc.building).default_kit);
      const cur = { name: lay ? 'current plan' : 'default plan', rate: lay?.fx?.rate ?? (lay ? engineRate(s, r, lay.cells) : null) ?? 1, key: lay ? cellsKey(lay.cells) : null };
      const cands = [];
      for (const e of FLOOR_LIBRARY) {
        const cells = e.fits ? e.fits(s, r) : e.recipes.includes(r) ? unpack(e.cells) : null;
        if (cells) cands.push({ name: e.name, cells, known: e.rate });
      }
      for (const [name, d] of Object.entries(s.st.designs?.[r] ?? {})) cands.push({ name: `saved "${name}"`, cells: d.cells, known: d.fx?.rate ?? null });
      let best = null;
      for (const c of cands) {
        const scored = engineRate(s, r, c.cells);
        c.rate = scored ?? c.known ?? 0;          // the live scorer wins over remembered rates
        c.scored = scored != null;
        c.bom = bomOf(s, c.cells);
        c.key = cellsKey(c.cells);
        c.value = Object.entries(c.bom).reduce((a, [i, n]) => a + n * (s.catalog.items[i]?.base_value ?? 0), 0);
        if (!best || c.rate > best.rate || (c.rate === best.rate && c.value < best.value)) best = c;
      }
      const upgrade = !!best && best.rate > cur.rate && best.key !== cur.key;
      const delta = {};
      if (upgrade) for (const [i, n] of Object.entries(best.bom)) { const d = (n - (curBom[i] ?? 0)) * buildings; if (d > 0) delta[i] = d; }
      out.push({ r, task: rc.name, building: rc.building, buildings, cur, best, upgrade, delta });
    }
    s._floors = out;
    return out;
  }

  // An upgrade goes only when every part it adds, for every building on the task, is in stock.
  // Returns null when it can go, else what's missing (floorPartBuys tries the player market).
  function floorBlock(s, f) {
    const short = Object.entries(f.delta).filter(([i, n]) => s.has(+i) < n);
    if (!short.length) return null;
    return { why: `waiting for parts: ${short.map(([i, n]) => `${Math.floor(s.has(+i))}/${n} ${iname(s, +i)}`).join(', ')}`, short };
  }

  // Home-made parts for a waiting upgrade are kept back from selling so they can build up.
  function floorReserve(s, item) {
    if (!cfg.floorUpgrades || !s.madeHere.has(item)) return 0;
    let r = 0;
    for (const f of floorPlans(s)) if (f.upgrade && floorBlock(s, f)) r += f.delta[item] ?? 0;
    return r;
  }

  function* floorActions(s) {
    if (!cfg.floorUpgrades) return;
    for (const f of floorPlans(s)) {
      if (!f.upgrade) continue;
      const label = `floorplan ${f.task}: x${f.cur.rate} → x${f.best.rate} (${f.best.name}${f.best.scored ? ', scored live' : ''}) on ${f.buildings} building(s)`;
      const block = floorBlock(s, f);
      if (block) {
        for (const [i, n] of block.short) yield* floorPartBuys(s, +i, n - s.has(+i) - (s.inbound[+i] ?? 0), `parts for ${f.task} floorplan`);
        yield { wait: `${label}: ${block.why}` };
        continue;
      }
      const key = f.best.key, cells = f.best.cells, r = f.r;
      const parts = Object.entries(f.delta).map(([i, n]) => `${n} ${iname(s, +i)}`).join(', ') || 'no extra parts';
      yield withMeta({ r, rate: f.best.rate }, act(`floor:${r}`, `${label}, uses ${parts}`,
        { msg: { type: 'EditLayout', recipe: r, cells }, until: (x) => cellsKey(x.st.layouts?.[r]?.cells) === key }));
    }
  }

  function floorTable(s) {
    return floorPlans(s).map((f) => {
      const block = f.upgrade ? floorBlock(s, f) : null;
      return {
        task: f.task, buildings: f.buildings, now: `x${f.cur.rate}`, best: `x${f.best?.rate ?? '?'}`,
        plan: f.best?.name ?? '—', scored: f.best?.scored ? 'live' : 'known',
        parts: f.upgrade ? Object.entries(f.delta).map(([i, n]) => `${n} ${iname(s, +i)}`).join(', ') || '—' : '—',
        status: !f.upgrade ? '✓ at best' : block ? block.why : 'ready to apply',
      };
    });
  }

  // Plan done = Core game plan S2–S4, wiki/guides/core-game-plan.md 1.1.
  function planDone(s) {
    return techPlan().every((t) => t.optional || s.unlocked(t.b))
      && (!s.research || s.research.building === B.DISPATCH)
      && s.running(B.WORKSHOP, R.FRAME_TIMBER) >= 1
      && s.running(B.WORKSHOP, R.RIVET) >= cfg.ironFrameWorkshops
      && s.owned(B.MINE) >= 1 && s.owned(B.QUARRY) >= 1
      && s.owned(B.KILN) >= 1 && s.owned(B.LAB) >= 1
      && s.has(IFRAME) >= 16;
  }

  function phaseOf(s) {
    if (s.owned(B.CAMP) + s.owned(B.FARM) < 2) return 1;
    if (!s.unlocked(B.SAWMILL) || s.owned(B.SAWMILL) < 1 || s.acresUsed < STARTER_ACRES) return 2;
    if (!s.unlocked(B.WORKSHOP)) return 3;
    if (!smelting(s)) return 4;
    return planDone(s) ? 'done' : 5;
  }

// continues the autopilot closure from autopilot-2.js (same try / IIFE)
  // ---- decide -----------------------------------------------------------------------

  // An action: { key, reason, steps: [{ msg, until(s), optional }] }.  A wait: { wait, final }.
  const act = (key, reason, ...steps) => ({ key, reason, steps });
  const withMeta = (meta, a) => Object.assign(a, { meta });

  function groupFor(s, b, r) {
    return s.groups.filter((g) => g.building === b && g.recipe === r).sort((a, z) => z.count - a.count)[0];
  }

  function assignAction(s, b, r, n) {
    const g = groupFor(s, b, r);
    if (g) {
      const c0 = g.count;
      return act(`assign:${g.id}`, `pool: assign ${n} ${bname(s, b)} → "${g.name}"`,
        { msg: { type: 'AssignBuildings', group: g.id, amount: n }, until: (x) => (x.st.groups[g.id]?.count ?? 0) >= c0 + n });
    }
    const id = s.nextGroupId;
    return act(`create:${b}:${r}`, `pool: create group "${NAMES[r]}" with ${n} ${bname(s, b)}`,
      // Only our new group (this building, no task yet) may get the task; if the id went to
      // another group the action fails here and the idle-group step retasks ours by its real id.
      { msg: { type: 'CreateGroup', building: b, amount: n, name: NAMES[r] ?? bname(s, b), region: REGION },
        until: (x) => x.st.groups[id]?.building === b && x.st.groups[id]?.recipe == null },
      { msg: { type: 'SetRecipe', group: id, recipe: r }, until: (x) => x.st.groups[id]?.recipe === r });
  }

  // Sellers of an item, cheapest first, under the price cap, big enough for `amount`.
  function sellersOf(s, item, amount) {
    const it = s.catalog.items[item] ?? {};
    const cap = (it.base_value || 0) * cfg.maxBuyPrice;
    return [
      ...s.deals.filter((d) => d.side === 'Buy' && d.item === item && d.amount >= amount)
        .map((d) => ({ key: `fill:${d.id}`, unit: d.price / d.amount, msg: { type: 'FillDeal', deal: d.id, amount, hire: null, region: REGION, courier: true } })),
      ...s.orders.filter((o) => o.side === 'Sell' && o.item === item && o.amount >= amount)
        .map((o) => ({ key: `order:${o.id}`, unit: o.unit_price * 1.02, msg: { type: 'FillOrder', order: o.id, amount, hire: null, region: REGION, courier: true } })),
    ].filter((o) => !cap || o.unit <= cap).sort((a, z) => a.unit - z.unit);
  }

  // One open player buy order per item, at `usd` per unit; none again within orderHoldHours
  // unless the last one was seen filled. Yields an action or a wait.
  function* postBuyOrder(s, item, amount, usdPerUnit, why) {
    const mine = s.myOrders.find((o) => o.side === 'Buy' && o.item === item);
    if (mine) { yield { wait: `${why}: your buy order for ${mine.amount} @ ${usd(mine.unit_price)} is waiting for a player` }; return; }
    const since = nowMs() - (posted[item] ?? -Infinity);
    if (since < cfg.orderHoldHours * 3600000) { yield { wait: `${why}: buy order posted ${Math.round(since / 60000)} min ago, waiting for a player` }; return; }
    const unit = Math.max(1, Math.round(usdPerUnit * 100)); // cents
    if (!cfg.postBuyOrders || s.money - unit * amount * 1.02 < moneyFloor(s)) return;
    const n0 = s.myOrders.length;
    yield withMeta({ item }, act(`post:${item}`, `${why}: post a buy order for ${amount} ${iname(s, item)} @ ${usd(unit)} (escrows ${usd(unit * amount)})`,
      { msg: { type: 'PostOrder', side: 'Buy', item, amount, unit_price: unit, region: REGION },
        until: (x) => x.myOrders.length > n0 || x.myOrders.some((o) => o.side === 'Buy' && o.item === item) }));
  }

  // Floorplan parts from the player market only, at up to cfg.floorBuyUsd per unit (2% fee
  // included): cheapest sell orders first, part-filling small ones. With no such seller, a buy
  // order at that price for parts you don't make (home-made parts just build up).
  function* floorPartBuys(s, item, need, why) {
    if (!(cfg.floorBuyUsd > 0) || need <= 0) return;
    if (!s.ordersKnown) { yield { wait: `${why}: player order board not loaded (open the Market page once)` }; return; }
    const it = s.catalog.items[item] ?? {};
    const amount = Math.max(1, Math.min(Math.ceil(need), Math.floor(COURIER_CU / (it.cargo_weight || 1))));
    const cap = cfg.floorBuyUsd * 100;
    const offers = s.orders.filter((o) => o.side === 'Sell' && o.item === item && o.unit_price * 1.02 <= cap)
      .sort((a, z) => a.unit_price - z.unit_price);
    for (const o of offers) {
      const n = Math.min(amount, o.amount);
      const cost = Math.ceil(o.unit_price * 1.02 * n);
      if (s.money - cost < moneyFloor(s)) { yield { wait: `${why}: need ${usd(cost)} for ${n} ${iname(s, item)}` }; return; }
      if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): ${why}` }; return; }
      const id0 = s.shipId, m0 = s.money;
      yield act(`order:${o.id}`, `${why}: buy ${n} ${iname(s, item)} from a player @ ${usd(o.unit_price)}`,
        { msg: { type: 'FillOrder', order: o.id, amount: n, hire: null, region: REGION, courier: true }, until: (x) => x.shipId > id0 || x.money < m0 - cost / 2 });
    }
    if (!s.madeHere.has(item)) yield* postBuyOrder(s, item, amount, cfg.floorBuyUsd, why);
  }

  // Buy actions (one per seller, best first) for `need` of an item, capped at one courier load.
  function* buyActions(s, item, need, why) {
    const it = s.catalog.items[item] ?? {};
    const amount = Math.max(1, Math.min(Math.ceil(need), Math.floor(COURIER_CU / (it.cargo_weight || 1))));
    if (!s.dealsKnown || !s.ordersKnown) { yield { wait: `${why}: market board not loaded (open the Market page once)` }; return; }
    const offers = sellersOf(s, item, amount);
    if (!offers.length) {
      yield* postBuyOrder(s, item, amount, cfg.buyOrderUsd, `no seller for ${iname(s, item)}`);
      yield { wait: `no seller for ${Math.ceil(need)} ${iname(s, item)} under ${cfg.maxBuyPrice}× base (buy it by hand)` };
      return;
    }
    for (const o of offers) {
      const cost = Math.ceil(o.unit * amount);
      if (s.money - cost < moneyFloor(s)) { yield { wait: `${why}: need ${usd(cost)} for ${amount} ${iname(s, item)}` }; return; }
      if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): ${why}` }; return; }
      const id0 = s.shipId, m0 = s.money;
      yield act(o.key, `${why}: buy ${amount} ${iname(s, item)} for ~${usd(cost)}`,
        { msg: o.msg, until: (x) => x.shipId > id0 || x.money < m0 - cost / 2 });
    }
  }

  // Home-made items held back from a build: next tech's prototype + build cost of plan
  // buildings ranked above `t` that aren't built yet (so Gold Mines can't starve the Smelter).
  function reserveFor(s, item, t, targets) {
    const amt = (list) => (list ?? []).find((i) => i.item === item)?.amount ?? 0;
    const nt = nextTech(s);
    let r = nt ? amt(s.bld(nt.b).build_items) : 0;
    for (const u of targets) { if (u === t) break; r += amt(s.bld(u.b).build_items); }
    return r;
  }

  // Never sell below: base + 10 min of what groups eat + owed kits + next tech prototype
  // + the next two plan builds (items and kits).
  function sellReserve(s, item) {
    const amt = (list) => (list ?? []).find((i) => i.item === item)?.amount ?? 0;
    let r = (item === WOOD ? cfg.woodReserve : 0) + cfg.sellKeepMinutes * (s.eatPerMin[item] ?? 0) + (s.kitOwed[item] ?? 0) + floorReserve(s, item);
    const nt = nextTech(s);
    if (nt) r += amt(s.bld(nt.b).build_items);
    for (const t of criticalTargets(s).slice(0, 2)) r += amt(s.bld(t.b).build_items) + amt(s.kitFor(t.b, t.recipe));
    return Math.ceil(r);
  }

  // Parts to buy: owed kits + next tech's prototype, minus stock, inbound and home production.
  function partsToBuy(s) {
    const want = {};
    for (const [item, n] of Object.entries(s.kitOwed)) if (!s.madeHere.has(+item)) want[item] = n;
    const nt = nextTech(s);
    if (nt) {
      const tech = s.catalog.techs.find((t) => t.building === nt.b);
      if (tech && s.cd >= tech.cost) {
        for (const i of s.bld(nt.b).build_items ?? []) {
          if (HOME_MADE.includes(i.item) || i.item === LD || i.item === CD) continue;
          want[i.item] = (want[i.item] ?? 0) + i.amount;
        }
      }
    }
    return Object.entries(want)
      .map(([item, amount]) => ({ item: +item, need: amount - s.has(+item) - (s.inbound[+item] ?? 0) }))
      .filter((p) => p.need > 0);
  }
  // (An open buy order of ours is handled in buyActions: it waits instead of reposting.)

  // Acres held free for the CD booster once it is in use (other builds buy their own).
  function boosterAcresHeld(s) {
    if (!cfg.cdBooster || !s.unlocked(B.WORKSHOP)) return 0;
    if (!(successes.get('booster') || successes.get('land:booster') || successes.get('booster:cdfarm'))) return 0;
    if ((boosterOff() && cfg.boosterVia !== 'cdFarm') || !nextTech(s)) return 0;
    return Math.min(cfg.boosterAcres, s.freeAcres);
  }

  function buildSteps(s, b, why, maxAcre) {
    const needAcres = Math.max(0, s.bld(b).acres - (s.freeAcres - boosterAcresHeld(s)));
    const floor = moneyFloor(s, s.drawOf(b));
    if (needAcres > 0) {
      const top = acrePrice(s.landBought + needAcres - 1);
      if (top > maxAcre * 100) return { wait: `${why}: next acre ${usd(top)} is above the ${usd(maxAcre * 100)} land wall`, wall: true };
      const lc = landCost(s, needAcres);
      if (s.money - lc - buildCost(s, b) < floor) return { wait: `${why}: saving for ${needAcres} acre(s) + ${bname(s, b)} (${usd(lc + buildCost(s, b))})`, money: true };
      const l0 = s.landBought;
      return act('land', `${why}: buy ${needAcres} acre(s) for ${usd(lc)}`,
        { msg: { type: 'BuyLand', amount: needAcres, region: REGION }, until: (x) => x.landBought >= l0 + needAcres });
    }
    const cost = buildCost(s, b);
    if (s.money - cost < floor) return { wait: `${why}: saving ${usd(cost)} for ${bname(s, b)} (have ${usd(s.money)})`, money: true };
    const o0 = s.owned(b);
    return act(`build:${b}`, `${why}: build ${bname(s, b)} for ${usd(cost)}`,
      { msg: { type: 'BuyBuilding', building: b, amount: 1, region: REGION }, until: (x) => x.owned(b) >= o0 + 1 });
  }

  // Every candidate, in priority order. decide() takes the first that isn't cooling down.
  function* candidates(s) {
    // 1. Resume groups paused by an unpaid bill. Groups you paused are never touched.
    if (cfg.resumePaused) {
      for (const g of s.groups) {
        if (!g.paused || !billPaused.has(g.id) || userPaused.has(g.id) || keptPaused.has(g.id)) continue;
        const mw = s.drawOf(g.building) * g.count;
        if (s.money < moneyFloor(s, mw) + mw * 1000) { yield { wait: `"${g.name}" is paused (unpaid bill?): waiting for cash to resume` }; continue; }
        yield act(`resume:${g.id}`, `resume "${g.name}" (paused, bills affordable again)`,
          { msg: { type: 'SetPaused', group: g.id, paused: false }, until: (x) => !x.st.groups[g.id]?.paused });
      }
    }

    // 2. Power.
    if (s.powerNeed > s.powerHave) {
      const level = Math.min(MAX_POWER, s.powerNeed);
      if (level > s.powerHave) {
        yield act('power', `power: groups draw ${s.powerNeed} MW, subscribed ${s.powerHave}`,
          { msg: { type: 'SetSubscription', region: REGION, utility: 'power', level }, until: (x) => x.powerHave === level });
      }
      if (s.powerNeed > MAX_POWER) yield { wait: `power need ${s.powerNeed} MW is above the ${MAX_POWER} MW grid cap` };
    }

    // 3a. Booster leftovers (its demolish got lost): demolish them, don't put them to work.
    for (const [bs, left] of Object.entries(boosterLeft)) {
      const b = +bs, n = Math.min(left, s.pool[b] ?? 0);
      if (!left) continue;
      if (!n) { boosterLeft[b] = 0; continue; } // already gone
      const p0 = s.pool[b];
      const a = act(`booster:cleanup:${b}`, `CD booster cleanup: demolish ${n} leftover ${bname(s, b)}`,
        { msg: { type: 'DemolishBuilding', building: b, amount: n, region: REGION }, until: (x) => (x.pool[b] ?? 0) <= p0 - n });
      a.meta = { b, n };
      yield a;
    }

    // 3b. Unassigned plan buildings → their group (non-plan buildings are left alone).
    for (const [bs, total] of Object.entries(s.pool)) {
      const b = +bs;
      const n = total - (boosterLeft[b] ?? 0) - farmCamps(s, b);
      if (n <= 0) continue;
      const r = poolRecipe(s, b);
      if (r == null) continue;
      yield assignAction(s, b, r, b === B.MINE || b === B.WORKSHOP ? 1 : poolTake(s, b, n));
    }

    // 4. Plan groups with no task.
    for (const g of s.groups) {
      if (g.recipe != null || g.building === B.KILN) continue; // bare Kiln groups are Core plan's
      const r = poolRecipe(s, g.building);
      if (r == null) continue;
      yield act(`recipe:${g.id}`, `idle group "${g.name}" → ${NAMES[r]}`,
        { msg: { type: 'SetRecipe', group: g.id, recipe: r }, until: (x) => x.st.groups[g.id]?.recipe === r });
    }

    // 5. Kit / prototype parts the corp can't make yet.
    if (cfg.buyKits) for (const p of partsToBuy(s)) yield* buyActions(s, p.item, p.need, 'parts for kits/prototype');

    // 6. Next plan tech.
    const nt = nextTech(s);
    if (nt) {
      const tech = s.catalog.techs.find((t) => t.building === nt.b);
      const proto = s.bld(nt.b).build_items ?? [];
      const why = `unlock ${bname(s, nt.b)}`;
      if (!tech) yield { wait: `${why}: not in the tech tree` };
      else if (!s.researchIdle) yield { wait: `${why}: research slot busy` };
      else if (tech.requires != null && !s.unlocked(tech.requires)) yield { wait: `${why}: needs ${bname(s, tech.requires)} first` };
      else if (s.cd < tech.cost) yield { wait: `${why}: ${s.cd} / ${tech.cost} CD` };
      else {
        const gate = nt.gate ? nt.gate(s) : true;
        const lack = proto.filter((i) => s.has(i.item) < i.amount);
        if (gate !== true) yield { wait: `${why}: ${gate}` };
        else if (lack.length) yield { wait: `${why}: need ${lack.map((i) => `${Math.ceil(i.amount - s.has(i.item))} more ${iname(s, i.item)}${whyNoneMade(s, i.item)}`).join(', ')}` };
        else {
          yield act(`tech:${nt.b}`, `${why} (${tech.cost} CD${proto.length ? ' + ' + proto.map((i) => `${i.amount} ${iname(s, i.item)}`).join(', ') : ''})`,
            { msg: { type: 'StartTech', building: nt.b, region: REGION }, until: (x) => x.research?.building === nt.b || x.unlocked(nt.b) });
        }
      }
    }

    // 6b. Better floorplans.
    yield* floorActions(s);

    // 7. Selling.
    yield* sellActions(s);

    // 8. Plan buildings.
    const targets = criticalTargets(s);
    for (const t of targets) {
      const items = s.bld(t.b).build_items ?? [];
      const short = items.find((i) => s.has(i.item) < i.amount + (HOME_MADE.includes(i.item) ? reserveFor(s, i.item, t, targets) : 0));
      const label = `${bname(s, t.b)}${t.b === B.MINE || t.b === B.WORKSHOP ? ` (${NAMES[t.recipe]})` : ''} ${t.have + 1}/${t.target === Infinity ? '∞' : t.target}`;
      if (short) { yield { wait: `${label}: waiting for ${iname(s, short.item)}${whyNoneMade(s, short.item)}` }; continue; }
      if (s.owned(t.b) > s.equipped(t.b)) { yield { wait: `${label}: a ${bname(s, t.b)} is still waiting for its floor kit` }; continue; }
      // One-off plan buildings take land at any price they can afford; only the open-ended
      // Gold Mines are held to the land wall.
      const wall = t.recipe === R.MINE_GOLD ? Math.max(cfg.maxAcrePriceCritical, s.money / 100 * cfg.landCashShare) : Infinity;
      const a = buildSteps(s, t.b, label, wall);
      if (a.steps) { yield a; continue; }
      if (a.money && cfg.saveForCritical) { yield { ...a, final: true }; return; }
      yield a;
    }

    // 9. CD booster.
    yield* boosterActions(s, nt);

    // 10. Cheaper of Lumber Camp / Farm (tie → camp).
    if (farmInfo()?.resumable) { yield { wait: 'camps/farms wait: CD Farm has an interrupted run (resume or discard it in CD Farm)' }; return; }
    const b =buildCost(s, B.FARM) < buildCost(s, B.CAMP) ? B.FARM : B.CAMP;
    const unequipped = s.owned(B.CAMP) + s.owned(B.FARM) - s.equipped(B.CAMP) - s.equipped(B.FARM);
    if (unequipped >= cfg.maxUnequippedCamps) { yield { wait: `${unequipped} camps/farms still waiting for their Wood kit` }; return; }
    const workshopStarted = s.unlocked(B.WORKSHOP) || s.research?.building === B.WORKSHOP;
    yield buildSteps(s, b, `${bname(s, b)} #${s.owned(b) + 1}`, workshopStarted ? cfg.maxAcrePrice : cfg.maxAcrePriceEarly);
  }

  function* boosterActions(s, nt) {
    if (!cfg.cdBooster || !nt || !s.unlocked(B.WORKSHOP) || !s.researchIdle) return;
    const tech = s.catalog.techs.find((t) => t.building === nt.b);
    if (!tech || s.cd >= tech.cost || (tech.requires != null && !s.unlocked(tech.requires))) return;
    const fi = farmInfo();
    if (fi?.resumable) { yield { wait: 'CD booster waits: CD Farm has an interrupted run (resume or discard it in CD Farm)' }; return; }
    const viaFarm = cfg.boosterVia === 'cdFarm' && typeof fi?.f.start === 'function';
    const verified = (successes.get('booster') ?? 0) > 0;
    if (boosterOff() && !viaFarm) { yield { wait: 'CD booster off: build-and-demolish did not keep the CD / refund (seen twice)' }; return; }
    if (Object.values(boosterLeft).some((n) => n > 0)) return; // clean up first
    if (s.money < cfg.boosterMinCash * 100) return;
    if (s.freeAcres < 1) {
      const want = Math.max(1, cfg.boosterAcres);
      // A few acres bought once and reused for every cycle: allowed up to 10% of cash per acre.
      const cap = Math.max(cfg.maxAcrePriceCritical, s.money / 100 * Math.max(cfg.landCashShare, 0.1)) * 100;
      if (acrePrice(s.landBought + want - 1) > cap) { yield { wait: `CD booster: next acre ${usd(acrePrice(s.landBought))} above the land wall` }; return; }
      const lc = landCost(s, want), l0 = s.landBought;
      if (s.money - lc < Math.max(moneyFloor(s), cfg.boosterKeepCash * 100)) return;
      yield act('land:booster', `CD booster: buy ${want} acre(s) to build on (${usd(lc)}, reused)`,
        { msg: { type: 'BuyLand', amount: want, region: REGION }, until: (x) => x.landBought >= l0 + want });
      return;
    }
    const keep = Math.max(moneyFloor(s), cfg.boosterKeepCash * 100);
    if (viaFarm) {
      // CD Farm runs the build+demolish cycles itself (and verifies them); we hold until it stops.
      // Its settings for this run are restored when it stops (runOnly).
      // Not worth starting when it would stop at once (it needs one camp's cost above the floor), and
      // after a run ends (stopped by you, error) wait cfg.boosterFarmGapMs instead of restarting it every loop.
      if (s.money - buildCost(s, B.CAMP) < keep) return;
      if (nowMs() - farmSeenBusyAt < cfg.boosterFarmGapMs) { yield { wait: `CD booster: CD Farm just stopped, waiting ${cfg.boosterFarmGapMs / 1000} s before starting it again` }; return; }
      const opts = {
        targetCd: tech.cost, budget: 'reserve', minMoney: Math.ceil(keep / 100), batch: cfg.boosterBatch,
        reserveAcres: 0, fullBatch: false, existingPool: 'keep', maxSpendPerMin: Infinity,
        building: B.CAMP, runOnly: true, by: `Autopilot: CD for ${bname(s, nt.b)}`,
      };
      const a = act('booster:cdfarm', `CD booster via CD Farm: farm ${tech.cost - s.cd} CD for ${bname(s, nt.b)} (keeps ${usd(keep)})`);
      a.call = () => { fi.f.start(opts); return !!W.cdFarm?.running; };
      a.callInfo = `cdFarm.start(${JSON.stringify(opts)})`;
      yield a;
      return;
    }
    const b = buildCost(s, B.FARM) < buildCost(s, B.CAMP) ? B.FARM : B.CAMP;
    const base = s.bld(b).cost, owned = s.owned(b);
    const max = verified ? Math.min(cfg.boosterBatch, s.freeAcres, tech.cost - s.cd) : 1;
    let n = 0, cost = 0;
    while (n < max && s.money - (cost + Math.round(base * (20 + owned + n) / 20)) >= keep) { cost += Math.round(base * (20 + owned + n) / 20); n++; }
    if (!n) return;
    const refund = Math.floor(base / 2) * n;
    const p0 = s.pool[b] ?? 0, cd0 = s.cd, m0 = s.money;
    const a = act('booster', `CD booster${verified ? '' : ' (1-building test)'}: build + demolish ${n} ${bname(s, b)} → +${n} CD for ~${usd(cost - refund)} (${tech.cost - s.cd} CD short of ${bname(s, nt.b)})`,
      { msg: { type: 'BuyBuilding', building: b, amount: n, region: REGION }, until: (x) => (x.pool[b] ?? 0) >= p0 + n },
      { msg: { type: 'DemolishBuilding', building: b, amount: n, region: REGION },
        // Verified on the result: buildings gone, CD kept, and the refund came back.
        // Slack covers a $10/MW bill landing between the two steps.
        until: (x) => (x.pool[b] ?? 0) <= p0 && x.cd >= cd0 + n && x.money >= m0 - (cost - refund) - Math.max(5000, cost * 0.02) - Math.max(s.powerHave, s.powerNeed) * 1000 });
    a.meta = { b, n, p0 };
    yield a;
  }

  // "back in 6 s" from the game's courier_ready_at, or our own hold after a lost race.
  const courierBackInMs = (s) => Math.max(s.courierWaitTicks * 500, courierHoldUntil - nowMs(), 0);
  function courierEta(s) {
    const ms = courierBackInMs(s);
    return ms > 0 ? `back in ${Math.ceil(ms / 1000)} s` : 'back now';
  }

  function* sellActions(s) {
    if (!s.dealsKnown) { yield { wait: 'selling: market board not loaded (open the Market page once)' }; return; }
    const load = (item) => Math.floor(COURIER_CU / (s.catalog.items[item]?.cargo_weight || 1));
    const bids = (item) => s.deals.filter((d) => d.side === 'Sell' && d.item === item)
      .sort((a, z) => z.price / z.amount - a.price / a.amount);

    // Cotton auto-ship (1 slot, unlocks after First Steps). Never replaces another auto-ship.
    const standingIds = Object.keys(s.standing);
    const autoCotton = standingIds.some((id) => s.deals.find((d) => String(d.id) === id)?.item === COTTON);
    if (cfg.autoShipCotton && !autoCotton && standingIds.length === 0 && s.has(COTTON) > 0) {
      const d = bids(COTTON)[0];
      if (d) {
        yield act(`autoship:${d.id}`, `auto-ship Cotton to bid @ ${usd(d.price / d.amount)}`,
          { msg: { type: 'KeepFilling', deal: d.id, region: REGION, amount: null }, until: (x) => !!x.standing[d.id], optional: true });
      }
    }
    if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): selling waits` }; return; }

    // Every item with a Heartland bid whose stock above its reserve fills a courier run
    // (10,000 CU) is sold, best-paying load first. Part loads only for Wood/Cotton at the start.
    const early = s.owned(B.CAMP) + s.owned(B.FARM) < cfg.smallLoadsUntil;
    const autoItems = new Set(standingIds.map((id) => s.deals.find((d) => String(d.id) === id)?.item).filter((i) => i != null));
    const items = new Set(cfg.sellAll ? Object.keys(s.stock).map(Number) : []);
    items.add(WOOD); items.add(COTTON);
    const loads = [];
    for (const item of items) {
      if (autoItems.has(item) || NEVER_SELL.includes(item) || cfg.neverSell.includes(item) || s.catalog.items[item]?.intangible) continue;
      const spare = Math.floor(s.has(item) - sellReserve(s, item));
      const small = early && (item === WOOD || item === COTTON);
      const n = small ? Math.min(load(item), spare) : load(item);
      if (spare < n || n < (small ? cfg.minSmallLoad : 1)) continue;
      for (const d of bids(item)) {
        if (d.amount < n) continue; // nearly filled: try the next bid
        loads.push({ item, n, d, value: d.price / d.amount * n });
        break;
      }
    }
    loads.sort((a, z) => z.value - a.value);
    for (const { item, n, d, value } of loads) {
      const id0 = s.shipId;
      yield act(`fill:${d.id}`, `sell ${n} ${iname(s, item)} @ ${usd(d.price / d.amount)} = ${usd(value)}${n === load(item) ? ' (full courier load)' : ' (part load)'}`,
        { msg: { type: 'FillDeal', deal: d.id, amount: n, hire: null, region: REGION, courier: true }, until: (x) => x.shipId > id0 });
    }
  }
  // Never sold: what the plan builds with, and corp-wide data.
  const NEVER_SELL = [PLANKS, WFRAME, IFRAME, MONEY, CD, 25, 26, LD];

  // First candidate action not cooling down. Waits are collected; a final wait (saving for a
  // plan building) stops the search so camps don't eat the money.
  function decide(s) {
    const waits = [];
    for (const c of candidates(s)) {
      if (c.steps) {
        if (usesCourier(c)) c.meta = { ...(c.meta ?? {}), courierReadyAt: s.courierReadyAt };
        if (cooling(c.key)) { waits.push(`backing off "${c.reason}" (${cooldowns.get(c.key).why || 'not confirmed'})`); continue; }
        return c;
      }
      waits.push(c.wait);
      if (c.final) break;
    }
    const isNote = (w) => /^no seller|^courier busy|backing off/.test(w);
    const main = waits.find((w) => !isNote(w)) ?? waits[0] ?? 'nothing to do';
    const extra = waits.filter((w) => w !== main && /^no seller|backing off/.test(w));
    return { wait: main + (extra.length ? ` | ${extra.slice(0, 2).join(' | ')}` : ''), waits };
  }

// continues the autopilot closure from autopilot-3.js (same try / IIFE)
  // ---- execute -------------------------------------------------------------------

  const sleep = core.sleep;
  const jitter = () => sleep(cfg.jitterMinMs + Math.random() * Math.max(0, cfg.jitterMaxMs - cfg.jitterMinMs));
  class ConnError extends Error {}

  function waitConfirm(until, d0) {
    return core.waitConfirm({ read, pred: until, d0, timeoutMs: cfg.timeoutMs, closed: () => { throw new ConnError('socket closed while waiting'); } });
  }

  let sentTimes = [];
  // true = done (or harmless), false = failed, 'held' = not sent because of a hold.
  async function execute(a) {
    inStep = true;
    try { return await executeSteps(a); } finally { inStep = false; }
  }
  async function executeSteps(a) {
    if (a.call) {
      // Not a socket message: hand work to another module (CD Farm). Not awaited: it runs on its own.
      await jitter();
      if (!running) return true;
      if (heldReason()) return 'held';
      const ok = !!a.call();
      finish(a, ok, ok ? 1 : 0, read(), ok ? '' : 'CD Farm did not start');
      if (ok) core.ledger.add('AP', 'action', a.reason);
      if (!ok) note(`not started: ${a.reason} — backing off (see the CD Farm panel / console)`);
      return ok;
    }
    let done = 0, m0 = null;
    for (const step of a.steps) {
      await jitter();
      if (!running) { if (done) finish(a, false, done, read(), 'stopped'); return true; }
      // A hold (e.g. CD Farm starting) only stops an action before its first message:
      // half a build+demolish is finished rather than left for cleanup.
      if (done === 0 && heldReason()) return 'held';
      takeLock();
      const s = read(true);
      if (!s) throw new ConnError('game state not found');
      if (!s.wsOpen) throw new ConnError('socket not open');
      const d0 = core.markSend(s.mutTick);
      m0 ??= s.money;
      s.ws.send(JSON.stringify(step.msg));
      sentTimes.push(Date.now());
      if (!(await waitConfirm(step.until, d0))) {
        const after = read();
        if (finish(a, false, done, after, step.optional ? 'not available yet' : 'server did not apply it') === 'courier') {
          note(`courier busy (freight cooldown or auto-ship): "${a.reason}" waits ${Math.ceil((courierHoldUntil - nowMs()) / 1000)} s`);
          return true; // not an error: it goes again when the courier is back
        }
        note(`${step.optional ? 'skipped' : 'not confirmed'}: ${a.reason} — backing off`);
        return !!step.optional; // optional steps don't count as errors
      }
      done++;
    }
    const after = read();
    finish(a, true, done, after);
    core.ledger.add('AP', 'action', a.reason, { dMoney: m0 != null && after ? Math.round((after.money - m0) / 100) : undefined });
    return true;
  }

  // ---- loop / control -----------------------------------------------------------

  let lastLine = '', actions = 0, fails = 0, log = [], stopReason = '';
  const note = (line) => {
    if (line === lastLine) return;
    lastLine = line;
    log = [`${new Date().toLocaleTimeString()} ${line}`, ...log].slice(0, 6);
    console.log('[earlyGame] ' + line);
    if (LEDGER_NOTE.test(line)) core.ledger.add('AP', /^(connection back|progress)/.test(line) ? 'info' : 'fail', line);
  };
  const LEDGER_NOTE = /^(stopping|error:|not confirmed|skipped|not started|connection back|Live refused|stalled|slowing down|progress again)/;

  let active = false; // a loop is still executing (maybe finishing a step after stop())

  // ---- watchdog, pacing, game check --------------------------------------------------
  let rateScale = 1, okStreak = 0, waitStreak = 0, stalled = '', lastPhase = null, lastLiveCheck = 0, liveCountdownUntil = 0;
  const INCOME_ACTION = /^(fill|autoship):/;           // selling is steady-state income, not plan progress
  const prog = { sig: '', at: 0, money: 0, acts: 0 };   // last time the plan moved (nowMs clock)
  const cash = [];                                      // { t, m } samples for the cash-change rate
  const sstore = (() => { try { return W.sessionStorage ?? null; } catch { return null; } })();
  const LIVE_KEY = KEY + '.live';
  const liveFlag = (() => { try { const f = JSON.parse(sstore?.getItem(LIVE_KEY) || 'null'); return f && Date.now() - f.t < 10 * 60000 ? f : null; } catch { return null; } })();
  const heartbeatLive = () => { try { sstore?.setItem(LIVE_KEY, JSON.stringify({ t: Date.now() })); } catch {} };
  const clearLive = () => { try { sstore?.removeItem(LIVE_KEY); } catch {} };

  // Plan progress is a change in phase, CD, building count, unlocks or research, or cash up 10 %
  // (+$100). With no progress for cfg.stallMinutes while actions keep coming (20+), say so:
  // a badge, a notification and a banner. It never stops the run by itself. Waiting on a
  // courier or research sends no actions, so it never counts.
  function watchStall(s, acting) {
    const t = nowMs(), ph = phaseOf(s);
    if (ph !== lastPhase) {
      if (lastPhase != null && running && !cfg.dryRun) core.notify('AP', ph === 'done' ? 'Autopilot: plan done' : 'Autopilot: phase ' + ph, 'Money ' + usd(s.money) + ', CD ' + s.cd);
      lastPhase = ph;
    }
    const sig = [ph, s.cd, s.totalBuildings, (s.st.unlocked_buildings ?? []).length, s.research ? 1 : 0, s.queue.length].join('|');
    if (sig !== prog.sig || s.money > prog.money * 1.1 + 10000 || ph === 'done' || !prog.at) {
      prog.sig = sig; prog.at = t; prog.money = s.money; prog.acts = 0;
      if (stalled) { stalled = ''; core.setBadge('AP', ''); note('progress again'); }
      return;
    }
    if (cfg.dryRun) return;
    if (acting) prog.acts++;
    if (!stalled && cfg.stallMinutes > 0 && prog.acts >= 20 && t - prog.at >= cfg.stallMinutes * 60000) {
      stalled = 'no plan progress for ' + Math.round((t - prog.at) / 60000) + ' min (' + prog.acts + ' actions since)';
      note('stalled: ' + stalled);
      core.setBadge('AP', 'AP stalled');
      core.notify('AP', 'Autopilot looks stalled', stalled);
    }
  }

  // Does the game still look like what this script was written against? Live mode needs it.
  function checkGame(s) {
    const bad = [];
    const miss = core.missingFields(s.st, ['groups', 'stock', 'ssi', 'items']);
    if (miss.length) bad.push('state is missing ' + miss.join(', '));
    const c = s.catalog;
    for (const k of ['items', 'buildings', 'recipes']) if (!Object.keys(c[k] ?? {}).length) bad.push('catalog.' + k + ' is empty');
    if (!c.techs?.length) bad.push('catalog.techs is empty');
    const camp = c.buildings[B.CAMP];
    if (!camp || typeof camp.cost !== 'number' || typeof camp.acres !== 'number') bad.push('Lumber Camp has no cost / acres');
    const fell = c.recipes[R.FELL_WOOD];
    if (!fell || !Array.isArray(fell.inputs) || !Array.isArray(fell.outputs) || typeof fell.ticks !== 'number') bad.push('Fell Wood recipe changed');
    if (typeof c.items[WOOD]?.base_value !== 'number') bad.push('Wood has no base_value');
    if (typeof s.st.items?.[MONEY] !== 'number') bad.push('money is not items[0]');
    return bad;
  }
  // Why Live must not run right now ('' = fine). Dry runs and the offline sim (no DOM) are never blocked.
  function liveBlocked(s) {
    if (!HAS_DOM || cfg.dryRun || !s) return '';
    const bad = checkGame(s);
    return bad.length ? 'the game data no longer looks like what this script expects (' + bad.join('; ') + ')' : '';
  }

  // Cash change per hour over the last hour (needs 5 min of samples). Includes spending: it is net.
  function trackCash(s) {
    const t = nowMs();
    if (!cash.length || t - cash[cash.length - 1].t >= 30000) cash.push({ t, m: s.money });
    while (cash.length && t - cash[0].t > 3600000) cash.shift();
  }
  function cashRate() {
    if (cash.length < 2) return null;
    const a = cash[0], b = cash[cash.length - 1], dt = b.t - a.t;
    return dt >= 300000 ? { perHour: (b.m - a.m) / (dt / 3600000), mins: Math.round(dt / 60000) } : null;
  }

  async function loop() {
    active = true;
    let lostSince = 0, courierWaiting = false;
    waitStreak = 0;
    while (running) {
      let pause = cfg.intervalMs;
      try {
        const s = read();
        if (!s || !s.wsOpen) {
          lostSince ||= Date.now();
          if (lockOwner() === TAB || !lockOwner()) takeLock();
          note(`waiting for the game connection (${Math.round((Date.now() - lostSince) / 1000)} s)…`);
          await sleep(2000);
          continue;
        }
        if (lostSince) { lostSince = 0; note('connection back'); await sleep(2000); continue; } // let the fresh Snapshot land
        const owner = lockOwner();
        if (owner && owner !== TAB) { stopReason = 'another tab is running Autopilot'; note('stopping: ' + stopReason); break; }
        takeLock();
        if (!cfg.dryRun) {
          heartbeatLive();
          if (HAS_DOM && Date.now() - lastLiveCheck > 60000) {
            lastLiveCheck = Date.now();
            const why = liveBlocked(s);
            if (why) { cfg.dryRun = true; clearLive(); note('Live refused: ' + why); core.notify('AP', 'Autopilot switched to dry run', why); render(); continue; }
          }
        }
        observe(s);
        trackCash(s);
        const held = heldReason();
        if (held) { note('paused: ' + held); await sleep(cfg.intervalMs); continue; }
        sentTimes = sentTimes.filter((t) => Date.now() - t < 60000);
        if (sentTimes.length >= Math.max(2, Math.floor(cfg.maxActionsPerMin * rateScale))) { note('rate limit: waiting'); await sleep(5000); continue; }
        const a = decide(s);
        watchStall(s, !a.wait && !INCOME_ACTION.test(a.key ?? ''));
        if (a.wait) {
          note('wait — ' + a.wait);
          // Nothing to do: look less often the longer it lasts (up to cfg.maxIdleMs). A command applied
          // by the server (yours, or one you click) ends the sleep early.
          waitStreak++;
          pause = Math.min(Math.max(cfg.maxIdleMs, cfg.intervalMs), cfg.intervalMs * (1 + Math.floor(waitStreak / 5)));
          // Courier work is waiting on the freight cooldown: wake right when it ends and retry.
          if (a.waits.some((w) => /^courier busy/.test(w))) {
            courierWaiting = true;
            const back = courierBackInMs(s);
            if (back > 0) pause = Math.min(pause, back + 250);
          }
        }
        else if (cfg.dryRun) note('DRY RUN would: ' + a.reason + '  ' + (a.callInfo ?? a.steps.map((x) => JSON.stringify(x.msg)).join(' ; ')));
        else {
          waitStreak = 0;
          if (courierWaiting && usesCourier(a)) note('courier back: retrying');
          courierWaiting = false;
          note(a.reason);
          const res = await execute(a);
          if (res === 'held') continue;
          if (res) {
            actions++; fails = 0;
            // Back to full pace after 10 confirmed actions in a row.
            if (++okStreak >= 10 && rateScale < 1) { rateScale = Math.min(1, rateScale * 1.25); okStreak = 0; }
          } else {
            // An action the server did not apply: slow down (half the action cap, down to a quarter).
            okStreak = 0;
            if (rateScale > 0.25) { rateScale = Math.max(0.25, rateScale / 2); note('slowing down to ' + Math.round(rateScale * 100) + '% pace'); }
            if (++fails >= 10) { stopReason = '10 actions in a row were not confirmed'; note('stopping: ' + stopReason); break; }
          }
          continue;
        }
        fails = 0;
      } catch (e) {
        if (e instanceof ConnError) { note(e.message); await sleep(2000); continue; }
        fails++;
        note(`error: ${e.message}`);
        if (fails >= 10) { stopReason = '10 errors in a row'; note('stopping after ' + stopReason); break; }
      }
      await core.sleepWake(pause);
    }
    running = false; active = false; save(); dropLock(); clearLive(); core.setBadge('AP', '');
    if (stopReason && stopReason !== 'stopped by you') core.notify('AP', 'Autopilot stopped', stopReason);
    render();
  }

  function start(opts = {}) {
    if (running) return console.warn('[earlyGame] already running');
    if (active) return console.warn('[earlyGame] the previous run is still finishing its step; try again in a few seconds');
    const owner = lockOwner();
    if (owner && owner !== TAB) return console.warn('[earlyGame] already running in another tab of this browser');
    Object.assign(cfg, opts);
    if (!cfg.dryRun && HAS_DOM) {
      const why = liveBlocked(read(true));
      if (why) { cfg.dryRun = true; console.warn('[earlyGame] Live refused: ' + why + '. Starting as a dry run.'); core.toast('Live refused: the game data changed. Started as a dry run (see the console).'); core.ledger.add('AP', 'fail', 'Live refused: ' + why); }
    }
    takeLock();
    running = true; fails = 0; lastLine = ''; stopReason = '';
    stalled = ''; prog.at = 0; waitStreak = 0; rateScale = 1; okStreak = 0; lastLiveCheck = Date.now();
    core.setBadge('AP', '');
    if (cfg.dryRun) clearLive(); else heartbeatLive();
    save();
    console.log(`[earlyGame] start (${cfg.dryRun ? 'DRY RUN — start({ dryRun: false }) to send' : 'LIVE'})`);
    loop();
    render();
  }
  function stop() { if (running) stopReason = 'stopped by you'; running = false; clearLive(); save(); dropLock(); console.log('[earlyGame] stopped'); render(); }

  // Settings out and in (the toolkit's Export / Import buttons). Never touches session-only settings.
  function exportCfg() { return { cfg: persistable() }; }
  function importCfg(o) {
    if (running && !cfg.dryRun) throw new Error('stop the live run first');
    return applyCfg(o);
  }
  // Live-safe, saving setter for other modules (Core plan): the same validation as importCfg, allowed while Autopilot runs,
  // and neverSell is unioned with what is already there. Settings poked straight onto `cfg` would not be saved.
  function tune(patch = {}) {
    const p = { ...patch };
    if (Array.isArray(p.neverSell)) p.neverSell = [...new Set([...cfg.neverSell, ...p.neverSell])];
    return applyCfg({ cfg: p });
  }
  function applyCfg(o) {
    const applied = [], skipped = [];
    for (const [k, v] of Object.entries(o?.cfg ?? {})) {
      const f = FIELDS[k];
      const ok = k in cfg && !SESSION_ONLY.includes(k) && typeof v === typeof cfg[k] && Array.isArray(v) === Array.isArray(cfg[k])
        && (typeof v !== 'number' || Number.isNaN(v) === false)
        && !(f && ((f.min != null && v < f.min) || (f.max != null && v > f.max)));
      if (ok) { cfg[k] = v; applied.push(k); } else skipped.push(k);
    }
    save(); render();
    return { applied, skipped };
  }
  function resetCfg() {
    if (running && !cfg.dryRun) throw new Error('stop the live run first');
    for (const k of Object.keys(DEFAULTS)) if (!SESSION_ONLY.includes(k)) cfg[k] = Array.isArray(DEFAULTS[k]) ? [...DEFAULTS[k]] : DEFAULTS[k];
    save(); render();
  }

  // After a reload with cfg.liveResume (and this tab was running Live less than 10 min ago): 60 s to cancel.
  async function liveCountdown() {
    liveCountdownUntil = Date.now() + 60000;
    panel(true);
    core.notify('AP', 'Autopilot resumes LIVE in 60 s', 'Open the Autopilot panel and press Cancel to resume as a dry run instead.');
    while (liveCountdownUntil && Date.now() < liveCountdownUntil) {
      if (unloaded) return false;
      render();
      await sleep(500);
    }
    const go = liveCountdownUntil !== 0;
    liveCountdownUntil = 0;
    render();
    return go;
  }

  function keepPaused(id) { keptPaused.add(+id); billPaused.delete(+id); save(); console.log(`[earlyGame] group ${id} will never be auto-resumed`); }

  // What the next planned steps need, for CD Farm's Auto mode: the power-bill money floor (cents), items it must not
  // use (floor kits owed to unequipped buildings, an hour of what running groups eat, the next unlock's prototype),
  // and the next unlock with the CD it costs and whether everything else for it is ready. null until the game state is read.
  function reserve() {
    const s = read();
    if (!s) return null;
    const items = {};
    const add = (item, n) => { if (n > 0) items[item] = (items[item] ?? 0) + n; };
    for (const [item, n] of Object.entries(s.kitOwed)) add(item, n);
    for (const [item, perMin] of Object.entries(s.eatPerMin)) add(item, Math.ceil(perMin * 60));
    let next = null;
    const nt = nextTech(s);
    const tech = nt && s.catalog.techs.find((t) => t.building === nt.b);
    if (tech) {
      const proto = s.bld(nt.b).build_items ?? [];
      for (const p of proto) add(p.item, p.amount);
      const gate = nt.gate ? nt.gate(s) : true;
      const missing = proto.find((p) => s.has(p.item) < p.amount);
      const note = gate !== true ? gate : tech.requires != null && !s.unlocked(tech.requires) ? `${bname(s, tech.requires)} to be unlocked`
        : missing ? `the ${iname(s, missing.item)} prototype` : '';
      next = { b: nt.b, name: bname(s, nt.b), cd: tech.cost, prereqsMet: !note, note };
    }
    // What Autopilot's own selling keeps: wood and floor reserves, and the build items of its next two plan builds.
    add(WOOD, cfg.woodReserve);
    for (const item of [WOOD, ...Object.keys(s.eatPerMin).map(Number)]) add(item, floorReserve(s, item));
    for (const t of criticalTargets(s).slice(0, 2)) for (const p of s.bld(t.b).build_items ?? []) add(p.item, p.amount);
    return { moneyFloor: Math.max(moneyFloor(s), cfg.boosterKeepCash * 100), items, nextTech: next, phase: phaseOf(s) };
  }

  // Pause after the current step (resolves once nothing is being sent), e.g. CD Farm before it
  // takes its baseline of unassigned camps. Holds live in memory only; release() lifts one.
  async function hold(who = 'you') {
    holds.add(String(who)); render();
    const t0 = Date.now();
    while (inStep && Date.now() - t0 < 60000) await sleep(100);
  }
  function release(who = 'you') { holds.delete(String(who)); render(); }

  function plan() {
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const a = decide(s);
    console.log('[earlyGame] next: ' + (a.wait ? 'wait — ' + a.wait : a.reason), a.steps?.map((x) => x.msg) ?? '');
    return a;
  }

  function checklist(s) {
    const mark = (ok) => (ok ? '✓' : '·');
    const row = (label, have, target) => [label, `${mark(have >= target)} ${have} / ${target === Infinity ? '∞' : target}`];
    const techState = (b) => (s.unlocked(b) ? '✓' : s.research?.building === b ? 'researching' : s.queue.some((q) => q.building === b) ? 'queued' : '·');
    return [
      ['Phase', String(phaseOf(s))],
      ['Money', `${usd(s.money)} (floor ${usd(moneyFloor(s))})`],
      ['CD', s.cd],
      ['Acres', `${s.acresUsed} / ${s.acresOwned} · next ${usd(acrePrice(s.landBought))}`],
      ['Power', `${s.powerHave} MW (need ${s.powerNeed})`],
      ['Lumber Camps / Farms', `${s.owned(B.CAMP)} / ${s.owned(B.FARM)}`],
      ...techPlan().map((t) => [`P${t.phase} unlock ${bname(s, t.b)}`, techState(t.b)]),
      row('Sawmills', s.owned(B.SAWMILL), sawTarget(s)),
      row('Workshops (Frame Timber)', s.running(B.WORKSHOP, R.FRAME_TIMBER), cfg.workshops),
      row('Iron Mines', s.running(B.MINE, R.MINE_IRON), cfg.ironMines),
      row('Coal Mines', s.running(B.MINE, R.MINE_COAL), cfg.coalMines),
      row('Limestone Quarries', s.owned(B.QUARRY), cfg.quarries),
      row('Smelters', s.owned(B.SMELTER), cfg.smelters),
      row('Gold Mines', s.running(B.MINE, R.MINE_GOLD), cfg.goldMines),
      row('Workshops (Iron Frames)', s.running(B.WORKSHOP, R.RIVET), cfg.ironFrameWorkshops),
      ['Planks / Wooden / Iron Frames', `${Math.floor(s.has(PLANKS))} / ${Math.floor(s.has(WFRAME))} / ${Math.floor(s.has(IFRAME))}`],
      ['Unequipped (no kit)', s.groups.filter((g) => g.count > (g.equipped ?? 0)).map((g) => `${g.name} ${g.count - (g.equipped ?? 0)}`).join(', ') || '—'],
      ['Courier', s.courierFree ? 'free' : `busy, ${courierEta(s)}${Object.keys(s.standing).length ? ' (auto-ship running)' : ''}`],
      ['Floorplans', floorPlans(s).map((f) => `${f.task} x${f.cur.rate}${f.upgrade ? `→x${f.best.rate}` : ' ✓'}`).join(', ') || '—'],
      ['Starved', s.starved.map((g) => g.name).join(', ') || '—'],
      ['Paused', s.groups.filter((g) => g.paused).map((g) => `${g.name}${billPaused.has(g.id) && !keptPaused.has(g.id) ? ' (unpaid bill: auto-resume)' : ' (yours: left alone)'}`).join(', ') || '—'],
    ];
  }

  function status() {
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const d = decide(s);
    const rows = [...checklist(s),
      ['Next', d.wait ? 'wait — ' + d.wait : d.reason],
      ['Mode', `${running ? 'running' : 'stopped'}${cfg.dryRun ? ' (dry run)' : ''}`]];
    console.table(Object.fromEntries(rows));
    return rows;
  }

  function floors() {
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const rows = floorTable(s);
    console.log(`[earlyGame] floorplans — scorer: ${s.engine && !scorerBroken ? 'live (game engine)' : 'not found, using known rates'}`);
    console.table(rows);
    return rows;
  }

  // "Before you go offline": keep `hours` of power bills, and say what to check.
  function offline(hours = 8) {
    cfg.billHours = Math.max(1, hours); save();
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const need = moneyFloor(s);
    const nt = nextTech(s);
    console.log(`[earlyGame] offline for ${hours} h:` +
      `\n  • power ${s.powerHave} MW → keep ${usd(need)} for bills (have ${usd(s.money)})${s.money < need ? '  ⚠ NOT ENOUGH: powered groups will pause' : ' ✓'}` +
      '\n  • the script now never spends below that, until the page reloads (earlyGame.cfg.billHours = 1 to undo)' +
      "\n  • auto-ship and selling stop while you're offline; stock piles up (24 h cap on the free plan)" +
      `\n  • research: ${s.research ? `${bname(s, s.research.building)} running ✓` : nt ? `idle — next is ${bname(s, nt.b)} (start a long unlock before leaving)` : 'idle'}`);
  }


// continues the autopilot closure from autopilot-4.js (same try / IIFE)
  // ---- game UI ----------------------------------------------------------------------
  // Same look as CD Farm (the game's CSS variables and button classes): an "Autopilot" tab in the
  // sidebar, a chip in the top bar, and a draggable card that opens bottom-left (CD Farm's card
  // opens bottom-right). Nothing here runs without a DOM, so the offline simulator is unaffected.

  const UI_KEY = 'earlyGame.ui';
  const ui = (() => { try { return { open: true, x: null, y: null, ...JSON.parse(store?.getItem(UI_KEY) || '{}') }; } catch { return { open: true, x: null, y: null }; } })();
  const saveUi = () => { try { store?.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };


  const ICON = '<svg class="nav-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16h4v-4h4V8h4V4"></path><circle cx="15" cy="4" r="1.6" fill="currentColor" style="stroke:var(--nav-accent)"></circle></svg>';

  const mk = core.h;
  const K = core.ui;
  const uiNum = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const parseAmount = (str) => {
    const m = String(str).trim().replace(/[$,\s_]/g, '').match(/^(\d*\.?\d+)([kmb])?$/i);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1));
  };

  let P = null, chrome = null, uiTimer = null, unloaded = false;
  const refs = {};
  let confirmUntil = 0;

  const FIELDS = {
    workshops: { kind: 'count', label: 'Frame Timber Workshops', min: 0, max: 50 },
    sawmills: { kind: 'count', label: 'Sawmills (at least)', min: 0, max: 200 },
    ironMines: { kind: 'count', label: 'Iron Mines', min: 0, max: 100 },
    coalMines: { kind: 'count', label: 'Coal Mines', min: 0, max: 100 },
    goldMines: { kind: 'count', label: 'Gold Mines', min: 0, optional: true, empty: 'No limit' },
    ironFrameWorkshops: { kind: 'count', label: 'Iron Frame Workshops', min: 0, max: 50 },
    maxAcrePriceEarly: { kind: 'money', label: 'Land wall, early', min: 0 },
    maxAcrePrice: { kind: 'money', label: 'Land wall, later', min: 0 },
    boosterBatch: { kind: 'count', label: 'Booster batch', min: 1, max: 100 },
    boosterMinCash: { kind: 'money', label: 'Booster starts above', min: 0 },
    boosterKeepCash: { kind: 'money', label: 'Booster keeps', min: 0 },
    // Advanced
    quarries: { kind: 'count', label: 'Limestone Quarries', min: 0, max: 50 },
    smelters: { kind: 'count', label: 'Smelters', min: 0, max: 50 },
    maxAcrePriceCritical: { kind: 'money', label: 'Land wall, plan buildings', min: 0 },
    landCashShare: { kind: 'pct', label: 'Land: share of cash', min: 0, max: 1, unit: '%' },
    boosterAcres: { kind: 'count', label: 'Booster acres kept free', min: 0, max: 100 },
    woodReserve: { kind: 'count', label: 'Wood never sold below', min: 0, max: 1000000 },
    sellKeepMinutes: { kind: 'count', label: 'Keep minutes of use', min: 0, max: 1440, unit: 'min' },
    maxBuyPrice: { kind: 'mult', label: 'Max buy price (× base)', min: 0.1, max: 100, unit: '×' },
    floorBuyUsd: { kind: 'usd', label: 'Floor parts, $ per unit', min: 0, max: 1000 },
    buyOrderUsd: { kind: 'usd', label: 'Buy order, $ per unit', min: 0.01, max: 1000 },
    orderHoldHours: { kind: 'count', label: 'Order hold', min: 0, max: 720, unit: 'h' },
    maxActionsPerMin: { kind: 'count', label: 'Max actions per minute', min: 1, max: 60 },
    intervalMs: { kind: 'count', label: 'Check every', min: 500, max: 60000, unit: 'ms' },
    maxIdleMs: { kind: 'count', label: 'Slowest idle check', min: 500, max: 120000, unit: 'ms' },
    stallMinutes: { kind: 'count', label: 'Stall alert after', min: 0, max: 600, unit: 'min' },
  };
  const ADV_FIELDS = ['quarries', 'smelters', 'maxAcrePriceCritical', 'landCashShare', 'boosterAcres', 'woodReserve', 'sellKeepMinutes', 'maxBuyPrice', 'floorBuyUsd', 'buyOrderUsd', 'orderHoldHours', 'maxActionsPerMin', 'intervalMs', 'maxIdleMs', 'stallMinutes'];
  const CHECKS = [
    ['sellAll', 'Sell spare full courier loads'],
    ['cdBooster', 'CD booster (build + demolish)'],
    ['floorUpgrades', 'Apply better floorplans'],
    ['buyKits', 'Buy kit parts the corp can\'t make'],
    ['postBuyOrders', 'Post buy orders when no one sells'],
    ['dispatchOffice', 'Also unlock the Dispatch Office'],
    ['autoResume', 'Resume after reload (as a dry run unless Live resume is on)'],
  ];
  const ADV_CHECKS = [
    ['liveResume', 'Live resume: after a reload in this tab, go Live again after a 60 s cancel window'],
    ['autoShipCotton', 'Auto-ship Cotton'],
    ['saveForCritical', 'Save for a ready plan building before buying camps/farms'],
    ['resumePaused', 'Resume groups paused by an unpaid bill'],
  ];
  const VIA = [
    { id: 'builtin', label: 'Built-in', desc: 'Builds and demolishes the cheaper of Lumber Camp / Farm itself, after a 1-building test.' },
    { id: 'cdFarm', label: 'CD Farm', desc: 'Starts CD Farm up to the CD the next unlock needs, then waits until it stops. CD Farm\'s own settings come back afterwards.' },
  ];
  const MODES = [
    { id: true, label: 'Dry run' },
    { id: false, label: 'Live' },
  ];

  function setCfg(key, v) { cfg[key] = v; confirmUntil = 0; save(); render(); }
  const shownOf = (key, v) => (Number.isFinite(v) ? uiNum(FIELDS[key]?.kind === 'pct' ? v * 100 : v) : '');
  const shown = (key) => shownOf(key, cfg[key]);
  const same = (a, b) => (Array.isArray(a) ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b));
  const viaOf = (v) => (v === 'cdFarm' ? 'cdFarm' : 'builtin');
  const parseErr = {};
  function parseField(key, text) {
    const f = FIELDS[key];
    const str = text.trim();
    if (str === '') return f.optional ? { v: Infinity } : { err: 'Required.' };
    const decimal = f.kind === 'usd' || f.kind === 'mult' || f.kind === 'pct';
    let v;
    if (decimal) {
      v = /^[$]?\d*\.?\d+[%×x]?$/i.test(str.replace(/[,\s_]/g, '')) ? Number(str.replace(/[$,%×x\s_]/gi, '')) : null;
      if (v != null && f.kind === 'pct') v /= 100;
    } else v = parseAmount(str);
    if (v == null) return { err: decimal ? 'Use a number like 1 or 0.5.' : f.kind === 'money' ? 'Use an amount like 500, 20k or 1.5m.' : 'Use a whole number.' };
    const disp = (x) => uiNum(f.kind === 'pct' ? x * 100 : x);
    if (f.min != null && v < f.min) return { err: `At least ${disp(f.min)}.` };
    if (f.max != null && v > f.max) return { err: `At most ${disp(f.max)}.` };
    return { v };
  }
  function textField(key) {
    const f = FIELDS[key];
    const { input, box } = K.inputBox({ label: f.label, prefix: f.kind === 'money' || f.kind === 'usd' ? '$' : '', suffix: f.unit, placeholder: f.empty || '' });
    const msg = mk('div', { class: 'idc-msg error', hidden: true });
    const revert = () => { delete parseErr[key]; input.value = shown(key); };
    input.addEventListener('input', () => {
      const p = parseField(key, input.value);
      if (p.err) { parseErr[key] = p.err; render(); } else { delete parseErr[key]; setCfg(key, p.v); }
    });
    input.addEventListener('blur', () => { revert(); render(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { revert(); input.blur(); } });
    const el = K.field(f.label, box, msg);
    refs.fields[key] = { input, box, msg, el };
    return el;
  }
  const row = K.row;
  const signed = (c) => (c < 0 ? '−' : '+') + usd(Math.abs(c));

  function doReset() {
    try {
      const snap = exportCfg();
      resetCfg();
      core.toast('Autopilot settings are back to their defaults', { undo: () => { if (unloaded) return; try { importCfg(snap); } catch (e) { core.toast(e.message, 'error'); } } });
    } catch (e) { core.toast(e.message, 'error'); }
  }
  function doClearLog() {
    const snap = core.ledger.list();
    core.ledger.clear(); render();
    core.toast('Log cleared', { undo: () => { if (unloaded) return; core.ledger.restore(snap); render(); } });
  }

  function buildPanel() {
    refs.badge = mk('span', { class: 'idc-badge' });

    // ---- Status tab
    refs.phase = mk('span', { class: 'idc-big' });
    refs.phaseOf = mk('span', { class: 'idc-label' });
    refs.bar = mk('i');
    refs.rows = mk('div', { class: 'idc-rows' });
    refs.stateDot = mk('span', { class: 'idc-dot' });
    refs.state = mk('span');
    refs.noteText = mk('span');
    refs.noteBtn = mk('button', { type: 'button', onclick: () => W.cdFarm?.panel?.(true) }, 'Open CD Farm');
    refs.note = mk('div', { class: 'idc-note', hidden: true }, refs.noteText, refs.noteBtn);
    refs.log = mk('div', { class: 'idc-recent', 'aria-live': 'polite' });
    const banner = (label, onclick) => { const text = mk('span'); const btn = mk('button', { type: 'button', onclick }, label); return { text, btn, el: mk('div', { class: 'idc-note', hidden: true }, text, btn) }; };
    refs.live = banner('Cancel: resume as a dry run', () => { liveCountdownUntil = 0; render(); });
    refs.stall = banner('Snooze', () => { stalled = ''; core.setBadge('AP', ''); prog.at = nowMs(); prog.acts = 0; render(); });
    refs.check = mk('div', { class: 'idc-rows' });
    const checklistSec = mk('details', { class: 'idc-sec', open: !!ui.checkOpen }, mk('summary', {}, 'Checklist'), refs.check);
    checklistSec.addEventListener('toggle', () => { ui.checkOpen = checklistSec.open; saveUi(); });
    const status = [
      mk('div', {}, mk('div', { class: 'idc-label' }, 'Early-game plan'), mk('div', { class: 'idc-hero' }, refs.phase, refs.phaseOf), mk('div', { class: 'idc-bar' }, refs.bar)),
      refs.rows,
      mk('div', { class: 'idc-state' }, refs.stateDot, refs.state),
      refs.note, refs.live.el, refs.stall.el, refs.log,
      checklistSec];

    // ---- Settings tab
    refs.fields = {};
    refs.via = K.seg(VIA, () => viaOf(cfg.boosterVia), (id) => setCfg('boosterVia', id), 'CD booster runs through');
    refs.viaDesc = mk('div', { class: 'idc-desc' });
    refs.viaField = K.field('CD booster runs through', refs.via.el, refs.viaDesc);
    refs.checks = [...CHECKS, ...ADV_CHECKS].map(([key, label]) => {
      const input = mk('input', { type: 'checkbox', onchange: () => setCfg(key, input.checked) });
      return [key, input, K.check(input, label)];
    });
    const checkEl = (key) => refs.checks.find(([k]) => k === key)[2];
    refs.hours = mk('input', { type: 'text', inputMode: 'decimal', autocomplete: 'off', value: '8', 'aria-label': 'Hours offline' });
    refs.billNow = mk('div', { class: 'idc-desc' });
    const offBtn = mk('button', { type: 'button', onclick: () => { const hrs = Number(refs.hours.value); if (hrs > 0) { offline(hrs); render(); } } }, 'Keep bills');
    const lockIcon = mk('span', { 'aria-hidden': 'true' });
    lockIcon.innerHTML = K.ICONS.lock;
    refs.lock = mk('div', { class: 'idc-lock' }, lockIcon, 'Stop the live run to change settings.');
    refs.fs = mk('fieldset', { class: 'idc-form' },
      K.group('Build targets', mk('div', { class: 'idc-two' }, ...['workshops', 'sawmills', 'ironMines', 'coalMines', 'goldMines', 'ironFrameWorkshops'].map(textField))),
      K.group('Land price limits', mk('div', { class: 'idc-two' }, ...['maxAcrePriceEarly', 'maxAcrePrice'].map(textField)),
        mk('div', { class: 'idc-desc' }, 'The most per acre Autopilot will pay for land, early on and later.')),
      K.group('CD booster', refs.viaField, mk('div', { class: 'idc-two' }, ...['boosterBatch', 'boosterMinCash', 'boosterKeepCash'].map(textField)), checkEl('cdBooster')),
      K.group('Automation', ...['sellAll', 'floorUpgrades', 'buyKits', 'postBuyOrders', 'dispatchOffice', 'autoResume'].map(checkEl)),
      K.group('Power bills', K.field('Going offline: keep power bills for',
        mk('div', { class: 'idc-inline' }, mk('div', { class: 'idc-inp' }, refs.hours, mk('span', {}, 'h')), offBtn), refs.billNow)),
      mk('details', { class: 'idc-sub', open: !!ui.advOpen, ontoggle: (e) => { ui.advOpen = e.target.open; saveUi(); } },
        mk('summary', {}, 'Advanced'),
        K.group(null, mk('div', { class: 'idc-two' }, ...ADV_FIELDS.map(textField)), ...ADV_CHECKS.map(([key]) => checkEl(key)))));
    refs.importBtn = mk('button', { type: 'button', onclick: () => core.importFile() }, 'Import settings');
    refs.resetBtn = K.confirmBtn('Reset settings', doReset, 'Click again to reset');
    const backup = K.group('Backup', mk('div', { class: 'idc-tools' }, mk('button', { type: 'button', onclick: () => core.exportFile() }, 'Export settings'), refs.importBtn, refs.resetBtn));
    const settings = [refs.lock, refs.fs, backup];

    // ---- Log tab
    refs.logv = K.createLogView();
    refs.alertBtn = mk('button', { type: 'button', title: 'Notify me when Autopilot stops, stalls or changes phase while this tab is in the background', onclick: async () => { await core.askNotify(); render(); } }, 'Enable alerts');
    const logTab = [
      refs.logv.el,
      mk('div', { class: 'idc-tools' },
        mk('button', { type: 'button', onclick: () => core.ledger.copy() }, 'Copy log'),
        mk('button', { type: 'button', class: 'danger', onclick: doClearLog }, 'Clear log'),
        refs.alertBtn),
      mk('div', { class: 'idc-desc' }, 'Alt+Shift+X stops Autopilot, CD Farm and the Lab runner from anywhere on the page.')];

    // ---- Footer (always visible)
    refs.mode = K.seg(MODES, () => !!cfg.dryRun, (id) => { cfg.dryRun = id; confirmUntil = 0; render(); }, 'Run mode');
    refs.plan = mk('div', { class: 'idc-plan' });
    refs.alt = mk('button', { onclick: () => { confirmUntil = 0; render(); } }, 'Cancel');
    refs.main = mk('button', { class: 'primary', onclick: onMain });
    const foot = mk('div', { class: 'idc-foot' }, refs.mode.el, refs.plan, mk('div', { class: 'idc-btns' }, refs.alt, refs.main));

    P = K.createPanel({
      id: 'ap', title: 'Autopilot', cls: 'egp-panel', state: ui, save: saveUi, headExtra: [refs.badge], foot,
      tabs: [{ id: 'status', label: 'Status', content: status }, { id: 'settings', label: 'Settings', content: settings }, { id: 'log', label: 'Log', content: logTab }],
      onClose: () => panel(false), onTab: () => render(), opener: () => chrome?.opener,
      // Default: bottom-left of the page content, just right of the game's sidebar.
      defaultPlace: () => { const side = document.querySelector('.primary-navigation')?.getBoundingClientRect(); return { left: side && side.right < innerWidth / 2 ? Math.round(side.right + 16) : 20 }; },
    });
    refs.dot = P.dot;
  }

  function onMain() {
    if (running) return stop();
    if (cfg.dryRun) return start();
    if (Date.now() < confirmUntil) { confirmUntil = 0; return start(); }
    confirmUntil = Date.now() + 6000;
    render();
    setTimeout(render, 6100);
  }

  // 'run' | 'wait' | 'err' | ''
  function tone() {
    if (running && stalled) return 'err';
    if (running) return heldReason() || cfg.dryRun ? 'wait' : 'run';
    if (stopReason && stopReason !== 'stopped by you') return 'err';
    return '';
  }

  function cdFarmNote() {
    const fi = farmInfo();
    if (fi?.busy) return { text: `CD Farm is running${fi.f.stats?.by ? ` (${fi.f.stats.by})` : ''}. Autopilot waits until it stops.`, btn: true };
    if (fi?.resumable) return { text: 'CD Farm has an interrupted run. Its leftover camps are left alone, and no camps, farms or booster run until you resume or discard it there.', btn: true };
    if (cfg.boosterVia === 'cdFarm' && !fi) return { text: 'The CD booster is set to CD Farm, but CD Farm isn\'t loaded: the built-in booster is used.', btn: false };
    if (holds.size) return { text: `Held by ${[...holds].join(', ')}. earlyGame.release() to go on.`, btn: false };
    return null;
  }

  function renderPanel(s) {
    const t = tone();
    refs.dot.className = refs.stateDot.className = 'idc-dot ' + t;
    refs.badge.textContent = cfg.dryRun ? 'Dry run' : 'Live';
    refs.badge.className = 'idc-badge' + (cfg.dryRun ? '' : ' live');
    if (!s) {
      refs.phase.textContent = '—'; refs.phaseOf.textContent = ''; refs.rows.replaceChildren(); refs.check.replaceChildren();
      refs.state.textContent = 'Waiting for the game to load…';
    } else {
      const ph = phaseOf(s);
      refs.phase.textContent = ph === 'done' ? 'Plan done' : `Phase ${ph}`;
      refs.phaseOf.textContent = ph === 'done' ? '' : 'of 5';
      const list = checklist(s);
      const marks = list.filter(([, v]) => /^(✓|·|researching|queued)/.test(v));
      refs.bar.style.width = (marks.length ? (marks.filter(([, v]) => v.startsWith('✓')).length / marks.length) * 100 : 0) + '%';
      refs.rows.replaceChildren(
        row('Money', `${usd(s.money)} · floor ${usd(moneyFloor(s))}`),
        row('CD', uiNum(s.cd)),
        row('Acres', `${s.acresUsed} / ${s.acresOwned} · next ${usd(acrePrice(s.landBought))}`),
        row('Power', `${s.powerHave} MW (need ${s.powerNeed})`),
        row('Courier', s.courierFree ? 'free' : `busy, ${courierEta(s)}`),
        row('Actions', `${actions} sent this session`),
        ...(cashRate() ? [row('Cash change', `${signed(cashRate().perHour)}/h (last ${cashRate().mins} min)`)] : []),
        ...(rateScale < 1 ? [row('Pace', `${Math.round(rateScale * 100)}% after an action the server did not apply`)] : []));
      const skip = new Set(['Phase', 'Money', 'CD', 'Acres', 'Power', 'Courier']);
      refs.check.replaceChildren(...list.filter(([k]) => !skip.has(k)).map(([k, v]) => row(k, String(v))));
      const held = running && heldReason();
      let next;
      try { const d = decide(s); next = d.wait ? 'Waiting: ' + d.wait : 'Next: ' + d.reason; } catch (e) { next = 'error: ' + e.message; }
      refs.state.textContent = held ? `Paused: ${held}`
        : running ? (cfg.dryRun ? 'Dry run. ' : '') + next
        : (stopReason ? `Stopped: ${stopReason}. ` : 'Stopped. ') + next;
    }
    const n = cdFarmNote();
    refs.note.hidden = !n;
    if (n) { refs.noteText.textContent = n.text; refs.noteBtn.hidden = !n.btn || !W.cdFarm?.panel; }
    refs.log.replaceChildren(...log.map((l) => mk('div', {}, l)));
    refs.live.el.hidden = !liveCountdownUntil;
    if (liveCountdownUntil) refs.live.text.textContent = `Resuming Live after the reload in ${Math.max(0, Math.ceil((liveCountdownUntil - Date.now()) / 1000))} s. Cancel to resume as a dry run instead.`;
    refs.stall.el.hidden = !stalled;
    if (stalled) refs.stall.text.textContent = `Looks stalled: ${stalled}. Autopilot keeps running; check the log below.`;
    if (ui.tab === 'log' && !ui.min) { refs.logv.render(); refs.logv.markSeen(); }
    const unseen = ui.tab === 'log' ? 0 : refs.logv.unseen();
    P.setTabBadge('log', unseen ? unseen + ' new problem' + (unseen > 1 ? 's' : '') : '', true);
    refs.alertBtn.hidden = core.notifyPerm() !== 'default';

    // Settings
    const locked = running && !cfg.dryRun;
    refs.importBtn.disabled = refs.resetBtn.disabled = locked;
    refs.fs.disabled = locked;
    refs.lock.hidden = !locked;
    let changed = 0;
    for (const [key, f] of Object.entries(refs.fields)) {
      if (document.activeElement !== f.input) f.input.value = shown(key);
      f.msg.hidden = !parseErr[key]; f.msg.textContent = parseErr[key] || '';
      f.box.classList.toggle('bad', !!parseErr[key]);
      const mod = !same(cfg[key], DEFAULTS[key]);
      if (mod) changed++;
      K.setModified(f.el, mod, 'Reset to the default (' + (shownOf(key, DEFAULTS[key]) || FIELDS[key].empty || 'none') + ')', () => { delete parseErr[key]; setCfg(key, DEFAULTS[key]); });
    }
    refs.via.sync();
    refs.viaDesc.textContent = VIA.find((v) => v.id === viaOf(cfg.boosterVia)).desc;
    const viaMod = viaOf(cfg.boosterVia) !== viaOf(DEFAULTS.boosterVia);
    if (viaMod) changed++;
    K.setModified(refs.viaField, viaMod, 'Reset to the default (' + VIA.find((v) => v.id === viaOf(DEFAULTS.boosterVia)).label + ')', () => setCfg('boosterVia', DEFAULTS.boosterVia));
    for (const [key, input, label] of refs.checks) {
      input.checked = !!cfg[key];
      const mod = !!cfg[key] !== !!DEFAULTS[key];
      label.classList.toggle('mod', mod); label.title = mod ? 'Changed from the default' : '';
      if (mod) changed++;
    }
    P.setTabBadge('settings', changed ? changed + ' setting' + (changed > 1 ? 's' : '') + ' changed from the defaults' : '');
        refs.billNow.textContent = `Now ${cfg.billHours} h${s ? ` = ${usd(moneyFloor(s))} kept` : ''}. Back to 1 h on reload.`;

    // Footer
    refs.mode.sync();
    refs.mode.btns.forEach((b) => { b.disabled = running || active; });
    const other = lockOwner() && lockOwner() !== TAB && !running;
    const confirming = !running && !cfg.dryRun && Date.now() < confirmUntil;
    refs.plan.hidden = running;
    refs.plan.classList.toggle('hot', confirming);
    refs.plan.textContent = cfg.dryRun
      ? 'Dry run: works out every step and writes it to the log, but sends nothing.'
      : `Live: sends actions to the game, one confirmed step at a time, and never spends below the power-bill floor${s ? ` (${usd(moneyFloor(s))})` : ''}.${confirming ? ' Click Confirm start to go.' : ''}`;
    refs.main.textContent = running ? 'Stop' : other ? 'Running in another tab' : active ? 'Stopping…' : cfg.dryRun ? 'Start dry run' : confirming ? 'Confirm start' : 'Start live';
    refs.main.disabled = !running && (other || active || !s);
    refs.alt.hidden = !confirming;
  }

  const onResize = () => P?.place();

  function render() {
    if (!HAS_DOM || unloaded) return;
    const s = read();
    const t = tone();
    const ph = s ? phaseOf(s) : null;
    chrome?.setPill(heldReason() ? 'Held' : cfg.dryRun ? 'Dry run' : ph === 'done' ? 'Done' : `P${ph ?? '?'}`, t, !running);
    chrome?.setChip(ph == null ? 'Autopilot' : ph === 'done' ? 'Plan done' : `Phase ${ph}`, t,
      `Autopilot · ${running ? (heldReason() ? 'paused' : cfg.dryRun ? 'dry run' : 'live') : 'stopped'}`);
    const open = !!P?.el.isConnected;
    chrome?.setOpen(open);
    if (open) renderPanel(s);
  }

  function panel(show = true, opts = {}) {
    if (!HAS_DOM || unloaded) return;
    if (show) { if (!P) buildPanel(); P.mount(opts); } else P?.unmount();
    ui.open = !!show; saveUi();
    render();
  }

  function mountUi() {
    chrome = K.createChrome({
      label: 'Autopilot', navTitle: 'Early-game autopilot', icon: ICON, navClass: 'egp-tab', chipClass: 'egp-chip',
      onToggle: () => K.togglePanel(P, ui, panel),
      navInsert: (nav, el) => nav.insertBefore(el, nav.querySelector('.cdf-tab')),   // above CD Farm's tab
      chipInsert: (tools, el) => tools.insertBefore(el, tools.querySelector('.cdf-chip') || tools.querySelector('.tip-anchor') || null),
    });
    chrome.mount();
    uiTimer = setInterval(render, 1000);
    if (ui.open) panel(true); else render();
    addEventListener('resize', onResize);
  }
  function unmountUi() {
    clearInterval(uiTimer); uiTimer = null;
    P?.unmount(); chrome?.unmount();
    P = chrome = null;
    removeEventListener('resize', onResize);
  }

// continues the autopilot closure from autopilot-5.js (same try / IIFE)
  // ---- load ---------------------------------------------------------------------------

  W.earlyGame = {
    start, stop, plan, status, floors, offline, keepPaused, panel, read, decide, cfg, hold, release, reserve, tune, exportCfg, importCfg, resetCfg,
    get stalled() { return stalled; },
    get running() { return running; },
    get active() { return active; },
    get busy() { return isLive(); },   // sending live actions
    get held() { return heldReason(); },
    // Pure pieces for the offline simulator.
    _core: {
      checkGame, watchStall, stalledNow: () => stalled, resetWatch: () => { stalled = ''; prog.at = 0; lastPhase = null; },
      snapshot: fullSnapshot, normalize, decide, checklist, phaseOf, finish, observe, userPaused, billPaused, floorTable, bomOf,
      setClock: (fn) => { nowMs = fn; courierHoldUntil = 0; courierMisses = 0; cooldowns.clear(); successes.clear(); failures.clear(); boosterBad = 0; for (const k in boosterLeft) delete boosterLeft[k]; },
    },
    _unload: () => {
      unloaded = true; running = false; holds.clear(); dropLock(); core.setBadge('AP', ''); core.reserves?.unregister('earlyGame');
      if (HAS_DOM) unmountUi();
    },
  };

  // Calls go through the exported object so anything wrapping earlyGame.hold / release (tests, other scripts) still sees them.
  core.reserves?.register('earlyGame', {
    reserve: () => (W.earlyGame?.reserve ?? reserve)(),
    busy: () => (W.earlyGame ? W.earlyGame.busy : isLive()),
    hold: (w) => (W.earlyGame?.hold ?? hold)(w),
    release: (w) => (W.earlyGame?.release ?? release)(w),
  });

  // Wait for the game to render and connect before mounting or resuming.
  if (HAS_DOM) (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    mountUi();
    console.log('[earlyGame] ready (dry run by default). Open "Autopilot" in the sidebar, or earlyGame.status() / earlyGame.plan() / earlyGame.start()');
    if (W.cdFarm?.running) console.warn('[earlyGame] CD Farm is running; Autopilot waits until it stops.');
    if (wasRunning && cfg.autoResume) {
      while (!read()?.wsOpen) { if (unloaded) return; await sleep(500); }
      await sleep(2000); // let the fresh snapshot land
      if (unloaded || running) return;
      let live = false;
      if (cfg.liveResume && liveFlag) { live = await liveCountdown(); if (unloaded || running) return; }
      cfg.dryRun = !live;
      console.log(live ? '[earlyGame] resuming the run from before the reload, LIVE (liveResume)'
        : '[earlyGame] resuming the run from before the reload (as a DRY RUN: switch to Live in the panel to send again)');
      start();
    }
  })();
})();
} catch (e) { console.error('[IdleCorp] Autopilot failed to load:', e); }
