// Headless checks for the CD farm planner (src/planner.js): CD, price ladders, items, the greedy plan, gates, land.
//   bun test/planner-test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'live-board.json'), 'utf8'));
const slice = (files, name) => {
  const s = [].concat(files).map((file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8')).join('\n');
  return s.slice(s.indexOf('// @@MODULE ' + name), s.indexOf('// @@END ' + name));
};
(0, eval)(slice(['core-1.js', 'core-2.js', 'core-form.js', 'core-3.js'], 'core') + '\n' + slice('planner.js', 'planner'));
const P = globalThis.idleCore.planner;

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
}
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

const C = deepFreeze(P.normalize(board.catalog));
const id = (name) => Object.values(C.buildings).find((b) => b.name === name).id;
const item = (name) => Object.values(C.items).find((i) => i.name === name).id;
const CAMP = 0, FARM = 10, MINE = id('Mine'), WF = item('Wooden Frame');
const base = (over = {}) => ({
  catalog: C, unlocked: [], owned: {}, usableAcres: 50, money: 1e9, floor: 0, stock: {}, reserve: {},
  netSupply: {}, burn: {}, itemValue: {}, quarantine: {}, R: Infinity, T: 60, I: 0, ...over
});
const unitsOf = (r) => Object.fromEntries(r.units.map((u) => [u.b, u.n]));
const total = (r) => r.units.reduce((a, u) => a + u.n, 0);

t('cdOf matches the live catalog', () => {
  const want = { 'Lumber Camp': 1, Farm: 1, Mine: 8, Well: 4, 'Oil Rig': 24, Smelter: 12, 'Data Center': 256 };
  for (const [name, cd] of Object.entries(want)) assert.strictEqual(P.cdOf(C, id(name)), cd, name);
  assert.strictEqual(P.cdOf(board.catalog, C.buildings[MINE]), 8, 'raw catalog and building object');
});

t('normalize keys by id and passes a normalized catalog through', () => {
  assert.strictEqual(P.normalize(C), C);
  assert.strictEqual(P.normalize(board.catalog).buildings[MINE].name, 'Mine');
});

t('price / batchCost reproduce the wiki batch table', () => {
  assert.strictEqual(P.price(4100, 0, 0), 4100);
  assert.strictEqual(P.price(4100, 4, 0), 4920);
  const perCd = (n) => (P.batchCost(4100, 0, n) - n * 2050) / n / 100;
  assert.ok(Math.abs(perCd(8) - 27.7) <= 0.05, 'batch 8 ' + perCd(8));
  assert.ok(Math.abs(perCd(16) - 35.9) <= 0.05, 'batch 16 ' + perCd(16));
});

t('acrePrice / landCost: acre 26 costs the first price, then floor(prev x 41/40)', () => {
  assert.strictEqual(P.acrePrice(5000, 0), 5000);
  assert.strictEqual(P.acrePrice(5000, 1), 5125);
  assert.strictEqual(P.acrePrice(5000, 2), Math.floor(5125 * 41 / 40));
  assert.strictEqual(P.landCost(5000, 1, 2), 5125 + Math.floor(5125 * 41 / 40));
});

t('plan: I = 0 stops at minUnits; huge I fills a cap', () => {
  const r = P.plan(deepFreeze(base({ minUnits: 4 })));
  assert.strictEqual(total(r), 4);
  assert.strictEqual(r.binding, 'time');
  // Camp and Farm share a base, so equalising alternates them (2 + 2); one type needs maxTypes 1.
  assert.deepStrictEqual(unitsOf(r), { [CAMP]: 2, [FARM]: 2 });
  const one = P.plan(deepFreeze(base({ minUnits: 4, maxTypes: 1 })));
  assert.deepStrictEqual(unitsOf(one), { [CAMP]: 4 });
  const acres = P.plan(deepFreeze(base({ I: 1e12, usableAcres: 12, T: 1000 })));   // a long cycle, so the demolish queue never binds
  assert.strictEqual(total(acres), 12);
  assert.strictEqual(acres.binding, 'acres');
  const batch = P.plan(deepFreeze(base({ I: 1e12, usableAcres: 500, maxBatch: 30, T: 1000 })));
  assert.strictEqual(total(batch), 30);
  assert.strictEqual(batch.binding, 'batch');
});

t('plan equalises marginal cost: 4 Farms owned -> Camp first', () => {
  const r = P.plan(deepFreeze(base({ owned: { [FARM]: 4 } })));
  assert.deepStrictEqual(unitsOf(r), { [CAMP]: 1 });
  const r5 = P.plan(deepFreeze(base({ owned: { [FARM]: 4 }, minUnits: 5 })));
  assert.deepStrictEqual(unitsOf(r5), { [CAMP]: 5 }, 'the 5th Camp ties the 5th Farm at 4920; ties break by id');
});

t('plan: Mine wins only with free Wooden Frames in surplus', () => {
  const stock = { [WF]: 100 };
  const free = P.plan(deepFreeze(base({ unlocked: [MINE], stock, minUnits: 2 })));
  assert.strictEqual(free.units[0].b, MINE);
  const valued = P.plan(deepFreeze(base({ unlocked: [MINE], stock, itemValue: { [WF]: C.items[WF].base_value }, minUnits: 2 })));
  assert.ok(!valued.units.some((u) => u.b === MINE), 'priced frames make Mines dear');
  assert.strictEqual(valued.candidates.find((c) => c.b === MINE).matCents, 4 * C.items[WF].base_value);
  const short = P.plan(deepFreeze(base({ unlocked: [MINE], stock: { [WF]: 10 }, reserve: { [WF]: 8 } })));
  assert.strictEqual(short.candidates.find((c) => c.b === MINE).dropped, 'item:' + WF + ':short');
  const drain = P.plan(deepFreeze(base({ unlocked: [MINE], stock: { [WF]: 10 }, netSupply: { [WF]: -1 }, burn: { [WF]: 4 } })));
  assert.strictEqual(drain.candidates.find((c) => c.b === MINE).dropped, 'item:' + WF + ':draining');
  const okDrain = P.plan(deepFreeze(base({ unlocked: [MINE], stock: { [WF]: 20 }, netSupply: { [WF]: -1 }, burn: { [WF]: 4 } })));
  assert.strictEqual(okDrain.candidates.find((c) => c.b === MINE).dropped, null, '16 left covers 2 h of burn 4');
  const capped = P.plan(deepFreeze(base({ unlocked: [MINE], quarantine: { [CAMP]: true, [FARM]: true }, stock: { [WF]: 10 }, I: 1e12 })));
  assert.deepStrictEqual(unitsOf(capped), { [MINE]: 2 });
  assert.strictEqual(capped.binding, 'items');
  assert.strictEqual(P.candidates(deepFreeze(base())).find((c) => c.b === CAMP).dropped, null, 'starters never drop for items');
});

t('plan: the money floor binds on GROSS cost', () => {
  const r = P.plan(deepFreeze(base({ quarantine: { [FARM]: true }, I: 1e12, floor: 100000, money: 100000 + 4100 + 4304 })));
  assert.deepStrictEqual(unitsOf(r), { [CAMP]: 1 });
  assert.strictEqual(r.binding, 'money');
  assert.strictEqual(r.grossCents, 4100);
  assert.strictEqual(r.netCents, 2050);
  const r2 = P.plan(deepFreeze(base({ quarantine: { [FARM]: true }, I: 1e12, floor: 100000, money: 100000 + 4100 + 4305 })));
  assert.strictEqual(total(r2), 2);
});

t('plan never plans past R', () => {
  const r = P.plan(deepFreeze(base({ R: 3, I: 1e12 })));
  assert.strictEqual(r.cdTotal, 3);
  assert.strictEqual(r.binding, 'target');
  const m = P.plan(deepFreeze(base({ R: 3, I: 1e12, unlocked: [MINE], stock: { [WF]: 100 } })));
  assert.ok(m.cdTotal < 3 + 8, 'one unit past at most: ' + m.cdTotal);
});

t('plan: acres cap counts each type\'s acres', () => {
  const r = P.plan(deepFreeze(base({ unlocked: [MINE], stock: { [WF]: 400 }, quarantine: { [CAMP]: true, [FARM]: true }, usableAcres: 7, I: 1e12 })));
  assert.deepStrictEqual(unitsOf(r), { [MINE]: 3 });
  assert.strictEqual(r.binding, 'acres');
});

t('plan: wait reasons when nothing can be built', () => {
  const money = P.plan(deepFreeze(base({ floor: 100000, money: 102000 })));
  assert.deepStrictEqual(money.wait, { gate: 'G5', reason: 'need $21.00 more above the floor', shortfallCents: 2100 });
  assert.strictEqual(money.binding, 'money');
  const acres = P.plan(deepFreeze(base({ usableAcres: 0 })));
  assert.deepStrictEqual(acres.wait, { gate: 'G5', reason: 'no free acres above the spare' });
  const items = P.plan(deepFreeze(base({ unlocked: [MINE], quarantine: { [CAMP]: true, [FARM]: true } })));
  assert.strictEqual(items.binding, 'items');
  assert.ok(/Mine needs Wooden Frame \(short\)/.test(items.wait.reason), items.wait.reason);
  assert.strictEqual(P.plan(deepFreeze(base())).wait, null);
});

t('gates G2 / G3 / G4', () => {
  assert.deepStrictEqual(P.gates({ need: 10, cd: 10 }), { run: false, gate: 'G2', reason: 'no CD needed' });
  assert.strictEqual(P.gates({ cd: 0 }).gate, 'G2');
  assert.deepStrictEqual(P.gates({ need: 100, cd: 0, prereqsMet: false, prereqNote: 'the prototype' }),
    { run: false, gate: 'G3', reason: 'waiting on the prototype, cash is better spent there' });
  assert.deepStrictEqual(P.gates({ need: 100, cd: 40, prereqsMet: true, organicCdPerHour: 20 }),
    { run: false, gate: 'G4', reason: 'organic CD will cover it in 3.0 h' });
  assert.deepStrictEqual(P.gates({ need: 1000, cd: 0, prereqsMet: true, organicCdPerHour: 20 }), { run: true });
  assert.deepStrictEqual(P.gates({ need: 1000, cd: 0, prereqsMet: true, organicCdPerHour: null }), { run: true });
});

t('land: off notes the saving, plan mode buys only inside the plan and when it pays, wall and floor hold', () => {
  const farm = { cdTotal: 10, grossCents: 50000, binding: 'acres' };
  const L = (over) => P.land(deepFreeze({
    allow: 'plan', landBought: 0, firstAcre: 5000, wall: 1e9, hoursUntilBought: () => 1, paybackHours: 10,
    plan: farm, unitNeed: { cd: 1, unitCost: 2050, acres: 1 }, R: 1000, T: 60, I: 100000, money: 1e7, floor: 0, usableAcres: 0, ...over
  }));
  const off = L({ allow: 'off' });
  assert.strictEqual(off.buy, 0);
  assert.ok(/^\d more acres? would save [\d.]+ h for \$[\d.]+$/.test(off.note), off.note);
  const on = L({});
  assert.ok(on.buy > 0, 'buys inside the plan');
  assert.ok(on.savingCents > on.realCostCents);
  assert.strictEqual(L({ hoursUntilBought: () => Infinity }).buy, 0, 'outside the plan');
  assert.strictEqual(L({ I: 10 }).buy, 0, 'saving below real cost');
  assert.strictEqual(L({ wall: 4999 }).buy, 0, 'over the wall');
  assert.strictEqual(L({ money: 50000 + 5000 - 1 }).buy, 0, 'floor plus the plan\'s gross');
  assert.strictEqual(L({ allow: 5000, hoursUntilBought: () => Infinity }).buy, 1, 'a cents cap allows acres up to it');
  assert.strictEqual(L({ plan: { ...farm, cdTotal: 0 } }).buy, 0, 'no plan yet');
  const notCap = L({ plan: { ...farm, binding: 'money' } });
  assert.strictEqual(notCap.buy, 0, 'acres not the cap');
  assert.ok(/would save .* \(acres are not the cap\)$/.test(notCap.note), notCap.note);
});

t('signature is order independent and tracks Retail and running recipes', () => {
  const a = P.signature({ unlocked: [3, 1, 2], running: [7, 5], retail: false, bids: [9, 4], phase: 'mid' });
  const b = P.signature({ unlocked: [1, 2, 3], running: [5, 7], retail: false, bids: [4, 9], phase: 'mid' });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, P.signature({ unlocked: [1, 2, 3], running: [5, 7], retail: true, bids: [4, 9], phase: 'mid' }));
  assert.notStrictEqual(a, P.signature({ unlocked: [1, 2, 3], running: [5, 7, 8], retail: false, bids: [4, 9], phase: 'mid' }));
});

