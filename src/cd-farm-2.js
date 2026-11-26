// continues the cd-farm closure from cd-farm-1.js (same try / IIFE)
  // ---- cycle -------------------------------------------------------------

  const netSpend = () => stats.spent - stats.refunded;
  const stopWith = (reason) => { stopReason = reason; return 'stop'; };

  // Returns 'ok' | 'wait' | 'stop'.
  async function cycle() {
    const r0 = read();
    if (!r0) throw new ConnError('game state not found');
    if (r0.cd >= cfg.targetCd) return stopWith(`reached target CD ${fmt(cfg.targetCd)}`);
    if (netSpend() >= cfg.maxSpend) return stopWith(`reached max spend $${fmt(cfg.maxSpend)}`);
    // Acres held by queued demolitions come back as each one finishes (10 s per camp): wait for them. Stop only for acres that will not return.
    const short = r0.usableAcres === 0 || (cfg.fullBatch && r0.usableAcres < cfg.batch);
    if (short && r0.acresComing > 0) { phase = 'waiting: queued demolitions free acres'; return 'wait'; }
    if (r0.usableAcres === 0) return stopWith(`no free acres above the ${cfg.reserveAcres}-acre reserve (${r0.freeAcres} free)`);
    if (cfg.fullBatch && r0.usableAcres < cfg.batch) return stopWith(`need ${cfg.batch} free acres above the ${cfg.reserveAcres}-acre reserve for a full batch, have ${r0.usableAcres}`);
    if (cfg.fullBatch ? r0.nextBatch < cfg.batch : r0.nextBatch === 0) {
      const want = cfg.fullBatch ? cfg.batch : 1;
      const need = campCost(r0.ownedCamps, want) + r0.moneyFloor - r0.money;
      if (cfg.budget === 'income' || cfg.budget === 'floor') { phase = `waiting for income: $${fmt(need)} more`; return 'wait'; }
      return stopWith(`below cash reserve ($${fmt(r0.money)}, floor $${fmt(r0.moneyFloor)})`);
    }
    const now = Date.now();
    // Build only the camps still needed for the target (r0.cd < targetCd here); a full batch keeps its size.
    const campsToTarget = Number.isFinite(cfg.targetCd) ? Math.max(1, Math.ceil(cfg.targetCd - r0.cd)) : Infinity;
    const n = cfg.fullBatch ? r0.nextBatch : Math.min(r0.nextBatch, campsToTarget);
    const cost = n === r0.nextBatch ? r0.nextBatchCost : campCost(r0.ownedCamps, n);
    const netCost = cost - n * unitRefund();
    stats.spends = stats.spends.filter((s) => now - s.t < 60000);
    const lastMin = stats.spends.reduce((a, s) => a + s.amount, 0);
    if (lastMin > 0 && lastMin + netCost > cfg.maxSpendPerMin) { phase = 'waiting: spend limit'; return 'wait'; }

    // Build. Confirmed on the pool count; CD can be spent on research at the same time.
    phase = 'building';
    await jitter();
    if (!running) return 'stop'; // stopped during the wait; nothing sent yet
    const rb = mustRead();       // fresh baseline after the wait
    if (rb.nextBatch < n) { phase = 'waiting: money or land changed'; return 'wait'; } // the plan above no longer fits
    inFlight = { action: 'build', amount: n, at: Date.now() }; save();
    const d = send({ type: 'BuyBuilding', building: farmId(), amount: n, region: region() });
    const r1 = await waitConfirm((r) => r.unassignedCamps >= rb.unassignedCamps + n, d, read, cfg.timeoutMs + Math.ceil((n * rb.buildSec + rb.queue.build) * 1500));
    if (!r1) {
      const r = mustRead();
      const got = r.unassignedCamps - rb.unassignedCamps;
      if (got > 0) await reconcile();
      throw new Error(`build not confirmed: ${got}/${n} built, CD +${r.cd - rb.cd}`);
    }
    if (r1.cd < rb.cd + n) console.warn(`[cdFarm] CD +${r1.cd - rb.cd} after building ${n} (research spending?)`);
    // Account with the price formula; the money delta also includes passive income.
    const paid = rb.money - r1.money;
    stats.spent += cost;
    stats.built += n;
    stats.spends.push({ t: Date.now(), amount: netCost });
    inFlight = null;
    if (Math.abs(paid - cost) > Math.max(5, cost * 0.05)) {
      console.warn(`[cdFarm] money fell $${fmt(paid)}, expected ~$${fmt(cost)}`);
    }
    save();
    await pause('step');

    // Demolish
    phase = 'demolishing';
    await demolish(n);

    stats.cycles++;
    sample();
    const r2 = mustRead();
    const rt = rates(r2);
    stats.last = `#${stats.cycles} | built ${n} | CD ${fmt(r2.cd)} (+${stats.built}) | $${fmt(r2.money)} | pool ${r2.unassignedCamps} | $/CD ${perCd()}`;
    console.log('[cdFarm] ' + stats.last + (stats.cycles % 10 === 0 ? ` | ${fmtRate(rt.cdh15 ?? rt.cdhAll)} CD/h | ETA ${etaText(rt)}` : ''));
    save();
    if (stats.cycles === 1 || stats.cycles % 10 === 0) core.ledger.add('CD', 'action', stats.last);
    phase = 'running';
    await pause('cycle');
    return 'ok';
  }

  async function runLoop() {
    let reconnects = 0;
    while (running && stats.cycles < cfg.cycles) {
      try {
        const res = isAuto() ? await autoCycle() : await cycle();
        if (res === 'stop') break;
        if (res === 'wait') { save(); await pause('poll'); continue; }
        reconnects = 0;
      } catch (e) {
        if (e instanceof ConnError && reconnects < cfg.maxReconnects) {
          reconnects++;
          phase = `reconnecting (${reconnects}/${cfg.maxReconnects})`;
          console.warn(`[cdFarm] ${e.message}; ${phase}`);
          save();
          if (await waitForSocket()) {
            try { await reconcile(); } catch (e2) { console.warn('[cdFarm] cleanup failed:', e2.message); }
          }
          continue;
        }
        stopReason = 'error: ' + e.message;
        break;
      }
    }
  }

  // ---- Auto mode ---------------------------------------------------------
  // cfg.building === 'auto': core.planner picks the types and the batch every cycle from the live state
  // (see .omc/plans/cd-farm-auto-mode.md). This section only reads state, asks the planner, and sends the
  // same BuyBuilding / DemolishBuilding commands (plus BuyLand) as the manual path.

  const PACE = {
    thrifty: { mult: 0, minUnits: 4, maxHours: 24 },     // cheapest CD, slow
    balanced: { mult: 0.25, minUnits: 1, maxHours: 6 },
    fast: { mult: 1, minUnits: 1, maxHours: 1 },         // as fast as cash and acres allow
  };
  const PL = () => core.planner;
  const MIN_FLOOR_C = 10000;          // Auto never spends the last $100, whatever the other floors say
  let graceMs = 2000;                 // a timed-out Demolish gets this long to land before the retry looks again
  let waitMaxMs = 600000;             // a run waits this long for cash/items inside the run, then ends and lets Autopilot go
  // A run ends after PL().runMaxMs (15 min, shorter at high income while it holds Autopilot / Core plan) so they get their turn
  // (sales, power, resuming groups); the controller restarts it.
  let segStart = 0;                   // when this run segment began (a start or a resume): the cap counts from here, so time spent interrupted does not end a resumed run
  const ERR_COOLDOWN_MS = 300000;     // after an error stop: 5 min, doubling, off after 3 in a row
  const HIST_MS = 30 * 60 * 1000;        // window for income, organic CD, net supply
  const SAMPLE_MS = 5000;
  const BOOT_DELAY_MS = 15000;           // let the first snapshot and Autopilot settle before Auto starts itself
  const IDLE_COOLDOWN_MS = 60000;        // after a run ends, wait before starting another
  const QUARANTINE_MS = 30 * 60 * 1000;
  const BREAKER_WAIT_MS = 5 * 60 * 1000;
  // Mean of the pacer's log-normal waits is median x exp(sigma^2 / 2); used to estimate the cycle time.
  const WAIT_MEAN = Math.exp(0.55 * 0.55 / 2);

  const hist = { at: 0, money: [], cd: [], stock: {}, use: {}, slopes: {}, cum: { net: 0, farmCd: 0, items: {} } };
  const quarantine = {};                 // building id -> until (ms)
  let lastEval = null, regimeKey = null, lastDrop = '', idleNote = '', cooldownUntil = 0, bootAt = Date.now() + BOOT_DELAY_MS;
  let strikes = 0, recovering = 0, lastDry = '', lastLandLog = 0, dryCycles = 0, waitSince = 0, errStreak = 0;
  const mismatch = {};   // consecutive price/CD mismatches per type: a power bill or sale inside one confirm window is not a strike
  // Units of a type that this run built and has not demolished yet (plus the ones a Buy may still deliver late). It caps every
  // cleanup, so nothing the farm did not build (a plan Mine, your own camps) can be demolished.
  const holding = (b, d) => { const h = (stats.holding ||= {}); h[b] = Math.max(0, (h[b] ?? 0) + d); };
  const owedCap = (b, pending = inFlight) => (stats.holding?.[b] ?? 0) + (pending?.action === 'build' ? (pending.units?.find((u) => u.b === b)?.n ?? 0) : 0);

  const runBuilding = () => ((running || active || resumable) && stats.building != null ? stats.building : cfg.building);
  const activeQuarantine = () => Object.fromEntries(Object.entries(quarantine).filter(([, t]) => t > Date.now()).map(([b]) => [b, true]));

  // Light state for confirming commands: no catalog needed.
  function readPool(fresh = false) {
    const { ws, st, catalog } = core.walk(fresh);
    if (!st) return null;
    const R = region(st, catalog);
    return {
      ws, wsOpen: ws?.readyState === 1, pool: { ...(st.building_pool?.[R] ?? {}) }, money: st.items?.[MONEY] ?? 0, cd: st.items?.[CD] ?? 0,
      landBought: st.land_bought?.[R] ?? 0, mutTick: st.ssi?.last_user_mutation_tick ?? 0,
    };
  }

  // Everything the planner needs from the game state (money in cents).
  function readAuto(fresh = false) {
    const { ws, st, catalog, deals } = core.walk(fresh);
    if (!st || !catalog || !PL()) return null;
    syncIds(catalog);
    const R = region(st, catalog);   // before `running` below shadows the run flag
    const cat = PL().normalize(catalog);
    const pool = { ...(st.building_pool?.[R] ?? {}) };   // a copy: confirms compare against what it was before the command
    // The price counts every unit in every region and both queues; acres, stock, bids and recipes are this region's.
    const owned = PL().ownedAll({ st, catalog: cat }), running = new Set(), recipes = [];
    for (const g of Object.values(st.groups ?? {})) {
      if ((g.region ?? 0) !== R || g.paused) continue;
      recipes.push(g.recipe);
      for (const i of cat.recipes[g.recipe]?.inputs ?? []) running.add(i.item);
    }
    const q = PL().queued({ st, catalog: cat, region: R });
    const ra = PL().regionAcres({ st, catalog: cat, region: R });
    // Open bids per item as lots (per-unit price, amount); side 'Sell' rows are bids you can sell into.
    const bids = {};
    for (const d of deals ?? []) if (d.region === R && d.side === 'Sell' && d.amount > 0) (bids[d.item] ||= []).push({ price: d.price / d.amount, amount: d.amount });
    const unlocked = st.unlocked_buildings ?? [];
    const landBought = st.land_bought?.[R] ?? 0;
    return {
      ws, wsOpen: ws?.readyState === 1, cat, region: R, pool, owned, running, recipes, bids, unlocked, landBought, acresOwned: ra.owned, acresUsed: ra.used, queue: { build: q.build, demolish: q.demolish },
      freeAcres: ra.free, stock: st.stock?.[R] ?? {},
      money: st.items?.[MONEY] ?? 0, cd: st.items?.[CD] ?? 0, retail: unlocked.includes(RETAIL) || (owned[RETAIL] ?? 0) > 0,
      nextTech: cfg.solo ? PL().nextLockedTech({ catalog, unlocked, research: st.research, queue: st.research_queue ?? [] }) : null,
      mutTick: st.ssi?.last_user_mutation_tick ?? 0,
    };
  }

  // Items whose stock matters: the build items of every type that is not a starter.
  function watchItems(c) {
    const out = new Set();
    for (const b of Object.values(c.cat.buildings)) for (const i of b.build_items ?? []) out.add(i.item);
    return [...out];
  }

  // Rolling samples, compensated for what the farm itself spent and consumed, so the slopes are the
  // economy's own: income (cents/h), organic CD (CD/h), net supply and the farm's burn (items/h).
  function sampleHist(c) {
    const t = Date.now();
    if (t - hist.at < SAMPLE_MS) return;
    hist.at = t;
    const push = (arr, v) => { arr.push({ t, v }); while (arr.length && t - arr[0].t > HIST_MS) arr.shift(); };
    push(hist.money, c.money + hist.cum.net);
    push(hist.cd, c.cd - hist.cum.farmCd);
    for (const it of watchItems(c)) {
      push((hist.stock[it] ||= []), (c.stock[it] ?? 0) + (hist.cum.items[it] ?? 0));
      push((hist.use[it] ||= []), hist.cum.items[it] ?? 0);
    }
    const s = core.measure.slope;
    hist.slopes = { money: s(hist.money), cd: s(hist.cd) };
    for (const it of Object.keys(hist.stock)) { hist.slopes['s' + it] = s(hist.stock[it]); hist.slopes['u' + it] = s(hist.use[it]); }
  }

  // Expected seconds of one cycle with one type, and of each further type: measured round trips and
  // loop overhead (priors until 8 samples), plus the pacer's mean waits and its think pauses.
  function expectedCycle() {
    const rtt = core.measure.estimate('rtt', 350).value, over = core.measure.estimate('overhead', 250).value;
    const f = getPacer().factor;
    const pair = 2 * (500 * WAIT_MEAN * f + rtt) + over / 2;                 // one Buy and one Demolish
    const fixed = (400 + 600) * WAIT_MEAN * f + over / 2 + (4000 + 8000) / 22; // step + cycle gap + think pauses
    return { T: (pair + fixed) / 1000, perType: pair / 1000, rtt, over };
  }

  // The regime detector: a change in what is unlocked, in Retail, in the recipes that run or in the bid items
  // changes item values and candidate types. Planning is stateless so it adapts at once; this only restarts
  // the price-dependent windows and says what changed.
  function detectRegime(c, ap) {
    const sig = PL().signature({ unlocked: c.unlocked, running: c.recipes, retail: c.retail, bids: Object.keys(c.bids), phase: ap?.phase });
    const key = JSON.stringify([[...c.unlocked].sort((a, b) => a - b), c.retail]);
    if (sig === lastEval?.sig) return sig;
    if (regimeKey != null && key !== regimeKey) { hist.money.length = 0; hist.cd.length = 0; hist.slopes = {}; }
    regimeKey = key;
    return sig;
  }
  function reportDrops(plan) {
    const drops = plan.candidates.filter((x) => x.dropped && !['locked', 'no-acres'].includes(x.dropped)).map((x) => x.name + ' (' + (x.dropped === 'quarantined' ? 'quarantined' : x.dropped.split(':').slice(2).join('')) + ')').sort().join(', ');
    if (drops === lastDrop) return;
    if (lastDrop !== '' || drops !== '') core.ledger.add('CD', 'info', drops ? 'Auto: not using ' + drops : 'Auto: every unlocked type is usable again');
    lastDrop = drops;
  }

  // Item values flip when something starts using an item (Retail's furniture groups eat frames and planks) or when it
  // gets a buyer: say so once, so a type dropping out of the plan is explained.
  const lastValues = {};
  function reportValues(c, values) {
    for (const it of watchItems(c)) {
      const v = values[it] ?? 0, was = lastValues[it];
      lastValues[it] = v;
      if (was === undefined || v === was) continue;
      if ((was === 0) !== (v === 0) || v > 2 * was || was > 2 * v) {
        core.ledger.add('CD', 'info', `Auto: ${c.cat.items[it]?.name ?? 'item ' + it} is now worth $${fmt(v / 100)} each (was $${fmt(was / 100)})${c.retail ? ', Retail is open' : ''}`);
      }
    }
  }

  // Other modules that spend (Autopilot, Core plan) register with core.reserves; without any registered, fall back to Autopilot alone.
  const rsv = () => core.reserves;
  const hasProviders = () => (rsv()?.names().length ?? 0) > 0;
  const othersBusy = () => (hasProviders() ? rsv().anyBusy() : !!window.earlyGame?.busy);
  const canHold = () => hasProviders() || !!window.earlyGame?.hold;
  const holdOthers = async (who) => { if (hasProviders()) await rsv().holdAll(who); else if (window.earlyGame?.hold) await window.earlyGame.hold(who); };
  const releaseOthers = (who) => { if (hasProviders()) rsv().releaseAll(who); else window.earlyGame?.release?.(who); };
  const autopilotInfo = () => { try { return (hasProviders() ? rsv().merged() : window.earlyGame?.reserve?.()) ?? null; } catch { return null; } };

  // One look at the world: the gates, then the plan, then land. Pure apart from sampling and log lines.
  function evaluateAuto(fresh = false) {
    const c = readAuto(fresh);
    if (!c) return { idle: true, gate: 'G0', reason: 'game state or catalog not found' };
    if (!c.wsOpen) return { c, idle: true, gate: 'G0', reason: 'socket not open' };
    sampleHist(c);
    const ap = autopilotInfo();
    const sig = detectRegime(c, ap);
    const pace = PACE[cfg.pace] ?? PACE.balanced;
    const userTarget = Number.isFinite(cfg.targetCd) ? cfg.targetCd : null;
    // On its own (cfg.solo, nothing else live): the target is the cheapest tech that can start next (PL().nextLockedTech).
    const live = othersBusy(), solo = userTarget == null && !live && cfg.solo;
    const next = userTarget != null ? null : solo ? c.nextTech : ap?.nextTech;
    const need = userTarget ?? next?.cd ?? null;
    const base = { c, ap, sig, need, next, pace };
    if (userTarget == null && !live && !solo) return { ...base, idle: true, gate: 'G0', reason: 'waiting for Autopilot or Core plan to run live (or set a Target CD, or switch on Run without Autopilot)' };
    if (solo && !next) return { ...base, idle: true, gate: 'G0', reason: 'no tech can start next' };
    const g = PL().gates({ need: need ?? 0, cd: c.cd, prereqsMet: next ? next.prereqsMet !== false : true, prereqNote: next?.note || 'its prerequisites', organicCdPerHour: hist.slopes.cd ?? null, maxHours: pace.maxHours });
    if (!g.run) return { ...base, idle: true, gate: g.gate, reason: g.reason };

    // Autopilot's own floor (power bills, next purchase) or $100, plus whatever you add on top.
    const floorC = Math.max(MIN_FLOOR_C, ap?.moneyFloor ?? 0) + Math.round(cfg.autoFloor * 100);
    const income = hist.slopes.money ?? null;
    const I = pace.mult * Math.max(0, income ?? 0);
    const t = expectedCycle();
    const netSupply = {}, burn = {};
    for (const it of watchItems(c)) { const s = hist.slopes['s' + it]; if (s != null) netSupply[it] = s; burn[it] = Math.max(0, hist.slopes['u' + it] ?? 0); }
    const input = {
      catalog: c.cat, unlocked: c.unlocked, owned: c.owned, usableAcres: Math.max(0, c.freeAcres - cfg.reserveAcres), money: c.money, floor: floorC,
      stock: c.stock, reserve: ap?.items ?? {}, netSupply, burn, itemValue: PL().itemValues({ catalog: c.cat, bids: c.bids, runningInputs: [...c.running], stock: c.stock }),
      quarantine: activeQuarantine(), R: need - c.cd, T: t.T, TperType: t.perType, I, queue: c.queue, cdHave: c.cd,
      minUnits: recovering ? 1 : pace.minUnits, maxBatch: recovering ? 1 : cfg.batch, maxTypes: recovering ? 1 : cfg.maxTypes,
    };
    reportValues(c, input.itemValue);
    const plan = PL().plan(input);
    reportDrops(plan);

    // Land only matters while acres cap the batch. With no free acre at all, ask what one acre would buy. Only in Heartland: the
    // state does not show a charter's acre cap, and land is never refunded.
    let landR = { buy: 0, note: '' };
    if (c.region === 0 && (plan.binding === 'acres' || plan.wait?.reason === 'no free acres above the spare')) {
      const p2 = plan.units.length ? plan : PL().plan({ ...input, usableAcres: 1 });
      const u = p2.units[0];
      if (u) {
        // Autopilot's land wall when it is loaded; without it the payback test in PL().land decides (plus its cash floor).
        const apWall = window.earlyGame?.cfg?.maxAcrePrice;
        const wallC = cfg.land === 'plan' && apWall != null ? apWall * 100 : Infinity;
        const share = window.earlyGame?.cfg?.landCashShare ?? 0.02;   // Autopilot's own pace of land buying
        const first = PL().firstAcre(c.region);
        landR = PL().land({
          allow: cfg.land === 'plan' || cfg.land === 'off' ? cfg.land : cfg.land * 100, landBought: c.landBought, firstAcre: first, wall: wallC, paybackHours: 20,
          hoursUntilBought: (k) => (income > 0 ? PL().landCost(first, c.landBought, k) / (income * share) : Infinity),
          plan: p2, unitNeed: { cd: u.cd, acres: c.cat.buildings[u.b].acres }, R: need - c.cd, T: t.T, I, money: c.money, floor: floorC,
        });
      }
    }
    // Land is the one irreversible spend: when it is off (or not worth it), say once an hour what it would have bought.
    if (landR.note && !landR.buy && Date.now() - lastLandLog > 3600000) { lastLandLog = Date.now(); core.ledger.add('CD', 'info', 'Auto: ' + landR.note); }
    return { ...base, plan, land: landR, floorC, I, income, t };
  }

  const shuffle = (a) => { const o = [...a]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };
  const unitsText = (units) => units.map((u) => u.n + ' ' + u.name).join(' + ');

  // Right before a Buy: the state must still match the plan (nothing changed it, cash and items still hold).
  function recheck(rb, u, ev) {
    const base = rb.cat.buildings[u.b];
    if ((rb.owned[u.b] ?? 0) !== (ev.c.owned[u.b] ?? 0)) return u.name + ' count changed since the plan';
    if (rb.freeAcres - cfg.reserveAcres < base.acres * u.n) return u.name + ' has no free acres left';
    if (rb.money - PL().batchCost(base.cost, rb.owned[u.b] ?? 0, u.n) < ev.floorC) return 'money would fall below the floor';
    for (const { item, amount } of base.build_items ?? []) {
      if (!PL().itemOk({ need: u.n * amount, stock: rb.stock[item] ?? 0, reserve: ev.ap?.items?.[item] ?? 0 }).ok) return (rb.cat.items[item]?.name ?? 'an item') + ' surplus is gone';
    }
    return '';
  }

  // A price or CD that does not match the catalog: skip that type for 30 min; a second one stops the run.
  function strike(b, name, why) {
    quarantine[b] = Date.now() + QUARANTINE_MS;
    strikes++;
    core.ledger.add('CD', 'fail', `Auto: ${name}: ${why}; skipping it for 30 min`);
    if (strikes >= 2) throw new Error('prices or CD did not match the catalog twice (' + why + '): the game may have changed');
  }

  function accountBuild(u, n, owned, base) {
    const gross = PL().batchCost(base.cost, owned, n);
    const row = (stats.byType[u.b] ||= { built: 0, spent: 0, refunded: 0 });
    row.built += n; row.spent += gross / 100;
    stats.spent += gross / 100; stats.built += n * u.cd;
    hist.cum.net += gross; hist.cum.farmCd += n * u.cd;
    for (const { item, amount } of base.build_items ?? []) hist.cum.items[item] = (hist.cum.items[item] ?? 0) + n * amount;
    stats.spends.push({ t: Date.now(), amount: (gross - n * Math.floor(base.cost / 2)) / 100 });
    return gross;
  }

  async function buyLand(ev) {
    const k = ev.land.buy;
    await jitter();
    if (!running) return;
    const rb = readAuto(true);
    if (!rb) throw new ConnError('game state not found');
    // Land is never refunded: send only if nothing moved since the plan and the floor still holds.
    if (rb.region !== ev.c.region || rb.landBought !== ev.c.landBought || rb.money - ev.land.priceCents < ev.floorC) return;
    inFlight = { action: 'land', amount: k, at: Date.now() }; save();
    const d = send({ type: 'BuyLand', amount: k, region: rb.region });
    const r1 = await waitConfirm((r) => r.landBought >= rb.landBought + k, d, readPool);
    inFlight = null;
    if (!r1) throw new Error(`land purchase of ${k} acre(s) not confirmed`);
    stats.land += ev.land.priceCents / 100; stats.acresBought += k; hist.cum.net += ev.land.priceCents;
    core.ledger.add('CD', 'action', `Auto: bought ${k} acre(s) for $${fmt(ev.land.priceCents / 100)} (real cost $${fmt(ev.land.realCostCents / 100)}): ${ev.land.note}`);
    save();
    await pause('cycle');
  }

  // Demolishes `want` units of one type and confirms on the pool count. DemolishBuilding queues them (they leave the pool
  // now; each refund comes when it finishes). DemolishNow takes them out at once for ceil(CD/2) CD each.
  async function demolishUnits(b, want, type) {
    for (let attempt = 0; attempt < 2; attempt++) {
      // A Demolish that timed out may still be applied: give it time to land before looking again and retrying.
      if (attempt) await sleep(Math.max(graceMs, 4 * (core.measure.get('rtt').p90 ?? 0)));
      await jitter();
      const r0 = readPool(true);
      if (!r0) throw new ConnError('game state not found');
      // Never more than the farm holds: a first attempt that the server applied late must not make the retry eat your own buildings.
      const amt = Math.min(want, (r0.pool[b] ?? 0) - (stats.baseline?.[b] ?? 0));
      if (amt <= 0) return { ok: true, rtt: 0 };
      const d = send({ type, building: b, amount: amt, region: region() });
      if (await waitConfirm((r) => (r.pool[b] ?? 0) <= (r0.pool[b] ?? 0) - amt, d, readPool)) return { ok: true, rtt: core.lastRtt() ?? 0 };
    }
    return { ok: false, rtt: 0 };
  }

  // Three failed commands in a row, or a latency spike: clean up, wait, retry once at batch 1; a second trip stops.
  async function breakerRecover(br) {
    if (getPacer().tripCount >= 2) { stopReason = 'error: commands keep failing (' + br.reason + ')'; return 'stop'; }
    phase = 'breaker open, waiting 5 min: ' + br.reason;
    core.ledger.add('CD', 'fail', `Auto: ${br.reason}; cleaning up and pausing 5 min`);
    try { await reconcile(); } catch (e) { console.warn('[cdFarm] cleanup failed:', e.message); }
    for (let t = 0; t < BREAKER_WAIT_MS && running; t += 250) await sleep(250);   // short steps: Stop must not wait seconds for this loop
    getPacer().resetBreaker();
    recovering = 3;
    return running ? 'ok' : 'stop';
  }

  // Returns 'ok' | 'stop'.
  async function autoCycle() {
    const pace = getPacer();
    const br = pace.breaker();
    if (br.open) return breakerRecover(br);
    if (Object.values(stats.holding ?? {}).some((n) => n > 0)) await reconcileAuto(null);   // a late Buy from the last cycle
    const ev = evaluateAuto(true);
    lastEval = ev;
    if (ev.idle) return stopWith(ev.reason);
    if (netSpend() >= cfg.maxSpend) return stopWith(`reached max spend $${fmt(cfg.maxSpend)}`);
    if (Date.now() - segStart > PL().runMaxMs({ incomeCentsPerHour: ev.income, held: othersBusy() })) return stopWith('giving Autopilot its turn');
    if (cfg.dryRun) {
      // Nothing is sent, land included. Log the plan a few times, then end (a dry run must not hold Autopilot forever).
      const u = ev.plan.units;
      const line = (ev.land.buy > 0 ? ev.land.buy + ' acre(s), then ' : '') + (u.length ? `${unitsText(u)} (${fmt(ev.plan.cdTotal)} CD, $${fmt(ev.plan.netCents / 100)} net)` : 'nothing yet (' + (ev.plan.wait?.reason ?? 'no plan') + ')');
      if (line !== lastDry) { lastDry = line; console.log('[cdFarm] dry run, would build ' + line); core.ledger.add('CD', 'info', 'dry run: would build ' + line); }
      if (++dryCycles >= 3) { cfg.autoStart = false; save(); return stopWith('dry run: plan logged (Auto is off until you switch it on)'); }
      await pause('cycle'); await pause('poll');
      return 'ok';
    }
    if (ev.land.buy > 0) { waitSince = 0; await buyLand(ev); return 'ok'; }
    const units = ev.plan.units;
    if (ev.plan.wait || !units.length) {
      // Cash or items are short: wait inside the run (Autopilot stays held, so cash only grows) up to 10 min, then end it.
      const why = ev.plan.wait?.reason ?? 'nothing to build right now';
      waitSince ||= Date.now();
      if (Date.now() - waitSince > waitMaxMs) { waitSince = 0; return stopWith(why); }
      phase = 'waiting: ' + why;
      await pause('poll');
      return 'ok';
    }
    waitSince = 0;
    const net = ev.plan.netCents / 100;
    const now = Date.now();
    stats.spends = stats.spends.filter((s) => now - s.t < 60000);
    if (stats.spends.reduce((a, s) => a + s.amount, 0) + net > cfg.maxSpendPerMin && stats.spends.length) { phase = 'waiting: spend limit'; await pause('poll'); return 'ok'; }
    // Build every type of the plan (in random order), then demolish what was built.
    const t0 = hr(); acc.wait = 0; let rttSum = 0, buildWait = 0;
    phase = 'building';
    for (const u of units) if (!stats.types.includes(u.b)) stats.types.push(u.b);
    inFlight = { action: 'build', units: [], at: Date.now() }; save();
    const built = [];
    let halted = '';
    for (const u of shuffle(units)) {
      if (!running) { halted = 'stopped'; break; }
      await jitter();
      const rb = readAuto(true);
      if (!rb) throw new ConnError('game state not found');
      halted = recheck(rb, u, ev);
      if (halted) break;
      const base = rb.cat.buildings[u.b], owned = rb.owned[u.b] ?? 0;
      inFlight.units.push({ b: u.b, n: u.n }); save();   // from here on a reload or error counts these as possibly built
      const d = send({ type: 'BuyBuilding', building: u.b, amount: u.n, region: region() });
      const bw0 = hr();
      // The game charges on the Buy, but refunds of queued demolishes and income keep landing until the build is done: read the
      // charge from the first state that has applied a player command since the send (the state's own mutation tick: the game can
      // apply a Diff after the socket listener counts it). The largest single drop in cash is kept too (refunds and income only add).
      let rAck = null, step = 0, last = rb.money;
      const rdAck = (f) => {
        const r = readPool(f);
        if (!r) return r;
        if (!rAck && r.mutTick > rb.mutTick) rAck = r;
        step = Math.max(step, last - r.money); last = r.money;
        return r;
      };
      const r1 = await waitConfirm((r) => (r.pool[u.b] ?? 0) >= (rb.pool[u.b] ?? 0) + u.n, d, rdAck, cfg.timeoutMs + Math.ceil((u.n * u.build + rb.queue.build) * 1500));
      buildWait += hr() - bw0;   // the build itself is waited for, not overhead: the round trip above does not include it
      if (!r1) {
        const got = Math.max(0, (readPool(true)?.pool[u.b] ?? 0) - (rb.pool[u.b] ?? 0));
        if (got > 0) { accountBuild(u, got, owned, base); built.push({ u, got, base }); }
        holding(u.b, u.n); (stats.late ||= {})[u.b] = (stats.late[u.b] ?? 0) + (u.n - got);   // the rest may still arrive: cleanup looks again
        (stats.holdAt ||= {})[u.b] = Date.now();
        inFlight.units = inFlight.units.filter((x) => x.b !== u.b); save();
        halted = `build of ${u.n} ${u.name} not confirmed (${got} appeared)`;
        break;
      }
      const rtt = core.lastRtt();   // the Buy's round trip sits inside buildWait, so it is not added to rttSum again
      const gross = accountBuild(u, u.n, owned, base);
      built.push({ u, got: u.n, base });
      holding(u.b, u.n);
      inFlight.units = inFlight.units.filter((x) => x.b !== u.b); save();
      // F2: what the game charged and gave must match the catalog: the drop at the ack, or, when the charge landed later than the
      // ack, the largest single drop. No drop at all means the charge was not seen yet, not a wrong price.
      const rEnd = rdAck(true);
      const atAck = rAck ? rb.money - rAck.money : 0, allow = Math.max(500, gross * 0.05, Math.max(0, hist.slopes.money ?? 0) * ((rtt ?? 500) + 2000) / 3.6e6);
      const paid = Math.abs(atAck - gross) <= allow ? atAck : step, charged = atAck > 0 || step > 0;
      if (!charged) console.warn(`[cdFarm] ${u.name}: the charge did not show in the cash; price check skipped`);
      const cdGot = Math.max(r1.cd, rEnd?.cd ?? 0) - rb.cd;
      const bad = charged && Math.abs(paid - gross) > allow ? `paid $${fmt(paid / 100)}, catalog says $${fmt(gross / 100)}` : cdGot <= 0 ? 'no Construction Data came with the build' : '';
      if (!bad) mismatch[u.b] = 0;
      else if ((mismatch[u.b] = (mismatch[u.b] ?? 0) + 1) >= 2) { mismatch[u.b] = 0; strike(u.b, u.name, bad); }
      else core.ledger.add('CD', 'info', `Auto: ${u.name}: ${bad}; checking once more`);
    }
    inFlight = { action: 'demolish', units: [], at: Date.now() }; save();
    if (built.length) { phase = 'demolishing'; await pause('step'); }
    for (const x of shuffle(built)) {
      // Rushed units leave at once for ceil(CD/2) CD each, while the stock covers them; the rest queue, and their refund
      // comes when each one finishes.
      const cdNow = readPool(true)?.cd ?? 0;
      const rushN = Math.min(x.u.rush ?? 0, x.got, Math.floor(cdNow / Math.max(1, x.u.rushEach)));
      const q = x.got > rushN ? await demolishUnits(x.u.b, x.got - rushN, 'DemolishBuilding') : { ok: true, rtt: 0 };
      const r = rushN ? await demolishUnits(x.u.b, rushN, 'DemolishNow') : { ok: true, rtt: 0 };
      if (!q.ok || !r.ok) throw new Error(`demolish of ${x.got} ${x.u.name} not confirmed`);
      rttSum += q.rtt + r.rtt;
      holding(x.u.b, -x.got); save();
      const refund = Math.floor(x.base.cost / 2) * x.got;
      stats.refunded += refund / 100; stats.byType[x.u.b].refunded += refund / 100; hist.cum.net -= refund;
      if (rushN) {
        const spent = rushN * x.u.rushEach;
        stats.rushCd = (stats.rushCd ?? 0) + spent;
        hist.cum.farmCd -= spent;   // CD spent on rushing is not farm output: keep the organic CD slope clean
      }
    }
    inFlight = null;
    if (halted && halted !== 'stopped') { phase = 'waiting: ' + halted; core.ledger.add('CD', 'info', 'Auto: ' + halted); }
    if (halted) { await pause('poll'); await reconcileAuto(null); }   // a Buy that confirms late must not stay in the pool

    if (!built.length) await pause('poll');   // nothing could be built (state moved): do not spin
    if (built.length) {
      stats.cycles++; sample();
      const wall = hr() - t0;
      core.measure.get('cycle').add(wall);
      core.measure.get('overhead').add(Math.max(0, wall - acc.wait - rttSum - buildWait));
      const r2 = readPool();
      stats.last = `#${stats.cycles} | ${built.map((x) => x.got + ' ' + x.u.name).join(' + ')} | CD ${fmt(r2?.cd ?? 0)} (+${fmt(stats.built)}) | $${fmt((r2?.money ?? 0) / 100)} | $/CD ${perCd()}`;
      console.log('[cdFarm] ' + stats.last);
      if (stats.cycles === 1 || stats.cycles % 10 === 0) core.ledger.add('CD', 'action', stats.last);
      if (recovering) recovering--;
    }
    save();
    phase = 'running';
    await pause('cycle');
    return 'ok';
  }

  // Demolish whatever an interrupted Auto run still holds above its baseline; count a build that was not accounted.
  async function reconcileAuto(pending) {
    const rp = readPool();
    const c = readAuto();
    if (!rp || !c) return;
    const types = new Set([...(stats.types ?? []), ...(pending?.units ?? []).map((u) => u.b)]);
    for (const b of types) {
      // A Buy that has not shown up in 2 minutes is not coming: forget it, so the cap cannot reach buildings you add later.
      if ((stats.holding?.[b] ?? 0) > 0 && (rp.pool[b] ?? 0) - (stats.baseline?.[b] ?? 0) <= 0 && Date.now() - (stats.holdAt?.[b] ?? 0) > 120000) { stats.holding[b] = 0; if (stats.late) stats.late[b] = 0; }
      const extra = Math.min((rp.pool[b] ?? 0) - (stats.baseline?.[b] ?? 0), owedCap(b, pending));
      if (extra <= 0) continue;
      const base = c.cat.buildings[b];
      const unaccounted = pending?.action === 'build' ? (pending.units.find((u) => u.b === b)?.n ?? 0) : 0;
      if (unaccounted) {
        const n = Math.min(extra, unaccounted);
        const row = (stats.byType[b] ||= { built: 0, spent: 0, refunded: 0 });
        const gross = PL().batchCost(base.cost, (c.owned[b] ?? 0) - n, n);
        row.built += n; row.spent += gross / 100; stats.spent += gross / 100; stats.built += n * PL().cdOf(c.cat, b); hist.cum.net += gross;
      }
      const late = Math.min(extra - unaccounted, stats.late?.[b] ?? 0);   // a Buy that confirmed after the timeout: now it counts as built
      if (late > 0) {
        const row = (stats.byType[b] ||= { built: 0, spent: 0, refunded: 0 });
        const gross = PL().batchCost(base.cost, (c.owned[b] ?? 0) - late, late);
        row.built += late; row.spent += gross / 100; stats.spent += gross / 100; stats.built += late * PL().cdOf(c.cat, b); hist.cum.net += gross;
        stats.late[b] -= late;
      }
      console.log(`[cdFarm] cleanup: demolishing ${extra} leftover ${base.name}`);
      await jitter();
      const d = send({ type: 'DemolishBuilding', building: b, amount: extra, region: region() });
      const r1 = await waitConfirm((r) => (r.pool[b] ?? 0) <= (rp.pool[b] ?? 0) - extra, d, readPool);
      if (!r1) throw new Error(`cleanup demolish of ${extra} ${base.name} not confirmed`);
      const refund = Math.floor(base.cost / 2) * extra;
      stats.refunded += refund / 100; hist.cum.net -= refund;
      if (stats.byType[b]) stats.byType[b].refunded += refund / 100;
      holding(b, -extra);
    }
    save();
  }

