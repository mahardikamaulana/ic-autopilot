// ============================================================================
// 1b. PACER AND MEASURE (window.idleCore.pacer, window.idleCore.measure)
// ============================================================================
// Human-looking waits and a command budget for every module that sends commands, plus the robust
// statistics the planner measures with. Everything is injectable (clock, sleep, rng) so tests run
// without real time.
//   const p = core.pacer({ now, sleep, rng, cmdsPerMin })   // core.pacer.default: real time
//   p.draw(kind) / await p.wait(kind) / await p.beforeCommand() / p.noteResult(ok) / p.noteConfirm({ ok, rtt })
//   core.measure.get(name).add(x) / .median / .mad / .p90;  slope(points);  estimate(name, prior)
// @@MODULE pacer
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');

  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // ---- measure: rolling robust statistics ------------------------------------
  const all = new Map();
  function series(name, { window = 40 } = {}) {
    if (all.has(name)) return all.get(name);
    let vals = [];
    const s = {
      add(x) { if (Number.isFinite(x)) { vals.push(x); if (vals.length > window) vals.shift(); } },
      get n() { return vals.length; },
      get median() { return median(vals); },
      // median absolute deviation: one slow reply barely moves it
      get mad() { const m = median(vals); return m === null ? null : median(vals.map((v) => Math.abs(v - m))); },
      // nearest rank
      get p90() { if (!vals.length) return null; return [...vals].sort((a, b) => a - b)[Math.ceil(0.9 * vals.length) - 1]; },
      get mean() { return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; },
      get last() { return vals.length ? vals[vals.length - 1] : null; },
      values: () => [...vals],
      toJSON: () => ({ window, values: [...vals] }),
      load(json) { vals = (json?.values ?? []).filter(Number.isFinite).slice(-window); },
    };
    all.set(name, s);
    return s;
  }

  // Theil-Sen: median of all pairwise slopes, so a few outliers (a purchase, a sale) do not bend it.
  // Per hour; null when there is too little to say anything.
  const MAX_SLOPE_POINTS = 60;   // pairwise work is quadratic: 360 samples would sort ~65k slopes every few seconds
  function slope(points) {
    if (!points || points.length < 3) return null;
    if (points.length > MAX_SLOPE_POINTS) {
      const step = (points.length - 1) / (MAX_SLOPE_POINTS - 1);
      points = Array.from({ length: MAX_SLOPE_POINTS }, (_, i) => points[Math.round(i * step)]);   // evenly spaced, first and last kept
    }
    const ts = points.map((p) => p.t);
    if (Math.max(...ts) - Math.min(...ts) < 60000) return null;
    const out = [];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dt = points[j].t - points[i].t;
        if (dt !== 0) out.push(((points[j].v - points[i].v) / dt) * 3600000);
      }
    }
    return median(out);
  }

  function estimate(name, prior, minN = 8) {
    const s = series(name);
    return s.n >= minN ? { value: s.median, n: s.n, source: 'measured' } : { value: prior, n: s.n, source: 'prior' };
  }

  // Round-trip time of one command: start at ws.send, end when the confirming Diff arrives. A reply
  // that never came (ok = false) has no round trip, so it is returned but not recorded.
  const rttStart = (tag) => ({ tag, t: clock() });
  function rttEnd(token, ok = true) {
    const rtt = clock() - token.t;
    if (ok) {
      series('rtt').add(rtt);
      if (token.tag) series('rtt:' + token.tag).add(rtt);
    }
    return rtt;
  }

  core.measure = {
    series, get: (name) => series(name), slope, estimate, rttStart, rttEnd,
    snapshot: () => Object.fromEntries([...all].map(([k, s]) => [k, { n: s.n, median: s.median, p90: s.p90, mad: s.mad, last: s.last }])),
    save: () => Object.fromEntries([...all].map(([k, s]) => [k, s.toJSON()])),
    restore(obj) { for (const [k, json] of Object.entries(obj ?? {})) series(k, { window: json?.window ?? 40 }).load(json); },
  };

  // ---- pacer -------------------------------------------------------------------
  const DRIFT_STEP = 0.02;   // per draw; ~400 draws (about 10 min of cycles) to wander across the band
  const POLL_SIGMA = 0.25;   // poll: roughly +-40% around 3 s
  const THINK_P = 1 / 22;    // chance that a cycle gap gets a 4-20 s think pause
  const WINDOW_MS = 60000;
  const SHORT_MS = 0.25;     // a sleep this much short of its target is topped up once

  function createPacer(opts = {}) {
    const now = opts.now ?? clock;
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const rng = opts.rng ?? Math.random;
    const cmdsPerMin = opts.cmdsPerMin ?? 20;
    const medianMs = { before: 500, step: 400, cycle: 600, poll: 3000, reconnect: 1000, ...opts.medianMs };
    const sigma = opts.sigma ?? 0.55, minMs = opts.minMs ?? 120, maxMs = opts.maxMs ?? 12000, thinkP = opts.thinkP ?? THINK_P;

    let drift = 1, debt = 0, factor = 1, okRun = 0, trips = 0;
    const cmds = [];                       // issue times inside the last minute
    let fails = 0, recent = [], tripped = null;

    const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

    function draw(kind) {
      const base = medianMs[kind];
      if (!(base > 0)) throw new Error('unknown pacer kind: ' + kind);
      drift = clamp(drift + (rng() * 2 - 1) * DRIFT_STEP, 0.75, 1.25);
      const sig = kind === 'poll' ? POLL_SIGMA : sigma;
      // poll keeps its mean (not its median) on target, it is a rate
      const centre = base * drift * factor * (kind === 'poll' ? Math.exp(-sig * sig / 2) : 1);
      const hi = maxMs * factor;
      let v;
      // redraw instead of clipping: a clip would pile many draws on one exact value
      for (let i = 0; i < 16; i++) { v = centre * Math.exp(sig * gauss()); if (v >= minMs && v <= hi) break; }
      v = clamp(v, minMs, hi);
      if (kind === 'cycle' && rng() < thinkP) v += 4000 + rng() * 16000;
      return v;
    }

    // setTimeout only does whole milliseconds: sleep the floor, top up the shortfall once, and carry
    // what is still over or under into the next wait so the average matches the drawn delays.
    async function wait(kind) {
      const drawn = draw(kind);
      const target = Math.max(0, drawn - debt);
      const t0 = now();
      await sleep(Math.floor(target));
      let actual = now() - t0;
      if (target - actual > SHORT_MS) { await sleep(target - actual); actual = now() - t0; }
      debt = clamp(actual - drawn, -5, 5);
      core.measure.get('own-wait').add(actual);
      return { drawn, actual };
    }

    function prune(t) { while (cmds.length && t - cmds[0] >= WINDOW_MS) cmds.shift(); }

    async function beforeCommand() {
      const start = now();
      for (;;) {
        const t = now();
        prune(t);
        if (cmds.length < cmdsPerMin) { cmds.push(t); return t - start; }
        await sleep(cmds[0] + WINDOW_MS - t + 1);   // +1 ms: whole-ms sleeps must still clear the window
      }
    }

    function noteResult(ok) {
      if (!ok) { factor = Math.min(8, factor * 1.5); okRun = 0; return; }
      if (++okRun >= 20) { factor = Math.max(1, factor / 1.5); okRun = 0; }
    }

    // The breaker keeps its own rtt window so a fresh pacer starts clean; it latches until resetBreaker.
    function noteConfirm({ ok, rtt }) {
      if (ok) { fails = 0; if (Number.isFinite(rtt)) { recent.push(rtt); if (recent.length > 40) recent.shift(); } } else fails++;
      if (tripped) return;
      if (fails >= 3) tripped = fails + ' unconfirmed commands in a row';
      else if (recent.length >= 8) {
        const lastFive = median(recent.slice(-5)), base = median(recent.slice(0, -5));
        if (lastFive > 5 * base) tripped = 'rtt median ' + Math.round(lastFive) + ' ms is over 5x its baseline ' + Math.round(base) + ' ms';
      }
      if (tripped) trips++;
    }

    function resetBreaker() { fails = 0; recent = []; tripped = null; }
    function clearTrips() { trips = 0; }   // a new run starts with no trips behind it

    function load(s) {
      factor = clamp(Number(s?.factor) || 1, 1, 8);
      drift = clamp(Number(s?.drift) || 1, 0.75, 1.25);
      debt = clamp(Number(s?.debt) || 0, -5, 5);
      trips = Number(s?.trips) | 0;
    }

    return {
      draw, wait, beforeCommand, noteResult, noteConfirm, resetBreaker, clearTrips, load,
      cmdsInLastMinute() { prune(now()); return cmds.length; },
      breaker: () => ({ open: !!tripped, reason: tripped }),
      state: () => ({ factor, drift, debt, trips }),
      get factor() { return factor; },
      get tripCount() { return trips; },
    };
  }

  core.pacer = Object.assign(createPacer, { default: createPacer() });
})();
} catch (e) { console.error('[IdleCorp] pacer failed to load:', e); }
// @@END pacer
