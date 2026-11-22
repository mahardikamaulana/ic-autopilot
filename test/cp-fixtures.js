// Shared fixtures for the Core plan tests (core-plan-sim.js and the director tests test/cp-*-test.js).
//   const F = require('./cp-fixtures');  const { core, cp, w } = F.boot(st, { modules: ['cp-buildout'] });
// boot() evals core, pacer, planner, core-math, core-plan (+ the named director modules) from the BUILT script, with a fake
// game server in place: the fiber tree the core reads, a WebSocket that applies the actions below to st and answers with a Diff.
const fs = require('fs');
const path = require('path');

const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'live-board.json'), 'utf8'));
const stageB = JSON.parse(fs.readFileSync(path.join(__dirname, 'live-stageB.json'), 'utf8'));   // live corp, Stage B, 2026-11-22
// CP_FROM_SRC=1 reads src/*.js in build.js PARTS order instead of the built file (so several people can test without racing bun build.js).
const full = () => {
  if (!process.env.CP_FROM_SRC) return fs.readFileSync(path.join(__dirname, '..', 'ic-autopilot.user.js'), 'utf8');
  const parts = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build.js'), 'utf8').match(/const PARTS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  return parts.map((p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8')).join('');
};
const slice = (src, name) => {
  const a = src.indexOf('// @@MODULE ' + name + '\n'), b = src.indexOf('// @@END ' + name);
  if (a < 0 || b < 0) throw new Error('module ' + name + ' is not in the built script (bun build.js?)');
  return src.slice(a, b);
};
const BASE = ['core', 'pacer', 'planner', 'core-math', 'core-plan'];

let failed = 0;
const quietLog = console.log, quietWarn = console.warn, quietErr = console.error;
async function t(name, fn) {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { await fn(); console.log = quietLog; console.warn = quietWarn; console.error = quietErr; quietLog('ok   ' + name); }
  catch (e) { console.log = quietLog; console.warn = quietWarn; console.error = quietErr; failed++; quietLog('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
}
const done = () => { console.log(failed ? '\n' + failed + ' failed' : '\nall passed'); process.exit(failed ? 1 : 0); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 4000, step = 10) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(step); } return !!cond(); };
const clone = (o) => JSON.parse(JSON.stringify(o));

const B = (n, cat = board.catalog) => cat.buildings.find((b) => b.name === n).id;
const I = (n, cat = board.catalog) => cat.items.find((i) => i.name === n).id;
const Rc = (n, cat = board.catalog) => cat.recipes.find((r) => r.name === n).id;
const MONEY = 0, CD = 24;

// A Stage A Corporation: everything the start conditions ask for, 80 bought acres, 20 Cotton Farms.
function stageA(over = {}) {
  const st = {
    ssi: { corp_id: 1, last_user_mutation_tick: 0 },
    items: { [MONEY]: 5000000, [CD]: 100 },
    stock: { 0: { [I('Iron Frame')]: 30, [I('Concrete')]: 100 } },
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
    building_pool: { 0: {} }, next_group_id: 11, research: null, research_queue: [], module_defs: {}, standing_fills: {},
    unlocked_buildings: ['Mine', 'Quarry', 'Sawmill', 'Smelter', 'Workshop', 'Kiln', 'Factory', 'Paper Mill', 'Manufacturing Lab'].map((n) => B(n)),
    land_bought: { 0: 80 },
  };
  return Object.assign(st, over);
}
// The live Stage B corp (a fresh copy each call).
const liveB = () => clone(stageB.st);
const cottonBidDeals = () => [{ id: 1, side: 'Sell', item: I('Cotton'), amount: 200000, price: 30000000, region: 0, expires_at: 99999999 }];

