// ============================================================================
// CORE PLAN DIRECTOR: 6. Retail (wiki core-game-plan 4.7, wiki retail.md)
// ============================================================================
// Director "retail" (order 45):
//   - Pre-store gate: once the Retail Store is unlocked, every made shelf good needs cfg.stockHoursPerShelf hours of what will sell
//     in stock: min(modelled demand, measured output) per hour (sales are capped by output, wiki 4.7). Held-only goods skip the gate.
//   - Builds 1 store (BuyBuilding, then CreateGroup amount 1 "Retail"; an empty Retail group is reused), then SetAssortment with up
//     to 4 of the board's goods the Corporation can make (made, assigned or held, best appetite x price first; Bookshelf, Table, Chair,
//     Bench when the board names none), only when the shelf set differs.
//     A shelved good leaves only after cfg.retailShelfDropMin minutes absent, so pauses do not churn the shelf.
//   - Money gate: floor + store price + bill floor (new MW x $20 + 2 h of bills, plan 8.1); Iron Frames keep cfg.ifReserve back.
//   - Checkpoint sampler (context): every cfg.retailSampleMin minutes after the shelves are set it records the shelf rows, the rating
//     and the stock, then judges the four rows of wiki 4.7. Sets ctx.retailOk (true / false / null), ctx.retailCap (furniture blocks the
//     measured sales can carry, on a fail), ctx.retailE1 (cfg.retailE1Hours in a row against the streak's first appetite).
//     Samples live in localStorage "corePlan.v1.mem.retail"; removing that key starts the checkpoint over.
//   - Fail path (plan step 6): furniture Workshops above the cap move to Frame Timber (SetRecipe a whole group, or Unassign and put the
//     pooled Workshops in a Frame Timber group). Farms are left on Cotton. Once the cap holds, one new checkpoint run starts at the capped
//     output (old decision kept as prevDecision, its cap in force); a pass of it sets ctx.retailOk = true (plan B3) and opens only the Oil Rig
//     gate: that pass proves the capped output sells, so the cap stays. ctx.retailFail / retailFailPath tell the other directors a measured
//     cap is in force (reserve, waves, land rule, ladder).
// @@MODULE cp-retail
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const P = W.idleCore?.planner;
  const REGION = 0, TPS = 2, TICKS_H = 3600 * TPS;
  // fallback shelf goods when the board names none the Corporation can make
  const RECIPE = { Bookshelf: 'Make Bookshelf', Table: 'Make Table', Chair: 'Make Chair', Bench: 'Make Bench' };
  const STORE = 'Retail Store', GROUP_NAME = 'Retail', WORKSHOP = 'Workshop', FT = 'Assemble Wooden Frame', FT_GROUP = 'Frame Timber';
  const RATES = { power: 1000, water: 400, bandwidth: 1500 };   // cents per unit per 10-min bill (same as autoUtil billsOf)
  // shortcut: the corp state carries no stock quality, so the price uses quality 0; read it once the protocol shows one.
  const Q0 = 0.952;                    // quality factor at quality 0 (wiki retail.md, Price)
  const cfg = () => W.corePlan.cfg;
  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const pct = (x) => (x * 100).toFixed(0) + '%';
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  // ---- the board ------------------------------------------------------------------------------------------------------------------
  // Asserts the shape seen on 2026-11-22 (shelves[region][itemId] = { appetite, held, standard, price }); never guesses past it.
  // Only appetite and price are required: held is just a note on the appetite row.
  function checkBoard(board, ids) {
    if (!board || typeof board !== 'object') return 'no board from engine.retailJson()';
    const rows = board.shelves?.[REGION] ?? board.shelves?.[String(REGION)];
    if (!board.shelves || typeof board.shelves !== 'object') return 'board has no "shelves"';
    if (!rows || typeof rows !== 'object') return 'board has no region ' + REGION + ' under "shelves"';
    for (const [n, id] of Object.entries(ids)) {
      const r = rows[id];
      if (!r) return 'no shelf row for ' + n + ' (item ' + id + ')';
      const miss = ['appetite', 'price'].filter((k) => !num(r[k]));
      if (miss.length) return n + ' row lacks ' + miss.join(', ');
    }
    return null;
  }
  // share = (1,000 + mine) / sum over store owners (1,000 + theirs) (wiki retail.md). ratings[region] = { corpId: rating } is assumed;
  // an empty or missing object means nobody else has a store. Anything else returns null (unknown shape, no guess).
  function shareOf(board, mine, corpId) {
    const all = board.ratings;
    if (all == null || (typeof all === 'object' && !Object.keys(all).length)) return 1;
    const rows = all[REGION] ?? all[String(REGION)];
    if (rows == null) return Object.values(all).every((x) => x && typeof x === 'object') ? 1 : null;
    if (typeof rows !== 'object' || !Object.values(rows).every(num)) return null;
    const me = 1000 + (mine ?? 0);
    const others = Object.entries(rows).filter(([k]) => String(k) !== String(corpId)).reduce((a, [, r]) => a + 1000 + r, 0);
    return me / (me + others);
  }
  function ratingOf(st) {
    const r = st.retail_ratings?.[REGION] ?? st.retail_ratings?.[String(REGION)];
    if (num(r)) return r;
    if (r && typeof r === 'object') { const x = r[st.ssi?.corp_id]; return num(x) ? x : null; }
    return null;
  }

  // Shelf goods: every board row the Corporation can make (a recipe on an unlocked building), name -> recipe name; RECIPE when none.
  function goodsOf(v, board) {
    const rows = board?.shelves?.[REGION] ?? board?.shelves?.[String(REGION)];
    const out = {};
    if (rows && typeof rows === 'object') for (const id of Object.keys(rows)) {
      const n = v.C.items[id]?.name;
      // engine items (Planks, frames: Core plan never sells them) are not shelf goods even when the board lists them
      if (!n || (W.corePlan.ENGINE_ITEMS.includes(n) && !RECIPE[n])) continue;
      const rs = Object.values(v.C.recipes).filter((r) => r.outputs?.[0]?.item === +id && v.unlocked(v.bld(r.building).name));
      const r = rs.find((x) => x.name === RECIPE[n]) ?? rs[0];
      if (r) out[n] = r.name;
    }
    return Object.keys(out).length ? out : RECIPE;
  }
  // A demand world event running now (wiki megaprojects-and-events: "Demand +-X% for item in region"). null: no event message seen.
  // shortcut: the WorldEvents payload is unverified; any event text naming demand with no end tick in the past counts. Parse its fields once a capture shows them.
  function demandEvent(we, tick) {
    if (!we?.raw) return null;
    let j = null;
    try { j = typeof we.raw === 'string' ? JSON.parse(we.raw) : we.raw; } catch { return /demand/i.test(String(we.raw)); }
    let hit = false;
    const walk = (o) => {
      if (hit || !o || typeof o !== 'object') return;
      const end = o.ends_at ?? o.end_tick ?? o.until ?? o.expires_at;
      if (Object.values(o).some((x) => typeof x === 'string' && /demand/i.test(x)) && !(typeof end === 'number' && tick != null && end <= tick)) { hit = true; return; }
      Object.values(o).forEach(walk);
    };
    walk(j);
    return hit;
  }

  // ---- what the Corporation makes ---------------------------------------------------------------------------------------------------
  // Units per tick from the groups on the good's recipe: runs per wave x output / recipe ticks (the live "work" rows hold the runs).
  function output(v, recipeId) {
    const rc = v.C.recipes[recipeId];
    if (!rc) return { perTick: 0, runsPerB: null };
    const amt = (rc.outputs ?? [])[0]?.amount ?? 1;
    let perTick = 0, runs = 0, blds = 0;
    for (const g of v.groups) {
      if (g.recipe !== recipeId || g.paused || !(g.count > 0)) continue;
      const w = (g.work ?? []).filter((x) => x.recipe === recipeId);
      if (w.length) for (const x of w) { perTick += x.runs * amt * (x.outputs_pct ?? 100) / 100 / rc.ticks; runs += x.runs; blds += x.buildings ?? g.count; }
      else perTick += g.count * cfg().retailRunsPerWave * amt / rc.ticks;
    }
    return { perTick, runsPerB: blds ? runs / blds : null, amt, ticks: rc.ticks };
  }
  // Units per hour one block (1 Workshop on the recipe) makes; the measured runs per building when a group runs it.
  const perBlockH = (o) => (o.ticks ? (o.runsPerB ?? cfg().retailRunsPerWave) * o.amt * TICKS_H / o.ticks : 0);

  // ---- facts for this step ----------------------------------------------------------------------------------------------------------
  function facts(v, ctx) {
    const c = cfg();
    const storeB = v.idB(STORE);
    const ids = {}, miss = [], recipeOf = goodsOf(v, ctx.retailBoard);
    for (const [n, rn] of Object.entries(recipeOf)) { const i = v.idI(n), r = v.idR(rn); if (i == null || r == null) miss.push(i == null ? n : rn); else ids[n] = i; }
    if (storeB == null) miss.push(STORE);
    if (miss.length) return { err: 'name not in the catalog: ' + miss.join(', ') + ' (director off until the names match)' };
    const badBoard = checkBoard(ctx.retailBoard, ids);
    const storeGroup = v.groups.find((g) => g.building === storeB && g.count > 0) ?? null;
    const emptyGroup = storeGroup ? null : v.groups.find((g) => g.building === storeB) ?? null;
    const f = { storeB, ids, names: Object.keys(recipeOf), storeGroup, emptyGroup, pooled: v.pool[storeB] ?? 0, owned: v.owned(STORE), unlocked: v.unlocked(STORE), rating: ratingOf(v.st), badBoard };
    if (badBoard) return f;
    const rows = ctx.retailBoard.shelves[REGION] ?? ctx.retailBoard.shelves[String(REGION)];
    f.share = shareOf(ctx.retailBoard, f.rating, v.st.ssi?.corp_id);
    const plId = v.idI('Planks');
    f.goods = Object.keys(ids).map((n) => {
      const id = ids[n], rid = v.idR(recipeOf[n]), row = rows[id], base = v.C.items[id]?.base_value ?? 0, o = output(v, rid), rc = v.C.recipes[rid];
      return { name: n, id, rid, appetite: row.appetite, held: row.held, boardPrice: row.price, base, unit: base * row.price / 10000 * Q0,
        stock: v.has(n), outTick: o.perTick, blockH: perBlockH(o), made: o.perTick > 0,
        // a paused or retuning group still counts: it comes back, and the shelf should not churn meanwhile
        assigned: v.groups.some((g) => g.recipe === rid && g.count > 0),
        ppu: (rc?.inputs ?? []).filter((x) => x.item === plId).reduce((a, x) => a + x.amount, 0) / (rc?.outputs?.[0]?.amount || 1) };
    });
    f.eligible = (g) => g.made || g.assigned || g.stock > 0;
    f.demandH = (g) => demandH(g, f.share);
    // Planks per hour the best four plank goods sell: the land rule sizes the engine to it (corePlan decide). Before a store sells, at the
    // share the target rating (cfg.retailRating) will give, not today's rating of 0.
    const dShare = f.storeGroup ? f.share : shareOf(ctx.retailBoard, Math.max(f.rating ?? 0, c.retailRating ?? 0), v.st.ssi?.corp_id);
    f.demandPlanksH = dShare == null ? null : pickOrder(f.goods.filter((g) => g.ppu > 0)).reduce((a, g) => a + demandH(g, dShare) * g.ppu, 0);
    // Before the store: the shelf is what is eligible now (shelfPick() adds the keep-on-shelf rule once the store exists).
    f.chosen = pickOrder(f.goods.filter(f.eligible));
    needOf(f, c);
    return f;
  }

  // Units per hour the shelf sells: appetite per 240 ticks x this store's share.
  const demandH = (g, share) => g.appetite / 240 * (share ?? 0) * TICKS_H;
  // Hours the stock lasts: it drains by demand minus what the groups make (Infinity when output keeps up). The board's `held` is not used.
  function shelfHours(g, share) {
    const drain = demandH(g, share) - g.outTick * TICKS_H;
    return drain > 0 ? g.stock / drain : Infinity;
  }
  const pickOrder = (gs) => [...gs].sort((a, b) => b.appetite * b.unit - a.appetite * a.unit).slice(0, 4);
  // 1 h of what will sell: sales stop at output once output is below demand, so stock past an hour of output adds nothing.
  // Only made goods: a held-only good cannot grow, it just sells out.
  function needOf(f, c) {
    f.need = f.chosen.filter((g) => g.made).map((g) => ({ g, need: Math.ceil(Math.min(f.demandH(g), g.outTick * TICKS_H) * c.stockHoursPerShelf) }));
  }
  // Once the store exists: a shelved good stays while it is eligible, and for cfg.retailShelfDropMin minutes after it stops being so.
  function shelfPick(f, ctx, m) {
    if (!f.storeGroup || f.badBoard || !f.goods) return;
    const c = cfg(), shelf = f.storeGroup.assortment ?? [], now = ctx.now;
    const absent = { ...(m.get().absentSince ?? {}) };
    let changed = false;
    const keep = f.goods.filter((g) => {
      if (f.eligible(g)) { if (absent[g.id] != null) { delete absent[g.id]; changed = true; } return true; }
      if (!shelf.includes(g.id)) { if (absent[g.id] != null) { delete absent[g.id]; changed = true; } return false; }
      if (absent[g.id] == null) { absent[g.id] = now; changed = true; }
      return now - absent[g.id] < c.retailShelfDropMin * 60000;
    });
    if (changed) m.set({ absentSince: absent });
    f.chosen = pickOrder(keep);
    needOf(f, c);
  }
  // What the next bill is now, every subscription together (cents).
  function billsOf(st) {
    let t = (st.isp ?? 0) * RATES.bandwidth;
    const pm = W.idleCore?.powerPriceMult?.() ?? 1;   // a world event's NPC power price multiplier
    for (const o of Object.values(st.subscriptions ?? {})) for (const [k, l] of Object.entries(o ?? {})) t += (l ?? 0) * (RATES[k] ?? 0) * (k === 'power' ? pm : 1);
    return t;
  }

  // ---- the checkpoint (wiki 4.7) -----------------------------------------------------------------------------------------------------
  // Sold between samples = modelled output - stock change; model = appetite / 240 x share, up to what was there to sell.
  function salesOver(samples, ids) {
    let sold = 0, model = 0;
    const by = {};
    for (const id of ids) by[id] = { sold: 0, model: 0, ticks: 0 };
    for (let k = 1; k < samples.length; k++) {
      const a = samples[k - 1], b = samples[k], ticks = (b.t - a.t) / 1000 * TPS;
      for (const id of ids) {
        const ga = a.g[id], gb = b.g[id];
        if (!ga || !gb) continue;
        const made = ga.out * ticks;
        const s = Math.max(0, made - (gb.s - ga.s));
        const m = Math.min(ga.a / 240 * (a.share ?? 1) * ticks, made + Math.max(0, ga.s));
        by[id].sold += s; by[id].model += m; by[id].ticks += ticks; sold += s; model += m;
      }
    }
    return { sold, model, by };
  }
  // base: appetite per item the drift is measured from (the E1 streak's first sample); default the first sample here.
  // live: board price per item now (default the last sample); demandOn: a demand world event runs, so appetite drift is unknown, not a fail.
  function rowsOf(samples, mem, c, now, e1 = false, base = null, live = null, demandOn = false) {
    const s0 = samples[0], sN = samples[samples.length - 1], ids = Object.keys(s0?.g ?? {});
    const out = [];
    // 1. appetite steady within +-tol of the baseline (a fixed one, so a slow slide adds up instead of hiding in a rolling window)
    let worst = 0, worstName = '';
    for (const id of ids) {
      const a0 = base?.[id] ?? s0.g[id].a;
      for (const s of samples) { const d = a0 && s.g[id] ? Math.abs(s.g[id].a / a0 - 1) : 0; if (d > worst) { worst = d; worstName = s0.g[id].n; } }
    }
    const held0 = ids.reduce((a, id) => a + (s0.g[id].h ?? 0), 0), heldN = ids.reduce((a, id) => a + (sN.g[id]?.h ?? 0), 0);
    const steady = worst <= c.retailAppetiteTol / 100;
    out.push({ id: 'appetite', ok: samples.length < 2 || (!steady && demandOn) ? null : steady, why: 'max drift ' + pct(worst) + (worstName ? ' (' + worstName + ')' : '') + ', limit ' + c.retailAppetiteTol + '%' + (!steady && demandOn ? ' (a demand world event runs: unknown)' : '') + '; held ' + held0 + ' -> ' + heldN });
    // 2. sales >= pass% of the model
    // per good (wiki E1): every shelved good with a model must pass, so one dead good cannot hide behind the others; the worst is named
    const sv = salesOver(samples, ids);
    const per = ids.filter((id) => sv.by[id].model > 0).map((id) => ({ n: s0.g[id].n, ...sv.by[id], x: sv.by[id].sold / sv.by[id].model })).sort((a, b) => a.x - b.x);
    const w = per[0];
    out.push({ id: 'sales', ok: per.length ? per.every((p) => p.x >= c.retailSamplePassPct / 100) : null,
      why: (w ? 'worst ' + w.n + ' sold ' + Math.round(w.sold) + ' of model ' + Math.round(w.model) + ' (' + pct(w.x) + ')' : 'no model yet') + ', all goods ' + Math.round(sv.sold) + ' of ' + Math.round(sv.model) + ', pass ' + c.retailSamplePassPct + '%' });
    // 3. price = base x board price x quality factor (quality 0), from each sample's own board price: the server sets the board price
    // (160% on 2026-11-21), so a board at another level or one that moves is the price, not a failed store. Unreadable: unknown.
    let pw = 0, pName = '', bad = false;
    for (const s of samples) for (const id of ids) {
      const x = s.g[id], want = live?.[id] ?? sN.g[id]?.p;
      if (!x) continue;
      if (!(x.p > 0) || !(want > 0)) { bad = true; continue; }
      const d = Math.abs(x.p / want - 1);
      if (d > pw || !pName) { pw = d; pName = x.n + ' ' + (want / 10000 * Q0).toFixed(2) + 'x base'; }
    }
    out.push({ id: 'price', ok: bad || !pName ? null : true, why: bad ? 'a shelf row has no board price' : 'live board: ' + (pName || '-') + (pw > 0 ? ', board moved up to ' + pct(pw) + ' during the run' : '') });
    // 4. rating >= target within cfg.retailRatingMin minutes of the shelves being set (+1 per tick from 0 gives 9,000 in 75 min)
    const rated = samples.filter((s) => num(s.r));
    const dl = mem.shelvedAt + c.retailRatingMin * 60000;
    const hit = rated.find((s) => s.r >= c.retailRating && s.t <= dl + c.retailSampleMin * 60000);
    const rate = rated.length >= 2 ? (rated[rated.length - 1].r - rated[0].r) / ((rated[rated.length - 1].t - rated[0].t) / 1000 * TPS) : null;
    // E1 run (after the checkpoint): the rating stays at the target at every sample of the run, not only the last one
    const okR = !rated.length ? null : e1 ? rated.every((s) => s.r >= c.retailRating) : hit ? true : now > dl + c.retailSampleMin * 60000 ? false : null;
    out.push({ id: 'rating', ok: okR,
      why: !rated.length ? 'no rating in st.retail_ratings' : 'rating ' + rated[rated.length - 1].r + (rate != null ? ', ' + rate.toFixed(2) + ' per tick' : '') + ', needs ' + c.retailRating + ' within ' + c.retailRatingMin + ' min' + (hit ? ' (reached at ' + Math.round((hit.t - mem.shelvedAt) / 60000) + ' min)' : '') });
    return { rows: out, sales: sv };
  }
  // Blocks the measured sales can carry: per good min(sold per hour over the last hour, latest demand per hour) / block units per hour.
  function capOf(samples, blockH) {
    const lastT = samples[samples.length - 1].t;
    const win = samples.filter((s) => s.t >= lastT - 3600000);
    const w = win.length >= 2 ? win : samples.slice(-2);
    const sN = samples[samples.length - 1];
    const sv = salesOver(w, Object.keys(sN.g));
    let blocks = 0;
    const by = {};
    for (const [id, x] of Object.entries(sv.by)) {
      const soldH = x.ticks ? x.sold / x.ticks * TICKS_H : 0;
      const demandH = sN.g[id].a / 240 * (sN.share ?? 1) * TICKS_H;
      const rateH = Math.min(soldH, demandH), bh = blockH[id] || 0;
      const b = bh ? rateH / bh : 0;
      by[sN.g[id].n] = +b.toFixed(2); blocks += b;
    }
    return { cap: Math.floor(blocks), by };
  }
  // Last 3 samples within +-5% of their mean: demand found a level (saturating); else it is still falling (decaying).
  function shapeOf(samples) {
    const tot = (s) => Object.values(s.g).reduce((a, x) => a + x.a, 0);
    const last = samples.slice(-3).map(tot), mean = last.reduce((a, b) => a + b, 0) / last.length;
    return last.every((x) => Math.abs(x / mean - 1) <= 0.05) ? 'saturating' : 'decaying';
  }

  const appetites = (smp) => Object.fromEntries(Object.entries(smp.g).map(([id, x]) => [id, x.a]));
  function sampler(v, ctx, f) {
    const c = cfg(), m = ctx.mem('retail');
    let mem = m.get();
    if (!f.storeGroup) {
      // Start over only when the store is really gone: none owned in a non-empty state, for cfg.retailGoneMin minutes.
      // One bad frame (empty groups, reconnect) or a store waiting in the pool keeps the samples.
      if (f.owned > 0) { if (mem.goneSince != null) mem = m.set({ goneSince: null }); }
      else if (v.groups.length && mem.shelvedAt) {
        if (mem.goneSince == null) mem = m.set({ goneSince: ctx.now });
        else if (ctx.now - mem.goneSince >= c.retailGoneMin * 60000)
          mem = m.set({ shelvedAt: null, samples: [], decision: null, prevDecision: null, streakStart: null, e1Base: null, e1: false, goneSince: null });
      }
      return { mem, n: 0 };
    }
    if (mem.goneSince != null) mem = m.set({ goneSince: null });
    // Re-checkpoint after a fail (plan B3, D-2): once the fail path has applied the cap (nothing left for failAction), or nothing was measured,
    // a new run starts at the capped output (again after each fail). The old decision stays as prevDecision: its cap holds meanwhile and
    // the readout shows it.
    const d0 = mem.decision;
    if (d0 && !d0.ok && !f.badBoard && (!d0.measured || !failAction(v, f, d0)))
      mem = m.set({ prevDecision: d0, decision: null, shelvedAt: ctx.now, samples: [], streakStart: ctx.now, e1Base: null, e1: false });
    const shelf = f.storeGroup.assortment ?? [];
    // The clock starts when the store can sell: the first read with shelves set, not the group's creation.
    if (!mem.shelvedAt) {
      if (!shelf.length || f.badBoard) return { mem, n: 0 };
      mem = m.set({ shelvedAt: ctx.now, samples: [], decision: null, streakStart: ctx.now, e1Base: null, e1: false });
    }
    const samples = mem.samples ?? [];
    const lastT = samples.length ? samples[samples.length - 1].t : -Infinity;
    if (!f.badBoard && ctx.now - lastT >= c.retailSampleMin * 60000 && shelf.length) {
      const g = {};
      for (const x of f.goods) if (shelf.includes(x.id)) g[x.id] = { n: x.name, a: x.appetite, h: x.held, p: x.boardPrice, s: x.stock, out: x.outTick };
      samples.push({ t: ctx.now, r: f.rating, share: f.share, g });
      // enough to cover the checkpoint and a whole E1 streak
      const keep = Math.max(60, Math.ceil(c.retailE1Hours * 60 / c.retailSampleMin) + 2);
      while (samples.length > keep) samples.shift();
      mem = m.set({ samples, ...(mem.e1Base ? {} : { e1Base: appetites(samples[samples.length - 1]) }) });
    }
    const res = { mem, n: samples.length };
    if (samples.length < 1) return res;
    const live = Object.fromEntries(f.goods.map((x) => [x.id, x.boardPrice]));
    const we = ctx.worldEvents ?? W.idleCore?.sock?.worldEvents ?? null;
    const ev = rowsOf(mem.decision ? samples.filter((x) => x.t >= (mem.streakStart ?? 0)) : samples, mem, c, ctx.now, !!mem.decision, mem.decision ? mem.e1Base : null, live, !!demandEvent(we, ctx.tick));
    res.rows = ev.rows;
    const blockH = Object.fromEntries(f.goods.map((x) => [x.id, x.blockH]));
    const age = ctx.now - mem.shelvedAt;
    if (!mem.decision && age >= c.retailCheckHours * 3600000) {
      const bad = ev.rows.filter((r) => r.ok === false), open = ev.rows.filter((r) => r.ok === null);
      let d = null;
      if (!bad.length && !open.length) d = { ok: true, kind: 'pass', at: ctx.now };
      else if (bad.length || age >= c.retailMaxHours * 3600000) {
        const kind = bad.some((r) => r.id === 'appetite') ? shapeOf(samples) : bad.length ? bad.map((r) => r.id).join('+') : 'undecided';
        const cp = samples.length >= 2 ? capOf(samples, blockH) : { cap: 0, by: {} };
        // measured: the cap comes from sales, so the fail path may act on it (an undecided run has no sales figure to trust)
        d = { ok: false, kind, cap: cp.cap, capBy: cp.by, measured: samples.length >= 2 && kind !== 'undecided', at: ctx.now, why: (bad.length ? bad : open).map((r) => r.id + ': ' + r.why).join('; ') };
      }
      if (d) mem = m.set({ decision: d });
      res.mem = mem;
    }
    // E1: rows (appetite vs the streak's first appetite, sales, price; rating once reached) passing for cfg.retailE1Hours in a row.
    // A failing sample restarts the run from that sample.
    if (mem.decision) {
      const run = ev.rows.filter((r) => r.id !== 'rating' || mem.decision.ok);
      if (run.some((r) => r.ok === false)) mem = m.set({ streakStart: ctx.now, e1Base: appetites(samples[samples.length - 1]), e1: false });
      else if (ctx.now - (mem.streakStart ?? mem.shelvedAt) >= c.retailE1Hours * 3600000 && mem.decision.ok) mem = m.set({ e1: true });
      res.mem = mem;
    }
    return res;
  }

  function context(v, ctx) {
    const f = facts(v, ctx);
    ctx.retail = f;
    if (f.err) return;
    shelfPick(f, ctx, ctx.mem('retail'));
    const s = sampler(v, ctx, f);
    f.sampler = s;
    // a re-run (B3) keeps the old fail in force until it decides: retailOk false, its cap, its fail path
    const prev = s.mem.prevDecision ?? null, d = s.mem.decision ?? prev;
    f.decision = d;
    // The measured fail whose cap is in force: the decision itself, or the fail before a re-run's pass. That pass proves only that the
    // capped output sells, so it opens the Oil Rig gate (retailOk) and nothing else: cap, land rule, Farms on Cotton and the ladder waiver stay.
    const capD = d && !d.ok && d.measured ? d : d?.ok && prev && !prev.ok && prev.measured ? prev : null;   // an undecided fail has no sales figure to cap at
    f.capDecision = capD;
    ctx.retailOk = f.storeGroup ? (d ? d.ok : null) : null;
    ctx.retailCap = capD ? capD.cap : null;
    ctx.retailE1 = !!(f.storeGroup && s.mem.e1);
    ctx.retailDecided = !!d;
    // fail path (plan A2): a measured cap in force (Farms stay, engine capped, CD from Wooden Frames)
    ctx.retailFail = !!(f.storeGroup && capD);
    ctx.retailFailPath = ctx.retailFail;
  }

  // ---- what to send ----------------------------------------------------------------------------------------------------------------
  function readoutOf(f) {
    if (!f || f.err) return { error: f?.err ?? 'no facts' };
    const s = f.sampler ?? {}, d = s.mem?.decision, p = s.mem?.prevDecision, capP = d?.ok && f.capDecision === p;
    return {
      board: f.badBoard ? 'BAD: ' + f.badBoard : 'ok', share: f.share, rating: f.rating,
      shelf: (f.chosen ?? []).map((g) => g.name + ' appetite ' + g.appetite + '/2min, ' + usd(g.unit) + ', stock ' + Math.floor(g.stock) + (g.made ? ', ' + (g.outTick * TICKS_H).toFixed(1) + '/h made' : '')),
      samples: s.n ?? 0, shelvedAt: s.mem?.shelvedAt ?? null,
      rows: (s.rows ?? []).map((r) => r.id + ' ' + (r.ok === null ? '?' : r.ok ? 'pass' : 'FAIL') + ': ' + r.why),
      decision: d ? (d.ok ? (capP ? 'PASS at the capped output: Oil Rig opens; the cap of ' + p.cap + ' furniture blocks stays, Farms stay on Cotton' : 'PASS (scale to the land rule)') : 'FAIL ' + d.kind + ': cap ' + d.cap + ' furniture blocks ' + JSON.stringify(d.capBy) + ', excess Workshops to Frame Timber, Farms stay on Cotton (' + d.why + ')')
        : p ? 're-checkpoint at the capped output: sampling (the earlier FAIL holds meanwhile)' : f.storeGroup ? 'sampling' : 'store not built',
      prevDecision: p ? 'FAIL ' + p.kind + ': cap ' + p.cap + ' furniture blocks (' + p.why + ')' : null,
      e1: !!s.mem?.e1,
    };
  }
  const workshopGroups = (v, wsB) => v.groups.filter((g) => g.building === wsB);
  // Fail path: furniture Workshops above the measured cap go to Frame Timber -> CD. One action per step, each gated on the state it
  // changes, so a slow confirm never moves twice. Order: name the new Frame Timber group's recipe, place pooled Workshops, then cut.
  function failAction(v, f, d) {
    const wsB = v.idB(WORKSHOP), ftR = v.idR(FT);
    if (wsB == null || ftR == null) return { wait: 'retail fail path: name not in the catalog: ' + (wsB == null ? WORKSHOP : FT) };
    const wg = workshopGroups(v, wsB);
    const unnamed = wg.find((g) => g.name === FT_GROUP && g.recipe == null);   // the group this path just made
    if (unnamed) return { action: { id: 'retail:ft:recipe:' + unnamed.id, text: 'retail fail: group "' + FT_GROUP + '" on Frame Timber', hold: true,
      steps: [{ msg: { type: 'SetRecipe', group: unnamed.id, recipe: ftR }, until: (x) => x.groups.find((g) => g.id === unnamed.id)?.recipe === ftR }] } };
    const pooled = v.pool[wsB] ?? 0;
    if (pooled > 0) {
      const ft = wg.filter((g) => g.recipe === ftR).sort((a, b) => b.count - a.count)[0];
      if (ft) {
        const c0 = ft.count;
        return { action: { id: 'retail:ft:assign:' + ft.id + ':' + c0, text: 'retail fail: ' + pooled + ' idle Workshop(s) to Frame Timber (group ' + ft.id + ')', hold: true,
          steps: [{ msg: { type: 'AssignBuildings', group: ft.id, amount: pooled }, until: (x) => (x.groups.find((g) => g.id === ft.id)?.count ?? 0) >= c0 + pooled }] } };
      }
      return { action: { id: 'retail:ft:create', text: 'retail fail: new group "' + FT_GROUP + '" with ' + pooled + ' idle Workshop(s)', hold: true,
        steps: [{ msg: { type: 'CreateGroup', building: wsB, amount: pooled, name: FT_GROUP, region: REGION }, until: (x) => x.groups.some((g) => g.building === wsB && g.name === FT_GROUP) }] } };
    }
    for (const g of f.goods) {
      if (!(g.name in (d.capBy ?? {}))) continue;   // not on the measured shelf: no sales figure for it
      const on = wg.filter((x) => x.recipe === g.rid && x.count > 0);
      const blocks = on.reduce((a, x) => a + x.count, 0), keep = Math.ceil(d.capBy[g.name] - 1e-9), excess = blocks - keep;
      if (excess <= 0) continue;
      // a whole group that fits in the excess just changes recipe; otherwise unassign the excess from the largest group
      const whole = on.filter((x) => x.count <= excess).sort((a, b) => b.count - a.count)[0];
      if (whole) return { action: { id: 'retail:ft:switch:' + whole.id, text: 'retail fail: ' + g.name + ' group ' + whole.id + ' (' + whole.count + ' Workshops) to Frame Timber, keeping ' + keep + ' on ' + g.name, hold: true,
        steps: [{ msg: { type: 'SetRecipe', group: whole.id, recipe: ftR }, until: (x) => x.groups.find((y) => y.id === whole.id)?.recipe === ftR }] } };
      const big = [...on].sort((a, b) => b.count - a.count)[0], c0 = big.count;
      // The cut goes straight on to Frame Timber, so nothing waits in the pool for buildout's tidy to put back on furniture.
      // No Frame Timber group: a new one; its recipe comes from the branch above on the next step (its id is not known before).
      const ft = wg.filter((x) => x.recipe === ftR).sort((a, b) => b.count - a.count)[0], f0 = ft?.count ?? 0;
      const to = ft ? { msg: { type: 'AssignBuildings', group: ft.id, amount: excess }, until: (x) => (x.groups.find((y) => y.id === ft.id)?.count ?? 0) >= f0 + excess }
        : { msg: { type: 'CreateGroup', building: wsB, amount: excess, name: FT_GROUP, region: REGION }, until: (x) => x.groups.some((y) => y.building === wsB && y.name === FT_GROUP) };
      return { action: { id: 'retail:ft:cut:' + big.id + ':' + c0, text: 'retail fail: move ' + excess + ' Workshops off ' + g.name + ' (group ' + big.id + ') to Frame Timber, keeping ' + keep, hold: true,
        steps: [{ msg: { type: 'UnassignBuildings', group: big.id, amount: excess }, until: (x) => (x.groups.find((y) => y.id === big.id)?.count ?? 0) <= c0 - excess }, to] } };
    }
    return null;
  }
  function decide(v, ctx, out) {
    const f = ctx.retail;
    const readout = readoutOf(f);
    if (!f || f.err) return { wait: f?.err ?? 'no facts (context did not run)', readout };
    if (f.badBoard) return { wait: 'RETAIL BOARD SHAPE CHANGED: ' + f.badBoard + '; not building or shelving until it is checked', readout };
    if (f.share == null) return { wait: 'RETAIL BOARD: unknown "ratings" shape, share not computed; not acting', readout };
    if (!f.unlocked && !f.storeGroup && !f.pooled && !f.emptyGroup) return { wait: 'Retail Store not unlocked', readout };
    if (!f.chosen.length) return { wait: 'no shelf good: the Corporation makes or holds none of ' + f.names.join(', '), readout };
    const want = f.chosen.map((g) => g.id);
    const storeB = f.storeB, p0 = f.pooled;
    if (!f.storeGroup && f.emptyGroup) {
      // reuse the empty Retail group (its shelves stay); never a second group or a rebuy behind the user's back
      const eg = f.emptyGroup;
      if (!p0) return { wait: 'manual: empty Retail group ' + eg.id + ' and no store in the pool (assign or delete it)', readout };
      return { action: { id: 'retail:store:assign:' + eg.id, text: 'put the pooled Retail Store into group ' + eg.id, hold: true,
        steps: [{ msg: { type: 'AssignBuildings', group: eg.id, amount: 1 }, until: (x) => (x.groups.find((g) => g.id === eg.id)?.count ?? 0) >= 1 }] }, readout };
    }
    if (!f.storeGroup) {
      const bd = v.bld(storeB);
      const steps = [];
      if (!p0) {
        const short = f.need.filter((x) => x.g.stock < x.need);
        if (short.length) return { wait: 'pre-store gate: ' + short.map((x) => x.g.name + ' ' + Math.floor(x.g.stock) + ' / ' + x.need).join(', ') + ' (' + cfg().stockHoursPerShelf + ' h of sales at min(demand, output))', readout };
        const cost = P ? P.price(bd.cost, v.ownedAll(STORE), 0) : bd.cost;
        // Iron Frames: until Stage D the prototypes and first builds still to pay are kept back (corePlan ifNeed, capped by cfg.ifReserve); this build's own frames are not
        const ifId = v.idI('Iron Frame'), late = out?.stage === 'D' || out?.stage === 'END';
        const keepOf = (i) => (i === ifId && !late ? Math.min(cfg().ifReserve ?? 0, W.corePlan._ifNeed(v, STORE)) : 0);
        const lack = (bd.build_items ?? []).filter((i) => (v.st.stock?.[REGION]?.[i.item] ?? 0) - i.amount < keepOf(i.item));
        if (lack.length) return { wait: 'store needs ' + lack.map((i) => i.amount + ' ' + (v.C.items[i.item]?.name ?? i.item) + (keepOf(i.item) ? ' (+' + keepOf(i.item) + ' kept for prototypes)' : '')).join(', '), readout };
        if (v.freeAcres < bd.acres) return { wait: 'store needs ' + bd.acres + ' free acres (' + v.freeAcres + ' free)', readout };
        // bill floor (plan 8.1): the store's always-on draw goes on every bill from now on
        const mw = bd.draws?.power ?? 0, billFloor = mw * 2000 * (W.idleCore?.powerPriceMult?.() ?? 1) + 12 * billsOf(v.st);
        const need = (ctx.floorCents ?? 0) + cost + billFloor;
        if (v.money < need) return { wait: 'store ' + usd(cost) + ' + bill floor ' + usd(billFloor) + ' (' + mw + ' MW x $20 + 2 h of bills): need ' + usd(need - v.money) + ' more above the floor', readout };
        steps.push({ msg: { type: 'BuyBuilding', building: storeB, amount: 1, region: REGION }, until: (x) => (x.pool[storeB] ?? 0) >= 1 || x.groups.some((g) => g.building === storeB && g.count > 0) });
      }
      steps.push({ msg: { type: 'CreateGroup', building: storeB, amount: 1, name: GROUP_NAME, region: REGION }, until: (x) => x.groups.some((g) => g.building === storeB && g.count > 0) });
      return { action: { id: 'retail:store', text: (p0 ? '' : 'build 1 Retail Store, then ') + 'group it as "' + GROUP_NAME + '"', steps, hold: true }, readout };
    }
    const g = f.storeGroup, have = g.assortment ?? [];
    if (!sameSet(have, want)) {
      return { action: { id: 'retail:shelf:' + want.join(','), text: 'shelves: ' + f.chosen.map((x) => x.name).join(', '),
        steps: [{ msg: { type: 'SetAssortment', group: g.id, items: want }, until: (x) => sameSet(x.groups.find((y) => y.id === g.id)?.assortment ?? [], want) }] }, readout };
    }
    const d = f.capDecision;   // a re-run, and its pass, keep cutting to the earlier fail's cap
    if (d) {
      const fa = failAction(v, f, d);
      if (fa) return { ...fa, readout };
    }
    return { wait: readout.decision, readout };
  }

  W.corePlan.addDirector({
    name: 'retail', order: 45,
    defaults: {
      stockHoursPerShelf: 1,       // hours of modelled sales in stock per shelf good before the store is built (wiki 4.7)
      retailSampleMin: 10,         // minutes between checkpoint samples
      retailCheckHours: 2,         // decide the checkpoint after this many hours
      retailMaxHours: 4,           // give up (fail) when a row still has no data by then
      retailAppetiteTol: 15,       // % appetite may move while the store sells
      retailSamplePassPct: 70,     // % of the modelled sales that must sell
      retailRating: 9000,          // rating the store must reach ...
      retailRatingMin: 90,         // ... within this many minutes of the build (75 at +1 per tick, plus slack)
      retailE1Hours: 6,            // E1: hours in a row with the rows passing
      retailShelfDropMin: 60,      // minutes a shelved good may be unmade and out of stock before it leaves the shelf
      retailGoneMin: 10,           // minutes with no store owned before the checkpoint starts over
      retailRunsPerWave: 5,        // runs per wave per Workshop when no group runs a recipe yet (wiki 2.1)
    },
    context, decide,
    duties: () => [{ duty: 'Retail Store, shelves and the retail checkpoint (wiki 4.7)', owner: 'Core plan', done: true }],
  });
  W.corePlan._retail = { facts, goodsOf, demandEvent, demandH, shelfHours, checkBoard, shareOf, salesOver, rowsOf, capOf, shapeOf };
})();
} catch (e) { console.error('[IdleCorp] cp-retail failed to load:', e); }
// @@END cp-retail
