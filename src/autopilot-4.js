// continues the autopilot closure from autopilot-3.js (same try / IIFE)
  // ---- execute -------------------------------------------------------------------

  const sleep = core.sleep;
  const jitter = () => sleep(cfg.jitterMinMs + Math.random() * Math.max(0, cfg.jitterMaxMs - cfg.jitterMinMs));
  class ConnError extends Error {}

  function waitConfirm(until, d0) {
    return core.waitConfirm({ read, pred: until, d0, timeoutMs: cfg.timeoutMs, closed: () => { throw new ConnError('socket closed while waiting'); } });
  }

  let sentTimes = [];
  // true = done (or harmless), false = failed, 'held' = not sent because of a hold.
  async function execute(a) {
    inStep = true;
    try { return await executeSteps(a); } finally { inStep = false; }
  }
  async function executeSteps(a) {
    if (a.call) {
      // Not a socket message: hand work to another module (CD Farm). Not awaited: it runs on its own.
      await jitter();
      if (!running) return true;
      if (heldReason()) return 'held';
      const ok = !!a.call();
      finish(a, ok, ok ? 1 : 0, read(), ok ? '' : 'CD Farm did not start');
      if (ok) core.ledger.add('AP', 'action', a.reason);
      if (!ok) note(`not started: ${a.reason} — backing off (see the CD Farm panel / console)`);
      return ok;
    }
    let done = 0, m0 = null;
    for (const step of a.steps) {
      await jitter();
      if (!running) { if (done) finish(a, false, done, read(), 'stopped'); return true; }
      // A hold (e.g. CD Farm starting) only stops an action before its first message:
      // half a build+demolish is finished rather than left for cleanup.
      if (done === 0 && heldReason()) return 'held';
      takeLock();
      const s = read(true);
      if (!s) throw new ConnError('game state not found');
      if (!s.wsOpen) throw new ConnError('socket not open');
      const d0 = core.markSend(s.mutTick);
      m0 ??= s.money;
      s.ws.send(JSON.stringify(step.msg));
      sentTimes.push(Date.now());
      if (!(await waitConfirm(step.until, d0))) {
        const after = read();
        if (finish(a, false, done, after, step.optional ? 'not available yet' : 'server did not apply it') === 'courier') {
          note(`courier busy (freight cooldown or auto-ship): "${a.reason}" waits ${Math.ceil((courierHoldUntil - nowMs()) / 1000)} s`);
          return true; // not an error: it goes again when the courier is back
        }
        note(`${step.optional ? 'skipped' : 'not confirmed'}: ${a.reason} — backing off`);
        return !!step.optional; // optional steps don't count as errors
      }
      done++;
    }
    const after = read();
    finish(a, true, done, after);
    core.ledger.add('AP', 'action', a.reason, { dMoney: m0 != null && after ? Math.round((after.money - m0) / 100) : undefined });
    return true;
  }

  // ---- loop / control -----------------------------------------------------------

  let lastLine = '', actions = 0, fails = 0, log = [], stopReason = '';
  const note = (line) => {
    if (line === lastLine) return;
    lastLine = line;
    log = [`${new Date().toLocaleTimeString()} ${line}`, ...log].slice(0, 6);
    console.log('[earlyGame] ' + line);
    if (LEDGER_NOTE.test(line)) core.ledger.add('AP', /^(connection back|progress)/.test(line) ? 'info' : 'fail', line);
  };
  const LEDGER_NOTE = /^(stopping|error:|not confirmed|skipped|not started|connection back|Live refused|stalled|slowing down|progress again)/;

  let active = false; // a loop is still executing (maybe finishing a step after stop())

  // ---- watchdog, pacing, game check --------------------------------------------------
  let rateScale = 1, okStreak = 0, waitStreak = 0, stalled = '', lastPhase = null, handedOver = false, lastLiveCheck = 0, liveCountdownUntil = 0;
  const INCOME_ACTION = /^(fill|autoship):/;           // selling is steady-state income, not plan progress
  const prog = { sig: '', at: 0, money: 0, acts: 0 };   // last time the plan moved (nowMs clock)
  const cash = [];                                      // { t, m } samples for the cash-change rate
  const sstore = (() => { try { return W.sessionStorage ?? null; } catch { return null; } })();
  const LIVE_KEY = KEY + '.live';
  const liveFlag = (() => { try { const f = JSON.parse(sstore?.getItem(LIVE_KEY) || 'null'); return f && Date.now() - f.t < 10 * 60000 ? f : null; } catch { return null; } })();
  const heartbeatLive = () => { try { sstore?.setItem(LIVE_KEY, JSON.stringify({ t: Date.now() })); } catch {} };
  const clearLive = () => { try { sstore?.removeItem(LIVE_KEY); } catch {} };

  // Plan progress is a change in phase, CD, building count, unlocks or research, or cash up 10 %
  // (+$100). With no progress for cfg.stallMinutes while actions keep coming (20+), say so:
  // a badge, a notification and a banner. It never stops the run by itself. Waiting on a
  // courier or research sends no actions, so it never counts.
  function watchStall(s, acting) {
    const t = nowMs(), ph = phaseOf(s);
    if (ph !== lastPhase) {
      if (lastPhase != null && running && !cfg.dryRun) core.notify('AP', ph === 'done' ? 'Autopilot: plan done' : 'Autopilot: phase ' + ph, 'Money ' + usd(s.money) + ', CD ' + s.cd);
      lastPhase = ph;
    }
    const sig = [ph, s.cd, s.totalBuildings, (s.st.unlocked_buildings ?? []).length, s.research ? 1 : 0, s.queue.length].join('|');
    if (sig !== prog.sig || s.money > prog.money * 1.1 + 10000 || ph === 'done' || !prog.at) {
      prog.sig = sig; prog.at = t; prog.money = s.money; prog.acts = 0;
      if (stalled) { stalled = ''; core.setBadge('AP', ''); note('progress again'); }
      return;
    }
    if (cfg.dryRun) return;
    if (acting) prog.acts++;
    if (!stalled && cfg.stallMinutes > 0 && prog.acts >= 20 && t - prog.at >= cfg.stallMinutes * 60000) {
      stalled = 'no plan progress for ' + Math.round((t - prog.at) / 60000) + ' min (' + prog.acts + ' actions since)';
      note('stalled: ' + stalled);
      core.setBadge('AP', 'AP stalled');
      core.notify('AP', 'Autopilot looks stalled', stalled);
    }
  }

  // Plan done: Core plan picks up at once, in Autopilot's mode (a dry-run resume after a reload never goes Live by itself). Checked before
  // any hold (CD Farm running), so the hand-off never waits. Once per run: a Core plan the user stops stays stopped, even if Iron Frames dip.
  function handOver(s) {
    if (handedOver || !running || !W.corePlan || phaseOf(s) !== 'done') return;
    handedOver = true;
    if (!(W.corePlan.busy || (W.corePlan.running && cfg.dryRun))) { note('plan done: Core plan takes over' + (cfg.dryRun ? ' (dry run)' : '')); W.corePlan.start({ dryRun: !!cfg.dryRun }); }
  }

  // Core plan runs Live and has taken over (it drives a stage, or the hand-off is done): it owns land, building and unlocks from here
  // (scripts/core-game-userscript-plan.md, "Who sends purchases"). Autopilot keeps only its duties: bill resume, power, floors, selling.
  function coreOwns() {
    const c = W.corePlan;
    if (!c?.busy) return false;
    try { return handedOver || !!c.plan()?.stage || !!c.status().handedOff; } catch { return false; }
  }

  // Does the game still look like what this script was written against? Live mode needs it.
  function checkGame(s) {
    const bad = [];
    const miss = core.missingFields(s.st, ['groups', 'stock', 'ssi', 'items']);
    if (miss.length) bad.push('state is missing ' + miss.join(', '));
    const c = s.catalog;
    for (const k of ['items', 'buildings', 'recipes']) if (!Object.keys(c[k] ?? {}).length) bad.push('catalog.' + k + ' is empty');
    if (!c.techs?.length) bad.push('catalog.techs is empty');
    const camp = c.buildings[B.CAMP];
    if (!camp || typeof camp.cost !== 'number' || typeof camp.acres !== 'number') bad.push('Lumber Camp has no cost / acres');
    const fell = c.recipes[R.FELL_WOOD];
    if (!fell || !Array.isArray(fell.inputs) || !Array.isArray(fell.outputs) || typeof fell.ticks !== 'number') bad.push('Fell Wood recipe changed');
    if (typeof c.items[WOOD]?.base_value !== 'number') bad.push('Wood has no base_value');
    if (typeof s.st.items?.[MONEY] !== 'number') bad.push('money is not items[0]');
    // Every building, recipe and item id the plan uses is found by name in the catalog (resolveIds in snapshot()).
    if (idMissing.length) bad.push('not in the catalog: ' + idMissing.join(', '));
    return bad;
  }
  // Why Live must not run right now ('' = fine). Dry runs and the offline sim (no DOM) are never blocked.
  function liveBlocked(s) {
    if (!HAS_DOM || cfg.dryRun || !s) return '';
    const bad = checkGame(s);
    return bad.length ? 'the game data no longer looks like what this script expects (' + bad.join('; ') + ')' : '';
  }

  // Cash change per hour over the last hour (needs 5 min of samples). Includes spending: it is net.
  function trackCash(s) {
    const t = nowMs();
    if (!cash.length || t - cash[cash.length - 1].t >= 30000) cash.push({ t, m: s.money });
    while (cash.length && t - cash[0].t > 3600000) cash.shift();
  }
  function cashRate() {
    if (cash.length < 2) return null;
    const a = cash[0], b = cash[cash.length - 1], dt = b.t - a.t;
    return dt >= 300000 ? { perHour: (b.m - a.m) / (dt / 3600000), mins: Math.round(dt / 60000) } : null;
  }

  async function loop() {
    active = true;
    let lostSince = 0, courierWaiting = false;
    waitStreak = 0;
    while (running) {
      let pause = cfg.intervalMs;
      try {
        const s = read();
        if (!s || !s.wsOpen) {
          lostSince ||= Date.now();
          if (lockOwner() === TAB || !lockOwner()) takeLock();
          note(`waiting for the game connection (${Math.round((Date.now() - lostSince) / 1000)} s)…`);
          await sleep(2000);
          continue;
        }
        if (lostSince) { lostSince = 0; note('connection back'); await sleep(2000); continue; } // let the fresh Snapshot land
        const owner = lockOwner();
        if (owner && owner !== TAB) { stopReason = 'another tab is running Autopilot'; note('stopping: ' + stopReason); break; }
        takeLock();
        if (!cfg.dryRun) {
          heartbeatLive();
          if (HAS_DOM && Date.now() - lastLiveCheck > 60000) {
            lastLiveCheck = Date.now();
            const why = liveBlocked(s);
            if (why) { cfg.dryRun = true; clearLive(); note('Live refused: ' + why); core.notify('AP', 'Autopilot switched to dry run', why); render(); continue; }
          }
        }
        observe(s);
        trackCash(s);
        handOver(s);
        const held = heldReason();
        if (held) { note('paused: ' + held); await sleep(cfg.intervalMs); continue; }
        sentTimes = sentTimes.filter((t) => Date.now() - t < 60000);
        if (sentTimes.length >= Math.max(2, Math.floor(cfg.maxActionsPerMin * rateScale))) { note('rate limit: waiting'); await sleep(5000); continue; }
        const a = decide(s);
        if (s.bookWanted) core.orderBook?.need(REGION);   // buys need other players' orders; released a minute after the last need
        watchStall(s, !a.wait && !INCOME_ACTION.test(a.key ?? ''));
        if (a.wait) {
          note('wait — ' + a.wait);
          // Nothing to do: look less often the longer it lasts (up to cfg.maxIdleMs). A command applied
          // by the server (yours, or one you click) ends the sleep early.
          waitStreak++;
          pause = Math.min(Math.max(cfg.maxIdleMs, cfg.intervalMs), cfg.intervalMs * (1 + Math.floor(waitStreak / 5)));
          // Courier work is waiting on the freight cooldown: wake right when it ends and retry.
          if (a.waits.some((w) => /^courier busy/.test(w))) {
            courierWaiting = true;
            const back = courierBackInMs(s);
            if (back > 0) pause = Math.min(pause, back + 250);
          }
        }
        else if (cfg.dryRun) note('DRY RUN would: ' + a.reason + '  ' + (a.callInfo ?? a.steps.map((x) => JSON.stringify(x.msg)).join(' ; ')));
        else {
          waitStreak = 0;
          if (courierWaiting && usesCourier(a)) note('courier back: retrying');
          courierWaiting = false;
          note(a.reason);
          const res = await execute(a);
          if (res === 'held') continue;
          if (res) {
            actions++; fails = 0;
            // Back to full pace after 10 confirmed actions in a row.
            if (++okStreak >= 10 && rateScale < 1) { rateScale = Math.min(1, rateScale * 1.25); okStreak = 0; }
          } else {
            // An action the server did not apply: slow down (half the action cap, down to a quarter).
            okStreak = 0;
            if (rateScale > 0.25) { rateScale = Math.max(0.25, rateScale / 2); note('slowing down to ' + Math.round(rateScale * 100) + '% pace'); }
            if (++fails >= 10) { stopReason = '10 actions in a row were not confirmed'; note('stopping: ' + stopReason); break; }
          }
          continue;
        }
        fails = 0;
      } catch (e) {
        if (e instanceof ConnError) { note(e.message); await sleep(2000); continue; }
        fails++;
        note(`error: ${e.message}`);
        if (fails >= 10) { stopReason = '10 errors in a row'; note('stopping after ' + stopReason); break; }
      }
      await core.sleepWake(pause);
    }
    running = false; active = false; save(); dropLock(); clearLive(); core.setBadge('AP', '');
    if (stopReason && stopReason !== 'stopped by you') core.notify('AP', 'Autopilot stopped', stopReason);
    render();
  }

  function start(opts = {}) {
    if (running) return console.warn('[earlyGame] already running');
    if (active) return console.warn('[earlyGame] the previous run is still finishing its step; try again in a few seconds');
    const owner = lockOwner();
    if (owner && owner !== TAB) return console.warn('[earlyGame] already running in another tab of this browser');
    Object.assign(cfg, opts);
    if (!cfg.dryRun && HAS_DOM) {
      const why = liveBlocked(read(true));
      if (why) { cfg.dryRun = true; console.warn('[earlyGame] Live refused: ' + why + '. Starting as a dry run.'); core.toast('Live refused: the game data changed. Started as a dry run (see the console).'); core.ledger.add('AP', 'fail', 'Live refused: ' + why); }
    }
    takeLock();
    running = true; fails = 0; lastLine = ''; stopReason = ''; handedOver = false;
    stalled = ''; prog.at = 0; waitStreak = 0; rateScale = 1; okStreak = 0; lastLiveCheck = Date.now();
    core.setBadge('AP', '');
    if (cfg.dryRun) clearLive(); else heartbeatLive();
    save();
    console.log(`[earlyGame] start (${cfg.dryRun ? 'DRY RUN — start({ dryRun: false }) to send' : 'LIVE'})`);
    loop();
    render();
  }
  function stop() { if (running) stopReason = 'stopped by you'; running = false; clearLive(); save(); dropLock(); console.log('[earlyGame] stopped'); render(); }

  // Settings out and in (the toolkit's Export / Import buttons). Never touches session-only settings.
  function exportCfg() { return { cfg: persistable() }; }
  function importCfg(o) {
    if (running && !cfg.dryRun) throw new Error('stop the live run first');
    return applyCfg(o);
  }
  // Live-safe, saving setter for other modules (Core plan): the same validation as importCfg, allowed while Autopilot runs,
  // and neverSell is unioned with what is already there. Settings poked straight onto `cfg` would not be saved.
  function tune(patch = {}) {
    const p = { ...patch };
    if (Array.isArray(p.neverSell)) p.neverSell = [...new Set([...cfg.neverSell, ...p.neverSell])];
    return applyCfg({ cfg: p });
  }
  function applyCfg(o) {
    const applied = [], skipped = [];
    for (const [k, v] of Object.entries(o?.cfg ?? {})) {
      const f = FIELDS[k];
      const ok = k in cfg && !SESSION_ONLY.includes(k) && typeof v === typeof cfg[k] && Array.isArray(v) === Array.isArray(cfg[k])
        && (typeof v !== 'number' || Number.isNaN(v) === false)
        && !(f && ((f.min != null && v < f.min) || (f.max != null && v > f.max)));
      if (ok) { cfg[k] = v; applied.push(k); } else skipped.push(k);
    }
    save(); render();
    return { applied, skipped };
  }
  function resetCfg() {
    if (running && !cfg.dryRun) throw new Error('stop the live run first');
    for (const k of Object.keys(DEFAULTS)) if (!SESSION_ONLY.includes(k)) cfg[k] = Array.isArray(DEFAULTS[k]) ? [...DEFAULTS[k]] : DEFAULTS[k];
    save(); render();
  }

  // After a reload with cfg.liveResume (and this tab was running Live less than 10 min ago): 60 s to cancel.
  async function liveCountdown() {
    liveCountdownUntil = Date.now() + 60000;
    panel(true);
    core.notify('AP', 'Autopilot resumes LIVE in 60 s', 'Open the Autopilot panel and press Cancel to resume as a dry run instead.');
    while (liveCountdownUntil && Date.now() < liveCountdownUntil) {
      if (unloaded) return false;
      render();
      await sleep(500);
    }
    const go = liveCountdownUntil !== 0;
    liveCountdownUntil = 0;
    render();
    return go;
  }

  function keepPaused(id) { keptPaused.add(+id); billPaused.delete(+id); save(); console.log(`[earlyGame] group ${id} will never be auto-resumed`); }

  // What the next planned steps need, for CD Farm's Auto mode: the power-bill money floor (cents), items it must not
  // use (floor kits owed to unequipped buildings, an hour of what running groups eat, the next unlock's prototype),
  // and the next unlock with the CD it costs and whether everything else for it is ready. null until the game state is read.
  function reserve() {
    const s = read();
    if (!s) return null;
    const items = {};
    const add = (item, n) => { if (n > 0) items[item] = (items[item] ?? 0) + n; };
    for (const [item, n] of Object.entries(s.kitOwed)) add(item, n);
    for (const [item, perMin] of Object.entries(s.eatPerMin)) add(item, Math.ceil(perMin * 60));
    let next = null;
    const nt = nextTech(s);
    const tech = nt && s.catalog.techs.find((t) => t.building === nt.b);
    if (tech) {
      const proto = s.bld(nt.b).build_items ?? [];
      for (const p of proto) add(p.item, p.amount);
      const gate = nt.gate ? nt.gate(s) : true;
      const missing = proto.find((p) => s.has(p.item) < p.amount);
      const note = gate !== true ? gate : tech.requires != null && !s.unlocked(tech.requires) ? `${bname(s, tech.requires)} to be unlocked`
        : missing ? `the ${iname(s, missing.item)} prototype` : '';
      next = { b: nt.b, name: bname(s, nt.b), cd: tech.cost, prereqsMet: !note, note };
    }
    // What Autopilot's own selling keeps: wood and floor reserves, and the build items of its next two plan builds.
    add(WOOD, cfg.woodReserve);
    for (const item of [WOOD, ...Object.keys(s.eatPerMin).map(Number)]) add(item, floorReserve(s, item));
    for (const t of criticalTargets(s).slice(0, 2)) for (const p of s.bld(t.b).build_items ?? []) add(p.item, p.amount);
    return { moneyFloor: Math.max(moneyFloor(s), cfg.boosterKeepCash * 100), items, nextTech: next, phase: phaseOf(s) };
  }

  // Pause after the current step (resolves once nothing is being sent), e.g. CD Farm before it
  // takes its baseline of unassigned camps. Holds live in memory only; release() lifts one.
  async function hold(who = 'you') {
    holds.add(String(who)); render();
    const t0 = Date.now();
    while (inStep && Date.now() - t0 < 60000) await sleep(100);
  }
  function release(who = 'you') { holds.delete(String(who)); render(); }

  function plan() {
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const a = decide(s);
    console.log('[earlyGame] next: ' + (a.wait ? 'wait — ' + a.wait : a.reason), a.steps?.map((x) => x.msg) ?? '');
    return a;
  }

  function checklist(s) {
    const mark = (ok) => (ok ? '✓' : '·');
    const row = (label, have, target) => [label, `${mark(have >= target)} ${have} / ${target === Infinity ? '∞' : target}`];
    const techState = (b) => (s.unlocked(b) ? '✓' : s.research?.building === b ? 'researching' : s.queue.some((q) => q.building === b) ? 'queued' : '·');
    return [
      ['Phase', String(phaseOf(s))],
      ['Money', `${usd(s.money)} (floor ${usd(moneyFloor(s))})`],
      ['CD', s.cd],
      ['Acres', `${s.acresUsed} / ${s.acresOwned} · next ${usd(acrePrice(s.landBought))}`],
      ['Power', `${s.powerHave} MW (need ${s.powerNeed})`],
      ['Lumber Camps / Farms', `${s.owned(B.CAMP)} / ${s.owned(B.FARM)}`],
      ...techPlan().map((t) => [`P${t.phase} unlock ${bname(s, t.b)}`, techState(t.b)]),
      row('Sawmills', s.owned(B.SAWMILL), sawTarget(s)),
      row('Workshops (Frame Timber)', s.running(B.WORKSHOP, R.FRAME_TIMBER), cfg.workshops),
      row('Iron Mines', s.running(B.MINE, R.MINE_IRON), mineTarget(s, R.MINE_IRON)),
      row('Coal Mines', s.running(B.MINE, R.MINE_COAL), mineTarget(s, R.MINE_COAL)),
      row('Limestone Quarries', s.owned(B.QUARRY), cfg.quarries),
      row('Smelters', s.owned(B.SMELTER), cfg.smelters),
      row('Gold Mines', s.running(B.MINE, R.MINE_GOLD), goldTarget(s)),
      row('Workshops (Iron Frames)', s.running(B.WORKSHOP, R.RIVET), cfg.ironFrameWorkshops),
      ['Planks / Wooden / Iron Frames', `${Math.floor(s.has(PLANKS))} / ${Math.floor(s.has(WFRAME))} / ${Math.floor(s.has(IFRAME))}`],
      ['Unequipped (no kit)', s.groups.filter((g) => g.count > (g.equipped ?? 0)).map((g) => `${g.name} ${g.count - (g.equipped ?? 0)}`).join(', ') || '—'],
      ['Courier', s.courierFree ? 'free' : `busy, ${courierEta(s)}${Object.keys(s.standing).length ? ' (auto-ship running)' : ''}`],
      ['Floorplans', floorPlans(s).map((f) => `${f.task} x${f.cur.rate}${f.upgrade ? `→x${f.best.rate}` : ' ✓'}`).join(', ') || '—'],
      ['Starved', s.starved.map((g) => g.name).join(', ') || '—'],
      ['Paused', s.groups.filter((g) => g.paused).map((g) => `${g.name}${billPaused.has(g.id) && !keptPaused.has(g.id) ? ' (unpaid bill: auto-resume)' : ' (yours: left alone)'}`).join(', ') || '—'],
    ];
  }

  function status() {
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const d = decide(s);
    const rows = [...checklist(s),
      ['Next', d.wait ? 'wait — ' + d.wait : d.reason],
      ['Mode', `${running ? 'running' : 'stopped'}${cfg.dryRun ? ' (dry run)' : ''}`]];
    console.table(Object.fromEntries(rows));
    return rows;
  }

  function floors() {
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const rows = floorTable(s);
    console.log(`[earlyGame] floorplans — scorer: ${s.engine && !scorerBroken ? 'live (game engine)' : 'not found, using known rates'}`);
    console.table(rows);
    return rows;
  }

  // "Before you go offline": keep `hours` of power bills, start the longest plan unlock that is ready, and say what to check.
  // The unlock goes through the loop (all guards, dry run sends nothing) in the next 10 minutes; nothing is sent from here.
  function offline(hours = 8) {
    cfg.billHours = Math.max(1, hours); save();
    longUnlockUntil = nowMs() + 600000;
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const need = moneyFloor(s);
    const nt = nextTech(s);
    console.log(`[earlyGame] offline for ${hours} h:` +
      `\n  • power ${s.powerHave} MW → keep ${usd(need)} for bills (have ${usd(s.money)})${s.money < need ? '  ⚠ NOT ENOUGH: powered groups will pause' : ' ✓'}` +
      '\n  • the script now never spends below that, until the page reloads (earlyGame.cfg.billHours = 1 to undo)' +
      "\n  • auto-ship and selling stop while you're offline; stock piles up (24 h cap on the free plan)" +
      `\n  • research: ${s.research ? `${bname(s, s.research.building)} running ✓` : nt ? `idle — ${running ? `Autopilot starts ${bname(s, nt.b)} (the longest ready unlock)` : `next is ${bname(s, nt.b)} (start a long unlock before leaving)`}` : 'idle'}`);
  }


