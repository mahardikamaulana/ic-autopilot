// Tests for src/cp-cadence-*.js: slot, sell, cadence, world events, offline, canSaveDesign, resume, utilities.
//   CP_FROM_SRC=1 bun test/cp-cadence-test.js
const assert = require('assert');
const F = require('./cp-fixtures');
const { t, done, clone, waitFor } = F;
const CAT = F.stageB.catalog;
const B = (n) => F.B(n, CAT), I = (n) => F.I(n, CAT), Rc = (n) => F.Rc(n, CAT);
const T0 = 20150000;                       // server tick used by the pure tests
const MIN = 120;                           // ticks per minute

const bid = (id, item, amount, unitCents, minsLeft) => ({ id, side: 'Sell', item, amount, price: Math.round(unitCents * amount), region: 0, expires_at: T0 + minsLeft * MIN });
function cottonBids() {
  return [
    bid(11, I('Cotton'), 100000, 300, 300),    // best price, lot too small
    bid(12, I('Cotton'), 200000, 250, 30),     // good price, too little time
    bid(13, I('Cotton'), 200000, 200, 120),    // the right one
    bid(14, I('Cotton'), 300000, 150, 180),
  ];
}
const view = (cp, st, deals = []) => cp._view(st, CAT, deals);
const plain = () => { const st = F.liveB(); st.standing_fills = {}; return st; };

