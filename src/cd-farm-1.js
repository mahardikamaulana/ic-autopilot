// ============================================================================
// 1. CD FARM
// ============================================================================
// Open "CD Farm" in the game's sidebar (or click the CD chip in the top bar).
// Settings there map to cfg below; the console API also works:
//   cdFarm.start({ budget: 'floor', minMoney: 100000, fullBatch: true, targetCd: 20000 })
//   cdFarm.stop() / cdFarm.resume() / cdFarm.status() / cdFarm.reset()
//
// Each Lumber Camp or Farm (Settings > Building, or start({ building: 10 })) earns 1 CD on build;
// CD is kept after demolish. Both cost $41 base, refund 50% of base ($20.50) and need 1 free acre.
// The i-th one costs base x (20 + owned + i) / 20, where owned counts every building of that type you hold or have queued
// (a queued demolition still counts until it finishes), so pick the type you own fewer of. The demolish queue takes one
// building at a time (10 s per Lumber Camp), so camps and farms top out near 6 CD a minute; frame buildings are rushed when
// the queue is full (the wiki's CD farm section has the numbers).
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
    cdStart: 0, moneyStart: 0, startedAt: 0, baselinePool: 0, rushCd: 0,
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
    const { ws, st, catalog } = core.walk(fresh);
    if (!st || !catalog) return null;
    const C = PL().normalize(catalog);
    const regionPool = st.building_pool?.[REGION] ?? {};
    const unassignedCamps = regionPool[farmId()] ?? 0;
    // Queued builds and demolitions count in the price and hold acres: a queued demolition keeps its acre until it finishes.
    const q = PL().queued({ st, catalog, region: REGION });

    let campsInGroups = 0, acresUsed = q.acres;
    for (const g of Object.values(st.groups)) {
      if ((g.region ?? REGION) !== REGION) continue;
      if (g.building === farmId()) campsInGroups += g.count;
      acresUsed += C.buildings[g.building].acres * g.count;
    }
    for (const [b, n] of Object.entries(regionPool)) acresUsed += C.buildings[b].acres * n;

    const acresOwned = STARTER_ACRES + (st.land_bought?.[REGION] ?? 0);
    const money = (st.items?.[MONEY] ?? 0) / 100;
    const ownedCamps = campsInGroups + unassignedCamps + (q.owned[farmId()] ?? 0);
    const freeAcres = Math.max(0, acresOwned - acresUsed);
    const usableAcres = Math.max(0, freeAcres - cfg.reserveAcres);
    // 'income' keeps the money you have at Start; with no run on, that is the money now (stats.moneyStart is from the last run).
    const floor = cfg.budget === 'income' && !(running || active || resumable) ? Math.max(cfg.minMoney, money) : moneyFloor();

    let affordable = 0;
    while (affordable < cfg.batch && money - campCost(ownedCamps, affordable + 1) >= floor) affordable++;
    const nextBatch = Math.min(cfg.batch, usableAcres, affordable);
    const sec = PL().secsOf(C, farmId());

    return {
      money, cd: st.items?.[CD] ?? 0,
      unassignedCamps, campsInGroups, ownedCamps,
      acresOwned, acresUsed, freeAcres, usableAcres, moneyFloor: floor,
      nextBatch, nextBatchCost: campCost(ownedCamps, nextBatch),
      buildSec: sec.build, demolishSec: sec.demolish, queue: { build: q.build, demolish: q.demolish }, acresComing: q.demolishAcres,
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
  async function waitConfirm(pred, d0, rd = read, timeoutMs = cfg.timeoutMs) {
    const r = await core.waitConfirm({ read: rd, pred, d0, timeoutMs, closed: () => { throw new ConnError('socket closed while waiting'); } });
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

