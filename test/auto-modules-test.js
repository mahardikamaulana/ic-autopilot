// Auto modules optimizer (src/auto-modules.js), scored by the real engine's moduleReport (the game's own module math).
//   bun test/auto-modules-test.js        (skips when the engine wasm cannot be loaded, e.g. offline)
const assert = require('assert');
const F = require('./cp-fixtures');

(async () => {
  const eng = await require('./engine.js').load();
  if (!eng) { console.log('skip: engine wasm not available (offline?)'); return; }
  const fx = require('./live-2026-11-28.json');
  const cat = eng.catalog();
  F.load(['module-watch', 'auto-modules']);
  const am = globalThis.autoModules;
  const R = (n) => cat.recipes.find((r) => r.name === n);
  const FELL = R('Fell Wood'), SAW = R('Saw Planks');   // Fell Wood has no inputs; Saw Planks inputs are 71% of its output value
  const live = fx.snap.module_defs;
  const OC = (id, x = {}) => ({ id, kind: 61, name: 'Overclock Module Mk' + (id + 1), ticks_bonus: 0, inputs_bonus: 0, neighbor_pct: 0, quirks: [], ...x });
  const RF = (id, x = {}) => ({ id, kind: 62, name: 'Refiner Module Mk' + (id + 1), ticks_bonus: 0, inputs_bonus: 0, neighbor_pct: 0, quirks: [], ...x });
  const grp = (rc, count, modules = {}) => ({ building: rc.building, recipe: rc.id, count, modules, paused: false, work: [], region: 0 });
  // A corp with these groups and module defs; the engine is loaded with the same defs, so moduleReport reads them.
  function corp(groups, defs) {
    const st = { ...structuredClone(fx.snap), groups, module_defs: Object.fromEntries(defs.map((d) => [d.id, d])), fleet_modules: [] };
    const e = new eng.Engine(st.ssi.corp_id);
    e.load(st);
    return { st, e, p: am._plan(st, cat, e) };
  }
  // Play the steps on a copy: each must be legal when sent (a remove finds its module, an install a free module and an empty
  // socket), and the end state must be the target.
  function play(st, p) {
    const s = structuredClone(st);
    for (const x of p.steps) {
      const g = s.groups[x.msg.group];
      if (x.msg.type === 'RemoveModule') { assert.strictEqual(g.modules[x.msg.cell], x.module, 'remove finds its module: ' + x.text); delete g.modules[x.msg.cell]; }
      else {
        assert.ok(g.modules[x.msg.cell] == null, 'install into an empty socket: ' + x.text);
        assert.ok(globalThis.idleCore.modules.freeModules(s).some((d) => d.id === x.module), 'install a free module: ' + x.text);
        g.modules[x.msg.cell] = x.module;
      }
    }
    for (const [id, cells] of Object.entries(p.target)) assert.deepStrictEqual(s.groups[id].modules, cells, 'group ' + id + ' ends on its target');
    return s;
  }
  const rep = (e, b, cells) => JSON.parse(e.moduleReport(b, JSON.stringify(cells)));

  await F.t('a Twinned pair ends up side by side (both at 108% strength)', () => {
    const { st, e, p } = corp({ 1: grp(FELL, 50) }, [live[1], live[10]]);   // Overclocks with Twinned 8
    play(st, p);
    assert.deepStrictEqual(Object.values(p.target[1]).sort(), [1, 10]);
    assert.deepStrictEqual(Object.values(rep(e, FELL.building, p.target[1]).strength), [108, 108], JSON.stringify(p.target[1]));
  });

  await F.t('a Corner-tuned module goes into its named socket', () => {
    const { st, p } = corp({ 1: grp(FELL, 50) }, [live[3]]);   // Overclock, CornerTuned "0,1" (53% elsewhere)
    play(st, p);
    assert.deepStrictEqual(p.target[1], { '0,1': 3 });
  });

  await F.t('a Refiner goes to the group with expensive inputs, the Overclock to the one without', () => {
    const { st, p } = corp({ 1: grp(FELL, 20), 2: grp(SAW, 20) }, [OC(0), RF(1)]);
    play(st, p);
    assert.deepStrictEqual(Object.values(p.target[2]), [1], 'Refiner on Saw Planks: ' + JSON.stringify(p.target));
    assert.deepStrictEqual(Object.values(p.target[1]), [0], 'Overclock on Fell Wood');
    assert.ok(p.moves.every((m) => /\+\$/.test(m.why)), 'each move says what it adds: ' + p.moves.map((m) => m.why));
  });

  await F.t('no move when the gain is under the 2% margin', () => {
    const { p } = corp({ 1: grp(FELL, 100, { '0,-1': 0 }), 2: grp(FELL, 101) }, [OC(0)]);
    assert.ok(p.top > p.cur, 'the other group is a little better');
    assert.deepStrictEqual(p.moves, []); assert.deepStrictEqual(p.steps, []);
    assert.deepStrictEqual(p.target, { 1: { '0,-1': 0 }, 2: {} });
    const q = corp({ 1: grp(FELL, 100, { '0,-1': 0 }), 2: grp(FELL, 110) }, [OC(0)]).p;   // 10% better: it moves
    assert.deepStrictEqual(q.steps.map((s) => s.msg.type), ['RemoveModule', 'InstallModule']);
  });

  await F.t('an unknown kind stays put; a known module still goes in around it', () => {
    const odd = { id: 5, kind: 999, name: 'Odd Module Mk6', ticks_bonus: 0, inputs_bonus: 0, neighbor_pct: 0, quirks: [] };
    const { st, p } = corp({ 1: grp(FELL, 50, { '0,-1': 5 }) }, [odd, OC(7)]);
    play(st, p);
    assert.strictEqual(p.target[1]['0,-1'], 5);
    assert.ok(Object.values(p.target[1]).includes(7), 'the Overclock is installed');
    assert.ok(!p.moves.some((m) => m.module === 5), 'the unknown module never moves');
  });

  await F.t('Efficiency: installed where its power saving and slower runs pay (a loss-making powered group), and its draws_pct is reported for Auto utilities', () => {
    const EF = { id: 3, kind: 131, name: 'Efficiency Module Mk4', ticks_bonus: 0, inputs_bonus: 0, neighbor_pct: 0, quirks: [] };
    const DRAFT = R('Draft Wooden Plans');
    const { st, e, p } = corp({ 1: grp(DRAFT, 10) }, [EF]);
    play(st, p);
    assert.deepStrictEqual(Object.values(p.target[1]), [3]);
    assert.strictEqual(rep(e, DRAFT.building, p.target[1]).draws_pct, 85);
    const q = corp({ 1: grp(DRAFT, 10, { '0,-1': 3 }) }, [EF]).p;
    assert.deepStrictEqual([...q.drawsPct.values()], [85], 'draws_pct of the installed layout, for core.powerMeasure');
  });

  await F.t('Calibrator: its quality raises the value of a retail good only (x qf(0.5) / qf(0))', () => {
    const CA = { id: 4, kind: 132, name: 'Calibrator Module Mk5', ticks_bonus: 0, inputs_bonus: 0, neighbor_pct: 0, quirks: [] };
    const CHAIR = R('Make Chair'), store = { building: cat.buildings.find((b) => b.name === 'Retail Store').id, count: 1, recipe: null, assortment: [CHAIR.outputs[0].item], modules: {}, paused: false, work: [] };
    const plain = corp({ 1: grp(CHAIR, 10, { '0,-1': 4 }) }, [CA]).p.rows[0];
    const sold = corp({ 1: grp(CHAIR, 10, { '0,-1': 4 }), 2: store }, [CA]).p.rows.find((r) => r.group === 1);
    const qf = (q) => 0.95 + 0.19 * q / (q + 10);
    const chairsH = 10 * fx.snap.layouts[CHAIR.id].fx.rate * 7200 / Math.floor(CHAIR.ticks * 100 / 80), unit = cat.items.find((i) => i.id === CHAIR.outputs[0].item).base_value;   // speed -20
    assert.ok(Math.abs((sold.now - plain.now) - chairsH * unit * (qf(0.5) / qf(0) - 1)) < 1e-6, (sold.now - plain.now) + ' cents/h');
  });

  await F.t('Instrumented breaks a dollar tie (30 MD/h), never beats dollars', () => {
    const odd = (id) => ({ id, kind: 999, name: 'Odd Module Mk' + (id + 1), ticks_bonus: 0, inputs_bonus: 0, neighbor_pct: 0, quirks: [] });
    const five = { '1,-1': 20, '-1,0': 21, '1,0': 22, '-1,1': 23, '0,1': 24 };   // one open socket
    const pins = [20, 21, 22, 23, 24].map(odd), INS = [{ kind: 'Instrumented' }];
    let p = corp({ 1: grp(FELL, 50, { ...five }) }, [...pins, OC(1), OC(2, { quirks: INS })]).p;
    assert.strictEqual(p.target[1]['0,-1'], 2, 'same dollars: the Instrumented one');
    assert.ok(p.moves.some((m) => /\+30\.0 MD\/h/.test(m.why)), p.moves.map((m) => m.why).join('; '));
    p = corp({ 1: grp(FELL, 50, { ...five }) }, [...pins, OC(1, { ticks_bonus: -5 }), OC(2, { quirks: INS })]).p;
    assert.strictEqual(p.target[1]['0,-1'], 1, 'five more speed points (34 -> 33 ticks a run) beat the MD');
  });

  await F.t('Insightful: a module that loses money on production goes to the Lab, where it saves MD on the running project', () => {
    const lab = { building: cat.buildings.find((b) => b.name === 'Manufacturing Lab').id, count: 1, recipe: null, modules: {}, paused: false, work: [] };
    const { st, p } = corp({ 1: grp(FELL, 50), 2: lab }, [RF(8, { quirks: [{ kind: 'Insightful', pct: 7 }] })]);   // a Refiner only slows Fell Wood (no inputs)
    assert.ok(Object.keys(st.mfg_research ?? {}).length, 'the live fixture has a Lab project running');
    play(st, p);
    assert.deepStrictEqual(Object.values(p.target[2]), [8]); assert.deepStrictEqual(p.target[1], {});
    assert.ok(p.topM > p.curM && /MD\/h/.test(p.moves[0].why), p.moves[0]?.why);
  });

  await F.t('a full corp with no free socket: legal swaps only, removes before installs, ends on the target', () => {
    const six = (ids) => Object.fromEntries(['0,-1', '1,-1', '-1,0', '1,0', '-1,1', '0,1'].map((c, i) => [c, ids[i]]));
    const defs = [...[0, 1, 2, 3, 4, 5].map((i) => RF(i)), ...[6, 7, 8, 9, 10, 11].map((i) => OC(i)), OC(12, { ticks_bonus: -10 })];
    // the wrong way round: Refiners on the group without inputs, Overclocks on the one with expensive inputs; one strong Overclock free
    const { st, p } = corp({ 1: grp(FELL, 30, six([0, 1, 2, 3, 4, 5])), 2: grp(SAW, 30, six([6, 7, 8, 9, 10, 11])) }, defs);
    assert.ok(p.adopt && p.top > p.cur);
    const types = p.steps.map((s) => s.msg.type);
    assert.ok(types.lastIndexOf('RemoveModule') < types.indexOf('InstallModule'), 'every remove comes before the installs');
    play(st, p);
    assert.ok(Object.values(p.target[1]).includes(12), 'the strongest Overclock lands on the group without inputs');
  });

  globalThis.autoModules?._unload(); globalThis.moduleWatch?._unload();
  F.unload();
  F.done();
})();
