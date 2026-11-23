// Offline check that the Autopilot module of ic-autopilot.user.js plays wiki/guides/early-game-plan.md from a brand-new corp.
//
//   bun test/early-game-sim.js                 # rich: live board + asks for every kit part
//   bun test/early-game-sim.js live 16         # only the sellers on the saved live board
//   bun test/early-game-sim.js chaos 30        # rich + dropped commands, deal churn,
//                                                      #   a cash shock that pauses groups, a disconnect
//   bun test/early-game-sim.js patched 40      # build-and-demolish patched: booster must switch off
//   bun test/early-game-sim.js nobooster 40    # cfg.cdBooster = false
//   bun test/early-game-sim.js cdfarm 40       # cfg.boosterVia = 'cdFarm' with a stand-in CD Farm
//   bun test/early-game-sim.js all 44          # every scenario, summary only
//
// Uses the real catalog and deal board saved from the page (live-board.json) and the script's
// own snapshot()/decide()/report(). The engine models wiki/mechanics/formulas.md: building cost, CD on
// build, default floor kits (no free kits), research time, courier (10 s turnaround, 2 min
// transit, 10,000 CU, 1 Logistics Data per full load), $10/MW per 10 min bills (unpaid →
// powered groups pause, service drops), 1 run per building per recipe time.

const fs = require('fs');
const path = require('path');

const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'live-board.json'), 'utf8'));
// Floor pieces (machines + belts) for parts lists; saved from the page with the account's designs.
const floorState = JSON.parse(fs.readFileSync(path.join(__dirname, 'floor-state.json'), 'utf8'));
board.catalog.machines = floorState.machines;
board.catalog.belts = floorState.belts;
// The merged userscript holds the shared core, CD Farm, then Autopilot; the sim runs the core and the Autopilot module.
const full = fs.readFileSync(path.join(__dirname, '..', 'ic-autopilot.user.js'), 'utf8');
const coreSrc = full.slice(full.indexOf('// @@MODULE core'), full.indexOf('// @@END core'));
const src = coreSrc + '\n' + full.slice(full.indexOf('// @@MODULE early-game'));

