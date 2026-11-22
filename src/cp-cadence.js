// ============================================================================
// CORE PLAN DIRECTORS 9-10: Cotton slot, sell jobs, cadence, offline checklist, endgame (corePlan directors)
// ============================================================================
// Five directors on top of corePlan (wiki/guides/core-game-plan.md sections 5, 6, 8.1, 12, 13):
//   resume   SetPaused false on a group an unpaid bill paused, once bills are affordable (plan D7, Autopilot's rule; yours stay paused).
//   slot     KeepFilling on the best Heartland Cotton bid while Farms exist (5.1), then a surplus bid or nothing (5.2).
//            Autopilot's autoShipCotton does the same job: while Autopilot runs with it on, this director only reads out.
//   sell     autoSell jobs for ore, stone, sheets and saturated shelves above the keep line (section 6). Live only.
//   cadence  hourly and 6-hour checklists (section 13); a browser alert only when a check newly fails.
//   endgame  off by default (cfg.dir_endgame): StartTech Refinery once E1-E5 hold and 750,000 CD + the prototype are in hand.
// Also: corePlan.offline(hours) (checklist before going away) and corePlan.canSaveDesign(st, recipe).
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
  const num = (n) => Math.round(n).toLocaleString('en-US');
  const usd2 = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });   // unit prices
  // Engine inputs and the endgame prototypes: never sold, never in the slot (wiki 5.2, 6).
  const NEVER = ['Wood', 'Planks', 'Iron Sheet', 'Concrete', 'Glass', 'Bookshelf', 'Table', 'Chair', 'Bench', 'Wooden Frame', 'Iron Frame', 'Copper Wire', 'Wired Frame'];
  const UNLOCKS = ['Assembly Plant', 'Retail Store', 'Oil Rig'];
  // Endgame stock (wiki 12): kept back from every sale and the surplus slot.
  const TARGETS = [['Iron Frame', 80], ['Wired Frame', 12], ['Copper Wire', 200], ['Copper Ore', 2000]];

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
      const g = rf?.share != null ? rf.goods?.find((x) => x.id === i) : null;
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

  // ---- cadence (wiki 13) -------------------------------------------------------------------------------------------------------------
  // Fires once per period; the clock is anchored at first sight, so a sleep gives one catch-up fire, not several.
  function tickPeriods(m, now) {
    const o = m.get(), fired = { hourly: false, six: false }, patch = {};
    for (const [k, last, per, cnt] of [['hourly', 'hLast', HOUR, 'hFires'], ['six', 'sLast', SIX, 'sFires']]) {
      const l = o[last];
      if (l == null || now - l >= per) { fired[k] = true; patch[last] = l == null ? now : now - ((now - l) % per); patch[cnt] = (o[cnt] ?? 0) + 1; }
    }
    if (Object.keys(patch).length) m.set(patch);
    return fired;
  }
  const chk = (id, ok, why) => ({ id, ok, why });
  function powerLoad(v) {
    let mw = 0;
    for (const g of v.groups) if (!g.paused && g.count > 0) mw += (v.bld(g.building).draws?.power ?? 0) * g.count;
    return mw;
  }
  function hourlyChecks(v, ctx, out) {
    const c = [];
    const lr = ctx.mods?.labRunner;
    if (v.owned('Manufacturing Lab') > 0) c.push(chk('lab', !!(lr?.running && lr.cfg?.dryRun === false), !lr ? 'Lab runner not loaded' : !lr.running ? 'Lab runner stopped' : lr.cfg?.dryRun !== false ? 'Lab runner is a dry run' : 'Lab runner live'));
    if (v.owned('Farm') > 0 && !deals(ctx).length) c.push(chk('autoship', null, 'market board not loaded (open the Market page once)'));
    else if (v.owned('Farm') > 0) {
      const f = activeFills(v, ctx).sort((a, z) => z.left - a.left)[0];
      c.push(chk('autoship', !!f && f.left >= cfg.slotRearmMinutes * 120, !f ? 'no auto-ship running' : itemName(v, f.bid.item) + ' auto-ship, ' + Math.floor(f.left / 120) + ' min left'));
    }
    const sub = v.st.subscriptions?.[REGION]?.power ?? 0, load = powerLoad(v), au = ctx.mods?.autoUtil;
    if (load > 0) c.push(chk('power', !!au?.conf?.power?.on && sub >= load, (au?.conf?.power?.on ? 'Auto power on' : 'Auto power off') + ', ' + sub + ' MW subscribed for ' + load + ' MW load'));
    const floor = sub * 12000;
    c.push(chk('cash', v.money >= floor, 'money ' + usd(v.money) + (v.money >= floor ? ' >= ' : ' < ') + 'bill floor ' + usd(floor) + ' (2 h of bills)'));
    if (out.stage === 'D' || out.stage === 'END') {
      const rf = ctx.retail;
      if (!rf?.goods) c.push(chk('shelves', null, 'retail board unreadable'));
      else if (rf.share == null) c.push(chk('shelves', null, 'retail share unknown'));
      else {
        const low = storeItems(v).filter((i) => shelfHours(rf, i) < cfg.shelfHours);
        c.push(chk('shelves', !low.length, low.length ? 'under ' + cfg.shelfHours + ' h: ' + low.map((i) => itemName(v, i)).join(', ') : 'every shelf >= ' + cfg.shelfHours + ' h'));
      }
    }
    return c;
  }
  function sixHourChecks(v, ctx, out) {
    const r = out.rule, c = [];
    c.push(chk('land', !!r, r ? 'land rule: last acre #' + r.lastAcre + ', T_wall ' + (+r.tWall).toFixed(1) + ' h, ' + (r.acresToBuy ?? 0) + ' acres to buy' : 'land rule unavailable'));
    const fm = cp._lab.freeModules(v);
    c.push(chk('modules', !fm.length, fm.length ? fm.length + ' module(s) not installed: ' + fm.map((d) => d.name ?? '#' + d.id).join(', ') : 'all modules installed'));
    const builds = nextBuilds(v, r, cfg.kitWaveBuilds), kit = kitOf(v, builds);
    const short = Object.entries(kit).filter(([i, n]) => stockOf(v, +i) < n);
    c.push(chk('kit', !short.length, short.length ? 'next wave (' + builds.join(', ') + ') short of ' + short.map(([i, n]) => num(n - stockOf(v, +i)) + ' ' + itemName(v, +i)).join(', ') : 'kit stock covers the next ' + builds.length + ' builds'));
    return c;
  }
  // Each check set runs when its period fires (and once on first sight); between fires the readout shows the saved results.
  function cadenceDecide(v, ctx, out) {
    const o = ctx.mem('cadence').get(), fired = ctx.cadenceFired ?? { hourly: false, six: false };
    const evaluated = { hourly: !!fired.hourly || !o.hourly, six: !!fired.six || !o.six };
    const hourly = evaluated.hourly ? hourlyChecks(v, ctx, out) : o.hourly;
    const six = evaluated.six ? sixHourChecks(v, ctx, out) : o.six;
    const failing = [...hourly, ...six].filter((x) => x.ok === false);
    return { readout: { fired, evaluated, fires: { hourly: o.hFires ?? 0, six: o.sFires ?? 0 }, failing: failing.map((x) => x.id + ': ' + x.why), hourly, six, at: o.at ?? null } };
  }
  // Runs in the next step's context on the last plan: saves fresh check results and alerts on a check that newly fails.
  // Outside the action queue on purpose: a dry run alerts too, and no other director's pending action delays it.
  function cadenceSettle(prev, m, now, notify = (...a) => core?.notify?.(...a)) {
    const rc = prev?.readouts?.cadence;
    if (!rc?.evaluated || (!rc.evaluated.hourly && !rc.evaluated.six)) return null;
    const o = m.get(), patch = { at: now };
    if (rc.evaluated.hourly) patch.hourly = rc.hourly;
    if (rc.evaluated.six) patch.six = rc.six;
    const failing = [...(patch.hourly ?? o.hourly ?? []), ...(patch.six ?? o.six ?? [])].filter((x) => x.ok === false);
    const ids = failing.map((x) => x.id).sort(), fresh = ids.filter((id) => !(o.notified ?? []).includes(id));
    if (fresh.length) try { notify('CP', 'Core plan check failing', failing.filter((x) => fresh.includes(x.id)).map((x) => x.why).join('; ')); } catch {}
    m.set({ ...patch, notified: ids });
    return { ids, fresh };
  }

  // ---- offline (wiki 13 "Before going offline", account-and-offline.md) ---------------------------------------------------------
  function canSaveDesign(st, recipe) { return Object.keys(st?.designs?.[recipe] ?? st?.designs?.[String(recipe)] ?? {}).length < (st?.premium ? 10 : 4); }
  function offlinePlan(v, hours, opts = {}) {
    const premium = opts.premium ?? !!v.st.premium, cap = premium ? 168 : 24, list = [], sends = [];
    const add = (id, ok, text) => list.push({ id, ok, text });
    add('cap', hours <= cap, hours <= cap ? hours + ' h is inside the ' + cap + ' h offline cap' : hours + ' h is over the ' + cap + ' h offline cap (' + (premium ? 'premium' : 'free plan') + '): production stops after ' + cap + ' h');
    // Unlocks: queueing charges CD and the prototype at once, so they are budgeted together. Oil Rig is never queued (retail checkpoint first).
    const queue = v.st.research_queue ?? [], busyB = v.research?.building ?? null;
    const pending = new Set([busyB, ...queue.map((q) => q.building)].filter((b) => b != null));
    const retailGo = opts.retailOk === true;   // Oil Rig only on a pass, of either checkpoint run (plan D-2), as the live plan
    let cd = v.cd; const stock = { ...(v.st.stock?.[REGION] ?? {}) };
    const tech = (b) => v.N.techs.find((t) => t.building === b);
    const affordable = (b) => { const t = tech(b); if (!t || cd < t.cost) return false; return (v.bld(b).build_items ?? []).every((i) => (stock[i.item] ?? 0) >= i.amount); };
    const take = (b) => { cd -= tech(b).cost; for (const i of v.bld(b).build_items ?? []) stock[i.item] = (stock[i.item] ?? 0) - i.amount; };
    const reqOk = (b, allowPending) => { const t = tech(b); if (!t || t.requires == null) return !!t; return v.st.unlocked_buildings?.includes(t.requires) || v.C.buildings[t.requires]?.name === 'Lumber Camp' || (allowPending && pending.has(t.requires)); };
    const names = [];
    if (premium) {
      let slots = 5 - queue.length - (busyB != null ? 1 : 0), idle = busyB == null;
      for (const n of UNLOCKS) {
        const b = v.idB(n);
        if (b == null || v.unlocked(n) || pending.has(b) || slots <= 0) continue;
        // Oil Rig: started on an idle slot once retail passed, never queued behind the store (wiki 13 step 1, plan Decisions).
        if (n === 'Oil Rig' && !(idle && retailGo)) break;
        if (!reqOk(b, true) || !affordable(b)) break;
        sends.push({ type: idle ? 'StartTech' : 'QueueTech', building: b, region: REGION });
        take(b); pending.add(b); names.push(n); slots--; idle = false;
      }
    } else if (busyB == null) {
      // Free plan: StartTech only (a busy StartTech is ignored). Of the unlocks that can start now, the longest.
      const due = UNLOCKS.filter((n) => n !== 'Oil Rig' || retailGo).map((n) => v.idB(n))
        .filter((b) => b != null && !v.unlocked(v.C.buildings[b].name) && reqOk(b, false) && affordable(b)).sort((a, z) => (tech(z)?.ticks ?? 0) - (tech(a)?.ticks ?? 0));
      if (due.length) { sends.push({ type: 'StartTech', building: due[0], region: REGION }); names.push(v.C.buildings[due[0]].name); }
    }
    const busyName = busyB != null ? v.C.buildings[busyB]?.name ?? 'building ' + busyB : null;
    // Only the Oil Rig is left and retail has not passed: that is the plan waiting, not a missed start.
    const oilWaits = !retailGo && !v.unlocked('Oil Rig') && UNLOCKS.slice(0, 2).every((n) => v.unlocked(n));
    add('unlock', names.length > 0 || busyB != null || oilWaits || UNLOCKS.every((n) => v.unlocked(n)),
      names.length ? (premium ? 'queue ' : 'start ') + names.join(' -> ') : busyName ? 'research running: ' + busyName : UNLOCKS.every((n) => v.unlocked(n)) ? 'all three unlocks are in'
        : oilWaits ? 'Oil Rig waits for the retail checkpoint' : 'no unlock can start (CD, prototype or prerequisite missing)');
    const mw = v.st.subscriptions?.[REGION]?.power ?? 0, need = mw * 6000 * hours;
    add('cash', v.money >= need, 'cash ' + usd(v.money) + (v.money >= need ? ' >= ' : ' < ') + mw + ' MW x $60 x ' + hours + ' h = ' + usd(need));
    if (v.owned('Retail Store') > 0) {
      const rf = opts.retail?.goods ? opts.retail : null, items = storeItems(v);
      const low = rf ? items.filter((i) => shelfHours(rf, i) < hours) : [];
      if (rf && rf.share == null) add('shelves', null, 'retail share unknown: stock the shelves for ' + hours + ' h');
      else add('shelves', rf ? !low.length : null, !rf ? 'retail board unreadable: stock the shelves for ' + hours + ' h' : low.length ? 'shelves run dry before ' + hours + ' h: ' + low.map((i) => itemName(v, i)).join(', ') : 'every shelf holds ' + hours + ' h');
    } else add('shelves', true, 'no Retail Store yet');
    add('autoship', true, 'auto-ship and distributor sales stop while away');
    return { hours, premium, capHours: cap, ok: list.every((x) => x.ok !== false), checklist: list, sends };
  }
  function offline(hours) {
    const w = core.walk(true);
    if (!w?.st || !w.catalog) return { error: 'game state not readable' };
    const v = cp._view(w.st, w.catalog, w.deals ?? []);
    let retail = null;
    try { const j = w.engine?.retailJson?.(); retail = cp._retail.facts(v, { retailBoard: typeof j === 'string' ? JSON.parse(j) : j }); } catch {}
    // The retail checkpoint as the last step saw it (the retail director's context sets it; saved by the cadence context).
    const cm = memRef?.('cadence').get() ?? {};
    return offlinePlan(v, +hours, { retail, retailOk: cm.retailOk ?? null });
  }

  // ---- endgame (wiki 12) ------------------------------------------------------------------------------------------------------------
  function endgameDecide(v, ctx, out) {
    const checklist = TARGETS.map(([n, want]) => ({ item: n, have: Math.floor(v.has(n)), want, ok: v.has(n) >= want }));
    const finished = !!out.finished || (Array.isArray(out.E) && out.E.length > 0 && out.E.every((c) => c.ok));
    if (!finished) return { wait: 'end conditions E1-E5 not all true', readout: { checklist } };
    const b = v.idB('Refinery');
    if (b == null) return { wait: 'manual: no building named Refinery', readout: { checklist } };
    if (v.unlocked('Refinery')) return { wait: 'Refinery unlocked', readout: { checklist } };
    const t = v.N.techs.find((x) => x.building === b), cost = t?.cost ?? 750000;
    const preOk = !t?.requires || !!v.st.unlocked_buildings?.includes(t.requires);
    if (v.research?.building !== b) out.cdNeed = { b, name: 'Refinery', cd: cost, prereqsMet: preOk, note: preOk ? '' : 'needs Oil Rig first' };
    const proto = v.bld(b).build_items ?? [];
    const lack = proto.filter((i) => stockOf(v, i.item) < i.amount);
    const why = 'Refinery';
    if (v.research?.building === b) return { wait: why + ': research running', readout: { checklist } };
    if (!preOk) return { wait: why + ': needs Oil Rig first', readout: { checklist } };
    if (v.research) return { wait: why + ': research slot busy', readout: { checklist } };
    if (v.cd < cost) return { wait: why + ': ' + num(v.cd) + ' / ' + num(cost) + ' CD', readout: { checklist } };
    if (lack.length) return { wait: why + ': need ' + lack.map((i) => Math.ceil(i.amount - stockOf(v, i.item)) + ' more ' + itemName(v, i.item)).join(', '), readout: { checklist } };
    return { readout: { checklist }, action: { id: 'tech:' + b, text: 'unlock Refinery (' + num(cost) + ' CD + ' + proto.map((i) => i.amount + ' ' + itemName(v, i.item)).join(', ') + ')',
      steps: [{ msg: { type: 'StartTech', building: b, region: REGION }, until: (x) => x.research?.building === b || x.unlocked('Refinery') }] } };
  }

  // ---- resume groups paused by an unpaid bill (plan D7, D-4: Autopilot's observe() + resume step, moved here) -------------
  // A powered group seen running, then paused while cash is under ~2 bills (or the subscription is below the load), was paused by an
  // unpaid bill; any other pause, and a group already paused when first seen, is the user's and is never touched (Autopilot's rule).
  const lastPaused = new Map();                  // this session only, like Autopilot: a group paused before the load counts as yours
  const drawOf = (v, g) => v.bld(g.building).draws?.power ?? 0;
  const powerHave = (v) => v.st.subscriptions?.[REGION]?.power ?? 0;
  function resumeObserve(v, m) {
    const needAll = v.groups.reduce((a, g) => a + drawOf(v, g) * g.count, 0), have = powerHave(v);
    const billShort = have < needAll || v.money < Math.max(have, needAll) * 1000 * 2;
    const o = m.get(), bill = new Set(o.bill ?? []), user = new Set(o.user ?? []);
    let changed = false;
    for (const g of v.groups) {
      const prev = lastPaused.get(g.id);
      if (g.paused && prev !== true && !bill.has(g.id) && !user.has(g.id)) { (prev === false && billShort && drawOf(v, g) > 0 ? bill : user).add(g.id); changed = true; }
      if (!g.paused && (bill.delete(g.id) | user.delete(g.id))) changed = true;
      lastPaused.set(g.id, !!g.paused);
    }
    if (changed) m.set({ bill: [...bill], user: [...user] });
  }
  // One SetPaused false per step once the bills are affordable: cash >= Autopilot's floor (1 h of bills, min $100, the group counted)
  // + one bill for it, and the subscription covers the load with it. Groups a director paused on purpose (Kiln gate, WF gate) stay.
  function resumeDecide(v, ctx) {
    if (!ctx.mem) return null;
    const bo = ctx.mem('buildout').get(), mine = new Set([...(bo.kilnMine ?? []), ...(bo.ftMine ?? [])]);
    const bill = new Set(ctx.mem('resume').get().bill ?? []);
    const list = v.groups.filter((g) => g.paused && g.count > 0 && bill.has(g.id) && !mine.has(g.id));
    if (!list.length) return null;
    const eg = ctx.mods?.earlyGame;
    if (eg?.running && eg.cfg?.resumePaused !== false) return { wait: 'Autopilot resumes the ' + list.length + ' bill-paused group(s) while it runs' };   // one driver per job
    const have = powerHave(v), load = powerLoad(v), waits = [];
    for (const g of list) {
      const mw = drawOf(v, g) * g.count, name = '"' + (g.name ?? v.bld(g.building).name) + '"';
      if (have < load + mw) { waits.push(name + ' is paused (unpaid bill?): power subscription ' + have + ' MW < ' + (load + mw) + ' MW with it'); continue; }
      const need = Math.max(10000, (Math.max(have, load) + mw) * 1000 * 6) + mw * 1000;
      if (v.money < need) { waits.push(name + ' is paused (unpaid bill?): waiting for cash ' + usd(v.money) + ' / ' + usd(need) + ' to resume'); continue; }
      return { action: { id: 'resume:' + g.id, text: 'resume ' + name + ' (paused by an unpaid bill, bills affordable again)',
        steps: [{ msg: { type: 'SetPaused', group: g.id, paused: false }, until: (x) => !x.groups.find((y) => y.id === g.id)?.paused }] } };
    }
    return { wait: waits.join(' | ') };
  }

  // ---- registration ------------------------------------------------------------------------------------------------------------------
  // The server tick now: the core's clock (last tick seen + elapsed), never behind the last mutation tick.
  let memRef = null;                             // ctx.mem, for corePlan.offline() outside a step
  const setTick = (v, ctx) => { if (ctx.tick == null) { let t = 0; try { t = core?.nowTick?.() ?? 0; } catch {} ctx.tick = Math.max(t, v.mutTick ?? 0); } };
  cp.addDirector({
    name: 'resume', order: 10, always: true,   // always: a bill pause can make cash fall (S6) and drop the stage
    context(v, ctx) { if (ctx.mem) resumeObserve(v, ctx.mem('resume')); },
    decide: resumeDecide,
    duties: () => [{ duty: 'resume groups paused by an unpaid bill (waits while Autopilot runs with resumePaused on)', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'slot', order: 70,
    defaults: { dir_slot: true, slotLotMin: 150000, slotMinMinutes: 60, slotRearmMinutes: 15 },
    context(v, ctx) {
      setTick(v, ctx);
      // Forget fills that are gone from the server.
      const m = ctx.mem('slot'), a = m.get().armed ?? {}, sf = v.st.standing_fills ?? {};
      const gone = Object.keys(a).filter((id) => !sf[id]);
      if (gone.length) setArmed(m, (x) => { for (const id of gone) delete x[id]; });
    },
    decide: slotDecide,
    duties: () => [{ duty: 'native Cotton auto-ship slot (Core plan acts only while Autopilot is stopped or autoShipCotton is off)', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'sell', order: 75,
    defaults: { dir_sell: true, sellKeepHours: 48, sellKitBuilds: 3, sellSaturatedHours: 24, sellCooldownMinutes: 60 },
    context(v, ctx) {
      setTick(v, ctx);
      let read = false;
      if (ctx.sellJobs == null) { try { ctx.sellJobs = ctx.mods?.autoSell?.jobs?.() ?? null; read = Array.isArray(ctx.sellJobs); } catch {} ctx.sellJobs ??= []; } else read = true;
      if (!read || !ctx.mods?.autoSell) return;
      // A job we started that autoSell ended by itself (5 unconfirmed sends, bid filled, user stop) cools down before that bid
      // is tried again: an instant restart would loop unconfirmed sends forever without tripping the 3-fail stop.
      const m = ctx.mem('sell'), o = m.get(), now = ctx.now ?? 0, have = new Set(ctx.sellJobs.map((j) => j.deal));
      // A job autoSell moved to another bid (its `from` is our old id) is still ours. shortcut: only the last move is remembered, so a job that moves twice between two ticks is lost; upgrade to a chain if that is ever seen.
      const was = o.mine ?? [], mine = was.map((d) => ctx.sellJobs.find((j) => j.from === d)?.deal ?? d), ended = mine.filter((d) => !have.has(d));
      const cool = Object.fromEntries(Object.entries(o.cool ?? {}).filter(([, until]) => until > now));
      for (const d of ended) cool[d] = now + cfg.sellCooldownMinutes * 60000;
      if (ended.length || mine.some((d, i) => d !== was[i]) || Object.keys(cool).length !== Object.keys(o.cool ?? {}).length) m.set({ mine: mine.filter((d) => have.has(d)), cool });
    },
    decide: sellDecide,
    duties: () => [{ duty: 'Auto ship jobs for ore, stone, sheets and saturated shelves (keep line)', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'cadence', order: 80,
    defaults: { dir_cadence: true, shelfHours: 1, kitWaveBuilds: 3 },
    context(v, ctx) {
      setTick(v, ctx); memRef = ctx.mem;
      const m = ctx.mem('cadence');
      if ((m.get().retailOk ?? null) !== (ctx.retailOk ?? null)) m.set({ retailOk: ctx.retailOk ?? null });
      cadenceSettle(cp.plan?.(), m, ctx.now ?? 0);
      ctx.cadenceFired = tickPeriods(m, ctx.now ?? 0);
    },
    decide: cadenceDecide,
    duties: () => [{ duty: 'hourly and 6-hour checks (alerts on a new failure)', owner: 'Core plan', done: true }],
  });
  cp.addDirector({
    name: 'endgame', order: 90,
    defaults: { dir_endgame: false },
    decide: endgameDecide,
    duties: () => [{ duty: 'endgame: Refinery start (off unless cfg.dir_endgame)', owner: 'Core plan', done: cfg.dir_endgame === true }],
  });
  cp.offline = offline;
  cp.canSaveDesign = canSaveDesign;
  cp._cadence = { slotDecide, sellPlan, sellDecide, cadenceDecide, cadenceSettle, tickPeriods, hourlyChecks, sixHourChecks, offlinePlan, canSaveDesign, endgameDecide, resumeObserve, resumeDecide, keepLine, consumption, activeFills, slotFills, NEVER, TARGETS };
})();
} catch (e) { console.error('[IdleCorp] cp-cadence failed to load:', e); }
// @@END cp-cadence