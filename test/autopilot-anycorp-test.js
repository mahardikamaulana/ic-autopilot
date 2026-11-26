// Autopilot on any corp, not only the author's: hand-off, land payback, mine sizing, buy prices, building cost counting, ids by name.
//   bun test/autopilot-anycorp-test.js     (reads the built ic-autopilot.user.js: run bun build.js first)
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const full = fs.readFileSync(path.join(__dirname, '..', 'ic-autopilot.user.js'), 'utf8');
const slice = (m) => full.slice(full.indexOf('// @@MODULE ' + m), full.indexOf('// @@END ' + m));
const src = slice('core') + '\n' + slice('planner') + '\n' + full.slice(full.indexOf('// @@MODULE early-game'));
const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'live-board.json'), 'utf8'));
const floor = JSON.parse(fs.readFileSync(path.join(__dirname, 'floor-state.json'), 'utf8'));
board.catalog.machines = floor.machines; board.catalog.belts = floor.belts;

function load() {
  globalThis.earlyGame = undefined; globalThis.idleCore?._unload?.(); globalThis.idleCore = undefined;
  (0, eval)(src);
  return globalThis.earlyGame;
}
const ap = load(), k = ap._core;
const C = k.normalize(board.catalog);
const bid = (name) => C.items[Object.values(C.items).find((i) => i.name === name).id];
const B = (n) => Object.values(C.buildings).find((b) => b.name === n).id;
const R = (n) => Object.values(C.recipes).find((r) => r.name === n).id;
const I = (n) => bid(n).id;
const deals = board.deals.filter((d) => d.region === 0);
const base = () => ({
  ssi: { corp_id: 1, last_user_mutation_tick: 0 }, items: { 0: 10000000, [I('Construction Data')]: 0 }, stock: { 0: {} }, groups: {},
  building_pool: { 0: {} }, research: null, unlocked_buildings: [], shipments: [], courier_ready_at: 0, subscriptions: { 0: { power: 0 } },
  standing_fills: {}, land_bought: { 0: 0 }, layouts: {}, designs: {}, exchange: { 0: {} }, auto_deliver: [],
});
const snap = (st, d = deals, o = []) => k.snapshot(st, C, d, o, 1);
let n = 0, failed = 0;
const t = (name, fn) => { n++; try { fn(); console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + e.message); } };

t('hand-off: plan unlocks in + core buildings exist → done, without Frame Timber, Rivet or 16 Iron Frames', () => {
  const st = base();
  st.unlocked_buildings = ['Sawmill', 'Workshop', 'Mine', 'Quarry', 'Smelter', 'Factory', 'Kiln', 'Paper Mill', 'Manufacturing Lab'].map(B);
  st.building_pool[0] = { [B('Sawmill')]: 1, [B('Workshop')]: 1, [B('Mine')]: 1, [B('Quarry')]: 1, [B('Kiln')]: 1, [B('Manufacturing Lab')]: 1 };
  assert.strictEqual(k.phaseOf(snap(st)), 'done');
  delete st.building_pool[0][B('Manufacturing Lab')];
  assert.notStrictEqual(k.phaseOf(snap(st)), 'done', 'no Lab: not done');
  st.building_pool[0][B('Manufacturing Lab')] = 1;
  st.unlocked_buildings = st.unlocked_buildings.filter((b) => b !== B('Paper Mill'));
  assert.notStrictEqual(k.phaseOf(snap(st)), 'done', 'a plan unlock missing: not done');
});

t('mine sizing follows the Smelter at the floor rates (4/2 at equal rates)', () => {
  const st = base();
  const s1 = snap(st);
  assert.strictEqual(k.mineTarget(s1, R('Mine Iron Ore')), 4); assert.strictEqual(k.mineTarget(s1, R('Mine Coal')), 2);
  st.layouts = { [R('Mine Iron Ore')]: { fx: { rate: 3 } }, [R('Mine Coal')]: { fx: { rate: 3 } }, [R('Roll Iron Sheet')]: { fx: { rate: 3 } } };
  assert.strictEqual(k.mineTarget(snap(st), R('Mine Iron Ore')), 4, 'x3 / x3');
  delete st.layouts[R('Roll Iron Sheet')];
  assert.strictEqual(k.mineTarget(snap(st), R('Mine Iron Ore')), 2, 'x3 mines, x1 Smelter');
  assert.strictEqual(k.mineTarget(snap(st), R('Mine Coal')), 1);
  ap.cfg.ironMines = 3;
  assert.strictEqual(k.mineTarget(snap(st), R('Mine Iron Ore')), 3, 'cfg is the minimum');
  ap.cfg.ironMines = 1;
});

t('Gold Mines: Infinity means auto, a finite target while a plan unlock is open', () => {
  assert.strictEqual(ap.cfg.goldMines, Infinity);
  const st = base();
  assert.ok(Number.isFinite(k.goldTarget(snap(st))) && k.goldTarget(snap(st)) > 0);
  ap.cfg.goldMines = 3; assert.strictEqual(k.goldTarget(snap(st)), 3); ap.cfg.goldMines = Infinity;
});

