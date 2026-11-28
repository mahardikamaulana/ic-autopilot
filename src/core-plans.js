
// ---- plan presets (core.plans) -----------------------------------------------------------------------------------------------------
// A plan preset is data: what to unlock, build, assign and sell, in what order, with which numbers and conditions. The engines are rule
// libraries that read it: Autopilot plays a preset's `early` part, Core plan its `core` part. A new plan is one more entry in PLANS.
// Names are the game's own (buildings, recipes, items); each engine turns them into ids its usual way.
//
// Conditions (both parts) are specs, evaluated against an engine adapter `a`: plans.check(spec, a) -> [ok, why], plans.test(spec, a) -> ok.
//   { type: 'all' | 'any', of: [spec, ...], okWhy }   { type: 'not', of: spec }
//   { type: 'unlocked', of: [building, ...], okWhy }       every one unlocked ("not unlocked: a, b")
//   { type: 'locked', of: building, okWhy, noWhy }         not unlocked yet
//   { type: 'owned', of: [building, ...], min, okWhy }     each owned >= min (default 1) ("missing: a, b")
//   { type: 'ownedSum', of: [building, ...], min }         together >= min
//   { type: 'running', of: [[building, recipe], ...], min }          each >= min (default 1) on that recipe ("not running: b on r")
//   { type: 'runningEquipped', of: [[building, recipe], ...], min }  the same, counting only equipped, unpaused buildings
//   { type: 'stock', of: item, min }   { type: 'acresUsed', min }   { type: 'researching', of: building }  (running or queued)
//   { type: 'ref', of: name }          a condition the engine names (a.ref(name) -> boolean)
//   { type: 'targetsMet', of: [recipe, ...] }   those target rows are at target (a.targetsMet(list) -> boolean)
//   any other type: the engine's own (a.types[type](spec, a) -> [ok, why]), e.g. Core plan's ctx and land-rule conditions.
// okWhy may name items in braces ("running, Iron Frames {Iron Frame}"): their stock. The adapter has unlocked(b), owned(b), running(b, r),
// runningEquipped(b, r), has(item), acresUsed, researching(b), ref(name), targetsMet(list), types; it counts the engine's way, so a spec
// means exactly what the engine's own code meant.
const okText = (t, a) => t.replace(/\{([^}]+)\}/g, (_, n) => a.has(n));
const COND = {
  all(c, a) { for (const x of c.of) { const [ok, why] = checkCond(x, a); if (!ok) return [false, why]; } return [true, c.okWhy != null ? okText(c.okWhy, a) : 'all hold']; },
  any(c, a) { const whys = []; for (const x of c.of) { const [ok, why] = checkCond(x, a); if (ok) return [true, why]; whys.push(why); } return [false, whys.join('; ')]; },
  not: (c, a) => { const [ok, why] = checkCond(c.of, a); return [!ok, why]; },
  unlocked: (c, a) => { const miss = c.of.filter((b) => !a.unlocked(b)); return [!miss.length, miss.length ? 'not unlocked: ' + miss.join(', ') : c.okWhy ?? 'all unlocked']; },
  locked: (c, a) => (a.unlocked(c.of) ? [false, c.noWhy ?? c.of + ' is unlocked'] : [true, c.okWhy ?? 'not unlocked yet']),
  owned: (c, a) => { const miss = c.of.filter((b) => !(a.owned(b) >= (c.min ?? 1))); return [!miss.length, miss.length ? 'missing: ' + miss.join(', ') : c.okWhy ?? 'built']; },
  ownedSum: (c, a) => { const n = c.of.reduce((x, b) => x + a.owned(b), 0); return [n >= c.min, c.of.join(' + ') + ' ' + n + (n >= c.min ? ' >= ' : ' < ') + c.min]; },
  running: (c, a) => { const miss = c.of.filter(([b, r]) => !(a.running(b, r) >= (c.min ?? 1))); return [!miss.length, miss.length ? 'not running: ' + miss.map(([b, r]) => b + ' on ' + r).join(', ') : 'running']; },
  runningEquipped: (c, a) => { const miss = c.of.filter(([b, r]) => !(a.runningEquipped(b, r) >= (c.min ?? 1))); return [!miss.length, miss.length ? 'not running: ' + miss.map(([b, r]) => b + ' on ' + r).join(', ') : 'running']; },
  stock: (c, a) => { const n = a.has(c.of); return [n >= c.min, c.of + ' stock ' + n + (n >= c.min ? ' >= ' : ' < ') + c.min]; },
  acresUsed: (c, a) => [a.acresUsed >= c.min, a.acresUsed + ' acres used, ' + c.min + ' needed'],
  researching: (c, a) => (a.researching(c.of) ? [true, c.of + ' researching'] : [false, c.of + ' not researching']),
  ref: (c, a) => (a.ref(c.of) ? [true, c.of] : [false, 'not ' + c.of]),
  targetsMet: (c, a) => (a.targetsMet(c.of) ? [true, 'at target'] : [false, 'not at target: ' + c.of.join(', ')]),
};
function checkCond(c, a) {
  const f = COND[c?.type] ?? a.types?.[c?.type];
  if (!f) throw new Error('plan condition: unknown type ' + JSON.stringify(c?.type));
  return f(c, a);
}
const testCond = (c, a) => checkCond(c, a)[0];

