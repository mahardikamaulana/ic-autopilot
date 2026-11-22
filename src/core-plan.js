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
//     then Autopilot is stopped once (earlyGame.stop), as Core plan resumes bill-paused groups itself (plan D-4, D7).
//   - Unlock director: StartTech for Assembly Plant, then Retail Store, then Oil Rig, only when the research slot is idle, the previous
//     unlock is in, the CD and the prototype items are in stock, and (Oil Rig) the retail checkpoint has passed.
//   - Land, Stage A-B: an acre plus a Cotton Farm while (acre + Farm) / Cotton Farm income <= 20 h. Autopilot is held around it.
//     Not while CD alone holds up the next unlock (Stage A, wiki 11.1), nor while buildout has a block to buy (Stage B, plan D-1).
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
    bufferAcres: 16,              // acres kept free for the CD farm (my-plan.js cdBufferAcres)
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
      N, C, st, groups, pool, bld, idB, idI, idR, owned, has, unlocked, running, cottonGroup, cottonBid,
      money: items[MONEY] ?? 0, cd: items[CD] ?? 0,
      landBought, acresUsed, acresOwned, freeAcres: Math.max(0, acresOwned - acresUsed), fixedAcres: Math.max(0, acresUsed - engineAcres),
      nextAcreCents: acrePriceCents(landBought),
      research: st.research ?? null, researchIdle: !st.research && !(st.research_queue ?? []).length,
      mutTick: st.ssi?.last_user_mutation_tick ?? 0,
    };
  }

  // ---- start and end conditions, stage ----------------------------------------------------------------------------------------
  const cond = (id, ok, why) => ({ id, ok, why });
  function startConditions(v, ctx) {
    const miss2 = S2_NEEDS.filter((n) => !v.unlocked(n));
    const s2 = cond('S2', !miss2.length, miss2.length ? 'not unlocked: ' + miss2.join(', ') : 'all unlocked');
    const need3 = [['Smelter', 'Roll Iron Sheet'], ['Workshop', 'Rivet Iron Frame'], ['Workshop', 'Frame Timber']].filter(([b, r]) => !v.running(b, r));
    const ifs = v.has('Iron Frame');
    const s3 = cond('S3', !need3.length && ifs >= 16, need3.length ? 'not running: ' + need3.map(([b, r]) => b + ' on ' + r).join(', ') : ifs < 16 ? 'Iron Frame stock ' + ifs + ' < 16' : 'running, Iron Frames ' + ifs);
    const lab = v.owned('Manufacturing Lab'), kiln = v.owned('Kiln'), mine = v.owned('Mine'), quarry = v.owned('Quarry');
    const s4 = cond('S4', lab >= 1 && kiln >= 1 && mine >= 1 && quarry >= 1, lab >= 1 && kiln >= 1 && mine >= 1 && quarry >= 1 ? 'built' : 'missing: ' + [['Manufacturing Lab', lab], ['Kiln', kiln], ['Mine', mine], ['Quarry', quarry]].filter(([, n]) => n < 1).map(([n]) => n).join(', '));
    const s1 = cond('S1', ctx.planDone === true || (s2.ok && s3.ok && s4.ok), ctx.planDone === true ? 'Autopilot: Plan done' : (s2.ok && s3.ok && s4.ok) ? 'S2-S4 hold' : 'Autopilot has not finished the Early-Game Plan, and S2-S4 do not all hold');
    const s5 = cond('S5', !v.unlocked('Assembly Plant'), v.unlocked('Assembly Plant') ? 'Assembly Plant is already unlocked (join at stage B or later)' : 'not unlocked yet');
    const c10 = ctx.cashDelta10;
    const s6 = cond('S6', c10 == null ? null : c10 > 0, c10 == null ? 'not enough cash samples yet (needs 10 min)' : 'money ' + (c10 > 0 ? 'rose ' : 'fell ') + usd(Math.abs(c10)) + ' over 10 min');
    const s7 = cond('S7', v.cottonBid, v.cottonBid ? 'Cotton bid in Heartland' : 'no Cotton bid in Heartland');
    return [s1, s2, s3, s4, s5, s6, s7];
  }
  function stageOf(v, S) {
    if (v.owned('Retail Store') >= 1) return 'D';
    if (v.unlocked('Assembly Plant')) return 'C';
    if (v.research && v.research.building === v.idB('Assembly Plant')) return 'B';
    const ok = S.filter((c) => c.id !== 'S5').every((c) => c.ok !== false);
    return ok && S[0].ok ? 'A' : null;
  }
  function landInput(v, ctx) {
    const o = (n) => v.owned(n);
    return { acres: v.acresOwned, acrePrice: v.nextAcreCents / 100, camps: o('Lumber Camp'), farms: o('Farm'), sawmills: o('Sawmill'), workshops: o('Workshop'),
      docks: 0, pastures: 0, fixedAcres: v.fixedAcres,
      // v.fixedAcres already holds a built Retail Store (3 acres) and Assembly Plant (5): only the unbuilt ones are extra
      fixedExtra: (v.owned('Retail Store') ? 0 : 3) + (v.owned('Assembly Plant') ? 0 : 5), cyclesPerHour: ctx.cyclesPerHour ?? cfg.cyclesPerHour, cdBufferAcres: cfg.bufferAcres };
  }
  // Iron Frames (or `item`) the three unlocks still need (wiki 9): the prototype until its research starts, the first build until the building
  // stands. `except` is the building being bought now: its own first build is not kept back from itself.
  function ifNeed(v, except, item = 'Iron Frame') {
    const ifId = v.idI(item);
    if (ifId == null) return 0;
    const queued = (v.st.research_queue ?? []).map((q) => q.building);
    let n = 0;
    for (const name of UNLOCKS) {
      const b = v.idB(name);
      if (b == null) continue;
      const per = (v.bld(b).build_items ?? []).find((i) => i.item === ifId)?.amount ?? 0;
      if (!v.unlocked(name) && v.research?.building !== b && !queued.includes(b)) n += per;
      if (v.owned(name) === 0 && name !== except) n += per;
    }
    return n;
  }
  function endConditions(v, rule, ctx) {
    const retail = v.owned('Retail Store') >= 1;
    const e1 = cond('E1', retail && ctx.retailE1 === true, !retail ? 'Retail Store not built' : ctx.retailE1 === true ? 'selling 6 h in a row with the checkpoint rows passing' : ctx.retailOk === true ? 'checkpoint passed, not yet 6 h in a row' : ctx.retailOk === false ? 'retail checkpoint failed' : 'retail checkpoint not decided yet');
    const miss = UNLOCKS.filter((n) => !v.unlocked(n));
    const e2 = cond('E2', !miss.length, miss.length ? 'not unlocked: ' + miss.join(', ') : 'Assembly Plant, Retail Store and Oil Rig unlocked');
    const farms = v.owned('Farm'), wf = v.has('Wooden Frame');
    const e3 = cond('E3', farms === 0 && wf < 20, farms ? farms + ' Farms owned' : wf >= 20 ? 'Wooden Frame stock ' + wf + ' >= 20' : '0 Farms, frames ' + wf + ' (ladder batch not checked here)');
    const e4 = rule ? cond('E4', v.acresOwned >= rule.lastAcre && v.freeAcres <= cfg.bufferAcres, v.acresOwned < rule.lastAcre ? v.acresOwned + ' acres, rule closes at #' + rule.lastAcre : v.freeAcres > cfg.bufferAcres ? v.freeAcres + ' free acres, buffer ' + cfg.bufferAcres : 'rule closed, acres built')
      : cond('E4', false, 'land rule unavailable');
    const e5 = rule ? cond('E5', v.money >= rule.income * 300 && rule.acresToBuy === 0 && !rule.need.camps && !rule.need.sawmills && !rule.need.workshops,
      v.money < rule.income * 300 ? 'money ' + usd(v.money) + ' < 3 h of income ' + usd(rule.income * 300) : 'still to buy: ' + rule.acresToBuy + ' acres, ' + rule.need.camps + ' Camps, ' + rule.need.sawmills + ' Sawmills, ' + rule.need.workshops + ' Workshops')
      : cond('E5', false, 'land rule unavailable');
    return [e1, e2, e3, e4, e5];
  }

  // ---- directors ------------------------------------------------------------------------------------------------------------------------
  // Next unlock Core plan owns, with what is still missing. null when all three are in.
  function nextUnlock(v) {
    for (const n of UNLOCKS) {
      if (v.unlocked(n)) continue;
      const b = v.idB(n), tech = v.N.techs.find((t) => t.building === b);
      const out = { b, name: n, cd: tech?.cost ?? 0, prereqsMet: true, note: '', tech };
      if (!tech) { out.prereqsMet = false; out.note = 'not in the tech tree'; return out; }
      if (tech.requires != null && !v.st.unlocked_buildings?.includes(tech.requires) && v.C.buildings[tech.requires]?.name !== 'Lumber Camp') { out.prereqsMet = false; out.note = 'needs ' + (v.C.buildings[tech.requires]?.name ?? 'building ' + tech.requires) + ' first'; }
      return out;
    }
    return null;
  }
  function unlockAction(v, ctx, nx) {
    if (!nx) return { wait: 'all three unlocks are in' };
    const why = 'unlock ' + nx.name;
    if (nx.name === 'Oil Rig' && ctx.retailOk !== true) return { wait: why + ': waits for the retail checkpoint' + (ctx.retailOk === false ? ' (failed: a new run measures the capped output)' : '') };   // only on a pass, of either run (plan D-2)
    if (ctx.apNextTech) return { wait: why + ': Autopilot still owns "' + ctx.apNextTech.name + '"' };
    if (!nx.prereqsMet) return { wait: why + ': ' + nx.note };
    if (v.research) return { wait: why + ': research slot busy' };
    if (v.cd < nx.cd) return { wait: why + ': ' + Math.floor(v.cd) + ' / ' + nx.cd + ' CD' };
    const proto = v.bld(nx.b).build_items ?? [];
    const lack = proto.filter((i) => (v.st.stock?.[REGION]?.[i.item] ?? v.st.items?.[i.item] ?? 0) < i.amount);
    if (lack.length) return { wait: why + ': need ' + lack.map((i) => Math.ceil(i.amount - (v.st.stock?.[REGION]?.[i.item] ?? v.st.items?.[i.item] ?? 0)) + ' more ' + (v.C.items[i.item]?.name ?? 'item ' + i.item)).join(', ') };
    return { action: { id: 'tech:' + nx.b, text: why + ' (' + nx.cd + ' CD' + (proto.length ? ' + ' + proto.map((i) => i.amount + ' ' + (v.C.items[i.item]?.name ?? i.item)).join(', ') : '') + ')',
      steps: [{ msg: { type: 'StartTech', building: nx.b, region: REGION }, until: (x) => x.research?.building === nx.b || x.unlocked(nx.name) }] } };
  }
  // Stage A-B land: an acre plus a Cotton Farm while (acre + Farm) / hourly income <= cfg.landPaybackAB; one purchase per call.
  // block: why another use of the cash goes first (B1, B2).
  function landAction(v, stage, floorCents, block) {
    if (stage !== 'A' && stage !== 'B') return { wait: 'land: stage ' + stage + ' land is bought by the buildout director with its blocks' };
    if (block) return { wait: 'land: ' + block };
    if (!v.cottonGroup) return { wait: 'land: no running Cotton Farm group to add to' };
    if (v.acresOwned >= ACRE_CAP) return { wait: 'land: Heartland cap (' + ACRE_CAP + ' acres)' };
    const farm = v.idB('Farm'), farmCents = P.price(v.bld(farm).cost, v.owned('Farm'), 0);
    const needAcre = v.freeAcres - cfg.bufferAcres < 1;   // the CD farm's spare acres stay free
    const cost = farmCents + (needAcre ? v.nextAcreCents : 0);
    const payback = cost / 100 / cfg.cottonFarmHourly;
    const line = (needAcre ? 'acre #' + (v.acresOwned + 1) + ' ' + usd(v.nextAcreCents) + ' + ' : '') + 'Cotton Farm ' + usd(farmCents) + ', payback ' + payback.toFixed(1) + ' h';
    if (payback > cfg.landPaybackAB) return { wait: 'land: ' + line + ' > ' + cfg.landPaybackAB + ' h, rule closed' };
    if (v.money - cost < floorCents) return { wait: 'land: ' + line + ': need ' + usd(floorCents + cost - v.money) + ' more above the floor' };
    const g = v.cottonGroup, c0 = g.count, p0 = v.pool[farm] ?? 0, l0 = v.landBought;
    const steps = [];
    if (needAcre) steps.push({ msg: { type: 'BuyLand', amount: 1, region: REGION }, until: (x) => x.landBought >= l0 + 1 });
    steps.push({ msg: { type: 'BuyBuilding', building: farm, amount: 1, region: REGION }, until: (x) => (x.pool[farm] ?? 0) >= p0 + 1 });
    steps.push({ msg: { type: 'AssignBuildings', group: g.id, amount: 1 }, until: (x) => (x.groups.find((y) => y.id === g.id)?.count ?? 0) >= c0 + 1 });
    return { action: { id: 'land:' + (v.acresOwned + 1), text: 'buy ' + line, steps, hold: true } };
  }
  function handoffAction(v, ctx) {
    if (!cfg.handoff || !ctx.ap) return null;
    const ids = ENGINE_ITEMS.map((n) => v.idI(n)).filter((i) => i != null);
    const never = ctx.ap.neverSell ?? [];
    const lacking = ids.filter((i) => !never.includes(i));
    if (!lacking.length && ctx.ap.cdBooster === false) {
      // Then stop Autopilot (plan D-4), only once Core plan resumes bill-paused groups (D7), and only once: a restart by the user is left alone.
      const m = ctx.mem?.('handoff');
      if (!m || m.get().stopped || cfg.handoffStopAutopilot === false) return null;
      if (!directors.some((d) => d.name === 'resume') || cfg.dir_resume === false) return null;
      const on = !!ctx.ap.running;   // not running: only recorded, so a later start by the user is not stopped either
      return { id: 'handoff:stop', text: on ? 'hand-off: stop Autopilot (Core plan resumes bill-paused groups now)' : 'hand-off: Autopilot is not running; recorded (a later start is left alone)',
        run: async () => { if (on) { if (!W.earlyGame?.stop) return false; W.earlyGame.stop(); } m.set({ stopped: ctx.now ?? Date.now() }); return true; } };
    }
    return { id: 'handoff', text: 'hand-off: ' + (lacking.length ? lacking.length + ' engine items to Autopilot neverSell' : '') + (ctx.ap.cdBooster !== false ? (lacking.length ? ', ' : '') + 'CD booster off' : ''),
      patch: { neverSell: ids, cdBooster: false } };
  }

  // ---- plug-in directors (steps 5-10 live in their own files: src/cp-*.js) ------------------------------------------------
  // A director is { name, order, always?, defaults?, context?(v, ctx), decide(v, ctx, out) -> { action?, actions?, wait?, readout? }, duties?() }.
  //   always: it also decides when no stage holds (out.stage null).
  //   context(v, ctx, stage): adds facts to ctx before any director decides (e.g. the retail sampler sets ctx.retailOk).
  //   decide: pure; an action is { id, text, steps: [{ msg, until(view) }], hold? } or { id, text, run: async () => true|false|null }.
  //   defaults: cfg keys (validated and saved like the built-in ones). ctx.mem(name) is a small saved object per director.
  const directors = [];
  function addDirector(d) {
    if (!d?.name || typeof d.decide !== 'function') throw new Error('addDirector: name and decide() are required');
    const i = directors.findIndex((x) => x.name === d.name);
    if (i >= 0) directors.splice(i, 1);
    directors.push(d); directors.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    for (const [k, val] of Object.entries({ ['dir_' + d.name]: true, ...(d.defaults ?? {}) })) { if (!(k in DEFAULTS)) { DEFAULTS[k] = val; cfg[k] = val; } }
    restore();
    return () => { const j = directors.indexOf(d); if (j >= 0) directors.splice(j, 1); };
  }

  // The whole decision, from a view: stage, S/E conditions, the land rule, what to send next (first action) and what it is waiting for.
  function decide(v, ctx = {}) {
    const S = startConditions(v, ctx);
    const stage = stageOf(v, S);
    for (const dir of directors) { try { dir.context?.(v, ctx, stage); } catch (e) { console.error('[corePlan] ' + dir.name + '.context', e); } }
    // After the directors' context: a failed retail checkpoint (ctx.retailFail) caps the planks at the furniture blocks sales carry (plan A2).
    let rule = null;
    try {
      const planksCap = ctx.retailFail && typeof ctx.retailCap === 'number' ? ctx.retailCap / M.engineModel(v.C).wsPerPlank : undefined;
      rule = M.landRule(landInput(v, ctx), v.C, { cyclesPerHour: ctx.cyclesPerHour ?? cfg.cyclesPerHour, planksCap });
    } catch (e) { console.error(e); }
    const E = endConditions(v, rule, ctx);
    const out = { stage, S, E, rule, actions: [], waits: [], nextUnlock: null, finished: stage === 'D' && E.every((c) => c.ok), readouts: {} };
    if (out.finished) out.stage = 'END';
    if (!stage) { out.waits.push('stage: start conditions do not hold (' + S.filter((c) => c.ok === false).map((c) => c.id + ': ' + c.why).join('; ') + ')'); return decideDirectors(v, ctx, out, true); }
    out.nextUnlock = nextUnlock(v);
    out._ifId = v.idI('Iron Frame'); out._ifNeed = ifNeed(v); out._wfId = v.idI('Wooden Frame'); out._plId = v.idI('Planks');
    out._failPath = !!ctx.retailFailPath;
    try { out._wfKeep = W.corePlan._buildout?.wfKeep?.(v, ctx) ?? null; } catch { out._wfKeep = null; }   // null: the reserve keeps every frame
    const ho = ctx.planDone === true ? handoffAction(v, ctx) : null;
    if (ho) out.actions.push(ho);
    if (ctx.ap?.running && ctx.mem?.('handoff')?.get?.()?.stopped) out.readouts.handoff = { alert: 'Autopilot was started again after the hand-off: left running (it also sells and resumes groups)' };
    const u = unlockAction(v, ctx, out.nextUnlock);
    if (cfg.unlocks) { if (u.action) out.actions.push(u.action); else out.waits.push(u.wait); }
    let block = null;
    // B2 (wiki 11.1): Stage A, the next unlock waits on CD alone (it would start with the CD in hand): no cash into Cotton Farms
    if (stage === 'A' && !u.action && out.nextUnlock && unlockAction({ ...v, cd: Infinity }, ctx, out.nextUnlock).action) block = 'CD is the bottleneck: cash goes to the CD farm';
    // B1 (plan D-1): Stage B, a block buildout can buy now goes before an acre + Cotton Farm
    if (stage === 'B' && cfg.dir_buildout !== false && W.corePlan._buildout?.nextBuildStep) {
      try { const nb = W.corePlan._buildout.nextBuildStep(v, ctx, rule, stage); if (nb?.pick) block = 'build-out goes first (' + nb.why + ')'; } catch (e) { console.error('[corePlan] buildout.nextBuildStep', e); }
    }
    if (cfg.land) { const l = landAction(v, stage, ctx.floorCents ?? 0, block); if (l.action) out.actions.push(l.action); else out.waits.push(l.wait); }
    return decideDirectors(v, ctx, out, false);
  }
  // Directors in order; with no stage only those marked always (D7 resume) decide.
  function decideDirectors(v, ctx, out, noStage) {
    for (const dir of directors) {
      if (noStage && !dir.always) continue;
      if (cfg['dir_' + dir.name] === false) { out.waits.push(dir.name + ': off'); continue; }
      let r = null;
      try { r = dir.decide(v, ctx, out); } catch (e) { console.error('[corePlan] ' + dir.name, e); out.waits.push(dir.name + ': error ' + (e.message ?? e)); continue; }
      if (!r) continue;
      for (const a of [...(r.actions ?? []), ...(r.action ? [r.action] : [])]) out.actions.push({ ...a, director: dir.name });
      if (r.wait) out.waits.push(dir.name + ': ' + r.wait);
      if (r.readout !== undefined) out.readouts[dir.name] = r.readout;
    }
    return out;
  }

  // ---- reading the game, sending, confirming ---------------------------------------------------------------------------------
  let pacer = core.pacer ? core.pacer({ cmdsPerMin: cfg.cmdsPerMin }) : null;
  function read(fresh = false) {
    const { ws, st, catalog, deals, engine } = core.walk(fresh);
    lastEngine = engine ?? lastEngine;
    if (!st || !catalog) return null;
    core.seeTick(st.ssi?.last_user_mutation_tick);
    return { st, catalog, ws, deals: deals ?? [], wsOpen: ws?.readyState === 1, mutTick: st.ssi?.last_user_mutation_tick ?? 0, v: view(st, catalog, deals ?? []) };
  }
  const cash = [];
  let lastEngine = null;
  const memOf = (name) => { const k = KEY + '.mem.' + name; let o = {}; try { o = JSON.parse(store?.getItem(k) || '{}') ?? {}; } catch {} return { get: () => o, set: (patch) => { o = { ...o, ...patch }; try { store?.setItem(k, JSON.stringify(o)); } catch {} return o; } }; };
  function trackCash(v) { const t = Date.now(); if (!cash.length || t - cash[cash.length - 1].t >= 30000) cash.push({ t, m: v.money }); while (cash.length && t - cash[0].t > 3600000) cash.shift(); }
  function cashDelta10() { const t = Date.now(), base = [...cash].reverse().find((c) => t - c.t >= 600000); return base && cash.length ? cash[cash.length - 1].m - base.m : null; }
  function context(r) {
    const ap = W.earlyGame;
    let apRes = null; try { apRes = ap?.reserve?.() ?? null; } catch {}
    const others = core.reserves.merged();
    let floor = 0;
    for (const [n, x] of Object.entries(others?.by ?? {})) if (n !== 'corePlan') floor = Math.max(floor, x.moneyFloor ?? 0);
    return {
      planDone: apRes ? apRes.phase === 'done' : null,
      ap: ap?.cfg ? { neverSell: [...(ap.cfg.neverSell ?? [])], cdBooster: ap.cfg.cdBooster, running: !!ap.running } : null,
      apNextTech: apRes?.nextTech && ap?.busy ? apRes.nextTech : null,
      cashDelta10: cashDelta10(), floorCents: floor + cfg.cashReserve,
      retailOk: null,   // set by the retail director's checkpoint sampler (ctx is mutable for directors' context())
      tick: Math.max(core.nowTick(), r?.st?.ssi?.last_user_mutation_tick ?? 0),
      reserveItems: (() => { const o = {}; for (const [n, x] of Object.entries(others?.by ?? {})) if (n !== 'corePlan') for (const [i, k] of Object.entries(x.items ?? {})) o[i] = (o[i] ?? 0) + k; return o; })(),
      now: Date.now(), premium: !!r?.st?.premium, deals: r?.deals ?? [],
      retailBoard: (() => { try { const j = lastEngine?.retailJson?.(); return typeof j === 'string' ? JSON.parse(j) : j ?? null; } catch { return null; } })(),
      mem: memOf, live: running && !cfg.dryRun, dryRun: cfg.dryRun,
      mods: { cdFarm: W.cdFarm ?? null, labRunner: W.labRunner ?? null, autoSell: W.autoSell ?? null, autoUtil: W.autoUtil ?? null, earlyGame: W.earlyGame ?? null },
    };
  }

  const ledgerNote = (kind, text) => core.ledger.add(TAG, kind, text);
  let running = false, stepping = false, loopTimer = 0, last = null, fails = 0, lastSig = '', lastWait = '', lastWouldAt = {}, stopReason = '';
  const holds = new Set();

  async function sendStep(st) {
    const r = read(true);
    if (!r || !r.wsOpen) return 'down';
    await pacer?.beforeCommand?.();
    const d0 = core.markSend(r.mutTick);
    r.ws.send(JSON.stringify(st.msg));
    const ok = await core.waitConfirm({ read, d0, timeoutMs: cfg.confirmMs, pred: (x) => st.until(x.v), closed: () => { throw new Error('socket closed while waiting'); } });
    pacer?.noteConfirm?.({ ok: !!ok, rtt: core.lastRtt() });
    return !!ok;
  }
  async function perform(a) {
    if (a.run) {
      const ok = await a.run();
      if (ok === true) ledgerNote('action', a.text);
      else if (ok === false) ledgerNote('fail', 'did not work: ' + a.text + ' (' + (fails + 1) + '/' + cfg.maxFails + ')');
      return ok;
    }
    if (a.patch) {
      if (!W.earlyGame?.tune) return false;
      const rep = W.earlyGame.tune(a.patch);
      ledgerNote('action', a.text + ' (' + rep.applied.join(', ') + (rep.skipped.length ? '; skipped ' + rep.skipped.join(', ') : '') + ')');
      return true;
    }
    if (a.hold) await core.reserves.holdAll('corePlan', 'corePlan');
    try {
      for (const st of a.steps) {
        const ok = await sendStep(st);
        if (ok === 'down') return null;           // nothing was sent
        if (!ok) { ledgerNote('fail', 'not confirmed: ' + a.text + ' (' + (fails + 1) + '/' + cfg.maxFails + ')'); return false; }
      }
      ledgerNote('action', a.text);
      return true;
    } finally { if (a.hold) core.reserves.releaseAll('corePlan', 'corePlan'); }
  }

  const sigOf = (d) => [d.stage, ...d.S.map((c) => c.ok), ...d.E.map((c) => c.ok)].join('|');
  function report(d) {
    const sig = sigOf(d);
    if (sig === lastSig) return;
    lastSig = sig;
    ledgerNote('info', 'stage ' + (d.stage ?? '-') + ' | ' + d.S.map((c) => c.id + (c.ok === null ? '?' : c.ok ? '+' : '-')).join(' ') + ' | ' + d.E.map((c) => c.id + (c.ok ? '+' : '-')).join(' '));
  }

  async function step() {
    if (stepping || unloaded) return;
    stepping = true;
    try {
      const r = read(true);
      if (!r) { last = { waits: ['waiting for the game'] }; return; }
      trackCash(r.v);
      const d = decide(r.v, context(r));
      last = d; report(d);
      if (running && !cfg.dryRun) heartbeat();
      if (holds.size || !running) return;
      const a = d.actions[0];
      if (!a) { const w = d.waits.join(' | '), key = w.replace(/[\d,.$]+/g, '#'); if (key !== lastWait) { lastWait = key; ledgerNote('info', 'waiting: ' + w); } return; }   // amounts move every step: log a wait once per reason
      if (cfg.dryRun) { const t = Date.now(); if (!(lastWouldAt[a.id] > t - 60000)) { lastWouldAt[a.id] = t; ledgerNote('info', 'dry run, would: ' + a.text); } return; }
      const ok = await perform(a);
      if (ok === true) fails = 0;
      else if (ok === false && ++fails >= cfg.maxFails) { stopReason = 'the server did not apply ' + cfg.maxFails + ' actions in a row'; ledgerNote('fail', 'stopped: ' + stopReason); core.notify('CP', 'Core plan stopped', stopReason); stop(); }
    } catch (e) {
      ledgerNote('fail', 'error: ' + (e.message ?? e));
      if (/socket closed/.test(e.message ?? '')) return;
    } finally { stepping = false; }
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------------------------------
  const heartbeat = () => { try { sstore?.setItem(LIVE_KEY, JSON.stringify({ t: Date.now() })); } catch {} ; takeLock(); };
  const clearLive = () => { try { sstore?.removeItem(LIVE_KEY); } catch {} };
  const lockOwner = () => { try { const l = JSON.parse(store?.getItem(LOCK_KEY) || 'null'); return l && Date.now() - l.t < 15000 ? l.tab : null; } catch { return null; } };
  const takeLock = () => { try { store?.setItem(LOCK_KEY, JSON.stringify({ tab: TAB, t: Date.now() })); } catch {} };
  const dropLock = () => { try { if (lockOwner() === TAB) store?.removeItem(LOCK_KEY); } catch {} };

  function start(o = {}) {
    if (running && !(o.dryRun === false && cfg.dryRun)) return status();   // already running; a dry run may still be taken live
    const dry = o.dryRun !== undefined ? !!o.dryRun : cfg.dryRun;
    if (!dry) {
      const owner = lockOwner();
      if (owner && owner !== TAB) { ledgerNote('fail', 'Live refused: another tab is running Core plan'); return status(); }
      const r = read(true);
      if (r) { const miss = core.missingFields(r.st, ['groups', 'stock', 'ssi', 'items']); const bad = []; if (miss.length) bad.push('state is missing ' + miss.join(', ')); for (const n of [...UNLOCKS, 'Farm']) if (r.v.idB(n) == null) bad.push('no building named ' + n); if (bad.length) { cfg.dryRun = true; ledgerNote('fail', 'Live refused: the game data no longer looks right (' + bad.join('; ') + ')'); running = true; ensureLoop(); return status(); } }
    }
    cfg.dryRun = dry; running = true; stopReason = ''; fails = 0; lastSig = ''; lastWait = '';
    ledgerNote('info', 'started' + (dry ? ' (dry run)' : ' LIVE'));
    if (!dry) heartbeat();
    ensureLoop(); step();
    return status();
  }
  function stop() {
    if (!running) return status();
    running = false; clearInterval(loopTimer); loopTimer = 0; clearLive(); dropLock(); cancelResume();
    ledgerNote('info', 'stopped');
    return status();
  }
  function ensureLoop() { if (!loopTimer) loopTimer = setInterval(() => { step(); }, cfg.intervalMs); }
  async function hold(who) { holds.add(who); while (stepping) await core.sleep(25); }
  function release(who) { holds.delete(who); }

  // After a page reload Live resumes by itself, after a countdown the user can cancel (stop(), cancelResume() or Alt+Shift+X).
  let resumeTimer = 0, resumeLeft = 0;
  function cancelResume() { if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = 0; resumeLeft = 0; } }
  function scheduleResume() {
    resumeLeft = cfg.resumeSeconds;
    ledgerNote('info', 'resuming Live after the reload in ' + resumeLeft + ' s (corePlan.cancelResume() or Alt+Shift+X cancels; it then runs as a dry run)');
    resumeTimer = setInterval(() => {
      if (unloaded) return cancelResume();
      if (--resumeLeft > 0) return;
      cancelResume(); start({ dryRun: false });
    }, 1000);
  }

  function duties() {
    return [
      { duty: 'engine items kept off the shelf (neverSell, CD booster)', owner: 'Core plan', done: true },
      { duty: 'unlocks: Assembly Plant, Retail Store, Oil Rig', owner: 'Core plan', done: true },
      { duty: 'Stage A-B land and Cotton Farms', owner: 'Core plan', done: true },
      ...directors.flatMap((d) => { try { return d.duties?.() ?? []; } catch { return []; } }),
    ];
  }
  function status() {
    const d = last;
    return {
      running, live: running && !cfg.dryRun, dryRun: cfg.dryRun, stage: d?.stage ?? null, stopReason,
      start: d?.S?.map((c) => c.id + ' ' + (c.ok === null ? '?' : c.ok ? 'ok' : 'NO') + ': ' + c.why) ?? [],
      end: d?.E?.map((c) => c.id + ' ' + (c.ok ? 'ok' : 'NO') + ': ' + c.why) ?? [],
      next: d?.actions?.[0]?.text ?? null, waits: d?.waits ?? [], readouts: d?.readouts ?? {},
      land: d?.rule ? { lastAcre: d.rule.lastAcre, acresToBuy: d.rule.acresToBuy, landCost: Math.round(d.rule.landCost), tWallHours: +d.rule.tWall.toFixed(1), income: Math.round(d.rule.income) } : null,
      holds: [...holds],
    };
  }

  // ---- settings -----------------------------------------------------------------------------------------------------------------------------
  function apply(o) {
    const applied = [], skipped = [];
    for (const [k, v] of Object.entries(o ?? {})) {
      const ok = k in DEFAULTS && !SESSION_ONLY.includes(k) && typeof v === typeof DEFAULTS[k] && !(typeof v === 'number' && !Number.isFinite(v))
        && !(typeof v === 'number' && v < 0);
      if (ok) { cfg[k] = v; applied.push(k); } else skipped.push(k);
    }
    return { applied, skipped };
  }
  const save = () => { try { store?.setItem(KEY, JSON.stringify({ cfg: Object.fromEntries(Object.entries(cfg).filter(([k]) => !SESSION_ONLY.includes(k))) })); } catch {} };
  function restore() { try { const o = JSON.parse(store?.getItem(KEY) || 'null'); if (o?.cfg) apply(o.cfg); } catch {} }

  // What CD Farm and the other spenders see: the next unlock and the Iron Frames kept for the prototypes. Null while not running.
  core.reserves.register('corePlan', {
    reserve: () => {
      if (!running || !last?.stage) return null;
      // A director may set out.cdNeed: an object { b, name, cd, prereqsMet, note } replaces the next unlock as the CD need, false = no CD need now.
      const v = last.cdNeed === false ? null : (last.cdNeed ?? last.nextUnlock), ifId = last._ifId;
      // Before the store: Iron Frames for the prototypes. Once it is built: every Wooden Frame and Plank, so CD Farm's planner never
      // burns them on Mines / Quarries (wiki 11.4, the $294-per-CD mistake).
      const items = {};
      // Retail fail path (plan A2): Wooden Frames only down to their keep line and Planks free, so CD Farm cycles the frames above it.
      if (last.stage === 'D' || last.stage === 'END') {
        if (last._failPath) { if (last._wfId != null) items[last._wfId] = last._wfKeep ?? Infinity; }
        else for (const id of [last._wfId, last._plId]) if (id != null) items[id] = Infinity;
      }
      else if (ifId != null) { const k = Math.min(cfg.ifReserve, last._ifNeed ?? Infinity); if (k > 0) items[ifId] = k; }
      return { moneyFloor: 0, items, nextTech: v ? { b: v.b, name: v.name, cd: v.cd, prereqsMet: v.prereqsMet, note: v.note } : null, phase: null };
    },
    busy: () => running && !cfg.dryRun,
    hold: (w) => hold(w), release: (w) => release(w),
  });

  W.corePlan = {
    cfg, DEFAULTS,
    get running() { return running; }, get busy() { return running && !cfg.dryRun; }, get active() { return stepping; },
    status, plan: () => last, start, stop, addDirector, ENGINE_ITEMS, directors: () => directors.map((d) => d.name), _usd: usd, _acrePriceCents: acrePriceCents, hold, release, duties, cancelResume,
    importCfg(o) { const r = apply(o?.cfg ?? o); save(); return r; },
    exportCfg() { return { cfg: Object.fromEntries(Object.entries(cfg).filter(([k]) => !SESSION_ONLY.includes(k))) }; },
    resetCfg() { Object.assign(cfg, DEFAULTS); save(); },
    _ifNeed: ifNeed, _view: view, _decide: decide, _step: step, _names: names, _startConditions: startConditions, _endConditions: endConditions, _nextUnlock: nextUnlock, _setPacer(p) { pacer = p; },
    _unload() { unloaded = true; running = false; clearInterval(loopTimer); cancelResume(); loopTimer = 0; core.reserves?.unregister('corePlan'); dropLock(); },
  };

  restore();
  try { const f = JSON.parse(sstore?.getItem(LIVE_KEY) || 'null'); if (cfg.liveResume && f && Date.now() - f.t < 10 * 60000) { start({ dryRun: true }); cfg.dryRun = true; scheduleResume(); } } catch {}
  console.log('[corePlan] ready: corePlan.status() reads the stage and conditions; corePlan.start() is a dry run, corePlan.start({ dryRun: false }) goes live');
})();
} catch (e) { console.error('[IdleCorp] Core plan failed to load:', e); }
// @@END core-plan
