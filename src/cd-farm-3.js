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
  const perCd = () => { const netCd = stats.built - (stats.rushCd ?? 0); return netCd > 0 ? (netSpend() / netCd).toFixed(2) : '-'; };

  async function start(opts = {}) {
    if (running) return console.warn('[cdFarm] already running');
    if (active) return console.warn('[cdFarm] previous run is still finishing its step; try again in a moment');
    const { resume: resumeFlag, runOnly, by, ...rest } = opts;
    const resume = !!resumeFlag;
    let r = read();
    if (!r) return console.error('[cdFarm] game state not found');
    const miss = core.missingFields(core.walk(true).st, ['groups', 'items']);
    if (miss.length) return console.error('[cdFarm] the game state no longer has ' + miss.join(', ') + ': refusing to run (did the game update?)');
    if (rest.building != null && !isBuilding(rest.building)) {
      return console.error(`[cdFarm] building must be 'auto', 'cheapest' or one of: ${BUILDINGS.map((b) => `${b.id} (${b.name})`).join(', ')}`);
    }
    if (rest.region != null && rest.region !== 'auto' && ![0, 1, 2, 3].includes(rest.region)) return console.error("[cdFarm] region must be 'auto' or 0-3");
    // runOnly: these settings are for this run only; yours come back when it stops.
    if (runOnly && !restoreCfg) restoreCfg = { ...cfg };
    // cycles and maxSpend apply to one run only; other settings are remembered.
    if (!resume) { cfg.cycles = Infinity; cfg.maxSpend = Infinity; }
    Object.assign(cfg, rest);
    const scaleFloor = !('minMoney' in rest) && cfg.minMoney === DEFAULTS.minMoney;   // a floor passed in (Autopilot's booster) is never scaled

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
        // Fix the building ('cheapest' resolves to one type now) and the region for the whole run, before resetting stats.
        const building = cfg.building === 'cheapest' ? cheaperId() : cfg.building, reg = pickRegionNow();
        stats = freshStats();
        stats.building = building; stats.region = reg; stats.scaleFloor = scaleFloor;
        r = mustRead(); // re-read: the pool count must be for the building this run uses
        Object.assign(stats, { cdStart: r.cd, moneyStart: r.money, startedAt: Date.now(), baselinePool: r.unassignedCamps, by: by || '' });
        stats.baseline = { ...(readPool()?.pool ?? {}) }; strikes = 0; recovering = 0; dryCycles = 0; waitSince = 0;
        for (const k of Object.keys(mismatch)) delete mismatch[k];

        sample();
      }
      resumable = false; began = true;
      segStart = Date.now();
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