t('plan: a new type that is not worth its extra step does not end the plan; the next unit of an existing type is tried', () => {
  // Mine is cheapest per CD, then Farm (new type, 20.5/CD) beats Mine from its 5th unit on. A step costing 1e6 s makes Farm never worth it.
  const r = P.plan(deepFreeze(base({ unlocked: [MINE], owned: { [CAMP]: 100 }, stock: { [WF]: 1000 }, I: 1e9, R: 500, T: 200, TperType: 1e6, maxBatch: 10 })));
  assert.deepStrictEqual(unitsOf(r), { [MINE]: 10 }, JSON.stringify(unitsOf(r)));
});

t('itemValues: bid, in-use base value, max of both', () => {
  const v = P.itemValues(deepFreeze({ catalog: C, stock: {}, bids: { [WF]: 50000, 1: 50 }, runningInputs: [1, 2] }));
  assert.strictEqual(v[WF], 50000);
  assert.strictEqual(v[1], 100, 'in-use base beats a low bid');
  assert.strictEqual(v[2], C.items[2].base_value);
  assert.strictEqual(v[item('Iron Frame')], 0);
});

t('surplus / itemOk', () => {
  assert.deepStrictEqual(P.surplus({ stock: { 1: 10, 2: 3 }, reserve: { 2: 5 } }), { 1: 10, 2: 0 });
  assert.deepStrictEqual(P.itemOk({ need: 4, stock: 10, reserve: 2 }), { ok: true, reason: null });
  assert.strictEqual(P.itemOk({ need: 4, stock: 10, reserve: 2, netSupply: -1, burn: 3 }).ok, false);
  assert.strictEqual(P.itemOk({ need: 4, stock: 10, reserve: 2, netSupply: 0, burn: 3 }).ok, true);
});

