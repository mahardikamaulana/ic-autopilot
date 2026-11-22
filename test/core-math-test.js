// Headless checks for the Core Game Plan math (src/core-math.js) against the spec script scripts/core-plan/my-plan.js.
//   bun test/core-math-test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const PLAN = path.join(ROOT, '..', 'scripts', 'core-plan');
const state = JSON.parse(fs.readFileSync(path.join(PLAN, 'state-example.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(PLAN, 'catalog-2026-11-22.json'), 'utf8'));

const slice = (file, name) => {
  const s = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
  return s.slice(s.indexOf('// @@MODULE ' + name), s.indexOf('// @@END ' + name));
};
globalThis.idleCore = {};
(0, eval)(slice('core-math.js', 'core-math'));
const CM = globalThis.idleCore.coreMath;

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': got ' + a + ', want ' + b + ' (+-' + tol + ')');
const num = (s) => +s.replace(/,/g, '');

// ---- the real spec: run my-plan.js and parse what it prints ---------------------------------------------
function runSpec(args = []) {
  const out = Bun.spawnSync(['bun', path.join(PLAN, 'my-plan.js'), ...args]).stdout.toString();
  const m = (re) => { const x = out.match(re); if (!x) throw new Error('spec output did not match ' + re + '\n' + out); return x; };
  const N = '([\\d,]+(?:\\.\\d+)?)';
  const land = m(new RegExp('engine income \\$' + N + '/h -> Farm ladder batch (\\d+) at \\$' + N + '/CD, ' + N + ' CD/h -> T_wall ' + N + ' h -> buy acres while payback <= ' + N + ' h'));
  const last = m(/last acre inside the rule: #(\d+)/);
  const more = out.match(/\(([\d,]+) more acres, \$([\d,]+)\)/);
  const eng = m(new RegExp('engine: ' + N + ' planks/h = (\\d+) Camps, (\\d+) Sawmills, (\\d+) Workshops \\((\\d+) Bookshelf, (\\d+) Table, (\\d+) Chair'));
  const rev = m(new RegExp('revenue at retail ~\\$' + N + '/h; building cost from your counts ~\\$' + N + ' \\+ land \\$' + N));
  const need = m(/you still need: (\d+) Camps, (\d+) Sawmills, (\d+) Workshops/);
  const tgt = m(new RegExp('owned acres target ' + N + ' = engine ' + N + ' \\+ fixed ' + N + ' \\+ buffer (\\d+)'));
  return {
    income: num(land[1]), batch: +land[2], perCd: num(land[3]), cdH: num(land[4]), tWall: num(land[5]), limit: num(land[6]),
    lastAcre: +last[1], acresToBuy: more ? num(more[1]) : 0, landCost: more ? num(more[2]) : 0,
    planksH: num(eng[1]), camps: +eng[2], sawmills: +eng[3], workshops: +eng[4], bookshelf: +eng[5], table: +eng[6], chair: +eng[7],
    revenueH: num(rev[1]), buildingCost: num(rev[2]), needCamps: +need[1], needSaws: +need[2], needWs: +need[3],
    targetAcres: num(tgt[1]), engineAcres: num(tgt[2]), fixed: num(tgt[3]),
  };
}

function matchSpec(spec, r) {
  near(r.lastAcre, spec.lastAcre, 0, 'last acre');
  near(r.tWall, spec.tWall, 0.05, 'T_wall');
  near(r.limitHours, spec.limit, 0.05, 'payback limit');
  near(r.income, spec.income, 1, 'income');
  assert.strictEqual(r.batch, spec.batch, 'batch');
  near(r.perCd, spec.perCd, 0.05, '$/CD');
  near(r.cdPerHour, spec.cdH, 0.5, 'CD/h');
  near(r.planksH, spec.planksH, 0.5, 'planks/h');
  assert.strictEqual(r.camps, spec.camps, 'camps');
  assert.strictEqual(r.sawmills, spec.sawmills, 'sawmills');
  assert.strictEqual(r.workshops.total, spec.workshops, 'workshops');
  assert.deepStrictEqual([r.workshops.bookshelf, r.workshops.table, r.workshops.chair], [spec.bookshelf, spec.table, spec.chair], 'furniture split');
  assert.strictEqual(r.need.camps, spec.needCamps, 'need camps');
  assert.strictEqual(r.need.sawmills, spec.needSaws, 'need sawmills');
  assert.strictEqual(r.need.workshops, spec.needWs, 'need workshops');
  near(r.landCost, spec.landCost, 1, 'land cost');
  assert.strictEqual(r.acresToBuy, spec.acresToBuy, 'acres to buy');
  near(r.buildingCost, spec.buildingCost, 1, 'building cost');
  near(r.revenueH, spec.revenueH, 1, 'revenue/h');
  near(r.targetAcres, spec.targetAcres, 0.5, 'target acres');
  near(r.engineAcres, spec.engineAcres, 0.5, 'engine acres');
  near(r.fixedAcres, spec.fixed, 0, 'fixed acres');
}

const spec = runSpec();

t('spec sanity: the parsed my-plan.js numbers are the wiki example', () => {
  assert.strictEqual(spec.lastAcre, 293);
  assert.strictEqual(spec.batch, 16);
  near(spec.tWall, 78.6, 0.05, 'T_wall');
  assert.deepStrictEqual([spec.camps, spec.sawmills, spec.workshops], [112, 101, 20]);
});

t('landRule matches my-plan.js on state-example + catalog (raw client arrays)', () => {
  matchSpec(spec, CM.landRule(state, catalog));
});

t('landRule matches my-plan.js with a different state (fewer acres, more buildings)', () => {
  const alt = { ...state, acres: 150, acrePrice: 1000, camps: 120, sawmills: 40, workshops: 9, fixedAcres: 30 };
  const f = path.join(__dirname, '.core-math-alt-state.json');
  fs.writeFileSync(f, JSON.stringify(alt));
  try { matchSpec(runSpec([f, path.join(PLAN, 'catalog-2026-11-22.json')]), CM.landRule(alt, catalog)); }
  finally { fs.unlinkSync(f); }
});

t('bestBatch reproduces the wiki CD ladder table', () => {
  for (const [income, k, perCd] of [[150000, 8, 27.7], [350000, 16, 35.9], [600000, 23, 43.0]]) {
    const b = CM.bestBatch('farm', 0, income, 600);
    assert.strictEqual(b.k, k, 'batch at ' + income);
    near(b.perCd, perCd, 0.05, '$/CD at ' + income);
    near(b.cdH, 600 * k, 0, 'CD/h at ' + income);
  }
  near(CM.batchCost('farm', 70, 8) / 8, 171.2, 0.05, 'farm owned 70 batch 8');
  near(CM.batchCost('dock', 0, 8) / 8, 121.3, 0.05, 'dock batch 8');
});

t('acrePrice: first price, then floor-to-cent of prev x 41/40', () => {
  assert.strictEqual(CM.acrePrice(2287.97, 0), 2287.97);
  assert.strictEqual(CM.acrePrice(2287.97, 1), Math.floor(2287.97 * 100 * 41 / 40) / 100);
});

t('engineModel: wiki constants, works on unkeyed arrays and id-keyed objects', () => {
  const m = CM.engineModel(catalog);
  near(m.campWoodH, 1080, 0, 'camp wood/h');
  near(m.smPlanksH, 120, 0, 'sawmill planks/h');
  near(m.woodPerPlank, 10, 0, 'wood per plank');
  assert.strictEqual(m.furn.length, 3);
  near(m.perPlank, 29.3, 0.1, '$/plank');
  const keyed = { items: Object.fromEntries(catalog.items.map((i) => [i.id, i])), recipes: Object.fromEntries(catalog.recipes.map((r) => [r.id, r])) };
  near(CM.engineModel(keyed).perPlank, m.perPlank, 1e-9, 'id-keyed catalog');
  assert.throws(() => CM.engineModel({ items: [], recipes: [] }), /Fell Wood/);
});

t('opts.cyclesPerHour overrides state.cyclesPerHour: 300 cycles/h raises T_wall (bigger batch partly compensates)', () => {
  const base = CM.landRule(state, catalog);
  const slow = CM.landRule(state, catalog, { cyclesPerHour: 300 });
  const same = CM.landRule({ ...state, cyclesPerHour: 300 }, catalog);
  near(slow.tWall, same.tWall, 1e-9, 'opts vs state');
  const ratio = slow.tWall / base.tWall;
  // Half the cycles/h lets the ladder afford a bigger batch (income / cycles), so CD/h falls by less than half: 9,600 -> 7,800.
  assert.ok(ratio > 1.1 && ratio < 2.1, 'T_wall ratio ' + ratio);
  assert.strictEqual(slow.batch, 26);
  near(slow.cdPerHour, 7800, 0.5, 'CD/h at 300 cycles/h');
  assert.ok(slow.lastAcre >= base.lastAcre, 'a longer T_wall widens the payback limit, so the last acre never moves down');
  assert.strictEqual(CM.landRule(state, catalog, {}).tWall, base.tWall);
});

t('edge: already past the last acre -> acresToBuy 0, no land cost, nothing to build', () => {
  const r = CM.landRule({ ...state, acres: 400, acrePrice: 90000 }, catalog);
  assert.strictEqual(r.acresToBuy, 0);
  assert.strictEqual(r.landCost, 0);
  assert.ok(r.targetAcres >= 400);
  const rich = CM.landRule({ ...state, camps: 500, sawmills: 500, workshops: 500 }, catalog);
  assert.deepStrictEqual(rich.need, { camps: 0, sawmills: 0, workshops: 0 });
  assert.strictEqual(rich.buildingCost, 0);
});

t('edge: missing optional state fields use the spec defaults (600 cycles/h, buffer 16, fixed 0)', () => {
  const { cyclesPerHour, cdBufferAcres, fixedAcres, ...lean } = state;
  const r = CM.landRule(lean, catalog);
  assert.strictEqual(r.bufferAcres, 16);
  assert.strictEqual(r.fixedAcres, 8);
  assert.ok(Number.isFinite(r.tWall) && r.tWall > 0);
});

t('fixedExtra: acres of the Retail Store / Assembly Plant not built yet replace the default 8', () => {
  assert.strictEqual(CM.landRule({ ...state, fixedExtra: 5 }, catalog).fixedAcres, state.fixedAcres + 5);
  assert.strictEqual(CM.landRule({ ...state, fixedExtra: 0 }, catalog).fixedAcres, state.fixedAcres);
});

t('determinism and no input mutation', () => {
  const s = JSON.stringify(state), c = JSON.stringify(catalog);
  const a = CM.landRule(state, catalog), b = CM.landRule(state, catalog);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(JSON.stringify(state), s);
  assert.strictEqual(JSON.stringify(catalog), c);
});

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
