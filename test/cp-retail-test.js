// Tests for the retail director (src/cp-retail.js): pre-store gate, store build + shelves against the fake server,
// board shape assertion, and the wiki 4.7 checkpoint fed with steady / saturating / decaying boards over simulated time.
//   CP_FROM_SRC=1 bun test/cp-retail-test.js
const assert = require('assert');
const F = require('./cp-fixtures');
const { t, done, clone, waitFor } = F;
const cat = F.stageB.catalog;
const B = (n) => F.B(n, cat), I = (n) => F.I(n, cat), Rc = (n) => F.Rc(n, cat);
const MIN = 60000;

// Live Stage B corp moved to Stage C: Assembly Plant and Retail Store unlocked, Workshops on furniture, plenty of furniture in stock.
function liveC({ stock = 50000, counts = {} } = {}) {
  const st = F.liveB();
  st.research = null; st.research_queue = [];
  st.unlocked_buildings = [...new Set([...st.unlocked_buildings, B('Assembly Plant'), B('Retail Store')])];
  const furn = (gid, rn) => { const g = st.groups[gid]; if (counts[gid]) g.count = counts[gid]; g.recipe = Rc(rn); g.work = [{ recipe: Rc(rn), runs: g.count * 5, buildings: g.count, remaining: 100, inputs_pct: 100, outputs_pct: 100 }]; };
  furn(3, 'Make Bookshelf'); furn(8, 'Make Table'); furn(11, 'Make Chair');
  for (const n of ['Bookshelf', 'Table', 'Chair']) st.stock[0][I(n)] = stock;
  st.items[F.MONEY] = 50000000;
  st.land_bought[0] += 3;   // the live corp has no free acre; the store needs 3
  st.stock[0][I('Iron Frame')] = 100;   // the store's 6 plus the 44 kept for prototypes
  return st;
}
const board = () => clone(F.stageB.retail);
const shelfIds = () => [I('Bookshelf'), I('Table'), I('Chair')];
// One mem store shared by every ctx of a run (the runner's is localStorage).
const memFn = () => { const m = {}; return (n) => ({ get: () => m[n] ?? {}, set: (p) => (m[n] = { ...(m[n] ?? {}), ...p }) }); };