t('determinism: same input twice -> same output, inputs untouched', () => {
  const input = deepFreeze(base({ unlocked: [MINE, id('Well')], stock: { [WF]: 50 }, owned: { [CAMP]: 2 }, I: 5e6, T: 90, TperType: 30, R: 500 }));
  const a = P.plan(input), b = P.plan(input);
  assert.deepStrictEqual(a, b);
  assert.ok(a.units.length > 0);
});

// ---- Core plan: CD Farm Auto against the wiki's Farm ladder (§11.4) and the Wooden Frame guard ------------------
const ladder = (over = {}) => base({
  unlocked: [MINE, id('Quarry')], owned: { [CAMP]: 112, [FARM]: 0, [MINE]: 10, [id('Quarry')]: 4 }, usableAcres: 60,
  I: 1e12, R: 755000, T: 6, minUnits: 1, maxBatch: 16, maxTypes: 1, stock: { [WF]: 5000 }, ...over
});
const perCdDollars = (r) => r.perCdCents / 100;

t('Auto planner: Thrifty (I = 0) runs the Farm ladder one at a time at $20.50 per CD', () => {
  // The wiki batch table (27.7 at 8, 35.9 at 16) assumes instant cycles. A Farm takes 10 s to demolish, so a batch of 8
  // holds the queue for 80 s for the same CD per second as one Farm: at I = 0 the planner keeps one, the cheapest cash per CD.
  for (const batch of [1, 8, 16]) {
    const r = P.plan(deepFreeze(ladder({ maxBatch: batch, I: 0 })));
    assert.deepStrictEqual(unitsOf(r), { [FARM]: 1 }, 'maxBatch ' + batch);
    assert.ok(Math.abs(perCdDollars(r) - 20.5) <= 0.05, 'costs ' + perCdDollars(r));
  }
});

