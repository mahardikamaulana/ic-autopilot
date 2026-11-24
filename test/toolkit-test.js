// Headless checks for the shared core, the Lab runner and the Autopilot guards of ic-autopilot.user.js (no browser, no game).
//   bun test/toolkit-test.js
// The offline simulator (early-game-sim.js) covers what Autopilot decides; this covers what the core
// and the guards around it do: confirm waiting, game-data check, stall watchdog, settings export /
// import, stop-all, and the React walk cache; and what the Lab runner decides and sends.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'live-board.json'), 'utf8'));
const full = fs.readFileSync(path.join(__dirname, '..', 'ic-autopilot.user.js'), 'utf8');
const coreSrc = full.slice(full.indexOf('// @@MODULE core'), full.indexOf('// @@END core'));
const apSrc = full.slice(full.indexOf('// @@MODULE early-game'));
const labSrc = full.slice(full.indexOf('// @@MODULE lab'), full.indexOf('// @@END lab'));
const asSrc = full.slice(full.indexOf('// @@MODULE autosell'), full.indexOf('// @@END autosell'));
const cdSrc = full.slice(full.indexOf('// @@END core-math'), full.indexOf('// @@MODULE lab'));   // CD Farm has no module markers: it sits between core-math and lab

let failed = 0;
const quietLog = console.log, quietWarn = console.warn;
// bun test/toolkit-test.js --shard=k/N runs every N-th test (k from 0); no flag runs all.
const SHARD = (process.argv.find((a) => a.startsWith('--shard=')) || '').slice(8).split('/').map(Number);
let testNo = 0;
async function t(name, fn) {
  if (SHARD.length === 2 && testNo++ % SHARD[1] !== SHARD[0]) return;
  console.log = () => {}; console.warn = () => {};
  const t0 = Date.now();
  try { await fn(); console.log = quietLog; console.warn = quietWarn; quietLog('ok   ' + name + (process.env.TEST_TIMES ? '  [' + (Date.now() - t0) + ' ms]' : '')); }
  catch (e) { console.log = quietLog; console.warn = quietWarn; failed++; quietLog('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll a condition instead of sleeping a guessed time: returns as soon as it holds (or false after ms).
const waitFor = async (cond, ms = 4000, step = 10) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(step); } return !!cond(); };
const settled = (m) => waitFor(() => !m.running && !m.active, 3000);   // a runner has finished its current step after stop()
const fresh = () => { globalThis.idleCore?._unload?.(); globalThis.labRunner?._unload?.(); globalThis.idleCore = undefined; globalThis.earlyGame = undefined; globalThis.cdFarm = undefined; globalThis.labRunner = undefined; };

function loadBoth() {
  fresh();
  (0, eval)(coreSrc + '\n' + labSrc + '\n' + apSrc);
  return { core: globalThis.idleCore, ap: globalThis.earlyGame, lab: globalThis.labRunner };
}
function baseState() {
  return { ssi: { corp_id: 1, last_user_mutation_tick: 0 }, items: { 0: 10000, 24: 0, 111: 0 }, stock: { 0: {} }, groups: {}, building_pool: { 0: {} }, next_group_id: 0, research: null, research_queue: [], unlocked_buildings: [], land_bought: { 0: 0 } };
}

// ---- Lab runner fixtures: the saved live catalog and a state with Manufacturing Labs -----------------
const itemId = (name) => board.catalog.items.find((i) => i.name === name).id;
const recipeFor = (name) => board.catalog.recipes.find((r) => r.inputs.length && r.outputs.some((o) => o.item === itemId(name))).id;
const IRON_FRAME = itemId('Iron Frame'), WOODEN_FRAME = itemId('Wooden Frame'), PLANKS = itemId('Planks'), IRON_SHEET = itemId('Iron Sheet');
// labs: { region: count } (unassigned pool); catalyst: { region: n }; make: products the groups make (plus a Lumber Camp on Wood, which the Lab won't take).
function labState({ labs = { 0: 1 }, make = ['Planks', 'Iron Sheet', 'Wooden Frame', 'Iron Frame'], md = 200000, rd = 20, catalyst = { 0: 1 } } = {}) {
  const st = baseState();
  st.items = { 0: 10000000, 24: 0, 25: md, 26: rd };
  st.building_pool = Object.fromEntries(Object.entries(labs).map(([r, n]) => [r, { 14: n }]));
  st.stock = Object.fromEntries(Object.keys(labs).map((r) => [r, { 63: catalyst[r] ?? 0 }]));
  st.groups = Object.fromEntries(make.map((name, i) => [i + 1, { building: 4, region: 0, count: 1, recipe: recipeFor(name) }]));
  st.groups[99] = { building: 0, region: 0, count: 5, recipe: 0 };
  st.mfg_research = {}; st.pending_results = [];
  return st;
}

(async () => {
  await t('game-data check passes on the saved live catalog and fails on a broken one', () => {
    const { ap } = loadBoth();
    const k = ap._core, C = k.normalize(board.catalog);
    assert.deepStrictEqual(k.checkGame(k.snapshot(baseState(), C, [], [], 0)), []);
    const broken = JSON.parse(JSON.stringify(board.catalog));
    broken.buildings = [];
    const bad = k.checkGame(k.snapshot(baseState(), k.normalize(broken), [], [], 0));
    assert.ok(bad.some((x) => /buildings is empty/.test(x)) && bad.some((x) => /Lumber Camp/.test(x)), bad.join('; '));
    const noMoney = baseState(); noMoney.items = {};
    assert.ok(k.checkGame(k.snapshot(noMoney, C, [], [], 0)).some((x) => /money/.test(x)));
  });

  await t('stall watchdog: fires on plan actions without progress, not on waits or selling, clears on progress', () => {
    const { ap } = loadBoth();
    const k = ap._core, C = k.normalize(board.catalog);
    ap.cfg.dryRun = false;
    let now = 1e9;
    k.setClock(() => now);
    const st = baseState();
    const snap = () => k.snapshot(st, C, [], [], 0);
    k.watchStall(snap(), true);                         // first look sets the mark
    for (let i = 0; i < 30; i++) { now += 60000; k.watchStall(snap(), false); }
    assert.strictEqual(k.stalledNow(), '', 'waiting alone must not alert');
    k.resetWatch(); k.watchStall(snap(), true);
    for (let i = 0; i < 19; i++) { now += 3000; k.watchStall(snap(), true); }
    assert.strictEqual(k.stalledNow(), '', 'too early');
    now += 21 * 60000; k.watchStall(snap(), true);
    assert.ok(/no plan progress for 2\d min/.test(k.stalledNow()), 'should alert: ' + k.stalledNow());
    st.items[24] = 5;                                    // CD went up: progress
    k.watchStall(snap(), true);
    assert.strictEqual(k.stalledNow(), '');
    ap.cfg.dryRun = true;                                // a dry run never changes anything: never alerts
    k.resetWatch(); k.watchStall(snap(), true);
    for (let i = 0; i < 40; i++) { now += 60000; k.watchStall(snap(), true); }
    assert.strictEqual(k.stalledNow(), '');
  });

  await t('settings export / import round-trips Infinity and rejects bad values', () => {
    const { core, ap } = loadBoth();
    assert.strictEqual(ap.cfg.goldMines, Infinity);
    ap.cfg.workshops = 3; ap.cfg.sellAll = false;
    const json = core.exportConfig();
    assert.ok(JSON.parse(json).earlyGame.cfg.goldMines === 'Infinity');
    ap.cfg.workshops = 2; ap.cfg.sellAll = true; ap.cfg.goldMines = 7;
    const rep = core.importConfig(json);
    assert.strictEqual(ap.cfg.workshops, 3); assert.strictEqual(ap.cfg.sellAll, false); assert.strictEqual(ap.cfg.goldMines, Infinity);
    assert.ok(/earlyGame: \d+ applied/.test(rep), rep);
    const bad = JSON.stringify({ app: 'idlecorp-toolkit', format: 1, earlyGame: { cfg: { workshops: 'lots', sawmills: -4, dryRun: false, nosuchkey: 1, ironMines: 9 } } });
    const r2 = core.importConfig(bad);
    assert.strictEqual(ap.cfg.workshops, 3, 'string for a number is refused');
    assert.notStrictEqual(ap.cfg.sawmills, -4, 'below min is refused');
    assert.strictEqual(ap.cfg.dryRun, true, 'session-only settings are never imported');
    assert.strictEqual(ap.cfg.ironMines, 9);
    assert.ok(/skipped/.test(r2) && /workshops/.test(r2), r2);
    assert.throws(() => core.importConfig('{"app":"other"}'), /not an IdleCorp Toolkit export/);
    assert.throws(() => core.importConfig('nope'), /not valid JSON/);
    ap.resetCfg();
    assert.strictEqual(ap.cfg.workshops, 2); assert.strictEqual(ap.cfg.goldMines, Infinity); assert.strictEqual(ap.cfg.sellAll, true);
  });

  await t('waitConfirm: needs a newer mutation when the socket talks; holds steady when it never does', async () => {
    const { core } = loadBoth();
    core.tune.steadyMs = 150; core.tune.pollMs = 10;   // the code under test is the logic, not the 1.5 s hold
    const closed = () => { throw new Error('closed'); };
    // Socket has delivered frames: a true state alone is not enough, a later mutation is.
    core.sock.textMsgs = 5; core.sock.muts = 3;
    let reads = 0;
    const read = () => { reads++; return { wsOpen: true }; };
    setTimeout(() => { core.sock.muts = 4; }, 60);
    const t0 = Date.now();
    const r = await core.waitConfirm({ read, pred: () => true, d0: 3, timeoutMs: 3000, closed });
    assert.ok(r && Date.now() - t0 >= 50 && Date.now() - t0 < 1500, 'waited for the mutation, ' + (Date.now() - t0) + ' ms');
    assert.strictEqual(await core.waitConfirm({ read, pred: () => true, d0: 99, timeoutMs: 120, closed }), null, 'times out without one');
    // Blind socket (no text frames ever): the state must hold for ~1.5 s.
    core.sock.textMsgs = 0;
    const t1 = Date.now();
    assert.ok(await core.waitConfirm({ read, pred: () => true, d0: 0, timeoutMs: 6000, closed }));
    assert.ok(Date.now() - t1 >= core.tune.steadyMs - 10, 'steady wait was ' + (Date.now() - t1) + ' ms');
    // ...and a state that flickers never confirms.
    let n = 0;
    assert.strictEqual(await core.waitConfirm({ read, pred: () => (n++ % 2) === 0, d0: 0, timeoutMs: 400, closed }), null);   // alternates every poll: never two true in a row, whatever the load
    // A closed socket throws through the caller's hook.
    await assert.rejects(core.waitConfirm({ read: () => ({ wsOpen: false }), pred: () => true, d0: 0, timeoutMs: 200, closed }), /closed/);
  });

  await t('stopAll stops whatever is running and says so', () => {
    const { core } = loadBoth();
    const calls = [];
    globalThis.earlyGame = { running: true, stop: () => calls.push('ap') };
    globalThis.cdFarm = { running: true, stop: () => calls.push('cd') };
    assert.deepStrictEqual(core.stopAll('test'), ['Autopilot', 'CD Farm']);
    assert.deepStrictEqual(calls, ['ap', 'cd']);
    globalThis.earlyGame = { running: false, stop: () => calls.push('x') };
    globalThis.cdFarm = { running: false, stop: () => calls.push('x') };
    assert.deepStrictEqual(core.stopAll('test'), []);
    assert.strictEqual(calls.length, 2);
    assert.ok(core.ledger.text().includes('stop all (test)'));
  });

  await t('ledger keeps the newest 300 lines', () => {
    const { core } = loadBoth();
    core.ledger.clear();
    for (let i = 0; i < 350; i++) core.ledger.add('AP', 'action', 'line ' + i, i === 349 ? { dMoney: -12 } : {});
    const l = core.ledger.list();
    assert.strictEqual(l.length, 300);
    assert.strictEqual(l[0].text, 'line 50');
    assert.ok(core.ledger.text().endsWith('line 349 (-$12)'));
    core.ledger.clear();
  });

  await t('UI kit: exported without a DOM, toast + ledger.restore are safe, kinds and Undo accepted', () => {
    fresh();
    (0, eval)(coreSrc);
    const core = globalThis.idleCore;
    for (const k of ['group', 'field', 'inputBox', 'createPanel', 'createChrome', 'createLogView', 'ensureStyle', 'hero', 'rowList', 'stateLine', 'banner', 'disclosure', 'amountField', 'toggleField', 'segField', 'quickPicks', 'runModeSeg', 'settingsTab', 'footer', 'logTab', 'syncLog', 'resetSettings']) assert.strictEqual(typeof core.ui[k], 'function', 'ui.' + k);
    core.toast('plain'); core.toast('kind', 'error'); core.toast('undo', { kind: 'success', undo() {} });
    core.ledger.clear(); core.ledger.add('AP', 'action', 'a'); core.ledger.add('CD', 'fail', 'b');
    const snap = core.ledger.list();
    core.ledger.clear(); assert.strictEqual(core.ledger.list().length, 0);
    core.ledger.restore(snap); assert.deepStrictEqual(core.ledger.list().map((e) => e.text), ['a', 'b']);
    core.ledger.clear();
  });

  await t('walk(): reuses the result for 120 ms, walks again when fresh or expired', async () => {
    fresh();
    // A tiny fake React tree: root container -> fiber with hooks holding the game state and a socket ref.
    class FakeWS { constructor() { this.readyState = 1; this.listeners = []; } addEventListener(_t, f) { this.listeners.push(f); } removeEventListener() {} }
    globalThis.WebSocket = FakeWS;
    const ws = new FakeWS();
    let walks = 0;
    const st = { groups: {}, stock: {}, ssi: {}, items: {} };
    const fiber = { get memoizedState() { walks++; return { memoizedState: { current: ws }, next: { memoizedState: st, next: null } }; }, memoizedProps: null, child: null, sibling: null };
    const root = { __reactContainer$x: fiber };
    globalThis.document = { body: {}, getElementById: (id) => (id === 'root' ? root : null), title: 'x' };
    (0, eval)(coreSrc);
    const core = globalThis.idleCore;
    try {
      const a = core.walk(), b = core.walk();
      assert.strictEqual(a, b); assert.strictEqual(walks, 1); assert.strictEqual(a.st, st); assert.strictEqual(a.ws, ws);
      assert.strictEqual(core.sock.ws, ws, 'the socket listener is attached once');
      const c = core.walk(true);
      assert.notStrictEqual(c, a); assert.strictEqual(walks, 2);
      await sleep(150);
      core.walk(); assert.strictEqual(walks, 3);
    } finally {
      core._unload(); globalThis.idleCore = undefined;
      delete globalThis.document; delete globalThis.WebSocket;
    }
  });

  await t('loop smoke: dry run sends nothing; live sends, slows down when unconfirmed, stops cleanly; broken game data refuses Live', async () => {
    fresh();
    class FakeWS { constructor() { this.readyState = 1; this.sent = []; } addEventListener() {} removeEventListener() {} send(m) { this.sent.push(JSON.parse(m)); } }
    globalThis.WebSocket = FakeWS;
    const ws = new FakeWS();
    const st = baseState();
    const catalog = JSON.parse(JSON.stringify(board.catalog));
    const props = { catalog };
    const fiber = { memoizedState: { memoizedState: { current: ws }, next: { memoizedState: st, next: { memoizedState: board.deals.filter((d) => d.region === 0), next: null } } }, memoizedProps: props, child: null, sibling: null };
    const root = { __reactContainer$x: fiber };
    const el = () => ({ append() {}, remove() {}, addEventListener() {}, setAttribute() {}, style: {}, classList: { toggle() {} } });
    globalThis.document = { body: el(), head: el(), title: 'game', getElementById: (id) => (id === 'root' ? root : null), createElement: el, querySelector: () => null, hidden: true };
    (0, eval)(coreSrc + '\n' + apSrc);
    const ap = globalThis.earlyGame;
    ap.cfg.jitterMinMs = 0; ap.cfg.jitterMaxMs = 0; ap.cfg.intervalMs = 40; ap.cfg.timeoutMs = 300;
    try {
      // Dry run: decides, writes to the log, sends nothing.
      ap.start({ dryRun: true });
      await waitFor(() => globalThis.idleCore.ledger.list().length > 0 && ap.stats?.cycles !== 0, 1500);   // it has looked at the world at least once
      await sleep(120);                                                                                   // ...and a few more loops: still nothing sent
      assert.strictEqual(ws.sent.length, 0, 'dry run sent ' + JSON.stringify(ws.sent[0]));
      ap.stop(); await settled(ap);
      assert.ok(!ap.running && !ap.active);

      // Live: the server never applies anything, so every action fails: the pace halves and the log says so.
      ap.cfg.dryRun = false;
      ap.start();
      await waitFor(() => /not confirmed|slowing down/.test(globalThis.idleCore.ledger.text()), 4000);
      assert.ok(ws.sent.length >= 1, 'live sent nothing');
      assert.ok(ws.sent[0].type, 'sent ' + JSON.stringify(ws.sent[0]));
      const led = globalThis.idleCore.ledger.text();
      assert.ok(/not confirmed|slowing down/.test(led), 'ledger: ' + led);
      ap.stop(); await settled(ap);
      assert.ok(!ap.running && !ap.active, 'stopped');

      // Game data that no longer looks right: Live is refused and falls back to a dry run.
      props.catalog = { ...catalog, buildings: [] };   // a new object: the script caches the re-keyed catalog per object
      ws.sent.length = 0;
      ap.cfg.dryRun = false;
      ap.start();
      assert.strictEqual(ap.cfg.dryRun, true, 'Live must be refused');
      await sleep(100);
      assert.strictEqual(ws.sent.length, 0);
      assert.ok(/Live refused/.test(globalThis.idleCore.ledger.text()));
      ap.stop(); await settled(ap);
    } finally {
      ap.stop(); await settled(ap);
      ap._unload(); globalThis.idleCore._unload(); globalThis.idleCore = undefined; globalThis.earlyGame = undefined;
      delete globalThis.document; delete globalThis.WebSocket;
    }
  });

  await t('live confirm path: a Diff frame through the shared listener confirms the first action', async () => {
    fresh();
    class FakeWS {
      constructor() { this.readyState = 1; this.sent = []; this.ls = []; this.n = 0; }
      addEventListener(_t, f) { this.ls.push(f); } removeEventListener() {}
      send(m) {
        const msg = JSON.parse(m); this.sent.push(msg);
        if (this.sent.length > 1) return;                    // only the first action is echoed
        if (msg.type === 'BuyBuilding') {
          st.building_pool[0][msg.building] = (st.building_pool[0][msg.building] ?? 0) + msg.amount;
          st.items[0] -= 100;
        }
        const tick = (st.ssi.last_user_mutation_tick += 4);
        setTimeout(() => { for (const f of this.ls) f({ data: JSON.stringify({ kind: 'Diff', tick: tick + 1, diff: { tick: tick + 1, ssi: { last_user_mutation_tick: tick } } }) }); }, 30);
      }
    }
    globalThis.WebSocket = FakeWS;
    const ws = new FakeWS();
    const st = baseState();
    const props = { catalog: JSON.parse(JSON.stringify(board.catalog)) };
    const fiber = { memoizedState: { memoizedState: { current: ws }, next: { memoizedState: st, next: { memoizedState: board.deals.filter((d) => d.region === 0), next: null } } }, memoizedProps: props, child: null, sibling: null };
    const root = { __reactContainer$x: fiber };
    const el = () => ({ append() {}, remove() {}, addEventListener() {}, setAttribute() {}, style: {}, classList: { toggle() {} } });
    globalThis.document = { body: el(), head: el(), title: 'game', getElementById: (id) => (id === 'root' ? root : null), createElement: el, querySelector: () => null, hidden: true };
    (0, eval)(coreSrc + '\n' + apSrc);
    const ap = globalThis.earlyGame, core = globalThis.idleCore;
    ap.cfg.jitterMinMs = 0; ap.cfg.jitterMaxMs = 0; ap.cfg.intervalMs = 40; ap.cfg.timeoutMs = 3000;
    core.ledger.clear();
    try {
      ap.cfg.dryRun = false;
      const t0 = Date.now();
      ap.start();
      let line = null;
      while (Date.now() - t0 < 2500 && !(line = core.ledger.list().find((e) => e.mod === 'AP' && e.kind === 'action'))) await sleep(20);
      assert.ok(line, 'no confirmed action; sent ' + JSON.stringify(ws.sent[0]) + ' ledger: ' + core.ledger.text());
      assert.ok(Date.now() - t0 < 1400, 'confirmed in ' + (Date.now() - t0) + ' ms: this is the steady (blind) path, not the mutation path');
      assert.ok(core.sock.textMsgs >= 1 && core.sock.muts >= 1, 'frames reached the shared listener: ' + JSON.stringify({ ...core.sock, ws: 0 }));
      assert.ok(core.sock.tick > 0 && core.nowTick() >= core.sock.tick, 'server tick tracked');
      assert.strictEqual(typeof line.dMoney, 'number', 'ledger line carries a cash change');
      assert.ok(!/not confirmed/.test(core.ledger.text()), core.ledger.text());
      ap.stop(); await settled(ap);
    } finally {
      ap.stop(); await settled(ap);
      ap._unload(); core._unload(); globalThis.idleCore = undefined; globalThis.earlyGame = undefined;
      delete globalThis.document; delete globalThis.WebSocket;
    }
  });

  await t('reload: the old tab gives up the Autopilot lock as the page goes, so the reloaded tab starts at once', async () => {
    fresh();
    const disk = {};
    globalThis.localStorage = { getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = String(v); }, removeItem: (k) => { delete disk[k]; } };
    // A game page that has not rendered yet: each copy's startup poll waits for it (it ends at _unload).
    const el = () => ({ append() {}, remove() {}, addEventListener() {}, setAttribute() {}, style: {}, classList: { toggle() {} } });
    globalThis.document = { body: el(), head: el(), title: 'game', getElementById: () => null, createElement: el, querySelector: () => null, hidden: true };
    let old = null, ap = null;
    try {
      (0, eval)(coreSrc + '\n' + apSrc);
      old = globalThis.earlyGame;
      old.start({ dryRun: true });                    // the old tab: its loop holds the lock
      assert.ok(old.running && disk['earlyGame.v2.lock'], 'the old tab holds the lock');
      dispatchEvent(new Event('pagehide'));           // a reload: the browser says the page is going
      fresh();                                        // the reloaded page is a new script; the old copy never gets _unload()
      (0, eval)(coreSrc + '\n' + apSrc);
      ap = globalThis.earlyGame;
      ap.start({ dryRun: true });
      assert.ok(ap.running, 'the reloaded tab did not start (the old tab still holds the lock)');
    } finally {
      old?.stop(); ap?.stop();
      await Promise.all([old && settled(old), ap && settled(ap)]);
      old?._unload(); ap?._unload();
      await sleep(550);                               // both startup polls wake, see _unload and return before the stub goes
      fresh(); delete globalThis.localStorage; delete globalThis.document;
    }
  });

  // ---- Lab runner: what _decide chooses (state in, decision out: no I/O) -----------------------------------
  const D = (lab, st, over = {}, mem = { counts: {}, next: 0 }) => lab._decide(st, board.catalog, { mode: 'process', tierMode: 'best', mdReserve: 5000, autoClaim: true, list: [], ...over }, mem);
  const startMsg = (product, context, tier, region) => ({ type: 'StartResearch', product, context, tier, region });

  await t('Lab runner: picks the highest-value product the groups make, focus 0, at the best tier it can pay for', () => {
    const { lab } = loadBoth();
    assert.strictEqual(lab.cfg.dryRun, true, 'dry run is the default');
    const st = labState();    // makes Planks, Iron Sheet, Wooden Frame, Iron Frame (and Wood, which is no product); 200,000 MD, 20 RD, a Catalyst in Heartland
    assert.deepStrictEqual(D(lab, st).msg, startMsg(IRON_FRAME, 0, 2, 0));
    st.stock[0][63] = 0;      // no Catalyst: Tier III is out
    assert.deepStrictEqual(D(lab, st).msg, startMsg(IRON_FRAME, 0, 1, 0));
    st.items[26] = 4;         // RD short of 5: Tier II is out
    assert.deepStrictEqual(D(lab, st).msg, startMsg(IRON_FRAME, 0, 0, 0));
    // Module fabrication picks the same product, with focus 1
    assert.deepStrictEqual(D(lab, st, { mode: 'modules' }).msg, startMsg(IRON_FRAME, 1, 0, 0));
    // Nothing the groups make qualifies: Process study waits, Module fabrication takes the dearest product there is
    const none = labState({ make: [] });
    assert.strictEqual(D(lab, none).msg, undefined);
    assert.match(D(lab, none).wait, /no produced product qualifies/);
    assert.strictEqual(D(lab, none, { mode: 'modules' }).msg.product, itemId('Smart Frame'));
  });

  await t('Lab runner: Process study rotates to the product started least, the dearest first on a tie', () => {
    const { lab } = loadBoth();
    const st = labState(), mem = { counts: {}, next: 0 }, order = [];
    for (let i = 0; i < 5; i++) {
      const p = D(lab, st, {}, mem).msg.product;
      order.push(p); mem.counts[p] = (mem.counts[p] ?? 0) + 1;
    }
    assert.deepStrictEqual(order, [IRON_FRAME, WOODEN_FRAME, IRON_SHEET, PLANKS, IRON_FRAME]);
  });

  await t('Lab runner: never spends into the MD reserve', () => {
    const { lab } = loadBoth();
    const st = labState({ catalyst: {}, rd: 0 });     // Tier I is all it can pay
    st.items[25] = 5999;
    let d = D(lab, st);                               // 5,999 - 1,000 would leave less than 5,000
    assert.strictEqual(d.msg, undefined);
    assert.match(d.wait, /MD 5,999 < 1,000 \+ reserve 5,000/);
    st.items[25] = 6000;
    assert.strictEqual(D(lab, st).msg.tier, 0, 'exactly the reserve left is fine');
    // Bigger tiers count the reserve too: Tier II costs 10,000 and keeps 5,000
    const rich = labState({ catalyst: {} });
    rich.items[25] = 14999; assert.strictEqual(D(lab, rich).msg.tier, 0);
    rich.items[25] = 15000; assert.strictEqual(D(lab, rich).msg.tier, 1);
    // ... and so does Tier III: 100,000 + 5,000
    const cat = labState();
    cat.items[25] = 104999; assert.strictEqual(D(lab, cat).msg.tier, 1);
    cat.items[25] = 105000; assert.strictEqual(D(lab, cat).msg.tier, 2);
    // The reserve is a setting: 13,000 leaves room for Tier I only; 0 spends everything
    assert.strictEqual(D(lab, rich, { mdReserve: 13000 }).msg.tier, 0);
    d = D(lab, rich, { mdReserve: 14500 });
    assert.strictEqual(d.msg, undefined); assert.match(d.wait, /reserve 14,500/);
    const broke = labState({ catalyst: {}, rd: 0, md: 1000 });
    assert.strictEqual(D(lab, broke, { mdReserve: 0 }).msg.tier, 0);
  });

  await t('Lab runner: skips regions whose Lab slot is busy; building research does not block a Lab', () => {
    const { lab } = loadBoth();
    const st = labState({ labs: { 0: 1, 1: 1 }, catalyst: { 0: 1, 1: 1 } });
    st.mfg_research = { 0: { product: PLANKS, context: 0, tier: 0, remaining: 3840 } };
    let d = D(lab, st);
    assert.deepStrictEqual(d.actions.map((a) => a.msg.region), [1]);
    assert.strictEqual(d.regions[0].wait, 'slot busy: Planks Process study, 32m left');
    st.mfg_research[1] = { product: IRON_SHEET, context: 1, tier: 1, remaining: 7200 };
    d = D(lab, st);
    assert.strictEqual(d.msg, undefined);
    assert.strictEqual(d.wait, 'Heartland: slot busy: Planks Process study, 32m left | Industrial Basin: slot busy: Iron Sheet Module fabrication, 1h left');
    // An old save keeps a Heartland project in the construction slot: that Lab is busy
    const old = labState(); old.research = { product: PLANKS, context: 0, tier: 0, remaining: 100 };
    assert.strictEqual(D(lab, old).msg, undefined);
    // Unlocking a building ({ building, remaining }) is the other slot: the Lab still starts
    const tech = labState(); tech.research = { building: 4, remaining: 5000 };
    assert.strictEqual(D(lab, tech).msg.type, 'StartResearch');
    // A Lab project waiting in the shared queue holds its region's slot
    const queued = labState({ labs: { 0: 1, 1: 1 } });
    queued.research_queue = [{ building: 4 }, { product: PLANKS, context: 0, tier: 0, region: 1 }];
    assert.deepStrictEqual(D(lab, queued).actions.map((a) => a.msg.region), [0]);
    // No Lab at all
    const noLab = labState({ labs: {} });
    assert.strictEqual(D(lab, noLab).msg, undefined); assert.match(D(lab, noLab).wait, /no Manufacturing Lab/);
    // Labs in a group count too, not only the unassigned pool
    const grouped = labState({ labs: { 0: 0 } }); grouped.groups[50] = { building: 14, region: 0, count: 1 };
    assert.strictEqual(D(lab, grouped).msg.type, 'StartResearch');
  });

  await t('Lab runner: Tier III needs a Catalyst in that very region; each region sees what the ones before it use', () => {
    const { lab } = loadBoth();
    const st = labState({ labs: { 0: 1, 1: 1 }, catalyst: { 0: 0, 1: 1 } });     // the Catalyst sits in Industrial Basin
    let d = D(lab, st, { tierMode: 3 });
    assert.deepStrictEqual(d.actions.map((a) => [a.msg.region, a.msg.tier]), [[1, 2]]);
    assert.strictEqual(d.regions[0].wait, 'Tier III needs a Catalyst in Heartland');
    const basin = labState({ labs: { 0: 1, 1: 1 }, catalyst: { 0: 1, 1: 0 } });
    assert.strictEqual(D(lab, basin, { tierMode: 3 }).regions[1].wait, 'Tier III needs a Catalyst in Industrial Basin');
    // Best affordable: Heartland takes Tier II, Industrial Basin Tier III (its Catalyst, and MD that is still there)
    d = D(lab, st, { tierMode: 'best' });
    assert.deepStrictEqual(d.actions.map((a) => [a.msg.region, a.msg.tier]), [[0, 1], [1, 2]]);
    // MD for one Tier III only: the second Lab gets nothing, however many Catalysts there are
    const one = labState({ labs: { 0: 1, 1: 1 }, catalyst: { 0: 1, 1: 1 }, md: 105000 });
    d = D(lab, one);
    assert.deepStrictEqual(d.actions.map((a) => [a.msg.region, a.msg.tier]), [[0, 2]]);
    assert.match(d.regions[1].wait, /MD 5,000 < 1,000 \+ reserve 5,000/);
  });

  await t('Lab runner: a fixed tier that cannot be paid waits instead of falling back', () => {
    const { lab } = loadBoth();
    const st = labState({ catalyst: {} });     // 200,000 MD, 20 RD, no Catalyst
    let d = D(lab, st, { tierMode: 3 });
    assert.strictEqual(d.msg, undefined); assert.match(d.wait, /^Tier III needs a Catalyst in Heartland$/);
    st.items[26] = 4;
    d = D(lab, st, { tierMode: 2 });
    assert.strictEqual(d.msg, undefined); assert.match(d.wait, /^Tier II needs 5 Research Data \(have 4\)$/);
    assert.strictEqual(D(lab, st, { tierMode: 1 }).msg.tier, 0, 'Tier I was asked for and can be paid');
    st.items[26] = 20;
    assert.strictEqual(D(lab, st, { tierMode: 1 }).msg.tier, 0, 'a fixed tier is used even when a higher one is affordable');
    assert.strictEqual(D(lab, st, { tierMode: 2 }).msg.tier, 1);
    st.items[25] = 12000;                      // Tier II would leave 2,000 < the 5,000 reserve
    d = D(lab, st, { tierMode: 2 });
    assert.strictEqual(d.msg, undefined); assert.match(d.wait, /MD 12,000 < 10,000 \+ reserve 5,000/);
  });

  await t('Lab runner: only ever emits StartResearch / ClaimResearch, never QueueResearch, and only for free Lab slots', () => {
    const { lab } = loadBoth();
    const msgs = [], list = [{ product: IRON_FRAME, focus: 2, tier: 'default' }, { product: PLANKS, focus: 0, tier: 3 }];
    for (const mode of ['process', 'modules', 'list']) for (const tierMode of ['best', 1, 2, 3]) for (const autoClaim of [true, false]) {
      for (const shape of ['free', 'busy', 'queued', 'poor']) {
        const st = labState({ labs: { 0: 2, 1: 1, 2: 1 }, catalyst: { 0: 1, 2: 1 }, md: shape === 'poor' ? 900 : 300000 });
        st.pending_results = [{ tick: 20, product: PLANKS, context: 0, tier: 0, reward: 'x' }, { tick: 10, product: IRON_SHEET, context: 1, tier: 1 }];
        if (shape === 'busy') st.mfg_research = { 0: { product: PLANKS, context: 0, tier: 0, remaining: 5 }, 1: { product: PLANKS, context: 0, tier: 0, remaining: 5 } };
        if (shape === 'queued') { st.research = { building: 5, remaining: 9 }; st.research_queue = [{ building: 4 }, { product: PLANKS, context: 0, tier: 0, region: 2 }]; }
        const d = D(lab, st, { mode, tierMode, autoClaim, list });
        msgs.push(...d.actions.map((a) => a.msg));
        const free = { free: [0, 1, 2], busy: [2], queued: [0, 1], poor: [] }[shape];
        const started = d.actions.filter((a) => a.msg.type === 'StartResearch').map((a) => a.msg.region);
        assert.ok(started.every((r) => free.includes(r)), `${mode}/${tierMode}/${shape}: started ${started} but only ${free} are free`);
        assert.strictEqual(d.actions.filter((a) => a.msg.type === 'ClaimResearch').length, autoClaim ? 1 : 0);
      }
    }
    assert.ok(msgs.length > 60, 'the sweep produced decisions: ' + msgs.length);
    assert.ok(msgs.every((m) => m.type === 'StartResearch' || m.type === 'ClaimResearch'), JSON.stringify([...new Set(msgs.map((m) => m.type))]));
    assert.ok(!JSON.stringify(msgs).includes('QueueResearch'));
  });

  await t('Lab runner: claims the oldest finished result before it starts anything (autoClaim)', () => {
    const { lab } = loadBoth();
    const st = labState();
    st.pending_results = [{ tick: 700, product: PLANKS, context: 0, tier: 0 }, { tick: 500, product: IRON_FRAME, context: 1, tier: 2, reward: { Module: 'Rare Overclock Mk2' } }];
    let d = D(lab, st);
    assert.deepStrictEqual(d.msg, { type: 'ClaimResearch', tick: 500 });
    assert.deepStrictEqual(d.actions.map((a) => a.msg.type), ['ClaimResearch', 'StartResearch']);
    assert.match(d.reason, /Iron Frame · Module fabrication · Tier III/); assert.match(d.reason, /Rare Overclock/);
    assert.strictEqual(d.pending, 2);
    // Off: results wait for you and the Lab still starts
    d = D(lab, st, { autoClaim: false });
    assert.strictEqual(d.msg.type, 'StartResearch');
    assert.ok(d.actions.every((a) => a.msg.type !== 'ClaimResearch'));
    assert.strictEqual(d.pending, 2);
    // Nothing to start, but a result to claim: the claim is the decision
    st.mfg_research = { 0: { product: PLANKS, context: 0, tier: 0, remaining: 99 } };
    assert.deepStrictEqual(D(lab, st).msg, { type: 'ClaimResearch', tick: 500 });
  });

  await t('Lab runner: custom list cycles in order, skips entries that are not Lab products, an explicit tier beats the default', () => {
    const { lab } = loadBoth();
    const list = [
      { product: WOODEN_FRAME, focus: 1, tier: 'default' },
      { product: itemId('Conveyor'), focus: 0, tier: 'default' },   // a floor piece
      { product: 0, focus: 0, tier: 1 },                            // Money: no recipe makes it from inputs
      { product: PLANKS, focus: 2, tier: 1 },
      { product: 999999, focus: 0, tier: 'default' },               // not in the catalog
    ];
    const at = (next, st = labState()) => D(lab, st, { mode: 'list', list, tierMode: 2 }, { counts: {}, next });
    const first = startMsg(WOODEN_FRAME, 1, 1, 0);    // 'default' follows the tier setting (II = 1 on the wire)
    const second = startMsg(PLANKS, 2, 0, 0);         // its own Tier I
    assert.deepStrictEqual(at(0).msg, first);
    assert.deepStrictEqual(at(1).msg, second, 'the floor piece and Money are skipped');
    assert.deepStrictEqual(at(3).msg, second);
    assert.deepStrictEqual(at(4).msg, first, 'the unknown product is skipped and the list wraps');
    assert.deepStrictEqual(at(17).msg, second, 'a stale pointer is taken modulo the list length');
    // Two free Labs take the next two entries in order
    assert.deepStrictEqual(at(0, labState({ labs: { 0: 1, 1: 1 } })).actions.map((a) => a.msg), [first, { ...second, region: 1 }]);
    // Nothing usable in the list
    const skip = (l) => D(lab, labState(), { mode: 'list', list: l, tierMode: 1 });
    assert.match(skip([]).wait, /list is empty/);
    assert.match(skip([{ product: 0, focus: 0, tier: 'default' }]).wait, /no list entry is a qualifying product/);
  });

  await t('Lab runner: exactly the 91 products the Lab picker lists can be researched (value above 0, no floor pieces, made from inputs)', () => {
    const { lab } = loadBoth();
    const st = labState();
    // A one-entry list per catalog item: it starts only when the item qualifies.
    const startable = board.catalog.items.filter((it) => D(lab, st, { mode: 'list', list: [{ product: it.id, focus: 0, tier: 'default' }], tierMode: 1 }).msg?.product === it.id).map((it) => it.name);
    assert.strictEqual(startable.length, 91);
    for (const yes of ['Planks', 'Iron Frame', 'Smart Frame', 'Car', 'Grain']) assert.ok(startable.includes(yes), yes + ' qualifies');
    for (const no of ['Wood', 'Money', 'Cotton', 'Gold Ore', 'Conveyor', 'Feeder', 'Research Catalyst', 'Manufacturing Data']) assert.ok(!startable.includes(no), no + ' does not');
  });

  await t('Lab runner: success chance follows the client formula (Labs owned, Insightful quirks, focus, tier)', () => {
    const { lab } = loadBoth();
    const rich = (labs) => labState({ labs, catalyst: Object.fromEntries(Object.keys(labs).map((r) => [r, 1])), md: 1e6 });
    const pcts = (st, over = {}) => [1, 2, 3].map((tierMode) => D(lab, st, { tierMode, mdReserve: 0, ...over }).actions[0].pct);
    assert.deepStrictEqual(pcts(rich({ 0: 1 })), [90, 70, 50], 'a single Lab adds nothing you can see');
    assert.deepStrictEqual(pcts(rich({ 0: 1, 1: 1 })), [91, 71, 51]);
    const four = rich({ 0: 3, 1: 1 });
    assert.deepStrictEqual(pcts(four), [93, 72, 52]);
    assert.deepStrictEqual(pcts(four, { mode: 'modules' }), [88, 67, 46]);
    assert.deepStrictEqual(pcts(four, { mode: 'list', list: [{ product: IRON_FRAME, focus: 2, tier: 'default' }] }), [83, 62, 41]);
    // An Insightful quirk on a module in a Lab group adds its percentage (other quirks and other buildings don't)
    const mod = labState({ labs: { 0: 0 }, catalyst: { 0: 1 }, md: 1e6 });
    mod.groups[50] = { building: 14, region: 0, count: 1, modules: { 0: 7 } };
    mod.groups[51] = { building: 4, region: 0, count: 1, recipe: recipeFor('Planks'), modules: { 0: 7 } };
    mod.module_defs = { 7: { quirks: [{ kind: 'Insightful', pct: 3 }, { kind: 'Loner', pct: 50 }] } };
    assert.deepStrictEqual(pcts(mod), [93, 72, 52], '1 Lab + 3 Insightful = bonus 4');
    mod.module_defs[7].quirks[0].pct = 20;
    assert.deepStrictEqual(pcts(mod), [95, 84, 60], 'capped at 95');
  });

  // ---- Lab runner: the loop, against a fake game page ------------------------------------------------------
  // A React tree holding the state and the catalog, a socket class, a bare document: enough for core.walk().
  function labPage(st, FakeWS) {
    globalThis.WebSocket = FakeWS;
    const ws = new FakeWS();
    const props = { catalog: JSON.parse(JSON.stringify(board.catalog)) };
    const fiber = { memoizedState: { memoizedState: { current: ws }, next: { memoizedState: st, next: null } }, memoizedProps: props, child: null, sibling: null };
    const root = { __reactContainer$x: fiber };
    const el = () => ({ append() {}, remove() {}, addEventListener() {}, setAttribute() {}, style: {}, classList: { toggle() {} } });
    globalThis.document = { body: el(), head: el(), title: 'game', getElementById: (id) => (id === 'root' ? root : null), createElement: el, querySelector: () => null, hidden: true };
    return { ws, props };
  }
  const labFast = (lab, extra = {}) => Object.assign(lab.cfg, { intervalMs: 40, delayMs: 10, jitterMinMs: 0, jitterMaxMs: 0, timeoutMs: 400, ...extra });
  const until = async (cond, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !cond()) await sleep(20); };
  const halt = async (lab) => { lab.stop(); await until(() => !lab.active, 3000); };

  await t('Lab runner loop: dry run sends nothing; live claims first, then starts each free Lab one confirmed command at a time, and cycles the list', async () => {
    fresh();
    const st = labState({ labs: { 0: 1, 1: 1 }, catalyst: { 0: 1 } });
    st.pending_results = [{ tick: 40, product: PLANKS, context: 0, tier: 0, reward: 'a Planks process' }];
    const arrived = [], everSent = [];     // arrived: what the server had applied when each command arrived (cleared per round); everSent: every command of the test
    class FakeWS {
      constructor() { this.readyState = 1; this.ls = []; }
      addEventListener(_t, f) { this.ls.push(f); } removeEventListener() {}
      send(m) {
        const msg = JSON.parse(m);
        arrived.push({ msg, pending: st.pending_results.length, running: Object.keys(st.mfg_research).length });
        everSent.push(msg);
        if (msg.type === 'StartResearch') { st.mfg_research[msg.region] = { product: msg.product, context: msg.context, tier: msg.tier, remaining: 7200 }; st.items[25] -= [1000, 10000, 100000][msg.tier]; }
        if (msg.type === 'ClaimResearch') st.pending_results = st.pending_results.filter((p) => p.tick !== msg.tick);
        const tick = (st.ssi.last_user_mutation_tick += 4);
        setTimeout(() => { for (const f of this.ls) f({ data: JSON.stringify({ kind: 'Diff', tick: tick + 1, diff: { tick: tick + 1, ssi: { last_user_mutation_tick: tick } } }) }); }, 30);
      }
    }
    labPage(st, FakeWS);
    (0, eval)(coreSrc + '\n' + labSrc);
    const lab = globalThis.labRunner, core = globalThis.idleCore;
    labFast(lab);
    core.ledger.clear();
    try {
      // Dry run (the default): says what it would send, once, and sends nothing.
      assert.strictEqual(lab.cfg.dryRun, true);
      lab.start();
      await waitFor(() => core.ledger.list().filter((e) => e.mod === 'LAB' && /would send/.test(e.text)).length >= 3, 2000);   // all three steps logged
      await sleep(100);
      assert.strictEqual(arrived.length, 0, 'dry run sent ' + JSON.stringify(arrived[0]?.msg));
      const would = core.ledger.list().filter((e) => e.mod === 'LAB' && /would send/.test(e.text)).map((e) => e.text.match(/"type":"(\w+)"/)[1]);
      assert.deepStrictEqual(would, ['ClaimResearch', 'StartResearch', 'StartResearch'], 'one line per step, logged once rather than at every look');
      await halt(lab);
      assert.ok(!lab.running && !lab.active);

      // Live: the claim first, then Heartland, then Industrial Basin; each only after the one before was applied.
      lab.cfg.dryRun = false;
      lab.start();
      await until(() => arrived.length >= 3);
      await sleep(120);     // anything more would show up
      assert.deepStrictEqual(arrived.map((x) => x.msg), [{ type: 'ClaimResearch', tick: 40 }, startMsg(IRON_FRAME, 0, 2, 0), startMsg(WOODEN_FRAME, 0, 1, 1)]);
      assert.deepStrictEqual(arrived.map((x) => [x.pending, x.running]), [[1, 0], [0, 0], [0, 1]], 'claim applied before the first start, first start before the second');
      const lines = core.ledger.list().filter((e) => e.mod === 'LAB' && e.kind === 'action').map((e) => e.text);
      assert.strictEqual(lines.length, 3, lines.join(' | '));
      assert.match(lines[0], /^claimed Planks · Process study · Tier I: a Planks process$/);
      assert.match(lines[1], /^started Iron Frame · Process study · Tier III in Heartland \(51% success\)$/);
      assert.match(lines[2], /^started Wooden Frame · Process study · Tier II in Industrial Basin/);
      assert.deepStrictEqual(lab.mem.counts, { [IRON_FRAME]: 1, [WOODEN_FRAME]: 1 });
      // Both slots busy: it only watches.
      await sleep(120);
      assert.strictEqual(arrived.length, 3);
      assert.ok(lab.running);

      // Custom list over three entries and two Labs: the pointer survives between rounds (A, B, then C, A).
      await halt(lab);
      const A = { product: IRON_SHEET, focus: 1, tier: 'default' }, B = { product: PLANKS, focus: 0, tier: 1 }, C = { product: WOODEN_FRAME, focus: 2, tier: 2 };
      Object.assign(lab.cfg, { mode: 'list', list: [A, B, C], tierMode: 1 });
      for (const round of [0, 1]) {
        arrived.length = 0; st.mfg_research = {};          // the projects finished
        lab.start();
        await until(() => arrived.length >= 2);
        await halt(lab);
        const want = round === 0
          ? [startMsg(IRON_SHEET, 1, 0, 0), startMsg(PLANKS, 0, 0, 1)]
          : [startMsg(WOODEN_FRAME, 2, 1, 0), startMsg(IRON_SHEET, 1, 0, 1)];
        assert.deepStrictEqual(arrived.map((x) => x.msg), want, 'round ' + round);
      }
      assert.ok(everSent.length >= 7, 'sends seen: ' + everSent.length);
      assert.ok(everSent.every((m) => m.type === 'StartResearch' || m.type === 'ClaimResearch'), JSON.stringify(everSent.map((m) => m.type)));

      // Alt+Shift+X's stop-all stops it like the other modules.
      arrived.length = 0; st.mfg_research = {};
      lab.start();
      assert.ok(lab.running);
      assert.deepStrictEqual(core.stopAll('test'), ['Lab']);
      await until(() => !lab.active, 3000);
      assert.ok(!lab.running && !lab.active);
    } finally {
      await halt(lab);
      lab._unload(); core._unload(); globalThis.idleCore = undefined; globalThis.labRunner = undefined;
      delete globalThis.document; delete globalThis.WebSocket;
    }
  });

  await t('Lab runner loop: a command the server ignores backs off and does not hold up the next one; Live is refused on a broken catalog', async () => {
    fresh();
    const st = labState({ catalyst: { 0: 1 } });
    st.pending_results = [{ tick: 40, product: PLANKS, context: 0, tier: 0 }];
    const sent = [];
    class FakeWS { constructor() { this.readyState = 1; } addEventListener() {} removeEventListener() {} send(m) { sent.push(JSON.parse(m)); } }   // never applies anything
    const { props } = labPage(st, FakeWS);
    (0, eval)(coreSrc + '\n' + labSrc);
    const lab = globalThis.labRunner, core = globalThis.idleCore;
    labFast(lab, { timeoutMs: 250, dryRun: false });
    core.ledger.clear();
    try {
      lab.start();
      await waitFor(() => core.ledger.list().filter((e) => e.mod === 'LAB' && e.kind === 'fail').length >= 2, 4000);
      await sleep(150);   // a retry before the back-off ends would show up here
      assert.deepStrictEqual(sent.map((m) => m.type), ['ClaimResearch', 'StartResearch'], 'the claim that did not take is not retried before its back-off ends, and does not block the start');
      const fails = core.ledger.list().filter((e) => e.mod === 'LAB' && e.kind === 'fail').map((e) => e.text);
      assert.strictEqual(fails.length, 2, fails.join(' | '));
      assert.match(fails[0], /^not confirmed: claim Planks · Process study · Tier I; trying again in 30 s$/);
      assert.match(fails[1], /^not confirmed: start Iron Frame · Process study · Tier III in Heartland/);
      assert.ok(lab.running, 'two misses do not stop it');
      await halt(lab);
      assert.ok(!lab.running && !lab.active);

      // Game data that no longer looks right (Building 14 is not the Lab): Live is refused and runs as a dry run.
      sent.length = 0;
      props.catalog = { ...props.catalog, buildings: [] };     // a new object: the lookup is cached per catalog object
      lab.cfg.dryRun = false;
      lab.start();
      assert.strictEqual(lab.cfg.dryRun, true, 'Live must be refused');
      await sleep(100);
      assert.strictEqual(sent.length, 0);
      assert.ok(/Live refused/.test(core.ledger.text()));
      await halt(lab);
    } finally {
      await halt(lab);
      lab._unload(); core._unload(); globalThis.idleCore = undefined; globalThis.labRunner = undefined;
      delete globalThis.document; delete globalThis.WebSocket;
    }
  });

  await t('Lab runner: stop-all covers it, and its settings travel with the toolkit export (dryRun never does)', () => {
    const { core, lab } = loadBoth();
    // stop-all
    const real = globalThis.labRunner;
    let stopped = 0;
    globalThis.labRunner = { running: true, stop: () => stopped++ };
    assert.deepStrictEqual(core.stopAll('test'), ['Lab']);
    assert.strictEqual(stopped, 1);
    globalThis.earlyGame = { running: true, stop() {} }; globalThis.cdFarm = { running: true, stop() {} };
    assert.deepStrictEqual(core.stopAll('test'), ['Autopilot', 'CD Farm', 'Lab']);
    globalThis.earlyGame = globalThis.cdFarm = undefined;
    globalThis.labRunner = real;
    assert.deepStrictEqual(core.stopAll('test'), [], 'a Lab runner that is not running is left alone');
    // export / import
    Object.assign(lab.cfg, { mode: 'list', tierMode: 2, mdReserve: 12345, autoClaim: false, list: [{ product: PLANKS, focus: 1, tier: 3 }] });
    lab.cfg.dryRun = false;
    const json = core.exportConfig();
    const exported = JSON.parse(json).labRunner;
    assert.ok(exported && !('dryRun' in exported.cfg), 'dryRun is session-only');
    assert.strictEqual(exported.cfg.mdReserve, 12345);
    Object.assign(lab.cfg, { mode: 'process', tierMode: 'best', mdReserve: 1, autoClaim: true, list: [] });
    lab.cfg.dryRun = true;
    assert.match(core.importConfig(json), /labRunner: \d+ applied/);
    const mine = () => ({ mode: lab.cfg.mode, tierMode: lab.cfg.tierMode, mdReserve: lab.cfg.mdReserve, autoClaim: lab.cfg.autoClaim, list: lab.cfg.list });
    const want = { mode: 'list', tierMode: 2, mdReserve: 12345, autoClaim: false, list: [{ product: PLANKS, focus: 1, tier: 3 }] };
    assert.deepStrictEqual(mine(), want);
    assert.strictEqual(lab.cfg.dryRun, true, 'an import never turns Live on');
    // Bad values are skipped one by one; a list with a bad entry is skipped whole
    const bad = JSON.stringify({ app: 'idlecorp-toolkit', format: 1, labRunner: { cfg: { mode: 'chaos', tierMode: 4, mdReserve: -5, autoClaim: 'yes', dryRun: false, list: [{ product: PLANKS, focus: 7, tier: 'default' }], nosuch: 1, intervalMs: 5 } } });
    const rep = core.importConfig(bad);
    assert.deepStrictEqual(mine(), want);
    assert.strictEqual(lab.cfg.dryRun, true);
    assert.match(rep, /skipped .*mode.*tierMode.*mdReserve.*autoClaim.*dryRun.*list.*nosuch.*intervalMs/);
    lab.resetCfg();
    assert.deepStrictEqual(mine(), { mode: 'process', tierMode: 'best', mdReserve: 5000, autoClaim: true, list: [] });
  });

  await t('Lab runner: settings and what it has started survive a reload; a damaged save is ignored value by value; dryRun is never saved', () => {
    fresh();
    const disk = {};
    globalThis.localStorage = { getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = String(v); }, removeItem: (k) => { delete disk[k]; } };
    const reload = () => { fresh(); (0, eval)(coreSrc + '\n' + labSrc); return globalThis.labRunner; };
    try {
      let lab = reload();
      lab.importCfg({ cfg: { mode: 'list', tierMode: 3, mdReserve: 777, list: [{ product: PLANKS, focus: 1, tier: 2, junk: 'x' }] } });
      lab.cfg.dryRun = false;
      Object.assign(lab.mem.counts, { [PLANKS]: 3 }); lab.mem.next = 4;
      lab.importCfg({ cfg: {} });     // saves again, with the counts as they are now
      lab = reload();
      assert.deepStrictEqual({ mode: lab.cfg.mode, tierMode: lab.cfg.tierMode, mdReserve: lab.cfg.mdReserve, list: lab.cfg.list }, { mode: 'list', tierMode: 3, mdReserve: 777, list: [{ product: PLANKS, focus: 1, tier: 2 }] }, 'settings come back, a list entry keeps its three fields only');
      assert.strictEqual(lab.cfg.dryRun, true, 'after a reload it is a dry run again');
      assert.deepStrictEqual(lab.mem, { counts: { [PLANKS]: 3 }, next: 4 });
      assert.ok(!disk['labRunner.v1'].includes('dryRun'), 'dryRun is not in the save');
      disk['labRunner.v1'] = JSON.stringify({ cfg: { mode: 'chaos', mdReserve: -1, dryRun: false, tierMode: 2, list: 'no' }, mem: { counts: { x: 5, 9: 'a', 41: 2 }, next: -3 } });
      lab = reload();
      assert.deepStrictEqual({ mode: lab.cfg.mode, tierMode: lab.cfg.tierMode, mdReserve: lab.cfg.mdReserve, list: lab.cfg.list, dryRun: lab.cfg.dryRun }, { mode: 'process', tierMode: 2, mdReserve: 5000, list: [], dryRun: true });
      assert.deepStrictEqual(lab.mem, { counts: { 41: 2 }, next: 0 });
      disk['labRunner.v1'] = '{not json';
      assert.strictEqual(reload().cfg.mode, 'process', 'unreadable save: defaults');
    } finally { delete globalThis.localStorage; }
  });

  // ---- Auto ship (autoSell): per-bid auto-selling by FillDeal over the socket ---------------------------------------
  const COTTON = itemId('Cotton'), WOOD = itemId('Wood');
  const WOOD_CARGO = board.catalog.items.find((i) => i.id === WOOD).cargo_weight;
  const cottonLoad = Math.floor(10000 / board.catalog.items.find((i) => i.id === COTTON).cargo_weight);
  const bid = (id, item, amount, unit, extra = {}) => ({ id, side: 'Sell', item, amount, price: amount * unit, region: 0, expires_at: 5000, ...extra });
  const asBase = (over = {}) => ({ st: { stock: { 0: { [COTTON]: 5000 } }, courier_ready_at: 0, standing_fills: {} }, catalog: board.catalog, deals: [bid(1, COTTON, 100000, 150)], tick: 100, now: 1000, ...over });
  const asJob = (over = {}) => ({ deal: 1, item: COTTON, region: 0, unit: 150, left: null, sold: 0, keep: 0, fullLoads: false, expiresAt: 5000, fails: 0, retryAt: 0, ...over });

  await t('Auto ship: a job sends one free courier load, and waits for stock, the courier, a full load, or the game\'s own auto-ship', () => {
    const { as } = (() => { fresh(); globalThis.autoSell?._unload?.(); (0, eval)(coreSrc + '\n' + asSrc); return { as: globalThis.autoSell }; })();
    try {
      const d = as._decide;
      let v = d(asJob(), asBase());
      assert.deepStrictEqual([v.kind, v.n, v.deal.id], ['send', cottonLoad, 1], 'a full free courier load');
      assert.strictEqual(d(asJob({ left: 120 }), asBase()).n, 120, 'never more than what is left to sell');
      assert.strictEqual(d(asJob(), asBase({ deals: [bid(1, COTTON, 70, 150)] })).n, 70, 'never more than the lot');
      assert.strictEqual(d(asJob({ keep: 4800 }), asBase()).n, 200, 'stock above the reserve only');
      assert.match(d(asJob({ keep: 5000 }), asBase()).why, /waiting for Cotton above 5,000/);
      assert.match(d(asJob({ fullLoads: true, keep: 4800 }), asBase()).why, /full load \(200 of 500\)/);
      assert.strictEqual(d(asJob({ fullLoads: true }), asBase()).kind, 'send');
      assert.match(d(asJob(), asBase({ st: { ...asBase().st, courier_ready_at: 110 } })).why, /courier ready in 5 s/);
      assert.strictEqual(d(asJob(), asBase({ st: { ...asBase().st, courier_ready_at: 100 } })).kind, 'send', 'ready exactly now');
      assert.match(d(asJob(), asBase({ st: { ...asBase().st, standing_fills: { 1: {} } } })).why, /own auto-ship/);
      assert.match(d(asJob({ retryAt: 5000 }), asBase()).why, /retrying in 4 s/);
      // Other regions: stock and the sent region come from the bid, not from Heartland.
      const fr = asBase({ deals: [bid(1, COTTON, 100000, 150, { region: 3 })], st: { ...asBase().st, stock: { 0: { [COTTON]: 9999 }, 3: { [COTTON]: 40 } } } });
      assert.strictEqual(d(asJob({ region: 3 }), fr).n, 40);
    } finally { as._unload(); globalThis.autoSell = undefined; globalThis.idleCore._unload(); globalThis.idleCore = undefined; }
  });

  await t('Auto ship: a job ends when the target is reached (or after 24 h with no bid), moves to the best open bid when its own is gone, and never ends because the board is not loaded', () => {
    fresh(); (0, eval)(coreSrc + '\n' + asSrc);
    const as = globalThis.autoSell, d = as._decide;
    try {
      const IRON = itemId('Iron Sheet');
      const NOW = 200000000, DAY = 86400000;
      assert.strictEqual(d(asJob({ left: 0 }), asBase()).kind, 'end', 'target reached');
      assert.strictEqual(d(asJob({ left: 0 }), asBase({ deals: [] })).kind, 'end', 'target first, even when the bid is gone');
      assert.strictEqual(d(asJob({ left: 0 }), asBase({ deals: null })).kind, 'end', 'target first, even when the board is not loaded');
      assert.strictEqual(d(asJob(), asBase({ deals: null })).kind, 'wait', 'board not loaded: keep waiting');
      assert.match(d(asJob(), asBase({ deals: null })).why, /Market board not loaded/);
      // The bid is gone: wait for another one (it used to end the job).
      let v = d(asJob(), asBase({ deals: [] }));
      assert.deepStrictEqual([v.kind, v.noBid], ['wait', true], 'bid gone, no other bid');
      assert.match(v.why, /waiting for a Cotton bid/);
      assert.strictEqual(d(asJob(), asBase({ deals: [{ ...bid(1, COTTON, 10, 150), side: 'Buy' }] })).kind, 'wait', 'an ask is never sold into');
      v = d(asJob({ expiresAt: 50 }), asBase({ deals: null }));
      assert.deepStrictEqual([v.kind, v.noBid], ['wait', true], 'known to be expired, board not loaded');
      assert.match(v.why, /bid expired/);
      // Rollover: bid 1 is gone; the highest unit price wins, in the job's own region only.
      const two = [bid(2, COTTON, 100000, 140), bid(3, COTTON, 100000, 160)];
      v = d(asJob(), asBase({ deals: two }));
      assert.deepStrictEqual([v.kind, v.deal.id], ['switch', 3], 'highest unit price');
      assert.strictEqual(d(asJob(), asBase({ deals: [two[0], bid(3, COTTON, 100000, 160, { region: 3 })] })).deal.id, 2, 'own region only');
      assert.strictEqual(d(asJob(), asBase({ deals: two, taken: new Set([3]) })).deal.id, 2, 'a bid another job holds');
      assert.strictEqual(d(asJob(), asBase({ deals: two, st: { ...asBase().st, standing_fills: { 3: {} } } })).deal.id, 2, 'a bid the game\'s own auto-ship runs on');
      assert.strictEqual(d(asJob(), asBase({ deals: [...two, bid(4, WOOD, 100000, 900)] })).deal.id, 3, 'another item is ignored');
      assert.strictEqual(d(asJob(), asBase({ deals: [two[0], bid(3, COTTON, 100000, 160, { expires_at: 100 })] })).deal.id, 2, 'expired bid skipped');
      assert.strictEqual(d(asJob(), asBase({ deals: [bid(2, COTTON, 100000, 140), bid(3, COTTON, 100000, 140)] })).deal.id, 2, 'a tie: the first on the board');
      assert.strictEqual(d(asJob(), asBase({ deals: [{ ...bid(4, COTTON, 1, 999), amount: 0 }, bid(2, COTTON, 100000, 140)] })).deal.id, 2, 'an empty lot (amount 0) is never picked');
      // Price floor: never below what a unit costs to make.
      const floor = as._unitCost(board.catalog, IRON);
      assert.ok(floor > 0);
      const ironJob = asJob({ item: IRON });
      v = d(ironJob, asBase({ deals: [bid(4, IRON, 1, floor - 1)] }));
      assert.deepStrictEqual([v.kind, v.noBid], ['wait', true], 'below the floor');
      assert.match(v.why, /≥ \$/);
      assert.strictEqual(d(ironJob, asBase({ deals: [bid(4, IRON, 1, floor)] })).deal.id, 4, 'exactly at the floor');
      // Give up after 24 h with no qualifying bid; a job that is not waiting for a bid has no clock.
      v = d(asJob({ waitSince: NOW - DAY }), asBase({ deals: [], now: NOW }));
      assert.strictEqual(v.kind, 'end');
      assert.match(v.why, /no Cotton bid at ≥ \$1\.35 for 24 h/);
      v = d(asJob({ waitSince: NOW - DAY + 1 }), asBase({ deals: [], now: NOW }));
      assert.deepStrictEqual([v.kind, v.noBid], ['wait', true]);
      assert.strictEqual(d(asJob({ waitSince: 0 }), asBase({ deals: [], now: NOW })).kind, 'wait');
      assert.strictEqual(d(asJob({ waitSince: NOW - DAY }), asBase({ deals: null, now: NOW, tick: 1e9 })).kind, 'end', 'expired bid on an unloaded board: same clock');
      v = d(asJob({ waitSince: NOW - 2 * DAY }), asBase({ now: NOW, st: { ...asBase().st, stock: {} } }));
      assert.deepStrictEqual([v.kind, v.noBid], ['wait', undefined], 'a live bid waiting for stock is not waiting for a bid');
    } finally { as._unload(); globalThis.autoSell = undefined; globalThis.idleCore._unload(); globalThis.idleCore = undefined; }
  });

  await t('Auto ship loop: confirmed FillDeal per courier run, two jobs share the courier, no slot limit, stop-all stops it, jobs survive a reload', async () => {
    fresh();
    const disk = {};
    globalThis.localStorage = { getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = v; } };
    const st = baseState();
    st.stock = { 0: { [COTTON]: 1200, [WOOD]: 600 } };
    st.courier_ready_at = 0; st.next_shipment_id = 10; st.standing_fills = {};
    const deals = [bid(7, COTTON, 100000, 150), bid(8, WOOD, 100000, 90)];
    const sent = [];
    let courierBusy = 0;     // ticks the courier stays busy after a send
    class FakeWS {
      constructor() { this.readyState = 1; this.ls = []; }
      addEventListener(_t, f) { this.ls.push(f); } removeEventListener() {}
      send(m) {
        const msg = JSON.parse(m); sent.push(msg);
        const tick = (st.ssi.last_user_mutation_tick += 4);
        st.stock[msg.region][deals.find((x) => x.id === msg.deal).item] -= msg.amount;
        st.next_shipment_id++;
        st.courier_ready_at = tick + courierBusy;
        setTimeout(() => { for (const f of this.ls) f({ data: JSON.stringify({ kind: 'Diff', tick: tick + 1, diff: { tick: tick + 1, ssi: { last_user_mutation_tick: tick } } }) }); }, 20);
      }
    }
    const { props } = labPage(st, FakeWS);
    // The bid board is a React hook value too (an array of rows with side/price and no poster).
    const root = globalThis.document.getElementById('root');
    const fiber = root.__reactContainer$x;
    fiber.memoizedState.next.next = { memoizedState: deals, next: null };
    void props;
    (0, eval)(coreSrc + '\n' + asSrc);
    const as = globalThis.autoSell, core = globalThis.idleCore;
    Object.assign(as.cfg, { cycleMs: 40, confirmMs: 3000, jitterMs: 0 });   // wide: a slow machine must not read as "not confirmed"
    core.ledger.clear();
    try {
      courierBusy = 100000;                                  // after the first send the courier stays busy
      as.start({ deal: 7, total: 700 });
      as.start({ deal: 8, total: null, keep: 100 });         // a second job: the game's own slot would not allow it
      assert.deepStrictEqual(as.items().sort((a, z) => a - z), [COTTON, WOOD].sort((a, z) => a - z));
      await until(() => sent.length >= 1);
      await sleep(250);
      assert.strictEqual(sent.length, 1, 'one send per courier run: the courier is busy for the other job');
      // Cotton has the higher unit price, so it goes first: one full load, FillDeal as the Sell dialog sends it.
      assert.deepStrictEqual(sent[0], { type: 'FillDeal', deal: 7, amount: cottonLoad, hire: null, region: 0, courier: true });
      assert.strictEqual(st.next_shipment_id, 11);
      let j7 = as.jobs().find((x) => x.deal === 7);
      assert.deepStrictEqual([j7.sold, j7.left], [cottonLoad, 700 - cottonLoad]);
      // Courier back: the other job (served least recently) is next, with its reserve kept.
      st.courier_ready_at = 0; courierBusy = 0;
      await until(() => sent.length >= 2);
      assert.deepStrictEqual(sent[1], { type: 'FillDeal', deal: 8, amount: Math.min(500, Math.floor(10000 / WOOD_CARGO)), hire: null, region: 0, courier: true }, 'Wood: 600 in stock - 100 kept = 500, capped at one free courier load');
      // With the courier always free, Cotton finishes its target (700 = 500 + 200) and the job ends by itself.
      await until(() => !as.jobs().some((x) => x.deal === 7), 3000);
      assert.deepStrictEqual(sent.filter((m) => m.deal === 7).map((m) => m.amount), [500, 200]);
      assert.ok(core.ledger.list().some((e) => e.mod === 'AS' && /ended: target reached \(700 sold\)/.test(e.text)));
      // The save holds the job that is left; a reload resumes it.
      assert.deepStrictEqual(JSON.parse(disk['autoSell.v1']).jobs.map((x) => x.deal), [8]);
      as._unload();
      globalThis.autoSell = undefined;
      (0, eval)(asSrc);
      assert.deepStrictEqual(globalThis.autoSell.jobs().map((x) => x.deal), [8], 'resumed from the save');
      // Stop-all (Alt+Shift+X) stops every job.
      assert.deepStrictEqual(core.stopAll('test'), ['Auto ship']);
      assert.strictEqual(globalThis.autoSell.jobs().length, 0);
      assert.deepStrictEqual(JSON.parse(disk['autoSell.v1']).jobs, []);
    } finally {
      globalThis.autoSell?._unload(); core._unload(); globalThis.idleCore = undefined; globalThis.autoSell = undefined;
      delete globalThis.document; delete globalThis.WebSocket; delete globalThis.localStorage;
    }
  });

  await t('Auto ship loop: a job whose bid is gone moves to the best open bid and keeps its totals, survives a reload, two jobs never take the same bid, and it gives up after cfg.bidWaitMs', async () => {
    fresh();
    const disk = {};
    globalThis.localStorage = { getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = v; } };
    const st = baseState();
    st.stock = { 0: { [COTTON]: 1200 } };
    st.courier_ready_at = 0; st.next_shipment_id = 10; st.standing_fills = {};
    const deals = [bid(7, COTTON, 100000, 150)];
    const sent = [];
    class FakeWS {
      constructor() { this.readyState = 1; this.ls = []; }
      addEventListener(_t, f) { this.ls.push(f); } removeEventListener() {}
      send(m) {
        const msg = JSON.parse(m); sent.push(msg);
        const tick = (st.ssi.last_user_mutation_tick += 4);
        st.stock[msg.region][deals.find((x) => x.id === msg.deal).item] -= msg.amount;
        st.next_shipment_id++;
        st.courier_ready_at = tick + 100000;
        setTimeout(() => { for (const f of this.ls) f({ data: JSON.stringify({ kind: 'Diff', tick: tick + 1, diff: { tick: tick + 1, ssi: { last_user_mutation_tick: tick } } }) }); }, 20);
      }
    }
    labPage(st, FakeWS);
    globalThis.document.getElementById('root').__reactContainer$x.memoizedState.next.next = { memoizedState: deals, next: null };
    (0, eval)(coreSrc + '\n' + asSrc);
    let as = globalThis.autoSell;
    const core = globalThis.idleCore;
    const timing = { cycleMs: 40, confirmMs: 3000, jitterMs: 0 };
    Object.assign(as.cfg, timing);
    core.ledger.clear();
    const saved = () => JSON.parse(disk['autoSell.v1']).jobs;
    try {
      as.start({ deal: 7, total: 700 });
      await until(() => sent.length >= 1);
      assert.strictEqual(sent[0].deal, 7);
      // Bid 7 is filled; two new bids open. The same job moves to the better one (the same object: sold, left, revenue carry over).
      deals.splice(deals.findIndex((x) => x.id === 7), 1, bid(11, COTTON, 100000, 130), bid(12, COTTON, 100000, 170));
      await until(() => as.jobs().some((x) => x.deal === 12));
      let j = as.jobs()[0];
      assert.deepStrictEqual([as.jobs().length, j.from, j.unit, j.sold, j.left, j.revenue], [1, 7, 170, cottonLoad, 700 - cottonLoad, cottonLoad * 150]);
      assert.ok(core.ledger.list().some((e) => e.mod === 'AS' && /moved: bid #7 @ \$1\.50 → #12 @ \$1\.70/.test(e.text)));
      assert.deepStrictEqual([saved().length, saved()[0].deal, saved()[0].from, saved()[0].waitSince, saved()[0].unit0], [1, 12, 7, 0, 150]);
      // A reload resumes the job on the new bid.
      as._unload(); globalThis.autoSell = undefined;
      (0, eval)(asSrc);
      as = globalThis.autoSell;
      Object.assign(as.cfg, timing);
      assert.deepStrictEqual(as.jobs().map((x) => [x.deal, x.sold]), [[12, cottonLoad]], 'resumed on the new bid');
      // The courier is free again: the next FillDeal goes to bid 12, and the job ends at its target.
      // (The test page has no navigation, so the resume loop never starts by itself: start() on the restored job does it.)
      as.start({ deal: 12, total: 700 - cottonLoad });
      st.courier_ready_at = 0;
      await until(() => !as.jobs().length, 8000);
      assert.deepStrictEqual(sent.map((m) => m.deal), [7, 12]);
      assert.strictEqual(sent[1].amount, 700 - cottonLoad);
      assert.ok(core.ledger.list().some((e) => e.mod === 'AS' && /ended: target reached \(700 sold\)/.test(e.text)));
      assert.deepStrictEqual(saved(), []);

      // Two jobs whose bids both vanish, one replacement: one moves, the other waits (the replacement is taken).
      st.courier_ready_at = 1e9;
      deals.splice(0, deals.length, bid(21, COTTON, 100000, 150), bid(22, COTTON, 100000, 140));
      as.start({ deal: 21 }); as.start({ deal: 22 });
      deals.splice(0, deals.length, bid(23, COTTON, 100000, 160));
      await until(() => as.jobs().some((x) => x.deal === 23));
      await sleep(200);
      assert.deepStrictEqual(as.jobs().map((x) => x.deal).sort(), [22, 23], 'the other job did not take bid 23');
      assert.match(as.jobs().find((x) => x.deal === 22).status, /waiting for a Cotton bid/i);
      await until(() => saved().some((x) => x.deal === 22 && x.waitSince > 0));
      // A bid that comes back ends the wait: the clock is reset.
      deals.push(bid(24, COTTON, 100000, 130));
      await until(() => as.jobs().some((x) => x.deal === 24));
      assert.deepStrictEqual(saved().map((x) => x.waitSince), [0, 0]);

      // Give up: no bid for cfg.bidWaitMs ends both jobs.
      as.cfg.bidWaitMs = 200;
      deals.splice(0, deals.length, bid(99, WOOD, 100000, 90));   // an empty array would read as "board not loaded"
      await until(() => !as.jobs().length, 8000);
      assert.ok(core.ledger.list().some((e) => e.mod === 'AS' && /ended: no Cotton bid .* for 24 h/.test(e.text)));
      assert.deepStrictEqual(saved(), []);
    } finally {
      globalThis.autoSell?._unload(); core._unload(); globalThis.idleCore = undefined; globalThis.autoSell = undefined;
      delete globalThis.document; delete globalThis.WebSocket; delete globalThis.localStorage;
    }
  });

  await t('Auto ship loop: a moved job never takes a bid below cfg.switchFloorPct of the first bid (unit0), however many times it moved, and unit0 survives a reload', async () => {
    fresh();
    const disk = {};
    globalThis.localStorage = { getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = v; } };
    const st = baseState();
    st.stock = { 0: { [COTTON]: 1200 } };
    st.courier_ready_at = 1e9; st.next_shipment_id = 10; st.standing_fills = {};   // courier busy: nothing is sent, only moves are tested
    const deals = [bid(31, COTTON, 100000, 200)];
    class FakeWS { constructor() { this.readyState = 1; } addEventListener() {} removeEventListener() {} send() {} }
    labPage(st, FakeWS);
    globalThis.document.getElementById('root').__reactContainer$x.memoizedState.next.next = { memoizedState: deals, next: null };
    (0, eval)(coreSrc + '\n' + asSrc);
    let as = globalThis.autoSell;
    const core = globalThis.idleCore;
    const timing = { cycleMs: 40, confirmMs: 3000, jitterMs: 0 };
    Object.assign(as.cfg, timing);
    core.ledger.clear();
    const saved = () => JSON.parse(disk['autoSell.v1']).jobs;
    const open = (...bids) => deals.splice(0, deals.length, ...bids);
    try {
      assert.strictEqual(as.cfg.switchFloorPct, 90);
      as.start({ deal: 31 });
      assert.strictEqual(saved()[0].unit0, 200, 'unit0 is the first bid');
      // Bid 31 is gone; the only bid is below 90% of $2.00: the job waits, it does not move.
      open(bid(32, COTTON, 100000, 179));
      await until(() => saved().some((x) => x.waitSince > 0));
      await sleep(200);
      assert.deepStrictEqual([as.jobs().length, as.jobs()[0].deal], [1, 31], 'bid 32 is below the floor: no move');
      assert.match(as.jobs()[0].status, /waiting for a Cotton bid at ≥ \$1\.80/i);
      // Exactly 90% is taken.
      deals.push(bid(33, COTTON, 100000, 180));
      await until(() => as.jobs().some((x) => x.deal === 33));
      assert.deepStrictEqual([as.jobs()[0].unit, saved()[0].unit0, as.jobs()[0].from], [180, 200, 31]);
      // After one move the floor is still 90% of the first bid ($1.80), not of the second ($1.62): $1.70 is refused.
      open(bid(34, COTTON, 100000, 170));
      await until(() => saved().some((x) => x.waitSince > 0));
      await sleep(200);
      assert.deepStrictEqual([as.jobs()[0].deal, saved()[0].unit0], [33, 200], 'bid 34 is above 90% of the second bid but below 90% of the first');
      deals.push(bid(35, COTTON, 100000, 185));
      await until(() => as.jobs().some((x) => x.deal === 35));
      assert.deepStrictEqual([as.jobs()[0].unit, saved()[0].unit0], [185, 200], 'second move: unit0 unchanged');
      assert.deepStrictEqual([saved()[0].deal, saved()[0].unit0], [35, 200], 'persisted');
      // A reload keeps unit0.
      as._unload(); globalThis.autoSell = undefined;
      (0, eval)(asSrc);
      as = globalThis.autoSell;
      Object.assign(as.cfg, timing);
      assert.deepStrictEqual(as.jobs().map((x) => x.deal), [35], 'resumed on the moved bid');
      as.start({ deal: 35 });
      // After the reload the floor is still $1.80 (unit0 was restored): a $1.70 bid is refused and the job ends after cfg.bidWaitMs.
      as.cfg.bidWaitMs = 300;
      open(bid(36, COTTON, 100000, 170));
      await until(() => !as.jobs().length, 8000);
      assert.ok(core.ledger.list().some((e) => e.mod === 'AS' && /ended: no Cotton bid at ≥ \$1\.80 for 24 h/.test(e.text)));
      assert.deepStrictEqual(saved(), []);
    } finally {
      globalThis.autoSell?._unload(); core._unload(); globalThis.idleCore = undefined; globalThis.autoSell = undefined;
      delete globalThis.document; delete globalThis.WebSocket; delete globalThis.localStorage;
    }
  });

  await t('Auto ship loop: a send the server never applies backs off, and five in a row end the job; the game\'s own auto-ship is left alone', async () => {
    fresh();
    const st = baseState();
    st.stock = { 0: { [COTTON]: 1200 } };
    st.courier_ready_at = 0; st.next_shipment_id = 10; st.standing_fills = {};
    const deals = [bid(7, COTTON, 100000, 150), bid(9, COTTON, 100000, 140)];
    const sent = [];
    class FakeWS { constructor() { this.readyState = 1; } addEventListener() {} removeEventListener() {} send(m) { sent.push(JSON.parse(m)); } }   // applies nothing
    labPage(st, FakeWS);
    globalThis.document.getElementById('root').__reactContainer$x.memoizedState.next.next = { memoizedState: deals, next: null };
    (0, eval)(coreSrc + '\n' + asSrc);
    const as = globalThis.autoSell, core = globalThis.idleCore;
    Object.assign(as.cfg, { cycleMs: 30, confirmMs: 60, jitterMs: 0, backoffMs: 5 });
    core.ledger.clear();
    try {
      st.standing_fills = { 9: { region: 0, remaining: null, filled: 5 } };
      as.start({ deal: 9 });
      await sleep(300);
      assert.strictEqual(sent.length, 0, 'the game\'s auto-ship already runs on bid 9: nothing is sent for it');
      as.stop(9);
      as.start({ deal: 7 });
      await until(() => !as.jobs().length, 20000);
      assert.strictEqual(as.jobs().length, 0, 'the job ended');
      assert.strictEqual(sent.length, 5, 'exactly MAX_FAILS sends, with a back-off between them');
      assert.ok(core.ledger.list().some((e) => e.mod === 'AS' && e.kind === 'fail' && /did not apply 5 sends in a row/.test(e.text)));
    } finally {
      as._unload(); core._unload(); globalThis.idleCore = undefined; globalThis.autoSell = undefined;
      delete globalThis.document; delete globalThis.WebSocket;
    }
  });


  await t('Auto ship profit: cost = the recipe inputs at base value (raw is free), actual profit is booked per send, estimate adds the margin on what is left', async () => {
    fresh();
    const IRON = itemId('Iron Sheet');
    const recs = board.catalog.recipes.filter((r) => r.outputs.some((o) => o.item === IRON));
    const baseOf = (i) => board.catalog.items.find((x) => x.id === i).base_value;
    const expectCost = Math.min(...recs.map((r) => r.inputs.reduce((s, x) => s + x.amount * baseOf(x.item), 0) * baseOf(IRON) / r.outputs.reduce((s, o) => s + o.amount * baseOf(o.item), 0)));
    const st = baseState();
    st.stock = { 0: { [IRON]: 500, [COTTON]: 5000 } };
    st.courier_ready_at = 0; st.next_shipment_id = 10; st.standing_fills = {};
    const deals = [bid(5, IRON, 300, 6000), bid(6, COTTON, 100000, 150), bid(103, IRON, 500, 3000)];
    const sent = [];
    class FakeWS {
      constructor() { this.readyState = 1; this.ls = []; }
      addEventListener(_t, f) { this.ls.push(f); } removeEventListener() {}
      send(m) {
        const msg = JSON.parse(m); sent.push(msg);
        const tick = (st.ssi.last_user_mutation_tick += 4);
        const dl = deals.find((x) => x.id === msg.deal);
        st.stock[msg.region][dl.item] -= msg.amount ?? dl.amount;
        st.next_shipment_id++; st.courier_ready_at = tick + 100000;
        setTimeout(() => { for (const f of this.ls) f({ data: JSON.stringify({ kind: 'Diff', tick: tick + 1, diff: { tick: tick + 1, ssi: { last_user_mutation_tick: tick } } }) }); }, 20);
      }
    }
    const disk = {};
    globalThis.localStorage = { getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = v; } };
    labPage(st, FakeWS);
    globalThis.document.getElementById('root').__reactContainer$x.memoizedState.next.next = { memoizedState: deals, next: null };
    (0, eval)(coreSrc + '\n' + asSrc);
    const as = globalThis.autoSell, core = globalThis.idleCore;
    Object.assign(as.cfg, { cycleMs: 40, confirmMs: 3000, jitterMs: 0 });   // wide: a slow machine must not read as "not confirmed"
    core.ledger.clear();
    try {
      assert.ok(expectCost > 0, 'Iron Sheet has a recipe cost');
      assert.strictEqual(as._unitCost(board.catalog, IRON), expectCost);
      assert.strictEqual(as._unitCost(board.catalog, COTTON), 0, 'raw materials are free');
      assert.strictEqual(as._unitCost(board.catalog, 99999), 0, 'no recipe: free');
      as.start({ deal: 5 });
      let j = as.jobs().find((x) => x.deal === 5);
      assert.strictEqual(j.profit, 0);
      assert.strictEqual(j.estProfit, Math.round(300 * (6000 - expectCost)), 'estimate before the first send: margin x the open lot');
      await until(() => sent.length >= 1);
      // booked (after the confirm) and the open lot re-read by the next cycle: both come from timers, so wait for them, not for a guessed time
      await until(() => { const x = as.jobs().find((y) => y.deal === 5); return x.revenue > 0 && x.estProfit > x.profit; }, 8000);
      j = as.jobs().find((x) => x.deal === 5);
      assert.strictEqual(sent[0].amount, null, 'the whole lot');
      assert.strictEqual(j.revenue, 300 * 6000);
      assert.strictEqual(j.cost, Math.round(300 * expectCost));
      assert.strictEqual(j.profit, 300 * 6000 - Math.round(300 * expectCost));
      assert.strictEqual(j.estProfit, Math.round(j.profit + 300 * (6000 - expectCost)), 'actual so far + margin on what the bid still wants');
      assert.ok(core.ledger.list().some((e) => e.mod === 'AS' && /auto ship 300 Iron Sheet @ \$60\.00 = \$18,000\.00, profit \$/.test(e.text)), 'the send line shows the profit');
      assert.match(as.status(), /Iron Sheet #5: 300 sold, until stopped, profit \$/);
      // The profit numbers and the open lot are saved and come back after a reload; a save from before profit existed loads as zero, not NaN.
      const before = as.jobs().find((x) => x.deal === 5);
      const savedJob = JSON.parse(disk['autoSell.v1']).jobs.find((x) => x.deal === 5);
      assert.deepStrictEqual([savedJob.revenue, savedJob.cogs, savedJob.lot], [before.revenue, before.cost, 0], 'revenue, cost and the open lot are saved (the whole lot was sent, so none is left open)');
      as._unload(); globalThis.autoSell = undefined;
      disk['autoSell.v1'] = JSON.stringify({ jobs: [...JSON.parse(disk['autoSell.v1']).jobs, { deal: 6, item: COTTON, region: 0, unit: 150, left: null, sold: 12, keep: 0, fullLoads: false, expiresAt: 5000 }] });
      (0, eval)(asSrc);
      const as2 = globalThis.autoSell;
      Object.assign(as2.cfg, { cycleMs: 40, confirmMs: 3000, jitterMs: 0 });
      const back = as2.jobs().find((x) => x.deal === 5);
      assert.deepStrictEqual([back.revenue, back.cost, back.profit], [before.revenue, before.cost, before.profit], 'profit survives a reload');
      const old = as2.jobs().find((x) => x.deal === 6);
      assert.deepStrictEqual([old.revenue, old.cost, old.profit, Number.isFinite(old.estProfit)], [0, 0, 0, true], 'an old save has no profit numbers: zero, not NaN');
      // A job with a target: estimate = what is booked + margin x what is left (a loss when the bid pays less than the inputs cost).
      as2.start({ deal: 103, total: 200 });
      assert.strictEqual(as2.jobs().find((x) => x.deal === 103).estProfit, Math.round(200 * (3000 - expectCost)));
      as2.stop(103);
      as2.stop(5);
      assert.ok(core.ledger.list().some((e) => e.mod === 'AS' && /ended: stopped \(300 sold\), profit \$/.test(e.text)), 'the end line shows the profit');
      // A raw job: no cost, profit = revenue; until stopped, the estimate counts the open lot.
      as.start({ deal: 6 });
      const c = as.jobs().find((x) => x.deal === 6);
      assert.strictEqual(c.estProfit, 100000 * 150);
    } finally {
      globalThis.autoSell?._unload(); core._unload(); globalThis.idleCore = undefined; globalThis.autoSell = undefined;
      delete globalThis.document; delete globalThis.WebSocket; delete globalThis.localStorage;
    }
  });

  // ---- Auto utilities (autoUtil): the grid service / waterworks subscription follows the load ------------------------------
  const utSrc = () => { const f = require('fs').readFileSync(path.join(__dirname, '..', 'ic-autopilot.user.js'), 'utf8'); return f.slice(f.indexOf('// @@MODULE utilities'), f.indexOf('// @@END utilities')); };
  const loadUt = () => { fresh(); globalThis.autoUtil?._unload?.(); globalThis.autoUtil = undefined; (0, eval)(coreSrc + '\n' + utSrc()); return { ut: globalThis.autoUtil, core: globalThis.idleCore }; };
  const unloadUt = () => { globalThis.autoUtil?._unload(); globalThis.idleCore?._unload(); globalThis.idleCore = undefined; globalThis.autoUtil = undefined; globalThis.earlyGame = undefined; delete globalThis.document; delete globalThis.WebSocket; delete globalThis.localStorage; };
  const recOf = (building) => board.catalog.recipes.find((r) => r.building === building && !r.generates);
  const WORKSHOP = 8, SMELTER = 5, CHEM = 24, PUMP = 34, COAL_PLANT = 19, SOLAR = 20, BATTERY = 21;
  const run = (building, count, recipe, runs = count, extra = {}) => ({ building, count, recipe, work: runs ? [{ recipe, runs, remaining: 10 }] : [], ...extra });

  await t('Auto utilities: need = running draw + sold - generated - stored - bought, stalled groups add what they wait for, paused and idle ones add nothing', () => {
    const { ut } = loadUt();
    try {
      const cat = board.catalog, chair = recOf(WORKSHOP).id, smelt = recOf(SMELTER);
      const st = baseState();
      st.subscriptions = { 0: { power: 12 } };
      st.groups = { 1: run(WORKSHOP, 4, chair), 2: run(SMELTER, 1, smelt.id) };
      const m = (util = 'power', s = st, tick = 100, contracts = []) => ut._measure(util, 0, s, cat, tick, contracts);
      assert.deepStrictEqual([m().load, m().need, m().have], [6, 6, 12], 'Workshop x4 (1 MW each) + Smelter x1 (2 MW)');
      assert.deepStrictEqual(ut._want(m()), { want: 6, over: 0 });
      assert.strictEqual(ut._want(m(), 2).want, 8, 'spare is added on top');
      assert.strictEqual(ut._want(m(), 2, 10).want, 10, 'a floor wins over a lower need');
      assert.strictEqual(ut._want({ ...m(), need: -30 }, 3).want, 0, 'nothing needed: no spare, no subscription');
      assert.deepStrictEqual(ut._want({ ...m(), util: 'power', need: 250.2 }), { want: 200, over: 251 }, 'capped at 200 MW and flagged');
      assert.strictEqual(ut._want({ util: 'water', need: 120.01 }).want, 121, 'rounded up to a whole unit');
      assert.strictEqual(ut._want({ util: 'water', need: 900 }).want, 500, 'water caps at 500 kL');
      // Paused or idle groups draw nothing; a paused group is never "waiting".
      st.groups[3] = run(SMELTER, 3, smelt.id, 0, { paused: true });
      assert.strictEqual(m().need, 6);
      // Stalled: idle, not paused, inputs in stock, and its draw is more than the free capacity.
      delete st.groups[3];
      st.groups[4] = run(SMELTER, 3, smelt.id, 0);                                  // wants 6 MW; free is 12 - 6 = 6: it can start
      st.stock = { 0: Object.fromEntries(smelt.inputs.map((i) => [i.item, i.amount * 5])) };
      assert.strictEqual(m().waiting, 0);
      st.subscriptions[0].power = 8;                                                // free is now 2: stalled
      assert.deepStrictEqual([m().waiting, m().need], [6, 12], 'it waits for 6 MW');
      st.groups[4].equipped = 0;
      assert.strictEqual(m().waiting, 0, 'no machines yet (equipped 0): the game calls it unequipped, it cannot start whatever the power');
      st.groups[4].equipped = 3;
      assert.strictEqual(m().waiting, 6, 'with machines it waits');
      st.stock = { 0: {} };
      assert.strictEqual(m().waiting, 0, 'no inputs: not waiting for power');
      st.stock = { 0: Object.fromEntries(smelt.inputs.map((i) => [i.item, i.amount])) };
      st.groups[4].paused = true;
      assert.strictEqual(m().waiting, 0, 'paused: not waiting');
      delete st.groups[4];
      // Generation (a coal plant), diurnal generation (solar at night), storage, contracts.
      st.groups[5] = run(COAL_PLANT, 1, 72, 2);                                     // 2 runs x 25 MW
      assert.deepStrictEqual([m().gen, m().need], [50, 6 - 50]);
      delete st.groups[5];
      const solar = { 6: run(SOLAR, 1, 73, 3) };
      Object.assign(st.groups, solar);
      assert.strictEqual(m('power', st, 100).gen, 72, 'daylight: 3 x 24');
      assert.strictEqual(m('power', st, 25000).gen, Math.floor(72 * 25 / 100), 'night: 25%');
      assert.strictEqual(m('power', st, 28800 + 100).gen, 72, 'next day');
      delete st.groups[6];
      st.building_pool = { 0: { [BATTERY]: 2 } }; st.stored = { 0: { power: 1000 } };
      assert.strictEqual(m().discharge, 2 * 18, 'two Battery Banks can discharge 18 MW each');
      st.stored = { 0: { power: 5 } };
      assert.strictEqual(m().discharge, 5, 'never more than is held');
      st.building_pool = { 0: {} };
      const deals = [
        { utility: 'power', region: 0, state: 'Active', seller: 1, buyer: 9, amount: 8, delivered: 3 },
        { utility: 'power', region: 0, state: 'Active', seller: 9, buyer: 1, amount: 5, delivered: 2 },
        { utility: 'power', region: 0, state: 'Ended', seller: 1, buyer: 9, delivered: 50 },
        { utility: 'water', region: 0, state: 'Active', seller: 1, buyer: 9, delivered: 50 },
        { utility: 'power', region: 1, state: 'Active', seller: 1, buyer: 9, delivered: 50 }];
      assert.deepStrictEqual([m('power', st, 100, deals).sold, m('power', st, 100, deals).imported, m('power', st, 100, deals).need], [8, 2, 6 + 8 - 2], 'sold = what is promised (8), bought = what arrives (2)');
      // Water: Chemical Plant draws 4 kL per building, a Pump Station run makes 40 kL, a Water Tower holds spare supply.
      st.groups = { 1: run(CHEM, 2, recOf(CHEM).id), 2: run(PUMP, 1, 117, 1) };
      st.subscriptions = { 0: { water: 30 } };
      const w = m('water');
      assert.deepStrictEqual([w.load, w.gen, w.need], [8, 40, 8 - 40]);
      assert.strictEqual(m('power').load, 3 * 2 + 4, 'the same groups also draw power: Chemical Plant 3 MW x 2, Pump Station 4 MW');
      // Another region is measured on its own groups and its own subscription.
      st.groups[7] = run(WORKSHOP, 5, chair, 5, { region: 2 });
      st.subscriptions[2] = { power: 1 };
      assert.deepStrictEqual([ut._measure('power', 2, st, cat, 100, []).load, ut._measure('power', 2, st, cat, 100, []).have], [5, 1]);
      assert.strictEqual(ut._measure('power', 0, st, cat, 100, []).load, 10, 'Heartland does not see the region 2 group');
    } finally { unloadUt(); }
  });

  await t('Auto utilities: raise at once (cut to what cash pays), lower only after the hold window, just before a bill, never on unreadable contracts', () => {
    const { ut } = loadUt();
    try {
      const d = (o) => ut._decide({ util: 'power', have: 12, want: 12, peak: 12, observedMs: 3600000, holdMs: 600000, money: 1e7, ticksToBill: 60, ...o });
      assert.deepStrictEqual(d({ want: 14, peak: 14 }), { kind: 'raise', level: 14, partial: false });
      assert.deepStrictEqual(d({ want: 14, peak: 14, money: 4500 }), { kind: 'raise', level: 14, partial: false }, 'each extra MW costs $10 now and $10 in the next bill: 2 MW = $40');
      assert.deepStrictEqual(d({ want: 14, peak: 14, money: 3000 }), { kind: 'raise', level: 13, partial: true }, '$30 covers 1 MW (now + next bill), not 2');
      assert.strictEqual(d({ want: 14, peak: 14, money: 1999 }).kind, 'broke', 'under $20: not even 1 MW');
      assert.deepStrictEqual(d({ want: 14, peak: 14, money: 5000, bills: 2000 }), { kind: 'raise', level: 13, partial: true }, 'the bill that is due as it is comes off the cash first');
      assert.strictEqual(d({ want: 14, peak: 14, money: 2000, bills: 2500 }).kind, 'broke', 'cash that cannot pay the bill itself buys nothing');
      assert.deepStrictEqual(d({ util: 'water', have: 0, want: 20, peak: 20, money: 1000 }), { kind: 'raise', level: 1, partial: true }, 'water: $4 per kL, twice');
      assert.strictEqual(d({ want: 14, peak: 14, observedMs: 0, ticksToBill: 1000 }).kind, 'raise', 'a raise never waits');
      assert.strictEqual(d({ want: 8, peak: 12 }).kind, 'ok', 'the highest need of the window is still the level');
      assert.deepStrictEqual(d({ want: 8, peak: 9 }), { kind: 'lower', level: 9 }, 'lowers to the window peak, not to the current need');
      assert.strictEqual(d({ want: 8, peak: 8, observedMs: 590000 }).kind, 'hold', 'watched for less than the hold');
      assert.match(d({ want: 8, peak: 8, observedMs: 590000 }).why, /watching/);
      assert.match(d({ want: 8, peak: 8, ticksToBill: 700 }).why, /next bill/);
      assert.strictEqual(d({ want: 8, peak: 8, ticksToBill: 120 }).kind, 'lower', 'in the last minute before the bill');
      assert.strictEqual(d({ want: 8, peak: 8, ticksToBill: null }).kind, 'lower', 'tick unknown: do not wait forever');
      assert.match(d({ want: 8, peak: 8, canLower: false }).why, /contracts/);
      assert.strictEqual(d({ want: 12, peak: 12 }).kind, 'ok');
    } finally { unloadUt(); }
  });

  await t('Auto utilities loop: SetSubscription per confirmed change, lowers after the hold, off means no sends, 3 unconfirmed changes switch it off, state survives a reload', async () => {
    fresh();
    const disk = {};
    globalThis.localStorage = { getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = v; } };
    const st = baseState();
    st.items = { 0: 1000000, 24: 0, 111: 0 };
    const chair = recOf(WORKSHOP).id;
    st.groups = { 1: run(WORKSHOP, 4, chair), 2: run(SMELTER, 1, recOf(SMELTER).id) };   // 6 MW
    st.subscriptions = { 0: { power: 4 } };
    const sent = [];
    let apply = true;
    class FakeWS {
      constructor() { this.readyState = 1; this.ls = []; }
      addEventListener(_t, f) { this.ls.push(f); } removeEventListener() {}
      send(m) {
        const msg = JSON.parse(m); sent.push(msg);
        const tick = (st.ssi.last_user_mutation_tick += 4);
        if (apply) { st.subscriptions[msg.region] = { ...st.subscriptions[msg.region], [msg.utility]: msg.level }; st.items[0] -= 100; }
        setTimeout(() => { for (const f of this.ls) f({ data: JSON.stringify({ kind: 'Diff', tick: tick + 1, diff: { tick: tick + 1, ssi: { last_user_mutation_tick: tick } } }) }); }, 10);
      }
    }
    const { props } = labPage(st, FakeWS);
    props.contracts = [];
    (0, eval)(coreSrc + '\n' + utSrc());
    const ut = globalThis.autoUtil, core = globalThis.idleCore;
    Object.assign(ut.cfg, { confirmMs: 3000, backoffMs: 0, cycleMs: 1e9 });       // the test drives the steps itself, with its own clock
    core.ledger.clear();
    const T0 = 1e12, MIN = 60000;
    try {
      assert.deepStrictEqual([ut.conf.power.on, ut.conf.water.on, ut.running], [false, false, false], 'off by default');
      await ut._step(T0);
      assert.strictEqual(sent.length, 0, 'off: nothing is sent');
      ut.set('power', true);
      assert.strictEqual(ut.running, true);
      await ut._step(T0);
      assert.deepStrictEqual(sent, [{ type: 'SetSubscription', region: 0, utility: 'power', level: 6 }], 'raised to the 6 MW the groups draw');
      assert.strictEqual(st.subscriptions[0].power, 6);
      assert.ok(core.ledger.list().some((e) => e.mod === 'AU' && /power grid service 4 → 6 MW/.test(e.text)), JSON.stringify(core.ledger.list().map((e) => e.text)));
      await ut._step(T0 + 1000);
      assert.strictEqual(sent.length, 1, 'at the level: nothing more');
      // Load grows: raised at once.
      st.groups[3] = run(WORKSHOP, 2, chair);
      await ut._step(T0 + 2000);
      assert.strictEqual(sent.at(-1).level, 8);
      // Load falls to 2 MW: the level is kept until the window has passed with the load low, and then goes to the window peak.
      delete st.groups[1]; delete st.groups[3];
      await ut._step(T0 + 3 * MIN);
      await ut._step(T0 + 9 * MIN);
      assert.strictEqual(sent.length, 2, 'inside the hold window the highest need still counts');
      await ut._step(T0 + 13 * MIN);
      assert.strictEqual(sent.length, 2, 'the hold has passed, but the next bill is far: it waits for the minute before it');
      assert.match(ut.status(), /before the next bill/);
      core.seeTick(1200 * 100 - 60);                       // 30 s before a bill
      await ut._step(T0 + 13 * MIN + 1000);
      assert.strictEqual(sent.length, 3, ut.status());
      assert.strictEqual(sent.at(-1).level, 2, 'lowered to what is needed');
      assert.strictEqual(st.subscriptions[0].power, 2);
      // The peak that justified a lower stays in the window: the load dipping further does not lower it again at once.
      st.groups = { 2: run(SMELTER, 1, recOf(SMELTER).id, 0) };      // nothing runs: need 0
      await ut._step(T0 + 13 * MIN + 3000);
      assert.strictEqual(sent.length, 3, 'one lower per window: ' + ut.status());
      st.groups = { 1: run(WORKSHOP, 2, chair) };                    // 2 MW again
      // Cash: raising 2 -> 12 would cost $100, with $35 it buys what it can pay for.
      st.items[0] = 8000; st.groups[4] = run(WORKSHOP, 10, chair);   // the bill as it is: 2 MW = $20, so $60 is free for raising
      await ut._step(T0 + 14 * MIN);
      assert.strictEqual(sent.at(-1).level, 5, '$60 covers 3 MW more at $10 now and $10 in the bill');
      st.items[0] = 500;
      const n = sent.length;
      await ut._step(T0 + 15 * MIN);
      assert.strictEqual(sent.length, n, 'cannot pay for one MW: nothing sent');
      assert.match(ut.status(), /cannot cover/);
      st.items[0] = 1000000;
      // A closed game socket is waited out: nothing is sent and it is not counted as a failed change.
      st.groups[4] = run(WORKSHOP, 10, chair);
      st.items[0] = 1000000;
      const wsNow = core.walk(true).ws;
      wsNow.readyState = 3;
      const nDown = sent.length;
      for (let i = 0; i < 5; i++) await ut._step(T0 + (15 * MIN + 10000 + i * 5000));
      assert.strictEqual(sent.length, nDown, 'socket down: no sends');
      assert.strictEqual(ut.conf.power.on, true, 'five steps with the socket down do not switch Auto off');
      assert.match(ut.status(), /connection/);
      wsNow.readyState = 1;
      // Failed changes count "in a row": a quiet step in between starts the count again.
      apply = false;
      ut.cfg.confirmMs = 150;   // from here the server ignores us: a short window keeps the test quick
      await ut._step(T0 + 16 * MIN - 20000);
      await ut._step(T0 + 16 * MIN - 10000);
      assert.match(ut.status(), /2\/3/);
      apply = true;
      await ut._step(T0 + 16 * MIN - 5000);                              // this one goes through
      assert.match(ut.status(), /Raised/);
      st.groups = { 1: run(WORKSHOP, 2, chair) };
      st.items[0] = 1000000;
      // Water works the same way, with its own rate and cap, and region 0 only has the groups of region 0.
      ut.set('water', true);
      st.groups = { 1: run(CHEM, 2, recOf(CHEM).id) };
      st.subscriptions = { 0: { power: 12 } };               // 12 MW was the highest need of the last 10 minutes: it stays
      const nBefore = sent.length;
      await ut._step(T0 + 16 * MIN);
      assert.strictEqual(sent.length - nBefore, 1, 'only water changed: ' + ut.status());
      assert.deepStrictEqual(sent.at(-1), { type: 'SetSubscription', region: 0, utility: 'water', level: 8 });
      assert.strictEqual(st.subscriptions[0].power, 12, 'the other utility keeps its level');
      // Saved, and restored by the next load.
      assert.deepStrictEqual(JSON.parse(disk['autoUtil.v1']).power.on, true);
      ut._unload(); globalThis.autoUtil = undefined;
      (0, eval)(utSrc());
      assert.deepStrictEqual([globalThis.autoUtil.conf.power.on, globalThis.autoUtil.conf.water.on], [true, true], 'switches survive a reload');
      // Stop-all (Alt+Shift+X) switches both off.
      assert.ok(core.stopAll().includes('Auto utilities'));
      assert.deepStrictEqual([globalThis.autoUtil.conf.power.on, globalThis.autoUtil.conf.water.on, globalThis.autoUtil.running], [false, false, false]);
      assert.strictEqual(JSON.parse(disk['autoUtil.v1']).power.on, false);
      // The server ignoring the change: 3 tries, then that utility switches itself off.
      const ut2 = globalThis.autoUtil;
      Object.assign(ut2.cfg, { confirmMs: 3000, backoffMs: 0, cycleMs: 1e9 });
      ut2.set('power', true);
      apply = false;
      ut2.cfg.confirmMs = 150;
      st.groups = { 1: run(WORKSHOP, 9, chair) }; st.subscriptions = { 0: { power: 1 } };
      const before = sent.length;
      for (let i = 0; i < 4; i++) await ut2._step(T0 + (20 + i) * MIN);
      assert.strictEqual(sent.length - before, 3, 'three tries, then it stops asking');
      assert.strictEqual(ut2.conf.power.on, false, 'switched off');
      assert.ok(core.ledger.list().some((e) => e.kind === 'fail' && /switched off/.test(e.text)));
    } finally { unloadUt(); }
  });

  await t('Auto utilities: never lowers power under what Autopilot would subscribe, and export / import keeps only valid settings', () => {
    const { ut, core } = loadUt();
    try {
      const st = baseState(), cat = board.catalog;
      st.groups = { 1: run(SMELTER, 3, recOf(SMELTER).id, 0), 2: run(SMELTER, 2, recOf(SMELTER).id, 0, { paused: true }) };
      assert.strictEqual(ut._floor('power', 0, st, cat), 0, 'Autopilot not running: no floor');
      globalThis.earlyGame = { running: true, busy: false, held: '' };
      assert.strictEqual(ut._floor('power', 0, st, cat), 0, 'Autopilot in a dry run sends nothing: no floor');
      globalThis.earlyGame = { running: true, busy: true, held: 'lab' };
      assert.strictEqual(ut._floor('power', 0, st, cat), 0, 'held: no floor');
      globalThis.earlyGame = { running: true, busy: true, held: '' };
      assert.strictEqual(ut._floor('power', 0, st, cat), 6, 'its unpaused groups at full draw: Smelter x3 = 6 MW');
      assert.strictEqual(ut._floor('water', 0, st, cat), 0, 'it never subscribes water');
      assert.strictEqual(ut._floor('power', 2, st, cat), 0, 'it only works Heartland');
      ut.set('power', true); ut.conf.power.spare = 2; ut.conf.holdMin = 15;
      const json = core.exportConfig();
      assert.deepStrictEqual(JSON.parse(json).autoUtil.cfg.power, { on: true, spare: 2 });
      ut.conf.power.on = false; ut.conf.power.spare = 0; ut.conf.holdMin = 10;
      core.importConfig(json);
      assert.deepStrictEqual([ut.conf.power.on, ut.conf.power.spare, ut.conf.holdMin], [true, 2, 15]);
      const bad = JSON.stringify({ app: 'idlecorp-toolkit', format: 1, autoUtil: { cfg: { power: { on: 'yes', spare: -3 }, water: { spare: 99999 }, holdMin: 0 } } });
      const rep = core.importConfig(bad);
      assert.deepStrictEqual([ut.conf.power.on, ut.conf.power.spare, ut.conf.water.spare, ut.conf.holdMin], [true, 2, 0, 15], 'bad values are refused');
      assert.match(rep, /skipped/);
    } finally { unloadUt(); }
  });


  await t('reserves registry: merges providers, holds every one, drops one on unregister', async () => {
    const { core } = loadBoth();
    assert.ok(core.reserves.names().includes('earlyGame'), 'Autopilot registers itself');
    const calls = [], logErr = console.error;
    console.error = () => {};   // the throwing provider below is logged, not fatal
    core.reserves.register('a', { reserve: () => ({ moneyFloor: 100, items: { 1: 5 }, nextTech: null, phase: 3 }), busy: () => false, hold: async (w) => { calls.push('hold-a:' + w); }, release: (w) => calls.push('rel-a:' + w) });
    const offB = core.reserves.register('b', { reserve: () => ({ moneyFloor: 500, items: { 1: 7, 9: Infinity }, nextTech: { cd: 5000, name: 'Retail Store' }, phase: 'x' }), busy: () => true, hold: async (w) => { calls.push('hold-b:' + w); }, release: (w) => calls.push('rel-b:' + w) });
    core.reserves.register('broken', { reserve: () => { throw new Error('boom'); }, busy: () => { throw new Error('boom'); } });
    const m = core.reserves.merged();
    assert.strictEqual(m.moneyFloor, 500, 'the highest floor wins');
    assert.strictEqual(m.items[1], 12, 'item reserves add up');
    assert.strictEqual(m.items[9], Infinity, 'Infinity stays Infinity');
    assert.strictEqual(m.nextTech.cd, 5000);
    assert.strictEqual(m.phase, 3, 'the first provider with a phase wins');
    assert.ok(core.reserves.anyBusy());
    await core.reserves.holdAll('CD Farm');
    core.reserves.releaseAll('CD Farm');
    assert.deepStrictEqual(calls.sort(), ['hold-a:CD Farm', 'hold-b:CD Farm', 'rel-a:CD Farm', 'rel-b:CD Farm']);
    offB();
    assert.ok(!core.reserves.names().includes('b'));
    assert.strictEqual(core.reserves.merged().nextTech, null);
    core.reserves.unregister('a'); core.reserves.unregister('broken');
    assert.strictEqual(core.reserves.merged(), null, 'no provider has a reserve');
    assert.ok(!core.reserves.anyBusy());
    console.error = logErr;
  });

  await t('Autopilot unregisters its reserve provider when it unloads', () => {
    const { core, ap } = loadBoth();
    assert.ok(core.reserves.names().includes('earlyGame'));
    ap._unload();
    assert.ok(!core.reserves.names().includes('earlyGame'));
  });

  await t('CD Farm rates().spendH: net dollars spent in the last 60 min, across runs (Core plan E5 adds it to the cash trend)', () => {
    const { core } = loadBoth();
    globalThis.window = globalThis; globalThis.document = { querySelector: () => null, getElementById: () => null };
    (0, eval)(cdSrc);
    const cf = globalThis.cdFarm, H = 3600000, T0 = 1e12, spendH = (now) => cf.rates(null, now).spendH;
    cf._newRun(); cf.stats.spent = 500; cf._sample(T0);                       // run 1: $500
    cf._newRun(); cf.stats.spent = 300; cf._sample(T0 + 10 * 60000);          // run 2 (stats reset): $300
    assert.strictEqual(spendH(T0 + 20 * 60000), 800, 'both runs count, in dollars');
    assert.strictEqual(spendH(T0 + H + 5 * 60000), 300, 'run 1 is older than 60 min, run 2 still counts');
    cf.stats.refunded = 120; cf._sample(T0 + 30 * 60000);                     // a net refund: negative
    assert.strictEqual(spendH(T0 + 40 * 60000), 680, 'refund (-$120) is subtracted');
    assert.strictEqual(spendH(T0 + H + 25 * 60000), -120, 'only the refund is left: a negative amount');
    cf._unload(); core._unload(); delete globalThis.window; delete globalThis.document;
  });

  await t('earlyGame.tune: saved, validated like importCfg, neverSell is unioned', () => {
    const disk = {};
    globalThis.localStorage = { getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = String(v); }, removeItem: (k) => { delete disk[k]; } };
    try {
      const { ap } = loadBoth();
      ap.cfg.neverSell = [5];
      const r = ap.tune({ neverSell: [9, 5, 14, 15], cdBooster: false, workshops: 'lots', nosuchkey: 1, dryRun: false });
      assert.deepStrictEqual(r.applied.sort(), ['cdBooster', 'neverSell']);
      assert.deepStrictEqual(r.skipped.sort(), ['dryRun', 'nosuchkey', 'workshops'], 'wrong type, unknown and session-only keys are refused');
      assert.deepStrictEqual([...ap.cfg.neverSell].sort((a, b) => a - b), [5, 9, 14, 15], 'unioned, not replaced');
      assert.strictEqual(ap.cfg.cdBooster, false);
      const saved = JSON.parse(disk['earlyGame.v2']);
      assert.strictEqual(saved.cfg.cdBooster, false, 'saved: survives a reload');
      assert.deepStrictEqual([...saved.cfg.neverSell].sort((a, b) => a - b), [5, 9, 14, 15]);
      ap.tune({ neverSell: [9] });
      assert.strictEqual(ap.cfg.neverSell.length, 4, 'a second tune does not duplicate');
    } finally { fresh(); delete globalThis.localStorage; }
  });

  await t('floor library: furniture recipes get a Workshop design (x5 Bookshelf/Table/Chair, Rivet x3 for Bench/Desk; scored live 2026-11-22)', () => {
    const { ap } = loadBoth();
    const k = ap._core, C = k.normalize(board.catalog);
    const rid = (n) => board.catalog.recipes.find((r) => r.name === n).id;
    const st = baseState();
    st.groups = {
      1: { building: 8, region: 0, count: 2, recipe: rid('Make Bookshelf') }, 2: { building: 8, region: 0, count: 2, recipe: rid('Make Table') },
      3: { building: 8, region: 0, count: 2, recipe: rid('Make Chair') }, 4: { building: 8, region: 0, count: 1, recipe: rid('Make Bench') }, 5: { building: 8, region: 0, count: 1, recipe: rid('Make Desk') },
    };
    const rows = k.floorTable(k.snapshot(st, C, [], [], 0));
    const by = Object.fromEntries(rows.map((r) => [r.task, r]));
    for (const n of ['Make Bookshelf', 'Make Table', 'Make Chair']) assert.ok(by[n] && by[n].best === 'x5' && by[n].plan === 'Workshop v1 x5', n + ': ' + JSON.stringify(by[n]));
    for (const n of ['Make Bench', 'Make Desk']) assert.ok(by[n] && by[n].best === 'x3' && by[n].plan === 'Rivet x3 (two inputs)', n + ': ' + JSON.stringify(by[n]));
    // Library fallback rates here (no engine in the test); the designs scored x5 / x3 on these recipes in the live game on 2026-11-22.
    const lib = (n) => rows.find((r) => r.task === n).plan;
    assert.strictEqual(lib('Make Table'), lib('Make Chair'));
  });


  console.log(failed ? '\n' + failed + ' failed' : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
