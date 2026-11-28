// continues the core closure from core-2.js (same try / IIFE)
// ---- reserves: what each spending module keeps back, shared by CD Farm Auto --------------------------------------
// A provider is { reserve(): { moneyFloor (cents), items: {id: n}, nextTech, phase } | null, busy(): bool, hold?(who): Promise, release?(who) }.
// Autopilot registers itself; Core plan registers its own. CD Farm reads the merged view instead of asking Autopilot alone:
// money floor = the highest, item reserves add up (Infinity stays Infinity), the first provider with a next unlock wins.
const reserveProviders = new Map();
const reserves = {
  register(name, p) { reserveProviders.set(String(name), p); return () => { if (reserveProviders.get(String(name)) === p) reserveProviders.delete(String(name)); }; },
  unregister(name) { reserveProviders.delete(String(name)); },
  names: () => [...reserveProviders.keys()],
  anyBusy() { for (const p of reserveProviders.values()) { try { if (p.busy?.()) return true; } catch (e) { console.error(e); } } return false; },
  merged() {
    let any = false, moneyFloor = 0, nextTech = null, phase = null;
    const items = {}, by = {};
    for (const [name, p] of reserveProviders) {
      let r = null;
      try { r = p.reserve?.() ?? null; } catch (e) { console.error(e); }
      if (!r) continue;
      any = true; by[name] = r;
      moneyFloor = Math.max(moneyFloor, r.moneyFloor ?? 0);
      for (const [i, n] of Object.entries(r.items ?? {})) items[i] = (items[i] ?? 0) + n;
      nextTech ||= r.nextTech ?? null;
      if (phase == null && r.phase != null) phase = r.phase;
    }
    return any ? { moneyFloor, items, nextTech, phase, by } : null;
  },
  // Every provider pauses after its current step (CD Farm takes its baseline of unassigned buildings after this).
  // `except` names a provider that must not be held (a module holding the others while it spends must not wait for itself).
  async holdAll(who, except) { await Promise.all([...reserveProviders].filter(([n]) => n !== except).map(async ([, p]) => { try { await p.hold?.(who); } catch (e) { console.error(e); } })); },
  releaseAll(who, except) { for (const [n, p] of reserveProviders) { if (n === except) continue; try { p.release?.(who); } catch (e) { console.error(e); } } },
};

// ---- saved floor designs shared by Autopilot (floor upgrades) and Core plan (furniture floors) --------------------------
// "x,y:item:rot" cells. Scored with the game's engine.evaluateLayout on 2026-11-22: Workshop v1 = x5 on Frame Timber, Make Bookshelf,
// Make Table, Make Chair (one input); Rivet x3 = x3 on Rivet Iron Frame, Make Bench, Make Desk (two inputs).
// mineX3 = x3 merge on a 5x2 Mine (Extract, no inputs; proven max), smeltX3 = Smelt x3 on the Smelter: both moved from Autopilot's floor library.
const floorDesigns = Object.freeze({
  workshopV1: '0,0:114:0 0,1:114:0 0,2:114:0 0,3:114:0 0,4:114:0 10,1:123:0 10,2:116:2 10,4:123:0 11,0:123:0 11,1:126:0 11,4:123:0 12,0:123:0 12,1:123:0 12,4:123:0 13,0:123:0 13,1:126:0 13,2:123:1 13,3:123:2 13,4:123:0 14,0:123:0 14,1:123:1 14,2:123:0 14,4:123:0 15,0:116:0 15,2:116:0 15,4:123:0 16,4:123:0 17,4:123:0 2,0:123:0 2,1:123:0 2,2:123:0 2,3:123:0 2,4:123:0 3,0:123:0 3,1:123:1 3,2:127:0 3,3:123:3 3,4:123:0 4,0:116:0 4,2:123:0 4,3:116:0 5,2:123:0 6,2:123:0 7,0:123:0 7,1:123:0 7,2:123:3 7,3:123:0 8,0:123:1 8,1:128:0 8,2:123:1 8,3:127:1 8,4:123:0 9,1:123:0 9,3:123:1 9,4:127:0',
  rivetX3: '0,0:123:0 0,1:123:1 0,2:123:1 0,3:123:1 0,4:123:0 1,0:123:0 1,4:123:0 10,1:123:0 10,2:123:0 10,4:123:0 11,1:123:0 11,2:123:0 11,4:123:0 12,1:123:0 12,2:116:0 12,4:123:0 13,1:123:0 13,4:123:0 14,1:123:0 14,4:123:0 15,0:116:0 15,2:123:0 15,3:116:0 16,2:123:0 17,2:123:0 2,0:126:0 2,1:123:1 2,2:126:1 2,3:123:0 2,4:123:0 3,0:123:0 3,2:123:0 3,3:114:0 3,4:123:0 4,0:114:0 4,2:114:0 4,4:123:0 5,3:123:0 5,4:123:0 6,0:123:0 6,2:123:0 6,3:127:0 6,4:123:3 7,0:123:1 7,1:123:1 7,2:127:0 7,3:123:3 8,2:123:0 9,1:123:0 9,2:126:0 9,3:123:1 9,4:123:0',
  mineX3: '0,0:121:0 0,1:121:0 1,0:123:0 1,1:123:0 2,0:127:0 2,1:123:3 3,0:123:0 4,0:123:0 4,1:121:0',
  smeltX3: '0,0:123:1 0,1:127:1 0,2:123:1 0,3:123:0 1,0:113:0 1,2:123:3 1,3:126:0 2,3:123:0 3,0:123:0 3,2:123:0 3,3:126:0 4,0:123:0 4,1:113:0 4,3:123:0 5,0:123:0 5,3:123:0 6,0:123:0 6,1:123:0 6,2:113:0 7,0:123:0 7,1:123:0 8,0:123:0 8,1:123:0 8,2:123:0 9,0:114:0 9,1:114:0 9,2:114:0',
});

