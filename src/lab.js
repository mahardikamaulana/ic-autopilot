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

