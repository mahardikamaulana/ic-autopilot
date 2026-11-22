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

  await t('store gate: Iron Frames still needed by the other unlocks are kept back (capped by cfg.ifReserve); bill floor on top of the price', () => {
    const st = liveC(); st.stock[0][I('Iron Frame')] = 6;
    const a = dec(st);
    assert.strictEqual(a.r.length, 0);
    assert.ok(a.w.some((x) => /store needs 6 Iron Frame \(\+22 kept for prototypes\)/.test(x)), a.w.join(' | '));
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

  await t('store gate: the build counts its own Iron Frames once, plus only what Oil Rig still needs', () => {
    const acres = (n) => cat.buildings.find((b) => b.id === B(n)).acres;
    const st = liveC(); st.building_pool[0][B('Assembly Plant')] = 1; st.land_bought[0] += acres('Assembly Plant');   // plant built: its 10 frames are paid
    const ifs = (n) => { st.stock[0][I('Iron Frame')] = n; return dec(st); };
    assert.strictEqual(ifs(17).r.length, 0, '6 own + 12 for the Oil Rig prototype and first build = 18, not 6 + 44');
    assert.ok(ifs(17).w.some((x) => /store needs 6 Iron Frame \(\+12 kept for prototypes\)/.test(x)));
    assert.strictEqual(ifs(18).r.length, 1);
    // Oil Rig researched and built: nothing left to keep, the store needs its 6.
    st.unlocked_buildings.push(B('Oil Rig')); st.building_pool[0][B('Oil Rig')] = 1; st.land_bought[0] += acres('Oil Rig');
    assert.strictEqual(ifs(5).r.length, 0);
    assert.strictEqual(ifs(6).r.length, 1);
    // The reserve other modules see is the same need, capped by cfg.ifReserve.
    assert.strictEqual(cp._ifNeed(cp._view(liveC(), cat, F.stageB.deals), 'Retail Store'), 22);
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
  // shelfAt: minute the shelves are set (before it the store cannot sell); counts: furniture group sizes; cd: CD in hand (Oil Rig).
  function simulate(appetiteAt, { minutes = 120, stock = 50000, shelfAt = 0, counts = {}, cd = null } = {}) {
    const { cp: c } = F.load(['cp-retail']);
    const st = liveC({ stock, counts });
    if (cd != null) st.items[F.CD] = cd;
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

  await t('steady board: undecided before 2 h, PASS at 2 h, E1 after 6 h with the rating at 9,000 at every sample', () => {
    const { log, last } = simulate((m) => 1 + 0.04 * Math.sin(m / 17), { minutes: 500, stock: 200000 });
    assert.ok(log.filter((x) => x.m < 120).every((x) => x.ok === null), 'undecided early');
    const at2 = log.find((x) => x.m === 120);
    assert.strictEqual(at2.ok, true, JSON.stringify(at2.out.readouts.retail, null, 1));
    assert.strictEqual(at2.cap, null);
    // E1 needs 6 h with every sample at 9,000 (C2): the rating ramp (9,000 at 75 min) restarts the run at the first look after the pass
    assert.strictEqual(at2.e1, false);
    assert.ok(log.filter((x) => x.m < 130 + 360).every((x) => x.e1 === false), 'no E1 before 6 h at 9,000: ' + log.find((x) => x.e1)?.m);
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
      for (const s of a.steps) { sent.push(s.msg); w.ws.send(JSON.stringify(s.msg)); assert.ok(s.until(c._view(st, cat, [])), 'confirmed: ' + JSON.stringify(s.msg)); }
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

  // ---- fail path, re-checkpoint, per-good sales, rating at every sample (plan A2, B3, C1, C2) ------------------------------------
  const FAIL3 = { ok: false, kind: 'saturating', cap: 3, capBy: { Bookshelf: 1, Table: 1, Chair: 1 }, measured: true, at: 1.8e12, why: 'test' };
  // Stage D store with a Rivet group (liveC puts the live one on Chair) and the given checkpoint decision in mem.
  function failSt() {
    const st = liveC();
    st.groups[90] = { building: B('Retail Store'), region: 0, count: 1, recipe: null, name: 'Retail', modules: {}, assortment: shelfIds() };
    st.groups[91] = { building: B('Workshop'), region: 0, count: 2, recipe: Rc('Rivet Iron Frame'), modules: {} };
    st.retail_ratings = { 0: 10000 };
    return st;
  }
  const memWith = (decision, now = 1.8e12) => { const m = memFn(); m('retail').set({ shelvedAt: now - 3 * 3600000, samples: [], decision }); return m; };

  await t('fail path (A2): Farm waves wait, the land rule caps Camps and the last acre, the reserve keeps Wooden Frames to the keep line and frees Planks', async () => {
    const { cp: c } = F.load(['cp-buildout', 'cp-retail']);
    const st = failSt(), v = c._view(st, cat, []);
    const ctxF = F.ctxOf({ retailBoard: board(), mem: memWith(FAIL3) }), dF = c._decide(v, ctxF);
    const ctxP = F.ctxOf({ retailBoard: board(), mem: memWith({ ok: true, kind: 'pass', at: 1.8e12 }) }), dP = c._decide(v, ctxP);
    assert.strictEqual(ctxF.retailOk, false); assert.strictEqual(ctxF.retailFail, true); assert.strictEqual(ctxF.retailFailPath, true);
    assert.strictEqual(ctxP.retailFail, false); assert.strictEqual(ctxP.retailFailPath, false);
    assert.ok(dF.rule.camps < dP.rule.camps, 'camps ' + dF.rule.camps + ' vs ' + dP.rule.camps);
    assert.ok(dF.rule.sawmills < dP.rule.sawmills, 'sawmills ' + dF.rule.sawmills + ' vs ' + dP.rule.sawmills);
    assert.ok(dF.rule.lastAcre < dP.rule.lastAcre, 'last acre ' + dF.rule.lastAcre + ' vs ' + dP.rule.lastAcre);
    assert.match(c._buildout.waveStep(v, ctxF, dF.rule, 'D').wait, /retail checkpoint failed: remaining Farms stay on Cotton/);
    assert.ok(!/retail checkpoint failed/.test(c._buildout.waveStep(v, ctxP, dP.rule, 'D').wait ?? ''));
    // C-fix: a pass of the re-run after the measured fail opens only the Oil Rig gate; the cap, the capped land rule and the Farms stay
    const memRP = memWith({ ok: true, kind: 'pass', at: 1.8e12 }); memRP('retail').set({ prevDecision: FAIL3 });
    const ctxRP = F.ctxOf({ retailBoard: board(), mem: memRP }), dRP = c._decide(v, ctxRP);
    assert.strictEqual(ctxRP.retailOk, true); assert.strictEqual(ctxRP.retailCap, 3);
    assert.strictEqual(ctxRP.retailFail, true); assert.strictEqual(ctxRP.retailFailPath, true);
    assert.deepStrictEqual([dRP.rule.camps, dRP.rule.sawmills, dRP.rule.lastAcre], [dF.rule.camps, dF.rule.sawmills, dF.rule.lastAcre]);
    assert.strictEqual(c._buildout.waveStep(v, ctxRP, dRP.rule, 'D').wait, 'retail fail path: Farms stay on Cotton');
    assert.match(dRP.readouts.retail.decision, /^PASS at the capped output: Oil Rig opens; the cap of 3 furniture blocks stays/);
    // the reserve CD Farm reads (runner): fail -> Wooden Frames = keep line (2 Rivet x 24 WF/h x 2 h = 96, capped at cfg.ftKeepMax 19), no Planks; pass -> both held
    const keep = c._buildout.wfKeep(v, ctxF);
    assert.strictEqual(keep, 19);
    for (const [decision, want] of [[FAIL3, { [I('Wooden Frame')]: 19 }], [{ ok: true, kind: 'pass', at: 1 }, { [I('Wooden Frame')]: Infinity, [I('Planks')]: Infinity }]]) {
      globalThis.localStorage = F.mem({ 'corePlan.v1.mem.retail': JSON.stringify({ shelvedAt: Date.now() - 3 * 3600000, samples: [], decision }) });
      const { cp: r, core } = F.boot(failSt(), { modules: ['cp-buildout', 'cp-retail'], catalog: cat, deals: [], retail: board() });
      r.start();
      await waitFor(() => !r.active); await r._step();
      assert.strictEqual(r.status().stage, 'D');
      assert.deepStrictEqual(core.reserves.merged().by.corePlan.items, want, JSON.stringify(decision));
      r.stop(); F.unload();
    }
  });

  await t('fail path vs buildout: the cut goes to Frame Timber, the pool tidy keeps to the per-good keep, it converges and the re-run starts', () => {
    const { cp: c } = F.load(['cp-buildout', 'cp-retail']);
    const st = failSt();
    st.groups[3].count = 3;   // Bookshelf 3 over its keep of 1, Table 1, Chair 1
    st.building_pool[0][B('Workshop')] = 1;   // a pooled Workshop: before the fix tidy put it back on Bookshelf and the cut took it off again
    for (const n of ['Make Bookshelf', 'Make Table', 'Make Chair']) st.layouts[Rc(n)] = { fx: { rate: 5 }, bom: [] };
    for (const g of Object.values(st.groups)) if (g.building === B('Sawmill')) g.count *= 10;   // planks headroom for any furniture
    const w = F.world(st, [], { catalog: cat, retail: board() }), mem = memWith(FAIL3);
    const total = Object.values(st.groups).filter((g) => g.building === B('Workshop')).reduce((a, g) => a + g.count, 0) + 1;
    const ids = [];
    let cut = null;
    for (let k = 0; k < 12; k++) {
      const out = c._decide(c._view(st, cat, []), F.ctxOf({ retailBoard: board(), mem, now: 1.8e12 + k * MIN }));
      const a = out.actions.find((x) => x.director === 'buildout' || x.director === 'retail');
      if (!a) break;
      ids.push(a.id);
      if (a.id.startsWith('retail:ft:cut:')) cut = a;
      for (const s of a.steps) { w.ws.send(JSON.stringify(s.msg)); assert.ok(s.until(c._view(st, cat, [])), a.id + ' confirmed'); }
    }
    assert.ok(ids.length < 12, 'converges: ' + ids.join(', '));
    // the tidy made the Frame Timber group from the pooled Workshop, so the cut joins it in the same action
    assert.deepStrictEqual(cut.steps.map((s) => s.msg.type), ['UnassignBuildings', 'AssignBuildings'], 'the cut is placed in the same action');
    assert.strictEqual(st.groups[cut.steps[1].msg.group].recipe, Rc('Frame Timber'));
    assert.strictEqual(new Set(ids.map((x) => x.split(':').slice(0, 4).join(':'))).size, ids.length, 'no step undone and redone: ' + ids.join(', '));
    const on = (r) => Object.values(st.groups).filter((g) => g.recipe === Rc(r)).reduce((a, g) => a + g.count, 0);
    assert.deepStrictEqual([on('Make Bookshelf'), on('Make Table'), on('Make Chair')], [1, 1, 1]);
    assert.strictEqual(st.building_pool[0][B('Workshop')] ?? 0, 0);
    assert.strictEqual(on('Frame Timber') + on('Rivet Iron Frame') + 3, total, 'every other Workshop on Frame Timber');
    // nothing left for the fail path: the B3 re-run starts at the capped output, the old fail kept as prevDecision
    const r = mem('retail').get();
    assert.strictEqual(r.decision, null); assert.strictEqual(r.prevDecision.kind, 'saturating');
  });

  // Steps buildout + retail on the fake server until neither acts: the ids sent (12 = never settled).
  function converge(c, st, mem, b = board()) {
    const w = F.world(st, [], { catalog: cat, retail: b }), ids = [], acts = [];
    for (let k = 0; k < 12; k++) {
      const out = c._decide(c._view(st, cat, []), F.ctxOf({ retailBoard: b, mem, now: 1.8e12 + k * MIN }));
      const a = out.actions.find((x) => x.director === 'buildout' || x.director === 'retail');
      if (!a) break;
      ids.push(a.id); acts.push(a);
      for (const s of a.steps) { w.ws.send(JSON.stringify(s.msg)); assert.ok(s.until(c._view(st, cat, [])), a.id + ' confirmed'); }
    }
    return { ids, acts };
  }
  const furnOn = (st, r) => Object.values(st.groups).filter((g) => g.recipe === Rc(r)).reduce((a, g) => a + g.count, 0);

  await t('fail path vs buildout: no Frame Timber group: the cut makes one, it gets its recipe next, converges, the re-run starts', () => {
    const { cp: c } = F.load(['cp-buildout', 'cp-retail']);
    const st = failSt();
    for (const g of Object.values(st.groups)) if (g.recipe === Rc('Frame Timber')) g.recipe = Rc('Make Bookshelf');   // every Frame Timber Workshop on Bookshelf
    const mem = memWith(FAIL3), { ids, acts } = converge(c, st, mem);
    assert.ok(ids.length < 12, 'converges: ' + ids.join(', '));
    const cut = acts.find((a) => a.id.startsWith('retail:ft:cut:'));
    assert.deepStrictEqual(cut.steps.map((s) => s.msg.type), ['UnassignBuildings', 'CreateGroup'], ids.join(', '));
    const ft = Object.values(st.groups).find((g) => g.name === 'Frame Timber');
    assert.strictEqual(ft.recipe, Rc('Frame Timber'));
    assert.deepStrictEqual(['Make Bookshelf', 'Make Table', 'Make Chair'].map((r) => furnOn(st, r)), [1, 1, 1]);
    assert.strictEqual(st.building_pool[0][B('Workshop')] ?? 0, 0);
    const r = mem('retail').get();
    assert.strictEqual(r.decision, null); assert.strictEqual(r.prevDecision.kind, 'saturating');
  });

  await t('fail path vs buildout: furniture under the cap with spare Frame Timber: the switch keeps to the per-good keep, converges', () => {
    const { cp: c } = F.load(['cp-buildout', 'cp-retail']);
    const st = failSt();
    st.groups[3].count = 1; st.groups[8].count = 1;
    st.groups[11].recipe = Rc('Frame Timber'); st.groups[11].count = 6;   // Chair at 0 (keep 1), spare Frame Timber to switch
    for (const n of ['Make Bookshelf', 'Make Table', 'Make Chair']) st.layouts[Rc(n)] = { fx: { rate: 5 }, bom: [] };
    for (const g of Object.values(st.groups)) if (g.building === B('Sawmill')) g.count *= 10;
    const b = board(), rows = b.shelves[0] ?? b.shelves['0'];
    rows[I('Bookshelf')].appetite *= 20;   // the board's mix wants Bookshelf above its keep of 1
    const { ids } = converge(c, st, memWith(FAIL3), b);
    assert.ok(ids.length < 12, 'converges: ' + ids.join(', '));
    assert.ok(!ids.some((x) => x.startsWith('retail:ft:cut:')), 'nothing to cut: ' + ids.join(', '));
    assert.ok(furnOn(st, 'Make Bookshelf') <= 1 && furnOn(st, 'Make Table') <= 1 && furnOn(st, 'Make Chair') <= 1, ids.join(', '));
  });

  await t('undecided fail (no measured sales): no cap, no fail path, no land-rule cap, but the Farm waves still wait', () => {
    const { cp: c } = F.load(['cp-buildout', 'cp-retail']);
    const st = failSt(), v = c._view(st, cat, []);
    const ctxU = F.ctxOf({ retailBoard: board(), mem: memWith({ ok: false, kind: 'undecided', cap: 0, capBy: {}, measured: false, at: 1.8e12, why: 'test' }) }), dU = c._decide(v, ctxU);
    const ctxP = F.ctxOf({ retailBoard: board(), mem: memWith({ ok: true, kind: 'pass', at: 1.8e12 }) }), dP = c._decide(v, ctxP);
    assert.strictEqual(ctxU.retailOk, false);
    assert.strictEqual(ctxU.retailCap, null); assert.strictEqual(ctxU.retailFail, false); assert.strictEqual(ctxU.retailFailPath, false);
    assert.strictEqual(dU.rule.camps, dP.rule.camps, 'no planks cap');
    assert.match(c._buildout.waveStep(v, ctxU, dU.rule, 'D').wait, /retail checkpoint failed: remaining Farms stay on Cotton/);
  });

  await t('board check: held is optional (appetite and price only)', () => {
    const b = board(), rows = b.shelves[0] ?? b.shelves['0'];
    for (const r of Object.values(rows)) delete r.held;
    assert.strictEqual(cp._retail.checkBoard(b, { Chair: I('Chair') }), null);
    delete rows[I('Chair')].price;
    assert.match(cp._retail.checkBoard(b, { Chair: I('Chair') }), /Chair row lacks price/);
    // samples then carry no held: the appetite row's note shows 0, not NaN
    const s = (t) => ({ t, r: 10000, share: 1, g: { [I('Chair')]: { n: 'Chair', a: 2400, p: 16000, s: 1000, out: 0 } } });
    const ap = cp._retail.rowsOf([s(1.8e12), s(1.8e12 + 600000)], { shelvedAt: 1.8e12 }, cp.cfg, 1.8e12 + 600000, false, null).rows.find((r) => r.id === 'appetite');
    assert.match(ap.why, /held 0 -> 0/);
  });

  await t('re-checkpoint (B3): a fail at the cap starts a new run; its pass sets retailOk and lets the Oil Rig start; a fail above the cap never does', () => {
    const f = (m) => 0.35 + 0.65 * Math.exp(-m / 15);
    const oil = (x) => x.out.actions.some((a) => a.id === 'tech:' + B('Oil Rig'));
    const { log } = simulate(f, { minutes: 260, cd: 20000 });
    const at = (m) => log.find((x) => x.m === m);
    assert.strictEqual(at(120).ok, false);
    assert.ok(!oil(at(120)) && at(120).out.waits.some((w) => /unlock Oil Rig: waits for the retail checkpoint \(failed/.test(w)));
    // furniture already under the cap: the next look starts the new run, the old fail stays in force meanwhile
    const r = at(130).ctx.retail.sampler.mem;
    assert.strictEqual(r.decision, null); assert.strictEqual(r.prevDecision.kind, 'saturating'); assert.strictEqual(r.shelvedAt, 1.8e12 + 130 * MIN);
    assert.ok(log.filter((x) => x.m >= 130 && x.m < 250).every((x) => x.ok === false && x.ctx.retailFail && !oil(x)), 'fail holds during the new run');
    assert.match(at(130).out.readouts.retail.decision, /re-checkpoint at the capped output/);
    assert.strictEqual(at(250).ok, true, JSON.stringify(at(250).out.readouts.retail.rows));
    assert.ok(oil(at(250)), at(250).out.waits.join(' | '));
    assert.match(at(250).out.readouts.retail.prevDecision, /^FAIL saturating/);
    assert.strictEqual(at(250).ctx.retailFailPath, true, 'pass after a measured fail: CD from Wooden Frames');
    assert.strictEqual(at(250).ctx.retailCap, at(250).ctx.retail.sampler.mem.prevDecision.cap, 'C-fix: the cap stays after the pass');
    assert.strictEqual(at(250).ctx.retailFail, true);
    // 600 furniture Workshops and nothing cutting them (no server): the cap is never reached, no new run, no Oil Rig
    const big = simulate(f, { minutes: 260, cd: 20000, counts: { 3: 300, 8: 200, 11: 100 } });
    assert.ok(big.log.filter((x) => x.m >= 120).every((x) => x.ok === false && !oil(x)));
    assert.strictEqual(big.last.ctx.retail.sampler.mem.prevDecision, undefined);
    // the new run fails too (demand still sliding): once its cap holds, another run starts with that fail as prevDecision
    const slide = simulate((m) => Math.max(0.05, 1 - m / 150), { minutes: 260 });
    const sat = (m) => slide.log.find((x) => x.m === m);
    assert.strictEqual(sat(130).ctx.retail.sampler.mem.prevDecision.at, 1.8e12 + 120 * MIN);
    assert.strictEqual(sat(250).ok, false); assert.strictEqual(sat(250).ctx.retail.sampler.mem.decision.at, 1.8e12 + 250 * MIN);
    const m3 = sat(260).ctx.retail.sampler.mem;
    assert.strictEqual(m3.decision, null); assert.strictEqual(m3.prevDecision.at, 1.8e12 + 250 * MIN); assert.strictEqual(m3.shelvedAt, 1.8e12 + 260 * MIN);
  });

  await t('sales row (C1): judged per good; one good far under the model fails even when the total passes', () => {
    const { cp: c } = F.load(['cp-retail']);
    const t0 = 1.8e12, g = (bs, ts) => ({ 1: { n: 'Bookshelf', a: 240, h: 0, p: 16000, s: bs, out: 0 }, 2: { n: 'Table', a: 24, h: 0, p: 16000, s: ts, out: 0 } });
    const run = (tableLeft) => c._retail.rowsOf([{ t: t0, r: 10000, share: 1, g: g(1e6, 1e4) }, { t: t0 + 3600000, r: 10000, share: 1, g: g(1e6 - 7200, tableLeft) }], { shelvedAt: t0 }, c.cfg, t0 + 3600000).rows.find((r) => r.id === 'sales');
    // Bookshelf sells its whole model (7,200), Table none of its 720: the total is 91%, Table is 0%
    const bad = run(1e4);
    assert.strictEqual(bad.ok, false, bad.why);
    assert.match(bad.why, /^worst Table sold 0 of model 720 \(0%\), all goods 7200 of 7920/);
    assert.strictEqual(run(1e4 - 720).ok, true);
  });

  await t('E1 rating (C2): 9,000 at every sample of the run, not only the last one', () => {
    const { cp: c } = F.load(['cp-retail']);
    const t0 = 1.8e12, g = { 1: { n: 'Bookshelf', a: 240, h: 0, p: 16000, s: 1e6, out: 0 } };
    const rows = (rs) => c._retail.rowsOf(rs.map((r, k) => ({ t: t0 + k * 600000, r, share: 1, g })), { shelvedAt: t0 }, c.cfg, t0 + rs.length * 600000, true).rows.find((x) => x.id === 'rating');
    assert.strictEqual(rows([9500, 8000, 9500]).ok, false, 'a dip in the run fails it');
    assert.strictEqual(rows([9000, 9500, 10000]).ok, true);
  });

  done();
})();
