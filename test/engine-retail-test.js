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
//   rival    1 h twice, a rival store at 10,000: with rival mode the empty shelves drop and the rating climbs (plan D2)
//   convert  2 h, plan B4 / R-6: offer, guards, then 22 Gold Mines (Gold Ore unused) become Camps + Sawmills and Planks balance within 2%
//   adopt    2 h twice, a Table Lab process with quality 2: its floor is copied, the Table group adopts it, nothing else moves (plan D1)
const assert = require('assert');
const F = require('./cp-fixtures');
const FX = require('./live-2026-11-28.json');
const SCEN = process.argv[2] ?? 'static';

(async () => {
  const eng = await require('./engine.js').load();
  if (!eng) { console.log('skip: engine wasm not available (offline?)'); return; }
  const cat = eng.catalog();
  const { cp } = F.load(['cp-buildout', 'cp-retail', 'utilities', ...(SCEN === 'adopt' ? ['cp-lab'] : [])]);
  const au = globalThis.autoUtil;
  au.conf.power.on = true;
  const H = 7200, T0 = 1.8e12, PER = 600;
  const id = (n) => cat.items.find((i) => i.name === n).id;
  const wsB = cat.buildings.find((b) => b.name === 'Workshop').id, plId = id('Planks');
  const recName = (r) => (cat.recipes.find((x) => x.id === r)?.name ?? '-').replace(/^(Make|Assemble) /, '');

  // One run: hours simulated; edit(snap, mem) before loading; boardAt(tick) the retail board (static by default); cfg patch for Core plan.
  function run({ hours, edit = () => {}, boardAt = null, cfg = {}, ctxPlus = {} }) {
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
      const ctx = F.ctxOf({ retailBoard: board, mem, now: T0 + ran * 500, tick, contracts: fx.contracts, mods: { autoUtil: au }, ...ctxPlus });
      const out = cp._decide(cp._view(snap, cat, []), ctx);
      const al = ctx._boAlloc?.al;
      const a = out.actions.find((x) => x.director === 'buildout' || x.director === 'retail' || x.id.startsWith('lab:adopt'));
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
  if (SCEN === 'rival') {
    const rb = F.clone(FX.retail); rb.ratings = { 0: { 999: 10000 } };
    const edit = (s) => { s.stock[0][id('Bookshelf')] = 5000; };   // Chair and Table: no stock, output far below demand at a 9% share
    const on = run({ hours: 1, edit, boardAt: () => rb }), off = run({ hours: 1, edit, boardAt: () => rb, cfg: { rivalStockHours: 0 } });
    const rating = (r) => r.snap.retail_ratings?.[0] ?? 0;
    await F.t('engine rival (D2): a rival at 10,000 with Chair always short: the Chair shelf drops and the rating climbs over 1 h (' + rating(on) + ', ' + rating(off) + ' without rival mode)', () => {
      assert.ok(!(on.snap.groups[16].assortment ?? []).includes(id('Chair')), 'shelves ' + JSON.stringify(on.snap.groups[16].assortment) + on.log);
      assert.ok(rating(on) >= 300 && rating(on) > rating(off) + 200, 'rating ' + rating(on) + ' vs ' + rating(off) + on.log);
    });
  }
  if (SCEN === 'convert') {
    // the 3 free acres hold one more Camp first (the build-out builds on free land before it converts): start at the buffer; the Planks
    // stock at about its reserve (with the fixture's 122k there is no conversion: the stock feeds the Workshops, see the gate test)
    const plB = id('Planks'), edit = (s) => { s.groups[0].count += 1; s.stock[0][plB] = 1500; };
    const campB = cat.buildings.find((b) => b.name === 'Lumber Camp').id, sawB = cat.buildings.find((b) => b.name === 'Sawmill').id, mineB = cat.buildings.find((b) => b.name === 'Mine').id;
    const decide0 = (o = {}, st = null, memPatch = {}) => {
      const s = F.clone(FX.snap); edit(s); st?.(s);
      const m = {}, mem = (n) => ({ get: () => m[n] ?? {}, set: (p) => (m[n] = { ...(m[n] ?? {}), ...p }) });
      mem('buildout').set({ ftMine: [3], ...memPatch });
      const saved = { ...cp.cfg }; Object.assign(cp.cfg, o);
      try {
        const v = cp._view(s, cat, FX.market), ctx = F.ctxOf({ retailBoard: FX.retail, mem, now: T0, contracts: FX.contracts, deals: FX.market, mods: { autoUtil: au } });
        const out = cp._decide(v, ctx);
        return { out, cv: cp._buildout.convertStep(v, ctx, out.rule, out.stage), tg: cp._buildout.targets(v, ctx, out.rule) };
      } finally { Object.assign(cp.cfg, saved); }
    };
    await F.t('engine convert (B4): not confirmed yet: no action, the readout offers "Convert 22 Mine (Gold Ore, $X/h) to N Lumber Camps + M Sawmills: +$Y/h, payback Z h"', () => {
      const { cv } = decide0();
      assert.ok(!cv.action && /^conversion offer: Convert 22 Mine \(Gold Ore, \$[\d,]+\/h\) to \d+ Lumber Camps \+ \d+ Sawmills: \+\$[\d,]+\/h, payback [\d.]+ h/.test(cv.wait), JSON.stringify(cv));
    });
    await F.t('engine convert (B4): confirmed: unassign then demolish the 22 Mines in one action', () => {
      const { cv } = decide0({ convertConfirmed: true });
      assert.deepStrictEqual(cv.action.steps.map((x) => x.msg), [{ type: 'UnassignBuildings', group: 12, amount: 22 }, { type: 'DemolishBuilding', building: mineB, amount: 22, region: 0 }]);
    });
    await F.t('engine convert (B4): a Smelt Gold Bar group uses Gold Ore: no conversion; nor a protected or paused group', () => {
      const smelter = cat.buildings.find((b) => b.name === 'Smelter').id, gold = cat.recipes.find((x) => x.name === 'Smelt Gold Bar').id;
      for (const [why, o, st] of [['Smelt Gold Bar', {}, (s) => { s.groups[40] = { building: smelter, count: 1, recipe: gold, name: 'Gold Bar', work: [], modules: {}, equipped: 1 }; }], ['protected', { convertProtect: ['Gold'] }], ['paused', {}, (s) => { s.groups[12].paused = true; }]]) {
        const { cv } = decide0({ convertConfirmed: true, ...o }, st);
        assert.ok(!cv?.action, why + ': ' + cv?.status);
      }
    });
    await F.t('engine convert (review): 122k Planks in stock (burned over 24 h): no conversion, and the Camp / Sawmill minimum nets the stock budget out (no buy)', () => {
      const { cv, tg } = decide0({ convertConfirmed: true }, (s) => { s.stock[0][plB] = FX.snap.stock[0][plB]; });
      assert.ok(!cv?.action && /no conversion while the Planks stock/.test(cv?.status), JSON.stringify(cv));
      assert.ok(tg.camps <= 126 && tg.sawmills <= 113, tg.camps + ' / ' + tg.sawmills + ' ' + JSON.stringify(tg.chain));
    });
    await F.t('engine convert (review): outputs used outside recipes are never converted: Parks (Inspiration, no bid), Iron Mines with no Smelter (Iron Ore is a kit / floor part)', () => {
      const parkB = cat.buildings.find((b) => b.name === 'Park').id, picnic = cat.recipes.find((x) => x.name === 'Host a Picnic').id;
      let { cv } = decide0({ convertConfirmed: true }, (s) => { s.groups[12].count = 14; s.groups[50] = { building: parkB, count: 4, recipe: picnic, name: 'Park', work: [], modules: {}, equipped: 4 }; });
      assert.ok(!(cv?.action?.steps ?? []).some((x) => x.msg.group === 50 || x.msg.building === parkB), JSON.stringify(cv?.action?.steps?.map((x) => x.msg)));
      assert.strictEqual(cv?.action?.steps[0].msg.group, 12, 'the Gold Mines still go: ' + cv?.status);
      ({ cv } = decide0({ convertConfirmed: true }, (s) => { delete s.groups[7]; delete s.groups[12]; }));
      assert.ok(!cv?.action, 'no Iron Mine conversion: ' + cv?.status);
    });
    await F.t('engine convert (review): a resumed conversion demolishes only the units it put in the pool (pool above its p0)', () => {
      const conv = { g: 12, b: mineB, n: 22, p0: 5, camps: 23, saws: 21, text: 'x', at: T0 - 60000 };
      let { cv } = decide0({}, (s) => { delete s.groups[12]; s.building_pool[0][mineB] = 27; }, { conv });
      assert.deepStrictEqual(cv.action.steps.map((x) => x.msg), [{ type: 'DemolishBuilding', building: mineB, amount: 22, region: 0 }]);
      ({ cv } = decide0({}, (s) => { delete s.groups[12]; s.building_pool[0][mineB] = 5; }, { conv }));
      assert.ok(!cv.action.steps.some((x) => x.msg.type === 'DemolishBuilding'), '5 pooled Mines are not its own: ' + JSON.stringify(cv.action.steps.map((x) => x.msg)));
    });
    // rebalance held 30 min and a 1% move gain: the furniture settles on the plan inside the run, so the last hour shows the chain's balance
    // (at the default 3% the allocator keeps one Chair Workshop, about 400 Planks/h under the Bookshelf the chain was sized for)
    const r = run({ hours: 4, edit, cfg: { convertConfirmed: true, rebalanceHours: 0.5, moveGainPct: 1 }, ctxPlus: { deals: FX.market } });
    const cnt = (b) => Object.values(r.snap.groups).filter((g) => g.building === b && (g.region ?? 0) === 0).reduce((a, g) => a + g.count, 0) + (r.snap.building_pool[0][b] ?? 0);
    const camps = cnt(campB) - 126, saws = cnt(sawB) - 113;
    // measured in the engine: Planks the Sawmills make in the last hour (120/h each at x2) against the stock's change over it
    const made = cnt(sawB) * 120, slope = r.stock[4] - r.stock[3], used = made - slope;
    await F.t('engine convert (B4): 22 Mines demolished, ' + camps + ' Camps + ' + saws + ' Sawmills bought and grouped; Planks made ' + made + '/h, stock ' + (slope >= 0 ? '+' : '') + Math.round(slope) + '/h in the last hour (within 2%)', () => {
      assert.ok(r.ids.some((x) => / bo:convert:12:22/.test(x)) && r.ids.some((x) => / bo:convert:buy/.test(x)), r.log);
      assert.strictEqual(cnt(mineB), 7, 'no Gold Mine left (7 other Mines: Iron, Coal, 1 pooled)' + r.log);
      assert.ok(saws >= 18 && camps >= saws, camps + ' Camps, ' + saws + ' Sawmills' + r.log);
      assert.strictEqual(r.snap.building_pool[0][campB] ?? 0, 0, 'Camps grouped'); assert.strictEqual(r.snap.building_pool[0][sawB] ?? 0, 0, 'Sawmills grouped');
      assert.ok(Math.abs(slope) <= 0.02 * made && r.stock[4] > 100, made + ' made, ' + Math.round(used) + ' used' + r.log);
      const furnRun = Object.values(r.snap.groups).filter((g) => g.building === wsB && !g.paused && /Bookshelf|Table|Chair/.test(recName(g.recipe))).reduce((a, g) => a + g.count, 0);
      assert.ok(furnRun >= 18 && !(r.snap.building_pool[0][wsB] ?? 0), 'every furniture Workshop runs (none parked for lack of Planks): ' + furnRun + r.log);
      assert.ok(cnt(campB) * 1080 >= cnt(sawB) * 1200, 'the Camps feed the Sawmills: ' + cnt(campB) + ' x 1,080 vs ' + cnt(sawB) + ' x 1,200 Wood/h');
      noOver(r);
    });
  }
  if (SCEN === 'adopt') {
    const tb = cat.recipes.find((x) => x.name === 'Make Table'), vid = FX.snap.next_recipe_id;
    const edit = (s) => { s.recipes[vid] = { id: vid, name: 'Table Process #4 · Quality +2', building: tb.building, inputs: tb.inputs, outputs: tb.outputs, ticks: tb.ticks, quality: 2 }; s.next_recipe_id = vid + 1; };
    const base = run({ hours: 2 }), r = run({ hours: 2, edit });
    const g = r.snap.groups[14];
    await F.t('engine adopt (D1): a Table process with the same inputs and ticks at quality 2: floor copied, then the Table group adopts it (equipped, x5), Table stays shelved, nothing else moves, money within 3% or better', () => {
      assert.deepStrictEqual(r.ids.filter((x) => / lab:adopt/.test(x)).map((x) => x.split(' ')[1]), ['lab:adopt:floor:' + vid, 'lab:adopt:14:' + vid], r.log);
      assert.ok(g.recipe === vid && g.equipped === g.count && (r.snap.layouts[vid]?.fx?.rate ?? 1) >= 5, JSON.stringify({ recipe: g.recipe, equipped: g.equipped, count: g.count, fx: r.snap.layouts[vid]?.fx }));
      assert.ok((r.snap.groups[16].assortment ?? []).includes(id('Table')), r.log);
      assert.deepStrictEqual(r.ids.filter((x) => !/ lab:/.test(x)).map((x) => x.split(' ')[1]), base.ids.map((x) => x.split(' ')[1]), 'same buildout / retail actions as without the process' + r.log + base.log);
      assert.ok(r.perH(2) >= base.perH(2) * 0.97, '$' + Math.round(r.perH(2)) + ' vs $' + Math.round(base.perH(2)));
    });
  }
  F.done();
})();