// ---- fake game server --------------------------------------------------------------------------------------------------------------------
// Applies: BuyLand, BuyBuilding, AssignBuildings, UnassignBuildings, DemolishBuilding, CreateGroup, SetRecipe, SetPaused,
// StartTech, QueueTech, InstallModule, RemoveModule, SetAssortment, KeepFilling, StopFilling, EditLayout. Anything in opts.ignore is received but not applied.
function world(st, deals = cottonBidDeals(), { ignore = [], catalog = board.catalog, retail = null, tickRef = { tick: 20000000 } } = {}) {
  const listeners = new Set();
  st.building_pool ??= { 0: {} }; st.building_pool[0] ??= {};
  st.ssi ??= { corp_id: 1, last_user_mutation_tick: 0 };
  const cat = catalog;
  const owned = (b) => Object.values(st.groups).filter((g) => g.building === b).reduce((a, g) => a + g.count, 0) + (st.building_pool[0][b] ?? 0);
  function apply(m) {
    const pool = st.building_pool[0];
    switch (m.type) {
      case 'BuyLand': { let p = 5000; for (let i = 0; i < st.land_bought[0]; i++) p = Math.floor(p * 41 / 40); for (let i = 0; i < m.amount; i++) { st.items[MONEY] -= p; p = Math.floor(p * 41 / 40); } st.land_bought[0] += m.amount; break; }
      case 'BuyBuilding': { const bd = cat.buildings.find((b) => b.id === m.building); for (let i = 0; i < m.amount; i++) st.items[MONEY] -= Math.floor(bd.cost * (20 + owned(m.building) + i) / 20); for (const it of bd.build_items ?? []) st.stock[0][it.item] = (st.stock[0][it.item] ?? 0) - it.amount * m.amount; pool[m.building] = (pool[m.building] ?? 0) + m.amount; break; }
      case 'AssignBuildings': { const g = st.groups[m.group]; pool[g.building] -= m.amount; g.count += m.amount; break; }
      case 'UnassignBuildings': { const g = st.groups[m.group]; g.count -= m.amount; pool[g.building] = (pool[g.building] ?? 0) + m.amount; break; }
      case 'DemolishBuilding': { const bd = cat.buildings.find((b) => b.id === m.building); pool[m.building] -= m.amount; st.items[MONEY] += Math.floor(bd.cost / 2) * m.amount; break; }
      case 'CreateGroup': { const id = st.next_group_id++; pool[m.building] -= m.amount; st.groups[id] = { building: m.building, region: m.region ?? 0, count: m.amount, recipe: null, name: m.name, modules: {} }; break; }
      case 'SetRecipe': st.groups[m.group].recipe = m.recipe; break;
      case 'SetPaused': st.groups[m.group].paused = !!m.paused; break;
      case 'StartTech': case 'QueueTech': { const tech = cat.techs.find((x) => x.building === m.building); if (m.type === 'StartTech' && st.research) break; st.items[CD] -= tech.cost; for (const i of cat.buildings.find((b) => b.id === m.building).build_items ?? []) st.stock[0][i.item] -= i.amount; if (m.type === 'StartTech') st.research = { building: m.building }; else (st.research_queue ??= []).push({ building: m.building }); break; }
      case 'InstallModule': { const g = st.groups[m.group]; g.modules ??= {}; g.modules[m.cell] = m.module; break; }
      case 'RemoveModule': delete st.groups[m.group].modules[m.cell]; break;
      case 'SetAssortment': st.groups[m.group].assortment = [...m.items]; break;
      case 'KeepFilling': (st.standing_fills ??= {})[m.deal] = { region: 0, remaining: m.amount, filled: 0, since: tickRef.tick, expires_at: deals.find((d) => d.id === m.deal)?.expires_at ?? 0 }; break;
      case 'StopFilling': delete st.standing_fills?.[m.deal]; break;
      case 'EditLayout': {   // every building on the recipe pays the added pieces; rejected (not applied) when any is short
        const r = cat.recipes.find((x) => x.id === m.recipe);
        const pieces = Object.fromEntries([...(cat.machines ?? []), ...(cat.belts ?? [])].map((x) => [x.item, x]));
        const bom = {};
        for (const c of Object.values(m.cells ?? {})) for (const x of pieces[c.item]?.materials ?? []) bom[x.item] = (bom[x.item] ?? 0) + x.amount;
        st.layouts ??= {};
        const old = Object.fromEntries((st.layouts[m.recipe]?.bom ?? cat.buildings.find((b) => b.id === r.building).default_kit ?? []).map((i) => [i.item, i.amount]));
        const n = Object.values(st.groups).filter((g) => g.recipe === m.recipe).reduce((a, g) => a + g.count, 0);
        const add = Object.entries(bom).map(([i, a]) => [i, Math.max(0, a - (old[i] ?? 0)) * n]);
        if (add.some(([i, a]) => (st.stock[0][i] ?? 0) < a)) break;
        for (const [i, a] of add) st.stock[0][i] -= a;
        st.layouts[m.recipe] = { cells: m.cells, fx: { rate: 5 }, bom: Object.entries(bom).map(([item, amount]) => ({ item: +item, amount })) };
        break;
      }
      default: break;
    }
  }
  class FakeWS {
    constructor() { this.readyState = 1; this.sent = []; }
    addEventListener(_, f) { listeners.add(f); } removeEventListener(_, f) { listeners.delete(f); }
    send(m) {
      const msg = JSON.parse(m); this.sent.push(msg);
      if (!ignore.includes(msg.type)) apply(msg);
      st.ssi.last_user_mutation_tick += 1; tickRef.tick += 1;
      for (const f of [...listeners]) f({ data: JSON.stringify({ kind: 'Diff', tick: tickRef.tick, diff: { ssi: { last_user_mutation_tick: st.ssi.last_user_mutation_tick } } }) });
    }
  }
  globalThis.WebSocket = FakeWS;
  const ws = new FakeWS();
  const engine = { evaluateLayout: () => JSON.stringify({ fx: { rate: 1 } }), retailJson: () => JSON.stringify(typeof retail === 'function' ? retail() : retail ?? { shelves: {} }) };
  const props = { catalog, engine };
  const fiber = { memoizedState: { memoizedState: { current: ws }, next: { memoizedState: st, next: { memoizedState: deals, next: null } } }, memoizedProps: props, child: null, sibling: null };
  const root = { __reactContainer$x: fiber };
  const el = () => ({ append() {}, remove() {}, addEventListener() {}, setAttribute() {}, style: {}, classList: { toggle() {} } });
  globalThis.document = { body: el(), head: el(), title: 'game', getElementById: (id) => (id === 'root' ? root : null), createElement: el, querySelector: () => null, hidden: true };
  return { ws, st, props, deals, tickRef, setRetail: (r) => { retail = r; } };
}

