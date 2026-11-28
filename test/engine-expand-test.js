// Engine-backed expansion run (plan C1, E1): Core plan's expand director (cfg.expand 'auto') on the live corp of 2026-11-28
// (test/live-2026-11-28.json: Heartland at 360 acres, $12.3M) in the real engine (test/engine.js). Skips cleanly offline.
//   bun test/engine-expand-test.js        # ENGINE_EXPAND_LOG=1 prints the actions and the hourly money
// Only the expand director's actions are sent (one message a tick, each step waits for its `until`), so Heartland runs as it is and a
// control run with expand 'off' gives the baseline. The fixture holds 2 Iron Frames, 18 Concrete and 2 Glass with its Kiln paused by hand
// (buildout's Kiln gate leaves it alone), so the store materials are seeded; everything else comes from the corp's own stock.
// The engine's tick counter starts at 1: it is moved to the snapshot's courier_ready_at first, or the courier looks busy for 21M ticks.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('./cp-fixtures');
const FX = require('./live-2026-11-28.json');

// cp-expand from the built script when build.js lists it, else straight from src (so it tests before it is registered)
function loadExpand(mods) {
  F.load([...mods, ...(F.full().includes('// @@MODULE cp-expand\n') ? ['cp-expand'] : [])]);
  if (!globalThis.corePlan._expand) (0, eval)(F.slice(fs.readFileSync(path.join(__dirname, '..', 'src', 'cp-expand.js'), 'utf8'), 'cp-expand'));
  return globalThis.corePlan;
}

