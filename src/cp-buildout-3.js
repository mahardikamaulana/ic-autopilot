// continues the cp-buildout closure from cp-buildout-2.js (same try / IIFE)
  // ---- the director --------------------------------------------------------------------------------------------------------------
  const conversionStage = (v) => v.unlocked('Assembly Plant');   // Stage C or D
  const dir = {
    name: 'buildout', order: 40, defaults: DEFAULTS,
    furnitureSplit, nextBuildStep, alloc: (v, ctx) => allocOf(v, ctx), stepBackStep: (v, ctx) => stepBackStep(v, ctx, engine(v, ctx)), targets: (v, ctx, rule) => targets(v, ctx, rule, engine(v, ctx)), benchHeld: (v, ctx, rule) => { const e = engine(v, ctx); return benchHeld(v, e, targets(v, ctx, rule, e)); }, rebalanceStep: (v, ctx) => rebalanceStep(v, ctx, engine(v, ctx)), waveState: (v, ctx) => waveState(v, ctx, engine(v, ctx)), allocate,
    waveStep: (v, ctx, rule, stage) => waveStep(v, ctx, engine(v, ctx), null, rule, stage), wfKeep: (v, ctx) => wfKeep(v, ctx ?? {}),
    waveGate: (v, ctx, rule, stage, n) => waveGate(v, ctx, engine(v, ctx), rule, stage, n),
    buyAction: (v, ctx, s) => buyAction(v, engine(v, ctx), s),
    // E5 (plan C5): the build-out is an investment still to make until it is at target, or its next block is past the land rule (closed).
    pendingInvest(v, ctx, rule, stage) {
      if (!rule || (stage !== 'B' && stage !== 'C' && stage !== 'D')) return [];
      const nb = nextBuildStep(v, ctx, rule, stage);
      return nb.done || nb.closed ? [] : [{ what: 'build-out (' + (nb.pick?.label ?? nb.wait) + ')', paybackH: null }];
    },
    context(v, ctx) {
      const cd = ctx.mods?.cdFarm;
      let units = {};
      try { units = cd?.farmUnits ?? {}; } catch {}
      ctx.boFarmUnits = units;
      ctx.boCdBusy = !!(cd && (cd.running || cd.active));
      if (!ctx.mem) return;
      const m = ctx.mem('buildout');
      // Storage check: write and read back through a fresh handle. Waves (which demolish Farms) need memory that survives; fail closed.
      m.set({ chk: ctx.now });
      ctx.boMemOk = ctx.mem('buildout').get().chk === ctx.now;
      // Groups it made that are gone drop out of groupsMine.
      const gm = m.get().groupsMine ?? [], gm2 = gm.filter((id) => v.groups.some((g) => g.id === id));
      if (gm2.length !== gm.length) m.set({ groupsMine: gm2 });
      // Units placed by hand leave the pool: what tidy may take back is never more than the pool holds.
      const pm = m.get().poolMine ?? {}, pm2 = Object.fromEntries(Object.entries(pm).map(([b, n]) => [b, Math.min(n, v.pool[b] ?? 0)]));
      if (Object.entries(pm).some(([b, n]) => pm2[b] !== n)) m.set({ poolMine: pm2 });
      // A Kiln this director paused that is running now was resumed by the user: hands off from then on.
      const kilnId = v.idB('Kiln');
      const mine = m.get().kilnMine ?? [];
      const resumed = mine.filter((id) => { const g = v.groups.find((x) => x.id === id); return !g || g.building !== kilnId || !g.paused; });
      if (resumed.length) m.set({ kilnMine: mine.filter((id) => !resumed.includes(id)), kilnUser: [...new Set([...(m.get().kilnUser ?? []), ...resumed])] });
      // Frame Timber the WF gate paused: one running again on Frame Timber was resumed by the user (hands off); one gone, emptied or
      // running on another recipe just drops out (a paused one on another recipe stays: ftStep resumes it).
      const ftR = v.idR('Assemble Wooden Frame'), ftMine = m.get().ftMine ?? [], ftKeep = [], ftUser = [];
      for (const id of ftMine) { const g = v.groups.find((x) => x.id === id); if (g && g.count > 0 && g.paused) ftKeep.push(id); else if (g && g.recipe === ftR) ftUser.push(id); }
      if (ftKeep.length !== ftMine.length) m.set({ ftMine: ftKeep, ...(ftUser.length ? { ftUser: [...new Set([...(m.get().ftUser ?? []), ...ftUser])] } : {}) });
      // (the rebalance hysteresis is noted in decide: the allocator needs the retail facts, which come after this context)
      const e = engine(v, ctx);
      if (e.missing) return;
      // Wave bookkeeping from state (right under chaos, dry run and reloads): base at the first Stage C look, a wave counts once the
      // cotton Farms are at or below its target, and its time is when that is first seen.
      if (!conversionStage(v)) return;
      const farms = cottonFarms(v, e);
      if (m.get().base == null) { if (farms > 0) m.set({ base: farms, wave: 0, at: null }); return; }
      const w = waveState(v, ctx, e);
      let k = w.wave;
      while (k < w.waves && farms <= w.targetAfter(k)) k++;
      if (k > w.wave) m.set({ wave: k, at: ctx.now });
    },
    decide(v, ctx, out) {
      const stage = out.stage;
      if (stage !== 'B' && stage !== 'C' && stage !== 'D') return { wait: 'waits for stage B (now ' + (stage ?? '-') + ')' };
      const e = engine(v, ctx);
      if (e.missing) return { wait: 'off: catalog lacks ' + e.missing.join(', ') };
      const rule = out.rule;
      const tg = rule ? targets(v, ctx, rule, e) : null;
      noteRebal(v, ctx, e);
      const al = allocOf(v, ctx, e);
      const readout = {
        camps: e.camps + '/' + (tg?.camps ?? '?'), sawmills: e.saws + '/' + (tg?.sawmills ?? '?'), workshops: e.workshops + '/' + (tg?.workshops ?? '?'),
        furniture: tg ? FURN.map(([k, n]) => n + ' ' + e.furnNow[k] + '/' + tg.furn[k]).join(', ') + ', Frame Timber ' + e.ftNow + '/' + tg.ft + ' (' + tg.source + ')' : null,
        plan: al ? usd(al.dollarsPerHour * 100) + '/h planned (' + al.detail + ')' + (al.burn ? ', burning Planks stock above ' + Math.round(al.reserve) + ' at +' + Math.round(al.extra) + '/h' : '') : null,
        planks: Math.round(e.planksSupply) + '/h made, ' + Math.round(e.planksDemand) + '/h used',
      };
      const never = ctx.ap?.neverSell;
      if (never && ['Wood', 'Planks', 'Bookshelf', 'Table', 'Chair'].some((n) => !never.includes(v.idI(n)))) readout.selling = 'hand-off pending: Autopilot may still sell Wood, Planks or furniture';
      const waits = [];
      const done = (action, extra) => ({ action, readout: { ...readout, ...extra, next: action.text } });
      const t1 = tidy(v, ctx, e, tg);
      if (t1) return done(t1);
      const k = kilnStep(v, ctx, e);
      readout.kiln = k.wait ?? k.action?.text;
      if (k.action) return done(k.action);
      const fs = ftStep(v, ctx, e);
      readout.frames = fs.wait ?? fs.action?.text;
      if (fs.action) return done(fs.action);
      // Furniture floors first (wiki 4.5: Workshop v1 = x5, scored live): a switch or a furniture Workshop needs its recipe's floor.
      const fl = floorStep(v, ctx, e, tg);
      if (fl?.action) return done(fl.action);
      if (fl?.wait) waits.push(fl.wait);
      // furniture over the plan steps back first: it eats Planks now (spare Frame Timber the switch parks may be paused already)
      const sb = stepBackStep(v, ctx, e);
      if (sb?.action) return done(sb.action);
      if (sb?.wait) waits.push(sb.wait);
      const sw = switchStep(v, ctx, e, tg);
      noteBlocked(v, ctx, e, sw);
      if (sw?.action) return done(sw.action);
      if (sw?.wait) waits.push(sw.wait);
      const rb = rebalanceStep(v, ctx, e);
      if (rb?.action) return done(rb.action);
      if (rb?.wait) waits.push(rb.wait);
      if (conversionStage(v)) {
        const ws = waveStep(v, ctx, e, tg, rule, stage);
        readout.waves = ws.status;
        if (ws.action) return done(ws.action);
        if (ws.wait) waits.push(ws.wait);
      } else readout.waves = 'Stage C: ' + cottonFarms(v, e) + ' cotton Farms to convert';
      const nb = nextBuildStep(v, { ...ctx, _boEngine: e, _boTargets: tg ?? undefined }, rule, stage);
      if (nb.pick) return done(track(v, ctx, nb.b, buyAction(v, e, nb)));
      waits.push('build-out: ' + nb.wait);
      readout.next = waits[waits.length - 1];
      return { wait: waits.join(' | '), readout };
    },
    duties: () => [
      { duty: 'Stage C-D land, engine build-out, Farm conversion', owner: 'Core plan', done: true },
      { duty: 'spare Frame Timber Workshops to furniture, Kiln Glass / Concrete gate, Wooden Frame gate', owner: 'Core plan', done: true },
    ],
  };
  cp.addDirector(dir);
  cp._buildout = dir;
})();
} catch (e) { console.error('[IdleCorp] cp-buildout failed to load:', e); }
// @@END cp-buildout
