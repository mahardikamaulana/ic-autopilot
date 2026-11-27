// continues the cp-buildout closure from cp-buildout-1.js (same try / IIFE)
  // ---- actions (one message, or one purchase with hold) ---------------------------------------------------------------------------
  const groupById = (x, id) => x.groups.find((g) => g.id === id);
  function assignAction(v, b, g, n, why) {
    const c0 = g.count;
    return { id: 'bo:assign:' + g.id, text: why + ': assign ' + n + ' ' + v.bld(b).name + ' to group ' + g.id + (g.name ? ' (' + g.name + ')' : ''),
      steps: [{ msg: { type: 'AssignBuildings', group: g.id, amount: n }, until: (x) => (groupById(x, g.id)?.count ?? 0) >= c0 + n }] };
  }
  function createAction(v, b, n, name, why) {
    const ids = new Set(v.groups.map((g) => g.id));
    return { id: 'bo:create:' + b + ':' + name, text: why + ': new group "' + name + '" with ' + n + ' ' + v.bld(b).name,
      steps: [{ msg: { type: 'CreateGroup', building: b, amount: n, name, region: REGION }, until: (x) => x.groups.some((g) => !ids.has(g.id) && g.building === b && g.count >= n) }] };
  }
  function recipeAction(v, g, r, why) {
    return { id: 'bo:recipe:' + g.id + ':' + r.id, text: why + ': group ' + g.id + ' (' + g.count + ' ' + v.bld(g.building).name + ') to ' + r.name,
      steps: [{ msg: { type: 'SetRecipe', group: g.id, recipe: r.id }, until: (x) => groupById(x, g.id)?.recipe === r.id }] };
  }
  function pauseAction(v, g, paused, why) {
    return { id: 'bo:pause:' + g.id + ':' + paused, text: why + ': ' + (paused ? 'pause' : 'resume') + ' group ' + g.id + ' (' + (v.C.recipes[g.recipe]?.name ?? 'no recipe') + ')',
      steps: [{ msg: { type: 'SetPaused', group: g.id, paused }, until: (x) => !!groupById(x, g.id)?.paused === paused }] };
  }
  // Group a building of type b on recipe r goes into: the biggest one on that recipe (a paused furniture group is the user's: never).
  // A group made by CreateGroup has no recipe until SetRecipe lands; it counts by its name, so a second Workshop joins it instead of a new group.
  const homeGroup = (e, b, r) => e.groupsOf(b, r).filter((g) => !g.paused || !FURN.some(([k]) => e.R[k].id === r.id)).sort((a, c) => c.count - a.count)[0]
    ?? e.groupsOf(b).filter((g) => g.recipe == null && g.name === r.name).sort((a, c) => c.count - a.count)[0] ?? null;
  // Where a Workshop from the pool goes: a wanted Bench that is ready (as the buy path, Bench first), else the biggest furniture gap that has its floor and that the spare planks feed, else Frame Timber.
  // With the allocator (running furniture only): a gap that has held cfg.planHoldMin; Frame Timber only while it is below its target; else
  // null, the Workshop stays parked in the pool (plan B2 step back).
  // Same checks as the switch, so a Workshop the switch freed is never sent back to Frame Timber while the switch still wants it.
  function poolWorkshopRecipe(v, ctx, e, tg, n) {
    if (tg && tg.bench > e.benchNow && !benchHeld(v, e, tg)) return e.R.bench;
    const furnTotal = FURN.reduce((a, [k]) => a + e.furnNow[k], 0);
    const al = allocOf(v, ctx, e);
    const want = al ? al.byKey : failKeep(ctx, tg ? tg.furn : furnitureSplit(ctx.retailBoard, 0, v.C).alloc(furnTotal + n));
    const headroom = planksRoom(v, ctx, e);
    const cur = al ? e.furnRun : e.furnNow;
    const gaps = FURN.map(([k]) => ({ k, gap: want[k] - cur[k] })).filter((x) => x.gap > 0).sort((a, b) => b.gap - a.gap);
    const ok = gaps.find((x) => !floorMissing(e, e.R[x.k]) && headroom + 1e-9 >= e.wsPlanksH(e.R[x.k]));
    if (al && ok) return holdFor(ctx, 'pool', true) ? e.R[ok.k] : null;
    if (al) holdFor(ctx, 'pool', false);
    return ok ? e.R[ok.k] : !al || e.ftNow < (tg?.ft ?? cfg.keepFrameTimber) ? e.R.ft : null;
  }

  // Ownership memory, like kilnMine: units this director left in the pool (mem poolMine { building: n }: + on a confirmed BuyBuilding or
  // UnassignBuildings, - on AssignBuildings / CreateGroup) and the groups it made (groupsMine). Each step records once.
  function track(v, ctx, b, a) {
    const ids = new Set(v.groups.map((g) => g.id));
    for (const st of a.steps) {
      const t = st.msg?.type, n = st.msg?.amount ?? 1, u = st.until;
      const sign = t === 'BuyBuilding' || t === 'UnassignBuildings' ? 1 : t === 'AssignBuildings' || t === 'CreateGroup' ? -1 : 0;
      if (!sign) continue;
      let seen = false;
      st.until = (x) => {
        const ok = u(x), m = ctx.mem?.('buildout');
        if (ok && !seen && m) {
          seen = true;
          const pm = { ...(m.get().poolMine ?? {}) }, patch = { poolMine: pm };
          pm[b] = Math.max(0, (pm[b] ?? 0) + sign * n);
          if (t === 'CreateGroup') patch.groupsMine = [...new Set([...(m.get().groupsMine ?? []), ...x.groups.filter((g) => !ids.has(g.id) && g.building === b).map((g) => g.id)])];
          m.set(patch);
        }
        return ok;
      };
    }
    return a;
  }
  // A plan group of engine building bn: made here, on a plan recipe, or without one but named after a plan recipe (how groups are named here).
  function planGroupOf(v, e, bn, mineG) {
    const b = v.idB(bn), pr = (bn === 'Lumber Camp' ? [e.R.wood] : bn === 'Sawmill' ? [e.R.planks] : [e.R.ft, e.R.rivet, e.R.bookshelf, e.R.table, e.R.chair, e.R.bench]).filter(Boolean);
    return (g) => mineG.has(g.id) || pr.some((r) => r.id === g.recipe || (g.recipe == null && r.name === g.name && r.building === b));
  }
  // 1. Pool tidy: own engine buildings sitting in the pool, and engine groups without a recipe. Pooled units are taken only when this
  // director left them there, or no group outside the plan uses that building (then nobody else is waiting to place them).
  // Pooled units of bn tidy may take (the wave gate waits on the same count).
  function poolTake(v, ctx, e, bn) {
    const mm = ctx.mem?.('buildout')?.get?.() ?? {}, b = v.idB(bn), plan = planGroupOf(v, e, bn, new Set(mm.groupsMine ?? []));
    return v.groups.some((g) => g.building === b && g.count > 0 && !plan(g)) ? Math.min(e.ownPool(b), mm.poolMine?.[b] ?? 0) : e.ownPool(b);
  }
  function tidy(v, ctx, e, tg) {
    const mineG = new Set(ctx.mem?.('buildout')?.get?.()?.groupsMine ?? []);
    for (const bn of ENGINE) {
      const b = v.idB(bn);
      if (bn === 'Lumber Camp' && ctx.boCdBusy) continue;            // a CD run may be cycling Camps through the pool
      const n = poolTake(v, ctx, e, bn);
      if (!n) continue;
      let r = bn === 'Lumber Camp' ? e.R.wood : bn === 'Sawmill' ? e.R.planks : null;
      if (bn === 'Workshop') { r = poolWorkshopRecipe(v, ctx, e, tg, n); if (!r) continue; }   // parked: the plan has no gap for it
      const g = homeGroup(e, b, r);
      // into a running group the draw starts at once: only with the power free (asked of Auto utilities first), as the switch
      if (bn === 'Workshop' && g?.work?.length && powerFor(v, ctx, v.bld(b).draws?.power ?? 0) < (v.bld(b).draws?.power ?? 0)) continue;
      const k = bn === 'Workshop' ? 1 : n;                            // Workshops one at a time: each goes where the split is shortest
      return track(v, ctx, b, g ? assignAction(v, b, g, k, 'pool') : createAction(v, b, k, r.name, 'pool'));
    }
    for (const bn of ENGINE) {
      const b = v.idB(bn), plan = planGroupOf(v, e, bn, mineG);
      const named = (g) => Object.values(v.C.recipes).find((r) => r.building === b && r.name === g.name);
      // Workshops: only a plan group (a user's recipe-less Workshop group waits for the user)
      const g = v.groups.find((x) => x.building === b && x.count > 0 && (x.recipe == null || !v.C.recipes[x.recipe]) && (bn !== 'Workshop' || plan(x)));
      if (!g) continue;
      const r = named(g) ?? (bn === 'Lumber Camp' ? e.R.wood : bn === 'Sawmill' ? e.R.planks : (tg ? nextWorkshopRecipe(e, tg)?.r : null) ?? e.R.ft);
      return recipeAction(v, g, r, 'new group');
    }
    return null;
  }

  const confirmed = (a, fn) => { const u = a.steps[0].until; a.steps[0].until = (x) => { const ok = u(x); if (ok) fn(); return ok; }; return a; };
  // 2. Kiln stock gate: Glass >= glassGate and Concrete >= concreteGate, then pause.
  // Only Kilns this director paused are resumed (ids in mem kilnMine, written when the pause is confirmed); a Kiln the user resumed after
  // that is left alone for good (kilnUser, from context()). A resume also needs the bill floor and the money floor for its draw.
  function kilnStep(v, ctx, e) {
    const kilns = e.groupsOf(e.id.kiln).filter((g) => g.count > 0);
    if (!kilns.length) return { wait: 'no Kiln group' };
    const km = ctx.mem?.('buildout')?.get?.() ?? {};
    const mine = new Set(km.kilnMine ?? []), user = new Set(km.kilnUser ?? []);
    const note = (gid, add) => () => {   // runs when the server confirms the pause / resume
      const m = ctx.mem?.('buildout'); if (!m) return;
      const s = new Set(m.get().kilnMine ?? []);
      if (add) s.add(gid); else s.delete(gid);
      m.set({ kilnMine: [...s] });
    };
    const manual = [];
    // + 48 h of Bench use while a Bench group exists, and already while one is wanted: the Kiln is the only Concrete source, so a gate
    // that stopped at concreteGate would keep the Bench's own Concrete gate from ever opening.
    const benchN = Math.max(e.benchNow, benchWanted(v, ctx, e) ? Math.max(0, cfg.benchWorkshops) : 0);
    const cGate = cfg.concreteGate + (benchN > 0 ? Math.ceil(e.benchConcreteH(benchN) * BENCH_HOURS) : 0);
    const want = { [e.R.glass.id]: v.has('Glass') < cfg.glassGate, [e.R.concrete.id]: v.has('Concrete') < cGate };
    const making = (rid) => kilns.some((g) => !g.paused && g.recipe === rid);
    for (const g of kilns) {
      if (user.has(g.id)) continue;
      const low = want[g.recipe];
      if (g.paused && low) {
        if (!mine.has(g.id)) { manual.push('manual: Kiln group ' + g.id + ' is paused (not by Core plan): resume it for ' + v.C.recipes[g.recipe].name); continue; }
        const mw = (v.bld(g.building).draws?.power ?? 0) * g.count, bill = cp._billNeed(v, mw), floor = ctx.floorCents ?? 0;
        if (v.money < floor + bill) return { wait: 'Kiln gate: resume group ' + g.id + ' waits: cash ' + usd(v.money) + ' < ' + usd(floor + bill) + ' (money floor + ' + mw + ' MW bills)' };
        return { action: confirmed(pauseAction(v, g, false, 'Kiln gate (' + v.C.recipes[g.recipe].name + ' below its gate)'), note(g.id, false)) };
      }
      if (!g.paused && low === false) {
        const other = [e.R.glass, e.R.concrete].find((r) => r.id !== g.recipe && want[r.id] && !making(r.id));
        if (other) return { action: recipeAction(v, g, other, 'Kiln gate (' + other.name + ' below its gate)') };
        return { action: confirmed(pauseAction(v, g, true, 'Kiln gate reached'), note(g.id, true)) };
      }
      if (g.paused && low === false && mine.has(g.id)) {
        const other = [e.R.glass, e.R.concrete].find((r) => want[r.id] && !making(r.id));
        if (other) return { action: recipeAction(v, g, other, 'Kiln gate (' + other.name + ' below its gate)') };
      }
    }
    return { wait: (manual.length ? manual.join('; ') + '; ' : '') + 'Glass ' + Math.floor(v.has('Glass')) + '/' + cfg.glassGate + ', Concrete ' + Math.floor(v.has('Concrete')) + '/' + cGate + (cGate > cfg.concreteGate ? ' (gate ' + cfg.concreteGate + ' + 48 h of Bench use)' : '') };
  }

  // Wooden Frame keep line (plan D-3): what the running Rivet Workshops eat in cfg.ftKeepHours, plus the frames the unlocks' prototypes and
  // first builds still need (corePlan ifNeed), at most cfg.ftKeepMax (E3: stock < 20). Buildout never buys Mines or Quarries, so their 4 frames each are not in it.
  function wfKeep(v, ctx = {}, e = engine(v, ctx)) {
    if (e.missing) return null;
    const rivetH = e.sum(e.groupsOf(e.id.ws, e.R.rivet).filter((g) => !g.paused)) * runsH(e.R.rivet, e.rateNow(e.R.rivet)) * amt(e.R.rivet.inputs, v.idI('Wooden Frame'));
    return Math.min(cfg.ftKeepMax, Math.ceil(rivetH * cfg.ftKeepHours) + cp._ifNeed(v, null, 'Wooden Frame'));
  }
  // Frames need no more Frame Timber: at or above the keep line, or while the gate holds one of its groups paused (until below half).
  // Then the switch targets the best $ per Workshop-hour and the board rebalance stands down (plan A2).
  function valueMode(v, ctx, e) {
    const wk = wfKeep(v, ctx, e), mine = new Set(ctx.mem?.('buildout')?.get?.()?.ftMine ?? []);
    return (wk > 0 && v.has('Wooden Frame') >= wk) || v.groups.some((g) => mine.has(g.id) && g.paused && g.recipe === e.R.ft.id && g.count > 0);
  }
  // 2b. Wooden Frame gate: pause Frame Timber at or above the keep line, resume below half of it (planks above the line are worth more as
  // furniture, wiki 11.4). It pauses at most cfg.keepFrameTimber Workshops (plan A2): Frame Timber above that goes to furniture through the
  // switch. Only when the switch has been blocked (planks, kit, floor, cap, power) for cfg.ftBlockedMin minutes (mem ftBlockedSince) does
  // it pause the extra too; the switch moves them later. Kiln-gate bookkeeping: only groups paused here come back (mem ftMine), one the
  // user resumed is left alone (ftUser, from context()); a paused group moved off Frame Timber is resumed at once.
  function ftStep(v, ctx, e) {
    const keep = wfKeep(v, ctx, e), wf = v.has('Wooden Frame');
    const km = ctx.mem?.('buildout')?.get?.() ?? {};
    const mine = new Set(km.ftMine ?? []), user = new Set(km.ftUser ?? []);
    const note = (gid, add) => () => {   // runs when the server confirms the pause / resume
      const m = ctx.mem?.('buildout'); if (!m) return;
      const s = new Set(m.get().ftMine ?? []);
      if (add) s.add(gid); else s.delete(gid);
      m.set({ ftMine: [...s] });
    };
    const line = 'Wooden Frame ' + Math.floor(wf) + ', keep line ' + keep;
    const paused = v.groups.filter((g) => mine.has(g.id) && g.paused && g.count > 0);
    // a paused group the switch or the retail fail path moved off Frame Timber comes back at once
    const back = paused.find((g) => g.recipe !== e.R.ft.id) ?? (wf < keep / 2 ? paused[0] : null);
    if (back) {
      const mw = (v.bld(back.building).draws?.power ?? 0) * back.count, bill = cp._billNeed(v, mw), floor = ctx.floorCents ?? 0;
      if (v.money < floor + bill) return { wait: 'WF gate: resume group ' + back.id + ' waits: cash ' + usd(v.money) + ' < ' + usd(floor + bill) + ' (money floor + ' + mw + ' MW bills)' };
      return { action: confirmed(pauseAction(v, back, false, 'Wooden Frame gate (' + line + ')'), note(back.id, false)) };
    }
    if (!(keep > 0) || wf < keep) return { wait: line };
    if (!ctx.boMemOk) return { wait: line + ': Frame Timber not paused, browser storage does not save (a pause it forgets would starve Rivet)' };
    const since = km.ftBlockedSince, blocked = since != null && (ctx.now ?? Date.now()) - since >= cfg.ftBlockedMin * 60000;
    const room = blocked ? Infinity : cfg.keepFrameTimber - e.sum(paused.filter((x) => x.recipe === e.R.ft.id));
    const run = e.groupsOf(e.id.ws, e.R.ft).filter((x) => !x.paused && x.count > 0 && !user.has(x.id));
    const g = run.find((x) => x.count <= room);
    if (!g) return { wait: line + (run.length ? ' (Frame Timber above the ' + cfg.keepFrameTimber + ' kept goes to furniture, not paused)' : '') };
    return { action: confirmed(pauseAction(v, g, true, 'Wooden Frame gate (' + line + ')' + (blocked && g.count > cfg.keepFrameTimber ? ': the switch has been blocked ' + cfg.ftBlockedMin + ' min' : '')), note(g.id, true)) };
  }

  // 3. Spare Frame Timber Workshops to furniture (Stage B on), keeping cfg.keepFrameTimber (and the Rivet group, never touched).
  // EditLayout for each furniture recipe without a floor that something will run soon: Workshops already on it, spare Frame Timber to
  // switch, or the buy path's next Workshop. A recipe with Workshops on it: Autopilot owns the upgrade while it sends live with floor
  // upgrades on; otherwise the added parts for every building must be in stock (net of other modules' reserves), as Autopilot's
  // floorBlock asks. A recipe with none costs nothing. After an EditLayout the server did not apply, floors wait cfg.floorRetryMin.
  const pieceBom = (v, cells) => {   // parts per building: each piece's materials, null when the catalog has no floor pieces
    const pieces = v.N.pieces ?? {};
    if (!Object.keys(pieces).length) return null;
    const out = {};
    for (const c of Object.values(cells)) for (const m of pieces[c.item]?.materials ?? []) out[m.item] = (out[m.item] ?? 0) + m.amount;
    return out;
  };
  function floorStep(v, ctx, e, tg) {
    if (!cfg.applyFurnitureFloor || !cfg.needFurnitureFloor) return null;
    const nx = tg ? nextWorkshopRecipe(e, tg) : null;
    const soon = (k) => e.furnNow[k] > 0 || e.ftNow > cfg.keepFrameTimber || nx?.r?.id === e.R[k].id;
    const want = FURN.filter(([k]) => floorMissing(e, e.R[k]) && soon(k)).map(([k]) => ({ r: e.R[k], n: e.furnNow[k], design: 'workshopV1', label: 'Workshop v1 floor (x5)' }));
    // Bench, while wanted: the Rivet x3 floor goes on before its Workshop is assigned (or on Benches already running without one).
    if (e.R.bench && tg?.bench > 0 && floorMissing(e, e.R.bench)) want.push({ r: e.R.bench, n: e.benchNow, design: 'rivetX3', label: 'Rivet x3 floor' });
    if (!want.length) return null;
    const ap = ctx.mods?.earlyGame, apFloors = !!(ap && ap.busy && ap.cfg?.floorUpgrades !== false);
    const waits = [];
    for (const { r, n, design, label } of want) {
      const obj = cp._floorObj(design);
      if (!obj) { waits.push('floors: no ' + label + ' design in the core'); continue; }
      if (n > 0 && apFloors) { waits.push('floors: Autopilot applies the ' + r.name + ' floor upgrade while it runs live'); continue; }
      if (n > 0) {
        const bom = pieceBom(v, obj);
        if (!bom) { waits.push('floors: ' + r.name + ': the catalog has no floor pieces, parts for its ' + n + ' Workshop(s) cannot be checked'); continue; }
        const cur = Object.fromEntries((v.bld(e.id.ws).default_kit ?? []).map((i) => [i.item, i.amount]));
        const st = v.st.stock?.[REGION] ?? {}, items = v.st.items ?? {}, res = ctx.reserveItems ?? {};
        const lack = Object.entries(bom).map(([i, a]) => [i, Math.max(0, a - (cur[i] ?? 0)) * n - Math.max(0, (st[i] ?? items[i] ?? 0) - (res[i] ?? 0))]).filter(([, d]) => d > 0);
        if (lack.length) { waits.push('floors: ' + r.name + ' (' + n + ' Workshops) waits for parts: ' + lack.map(([i, d]) => Math.ceil(d) + ' more ' + (v.C.items[i]?.name ?? 'item ' + i)).join(', ')); continue; }
      }
      const f = cp._floorAction(ctx, 'buildout', 'floors', r, obj, 'floors: the server did not apply the last floor', { id: 'floor:' + r.id, text: 'apply the ' + label + ' to ' + r.name + (n > 0 ? ' (' + n + ' Workshops pay the added parts)' : '') });
      if (f.action) return f;
      waits.push(f.wait);
    }
    return { wait: [...new Set(waits)].join('; ') };   // the shared retry wait is the same for every floor
  }

  // MW free now for a move that adds `mw` of draw at once (store included, contracts counted). Short of it, Core plan asks Auto utilities for
  // the draw (live only, autoUtil.ask) and the move waits until the raise has landed: the store is served last, so a move ahead of the raise
  // darkens it (plan R-5). Infinity without Auto utilities loaded (no power model to ask).
  function powerFor(v, ctx, mw) {
    const au = ctx.mods?.autoUtil;
    if (!au?._measure) return Infinity;
    const free = Math.max(0, au._measure('power', REGION, v.st, v.catalog, ctx.tick ?? 0, ctx.contracts ?? []).free ?? 0);
    if (free + 1e-9 < mw && ctx.live) au.ask?.('power', REGION, mw, ctx.tick ?? 0);
    return free;
  }
  // Frame Timber groups this director may move, biggest first: not one the user paused, nor one the user resumed after the WF gate paused it.
  function movableFt(ctx, e) {
    const km = ctx.mem?.('buildout')?.get?.() ?? {}, mine = new Set(km.ftMine ?? []), user = new Set(km.ftUser ?? []);
    return e.groupsOf(e.id.ws, e.R.ft).filter((g) => g.count > 0 && (!g.paused || mine.has(g.id)) && !user.has(g.id)).sort((a, b) => b.count - a.count);
  }
  // mem ftBlockedSince: when the switch first waited with Frame Timber above the kept Workshops while frames are not needed (ftStep pauses
  // the extra after cfg.ftBlockedMin); cleared once the switch moves or has nothing to move.
  function noteBlocked(v, ctx, e, sw) {
    const m = ctx.mem?.('buildout');
    if (!m) return;
    const blocked = !sw?.action && !!sw?.wait && valueMode(v, ctx, e), since = m.get().ftBlockedSince ?? null;
    if (blocked && since == null) m.set({ ftBlockedSince: ctx.now ?? Date.now() });
    else if (!blocked && since != null) m.set({ ftBlockedSince: null });
  }
  function switchStep(v, ctx, e, tg) {
    // Keep only the reserve here: the retail cap already limits n, and extra Frame Timber for leftover planks is the purchase path's job.
    const keep = cfg.keepFrameTimber;
    const fts = movableFt(ctx, e);
    const spare = e.sum(fts) - keep;
    if (spare <= 0) return null;
    const al = allocOf(v, ctx, e), split = al ? null : tg?.split ?? furnitureSplit(ctx.retailBoard, 0, v.C);
    const cur = al ? e.furnRun : e.furnNow, furnTotal = FURN.reduce((a, [k]) => a + cur[k], 0);
    const cap = typeof ctx.retailCap === 'number' ? Math.max(0, Math.floor(ctx.retailCap)) : Infinity;
    const n = Math.min(furnTotal + spare, cap);
    if (n <= furnTotal) return { wait: 'switch: furniture at the retail cap (' + cap + '), spare Frame Timber stays' };
    // Target (plan B3): the allocator's largest gap. Without it: the board split; while Wooden Frames are at the keep line (the WF gate
    // would idle them, plan A2) the good with the best $ per Workshop-hour that has a floor (the first that fits below). A measured fail:
    // never above the per-good keep the fail path cuts to.
    const val = !al && valueMode(v, ctx, e) ? furnValue(v, ctx, e) : null;
    const want = al ? al.byKey : failKeep(ctx, val ? Object.fromEntries(FURN.map(([k]) => [k, Infinity])) : split.alloc(n));
    // with the allocator only its net gain of furniture Workshops (a good under the plan while another is over waits for the rebalance)
    const net = al ? FURN.reduce((a, [k]) => a + want[k] - cur[k], 0) : Infinity;
    // Spare Frame Timber the plan has no use for (Planks bind: it plans fewer furniture Workshops) goes to the pool once that has held
    // cfg.planHoldMin, parked: no draw, no Planks, which the plan counted as free; the pool tidy places them once the plan has a gap. Never
    // while a furniture recipe lacks its floor (the plan cannot see that good yet), nor on a measured retail fail (its fail path keeps the
    // surplus on Frame Timber).
    const noFloorAll = FURN.filter(([k]) => floorMissing(e, e.R[k])).map(([k]) => e.R[k].name);
    const surplus = al && !ctx.retailFail && !noFloorAll.length ? spare - Math.max(0, net) : 0, pk = fts[0], park = Math.min(surplus, pk.count - (fts.length === 1 ? keep : 0));
    if (al && holdFor(ctx, 'park', park > 0)) {
      const c0 = pk.count;
      return { action: track(v, ctx, e.id.ws, { id: 'bo:park:' + pk.id + ':' + c0, text: 'switch: park ' + park + ' spare Frame Timber Workshop(s) of group ' + pk.id + ' in the pool (the plan has no Planks for them: ' + al.detail + ')',
        steps: [{ msg: { type: 'UnassignBuildings', group: pk.id, amount: park }, until: (x) => (groupById(x, pk.id)?.count ?? 0) <= c0 - park }] }) };
    }
    const gaps = FURN.map(([k]) => ({ k, gap: Math.min(want[k] - cur[k], n - furnTotal, net) })).filter((x) => x.gap > 0).sort((a, b) => (val ? val[b.k] - val[a.k] : 0) || b.gap - a.gap);
    if (!gaps.length) return al && noFloorAll.length && !cfg.applyFurnitureFloor ? { wait: 'switch: manual: apply the v1 floor for ' + noFloorAll.join(', ') + ' (furniture Workshops wait for it)' } : null;
    // Planks cap: a switch may not push plank use past what the Sawmills make plus the stock budget (a Bookshelf eats more than Frame Timber).
    const headroom = planksRoom(v, ctx, e), ftUse = al && fts[0].paused ? 0 : e.wsPlanksH(e.R.ft);
    const why = al ? 'allocator: ' + al.binding : val ? 'best $ per Workshop-hour' : split.source;
    const fits = (k) => { const d = e.wsPlanksH(e.R[k]) - ftUse; return d <= 0 ? Infinity : Math.floor((headroom + 1e-9) / d); };
    // Skip recipes without a saved floor: the switch moves what it can now and asks for the floor of the rest.
    const noFloor = gaps.filter((x) => floorMissing(e, e.R[x.k]));
    const pickGap = gaps.find((x) => fits(x.k) > 0 && !floorMissing(e, e.R[x.k]));
    if (!pickGap && noFloor.length) return { wait: 'switch: manual: apply the v1 floor for ' + noFloor.map((x) => e.R[x.k].name).join(', ') + ' (furniture Workshops wait for it)' };
    if (!pickGap) return { wait: 'switch: planks ' + Math.round(e.planksSupply) + '/h made, ' + Math.round(e.planksDemand) + '/h used: more Sawmills before more furniture' };
    const { k } = pickGap, r = e.R[k], gap = Math.min(pickGap.gap, fits(k));
    const room = Math.min(gap, spare);
    const whole = fts.filter((g) => g.count <= room).sort((a, b) => b.count - a.count)[0];
    const kit = (cnt) => short(v, e.kitOf(e.id.ws, r).filter((x) => !(v.bld(e.id.ws).build_items ?? []).includes(x)), cnt);
    if (whole) {
      const lack = kit(whole.count);
      if (lack.length) return { wait: 'switch: kit short for ' + whole.count + ' x ' + r.name + ': ' + lack.join(', ') };
      return { action: filled(ctx, whole.id, recipeAction(v, whole, r, 'switch spare Frame Timber to furniture (' + why + ')')) };
    }
    const g = fts[0], home = homeGroup(e, e.id.ws, r);
    let take = Math.min(room, g.count - (fts.length === 1 ? keep : 0));
    if (take <= 0) return null;
    // Power (fix 6): the engine draws by building count for a group with work rows, so moving Workshops from a group that draws nothing
    // into one that runs adds their draw at once, and the store, powered last, goes dark. Move only what the free power (plus what
    // Auto utilities can raise now) carries. A whole group's recipe change or a new group starts only once the engine has the power.
    const perB = v.bld(e.id.ws).draws?.power ?? 0, adds = perB > 0 && home?.work?.length > 0 && !(g.work?.length > 0);
    if (adds) {
      const pw = powerFor(v, ctx, take * perB);
      take = Math.min(take, Math.floor(pw / perB + 1e-9));
      if (take <= 0) return { wait: 'switch: waits for power (' + Math.max(0, Math.floor(pw)) + ' MW free for ' + perB + ' MW a Workshop; asked Auto utilities)' };
    }
    const lack = kit(take);
    if (lack.length) return { wait: 'switch: kit short for ' + take + ' x ' + r.name + ': ' + lack.join(', ') };
    const c0 = g.count;
    // One action: free the Workshops and put them straight on r, so the pool tidy never has to guess the recipe the switch chose.
    const ids = new Set(v.groups.map((x) => x.id));
    const place = home
      ? { msg: { type: 'AssignBuildings', group: home.id, amount: take }, until: ((h0) => (x) => (groupById(x, home.id)?.count ?? 0) >= h0 + take)(home.count) }
      : { msg: { type: 'CreateGroup', building: e.id.ws, amount: take, name: r.name, region: REGION }, until: (x) => x.groups.some((y) => !ids.has(y.id) && y.building === e.id.ws && y.count >= take) };
    return { action: filled(ctx, home?.id, track(v, ctx, e.id.ws, { id: 'bo:split:' + g.id, text: 'switch spare Frame Timber to furniture (' + why + '): move ' + take + ' Workshop(s) from group ' + g.id + ' to ' + r.name + (home ? ' (group ' + home.id + ')' : ' (new group)'),
      steps: [{ msg: { type: 'UnassignBuildings', group: g.id, amount: take }, until: (x) => (groupById(x, g.id)?.count ?? 0) <= c0 - take }, place] })) };
  }

  // 3b. Furniture rebalance (wiki 4.7 step 3, plan D3): today's furniture Workshops against the board's split of the same total.
  // Gap per recipe (+ under, - over); none without a board (the 40/30/30 default is no reason to move a Workshop).
  function furnGaps(v, ctx, e) {
    const al = allocOf(v, ctx, e);
    if (al) return Object.fromEntries(FURN.map(([k]) => [k, al.byKey[k] - e.furnRun[k]]));
    const split = furnitureSplit(ctx.retailBoard, 0, v.C);
    if (split.source !== 'board') return null;
    const want = split.alloc(FURN.reduce((a, [k]) => a + e.furnNow[k], 0));
    return Object.fromEntries(FURN.map(([k]) => [k, want[k] - e.furnNow[k]]));
  }
  const modCount = (g) => Object.values(g.modules ?? {}).filter((m) => (m != null && typeof m === 'object' ? m.id : m) != null).length;
  // One move per step, once an over and an under recipe have each held their gap cfg.rebalanceHours (mem rebal, written by context()):
  // UnassignBuildings 1 from the over group with the fewest modules, then into the under recipe's group. The under recipe needs its floor,
  // its kit and the plank headroom for the swap. Never on the retail fail path: its per-good caps rule then.
  function rebalanceStep(v, ctx, e) {
    // not on the fail path (its per-good caps rule), nor while the switch targets the best $ per Workshop-hour (it would undo it)
    // with the allocator the plan already holds the best $ per Workshop-hour (and its 3% move gain): it does not stand down in value mode
    const al = allocOf(v, ctx, e), gaps = ctx.retailFail || (!al && valueMode(v, ctx, e)) ? null : furnGaps(v, ctx, e);
    if (!gaps) return null;
    const keys = FURN.map(([k]) => k).filter((k) => gaps[k]);
    if (!keys.some((k) => gaps[k] > 0) || !keys.some((k) => gaps[k] < 0)) return null;
    const seen = ctx.mem?.('buildout')?.get?.()?.rebal ?? {}, now = ctx.now ?? Date.now(), holdMs = Math.max(0, cfg.rebalanceHours) * HOUR;
    const ready = (k) => seen[k]?.dir === (gaps[k] > 0 ? 'under' : 'over') && now - seen[k].at >= holdMs;
    const line = keys.map((k) => e.R[k].name + ' ' + (gaps[k] > 0 ? '+' : '') + gaps[k]).join(', ');
    const under = keys.filter((k) => gaps[k] > 0 && ready(k)).sort((a, b) => gaps[b] - gaps[a]);
    const over = keys.filter((k) => gaps[k] < 0 && ready(k)).sort((a, b) => gaps[a] - gaps[b]);
    if (!under.length || !over.length) return { wait: 'rebalance: ' + line + ' (moves once held ' + cfg.rebalanceHours + ' h)' };
    const headroom = planksRoom(v, ctx, e), why = [];
    for (const to of under) {
      const r = e.R[to];
      if (floorMissing(e, r)) { why.push(r.name + ' has no floor'); continue; }
      const lack = short(v, e.kitOf(e.id.ws, r).filter((x) => !(v.bld(e.id.ws).build_items ?? []).includes(x)));
      if (lack.length) { why.push(r.name + ' kit short: ' + lack.join(', ')); continue; }
      for (const from of over) {
        if (e.wsPlanksH(r) - e.wsPlanksH(e.R[from]) > headroom + 1e-9) { why.push('planks cannot feed ' + e.R[from].name + ' -> ' + r.name); continue; }
        const g = e.groupsOf(e.id.ws, e.R[from]).filter((x) => x.count > 0 && !x.paused).sort((a, b) => modCount(a) - modCount(b) || b.count - a.count)[0];
        if (!g) continue;
        const c0 = g.count, home = homeGroup(e, e.id.ws, r), ids = new Set(v.groups.map((x) => x.id));
        const place = home
          ? { msg: { type: 'AssignBuildings', group: home.id, amount: 1 }, until: ((h0) => (x) => (groupById(x, home.id)?.count ?? 0) >= h0 + 1)(home.count) }
          : { msg: { type: 'CreateGroup', building: e.id.ws, amount: 1, name: r.name, region: REGION }, until: (x) => x.groups.some((y) => !ids.has(y.id) && y.building === e.id.ws) };
        return { action: track(v, ctx, e.id.ws, { id: 'bo:rebal:' + g.id, text: 'rebalance furniture to the ' + (al ? 'allocator plan' : 'board') + ' (' + line + '): move 1 Workshop from group ' + g.id + ' (' + e.R[from].name + ') to ' + r.name + (home ? ' (group ' + home.id + ')' : ' (new group)'),
          steps: [{ msg: { type: 'UnassignBuildings', group: g.id, amount: 1 }, until: (x) => (groupById(x, g.id)?.count ?? 0) <= c0 - 1 }, place] }) };
      }
    }
    return { wait: 'rebalance: ' + line + ' waits: ' + why.join('; ') };
  }
  // Rebalance hysteresis (plan D3): per recipe, the direction of its gap to the plan and when that was first seen (mem rebal).
  function noteRebal(v, ctx, e) {
    const m = ctx.mem?.('buildout'), gaps = m ? furnGaps(v, ctx, e) : null;   // no plan or board: the times are kept as they are
    if (!gaps) return;
    const old = m.get().rebal ?? {}, rebal = {};
    for (const [k, g] of Object.entries(gaps)) if (g) { const dir = g > 0 ? 'under' : 'over'; rebal[k] = old[k]?.dir === dir ? old[k] : { dir, at: ctx.now }; }
    if (JSON.stringify(rebal) !== JSON.stringify(old)) m.set({ rebal });
  }
  // mem filled: furniture groups a switch filled, most recent last (the step back takes from the newest first, plan B2).
  function filled(ctx, gid, a) {
    if (gid == null || !ctx.mem) return a;
    const st = a.steps[a.steps.length - 1], u = st.until;
    st.until = (x) => { const ok = u(x); if (ok) { const m = ctx.mem('buildout'); m.set({ filled: [...(m.get().filled ?? []).filter((id) => id !== gid), gid].slice(-20) }); } return ok; };
    return a;
  }
  // 3c. Step back (plan B2): furniture Workshops above the plan's total (the Planks stock budget ended, a demand cap) go to the pool one
  // per step, off a good over its plan (a good under it is the rebalance's, after its hold), from the group a switch filled most recently
  // first, once the excess has held cfg.planHoldMin; never from a paused group. They stay parked there (no draw, no Planks) until the plan has a gap: in the paused Frame Timber group
  // the WF gate's half-line resume would wake them all.
  function stepBackStep(v, ctx, e) {
    const al = allocOf(v, ctx, e);
    if (!al || ctx.retailFail) return null;   // a measured retail fail: its fail path cuts the excess to Frame Timber in one action
    const gap = (k) => al.byKey[k] - e.furnRun[k];
    const excess = -FURN.reduce((a, [k]) => a + gap(k), 0);
    if (!holdFor(ctx, 'stepback', excess > 0)) return excess > 0 ? { wait: 'step back: ' + excess + ' furniture Workshop(s) over the plan, moves once that holds ' + cfg.planHoldMin + ' min' } : null;
    const over = new Set(FURN.filter(([k]) => gap(k) < 0).map(([k]) => e.R[k].id));
    const src = v.groups.filter((g) => g.building === e.id.ws && g.count > 0 && !g.paused && over.has(g.recipe));
    const recent = [...(ctx.mem?.('buildout')?.get?.()?.filled ?? [])].reverse();
    const g = recent.map((id) => src.find((x) => x.id === id)).find(Boolean) ?? [...src].sort((a, b) => modCount(a) - modCount(b) || a.count - b.count)[0];
    const line = 'step back: ' + excess + ' furniture Workshop(s) over the plan (' + al.detail + ')';
    if (!g) return { wait: line + ', all in paused groups (left alone)' };
    const c0 = g.count;
    return { action: track(v, ctx, e.id.ws, { id: 'bo:stepback:' + g.id + ':' + c0, text: line + ': 1 Workshop from group ' + g.id + ' (' + v.C.recipes[g.recipe].name + ') to the pool, parked until the plan has a gap',
      steps: [{ msg: { type: 'UnassignBuildings', group: g.id, amount: 1 }, until: (x) => (groupById(x, g.id)?.count ?? 0) <= c0 - 1 }] }) };
  }

  // 4. Farm conversion waves. Wave memory lives in ctx.mem('buildout'): base (Farms at the first Stage C look), wave, at (ms).
  const cottonFarms = (v, e) => e.sum(e.groupsOf(e.id.farm, e.R.cotton));
  function waveState(v, ctx, e) {
    const m = ctx.mem?.('buildout')?.get?.() ?? {};
    const base = m.base ?? cottonFarms(v, e), waves = Math.max(1, cfg.conversionWaves);
    const size = Math.ceil(base / waves);
    return { base, waves, size, wave: m.wave ?? 0, at: m.at ?? null, farms: cottonFarms(v, e), targetAfter: (k) => Math.max(0, base - (k + 1) * size) };
  }
  function blocksRunning(v, ctx, e) {
    const ftHeld = new Set(ctx.mem?.('buildout')?.get?.()?.ftMine ?? []);   // paused by the WF gate on purpose
    for (const bn of ENGINE) {
      const b = v.idB(bn);
      if (poolTake(v, ctx, e, bn) > 0 && !(bn === 'Workshop' && allocOf(v, ctx, e))) return v.bld(b).name + ' in the pool';   // Workshops the plan parked do not hold a wave
      const g = v.groups.find((x) => x.building === b && x.count > 0 && !ftHeld.has(x.id) && (x.paused || (x.equipped ?? x.count) < x.count));
      if (g) return 'group ' + g.id + ' (' + (g.name ?? v.bld(b).name) + ') ' + (g.paused ? 'paused' : 'equipped ' + g.equipped + '/' + g.count);
    }
    return null;
  }
  // Before a wave: the first buildings for the freed acres must pass the build gates (kit, wood, bill floor, money floor) as if the acres
  // were free now, and stock (kits) and cash must cover cfg.waveCashAhead of them (plan step 5: bill floor and
  // kit gate first). Otherwise the Farms would go with nothing to rebuild the acres.
  function waveGate(v, ctx, e, rule, stage, n) {
    const freed = n * (v.bld(e.id.farm).acres || 1);
    const s = nextBuildStep({ ...v, freeAcres: v.freeAcres + freed }, { ...ctx, _boEngine: e, _boNoCash: true }, rule, stage);
    if (!s.pick) return { wait: 'nothing can be built on the ' + freed + ' freed acres yet (' + s.wait + ')' };
    const bd = v.bld(s.b), blocks = Math.max(1, Math.floor(freed / (bd.acres || 1)));
    const ahead = Math.max(1, Math.min(blocks, cfg.waveCashAhead));
    const lack = short(v, e.kitOf(s.b, s.pick.r), ahead);
    if (lack.length) return { wait: 'kit short for ' + ahead + ' x ' + s.pick.label + ': ' + lack.join(', ') };
    let cost = 0;
    for (let i = 0; i < ahead; i++) cost += W.idleCore.planner.price(bd.cost, v.ownedAll(s.pick.bn), i);
    const bill = cp._billNeed(v, (bd.draws?.power ?? 0) * ahead), floor = ctx.floorCents ?? 0;
    if (v.money - cost < floor + bill) return { wait: 'cash ' + usd(v.money) + ' < ' + usd(cost + floor + bill) + ' for ' + ahead + ' x ' + s.pick.label + ' + bill floor + money floor', need: cost + floor + bill };
    return { ok: true, need: cost + floor + bill };
  }
  function waveStep(v, ctx, e, tg, rule, stage) {
    const w = waveState(v, ctx, e);
    const status = 'wave ' + Math.min(w.wave, w.waves) + '/' + w.waves + ', ' + w.farms + ' cotton Farms';
    const ownFarms = e.ownPool(e.id.farm);
    if (ownFarms > 0 && !ctx.boCdBusy) {   // a wave whose demolish did not land: finish it
      const p0 = v.pool[e.id.farm] ?? 0;
      return { status, action: { id: 'bo:demolish', text: 'Farm conversion: demolish ' + ownFarms + ' Farm(s) left in the pool',
        steps: [{ msg: { type: 'DemolishBuilding', building: e.id.farm, amount: ownFarms, region: REGION }, until: (x) => (x.pool[e.id.farm] ?? 0) <= p0 - ownFarms }] } };
    }
    if (!w.farms) return { status: 'conversion done (0 cotton Farms)' };
    if (w.wave >= w.waves) return { status, wait: 'conversion: all ' + w.waves + ' waves done, ' + w.farms + ' Farms left' };
    if (ctx.retailOk === false) return { status, wait: 'retail checkpoint failed: remaining Farms stay on Cotton' };   // plan A2: any fail, measured or not; the capped engine needs no more acres
    const cot = v.idI('Cotton'), eater = v.groups.find((g) => g.count > 0 && (v.C.recipes[g.recipe]?.inputs ?? []).some((i) => i.item === cot));
    if (eater) return { status, wait: 'conversion: group ' + eater.id + ' (' + (eater.name ?? v.C.recipes[eater.recipe].name) + ') eats Cotton: Farms stay' };   // the plan sells Cotton; a group outside it needs the Farms
    if (ctx.boCdBusy) return { status, wait: 'conversion: CD Farm is running' };
    // Fail closed: without saved wave memory every step would look like wave 1 and demolish another quarter of the Farms.
    if (!ctx.boMemOk || ctx.mem?.('buildout')?.get?.()?.base == null) return { status, wait: 'conversion: wave memory not saved (browser storage), no wave' };
    if (w.wave > 0 && w.at != null && ctx.now - w.at < cfg.waveGapHours * HOUR) return { status, wait: 'conversion: next wave in ' + ((cfg.waveGapHours * HOUR - (ctx.now - w.at)) / 60000).toFixed(0) + ' min' };
    if (w.wave > 0) {
      const busy = blocksRunning(v, ctx, e);
      if (busy) return { status, wait: 'conversion: last wave not running yet: ' + busy };
      const left = v.freeAcres - cfg.bufferAcres;
      const need = rule && (rule.need.camps || rule.need.sawmills || rule.need.workshops);
      if (need && left > cfg.waveSlackAcres) return { status, wait: 'conversion: ' + left + ' acres of the last wave not built yet' };
    }
    const g = homeGroup(e, e.id.farm, e.R.cotton);
    const n = Math.min(g.count, w.farms - w.targetAfter(w.wave));
    if (n <= 0) return { status };
    const gate = waveGate(v, ctx, e, rule, stage, n);
    if (!gate.ok) return { status, wait: 'conversion: wave ' + (w.wave + 1) + ' waits: ' + gate.wait };
    const c0 = g.count, o0 = v.owned('Farm');
    return { status, action: { id: 'bo:wave:' + w.wave, text: 'Farm conversion wave ' + (w.wave + 1) + '/' + w.waves + ': unassign and demolish ' + n + ' Farms', hold: true,
      steps: [{ msg: { type: 'UnassignBuildings', group: g.id, amount: n }, until: (x) => (groupById(x, g.id)?.count ?? 0) <= c0 - n },
        { msg: { type: 'DemolishBuilding', building: e.id.farm, amount: n, region: REGION }, until: (x) => x.owned('Farm') <= o0 - n }] } };
  }

  // 4b. Land conversion (plan R-6, B4). When the Workshops the plan has want more Planks than the Sawmills make (tg.chain, B4, net of the
  // Planks stock budget: while the stock above the reserve feeds Workshops, no Sawmill for them) and there is no land to buy (Heartland at its
  // cap or past the land rule), a group whose output only sells on the market is demolished and its acres rebuilt as Camps + Sawmills.
  // Candidate: a running Heartland extraction group (a recipe with no inputs: removing a processing group would strand its inputs), not
  // paused, not in cfg.convertProtect by id or name, not CD Farm's building, not an engine / Farm / store / Lab building, with no
  // demolition of its building queued, whose output
  //   - has a positive market bid in Heartland (an output nothing buys, e.g. Inspiration for module Refits, is never free land) and is no
  //     intangible / global item;
  //   - is no input of any group's recipe (any region, Lab processes included) or of the plan's own recipes (Kiln gate, furniture, Frame Timber);
  //   - is no floor piece material, no build item and no kit part (default kit or applied floor) of an unlocked building (the plan buys
  //     Camps, Sawmills, Workshops and stores) nor a build item of a locked one (prototypes);
  //   - is not researched or on the Lab runner's list, not an endgame target, not kept back by another module.
  // Ranked by $ per acre-hour (output x the marginal bid), below the chain's (the allocator's best $ per Workshop-hour over the acres of a
  // Workshop, its Sawmills and Camps). Size: the acres the chain gap needs (acres of queued demolitions count as coming); the split keeps Wood
  // >= what the Sawmills eat. Gates before anything is sent: payback (chain buildings + their kits - demolish refund) / (the allocator's $/h
  // with the new Planks - without them - the group's $/h) <= cfg.convertPaybackH, cash (money floor + bills), kits, the Sawmill wood gate,
  // saved memory. The first conversion waits for cfg.convertConfirmed (a toast with Confirm, and the readout). Sequence, one message per step
  // (mem conv): UnassignBuildings + DemolishBuilding (queued: the acres free when the demolitions finish), then at once BuyBuilding the Camps
  // and the Sawmills (CD Farm takes free acres), then the pool tidy puts them in their groups. Buildings a lost buy did not get are left to
  // the build-out (its targets still want them). After 1 h a conversion still under way is dropped (the build-out takes over).
  // start: false only continues a conversion under way.
  const GLOBAL_ITEMS = ['Inspiration', 'Manufacturing Data', 'Research Data', 'Construction Data', 'Data'];
  function convertStep(v, ctx, e, tg, rule, stage, start) {
    const m = ctx.mem?.('buildout'), mm = m?.get?.() ?? {}, cv = mm.conv ?? null;
    const mf = () => ctx.mem('buildout');   // a fresh handle inside a confirm: never write back a copy read before the send
    const cb = e.id.camp, sb = e.id.saw, campA = v.bld(cb).acres || 1, sawA = v.bld(sb).acres || 1;
    const demolishing = (b) => (v.st.construction?.demolitions ?? []).filter((x) => x.building === b && (x.region ?? REGION) === REGION).reduce((a, x) => a + x.count, 0);
    if (cv) {
      const name = v.bld(cv.b).name, wantA = cv.camps * campA + cv.saws * sawA;
      // stuck (CD Farm keeps the Mine demolition queue busy, a lost message): after an hour the build-out takes the freed acres over
      if ((ctx.now ?? Date.now()) - (cv.at ?? 0) > HOUR) { m.set({ conv: null }); return { status: 'conversion dropped after 1 h (the build-out buys what is missing): ' + cv.text }; }
      const dq = demolishing(cv.b);
      if (dq > 0 && v.freeAcres < wantA) return { status: cv.text, wait: 'conversion: ' + dq + ' ' + name + ' demolition(s) left before the chain is bought' };
      // only the units this conversion put in the pool (pool above what it held before the unassign; unknown: none)
      const pooled = Math.min(cv.n, Math.max(0, (v.pool[cv.b] ?? 0) - (cv.p0 ?? Infinity)));
      if (!cv.demolished && pooled > 0) {
        const p1 = v.pool[cv.b] ?? 0;
        return { status: cv.text, action: { id: 'bo:convert:demolish:' + cv.b, text: 'conversion: demolish the ' + pooled + ' ' + name + ' it left in the pool', hold: true,
          steps: [{ msg: { type: 'DemolishBuilding', building: cv.b, amount: pooled, region: REGION }, until: (x) => { const ok = (x.pool[cv.b] ?? 0) <= p1 - pooled; if (ok) { const h = mf(); h.set({ conv: { ...h.get().conv, demolished: true } }); } return ok; } }] } };
      }
      const sent = cv.sent ?? {}, steps = [];
      // both buys share the free acres (a queued build holds its acres): fewer than planned (CD Farm took some) scales both alike
      const left = (sent[cb] ? 0 : cv.camps * campA) + (sent[sb] ? 0 : cv.saws * sawA), f = left > 0 ? Math.min(1, Math.max(0, v.freeAcres) / left) : 0;
      for (const [b, n, bn] of [[cb, cv.camps, 'Lumber Camp'], [sb, cv.saws, 'Sawmill']]) {
        const k = Math.floor(n * f + 1e-9);
        if (sent[b] || k <= 0) continue;
        const o0 = v.ownedAll(bn);
        let marked = false;   // the first look after the send marks it sent: a lost confirm never buys twice (the build-out buys what is missing)
        steps.push({ msg: { type: 'BuyBuilding', building: b, amount: k, region: REGION }, until: (x) => {
          const h = mf();
          if (!marked) { marked = true; const c = h.get().conv; if (c) h.set({ conv: { ...c, sent: { ...(c.sent ?? {}), [b]: true } } }); }
          const ok = x.ownedAll(bn) >= o0 + k;
          if (ok) { const pm = { ...(h.get().poolMine ?? {}) }; pm[b] = (pm[b] ?? 0) + k; h.set({ poolMine: pm }); }
          return ok;
        } });
      }
      if (!steps.length) { m.set({ conv: null, convDone: (mm.convDone ?? 0) + 1 }); return { status: 'conversion done: ' + cv.text }; }
      return { status: cv.text, action: { id: 'bo:convert:buy:' + cv.b, text: 'conversion: buy ' + steps.map((s) => s.msg.amount + ' ' + v.bld(s.msg.building).name).join(' + ') + ' on the freed acres', hold: true, steps } };
    }
    const al = tg?.al;
    if (!start || !tg?.chain || !al?.bestWs || !al.valueAt || ctx.retailFail) return null;
    // a Camp / Sawmill group on a Lab process: its rates are in the model, but keep the irreversible step to plain chains
    if (v.groups.some((g) => (g.building === cb || g.building === sb) && g.process != null)) return { status: 'no conversion: a Camp / Sawmill group runs a Lab process' };
    const cGap = Math.max(0, tg.chain.camps - e.camps), sGap = Math.max(0, tg.chain.sawmills - e.saws);
    const coming = W.idleCore.planner.queued({ st: v.st, catalog: v.catalog, region: REGION }).demolishAcres;   // acres queued demolitions will free
    const free = Math.max(0, v.freeAcres + coming - cfg.bufferAcres), need = cGap * campA + sGap * sawA - free;
    if (!sGap || need <= 0) return al.burn && al.extra > 0 && tg.chain.sawmillsNoStock > e.saws ? { status: 'no conversion while the Planks stock above the reserve feeds the Workshops (' + Math.round(v.has('Planks')) + ' in stock, burned at +' + Math.round(al.extra) + '/h)' } : null;
    if (v.acresOwned < Math.min(rule?.lastAcre ?? ACRE_CAP, ACRE_CAP)) return null;   // land can still be bought: the build-out's job
    if (!(ctx.deals ?? []).length) return { status: 'no conversion: market rows not loaded (an output is only valued by its bid)' };
    const nb = nextBuildStep(v, { ...ctx, _boEngine: e, _boTargets: tg }, rule, stage);
    if (nb.pick || nb.saving) return null;
    // the chain's $ per acre-hour over a Workshop, its Sawmills and its Camps (for the ranking)
    const rt = chainRates(e), wpp = amt(e.R.planks.inputs, e.woodId) / (e.R.planks.outputs[0]?.amount || 1), bw = al.bestWs;
    const chainAcreH = bw.cents / ((v.bld(e.id.ws).acres || 2) + bw.planksH / rt.smPlanksH * sawA + bw.planksH * wpp / rt.campWoodH * campA);
    // items something uses or keeps
    const used = new Set(), C = v.C;
    for (const g of Object.values(v.st.groups ?? {})) if (g.count > 0) for (const i of (v.st.recipes?.[g.recipe] ?? C.recipes[g.recipe])?.inputs ?? []) used.add(i.item);
    for (const r of Object.values(e.R)) for (const i of r?.inputs ?? []) used.add(i.item);   // the plan's own recipes (the Kiln gate switches to Mix Concrete)
    for (const p of Object.values(v.N.pieces ?? {})) for (const x of p.materials ?? []) used.add(x.item);   // floor pieces (kits, floor upgrades)
    for (const bd of Object.values(C.buildings)) {
      for (const x of bd.build_items ?? []) used.add(x.item);   // unlocked: the plan buys them; locked: prototypes
      if (v.unlocked(bd.name)) for (const x of bd.default_kit ?? []) used.add(x.item);
    }
    for (const l of Object.values(v.st.layouts ?? {})) for (const x of l?.bom ?? []) used.add(x.item);
    for (const x of Object.values(v.st.mfg_research ?? {})) if (x?.product != null) used.add(x.product);
    for (const x of ctx.mods?.labRunner?.cfg?.list ?? []) used.add(x.product);
    for (const [n] of cp._cadence?.TARGETS ?? []) used.add(v.idI(n));
    for (const [i, k] of Object.entries(ctx.reserveItems ?? {})) if (k > 0) used.add(+i);
    const protect = new Set([].concat(cfg.convertProtect ?? []).map(String)), units = ctx.boFarmUnits ?? {};
    const skipB = new Set([cb, sb, e.id.ws, e.id.farm, v.idB('Retail Store'), v.idB('Manufacturing Lab')]);
    const lots = (item) => (ctx.deals ?? []).filter((d) => d.side === 'Sell' && d.item === item && (d.region ?? REGION) === REGION && d.amount > 0).map((d) => ({ price: d.price / d.amount, amount: d.amount }));
    const cands = [];
    for (const g of v.groups) {
      const r = v.st.recipes?.[g.process ?? g.recipe] ?? C.recipes[g.recipe], out = r?.outputs?.[0], it = C.items[out?.item];
      if (!(g.count > 0) || g.paused || !r || !out || !it || (r.inputs ?? []).length || skipB.has(g.building) || (units[g.building] ?? 0) > 0 || protect.has(String(g.id)) || (g.name && protect.has(g.name))) continue;
      if ((r.outputs ?? []).some((o) => used.has(o.item)) || it.intangible || GLOBAL_ITEMS.includes(it.name) || W.corePlan.ENGINE_ITEMS.includes(it.name) || demolishing(g.building) > 0) continue;
      const bid = W.idleCore.planner.itemValues({ catalog: v.catalog, bids: { [out.item]: lots(out.item) }, stock: { [out.item]: v.st.stock?.[REGION]?.[out.item] ?? 0 } })[out.item];
      if (!(bid > 0)) continue;   // no buyer: not free land, its use is unknown
      const perH = g.count * out.amount * runsH(r, v.st.layouts?.[g.process ?? g.recipe]?.fx?.rate ?? 1) * bid, acres = g.count * (v.bld(g.building).acres || 1);
      if (perH / acres < chainAcreH) cands.push({ g, r, item: it.name, perH, acreH: perH / acres });
    }
    cands.sort((a, b) => a.acreH - b.acreH);
    const why = [];
    const kitCents = (list) => list.reduce((a, x) => a + x.amount * (C.items[x.item]?.base_value ?? 0), 0);
    for (const c of cands) {
      const bA = v.bld(c.g.building).acres || 1, n = Math.min(c.g.count, Math.ceil(need / bA - 1e-9)), A = n * bA + free;
      // Sawmills first, as many as the Wood (now plus the new Camps on the rest of the acres) feeds; Camps for the Wood they need
      const s = Math.max(0, Math.min(sGap, Math.floor((e.woodSupply - e.woodDemand + A / campA * rt.campWoodH) / (e.woodPerSaw + sawA / campA * rt.campWoodH) + 1e-9)));
      const k = Math.max(0, Math.min(Math.floor((A - s * sawA) / campA + 1e-9), Math.ceil((e.woodDemand + s * e.woodPerSaw - e.woodSupply) / rt.campWoodH - 1e-9)));
      if (!s) continue;
      let cost = k * kitCents(e.kitOf(cb, e.R.wood)) + s * kitCents(e.kitOf(sb, e.R.planks));
      for (let i = 0; i < k; i++) cost += W.idleCore.planner.price(v.bld(cb).cost, v.ownedAll('Lumber Camp'), i);
      for (let i = 0; i < s; i++) cost += W.idleCore.planner.price(v.bld(sb).cost, v.ownedAll('Sawmill'), i);
      // the new Planks at the allocator's marginal value now: its $/h with them less without them (Sawmills + the stock budget: Planks the stock
      // already covers add nothing yet)
      const refund = n * Math.floor((v.bld(c.g.building).cost ?? 0) / 2), groupH = c.perH * n / c.g.count;
      const gain = (al.valueAt(s * rt.smPlanksH) - al.valueAt(0)) * 100 - groupH;
      const pb = gain > 0 ? (cost - refund) / gain : Infinity;
      const text = 'Convert ' + n + ' ' + v.bld(c.g.building).name + ' (' + c.item + ', ' + usd(groupH) + '/h) to ' + k + ' Lumber Camps + ' + s + ' Sawmills: +' + usd(Math.max(0, gain)) + '/h, payback ' + (Number.isFinite(pb) ? pb.toFixed(1) : 'never') + ' h';
      if (pb > cfg.convertPaybackH) { why.push(text + ' > ' + cfg.convertPaybackH + ' h'); continue; }
      const lack = [...short(v, e.kitOf(cb, e.R.wood), k), ...short(v, [...e.kitOf(sb, e.R.planks), { item: e.woodId, amount: (e.saws + s) * cfg.woodRunsPerSawmill * amt(e.R.planks.inputs, e.woodId) / s }], s)];   // + the R8 wood gate for the Sawmills after the buy
      if (lack.length) return { status: text, wait: 'conversion waits: kit / wood short: ' + lack.join(', ') };
      const floor = ctx.floorCents ?? 0, bill = cp._billNeed(v, 0);
      if (v.money - cost < floor + bill) return { status: text, wait: 'conversion waits: cash ' + usd(v.money) + ' < ' + usd(cost + floor + bill) + ' (chain + money floor + bills)' };
      if (!ctx.boMemOk || !m) return { status: text, wait: 'conversion: memory not saved (browser storage), no demolition' };
      if (!cfg.convertConfirmed) {
        const key = c.g.id + ':' + n + ':' + k + ':' + s, o = mm.convOffer ?? {}, now = ctx.now ?? Date.now();
        if (ctx.live && (o.key !== key || now - (o.at ?? 0) >= HOUR)) {
          m.set({ convOffer: { key, at: now } });
          try { W.idleCore.toast?.(text + ' (Core plan, first conversion)', { kind: 'info', action: { label: 'Confirm', run: () => cp.importCfg({ convertConfirmed: true }) } }); } catch (err) { console.error(err); }
        }
        return { status: text + ': waits for your Confirm', wait: 'conversion offer: ' + text + ' -- Confirm on the toast, or corePlan.importCfg({ convertConfirmed: true })' };
      }
      const g = c.g, c0 = g.count, p0 = v.pool[g.building] ?? 0, conv = { g: g.id, b: g.building, n, p0, camps: k, saws: s, text, at: ctx.now ?? Date.now() };
      return { status: text, action: { id: 'bo:convert:' + g.id + ':' + c0, text: 'conversion: ' + text + ': unassign and demolish ' + n + ' ' + v.bld(g.building).name, hold: true,
        steps: [{ msg: { type: 'UnassignBuildings', group: g.id, amount: n }, until: (x) => { const ok = (groupById(x, g.id)?.count ?? 0) <= c0 - n; if (ok) { const h = mf(); if (!h.get().conv) h.set({ conv }); } return ok; } },
          { msg: { type: 'DemolishBuilding', building: g.building, amount: n, region: REGION }, until: (x) => { const ok = (x.pool[g.building] ?? 0) <= p0; if (ok) { const h = mf(); h.set({ conv: { ...(h.get().conv ?? conv), demolished: true } }); } return ok; } }] } };
    }
    return why.length ? { status: 'no conversion: ' + why.join('; ') } : null;
  }

  // Dollars an engine acre earns an hour (plan D-1): BLOCK_HOURLY at board price 160% and quality 0, scaled by the live board price of the
  // furniture mix, and 0 once the planks made already cover what the shelves sell (appetite x share). BLOCK_HOURLY without a board.
  function blockHourly(ctx, e) {
    const f = ctx.retail, gs = FURN.map(([, n]) => f?.goods?.find((g) => g.name === n));
    if (f?.share == null || gs.some((g) => !(g?.base > 0))) return BLOCK_HOURLY;
    if (f.demandPlanksH > 0 && e.planksSupply >= f.demandPlanksH) return 0;
    return BLOCK_HOURLY * gs.reduce((a, g, i) => a + MIX[FURN[i][0]] * g.unit / g.base, 0) / (1.6 * 0.952);
  }

  // 5. The next purchase: a consumer only when its supplier covers it; otherwise its supplier.
  function nextBuildStep(v, ctx, rule, stage) {
    const e = ctx._boEngine ?? engine(v, ctx);
    if (e.missing) return { wait: 'catalog lacks ' + e.missing.join(', ') };
    if (!rule) return { wait: 'land rule unavailable' };
    const tg = ctx._boTargets ?? targets(v, ctx, rule, e);
    const gap = { camp: tg.camps - e.camps, saw: tg.sawmills - e.saws };
    const nx = nextWorkshopRecipe(e, tg);
    const wsWhy = (r) => 'Workshop (' + r.name + ')';
    let pick = null, held = [], planksHolds = 0, planksNeed = 0;   // holds that only more planks would lift, and the planks/h they need
    // Bench first: one Workshop, the 4th shelf; a Bench that waits (floor, Concrete, planks) holds nothing else back.
    if (tg.bench > e.benchNow) {
      const label = 'Workshop (' + e.R.bench.name + ')', why = benchHeld(v, e, tg);
      if (why) { held.push(label + ': ' + why); if (why.startsWith('planks ')) { planksHolds++; planksNeed = Math.max(planksNeed, e.planksDemand + e.benchPlanksH); } }
      else pick = { bn: 'Workshop', r: e.R.bench, label };
    }
    if (!pick && nx && e.sum(movableFt(ctx, e)) > tg.ft) held.push('Workshop: switch the spare Frame Timber Workshops first');
    else if (!pick && nx && poolTake(v, ctx, e, 'Workshop') > 0) held.push('Workshop: the ' + poolTake(v, ctx, e, 'Workshop') + ' in the pool go first');
    else if (!pick && nx) {
      const extra = e.wsPlanksH(nx.r);
      const covered = e.planksSupply >= e.planksDemand + extra;
      if (floorMissing(e, nx.r)) held.push(wsWhy(nx.r) + ': manual: apply the v1 floor for ' + nx.r.name);
      else if (!covered) { held.push(wsWhy(nx.r) + ': planks ' + Math.round(e.planksSupply) + '/h cannot feed ' + Math.round(e.planksDemand + extra) + '/h'); planksHolds++; planksNeed = Math.max(planksNeed, e.planksDemand + extra); }
      else pick = { bn: 'Workshop', r: nx.r, label: wsWhy(nx.r) };
    }
    if (!pick && gap.saw > 0) {
      const woodShort = e.woodSupply < e.woodDemand + e.woodPerSaw;
      if (woodShort && gap.camp > 0) pick = { bn: 'Lumber Camp', r: e.R.wood, label: 'Lumber Camp (Wood ' + Math.round(e.woodSupply) + '/h short of Sawmills)' };
      else pick = { bn: 'Sawmill', r: e.R.planks, label: 'Sawmill' };
    }
    if (!pick && gap.camp > 0) pick = { bn: 'Lumber Camp', r: e.R.wood, label: 'Lumber Camp' };
    // Held only by planks with the Camps / Sawmills at their targets: closed when the targets at their floor rates (as the rule sizes them) cannot
    // feed it either, so E5 is not held forever. Planks short only now (paused Sawmills, a floor not on yet) stay pending.
    if (!pick && held.length && planksHolds === held.length) {
      const m = W.idleCore.coreMath.engineModel(v.C), cap = Math.min(tg.sawmills * m.smPlanksH, tg.camps * m.campWoodH / m.woodPerPlank);
      if (cap < planksNeed) return { closed: true, wait: held.join('; ') + ' (the targets, ' + tg.camps + ' Camps / ' + tg.sawmills + ' Sawmills, make ' + Math.round(cap) + '/h: closed)' };
    }
    if (!pick) return { wait: held.length ? held.join('; ') : 'build-out at target (' + e.camps + ' Camps, ' + e.saws + ' Sawmills, ' + e.workshops + ' Workshops)', done: !held.length };
    const b = v.idB(pick.bn), bd = v.bld(b);
    const why = 'next ' + pick.label;
    // Acre: keep the CD-farm buffer free; Stage C-D buys acres while the land rule is open, Stage B while the Stage A-B payback rule holds
    // for the dearest acre bought (plan D-1: a block earns more an acre than a Cotton Farm).
    // Stage B buys only the block's own acres (like the land director: the buffer is never used, nor refilled here).
    const acres = stage === 'B' ? Math.max(0, bd.acres - Math.max(0, v.freeAcres - cfg.bufferAcres)) : Math.max(0, cfg.bufferAcres + bd.acres - v.freeAcres);
    let landCents = 0;
    if (acres > 0) {
      if (stage === 'B') {
        const last = cp._acrePriceCents(v.landBought + acres - 1), pb = (last / 100 + BLOCK_SHARE) / blockHourly(ctx, e);
        if (pb > cfg.landPaybackAB) return { closed: true, wait: why + ': acre #' + (v.acresOwned + acres) + ' ' + usd(last) + ' + block ' + usd(BLOCK_SHARE * 100) + ' pays back in ' + pb.toFixed(1) + ' h > ' + cfg.landPaybackAB + ' h (Stage A-B rule closed)' };
        if (v.acresOwned + acres > ACRE_CAP) return { closed: true, wait: why + ': no free acre and Heartland is at its cap (' + ACRE_CAP + ' acres)' };
      } else {
        if (stage !== 'C' && stage !== 'D') return { wait: why + ': no free acre (stage ' + stage + ' builds on free land only, ' + v.freeAcres + ' free, buffer ' + cfg.bufferAcres + ')' };
        if (v.acresOwned + acres > Math.min(rule.lastAcre, ACRE_CAP)) return { closed: true, wait: why + ': no free acre and the land rule closes at #' + Math.min(rule.lastAcre, ACRE_CAP) };
      }
      for (let i = 0; i < acres; i++) landCents += cp._acrePriceCents(v.landBought + i);
    }
    const lack = short(v, e.kitOf(b, pick.r));
    if (lack.length) return { wait: why + ': kit short: ' + lack.join(', ') };
    if (pick.bn === 'Sawmill') {
      const need = (e.saws + 1) * cfg.woodRunsPerSawmill * amt(e.R.planks.inputs, e.woodId);
      if (v.has('Wood') < need) return { wait: why + ': wood gate: Wood ' + Math.floor(v.has('Wood')) + ' < ' + need + ' (Sawmills x ' + cfg.woodRunsPerSawmill + ' runs)' };
    }
    const price = W.idleCore.planner.price(bd.cost, v.ownedAll(pick.bn), 0), cost = price + landCents;
    const mw = bd.draws?.power ?? 0, bill = cp._billNeed(v, mw), floor = ctx.floorCents ?? 0;
    if (ctx._boNoCash) return { pick, b, acres, cost, landCents, price, why };   // the wave gate checks cash itself, for several buildings
    if (v.money - cost < bill) return { saving: pick.label, wait: why + ': bill floor: cash ' + usd(v.money) + ' - ' + usd(cost) + ' < ' + usd(bill) + ' (' + mw + ' new MW x $20 + 2 h of bills)' };
    if (v.money - cost < floor + bill) return { saving: pick.label, wait: why + ': money floor: needs ' + usd(floor + bill + cost - v.money) + ' more above the floor ' + usd(floor) };
    // a Workshop into a running group draws at once: only with the power free (asked of Auto utilities first), as the switch
    if (pick.bn === 'Workshop' && homeGroup(e, b, pick.r)?.work?.length && mw > 0 && powerFor(v, ctx, mw) < mw) return { wait: why + ': waits for ' + mw + ' MW free power (asked Auto utilities)' };
    return { pick, b, acres, cost, landCents, price, why };
  }
  function buyAction(v, e, s) {
    const { b, pick, acres } = s;
    const g = homeGroup(e, b, pick.r), steps = cp._buySteps(v, b, acres, g, pick.r.name);
    const text = 'build-out: buy ' + (acres ? acres + ' acre(s) #' + (v.acresOwned + 1) + ' ' + usd(s.landCents) + ' + ' : '') + pick.label + ' ' + usd(s.price) + (g ? ' into group ' + g.id : ' (new group)');
    return { id: 'bo:buy:' + pick.bn + ':' + v.owned(pick.bn), text, steps, hold: true };
  }

