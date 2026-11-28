// continues the core-plan closure from core-plan-1.js (same try / IIFE)
  // ---- start and end conditions, stage ----------------------------------------------------------------------------------------
  const cond = (id, ok, why) => ({ id, ok, why });
  // The plan's conditions (core.plans specs) against a view: the shared types plus Core plan's own (CP_TYPES), which read ctx, the land rule
  // and the start conditions.
  function planView(v, ctx, rule = null, S = null) {
    return {
      unlocked: (n) => v.unlocked(n), owned: (n) => v.owned(n), running: (b, r) => v.running(b, r), has: (n) => v.has(n),
      researching: (n) => { const b = v.idB(n); return b != null && (v.research?.building === b || (v.st.research_queue ?? []).some((q) => q?.building === b)); },
      get acresUsed() { return v.acresUsed; },
      types: CP_TYPES, v, ctx, rule, S,
    };
  }
  const CP_TYPES = {
    // S6: money rose over 10 min; unknown (null) with too few cash samples
    cashRising: (c, { ctx }) => { const c10 = ctx.cashDelta10; return [c10 == null ? null : c10 > 0, c10 == null ? 'not enough cash samples yet (needs 10 min)' : 'money ' + (c10 > 0 ? 'rose ' : 'fell ') + usd(Math.abs(c10)) + ' over 10 min']; },
    // S7: a Cotton bid in Heartland; unknown (null) while the market board is not loaded
    cottonBid: (c, { v }) => (!v.dealsLoaded ? [null, 'market board not loaded (open the Market page once)'] : [v.cottonBid, v.cottonBid ? 'Cotton bid in Heartland' : 'no Cotton bid in Heartland']),
    // Stage A: every start condition but `ignore` is not false (`strict` ones exactly true), and `gate` holds.
    // S6 unknown (too few cash samples) does not block; S7 unknown (Market never opened) does: a Cotton bid must be seen.
    startOk: (c, { S }) => { const ok = S.filter((x) => !c.ignore.includes(x.id)).every((x) => (c.strict.includes(x.id) ? x.ok === true : x.ok !== false)); return [ok && S.find((x) => x.id === c.gate).ok, '']; },
    // E1: a Retail Store sells hoursText in a row with the checkpoint rows passing
    retailSelling: (c, { v, ctx }) => { const retail = v.owned('Retail Store') >= 1; return [retail && ctx.retailE1 === true, !retail ? 'Retail Store not built' : ctx.retailE1 === true ? 'selling ' + c.hoursText + ' in a row with the checkpoint rows passing' : ctx.retailOk === true ? 'checkpoint passed, not yet ' + c.hoursText + ' in a row' : ctx.retailOk === false ? 'retail checkpoint failed' : 'retail checkpoint not decided yet']; },
    cdFarmCycle: (c, { v, ctx }) => e3Of(v, ctx, c),
    // E4: the land rule is closed and its acres built (C4: T_wall from the measured CD rate when CD Farm has one, else the model)
    landDone: (c, { v, rule }) => {
      if (!rule) return [false, 'land rule unavailable'];
      const tw = ' (T_wall ' + rule.tWall.toFixed(1) + ' h from the ' + rule.tWallFrom + ' CD rate)';
      return [v.acresOwned >= rule.lastAcre && v.freeAcres <= cfg.bufferAcres, (v.acresOwned < rule.lastAcre ? v.acresOwned + ' acres, rule closes at #' + rule.lastAcre : v.freeAcres > cfg.bufferAcres ? v.freeAcres + ' free acres, buffer ' + cfg.bufferAcres : 'rule closed, acres built') + tw];
    },
    cashInHand: (c, { v, ctx, rule }) => (rule ? e5Of(v, rule, ctx, c) : [false, 'land rule unavailable']),
  };
  // Start conditions (the preset's start list). A covers entry (S1) is worked out after the others: it holds at Plan done or when they hold,
  // and at Plan done they count as held too ("Autopilot: Plan done (...)"), except a keep entry whose recipe is not running.
  // Autopilot's Plan done stands for S2-S4: a corp that finished the early plan its own way still starts Stage A.
  function startConditions(v, ctx) {
    const a = planView(v, ctx);
    const S = PLAN.start.map((c) => (c.covers ? null : cond(c.id, ...core.plans.check(c, a))));
    PLAN.start.forEach((c, i) => {
      if (!c.covers) return;
      const cov = S.filter((x) => x && c.covers.includes(x.id)), all = cov.every((x) => x.ok), done = ctx.planDone === true;
      S[i] = cond(c.id, done || all, done ? c.doneWhy : all ? c.okWhy : c.noWhy);
      if (done) for (const x of cov) if (!x.ok && (!c.keep?.[x.id] || v.running(...c.keep[x.id]))) { x.ok = true; x.why = c.doneWhy + ' (' + x.why + ')'; }
    });
    return S;
  }
  // The stage: the last of the preset's stages whose condition holds; null when none does.
  function stageOf(v, S, ctx) {
    const a = planView(v, ctx, null, S), st = PLAN.stages;
    for (let i = st.length - 1; i >= 0; i--) if (core.plans.check(st[i].when, a)[0]) return st[i].id;
    return null;
  }
  function landInput(v, ctx) {
    const o = (n) => v.owned(n);
    return { acres: v.acresOwned, acrePrice: v.nextAcreCents / 100, camps: o('Lumber Camp'), farms: o('Farm'), sawmills: o('Sawmill'), workshops: o('Workshop'),
      docks: 0, pastures: 0, fixedAcres: v.fixedAcres,
      // v.fixedAcres already holds a built Retail Store (3 acres) and Assembly Plant (5): only the unbuilt ones are extra
      fixedExtra: PLAN.landRule.later.reduce((n, [b, a]) => n + (v.owned(b) ? 0 : a), 0), cyclesPerHour: ctx.cyclesPerHour ?? cfg.cyclesPerHour, cdBufferAcres: cfg.bufferAcres };
  }
  // Iron Frames (or `item`) the three unlocks still need (wiki 9): the prototype until its research starts, the first build until the building
  // stands. `except` is the building being bought now: its own first build is not kept back from itself.
  function ifNeed(v, except, item = 'Iron Frame') {
    const ifId = v.idI(item);
    if (ifId == null) return 0;
    const queued = (v.st.research_queue ?? []).map((q) => q.building);
    let n = 0;
    for (const name of UNLOCKS) {
      const b = v.idB(name);
      if (b == null) continue;
      const per = (v.bld(b).build_items ?? []).find((i) => i.item === ifId)?.amount ?? 0;
      if (!v.unlocked(name) && v.research?.building !== b && !queued.includes(b)) n += per;
      if (v.owned(name) === 0 && name !== except) n += per;
    }
    return n;
  }
  // E3 (plan C3): 0 Farms, Wooden Frames < 20, CD Farm on Auto with its batch within 1 of core-math bestBatch('farm', 0) at the measured
  // income and cycles (what the ladder tunes it to), and a Farm-only plan. Retail fail path: the Farms stay on Cotton (wiki 4.7), so Auto on,
  // frames at most the keep line + 20 (one free courier load) and the same batch check for the plan CD Farm runs.
  function e3Of(v, ctx, c) {
    const fail = !!ctx.retailFailPath, pre = fail ? 'fail path: ' : '';
    const no = (why) => [false, pre + why];
    const B = c.building, FR = c.frames, below = c.framesBelow, slack = c.failSlack;
    const lad = ctx.ladder ?? {}, fc = ctx.mods?.cdFarm?.cfg;
    const held = (n) => lad.held?.[v.idB(n)] ?? 0;   // units a CD Farm run holds mid-cycle are its own, not owned ones
    const farms = v.owned(B) - held(B), wf = v.has(FR);
    if (!fail && farms > 0) return no(farms + ' ' + B + 's owned');
    if (!fail && wf >= below) return no(FR + ' stock ' + wf + ' >= ' + below);
    let keep = null;
    if (fail) {
      try { keep = W.corePlan._buildout?.wfKeep?.(v, ctx) ?? null; } catch {}
      if (keep == null) return no(FR + ' keep line unknown (build-out director not loaded)');
      if (wf > keep + slack) return no(FR + ' stock ' + wf + ' > keep line ' + keep + ' + ' + slack);
    }
    if (!fc) return no('CD Farm is not loaded');
    if (fc.building !== 'auto') return no('CD Farm Building is ' + fc.building + ', not Auto');
    if (fail && !fc.autoStart) return no('CD Farm Auto is off');
    const units = lad.plan?.units ?? [];
    if (!units.length) return no('CD Farm plan not measured yet');
    if (!fail && !units.every((u) => u.b === v.idB(B))) return no('CD Farm plan is ' + units.map((u) => u.n + ' ' + u.name).join(' + ') + ', not ' + B + '-only');
    const income = lad.income > 0 ? lad.income / 100 : null, cycles = lad.rates?.cyclesh15 > 0 ? lad.rates.cyclesh15 : null;   // CD Farm measures cents/h
    if (!income || !cycles) return no('batch not measured yet (no ' + [!income && 'income', !cycles && 'cycles per hour'].filter(Boolean).join(' or ') + ')');
    const best = M.bestBatch(c.batchType, 0, income, cycles).k;
    if (!(Math.abs(fc.batch - best) <= c.batchWithin)) return no('CD Farm batch ' + fc.batch + ', measured best ' + best + ' (within ' + c.batchWithin + ')');
    return [true, pre + (fail ? 'Auto on, frames ' + wf + ' <= keep line ' + keep + ' + ' + slack + ', ' + units.map((u) => u.n + ' ' + u.name).join(' + ') + ' plan' : '0 ' + B + 's, frames ' + wf + ', ' + B + '-only plan') + ', batch ' + fc.batch + ' (measured best ' + best + ')'];
  }
  // E5 (plan C5): money >= 3 h of net income (cash trend over 60 min + CD Farm's spend in it), and nothing left to buy that pays back inside
  // T_wall/3: the land rule's acres and blocks plus what directors report (ctx.pendingInvest). Net income <= 0 does not pass.
  function e5Of(v, rule, ctx, c) {
    const inc = ctx.netIncomeH, h = c.hours;   // cents per hour
    if (inc == null) return [false, 'income not measured yet (needs 60 min of cash samples)'];
    if (!(inc > 0)) return [false, 'net income ' + usd(inc) + '/h is not positive'];
    if (v.money < inc * h) return [false, 'money ' + usd(v.money) + ' < ' + h + ' h of net income ' + usd(inc * h)];
    const left = rule.acresToBuy ? [rule.acresToBuy + ' acres'] : [];
    for (const [k, n] of [['camps', 'Camps'], ['sawmills', 'Sawmills'], ['workshops', 'Workshops']]) if (rule.need[k]) left.push(rule.need[k] + ' ' + n);
    for (const p of ctx.pendingInvest ?? []) if (!(p.paybackH > rule.limitHours)) left.push(p.what);
    if (left.length) return [false, 'still to buy: ' + left.join(', ')];
    return [true, 'money ' + usd(v.money) + ' >= ' + h + ' h of net income ' + usd(inc * h) + ', nothing left to buy'];
  }
  // End conditions (the preset's end list), in order.
  function endConditions(v, rule, ctx) {
    const a = planView(v, ctx, rule);
    return PLAN.end.map((c) => cond(c.id, ...core.plans.check(c, a)));
  }

  // ---- directors ------------------------------------------------------------------------------------------------------------------------
  // Next unlock Core plan owns, with what is still missing. null when all three are in.
  function nextUnlock(v) {
    for (const n of UNLOCKS) {
      if (v.unlocked(n)) continue;
      const b = v.idB(n), tech = v.N.techs.find((t) => t.building === b);
      const out = { b, name: n, cd: tech?.cost ?? 0, prereqsMet: true, note: '', tech };
      if (!tech) { out.prereqsMet = false; out.note = 'not in the tech tree'; return out; }
      if (tech.requires != null && !v.st.unlocked_buildings?.includes(tech.requires) && v.C.buildings[tech.requires]?.name !== 'Lumber Camp') { out.prereqsMet = false; out.note = 'needs ' + (v.C.buildings[tech.requires]?.name ?? 'building ' + tech.requires) + ' first'; }
      return out;
    }
    return null;
  }
  function unlockAction(v, ctx, nx) {
    if (!nx) return { wait: 'all three unlocks are in' };
    const why = 'unlock ' + nx.name;
    if (PLAN.unlockGates?.[nx.name] === 'retailCheckpoint' && ctx.retailOk !== true) return { wait: why + ': waits for the retail checkpoint' + (ctx.retailOk === false ? (ctx.retailFail ? ' (failed: a new run measures the capped output)' : ' (failed with no unsold stock, so no cap: a new run checks again)') : '') };   // only on a pass, of either run (plan D-2)
    if (ctx.apNextTech) return { wait: why + ': Autopilot still owns "' + ctx.apNextTech.name + '"' };
    if (!nx.prereqsMet) return { wait: why + ': ' + nx.note };
    if (v.research) return { wait: why + ': research slot busy' };
    if (v.cd < nx.cd) return { wait: why + ': ' + Math.floor(v.cd) + ' / ' + nx.cd + ' CD' };
    const proto = v.bld(nx.b).build_items ?? [];
    const lack = proto.filter((i) => (v.st.stock?.[REGION]?.[i.item] ?? v.st.items?.[i.item] ?? 0) < i.amount);
    if (lack.length) return { wait: why + ': need ' + lack.map((i) => Math.ceil(i.amount - (v.st.stock?.[REGION]?.[i.item] ?? v.st.items?.[i.item] ?? 0)) + ' more ' + (v.C.items[i.item]?.name ?? 'item ' + i.item)).join(', ') };
    return { action: { id: 'tech:' + nx.b, text: why + ' (' + nx.cd + ' CD' + (proto.length ? ' + ' + proto.map((i) => i.amount + ' ' + (v.C.items[i.item]?.name ?? i.item)).join(', ') : '') + ')',
      steps: [{ msg: { type: 'StartTech', building: nx.b, region: REGION }, until: (x) => x.research?.building === nx.b || x.unlocked(nx.name) }] } };
  }
  // Dollars per hour one Cotton Farm earns: the best Heartland Cotton bid x a Farm's output (runs per building from the live group's
  // work row), else cfg.cottonFarmHourly.
  function cottonHourly(v) {
    const rc = v.C.recipes[v.idR('Grow Cotton')], w = v.cottonGroup?.work?.find((x) => x.recipe === rc?.id);
    if (!v.cottonUnit || !rc?.ticks || !(w?.buildings > 0 && w.runs > 0)) return cfg.cottonFarmHourly;
    return v.cottonUnit * w.runs / w.buildings * (rc.outputs?.[0]?.amount ?? 1) * 7200 / rc.ticks / 100;
  }
  // Stage A-B land: an acre plus a Cotton Farm while (acre + Farm) / hourly income <= cfg.landPaybackAB; one purchase per call.
  // block: why another use of the cash goes first (B1, B2).
  function landAction(v, stage, floorCents, block) {
    if (!PLAN.land.stages.includes(stage)) return { wait: 'land: stage ' + stage + ' land is bought by the buildout director with its blocks' };
    if (block) return { wait: 'land: ' + block };
    if (!v.cottonGroup) return { wait: 'land: no running Cotton Farm group to add to' };
    if (v.acresOwned >= ACRE_CAP) return { wait: 'land: Heartland cap (' + ACRE_CAP + ' acres)' };
    const farm = v.idB('Farm'), farmCents = P.price(v.bld(farm).cost, v.ownedAll('Farm'), 0);
    const needAcre = v.freeAcres - cfg.bufferAcres < 1;   // the CD farm's spare acres stay free
    const cost = farmCents + (needAcre ? v.nextAcreCents : 0);
    const payback = cost / 100 / cottonHourly(v);
    const line = (needAcre ? 'acre #' + (v.acresOwned + 1) + ' ' + usd(v.nextAcreCents) + ' + ' : '') + 'Cotton Farm ' + usd(farmCents) + ', payback ' + payback.toFixed(1) + ' h';
    if (payback > cfg.landPaybackAB) return { wait: 'land: ' + line + ' > ' + cfg.landPaybackAB + ' h, rule closed' };
    if (v.money - cost < floorCents) return { wait: 'land: ' + line + ': need ' + usd(floorCents + cost - v.money) + ' more above the floor' };
    const g = v.cottonGroup, c0 = g.count, p0 = v.pool[farm] ?? 0, l0 = v.landBought;
    const steps = [];
    if (needAcre) steps.push({ msg: { type: 'BuyLand', amount: 1, region: REGION }, until: (x) => x.landBought >= l0 + 1 });
    steps.push({ msg: { type: 'BuyBuilding', building: farm, amount: 1, region: REGION }, until: (x) => (x.pool[farm] ?? 0) >= p0 + 1 });
    steps.push({ msg: { type: 'AssignBuildings', group: g.id, amount: 1 }, until: (x) => (x.groups.find((y) => y.id === g.id)?.count ?? 0) >= c0 + 1 });
    return { action: { id: 'land:' + (v.acresOwned + 1), text: 'buy ' + line, steps, hold: true } };
  }
  function handoffAction(v, ctx) {
    if (!cfg.handoff || !ctx.ap) return null;
    const ids = ENGINE_ITEMS.map((n) => v.idI(n)).filter((i) => i != null);
    const never = ctx.ap.neverSell ?? [];
    const lacking = ids.filter((i) => !never.includes(i));
    if (!lacking.length && ctx.ap.cdBooster === false) {
      // Then stop Autopilot (plan D-4), only once Core plan resumes bill-paused groups (D7), and only once: a restart by the user is left alone.
      const m = ctx.mem?.('handoff');
      if (!m || m.get().stopped || cfg.handoffStopAutopilot === false) return null;
      if (!directors.some((d) => d.name === 'resume') || cfg.dir_resume === false) return null;
      // Autopilot also raises the power subscription: it keeps running until Auto utilities power has that job (plan D1).
      if (ctx.mods?.autoUtil?.conf?.power?.on !== true) return { wait: 'hand-off: Autopilot keeps running until Auto utilities power is on (it raises the power subscription)' };
      // "Stopped once" lives in browser storage: a write must read back through a fresh handle, or a user restart would be stopped again.
      const t = ctx.now ?? Date.now();
      m.set({ chk: t });
      if (ctx.mem('handoff').get().chk !== t) return { wait: 'hand-off: Autopilot keeps running: browser storage does not save, so its stop could not be kept to once' };
      const on = !!ctx.ap.running;   // not running: only recorded, so a later start by the user is not stopped either
      return { id: 'handoff:stop', text: on ? 'hand-off: stop Autopilot (Core plan resumes bill-paused groups now)' : 'hand-off: Autopilot is not running; recorded (a later start is left alone)',
        run: async () => {
          if (on && !W.earlyGame?.stop) return false;
          m.set({ stopped: t });
          if (ctx.mem('handoff').get().stopped !== t) return false;   // recorded first: no stop that is not remembered
          if (on) W.earlyGame.stop();
          return true;
        } };
    }
    return { id: 'handoff', text: 'hand-off: ' + (lacking.length ? lacking.length + ' engine items to Autopilot neverSell' : '') + (ctx.ap.cdBooster !== false ? (lacking.length ? ', ' : '') + 'CD booster off' : ''),
      patch: { neverSell: ids, cdBooster: false } };
  }

  // ---- plug-in directors (steps 5-10 live in their own files: src/cp-*.js) ------------------------------------------------
  // A director is { name, order, always?, defaults?, context?(v, ctx), decide(v, ctx, out) -> { action?, actions?, wait?, readout? }, duties?() }.
  //   always: it also decides when no stage holds (out.stage null).
  //   whenOff(v, ctx, out): decides instead of decide while cfg.dir_<name> is false (endgame: resume what its gate paused).
  //   context(v, ctx, stage): adds facts to ctx before any director decides (e.g. the retail sampler sets ctx.retailOk).
  //   decide: pure; an action is { id, text, steps: [{ msg, until(view) }], hold? } or { id, text, run: async () => true|false|null }.
  //   defaults: cfg keys (validated and saved like the built-in ones). ctx.mem(name) is a small saved object per director.
  //   pendingInvest(v, ctx, rule, stage) -> [{ what, paybackH }]: purchases it still plans; E5 waits while one pays back inside T_wall/3 (null = counts).
  const directors = [];
  function addDirector(d) {
    if (!d?.name || typeof d.decide !== 'function') throw new Error('addDirector: name and decide() are required');
    const i = directors.findIndex((x) => x.name === d.name);
    if (i >= 0) directors.splice(i, 1);
    // The preset orders its directors and says which start off; a director it does not name runs at its own order (default 50), on.
    const ord = (x) => PLAN.directors?.[x.name]?.order ?? x.order ?? 50;
    directors.push(d); directors.sort((a, b) => ord(a) - ord(b));
    for (const [k, val] of Object.entries({ ['dir_' + d.name]: PLAN.directors?.[d.name]?.on ?? true, ...(d.defaults ?? {}) })) { if (!(k in DEFAULTS)) { DEFAULTS[k] = val; cfg[k] = val; } }
    restore();
    return () => { const j = directors.indexOf(d); if (j >= 0) directors.splice(j, 1); };
  }

  // The whole decision, from a view: stage, S/E conditions, the land rule, what to send next (first action) and what it is waiting for.
  function decide(v, ctx = {}) {
    const S = startConditions(v, ctx);
    const stage = stageOf(v, S, ctx);
    for (const dir of directors) { try { dir.context?.(v, ctx, stage); } catch (e) { console.error('[corePlan] ' + dir.name + '.context', e); } }
    // After the directors' context: a failed retail checkpoint (ctx.retailFail) caps the planks at the furniture blocks sales carry (plan A2).
    let rule = null;
    try {
      // The engine is sized to demand too: planks the shelves can sell (appetite x share, from the retail facts), and on a fail the measured cap.
      const caps = [ctx.retail?.demandPlanksH > 0 ? ctx.retail.demandPlanksH : null, ctx.retailFail && typeof ctx.retailCap === 'number' ? ctx.retailCap / M.engineModel(v.C).wsPerPlank : null].filter((x) => typeof x === 'number');
      const planksCap = caps.length ? Math.min(...caps) : undefined;
      // C4: the measured CD rate sets T_wall once CD Farm has measured 30 min (landCdRate); the model before
      rule = M.landRule(landInput(v, ctx), v.C, { wallCd: PLAN.landRule.wallCd, batchType: PLAN.landRule.batchType, limitDivisor: PLAN.landRule.limitDivisor, cyclesPerHour: ctx.cyclesPerHour ?? cfg.cyclesPerHour, planksCap, cdPerHour: landCdRate(ctx) ?? undefined });
    } catch (e) { console.error(e); }
    ctx.pendingInvest = [];
    for (const dir of directors) {
      if (!dir.pendingInvest || cfg['dir_' + dir.name] === false) continue;
      try { ctx.pendingInvest.push(...(dir.pendingInvest(v, ctx, rule, stage) ?? [])); } catch (e) { console.error('[corePlan] ' + dir.name + '.pendingInvest', e); }
    }
    const E = endConditions(v, rule, ctx);
    const out = { stage, S, E, rule, actions: [], waits: [], nextUnlock: null, finished: stage === 'D' && E.every((c) => c.ok), readouts: {} };
    if (out.finished) out.stage = 'END';
    if (!stage) { out.waits.push('stage: start conditions do not hold (' + S.filter((c) => c.ok === false).map((c) => c.id + ': ' + c.why).join('; ') + ')'); return decideDirectors(v, ctx, out, true); }
    out.nextUnlock = nextUnlock(v);
    out._ifId = v.idI('Iron Frame'); out._ifNeed = ifNeed(v); out._wfId = v.idI('Wooden Frame'); out._keepIds = PLAN.reserve.items.map((n) => v.idI(n));
    out._failPath = !!ctx.retailFailPath;
    try { out._wfKeep = W.corePlan._buildout?.wfKeep?.(v, ctx) ?? null; } catch { out._wfKeep = null; }   // null: the reserve keeps every frame
    const ho = ctx.planDone === true ? handoffAction(v, ctx) : null;
    if (ho?.wait) out.waits.push(ho.wait); else if (ho) out.actions.push(ho);
    if (ctx.ap?.running && ctx.mem?.('handoff')?.get?.()?.stopped) out.readouts.handoff = { alert: 'Autopilot was started again after the hand-off: left running (it also sells and resumes groups)' };
    const u = unlockAction(v, ctx, out.nextUnlock);
    if (cfg.unlocks) { if (u.action) out.actions.push(u.action); else out.waits.push(u.wait); }
    let block = null;
    // B2 (wiki 11.1): Stage A, the next unlock waits on CD alone (it would start with the CD in hand): no cash into Cotton Farms
    if (stage === PLAN.land.cdBlock && !u.action && out.nextUnlock && unlockAction({ ...v, cd: Infinity }, ctx, out.nextUnlock).action) block = 'CD is the bottleneck: cash goes to the CD farm';
    // B1 (plan D-1): Stage B, a block buildout can buy now, or is saving cash for, goes before an acre + Cotton Farm
    if (stage === PLAN.land.buildoutBlock && cfg.dir_buildout !== false && W.corePlan._buildout?.nextBuildStep) {
      try { const nb = W.corePlan._buildout.nextBuildStep(v, ctx, rule, stage); if (nb?.pick) block = 'build-out goes first (' + nb.why + ')'; else if (nb?.saving) block = 'build-out is saving for ' + nb.saving; } catch (e) { console.error('[corePlan] buildout.nextBuildStep', e); }
    }
    if (cfg.land) { const l = landAction(v, stage, ctx.floorCents ?? 0, block); if (l.action) out.actions.push(l.action); else out.waits.push(l.wait); }
    return decideDirectors(v, ctx, out, false);
  }
  // CD rate for the land rule: CD Farm's 15-min rate, kept in mem one sample per 30 s. Only after 30 min of samples with no gap over
  // 5 min (a null rate or a stop breaks it), as the mean of the last 30 min, so a short dip does not move the land rule. Else null (the model).
  function landCdRate(ctx) {
    const m = ctx.mem?.('landRate'), r = ctx.ladder?.rates?.cdh15, t = ctx.now;
    if (!m || t == null) return null;
    let { since = null, s = [] } = m.get();
    if (!(r > 0)) { if (since != null) m.set({ since: null, s: [] }); return null; }
    if (!s.length || t - s[s.length - 1].t > 300000) { since = t; s = []; }
    if (!s.length || t - s[s.length - 1].t >= 30000) { s = [...s, { t, r }].filter((x) => t - x.t <= 1800000); m.set({ since, s }); }
    return t - since >= 1800000 ? s.reduce((a, x) => a + x.r, 0) / s.length : null;
  }
  // Directors in order; with no stage only those marked always (D7 resume) decide.
  function decideDirectors(v, ctx, out, noStage) {
    for (const dir of directors) {
      if (noStage && !dir.always) continue;
      const off = cfg['dir_' + dir.name] === false;
      if (off) { out.waits.push(dir.name + ': off'); if (!dir.whenOff) continue; }
      let r = null;
      try { r = (off ? dir.whenOff : dir.decide)(v, ctx, out); } catch (e) { console.error('[corePlan] ' + dir.name, e); out.waits.push(dir.name + ': error ' + (e.message ?? e)); continue; }
      if (!r) continue;
      for (const a of [...(r.actions ?? []), ...(r.action ? [r.action] : [])]) out.actions.push({ ...a, director: dir.name });
      if (r.wait) out.waits.push(dir.name + ': ' + r.wait);
      if (r.readout !== undefined) out.readouts[dir.name] = r.readout;
    }
    return out;
  }