function run(scenario, HOURS, quiet) {
  globalThis.earlyGame = undefined;
  globalThis.cdFarm = undefined;
  globalThis.idleCore?._unload?.();
  globalThis.idleCore = undefined;
  (0, eval)(src);
  if (!globalThis.earlyGame) throw new Error('Autopilot module failed to load (see the "[IdleCorp] Autopilot failed to load" error above)');
  const core = globalThis.earlyGame._core;
  const C = core.normalize(board.catalog);
  const chaos = scenario === 'chaos';
  const patched = scenario === 'patched';            // build-and-demolish no longer pays: no refund, CD taken back
  if (scenario === 'nobooster') globalThis.earlyGame.cfg.cdBooster = false;
  let demolishes = 0;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  // ---- market -------------------------------------------------------------
  let deals = board.deals.filter((d) => d.region === 0).map((d) => ({ ...d }));
  const orders = (board.orders || []).filter((o) => o.region === 0).map((o) => ({ ...o, poster: -1 }));
  let nextDeal = 9e9;
  const addAsk = (item) => {
    const base = C.items[item].base_value;
    deals.push({ id: nextDeal++, item, side: 'Buy', region: 0, amount: 100000, price: Math.round(base * 1.2) * 100000, expires_at: 1e12 });
  };
  const KIT_ITEMS = [1, 2, 3, 6, 9, 10];
  if (scenario !== 'live') for (const item of KIT_ITEMS) addAsk(item); // live: only the saved board's sellers

  // ---- state --------------------------------------------------------------
  const st = {
    ssi: { corp_id: 999, last_user_mutation_tick: 0 },
    items: { 0: 10000, 24: 0, 111: 0 },
    stock: { 0: {} }, groups: {}, building_pool: { 0: {} }, next_group_id: 0,
    research: null, research_queue: [], unlocked_buildings: [],
    shipments: [], next_shipment_id: 0, courier_ready_at: 0,
    subscriptions: { 0: { power: 0 } }, standing_fills: {}, land_bought: { 0: 0 },
    layouts: {}, designs: {},   // a fresh corp: default plans everywhere, no saved designs
  };
  const floorSwitches = [];
  const sold = {};   // item name → units sold by the script (auto-ship not included)
  // The sim has no game scorer: a layout's rate is the library rate the script expects (meta.rate),
  // recorded when the action is applied. Default plans are x1 (checked live).
  let pendingRate = 1;
  const layoutRate = () => pendingRate;
  let courierRejects = 0;
  let postedOrders = 0, shockAt = -1e9, minPowered = Infinity, userGroup = null, userKeptUntilResume = null;
  let tick = 1, soldWood = false, minMoney = Infinity, pausedByBill = 0, dropped = 0, offlineUntil = 0;
  const stock = st.stock[0];
  const add = (item, n) => { stock[item] = (stock[item] ?? 0) + n; };
  const has = (item) => stock[item] ?? st.items[item] ?? 0;
  const take = (item, n) => { if (stock[item] !== undefined || st.items[item] === undefined) add(item, -n); else st.items[item] -= n; };
  const FRAME_W = { 41: 2, 42: 4, 43: 8, 44: 16, 45: 32, 74: 64, 75: 128 };
  const owned = (b) => Object.values(st.groups).filter((g) => g.building === b).reduce((a, g) => a + g.count, 0) + (st.building_pool[0][b] ?? 0);
  const firstStepsDone = () => soldWood && owned(4) >= 1;
  const acres = () => {
    let a = 0;
    for (const g of Object.values(st.groups)) a += C.buildings[g.building].acres * g.count;
    for (const [b, n] of Object.entries(st.building_pool[0])) a += C.buildings[+b].acres * n;
    return a;
  };
  const acrePrice = (n) => { let p = 5000; for (let i = 0; i < n; i++) p = Math.floor(p * 41 / 40); return p; };
  const fmtT = (t) => { const m = Math.floor(t / 120); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`; };
  const errors = [];
  const err = (m) => { errors.push(`t=${fmtT(tick)} ${m}`); return false; };

  function ship(item, amount, money, inbound) {
    st.shipments.push({ id: st.next_shipment_id++, item, amount: inbound ? amount : 0, money, remaining: 240, inbound });
    st.courier_ready_at = tick + 20;
  }

  // Applies a command like the server. Rejections are silent on the real server; here they are
  // recorded so a script bug (sending something invalid) shows up.
  function apply(m) {
    switch (m.type) {
      case 'BuyBuilding': {
        const b = C.buildings[m.building];
        const cost = Math.round(b.cost * (20 + owned(m.building)) / 20);
        if (st.items[0] < cost) return err(`BuyBuilding ${b.name}: not enough money`);
        if (acres() + b.acres > 25 + st.land_bought[0]) return err(`BuyBuilding ${b.name}: no land`);
        if (!(m.building === 0 || m.building === 10 || st.unlocked_buildings.includes(m.building))) return err(`BuyBuilding ${b.name}: locked`);
        for (const i of b.build_items) if (has(i.item) < i.amount) return err(`BuyBuilding ${b.name}: missing ${C.items[i.item].name}`);
        for (const i of b.build_items) take(i.item, i.amount);
        st.items[0] -= cost;
        st.building_pool[0][m.building] = (st.building_pool[0][m.building] ?? 0) + 1;
        st.items[24] += Math.max(1, b.build_items.reduce((a, i) => a + i.amount * (FRAME_W[i.item] ?? 0), 0));
        return true;
      }
      case 'CreateGroup': {
        const p = st.building_pool[0];
        if ((p[m.building] ?? 0) < m.amount) return err('CreateGroup: not in pool');
        p[m.building] -= m.amount;
        st.groups[st.next_group_id++] = { building: m.building, count: m.amount, equipped: 0, recipe: null, name: m.name, paused: false, acc: 0 };
        return true;
      }
      case 'AssignBuildings': {
        const g = st.groups[m.group], p = st.building_pool[0];
        if (!g || (p[g.building] ?? 0) < m.amount) return err('Assign: not in pool');
        p[g.building] -= m.amount; g.count += m.amount; return true;
      }
      case 'SetRecipe': {
        const r = C.recipes[m.recipe];
        if (!st.groups[m.group] || r.building !== st.groups[m.group].building) return err('SetRecipe: wrong building');
        st.groups[m.group].recipe = m.recipe; return true;
      }
      case 'DemolishBuilding': {
        const p = st.building_pool[0];
        if ((p[m.building] ?? 0) < m.amount) return err('Demolish: not in pool');
        p[m.building] -= m.amount;
        demolishes++;
        if (patched) st.items[24] -= m.amount;
        else st.items[0] += Math.floor(C.buildings[m.building].cost / 2) * m.amount; // 50% of base, cash only
        return true;
      }
      case 'SetPaused': st.groups[m.group].paused = m.paused; return true;
      case 'BuyLand': {
        let c = 0; for (let i = 0; i < m.amount; i++) c += acrePrice(st.land_bought[0] + i);
        if (st.items[0] < c) return err('BuyLand: money');
        st.items[0] -= c; st.land_bought[0] += m.amount; return true;
      }
      case 'SetSubscription': if (m.level > 200) return err('power over cap'); st.subscriptions[0].power = m.level; return true;
      case 'StartTech': {
        if (st.research) return err('StartTech while busy');
        const t = C.techs.find((x) => x.building === m.building);
        const b = C.buildings[m.building];
        if (t.requires != null && !st.unlocked_buildings.includes(t.requires)) return err(`StartTech ${b.name}: prerequisite`);
        if (st.items[24] < t.cost) return err('StartTech: CD');
        for (const i of b.build_items) if (has(i.item) < i.amount) return err(`StartTech ${b.name}: missing ${C.items[i.item].name}`);
        st.items[24] -= t.cost;
        for (const i of b.build_items) take(i.item, i.amount);
        st.research = { building: m.building, remaining: t.ticks };
        return true;
      }
      case 'FillDeal': case 'FillOrder': {
        if (tick < st.courier_ready_at) { courierRejects++; return false; } // silently ignored, like the server
        const d = m.type === 'FillDeal' ? deals.find((x) => x.id === m.deal) : orders.find((x) => x.id === m.order);
        if (!d) return false; // deal gone (filled by someone else): silently ignored, like the server
        const unit = m.type === 'FillDeal' ? d.price / d.amount : d.unit_price * 1.02;
        const cu = C.items[d.item].cargo_weight * m.amount;
        if (cu > 10000) return err(`${m.type}: over courier CU`);
        const playerSells = m.type === 'FillDeal' ? d.side === 'Sell' : d.side === 'Buy';
        if (playerSells) {
          if (has(d.item) < m.amount) return err(`${m.type}: not enough ${C.items[d.item].name}`);
          if (d.item === 9 || d.item === 41 || d.item === 42) err(`sold ${C.items[d.item].name}!`);
          take(d.item, m.amount);
          sold[C.items[d.item].name] = (sold[C.items[d.item].name] ?? 0) + m.amount;
          if (d.item === 1) soldWood = true;
          st.items[111] += Math.floor((cu + C.items[d.item].cargo_weight) / 10000);
          ship(d.item, m.amount, Math.floor(unit * m.amount), false);
        } else {
          const cost = Math.ceil(unit * m.amount);
          if (st.items[0] < cost) return err(`${m.type}: money`);
          st.items[0] -= cost;
          ship(d.item, m.amount, 0, true);
        }
        return true;
      }
      case 'PostOrder': {
        const cost = Math.ceil(m.unit_price * m.amount * 1.02);
        if (m.side !== 'Buy' || st.items[0] < cost) return err('PostOrder: money/side');
        st.items[0] -= cost; // escrow
        orders.push({ id: nextDeal++, poster: 999, side: 'Buy', item: m.item, amount: m.amount, unit_price: m.unit_price, region: 0, postedAt: tick });
        postedOrders++;
        return true;
      }
      case 'EditLayout': {
        // Every building on the task is charged the added pieces; removed pieces come back at half.
        const r = C.recipes[m.recipe];
        const n = Object.values(st.groups).filter((g) => g.recipe === m.recipe).reduce((a, g) => a + g.count, 0);
        const oldBom = Object.fromEntries((st.layouts[m.recipe]?.bom ?? C.buildings[r.building].default_kit ?? []).map((i) => [i.item, i.amount]));
        const newBom = core.bomOf({ catalog: C }, m.cells);
        for (const [i, a] of Object.entries(newBom)) if (has(+i) < Math.max(0, a - (oldBom[i] ?? 0)) * n) return err(`EditLayout ${r.name}: missing ${C.items[i].name}`);
        for (const [i, a] of Object.entries(newBom)) take(+i, Math.max(0, a - (oldBom[i] ?? 0)) * n);
        for (const [i, a] of Object.entries(oldBom)) add(+i, Math.floor(Math.max(0, a - (newBom[i] ?? 0)) * n / 2));
        st.layouts[m.recipe] = { cells: m.cells, fx: { rate: layoutRate(m.recipe, m.cells) }, bom: Object.entries(newBom).map(([item, amount]) => ({ item: +item, amount })) };
        floorSwitches.push(`${fmtT(tick)} ${r.name} → x${st.layouts[m.recipe].fx.rate}`);
        return true;
      }
      case 'KeepFilling':
        if (firstStepsDone() && Object.keys(st.standing_fills).length === 0) st.standing_fills[m.deal] = { region: 0 };
        return true;
      default: return err('unknown ' + m.type);
    }
  }

  // ---- engine -------------------------------------------------------------
  const DT = 20; // ticks per step (10 s)
  function step() {
    for (const g of Object.values(st.groups)) {
      const kit = st.layouts[g.recipe]?.bom ?? C.buildings[g.building].default_kit ?? [];
      while (g.equipped < g.count && kit.every((k) => has(k.item) >= k.amount)) { for (const k of kit) take(k.item, k.amount); g.equipped++; }
    }
    const need = Object.values(st.groups).filter((g) => !g.paused).reduce((a, g) => a + (C.buildings[g.building].draws?.power ?? 0) * g.count, 0);
    const powered = st.subscriptions[0].power >= need;
    for (const g of Object.values(st.groups)) {
      if (g.recipe == null || !g.equipped || g.paused) continue;
      if ((C.buildings[g.building].draws?.power ?? 0) > 0 && !powered) continue;
      const r = C.recipes[g.recipe];
      let runs = g.equipped * (st.layouts[g.recipe]?.fx?.rate ?? 1) * DT / r.ticks + g.acc;
      for (const i of r.inputs) runs = Math.min(runs, has(i.item) / i.amount);
      const whole = Math.floor(runs);
      g.acc = Math.min(runs - whole, 1);
      for (const i of r.inputs) take(i.item, i.amount * whole);
      for (const o of r.outputs) add(o.item, o.amount * whole);
    }
    // Assumption: another player fills our buy orders 45 min after posting.
    for (let i = orders.length - 1; i >= 0; i--) {
      const o = orders[i];
      if (o.poster === 999 && tick - o.postedAt >= 5400) { add(o.item, o.amount); orders.splice(i, 1); }
    }
    if (st.research) {
      st.research.remaining -= DT;
      if (st.research.remaining <= 0) { st.unlocked_buildings.push(st.research.building); st.research = null; }
    }
    for (const s of st.shipments) { s.remaining -= DT; if (s.remaining <= 0) { if (s.inbound) add(s.item, s.amount); else st.items[0] += s.money; } }
    st.shipments = st.shipments.filter((s) => s.remaining > 0);
    const fill = Object.keys(st.standing_fills)[0];
    if (fill && tick >= st.courier_ready_at && tick >= offlineUntil) {
      const d = deals.find((x) => String(x.id) === fill);
      if (!d) delete st.standing_fills[fill];
      else {
        const n = Math.min(Math.floor(has(d.item)), Math.floor(10000 / C.items[d.item].cargo_weight));
        if (n > 0) { take(d.item, n); ship(d.item, n, Math.floor(d.price / d.amount * n), false); }
      }
    }
    if (chaos) {
      if (tick % 3600 < DT) { // every 30 min: a third of the asks/bids disappear, replacements appear
        const gone = deals.filter(() => rand() < 0.33).map((d) => d.id);
        deals = deals.filter((d) => !gone.includes(d.id));
        for (const item of KIT_ITEMS) if (!deals.some((d) => d.item === item && d.side === 'Buy')) addAsk(item);
        for (const d of board.deals) if (d.region === 0 && d.side === 'Sell' && !deals.some((x) => x.item === d.item && x.side === 'Sell')) deals.push({ ...d, id: nextDeal++ });
        for (const id of Object.keys(st.standing_fills)) if (!deals.some((d) => String(d.id) === id)) delete st.standing_fills[id];
      }
      for (const h of [7, 12]) if (tick >= 7200 * h && tick < 7200 * h + DT) { st.items[0] = 0; shockAt = tick; } // cash shocks right before a bill
      if (tick >= 7200 * 10 && tick < 7200 * 10 + DT) {   // you pause a Workshop group by hand
        const g = Object.entries(st.groups).find(([, x]) => x.building === 8);
        if (g) { g[1].paused = true; userGroup = +g[0]; } // a click in the game UI: the script isn't told
      }
      if (tick >= 7200 * 20 && tick < 7200 * 20 + DT && userGroup != null) { // ...and resume it yourself 10 h later
        userKeptUntilResume = st.groups[userGroup].paused;
        st.groups[userGroup].paused = false;
      }
      if (tick >= 7200 * 3 && tick < 7200 * 3 + DT) offlineUntil = tick + 2400;               // 20 min disconnect at 3h
      if (tick % 1800 < DT) st.courier_ready_at = Math.max(st.courier_ready_at, tick + 240);    // every 15 min: a 2 min freight cooldown
    }
    if (tick % 1200 < DT) {
      const bill = st.subscriptions[0].power * 1000;
      if (bill > st.items[0]) {           // unpaid: service stops, powered groups pause
        pausedByBill++;
        st.subscriptions[0].power = 0;
        for (const g of Object.values(st.groups)) if ((C.buildings[g.building].draws?.power ?? 0) > 0) g.paused = true;
      } else st.items[0] -= bill;
    }
    minMoney = Math.min(minMoney, st.items[0]);
    if (st.subscriptions[0].power > 0 && tick - shockAt > 3600) minPowered = Math.min(minPowered, st.items[0]);
    tick += DT;
  }

  // ---- run ----------------------------------------------------------------
  core.setClock(() => tick * 500);
  const milestones = new Map();
  const mark = (k, cond) => { if (cond && !milestones.has(k)) milestones.set(k, fmtT(tick)); };
  const waits = new Map();
  const hourly = [];
  let actions = 0;
  // cdfarm: a stand-in for the CD Farm module of ic-autopilot.user.js. start() runs Lumber Camp build+demolish cycles with
  // the options Autopilot passes (target CD, cash floor, batch, spare acres) and reports running
  // until the next decision round, like the real one that Autopilot then waits for.
  let farmRuns = 0, farmBuilt = 0, farmStopNext = false;
  if (scenario === 'cdfarm') {
    globalThis.earlyGame.cfg.boosterVia = 'cdFarm';
    const farm = globalThis.cdFarm = {
      running: false, active: false, resumable: false, stats: { baselinePool: 0 },
      start(o) {
        if (farm.running) return;
        farm.running = true; farmRuns++; farmStopNext = true;
        farm.stats.baselinePool = st.building_pool[0][0] ?? 0;
        const base = C.buildings[0].cost;
        while ((st.items[24] ?? 0) < o.targetCd) {
          const free = core.snapshot(st, C, deals, orders, tick).freeAcres - o.reserveAcres;
          let n = 0, cost = 0;
          const own = owned(0);
          while (n < Math.min(o.batch, free) && st.items[0] - cost - Math.round(base * (20 + own + n) / 20) >= o.minMoney * 100) { cost += Math.round(base * (20 + own + n) / 20); n++; }
          if (n < 1) break;
          const before = errors.length;
          let got = 0; // the sim engine builds one per BuyBuilding
          while (got < n && apply({ type: 'BuyBuilding', building: 0, amount: 1, region: 0 })) got++;
          if (got) apply({ type: 'DemolishBuilding', building: 0, amount: got, region: 0 });
          farmBuilt += got;
          if (errors.length > before) break;
        }
      },
    };
  }
  const grp = (b, r) => Object.values(st.groups).filter((x) => x.building === b && (r == null || x.recipe === r));
  const running = (b, r) => grp(b, r).some((x) => x.equipped > 0 && !x.paused);

  globalThis.earlyGame.cfg.dryRun = false; // the stall watchdog only judges live runs
  { const bad = core.checkGame(core.snapshot(st, C, deals, orders, 0)); if (bad.length) err('checkGame: ' + bad.join('; ')); }
  let stallAlerts = 0, wasStalled = false;
  const end = HOURS * 7200;
  while (tick < end) {
    if (farmStopNext) { globalThis.cdFarm.running = false; farmStopNext = false; }
    if (tick >= offlineUntil) {
      core.observe(core.snapshot(st, C, deals, orders, tick));
      for (let i = 0; i < 10; i++) {
        const seen = chaos && rand() < 0.3 ? tick + 30 : tick;   // chaos: tick estimate runs 15 s early
        const snap = core.snapshot(st, C, deals, orders, seen);
        const a = core.decide(snap);
        core.watchStall(snap, !a.wait && !/^(fill|autoship):/.test(a.key ?? ''));
        if (core.stalledNow() && !wasStalled) stallAlerts++;
        wasStalled = !!core.stalledNow();
        if (a.wait) { const k = a.wait.replace(/[\d$,.∞]+/g, '#'); waits.set(k, (waits.get(k) ?? 0) + 1); break; }
        let ok = true, done = 0;
        if (a.call) { ok = !!a.call(); done = ok ? 1 : 0; }
        for (const stp of a.steps) {
          if (chaos && rand() < 0.1) { dropped++; ok = false; break; } // command lost
          const before = errors.length;
          pendingRate = a.meta?.rate ?? 1;
          apply(stp.msg);
          st.ssi.last_user_mutation_tick = tick;
          if (errors.length > before) { ok = false; break; }
          if (!stp.until(core.snapshot(st, C, deals, orders, tick))) { ok = false; break; } // optional or not: back off
          done++;
        }
        core.finish(a, ok, done, core.snapshot(st, C, deals, orders, tick), ok ? '' : 'sim: not applied');
        actions++;
      }
    }
    mark('P1 Lumber Camp + Farm', owned(0) >= 1 && owned(10) >= 1);
    mark('P2 Sawmill unlocked', st.unlocked_buildings.includes(4));
    mark('P2 Sawmill running', running(4));
    mark('P2 First Steps → auto-ship', Object.keys(st.standing_fills).length > 0);
    mark('P2 25 acres full', acres() >= 25);
    mark('P3 3 Sawmills', owned(4) >= 3);
    mark('P3 Workshop unlock started', st.research?.building === 8 || st.unlocked_buildings.includes(8));
    mark('P4 Workshop running', running(8, 37));
    mark('P4 2 Workshops', grp(8, 37).reduce((a, x) => a + x.count, 0) >= 2);
    mark('P4 Mine unlocked', st.unlocked_buildings.includes(1));
    mark('P4 4 Iron + 2 Coal Mines', grp(1, 1).reduce((a, x) => a + x.count, 0) >= 4 && grp(1, 2).reduce((a, x) => a + x.count, 0) >= 2);
    mark('P4 Quarry built', owned(2) >= 1);
    mark('P4 1st Gold Mine', grp(1, 95).length > 0);
    mark('P4 Smelter running', running(5, 9));
    mark('P5 Iron Frame Workshop running', running(8, 38));
    mark('P5 1st Iron Frame', has(42) > 0 || st.unlocked_buildings.includes(6));
    mark('P5 Factory unlocked', st.unlocked_buildings.includes(15));
    mark('P5 Kiln unlocked', st.unlocked_buildings.includes(6));
    mark('P5 Paper Mill unlocked', st.unlocked_buildings.includes(23));
    mark('P5 Manufacturing Lab unlocked', st.unlocked_buildings.includes(14));
    mark('P5 Kiln built', owned(6) >= 1);
    mark('P5 Lab built', owned(14) >= 1);
    mark('P5 all plan unlocks done', core.phaseOf(core.snapshot(st, C, deals, orders, tick)) === 'done');
    if (tick % 7200 < DT && tick > 1) {
      hourly.push({ t: fmtT(tick), money: Math.round(st.items[0] / 100), cd: st.items[24], bld: Object.values(st.groups).reduce((a, x) => a + x.count, 0),
        acres: `${acres()}/${25 + st.land_bought[0]}`, planks: Math.floor(has(9)), wf: Math.floor(has(41)), sheets: Math.floor(has(10)), if: Math.floor(has(42)), mw: st.subscriptions[0].power });
    }
    step();
  }

  const s = core.snapshot(st, C, deals, orders, tick);
  const result = { stallAlerts, scenario, hours: HOURS, courierRejects, woodSold: sold.Wood ?? 0, floorSwitches, postedOrders, demolishes, actions, errors, milestones, phase: core.phaseOf(s), minMoney, minPowered, userKept: userGroup == null ? '—' : (userKeptUntilResume ?? st.groups[userGroup].paused) ? 'yes' : 'NO', pausedByBill, dropped, stillPaused: Object.values(st.groups).filter((g) => g.paused).length, farmRuns, farmBuilt };
  if (!quiet) {
    if (scenario === 'cdfarm') console.log(`CD Farm stand-in: ${farmRuns} runs started by Autopilot, ${farmBuilt} camps built + demolished`);
    console.log(`\n=== ${scenario}, ${HOURS} h: ${actions} actions, ${errors.length} script errors, phase ${result.phase}` +
      `, lowest cash $${(minMoney / 100).toFixed(2)} (while powered $${(minPowered / 100).toFixed(2)}), your paused group kept: ${result.userKept}, bill pauses ${pausedByBill}, dropped commands ${dropped}, groups still paused ${result.stillPaused}`);
    console.table(Object.fromEntries(milestones));
    console.table(hourly.filter((_, i) => i % 2 === 1 || hourly.length < 14));
    console.table(Object.fromEntries(core.checklist(s)));
    console.log('Sold by the script:', Object.entries(sold).sort((a, z) => z[1] - a[1]).map(([n, a]) => `${n} ${a.toLocaleString('en-US')}`).join(', '));
    console.log('Floorplan switches:', floorSwitches.length ? floorSwitches.join(' | ') : 'none');
    console.table(core.floorTable(s));
    console.log('Most common waits:');
    console.table([...waits.entries()].sort((a, z) => z[1] - a[1]).slice(0, 8).map(([w, n]) => ({ wait: w.slice(0, 120), steps: n })));
    if (errors.length) { console.log('Errors (first 15):'); for (const e of errors.slice(0, 15)) console.log('  ' + e); }
    const last = core.decide(s);
    console.log('Next decision:', last.wait ? 'wait — ' + last.wait : last.reason);
    const idle = core.decide(core.snapshot(st, C, deals, orders, 0)); // courier treated busy: shows what else is pending
    console.log('Without selling:', idle.wait ? idle.waits : idle.reason);
  }
  return result;
}

const scenario = process.argv[2] || 'rich';
const hours = Number(process.argv[3] || (scenario === 'live' ? 16 : 30));
if (scenario === 'all') {
  const results = ['rich', 'live', 'chaos', 'patched', 'nobooster', 'cdfarm'].map((sc) => run(sc, hours, true));
  const rows = results.map((r) => ({
    scenario: r.scenario, phase: r.phase, 'courier misses': r.courierRejects, 'wood sold': r.woodSold, floors: r.floorSwitches.length, 'buy orders': r.postedOrders, demolishes: r.demolishes, errors: r.errors.length, actions: r.actions,
    'lowest $ powered': r.minPowered === Infinity ? '—' : (r.minPowered / 100).toFixed(0), 'bill pauses': r.pausedByBill, 'paused at end': r.stillPaused, 'your pause kept': r.userKept,
    'Smelter running': r.milestones.get('P4 Smelter running') ?? '—', 'Lab unlocked': r.milestones.get('P5 Manufacturing Lab unlocked') ?? '—',
    ...(r.scenario === 'cdfarm' ? { 'CD Farm runs': r.farmRuns } : {}),
  }));
  console.table(rows);
  console.log('stall alerts: ' + results.map((r) => r.scenario + '=' + r.stallAlerts).join(' '));
  process.exitCode = rows.some((r) => r.errors) ? 1 : 0;
} else {
  const r = run(scenario, hours, false);
  process.exitCode = r.errors.length ? 1 : 0;
}