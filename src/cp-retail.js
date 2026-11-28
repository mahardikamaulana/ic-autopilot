// ============================================================================
// CORE PLAN DIRECTOR: 6. Retail (wiki core-game-plan 4.7, wiki retail.md)
// ============================================================================
// Director "retail" (order 45):
//   - Pre-store gate: once the Retail Store is unlocked, every made shelf good needs cfg.stockHoursPerShelf hours of what will sell
//     in stock: min(modelled demand, measured output) per hour (sales are capped by output, wiki 4.7). Held-only goods skip the gate.
//   - Builds 1 store (BuyBuilding, then CreateGroup amount 1 "Retail"; an empty Retail group is reused), then SetAssortment with up
//     to 4 of the board's goods the Corporation can make (made, assigned or held, best appetite x price first; Bookshelf, Table, Chair,
//     Bench when the board names none), only when the shelf set differs.
//     A shelved good leaves only after cfg.retailShelfDropMin minutes absent, so pauses do not churn the shelf. With the build-out
//     director's retail allocator (plan B1) the shelves are its planned goods plus the goods still made or kept, planned first, by unit
//     price (board price x base x the stock's quality factor); then more stores up to its storesNeeded (BuyBuilding + AssignBuildings, plan B5).
//   - Rival mode (plan R-8, D2): with another corp's store on the board (share < 1), only goods with cfg.rivalStockHours of stock at their
//     drain go on the shelf, an empty one with output short of demand leaves, quality goods first (the rating is scored per shelf).
//   - Money gate: floor + store price + bill floor (new MW x $20 + 2 h of bills, plan 8.1); Iron Frames keep cfg.ifReserve back.
//   - Checkpoint sampler (context): every cfg.retailSampleMin minutes after the shelves are set it records the shelf rows, the rating
//     and the stock, then judges the four rows of wiki 4.7 (appetite fails only on a fall) plus unsold stock. Sets ctx.retailOk (true / false
//     / null), ctx.retailCap (furniture blocks the measured sales can carry, only on unsold stock: plan R-1), ctx.retailE1 (cfg.retailE1Hours
//     in a row against the streak's first appetite). Samples live in localStorage "corePlan.v1.mem.retail" (schema 2: an older decision is
//     dropped on load, plan R-2; an old pass is kept); removing that key starts the checkpoint over. A fail is re-run after cfg.failTtlHours;
//     a pass turns into a measured fail when stock piles up unsold after it.
//   - Fail path (plan step 6): on unsold stock, furniture Workshops above the cap move to Frame Timber (SetRecipe a whole group, or Unassign
//     and put the pooled Workshops in a Frame Timber group). Farms are left on Cotton. Once the cap holds, one new checkpoint run starts at the
//     capped output (old decision kept as prevDecision, its cap in force); a pass of it sets ctx.retailOk = true (plan B3) and drops the cap.
//     ctx.retailFail / retailFailPath tell the other directors a measured cap is in force (reserve, waves, land rule, ladder).
// @@MODULE cp-retail
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const P = W.idleCore?.planner;
  const REGION = 0, TPS = 2, TICKS_H = 3600 * TPS;
  // fallback shelf goods when the board names none the Corporation can make
  const PD = W.idleCore.plans.current().core.directors.retail, T = PD.tables, MAX_SHELVES = W.idleCore.plans.current().core.maxShelves;   // plan data and settings (src/core-plans.js)
  const RECIPE = T.goods;
  const STORE = T.store, GROUP_NAME = T.groupName, WORKSHOP = 'Workshop', FT = T.ftRecipe, FT_GROUP = T.ftGroup;
  const RATES = { power: 1000, water: 400, bandwidth: 1500 };   // cents per unit per 10-min bill (same as autoUtil billsOf)
  const Q0 = 0.95;                     // quality factor at quality 0 (wiki retail.md, Price; engine BhehihUq)
  // Quality factor of the Heartland stock: 0.95 + 0.19 q / (q + 10), q = quality_points / units / 100 (wiki formulas.md); Q0 with none.
  const qOf = (st, id, r = REGION) => { const u = st.stock?.[r]?.[id] ?? 0; return u > 0 ? (st.quality_points?.[r]?.[id] ?? 0) / u / 100 : 0; };
  const qf = (st, id, r = REGION) => { const q = qOf(st, id, r); return Q0 + 0.19 * q / (q + 10); };
  const cfg = () => W.corePlan.cfg;
  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const pct = (x) => (x * 100).toFixed(0) + '%';
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  // ---- the board ------------------------------------------------------------------------------------------------------------------
  // Asserts the shape seen on 2026-11-22 (shelves[region][itemId] = { appetite, held, standard, price }); never guesses past it.
  // Only appetite and price are required: held is just a note on the appetite row.
  function checkBoard(board, ids, REGION = 0) {
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
  function shareOf(board, mine, corpId, REGION = 0) {
    const all = board.ratings;
    if (all == null || (typeof all === 'object' && !Object.keys(all).length)) return 1;
    const rows = all[REGION] ?? all[String(REGION)];
    if (rows == null) return Object.values(all).every((x) => x && typeof x === 'object') ? 1 : null;
    if (typeof rows !== 'object' || !Object.values(rows).every(num)) return null;
    const me = 1000 + (mine ?? 0);
    const others = Object.entries(rows).filter(([k]) => String(k) !== String(corpId)).reduce((a, [, r]) => a + 1000 + r, 0);
    return me / (me + others);
  }
  function ratingOf(st, REGION = 0) {
    const r = st.retail_ratings?.[REGION] ?? st.retail_ratings?.[String(REGION)];
    if (r == null) return 0;   // the engine deletes the key (or the whole map) when the rating reaches 0
    if (num(r)) return r;
    if (r && typeof r === 'object') { const x = r[st.ssi?.corp_id]; return num(x) ? x : null; }
    return null;
  }

  // Shelf goods: every board row the Corporation can make (a recipe on an unlocked building), name -> recipe name; RECIPE when none.
  function goodsOf(v, board) {
    const REGION = v.region ?? 0;
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
      const w = (g.work ?? []).filter((x) => x.recipe === recipeId || (g.process != null && x.recipe === g.process));   // a Lab process counts as its base recipe
      if (w.length) for (const x of w) { perTick += x.runs * amt * (x.outputs_pct ?? 100) / 100 / rc.ticks; runs += x.runs; blds += x.buildings ?? g.count; }
      else perTick += g.count * cfg().retailRunsPerWave * amt / rc.ticks;
    }
    return { perTick, runsPerB: blds ? runs / blds : null, amt, ticks: rc.ticks };
  }
  // Units per hour one block (1 Workshop on the recipe) makes; the measured runs per building when a group runs it.
  const perBlockH = (o) => (o.ticks ? (o.runsPerB ?? cfg().retailRunsPerWave) * o.amt * TICKS_H / o.ticks : 0);

  // ---- facts for this step ----------------------------------------------------------------------------------------------------------
  function facts(v, ctx) {
    const c = cfg(), REGION = v.region ?? 0;   // a region view (lever 4) reads its own board row, rating and stock
    const storeB = v.idB(STORE);
    const ids = {}, miss = [], recipeOf = goodsOf(v, ctx.retailBoard);
    for (const [n, rn] of Object.entries(recipeOf)) { const i = v.idI(n), r = v.idR(rn); if (i == null || r == null) miss.push(i == null ? n : rn); else ids[n] = i; }
    if (storeB == null) miss.push(STORE);
    if (miss.length) return { err: 'name not in the catalog: ' + miss.join(', ') + ' (director off until the names match)' };
    const badBoard = checkBoard(ctx.retailBoard, ids, REGION);
    const storeGroup = v.groups.find((g) => g.building === storeB && g.count > 0) ?? null;
    const emptyGroup = storeGroup ? null : v.groups.find((g) => g.building === storeB) ?? null;
    const f = { storeB, ids, names: Object.keys(recipeOf), storeGroup, emptyGroup, pooled: v.pool[storeB] ?? 0, owned: v.owned(STORE), unlocked: v.unlocked(STORE), rating: ratingOf(v.st, REGION), badBoard };
    if (badBoard) return f;
    const rows = ctx.retailBoard.shelves[REGION] ?? ctx.retailBoard.shelves[String(REGION)];
    f.share = shareOf(ctx.retailBoard, f.rating, v.st.ssi?.corp_id, REGION);
    const plId = v.idI('Planks');
    f.goods = Object.keys(ids).map((n) => {
      const id = ids[n], rid = v.idR(recipeOf[n]), row = rows[id], base = v.C.items[id]?.base_value ?? 0, o = output(v, rid), rc = v.C.recipes[rid];
      return { name: n, id, rid, appetite: row.appetite, held: row.held, boardPrice: row.price, base, unit: Math.floor(base * row.price / 10000 * qf(v.st, id, REGION)), q: qOf(v.st, id, REGION),
        stock: v.has(n), outTick: o.perTick, blockH: perBlockH(o), made: o.perTick > 0,
        // a paused or retuning group still counts: it comes back, and the shelf should not churn meanwhile
        assigned: v.groups.some((g) => g.recipe === rid && g.count > 0),
        ppu: (rc?.inputs ?? []).filter((x) => x.item === plId).reduce((a, x) => a + x.amount, 0) / (rc?.outputs?.[0]?.amount || 1) };
    });
    f.eligible = (g) => g.made || g.assigned || g.stock > 0;
    f.demandH = (g) => demandH(g, f.share);
    // rival mode (plan R-8, D2): another corp's store is on the board, so empty shelves cost rating, and rating is share
    f.rival = !!storeGroup && f.share < 1 && c.rivalStockHours > 0;
    // Planks per hour the best four plank goods sell: the land rule sizes the engine to it (corePlan decide). Before a store sells, at the
    // share the target rating (cfg.retailRating) will give, not today's rating of 0.
    const dShare = f.storeGroup ? f.share : shareOf(ctx.retailBoard, Math.max(f.rating ?? 0, c.retailRating ?? 0), v.st.ssi?.corp_id, REGION);
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
  // qFirst (rival mode): goods with quality > 0 first, they score +2 a sale instead of +1
  const qRank = (a, b) => (b.q >= 0.01) - (a.q >= 0.01);
  const pickOrder = (gs, qFirst = false) => [...gs].sort((a, b) => (qFirst && qRank(a, b)) || b.appetite * b.unit - a.appetite * a.unit).slice(0, MAX_SHELVES);
  // Rival mode (plan R-8, D2): the rating is scored per shelf each tick: +1 for a shelf that sold (+2 at quality >= 0.01), -2 for a shelf
  // with a customer due but no stock or no power (wiki retail.md). So a good goes on the shelf only with cfg.rivalStockHours of stock at
  // its drain (demand at today's share less output; any stock when output keeps up), and leaves once it is empty with output short of
  // demand (it cannot stay stocked); in between it stays, so an output-limited good fills off the shelf and sells down on it, no churn.
  const rivalOk = (f, g, shelf) => (shelf.includes(g.id) ? !(g.stock < 1 && shelfHours(g, f.share) < Infinity) : shelfHours(g, f.share) >= cfg().rivalStockHours);
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
    f.keep = f.rival ? keep.filter((g) => rivalOk(f, g, shelf)) : keep;
    f.chosen = pickOrder(f.keep, f.rival);
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
    for (const id of ids) by[id] = { sold: 0, model: 0, made: 0, ticks: 0 };
    for (let k = 1; k < samples.length; k++) {
      const a = samples[k - 1], b = samples[k], ticks = (b.t - a.t) / 1000 * TPS;
      for (const id of ids) {
        const ga = a.g[id], gb = b.g[id];
        if (!ga || !gb) continue;
        const made = ga.out * ticks;
        const s = Math.max(0, made - (gb.s - ga.s));
        const m = Math.min(ga.a / 240 * (a.share ?? 1) * ticks, made + Math.max(0, ga.s));
        by[id].sold += s; by[id].model += m; by[id].made += made; by[id].ticks += ticks; sold += s; model += m;
      }
    }
    return { sold, model, by };
  }
  // base: appetite per item the drift is measured from (the E1 streak's first sample); default the first sample here.
  // live: board price per item now (default the last sample); demandOn: a demand world event runs, so appetite drift is unknown, not a fail.
  function rowsOf(samples, mem, c, now, e1 = false, base = null, live = null, demandOn = false) {
    const s0 = samples[0], sN = samples[samples.length - 1], ids = Object.keys(s0?.g ?? {});
    const out = [];
    // 1. appetite no more than tol below the baseline (a fixed one, so a slow slide adds up instead of hiding in a rolling window).
    // A rise passes (plan A1): more demand is good news, not drift.
    let worst = 0, worstName = '', grew = 0;
    for (const id of ids) {
      const a0 = base?.[id] ?? s0.g[id].a;
      for (const s of samples) {
        const d = a0 && s.g[id] ? 1 - s.g[id].a / a0 : 0;
        if (d > worst) { worst = d; worstName = s0.g[id].n; }
        if (-d > grew) grew = -d;
      }
    }
    const held0 = ids.reduce((a, id) => a + (s0.g[id].h ?? 0), 0), heldN = ids.reduce((a, id) => a + (sN.g[id]?.h ?? 0), 0);
    const steady = worst <= c.retailAppetiteTol / 100;
    out.push({ id: 'appetite', ok: samples.length < 2 || (!steady && demandOn) ? null : steady, why: 'max fall ' + pct(worst) + (worstName ? ' (' + worstName + ')' : '') + ', limit ' + c.retailAppetiteTol + '%' + (grew > 0 ? ', demand grew ' + pct(grew) : '') + (!steady && demandOn ? ' (a demand world event runs: unknown)' : '') + '; held ' + held0 + ' -> ' + heldN });
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
    // 4. rating >= target within cfg.retailRatingMin minutes of the shelves being set, checked only while a rival store is on the board.
    // The rating is scored per shelf (+1 per shelf that sold, +2 at quality >= 0.01, -2 per shelf with a customer due but no stock or power; wiki retail.md), so an
    // output-limited store sits near 0; alone, share is 100% at any rating, so the rating is no test of the store.
    const rival = samples.some((s) => num(s.share) && s.share < 1);
    const rated = samples.filter((s) => num(s.r));
    const dl = mem.shelvedAt + c.retailRatingMin * 60000;
    const hit = rated.find((s) => s.r >= c.retailRating && s.t <= dl + c.retailSampleMin * 60000);
    const rate = rated.length >= 2 ? (rated[rated.length - 1].r - rated[0].r) / ((rated[rated.length - 1].t - rated[0].t) / 1000 * TPS) : null;
    // E1 run (after the checkpoint): the rating stays at the target at every sample of the run, not only the last one
    const okR = !rival ? (samples.length ? true : null) : !rated.length ? null : e1 ? rated.every((s) => s.r >= c.retailRating) : hit ? true : now > dl + c.retailSampleMin * 60000 ? false : null;
    const ratingTxt = rated.length ? 'rating ' + rated[rated.length - 1].r + (rate != null ? ', ' + rate.toFixed(2) + ' per tick' : '') : 'no rating in st.retail_ratings';
    out.push({ id: 'rating', ok: okR,
      why: !rival ? ratingTxt + '; no rival store on the board, so the rating is not checked (share 100%)'
        : ratingTxt + ', needs ' + c.retailRating + ' within ' + c.retailRatingMin + ' min (a rival store is on the board)' + (hit ? ' (reached at ' + Math.round((hit.t - mem.shelvedAt) / 60000) + ' min)' : '') });
    return { rows: out, sales: sv };
  }
  // Unsold stock (plan R-1), the only thing that sets a furniture cap: a shelved good whose stock grew over the last cfg.capStockHours
  // while more than (100 - retailSamplePassPct)% of its output went unsold. Low sales because output is low never counts.
  // Its cap: blocks its measured sales over the last hour carry (sold per hour / block units per hour). A sample interval with no sale at
  // all is left out (the store was dark, e.g. no power left for it, or a bad read: no demand figure). null: nothing unsold, the window is
  // not covered yet, or no interval sold.
  // Per good over the sample intervals that sold something: sold, made, stock change (also per half of the window: h[0] up to mid, h[1]
  // after, null for a half with no such interval), ticks.
  function liveSales(win, ids, mid = Infinity) {
    const by = Object.fromEntries(ids.map((id) => [id, { sold: 0, made: 0, grew: 0, ticks: 0, h: [null, null] }]));
    let n = 0;
    for (let k = 1; k < win.length; k++) {
      const sv = salesOver([win[k - 1], win[k]], ids);
      if (!(sv.sold > 0)) continue;
      n++;
      for (const id of ids) {
        const a = win[k - 1].g[id], b = win[k].g[id], x = sv.by[id];
        if (!a || !b) continue;
        by[id].sold += x.sold; by[id].made += x.made; by[id].ticks += x.ticks; by[id].grew += b.s - a.s;
        const j = win[k].t <= mid ? 0 : 1; by[id].h[j] = (by[id].h[j] ?? 0) + b.s - a.s;
      }
    }
    return n ? by : null;
  }
  function capOf(samples, blockH, c = cfg()) {
    const sN = samples[samples.length - 1], ids = Object.keys(sN.g), from = sN.t - c.capStockHours * 3600000;
    const w = samples.filter((s) => s.t >= from);
    if (w.length < 2 || w[0].t > from + c.retailSampleMin * 60000) return null;
    const sv = liveSales(w, ids, from + c.capStockHours * 1800000);
    if (!sv) return null;
    const rv = liveSales(samples.filter((s) => s.t >= sN.t - 3600000), ids) ?? sv;   // the last hour; the whole window when it all was dark
    let blocks = 0;
    const by = {}, why = [];
    for (const id of ids) {
      const x = sv[id], grew = x.grew;
      if (!w[0].g[id] || !(x.made > 0)) continue;
      // growing for the whole window: up in each half that has a sale (a glut younger than the window is not one yet)
      if (!(grew > 0) || x.h.some((g) => g != null && !(g > 0)) || x.sold >= x.made * c.retailSamplePassPct / 100) continue;
      const r = rv[id], soldH = r.ticks ? r.sold / r.ticks * TICKS_H : 0, bh = blockH[id] || 0;
      if (!(soldH > 0) || !(bh > 0)) continue;   // never a cap of 0 Workshops from an hour with no sales figure
      const b = soldH / bh;
      by[sN.g[id].n] = +b.toFixed(2); blocks += b;
      why.push(sN.g[id].n + ' stock +' + Math.round(grew) + ' in ' + c.capStockHours + ' h, sold ' + Math.round(x.sold) + ' of ' + Math.round(x.made) + ' made');
    }
    return why.length ? { cap: Math.floor(blocks), by, why: why.join(', ') } : null;
  }
  // Last 3 samples within +-5% of their mean: demand found a level (saturating); else it is still falling (decaying).
  function shapeOf(samples) {
    const tot = (s) => Object.values(s.g).reduce((a, x) => a + x.a, 0);
    const last = samples.slice(-3).map(tot), mean = last.reduce((a, b) => a + b, 0) / last.length;
    return last.every((x) => Math.abs(x / mean - 1) <= 0.05) ? 'saturating' : 'decaying';
  }

  const appetites = (smp) => Object.fromEntries(Object.entries(smp.g).map(([id, x]) => [id, x.a]));
  const SCHEMA = 2, RESET = { shelvedAt: null, samples: [], decision: null, prevDecision: null, streakStart: null, e1Base: null, e1: false };
  function sampler(v, ctx, f) {
    const c = cfg(), m = ctx.mem('retail');
    let mem = m.get();
    // Schema 2 (plan R-2): a fail saved by an older version (no schema) was judged by the old rules, so the checkpoint starts over.
    // An old pass stays: wiping it would close the Oil Rig gate and hold CD cycling for another checkpoint.
    if (mem.schema !== SCHEMA) mem = m.set({ schema: SCHEMA, ...(mem.decision?.ok === false || mem.prevDecision ? RESET : {}) });
    // A fail is re-judged after cfg.failTtlHours (plan A1): the decision starts over; a re-run's old fail just drops.
    const stale = (d) => !!d && !d.ok && ctx.now - (d.at ?? 0) >= c.failTtlHours * 3600000;
    if (stale(mem.decision)) mem = m.set(RESET);
    else if (stale(mem.prevDecision)) mem = m.set({ prevDecision: null });
    if (!f.storeGroup) {
      // Start over only when the store is really gone: none owned in a non-empty state, for cfg.retailGoneMin minutes.
      // One bad frame (empty groups, reconnect) or a store waiting in the pool keeps the samples.
      if (f.owned > 0) { if (mem.goneSince != null) mem = m.set({ goneSince: null }); }
      else if (v.groups.length && mem.shelvedAt) {
        if (mem.goneSince == null) mem = m.set({ goneSince: ctx.now });
        else if (ctx.now - mem.goneSince >= c.retailGoneMin * 60000)
          mem = m.set({ ...RESET, goneSince: null });
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
      const un = samples.length >= 2 ? capOf(samples, blockH, c) : null;   // unsold stock: a fail of its own, and the only cap
      let d = null;
      if (!bad.length && !open.length && !un) d = { ok: true, kind: 'pass', at: ctx.now };
      else if (bad.length || un || age >= c.retailMaxHours * 3600000) {
        const kind = bad.some((r) => r.id === 'appetite') ? shapeOf(samples) : bad.length ? bad.map((r) => r.id).join('+') : un ? 'unsold' : 'undecided';
        // measured: unsold stock gives a sales figure, so the fail path may act on it; any other fail moves no Workshop (plan R-1)
        const why = [...(bad.length ? bad : un ? [] : open).map((r) => r.id + ': ' + r.why), ...(un ? ['unsold: ' + un.why] : [])].join('; ');
        d = { ok: false, kind, cap: un?.cap ?? 0, capBy: un?.by ?? {}, measured: !!un, at: ctx.now, why };
      }
      if (d) mem = m.set({ decision: d });
      res.mem = mem;
    } else if (mem.decision?.ok && samples.length >= 2) {
      // A pass is not for good: stock piling up unsold for cfg.capStockHours after it is a new (measured) fail with its cap.
      const un = capOf(samples, blockH, c);
      if (un) mem = m.set({ decision: { ok: false, kind: 'unsold', cap: un.cap, capBy: un.by, measured: true, at: ctx.now, why: 'after the pass, unsold: ' + un.why }, streakStart: ctx.now, e1: false });
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
    // The measured fail whose cap is in force: the decision itself, or the fail a re-run is checking. A pass of the re-run drops the cap (plan A1).
    const capD = d && !d.ok && d.measured ? d : null;   // a fail without unsold stock has no sales figure to cap at
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
    const s = f.sampler ?? {}, d = s.mem?.decision, p = s.mem?.prevDecision;
    return {
      board: f.badBoard ? 'BAD: ' + f.badBoard : 'ok', share: f.share, rating: f.rating,
      rival: f.rival ? 'a rival store is on the board: shelves only goods with ' + cfg().rivalStockHours + ' h of stock at their drain, quality goods first' : null,
      shelf: (f.chosen ?? []).map((g) => g.name + ' appetite ' + g.appetite + '/2min, ' + usd(g.unit) + ', stock ' + Math.floor(g.stock) + (g.made ? ', ' + (g.outTick * TICKS_H).toFixed(1) + '/h made' : '')),
      samples: s.n ?? 0, shelvedAt: s.mem?.shelvedAt ?? null,
      rows: (s.rows ?? []).map((r) => r.id + ' ' + (r.ok === null ? '?' : r.ok ? 'pass' : 'FAIL') + ': ' + r.why),
      decision: d ? (d.ok ? (p?.measured ? 'PASS at the capped output: the earlier cap drops (scale to the land rule)' : 'PASS (scale to the land rule)')
        : 'FAIL ' + d.kind + (d.measured ? ': cap ' + d.cap + ' furniture blocks ' + JSON.stringify(d.capBy) + ', excess Workshops to Frame Timber' : ': no unsold stock, so no cap and no Workshop moves') + ', Farms stay on Cotton (' + d.why + ')')
        : p ? (p.measured ? 're-checkpoint at the capped output: sampling (the earlier FAIL and its cap hold meanwhile)' : 're-checkpoint: sampling (the earlier FAIL had no unsold stock, so no cap; retailOk stays false meanwhile)') : f.storeGroup ? 'sampling' : 'store not built',
      prevDecision: p ? 'FAIL ' + p.kind + (p.measured ? ': cap ' + p.cap + ' furniture blocks' : ': no unsold stock, no cap') + ' (' + p.why + ')' : null,
      e1: !!s.mem?.e1,
      // the retail allocator (plan B1, D3): $/h if the needed stores exist, what binds it, and the Workshops per good
      plan: f.alloc ? usd(f.alloc.dollarsPerHour * 100) + '/h planned, with ' + (f.alloc.storesNeeded?.[REGION] ?? 1) + ' store(s)' : null,
      binding: f.alloc ? f.alloc.binding + ': ' + f.alloc.detail : null,
      alloc: f.alloc ? f.goods.filter((g) => f.alloc.alloc[g.id] > 0).map((g) => g.name + ' ' + f.alloc.alloc[g.id] + ' Workshop(s)').join(', ') || 'none' : null,
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
  // Shelves from the retail allocator (plan B1): its goods (planned Workshops, or stock) and the goods still made or kept on the shelf, up to 4,
  // planned goods first, then by unit price. Order only matters when store capacity binds; the shelf set is what is sent.
  // Rival mode: only goods that pass rivalOk, quality goods first (also in the shelf order).
  function allocPick(f, al) {
    const planned = (g) => (al.alloc[g.id] ?? 0) > 0 || al.shelves.includes(g.id);
    const shelf = f.storeGroup?.assortment ?? [];
    const byUnit = (a, b) => (f.rival && qRank(a, b)) || b.unit - a.unit;
    return [...new Set([...f.goods.filter(planned), ...(f.keep ?? f.goods.filter(f.eligible))])].filter((g) => !f.rival || rivalOk(f, g, shelf))
      .sort((a, b) => (f.rival && qRank(a, b)) || planned(b) - planned(a) || byUnit(a, b)).slice(0, MAX_SHELVES).sort(byUnit);
  }
  // One more store (wiki 4.7, plan B5): its build items (Iron Frames for the prototypes kept back until Stage D; this build's own are not),
  // its acres, and cash for the money floor + its price + the bill floor (plan 8.1). { wait } or { cost }.
  function storeGate(v, ctx, f, out) {
    const bd = v.bld(f.storeB);
    const cost = P ? P.price(bd.cost, v.ownedAll(STORE), 0) : bd.cost;
    const ifId = v.idI('Iron Frame'), late = out?.stage === 'D' || out?.stage === 'END';
    const keepOf = (i) => (i === ifId && !late ? Math.min(cfg().ifReserve ?? 0, W.corePlan._ifNeed(v, STORE)) : 0);
    // ...and what other modules keep back (finite reserves: Iron Frame, Concrete, Glass for their own builds)
    const res = (i) => { const r = ctx.reserveItems?.[i]; return Number.isFinite(r) ? r : 0; };
    const lack = (bd.build_items ?? []).filter((i) => (v.st.stock?.[REGION]?.[i.item] ?? 0) - i.amount < keepOf(i.item) + res(i.item));
    if (lack.length) return { wait: 'store needs ' + lack.map((i) => i.amount + ' ' + (v.C.items[i.item]?.name ?? i.item) + (keepOf(i.item) ? ' (+' + keepOf(i.item) + ' kept for prototypes)' : '') + (res(i.item) ? ' (+' + res(i.item) + ' other modules keep)' : '')).join(', ') };
    if (v.freeAcres < bd.acres) return { wait: 'store needs ' + bd.acres + ' free acres (' + v.freeAcres + ' free)' };
    // bill floor (plan 8.1): the store's always-on draw goes on every bill from now on
    const mw = bd.draws?.power ?? 0, billFloor = mw * 2000 * (W.idleCore?.powerPriceMult?.() ?? 1) + 12 * billsOf(v.st);
    const need = (ctx.floorCents ?? 0) + cost + billFloor;
    if (v.money < need) return { wait: 'store ' + usd(cost) + ' + bill floor ' + usd(billFloor) + ' (' + mw + ' MW x $20 + 2 h of bills): need ' + usd(need - v.money) + ' more above the floor' };
    return { cost };
  }
  function decideHeartland(v, ctx, out) {
    const f = ctx.retail;
    if (f?.goods && !f.badBoard && f.share != null) {
      try { f.alloc = W.corePlan._buildout?.alloc?.(v, ctx) ?? null; } catch (e) { console.error('[corePlan] retail alloc', e); f.alloc = null; }
      if (f.alloc) { f.chosen = allocPick(f, f.alloc); needOf(f, cfg()); }
    }
    const readout = readoutOf(f);
    if (!f || f.err) return { wait: f?.err ?? 'no facts (context did not run)', readout };
    if (f.badBoard) return { wait: 'RETAIL BOARD SHAPE CHANGED: ' + f.badBoard + '; not building or shelving until it is checked', readout };
    if (f.share == null) return { wait: 'RETAIL BOARD: unknown "ratings" shape, share not computed; not acting', readout };
    if (!f.unlocked && !f.storeGroup && !f.pooled && !f.emptyGroup) return { wait: 'Retail Store not unlocked', readout };
    // rival mode with nothing stocked: an empty shelf set (the engine takes it), so no shelf scores -2 while stock builds up
    if (!f.chosen.length && !(f.rival && f.storeGroup)) return { wait: 'no shelf good: the Corporation makes or holds none of ' + f.names.join(', '), readout };
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
      const steps = [];
      if (!p0) {
        const short = f.need.filter((x) => x.g.stock < x.need);
        if (short.length) return { wait: 'pre-store gate: ' + short.map((x) => x.g.name + ' ' + Math.floor(x.g.stock) + ' / ' + x.need).join(', ') + ' (' + cfg().stockHoursPerShelf + ' h of sales at min(demand, output))', readout };
        const sg = storeGate(v, ctx, f, out);
        if (sg.wait) return { wait: sg.wait, readout };
        steps.push({ msg: { type: 'BuyBuilding', building: storeB, amount: 1, region: REGION }, until: (x) => (x.pool[storeB] ?? 0) >= 1 || x.groups.some((g) => g.building === storeB && g.count > 0) });
      }
      steps.push({ msg: { type: 'CreateGroup', building: storeB, amount: 1, name: GROUP_NAME, region: REGION }, until: (x) => x.groups.some((g) => g.building === storeB && g.count > 0) });
      return { action: { id: 'retail:store', text: (p0 ? '' : 'build 1 Retail Store, then ') + 'group it as "' + GROUP_NAME + '"', steps, hold: true }, readout };
    }
    const g = f.storeGroup, have = g.assortment ?? [];
    if (!sameSet(have, want)) {
      return { action: { id: 'retail:shelf:' + want.join(','), text: 'shelves: ' + (f.chosen.map((x) => x.name).join(', ') || 'none') + (f.rival ? ' (rival mode: only goods that stay stocked)' : ''),
        steps: [{ msg: { type: 'SetAssortment', group: g.id, items: want }, until: (x) => sameSet(x.groups.find((y) => y.id === g.id)?.assortment ?? [], want) }] }, readout };
    }
    const d = f.capDecision;   // a re-run keeps cutting to the earlier fail's cap until it decides
    if (d) {
      const fa = failAction(v, f, d);
      if (fa) return { ...fa, readout };
    }
    // B5: stores up to what the allocator's shelves sell (50 units a tick each), Heartland only; a pooled store joins the group first (one
    // the user pooled stays while the plan needs no more). A store draws its baseload the moment it joins, and stores are served last: the
    // power must be free first (asked of Auto utilities), or one more store would darken all of them.
    const nStores = f.alloc?.storesNeeded?.[REGION] ?? 0, c0 = g.count;
    const into = { msg: { type: 'AssignBuildings', group: g.id, amount: 1 }, until: (x) => (x.groups.find((y) => y.id === g.id)?.count ?? 0) >= c0 + 1 };
    if (nStores > c0) {
      const line = 'store ' + (c0 + 1) + ' of ' + nStores + ' (the planned shelves sell more than ' + c0 + ' store(s) carry)';
      const au = ctx.mods?.autoUtil, mw = v.bld(storeB).draws?.power ?? 0;
      const free = au?._measure ? Math.max(0, au._measure('power', REGION, v.st, v.catalog, ctx.tick ?? 0, ctx.contracts ?? []).free ?? 0) : Infinity;
      if (free + 1e-9 < mw) { if (ctx.live) au.ask?.('power', REGION, mw, ctx.tick ?? 0); return { wait: line + ': waits for ' + mw + ' MW free power (asked Auto utilities)', readout }; }
      if (p0 > 0) return { action: { id: 'retail:store:pool:' + g.id + ':' + c0, text: 'put the pooled Retail Store into group ' + g.id + ': ' + line, hold: true, steps: [into] }, readout };
      const sg = storeGate(v, ctx, f, out);
      if (sg.wait) return { wait: line + ': ' + sg.wait, readout };
      return { action: { id: 'retail:store:more:' + c0, text: 'build ' + line, hold: true,
        steps: [{ msg: { type: 'BuyBuilding', building: storeB, amount: 1, region: REGION }, until: (x) => (x.pool[storeB] ?? 0) >= 1 || (x.groups.find((y) => y.id === g.id)?.count ?? 0) > c0 }, into] }, readout };
    }
    return { wait: readout.decision, readout };
  }

  // Lever 4 (scripts/multi-region-plan.md): the regions the expand director opened or adopted that have a store get the same shelf rule as
  // Heartland (made, assigned or held goods, the shelf-drop delay, rival mode), from their own board row, stock and rating. One
  // SetAssortment at a time, after Heartland's own action. The checkpoint, fail path and store count stay Heartland's (a region chain is
  // far below its demand and one store's capacity: see the plan's dropped-lever table).
  function regionShelf(v, ctx) {
    const em = ctx.mem?.('expand')?.get?.() ?? {};   // the run's region too: retail decides before expand, the step the run ends
    for (const r of new Set([...Object.keys(em.regions ?? {}).map(Number), em.run?.r])) {
      if (!(r > 0)) continue;
      const vr = W.corePlan._view(v.st, v.catalog, [], r), f = facts(vr, ctx);
      if (f.err || f.badBoard || f.share == null || !f.storeGroup) continue;
      shelfPick(f, ctx, ctx.mem('retail:' + r));
      const want = f.chosen.map((g) => g.id), g = f.storeGroup;
      if (!want.length || sameSet(g.assortment ?? [], want)) continue;
      return { id: 'retail:shelf:' + r + ':' + want.join(','), text: 'region ' + r + ' shelves: ' + f.chosen.map((x) => x.name).join(', ') + (f.rival ? ' (rival mode)' : ''),
        steps: [{ msg: { type: 'SetAssortment', group: g.id, items: want }, until: (x) => sameSet(x.st.groups?.[g.id]?.assortment ?? [], want) }] };
    }
    return null;
  }
  function decide(v, ctx, out) {
    const h = decideHeartland(v, ctx, out);
    if (h.action) return h;
    let a = null;
    try { a = regionShelf(v, ctx); } catch (e) { console.error('[corePlan] retail regionShelf', e); }
    return a ? { action: a, readout: h.readout } : h;
  }

  W.corePlan.addDirector({
    name: 'retail', order: 45,
    defaults: W.idleCore.plans.copy(PD.defaults),
    context, decide,
    duties: () => [{ duty: 'Retail Store, shelves and the retail checkpoint (wiki 4.7)', owner: 'Core plan', done: true }],
  });
  W.corePlan._retail = { facts, goodsOf, demandEvent, demandH, shelfHours, checkBoard, shareOf, salesOver, rowsOf, capOf, shapeOf };
})();
} catch (e) { console.error('[IdleCorp] cp-retail failed to load:', e); }
// @@END cp-retail
