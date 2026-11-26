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

    const MONEY = 0;         // items[0], cents
    const CD = 24;           // items[24], Construction Data
    // Buildings the farm can cycle: money only (no build items), 1 acre and 1 CD each, same price curve. Id and base price are
    // read from the catalog by name (syncIds); these numbers are the fallback.
    const BUILDINGS = [
      { id: 0, name: 'Lumber Camp', plural: 'camps', base: 41 },
      { id: 10, name: 'Farm', plural: 'farms', base: 41 },
    ];
    const isBuilding = (v) => v === 'auto' || v === 'cheapest' || BUILDINGS.some((b) => b.id === v);
    let RETAIL = 38;   // Retail Store (by name from the catalog; this id is the fallback)
    const RATE_WINDOW_MS = 15 * 60 * 1000;


    const cfg = {
      building: 'auto',      // 'auto': the planner picks types and batch every cycle; 'cheapest': Lumber Camp or Farm, whichever costs less at start; or an id: 0 Lumber Camp, 10 Farm
      region: 'auto',        // 'auto': the region you hold with the most free acres (Heartland on a tie); or 0 Heartland, 1 Industrial Basin, 2 Coastal Cities, 3 Frontier
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
      autoResume: true,     // resume an interrupted run automatically when the script loads
      pace: 'balanced',      // Auto: 'thrifty' | 'balanced' | 'fast' (how much waiting for CD costs)
      land: 'plan',          // Auto: 'off' | 'plan' (acres only inside Autopilot's own land plan) | max $ per acre
      autoStart: true,       // Auto: start by itself when the engine needs CD (switched off when you press Stop)
      solo: false,           // Auto: with Autopilot and Core plan off and no Target CD, farm for the cheapest tech that can start next
      autoFloor: 0,          // Auto: money floor ($) on top of Autopilot's power-bill floor
      maxTypes: 2,           // Auto: building types per cycle (each adds a Buy and a Demolish round trip)
      cmdsPerMin: 20,        // command budget per rolling minute (shared pacer)
      dryRun: false,         // Auto: log what it would build, send nothing
      timeoutMs: 8000,       // max wait for the server to confirm a step
      reconnectMs: 60000,    // max wait for the socket to come back
      maxReconnects: 3,      // consecutive reconnects before giving up
    };

    const DEFAULTS = { ...cfg };

    class ConnError extends Error { }

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
    const farmId = () => { const b = runBuilding(); return typeof b === 'number' ? b : b === 'cheapest' ? cheaperId() : BUILDINGS[0].id; };   // Auto: the shared read() just looks at Lumber Camps
    // Lumber Camp or Farm, whichever is cheaper now: the price is base x (20 + owned) / 20, owned counting every region and both queues.
    function cheaperId() {
      const { st, catalog } = core.walk();
      if (!st || !catalog) return BUILDINGS[0].id;
      const own = PL().ownedAll({ st, catalog });
      return [...BUILDINGS].sort((a, b) => a.base * (20 + (own[a.id] ?? 0)) - b.base * (20 + (own[b.id] ?? 0)))[0].id;
    }
    // The region a run uses is fixed when it starts (stats.region; a run saved before regions existed was in Heartland), so cleanup
    // never looks at another region's pool. With no run on, it is cfg.region ('auto': PL().pickRegion).
    function region(st, catalog) {
      if (running || active || resumable) return stats.region ?? 0;
      if (!st) ({ st, catalog } = core.walk());
      return st && catalog ? PL().pickRegion({ st, catalog, choice: cfg.region }) : 0;
    }
    const pickRegionNow = () => { const { st, catalog } = core.walk(true); return st && catalog ? PL().pickRegion({ st, catalog, choice: cfg.region }) : 0; };
    // Ids by name from the catalog (once per catalog), with the numbers above as the fallback.
    const synced = new WeakSet();
    function syncIds(catalog) {
      if (synced.has(catalog)) return;
      synced.add(catalog);
      const byName = (n) => (catalog.buildings ?? []).find((b) => b.name === n);
      for (const b of BUILDINGS) { const x = byName(b.name); if (x) { b.id = x.id; b.base = x.cost / 100; } }
      RETAIL = byName('Retail Store')?.id ?? RETAIL;
    }
    const isAuto = () => runBuilding() === 'auto';
    const bld = () => BUILDINGS.find((b) => b.id === farmId()) ?? BUILDINGS[0];
    const unitRefund = () => bld().base / 2; // demolish refunds 50% of base ($)

    // ---- persistence (#5) --------------------------------------------------

    const replacer = (_k, v) => (v === Infinity ? 'Infinity' : v);
    const reviver = (_k, v) => (v === 'Infinity' ? Infinity : v);

    function save() {
      if (unloaded) return;
      try { localStorage.setItem(KEY, JSON.stringify({ cfg, stats, running, inFlight, stopReason, restoreCfg, quarantine, measure: core.measure?.save() }, replacer)); } catch { }
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
      const base = bld().base;
      for (let i = 0; i < n; i++) c += base * (20 + owned + i) / 20;
      return c;
    }

    // stats.scaleFloor: the run started on the default floor (nobody set one), so it is capped by the cash at start (PL().manualFloor).
    const baseFloor = (scale, moneyStart) => PL().manualFloor({ minMoney: cfg.minMoney, isDefault: scale, moneyStart });
    const moneyFloor = () => { const f = baseFloor(!!stats.scaleFloor, stats.moneyStart); return cfg.budget === 'income' ? Math.max(f, stats.moneyStart) : f; };

    // Live snapshot. Every decision in the script goes through this.
    function read(fresh = false) {
      const { ws, st, catalog } = core.walk(fresh);
      if (!st || !catalog) return null;
      syncIds(catalog);
      const R = region(st, catalog);
      const id = farmId();
      const unassignedCamps = st.building_pool?.[R]?.[id] ?? 0;
      // Queued builds and demolitions count in the price and hold acres: a queued demolition keeps its acre until it finishes.
      const q = PL().queued({ st, catalog, region: R });
      const ra = PL().regionAcres({ st, catalog, region: R });
      let campsInGroups = 0;
      for (const g of Object.values(st.groups)) if (g.building === id) campsInGroups += g.count;   // every region: the price counts them all

      const acresOwned = ra.owned, acresUsed = ra.used, freeAcres = ra.free;
      const money = (st.items?.[MONEY] ?? 0) / 100;
      const ownedCamps = PL().ownedAll({ st, catalog })[id] ?? 0;
      const usableAcres = Math.max(0, freeAcres - cfg.reserveAcres);
      // With no run on, the floor is what a run started now would use ('income' keeps the money you have at Start).
      const f0 = baseFloor(cfg.minMoney === DEFAULTS.minMoney, money);
      const floor = !(running || active || resumable) ? (cfg.budget === 'income' ? Math.max(f0, money) : f0) : moneyFloor();

      let affordable = 0;
      while (affordable < cfg.batch && money - campCost(ownedCamps, affordable + 1) >= floor) affordable++;
      const nextBatch = Math.min(cfg.batch, usableAcres, affordable);
      const sec = PL().secsOf(catalog, id);

      return {
        money, cd: st.items?.[CD] ?? 0, region: R,
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
      const r0 = mustRead(true);
      inFlight = { action: 'demolish', amount: n, at: Date.now() }; save();
      const d = send({ type: 'DemolishBuilding', building: farmId(), amount: n, region: region() });
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