const mem = (disk = {}) => ({ getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = String(v); }, removeItem: (k) => { delete disk[k]; }, _disk: disk });
const fastPacer = () => ({ beforeCommand: async () => {}, noteConfirm() {}, noteResult() {} });

function clean() {
  globalThis.corePlan?._unload?.(); globalThis.idleCore?._unload?.();
  for (const k of ['idleCore', 'corePlan', 'earlyGame', 'cdFarm', 'labRunner', 'autoSell', 'autoUtil']) globalThis[k] = undefined;
}
// Pure load (no fake game): for the view / decide tests.
function load(modules = []) {
  clean();
  const src = full();
  (0, eval)([...BASE, ...modules].map((m) => slice(src, m)).join('\n'));
  const core = globalThis.idleCore;
  core.tune.pollMs = 5; core.tune.steadyMs = 50;
  globalThis.corePlan._setPacer(fastPacer());
  return { core, cp: globalThis.corePlan };
}
// Load with a fake game already in place (the core reads document / WebSocket when it loads).
function boot(st, { deals, ignore = [], modules = [], retail = null, catalog } = {}) {
  clean();
  const w = world(st, deals ?? cottonBidDeals(), { ignore, retail, catalog: catalog ?? board.catalog });
  const { core, cp } = load(modules);
  return { core, cp, w };
}
function unload() {
  clean();
  delete globalThis.document; delete globalThis.WebSocket; delete globalThis.localStorage; delete globalThis.sessionStorage;
}
// Make the bought acres exactly the acres in use (Camps soak up the difference), so a purchase needs an acre. stageA() only.
function tight(cp, st, bought) {
  st.land_bought[0] = bought;
  st.groups[5].count = 1;
  const used = cp._view(st, board.catalog, []).acresUsed;
  st.groups[5].count = Math.max(1, 25 + bought - (used - 1));
  return st;
}
// The ctx corePlan's runner builds, for pure decide() calls.
const ctxOf = (o = {}) => ({ planDone: true, cashDelta10: 500, floorCents: 0, retailOk: null, ap: null, apNextTech: null, now: 1.8e12, premium: false, deals: [], retailBoard: null,
  mem: (() => { const m = {}; return (n) => ({ get: () => m[n] ?? {}, set: (p) => (m[n] = { ...(m[n] ?? {}), ...p }) }); })(), live: true, dryRun: false, mods: {}, ...o });

module.exports = { board, stageB, t, done, sleep, waitFor, clone, B, I, Rc, MONEY, CD, stageA, liveB, cottonBidDeals, world, mem, fastPacer, load, boot, unload, tight, ctxOf, slice, full, BASE };