// ---- game numbers other modules share ------------------------------------------------------------------------------
// Courier allowance per run in CU: 10,000 + 5,000 per capacity level, at most 50,000 (the client's own formula, st.courier_levels.capacity).
const courierCU = (st = walk().st) => Math.min(50000, 10000 + Math.max(0, Number(st?.courier_levels?.capacity) || 0) * 5000);
// NPC power price multiplier from the world event in force: the client's event chip reads engine.worldEventAt(tick) and shows
// "NPC power x(100 + percent) / 100" when the event is an outage. 1 when there is none, or no engine / tick to ask.
function powerPriceMult(engine = walk().engine, tick = nowTick()) {
  try {
    const ev = tick > 0 && typeof engine?.worldEventAt === 'function' ? JSON.parse(engine.worldEventAt(tick)) : null;
    return ev?.outage && Number.isFinite(ev.percent) ? Math.max(0, (100 + ev.percent) / 100) : 1;
  } catch { return 1; }
}
// The power world event in force, or the next one to start within `ahead` ticks (default one 12 h event day): { mult, title, start, end }
// in ticks, or null. The engine works events out from the server's seeds, so worldEventAt answers for later ticks too. Power events last
// 2 h (14,400 ticks) and start on the hour, so a scan every 1,200 ticks finds them; the result is kept for one 1,200-tick step.
const POWER_EVENT_TICKS = 14400;
let powerEventMemo = { key: -1 };
function powerEvent(engine = walk().engine, tick = nowTick(), ahead = 86400) {
  if (!(tick > 0) || typeof engine?.worldEventAt !== 'function') return null;
  const key = Math.floor(tick / 1200), mm = powerEventMemo;
  if (mm.key === key && mm.engine === engine && mm.ahead === ahead && !(mm.v && mm.v.end <= tick)) return mm.v;
  let v = null;
  try {
    for (let t = tick; t <= tick + ahead && !v; t += 1200) {
      const ev = JSON.parse(engine.worldEventAt(t));
      if (!ev?.outage || !Number.isFinite(ev.percent)) continue;
      const end = Number.isFinite(ev.ends_at) ? ev.ends_at : t + POWER_EVENT_TICKS;
      if (end > tick) v = { mult: Math.max(0, (100 + ev.percent) / 100), title: ev.title ?? null, start: end - POWER_EVENT_TICKS, end };
    }
  } catch { v = null; }
  powerEventMemo = { key, engine, ahead, v };
  return v;
}
// Power or water this Corporation buys on contracts in one region (a power-market buy is one): each Active contract's capacity, less the
// part of what the buyer draws (up to the contract) that the seller is not delivering; in a shortfall the grid covers that gap during the
// grace period. contracts: walk().contracts (null before the board was first seen: nothing bought counts).
// endBy: a game tick; a contract that ends by then (started_at + duration) counts as gone already (0 / omitted: no end rule).
function bought(util, region, st, contracts, endBy = 0) {
  const corp = st?.ssi?.corp_id;
  let n = 0;
  for (const c of contracts ?? []) {
    if (c.utility !== util || c.region !== region || c.state !== 'Active' || c.buyer !== corp) continue;
    if (endBy > 0 && c.started_at != null && c.duration != null && c.started_at + c.duration <= endBy) continue;
    n += (c.amount ?? 0) - Math.max(0, Math.min(Math.max(c.drawn ?? 0, 0), c.amount ?? 0) - Math.max(c.delivered ?? 0, 0));
  }
  return n;
}
// "MW needed", the one power model every module uses (plan A4: Auto utilities, Core plan's hourly check, Autopilot). Pure. For one utility
// in one region: what the groups draw, what is generated, stored or bought, what stalled groups wait for, and need: the subscription that
// covers all of it (negative: a surplus). flows: the engine's line flows [{ from, to, sent, delivered }] (power only). ev: a power event
// plan ({ mode: 'pre' | 'dear' | 'cheap', end }) or null; it counts only where storage is. leadMin: a bought contract this close to its
// end counts as gone (`ending` is that share). catalog: the client catalog (arrays) or an id-keyed one.
// A state with no work rows on any group (a pure snapshot, the offline sim) counts every unpaused group's draw, as before the engine rows.
const POWER_DAY = 28800, POWER_DAYLIGHT = 21600, POWER_NIGHT_PCT = 25, POWER_BILL_TICKS = 1200;   // diurnal generators make 25% at night; a bill every 10 min
const INTANGIBLE_ITEMS = new Set([0, 24, 25, 26, 106, 107, 108, 109, 110, 111]);                    // items held in st.items, not in stock
const powerIdx = new WeakMap();   // catalog -> { b, r } by id, built once per catalog object
function powerMeasure(util, region, st, catalog, tick, contracts, flows = [], ev = null, leadMin = 30) {
  const R = String(region);
  let ix = powerIdx.get(catalog);
  if (!ix) powerIdx.set(catalog, ix = { b: new Map(Object.values(catalog.buildings ?? {}).map((b) => [b.id, b])), r: new Map(Object.values(catalog.recipes ?? {}).map((r) => [r.id, r])) });
  const bOf = ix.b, rOf = ix.r;
  const have = st.subscriptions?.[R]?.[util] ?? 0;
  const groups = Object.values(st.groups ?? {}).filter((g) => (g.region ?? 0) === region);
  const noRows = !groups.some((g) => g.work != null);
  const stockOf = (item) => (INTANGIBLE_ITEMS.has(item) ? (st.items?.[item] ?? 0) : (st.stock?.[R]?.[item] ?? 0));
  const diurnal = (p) => (((tick % POWER_DAY) + POWER_DAY) % POWER_DAY < POWER_DAYLIGHT ? p : Math.floor(p * POWER_NIGHT_PCT / 100));
  let load = 0, gen = 0, base = 0;
  // an Efficiency module cuts the building draw by its layout's draws_pct (engine-measured; Auto modules reads it from the engine)
  const dp = (g) => (W.autoModules?.drawsPct?.(g) ?? 100) / 100;
  for (const g of groups) {
    const work = g.work ?? [], bd = bOf.get(g.building), draw = (bd?.draws?.[util] ?? 0) * g.count * dp(g);
    // A baseload building (Retail Store: no work rows, no machines) draws whenever its group is unpaused; short of it, no store in
    // the region sells (plan A3).
    if (bd?.baseload && !g.paused) { load += draw; base += draw; }
    else if (work.length || (noRows && !g.paused)) load += draw;
    for (const w of work) {
      const rc = rOf.get(w.recipe);
      if (!rc) continue;
      load += (rc.draws?.[util] ?? 0) * w.runs;
      const p = (rc.generates?.[util] ?? 0) * w.runs;
      gen += rc.diurnal ? diurnal(p) : p;
    }
  }
  const owned = (id) => (st.building_pool?.[R]?.[id] ?? 0) + groups.filter((g) => g.building === id).reduce((a, g) => a + g.count, 0);
  let dischargeCap = 0, chargeCap = 0, storeMax = 0;
  for (const b of bOf.values()) {
    const s = b.storage?.[util], n = s ? owned(b.id) : 0;
    if (n) { dischargeCap += (s.discharge_limit ?? 0) * n; chargeCap += (s.charge_limit ?? 0) * n; storeMax += (s.max ?? 0) * n; }
  }
  // Stored is in MW-ticks (7,200 = 1 MWh): count only the rate it can keep up until the next bill, so a Battery Bank that would run
  // dry mid-period does not cut the subscription. Right after a bill that is stored / 1,200, and the hold window keeps that sample.
  const stored = st.stored?.[R]?.[util] ?? 0, toBill = tick > 0 ? POWER_BILL_TICKS - (tick % POWER_BILL_TICKS) : 0;
  // Power events: before a dear one and during a cheap one nothing stored is counted on (a cheap one also adds the charge rate until
  // full); during a dear one what is stored is spread to the event's end.
  const mode = util === 'power' && dischargeCap + chargeCap > 0 ? ev?.mode ?? null : null;
  const toUse = mode === 'dear' && ev.end > tick ? ev.end - tick : toBill;
  const discharge = mode === 'pre' || mode === 'cheap' ? 0 : Math.min(dischargeCap, stored, toUse ? stored / toUse : stored);
  const charge = mode === 'cheap' ? Math.min(chargeCap, Math.max(0, storeMax - stored)) : 0;
  const lines = util === 'power' && Array.isArray(flows) ? flows : [];
  const lineIn = lines.filter((f) => f.to === region).reduce((a, f) => a + (Number(f.delivered) || 0), 0);
  const lineOut = lines.filter((f) => f.from === region && f.delivered > 0).reduce((a, f) => a + (Number(f.sent) || 0), 0);
  const corp = st.ssi?.corp_id;
  // What is bought counts its capacity less any shortfall (bought); what is promised to others is owed, whatever has got through.
  const importedNow = bought(util, region, st, contracts);
  const imported = tick > 0 ? bought(util, region, st, contracts, tick + leadMin * 120) : importedNow;
  const sold = (contracts ?? []).filter((c) => c.utility === util && c.region === region && c.state === 'Active' && c.seller === corp).reduce((a, c) => a + (c.amount ?? 0), 0);
  // A group that could start but whose draw is more than the free capacity is stalled; the engine starts it once free >= its draw.
  // A group with no machines yet (equipped 0) cannot start whatever the power: the game calls it "unequipped", not stalled.
  // Baseload groups are in the load already: the store gets power last, so it sells only while what is left covers it.
  const free = Math.max(0, have + gen + discharge + imported + lineIn - load - sold - lineOut);
  let waiting = 0;
  for (const g of groups) {
    if (noRows || g.paused || g.equipped === 0 || (g.work ?? []).length || bOf.get(g.building)?.baseload) continue;
    const draw = (bOf.get(g.building)?.draws?.[util] ?? 0) * g.count * dp(g);
    if (!(draw > 0) || draw <= free) continue;
    const rc = (g.recipe != null && (st.recipes?.[String(g.recipe)] ?? rOf.get(g.recipe))) || null;
    if (!rc || !(rc.inputs ?? []).every((i) => stockOf(i.item) >= i.amount)) continue;
    waiting += draw;
  }
  const need = load + sold + lineOut + waiting + charge - gen - discharge - imported - lineIn;
  return { util, region, have, load, base, free, sold, gen, discharge, charge, mode, imported, ending: importedNow - imported, lineIn, lineOut, waiting, need };
}

