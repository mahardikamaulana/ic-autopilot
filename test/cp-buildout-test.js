// Tests for the build-out director (src/cp-buildout-*.js): furniture split, Stage B switch, build order and gates, Farm conversion waves,
// Kiln gate, chaos, and a live purchase against the fake server.
//   CP_FROM_SRC=1 bun test/cp-buildout-test.js
const assert = require('assert');
const F = require('./cp-fixtures');

const cat = F.stageB.catalog, deals = F.stageB.deals, retail = F.stageB.retail;
const B = (n) => F.B(n, cat), I = (n) => F.I(n, cat), Rc = (n) => F.Rc(n, cat);
const HOUR = 3600000;
// The live Stage B corp with Wooden Frames between half the keep line and the line (19 there): the WF gate neither pauses nor resumes.
const liveB = () => { const st = F.liveB(); st.stock[0][I('Wooden Frame')] = 12; return st; };

// Live Stage B with the v1 furniture floors saved (copied from Frame Timber's) and the Kiln gate already met.
function liveReady() {
  const st = liveB();
  for (const n of ['Make Bookshelf', 'Make Table', 'Make Chair']) st.layouts[Rc(n)] = F.clone(st.layouts[Rc('Assemble Wooden Frame')]);
  st.stock[0][I('Glass')] = 150; st.stock[0][I('Concrete')] = 500;
  return st;
}
// Stage C: the Assembly Plant is in, the Retail Store research is not running.
function stageC(st = liveReady()) { st.unlocked_buildings.push(B('Assembly Plant')); st.research = null; return st; }
// Furniture on one recipe, a single Frame Timber Workshop: nothing left to switch.
function switched(st) { st.groups[3].count = 1; st.groups[8].recipe = Rc('Make Chair'); return st; }
const sharedMem = () => { const m = {}; return (n) => ({ get: () => m[n] ?? {}, set: (p) => (m[n] = { ...(m[n] ?? {}), ...p }) }); };
const bo = (d) => d.actions.find((a) => a.director === 'buildout');
const boWait = (d) => d.waits.filter((w) => w.startsWith('buildout:')).join(' | ');
function decideOn(cp, st, o = {}) { return cp._decide(cp._view(st, cat, deals), F.ctxOf({ retailBoard: retail, ...o })); }
const C_name = (rid) => cat.recipes.find((r) => r.id === rid)?.name;
const msgTypes = (a) => a.steps.map((s) => s.msg.type);
// Cash that passes the wave gate in the runner (its floor is cfg.cashReserve) but no more.
function gateCashOf(cp, st) {
  const v = cp._view(st, cat, deals), c = F.ctxOf({ retailBoard: retail, floorCents: cp.cfg.cashReserve });
  return cp._buildout.waveGate(v, c, cp._decide(v, c).rule, 'C', 22).need;
}
const wsGroups = (st) => Object.values(st.groups).filter((g) => g.building === B('Workshop'));

