// Headless checks for the retail allocator (src/core-retail-alloc.js, scripts/retail-optimizer-plan.md B1/B2). Each case names its binding constraint.
//   bun test/retail-alloc-test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'core-retail-alloc.js'), 'utf8');
globalThis.idleCore = {};
(0, eval)(s.slice(s.indexOf('// @@MODULE retail-alloc'), s.indexOf('// @@END retail-alloc')));
const retailAlloc = globalThis.idleCore.retailAlloc;

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': got ' + a + ', want ' + b + ' (+-' + tol + ')');

// Live-like goods at board price 160%, q0: unit = floor(base x 1.6 x 0.95). 5 runs/wave floors.
const furniture = (cur = {}) => [
  { id: 'Bookshelf', name: 'Bookshelf', unitCents: 88160, planksPerUnit: 30, unitsPerWorkshopHour: 30, demandPerHour: 7080, current: cur.Bookshelf ?? 0, floorOk: true },
  { id: 'Table', name: 'Table', unitCents: 72960, planksPerUnit: 25, unitsPerWorkshopHour: 30, demandPerHour: 8520, current: cur.Table ?? 0, floorOk: true },
  { id: 'Chair', name: 'Chair', unitCents: 44080, planksPerUnit: 15, unitsPerWorkshopHour: 37.5, demandPerHour: 14160, current: cur.Chair ?? 0, floorOk: true },
];
const run = (o) => retailAlloc({ goods: furniture(), supply: { Planks: 1e6 }, stock: {}, reserve: {}, workshops: { owned: 0, buildable: 0 }, stores: { Heartland: 1 }, ...o });
const planksUsed = (r, goods) => goods.reduce((a, g) => a + r.alloc[g.id] * g.unitsPerWorkshopHour * g.planksPerUnit, 0);

t('unit price formula and $/Workshop-h match the plan ($26.4k Bookshelf)', () => {
  assert.strictEqual(Math.floor(58000 * 16000 / 10000 * (0.95 + 0.19 * 0 / 10)), 88160);
  const r = run({ workshops: { owned: 1, buildable: 0 } });
  near(r.dollarsPerHour, 26448, 0.01, 'Bookshelf $/Workshop-h');
});

t('workshops bind: planks plentiful, W=19 -> all 19 on Bookshelf', () => {
  const r = run({ workshops: { owned: 10, buildable: 9 } });
  assert.deepStrictEqual(r.alloc, { Bookshelf: 19, Table: 0, Chair: 0 });
  assert.strictEqual(r.binding, 'workshops');
  assert.deepStrictEqual(r.bindings, ['workshops'], 'demand 7,080/h is far above 19 x 30/h: not named as binding');
  assert.deepStrictEqual(r.shelves, ['Bookshelf']);
  assert.deepStrictEqual(r.moves, [{ from: 'pool', to: 'Bookshelf', n: 19 }]);
  near(r.dollarsPerHour, 19 * 26448, 0.01, '$/h');
});

t('curSlack: a current assignment up to the slack over its Planks budget is kept (no churn on a wobbling budget); past it, it moves', () => {
  const goods = furniture({ Bookshelf: 15 });                          // 13,500 Planks/h
  const at = (planks, slack) => run({ goods, supply: { Planks: planks }, workshops: { owned: 20, buildable: 0 }, cfg: { curSlack: { Planks: slack } } });
  assert.deepStrictEqual(at(13480, 0).alloc.Bookshelf, 14, 'strict: 20 over, one Workshop off');
  assert.deepStrictEqual(at(13480, 900).alloc, { Bookshelf: 15, Table: 0, Chair: 0 });
  assert.deepStrictEqual(at(13480, 900).moves, []);
  assert.deepStrictEqual(at(12500, 900).alloc.Bookshelf < 15, true, '1,000 over: past one Workshop of use, it moves');
});

t('planks bind: 13,560/h, W=40 -> planks used up, ties per plank, near-tie current kept, spare reported', () => {
  const goods = furniture({ Bookshelf: 12, Table: 2, Chair: 2 });   // 13,425 planks/h, 1.1% under the plan
  const r = run({ goods, supply: { Planks: 13560 }, workshops: { owned: 40, buildable: 0 } });
  assert.strictEqual(r.binding, 'planks');
  near(r.lpDollarsPerHour, 13560 * 88160 / 30 / 100, 0.01, 'LP $/h = planks x Bookshelf cents/plank');
  assert.deepStrictEqual(r.alloc, { Bookshelf: 12, Table: 2, Chair: 2 });
  assert.deepStrictEqual(r.moves, []);
  assert.strictEqual(r.spareWorkshops, 24);
  assert.ok(planksUsed(r, goods) <= 13560);
  // The task's literal current {16, 2, 1} needs 16,462.5 planks/h > 13,560: infeasible, so it moves to the plan.
  const lit = run({ goods: furniture({ Bookshelf: 16, Table: 2, Chair: 1 }), supply: { Planks: 13560 }, workshops: { owned: 40, buildable: 0 } });
  assert.deepStrictEqual(lit.alloc, { Bookshelf: 15, Table: 0, Chair: 0 });   // fewer Workshops on a per-plank tie: 13,500 planks/h
  assert.ok(lit.moves.length > 0);
  assert.strictEqual(lit.spareWorkshops, 25);
  assert.strictEqual(lit.binding, 'planks');
});