t('Auto planner: Fast (time is worth a lot) picks a frame building over the queue-bound Farm', () => {
  // Ten Mines are owned, so a Mine costs $31 per CD against the Farm's $20.50, but a Mine makes 8 CD per 14 s of queue and a Farm 1 per 10 s.
  const r = P.plan(deepFreeze(ladder({ maxBatch: 8 })));
  assert.ok(Object.keys(unitsOf(r)).some((b) => Number(b) !== FARM && Number(b) !== CAMP), JSON.stringify(unitsOf(r)));   // Mine or Quarry: 8 CD per 14 s of queue
});

t('queue: a demolish backlog that outlasts the cycle waits instead of queueing more', () => {
  const r = P.plan(deepFreeze(ladder({ queue: { build: 0, demolish: 30 }, T: 6 })));   // 30 s left: longer than a Farm or Quarry cycle
  assert.strictEqual(total(r), 0, JSON.stringify(unitsOf(r)));
  assert.ok(r.wait && /demolish queue/.test(r.wait.reason), JSON.stringify(r.wait));
});

t('rush: with the queue deep, a Mine is demolished at once for ceil(CD/2) CD, and that CD is netted', () => {
  const r = P.plan(deepFreeze(base({ unlocked: [MINE], stock: { [WF]: 1000 }, queue: { build: 0, demolish: 30 }, T: 6, cdHave: 100, I: 1e12, R: 100, maxBatch: 3 })));
  const m = r.units.find((u) => u.b === MINE);
  assert.ok(m && m.rush >= 1, JSON.stringify(r.units));
  assert.strictEqual(r.rushCd, m.rush * 4, 'a Mine rush costs 4 CD');
  assert.strictEqual(r.cdTotal, r.cdGross - r.rushCd, 'net CD');
});

