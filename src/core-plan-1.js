// ============================================================================
// 3d. CORE PLAN (window.corePlan)
// ============================================================================
// Coordinator for wiki/guides/core-game-plan.md: reads the game, says which stage (A-D) the Corporation is in and which of the start
// conditions S1-S7 and end conditions E1-E5 hold (with the reason for each that does not), and sends the few purchases it owns.
//   corePlan.status() / corePlan.plan()        // what it sees and would do now (nothing is sent)
//   corePlan.start({ dryRun: true })           // dry run; Live is the default, and Live resumes after a page reload (60 s to cancel)
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

    // The plan is the preset's `core` part (core.plans, src/core-plans.js): stages, start/end conditions, unlocks, land, director order and
    // the plan's settings. shortcut: read once at load; another preset in the Autopilot panel applies to Core plan after a reload.
    const PLAN = core.plans.current().core;
    const DEFAULTS = {
      dryRun: false,
      intervalMs: 5000, confirmMs: 8000, maxFails: 3, cmdsPerMin: 20,
      ...core.plans.copy(PLAN.defaults),   // the plan's rules (land payback, reserves, hand-off, the unlock and land steps)
      liveResume: true,             // after a reload Live resumes (60 s countdown); off = it comes back as a dry run
      resumeSeconds: 60,
    };
    const SESSION_ONLY = ['dryRun'];
    const cfg = { ...DEFAULTS };
    const ENGINE_ITEMS = PLAN.engineItems;
    const UNLOCKS = PLAN.unlocks;   // in this order
    const REFINERY_CD = 500000;   // fallback when the tech tree lacks it (wiki data/tech-tree.md, 2026-11-24 patch); ladder and endgame share it

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
    // cents: $20 per new MW + 2 h of bills ($60/MW/h), times a world event's NPC power price multiplier
    const billNeed = (v, newMW) => (newMW * 2000 + (v.st.subscriptions?.[REGION]?.power ?? 0) * 12000) * (core.powerPriceMult?.() ?? 1);
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
    function view(st, raw, deals = [], region = REGION) {   // region: the per-region retail pass (scripts/multi-region-plan.md lever 4); directors read Heartland
      const N = names(raw), C = N.C;
      // A group on a Lab process (st.recipes, wiki research.md) shows as on the catalog recipe of the same building and product, so every
      // director counts it as that recipe (plan D1 adoption); g.process keeps the real id.
      const baseOf = (r) => Object.values(C.recipes).find((x) => x.building === r.building && x.inputs?.length && x.outputs?.[0]?.item === r.outputs?.[0]?.item);
      const groups = Object.entries(st.groups ?? {}).map(([id, g]) => {
        const pr = g.recipe != null && !C.recipes[g.recipe] ? st.recipes?.[g.recipe] : null, b = pr ? baseOf(pr) : null;
        return { id: +id, ...g, ...(b ? { recipe: b.id, process: g.recipe } : {}) };
      }).filter((g) => (g.region ?? 0) === region);
      const pool = st.building_pool?.[region] ?? {};
      const stock = st.stock?.[region] ?? {}, items = st.items ?? {};
      const bld = (b) => C.buildings[b] ?? { name: 'building ' + b, cost: 0, acres: 1, build_items: [] };
      const idB = (n) => N.b[n], idI = (n) => N.i[n], idR = (n) => N.r[n];
      const ownedId = (b) => groups.filter((g) => g.building === b).reduce((a, g) => a + g.count, 0) + (pool[b] ?? 0);
      const owned = (n) => (N.b[n] == null ? 0 : ownedId(N.b[n]));
      // Building prices count every region and the build / demolish queues (planner.queued): owned() is Heartland only.
      const q = P.queued({ st, catalog: raw, region });
      const ownedAll = (n) => {
        const b = N.b[n];
        if (b == null) return 0;
        let c = q.owned[b] ?? 0;
        for (const g of Object.values(st.groups ?? {})) if (g.building === b) c += g.count ?? 0;
        for (const p of Object.values(st.building_pool ?? {})) c += p?.[b] ?? 0;
        return c;
      };
      const landBought = st.land_bought?.[region] ?? 0;
      let acresUsed = q.acres;   // a queued build or demolition holds its acres
      for (const g of groups) acresUsed += bld(g.building).acres * g.count;
      for (const [b, n] of Object.entries(pool)) acresUsed += bld(+b).acres * n;
      const acresOwned = STARTER_ACRES + landBought;
      const unlockedList = st.unlocked_buildings ?? [];
      const unlocked = (n) => N.b[n] != null && (n === 'Lumber Camp' || n === 'Farm' || unlockedList.includes(N.b[n]));
      const has = (n) => { const i = N.i[n]; return i == null ? 0 : (stock[i] ?? items[i] ?? 0); };
      const running = (bn, rn) => groups.filter((g) => g.building === N.b[bn] && g.recipe === N.r[rn] && !g.paused && g.count > 0).reduce((a, g) => a + g.count, 0);
      const cottonGroup = groups.find((g) => g.building === N.b.Farm && g.recipe === N.r['Grow Cotton'] && !g.paused);
      const engineAcres = ['Lumber Camp', 'Farm', 'Sawmill', 'Workshop'].reduce((a, n) => a + owned(n) * (N.b[n] == null ? 0 : bld(N.b[n]).acres), 0);
      const cottonBids = deals.filter((d) => d.side === 'Sell' && d.item === N.i.Cotton && (d.region ?? 0) === region && d.amount > 0);
      return {
        catalog: raw, region,
        N, C, st, groups, pool, bld, idB, idI, idR, owned, ownedAll, has, unlocked, running, cottonGroup,
        cottonBid: cottonBids.length > 0, dealsLoaded: deals.length > 0,
        cottonUnit: cottonBids.reduce((a, d) => Math.max(a, d.price / d.amount), 0) || null,   // cents per unit, best Heartland Cotton bid
        money: items[MONEY] ?? 0, cd: items[CD] ?? 0,
        landBought, acresUsed, acresOwned, freeAcres: Math.max(0, acresOwned - acresUsed), fixedAcres: Math.max(0, acresUsed - engineAcres),
        nextAcreCents: acrePriceCents(landBought),
        research: st.research ?? null, researchIdle: !st.research && !(st.research_queue ?? []).length,
        mutTick: st.ssi?.last_user_mutation_tick ?? 0,
      };
    }