// The Xeraphire Plan: the Early-Game Plan (wiki/guides/early-game-plan.md, Phases 1-5) and then the Core Game Plan
// (wiki/guides/core-game-plan.md, Stages A-D) up to the endgame gate.
const XERAPHIRE = {
  id: 'xeraphire', label: 'Xeraphire Plan',
  desc: 'Early game (Phases 1-5, this module), then the core game (Stages A-D, Core plan) up to the endgame gate, in one run.',
  early: {
    // Plan targets and policy numbers (Autopilot settings: these are their defaults, the user can change them).
    defaults: {
      sawmills: 6,             // once the Workshop is unlocked (1 before, 3 from 50 buildings); at least 2 per Frame Timber Workshop
      workshops: 2,            // on Frame Timber
      ironFrameWorkshops: 1,   // Phase 5: on Rivet Iron Frame, once the Smelter runs
      ironMines: 1, coalMines: 1, // at least; more as the Smelters' Iron Ore / Coal use needs at the current floor rates (4 / 2 at equal rates)
      quarries: 1, smelters: 1, kilns: 1, labs: 1,
      goldMines: Infinity,     // leftover frames → Gold Mines (+8 CD each; the CD source for Smelter and Phase 5). Infinity = auto: up to the gold target's auto while a plan unlock is open
      dispatchOffice: true,    // Phase 5 optional unlock
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
    },
    // Techs the plan spends CD on, in order (golden rule 5). gate: an extra condition (GATES in Autopilot); when: a setting that adds it.
    unlocks: [
      { b: 'Sawmill', phase: 2 },
      { b: 'Workshop', phase: 3, gate: { type: 'stockOrMade', item: 'Planks', need: 'workshopPlanks', maker: 'Sawmill' } },
      { b: 'Mine', phase: 4 },
      { b: 'Quarry', phase: 4 },
      { b: 'Smelter', phase: 4 },
      { b: 'Factory', phase: 5 },
      { b: 'Kiln', phase: 5 },
      { b: 'Paper Mill', phase: 5 },
      { b: 'Manufacturing Lab', phase: 5 },
      { b: 'Dispatch Office', phase: 5, optional: true, when: 'dispatchOffice' },
    ],
    // Phase n lasts until its condition holds; then the next one. After the last listed phase comes one more, until `done`.
    phases: [
      { phase: 1, until: { type: 'ownedSum', of: ['Lumber Camp', 'Farm'], min: 2 } },
      { phase: 2, until: { type: 'all', of: [{ type: 'unlocked', of: ['Sawmill'] }, { type: 'owned', of: ['Sawmill'] }, { type: 'acresUsed', min: 25 }] } },
      { phase: 3, until: { type: 'unlocked', of: ['Workshop'] } },
      { phase: 4, until: { type: 'ref', of: 'smelting' } },
    ],
    // Plan done (the hand-off to Core plan): every plan unlock is in and the core buildings exist, whatever route the corp took.
    // A running Rivet group is required: Core plan never builds the Smelter/Rivet chain, and the Assembly Plant prototype needs Iron Frames.
    // Frame Timber running and 16 Iron Frames stay plan targets, not hand-off conditions.
    done: { type: 'all', of: [
      { type: 'ref', of: 'requiredUnlocks' },
      { type: 'owned', of: ['Sawmill', 'Workshop', 'Mine', 'Quarry', 'Kiln', 'Manufacturing Lab', 'Smelter'] },
      { type: 'running', of: [['Workshop', 'Assemble Iron Frame']] },
    ] },
    // Named conditions (type 'ref') this part uses.
    refs: { smelting: { type: 'runningEquipped', of: [['Smelter', 'Roll Iron Sheet']] } },
    // What each plan building is put to work on. task: its one recipe (every one of them). pick: the first recipe still under its target
    // (TARGETS by recipe, running buildings; a row's assignWhen must hold), else it stays in the pool; one at a time.
    // capped: that recipe only up to its target (running), the rest stay in the pool; its bare groups are left alone.
    assign: [
      { b: 'Lumber Camp', task: 'Fell Wood' },
      { b: 'Farm', task: 'Grow Cotton' },
      { b: 'Sawmill', task: 'Saw Planks' },
      { b: 'Quarry', task: 'Quarry Limestone' },
      { b: 'Smelter', task: 'Roll Iron Sheet' },
      { b: 'Mine', pick: ['Mine Iron Ore', 'Mine Coal', 'Mine Gold Ore'] },
      { b: 'Workshop', pick: ['Assemble Wooden Frame', 'Assemble Iron Frame'] },
      { b: 'Kiln', capped: 'Mix Concrete' },
    ],
    // Plan buildings still wanted, in priority order. target: a setting ({ cfg }) or a named target (TARGETS in Autopilot) with its numbers.
    // have: owned | running (on the recipe) | runningPool (running + the pool, when the pool goes to this recipe next). when: the row
    // counts only while it holds (targetsMet: those rows, by recipe, are at target). openEnded: held to the land wall or land payback.
    targets: [
      { b: 'Sawmill', recipe: 'Saw Planks', have: 'owned', target: { type: 'demand', cfg: 'sawmills', item: 'Planks', startedBy: 'Workshop', early: { at: 50, n: 3, else: 1 }, per: ['workshops', 2], headroom: 1.25, stockMinutes: 60 } },
      { b: 'Workshop', recipe: 'Assemble Wooden Frame', have: 'runningPool', target: { cfg: 'workshops' } },
      { b: 'Mine', recipe: 'Mine Iron Ore', have: 'running', target: { type: 'feed', min: 'ironMines', feeds: 'Roll Iron Sheet', by: 'Smelter', count: 'smelters' } },
      { b: 'Mine', recipe: 'Mine Coal', have: 'running', target: { type: 'feed', min: 'coalMines', feeds: 'Roll Iron Sheet', by: 'Smelter', count: 'smelters' } },
      { b: 'Quarry', recipe: 'Quarry Limestone', have: 'owned', target: { cfg: 'quarries' } },
      { b: 'Smelter', recipe: 'Roll Iron Sheet', have: 'owned', target: { cfg: 'smelters' } },
      { b: 'Kiln', recipe: 'Mix Concrete', have: 'owned', target: { cfg: 'kilns' } },
      { b: 'Manufacturing Lab', recipe: null, have: 'owned', target: { cfg: 'labs' } },   // no recipe: Core plan's Lab group takes it from the pool
      { b: 'Workshop', recipe: 'Assemble Iron Frame', have: 'runningPool', target: { cfg: 'ironFrameWorkshops' }, when: { type: 'ref', of: 'smelting' }, assignWhen: { type: 'ref', of: 'smelting' } },
      { b: 'Mine', recipe: 'Mine Gold Ore', have: 'running', target: { type: 'gold', cfg: 'goldMines', auto: 10 }, openEnded: true,
        when: { type: 'targetsMet', of: ['Mine Iron Ore', 'Mine Coal', 'Quarry Limestone'] } },
    ],
    // Every candidate, in priority order (RULES in Autopilot). keep: still runs once Core plan owns the corp (the others are skipped then).
    rules: [
      { rule: 'resumePaused', keep: true },   // 1. groups paused by an unpaid bill
      { rule: 'power', keep: true },          // 2. power subscription
      { rule: 'boosterCleanup', keep: true }, // 3a. CD booster leftovers
      { rule: 'assignPool' },                 // 3b. unassigned plan buildings → their group
      { rule: 'idleGroups' },                 // 4. plan groups with no task
      { rule: 'buyKits' },                    // 5. kit / prototype parts the corp can't make
      { rule: 'unlock', keep: true },         // 6. next plan tech
      { rule: 'floors' },                     // 6b. better floorplans
      { rule: 'sell', keep: true },           // 7. selling
      { rule: 'planBuildings' },              // 8. plan buildings (a final wait while saving for one ends the list)
      { rule: 'booster' },                    // 9. CD booster
      { rule: 'fillers', of: ['Farm', 'Lumber Camp'], wallAfter: 'Workshop' },   // 10. Lumber Camp or Farm, whichever pays back sooner
    ],
    homeMade: ['Wood', 'Planks', 'Wooden Frame', 'Iron Frame'],   // the plan makes these: never bought for prototypes, never sold
    neverSell: ['Planks', 'Wooden Frame', 'Iron Frame', 'Money', 'Construction Data', 'Manufacturing Data', 'Research Data', 'Logistics Data'],
    neverBuy: ['Logistics Data', 'Construction Data'],   // prototype parts never bought (besides homeMade)
    sell: { autoShip: { item: 'Cotton', cfg: 'autoShipCotton' }, always: ['Wood', 'Cotton'], smallLoads: { items: ['Wood', 'Cotton'], until: ['Lumber Camp', 'Farm'] }, reserve: { Wood: 'woodReserve' } },
    booster: { building: 'Lumber Camp', after: 'Workshop' },   // the CD booster farms on this, once this is unlocked
    groupNames: {   // group and log names per recipe
      'Fell Wood': 'Fell Wood', 'Grow Cotton': 'Grow Cotton', 'Saw Planks': 'Planks', 'Assemble Wooden Frame': 'Frame Timber', 'Assemble Iron Frame': 'Iron Frames',
      'Mine Iron Ore': 'Iron', 'Mine Coal': 'Coal', 'Mine Gold Ore': 'Gold', 'Quarry Limestone': 'Limestone', 'Roll Iron Sheet': 'Iron Sheet', 'Mix Concrete': 'Concrete',
    },
    // Checklist rows (earlyGame.status() and the panel): label, what is counted, and the target of that recipe's TARGETS row.
    checklist: [
      { label: 'Sawmills', have: ['owned', 'Sawmill'], target: 'Saw Planks' },
      { label: 'Workshops (Frame Timber)', have: ['running', 'Workshop', 'Assemble Wooden Frame'], target: 'Assemble Wooden Frame' },
      { label: 'Iron Mines', have: ['running', 'Mine', 'Mine Iron Ore'], target: 'Mine Iron Ore' },
      { label: 'Coal Mines', have: ['running', 'Mine', 'Mine Coal'], target: 'Mine Coal' },
      { label: 'Limestone Quarries', have: ['owned', 'Quarry'], target: 'Quarry Limestone' },
      { label: 'Smelters', have: ['owned', 'Smelter'], target: 'Roll Iron Sheet' },
      { label: 'Gold Mines', have: ['running', 'Mine', 'Mine Gold Ore'], target: 'Mine Gold Ore' },
      { label: 'Workshops (Iron Frames)', have: ['running', 'Workshop', 'Assemble Iron Frame'], target: 'Assemble Iron Frame' },
    ],
  },
  core: {
    // Core plan settings that are plan rules (the rest are its machinery); these are their defaults, the user can change them.
    defaults: {
      landPaybackAB: 20,            // Stage A-B: buy an acre + Cotton Farm while payback <= this many hours (wiki 4.6)
      cottonFarmHourly: 790,        // dollars per hour one Cotton Farm earns (wiki 4.6); fallback when no live Cotton bid prices it
      landPaybackFraction: 1 / 3,   // Stage C-D: payback <= T_wall x this
      cashReserve: 0,               // cents kept on top of the other modules' money floors
      ifReserve: 44,                // upper cap on the Iron Frames kept back for the prototypes and first builds (ifNeed counts what is still needed)
      bufferAcres: 2,               // acres kept free for the CD farm: one building being built + one waiting for demolition (my-plan.js cdBufferAcres)
      cyclesPerHour: 600,           // the CD rate the land rule assumes until a measured one exists
      handoff: true,                // at Plan done: engine items to Autopilot's neverSell, its CD booster off
      handoffStopAutopilot: true,   // ... then stop Autopilot once (Core plan resumes bill-paused groups); a user restart is left alone
      unlocks: true, land: true,    // the two directors that send
    },
    unlocks: ['Assembly Plant', 'Retail Store', 'Oil Rig'],   // in this order (wiki 9)
    unlockGates: { 'Oil Rig': 'retailCheckpoint' },          // waits for a passed retail checkpoint (of either run, plan D-2)
    engineItems: ['Wood', 'Planks', 'Iron Sheet', 'Concrete', 'Glass', 'Bookshelf', 'Table', 'Chair', 'Bench', 'Wooden Frame', 'Iron Frame',
      'Iron Ore', 'Coal', 'Limestone', 'Sand', 'Copper Ore', 'Copper Wire', 'Wired Frame'],   // cp-cadence NEVER plus the ores the kits use
    // Start conditions S1-S7. covers: S1 holds at Plan done or when those hold; at Plan done they count as held too, except a keep entry
    // whose recipe is not running (Plan done implies a running Rivet group: Core plan never builds one; without it S3 still fails).
    start: [
      { id: 'S1', type: 'earlyDone', covers: ['S2', 'S3', 'S4'], keep: { S3: ['Workshop', 'Assemble Iron Frame'] },
        doneWhy: 'Autopilot: Plan done', okWhy: 'S2-S4 hold', noWhy: 'Autopilot has not finished the Early-Game Plan, and S2-S4 do not all hold' },
      { id: 'S2', type: 'unlocked', of: ['Mine', 'Quarry', 'Sawmill', 'Smelter', 'Workshop', 'Kiln', 'Manufacturing Lab'] },   // Factory and Paper Mill are not on the plan's path
      { id: 'S3', type: 'all', okWhy: 'running, Iron Frames {Iron Frame}', of: [
        { type: 'running', of: [['Smelter', 'Roll Iron Sheet'], ['Workshop', 'Assemble Iron Frame'], ['Workshop', 'Assemble Wooden Frame']] },
        { type: 'stock', of: 'Iron Frame', min: 16 }] },
      { id: 'S4', type: 'owned', of: ['Manufacturing Lab', 'Kiln', 'Mine', 'Quarry'] },
      { id: 'S5', type: 'locked', of: 'Assembly Plant', noWhy: 'Assembly Plant is already unlocked (join at stage B or later)' },
      { id: 'S6', type: 'cashRising' },    // money rose over 10 min (unknown with too few samples: does not block)
      { id: 'S7', type: 'cottonBid' },     // a Cotton bid in Heartland (unknown while the Market was never opened: blocks)
    ],
    // Stages in order; the stage is the last one whose condition holds (startOk: every start condition but `ignore` is not false,
    // `strict` ones exactly true, and `gate` holds).
    stages: [
      { id: 'A', name: 'start', when: { type: 'startOk', ignore: ['S5'], strict: ['S7'], gate: 'S1' } },
      { id: 'B', name: 'Assembly Plant unlock', when: { type: 'researching', of: 'Assembly Plant' } },
      { id: 'C', name: 'Retail Store unlock', when: { type: 'unlocked', of: ['Assembly Plant'] } },
      { id: 'D', name: 'Retail Store built', when: { type: 'owned', of: ['Retail Store'] } },
    ],
    // End conditions E1-E5 (the endgame gate): the plan is finished in the last stage when all hold.
    end: [
      { id: 'E1', name: 'money engine runs', type: 'retailSelling', hoursText: '6 h' },
      { id: 'E2', name: 'only endgame unlocks left', type: 'unlocked', of: ['Assembly Plant', 'Retail Store', 'Oil Rig'], okWhy: 'Assembly Plant, Retail Store and Oil Rig unlocked' },
      { id: 'E3', name: 'CD on the Farm cycle', type: 'cdFarmCycle', building: 'Farm', batchType: 'farm', frames: 'Wooden Frame', framesBelow: 20, failSlack: 20, batchWithin: 1 },
      { id: 'E4', name: 'land done', type: 'landDone' },
      { id: 'E5', name: 'cash in hand', type: 'cashInHand', hours: 3 },
    ],
    // Stage C-D land rule (core-math landRule): CD to the wall (Oil Rig 5,000 + Refinery 500,000, 2026-11-24 catalog), the CD farm's building
    // type, an acre pays back within T_wall / limitDivisor; acres of buildings still to come (counted until built).
    landRule: { wallCd: 505000, batchType: 'farm', limitDivisor: 3, later: [['Retail Store', 3], ['Assembly Plant', 5]] },
    // Stage A-B land (acre + Cotton Farm) and the blocks on it: B2 in cdBlock (CD is the bottleneck), B1 in buildoutBlock (build-out first).
    land: { stages: ['A', 'B'], cdBlock: 'A', buildoutBlock: 'B' },
    maxShelves: 4,   // shelf goods per Retail Store (buildout's allocator, expand, retail's shelves)
    // Stock Core plan keeps from CD Farm and the other spenders: from these stages every one of `items` (on the retail fail path only
    // Wooden Frames down to their keep line); before them, the Iron Frames the prototypes still need (capped by cfg.ifReserve).
    reserve: { stages: ['D', 'END'], items: ['Wooden Frame', 'Planks'] },
    // Directors (src/cp-*.js) in this order (lower first); on: false starts switched off (dir_<name>); defaults: their settings (the user
    // can change them); tables: the plan data they work from. A director not named here runs at its own order, on.
    directors: {
      resume: { order: 10, defaults: { resumeGraceMin: 2 } },   // minutes after a SetPaused Core plan sent in which a pause of that group is the director's
      utilities: { order: 12 },
      buildout: {
        order: 40,
        defaults: {
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
        },
        tables: {
          furniture: [['bookshelf', 'Bookshelf', 'Make Bookshelf'], ['table', 'Table', 'Make Table'], ['chair', 'Chair', 'Make Chair']],
          // The other recipes the build-out steps read, by role (all required; the furniture ones come from `furniture`).
          recipes: { wood: 'Fell Wood', planks: 'Saw Planks', ft: 'Assemble Wooden Frame', rivet: 'Assemble Iron Frame', cotton: 'Grow Cotton',
            glass: 'Blow Glass', concrete: 'Mix Concrete' },
          // Floor designs (core floor library) the floors step applies: furniture recipes and Make Bench.
          floors: { furniture: { design: 'workshopV1', label: 'Workshop v1 floor (x5)' }, bench: { design: 'rivetX3', label: 'Rivet x3 floor' } },
          mix: { bookshelf: 0.4, table: 0.3, chair: 0.3 },     // plank shares when the board has no appetite (wiki 4.3)
          floor: { 'Lumber Camp': 3, Sawmill: 2, Workshop: 5 }, // floor rate the plan assumes (wiki 4.5)
          engine: ['Lumber Camp', 'Sawmill', 'Workshop'],
          bench: { recipe: 'Make Bench', floor: 3, hours: 48 }, // optional (no Bench in the catalog: none); on the Rivet x3 floor; Concrete kept for this many hours of Bench use (plan D4)
          block: { share: 1200, hourly: 1444 },                 // dollars: a block's buildings per acre, and what an engine acre earns an hour (plan D-1; blockHourly scales it to the board)
        },
      },
      retail: {
        order: 45,
        defaults: {
          stockHoursPerShelf: 1,       // hours of modelled sales in stock per shelf good before the store is built (wiki 4.7)
          retailSampleMin: 10,         // minutes between checkpoint samples
          retailCheckHours: 2,         // decide the checkpoint after this many hours
          retailMaxHours: 4,           // give up (fail) when a row still has no data by then
          retailAppetiteTol: 15,       // % appetite may fall while the store sells (a rise passes)
          capStockHours: 2,            // a furniture cap needs this many hours of a shelved good's stock growing while sales fall short of output
          failTtlHours: 12,            // a failed checkpoint is re-run after this many hours
          retailSamplePassPct: 70,     // % of the modelled sales that must sell
          retailRating: 9000,          // rating the store must reach ...
          retailRatingMin: 90,         // ... within this many minutes of the build (75 at +1 per tick, plus slack)
          retailE1Hours: 6,            // E1: hours in a row with the rows passing
          retailShelfDropMin: 60,      // minutes a shelved good may be unmade and out of stock before it leaves the shelf
          retailGoneMin: 10,           // minutes with no store owned before the checkpoint starts over
          retailRunsPerWave: 5,        // runs per wave per Workshop when no group runs a recipe yet (wiki 2.1)
          rivalStockHours: 2,          // rival on the board (plan R-8): a good goes on the shelf only with this many hours of stock at its drain (0: off)
        },
        tables: {
          goods: { Bookshelf: 'Make Bookshelf', Table: 'Make Table', Chair: 'Make Chair', Bench: 'Make Bench' },   // fallback shelf goods when the board names none the Corporation can make
          store: 'Retail Store', groupName: 'Retail', ftRecipe: 'Assemble Wooden Frame', ftGroup: 'Frame Timber',
        },
      },
      expand: {
        order: 47,
        defaults: {
          expand: 'ask',              // 'off' | 'ask' (a toast with a Go button) | 'auto' (plan R-7)
          expandPaybackH: 24,         // open or upgrade a region only when it pays back within this many hours
          expandBillHours: 3,         // ... and cash after it covers the money floor + this many hours of bills
          expandMarginPct: 25,        // shipment margin on build items + kits
          expandPlanksH: 1,           // ... plus this many hours of the new Workshops' Planks
          expandEquipMin: 30,         // minutes to wait for new Workshop groups to be equipped before going on (and reporting it)
          expandToastMin: 30,         // minutes between repeats of the same offer toast
          heartlandLandCap: false,    // opt-in: once a region is chartered, buildout buys no Heartland acre dearer than the cheapest region acre (regionAcreCents)
          expandFeed: true,           // M-2: pause the Heartland group that uses up an item a region shipment lacks (Iron Sheet into Iron Frames) until it ships
          expandFeedH: 6,             // ... at most this many hours while no run is on
        },
      },
      lab: {
        order: 55,
        defaults: { labPreset: true, labGroup: true, labTarget: 2,
          mdRich: 1000000,        // Manufacturing Data above this (and RD >= 5): the preset's Quality engineering runs at Tier II (plan D1)
          labAdopt: true },       // adopt a Lab process that is strictly better than a furniture group's recipe (plan D1)
        tables: {
          furniture: ['Make Bookshelf', 'Make Table', 'Make Chair', 'Make Bench'],
          preset: [['Bookshelf', 2], ['Planks', 0], ['Table', 2], ['Chair', 2]],   // wiki 10 step 1: product name, focus (0 Process study, 2 Quality engineering), Tier I pinned
          maxLabs: 2,     // the second-Lab step never buys past this many (cfg.labTarget may ask for fewer)
          tier2Rd: 5,     // Research Data needed for Tier II Quality engineering (Tier II costs this much)
        },
      },
      ladder: {
        order: 60,
        defaults: {
          ladderPace: 'balanced',   // CD Farm pace before the Stage D ladder (balanced: bigger batches while the time saved pays)
          ladderPaceD: 'fast',      // CD Farm pace on the Stage D ladder (plan step 1: CD is worth full income there)
          ladderSpareAcres: 0,      // CD Farm reserveAcres: the land rule already keeps cfg.bufferAcres free for the batch itself
        },
        tables: { bankFor: 'Retail Store', after: ['Oil Rig', 'Refinery'], batchType: 'farm' },   // CD banked for the store in stages B-C; the Stage D ladder's unlocks, in order
      },
      slot: { order: 70, defaults: { dir_slot: true, slotLotMin: 150000, slotMinMinutes: 60, slotRearmMinutes: 15 } },
      sell: { order: 75, defaults: { dir_sell: true, sellKeepHours: 48, sellKitBuilds: 3, sellSaturatedHours: 24, sellCooldownMinutes: 60 } },
      cadence: {
        order: 80,
        defaults: { dir_cadence: true, shelfHours: 1, kitWaveBuilds: 3 },
        tables: {
          // Engine inputs and the endgame prototypes: never sold, never in the slot (wiki 5.2, 6).
          never: ['Wood', 'Planks', 'Iron Sheet', 'Concrete', 'Glass', 'Bookshelf', 'Table', 'Chair', 'Bench', 'Wooden Frame', 'Iron Frame', 'Copper Wire', 'Wired Frame'],
          // Endgame stock (wiki 12): kept back from every sale and the surplus slot.
          targets: [['Iron Frame', 80], ['Wired Frame', 12], ['Copper Wire', 200], ['Copper Ore', 2000]],
        },
      },
      endgame: {
        order: 90, on: false,   // off until a live run has checked it
        tables: {
          minesPerSmelter: 5, smelters: 1,     // Smelt x3 eats 600 Ore/h, a Mine on the x3 merge makes 144 (plan D6)
          // Each production group with every target downstream of it: it pauses only when all of them hold.
          chain: [
            { b: 'Assembly Plant', r: 'Assemble Wired Frame', feeds: ['Wired Frame'] },
            { b: 'Smelter', r: 'Draw Copper Wire', feeds: ['Copper Wire', 'Wired Frame'] },
            { b: 'Mine', r: 'Mine Copper Ore', feeds: ['Copper Ore', 'Copper Wire', 'Wired Frame'] },
          ],
        },
      },
    },
  },
};

const PLAN_LIST = [XERAPHIRE];
const savedPlan = () => { try { return JSON.parse(W.localStorage?.getItem('earlyGame.v2') || '{}').cfg?.plan; } catch { return undefined; } };
const plans = {
  list: () => PLAN_LIST.map((p) => ({ id: p.id, label: p.label, desc: p.desc })),
  has: (id) => PLAN_LIST.some((p) => p.id === id),
  get: (id) => PLAN_LIST.find((p) => p.id === id) ?? PLAN_LIST[0],   // an unknown id (a preset that no longer exists) is the first
  // The preset the Autopilot panel plays (its Plan preset setting, saved by Autopilot); Core plan reads it too, before Autopilot loads.
  current: () => plans.get(W.earlyGame?.cfg?.plan ?? savedPlan()),
  test: testCond, check: checkCond,
  // A preset's settings as a fresh object (arrays copied): what a module puts in its cfg, so the preset itself is never changed.
  copy: (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])),
};
