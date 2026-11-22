// Stage D ladder director (src/cp-ladder.js): CD need per stage, CD Farm Auto tuning between runs, read-back alert,
// no re-arm after the user's Stop, Stage C pause once, Stage D gates, non-Farm plan alert, and a live run through the runner.
//   cd ic-autopilot && CP_FROM_SRC=1 bun test/cp-ladder-test.js
const assert = require('assert');
const F = require('./cp-fixtures');

const cat = F.stageB.catalog, deals = F.stageB.deals;
const Bc = (n) => F.B(n, cat);
const stB = () => F.liveB();
// Stage C: Assembly Plant in; retail = the Retail Store research is running.
function stC(retail) { const st = F.liveB(); st.unlocked_buildings.push(Bc('Assembly Plant')); st.research = retail ? { building: Bc('Retail Store') } : null; return st; }
// Stage D: the store is built, every Farm demolished.
function stD() {
  const st = stC(false); st.unlocked_buildings.push(Bc('Retail Store'));
  for (const [id, g] of Object.entries(st.groups)) if (g.building === Bc('Farm')) delete st.groups[id];
  st.building_pool[0][Bc('Retail Store')] = 1; delete st.building_pool[0][Bc('Farm')];
  return st;
}
// A fake CD Farm with the 2.8.0 surface the director uses.
function fakeFarm(o = {}) {
  return {
    cfg: { building: 'auto', batch: 10, reserveAcres: 10, pace: 'balanced', land: 'plan', autoStart: true, maxTypes: 2, ...(o.cfg ?? {}) },
    running: false, active: false, calls: [], pauses: 0, drop: o.drop ?? [], _rates: o.rates ?? null, _ev: o.ev ?? null,
    importCfg(x) { if (this.running || this.active) throw new Error('stop the CD Farm run first'); this.calls.push({ ...x.cfg }); for (const [k, val] of Object.entries(x.cfg)) if (!this.drop.includes(k)) this.cfg[k] = val; return { applied: Object.keys(x.cfg), skipped: [] }; },
    pauseAuto() { if (this.cfg.building !== 'auto' || !this.cfg.autoStart) return false; this.cfg.autoStart = false; this.pauses++; return true; },
    rates() { return this._rates ?? { cdh15: null, cdhAll: null }; },
    evaluate() { return this._ev ?? { idle: true, gate: 'G2', reason: 'no CD needed' }; },
  };
}
const dec = (cp, st, ctx) => cp._decide(cp._view(st, cat, deals), ctx);
const act = (d, re) => d.actions.find((a) => a.director === 'ladder' && re.test(a.id));
const lwait = (d) => d.waits.filter((w) => w.startsWith('ladder:')).join(' | ');
// Apply the director's own settings until none is left (so a test starts in sync).
async function sync(cp, st, ctx) { for (let i = 0; i < 4; i++) { const a = act(dec(cp, st, ctx), /^ladder:(tune|seen)/); if (!a) return; await a.run(); } }

