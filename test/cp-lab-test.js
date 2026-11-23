// Tests for the Core plan "lab" director (src/cp-lab.js): Lab group, Tier I Lab preset through the Lab runner's API, module installer.
//   CP_FROM_SRC=1 bun test/cp-lab-test.js
const assert = require('assert');
const F = require('./cp-fixtures');
const { t, B, I, Rc } = F;
const SB = F.stageB.catalog;

// Stage A plus furniture Workshops and a set of free modules.
function withModules(defs, extraGroups = {}) {
  const st = F.stageA();
  st.groups[11] = { building: B('Workshop'), region: 0, count: 3, recipe: Rc('Make Bookshelf'), modules: {} };
  st.groups[12] = { building: B('Workshop'), region: 0, count: 1, recipe: Rc('Make Table'), modules: {} };
  Object.assign(st.groups, extraGroups);
  st.next_group_id = 20;
  st.module_defs = Object.fromEntries(defs.map((d) => [d.id, d]));
  return st;
}
const OC = (id, quirks = []) => ({ id, kind: 61, name: 'Overclock #' + id, ticks_bonus: 5, inputs_bonus: 1, neighbor_pct: 0, quirks });
const RF = (id, quirks = []) => ({ id, kind: 62, name: 'Refiner #' + id, ticks_bonus: -4, inputs_bonus: -1, neighbor_pct: 1, quirks });
const CORNER = [{ kind: 'CornerTuned', cell: '1,-1', elsewhere_pct: 48 }];
const labOf = (d) => d.actions.filter((a) => a.director === 'lab');
const decideA = (cp, st, ctx = F.ctxOf()) => cp._decide(cp._view(st, F.board.catalog, F.cottonBidDeals()), ctx);
const inB = (st) => { st.research = { building: B('Assembly Plant') }; return st; };   // Stage B: the Assembly Plant research is running
const inC = (st) => { st.unlocked_buildings.push(B('Assembly Plant')); return st; };   // Stage C: the Assembly Plant is unlocked
const installs = (d) => labOf(d).filter((a) => a.steps?.[0]?.msg.type === 'InstallModule').map((a) => a.steps[0].msg);

// A fake Lab runner with the parts of labRunner's API the director uses.
function fakeLab({ running = true, dryRun = true, mode = 'process', list = [], stopReason = '', goLive = true, stuck = false } = {}) {
  const lr = {
    cfg: { mode, dryRun, list, tierMode: 'best' }, running, active: running, stopReason, calls: [],
    stop() { this.calls.push('stop'); if (this.running) this.stopReason = 'stopped by you'; this.running = false; if (!stuck) setTimeout(() => { this.active = false; }, 30); },
    start(o) {
      this.calls.push(['start', o]);
      if (this.running || this.active) return;
      for (const [k, v] of Object.entries(o)) this.cfg[k] = v;
      if (!goLive) this.cfg.dryRun = true;   // e.g. Live refused because the game data changed
      this.running = true; this.active = true; this.stopReason = '';
    },
  };
  return lr;
}

