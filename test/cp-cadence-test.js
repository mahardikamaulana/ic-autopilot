// Tests for src/cp-cadence.js: slot, sell, cadence, offline, canSaveDesign, endgame.
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
  const { cp } = F.load(['cp-cadence']);
  const X = cp._cadence;

  await t('directors load; endgame is off by default', () => {
    for (const n of ['slot', 'sell', 'cadence', 'endgame']) assert.ok(cp.directors().includes(n), n);
    assert.strictEqual(cp.cfg.dir_endgame, false);
    assert.strictEqual(typeof cp.offline, 'function');
    const d = cp._decide(view(cp, plain()), F.ctxOf({ tick: T0 }));
    assert.ok(d.waits.includes('endgame: off'), d.waits.join(' | '));
    assert.ok(!d.actions.some((a) => a.director === 'endgame'));
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
    const { cp: c2, w } = F.boot(st, { deals, catalog: CAT, modules: ['cp-cadence'] });
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
    const { cp: c2, w } = F.boot(st, { deals, catalog: CAT, modules: ['cp-cadence'], ignore: ['KeepFilling'] });
    assert.deepStrictEqual(c2.importCfg({ land: false, unlocks: false, handoff: false, dir_sell: false, dir_cadence: false, confirmMs: 30 }).skipped, []);
    c2.start({ dryRun: false });
    for (let i = 0; i < 4 && c2.running; i++) { await waitFor(() => !c2.active); await c2._step(); }
    assert.strictEqual(c2.running, false, 'stopped after 3 unconfirmed sends');
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'KeepFilling').length, 3);
    F.unload();
  });

  // ---- sell -------------------------------------------------------------------------------------------------------------
  const { cp: cpS } = F.load(['cp-cadence']);
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
    const as = { jobs: () => jobs, start: (o) => { started.push(o); jobs.push({ deal: o.deal, item: deals.find((d) => d.id === o.deal).item, keep: o.keep, left: o.total, fullLoads: o.fullLoads }); return o.deal; }, stop() {} };
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
    const as = { jobs: () => jobs, start: (o) => { started.push(o); jobs[0].keep = o.keep; return o.deal; }, stop() {} };
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
  await t('sell: a job autoSell ended by itself cools down before that bid is tried again', () => {
    const st = sellSt(), deals = sellDeals();
    const mm = F.ctxOf().mem; mm('sell').set({ mine: [41] });
    const as = { jobs: () => [], start() {}, stop() {} };
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
    const mm = F.ctxOf().mem, quiet = () => {};
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
    const { cp: c2 } = F.boot(st, { deals: [], catalog: CAT, modules: ['cp-cadence'] });
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
    const { cp: cpO, core } = F.load(['cp-cadence']);
    const mm = F.ctxOf().mem;
    cpO._decide(view(cpO, st), F.ctxOf({ tick: T0, mem: mm, retailOk: true }));
    core.walk = () => ({ st, catalog: CAT, deals: [] });
    assert.deepStrictEqual(cpO.offline(10).sends, [{ type: 'StartTech', building: B('Oil Rig'), region: 0 }]);
    cpO._decide(view(cpO, st), F.ctxOf({ tick: T0, mem: mm, retailOk: null }));
    assert.deepStrictEqual(cpO.offline(10).sends, []);
    // A failed checkpoint is still decided: the live plan starts the Oil Rig, and so does the offline plan.
    for (const premium of [true, false]) {
      p = XS.offlinePlan(view(cpS, st), 10, { premium, retailOk: false, retailDecided: true });
      assert.deepStrictEqual(p.sends, [{ type: 'StartTech', building: B('Oil Rig'), region: 0 }], 'failed checkpoint, premium ' + premium);
    }
    cpO._decide(view(cpO, st), F.ctxOf({ tick: T0, mem: mm, retailOk: false, retailDecided: true }));
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

  // ---- endgame ------------------------------------------------------------------------------------------------------------------
  await t('endgame: StartTech Refinery once E1-E5 hold, 750,000 CD and 6 Wired Frames are in hand', () => {
    const st = plain();
    st.research = null; st.unlocked_buildings = [...st.unlocked_buildings, B('Assembly Plant'), B('Retail Store'), B('Oil Rig')];
    st.items[F.CD] = 800000; st.stock[0][I('Wired Frame')] = 6;
    const v = view(cpS, st);
    let out = { finished: false, E: [{ ok: false }] };
    assert.ok(!XS.endgameDecide(v, F.ctxOf(), out).action, 'not before E1-E5');
    out = { finished: true, E: [] };
    const r = XS.endgameDecide(v, F.ctxOf(), out);
    assert.deepStrictEqual(r.action.steps[0].msg, { type: 'StartTech', building: B('Refinery'), region: 0 });
    assert.strictEqual(out.cdNeed.name, 'Refinery');
    assert.deepStrictEqual(r.readout.checklist.map((c) => c.item), ['Iron Frame', 'Wired Frame', 'Copper Wire', 'Copper Ore']);
    st.stock[0][I('Wired Frame')] = 5;
    assert.match(XS.endgameDecide(view(cpS, st), F.ctxOf(), { finished: true }).wait, /1 more Wired Frame/);
    st.stock[0][I('Wired Frame')] = 6; st.items[F.CD] = 700000;
    assert.ok(!XS.endgameDecide(view(cpS, st), F.ctxOf(), { finished: true }).action);
    // Switched on, the director runs inside decide (and waits, since this corp is not at the end).
    cpS.importCfg({ dir_endgame: true });
    const d = cpS._decide(view(cpS, plain()), F.ctxOf({ tick: T0 }));
    assert.ok(!d.waits.includes('endgame: off'));
    assert.ok(d.waits.some((w) => /^endgame: end conditions/.test(w)), d.waits.join(' | '));
    cpS.importCfg({ dir_endgame: false });
  });

  F.unload();
  done();
})();