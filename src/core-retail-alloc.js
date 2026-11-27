// ============================================================================
// RETAIL ALLOCATOR (window.idleCore.retailAlloc)
// ============================================================================
// Pure: Workshops per retail good that maximise $/h (scripts/retail-optimizer-plan.md R-3, R-4, B1). No DOM, sockets or timers.
// LP: max sum unitCents * uph_g * x_g  s.t.  sum x_g <= owned + buildable;  per input i: sum x_g * uph_g * in_g,i <= supply_i + max(0, stock_i - reserve_i) / stockBurnHours;
// x_g * uph_g <= demand_g (cfg.curSlack: per input, how far over its budget the current assignment may run and still be kept);  x_g >= 0;  only floorOk goods;  at most maxShelves goods. Solved exactly with a small simplex, then rounded to whole Workshops.
// Store capacity is not an LP limit: storesNeeded says how many stores the plan needs, and binding 'stores' flags a region short of them.
// Money: unitCents in cents, dollarsPerHour in dollars (assumes storesNeeded stores exist).
// @@MODULE retail-alloc
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');

  // max c.x s.t. A x <= b, x >= 0, b >= 0 (slack basis is feasible). Bland's rule, so no cycling.
  function simplex(c, A, b) {
    const m = A.length, n = c.length, N = n + m;
    const T = A.map((row, i) => [...row, ...Array.from({ length: m }, (_, k) => +(k === i)), b[i]]);
    const z = [...c.map((v) => -v), ...new Array(m + 1).fill(0)];
    const basis = Array.from({ length: m }, (_, i) => n + i);
    for (let it = 0; it < 1000; it++) {
      const e = z.findIndex((v, j) => j < N && v < -1e-12);
      if (e < 0) break;
      let r = -1, best = Infinity;
      for (let i = 0; i < m; i++) {
        if (T[i][e] <= 1e-12) continue;
        const q = T[i][N] / T[i][e];
        if (q < best - 1e-12 || (q <= best + 1e-12 && basis[i] < basis[r])) { best = q; r = i; }
      }
      if (r < 0) break;   // unbounded: cannot happen, the Workshops row bounds every x
      const p = T[r][e];
      for (let j = 0; j <= N; j++) T[r][j] /= p;
      for (const row of [...T.filter((_, i) => i !== r), z]) {
        const f = row[e];
        if (f) for (let j = 0; j <= N; j++) row[j] -= f * T[r][j];
      }
      basis[r] = e;
    }
    const x = new Array(n).fill(0);
    basis.forEach((v, i) => { if (v < n) x[v] = Math.max(0, T[i][N]); });
    return x;
  }

  function retailAlloc(input) {
    const cfg = { stockBurnHours: 24, moveGainPct: 3, maxShelves: 4, ...(input.cfg ?? {}) };
    const supply = input.supply ?? {}, stock = input.stock ?? {}, reserve = input.reserve ?? {}, stores = input.stores ?? {};
    const storeCap = input.storeCapPerHour ?? 50 * 7200;
    const owned = input.workshops?.owned ?? 0, buildable = input.workshops?.buildable ?? 0, Wmax = owned + buildable;
    // shortcut: goods without a region share the first store region, fine while the corp sells in one region; give goods a region for more.
    const defRegion = Object.keys(stores)[0] ?? 'default';
    const goods = input.goods.map((g) => {
      const uph = g.unitsPerWorkshopHour > 0 ? g.unitsPerWorkshopHour : 0, dem = g.demandPerHour > 0 ? g.demandPerHour : 0;   // NaN / missing -> 0
      return {
        ...g, region: g.region ?? defRegion, uph, dem, cents: g.unitCents > 0 ? g.unitCents : 0,
        inputs: g.inputs ?? (g.planksPerUnit ? { Planks: g.planksPerUnit } : {}),
        c: (g.unitCents > 0 ? g.unitCents : 0) * uph,     // cents per Workshop-hour
        cap: uph && dem ? Math.min(dem / uph, Wmax) : 0,  // Workshops that fill demand (Infinity demand -> Wmax)
      };
    });
    const items = [...new Set(goods.flatMap((g) => Object.keys(g.inputs)))];
    const budget = Object.fromEntries(items.map((i) => [i, (supply[i] ?? 0) + Math.max(0, (stock[i] ?? 0) - (reserve[i] ?? 0)) / cfg.stockBurnHours]));
    const use = (g, i) => (g.inputs[i] ?? 0) * g.uph;   // input i per Workshop-hour
    const eligible = goods.filter((g) => g.floorOk && g.c > 0);

    // Constraint rows over the goods in `gs`: kind, label, coefficient per good, limit.
    const rowsFor = (gs) => [
      { kind: 'workshops', a: gs.map(() => 1), b: Wmax },
      ...items.map((i) => ({ kind: i === 'Planks' ? 'planks' : 'inputs', item: i, a: gs.map((g) => use(g, i)), b: budget[i] })),
      ...gs.map((g, k) => ({ kind: 'demand', good: g, a: gs.map((_, j) => +(j === k)), b: g.cap })),
    ];
    const maxC = Math.max(1, ...eligible.map((g) => g.c));
    function solve(gs) {
      if (!gs.length) return { gs, x: [], obj: 0 };
      const rows = rowsFor(gs);
      // Rows scaled to max coefficient 1; objective scaled to 1, minus a tiny cost per Workshop so ties per plank pick fewer Workshops.
      const sc = rows.map((r) => Math.max(...r.a.map(Math.abs)) || 1);
      const x = simplex(gs.map((g) => g.c / maxC - 1e-7), rows.map((r, k) => r.a.map((v) => v / sc[k])), rows.map((r, k) => Math.max(0, r.b) / sc[k]));
      return { gs, x, obj: gs.reduce((s, g, k) => s + g.c * x[k], 0) };
    }
    let lp = solve(eligible);
    if (lp.x.filter((v) => v > 1e-9).length > cfg.maxShelves) {
      // More goods than shelves: best subset of maxShelves goods (C(10,4) = 210 tiny solves).
      const pick = (from, k, start = 0, acc = []) => {
        if (acc.length === k) { const s = solve(acc); if (s.obj > lp.obj || lp.x.filter((v) => v > 1e-9).length > k) lp = s; return; }
        for (let i = start; i < from.length; i++) pick(from, k, i + 1, [...acc, from[i]]);
      };
      pick(eligible, cfg.maxShelves);
    }

    // Integer plan: floor (with an epsilon against float noise), then one Workshop at a time to the best $/Workshop good that still fits.
    const tol = (b) => 1e-9 * Math.max(1, Math.abs(b));
    // slack: input item -> units/h the current assignment may run over its budget and still be kept (hysteresis against a wobbling budget)
    const fits = (x, slack = {}) => rowsFor(goods).every((r) => r.a.reduce((s, a, k) => s + a * x[k], 0) <= r.b + tol(r.b) + ((r.item && slack[r.item]) || 0));
    const plan = goods.map((g) => { const k = lp.gs.indexOf(g); return k < 0 ? 0 : Math.floor(lp.x[k] + 1e-9); });
    for (;;) {
      const used = plan.filter((v) => v > 0).length;
      let best = -1;
      goods.forEach((g, k) => {
        if (!eligible.includes(g) || (plan[k] === 0 && used >= cfg.maxShelves) || (best >= 0 && g.c <= goods[best].c)) return;
        plan[k]++;
        if (fits(plan)) best = k;
        plan[k]--;
      });
      if (best < 0) break;
      plan[best]++;
    }

    // Hysteresis: keep the current assignment when it is feasible and the plan gains no more than moveGainPct.
    const value = (x) => goods.reduce((s, g, k) => s + g.cents * Math.min(x[k] * g.uph, g.dem), 0);
    const cur = goods.map((g) => g.current ?? 0);
    const curOk = fits(cur, cfg.curSlack) && goods.every((g, k) => !cur[k] || eligible.includes(g)) && cur.filter((v) => v > 0).length <= cfg.maxShelves;
    const keep = curOk && value(plan) <= value(cur) * (1 + cfg.moveGainPct / 100);
    const x = keep ? cur : plan;
    const alloc = Object.fromEntries(goods.map((g, k) => [g.id, x[k]]));

    // Moves from current to alloc; 'pool' = unassigned or newly bought Workshops.
    const moves = [];
    if (!keep) {
      const out = [], inn = [];
      goods.forEach((g, k) => { const d = x[k] - cur[k]; if (d < 0) out.push([g.id, -d]); else if (d > 0) inn.push([g.id, d]); });
      for (const t of inn) {
        while (t[1] > 0 && out.length) {
          const n = Math.min(t[1], out[0][1]);
          moves.push({ from: out[0][0], to: t[0], n });
          t[1] -= n; out[0][1] -= n;
          if (!out[0][1]) out.shift();
        }
        if (t[1] > 0) moves.push({ from: 'pool', to: t[0], n: t[1] });
      }
      for (const [id, n] of out) moves.push({ from: id, to: 'pool', n });
    }

    // Shelves: allocated goods first, then goods with stock of their own, best unit price first.
    const byPrice = (a, b) => b.cents - a.cents;
    const shelfGoods = [...goods.filter((g, k) => x[k] > 0).sort(byPrice), ...goods.filter((g, k) => !x[k] && g.stock > 0).sort(byPrice)]
      .slice(0, cfg.maxShelves).sort(byPrice);
    const storesNeeded = {};
    for (const g of shelfGoods) {
      const k = goods.indexOf(g);
      storesNeeded[g.region] = (storesNeeded[g.region] ?? 0) + Math.min(x[k] * g.uph, g.dem);
    }
    for (const r in storesNeeded) storesNeeded[r] = Math.max(1, Math.ceil(storesNeeded[r] / storeCap - 1e-9));

    // Binding: constraints tight at the LP optimum, plus store regions short of storesNeeded.
    const tight = [];
    for (const r in storesNeeded) if (storesNeeded[r] > (stores[r] ?? 0)) tight.push({ kind: 'stores', text: 'stores: need ' + storesNeeded[r] + ' in ' + r + ', have ' + (stores[r] ?? 0) });
    const lpX = goods.map((g) => { const k = lp.gs.indexOf(g); return k < 0 ? 0 : lp.x[k]; });
    for (const r of rowsFor(goods)) {
      const lhs = r.a.reduce((s, a, k) => s + a * lpX[k], 0);
      if (r.kind === 'demand' ? !lp.gs.includes(r.good) : !eligible.length) continue;
      if (r.kind === 'demand' && r.good.dem / r.good.uph >= Wmax) continue;   // its cap is the Workshops row, not demand
      if (lhs < r.b - 1e-7 * Math.max(1, r.b)) continue;
      if (r.kind === 'workshops') tight.push(buildable > 0 ? { kind: 'workshops', text: 'Workshops ' + Wmax + ' (owned ' + owned + ' + buildable ' + buildable + ')' } : { kind: 'money', text: 'Workshops ' + owned + ', buildable=0 (no cash or acres for another)' });
      else if (r.kind === 'demand') tight.push({ kind: 'demand', text: r.good.name + ' demand ' + Math.round(r.good.dem) + '/h' });
      else tight.push({ kind: r.kind, text: r.item + ' ' + Math.round(r.b) + '/h fully used' });
    }
    const order = ['stores', 'money', 'workshops', 'planks', 'inputs', 'demand'];
    tight.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const spareWorkshops = Math.max(0, owned - x.reduce((s, v) => s + v, 0));

    return {
      alloc, shelves: shelfGoods.map((g) => g.id), storesNeeded,
      binding: tight[0]?.kind ?? 'none', bindings: [...new Set(tight.map((t) => t.kind))],
      detail: tight.length ? tight.map((t) => t.text).join('; ') + (spareWorkshops ? '; ' + spareWorkshops + ' Workshops spare' : '') : eligible.length ? 'nothing binds' : 'no good has a floor',
      dollarsPerHour: value(x) / 100, lpDollarsPerHour: lp.obj / 100, moves, spareWorkshops, budget,
    };
  }

  core.retailAlloc = retailAlloc;
})();
} catch (e) { console.error('[IdleCorp] retail-alloc failed to load:', e); }
// @@END retail-alloc