(async () => {
  await t('the director loads from src and adds its settings', () => {
    const { cp } = F.load(['cp-lab']);
    assert.ok(cp.directors().includes('lab'), 'lab director registered');
    for (const k of ['labPreset', 'labGroup', 'labModules', 'modulesStackOk']) assert.ok(k in cp.cfg, k);
    assert.strictEqual(cp.cfg.modulesStackOk, false);
    F.unload();
  });

  await t('install table: Overclock to Fell Wood, Refiner to the bigger furniture Workshop, Insightful to the Lab, unknown kinds manual', () => {
    const { cp } = F.load(['cp-lab']);
    const st = withModules([OC(0), RF(1), OC(2, [{ kind: 'Insightful', pct: 5 }]), { id: 3, kind: 99, name: 'Odd', quirks: [] }]);
    const L = cp._lab;
    const v = cp._view(st, F.board.catalog, []);
    assert.deepStrictEqual(L.freeModules(v).map((d) => d.id), [0, 1, 2, 3], 'module id 0 counts as a module');
    const p = L.planInstall(v, cp.cfg);
    assert.strictEqual(p.install.d.id, 0); assert.strictEqual(p.install.g.id, 5); assert.strictEqual(p.install.cell, '0,-1');
    // Walk the whole table by installing each pick in turn.
    const placed = {};
    for (let k = 0; k < 4; k++) {
      const q = L.planInstall(cp._view(st, F.board.catalog, []), cp.cfg);
      if (!q.install) { assert.match(q.notes.join(' '), /Odd .*kind 99.*by hand/); break; }
      st.groups[q.install.g.id].modules = { ...(st.groups[q.install.g.id].modules ?? {}), [q.install.cell]: q.install.d.id };
      placed[q.install.d.id] = q.install.g.id;
    }
    assert.deepStrictEqual(placed, { 0: 5, 1: 11, 2: 9 });
    F.unload();
  });

  await t('an Overclock never lands on a Workshop, whatever the groups', () => {
    const { cp } = F.load(['cp-lab']);
    const st = withModules([OC(0), OC(1), OC(4)]);
    delete st.groups[5];   // no Fell Wood group: only Workshops (furniture, Rivet, Frame Timber) are left
    st.groups[13] = { building: B('Workshop'), region: 0, count: 50, recipe: Rc('Fell Wood'), modules: {} };   // even a Workshop on a Fell Wood id
    const d = decideA(cp, st);
    assert.deepStrictEqual(installs(d), []);
    assert.match(cp._decide(cp._view(st, F.board.catalog, F.cottonBidDeals()), F.ctxOf()).readouts.lab.modules.join(' '), /no Fell Wood group yet/);
    F.unload();
  });

  await t('no install past 6 sockets, even with stacking confirmed', () => {
    const { cp } = F.load(['cp-lab']);
    const others = [10, 11, 12, 13, 14, 15].map((id) => ({ id, kind: 70, name: 'Other ' + id, quirks: [] }));
    const st = withModules([OC(0), ...others]);
    st.groups[5].modules = Object.fromEntries(cp._lab.CELLS.map((c, i) => [c, 10 + i]));
    cp.cfg.modulesStackOk = true;
    const d = decideA(cp, st);
    assert.deepStrictEqual(installs(d), []);
    assert.match(d.readouts.lab.modules.join(' '), /all 6 sockets full/);
    F.unload();
  });

  await t('no re-install: modules in a group or a fleet socket are not free (object and array fleet shapes, id 0)', () => {
    const { cp } = F.load(['cp-lab']);
    const st = withModules([OC(0), OC(1), RF(2)]);
    st.groups[5].modules = { '0,1': { id: 0 } };   // installed, object form
    st.fleet_modules = { 0: 1 };                     // in a fleet socket
    st.groups[11].modules = { '-1,0': 2 };
    cp.cfg.modulesStackOk = true;
    assert.deepStrictEqual(cp._lab.freeModules(cp._view(st, F.board.catalog, [])).map((d) => d.id), []);
    assert.deepStrictEqual(installs(decideA(cp, st)), []);
    st.fleet_modules = [1];
    assert.deepStrictEqual(cp._lab.freeModules(cp._view(st, F.board.catalog, [])).map((d) => d.id), []);
    F.unload();
  });

  await t('a quirk cell is respected: CornerTuned goes into "1,-1", the next group when taken, nowhere when all are taken', () => {
    const { cp } = F.load(['cp-lab']);
    const st = withModules([RF(0, CORNER), { id: 9, kind: 70, name: 'Other', quirks: [] }]);
    let m = installs(decideA(cp, st));
    assert.deepStrictEqual(m, [{ type: 'InstallModule', group: 11, cell: '1,-1', module: 0 }]);
    st.groups[11].modules = { '1,-1': 9 };
    m = installs(decideA(cp, st));
    assert.deepStrictEqual(m, [{ type: 'InstallModule', group: 12, cell: '1,-1', module: 0 }], 'never another cell of the big group');
    st.groups[12].modules = { '1,-1': 9 };
    const d = decideA(cp, st);
    assert.deepStrictEqual(installs(d), []);
    assert.match(d.readouts.lab.modules.join(' '), /cell 1,-1 \(CornerTuned\) is taken/);
    F.unload();
  });

  await t('stacking pause (R2): no second Overclock on a group until modulesStackOk; installs are recorded in mem', () => {
    const { cp } = F.load(['cp-lab']);
    const st = withModules([OC(0), OC(1)]);
    st.groups[5].modules = { '0,-1': 0 };
    const ctx = F.ctxOf();
    const d = decideA(cp, st, ctx);
    assert.deepStrictEqual(installs(d), []);
    assert.match(d.readouts.lab.modules.join(' '), /already has a Overclock: stacking is unverified.*modulesStackOk/);
    assert.ok(d.waits.some((w) => /^lab: modules: .*stacking/.test(w)), 'the pause is a wait, not silent');
    assert.deepStrictEqual(ctx.mem('lab').get().installs, [{ module: 0, group: 5, kind: 61, cell: '0,-1', at: ctx.now }]);
    cp.cfg.modulesStackOk = true;
    assert.deepStrictEqual(installs(decideA(cp, st, ctx)), [{ type: 'InstallModule', group: 5, cell: '1,-1', module: 1 }]);
    F.unload();
  });

  await t('live Stage B snapshot: CreateGroup for the pooled Lab; the Refiner waits (no furniture Workshop), never on Frame Timber', () => {
    const { cp } = F.load(['cp-lab']);
    cp.cfg.labTarget = 1;   // the second Lab (which may buy its acres) is D2's test
    const st = F.liveB();
    const d = cp._decide(cp._view(st, SB, F.stageB.deals), F.ctxOf());
    assert.strictEqual(d.stage, 'B');
    const mine = labOf(d);
    assert.strictEqual(mine.length, 1, 'one action per step');
    assert.deepStrictEqual(mine[0].steps[0].msg, { type: 'CreateGroup', building: B('Manufacturing Lab', SB), amount: 1, name: 'Manufacturing Lab', region: 0 });
    assert.ok(!d.actions.some((a) => a.steps?.some((s) => s.msg.type === 'InstallModule')));
    assert.match(d.readouts.lab.modules.join(' '), /Refiner Module Mk1: no furniture Workshop group yet/);
    assert.match(d.readouts.lab.manual.join(' '), /adopt by hand/);
    assert.match(d.readouts.lab.manual.join(' '), /Module Exchange/);
    // With a Lab group already there, nothing is created again.
    st.groups[13] = { building: B('Manufacturing Lab', SB), region: 0, count: 1, recipe: null, modules: {} }; st.building_pool[0][B('Manufacturing Lab', SB)] = 0;
    assert.strictEqual(labOf(cp._decide(cp._view(st, SB, F.stageB.deals), F.ctxOf())).length, 0);
    // A Refiner with its quirk cell goes to a furniture Workshop once one exists, never to the Frame Timber ones (3, 8).
    st.groups[14] = { building: B('Workshop', SB), region: 0, count: 2, recipe: Rc('Make Chair', SB), modules: {} };
    const m = labOf(cp._decide(cp._view(st, SB, F.stageB.deals), F.ctxOf()))[0].steps[0].msg;
    assert.deepStrictEqual(m, { type: 'InstallModule', group: 14, cell: '1,-1', module: 0 });
    F.unload();
  });

  await t('runner: InstallModule is sent once and the fake server puts it in group.modules', async () => {
    const st = withModules([OC(0)]);
    st.items[F.MONEY] = 1;   // no land money
    const { cp, w } = F.boot(st, { modules: ['cp-lab'] });
    cp.cfg.land = false; cp.cfg.unlocks = false;
    cp.start({ dryRun: false });
    await F.waitFor(() => w.ws.sent.some((m) => m.type === 'InstallModule'));
    await F.waitFor(() => !cp.active);
    assert.deepStrictEqual(st.groups[5].modules, { '0,-1': 0 });
    await cp._step(); await cp._step();
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'InstallModule').length, 1, 'not sent twice');
    cp.stop(); F.unload();
  });

  await t('runner on the live snapshot: CreateGroup applied, then nothing more to send for the Lab group', async () => {
    const st = F.liveB();
    const { cp, w } = F.boot(st, { modules: ['cp-lab'], catalog: SB, deals: F.stageB.deals });
    cp.cfg.land = false; cp.cfg.unlocks = false; cp.cfg.labTarget = 1;   // the second Lab is D2's test
    cp.start({ dryRun: false });
    await F.waitFor(() => w.ws.sent.some((m) => m.type === 'CreateGroup'));
    await F.waitFor(() => !cp.active);
    const g = Object.values(st.groups).find((x) => x.building === B('Manufacturing Lab', SB));
    assert.ok(g && g.count === 1);
    await cp._step(); await cp._step();
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'CreateGroup').length, 1);
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'InstallModule').length, 0);
    cp.stop(); F.unload();
  });

  await t('chaos: an InstallModule the server ignores is never counted as done, and three in a row stop Core plan', async () => {
    const st = withModules([OC(0)]);
    st.items[F.MONEY] = 1;
    const { core, cp, w } = F.boot(st, { modules: ['cp-lab'], ignore: ['InstallModule'] });
    cp.cfg.land = false; cp.cfg.unlocks = false; cp.cfg.confirmMs = 150; cp.cfg.intervalMs = 20;
    cp.start({ dryRun: false });
    await F.waitFor(() => !cp.running, 6000);
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'InstallModule').length, 3);
    assert.deepStrictEqual(st.groups[5].modules ?? {}, {});
    assert.match(core.ledger.text(), /not confirmed: install Overclock #0/);
    F.unload();
  });

  await t('Lab preset: dry-run Lab runner while Core plan is live -> restart live on the Tier I list through its API', async () => {
    const { cp } = F.load(['cp-lab']);
    const st = F.stageA();
    const lr = fakeLab();
    const ctx = F.ctxOf({ mods: { labRunner: lr } });
    const d = decideA(cp, st, ctx);
    assert.match(d.readouts.lab.alert, /ALERT: the Lab runner is a dry run while Core plan is live/);
    const a = labOf(d).find((x) => x.id === 'lab:preset');
    assert.ok(a && typeof a.run === 'function');
    assert.strictEqual(await a.run(), true);
    assert.strictEqual(lr.calls[0], 'stop');
    const o = lr.calls[1][1];
    assert.deepStrictEqual(o, { dryRun: false, mode: 'list', list: [
      { product: I('Bookshelf'), focus: 2, tier: 1 }, { product: I('Planks'), focus: 0, tier: 1 }, { product: I('Table'), focus: 2, tier: 1 }, { product: I('Chair'), focus: 2, tier: 1 }] });
    assert.ok(lr.running && !lr.cfg.dryRun);
    const d2 = decideA(cp, st, ctx);
    assert.ok(!labOf(d2).some((x) => x.id === 'lab:preset'), 'gone once applied');
    assert.strictEqual(d2.readouts.lab.alert, undefined);
    assert.strictEqual(ctx.mem('lab').get().selfStop, undefined, 'the self-stop marker is never saved');
    assert.ok(ctx.mem('lab').get().applied, 'what was applied is remembered');
    F.unload();
  });

  await t('Lab preset: only when live; an explicit stop is respected; a reload (no stop reason) is re-armed; failures back off', async () => {
    const { cp } = F.load(['cp-lab']);
    const st = F.stageA();
    // Core plan in dry run: readout only.
    let lr = fakeLab();
    let d = decideA(cp, st, F.ctxOf({ live: false, dryRun: true, mods: { labRunner: lr } }));
    assert.ok(!labOf(d).length); assert.match(d.readouts.lab.alert, /dry run/); assert.match(d.readouts.lab.preset, /once Core plan runs live/);
    // Stopped by the user.
    lr = fakeLab({ running: false, stopReason: 'stopped by you' });
    d = decideA(cp, st, F.ctxOf({ mods: { labRunner: lr } }));
    assert.ok(!labOf(d).length); assert.match(d.readouts.lab.alert, /stopped \(stopped by you\)/);
    // After a reload: not running, no stop reason -> start (no stop call).
    lr = fakeLab({ running: false });
    const ctx = F.ctxOf({ mods: { labRunner: lr } });
    d = decideA(cp, st, ctx);
    assert.strictEqual(await labOf(d)[0].run(), true);
    assert.strictEqual(lr.calls[0][0], 'start');
    // Already live on the list: nothing.
    assert.ok(!labOf(decideA(cp, st, ctx)).length);
    // Live refused (comes back dry): null (not a Core plan failure), then alert only while it stays a dry run; re-armed after a reload.
    lr = fakeLab({ running: false, goLive: false });
    const c2 = F.ctxOf({ mods: { labRunner: lr } });
    assert.strictEqual(await labOf(decideA(cp, st, c2))[0].run(), null);
    for (const dt of [60000, 11 * 60000, 30 * 60000]) {
      d = decideA(cp, st, { ...c2, now: c2.now + dt });
      assert.ok(!labOf(d).length, 'no retry while refused'); assert.match(d.readouts.lab.alert, /refuses Live/);
    }
    lr.running = false; lr.active = false; lr.stopReason = '';   // a reload
    assert.strictEqual(labOf(decideA(cp, st, c2)).length, 1);
    // Preset switched off: still an alert, no action.
    cp.cfg.labPreset = false;
    d = decideA(cp, st, F.ctxOf({ mods: { labRunner: fakeLab() } }));
    assert.ok(!labOf(d).length); assert.match(d.readouts.lab.alert, /dry run while Core plan is live/);
    F.unload();
  });

  await t('runner: the preset run() goes through the real step loop and the Lab runner ends up live', async () => {
    const st = F.stageA(); st.items[F.MONEY] = 1;
    const { core, cp, w } = F.boot(st, { modules: ['cp-lab'] });
    const lr = fakeLab();
    globalThis.labRunner = lr;   // after boot (boot clears it)
    cp.cfg.land = false; cp.cfg.unlocks = false;
    cp.start({ dryRun: false });
    await F.waitFor(() => lr.running && !lr.cfg.dryRun);
    await F.waitFor(() => !cp.active);
    assert.strictEqual(lr.cfg.mode, 'list');
    assert.match(core.ledger.text(), /Lab runner: restart live on the Tier I list/);
    await cp._step();
    assert.strictEqual(lr.calls.filter((c) => c[0] === 'start').length, 1, 'started once');
    assert.strictEqual(w.ws.sent.length, 0);
    cp.stop(); F.unload();
  });

  await t('Lab preset: a live Lab runner on any other setting is left alone (process, modules, an edited list)', () => {
    const { cp } = F.load(['cp-lab']);
    const st = F.stageA();
    const edited = [{ product: I('Planks'), focus: 0, tier: 1 }, { product: I('Table'), focus: 2, tier: 1 }, { product: I('Chair'), focus: 2, tier: 1 }];
    for (const o of [{ mode: 'process' }, { mode: 'modules' }, { mode: 'list', list: edited }]) {
      const lr = fakeLab({ dryRun: false, ...o });
      const d = decideA(cp, st, F.ctxOf({ mods: { labRunner: lr } }));
      assert.ok(!labOf(d).some((x) => x.id === 'lab:preset'), 'no preset for ' + o.mode);
      assert.match(d.readouts.lab.preset, /own setting/);
      assert.strictEqual(d.readouts.lab.alert, undefined);
      assert.deepStrictEqual(lr.calls, []);
    }
    F.unload();
  });

  await t('Lab preset: after a reload with your edited list, it restarts live on your list, not the preset', async () => {
    const { cp } = F.load(['cp-lab']);
    const st = F.stageA();
    const ctx = F.ctxOf({ mods: { labRunner: fakeLab({ running: false }) } });
    assert.strictEqual(await labOf(decideA(cp, st, ctx)).find((x) => x.id === 'lab:preset').run(), true);   // the preset was applied once
    const edited = [{ product: I('Planks'), focus: 0, tier: 1 }, { product: I('Table'), focus: 2, tier: 1 }];
    const lr = fakeLab({ running: true, dryRun: true, mode: 'list', list: edited });   // reload: list kept, dry again
    const c2 = { ...ctx, mods: { labRunner: lr } };
    const a = labOf(decideA(cp, st, c2)).find((x) => x.id === 'lab:preset');
    assert.match(a.text, /your own setting/);
    assert.strictEqual(await a.run(), true);
    assert.deepStrictEqual(lr.calls[1], ['start', { dryRun: false }]);
    assert.deepStrictEqual(lr.cfg.list, edited);
    // A reload still on the preset list restarts on the preset.
    const lr3 = fakeLab({ running: false, mode: 'list', list: cp._lab.presetList(cp._view(st, F.board.catalog, [])) });
    assert.match(labOf(decideA(cp, st, { ...ctx, mods: { labRunner: lr3 } }))[0].text, /Tier I list/);
    F.unload();
  });

  await t('Lab preset: when the runner is slow to stop, our own stop is not taken for yours, and nothing is saved as a self-stop', async () => {
    const { cp } = F.load(['cp-lab']);
    const st = F.stageA();
    Object.assign(cp._lab.timing, { pollMs: 5, polls: 3 });
    const lr = fakeLab({ stuck: true });
    const ctx = F.ctxOf({ mods: { labRunner: lr } });
    assert.strictEqual(await labOf(decideA(cp, st, ctx)).find((x) => x.id === 'lab:preset').run(), null);
    assert.strictEqual(lr.stopReason, 'stopped by you');
    assert.strictEqual(ctx.mem('lab').get().selfStop, undefined);
    lr.active = false;   // the step finally ends
    const failAt = ctx.mem('lab').get().presetFailAt;
    let d = decideA(cp, st, { ...ctx, now: failAt + 60000 });
    assert.ok(!labOf(d).length); assert.match(d.readouts.lab.preset, /failed recently/);
    d = decideA(cp, st, { ...ctx, now: failAt + 11 * 60000 });
    assert.strictEqual(labOf(d).length, 1, 're-armed, not "stopped by you"');
    assert.ok(await labOf(d)[0].run());
    assert.ok(lr.running && !lr.cfg.dryRun);
    F.unload();
  });

  await t('runner: a Lab runner that refuses Live never stops Core plan (no fail count)', async () => {
    const st = F.stageA(); st.items[F.MONEY] = 1;
    const { cp } = F.boot(st, { modules: ['cp-lab'] });
    const lr = fakeLab({ goLive: false });
    globalThis.labRunner = lr;
    cp.cfg.land = false; cp.cfg.unlocks = false; cp.cfg.intervalMs = 20;
    cp.start({ dryRun: false });
    await F.waitFor(() => lr.calls.some((c) => c[0] === 'start'));
    await F.waitFor(() => !cp.active);
    for (let k = 0; k < 5; k++) await cp._step();
    assert.ok(cp.running, 'Core plan still running');
    assert.strictEqual(lr.calls.filter((c) => c[0] === 'start').length, 1, 'tried once');
    cp.stop(); F.unload();
  });

  await t('stacking (R2) is a manual duty, and the installs readout shows the expected effect', () => {
    const { cp } = F.load(['cp-lab']);
    const st = withModules([OC(0)]);
    st.groups[5].modules = { '0,-1': 0 };
    const d = decideA(cp, st);
    assert.match(d.readouts.lab.installs.join(' '), /Overclock #0 on group 5 cell 0,-1 \(expected speed \+25% - ticks_bonus 5\)/);
    const mine = globalThis.corePlan.duties().flat(Infinity).find((x) => /stacking/.test(x?.duty ?? ''));
    assert.ok(mine && mine.owner === 'you' && mine.done === false, 'manual stacking duty');
    F.unload();
  });

  await t('D2: second Lab: bought with 1 Lab, the unlocks\' frames + 4, 2 free acres above the buffer and the cash; each gate says why', () => {
    const { cp } = F.load(['cp-lab']);
    const lab = B('Manufacturing Lab');
    // 81 acres bought: 18 free, exactly 2 above the 16-acre buffer; Iron Frames = what the unlocks still need + the Lab's 4
    const ready = () => { const st = F.stageA(); st.land_bought[0] = 81; st.stock[0][I('Iron Frame')] = cp._ifNeed(cp._view(st, F.board.catalog, []), null) + 4; return st; };
    const st = ready(), need = st.stock[0][I('Iron Frame')];
    assert.strictEqual(cp.cfg.labTarget, 2);
    const a = labOf(decideA(cp, st))[0];
    assert.strictEqual(a.id, 'lab:buy:1');
    assert.ok(a.hold);
    assert.deepStrictEqual(a.steps.map((s) => s.msg), [{ type: 'BuyBuilding', building: lab, amount: 1, region: 0 }, { type: 'AssignBuildings', group: 9, amount: 1 }]);
    const v = cp._view(st, F.board.catalog, []);
    assert.deepStrictEqual(cp._lab.pendingInvest(v, F.ctxOf()), [{ what: 'second Manufacturing Lab', paybackH: null }]);
    // frames short
    const s1 = ready(); s1.stock[0][I('Iron Frame')] = need - 1;
    let d = decideA(cp, s1);
    assert.ok(!labOf(d).some((x) => x.id.startsWith('lab:buy')));
    assert.match(d.readouts.lab.secondLab, new RegExp('Iron Frame ' + (need - 1) + ' < ' + need));
    assert.strictEqual(cp._lab.pendingInvest(cp._view(s1, F.board.catalog, []), F.ctxOf()).length, 1, 'still wanted: E5 waits');
    // one free acre above the buffer: the Lab buys the other in the same held action while the land rule is open
    const s2 = inC(ready()); s2.land_bought[0] = 80;   // stage C: the Lab may buy land
    d = decideA(cp, s2);
    const la = labOf(d).find((x) => x.id.startsWith('lab:buy'));
    assert.ok(d.rule.lastAcre >= cp._view(s2, F.board.catalog, []).acresOwned + 1, 'fixture: rule open');
    assert.deepStrictEqual(la.steps.map((s) => s.msg), [{ type: 'BuyLand', amount: 1, region: 0 }, { type: 'BuyBuilding', building: lab, amount: 1, region: 0 }, { type: 'AssignBuildings', group: 9, amount: 1 }]);
    assert.match(la.text, /buy 1 acre\(s\) \$/);
    // cash: money floor + Lab + bill floor
    d = decideA(cp, ready(), F.ctxOf({ floorCents: 5000000 - 1050000 - 4000 + 1 }));
    assert.ok(!labOf(d).some((x) => x.id.startsWith('lab:buy')));
    assert.match(d.readouts.lab.secondLab, /cash \$50,000 < /);
    assert.ok(labOf(decideA(cp, ready(), F.ctxOf({ floorCents: 5000000 - 1050000 - 4000 })))[0].id === 'lab:buy:1', 'cash exactly at the line buys');
    // never past 2, and not when labTarget is 1
    const s3 = ready(); s3.groups[9].count = 2;
    assert.ok(!labOf(decideA(cp, s3)).some((x) => x.id.startsWith('lab:buy')));
    assert.deepStrictEqual(cp._lab.pendingInvest(cp._view(s3, F.board.catalog, []), F.ctxOf()), []);
    cp.cfg.labTarget = 1;
    assert.ok(!labOf(decideA(cp, ready())).some((x) => x.id.startsWith('lab:buy')));
    F.unload();
  });

  await t('B1: second Lab with no free acre: buys its own acres in stage C-D inside the land rule (cash counts the land); rule closed: not pending, readout says so', () => {
    const { cp } = F.load(['cp-lab']);
    const lab = B('Manufacturing Lab'), cat = F.board.catalog;
    // E4 at the end: no acre above the 16-acre buffer free
    const st = F.stageA(); st.stock[0][I('Iron Frame')] = 1000; st.items[F.MONEY] = 1e11;
    st.land_bought[0] += cp.cfg.bufferAcres - cp._view(st, cat, []).freeAcres;
    const v = cp._view(st, cat, []);
    assert.strictEqual(v.freeAcres, cp.cfg.bufferAcres);
    const open = { lastAcre: v.acresOwned + 2 }, closed = { lastAcre: v.acresOwned + 1 };
    const r = cp._lab.labBuy(v, F.ctxOf(), cp.cfg, open, 'C');
    assert.deepStrictEqual(r.action.steps.map((s) => s.msg), [{ type: 'BuyLand', amount: 2, region: 0 }, { type: 'BuyBuilding', building: lab, amount: 1, region: 0 }, { type: 'AssignBuildings', group: 9, amount: 1 }]);
    assert.strictEqual(cp._lab.pendingInvest(v, F.ctxOf(), open, 'C').length, 1);
    // cash: money floor + 2 acres + Lab + bill floor
    const land = cp._acrePriceCents(v.landBought) + cp._acrePriceCents(v.landBought + 1);
    const price = globalThis.idleCore.planner.price(cat.buildings.find((b) => b.name === 'Manufacturing Lab').cost, 1, 0);
    const line = land + price + 4000;
    assert.ok(cp._lab.labBuy(v, F.ctxOf({ floorCents: v.money - line }), cp.cfg, open, 'C').action, 'cash exactly at the line buys');
    const short = cp._lab.labBuy(v, F.ctxOf({ floorCents: v.money - line + 1 }), cp.cfg, open, 'C');
    assert.ok(!short.action && short.want);
    assert.match(short.note, /money floor \+ 2 acre\(s\) \$/);
    // the rule closes before the 2nd acre: not wanted, so E5 is not held by it
    const c = cp._lab.labBuy(v, F.ctxOf(), cp.cfg, closed, 'C');
    assert.ok(!c.action && !c.want);
    assert.match(c.note, /^second Lab: land rule closed/);
    assert.deepStrictEqual(cp._lab.pendingInvest(v, F.ctxOf(), closed, 'C'), []);
    assert.deepStrictEqual(cp._lab.pendingInvest(v, F.ctxOf(), null, 'C'), [], 'no rule: no land');
    // through decide (verifier probe: E4 free-acre side holds, rule open): the Lab buys its acres, so it never deadlocks E5
    const s4 = inC(F.stageA()); s4.stock[0][I('Iron Frame')] = 200; s4.items[F.MONEY] = 1e11; F.tight(cp, s4, 80);
    s4.land_bought[0] += cp.cfg.bufferAcres - cp._view(s4, cat, []).freeAcres;
    const d = decideA(cp, s4, F.ctxOf({ netIncomeH: 1, tick: 20150000 }));
    assert.ok(d.rule.lastAcre >= cp._view(s4, cat, []).acresOwned + 2, 'fixture: rule open');
    assert.deepStrictEqual(labOf(d)[0].steps.map((s) => s.msg.type), ['BuyLand', 'BuyBuilding', 'AssignBuildings']);
    F.unload();
  });

  await t('D2: second Lab, stage A-B: no free acre above the buffer buys no land (no action, not pending, readout says why); free acres above it still buy, no BuyLand', () => {
    const { cp } = F.load(['cp-lab']);
    const cat = F.board.catalog;
    // 80 bought + the buffer free: no acre above the 16-acre buffer; money and frames are plentiful, the land rule is open
    const none = (inStage) => { const s = inStage(F.stageA()); s.stock[0][I('Iron Frame')] = 200; s.items[F.MONEY] = 1e11; F.tight(cp, s, 80); s.land_bought[0] += cp.cfg.bufferAcres - cp._view(s, cat, []).freeAcres; return s; };
    for (const [stage, inStage] of [['B', inB], ['A', (s) => s]]) {
      const s = none(inStage), ctx = F.ctxOf({ netIncomeH: 1, tick: 20150000 });
      const d = decideA(cp, s, ctx), v = cp._view(s, cat, []);
      assert.strictEqual(d.stage, stage);
      assert.ok(d.rule.lastAcre >= v.acresOwned + 2, 'fixture: rule open');
      assert.strictEqual(v.freeAcres, cp.cfg.bufferAcres);
      assert.ok(!labOf(d).some((x) => x.id.startsWith('lab:buy')), 'stage ' + stage + ': no Lab action');
      assert.match(d.readouts.lab.secondLab, new RegExp('stage ' + stage + ' buys no land for it'));
      assert.deepStrictEqual(cp._lab.pendingInvest(v, ctx, d.rule, stage), [], 'stage ' + stage + ': not pending');
      assert.ok(!cp._lab.labBuy(v, ctx, cp.cfg, d.rule, stage).want);
      assert.ok(cp._lab.labBuy(v, ctx, cp.cfg, d.rule, 'C').action, 'stage C buys the land');
    }
    // 2 free acres above the buffer: stage B still buys, with no BuyLand
    const s2 = inB(F.stageA()); s2.land_bought[0] = 81; s2.stock[0][I('Iron Frame')] = 200; s2.items[F.MONEY] = 1e11;
    const d2 = decideA(cp, s2);
    assert.strictEqual(d2.stage, 'B');
    assert.deepStrictEqual(labOf(d2).find((x) => x.id.startsWith('lab:buy')).steps.map((x) => x.msg.type), ['BuyBuilding', 'AssignBuildings']);
    F.unload();
  });

  await t('D2: a bought Lab whose assign did not land joins the Lab group; no second purchase', () => {
    const { cp } = F.load(['cp-lab']);
    const st = F.stageA(); st.land_bought[0] = 90; st.stock[0][I('Iron Frame')] = 200;
    st.building_pool[0][B('Manufacturing Lab')] = 1;   // BuyBuilding landed, AssignBuildings was lost
    const acts = labOf(decideA(cp, st));
    assert.ok(!acts.some((x) => x.id.startsWith('lab:buy')), 'owned is 2 with the pool');
    assert.deepStrictEqual(acts[0].steps.map((s) => s.msg), [{ type: 'AssignBuildings', group: 9, amount: 1 }]);
    F.unload();
  });

  await t('D2 runner: the fake server applies the buy: 2 Labs in the Lab group, one BuyBuilding only', async () => {
    const st = F.stageA(); st.land_bought[0] = 82;
    const { cp, w } = F.boot(st, { modules: ['cp-lab'] });
    Object.assign(cp.cfg, { land: false, unlocks: false, confirmMs: 500 });
    st.stock[0][I('Iron Frame')] = cp._ifNeed(cp._view(st, F.board.catalog, []), null) + 4;
    cp.start({ dryRun: false });
    for (let i = 0; i < 4; i++) { await F.waitFor(() => !cp.active); await cp._step(); }
    await F.waitFor(() => !cp.active);
    assert.strictEqual(w.ws.sent.filter((m) => m.type === 'BuyBuilding').length, 1, w.ws.sent.map((m) => m.type).join());
    assert.strictEqual(st.groups[9].count, 2);
    cp.stop(); F.unload();
  });

  F.done();
})();