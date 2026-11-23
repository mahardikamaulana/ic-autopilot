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

