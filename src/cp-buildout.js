// ============================================================================
// CORE PLAN DIRECTOR: 5. Engine build-out and Farm conversion
// ============================================================================
// Director "buildout" (wiki/guides/core-game-plan.md 4.2-4.5, 4.8, 8.1, 11.2-11.3, 14 R8). One message (or one purchase) per step:
//   - pool tidy: own Camps / Sawmills / Workshops left in the pool go into their group (never cdFarm's units), named groups get their recipe;
//   - Kiln stock gate: unpause / switch the Kiln until Glass and Concrete reach their gates, pause again after;
//   - Wooden Frame gate: pause Frame Timber at the WF keep line (Rivet use for cfg.ftKeepHours), resume below half (plan D-3);
//   - Stage B-D: spare Frame Timber Workshops switch to furniture (split from the retail board), keeping 1 on Frame Timber;
//   - Stage C-D: Farms go in 4 waves 3 h apart (UnassignBuildings + DemolishBuilding), only when the last wave's acres are built and running;
//   - build-out toward core-math landRule: a consumer only when its supplier covers it, each buy gated by acre, kit, wood (R8), bill floor
//     and the money floor; Stage C-D buys the acre too while the land rule is open, Stage B while (acre + $1,200) / $1,444 <= 20 h (plan D-1).
//   - Stage B-D: furniture Workshops follow the board: a recipe 1+ Workshops over / under the split for cfg.rebalanceHours moves one (plan D3);
//   - Stage D after a checkpoint pass (never on the fail path): cfg.benchWorkshops Bench Workshop(s), the 4th shelf, on the Rivet x3 floor, once
//     Concrete covers the Kiln gate + 48 h of Bench use; while a Bench group exists the Kiln gate's Concrete target rises by that use (plan D4).
// Pure helpers for tests: corePlan._buildout.furnitureSplit / nextBuildStep / waveState / waveStep; wfKeep is the keep line Core plan's reserve uses.
// nextBuildStep's saving (a bill / money floor wait) makes the Stage B land director wait too; pendingInvest feeds Core plan's E5.
// @@MODULE cp-buildout
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const cp = W.corePlan, cfg = cp.cfg, usd = cp._usd;
  const REGION = 0, ACRE_CAP = 360;
  const FURN = [['bookshelf', 'Bookshelf', 'Make Bookshelf'], ['table', 'Table', 'Make Table'], ['chair', 'Chair', 'Make Chair']];
  const MIX = { bookshelf: 0.4, table: 0.3, chair: 0.3 };     // plank shares when the board has no appetite (wiki 4.3)
  const FLOOR = { 'Lumber Camp': 3, Sawmill: 2, Workshop: 5 }; // floor rate the plan assumes (wiki 4.5)
  const ENGINE = ['Lumber Camp', 'Sawmill', 'Workshop'];
  const HOUR = 3600000;
  const BENCH_FLOOR = 3, BENCH_HOURS = 48;                    // Make Bench on the Rivet x3 floor; Concrete kept for this many hours of Bench use (plan D4)
  const BLOCK_SHARE = 1200, BLOCK_HOURLY = 1444;               // dollars: a block's buildings per acre, and what an engine acre earns an hour (plan D-1)

  const DEFAULTS = {
    keepFrameTimber: 1,          // Workshops kept on Frame Timber (wiki 4.8 step 1)
    needFurnitureFloor: true,    // furniture Workshops wait until the recipe has a saved floor (wiki 4.8 pre-condition)
    applyFurnitureFloor: true,   // ...and Core plan applies the Workshop v1 floor itself (EditLayout); Autopilot keeps recipes already running while it sends live
    floorRetryMin: 10,           // after an EditLayout the server did not apply, floors wait this long (one bad floor cannot run into maxFails)
    conversionWaves: 4,          // Farm conversion waves (wiki 4.8 step 5)
    waveGapHours: 3,
    waveSlackAcres: 4,           // a wave waits while more than buffer + this many acres are still empty
    waveCashAhead: 3,            // a wave waits until cash covers this many of the buildings that replace its Farms
    woodRunsPerSawmill: 2,       // R8: Wood stock >= Sawmills x this x Wood per run before more Sawmills
    glassGate: 100,              // Kiln: Glass before the store research ends (wiki 4.8 step 6)
    concreteGate: 400,           // Kiln: Concrete by the gate
    ftKeepHours: 2,              // Wooden Frame keep line: this many hours of Rivet use (plan D-3); Frame Timber pauses at it, resumes below half
    ftKeepMax: 19,               // ... capped here, so stock settles under 20 and E3 can hold (a Rivet Workshop takes 6 per wave start)
    rebalanceHours: 6,           // a furniture recipe's gap to the board's split must hold this long before a Workshop moves (plan D3)
    benchWorkshops: 1,           // Bench Workshops in Stage D after a checkpoint pass (wiki 4.7 step 2)
  };

  // ---- small pure helpers ------------------------------------------------------------------------------------------------------
  const runsH = (r, rate) => (r ? rate * 3600 / (r.ticks / 2) : 0);           // runs per hour per building (2 ticks a second)
  const recipeOf = (C, name) => Object.values(C.recipes).find((r) => r.name === name) ?? null;
  const itemOf = (C, name) => Object.values(C.items).find((i) => i.name === name) ?? null;
  const amt = (list, item) => (list ?? []).filter((x) => x.item === item).reduce((a, x) => a + x.amount, 0);

  // Largest-remainder rounding of fractional counts to n whole Workshops.
  function allocate(frac, n) {
    const keys = Object.keys(frac), sum = keys.reduce((a, k) => a + frac[k], 0);
    const out = {};
    if (!(sum > 0) || n <= 0) { for (const k of keys) out[k] = 0; return out; }
    const raw = keys.map((k) => ({ k, x: frac[k] * n / sum }));
    for (const r of raw) out[r.k] = Math.floor(r.x);
    let left = n - raw.reduce((a, r) => a + out[r.k], 0);
    for (const r of [...raw].sort((a, b) => (b.x - Math.floor(b.x)) - (a.x - Math.floor(a.x)) || b.x - a.x)) { if (left <= 0) break; out[r.k]++; left--; }
    return out;
  }

  // Bookshelf / Table / Chair Workshops for planksH planks per hour, sized by retail appetite in Heartland (wiki 4.7 step 3).
  // Plank share of an item = appetite x planks per unit; Workshops = that share / planks one Workshop eats at the v1 floor.
  function furnitureSplit(board, planksH, catalog) {
    const C = catalog?.byId ? catalog : cp._names(catalog).C;
    const shelf = board?.shelves?.[REGION] ?? board?.shelves?.[String(REGION)] ?? null;
    const rows = FURN.map(([k, item, rec]) => {
      const r = recipeOf(C, rec), it = itemOf(C, item);
      if (!r || !it) throw new Error('furnitureSplit: ' + rec + ' / ' + item + ' not in the catalog');
      const ppu = amt(r.inputs, itemOf(C, 'Planks')?.id) / (r.outputs[0]?.amount || 1);
      const unitsH = (r.outputs[0]?.amount ?? 1) * runsH(r, FLOOR.Workshop);
      return { k, appetite: Math.max(0, +(shelf?.[it.id]?.appetite ?? 0) || 0), ppu, planksPerWs: unitsH * ppu };
    });
    const fromBoard = rows.some((r) => r.appetite > 0);
    const w = Object.fromEntries(rows.map((r) => [r.k, fromBoard ? r.appetite * r.ppu : MIX[r.k]]));
    const ws = Object.values(w).reduce((a, x) => a + x, 0);
    const shares = Object.fromEntries(rows.map((r) => [r.k, w[r.k] / ws]));
    const frac = Object.fromEntries(rows.map((r) => [r.k, Math.max(0, planksH || 0) * shares[r.k] / r.planksPerWs]));
    const total = Math.round(Object.values(frac).reduce((a, x) => a + x, 0));   // capped by planks: no Workshop past what planks feed
    const counts = allocate(frac, total);
    const perWs = Object.fromEntries(rows.map((r) => [r.k, r.planksPerWs]));
    // Workshops per item for any total n (the Stage B switch has a fixed number of spare Workshops).
    const unitFrac = Object.fromEntries(rows.map((r) => [r.k, shares[r.k] / r.planksPerWs]));
    return { source: fromBoard ? 'board' : 'default 40/30/30', shares, frac, ...counts, total, planksPerWs: perWs, alloc: (n) => allocate(unitFrac, n) };
  }

  // ---- reading the engine from a view ---------------------------------------------------------------------------------------------
  function engine(v, ctx) {
    const N = v.N, C = v.C, st = v.st;
    const id = { camp: v.idB('Lumber Camp'), saw: v.idB('Sawmill'), ws: v.idB('Workshop'), farm: v.idB('Farm'), kiln: v.idB('Kiln') };
    const rec = (n) => recipeOf(C, n);
    const R = { wood: rec('Fell Wood'), planks: rec('Saw Planks'), ft: rec('Frame Timber'), rivet: rec('Rivet Iron Frame'), cotton: rec('Grow Cotton'),
      glass: rec('Blow Glass'), concrete: rec('Mix Concrete'), bookshelf: rec('Make Bookshelf'), table: rec('Make Table'), chair: rec('Make Chair') };
    const missing = [...Object.entries(id).filter(([, x]) => x == null).map(([k]) => 'building ' + k), ...Object.entries(R).filter(([, x]) => !x).map(([k]) => 'recipe ' + k)];
    if (missing.length) return { missing };
    const units = ctx.boFarmUnits ?? {};
    const ownPool = (b) => Math.max(0, (v.pool[b] ?? 0) - (units[b] ?? 0));
    const layout = (r) => st.layouts?.[r.id] ?? null;
    const rateNow = (r) => layout(r)?.fx?.rate ?? 1;                         // what it runs at today (default floor = 1)
    const ratePlan = (r, b) => Math.max(rateNow(r), FLOOR[b] ?? 1);          // what it will eat once the floor is applied
    const planksId = v.idI('Planks'), woodId = v.idI('Wood');
    const groupsOf = (b, r) => v.groups.filter((g) => g.building === b && (r === undefined || g.recipe === (r?.id ?? r)));
    const sum = (gs) => gs.reduce((a, g) => a + g.count, 0);
    const furnKeys = FURN.map(([k]) => k);
    const wsGroups = groupsOf(id.ws);
    const furnNow = Object.fromEntries(furnKeys.map((k) => [k, sum(wsGroups.filter((g) => g.recipe === R[k].id))]));
    const ftNow = sum(wsGroups.filter((g) => g.recipe === R.ft.id));
    const planksPerSaw = (R.planks.outputs[0]?.amount ?? 1) * runsH(R.planks, rateNow(R.planks));
    const woodPerSaw = amt(R.planks.inputs, woodId) * runsH(R.planks, ratePlan(R.planks, 'Sawmill'));
    const woodPerCamp = (R.wood.outputs[0]?.amount ?? 1) * runsH(R.wood, rateNow(R.wood));
    const wsPlanksH = (r) => amt(r.inputs, planksId) * runsH(r, ratePlan(r, 'Workshop'));
    const live = (g) => !g.paused && g.count > 0;
    const ftHeld = new Set(ctx.mem?.('buildout')?.get?.()?.ftMine ?? []);   // Frame Timber the WF gate paused comes back: its planks stay spoken for
    const planksSupply = sum(groupsOf(id.saw, R.planks).filter(live)) * planksPerSaw;
    // Each group at the floor it really runs (Make Bench x3, not furniture's x5); one with no floor yet at the floor it will get.
    const runPlanksH = (r) => (layout(r) ? amt(r.inputs, planksId) * runsH(r, rateNow(r)) : wsPlanksH(r));
    const planksDemand = wsGroups.filter((g) => live(g) || (ftHeld.has(g.id) && g.count > 0)).reduce((a, g) => a + g.count * (C.recipes[g.recipe] ? runPlanksH(C.recipes[g.recipe]) : 0), 0);
    const woodSupply = sum(groupsOf(id.camp, R.wood).filter(live)) * woodPerCamp;
    const woodDemand = sum(groupsOf(id.saw, R.planks).filter(live)) * woodPerSaw;
    const kitOf = (b, r) => [...(v.bld(b).build_items ?? []), ...((r && layout(r)?.bom) ?? v.bld(b).default_kit ?? [])];
    // Make Bench is optional (no Bench in the catalog: no Bench Workshop); it runs on the Rivet x3 floor, not v1's x5.
    R.bench = rec('Make Bench');
    const benchNow = R.bench ? sum(wsGroups.filter((g) => g.recipe === R.bench.id)) : 0;
    const benchRuns = R.bench ? runsH(R.bench, Math.max(rateNow(R.bench), BENCH_FLOOR)) : 0;
    const benchConcreteH = (n) => n * benchRuns * (R.bench ? amt(R.bench.inputs, v.idI('Concrete')) : 0);
    const benchPlanksH = R.bench ? benchRuns * amt(R.bench.inputs, planksId) : 0;
    return { id, R, ownPool, benchNow, benchConcreteH, benchPlanksH, layout, rateNow, groupsOf, sum, furnNow, ftNow, wsGroups, planksPerSaw, woodPerSaw, woodPerCamp, wsPlanksH,
      planksSupply, planksDemand, woodSupply, woodDemand, kitOf, woodId, planksId,
      camps: v.owned('Lumber Camp'), saws: v.owned('Sawmill'), workshops: v.owned('Workshop'), farms: v.owned('Farm') };
  }
  const short = (v, list, n = 1) => {   // what is missing from stock for n x list
    const need = {};
    for (const x of list) need[x.item] = (need[x.item] ?? 0) + x.amount * n;
    const st = v.st.stock?.[REGION] ?? {}, items = v.st.items ?? {};
    return Object.entries(need).filter(([i, a]) => (st[i] ?? items[i] ?? 0) < a).map(([i, a]) => Math.ceil(a - (st[i] ?? items[i] ?? 0)) + ' ' + (v.C.items[i]?.name ?? 'item ' + i));
  };

  // A measured retail fail: per good, the keep the fail path cuts to (ceil of its capBy, as cp-retail failAction), so buildout never adds
  // above it and the two never undo each other. Goods not on the measured shelf keep `want`.
  function failKeep(ctx, want) {
    const by = ctx.retailFail ? ctx.retail?.capDecision?.capBy : null;
    return by ? Object.fromEntries(FURN.map(([k, n]) => [k, n in by ? Math.min(want[k], Math.ceil(by[n] - 1e-9)) : want[k]])) : want;
  }
  // Bench (wiki 4.7 step 2): Stage D, the checkpoint passed, not on the retail fail path (its per-good caps rule then).
  const benchWanted = (v, ctx, e) => !!e.R.bench && v.owned('Retail Store') >= 1 && ctx.retailOk === true && !ctx.retailFail && !ctx.retailFailPath;
  // Why the wanted Bench Workshop cannot be placed yet (its floor, Concrete for the gate + 48 h of its use, planks), or null.
  function benchHeld(v, e, tg) {
    const r = e.R.bench, need = cfg.concreteGate + Math.ceil(e.benchConcreteH(tg.bench) * BENCH_HOURS);
    if (floorMissing(e, r)) return 'waits for the Rivet x3 floor';
    if (v.has('Concrete') < need) return 'Concrete ' + Math.floor(v.has('Concrete')) + ' < ' + need + ' (gate ' + cfg.concreteGate + ' + 48 h of Bench use)';
    if (e.planksSupply < e.planksDemand + e.benchPlanksH) return 'planks ' + Math.round(e.planksSupply) + '/h cannot feed ' + Math.round(e.planksDemand + e.benchPlanksH) + '/h';
    return null;
  }
  // Targets: Camps / Sawmills from the land rule, Workshops from the furniture split of the rule's planks, capped by ctx.retailCap.
  function targets(v, ctx, rule, e) {
    const split = furnitureSplit(ctx.retailBoard, rule.planksH, v.C);
    const furn = { bookshelf: split.bookshelf, table: split.table, chair: split.chair };
    let ft = cfg.keepFrameTimber;
    const kept = failKeep(ctx, furn);
    if (kept !== furn || (typeof ctx.retailCap === 'number' && split.total > ctx.retailCap)) {
      // Over the retail cap: the per-good keep on a measured fail, else the board's mix inside the cap; the planks left over go to Frame Timber.
      const capped = kept !== furn ? kept : split.alloc(Math.max(0, Math.floor(ctx.retailCap)));
      const extra = Object.keys(furn).reduce((a, k) => a + (furn[k] - capped[k]) * split.planksPerWs[k], 0);
      Object.assign(furn, capped);
      ft += Math.ceil(extra / e.wsPlanksH(e.R.ft) - 1e-9);
    }
    const rivet = Math.max(1, e.sum(e.groupsOf(e.id.ws, e.R.rivet)));
    const bench = benchWanted(v, ctx, e) ? Math.max(0, cfg.benchWorkshops) : 0;
    // A wanted Bench eats planks at its Rivet x3 rate on top of the rule's: Camps / Sawmills for them, sized as core-math sizes the rule's (the rule is unchanged).
    let camps = rule.camps, sawmills = rule.sawmills;
    if (bench > 0) {
      const m = W.idleCore.coreMath.engineModel(v.C), p = Math.max(0, rule.planksH || 0), q = p + bench * e.benchPlanksH;
      camps += Math.ceil(q * m.woodPerPlank / m.campWoodH) - Math.ceil(p * m.woodPerPlank / m.campWoodH);
      sawmills += Math.ceil(q / m.smPlanksH) - Math.ceil(p / m.smPlanksH);
    }
    return { split, furn, ft, rivet, bench, camps, sawmills, workshops: furn.bookshelf + furn.table + furn.chair + ft + rivet + bench };
  }
  // The furniture recipe the next Workshop should run (largest gap to target), or Frame Timber when furniture is at its cap.
  function nextWorkshopRecipe(e, tg) {
    let best = null;
    for (const [k] of FURN) { const gap = tg.furn[k] - e.furnNow[k]; if (gap > 0 && (!best || gap > best.gap)) best = { k, gap }; }
    if (best) return { key: best.k, r: e.R[best.k] };
    if (e.ftNow < tg.ft) return { key: 'ft', r: e.R.ft };
    return null;
  }
  const floorMissing = (e, r) => cfg.needFurnitureFloor && (FURN.some(([k]) => e.R[k].id === r.id) || r.id === e.R.bench?.id) && !e.layout(r);

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

  // ---- the director --------------------------------------------------------------------------------------------------------------
  const conversionStage = (v) => v.unlocked('Assembly Plant');   // Stage C or D
  const dir = {
    name: 'buildout', order: 40, defaults: DEFAULTS,
    furnitureSplit, nextBuildStep, targets: (v, ctx, rule) => targets(v, ctx, rule, engine(v, ctx)), benchHeld: (v, ctx, rule) => { const e = engine(v, ctx); return benchHeld(v, e, targets(v, ctx, rule, e)); }, rebalanceStep: (v, ctx) => rebalanceStep(v, ctx, engine(v, ctx)), waveState: (v, ctx) => waveState(v, ctx, engine(v, ctx)), allocate,
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
      // A Kiln this director paused that is running now was resumed by the user: hands off from then on.
      const kilnId = v.idB('Kiln');
      const mine = m.get().kilnMine ?? [];
      const resumed = mine.filter((id) => { const g = v.groups.find((x) => x.id === id); return !g || g.building !== kilnId || !g.paused; });
      if (resumed.length) m.set({ kilnMine: mine.filter((id) => !resumed.includes(id)), kilnUser: [...new Set([...(m.get().kilnUser ?? []), ...resumed])] });
      // Frame Timber the WF gate paused: one running again on Frame Timber was resumed by the user (hands off); one gone, emptied or
      // running on another recipe just drops out (a paused one on another recipe stays: ftStep resumes it).
      const ftR = v.idR('Frame Timber'), ftMine = m.get().ftMine ?? [], ftKeep = [], ftUser = [];
      for (const id of ftMine) { const g = v.groups.find((x) => x.id === id); if (g && g.count > 0 && g.paused) ftKeep.push(id); else if (g && g.recipe === ftR) ftUser.push(id); }
      if (ftKeep.length !== ftMine.length) m.set({ ftMine: ftKeep, ...(ftUser.length ? { ftUser: [...new Set([...(m.get().ftUser ?? []), ...ftUser])] } : {}) });
      const e = engine(v, ctx);
      if (e.missing) return;
      // Rebalance hysteresis (plan D3): per recipe, the direction of its gap to the board's split and when that was first seen.
      const gaps = furnGaps(v, ctx, e), old = m.get().rebal ?? {}, rebal = {};   // no board read: the times are kept as they are
      if (gaps) for (const [k, g] of Object.entries(gaps)) if (g) { const dir = g > 0 ? 'under' : 'over'; rebal[k] = old[k]?.dir === dir ? old[k] : { dir, at: ctx.now }; }
      if (gaps && JSON.stringify(rebal) !== JSON.stringify(old)) m.set({ rebal });
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
      const readout = {
        camps: e.camps + '/' + (tg?.camps ?? '?'), sawmills: e.saws + '/' + (tg?.sawmills ?? '?'), workshops: e.workshops + '/' + (tg?.workshops ?? '?'),
        furniture: tg ? FURN.map(([k, n]) => n + ' ' + e.furnNow[k] + '/' + tg.furn[k]).join(', ') + ', Frame Timber ' + e.ftNow + '/' + tg.ft + ' (' + tg.split.source + ')' : null,
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
      const sw = switchStep(v, ctx, e, tg);
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
      if (nb.pick) return done(buyAction(v, e, nb));
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