t('planks bind with a stock budget: 122k stock, 2k reserve over 24 h adds 5,000/h -> more Workshops', () => {
  const base = run({ supply: { Planks: 13560 }, workshops: { owned: 40, buildable: 0 } });
  const r = run({ supply: { Planks: 13560 }, stock: { Planks: 122000 }, reserve: { Planks: 2000 }, workshops: { owned: 40, buildable: 0 } });
  near(r.budget.Planks, 18560, 1e-9, 'planks budget');
  const n = (x) => Object.values(x.alloc).reduce((a, b) => a + b, 0);
  assert.ok(n(r) > n(base), n(r) + ' Workshops with stock vs ' + n(base) + ' without');
  assert.deepStrictEqual(r.alloc, { Bookshelf: 20, Table: 0, Chair: 0 });
  assert.strictEqual(r.binding, 'planks');
});

t('demand binds for one good: Bookshelf 100/h, W=10 -> 3 Bookshelf (floor of 3.33), 7 Table', () => {
  const goods = furniture(); goods[0].demandPerHour = 100;
  const r = run({ goods, workshops: { owned: 10, buildable: 0 } });
  assert.deepStrictEqual(r.alloc, { Bookshelf: 3, Table: 7, Chair: 0 });
  assert.ok(r.bindings.includes('demand'), r.bindings.join());
  assert.deepStrictEqual(r.shelves, ['Bookshelf', 'Table']);
});

t('stores bind: Beer output meets 1,825,800/h demand with 1 store -> 6 stores', () => {
  const beer = (uph) => [{ id: 'Beer', name: 'Beer', unitCents: 1672, inputs: { Malt: 1 }, unitsPerWorkshopHour: uph, demandPerHour: 1825800, current: 0, floorOk: true }];
  const r = run({ goods: beer(912900), supply: { Malt: 1e9 }, workshops: { owned: 2, buildable: 0 } });
  assert.deepStrictEqual(r.alloc, { Beer: 2 });
  assert.deepStrictEqual(r.storesNeeded, { Heartland: 6 });
  assert.strictEqual(r.binding, 'stores');
  assert.ok(/need 6 in Heartland, have 1/.test(r.detail), r.detail);
  // Task's literal uph 1e6: a 2nd Workshop would exceed demand, so 1 Workshop sells 1e6/h -> 3 stores.
  const lit = run({ goods: beer(1e6), supply: { Malt: 1e9 }, workshops: { owned: 2, buildable: 0 } });
  assert.deepStrictEqual(lit.alloc, { Beer: 1 });
  assert.deepStrictEqual(lit.storesNeeded, { Heartland: 3 });
  assert.strictEqual(lit.binding, 'stores');
});

t('money binds: owned 2, buildable 0 -> 2 Workshops, readout names buildable=0', () => {
  const r = run({ workshops: { owned: 2, buildable: 0 } });
  assert.deepStrictEqual(r.alloc, { Bookshelf: 2, Table: 0, Chair: 0 });
  assert.strictEqual(r.binding, 'money');
  assert.ok(/buildable=0/.test(r.detail), r.detail);
});

t('no floor -> nothing allocated, binding none; maxShelves caps the goods used', () => {
  const goods = furniture().map((g) => ({ ...g, floorOk: false }));
  const r = run({ goods, workshops: { owned: 5, buildable: 0 } });
  assert.deepStrictEqual(r.alloc, { Bookshelf: 0, Table: 0, Chair: 0 });
  assert.strictEqual(r.binding, 'none');
  const two = run({ goods: furniture().map((g) => ({ ...g, demandPerHour: 60 })), workshops: { owned: 9, buildable: 0 }, cfg: { maxShelves: 2 } });
  assert.deepStrictEqual(two.alloc, { Bookshelf: 2, Table: 2, Chair: 0 });
});

t('a junk good (no floor, uph 0, no demand) does not break rounding or hysteresis', () => {
  const junk = { id: 'Desk', name: 'Desk', unitCents: 90000, unitsPerWorkshopHour: 0, floorOk: false };
  const kept = run({ goods: [...furniture({ Bookshelf: 12, Table: 2, Chair: 2 }), junk], supply: { Planks: 13560 }, workshops: { owned: 40, buildable: 0 } });
  assert.deepStrictEqual(kept.moves, []);
  assert.ok(Number.isFinite(kept.dollarsPerHour));
  const goods = furniture(); goods[0].demandPerHour = 100;
  const r = run({ goods: [...goods, junk], workshops: { owned: 10, buildable: 0 } });
  assert.deepStrictEqual(r.alloc, { Bookshelf: 3, Table: 7, Chair: 0, Desk: 0 });   // the leftover Workshop is still placed
});

