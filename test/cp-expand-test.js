// Core plan expand director (plan C1, C2; src/cp-expand.js) on the live corp of 2026-11-28 (Heartland at 360 acres, $12.3M) with a small
// local game: pure corePlan._decide on a view, the first expand action applied by `apply` below, each step checked with its `until`.
//   bun test/cp-expand-test.js
// The director memory is the same localStorage-backed handle Core plan's memOf gives (a snapshot per handle), so reset() / cancel() and a
// reload (modules evaluated again, same storage) behave as in the page.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('./cp-fixtures');
const FX = require('./live-2026-11-28.json');
const cat = F.board.catalog;
const B = (n) => F.B(n, cat), I = (n) => F.I(n, cat), Rc = (n) => F.Rc(n, cat);

// cp-expand from the built script once build.js lists it, else straight from src (so it tests before it is registered)
const BUILT = F.full().includes('// @@MODULE cp-expand\n');
const evalSrc = () => { if (!globalThis.corePlan._expand) (0, eval)(F.slice(fs.readFileSync(path.join(__dirname, '..', 'src', 'cp-expand.js'), 'utf8'), 'cp-expand')); };
const MODS = ['cp-buildout', 'cp-retail', ...(BUILT ? ['cp-expand'] : [])];
function loadExpand() {
  F.load(MODS);
  evalSrc();
  return globalThis.corePlan;
}
// The corp: the live snapshot with the store materials in stock (its Kiln is paused by hand) and the courier ready.
function corp() {
  const st = F.clone(FX.snap);
  Object.assign(st.stock[0], { [I('Iron Frame')]: 40, [I('Concrete')]: 100, [I('Glass')]: 100 });
  return st;
}
const disk = F.mem();
globalThis.localStorage = disk;
const memOf = (n) => { const k = 'corePlan.v1.mem.' + n; let o = {}; try { o = JSON.parse(disk.getItem(k) || '{}'); } catch {} return { get: () => o, set: (p) => { o = { ...o, ...p }; disk.setItem(k, JSON.stringify(o)); return o; } }; };
const TICK = FX.snap.courier_ready_at + 10;
const ctxFor = (o = {}) => F.ctxOf({ retailBoard: FX.retail, mem: memOf, tick: TICK, now: 1.8e12, ...o });

// The local game: the region messages the director sends. drop: message types received but not applied (a mismatch).
function apply(st, m, drop = []) {
  if (drop.includes(m.type)) return;
  const r = m.region ?? 0, pool = ((st.building_pool ??= {})[r] ??= {}), stock = ((st.stock ??= {})[r] ??= {});
  const bd = (b) => cat.buildings.find((x) => x.id === b);
  switch (m.type) {
    case 'BuyCharter': (st.charters ??= {})[r] = (st.charters[r] ?? 0) + 1; st.items[0] -= [0, 1e8, 3e8, 9e8][r] * [0, 1, 3, 32][st.charters[r]]; break;
    case 'BuyLand': st.land_bought[r] = (st.land_bought[r] ?? 0) + m.amount; break;
    case 'TransferStock': st.stock[0][m.item] -= m.amount; (st.shipments ??= []).push({ item: m.item, amount: m.amount, region: m.to, remaining: 480, returning: false, courier: true }); st.courier_ready_at = TICK + 20; break;
    case 'BuyBuilding': for (const x of bd(m.building).build_items ?? []) stock[x.item] = (stock[x.item] ?? 0) - x.amount * m.amount; pool[m.building] = (pool[m.building] ?? 0) + m.amount; break;
    case 'CreateGroup': { const id = st.next_group_id++; pool[m.building] -= m.amount; st.groups[id] = { building: m.building, region: r, count: m.amount, recipe: null, name: m.name, equipped: 0, work: [], modules: {} }; break; }
    case 'SetRecipe': st.groups[m.group].recipe = m.recipe; st.groups[m.group].equipped = st.groups[m.group].count; break;
    case 'AssignBuildings': { const g = st.groups[m.group]; st.building_pool[g.region ?? 0][g.building] -= m.amount; g.count += m.amount; g.equipped = g.count; break; }
    case 'SetSubscription': ((st.subscriptions ??= {})[r] ??= {})[m.utility] = m.level; break;
    case 'SetAssortment': st.groups[m.group].assortment = [...m.items]; break;
    default: throw new Error('unexpected message ' + m.type);
  }
}
const arrive = (st) => { for (const s of st.shipments ?? []) { const k = (st.stock[s.region] ??= {}); k[s.item] = (k[s.item] ?? 0) + s.amount; } st.shipments = []; st.courier_ready_at = 0; };
// Steps the director: each decide, its expand action is applied (all steps); shipments arrive when it waits on them. Returns the messages.
function drive(cp, st, { n = 60, ctx = {}, drop = [], stopAt = null } = {}) {
  const sent = [];
  for (let k = 0; k < n; k++) {
    const out = cp._decide(cp._view(st, cat, []), ctxFor(ctx));
    const a = out.actions.find((x) => x.director === 'expand');
    if (!a) {
      const w = out.waits.find((x) => /^expand:/.test(x)) ?? '';
      if (/in transit/.test(w)) { arrive(st); continue; }
      if (/courier busy/.test(w)) { st.courier_ready_at = 0; continue; }
      return { sent, wait: w, out };
    }
    for (const s of a.steps) { apply(st, s.msg, drop); sent.push(s.msg); s.until(cp._view(st, cat, [])); }
    if (stopAt && stopAt(sent)) return { sent, out };
  }
  return { sent };
}
const types = (sent) => sent.map((m) => m.type + (m.type === 'CreateGroup' || m.type === 'BuyBuilding' ? ':' + cat.buildings.find((b) => b.id === m.building).name : ''));
const fresh = () => { for (const k of Object.keys(disk._disk)) delete disk._disk[k]; };

