// Engine-backed retail runs (plan E1): Core plan's buildout and retail directors with the retail allocator, and Auto utilities' grid level,
// on the live corp of 2026-11-28 (test/live-2026-11-28.json) in the real engine (test/engine.js). Skips cleanly offline.
//   bun test/engine-retail-test.js [static|churn|reserve|board|pool]   # ENGINE_RETAIL_LOG=1 prints one line per simulated hour
// Loop: every PER ticks Core plan decides on engine.snapshot(); the first buildout / retail action goes in one message per tick (each step
// waits for its `until`). Auto utilities runs on its own clock as in the game: every 4 ticks (its 2 s cycle) it sets the level au._want
// asks for (asks from Core plan included). Load <= supply is checked on every tick, the ticks right after an action included.
//   static   4 h, the fixture as it is: money, sales, recipe changes, power
//   churn    8 h, the Table group paused by the user and 12,000 Planks: the plan must not churn Workshops (review fix 1)
//   reserve  10 h, 12,000 Planks burned over 6 h: the stock runs down to the reserve line and stays near it (review fix 2)
//   board    9 h, board prices / appetite swinging +-15% every 45 min: the smoothed plan settles on the best good (review fix 4)
//   pool     2 h, 4 Workshops left in the pool with the Bookshelf group running: the tidy waits for power (review fix 5)
const assert = require('assert');
const F = require('./cp-fixtures');
const FX = require('./live-2026-11-28.json');
const SCEN = process.argv[2] ?? 'static';