t('10 goods, 4 shelves: subset search finishes fast and matches the LP on the chosen goods', () => {
  const goods = Array.from({ length: 10 }, (_, k) => ({ id: 'g' + k, name: 'g' + k, unitCents: 20000 + 7919 * k % 50000, planksPerUnit: 5 + 3 * k % 20, unitsPerWorkshopHour: 10 + 13 * k % 40, demandPerHour: 300 + 97 * k % 500, floorOk: true }));
  const inp = { goods, supply: { Planks: 1e7 }, workshops: { owned: 200, buildable: 0 }, stores: { R: 4 } };   // demand-limited: the full LP wants all 10
  const t0 = performance.now(), r = retailAlloc(inp), ms = performance.now() - t0;
  assert.ok(ms < 500, ms + ' ms');
  const chosen = goods.filter((g) => r.alloc[g.id] > 0);
  assert.ok(chosen.length <= 4 && chosen.length > 0);
  const only = retailAlloc({ ...inp, goods: goods.map((g) => ({ ...g, floorOk: chosen.includes(g) })) });
  assert.ok(r.lpDollarsPerHour >= only.lpDollarsPerHour - 1e-6, r.lpDollarsPerHour + ' < ' + only.lpDollarsPerHour);
  const unc = retailAlloc({ ...inp, cfg: { maxShelves: 10 } });
  assert.ok(Object.values(unc.alloc).filter((v) => v > 0).length > 4 && unc.lpDollarsPerHour >= r.lpDollarsPerHour - 1e-6);
});

// ---- property: integer rounding never breaks a limit, and never beats the LP or the integer optimum ---------
t('200 seeded random cases: integer plan feasible, <= best integer plan <= LP', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  for (let c = 0; c < 200; c++) {
    const n = ri(1, 3), items = ['Planks', 'Iron'];
    const goods = Array.from({ length: n }, (_, k) => ({
      id: 'g' + k, name: 'g' + k, unitCents: ri(1000, 100000), unitsPerWorkshopHour: ri(1, 60), demandPerHour: ri(0, 400), floorOk: rnd() < 0.85,
      inputs: Object.fromEntries(items.filter(() => rnd() < 0.7).map((i) => [i, ri(1, 40)])), current: ri(0, 3),
    }));
    const inp = {
      goods, supply: { Planks: ri(0, 8000), Iron: ri(0, 3000) }, stock: { Planks: ri(0, 50000) }, reserve: { Planks: ri(0, 20000) },
      workshops: { owned: ri(0, 6), buildable: ri(0, 3) }, stores: { R: ri(0, 2) }, cfg: { maxShelves: ri(1, 4), moveGainPct: 3 },
    };
    const r = retailAlloc(inp);
    const W = inp.workshops.owned + inp.workshops.buildable, x = goods.map((g) => r.alloc[g.id]);
    const ok = (xs) => xs.reduce((a, b) => a + b, 0) <= W && xs.filter((v) => v > 0).length <= inp.cfg.maxShelves
      && goods.every((g, k) => (!xs[k] || g.floorOk) && xs[k] * g.unitsPerWorkshopHour <= g.demandPerHour + 1e-6)
      && items.every((i) => goods.reduce((a, g, k) => a + xs[k] * g.unitsPerWorkshopHour * (g.inputs[i] ?? 0), 0) <= (r.budget[i] ?? 0) + 1e-6);
    const val = (xs) => goods.reduce((a, g, k) => a + g.unitCents * xs[k] * g.unitsPerWorkshopHour, 0) / 100;
    const where = 'case ' + c + ' ' + JSON.stringify(inp) + ' -> ' + JSON.stringify(r.alloc);
    assert.ok(x.every((v) => Number.isInteger(v) && v >= 0), 'non-integer ' + where);
    assert.ok(ok(x), 'infeasible ' + where);
    let best = 0;
    const walk = (k, xs) => { if (k === n) { if (ok(xs)) best = Math.max(best, val(xs)); return; } for (let v = 0; v <= W; v++) walk(k + 1, [...xs, v]); };
    walk(0, []);
    assert.ok(val(x) <= best + 1e-6, 'beats the integer optimum ' + where);
    assert.ok(best <= r.lpDollarsPerHour + 1e-6 * Math.max(1, best), 'LP below integer optimum ' + best + ' > ' + r.lpDollarsPerHour + ' ' + where);
    near(r.dollarsPerHour, val(x), 1e-6, 'dollarsPerHour ' + where);
  }
});

console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
