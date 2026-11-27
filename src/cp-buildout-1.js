// ============================================================================
// CORE PLAN DIRECTOR: 5. Engine build-out and Farm conversion
// ============================================================================
// Director "buildout" (wiki/guides/core-game-plan.md 4.2-4.5, 4.8, 8.1, 11.2-11.3, 14 R8). One message (or one purchase) per step:
//   - pool tidy: Camps / Sawmills / Workshops it left in the pool (mem poolMine), or any pooled when no group outside the plan uses the
//     building, go into their group (never cdFarm's units); groups it made or named after a plan recipe get their recipe;
//   - Kiln stock gate: unpause / switch the Kiln until Glass and Concrete reach their gates, pause again after;
//   - Wooden Frame gate: pause at most cfg.keepFrameTimber Frame Timber Workshops at the WF keep line (Rivet use for cfg.ftKeepHours),
//     resume below half (plan D-3, A2);
//   - Furniture Workshop targets come from the retail allocator (window.idleCore.retailAlloc, plan B1): $/h-best Workshops per good under
//     Planks (Sawmill output + its measured error + a stock budget above plankReserve, plan B2), running Workshops (owned + buildable) and
//     smoothed demand and prices, once a Retail Store group exists; before that, or without the retail director's facts (no board), the
//     appetite / 40-30-30 split (furnitureSplit) stays as the fallback. Plan moves that idle or park Workshops wait cfg.planHoldMin;
//   - a move into a running group (switch, pool tidy, buy) waits until the power it adds is free, asking Auto utilities for it (plan R-5);
//   - Stage B-D: spare Frame Timber Workshops switch to the plan's largest gap (plan B3; fallback: the best $ per Workshop-hour), keeping 1 on Frame Timber;
//   - furniture above the plan's total (the stock budget ended, a demand cap) steps back to the pool, one per step, newest first, and stays
//     parked there until the plan has a gap (plan B2);
//   - Stage C-D: Farms go in 4 waves 3 h apart (UnassignBuildings + DemolishBuilding), only when the last wave's acres are built and running
//     and no group eats Cotton;
//   - land conversion (plan R-6, B4, convertStep): with no land to buy and the Workshops short of Planks, a group whose output nothing uses
//     becomes Camps + Sawmills (payback <= cfg.convertPaybackH; the first one asks: cfg.convertConfirmed);
//   - Camps / Sawmills at least what the plan's Workshops eat (allocator Planks target at the live floors, plan B4);
//   - build-out toward core-math landRule: a consumer only when its supplier covers it, each buy gated by acre, kit, wood (R8), bill floor
//     and the money floor; Stage C-D buys the acre too while the land rule is open, Stage B while (acre + $1,200) / $1,444 <= 20 h (plan D-1).
//   - Stage B-D: furniture Workshops follow the plan: a recipe 1+ Workshops over / under it for cfg.rebalanceHours moves one (plan D3; the
//     allocator keeps the current mix unless the plan gains more than cfg.moveGainPct);
//   - Stage D after a checkpoint pass (never on the fail path): cfg.benchWorkshops Bench Workshop(s), the 4th shelf, on the Rivet x3 floor, once
//     Concrete covers the Kiln gate + 48 h of Bench use; while a Bench group exists the Kiln gate's Concrete target rises by that use (plan D4).
// Pure helpers for tests: corePlan._buildout.furnitureSplit / alloc / nextBuildStep / waveState / waveStep; wfKeep is the keep line Core plan's reserve uses;
// alloc(v, ctx) is the plan the retail director shelves and sizes stores from.
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
  const BLOCK_SHARE = 1200, BLOCK_HOURLY = 1444;               // dollars: a block's buildings per acre, and what an engine acre earns an hour (plan D-1; blockHourly scales it to the board)

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
    ftBlockedMin: 30,            // Frame Timber above keepFrameTimber pauses when the switch to furniture stays blocked this long (plan A2)
    ftKeepMax: 19,               // ... capped here, so stock settles under 20 and E3 can hold (a Rivet Workshop takes 6 per wave start)
    rebalanceHours: 6,           // a furniture recipe's gap to the board's split must hold this long before a Workshop moves (plan D3)
    benchWorkshops: 1,           // Bench Workshops in Stage D after a checkpoint pass (wiki 4.7 step 2)
    moveGainPct: 3,              // the retail allocator moves furniture Workshops only for a gain above this (plan B1; rebalance also holds rebalanceHours)
    stockBurnHours: 24,          // Planks above plankReserve are planned to run down over this many hours with extra Workshops (plan R-4)
    stepBackHours: 4,            // ... stopped when the projected stock would reach plankReserve within this many hours (plan B2)
    stockBand: 10,               // ... and started again only once the stock is this % above plankReserve (hysteresis)
    plankReserve: 1000,          // Planks always kept, on top of other modules' reserves, the next Workshop builds and Frame Timber's keep-line need
    planHoldMin: 30,             // a step back, a park or a pool placement the plan asks for must hold this long first (no churn on a wobbling budget)
    boardSmoothHours: 2,         // the allocator plans from board prices and appetite smoothed over about this many hours (EMA)
    plankEmaHours: 2,            // the Planks model's error is measured from the stock, smoothed over about this many hours (EMA)
    convertPaybackH: 6,          // land conversion (plan R-6): a group whose output nothing uses becomes Camps + Sawmills only if this pays back within this many hours
    convertConfirmed: false,     // ... the first conversion waits for your Confirm (toast); after that conversions run on their own
    convertProtect: [],          // ... group ids or names never converted
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

  // Dollars a Workshop-hour makes on each furniture good (plan A2): board unit price x units an hour at the floor it runs (quality 0
  // scales every good alike, so it is left out). null without a readable board. The allocator (plan B1) replaces this.
  function furnValue(v, ctx, e) {
    const rows = ctx.retailBoard?.shelves?.[REGION] ?? ctx.retailBoard?.shelves?.[String(REGION)];
    if (!rows) return null;
    const val = {};
    for (const [k, n] of FURN) {
      const it = itemOf(v.C, n), r = e.R[k], row = it ? rows[it.id] : null;
      if (!(row?.price > 0) || !(it.base_value > 0)) return null;
      val[k] = it.base_value * row.price / 10000 * (r.outputs[0]?.amount ?? 1) * runsH(r, Math.max(e.rateNow(r), FLOOR.Workshop));
    }
    return val;
  }

  // ---- the retail allocator (plan B1, B2) -------------------------------------------------------------------------------------------
  // Planks kept in stock (plan B2): cfg.plankReserve, other modules' finite Planks reserves, the next cfg.kitWaveBuilds Workshop builds
  // (build items + kit), and the Planks Frame Timber needs to bring Wooden Frames up to their keep line.
  function plankReserve(v, ctx, e) {
    const pl = e.planksId, other = ctx.reserveItems?.[pl];
    const builds = amt(e.kitOf(e.id.ws, null), pl) * (cfg.kitWaveBuilds ?? 3);
    const wfShort = Math.max(0, (wfKeep(v, ctx, e) ?? 0) - v.has('Wooden Frame')) * amt(e.R.ft.inputs, pl);
    return cfg.plankReserve + (Number.isFinite(other) ? other : 0) + builds + wfShort;
  }
  // Workshops cash and acres buy now: each at its price + bill floor, with the acres it lacks (Stage C-D up to the land rule's last acre;
  // Stage B on free acres only, as nextBuildStep). Kits are nextBuildStep's check.
  function buildableWs(v, ctx, e, rule) {
    const bd = v.bld(e.id.ws), addBill = cp._billNeed(v, bd.draws?.power ?? 0) - cp._billNeed(v, 0);
    const cap = conversionStage(v) && rule ? Math.min(rule.lastAcre, ACRE_CAP) : v.acresOwned;
    let cash = v.money - (ctx.floorCents ?? 0) - cp._billNeed(v, 0), free = Math.max(0, v.freeAcres - cfg.bufferAcres), bought = 0, n = 0;
    for (; n < 100; n++) {
      const lack = Math.max(0, bd.acres - free);
      if (v.acresOwned + bought + lack > cap) break;
      let c = W.idleCore.planner.price(bd.cost, v.ownedAll('Workshop'), n) + addBill;
      for (let i = 0; i < lack; i++) c += cp._acrePriceCents(v.landBought + bought + i);
      if (cash < c) break;
      cash -= c; free += lack - bd.acres; bought += lack;
    }
    return n;
  }
  // Board price and appetite per good smoothed (EMA over about cfg.boardSmoothHours; mem board, sampled every 10 min, reset after a 6 h gap),
  // so a board that moves fast does not lock the Workshops into one phase of it (plan risk "flip-flops").
  function smoothBoard(m, mm, goods, now) {
    const o = mm.board && now >= mm.board.t && now - mm.board.t < 6 * HOUR ? mm.board : null;
    const dtH = o ? (now - o.t) / HOUR : 0, a = o ? dtH / (dtH + cfg.boardSmoothHours) : 1;
    const p = {}, ap = {};
    for (const g of goods) {
      const op = o?.p?.[g.id], oa = o?.a?.[g.id];
      p[g.id] = op > 0 ? op + a * (g.boardPrice - op) : g.boardPrice;
      ap[g.id] = oa >= 0 ? oa + a * (g.appetite - oa) : g.appetite;
    }
    if (m && (!o || now - o.t >= 600000)) m.set({ board: { t: now, p, a: ap } });
    return { p, a: ap };
  }
  // Error of the Planks model (plan B2): EMA (cfg.plankEmaHours) of the stock's measured slope less the modelled one (Sawmills - running
  // Workshops at their nominal rates) over intervals of 10 min to 1 h (mem plk; a longer gap starts over). An interval in which the model
  // changed (a move: new groups start with a burst of wave inputs) is dropped. Starts at 0, used after 3 intervals, else 0.
  function plankCorr(m, mm, stock, model, now) {
    const p = mm.plk, dtH = p ? (now - p.t) / HOUR : -1;
    if (!m) return 0;
    if (!p || dtH < 0 || dtH > 1) { m.set({ plk: { t: now, s: stock, m: model, r: p?.r ?? 0, n: 0 } }); return 0; }
    if (Math.abs(model - p.m) > 1e-6) { m.set({ plk: { ...p, t: now, s: stock, m: model } }); return p.n >= 3 ? p.r : 0; }
    if (dtH < 1 / 6) return p.n >= 3 ? p.r : 0;
    const x = (stock - p.s) / dtH - p.m, r = p.r + dtH / (dtH + cfg.plankEmaHours) * (x - p.r);
    m.set({ plk: { t: now, s: stock, m: model, r, n: p.n + 1 } });
    return p.n + 1 >= 3 ? r : 0;
  }
  // A condition a plan move needs to have held for cfg.planHoldMin (mem hold[key] = since it was first seen); false and cleared when it does not hold.
  function holdFor(ctx, key, on) {
    const m = ctx.mem?.('buildout');
    if (!m) return on;
    const h = { ...(m.get().hold ?? {}) }, now = ctx.now ?? Date.now();
    if (!on) { if (h[key] != null) { delete h[key]; m.set({ hold: h }); } return false; }
    if (h[key] == null) { h[key] = now; m.set({ hold: h }); }
    return now - h[key] >= cfg.planHoldMin * 60000;
  }
  // The plan from window.idleCore.retailAlloc, once per view (ctx._boAlloc), with byKey (Workshops per FURN key), extra (Planks/h the stock
  // budget adds), burn and reserve. Only once a Retail Store group exists: before it sells, Wooden Frames and the pre-store plan have value
  // the allocator cannot see. Inputs: the retail director's facts on a smoothed board (price x quality, appetite x 30 x share, stock), runs
  // per wave x waves/h at the furniture floor, Planks the Sawmills make less what other running Workshops eat (a gate-held one eats nothing)
  // plus the model's measured error, running furniture Workshops (a paused group is the user's: not counted) + spare Frame Timber + pooled
  // (owned) + buildable, stores. A good without its floor is out while floors are not applied here. A measured retail fail caps each shelved
  // good at its kept Workshops (as failKeep).
  // B2: the Planks stock budget, (stock when the burn started - reserve) / cfg.stockBurnHours (mem burnFrom), is off once the stock is at the
  // reserve + cfg.stepBackHours of the projected drain, and on again only cfg.stockBand % above that line (mem burn). While on, the current assignment is kept up to one Workshop's Planks over its budget.
  // null without the retail facts or a store: callers keep the appetite / 40-30-30 split (furnitureSplit) as their fallback.
  function allocOf(v, ctx, e = engine(v, ctx), rule = null) {
    if (ctx._boAlloc?.v === v) return ctx._boAlloc.al;
    const f = ctx.retail, ra = W.idleCore.retailAlloc;
    let al = null;
    if (!e.missing && ra && f?.goods && f.share != null && f.storeGroup) {
      const m = ctx.mem?.('buildout'), mm = m?.get?.() ?? {}, now = ctx.now ?? Date.now();
      const keyOf = Object.fromEntries(FURN.map(([k, n]) => [n, k]));
      const by = ctx.retailFail ? f.capDecision?.capBy ?? null : null;
      const sm = smoothBoard(m, mm, f.goods, now);
      const goods = f.goods.map((g) => {
        const k = keyOf[g.name], r = k ? e.R[k] : null;
        const uph = r ? (r.outputs[0]?.amount ?? 1) * runsH(r, Math.max(e.rateNow(r), FLOOR.Workshop)) : 0;
        const d = f.demandH({ ...g, appetite: sm.a[g.id] });
        const dem = by && g.name in by ? Math.min(d, Math.ceil(by[g.name] - 1e-9) * uph) : d;
        return { id: g.id, name: g.name, unitCents: g.unit * sm.p[g.id] / g.boardPrice, planksPerUnit: g.ppu, unitsPerWorkshopHour: uph, demandPerHour: dem,
          current: k ? e.furnRun[k] : 0, floorOk: !!r && (cfg.applyFurnitureFloor || !floorMissing(e, r)), region: REGION, stock: g.stock };
      });
      const fts = movableFt(ctx, e), ftRate = e.wsPlanksH(e.R.ft), keep = cfg.keepFrameTimber;
      const ftPaused = e.sum(fts.filter((g) => g.paused)), ftRun = e.sum(fts.filter((g) => !g.paused));
      const spare = Math.max(0, ftPaused + ftRun - keep), spareRun = Math.max(0, ftRun - Math.max(0, keep - ftPaused));
      const furnUse = FURN.reduce((a, [k]) => a + e.furnRun[k] * e.runPlanksH(e.R[k]), 0);
      const stock = v.has('Planks'), net = e.planksSupply - e.planksLive + plankCorr(m, mm, stock, e.planksSupply - e.planksLive, now);
      const supply = Math.max(0, net + furnUse + spareRun * ftRate);
      const reserve = plankReserve(v, ctx, e), line = reserve + Math.max(0, -net) * cfg.stepBackHours;
      // on again cfg.stockBand % above the line: after a step back the drain (so the line) is lower, and the burn restarts at the lower
      // rate the smaller stock gives, so the stock steps down to the reserve instead of stopping 4 h of the old drain above it
      const burn = mm.burn ? stock > line : stock >= line * (1 + cfg.stockBand / 100);
      // the burn rate is set by the stock when it started (raised if the stock grows past it), so it runs down at a steady rate and reaches the line
      const from = burn ? Math.max(stock, mm.burn ? mm.burnFrom ?? 0 : 0) : null;
      if (m && (burn !== !!mm.burn || from !== (mm.burnFrom ?? null))) m.set({ burn, burnFrom: from });
      const maxUse = Math.max(...FURN.map(([k]) => e.wsPlanksH(e.R[k])));
      const wsOwned = FURN.reduce((a, [k]) => a + e.furnRun[k], 0) + spare + e.ownPool(e.id.ws), stores = { [REGION]: v.owned('Retail Store') };
      al = ra({ goods, supply: { Planks: supply }, stock: { Planks: burn ? from : 0 }, reserve: { Planks: reserve },
        workshops: { owned: wsOwned, buildable: buildableWs(v, ctx, e, rule) },
        stores, cfg: { stockBurnHours: cfg.stockBurnHours, moveGainPct: cfg.moveGainPct, maxShelves: 4, curSlack: burn ? { Planks: maxUse } : {} } });
      // B4: Planks/h the Workshops it counts (owned, pooled, spare Frame Timber; none still to buy) eat with Planks unlimited: the chain
      // target. With the best $ per Workshop-hour (cents) and that good's Planks per Workshop-hour: the chain's $ per acre-hour (convertStep).
      const free = ra({ goods, supply: { Planks: (wsOwned + 1) * maxUse * 10 }, workshops: { owned: wsOwned, buildable: 0 }, stores, cfg: { maxShelves: 4, moveGainPct: cfg.moveGainPct } });   // the current mix kept as the allocator keeps it
      const best = goods.filter((g) => g.floorOk && g.unitsPerWorkshopHour > 0).sort((a, b) => b.unitCents * b.unitsPerWorkshopHour - a.unitCents * a.unitsPerWorkshopHour)[0];
      Object.assign(al, { byKey: Object.fromEntries(FURN.map(([k, n]) => [k, al.alloc[v.idI(n)] ?? 0])), extra: (al.budget.Planks ?? 0) - supply, burn, reserve, net,
        planksWant: goods.reduce((a, g) => a + (free.alloc[g.id] ?? 0) * g.unitsPerWorkshopHour * g.planksPerUnit, 0),
        bestWs: best ? { name: best.name, cents: best.unitCents * best.unitsPerWorkshopHour, planksH: best.unitsPerWorkshopHour * best.planksPerUnit } : null,
        // $/h the LP plans on what the Sawmills make and the stock budget, plus dPlanks/h (Workshops it counts): the marginal value of more Planks
        valueAt: (dPlanks) => ra({ goods: goods.map((g) => ({ ...g, current: 0 })), supply: { Planks: (al.budget.Planks ?? supply) + dPlanks }, workshops: { owned: wsOwned, buildable: 0 }, stores, cfg: { maxShelves: 4, moveGainPct: 0 } }).lpDollarsPerHour });
    }
    ctx._boAlloc = { v, al };
    return al;
  }
  // Planks/h a move may add: what the Sawmills make plus the stock budget and the model's measured error, less what the Workshops eat now.
  // With the allocator a gate-held group eats nothing (al.net is from running groups); the switch then counts a held source as eating nothing.
  const planksRoom = (v, ctx, e) => { const al = allocOf(v, ctx, e); return al ? al.net + al.extra : e.planksSupply - e.planksDemand; };

  // ---- reading the engine from a view ---------------------------------------------------------------------------------------------
  function engine(v, ctx) {
    const N = v.N, C = v.C, st = v.st;
    const id = { camp: v.idB('Lumber Camp'), saw: v.idB('Sawmill'), ws: v.idB('Workshop'), farm: v.idB('Farm'), kiln: v.idB('Kiln') };
    const rec = (n) => recipeOf(C, n);
    const R = { wood: rec('Fell Wood'), planks: rec('Saw Planks'), ft: rec('Assemble Wooden Frame'), rivet: rec('Assemble Iron Frame'), cotton: rec('Grow Cotton'),
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
    const furnRun = Object.fromEntries(furnKeys.map((k) => [k, sum(wsGroups.filter((g) => g.recipe === R[k].id && !g.paused))]));   // a paused furniture group is the user's
    const ftNow = sum(wsGroups.filter((g) => g.recipe === R.ft.id));
    const planksPerSaw = (R.planks.outputs[0]?.amount ?? 1) * runsH(R.planks, rateNow(R.planks));
    const woodPerSaw = amt(R.planks.inputs, woodId) * runsH(R.planks, ratePlan(R.planks, 'Sawmill'));
    const woodPerCamp = (R.wood.outputs[0]?.amount ?? 1) * runsH(R.wood, rateNow(R.wood));
    const wsPlanksH = (r) => amt(r.inputs, planksId) * runsH(r, ratePlan(r, 'Workshop'));
    const live = (g) => !g.paused && g.count > 0;
    const ftHeld = new Set(ctx.mem?.('buildout')?.get?.()?.ftMine ?? []);   // Frame Timber the WF gate paused comes back: its planks stay spoken for
    // A group on a Lab process (g.process, see corePlan view) at that process's own inputs, outputs, time and floor.
    const real = (g) => st.recipes?.[g.process] ?? C.recipes[g.recipe] ?? null;
    const perG = (gs, f) => gs.filter(live).reduce((a, g) => { const r = real(g); return a + (r ? g.count * f(r) : 0); }, 0);
    const planksSupply = perG(groupsOf(id.saw, R.planks), (r) => amt(r.outputs, planksId) * runsH(r, rateNow(r)));
    // Each group at the floor it really runs (Make Bench x3, not furniture's x5); one with no floor yet at the floor it will get.
    const runPlanksH = (r) => (layout(r) ? amt(r.inputs, planksId) * runsH(r, rateNow(r)) : wsPlanksH(r));
    const planksDemand = wsGroups.filter((g) => live(g) || (ftHeld.has(g.id) && g.count > 0)).reduce((a, g) => a + g.count * (real(g) ? runPlanksH(real(g)) : 0), 0);
    const planksLive = wsGroups.filter(live).reduce((a, g) => a + g.count * (real(g) ? runPlanksH(real(g)) : 0), 0);   // eaten now (no gate-held group)
    const woodSupply = perG(groupsOf(id.camp, R.wood), (r) => amt(r.outputs, woodId) * runsH(r, rateNow(r)));
    const woodDemand = perG(groupsOf(id.saw, R.planks), (r) => amt(r.inputs, woodId) * runsH(r, ratePlan(r, 'Sawmill')));
    const kitOf = (b, r) => [...(v.bld(b).build_items ?? []), ...((r && layout(r)?.bom) ?? v.bld(b).default_kit ?? [])];
    // Make Bench is optional (no Bench in the catalog: no Bench Workshop); it runs on the Rivet x3 floor, not v1's x5.
    R.bench = rec('Make Bench');
    const benchNow = R.bench ? sum(wsGroups.filter((g) => g.recipe === R.bench.id)) : 0;
    const benchRuns = R.bench ? runsH(R.bench, Math.max(rateNow(R.bench), BENCH_FLOOR)) : 0;
    const benchConcreteH = (n) => n * benchRuns * (R.bench ? amt(R.bench.inputs, v.idI('Concrete')) : 0);
    const benchPlanksH = R.bench ? benchRuns * amt(R.bench.inputs, planksId) : 0;
    return { id, R, ownPool, runPlanksH, benchNow, benchConcreteH, benchPlanksH, layout, rateNow, groupsOf, sum, furnNow, furnRun, ftNow, wsGroups, planksPerSaw, woodPerSaw, woodPerCamp, wsPlanksH,
      planksSupply, planksDemand, planksLive, woodSupply, woodDemand, kitOf, woodId, planksId,
      camps: v.owned('Lumber Camp'), saws: v.owned('Sawmill'), workshops: v.owned('Workshop'), farms: v.owned('Farm') };
  }
  // Wood per Camp-hour and Planks per Sawmill-hour at the floor they run (at least the plan's floor): 1,080 and 120 at x3 / x2 (plan B4).
  const chainRates = (e) => ({ campWoodH: (e.R.wood.outputs[0]?.amount ?? 1) * runsH(e.R.wood, Math.max(e.rateNow(e.R.wood), FLOOR['Lumber Camp'])),
    smPlanksH: (e.R.planks.outputs[0]?.amount ?? 1) * runsH(e.R.planks, Math.max(e.rateNow(e.R.planks), FLOOR.Sawmill)) });
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
  // Targets: Camps / Sawmills from the land rule, Workshops from the retail allocator (plan B1; on a measured fail the Workshops it cannot use
  // go to Frame Timber), else from the furniture split of the rule's planks, capped by ctx.retailCap.
  function targets(v, ctx, rule, e) {
    const al = allocOf(v, ctx, e, rule);
    const split = al ? null : furnitureSplit(ctx.retailBoard, rule.planksH, v.C);
    const furn = al ? { ...al.byKey } : { bookshelf: split.bookshelf, table: split.table, chair: split.chair };
    let ft = cfg.keepFrameTimber + (al && ctx.retailFail ? al.spareWorkshops : 0);
    const kept = al ? furn : failKeep(ctx, furn);
    if (!al && (kept !== furn || (typeof ctx.retailCap === 'number' && split.total > ctx.retailCap))) {
      // Over the retail cap: the per-good keep on a measured fail, else the board's mix inside the cap; the planks left over go to Frame Timber.
      const capped = kept !== furn ? kept : split.alloc(Math.max(0, Math.floor(ctx.retailCap)));
      const extra = Object.keys(furn).reduce((a, k) => a + (furn[k] - capped[k]) * split.planksPerWs[k], 0);
      Object.assign(furn, capped);
      ft += Math.ceil(extra / e.wsPlanksH(e.R.ft) - 1e-9);
    }
    const rivet = Math.max(1, e.sum(e.groupsOf(e.id.ws, e.R.rivet)));
    const bench = benchWanted(v, ctx, e) ? Math.max(0, cfg.benchWorkshops) : 0;
    // A wanted Bench eats planks at its Rivet x3 rate on top of the rule's: Camps / Sawmills for them, sized as core-math sizes the rule's (the rule is unchanged).
    let camps = rule.camps, sawmills = rule.sawmills, chain = null;
    if (bench > 0) {
      const m = W.idleCore.coreMath.engineModel(v.C), p = Math.max(0, rule.planksH || 0), q = p + bench * e.benchPlanksH;
      camps += Math.ceil(q * m.woodPerPlank / m.campWoodH) - Math.ceil(p * m.woodPerPlank / m.campWoodH);
      sawmills += Math.ceil(q / m.smPlanksH) - Math.ceil(p / m.smPlanksH);
    }
    // B4 chain balance: at least the Camps / Sawmills that feed the Workshops the plan has (allocator Planks target + Frame Timber, Rivet and
    // Bench use) at the live floors; the land rule still grows the engine past that with land.
    if (al) {
      // Frame Timber only while it runs: the kept group paused at the Wooden Frame keep line eats nothing (its restart burns stock above the reserve)
      const ftRun = Math.min(ft, e.sum(e.groupsOf(e.id.ws, e.R.ft).filter((g) => !g.paused)));
      // less the Planks stock budget while the stock above the reserve is burned: the stock feeds those Workshops for now (no Camp / Sawmill for them)
      const planksH = Math.max(0, al.planksWant + ftRun * e.wsPlanksH(e.R.ft) + rivet * e.runPlanksH(e.R.rivet) + bench * e.benchPlanksH - (al.burn ? al.extra : 0));
      const c = W.idleCore.coreMath.chainFor(planksH, v.C, chainRates(e));
      chain = { planksH, ...c, sawmillsNoStock: al.burn ? W.idleCore.coreMath.chainFor(planksH + al.extra, v.C, chainRates(e)).sawmills : c.sawmills };
      camps = Math.max(camps, c.camps); sawmills = Math.max(sawmills, c.sawmills);
    }
    return { split, al, chain, source: al ? 'allocator, ' + al.binding : split.source, furn, ft, rivet, bench, camps, sawmills, workshops: furn.bookshelf + furn.table + furn.chair + ft + rivet + bench };
  }
  // The furniture recipe the next Workshop should run (largest gap to target), or Frame Timber when furniture is at its cap.
  function nextWorkshopRecipe(e, tg) {
    let best = null;
    const cur = tg.al ? e.furnRun : e.furnNow;
    for (const [k] of FURN) { const gap = tg.furn[k] - cur[k]; if (gap > 0 && (!best || gap > best.gap)) best = { k, gap }; }
    if (best) return { key: best.k, r: e.R[best.k] };
    if (e.ftNow < tg.ft) return { key: 'ft', r: e.R.ft };
    return null;
  }
  const floorMissing = (e, r) => cfg.needFurnitureFloor && (FURN.some(([k]) => e.R[k].id === r.id) || r.id === e.R.bench?.id) && !e.layout(r);