t('rush: no rush when the stock cannot cover it, so the plan waits for the queue', () => {
  const r = P.plan(deepFreeze(base({ unlocked: [MINE], stock: { [WF]: 1000 }, queue: { build: 0, demolish: 30 }, T: 6, cdHave: 3, I: 1e12 })));
  assert.strictEqual(total(r), 0, JSON.stringify(unitsOf(r)));
  assert.ok(r.wait && /demolish queue/.test(r.wait.reason));
});

t('rush: at Thrifty (I = 0) with frames in surplus, a deep queue waits and never rushes, however much CD is in stock', () => {
  const r = P.plan(deepFreeze(base({ unlocked: [MINE], stock: { [WF]: 1000 }, queue: { build: 0, demolish: 30 }, T: 6, cdHave: 1000, I: 0, R: 100, maxBatch: 3 })));
  assert.strictEqual(r.rushCd, 0, JSON.stringify(r.units));
  assert.ok(!r.units.some((u) => u.rush > 0), JSON.stringify(r.units));
});

t('Auto planner: with Wooden Frames valued (a Rivet run eats them) the plan stays on Farm, one type', () => {
  const iv = P.itemValues({ catalog: C, bids: {}, runningInputs: [WF] });
  assert.ok(iv[WF] > 0);
  const r = P.plan(deepFreeze(ladder({ itemValue: { [WF]: iv[WF] }, maxTypes: 2, I: 0 })));
  assert.deepStrictEqual(unitsOf(r), { [FARM]: 1 });
});

t('Auto planner: Wooden Frames worth nothing (nothing consumes them) pull in Quarry/Mine unless the item is reserved', () => {
  // This is the post-Retail behaviour Core plan has to guard: it reserves the frames instead of letting the farm burn them.
  const loose = P.plan(deepFreeze(ladder({ itemValue: { [WF]: 0 }, maxTypes: 2 })));
  assert.ok(Object.keys(unitsOf(loose)).some((b) => Number(b) !== FARM), 'frames are free: ' + JSON.stringify(unitsOf(loose)));
  assert.ok(perCdDollars(loose) < 35.9, 'cheaper per CD only because the frames cost nothing');
  const guarded = P.plan(deepFreeze(ladder({ itemValue: { [WF]: 0 }, maxTypes: 2, reserve: { [WF]: Infinity } })));
  assert.deepStrictEqual(unitsOf(guarded), { [FARM]: 1 }, 'reserved frames are not spent');
  assert.ok(guarded.notes.some((n) => /skipped: item:/.test(n)), guarded.notes.join(' | '));
});

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
