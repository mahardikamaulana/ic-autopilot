// ============================================================================
// CORE MATH (window.idleCore.coreMath)
// ============================================================================
// Pure fixed-point model of the Core Game Plan (scripts/core-plan/my-plan.js, wiki/guides/core-game-plan.md 4.2, 4.3, 4.6, 11.4):
// the Farm/Camp/Dock/Pasture CD ladder, the engine constants from the live catalog, and the land rule
// (income -> T_wall -> last acre inside the rule -> engine acres -> income). No DOM, sockets or timers.
// Money is in dollars (like the spec script). opts.cyclesPerHour overrides the state's CD rate (a measured CD-farm rate).
// opts.planksCap (planks per hour, a failed retail checkpoint): the engine, its Camps / Sawmills and the last acre stop at those planks.
// opts.cdPerHour (a measured CD-farm rate, CD/h): T_wall comes from it instead of the modelled batch (T_wall moves with income).
// @@MODULE core-math
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');

  // Floors the plan assumes: Camp x3, Sawmill x2, Workshop v1 x5.
  const M = { camp: 3, sawmill: 2, workshop: 5 };
  const MIX = [0.4, 0.3, 0.3];                       // Bookshelf, Table, Chair share of planks
  const RETAIL = 1.52, WALL_CD = 505000, BLD_ACRE = 1200, FIXED_EXTRA = 3 + 5;   // Retail Store 3 + Assembly Plant 5; WALL_CD = Oil Rig 5,000 + Refinery 500,000 (2026-11-24 catalog)
  const FURNITURE = ['Make Bookshelf', 'Make Table', 'Make Chair'];

  // CD ladder: price of the i-th building in a batch = base x (20 + owned + i) / 20, refund 50% of base.
  const TYPES = { farm: { base: 41, cd: 1, items: 0 }, camp: { base: 41, cd: 1, items: 0 }, dock: { base: 150, cd: 1, items: 20 * 1.0 }, pasture: { base: 250, cd: 1, items: 30 * 1.0 } };
  const batchCost = (type, owned, k) => {
    const t = TYPES[type];
    let c = 0;
    for (let i = 0; i < k; i++) c += Math.floor(t.base * 100 * (20 + owned + i) / 20) / 100 - t.base / 2 + t.items;
    return c;
  };
  // Demolitions cap at 360 CD/h. Batch size only sets the price, so the cheapest batch that reaches the cap wins (same as my-plan.js).
  function bestBatch(type, owned, income, cycles) {
    const cap = 360 * TYPES[type].cd;
    let best = null;
    for (let k = 1; k <= 200; k++) {
      const c = batchCost(type, owned, k);
      const batchesH = Math.min(cycles, cap / (k * TYPES[type].cd));
      const spendH = batchesH * c;
      if (spendH > income) break;
      const cdH = batchesH * k * TYPES[type].cd, perCd = c / (k * TYPES[type].cd);
      if (!best || cdH > best.cdH + 1e-9 || (Math.abs(cdH - best.cdH) < 1e-9 && perCd < best.perCd)) best = { k, perCd, cdH, spendH };
    }
    return best ?? { k: 1, perCd: batchCost(type, owned, 1), cdH: 0, spendH: 0 };
  }

  // Price of the next acre after n bought ones, starting at `first`.
  function acrePrice(first, n) {
    let p = first;
    for (let i = 0; i < n; i++) p = Math.floor(p * 100 * 41 / 40) / 100;
    return p;
  }

  const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));

  // Engine constants from a raw catalog ({items, recipes} arrays or id-keyed objects). Recipes are found by NAME, items re-keyed by id.
  const modelCache = new WeakMap();
  function engineModel(catalog) {
    if (modelCache.has(catalog)) return modelCache.get(catalog);
    const items = Object.fromEntries(list(catalog.items).map((i) => [i.id, i]));
    const recipes = list(catalog.recipes);
    const R = (n) => {
      const r = recipes.find((x) => x.name === n);
      if (!r) throw new Error('recipe not in catalog: ' + n);
      return r;
    };
    const wood = R('Fell Wood'), saw = R('Saw Planks');
    const campWoodH = wood.outputs[0].amount * M.camp * 3600 / (wood.ticks / 2);
    const smPlanksH = saw.outputs[0].amount * M.sawmill * 3600 / (saw.ticks / 2);
    const woodPerPlank = saw.inputs[0].amount / saw.outputs[0].amount;
    const furn = FURNITURE.map((n) => {
      const r = R(n), o = r.outputs[0];
      const unitsH = M.workshop * o.amount * 3600 / (r.ticks / 2);
      return { name: n.replace('Make ', ''), planksH: unitsH * r.inputs[0].amount, unitsH, rev: unitsH * items[o.item].base_value / 100 * RETAIL };
    });
    const perPlank = furn[0].rev / furn[0].planksH;
    const wsPerPlank = MIX.reduce((a, s, i) => a + s / furn[i].planksH, 0);
    const acresOf = (p) => p * woodPerPlank / campWoodH + p / smPlanksH + 2 * (p * wsPerPlank + 2);
    const planksFor = (E) => {
      let lo = 0, hi = 1e6;
      for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (acresOf(mid) > E) hi = mid; else lo = mid; }
      return lo;
    };
    const m = { campWoodH, smPlanksH, woodPerPlank, furn, perPlank, wsPerPlank, acresOf, planksFor };
    modelCache.set(catalog, m);
    return m;
  }

  // Cost of buying `want - have` more of a building whose base price is `base` (price ladder base x (20 + n) / 20).
  const costTo = (base, have, want) => {
    let c = 0;
    for (let n = have; n < want; n++) c += Math.floor(base * 100 * (20 + n) / 20) / 100;
    return c;
  };

  // The engine target and land rule as data. state: acres, acrePrice, camps, sawmills, workshops, fixedAcres, fixedExtra (acres of the Retail Store / Assembly Plant not built yet, default 8), cyclesPerHour, cdBufferAcres.
  function landRule(state, catalog, opts = {}) {
    const m = engineModel(catalog);
    const st = state;
    const cycles = opts.cyclesPerHour ?? st.cyclesPerHour ?? 600;
    const fixed = (st.fixedAcres ?? 0) + (st.fixedExtra ?? FIXED_EXTRA), buffer = st.cdBufferAcres ?? 2;   // one building being built + one waiting for demolition (batch 1)
    const Ecap = opts.planksCap != null ? m.acresOf(Math.max(0, opts.planksCap)) : Infinity;   // engine acres the capped planks need
    let E = Math.min(150, Ecap), rule = null;
    for (let it = 0; it < 40; it++) {
      const planks = m.planksFor(E), income = planks * m.perPlank;
      const b = bestBatch('farm', 0, income, cycles), tWall = WALL_CD / (opts.cdPerHour > 0 ? opts.cdPerHour : b.cdH);
      let price = st.acrePrice, last = st.acres;
      const rev = planks * m.perPlank / (E - 4);   // marginal furniture acre: reserve Workshops (Frame Timber, Rivet) excluded
      for (let a = st.acres; a < 360; a++) {
        if ((price + BLD_ACRE) / rev <= tWall / 3) last = a + 1; else break;
        price = Math.floor(price * 100 * 41 / 40) / 100;
      }
      rule = { planks, income, b, tWall, last };
      const Enew = Math.min(Ecap, Math.max(0, Math.max(last, st.acres) - fixed - buffer));
      if (Math.abs(Enew - E) < 0.5) { E = Enew; break; }
      E = (E + Enew) / 2;
    }
    if (Ecap < Infinity) rule.last = Math.min(rule.last, Math.max(st.acres, Math.ceil(Ecap + fixed + buffer)));   // no acre the capped engine cannot fill
    const acreN = Math.max(rule.last, st.acres);
    const planks = m.planksFor(E);
    const camps = Math.ceil(planks * m.woodPerPlank / m.campWoodH), saws = Math.ceil(planks / m.smPlanksH);
    const ws = MIX.map((s, i) => Math.ceil(planks * s / m.furn[i].planksH));
    const wsTotal = ws.reduce((a, b) => a + b) + 2;   // + Frame Timber, Rivet
    const buildingCost = costTo(41, st.camps, Math.max(st.camps, camps)) + costTo(400, st.sawmills, Math.max(st.sawmills, saws)) + costTo(5000, st.workshops, Math.max(st.workshops, wsTotal));
    let landCost = 0, pr = st.acrePrice;
    for (let a = st.acres; a < acreN; a++) { landCost += pr; pr = Math.floor(pr * 100 * 41 / 40) / 100; }
    return {
      fixedAcres: fixed, bufferAcres: buffer,
      income: rule.income, batch: rule.b.k, perCd: rule.b.perCd, cdPerHour: rule.b.cdH,
      tWall: rule.tWall, limitHours: rule.tWall / 3, tWallFrom: opts.cdPerHour > 0 ? 'measured' : 'model',
      lastAcre: rule.last, acresToBuy: Math.max(0, rule.last - st.acres), landCost,
      targetAcres: acreN, engineAcres: E, planksH: planks, camps, sawmills: saws,
      workshops: { bookshelf: ws[0], table: ws[1], chair: ws[2], frameTimber: 1, rivet: 1, total: wsTotal },
      revenueH: planks * m.perPlank, buildingCost,
      need: { camps: Math.max(0, camps - st.camps), sawmills: Math.max(0, saws - st.sawmills), workshops: Math.max(0, wsTotal - st.workshops) },
    };
  }

  core.coreMath = { TYPES, batchCost, bestBatch, acrePrice, engineModel, landRule };
})();
} catch (e) { console.error('[IdleCorp] core-math failed to load:', e); }
// @@END core-math