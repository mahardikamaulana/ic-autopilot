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

  // Engine build and demolish times in seconds (checked in the sandbox on a Lumber Camp and a Mine): building takes 2 + B
  // ticks and demolishing 20 + B ticks, one at a time per queue, where B = sum of build items x frame weight. A tick is 0.5 s.
  const TICK_WEIGHT = { 'Wooden Frame': 2, 'Iron Frame': 4, 'Wired Frame': 8, 'Light Frame': 16, 'Machine Frame': 30, 'Automated Frame': 60, 'Smart Frame': 120 };
  function secsOf(catalog, b) {
    const C = normalize(catalog);
    const bld = typeof b === 'object' ? b : C.buildings[b];
    let B = 0;
    for (const { item, amount } of bld?.build_items ?? []) B += amount * (TICK_WEIGHT[C.items[item]?.name] ?? 0);
    return { build: (2 + B) / 2, demolish: (20 + B) / 2 };
  }
  // What the build and demolish queues hold. The price counts every queued build and demolition (all regions). The acres
  // count too: a queued build reserves its acres when ordered, and a queued demolition keeps them until it finishes.
  function queued({ st, catalog, region = 0 }) {
    const C = normalize(catalog);
    const out = { owned: {}, acres: 0, demolishAcres: 0, build: 0, demolish: 0 };
    for (const x of st.construction?.builds ?? []) {
      out.owned[x.building] = (out.owned[x.building] ?? 0) + x.count;
      out.build += secsOf(C, x.building).build * x.count;
      if ((x.region ?? region) === region) out.acres += C.buildings[x.building].acres * x.count;
    }
    for (const x of st.construction?.demolitions ?? []) {
      out.owned[x.building] = (out.owned[x.building] ?? 0) + x.count;
      out.demolish += secsOf(C, x.building).demolish * x.count;
      if ((x.region ?? region) === region) { out.acres += C.buildings[x.building].acres * x.count; out.demolishAcres += C.buildings[x.building].acres * x.count; }
    }
    // The head of each queue has progressed: the engine counts its progress in ticks (see ON in the client), so the seconds
    // left are the queue's full length less that progress.
    out.build = Math.max(0, out.build - (st.construction?.build_progress ?? 0) / 2);
    out.demolish = Math.max(0, out.demolish - (st.construction?.demolish_progress ?? 0) / 2);
    return out;
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
    const cd = cdOf(C, bld), sec = secsOf(C, bld);
    return { b: bld.id, name: bld.name, cd, acres: bld.acres, base: bld.cost, items, matCents, dropped, build: sec.build, demo: sec.demolish, rush: Math.ceil(cd / 2) };
    });
  }

  function plan(input) {
    const C = normalize(input.catalog);
    const { money = 0, floor = 0, R = Infinity, T = 0, TperType = 0, I = 0, minUnits = 1, maxBatch = 100, maxTypes = 2 } = input;
    const queueNow = input.queue ?? {};   // seconds already queued: { build, demolish }
    const cdHave = input.cdHave ?? 0;     // CD in stock: what rushed demolitions may spend
    const backlog0 = queueNow.demolish ?? 0;   // demolish seconds queued before this plan (they drain during this cycle)
    const cands = candidates(input);
    const live = cands.filter((c) => !c.dropped);
    const owned = (b) => input.owned?.[b] ?? 0;
    const n = {}, rushN = {}, order = [], barred = new Set();
    let acresLeft = input.usableAcres ?? 0, gross = 0, cdGross = 0, rushCd = 0, units = 0, binding = null, blocked = null;
    let buildSec = queueNow.build ?? 0, demoSec = queueNow.demolish ?? 0;
    const Reff = Math.min(R, 1e9);
    const notes = [];
    // A cycle is the measured overhead (T, plus a step per extra type) and the builds it waits for, one after the other. The
    // demolish queue runs beside the cycle, so the cycle is at least as long as the queue it receives (else the queue grows).
    const period = (types, bSec, dSec) => Math.max(T + TperType * Math.max(0, types - 1) + bSec, dSec);

    while (true) {
      if (cdGross - rushCd >= R) { binding = 'target'; break; }
      if (units >= maxBatch) { binding = 'batch'; break; }
      const P0 = period(order.length, buildSec, demoSec - backlog0);
      const steps = live.map((c) => {
        const k = n[c.b] ?? 0;
        const types = order.length + (k ? 0 : 1);
        const unitGross = price(c.base, owned(c.b), k);
        const bSec = buildSec + c.build;
        const unitCost = unitGross - Math.floor(c.base / 2) + c.matCents;
        // Route. A unit queues its demolish while the backlog from earlier cycles drains within this cycle (it is gone before
        // this cycle's demolishes start) and this batch's own demolishes fit in one cycle (they drain in the next; the first unit
        // always fits). Otherwise the unit is rushed (demolished at once for ceil(CD/2) CD) when the cycle time it saves is worth
        // more than that CD at the unit's cash per CD and the income I, or it waits for the queue.
        const Pq = period(types, bSec, 0);
        const batchNext = demoSec - backlog0 + c.demo;
        const fitsQueue = backlog0 <= Pq && batchNext <= Math.max(Pq, c.demo);
        let route = 'queue', block = null, P1 = period(types, bSec, batchNext);
        if (!fitsQueue) {
          const P1rush = period(types, bSec, demoSec - backlog0);
          const affordable = 2 * c.rush <= c.cd && cdHave - rushCd >= c.rush;
          if (affordable && I / 3600 * (P1 - P1rush) >= c.rush * unitCost / c.cd) { route = 'rush'; P1 = P1rush; }
          else block = 'queue';
        }
        const rushNow = route === 'rush' ? c.rush : 0;
        if (c.acres > acresLeft) block = 'acres';
        else if (money - (gross + unitGross) < floor) block = 'money';
        else if (c.items.some(({ item, amount }) => !itemCheck(input, item, (k + 1) * amount).ok)) block = 'items';
        else if (!k && order.length >= maxTypes) block = 'types';
        else if (!k && barred.has(c.b)) block = 'time';
        const netCd = c.cd - rushNow, perCd = unitCost / netCd;
        // Ranked by cash per net CD plus the time it costs per net CD (the cycle the unit lengthens, valued at the income I).
        // At I = 0 (Thrifty) this is the cheapest cash per CD; a high I favours the type that makes CD fastest per second.
        return { c, k, types, route, rushNow, unitGross, unitCost, netCd, P1, perCd, score: perCd + I / 3600 * P1 / netCd, block };
      }).sort((a, b) => a.score - b.score || a.c.b - b.c.b);
      const best = steps.find((s) => !s.block);
      if (!best) { blocked = steps[0] ?? null; binding = blocked?.block ?? null; break; }
      // Time value of shortening every remaining cycle by growing the batch from N to N + this unit's net CD.
      const N = cdGross - rushCd;
      const worth = N === 0 || units < minUnits
        || best.unitCost <= I / 3600 * Reff * (P0 / N - best.P1 / (N + best.netCd));
      if (!worth) {
        // A new type pays an extra step on every cycle; the next unit of a type already in the plan does not, so try that instead.
        if (!best.k) { barred.add(best.c.b); continue; }
        binding = 'time'; break;
      }
      if (!best.k) order.push(best.c);
      n[best.c.b] = best.k + 1;
      if (best.route === 'rush') { rushN[best.c.b] = (rushN[best.c.b] ?? 0) + 1; rushCd += best.rushNow; }
      else demoSec += best.c.demo;
      buildSec += best.c.build;
      gross += best.unitGross; cdGross += best.c.cd; acresLeft -= best.c.acres; units++;
    }
    // Final pass: a rushed unit goes back into the queue when it fits the same two limits in the finished cycle.
    const Pb = period(order.length, buildSec, 0);
    for (const c of order) {
      while ((rushN[c.b] ?? 0) > 0 && backlog0 <= Pb && demoSec - backlog0 + c.demo <= Math.max(Pb, c.demo)) {
        rushN[c.b] -= 1; rushCd -= c.rush; demoSec += c.demo;
      }
    }
    // No live candidate at all: say whether acres or items emptied the list.
    if (!live.length) binding = cands.some((c) => c.dropped === 'no-acres') ? 'acres' : cands.some((c) => c.dropped?.startsWith('item:')) ? 'items' : null;

    const out = order.map((c) => {
      const g = batchCost(c.base, owned(c.b), n[c.b]);
      return { b: c.b, name: c.name, n: n[c.b], rush: rushN[c.b] ?? 0, rushEach: c.rush, cd: c.cd, build: c.build, demolish: c.demo,
        grossCents: g, netCents: g - n[c.b] * Math.floor(c.base / 2), matCents: n[c.b] * c.matCents };
    });
    const netCents = out.reduce((a, u) => a + u.netCents, 0);
    const matCents = out.reduce((a, u) => a + u.matCents, 0);
    const cdTotal = cdGross - rushCd;   // net: a rushed demolish spends CD

    let wait = null;
    if (!units) {
      if (binding === 'money') {
        const shortfallCents = floor + blocked.unitGross - money;
        wait = { gate: 'G5', reason: 'need ' + dollars(shortfallCents) + ' more above the floor', shortfallCents };
      } else if (binding === 'acres') wait = { gate: 'G5', reason: 'no free acres above the spare' };
      else if (binding === 'queue') wait = { gate: 'G5', reason: 'demolish queue ' + Math.round(queueNow.demolish ?? 0) + ' s deep; waiting for it to drain' };
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
      units: out, cdTotal, cdGross, rushCd, grossCents: gross, netCents,
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

  core.planner = { normalize, cdOf, secsOf, queued, price, batchCost, acrePrice, landCost, itemValues, surplus, itemOk, candidates, plan, gates, land, signature, FRAME_CD };
})();
} catch (e) { console.error('[IdleCorp] planner failed to load:', e); }
// @@END planner
