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

  // Sellers of an item, cheapest first, under the price cap, big enough for `amount`.
  function sellersOf(s, item, amount) {
    const it = s.catalog.items[item] ?? {};
    const cap = (it.base_value || 0) * cfg.maxBuyPrice;
    return [
      ...s.deals.filter((d) => d.side === 'Buy' && d.item === item && d.amount >= amount)
        .map((d) => ({ key: `fill:${d.id}`, unit: d.price / d.amount, msg: { type: 'FillDeal', deal: d.id, amount, hire: null, region: REGION, courier: true } })),
      ...s.orders.filter((o) => o.side === 'Sell' && o.item === item && o.amount >= amount)
        .map((o) => ({ key: `order:${o.id}`, unit: o.unit_price * 1.02, msg: { type: 'FillOrder', order: o.id, amount, hire: null, region: REGION, courier: true } })),
    ].filter((o) => !cap || o.unit <= cap).sort((a, z) => a.unit - z.unit);
  }

  // One open player buy order per item, at `usd` per unit; none again within orderHoldHours
  // unless the last one was seen filled. Yields an action or a wait.
  function* postBuyOrder(s, item, amount, usdPerUnit, why) {
    const mine = s.myOrders.find((o) => o.side === 'Buy' && o.item === item);
    if (mine) { yield { wait: `${why}: your buy order for ${mine.amount} @ ${usd(mine.unit_price)} is waiting for a player` }; return; }
    const since = nowMs() - (posted[item] ?? -Infinity);
    if (since < cfg.orderHoldHours * 3600000) { yield { wait: `${why}: buy order posted ${Math.round(since / 60000)} min ago, waiting for a player` }; return; }
    const unit = Math.max(1, Math.round(usdPerUnit * 100)); // cents
    if (!cfg.postBuyOrders || s.money - unit * amount * 1.02 < moneyFloor(s)) return;
    const n0 = s.myOrders.length;
    yield withMeta({ item }, act(`post:${item}`, `${why}: post a buy order for ${amount} ${iname(s, item)} @ ${usd(unit)} (escrows ${usd(unit * amount)})`,
      { msg: { type: 'PostOrder', side: 'Buy', item, amount, unit_price: unit, region: REGION },
        until: (x) => x.myOrders.length > n0 || x.myOrders.some((o) => o.side === 'Buy' && o.item === item) }));
  }

  // Floorplan parts from the player market only, at up to cfg.floorBuyUsd per unit (2% fee
  // included): cheapest sell orders first, part-filling small ones. With no such seller, a buy
  // order at that price for parts you don't make (home-made parts just build up).
  function* floorPartBuys(s, item, need, why) {
    if (!(cfg.floorBuyUsd > 0) || need <= 0) return;
    if (!s.ordersKnown) { yield { wait: `${why}: player order board not loaded (open the Market page once)` }; return; }
    const it = s.catalog.items[item] ?? {};
    const amount = Math.max(1, Math.min(Math.ceil(need), Math.floor(COURIER_CU / (it.cargo_weight || 1))));
    const cap = cfg.floorBuyUsd * 100;
    const offers = s.orders.filter((o) => o.side === 'Sell' && o.item === item && o.unit_price * 1.02 <= cap)
      .sort((a, z) => a.unit_price - z.unit_price);
    for (const o of offers) {
      const n = Math.min(amount, o.amount);
      const cost = Math.ceil(o.unit_price * 1.02 * n);
      if (s.money - cost < moneyFloor(s)) { yield { wait: `${why}: need ${usd(cost)} for ${n} ${iname(s, item)}` }; return; }
      if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): ${why}` }; return; }
      const id0 = s.shipId, m0 = s.money;
      yield act(`order:${o.id}`, `${why}: buy ${n} ${iname(s, item)} from a player @ ${usd(o.unit_price)}`,
        { msg: { type: 'FillOrder', order: o.id, amount: n, hire: null, region: REGION, courier: true }, until: (x) => x.shipId > id0 || x.money < m0 - cost / 2 });
    }
    if (!s.madeHere.has(item)) yield* postBuyOrder(s, item, amount, cfg.floorBuyUsd, why);
  }

  // Buy actions (one per seller, best first) for `need` of an item, capped at one courier load.
  function* buyActions(s, item, need, why) {
    const it = s.catalog.items[item] ?? {};
    const amount = Math.max(1, Math.min(Math.ceil(need), Math.floor(COURIER_CU / (it.cargo_weight || 1))));
    if (!s.dealsKnown || !s.ordersKnown) { yield { wait: `${why}: market board not loaded (open the Market page once)` }; return; }
    const offers = sellersOf(s, item, amount);
    if (!offers.length) {
      yield* postBuyOrder(s, item, amount, cfg.buyOrderUsd, `no seller for ${iname(s, item)}`);
      yield { wait: `no seller for ${Math.ceil(need)} ${iname(s, item)} under ${cfg.maxBuyPrice}× base (buy it by hand)` };
      return;
    }
    for (const o of offers) {
      const cost = Math.ceil(o.unit * amount);
      if (s.money - cost < moneyFloor(s)) { yield { wait: `${why}: need ${usd(cost)} for ${amount} ${iname(s, item)}` }; return; }
      if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): ${why}` }; return; }
      const id0 = s.shipId, m0 = s.money;
      yield act(o.key, `${why}: buy ${amount} ${iname(s, item)} for ~${usd(cost)}`,
        { msg: o.msg, until: (x) => x.shipId > id0 || x.money < m0 - cost / 2 });
    }
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
    let r = (item === WOOD ? cfg.woodReserve : 0) + cfg.sellKeepMinutes * (s.eatPerMin[item] ?? 0) + (s.kitOwed[item] ?? 0) + floorReserve(s, item);
    const nt = nextTech(s);
    if (nt) r += amt(s.bld(nt.b).build_items);
    for (const t of criticalTargets(s).slice(0, 2)) r += amt(s.bld(t.b).build_items) + amt(s.kitFor(t.b, t.recipe));
    return Math.ceil(r);
  }

  // Parts to buy: owed kits + next tech's prototype, minus stock, inbound and home production.
  function partsToBuy(s) {
    const want = {};
    for (const [item, n] of Object.entries(s.kitOwed)) if (!s.madeHere.has(+item)) want[item] = n;
    const nt = nextTech(s);
    if (nt) {
      const tech = s.catalog.techs.find((t) => t.building === nt.b);
      if (tech && s.cd >= tech.cost) {
        for (const i of s.bld(nt.b).build_items ?? []) {
          if (HOME_MADE.includes(i.item) || i.item === LD || i.item === CD) continue;
          want[i.item] = (want[i.item] ?? 0) + i.amount;
        }
      }
    }
    return Object.entries(want)
      .map(([item, amount]) => ({ item: +item, need: amount - s.has(+item) - (s.inbound[+item] ?? 0) }))
      .filter((p) => p.need > 0);
  }
  // (An open buy order of ours is handled in buyActions: it waits instead of reposting.)

  // Acres held free for the CD booster once it is in use (other builds buy their own).
  function boosterAcresHeld(s) {
    if (!cfg.cdBooster || !s.unlocked(B.WORKSHOP)) return 0;
    if (!(successes.get('booster') || successes.get('land:booster') || successes.get('booster:cdfarm'))) return 0;
    if ((boosterOff() && cfg.boosterVia !== 'cdFarm') || !nextTech(s)) return 0;
    return Math.min(cfg.boosterAcres, s.freeAcres);
  }

  function buildSteps(s, b, why, maxAcre) {
    const needAcres = Math.max(0, s.bld(b).acres - (s.freeAcres - boosterAcresHeld(s)));
    const floor = moneyFloor(s, s.drawOf(b));
    if (needAcres > 0) {
      const top = acrePrice(s.landBought + needAcres - 1);
      if (top > maxAcre * 100) return { wait: `${why}: next acre ${usd(top)} is above the ${usd(maxAcre * 100)} land wall`, wall: true };
      const lc = landCost(s, needAcres);
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

  // Every candidate, in priority order. decide() takes the first that isn't cooling down.
  function* candidates(s) {
    // 1. Resume groups paused by an unpaid bill. Groups you paused are never touched.
    if (cfg.resumePaused) {
      for (const g of s.groups) {
        if (!g.paused || !billPaused.has(g.id) || userPaused.has(g.id) || keptPaused.has(g.id)) continue;
        const mw = s.drawOf(g.building) * g.count;
        if (s.money < moneyFloor(s, mw) + mw * 1000) { yield { wait: `"${g.name}" is paused (unpaid bill?): waiting for cash to resume` }; continue; }
        yield act(`resume:${g.id}`, `resume "${g.name}" (paused, bills affordable again)`,
          { msg: { type: 'SetPaused', group: g.id, paused: false }, until: (x) => !x.st.groups[g.id]?.paused });
      }
    }

    // 2. Power.
    if (s.powerNeed > s.powerHave) {
      const level = Math.min(MAX_POWER, s.powerNeed);
      if (level > s.powerHave) {
        yield act('power', `power: groups draw ${s.powerNeed} MW, subscribed ${s.powerHave}`,
          { msg: { type: 'SetSubscription', region: REGION, utility: 'power', level }, until: (x) => x.powerHave === level });
      }
      if (s.powerNeed > MAX_POWER) yield { wait: `power need ${s.powerNeed} MW is above the ${MAX_POWER} MW grid cap` };
    }

    // 3a. Booster leftovers (its demolish got lost): demolish them, don't put them to work.
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

    // 3b. Unassigned plan buildings → their group (non-plan buildings are left alone).
    for (const [bs, total] of Object.entries(s.pool)) {
      const b = +bs;
      const n = total - (boosterLeft[b] ?? 0) - farmCamps(s, b);
      if (n <= 0) continue;
      const r = poolRecipe(s, b);
      if (r == null) continue;
      yield assignAction(s, b, r, b === B.MINE || b === B.WORKSHOP ? 1 : poolTake(s, b, n));
    }

    // 4. Plan groups with no task.
    for (const g of s.groups) {
      if (g.recipe != null || g.building === B.KILN) continue; // bare Kiln groups are Core plan's
      const r = poolRecipe(s, g.building);
      if (r == null) continue;
      yield act(`recipe:${g.id}`, `idle group "${g.name}" → ${NAMES[r]}`,
        { msg: { type: 'SetRecipe', group: g.id, recipe: r }, until: (x) => x.st.groups[g.id]?.recipe === r });
    }

    // 5. Kit / prototype parts the corp can't make yet.
    if (cfg.buyKits) for (const p of partsToBuy(s)) yield* buyActions(s, p.item, p.need, 'parts for kits/prototype');

    // 6. Next plan tech.
    const nt = nextTech(s);
    if (nt) {
      const tech = s.catalog.techs.find((t) => t.building === nt.b);
      const proto = s.bld(nt.b).build_items ?? [];
      const why = `unlock ${bname(s, nt.b)}`;
      if (!tech) yield { wait: `${why}: not in the tech tree` };
      else if (!s.researchIdle) yield { wait: `${why}: research slot busy` };
      else if (tech.requires != null && !s.unlocked(tech.requires)) yield { wait: `${why}: needs ${bname(s, tech.requires)} first` };
      else if (s.cd < tech.cost) yield { wait: `${why}: ${s.cd} / ${tech.cost} CD` };
      else {
        const gate = nt.gate ? nt.gate(s) : true;
        const lack = proto.filter((i) => s.has(i.item) < i.amount);
        if (gate !== true) yield { wait: `${why}: ${gate}` };
        else if (lack.length) yield { wait: `${why}: need ${lack.map((i) => `${Math.ceil(i.amount - s.has(i.item))} more ${iname(s, i.item)}${whyNoneMade(s, i.item)}`).join(', ')}` };
        else {
          yield act(`tech:${nt.b}`, `${why} (${tech.cost} CD${proto.length ? ' + ' + proto.map((i) => `${i.amount} ${iname(s, i.item)}`).join(', ') : ''})`,
            { msg: { type: 'StartTech', building: nt.b, region: REGION }, until: (x) => x.research?.building === nt.b || x.unlocked(nt.b) });
        }
      }
    }

    // 6b. Better floorplans.
    yield* floorActions(s);

    // 7. Selling.
    yield* sellActions(s);

    // 8. Plan buildings.
    const targets = criticalTargets(s);
    for (const t of targets) {
      const items = s.bld(t.b).build_items ?? [];
      const short = items.find((i) => s.has(i.item) < i.amount + (HOME_MADE.includes(i.item) ? reserveFor(s, i.item, t, targets) : 0));
      const label = `${bname(s, t.b)}${t.b === B.MINE || t.b === B.WORKSHOP ? ` (${NAMES[t.recipe]})` : ''} ${t.have + 1}/${t.target === Infinity ? '∞' : t.target}`;
      if (short) { yield { wait: `${label}: waiting for ${iname(s, short.item)}${whyNoneMade(s, short.item)}` }; continue; }
      if (s.owned(t.b) > s.equipped(t.b)) { yield { wait: `${label}: a ${bname(s, t.b)} is still waiting for its floor kit` }; continue; }
      // One-off plan buildings take land at any price they can afford; only the open-ended
      // Gold Mines are held to the land wall.
      const wall = t.recipe === R.MINE_GOLD ? Math.max(cfg.maxAcrePriceCritical, s.money / 100 * cfg.landCashShare) : Infinity;
      const a = buildSteps(s, t.b, label, wall);
      if (a.steps) { yield a; continue; }
      if (a.money && cfg.saveForCritical) { yield { ...a, final: true }; return; }
      yield a;
    }

    // 9. CD booster.
    yield* boosterActions(s, nt);

    // 10. Cheaper of Lumber Camp / Farm (tie → camp).
    if (farmInfo()?.resumable) { yield { wait: 'camps/farms wait: CD Farm has an interrupted run (resume or discard it in CD Farm)' }; return; }
    const b =buildCost(s, B.FARM) < buildCost(s, B.CAMP) ? B.FARM : B.CAMP;
    const unequipped = s.owned(B.CAMP) + s.owned(B.FARM) - s.equipped(B.CAMP) - s.equipped(B.FARM);
    if (unequipped >= cfg.maxUnequippedCamps) { yield { wait: `${unequipped} camps/farms still waiting for their Wood kit` }; return; }
    const workshopStarted = s.unlocked(B.WORKSHOP) || s.research?.building === B.WORKSHOP;
    yield buildSteps(s, b, `${bname(s, b)} #${s.owned(b) + 1}`, workshopStarted ? cfg.maxAcrePrice : cfg.maxAcrePriceEarly);
  }

  function* boosterActions(s, nt) {
    if (!cfg.cdBooster || !nt || !s.unlocked(B.WORKSHOP) || !s.researchIdle) return;
    const tech = s.catalog.techs.find((t) => t.building === nt.b);
    if (!tech || s.cd >= tech.cost || (tech.requires != null && !s.unlocked(tech.requires))) return;
    const fi = farmInfo();
    if (fi?.resumable) { yield { wait: 'CD booster waits: CD Farm has an interrupted run (resume or discard it in CD Farm)' }; return; }
    const viaFarm = cfg.boosterVia === 'cdFarm' && typeof fi?.f.start === 'function';
    const verified = (successes.get('booster') ?? 0) > 0;
    if (boosterOff() && !viaFarm) { yield { wait: 'CD booster off: build-and-demolish did not keep the CD / refund (seen twice)' }; return; }
    if (Object.values(boosterLeft).some((n) => n > 0)) return; // clean up first
    if (s.money < cfg.boosterMinCash * 100) return;
    if (s.freeAcres < 1) {
      const want = Math.max(1, cfg.boosterAcres);
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
    if (viaFarm) {
      // CD Farm runs the build+demolish cycles itself (and verifies them); we hold until it stops.
      // Its settings for this run are restored when it stops (runOnly).
      // Not worth starting when it would stop at once (it needs one camp's cost above the floor), and
      // after a run ends (stopped by you, error) wait cfg.boosterFarmGapMs instead of restarting it every loop.
      if (s.money - buildCost(s, B.CAMP) < keep) return;
      if (nowMs() - farmSeenBusyAt < cfg.boosterFarmGapMs) { yield { wait: `CD booster: CD Farm just stopped, waiting ${cfg.boosterFarmGapMs / 1000} s before starting it again` }; return; }
      const opts = {
        targetCd: tech.cost, budget: 'reserve', minMoney: Math.ceil(keep / 100), batch: cfg.boosterBatch,
        reserveAcres: 0, fullBatch: false, existingPool: 'keep', maxSpendPerMin: Infinity,
        building: B.CAMP, runOnly: true, by: `Autopilot: CD for ${bname(s, nt.b)}`,
      };
      const a = act('booster:cdfarm', `CD booster via CD Farm: farm ${tech.cost - s.cd} CD for ${bname(s, nt.b)} (keeps ${usd(keep)})`);
      a.call = () => { fi.f.start(opts); return !!W.cdFarm?.running; };
      a.callInfo = `cdFarm.start(${JSON.stringify(opts)})`;
      yield a;
      return;
    }
    const b = buildCost(s, B.FARM) < buildCost(s, B.CAMP) ? B.FARM : B.CAMP;
    const base = s.bld(b).cost, owned = s.owned(b);
    const max = verified ? Math.min(cfg.boosterBatch, s.freeAcres, tech.cost - s.cd) : 1;
    let n = 0, cost = 0;
    while (n < max && s.money - (cost + Math.round(base * (20 + owned + n) / 20)) >= keep) { cost += Math.round(base * (20 + owned + n) / 20); n++; }
    if (!n) return;
    const refund = Math.floor(base / 2) * n;
    const p0 = s.pool[b] ?? 0, cd0 = s.cd, m0 = s.money;
    const a = act('booster', `CD booster${verified ? '' : ' (1-building test)'}: build + demolish ${n} ${bname(s, b)} → +${n} CD for ~${usd(cost - refund)} (${tech.cost - s.cd} CD short of ${bname(s, nt.b)})`,
      { msg: { type: 'BuyBuilding', building: b, amount: n, region: REGION }, until: (x) => (x.pool[b] ?? 0) >= p0 + n },
      { msg: { type: 'DemolishBuilding', building: b, amount: n, region: REGION },
        // Verified on the result: buildings gone, CD kept, and the refund came back.
        // Slack covers a $10/MW bill landing between the two steps.
        until: (x) => (x.pool[b] ?? 0) <= p0 && x.cd >= cd0 + n && x.money >= m0 - (cost - refund) - Math.max(5000, cost * 0.02) - Math.max(s.powerHave, s.powerNeed) * 1000 });
    a.meta = { b, n, p0 };
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
    const load = (item) => Math.floor(COURIER_CU / (s.catalog.items[item]?.cargo_weight || 1));
    const bids = (item) => s.deals.filter((d) => d.side === 'Sell' && d.item === item)
      .sort((a, z) => z.price / z.amount - a.price / a.amount);

    // Cotton auto-ship (1 slot, unlocks after First Steps). Never replaces another auto-ship.
    const standingIds = Object.keys(s.standing);
    const autoCotton = standingIds.some((id) => s.deals.find((d) => String(d.id) === id)?.item === COTTON);
    if (cfg.autoShipCotton && !autoCotton && standingIds.length === 0 && s.has(COTTON) > 0) {
      const d = bids(COTTON)[0];
      if (d) {
        yield act(`autoship:${d.id}`, `auto-ship Cotton to bid @ ${usd(d.price / d.amount)}`,
          { msg: { type: 'KeepFilling', deal: d.id, region: REGION, amount: null }, until: (x) => !!x.standing[d.id], optional: true });
      }
    }
    if (!s.courierFree) { yield { wait: `courier busy (${courierEta(s)}): selling waits` }; return; }

    // Every item with a Heartland bid whose stock above its reserve fills a courier run
    // (10,000 CU) is sold, best-paying load first. Part loads only for Wood/Cotton at the start.
    const early = s.owned(B.CAMP) + s.owned(B.FARM) < cfg.smallLoadsUntil;
    const autoItems = new Set(standingIds.map((id) => s.deals.find((d) => String(d.id) === id)?.item).filter((i) => i != null));
    const items = new Set(cfg.sellAll ? Object.keys(s.stock).map(Number) : []);
    items.add(WOOD); items.add(COTTON);
    const loads = [];
    for (const item of items) {
      if (autoItems.has(item) || NEVER_SELL.includes(item) || cfg.neverSell.includes(item) || s.catalog.items[item]?.intangible) continue;
      const spare = Math.floor(s.has(item) - sellReserve(s, item));
      const small = early && (item === WOOD || item === COTTON);
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
  // Never sold: what the plan builds with, and corp-wide data.
  const NEVER_SELL = [PLANKS, WFRAME, IFRAME, MONEY, CD, 25, 26, LD];

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