t('building cost counts every region and the build / demolish queues; queued builds count as owned here and hold acres', () => {
  const st = base(), camp = B('Lumber Camp');
  const cost0 = k.buildCost(snap(st), camp);
  st.groups = { 5: { building: camp, count: 4, equipped: 4, recipe: R('Fell Wood'), region: 1, name: 'IB camps' } };
  st.building_pool[2] = { [camp]: 2 };
  st.construction = { builds: [{ building: camp, count: 3, region: 0 }], demolitions: [{ building: camp, count: 1, region: 1 }] };
  const s = snap(st);
  assert.strictEqual(k.buildCost(s, camp), Math.round(C.buildings[camp].cost * (20 + 4 + 2 + 3 + 1) / 20));
  assert.ok(k.buildCost(s, camp) > cost0);
  assert.strictEqual(s.owned(camp), 3, 'Heartland: the 3 queued builds');
  assert.strictEqual(s.acresUsed, 3 * C.buildings[camp].acres, 'queued Heartland builds hold their acres; the IB demolition does not');
  // A BuyBuilding is confirmed by a queued build, not only a finished one.
  const a = k.buildSteps({ ...s, freeAcres: 5 }, camp, 'test', Infinity);
  assert.strictEqual(a.steps[0].msg.type, 'BuyBuilding');
  st.construction.builds[0].count = 4;
  assert.ok(a.steps[0].until(snap(st)));
});

t('land: payback from live income allows land above the wall; no bid → the wall; the 360-acre cap holds', () => {
  const st = base(), camp = B('Lumber Camp');
  st.land_bought[0] = 100;   // next acre ≈ $590
  st.building_pool[0] = { [camp]: 125 };
  const s = snap(st);
  assert.strictEqual(s.freeAcres, 0);
  ap.cfg.landPaybackHours = 2;
  const inc = k.incomePerMin(s, R('Fell Wood'));
  assert.ok(inc > 0, 'Wood has a bid');
  const wall = k.buildSteps(s, camp, 'camp', 500, R('Fell Wood'), true);   // $590 > $500 wall, but pays back in time
  const h = (590 * 100 + k.buildCost(s, camp)) / inc / 60;
  assert.strictEqual(!!wall.steps, h <= 2, JSON.stringify(wall.wait ?? wall.reason) + ' h=' + h.toFixed(2));
  ap.cfg.landPaybackHours = 0;
  assert.ok(k.buildSteps(s, camp, 'camp', 500, R('Fell Wood'), true).wall, 'payback off: the wall');
  const noBid = snap(st, []);
  assert.strictEqual(k.incomePerMin(noBid, R('Fell Wood')), 0);
  assert.ok(k.buildSteps(noBid, camp, 'camp', 500, R('Fell Wood'), true).wall, 'no bid: the wall');
  ap.cfg.landPaybackHours = 1000;
  assert.ok(k.buildSteps(s, camp, 'camp', 500, R('Fell Wood')).steps, 'payback-only rule');
  st.land_bought[0] = 335;
  st.building_pool[0] = { [camp]: 360 };
  assert.match(k.buildSteps(snap(st), camp, 'camp', Infinity).wait, /360-acre cap/);
  ap.cfg.landPaybackHours = 2;
});

t('buy prices: a multiple of base value; small lots add up', () => {
  const st = base(), s = snap(st);
  const wood = I('Wood'), frame = I('Wooden Frame');
  assert.strictEqual(k.priceCents(s, frame, ap.cfg.buyOrderMult), Math.round(C.items[frame].base_value * 1.5));
  assert.strictEqual(k.priceCents(s, wood, 1.5), 150);
  const orders = [{ id: 1, side: 'Sell', item: wood, amount: 30, unit_price: 90, region: 0, poster: 7 }, { id: 2, side: 'Sell', item: wood, amount: 500, unit_price: 95, region: 0, poster: 7 }];
  const offers = k.sellersOf(snap(st, [], orders), wood, 100);
  assert.deepStrictEqual(offers.map((o) => [o.key, o.n, o.msg.amount]), [['order:1', 30, 30], ['order:2', 100, 100]]);
});

t('ids by name: a renumbered catalog resolves, missing names are reported by checkGame', () => {
  const raw = JSON.parse(JSON.stringify(board.catalog));
  const saw = raw.buildings.find((b) => b.name === 'Sawmill');
  saw.id = 990;
  for (const tch of raw.techs) if (tch.building === 4) tch.building = 990;
  for (const r of raw.recipes) if (r.building === 4) r.building = 990;
  raw.recipes = raw.recipes.filter((r) => r.name !== 'Mix Concrete');
  const st = base();
  st.unlocked_buildings = [990];
  st.building_pool[0] = { 990: 2 };
  const s = k.snapshot(st, raw, deals, [], 1);
  assert.strictEqual(s.owned(990), 2);
  assert.ok(k.checklist(s).some(([kk, v]) => kk === 'Sawmills' && /^✓? ?2 \//.test(v.replace('· ', ''))), JSON.stringify(k.checklist(s).find(([kk]) => kk === 'Sawmills')));
  assert.ok(k.checkGame(s).some((x) => /Mix Concrete/.test(x)), JSON.stringify(k.checkGame(s)));
  // The live catalog resolves everything.
  const live = snap(base());
  assert.deepStrictEqual(k.checkGame(live), []);
});

console.log(failed ? `\n${failed} of ${n} failed` : `\nall ${n} passed`);
process.exit(failed ? 1 : 0);
