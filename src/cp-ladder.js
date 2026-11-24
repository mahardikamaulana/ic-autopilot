// ============================================================================
// CORE PLAN DIRECTOR: 8. Stage D ladder (window.corePlan director "ladder")
// ============================================================================
// Feeds and tunes CD Farm's Auto mode per stage (wiki/guides/core-game-plan.md section 11); it never cycles buildings itself.
//   CD need (out.cdNeed): A = next unlock (Assembly Plant 20,000), B = Retail Store 5,000 banked, C = none (pause Auto once),
//   D = none until the retail checkpoint passes, then Oil Rig 5,000, then Refinery 500,000 (11.4: 505,000 farmed in Stage D).
//   Auto tuning through cdFarm.importCfg, only between runs and only for keys that differ, read back after:
//   land 'off' (Core plan owns land), pace, batch (core-math bestBatch at the measured income), reserveAcres, maxTypes 1 in D,
//   autoStart: armed when Auto is off and nothing says the user wants it off. The user's Stop (or unticking it) is sticky until
//   they switch it on again; Alt+Shift+X, CD Farm's own error / dry-run switch-off wait for Core plan's next Live session
//   (the live-resume countdown after a reload); the ladder's own Stage C pause ends with the stage.
//   Stage D gates (11.4): checkpoint passed (a pass of either run, plan D-2), 0 Farms owned (waived on the retail fail path, where Wooden
//   Frames are the CD source), free acres >= batch + spare; alert when Auto's plan is not Farm-only.
// @@MODULE cp-ladder
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const M = W.idleCore?.coreMath;
  if (!M) throw new Error('core-math did not load');
  const NAME = 'ladder', WALL_CD = 505000;   // Oil Rig 5,000 + Refinery 500,000 (2026-11-24 catalog)
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const cfgOf = () => W.corePlan.cfg;
  // A Live session = Core plan stepping live without a long gap; a reload starts a new one (new LOAD token).
  const LOAD = Math.random().toString(36).slice(2, 8);
  let session = 0, liveAt = 0;

  // Why Auto went off, from CD Farm's own ledger lines since it was last seen on. No line = unticked by hand = the user's.
  function offWhy(since) {
    let list = [];
    try { list = W.idleCore?.ledger?.list?.() ?? []; } catch {}
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (since && e.t < since) break;
      if (e.mod !== 'CD') continue;
      if (/Auto switched off because you stopped it/.test(e.text)) return 'user';
      if (/Auto switched off \(stop all\)/.test(e.text)) return 'pause';
      if (/Auto switched off after \d+ errors/.test(e.text)) return 'error';
      if (/dry run: plan logged/.test(e.text)) return 'dry';
    }
    return 'user';
  }

  // An unlock counts as done once its research runs or waits in the queue: its CD is already spent.
  const researching = (v, b) => b != null && (v.research?.building === b || (v.st.research_queue ?? []).some((q) => q?.building === b));
  const gone = (v, name) => v.unlocked(name) || researching(v, v.idB(name));
  // A deliberate banking target: prereqsMet is true on purpose (Retail Store needs the Assembly Plant that is still researching;
  // the Refinery needs the Oil Rig whose research runs). Otherwise CD Farm's gate G3 would keep Auto idle.
  function needOf(v, name, note = '') {
    const b = v.idB(name), tech = b == null ? null : v.N.techs.find((t) => t.building === b);
    if (!tech) return { missing: name };
    return { b, name, cd: tech.cost, prereqsMet: true, note };
  }

  // What the stage asks of the CD farm. need: undefined = keep the next unlock, false = no CD need, object = this target.
  function phaseOf(v, stage, ctx) {
    if (stage === 'A') return { key: 'A', arm: true };
    if (stage === 'B') {
      if (gone(v, 'Retail Store')) return { key: 'B-done', need: false, why: 'Retail Store already unlocked or researching' };
      return { key: 'B', need: needOf(v, 'Retail Store', 'banked while the Assembly Plant researches'), arm: true };
    }
    if (stage === 'C') {
      // stageOf says C as soon as the Assembly Plant is in; the wiki's C (pause) starts with the Retail research.
      if (gone(v, 'Retail Store')) return { key: 'C', need: false, pause: true, why: 'stage C: no CD cycling until the store passes the checkpoint (11.3)' };
      const n = needOf(v, 'Retail Store', 'not banked in stage B');
      if (n.missing || v.cd < n.cd) return { key: 'C-bank', need: n, arm: true, why: 'stage C: Retail Store research not started, ' + fmt(v.cd) + ' / ' + fmt(n.cd ?? 0) + ' CD' };
      return { key: 'C', need: false, pause: true, why: 'stage C: Retail Store CD is in hand, no CD cycling (11.3)' };
    }
    if (stage === 'D' || stage === 'END') {
      if (ctx.retailOk !== true) return { key: 'D-wait', need: false, pause: true, why: 'stage D: the store has not passed the retail checkpoint' + (ctx.retailOk === false ? ' (it failed: a new run measures the capped output)' : ' yet') };
      if (!gone(v, 'Oil Rig')) return { key: 'D', need: needOf(v, 'Oil Rig'), arm: true, ladder: true };
      if (!gone(v, 'Refinery')) return { key: 'D', need: needOf(v, 'Refinery', v.unlocked('Oil Rig') ? '' : 'Oil Rig research running'), arm: true, ladder: true };
      return { key: 'D-done', need: false, why: 'Refinery research started: no CD need left' };
    }
    return null;
  }

  // CD Farm reads are not pure (rates() reads the page, evaluate() samples its history), so they happen here, before decide.
  function context(v, ctx, stage) {
    // The phase's CD need, published before any decide: buildout (order 40) reads it for the Wooden Frame gate.
    const ph = phaseOf(v, stage, ctx);
    ctx.ladderNeed = ph?.need && !ph.need.missing ? ph.need : false;
    const gap = 3 * (cfgOf().intervalMs ?? 5000);
    if (ctx.live) { if (!liveAt || ctx.now - liveAt > gap) session++; liveAt = ctx.now; }
    else liveAt = 0;   // dry run: going Live again is a new session
    const cf = ctx.mods?.cdFarm;
    if (!cf) return;
    const lad = { rates: null, plan: null, income: null, held: null, session: LOAD + ':' + session };
    try { lad.held = cf.farmUnits ?? null; } catch {}   // buildings a CD Farm run holds in the pool between its Buy and Demolish
    // Record Auto going off (and back on) here, where reading the ledger is allowed; decide only reads mem.
    if (cf.cfg?.building === 'auto') {
      const mm = ctx.mem(NAME), m = mm.get();
      if (cf.cfg.autoStart) { if (m.off || !m.onAt) mm.set({ off: null, onAt: ctx.now }); }
      else if (!m.off && (m.armed || m.onAt)) mm.set({ off: { why: offWhy(m.onAt), session: lad.session } });
    }
    try { lad.rates = cf.rates?.() ?? null; } catch {}
    try { const ev = cf.evaluate?.(); lad.plan = ev?.plan ?? null; lad.income = ev?.income ?? null; lad.gate = ev?.idle ? (ev.gate + ': ' + ev.reason) : null; } catch {}
    ctx.ladder = lad;
  }

  function decide(v, ctx, out) {
    const c = cfgOf(), stage = out.stage;
    const ph = phaseOf(v, stage, ctx);
    if (!ph) return { wait: 'no stage yet' };
    const waits = [], alerts = [];
    if (ph.need?.missing) {
      out.cdNeed = false;
      return { wait: 'off: no tech named ' + ph.need.missing + ' in the catalog (the game changed?)', readout: { phase: ph.key, alerts: ['no tech named ' + ph.need.missing] } };
    }
    const lad = ctx.ladder ?? {};
    const cycles = lad.rates?.cyclesh15 > 0 ? lad.rates.cyclesh15 : ctx.cyclesPerHour ?? c.cyclesPerHour;   // measured CD Farm cycles first: E3 checks the batch against them
    const incomeH = lad.income > 0 ? lad.income / 100 : out.rule?.income ?? null;   // CD Farm measures cents/h; core-math works in dollars
    const batch = incomeH > 0 && cycles > 0 ? M.bestBatch('farm', 0, incomeH, cycles).k : null;
    const spare = c.ladderSpareAcres;

    // Stage D ladder gates (11.4); while one fails there is no CD need, so Auto cannot farm on dear types meanwhile.
    if (ph.ladder) {
      // The gates are entry checks: Farms and acres a CD Farm run holds mid-cycle are its own, not owned ones.
      const cf0 = ctx.mods?.cdFarm, inRun = !!(cf0 && (cf0.running || cf0.active));
      const held = lad.held, farmId0 = v.idB('Farm');
      const heldAll = held ? Object.values(held).reduce((a, n) => a + (n > 0 ? n : 0), 0) : 0;
      const farms = inRun && !held ? 0 : v.owned('Farm') - (held?.[farmId0] ?? 0);
      // Fail path (plan A2): the remaining Farms stay on Cotton and CD Farm burns Wooden Frames above the keep line instead
      if (ctx.retailFailPath) alerts.push('fail path: CD from Wooden Frames');
      else if (farms > 0) waits.push(farms + ' Farms owned: the ladder needs 0 (each one raises the next Farm price by $2.05)');
      const want = (batch ?? 1) + spare;
      if (!inRun && v.freeAcres + heldAll < want) waits.push('free acres ' + (v.freeAcres + heldAll) + ' < batch ' + (batch ?? '?') + ' + spare ' + spare);
      if (waits.length) { ph.need = false; ph.arm = false; }
      const units = lad.plan?.units ?? [];
      const farmId = v.idB('Farm');
      if (!ctx.retailFailPath && units.length && (!units.some((u) => u.b === farmId) || units.length > 2)) alerts.push('CD Farm plan is ' + units.map((u) => u.n + ' ' + u.name).join(' + ') + ', not Farm-only (or Farm + 1 type): check Farms owned and the Wooden Frame reserve');
    }
    if (ph.need !== undefined) out.cdNeed = ph.need;
    const need = ph.need || (ph.need === undefined ? out.nextUnlock : null);

    // T_wall from the measured CD rate and from the model rate (R4: the 600 cycles/h is a claim).
    const measured = lad.rates ? (lad.rates.cdh15 ?? lad.rates.cdhAll ?? null) : null;
    const model = out.rule?.cdPerHour ?? null;
    const readout = {
      phase: ph.key, need: need ? need.name + ' ' + fmt(need.cd) + ' CD (' + fmt(Math.max(0, need.cd - v.cd)) + ' to go)' : 'none',
      cdPerHour: { measured: measured == null ? null : Math.round(measured), model: model == null ? null : Math.round(model) },
      tWallHours: { measured: measured > 0 ? +(WALL_CD / measured).toFixed(1) : null, model: model > 0 ? +(WALL_CD / model).toFixed(1) : null },
      batch, alerts,
    };
    if (ph.why) waits.push(ph.why);

    const cf = ctx.mods?.cdFarm;
    if (!cf?.cfg) { waits.push('CD Farm is not loaded'); return { wait: waits.join('; '), readout }; }
    if (lad.gate) readout.auto = lad.gate;
    const m = ctx.mem(NAME).get();
    const fc = cf.cfg;
    const isAuto = fc.building === 'auto';
    // Manual Building: none of the ladder's settings apply (batch and reserveAcres steer manual runs too).
    if (!isAuto) { alerts.push('CD Farm Building is ' + fc.building + ', not Auto: Core plan leaves it as you set it'); return { wait: waits.join('; ') || undefined, readout }; }

    // Pause once per stage entry; if the user switches Auto on again in that stage, that is their call.
    if (ph.pause && fc.autoStart && m.paused !== ph.key) {
      const key = ph.key;
      return { wait: waits.join('; ') || undefined, readout, action: { id: 'ladder:pause:' + key, text: 'CD Farm: pause Auto (' + ph.why + ')',
        run: async () => { const ok = cf.pauseAuto(); ctx.mem(NAME).set({ paused: key, off: { why: 'ladder' } }); return ok ? true : null; } } };
    }

    // Plan step 1 tuning: 'fast' on the Stage D ladder (CD is worth full income there), cfg.ladderPace before.
    const want = { land: 'off', pace: ph.ladder ? c.ladderPaceD : c.ladderPace, reserveAcres: spare };
    // batch follows a noisy income slope: only move it by 2 or more, so tune actions do not flip back and forth.
    if (batch && !(typeof fc.batch === 'number' && Math.abs(batch - fc.batch) < 2)) want.batch = batch;
    // Farm-only: each extra type adds a Buy and a Demolish round trip. Not on the fail path: Farms stay on Cotton, CD comes from frames.
    if ((stage === 'D' || stage === 'END') && !ctx.retailFailPath) want.maxTypes = 1;
    const sid = lad.session, off = m.off;
    if (ph.arm && !fc.autoStart) {
      if (!off || (off.why === 'ladder' && m.paused !== ph.key)) want.autoStart = true;
      else if (off.why === 'user') alerts.push('Auto was switched off by you: Core plan does not switch it back on (switch it on in CD Farm)');
      else if (off.session !== sid) want.autoStart = true;   // Alt+Shift+X / its own error or dry-run stop: re-armed in a new Live session
      else alerts.push('Auto was switched off (' + (off.why === 'pause' ? 'Alt+Shift+X' : off.why === 'error' ? 'its own error stop' : off.why === 'dry' ? 'its dry run' : 'the Stage C pause') + '): Core plan switches it on again only after it resumes Live');
    }
    // A key CD Farm did not take (read back) is not sent again with the same value; other keys still go.
    const rej = m.rejected ?? {};
    const diff = {};
    for (const [k, x] of Object.entries(want)) {
      if (fc[k] === x) continue;
      if (Object.prototype.hasOwnProperty.call(rej, k) && rej[k] === x) { alerts.push('CD Farm did not take ' + k + ' ' + x + ' (read back after importCfg); not retried until the wanted value changes'); continue; }
      diff[k] = x;
    }
    const keys = Object.keys(diff).sort(), sig = keys.map((k) => k + '=' + diff[k]).join(',');
    readout.tune = keys.length ? diff : 'in sync';
    const phKey = ph.key;
    if (keys.length) {
      if (cf.running || cf.active) waits.push('settings wait for the CD Farm run to end (' + keys.join(', ') + ')');
      else {
        const text = 'CD Farm settings: ' + keys.map((k) => k + ' ' + diff[k]).join(', ');
        return { wait: waits.join('; ') || undefined, readout, action: { id: 'ladder:tune:' + sig, text,
          run: async () => {
            if (cf.running || cf.active) return null;   // a run started since decide: try again between runs
            try { cf.importCfg({ cfg: diff }); } catch { return null; }
            const bad = keys.filter((k) => cf.cfg[k] !== diff[k]);
            const mm = ctx.mem(NAME), r = { ...(mm.get().rejected ?? {}) };
            for (const k of keys) { if (bad.includes(k)) r[k] = diff[k]; else delete r[k]; }
            const patch = { rejected: r };
            if (diff.autoStart && !bad.includes('autoStart')) Object.assign(patch, { armed: phKey, off: null, onAt: ctx.now });
            mm.set(patch);
            return bad.length ? false : true;
          } } };
      }
    }
    if (ph.arm && !fc.autoStart && need) waits.push('Auto is off while ' + need.name + ' needs CD: switch it on in CD Farm');
    return { wait: waits.join('; ') || undefined, readout };
  }

  W.corePlan.addDirector({
    name: NAME, order: 60,
    defaults: {
      ladderPace: 'balanced',   // CD Farm pace before the Stage D ladder (balanced: bigger batches while the time saved pays)
      ladderPaceD: 'fast',      // CD Farm pace on the Stage D ladder (plan step 1: CD is worth full income there)
      ladderSpareAcres: 0,      // CD Farm reserveAcres: the land rule already keeps cfg.bufferAcres free for the batch itself
    },
    context, decide,
    duties: () => [{ duty: 'CD farm per stage: need, Auto tuning, Stage C pause, Stage D Farm ladder gates', owner: 'Core plan', done: true }],
  });
})();
} catch (e) { console.error('[IdleCorp] cp-ladder failed to load:', e); }
// @@END cp-ladder