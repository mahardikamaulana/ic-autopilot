// Multi-region Core plan (scripts/multi-region-plan.md) on the full loop in the real engine (test/engine-region.js). Skips cleanly offline.
//   bun test/engine-region-test.js [golden|phase1|phase2]   # ENGINE_REGION_LOG=1 prints each run's actions and hourly money
//   GOLDEN_WRITE=1 bun test/engine-region-test.js   # re-record test/golden-heartland.json (only from code known to be right)
// Golden: a Heartland-only corp acts exactly as before the multi-region work (action ids of the full loop on the live fixture with expand
// off and ask, the Gold Mine variant with ask, and a pure decide on the Stage B corp).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('./cp-fixtures');
const GOLD = path.join(__dirname, 'golden-heartland.json');
const LOG = !!process.env.ENGINE_REGION_LOG;
const SCEN = process.argv[2] ?? 'golden';
// The Gold Mine variant: Heartland at 316 of 316 acres (22 Gold Mines and their 44 acres gone), so its land rule decides where it stops.
const goldEdit = (snap) => { delete snap.groups[12]; snap.land_bought[0] -= 44; };

(async () => {
  const R = await require('./engine-region.js').load();
  if (!R) { console.log('skip: engine wasm not available (offline?)'); return; }
  const { run, cp } = R;
  const ids = (x) => x.ids.map((s) => s.slice(s.indexOf(' ') + 1));
  const stageB = (expand) => {
    const saved = cp.cfg.expand; cp.cfg.expand = expand;
    try {
      const out = cp._decide(cp._view(F.liveB(), F.stageB.catalog, F.stageB.deals), F.ctxOf({ retailBoard: F.stageB.retail, deals: F.stageB.deals }));
      return { actions: out.actions.map((a) => a.id), waits: out.waits.filter((w) => !/^expand:/.test(w)) };
    } finally { cp.cfg.expand = saved; }
  };
  if (SCEN === 'golden') {
  const now = {
    liveOff: ids(run({ hours: 3, expand: 'off' })),
    liveAsk: ids(run({ hours: 3, expand: 'ask' })),
    goldAsk: ids(run({ hours: 3, expand: 'ask', edit: goldEdit })),
    stageBOff: stageB('off'), stageBAsk: stageB('ask'),
  };
  if (process.env.GOLDEN_WRITE) { fs.writeFileSync(GOLD, JSON.stringify(now, null, 1) + '\n'); console.log('wrote ' + GOLD); }
  const gold = JSON.parse(fs.readFileSync(GOLD, 'utf8'));
  for (const k of Object.keys(gold)) {
    await F.t('golden: a Heartland-only corp acts as before (' + k + ')', () => assert.deepStrictEqual(now[k], gold[k]));
  }
  }

  // Phase 1 (lever 6): Industrial Basin opened and built by the director (1.5 h, seeded), then its store removed and the expand memory
  // emptied: a region this director did not open, with a chain and no store (the user's corp).
  if (SCEN === 'phase1') {
  const base = run({ hours: 1.5, expand: 'auto', seed: true });
  const noStore = F.clone(base.snap), sb = R.bid('Retail Store');
  for (const [g, x] of Object.entries(noStore.groups)) if (x.region === 1 && x.building === sb) delete noStore.groups[g];
  if (noStore.building_pool?.[1]) noStore.building_pool[1][sb] = 0;
  const memNo = { ...base.mem, expand: {} };
  const ctrl1 = run({ hours: 4, expand: 'off', snap: noStore, mem: memNo }), adopt = run({ hours: 4, expand: 'ask', snap: noStore, mem: memNo });
  const model1 = adopt.mem.expand?.regions?.[1]?.dph ?? 0, gain1 = adopt.perH(4) - ctrl1.perH(4);
  if (LOG) console.log('phase 1 control' + ctrl1.log + '\nphase 1 adopt' + adopt.log);
  await F.t('phase 1: a hand-opened Industrial Basin with no store gets one in ask without a Go, and money/h rises by the model +-15% (+$' + Math.round(gain1).toLocaleString('en-US') + '/h vs modelled $' + Math.round(model1).toLocaleString('en-US') + '/h; $' + Math.round(ctrl1.perH(4)).toLocaleString('en-US') + ' -> $' + Math.round(adopt.perH(4)).toLocaleString('en-US') + '/h)', () => {
    const kinds = ids(adopt).filter((s) => s.startsWith('expand:')).map((s) => s.split(':')[1]);
    assert.ok(kinds.includes('buy') && !kinds.includes('charter') && ids(adopt).some((s) => s.startsWith('retail:shelf:1:')), adopt.log);
    assert.ok(!ids(adopt).some((s) => /expand:buy:(ws|camps|saws)/.test(s)), 'store only' + adopt.log);
    const sg = Object.values(adopt.snap.groups).find((g) => g.region === 1 && g.building === sb);
    assert.ok(sg?.count === 1 && sg.assortment?.length, adopt.log);
    assert.ok(model1 > 0 && Math.abs(gain1 / model1 - 1) <= 0.15, 'gain ' + Math.round(gain1) + ' vs model ' + Math.round(model1) + adopt.log);
    assert.strictEqual(adopt.over, 0, adopt.log);
  });
  const short = run({ hours: 0.5, expand: 'ask', snap: noStore, mem: memNo, edit: (s) => Object.assign(s.stock[0], { [R.id('Iron Frame')]: 2, [R.id('Concrete')]: 18, [R.id('Glass')]: 2 }) });
  await F.t('phase 1: with the live store materials (2 Iron Frames, 18 Concrete, 2 Glass) nothing is bought and the wait names what is short', () => {
    assert.ok(!ids(short).some((s) => s.startsWith('expand:')), short.log);
    assert.ok(short.waits.some((w) => /not opened by Core plan.*Heartland needs # Concrete \(have #\).*Glass \(have #\).*Iron Frame \(have #\)/.test(w)), short.log);
  });
  }
  // Phase 2 (lever 1, M-5): the Gold Mine variant stalls at 355 of 360 acres today (buildout waits on Planks, expansion waited for 360).
  if (SCEN === 'phase2') {
  const ctrl2 = run({ hours: 12, expand: 'off', seed: true, edit: goldEdit }), early = run({ hours: 12, expand: 'auto', seed: true, edit: goldEdit });
  const model2 = early.mem.expand?.regions?.[1]?.dph ?? 0, gain2 = early.perH(12) - ctrl2.perH(12);
  if (LOG) console.log('phase 2 control' + ctrl2.log + '\nphase 2 early' + early.log);
  await F.t('phase 2: Heartland short of 360 acres (Gold Mine variant) still opens Industrial Basin, and money/h rises by >= 85% of the model (+$' + Math.round(gain2).toLocaleString('en-US') + '/h vs modelled $' + Math.round(model2).toLocaleString('en-US') + '/h; $' + Math.round(ctrl2.perH(12)).toLocaleString('en-US') + ' -> $' + Math.round(early.perH(12)).toLocaleString('en-US') + '/h)', () => {
    assert.ok(25 + early.snap.land_bought[0] < 360 && early.snap.charters?.[1] === 1, early.log);
    // M-2: the Iron Frame group is paused for the Iron Sheet and resumed once it ships, so the region sells by hour 4 (it waited ~7 h before)
    const at = (re) => early.ids.findIndex((s) => re.test(s));
    assert.ok(at(/expand:feed:/) >= 0 && at(/expand:unfeed:/) > at(/expand:feed:/) && parseInt(early.ids[at(/retail:shelf:1:/)]) < 240, early.log);
    assert.ok(model2 > 0 && gain2 >= 0.85 * model2, 'gain ' + Math.round(gain2) + ' vs model ' + Math.round(model2) + early.log);
    assert.ok(early.over <= ctrl2.over, early.log);
  });
  // opt-in Heartland land cap (cfg.heartlandLandCap): Industrial Basin chartered, so buildout buys no Heartland acre dearer than a region acre
  const capEdit = (s) => { goldEdit(s); s.charters = { 1: 1 }; };
  const capOff = run({ hours: 3, expand: 'off', edit: capEdit }), capOn = run({ hours: 3, expand: 'off', edit: capEdit, cfg: { heartlandLandCap: true } });
  await F.t('land cap (opt-in): with a region chartered, Heartland stays at 316 acres (each next acre > the region acre) and keeps the cash; off it buys to 355', () => {
    assert.strictEqual(25 + capOn.snap.land_bought[0], 316, capOn.log);
    assert.ok(25 + capOff.snap.land_bought[0] > 340, capOff.log);
    assert.ok(capOn.snap.items[0] > capOff.snap.items[0] + 2e8, 'keeps over $2M more');
  });
  }

  F.done();
})();