(async () => {
  const eng = await require('./engine.js').load();
  if (!eng) { console.log('skip: engine wasm not available (offline?)'); return; }
  const cat = eng.catalog();
  const cp = loadExpand(['cp-buildout', 'cp-retail', 'utilities']);
  const au = globalThis.autoUtil;
  const H = 7200, T0 = 1.8e12, PER = 120;
  const id = (n) => cat.items.find((i) => i.name === n).id;
  const storeB = cat.buildings.find((b) => b.name === 'Retail Store').id;

  // seed: the store materials (the fixture has 2 Iron Frames, 18 Concrete, 2 Glass); auto: Auto utilities power on, tending every region it
  // lists (_regionsOf) on its own 2 s cycle as its tend() does: the want, the hold window's peak, the bill timing, then _decide.
  function run(expand, { seed = true, hours = 3, auto = false } = {}) {
    const fx = F.clone(FX), m = {}, mem = (n) => ({ get: () => m[n] ?? {}, set: (p) => (m[n] = { ...(m[n] ?? {}), ...p }) });
    mem('buildout').set({ ftMine: [3] });
    if (seed) Object.assign(fx.snap.stock[0], { [id('Iron Frame')]: 40, [id('Concrete')]: 100, [id('Glass')]: 100 });
    const saved = cp.cfg.expand;
    cp.cfg.expand = expand;
    au.conf.power.on = auto;
    const e = new eng.Engine(fx.snap.ssi.corp_id);
    e.load(fx.snap); e.setRetail(fx.retail); e.setMarket(fx.market); e.setContracts(fx.contracts);
    e.tickAt(fx.snap.courier_ready_at + 1);
    let tick = e.tick([]).tick, ran = 0, snap = e.snapshot();
    const r = { money: [snap.items[0]], ids: [], doneAt: null, waits: [], levels1: [], over1: 0, storeDark: 0 };
    const samples = {}, first = {};
    const measure = (reg) => au._measure('power', reg, snap, cat, tick, fx.contracts);
    function auCycle() {
      for (const reg of au._regionsOf('power', snap)) {
        const x = measure(reg), spare = au.conf.power.spare;
        const { want } = au._want(x, spare), urgent = au._want({ ...x, need: x.need - x.waiting - x.ending }, spare).want;
        const s = (samples[reg] ??= []); first[reg] ??= tick;
        s.push({ t: tick, want });
        while (s.length > 1 && s[0].t < tick - au.conf.holdMin * 120) s.shift();
        const d = au._decide({ util: 'power', have: x.have, want, peak: Math.max(...s.map((y) => y.want)), observedMs: (tick - first[reg]) * 500, holdMs: au.conf.holdMin * 60000,
          money: snap.items[0], bills: 0, ticksToBill: 1200 - (tick % 1200), canLower: true, urgent });
        if (d.kind === 'raise' || d.kind === 'lower') { step([{ type: 'SetSubscription', region: reg, utility: 'power', level: d.level }]); if (reg === 1) r.levels1.push(d.level); }
      }
    }
    const step = (msgs = []) => {
      const d = e.tick(msgs); if (d?.tick) tick = d.tick; ran++; snap = e.snapshot(); if (ran % H === 0) r.money.push(snap.items[0]);
      if (auto && Object.values(snap.groups).some((g) => g.region === 1)) {
        const x = measure(1);
        if (x.load > x.have + x.imported + x.gen + 1e-9) r.over1++;
      }
    };
    while (ran < hours * H) {
      const ctx = F.ctxOf({ retailBoard: fx.retail, mem, now: T0 + ran * 500, tick, contracts: fx.contracts, mods: auto ? { autoUtil: au } : {} });
      const out = cp._decide(cp._view(snap, cat, []), ctx);
      const a = out.actions.find((x) => x.director === 'expand' || /^retail:shelf:\d+:/.test(x.id));   // a region's shelves: cp-retail's region pass
      const w = out.waits.find((x) => /^expand:/.test(x));
      if (w && r.waits[r.waits.length - 1] !== w.replace(/\d+/g, '#')) r.waits.push(w.replace(/\d+/g, '#'));
      if (a) {
        r.ids.push(Math.floor(ran / 120) + 'm ' + a.id);
        for (const st of a.steps) { step([st.msg]); for (let k = 0; k < 40 && !st.until(cp._view(snap, cat, [])); k++) step(); }
      }
      if (r.doneAt == null && m.expand?.regions?.[1]) r.doneAt = ran;
      const to = Math.min(hours * H, (Math.floor(ran / PER) + 1) * PER);
      while (ran < to) { step(); if (auto && ran % 4 === 0) auCycle(); }
    }
    cp.cfg.expand = saved;
    au.conf.power.on = false;
    r.mem = m; r.snap = snap;
    r.perH = (h) => (r.money[h] - r.money[h - 1]) / 100;
    r.log = '\nactions: ' + r.ids.join(', ') + '\nwaits: ' + r.waits.join(' | ') + '\n$/h: ' + r.money.slice(1).map((x, h) => Math.round(r.perH(h + 1))).join(', ') + (auto ? '\nregion 1 levels: ' + r.levels1.join(' ') + ', ticks over supply ' + r.over1 : '') + '\nmem: ' + JSON.stringify(m.expand ?? {}).slice(0, 1500);
    if (process.env.ENGINE_EXPAND_LOG) console.log(expand + (auto ? ' + Auto utilities' : '') + (seed ? '' : ' unseeded') + r.log);
    return r;
  }

  const HOURS = 3;
  const bare = run('auto', { seed: false, hours: 0.5 });
  await F.t('engine expand: on the live fixture as it is (store materials short, Kiln paused by hand) auto buys nothing and names what is short', () => {
    assert.strictEqual(bare.ids.length, 0, bare.log);
    assert.ok(!bare.mem.expand?.run && !(bare.snap.charters?.[1] > 0), bare.log);
    assert.ok(bare.waits.some((w) => /Heartland needs # Concrete \(have #\), # Glass \(have #\), # Iron Frame \(have #\)/.test(w)), bare.log);
  });
  const ctrl = run('off'), x = run('auto');
  const reg = x.mem.expand?.regions?.[1], model = reg?.dph ?? 0;
  const gain = x.perH(HOURS) - ctrl.perH(HOURS);
  await F.t('engine expand: auto opens Industrial Basin in order (charter, land, shipments, buildings, power, Workshop group first, store) within ' + (HOURS - 1) + ' simulated hours', () => {
    assert.ok(x.doneAt != null && x.doneAt <= (HOURS - 1) * H, 'not done by hour ' + (HOURS - 1) + x.log);
    const kinds = x.ids.map((s) => s.split(' ')[1].split(':')[1]);
    const first = (k) => kinds.indexOf(k);
    assert.deepStrictEqual(kinds.slice(0, 2), ['charter', 'land'], x.log);
    assert.ok(first('ship') > first('land') && first('buy') > first('ship') && first('power') > first('buy') && first('group') > first('power'), x.log);
    const groups = x.ids.filter((s) => / expand:group:/.test(s)).map((s) => s.split(':')[2]);
    const B = (n) => String(cat.buildings.find((b) => b.name === n).id);
    assert.strictEqual(groups[0], B('Workshop'), 'Workshops are grouped first' + x.log);
    assert.ok(x.ids.some((s) => / expand:buy:store/.test(s)) && x.ids.some((s) => / retail:shelf:1:/.test(s)), x.log);
    assert.ok(!x.mem.expand.run, 'the run finished' + x.log);
    assert.ok(!(globalThis.idleCore.acreHolds?.[1] > 0), 'the acre hold is released once the run is done');
  });
  await F.t('engine expand: the region sells, and money/h in hour ' + HOURS + ' rises by the modelled $' + Math.round(model).toLocaleString('en-US') + '/h +-15% (measured +$' + Math.round(gain).toLocaleString('en-US') + '/h over the control run)', () => {
    const sg = Object.values(x.snap.groups).find((g) => g.region === 1 && g.building === cat.buildings.find((b) => b.name === 'Retail Store').id);
    assert.ok(sg?.count === 1 && sg.assortment?.length, 'a Retail group with shelves in Industrial Basin' + x.log);
    assert.ok(model > 0, x.log);
    assert.ok(Math.abs(gain / model - 1) <= 0.15, 'gain ' + Math.round(gain) + ' vs model ' + Math.round(model) + x.log);
  });
  const ctrlA = run('off', { auto: true }), xa = run('auto', { auto: true });
  const gainA = xa.perH(HOURS) - ctrlA.perH(HOURS), modelA = xa.mem.expand?.regions?.[1]?.dph ?? 0;
  await F.t('engine expand with Auto utilities managing both regions: no SetSubscription from the director, the region grid settles (no raise/lower loop), its load never exceeds supply, and the gain holds (+$' + Math.round(gainA).toLocaleString('en-US') + '/h vs modelled $' + Math.round(modelA).toLocaleString('en-US') + '/h)', () => {
    assert.ok(xa.doneAt != null && xa.doneAt <= (HOURS - 1) * H, 'not done by hour ' + (HOURS - 1) + xa.log);
    assert.ok(!xa.ids.some((s) => / expand:power:/.test(s)), 'the director sent no SetSubscription' + xa.log);
    assert.ok(xa.levels1.length >= 1 && xa.levels1.length <= 4, 'region 1 level changes: ' + xa.levels1.join(' ') + xa.log);
    assert.strictEqual(xa.over1, 0, xa.log);
    const sg = Object.values(xa.snap.groups).find((g) => g.region === 1 && g.building === storeB);
    assert.ok(sg?.count === 1 && sg.assortment?.length, xa.log);
    assert.ok(modelA > 0 && Math.abs(gainA / modelA - 1) <= 0.15, 'gain ' + Math.round(gainA) + ' vs model ' + Math.round(modelA) + xa.log);
  });
  F.done();
})();