(async () => {
  const eng = await require('./engine.js').load();
  if (!eng) { console.log('skip: engine wasm not available (offline?)'); return; }
  const cat = eng.catalog();
  const { cp } = F.load(['cp-buildout', 'cp-retail', 'utilities']);
  const au = globalThis.autoUtil;
  au.conf.power.on = true;
  const H = 7200, T0 = 1.8e12, PER = 600;
  const id = (n) => cat.items.find((i) => i.name === n).id;
  const wsB = cat.buildings.find((b) => b.name === 'Workshop').id, plId = id('Planks');
  const recName = (r) => (cat.recipes.find((x) => x.id === r)?.name ?? '-').replace(/^(Make|Assemble) /, '');

  // One run: hours simulated; edit(snap, mem) before loading; boardAt(tick) the retail board (static by default); cfg patch for Core plan.
  function run({ hours, edit = () => {}, boardAt = null, cfg = {} }) {
    const fx = F.clone(FX), m = {}, mem = (n) => ({ get: () => m[n] ?? {}, set: (p) => (m[n] = { ...(m[n] ?? {}), ...p }) });
    mem('buildout').set({ ftMine: [3] });   // the 11 paused Frame Timber Workshops were paused by Core plan's Wooden Frame gate
    edit(fx.snap, mem);
    const saved = { ...cp.cfg };
    Object.assign(cp.cfg, cfg);
    const e = new eng.Engine(fx.snap.ssi.corp_id);
    let board = boardAt ? boardAt(0) : fx.retail;
    e.load(fx.snap); e.setRetail(board); e.setMarket(fx.market); e.setContracts(fx.contracts);
    let tick = 0, ran = 0, snap = e.snapshot();
    const r = { over: [], sold: new Array(hours).fill(0), money: [snap.items[0]], stock: [snap.stock[0][plId]], changes: {}, counts: {}, ids: [], hourly: [], als: [] };
    const lastRecipe = {}, lastCount = {};
    const measure = (s) => au._measure('power', 0, s, cat, tick, fx.contracts);
    const grid = () => { const w = au._want(measure(snap)).want; if (w !== (snap.subscriptions[0]?.power ?? 0)) step([{ type: 'SetSubscription', region: 0, utility: 'power', level: w }]); };
    function step(msgs = []) {
      const before = snap, d = e.tick(msgs);
      if (d?.tick) tick = d.tick;
      ran++;
      snap = e.snapshot();
      const x = measure(snap);
      if (x.load > x.have + x.imported + x.gen + 1e-9) r.over.push(ran);
      const hr = Math.min(hours - 1, Math.floor((ran - 1) / H));
      for (const i of snap.groups[16]?.assortment ?? []) r.sold[hr] += Math.max(0, (before.stock[0][i] ?? 0) - (snap.stock[0][i] ?? 0));
      for (const [gid, g] of Object.entries(snap.groups)) {
        if (g.building !== wsB) continue;
        if (g.recipe != null) { if (lastRecipe[gid] != null && lastRecipe[gid] !== g.recipe) (r.changes[gid] ??= []).push(ran); lastRecipe[gid] = g.recipe; }
        if (lastCount[gid] != null && lastCount[gid] !== g.count) (r.counts[gid] ??= []).push(g.count - lastCount[gid]);
        lastCount[gid] = g.count;
      }
      if (ran % H === 0) { r.money.push(snap.items[0]); r.stock.push(snap.stock[0][plId]); }
      if (boardAt) { const b = boardAt(ran); if (b !== board) { board = b; e.setRetail(b); } }
      if (ran % 4 === 0) grid();   // Auto utilities' own 2 s cycle
    }
    grid();
    while (ran < hours * H) {
      const ctx = F.ctxOf({ retailBoard: board, mem, now: T0 + ran * 500, tick, contracts: fx.contracts, mods: { autoUtil: au } });
      const out = cp._decide(cp._view(snap, cat, []), ctx);
      const al = ctx._boAlloc?.al;
      const a = out.actions.find((x) => x.director === 'buildout' || x.director === 'retail');
      if (a) {
        r.ids.push(Math.floor(ran / 120) + 'm ' + a.id);
        for (const st of a.steps) { step([st.msg]); for (let k = 0; k < 40 && !st.until(cp._view(snap, cat, [])); k++) step(); }
      }
      const to = Math.min(hours * H, (Math.floor(ran / PER) + 1) * PER);
      while (ran < to) step();
      if (ran % H === 0) {
        const gs = Object.values(snap.groups).filter((g) => g.building === wsB);
        r.als.push(al);
        r.hourly.push('h' + ran / H + ': $' + Math.round((r.money[r.money.length - 1] - r.money[r.money.length - 2]) / 100) + '/h, grid ' + snap.subscriptions[0].power + ' MW, sold ' + r.sold[ran / H - 1]
          + ', Workshops ' + gs.map((g) => g.count + (g.paused ? 'p' : '') + ' ' + recName(g.recipe)).join(' / ') + ', pool ' + (snap.building_pool[0][wsB] ?? 0)
          + ', Planks ' + Math.round(snap.stock[0][plId]) + (al ? ', plan $' + Math.round(al.dollarsPerHour) + '/h ' + al.binding + (al.burn ? ' burn +' + Math.round(al.extra) + '/h' : '') + ' reserve ' + Math.round(al.reserve) : ''));
        if (process.env.ENGINE_RETAIL_LOG) console.log(r.hourly[r.hourly.length - 1]);
      }
    }
    if (process.env.ENGINE_RETAIL_LOG) console.log('actions: ' + r.ids.join(', '));
    r.mem = m; r.snap = snap; r.cat = cat;
    r.perH = (h) => (r.money[h] - r.money[h - 1]) / 100;
    r.moves = r.ids.filter((x) => / bo:(split|rebal|stepback|park|assign|create|pool)/.test(x));
    r.log = '\n' + r.hourly.join('\n') + '\nactions: ' + r.ids.join(', ') + (r.over.length ? '\nover supply at ticks ' + r.over.slice(0, 10).join(', ') : '');
    Object.assign(cp.cfg, saved);
    return r;
  }
  const noOver = (r) => assert.deepStrictEqual(r.over.length, 0, r.over.length + ' ticks with load over supply' + r.log);

  if (SCEN === 'static') {
    const r = run({ hours: 4 });
    const lastH = r.perH(4);
    await F.t('engine retail (E1a): money in the last of 4 simulated hours >= $350k/h ($' + Math.round(lastH).toLocaleString('en-US') + ')', () => assert.ok(lastH >= 350000, '$' + Math.round(lastH) + '/h' + r.log));
    await F.t('engine retail (E1b): the store sells every hour', () => r.sold.forEach((n, h) => assert.ok(n > 0, 'hour ' + (h + 1) + ' sold nothing' + r.log)));
    await F.t('engine retail (E1c): no Workshop group changes recipe more than once per rebalanceHours', () => {
      const gap = cp.cfg.rebalanceHours * H;
      for (const [g, ts] of Object.entries(r.changes)) for (let k = 1; k < ts.length; k++) assert.ok(ts[k] - ts[k - 1] >= gap, 'group ' + g + ' changed recipe at ticks ' + ts.join(', ') + r.log);
    });
    await F.t('engine retail (E1d): load never exceeds supply on any tick, with Auto utilities on its own 2 s cycle (moves wait for the power they asked for)', () => noOver(r));
  }

  if (SCEN === 'churn') {
    const r = run({ hours: 8, edit: (s) => { s.groups[14].paused = true; s.stock[0][plId] = 12000; } });
    await F.t('engine churn (review fix 1): a user-paused Table group and 12,000 Planks: at most 4 Workshop moves in 8 h (' + r.moves.length + '), the paused group untouched', () => {
      assert.ok(r.moves.length <= 4, r.moves.length + ' moves' + r.log);
      assert.ok(!r.counts[14], 'the paused Table group keeps its Workshops' + r.log);
      assert.ok(r.snap.groups[14].paused && r.snap.groups[14].count === 2, r.log);
      for (const [g, d] of Object.entries(r.counts)) assert.ok(!(d.some((x) => x > 0) && d.some((x) => x < 0)) || d.length <= 2, 'group ' + g + ' grew and shrank: ' + d + r.log);
    });
    await F.t('engine churn: the plan counts only running Workshops, and the run makes >= $380k/h in the last hour ($' + Math.round(r.perH(8)).toLocaleString('en-US') + ')', () => {
      const al = r.als[r.als.length - 1];
      const running = Object.values(r.snap.groups).filter((g) => g.building === wsB && !g.paused && /Bookshelf|Table|Chair/.test(recName(g.recipe))).reduce((a, g) => a + g.count, 0);
      assert.ok(al.byKey.bookshelf + al.byKey.table + al.byKey.chair <= running + (r.snap.building_pool[0][wsB] ?? 0), JSON.stringify(al.byKey) + r.log);
      assert.ok(r.perH(8) >= 380000, r.log);
      assert.ok((r.mem.buildout.groupsMine ?? []).length <= 4, 'groupsMine ' + JSON.stringify(r.mem.buildout.groupsMine));
      noOver(r);
    });
  }

  if (SCEN === 'reserve') {
    const r = run({ hours: 10, edit: (s) => { s.stock[0][plId] = 12000; }, cfg: { stockBurnHours: 6 } });
    const al = r.als[r.als.length - 1], reserve = al.reserve, reachH = r.stock.findIndex((x) => x <= reserve + 4 * 900);
    await F.t('engine reserve (review fix 2): 12,000 Planks burned over 6 h run down to the reserve line (reserve + 4 h of one Workshop) by hour ' + reachH + ', then stay within the band', () => {
      assert.ok(reachH > 0 && reachH <= 8, 'Planks by hour ' + r.stock.map(Math.round).join(', ') + ', reserve ' + Math.round(reserve) + r.log);
      for (const x of r.stock.slice(reachH)) assert.ok(x <= (reserve + 4 * 900) * 1.5 && x >= reserve * 0.5, 'Planks ' + Math.round(x) + r.log);
      assert.ok(r.moves.length <= 10, r.moves.length + ' moves' + r.log);
      noOver(r);
    });
  }

  if (SCEN === 'board') {
    const base = FX.retail, furn = ['Bookshelf', 'Table', 'Chair'].map(id), PERIOD = 45 * 120, cache = new Map();
    const boardAt = (t) => {
      const k = Math.floor(t / PERIOD);
      if (!cache.has(k)) {
        const b = F.clone(base);
        furn.forEach((i, j) => { const s = ((k + j) % 2 ? 1 : -1) * 0.15, row = b.shelves[0][i]; row.price = Math.round(row.price * (1 + s)); row.appetite = Math.round(row.appetite * (1 - s)); });
        cache.set(k, b);
      }
      return cache.get(k);
    };
    const r = run({ hours: 9, boardAt });
    const shelves = Object.values(r.snap.groups).filter((g) => g.building === wsB && recName(g.recipe) === 'Bookshelf').reduce((a, g) => a + g.count, 0);
    await F.t('engine board (review fix 4): prices swinging +-15% every 45 min: the smoothed plan settles on Bookshelf (best on average) and holds (' + shelves + ' Bookshelf Workshops at 9 h)', () => {
      assert.ok(shelves >= 15, shelves + ' Bookshelf' + r.log);
      const plans = r.als.slice(-3).map((a) => a.byKey.bookshelf);
      assert.ok(plans.every((x) => x >= 15), 'plans ' + plans + r.log);
      const gap = cp.cfg.rebalanceHours * H;
      for (const [g, ts] of Object.entries(r.changes)) for (let k = 1; k < ts.length; k++) assert.ok(ts[k] - ts[k - 1] >= gap, 'group ' + g + ' changed recipe at ticks ' + ts.join(', ') + r.log);
      noOver(r);
    });
  }

  if (SCEN === 'pool') {
    const r = run({ hours: 2, edit: (s, mem) => {
      s.groups[15].work = [{ recipe: s.groups[15].recipe, runs: 25, buildings: 5, remaining: 100, inputs_pct: 100, outputs_pct: 100 }];   // the Bookshelf group runs
      s.groups[3].count = 7; (s.building_pool[0] ??= {})[wsB] = 4; mem('buildout').set({ poolMine: { [wsB]: 4 } });             // 4 of the 11 left in the pool
    } });
    await F.t('engine pool (review fix 5): Workshops the tidy puts into a running group wait for the power Auto utilities raises first: load never over supply', () => {
      assert.ok(r.moves.some((x) => / bo:assign:15/.test(x)), 'the tidy placed them' + r.log);
      assert.strictEqual(r.snap.building_pool[0][wsB] ?? 0, 0, r.log);
      noOver(r);
    });
  }
  F.done();
})();
