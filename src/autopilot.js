// ============================================================================
// 2. AUTOPILOT
// ============================================================================
// @@MODULE early-game (test/early-game-sim.js evals everything from this line down)
//
// IdleCorp early-game autopilot: plays wiki/early-game-plan.md, Phase 1 → Phase 5, over the game WebSocket.
// Install as a userscript (Tampermonkey / Violentmonkey) and open "Autopilot" in the game's sidebar,
// or paste into the DevTools console on https://idlecorp.net (logged in). Console API:
//
//   earlyGame.status()              // current phase, plan checklist, blockers, starved groups
//   earlyGame.plan()                 // the next action and why (sends nothing)
//   earlyGame.start()                // DRY RUN by default: logs actions, sends nothing
//   earlyGame.start({ dryRun: false })   // live
//   earlyGame.stop()
//   earlyGame.offline(8)             // before going offline: keep 8 h of power bills, show checklist
//   earlyGame.keepPaused(groupId)    // never auto-resume this group
//   earlyGame.panel(false)           // hide the on-page panel
//   earlyGame.hold('me') / earlyGame.release('me')   // pause after the current step / go on
//   earlyGame.exportCfg() / importCfg(obj) / resetCfg()   // settings (also: Export / Import / Reset in the panel)
//   idleCore.ledger.text()           // what Autopilot and CD Farm did, kept across reloads (panel: the Log tab)
//   idleCore.stopAll()               // same as Alt+Shift+X: stop Autopilot, CD Farm and the Lab runner
//
// Watching it: a stall alert (no plan progress for cfg.stallMinutes while actions keep coming) shows a banner,
// a tab-title badge and, once you press "Enable alerts", a desktop notification; so do phase changes and
// stops. With cfg.liveResume on, a reload of a tab that was running Live resumes Live after a 60 s cancel
// window (otherwise always as a dry run). Live also refuses to run when the game's data no longer looks
// like what this script expects.
//
// With CD Farm (the CD Farm module in this file): Autopilot pauses while CD Farm runs or finishes a step (CD Farm
// calls earlyGame.hold before it takes its baseline), never assigns or builds over the camps of an
// interrupted CD Farm run, and with cfg.boosterVia = 'cdFarm' hands its CD booster to CD Farm.
//
// Phases (each step is a check on live state, so it starts wherever the corp is):
//   1-2  Lumber Camps + Farms (Cotton), always the cheaper; part loads until 25 acres are full
//   2    Sawmill unlock + build (kit bought if needed); auto-ship Cotton
//   all  every item's full courier loads above its reserve are sold, best-paying first (like
//        auto-ship, for everything): Wood, Cotton, Gold Ore, surplus ore… never Planks or frames
//   3    buy land, 3 Sawmills, Workshop unlock at 155 CD + 205 Planks
//   4    2 Workshops on Frame Timber, 6 Sawmills, Mine → Quarry → Smelter;
//        4 Iron + 2 Coal Mines, Limestone Quarry, Smelter on Iron Sheet, leftover frames → Gold Mines
//   5    Workshop on Rivet Iron Frame; unlock Factory → Kiln → Paper Mill → Manufacturing Lab
//        (→ Dispatch Office if cfg.dispatchOffice). Never the Drafting Bureau.
//        CD for these comes from Gold Mines and, when land gets too dear, the plan's
//        build-and-demolish booster (tested on 1 building first, off if it doesn't work).
//
// Safety: one confirmed action at a time; failed actions back off (15 s → 10 min) so they
// never block the rest; cash never drops below the power-bill floor; land walls; buy-price cap;
// bill-paused groups resumed (groups you pause, any time, stay paused); waits through socket
// drops; after a reload resumes as a DRY RUN (dryRun is never remembered); one copy per browser;
// one buy order per item per 24 h; pauses while cdFarm runs; never sells Planks or frames;
// courier busy (freight cooldown, auto-ship) → courier work waits, with no back-off or errors.
// Floorplans: every task a group runs is scored (the game's own scorer when the page has it,
// else known rates) against a library of the best known designs plus your saved designs; the
// best is applied automatically with EditLayout as soon as every part it adds (for every
// building on the task) is in stock. Missing parts are bought only from the player market at
// up to cfg.floorBuyUsd ($1) per unit, or ordered at that price.
//   earlyGame.floors()             // table: task, buildings, current x, best x, parts, status
// Offline test from a $100 start: bun test/early-game-sim.js [rich|live|chaos] [hours]