(async () => {
  const { cp } = F.load(['cp-lab', 'cp-cadence']);
  const X = cp._cadence;

  await t('directors load', () => {
    for (const n of ['resume', 'utilities', 'slot', 'sell', 'cadence']) assert.ok(cp.directors().includes(n), n);
    assert.ok(!cp.directors().includes('endgame'), 'the endgame director is in cp-endgame.js');
    assert.strictEqual(typeof cp.offline, 'function');
    assert.strictEqual(typeof cp.worldEvents, 'function');
  });

  // ---- slot -------------------------------------------------------------------------------------------------------------
  await t('slot picks the best Cotton bid with lot >= 150k and >= 60 min left', () => {
    const st = plain(), deals = cottonBids();
    const r = X.slotDecide(view(cp, st, deals), F.ctxOf({ tick: T0, deals }), {});
    assert.ok(r.action, JSON.stringify(r));
    assert.deepStrictEqual(r.action.steps.map((s) => s.msg), [{ type: 'KeepFilling', deal: 13, region: 0, amount: null }]);
  });
  await t('slot never sends while Autopilot owns the slot', () => {
    const st = plain(), deals = cottonBids();
    const ap = (o) => X.slotDecide(view(cp, st, deals), F.ctxOf({ tick: T0, deals, mods: { earlyGame: o } }), {});
    const r = ap({ running: true, cfg: { autoShipCotton: true } });
    assert.ok(!r.action); assert.match(r.readout, /Autopilot keeps the Cotton slot/);
    assert.ok(ap({ running: false, cfg: { autoShipCotton: true } }).action, 'Autopilot stopped: Core plan takes it');
    assert.ok(ap({ running: true, cfg: { autoShipCotton: false } }).action, 'autoShipCotton off: Core plan takes it');
  });
  await t('slot never re-sends while a fill is active; re-arms when it is about to expire', () => {
    const st = plain(), deals = cottonBids();
    st.standing_fills = { 13: { region: 0, remaining: null, filled: 5, since: T0 - 1000, expires_at: T0 + 120 * MIN } };
    assert.ok(!X.slotDecide(view(cp, st, deals), F.ctxOf({ tick: T0, deals }), {}).action);
    // A user's fill on another item is never replaced either.
    st.standing_fills = { 99: { region: 0, expires_at: T0 + 90 * MIN } };
    const d2 = [...deals, bid(99, I('Gold Ore'), 400000, 900, 90)];
    assert.ok(!X.slotDecide(view(cp, st, d2), F.ctxOf({ tick: T0, deals: d2 }), {}).action);
    // Our fill with 10 minutes left: stop it, then fill the next best bid.
    st.standing_fills = { 13: { region: 0, expires_at: T0 + 10 * MIN } };
    const ds = deals.map((d) => (d.id === 13 ? { ...d, expires_at: T0 + 10 * MIN } : d));
    const ours = F.ctxOf().mem; ours('slot').set({ armed: { 13: { item: I('Cotton'), mode: 'cotton' } } });
    const r = X.slotDecide(view(cp, st, ds), F.ctxOf({ tick: T0, deals: ds, mem: ours }), {});
    assert.deepStrictEqual(r.action.steps.map((s) => s.msg), [{ type: 'StopFilling', deal: 13 }, { type: 'KeepFilling', deal: 14, region: 0, amount: null }]);
    // Same bid renewed (the server keeps the deal id and moves expires_at): KeepFilling again, no StopFilling (live 2026-11-22).
    st.standing_fills = { 13: { region: 0, expires_at: T0 + 10 * MIN } };
    const r2 = X.slotDecide(view(cp, st, deals), F.ctxOf({ tick: T0, deals, mem: ours }), {});
    assert.deepStrictEqual(r2.action.steps.map((s) => s.msg), [{ type: 'KeepFilling', deal: 13, region: 0, amount: null }]);
    // An expired entry still listed does not count as active.
    st.standing_fills = { 13: { region: 0, expires_at: T0 - 5 } };
    assert.ok(X.slotDecide(view(cp, st, deals), F.ctxOf({ tick: T0, deals }), {}).action);
  });
  await t('slot leaves fills it did not arm alone: other regions, off-board bids, a user fill near its end', () => {
    const st = plain(), deals = cottonBids();
    // A 5-hour fill in another region: the corp has one slot, so it holds it; never stopped, not even once expired.
    st.standing_fills = { 99: { region: 1, expires_at: T0 + 300 * MIN } };
    let r = X.slotDecide(view(cp, st, deals), F.ctxOf({ tick: T0, deals }), {});
    assert.ok(!r.action); assert.match(r.readout, /slot held by user fill #99/);
    st.standing_fills = { 99: { region: 1, expires_at: T0 - 5 } };
    r = X.slotDecide(view(cp, st, deals), F.ctxOf({ tick: T0, deals }), {});
    assert.deepStrictEqual(r.action.steps.map((s) => s.msg), [{ type: 'KeepFilling', deal: 13, region: 0, amount: null }]);
    // A Heartland fill whose bid is not on the loaded board: the user's, it holds the slot.
    st.standing_fills = { 777: { region: 0, expires_at: T0 + 200 * MIN } };
    r = X.slotDecide(view(cp, st, deals), F.ctxOf({ tick: T0, deals }), {});
    assert.ok(!r.action, JSON.stringify(r.action?.steps?.map((s) => s.msg)));
    assert.match(r.readout, /slot held by user fill #777/);
    // A user fill with 10 min left is still the user's until it expires.
    st.standing_fills = { 13: { region: 0, expires_at: T0 + 10 * MIN } };
    assert.ok(!X.slotDecide(view(cp, st, deals), F.ctxOf({ tick: T0, deals }), {}).action);
  });
  await t('slot surplus: capped at the spare, recorded on confirm, stopped at the keep line or once the item is eaten', () => {
    const st = plain();
    delete st.groups[1];
    st.stock[0][I('Gold Ore')] = 50000;
    const deals = [bid(24, I('Gold Ore'), 400000, 900, 300)];
    const mm = F.ctxOf().mem, cx = () => F.ctxOf({ tick: T0, deals, retailOk: true, mem: mm });
    const out = cp._decide(view(cp, st, deals), F.ctxOf({ tick: T0, deals }));
    const keep = X.keepLine(view(cp, st, deals), out.rule, I('Gold Ore'));
    let r = X.slotDecide(view(cp, st, deals), cx(), out);
    const step = r.action.steps[0];
    assert.deepStrictEqual(step.msg, { type: 'KeepFilling', deal: 24, region: 0, amount: 50000 - keep }, 'never the whole stock');
    assert.ok(!mm('slot').get().armed, 'nothing claimed before the server confirms');
    st.standing_fills = { 24: { region: 0, remaining: 50000 - keep, expires_at: T0 + 300 * MIN } };
    assert.ok(step.until(view(cp, st, deals)));
    assert.deepStrictEqual(mm('slot').get().armed, { 24: { item: I('Gold Ore'), mode: 'surplus' } });
    r = X.slotDecide(view(cp, st, deals), cx(), out);
    assert.ok(!r.action); assert.match(r.readout, /Gold Ore bid #24/);
    // Stock down to the keep line: StopFilling (the native slot would ship the rest).
    st.stock[0][I('Gold Ore')] = keep;
    r = X.slotDecide(view(cp, st, deals), cx(), out);
    assert.deepStrictEqual(r.action.steps.map((s) => s.msg), [{ type: 'StopFilling', deal: 24 }]);
    assert.match(r.action.text, /keep line/);
    // Plenty again, but a Smelter now smelts Gold Ore: an engine input, stop.
    st.stock[0][I('Gold Ore')] = 50000;
    st.groups[7].recipe = Rc('Smelt Gold'); delete st.groups[7].work;
    r = X.slotDecide(view(cp, st, deals), cx(), out);
    assert.deepStrictEqual(r.action.steps.map((s) => s.msg), [{ type: 'StopFilling', deal: 24 }]);
    assert.match(r.action.text, /engine input/);
    delete st.standing_fills[24];
    assert.ok(r.action.steps[0].until(view(cp, st, deals)));
    assert.deepStrictEqual(mm('slot').get().armed, {});
    // Endgame stock is in the keep line (wiki 12: 2,000 Copper Ore).
    assert.ok(X.keepLine(view(cp, st, deals), out.rule, I('Copper Ore')) >= 2000);
  });
  await t('slot after the Farms are gone: surplus only with retail selling, never an engine input', () => {
    const st = plain();
    delete st.groups[1];                                     // the Cotton Farms
    st.stock[0][I('Gold Ore')] = 50000; st.stock[0][I('Wood')] = 900000; st.stock[0][I('Iron Sheet')] = 90000;
    const deals = [bid(21, I('Wood'), 400000, 999, 300), bid(22, I('Iron Sheet'), 400000, 99999, 300), bid(23, I('Planks'), 400000, 9999, 300), bid(24, I('Gold Ore'), 400000, 900, 300), bid(25, I('Cotton'), 400000, 300, 300)];
    const v = view(cp, st, deals);
    const out = cp._decide(v, F.ctxOf({ tick: T0, deals }));
    let r = X.slotDecide(v, F.ctxOf({ tick: T0, deals, retailOk: null }), out);
    assert.ok(!r.action, 'empty until retail sells');
    r = X.slotDecide(v, F.ctxOf({ tick: T0, deals, retailOk: true }), out);
    assert.deepStrictEqual(r.action.steps.map((s) => s.msg.deal), [24]);
    assert.strictEqual(r.action.steps[0].msg.amount, 50000 - X.keepLine(v, out.rule, I('Gold Ore')), 'capped at the spare');
    st.stock[0][I('Gold Ore')] = 0;
    r = X.slotDecide(view(cp, st, deals), F.ctxOf({ tick: T0, deals, retailOk: true }), out);
    assert.ok(!r.action, 'nothing above the keep line: slot left empty');
  });
  await t('slot runner: one KeepFilling, confirmed, recorded as ours, not sent again', async () => {
    const st = plain();
    const disk = F.mem(); globalThis.localStorage = disk;     // ctx.mem persists through localStorage, as in the browser
    const deals = [{ id: 31, side: 'Sell', item: I('Cotton'), amount: 400000, price: 60000000, region: 0, expires_at: st.ssi.last_user_mutation_tick + 50000 }];
    const { cp: c2, w } = F.boot(st, { deals, catalog: CAT, modules: ['cp-lab', 'cp-cadence'] });
    assert.deepStrictEqual(c2.importCfg({ land: false, unlocks: false, handoff: false, dir_sell: false, dir_cadence: false }).skipped, []);
    c2.start({ dryRun: false });
    await waitFor(() => w.ws.sent.some((m) => m.type === 'KeepFilling'));
    await waitFor(() => !c2.active);
    await c2._step(); await c2._step();
    assert.deepStrictEqual(w.ws.sent.filter((m) => m.type === 'KeepFilling'), [{ type: 'KeepFilling', deal: 31, region: 0, amount: null }]);
    assert.ok(st.standing_fills[31]);
    assert.ok(JSON.parse(disk._disk['corePlan.v1.mem.slot']).armed[31], 'the confirmed fill is saved as ours');
    assert.match(c2.status().readouts.slot, /^slot: Cotton bid #31/, 'read out as our live fill, not a user fill');
    c2.stop(); F.unload();
  });
  await t('slot chaos: an unconfirmed KeepFilling is retried at most once per step and stops after 3', async () => {
    const st = plain();
    const deals = [{ id: 32, side: 'Sell', item: I('Cotton'), amount: 400000, price: 60000000, region: 0, expires_at: st.ssi.last_user_mutation_tick + 50000 }];
    const { cp: c2, w } = F.boot(st, { deals, catalog: CAT, modules: ['cp-lab', 'cp-cadence'], ignore: ['KeepFilling'] });
    assert.deepStrictEqual(c2.importCfg({ land: false, unlocks: false, handoff: false, dir_sell: false, dir_cadence: false, confirmMs: 30 }).skipped, []);
    c2.start({ dryRun: false });
    for (let i = 0; i < 4 && c2.running; i++) { await waitFor(() => !c2.active); await c2._step(); }
    assert.strictEqual(c2.running, false, 'stopped after 3 unconfirmed sends');
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'KeepFilling').length, 3);
    F.unload();
  });

  // ---- sell -------------------------------------------------------------------------------------------------------------
  const { cp: cpS } = F.load(['cp-lab', 'cp-cadence']);
  const XS = cpS._cadence;
  const sellSt = () => { const st = plain(); st.stock[0][I('Iron Ore')] = 500000; st.stock[0][I('Gold Ore')] = 155; st.stock[0][I('Iron Sheet')] = 900000; st.stock[0][I('Wood')] = 900000; st.stock[0][I('Wooden Frame')] = 9000; return st; };
  const sellDeals = () => [bid(41, I('Iron Ore'), 393000, 229, 300), bid(42, I('Iron Sheet'), 400000, 9000, 300), bid(43, I('Wood'), 386000, 75, 300), bid(44, I('Wooden Frame'), 10000, 99999, 300), bid(45, I('Gold Ore'), 399600, 918, 300), bid(46, I('Cotton'), 300000, 150, 300)];
  await t('sell plans ore above the keep line and never touches engine inputs', () => {
    const st = sellSt(), deals = sellDeals(), v = view(cpS, st, deals);
    const out = cpS._decide(v, F.ctxOf({ tick: T0, deals }));
    const plan = XS.sellPlan(v, F.ctxOf({ tick: T0, deals }), out);
    const never = new Set(XS.NEVER.map(I));
    assert.ok(plan.length >= 1);
    for (const p of plan) assert.ok(!never.has(p.item) && p.item !== I('Cotton'), 'never sells ' + p.name);
    const ore = plan.find((p) => p.item === I('Iron Ore'));
    assert.ok(ore, 'Iron Ore is sold');
    assert.ok(ore.keep > 0 && ore.spare === 500000 - ore.keep, 'keep line applied');
    assert.ok(!plan.some((p) => p.item === I('Gold Ore')), 'less than one full load above the keep line: not started');
    // The paused Kiln on Blow Glass still eats Sand later: its 48 h is kept (live 2026-11-22: 2,196 Sand, keep was 0).
    assert.ok(st.groups[10].paused && st.groups[10].recipe === Rc('Blow Glass'));
    assert.ok(XS.keepLine(v, out.rule, I('Sand')) > 0, 'paused group input kept');
  });
  await t('sell only when live, through autoSell.start, never a duplicate job', async () => {
    const st = sellSt(), deals = sellDeals(), v = view(cpS, st, deals);
    const out = cpS._decide(v, F.ctxOf({ tick: T0, deals }));
    const jobs = [], started = [];
    const as = { jobs: () => jobs, start: (o) => { started.push(o); jobs.push({ deal: o.deal, item: deals.find((d) => d.id === o.deal).item, keep: o.keep, left: o.total, fullLoads: o.fullLoads }); return o.deal; }, stop() { } };
    const mm = F.ctxOf().mem;
    let r = XS.sellDecide(v, F.ctxOf({ tick: T0, deals, live: false, dryRun: true, mods: { autoSell: as }, sellJobs: jobs, mem: mm }), out);
    assert.ok(!r.action, 'dry run: no action');
    r = XS.sellDecide(v, F.ctxOf({ tick: T0, deals, mods: { autoSell: as }, sellJobs: jobs, mem: mm }), out);
    assert.strictEqual(await r.action.run(), true);
    assert.deepStrictEqual(started, [{ deal: 41, total: null, keep: started[0].keep, fullLoads: true }]);
    r = XS.sellDecide(v, F.ctxOf({ tick: T0, deals, mods: { autoSell: as }, sellJobs: jobs, mem: mm }), out);
    assert.ok(!r.action || !/Iron Ore/.test(r.action.text), 'no second job for Iron Ore');
    // A bid the game's own auto-ship fills is left alone.
    st.standing_fills = { 41: { region: 0, expires_at: T0 + 300 * MIN } };
    assert.ok(!XS.sellPlan(view(cpS, st, deals), F.ctxOf({ tick: T0, deals }), out).some((p) => p.deal === 41));
    // autoSell throwing (bid gone) is not a server failure.
    const bad = { jobs: () => [], start: () => { throw new Error('bid not found'); } };
    st.standing_fills = {};
    r = XS.sellDecide(view(cpS, st, deals), F.ctxOf({ tick: T0, deals, mods: { autoSell: bad }, sellJobs: [] }), out);
    assert.strictEqual(await r.action.run(), null);
  });

  await t('sell: our job follows the keep line when a group starts eating the item; never a raise for a job not ours', async () => {
    const st = sellSt(); st.stock[0][I('Gold Ore')] = 400000;
    const deals = sellDeals(), out = cpS._decide(view(cpS, st, deals), F.ctxOf({ tick: T0, deals }));
    const started = [];
    const jobs = [{ deal: 45, item: I('Gold Ore'), keep: 0, left: null, fullLoads: true }];
    const as = { jobs: () => jobs, start: (o) => { started.push(o); jobs[0].keep = o.keep; return o.deal; }, stop() { } };
    const mm = F.ctxOf().mem; mm('sell').set({ mine: [45] });
    const cx = () => F.ctxOf({ tick: T0, deals, mods: { autoSell: as }, sellJobs: jobs, mem: mm });
    let r = XS.sellDecide(view(cpS, st, deals), cx(), out);
    assert.ok(!r.action || !/^sell:keep/.test(r.action.id), 'nothing eats Gold Ore yet: keep 0 is right');
    // A Smelter switches to Smelt Gold: 48 h of its use must stay.
    st.groups[7].recipe = Rc('Smelt Gold'); delete st.groups[7].work;
    const keep = XS.keepLine(view(cpS, st, deals), out.rule, I('Gold Ore'));
    assert.ok(keep > 0);
    r = XS.sellDecide(view(cpS, st, deals), cx(), out);
    assert.strictEqual(r.action.id, 'sell:keep:45:' + keep);
    assert.strictEqual(await r.action.run(), true);
    assert.deepStrictEqual(started, [{ deal: 45, total: null, keep, fullLoads: true }]);
    r = XS.sellDecide(view(cpS, st, deals), cx(), out);
    assert.ok(!r.action || !/^sell:keep/.test(r.action.id), 'raised once');
    // A job the user started is left as it is.
    jobs[0].keep = 0; mm('sell').set({ mine: [] });
    r = XS.sellDecide(view(cpS, st, deals), cx(), out);
    assert.ok(!r.action || !/^sell:keep/.test(r.action.id));
  });
  await t('sell: a job autoSell moved to another bid (from: old id) stays ours: no cooldown, keep line raised on the new id', async () => {
    const st = sellSt(); st.stock[0][I('Gold Ore')] = 400000;
    const deals = sellDeals(), out = cpS._decide(view(cpS, st, deals), F.ctxOf({ tick: T0, deals }));
    const started = [];
    const jobs = [{ deal: 47, from: 45, item: I('Gold Ore'), keep: 0, left: null, fullLoads: true }];
    const as = { jobs: () => jobs, start: (o) => { started.push(o); jobs[0].keep = o.keep; return o.deal; }, stop() { } };
    const mm = F.ctxOf().mem; mm('sell').set({ mine: [45] });
    st.groups[7].recipe = Rc('Smelt Gold'); delete st.groups[7].work;
    const keep = XS.keepLine(view(cpS, st, deals), out.rule, I('Gold Ore'));
    assert.ok(keep > 0);
    const now = 1.8e12, cx = () => F.ctxOf({ now, tick: T0, deals, mods: { autoSell: as }, mem: mm });
    const c = cx(); cpS._decide(view(cpS, st, deals), c);       // the sell context remaps mine
    assert.deepStrictEqual(mm('sell').get().mine, [47]);
    assert.ok(!mm('sell').get().cool?.[45], 'no cooldown on the old id');
    const r = XS.sellDecide(view(cpS, st, deals), c, out);
    assert.strictEqual(r.action.id, 'sell:keep:47:' + keep);
    assert.strictEqual(await r.action.run(), true);
    assert.deepStrictEqual(started, [{ deal: 47, total: null, keep, fullLoads: true }]);
  });
  await t('sell: a job autoSell ended by itself cools down before that bid is tried again', () => {
    const st = sellSt(), deals = sellDeals();
    const mm = F.ctxOf().mem; mm('sell').set({ mine: [41] });
    const as = { jobs: () => [], start() { }, stop() { } };
    const now = 1.8e12, cx = (n) => F.ctxOf({ now: n, tick: T0, deals, mods: { autoSell: as }, mem: mm });
    let d = cpS._decide(view(cpS, st, deals), cx(now));        // the sell context sees job 41 gone
    assert.deepStrictEqual(mm('sell').get().mine, []);
    assert.ok(mm('sell').get().cool[41] > now);
    const a = d.actions.find((x) => x.director === 'sell');
    assert.ok(!a || a.id !== 'sell:41', 'not restarted at once: ' + a?.id);
    assert.ok(!XS.sellPlan(view(cpS, st, deals), cx(now + 30 * 60000), d).some((p) => p.deal === 41));
    d = cpS._decide(view(cpS, st, deals), cx(now + 61 * 60000));
    assert.ok(XS.sellPlan(view(cpS, st, deals), cx(now + 61 * 60000), d).some((p) => p.deal === 41), 'tried again after the cooldown');
  });

  // ---- cadence ------------------------------------------------------------------------------------------------------------
  // Spies: the hourly lab check reads labRunner.running, the 6-hour module check reads st.module_defs.
  const spy = (st) => {
    const n = { lab: 0, mods: 0 }, lab = { cfg: { dryRun: false } };
    Object.defineProperty(lab, 'running', { get: () => { n.lab++; return true; } });
    const md = st.module_defs;
    Object.defineProperty(st, 'module_defs', { get: () => { n.mods++; return md; }, configurable: true });
    return { n, lab };
  };
  await t('cadence: over 24 h the hourly checks run 24 times and the 6-hour checks 4 times, each on its tick', () => {
    const st = plain(), { n, lab } = spy(st), v = view(cpS, st, []);
    cpS.cfg.dir_lab = false;                                    // the lab director also reads labRunner.running: keep it out of the spy count
    const mm = F.ctxOf().mem, quiet = () => { };
    const t0 = 1.8e12 + 123457;
    let h = 0, s = 0, prev = null;
    for (let now = t0; now < t0 + 24 * 3600000; now += 7 * 60000) {
      const ctx = F.ctxOf({ now, tick: T0, mem: mm, mods: { labRunner: lab } });
      XS.cadenceSettle(prev, mm('cadence'), now, quiet);      // what the next step's context does with the last plan
      const before = { ...n };
      const d = cpS._decide(v, ctx);
      const rc = d.readouts.cadence;
      assert.strictEqual(rc.evaluated.hourly, n.lab > before.lab, 'hourly checks ran exactly when their tick fired');
      assert.strictEqual(rc.evaluated.six, n.mods > before.mods, '6-hour checks ran exactly when their tick fired');
      assert.strictEqual(rc.evaluated.hourly, rc.fired.hourly); assert.strictEqual(rc.evaluated.six, rc.fired.six);
      if (rc.evaluated.hourly) h++; if (rc.evaluated.six) s++;
      assert.ok(rc.hourly.length && rc.six.length, 'saved results shown between ticks');
      prev = d;
    }
    cpS.cfg.dir_lab = true;
    assert.strictEqual(h, 24); assert.strictEqual(s, 4);
    assert.deepStrictEqual([mm('cadence').get().hFires, mm('cadence').get().sFires], [24, 4]);
    // A long sleep gives one catch-up fire, not several.
    const d = cpS._decide(v, F.ctxOf({ now: t0 + 30 * 3600000, tick: T0, mem: mm, mods: { labRunner: lab } }));
    assert.ok(d.readouts.cadence.evaluated.hourly);
    assert.strictEqual(mm('cadence').get().hFires, 25);
  });
  await t('cadence: readout lists failing checks; alert only on a new failure', () => {
    const st = plain();
    const notes = [], note = (...a) => notes.push(a);
    const mm = F.ctxOf().mem;
    const lab = { running: true, cfg: { dryRun: false } }, util = { conf: { power: { on: true } } };
    const deals = [{ id: 2147483724, side: 'Sell', item: I('Cotton'), amount: 23649, price: 3582900, region: 0, expires_at: T0 + 100 * MIN }];
    st.standing_fills = { 2147483724: { region: 0, expires_at: T0 + 100 * MIN } };
    st.subscriptions = { 0: { power: 50 } };
    const t0 = 1.8e12;
    const ctx = (o = {}) => F.ctxOf({ now: t0, tick: T0, deals, mem: mm, mods: { labRunner: lab, autoUtil: util }, ...o });
    let d = cpS._decide(view(cpS, st, deals), ctx());
    const fails = d.readouts.cadence.failing.map((x) => x.split(':')[0]);
    assert.ok(fails.includes('modules'), 'the free Refiner module: ' + fails);
    assert.ok(!fails.includes('lab') && !fails.includes('autoship') && !fails.includes('power'), fails.join());
    assert.ok(!d.actions.some((x) => x.director === 'cadence'), 'the alert is not a queued action');
    assert.deepStrictEqual(XS.cadenceSettle(d, mm('cadence'), t0, note).fresh, ['modules']);
    assert.strictEqual(notes.length, 1);
    d = cpS._decide(view(cpS, st, deals), ctx({ now: t0 + 60000 }));
    XS.cadenceSettle(d, mm('cadence'), t0 + 60000, note);
    assert.strictEqual(notes.length, 1, 'same failures: no second alert');
    // The Lab runner drops to a dry run: on the next hourly tick, a new failure and one more alert.
    lab.cfg.dryRun = true;
    d = cpS._decide(view(cpS, st, deals), ctx({ now: t0 + 61 * 60000 }));
    XS.cadenceSettle(d, mm('cadence'), t0 + 61 * 60000, note);
    assert.strictEqual(notes.length, 2);
    assert.match(notes[1][2], /Lab runner is a dry run/);
    d = cpS._decide(view(cpS, st, deals), ctx({ now: t0 + 62 * 60000 }));
    XS.cadenceSettle(d, mm('cadence'), t0 + 62 * 60000, note);
    assert.strictEqual(notes.length, 2);
    const hc = (s, dl) => XS.hourlyChecks(view(cpS, s, dl), ctx({ deals: dl }), { stage: 'B' });
    // Auto-ship with under 15 min left fails the hourly check.
    st.standing_fills[2147483724].expires_at = T0 + 10 * MIN;
    assert.strictEqual(hc(st, deals).find((x) => x.id === 'autoship').ok, false);
    // Market board not loaded: the auto-ship check is unknown, not failing (no false alert).
    assert.strictEqual(hc(st, []).find((x) => x.id === 'autoship').ok, null);
    // Cash under the bill floor (50 MW x $120).
    st.items[0] = 100;
    assert.strictEqual(hc(st, deals).find((x) => x.id === 'cash').ok, false);
  });
  await t('cadence runner: a dry run alerts too (the alert is not a game command)', async () => {
    const st = plain();
    globalThis.localStorage = F.mem();                         // ctx.mem persists through localStorage, as in the browser
    const { cp: c2 } = F.boot(st, { deals: [], catalog: CAT, modules: ['cp-lab', 'cp-cadence'] });
    const notes = [];
    globalThis.idleCore.notify = (...a) => notes.push(a);
    c2.importCfg({ land: false, unlocks: false, handoff: false, dir_slot: false, dir_sell: false });
    c2.start({ dryRun: true });
    for (let i = 0; i < 3; i++) { await waitFor(() => !c2.active); await c2._step(); }
    assert.strictEqual(c2.status().dryRun, true);
    assert.strictEqual(notes.length, 1, JSON.stringify(notes));
    assert.match(notes[0][2], /module/);
    c2.stop(); F.unload();
  });

  // ---- offline, designs -------------------------------------------------------------------------------------------------------
  await t('offline: free plan StartTech only, premium queues Assembly Plant -> Retail Store, never Oil Rig', () => {
    // Stage B (Assembly Plant researching): free plan sends nothing, warns over 24 h.
    let st = plain();
    let p = XS.offlinePlan(view(cpS, st), 30);
    assert.deepStrictEqual(p.sends, []);
    assert.strictEqual(p.capHours, 24);
    assert.strictEqual(p.checklist.find((x) => x.id === 'cap').ok, false);
    assert.strictEqual(p.checklist.find((x) => x.id === 'cash').ok, true);
    // Premium, enough CD and prototype items: Retail Store goes in the queue behind the Assembly Plant.
    st = plain(); st.premium = true; st.items[F.CD] = 30000; st.stock[0][I('Glass')] = 100;
    p = XS.offlinePlan(view(cpS, st), 30, { retailOk: true });
    assert.deepStrictEqual(p.sends, [{ type: 'QueueTech', building: B('Retail Store'), region: 0 }], 'Oil Rig never queued');
    assert.strictEqual(p.capHours, 168); assert.strictEqual(p.checklist.find((x) => x.id === 'cap').ok, true);
    // Research idle, nothing unlocked yet: premium starts AP and queues RS; free starts AP only.
    st = plain(); st.research = null; st.items[F.CD] = 60000; st.stock[0][I('Glass')] = 100; st.stock[0][I('Concrete')] = 500; st.stock[0][I('Iron Frame')] = 100;
    p = XS.offlinePlan(view(cpS, st), 10, { premium: true, retailOk: true });
    assert.deepStrictEqual(p.sends.map((m) => [m.type, m.building]), [['StartTech', B('Assembly Plant')], ['QueueTech', B('Retail Store')]]);
    p = XS.offlinePlan(view(cpS, st), 10, { premium: false });
    assert.deepStrictEqual(p.sends.map((m) => [m.type, m.building]), [['StartTech', B('Assembly Plant')]], 'longest due unlock, not Oil Rig');
    // Only Oil Rig left: started on the idle slot once retail passed (premium or not); before that the plan waits, not a failure.
    st.unlocked_buildings = [...st.unlocked_buildings, B('Assembly Plant'), B('Retail Store')];
    for (const premium of [true, false]) {
      p = XS.offlinePlan(view(cpS, st), 10, { premium, retailOk: true });
      assert.deepStrictEqual(p.sends, [{ type: 'StartTech', building: B('Oil Rig'), region: 0 }], 'premium ' + premium);
      p = XS.offlinePlan(view(cpS, st), 10, { premium, retailOk: null });
      assert.deepStrictEqual(p.sends, []);
      const u = p.checklist.find((x) => x.id === 'unlock');
      assert.strictEqual(u.ok, true); assert.match(u.text, /Oil Rig waits for the retail checkpoint/);
    }
    // corePlan.offline() uses the checkpoint the last step saw (the retail director's ctx.retailOk).
    const { cp: cpO, core } = F.load(['cp-lab', 'cp-cadence']);
    const mm = F.ctxOf().mem;
    cpO._decide(view(cpO, st), F.ctxOf({ tick: T0, mem: mm, retailOk: true }));
    core.walk = () => ({ st, catalog: CAT, deals: [] });
    assert.deepStrictEqual(cpO.offline(10).sends, [{ type: 'StartTech', building: B('Oil Rig'), region: 0 }]);
    cpO._decide(view(cpO, st), F.ctxOf({ tick: T0, mem: mm, retailOk: null }));
    assert.deepStrictEqual(cpO.offline(10).sends, []);
    // A failed checkpoint waits for a pass of the new run (plan D-2), offline as live; that pass starts the Oil Rig.
    for (const premium of [true, false]) {
      p = XS.offlinePlan(view(cpS, st), 10, { premium, retailOk: false });
      assert.deepStrictEqual(p.sends, [], 'failed checkpoint, premium ' + premium);
      assert.match(p.checklist.find((x) => x.id === 'unlock').text, /Oil Rig waits for the retail checkpoint/);
    }
    cpO._decide(view(cpO, st), F.ctxOf({ tick: T0, mem: mm, retailOk: false }));
    assert.deepStrictEqual(cpO.offline(10).sends, []);
    cpO._decide(view(cpO, st), F.ctxOf({ tick: T0, mem: mm, retailOk: true }));
    assert.deepStrictEqual(cpO.offline(10).sends, [{ type: 'StartTech', building: B('Oil Rig'), region: 0 }]);
    // Cash: subscribed MW x $60 x hours.
    st.subscriptions = { 0: { power: 100 } }; st.items[0] = 100 * 6000 * 10 - 1;
    assert.strictEqual(XS.offlinePlan(view(cpS, st), 10).checklist.find((x) => x.id === 'cash').ok, false);
  });
  await t('canSaveDesign: 4 designs per recipe free, 10 premium', () => {
    const r = Rc('Make Chair'), d = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['d' + i, { cells: {} }]));
    assert.strictEqual(cpS.canSaveDesign({ designs: { [r]: d(3) } }, r), true);
    assert.strictEqual(cpS.canSaveDesign({ designs: { [r]: d(4) } }, r), false);
    assert.strictEqual(cpS.canSaveDesign({ premium: true, designs: { [r]: d(4) } }, r), true);
    assert.strictEqual(cpS.canSaveDesign({ premium: true, designs: { [r]: d(10) } }, r), false);
    assert.strictEqual(cpS.canSaveDesign({}, r), true);
  });

  // ---- world events (plan D5) -------------------------------------------------------------------------------------------
  await t('world events (D5): the last WorldEvents socket message is kept raw and shown as an info row in the 6-hour checks, never failing', () => {
    const st = plain();
    const { cp: c2, core, w } = F.boot(st, { deals: [], catalog: CAT, modules: ['cp-lab', 'cp-cadence'] });
    const row = (o = {}) => c2._decide(view(c2, st), F.ctxOf({ tick: T0, now: Date.now(), ...o })).readouts.cadence.six.find((x) => x.id === 'world');
    assert.strictEqual(c2.worldEvents(), null);
    assert.deepStrictEqual(row(), { id: 'world', ok: null, why: 'no WorldEvents message seen' });
    core.walk(true);                                             // attaches the core's listener to the game socket
    w.emit({ kind: 'WorldEvents', clock: { npc_power: 2 }, tick: 5 });
    w.emit({ kind: 'Heartbeat', tick: 6, hash: 'x' });           // other messages leave the record alone
    const rec = c2.worldEvents();
    assert.strictEqual(JSON.parse(rec.raw).clock.npc_power, 2);
    assert.ok(Math.abs(rec.at - Date.now()) < 5000);
    const r = row();
    assert.strictEqual(r.ok, null);
    assert.match(r.why, /^world events: last WorldEvents message 0 min ago: \{"kind":"WorldEvents","clock":\{"npc_power":2\}/);
    const d = c2._decide(view(c2, st), F.ctxOf({ tick: T0, now: Date.now() }));
    assert.ok(!d.readouts.cadence.failing.some((x) => /^world/.test(x)));
    assert.ok(!d.actions.some((a) => /world/i.test(a.text)), 'never acted on');
    const long = { raw: 'x'.repeat(500), at: Date.now() - 2 * 3600000 };
    const six = c2._cadence.sixHourChecks(view(c2, st), F.ctxOf({ worldEvents: long, now: Date.now() }), { rule: null }).find((x) => x.id === 'world');
    assert.strictEqual(six.why, 'world events: last WorldEvents message 2.0 h ago: ' + 'x'.repeat(200));
    F.unload();
  });

  // ---- shelf hours, free modules (plan A1, A4) -----------------------------------------------------------------------------
  const { cp: cpR, core: coreR } = F.load(['cp-lab', 'cp-retail', 'cp-cadence']);
  const XR = cpR._cadence, R = cpR._retail;
  const chair = (stock, outTick = 0) => ({ id: I('Chair'), appetite: 2400, stock, outTick });   // demand 72,000 per hour at share 1
  await t('shelf hours: stock over (demand - output), Infinity when output keeps up; the board\'s held is not read', () => {
    assert.strictEqual(R.shelfHours(chair(144000), 1), 2);
    assert.strictEqual(R.shelfHours(chair(36000), 1), 0.5);
    assert.strictEqual(R.shelfHours(chair(144000, 5), 1), 144000 / 36000, 'output offsets the drain');
    assert.strictEqual(R.shelfHours(chair(0, 10), 1), Infinity);
    assert.strictEqual(R.shelfHours(chair(0), 0.5), 0);
    const stD = plain(); stD.groups[90] = { building: B('Retail Store'), region: 0, count: 1, recipe: null, name: 'Retail', modules: {}, assortment: [I('Chair')] };
    const board = { shelves: { 0: { [I('Chair')]: { appetite: 2400, held: 0, price: 10000 } } } };   // held 0: the old check failed on it
    const hc = (g) => XR.hourlyChecks(view(cpR, stD, []), F.ctxOf({ retailBoard: board, retail: g ? { goods: [g], share: 1 } : undefined }), { stage: 'D' }).find((x) => x.id === 'shelves');
    assert.strictEqual(hc(chair(144000)).ok, true, '2 h of stock passes');
    const low = hc(chair(36000));
    assert.strictEqual(low.ok, false, '0.5 h of stock fails'); assert.match(low.why, /Chair/);
    assert.strictEqual(hc(chair(0, 10)).ok, true, 'output at demand: never runs dry');
    assert.strictEqual(hc(null).ok, null, 'no retail facts: unknown, not a failure');
    const off = (g, hours) => XR.offlinePlan(view(cpR, stD, []), hours, { retail: { goods: [g], share: 1 } }).checklist.find((x) => x.id === 'shelves');
    assert.strictEqual(off(chair(144000), 1).ok, true);
    assert.strictEqual(off(chair(144000), 10).ok, false);
    assert.strictEqual(off(chair(0, 10), 10).ok, true);
    // share unknown (rival ratings shape): never a pass, even with no stock
    const hcN = XR.hourlyChecks(view(cpR, stD, []), F.ctxOf({ retailBoard: board, retail: { goods: [chair(0)], share: null } }), { stage: 'D' }).find((x) => x.id === 'shelves');
    assert.strictEqual(hcN.ok, null); assert.match(hcN.why, /retail share unknown/);
    const offN = XR.offlinePlan(view(cpR, stD, []), 10, { retail: { goods: [chair(0)], share: null } }).checklist.find((x) => x.id === 'shelves');
    assert.strictEqual(offN.ok, null); assert.match(offN.text, /retail share unknown/);
    // corePlan.offline() builds the facts from the engine's board.
    coreR.walk = () => ({ st: stD, catalog: CAT, deals: [], engine: { retailJson: () => JSON.stringify(F.stageB.retail) } });
    assert.notStrictEqual(cpR.offline(1).checklist.find((x) => x.id === 'shelves').ok, null, 'readable board');
  });
  await t('sell: a shelf is saturated when output >= demand and stock >= sellSaturatedHours of demand', () => {
    const dl = [bid(61, I('Clock'), 400000, 500, 300)], st = plain(); st.stock[0][I('Clock')] = 9e6;
    const sat = (g) => XR.sellPlan(view(cpR, st, dl), F.ctxOf({ tick: T0, deals: dl, retail: { goods: [g], share: 1 } }), {}).find((p) => p.item === I('Clock'));
    const clock = (stock, outTick) => ({ id: I('Clock'), appetite: 2400, stock, outTick });
    assert.ok(!sat(clock(2e6, 10)), 'a good the store does not shelve is never sold as a saturated shelf');
    st.groups[90] = { building: B('Retail Store'), region: 0, count: 1, recipe: null, assortment: [I('Clock')] };
    assert.strictEqual(sat(clock(2e6, 10)).kind, 'saturated shelf');
    assert.ok(!sat(clock(1e6, 10)), 'under 24 h of demand in stock');
    assert.ok(!sat(clock(2e6, 5)), 'output below demand');
  });
  await t('free modules: object sockets (modId) count as installed', () => {
    const st = plain(); st.fleet_modules = [];
    st.module_defs = { 7: { id: 7, name: 'Overclock A', kind: 1 }, 8: { id: 8, name: 'Refiner B', kind: 2 } };
    st.groups[3].modules = { '1,-1': { id: 7 } };
    const m = XR.sixHourChecks(view(cpR, st, []), F.ctxOf(), { rule: null }).find((x) => x.id === 'modules');
    assert.strictEqual(m.ok, false); assert.match(m.why, /1 module\(s\) not installed: Refiner B/);
  });

  // ---- resume (D7) and the Autopilot hand-off (B4) ---------------------------------------------------------------------
  await t('resume (D7): a group an unpaid bill paused comes back once bills are affordable; yours and a director\'s stay paused', () => {
    const { cp: c } = F.load(['cp-cadence']);
    const cat = F.board.catalog, dl = F.cottonBidDeals(), st = F.stageA();
    const v0 = c._view(st, cat, dl), drawAll = v0.groups.reduce((a, g) => a + (v0.bld(g.building).draws?.power ?? 0) * g.count, 0);
    assert.ok((v0.bld(F.B('Smelter')).draws?.power ?? 0) > 0 && drawAll > 0, 'Smelters draw power');
    st.subscriptions = { 0: { power: drawAll } };
    const mem = F.ctxOf().mem;
    const dec = (o = {}) => c._decide(c._view(st, cat, dl), F.ctxOf({ mem, ...o }));
    const res = (d) => d.actions.find((a) => a.director === 'resume');
    st.groups[7].paused = true;                                  // already paused when first seen: the user's
    dec();                                                       // the Smelters are seen running
    st.groups[1].paused = true; st.items[F.MONEY] = 100;         // paused with cash under 2 bills: the bill did it
    let d = dec();
    assert.deepStrictEqual(mem('resume').get().bill, [1]);
    assert.ok(mem('resume').get().user.includes(7));
    assert.ok(!res(d)); assert.match(d.waits.join(' | '), /resume: "Smelter" is paused \(unpaid bill\?\): waiting for cash/);
    st.items[F.MONEY] = 5e6;
    st.groups[6].paused = true;                                  // paused with the bills covered: the user's
    d = dec();
    assert.deepStrictEqual(res(d).steps[0].msg, { type: 'SetPaused', group: 1, paused: false });
    assert.ok(mem('resume').get().user.includes(6) && !mem('resume').get().bill.includes(6));
    assert.ok(res(dec({ cashDelta10: -50 })), 'no stage (cash falling): it still resumes');
    assert.match(dec({ mods: { earlyGame: { running: true, cfg: { resumePaused: true } } } }).waits.join(' | '), /resume: Autopilot resumes the 1 bill-paused group/);
    st.subscriptions[0].power = 0;
    assert.match(dec().waits.join(' | '), /power subscription 0 MW < \d+ MW with it/);
    st.subscriptions[0].power = drawAll;
    mem('buildout').set({ kilnMine: [1] });                      // a director paused it on purpose
    assert.ok(!res(dec()));
    mem('buildout').set({ kilnMine: [], ftMine: [1] });
    assert.ok(!res(dec()));
    mem('buildout').set({ ftMine: [] });
    st.groups[1].paused = false; dec();                          // running again: forgotten
    assert.deepStrictEqual(mem('resume').get().bill, []);
    assert.ok(c.duties().some((x) => /resume groups paused by an unpaid bill/.test(x.duty) && x.owner === 'Core plan'));
    assert.ok(!c.duties().some((x) => /floor upgrades/.test(x.duty) || x.owner === 'Autopilot'));
  });

  await t('resume (D7): with Auto power on, a group the user pauses is the user\'s even though the subscription is below the unpaused draw', () => {
    const { cp: c } = F.load(['cp-cadence']);
    const cat = F.board.catalog, dl = F.cottonBidDeals(), st = F.stageA();
    st.subscriptions = { 0: { power: 0 } };                      // Auto power follows the running load: no bill is short
    st.items[F.MONEY] = 5e6;
    const mem = F.ctxOf().mem, mods = { autoUtil: { conf: { power: { on: true } } } };
    const dec = () => c._decide(c._view(st, cat, dl), F.ctxOf({ mem, mods }));
    dec();                                                       // the Smelters are seen running
    st.groups[1].paused = true;                                  // the user pauses one
    dec();
    assert.ok(mem('resume').get().user.includes(1), 'the user\'s pause');
    assert.ok(!(mem('resume').get().bill ?? []).includes(1));
  });

  await t('resume (D7): with Auto power on, a bill-paused group resumes on cash alone (the subscription is below its full draw)', () => {
    const { cp: c } = F.load(['cp-cadence']);
    const cat = F.board.catalog, dl = F.cottonBidDeals(), st = F.stageA();
    st.subscriptions = { 0: { power: 0 } };
    const mem = F.ctxOf().mem, mods = { autoUtil: { conf: { power: { on: true } } } };
    const dec = () => c._decide(c._view(st, cat, dl), F.ctxOf({ mem, mods }));
    dec();                                                       // the Smelters are seen running
    st.items[F.MONEY] = 100; st.groups[1].paused = true;         // paused with cash under 2 bills: the bill did it
    dec();
    assert.deepStrictEqual(mem('resume').get().bill, [1]);
    st.items[F.MONEY] = 5e6;
    const d = dec();
    assert.deepStrictEqual(d.actions.find((a) => a.director === 'resume').steps[0].msg, { type: 'SetPaused', group: 1, paused: false });
  });

  await t('resume (D7): Autopilot\'s keptPaused groups (localStorage earlyGame.v2) and the endgame gate\'s groups stay paused; a bad key reads as empty', () => {
    const { cp: c } = F.load(['cp-cadence']);
    const cat = F.board.catalog, dl = F.cottonBidDeals(), st = F.stageA();
    const v0 = c._view(st, cat, dl), drawAll = v0.groups.reduce((a, g) => a + (v0.bld(g.building).draws?.power ?? 0) * g.count, 0);
    st.subscriptions = { 0: { power: drawAll } };
    const mem = F.ctxOf().mem;
    const dec = () => c._decide(c._view(st, cat, dl), F.ctxOf({ mem }));
    const res = (d) => d.actions.find((a) => a.director === 'resume');
    dec();
    st.groups[1].paused = true; st.items[F.MONEY] = 100; dec();  // a bill pause
    assert.deepStrictEqual(mem('resume').get().bill, [1]);
    st.items[F.MONEY] = 5e6;
    try {
      for (const raw of [null, '{not json', JSON.stringify({ keptPaused: 'x' }), JSON.stringify({}), JSON.stringify({ keptPaused: [2] })]) {
        globalThis.localStorage = F.mem(raw == null ? {} : { 'earlyGame.v2': raw });
        assert.ok(res(dec()), 'resumed with earlyGame.v2 = ' + raw);
      }
      delete globalThis.localStorage;
      assert.deepStrictEqual(c._cadence.keptPaused(), [], 'no localStorage at all');
      globalThis.localStorage = F.mem({ 'earlyGame.v2': JSON.stringify({ keptPaused: [1, 9] }) });
      assert.deepStrictEqual(c._cadence.keptPaused(), [1, 9]);
      assert.ok(!res(dec()), 'kept paused by Autopilot');
      globalThis.localStorage = F.mem({});
      mem('endgame').set({ egMine: [1] });                       // the endgame stock gate paused it
      assert.ok(!res(dec()));
      mem('endgame').set({ egMine: [] });
      assert.ok(res(dec()));
    } finally { delete globalThis.localStorage; }
  });

  await t('hand-off (B4): every engine item to neverSell, then Autopilot stopped once; a restart by the user is left alone with an alert', async () => {
    const { cp: c } = F.load(['cp-cadence']);
    const cat = F.board.catalog, v = c._view(F.stageA(), cat, F.cottonBidDeals()), mem = F.ctxOf().mem;
    let stops = 0;
    const eg = { running: true, stop() { stops++; this.running = false; } };
    globalThis.earlyGame = eg;
    const ap = (o) => ({ neverSell: [], cdBooster: true, running: eg.running, ...o });
    const util = { conf: { power: { on: true }, water: { on: true } }, set() { } };   // Auto utilities power on (H-fix)
    const ho = (o, cx = c) => cx._decide(v, F.ctxOf({ mem, ap: ap(o), mods: { autoUtil: util } })).actions.find((a) => a.id.startsWith('handoff'));
    const a1 = ho();
    assert.strictEqual(a1.id, 'handoff');
    for (const n of ['Wood', 'Planks', 'Iron Sheet', 'Concrete', 'Glass', 'Bookshelf', 'Table', 'Chair', 'Bench', 'Wooden Frame', 'Iron Frame',
      'Iron Ore', 'Coal', 'Limestone', 'Sand', 'Copper Ore', 'Copper Wire', 'Wired Frame']) assert.ok(a1.patch.neverSell.includes(F.I(n)), n);
    for (const n of X.NEVER) assert.ok(a1.patch.neverSell.includes(F.I(n)), 'cadence NEVER: ' + n);
    const patched = { neverSell: a1.patch.neverSell, cdBooster: false };
    c.cfg.handoffStopAutopilot = false; assert.ok(!ho(patched), 'cfg.handoffStopAutopilot false: Autopilot keeps running'); c.cfg.handoffStopAutopilot = true;
    c.cfg.dir_resume = false; assert.ok(!ho(patched), 'D7 off: Autopilot keeps the resume duty'); c.cfg.dir_resume = true;
    // Autopilot also raises the power subscription: no stop until Auto utilities power is on (or while autoUtil is not loaded)
    util.conf.power.on = false;
    assert.ok(!ho(patched), 'power Auto off: Autopilot keeps running');
    assert.ok(c._decide(v, F.ctxOf({ mem, ap: ap(patched), mods: { autoUtil: util } })).waits.includes('hand-off: Autopilot keeps running until Auto utilities power is on (it raises the power subscription)'));
    assert.ok(!c._decide(v, F.ctxOf({ mem, ap: ap(patched) })).actions.some((a) => a.id === 'handoff:stop'), 'autoUtil not loaded');
    util.conf.power.on = true;
    const a2 = ho(patched);
    assert.strictEqual(a2.id, 'handoff:stop');
    assert.strictEqual(await a2.run(), true);
    assert.strictEqual(stops, 1); assert.ok(mem('handoff').get().stopped);
    assert.ok(!ho(patched), 'stopped: nothing more to do');
    eg.running = true;                                           // the user starts Autopilot again
    const d = c._decide(v, F.ctxOf({ mem, ap: ap(patched) }));
    assert.ok(!d.actions.some((a) => a.id.startsWith('handoff')));
    assert.match(d.readouts.handoff.alert, /started again after the hand-off: left running/);
    assert.strictEqual(stops, 1);
    // Autopilot not running at the hand-off: recorded without a stop, so a later start is left alone
    const mem2 = F.ctxOf().mem, a3 = c._decide(v, F.ctxOf({ mem: mem2, ap: ap({ ...patched, running: false }), mods: { autoUtil: util } })).actions.find((a) => a.id === 'handoff:stop');
    assert.match(a3.text, /Autopilot is not running; recorded/);
    assert.strictEqual(await a3.run(), true); assert.strictEqual(stops, 1); assert.ok(mem2('handoff').get().stopped);
    assert.ok(!c._decide(v, F.ctxOf({ mem: mem2, ap: ap(patched), mods: { autoUtil: util } })).actions.some((a) => a.id.startsWith('handoff')), 'started later: not stopped');
    // no resume director loaded (D7): Autopilot is never stopped
    const { cp: c2 } = F.load([]);
    globalThis.earlyGame = { running: true, stop() { stops++; } };
    assert.ok(!c2._decide(v, F.ctxOf({ ap: ap(patched) })).actions.some((a) => a.id === 'handoff:stop'));
    globalThis.earlyGame = undefined;
  });

  await t('utilities (D1): power Auto on once per Live session; your switch-off is sticky with an alert; Alt+Shift+X waits for a new session; water only for a water-drawing group', async () => {
    const { cp: c, core: cc } = F.load(['cp-cadence']);
    const st = F.stageA(), cat = F.board.catalog;
    const util = { conf: { power: { on: false }, water: { on: false } }, set(u, on) { if (this.conf[u].on === !!on) return; this.conf[u].on = !!on; cc.ledger.add('AU', 'info', 'Auto ' + u + (on ? ' on' : ' off')); } };
    const mem = F.ctxOf().mem;
    let now = 1.8e12;
    const dec = (o = {}) => c._decide(c._view(st, cat, F.cottonBidDeals()), F.ctxOf({ mem, now, mods: { autoUtil: util }, ...o }));
    const act = (d) => d.actions.find((a) => a.director === 'utilities');
    const alerts = (d) => (d.readouts.utilities?.alerts ?? []).join(' | ');
    // off, no switch-off line: switched on; water stays off (no running group draws water)
    let a = act(dec());
    assert.strictEqual(a?.id, 'utilities:power');
    assert.strictEqual(await a.run(), true); assert.strictEqual(util.conf.power.on, true);
    let d = dec();
    assert.ok(!act(d), 'on, and no water draw: nothing to do');
    assert.match(d.readouts.utilities.water, /no running group draws water/);
    // Alt+Shift+X: "Auto power off" with a stop-all line right after it: not again in this Live session, again in the next
    util.set('power', false); cc.ledger.add('--', 'info', 'stop all (Alt+Shift+X): Auto utilities');
    d = dec();
    assert.ok(!act(d)); assert.match(alerts(d), /Auto power went off \(Alt\+Shift\+X\): switched on again in the next Live session/);
    now += 60000;                                                // a gap longer than 3 steps: a new Live session
    a = act(dec()); assert.strictEqual(a?.id, 'utilities:power'); await a.run();
    // its own 3-failure stop: the same
    util.conf.power.on = false; cc.ledger.add('AU', 'fail', 'Auto power switched off: the server did not apply 3 changes in a row');
    d = dec(); assert.ok(!act(d)); assert.match(alerts(d), /the game did not apply its changes/);
    now += 60000; a = act(dec()); assert.strictEqual(a?.id, 'utilities:power'); await a.run();
    // real order: Alt+Shift+X stops Core plan too, so its first look at the switch-off is in the next session: switched on there
    util.set('power', false); cc.ledger.add('--', 'info', 'stop all (Alt+Shift+X): Core plan + Auto utilities');
    now += 60000; a = act(dec()); assert.strictEqual(a?.id, 'utilities:power', 'stop-all first seen in a new session'); await a.run();
    util.conf.power.on = false; cc.ledger.add('AU', 'fail', 'Auto power switched off: the server did not apply 3 changes in a row');
    now += 60000; a = act(dec()); assert.strictEqual(a?.id, 'utilities:power', 'error stop first seen in a new session'); await a.run();
    // the user switches it off: an alert, no action, also in a later session and after the line has left the ledger
    util.set('power', false);
    d = dec(); assert.ok(!act(d)); assert.match(alerts(d), /Auto power was switched off by you: Core plan does not switch it back on/);
    now += 60000; assert.ok(!act(dec()), 'sticky across sessions');
    cc.ledger.clear(); now += 60000; assert.ok(!act(dec()), 'kept in mem when the ledger line is gone');
    // they switch it on again: forgotten; a later Alt+Shift+X is not theirs
    util.set('power', true); dec();
    assert.ok(!mem('utilities').get().off.power);
    // water: on once a running group draws water (Paper Mill), not for a paused one
    st.groups[20] = { building: F.B('Paper Mill'), region: 0, count: 1, recipe: null, paused: true };
    assert.ok(!act(dec()), 'paused group: no water');
    st.groups[20].paused = false;
    a = act(dec()); assert.strictEqual(a?.id, 'utilities:water'); await a.run(); assert.strictEqual(util.conf.water.on, true);
    // the pure ledger reading
    const L = (...e) => e.map(([mod, text, t]) => ({ mod, text, t }));
    assert.strictEqual(c._cadence.utilOffWhy('power', L(['AU', 'Auto power on', 1])), null);
    assert.strictEqual(c._cadence.utilOffWhy('power', L(['AU', 'Auto power on', 1], ['AU', 'Auto power off', 2])), 'user');
    assert.strictEqual(c._cadence.utilOffWhy('power', L(['AU', 'Auto power off', 2], ['--', 'stop all (Alt+Shift+X): x', 3])), 'pause');
    assert.strictEqual(c._cadence.utilOffWhy('power', L(['AU', 'Auto power off', 2], ['--', 'stop all (Alt+Shift+X): x', 60000])), 'user', 'a stop-all much later is not why');
    assert.strictEqual(c._cadence.utilOffWhy('water', L(['AU', 'Auto power off', 2])), null);
    assert.strictEqual(c._cadence.utilOffWhy('power', []), null);
    F.unload();
  });

  await t('resume (D7): a pause is judged against the load before it, so a user pause next to a paused group is not a bill pause; a real bill pause still is', () => {
    const { cp: c } = F.load(['cp-buildout', 'cp-cadence']);
    const cat = F.board.catalog, dl = F.cottonBidDeals(), st = F.stageA();
    st.items[F.MONEY] = 5e8;                                     // $5M: every bill covered many times
    const runLoad = () => { const v = c._view(st, cat, dl); return v.groups.reduce((a, g) => a + (g.paused ? 0 : (v.bld(g.building).draws?.power ?? 0) * g.count), 0); };
    const mem = F.ctxOf().mem;
    const dec = (o = {}) => c._decide(c._view(st, cat, dl), F.ctxOf({ mem, ...o }));
    const res = (d) => d.actions.find((a) => a.director === 'resume');
    st.groups[8].paused = true; mem('buildout').set({ kilnMine: [8] });   // the Kiln gate paused the Kiln
    st.subscriptions = { 0: { power: runLoad() } };              // Auto utilities sizes to the running groups only
    dec(); dec();
    st.groups[1].paused = true;                                  // the user pauses the Smelters, cash plenty
    let d = dec();
    assert.ok(!(mem('resume').get().bill ?? []).includes(1), JSON.stringify(mem('resume').get()));
    assert.ok(mem('resume').get().user.includes(1));
    st.subscriptions[0].power = runLoad(); d = dec();            // Auto utilities lowers to the new load
    assert.ok(!res(d), 'a user pause is never resumed');
    st.groups[1].paused = false; dec();
    st.items[F.MONEY] = 100; st.groups[1].paused = true; dec();  // cash under 2 bills of the load before: the bill did it
    assert.deepStrictEqual(mem('resume').get().bill, [1]);
  });

  await t('resume (D7): a pause a director sent in the last resumeGraceMin minutes is not a bill pause (its own memory may be written later)', () => {
    const { cp: c } = F.load(['cp-cadence']);
    const cat = F.board.catalog, dl = F.cottonBidDeals(), st = F.stageA();
    const v0 = c._view(st, cat, dl);
    st.subscriptions = { 0: { power: v0.groups.reduce((a, g) => a + (v0.bld(g.building).draws?.power ?? 0) * g.count, 0) } };
    const mem = F.ctxOf().mem, now = 1.8e12;
    const dec = (o = {}) => c._decide(c._view(st, cat, dl), F.ctxOf({ mem, now, ...o }));
    assert.strictEqual(c.cfg.resumeGraceMin, 2);
    dec();
    st.items[F.MONEY] = 100;                                     // bill short
    st.groups[8].paused = true; st.groups[1].paused = true;
    dec({ pauseSent: { 8: now - 30000, 1: now - 5 * 60000 } });  // the Kiln gate sent 8 just now; 1 was a pause sent 5 min ago
    assert.ok(mem('resume').get().user.includes(8), JSON.stringify(mem('resume').get()));
    assert.deepStrictEqual(mem('resume').get().bill, [1]);
  });

  await t('hand-off (B4): no Autopilot stop while browser storage does not save (the stop must be kept once only)', async () => {
    const { cp: c } = F.load(['cp-cadence']);
    const v = c._view(F.stageA(), F.board.catalog, F.cottonBidDeals());
    let stops = 0;
    globalThis.earlyGame = { running: true, stop() { stops++; this.running = false; } };
    const ids = c.ENGINE_ITEMS.map((n) => F.I(n));
    const util = { conf: { power: { on: true }, water: { on: true } }, set() { } };
    const noSave = () => { let o = {}; return { get: () => o, set: (p) => (o = { ...o, ...p }) }; };   // each handle starts empty, like memOf over storage that drops writes
    const d = c._decide(v, F.ctxOf({ mem: noSave, ap: { neverSell: ids, cdBooster: false, running: true }, mods: { autoUtil: util } }));
    assert.ok(!d.actions.some((a) => a.id === 'handoff:stop'), d.actions.map((a) => a.id).join(','));
    assert.ok(d.waits.some((w) => /hand-off: .*browser storage does not save/.test(w)), d.waits.join(' | '));
    assert.strictEqual(stops, 0);
    globalThis.earlyGame = undefined;
  });

  await t('utilities (D1): going Live with power Auto off after Core plan had switched it on, and no ledger line why: your switch-off (sticky); never switched on by it: on', async () => {
    const { cp: c, core: cc } = F.load(['cp-cadence']);
    const st = F.stageA(), cat = F.board.catalog;
    const util = { conf: { power: { on: false }, water: { on: false } }, set(u, on) { if (this.conf[u].on === !!on) return; this.conf[u].on = !!on; cc.ledger.add('AU', 'info', 'Auto ' + u + (on ? ' on' : ' off')); } };
    const mem = F.ctxOf().mem;
    let now = 1.8e12;
    const dec = (o = {}) => c._decide(c._view(st, cat, F.cottonBidDeals()), F.ctxOf({ mem, now, mods: { autoUtil: util }, ...o }));
    const act = (d) => d.actions.find((a) => a.director === 'utilities');
    let a = act(dec()); assert.strictEqual(a?.id, 'utilities:power', 'never on: switched on'); await a.run();
    dec();
    // Core plan stopped; the user switches power off, and the ledger line is gone (cleared, or 300 newer lines) before it goes Live again
    util.set('power', false); cc.ledger.clear();
    now += 3600000;
    const d = dec();
    assert.ok(!act(d), 'not switched on again');
    assert.match((d.readouts.utilities?.alerts ?? []).join(' | '), /Auto power was switched off by you/);
    now += 60000; assert.ok(!act(dec()), 'sticky');
    util.set('power', true); dec();
    assert.ok(!mem('utilities').get().off.power, 'switched on again by the user: forgotten');
  });

  await t('resume (D7) through the runner: a SetPaused a director sent and the server confirmed late is not read as a bill pause', async () => {
    const st = F.stageA(), disk = {};
    globalThis.localStorage = F.mem(disk);
    st.items[F.MONEY] = 100;                                     // cash under 2 bills: any new pause would read as a bill
    const { cp: c2, w } = F.boot(st, { ignore: ['SetPaused'], modules: ['cp-cadence'] });
    c2.cfg.confirmMs = 50; c2.cfg.unlocks = false; c2.cfg.land = false; c2.cfg.handoff = false;
    let sent = false;
    c2.addDirector({ name: 'gate', order: 1, always: true, decide: () => (sent ? null : { action: { id: 'gate', text: 'gate pause', steps: [{ msg: { type: 'SetPaused', group: 8, paused: true }, until: (x) => !!x.groups.find((g) => g.id === 8)?.paused }] } }) });
    c2.start({ dryRun: false });
    await waitFor(() => !c2.active);
    sent = true;
    assert.ok(w.ws.sent.some((m) => m.type === 'SetPaused' && m.group === 8), 'the pause was sent');
    st.groups[8].paused = true;                                  // the server applies it after the confirm window
    await c2._step();
    const mem = JSON.parse(disk['corePlan.v1.mem.resume'] || '{}');
    assert.ok((mem.user ?? []).includes(8) && !(mem.bill ?? []).includes(8), JSON.stringify(mem));
    c2.stop();
    F.unload();
  });

  F.unload();
  done();
})();