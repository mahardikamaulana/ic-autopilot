// ============================================================================
// 3d. CORE PLAN (window.corePlan)
// ============================================================================
// Coordinator for wiki/guides/core-game-plan.md: reads the game, says which stage (A-D) the Corporation is in and which of the start
// conditions S1-S7 and end conditions E1-E5 hold (with the reason for each that does not), and sends the few purchases it owns.
//   corePlan.status() / corePlan.plan()        // what it sees and would do now (nothing is sent)
//   corePlan.start({ dryRun: false })          // dry run unless told otherwise; Live resumes after a page reload (60 s to cancel)
//   corePlan.stop() / hold(who) / release(who) // like earlyGame; CD Farm holds every registered module while it buys
//   corePlan.duties()                          // what Autopilot still does that Core plan has not taken over
// What it sends today (everything else is read-out only):
//   - Hand-off at Plan done: the engine items go onto Autopilot's neverSell list and its CD booster is switched off (earlyGame.tune);
//     then Autopilot is stopped once (earlyGame.stop), as Core plan resumes bill-paused groups itself (plan D-4, D7), once Auto utilities
//     power is on too (Autopilot also raises the power subscription).
//   - Unlock director: StartTech for Assembly Plant, then Retail Store, then Oil Rig, only when the research slot is idle, the previous
//     unlock is in, the CD and the prototype items are in stock, and (Oil Rig) the retail checkpoint has passed.
//   - Land, Stage A-B: an acre plus a Cotton Farm while (acre + Farm) / Cotton Farm income <= 20 h. Autopilot is held around it.
//     Not while CD alone holds up the next unlock (Stage A, wiki 11.1), nor while buildout has a block to buy or saves cash for one (Stage B, plan D-1).
//   Stage C-D land and the engine build-out are shown (landRule) but not bought yet.
// The pure part (corePlan._view / _decide) has no DOM, sockets or timers; the tests drive it with saved boards.
// @@MODULE core-plan
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');
  if (!core.planner || !core.coreMath) throw new Error('planner / core-math did not load');
  const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
  const sstore = (() => { try { return W.sessionStorage ?? null; } catch { return null; } })();
  const KEY = 'corePlan.v1', LIVE_KEY = KEY + '.live', LOCK_KEY = KEY + '.lock';
  const TAG = 'CP';
  const TAB = Math.random().toString(36).slice(2, 8);
  if (W.corePlan?._unload) W.corePlan._unload();
  let unloaded = false;
  const P = core.planner, M = core.coreMath;
  const REGION = 0, MONEY = 0, CD = 24, STARTER_ACRES = 25, FIRST_ACRE = 5000, ACRE_CAP = 360;   // FIRST_ACRE in cents

  const DEFAULTS = {
    dryRun: true,
    intervalMs: 5000, confirmMs: 8000, maxFails: 3, cmdsPerMin: 20,
    landPaybackAB: 20,            // Stage A-B: buy an acre + Cotton Farm while payback <= this many hours (wiki 4.6)
    cottonFarmHourly: 790,        // dollars per hour one Cotton Farm earns (wiki 4.6)
    landPaybackFraction: 1 / 3,   // Stage C-D: payback <= T_wall x this
    cashReserve: 0,               // cents kept on top of the other modules' money floors
    ifReserve: 44,                // upper cap on the Iron Frames kept back for the prototypes and first builds (ifNeed counts what is still needed)
    bufferAcres: 2,               // acres kept free for the CD farm: one building being built + one waiting for demolition (my-plan.js cdBufferAcres)
    cyclesPerHour: 600,           // the CD rate the land rule assumes until a measured one exists
    handoff: true,                // at Plan done: engine items to Autopilot's neverSell, its CD booster off
    handoffStopAutopilot: true,   // ... then stop Autopilot once (Core plan resumes bill-paused groups); a user restart is left alone
    unlocks: true, land: true,    // the two directors that send
    liveResume: true,             // after a reload Live resumes (60 s countdown); off = it comes back as a dry run
    resumeSeconds: 60,
  };
  const SESSION_ONLY = ['dryRun'];
  const cfg = { ...DEFAULTS };
  const ENGINE_ITEMS = ['Wood', 'Planks', 'Iron Sheet', 'Concrete', 'Glass', 'Bookshelf', 'Table', 'Chair', 'Bench', 'Wooden Frame', 'Iron Frame',
    'Iron Ore', 'Coal', 'Limestone', 'Sand', 'Copper Ore', 'Copper Wire', 'Wired Frame'];   // cp-cadence NEVER plus the ores the kits use
  const UNLOCKS = ['Assembly Plant', 'Retail Store', 'Oil Rig'];   // in this order (wiki 9)
  const S2_NEEDS = ['Mine', 'Quarry', 'Sawmill', 'Smelter', 'Workshop', 'Kiln', 'Factory', 'Paper Mill', 'Manufacturing Lab'];

  // ---- ids by name (the client catalog array is not indexed by id) ------------------------------------------------------
  const idxRef = new WeakMap();
  function names(raw) {
    let x = idxRef.get(raw);
    if (!x) {
      const C = P.normalize(raw);
      const by = (m) => Object.fromEntries(Object.values(m ?? {}).map((e) => [e.name, e.id]));
      const pieces = Object.fromEntries([...(raw.machines ?? []), ...(raw.belts ?? [])].map((p) => [p.item, p]));   // floor pieces, for parts lists
      x = { C, techs: raw.techs ?? [], pieces, b: by(C.buildings), r: by(C.recipes), i: by(C.items) };   // planner.normalize drops the tech list
      idxRef.set(raw, x);
    }
    return x;
  }
  const acrePriceCents = (n) => { let p = FIRST_ACRE; for (let i = 0; i < n; i++) p = Math.floor(p * 41 / 40); return p; };
  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  // ---- purchase and floor pieces shared by the buildout, lab and endgame directors ----------------------------------------------------
  const billNeed = (v, newMW) => newMW * 2000 + (v.st.subscriptions?.[REGION]?.power ?? 0) * 12000;   // cents: $20 per new MW + 2 h of bills ($60/MW/h)
  // One purchase: BuyLand (if acres), BuyBuilding, then the building into group g, else a new group of `amount` named `name`.
  function buySteps(v, b, acres, g, name, amount = 1) {
    const p0 = v.pool[b] ?? 0, l0 = v.landBought, steps = [];
    if (acres) steps.push({ msg: { type: 'BuyLand', amount: acres, region: REGION }, until: (x) => x.landBought >= l0 + acres });
    steps.push({ msg: { type: 'BuyBuilding', building: b, amount: 1, region: REGION }, until: (x) => (x.pool[b] ?? 0) >= p0 + 1 });
    if (g) { const c0 = g.count; steps.push({ msg: { type: 'AssignBuildings', group: g.id, amount: 1 }, until: (x) => (x.groups.find((y) => y.id === g.id)?.count ?? 0) >= c0 + 1 }); }
    else { const ids = new Set(v.groups.map((x) => x.id)); steps.push({ msg: { type: 'CreateGroup', building: b, amount, name, region: REGION }, until: (x) => x.groups.some((y) => !ids.has(y.id) && y.building === b) }); }
    return steps;
  }
  const floorObj = (design) => {   // a floor design string from the core as EditLayout cells, or null when the core has none
    const cells = W.idleCore?.floorDesigns?.[design];
    return cells ? Object.fromEntries(cells.split(' ').map((t) => { const [x, y, item, rot] = t.split(/[,:]/).map(Number); return [x + ',' + y, { item, rot }]; })) : null;
  };
  // An EditLayout the server did not apply: floors under the same key wait cfg.floorRetryMin (endgame: the recipe id, so a failed floor never blocks
  // another; buildout: one key for all). mem(memName).floorFail holds the time per key; the module copy covers no browser storage.
  const floorFail = new Map();
  function floorAction(ctx, memName, key, r, obj, waitPre, act) {
    const mm = ctx.mem?.(memName), mk = memName + ':' + key, m = mm?.get?.() ?? {}, now = ctx.now ?? Date.now();
    const failAt = m.floorFail?.[key] ?? floorFail.get(mk) ?? null, retryMs = Math.max(0, cfg.floorRetryMin ?? 10) * 60000;
    if (failAt != null && now - failAt < retryMs) return { wait: waitPre + ': retry in ' + Math.ceil((retryMs - (now - failAt)) / 60000) + ' min' };
    let marked = false;
    const until = (x) => {   // the first look after the send marks the try; a confirm clears it
      const ok = !!x.st.layouts?.[r.id];
      if (ok || !marked) { const t = ok ? null : Date.now(); floorFail.set(mk, t); if (mm) mm.set({ floorFail: { ...mm.get().floorFail, [key]: t } }); }
      marked = true;
      return ok;
    };
    return { action: { ...act, steps: [{ msg: { type: 'EditLayout', recipe: r.id, cells: obj }, until }] } };
  }

  // ---- a small pure view of the game state ---------------------------------------------------------------------------------
  function view(st, raw, deals = []) {
    const N = names(raw), C = N.C;
    const groups = Object.entries(st.groups ?? {}).map(([id, g]) => ({ id: +id, ...g })).filter((g) => (g.region ?? REGION) === REGION);
    const pool = st.building_pool?.[REGION] ?? {};
    const stock = st.stock?.[REGION] ?? {}, items = st.items ?? {};
    const bld = (b) => C.buildings[b] ?? { name: 'building ' + b, cost: 0, acres: 1, build_items: [] };
    const idB = (n) => N.b[n], idI = (n) => N.i[n], idR = (n) => N.r[n];
    const ownedId = (b) => groups.filter((g) => g.building === b).reduce((a, g) => a + g.count, 0) + (pool[b] ?? 0);
    const owned = (n) => (N.b[n] == null ? 0 : ownedId(N.b[n]));
    const landBought = st.land_bought?.[REGION] ?? 0;
    let acresUsed = 0;
    for (const g of groups) acresUsed += bld(g.building).acres * g.count;
    for (const [b, n] of Object.entries(pool)) acresUsed += bld(+b).acres * n;
    const acresOwned = STARTER_ACRES + landBought;
    const unlockedList = st.unlocked_buildings ?? [];
    const unlocked = (n) => N.b[n] != null && (n === 'Lumber Camp' || n === 'Farm' || unlockedList.includes(N.b[n]));
    const has = (n) => { const i = N.i[n]; return i == null ? 0 : (stock[i] ?? items[i] ?? 0); };
    const running = (bn, rn) => groups.filter((g) => g.building === N.b[bn] && g.recipe === N.r[rn] && !g.paused && g.count > 0).reduce((a, g) => a + g.count, 0);
    const cottonGroup = groups.find((g) => g.building === N.b.Farm && g.recipe === N.r['Grow Cotton'] && !g.paused);
    const engineAcres = ['Lumber Camp', 'Farm', 'Sawmill', 'Workshop'].reduce((a, n) => a + owned(n) * (N.b[n] == null ? 0 : bld(N.b[n]).acres), 0);
    const cottonBid = deals.some((d) => d.side === 'Sell' && d.item === N.i.Cotton && (d.region ?? REGION) === REGION);
    return {
      catalog: raw,
      N, C, st, groups, pool, bld, idB, idI, idR, owned, has, unlocked, running, cottonGroup, cottonBid,
      money: items[MONEY] ?? 0, cd: items[CD] ?? 0,
      landBought, acresUsed, acresOwned, freeAcres: Math.max(0, acresOwned - acresUsed), fixedAcres: Math.max(0, acresUsed - engineAcres),
      nextAcreCents: acrePriceCents(landBought),
      research: st.research ?? null, researchIdle: !st.research && !(st.research_queue ?? []).length,
      mutTick: st.ssi?.last_user_mutation_tick ?? 0,
    };
  }