(async () => {
  let cp = loadExpand();
  cp.cfg.expand = 'auto';

  await F.t('trigger: Heartland below its 360 acres -> no offer, the wait says so', () => {
    fresh();
    const st = corp(); st.land_bought[0] = 300;
    const r = drive(cp, st);
    assert.strictEqual(r.sent.length, 0);
    assert.ok(/Heartland has 325 of 360 acres/.test(r.wait), r.wait);
  });

  await F.t('trigger: a demand-bound allocator (not Planks or land) -> no offer', () => {
    fresh();
    const st = corp(), board = F.clone(FX.retail);
    for (const row of Object.values(board.shelves[0])) row.appetite = 1;
    const r = drive(cp, st, { ctx: { retailBoard: board } });
    assert.strictEqual(r.sent.length, 0);
    assert.ok(/not Planks or land/.test(r.wait), r.wait);
  });

  await F.t('offer: Industrial Basin level 1, 60 acres -> 3 Workshops, 26 Camps, 23 Sawmills, 1 store; payback under 24 h; shipment from the applied layouts + 25%', () => {
    fresh();
    const st = corp(), v = cp._view(st, cat, []), ctx = ctxFor();
    cp._decide(v, ctx);   // the retail facts the offer prices from
    const o = cp._expand.offerFor(v, ctx, 1, 1);
    assert.deepStrictEqual(o.total, { ws: 3, saws: 23, camps: 26, stores: 1 }, o.line);
    assert.ok(o.payback > 5 && o.payback <= 24, o.line);
    assert.ok(o.cost > 100000000 && o.cost < 125000000, o.line);   // charter $1M + land + courier + buildings + store
    // Iron Ore: (3 x 66 Make Bookshelf + 23 x 21 Saw Planks + 26 x 1 Fell Wood) x 1.25 (live layouts; default_kit would give 3 x 14 + 23 x 10)
    assert.strictEqual(o.ship[I('Iron Ore')], Math.ceil((3 * 66 + 23 * 21 + 26) * 1.25), JSON.stringify(o.ship));
    assert.ok(o.ship[I('Planks')] >= 2700, 'a 1 h Planks buffer for 3 Workshops: ' + o.ship[I('Planks')]);
    assert.deepStrictEqual(o.storeShip, { [I('Iron Frame')]: 6, [I('Concrete')]: 20, [I('Glass')]: 20 });
  });

  await F.t('ask: one toast with a Go button, no action; Go starts the run with BuyCharter; the toast does not repeat within expandToastMin', () => {
    fresh();
    cp.cfg.expand = 'ask';
    const toasts = [];
    globalThis.idleCore.toast = (t, o) => toasts.push([t, o]);
    const st = corp();
    let r = drive(cp, st);
    assert.strictEqual(r.sent.length, 0);
    assert.ok(/^expand: offer: Industrial Basin/.test(r.wait), r.wait);
    assert.strictEqual(toasts.length, 1);
    assert.strictEqual(toasts[0][1].action.label, 'Go');
    r = drive(cp, st, { n: 1, ctx: { now: 1.8e12 + 60000 } });
    assert.strictEqual(toasts.length, 1, 'no repeat a minute later');
    toasts[0][1].action.run();   // the click
    r = drive(cp, st, { n: 1 });
    assert.deepStrictEqual(r.sent.map((m) => m.type), ['BuyCharter']);
    assert.strictEqual(memOf('expand').get().run.r, 1);
    cp.cfg.expand = 'auto';
  });

  await F.t('ask: Go is checked again at the click: with the cash gone it does not start, and says why', () => {
    fresh();
    cp.cfg.expand = 'ask';
    const st = corp();
    drive(cp, st);
    cp._expand.go();
    st.items[0] = 50000000;   // $500k
    const r = drive(cp, st, { n: 1 });
    assert.strictEqual(r.sent.length, 0);
    assert.ok(!memOf('expand').get().run);
    assert.ok(/Go pressed, but .*need \$/.test(memOf('expand').get().goMiss), memOf('expand').get().goMiss);
    cp.cfg.expand = 'auto';
  });

  await F.t('materials first: on the live fixture as it is (18 Concrete, 2 Glass, 2 Iron Frame) nothing is bought and no Go is offered; the wait names what is short', () => {
    fresh();
    const st = F.clone(FX.snap), toasts = [];
    globalThis.idleCore.toast = (t, o) => toasts.push([t, o]);
    let r = drive(cp, st);
    assert.strictEqual(r.sent.length, 0);
    assert.ok(/Heartland needs 20 Concrete \(have 18\), 20 Glass \(have 2\), 6 Iron Frame \(have 2\)/.test(r.wait), r.wait);
    cp.cfg.expand = 'ask';
    r = drive(cp, st);
    assert.strictEqual(r.sent.length + toasts.length, 0, 'no toast while materials are short');
    // other modules' finite reserves count against the stock too
    cp.cfg.expand = 'auto';
    const st2 = corp();
    r = drive(cp, st2, { ctx: { reserveItems: { [I('Glass')]: 90 } } });
    assert.strictEqual(r.sent.length, 0);
    assert.ok(/20 Glass \(have 100, 90 kept by other modules\)/.test(r.wait), r.wait);
  });

  await F.t('off pauses a run in progress (acres and store materials stay held); back to auto it goes on', () => {
    fresh();
    const st = corp();
    drive(cp, st, { stopAt: (sent) => sent[sent.length - 1].type === 'BuyLand' });
    cp.cfg.expand = 'off';
    const r = drive(cp, st);
    assert.strictEqual(r.sent.length, 0);
    assert.ok(/^expand: PAUSED \(cfg.expand is "off"\)/.test(r.wait), r.wait);
    assert.strictEqual(globalThis.idleCore.acreHolds?.[1], 60);
    assert.ok(globalThis.idleCore.reserves.merged()?.by?.coreExpand, 'store materials still kept');
    cp.cfg.expand = 'auto';
    assert.deepStrictEqual(drive(cp, st, { n: 1 }).sent.map((m) => m.type), ['TransferStock']);
  });

  await F.t('cancel() in auto: expand turns to ask, the region stays this director\'s, and the next offer finishes it (not a $3M Coastal charter)', () => {
    fresh();
    const st = corp();
    drive(cp, st, { stopAt: (sent) => sent[sent.length - 1].type === 'BuyLand' });
    assert.ok(/expand is "ask"/.test(cp._expand.cancel()));
    assert.strictEqual(cp.cfg.expand, 'ask');
    assert.ok(memOf('expand').get().regions[1].cancelled);
    assert.deepStrictEqual(globalThis.idleCore.acreHolds, {});
    const r = drive(cp, st);
    assert.strictEqual(r.sent.length, 0);
    assert.ok(/^expand: offer: Industrial Basin charter 1 -> 1: courier/.test(r.wait), r.wait);
    cp.cfg.expand = 'auto';
  });

  await F.t('Go binds to the offer shown: a changed offer asks again (new toast); a Go survives a reload', () => {
    fresh();
    cp.cfg.expand = 'ask';
    const toasts = [];
    globalThis.idleCore.toast = (t, o) => toasts.push([t, o]);
    const st = corp();
    drive(cp, st);
    const shown = memOf('expand').get().offer;
    memOf('expand').set({ go: { ...shown, cost: Math.round(shown.cost / 1.1) } });   // pressed on an offer 10% cheaper
    let r = drive(cp, st, { n: 1 });
    assert.strictEqual(r.sent.length, 0);
    assert.ok(/offer changed after Go/.test(memOf('expand').get().goMiss), memOf('expand').get().goMiss);
    assert.strictEqual(toasts.length, 2, 'asked again');
    toasts[1][1].action.run();
    assert.deepStrictEqual(memOf('expand').get().go, shown);
    cp = loadExpand(); cp.cfg.expand = 'ask';
    globalThis.idleCore.toast = () => {};
    r = drive(cp, st, { n: 1 });
    assert.deepStrictEqual(r.sent.map((m) => m.type), ['BuyCharter']);
    cp.cfg.expand = 'auto';
  });

  await F.t('off and dry run: nothing starts', () => {
    fresh();
    cp.cfg.expand = 'off';
    assert.ok(/off \(cfg.expand\)/.test(drive(cp, corp()).wait));
    cp.cfg.expand = 'auto';
    const r = drive(cp, corp(), { ctx: { live: false } });
    assert.strictEqual(r.sent.length, 0);
    assert.ok(/dry run: would start Industrial Basin/.test(r.wait), r.wait);
    assert.ok(!memOf('expand').get().run);
  });

  await F.t('auto: the whole sequence in order, the acres held and the store materials kept back while it runs, released at the end', () => {
    fresh();
    const st = corp();
    let held = null, kept = null, picked = null;
    const r = drive(cp, st, { n: 80, stopAt: (sent) => {
      if (sent[sent.length - 1].type === 'BuyLand') {
        held = globalThis.idleCore.acreHolds?.[1];
        kept = globalThis.idleCore.reserves.merged()?.by?.coreExpand?.items ?? null;
        picked = globalThis.idleCore.planner.pickRegion({ st, catalog: cat });   // Industrial Basin has 60 free acres, Heartland 3
      }
      return false;
    } });
    assert.deepStrictEqual(types(r.sent), ['BuyCharter', 'BuyLand', 'TransferStock', 'TransferStock', 'TransferStock', 'TransferStock',
      'BuyBuilding:Workshop', 'BuyBuilding:Lumber Camp', 'BuyBuilding:Sawmill', 'SetSubscription', 'CreateGroup:Workshop', 'SetRecipe',
      'CreateGroup:Lumber Camp', 'SetRecipe', 'CreateGroup:Sawmill', 'SetRecipe', 'TransferStock', 'TransferStock', 'TransferStock',
      'BuyBuilding:Retail Store', 'CreateGroup:Retail Store', 'SetAssortment'], r.wait);
    assert.strictEqual(held, 60, 'Industrial Basin acres held from BuyLand');
    assert.strictEqual(picked, 0, 'CD Farm Auto region skips the held region');
    assert.deepStrictEqual(kept, { [I('Iron Frame')]: 6, [I('Concrete')]: 20, [I('Glass')]: 20 }, 'store materials kept in Heartland');
    assert.strictEqual(r.sent.find((m) => m.type === 'SetSubscription').level, 5);
    assert.ok(r.sent.filter((m) => m.type === 'TransferStock').every((m) => m.from === 0 && m.to === 1 && m.courier === true));
    const mm = memOf('expand').get();
    assert.ok(!mm.run && mm.regions[1].level === 1, JSON.stringify(mm));
    assert.deepStrictEqual(globalThis.idleCore.acreHolds, {});
    assert.ok(!globalThis.idleCore.reserves.merged()?.by?.coreExpand, 'reserve released');
    // C2: the region's shelves follow what it makes, also after the run
    const sg = Object.values(st.groups).find((g) => g.region === 1 && g.building === B('Retail Store'));
    assert.deepStrictEqual(sg.assortment, [I('Bookshelf')]);
    sg.assortment = [];
    const again = drive(cp, st, { n: 1 });
    assert.deepStrictEqual(again.sent.map((m) => m.type), ['SetAssortment']);
  });

  await F.t('resume after reload: mid-shipping the modules load again and go on from the state (no second charter, land or shipment)', () => {
    fresh();
    const st = corp();
    const a = drive(cp, st, { stopAt: (sent) => sent.filter((m) => m.type === 'TransferStock').length === 2 });
    assert.deepStrictEqual(a.sent.map((m) => m.type), ['BuyCharter', 'BuyLand', 'TransferStock', 'TransferStock']);
    // the third send went out, then the page reloaded before its confirm was saved
    const run = memOf('expand').get().run, third = Object.keys(run.ship).find((i) => !run.shipped[i]);
    apply(st, { type: 'TransferStock', from: 0, to: 1, item: +third, amount: run.ship[third], courier: true });
    cp = loadExpand();
    cp.cfg.expand = 'auto';
    assert.strictEqual(globalThis.idleCore.acreHolds?.[1], 60, 'the hold is back from storage at load');
    const b = drive(cp, st, { n: 80 });
    assert.strictEqual(b.sent.filter((m) => m.type === 'BuyCharter' || m.type === 'BuyLand').length, 0);
    assert.strictEqual(b.sent.filter((m) => m.type === 'TransferStock' && m.item === +third).length, 0, 'the in-flight shipment counts as sent');
    assert.deepStrictEqual(types(b.sent).slice(0, 2), ['TransferStock', 'BuyBuilding:Workshop']);
    assert.ok(memOf('expand').get().regions?.[1], 'finished');
  });

  await F.t('abort on mismatch: a step the state never shows stops the run (no resend), reported in the readout; reset() retries from the state', () => {
    fresh();
    const st = corp();
    const r = drive(cp, st, { drop: ['BuyLand'] });
    assert.deepStrictEqual(r.sent.map((m) => m.type), ['BuyCharter', 'BuyLand']);
    assert.ok(/^expand: STOPPED: buy 60 acres .*sent 1x/.test(r.wait), r.wait);
    assert.ok(/sent 1x/.test(r.out.readouts.expand.alert));
    assert.strictEqual(drive(cp, st).sent.length, 0, 'still stopped');
    assert.ok(!globalThis.idleCore.reserves.merged()?.by?.coreExpand, 'a stopped run frees the store materials');
    assert.strictEqual(globalThis.idleCore.acreHolds?.[1], 60, '... and keeps its acres');
    assert.ok(/resumes/.test(cp._expand.reset()));
    assert.ok(globalThis.idleCore.reserves.merged()?.by?.coreExpand, 'reset() holds them again');
    assert.deepStrictEqual(drive(cp, st, { n: 1 }).sent.map((m) => m.type), ['BuyLand']);
  });

  await F.t('abort on mismatch: a dropped TransferStock (busy courier) is sent twice, then the run stops', () => {
    fresh();
    const st = corp();
    const r = drive(cp, st, { drop: ['TransferStock'] });
    assert.deepStrictEqual(r.sent.map((m) => m.type), ['BuyCharter', 'BuyLand', 'TransferStock', 'TransferStock']);
    assert.ok(/STOPPED: ship .*sent 2x/.test(r.wait), r.wait);
    assert.ok(/dropped/.test(cp._expand.cancel()));
    assert.ok(!memOf('expand').get().run);
  });

  await F.t('abort on mismatch, live Core plan on the fake socket (it drops BuyCharter): one send, then STOPPED; no resend while Core plan keeps stepping', async () => {
    fresh();
    const { w } = F.boot(corp(), { modules: MODS, retail: FX.retail, catalog: cat });
    evalSrc();
    const live = globalThis.corePlan;
    Object.assign(live.cfg, { expand: 'auto', dir_buildout: false, dir_retail: false, unlocks: false, land: false, confirmMs: 150, intervalMs: 30 });
    live.start({ dryRun: false });
    assert.ok(await F.waitFor(() => (live.status().waits ?? []).some((x) => /^expand: STOPPED: charter level 1/.test(x)), 5000), JSON.stringify(live.status().waits));
    await F.sleep(300);
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'BuyCharter').length, 1, JSON.stringify(w.ws.sent.map((m) => m.type)));
    assert.ok(live.running, 'one unconfirmed send does not stop Core plan');
    live.stop();
    F.unload(); globalThis.localStorage = disk;
    cp = loadExpand(); cp.cfg.expand = 'auto';
  });

  await F.t('C2: after the run (58 of 60 acres used, no block fits) Industrial Basin is offered charter level 2 (same payback rule) against Coastal Cities; the better payback wins', () => {
    fresh();
    const st = corp();
    drive(cp, st, { n: 80 });
    const v = cp._view(st, cat, []), ctx = ctxFor();
    cp._decide(v, ctx);
    assert.ok(cp._expand.offerFor(v, ctx, 1, 1).r == null, 'level 1 adds nothing more');
    const o = cp._expand.offerFor(v, ctx, 1, 2), c = cp._expand.offerFor(v, ctx, 2, 1);
    assert.strictEqual(o.level, 2);
    assert.ok(/charter 1 -> 2: charter \$3,000,000 \+ 90 acres/.test(o.line), o.line);
    assert.ok(o.add.ws >= 4 && o.add.stores === 0, o.line);
    const t = cp._expand.trigger(v, ctx, { 1: { level: 1 } });
    assert.strictEqual(t.offer.r, o.payback <= c.payback ? 1 : 2, t.offer.line + ' vs ' + c.line);
    assert.strictEqual(cp._expand.trigger(v, ctx, {}).offer.r, 2, 'a region this director did not open is not upgraded');
  });

  await F.t('power with Auto utilities on: never a SetSubscription; it asks Auto utilities and waits for free MW before Workshops and the store join', () => {
    fresh();
    const st = corp(), asks = [];
    let free = 0;
    const au = { conf: { power: { on: true } }, _measure: () => ({ free }), ask: (...a) => asks.push(a) };
    let r = drive(cp, st, { n: 80, ctx: { mods: { autoUtil: au } } });
    assert.ok(!r.sent.some((m) => m.type === 'SetSubscription'), 'the region has no grid: Auto utilities raises it on the ask');
    assert.ok(/waits for 3 MW free power in Industrial Basin/.test(r.wait), r.wait);
    assert.deepStrictEqual(asks.map((a) => a.slice(0, 3)), [['power', 1, 3]]);
    assert.ok(!r.sent.some((m) => m.type === 'CreateGroup'));
    free = 3;
    r = drive(cp, st, { n: 80, ctx: { mods: { autoUtil: au } }, stopAt: (sent) => sent[sent.length - 1].type === 'BuyBuilding' && sent[sent.length - 1].building === B('Retail Store') });
    assert.strictEqual(r.sent.filter((m) => m.type === 'SetSubscription').length, 0, 'no fight with Auto utilities over the level');
    free = 1;   // the Workshops draw now
    r = drive(cp, st, { n: 80, ctx: { mods: { autoUtil: au } } });
    assert.ok(/waits for 2 MW free power/.test(r.wait), 'the store waits for its 2 MW: ' + r.wait);
    free = 2;
    r = drive(cp, st, { n: 80, ctx: { mods: { autoUtil: au } } });
    assert.deepStrictEqual(r.sent.map((m) => m.type), ['CreateGroup', 'SetAssortment']);
  });

  await F.t('CD Farm reservation: pickRegion skips a held region on Auto, keeps a fixed choice, and Heartland is never skipped', () => {
    const P = globalThis.idleCore.planner;
    const st = { land_bought: { 0: 0, 1: 40 }, groups: {}, building_pool: {} };
    globalThis.idleCore.acreHolds = { 1: 60 };
    assert.strictEqual(P.pickRegion({ st, catalog: cat }), 0);
    assert.strictEqual(P.pickRegion({ st, catalog: cat, choice: 1 }), 1);
    globalThis.idleCore.acreHolds = {};
    assert.strictEqual(P.pickRegion({ st, catalog: cat }), 1);
  });

  F.done();
})();
