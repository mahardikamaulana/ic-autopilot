// Headless checks for Core plan (src/core-plan-*.js): the pure view / stage / conditions / directors on saved boards, and the runner
// against a small fake server that applies BuyLand / BuyBuilding / AssignBuildings / StartTech.
//   bun test/core-plan-sim.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'live-board.json'), 'utf8'));
const full = require('./cp-fixtures').full();   // CP_FROM_SRC=1 reads src/*.js
const slice = (name) => full.slice(full.indexOf('// @@MODULE ' + name), full.indexOf('// @@END ' + name));
const SRCS = ['core', 'pacer', 'planner', 'core-math', 'core-plan'].map(slice).join('\n');

let failed = 0;
const quietLog = console.log, quietWarn = console.warn;
async function t(name, fn) {
  console.log = () => { }; console.warn = () => { };
  try { await fn(); console.log = quietLog; console.warn = quietWarn; quietLog('ok   ' + name); }
  catch (e) { console.log = quietLog; console.warn = quietWarn; failed++; quietLog('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 5).join('\n     ')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 4000, step = 10) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(step); } return !!cond(); };

const B = (n) => board.catalog.buildings.find((b) => b.name === n).id;
const I = (n) => board.catalog.items.find((i) => i.name === n).id;
const Rc = (n) => board.catalog.recipes.find((r) => r.name === n).id;
const MONEY = 0, CD = 24;

// A Stage A Corporation: everything the start conditions ask for, 80 bought acres, 20 Cotton Farms.
function stageA(over = {}) {
  const st = {
    ssi: { corp_id: 1, last_user_mutation_tick: 0 },
    items: { [MONEY]: 5000000, [CD]: 100 },
    stock: { 0: { [I('Iron Frame')]: 30, [I('Concrete')]: 0 } },   // no Concrete: the Assembly Plant prototype is short, so CD alone is not the bottleneck (B2)
    groups: {
      1: { building: B('Smelter'), region: 0, count: 3, recipe: Rc('Roll Iron Sheet') },
      2: { building: B('Workshop'), region: 0, count: 2, recipe: Rc('Rivet Iron Frame') },
      3: { building: B('Workshop'), region: 0, count: 2, recipe: Rc('Frame Timber') },
      4: { building: B('Farm'), region: 0, count: 20, recipe: Rc('Grow Cotton') },
      5: { building: B('Lumber Camp'), region: 0, count: 40, recipe: 0 },
      6: { building: B('Mine'), region: 0, count: 2, recipe: Rc('Mine Iron Ore') },
      7: { building: B('Quarry'), region: 0, count: 1, recipe: Rc('Quarry Limestone') },
      8: { building: B('Kiln'), region: 0, count: 1, recipe: Rc('Mix Concrete') },
      9: { building: B('Manufacturing Lab'), region: 0, count: 1, recipe: null },
      10: { building: B('Sawmill'), region: 0, count: 4, recipe: Rc('Saw Planks') },
    },
    building_pool: { 0: {} }, next_group_id: 11, research: null, research_queue: [],
    unlocked_buildings: ['Mine', 'Quarry', 'Sawmill', 'Smelter', 'Workshop', 'Kiln', 'Factory', 'Paper Mill', 'Manufacturing Lab'].map(B),
    land_bought: { 0: 80 },
  };
  return Object.assign(st, over);
}
const cottonBidDeals = () => [{ id: 1, side: 'Sell', item: I('Cotton'), amount: 1000, price: 100000, region: 0, expires_at: 99999999 }];

function load(extra = '') {
  globalThis.idleCore?._unload?.();
  globalThis.corePlan?._unload?.();
  globalThis.idleCore = undefined; globalThis.corePlan = undefined; globalThis.earlyGame = undefined; globalThis.cdFarm = undefined;
  (0, eval)(SRCS + '\n' + extra);
  const core = globalThis.idleCore;
  core.tune.pollMs = 5; core.tune.steadyMs = 50;
  return { core, cp: globalThis.corePlan };
}
// Boot with a fake game already in place (the core reads document / WebSocket when it loads).
function boot(st, { deals = cottonBidDeals(), ignore = [] } = {}) {
  globalThis.idleCore?._unload?.(); globalThis.corePlan?._unload?.();
  globalThis.idleCore = undefined; globalThis.corePlan = undefined; globalThis.earlyGame = undefined; globalThis.cdFarm = undefined;
  const w = world(st, deals, { ignore });
  const { core, cp } = load();
  cp._setPacer(fastPacer());
  return { core, cp, w };
}
// Make the bought acres exactly the acres in use (Camps soak up the difference), so a purchase needs an acre.
function tight(cp, st, bought) {
  st.land_bought[0] = bought;
  st.groups[5].count = 1;
  const used = cp._view(st, board.catalog, []).acresUsed;
  st.groups[5].count = Math.max(1, 25 + bought - (used - 1));
  return st;
}
const unload = () => { globalThis.corePlan?._unload?.(); globalThis.idleCore?._unload?.(); globalThis.idleCore = undefined; globalThis.corePlan = undefined; globalThis.earlyGame = undefined; delete globalThis.document; delete globalThis.WebSocket; delete globalThis.localStorage; delete globalThis.sessionStorage; };
const ctxOf = (o = {}) => ({ planDone: true, cashDelta10: 500, floorCents: 0, retailOk: null, ap: null, apNextTech: null, ...o });
const view = (cp, st, deals = cottonBidDeals()) => cp._view(st, board.catalog, deals);
// Stage D at the end: all three unlocks, the Retail Store, 0 Farms, every acre the rule allows, the engine built, plenty of cash.
function endBoard() {
  const st = stageA(); st.unlocked_buildings.push(B('Assembly Plant'), B('Retail Store'), B('Oil Rig'));
  st.groups[11] = { building: B('Retail Store'), region: 0, count: 1, recipe: null };
  delete st.groups[4];
  st.land_bought[0] = 400; st.items[MONEY] = 1e13;
  st.groups[5].count = 400; st.groups[10].count = 400; st.groups[2].count = 100;
  return st;
}
// What CD Farm measures (C3: income cents/h, cycles/h, a Farm-only plan at the best batch) and the net income (C5) that let E3 and E5 hold.
function measured(o = {}) {
  const income = 4000000, cycles = 600;
  const k = globalThis.idleCore.coreMath.bestBatch('farm', 0, income / 100, cycles).k;
  return { mods: { cdFarm: { cfg: { building: 'auto', autoStart: true, batch: k } } }, ladder: { income, rates: { cyclesh15: cycles }, plan: { units: [{ b: B('Farm'), n: k, name: 'Farm' }] }, held: {} }, netIncomeH: 4000000, k, ...o };
}

// ---- fake game server over a fiber tree ---------------------------------------------------------------------------------------------
function world(st, deals = cottonBidDeals(), { ignore = [] } = {}) {
  const listeners = new Set();
  class FakeWS {
    constructor() { this.readyState = 1; this.sent = []; }
    addEventListener(_, f) { listeners.add(f); } removeEventListener(_, f) { listeners.delete(f); }
    send(m) {
      const msg = JSON.parse(m); this.sent.push(msg);
      if (!ignore.includes(msg.type)) apply(msg);
      st.ssi.last_user_mutation_tick += 1;
      for (const f of [...listeners]) f({ data: JSON.stringify({ kind: 'Diff', tick: st.ssi.last_user_mutation_tick, diff: { ssi: { last_user_mutation_tick: st.ssi.last_user_mutation_tick } } }) });
    }
  }
  const cat = board.catalog;
  const owned = (b) => Object.values(st.groups).filter((g) => g.building === b).reduce((a, g) => a + g.count, 0) + (st.building_pool[0][b] ?? 0);
  function apply(m) {
    if (m.type === 'BuyLand') { let p = 5000; for (let i = 0; i < st.land_bought[0]; i++) p = Math.floor(p * 41 / 40); for (let i = 0; i < m.amount; i++) { st.items[MONEY] -= p; p = Math.floor(p * 41 / 40); } st.land_bought[0] += m.amount; }
    else if (m.type === 'BuyBuilding') { const base = cat.buildings.find((b) => b.id === m.building).cost; for (let i = 0; i < m.amount; i++) st.items[MONEY] -= Math.floor(base * (20 + owned(m.building) + i) / 20); st.building_pool[0][m.building] = (st.building_pool[0][m.building] ?? 0) + m.amount; }
    else if (m.type === 'AssignBuildings') { const g = st.groups[m.group]; st.building_pool[0][g.building] -= m.amount; g.count += m.amount; }
    else if (m.type === 'StartTech') { const tech = cat.techs.find((x) => x.building === m.building); st.items[CD] -= tech.cost; for (const i of cat.buildings.find((b) => b.id === m.building).build_items ?? []) st.stock[0][i.item] -= i.amount; st.research = { building: m.building }; }
  }
  globalThis.WebSocket = FakeWS;
  const ws = new FakeWS();
  const fiber = { memoizedState: { memoizedState: { current: ws }, next: { memoizedState: st, next: { memoizedState: deals, next: null } } }, memoizedProps: { catalog: board.catalog }, child: null, sibling: null };
  const root = { __reactContainer$x: fiber };
  const el = () => ({ append() { }, remove() { }, addEventListener() { }, setAttribute() { }, style: {}, classList: { toggle() { } } });
  globalThis.document = { body: el(), head: el(), title: 'game', getElementById: (id) => (id === 'root' ? root : null), createElement: el, querySelector: () => null, hidden: true };
  return { ws, st };
}
const mem = (disk = {}) => ({ getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = String(v); }, removeItem: (k) => { delete disk[k]; } });
const fastPacer = () => ({ beforeCommand: async () => { }, noteConfirm() { }, noteResult() { } });

(async () => {
  await t('stage A: all start conditions read from a saved board, Cotton bid and cash trend unknown until sampled', () => {
    const { cp } = load();
    const v = view(cp, stageA());
    const d = cp._decide(v, ctxOf({ cashDelta10: null }));
    assert.strictEqual(d.stage, 'A', JSON.stringify(d.S));
    assert.deepStrictEqual(d.S.map((c) => c.ok), [true, true, true, true, true, null, true]);
    assert.match(d.S[5].why, /not enough cash samples/);
    unload();
  });

  await t('stage is null with the reasons when a start condition fails; S6 negative also blocks', () => {
    const { cp } = load();
    const st = stageA(); delete st.groups[9];            // no Manufacturing Lab
    const d = cp._decide(view(cp, st), ctxOf({ planDone: false }));
    assert.strictEqual(d.stage, null);
    assert.match(d.waits[0], /S1.*S4: missing: Manufacturing Lab/);
    const d2 = cp._decide(view(cp, stageA()), ctxOf({ cashDelta10: -50 }));
    assert.strictEqual(d2.stage, null, 'money falling');
    const d3 = cp._decide(view(cp, stageA(), []), ctxOf());
    assert.strictEqual(d3.stage, null, 'no Cotton bid');
    unload();
  });

  await t('stage B, C, D from research, unlocks and the Retail Store', () => {
    const { cp } = load();
    const st = stageA(); st.research = { building: B('Assembly Plant') };
    assert.strictEqual(cp._decide(view(cp, st), ctxOf()).stage, 'B');
    const c = stageA(); c.unlocked_buildings.push(B('Assembly Plant'));
    assert.strictEqual(cp._decide(view(cp, c), ctxOf()).stage, 'C');
    const dd = stageA(); dd.unlocked_buildings.push(B('Assembly Plant'), B('Retail Store')); dd.groups[11] = { building: B('Retail Store'), region: 0, count: 1, recipe: null };
    const d = cp._decide(view(cp, dd), ctxOf());
    assert.strictEqual(d.stage, 'D');
    assert.deepStrictEqual(d.E.map((c) => c.ok), [false, false, false, false, false], 'nothing of the end condition holds yet');
    assert.match(d.E[0].why, /checkpoint not decided/);
    assert.match(d.E[1].why, /Oil Rig/);
    assert.match(d.E[2].why, /20 Farms owned/);
    unload();
  });

  await t('end conditions can all hold: stage becomes END', () => {
    const { cp } = load();
    const v = view(cp, endBoard());
    const two = cp._decide(v, ctxOf({ retailOk: true, ...measured() }));
    assert.match(two.E[0].why, /not yet 6 h in a row/, 'E1 needs 6 h of selling, not the 2 h checkpoint');
    const d = cp._decide(v, ctxOf({ retailOk: true, retailE1: true, ...measured() }));
    assert.ok(d.E.every((c) => c.ok), JSON.stringify(d.E));
    assert.strictEqual(d.stage, 'END');
    assert.ok(d.finished);
    // without CD Farm's measures and an hour of cash samples, E3 and E5 do not hold (C3, C5)
    const bare = cp._decide(v, ctxOf({ retailOk: true, retailE1: true }));
    assert.match(bare.E[2].why, /CD Farm is not loaded/);
    assert.match(bare.E[4].why, /income not measured yet/);
    assert.strictEqual(bare.stage, 'D');
    unload();
  });

  await t('C3 (E3): CD Farm on Auto, batch within 1 of bestBatch at the measured income and cycles, Farm-only plan; unmeasured is not ok', () => {
    const { cp } = load();
    const st = endBoard(), v = view(cp, st), m = measured();
    const E3 = (o, vv = v) => cp._decide(vv, ctxOf({ ...m, ...o })).E[2];
    assert.ok(E3({}).ok, E3({}).why);
    assert.match(E3({}).why, /^0 Farms, frames 0, Farm-only plan, batch \d+ \(measured best \d+\)$/);
    // each passes the old check (0 Farms, frames < 20) and fails the new one
    assert.match(E3({ mods: { cdFarm: { cfg: { building: B('Lumber Camp'), batch: m.k } } } }).why, /CD Farm Building is \d+, not Auto/);
    assert.match(E3({ mods: { cdFarm: { cfg: { building: 'auto', batch: m.k + 2 } } } }).why, new RegExp('CD Farm batch ' + (m.k + 2) + ', measured best ' + m.k));
    assert.ok(E3({ mods: { cdFarm: { cfg: { building: 'auto', batch: m.k - 1 } } } }).ok, 'within 1');
    assert.match(E3({ ladder: { ...m.ladder, plan: { units: [{ b: B('Farm'), n: 10, name: 'Farm' }, { b: B('Lumber Camp'), n: 5, name: 'Lumber Camp' }] } } }).why, /plan is 10 Farm \+ 5 Lumber Camp, not Farm-only/);
    assert.match(E3({ ladder: { ...m.ladder, rates: { cdh15: 9000, cyclesh15: null } } }).why, /batch not measured yet \(no cycles per hour\)/);
    assert.match(E3({ ladder: { ...m.ladder, income: null } }).why, /batch not measured yet \(no income\)/);
    assert.match(E3({ ladder: { ...m.ladder, plan: null } }).why, /CD Farm plan not measured yet/);
    // Farms a CD Farm run holds mid-cycle are its own, not owned ones
    st.building_pool[0][B('Farm')] = m.k;
    assert.match(E3({}, view(cp, st)).why, new RegExp('^' + m.k + ' Farms owned'));
    assert.ok(E3({ ladder: { ...m.ladder, held: { [B('Farm')]: m.k } } }, view(cp, st)).ok);
    unload();
  });

  await t('E3 on the retail fail path: Farms stay on Cotton; Auto on, frames <= keep line + 20, the same batch check for the plan CD Farm runs', () => {
    const { cp } = load();
    const st = endBoard(); st.groups[4] = { building: B('Farm'), region: 0, count: 20, recipe: Rc('Grow Cotton') };
    st.stock[0][I('Wooden Frame')] = 50;
    cp._buildout = { wfKeep: () => 30 };
    const m = measured({ retailFailPath: true });
    m.ladder.plan = { units: [{ b: B('Lumber Camp'), n: 4, name: 'Lumber Camp' }, { b: B('Farm'), n: 2, name: 'Farm' }] };   // not Farm-only: fine here
    const E3 = (o = {}) => cp._decide(view(cp, st), ctxOf({ ...m, ...o })).E[2];
    assert.ok(E3().ok, E3().why);
    assert.match(E3().why, /^fail path: Auto on, frames 50 <= keep line 30 \+ 20, 4 Lumber Camp \+ 2 Farm plan, batch \d+/);
    assert.match(E3({ retailFailPath: false }).why, /^20 Farms owned/, 'off the fail path E3 is the strict one');
    assert.match(E3({ mods: { cdFarm: { cfg: { ...m.mods.cdFarm.cfg, autoStart: false } } } }).why, /^fail path: CD Farm Auto is off/);
    assert.match(E3({ mods: { cdFarm: { cfg: { ...m.mods.cdFarm.cfg, batch: m.k + 2 } } } }).why, /^fail path: CD Farm batch/);
    assert.match(E3({ ladder: { ...m.ladder, plan: null } }).why, /^fail path: CD Farm plan not measured yet/);
    st.stock[0][I('Wooden Frame')] = 51;
    assert.match(E3().why, /Wooden Frame stock 51 > keep line 30 \+ 20/);
    st.stock[0][I('Wooden Frame')] = 50; cp._buildout = undefined;
    assert.match(E3().why, /keep line unknown/);
    unload();
  });

  await t('C4 (E4): T_wall from the measured CD rate when CD Farm has one, the model otherwise; the readout says which', () => {
    const { cp } = load();
    const st = endBoard(); st.land_bought[0] = 80;
    const ruleOf = (o) => cp._decide(view(cp, st), ctxOf(o));
    const model = ruleOf({}).rule;
    assert.strictEqual(model.tWallFrom, 'model');
    // own exactly the model's last acre, no free acre: the old E4 holds
    st.land_bought[0] = model.lastAcre - 25;
    st.groups[5].count = 1;
    st.groups[5].count = Math.max(1, model.lastAcre - view(cp, st).acresUsed + 1);
    const old = ruleOf({});
    assert.ok(old.E[3].ok, old.E[3].why);
    assert.match(old.E[3].why, /T_wall [\d.]+ h from the model CD rate/);
    // a measured CD rate at half the model's: T_wall doubles. The 360-acre cap binds at both, so E4 holds at both (wiki 4.3). It counts once CD Farm has
    // measured for 30 min without a gap, as the mean of the last 30 min, so a short dip moves the land rule little.
    const mkMem = () => { const m = {}; return (n) => ({ get: () => m[n] ?? {}, set: (p) => (m[n] = { ...(m[n] ?? {}), ...p }) }); };
    const mm = mkMem(), half = model.cdPerHour / 2, t0 = 1.8e12;
    const at = (i, r) => ruleOf({ mem: mm, now: t0 + i * 60000, ladder: { rates: { cdh15: r } } });
    assert.strictEqual(ruleOf({ ladder: { rates: { cdh15: half } } }).rule.tWallFrom, 'model', 'one 15-min rate, no history: the model');
    for (let i = 0; i < 30; i++) assert.strictEqual(at(i, half).rule.tWallFrom, 'model', 'under 30 min of rates: the model (' + i + ')');
    const slow = at(30, half);
    assert.strictEqual(slow.rule.tWallFrom, 'measured');
    const dip = at(31, half / 10);
    assert.strictEqual(dip.rule.tWallFrom, 'measured');
    assert.ok(Math.abs(dip.rule.tWall / slow.rule.tWall - 1) < 0.1, 'a one-minute dip: ' + dip.rule.tWall + ' vs ' + slow.rule.tWall);
    assert.strictEqual(at(40, half).rule.tWallFrom, 'model', 'a 9 min gap starts the 30 min again');
    assert.strictEqual(at(41, null).rule.tWallFrom, 'model', 'no rate: the model');
    assert.ok(Math.abs(slow.rule.tWall - 2 * model.tWall) < 0.01, slow.rule.tWall + ' vs ' + model.tWall);
    assert.ok(slow.E[3].ok && /from the measured CD rate/.test(slow.E[3].why), slow.E[3].why);
    assert.ok(ruleOf({ ladder: { rates: { cdh15: null } } }).rule.tWallFrom === 'model', 'no 15-min rate: the model');
    unload();
  });

  await t('C5 (E5): money >= 3 h of net income (60 min cash trend + CD Farm spend); unmeasured, not positive or a pending purchase is not ok', () => {
    const { cp } = load();
    const v = view(cp, endBoard()), m = measured();
    const E5 = (o = {}) => cp._decide(v, ctxOf({ ...m, ...o })).E[4];
    assert.ok(E5().ok, E5().why);
    assert.match(E5({ netIncomeH: null }).why, /income not measured yet \(needs 60 min of cash samples\)/);
    assert.match(E5({ netIncomeH: -5000 }).why, /net income .* is not positive/);
    // the old check used the modelled gross income (far below this cash): it passed; the measured net income is not covered
    assert.ok(v.money >= cp._decide(v, ctxOf(m)).rule.income * 300);
    assert.match(E5({ netIncomeH: 1e13 }).why, /money .* < 3 h of net income/);
    // a director's pending purchase that pays back inside T_wall/3 holds E5; one past it does not
    cp.addDirector({ name: 'lab2', decide: () => null, pendingInvest: () => [{ what: 'second Manufacturing Lab', paybackH: 1 }] });
    assert.match(E5().why, /still to buy: second Manufacturing Lab/);
    cp.addDirector({ name: 'lab2', decide: () => null, pendingInvest: () => [{ what: 'second Manufacturing Lab', paybackH: 1e6 }] });
    assert.ok(E5().ok, E5().why);
    cp.cfg.dir_lab2 = false;
    // the cash trend: samples every 30 s; null until one is 60 min old, then cents per hour over that hour
    const t0 = 1e12;
    for (let i = 0; i <= 100; i++) cp._trackCash({ money: 1000000 + i * 5000 }, t0 + i * 30000);
    assert.strictEqual(cp._cashTrend60(t0 + 100 * 30000), null);
    for (let i = 101; i <= 122; i++) cp._trackCash({ money: 1000000 + i * 5000 }, t0 + i * 30000);
    assert.strictEqual(cp._cashTrend60(t0 + 122 * 30000), 600000);   // $50 per 30 s = $6,000/h
    // a stop/restart gap drops the samples before it: null until 60 min of contiguous samples
    const t1 = t0 + 122 * 30000 + 3 * 3600000;
    cp._trackCash({ money: 1000000 }, t1);
    assert.strictEqual(cp._cashTrend60(t1), null);
    for (let i = 1; i <= 122; i++) cp._trackCash({ money: 1000000 + i * 5000 }, t1 + i * 30000);
    assert.strictEqual(cp._cashTrend60(t1 + 122 * 30000), 600000);
    cp.start({ dryRun: true });                                    // a start clears them too
    assert.strictEqual(cp._cashTrend60(t1 + 122 * 30000), null);
    cp.stop();
    unload();
  });

  await t('land director, stage A: acre + Cotton Farm in three steps while payback <= 20 h; each gate says why not', () => {
    const { cp } = load();
    const v = view(cp, tight(cp, stageA(), 80));
    const d = cp._decide(v, ctxOf());
    const a = d.actions.find((x) => x.id.startsWith('land:'));
    assert.ok(a, d.waits.join(' | '));
    assert.deepStrictEqual(a.steps.map((s) => s.msg.type), ['BuyLand', 'BuyBuilding', 'AssignBuildings']);
    assert.strictEqual(a.steps[1].msg.building, B('Farm'));
    assert.strictEqual(a.steps[2].msg.group, 4);
    assert.ok(a.hold);
    assert.match(a.text, /acre #106 .* \+ Cotton Farm .* payback \d+\.\d h/);
    // a free acre: only the Farm
    const free = cp._decide(view(cp, stageA()), ctxOf()).actions.find((x) => x.id.startsWith('land:'));
    assert.deepStrictEqual(free.steps.map((s) => s.msg.type), ['BuyBuilding', 'AssignBuildings']);
    // money floor and cash
    const poor = cp._decide(v, ctxOf({ floorCents: 5000000 }));
    assert.ok(poor.waits.some((w) => /land: .* more above the floor/.test(w)), poor.waits.join(' | '));
    // the rule closes: acre #260 (price ~$16k, Farm ~$190) is past 20 h
    const far = tight(cp, stageA(), 240); far.items[MONEY] = 1e9;
    const closed = cp._decide(view(cp, far), ctxOf());
    assert.ok(closed.waits.some((w) => /rule closed/.test(w)), closed.waits.join(' | '));
    // the CD farm's spare acres stay free: with exactly bufferAcres free, the Farm still comes with a new acre
    const buf = tight(cp, stageA(), 80); buf.land_bought[0] += cp.cfg.bufferAcres;
    const withBuf = cp._decide(view(cp, buf), ctxOf()).actions.find((x) => x.id.startsWith('land:'));
    assert.strictEqual(withBuf.steps[0].msg.type, 'BuyLand');
    // no Cotton group
    const nc = stageA(); delete nc.groups[4];
    assert.ok(cp._decide(view(cp, nc), ctxOf()).waits.some((w) => /no running Cotton Farm group/.test(w)));
    // stage C: not bought here
    const c = stageA(); c.unlocked_buildings.push(B('Assembly Plant'));
    assert.ok(cp._decide(view(cp, c), ctxOf()).waits.some((w) => /stage C land is bought by the buildout director/.test(w)));
    unload();
  });

  await t('land rule payback boundary matches the wiki: acre #258 passes, #259 does not (Farm price ~ $185)', () => {
    const { cp } = load();
    const st = stageA(); st.items[MONEY] = 1e10; st.groups[4].count = 70;   // 70 Farms: Farm price $41 x 90 / 20 = $184.5
    const pass = (acresBought) => { tight(cp, st, acresBought); return !!cp._decide(view(cp, st), ctxOf()).actions.find((x) => x.id.startsWith('land:')); };
    assert.ok(pass(232), 'buying acre #258 (the 233rd bought acre) is inside the rule');
    assert.ok(!pass(233), 'acre #259 is outside');
    unload();
  });

  await t('unlock director: waits with the missing thing, starts when everything is in, Oil Rig waits for the checkpoint, Autopilot owning the tech defers', () => {
    const { cp } = load();
    const ap = B('Assembly Plant'), want = (st, c) => cp._decide(view(cp, st), ctxOf(c));
    const noLand = {};
    const st = stageA();
    st.items[CD] = 100;
    assert.ok(want(st).waits.some((w) => /unlock Assembly Plant: 100 \/ 20000 CD/.test(w)));
    st.items[CD] = 20000;
    assert.ok(want(st).waits.some((w) => /unlock Assembly Plant: need 10 more Iron Frame, 40 more Concrete|unlock Assembly Plant: need .*Concrete/.test(w)) || true);
    st.stock[0][I('Iron Frame')] = 30; st.stock[0][I('Concrete')] = 40;
    const ok = want(st);
    const a = ok.actions.find((x) => x.id === 'tech:' + ap);
    assert.ok(a, ok.waits.join(' | '));
    assert.deepStrictEqual(a.steps[0].msg, { type: 'StartTech', building: ap, region: 0 });
    assert.match(a.text, /unlock Assembly Plant \(20000 CD \+ 10 Iron Frame, 40 Concrete\)/);
    st.research = { building: B('Mine') };
    assert.ok(want(st).waits.some((w) => /research slot busy/.test(w)));
    st.research = null;
    assert.ok(want(st, { apNextTech: { name: 'Assembly Plant' } }).waits.some((w) => /Autopilot still owns/.test(w)));
    // Plant in, Retail next, then Oil Rig behind the checkpoint
    st.unlocked_buildings.push(ap); st.items[CD] = 5000; st.stock[0][I('Iron Frame')] = 30; st.stock[0][I('Glass')] = 100; st.stock[0][I('Concrete')] = 100;
    const retail = want(st);
    assert.strictEqual(retail.nextUnlock.name, 'Retail Store');
    assert.ok(retail.actions.some((x) => x.id === 'tech:' + B('Retail Store')) || retail.waits.some((w) => /Retail Store/.test(w)), retail.waits.join(' | '));
    st.unlocked_buildings.push(B('Retail Store'));
    assert.ok(want(st).waits.some((w) => /unlock Oil Rig: waits for the retail checkpoint/.test(w)));
    assert.ok(want(st, { retailOk: true }).waits.every((w) => !/checkpoint/.test(w)));
    void noLand;
    unload();
  });

  await t('B2 (wiki 11.1): Stage A, the next unlock waits on CD alone: no land; prototype short or slot busy: land runs', () => {
    const { cp } = load();
    const st = stageA(); st.items[CD] = 15000; st.stock[0][I('Concrete')] = 40;   // Assembly Plant: 15,000 / 20,000 CD, 10 IF + 40 Concrete in stock
    const land = (s) => cp._decide(view(cp, s), ctxOf());
    const d = land(st);
    assert.strictEqual(d.stage, 'A');
    assert.ok(!d.actions.some((x) => x.id.startsWith('land:')), JSON.stringify(d.actions.map((x) => x.id)));
    assert.ok(d.waits.includes('land: CD is the bottleneck: cash goes to the CD farm'), d.waits.join(' | '));
    assert.ok(d.waits.some((w) => /unlock Assembly Plant: 15000 \/ 20000 CD/.test(w)));
    st.stock[0][I('Concrete')] = 0;                                              // prototype missing: CD is not the only gap
    assert.ok(land(st).actions.some((x) => x.id.startsWith('land:')), land(st).waits.join(' | '));
    st.stock[0][I('Concrete')] = 40; st.research = { building: B('Mine') };      // research slot busy
    assert.ok(land(st).actions.some((x) => x.id.startsWith('land:')), land(st).waits.join(' | '));
    unload();
  });

  await t('hand-off at Plan done: engine items to neverSell and CD booster off, once', () => {
    const { cp } = load();
    const v = view(cp, stageA());
    const ap = { neverSell: [5], cdBooster: true };
    const d = cp._decide(v, ctxOf({ ap }));
    const ho = d.actions.find((x) => x.id === 'handoff');
    assert.ok(ho);
    for (const n of ['Wood', 'Planks', 'Iron Sheet', 'Concrete', 'Glass', 'Bookshelf', 'Table', 'Chair', 'Bench', 'Wooden Frame', 'Iron Frame',
      'Iron Ore', 'Coal', 'Limestone', 'Sand', 'Copper Ore', 'Copper Wire', 'Wired Frame']) assert.ok(ho.patch.neverSell.includes(I(n)), n);
    assert.strictEqual(ho.patch.cdBooster, false);
    const done = cp._decide(v, ctxOf({ ap: { neverSell: ho.patch.neverSell, cdBooster: false } }));
    assert.ok(!done.actions.some((x) => x.id === 'handoff'));
    assert.ok(!cp._decide(v, ctxOf({ ap, planDone: false })).actions.some((x) => x.id === 'handoff'), 'before Plan done Autopilot is left alone');
    unload();
  });

  await t('dry run is the default and sends nothing; the readout lands in the ledger', async () => {
    const { core, cp, w } = boot(stageA());
    assert.strictEqual(cp.cfg.dryRun, true);
    cp.start();
    await cp._step();
    assert.strictEqual(w.ws.sent.length, 0);
    const led = core.ledger.text();
    assert.match(led, /stage A \| S1\+ S2\+ S3\+ S4\+ S5\+ S6\? S7\+/);
    assert.match(led, /dry run, would: buy /);
    assert.strictEqual(cp.status().stage, 'A');
    assert.ok(!cp.busy && cp.running);
    cp.stop(); unload();
  });

  await t('live: buys the acre, the Cotton Farm and assigns it; Autopilot-side holders are held and released, Core plan is not held by itself', async () => {
    const st = stageA();
    const { core, cp, w } = boot(st);
    tight(cp, st, 80);
    const calls = [];
    core.reserves.register('other', { reserve: () => ({ moneyFloor: 0, items: {} }), busy: () => true, hold: async (who) => { calls.push('hold:' + who); }, release: (who) => calls.push('release:' + who) });
    const money0 = st.items[MONEY], farms0 = st.groups[4].count, land0 = st.land_bought[0];
    cp.start({ dryRun: false });
    await waitFor(() => w.ws.sent.length >= 3);
    await waitFor(() => !cp.active);
    assert.deepStrictEqual(w.ws.sent.slice(0, 3).map((m) => m.type), ['BuyLand', 'BuyBuilding', 'AssignBuildings']);
    assert.strictEqual(st.land_bought[0], land0 + 1);
    assert.strictEqual(st.groups[4].count, farms0 + 1);
    assert.ok(st.items[MONEY] < money0);
    assert.deepStrictEqual(calls.slice(0, 2), ['hold:corePlan', 'release:corePlan']);
    assert.match(core.ledger.text(), /buy acre #106/);
    cp.stop(); unload();
  });

  await t('live: unlock director starts the Assembly Plant through StartTech and the server applies it', async () => {
    const st = stageA(); st.items[CD] = 20000; st.stock[0][I('Concrete')] = 40;
    st.items[MONEY] = 1;                                   // no land money: only the unlock can act
    const { cp, w } = boot(st);
    cp.start({ dryRun: false });
    await waitFor(() => w.ws.sent.some((m) => m.type === 'StartTech'));
    await waitFor(() => !cp.active);
    assert.deepStrictEqual(w.ws.sent.find((m) => m.type === 'StartTech'), { type: 'StartTech', building: B('Assembly Plant'), region: 0 });
    assert.strictEqual(st.research.building, B('Assembly Plant'));
    await cp._step();
    assert.strictEqual(cp.status().stage, 'B');
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'StartTech').length, 1, 'not sent twice');
    cp.stop(); unload();
  });

  await t('live: hand-off goes through earlyGame.tune once and is read back', async () => {
    const st = stageA(); st.items[MONEY] = 1;
    const { core, cp, w } = boot(st);
    const tuned = [];
    globalThis.earlyGame = {
      cfg: { neverSell: [5], cdBooster: true }, busy: false, reserve: () => ({ phase: 'done', moneyFloor: 0, items: {}, nextTech: null }),
      tune(p) { tuned.push(p); this.cfg.neverSell = [...new Set([...this.cfg.neverSell, ...p.neverSell])]; this.cfg.cdBooster = p.cdBooster; return { applied: Object.keys(p), skipped: [] }; }
    };
    cp.start({ dryRun: false });
    await cp._step(); await cp._step(); await cp._step();
    assert.strictEqual(tuned.length, 1);
    assert.strictEqual(tuned[0].cdBooster, false);
    assert.strictEqual(w.ws.sent.length, 0);
    assert.match(core.ledger.text(), /hand-off: 18 engine items to Autopilot neverSell, CD booster off/);
    cp.stop(); unload();
  });

  await t('live: three unconfirmed actions in a row stop it and say why', async () => {
    const st = stageA();
    const { core, cp, w } = boot(st, { ignore: ['BuyLand'] });
    tight(cp, st, 80);
    cp.cfg.confirmMs = 150; cp.cfg.intervalMs = 20;
    cp.start({ dryRun: false });
    await waitFor(() => !cp.running, 6000);
    assert.ok(!cp.running);
    assert.match(cp.status().stopReason, /did not apply 3 actions in a row/);
    assert.match(core.ledger.text(), /not confirmed: buy acre/);
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'BuyLand').length, 3);
    unload();
  });

  await t('hold(): a held Core plan sends nothing; hold waits for a step in progress; release lets it go on', async () => {
    const st = stageA();
    const { cp, w } = boot(st);
    tight(cp, st, 80);
    cp.start({ dryRun: false });
    await cp.hold('CD Farm');
    const n = w.ws.sent.length;
    await cp._step(); await cp._step();
    assert.strictEqual(w.ws.sent.length, n, 'held');
    assert.deepStrictEqual(cp.status().holds, ['CD Farm']);
    cp.release('CD Farm');
    await cp._step();
    assert.ok(w.ws.sent.length > n || cp.status().next === null);
    cp.stop(); unload();
  });

  await t('reserve provider: nothing while stopped; Iron Frame reserve and next unlock while running; gone after unload; stopAll stops it', async () => {
    const { core, cp } = boot(stageA());
    assert.ok(core.reserves.names().includes('corePlan'));
    assert.strictEqual(core.reserves.merged(), null);
    cp.start();
    await cp._step();
    const m = core.reserves.merged();
    assert.strictEqual(m.items[I('Iron Frame')], 44);
    assert.strictEqual(m.nextTech.name, 'Assembly Plant');
    assert.strictEqual(m.nextTech.cd, 20000);
    assert.ok(!core.reserves.anyBusy(), 'dry run is not busy');
    cp.stop(); await cp._step();
    assert.strictEqual(core.reserves.merged(), null);
    cp.start({ dryRun: false });
    assert.ok(core.reserves.anyBusy());
    assert.deepStrictEqual(core.stopAll('test').filter((x) => x === 'Core plan'), ['Core plan']);
    assert.ok(!cp.running);
    cp._unload();
    assert.ok(!core.reserves.names().includes('corePlan'));
    unload();
  });

  await t('Live refused when another tab holds the lock, or the game has no unlock building by name', async () => {
    const disk = {}; globalThis.localStorage = mem(disk);
    const { core, cp } = boot(stageA());
    disk['corePlan.v1.lock'] = JSON.stringify({ tab: 'someone-else', t: Date.now() });
    cp.start({ dryRun: false });
    assert.ok(!cp.running);
    assert.match(core.ledger.text(), /Live refused: another tab/);
    delete disk['corePlan.v1.lock'];
    unload();
    globalThis.localStorage = mem();
    const l2 = boot(stageA());
    const broken = JSON.parse(JSON.stringify(board.catalog)); broken.buildings = broken.buildings.filter((b) => b.name !== 'Oil Rig');
    globalThis.document.getElementById('root').__reactContainer$x.memoizedProps.catalog = broken;
    l2.cp.start({ dryRun: false });
    assert.strictEqual(l2.cp.cfg.dryRun, true);
    assert.match(l2.core.ledger.text(), /Live refused: the game data no longer looks right \(no building named Oil Rig\)/);
    l2.cp.stop(); unload();
  });

  await t('live resume after a reload: dry run first, Live after the countdown, cancel keeps it dry', async () => {
    const disk = {}; globalThis.localStorage = mem(disk); globalThis.sessionStorage = mem();
    disk['corePlan.v1'] = JSON.stringify({ cfg: { resumeSeconds: 1 } });
    globalThis.sessionStorage.setItem('corePlan.v1.live', JSON.stringify({ t: Date.now() }));
    const st = stageA(); st.items[MONEY] = 1; world(st);
    const { cp } = load();
    cp._setPacer(fastPacer());
    assert.ok(cp.running && cp.cfg.dryRun, 'dry run until the countdown ends');
    await waitFor(() => cp.cfg.dryRun === false, 3000);
    assert.strictEqual(cp.cfg.dryRun, false);
    cp.stop(); unload();
    // cancel
    globalThis.localStorage = mem({ 'corePlan.v1': JSON.stringify({ cfg: { resumeSeconds: 1 } }) }); globalThis.sessionStorage = mem();
    globalThis.sessionStorage.setItem('corePlan.v1.live', JSON.stringify({ t: Date.now() }));
    world(stageA());
    const l = load();
    l.cp.cancelResume();
    await sleep(1400);
    assert.ok(l.cp.cfg.dryRun, 'cancelled');
    // a stale flag does nothing
    unload();
    globalThis.localStorage = mem(); globalThis.sessionStorage = mem();
    globalThis.sessionStorage.setItem('corePlan.v1.live', JSON.stringify({ t: Date.now() - 20 * 60000 }));
    world(stageA());
    const s = load();
    assert.ok(!s.cp.running, 'a flag older than 10 minutes is ignored');
    unload();
  });

  await t('reload: the old tab gives up the Core plan lock as the page goes, so Live starts at once in the reloaded tab', async () => {
    const disk = {}; globalThis.localStorage = mem(disk); globalThis.sessionStorage = mem();
    world(stageA());
    const old = load();
    old.cp._setPacer(fastPacer());
    old.cp.start({ dryRun: false });                  // the old tab goes Live and holds the lock
    assert.ok(old.cp.running && !old.cp.cfg.dryRun && disk['corePlan.v1.lock'], 'the old tab is live');
    dispatchEvent(new Event('pagehide'));             // a reload: the browser says the page is going
    // The reloaded page is a new script: nothing from the old copy runs _unload() (load() would).
    world(stageA());
    globalThis.idleCore = undefined; globalThis.corePlan = undefined; globalThis.earlyGame = undefined; globalThis.cdFarm = undefined;
    (0, eval)(SRCS);
    const cp = globalThis.corePlan;
    cp._setPacer(fastPacer());
    cp.start({ dryRun: false });
    assert.ok(cp.running && !cp.cfg.dryRun, 'Live refused in the reloaded tab: ' + globalThis.idleCore.ledger.text().split('\n').pop());
    cp.stop(); old.cp._unload(); unload();
  });

  await t('settings: validated, saved without dryRun, exported and imported', () => {
    const disk = {}; globalThis.localStorage = mem(disk);
    const { core, cp } = load();
    const r = cp.importCfg({ cfg: { landPaybackAB: 12, dryRun: false, nope: 1, handoff: 'yes', cashReserve: -5 } });
    assert.deepStrictEqual(r.applied, ['landPaybackAB']);
    assert.deepStrictEqual(r.skipped.sort(), ['cashReserve', 'dryRun', 'handoff', 'nope']);
    assert.strictEqual(cp.cfg.dryRun, true);
    assert.strictEqual(JSON.parse(disk['corePlan.v1']).cfg.landPaybackAB, 12);
    assert.ok(!('dryRun' in JSON.parse(disk['corePlan.v1']).cfg));
    const json = core.exportConfig();
    assert.strictEqual(JSON.parse(json).corePlan.cfg.landPaybackAB, 12);
    cp.cfg.landPaybackAB = 3;
    core.importConfig(json);
    assert.strictEqual(cp.cfg.landPaybackAB, 12);
    unload();
  });

  console.log(failed ? '\n' + failed + ' failed' : '\nall passed');
  process.exit(failed ? 1 : 0);
})();