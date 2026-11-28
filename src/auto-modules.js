// ============================================================================
// AUTO MODULES (window.autoModules)
// ============================================================================
// Arranges the corp's modules (free and installed) over the group sockets so they add the most value per hour: the best set on
// each group, in the best socket order, the strongest modules on the groups where they are worth the most. On by default; the
// switch sits in the heading of the game's Modules page, with the value now against the best value, the moves still to make and a log.
//   autoModules.set(false) / autoModules.status() / autoModules.plan()   // switch, readout, the plan it would follow now (sends nothing)
//
// Scoring: the game's own numbers. engine.moduleReport(building, layout) is the call the game's group card makes (client B_,
// index-DnZR5vdC.js 2026-11-28): it returns the combined { speed, inputs_pct, outputs_pct, draws_pct, quality, strength } of a
// layout, with every quirk, neighbor bonus, coupling, Corner-tuned socket and Specialist building already applied. From it,
// per hour in cents (the group card's own $/s estimate, same file):
//   run ticks = max(1, floor(recipe ticks x 100 / (100 + speed)))                      client Q0 (the card's run time)
//   runs/h    = buildings x floor rate x 7200 / run ticks                               card: count x Fc (layout fx.rate) / ticks x 2 ticks/s
//   value     = runs/h x (outputs x outputs_pct/100 - inputs x inputs_pct/100) at catalog base_value   card prices runs at base_value
//   quality   = retail goods (on a store's shelves) sell at x (0.95 + 0.19 q / (q + 10)) / 0.95, q = recipe quality + report quality / 100
//               (wiki retail.md, measured; engine: a Calibrator's report quality 50 put 50 quality points per unit, shown / 100 by client Xw)
//   draws     - buildings x building draw x draws_pct/100 x the subscription price, power $10 per MW and water $4 per kL per 10-min bill
//               (engine: 20 Workshops start on 17 MW with an Efficiency module, draws_pct 85; prices as src/utilities.js). core.powerMeasure
//               applies the same draws_pct (drawsPct below), so Auto utilities lowers the subscription and the saving is real.
// Manufacturing Data has no price in the game, so MD only breaks ties between layouts worth the same in dollars (TIE cents per MD):
//   Instrumented: +1/240 MD per tick per quirk on a running group (client OM) = 30 MD/h.
//   Insightful:   its pct adds to the Lab success bonus (client EA: Labs owned + Insightful pct on Lab groups); MD saved per hour =
//                 sum over running Lab projects of 7200 / project ticks x cost x (1 - success before / success after)
//                 (client W0 success, kA costs 1k/10k/100k, bx project ticks). A Lab group is otherwise worth $0.
// A module adds value(layout) - value(layout without it). Only modules of an unknown kind stay where they are.
// Fleet sockets, paused groups and groups without a recipe (other than Labs) are left alone. A new layout is adopted only when it
// adds at least cfg.margin (2%) to the total; then each move is a RemoveModule,
// then an InstallModule, one message at a time, each confirmed in the game state before the next. Switching off finishes the move in
// progress first, so no module is left out of its socket. 3 unconfirmed changes in a row: it waits 10 minutes and tries again.
// Alt+Shift+X switches it off with everything else.
// @@MODULE auto-modules
try {
  (() => {
    const W = typeof window !== 'undefined' ? window : globalThis;
    const core = W.idleCore;
    if (!core) throw new Error('the shared core did not load');
    const mw = W.moduleWatch;
    if (!mw?.kinds) throw new Error('module watch did not load');
    const HAS_DOM = typeof document !== 'undefined' && !!document.body;
    const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
    const KEY = 'autoModules.v1', TAG = 'AM';
    if (W.autoModules?._unload) W.autoModules._unload();
    const { modId, usedCells, freeModules } = core.modules;
    const h = core.h;
    const CELLS = ['0,-1', '1,-1', '-1,0', '1,0', '-1,1', '0,1'];
    const CELL_NAME = { '0,-1': 'upper left', '1,-1': 'upper right', '-1,0': 'left', '1,0': 'right', '-1,1': 'lower left', '0,1': 'lower right' };
    const KNOWN = new Set(Object.values(mw.kinds));
    const TIE = 1e-4;                                  // cents per MD: MD only breaks ties (dollars always win)
    const POWER_CPH = 1000 * 6, WATER_CPH = 400 * 6;   // cents per MW / kL per hour: one bill every 1,200 ticks (src/utilities.js UTILS.rate)
    const MD_PER_QUIRK_H = 7200 / 240;                 // client OM: each Instrumented quirk counts as one more building's MD (1 per 240 ticks)
    const COST = [1000, 10000, 100000];                // client kA: MD per Lab project, Tier I-III
    const qf = (q) => 0.95 + 0.19 * q / (q + 10);      // wiki retail.md quality factor
    const succ = (tier, focus, bonus) => Math.min(95, Math.floor(([90, 70, 50][tier] - 5 * focus) * (100 + bonus) / 100));   // client W0
    // draws_pct of a group's current layout, as Auto modules last read it from the engine (100 when unknown: full draw, the safe side)
    const layoutKey = (b, mods) => b + JSON.stringify(mods);
    const curMods = (g) => Object.fromEntries(usedCells(g).map(([c, m]) => [c, modId(m)]));
    let drawsMemo = new Map();
    const drawsPct = (g) => (usedCells(g).length ? drawsMemo.get(layoutKey(g.building, curMods(g))) ?? 100 : 100);
    const MAX_FAILS = 3;
    const cfg = { cycleMs: 5000, confirmMs: 10000, backoffMs: 5000, margin: 0.02, replanMs: 60000 };
    const conf = { on: true };
    const usd = (c) => (c < 0 ? '−$' : '$') + Math.abs(c / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const same = (a, b) => a != null && b != null && String(a) === String(b);
    const movable = (d) => KNOWN.has(d.kind);
    const pctOf = (d, k) => (d?.quirks ?? []).filter((q) => q?.kind === k).reduce((a, q) => a + (k === 'Insightful' ? q.pct ?? 0 : 1), 0);

    // ---- the optimizer (pure: state, catalog and the engine in, target layout and moves out) ---------------------------------
    function plan(st, catalog, engine, { margin = cfg.margin } = {}) {
      const items = new Map((catalog.items ?? []).map((i) => [i.id, i.base_value ?? 0]));
      const recipes = new Map((catalog.recipes ?? []).map((r) => [r.id, r]));
      const bName = new Map((catalog.buildings ?? []).map((b) => [b.id, b.name]));
      const defs = st.module_defs ?? {};
      const def = (id) => defs[id] ?? defs[String(id)] ?? null;
      const memo = new Map();
      const report = (b, layout) => {
        const k = b + JSON.stringify(layout);
        if (!memo.has(k)) memo.set(k, JSON.parse(engine.moduleReport(b, JSON.stringify(layout))));
        return memo.get(k);
      };
      const bOf = new Map((catalog.buildings ?? []).map((b) => [b.id, b]));
      const isLab = (g) => bName.get(g.building) === 'Manufacturing Lab';
      // retail goods: on the shelves of an unpaused store group
      const retail = new Set(Object.values(st.groups ?? {}).filter((g) => !g.paused && Array.isArray(g.assortment)).flatMap((g) => g.assortment));
      const worth = (list, mult = () => 1) => (list ?? []).reduce((a, x) => a + x.amount * (items.get(x.item) ?? 0) * mult(x.item), 0);
      const sumQ = (layout, k) => Object.values(layout).reduce((a, id) => a + pctOf(def(id), k), 0);
      // Lab projects running now and the Insightful bonus outside a given Lab group (client EA: + Labs owned)
      const projects = Object.values(st.mfg_research ?? {}).filter((x) => x && COST[x.tier] != null);
      const projTicks = (product) => {   // client bx: 4 x the shortest input-using recipe for the product, 2 h to 24 h
        const ts = (catalog.recipes ?? []).filter((r) => r.inputs?.length && r.outputs?.some((o) => o.item === product)).map((r) => r.ticks);
        return Math.min(86400, Math.max(7200, (ts.length ? Math.min(...ts) : 240) * 4));
      };
      const labsOwned = Object.values(st.groups ?? {}).filter(isLab).reduce((a, g) => a + g.count, 0) + Object.values(st.building_pool ?? {}).reduce((a, p) => a + Object.entries(p ?? {}).filter(([b]) => bName.get(Number(b)) === 'Manufacturing Lab').reduce((s, [, n]) => s + n, 0), 0);
      const mdSaved = (bonus0, bonus1) => projects.reduce((a, p) => {
        const f = p.context ?? 0, s0 = succ(p.tier, f, bonus0), s1 = succ(p.tier, f, bonus1);   // shortcut: context read as the focus (0 process, 1 module, 2 quality), unconfirmed
        return s1 > 0 ? a + 7200 / projTicks(p.product) * COST[p.tier] * (1 - s0 / s1) : a;
      }, 0);
      // { u: cents per hour, m: MD per hour, v: u + TIE x m }
      const value = (g, layout) => {
        let u = 0, m = 0;
        if (g.lab) m = mdSaved(g.bonus, g.bonus + sumQ(layout, 'Insightful'));
        else {
          const r = report(g.building, layout), rc = g.rc, bd = bOf.get(g.building);
          const t = Math.max(1, Math.floor(rc.ticks * 100 / (100 + r.speed)));
          const q0 = rc.quality ?? 0, qm = (item) => (retail.has(item) ? qf(q0 + r.quality / 100) / qf(0) : 1);
          u = g.count * g.rate * 7200 / t * (worth(rc.outputs, qm) * r.outputs_pct / 100 - worth(rc.inputs) * r.inputs_pct / 100)
            - g.count * ((bd?.draws?.power ?? 0) * POWER_CPH + (bd?.draws?.water ?? 0) * WATER_CPH) * r.draws_pct / 100;
          m = MD_PER_QUIRK_H * sumQ(layout, 'Instrumented');
        }
        return { u, m, v: u + TIE * m };
      };
      // Groups whose sockets are ours: running a recipe and not paused, or a Lab.
      const groups = [];
      for (const [id, g] of Object.entries(st.groups ?? {})) {
        const rc = g.recipe != null ? st.recipes?.[String(g.recipe)] ?? recipes.get(g.recipe) : null;
        if (!(g.count > 0) || g.paused || (!rc && !isLab(g))) continue;
        const fixed = {}, cur = {};
        for (const [cell, m] of usedCells(g)) { const d = def(modId(m)); (d && movable(d) ? cur : fixed)[cell] = modId(m); }
        const x = { id: Number(id), name: g.name || bName.get(g.building) || 'group', building: g.building, count: g.count, rc, lab: !rc, rate: st.layouts?.[String(g.recipe)]?.fx?.rate ?? 1, fixed, cur, open: CELLS.filter((c) => !(c in fixed)) };
        if (x.lab) x.bonus = labsOwned + Object.entries(st.groups ?? {}).filter(([k, o]) => k !== id && isLab(o)).reduce((a, [, o]) => a + sumQ(curMods(o), 'Insightful'), 0);
        x.base = value(x, fixed);
        groups.push(x);
      }
      const drawsOut = new Map(groups.filter((g) => !g.lab && usedCells(st.groups[g.id]).length).map((g) => { const mods = curMods(st.groups[g.id]); return [layoutKey(g.building, mods), report(g.building, mods).draws_pct]; }));
      const pool = [...freeModules(st).filter(movable).map((d) => d.id), ...groups.flatMap((g) => Object.values(g.cur))];

      // The best placement of a set of modules on a group: every injective map of the set into the open sockets (6! = 720 at most).
      // The current placement is tried first and kept on a tie, so equal layouts never move a module.
      const val = (g, layout) => value(g, layout).v - g.base.v;
      const parts = (g, layout) => { const x = value(g, layout); return { u: x.u - g.base.u, m: x.m - g.base.m }; };
      const bestMemo = new Map();
      function best(g, ids) {
        const key = g.id + ':' + [...ids].sort((a, b) => a - b).join(',');
        if (bestMemo.has(key)) return bestMemo.get(key);
        let top = null;
        const curCells = Object.fromEntries(Object.entries(g.cur).filter(([, m]) => ids.includes(m)));
        if (Object.keys(curCells).length === ids.length) top = { v: val(g, { ...g.fixed, ...curCells }), cells: curCells };
        const pick = (i, used, cells) => {
          if (i === ids.length) { const v = val(g, { ...g.fixed, ...cells }); if (!top || v > top.v + 1e-9) top = { v, cells: { ...cells } }; return; }
          for (const c of g.open) if (!used.has(c)) { used.add(c); cells[c] = ids[i]; pick(i + 1, used, cells); delete cells[c]; used.delete(c); }
        };
        if (ids.length <= g.open.length) pick(0, new Set(), {});
        const r = top ?? { v: -Infinity, cells: {} };
        bestMemo.set(key, r);
        return r;
      }

      // Greedy: modules by their best value anywhere, each to the group where it adds the most; then moves and swaps until none helps.
      const on = new Map(pool.map((m) => [m, -1]));   // module -> index in groups, -1 free
      const setOf = (gi) => [...on].filter(([, x]) => x === gi).map(([m]) => m);
      const sv = (gi, ids) => (gi < 0 ? 0 : best(groups[gi], ids).v);
      const solo = (m) => Math.max(0, ...groups.map((g) => best(g, [m]).v));
      for (const m of [...pool].sort((a, b) => solo(b) - solo(a) || a - b)) {
        let bi = -1, bd = 1e-9;
        groups.forEach((g, gi) => { const s = setOf(gi); if (s.length >= g.open.length) return; const d = sv(gi, [...s, m]) - sv(gi, s); if (d > bd) { bd = d; bi = gi; } });
        on.set(m, bi);
      }
      for (let round = 0; round < 200; round++) {   // shortcut: rounds capped at 200, a corp with hundreds of modules may stop short of the optimum
        let bestD = 1e-6, apply = null;
        for (const m of pool) {
          const a = on.get(m), sa = setOf(a), sa2 = sa.filter((x) => x !== m), da = sv(a, sa2) - sv(a, sa);
          for (let b = -1; b < groups.length; b++) {
            if (b === a) continue;
            const sb = setOf(b);
            if (b >= 0 && sb.length < groups[b].open.length) { const d = da + sv(b, [...sb, m]) - sv(b, sb); if (d > bestD) { bestD = d; apply = [[m, b]]; } }
            else if (b < 0) { if (da > bestD) { bestD = da; apply = [[m, -1]]; } }
            for (const n of sb) {
              if (n <= m && a !== -1 && b !== -1) continue;   // each pair of placed modules once
              const d = sv(a, [...sa2, n]) - sv(a, sa) + sv(b, [...sb.filter((x) => x !== n), m]) - sv(b, sb);
              if (d > bestD) { bestD = d; apply = [[m, b], [n, a]]; }
            }
          }
        }
        if (!apply) break;
        for (const [m, gi] of apply) on.set(m, gi);
      }

      // Target per group, the margin, and the moves. Dollars (u) and MD (m) are kept apart for the readout and the margin.
      const bestCells = {}, rows = [];
      let cur = 0, top = 0, curM = 0, topM = 0;
      groups.forEach((g, gi) => {
        const s = setOf(gi), b = best(g, s), nowL = { ...g.fixed, ...g.cur }, now = val(g, nowL);
        // a reorder of the same set for less than the margin is not worth disturbing the group
        const sameSet = s.length === Object.keys(g.cur).length && s.every((m) => Object.values(g.cur).includes(m));
        const cells = sameSet && b.v - now < margin * Math.abs(now) ? g.cur : b.cells;
        const pn = parts(g, nowL), pb = cells === g.cur ? pn : parts(g, { ...g.fixed, ...cells });
        bestCells[g.id] = cells;
        rows.push({ group: g.id, name: g.name, now: pn.u, best: pb.u, nowM: pn.m, bestM: pb.m });
        cur += pn.u; top += pb.u; curM += pn.m; topM += pb.m;
      });
      // adopt for at least the margin in dollars, or for more MD at no dollar cost (MD only breaks ties)
      const adopt = (top - cur > 1e-6 && top - cur >= margin * Math.abs(cur)) || (top - cur > -1e-6 && topM - curM > 1e-6);
      const target = Object.fromEntries(groups.map((g) => [g.id, { ...g.fixed, ...(adopt ? bestCells[g.id] : g.cur) }]));
      const where = new Map();
      for (const g of groups) for (const [cell, m] of Object.entries(g.cur)) where.set(m, { group: g.id, cell });
      const to = new Map();
      if (adopt) for (const g of groups) for (const [cell, m] of Object.entries(target[g.id])) if (!(cell in g.fixed)) to.set(m, { group: g.id, cell });
      const gname = (id) => 'group ' + id + ' (' + (groups.find((g) => g.id === id)?.name ?? bName.get(st.groups[id]?.building) ?? '?') + ')';
      const gain = (id) => { const r = rows.find((x) => x.group === id); if (!r) return ''; const du = r.best - r.now, dm = r.bestM - r.nowM; return (du >= 0 ? '+' : '') + usd(du) + '/h' + (Math.abs(dm) > 0.05 ? ' · ' + (dm > 0 ? '+' : '') + dm.toFixed(1) + ' MD/h' : ''); };
      const moves = [];
      if (adopt) for (const m of pool) {
        const a = where.get(m) ?? null, b = to.get(m) ?? null;
        if (a && b && a.group === b.group && a.cell === b.cell) continue;
        if (!a && !b) continue;
        const name = mw.name(def(m));
        const text = name + ': ' + (a ? gname(a.group) + ' ' + CELL_NAME[a.cell] : 'free') + ' → ' + (b ? gname(b.group) + ' ' + CELL_NAME[b.cell] : 'free');
        const why = b ? gname(b.group) + ' ' + gain(b.group) : 'it costs ' + gname(a.group) + ' ' + usd(-best(groups.find((g) => g.id === a.group), [m]).v) + '/h';
        moves.push({ module: m, from: a, to: b, text, why });
      }
      // One message each: every remove first (a module must leave its socket before it goes into another), then the installs.
      const steps = [
        ...moves.filter((x) => x.from).map((x) => ({ msg: { type: 'RemoveModule', group: x.from.group, cell: x.from.cell }, module: x.module, text: 'remove ' + x.text })),
        ...moves.filter((x) => x.to).map((x) => ({ msg: { type: 'InstallModule', group: x.to.group, cell: x.to.cell, module: x.module }, module: x.module, text: 'install ' + x.text })),
      ];
      return { target, moves, steps, cur, best: adopt ? top : cur, top, curM, topM, rows, adopt, drawsPct: drawsOut };
    }

    // ---- steps against the game state ----------------------------------------------------------------------------------------
    const cellOf = (st, s) => modId(st.groups?.[s.msg.group]?.modules?.[s.msg.cell]);
    const done = (st, s) => (s.msg.type === 'RemoveModule' ? !same(cellOf(st, s), s.module) : same(cellOf(st, s), s.module));
    const valid = (st, s) => (s.msg.type === 'RemoveModule' ? same(cellOf(st, s), s.module)
      : cellOf(st, s) == null && freeModules(st).some((d) => same(d.id, s.module)));

    // ---- the runner ---------------------------------------------------------------------------------------------------------------
    let unloaded = false, busy = false, loopTimer = null, job = null, fails = 0, retryAt = 0, lastSig = '', lastAt = 0;
    const info = { note: 'Starting', cur: null, best: null, moves: [] };
    const log = [];
    const note = (kind, text) => { core.ledger.add(TAG, kind, text); log.push(new Date().toLocaleTimeString() + ' ' + text); if (log.length > 12) log.shift(); };
    function read(fresh = false) {
      const { ws, st, catalog, engine } = core.walk(fresh);
      if (!st || !catalog) return null;
      return { ws, st, catalog, engine, wsOpen: ws?.readyState === 1, mutTick: st.ssi?.last_user_mutation_tick ?? 0 };
    }
    // a removed module whose install is still to come: switching off waits for it
    const midMove = () => !!job && job.steps.some((s) => s.msg.type === 'InstallModule' && job.removed.has(s.module));
    const sigOf = (st) => JSON.stringify([Object.entries(st.groups ?? {}).map(([id, g]) => [id, g.count, g.recipe, g.paused, g.modules]), Object.keys(st.module_defs ?? {}), st.fleet_modules]);

    async function step(now = Date.now()) {
      if (busy || unloaded) return;
      busy = true;
      try {
        const r = read(true);
        if (!r) { info.note = 'Waiting for the game'; return; }
        if (typeof r.engine?.moduleReport !== 'function') { info.note = 'The game engine is not readable: nothing to score modules with'; return; }
        if (job && !conf.on && !midMove()) job = null;
        if (!job) {
          if (!conf.on) { info.note = 'Off'; info.moves = []; return; }
          const sig = sigOf(r.st);
          if (sig === lastSig && now - lastAt < cfg.replanMs) return;
          lastSig = sig; lastAt = now;
          const p = plan(r.st, r.catalog, r.engine);
          drawsMemo = p.drawsPct;
          Object.assign(info, { cur: p.cur, best: p.top, curM: p.curM, bestM: p.topM, moves: p.moves, note: p.moves.length ? '' : p.top > p.cur + 1e-6 ? 'Best layout adds under ' + cfg.margin * 100 + '%: left as it is' : 'Every module is where it adds the most' });
          if (!p.steps.length) return;
          job = { steps: p.steps, removed: new Set() };
          note('info', 'new layout: ' + usd(p.cur) + '/h → ' + usd(p.top) + '/h from modules, ' + p.moves.length + ' move' + (p.moves.length > 1 ? 's' : ''));
        }
        if (now < retryAt) { info.note = 'Retrying in ' + Math.ceil((retryAt - now) / 1000) + ' s'; return; }
        const s = job.steps[0];
        if (done(r.st, s)) { job.steps.shift(); if (s.msg.type === 'RemoveModule') job.removed.add(s.module); }
        else if (!valid(r.st, s)) { note('info', 'the sockets changed under the plan (' + s.text + '): planning again'); job = null; lastSig = ''; }
        else {
          if (!r.wsOpen) { info.note = 'Waiting for the game connection'; return; }   // nothing sent: not a failed change
          const d0 = core.markSend(r.mutTick);
          r.ws.send(JSON.stringify(s.msg));
          let ok = null;
          try { ok = await core.waitConfirm({ read, d0, timeoutMs: cfg.confirmMs, pred: (x) => done(x.st, s), closed: () => { throw new Error('socket closed'); } }); } catch { ok = null; }
          if (ok) {
            fails = 0; retryAt = 0;
            job.steps.shift();
            if (s.msg.type === 'RemoveModule') job.removed.add(s.module);
            note('action', s.text);
          } else if (core.link().state === 'open') {
            fails++;
            retryAt = now + Math.min(60000, cfg.backoffMs * 2 ** fails);
            note('fail', 'not confirmed: ' + s.text + ' (' + fails + '/' + MAX_FAILS + ')');
            if (fails >= MAX_FAILS) { fails = 0; retryAt = now + 600000; note('fail', 'the server did not apply ' + MAX_FAILS + ' changes in a row; trying again in 10 min'); }
          }
        }
        if (job && !job.steps.length) { job = null; lastSig = ''; }
        info.moves = job ? info.moves : [];
        info.note = job ? (conf.on ? '' : 'Finishing the move in progress, then off') : info.note;
      } catch (e) { console.error('[autoModules]', e); }
      finally { busy = false; render(); ensureLoop(); }
    }

    function ensureLoop() {
      const want = (conf.on || midMove()) && !unloaded;
      if (want && !loopTimer) loopTimer = core.every(cfg.cycleMs, step);
      else if (!want && loopTimer) { loopTimer(); loopTimer = null; }
    }
    function save() { try { store?.setItem(KEY, JSON.stringify(conf)); } catch { } }
    function set(on) {
      on = !!on;
      if (conf.on === on) return on;
      conf.on = on; save();
      lastSig = '';
      note('info', 'Auto modules ' + (on ? 'on' : midMove() ? 'off after the move in progress' : 'off'));
      ensureLoop(); render();
      return on;
    }
    const status = () => (conf.on ? 'on' : 'off') + ': ' + (info.cur != null ? usd(info.cur) + '/h from modules, best ' + usd(info.best) + '/h' : '') + (info.moves.length ? '; ' + info.moves.length + ' move(s) pending' : '') + (info.note ? '; ' + info.note : '');

    // ---- the page: a box in the heading of the Modules page ------------------------------------------------------------------
    const CSS = '.am-box{margin:0 0 12px;padding:10px 12px;border:1px solid var(--border,rgba(255,255,255,.12));border-radius:8px;background:var(--surface-2,rgba(255,255,255,.03));font-size:12px;line-height:1.45}' +
      '.am-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.am-val{color:var(--ink-2,#b6b6ba);font-variant-numeric:tabular-nums}' +
      '.am-sw{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-weight:600}.am-sw input{position:absolute;opacity:0;width:0;height:0}' +
      '.am-track{width:26px;height:14px;border-radius:7px;background:var(--surface-3,#27272a);border:1px solid var(--border,rgba(255,255,255,.18));position:relative;transition:background .15s}' +
      '.am-track::after{content:"";position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;background:var(--ink-2,#b6b6ba);transition:transform .15s}' +
      '.am-sw input:checked+.am-track{background:var(--status-good,#22b573);border-color:transparent}.am-sw input:checked+.am-track::after{transform:translateX(12px);background:#fff}' +
      '.am-sw input:focus-visible+.am-track{outline:2px solid var(--accent,#5b8def);outline-offset:2px}' +
      '.am-list{margin:6px 0 0;padding-left:18px}.am-muted{color:var(--muted,#808086)}' +
      '@media (prefers-reduced-motion:reduce){.am-track,.am-track::after{transition:none}}';
    let styleEl = null, domOff = null, box = null, mounted = false, uiSig = '';
    function modulesPanel() {
      for (const hd of document.querySelectorAll('section.panel > .panel-head')) if (hd.querySelector(':scope > h2')?.textContent.trim() === 'Modules') return hd.parentElement;
      return null;
    }
    function inject() {
      if (!HAS_DOM || unloaded || !mounted) return;
      const panel = modulesPanel();
      if (!panel) { box?.remove(); return; }
      const head = panel.querySelector(':scope > .panel-head');
      if (!box) {
        const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Auto modules', onchange: (e) => set(e.target.checked) });
        box = h('div', { class: 'am-box', 'data-am': 'box' },
          h('div', { class: 'am-head' }, h('label', { class: 'am-sw', title: 'Arrange the modules over the group sockets for the most value per hour' }, input, h('span', { class: 'am-track' }), h('span', {}, 'Auto modules')), h('span', { class: 'am-val', 'data-am': 'val' })),
          h('div', { class: 'am-muted', 'data-am': 'note', 'aria-live': 'polite' }), h('ul', { class: 'am-list', 'data-am': 'moves' }), h('ul', { class: 'am-list am-muted', 'data-am': 'log' }));
        uiSig = '';
      }
      if (box.previousElementSibling !== head) head.after(box);
      const sig = JSON.stringify([conf.on, info, log]);
      if (sig === uiSig) return;
      uiSig = sig;
      box.querySelector('input').checked = conf.on;
      box.querySelector('[data-am="val"]').textContent = info.cur != null ? 'Modules add ' + usd(info.cur) + '/h now · best ' + usd(info.best) + '/h' + (info.bestM ? ' (MD ' + info.curM.toFixed(0) + ' → ' + info.bestM.toFixed(0) + '/h, tie-break only)' : '') : '';
      const nt = box.querySelector('[data-am="note"]');
      nt.textContent = info.note || ''; nt.hidden = !info.note;
      box.querySelector('[data-am="moves"]').replaceChildren(...info.moves.map((m) => h('li', {}, m.text + ' · ' + m.why)));
      box.querySelector('[data-am="log"]').replaceChildren(...log.slice(-6).map((l) => h('li', {}, l)));
    }
    const render = () => { if (mounted && !unloaded) inject(); };
    function mountUi() {
      mounted = true;
      styleEl = h('style', { id: 'am-style' }, CSS);
      document.head.append(styleEl);
      domOff = core.ui.onDom(inject);
      inject();
    }

    // ---- load -----------------------------------------------------------------------------------------------------------------
    try { const o = JSON.parse(store?.getItem(KEY) || 'null'); if (typeof o?.on === 'boolean') conf.on = o.on; } catch { }
    W.autoModules = {
      set, stop: () => set(false), status, cfg, conf, drawsPct,
      get running() { return conf.on || midMove(); },
      plan: () => { const r = read(true); return r?.engine?.moduleReport ? plan(r.st, r.catalog, r.engine) : null; },
      exportCfg: () => ({ on: conf.on }),
      importCfg(o) { if (typeof o?.on !== 'boolean') return { applied: [], skipped: ['on'] }; set(o.on); return { applied: ['on'], skipped: [] }; },
      _plan: plan, _step: step, _info: info,
      _unload() { unloaded = true; loopTimer?.(); loopTimer = null; domOff?.(); styleEl?.remove(); box?.remove(); mounted = false; },
    };
    ensureLoop();
    if (HAS_DOM) (async () => {
      while (!document.querySelector('.primary-navigation')) { if (unloaded) return; await core.sleep(500); }
      if (unloaded) return;
      mountUi();
    })();
  })();
} catch (e) { console.error('[IdleCorp] Auto modules failed to load:', e); }
// @@END auto-modules
