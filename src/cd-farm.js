// ============================================================================
// 1. CD FARM
// ============================================================================
// Open "CD Farm" in the game's sidebar (or click the CD chip in the top bar).
// Settings there map to cfg below; the console API also works:
//   cdFarm.start({ budget: 'floor', minMoney: 100000, fullBatch: true, targetCd: 20000 })
//   cdFarm.stop() / cdFarm.resume() / cdFarm.status() / cdFarm.reset()
//
// Each Lumber Camp earns 1 CD on build; CD is kept after demolish.
// Demolish refunds 50% of base ($20.50). Each camp needs 1 free acre.
// While running, any unassigned Lumber Camps above the count at start are
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

  const BUILDING = 0;      // Lumber Camp
  const REGION = 0;        // Heartland
  const MONEY = 0;         // items[0], cents
  const CD = 24;           // items[24], Construction Data
  const BASE = 41;         // Lumber Camp base cost ($)
  const REFUND = BASE / 2; // demolish refund per camp ($)
  const STARTER_ACRES = 25;
  const RATE_WINDOW_MS = 15 * 60 * 1000;

  // Acres per building id (wiki/data/buildings.md).
  const ACRES = [1, 2, 2, 3, 1, 2, 2, 6, 2, 5, 1, 1, 2, 4, 2, 3, 1, 5, 1, 3, 8, 1, 2, 2, 3, 1, 1, 1, 6, 1, 2, 1, 1, 1, 3, 1, 1, 2, 3];

  const cfg = {
    batch: 10,             // max camps per cycle
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
    delayMs: 400,          // pause between steps
    jitterMinMs: 150,      // random extra wait before each command (min)
    jitterMaxMs: 900,      // random extra wait before each command (max)
    timeoutMs: 8000,       // max wait for the server to confirm a step
    reconnectMs: 60000,    // max wait for the socket to come back
    maxReconnects: 3,      // consecutive reconnects before giving up
  };

  const DEFAULTS = { ...cfg };

  class ConnError extends Error {}

  const freshStats = () => ({
    cycles: 0, built: 0, spent: 0, refunded: 0,
    cdStart: 0, moneyStart: 0, startedAt: 0, baselinePool: 0,
    samples: [], spends: [], last: '', by: '',
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

  // ---- persistence (#5) --------------------------------------------------

  const replacer = (_k, v) => (v === Infinity ? 'Infinity' : v);
  const reviver = (_k, v) => (v === 'Infinity' ? Infinity : v);

  function save() {
    if (unloaded) return;
    try { localStorage.setItem(KEY, JSON.stringify({ cfg, stats, running, inFlight, stopReason, restoreCfg }, replacer)); } catch {}
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
    for (let i = 0; i < n; i++) c += BASE * (20 + owned + i) / 20;
    return c;
  }

  const moneyFloor = () => (cfg.budget === 'income' ? Math.max(cfg.minMoney, stats.moneyStart) : cfg.minMoney);

  // Live snapshot. Every decision in the script goes through this.
  function read(fresh = false) {
    const { ws, st } = core.walk(fresh);
    if (!st) return null;
    const regionPool = st.building_pool?.[REGION] ?? {};
    const unassignedCamps = regionPool[BUILDING] ?? 0;

    let campsInGroups = 0, acresUsed = 0;
    for (const g of Object.values(st.groups)) {
      if ((g.region ?? REGION) !== REGION) continue;
      if (g.building === BUILDING) campsInGroups += g.count;
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

  // Random wait in [jitterMinMs, jitterMaxMs] before sending a command.
  function jitter() {
    const lo = Math.max(0, cfg.jitterMinMs || 0);
    const hi = Math.max(lo, cfg.jitterMaxMs || 0);
    return sleep(lo + Math.random() * (hi - lo));
  }

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
  function waitConfirm(pred, d0) {
    return core.waitConfirm({ read, pred, d0, timeoutMs: cfg.timeoutMs, closed: () => { throw new ConnError('socket closed while waiting'); } });
  }

  // Returns the observed money change (includes passive income during the wait).
  async function demolish(n, { count = true } = {}) {
    await jitter();
    const r0 = mustRead();
    inFlight = { action: 'demolish', amount: n, at: Date.now() }; save();
    const d = send({ type: 'DemolishBuilding', building: BUILDING, amount: n, region: REGION });
    const r1 = await waitConfirm((r) => r.unassignedCamps <= r0.unassignedCamps - n, d);
    if (!r1) throw new Error(`demolish of ${n} not confirmed`);
    if (count) stats.refunded += n * REFUND;
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
    const r = read();
    if (!r) return;
    const extra = r.unassignedCamps - stats.baselinePool;
    if (extra > 0) {
      if (pending?.action === 'build') {
        const n = Math.min(extra, pending.amount);
        stats.built += n;
        stats.spent += campCost(r.ownedCamps - n, n);
      }
      console.log(`[cdFarm] cleanup: demolishing ${extra} leftover farm camps`);
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
    const netCost = cost - n * REFUND;
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
    const d = send({ type: 'BuyBuilding', building: BUILDING, amount: n, region: REGION });
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
    await sleep(cfg.delayMs);

    // Demolish
    phase = 'demolishing';
    const refund = await demolish(n);
    if (Math.abs(refund - n * REFUND) > Math.max(5, n * REFUND * 0.2)) {
      console.warn(`[cdFarm] money rose $${fmt(refund)}, expected ~$${fmt(n * REFUND)} refund`);
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
    await sleep(cfg.delayMs);
    return 'ok';
  }

  async function runLoop() {
    let reconnects = 0;
    while (running && stats.cycles < cfg.cycles) {
      try {
        const res = await cycle();
        if (res === 'stop') break;
        if (res === 'wait') { save(); await sleep(3000); continue; }
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
    // runOnly: these settings are for this run only; yours come back when it stops.
    if (runOnly && !restoreCfg) restoreCfg = { ...cfg };
    // cycles and maxSpend apply to one run only; other settings are remembered.
    if (!resume) { cfg.cycles = Infinity; cfg.maxSpend = Infinity; }
    Object.assign(cfg, rest);

    active = true;
    running = true; stopReason = '';
    phase = window.earlyGame?.hold ? 'waiting for Autopilot to finish its step' : (resume ? 'resuming' : 'running');
    try {
      // Autopilot must not send anything between our baseline and the end of the run
      // (a camp it builds would look like ours). hold() resolves once its current step is done.
      if (window.earlyGame?.hold) { await window.earlyGame.hold('CD Farm'); r = mustRead(); }
      if (!running) throw new Error(STOPPED_EARLY);
      phase = resume ? 'resuming' : 'running';
      if (!resume) {
        if (resumable) {
          // Clean up the interrupted run's camps (with its own baseline) before starting fresh.
          await reconcile();
          r = mustRead();
        }
        stats = freshStats();
        Object.assign(stats, { cdStart: r.cd, moneyStart: r.money, startedAt: Date.now(), baselinePool: r.unassignedCamps, by: by || '' });
        sample();
      }
      resumable = false;
      save(); render();

      if (resume) {
        await reconcile();
        console.log(`[cdFarm] resumed after ${stats.cycles} cycles`);
      } else if (r.unassignedCamps > 0) {
        if (cfg.existingPool === 'demolish') {
          const got = await demolish(r.unassignedCamps, { count: false });
          stats.baselinePool = 0;
          console.log(`[cdFarm] demolished ${r.unassignedCamps} existing unassigned camps (+$${fmt(got)})`);
        } else {
          console.log(`[cdFarm] keeping ${r.unassignedCamps} existing unassigned camps (start({ existingPool: 'demolish' }) to clear them)`);
        }
      }
      const r1 = mustRead();
      console.log(`[cdFarm] start | CD ${fmt(r1.cd)} | $${fmt(r1.money)} | floor $${fmt(r1.moneyFloor)} | free acres ${r1.freeAcres} | next batch ${r1.nextBatch}`);
      phase = 'running';
      await runLoop();
      if (!stopReason) stopReason = running ? `finished ${stats.cycles} cycles` : 'stopped by user';
    } catch (e) {
      stopReason = e.message === STOPPED_EARLY ? 'stopped by user' : 'error: ' + e.message;
    } finally {
      running = false;
      active = false;
      phase = 'idle';
      if (restoreCfg) { Object.assign(cfg, restoreCfg); restoreCfg = null; }
      window.earlyGame?.release?.('CD Farm');
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
    if (running) console.log('[cdFarm] stopping after current step');
    running = false;
    save();
  }

  function reset() {
    if (running || active) return console.warn('[cdFarm] stop the run (and let it finish its step) before reset()');
    try { localStorage.removeItem(KEY); } catch {}
    stats = freshStats(); resumable = false; stopReason = ''; inFlight = null;
    if (restoreCfg) { Object.assign(cfg, restoreCfg); restoreCfg = null; }
    save(); render();
  }

  // ---- rates (#7) --------------------------------------------------------

  function sample() {
    const now = Date.now();
    stats.samples.push({ t: now, cycles: stats.cycles, built: stats.built, net: netSpend() });
    stats.samples = stats.samples.filter((s) => now - s.t <= RATE_WINDOW_MS);
  }

  // Uses camps built (not the CD balance) so research spending doesn't skew it.
  // Rates stay hidden until MIN_RATE_CYCLES cycles are in, since one fast cycle
  // extrapolates to absurd hourly figures.
  const MIN_RATE_CYCLES = 3;
  function rates(r = read()) {
    const now = Date.now();
    const s = stats.samples.filter((x) => now - x.t <= RATE_WINDOW_MS);
    let cdh15 = null, spendh15 = null;
    if (s.length >= 2) {
      const a = s[0], b = s[s.length - 1];
      const h = (b.t - a.t) / 3.6e6;
      if (h > 0 && b.cycles - a.cycles >= MIN_RATE_CYCLES) {
        cdh15 = (b.built - a.built) / h;
        spendh15 = (b.net - a.net) / h;
      }
    }
    const hAll = stats.startedAt ? (now - stats.startedAt) / 3.6e6 : 0;
    const cdhAll = hAll > 0 && stats.cycles >= MIN_RATE_CYCLES ? stats.built / hAll : null;
    const target = Number.isFinite(cfg.targetCd) ? cfg.targetCd : 20000;
    const rate = cdh15 ?? cdhAll;

    // In reserve mode, cash above the floor caps how much CD the farm can buy.
    let reachableCd = null, capped = false;
    if (r) {
      const perCd = (campCost(r.ownedCamps, cfg.batch) - cfg.batch * REFUND) / cfg.batch;
      reachableCd = r.cd + Math.max(0, Math.floor((r.money - r.moneyFloor) / perCd));
      capped = cfg.budget === 'reserve' && reachableCd < target;
    }
    const goal = capped ? reachableCd : target;
    const etaH = r && rate > 0 ? Math.max(0, goal - r.cd) / rate : null;
    return { cdh15, spendh15, cdhAll, target, etaH, reachableCd, capped };
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
      'Unassigned camps': `${r.unassignedCamps} (baseline ${stats.baselinePool})`,
      'Camps in groups': r.campsInGroups,
      Acres: `${r.acresUsed} / ${r.acresOwned} (${r.freeAcres} free)`,
      'Next batch': `${r.nextBatch} camps, $${fmt(r.nextBatchCost)}`,
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

  let P = null, chrome = null, timer = null, discardUntil = 0;
  const refs = {};

  // 'run' | 'wait' | 'err' | '' for the status dot.
  function tone() {
    if (running) return /waiting|reconnect/.test(phase) ? 'wait' : 'run';
    if (resumable || /^error/.test(stopReason)) return 'err';
    return '';
  }
  const stateText = () => (running ? phase + (stats.by ? ` · ${stats.by}` : '') : resumable ? 'Interrupted — resume available' : (stopReason || 'Idle'));
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
    targetCd: { kind: 'count', label: 'Target CD', optional: true, empty: 'No target' },
    batch: { kind: 'count', label: 'Camps per cycle', min: 1, max: 100 },
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
  const netPerCd = (r) => (campCost(r.ownedCamps, cfg.batch) - cfg.batch * REFUND) / cfg.batch;

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
    const camps = cfg.fullBatch ? `exactly ${cfg.batch}` : `up to ${cfg.batch}`;
    const parts = [cfg.budget === 'income'
      ? `Builds ${camps} camps at a time from new income only, keeping $${fmt(floor)}.`
      : `Builds ${camps} camps at a time while money is above $${fmt(floor)}.`];
    if (cfg.budget === 'reserve') parts.push(`Stops at the floor, about ${fmt(Math.max(0, Math.floor((r.money - floor) / per)))} CD from current cash.`);
    else parts.push('At the floor it waits for income.');
    if (Number.isFinite(cfg.targetCd) && cfg.targetCd > r.cd) {
      const left = cfg.targetCd - r.cd;
      parts.push(`Stops at ${fmt(cfg.targetCd)} CD: ${fmt(left)} more, about $${short(left * per)} net.`);
    } else if (!Number.isFinite(cfg.targetCd)) parts.push('No target: runs until you stop it.');
    return parts.join(' ');
  }

  function onMain() {
    if (running) return stop();
    if (resumable) return resume();
    if (Date.now() < confirmUntil) { confirmUntil = 0; return start(); }
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
    refs.fieldEl.budget = fieldBox('Budget', refs.seg.el, refs.modeDesc);
    refs.fieldEl.minMoney = fieldBox('Money floor', floor.box, h('div', { class: 'idc-quicks' }, ...refs.floorChips.map(([, b]) => b)), floor.msg);
    refs.fieldEl.targetCd = fieldBox('Target CD', target.box, refs.targetChips, target.msg);
    refs.fieldEl.batch = fieldBox('Camps per cycle', batch.box, batch.msg);
    refs.fieldEl.reserveAcres = fieldBox('Spare acres', spare.box, spare.msg);
    refs.fieldEl.maxSpendPerMin = fieldBox('Max spend per minute', rate.box, rate.msg);
    const lockIcon = h('span', { 'aria-hidden': 'true' });
    lockIcon.innerHTML = K.ICONS.lock;
    refs.lock = h('div', { class: 'idc-lock' }, lockIcon, 'Stop the farm to change settings.');
    refs.fs = h('fieldset', { class: 'idc-form' },
      K.group('Budget', refs.fieldEl.budget, refs.fieldEl.minMoney),
      K.group('Goal', refs.fieldEl.targetCd),
      K.group('Batches', refs.fullLabel, refs.landMsg),
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

    const issues = r && !busy ? checkPlan(r) : [];
    const msgFor = (key) => (parseErr[key] ? { level: 'error', text: parseErr[key] } : issues.find((i) => i.field === key));
    for (const [key, f] of Object.entries(refs.fields)) {
      const m = msgFor(key);
      setMsg(f.msg, m);
      f.box.classList.toggle('bad', m?.level === 'error');
    }
    setMsg(refs.landMsg, msgFor('land'));
    refs.full.checked = !!cfg.fullBatch;
    refs.fullText.textContent = cfg.fullBatch
      ? `Always ${cfg.batch} camps per cycle; waits instead of building fewer.`
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
    mod('budget', MODES.find((m) => m.id === DEFAULTS.budget).label);
    for (const key of ['minMoney', 'targetCd', 'batch', 'reserveAcres', 'maxSpendPerMin']) mod(key, defShown(key));
    for (const [key, label] of [['fullBatch', refs.fullLabel], ['autoResume', refs.autoLabel]]) {
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
    if (!refs.plan.hidden) refs.plan.textContent = blocking ? 'Fix the settings marked in red to start.' : planText(r);
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
      const rows = [
        ['Money', `$${fmt(r.money)}`],
        ['Floor', `$${fmt(r.moneyFloor)}`],
        ['Next batch', r.nextBatch ? `${r.nextBatch} camps · $${fmt(r.nextBatchCost)}` : 'none affordable'],
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
      label: 'CD Farm', navTitle: 'Build and demolish Lumber Camps for Construction Data', icon: ICON, navClass: 'cdf-tab', chipClass: 'cdf-chip',
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
    if (saved.running) { resumable = true; stopReason = 'interrupted (page reloaded)'; }
  }

  // Settings out and in (the toolkit's Export / Import). cycles and maxSpend are per-run and never saved.
  const RUN_ONLY = ['cycles', 'maxSpend'];
  function exportCfg() { return { cfg: Object.fromEntries(Object.entries(cfg).filter(([k]) => !RUN_ONLY.includes(k))) }; }
  function importCfg(o) {
    if (running || active) throw new Error('stop the CD Farm run first');
    const applied = [], skipped = [];
    for (const [k, v] of Object.entries(o?.cfg ?? {})) {
      if (k in cfg && !RUN_ONLY.includes(k) && typeof v === typeof cfg[k] && !Number.isNaN(v)) { cfg[k] = v; applied.push(k); } else skipped.push(k);
    }
    save(); render();
    return { applied, skipped };
  }

  window.cdFarm = {
    read, status, start, resume, stop, reset, panel, rates, cfg, exportCfg, importCfg,
    get running() { return running; },
    get active() { return active; },        // a run is still executing (maybe finishing a step after stop())
    get resumable() { return resumable; },  // an interrupted run waits for Resume / Discard
    // Unassigned camps that belong to a running or interrupted run (Autopilot leaves them alone).
    get farmPool() { if (!(running || active || resumable)) return 0; const r = read(); return r ? Math.max(0, r.unassignedCamps - stats.baselinePool) : 0; },
    get stats() { return stats; },
    _debug: () => ({ ...core.sock, ws: undefined, attached: !!core.sock.ws, inFlight, phase, active }),
    _unload: () => { unloaded = true; running = false; unmountUi(); },
  };

  // Wait for the game to render and connect before mounting or resuming.
  (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    mountUi();
    console.log('[cdFarm] ready. Open "CD Farm" in the sidebar, or use cdFarm.start() / cdFarm.stop()' + (resumable ? ' / cdFarm.resume()' : ''));
    if (resumable && cfg.autoResume) {
      while (!read()?.wsOpen) { if (unloaded) return; await sleep(500); }
      await sleep(2000); // let the fresh snapshot land
      resume();
    }
  })();
})();
} catch (e) { console.error('[IdleCorp] CD Farm failed to load:', e); }

