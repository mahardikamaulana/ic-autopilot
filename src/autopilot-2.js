// continues the autopilot closure from autopilot-1.js (same try / IIFE)
  // ---- socket listener ------------------------------------------------------
  // Shared with CD Farm (core.sock): command confirmation counters and the server tick.
  const seeTick = core.seeTick, nowTick = core.nowTick;

  // ---- state ----------------------------------------------------------------

  // (core.walk: one cached walk of the game's React state)

  // The client's catalog arrays are NOT indexed by id (items[41] is Light Frame, not Wooden
  // Frame). Re-key by id once per catalog object.
  const normCache = new WeakMap();
  function normalize(raw) {
    if (raw.byId) return raw;
    if (normCache.has(raw)) return normCache.get(raw);
    const key = (arr) => Object.fromEntries((arr ?? []).map((x) => [x.id, x]));
    const pieces = Object.fromEntries([...(raw.machines ?? []), ...(raw.belts ?? [])].map((x) => [x.item, x]));
    const c = { byId: true, items: key(raw.items), buildings: key(raw.buildings), recipes: key(raw.recipes), techs: raw.techs ?? [], pieces };
    normCache.set(raw, c);
    return c;
  }

  // Everything decide() needs, from raw game state. Pure: also used by the offline simulator.
  function snapshot(st, rawCatalog, tickNow) {
    const catalog = normalize(rawCatalog);
    resolveIds(catalog);
    const bld = (b) => catalog.buildings[b] ?? { name: `building ${b}`, cost: 0, acres: 1, build_items: [] };
    const recipe = (r) => catalog.recipes[r];
    const allGroups = Object.values(st.groups ?? {});
    const groups = Object.entries(st.groups ?? {}).map(([id, g]) => ({ id: +id, ...g }))
      .filter((g) => (g.region ?? REGION) === REGION);
    const pool = st.building_pool?.[REGION] ?? {};
    const stock = st.stock?.[REGION] ?? {};
    // Build / demolish queues (st.construction, patch 2026-11-24): every queued build and demolition, all regions, counts in
    // the price, and this region's queued ones hold their acres. Without the planner (offline sim) the queues are not counted.
    const q = (st.construction && core.planner?.queued?.({ st, catalog, region: REGION })) || { owned: {}, acres: 0 };
    const queuedHere = {};
    for (const x of st.construction?.builds ?? []) if ((x.region ?? REGION) === REGION) queuedHere[x.building] = (queuedHere[x.building] ?? 0) + x.count;

    // This region's buildings, counting queued builds (so a busy build queue is neither bought twice nor a failed build).
    const owned = (b) => groups.filter((g) => g.building === b).reduce((a, g) => a + g.count, 0) + (pool[b] ?? 0) + (queuedHere[b] ?? 0);
    // What the game prices the next one by: all regions, plus queued builds and demolitions (wiki formulas.md, Building cost).
    const ownedAll = (b) => allGroups.filter((g) => g.building === b).reduce((a, g) => a + g.count, 0)
      + Object.values(st.building_pool ?? {}).reduce((a, p) => a + (p?.[b] ?? 0), 0) + (q.owned[b] ?? 0);
    const equipped = (b) => groups.filter((g) => g.building === b).reduce((a, g) => a + (g.equipped ?? 0), 0);
    const running = (b, r) => groups.filter((g) => g.building === b && g.recipe === r).reduce((a, g) => a + g.count, 0);
    const runningEquipped = (b, r) => groups.filter((g) => g.building === b && g.recipe === r && !g.paused)
      .reduce((a, g) => a + (g.equipped ?? 0), 0);
    let acresUsed = 0;
    for (const g of groups) acresUsed += bld(g.building).acres * g.count;
    for (const [b, n] of Object.entries(pool)) acresUsed += bld(+b).acres * n;
    acresUsed += q.acres;
    const landBought = st.land_bought?.[REGION] ?? 0;
    const drawOf = (b) => bld(b).draws?.power ?? 0;
    const powerNeed = groups.filter((g) => !g.paused).reduce((a, g) => a + drawOf(g.building) * g.count, 0);
    const powerHave = st.subscriptions?.[REGION]?.power ?? 0;
    const inbound = {};
    // A shipment to the Exchange (to_exchange, patch 2026-11-25) leaves stock; it is not inbound.
    for (const s of st.shipments ?? []) if (s.amount > 0 && !s.returning && s.inbound !== false && !s.to_exchange) inbound[s.item] = (inbound[s.item] ?? 0) + s.amount;
    // Goods bought from players land at this region's Exchange (st.exchange[region][item].units) and can't be used there
    // until withdrawn, or shipped home by the game when auto_deliver lists the region (the client shows deliveries_due
    // as "N to deliver" on those same units, so they are not added again).
    const exch = st.exchange?.[REGION] ?? {};
    const atExchange = (item) => exch[item]?.units ?? 0;
    const autoDeliver = (st.auto_deliver ?? []).includes(REGION);
    // Floor kit per building: the active layout's bill of materials for that recipe, else the default kit.
    const kitFor = (b, r) => st.layouts?.[r]?.bom ?? bld(b).default_kit ?? [];
    const items = st.items ?? {};
    return {
      st, catalog, bld, recipe, groups, pool, stock, items, inbound, atExchange, autoDeliver, kitFor, landBought, acresUsed,
      owned, ownedAll, equipped, running, runningEquipped, drawOf, powerNeed, powerHave, tickNow,
    };
  }

  // Derived values that need poolRecipe (defined with the plan below) are added here.
  function enrich(s) {
    const { st, groups, pool, recipe, kitFor, items, stock } = s;
    const kitOwed = {};
    const owe = (list, n) => { for (const k of list) kitOwed[k.item] = (kitOwed[k.item] ?? 0) + k.amount * n; };
    for (const g of groups) if (g.count > (g.equipped ?? 0)) owe(kitFor(g.building, g.recipe), g.count - (g.equipped ?? 0));
    // Items made at home by equipped, running groups; what they eat per minute; starved groups.
    const madeHere = new Set(), eatPerMin = {}, makePerMin = {}, starved = [];
    for (const g of groups) {
      if (!(g.equipped > 0) || g.paused || g.recipe == null) continue;
      const r = recipe(g.recipe);
      if (!r) continue;
      for (const o of r.outputs) madeHere.add(o.item);
      const rate = st.layouts?.[g.recipe]?.fx?.rate ?? 1; // runs per wave from the floorplan
      for (const i of r.inputs) eatPerMin[i.item] = (eatPerMin[i.item] ?? 0) + i.amount * g.equipped * rate * 120 / r.ticks;
      for (const o of r.outputs) makePerMin[o.item] = (makePerMin[o.item] ?? 0) + o.amount * g.equipped * rate * 120 / r.ticks;
      if ((g.work ?? []).some((w) => w.inputs_pct != null && w.inputs_pct < 100)) starved.push(g);
    }
    Object.assign(s, {
      kitOwed, madeHere, eatPerMin, makePerMin, starved,
      money: items[MONEY] ?? 0, cd: items[CD] ?? 0,
      // Regional stock first; global items (CD, MD, Logistics Data) live in items.
      has: (item) => stock[item] ?? items[item] ?? 0,
      totalBuildings: groups.reduce((a, g) => a + g.count, 0) + Object.values(pool).reduce((a, n) => a + n, 0),
      unlocked: (b) => b === B.CAMP || b === B.FARM || (st.unlocked_buildings ?? []).includes(b),
      acresOwned: STARTER_ACRES + s.landBought,
      freeAcres: Math.max(0, STARTER_ACRES + s.landBought - s.acresUsed),
      // Courier (one run per 10,000 CU, then a turnaround cooldown). Unknown tick → assume free:
      // a run that loses the race is harmless (see finish), it just waits for the courier.
      courierReadyAt: st.courier_ready_at ?? 0,
      courierWaitTicks: s.tickNow > 0 ? Math.max(0, (st.courier_ready_at ?? 0) - s.tickNow) : 0,
      courierFree: (s.tickNow === 0 || s.tickNow >= (st.courier_ready_at ?? 0)) && nowMs() >= courierHoldUntil,
      research: st.research, queue: st.research_queue ?? [],
      researchIdle: !st.research && !(st.research_queue ?? []).length,
      // Premium corps can queue unlocks (QueueTech); only when the state carries both fields, else the old one-at-a-time path.
      canQueue: !!st.premium && Array.isArray(st.research_queue),
      nextGroupId: st.next_group_id ?? 0,
      shipId: st.next_shipment_id ?? 0, standing: st.standing_fills ?? {},
      mutTick: st.ssi?.last_user_mutation_tick ?? 0,
    });
    for (const [b, n] of Object.entries(pool)) { const r = poolRecipe(s, +b); if (n && r != null) owe(kitFor(+b, r), poolTake(s, +b, n)); }
    return s;
  }

  function fullSnapshot(st, catalog, deals, orders, tickNow, engine = null) {
    const s = snapshot(st, catalog, tickNow);
    s.engine = engine;
    // A board missing from React state is unknown, not empty (Market page not mounted, reload).
    s.dealsKnown = Array.isArray(deals);
    s.ordersKnown = Array.isArray(orders);
    s.deals = (deals ?? []).filter((d) => d.region === REGION);
    s.orders = (orders ?? []).filter((o) => o.region === REGION && o.poster !== st.ssi?.corp_id);
    s.myOrders = (orders ?? []).filter((o) => o.region === REGION && o.poster === st.ssi?.corp_id);
    return enrich(s);
  }

  function read(fresh = false) {
    const { ws, st, catalog, deals, orders, engine } = core.walk(fresh);
    if (!st || !catalog) return null;
    seeTick(st.ssi?.last_user_mutation_tick);
    const s = fullSnapshot(st, catalog, deals, orders, nowTick(), engine);
    s.ws = ws; s.wsOpen = ws?.readyState === 1;
    // Other players' orders are on the board only while a full-region board filter is set and answered (Goods tab open,
    // or core.orderBook subscribed); without one the list holds only your own, so it is not loaded. A loaded book may
    // hold only your own orders, or none (the walk finds no empty array: s.orders is [] then).
    if (core?.orderBook && s.wsOpen) s.ordersKnown = core.orderBook.live(REGION);
    s.autoPower = W.autoUtil?.conf?.power?.on === true;   // Auto utilities owns power while on (it subscribes the running load)
    return s;
  }

  // ---- prices -----------------------------------------------------------------

  const buildCost = (s, b) => Math.round(s.bld(b).cost * (20 + s.ownedAll(b)) / 20);
  // Cents per minute one more building on recipe r earns at the current floor rate: outputs at the best Heartland bid (or base
  // value while the corp eats the item itself), less its inputs at the same values. 0 = not known (no bid, nothing eats it).
  function unitValue(s, item) {
    let v = 0;
    for (const d of s.deals ?? []) if (d.side === 'Sell' && d.item === item) v = Math.max(v, d.price / d.amount);
    return Math.max(v, s.eatPerMin[item] > 0 ? s.catalog.items[item]?.base_value ?? 0 : 0);
  }
  function incomePerMin(s, r) {
    const rc = r != null && s.recipe(r);
    if (!rc) return 0;
    const runs = (s.st.layouts?.[r]?.fx?.rate ?? 1) * 120 / rc.ticks;
    let v = 0;
    for (const o of rc.outputs) v += o.amount * unitValue(s, o.item);
    for (const i of rc.inputs) v -= i.amount * unitValue(s, i.item);
    return Math.max(0, v * runs);
  }
  function acrePrice(n) { let p = FIRST_ACRE; for (let i = 0; i < n; i++) p = Math.floor(p * 41 / 40); return p; }
  function landCost(s, n) { let c = 0; for (let i = 0; i < n; i++) c += acrePrice(s.landBought + i); return c; }
  // No floor before anything draws power (the plan spends down to ~$18 at the start); then
  // max($100, billHours × $10/MW per 10 min), counting a powered building about to be added.
  function moneyFloor(s, extraMW = 0) {
    const mw = Math.max(s.powerHave, s.powerNeed) + extraMW;
    return mw > 0 ? Math.max(10000, mw * 1000 * 6 * cfg.billHours) : 0;
  }
  // " — nothing is making it (…)" when no running group produces the item.
  function whyNoneMade(s, item) {
    if (s.madeHere.has(item)) return '';
    const makers = s.groups.filter((g) => s.recipe(g.recipe)?.outputs.some((o) => o.item === item));
    if (!makers.length) return '';
    const paused = makers.filter((g) => g.paused);
    if (paused.length) return ` — nothing is making it: "${paused[0].name}" is paused${userPaused.has(paused[0].id) ? ' by you' : ''}`;
    return ` — nothing is making it: "${makers[0].name}" has no floor kit yet`;
  }
  // "$1,234.5": same text as toLocaleString('en-US', { maximumFractionDigits: 2 }) without its cost (it was 30% of a simulation).
  const usd = (c) => {
    if (!Number.isFinite(c)) return '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const cents = Math.round(Math.abs(c)), whole = Math.floor(cents / 100), rem = cents % 100;
    let s = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (rem) s += '.' + (rem < 10 ? '0' + rem : rem % 10 ? rem : rem / 10);
    return '$' + (c < 0 && cents ? '-' : '') + s;
  };
  const iname = (s, i) => s.catalog.items[i]?.name ?? `item ${i}`;
  const bname = (s, b) => s.bld(b)?.name ?? `building ${b}`;

  // ---- plan data ----------------------------------------------------------------

  // Techs the plan spends CD on, in order (golden rule 5). `gate` adds extra conditions.
  const techPlan = () => [
    { b: B.SAWMILL, phase: 2 },
    { b: B.WORKSHOP, phase: 3, gate: workshopGate },
    { b: B.MINE, phase: 4 },
    { b: B.QUARRY, phase: 4 },
    { b: B.SMELTER, phase: 4 },
    { b: B.FACTORY, phase: 5 },
    { b: B.KILN, phase: 5 },
    { b: B.PAPER_MILL, phase: 5 },
    { b: B.LAB, phase: 5 },
    ...(cfg.dispatchOffice ? [{ b: B.DISPATCH, phase: 5, optional: true }] : []),
  ];

  // Workshop unlock: 205 Planks on hand, or the prototype in stock and the build Planks (+ kit) made by the Sawmills during the research.
  function workshopGate(s) {
    if (s.has(PLANKS) >= cfg.workshopPlanks) return true;
    const proto = (s.bld(B.WORKSHOP).build_items ?? []).find((i) => i.item === PLANKS)?.amount ?? 0;
    const tech = s.catalog.techs.find((t) => t.building === B.WORKSHOP);
    const net = (s.makePerMin[PLANKS] ?? 0) - (s.eatPerMin[PLANKS] ?? 0);
    if (tech && proto > 0 && s.has(PLANKS) >= proto && s.has(PLANKS) - proto + net * tech.ticks / 120 >= cfg.workshopPlanks - proto) return true;
    return `need ${cfg.workshopPlanks} Planks on hand (or ${proto} and enough Sawmill output during the research)`;
  }

  // earlyGame.offline(): for a few minutes an idle research slot starts the longest plan unlock that is ready.
  let longUnlockUntil = 0;
  function longestReady(s) {
    if (!s.researchIdle) return null;
    let best = null;
    for (const t of techPlan()) {
      const tech = s.catalog.techs.find((x) => x.building === t.b);
      if (!tech || s.unlocked(t.b) || s.cd < tech.cost || (tech.requires != null && !s.unlocked(tech.requires))) continue;
      if ((t.gate ? t.gate(s) : true) !== true || (s.bld(t.b).build_items ?? []).some((i) => s.has(i.item) < i.amount)) continue;
      if (!best || tech.ticks > best.ticks) best = { t, ticks: tech.ticks };
    }
    return best?.t ?? null;
  }

  function nextTech(s) {
    if (coreOwns()) return null;   // unlocks are Core plan's after the hand-off (no StartTech, prototype parts or CD need from here)
    if (nowMs() < longUnlockUntil) { const t = longestReady(s); if (t) return t; }
    for (const t of techPlan()) {
      if (s.unlocked(t.b)) continue;
      if (s.research?.building === t.b || s.queue.some((q) => q.building === t.b)) return null; // in progress
      return t;
    }
    return null;
  }
  // Premium: the next plan unlock that is neither running nor queued (QueueTech), while the queue has room (5 incl. the running one).
  function nextQueueable(s) {
    if (coreOwns() || !s.canQueue || s.researchIdle || 5 - s.queue.length - (s.research ? 1 : 0) <= 0) return null;
    return techPlan().find((t) => !s.unlocked(t.b) && s.research?.building !== t.b && !s.queue.some((q) => q.building === t.b)) ?? null;
  }
  const pendingTech = (s, b) => s.research?.building === b || s.queue.some((q) => q.building === b);

  function sawTarget(s) {
    if (!(s.unlocked(B.WORKSHOP) || s.research?.building === B.WORKSHOP)) return s.totalBuildings >= 50 ? 3 : 1;
    // Enough Sawmills for what the running groups eat (Frame Timber x5 eats 5× the Planks),
    // plus 25% so Planks build up for Workshops and prototypes. A Saw Planks run makes 1 Plank
    // per minute per building, times the floorplan's runs per wave.
    const perSawmill = s.st.layouts?.[R.SAW_PLANKS]?.fx?.rate ?? 1;
    const eat = s.eatPerMin[PLANKS] ?? 0;
    // Only grow while Plank stock is under 1 hour of use (a big stockpile can carry the gap).
    const forDemand = s.has(PLANKS) >= eat * 60 ? 0 : Math.ceil(eat * 1.25 / perSawmill);
    return Math.max(cfg.sawmills, 2 * cfg.workshops, forDemand);
  }

  // Iron / Coal Mines (like sawTarget): enough for what the planned Smelters eat on Iron Sheet at the current floor rates,
  // at least cfg.ironMines / cfg.coalMines. Iron Sheet takes 10 ore + 5 coal per 180 s, a mine 2 per 120 s / 90 s: 4 / 2 at equal rates.
  function mineTarget(s, r) {
    const min = r === R.MINE_IRON ? cfg.ironMines : cfg.coalMines;
    const sheet = s.recipe(R.IRON_SHEET), mine = s.recipe(r), out = mine?.outputs?.[0];
    const per = out && sheet?.inputs.find((i) => i.item === out.item)?.amount;
    if (!per) return min;
    const rate = (x) => s.st.layouts?.[x]?.fx?.rate ?? 1;
    const smelters = Math.max(cfg.smelters, s.running(B.SMELTER, R.IRON_SHEET));
    const eat = smelters * rate(R.IRON_SHEET) * per / sheet.ticks, make = rate(r) * out.amount / mine.ticks;
    return Math.max(min, Math.ceil(eat / make - 1e-9));
  }
  // Gold Mines: cfg.goldMines, or (Infinity = auto) up to GOLD_AUTO while a plan unlock still needs CD.
  const GOLD_AUTO = 10;
  const goldTarget = (s) => (Number.isFinite(cfg.goldMines) ? cfg.goldMines : techPlan().some((t) => !t.optional && !s.unlocked(t.b)) ? GOLD_AUTO : 0);
  function mineRecipe(s) {
    if (s.running(B.MINE, R.MINE_IRON) < mineTarget(s, R.MINE_IRON)) return R.MINE_IRON;
    if (s.running(B.MINE, R.MINE_COAL) < mineTarget(s, R.MINE_COAL)) return R.MINE_COAL;
    return s.running(B.MINE, R.MINE_GOLD) < goldTarget(s) ? R.MINE_GOLD : null;   // a Mine the plan doesn't need stays in the pool
  }
  const smelting = (s) => s.runningEquipped(B.SMELTER, R.IRON_SHEET) > 0;
  // A Workshop the plan doesn't need stays in the pool for whichever group (Core plan's) wants it.
  function workshopRecipe(s) {
    if (s.running(B.WORKSHOP, R.FRAME_TIMBER) < cfg.workshops) return R.FRAME_TIMBER;
    if (smelting(s) && s.running(B.WORKSHOP, R.RIVET) < cfg.ironFrameWorkshops) return R.RIVET;
    return null;
  }
  // Kilns: Autopilot keeps cfg.kilns on Concrete; any other Kiln is Core plan's and stays unassigned.
  const kilnFree = (s) => Math.max(0, cfg.kilns - s.running(B.KILN, R.MIX_CONCRETE));
  const poolTake = (s, b, n) => (b === B.KILN ? Math.min(n, kilnFree(s)) : n);
  function poolRecipe(s, b) {
    if (b === B.KILN) return kilnFree(s) > 0 ? R.MIX_CONCRETE : null;
    return b === B.MINE ? mineRecipe(s) : b === B.WORKSHOP ? workshopRecipe(s) : TASK[b];
  }
  // Unassigned Workshops count toward the recipe they'll be given.
  const workshopPool = (s, r) => ((s.pool[B.WORKSHOP] ?? 0) > 0 && workshopRecipe(s) === r ? s.pool[B.WORKSHOP] : 0);

  // Plan buildings still wanted, in priority order.
  function criticalTargets(s) {
    const out = [];
    const add = (b, recipe, target, have) => { if (s.unlocked(b) && have < target) out.push({ b, recipe, target, have }); };
    add(B.SAWMILL, R.SAW_PLANKS, sawTarget(s), s.owned(B.SAWMILL));
    add(B.WORKSHOP, R.FRAME_TIMBER, cfg.workshops, s.running(B.WORKSHOP, R.FRAME_TIMBER) + workshopPool(s, R.FRAME_TIMBER));
    add(B.MINE, R.MINE_IRON, mineTarget(s, R.MINE_IRON), s.running(B.MINE, R.MINE_IRON));
    add(B.MINE, R.MINE_COAL, mineTarget(s, R.MINE_COAL), s.running(B.MINE, R.MINE_COAL));
    add(B.QUARRY, R.LIMESTONE, cfg.quarries, s.owned(B.QUARRY));
    add(B.SMELTER, R.IRON_SHEET, cfg.smelters, s.owned(B.SMELTER));
    add(B.KILN, R.MIX_CONCRETE, cfg.kilns, s.owned(B.KILN));
    add(B.LAB, null, cfg.labs, s.owned(B.LAB)); // no recipe: Core plan's Lab group takes it from the pool
    // Phase 5: Iron Frames once Iron Sheet is being made.
    if (smelting(s)) add(B.WORKSHOP, R.RIVET, cfg.ironFrameWorkshops, s.running(B.WORKSHOP, R.RIVET) + workshopPool(s, R.RIVET));
    const basicsDone = s.running(B.MINE, R.MINE_IRON) >= mineTarget(s, R.MINE_IRON) && s.running(B.MINE, R.MINE_COAL) >= mineTarget(s, R.MINE_COAL)
      && s.owned(B.QUARRY) >= cfg.quarries;
    if (basicsDone) add(B.MINE, R.MINE_GOLD, goldTarget(s), s.running(B.MINE, R.MINE_GOLD));
    return out;
  }

  // ---- floorplans ----------------------------------------------------------------

  // Best known designs (found with the game's scorer; see wiki/dev/floorplan-search.md).
  // Cells as "x,y:item:rot". Pieces: 113 Furnace, 114 Cutter, 116 Assembler, 121 Digging Eq.,
  // 122 Field Eq., 123 Conveyor, 126 Splitter, 127 Merger, 128 Crossing.
  // Library designs never change: unpack each string once and freeze it, so cellsKey can remember its key too.
  const unpackCache = new Map();
  const unpack = (str) => {
    let o = unpackCache.get(str);
    if (!o) {
      o = Object.freeze(Object.fromEntries(str.split(' ').map((t) => {
        const [x, y, item, rot] = t.split(/[,:]/).map(Number);
        return [`${x},${y}`, Object.freeze({ item, rot })];
      })));
      unpackCache.set(str, o);
    }
    return o;
  };
  const X3_MERGE = (eq) => unpack(`0,0:${eq}:0 0,1:${eq}:0 1,0:123:0 1,1:123:0 2,0:127:0 2,1:123:3 3,0:123:0 4,0:123:0 4,1:${eq}:0`);
  const SMELT_X3 = '0,0:123:1 0,1:127:1 0,2:123:1 0,3:123:0 1,0:113:0 1,2:123:3 1,3:126:0 2,3:123:0 3,0:123:0 3,2:123:0 3,3:126:0 4,0:123:0 4,1:113:0 4,3:123:0 5,0:123:0 5,3:123:0 6,0:123:0 6,1:123:0 6,2:113:0 7,0:123:0 7,1:123:0';
  const isLive = () => running && !cfg.dryRun;   // sending live actions: what `busy` reports and what the reserve registry asks
  const WORKSHOP_V1 = core.floorDesigns.workshopV1;
  const RIVET_X3 = core.floorDesigns.rivetX3;
  const FURNITURE_V1 = new Set(['Make Bookshelf', 'Make Table', 'Make Chair']);   // one-input Workshop recipes of the core plan (rate 5)
  const FURNITURE_RIVET = new Set(['Make Bench', 'Make Desk']);                  // two-input ones (rate 3)
  const FLOOR_LIBRARY = [
    { // proven max on every 5x2 floor with no inputs (26,864 layouts scored)
      name: 'x3 merge', rate: 3,
      fits: (s, r) => {
        const rc = s.recipe(r), b = rc && s.bld(rc.building);
        if (!rc || rc.inputs.length || b.floor_w !== 5 || b.floor_h !== 2) return null;
        return b.operations?.includes('Extract') ? unpack(core.floorDesigns.mineX3) : b.operations?.includes('Cultivate') ? X3_MERGE(122) : null;
      },
    },
    { name: 'Saw x2', rate: 2, recipes: ['Saw Planks'], // proven max on the 6x2 Sawmill
      cells: '0,0:123:1 0,1:123:0 1,0:123:0 1,1:126:0 2,0:123:0 2,1:123:0 3,0:114:0 3,1:114:0 5,0:123:0 5,1:123:0' },
    { name: 'Smelt x3', rate: 3, recipes: ['Roll Iron Sheet', 'Roll Steel Sheet', 'Draw Copper Wire'],
      cells: core.floorDesigns.smeltX3 },
    { name: 'Kiln x3', rate: 3, recipes: ['Mix Concrete', 'Blow Glass'], cells: SMELT_X3 }, // Mix Concrete, Blow Glass
    { name: 'Frame Timber x5', rate: 5, recipes: ['Frame Timber'], cells: WORKSHOP_V1 },
    // Scored with the game's engine on 2026-11-22: x5 on Make Bookshelf / Table / Chair. Layouts are per recipe, so each gets its own
    // EditLayout; the live scorer (engineRate) still decides, the library rate is only a fallback when no scorer is reachable.
    { name: 'Workshop v1 x5', rate: 5, fits: (s, r) => (FURNITURE_V1.has(s.recipe(r)?.name) ? unpack(WORKSHOP_V1) : null) },
    { name: 'Rivet x3', rate: 3, recipes: ['Rivet Iron Frame'], cells: RIVET_X3 },
    // Scored x3 on Make Bench and Make Desk (2026-11-22).
    { name: 'Rivet x3 (two inputs)', rate: 3, fits: (s, r) => (FURNITURE_RIVET.has(s.recipe(r)?.name) ? unpack(RIVET_X3) : null) },
  ];

  // Only a frozen set of cells (a library design) can be remembered: the game's own cells may change in place.
  const keyCache = new WeakMap();
  const cellsKey = (cells) => {
    const frozen = cells && Object.isFrozen(cells);
    if (frozen) { const k = keyCache.get(cells); if (k !== undefined) return k; }
    const k = JSON.stringify(Object.entries(cells ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    if (frozen) keyCache.set(cells, k);
    return k;
  };
  // Parts per building = sum of each piece's materials (matches the game's bom on every saved design).
  function bomOf(s, cells) {
    const out = {};
    for (const c of Object.values(cells ?? {})) for (const m of s.catalog.pieces?.[c.item]?.materials ?? []) out[m.item] = (out[m.item] ?? 0) + m.amount;
    return out;
  }
  const listToMap = (list) => Object.fromEntries((list ?? []).map((i) => [i.item, i.amount]));

  // The game's scorer, cached (it can crash after ~500k calls; a failure turns it off for the session).
  const scoreCache = new Map();
  let scorerBroken = false;
  function engineRate(s, r, cells) {
    if (!s.engine || scorerBroken) return null;
    const k = `${r}|${cellsKey(cells)}`;
    if (scoreCache.has(k)) return scoreCache.get(k);
    try {
      const out = s.engine.evaluateLayout(r, JSON.stringify(cells));
      const rate = (typeof out === 'string' ? JSON.parse(out) : out)?.fx?.rate ?? null;
      if (scoreCache.size >= 20000) scoreCache.clear();   // bounded: a long session scores many distinct layouts
      scoreCache.set(k, rate);
      return rate;
    } catch { scorerBroken = true; return null; }
  }

  // Every running task: current plan vs. the best candidate. Memoised per snapshot.
  function floorPlans(s) {
    if (s._floors) return s._floors;
    const tasks = new Map();
    for (const g of s.groups) if (g.recipe != null && g.count > 0) tasks.set(g.recipe, (tasks.get(g.recipe) ?? 0) + g.count);
    const out = [];
    for (const [r, buildings] of tasks) {
      const rc = s.recipe(r);
      if (!rc) continue;
      const lay = s.st.layouts?.[r];
      const curBom = lay?.bom ? listToMap(lay.bom) : listToMap(s.bld(rc.building).default_kit);
      const cur = { name: lay ? 'current plan' : 'default plan', rate: lay?.fx?.rate ?? (lay ? engineRate(s, r, lay.cells) : null) ?? 1, key: lay ? cellsKey(lay.cells) : null };
      const cands = [];
      for (const e of FLOOR_LIBRARY) {
        const cells = e.fits ? e.fits(s, r) : e.recipes.includes(rc.name) ? unpack(e.cells) : null;
        if (cells) cands.push({ name: e.name, cells, known: e.rate });
      }
      for (const [name, d] of Object.entries(s.st.designs?.[r] ?? {})) cands.push({ name: `saved "${name}"`, cells: d.cells, known: d.fx?.rate ?? null });
      let best = null;
      for (const c of cands) {
        const scored = engineRate(s, r, c.cells);
        c.rate = scored ?? c.known ?? 0;          // the live scorer wins over remembered rates
        c.scored = scored != null;
        c.bom = bomOf(s, c.cells);
        c.key = cellsKey(c.cells);
        c.value = Object.entries(c.bom).reduce((a, [i, n]) => a + n * (s.catalog.items[i]?.base_value ?? 0), 0);
        if (!best || c.rate > best.rate || (c.rate === best.rate && c.value < best.value)) best = c;
      }
      const upgrade = !!best && best.rate > cur.rate && best.key !== cur.key;
      const delta = {};
      if (upgrade) for (const [i, n] of Object.entries(best.bom)) { const d = (n - (curBom[i] ?? 0)) * buildings; if (d > 0) delta[i] = d; }
      out.push({ r, task: rc.name, building: rc.building, buildings, cur, best, upgrade, delta });
    }
    s._floors = out;
    return out;
  }

  // An upgrade goes only when every part it adds, for every building on the task, is in stock.
  // Returns null when it can go, else what's missing (floorPartBuys tries the player market).
  function floorBlock(s, f) {
    const short = Object.entries(f.delta).filter(([i, n]) => s.has(+i) < n);
    if (!short.length) return null;
    return { why: `waiting for parts: ${short.map(([i, n]) => `${Math.floor(s.has(+i))}/${n} ${iname(s, +i)}`).join(', ')}`, short };
  }

  // Home-made parts for a waiting upgrade are kept back from selling so they can build up.
  function floorReserve(s, item) {
    if (!cfg.floorUpgrades || !s.madeHere.has(item)) return 0;
    let r = 0;
    for (const f of floorPlans(s)) if (f.upgrade && floorBlock(s, f)) r += f.delta[item] ?? 0;
    return r;
  }

  function* floorActions(s) {
    if (!cfg.floorUpgrades) return;
    for (const f of floorPlans(s)) {
      if (!f.upgrade) continue;
      const label = `floorplan ${f.task}: x${f.cur.rate} → x${f.best.rate} (${f.best.name}${f.best.scored ? ', scored live' : ''}) on ${f.buildings} building(s)`;
      const block = floorBlock(s, f);
      if (block) {
        for (const [i, n] of block.short) {
          yield* withdrawActions(s, +i, n, `parts for ${f.task} floorplan`);
          yield* floorPartBuys(s, +i, n - s.has(+i) - (s.inbound[+i] ?? 0) - s.atExchange(+i), `parts for ${f.task} floorplan`);
        }
        yield { wait: `${label}: ${block.why}` };
        continue;
      }
      const key = f.best.key, cells = f.best.cells, r = f.r;
      const parts = Object.entries(f.delta).map(([i, n]) => `${n} ${iname(s, +i)}`).join(', ') || 'no extra parts';
      yield withMeta({ r, rate: f.best.rate }, act(`floor:${r}`, `${label}, uses ${parts}`,
        { msg: { type: 'EditLayout', recipe: r, cells }, until: (x) => cellsKey(x.st.layouts?.[r]?.cells) === key }));
    }
  }

  function floorTable(s) {
    return floorPlans(s).map((f) => {
      const block = f.upgrade ? floorBlock(s, f) : null;
      return {
        task: f.task, buildings: f.buildings, now: `x${f.cur.rate}`, best: `x${f.best?.rate ?? '?'}`,
        plan: f.best?.name ?? '—', scored: f.best?.scored ? 'live' : 'known',
        parts: f.upgrade ? Object.entries(f.delta).map(([i, n]) => `${n} ${iname(s, +i)}`).join(', ') || '—' : '—',
        status: !f.upgrade ? '✓ at best' : block ? block.why : 'ready to apply',
      };
    });
  }

  // Plan done (the hand-off to Core plan): every plan unlock is in and the core buildings exist, whatever route the corp took.
  // Frame Timber / Iron Frame running and 16 Iron Frames stay plan targets, not hand-off conditions.
  const CORE_BUILDINGS = () => [B.SAWMILL, B.WORKSHOP, B.MINE, B.QUARRY, B.KILN, B.LAB];
  function planDone(s) {
    return techPlan().every((t) => t.optional || s.unlocked(t.b)) && CORE_BUILDINGS().every((b) => s.owned(b) >= 1);
  }

  function phaseOf(s) {
    if (planDone(s)) return 'done';   // first: a late corp may have demolished its camps or never smelted
    if (s.owned(B.CAMP) + s.owned(B.FARM) < 2) return 1;
    if (!s.unlocked(B.SAWMILL) || s.owned(B.SAWMILL) < 1 || s.acresUsed < STARTER_ACRES) return 2;
    if (!s.unlocked(B.WORKSHOP)) return 3;
    return smelting(s) ? 5 : 4;
  }