// Module sockets, shared by Auto modules and Core plan. A socket holds a module id (a number, possibly 0) or an object with an id.
const modId = (m) => (m != null && typeof m === 'object' ? m.id : m);
const usedCells = (g) => Object.entries(g?.modules ?? {}).filter(([, m]) => modId(m) != null);
// Free modules: defined, in no group's sockets (any region) and not in a fleet socket.
function freeModules(st) {
  const f = st.fleet_modules;
  const used = new Set((f == null ? [] : Array.isArray(f) ? f : Object.values(f)).map(modId).filter((x) => x != null).map(String));
  for (const g of Object.values(st.groups ?? {})) for (const [, m] of usedCells(g)) used.add(String(modId(m)));
  return Object.values(st.module_defs ?? {}).filter((d) => d?.id != null && !used.has(String(d.id))).sort((a, b) => a.id - b.id);
}

const titleTimer = HAS_DOM ? setInterval(applyTitle, 2000) : 0;
addEventListener?.('pagehide', flushLedger);

// settings(key): one module's saved settings in localStorage. load() is null when missing or unreadable; save() never throws.
const settings = (key) => ({
  load: () => { try { return JSON.parse(store?.getItem(key) || 'null'); } catch { return null; } },
  save: (v) => { try { store?.setItem(key, JSON.stringify(v)); } catch { } },
});