(async () => {
  const { cp } = F.load(['cp-retail']);
  const dec = (st, o = {}) => { const ctx = F.ctxOf({ retailBoard: board(), deals: F.stageB.deals, ...o }); const v = cp._view(st, cat, F.stageB.deals); const out = cp._decide(v, ctx); return { out, ctx, v, r: out.actions.filter((a) => a.director === 'retail'), w: out.waits.filter((x) => x.startsWith('retail:')) }; };

  await t('director is registered with its defaults', () => {
    assert.ok(cp.directors().includes('retail'));
    assert.strictEqual(cp.cfg.stockHoursPerShelf, 1);
    assert.strictEqual(cp.cfg.retailSamplePassPct, 70);
  });

  await t('Stage B (store not unlocked): waits, sends nothing', () => {
    const { r, w } = dec(F.liveB());
    assert.strictEqual(r.length, 0);
    assert.ok(w.some((x) => /not unlocked/.test(x)), w.join(' | '));
  });

  await t('unlocked + stocked: one action buys the store then groups it "Retail"', () => {
    const st = liveC();
    const { r, v } = dec(st);
    assert.ok(v.freeAcres >= 3, 'fixture needs 3 free acres, has ' + v.freeAcres);
    assert.strictEqual(r.length, 1, JSON.stringify(r));
    const s = r[0].steps.map((x) => x.msg);
    assert.deepStrictEqual(s[0], { type: 'BuyBuilding', building: B('Retail Store'), amount: 1, region: 0 });
    assert.deepStrictEqual(s[1], { type: 'CreateGroup', building: B('Retail Store'), amount: 1, name: 'Retail', region: 0 });
    assert.strictEqual(r[0].hold, true);
  });

  await t('store already in the pool: only CreateGroup (no second purchase)', () => {
    const st = liveC(); st.building_pool[0][B('Retail Store')] = 1;
    const { r } = dec(st);
    assert.deepStrictEqual(r[0].steps.map((x) => x.msg.type), ['CreateGroup']);
  });

  await t('pre-store gate: 1 h of what sells = min(demand, output); live output opens it within the hour', () => {
    const st = liveC(); st.stock[0][I('Chair')] = 10;
    const { r, w } = dec(st);
    assert.strictEqual(r.length, 0);
    // Chair: demand 302 x 30 = 9,060/h but the one Chair Workshop makes 37.5/h, so 1 h of sales is 38
    assert.ok(w.some((x) => /pre-store gate: Chair 10 \/ 38 /.test(x)), w.join(' | '));
    st.stock[0][I('Chair')] = 38;
    assert.strictEqual(dec(st).r.length, 1);
    cp.cfg.stockHoursPerShelf = 2;
    assert.ok(dec(st).w.some((x) => /Chair 38 \/ 75 \(2 h/.test(x)));
    cp.cfg.stockHoursPerShelf = 1;
    // from empty stock every made good reaches its gate in at most 1 h of its own output
    const st0 = liveC({ stock: 0 });
    const { ctx } = dec(st0);
    for (const x of ctx.retail.need) assert.ok(x.need <= Math.ceil(x.g.outTick * 7200), x.g.name + ' needs ' + x.need + ' vs ' + x.g.outTick * 7200 + '/h');
    for (const x of ctx.retail.need) st0.stock[0][x.g.id] = x.need;
    assert.strictEqual(dec(st0).r.length, 1, 'gate open after 1 h of output');
  });

  await t('pre-store gate: a held-only good (no group) does not block the store', () => {
    const st = liveC(); st.stock[0][I('Bench')] = 10;
    const { r, w, ctx } = dec(st);
    assert.ok(ctx.retail.chosen.some((g) => g.name === 'Bench'), 'Bench still shelved');
    assert.ok(!ctx.retail.need.some((x) => x.g.name === 'Bench'));
    assert.strictEqual(r.length, 1, w.join(' | '));
    assert.strictEqual(r[0].steps[0].msg.type, 'BuyBuilding');
  });

  await t('store gate: Iron Frames keep cfg.ifReserve back; bill floor on top of the price', () => {
    const st = liveC(); st.stock[0][I('Iron Frame')] = 6;
    const a = dec(st);
    assert.strictEqual(a.r.length, 0);
    assert.ok(a.w.some((x) => /store needs 6 Iron Frame \(\+44 kept for prototypes\)/.test(x)), a.w.join(' | '));
    st.stock[0][I('Iron Frame')] = 50;
    assert.strictEqual(dec(st).r.length, 1);
    // price $15,000; bill floor 2 MW x $20 + 12 x (11 MW x $10) = $1,360
    st.items[F.MONEY] = 1500000 + 100000;
    const b = dec(st);
    assert.strictEqual(b.r.length, 0);
    assert.ok(b.w.some((x) => /bill floor \$1,360/.test(x)), b.w.join(' | '));
    st.items[F.MONEY] = 1500000 + 136000;
    assert.strictEqual(dec(st).r.length, 1);
  });

  await t('empty Retail group: pooled store is assigned to it, no new group, no rebuy', () => {
    const st = liveC();
    st.groups[99] = { building: B('Retail Store'), region: 0, count: 0, recipe: null, name: 'Retail', modules: {}, assortment: shelfIds() };
    st.building_pool[0][B('Retail Store')] = 1;
    const a = dec(st);
    assert.deepStrictEqual(a.r[0].steps.map((x) => x.msg), [{ type: 'AssignBuildings', group: 99, amount: 1 }]);
    st.building_pool[0][B('Retail Store')] = 0;
    const b = dec(st);
    assert.strictEqual(b.r.length, 0);
    assert.ok(b.w.some((x) => /manual: empty Retail group 99/.test(x)), b.w.join(' | '));
  });

  await t('store prerequisites: missing Glass or free acres block the build', () => {
    const { cp: c2 } = F.load(['cp-retail']);
    const st = liveC(); st.stock[0][I('Glass')] = 5;
    const ctx = F.ctxOf({ retailBoard: board() });
    const out = c2._decide(c2._view(st, cat, []), ctx);
    assert.ok(out.waits.some((x) => /store needs 20 Glass/.test(x)), out.waits.join(' | '));
    const st2 = liveC(); st2.land_bought[0] -= 3;
    const o2 = c2._decide(c2._view(st2, cat, []), F.ctxOf({ retailBoard: board() }));
    assert.ok(o2.waits.some((x) => /store needs 3 free acres \(0 free\)/.test(x)), o2.waits.join(' | '));
  });

  await t('shelf pick: made or held goods only, best appetite x price first, at most 4', () => {
    const { cp: c2 } = F.load(['cp-retail']);
    const st = liveC();
    const ctx = F.ctxOf({ retailBoard: board() });
    c2._decide(c2._view(st, cat, []), ctx);
    // Chair 302 x $290 > Table 182 x $480 > Bookshelf 150 x $580; Bench (not made, no stock) left out
    assert.deepStrictEqual(ctx.retail.chosen.map((g) => g.name), ['Chair', 'Table', 'Bookshelf']);
    st.stock[0][I('Bench')] = 10;
    const ctx2 = F.ctxOf({ retailBoard: board() });
    c2._decide(c2._view(st, cat, []), ctx2);
    assert.strictEqual(ctx2.retail.chosen.length, 4);
    assert.ok(ctx2.retail.chosen.some((g) => g.name === 'Bench'));
  });

  await t('malformed board: loud wait, nothing sent', () => {
    const { cp: c2 } = F.load(['cp-retail']);
    const st = liveC();
    const cases = [null, {}, { shelves: {} }, (() => { const b = board(); delete b.shelves[0][I('Chair')].price; return b; })(), (() => { const b = board(); b.shelves[0][I('Table')].appetite = 'x'; return b; })()];
    for (const b of cases) {
      const out = c2._decide(c2._view(st, cat, []), F.ctxOf({ retailBoard: b }));
      assert.strictEqual(out.actions.filter((a) => a.director === 'retail').length, 0);
      assert.ok(out.waits.some((x) => /RETAIL BOARD SHAPE CHANGED/.test(x)), JSON.stringify(b)?.slice(0, 60) + ' -> ' + out.waits.join(' | '));
    }
  });

  await t('rival ratings: share from (1,000 + rating); unknown ratings shape waits', () => {
    const { cp: c2 } = F.load(['cp-retail']);
    const R = c2._retail;
    assert.strictEqual(R.shareOf({ ratings: {} }, 0, 1), 1);
    assert.ok(Math.abs(R.shareOf({ ratings: { 0: { 7: 10000 } } }, 0, 1) - 1000 / 12000) < 1e-9);
    assert.strictEqual(R.shareOf({ ratings: { 0: { 1: 500, 7: 500 } } }, 500, 1), 0.5);
    const b = board(); b.ratings = { 0: 'strange' };
    const out = c2._decide(c2._view(liveC(), cat, []), F.ctxOf({ retailBoard: b }));
    assert.ok(out.waits.some((x) => /unknown "ratings" shape/.test(x)), out.waits.join(' | '));
  });

  await t('live run vs fake server: buy + group, then SetAssortment, then nothing more', async () => {
    globalThis.localStorage = F.mem(); globalThis.sessionStorage = F.mem();
    const st = liveC();
    const { cp: c3, w } = F.boot(st, { modules: ['cp-retail'], catalog: cat, deals: F.stageB.deals, retail: board() });
    c3.start({ dryRun: false });
    await waitFor(() => w.ws.sent.some((m) => m.type === 'CreateGroup'));
    await waitFor(() => !c3.active);
    const g = Object.entries(st.groups).find(([, x]) => x.building === B('Retail Store'));
    assert.ok(g, 'store group made');
    assert.strictEqual(g[1].count, 1); assert.strictEqual(g[1].name, 'Retail');
    assert.strictEqual(st.building_pool[0][B('Retail Store')], 0);
    assert.deepStrictEqual(w.ws.sent.map((m) => m.type), ['BuyBuilding', 'CreateGroup']);
    await c3._step();
    assert.deepStrictEqual(w.ws.sent.map((m) => m.type), ['BuyBuilding', 'CreateGroup', 'SetAssortment']);
    const sa = w.ws.sent[2];
    assert.strictEqual(sa.group, +g[0]);
    assert.deepStrictEqual([...sa.items].sort(), shelfIds().sort());
    assert.deepStrictEqual([...st.groups[g[0]].assortment].sort(), shelfIds().sort());
    await c3._step(); await c3._step();
    assert.strictEqual(w.ws.sent.length, 3, 'no re-send: ' + w.ws.sent.map((m) => m.type).join(','));
    // the server reordering the shelf is not a difference
    st.groups[g[0]].assortment.reverse();
    await c3._step();
    assert.strictEqual(w.ws.sent.length, 3);
    // the sampler started (store built, shelves set)
    assert.ok(c3.status().readouts.retail.samples >= 1, JSON.stringify(c3.status().readouts.retail));
    c3.stop(); F.unload();
  });

  await t('chaos: unconfirmed SetAssortment is sent once per step and stops after 3 fails', async () => {
    globalThis.localStorage = F.mem(); globalThis.sessionStorage = F.mem();
    const st = liveC();
    st.groups[90] = { building: B('Retail Store'), region: 0, count: 1, recipe: null, name: 'Retail', modules: {}, assortment: [] };
    const { cp: c3, w } = F.boot(st, { modules: ['cp-retail'], catalog: cat, deals: F.stageB.deals, retail: board(), ignore: ['SetAssortment'] });
    c3.cfg.confirmMs = 80;
    c3.start({ dryRun: false });
    await waitFor(() => !c3.active);
    for (let k = 0; k < 4 && c3.running; k++) await c3._step();
    const n = w.ws.sent.filter((m) => m.type === 'SetAssortment').length;
    assert.strictEqual(n, 3, 'sent ' + n);
    assert.strictEqual(c3.running, false);
    assert.ok(!w.ws.sent.some((m) => m.type === 'BuyBuilding'), 'no store purchase when one exists');
    F.unload();
  });

  // ---- checkpoint over simulated time --------------------------------------------------------------------------------------------
  // Each 10 min: Workshops add their waves, the store sells min(stock, appetite / 240 x ticks), the rating moves +1 per selling tick
  // (-2 when nothing sells), then the board for that minute is read and corePlan decides.
  // shelfAt: minute the shelves are set (before it the store cannot sell); counts: furniture group sizes.
  function simulate(appetiteAt, { minutes = 120, stock = 50000, shelfAt = 0, counts = {} } = {}) {
    const { cp: c } = F.load(['cp-retail']);
    const st = liveC({ stock, counts });
    st.groups[90] = { building: B('Retail Store'), region: 0, count: 1, recipe: null, name: 'Retail', modules: {}, assortment: shelfAt > 0 ? [] : shelfIds() };
    st.retail_ratings = { 0: 0 };
    const mem = memFn(), t0 = 1.8e12, b0 = board();
    const rate = (n) => { const g = Object.values(st.groups).find((x) => x.recipe === Rc('Make ' + n)); return g.work[0].runs / cat.recipes.find((r) => r.id === Rc('Make ' + n)).ticks; };
    const log = [];
    let b = board();
    for (let m = 0; m <= minutes; m += 10) {
      if (m >= shelfAt && !st.groups[90].assortment.length) st.groups[90].assortment = shelfIds();
      if (m > shelfAt) {
        const ticks = 10 * 60 * 2;
        let selling = false;
        for (const n of ['Bookshelf', 'Table', 'Chair']) {
          const id = I(n), made = rate(n) * ticks, want = b.shelves[0][id].appetite / 240 * ticks;
          const sold = Math.min(st.stock[0][id] + made, want);
          if (sold > 0) selling = true;
          st.stock[0][id] += made - sold;
          b.shelves[0][id].held += Math.round(sold);
        }
        st.retail_ratings[0] = Math.max(0, Math.min(10000, st.retail_ratings[0] + (selling ? ticks : -2 * ticks)));
      }
      const nb = clone(b);
      for (const n of ['Bookshelf', 'Table', 'Chair']) nb.shelves[0][I(n)].appetite = Math.round(b0.shelves[0][I(n)].appetite * appetiteAt(m));
      b = nb;
      const ctx = F.ctxOf({ retailBoard: b, mem, now: t0 + m * MIN });
      const out = c._decide(c._view(st, cat, []), ctx);
      log.push({ m, ok: ctx.retailOk, cap: ctx.retailCap, e1: ctx.retailE1, ctx, out });
    }
    return { log, last: log[log.length - 1], c, mem, st };
  }

  await t('steady board: undecided before 2 h, PASS at 2 h, E1 after 6 h', () => {
    const { log, last } = simulate((m) => 1 + 0.04 * Math.sin(m / 17), { minutes: 380, stock: 200000 });
    assert.ok(log.filter((x) => x.m < 120).every((x) => x.ok === null), 'undecided early');
    const at2 = log.find((x) => x.m === 120);
    assert.strictEqual(at2.ok, true, JSON.stringify(at2.out.readouts.retail, null, 1));
    assert.strictEqual(at2.cap, null);
    // E1 needs 6 h of sampling: false at the 2 h checkpoint, true once 6 h have run
    assert.strictEqual(at2.e1, false);
    assert.ok(log.filter((x) => x.m < 360).every((x) => x.e1 === false), 'no E1 before 6 h');
    assert.strictEqual(last.e1, true, JSON.stringify(last.out.readouts.retail, null, 1));
    const ro = at2.out.readouts.retail;
    assert.ok(ro.rows.length === 4 && ro.rows.every((r) => / pass: /.test(r)), ro.rows.join('\n'));
    assert.ok(/^PASS/.test(ro.decision));
  });

  await t('E1: a slow slide after the pass (8%/h) never counts as steady', () => {
    const { log, last } = simulate((m) => (m <= 120 ? 1 : Math.pow(0.92, (m - 120) / 60)), { minutes: 480, stock: 200000 });
    assert.strictEqual(log.find((x) => x.m === 120).ok, true);
    assert.ok(log.every((x) => x.e1 === false), 'E1 set at ' + log.find((x) => x.e1)?.m);
    assert.strictEqual(last.e1, false);
  });

  await t('rating clock starts when the shelves are set, not when the group appears', () => {
    // shelves land 60 min after the group; the rating then climbs +1 per tick and reaches 9,000 75 min later
    const { log } = simulate((m) => 1 + 0.04 * Math.sin(m / 17), { minutes: 190, stock: 200000, shelfAt: 60 });
    assert.ok(log.filter((x) => x.m < 180).every((x) => x.ok === null), 'undecided before 2 h of shelves');
    const at = log.find((x) => x.m === 180);
    assert.strictEqual(at.ok, true, JSON.stringify(at.out.readouts.retail.rows));
    assert.strictEqual(at.ctx.retail.sampler.mem.shelvedAt, 1.8e12 + 60 * MIN);
  });

  await t('saturating board: FAIL saturating with a block cap at the measured sales', () => {
    const f = (m) => 0.35 + 0.65 * Math.exp(-m / 15);
    const { last } = simulate(f);
    assert.strictEqual(last.ok, false);
    const d = last.ctx.retail.sampler.mem.decision;
    assert.strictEqual(d.kind, 'saturating', JSON.stringify(d));
    // demand left at 35%: Chair 302 x .35 x 30 / 37.5 + Table 182 x .35 x 30 / 30 + Bookshelf 150 x .35 x 30 / 30 ~ 200 blocks
    const want = (302 * 30 / 37.5 + 182 + 150) * 0.35;
    assert.ok(Math.abs(last.cap - want) <= 3, 'cap ' + last.cap + ' vs ' + want.toFixed(1));
    assert.strictEqual(last.e1, false);
    assert.ok(/FAIL saturating: cap/.test(last.out.readouts.retail.decision));
    assert.ok(last.out.readouts.retail.rows.some((r) => /^appetite FAIL/.test(r)));
  });

  await t('decaying board: FAIL decaying, cap from the latest (lower) demand', () => {
    const { last } = simulate((m) => Math.max(0.05, 1 - m / 150));
    assert.strictEqual(last.ok, false);
    const d = last.ctx.retail.sampler.mem.decision;
    assert.strictEqual(d.kind, 'decaying', JSON.stringify(d));
    const sat = (302 * 30 / 37.5 + 182 + 150) * 0.35;
    assert.ok(last.cap < sat, 'decaying cap ' + last.cap + ' below the saturating one');
  });

  await t('fail path: Workshops above the cap move to Frame Timber, one action per step, then nothing more', () => {
    const f = (m) => 0.35 + 0.65 * Math.exp(-m / 15);
    const { last, c, mem, st } = simulate(f, { counts: { 3: 300, 8: 200, 11: 100 } });
    const d = last.ctx.retail.sampler.mem.decision;
    assert.strictEqual(d.ok, false); assert.strictEqual(d.measured, true);
    const w = F.world(st, F.stageB.deals, { catalog: cat, retail: board() });
    const sent = [];
    let now = 1.8e12 + 121 * MIN;
    for (let k = 0; k < 20; k++) {
      const ctx = F.ctxOf({ retailBoard: board(), mem, now });
      const out = c._decide(c._view(st, cat, []), ctx);
      const a = out.actions.find((x) => x.director === 'retail');
      if (!a) break;
      assert.strictEqual(a.steps.length, 1);
      sent.push(a.steps[0].msg); w.ws.send(JSON.stringify(a.steps[0].msg));
      assert.ok(a.steps[0].until(c._view(st, cat, [])), 'confirmed: ' + JSON.stringify(a.steps[0].msg));
      now += MIN;
    }
    assert.ok(sent.length >= 4 && sent.length < 20, sent.map((m) => m.type).join(','));
    assert.ok(!sent.some((m) => m.type === 'BuyBuilding' || m.building === B('Farm')), 'no purchase, no Farm touched');
    const ws = Object.values(st.groups).filter((g) => g.building === B('Workshop'));
    const on = (r) => ws.filter((g) => g.recipe === Rc(r)).reduce((a, g) => a + g.count, 0);
    for (const [n, r] of [['Bookshelf', 'Make Bookshelf'], ['Table', 'Make Table'], ['Chair', 'Make Chair']]) assert.ok(on(r) <= Math.ceil(d.capBy[n]), n + ' ' + on(r) + ' vs cap ' + d.capBy[n]);
    assert.strictEqual(on('Frame Timber'), 600 - on('Make Bookshelf') - on('Make Table') - on('Make Chair'));
    assert.strictEqual(st.building_pool[0][B('Workshop')] ?? 0, 0);
    assert.ok(Object.values(st.groups).some((g) => g.name === 'Frame Timber' && g.recipe === Rc('Frame Timber')));
    // an undecided fail (no measured sales) never moves Workshops
    mem('retail').set({ decision: { ok: false, kind: 'undecided', cap: 0, capBy: {}, measured: false } });
    st.groups[3].count += 50;
    const out = c._decide(c._view(st, cat, []), F.ctxOf({ retailBoard: board(), mem, now }));
    assert.strictEqual(out.actions.filter((x) => x.director === 'retail').length, 0);
  });

  await t('shelf churn: a paused or retuned furniture group does not reshuffle the shelf', () => {
    const { cp: c } = F.load(['cp-retail']);
    const st = liveC();
    st.groups[90] = { building: B('Retail Store'), region: 0, count: 1, recipe: null, name: 'Retail', modules: {}, assortment: shelfIds() };
    const mem = memFn();
    const run = (m) => { const ctx = F.ctxOf({ retailBoard: board(), mem, now: 1.8e12 + m * MIN }); const out = c._decide(c._view(st, cat, []), ctx); return out.actions.filter((a) => a.director === 'retail'); };
    st.groups[11].paused = true; st.stock[0][I('Chair')] = 0;
    assert.strictEqual(run(0).length, 0, 'paused Chair group keeps Chair on the shelf');
    st.groups[11].recipe = Rc('Frame Timber'); st.groups[11].work = [];
    assert.strictEqual(run(10).length, 0, 'just retuned: still on the shelf');
    assert.strictEqual(run(60).length, 0);
    const r = run(71);
    assert.strictEqual(r.length, 1);
    assert.deepStrictEqual([...r[0].steps[0].msg.items].sort(), [I('Bookshelf'), I('Table')].sort());
  });

  await t('output-bound store: sales follow output, the sales row passes', () => {
    // little stock: the store sells what the Workshops make; the model is capped by what was there to sell
    const { log } = simulate(() => 1, { stock: 30 });
    const at2 = log.find((x) => x.m === 120);
    const rows = at2.out.readouts.retail.rows;
    assert.ok(rows.some((r) => /^sales pass/.test(r)), rows.join('\n'));
  });

  await t('rating stuck (store keeps running dry): FAIL on the rating row', () => {
    const { cp: c } = F.load(['cp-retail']);
    const st = liveC({ stock: 50000 });
    st.groups[90] = { building: B('Retail Store'), region: 0, count: 1, recipe: null, name: 'Retail', modules: {}, assortment: shelfIds() };
    st.retail_ratings = { 0: 0 };
    const mem = memFn();
    let ctx;
    for (let m = 0; m <= 120; m += 10) { st.retail_ratings[0] = m * 30; ctx = F.ctxOf({ retailBoard: board(), mem, now: 1.8e12 + m * MIN }); c._decide(c._view(st, cat, []), ctx); }
    assert.strictEqual(ctx.retailOk, false);
    assert.ok(/rating/.test(ctx.retail.sampler.mem.decision.kind), ctx.retail.sampler.mem.decision.kind);
  });

  await t('store demolished: samples start over only after it stays gone', () => {
    const { c, mem } = simulate(() => 1, { minutes: 30 });
    const n = mem('retail').get().samples.length;
    assert.ok(n >= 3);
    const at = (st, m) => { const ctx = F.ctxOf({ retailBoard: board(), mem, now: 1.8e12 + m * MIN }); c._decide(c._view(st, cat, []), ctx); return ctx; };
    // one bad frame with no groups at all: nothing lost
    const bad = liveC(); bad.groups = {};
    at(bad, 35);
    assert.strictEqual(mem('retail').get().samples.length, n);
    assert.ok(mem('retail').get().shelvedAt);
    // store gone: kept for the first read, reset after cfg.retailGoneMin
    const st = liveC();
    const ctx = at(st, 40);
    assert.strictEqual(ctx.retailOk, null);
    assert.strictEqual(mem('retail').get().samples.length, n);
    at(st, 51);
    assert.strictEqual(mem('retail').get().samples.length, 0);
    assert.strictEqual(mem('retail').get().shelvedAt, null);
  });

  done();
})();
