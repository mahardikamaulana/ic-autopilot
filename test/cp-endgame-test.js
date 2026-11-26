// Tests for src/cp-endgame.js: the endgame director (wiki 12, plan D6).
//   CP_FROM_SRC=1 bun test/cp-endgame-test.js
const assert = require('assert');
const F = require('./cp-fixtures');
const { t, done } = F;
const CAT = F.stageB.catalog;
const B = (n) => F.B(n, CAT), I = (n) => F.I(n, CAT), Rc = (n) => F.Rc(n, CAT);
const T0 = 20150000;
const view = (cp, st) => cp._view(st, CAT, []);
const plain = () => { const st = F.liveB(); st.standing_fills = {}; return st; };
// A corp at the end: the unlocks in, CD for the Refinery, money, and every kit item the endgame buildings ask for.
function endCorp() {
  const st = plain();
  st.research = null; st.research_queue = [];
  st.unlocked_buildings = [...new Set([...st.unlocked_buildings, B('Assembly Plant'), B('Retail Store'), B('Oil Rig')])];
  st.items[F.MONEY] = 1e12; st.items[F.CD] = 800000;
  for (const n of ['Assembly Plant', 'Mine', 'Smelter']) for (const it of [...(CAT.buildings.find((b) => b.name === n).build_items ?? []), ...(CAT.buildings.find((b) => b.name === n).default_kit ?? [])]) st.stock[0][it.item] = (st.stock[0][it.item] ?? 0) + it.amount * 10;
  for (const g of Object.values(st.groups)) if ([B('Assembly Plant'), B('Mine'), B('Smelter')].includes(g.building)) g.count = 0;   // no endgame building yet
  for (const b of [B('Assembly Plant'), B('Mine'), B('Smelter')]) delete st.building_pool[0][b];
  st.layouts = {};
  st.stock[0][I('Wired Frame')] = 0;   // no Refinery prototype yet: the Refinery start (checked first) waits
  return st;
}
const FIN = () => ({ finished: true, E: [] });

