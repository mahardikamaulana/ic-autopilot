// ============================================================================
// CORE PLAN DIRECTOR: Expansion (scripts/retail-optimizer-plan.md R-7, C1, C2; wiki regions-and-land.md "Opening a new region")
// ============================================================================
// Director "expand" (order 47, after retail). When Heartland is full and the retail allocator is held by Planks or land
// (binding planks, or money / workshops with no free acre for a Workshop), it offers the region option that pays back best:
//   - a new region: the cheapest charter not owned (Industrial Basin, Coastal Cities, Frontier), level 1 (60 acres);
//   - in a region this director opened: more chain while a block fits its acres, else its next charter level (150 / 360 acres) (C2).
// Heartland counts as full at 360 acres, or below it once its next acres for the same chain cost more than the region's charter + land + courier
// (scripts/multi-region-plan.md M-5: a land rule or Planks that stop Heartland short of 360 no longer block expansion for good).
// Payback = (charter + land + courier fees + buildings + store) / the region chain's $/h (window.idleCore.retailAlloc on the region's
// board, Planks from its Sawmills) <= cfg.expandPaybackH, and cash after it >= the money floor + cfg.expandBillHours of bills.
// Nothing is offered until Heartland holds the whole shipment and the store materials, less what other modules keep (the wait names what is short).
// cfg.expand: 'off' (also pauses a run in progress) | 'ask' (default: a toast with the cost, payback and a Go button; corePlan._expand.go()
// does the same; the Go is saved and binds to the offer shown: recomputed, same region and level, cost up <= 2%, else it asks again) | 'auto'. Sizing: Workshops on the best $/Workshop-hour good, Sawmills for their Planks, Camps for the
// Sawmills' Wood, 1 store, at the floors the corp's layouts run (the chain ratios buildout uses), as many as fit the acres.
// The run (mem "expand".run, so a reload resumes mid-sequence), one message per step, each confirmed by state:
//   BuyCharter -> BuyLand -> TransferStock per item (build items + the applied layout's kit per recipe, + cfg.expandMarginPct, + cfg.expandPlanksH
//   of Workshop Planks; one courier run each, waiting for courier_ready_at) -> wait for arrival -> BuyBuilding Workshops, Camps, Sawmills ->
//   power (Auto utilities power on: ask it and wait for free MW, never a SetSubscription; off: SetSubscription) -> CreateGroup +
//   SetRecipe Workshops first (their kits need Wood; waits cfg.expandEquipMin for equipped == count, then goes on and reports), Camps, Sawmills ->
//   store materials (6 Iron Frame, 20 Concrete, 20 Glass per store; kept back in Heartland by the "coreExpand" reserve provider until shipped)
//   -> ship -> BuyBuilding the store -> CreateGroup "Retail"; its shelves come from the retail director's region pass (cp-retail regionShelf).
// A step the state never shows is not sent again blindly: the run stops with the reason in the readout (TransferStock gets 2 tries: a busy
// courier drops it) and frees the store materials. corePlan._expand.reset() retries from the state; cancel() drops the run, keeps the region as
// this director's (a later offer can finish it) and turns 'auto' into 'ask'. While a run is on, its region's acres are
// held (idleCore.acreHolds, which planner.pickRegion honours: CD Farm's Auto region skips it).
// C2: the shelves of the regions this director opened or adopted are set by cp-retail's region pass (multi-region plan lever 4: the same shelf
// rule as Heartland on the region's own board). cp-buildout reads a Heartland-only view; a region grows only through this director's upgrades.
// Adopt (scripts/multi-region-plan.md M-3, M-4): a region the corp owns but this director did not open, with Workshops on a Planks good,
// becomes this director's: with a store it is registered at once (shelves, growth offers); without one it gets a store-only run (acres the
// store lacks, store materials, store, Retail group, shelves), which starts in 'ask' without a Go while it costs under $1M.
// @@MODULE cp-expand
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const cp = W.corePlan, cfg = cp.cfg, usd = cp._usd, core = W.idleCore, P = core.planner;
  const NAMES = ['Heartland', 'Industrial Basin', 'Coastal Cities', 'Frontier'];
  const BASE = [0, 100000000, 300000000, 900000000], MULT = [0, 1, 3, 32], CAP = [360, 60, 150, 360], HOPS = [1, 2, 3, 4];   // cents; charter level -> acre cap; hops from Heartland
  const WS = 'Workshop', CAMP = 'Lumber Camp', SAW = 'Sawmill', STORE = 'Retail Store';
  const TICKS_H = 7200, Q0 = 0.95, RATES = { power: 1000, water: 400, bandwidth: 1500 };   // cents per unit per 10-min bill (as cp-retail billsOf)
  const runsH = (r, rate) => rate * 3600 / (r.ticks / 2);
  const amt = (list, item) => (list ?? []).filter((x) => x.item === item).reduce((a, x) => a + x.amount, 0);
  const out1 = (r) => r.outputs?.[0]?.amount ?? 1;
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const mem = (ctx) => ctx.mem?.('expand') ?? null;   // a fresh handle each time: a handle writes its own snapshot back
  let holds = {}, keep = null;                        // published: acres held per region, Heartland items kept for the store

  // ---- reading a region -----------------------------------------------------------------------------------------------------------
  function region(v, r) {
    const st = v.st;
    const groups = Object.entries(st.groups ?? {}).map(([id, g]) => ({ id: +id, ...g })).filter((g) => (g.region ?? 0) === r);
    const pool = st.building_pool?.[r] ?? {};
    const queued = (b) => (st.construction?.builds ?? []).filter((x) => x.building === b && (x.region ?? 0) === r).reduce((a, x) => a + x.count, 0);
    const owned = (b) => groups.filter((g) => g.building === b).reduce((a, g) => a + g.count, 0) + (pool[b] ?? 0) + queued(b);
    return { r, groups, pool, queued, owned, acres: P.regionAcres({ st, catalog: v.catalog, region: r }), level: r === 0 ? 3 : (st.charters?.[r] ?? 0), landBought: st.land_bought?.[r] ?? 0, stock: st.stock?.[r] ?? {} };
  }
  // The chain at the floors the corp's layouts run (a recipe's layout is the corp's, so a new region's groups get it too).
  function chain(v) {
    const R = (n) => v.C.recipes[v.idR(n)], wood = R('Fell Wood'), saw = R('Saw Planks');
    const b = { ws: v.idB(WS), camps: v.idB(CAMP), saws: v.idB(SAW), store: v.idB(STORE) };
    const woodId = v.idI('Wood'), plId = v.idI('Planks');
    if (!wood || !saw || woodId == null || plId == null || Object.values(b).some((x) => x == null)) return null;
    const rate = (r) => v.st.layouts?.[r.id]?.fx?.rate ?? 1;
    return { b, wood, saw, plId, rate, acres: (k) => v.bld(b[k]).acres ?? 1, draw: (k) => v.bld(b[k]).draws?.power ?? 0,
      planksPerSaw: out1(saw) * runsH(saw, rate(saw)), woodPerSaw: amt(saw.inputs, woodId) * runsH(saw, rate(saw)), woodPerCamp: out1(wood) * runsH(wood, rate(wood)),
      // build items + the applied layout's kit (default_kit undercounts it: live 2026-11-28)
      kit: (k, r) => [...(v.bld(b[k]).build_items ?? []), ...((r && v.st.layouts?.[r.id]?.bom) ?? v.bld(b[k]).default_kit ?? [])] };
  }
  // share of a region's shoppers: (1,000 + mine) / sum over store owners (wiki retail.md); 1 with nobody else on the board
  function shareIn(board, st, r) {
    const rows = board?.ratings?.[r] ?? board?.ratings?.[String(r)];
    if (!rows || typeof rows !== 'object' || !Object.keys(rows).length) return 1;
    const me = 1000 + (Number(st.retail_ratings?.[r]) || 0);
    return me / (me + Object.entries(rows).filter(([k]) => String(k) !== String(st.ssi?.corp_id)).reduce((a, [, x]) => a + 1000 + (Number(x) || 0), 0));
  }
  // Region shelf goods: the retail director's goods made in a Workshop from Planks alone, priced on the region's board (quality 0 there).
  function goodsFor(v, ctx, r, ch) {
    const rows = ctx.retailBoard?.shelves?.[r] ?? ctx.retailBoard?.shelves?.[String(r)];
    if (!ctx.retail?.goods || !rows) return null;
    const share = shareIn(ctx.retailBoard, v.st, r);
    return ctx.retail.goods.flatMap((g) => {
      const rc = v.C.recipes[g.rid], row = rows[g.id];
      if (!rc || !row || rc.building !== ch.b.ws || !(g.ppu > 0) || !(rc.inputs ?? []).every((x) => x.item === ch.plId)) return [];
      return [{ id: g.id, name: g.name, rid: g.rid, unitCents: Math.floor((g.base ?? 0) * row.price / 10000 * Q0), planksPerUnit: g.ppu,
        unitsPerWorkshopHour: out1(rc) * runsH(rc, ch.rate(rc)), demandPerHour: row.appetite / 240 * share * TICKS_H, floorOk: true, region: r }];
    });
  }
  const allocFor = (goods, ws, saws, ch, r) => core.retailAlloc({ goods, supply: { Planks: saws * ch.planksPerSaw }, workshops: { owned: ws, buildable: 0 },
    stores: { [r]: 1 }, cfg: { maxShelves: 4, moveGainPct: 0 } });
  const priceN = (v, k, ch, n) => { let c = 0; for (let i = 0; i < n; i++) c += P.price(v.bld(ch.b[k]).cost, v.ownedAll(v.bld(ch.b[k]).name), i); return c; };
  const feeOf = (v, r, ...ships) => { const cu = core.courierCU?.(v.st) ?? 10000; return ships.reduce((a, s) => a + Object.entries(s).reduce((b, [i, n]) => b + Math.max(0, n * (v.C.items[i]?.cargo_weight ?? 1) - cu) * 5 * HOPS[r], 0), 0); };   // $0.05 per CU over the free run, per hop
  function billsOf(st) {
    let t = (st.isp ?? 0) * RATES.bandwidth;
    const pm = core.powerPriceMult?.() ?? 1;
    for (const o of Object.values(st.subscriptions ?? {})) for (const [k, l] of Object.entries(o ?? {})) t += (l ?? 0) * (RATES[k] ?? 0) * (k === 'power' ? pm : 1);
    return t;
  }

  // ---- an offer: region r at charter `level` --------------------------------------------------------------------------------------
  function offerFor(v, ctx, r, level) {
    const ch = chain(v);
    if (!ch) return { why: 'catalog lacks the chain (Lumber Camp, Sawmill, Workshop, Retail Store, Fell Wood, Saw Planks)' };
    const goods = goodsFor(v, ctx, r, ch);
    if (!goods?.length) return { why: NAMES[r] + ': no board row for a Planks good' };
    const rg = region(v, r), capA = CAP[level];
    const best = goods.filter((g) => g.demandPerHour > 0 && g.unitsPerWorkshopHour > 0).sort((a, b) => b.unitCents * b.unitsPerWorkshopHour - a.unitCents * a.unitsPerWorkshopHour)[0];
    if (!best) return { why: NAMES[r] + ': no demand for a Planks good' };
    const plH = best.unitsPerWorkshopHour * best.planksPerUnit;
    const have = { ws: rg.owned(ch.b.ws), saws: rg.owned(ch.b.saws), camps: rg.owned(ch.b.camps), stores: rg.owned(ch.b.store) };
    const other = rg.acres.used - ['ws', 'saws', 'camps', 'stores'].reduce((a, k) => a + have[k] * ch.acres(k === 'stores' ? 'store' : k), 0);
    const stores = Math.max(1, have.stores);
    let total = null;
    for (let w = Math.max(1, have.ws); w < 1000; w++) {
      const saws = Math.max(have.saws, Math.ceil(w * plH / ch.planksPerSaw - 1e-9)), camps = Math.max(have.camps, Math.ceil(saws * ch.woodPerSaw / ch.woodPerCamp - 1e-9));
      if (other + w * ch.acres('ws') + saws * ch.acres('saws') + camps * ch.acres('camps') + stores * ch.acres('store') > capA) break;
      total = { ws: w, saws, camps, stores };
    }
    if (!total) return { why: NAMES[r] + ': one Workshop chain does not fit ' + capA + ' acres' };
    const add = { ws: total.ws - have.ws, saws: total.saws - have.saws, camps: total.camps - have.camps, stores: total.stores - have.stores };
    if (!add.ws && !add.saws && !add.camps) return { why: NAMES[r] + ': level ' + level + ' adds nothing' };
    const al = allocFor(goods, total.ws, total.saws, ch, r), al0 = have.ws ? allocFor(goods, have.ws, have.saws, ch, r) : null;
    const dph = al.dollarsPerHour - (al0?.dollarsPerHour ?? 0);
    // Workshops per recipe: what runs now, plus the new ones toward the plan's gaps; the rest on the best good
    const onR = (rid) => rg.groups.filter((g) => g.building === ch.b.ws && g.recipe === rid).reduce((a, g) => a + g.count, 0);
    const ws = {};
    let left = add.ws;
    for (const g of goods) { const n = Math.min(left, Math.max(0, (al.alloc[g.id] ?? 0) - onR(g.rid))); if (n > 0) { ws[g.rid] = onR(g.rid) + n; left -= n; } }
    if (left > 0) ws[best.rid] = (ws[best.rid] ?? onR(best.rid)) + left;
    // shipment: build items + kit per new building, the margin, then cfg.expandPlanksH of the new Workshops' Planks
    const ship = {}, put = (list, n) => { for (const x of list) ship[x.item] = (ship[x.item] ?? 0) + x.amount * n; };
    for (const [rid, n] of Object.entries(ws)) put(ch.kit('ws', v.C.recipes[rid]), n - onR(+rid));
    put(ch.kit('camps', ch.wood), add.camps); put(ch.kit('saws', ch.saw), add.saws);
    for (const i of Object.keys(ship)) ship[i] = Math.ceil(ship[i] * (1 + cfg.expandMarginPct / 100));
    ship[ch.plId] = (ship[ch.plId] ?? 0) + Math.ceil(add.ws * plH * cfg.expandPlanksH);
    const storeShip = {};
    for (const x of v.bld(ch.b.store).build_items ?? []) storeShip[x.item] = x.amount * add.stores;
    for (const k of Object.keys(ship)) if (!(ship[k] > 0)) delete ship[k];
    const fee = feeOf(v, r, ship, storeShip);
    const charter = rg.level >= level ? 0 : BASE[r] * MULT[level];
    const land = rg.landBought < capA ? P.landCost(P.firstAcre(r), rg.landBought, capA - rg.landBought) : 0;
    const blds = priceN(v, 'ws', ch, add.ws) + priceN(v, 'camps', ch, add.camps) + priceN(v, 'saws', ch, add.saws), store = priceN(v, 'store', ch, add.stores);
    const cost = charter + land + fee + blds + store;
    const mw = Math.ceil(total.ws * ch.draw('ws') + total.stores * ch.draw('store')), newMW = Math.max(0, mw - (v.st.subscriptions?.[r]?.power ?? 0));
    const line = NAMES[r] + (rg.level ? ' charter ' + rg.level + ' -> ' + level : '') + ': ' + [charter && 'charter ' + usd(charter), land && (capA - rg.landBought) + ' acres ' + usd(land), fee && 'courier ' + usd(fee), 'buildings ' + usd(blds), store && 'store ' + usd(store)].filter(Boolean).join(' + ')
      + ' = ' + usd(cost) + ' for +' + add.ws + ' Workshops, +' + add.camps + ' Camps, +' + add.saws + ' Sawmills' + (add.stores ? ', ' + add.stores + ' store' : '') + ': +' + usd(dph * 100) + '/h, payback ' + (dph > 0 ? (cost / 100 / dph).toFixed(1) + ' h' : 'never');
    const acres = add.ws * ch.acres('ws') + add.saws * ch.acres('saws') + add.camps * ch.acres('camps') + add.stores * ch.acres('store');
    return { r, level, total, add, ws, ship, storeShip, cost, charter, land, fee, acres, dph, payback: dph > 0 ? cost / 100 / dph : Infinity, mw, newMW, line };
  }
  // What Heartland lacks for the offer's shipment and store materials: stock less what other modules keep (finite reserves, as shipStep).
  // .items: what is missing per item (feedStep)
  function shortOf(v, ctx, o) {
    const need = {}, out = [];
    out.items = {};
    for (const s of [o.ship, o.storeShip]) for (const [i, n] of Object.entries(s)) need[i] = (need[i] ?? 0) + n;
    for (const [i, n] of Object.entries(need)) {
      const res = ctx.reserveItems?.[i], kept = Number.isFinite(res) ? Math.max(0, res - (keep?.[i] ?? 0)) : 0, have = v.st.stock?.[0]?.[i] ?? 0;
      if (have - kept >= n) continue;
      out.push(n + ' ' + (v.C.items[i]?.name ?? 'item ' + i) + ' (have ' + Math.floor(have) + (kept ? ', ' + kept + ' kept by other modules' : '') + ')');
      out.items[i] = n - (have - kept);
    }
    return out;
  }
  // M-2 (scripts/multi-region-plan.md): an item the run or the offer lacks in Heartland that one Heartland group makes and another uses up
  // (Iron Sheet into Iron Frames): the consumer is paused until the run has shipped that item, or for cfg.expandFeedH at most without a run.
  // Never a group already paused (yours stay as they are), nor one whose own output is short too. cfg.expandFeed false: off.
  // The group to pause for item i (null: nothing makes i, or nothing to pause). fed: groups already paused for a run.
  function feedPick(v, short, i, fed = []) {
    const R = (g) => v.C.recipes[g.recipe], live = v.groups.filter((g) => !g.paused && g.count > 0 && R(g));
    if (!cfg.expandFeed || !live.some((g) => (R(g).outputs ?? []).some((x) => x.item === i))) return null;   // nothing makes it: a pause would not help
    return live.find((g) => (R(g).inputs ?? []).some((x) => x.item === i) && !(R(g).outputs ?? []).some((x) => short[x.item] > 0) && !fed.some((f) => f.group === g.id)) ?? null;
  }
  // Only inside a run (after Go in 'ask'): an offer short of a feedable item is not held back (gate), the run's ship step feeds it.
  function feedStep(v, ctx, short) {
    if (!cfg.expandFeed || !short) return null;
    const fed = mem(ctx).get().fed ?? [], R = (g) => v.C.recipes[g.recipe];
    for (const i of Object.keys(short).map(Number)) {
      const g = short[i] > 0 ? feedPick(v, short, i, fed) : null;
      if (!g) continue;
      const until = (x) => {
        const ok = !!x.groups.find((y) => y.id === g.id)?.paused, h = mem(ctx);
        if (ok && !(h.get().fed ?? []).some((f) => f.group === g.id)) h.set({ fed: [...(h.get().fed ?? []), { group: g.id, item: i, at: ctx.now ?? Date.now() }] });
        return ok;
      };
      return { action: { id: 'expand:feed:' + g.id, text: 'expand: pause group ' + g.id + ' (' + (g.name || R(g).name) + ') until ' + Math.ceil(short[i]) + ' more ' + (v.C.items[i]?.name ?? 'item ' + i) + ' are in Heartland and shipped',
        steps: [{ msg: { type: 'SetPaused', group: g.id, paused: true }, until }] } };
    }
    return null;
  }
  // The groups feedStep paused, resumed one per step once their item has shipped (or the run needs none of it), on 'off', or after
  // cfg.expandFeedH without a run. A group someone else resumed, or that is gone, is just forgotten.
  function feedResume(v, ctx, mm, now) {
    const run = mm.run;
    for (const f of mm.fed ?? []) {
      const g = v.groups.find((x) => x.id === f.group), drop = () => { const h = mem(ctx); h.set({ fed: (h.get().fed ?? []).filter((x) => x.group !== f.group) }); };
      if (!g?.paused) { drop(); continue; }
      const done = run && (run.shipped?.[f.item] || run.storeShipped?.[f.item] || !((run.ship?.[f.item] ?? 0) + (run.storeShip?.[f.item] ?? 0)));
      if (!(done || cfg.expand === 'off' || (!run && now - f.at > cfg.expandFeedH * 3600000))) continue;
      return { action: { id: 'expand:unfeed:' + g.id, text: 'expand: resume group ' + g.id + ' (' + (v.C.items[f.item]?.name ?? 'item ' + f.item) + ' shipped or no longer needed)',
        steps: [{ msg: { type: 'SetPaused', group: g.id, paused: false }, until: (x) => { const ok = !x.groups.find((y) => y.id === g.id)?.paused; if (ok) drop(); return ok; } }] } };
    }
    return null;
  }
  // Lever 6 (scripts/multi-region-plan.md M-3): a region the corp owns that this director did not open, with Workshops on a Planks good.
  // A store already there: { has } (decide registers it). No store: a store-only offer (acres for the store if it lacks them, the store
  // materials, the store; no charter, Workshop, Camp or Sawmill). null when the region makes no Planks good.
  function adoptFor(v, ctx, r) {
    const ch = chain(v), rg = region(v, r), goods = ch ? goodsFor(v, ctx, r, ch) : null;
    const made = (goods ?? []).filter((g) => rg.groups.some((x) => x.recipe === g.rid && x.count > 0));
    if (!made.length) return null;
    const on = (k, rid) => rg.groups.filter((g) => g.building === ch.b[k] && g.recipe === rid).reduce((a, g) => a + g.count, 0);
    const ws = rg.owned(ch.b.ws), saws = on('saws', ch.saw.id), dph = allocFor(goods, ws, saws, ch, r).dollarsPerHour;
    if (rg.owned(ch.b.store)) return { r, level: rg.level, has: true, dph };
    const lack = Math.max(0, ch.acres('store') - rg.acres.free), landTo = rg.landBought + lack;
    if (landTo > CAP[rg.level]) return { why: NAMES[r] + ': no ' + ch.acres('store') + ' free acres for a store under charter ' + rg.level };
    const storeShip = {};
    for (const x of v.bld(ch.b.store).build_items ?? []) storeShip[x.item] = x.amount;
    const fee = feeOf(v, r, storeShip), land = lack ? P.landCost(P.firstAcre(r), rg.landBought, lack) : 0, store = priceN(v, 'store', ch, 1), cost = fee + land + store;
    const mw = Math.ceil(ws * ch.draw('ws') + ch.draw('store')), payback = dph > 0 ? cost / 100 / dph : Infinity;
    const line = NAMES[r] + ' (not opened by Core plan): ' + ['store ' + usd(store), land && lack + ' acres ' + usd(land), fee && 'courier ' + usd(fee)].filter(Boolean).join(' + ') + ' = ' + usd(cost)
      + ' to sell its ' + made.map((g) => g.name).join(', ') + ': +' + usd(dph * 100) + '/h, payback ' + (dph > 0 ? payback.toFixed(1) + ' h' : 'never');
    return { r, level: rg.level, adopt: true, landTo, total: { ws, camps: on('camps', ch.wood.id), saws, stores: 1 }, ws: {}, ship: {}, storeShip, cost, dph, payback, mw, newMW: Math.max(0, mw - (v.st.subscriptions?.[r]?.power ?? 0)), line };
  }
  // An offer that pays back: Heartland holds what it ships, and cash covers it + the money floor + cfg.expandBillHours of bills.
  function gate(v, ctx, o) {
    if (o.payback > cfg.expandPaybackH) return { why: o.line + ' > ' + cfg.expandPaybackH + ' h', offer: o };
    // nothing is bought before Heartland holds everything the run ships (a run stuck without its store materials wastes the charter)
    const all = shortOf(v, ctx, o), short = all.filter((s, k) => !feedPick(v, all.items, +Object.keys(all.items)[k]));   // M-2: what feed can make does not hold the offer
    short.items = all.items;
    if (short.length) return { why: o.line + ': Heartland needs ' + short.join(', ') + ' (Glass / Concrete: the Kiln; Iron Frame: a Workshop on Assemble Iron Frame)', offer: o, short };
    const bills = cfg.expandBillHours * 6 * (billsOf(v.st) + o.newMW * RATES.power * (core.powerPriceMult?.() ?? 1));
    const need = o.cost + (ctx.floorCents ?? 0) + bills;
    if (v.money < need) return { why: o.line + ': need ' + usd(need - v.money) + ' more (money floor + ' + cfg.expandBillHours + ' h of bills ' + usd(bills) + ')', offer: o };
    return { ok: true, offer: o };
  }
  // A region to adopt first (lever 6); else Heartland held by Planks or land, and the best-paying region option. { ok, why, offer }
  // opened: regions this director opened or adopted (only those are grown or upgraded here).
  function trigger(v, ctx, opened = {}) {
    for (let r = 1; r < NAMES.length; r++) {
      if (opened[r] || !(v.st.charters?.[r] > 0)) continue;
      const a = adoptFor(v, ctx, r), g = a?.adopt ? gate(v, ctx, a) : null;
      if (g?.ok || g?.short) return g;   // short: it waits for the store materials; a store that does not pay (no Sawmills on Saw Planks) does not block the offers below
    }
    let al = null;
    try { al = cp._buildout?.alloc?.(v, ctx) ?? null; } catch (e) { console.error('[corePlan] expand alloc', e); }
    if (v.acresOwned < CAP[0] && !al) return { why: 'Heartland has ' + v.acresOwned + ' of ' + CAP[0] + ' acres: buildout grows it first' };
    if (!al) return { why: 'no retail allocator plan (needs the Heartland store and the board)' };
    const wsAcres = v.bld(v.idB(WS)).acres ?? 2, noLand = v.freeAcres - (cfg.bufferAcres ?? 0) < wsAcres;
    if (!(al.binding === 'planks' || (noLand && (al.binding === 'money' || al.binding === 'workshops')))) return { why: 'Heartland is held by ' + al.binding + ' (' + al.detail + '), not Planks or land' };
    const opts = [];
    for (let r = 1; r < NAMES.length; r++) {
      const lv = v.st.charters?.[r] ?? 0;
      if (!lv || !opened[r]) continue;
      const here = offerFor(v, ctx, r, lv);   // another chain block fits its acres: grow inside them; none fits: the next level (C2)
      if (here.r != null) opts.push(here); else if (lv < 3) opts.push(offerFor(v, ctx, r, lv + 1));
    }
    const fresh = [1, 2, 3].find((r) => !(v.st.charters?.[r] > 0));
    if (fresh) opts.push(offerFor(v, ctx, fresh, 1));
    const ok = opts.filter((o) => o.r != null && o.dph > 0).sort((a, b) => a.payback - b.payback);
    const o = ok[0];
    if (!o) return { why: opts.map((x) => x.why ?? x.line).join('; ') || 'no region left to open or upgrade' };
    // Lever 1 (M-5): below Heartland's cap, a region only when Heartland's next acres for the same chain cost more than the region's charter,
    // land and courier (past the cap they cannot be bought at all)
    if (v.acresOwned < CAP[0]) {
      const h = v.acresOwned + o.acres <= CAP[0] ? P.landCost(P.firstAcre(0), v.landBought, o.acres) : Infinity;
      if (h <= o.charter + o.land + o.fee) return { why: 'Heartland has ' + v.acresOwned + ' of ' + CAP[0] + ' acres: its next ' + o.acres + ' cost ' + usd(h) + ', less than ' + o.line.split(':')[0] + "'s " + usd(o.charter + o.land + o.fee) + ' (charter, land, courier): buildout grows it first', offer: o };
    }
    return gate(v, ctx, o);
  }

  // ---- the run --------------------------------------------------------------------------------------------------------------------
  // One message; its `until` notes an unconfirmed send in run.tries[key] (and clears it on a confirm). A key already tried `tries` times
  // and still not done stops the run instead of sending again.
  function act(ctx, run, key, text, msg, cond, o = {}) {
    const t = run.tries?.[key];
    if (t && t.n >= (o.tries ?? 1)) return { abort: text + ': sent ' + t.n + 'x, the game state never showed it' };
    let looked = false;
    const until = (x) => {
      const ok = !!cond(x), m = mem(ctx), cur = m?.get?.().run;
      if (cur) {
        const tries = { ...cur.tries };
        if (ok) delete tries[key]; else if (!looked) tries[key] = { n: (tries[key]?.n ?? 0) + 1, at: ctx.now ?? Date.now() };
        m.set({ run: { ...cur, tries, ...(ok && o.done ? o.done(cur) : {}) } });
      }
      looked = true;
      return ok;
    };
    return { action: { id: 'expand:' + key, text: 'expand ' + NAMES[run.r] + ': ' + text, hold: !!o.hold, steps: [{ msg, until }] } };
  }
  const shipsTo = (st, r, i) => (st.shipments ?? []).filter((s) => s.region === r && s.item === +i && !s.returning && s.amount > 0);
  // Ship each item once (field: run.shipped / run.storeShipped), then wait for arrival. null when everything is there.
  function shipStep(v, ctx, run, rg, items, field, keepOwn) {
    const r = run.r, tick = ctx.tick ?? 0, have = (i) => v.st.stock?.[0]?.[i] ?? 0;
    // scarcest first (Heartland stock / amount): an item its own recipes eat (Iron Sheet into Iron Frames) goes while it is there
    for (const [i, a] of Object.entries(items).sort(([i, a], [j, b]) => have(i) / a - have(j) / b)) {
      if (run[field]?.[i]) continue;
      // sent before a reload (in transit) or already in the region: done
      if (shipsTo(v.st, r, i).some((s) => s.amount >= a) || (rg.stock[i] ?? 0) >= a) { const m = mem(ctx), cur = m.get().run; m.set({ run: { ...cur, [field]: { ...cur[field], [i]: a } } }); continue; }
      const cra = v.st.courier_ready_at ?? 0;
      if (cra > tick) return { wait: 'courier busy for ' + (cra - tick) + ' ticks' };
      const res = ctx.reserveItems?.[i], kept = Math.max(0, (Number.isFinite(res) ? res : 0) - (keepOwn ? keepOwn[i] ?? 0 : 0)), have = v.st.stock?.[0]?.[i] ?? 0;
      const name = v.C.items[i]?.name ?? 'item ' + i;
      if (have - a < kept) return { short: { [i]: a + kept - have }, wait: 'Heartland has ' + Math.floor(have) + ' ' + name + ', ' + a + ' to ship' + (kept ? ' + ' + kept + ' other modules keep' : '') + (field === 'storeShipped' ? ' (Glass / Concrete: the Kiln; Iron Frame: a Workshop on Assemble Iron Frame)' : '') };
      return act(ctx, run, 'ship:' + field + ':' + i, 'ship ' + a + ' ' + name, { type: 'TransferStock', from: 0, to: r, item: +i, amount: a, courier: true },
        (x) => shipsTo(x.st, r, i).some((s) => s.amount >= a), { tries: 2, done: (cur) => ({ [field]: { ...cur[field], [i]: a } }) });
    }
    const fly = (v.st.shipments ?? []).filter((s) => s.region === r && s.amount > 0 && !s.returning && items[s.item] != null);
    return fly.length ? { wait: fly.length + ' shipment(s) to ' + NAMES[r] + ' in transit, ' + Math.max(...fly.map((s) => s.remaining ?? 0)) + ' ticks left' } : null;
  }
  // Power for `mw` more draw in region r. Auto utilities power on: never a SetSubscription (it would lower a level it did not want and the two
  // would fight); ask it for the draw and wait until that is free (plan R-5: a store is served last). Off: SetSubscription to the run's level.
  function powerStep(v, ctx, run, mw) {
    const r = run.r, have = v.st.subscriptions?.[r]?.power ?? 0, au = ctx.mods?.autoUtil;
    if (!(au?.conf?.power?.on && au._measure)) {
      if (have >= run.mw) return null;
      return act(ctx, run, 'power:' + run.mw, 'grid power ' + run.mw + ' MW', { type: 'SetSubscription', region: r, utility: 'power', level: run.mw }, (x) => (x.st.subscriptions?.[r]?.power ?? 0) >= run.mw);
    }
    const free = au._measure('power', r, v.st, v.catalog, ctx.tick ?? 0, ctx.contracts ?? []).free ?? 0;
    if (free + 1e-9 >= mw) return null;
    if (ctx.live) au.ask?.('power', r, mw, ctx.tick ?? 0);
    return { wait: 'waits for ' + mw + ' MW free power in ' + NAMES[r] + ' (asked Auto utilities)' };
  }
  // Groups of building k on recipe rid up to n: CreateGroup (named after the recipe) then SetRecipe, or AssignBuildings to the group.
  // rid null (the store): any group of the building counts, whatever its name.
  function groupStep(v, ctx, run, rg, k, ch, rid, n, name) {
    const b = ch.b[k], r = run.r, gs = rg.groups.filter((g) => g.building === b);
    const unset = gs.find((g) => g.recipe == null && g.name === name && rid != null);
    if (unset) return act(ctx, run, 'recipe:' + unset.id, name + ' on group ' + unset.id, { type: 'SetRecipe', group: unset.id, recipe: rid }, (x) => x.st.groups?.[unset.id]?.recipe === rid);
    const on = gs.filter((g) => rid == null || g.recipe === rid), c = on.reduce((a, g) => a + g.count, 0);
    if (c >= n) return null;
    const pool = rg.pool[b] ?? 0, bn = v.bld(b).name;
    if (!pool) return rg.queued(b) ? { wait: rg.queued(b) + ' ' + bn + ' still building' } : { abort: bn + ': ' + (n - c) + ' more wanted on ' + name + ', none in the ' + NAMES[r] + ' pool' };
    const k2 = Math.min(pool, n - c), g = on.sort((a, x) => x.count - a.count)[0];
    if (g) return act(ctx, run, 'assign:' + g.id + ':' + (g.count + k2), k2 + ' ' + bn + ' into ' + name + ' (group ' + g.id + ')', { type: 'AssignBuildings', group: g.id, amount: k2 }, (x) => (x.st.groups?.[g.id]?.count ?? 0) >= g.count + k2);
    const ids = new Set(gs.map((x) => x.id));
    return act(ctx, run, 'group:' + b + ':' + name, 'group ' + k2 + ' ' + bn + ' as "' + name + '"', { type: 'CreateGroup', building: b, amount: k2, name, region: r },
      (x) => region(x, r).groups.some((y) => !ids.has(y.id) && y.building === b && y.name === name));
  }
  // The next step of the run: { action } | { wait } | { abort } | { done }.
  function runStep(v, ctx, run) {
    const r = run.r, rg = region(v, r), ch = chain(v), now = ctx.now ?? Date.now();
    if (!ch) return { abort: 'the catalog lost a chain building or recipe' };
    const floor = ctx.floorCents ?? 0, cash = (c, what) => (v.money - c < floor ? { wait: what + ' ' + usd(c) + ': need ' + usd(floor + c - v.money) + ' more above the money floor' } : null);
    if (rg.level < run.level) {
      const c = BASE[r] * MULT[run.level];
      return cash(c, 'charter') ?? act(ctx, run, 'charter:' + run.level, 'charter level ' + run.level + ' (' + usd(c) + ')', { type: 'BuyCharter', region: r }, (x) => (x.st.charters?.[r] ?? 0) >= run.level, { hold: true });
    }
    const capA = run.landTo ?? CAP[run.level];   // an adopted region's store run buys only the acres the store lacks
    if (rg.landBought < capA) {
      const n = capA - rg.landBought, c = P.landCost(P.firstAcre(r), rg.landBought, n);
      return cash(c, n + ' acres') ?? act(ctx, run, 'land:' + capA, 'buy ' + n + ' acres (' + usd(c) + ')', { type: 'BuyLand', amount: n, region: r }, (x) => (x.st.land_bought?.[r] ?? 0) >= capA, { hold: true });
    }
    const T = run.total;
    if (!['ws', 'camps', 'saws'].every((k) => rg.owned(ch.b[k]) >= T[k])) {
      const s = shipStep(v, ctx, run, rg, run.ship, 'shipped', keep);
      if (s) return s;
    }
    for (const k of ['ws', 'camps', 'saws']) {
      const b = ch.b[k], n = T[k] - rg.owned(b);
      if (n <= 0) continue;
      const lack = (v.bld(b).build_items ?? []).filter((i) => (rg.stock[i.item] ?? 0) < i.amount * n);
      if (lack.length) return { abort: 'shipped, but ' + NAMES[r] + ' lacks ' + lack.map((i) => (i.amount * n - Math.floor(rg.stock[i.item] ?? 0)) + ' ' + (v.C.items[i.item]?.name ?? i.item)).join(', ') + ' to build ' + n + ' ' + v.bld(b).name };
      const c = priceN(v, k, ch, n);
      return cash(c, n + ' ' + v.bld(b).name) ?? act(ctx, run, 'buy:' + k + ':' + T[k], 'buy ' + n + ' ' + v.bld(b).name + ' (' + usd(c) + ')', { type: 'BuyBuilding', building: b, amount: n, region: r }, (x) => region(x, r).owned(b) >= T[k], { hold: true });
    }
    // Workshops first: their kits take Wood the Sawmills would eat
    const wsOn = (rid) => rg.groups.filter((g) => g.building === ch.b.ws && g.recipe === rid).reduce((a, g) => a + g.count, 0);
    const wsAdd = Object.entries(run.ws).reduce((a, [rid, n]) => a + Math.max(0, n - wsOn(+rid)), 0);
    if (wsAdd > 0) { const p = powerStep(v, ctx, run, wsAdd * ch.draw('ws')); if (p) return p; }
    for (const [rid, n] of Object.entries(run.ws)) { const s = groupStep(v, ctx, run, rg, 'ws', ch, +rid, n, v.C.recipes[rid]?.name ?? 'Workshops'); if (s) return s; }
    const unequipped = rg.groups.filter((g) => g.building === ch.b.ws && g.count > 0 && (g.equipped ?? g.count) < g.count);
    if (unequipped.length && !run.equipLate) {
      // live 2026-11-28: a Workshop stayed unequipped ~15 min with its kit in stock; wait, then go on and report it
      const since = run.equipSince ?? now;
      if (run.equipSince == null) { const m = mem(ctx); m.set({ run: { ...m.get().run, equipSince: now } }); }
      if (now - since < cfg.expandEquipMin * 60000) return { wait: 'Workshop group(s) ' + unequipped.map((g) => g.id + ' ' + (g.equipped ?? 0) + '/' + g.count).join(', ') + ' not equipped yet (' + Math.round((now - since) / 60000) + ' of ' + cfg.expandEquipMin + ' min)' };
      const m = mem(ctx); m.set({ run: { ...m.get().run, equipLate: 'Workshop group(s) ' + unequipped.map((g) => g.id + ' equipped ' + (g.equipped ?? 0) + '/' + g.count).join(', ') + ' after ' + cfg.expandEquipMin + ' min; went on' } });
    }
    for (const [k, rc] of [['camps', ch.wood], ['saws', ch.saw]]) { const s = groupStep(v, ctx, run, rg, k, ch, rc.id, T[k], rc.name); if (s) return s; }
    if (T.stores > rg.owned(ch.b.store)) {
      const s = shipStep(v, ctx, run, rg, run.storeShip, 'storeShipped', keep);
      if (s) return s;
      const n = T.stores - rg.owned(ch.b.store), lack = (v.bld(ch.b.store).build_items ?? []).filter((i) => (rg.stock[i.item] ?? 0) < i.amount * n);
      if (lack.length) return { abort: 'store materials shipped, but ' + NAMES[r] + ' lacks ' + lack.map((i) => (v.C.items[i.item]?.name ?? i.item)).join(', ') };
      const c = priceN(v, 'store', ch, n);
      return cash(c, 'store') ?? act(ctx, run, 'buy:store:' + T.stores, 'buy ' + n + ' Retail Store (' + usd(c) + ')', { type: 'BuyBuilding', building: ch.b.store, amount: n, region: r }, (x) => region(x, r).owned(ch.b.store) >= T.stores, { hold: true });
    }
    const sp = (rg.pool[ch.b.store] ?? 0) > 0 ? powerStep(v, ctx, run, (rg.pool[ch.b.store] ?? 0) * ch.draw('store')) : null;
    if (sp) return sp;
    const gs = groupStep(v, ctx, run, rg, 'store', ch, null, T.stores, 'Retail');
    if (gs) return gs;
    return { done: true };   // its shelves: the retail director's region pass (lever 4)
  }

  // What the region holds while a run is on: its acres (CD Farm's Auto region skips it) and the shipment and store materials not shipped yet.
  // A run stopped on an error keeps its acres held but frees the items (reset() holds them again).
  function publish(run) {
    holds = run ? { [run.r]: CAP[run.level] } : {};
    // the shipment too (multi-region plan, phase 2): a run that starts while buildout still buys lost its Iron Sheet to Heartland kits
    keep = null;
    if (run && !run.err) for (const [s, f] of [['ship', 'shipped'], ['storeShip', 'storeShipped']]) for (const [i, n] of Object.entries(run[s] ?? {})) if (!run[f]?.[i]) (keep ??= {})[i] = (keep[i] ?? 0) + n;
    core.acreHolds = holds;
  }
  try { publish(JSON.parse(W.localStorage?.getItem('corePlan.v1.mem.expand') || '{}')?.run ?? null); } catch {}
  core.reserves?.register('coreExpand', { reserve: () => (keep ? { moneyFloor: 0, items: { ...keep }, nextTech: null, phase: null } : null), busy: () => false });

  const startRun = (o, now) => ({ r: o.r, level: o.level, landTo: o.landTo, adopt: o.adopt, total: o.total, ws: o.ws, ship: o.ship, storeShip: o.storeShip, mw: o.mw, dph: o.dph, cost: o.cost, line: o.line, at: now, shipped: {}, storeShipped: {}, tries: {} });
  function decide(v, ctx) {
    const m = mem(ctx);
    if (!m) return { wait: 'no director memory' };
    const mm = m.get(), now = ctx.now ?? Date.now(), mode = cfg.expand;
    const readout = { mode, regions: Object.entries(mm.regions ?? {}).map(([r, x]) => NAMES[r] + ' level ' + x.level + (x.cancelled ? ' (run cancelled: an offer can finish it)' : ', modelled +' + usd(x.dph * 100) + '/h')) };
    if (mm.fed?.length) { readout.fed = mm.fed.map((f) => 'group ' + f.group + ' paused for ' + (v.C.items[f.item]?.name ?? f.item)); const fr = feedResume(v, ctx, mm, now); if (fr) return { ...fr, readout }; }
    if (mm.run) {
      readout.run = mm.run.line;
      if (mm.run.equipLate) readout.alert = mm.run.equipLate;
      if (mm.run.err) return { wait: 'STOPPED: ' + mm.run.err + ' (corePlan._expand.reset() retries from the state, cancel() drops the run)', readout: { ...readout, alert: mm.run.err } };
      // off (or a bad value) pauses the run where it is: acres and store materials stay held; cancel() drops it
      if (mode !== 'ask' && mode !== 'auto') return { wait: 'PAUSED (cfg.expand is "' + mode + '"): ' + mm.run.line + ' (set ask or auto to go on, corePlan._expand.cancel() drops the run)', readout };
      const s = runStep(v, ctx, mm.run);
      if (s.abort) {
        const cur = mem(ctx).get().run, stopped = { ...cur, err: s.abort, errAt: now };
        mem(ctx).set({ run: stopped });
        publish(stopped);
        if (ctx.live) core.notify?.('CP', 'Expansion stopped', s.abort);
        return { wait: 'STOPPED: ' + s.abort, readout: { ...readout, alert: s.abort } };
      }
      const fs = !s.done && s.short ? feedStep(v, ctx, s.short) : null;
      if (fs) return { ...fs, readout };
      if (!s.done) return { ...s, readout: { ...readout, next: s.action?.text ?? s.wait } };
      const cur = mem(ctx).get().run;
      mem(ctx).set({ run: null, regions: { ...mm.regions, [cur.r]: { level: cur.level, at: now, dph: cur.dph } } });
      publish(null);
      readout.regions.push(NAMES[cur.r] + ' level ' + cur.level + ': done');
    }
    if (!['off', 'ask', 'auto'].includes(mode)) return { wait: 'cfg.expand is "' + mode + '": off (use off, ask or auto)', readout };
    if (mode === 'off') { if (mm.go) m.set({ go: null }); return { wait: 'off (cfg.expand)', readout }; }
    // M-3: a region with Workshops on a Planks good and a store, not opened here, is this director's from now on (shelves, growth offers)
    for (let r = 1; r < NAMES.length; r++) {
      if (mem(ctx).get().regions?.[r] || !(v.st.charters?.[r] > 0)) continue;   // fresh handles: m still holds the snapshot from before a run ended
      const a = adoptFor(v, ctx, r);
      if (a?.has) { const h = mem(ctx); h.set({ regions: { ...h.get().regions, [r]: { level: a.level, at: now, dph: a.dph, adopted: true } } }); readout.regions.push(NAMES[r] + ' level ' + a.level + ': adopted'); }
    }
    const t = trigger(v, ctx, mem(ctx).get().regions ?? {});
    readout.offer = t.offer?.line ?? null;
    // Go (mem.go, so a reload keeps it) is for the offer it was pressed on: same region and level, cost up by at most 2% (building prices
    // move as CD Farm buys and demolishes); anything else asks again.
    const go = mode === 'ask' ? mm.go ?? null : null;
    if (!t.ok) {
      if (go) m.set({ go: null, goMiss: 'Go pressed, but ' + t.why });
      return { wait: t.why, readout: { ...readout, ...(mm.goMiss ? { goMiss: mm.goMiss } : {}) } };
    }
    const shown = { r: t.offer.r, level: t.offer.level, cost: Math.round(t.offer.cost) };
    const goOk = !!go && go.r === shown.r && go.level === shown.level && shown.cost <= go.cost * 1.02;
    if (go && !goOk) m.set({ go: null, toastKey: null, goMiss: 'the offer changed after Go (' + NAMES[go.r] + ' level ' + go.level + ' ' + usd(go.cost) + ' -> ' + t.offer.line + '): asking again' });
    if (mode === 'ask' && !goOk && !(t.offer.adopt && t.offer.cost < 1e8)) {   // M-4: an adopted region's store under $1M needs no Go
      const mx = m.get(), old = mx.offer;
      if (!old || old.r !== shown.r || old.level !== shown.level || Math.abs(shown.cost / old.cost - 1) > 0.01) m.set({ offer: shown });
      const key = shown.r + ':' + shown.level;
      if (ctx.live && (mx.toastKey !== key || !(now - (mx.toastAt ?? 0) < cfg.expandToastMin * 60000))) {
        m.set({ toastKey: key, toastAt: now });
        core.toast?.('Core plan: open ' + t.offer.line, { action: { label: 'Go', run: () => mem(ctx)?.set({ go: shown }) } });
      }
      return { wait: 'offer: ' + t.offer.line + ' (Go on the toast, or corePlan._expand.go())', readout: { ...readout, ...(mx.goMiss ? { goMiss: mx.goMiss } : {}) } };
    }
    if (!ctx.live) return { wait: 'dry run: would start ' + t.offer.line, readout };
    const run = startRun(t.offer, now);
    m.set({ run, go: null, goMiss: null });
    publish(run);
    const s = runStep(v, ctx, run);
    return { ...(s.abort ? { wait: s.abort } : s), readout: { ...readout, run: run.line } };
  }

  cp.addDirector({
    name: 'expand', order: 47,
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
    context: (v, ctx) => publish(mem(ctx)?.get?.()?.run ?? null),
    decide,
    duties: () => [{ duty: 'second region: charter, land, shipment, chain, store (plan C1, C2)', owner: 'Core plan', done: true }],
  });
  // Cheapest all-in cents per acre of the next region block: a region's next charter level (charter + land to its cap) per acre it adds,
  // or a fresh region's level 1. Infinity with nothing left. cp-buildout's opt-in Heartland land cap reads it.
  function regionAcreCents(v) {
    let best = Infinity;
    for (let r = 1; r < NAMES.length; r++) {
      const lv = v.st.charters?.[r] ?? 0, lb = v.st.land_bought?.[r] ?? 0;
      if (lv >= 3) continue;
      const add = CAP[lv + 1] - lb;
      if (add > 0) best = Math.min(best, (BASE[r] * MULT[lv + 1] + P.landCost(P.firstAcre(r), lb, add)) / add);
    }
    return best;
  }
  cp._expand = {
    offerFor, regionAcreCents, trigger, region, chain, goodsFor, runStep,
    get holds() { return holds; }, get keep() { return keep; },
  };
  // go / reset / cancel act on the saved memory (the key Core plan's memOf uses)
  const KEYM = 'corePlan.v1.mem.expand';
  const disk = () => { try { return JSON.parse(W.localStorage?.getItem(KEYM) || '{}') ?? {}; } catch { return {}; } };
  const save = (o) => { try { W.localStorage?.setItem(KEYM, JSON.stringify(o)); } catch {} };
  cp._expand.go = () => { const o = disk(); if (!o.offer) return 'no offer shown yet'; save({ ...o, go: o.offer }); return 'Go noted for ' + NAMES[o.offer.r] + ' level ' + o.offer.level + ' ' + usd(o.offer.cost) + ': the next Core plan step checks the offer again and starts it if it still holds'; };
  cp._expand.reset = () => { const o = disk(); if (!o.run) return 'no run'; const run = { ...o.run, err: null, errAt: null, tries: {} }; save({ ...o, run }); publish(run); return 'run resumes from the state at the next step'; };
  // The region stays this director's (it can be finished or grown later, through an offer), and auto drops to ask so the next region is not
  // started on its own right after a cancel.
  cp._expand.cancel = () => {
    const o = disk();
    if (!o.run) return 'no run';
    save({ ...o, run: null, go: null, regions: { ...o.regions, [o.run.r]: { level: o.run.level, at: Date.now(), dph: o.run.dph, cancelled: true } } });
    publish(null);
    if (cfg.expand === 'auto') cp.importCfg({ expand: 'ask' });
    return 'run dropped (bought things stay); ' + NAMES[o.run.r] + ' can be finished from a later offer; expand is "' + cfg.expand + '"';
  };
})();
} catch (e) { console.error('[IdleCorp] cp-expand failed to load:', e); }
// @@END cp-expand
