// ============================================================================
// PLANNER (window.idleCore.planner)
// ============================================================================
// Pure decision functions for the CD farm's Auto mode: CD per type, price ladders, item surplus,
// the greedy batch plan, the gates and the land check. No DOM, sockets or timers. Money is integer cents.
// @@MODULE planner
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');

  // Frame CD weights, by item name (ids differ between catalogs).
  const FRAME_CD = { 'Wooden Frame': 2, 'Iron Frame': 4, 'Wired Frame': 8, 'Light Frame': 16, 'Machine Frame': 32, 'Automated Frame': 64, 'Smart Frame': 128 };
  const STARTERS = [0, 10];
  const dollars = (c) => '$' + (c / 100).toFixed(2);

  const normCache = new WeakMap();
  function normalize(raw) {
    if (raw.byId) return raw;
    if (normCache.has(raw)) return normCache.get(raw);
    const key = (arr) => Object.fromEntries((arr ?? []).map((x) => [x.id, x]));
    const c = { byId: true, items: key(raw.items), buildings: key(raw.buildings), recipes: key(raw.recipes) };
    normCache.set(raw, c);
    return c;
  }

  function cdOf(catalog, b) {
    const C = normalize(catalog);
    const bld = typeof b === 'object' ? b : C.buildings[b];
    let cd = 0;
    for (const { item, amount } of bld?.build_items ?? []) cd += amount * (FRAME_CD[C.items[item]?.name] ?? 0);
    return Math.max(1, cd);
  }

  const price = (baseCents, owned, i) => Math.floor(baseCents * (20 + owned + i) / 20);
  function batchCost(baseCents, owned, n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += price(baseCents, owned, i);
    return s;
  }
  // n = 0-based index among bought acres (the starter acres are free and not counted).
  function acrePrice(first, n) {
    let p = first;
    for (let i = 0; i < n; i++) p = Math.floor(p * 41 / 40);
    return p;
  }
  function landCost(first, landBought, k) {
    let s = 0;
    for (let j = 0; j < k; j++) s += acrePrice(first, landBought + j);
    return s;
  }

  // Best open bid, else base value while a running recipe consumes it, else 0.
  function itemValues({ catalog, bids = {}, runningInputs = [] }) {
    const C = normalize(catalog);
    const inUse = new Set([...runningInputs].map(Number));
    const out = {};
    for (const it of Object.values(C.items)) out[it.id] = Math.max(bids[it.id] ?? 0, inUse.has(it.id) ? it.base_value : 0);
    return out;
  }

  function surplus({ stock = {}, reserve = {} }) {
    const out = {};
    for (const [item, n] of Object.entries(stock)) out[item] = Math.max(0, n - (reserve[item] ?? 0));
    return out;
  }

  // A draining item is only usable while the surplus left after this need still covers 2 h of the farm's burn.
  function itemOk({ need, stock = 0, reserve = 0, netSupply, burn = 0 }) {
    const sur = Math.max(0, stock - reserve);
    if (sur < need) return { ok: false, reason: 'short' };
    if (netSupply !== undefined && netSupply < 0 && sur - need < 2 * burn) return { ok: false, reason: 'draining' };
    return { ok: true, reason: null };
  }
  const itemCheck = (input, item, need) => itemOk({
    need, stock: input.stock?.[item] ?? 0, reserve: input.reserve?.[item] ?? 0,
    netSupply: input.netSupply?.[item], burn: input.burn?.[item] ?? 0,
  });

  function candidates(input) {
    const C = normalize(input.catalog);
    const unlocked = new Set([...(input.unlocked ?? []), ...STARTERS].map(Number));
    const usable = input.usableAcres ?? 0;
    return Object.values(C.buildings).sort((a, b) => a.id - b.id).map((bld) => {
      const items = (bld.build_items ?? []).map(({ item, amount }) => ({ item, amount }));
      const matCents = items.reduce((a, { item, amount }) => a + amount * (input.itemValue?.[item] ?? 0), 0);
      let dropped = null;
      if (!unlocked.has(bld.id)) dropped = 'locked';
      else if (input.quarantine?.[bld.id]) dropped = 'quarantined';
      else if (bld.acres > usable) dropped = 'no-acres';
      else for (const { item, amount } of items) {
        const r = itemCheck(input, item, amount);
        if (!r.ok) { dropped = 'item:' + item + ':' + r.reason; break; }
      }
      return { b: bld.id, name: bld.name, cd: cdOf(C, bld), acres: bld.acres, base: bld.cost, items, matCents, dropped };
    });
  }

  function plan(input) {
    const C = normalize(input.catalog);
    const { money = 0, floor = 0, R = Infinity, T = 0, TperType = 0, I = 0, minUnits = 1, maxBatch = 100, maxTypes = 2 } = input;
    const cands = candidates(input);
    const live = cands.filter((c) => !c.dropped);
    const owned = (b) => input.owned?.[b] ?? 0;
    const n = {}, order = [], barred = new Set();
    let acresLeft = input.usableAcres ?? 0, gross = 0, cdTotal = 0, units = 0, binding = null, blocked = null;
    const Reff = Math.min(R, 1e9);
    const notes = [];

    while (true) {
      if (cdTotal >= R) { binding = 'target'; break; }
      if (units >= maxBatch) { binding = 'batch'; break; }
      const steps = live.map((c) => {
        const k = n[c.b] ?? 0;
        const unitGross = price(c.base, owned(c.b), k);
        const unitCost = unitGross - Math.floor(c.base / 2) + c.matCents;
        let block = null;
        if (c.acres > acresLeft) block = 'acres';
        else if (money - (gross + unitGross) < floor) block = 'money';
        else if (c.items.some(({ item, amount }) => !itemCheck(input, item, (k + 1) * amount).ok)) block = 'items';
        else if (!k && order.length >= maxTypes) block = 'types';
        else if (!k && barred.has(c.b)) block = 'time';
        return { c, k, unitGross, unitCost, perCd: unitCost / c.cd, block };
      }).sort((a, b) => a.perCd - b.perCd || a.c.b - b.c.b);
      const best = steps.find((s) => !s.block);
      if (!best) { blocked = steps[0] ?? null; binding = blocked?.block ?? null; break; }
      const types = order.length + (best.k ? 0 : 1);
      // Time value of shortening every remaining cycle by growing the batch from N to N + cd.
      const N = cdTotal;
      // Cycle time is T plus a step per extra type; a new type lengthens every cycle, so compare the real before and after.
      const T0 = T + TperType * Math.max(0, order.length - 1), T1 = T + TperType * (types - 1);
      const worth = N === 0 || units < minUnits
        || best.unitCost <= I / 3600 * Reff * (T0 / N - T1 / (N + best.c.cd));
      if (!worth) {
        // A new type pays an extra step on every cycle; the next unit of a type already in the plan does not, so try that instead.
        if (!best.k) { barred.add(best.c.b); continue; }
        binding = 'time'; break;
      }
      if (!best.k) order.push(best.c);
      n[best.c.b] = best.k + 1;
      gross += best.unitGross; cdTotal += best.c.cd; acresLeft -= best.c.acres; units++;
    }

    // No live candidate at all: say whether acres or items emptied the list.
    if (!live.length) binding = cands.some((c) => c.dropped === 'no-acres') ? 'acres' : cands.some((c) => c.dropped?.startsWith('item:')) ? 'items' : null;

    const out = order.map((c) => {
      const g = batchCost(c.base, owned(c.b), n[c.b]);
      return { b: c.b, name: c.name, n: n[c.b], cd: c.cd, grossCents: g, netCents: g - n[c.b] * Math.floor(c.base / 2), matCents: n[c.b] * c.matCents };
    });
    const netCents = out.reduce((a, u) => a + u.netCents, 0);
    const matCents = out.reduce((a, u) => a + u.matCents, 0);

    let wait = null;
    if (!units) {
      if (binding === 'money') {
        const shortfallCents = floor + blocked.unitGross - money;
        wait = { gate: 'G5', reason: 'need ' + dollars(shortfallCents) + ' more above the floor', shortfallCents };
      } else if (binding === 'acres') wait = { gate: 'G5', reason: 'no free acres above the spare' };
      else if (binding === 'items') {
        const why = cands.filter((c) => c.dropped?.startsWith('item:')).map((c) => {
          const [, item, reason] = c.dropped.split(':');
          return c.name + ' needs ' + (C.items[item]?.name ?? 'item ' + item) + ' (' + reason + ')';
        });
        wait = { gate: 'G5', reason: 'no candidate has its build items: ' + why.join(', ') };
      }
    }
    for (const c of cands) if (c.dropped && c.dropped !== 'locked') notes.push(c.name + ' skipped: ' + c.dropped);
    if (binding) notes.push('bound by ' + binding);

    return {
      units: out, cdTotal, grossCents: gross, netCents,
      perCdCents: cdTotal ? Math.round((netCents + matCents) / cdTotal) : 0,
      wait, binding, candidates: cands, notes,
    };
  }

  function gates({ need, cd = 0, prereqsMet = true, prereqNote = '', organicCdPerHour = null, maxHours = 6 }) {
    if (!Number.isFinite(need) || need - cd <= 0) return { run: false, gate: 'G2', reason: 'no CD needed' };
    if (!prereqsMet) return { run: false, gate: 'G3', reason: 'waiting on ' + prereqNote + ', cash is better spent there' };
    if (organicCdPerHour > 0) {
      const h = (need - cd) / organicCdPerHour;
      if (h <= maxHours) return { run: false, gate: 'G4', reason: 'organic CD will cover it in ' + h.toFixed(1) + ' h' };
    }
    return { run: true };
  }

  // Extra acres pay back through faster cycles, so they are only bought while acres cap the batch.
  function land(input) {
    const { allow = 'off', landBought = 0, firstAcre, wall = Infinity, hoursUntilBought = () => Infinity, paybackHours = 1,
      plan: p, unitNeed, R = Infinity, T = 0, I = 0, money = 0, floor = 0 } = input;
    const N = p?.cdTotal ?? 0;
    const none = (note) => ({ buy: 0, priceCents: 0, realCostCents: 0, savingCents: 0, note });
    if (!N || !unitNeed) return none('no farm plan yet');
    const acresBind = p.binding === 'acres';
    const Reff = Math.min(R, 1e9), cdPerAcre = unitNeed.cd / unitNeed.acres;
    const opts = [1, 2, 3, 4].map((k) => {
      const priceCents = landCost(firstAcre, landBought, k);
      const unitPrice = acrePrice(firstAcre, landBought + k - 1);
      const h = hoursUntilBought(k);
      const realCostCents = Number.isFinite(h) ? Math.round(priceCents * Math.min(1, h / paybackHours)) : priceCents;
      const hoursSaved = T / 3600 * Reff * (1 / N - 1 / (N + k * cdPerAcre));
      const savingCents = Math.round(I * hoursSaved);
      const allowed = acresBind && allow !== 'off' && unitPrice <= wall
        && (allow === 'plan' ? Number.isFinite(h) : unitPrice <= allow)
        && money - priceCents >= floor + p.grossCents;
      return { k, priceCents, realCostCents, savingCents, hoursSaved, value: savingCents - realCostCents, allowed };
    });
    const pick = opts.filter((o) => o.allowed && o.value > 0).sort((a, b) => b.value - a.value || a.k - b.k)[0];
    const best = pick ?? [...opts].sort((a, b) => b.value - a.value || a.k - b.k)[0];
    const line = best.k + ' more acre' + (best.k > 1 ? 's' : '') + ' would save ' + best.hoursSaved.toFixed(1) + ' h for ' + dollars(best.priceCents);
    const { priceCents, realCostCents, savingCents } = best;
    return { buy: pick ? pick.k : 0, priceCents, realCostCents, savingCents, note: pick ? 'buying: ' + line : acresBind ? line : line + ' (acres are not the cap)' };
  }

  // FNV-1a over a canonical form, so the regime detector sees order-independent equality.
  function signature({ unlocked = [], running = [], retail = false, bids = [], phase = null }) {
    const sorted = (a) => [...a].map(Number).sort((x, y) => x - y);
    const s = JSON.stringify([sorted(unlocked), sorted(running), !!retail, sorted(bids), phase]);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  }

  core.planner = { normalize, cdOf, price, batchCost, acrePrice, landCost, itemValues, surplus, itemOk, candidates, plan, gates, land, signature, FRAME_CD };
})();
} catch (e) { console.error('[IdleCorp] planner failed to load:', e); }
// @@END planner
