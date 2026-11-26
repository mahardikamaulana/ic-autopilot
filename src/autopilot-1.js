// ============================================================================
// 2. AUTOPILOT
// ============================================================================
// @@MODULE early-game (test/early-game-sim.js evals everything from this line down)
//
// IdleCorp early-game autopilot: plays wiki/guides/early-game-plan.md, Phase 1 → Phase 5, over the game WebSocket.
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
// interrupted CD Farm run, and hands its CD booster to CD Farm.
//
// Phases (each step is a check on live state, so it starts wherever the corp is):
//   1-2  Lumber Camps + Farms (Cotton), whichever pays back sooner; part loads until 25 acres are full
//   2    Sawmill unlock + build (kit bought if needed); auto-ship Cotton
//   all  every item's full courier loads above its reserve are sold, best-paying first (like
//        auto-ship, for everything): Wood, Cotton, Gold Ore, surplus ore… never Planks or frames
//   3    buy land, 3 Sawmills, Workshop unlock at 155 CD + 205 Planks
//   4    2 Workshops on Frame Timber, 6 Sawmills, Mine → Quarry → Smelter;
//        Iron + Coal Mines sized to the Smelter (4 + 2 at equal floors), Limestone Quarry, Smelter on Iron Sheet, leftover frames → Gold Mines
//   5    Workshop on Rivet Iron Frame; unlock Factory → Kiln → Paper Mill → Manufacturing Lab
//        (→ Dispatch Office if cfg.dispatchOffice). Never the Drafting Bureau.
//        CD for these comes from Gold Mines and, when land gets too dear, the plan's
//        build-and-demolish booster (tested on 1 building first, off if it doesn't work).
//
// Safety: one confirmed action at a time; failed actions back off (15 s → 10 min) so they
// never block the rest; cash never drops below the power-bill floor; land walls (or payback); 360-acre cap; buy-price cap;
// bill-paused groups resumed (groups you pause, any time, stay paused); waits through socket
// drops; after a reload resumes as a DRY RUN (dryRun is never remembered); one copy per browser;
// one buy order per item per 24 h; pauses while cdFarm runs; never sells Planks or frames;
// courier busy (freight cooldown, auto-ship) → courier work waits, with no back-off or errors.
// Floorplans: every task a group runs is scored (the game's own scorer when the page has it,
// else known rates) against a library of the best known designs plus your saved designs; the
// best is applied automatically with EditLayout as soon as every part it adds (for every
// building on the task) is in stock. Missing parts are bought only from the player market at
// up to cfg.floorBuyMult (1.5× base value) per unit, or ordered at that price.
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
  // Ids are resolved by name from the catalog (resolveIds, once per catalog object); these numbers are the fallback.
  let MONEY = 0, CD = 24, LD = 111, MD = 25, RD = 26;
  let WOOD = 1, PLANKS = 9, COTTON = 76, WFRAME = 41, IFRAME = 42;
  const STARTER_ACRES = 25;
  const ACRE_CAP = 360;             // Heartland is always at the top charter level (wiki regions-and-land.md)
  const FIRST_ACRE = 5000;          // cents; next = floor(prev * 41 / 40)
  const COURIER_CU = 10000;
  const courierCU = () => core.courierCU?.() ?? COURIER_CU;   // with courier capacity upgrades when the core knows them
  const MAX_POWER = 200;

  const B = {
    CAMP: 0, MINE: 1, QUARRY: 2, SAWMILL: 4, SMELTER: 5, KILN: 6, WORKSHOP: 8, FARM: 10,
    LAB: 14, FACTORY: 15, PAPER_MILL: 23, DISPATCH: 36,
  };
  const R = {
    FELL_WOOD: 0, MINE_IRON: 1, MINE_COAL: 2, LIMESTONE: 5, SAW_PLANKS: 8, IRON_SHEET: 9,
    FRAME_TIMBER: 37, RIVET: 38, GROW_COTTON: 79, MINE_GOLD: 95, MIX_CONCRETE: 13,
  };
  const ID_NAMES = {
    building: { CAMP: 'Lumber Camp', MINE: 'Mine', QUARRY: 'Quarry', SAWMILL: 'Sawmill', SMELTER: 'Smelter', KILN: 'Kiln', WORKSHOP: 'Workshop',
      FARM: 'Farm', LAB: 'Manufacturing Lab', FACTORY: 'Factory', PAPER_MILL: 'Paper Mill', DISPATCH: 'Dispatch Office' },
    recipe: { FELL_WOOD: 'Fell Wood', MINE_IRON: 'Mine Iron Ore', MINE_COAL: 'Mine Coal', LIMESTONE: 'Quarry Limestone', SAW_PLANKS: 'Saw Planks',
      IRON_SHEET: 'Roll Iron Sheet', FRAME_TIMBER: 'Assemble Wooden Frame', RIVET: 'Assemble Iron Frame', GROW_COTTON: 'Grow Cotton', MINE_GOLD: 'Mine Gold Ore', MIX_CONCRETE: 'Mix Concrete' },
    item: { MONEY: 'Money', CD: 'Construction Data', LD: 'Logistics Data', MD: 'Manufacturing Data', RD: 'Research Data', WOOD: 'Wood', PLANKS: 'Planks',
      COTTON: 'Cotton', WFRAME: 'Wooden Frame', IFRAME: 'Iron Frame' },
  };
  const FALLBACK = { building: { ...B }, recipe: { ...R }, item: { MONEY, CD, LD, MD, RD, WOOD, PLANKS, COTTON, WFRAME, IFRAME } };
  let TASK, NAMES, HOME_MADE, NEVER_SELL;
  function tables() {
    TASK = {
      [B.CAMP]: R.FELL_WOOD, [B.FARM]: R.GROW_COTTON, [B.SAWMILL]: R.SAW_PLANKS,
      [B.QUARRY]: R.LIMESTONE, [B.SMELTER]: R.IRON_SHEET,
    };
    NAMES = {
      [R.FELL_WOOD]: 'Fell Wood', [R.GROW_COTTON]: 'Grow Cotton', [R.SAW_PLANKS]: 'Planks',
      [R.FRAME_TIMBER]: 'Frame Timber', [R.RIVET]: 'Iron Frames', [R.MINE_IRON]: 'Iron', [R.MINE_COAL]: 'Coal',
      [R.MINE_GOLD]: 'Gold', [R.LIMESTONE]: 'Limestone', [R.IRON_SHEET]: 'Iron Sheet',
      [R.MIX_CONCRETE]: 'Concrete',
    };
    // Items the plan makes itself: never bought for prototypes, never sold.
    HOME_MADE = [WOOD, PLANKS, WFRAME, IFRAME];
    // Never sold: what the plan builds with, and corp-wide data.
    NEVER_SELL = [PLANKS, WFRAME, IFRAME, MONEY, CD, MD, RD, LD];
  }
  tables();
  // Names not found in the catalog (their fallback number is used); checkGame reports them.
  const idMissing = [];
  let idsOf = null;   // the catalog the ids were last resolved from
  function resolveIds(c) {
    if (idsOf === c) return;
    idsOf = c;
    idMissing.length = 0;
    const find = (kind, list, key) => {
      const name = ID_NAMES[kind][key];
      const x = Object.values(list ?? {}).find((o) => o?.name === name);
      if (!x) idMissing.push(`${kind} "${name}"`);
      return x ? x.id : FALLBACK[kind][key];
    };
    for (const k of Object.keys(B)) B[k] = find('building', c.buildings, k);
    for (const k of Object.keys(R)) R[k] = find('recipe', c.recipes, k);
    const it = {};
    for (const k of Object.keys(ID_NAMES.item)) it[k] = find('item', c.items, k);
    ({ MONEY, CD, LD, MD, RD, WOOD, PLANKS, COTTON, WFRAME, IFRAME } = it);
    tables();
  }

  const cfg = {
    dryRun: true,            // log actions instead of sending them
    autoResume: true,        // after a page reload, resume a run that was going
    sawmills: 6,             // once the Workshop is unlocked (1 before, 3 from 50 buildings); at least 2 per Frame Timber Workshop
    workshops: 2,            // on Frame Timber
    ironFrameWorkshops: 1,   // Phase 5: on Rivet Iron Frame, once the Smelter runs
    ironMines: 1, coalMines: 1, // at least; more as the Smelters' Iron Ore / Coal use needs at the current floor rates (4 / 2 at equal rates)
    quarries: 1, smelters: 1, kilns: 1, labs: 1,
    goldMines: Infinity,     // leftover frames → Gold Mines (+8 CD each; the CD source for Smelter and Phase 5). Infinity = auto: up to GOLD_AUTO while a plan unlock is open
    dispatchOffice: false,   // Phase 5 optional unlock
    workshopPlanks: 205,     // planks before unlocking the Workshop (100 prototype + 100 build + 5 kit)
    landPaybackHours: 2,     // camps/farms/Gold Mines: land is also bought, above the walls below, while (acres + building) pay back from
                             // the building's own live income within this many hours (payback alone ignores the CD they bring: slower in the sim)
    maxAcrePrice: 500,       // $: land wall for camps/farms once the Workshop unlock has started, used when that income isn't known (no bid)
    maxAcrePriceEarly: 3000, // $: camps/farms before that (the plan pushes land until 155 CD), same fallback
    maxAcrePriceCritical: 5000, // $: land for plan buildings (Sawmill, Workshop, Mines, Smelter) ...
    landCashShare: 0.02,     // ... or up to this share of cash per acre, whichever is higher (money sitting still is wasted)
    // CD booster (the plan's "build-and-demolish CD"): once the Workshop is unlocked, when a plan
    // unlock waits only on CD and cash is idle, build cheap camps/farms and demolish them
    // (+1 CD each, 50% base refunded). Starts with a 1-building probe; disabled for good if the
    // CD isn't kept or the refund doesn't arrive (e.g. patched).
    cdBooster: true,
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
    buyOrderMult: 1.5,       // ... at this many × the item's base value per unit (money is escrowed; one open order per item)
    orderHoldHours: 24,      // never post another buy order for the same item within this time
    saveForCritical: true,   // stop buying camps/farms while saving for a ready plan building
    maxUnequippedCamps: 3,   // camps/farms waiting for their Wood kit before buying more
    resumePaused: true,      // resume powered groups paused by an unpaid bill
    floorUpgrades: true,     // switch tasks to the best-scoring known floorplan
    floorBuyMult: 1.5,       // missing floorplan parts: fill player sell orders at up to this many × base value per unit,
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
      store?.setItem(KEY, JSON.stringify({ cfg: persistable(), userPaused: [...userPaused], billPaused: [...billPaused], keptPaused: [...keptPaused], posted, running, boosterLeft }));
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
  // A reload or a closed tab never reaches stop(): give the lock up as the page goes, or the reloaded tab is refused for up to a minute.
  addEventListener?.('pagehide', dropLock);

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

  // CD booster leftovers: buildings a build-and-demolish left behind, cleaned up next loop.
  const boosterLeft = { ...(saved.boosterLeft || {}) };

  // Called every loop. A powered group that becomes paused while cash is under ~2 bills (or
  // the power service dropped) was paused by an unpaid bill; any other pause is yours.
  const lastPaused = new Map();
  function observe(s) {
    const needAll = s.groups.reduce((a, g) => a + s.drawOf(g.building) * g.count, 0);
    // With Auto power on, the subscription follows the running load, so being under the unpaused draw is not a short bill.
    const billShort = (!s.autoPower && s.powerHave < needAll) || s.money < Math.max(s.powerHave, needAll) * 1000 * 2;
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
    if (a.key.startsWith('booster:cleanup') && ok) boosterLeft[m.b] = Math.max(0, (boosterLeft[m.b] ?? 0) - m.n);
    save();
  }

