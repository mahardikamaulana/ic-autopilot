// continues the core-plan closure from core-plan-3.js (same try / IIFE)
  // ---- lifecycle -------------------------------------------------------------------------------------------------------------------------
  const heartbeat = () => { try { sstore?.setItem(LIVE_KEY, JSON.stringify({ t: Date.now() })); } catch {} ; takeLock(); };
  const clearLive = () => { try { sstore?.removeItem(LIVE_KEY); } catch {} };
  const lockOwner = () => { try { const l = JSON.parse(store?.getItem(LOCK_KEY) || 'null'); return l && Date.now() - l.t < 15000 ? l.tab : null; } catch { return null; } };
  const takeLock = () => { try { store?.setItem(LOCK_KEY, JSON.stringify({ tab: TAB, t: Date.now() })); } catch {} };
  const dropLock = () => { try { if (lockOwner() === TAB) store?.removeItem(LOCK_KEY); } catch {} };
  addEventListener?.('pagehide', dropLock);   // as the page goes: a reloaded tab may start Live at once, not after the 15 s lock expires

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
      resumeIn: resumeLeft,   // seconds left of the Live resume countdown after a reload (0 = none)
      handedOff: !!memOf('handoff').get().stopped,   // the hand-off has stopped (or recorded) Autopilot once
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
    _unload() { unloaded = true; running = false; clearInterval(loopTimer); cancelResume(); loopTimer = 0; core.reserves?.unregister('corePlan'); dropLock(); removeEventListener?.('pagehide', dropLock); },
  };

  restore();
  try { const f = JSON.parse(sstore?.getItem(LIVE_KEY) || 'null'); if (cfg.liveResume && f && Date.now() - f.t < 10 * 60000) { start({ dryRun: true }); cfg.dryRun = true; scheduleResume(); } } catch {}
  console.log('[corePlan] ready: corePlan.status() reads the stage and conditions; corePlan.start() is a dry run, corePlan.start({ dryRun: false }) goes live');
})();
} catch (e) { console.error('[IdleCorp] Core plan failed to load:', e); }
// @@END core-plan
