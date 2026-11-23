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

