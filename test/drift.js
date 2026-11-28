// Drift check: runs two builds through the same seeded scenarios and diffs every decision, so a refactor that should not change
// behaviour can be shown not to. Not part of run-all (it needs an old build to compare with).
//   IC_BASE=<old ic-autopilot.user.js> bun test/drift.js          # old build vs the current ic-autopilot.user.js
//   IC_BASE=<old> IC_NEW=<other> bun test/drift.js                  # any two builds
// Autopilot: every decide(), phase and Plan done of the five early-game sims (44 h each), plus `rich` with a stand-in Core plan that owns the
// corp from Plan done (the hand-off cutoff). Core plan: every action, wait and hourly money of the engine-region loop runs (real engine
// wasm; skipped offline), the full decide() on the saved Stage A / Stage B boards and on the base build's `rich` sim state every 2 h
// (planDone false and true: failing start conditions, no stage). Both: the default settings, director order and duties of a fresh load.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SIMS = [['rich'], ['live'], ['chaos'], ['nobooster'], ['cdfarm'], ['rich', 'stub']];
const simName = ([sc, v]) => 'sim-' + sc + (v ? '-' + v : '');
if (process.argv[2] === '--core-dump') coreDump(process.argv[3]);
else if (process.argv[2] === '--cfg-dump') cfgDump(process.argv[3]);
else compare();

async function compare() {
  const BASE = process.env.IC_BASE, NEW = process.env.IC_NEW || path.join(__dirname, '..', 'ic-autopilot.user.js');
  if (!BASE) { console.error('set IC_BASE to the old ic-autopilot.user.js'); process.exit(2); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-drift-'));
  const states = path.join(dir, 'states');
  fs.mkdirSync(states);
  await Bun.spawn(['bun', path.join(__dirname, 'early-game-sim.js'), 'rich', '44'], { env: { ...process.env, IC_BUILD: BASE, IC_STATES: states }, stdout: 'ignore', stderr: 'ignore' }).exited;
  const dump = (build, tag) => {
    const env = { ...process.env, IC_BUILD: build, IC_STATES_IN: states, FORCE_COLOR: '0' };
    const jobs = SIMS.map((x) => Bun.spawn(['bun', path.join(__dirname, 'early-game-sim.js'), x[0], '44'], { env: { ...env, IC_TRACE: path.join(dir, tag + '-' + simName(x)), ...(x[1] === 'stub' ? { IC_CORESTUB: '1' } : {}) }, stdout: 'ignore', stderr: 'ignore' }).exited);
    jobs.push(Bun.spawn(['bun', __filename, '--core-dump', path.join(dir, tag + '-core')], { env, stdout: 'ignore', stderr: 'inherit' }).exited);
    jobs.push(Bun.spawn(['bun', __filename, '--cfg-dump', path.join(dir, tag + '-cfg')], { env, stdout: 'ignore', stderr: 'inherit' }).exited);
    return Promise.all(jobs);
  };
  await Promise.all([dump(BASE, 'base'), dump(NEW, 'new')]);
  let bad = 0;
  for (const f of [...SIMS.map(simName), 'core', 'cfg']) {
    const read = (tag) => { try { return fs.readFileSync(path.join(dir, tag + '-' + f), 'utf8').split('\n'); } catch { return null; } };
    const a = read('base'), b = read('new');
    if (!a || !b) { console.log('FAIL ' + f + ': no output from ' + (!a ? 'base' : 'new')); bad++; continue; }
    const diffs = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diffs.push(i);
    if (!diffs.length) { console.log('same ' + f + ' (' + a.length + ' lines)'); continue; }
    bad++;
    console.log('DIFF ' + f + ': ' + diffs.length + ' of ' + Math.max(a.length, b.length) + ' lines differ; first ones:');
    for (const i of diffs.slice(0, 4)) console.log('  line ' + (i + 1) + '\n    base: ' + (a[i] ?? '(none)').slice(0, 400) + '\n    new:  ' + (b[i] ?? '(none)').slice(0, 400));
  }
  console.log(bad ? bad + ' trace(s) drifted (files in ' + dir + ')' : 'no drift');
  process.exitCode = bad ? 1 : 0;
}

// Child: Core plan traces of the build in IC_BUILD (cp-fixtures reads it), one line per run or board.
async function coreDump(out) {
  const F = require('./cp-fixtures');
  const lines = [];
  const plain = (x) => JSON.stringify(x, (_, v) => (typeof v === 'function' ? undefined : v));
  const R = await require('./engine-region.js').load();
  if (!R) { lines.push('engine wasm not available: engine-region runs skipped'); F.load(['cp-buildout', 'cp-retail']); }
  else {
    const { run } = R;
    const goldEdit = (snap) => { delete snap.groups[12]; snap.land_bought[0] -= 44; };
    const runs = {
      liveOff: () => run({ hours: 3, expand: 'off' }), liveAsk: () => run({ hours: 3, expand: 'ask' }), goldAsk: () => run({ hours: 3, expand: 'ask', edit: goldEdit }),
      autoSeeded: () => run({ hours: 1.5, expand: 'auto', seed: true }), goldAuto: () => run({ hours: 12, expand: 'auto', seed: true, edit: goldEdit }),
    };
    for (const [k, f] of Object.entries(runs)) { const r = f(); lines.push(k + ' ' + plain({ ids: r.ids, waits: r.waits, money: r.money, over: r.over })); }
  }
  const cp = globalThis.corePlan;
  for (const expand of ['off', 'ask']) {
    const saved = cp.cfg.expand; cp.cfg.expand = expand;
    try {
      lines.push('stageB-' + expand + ' ' + plain(cp._decide(cp._view(F.liveB(), F.stageB.catalog, F.stageB.deals), F.ctxOf({ retailBoard: F.stageB.retail, deals: F.stageB.deals }))));
      lines.push('stageA-' + expand + ' ' + plain(cp._decide(cp._view(F.stageA(), F.board.catalog, F.cottonBidDeals()), F.ctxOf({ deals: F.cottonBidDeals() }))));
    } finally { cp.cfg.expand = saved; }
  }
  const dir = process.env.IC_STATES_IN;
  for (const file of dir ? fs.readdirSync(dir).sort() : []) {
    const st = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const planDone of [false, true]) lines.push(file + ' planDone=' + planDone + ' ' + plain(cp._decide(cp._view(F.clone(st), F.board.catalog, F.cottonBidDeals()), F.ctxOf({ planDone, deals: F.cottonBidDeals() }))));
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
}

// Child: defaults, director order and duties of a fresh load (no saved settings) of the build in IC_BUILD.
function cfgDump(out) {
  const F = require('./cp-fixtures');
  const full = F.full();
  const lines = [];
  const plain = (x) => JSON.stringify(x, (_, v) => (typeof v === 'function' ? undefined : v === Infinity ? 'Infinity' : v));
  (0, eval)(full.slice(full.indexOf('// @@MODULE core'), full.indexOf('// @@END core')) + '\n' + full.slice(full.indexOf('// @@MODULE early-game')));
  lines.push('earlyGame ' + plain(globalThis.earlyGame.exportCfg()));
  globalThis.earlyGame._unload?.();
  F.load(['cp-buildout', 'cp-retail', 'cp-expand', 'cp-lab', 'cp-ladder', 'cp-cadence', 'cp-endgame']);
  const cp = globalThis.corePlan;
  lines.push('corePlan ' + plain(cp.exportCfg()), 'directors ' + plain(cp.directors()), 'duties ' + plain(cp.duties()));
  fs.writeFileSync(out, lines.join('\n') + '\n');
  process.exit(0);
}
