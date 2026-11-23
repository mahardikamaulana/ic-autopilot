// continues the core-plan closure from core-plan-1.js (same try / IIFE)
  // ---- start and end conditions, stage ----------------------------------------------------------------------------------------
  const cond = (id, ok, why) => ({ id, ok, why });
  function startConditions(v, ctx) {
    const miss2 = S2_NEEDS.filter((n) => !v.unlocked(n));
    const s2 = cond('S2', !miss2.length, miss2.length ? 'not unlocked: ' + miss2.join(', ') : 'all unlocked');
    const need3 = [['Smelter', 'Roll Iron Sheet'], ['Workshop', 'Rivet Iron Frame'], ['Workshop', 'Frame Timber']].filter(([b, r]) => !v.running(b, r));
    const ifs = v.has('Iron Frame');
    const s3 = cond('S3', !need3.length && ifs >= 16, need3.length ? 'not running: ' + need3.map(([b, r]) => b + ' on ' + r).join(', ') : ifs < 16 ? 'Iron Frame stock ' + ifs + ' < 16' : 'running, Iron Frames ' + ifs);
    const lab = v.owned('Manufacturing Lab'), kiln = v.owned('Kiln'), mine = v.owned('Mine'), quarry = v.owned('Quarry');
    const s4 = cond('S4', lab >= 1 && kiln >= 1 && mine >= 1 && quarry >= 1, lab >= 1 && kiln >= 1 && mine >= 1 && quarry >= 1 ? 'built' : 'missing: ' + [['Manufacturing Lab', lab], ['Kiln', kiln], ['Mine', mine], ['Quarry', quarry]].filter(([, n]) => n < 1).map(([n]) => n).join(', '));
    const s1 = cond('S1', ctx.planDone === true || (s2.ok && s3.ok && s4.ok), ctx.planDone === true ? 'Autopilot: Plan done' : (s2.ok && s3.ok && s4.ok) ? 'S2-S4 hold' : 'Autopilot has not finished the Early-Game Plan, and S2-S4 do not all hold');
    const s5 = cond('S5', !v.unlocked('Assembly Plant'), v.unlocked('Assembly Plant') ? 'Assembly Plant is already unlocked (join at stage B or later)' : 'not unlocked yet');
    const c10 = ctx.cashDelta10;
    const s6 = cond('S6', c10 == null ? null : c10 > 0, c10 == null ? 'not enough cash samples yet (needs 10 min)' : 'money ' + (c10 > 0 ? 'rose ' : 'fell ') + usd(Math.abs(c10)) + ' over 10 min');
    const s7 = cond('S7', v.cottonBid, v.cottonBid ? 'Cotton bid in Heartland' : 'no Cotton bid in Heartland');
    return [s1, s2, s3, s4, s5, s6, s7];
  }
  function stageOf(v, S) {
    if (v.owned('Retail Store') >= 1) return 'D';
    if (v.unlocked('Assembly Plant')) return 'C';
    if (v.research && v.research.building === v.idB('Assembly Plant')) return 'B';
    const ok = S.filter((c) => c.id !== 'S5').every((c) => c.ok !== false);
    return ok && S[0].ok ? 'A' : null;
  }
  function landInput(v, ctx) {
    const o = (n) => v.owned(n);
    return { acres: v.acresOwned, acrePrice: v.nextAcreCents / 100, camps: o('Lumber Camp'), farms: o('Farm'), sawmills: o('Sawmill'), workshops: o('Workshop'),
      docks: 0, pastures: 0, fixedAcres: v.fixedAcres,
      // v.fixedAcres already holds a built Retail Store (3 acres) and Assembly Plant (5): only the unbuilt ones are extra
      fixedExtra: (v.owned('Retail Store') ? 0 : 3) + (v.owned('Assembly Plant') ? 0 : 5), cyclesPerHour: ctx.cyclesPerHour ?? cfg.cyclesPerHour, cdBufferAcres: cfg.bufferAcres };
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
  function e3Of(v, ctx) {
    const fail = !!ctx.retailFailPath, pre = fail ? 'fail path: ' : '';
    const no = (why) => cond('E3', false, pre + why);
    const lad = ctx.ladder ?? {}, fc = ctx.mods?.cdFarm?.cfg;
    const held = (n) => lad.held?.[v.idB(n)] ?? 0;   // units a CD Farm run holds mid-cycle are its own, not owned ones
    const farms = v.owned('Farm') - held('Farm'), wf = v.has('Wooden Frame');
    if (!fail && farms > 0) return no(farms + ' Farms owned');
    if (!fail && wf >= 20) return no('Wooden Frame stock ' + wf + ' >= 20');
    let keep = null;
    if (fail) {
      try { keep = W.corePlan._buildout?.wfKeep?.(v, ctx) ?? null; } catch {}
      if (keep == null) return no('Wooden Frame keep line unknown (build-out director not loaded)');
      if (wf > keep + 20) return no('Wooden Frame stock ' + wf + ' > keep line ' + keep + ' + 20');
    }
    if (!fc) return no('CD Farm is not loaded');
    if (fc.building !== 'auto') return no('CD Farm Building is ' + fc.building + ', not Auto');
    if (fail && !fc.autoStart) return no('CD Farm Auto is off');
    const units = lad.plan?.units ?? [];
    if (!units.length) return no('CD Farm plan not measured yet');
    if (!fail && !units.every((u) => u.b === v.idB('Farm'))) return no('CD Farm plan is ' + units.map((u) => u.n + ' ' + u.name).join(' + ') + ', not Farm-only');
    const income = lad.income > 0 ? lad.income / 100 : null, cycles = lad.rates?.cyclesh15 > 0 ? lad.rates.cyclesh15 : null;   // CD Farm measures cents/h
    if (!income || !cycles) return no('batch not measured yet (no ' + [!income && 'income', !cycles && 'cycles per hour'].filter(Boolean).join(' or ') + ')');
    const best = M.bestBatch('farm', 0, income, cycles).k;
    if (!(Math.abs(fc.batch - best) <= 1)) return no('CD Farm batch ' + fc.batch + ', measured best ' + best + ' (within 1)');
    return cond('E3', true, pre + (fail ? 'Auto on, frames ' + wf + ' <= keep line ' + keep + ' + 20, ' + units.map((u) => u.n + ' ' + u.name).join(' + ') + ' plan' : '0 Farms, frames ' + wf + ', Farm-only plan') + ', batch ' + fc.batch + ' (measured best ' + best + ')');
  }
  // E5 (plan C5): money >= 3 h of net income (cash trend over 60 min + CD Farm's spend in it), and nothing left to buy that pays back inside
  // T_wall/3: the land rule's acres and blocks plus what directors report (ctx.pendingInvest). Net income <= 0 does not pass.
  function e5Of(v, rule, ctx) {
    const inc = ctx.netIncomeH;   // cents per hour
    if (inc == null) return cond('E5', false, 'income not measured yet (needs 60 min of cash samples)');
    if (!(inc > 0)) return cond('E5', false, 'net income ' + usd(inc) + '/h is not positive');
    if (v.money < inc * 3) return cond('E5', false, 'money ' + usd(v.money) + ' < 3 h of net income ' + usd(inc * 3));
    const left = rule.acresToBuy ? [rule.acresToBuy + ' acres'] : [];
    for (const [k, n] of [['camps', 'Camps'], ['sawmills', 'Sawmills'], ['workshops', 'Workshops']]) if (rule.need[k]) left.push(rule.need[k] + ' ' + n);
    for (const p of ctx.pendingInvest ?? []) if (!(p.paybackH > rule.limitHours)) left.push(p.what);
    if (left.length) return cond('E5', false, 'still to buy: ' + left.join(', '));
    return cond('E5', true, 'money ' + usd(v.money) + ' >= 3 h of net income ' + usd(inc * 3) + ', nothing left to buy');
  }
  function endConditions(v, rule, ctx) {
    const retail = v.owned('Retail Store') >= 1;
    const e1 = cond('E1', retail && ctx.retailE1 === true, !retail ? 'Retail Store not built' : ctx.retailE1 === true ? 'selling 6 h in a row with the checkpoint rows passing' : ctx.retailOk === true ? 'checkpoint passed, not yet 6 h in a row' : ctx.retailOk === false ? 'retail checkpoint failed' : 'retail checkpoint not decided yet');
    const miss = UNLOCKS.filter((n) => !v.unlocked(n));
    const e2 = cond('E2', !miss.length, miss.length ? 'not unlocked: ' + miss.join(', ') : 'Assembly Plant, Retail Store and Oil Rig unlocked');
    const e3 = e3Of(v, ctx);
    // C4: T_wall from the measured CD rate when CD Farm has one, else the model (the readout says which)
    const tw = rule ? ' (T_wall ' + rule.tWall.toFixed(1) + ' h from the ' + rule.tWallFrom + ' CD rate)' : '';
    const e4 = rule ? cond('E4', v.acresOwned >= rule.lastAcre && v.freeAcres <= cfg.bufferAcres, (v.acresOwned < rule.lastAcre ? v.acresOwned + ' acres, rule closes at #' + rule.lastAcre : v.freeAcres > cfg.bufferAcres ? v.freeAcres + ' free acres, buffer ' + cfg.bufferAcres : 'rule closed, acres built') + tw)
      : cond('E4', false, 'land rule unavailable');
    const e5 = rule ? e5Of(v, rule, ctx) : cond('E5', false, 'land rule unavailable');
    return [e1, e2, e3, e4, e5];
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
    if (nx.name === 'Oil Rig' && ctx.retailOk !== true) return { wait: why + ': waits for the retail checkpoint' + (ctx.retailOk === false ? ' (failed: a new run measures the capped output)' : '') };   // only on a pass, of either run (plan D-2)
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
  // Stage A-B land: an acre plus a Cotton Farm while (acre + Farm) / hourly income <= cfg.landPaybackAB; one purchase per call.
  // block: why another use of the cash goes first (B1, B2).
  function landAction(v, stage, floorCents, block) {
    if (stage !== 'A' && stage !== 'B') return { wait: 'land: stage ' + stage + ' land is bought by the buildout director with its blocks' };
    if (block) return { wait: 'land: ' + block };
    if (!v.cottonGroup) return { wait: 'land: no running Cotton Farm group to add to' };
    if (v.acresOwned >= ACRE_CAP) return { wait: 'land: Heartland cap (' + ACRE_CAP + ' acres)' };
    const farm = v.idB('Farm'), farmCents = P.price(v.bld(farm).cost, v.owned('Farm'), 0);
    const needAcre = v.freeAcres - cfg.bufferAcres < 1;   // the CD farm's spare acres stay free
    const cost = farmCents + (needAcre ? v.nextAcreCents : 0);
    const payback = cost / 100 / cfg.cottonFarmHourly;
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
    directors.push(d); directors.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    for (const [k, val] of Object.entries({ ['dir_' + d.name]: true, ...(d.defaults ?? {}) })) { if (!(k in DEFAULTS)) { DEFAULTS[k] = val; cfg[k] = val; } }
    restore();
    return () => { const j = directors.indexOf(d); if (j >= 0) directors.splice(j, 1); };
  }

  // The whole decision, from a view: stage, S/E conditions, the land rule, what to send next (first action) and what it is waiting for.
  function decide(v, ctx = {}) {
    const S = startConditions(v, ctx);
    const stage = stageOf(v, S);
    for (const dir of directors) { try { dir.context?.(v, ctx, stage); } catch (e) { console.error('[corePlan] ' + dir.name + '.context', e); } }
    // After the directors' context: a failed retail checkpoint (ctx.retailFail) caps the planks at the furniture blocks sales carry (plan A2).
    let rule = null;
    try {
      const planksCap = ctx.retailFail && typeof ctx.retailCap === 'number' ? ctx.retailCap / M.engineModel(v.C).wsPerPlank : undefined;
      // C4: the measured CD rate sets T_wall once CD Farm has measured 30 min (landCdRate); the model before
      rule = M.landRule(landInput(v, ctx), v.C, { cyclesPerHour: ctx.cyclesPerHour ?? cfg.cyclesPerHour, planksCap, cdPerHour: landCdRate(ctx) ?? undefined });
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
    out._ifId = v.idI('Iron Frame'); out._ifNeed = ifNeed(v); out._wfId = v.idI('Wooden Frame'); out._plId = v.idI('Planks');
    out._failPath = !!ctx.retailFailPath;
    try { out._wfKeep = W.corePlan._buildout?.wfKeep?.(v, ctx) ?? null; } catch { out._wfKeep = null; }   // null: the reserve keeps every frame
    const ho = ctx.planDone === true ? handoffAction(v, ctx) : null;
    if (ho?.wait) out.waits.push(ho.wait); else if (ho) out.actions.push(ho);
    if (ctx.ap?.running && ctx.mem?.('handoff')?.get?.()?.stopped) out.readouts.handoff = { alert: 'Autopilot was started again after the hand-off: left running (it also sells and resumes groups)' };
    const u = unlockAction(v, ctx, out.nextUnlock);
    if (cfg.unlocks) { if (u.action) out.actions.push(u.action); else out.waits.push(u.wait); }
    let block = null;
    // B2 (wiki 11.1): Stage A, the next unlock waits on CD alone (it would start with the CD in hand): no cash into Cotton Farms
    if (stage === 'A' && !u.action && out.nextUnlock && unlockAction({ ...v, cd: Infinity }, ctx, out.nextUnlock).action) block = 'CD is the bottleneck: cash goes to the CD farm';
    // B1 (plan D-1): Stage B, a block buildout can buy now, or is saving cash for, goes before an acre + Cotton Farm
    if (stage === 'B' && cfg.dir_buildout !== false && W.corePlan._buildout?.nextBuildStep) {
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