try {
(() => {
  const core = typeof window !== 'undefined' ? window.idleCore : globalThis.idleCore;
  if (!core) throw new Error('the shared core did not load');
  const KEY = 'earlyGame.v2';
  const W = typeof window !== 'undefined' ? window : globalThis;
  const HAS_DOM = typeof document !== 'undefined' && !!document.body;
  const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
  if (W.earlyGame) W.earlyGame._unload?.();

  const REGION = 0;                 // Heartland
  const MONEY = 0, CD = 24, LD = 111;
  const WOOD = 1, PLANKS = 9, COTTON = 76, WFRAME = 41, IFRAME = 42;
  const STARTER_ACRES = 25;
  const FIRST_ACRE = 5000;          // cents; next = floor(prev * 41 / 40)
  const COURIER_CU = 10000;
  const MAX_POWER = 200;

  const B = {
    CAMP: 0, MINE: 1, QUARRY: 2, SAWMILL: 4, SMELTER: 5, KILN: 6, WORKSHOP: 8, FARM: 10,
    LAB: 14, FACTORY: 15, PAPER_MILL: 23, DISPATCH: 36,
  };
  const R = {
    FELL_WOOD: 0, MINE_IRON: 1, MINE_COAL: 2, LIMESTONE: 5, SAW_PLANKS: 8, IRON_SHEET: 9,
    FRAME_TIMBER: 37, RIVET: 38, GROW_COTTON: 79, MINE_GOLD: 95,
  };
  const TASK = {
    [B.CAMP]: R.FELL_WOOD, [B.FARM]: R.GROW_COTTON, [B.SAWMILL]: R.SAW_PLANKS,
    [B.QUARRY]: R.LIMESTONE, [B.SMELTER]: R.IRON_SHEET,
  };
  const NAMES = {
    [R.FELL_WOOD]: 'Fell Wood', [R.GROW_COTTON]: 'Grow Cotton', [R.SAW_PLANKS]: 'Planks',
    [R.FRAME_TIMBER]: 'Frame Timber', [R.RIVET]: 'Iron Frames', [R.MINE_IRON]: 'Iron', [R.MINE_COAL]: 'Coal',
    [R.MINE_GOLD]: 'Gold', [R.LIMESTONE]: 'Limestone', [R.IRON_SHEET]: 'Iron Sheet',
  };
  // Items the plan makes itself: never bought for prototypes, never sold.
  const HOME_MADE = [WOOD, PLANKS, WFRAME, IFRAME];

  const cfg = {
    dryRun: true,            // log actions instead of sending them
    autoResume: true,        // after a page reload, resume a run that was going
    sawmills: 6,             // once the Workshop is unlocked (1 before, 3 from 50 buildings); at least 2 per Frame Timber Workshop
    workshops: 2,            // on Frame Timber
    ironFrameWorkshops: 1,   // Phase 5: on Rivet Iron Frame, once the Smelter runs
    ironMines: 4, coalMines: 2, quarries: 1, smelters: 1,
    goldMines: Infinity,     // leftover frames → Gold Mines (+8 CD each; the CD source for Smelter and Phase 5)
    dispatchOffice: false,   // Phase 5 optional unlock
    workshopPlanks: 205,     // planks before unlocking the Workshop (100 prototype + 100 build + 5 kit)
    maxAcrePrice: 500,       // $: land wall for camps/farms once the Workshop unlock has started
    maxAcrePriceEarly: 3000, // $: camps/farms before that (the plan pushes land until 155 CD)
    maxAcrePriceCritical: 5000, // $: land for plan buildings (Sawmill, Workshop, Mines, Smelter) ...
    landCashShare: 0.02,     // ... or up to this share of cash per acre, whichever is higher (money sitting still is wasted)
    // CD booster (the plan's "build-and-demolish CD"): once the Workshop is unlocked, when a plan
    // unlock waits only on CD and cash is idle, build cheap camps/farms and demolish them
    // (+1 CD each, 50% base refunded). Starts with a 1-building probe; disabled for good if the
    // CD isn't kept or the refund doesn't arrive (e.g. patched).
    cdBooster: true,
    boosterVia: 'builtin',   // 'cdFarm': start CD Farm (Lumber Camps, its own checks) up to the tech's CD instead;
                             // falls back to 'builtin' when CD Farm isn't loaded
    boosterBatch: 10,       // buildings per build+demolish cycle (limited by free acres)
    boosterFarmGapMs: 30000, // via CD Farm: wait this long after it stops before starting it again
    boosterMinCash: 20000,   // $: only above this much cash
    boosterKeepCash: 10000,  // $: never spend below this
    boosterAcres: 5,         // acres kept free for it (bought once, reused)
    woodReserve: 60,         // never sell below this (plus 10 min of what groups eat, kits and upcoming builds)
    sellAll: true,           // auto-sell every item's full courier loads above its reserve (like auto-ship)
    sellKeepMinutes: 30,     // keep this many minutes of what your groups eat of an item
    neverSell: [],           // extra item ids never sold (Planks, Wooden/Iron Frames, data are never sold anyway)
    smallLoadsUntil: 25,     // sell part loads until this many camps+farms exist
    minSmallLoad: 20,
    autoShipCotton: true,
    buyKits: true,           // buy kit / prototype parts the corp can't make yet
    maxBuyPrice: 3,          // × base value: most paid per unit for those parts
    postBuyOrders: true,     // no seller at all → post a player buy order for the part ...
    buyOrderUsd: 1,          // ... at this many $ per unit (money is escrowed; one open order per item)
    orderHoldHours: 24,      // never post another buy order for the same item within this time
    saveForCritical: true,   // stop buying camps/farms while saving for a ready plan building
    maxUnequippedCamps: 3,   // camps/farms waiting for their Wood kit before buying more
    resumePaused: true,      // resume powered groups paused by an unpaid bill
    floorUpgrades: true,     // switch tasks to the best-scoring known floorplan
    floorBuyUsd: 1,          // missing floorplan parts: fill player sell orders at up to this many $ per unit,
                             // else post a buy order at this price (parts you don't make); 0 = never buy
    billHours: 1,            // cash floor = this many hours of power bills (min $100 once powered)
    maxActionsPerMin: 20,       // halved (down to a quarter) after an action the server doesn't apply
    intervalMs: 3000,
    maxIdleMs: 9000,         // while there is nothing to do the loop slows from intervalMs up to this
    stallMinutes: 20,        // alert when the plan hasn't moved for this long while actions keep coming (0 = off)
    liveResume: false,       // after a reload, resume Live (with a 60 s cancel) if this tab was running Live
    jitterMinMs: 150, jitterMaxMs: 900,
    timeoutMs: 8000,
  };
  const DEFAULTS = { ...cfg, neverSell: [...cfg.neverSell] };

  // ---- persistence ----------------------------------------------------------

  // dryRun and billHours are never remembered: every paste/reload starts as a dry run with 1 h of bills.
  const SESSION_ONLY = ['dryRun', 'billHours'];
  const persistable = () => Object.fromEntries(Object.entries(cfg).filter(([k]) => !SESSION_ONLY.includes(k)));
  let saved = {};
  try { saved = JSON.parse(store?.getItem(KEY) || '{}'); } catch {}
  for (const [k, v] of Object.entries(saved.cfg || {})) if (!SESSION_ONLY.includes(k) && k in cfg) cfg[k] = v === null ? Infinity : v; // JSON has no Infinity
  const userPaused = new Set(saved.userPaused || []);   // groups you paused: never resumed
  const billPaused = new Set(saved.billPaused || []);   // groups paused by an unpaid bill: resumed when cash allows
  const keptPaused = new Set(saved.keptPaused || []);   // earlyGame.keepPaused(id): never resumed, never cleared
  const posted = { ...(saved.posted || {}) };           // item → when we last posted a buy order for it
  const wasRunning = !!saved.running;
  let running = false;
  const save = () => {
    try {
      store?.setItem(KEY, JSON.stringify({ cfg: persistable(), userPaused: [...userPaused], billPaused: [...billPaused], keptPaused: [...keptPaused], posted, running, boosterLeft, boosterBad }));
    } catch {}
  };

  // One running copy per browser: a heartbeat lock in localStorage (another browser can't be seen).
  const TAB = Math.random().toString(36).slice(2);
  const LOCK = KEY + '.lock';
  function lockOwner() {
    try { const l = JSON.parse(store?.getItem(LOCK) || 'null'); return l && Date.now() - l.t < 60000 ? l.id : null; } catch { return null; }
  }
  const takeLock = () => { try { store?.setItem(LOCK, JSON.stringify({ id: TAB, t: Date.now() })); } catch {} };
  const dropLock = () => { try { if (lockOwner() === TAB) store?.removeItem(LOCK); } catch {} };

  // ---- clock, cooldowns -----------------------------------------------------

  let nowMs = () => Date.now();
  const cooldowns = new Map();      // action key → { until, n, why }
  const successes = new Map();      // action key → confirmed count
  const failures = new Map();       // action key → failed count (never reset)
  function report(key, ok, why = '') {
    if (!key) return;
    if (ok) { cooldowns.delete(key); successes.set(key, (successes.get(key) ?? 0) + 1); return; }
    failures.set(key, (failures.get(key) ?? 0) + 1);
    const c = cooldowns.get(key) ?? { n: 0 };
    c.n++;
    c.until = nowMs() + Math.min(600000, 15000 * 2 ** (c.n - 1));
    c.why = why;
    cooldowns.set(key, c);
  }
  const cooling = (key) => (cooldowns.get(key)?.until ?? 0) > nowMs();

  // ---- CD Farm coordination -------------------------------------------------
  // CD Farm (the module above) builds and demolishes Lumber Camps or Farms (its Building setting); any unassigned one above its
  // baseline is treated as its own. So: while it runs (or finishes a step) we send nothing;
  // while it has an interrupted run, its leftover pool camps are never assigned and no new
  // camps/farms are built (they would look like its camps). window.cdFarm is re-read every time,
  // so either module can be reloaded (or be missing) at any time.
  const holds = new Set();          // earlyGame.hold(who): pause after the current step
  let inStep = false;               // an action is being sent / confirmed
  function farmInfo() {
    const f = W.cdFarm;
    if (!f) return null;
    return { busy: !!(f.running || f.active), resumable: !!f.resumable, baseline: f.stats?.baselinePool ?? 0, building: f.building ?? B.CAMP, units: f.farmUnits ?? null, f };
  }
  // Unassigned buildings (Lumber Camps or Farms, whichever the run cycles) that belong to a running or interrupted CD Farm run.
  function farmCamps(s, b = B.CAMP) {
    const fi = farmInfo();
    if (!fi || !(fi.busy || fi.resumable)) return 0;
    if (fi.units) return fi.units[b] ?? 0;   // CD Farm Auto: units of every type it holds above the baseline
    return b === fi.building ? Math.max(0, (s.pool[b] ?? 0) - fi.baseline) : 0;
  }
  let farmSeenBusyAt = -Infinity;   // last time CD Farm was seen running (a gap before the booster restarts it)
  function heldReason() {
    if (farmInfo()?.busy) { farmSeenBusyAt = nowMs(); return 'CD Farm is running (it demolishes unassigned camps)'; }
    if (holds.size) return `held by ${[...holds].join(', ')}`;
    return '';
  }

  // CD booster bookkeeping: buildings it built whose demolish got lost (cleaned up next, never
  // put to work), and probes where the demolish happened but CD/refund didn't check out.
  const boosterLeft = { ...(saved.boosterLeft || {}) };
  let boosterBad = saved.boosterBad || 0;
  const boosterOff = () => boosterBad >= 2;

  // Called every loop. A powered group that becomes paused while cash is under ~2 bills (or
  // the power service dropped) was paused by an unpaid bill; any other pause is yours.
  const lastPaused = new Map();
  function observe(s) {
    const needAll = s.groups.reduce((a, g) => a + s.drawOf(g.building) * g.count, 0);
    const billShort = s.powerHave < needAll || s.money < Math.max(s.powerHave, needAll) * 1000 * 2;
    let changed = false;
    for (const g of s.groups) {
      const prev = lastPaused.get(g.id);
      if (g.paused && prev !== true && !billPaused.has(g.id) && !userPaused.has(g.id)) {
        if (prev === false && billShort && s.drawOf(g.building) > 0) billPaused.add(g.id);
        else userPaused.add(g.id); // paused by you, or already paused when first seen
        changed = true;
      }
      if (!g.paused && (billPaused.delete(g.id) | userPaused.delete(g.id))) changed = true;
      lastPaused.set(g.id, !!g.paused);
    }
    // Buy-order hold: once our order was seen on the board and then left it (filled or
    // cancelled), the item may be ordered again. Never seen → the full orderHoldHours hold.
    for (const item of s.ordersKnown ? Object.keys(posted) : []) {
      const onBoard = s.myOrders?.some((o) => o.side === 'Buy' && o.item === +item);
      if (onBoard && !postedSeen.has(item)) postedSeen.add(item);
      else if (!onBoard && postedSeen.has(item)) { delete posted[item]; postedSeen.delete(item); changed = true; }
    }
    if (changed) save();
  }
  const postedSeen = new Set();

  // Courier conflicts: a shipment that didn't go because the courier was busy (auto-ship took it,
  // turnaround cooldown, or our tick estimate was early) is not the deal's fault. No back-off,
  // no failure count: courier work just waits until the courier is back.
  let courierHoldUntil = 0, courierMisses = 0;
  const usesCourier = (a) => a.steps.some((st) => st.msg.courier === true || st.msg.type === 'KeepFilling');

  // Result of an action: `stepsDone` steps were confirmed; `s` is the state afterwards.
  // Returns 'courier' when it failed only because the courier was busy.
  function finish(a, ok, stepsDone, s, why = '') {
    if (ok && usesCourier(a)) courierMisses = 0;
    if (!ok && usesCourier(a) && a.steps[0].msg.type !== 'KeepFilling' && s) {
      const busy = s.courierWaitTicks > 0 || (s.courierReadyAt ?? 0) > (a.meta?.courierReadyAt ?? Infinity);
      if (busy || courierMisses < 2) {
        const knownMs = (s.courierWaitTicks ?? 0) * 500;
        if (knownMs > 0) {
          // Freight cooldown with a known end (courier_ready_at): retry 1 s after it ends,
          // no escalation, since this was not a lost race.
          courierHoldUntil = nowMs() + knownMs + 1000;
        } else {
          // End unknown: hold at least 10 s, longer after repeated misses.
          courierMisses++;
          courierHoldUntil = nowMs() + Math.max(10000, 5000 * 2 ** Math.min(courierMisses, 6));
        }
        return 'courier';
      }
    }
    report(a.key, ok, why);
    const m = a.meta;
    if (!m) return;
    // A buy order may have been posted even if the board didn't show it: never post twice.
    if (a.key.startsWith('post:')) { posted[m.item] = nowMs(); save(); return; }
    if (a.key === 'booster' && ok) boosterBad = 0; // only consecutive bad probes turn it off
    if (a.key === 'booster' && !ok && stepsDone >= 1) {
      const left = Math.max(0, (s?.pool?.[m.b] ?? 0) - m.p0);
      if (left > 0) boosterLeft[m.b] = (boosterLeft[m.b] ?? 0) + left; // demolish lost: clean up next loop
      else boosterBad++;                                               // demolished, but CD/refund wrong
    }
    if (a.key.startsWith('booster:cleanup') && ok) boosterLeft[m.b] = Math.max(0, (boosterLeft[m.b] ?? 0) - m.n);
    save();
  }

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
    const bld = (b) => catalog.buildings[b] ?? { name: `building ${b}`, cost: 0, acres: 1, build_items: [] };
    const recipe = (r) => catalog.recipes[r];
    const groups = Object.entries(st.groups ?? {}).map(([id, g]) => ({ id: +id, ...g }))
      .filter((g) => (g.region ?? REGION) === REGION);
    const pool = st.building_pool?.[REGION] ?? {};
    const stock = st.stock?.[REGION] ?? {};

    const owned = (b) => groups.filter((g) => g.building === b).reduce((a, g) => a + g.count, 0) + (pool[b] ?? 0);
    const equipped = (b) => groups.filter((g) => g.building === b).reduce((a, g) => a + (g.equipped ?? 0), 0);
    const running = (b, r) => groups.filter((g) => g.building === b && g.recipe === r).reduce((a, g) => a + g.count, 0);
    const runningEquipped = (b, r) => groups.filter((g) => g.building === b && g.recipe === r && !g.paused)
      .reduce((a, g) => a + (g.equipped ?? 0), 0);
    let acresUsed = 0;
    for (const g of groups) acresUsed += bld(g.building).acres * g.count;
    for (const [b, n] of Object.entries(pool)) acresUsed += bld(+b).acres * n;
    const landBought = st.land_bought?.[REGION] ?? 0;
    const drawOf = (b) => bld(b).draws?.power ?? 0;
    const powerNeed = groups.filter((g) => !g.paused).reduce((a, g) => a + drawOf(g.building) * g.count, 0);
    const powerHave = st.subscriptions?.[REGION]?.power ?? 0;
    const inbound = {};
    for (const s of st.shipments ?? []) if (s.amount > 0 && !s.returning && s.inbound !== false) inbound[s.item] = (inbound[s.item] ?? 0) + s.amount;
    // Floor kit per building: the active layout's bill of materials for that recipe, else the default kit.
    const kitFor = (b, r) => st.layouts?.[r]?.bom ?? bld(b).default_kit ?? [];
    const items = st.items ?? {};
    return {
      st, catalog, bld, recipe, groups, pool, stock, items, inbound, kitFor, landBought, acresUsed,
      owned, equipped, running, runningEquipped, drawOf, powerNeed, powerHave, tickNow,
    };
  }

  // Derived values that need poolRecipe (defined with the plan below) are added here.
  function enrich(s) {
    const { st, groups, pool, recipe, kitFor, items, stock } = s;
    const kitOwed = {};
    const owe = (list, n) => { for (const k of list) kitOwed[k.item] = (kitOwed[k.item] ?? 0) + k.amount * n; };
    for (const g of groups) if (g.count > (g.equipped ?? 0)) owe(kitFor(g.building, g.recipe), g.count - (g.equipped ?? 0));
    // Items made at home by equipped, running groups; what they eat per minute; starved groups.
    const madeHere = new Set(), eatPerMin = {}, starved = [];
    for (const g of groups) {
      if (!(g.equipped > 0) || g.paused || g.recipe == null) continue;
      const r = recipe(g.recipe);
      if (!r) continue;
      for (const o of r.outputs) madeHere.add(o.item);
      const rate = st.layouts?.[g.recipe]?.fx?.rate ?? 1; // runs per wave from the floorplan
      for (const i of r.inputs) eatPerMin[i.item] = (eatPerMin[i.item] ?? 0) + i.amount * g.equipped * rate * 120 / r.ticks;
      if ((g.work ?? []).some((w) => w.inputs_pct != null && w.inputs_pct < 100)) starved.push(g);
    }
    Object.assign(s, {
      kitOwed, madeHere, eatPerMin, starved,
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
      nextGroupId: st.next_group_id ?? 0,
      shipId: st.next_shipment_id ?? 0, standing: st.standing_fills ?? {},
      mutTick: st.ssi?.last_user_mutation_tick ?? 0,
    });
    for (const [b, n] of Object.entries(pool)) if (n) owe(kitFor(+b, poolRecipe(s, +b)), n);
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
    return s;
  }

  // ---- prices -----------------------------------------------------------------

  const buildCost = (s, b) => Math.round(s.bld(b).cost * (20 + s.owned(b)) / 20);
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
    { b: B.WORKSHOP, phase: 3, gate: (s) => s.has(PLANKS) >= cfg.workshopPlanks || `need ${cfg.workshopPlanks} Planks on hand` },
    { b: B.MINE, phase: 4 },
    { b: B.QUARRY, phase: 4 },
    { b: B.SMELTER, phase: 4 },
    { b: B.FACTORY, phase: 5 },
    { b: B.KILN, phase: 5 },
    { b: B.PAPER_MILL, phase: 5 },
    { b: B.LAB, phase: 5 },
    ...(cfg.dispatchOffice ? [{ b: B.DISPATCH, phase: 5 }] : []),
  ];

  function nextTech(s) {
    for (const t of techPlan()) {
      if (s.unlocked(t.b)) continue;
      if (s.research?.building === t.b || s.queue.some((q) => q.building === t.b)) return null; // in progress
      return t;
    }
    return null;
  }

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

  function mineRecipe(s) {
    if (s.running(B.MINE, R.MINE_IRON) < cfg.ironMines) return R.MINE_IRON;
    if (s.running(B.MINE, R.MINE_COAL) < cfg.coalMines) return R.MINE_COAL;
    return R.MINE_GOLD;
  }
  const smelting = (s) => s.runningEquipped(B.SMELTER, R.IRON_SHEET) > 0;
  function workshopRecipe(s) {
    if (s.running(B.WORKSHOP, R.FRAME_TIMBER) < cfg.workshops) return R.FRAME_TIMBER;
    if (smelting(s) && s.running(B.WORKSHOP, R.RIVET) < cfg.ironFrameWorkshops) return R.RIVET;
    return R.FRAME_TIMBER;
  }
  function poolRecipe(s, b) { return b === B.MINE ? mineRecipe(s) : b === B.WORKSHOP ? workshopRecipe(s) : TASK[b]; }
  // Unassigned Workshops count toward the recipe they'll be given.
  const workshopPool = (s, r) => ((s.pool[B.WORKSHOP] ?? 0) > 0 && workshopRecipe(s) === r ? s.pool[B.WORKSHOP] : 0);

  // Plan buildings still wanted, in priority order.
  function criticalTargets(s) {
    const out = [];
    const add = (b, recipe, target, have) => { if (s.unlocked(b) && have < target) out.push({ b, recipe, target, have }); };
    add(B.SAWMILL, R.SAW_PLANKS, sawTarget(s), s.owned(B.SAWMILL));
    add(B.WORKSHOP, R.FRAME_TIMBER, cfg.workshops, s.running(B.WORKSHOP, R.FRAME_TIMBER) + workshopPool(s, R.FRAME_TIMBER));
    add(B.MINE, R.MINE_IRON, cfg.ironMines, s.running(B.MINE, R.MINE_IRON));
    add(B.MINE, R.MINE_COAL, cfg.coalMines, s.running(B.MINE, R.MINE_COAL));
    add(B.QUARRY, R.LIMESTONE, cfg.quarries, s.owned(B.QUARRY));
    add(B.SMELTER, R.IRON_SHEET, cfg.smelters, s.owned(B.SMELTER));
    // Phase 5: Iron Frames once Iron Sheet is being made.
    if (smelting(s)) add(B.WORKSHOP, R.RIVET, cfg.ironFrameWorkshops, s.running(B.WORKSHOP, R.RIVET) + workshopPool(s, R.RIVET));
    const basicsDone = s.running(B.MINE, R.MINE_IRON) >= cfg.ironMines && s.running(B.MINE, R.MINE_COAL) >= cfg.coalMines
      && s.owned(B.QUARRY) >= cfg.quarries;
    if (basicsDone) add(B.MINE, R.MINE_GOLD, cfg.goldMines, s.running(B.MINE, R.MINE_GOLD));
    return out;
  }

  // ---- floorplans ----------------------------------------------------------------

  // Best known designs (found with the game's scorer; see wiki/floorplan-search.md).
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
  const FLOOR_LIBRARY = [
    { // proven max on every 5x2 floor with no inputs (26,864 layouts scored)
      name: 'x3 merge', rate: 3,
      fits: (s, r) => {
        const rc = s.recipe(r), b = rc && s.bld(rc.building);
        if (!rc || rc.inputs.length || b.floor_w !== 5 || b.floor_h !== 2) return null;
        return b.operations?.includes('Extract') ? X3_MERGE(121) : b.operations?.includes('Cultivate') ? X3_MERGE(122) : null;
      },
    },
    { name: 'Saw x2', rate: 2, recipes: [R.SAW_PLANKS], // proven max on the 6x2 Sawmill
      cells: '0,0:123:1 0,1:123:0 1,0:123:0 1,1:126:0 2,0:123:0 2,1:123:0 3,0:114:0 3,1:114:0 5,0:123:0 5,1:123:0' },
    { name: 'Smelt x3', rate: 3, recipes: [R.IRON_SHEET, 10, 11], // Iron, Steel, Aluminum Sheet
      cells: SMELT_X3 + ' 8,0:123:0 8,1:123:0 8,2:123:0 9,0:114:0 9,1:114:0 9,2:114:0' },
    { name: 'Kiln x3', rate: 3, recipes: [13, 14], cells: SMELT_X3 }, // Mix Concrete, Blow Glass
    { name: 'Frame Timber x5', rate: 5, recipes: [R.FRAME_TIMBER],
      cells: '0,0:114:0 0,1:114:0 0,2:114:0 0,3:114:0 0,4:114:0 10,1:123:0 10,2:116:2 10,4:123:0 11,0:123:0 11,1:126:0 11,4:123:0 12,0:123:0 12,1:123:0 12,4:123:0 13,0:123:0 13,1:126:0 13,2:123:1 13,3:123:2 13,4:123:0 14,0:123:0 14,1:123:1 14,2:123:0 14,4:123:0 15,0:116:0 15,2:116:0 15,4:123:0 16,4:123:0 17,4:123:0 2,0:123:0 2,1:123:0 2,2:123:0 2,3:123:0 2,4:123:0 3,0:123:0 3,1:123:1 3,2:127:0 3,3:123:3 3,4:123:0 4,0:116:0 4,2:123:0 4,3:116:0 5,2:123:0 6,2:123:0 7,0:123:0 7,1:123:0 7,2:123:3 7,3:123:0 8,0:123:1 8,1:128:0 8,2:123:1 8,3:127:1 8,4:123:0 9,1:123:0 9,3:123:1 9,4:127:0' },
    { name: 'Rivet x3', rate: 3, recipes: [R.RIVET],
      cells: '0,0:123:0 0,1:123:1 0,2:123:1 0,3:123:1 0,4:123:0 1,0:123:0 1,4:123:0 10,1:123:0 10,2:123:0 10,4:123:0 11,1:123:0 11,2:123:0 11,4:123:0 12,1:123:0 12,2:116:0 12,4:123:0 13,1:123:0 13,4:123:0 14,1:123:0 14,4:123:0 15,0:116:0 15,2:123:0 15,3:116:0 16,2:123:0 17,2:123:0 2,0:126:0 2,1:123:1 2,2:126:1 2,3:123:0 2,4:123:0 3,0:123:0 3,2:123:0 3,3:114:0 3,4:123:0 4,0:114:0 4,2:114:0 4,4:123:0 5,3:123:0 5,4:123:0 6,0:123:0 6,2:123:0 6,3:127:0 6,4:123:3 7,0:123:1 7,1:123:1 7,2:127:0 7,3:123:3 8,2:123:0 9,1:123:0 9,2:126:0 9,3:123:1 9,4:123:0' },
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
        const cells = e.fits ? e.fits(s, r) : e.recipes.includes(r) ? unpack(e.cells) : null;
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
        for (const [i, n] of block.short) yield* floorPartBuys(s, +i, n - s.has(+i) - (s.inbound[+i] ?? 0), `parts for ${f.task} floorplan`);
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

  function phaseOf(s) {
    if (s.owned(B.CAMP) + s.owned(B.FARM) < 2) return 1;
    if (!s.unlocked(B.SAWMILL) || s.owned(B.SAWMILL) < 1 || s.acresUsed < STARTER_ACRES) return 2;
    if (!s.unlocked(B.WORKSHOP)) return 3;
    if (!smelting(s)) return 4;
    if (nextTech(s) || s.research || s.running(B.WORKSHOP, R.RIVET) < cfg.ironFrameWorkshops) return 5;
    return 'done';
  }

  // ---- decide -----------------------------------------------------------------------

  // An action: { key, reason, steps: [{ msg, until(s), optional }] }.  A wait: { wait, final }.
  const act = (key, reason, ...steps) => ({ key, reason, steps });
  const withMeta = (meta, a) => Object.assign(a, { meta });

  function groupFor(s, b, r) {
    return s.groups.filter((g) => g.building === b && g.recipe === r).sort((a, z) => z.count - a.count)[0];
  }

  function assignAction(s, b, r, n) {
    const g = groupFor(s, b, r);
    if (g) {
      const c0 = g.count;
      return act(`assign:${g.id}`, `pool: assign ${n} ${bname(s, b)} → "${g.name}"`,
        { msg: { type: 'AssignBuildings', group: g.id, amount: n }, until: (x) => (x.st.groups[g.id]?.count ?? 0) >= c0 + n });
    }
    const id = s.nextGroupId;
    return act(`create:${b}:${r}`, `pool: create group "${NAMES[r]}" with ${n} ${bname(s, b)}`,
      // Only our new group (this building, no task yet) may get the task; if the id went to
      // another group the action fails here and the idle-group step retasks ours by its real id.
      { msg: { type: 'CreateGroup', building: b, amount: n, name: NAMES[r] ?? bname(s, b), region: REGION },
        until: (x) => x.st.groups[id]?.building === b && x.st.groups[id]?.recipe == null },
      { msg: { type: 'SetRecipe', group: id, recipe: r }, until: (x) => x.st.groups[id]?.recipe === r });
  }

  // Sellers of an item, cheapest first, under the price cap, big enough for `amount`.
  function sellersOf(s, item, amount) {
    const it = s.catalog.items[item] ?? {};
    const cap = (it.base_value || 0) * cfg.maxBuyPrice;
    return [
      ...s.deals.filter((d) => d.side === 'Buy' && d.item === item && d.amount >= amount)
        .map((d) => ({ key: `fill:${d.id}`, unit: d.price / d.amount, msg: { type: 'FillDeal', deal: d.id, amount, hire: null, region: REGION, courier: true } })),
      ...s.orders.filter((o) => o.side === 'Sell' && o.item === item && o.amount >= amount)
        .map((o) => ({ key: `order:${o.id}`, unit: o.unit_price * 1.02, msg: { type: 'FillOrder', order: o.id, amount, hire: null, region: REGION, courier: true } })),
    ].filter((o) => !cap || o.unit <= cap).sort((a, z) => a.unit - z.unit);
  }

  // One open player buy order per item, at `usd` per unit; none again within orderHoldHours
  // unless the last one was seen filled. Yields an action or a wait.
  function* postBuyOrder(s, item, amount, usdPerUnit, why) {
    const mine = s.myOrders.find((o) => o.side === 'Buy' && o.item === item);
    if (mine) { yield { wait: `${why}: your buy order for ${mine.amount} @ ${usd(mine.unit_price)} is waiting for a player` }; return; }
    const since = nowMs() - (posted[item] ?? -Infinity);
    if (since < cfg.orderHoldHours * 3600000) { yield { wait: `${why}: buy order posted ${Math.round(since / 60000)} min ago, waiting for a player` }; return; }
    const unit = Math.max(1, Math.round(usdPerUnit * 100)); // cents
    if (!cfg.postBuyOrders || s.money - unit * amount * 1.02 < moneyFloor(s)) return;
    const n0 = s.myOrders.length;
    yield withMeta({ item }, act(`post:${item}`, `${why}: post a buy order for ${amount} ${iname(s, item)} @ ${usd(unit)} (escrows ${usd(unit * amount)})`,
      { msg: { type: 'PostOrder', side: 'Buy', item, amount, unit_price: unit, region: REGION },
        until: (x) => x.myOrders.length > n0 || x.myOrders.some((o) => o.side === 'Buy' && o.item === item) }));
  }

  // Floorplan parts from the player market only, at up to cfg.floorBuyUsd per unit (2% fee
  // included): cheapest sell orders first, part-filling small ones. With no such seller, a buy
  // order at that price for parts you don't make (home-made parts just build up).
  function* floorPartBuys(s, item, need, why) {
    if (!(cfg.floorBuyUsd > 0) || need <= 0) return;
    if (!s.ordersKnown) { yield { wait: `${why}: player order board not loaded (open the Market page once)` }; return; }
    const it = s.catalog.items[item] ?? {};
    const amount = Math.max(1, Math.min(Math.ceil(need), Math.floor(COURIER_CU / (it.cargo_weight || 1))));
    const cap = cfg.floorBuyUsd * 100;
    const offers = s.orders.filter((o) => o.side === 'Sell' && o.item === item && o.unit_price * 1.02 <= cap)
      .sort((a, z) => a.unit_price - z.unit_price);
    for (const o of offers) {
      const n = Math.min(amount, o.amount);
      const cost = Math.ceil(o.unit_price * 1.02 * n);
      if (s.money - cost < moneyFloor(s)) { yield { wait: `${why}: need ${usd(cost)} for ${n} ${iname(s, item)}` }; return; }
      if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): ${why}` }; return; }
      const id0 = s.shipId, m0 = s.money;
      yield act(`order:${o.id}`, `${why}: buy ${n} ${iname(s, item)} from a player @ ${usd(o.unit_price)}`,
        { msg: { type: 'FillOrder', order: o.id, amount: n, hire: null, region: REGION, courier: true }, until: (x) => x.shipId > id0 || x.money < m0 - cost / 2 });
    }
    if (!s.madeHere.has(item)) yield* postBuyOrder(s, item, amount, cfg.floorBuyUsd, why);
  }

  // Buy actions (one per seller, best first) for `need` of an item, capped at one courier load.
  function* buyActions(s, item, need, why) {
    const it = s.catalog.items[item] ?? {};
    const amount = Math.max(1, Math.min(Math.ceil(need), Math.floor(COURIER_CU / (it.cargo_weight || 1))));
    if (!s.dealsKnown || !s.ordersKnown) { yield { wait: `${why}: market board not loaded (open the Market page once)` }; return; }
    const offers = sellersOf(s, item, amount);
    if (!offers.length) {
      yield* postBuyOrder(s, item, amount, cfg.buyOrderUsd, `no seller for ${iname(s, item)}`);
      yield { wait: `no seller for ${Math.ceil(need)} ${iname(s, item)} under ${cfg.maxBuyPrice}× base (buy it by hand)` };
      return;
    }
    for (const o of offers) {
      const cost = Math.ceil(o.unit * amount);
      if (s.money - cost < moneyFloor(s)) { yield { wait: `${why}: need ${usd(cost)} for ${amount} ${iname(s, item)}` }; return; }
      if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): ${why}` }; return; }
      const id0 = s.shipId, m0 = s.money;
      yield act(o.key, `${why}: buy ${amount} ${iname(s, item)} for ~${usd(cost)}`,
        { msg: o.msg, until: (x) => x.shipId > id0 || x.money < m0 - cost / 2 });
    }
  }

  // Home-made items held back from a build: next tech's prototype + build cost of plan
  // buildings ranked above `t` that aren't built yet (so Gold Mines can't starve the Smelter).
  function reserveFor(s, item, t, targets) {
    const amt = (list) => (list ?? []).find((i) => i.item === item)?.amount ?? 0;
    const nt = nextTech(s);
    let r = nt ? amt(s.bld(nt.b).build_items) : 0;
    for (const u of targets) { if (u === t) break; r += amt(s.bld(u.b).build_items); }
    return r;
  }

  // Never sell below: base + 10 min of what groups eat + owed kits + next tech prototype
  // + the next two plan builds (items and kits).
  function sellReserve(s, item) {
    const amt = (list) => (list ?? []).find((i) => i.item === item)?.amount ?? 0;
    let r = (item === WOOD ? cfg.woodReserve : 0) + cfg.sellKeepMinutes * (s.eatPerMin[item] ?? 0) + (s.kitOwed[item] ?? 0) + floorReserve(s, item);
    const nt = nextTech(s);
    if (nt) r += amt(s.bld(nt.b).build_items);
    for (const t of criticalTargets(s).slice(0, 2)) r += amt(s.bld(t.b).build_items) + amt(s.kitFor(t.b, t.recipe));
    return Math.ceil(r);
  }

  // Parts to buy: owed kits + next tech's prototype, minus stock, inbound and home production.
  function partsToBuy(s) {
    const want = {};
    for (const [item, n] of Object.entries(s.kitOwed)) if (!s.madeHere.has(+item)) want[item] = n;
    const nt = nextTech(s);
    if (nt) {
      const tech = s.catalog.techs.find((t) => t.building === nt.b);
      if (tech && s.cd >= tech.cost) {
        for (const i of s.bld(nt.b).build_items ?? []) {
          if (HOME_MADE.includes(i.item) || i.item === LD || i.item === CD) continue;
          want[i.item] = (want[i.item] ?? 0) + i.amount;
        }
      }
    }
    return Object.entries(want)
      .map(([item, amount]) => ({ item: +item, need: amount - s.has(+item) - (s.inbound[+item] ?? 0) }))
      .filter((p) => p.need > 0);
  }
  // (An open buy order of ours is handled in buyActions: it waits instead of reposting.)

  // Acres held free for the CD booster once it is in use (other builds buy their own).
  function boosterAcresHeld(s) {
    if (!cfg.cdBooster || !s.unlocked(B.WORKSHOP)) return 0;
    if (!(successes.get('booster') || successes.get('land:booster') || successes.get('booster:cdfarm'))) return 0;
    if ((boosterOff() && cfg.boosterVia !== 'cdFarm') || !nextTech(s)) return 0;
    return Math.min(cfg.boosterAcres, s.freeAcres);
  }

  function buildSteps(s, b, why, maxAcre) {
    const needAcres = Math.max(0, s.bld(b).acres - (s.freeAcres - boosterAcresHeld(s)));
    const floor = moneyFloor(s, s.drawOf(b));
    if (needAcres > 0) {
      const top = acrePrice(s.landBought + needAcres - 1);
      if (top > maxAcre * 100) return { wait: `${why}: next acre ${usd(top)} is above the ${usd(maxAcre * 100)} land wall`, wall: true };
      const lc = landCost(s, needAcres);
      if (s.money - lc - buildCost(s, b) < floor) return { wait: `${why}: saving for ${needAcres} acre(s) + ${bname(s, b)} (${usd(lc + buildCost(s, b))})`, money: true };
      const l0 = s.landBought;
      return act('land', `${why}: buy ${needAcres} acre(s) for ${usd(lc)}`,
        { msg: { type: 'BuyLand', amount: needAcres, region: REGION }, until: (x) => x.landBought >= l0 + needAcres });
    }
    const cost = buildCost(s, b);
    if (s.money - cost < floor) return { wait: `${why}: saving ${usd(cost)} for ${bname(s, b)} (have ${usd(s.money)})`, money: true };
    const o0 = s.owned(b);
    return act(`build:${b}`, `${why}: build ${bname(s, b)} for ${usd(cost)}`,
      { msg: { type: 'BuyBuilding', building: b, amount: 1, region: REGION }, until: (x) => x.owned(b) >= o0 + 1 });
  }

  // Every candidate, in priority order. decide() takes the first that isn't cooling down.
  function* candidates(s) {
    // 1. Resume groups paused by an unpaid bill. Groups you paused are never touched.
    if (cfg.resumePaused) {
      for (const g of s.groups) {
        if (!g.paused || !billPaused.has(g.id) || userPaused.has(g.id) || keptPaused.has(g.id)) continue;
        const mw = s.drawOf(g.building) * g.count;
        if (s.money < moneyFloor(s, mw) + mw * 1000) { yield { wait: `"${g.name}" is paused (unpaid bill?): waiting for cash to resume` }; continue; }
        yield act(`resume:${g.id}`, `resume "${g.name}" (paused, bills affordable again)`,
          { msg: { type: 'SetPaused', group: g.id, paused: false }, until: (x) => !x.st.groups[g.id]?.paused });
      }
    }

    // 2. Power.
    if (s.powerNeed > s.powerHave) {
      const level = Math.min(MAX_POWER, s.powerNeed);
      if (level > s.powerHave) {
        yield act('power', `power: groups draw ${s.powerNeed} MW, subscribed ${s.powerHave}`,
          { msg: { type: 'SetSubscription', region: REGION, utility: 'power', level }, until: (x) => x.powerHave === level });
      }
      if (s.powerNeed > MAX_POWER) yield { wait: `power need ${s.powerNeed} MW is above the ${MAX_POWER} MW grid cap` };
    }

    // 3a. Booster leftovers (its demolish got lost): demolish them, don't put them to work.
    for (const [bs, left] of Object.entries(boosterLeft)) {
      const b = +bs, n = Math.min(left, s.pool[b] ?? 0);
      if (!left) continue;
      if (!n) { boosterLeft[b] = 0; continue; } // already gone
      const p0 = s.pool[b];
      const a = act(`booster:cleanup:${b}`, `CD booster cleanup: demolish ${n} leftover ${bname(s, b)}`,
        { msg: { type: 'DemolishBuilding', building: b, amount: n, region: REGION }, until: (x) => (x.pool[b] ?? 0) <= p0 - n });
      a.meta = { b, n };
      yield a;
    }

    // 3b. Unassigned plan buildings → their group (non-plan buildings are left alone).
    for (const [bs, total] of Object.entries(s.pool)) {
      const b = +bs;
      const n = total - (boosterLeft[b] ?? 0) - farmCamps(s, b);
      if (n <= 0) continue;
      const r = poolRecipe(s, b);
      if (r == null) continue;
      yield assignAction(s, b, r, b === B.MINE || b === B.WORKSHOP ? 1 : n);
    }

    // 4. Plan groups with no task.
    for (const g of s.groups) {
      if (g.recipe != null) continue;
      const r = poolRecipe(s, g.building);
      if (r == null) continue;
      yield act(`recipe:${g.id}`, `idle group "${g.name}" → ${NAMES[r]}`,
        { msg: { type: 'SetRecipe', group: g.id, recipe: r }, until: (x) => x.st.groups[g.id]?.recipe === r });
    }

    // 5. Kit / prototype parts the corp can't make yet.
    if (cfg.buyKits) for (const p of partsToBuy(s)) yield* buyActions(s, p.item, p.need, 'parts for kits/prototype');

    // 6. Next plan tech.
    const nt = nextTech(s);
    if (nt) {
      const tech = s.catalog.techs.find((t) => t.building === nt.b);
      const proto = s.bld(nt.b).build_items ?? [];
      const why = `unlock ${bname(s, nt.b)}`;
      if (!tech) yield { wait: `${why}: not in the tech tree` };
      else if (!s.researchIdle) yield { wait: `${why}: research slot busy` };
      else if (tech.requires != null && !s.unlocked(tech.requires)) yield { wait: `${why}: needs ${bname(s, tech.requires)} first` };
      else if (s.cd < tech.cost) yield { wait: `${why}: ${s.cd} / ${tech.cost} CD` };
      else {
        const gate = nt.gate ? nt.gate(s) : true;
        const lack = proto.filter((i) => s.has(i.item) < i.amount);
        if (gate !== true) yield { wait: `${why}: ${gate}` };
        else if (lack.length) yield { wait: `${why}: need ${lack.map((i) => `${Math.ceil(i.amount - s.has(i.item))} more ${iname(s, i.item)}${whyNoneMade(s, i.item)}`).join(', ')}` };
        else {
          yield act(`tech:${nt.b}`, `${why} (${tech.cost} CD${proto.length ? ' + ' + proto.map((i) => `${i.amount} ${iname(s, i.item)}`).join(', ') : ''})`,
            { msg: { type: 'StartTech', building: nt.b, region: REGION }, until: (x) => x.research?.building === nt.b || x.unlocked(nt.b) });
        }
      }
    }

    // 6b. Better floorplans.
    yield* floorActions(s);

    // 7. Selling.
    yield* sellActions(s);

    // 8. Plan buildings.
    const targets = criticalTargets(s);
    for (const t of targets) {
      const items = s.bld(t.b).build_items ?? [];
      const short = items.find((i) => s.has(i.item) < i.amount + (HOME_MADE.includes(i.item) ? reserveFor(s, i.item, t, targets) : 0));
      const label = `${bname(s, t.b)}${t.b === B.MINE || t.b === B.WORKSHOP ? ` (${NAMES[t.recipe]})` : ''} ${t.have + 1}/${t.target === Infinity ? '∞' : t.target}`;
      if (short) { yield { wait: `${label}: waiting for ${iname(s, short.item)}${whyNoneMade(s, short.item)}` }; continue; }
      if (s.owned(t.b) > s.equipped(t.b)) { yield { wait: `${label}: a ${bname(s, t.b)} is still waiting for its floor kit` }; continue; }
      // One-off plan buildings take land at any price they can afford; only the open-ended
      // Gold Mines are held to the land wall.
      const wall = t.recipe === R.MINE_GOLD ? Math.max(cfg.maxAcrePriceCritical, s.money / 100 * cfg.landCashShare) : Infinity;
      const a = buildSteps(s, t.b, label, wall);
      if (a.steps) { yield a; continue; }
      if (a.money && cfg.saveForCritical) { yield { ...a, final: true }; return; }
      yield a;
    }

    // 9. CD booster.
    yield* boosterActions(s, nt);

    // 10. Cheaper of Lumber Camp / Farm (tie → camp).
    if (farmInfo()?.resumable) { yield { wait: 'camps/farms wait: CD Farm has an interrupted run (resume or discard it in CD Farm)' }; return; }
    const b =buildCost(s, B.FARM) < buildCost(s, B.CAMP) ? B.FARM : B.CAMP;
    const unequipped = s.owned(B.CAMP) + s.owned(B.FARM) - s.equipped(B.CAMP) - s.equipped(B.FARM);
    if (unequipped >= cfg.maxUnequippedCamps) { yield { wait: `${unequipped} camps/farms still waiting for their Wood kit` }; return; }
    const workshopStarted = s.unlocked(B.WORKSHOP) || s.research?.building === B.WORKSHOP;
    yield buildSteps(s, b, `${bname(s, b)} #${s.owned(b) + 1}`, workshopStarted ? cfg.maxAcrePrice : cfg.maxAcrePriceEarly);
  }

  function* boosterActions(s, nt) {
    if (!cfg.cdBooster || !nt || !s.unlocked(B.WORKSHOP) || !s.researchIdle) return;
    const tech = s.catalog.techs.find((t) => t.building === nt.b);
    if (!tech || s.cd >= tech.cost || (tech.requires != null && !s.unlocked(tech.requires))) return;
    const fi = farmInfo();
    if (fi?.resumable) { yield { wait: 'CD booster waits: CD Farm has an interrupted run (resume or discard it in CD Farm)' }; return; }
    const viaFarm = cfg.boosterVia === 'cdFarm' && typeof fi?.f.start === 'function';
    const verified = (successes.get('booster') ?? 0) > 0;
    if (boosterOff() && !viaFarm) { yield { wait: 'CD booster off: build-and-demolish did not keep the CD / refund (seen twice)' }; return; }
    if (Object.values(boosterLeft).some((n) => n > 0)) return; // clean up first
    if (s.money < cfg.boosterMinCash * 100) return;
    if (s.freeAcres < 1) {
      const want = Math.max(1, cfg.boosterAcres);
      // A few acres bought once and reused for every cycle: allowed up to 10% of cash per acre.
      const cap = Math.max(cfg.maxAcrePriceCritical, s.money / 100 * Math.max(cfg.landCashShare, 0.1)) * 100;
      if (acrePrice(s.landBought + want - 1) > cap) { yield { wait: `CD booster: next acre ${usd(acrePrice(s.landBought))} above the land wall` }; return; }
      const lc = landCost(s, want), l0 = s.landBought;
      if (s.money - lc < Math.max(moneyFloor(s), cfg.boosterKeepCash * 100)) return;
      yield act('land:booster', `CD booster: buy ${want} acre(s) to build on (${usd(lc)}, reused)`,
        { msg: { type: 'BuyLand', amount: want, region: REGION }, until: (x) => x.landBought >= l0 + want });
      return;
    }
    const keep = Math.max(moneyFloor(s), cfg.boosterKeepCash * 100);
    if (viaFarm) {
      // CD Farm runs the build+demolish cycles itself (and verifies them); we hold until it stops.
      // Its settings for this run are restored when it stops (runOnly).
      // Not worth starting when it would stop at once (it needs one camp's cost above the floor), and
      // after a run ends (stopped by you, error) wait cfg.boosterFarmGapMs instead of restarting it every loop.
      if (s.money - buildCost(s, B.CAMP) < keep) return;
      if (nowMs() - farmSeenBusyAt < cfg.boosterFarmGapMs) { yield { wait: `CD booster: CD Farm just stopped, waiting ${cfg.boosterFarmGapMs / 1000} s before starting it again` }; return; }
      const opts = {
        targetCd: tech.cost, budget: 'reserve', minMoney: Math.ceil(keep / 100), batch: cfg.boosterBatch,
        reserveAcres: 0, fullBatch: false, existingPool: 'keep', maxSpendPerMin: Infinity,
        building: B.CAMP, runOnly: true, by: `Autopilot: CD for ${bname(s, nt.b)}`,
      };
      const a = act('booster:cdfarm', `CD booster via CD Farm: farm ${tech.cost - s.cd} CD for ${bname(s, nt.b)} (keeps ${usd(keep)})`);
      a.call = () => { fi.f.start(opts); return !!W.cdFarm?.running; };
      a.callInfo = `cdFarm.start(${JSON.stringify(opts)})`;
      yield a;
      return;
    }
    const b = buildCost(s, B.FARM) < buildCost(s, B.CAMP) ? B.FARM : B.CAMP;
    const base = s.bld(b).cost, owned = s.owned(b);
    const max = verified ? Math.min(cfg.boosterBatch, s.freeAcres, tech.cost - s.cd) : 1;
    let n = 0, cost = 0;
    while (n < max && s.money - (cost + Math.round(base * (20 + owned + n) / 20)) >= keep) { cost += Math.round(base * (20 + owned + n) / 20); n++; }
    if (!n) return;
    const refund = Math.floor(base / 2) * n;
    const p0 = s.pool[b] ?? 0, cd0 = s.cd, m0 = s.money;
    const a = act('booster', `CD booster${verified ? '' : ' (1-building test)'}: build + demolish ${n} ${bname(s, b)} → +${n} CD for ~${usd(cost - refund)} (${tech.cost - s.cd} CD short of ${bname(s, nt.b)})`,
      { msg: { type: 'BuyBuilding', building: b, amount: n, region: REGION }, until: (x) => (x.pool[b] ?? 0) >= p0 + n },
      { msg: { type: 'DemolishBuilding', building: b, amount: n, region: REGION },
        // Verified on the result: buildings gone, CD kept, and the refund came back.
        // Slack covers a $10/MW bill landing between the two steps.
        until: (x) => (x.pool[b] ?? 0) <= p0 && x.cd >= cd0 + n && x.money >= m0 - (cost - refund) - Math.max(5000, cost * 0.02) - Math.max(s.powerHave, s.powerNeed) * 1000 });
    a.meta = { b, n, p0 };
    yield a;
  }

  // "back in 6 s" from the game's courier_ready_at, or our own hold after a lost race.
  const courierBackInMs = (s) => Math.max(s.courierWaitTicks * 500, courierHoldUntil - nowMs(), 0);
  function courierEta(s) {
    const ms = courierBackInMs(s);
    return ms > 0 ? `back in ${Math.ceil(ms / 1000)} s` : 'back now';
  }

  function* sellActions(s) {
    if (!s.dealsKnown) { yield { wait: 'selling: market board not loaded (open the Market page once)' }; return; }
    const load = (item) => Math.floor(COURIER_CU / (s.catalog.items[item]?.cargo_weight || 1));
    const bids = (item) => s.deals.filter((d) => d.side === 'Sell' && d.item === item)
      .sort((a, z) => z.price / z.amount - a.price / a.amount);

    // Cotton auto-ship (1 slot, unlocks after First Steps). Never replaces another auto-ship.
    const standingIds = Object.keys(s.standing);
    const autoCotton = standingIds.some((id) => s.deals.find((d) => String(d.id) === id)?.item === COTTON);
    if (cfg.autoShipCotton && !autoCotton && standingIds.length === 0 && s.has(COTTON) > 0) {
      const d = bids(COTTON)[0];
      if (d) {
        yield act(`autoship:${d.id}`, `auto-ship Cotton to bid @ ${usd(d.price / d.amount)}`,
          { msg: { type: 'KeepFilling', deal: d.id, region: REGION, amount: null }, until: (x) => !!x.standing[d.id], optional: true });
      }
    }
    if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): selling waits` }; return; }

    // Every item with a Heartland bid whose stock above its reserve fills a courier run
    // (10,000 CU) is sold, best-paying load first. Part loads only for Wood/Cotton at the start.
    const early = s.owned(B.CAMP) + s.owned(B.FARM) < cfg.smallLoadsUntil;
    const autoItems = new Set(standingIds.map((id) => s.deals.find((d) => String(d.id) === id)?.item).filter((i) => i != null));
    const items = new Set(cfg.sellAll ? Object.keys(s.stock).map(Number) : []);
    items.add(WOOD); items.add(COTTON);
    const loads = [];
    for (const item of items) {
      if (autoItems.has(item) || NEVER_SELL.includes(item) || cfg.neverSell.includes(item) || s.catalog.items[item]?.intangible) continue;
      const spare = Math.floor(s.has(item) - sellReserve(s, item));
      const small = early && (item === WOOD || item === COTTON);
      const n = small ? Math.min(load(item), spare) : load(item);
      if (spare < n || n < (small ? cfg.minSmallLoad : 1)) continue;
      for (const d of bids(item)) {
        if (d.amount < n) continue; // nearly filled: try the next bid
        loads.push({ item, n, d, value: d.price / d.amount * n });
        break;
      }
    }
    loads.sort((a, z) => z.value - a.value);
    for (const { item, n, d, value } of loads) {
      const id0 = s.shipId;
      yield act(`fill:${d.id}`, `sell ${n} ${iname(s, item)} @ ${usd(d.price / d.amount)} = ${usd(value)}${n === load(item) ? ' (full courier load)' : ' (part load)'}`,
        { msg: { type: 'FillDeal', deal: d.id, amount: n, hire: null, region: REGION, courier: true }, until: (x) => x.shipId > id0 });
    }
  }
  // Never sold: what the plan builds with, and corp-wide data.
  const NEVER_SELL = [PLANKS, WFRAME, IFRAME, MONEY, CD, 25, 26, LD];

  // First candidate action not cooling down. Waits are collected; a final wait (saving for a
  // plan building) stops the search so camps don't eat the money.
  function decide(s) {
    const waits = [];
    for (const c of candidates(s)) {
      if (c.steps) {
        if (usesCourier(c)) c.meta = { ...(c.meta ?? {}), courierReadyAt: s.courierReadyAt };
        if (cooling(c.key)) { waits.push(`backing off "${c.reason}" (${cooldowns.get(c.key).why || 'not confirmed'})`); continue; }
        return c;
      }
      waits.push(c.wait);
      if (c.final) break;
    }
    const isNote = (w) => /^no seller|^courier busy|backing off/.test(w);
    const main = waits.find((w) => !isNote(w)) ?? waits[0] ?? 'nothing to do';
    const extra = waits.filter((w) => w !== main && /^no seller|backing off/.test(w));
    return { wait: main + (extra.length ? ` | ${extra.slice(0, 2).join(' | ')}` : ''), waits };
  }

  // ---- execute -------------------------------------------------------------------

  const sleep = core.sleep;
  const jitter = () => sleep(cfg.jitterMinMs + Math.random() * Math.max(0, cfg.jitterMaxMs - cfg.jitterMinMs));
  class ConnError extends Error {}

  function waitConfirm(until, d0) {
    return core.waitConfirm({ read, pred: until, d0, timeoutMs: cfg.timeoutMs, closed: () => { throw new ConnError('socket closed while waiting'); } });
  }

  let sentTimes = [];
  // true = done (or harmless), false = failed, 'held' = not sent because of a hold.
  async function execute(a) {
    inStep = true;
    try { return await executeSteps(a); } finally { inStep = false; }
  }
  async function executeSteps(a) {
    if (a.call) {
      // Not a socket message: hand work to another module (CD Farm). Not awaited: it runs on its own.
      await jitter();
      if (!running) return true;
      if (heldReason()) return 'held';
      const ok = !!a.call();
      finish(a, ok, ok ? 1 : 0, read(), ok ? '' : 'CD Farm did not start');
      if (ok) core.ledger.add('AP', 'action', a.reason);
      if (!ok) note(`not started: ${a.reason} — backing off (see the CD Farm panel / console)`);
      return ok;
    }
    let done = 0, m0 = null;
    for (const step of a.steps) {
      await jitter();
      if (!running) { if (done) finish(a, false, done, read(), 'stopped'); return true; }
      // A hold (e.g. CD Farm starting) only stops an action before its first message:
      // half a build+demolish is finished rather than left for cleanup.
      if (done === 0 && heldReason()) return 'held';
      takeLock();
      const s = read(true);
      if (!s) throw new ConnError('game state not found');
      if (!s.wsOpen) throw new ConnError('socket not open');
      const d0 = core.markSend(s.mutTick);
      m0 ??= s.money;
      s.ws.send(JSON.stringify(step.msg));
      sentTimes.push(Date.now());
      if (!(await waitConfirm(step.until, d0))) {
        const after = read();
        if (finish(a, false, done, after, step.optional ? 'not available yet' : 'server did not apply it') === 'courier') {
          note(`courier busy (freight cooldown or auto-ship): "${a.reason}" waits ${Math.ceil((courierHoldUntil - nowMs()) / 1000)} s`);
          return true; // not an error: it goes again when the courier is back
        }
        note(`${step.optional ? 'skipped' : 'not confirmed'}: ${a.reason} — backing off`);
        return !!step.optional; // optional steps don't count as errors
      }
      done++;
    }
    const after = read();
    finish(a, true, done, after);
    core.ledger.add('AP', 'action', a.reason, { dMoney: m0 != null && after ? Math.round((after.money - m0) / 100) : undefined });
    return true;
  }

  // ---- loop / control -----------------------------------------------------------

  let lastLine = '', actions = 0, fails = 0, log = [], stopReason = '';
  const note = (line) => {
    if (line === lastLine) return;
    lastLine = line;
    log = [`${new Date().toLocaleTimeString()} ${line}`, ...log].slice(0, 6);
    console.log('[earlyGame] ' + line);
    if (LEDGER_NOTE.test(line)) core.ledger.add('AP', /^(connection back|progress)/.test(line) ? 'info' : 'fail', line);
  };
  const LEDGER_NOTE = /^(stopping|error:|not confirmed|skipped|not started|connection back|Live refused|stalled|slowing down|progress again)/;

  let active = false; // a loop is still executing (maybe finishing a step after stop())

  // ---- watchdog, pacing, game check --------------------------------------------------
  let rateScale = 1, okStreak = 0, waitStreak = 0, stalled = '', lastPhase = null, lastLiveCheck = 0, liveCountdownUntil = 0;
  const INCOME_ACTION = /^(fill|autoship):/;           // selling is steady-state income, not plan progress
  const prog = { sig: '', at: 0, money: 0, acts: 0 };   // last time the plan moved (nowMs clock)
  const cash = [];                                      // { t, m } samples for the cash-change rate
  const sstore = (() => { try { return W.sessionStorage ?? null; } catch { return null; } })();
  const LIVE_KEY = KEY + '.live';
  const liveFlag = (() => { try { const f = JSON.parse(sstore?.getItem(LIVE_KEY) || 'null'); return f && Date.now() - f.t < 10 * 60000 ? f : null; } catch { return null; } })();
  const heartbeatLive = () => { try { sstore?.setItem(LIVE_KEY, JSON.stringify({ t: Date.now() })); } catch {} };
  const clearLive = () => { try { sstore?.removeItem(LIVE_KEY); } catch {} };

  // Plan progress is a change in phase, CD, building count, unlocks or research, or cash up 10 %
  // (+$100). With no progress for cfg.stallMinutes while actions keep coming (20+), say so:
  // a badge, a notification and a banner. It never stops the run by itself. Waiting on a
  // courier or research sends no actions, so it never counts.
  function watchStall(s, acting) {
    const t = nowMs(), ph = phaseOf(s);
    if (ph !== lastPhase) {
      if (lastPhase != null && running && !cfg.dryRun) core.notify('AP', ph === 'done' ? 'Autopilot: plan done' : 'Autopilot: phase ' + ph, 'Money ' + usd(s.money) + ', CD ' + s.cd);
      lastPhase = ph;
    }
    const sig = [ph, s.cd, s.totalBuildings, (s.st.unlocked_buildings ?? []).length, s.research ? 1 : 0, s.queue.length].join('|');
    if (sig !== prog.sig || s.money > prog.money * 1.1 + 10000 || ph === 'done' || !prog.at) {
      prog.sig = sig; prog.at = t; prog.money = s.money; prog.acts = 0;
      if (stalled) { stalled = ''; core.setBadge('AP', ''); note('progress again'); }
      return;
    }
    if (cfg.dryRun) return;
    if (acting) prog.acts++;
    if (!stalled && cfg.stallMinutes > 0 && prog.acts >= 20 && t - prog.at >= cfg.stallMinutes * 60000) {
      stalled = 'no plan progress for ' + Math.round((t - prog.at) / 60000) + ' min (' + prog.acts + ' actions since)';
      note('stalled: ' + stalled);
      core.setBadge('AP', 'AP stalled');
      core.notify('AP', 'Autopilot looks stalled', stalled);
    }
  }

  // Does the game still look like what this script was written against? Live mode needs it.
  function checkGame(s) {
    const bad = [];
    const miss = core.missingFields(s.st, ['groups', 'stock', 'ssi', 'items']);
    if (miss.length) bad.push('state is missing ' + miss.join(', '));
    const c = s.catalog;
    for (const k of ['items', 'buildings', 'recipes']) if (!Object.keys(c[k] ?? {}).length) bad.push('catalog.' + k + ' is empty');
    if (!c.techs?.length) bad.push('catalog.techs is empty');
    const camp = c.buildings[B.CAMP];
    if (!camp || typeof camp.cost !== 'number' || typeof camp.acres !== 'number') bad.push('Lumber Camp has no cost / acres');
    const fell = c.recipes[R.FELL_WOOD];
    if (!fell || !Array.isArray(fell.inputs) || !Array.isArray(fell.outputs) || typeof fell.ticks !== 'number') bad.push('Fell Wood recipe changed');
    if (typeof c.items[WOOD]?.base_value !== 'number') bad.push('Wood has no base_value');
    if (typeof s.st.items?.[MONEY] !== 'number') bad.push('money is not items[0]');
    return bad;
  }
  // Why Live must not run right now ('' = fine). Dry runs and the offline sim (no DOM) are never blocked.
  function liveBlocked(s) {
    if (!HAS_DOM || cfg.dryRun || !s) return '';
    const bad = checkGame(s);
    return bad.length ? 'the game data no longer looks like what this script expects (' + bad.join('; ') + ')' : '';
  }

  // Cash change per hour over the last hour (needs 5 min of samples). Includes spending: it is net.
  function trackCash(s) {
    const t = nowMs();
    if (!cash.length || t - cash[cash.length - 1].t >= 30000) cash.push({ t, m: s.money });
    while (cash.length && t - cash[0].t > 3600000) cash.shift();
  }
  function cashRate() {
    if (cash.length < 2) return null;
    const a = cash[0], b = cash[cash.length - 1], dt = b.t - a.t;
    return dt >= 300000 ? { perHour: (b.m - a.m) / (dt / 3600000), mins: Math.round(dt / 60000) } : null;
  }

  async function loop() {
    active = true;
    let lostSince = 0, courierWaiting = false;
    waitStreak = 0;
    while (running) {
      let pause = cfg.intervalMs;
      try {
        const s = read();
        if (!s || !s.wsOpen) {
          lostSince ||= Date.now();
          if (lockOwner() === TAB || !lockOwner()) takeLock();
          note(`waiting for the game connection (${Math.round((Date.now() - lostSince) / 1000)} s)…`);
          await sleep(2000);
          continue;
        }
        if (lostSince) { lostSince = 0; note('connection back'); await sleep(2000); continue; } // let the fresh Snapshot land
        const owner = lockOwner();
        if (owner && owner !== TAB) { stopReason = 'another tab is running Autopilot'; note('stopping: ' + stopReason); break; }
        takeLock();
        if (!cfg.dryRun) {
          heartbeatLive();
          if (HAS_DOM && Date.now() - lastLiveCheck > 60000) {
            lastLiveCheck = Date.now();
            const why = liveBlocked(s);
            if (why) { cfg.dryRun = true; clearLive(); note('Live refused: ' + why); core.notify('AP', 'Autopilot switched to dry run', why); render(); continue; }
          }
        }
        observe(s);
        trackCash(s);
        const held = heldReason();
        if (held) { note('paused: ' + held); await sleep(cfg.intervalMs); continue; }
        sentTimes = sentTimes.filter((t) => Date.now() - t < 60000);
        if (sentTimes.length >= Math.max(2, Math.floor(cfg.maxActionsPerMin * rateScale))) { note('rate limit: waiting'); await sleep(5000); continue; }
        const a = decide(s);
        watchStall(s, !a.wait && !INCOME_ACTION.test(a.key ?? ''));
        if (a.wait) {
          note('wait — ' + a.wait);
          // Nothing to do: look less often the longer it lasts (up to cfg.maxIdleMs). A command applied
          // by the server (yours, or one you click) ends the sleep early.
          waitStreak++;
          pause = Math.min(Math.max(cfg.maxIdleMs, cfg.intervalMs), cfg.intervalMs * (1 + Math.floor(waitStreak / 5)));
          // Courier work is waiting on the freight cooldown: wake right when it ends and retry.
          if (a.waits.some((w) => /^courier busy/.test(w))) {
            courierWaiting = true;
            const back = courierBackInMs(s);
            if (back > 0) pause = Math.min(pause, back + 250);
          }
        }
        else if (cfg.dryRun) note('DRY RUN would: ' + a.reason + '  ' + (a.callInfo ?? a.steps.map((x) => JSON.stringify(x.msg)).join(' ; ')));
        else {
          waitStreak = 0;
          if (courierWaiting && usesCourier(a)) note('courier back: retrying');
          courierWaiting = false;
          note(a.reason);
          const res = await execute(a);
          if (res === 'held') continue;
          if (res) {
            actions++; fails = 0;
            // Back to full pace after 10 confirmed actions in a row.
            if (++okStreak >= 10 && rateScale < 1) { rateScale = Math.min(1, rateScale * 1.25); okStreak = 0; }
          } else {
            // An action the server did not apply: slow down (half the action cap, down to a quarter).
            okStreak = 0;
            if (rateScale > 0.25) { rateScale = Math.max(0.25, rateScale / 2); note('slowing down to ' + Math.round(rateScale * 100) + '% pace'); }
            if (++fails >= 10) { stopReason = '10 actions in a row were not confirmed'; note('stopping: ' + stopReason); break; }
          }
          continue;
        }
        fails = 0;
      } catch (e) {
        if (e instanceof ConnError) { note(e.message); await sleep(2000); continue; }
        fails++;
        note(`error: ${e.message}`);
        if (fails >= 10) { stopReason = '10 errors in a row'; note('stopping after ' + stopReason); break; }
      }
      await core.sleepWake(pause);
    }
    running = false; active = false; save(); dropLock(); clearLive(); core.setBadge('AP', '');
    if (stopReason && stopReason !== 'stopped by you') core.notify('AP', 'Autopilot stopped', stopReason);
    render();
  }

  function start(opts = {}) {
    if (running) return console.warn('[earlyGame] already running');
    if (active) return console.warn('[earlyGame] the previous run is still finishing its step; try again in a few seconds');
    const owner = lockOwner();
    if (owner && owner !== TAB) return console.warn('[earlyGame] already running in another tab of this browser');
    Object.assign(cfg, opts);
    if (!cfg.dryRun && HAS_DOM) {
      const why = liveBlocked(read(true));
      if (why) { cfg.dryRun = true; console.warn('[earlyGame] Live refused: ' + why + '. Starting as a dry run.'); core.toast('Live refused: the game data changed. Started as a dry run (see the console).'); core.ledger.add('AP', 'fail', 'Live refused: ' + why); }
    }
    takeLock();
    running = true; fails = 0; lastLine = ''; stopReason = '';
    stalled = ''; prog.at = 0; waitStreak = 0; rateScale = 1; okStreak = 0; lastLiveCheck = Date.now();
    core.setBadge('AP', '');
    if (cfg.dryRun) clearLive(); else heartbeatLive();
    save();
    console.log(`[earlyGame] start (${cfg.dryRun ? 'DRY RUN — start({ dryRun: false }) to send' : 'LIVE'})`);
    loop();
    render();
  }
  function stop() { if (running) stopReason = 'stopped by you'; running = false; clearLive(); save(); dropLock(); console.log('[earlyGame] stopped'); render(); }

  // Settings out and in (the toolkit's Export / Import buttons). Never touches session-only settings.
  function exportCfg() { return { cfg: persistable() }; }
  function importCfg(o) {
    if (running && !cfg.dryRun) throw new Error('stop the live run first');
    const applied = [], skipped = [];
    for (const [k, v] of Object.entries(o?.cfg ?? {})) {
      const f = FIELDS[k];
      const ok = k in cfg && !SESSION_ONLY.includes(k) && typeof v === typeof cfg[k] && Array.isArray(v) === Array.isArray(cfg[k])
        && (typeof v !== 'number' || Number.isNaN(v) === false)
        && !(f && ((f.min != null && v < f.min) || (f.max != null && v > f.max)));
      if (ok) { cfg[k] = v; applied.push(k); } else skipped.push(k);
    }
    save(); render();
    return { applied, skipped };
  }
  function resetCfg() {
    if (running && !cfg.dryRun) throw new Error('stop the live run first');
    for (const k of Object.keys(DEFAULTS)) if (!SESSION_ONLY.includes(k)) cfg[k] = Array.isArray(DEFAULTS[k]) ? [...DEFAULTS[k]] : DEFAULTS[k];
    save(); render();
  }

  // After a reload with cfg.liveResume (and this tab was running Live less than 10 min ago): 60 s to cancel.
  async function liveCountdown() {
    liveCountdownUntil = Date.now() + 60000;
    panel(true);
    core.notify('AP', 'Autopilot resumes LIVE in 60 s', 'Open the Autopilot panel and press Cancel to resume as a dry run instead.');
    while (liveCountdownUntil && Date.now() < liveCountdownUntil) {
      if (unloaded) return false;
      render();
      await sleep(500);
    }
    const go = liveCountdownUntil !== 0;
    liveCountdownUntil = 0;
    render();
    return go;
  }

  function keepPaused(id) { keptPaused.add(+id); billPaused.delete(+id); save(); console.log(`[earlyGame] group ${id} will never be auto-resumed`); }

  // What the next planned steps need, for CD Farm's Auto mode: the power-bill money floor (cents), items it must not
  // use (floor kits owed to unequipped buildings, an hour of what running groups eat, the next unlock's prototype),
  // and the next unlock with the CD it costs and whether everything else for it is ready. null until the game state is read.
  function reserve() {
    const s = read();
    if (!s) return null;
    const items = {};
    const add = (item, n) => { if (n > 0) items[item] = (items[item] ?? 0) + n; };
    for (const [item, n] of Object.entries(s.kitOwed)) add(item, n);
    for (const [item, perMin] of Object.entries(s.eatPerMin)) add(item, Math.ceil(perMin * 60));
    let next = null;
    const nt = nextTech(s);
    const tech = nt && s.catalog.techs.find((t) => t.building === nt.b);
    if (tech) {
      const proto = s.bld(nt.b).build_items ?? [];
      for (const p of proto) add(p.item, p.amount);
      const gate = nt.gate ? nt.gate(s) : true;
      const missing = proto.find((p) => s.has(p.item) < p.amount);
      const note = gate !== true ? gate : tech.requires != null && !s.unlocked(tech.requires) ? `${bname(s, tech.requires)} to be unlocked`
        : missing ? `the ${iname(s, missing.item)} prototype` : '';
      next = { b: nt.b, name: bname(s, nt.b), cd: tech.cost, prereqsMet: !note, note };
    }
    // What Autopilot's own selling keeps: wood and floor reserves, and the build items of its next two plan builds.
    add(WOOD, cfg.woodReserve);
    for (const item of [WOOD, ...Object.keys(s.eatPerMin).map(Number)]) add(item, floorReserve(s, item));
    for (const t of criticalTargets(s).slice(0, 2)) for (const p of s.bld(t.b).build_items ?? []) add(p.item, p.amount);
    return { moneyFloor: Math.max(moneyFloor(s), cfg.boosterKeepCash * 100), items, nextTech: next, phase: phaseOf(s) };
  }

  // Pause after the current step (resolves once nothing is being sent), e.g. CD Farm before it
  // takes its baseline of unassigned camps. Holds live in memory only; release() lifts one.
  async function hold(who = 'you') {
    holds.add(String(who)); render();
    const t0 = Date.now();
    while (inStep && Date.now() - t0 < 60000) await sleep(100);
  }
  function release(who = 'you') { holds.delete(String(who)); render(); }

  function plan() {
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const a = decide(s);
    console.log('[earlyGame] next: ' + (a.wait ? 'wait — ' + a.wait : a.reason), a.steps?.map((x) => x.msg) ?? '');
    return a;
  }

  function checklist(s) {
    const mark = (ok) => (ok ? '✓' : '·');
    const row = (label, have, target) => [label, `${mark(have >= target)} ${have} / ${target === Infinity ? '∞' : target}`];
    const techState = (b) => (s.unlocked(b) ? '✓' : s.research?.building === b ? 'researching' : s.queue.some((q) => q.building === b) ? 'queued' : '·');
    return [
      ['Phase', String(phaseOf(s))],
      ['Money', `${usd(s.money)} (floor ${usd(moneyFloor(s))})`],
      ['CD', s.cd],
      ['Acres', `${s.acresUsed} / ${s.acresOwned} · next ${usd(acrePrice(s.landBought))}`],
      ['Power', `${s.powerHave} MW (need ${s.powerNeed})`],
      ['Lumber Camps / Farms', `${s.owned(B.CAMP)} / ${s.owned(B.FARM)}`],
      ...techPlan().map((t) => [`P${t.phase} unlock ${bname(s, t.b)}`, techState(t.b)]),
      row('Sawmills', s.owned(B.SAWMILL), sawTarget(s)),
      row('Workshops (Frame Timber)', s.running(B.WORKSHOP, R.FRAME_TIMBER), cfg.workshops),
      row('Iron Mines', s.running(B.MINE, R.MINE_IRON), cfg.ironMines),
      row('Coal Mines', s.running(B.MINE, R.MINE_COAL), cfg.coalMines),
      row('Limestone Quarries', s.owned(B.QUARRY), cfg.quarries),
      row('Smelters', s.owned(B.SMELTER), cfg.smelters),
      row('Gold Mines', s.running(B.MINE, R.MINE_GOLD), cfg.goldMines),
      row('Workshops (Iron Frames)', s.running(B.WORKSHOP, R.RIVET), cfg.ironFrameWorkshops),
      ['Planks / Wooden / Iron Frames', `${Math.floor(s.has(PLANKS))} / ${Math.floor(s.has(WFRAME))} / ${Math.floor(s.has(IFRAME))}`],
      ['Unequipped (no kit)', s.groups.filter((g) => g.count > (g.equipped ?? 0)).map((g) => `${g.name} ${g.count - (g.equipped ?? 0)}`).join(', ') || '—'],
      ['Courier', s.courierFree ? 'free' : `busy, ${courierEta(s)}${Object.keys(s.standing).length ? ' (auto-ship running)' : ''}`],
      ['Floorplans', floorPlans(s).map((f) => `${f.task} x${f.cur.rate}${f.upgrade ? `→x${f.best.rate}` : ' ✓'}`).join(', ') || '—'],
      ['Starved', s.starved.map((g) => g.name).join(', ') || '—'],
      ['Paused', s.groups.filter((g) => g.paused).map((g) => `${g.name}${billPaused.has(g.id) && !keptPaused.has(g.id) ? ' (unpaid bill: auto-resume)' : ' (yours: left alone)'}`).join(', ') || '—'],
    ];
  }

  function status() {
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const d = decide(s);
    const rows = [...checklist(s),
      ['Next', d.wait ? 'wait — ' + d.wait : d.reason],
      ['Mode', `${running ? 'running' : 'stopped'}${cfg.dryRun ? ' (dry run)' : ''}`]];
    console.table(Object.fromEntries(rows));
    return rows;
  }

  function floors() {
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const rows = floorTable(s);
    console.log(`[earlyGame] floorplans — scorer: ${s.engine && !scorerBroken ? 'live (game engine)' : 'not found, using known rates'}`);
    console.table(rows);
    return rows;
  }

  // "Before you go offline": keep `hours` of power bills, and say what to check.
  function offline(hours = 8) {
    cfg.billHours = Math.max(1, hours); save();
    const s = read();
    if (!s) return console.error('[earlyGame] game state not found');
    const need = moneyFloor(s);
    const nt = nextTech(s);
    console.log(`[earlyGame] offline for ${hours} h:` +
      `\n  • power ${s.powerHave} MW → keep ${usd(need)} for bills (have ${usd(s.money)})${s.money < need ? '  ⚠ NOT ENOUGH: powered groups will pause' : ' ✓'}` +
      '\n  • the script now never spends below that, until the page reloads (earlyGame.cfg.billHours = 1 to undo)' +
      "\n  • auto-ship and selling stop while you're offline; stock piles up (24 h cap on the free plan)" +
      `\n  • research: ${s.research ? `${bname(s, s.research.building)} running ✓` : nt ? `idle — next is ${bname(s, nt.b)} (start a long unlock before leaving)` : 'idle'}`);
  }


  // ---- game UI ----------------------------------------------------------------------
  // Same look as CD Farm (the game's CSS variables and button classes): an "Autopilot" tab in the
  // sidebar, a chip in the top bar, and a draggable card that opens bottom-left (CD Farm's card
  // opens bottom-right). Nothing here runs without a DOM, so the offline simulator is unaffected.

  const UI_KEY = 'earlyGame.ui';
  const ui = (() => { try { return { open: true, x: null, y: null, ...JSON.parse(store?.getItem(UI_KEY) || '{}') }; } catch { return { open: true, x: null, y: null }; } })();
  const saveUi = () => { try { store?.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };


  const ICON = '<svg class="nav-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16h4v-4h4V8h4V4"></path><circle cx="15" cy="4" r="1.6" fill="currentColor" style="stroke:var(--nav-accent)"></circle></svg>';

  const mk = core.h;
  const K = core.ui;
  const uiNum = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const parseAmount = (str) => {
    const m = String(str).trim().replace(/[$,\s_]/g, '').match(/^(\d*\.?\d+)([kmb])?$/i);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1));
  };

  let P = null, chrome = null, uiTimer = null, unloaded = false;
  const refs = {};
  let confirmUntil = 0;

  const FIELDS = {
    workshops: { kind: 'count', label: 'Frame Timber Workshops', min: 0, max: 50 },
    sawmills: { kind: 'count', label: 'Sawmills (at least)', min: 0, max: 200 },
    ironMines: { kind: 'count', label: 'Iron Mines', min: 0, max: 100 },
    coalMines: { kind: 'count', label: 'Coal Mines', min: 0, max: 100 },
    goldMines: { kind: 'count', label: 'Gold Mines', min: 0, optional: true, empty: 'No limit' },
    ironFrameWorkshops: { kind: 'count', label: 'Iron Frame Workshops', min: 0, max: 50 },
    maxAcrePriceEarly: { kind: 'money', label: 'Land wall, early', min: 0 },
    maxAcrePrice: { kind: 'money', label: 'Land wall, later', min: 0 },
    boosterBatch: { kind: 'count', label: 'Booster batch', min: 1, max: 100 },
    boosterMinCash: { kind: 'money', label: 'Booster starts above', min: 0 },
    boosterKeepCash: { kind: 'money', label: 'Booster keeps', min: 0 },
    // Advanced
    quarries: { kind: 'count', label: 'Limestone Quarries', min: 0, max: 50 },
    smelters: { kind: 'count', label: 'Smelters', min: 0, max: 50 },
    maxAcrePriceCritical: { kind: 'money', label: 'Land wall, plan buildings', min: 0 },
    landCashShare: { kind: 'pct', label: 'Land: share of cash', min: 0, max: 1, unit: '%' },
    boosterAcres: { kind: 'count', label: 'Booster acres kept free', min: 0, max: 100 },
    woodReserve: { kind: 'count', label: 'Wood never sold below', min: 0, max: 1000000 },
    sellKeepMinutes: { kind: 'count', label: 'Keep minutes of use', min: 0, max: 1440, unit: 'min' },
    maxBuyPrice: { kind: 'mult', label: 'Max buy price (× base)', min: 0.1, max: 100, unit: '×' },
    floorBuyUsd: { kind: 'usd', label: 'Floor parts, $ per unit', min: 0, max: 1000 },
    buyOrderUsd: { kind: 'usd', label: 'Buy order, $ per unit', min: 0.01, max: 1000 },
    orderHoldHours: { kind: 'count', label: 'Order hold', min: 0, max: 720, unit: 'h' },
    maxActionsPerMin: { kind: 'count', label: 'Max actions per minute', min: 1, max: 60 },
    intervalMs: { kind: 'count', label: 'Check every', min: 500, max: 60000, unit: 'ms' },
    maxIdleMs: { kind: 'count', label: 'Slowest idle check', min: 500, max: 120000, unit: 'ms' },
    stallMinutes: { kind: 'count', label: 'Stall alert after', min: 0, max: 600, unit: 'min' },
  };
  const ADV_FIELDS = ['quarries', 'smelters', 'maxAcrePriceCritical', 'landCashShare', 'boosterAcres', 'woodReserve', 'sellKeepMinutes', 'maxBuyPrice', 'floorBuyUsd', 'buyOrderUsd', 'orderHoldHours', 'maxActionsPerMin', 'intervalMs', 'maxIdleMs', 'stallMinutes'];
  const CHECKS = [
    ['sellAll', 'Sell spare full courier loads'],
    ['cdBooster', 'CD booster (build + demolish)'],
    ['floorUpgrades', 'Apply better floorplans'],
    ['buyKits', 'Buy kit parts the corp can\'t make'],
    ['postBuyOrders', 'Post buy orders when no one sells'],
    ['dispatchOffice', 'Also unlock the Dispatch Office'],
    ['autoResume', 'Resume after reload (as a dry run unless Live resume is on)'],
  ];
  const ADV_CHECKS = [
    ['liveResume', 'Live resume: after a reload in this tab, go Live again after a 60 s cancel window'],
    ['autoShipCotton', 'Auto-ship Cotton'],
    ['saveForCritical', 'Save for a ready plan building before buying camps/farms'],
    ['resumePaused', 'Resume groups paused by an unpaid bill'],
  ];
  const VIA = [
    { id: 'builtin', label: 'Built-in', desc: 'Builds and demolishes the cheaper of Lumber Camp / Farm itself, after a 1-building test.' },
    { id: 'cdFarm', label: 'CD Farm', desc: 'Starts CD Farm up to the CD the next unlock needs, then waits until it stops. CD Farm\'s own settings come back afterwards.' },
  ];
  const MODES = [
    { id: true, label: 'Dry run' },
    { id: false, label: 'Live' },
  ];

  function setCfg(key, v) { cfg[key] = v; confirmUntil = 0; save(); render(); }
  const shownOf = (key, v) => (Number.isFinite(v) ? uiNum(FIELDS[key]?.kind === 'pct' ? v * 100 : v) : '');
  const shown = (key) => shownOf(key, cfg[key]);
  const same = (a, b) => (Array.isArray(a) ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b));
  const viaOf = (v) => (v === 'cdFarm' ? 'cdFarm' : 'builtin');
  const parseErr = {};
  function parseField(key, text) {
    const f = FIELDS[key];
    const str = text.trim();
    if (str === '') return f.optional ? { v: Infinity } : { err: 'Required.' };
    const decimal = f.kind === 'usd' || f.kind === 'mult' || f.kind === 'pct';
    let v;
    if (decimal) {
      v = /^[$]?\d*\.?\d+[%×x]?$/i.test(str.replace(/[,\s_]/g, '')) ? Number(str.replace(/[$,%×x\s_]/gi, '')) : null;
      if (v != null && f.kind === 'pct') v /= 100;
    } else v = parseAmount(str);
    if (v == null) return { err: decimal ? 'Use a number like 1 or 0.5.' : f.kind === 'money' ? 'Use an amount like 500, 20k or 1.5m.' : 'Use a whole number.' };
    const disp = (x) => uiNum(f.kind === 'pct' ? x * 100 : x);
    if (f.min != null && v < f.min) return { err: `At least ${disp(f.min)}.` };
    if (f.max != null && v > f.max) return { err: `At most ${disp(f.max)}.` };
    return { v };
  }
  function textField(key) {
    const f = FIELDS[key];
    const { input, box } = K.inputBox({ label: f.label, prefix: f.kind === 'money' || f.kind === 'usd' ? '$' : '', suffix: f.unit, placeholder: f.empty || '' });
    const msg = mk('div', { class: 'idc-msg error', hidden: true });
    const revert = () => { delete parseErr[key]; input.value = shown(key); };
    input.addEventListener('input', () => {
      const p = parseField(key, input.value);
      if (p.err) { parseErr[key] = p.err; render(); } else { delete parseErr[key]; setCfg(key, p.v); }
    });
    input.addEventListener('blur', () => { revert(); render(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { revert(); input.blur(); } });
    const el = K.field(f.label, box, msg);
    refs.fields[key] = { input, box, msg, el };
    return el;
  }
  const row = K.row;
  const signed = (c) => (c < 0 ? '−' : '+') + usd(Math.abs(c));

  function doReset() {
    try {
      const snap = exportCfg();
      resetCfg();
      core.toast('Autopilot settings are back to their defaults', { undo: () => { if (unloaded) return; try { importCfg(snap); } catch (e) { core.toast(e.message, 'error'); } } });
    } catch (e) { core.toast(e.message, 'error'); }
  }
  function doClearLog() {
    const snap = core.ledger.list();
    core.ledger.clear(); render();
    core.toast('Log cleared', { undo: () => { if (unloaded) return; core.ledger.restore(snap); render(); } });
  }

  function buildPanel() {
    refs.badge = mk('span', { class: 'idc-badge' });

    // ---- Status tab
    refs.phase = mk('span', { class: 'idc-big' });
    refs.phaseOf = mk('span', { class: 'idc-label' });
    refs.bar = mk('i');
    refs.rows = mk('div', { class: 'idc-rows' });
    refs.stateDot = mk('span', { class: 'idc-dot' });
    refs.state = mk('span');
    refs.noteText = mk('span');
    refs.noteBtn = mk('button', { type: 'button', onclick: () => W.cdFarm?.panel?.(true) }, 'Open CD Farm');
    refs.note = mk('div', { class: 'idc-note', hidden: true }, refs.noteText, refs.noteBtn);
    refs.log = mk('div', { class: 'idc-recent', 'aria-live': 'polite' });
    const banner = (label, onclick) => { const text = mk('span'); const btn = mk('button', { type: 'button', onclick }, label); return { text, btn, el: mk('div', { class: 'idc-note', hidden: true }, text, btn) }; };
    refs.live = banner('Cancel: resume as a dry run', () => { liveCountdownUntil = 0; render(); });
    refs.stall = banner('Snooze', () => { stalled = ''; core.setBadge('AP', ''); prog.at = nowMs(); prog.acts = 0; render(); });
    refs.check = mk('div', { class: 'idc-rows' });
    const checklistSec = mk('details', { class: 'idc-sec', open: !!ui.checkOpen }, mk('summary', {}, 'Checklist'), refs.check);
    checklistSec.addEventListener('toggle', () => { ui.checkOpen = checklistSec.open; saveUi(); });
    const status = [
      mk('div', {}, mk('div', { class: 'idc-label' }, 'Early-game plan'), mk('div', { class: 'idc-hero' }, refs.phase, refs.phaseOf), mk('div', { class: 'idc-bar' }, refs.bar)),
      refs.rows,
      mk('div', { class: 'idc-state' }, refs.stateDot, refs.state),
      refs.note, refs.live.el, refs.stall.el, refs.log,
      checklistSec];

    // ---- Settings tab
    refs.fields = {};
    refs.via = K.seg(VIA, () => viaOf(cfg.boosterVia), (id) => setCfg('boosterVia', id), 'CD booster runs through');
    refs.viaDesc = mk('div', { class: 'idc-desc' });
    refs.viaField = K.field('CD booster runs through', refs.via.el, refs.viaDesc);
    refs.checks = [...CHECKS, ...ADV_CHECKS].map(([key, label]) => {
      const input = mk('input', { type: 'checkbox', onchange: () => setCfg(key, input.checked) });
      return [key, input, K.check(input, label)];
    });
    const checkEl = (key) => refs.checks.find(([k]) => k === key)[2];
    refs.hours = mk('input', { type: 'text', inputMode: 'decimal', autocomplete: 'off', value: '8', 'aria-label': 'Hours offline' });
    refs.billNow = mk('div', { class: 'idc-desc' });
    const offBtn = mk('button', { type: 'button', onclick: () => { const hrs = Number(refs.hours.value); if (hrs > 0) { offline(hrs); render(); } } }, 'Keep bills');
    const lockIcon = mk('span', { 'aria-hidden': 'true' });
    lockIcon.innerHTML = K.ICONS.lock;
    refs.lock = mk('div', { class: 'idc-lock' }, lockIcon, 'Stop the live run to change settings.');
    refs.fs = mk('fieldset', { class: 'idc-form' },
      K.group('Build targets', mk('div', { class: 'idc-two' }, ...['workshops', 'sawmills', 'ironMines', 'coalMines', 'goldMines', 'ironFrameWorkshops'].map(textField))),
      K.group('Land price limits', mk('div', { class: 'idc-two' }, ...['maxAcrePriceEarly', 'maxAcrePrice'].map(textField)),
        mk('div', { class: 'idc-desc' }, 'The most per acre Autopilot will pay for land, early on and later.')),
      K.group('CD booster', refs.viaField, mk('div', { class: 'idc-two' }, ...['boosterBatch', 'boosterMinCash', 'boosterKeepCash'].map(textField)), checkEl('cdBooster')),
      K.group('Automation', ...['sellAll', 'floorUpgrades', 'buyKits', 'postBuyOrders', 'dispatchOffice', 'autoResume'].map(checkEl)),
      K.group('Power bills', K.field('Going offline: keep power bills for',
        mk('div', { class: 'idc-inline' }, mk('div', { class: 'idc-inp' }, refs.hours, mk('span', {}, 'h')), offBtn), refs.billNow)),
      mk('details', { class: 'idc-sub', open: !!ui.advOpen, ontoggle: (e) => { ui.advOpen = e.target.open; saveUi(); } },
        mk('summary', {}, 'Advanced'),
        K.group(null, mk('div', { class: 'idc-two' }, ...ADV_FIELDS.map(textField)), ...ADV_CHECKS.map(([key]) => checkEl(key)))));
    refs.importBtn = mk('button', { type: 'button', onclick: () => core.importFile() }, 'Import settings');
    refs.resetBtn = K.confirmBtn('Reset settings', doReset, 'Click again to reset');
    const backup = K.group('Backup', mk('div', { class: 'idc-tools' }, mk('button', { type: 'button', onclick: () => core.exportFile() }, 'Export settings'), refs.importBtn, refs.resetBtn));
    const settings = [refs.lock, refs.fs, backup];

    // ---- Log tab
    refs.logv = K.createLogView();
    refs.alertBtn = mk('button', { type: 'button', title: 'Notify me when Autopilot stops, stalls or changes phase while this tab is in the background', onclick: async () => { await core.askNotify(); render(); } }, 'Enable alerts');
    const logTab = [
      refs.logv.el,
      mk('div', { class: 'idc-tools' },
        mk('button', { type: 'button', onclick: () => core.ledger.copy() }, 'Copy log'),
        mk('button', { type: 'button', class: 'danger', onclick: doClearLog }, 'Clear log'),
        refs.alertBtn),
      mk('div', { class: 'idc-desc' }, 'Alt+Shift+X stops Autopilot, CD Farm and the Lab runner from anywhere on the page.')];

    // ---- Footer (always visible)
    refs.mode = K.seg(MODES, () => !!cfg.dryRun, (id) => { cfg.dryRun = id; confirmUntil = 0; render(); }, 'Run mode');
    refs.plan = mk('div', { class: 'idc-plan' });
    refs.alt = mk('button', { onclick: () => { confirmUntil = 0; render(); } }, 'Cancel');
    refs.main = mk('button', { class: 'primary', onclick: onMain });
    const foot = mk('div', { class: 'idc-foot' }, refs.mode.el, refs.plan, mk('div', { class: 'idc-btns' }, refs.alt, refs.main));

    P = K.createPanel({
      id: 'ap', title: 'Autopilot', cls: 'egp-panel', state: ui, save: saveUi, headExtra: [refs.badge], foot,
      tabs: [{ id: 'status', label: 'Status', content: status }, { id: 'settings', label: 'Settings', content: settings }, { id: 'log', label: 'Log', content: logTab }],
      onClose: () => panel(false), onTab: () => render(), opener: () => chrome?.opener,
      // Default: bottom-left of the page content, just right of the game's sidebar.
      defaultPlace: () => { const side = document.querySelector('.primary-navigation')?.getBoundingClientRect(); return { left: side && side.right < innerWidth / 2 ? Math.round(side.right + 16) : 20 }; },
    });
    refs.dot = P.dot;
  }

  function onMain() {
    if (running) return stop();
    if (cfg.dryRun) return start();
    if (Date.now() < confirmUntil) { confirmUntil = 0; return start(); }
    confirmUntil = Date.now() + 6000;
    render();
    setTimeout(render, 6100);
  }

  // 'run' | 'wait' | 'err' | ''
  function tone() {
    if (running && stalled) return 'err';
    if (running) return heldReason() || cfg.dryRun ? 'wait' : 'run';
    if (stopReason && stopReason !== 'stopped by you') return 'err';
    return '';
  }

  function cdFarmNote() {
    const fi = farmInfo();
    if (fi?.busy) return { text: `CD Farm is running${fi.f.stats?.by ? ` (${fi.f.stats.by})` : ''}. Autopilot waits until it stops.`, btn: true };
    if (fi?.resumable) return { text: 'CD Farm has an interrupted run. Its leftover camps are left alone, and no camps, farms or booster run until you resume or discard it there.', btn: true };
    if (cfg.boosterVia === 'cdFarm' && !fi) return { text: 'The CD booster is set to CD Farm, but CD Farm isn\'t loaded: the built-in booster is used.', btn: false };
    if (holds.size) return { text: `Held by ${[...holds].join(', ')}. earlyGame.release() to go on.`, btn: false };
    return null;
  }

  function renderPanel(s) {
    const t = tone();
    refs.dot.className = refs.stateDot.className = 'idc-dot ' + t;
    refs.badge.textContent = cfg.dryRun ? 'Dry run' : 'Live';
    refs.badge.className = 'idc-badge' + (cfg.dryRun ? '' : ' live');
    if (!s) {
      refs.phase.textContent = '—'; refs.phaseOf.textContent = ''; refs.rows.replaceChildren(); refs.check.replaceChildren();
      refs.state.textContent = 'Waiting for the game to load…';
    } else {
      const ph = phaseOf(s);
      refs.phase.textContent = ph === 'done' ? 'Plan done' : `Phase ${ph}`;
      refs.phaseOf.textContent = ph === 'done' ? '' : 'of 5';
      const list = checklist(s);
      const marks = list.filter(([, v]) => /^(✓|·|researching|queued)/.test(v));
      refs.bar.style.width = (marks.length ? (marks.filter(([, v]) => v.startsWith('✓')).length / marks.length) * 100 : 0) + '%';
      refs.rows.replaceChildren(
        row('Money', `${usd(s.money)} · floor ${usd(moneyFloor(s))}`),
        row('CD', uiNum(s.cd)),
        row('Acres', `${s.acresUsed} / ${s.acresOwned} · next ${usd(acrePrice(s.landBought))}`),
        row('Power', `${s.powerHave} MW (need ${s.powerNeed})`),
        row('Courier', s.courierFree ? 'free' : `busy, ${courierEta(s)}`),
        row('Actions', `${actions} sent this session`),
        ...(cashRate() ? [row('Cash change', `${signed(cashRate().perHour)}/h (last ${cashRate().mins} min)`)] : []),
        ...(rateScale < 1 ? [row('Pace', `${Math.round(rateScale * 100)}% after an action the server did not apply`)] : []));
      const skip = new Set(['Phase', 'Money', 'CD', 'Acres', 'Power', 'Courier']);
      refs.check.replaceChildren(...list.filter(([k]) => !skip.has(k)).map(([k, v]) => row(k, String(v))));
      const held = running && heldReason();
      let next;
      try { const d = decide(s); next = d.wait ? 'Waiting: ' + d.wait : 'Next: ' + d.reason; } catch (e) { next = 'error: ' + e.message; }
      refs.state.textContent = held ? `Paused: ${held}`
        : running ? (cfg.dryRun ? 'Dry run. ' : '') + next
        : (stopReason ? `Stopped: ${stopReason}. ` : 'Stopped. ') + next;
    }
    const n = cdFarmNote();
    refs.note.hidden = !n;
    if (n) { refs.noteText.textContent = n.text; refs.noteBtn.hidden = !n.btn || !W.cdFarm?.panel; }
    refs.log.replaceChildren(...log.map((l) => mk('div', {}, l)));
    refs.live.el.hidden = !liveCountdownUntil;
    if (liveCountdownUntil) refs.live.text.textContent = `Resuming Live after the reload in ${Math.max(0, Math.ceil((liveCountdownUntil - Date.now()) / 1000))} s. Cancel to resume as a dry run instead.`;
    refs.stall.el.hidden = !stalled;
    if (stalled) refs.stall.text.textContent = `Looks stalled: ${stalled}. Autopilot keeps running; check the log below.`;
    if (ui.tab === 'log' && !ui.min) { refs.logv.render(); refs.logv.markSeen(); }
    const unseen = ui.tab === 'log' ? 0 : refs.logv.unseen();
    P.setTabBadge('log', unseen ? unseen + ' new problem' + (unseen > 1 ? 's' : '') : '', true);
    refs.alertBtn.hidden = core.notifyPerm() !== 'default';

    // Settings
    const locked = running && !cfg.dryRun;
    refs.importBtn.disabled = refs.resetBtn.disabled = locked;
    refs.fs.disabled = locked;
    refs.lock.hidden = !locked;
    let changed = 0;
    for (const [key, f] of Object.entries(refs.fields)) {
      if (document.activeElement !== f.input) f.input.value = shown(key);
      f.msg.hidden = !parseErr[key]; f.msg.textContent = parseErr[key] || '';
      f.box.classList.toggle('bad', !!parseErr[key]);
      const mod = !same(cfg[key], DEFAULTS[key]);
      if (mod) changed++;
      K.setModified(f.el, mod, 'Reset to the default (' + (shownOf(key, DEFAULTS[key]) || FIELDS[key].empty || 'none') + ')', () => { delete parseErr[key]; setCfg(key, DEFAULTS[key]); });
    }
    refs.via.sync();
    refs.viaDesc.textContent = VIA.find((v) => v.id === viaOf(cfg.boosterVia)).desc;
    const viaMod = viaOf(cfg.boosterVia) !== viaOf(DEFAULTS.boosterVia);
    if (viaMod) changed++;
    K.setModified(refs.viaField, viaMod, 'Reset to the default (' + VIA.find((v) => v.id === viaOf(DEFAULTS.boosterVia)).label + ')', () => setCfg('boosterVia', DEFAULTS.boosterVia));
    for (const [key, input, label] of refs.checks) {
      input.checked = !!cfg[key];
      const mod = !!cfg[key] !== !!DEFAULTS[key];
      label.classList.toggle('mod', mod); label.title = mod ? 'Changed from the default' : '';
      if (mod) changed++;
    }
    P.setTabBadge('settings', changed ? changed + ' setting' + (changed > 1 ? 's' : '') + ' changed from the defaults' : '');
        refs.billNow.textContent = `Now ${cfg.billHours} h${s ? ` = ${usd(moneyFloor(s))} kept` : ''}. Back to 1 h on reload.`;

    // Footer
    refs.mode.sync();
    refs.mode.btns.forEach((b) => { b.disabled = running || active; });
    const other = lockOwner() && lockOwner() !== TAB && !running;
    const confirming = !running && !cfg.dryRun && Date.now() < confirmUntil;
    refs.plan.hidden = running;
    refs.plan.classList.toggle('hot', confirming);
    refs.plan.textContent = cfg.dryRun
      ? 'Dry run: works out every step and writes it to the log, but sends nothing.'
      : `Live: sends actions to the game, one confirmed step at a time, and never spends below the power-bill floor${s ? ` (${usd(moneyFloor(s))})` : ''}.${confirming ? ' Click Confirm start to go.' : ''}`;
    refs.main.textContent = running ? 'Stop' : other ? 'Running in another tab' : active ? 'Stopping…' : cfg.dryRun ? 'Start dry run' : confirming ? 'Confirm start' : 'Start live';
    refs.main.disabled = !running && (other || active || !s);
    refs.alt.hidden = !confirming;
  }

  const onResize = () => P?.place();

  function render() {
    if (!HAS_DOM || unloaded) return;
    const s = read();
    const t = tone();
    const ph = s ? phaseOf(s) : null;
    chrome?.setPill(heldReason() ? 'Held' : cfg.dryRun ? 'Dry run' : ph === 'done' ? 'Done' : `P${ph ?? '?'}`, t, !running);
    chrome?.setChip(ph == null ? 'Autopilot' : ph === 'done' ? 'Plan done' : `Phase ${ph}`, t,
      `Autopilot · ${running ? (heldReason() ? 'paused' : cfg.dryRun ? 'dry run' : 'live') : 'stopped'}`);
    const open = !!P?.el.isConnected;
    chrome?.setOpen(open);
    if (open) renderPanel(s);
  }

  function panel(show = true, opts = {}) {
    if (!HAS_DOM || unloaded) return;
    if (show) { if (!P) buildPanel(); P.mount(opts); } else P?.unmount();
    ui.open = !!show; saveUi();
    render();
  }

  function mountUi() {
    chrome = K.createChrome({
      label: 'Autopilot', navTitle: 'Early-game autopilot', icon: ICON, navClass: 'egp-tab', chipClass: 'egp-chip',
      onToggle: () => K.togglePanel(P, ui, panel),
      navInsert: (nav, el) => nav.insertBefore(el, nav.querySelector('.cdf-tab')),   // above CD Farm's tab
      chipInsert: (tools, el) => tools.insertBefore(el, tools.querySelector('.cdf-chip') || tools.querySelector('.tip-anchor') || null),
    });
    chrome.mount();
    uiTimer = setInterval(render, 1000);
    if (ui.open) panel(true); else render();
    addEventListener('resize', onResize);
  }
  function unmountUi() {
    clearInterval(uiTimer); uiTimer = null;
    P?.unmount(); chrome?.unmount();
    P = chrome = null;
    removeEventListener('resize', onResize);
  }

  // ---- load ---------------------------------------------------------------------------

  W.earlyGame = {
    start, stop, plan, status, floors, offline, keepPaused, panel, read, decide, cfg, hold, release, reserve, exportCfg, importCfg, resetCfg,
    get stalled() { return stalled; },
    get running() { return running; },
    get active() { return active; },
    get busy() { return running && !cfg.dryRun; },   // sending live actions
    get held() { return heldReason(); },
    // Pure pieces for the offline simulator.
    _core: {
      checkGame, watchStall, stalledNow: () => stalled, resetWatch: () => { stalled = ''; prog.at = 0; lastPhase = null; },
      snapshot: fullSnapshot, normalize, decide, checklist, phaseOf, finish, observe, userPaused, billPaused, floorTable, bomOf,
      setClock: (fn) => { nowMs = fn; courierHoldUntil = 0; courierMisses = 0; cooldowns.clear(); successes.clear(); failures.clear(); boosterBad = 0; for (const k in boosterLeft) delete boosterLeft[k]; },
    },
    _unload: () => {
      unloaded = true; running = false; holds.clear(); dropLock(); core.setBadge('AP', '');
      if (HAS_DOM) unmountUi();
    },
  };

  // Wait for the game to render and connect before mounting or resuming.
  if (HAS_DOM) (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    mountUi();
    console.log('[earlyGame] ready (dry run by default). Open "Autopilot" in the sidebar, or earlyGame.status() / earlyGame.plan() / earlyGame.start()');
    if (W.cdFarm?.running) console.warn('[earlyGame] CD Farm is running; Autopilot waits until it stops.');
    if (wasRunning && cfg.autoResume) {
      while (!read()?.wsOpen) { if (unloaded) return; await sleep(500); }
      await sleep(2000); // let the fresh snapshot land
      if (unloaded || running) return;
      let live = false;
      if (cfg.liveResume && liveFlag) { live = await liveCountdown(); if (unloaded || running) return; }
      cfg.dryRun = !live;
      console.log(live ? '[earlyGame] resuming the run from before the reload, LIVE (liveResume)'
        : '[earlyGame] resuming the run from before the reload (as a DRY RUN: switch to Live in the panel to send again)');
      start();
    }
  })();
})();
} catch (e) { console.error('[IdleCorp] Autopilot failed to load:', e); }
