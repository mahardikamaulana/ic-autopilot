// ============================================================================
// CORE PLAN DIRECTORS 9-10: bill resume, utilities, Cotton slot, sell jobs, cadence, offline checklist (corePlan directors)
// ============================================================================
// Five directors on top of corePlan (wiki/guides/core-game-plan.md sections 5, 6, 8.1, 8.2, 12, 13):
//   resume   SetPaused false on a group an unpaid bill paused, once bills are affordable (plan D7, Autopilot's rule; yours stay paused).
//   utilities  Auto utilities power on once per Live session, water while a running group draws water (plan D1); your switch-off is sticky.
//   slot     KeepFilling on the best Heartland Cotton bid while Farms exist (5.1), then a surplus bid or nothing (5.2).
//            Autopilot's autoShipCotton does the same job: while Autopilot runs with it on, this director only reads out.
//   sell     autoSell jobs for ore, stone, sheets and saturated shelves above the keep line (section 6). Live only.
//   cadence  hourly and 6-hour checklists (section 13); a browser alert only when a check newly fails.
// The endgame director (wiki 12) is in cp-endgame.js; it reads TARGETS from here.
// Also: corePlan.offline(hours) (checklist before going away), corePlan.canSaveDesign(st, recipe) and corePlan.worldEvents() (the last
// WorldEvents socket message, raw, plan D5).
// The pure pieces are on corePlan._cadence for the tests.
// @@MODULE cp-cadence
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const core = W.idleCore;
  const cp = W.corePlan, cfg = cp.cfg;
  const REGION = 0, TPH = 7200;                  // 2 server ticks per second
  const HOUR = 3600000, SIX = 6 * HOUR;
  const COURIER_CU = 10000;                      // one free courier load
  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const num = core.ui.num;
  const usd2 = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });   // unit prices
  // Plan data and settings: the plan preset's core part (src/core-plans.js).
  const PC = core.plans.current().core, PD = PC.directors;
  // Engine inputs and the endgame prototypes: never sold, never in the slot (wiki 5.2, 6).
  const NEVER = PD.cadence.tables.never;
  const UNLOCKS = PC.unlocks;
  // Endgame stock (wiki 12): kept back from every sale and the surplus slot.
  const TARGETS = PD.cadence.tables.targets;

  // ---- shared reads (pure) ----------------------------------------------------------------------------------------------------
  const tickOf = (v, ctx) => ctx.tick ?? v.mutTick ?? 0;
  const deals = (ctx) => (Array.isArray(ctx.deals) ? ctx.deals : []);
  const unit = (d) => d.price / Math.max(1, d.amount);
  const stockOf = (v, i) => v.st.stock?.[REGION]?.[i] ?? v.st.items?.[i] ?? 0;
  const itemName = (v, i) => v.C.items[i]?.name ?? 'item ' + i;
  const neverIds = (v) => new Set(NEVER.map((n) => v.idI(n)).filter((i) => i != null));
  // A Heartland fill counts while its bid is still on the board and it has not expired.
  function activeFills(v, ctx) {
    const t = tickOf(v, ctx), board = deals(ctx);
    return Object.entries(v.st.standing_fills ?? {}).map(([id, f]) => ({ deal: +id, ...f, bid: board.find((d) => d.id === +id) ?? null }))
      .filter((f) => (f.region ?? REGION) === REGION && f.bid && (f.expires_at ?? f.bid.expires_at ?? 0) > t)
      .map((f) => ({ ...f, left: (f.expires_at ?? f.bid.expires_at) - t }));
  }
  // Items a group eats, with the amount per hour (runs per wave x input / wave length). Paused groups count too:
  // they restart (an unpaid bill, a Kiln paused for now) and their inputs must still be there.
  function consumption(v) {
    const per = {};
    for (const g of v.groups) {
      if (!g.count || g.recipe == null) continue;
      const rc = v.C.recipes[g.recipe];
      if (!rc?.ticks) continue;
      const runs = g.work?.find((w) => w.recipe === g.recipe)?.runs ?? g.count;
      for (const i of rc.inputs ?? []) per[i.item] = (per[i.item] ?? 0) + runs * i.amount * TPH / rc.ticks;
    }
    return per;
  }
  // The next builds the land rule still wants (Workshops first: they are most of the engine), at most n.
  function nextBuilds(v, rule, n) {
    const need = rule?.need ?? {};
    const out = [];
    for (const [k, name] of [['workshops', 'Workshop'], ['sawmills', 'Sawmill'], ['camps', 'Lumber Camp']]) for (let i = 0; i < (need[k] ?? 0) && out.length < n; i++) out.push(name);
    while (out.length < n) out.push('Workshop');
    return out;
  }
  const kitOf = (v, names) => {
    const k = {};
    for (const n of names) { const b = v.bld(v.idB(n)); for (const it of [...(b.default_kit ?? []), ...(b.build_items ?? [])]) k[it.item] = (k[it.item] ?? 0) + it.amount; }
    return k;
  };
  // Keep line (wiki 6): >= 2x the next three builds' kit, >= 48 h of the groups' own use, and the endgame stock (wiki 12).
  function keepLine(v, rule, item, use = consumption(v)) {
    const kit = kitOf(v, nextBuilds(v, rule, cfg.sellKitBuilds))[item] ?? 0;
    const target = TARGETS.find(([n]) => v.idI(n) === item)?.[1] ?? 0;
    return Math.ceil(Math.max(2 * kit, cfg.sellKeepHours * (use[item] ?? 0), target));
  }
  const storeItems = (v) => [...new Set(v.groups.filter((g) => g.building === v.idB('Retail Store')).flatMap((g) => g.assortment ?? []))];
  // Hours a shelf's stock lasts, from the retail facts (stock, output, appetite x share); Infinity for a good the store does not shelve.
  const shelfHours = (f, i) => { const g = f?.goods?.find((x) => x.id === i); return g ? cp._retail.shelfHours(g, f.share) : Infinity; };

  // ---- slot (wiki 5.1, 5.2) -----------------------------------------------------------------------------------------------------
  function apOwnsSlot(ctx) { const eg = ctx.mods?.earlyGame; return !!(eg && eg.running && eg.cfg?.autoShipCotton !== false); }
  function bidOk(v, ctx, d) { return d.side === 'Sell' && (d.region ?? REGION) === REGION && d.amount >= cfg.slotLotMin && d.expires_at - tickOf(v, ctx) >= cfg.slotMinMinutes * 120; }
  // Every fill with who armed it (mem('slot').armed: deal -> { item, mode }), ticks left (null: unknown) and whether it is ours to
  // touch (Heartland). The game has one auto-ship slot per corp (wiki market.md, formulas.md), so a fill in any region holds it.
  function slotFills(v, ctx) {
    const t = tickOf(v, ctx), board = deals(ctx), armed = ctx.mem('slot').get().armed ?? {};
    return Object.entries(v.st.standing_fills ?? {}).map(([id, f]) => {
      const deal = +id, bid = board.find((d) => d.id === deal) ?? null, exp = f.expires_at ?? bid?.expires_at ?? null;
      const here = (f.region ?? REGION) === REGION;
      return { ...f, deal, bid, here, mine: here ? armed[deal] ?? null : null, left: exp == null ? null : exp - t };
    });
  }
  // Saved once the server shows the change, so a dry run or an unconfirmed send never claims a fill.
  const setArmed = (m, fn) => { const a = { ...(m.get().armed ?? {}) }; fn(a); m.set({ armed: a }); };
  function slotDecide(v, ctx, out) {
    const farms = v.owned('Farm');
    if (farms > 0 && apOwnsSlot(ctx)) return { wait: 'Autopilot keeps the Cotton slot', readout: 'Autopilot keeps the Cotton slot (autoShipCotton)' };
    if (!deals(ctx).length) return { wait: 'market board not loaded (open the Market page once)' };
    const m = ctx.mem('slot'), rearm = cfg.slotRearmMinutes * 120, fills = slotFills(v, ctx);
    const cotton = v.idI('Cotton'), never = neverIds(v), use = consumption(v);
    const expired = (f) => f.left != null && f.left <= 0;
    // Ours: the board is loaded, so a bid missing from it was filled or withdrawn.
    const ours = fills.filter((f) => f.mine), oursDone = (f) => !f.bid || expired(f) || f.left <= rearm;
    // A surplus fill ends at the keep line or once the item is an engine input (5.2 "Until"): the native slot ignores both.
    for (const f of ours.filter((x) => x.mine.mode === 'surplus' && !oursDone(x))) {
      const it = f.mine.item, spare = stockOf(v, it) - keepLine(v, out.rule, it, use);
      if (spare > 0 && !use[it] && !never.has(it)) continue;
      const why = never.has(it) || use[it] ? 'engine input now' : 'at the keep line';
      return { action: { id: 'slot:stop:' + f.deal, text: 'stop auto-ship slot: ' + itemName(v, it) + ' (' + why + ')',
        steps: [{ msg: { type: 'StopFilling', deal: f.deal }, until: (x) => { const ok = !x.st.standing_fills?.[f.deal]; if (ok) setArmed(m, (a) => delete a[f.deal]); return ok; } }] } };
    }
    const live = ours.find((f) => !oursDone(f));
    if (live) return { readout: 'slot: ' + itemName(v, live.mine.item) + ' bid #' + live.deal + ', ' + Math.floor(live.left / 120) + ' min left' };
    // A fill Core plan did not arm (the user, Autopilot, any region) holds the one slot until its own expiry, on the board or not.
    const user = fills.find((f) => !f.mine && !expired(f));
    if (user) {
      const txt = 'slot held by user fill #' + user.deal + (user.bid ? ' (' + itemName(v, user.bid.item) + ')' : '') + (user.left != null ? ', ' + Math.floor(user.left / 120) + ' min left' : '');
      return { wait: txt, readout: txt };
    }
    let pick = null, why = '', mode = 'cotton', amount = null;
    if (farms > 0) {
      pick = deals(ctx).filter((d) => d.item === cotton && bidOk(v, ctx, d)).sort((a, z) => unit(z) - unit(a))[0] ?? null;
      why = pick ? 'Cotton @ ' + usd2(unit(pick)) : 'no Cotton bid with a lot >= ' + num(cfg.slotLotMin) + ' and >= ' + cfg.slotMinMinutes + ' min left';
    } else {
      // Surplus slot: retail sells, the item is above its keep line and nothing in the plan eats it.
      if (ctx.retailOk !== true) return { wait: 'no Farms: slot left empty until retail sells (5.2)' };
      const cands = deals(ctx).filter((d) => !never.has(d.item) && d.item !== cotton && !use[d.item] && bidOk(v, ctx, d))
        .map((d) => ({ d, spare: Math.floor(stockOf(v, d.item) - keepLine(v, out.rule, d.item, use)) })).filter((c) => c.spare > 0)
        .sort((a, z) => z.spare * unit(z.d) - a.spare * unit(a.d));
      pick = cands[0]?.d ?? null; mode = 'surplus';
      // The native slot ships everything it is given: cap it at the spare above the keep line.
      amount = cands[0] ? Math.max(1, cands[0].spare) : null;
      why = pick ? 'surplus ' + num(amount) + ' ' + itemName(v, pick.item) + ' @ ' + usd2(unit(pick)) : 'no surplus item with a bid: slot left empty';
    }
    if (!pick) return { wait: why };
    // Re-arm. Same bid: KeepFilling again refreshes the fill (live 2026-11-22: since and expires_at reset to the renewed bid).
    // Another bid: clear our old fill and any expired entry first (one slot; a lingering entry would otherwise hold it).
    const stale = fills.filter((f) => f.here && f.deal !== pick.id && (f.mine || expired(f))).map((f) => f.deal);
    const steps = stale.map((id) => ({ msg: { type: 'StopFilling', deal: id }, until: (x) => { const ok = !x.st.standing_fills?.[id]; if (ok) setArmed(m, (a) => delete a[id]); return ok; } }));
    const item = pick.item;
    steps.push({ msg: { type: 'KeepFilling', deal: pick.id, region: REGION, amount },
      until: (x) => { const ok = !!x.st.standing_fills?.[pick.id]; if (ok) setArmed(m, (a) => { a[pick.id] = { item, mode }; }); return ok; } });
    return { action: { id: 'slot:' + pick.id, text: 'auto-ship slot: ' + why + (stale.length ? ' (re-arm)' : ''), steps } };
  }

  // ---- sell (wiki 6) ----------------------------------------------------------------------------------------------------------------
  function sellPlan(v, ctx, out) {
    const never = neverIds(v), cotton = v.idI('Cotton'), wood = v.idI('Wood');
    const use = consumption(v), rf = ctx.retail, t = tickOf(v, ctx);
    const filled = new Set(Object.keys(v.st.standing_fills ?? {}).map(Number));
    const jobs = ctx.sellJobs ?? [];
    const jobItems = new Set(jobs.map((j) => j.item)), jobDeals = new Set(jobs.map((j) => j.deal));
    const cool = ctx.mem?.('sell').get().cool ?? {}, now = ctx.now ?? 0;
    const kind = (i) => {
      if (never.has(i) || i === cotton || i === wood) return null;
      const it = v.C.items[i];
      if (!it) return null;
      if (it.category === 'Raw') return 'raw';
      if (/ Sheet$/.test(it.name)) return 'sheet';
      // Saturated: output keeps up with demand and the stock is a stretch of demand deep (wiki 6).
      const g = rf?.share != null && storeItems(v).includes(i) ? rf.goods?.find((x) => x.id === i) : null;   // only goods on the shelf
      if (g) { const dem = cp._retail.demandH(g, rf.share); if (g.outTick * TPH >= dem && g.stock >= cfg.sellSaturatedHours * dem) return 'saturated shelf'; }
      return null;
    };
    const best = {};
    for (const d of deals(ctx)) {
      if (d.side !== 'Sell' || (d.region ?? REGION) !== REGION || filled.has(d.id) || d.expires_at - t < cfg.slotMinMinutes * 120) continue;
      if (!kind(d.item) || jobItems.has(d.item) || jobDeals.has(d.id) || (cool[d.id] ?? 0) > now) continue;
      if (!best[d.item] || unit(d) > unit(best[d.item])) best[d.item] = d;
    }
    const out2 = [];
    for (const d of Object.values(best)) {
      const keep = keepLine(v, out?.rule, d.item, use), load = Math.floor(COURIER_CU / Math.max(1, v.C.items[d.item]?.cargo_weight || 1));
      const spare = stockOf(v, d.item) - keep;
      if (spare < load) continue;   // full loads only: less than one load would just wait
      out2.push({ deal: d.id, item: d.item, name: itemName(v, d.item), kind: kind(d.item), keep, spare, unit: unit(d), value: spare * unit(d) });
    }
    return out2.sort((a, z) => z.value - a.value);
  }
  function sellDecide(v, ctx, out) {
    const as = ctx.mods?.autoSell, mem = ctx.mem('sell'), mine = mem.get().mine ?? [];
    const never = neverIds(v), use = consumption(v);
    // Our jobs follow the keep line (wiki 6 "Until"): a group that starts eating the item, or the next builds' kit, raises it.
    // autoSell keeps the keep it was started with, so a higher line restarts the job with it (start() updates an existing job).
    if (as && ctx.live) for (const j of (ctx.sellJobs ?? []).filter((x) => mine.includes(x.deal))) {
      if (never.has(j.item)) return { action: { id: 'sell:stop:' + j.deal, text: 'stop auto ship ' + itemName(v, j.item) + ' (engine input now)',
        run: async () => { try { as.stop(j.deal); mem.set({ mine: (mem.get().mine ?? []).filter((d) => d !== j.deal) }); return true; } catch { return null; } } } };
      const keep = keepLine(v, out?.rule, j.item, use), had = j.keep ?? 0;
      if (keep > Math.ceil(had * 1.02)) return { action: { id: 'sell:keep:' + j.deal + ':' + keep, text: 'auto ship ' + itemName(v, j.item) + ': keep ' + num(had) + ' -> ' + num(keep),
        run: async () => {
          try { as.start({ deal: j.deal, total: j.left ?? null, keep, fullLoads: j.fullLoads ?? true }); } catch { return null; }
          return (as.jobs?.() ?? []).some((x) => x.deal === j.deal && x.keep >= keep) ? true : null;
        } } };
    }
    const plan = sellPlan(v, ctx, out);
    const readout = plan.map((p) => p.name + ' #' + p.deal + ' keep ' + num(p.keep) + ' spare ' + num(p.spare) + ' (' + p.kind + ')');
    if (!plan.length) return { readout: [] };
    if (!as) return { wait: 'Auto ship (autoSell) is not loaded', readout };
    if (!ctx.live) return { wait: 'dry run: would auto ship ' + plan[0].name + ' above ' + num(plan[0].keep), readout };
    const p = plan[0];
    return { readout, action: { id: 'sell:' + p.deal, text: 'auto ship ' + p.name + ' @ ' + usd2(p.unit) + ', keep ' + num(p.keep) + ', full loads',
      run: async () => {
        try { as.start({ deal: p.deal, total: null, keep: p.keep, fullLoads: true }); }
        catch { return null; }           // bid gone or Market page not loaded: not a server failure
        const ok = (as.jobs?.() ?? []).some((j) => j.deal === p.deal);
        if (ok) mem.set({ mine: [...new Set([...(mem.get().mine ?? []), p.deal])] });
        return ok ? true : null;
      } } };
  }

