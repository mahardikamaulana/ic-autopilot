// continues the cp-cadence closure from cp-cadence-1.js (same try / IIFE)
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
    // Power bought on contracts (ctx.contracts, the board) covers part of the load: the subscription only has to cover the rest.
    const au = ctx.mods?.autoUtil, sub = v.st.subscriptions?.[REGION]?.power ?? 0, load = au?._measure ? au._measure('power', REGION, v.st, v.catalog, 0, []).load : powerLoad(v);
    const bought = boughtPower(v, ctx);
    if (load > 0) c.push(chk('power', !!au?.conf?.power?.on && sub + bought >= load, (au?.conf?.power?.on ? 'Auto power on' : 'Auto power off') + ', ' + sub + ' MW subscribed' + (bought > 0 ? ' + ' + bought + ' MW bought' : '') + ' for ' + load + ' MW load'));
    const floor = sub * 12000 * (core?.powerPriceMult?.() ?? 1);   // a world event's NPC power price multiplier
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
    // shortcut: readout only, the payload shape is unverified; act on it once a live capture shows its fields.
    const we = ctx.worldEvents, ago = we ? Math.max(0, (ctx.now ?? Date.now()) - we.at) : 0;
    c.push(chk('world', null, we ? 'world events: last WorldEvents message ' + (ago < HOUR ? Math.round(ago / 60000) + ' min' : (ago / HOUR).toFixed(1) + ' h') + ' ago: ' + String(we.raw).slice(0, 200) : 'no WorldEvents message seen'));
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
    const mw = v.st.subscriptions?.[REGION]?.power ?? 0, pm = core?.powerPriceMult?.() ?? 1, need = mw * 6000 * pm * hours;
    add('cash', v.money >= need, 'cash ' + usd(v.money) + (v.money >= need ? ' >= ' : ' < ') + mw + ' MW x $' + +(60 * pm).toFixed(2) + ' x ' + hours + ' h = ' + usd(need));
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

  // ---- resume groups paused by an unpaid bill (plan D7, D-4: Autopilot's observe() + resume step, moved here) -------------
  // A powered group seen running, then paused while cash is under ~2 bills (or the subscription is below the load), was paused by an
  // unpaid bill; any other pause, and a group already paused when first seen, is the user's and is never touched (Autopilot's rule).
  // The load is the one before the pause (groups seen running last step): Auto utilities sizes the subscription to running groups, so
  // counting paused ones would read every pause as a bill. Judged once, when the pause is first seen. A pause Core plan sent in the last
  // cfg.resumeGraceMin minutes (ctx.pauseSent) is a director's even before its own mem says so (the Kiln / FT gates write on confirm).
  const lastPaused = new Map();                  // this session only, like Autopilot: a group paused before the load counts as yours
  const drawOf = (v, g) => v.bld(g.building).draws?.power ?? 0;
  const powerHave = (v) => v.st.subscriptions?.[REGION]?.power ?? 0;
  const boughtPower = (v, ctx) => (core?.bought ? core.bought('power', REGION, v.st, ctx.contracts) : 0);   // power bought on contracts
  function resumeObserve(v, m, ctx = {}) {
    const before = v.groups.reduce((a, g) => a + (lastPaused.get(g.id) === false ? drawOf(v, g) * g.count : 0), 0), have = powerHave(v), bought = boughtPower(v, ctx);
    // With Auto power on, the subscription follows the running load, so being under the unpaused draw is not a short bill.
    // Power bought on contracts covers part of the draw; only the rest has to be subscribed (and billed).
    const billShort = (ctx.mods?.autoUtil?.conf?.power?.on !== true && have + bought < before) || v.money < Math.max(have, before - bought) * 1000 * 2;
    const sent = ctx.pauseSent ?? {}, grace = (cfg.resumeGraceMin ?? 2) * 60000;
    const o = m.get(), bill = new Set(o.bill ?? []), user = new Set(o.user ?? []);
    let changed = false;
    for (const g of v.groups) {
      const prev = lastPaused.get(g.id);
      if (g.paused && prev !== true && !bill.has(g.id) && !user.has(g.id)) { (prev === false && billShort && drawOf(v, g) > 0 && !(ctx.now - sent[g.id] < grace) ? bill : user).add(g.id); changed = true; }
      if (!g.paused && (bill.delete(g.id) | user.delete(g.id))) changed = true;
      lastPaused.set(g.id, !!g.paused);
    }
    if (changed) m.set({ bill: [...bill], user: [...user] });
  }
  // Groups Autopilot's earlyGame.keepPaused(id) marked: never resumed. Autopilot does not expose the list; it saves it in localStorage
  // 'earlyGame.v2' (.keptPaused). Read at call time; a missing key, bad JSON or a non-array is an empty list.
  function keptPaused() {
    try { const a = JSON.parse(W.localStorage?.getItem('earlyGame.v2') ?? 'null')?.keptPaused; return Array.isArray(a) ? a.map(Number) : []; } catch { return []; }
  }
  // One SetPaused false per step once the bills are affordable: cash >= Autopilot's floor (1 h of bills, min $100, the group counted)
  // + one bill for it, and the subscription covers the load with it. Groups a director paused on purpose (Kiln gate, WF gate,
  // endgame stock gate) and Autopilot's kept-paused ones stay.
  function resumeDecide(v, ctx) {
    if (!ctx.mem) return null;
    const bo = ctx.mem('buildout').get(), em = ctx.mem('endgame').get();
    const mine = new Set([...(bo.kilnMine ?? []), ...(bo.ftMine ?? []), ...(em.egMine ?? []), ...(ctx.apKept ?? [])]);
    const bill = new Set(ctx.mem('resume').get().bill ?? []);
    const list = v.groups.filter((g) => g.paused && g.count > 0 && bill.has(g.id) && !mine.has(g.id));
    if (!list.length) return null;
    const eg = ctx.mods?.earlyGame;
    if (eg?.running && eg.cfg?.resumePaused !== false) return { wait: 'Autopilot resumes the ' + list.length + ' bill-paused group(s) while it runs' };   // one driver per job
    const have = powerHave(v), bought = boughtPower(v, ctx), load = powerLoad(v), waits = [], autoOn = ctx.mods?.autoUtil?.conf?.power?.on === true;
    for (const g of list) {
      const mw = drawOf(v, g) * g.count, name = '"' + (g.name ?? v.bld(g.building).name) + '"';
      // With Auto power on the subscription follows running load and Auto raises it once the group runs: only cash gates the resume.
      if (!autoOn && have + bought < load + mw) { waits.push(name + ' is paused (unpaid bill?): power subscription ' + have + ' MW' + (bought > 0 ? ' + ' + bought + ' MW bought' : '') + ' < ' + (load + mw) + ' MW with it'); continue; }
      const need = Math.max(10000, (Math.max(have, load - bought) + mw) * 1000 * 6) + mw * 1000;
      if (v.money < need) { waits.push(name + ' is paused (unpaid bill?): waiting for cash ' + usd(v.money) + ' / ' + usd(need) + ' to resume'); continue; }
      return { action: { id: 'resume:' + g.id, text: 'resume ' + name + ' (paused by an unpaid bill, bills affordable again)',
        steps: [{ msg: { type: 'SetPaused', group: g.id, paused: false }, until: (x) => !x.groups.find((y) => y.id === g.id)?.paused }] } };
    }
    return { wait: waits.join(' | ') };
  }

