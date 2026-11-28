// ============================================================================
// CORE PLAN DIRECTOR 11: endgame prep and the Refinery start (corePlan director)
// ============================================================================
// Director "endgame" (wiki/guides/core-game-plan.md 12, plan D6). Off by default (cfg.dir_endgame) until a live run has checked it.
// Only once E1-E5 hold (out.finished / out.E), the Refinery start first when it can go, then one step at a time, each waiting on the one before it:
//   1. 1 Assembly Plant, bought into a new group "Assemble Wired Frame"; 2. that group on Assemble Wired Frame (default floor, x1);
//   3. Copper Mines on Mine Copper Ore, 5 per Smelter, the x3 merge floor applied before the first one;
//   4. one Smelter on Draw Copper Wire, the Smelt x3 floor applied before it;
//   5. stock gates: a production group pauses once every endgame target its output feeds is met and resumes when one is below
//      (Kiln-gate bookkeeping in mem('endgame'): egMine = paused here, egUser = resumed by you, left alone; the resume director skips egMine);
//   6. StartTech Refinery once 500,000 CD and its prototype are in hand, checked before steps 1-5. Its CD need is published from the moment E1-E5 hold.
// Before E1-E5 hold, or with cfg.dir_endgame off, only the resume half of step 5 runs (off: every group it paused), so no pause is stranded.
// Purchases: acres above the CD-farm buffer, BuyLand for the rest (E4 leaves no acre above the buffer), kit in stock, cash >= the money
// floor + land + price + bill floor. These buildings are not pending investments for E5: they come after the gate.
// Pure pieces on corePlan._endgame for the tests.
// @@MODULE cp-endgame
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const cp = W.corePlan, cfg = cp.cfg, usd = cp._usd;
  const TARGETS = cp._cadence?.TARGETS;          // the endgame stock (wiki 12), shared with the sell keep line
  if (!TARGETS) throw new Error('cp-cadence did not load');
  const REGION = 0, ACRE_CAP = 360;
  const ET = W.idleCore.plans.current().core.directors.endgame.tables;   // plan data (src/core-plans.js)
  const MINES_PER_SMELTER = ET.minesPerSmelter, SMELTERS = ET.smelters;     // Smelt x3 eats 600 Ore/h, a Mine on the x3 merge makes 144 (plan D6)
  // Each production group with every target downstream of it: it pauses only when all of them hold.
  const CHAIN = ET.chain;
  const num = W.idleCore.ui.num;
  const stockOf = (v, i) => v.st.stock?.[REGION]?.[i] ?? v.st.items?.[i] ?? 0;
  const itemName = (v, i) => v.C.items[i]?.name ?? 'item ' + i;
  const groupsOn = (v, b, r) => v.groups.filter((g) => g.building === b && g.recipe === r && g.count > 0);
  const setRecipe = (v, g, r) => ({ id: 'eg:recipe:' + g.id + ':' + r.id, text: 'endgame: group ' + g.id + ' (' + g.count + ' ' + v.bld(g.building).name + ') to ' + r.name,
    steps: [{ msg: { type: 'SetRecipe', group: g.id, recipe: r.id }, until: (x) => x.groups.find((y) => y.id === g.id)?.recipe === r.id }] });

  // One building bn for recipe r, into the biggest group on r, else a new group named after r (held: CD Farm and the pool tidy keep off it).
  function buyStep(v, ctx, bn, r, label) {
    const b = v.idB(bn), bd = v.bld(b);
    const acres = Math.max(0, cfg.bufferAcres + bd.acres - v.freeAcres);
    if (v.acresOwned + acres > ACRE_CAP) return { wait: label + ': no free acre and Heartland is at its cap (' + ACRE_CAP + ' acres)' };
    let land = 0;
    for (let i = 0; i < acres; i++) land += cp._acrePriceCents(v.landBought + i);
    const need = {};
    for (const x of [...(bd.build_items ?? []), ...(v.st.layouts?.[r.id]?.bom ?? bd.default_kit ?? [])]) need[x.item] = (need[x.item] ?? 0) + x.amount;
    const lack = Object.entries(need).filter(([i, a]) => stockOf(v, +i) < a).map(([i, a]) => Math.ceil(a - stockOf(v, +i)) + ' ' + itemName(v, +i));
    if (lack.length) return { wait: label + ': kit short: ' + lack.join(', ') };
    const price = W.idleCore.planner.price(bd.cost, v.ownedAll(bn), 0), mw = bd.draws?.power ?? 0, bill = cp._billNeed(v, mw), floor = ctx.floorCents ?? 0;
    const want = floor + land + price + bill;
    if (v.money < want) return { wait: label + ': cash ' + usd(v.money) + ' < ' + usd(want) + ' (money floor + ' + (land ? acres + ' acre(s) ' + usd(land) + ' + ' : '') + usd(price) + ' + ' + mw + ' MW bills)' };
    const g = groupsOn(v, b, r.id).sort((a, z) => z.count - a.count)[0], steps = cp._buySteps(v, b, acres, g, r.name);
    return { action: { id: 'eg:buy:' + bn + ':' + v.owned(bn), text: 'endgame: buy ' + (acres ? acres + ' acre(s) ' + usd(land) + ' + ' : '') + label + ' ' + usd(price) + (g ? ' into group ' + g.id : ' (new group "' + r.name + '")'), steps, hold: true } };
  }
  // n buildings bn on recipe rn: a group named after rn that has no recipe yet gets it, the floor goes on before the first building
  // (no building on the recipe: no parts to pay), then one purchase per step. null once n run it.
  // After an EditLayout the server did not apply, that recipe's floor waits cfg.floorRetryMin (cp._floorAction), as buildout's floorStep.
  function buildStep(v, ctx, bn, rn, n, floor) {
    const b = v.idB(bn), r = v.C.recipes[v.idR(rn)];
    if (b == null || !r) return { wait: 'manual: the catalog has no ' + (b == null ? bn : rn) };
    const bare = v.groups.find((g) => g.building === b && g.count > 0 && g.recipe == null && g.name === r.name);
    if (bare) return { action: setRecipe(v, bare, r) };
    const have = groupsOn(v, b, r.id).reduce((a, g) => a + g.count, 0);
    if (have >= n) return null;
    const label = bn + ' (' + rn + ') ' + (have + 1) + '/' + n;
    if (floor && !v.st.layouts?.[r.id]) {
      const obj = cp._floorObj(floor.key);
      if (!obj) return { wait: label + ': no ' + floor.label + ' design in the core' };
      if (have > 0) return { wait: label + ': manual: apply the ' + floor.label + ' to ' + rn + ' (' + have + ' ' + bn + ' already run it without)' };
      return cp._floorAction(ctx, 'endgame', r.id, r, obj, label + ': the server did not apply the ' + floor.label, { id: 'eg:floor:' + r.id, text: 'endgame: apply the ' + floor.label + ' to ' + rn + ' (before its first ' + bn + ')' });
    }
    return buyStep(v, ctx, bn, r, label);
  }
  // Steps 1-2: an Assembly Plant you own already counts; one with no recipe goes on Assemble Wired Frame, one on another recipe is left to you.
  function plantStep(v, ctx) {
    const b = v.idB('Assembly Plant'), r = v.C.recipes[v.idR('Assemble Wired Frame')];
    if (b == null || !r) return { wait: 'manual: the catalog has no ' + (b == null ? 'Assembly Plant' : 'Assemble Wired Frame') };
    if (groupsOn(v, b, r.id).length) return null;
    const idle = v.groups.find((g) => g.building === b && g.count > 0 && g.recipe == null);
    if (idle) return { action: setRecipe(v, idle, r) };
    if (v.owned('Assembly Plant') > 0) return { wait: 'manual: your Assembly Plant runs another recipe or sits in the pool: put one on Assemble Wired Frame' };
    return buyStep(v, ctx, 'Assembly Plant', r, 'Assembly Plant');
  }

  // Step 5: pause at the targets, resume below (only groups paused here; one you resumed is yours from then on).
  // mode 'resume': the resume half alone (E1-E5 not holding: a pause is never stranded); 'off' (cfg.dir_endgame false): every group it paused comes back.
  const confirmed = (a, fn) => { const u = a.steps[0].until; a.steps[0].until = (x) => { const ok = u(x); if (ok) fn(); return ok; }; return a; };
  function gateStep(v, ctx, mode) {
    const m = ctx.mem?.('endgame');
    if (!m) return null;
    const o = m.get(), mine = new Set(o.egMine ?? []), user = new Set(o.egUser ?? []);
    const note = (gid, add) => () => { const s = new Set(m.get().egMine ?? []); if (add) s.add(gid); else s.delete(gid); m.set({ egMine: [...s] }); };
    const met = (n) => v.has(n) >= TARGETS.find(([x]) => x === n)[1];
    const act = (g, why, paused) => ({ id: 'eg:pause:' + g.id + ':' + paused, text: 'endgame stock gate (' + why + '): ' + (paused ? 'pause' : 'resume') + ' group ' + g.id,
      steps: [{ msg: { type: 'SetPaused', group: g.id, paused }, until: (x) => !!x.groups.find((y) => y.id === g.id)?.paused === paused }] });
    const resume = (g, why) => {
      const mw = (v.bld(g.building).draws?.power ?? 0) * g.count, need = (ctx.floorCents ?? 0) + cp._billNeed(v, mw);
      if (v.money < need) return { wait: 'stock gate: resume group ' + g.id + ' waits: cash ' + usd(v.money) + ' < ' + usd(need) + ' (money floor + ' + mw + ' MW bills)' };
      return { action: confirmed(act(g, why, false), note(g.id, false)) };
    };
    if (mode === 'off') {
      const g = v.groups.find((x) => mine.has(x.id) && !user.has(x.id) && x.paused && x.count > 0);
      return g ? resume(g, 'endgame off') : null;
    }
    for (const c of CHAIN) {
      const full = c.feeds.every(met), why = c.r + (full ? ': ' + c.feeds.join(', ') + ' at target' : ': ' + c.feeds.filter((n) => !met(n)).join(', ') + ' below target');
      for (const g of groupsOn(v, v.idB(c.b), v.idR(c.r))) {
        if (user.has(g.id)) continue;
        if (!g.paused && full && mode !== 'resume') return { action: confirmed(act(g, why, true), note(g.id, true)) };
        if (g.paused && !full && mine.has(g.id)) return resume(g, why);
      }
    }
    return null;
  }

  function endgameDecide(v, ctx, out) {
    const checklist = TARGETS.map(([n, want]) => ({ item: n, have: Math.floor(v.has(n)), want, ok: v.has(n) >= want }));
    const finished = !!out.finished || (Array.isArray(out.E) && out.E.length > 0 && out.E.every((c) => c.ok));
    if (!finished) {
      const r = gateStep(v, ctx, 'resume');
      return { ...(r ?? {}), wait: r?.wait ?? (r?.action ? undefined : 'end conditions E1-E5 not all true'), readout: { checklist } };
    }
    const b = v.idB('Refinery'), t = b == null ? null : v.N.techs.find((x) => x.building === b), cost = t?.cost ?? cp._refineryCd;
    const preOk = !t?.requires || !!v.st.unlocked_buildings?.includes(t.requires);
    // The CD for the Refinery takes days to farm: asked for from the start, not after the builds.
    if (b != null && !v.unlocked('Refinery') && v.research?.building !== b) out.cdNeed = { b, name: 'Refinery', cd: cost, prereqsMet: preOk, note: preOk ? '' : 'needs Oil Rig first' };
    const ref = refineryStep(v, b, t, cost, preOk);
    if (ref.action) return { ...ref, readout: { checklist } };   // first: the slot, CD and frames in hand start it whatever the builds wait for
    for (const step of [() => plantStep(v, ctx),
      () => buildStep(v, ctx, 'Mine', 'Mine Copper Ore', MINES_PER_SMELTER * SMELTERS, { key: 'mineX3', label: 'x3 merge floor' }),
      () => buildStep(v, ctx, 'Smelter', 'Draw Copper Wire', SMELTERS, { key: 'smeltX3', label: 'Smelt x3 floor' }),
      () => gateStep(v, ctx)]) {
      const r = step();
      if (r) return { ...r, readout: { checklist } };
    }
    return { ...ref, readout: { checklist } };
  }
  // Step 6: StartTech Refinery, or why not yet.
  function refineryStep(v, b, t, cost, preOk) {
    if (b == null) return { wait: 'manual: no building named Refinery' };
    if (v.unlocked('Refinery')) return { wait: 'Refinery unlocked' };
    const proto = v.bld(b).build_items ?? [];
    const lack = proto.filter((i) => stockOf(v, i.item) < i.amount);
    const why = 'Refinery';
    if (v.research?.building === b) return { wait: why + ': research running' };
    if (!preOk) return { wait: why + ': needs Oil Rig first' };
    if (v.research) return { wait: why + ': research slot busy' };
    if (v.cd < cost) return { wait: why + ': ' + num(v.cd) + ' / ' + num(cost) + ' CD' };
    if (lack.length) return { wait: why + ': need ' + lack.map((i) => Math.ceil(i.amount - stockOf(v, i.item)) + ' more ' + itemName(v, i.item)).join(', ') };
    return { action: { id: 'tech:' + b, text: 'unlock Refinery (' + num(cost) + ' CD + ' + proto.map((i) => i.amount + ' ' + itemName(v, i.item)).join(', ') + ')',
      steps: [{ msg: { type: 'StartTech', building: b, region: REGION }, until: (x) => x.research?.building === b || x.unlocked('Refinery') }] } };
  }

  // A group the gate paused that runs again was resumed by you: hands off from then on. One gone or emptied drops out.
  function egContext(v, ctx) {
    if (!ctx.mem) return;
    const m = ctx.mem('endgame'), o = m.get(), mine = o.egMine ?? [];
    if (!mine.length) return;
    const keep = [], user = [];
    for (const id of mine) { const g = v.groups.find((x) => x.id === id); if (g && g.count > 0 && g.paused) keep.push(id); else if (g && g.count > 0) user.push(id); }
    if (keep.length !== mine.length) m.set({ egMine: keep, ...(user.length ? { egUser: [...new Set([...(o.egUser ?? []), ...user])] } : {}) });
  }

  cp.addDirector({
    name: 'endgame', order: 90, always: true,   // always: the resume half of the stock gates runs with no stage too
    // starts off: the plan preset's directors.endgame.on is false (cfg.dir_endgame)
    context: egContext,
    decide: endgameDecide,
    whenOff: (v, ctx) => gateStep(v, ctx, 'off'),   // turned off: the groups its gate paused come back
    duties: () => [{ duty: 'endgame: Assembly Plant, copper Mines, wire Smelter, stock gates, Refinery start (off unless cfg.dir_endgame)', owner: 'Core plan', done: cfg.dir_endgame === true }],
  });
  cp._endgame = { endgameDecide, gateStep, egContext, CHAIN, MINES_PER_SMELTER };
})();
} catch (e) { console.error('[IdleCorp] cp-endgame failed to load:', e); }
// @@END cp-endgame
