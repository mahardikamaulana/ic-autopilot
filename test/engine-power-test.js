// Engine-backed power checks (plan A3, review fixes 1, 6, 11): Auto utilities' level and Core plan's Frame Timber switch run against
// the real simulation (test/engine.js) on the live corp of 2026-11-28 (test/live-2026-11-28.json). Skips cleanly offline.
//   bun test/engine-power-test.js
const assert = require('assert');
const F = require('./cp-fixtures');
const fx = require('./live-2026-11-28.json');

(async () => {
  const eng = await require('./engine.js').load();
  if (!eng) { console.log('skip: engine wasm not available (offline?)'); return; }
  const cat = eng.catalog();
  const { cp } = F.load(['cp-buildout', 'cp-retail', 'utilities']);
  const au = globalThis.autoUtil;
  const STORE_G = 16, SHELF_G = 15;
  const shelfIds = fx.snap.groups[STORE_G].assortment;
  const fresh = (snap = fx.snap, contracts = fx.contracts) => {
    const e = new eng.Engine(snap.ssi.corp_id);
    e.load(snap); e.setRetail(fx.retail); e.setMarket(fx.market); e.setContracts(contracts);
    return e;
  };
  let tick = fx.snap.ssi.last_user_mutation_tick;
  const step = (e, msgs = []) => { const d = e.tick(msgs); if (d?.tick) tick = d.tick; return d; };
  const measure = (s, contracts) => au._measure('power', 0, s, cat, tick, contracts);
  const want = (s, contracts) => au._want(measure(s, contracts)).want;
  const setGrid = (level) => ({ type: 'SetSubscription', region: 0, utility: 'power', level });
  // The store sells what is made: Table / Chair (made by running groups) never pile up in stock; money rises by the sales.
  function sells(e, ticks = 1200) {
    const s0 = e.snapshot();
    for (let i = 0; i < ticks; i++) step(e);
    const s = e.snapshot();
    return { money: (s.items[0] - s0.items[0]) / 100, piled: shelfIds.filter((i) => (s.stock[0][i] ?? 0) > (s0.stock[0][i] ?? 0) && i !== 27), s };
  }

  await F.t('engine: the live corp needs exactly 7 MW of grid: at 6 the Bookshelf x5 stays idle, at 7 it starts and the store still sells', () => {
    const w = want(fx.snap, fx.contracts);
    assert.strictEqual(w, 7, JSON.stringify(measure(fx.snap, fx.contracts)));
    const at = (level) => { const e = fresh(); step(e, [setGrid(level)]); return sells(e); };
    const r6 = at(6), r7 = at(7);
    assert.deepStrictEqual(r6.s.groups[SHELF_G].work, [], 'at 6 MW the Bookshelf group cannot start');
    assert.ok(r7.s.groups[SHELF_G].work.length > 0, 'at 7 MW it starts');
    assert.deepStrictEqual(r7.piled, [], 'the store sells Table and Chair as they are made');
    assert.ok(r7.money > 5000, 'money rises by the sales: $' + r7.money);
  });

  await F.t('engine: contracts lost: Auto utilities re-measures, raises, and the store sells again', () => {
    const e = fresh(fx.snap, []);
    step(e, [setGrid(fx.snap.subscriptions[0].power)]);
    const dark = sells(e);
    assert.ok(dark.piled.length > 0, 'without the 19 MW of contracts the store is dark (stock piles up)');
    const w = want(e.snapshot(), []);
    assert.ok(w >= 21, 'want ' + w + ' covers the whole load on the grid');
    step(e, [setGrid(w)]);
    const lit = sells(e);
    assert.deepStrictEqual(lit.piled, [], 'after the raise the store sells');
    assert.ok(lit.money > dark.money + 3000, 'money: dark $' + dark.money + ', lit $' + lit.money);
  });

  // Core plan's buildout + retail on the engine: each action's messages go in one tick at a time, then the engine runs a minute.
  function runPlan(snap, steps = 6) {
    const e = fresh(snap);
    step(e, [setGrid(want(snap, fx.contracts))]);
    for (let i = 0; i < 120; i++) step(e);
    const m = {}, mem = (n) => ({ get: () => m[n] ?? {}, set: (p) => (m[n] = { ...(m[n] ?? {}), ...p }) });
    mem('buildout').set({ ftMine: [3] });
    const ids = [], over = [];
    for (let k = 0; k < steps; k++) {
      const s = e.snapshot();
      const ctx = F.ctxOf({ retailBoard: fx.retail, mem, now: 1.8e12 + k * 60000, tick, contracts: fx.contracts, mods: { autoUtil: au } });
      const out = cp._decide(cp._view(s, cat, []), ctx);
      const a = out.actions.find((x) => x.director === 'buildout' || x.director === 'retail');
      if (!a) break;
      ids.push(a.id + ' ' + a.text);
      for (const st of a.steps) {
        step(e, [st.msg]);
        for (let i = 0; i < 120; i++) {
          step(e);
          const x = measure(e.snapshot(), fx.contracts);
          if (x.load > x.have + x.imported + x.gen) over.push(a.id + ' tick ' + i + ': load ' + x.load + ' > ' + (x.have + x.imported + x.gen));
        }
      }
    }
    return { ids, over, e };
  }

  await F.t('engine: the Frame Timber switch never puts load above supply (live corp, and with the 11 paused without work rows)', () => {
    const live = runPlan(fx.snap);
    assert.ok(live.ids.some((x) => /^bo:split:3 /.test(x)), live.ids.join('\n'));
    assert.deepStrictEqual(live.over, [], live.ids.join('\n'));
    // the 11 paused with no work rows draw nothing: a move into a running group (Chair) adds its draw at once, so it waits for power
    const snap = F.clone(fx.snap);
    snap.groups[3].work = [];
    const cold = runPlan(snap);
    assert.deepStrictEqual(cold.over, [], cold.ids.join('\n'));
  });

  F.done();
})();
