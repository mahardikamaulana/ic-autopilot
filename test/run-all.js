// Runs every test of the toolkit side by side and prints one line per job.
//   bun test/run-all.js              # changed-only: a job whose input files are unchanged since its last pass is skipped
//   bun test/run-all.js --all        # everything, ignoring the cache (bun run test; always before a version bump)
//   bun test/run-all.js --fast       # no browser: build check, pacer, planner, simulation, toolkit (add --all to ignore the cache)
//   bun test/run-all.js --only=ui    # jobs whose name contains any of the comma-separated words
//   bun test/run-all.js --jobs=4     # at most 4 jobs at once (default: cpus - 1)
//   bun test/run-all.js --ok-lines=f # also write every "ok" line of every job, sorted, to f (to diff two runs)
//   bun test/run-all.js --list       # job names with their estimated seconds
// A job is a command plus the files it depends on. Its pass is cached in test/.cache.json by a hash of those
// files, so touching src/planner.js re-runs the planner job and everything that loads the built script, not the rest.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const T = (f) => path.join('test', f);
const BUILT = 'ic-autopilot.user.js';
const BOARD = [T('live-board.json'), T('floor-state.json')];
const BROWSER_CAP = 4;                      // Chrome pages compete for CPU: more than this makes timing checks flaky

// est = seconds on an 8-core laptop (longest first keeps the critical path short).
const J = [];
const add = (name, cmd, inputs, est, heavy = false) => J.push({ name, cmd, inputs, est, heavy });
const SH = ['chrome', 'cdfarm', 'lab', 'utilities', 'narrow', 'docked', 'motion', 'handoff', 'auto-a', 'auto-b', 'auto-c'];
const UI_EST = { chrome: 8, cdfarm: 10, lab: 8, utilities: 4, narrow: 2, docked: 3, motion: 2, handoff: 45, 'auto-a': 7, 'auto-b': 10, 'auto-c': 7 };
for (const s of SH) add('ui:' + s, ['bun', T('ui-harness.js'), 'check', s], [BUILT, T('ui-harness.js'), ...BOARD, T('live-stageB.json')], UI_EST[s], true);
for (let k = 0; k < 3; k++) add('toolkit:' + k, ['bun', T('toolkit-test.js'), '--shard=' + k + '/3'], [BUILT, T('toolkit-test.js'), ...BOARD], 4);
for (const s of ['rich', 'live', 'chaos', 'nobooster', 'cdfarm']) add('sim:' + s, ['bun', T('early-game-sim.js'), s, '44'], [BUILT, T('early-game-sim.js'), ...BOARD], 2);
add('pacer', ['bun', T('pacer-test.js')], ['src/core-1.js', 'src/core-2.js', 'src/core-form.js', 'src/core-3.js', 'src/pacer.js', T('pacer-test.js')], 1);
add('sim:coreplan', ['bun', T('core-plan-sim.js')], [BUILT, T('core-plan-sim.js'), T('live-board.json')], 6);
for (const m of ['cp-buildout', 'cp-retail', 'cp-lab', 'cp-ladder', 'cp-cadence', 'cp-endgame']) add(m, ['bun', T(m + '-test.js')], [BUILT, T(m + '-test.js'), T('cp-fixtures.js'), T('live-board.json'), T('live-stageB.json')], 4);
add('core-math', ['bun', T('core-math-test.js')], ['src/core-math.js', T('core-math-test.js'), '../scripts/core-plan/my-plan.js', '../scripts/core-plan/state-example.json', '../scripts/core-plan/catalog-2026-11-22.json'], 2);
add('autopilot-anycorp', ['bun', T('autopilot-anycorp-test.js')], [BUILT, T('autopilot-anycorp-test.js'), ...BOARD], 2);
add('planner', ['bun', T('planner-test.js')], ['src/core-1.js', 'src/core-2.js', 'src/core-form.js', 'src/core-3.js', 'src/planner.js', T('planner-test.js'), ...BOARD], 1);
add('keep-online', ['bun', T('keep-online-test.js')], [BUILT, T('keep-online-test.js')], 1);
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const val = (n) => (argv.find((a) => a.startsWith('--' + n + '=')) || '').slice(n.length + 3);
const CACHE = path.join(__dirname, '.cache.json');

const hashOf = (files) => {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort()) { h.update(f + '\0'); try { h.update(fs.readFileSync(path.join(ROOT, f))); } catch { h.update('missing'); } }
  return h.digest('hex').slice(0, 16);
};

async function exec(cmd) {
  const t0 = performance.now();
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, FORCE_COLOR: '0' } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: out + err, s: (performance.now() - t0) / 1000 };
}

async function main() {
  if (flag('list')) { for (const j of J) console.log(j.est.toString().padStart(3) + ' s  ' + j.name + (j.heavy ? '  (browser)' : '')); return; }
  const t0 = performance.now();
  // The built script must match src, always (it is what every other job loads).
  const chk = await exec(['bun', 'build.js', '--check']);
  if (chk.code) { console.log('FAIL build check\n' + chk.out); process.exit(1); }

  let jobs = J;
  if (flag('fast')) jobs = jobs.filter((j) => !j.heavy);
  if (val('only')) { const w = val('only').split(','); jobs = jobs.filter((j) => w.some((x) => j.name.includes(x))); }
  jobs = [...jobs].sort((a, b) => b.est - a.est);

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { }
  const results = [];
  const maxJobs = Math.max(1, Number(val('jobs')) || Math.max(2, os.cpus().length - 1));
  const queue = [...jobs];
  let running = 0, heavyRunning = 0;
  await new Promise((resolve) => {
    const pump = () => {
      while (running < maxJobs) {
        const i = queue.findIndex((j) => !j.heavy || heavyRunning < BROWSER_CAP);
        if (i < 0) break;
        const j = queue.splice(i, 1)[0];
        const hash = hashOf(j.inputs);
        if (!flag('all') && cache[j.name] === hash) { results.push({ j, cached: true, code: 0, out: '', s: 0 }); console.log('skip ' + j.name + '  (unchanged since it last passed)'); continue; }
        running++; if (j.heavy) heavyRunning++;
        exec(j.cmd).then((r) => {
          running--; if (j.heavy) heavyRunning--;
          results.push({ j, hash, ...r });
          console.log((r.code ? 'FAIL ' : 'ok   ') + j.name + '  ' + r.s.toFixed(1) + ' s');
          pump();
        });
      }
      if (!running && !queue.length) resolve();
    };
    pump();
  });

  for (const r of results) if (!r.cached && !r.code) cache[r.j.name] = r.hash; else if (!r.cached) delete cache[r.j.name];
  try { fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1)); } catch { }

  if (val('ok-lines')) {
    const lines = results.flatMap((r) => r.out.split('\n').filter((l) => /^ok   /.test(l)).map((l) => l.replace(/\s+\[\d+ ms\]$/, '')));
    fs.writeFileSync(val('ok-lines'), lines.sort().join('\n') + '\n');
  }
  const bad = results.filter((r) => r.code);
  for (const r of bad) console.log('\n===== ' + r.j.name + ' (exit ' + r.code + ') =====\n' + r.out.split('\n').filter((l) => !/^ok   /.test(l)).join('\n').trim());
  const wall = ((performance.now() - t0) / 1000).toFixed(1);
  const skipped = results.filter((r) => r.cached).length;
  console.log('\n' + (bad.length ? bad.length + ' of ' + results.length + ' jobs FAILED' : 'all passed') + '  (' + results.length + ' jobs' + (skipped ? ', ' + skipped + ' skipped' : '') + ', ' + wall + ' s)');
  process.exit(bad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
