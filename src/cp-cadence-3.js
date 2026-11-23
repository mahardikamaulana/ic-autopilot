// continues the cp-cadence closure from cp-cadence-2.js (same try / IIFE)
  // ---- Auto utilities on from Stage A (plan D1, wiki 8.1 step 1, 8.2) ------------------------------------------------------------------
  // Like the ladder's autoStart: switched on once per Live session. Why it went off comes from autoUtil's ledger lines: "Auto <u> off" with no
  // stop-all line right after it is the user's (sticky until they switch it on again); with one it is Alt+Shift+X, and "switched off" is its
  // own 3-failure stop: both wait for Core plan's next Live session.
  // The ledger is read only while Core plan steps. A switch-off while it was stopped, whose line has left the ledger, is read from state at
  // the start of a Live session: power off, no ledger line why, and mem says Core plan had switched it on (cpOn) = the user's (sticky).
  // Never switched on by Core plan: it is switched on.
  const UTIL_LOAD = Math.random().toString(36).slice(2, 8);
  let utilSession = 0, utilLiveAt = 0;
  function utilOffWhy(util, list) {
    let stopAt = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.mod === '--' && /^stop all/.test(e.text)) { stopAt = e.t; continue; }
      if (e.mod !== 'AU') continue;
      if (e.text === 'Auto ' + util + ' on') return null;
      if (e.text.startsWith('Auto ' + util + ' switched off')) return 'error';
      if (e.text === 'Auto ' + util + ' off') return stopAt && stopAt - e.t < 5000 ? 'pause' : 'user';
    }
    return null;   // no switch-off in the ledger
  }
  // Reading the ledger is not pure: done here, and the switch-off kept in mem (the ledger holds 300 lines) until the switch is seen on.
  function utilContext(v, ctx) {
    const gap = 3 * (cfg.intervalMs ?? 5000);
    let fresh = false;   // the first step of a Live session
    if (ctx.live) { if (!utilLiveAt || ctx.now - utilLiveAt > gap) { utilSession++; fresh = true; } utilLiveAt = ctx.now; }
    else utilLiveAt = 0;   // dry run: going Live again is a new session
    ctx.utilSession = UTIL_LOAD + ':' + utilSession;
    const au = ctx.mods?.autoUtil;
    if (!au?.conf || !ctx.mem) return;
    let list = [];
    try { list = core?.ledger?.list?.() ?? []; } catch {}
    const mm = ctx.mem('utilities');
    for (const u of ['power', 'water']) {
      const off = mm.get().off ?? {};
      if (au.conf[u]?.on) { if (off[u]) mm.set({ off: { ...off, [u]: null } }); continue; }
      if (off[u]) continue;
      const why = utilOffWhy(u, list) ?? (fresh && mm.get().cpOn?.[u] ? 'user' : null);
      // first step of a session: a stop-all or error stop happened while Core plan was stopped too, so it belongs to a past session
      if (why) mm.set({ off: { ...off, [u]: { why, session: fresh && why !== 'user' ? null : ctx.utilSession } } });
    }
  }
  function utilDecide(v, ctx) {
    const au = ctx.mods?.autoUtil;
    if (!au?.conf || !ctx.mem) return null;
    const m = ctx.mem('utilities').get(), sid = ctx.utilSession, alerts = [];
    const water = v.groups.some((g) => !g.paused && g.count > 0 && (v.bld(g.building).draws?.water ?? 0) > 0);
    const readout = { power: au.conf.power?.on ? 'on' : 'off', water: au.conf.water?.on ? 'on' : water ? 'off' : 'off (no running group draws water)', alerts };
    for (const u of ['power', 'water']) {
      if (au.conf[u]?.on || (u === 'water' && !water)) continue;
      const off = m.off?.[u];
      if (off?.why === 'user') { alerts.push('Auto ' + u + ' was switched off by you: Core plan does not switch it back on'); continue; }
      if (off ? off.session === sid : m.armed?.[u] === sid) { alerts.push('Auto ' + u + ' went off (' + (off?.why === 'pause' ? 'Alt+Shift+X' : off?.why === 'error' ? 'the game did not apply its changes' : 'not by a switch') + '): switched on again in the next Live session'); continue; }
      return { readout, action: { id: 'utilities:' + u, text: 'Auto utilities: ' + u + ' on (wiki 8.1' + (u === 'water' ? ', a running group draws water' : '') + ')',
        run: async () => {
          au.set(u, true);
          const mm = ctx.mem('utilities'), ok = au.conf[u]?.on === true;
          mm.set({ armed: { ...(mm.get().armed ?? {}), [u]: sid }, off: { ...(mm.get().off ?? {}), [u]: null }, ...(ok ? { cpOn: { ...(mm.get().cpOn ?? {}), [u]: true } } : {}) });
          return ok;
        } } };
    }
    return { readout };
  }

  // ---- registration ------------------------------------------------------------------------------------------------------------------
  // The server tick now: the core's clock (last tick seen + elapsed), never behind the last mutation tick.
  let memRef = null;                             // ctx.mem, for corePlan.offline() outside a step
  const setTick = (v, ctx) => { if (ctx.tick == null) { let t = 0; try { t = core?.nowTick?.() ?? 0; } catch {} ctx.tick = Math.max(t, v.mutTick ?? 0); } };
  cp.addDirector({
    name: 'resume', order: 10, always: true,   // always: a bill pause can make cash fall (S6) and drop the stage
    defaults: { resumeGraceMin: 2 },   // minutes after a SetPaused Core plan sent in which a pause of that group is the director's
    context(v, ctx) { ctx.apKept = keptPaused(); if (ctx.mem) resumeObserve(v, ctx.mem('resume'), ctx); },
    decide: resumeDecide,
    duties: () => [{ duty: 'resume groups paused by an unpaid bill (waits while Autopilot runs with resumePaused on)', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'utilities', order: 12, always: true,   // always: from the first step, before a stage holds (wiki 8.1 step 1)
    context: utilContext, decide: utilDecide,
    duties: () => [{ duty: 'Auto utilities: power on, water on while a group draws water', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'slot', order: 70,
    defaults: { dir_slot: true, slotLotMin: 150000, slotMinMinutes: 60, slotRearmMinutes: 15 },
    context(v, ctx) {
      setTick(v, ctx);
      // Forget fills that are gone from the server.
      const m = ctx.mem('slot'), a = m.get().armed ?? {}, sf = v.st.standing_fills ?? {};
      const gone = Object.keys(a).filter((id) => !sf[id]);
      if (gone.length) setArmed(m, (x) => { for (const id of gone) delete x[id]; });
    },
    decide: slotDecide,
    duties: () => [{ duty: 'native Cotton auto-ship slot (Core plan acts only while Autopilot is stopped or autoShipCotton is off)', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'sell', order: 75,
    defaults: { dir_sell: true, sellKeepHours: 48, sellKitBuilds: 3, sellSaturatedHours: 24, sellCooldownMinutes: 60 },
    context(v, ctx) {
      setTick(v, ctx);
      let read = false;
      if (ctx.sellJobs == null) { try { ctx.sellJobs = ctx.mods?.autoSell?.jobs?.() ?? null; read = Array.isArray(ctx.sellJobs); } catch {} ctx.sellJobs ??= []; } else read = true;
      if (!read || !ctx.mods?.autoSell) return;
      // A job we started that autoSell ended by itself (5 unconfirmed sends, bid filled, user stop) cools down before that bid
      // is tried again: an instant restart would loop unconfirmed sends forever without tripping the 3-fail stop.
      const m = ctx.mem('sell'), o = m.get(), now = ctx.now ?? 0, have = new Set(ctx.sellJobs.map((j) => j.deal));
      // A job autoSell moved to another bid (its `from` is our old id) is still ours. shortcut: only the last move is remembered, so a job that moves twice between two ticks is lost; upgrade to a chain if that is ever seen.
      const was = o.mine ?? [], mine = was.map((d) => ctx.sellJobs.find((j) => j.from === d)?.deal ?? d), ended = mine.filter((d) => !have.has(d));
      const cool = Object.fromEntries(Object.entries(o.cool ?? {}).filter(([, until]) => until > now));
      for (const d of ended) cool[d] = now + cfg.sellCooldownMinutes * 60000;
      if (ended.length || mine.some((d, i) => d !== was[i]) || Object.keys(cool).length !== Object.keys(o.cool ?? {}).length) m.set({ mine: mine.filter((d) => have.has(d)), cool });
    },
    decide: sellDecide,
    duties: () => [{ duty: 'Auto ship jobs for ore, stone, sheets and saturated shelves (keep line)', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'cadence', order: 80,
    defaults: { dir_cadence: true, shelfHours: 1, kitWaveBuilds: 3 },
    context(v, ctx) {
      setTick(v, ctx); memRef = ctx.mem;
      ctx.worldEvents ??= core?.sock?.worldEvents ?? null;
      const m = ctx.mem('cadence');
      if ((m.get().retailOk ?? null) !== (ctx.retailOk ?? null)) m.set({ retailOk: ctx.retailOk ?? null });
      cadenceSettle(cp.plan?.(), m, ctx.now ?? 0);
      ctx.cadenceFired = tickPeriods(m, ctx.now ?? 0);
    },
    decide: cadenceDecide,
    duties: () => [{ duty: 'hourly and 6-hour checks (alerts on a new failure)', owner: 'Core plan', done: true }],
  });
  cp.offline = offline;
  cp.canSaveDesign = canSaveDesign;
  cp.worldEvents = () => core?.sock?.worldEvents ?? null;
  cp._cadence = { utilDecide, utilOffWhy, slotDecide, sellPlan, sellDecide, cadenceDecide, cadenceSettle, tickPeriods, hourlyChecks, sixHourChecks, offlinePlan, canSaveDesign, resumeObserve, keptPaused, resumeDecide, keepLine, consumption, activeFills, slotFills, NEVER, TARGETS };
})();
} catch (e) { console.error('[IdleCorp] cp-cadence failed to load:', e); }
// @@END cp-cadence