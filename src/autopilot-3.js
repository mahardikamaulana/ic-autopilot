// continues the autopilot closure from autopilot-2.js (same try / IIFE)
  // ---- decide -----------------------------------------------------------------------

  // An action: { key, reason, steps: [{ msg, until(s), optional }] }.  A wait: { wait, final }.
  const act = (key, reason, ...steps) => ({ key, reason, steps });
  const withMeta = (meta, a) => Object.assign(a, { meta });

  function groupFor(s, b, r) {
    return s.groups.filter((g) => g.building === b && g.recipe === r).sort((a, z) => z.count - a.count)[0];
  }

  function assignAction(s, b, r, n) {
    const g = groupFor(s, b, r);
    if (g) {
      const c0 = g.count;
      return act(`assign:${g.id}`, `pool: assign ${n} ${bname(s, b)} → "${g.name}"`,
        { msg: { type: 'AssignBuildings', group: g.id, amount: n }, until: (x) => (x.st.groups[g.id]?.count ?? 0) >= c0 + n });
    }
    const id = s.nextGroupId;
    return act(`create:${b}:${r}`, `pool: create group "${NAMES[r]}" with ${n} ${bname(s, b)}`,
      // Only our new group (this building, no task yet) may get the task; if the id went to
      // another group the action fails here and the idle-group step retasks ours by its real id.
      { msg: { type: 'CreateGroup', building: b, amount: n, name: NAMES[r] ?? bname(s, b), region: REGION },
        until: (x) => x.st.groups[id]?.building === b && x.st.groups[id]?.recipe == null },
      { msg: { type: 'SetRecipe', group: id, recipe: r }, until: (x) => x.st.groups[id]?.recipe === r });
  }

  // Sellers of an item, cheapest first, under the price cap. A lot smaller than `amount` is bought whole (n), so several
  // small lots add up: each is its own action and the next decision buys the rest.
  function sellersOf(s, item, amount) {
    const it = s.catalog.items[item] ?? {};
    const cap = (it.base_value || 0) * cfg.maxBuyPrice;
    return [
      ...s.deals.filter((d) => d.side === 'Buy' && d.item === item && d.amount > 0).map((d) => {
        const n = Math.min(amount, d.amount);
        return { key: `fill:${d.id}`, n, unit: d.price / d.amount, msg: { type: 'FillDeal', deal: d.id, amount: n, hire: null, region: REGION, courier: true } };
      }),
      // A player fill lands at the Exchange, no shipment (the client sends courier:false since 2026-11-25); withdrawActions brings it home.
      ...s.orders.filter((o) => o.side === 'Sell' && o.item === item && o.amount > 0).map((o) => {
        const n = Math.min(amount, o.amount);
        return { key: `order:${o.id}`, n, unit: o.unit_price * 1.02, msg: { type: 'FillOrder', order: o.id, amount: n, hire: null, region: REGION, courier: false } };
      }),
    ].filter((o) => !cap || o.unit <= cap).sort((a, z) => a.unit - z.unit);
  }
  // Buy order / floor part price: a cfg multiple of the item's base value, in cents (at least 1 cent).
  const priceCents = (s, item, mult) => Math.max(1, Math.round((s.catalog.items[item]?.base_value ?? 0) * mult));

  // One open player buy order per item, at `unit` cents per unit; none again within orderHoldHours
  // unless the last one was seen filled. Yields an action or a wait.
  function* postBuyOrder(s, item, amount, unit, why) {
    const mine = s.myOrders.find((o) => o.side === 'Buy' && o.item === item);
    if (mine) { yield { wait: `${why}: your buy order for ${mine.amount} @ ${usd(mine.unit_price)} is waiting for a player` }; return; }
    const since = nowMs() - (posted[item] ?? -Infinity);
    if (since < cfg.orderHoldHours * 3600000) { yield { wait: `${why}: buy order posted ${Math.round(since / 60000)} min ago, waiting for a player` }; return; }
    if (!cfg.postBuyOrders || s.money - unit * amount * 1.02 < moneyFloor(s)) return;
    const n0 = s.myOrders.length;
    yield withMeta({ item }, act(`post:${item}`, `${why}: post a buy order for ${amount} ${iname(s, item)} @ ${usd(unit)} (escrows ${usd(unit * amount)})`,
      { msg: { type: 'PostOrder', side: 'Buy', item, amount, unit_price: unit, region: REGION },
        until: (x) => x.myOrders.length > n0 || x.myOrders.some((o) => o.side === 'Buy' && o.item === item) }));
  }

  // Floorplan parts from the player market only, at up to cfg.floorBuyMult × base value per unit (2% fee
  // included): cheapest sell orders first, part-filling small ones. With no such seller, a buy
  // order at that price for parts you don't make (home-made parts just build up).
  function* floorPartBuys(s, item, need, why) {
    if (!(cfg.floorBuyMult > 0) || need <= 0) return;
    s.bookWanted = true;   // the loop subscribes to the player order book (core.orderBook.need)
    if (!s.ordersKnown) { yield { wait: `${why}: player order book not loaded yet` }; return; }
    const it = s.catalog.items[item] ?? {};
    const amount = Math.max(1, Math.min(Math.ceil(need), Math.floor(courierCU() / (it.cargo_weight || 1))));
    const cap = priceCents(s, item, cfg.floorBuyMult);
    const offers = s.orders.filter((o) => o.side === 'Sell' && o.item === item && o.unit_price * 1.02 <= cap)
      .sort((a, z) => a.unit_price - z.unit_price);
    for (const o of offers) {
      const n = Math.min(amount, o.amount);
      const cost = Math.ceil(o.unit_price * 1.02 * n);
      if (s.money - cost < moneyFloor(s)) { yield { wait: `${why}: need ${usd(cost)} for ${n} ${iname(s, item)}` }; return; }
      const m0 = s.money, u0 = s.atExchange(item);
      yield act(`order:${o.id}`, `${why}: buy ${n} ${iname(s, item)} from a player @ ${usd(o.unit_price)} (lands at the Exchange)`,
        { msg: { type: 'FillOrder', order: o.id, amount: n, hire: null, region: REGION, courier: false }, until: (x) => x.atExchange(item) > u0 || x.money < m0 - cost / 2 });
    }
    if (!s.madeHere.has(item)) yield* postBuyOrder(s, item, amount, cap, why);
  }

  // Buy actions (one per seller, best first) for `need` of an item, capped at one courier load.
  function* buyActions(s, item, need, why) {
    const it = s.catalog.items[item] ?? {};
    const amount = Math.max(1, Math.min(Math.ceil(need), Math.floor(courierCU() / (it.cargo_weight || 1))));
    s.bookWanted = true;
    if (!s.dealsKnown) { yield { wait: `${why}: market board not loaded (open the Market page once)` }; return; }
    if (!s.ordersKnown) { yield { wait: `${why}: player order book not loaded yet` }; return; }
    const offers = sellersOf(s, item, amount);
    if (!offers.length) {
      yield* postBuyOrder(s, item, amount, priceCents(s, item, cfg.buyOrderMult), `no seller for ${iname(s, item)}`);
      yield { wait: `no seller for ${Math.ceil(need)} ${iname(s, item)} under ${cfg.maxBuyPrice}× base (buy it by hand)` };
      return;
    }
    for (const o of offers) {
      const cost = Math.ceil(o.unit * o.n);
      if (s.money - cost < moneyFloor(s)) { yield { wait: `${why}: need ${usd(cost)} for ${o.n} ${iname(s, item)}` }; return; }
      if (o.msg.courier && !s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): ${why}` }; return; }
      const id0 = s.shipId, m0 = s.money, u0 = s.atExchange(item);
      yield act(o.key, `${why}: buy ${o.n} ${iname(s, item)} for ~${usd(cost)}`,
        { msg: o.msg, until: (x) => x.shipId > id0 || x.atExchange(item) > u0 || x.money < m0 - cost / 2 });
    }
  }

  // TransferStock between this region's inventory and its Exchange, as the client's Transfers dialog sends it.
  // Withdraw = from the Exchange; to the Exchange = ship there to sell to players (listCents puts a sell order up on arrival).
  const transferMsg = (item, amount, toExchange, listCents = null) => ({ type: 'TransferStock', from: REGION, to: REGION, item, amount,
    courier: true, from_exchange: !toExchange, to_exchange: toExchange, list_price: toExchange ? listCents : null });

  // Goods bought on the Exchange can't be used there: withdraw what the plan still lacks (`want` = the full amount it
  // needs, before stock), one courier load at a time. Never more, so goods you keep there to sell stay. With the game's
  // Auto-deliver on for this region it ships them itself.
  function* withdrawActions(s, item, want, why) {
    if (s.autoDeliver) return;
    const load = Math.floor(courierCU() / (s.catalog.items[item]?.cargo_weight || 1));
    const n = Math.min(s.atExchange(item), Math.ceil(want - s.has(item) - (s.inbound[item] ?? 0)), load);
    if (!(n > 0)) return;
    if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): ${why}: withdraw ${n} ${iname(s, item)} from the Exchange` }; return; }
    const id0 = s.shipId, u0 = s.atExchange(item);
    yield act(`withdraw:${item}`, `${why}: withdraw ${n} ${iname(s, item)} from the Exchange`,
      { msg: transferMsg(item, n, false), until: (x) => x.shipId > id0 || x.atExchange(item) < u0 });
  }

  // Home-made items held back from a build: next tech's prototype + build cost of plan
  // buildings ranked above `t` that aren't built yet (so Gold Mines can't starve the Smelter).
  function reserveFor(s, item, t, targets) {
    const amt = (list) => (list ?? []).find((i) => i.item === item)?.amount ?? 0;
    const nt = nextTech(s);
    let r = nt ? amt(s.bld(nt.b).build_items) : 0;
    for (const u of targets) { if (u === t) break; r += amt(s.bld(u.b).build_items); }
    return r;
  }

  // Never sell below: base + 10 min of what groups eat + owed kits + next tech prototype
  // + the next two plan builds (items and kits).
  function sellReserve(s, item) {
    const amt = (list) => (list ?? []).find((i) => i.item === item)?.amount ?? 0;
    let r = (SELL.reserve[item] != null ? cfg[SELL.reserve[item]] : 0) + cfg.sellKeepMinutes * (s.eatPerMin[item] ?? 0) + (s.kitOwed[item] ?? 0) + floorReserve(s, item);
    const nt = nextTech(s);
    if (nt) r += amt(s.bld(nt.b).build_items);
    for (const t of criticalTargets(s).slice(0, 2)) r += amt(s.bld(t.b).build_items) + amt(s.kitFor(t.b, t.recipe));
    return Math.ceil(r);
  }

  // Parts to buy: owed kits + next tech's prototype (`want`), minus stock, inbound, what waits at the Exchange and home
  // production. Items with nothing left to buy are kept (need <= 0) so their Exchange goods still get withdrawn.
  function partsToBuy(s) {
    const want = {};
    for (const [item, n] of Object.entries(s.kitOwed)) if (!s.madeHere.has(+item)) want[item] = n;
    const nt = nextTech(s);
    if (nt) {
      const tech = s.catalog.techs.find((t) => t.building === nt.b);
      if (tech && s.cd >= tech.cost) {
        for (const i of s.bld(nt.b).build_items ?? []) {
          if (HOME_MADE.includes(i.item) || NEVER_BUY.includes(i.item)) continue;
          want[i.item] = (want[i.item] ?? 0) + i.amount;
        }
      }
    }
    return Object.entries(want)
      .map(([item, amount]) => ({ item: +item, want: amount, need: amount - s.has(+item) - (s.inbound[+item] ?? 0) - s.atExchange(+item) }));
  }
  // (An open buy order of ours is handled in buyActions: it waits instead of reposting.)

  // Acres held free for the CD booster once it is in use (other builds buy their own).
  function boosterAcresHeld(s) {
    if (!cfg.cdBooster || !s.unlocked(BOOSTER.after)) return 0;
    if (!(successes.get('land:booster') || successes.get('booster:cdfarm')) || !nextTech(s)) return 0;
    return Math.min(cfg.boosterAcres, s.freeAcres);
  }

  // r (a recipe): land for this building only while (acres + building) pay back from its own income within
  // cfg.landPaybackHours; with that income unknown (no bid), the old maxAcre wall. r null: maxAcre only (plan buildings).
  // orWall: either rule is enough (Gold Mines are bought for their CD as much as for their ore).
  function buildSteps(s, b, why, maxAcre, r = null, orWall = false) {
    const needAcres = Math.max(0, s.bld(b).acres - (s.freeAcres - boosterAcresHeld(s)));
    const floor = moneyFloor(s, s.drawOf(b));
    if (needAcres > 0) {
      if (s.acresOwned + needAcres > ACRE_CAP) return { wait: `${why}: Heartland is at its ${ACRE_CAP}-acre cap`, wall: true };
      const lc = landCost(s, needAcres);
      const inc = r == null ? 0 : incomePerMin(s, r);
      const top = acrePrice(s.landBought + needAcres - 1);
      const h = inc > 0 ? (lc + buildCost(s, b)) / inc / 60 : Infinity;
      if (inc > 0 && !orWall && h > cfg.landPaybackHours) return { wait: `${why}: ${needAcres} acre(s) + ${bname(s, b)} would pay back in ${h.toFixed(1)} h (limit ${cfg.landPaybackHours} h)`, wall: true };
      if ((!(inc > 0) || orWall) && h > cfg.landPaybackHours && top > maxAcre * 100) return { wait: `${why}: next acre ${usd(top)} is above the ${usd(maxAcre * 100)} land wall`, wall: true };
      if (s.money - lc - buildCost(s, b) < floor) return { wait: `${why}: saving for ${needAcres} acre(s) + ${bname(s, b)} (${usd(lc + buildCost(s, b))})`, money: true };
      const l0 = s.landBought;
      return act('land', `${why}: buy ${needAcres} acre(s) for ${usd(lc)}`,
        { msg: { type: 'BuyLand', amount: needAcres, region: REGION }, until: (x) => x.landBought >= l0 + needAcres });
    }
    const cost = buildCost(s, b);
    if (s.money - cost < floor) return { wait: `${why}: saving ${usd(cost)} for ${bname(s, b)} (have ${usd(s.money)})`, money: true };
    const o0 = s.owned(b);
    return act(`build:${b}`, `${why}: build ${bname(s, b)} for ${usd(cost)}`,
      { msg: { type: 'BuyBuilding', building: b, amount: 1, region: REGION }, until: (x) => x.owned(b) >= o0 + 1 });
  }

  // Every candidate, in priority order: the preset's rule list (early.rules), each a RULES entry. decide() takes the first that isn't
  // cooling down. A rule that returns STOP ends the list (a final wait). After the hand-off Core plan builds, assigns and buys land: only
  // the rules marked keep still run (bills, power, booster cleanup, unlocks, selling).
  const STOP = Symbol('stop');
  function* candidates(s) {
    // Worked out at first use (coreOwns at the first rule that is not kept, nextTech at the unlock rule), as the fixed order did.
    let owns, nt, qt;
    const ctx = {
      owns: () => (owns ??= coreOwns()),
      nt: () => (nt === undefined ? (nt = nextTech(s)) : nt),
      qt: () => (qt === undefined ? (qt = ctx.nt() ? null : nextQueueable(s)) : qt),
    };
    for (const r of PLAN().rules) {
      if (!r.keep && ctx.owns()) continue;
      const f = RULES[r.rule];
      if (!f) throw new Error('plan preset: unknown rule ' + r.rule);
      if ((yield* f(s, ctx, r)) === STOP) return;
    }
  }

  const RULES = {
    // Resume groups paused by an unpaid bill. Groups you paused are never touched.
    *resumePaused(s) {
      if (!cfg.resumePaused) return;
      for (const g of s.groups) {
        if (!g.paused || !billPaused.has(g.id) || userPaused.has(g.id) || keptPaused.has(g.id)) continue;
        const mw = s.drawOf(g.building) * g.count;
        if (s.money < moneyFloor(s, mw) + mw * 1000) { yield { wait: `"${g.name}" is paused (unpaid bill?): waiting for cash to resume` }; continue; }
        yield act(`resume:${g.id}`, `resume "${g.name}" (paused, bills affordable again)`,
          { msg: { type: 'SetPaused', group: g.id, paused: false }, until: (x) => !x.st.groups[g.id]?.paused });
      }
    },

    // Power.
    // Auto utilities owns power while it is on: it subscribes the running load; this step would raise it back to the unpaused draw.
    // Power bought on contracts covers part of the draw: only the rest is subscribed.
    *power(s) {
      const powerShort = s.powerNeed - s.powerBought;
      if (powerShort > s.powerHave && !s.autoPower) {
        const level = Math.min(MAX_POWER, powerShort);
        if (level > s.powerHave) {
          yield act('power', `power: groups draw ${s.powerNeed} MW${s.powerBought > 0 ? `, ${s.powerBought} MW bought` : ''}, subscribed ${s.powerHave}`,
            { msg: { type: 'SetSubscription', region: REGION, utility: 'power', level }, until: (x) => x.powerHave === level });
        }
        if (powerShort > MAX_POWER) yield { wait: `power need ${powerShort} MW is above the ${MAX_POWER} MW grid cap` };
      }
    },

    // Booster leftovers (its demolish got lost): demolish them, don't put them to work.
    *boosterCleanup(s) {
      for (const [bs, left] of Object.entries(boosterLeft)) {
        const b = +bs, n = Math.min(left, s.pool[b] ?? 0);
        if (!left) continue;
        if (!n) { boosterLeft[b] = 0; continue; } // already gone
        const p0 = s.pool[b];
        const a = act(`booster:cleanup:${b}`, `CD booster cleanup: demolish ${n} leftover ${bname(s, b)}`,
          { msg: { type: 'DemolishBuilding', building: b, amount: n, region: REGION }, until: (x) => (x.pool[b] ?? 0) <= p0 - n });
        a.meta = { b, n };
        yield a;
      }
    },

    // Unassigned plan buildings → their group (non-plan buildings are left alone). Buildings with several plan recipes go one at a time.
    *assignPool(s) {
      for (const [bs, total] of Object.entries(s.pool)) {
        const b = +bs;
        const n = total - (boosterLeft[b] ?? 0) - farmCamps(s, b);
        if (n <= 0) continue;
        const r = poolRecipe(s, b);
        if (r == null) continue;
        yield assignAction(s, b, r, isPick(b) ? 1 : poolTake(s, b, n));
      }
    },

    // Plan groups with no task.
    *idleGroups(s) {
      for (const g of s.groups) {
        if (g.recipe != null || isCapped(g.building)) continue; // bare Kiln groups are Core plan's
        const r = poolRecipe(s, g.building);
        if (r == null) continue;
        yield act(`recipe:${g.id}`, `idle group "${g.name}" → ${NAMES[r]}`,
          { msg: { type: 'SetRecipe', group: g.id, recipe: r }, until: (x) => x.st.groups[g.id]?.recipe === r });
      }
    },

    // Kit / prototype parts the corp can't make yet (not after the hand-off: Autopilot stops buying then).
    *buyKits(s) {
      if (!cfg.buyKits) return;
      for (const p of partsToBuy(s)) {
        yield* withdrawActions(s, p.item, p.want, 'parts for kits/prototype');
        if (p.need > 0) yield* buyActions(s, p.item, p.need, 'parts for kits/prototype');
      }
    },

    // Next plan tech.
    // Premium with research_queue in the state: while the slot is busy, the next unlock is queued (QueueTech) instead of waiting.
    *unlock(s, ctx) {
      const nt = ctx.nt();
      const qt = ctx.qt();
      const t6 = nt ?? qt;
      if (!t6) return;
      const tech = s.catalog.techs.find((t) => t.building === t6.b);
      const proto = s.bld(t6.b).build_items ?? [];
      const why = `${qt ? 'queue' : 'unlock'} ${bname(s, t6.b)}`;
      if (!tech) yield { wait: `${why}: not in the tech tree` };
      else if (!s.researchIdle && !qt) yield { wait: `${why}: research slot busy` };
      else if (tech.requires != null && !s.unlocked(tech.requires) && !(qt && pendingTech(s, tech.requires))) yield { wait: `${why}: needs ${bname(s, tech.requires)} first` };
      else if (s.cd < tech.cost) yield { wait: `${why}: ${s.cd} / ${tech.cost} CD` };
      else {
        const gate = t6.gate ? t6.gate(s) : true;
        const lack = proto.filter((i) => s.has(i.item) < i.amount);
        if (gate !== true) yield { wait: `${why}: ${gate}` };
        else if (lack.length) yield { wait: `${why}: need ${lack.map((i) => `${Math.ceil(i.amount - s.has(i.item))} more ${iname(s, i.item)}${whyNoneMade(s, i.item)}`).join(', ')}` };
        else {
          yield act(`tech:${t6.b}`, `${why} (${tech.cost} CD${proto.length ? ' + ' + proto.map((i) => `${i.amount} ${iname(s, i.item)}`).join(', ') : ''})`,
            { msg: { type: qt ? 'QueueTech' : 'StartTech', building: t6.b, region: REGION }, until: (x) => pendingTech(x, t6.b) || x.unlocked(t6.b) });
        }
      }
    },

    // Better floorplans (they buy parts; not after the hand-off).
    *floors(s) { yield* floorActions(s); },

    // Selling.
    *sell(s) { yield* sellActions(s); },

    // Plan buildings (the target rows). Saving for one (cfg.saveForCritical) is a final wait: camps don't eat the money.
    *planBuildings(s) {
      const targets = criticalTargets(s);
      for (const t of targets) {
        const items = s.bld(t.b).build_items ?? [];
        const short = items.find((i) => s.has(i.item) < i.amount + (HOME_MADE.includes(i.item) ? reserveFor(s, i.item, t, targets) : 0));
        const label = `${bname(s, t.b)}${isPick(t.b) ? ` (${NAMES[t.recipe]})` : ''} ${t.have + 1}/${t.target === Infinity ? '∞' : t.target}`;
        if (short) { yield { wait: `${label}: waiting for ${iname(s, short.item)}${whyNoneMade(s, short.item)}` }; continue; }
        if (s.owned(t.b) > s.equipped(t.b)) { yield { wait: `${label}: a ${bname(s, t.b)} is still waiting for its floor kit` }; continue; }
        // One-off plan buildings take land at any price they can afford; only the open-ended rows
        // (Gold Mines) are held to the land wall or land payback, whichever allows more.
        const gold = !!TARGETS.find((x) => x.b === t.b && x.r === t.recipe)?.openEnded;
        const wall = gold ? Math.max(cfg.maxAcrePriceCritical, s.money / 100 * cfg.landCashShare) : Infinity;
        const a = buildSteps(s, t.b, label, wall, gold ? t.recipe : null, gold);
        if (a.steps) { yield a; continue; }
        if (a.money && cfg.saveForCritical) { yield { ...a, final: true }; return STOP; }
        yield a;
      }
    },

    // CD booster.
    *booster(s, ctx) { yield* boosterActions(s, ctx.nt()); },

    // Lumber Camp or Farm (r.of: [a, b]): the one whose next building (and its acres) pays back sooner from live income per acre
    // (best bid × output × floor rate). Its price climbs with each one owned, so the two alternate. No income known → the cheaper; tie → b.
    // Land wall: maxAcrePrice once r.wallAfter's unlock has started, maxAcrePriceEarly before.
    *fillers(s, ctx, r) {
      if (farmInfo()?.resumable) { yield { wait: 'camps/farms wait: CD Farm has an interrupted run (resume or discard it in CD Farm)' }; return STOP; }
      const [fa, fb] = r.of.map(bId);
      const payback = (x) => { const inc = incomePerMin(s, TASK[x]); return inc > 0 ? (buildCost(s, x) + s.bld(x).acres * acrePrice(s.landBought)) / inc : Infinity; };
      const pf = payback(fa), pc = payback(fb);
      const b = pf < pc || (pf === pc && buildCost(s, fa) < buildCost(s, fb)) ? fa : fb;
      const unequipped = s.owned(fb) + s.owned(fa) - s.equipped(fb) - s.equipped(fa);
      if (unequipped >= cfg.maxUnequippedCamps) { yield { wait: `${unequipped} camps/farms still waiting for their Wood kit` }; return STOP; }
      const w = bId(r.wallAfter), workshopStarted = s.unlocked(w) || s.research?.building === w;
      yield buildSteps(s, b, `${bname(s, b)} #${s.owned(b) + 1}`, workshopStarted ? cfg.maxAcrePrice : cfg.maxAcrePriceEarly, TASK[b], true);
    },
  };

  function* boosterActions(s, nt) {
    if (!cfg.cdBooster || !nt || !s.unlocked(BOOSTER.after) || !s.researchIdle) return;
    const tech = s.catalog.techs.find((t) => t.building === nt.b);
    if (!tech || s.cd >= tech.cost || (tech.requires != null && !s.unlocked(tech.requires))) return;
    const fi = farmInfo();
    if (fi?.resumable) { yield { wait: 'CD booster waits: CD Farm has an interrupted run (resume or discard it in CD Farm)' }; return; }
    if (typeof fi?.f.start !== 'function') { yield { wait: 'CD booster waits: CD Farm is not loaded' }; return; }
    if (Object.values(boosterLeft).some((n) => n > 0)) return; // clean up first
    if (s.money < cfg.boosterMinCash * 100) return;
    if (s.freeAcres < 1) {
      const want = Math.max(1, cfg.boosterAcres);
      if (s.acresOwned + want > ACRE_CAP) return;
      // A few acres bought once and reused for every cycle: allowed up to 10% of cash per acre.
      const cap = Math.max(cfg.maxAcrePriceCritical, s.money / 100 * Math.max(cfg.landCashShare, 0.1)) * 100;
      if (acrePrice(s.landBought + want - 1) > cap) { yield { wait: `CD booster: next acre ${usd(acrePrice(s.landBought))} above the land wall` }; return; }
      const lc = landCost(s, want), l0 = s.landBought;
      if (s.money - lc < Math.max(moneyFloor(s), cfg.boosterKeepCash * 100)) return;
      yield act('land:booster', `CD booster: buy ${want} acre(s) to build on (${usd(lc)}, reused)`,
        { msg: { type: 'BuyLand', amount: want, region: REGION }, until: (x) => x.landBought >= l0 + want });
      return;
    }
    const keep = Math.max(moneyFloor(s), cfg.boosterKeepCash * 100);
    // CD Farm runs the build+demolish cycles itself (and verifies them); we hold until it stops.
    // Its settings for this run are restored when it stops (runOnly).
    // Not worth starting when it would stop at once (it needs one camp's cost above the floor), and
    // after a run ends (stopped by you, error) wait cfg.boosterFarmGapMs instead of restarting it every loop.
    if (s.money - buildCost(s, BOOSTER.b) < keep) return;
    if (nowMs() - farmSeenBusyAt < cfg.boosterFarmGapMs) { yield { wait: `CD booster: CD Farm just stopped, waiting ${cfg.boosterFarmGapMs / 1000} s before starting it again` }; return; }
    const opts = {
      targetCd: tech.cost, budget: 'reserve', minMoney: Math.ceil(keep / 100), batch: cfg.boosterBatch,
      reserveAcres: 0, fullBatch: false, existingPool: 'keep', maxSpendPerMin: Infinity,
      building: BOOSTER.b, region: REGION, runOnly: true, by: `Autopilot: CD for ${bname(s, nt.b)}`,
    };
    const a = act('booster:cdfarm', `CD booster via CD Farm: farm ${tech.cost - s.cd} CD for ${bname(s, nt.b)} (keeps ${usd(keep)})`);
    a.call = () => { fi.f.start(opts); return !!W.cdFarm?.running; };
    a.callInfo = `cdFarm.start(${JSON.stringify(opts)})`;
    yield a;
  }

  // "back in 6 s" from the game's courier_ready_at, or our own hold after a lost race.
  const courierBackInMs = (s) => Math.max(s.courierWaitTicks * 500, courierHoldUntil - nowMs(), 0);
  function courierEta(s) {
    const ms = courierBackInMs(s);
    return ms > 0 ? `back in ${Math.ceil(ms / 1000)} s` : 'back now';
  }

  function* sellActions(s) {
    if (!s.dealsKnown) { yield { wait: 'selling: market board not loaded (open the Market page once)' }; return; }
    const load = (item) => Math.floor(courierCU() / (s.catalog.items[item]?.cargo_weight || 1));
    const bids = (item) => s.deals.filter((d) => d.side === 'Sell' && d.item === item)
      .sort((a, z) => z.price / z.amount - a.price / a.amount);

    // Cotton auto-ship (the preset's sell.autoShip; 1 slot, unlocks after First Steps). Never replaces another auto-ship.
    const standingIds = Object.keys(s.standing), ship = SELL.autoShip;
    const autoCotton = standingIds.some((id) => s.deals.find((d) => String(d.id) === id)?.item === ship.id);
    if (cfg[ship.cfg] && !autoCotton && standingIds.length === 0 && s.has(ship.id) > 0) {
      const d = bids(ship.id)[0];
      if (d) {
        yield act(`autoship:${d.id}`, `auto-ship ${ship.item} to bid @ ${usd(d.price / d.amount)}`,
          { msg: { type: 'KeepFilling', deal: d.id, region: REGION, amount: null }, until: (x) => !!x.standing[d.id], optional: true });
      }
    }
    if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): selling waits` }; return; }

    // Every item with a Heartland bid whose stock above its reserve fills a courier run
    // (10,000 CU) is sold, best-paying load first. Part loads only for Wood/Cotton at the start.
    const early = SELL.smallUntil.reduce((n, b) => n + s.owned(b), 0) < cfg.smallLoadsUntil;
    const autoItems = new Set(standingIds.map((id) => s.deals.find((d) => String(d.id) === id)?.item).filter((i) => i != null));
    const items = new Set(cfg.sellAll ? Object.keys(s.stock).map(Number) : []);
    for (const i of SELL.always) items.add(i);
    const loads = [];
    for (const item of items) {
      if (autoItems.has(item) || NEVER_SELL.includes(item) || cfg.neverSell.includes(item) || s.catalog.items[item]?.intangible) continue;
      const spare = Math.floor(s.has(item) - sellReserve(s, item));
      const small = early && SELL.small.includes(item);
      const n = small ? Math.min(load(item), spare) : load(item);
      if (spare < n || n < (small ? cfg.minSmallLoad : 1)) continue;
      for (const d of bids(item)) {
        if (d.amount < n) continue; // nearly filled: try the next bid
        loads.push({ item, n, d, value: d.price / d.amount * n });
        break;
      }
    }
    loads.sort((a, z) => z.value - a.value);
    for (const { item, n, d, value } of loads) {
      const id0 = s.shipId;
      yield act(`fill:${d.id}`, `sell ${n} ${iname(s, item)} @ ${usd(d.price / d.amount)} = ${usd(value)}${n === load(item) ? ' (full courier load)' : ' (part load)'}`,
        { msg: { type: 'FillDeal', deal: d.id, amount: n, hire: null, region: REGION, courier: true }, until: (x) => x.shipId > id0 });
    }
  }

  // First candidate action not cooling down. Waits are collected; a final wait (saving for a
  // plan building) stops the search so camps don't eat the money.
  function decide(s) {
    const waits = [];
    for (const c of candidates(s)) {
      if (c.steps) {
        if (usesCourier(c)) c.meta = { ...(c.meta ?? {}), courierReadyAt: s.courierReadyAt };
        if (cooling(c.key)) { waits.push(`backing off "${c.reason}" (${cooldowns.get(c.key).why || 'not confirmed'})`); continue; }
        return c;
      }
      waits.push(c.wait);
      if (c.final) break;
    }
    const isNote = (w) => /^no seller|^courier busy|backing off/.test(w);
    const main = waits.find((w) => !isNote(w)) ?? waits[0] ?? 'nothing to do';
    const extra = waits.filter((w) => w !== main && /^no seller|backing off/.test(w));
    return { wait: main + (extra.length ? ` | ${extra.slice(0, 2).join(' | ')}` : ''), waits };
  }

