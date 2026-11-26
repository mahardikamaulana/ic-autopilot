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
  // Settings back to the defaults (the run's own numbers stay); refused while a run is going.
  function resetCfg() {
    if (running || active) throw new Error('stop the CD Farm run first');
    if (resumable) throw new Error('discard or resume the interrupted CD Farm run first');
    for (const k of Object.keys(DEFAULTS)) if (!RUN_ONLY.includes(k)) cfg[k] = DEFAULTS[k];
    save(); render();
  }

  window.cdFarm = {
    read, status, start, resume, stop, reset, panel, rates, cfg, exportCfg, importCfg, resetCfg, pauseAuto,
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
    _unload: () => { unloaded = true; running = false; ctlTimer?.(); ctlTimer = null; unmountUi(); },
  };

  // Wait for the game to render and connect before mounting or resuming.
  (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    mountUi();
    ctlTimer = core.every(2000, () => controllerTick().catch((e) => console.error('[cdFarm]', e)));
    console.log('[cdFarm] ready. Open "CD Farm" in the sidebar, or use cdFarm.start() / cdFarm.stop()' + (resumable ? ' / cdFarm.resume()' : ''));
    if (resumable && cfg.autoResume) {
      while (!read()?.wsOpen) { if (unloaded) return; await sleep(500); }
      await sleep(2000); // let the fresh snapshot land
      resume();
    }
  })();
})();
} catch (e) { console.error('[IdleCorp] CD Farm failed to load:', e); }