(async () => {
  await F.t('cdNeed per stage: A keeps the next unlock, B Retail Store 5,000 banked, C none, D Oil Rig then Refinery', () => {
    const { cp } = F.load(['cp-ladder']);
    const ctx = F.ctxOf({ mods: { cdFarm: fakeFarm() } });
    const a = cp._decide(cp._view(F.stageA(), F.board.catalog, F.cottonBidDeals()), ctx);
    assert.strictEqual(a.stage, 'A');
    assert.strictEqual(a.cdNeed, undefined, 'stage A: the default next unlock (Assembly Plant) stays the need');
    assert.strictEqual(a.nextUnlock.name, 'Assembly Plant');
    const b = dec(cp, stB(), ctx);
    assert.strictEqual(b.stage, 'B');
    assert.deepStrictEqual({ name: b.cdNeed.name, cd: b.cdNeed.cd, ok: b.cdNeed.prereqsMet, b: b.cdNeed.b }, { name: 'Retail Store', cd: 5000, ok: true, b: Bc('Retail Store') });
    const c = dec(cp, stC(true), ctx);
    assert.strictEqual(c.stage, 'C');
    assert.strictEqual(c.cdNeed, false);
    const cb = dec(cp, stC(false), ctx);
    assert.strictEqual(cb.cdNeed.name, 'Retail Store', 'stage C before the Retail research with < 5,000 CD: keep banking');
    assert.match(lwait(cb), /Retail Store research not started, 556 \/ 5,000 CD/);
    const cIn = stC(false); cIn.items[F.CD] = 6000;
    assert.strictEqual(dec(cp, cIn, ctx).cdNeed, false, 'CD in hand: pause');
    const d0 = dec(cp, stD(), ctx);
    assert.strictEqual(d0.stage, 'D');
    assert.strictEqual(d0.cdNeed, false, 'checkpoint not passed: no need');
    const okCtx = F.ctxOf({ retailOk: true, mods: { cdFarm: fakeFarm() } });
    const d1 = dec(cp, stD(), okCtx);
    assert.deepStrictEqual([d1.cdNeed.name, d1.cdNeed.cd], ['Oil Rig', 5000]);
    const sRig = stD(); sRig.research = { building: Bc('Oil Rig') };
    const d2 = dec(cp, sRig, okCtx);
    assert.deepStrictEqual([d2.cdNeed.name, d2.cdNeed.cd, d2.cdNeed.prereqsMet], ['Refinery', 750000, true], 'Oil Rig researching: its CD is spent, farm for the Refinery');
    const sRef = stD(); sRef.unlocked_buildings.push(Bc('Oil Rig')); sRef.research = { building: Bc('Refinery') };
    assert.strictEqual(dec(cp, sRef, okCtx).cdNeed, false, 'Refinery started: nothing left');
    F.unload();
  });

  await F.t('tuning: importCfg only between runs and only with the keys that differ; batch from bestBatch at the measured income', async () => {
    const { cp } = F.load(['cp-ladder']);
    const cf = fakeFarm({ ev: { idle: false, income: 35000000, plan: { units: [] } } });   // $350k/h measured
    const ctx = F.ctxOf({ retailOk: true, mods: { cdFarm: cf } });
    const st = stD();
    const d = dec(cp, st, ctx);
    const a = act(d, /^ladder:tune/);
    assert.ok(a, lwait(d));
    assert.strictEqual(d.readouts.ladder.batch, 16, 'wiki 11.4: $350k/h -> batch 16');
    await a.run();
    assert.deepStrictEqual(cf.calls[0], { land: 'off', pace: 'fast', reserveAcres: 0, batch: 16, maxTypes: 1 }, 'Stage D ladder: pace fast (plan step 1); autoStart already matches: not sent');
    assert.ok(!act(dec(cp, st, ctx), /^ladder:tune/), 'in sync: nothing to apply');
    cf.cfg.land = 'plan';
    const a2 = act(dec(cp, st, ctx), /^ladder:tune/);
    await a2.run();
    assert.deepStrictEqual(cf.calls[1], { land: 'off' }, 'only the changed key');
    cf.cfg.pace = 'balanced'; cf.running = true;
    const d3 = dec(cp, st, ctx);
    assert.ok(!act(d3, /^ladder:tune/), 'a run is on: no importCfg');
    assert.match(lwait(d3), /settings wait for the CD Farm run to end \(pace\)/);
    cf.running = false; cf.active = true;
    assert.ok(!act(dec(cp, st, ctx), /^ladder:tune/), 'a run is still finishing its step');
    cf.active = false;
    const a4 = act(dec(cp, st, ctx), /^ladder:tune/);
    cf.running = true;                                   // a run starts between decide and run(): nothing sent, nothing failed
    assert.strictEqual(await a4.run(), null);
    assert.strictEqual(cf.calls.length, 2);
    cf.running = false;
    assert.strictEqual(await act(dec(cp, st, ctx), /^ladder:tune/).run(), true);
    assert.deepStrictEqual(cf.calls[2], { pace: 'fast' });
    const b = dec(cp, stB(), F.ctxOf({ mods: { cdFarm: fakeFarm({ cfg: { maxTypes: 2 } }) } }));
    assert.ok(!('maxTypes' in b.readouts.ladder.tune), 'maxTypes 1 only in Stage D');
    assert.ok(!('pace' in b.readouts.ladder.tune), 'stage B keeps cfg.ladderPace (balanced)');
    F.unload();
  });

  await F.t('read-back: a setting CD Farm did not take fails once, then shows an alert and is not retried', async () => {
    const { cp } = F.load(['cp-ladder']);
    const cf = fakeFarm({ drop: ['land'] });
    const ctx = F.ctxOf({ mods: { cdFarm: cf } });
    const st = stB();
    const a = act(dec(cp, st, ctx), /^ladder:tune/);
    assert.strictEqual(await a.run(), false, 'counts toward the 3-fail stop once');
    const d = dec(cp, st, ctx);
    assert.ok(!act(d, /^ladder:tune/), 'not re-sent');
    assert.ok(d.readouts.ladder.alerts.some((x) => /CD Farm did not take land/.test(x)), JSON.stringify(d.readouts.ladder.alerts));
    cf.cfg.pace = 'thrifty';                             // the wanted set changes: try again
    assert.ok(act(dec(cp, st, ctx), /^ladder:tune/));
    F.unload();
  });

  await F.t('autoStart: armed once per stage entry, never re-armed after the user turns it off', async () => {
    const { cp } = F.load(['cp-ladder']);
    const cf = fakeFarm({ cfg: { autoStart: false, land: 'off', reserveAcres: 0, batch: 99 } });
    const ctx = F.ctxOf({ mods: { cdFarm: cf } });
    const st = stB();
    const a = act(dec(cp, st, ctx), /^ladder:tune/);
    assert.strictEqual(a.run && (await a.run()), true);
    assert.strictEqual(cf.cfg.autoStart, true);
    assert.ok(cf.calls[0].autoStart);
    cf.cfg.autoStart = false;                            // the user pressed Stop
    const d = dec(cp, st, ctx);
    assert.ok(!act(d, /^ladder:/), 'no re-arm');
    assert.ok(d.readouts.ladder.alerts.some((x) => /does not switch it back on/.test(x)));
    assert.match(lwait(d), /Auto is off while Retail Store needs CD/);
    // Already on at stage entry: it is remembered, so a later Stop is the user's too.
    const cf2 = fakeFarm();
    const ctx2 = F.ctxOf({ mods: { cdFarm: cf2 } });
    await sync(cp, st, ctx2);
    assert.ok(ctx2.mem('ladder').get().onAt, 'seen on: remembered');
    cf2.cfg.autoStart = false;
    assert.ok(!act(dec(cp, st, ctx2), /^ladder:/), 'no re-arm after a Stop of an Auto that was already on');
    // The user's Stop is sticky across stages: neither C-bank nor D (after the checkpoint) turns it back on.
    for (const [s, extra] of [[stC(false), {}], [stD(), { retailOk: true }]]) {
      const dd = dec(cp, s, { ...ctx2, ...extra });
      const tu = act(dd, /^ladder:tune/);
      assert.ok(!tu || !tu.text.includes('autoStart'), dd.actions.map((x) => x.text).join(' | '));
      assert.ok(dd.readouts.ladder.alerts.some((x) => /switched off by you/.test(x)));
    }
    // The user switches it on again: a later need may arm it after a later non-user stop.
    cf2.cfg.autoStart = true; dec(cp, st, ctx2);
    assert.strictEqual(ctx2.mem('ladder').get().off, null, 'switched on: the Stop is forgotten');
    // Building not Auto: nothing is sent at all (batch and reserveAcres steer manual runs too).
    const cf3 = fakeFarm({ cfg: { building: 10, batch: 10, reserveAcres: 10, autoStart: false } });
    const ctx3 = F.ctxOf({ retailOk: true, mods: { cdFarm: cf3 } });
    for (const s of [st, stD()]) {
      const d3 = dec(cp, s, ctx3);
      assert.ok(!d3.actions.some((x) => x.director === 'ladder'), d3.actions.map((x) => x.text).join(' | '));
      assert.ok(d3.readouts.ladder.alerts.some((x) => /not Auto/.test(x)));
    }
    assert.deepStrictEqual([cf3.calls.length, cf3.cfg.batch, cf3.cfg.reserveAcres, cf3.cfg.land], [0, 10, 10, 'plan']);
    F.unload();
  });

  await F.t('stage C: pauseAuto once on entry; the user switching it on again is left alone; same before the checkpoint in D', async () => {
    const { cp } = F.load(['cp-ladder']);
    const cf = fakeFarm();
    const ctx = F.ctxOf({ mods: { cdFarm: cf } });
    const st = stC(true);
    const a = act(dec(cp, st, ctx), /^ladder:pause:C$/);
    assert.ok(a);
    assert.strictEqual(await a.run(), true);
    assert.strictEqual(cf.pauses, 1);
    assert.ok(!act(dec(cp, st, ctx), /^ladder:pause/), 'paused: nothing more');
    cf.cfg.autoStart = true;                             // the user turns Auto on again
    assert.ok(!act(dec(cp, st, ctx), /^ladder:pause/), 'once per stage');
    assert.strictEqual(cf.pauses, 1);
    const dw = act(dec(cp, stD(), ctx), /^ladder:pause:D-wait$/);
    assert.ok(dw, 'stage D before the checkpoint is a new pause');
    F.unload();
  });

  await F.t('stage D gates: each failing precondition says why, and there is no CD need meanwhile', () => {
    const { cp } = F.load(['cp-ladder']);
    const cf = fakeFarm({ cfg: { autoStart: false } });
    const d0 = dec(cp, stD(), F.ctxOf({ mods: { cdFarm: cf } }));
    assert.match(lwait(d0), /retail checkpoint/);
    assert.strictEqual(d0.cdNeed, false);
    const ctx = F.ctxOf({ retailOk: true, mods: { cdFarm: cf } });
    const farms = stD(); farms.building_pool[0][Bc('Farm')] = 3;
    const d1 = dec(cp, farms, ctx);
    assert.match(lwait(d1), /3 Farms owned: the ladder needs 0/);
    assert.strictEqual(d1.cdNeed, false);
    assert.ok(!act(d1, /^ladder:tune/) || !act(d1, /^ladder:tune/).text.includes('autoStart'), 'not armed while a gate fails');
    const tightSt = stD();
    const v = cp._view(tightSt, cat, deals);
    tightSt.land_bought[0] -= v.freeAcres - 5;           // 5 free acres
    const d2 = dec(cp, tightSt, ctx);
    assert.match(lwait(d2), /free acres 5 < batch \d+ \+ spare 0/);
    assert.strictEqual(d2.cdNeed, false);
    const d3 = dec(cp, stD(), ctx);
    assert.strictEqual(d3.cdNeed.name, 'Oil Rig');
    assert.ok(!/Farms owned|free acres/.test(lwait(d3)));
    F.unload();
  });

  await F.t('stage D: alert when the Auto plan is not Farm-only (or Farm + 1 type); T_wall shows measured and model', () => {
    const { cp } = F.load(['cp-ladder']);
    const u = (n, k) => ({ b: Bc(n), name: n, n: k, cd: 1 });
    const run = (units, rates) => dec(cp, stD(), F.ctxOf({ retailOk: true, mods: { cdFarm: fakeFarm({ ev: { idle: false, income: 35000000, plan: { units } }, rates }) } })).readouts.ladder;
    const bad = run([u('Mine', 2), u('Quarry', 2)]);
    assert.ok(bad.alerts.some((x) => /not Farm-only/.test(x) && /2 Mine \+ 2 Quarry/.test(x)), JSON.stringify(bad.alerts));
    assert.ok(run([u('Farm', 10), u('Lumber Camp', 4), u('Mine', 1)]).alerts.some((x) => /not Farm-only/.test(x)), 'three types');
    assert.ok(!run([u('Farm', 16)]).alerts.length);
    assert.ok(!run([u('Farm', 12), u('Lumber Camp', 4)]).alerts.length, 'Farm + 1 type is fine');
    const r = run([u('Farm', 16)], { cdh15: 9600, cdhAll: 8000 });
    assert.deepStrictEqual(r.tWallHours.measured, 78.6);
    assert.strictEqual(r.cdPerHour.measured, 9600);
    assert.ok(r.tWallHours.model > 0 && r.cdPerHour.model > 0, JSON.stringify(r));
    assert.strictEqual(run([u('Farm', 16)], { cdh15: null, cdhAll: 6000 }).cdPerHour.measured, 6000, 'falls back to the whole-run rate');
    F.unload();
  });

  await F.t('live runner (Stage B): one importCfg, read back, then nothing more; the reserve provider names the Retail Store', async () => {
    const st = stB();
    globalThis.localStorage = F.mem();                   // ctx.mem persists through localStorage
    const { core, cp, w } = F.boot(st, { modules: ['cp-ladder'], catalog: cat, deals });
    const cf = fakeFarm({ cfg: { autoStart: false } });
    globalThis.cdFarm = cf;
    cp.cfg.land = false; cp.cfg.unlocks = false;
    cp.start({ dryRun: false });
    await F.waitFor(() => cf.calls.length >= 1 && !cp.active);
    await cp._step(); await cp._step();
    assert.strictEqual(cf.calls.length, 1, JSON.stringify(cf.calls));
    assert.strictEqual(cf.cfg.land, 'off');
    assert.strictEqual(cf.cfg.autoStart, true);
    assert.strictEqual(w.ws.sent.length, 0, 'nothing on the socket');
    assert.match(core.ledger.text(), /CD Farm settings: autoStart true/);
    assert.strictEqual(core.reserves.merged().nextTech.name, 'Retail Store');
    assert.strictEqual(core.reserves.merged().nextTech.cd, 5000);
    assert.strictEqual(cp.status().readouts.ladder.phase, 'B');
    cf.cfg.autoStart = false;                            // the user's Stop
    await cp._step(); await cp._step();
    assert.strictEqual(cf.calls.length, 1, 'not re-armed');
    assert.strictEqual(cf.cfg.autoStart, false);
    cp.stop(); F.unload();
  });

  await F.t('live runner (Stage C): pauseAuto once, dry run sends nothing', async () => {
    const st = stC(true);
    globalThis.localStorage = F.mem();
    const { cp } = F.boot(st, { modules: ['cp-ladder'], catalog: cat, deals });
    const cf = fakeFarm({ cfg: { land: 'off', reserveAcres: 0 } });
    globalThis.cdFarm = cf;
    cp.cfg.land = false; cp.cfg.unlocks = false;
    cp.start();
    await cp._step(); await cp._step();
    assert.strictEqual(cf.pauses, 0, 'dry run');
    assert.strictEqual(cf.calls.length, 0, 'dry run');
    cp.start({ dryRun: false });
    await F.waitFor(() => cf.pauses >= 1 && !cp.active);
    for (let i = 0; i < 4; i++) await cp._step();
    assert.strictEqual(cf.pauses, 1);
    assert.strictEqual(core_reserve_need(), null);
    cp.stop(); F.unload();
  });

  await F.t('stage D gates mid-cycle: Farms and acres a CD Farm run holds do not drop the need', () => {
    const { cp } = F.load(['cp-ladder']);
    const farm = Bc('Farm');
    const mk = () => { const s = stD(); const v = cp._view(s, cat, deals); s.land_bought[0] -= v.freeAcres - 85; s.building_pool[0][farm] = 16; return s; };
    const cf = fakeFarm(); cf.running = true; cf.farmUnits = { [farm]: 16 };
    const d = dec(cp, mk(), F.ctxOf({ retailOk: true, mods: { cdFarm: cf } }));
    assert.strictEqual(d.cdNeed && d.cdNeed.name, 'Oil Rig', lwait(d));
    assert.ok(!/Farms owned|free acres/.test(lwait(d)), lwait(d));
    cf.running = false; cf.active = true;                // finishing its last step
    assert.strictEqual(dec(cp, mk(), F.ctxOf({ retailOk: true, mods: { cdFarm: cf } })).cdNeed.name, 'Oil Rig');
    // No run: Farms in the pool are owned ones, the gate holds.
    const idle = fakeFarm(); idle.farmUnits = {};
    const d2 = dec(cp, mk(), F.ctxOf({ retailOk: true, mods: { cdFarm: idle } }));
    assert.strictEqual(d2.cdNeed, false);
    assert.match(lwait(d2), /16 Farms owned/);
    F.unload();
  });

  await F.t('re-arm: Alt+Shift+X and its own error stop wait for the next Live session; the user Stop never re-arms', async () => {
    const { cp } = F.load(['cp-ladder']);
    const L = globalThis.idleCore.ledger;
    const now = Date.now() - 600000;   // ledger lines are stamped with the real clock, after the arm
    for (const [line, why] of [['Auto switched off (stop all)', 'pause'], ['Auto switched off after 3 errors in a row; switch it on again to retry', 'error'], ['Auto switched off because you stopped it', 'user']]) {
      const cf = fakeFarm({ cfg: { autoStart: false, land: 'off', reserveAcres: 0, batch: 16, maxTypes: 1, pace: 'fast' } });
      const mem = F.ctxOf().mem;
      const ctx = (o = {}) => F.ctxOf({ retailOk: true, now, mem, mods: { cdFarm: cf }, ...o });
      const a = act(dec(cp, stD(), ctx()), /^ladder:tune/);
      assert.ok(a && a.text.includes('autoStart true'), why);
      assert.strictEqual(await a.run(), true);
      cf.cfg.autoStart = false; L.add('CD', 'info', line);
      const d = dec(cp, stD(), ctx({ now: now + 5000 }));
      assert.strictEqual(mem('ladder').get().off.why, why);
      assert.ok(!act(d, /^ladder:tune/), why + ': not re-armed in the same Live session');
      dec(cp, stD(), ctx({ now: now + 10000, live: false, dryRun: true }));   // reload: back as a dry run
      const r = act(dec(cp, stD(), ctx({ now: now + 70000 })), /^ladder:tune/);   // the live-resume countdown passed
      if (why === 'user') assert.ok(!r, 'the user Stop is never re-armed');
      else assert.ok(r && r.text.includes('autoStart true'), why + ': re-armed after Live resumes');
    }
    F.unload();
  });

  await F.t('read-back: a rejected key is dropped per key, so a moving batch does not re-send it and pile up fails', async () => {
    const { cp } = F.load(['cp-ladder']);
    const cf = fakeFarm({ drop: ['land'], cfg: { pace: 'fast', reserveAcres: 0, maxTypes: 1 } });
    const ctx = F.ctxOf({ retailOk: true, mods: { cdFarm: cf } });
    const res = [];
    for (const inc of [35000000, 50000000, 35000000, 50000000, 36000000, 51000000]) {
      cf._ev = { idle: false, income: inc, plan: { units: [] } };
      const a = act(dec(cp, stD(), ctx), /^ladder:tune/);
      res.push(a ? await a.run() : 'none');
      if (a && res.length > 1) assert.ok(!/land/.test(a.text), a.text);
    }
    assert.strictEqual(res.filter((x) => x === false).length, 1, JSON.stringify(res));
    const d = dec(cp, stD(), ctx);
    assert.ok(d.readouts.ladder.alerts.some((x) => /did not take land off/.test(x)));
    // batch moves by 2 or more only
    const cf2 = fakeFarm({ cfg: { pace: 'fast', reserveAcres: 0, maxTypes: 1, land: 'off', batch: 16 }, ev: { idle: false, income: 36000000, plan: { units: [] } } });
    const d2 = dec(cp, stD(), F.ctxOf({ retailOk: true, mods: { cdFarm: cf2 } }));
    assert.ok(!act(d2, /^ladder:tune/), 'batch ' + d2.readouts.ladder.batch + ' vs 16: within 1, not sent');
    F.unload();
  });

  F.done();
})();
function core_reserve_need() { return globalThis.idleCore.reserves.merged()?.nextTech ?? null; }