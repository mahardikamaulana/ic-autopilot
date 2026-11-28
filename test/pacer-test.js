// Headless checks for src/pacer.js: the jittered waits, the command budget, backoff, the circuit
// breaker and the measure statistics. Injected clock, sleep and seeded rng, no real time.
//   bun test/pacer-test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const srcDir = path.join(__dirname, '..', 'src');
const slice = (files, name) => {
  const s = [].concat(files).map((file) => fs.readFileSync(path.join(srcDir, file), 'utf8')).join('\n');
  return s.slice(s.indexOf('// @@MODULE ' + name), s.indexOf('// @@END ' + name));
};
globalThis.idleCore?._unload?.();
globalThis.idleCore = undefined;
(0, eval)(slice(['core-1.js', 'core-2.js', 'core-form.js', 'core-plans.js', 'core-3.js'], 'core') + '\n' + slice('pacer.js', 'pacer'));
const core = globalThis.idleCore;
const { measure } = core;

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
// fake time: sleep advances the clock by what the (possibly rounding) sleep implementation says
function fake({ seed = 1, round = (ms) => ms, ...opts } = {}) {
  const clk = { t: 1000 };
  const pacer = core.pacer({ now: () => clk.t, sleep: async (ms) => { clk.t += round(ms); }, rng: mulberry32(seed), ...opts });
  return { clk, pacer };
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sorted = (a) => [...a].sort((x, y) => x - y);
const q = (a, p) => sorted(a)[Math.min(a.length - 1, Math.floor(p * a.length))];

(async () => {
  await t('draw(before): right-skewed, fractional, no repeats, median near the configured one', () => {
    const { pacer } = fake({ seed: 7 });
    const raw = [], norm = [];
    for (let i = 0; i < 5000; i++) { const v = pacer.draw('before'); raw.push(v); norm.push(v / pacer.state().drift); }
    const med = q(raw, 0.5);
    assert.ok(q(raw, 0.99) / med > 2, 'p99/median ' + q(raw, 0.99) / med);
    assert.ok(med - q(raw, 0.1) < q(raw, 0.9) - med, 'lower side must be tighter than the upper');
    assert.ok(raw.filter((v) => v !== Math.round(v)).length / raw.length > 0.95, 'fractions');
    assert.strictEqual(new Set(raw.slice(0, 1000)).size, 1000);
    assert.ok(Math.abs(q(norm, 0.5) / 500 - 1) < 0.15, 'median ' + q(norm, 0.5));
    assert.ok(raw.every((v) => v >= 120 && v <= 12000));
    const real = core.pacer({}), seen = new Set();
    for (let i = 0; i < 1000; i++) seen.add(real.draw('before'));
    assert.strictEqual(seen.size, 1000, 'default rng repeats');
  });

  await t('draw(poll): mean within 5% of 3000 x drift, spread about +-40%', () => {
    const { pacer } = fake({ seed: 11 });
    const ratio = [];
    for (let i = 0; i < 5000; i++) { const v = pacer.draw('poll'); ratio.push(v / (3000 * pacer.state().drift)); }
    assert.ok(Math.abs(mean(ratio) - 1) < 0.05, 'mean ratio ' + mean(ratio));
    assert.ok(q(ratio, 0.05) > 0.55 && q(ratio, 0.95) < 1.6, q(ratio, 0.05) + ' .. ' + q(ratio, 0.95));
  });

  await t('drift stays inside 0.75..1.25 and moves slowly', () => {
    const { pacer } = fake({ seed: 3 });
    const ds = [];
    for (let i = 0; i < 20000; i++) { pacer.draw('step'); ds.push(pacer.state().drift); }
    assert.ok(Math.min(...ds) >= 0.75 && Math.max(...ds) <= 1.25);
    assert.ok(Math.max(...ds) - Math.min(...ds) > 0.2, 'it should wander');
    for (let i = 1; i < ds.length; i++) assert.ok(Math.abs(ds[i] - ds[i - 1]) <= 0.0201);
  });

  await t('wait(): whole-ms sleeps, yet the average actual matches the average drawn (debt carried)', async () => {
    const { pacer } = fake({ seed: 5, round: Math.round });
    const drawn = [], actual = [];
    for (let i = 0; i < 500; i++) { const r = await pacer.wait('before'); drawn.push(r.drawn); actual.push(r.actual); }
    assert.ok(Math.abs(mean(actual) / mean(drawn) - 1) < 0.02, mean(actual) + ' vs ' + mean(drawn));
    assert.ok(Math.abs(pacer.state().debt) <= 5);
    assert.ok(measure.get('own-wait').n > 0);
  });

  await t('wait(): actual is the measured elapsed time, with sub-ms fractions', async () => {
    // a sleep that overshoots by a fractional amount, like a real timer
    const clk = { t: 0 }, r = mulberry32(9);
    const pacer = core.pacer({ now: () => clk.t, sleep: async (ms) => { clk.t += ms + r() * 0.9; }, rng: mulberry32(2) });
    const out = [];
    for (let i = 0; i < 200; i++) out.push(await pacer.wait('step'));
    assert.ok(out.filter((o) => o.actual !== Math.round(o.actual)).length > 190);
    assert.ok(Math.abs(mean(out.map((o) => o.actual)) / mean(out.map((o) => o.drawn)) - 1) < 0.02);
  });

  await t('wait(): a short sleep is topped up once', async () => {
    const calls = [], clk = { t: 0 };
    const pacer = core.pacer({ now: () => clk.t, sleep: async (ms) => { calls.push(ms); clk.t += Math.floor(ms); }, rng: mulberry32(4) });
    const r = await pacer.wait('before');
    assert.ok(calls.length >= 1 && calls.length <= 2 && Number.isInteger(calls[0]));
    assert.ok(r.drawn - r.actual < 1);
  });

  await t('beforeCommand(): never more than cmdsPerMin in any sliding 60 s, over 200 calls', async () => {
    const { clk, pacer } = fake({ seed: 8, cmdsPerMin: 20 });
    const times = [], waits = [];
    for (let i = 0; i < 200; i++) {
      waits.push(await pacer.beforeCommand());
      times.push(clk.t);
      clk.t += (i % 7) * 150; // the loop does other work between commands
      assert.ok(pacer.cmdsInLastMinute() <= 20);
    }
    for (let i = 0; i < times.length; i++) {
      const inWin = times.filter((x) => x <= times[i] && times[i] - x <= 60000).length;
      assert.ok(inWin <= 20, 'window at ' + i + ' has ' + inWin);
    }
    assert.ok(waits.slice(0, 20).every((w) => w === 0) && waits[20] > 0);
    assert.ok(times[199] - times[0] >= 8 * 60000, 'rate really is limited');
  });

  await t('beforeCommand(): holds with whole-ms flooring sleeps too', async () => {
    const { clk, pacer } = fake({ seed: 2, cmdsPerMin: 5, round: Math.floor });
    const times = [];
    for (let i = 0; i < 40; i++) { await pacer.beforeCommand(); times.push(clk.t); }
    for (let i = 0; i < times.length; i++) assert.ok(times.filter((x) => x <= times[i] && times[i] - x <= 60000).length <= 5);
  });

  await t('backoff factor: x1.5 per failure to a cap of 8, back down after 20 clean results', () => {
    const { pacer } = fake();
    assert.strictEqual(pacer.factor, 1);
    const seq = [];
    for (let i = 0; i < 7; i++) { pacer.noteResult(false); seq.push(pacer.factor); }
    assert.deepStrictEqual(seq, [1.5, 2.25, 3.375, 5.0625, 7.59375, 8, 8]);
    for (let i = 0; i < 19; i++) pacer.noteResult(true);
    assert.strictEqual(pacer.factor, 8);
    pacer.noteResult(true);
    assert.ok(Math.abs(pacer.factor - 8 / 1.5) < 1e-9);
    // a failure restarts the count of clean results
    for (let i = 0; i < 10; i++) pacer.noteResult(true);
    pacer.noteResult(false);
    const f = pacer.factor;
    for (let i = 0; i < 19; i++) pacer.noteResult(true);
    assert.strictEqual(pacer.factor, f);
    pacer.noteResult(true);
    assert.ok(pacer.factor < f);
    for (let i = 0; i < 400; i++) pacer.noteResult(true);
    assert.strictEqual(pacer.factor, 1);
  });

  await t('backoff lengthens the draws, within a cap that scales with it', () => {
    const calm = fake({ seed: 6 }).pacer, slow = fake({ seed: 6 }).pacer;
    for (let i = 0; i < 6; i++) slow.noteResult(false);
    const a = [], b = [];
    for (let i = 0; i < 2000; i++) { a.push(calm.draw('before')); b.push(slow.draw('before')); }
    assert.ok(mean(b) / mean(a) > 6);
    assert.ok(Math.max(...b) <= 12000 * 8);
  });

  await t('breaker: opens on 3 unconfirmed in a row, not on 2, and resetBreaker clears it', () => {
    const { pacer } = fake();
    pacer.noteConfirm({ ok: false }); pacer.noteConfirm({ ok: false });
    assert.strictEqual(pacer.breaker().open, false);
    pacer.noteConfirm({ ok: true, rtt: 300 });
    pacer.noteConfirm({ ok: false }); pacer.noteConfirm({ ok: false });
    assert.strictEqual(pacer.breaker().open, false, 'a success resets the run');
    pacer.noteConfirm({ ok: false });
    const b = pacer.breaker();
    assert.ok(b.open && /3 unconfirmed/.test(b.reason), b.reason);
    assert.strictEqual(pacer.tripCount, 1);
    pacer.resetBreaker();
    assert.deepStrictEqual(pacer.breaker(), { open: false, reason: null });
    assert.strictEqual(pacer.tripCount, 1);
  });

  await t('breaker: opens on an RTT spike (20 x ~350 then 5 x 2500), quiet on normal jitter', () => {
    const { pacer } = fake();
    const r = mulberry32(21);
    for (let i = 0; i < 20; i++) { pacer.noteConfirm({ ok: true, rtt: 300 + r() * 100 }); assert.strictEqual(pacer.breaker().open, false); }
    for (let i = 0; i < 5; i++) pacer.noteConfirm({ ok: true, rtt: 2500 });
    const b = pacer.breaker();
    assert.ok(b.open && /rtt/.test(b.reason), b.reason);
    assert.strictEqual(pacer.tripCount, 1);
    pacer.resetBreaker();
    assert.strictEqual(pacer.breaker().open, false);
    for (let i = 0; i < 20; i++) pacer.noteConfirm({ ok: true, rtt: 350 });
    assert.strictEqual(pacer.breaker().open, false, 'reset forgets the spike');
  });

  await t('breaker: needs 8 samples before an RTT spike counts', () => {
    const { pacer } = fake();
    for (let i = 0; i < 4; i++) pacer.noteConfirm({ ok: true, rtt: 350 });
    for (let i = 0; i < 3; i++) pacer.noteConfirm({ ok: true, rtt: 5000 });
    assert.strictEqual(pacer.breaker().open, false);
  });

  await t('think pauses: about 1 in 22 cycle draws, 4 to 20 s on top', () => {
    const { pacer } = fake({ seed: 13 });
    const v = [];
    for (let i = 0; i < 5000; i++) v.push(pacer.draw('cycle'));
    const long = v.filter((x) => x >= 4000);
    assert.ok(long.length / v.length > 0.02 && long.length / v.length < 0.09, long.length / v.length);
    const quiet = fake({ seed: 13 }).pacer;
    for (let i = 0; i < 5000; i++) assert.ok(quiet.draw('step') < 4000);
  });

  await t('unknown kind throws', () => {
    assert.throws(() => fake().pacer.draw('nope'), /unknown pacer kind/);
  });

  await t('state() / load() round trip, and load() clamps junk', () => {
    const { pacer } = fake({ seed: 3 });
    for (let i = 0; i < 300; i++) pacer.draw('step');
    pacer.noteResult(false);
    const s = JSON.parse(JSON.stringify(pacer.state()));
    const other = fake().pacer;
    other.load(s);
    assert.deepStrictEqual(other.state(), s);
    other.load({ factor: 99, drift: 7, debt: -50, trips: 'x' });
    assert.deepStrictEqual(other.state(), { factor: 8, drift: 1.25, debt: -5, trips: 0 });
    other.load(null);
    assert.deepStrictEqual(other.state(), { factor: 1, drift: 1, debt: 0, trips: 0 });
  });

  await t('core.pacer.default is a ready instance on real time', () => {
    const d = core.pacer.default;
    const v = d.draw('before');
    assert.ok(v >= 120 && v <= 12000 && d.cmdsInLastMinute() === 0);
  });

  await t('measure.series: median, MAD, p90, mean, last on known data; window of 40', () => {
    const s = measure.series('known-' + Math.random());
    assert.strictEqual(s.median, null);
    [1, 2, 3, 4, 100].forEach((x) => s.add(x));
    assert.strictEqual(s.n, 5);
    assert.strictEqual(s.median, 3);
    assert.strictEqual(s.mad, 1);              // |x-3| = 2,1,0,1,97 -> median 1
    assert.strictEqual(s.p90, 100);            // nearest rank: ceil(.9*5) = 5th
    assert.strictEqual(s.mean, 22);
    assert.strictEqual(s.last, 100);
    const ten = measure.series('ten-' + Math.random());
    for (let i = 1; i <= 10; i++) ten.add(i);
    assert.strictEqual(ten.p90, 9);
    assert.strictEqual(ten.median, 5.5);
    const w = measure.series('win-' + Math.random());
    for (let i = 0; i < 100; i++) w.add(i);
    assert.strictEqual(w.n, 40);
    assert.deepStrictEqual(w.values().slice(0, 2), [60, 61]);
    w.add(NaN); w.add(undefined);
    assert.strictEqual(w.n, 40);
    assert.strictEqual(measure.get('ten-x') === measure.get('ten-x'), true);
  });

  await t('measure.slope: Theil-Sen per hour, robust to outliers; null when too little', () => {
    const r = mulberry32(31), pts = [];
    for (let i = 0; i < 61; i++) {
      const t = i * 60000;
      let v = 5000 + 1200 * (t / 3600000) + (r() - 0.5) * 20;
      if (i % 9 === 4) v += (i % 2 ? 1 : -1) * 50000;   // a purchase or a sale
      pts.push({ t, v });
    }
    const s = measure.slope(pts);
    assert.ok(Math.abs(s / 1200 - 1) < 0.02, String(s));
    assert.strictEqual(measure.slope(pts.slice(0, 2)), null);
    assert.strictEqual(measure.slope([{ t: 0, v: 1 }, { t: 20000, v: 2 }, { t: 40000, v: 3 }]), null);
    assert.ok(Math.abs(measure.slope([{ t: 0, v: 0 }, { t: 60000, v: 10 }, { t: 120000, v: 20 }]) - 600) < 1e-9);
  });

  await t('measure.estimate: prior until minN samples, then the median', () => {
    const name = 'est-' + Math.random();
    for (let i = 0; i < 7; i++) measure.get(name).add(400);
    assert.deepStrictEqual(measure.estimate(name, 350), { value: 350, n: 7, source: 'prior' });
    measure.get(name).add(400);
    assert.deepStrictEqual(measure.estimate(name, 350), { value: 400, n: 8, source: 'measured' });
    assert.deepStrictEqual(measure.estimate(name, 350, 9), { value: 350, n: 8, source: 'prior' });
  });

  await t('measure.snapshot / save / restore round trip', () => {
    const name = 'snap-' + Math.random();
    [5, 1, 9, 3].forEach((x) => measure.get(name).add(x));
    const snap = measure.snapshot()[name];
    assert.deepStrictEqual(snap, { n: 4, median: 4, p90: 9, mad: 2, last: 3 });
    const saved = JSON.parse(JSON.stringify(measure.save()));
    assert.deepStrictEqual(saved[name].values, [5, 1, 9, 3]);
    measure.get(name).load({ values: [] });
    assert.strictEqual(measure.get(name).n, 0);
    measure.restore(saved);
    assert.deepStrictEqual(measure.snapshot()[name], snap);
  });

  await t('measure.rttStart / rttEnd: float rtt into the rtt series (and per tag), failures not recorded', async () => {
    const before = measure.get('rtt').n, tag = 'tag-' + Math.random();
    const tok = measure.rttStart(tag);
    await new Promise((r) => setTimeout(r, 15));
    const rtt = measure.rttEnd(tok);
    assert.ok(rtt >= 10 && rtt < 200, String(rtt));
    assert.strictEqual(measure.get('rtt').last, rtt);
    assert.strictEqual(measure.get('rtt:' + tag).n, 1);
    const n1 = measure.get('rtt').n;
    assert.ok(n1 === before + 1 || n1 === 40);
    const bad = measure.rttEnd(measure.rttStart(tag), false);
    assert.ok(Number.isFinite(bad));
    assert.strictEqual(measure.get('rtt').last, rtt);
    assert.strictEqual(measure.get('rtt:' + tag).n, 1);
  });

  core._unload?.();
  if (failed) { console.log(failed + ' failed'); process.exit(1); }
  console.log('all passed');
  process.exit(0);
})();