(async () => {
  await F.t('loads as a director with defaults and a duty', () => {
    const { cp } = F.load(['cp-buildout']);
    assert.ok(cp.directors().includes('buildout'));
    assert.strictEqual(typeof cp._buildout.furnitureSplit, 'function');
    assert.strictEqual(cp.cfg.keepFrameTimber, 1);
    assert.strictEqual(cp.cfg.concreteGate, 400);
    assert.ok(cp.duties().some((d) => /Stage C-D land, engine build-out, Farm conversion/.test(d.duty) && d.owner === 'Core plan'));
    F.unload();
  });

  await F.t('furniture split follows Heartland appetite, capped by planks', () => {
    const { cp } = F.load(['cp-buildout']);
    const s = cp._buildout.furnitureSplit(retail, 12040, cat);
    assert.strictEqual(s.source, 'board');
    // appetite x planks per unit: Bookshelf 150 x 30, Table 182 x 25, Chair 302 x 15 -> about a third each
    for (const k of ['bookshelf', 'table', 'chair']) assert.ok(Math.abs(s.shares[k] - 1 / 3) < 0.01, k + ' ' + s.shares[k]);
    assert.deepStrictEqual([s.bookshelf, s.table, s.chair, s.total], [5, 5, 7, 17]);
    assert.ok(s.bookshelf * 900 + s.table * 750 + s.chair * 562.5 <= 12040 * 1.05, 'no more Workshops than planks feed');
    assert.strictEqual(cp._buildout.furnitureSplit(retail, 0, cat).total, 0);
    const a5 = s.alloc(5);
    assert.strictEqual(a5.bookshelf + a5.table + a5.chair, 5);
    assert.ok(a5.chair >= a5.bookshelf, 'Chairs eat fewer planks, so more Workshops');
    const def = cp._buildout.furnitureSplit(null, 12040, cat);
    assert.strictEqual(def.source, 'default 40/30/30');
    assert.deepStrictEqual(def.shares, { bookshelf: 0.4, table: 0.3, chair: 0.3 });
    F.unload();
  });

  await F.t('Stage B on the live snapshot: the Kiln someone else paused is not resumed (manual)', () => {
    const { cp } = F.load(['cp-buildout']);
    const d = decideOn(cp, liveB());
    assert.strictEqual(d.stage, 'B');
    assert.ok(!bo(d) || bo(d).steps[0].msg.type !== 'SetPaused', bo(d)?.text);
    assert.match(d.readouts.buildout.kiln, /manual: Kiln group 10 is paused \(not by Core plan\): resume it for Blow Glass/);
    F.unload();
  });

  await F.t('Stage B switch waits for the furniture floor (manual) when none is saved and applying it is off', () => {
    const { cp } = F.load(['cp-buildout']);
    cp.cfg.applyFurnitureFloor = false; cp.cfg.landPaybackAB = 0;   // Stage B buys no acre here (plan D-1 rule closed): this test is about the switch / floors
    const st = liveB(); st.stock[0][I('Glass')] = 150; st.stock[0][I('Concrete')] = 500;
    const d = decideOn(cp, st);
    assert.ok(!bo(d), JSON.stringify(bo(d)));
    assert.match(boWait(d), /manual: apply the v1 floor for Make/);
    F.unload();
  });

  await F.t('Stage B switch on the live snapshot: whole spare group first, Rivet and 1 Frame Timber kept', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = liveReady();
    const a = bo(decideOn(cp, st));
    assert.deepStrictEqual(msgTypes(a), ['SetRecipe']);
    const m = a.steps[0].msg;
    assert.strictEqual(m.group, 8, 'the group of 2 fits a furniture gap whole');
    assert.ok([Rc('Make Bookshelf'), Rc('Make Table'), Rc('Make Chair')].includes(m.recipe));
    assert.notStrictEqual(m.group, 11, 'never the Rivet group');
    F.unload();
  });

  await F.t('runner: the Stage B switch stops at the planks the Sawmills make; with more Sawmills it ends at 1 Frame Timber + Rivet + 5 furniture', async () => {
    const st = liveReady();
    st.groups[2].count = 40;   // 40 Sawmills x 120 = 4,800 planks/h: room for the whole switch
    const { cp, w } = F.boot(st, { modules: ['cp-buildout'], catalog: cat, deals, retail });
    Object.assign(cp.cfg, { land: false, unlocks: false, confirmMs: 500, landPaybackAB: 0 });   // Stage B buys no acre here (plan D-1 rule closed): this test is about the switch / floors
    cp.start({ dryRun: false });
    for (let i = 0; i < 12; i++) { await F.waitFor(() => !cp.active); await cp._step(); }
    await F.waitFor(() => !cp.active);
    const ws = Object.values(st.groups).filter((g) => g.building === B('Workshop'));
    const on = (r) => ws.filter((g) => g.recipe === Rc(r)).reduce((a, g) => a + g.count, 0);
    assert.strictEqual(on('Assemble Wooden Frame'), 1);
    assert.strictEqual(st.groups[11].count, 1); assert.strictEqual(st.groups[11].recipe, Rc('Assemble Iron Frame'));
    assert.strictEqual(on('Make Bookshelf') + on('Make Table') + on('Make Chair'), 5);
    assert.ok(on('Make Chair') >= 1 && on('Make Table') >= 1, JSON.stringify(ws));
    assert.ok(!w.ws.sent.some((m) => m.type === 'BuyBuilding' || m.type === 'BuyLand'));
    assert.ok(w.ws.sent.every((m) => ['SetRecipe', 'UnassignBuildings', 'AssignBuildings', 'CreateGroup'].includes(m.type)), w.ws.sent.map((m) => m.type).join());
    assert.strictEqual(st.building_pool[0][B('Workshop')] ?? 0, 0, 'no Workshop left idle in the pool');
    cp.stop(); F.unload();
  });

  await F.t('Stage B switch on the live planks (3,600/h made and used): Chairs (fewer planks than Frame Timber) only, then it waits', () => {
    const { cp } = F.load(['cp-buildout']);
    cp.cfg.landPaybackAB = 0;   // Stage B buys no acre here (plan D-1 rule closed): this test is about the switch / floors
    const st = liveReady();
    const a = bo(decideOn(cp, st));
    assert.deepStrictEqual(a.steps[0].msg, { type: 'SetRecipe', group: 8, recipe: Rc('Make Chair') });
    st.groups[8].recipe = Rc('Make Chair');
    const d = decideOn(cp, st);
    assert.ok(!bo(d), bo(d)?.text);
    assert.match(boWait(d), /switch: planks 3600\/h made, 3525\/h used: more Sawmills before more furniture/);
    assert.match(boWait(d), /Workshop: switch the spare Frame Timber Workshops first|no free acre|Stage A-B rule closed/);
    F.unload();
  });

  await F.t('retailCap: the switch stops at the cap, the rest stays on Frame Timber, no furniture Workshop is bought past it', async () => {
    const st = liveReady();
    st.groups[2].count = 40;   // plank headroom, so only the cap stops the switch
    const { cp } = F.boot(st, { modules: ['cp-buildout'], catalog: cat, deals, retail });
    Object.assign(cp.cfg, { land: false, unlocks: false, confirmMs: 500, landPaybackAB: 0 });   // Stage B buys no acre here (plan D-1 rule closed): this test is about the switch / floors
    const ctx0 = cp._buildout.context;
    cp._buildout.context = (v, ctx) => { ctx.retailCap = 2; ctx0(v, ctx); };   // what the retail director's context sets
    cp.start({ dryRun: false });
    for (let i = 0; i < 8; i++) { await F.waitFor(() => !cp.active); await cp._step(); }
    await F.waitFor(() => !cp.active);
    const ws = Object.values(st.groups).filter((g) => g.building === B('Workshop'));
    const on = (r) => ws.filter((g) => g.recipe === Rc(r)).reduce((a, g) => a + g.count, 0);
    assert.strictEqual(on('Make Bookshelf') + on('Make Table') + on('Make Chair'), 2);
    assert.strictEqual(on('Assemble Wooden Frame'), 4);
    cp.stop();
    st.land_bought[0] += 40; st.items[F.MONEY] = 1e9;
    const v = cp._view(st, cat, deals), ctx = F.ctxOf({ retailBoard: retail, retailCap: 2 });
    for (const stage of ['B', 'C']) {
      const s = cp._buildout.nextBuildStep(v, ctx, cp._decide(v, ctx).rule, stage);
      assert.ok(!s.pick || !/^Make /.test(s.pick.r.name), JSON.stringify(s.pick));
    }
    F.unload();
  });

  await F.t('supplier before consumer: Workshop only when planks cover it, else Sawmill, else Camp when wood is short', () => {
    const { cp } = F.load(['cp-buildout']);
    const nb = cp._buildout.nextBuildStep;
    const st = stageC(switched(liveReady()));
    st.items[F.MONEY] = 1e9;
    const ctx = () => F.ctxOf({ retailBoard: retail, floorCents: 0 });
    let v = cp._view(st, cat, deals), rule = cp._decide(v, ctx()).rule;
    // planks: 30 Sawmills x 120 = 3600/h; FT 600 + 2 Chair 1125 = 1725/h used -> room for a Workshop
    let s = nb(v, ctx(), rule, 'C');
    assert.strictEqual(s.pick.bn, 'Workshop', JSON.stringify(s));
    // Planks fully used -> the supplier (Sawmill) comes first (FT kept at 1, so this is the planks gate, not the switch)
    st.groups[8].count = 6;   // FT 600 + 6 Chair 3375 = 3975/h > 3600/h made
    v = cp._view(st, cat, deals);
    s = nb(v, ctx(), rule, 'C');
    assert.strictEqual(s.pick.bn, 'Sawmill', JSON.stringify(s));
    // Wood supply short of the Sawmills -> a Camp first
    st.groups[0].count = 10;  // 10 Camps x 1080 = 10,800 < 31 Sawmills x 1200
    v = cp._view(st, cat, deals); rule = cp._decide(v, ctx()).rule;
    s = nb(v, ctx(), rule, 'C');
    assert.strictEqual(s.pick.bn, 'Lumber Camp', JSON.stringify(s));
    // A whole decide: the buy steps land, building, assign, held around the purchase
    st.groups[0].count = 50; st.groups[8].count = 2; st.groups[1].count = 0;   // no Farms left: no wave ahead of the buy
    const a = bo(decideOn(cp, st, { floorCents: 0 }));
    assert.ok(a.hold);
    assert.strictEqual(msgTypes(a).slice(-2)[0], 'BuyBuilding');
    assert.ok(['AssignBuildings', 'CreateGroup'].includes(msgTypes(a).slice(-1)[0]));
    F.unload();
  });

  await F.t('gates each say why: acre (Stage B), kit, wood (R8), bill floor, money floor', () => {
    const { cp } = F.load(['cp-buildout']);
    cp.cfg.bufferAcres = 16;   // these scenarios count free acres against the 16-acre buffer
    const nb = cp._buildout.nextBuildStep;
    const ctx = (o) => F.ctxOf({ retailBoard: retail, ...o });
    const ruleOf = (st) => cp._decide(cp._view(st, cat, deals), ctx()).rule;
    // Stage B with no free acre above the buffer: the acres come with the block while (acre + $1,200) / $1,444 <= cfg.landPaybackAB (plan D-1)
    let st = switched(liveReady());
    const sB = nb(cp._view(st, cat, deals), ctx(), ruleOf(st), 'B');
    assert.ok(sB.pick && sB.landCents > 0, JSON.stringify(sB));
    assert.strictEqual(sB.acres, cp._view(st, cat, deals).bld(sB.b).acres, 'only the block\'s own acres, the empty buffer is not refilled');
    cp.cfg.landPaybackAB = 1;
    assert.match(nb(cp._view(st, cat, deals), ctx(), ruleOf(st), 'B').wait, /acre #\d+ \$[\d,]+ \+ block \$1,200 pays back in \d+\.\d h > 1 h \(Stage A-B rule closed\)/);
    cp.cfg.landPaybackAB = 20;
    // Stage C from here on
    st = stageC(switched(liveReady())); st.items[F.MONEY] = 1e9;
    st.stock[0][I('Planks')] = 50;
    assert.match(nb(cp._view(st, cat, deals), ctx(), ruleOf(st), 'C').wait, /Workshop \(Make .*\): kit short: \d+ Planks/);
    st.stock[0][I('Planks')] = 6000; st.groups[3].count = 4;          // Sawmill next
    st.stock[0][I('Wood')] = 600;                                      // kit (66 Wood) fits, the gate (31 x 2 x 10) does not
    assert.match(nb(cp._view(st, cat, deals), ctx(), ruleOf(st), 'C').wait, /Sawmill: wood gate: Wood 600 < 620 \(Sawmills x 2 runs\)/);
    st.stock[0][I('Wood')] = 300000; st.groups[3].count = 1;          // Workshop next again
    const v = cp._view(st, cat, deals), rule = ruleOf(st);
    const ok = nb(v, ctx(), rule, 'C');
    assert.ok(ok.pick, JSON.stringify(ok));
    const bill = 1 * 2000 + 11 * 12000;   // 1 new MW x $20 + 11 MW x $120
    st.items[F.MONEY] = ok.cost + bill - 1;
    assert.match(nb(cp._view(st, cat, deals), ctx(), rule, 'C').wait, /bill floor: cash .* \(1 new MW x \$20 \+ 2 h of bills\)/);
    st.items[F.MONEY] = ok.cost + bill + 1000;
    assert.ok(nb(cp._view(st, cat, deals), ctx(), rule, 'C').pick);
    assert.match(nb(cp._view(st, cat, deals), ctx({ floorCents: 50000 }), rule, 'C').wait, /money floor: needs \$490 more above the floor \$500/);
    F.unload();
  });

  await F.t('B1 (plan D-1): Stage B, 20 free acres, buffer 16, a Sawmill wanted: the Sawmill goes first and no Cotton Farm is bought', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = switched(liveReady()); st.items[F.MONEY] = 1e9; st.stock[0][I('Wood')] = 300000;
    st.groups[3].count = 4;                                      // 4 Frame Timber Workshops eat the planks: a Sawmill is next
    st.land_bought[0] += 20 - cp._view(st, cat, deals).freeAcres;
    assert.strictEqual(cp._view(st, cat, deals).freeAcres, 20);
    const d = decideOn(cp, st);
    assert.strictEqual(d.stage, 'B');
    assert.match(d.actions[0]?.text ?? '', /^build-out: buy Sawmill /, d.waits.join(' | '));
    assert.ok(!msgTypes(d.actions[0]).includes('BuyLand'), 'built on the free acres');
    assert.ok(!d.actions.some((x) => x.id.startsWith('land:')), JSON.stringify(d.actions.map((x) => x.id)));
    assert.ok(d.waits.includes('land: build-out goes first (next Sawmill)'), d.waits.join(' | '));
    // buildout off: the land director buys the acre-free Cotton Farm as before
    cp.cfg.dir_buildout = false;
    const off = decideOn(cp, st);
    assert.ok(off.actions.some((x) => x.id.startsWith('land:')), off.waits.join(' | '));
    F.unload();
  });

  await F.t('L-fix: Stage B, build-out saving cash for its next block (bill / money floor): land waits; a kit-short wait lets land buy a Cotton Farm', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = switched(liveReady()); st.items[F.MONEY] = 1e9; st.stock[0][I('Wood')] = 300000;
    st.groups[3].count = 4;                                      // a Sawmill is next (as in B1)
    st.land_bought[0] += 20 - cp._view(st, cat, deals).freeAcres;
    const v = cp._view(st, cat, deals), ctx = F.ctxOf({ retailBoard: retail });
    const s = cp._buildout.nextBuildStep(v, ctx, cp._decide(v, ctx).rule, 'B');
    assert.strictEqual(s.pick?.bn, 'Sawmill', JSON.stringify(s));
    const floorCents = 1e8;
    st.items[F.MONEY] = s.cost + floorCents - 1;                 // a Cotton Farm fits above the floor, the Sawmill does not
    let d = decideOn(cp, st, { floorCents });
    assert.match(boWait(d), /next Sawmill: (bill|money) floor/);
    assert.ok(d.waits.includes('land: build-out is saving for Sawmill'), d.waits.join(' | '));
    assert.ok(!d.actions.some((x) => x.id.startsWith('land:')), JSON.stringify(d.actions.map((x) => x.id)));
    // kit short (Wood): land buys the Cotton Farm
    st.items[F.MONEY] = 1e9; st.stock[0][I('Wood')] = 10;
    d = decideOn(cp, st);
    assert.match(boWait(d), /next Sawmill: kit short/);
    assert.ok(d.actions.some((x) => x.id.startsWith('land:')), d.waits.join(' | '));
    F.unload();
  });

  await F.t('C5: the build-out publishes its next purchase for E5 (pendingInvest) until it is at target', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = stageC(switched(liveReady())); st.items[F.MONEY] = 1e9;
    const d = decideOn(cp, st, { floorCents: 0, netIncomeH: 1 });
    assert.match(d.E[4].why, /still to buy: .*build-out \(/, d.E[4].why);
    // at target (a rule with no planks, Camps or Sawmills left to build): nothing pending, so E5 can hold
    const v = cp._view(st, cat, deals), ctx = F.ctxOf({ retailBoard: retail, floorCents: 0 });
    const rule0 = { ...cp._decide(v, ctx).rule, planksH: 0, camps: 0, sawmills: 0 };
    assert.strictEqual(cp._buildout.nextBuildStep(v, ctx, rule0, 'D').done, true);
    assert.deepStrictEqual(cp._buildout.pendingInvest(v, ctx, rule0, 'D'), []);
    cp.cfg.dir_buildout = false;
    assert.ok(!/build-out \(/.test(decideOn(cp, st, { floorCents: 0, netIncomeH: 1 }).E[4].why), 'director off: nothing published');
    F.unload();
  });

  await F.t('Farm conversion: 4 waves 3 h apart, never early, never before the last wave runs, never while CD Farm runs', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = stageC(switched(liveReady())); st.items[F.MONEY] = 1;
    const mem = sharedMem();
    let now = 1.8e12;
    // 2 Chair Workshops are off the board's split: after 6 h the rebalance would take the step, so it is held off in this test about waves
    const rbMem = sharedMem();
    cp._decide(cp._view(st, cat, deals), F.ctxOf({ retailBoard: retail, mem: rbMem, now }));
    assert.match(bo(cp._decide(cp._view(st, cat, deals), F.ctxOf({ retailBoard: retail, mem: rbMem, now: now + 7 * HOUR })))?.id ?? '', /^bo:rebal:/);
    cp.cfg.rebalanceHours = 1000;
    const ctx = (o) => F.ctxOf({ retailBoard: retail, mem, now, ...o });
    const dec = (o) => cp._decide(cp._view(st, cat, deals), ctx(o));
    const cotton = st.groups[1];
    // CD Farm busy: no wave
    assert.match(boWait(dec({ mods: { cdFarm: { running: true, active: false, farmUnits: {} } } })), /conversion: CD Farm is running/);
    const fill = () => { const v = cp._view(st, cat, deals); st.groups[0].count += Math.max(0, v.freeAcres - cp.cfg.bufferAcres); };   // the build-out filling the acres
    const sizes = [];
    // Cash for the wave gate (3 replacement buildings + bills) but not for a buy that also needs an acre: only waves act.
    const gateCash = () => { const v = cp._view(st, cat, deals), c = ctx(); return cp._buildout.waveGate(v, c, cp._decide(v, c).rule, 'C', 22).need; };
    for (let k = 0; k < 4; k++) {
      st.items[F.MONEY] = 1;
      assert.match(boWait(dec()), /conversion: wave \d waits: (nothing can be built|cash)/, 'no wave without the cash to rebuild');
      st.items[F.MONEY] = gateCash();
      const a = bo(dec());
      assert.ok(a && a.id === 'bo:wave:' + k, 'wave ' + k + ': ' + (a?.text ?? boWait(dec())));
      assert.deepStrictEqual(msgTypes(a), ['UnassignBuildings', 'DemolishBuilding']);
      assert.ok(a.hold);
      const n = a.steps[0].msg.amount; sizes.push(n);
      assert.strictEqual(a.steps[1].msg.amount, n);
      cotton.count -= n;              // the server applies the wave
      st.items[F.MONEY] = 1;          // no buys on the freed acres in this test
      dec();                          // context records it at "now"
      if (k === 3) break;
      now += 3 * HOUR - 60000;
      assert.match(boWait(dec()), /conversion: next wave in 1 min/);
      now += 60000;
      st.groups[0].equipped = st.groups[0].count - 1;      // a Camp group not equipped yet
      assert.match(boWait(dec()), /conversion: last wave not running yet: group 0/);
      delete st.groups[0].equipped;
      assert.match(boWait(dec()), /conversion: \d+ acres of the last wave not built yet/);
      fill();
      assert.match(boWait(dec({ mods: { cdFarm: { running: false, active: true, farmUnits: {} } } })), /CD Farm is running/);
    }
    assert.deepStrictEqual(sizes, [22, 22, 22, 22]);
    assert.strictEqual(cotton.count, 0);
    assert.ok(!dec().actions.some((a) => a.director === 'buildout' && /wave/.test(a.id)));
    assert.strictEqual(mem('buildout').get().wave, 4);
    F.unload();
  });

  await F.t('runner with a real localStorage: wave 1 lands, the next step waits 3 h (no second wave)', async () => {
    globalThis.localStorage = F.mem();
    const st = stageC(switched(liveReady()));
    const { cp, w } = F.boot(st, { modules: ['cp-buildout'], catalog: cat, deals, retail });
    Object.assign(cp.cfg, { land: false, unlocks: false, confirmMs: 500 });
    st.items[F.MONEY] = gateCashOf(cp, st);
    cp.start({ dryRun: false });
    for (let i = 0; i < 4; i++) { await F.waitFor(() => !cp.active); await cp._step(); }
    await F.waitFor(() => !cp.active);
    st.items[F.MONEY] = 1e9;   // plenty of cash now: still no second wave inside the 3 h gap
    for (let i = 0; i < 2; i++) { await cp._step(); await F.waitFor(() => !cp.active); }
    const types = w.ws.sent.map((m) => m.type);
    assert.strictEqual(types.filter((x) => x === 'UnassignBuildings').length, 1, types.join());
    assert.strictEqual(types.filter((x) => x === 'DemolishBuilding').length, 1, types.join());
    assert.strictEqual(st.groups[1].count, 66);
    st.items[F.MONEY] = 1; await cp._step(); await F.waitFor(() => !cp.active);
    assert.match(cp.status().waits.join(' | '), /conversion: next wave in 1[78]\d min/);
    cp.stop(); F.unload();
  });

  await F.t('no conversion in Stage B', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = switched(liveReady()); st.items[F.MONEY] = 1;
    const d = decideOn(cp, st);
    assert.ok(!bo(d), bo(d)?.text);
    assert.match(d.readouts.buildout.waves, /Stage C: 88 cotton Farms to convert/);
    F.unload();
  });

  await F.t('Kiln gate: switch to Concrete once Glass is in, pause when both are in', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = switched(liveReady());
    st.groups[10].paused = false; st.stock[0][I('Glass')] = 150; st.stock[0][I('Concrete')] = 378;
    let a = bo(decideOn(cp, st));
    assert.deepStrictEqual(a.steps[0].msg, { type: 'SetRecipe', group: 10, recipe: Rc('Mix Concrete') });
    st.groups[10].recipe = Rc('Mix Concrete'); st.stock[0][I('Concrete')] = 400;
    a = bo(decideOn(cp, st));
    assert.deepStrictEqual(a.steps[0].msg, { type: 'SetPaused', group: 10, paused: true });
    st.groups[10].paused = true;
    assert.ok(!bo(decideOn(cp, st)) || !/Kiln/.test(bo(decideOn(cp, st)).text));
    F.unload();
  });

  await F.t('pool tidy: an own Workshop in the pool is assigned, cdFarm Camps in the pool are left alone', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = switched(liveReady());
    st.building_pool[0][B('Workshop')] = 1;
    let a = bo(decideOn(cp, st));
    assert.ok(['AssignBuildings', 'CreateGroup'].includes(a.steps[0].msg.type), a.text);   // where the split is shortest
    assert.strictEqual(a.steps[0].msg.amount, 1);
    assert.ok(!bo(decideOn(cp, st)).steps.some((s) => s.msg.type === 'BuyBuilding'), 'pool first, no purchase');
    st.building_pool[0][B('Workshop')] = 0;
    st.building_pool[0][B('Lumber Camp')] = 5;
    a = bo(decideOn(cp, st, { mods: { cdFarm: { running: true, active: true, farmUnits: { [B('Lumber Camp')]: 5 } } } }));
    assert.ok(!a || a.steps[0].msg.type !== 'AssignBuildings', a?.text);
    a = bo(decideOn(cp, st));
    assert.deepStrictEqual(a.steps[0].msg, { type: 'AssignBuildings', group: 0, amount: 5 });
    F.unload();
  });

  // A Stage B corp with free acres above the buffer: the next buildout action is a Workshop purchase.
  function buyReady() { const st = switched(liveReady()); st.land_bought[0] += 30; return st; }

  await F.t('runner: one real purchase sequence (BuyBuilding + CreateGroup, then SetRecipe) applied by the server', async () => {
    const st = buyReady();
    const { core, cp, w } = F.boot(st, { modules: ['cp-buildout'], catalog: cat, deals, retail });
    Object.assign(cp.cfg, { land: false, unlocks: false, confirmMs: 500 });
    const money0 = st.items[F.MONEY], planks0 = st.stock[0][I('Planks')];
    const ws0 = Object.values(st.groups).filter((g) => g.building === B('Workshop')).reduce((a, g) => a + g.count, 0);
    cp.start({ dryRun: false });
    await F.waitFor(() => w.ws.sent.length >= 2); await F.waitFor(() => !cp.active);
    await cp._step(); await F.waitFor(() => !cp.active);
    // the largest furniture gap has no group yet, so the new Workshop gets its own group and then its recipe
    assert.deepStrictEqual(w.ws.sent.slice(0, 3).map((m) => m.type), ['BuyBuilding', 'CreateGroup', 'SetRecipe']);
    const ng = st.groups[w.ws.sent[2].group];
    assert.strictEqual(ng.building, B('Workshop')); assert.strictEqual(ng.count, 1);
    assert.strictEqual(C_name(ng.recipe), ng.name);
    assert.strictEqual(w.ws.sent[0].building, B('Workshop'));
    const ws1 = Object.values(st.groups).filter((g) => g.building === B('Workshop')).reduce((a, g) => a + g.count, 0);
    assert.strictEqual(ws1, ws0 + 1);
    assert.strictEqual(st.building_pool[0][B('Workshop')], 0);
    assert.strictEqual(money0 - st.items[F.MONEY], Math.floor(500000 * (20 + ws0) / 20));
    assert.strictEqual(planks0 - st.stock[0][I('Planks')], 100);
    assert.match(core.ledger.text(), /build-out: buy Workshop \(Make /);
    cp.stop(); F.unload();
  });

  await F.t('chaos: a group move the server ignores never leads to a second BuyBuilding', async () => {
    const st = buyReady();
    const { cp, w } = F.boot(st, { modules: ['cp-buildout'], catalog: cat, deals, retail, ignore: ['AssignBuildings', 'CreateGroup'] });
    Object.assign(cp.cfg, { land: false, unlocks: false, confirmMs: 200 });
    cp.start({ dryRun: false });
    for (let i = 0; i < 5; i++) { await F.waitFor(() => !cp.active); await cp._step(); }
    await F.waitFor(() => !cp.active);
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'BuyBuilding').length, 1, w.ws.sent.map((m) => m.type).join());
    assert.ok(w.ws.sent.filter((m) => m.type === 'AssignBuildings' || m.type === 'CreateGroup').length >= 2, 'it retries from the pool');
    assert.strictEqual(st.building_pool[0][B('Workshop')], 1);
    assert.ok(!cp.running, 'stopped after 3 unconfirmed actions');
    F.unload();
  });

  await F.t('chaos: an ignored DemolishBuilding never unassigns a second wave', async () => {
    globalThis.localStorage = F.mem();
    const st = stageC(switched(liveReady()));
    const { cp, w } = F.boot(st, { modules: ['cp-buildout'], catalog: cat, deals, retail, ignore: ['DemolishBuilding'] });
    Object.assign(cp.cfg, { land: false, unlocks: false, confirmMs: 200 });
    st.items[F.MONEY] = gateCashOf(cp, st);
    cp.start({ dryRun: false });
    for (let i = 0; i < 5; i++) { await F.waitFor(() => !cp.active); await cp._step(); }
    await F.waitFor(() => !cp.active);
    const types = w.ws.sent.map((m) => m.type);
    assert.strictEqual(types.filter((x) => x === 'UnassignBuildings').length, 1, types.join());
    assert.ok(types.filter((x) => x === 'DemolishBuilding').length >= 2, 'the leftover pool Farms are retried, not a new wave');
    assert.strictEqual(st.groups[1].count, 66);
    F.unload();
  });

  await F.t('dry run sends nothing and says what it would buy', async () => {
    const st = buyReady();
    const { core, cp, w } = F.boot(st, { modules: ['cp-buildout'], catalog: cat, deals, retail });
    Object.assign(cp.cfg, { land: false, unlocks: false });
    cp.start({ dryRun: true });
    await cp._step();
    assert.strictEqual(w.ws.sent.length, 0);
    assert.match(core.ledger.text(), /dry run, would: build-out: buy Workshop/);
    cp.stop(); F.unload();
  });

  // ---- fix pass: switch / tidy agree, one group per recipe, wave gates, wave memory, Kiln ownership ----------------------------
  function oneFtGroup(floors) {
    const st = liveB();
    for (const n of floors) st.layouts[Rc(n)] = F.clone(st.layouts[Rc('Assemble Wooden Frame')]);
    st.stock[0][I('Glass')] = 150; st.stock[0][I('Concrete')] = 500;
    st.groups[3].count = 6; delete st.groups[8]; st.groups[2].count = 60;   // one Frame Timber group of 6, 7,200 planks/h
    return st;
  }
  async function runSteps(st, n, o = {}) {
    const { cp, w } = F.boot(st, { modules: ['cp-buildout'], catalog: cat, deals, retail, ...o });
    Object.assign(cp.cfg, { land: false, unlocks: false, confirmMs: 300, applyFurnitureFloor: !!o.applyFloor, landPaybackAB: 0 });   // these runs test the switch with a floor missing; Stage B buys no acre here (plan D-1 rule closed)
    cp.start({ dryRun: false });
    for (let i = 0; i < n; i++) { await F.waitFor(() => !cp.active); await cp._step(); }
    await F.waitFor(() => !cp.active);
    return { cp, w };
  }

  await F.t('furniture floor: EditLayout with the core Workshop v1 design, one recipe at a time; Autopilot live keeps the duty', () => {
    const { core, cp } = F.load(['cp-buildout']);
    const st = liveB(); st.stock[0][I('Glass')] = 150; st.stock[0][I('Concrete')] = 500;
    const a = bo(decideOn(cp, st));
    assert.ok(a && a.id.startsWith('floor:'), JSON.stringify(a));
    const m = a.steps[0].msg;
    assert.strictEqual(m.type, 'EditLayout');
    assert.strictEqual(Object.keys(m.cells).length, core.floorDesigns.workshopV1.split(' ').length);
    assert.deepStrictEqual(m.cells['10,2'], { item: 116, rot: 2 });
    st.layouts[m.recipe] = { cells: m.cells, fx: { rate: 5 } };
    const b = bo(decideOn(cp, st));
    assert.ok(!b || b.steps[0].msg.recipe !== m.recipe, 'the next floor is another recipe: ' + JSON.stringify(b?.steps?.[0]?.msg?.recipe));
    // Autopilot live: no Workshop runs furniture yet, so nothing is equipped there and Core plan still applies the floor.
    const busy = decideOn(cp, liveB(), { mods: { earlyGame: { busy: true, running: true, cfg: { floorUpgrades: true } } } });
    assert.ok(busy.actions.some((x) => x.id?.startsWith('floor:')), busy.waits.join(' | '));
    F.unload();
  });

  // ---- fix pass 2: floors for the buy path, Autopilot's share, parts, backoff ----------------------------------------------------------
  const floorSt = () => { const st = liveB(); st.stock[0][I('Glass')] = 150; st.stock[0][I('Concrete')] = 500; return st; };
  const tableRunning = (st, n = 6) => { for (const r of ['Make Bookshelf', 'Make Chair']) st.layouts[Rc(r)] = F.clone(st.layouts[Rc('Assemble Wooden Frame')]); st.groups[8].recipe = Rc('Make Table'); st.groups[8].count = n; st.groups[8].name = 'Make Table'; st.groups[3].count = 1; return st; };   // no spare Frame Timber: nothing to switch
  const apLive = (up) => ({ mods: { earlyGame: { busy: true, running: true, cfg: { floorUpgrades: up } } } });

  await F.t('furniture floor: Frame Timber at its keep and no furniture yet: the buy path still gets its floor', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = floorSt(); st.groups[3].count = 1; delete st.groups[8];
    const d = decideOn(cp, st);
    assert.ok(bo(d)?.id?.startsWith('floor:'), boWait(d));
    F.unload();
  });

  await F.t('furniture floor: Autopilot live keeps only recipes with running Workshops, and only with its floor upgrades on', () => {
    const { cp } = F.load(['cp-buildout']);
    cp.cfg.landPaybackAB = 0;   // Stage B buys no acre here (plan D-1 rule closed): this test is about the switch / floors
    const st = tableRunning(floorSt());
    let d = decideOn(cp, st, apLive(true));
    assert.ok(!d.actions.some((x) => x.id?.startsWith('floor:')), JSON.stringify(bo(d)));
    assert.match(boWait(d), /Autopilot applies the Make Table floor/);
    d = decideOn(cp, st, apLive(false));
    assert.strictEqual(bo(d)?.id, 'floor:' + Rc('Make Table'), boWait(d));
    F.unload();
  });

  await F.t('furniture floor on running Workshops: only with the added parts for every building in stock, net of reserves', () => {
    const { cp } = F.load(['cp-buildout']);
    cp.cfg.landPaybackAB = 0;   // Stage B buys no acre here (plan D-1 rule closed): this test is about the switch / floors
    const st = tableRunning(floorSt());
    st.stock[0][I('Iron Ore')] = 300;   // 6 x (66 - 14) = 312 needed
    let d = decideOn(cp, st);
    assert.ok(!d.actions.some((x) => x.id?.startsWith('floor:')), JSON.stringify(bo(d)));
    assert.match(boWait(d), /floors: Make Table .*parts.*12 more Iron Ore/);
    st.stock[0][I('Iron Ore')] = 570;
    d = decideOn(cp, st);
    assert.strictEqual(bo(d)?.id, 'floor:' + Rc('Make Table'), boWait(d));
    d = decideOn(cp, st, { reserveItems: { [I('Iron Ore')]: 300 } });
    assert.ok(!d.actions.some((x) => x.id?.startsWith('floor:')), JSON.stringify(bo(d)));
    assert.match(boWait(d), /floors: Make Table .*parts/);
    F.unload();
  });

  await F.t('runner: the server rejects the floor: one EditLayout, then a backoff; Core plan keeps running', async () => {
    const st = oneFtGroup([]);
    const { cp, w } = await runSteps(st, 6, { applyFloor: true, ignore: ['EditLayout'] });
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'EditLayout').length, 1, w.ws.sent.map((m) => m.type).join());
    assert.ok(cp.running, 'still running');
    assert.match(cp.status().waits.join(' | '), /floors: .*retry/);
    cp.stop(); F.unload();
  });

  await F.t('runner: the server applies EditLayout: every furniture floor lands and Workshops move to furniture', async () => {
    const st = oneFtGroup([]);
    const { cp, w } = await runSteps(st, 14, { applyFloor: true });
    for (const r of ['Make Bookshelf', 'Make Table', 'Make Chair']) assert.ok(st.layouts[Rc(r)], r + ' floor: ' + w.ws.sent.map((m) => m.type).join());
    const furn = wsGroups(st).filter((g) => g.count > 0 && /^Make /.test(C_name(g.recipe) ?? '')).reduce((a, g) => a + g.count, 0);
    assert.ok(furn >= 1, JSON.stringify(wsGroups(st)));
    cp.stop(); F.unload();
  });

  await F.t('runner: one furniture floor missing: freed Workshops go to a recipe with a floor, never back to Frame Timber (no loop)', async () => {
    const st = oneFtGroup(['Make Bookshelf', 'Make Table']);
    const { cp, w } = await runSteps(st, 14);
    const sent = w.ws.sent;
    assert.ok(!sent.some((m) => m.type === 'AssignBuildings' && m.group === 3), 'nothing assigned back into Frame Timber: ' + sent.map((m) => m.type + ':' + m.group).join());
    assert.ok(sent.filter((m) => m.type === 'UnassignBuildings').length <= 2, sent.map((m) => m.type).join());
    const on = (r) => wsGroups(st).filter((g) => g.recipe === Rc(r)).reduce((a, g) => a + g.count, 0);
    assert.ok(on('Make Table') + on('Make Bookshelf') >= 1, JSON.stringify(wsGroups(st)));
    assert.strictEqual(on('Make Chair'), 0);
    assert.strictEqual(st.building_pool[0][B('Workshop')] ?? 0, 0, 'no Workshop idle in the pool');
    assert.match(cp.status().waits.join(' | '), /manual: apply the v1 floor for Make Chair/);
    cp.stop(); F.unload();
  });

  await F.t('chaos: the switch places its Workshops but the server ignores it: they never go back to Frame Timber', async () => {
    const st = oneFtGroup(['Make Bookshelf', 'Make Table']);
    const { cp, w } = await runSteps(st, 8, { ignore: ['CreateGroup', 'AssignBuildings'] });
    const sent = w.ws.sent;
    assert.ok(!sent.some((m) => m.type === 'AssignBuildings' && m.group === 3), sent.map((m) => m.type + ':' + (m.group ?? m.name)).join());
    assert.strictEqual(sent.filter((m) => m.type === 'UnassignBuildings').length, 1, sent.map((m) => m.type).join());
    assert.ok(!cp.running, 'stopped after 3 unconfirmed actions');
    F.unload();
  });

  await F.t('runner: all floors saved: the split ends with one group per furniture recipe (no duplicate CreateGroup)', async () => {
    const st = oneFtGroup(['Make Bookshelf', 'Make Table', 'Make Chair']);
    const { cp, w } = await runSteps(st, 14);
    const furn = wsGroups(st).filter((g) => g.count > 0 && /^Make /.test(C_name(g.recipe) ?? ''));
    const names = furn.map((g) => C_name(g.recipe));
    assert.strictEqual(new Set(names).size, names.length, 'one group per recipe: ' + JSON.stringify(furn));
    assert.ok(furn.every((g) => g.name === C_name(g.recipe)));
    assert.strictEqual(wsGroups(st).filter((g) => g.recipe === Rc('Assemble Wooden Frame')).reduce((a, g) => a + g.count, 0), 1);
    assert.ok(!w.ws.sent.some((m) => m.type === 'AssignBuildings' && m.group === 3));
    cp.stop(); F.unload();
  });

  await F.t('homeGroup: a pool Workshop joins a new group still waiting for its recipe instead of making another', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = switched(liveReady());
    st.groups[13] = { building: B('Workshop'), region: 0, count: 1, recipe: null, name: 'Make Table', modules: {} }; st.next_group_id = 14;
    st.building_pool[0][B('Workshop')] = 1;
    // tg says Table has the biggest gap (no Table Workshop yet); planks have room for one more Table
    const a = bo(decideOn(cp, st));
    assert.ok(a, boWait(decideOn(cp, st)));
    assert.deepStrictEqual(a.steps[0].msg, { type: 'AssignBuildings', group: 13, amount: 1 }, a.text);
    F.unload();
  });

  await F.t('wave gate: no wave with $1 cash, and none when the kit for the replacement blocks is short', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = stageC(switched(liveReady())); st.items[F.MONEY] = 100;
    let d = decideOn(cp, st);
    assert.ok(!bo(d) || !/wave/.test(bo(d).id), bo(d)?.text);
    assert.match(boWait(d), /conversion: wave 1 waits: /);
    st.items[F.MONEY] = 1e9;
    st.stock[0] = { [I('Glass')]: 150, [I('Concrete')]: 500 };
    d = decideOn(cp, st);
    assert.ok(!bo(d) || !/wave/.test(bo(d).id), bo(d)?.text);
    assert.match(boWait(d), /conversion: wave 1 waits: .*(kit short|nothing can be built)/);
    st.stock[0] = liveReady().stock[0];
    d = decideOn(cp, st);
    assert.strictEqual(bo(d)?.id, 'bo:wave:0', boWait(d));
    // a group outside the plan eats Cotton (Textile Mill on Spin Thread): no Farm is demolished
    st.groups[95] = { building: B('Textile Mill'), region: 0, count: 1, recipe: Rc('Spin Thread'), paused: true, modules: {} };
    d = decideOn(cp, st);
    assert.ok(!bo(d) || !/wave/.test(bo(d).id), bo(d)?.text);
    const ws = cp._buildout.waveStep(cp._view(st, cat, deals), F.ctxOf({ retailBoard: retail, boMemOk: true, mem: () => ({ get: () => ({ base: 88, wave: 0 }), set() { } }) }), d.rule, 'C');
    assert.match(ws.wait, /conversion: group 95 \(Spin Thread\) eats Cotton: Farms stay/);
    F.unload();
  });

  await F.t('pool tidy: with a user Workshop group, only Workshops the plan left in the pool are taken; a user recipe-less group keeps no recipe', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = switched(liveReady());
    st.building_pool[0][B('Workshop')] = 2;
    const mem = sharedMem(), dec = () => decideOn(cp, st, { mem });
    let a = bo(dec());
    assert.ok(a && /^bo:(assign|create)/.test(a.id), 'no user group: pooled Workshops are tidied: ' + (a?.text ?? boWait(dec())));
    st.groups[96] = { building: B('Workshop'), region: 0, count: 3, recipe: Rc('Make Desk'), modules: {} };   // the user's Desk group
    a = bo(dec());
    assert.ok(!a || !/^bo:(assign|create)/.test(a.id), 'the user may be placing them: ' + a?.text);
    mem('buildout').set({ poolMine: { [B('Workshop')]: 1 } });
    a = bo(dec());
    assert.ok(a && /^bo:(assign|create)/.test(a.id), boWait(dec()));
    assert.strictEqual(a.steps[0].msg.amount, 1, 'only the one the plan left there');
    // confirming it records the unit as placed (poolMine back to 0)
    a.steps[0].until({ groups: Object.entries(st.groups).map(([id, g]) => ({ id: +id, ...g, count: g.count + 1 })), pool: {} });
    assert.strictEqual(mem('buildout').get().poolMine[B('Workshop')], 0);
    // a recipe-less Workshop group the user made (not named after a plan recipe) gets no recipe
    st.building_pool[0][B('Workshop')] = 0;
    st.groups[97] = { building: B('Workshop'), region: 0, count: 1, recipe: null, name: 'My shop', modules: {} };
    a = bo(dec());
    assert.ok(!a || a.id !== 'bo:recipe:97:' + Rc('Assemble Wooden Frame'), a?.text);
    assert.ok(!a || !String(a.id).startsWith('bo:recipe:97'), a?.text);
    mem('buildout').set({ groupsMine: [97] });
    assert.ok(String(bo(dec())?.id).startsWith('bo:recipe:97'), 'a group the plan made gets its recipe');
    F.unload();
  });

  await F.t('runner without browser storage (or with a full one): no Farm wave at all, it says why', async () => {
    for (const store of [null, { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem() { } }]) {
      if (store) globalThis.localStorage = store; else delete globalThis.localStorage;
      const st = stageC(switched(liveReady()));
      const { cp, w } = F.boot(st, { modules: ['cp-buildout'], catalog: cat, deals, retail });
      Object.assign(cp.cfg, { land: false, unlocks: false, confirmMs: 300, applyFurnitureFloor: false });
      st.items[F.MONEY] = gateCashOf(cp, st);
      cp.start({ dryRun: false });
      for (let i = 0; i < 6; i++) { await F.waitFor(() => !cp.active); await cp._step(); }
      await F.waitFor(() => !cp.active);
      const types = w.ws.sent.map((m) => m.type);
      assert.ok(!types.includes('UnassignBuildings') && !types.includes('DemolishBuilding'), types.join());
      assert.strictEqual(st.groups[1].count, 88);
      const d = cp._decide(cp._view(st, cat, deals), F.ctxOf({ retailBoard: retail, mem: () => ({ get: () => ({}), set() { } }) }));
      assert.match(boWait(d), /conversion: wave memory not saved/);
      cp.stop(); F.unload();
    }
  });

  await F.t('Kiln: resumes only a Kiln it paused, leaves one the user resumed, needs the bill floor to resume', async () => {
    globalThis.localStorage = F.mem();
    const st = switched(liveReady());
    st.groups[10].paused = false;                       // Glass Kiln running, Glass 150 and Concrete 500: at the gates
    const { cp, w } = F.boot(st, { modules: ['cp-buildout'], catalog: cat, deals, retail });
    Object.assign(cp.cfg, { land: false, unlocks: false, confirmMs: 300, applyFurnitureFloor: false, landPaybackAB: 0, bufferAcres: 16 });   // Stage B buys no acre here (plan D-1 rule closed)
    cp.start({ dryRun: false });
    const step = async () => { await F.waitFor(() => !cp.active); await cp._step(); await F.waitFor(() => !cp.active); };
    await step();
    assert.deepStrictEqual(w.ws.sent.pop(), { type: 'SetPaused', group: 10, paused: true });
    assert.strictEqual(st.groups[10].paused, true);
    st.stock[0][I('Glass')] = 40;                        // Glass used up: our paused Kiln comes back, if the cash covers the bills
    const money = st.items[F.MONEY];
    st.items[F.MONEY] = 100;
    await step();
    assert.ok(!w.ws.sent.some((m) => m.type === 'SetPaused'), 'no resume below the bill floor');
    assert.match(cp.status().readouts?.buildout?.kiln ?? cp.status().waits.join(), /Kiln gate: resume group 10 waits: cash/);
    st.items[F.MONEY] = money;
    await step();
    assert.deepStrictEqual(w.ws.sent.pop(), { type: 'SetPaused', group: 10, paused: false });
    st.stock[0][I('Glass')] = 150;
    await step();
    assert.deepStrictEqual(w.ws.sent.pop(), { type: 'SetPaused', group: 10, paused: true });
    st.groups[10].paused = false;                        // the user resumes it at the gate
    for (let i = 0; i < 3; i++) await step();
    assert.ok(!w.ws.sent.some((m) => m.type === 'SetPaused'), 'never paused again after the user resumed it: ' + JSON.stringify(w.ws.sent));
    assert.strictEqual(st.groups[10].paused, false);
    cp.stop(); F.unload();
  });

  await F.t('land rule: the Retail Store (3) and Assembly Plant (5) acres are extra only until they are built', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = liveReady();
    const fixed = (s) => { const v = cp._view(s, cat, deals); return { v, rule: decideOn(cp, s).rule }; };
    let { v, rule } = fixed(st);
    assert.strictEqual(rule.fixedAcres, v.fixedAcres + 8, 'nothing built: both extra');
    st.building_pool[0][B('Retail Store')] = 1;
    ({ v, rule } = fixed(st));
    assert.strictEqual(rule.fixedAcres, v.fixedAcres + 5, 'store owned: its 3 acres are in used - engine already');
    st.building_pool[0][B('Assembly Plant')] = 1;
    ({ v, rule } = fixed(st));
    assert.strictEqual(rule.fixedAcres, v.fixedAcres, 'both owned: nothing extra');
    F.unload();
  });

  await F.t('Wooden Frame gate (B6): pause Frame Timber at the keep line, resume below half, leave a group the user resumed; none on the fail path after a pass', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = switched(liveReady()), mem = sharedMem(), WF = I('Wooden Frame');
    const pause = (o = {}) => { const a = bo(decideOn(cp, st, { mem, ...o })); return a?.id?.startsWith('bo:pause:3:') ? a : null; };
    // keep line = Rivet use for 2 h at its layout rate: 1 Workshop x 3600 / (1800 ticks / 2) x rate 3 x 2 Wooden Frames x 2 h = 48,
    // capped at cfg.ftKeepMax 19 so the stock settles under 20 (E3)
    const keep = cp._buildout.wfKeep(cp._view(st, cat, deals), F.ctxOf());
    assert.strictEqual(keep, 19);
    cp.cfg.ftKeepMax = 1000;
    assert.strictEqual(cp._buildout.wfKeep(cp._view(st, cat, deals), F.ctxOf()), 48, 'uncapped: 2 h of Rivet use');
    cp.cfg.ftKeepMax = 19;
    st.stock[0][WF] = 18;
    assert.strictEqual(pause(), null, 'below the line: runs');
    st.stock[0][WF] = 19;
    let a = pause();
    assert.deepStrictEqual(a.steps[0].msg, { type: 'SetPaused', group: 3, paused: true });
    st.groups[3].paused = true;
    assert.ok(a.steps[0].until(cp._view(st, cat, deals)));   // the confirm records it as ours
    assert.deepStrictEqual(mem('buildout').get().ftMine, [3]);
    st.stock[0][WF] = 10;
    assert.strictEqual(pause(), null, 'half the line: stays paused');
    st.stock[0][WF] = 9;
    a = pause();
    assert.deepStrictEqual(a.steps[0].msg, { type: 'SetPaused', group: 3, paused: false });
    st.groups[3].paused = false;
    assert.ok(a.steps[0].until(cp._view(st, cat, deals)));
    assert.deepStrictEqual(mem('buildout').get().ftMine, []);
    // paused again, then the user resumes it at the line: never paused again
    st.stock[0][WF] = 60;
    a = pause(); st.groups[3].paused = true; a.steps[0].until(cp._view(st, cat, deals));
    st.groups[3].paused = false;
    assert.strictEqual(pause(), null, 'the user resumed it');
    assert.deepStrictEqual(mem('buildout').get().ftUser, [3]);
    // retail fail before a pass: no CD need, so the gate still bounds the frames
    const fail = { retailOk: false, retailFail: true, retailFailPath: true };
    assert.deepStrictEqual(bo(decideOn(cp, st, { mem: sharedMem(), ...fail })).steps[0].msg, { type: 'SetPaused', group: 3, paused: true });
    // fail path after a pass with no CD need (Refinery started, or the ladder not loaded) or CD Farm not on Auto: the gate still pauses
    const auto = (o = {}) => ({ cdFarm: { cfg: { building: 'auto', autoStart: true, ...o } } }), need = { name: 'Oil Rig', cd: 20000 };
    for (const o of [{ ladderNeed: false, mods: auto() }, { mods: auto() }, { ladderNeed: need, mods: auto({ autoStart: false }) }, { ladderNeed: need, mods: auto({ building: 'Farm' }) }, { ladderNeed: need }])
      assert.deepStrictEqual(bo(decideOn(cp, st, { mem: sharedMem(), retailOk: true, retailFailPath: true, ...o }))?.steps[0].msg, { type: 'SetPaused', group: 3, paused: true }, JSON.stringify(o));
    // fail path after a pass, a CD need and Auto on: CD Farm burns the frames above the line, so nothing is paused and a group paused here comes back
    const mem2 = sharedMem(), burn = { retailOk: true, retailFailPath: true, ladderNeed: need, mods: auto() };
    assert.strictEqual(bo(decideOn(cp, st, { mem: mem2, ...burn }))?.id?.startsWith('bo:pause:3:') ?? false, false);
    mem2('buildout').set({ ftMine: [3] }); st.groups[3].paused = true;
    assert.deepStrictEqual(bo(decideOn(cp, st, { mem: mem2, ...burn })).steps[0].msg, { type: 'SetPaused', group: 3, paused: false });
    F.unload();
  });

  await F.t('D3 rebalance: the board moves 6/5/7 -> 4/5/9 for 6 h: one Workshop per step until it matches; a 2 h blip moves nothing', () => {
    const { cp } = F.load(['cp-buildout']);
    cp.cfg.landPaybackAB = 0;
    const st = switched(liveReady());
    st.groups[2].count = 200;                                   // plank headroom: only the rebalance rules decide
    st.groups[8].count = 7;                                     // Chair 7
    st.groups[20] = { building: B('Workshop'), region: 0, count: 4, recipe: Rc('Make Bookshelf'), modules: { '0,-1': 0 } };   // module id 0 counts
    st.groups[21] = { building: B('Workshop'), region: 0, count: 2, recipe: Rc('Make Bookshelf'), modules: {} };
    st.groups[22] = { building: B('Workshop'), region: 0, count: 5, recipe: Rc('Make Table'), modules: {} };
    st.next_group_id = 30;
    const board = (a, b, c) => ({ shelves: { 0: { [I('Bookshelf')]: { appetite: a }, [I('Table')]: { appetite: b }, [I('Chair')]: { appetite: c } } } });
    const A = board(180, 150, 262.5), Bd = board(120, 150, 337.5);   // alloc(18): 6/5/7 and 4/5/9
    assert.deepStrictEqual(cp._buildout.furnitureSplit(Bd, 0, cat).alloc(18), { bookshelf: 4, table: 5, chair: 9 });
    const mem = sharedMem(), t0 = 1.8e12;
    const dec = (b, now, o = {}) => cp._decide(cp._view(st, cat, deals), F.ctxOf({ retailBoard: b, mem, now, ...o }));
    const rebal = (d) => (bo(d)?.id.startsWith('bo:rebal') ? bo(d) : null);
    assert.ok(!rebal(dec(A, t0)), 'on the split: nothing');
    let d = dec(Bd, t0);
    assert.ok(!rebal(d));
    assert.match(boWait(d), /rebalance: Make Bookshelf -2, Make Chair \+2 \(moves once held 6 h\)/);
    assert.ok(!rebal(dec(A, t0 + 2 * HOUR)), 'blip back to the split');
    assert.deepStrictEqual(mem('buildout').get().rebal, {}, 'the gap closed: its time is forgotten');
    assert.ok(!rebal(dec(Bd, t0 + 6 * HOUR)), 'the gap starts again at +6 h');
    assert.ok(!rebal(dec(Bd, t0 + 12 * HOUR - 60000)));
    assert.ok(!rebal(dec(Bd, t0 + 12 * HOUR, { retailFail: true })), 'never on the retail fail path');
    assert.ok(!rebal(dec(null, t0 + 12 * HOUR)), 'no board: no move');
    const moves = [];
    for (let i = 0; i < 4; i++) {
      const a = rebal(dec(Bd, t0 + 12 * HOUR));
      if (!a) break;
      moves.push(a.steps.map((s) => s.msg));
      st.groups[a.steps[0].msg.group].count -= 1; st.groups[a.steps[1].msg.group].count += 1;   // the server applies both
    }
    const out = { type: 'UnassignBuildings', group: 21, amount: 1 }, into = { type: 'AssignBuildings', group: 8, amount: 1 };
    assert.deepStrictEqual(moves, [[out, into], [out, into]], 'from the Bookshelf group without modules, one per step');
    assert.deepStrictEqual([st.groups[20].count + st.groups[21].count, st.groups[22].count, st.groups[8].count], [4, 5, 9]);
    F.unload();
  });

  await F.t('D3 rebalance: the under recipe needs its floor', () => {
    const { cp } = F.load(['cp-buildout']);
    Object.assign(cp.cfg, { landPaybackAB: 0, applyFurnitureFloor: false });
    const st = switched(liveReady());
    st.groups[2].count = 200;
    st.groups[22] = { building: B('Workshop'), region: 0, count: 6, recipe: Rc('Make Table'), modules: {} };
    st.next_group_id = 30;
    delete st.layouts[Rc('Make Bookshelf')]; delete st.layouts[Rc('Make Chair')];   // both under recipes lack their floor
    const mem = sharedMem(), dec = (now) => cp._decide(cp._view(st, cat, deals), F.ctxOf({ retailBoard: retail, mem, now }));
    dec(1.8e12);
    const d = dec(1.8e12 + 7 * HOUR);
    assert.ok(!bo(d)?.id.startsWith('bo:rebal'), bo(d)?.text);
    assert.match(boWait(d), /rebalance: .* waits: Make Bookshelf has no floor; Make Chair has no floor/);
    F.unload();
  });

  // Stage D after a pass: Retail Store built, cotton Farms gone, 200 Sawmills for plank headroom, cash for anything.
  function stageD() {
    const st = stageC(switched(liveReady()));
    st.groups[30] = { building: B('Retail Store'), region: 0, count: 1, recipe: null, modules: {} };
    st.groups[1].count = 0; st.groups[2].count = 200; st.items[F.MONEY] = 1e10; st.next_group_id = 40;
    return st;
  }
  const benchLayout = (st) => { st.layouts[Rc('Make Bench')] = { ...F.clone(st.layouts[Rc('Assemble Wooden Frame')]), fx: { rate: 3 } }; };
  const pass = { retailOk: true };

  await F.t('D4 Bench: after a pass the Rivet x3 floor goes on Make Bench first, then the Workshop is bought; never before a pass or on the fail path', () => {
    const { core, cp } = F.load(['cp-buildout']);
    assert.strictEqual(cp.cfg.benchWorkshops, 1);
    const st = stageD(); st.stock[0][I('Concrete')] = 100000;
    let a = bo(decideOn(cp, st, pass));
    assert.strictEqual(a.steps[0].msg.type, 'EditLayout');
    assert.strictEqual(a.steps[0].msg.recipe, Rc('Make Bench'));
    assert.strictEqual(Object.keys(a.steps[0].msg.cells).length, core.floorDesigns.rivetX3.split(' ').length);
    assert.match(a.text, /Rivet x3 floor to Make Bench/);
    for (const o of [{}, { retailOk: false }, { retailOk: true, retailFail: true, retailFailPath: true }]) {
      const b = bo(decideOn(cp, st, o));
      assert.ok(!b || !/Bench/.test(b.text), JSON.stringify(o) + ': ' + b?.text);
    }
    benchLayout(st);
    a = bo(decideOn(cp, st, pass));
    assert.ok(a.steps.some((s) => s.msg.type === 'BuyBuilding' && s.msg.building === B('Workshop')), a.text);
    assert.deepStrictEqual(a.steps[a.steps.length - 1].msg, { type: 'CreateGroup', building: B('Workshop'), amount: 1, name: 'Make Bench', region: 0 });
    assert.ok(a.hold);
    F.unload();
  });

  await F.t('Bench planks: a running Make Bench group counts at the floor it runs (x3), not furniture\'s x5; one with no floor yet at the x5 plan rate', () => {
    const { cp } = F.load(['cp-buildout']);
    const used = (st) => +/, ([\d,]+)\/h used/.exec(cp._decide(cp._view(st, cat, deals), F.ctxOf({ ...pass, retailBoard: retail })).readouts.buildout.planks)[1].replace(/,/g, '');
    const st = stageD(), base0 = used(st);
    const r = cat.recipes.find((x) => x.name === 'Make Bench'), pl = r.inputs.find((i) => i.item === I('Planks')).amount;
    st.groups[41] = { building: B('Workshop'), region: 0, count: 2, recipe: r.id, modules: {} };
    benchLayout(st);
    assert.strictEqual(used(st) - base0, Math.round(2 * pl * 3 * 7200 / r.ticks), 'x3');
    delete st.layouts[r.id];
    assert.strictEqual(used(st) - base0, Math.round(2 * pl * 5 * 7200 / r.ticks), 'no floor: the plan rate');
    F.unload();
  });

  await F.t('D4 Bench: Concrete short of the gate + 48 h of Bench use: no Bench Workshop, the rest of the build-out goes on', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = stageD(); benchLayout(st); st.stock[0][I('Concrete')] = 5799;   // 400 + 48 h x 22.5 runs x 5 Concrete = 5,800
    const v = cp._view(st, cat, deals), ctx = F.ctxOf({ retailBoard: retail, ...pass });
    const rule = cp._decide(v, ctx).rule;
    const nb = cp._buildout.nextBuildStep(v, ctx, rule, 'D');
    assert.strictEqual(nb.pick.r.name, 'Make Table', 'a Bench that waits holds nothing else back');
    assert.strictEqual(cp._buildout.benchHeld(v, ctx, rule), 'Concrete 5799 < 5800 (gate 400 + 48 h of Bench use)');
    assert.ok(!(bo(decideOn(cp, st, pass))?.steps ?? []).some((s) => s.msg.name === 'Make Bench'));
    st.stock[0][I('Concrete')] = 5800;
    assert.strictEqual(cp._buildout.nextBuildStep(cp._view(st, cat, deals), ctx, rule, 'D').pick.r.name, 'Make Bench');
    F.unload();
  });

  await F.t('D4 Bench: the Kiln gate keeps 48 h of Bench use on top while a Bench is wanted or runs; a pool Workshop goes to the wanted Bench', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = stageD(); benchLayout(st); st.stock[0][I('Concrete')] = 500;
    assert.match(decideOn(cp, st).readouts.buildout.kiln, /Concrete 500\/400(?! \()/, 'no pass: the plain gate');
    assert.match(decideOn(cp, st, pass).readouts.buildout.kiln, /Concrete 500\/5800 \(gate 400 \+ 48 h of Bench use\)/, 'wanted: the Kiln makes the Bench gate\'s Concrete');
    // a Kiln Core plan paused at the plain gate comes back on Concrete for the Bench
    const mem = sharedMem(); mem('buildout').set({ kilnMine: [10] });
    st.groups[10].recipe = Rc('Mix Concrete');
    assert.deepStrictEqual(bo(decideOn(cp, st, { ...pass, mem })).steps[0].msg, { type: 'SetPaused', group: 10, paused: false });
    assert.ok(!bo(decideOn(cp, st, { mem }))?.id.startsWith('bo:pause:10'), 'no pass: Concrete 500 is past the plain gate');
    delete mem('buildout').get().kilnMine; st.groups[10].recipe = Rc('Blow Glass');
    st.groups[31] = { building: B('Workshop'), region: 0, count: 1, recipe: Rc('Make Bench'), modules: {} };
    assert.match(decideOn(cp, st, pass).readouts.buildout.kiln, /Concrete 500\/5800 \(gate 400 \+ 48 h of Bench use\)/);
    delete st.groups[31];
    st.building_pool[0][B('Workshop')] = 1; st.stock[0][I('Concrete')] = 100000;   // a Bench that is ready takes the pool Workshop first, as the buy path
    const a = bo(decideOn(cp, st, pass));
    assert.deepStrictEqual(a.steps.map((s) => s.msg), [{ type: 'CreateGroup', building: B('Workshop'), amount: 1, name: 'Make Bench', region: 0 }]);
    F.unload();
  });

  await F.t('B2 Bench planks: a wanted Bench adds its planks (Rivet x3 rate) to the Camp / Sawmill targets, sized as the rule; none when it is not wanted', () => {
    const { core, cp } = F.load(['cp-buildout']);
    const st = stageD(); benchLayout(st); st.stock[0][I('Concrete')] = 100000;
    const v = cp._view(st, cat, deals), ctx = F.ctxOf({ retailBoard: retail, ...pass });
    const rule = cp._decide(v, ctx).rule, m = core.coreMath.engineModel(v.C);
    const r = cat.recipes.find((x) => x.name === 'Make Bench'), benchP = r.inputs.find((i) => i.item === I('Planks')).amount * 3 * 7200 / r.ticks;   // x3 runs an hour x planks a run
    const sized = (p) => [Math.ceil(p * m.woodPerPlank / m.campWoodH), Math.ceil(p / m.smPlanksH)];
    const tg = cp._buildout.targets(v, ctx, rule), q = sized(rule.planksH + benchP), p = sized(rule.planksH);
    assert.deepStrictEqual([tg.camps, tg.sawmills], [rule.camps + q[0] - p[0], rule.sawmills + q[1] - p[1]]);
    const r0 = { ...rule, planksH: 0, camps: 0, sawmills: 0 };   // a rule with no planks: the Bench's own Camps / Sawmills
    const t0 = cp._buildout.targets(v, ctx, r0);
    assert.deepStrictEqual([t0.camps, t0.sawmills], sized(benchP));
    assert.ok(t0.camps >= 1 && t0.sawmills >= 1);
    const tn = cp._buildout.targets(v, F.ctxOf({ retailBoard: retail }), r0);
    assert.deepStrictEqual([tn.camps, tn.sawmills], [0, 0], 'no pass: no Bench, the rule alone');
    cp.cfg.benchWorkshops = 0;
    assert.deepStrictEqual([cp._buildout.targets(v, ctx, r0).camps, cp._buildout.targets(v, ctx, r0).sawmills], [0, 0], 'benchWorkshops 0');
    F.unload();
  });

  await F.t('B2: a Bench held only by planks with the Camps / Sawmills at their targets is closed, so it is not pending for E5', () => {
    const { cp } = F.load(['cp-buildout']);
    const st = stageD(); benchLayout(st); st.stock[0][I('Concrete')] = 100000;
    st.groups[2].count = 1;   // 1 Sawmill: the planks cannot feed the Bench
    const v = cp._view(st, cat, deals), base = F.ctxOf({ retailBoard: retail, ...pass });
    const r0 = { ...cp._decide(v, base).rule, planksH: 0, camps: 0, sawmills: 0 };   // synthetic: rule.need 0, the fixture's Wood model aside
    const tg = cp._buildout.targets(v, base, r0);
    const ctx = F.ctxOf({ retailBoard: retail, ...pass, _boTargets: { ...tg, camps: v.owned('Lumber Camp'), sawmills: v.owned('Sawmill') } });
    const nb = cp._buildout.nextBuildStep(v, ctx, r0, 'D');
    assert.ok(nb.closed && !nb.pick, JSON.stringify(nb));
    assert.match(nb.wait, /Workshop \(Make Bench\): planks \d+\/h cannot feed \d+\/h \(the targets, \d+ Camps \/ 1 Sawmills, make \d+\/h: closed\)/);
    assert.deepStrictEqual(cp._buildout.pendingInvest(v, ctx, r0, 'D'), []);
    // planks short only now (the 200 Sawmills at target, their group paused): the targets can feed it, so it stays pending
    const sp = stageD(); benchLayout(sp); sp.stock[0][I('Concrete')] = 100000; sp.groups[2].paused = true;
    const vp = cp._view(sp, cat, deals), cpx = F.ctxOf({ retailBoard: retail, ...pass, _boTargets: { ...tg, camps: vp.owned('Lumber Camp'), sawmills: vp.owned('Sawmill') } });
    const np = cp._buildout.nextBuildStep(vp, cpx, r0, 'D');
    assert.ok(!np.closed && !np.done && /planks/.test(np.wait), JSON.stringify(np));
    assert.strictEqual(cp._buildout.pendingInvest(vp, cpx, r0, 'D').length, 1);
    // one Sawmill short of its target: it is bought, nothing closed
    const more = F.ctxOf({ retailBoard: retail, ...pass, _boTargets: { ...tg, camps: v.owned('Lumber Camp'), sawmills: v.owned('Sawmill') + 1 } });
    const nb2 = cp._buildout.nextBuildStep(v, more, r0, 'D');
    assert.ok(!nb2.closed && /Sawmill|Lumber Camp/.test(nb2.pick?.label ?? ''), JSON.stringify(nb2));
    F.unload();
  });

  F.done();
})();
