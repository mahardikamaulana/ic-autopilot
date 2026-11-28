// @@MODULE module-watch
// Module watch: an alert when the Module Exchange lists a module that matches one of your saved watches. It never buys.
// A watch is a filter in the game's own words: kinds (overclock, refiner, efficiency, calibrator, amplifier, blank), rarities
// (fine … mythic = 2 … 6 quirks), quirks with or without a bound (twinned, twinned >= 10, corner-tuned < 50), "quirks >= 3" and
// "price <= 500" (dollars). Words of one watch must all hold, except kinds, where any one is enough (the game's rule).
// The server sends other Corporations' listings only while the socket has a "ModuleListings" board filter: the game's Module
// Exchange page sets one while it is open and clears it when it closes. With a watch on and the page closed, this module sets the
// watch's own filter (several watches take turns, ROTATE_MS each); while the page is open it only reads what the page asked for.
// A listing alerts once per watch (ids kept in this browser), never for your own or expired ones: a ledger line, a toast while the
// tab is visible, a desktop notification while it is hidden (after "Allow desktop alerts"), and a tab-title badge until you open the
// Module Exchange page.
//   moduleWatch.add('overclock mythic price <= 500')   moduleWatch.toggle(id, on)   moduleWatch.remove(id)   moduleWatch.list()   moduleWatch.status()
// UI: a "Watch" button in the Module Exchange heading opens the watch list. Saved in this browser (idc.moduleWatch); settings export/import carry the watches.
try {
  (() => {
    const W = typeof window !== 'undefined' ? window : globalThis;
    const core = W.idleCore;
    if (!core) throw new Error('the shared core did not load');
    const HAS_DOM = typeof document !== 'undefined' && !!document.body;
    const KEY = 'idc.moduleWatch', TAG = 'MW', BOARD = 'ModuleListings';
    const ROTATE_MS = 20000, TICK_MS = 2000, MAX_WATCHES = 8, SEEN_MAX = 1000;
    if (W.moduleWatch?._unload) W.moduleWatch._unload();
    const h = core.h;
    const own = (obj, key) => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);

    // ---- the game's filter words (client bundle index-DnZR5vdC.js, 2026-11-28) ------------------------------------------
    const KINDS = { overclock: 61, refiner: 62, efficiency: 131, calibrator: 132, amplifier: 133, blank: 134 };
    const KIND_NAME = { 61: 'Overclock', 62: 'Refiner', 131: 'Efficiency', 132: 'Calibrator', 133: 'Amplifier', 134: 'Blank' };
    const RARITY = ['', '', 'Fine', 'Superior', 'Exceptional', 'Legendary', 'Mythic'];   // index = number of quirks
    const QUIRKS = { loner: 'Loner', twinned: 'Twinned', discordant: 'Discordant', cornertuned: 'CornerTuned', 'corner-tuned': 'CornerTuned', instrumented: 'Instrumented', bulktuned: 'BulkTuned', 'bulk-tuned': 'BulkTuned', specialist: 'Specialist', insightful: 'Insightful' };
    const OPS = { '>=': 'Ge', '<=': 'Le', '>': 'Gt', '<': 'Lt', '=': 'Eq' };
    const TOKEN = /([a-z-]+)\s*(>=|<=|=|>|<)\s*(\d+(?:\.\d+)?)|([a-z-]+)|(\S+)/g;

    // Text -> { f: { kinds, nums, quirks }, bad: [words not understood], empty }. nums: { field: 'price' | 'quirks', op, value }.
    function parse(q) {
      const f = { kinds: [], nums: [], quirks: [] }, bad = [];
      for (const m of String(q ?? '').toLowerCase().replace(/,/g, ' ').matchAll(TOKEN)) {
        const [all, word, op, val, bare, junk] = m;
        if (junk) { bad.push(junk); continue; }
        if (word) {
          if (word === 'price' || word === 'quirks') f.nums.push({ field: word, op, value: Number(val) });
          else if (own(QUIRKS, word)) f.quirks.push({ quirk: QUIRKS[word], op, value: Number(val) });
          else bad.push(all);
          continue;
        }
        const rarity = RARITY.findIndex((r) => r.toLowerCase() === bare);
        if (own(KINDS, bare) != null) f.kinds.push(KINDS[bare]);
        else if (rarity > 1) f.nums.push({ field: 'quirks', op: '=', value: rarity });
        else if (own(QUIRKS, bare)) f.quirks.push({ quirk: QUIRKS[bare], op: null, value: null });
        else bad.push(bare);
      }
      return { f, bad, empty: !f.kinds.length && !f.nums.length && !f.quirks.length };
    }
    // The board filter the game's page would send for the same words ($O in the client: price and quirk count both x100).
    const serverFilter = (f) => ({
      items: f.kinds.slice(), sides: [], regions: [], utilities: [],
      quirks: f.quirks.map((q) => ({ quirk: q.quirk, op: q.op != null ? OPS[q.op] : null, value: q.op != null ? q.value : null })),
      nums: f.nums.map((n) => ({ field: n.field === 'price' ? 'Price' : 'QuirkCount', op: OPS[n.op], value: Math.round(n.value * 100) })),
    });
    const cmp = (a, op, b) => (op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : op === '<' ? a < b : a === b);
    // The number a quirk bound compares (TR in the client); null for quirks without one.
    function quirkValue(q) {
      switch (q.kind) {
        case 'Loner': case 'Twinned': case 'Discordant': case 'Insightful': return q.pct;
        case 'CornerTuned': return q.elsewhere_pct;
        case 'BulkTuned': return q.outputs_pct;
        default: return null;
      }
    }
    // A listing against a parsed watch, the way the game's page filters its rows (A$ / fx in the client).
    function matches(f, l) {
      const m = l?.module;
      if (!m) return false;
      if (f.kinds.length && !f.kinds.includes(m.kind)) return false;
      const quirks = m.quirks ?? [];
      for (const n of f.nums) if (!cmp(n.field === 'price' ? l.asking_price / 100 : quirks.length, n.op, n.value)) return false;
      for (const q of f.quirks) {
        const hits = quirks.filter((x) => x.kind === q.quirk);
        if (!hits.length) return false;
        if (q.op != null && !hits.some((x) => { const v = quirkValue(x); return v != null && cmp(v, q.op, q.value); })) return false;
      }
      return true;
    }
    function moduleName(m) {
      const rarity = RARITY[Math.min(m.quirks?.length ?? 0, RARITY.length - 1)];
      const mk = /Mk(\d+)$/.exec(m.name ?? '')?.[1] ?? (Number.isFinite(m.id) ? m.id + 1 : null);
      return [rarity, (KIND_NAME[m.kind] ?? 'Unknown') + ' Module', mk != null ? 'Mk' + mk : ''].filter(Boolean).join(' ');
    }
    const usd = (cents) => '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

    // ---- saved watches ---------------------------------------------------------------------------------------------------
    let watches = [], nextId = 1, seen = [], seenSet = new Set();
    function restore() {
      const o = core.settings(KEY).load();
      watches = [];
      for (const w of Array.isArray(o?.watches) ? o.watches : []) {
        const p = parse(w?.q);
        if (!p.bad.length && !p.empty && watches.length < MAX_WATCHES) watches.push({ id: Number(w.id) || 0, q: String(w.q).trim(), on: w.on !== false, p });
      }
      nextId = Math.max(1, Number(o?.nextId) || 1, ...watches.map((w) => w.id + 1));
      for (const w of watches) if (!w.id) w.id = nextId++;
      seen = Array.isArray(o?.seen) ? o.seen.filter((s) => typeof s === 'string').slice(-SEEN_MAX) : [];
      seenSet = new Set(seen);
    }
    function save() {
      core.settings(KEY).save({ watches: watches.map(({ id, q, on }) => ({ id, q, on })), nextId, seen });
    }
    function markSeen(key) {
      seen.push(key); seenSet.add(key);
      if (seen.length > SEEN_MAX) for (const k of seen.splice(0, seen.length - SEEN_MAX)) seenSet.delete(k);
    }

    function add(q) {
      const text = String(q ?? '').trim(), p = parse(text);
      if (p.bad.length) throw new Error('not a filter word: ' + p.bad.join(', '));
      if (p.empty) throw new Error('a watch needs at least one word, e.g. "overclock mythic price <= 500"');
      if (watches.length >= MAX_WATCHES) throw new Error('at most ' + MAX_WATCHES + ' watches');
      if (watches.some((w) => w.q.toLowerCase() === text.toLowerCase())) throw new Error('already watched: ' + text);
      const w = { id: nextId++, q: text, on: true, p };
      watches.push(w);
      save();
      core.ledger.add(TAG, 'info', 'watch added: ' + text);
      changed();
      return { id: w.id, q: w.q, on: w.on };
    }
    function find(id) { const w = watches.find((x) => x.id === Number(id)); if (!w) throw new Error('no watch ' + id); return w; }
    function toggle(id, on) {
      const w = find(id);
      w.on = on === undefined ? !w.on : !!on;
      save();
      core.ledger.add(TAG, 'info', 'watch ' + (w.on ? 'on' : 'off') + ': ' + w.q);
      changed();
      return w.on;
    }
    function remove(id) {
      const w = find(id);
      watches = watches.filter((x) => x !== w);
      save();
      core.ledger.add(TAG, 'info', 'watch removed: ' + w.q);
      changed();
    }
    const list = () => watches.map(({ id, q, on }) => ({ id, q, on, ...(stats.get(id) ?? {}) }));

    // ---- who owns the board filter, and which watch is asked for ---------------------------------------------------------
    const onExchangePage = () => /^\/market\/exchange/.test(W.location?.pathname ?? '');
    let cur = null;           // { id, at }: the watch whose filter we sent last
    let owner = 'none';       // 'page' | 'watch' | 'none'
    const stats = new Map();  // watch id -> { lastAt, rows, truncated, alerts }
    let pending = 0;          // alerted listings not looked at yet (title badge)

    function tick() {
      if (onExchangePage() && pending) { pending = 0; core.setBadge(TAG, null); }
      core.walk();   // attaches the core to a new socket after a reconnect
      const s = core.sock, ws = s.ws;
      if (!ws || ws.readyState !== 1 || core.link().state !== 'open') { owner = 'none'; cur = null; return; }
      const rec = s.boards?.[BOARD];
      const active = watches.filter((w) => w.on);
      if (onExchangePage() || (rec && !rec.ours && rec.filter)) { owner = 'page'; cur = null; return; }
      if (!active.length) {
        if (rec?.ours && rec.filter) core.sendBoardFilter(BOARD, null);
        owner = 'none'; cur = null;
        return;
      }
      owner = 'watch';
      const at = cur ? active.findIndex((w) => w.id === cur.id) : -1;
      const due = !rec?.ours || !rec.filter || at < 0 || (active.length > 1 && Date.now() - cur.at >= ROTATE_MS);
      if (!due) return;
      const next = active[(at + 1) % active.length];
      if (core.sendBoardFilter(BOARD, serverFilter(next.p.f))) cur = { id: next.id, at: Date.now() };
    }

    // ---- frames: every listing the server sends, for our filter or the page's ---------------------------------------------
    function onFrame(m) {
      if (m.kind === 'Listings') see(m.listings, m);
      else if (m.kind === 'ListingUpdate') see(m.changed, null);
    }
    function see(rows, board) {
      const me = core.walk().st?.ssi?.corp_id;
      if (me == null || !Array.isArray(rows)) return;   // no corp id yet: skip the reply (the next rotation sends the board again)
      const now = core.nowTick();
      if (board && owner === 'watch' && cur) stats.set(cur.id, { ...(stats.get(cur.id) ?? {}), lastAt: Date.now(), rows: rows.length, truncated: !!board.truncated });
      const hits = new Map();
      for (const l of rows) {
        if (!l || l.id == null || l.seller === me || (now && l.expires_at && l.expires_at <= now)) continue;
        for (const w of watches) {
          if (!w.on) continue;
          const key = w.id + ':' + l.id;
          if (seenSet.has(key) || !matches(w.p.f, l)) continue;
          markSeen(key);
          if (!hits.has(w)) hits.set(w, []);
          hits.get(w).push(l);
        }
      }
      if (!hits.size) return;
      save();
      for (const [w, ls] of hits) alert(w, ls.sort((a, b) => a.asking_price - b.asking_price));
      changed();
    }
    function alert(w, ls) {
      const best = ls[0];
      const title = ls.length === 1 ? 'Module Exchange: ' + moduleName(best.module) + ' for ' + usd(best.asking_price)
        : 'Module Exchange: ' + ls.length + ' new listings match "' + w.q + '"';
      const body = ls.length === 1 ? 'matches "' + w.q + '"' : 'cheapest: ' + moduleName(best.module) + ' for ' + usd(best.asking_price);
      core.notify(TAG, title, body);
      if (!core.realHidden()) core.toast(title + ' (' + body + ')', 'success');
      const st = stats.get(w.id) ?? {};
      stats.set(w.id, { ...st, alerts: (st.alerts ?? 0) + ls.length });
      if (!onExchangePage()) { pending += ls.length; core.setBadge(TAG, pending + ' module listing' + (pending === 1 ? '' : 's')); }
    }

    function status() {
      const c = cur && watches.find((w) => w.id === cur.id);
      const on = watches.filter((w) => w.on).length;
      return {
        owner, watching: c ? c.q : null, on, watches: list(), pending,
        alerts: core.notifyPerm(),
        note: owner === 'page' ? 'The Module Exchange page is open: matching what it shows'
          : owner === 'watch' ? 'Checking ' + (on > 1 ? 'one watch at a time, ' + ROTATE_MS / 1000 + ' s each' : 'the watch')
            : on ? 'Waiting for the game connection' : 'No watch is on',
      };
    }

    // ---- the page: a "Watch" button in the Module Exchange heading and the watch list under it ---------------------------
    const CSS = '.mw-btn{display:inline-flex;align-items:center;gap:6px}.mw-btn svg{flex:none}' +
      '.mw-btn .mw-count{font-size:11px;min-width:16px;padding:0 4px;border-radius:8px;background:var(--surface-3,#27272a);color:var(--ink-2,#b6b6ba);text-align:center}' +
      '.mw-box{margin:0 0 12px;padding:10px 12px;border:1px solid var(--border,rgba(255,255,255,.12));border-radius:8px;background:var(--surface-2,rgba(255,255,255,.03));font-size:12px}' +
      '.mw-row{display:flex;align-items:center;gap:8px;padding:4px 0}.mw-row code{flex:1;font:inherit;color:var(--ink,#e4e4e7);overflow-wrap:anywhere}' +
      '.mw-row .mw-meta{color:var(--muted,#808086);white-space:nowrap}.mw-row.off code{color:var(--muted,#808086)}' +
      '.mw-add{display:flex;gap:8px;margin-top:8px}.mw-add input{flex:1;min-width:0}' +
      '.mw-hint{margin-top:6px;color:var(--muted,#808086);line-height:1.4}.mw-hint.warn{color:var(--status-warn,#f2a93b)}';
    const BELL = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3L4 11zM6.5 14a1.5 1.5 0 0 0 3 0"/></svg>';
    let styleEl = null, domOff = null, open = false, mounted = false, unloaded = false, lastSig = '', msg = { text: '', warn: false };
    let btn = null, box = null, listEl = null, input = null, hintEl = null, permEl = null;

    function exchangePanel() {
      for (const hd of document.querySelectorAll('section.panel > .panel-head')) if (hd.querySelector(':scope > h2')?.textContent.trim() === 'Module Exchange') return hd.parentElement;
      return null;
    }
    function build() {
      btn = h('button', { type: 'button', class: 'mw-btn', 'data-mw': 'btn', title: 'Alert me when a module matching a saved filter is listed', 'aria-expanded': 'false', onclick: () => { open = !open; lastSig = ''; inject(); if (open) input.focus(); } });
      btn.innerHTML = BELL;
      btn.append(h('span', {}, 'Watch'), h('span', { class: 'mw-count' }, '0'));
      input = h('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: 'e.g. overclock mythic price <= 500', 'aria-label': 'New watch filter', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addFromInput(); } } });
      listEl = h('div', { role: 'list', 'aria-label': 'Watches' });
      hintEl = h('div', { class: 'mw-hint', 'aria-live': 'polite' });
      permEl = h('div', { class: 'mw-hint' });
      box = h('div', { class: 'mw-box', 'data-mw': 'box' }, listEl, h('div', { class: 'mw-add' }, input, h('button', { type: 'button', onclick: addFromInput }, 'Add watch')), hintEl, permEl);
    }
    function addFromInput() {
      try { add(input.value); input.value = ''; msg = { text: '', warn: false }; }
      catch (e) { msg = { text: e.message, warn: true }; }
      lastSig = ''; inject();
    }
    function renderBox() {
      const sig = JSON.stringify([list(), status().note, msg, core.notifyPerm()]);
      if (sig === lastSig) return;
      lastSig = sig;
      const rows = watches.map((w) => {
        const st = stats.get(w.id) ?? {};
        const cb = h('input', { type: 'checkbox', checked: w.on, 'aria-label': 'Watch on: ' + w.q, onchange: (e) => toggle(w.id, e.target.checked) });
        const meta = (st.alerts ? st.alerts + ' alerted' : '') + (st.truncated ? (st.alerts ? ' · ' : '') + 'server sent part of the matches: narrow it' : '');
        return h('div', { class: 'mw-row' + (w.on ? '' : ' off'), role: 'listitem' }, cb, h('code', {}, w.q), h('span', { class: 'mw-meta' }, meta),
          h('button', { type: 'button', 'aria-label': 'Remove watch ' + w.q, title: 'Remove', onclick: () => remove(w.id) }, '×'));
      });
      listEl.replaceChildren(...(rows.length ? rows : [h('div', { class: 'mw-hint' }, 'No watches yet. Words: overclock, refiner, fine … mythic, twinned >= 10, quirks >= 3, price <= 500.')]));
      hintEl.textContent = msg.text || status().note;
      hintEl.className = 'mw-hint' + (msg.warn ? ' warn' : '');
      const perm = core.notifyPerm();
      permEl.replaceChildren(...(perm === 'default'
        ? ['Alerts show here while the tab is visible. ', h('button', { type: 'button', onclick: async () => { await core.askNotify(); lastSig = ''; inject(); } }, 'Allow desktop alerts'), ' for when it is hidden.']
        : [perm === 'granted' ? 'Desktop alerts are on while the tab is hidden.' : perm === 'denied' ? 'Desktop alerts are blocked in this browser: alerts show only while the tab is visible.' : '']));
    }
    function inject() {
      if (!HAS_DOM || unloaded || !mounted) return;
      const panel = onExchangePage() ? exchangePanel() : null;
      if (!panel) { btn?.remove(); box?.remove(); return; }
      if (!btn) build();
      const head = panel.querySelector(':scope > .panel-head'), spacer = head.querySelector(':scope > .spacer');
      if (btn.parentElement !== head) (spacer ?? head.lastElementChild).after(btn);
      const count = String(watches.filter((w) => w.on).length);
      if (btn.lastChild.textContent !== count) btn.lastChild.textContent = count;
      btn.setAttribute('aria-expanded', String(open));
      if (!open) { box.remove(); return; }
      if (box.previousElementSibling !== head) head.after(box);
      renderBox();
    }
    const changed = () => { lastSig = ''; if (mounted) inject(); };
    function mountUi() {
      mounted = true;
      styleEl = h('style', { id: 'mw-style' }, CSS);
      document.head.append(styleEl);
      domOff = core.ui.onDom(inject);
      inject();
    }

    // ---- load --------------------------------------------------------------------------------------------------------------
    restore();
    const frameOff = core.onFrame(onFrame);
    const stopTick = core.every(TICK_MS, tick);
    W.moduleWatch = {
      add, remove, toggle, list, status,
      exportCfg: () => ({ watches: watches.map(({ q, on }) => ({ q, on })) }),
      importCfg(o) {
        const applied = [], skipped = [];
        if (!Array.isArray(o?.watches)) return { applied, skipped: ['watches'] };
        for (const w of o.watches) {
          const have = watches.find((x) => x.q.toLowerCase() === String(w?.q ?? '').trim().toLowerCase());
          try { if (have) toggle(have.id, w.on !== false); else { const n = add(w.q); if (w.on === false) toggle(n.id, false); } applied.push(String(w.q)); }
          catch { skipped.push(String(w?.q)); }
        }
        return { applied, skipped };
      },
      kinds: KINDS, name: moduleName,   // shared with Auto modules
      _parse: parse, _matches: matches, _serverFilter: serverFilter, _tick: tick, _name: moduleName,
      _unload() {
        unloaded = true;
        stopTick(); frameOff();
        const rec = core.sock?.boards?.[BOARD];
        if (rec?.ours && rec.filter) core.sendBoardFilter(BOARD, null);
        core.setBadge(TAG, null);
        domOff?.(); styleEl?.remove(); btn?.remove(); box?.remove();
      },
    };
    if (HAS_DOM) (async () => {
      while (!document.querySelector('.primary-navigation')) { if (unloaded) return; await core.sleep(500); }
      if (unloaded) return;
      mountUi();
    })();
    console.log('[moduleWatch] ready: ' + watches.filter((w) => w.on).length + ' watch(es) on. "Watch" button on the Module Exchange page, or moduleWatch.add("overclock mythic price <= 500")');
  })();
} catch (e) { console.error('[IdleCorp] module watch failed to load:', e); }
// @@END module-watch
