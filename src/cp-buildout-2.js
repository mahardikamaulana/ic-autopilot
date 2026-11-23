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
  // Group a building of type b on recipe r goes into: the biggest one on that recipe.
  // A group made by CreateGroup has no recipe until SetRecipe lands; it counts by its name, so a second Workshop joins it instead of a new group.
  const homeGroup = (e, b, r) => e.groupsOf(b, r).sort((a, c) => c.count - a.count)[0]
    ?? e.groupsOf(b).filter((g) => g.recipe == null && g.name === r.name).sort((a, c) => c.count - a.count)[0] ?? null;
  // Where a Workshop from the pool goes: a wanted Bench that is ready (as the buy path, Bench first), else the biggest furniture gap that has its floor and that the spare planks feed, else Frame Timber.
  // Same checks as the switch, so a Workshop the switch freed is never sent back to Frame Timber while the switch still wants it.
  function poolWorkshopRecipe(v, ctx, e, tg, n) {
    if (tg && tg.bench > e.benchNow && !benchHeld(v, e, tg)) return e.R.bench;
    const furnTotal = FURN.reduce((a, [k]) => a + e.furnNow[k], 0);
    const want = failKeep(ctx, tg ? tg.furn : furnitureSplit(ctx.retailBoard, 0, v.C).alloc(furnTotal + n));
    const headroom = e.planksSupply - e.planksDemand;
    const gaps = FURN.map(([k]) => ({ k, gap: want[k] - e.furnNow[k] })).filter((x) => x.gap > 0).sort((a, b) => b.gap - a.gap);
    const ok = gaps.find((x) => !floorMissing(e, e.R[x.k]) && headroom + 1e-9 >= e.wsPlanksH(e.R[x.k]));
    return ok ? e.R[ok.k] : e.R.ft;
  }

  // 1. Pool tidy: own engine buildings sitting in the pool, and engine groups without a recipe.
  function tidy(v, ctx, e, tg) {
    for (const bn of ENGINE) {
      const b = v.idB(bn);
      if (bn === 'Lumber Camp' && ctx.boCdBusy) continue;            // a CD run may be cycling Camps through the pool
      const n = e.ownPool(b);
      if (!n) continue;
      let r = bn === 'Lumber Camp' ? e.R.wood : bn === 'Sawmill' ? e.R.planks : null;
      if (bn === 'Workshop') r = poolWorkshopRecipe(v, ctx, e, tg, n);
      const g = homeGroup(e, b, r);
      const k = bn === 'Workshop' ? 1 : n;                            // Workshops one at a time: each goes where the split is shortest
      return g ? assignAction(v, b, g, k, 'pool') : createAction(v, b, k, r.name, 'pool');
    }
    for (const bn of ENGINE) {
      const b = v.idB(bn);
      const g = v.groups.find((x) => x.building === b && x.count > 0 && (x.recipe == null || !v.C.recipes[x.recipe]));
      if (!g) continue;
      const named = Object.values(v.C.recipes).find((r) => r.building === b && r.name === g.name);
      const r = named ?? (bn === 'Lumber Camp' ? e.R.wood : bn === 'Sawmill' ? e.R.planks : (tg ? nextWorkshopRecipe(e, tg)?.r : null) ?? e.R.ft);
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
  // 2b. Wooden Frame gate: pause Frame Timber at or above the keep line, resume below half of it (planks above the line are worth more as
  // furniture, wiki 11.4). Kiln-gate bookkeeping: only groups paused here come back (mem ftMine), one the user resumed is left alone
  // (ftUser, from context()). On the retail fail path after a pass CD Farm burns the frames above the line: nothing is paused, ours come
  // back. That holds only while the ladder has a CD need (ctx.ladderNeed) and CD Farm runs Auto; otherwise the gate bounds the frames.
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
    const cf = ctx.mods?.cdFarm?.cfg;   // CD Farm farms (the ladder's Oil Rig / Refinery need) only after a pass, with Auto on
    const burn = !!(ctx.retailFailPath && ctx.retailOk === true && ctx.ladderNeed && typeof ctx.ladderNeed === 'object' && cf?.building === 'auto' && cf.autoStart);
    const back = paused.find((g) => g.recipe !== e.R.ft.id) ?? (burn || wf < keep / 2 ? paused[0] : null);
    if (back) {
      const mw = (v.bld(back.building).draws?.power ?? 0) * back.count, bill = cp._billNeed(v, mw), floor = ctx.floorCents ?? 0;
      if (v.money < floor + bill) return { wait: 'WF gate: resume group ' + back.id + ' waits: cash ' + usd(v.money) + ' < ' + usd(floor + bill) + ' (money floor + ' + mw + ' MW bills)' };
      return { action: confirmed(pauseAction(v, back, false, 'Wooden Frame gate (' + line + ')'), note(back.id, false)) };
    }
    if (burn) return { wait: line + ' (retail fail path after a pass: CD Farm burns the frames above it)' };
    if (!(keep > 0) || wf < keep) return { wait: line };
    if (!ctx.boMemOk) return { wait: line + ': Frame Timber not paused, browser storage does not save (a pause it forgets would starve Rivet)' };
    const g = e.groupsOf(e.id.ws, e.R.ft).find((x) => !x.paused && x.count > 0 && !user.has(x.id));
    if (!g) return { wait: line };
    return { action: confirmed(pauseAction(v, g, true, 'Wooden Frame gate (' + line + ')'), note(g.id, true)) };
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

  function switchStep(v, ctx, e, tg) {
    // Keep only the reserve here: the retail cap already limits n, and extra Frame Timber for leftover planks is the purchase path's job.
    const keep = cfg.keepFrameTimber;
    const spare = e.ftNow - keep;
    if (spare <= 0) return null;
    const split = tg?.split ?? furnitureSplit(ctx.retailBoard, 0, v.C);
    const furnTotal = FURN.reduce((a, [k]) => a + e.furnNow[k], 0);
    const cap = typeof ctx.retailCap === 'number' ? Math.max(0, Math.floor(ctx.retailCap)) : Infinity;
    const n = Math.min(furnTotal + spare, cap);
    if (n <= furnTotal) return { wait: 'switch: furniture at the retail cap (' + cap + '), spare Frame Timber stays' };
    const want = failKeep(ctx, split.alloc(n));   // a measured fail: never above the per-good keep the fail path cuts to
    const gaps = FURN.map(([k]) => ({ k, gap: want[k] - e.furnNow[k] })).filter((x) => x.gap > 0).sort((a, b) => b.gap - a.gap);
    if (!gaps.length) return null;
    // Planks cap: a switch may not push plank use past what the Sawmills make (a Bookshelf eats more than Frame Timber).
    const headroom = e.planksSupply - e.planksDemand, ftUse = e.wsPlanksH(e.R.ft);
    const fits = (k) => { const d = e.wsPlanksH(e.R[k]) - ftUse; return d <= 0 ? Infinity : Math.floor((headroom + 1e-9) / d); };
    // Skip recipes without a saved floor: the switch moves what it can now and asks for the floor of the rest.
    const noFloor = gaps.filter((x) => floorMissing(e, e.R[x.k]));
    const pickGap = gaps.find((x) => fits(x.k) > 0 && !floorMissing(e, e.R[x.k]));
    if (!pickGap && noFloor.length) return { wait: 'switch: manual: apply the v1 floor for ' + noFloor.map((x) => e.R[x.k].name).join(', ') + ' (furniture Workshops wait for it)' };
    if (!pickGap) return { wait: 'switch: planks ' + Math.round(e.planksSupply) + '/h made, ' + Math.round(e.planksDemand) + '/h used: more Sawmills before more furniture' };
    const { k } = pickGap, r = e.R[k], gap = Math.min(pickGap.gap, fits(k));
    const room = Math.min(gap, spare);
    const fts = e.groupsOf(e.id.ws, e.R.ft).filter((g) => g.count > 0).sort((a, b) => b.count - a.count);
    const whole = fts.filter((g) => g.count <= room).sort((a, b) => b.count - a.count)[0];
    const kit = (cnt) => short(v, e.kitOf(e.id.ws, r).filter((x) => !(v.bld(e.id.ws).build_items ?? []).includes(x)), cnt);
    if (whole) {
      const lack = kit(whole.count);
      if (lack.length) return { wait: 'switch: kit short for ' + whole.count + ' x ' + r.name + ': ' + lack.join(', ') };
      return { action: recipeAction(v, whole, r, 'switch spare Frame Timber to furniture (' + split.source + ')') };
    }
    const g = fts[0];
    const take = Math.min(room, g.count - (fts.length === 1 ? keep : 0));
    if (take <= 0) return null;
    const lack = kit(take);
    if (lack.length) return { wait: 'switch: kit short for ' + take + ' x ' + r.name + ': ' + lack.join(', ') };
    const c0 = g.count;
    // One action: free the Workshops and put them straight on r, so the pool tidy never has to guess the recipe the switch chose.
    const home = homeGroup(e, e.id.ws, r), ids = new Set(v.groups.map((x) => x.id));
    const place = home
      ? { msg: { type: 'AssignBuildings', group: home.id, amount: take }, until: ((h0) => (x) => (groupById(x, home.id)?.count ?? 0) >= h0 + take)(home.count) }
      : { msg: { type: 'CreateGroup', building: e.id.ws, amount: take, name: r.name, region: REGION }, until: (x) => x.groups.some((y) => !ids.has(y.id) && y.building === e.id.ws && y.count >= take) };
    return { action: { id: 'bo:split:' + g.id, text: 'switch spare Frame Timber to furniture (' + split.source + '): move ' + take + ' Workshop(s) from group ' + g.id + ' to ' + r.name + (home ? ' (group ' + home.id + ')' : ' (new group)'),
      steps: [{ msg: { type: 'UnassignBuildings', group: g.id, amount: take }, until: (x) => (groupById(x, g.id)?.count ?? 0) <= c0 - take }, place] } };
  }

  // 3b. Furniture rebalance (wiki 4.7 step 3, plan D3): today's furniture Workshops against the board's split of the same total.
  // Gap per recipe (+ under, - over); none without a board (the 40/30/30 default is no reason to move a Workshop).
  function furnGaps(v, ctx, e) {
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
    const gaps = ctx.retailFail ? null : furnGaps(v, ctx, e);
    if (!gaps) return null;
    const keys = FURN.map(([k]) => k).filter((k) => gaps[k]);
    if (!keys.some((k) => gaps[k] > 0) || !keys.some((k) => gaps[k] < 0)) return null;
    const seen = ctx.mem?.('buildout')?.get?.()?.rebal ?? {}, now = ctx.now ?? Date.now(), holdMs = Math.max(0, cfg.rebalanceHours) * HOUR;
    const ready = (k) => seen[k]?.dir === (gaps[k] > 0 ? 'under' : 'over') && now - seen[k].at >= holdMs;
    const line = keys.map((k) => e.R[k].name + ' ' + (gaps[k] > 0 ? '+' : '') + gaps[k]).join(', ');
    const under = keys.filter((k) => gaps[k] > 0 && ready(k)).sort((a, b) => gaps[b] - gaps[a]);
    const over = keys.filter((k) => gaps[k] < 0 && ready(k)).sort((a, b) => gaps[a] - gaps[b]);
    if (!under.length || !over.length) return { wait: 'rebalance: ' + line + ' (moves once held ' + cfg.rebalanceHours + ' h)' };
    const headroom = e.planksSupply - e.planksDemand, why = [];
    for (const to of under) {
      const r = e.R[to];
      if (floorMissing(e, r)) { why.push(r.name + ' has no floor'); continue; }
      const lack = short(v, e.kitOf(e.id.ws, r).filter((x) => !(v.bld(e.id.ws).build_items ?? []).includes(x)));
      if (lack.length) { why.push(r.name + ' kit short: ' + lack.join(', ')); continue; }
      for (const from of over) {
        if (e.wsPlanksH(r) - e.wsPlanksH(e.R[from]) > headroom + 1e-9) { why.push('planks cannot feed ' + e.R[from].name + ' -> ' + r.name); continue; }
        const g = e.groupsOf(e.id.ws, e.R[from]).filter((x) => x.count > 0).sort((a, b) => modCount(a) - modCount(b) || b.count - a.count)[0];
        if (!g) continue;
        const c0 = g.count, home = homeGroup(e, e.id.ws, r), ids = new Set(v.groups.map((x) => x.id));
        const place = home
          ? { msg: { type: 'AssignBuildings', group: home.id, amount: 1 }, until: ((h0) => (x) => (groupById(x, home.id)?.count ?? 0) >= h0 + 1)(home.count) }
          : { msg: { type: 'CreateGroup', building: e.id.ws, amount: 1, name: r.name, region: REGION }, until: (x) => x.groups.some((y) => !ids.has(y.id) && y.building === e.id.ws) };
        return { action: { id: 'bo:rebal:' + g.id, text: 'rebalance furniture to the board (' + line + '): move 1 Workshop from group ' + g.id + ' (' + e.R[from].name + ') to ' + r.name + (home ? ' (group ' + home.id + ')' : ' (new group)'),
          steps: [{ msg: { type: 'UnassignBuildings', group: g.id, amount: 1 }, until: (x) => (groupById(x, g.id)?.count ?? 0) <= c0 - 1 }, place] } };
      }
    }
    return { wait: 'rebalance: ' + line + ' waits: ' + why.join('; ') };
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
      if (e.ownPool(b) > 0) return v.bld(b).name + ' in the pool';
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
    for (let i = 0; i < ahead; i++) cost += W.idleCore.planner.price(bd.cost, v.owned(s.pick.bn), i);
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
    if (ctx.retailFail) return { status, wait: 'retail fail path: Farms stay on Cotton' };   // a pass of the re-run proves only the capped output sells
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
    if (!pick && nx && e.ftNow > tg.ft) held.push('Workshop: switch the spare Frame Timber Workshops first');
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
        const last = cp._acrePriceCents(v.landBought + acres - 1), pb = (last / 100 + BLOCK_SHARE) / BLOCK_HOURLY;
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
    const price = W.idleCore.planner.price(bd.cost, v.owned(pick.bn), 0), cost = price + landCents;
    const mw = bd.draws?.power ?? 0, bill = cp._billNeed(v, mw), floor = ctx.floorCents ?? 0;
    if (ctx._boNoCash) return { pick, b, acres, cost, landCents, price, why };   // the wave gate checks cash itself, for several buildings
    if (v.money - cost < bill) return { saving: pick.label, wait: why + ': bill floor: cash ' + usd(v.money) + ' - ' + usd(cost) + ' < ' + usd(bill) + ' (' + mw + ' new MW x $20 + 2 h of bills)' };
    if (v.money - cost < floor + bill) return { saving: pick.label, wait: why + ': money floor: needs ' + usd(floor + bill + cost - v.money) + ' more above the floor ' + usd(floor) };
    return { pick, b, acres, cost, landCents, price, why };
  }
  function buyAction(v, e, s) {
    const { b, pick, acres } = s;
    const g = homeGroup(e, b, pick.r), steps = cp._buySteps(v, b, acres, g, pick.r.name);
    const text = 'build-out: buy ' + (acres ? acres + ' acre(s) #' + (v.acresOwned + 1) + ' ' + usd(s.landCents) + ' + ' : '') + pick.label + ' ' + usd(s.price) + (g ? ' into group ' + g.id : ' (new group)');
    return { id: 'bo:buy:' + pick.bn + ':' + v.owned(pick.bn), text, steps, hold: true };
  }