(async () => {
  let { cp } = F.load(['cp-lab', 'cp-cadence', 'cp-endgame']);
  let X = cp._endgame;

  await t('endgame loads after cadence, off by default; with no E1-E5 it only waits', () => {
    assert.ok(cp.directors().includes('endgame'));
    assert.strictEqual(cp.cfg.dir_endgame, false);
    const d = cp._decide(view(cp, plain()), F.ctxOf({ tick: T0 }));
    assert.ok(d.waits.includes('endgame: off'), d.waits.join(' | '));
    assert.ok(!d.actions.some((a) => a.director === 'endgame'));
    const r = X.endgameDecide(view(cp, endCorp()), F.ctxOf(), { finished: false, E: [{ ok: false }] });
    assert.ok(!r.action); assert.match(r.wait, /E1-E5 not all true/);
    assert.deepStrictEqual(r.readout.checklist.map((c) => c.item), ['Iron Frame', 'Wired Frame', 'Copper Wire', 'Copper Ore']);
    cp.importCfg({ dir_endgame: true });
    const d2 = cp._decide(view(cp, plain()), F.ctxOf({ tick: T0 }));
    assert.ok(d2.waits.some((w) => /^endgame: end conditions/.test(w)), d2.waits.join(' | '));
    cp.importCfg({ dir_endgame: false });
  });

  await t('endgame (D6): Assembly Plant first, its gates (kit, cash, acres above the buffer), and the Refinery CD need from the start', () => {
    const st = endCorp(), out = FIN();
    const r = X.endgameDecide(view(cp, st), F.ctxOf(), out);
    assert.strictEqual(out.cdNeed.name, 'Refinery', 'the CD need is published before the builds');
    const types = r.action.steps.map((s) => s.msg.type);
    assert.deepStrictEqual(types.slice(-2), ['BuyBuilding', 'CreateGroup']);
    assert.strictEqual(r.action.steps.at(-2).msg.building, B('Assembly Plant'));
    assert.strictEqual(r.action.steps.at(-1).msg.name, 'Assemble Wired Frame');
    assert.ok(r.action.hold);
    const v = view(cp, st), short = cp.cfg.bufferAcres + 5 - v.freeAcres;
    if (short > 0) assert.deepStrictEqual(r.action.steps[0].msg, { type: 'BuyLand', amount: short, region: 0 }); else assert.strictEqual(types[0], 'BuyBuilding');
    // E4 at the end: no acre above the CD-farm buffer is free, so the plant's 5 acres are bought in the same held action
    const tight = endCorp(); tight.land_bought[0] += cp.cfg.bufferAcres - view(cp, tight).freeAcres;
    assert.strictEqual(view(cp, tight).freeAcres, cp.cfg.bufferAcres);
    const rl = X.endgameDecide(view(cp, tight), F.ctxOf(), FIN());
    assert.deepStrictEqual(rl.action.steps[0].msg, { type: 'BuyLand', amount: 5, region: 0 });
    assert.deepStrictEqual(rl.action.steps.slice(1).map((s) => s.msg.type), ['BuyBuilding', 'CreateGroup']);
    tight.items[F.MONEY] = globalThis.idleCore.planner.price(CAT.buildings.find((b) => b.name === 'Assembly Plant').cost, 0, 0);   // the plant's price alone, short of land + bills
    assert.match(X.endgameDecide(view(cp, tight), F.ctxOf(), FIN()).wait, /^Assembly Plant: cash .* \+ 5 acre\(s\) \$/);
    // free acres above the buffer: no BuyLand
    const roomy = endCorp(); roomy.land_bought[0] += Math.max(0, short) + 5;
    assert.strictEqual(X.endgameDecide(view(cp, roomy), F.ctxOf(), FIN()).action.steps[0].msg.type, 'BuyBuilding');
    const poor = endCorp(); poor.items[F.MONEY] = 100;
    assert.match(X.endgameDecide(view(cp, poor), F.ctxOf(), FIN()).wait, /^Assembly Plant: cash .* \(money floor \+/);
    const noKit = endCorp(); noKit.stock[0][I('Iron Frame')] = 0;
    assert.match(X.endgameDecide(view(cp, noKit), F.ctxOf(), FIN()).wait, /^Assembly Plant: kit short: \d+ Iron Frame/);
    // an Assembly Plant you own already counts; one on another recipe is left to you
    const own = endCorp(); own.groups[900] = { building: B('Assembly Plant'), region: 0, count: 1, recipe: Rc('Assemble Wired Frame') };
    assert.strictEqual(X.endgameDecide(view(cp, own), F.ctxOf(), FIN()).action.id, 'eg:floor:' + Rc('Mine Copper Ore'));
  });

  await t('endgame (D6): through the fake server, each step waits on the one before it, then the stock gates, then the Refinery', () => {
    const st = endCorp();
    const { cp: c, w } = F.boot(st, { deals: [], catalog: CAT, modules: ['cp-lab', 'cp-cadence', 'cp-endgame'] });
    const ctx = F.ctxOf(), seq = [];
    // targets met: once built, the gates pause every endgame group
    st.stock[0][I('Copper Ore')] = 5000; st.stock[0][I('Copper Wire')] = 500; st.stock[0][I('Wired Frame')] = 20;
    for (let i = 0; i < 30; i++) {
      c._endgame.egContext(c._view(st, CAT, []), ctx);
      const r = c._endgame.endgameDecide(c._view(st, CAT, []), ctx, FIN());
      if (!r.action) { seq.push('wait: ' + r.wait); break; }
      for (const s of r.action.steps) { w.ws.send(JSON.stringify(s.msg)); assert.ok(s.until(c._view(st, CAT, [])), r.action.id + ' applied'); }
      seq.push(r.action.steps.map((s) => s.msg.type + (s.msg.type === 'EditLayout' || s.msg.type === 'SetRecipe' ? ':' + CAT.recipes.find((x) => x.id === s.msg.recipe).name : s.msg.type === 'BuyBuilding' ? ':' + CAT.buildings.find((x) => x.id === s.msg.building).name : s.msg.type === 'SetPaused' ? ':' + s.msg.paused : '')).filter((x) => x !== 'BuyLand').join(' '));
    }
    // C1: CD and the Wired Frames in hand start the Refinery first; the builds and gates follow while it researches
    assert.deepStrictEqual(seq, [
      'StartTech',
      'BuyBuilding:Assembly Plant CreateGroup', 'SetRecipe:Assemble Wired Frame',
      'EditLayout:Mine Copper Ore', 'BuyBuilding:Mine CreateGroup', 'SetRecipe:Mine Copper Ore',
      'BuyBuilding:Mine AssignBuildings', 'BuyBuilding:Mine AssignBuildings', 'BuyBuilding:Mine AssignBuildings', 'BuyBuilding:Mine AssignBuildings',
      'EditLayout:Draw Copper Wire', 'BuyBuilding:Smelter CreateGroup', 'SetRecipe:Draw Copper Wire',
      'SetPaused:true', 'SetPaused:true', 'SetPaused:true', 'wait: Refinery: research running',
    ], seq.join('\n'));
    assert.strictEqual(st.research.building, B('Refinery'));
    const mines = Object.values(st.groups).filter((g) => g.recipe === Rc('Mine Copper Ore'));
    assert.strictEqual(mines.reduce((a, g) => a + g.count, 0), X.MINES_PER_SMELTER);
    assert.strictEqual(ctx.mem('endgame').get().egMine.length, 3);
    F.unload();
    ({ cp } = F.load(['cp-lab', 'cp-cadence', 'cp-endgame'])); X = cp._endgame;   // the pure tests below need a loaded core again
  });

  await t('endgame (D6): a later step never runs before an earlier one: Mines wait for the Wire Frame group, the Smelter for 5 Mines', () => {
    const st = endCorp();
    st.groups[900] = { building: B('Assembly Plant'), region: 0, count: 1, recipe: null, name: 'Assemble Wired Frame' };
    assert.deepStrictEqual(X.endgameDecide(view(cp, st), F.ctxOf(), FIN()).action.steps[0].msg, { type: 'SetRecipe', group: 900, recipe: Rc('Assemble Wired Frame') });
    st.groups[900].recipe = Rc('Assemble Wired Frame');
    st.layouts[Rc('Mine Copper Ore')] = { fx: { rate: 3 } };
    st.groups[901] = { building: B('Mine'), region: 0, count: 4, recipe: Rc('Mine Copper Ore') };
    const r = X.endgameDecide(view(cp, st), F.ctxOf(), FIN());
    assert.strictEqual(r.action.steps.find((s) => s.msg.type === 'BuyBuilding').msg.building, B('Mine'));
    assert.match(r.action.text, /Mine \(Mine Copper Ore\) 5\/5/);
    // Mines already running without the floor: left to you, nothing bought on the wrong floor
    delete st.layouts[Rc('Mine Copper Ore')];
    assert.match(X.endgameDecide(view(cp, st), F.ctxOf(), FIN()).wait, /manual: apply the x3 merge floor to Mine Copper Ore/);
    // C1: with CD and the 6 Wired Frames in hand the Refinery starts first, whatever the build steps wait for
    st.stock[0][I('Wired Frame')] = 6;
    assert.deepStrictEqual(X.endgameDecide(view(cp, st), F.ctxOf(), FIN()).action.steps[0].msg, { type: 'StartTech', building: B('Refinery'), region: 0 });
    st.research = { building: B('Oil Rig') };   // slot busy: the build steps go on
    assert.match(X.endgameDecide(view(cp, st), F.ctxOf(), FIN()).wait, /manual: apply the x3 merge floor/);
  });

  await t('endgame stock gates (D6): copper and wire groups pause only when every target they feed is met, resume below; yours stay yours', () => {
    const st = endCorp();
    st.groups[900] = { building: B('Assembly Plant'), region: 0, count: 1, recipe: Rc('Assemble Wired Frame') };
    st.groups[901] = { building: B('Mine'), region: 0, count: 5, recipe: Rc('Mine Copper Ore') };
    st.groups[902] = { building: B('Smelter'), region: 0, count: 1, recipe: Rc('Draw Copper Wire') };
    const ctx = F.ctxOf(), m = ctx.mem('endgame');
    const gate = () => X.gateStep(view(cp, st), ctx);
    const set = (ore, wire, wf) => { st.stock[0][I('Copper Ore')] = ore; st.stock[0][I('Copper Wire')] = wire; st.stock[0][I('Wired Frame')] = wf; };
    set(5000, 50, 5);                                             // ore met, wire and frames below: every group runs
    assert.strictEqual(gate(), null);
    set(5000, 500, 5);                                            // ore and wire met, frames below: still all run (all feed Wired Frame)
    assert.strictEqual(gate(), null);
    set(100, 50, 12);                                             // frames met: only the Assembly Plant pauses
    let r = gate();
    assert.deepStrictEqual(r.action.steps[0].msg, { type: 'SetPaused', group: 900, paused: true });
    st.groups[900].paused = true; r.action.steps[0].until(view(cp, st));
    assert.deepStrictEqual(m.get().egMine, [900]);
    assert.strictEqual(gate(), null, 'Mines and Smelter keep running: ore and wire are below');
    set(5000, 200, 12);                                           // everything met: Smelter, then Mines
    r = gate(); assert.strictEqual(r.action.steps[0].msg.group, 902);
    st.groups[902].paused = true; r.action.steps[0].until(view(cp, st));
    r = gate(); assert.strictEqual(r.action.steps[0].msg.group, 901);
    st.groups[901].paused = true; r.action.steps[0].until(view(cp, st));
    assert.deepStrictEqual([...m.get().egMine].sort(), [900, 901, 902]);
    set(5000, 199, 12);                                           // wire below: the Smelter and the Mines come back, the Assembly Plant stays
    r = gate(); assert.deepStrictEqual(r.action.steps[0].msg, { type: 'SetPaused', group: 902, paused: false });
    st.groups[902].paused = false; r.action.steps[0].until(view(cp, st));
    r = gate(); assert.deepStrictEqual(r.action.steps[0].msg, { type: 'SetPaused', group: 901, paused: false });
    st.items[F.MONEY] = 0;
    assert.match(gate().wait, /stock gate: resume group 901 waits: cash/);
    st.items[F.MONEY] = 1e12;
    // you resume the Assembly Plant by hand: hands off from then on, even with frames at target
    st.groups[900].paused = false;
    X.egContext(view(cp, st), ctx);
    assert.ok(m.get().egUser.includes(900) && !m.get().egMine.includes(900));
    set(5000, 500, 50);
    assert.ok(![900].includes(gate()?.action?.steps[0].msg.group));
    // a group paused by someone else is not resumed by the gate
    st.groups[903] = { building: B('Smelter'), region: 0, count: 1, recipe: Rc('Draw Copper Wire'), paused: true };
    set(0, 0, 0);
    for (let i = 0; i < 3; i++) { const a = gate()?.action; if (!a) break; assert.notStrictEqual(a.steps[0].msg.group, 903); const g = st.groups[a.steps[0].msg.group]; g.paused = a.steps[0].msg.paused; a.steps[0].until(view(cp, st)); }
  });

  await t('endgame: with steps 1-4 in place and targets unmet, the Refinery start waits for its prototype and 750,000 CD, then StartTech', () => {
    const st = endCorp();
    st.groups[900] = { building: B('Assembly Plant'), region: 0, count: 1, recipe: Rc('Assemble Wired Frame') };
    st.groups[901] = { building: B('Mine'), region: 0, count: 5, recipe: Rc('Mine Copper Ore') };
    st.groups[902] = { building: B('Smelter'), region: 0, count: 1, recipe: Rc('Draw Copper Wire') };
    for (const r of ['Mine Copper Ore', 'Draw Copper Wire']) st.layouts[Rc(r)] = { fx: { rate: 3 } };
    st.stock[0][I('Copper Ore')] = 0; st.stock[0][I('Copper Wire')] = 0;
    st.stock[0][I('Wired Frame')] = 5;
    assert.match(X.endgameDecide(view(cp, st), F.ctxOf(), FIN()).wait, /^Refinery: need 1 more Wired Frame/);
    st.stock[0][I('Wired Frame')] = 6; st.items[F.CD] = 700000;
    const w7 = X.endgameDecide(view(cp, st), F.ctxOf(), FIN());
    assert.ok(!w7.action); assert.match(w7.wait, /^Refinery: 700,000 \/ 750,000 CD/);
    st.items[F.CD] = 800000;
    assert.deepStrictEqual(X.endgameDecide(view(cp, st), F.ctxOf(), FIN()).action.steps[0].msg, { type: 'StartTech', building: B('Refinery'), region: 0 });
  });

  await t('endgame gates: no stranded pause: before E1-E5 hold only the resume half runs; with the endgame off every group it paused comes back', () => {
    const st = endCorp();
    st.groups[900] = { building: B('Assembly Plant'), region: 0, count: 1, recipe: Rc('Assemble Wired Frame'), paused: true };
    st.groups[902] = { building: B('Smelter'), region: 0, count: 1, recipe: Rc('Draw Copper Wire'), paused: true };
    st.groups[903] = { building: B('Smelter'), region: 0, count: 1, recipe: Rc('Draw Copper Wire'), paused: true };   // paused by someone else
    const ctx = F.ctxOf({ tick: T0 });
    ctx.mem('endgame').set({ egMine: [900, 902] });
    const NOT = { finished: false, E: [{ ok: false }] };
    st.stock[0][I('Wired Frame')] = 50; st.stock[0][I('Copper Wire')] = 0;   // frames met (900 stays paused), wire below (902 resumes)
    let r = X.endgameDecide(view(cp, st), ctx, NOT);
    assert.deepStrictEqual(r.action.steps[0].msg, { type: 'SetPaused', group: 902, paused: false });
    st.groups[902].paused = false; r.action.steps[0].until(view(cp, st));
    r = X.endgameDecide(view(cp, st), ctx, NOT);
    assert.ok(!r.action, 'nothing is paused before E1-E5 hold, and 900 stays (its target is met)'); assert.match(r.wait, /E1-E5 not all true/);
    st.groups[902].paused = true; ctx.mem('endgame').set({ egMine: [900, 902] });
    st.stock[0][I('Copper Wire')] = 1e6;
    // off (the default): through decide, the director resumes the gate's groups even at target, never one it did not pause
    assert.strictEqual(cp.cfg.dir_endgame, false);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const a = cp._decide(view(cp, st), ctx).actions.find((x) => x.director === 'endgame');
      if (!a) break;
      seen.push(a.steps[0].msg.group); st.groups[a.steps[0].msg.group].paused = false; a.steps[0].until(view(cp, st));
    }
    assert.deepStrictEqual(seen.sort(), [900, 902]);
    assert.ok(st.groups[903].paused);
    assert.deepStrictEqual(ctx.mem('endgame').get().egMine, []);
  });

  await t('endgame floors: an EditLayout the server did not apply waits cfg.floorRetryMin before the next try', () => {
    const st = endCorp();
    st.groups[900] = { building: B('Assembly Plant'), region: 0, count: 1, recipe: Rc('Assemble Wired Frame') };
    const mem = F.ctxOf().mem, ctx = (min) => F.ctxOf({ mem, now: Date.now() + min * 60000 });   // until() stamps Date.now(), as buildout's floorStep
    const a = X.endgameDecide(view(cp, st), ctx(0), FIN()).action;
    assert.strictEqual(a.id, 'eg:floor:' + Rc('Mine Copper Ore'));
    assert.strictEqual(a.steps[0].until(view(cp, st)), false);   // not applied
    assert.ok(mem('endgame').get().floorFail[Rc('Mine Copper Ore')] != null);
    assert.strictEqual(cp.cfg.floorRetryMin ?? 10, 10);
    const w = X.endgameDecide(view(cp, st), ctx(4), FIN());
    assert.ok(!w.action); assert.match(w.wait, /did not apply the x3 merge floor: retry in/);
    mem('endgame').set({ floorFail: { [Rc('Mine Copper Ore')]: Date.now() - 10 * 60000 } });
    const b = X.endgameDecide(view(cp, st), ctx(0), FIN()).action;
    assert.strictEqual(b.id, 'eg:floor:' + Rc('Mine Copper Ore'), 'tried again after 10 min');
    st.layouts[Rc('Mine Copper Ore')] = { fx: { rate: 3 } };
    assert.ok(b.steps[0].until(view(cp, st)));
    assert.strictEqual(mem('endgame').get().floorFail[Rc('Mine Copper Ore')], null);
  });

  await t('endgame floors: a failed Mine floor does not block the Smelter floor (the retry wait is per recipe)', () => {
    const st = endCorp();
    st.groups[900] = { building: B('Assembly Plant'), region: 0, count: 1, recipe: Rc('Assemble Wired Frame') };
    const mem = F.ctxOf().mem, ctx = F.ctxOf({ mem, now: Date.now() });
    const mine = X.endgameDecide(view(cp, st), ctx, FIN()).action;
    assert.strictEqual(mine.id, 'eg:floor:' + Rc('Mine Copper Ore'));
    assert.strictEqual(mine.steps[0].until(view(cp, st)), false);   // the Mine floor is not applied: its retry window opens
    st.layouts[Rc('Mine Copper Ore')] = { fx: { rate: 3 } };       // later the 5 Mines run on a floor
    st.groups[901] = { building: B('Mine'), region: 0, count: 5, recipe: Rc('Mine Copper Ore') };
    const smelt = X.endgameDecide(view(cp, st), ctx, FIN());
    assert.strictEqual(smelt.action?.id, 'eg:floor:' + Rc('Draw Copper Wire'), smelt.wait);
  });

  await t('endgame: no pending investment for E5 (the buildings come after the gate)', () => {
    const ctx = F.ctxOf({ tick: T0 });
    cp._decide(view(cp, endCorp()), ctx);
    assert.ok(!(ctx.pendingInvest ?? []).some((p) => /Assembly|Mine|Smelter|endgame/i.test(p.what)), JSON.stringify(ctx.pendingInvest));
  });

  done();
})();