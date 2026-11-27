// ============================================================================
// 3. LAB RUNNER
// ============================================================================
// Keeps every Manufacturing Lab busy: whenever a region's Lab slot is free it starts a research
// project (StartResearch), and it claims finished results (ClaimResearch). Open "Lab" in the game's
// sidebar (or click the Lab chip in the top bar). Settings there map to cfg below; the console API
// also works:
//   labRunner.start()                          // live: sends the research commands
//   labRunner.start({ dryRun: true })          // dry run: logs "would send ...", sends nothing
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
// when that region's Lab slot is free. dryRun is off by default and is never remembered or imported: a reload starts Live again
// (keepLive, on by default). Dry run is for checking: start({ dryRun: true }).
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
      tierMode: 'best',      // 'best' (Tier I; a higher tier only out of surplus MD, see richOk) | 1 | 2 | 3 (that tier only: waits, never falls back)
      mdReserve: 5000,       // MD never spent below this
      autoClaim: true,       // claim finished results
      keepLive: true,       // a Live run that was still running when the page reloaded starts Live again (off: it stays stopped)
      dryRun: false,         // log "would send ..." instead of sending (session-only: never remembered or imported)
      list: [],              // [{ product, focus: 0 | 1 | 2, tier: 'default' | 1 | 2 | 3 }], cycled in order (a Tier II / III entry short of RD / Catalyst runs at Tier I)
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
      keepLive: (v) => typeof v === 'boolean',
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
    try { saved = JSON.parse(store?.getItem(KEY) || '{}') ?? {}; } catch { }
    for (const [k, v] of Object.entries(saved.cfg || {})) if (k in cfg && !SESSION_ONLY.includes(k) && VALID[k]?.(v)) cfg[k] = take(k, v);
    // counts: projects started per product (what the Process / Modules pick rotates on); next: the next custom-list entry.
    const mem = { counts: {}, next: 0 };
    for (const [k, v] of Object.entries(saved.mem?.counts || {})) if (Number.isInteger(+k) && isNum(v) && v > 0) mem.counts[k] = v;
    if (Number.isInteger(saved.mem?.next) && saved.mem.next >= 0) mem.next = saved.mem.next;

    let unloaded = false;
    function save() {
      if (unloaded) return;
      // live: a Live run is going (cleared when it stops; a reload does not stop it), for cfg.keepLive.
      try { store?.setItem(KEY, JSON.stringify({ cfg: persistable(), mem, live: running && !cfg.dryRun })); } catch { }
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

    // Items the unpaused groups make now (output of each group's current recipe) that the Lab accepts, with what that output is
    // worth per tick at base value (cents): item -> value.
    function produced(st, ix) {
      const out = new Map();
      for (const g of Object.values(st.groups ?? {})) {
        if (g.recipe == null || !(g.count > 0) || g.paused) continue;
        const rc = ix.recipes.get(g.recipe);
        for (const o of rc?.outputs ?? []) {
          if (ix.products.has(o.item)) out.set(o.item, (out.get(o.item) ?? 0) + (ix.products.get(o.item).base_value || 0) * (o.amount || 0) * g.count / Math.max(1, rc.ticks || 1));
        }
      }
      return out;
    }
    // Project hours for a product: clamp(4 x its fastest input-using recipe, 1 h, 12 h) (wiki research.md, Duration).
    function projectHours(ix, id) {
      let t = Infinity;
      for (const r of ix.recipes.values()) if (r.inputs?.length && (r.outputs ?? []).some((o) => o.item === id) && r.ticks > 0) t = Math.min(t, r.ticks);
      return Math.min(12, Math.max(1, Number.isFinite(t) ? 4 * t / 7200 : 1));
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
      const made = produced(st, ix), pool = [...made.keys()];
      if (!pool.length) {
        // Module fabrication doesn't care which product; Process study needs one the corp actually makes.
        const top = focus === 1 ? [...ix.products.values()].sort((a, b) => b.base_value - a.base_value || a.id - b.id)[0] : null;
        return top ? { product: top.id, focus, tier: 'default' } : { wait: 'no produced product qualifies' };
      }
      // The most output value the corp makes per project hour; each project already started on a product divides its score
      // (1 / (1 + started)), so the pick still rotates instead of studying one product forever.
      const score = (id) => (made.get(id) || 0) / projectHours(ix, id) / (1 + (counts[id] ?? 0));
      pool.sort((a, b) => score(b) - score(a) || a - b);
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
    // 'best' tier: success per MD is 0.09% for Tier I, 0.007% for II, 0.0005% for III (90/1,000, 70/10,000, 50/100,000), so Tier I
    // gives the most results per MD. A higher tier (rarer results) is taken only when the MD left above the reserve after paying is at
    // least RICH x its cost, and it can pay its RD / Catalyst (the Catalyst has no other use).
    const RICH = 10;
    const richOk = (t, have, region, reserve) => t === 0 || (!shortfall(t, have, region, reserve) && have.md - TIERS[t].md >= reserve + RICH * TIERS[t].md);

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
        actions.push({
          kind: 'claim', key: 'claim:' + p.tick, tick: p.tick, label, reward,
          msg: { type: 'ClaimResearch', tick: p.tick }, reason: 'claim ' + label + (reward ? ' (' + reward + ')' : '')
        });
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
        const best = setting === 'best' || !TIERS[setting - 1];
        const ladder = best ? [2, 1, 0] : [setting - 1];
        let tier = ladder.find((t) => !shortfall(t, have, r, c.mdReserve) && (!best || richOk(t, have, r, c.mdReserve)));
        // a list entry at Tier II / III that lacks its Research Data or Catalyst runs at Tier I instead of holding the Lab idle (MD short: it waits)
        const k0 = TIERS[ladder[0]];
        if (tier === undefined && !best && p.index != null && ladder[0] > 0 && ((k0.rd && have.rd < k0.rd) || (k0.cat && have.cat < k0.cat)) && !shortfall(0, have, r, c.mdReserve)) tier = 0;
        if (tier === undefined) { row.wait = shortfall(ladder[ladder.length - 1], have, r, c.mdReserve); continue; }
        const k = TIERS[tier], pct = successPct(tier, p.focus, bonus);
        const label = `${pname(ix, p.product)} · ${focusName(p.focus)} · Tier ${k.name}`;
        const a = {
          kind: 'start', key: 'start:' + r, region: r, regionName: row.name, product: p.product, focus: p.focus, tier, index: p.index, pct, label,
          msg: { type: 'StartResearch', product: p.product, context: p.focus, tier, region: r },
          reason: `start ${label} in ${row.name} (${pct}% success)`
        };
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