W.idleCore = {
  version: 1,
  walk, sleep, every, sleepWake, waitConfirm, tune, markSend, lastRtt, nowTick, seeTick, sock, orderBook, sendBoardFilter, onFrame, link, realHidden,
  h, makeDraggable, toast, ledger: ledgerApi, ui,
  setBadge, notify, askNotify, notifyPerm, stopAll, reserves, floorDesigns, courierCU, powerPriceMult, powerEvent, bought, powerMeasure,
  exportConfig, importConfig, exportFile, importFile, missingFields, modules: { modId, usedCells, freeModules }, plans, REGION_NAMES, regionName, toInt, settings,
  _unload() {
    orderBook.release();
    frameSubs.clear();
    unloaded = true;
    sock.ws?.removeEventListener('message', onMessage);
    if (sock.ws?.send === hookSend) sock.ws.send = baseSend;
    sock.ws = null;
    if (HAS_DOM) removeEventListener('keydown', onKey, true);
    clearInterval(titleTimer);
    flushLedger();
    if (HAS_DOM) { uiStyleEl?.remove(); toastBox?.remove(); uiStyleEl = toastBox = null; domObs?.disconnect(); domObs = null; domSubs.clear(); dockOff = null; }
  },
};
}) ();
} catch (e) { console.error('[IdleCorp] shared core failed to load:', e); }
// @@END core

