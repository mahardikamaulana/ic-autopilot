// ============================================================================
// CORE PLAN DIRECTOR: 7. Lab preset and module installer (wiki core-game-plan.md section 10)
// ============================================================================
// Director "lab" (order 55), one action per step:
//   0. Second Lab (wiki 10 "build one", plan D2): with 1 Lab owned and cfg.labTarget 2, buy one on free acres above the buffer (else its own acres while the land rule is open) once the
//      Iron Frames the unlocks still need are kept back and cash covers the money floor, the Lab and its bill floor; then into the Lab group.
//   1. Lab group: a Manufacturing Lab sitting in the building pool gets its own group (CreateGroup), so modules can sit on it.
//   2. Lab preset: while Core plan is live, a dry-run or reloaded Lab runner is started live with the Tier I list from wiki 10
//      step 1 (Bookshelf / Table / Chair on Quality engineering, Planks on Process study), or on your own setting once you have
//      changed it. A live Lab runner is never touched. A dry-run or stopped Lab runner is an alert, never silent.
//   3. Modules: Auto modules (src/auto-modules.js) arranges every socket; this director only shows its readout.
//   2b. The preset list follows the retail allocator (plan D1): Quality engineering on the top planned good by $/h, then Planks Process study.
//   4. Adopt: a Lab result strictly better than a running furniture group's recipe: its floor copied (EditLayout), then SetRecipe (plan D1).
// Manual only (spends money on the market, or not clearly better): Module Exchange, other Process results.
// @@MODULE cp-lab
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const REGION = 0, ACRE_CAP = 360;
  const PD = W.idleCore.plans.current().core.directors.lab, T = PD.tables;   // plan data and settings (src/core-plans.js)
  const FURNITURE = T.furniture;
  // wiki 10 step 1: product name, focus (0 Process study, 2 Quality engineering), Tier I pinned.
  const PRESET = T.preset;
  const PRESET_BACKOFF = 10 * 60000;   // after a failed preset, leave the Lab runner alone this long (so modules still get their turn)
  const LAB = 'lab';

  const freeModules = (v) => W.idleCore.modules.freeModules(v.st);
  const groupLabel = (v, g) => 'group ' + g.id + ' (' + (g.name || v.bld(g.building).name) + ')';

  // The list with ids by name; null when a name is missing (the preset is then off, with a readout).
  // With the retail allocator's plan (plan D1): Quality engineering on the planned good with the most $/h first, then a Planks process study,
  // then the other planned goods by $/h; Quality engineering at Tier II when MD > cfg.mdRich and RD >= T.tier2Rd (Tier II also costs that much RD).
  // Without a plan: the wiki 10 Tier I list.
  function presetList(v, ctx = {}) {
    let al = null;
    try { al = ctx.retail?.goods ? W.corePlan._buildout?.alloc?.(v, ctx) ?? null : null; } catch { al = null; }
    const ph = (g) => (al?.alloc?.[g.id] ?? 0) * g.unit * g.blockH;   // planned $/h (cents): Workshops x unit price x units per Workshop-hour
    const top = al ? ctx.retail.goods.filter((g) => ph(g) > 0).sort((a, b) => ph(b) - ph(a)) : [];
    const rich = (v.st.items?.[v.idI('Manufacturing Data')] ?? 0) > W.corePlan.cfg.mdRich && (v.st.items?.[v.idI('Research Data')] ?? 0) >= T.tier2Rd;
    const rows = top.length ? [[top[0].name, 2], ['Planks', 0], ...top.slice(1).map((g) => [g.name, 2])] : PRESET;
    const list = rows.map(([n, focus]) => ({ product: v.idI(n), focus, tier: top.length && focus === 2 && rich ? 2 : 1 }));
    return list.some((e) => e.product == null) ? null : Object.assign(list, { label: top.length ? 'allocator list' : 'Tier I list' });
  }
  const listText = (v, list) => list.map((e) => v.C.items[e.product]?.name + (e.focus === 2 ? ' quality' : ' process') + (e.tier === 2 ? ' (Tier II)' : '')).join(', ');
  const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((e, i) => e && e.product === b[i].product && e.focus === b[i].focus && e.tier === b[i].tier);

  // Lab preset: what to do with the Lab runner. Returns { action?, alert?, note }.
  // Rule: a live Lab runner is never touched (whatever its setting: the list is yours to edit, wiki 10 step 2).
  // Only a dry run or a reload (stopped, no stop reason) is (re)started live.
  function presetStep(v, ctx, cfg) {
    const lr = ctx.mods?.labRunner;
    if (!cfg.labPreset) return { note: 'preset off (cfg.labPreset)', alert: lr && lr.running && lr.cfg?.dryRun && ctx.live ? 'ALERT: the Lab runner is a dry run while Core plan is live, the Lab sends nothing' : null };
    if (!lr) return { note: 'Lab runner not loaded' };
    if (v.owned('Manufacturing Lab') < 1) return { note: 'no Manufacturing Lab yet' };
    const list = presetList(v, ctx);
    if (!list) return { note: 'preset off: an item of the Tier I list is missing from the catalog', alert: 'ALERT: Lab preset items not found by name' };
    const c = lr.cfg ?? {};
    if (lr.running && !c.dryRun) {
      if (c.mode === 'list' && sameList(c.list, list)) return { note: 'Lab runner live on the ' + list.label + ' (' + listText(v, list) + ')' };
      // still on the list Core plan applied (you did not change it) but the plan moved: restart it live on the new list (never over your own edit)
      const ma = ctx.mem?.(LAB)?.get?.() ?? {};
      if (ctx.live && ma.applied != null && sigOf(c) === ma.applied && !(ma.presetFailAt != null && ctx.now - ma.presetFailAt < PRESET_BACKOFF))
        return { note: 'Lab runner live on an older preset list', action: { id: 'lab:preset', text: 'Lab runner: restart live on the ' + list.label + ' (' + listText(v, list) + '): the plan changed', run: () => applyPreset(lr, list, ctx) } };
      return { note: 'Lab runner live on your own setting (' + (c.mode ?? '?') + '): left alone' };
    }
    const state = lr.running ? 'running as a dry run' : 'stopped';
    const alert = lr.running ? 'ALERT: the Lab runner is a dry run' + (ctx.live ? ' while Core plan is live: the Lab sits idle' : '') : null;
    if (!ctx.live) return { note: 'Lab runner ' + state + '; the preset is applied once Core plan runs live', alert };
    const mark = marks.get(lr) ?? {};
    // An explicit stop (by you, or the Lab runner's own failure stop) is respected: only a reload (no stop reason) or our own stop is re-armed.
    if (!lr.running && lr.stopReason && !mark.selfStopped) return { note: 'Lab runner stopped (' + lr.stopReason + '): not restarting it', alert: 'ALERT: the Lab runner is stopped (' + lr.stopReason + '), the Lab sits idle' };
    // Live was refused by the Lab runner itself (its game-data check): retrying only re-fires its refusal, so wait for you.
    if (mark.refused && lr.running) return { note: 'Lab runner refused Live: left as a dry run', alert: 'ALERT: the Lab runner refuses Live (see its ledger: game data check); start it live by hand once fixed' };
    const m = ctx.mem?.(LAB)?.get?.() ?? {};
    if (m.presetFailAt != null && ctx.now - m.presetFailAt < PRESET_BACKOFF) return { note: 'preset failed recently, trying again in ' + Math.ceil((PRESET_BACKOFF - (ctx.now - m.presetFailAt)) / 60000) + ' min', alert: alert ?? 'ALERT: the Lab preset did not take' };
    // Mode and list survive a reload (only dryRun resets). If they differ from what this director last applied, you changed them: keep yours.
    const own = m.applied != null && sigOf(c) !== m.applied;
    const verb = lr.running ? 'restart' : 'start';
    const text = own ? 'Lab runner: ' + verb + ' live on your own setting (' + (c.mode ?? '?') + ')' : 'Lab runner: ' + verb + ' live on the ' + list.label + ' (' + listText(v, list) + ')';
    return { alert, note: 'Lab runner ' + state, action: { id: 'lab:preset', text, run: () => applyPreset(lr, own ? null : list, ctx) } };
  }
  const sigOf = (c) => JSON.stringify([c.mode ?? null, c.mode === 'list' ? (c.list ?? []).map((e) => [e?.product, e?.focus, e?.tier]) : null]);
  // Per Lab runner, in memory only (a reload resets the runner's stopReason too): did we stop it, did it refuse Live.
  const marks = new WeakMap();
  const mark = (lr, patch) => marks.set(lr, { ...(marks.get(lr) ?? {}), ...patch });
  const timing = { pollMs: 100, polls: 100 };   // wait up to 10 s for the runner to finish its step after stop()
  // The only impure part: stop the Lab runner (it finishes its step first), then start it live, with the list or on its own setting.
  // Returns true when it ends up live, else null: the server is not involved, so a refusal must not count toward Core plan's fail stop.
  async function applyPreset(lr, list, ctx) {
    const mem = ctx.mem(LAB);
    const sleep = W.idleCore?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (lr.running) { mark(lr, { selfStopped: true }); lr.stop(); }
    for (let i = 0; i < timing.polls && lr.active; i++) await sleep(timing.pollMs);
    if (lr.active || lr.running) { mem.set({ presetFailAt: Date.now() }); return null; }   // still finishing a step: selfStopped stays, retry after the back-off
    lr.start(list ? { dryRun: false, mode: 'list', list: list.map((e) => ({ ...e })) } : { dryRun: false });
    if (!lr.running) { mem.set({ presetFailAt: Date.now() }); return null; }
    mark(lr, { selfStopped: false });
    if (lr.cfg?.dryRun) { mark(lr, { refused: true }); return null; }
    if (list && !(lr.cfg?.mode === 'list' && sameList(lr.cfg.list, list))) { mem.set({ presetFailAt: Date.now() }); return null; }
    mem.set({ presetFailAt: null, presetAt: Date.now(), ...(list ? { applied: sigOf(lr.cfg) } : {}) });
    return true;
  }

  // Second Lab (wiki 10 "build one", plan D2), only while one is owned and cfg.labTarget asks for more, up to T.maxLabs. Pure. Gates: the Iron Frames the
  // unlocks still need (ifNeed) stay back; acres above the CD-farm buffer, else its own acres bought in the same action while the land rule is
  // open (as buildout Stage C-D: acresOwned + acres <= min(rule.lastAcre, 360)); cash for the money floor + land + the Lab + its bill floor.
  // No free acre and the rule closed: not wanted, so E5 is never held by a Lab that cannot be placed.
  function labBuy(v, ctx, cfg, rule, stage) {
    const lab = v.idB('Manufacturing Lab');
    if (lab == null) return { note: 'no Manufacturing Lab in the catalog' };
    const owned = v.owned('Manufacturing Lab');
    if (owned < 1 || owned >= Math.min(cfg.labTarget, T.maxLabs)) return { note: owned + ' Manufacturing Lab' + (owned === 1 ? '' : 's') + ' (target ' + cfg.labTarget + ')' };
    const usd = W.corePlan._usd, bd = v.bld(lab), floor = ctx.floorCents ?? 0;
    const free = v.freeAcres - cfg.bufferAcres, acres = Math.max(0, bd.acres - Math.max(0, free)), cap = Math.min(rule?.lastAcre ?? 0, ACRE_CAP);
    // Land for the Lab only in Stage C-D: in Stage A-B free land goes to engine blocks first (plan D-1).
    if (acres && !['C', 'D', 'END'].includes(stage)) return { note: 'second Lab: no free acre above the ' + cfg.bufferAcres + '-acre buffer (stage ' + (stage ?? '-') + ' buys no land for it)' };
    if (acres && v.acresOwned + acres > cap) return { note: 'second Lab: land rule closed (' + Math.max(0, free) + ' free acre(s) above the ' + cfg.bufferAcres + '-acre buffer, needs ' + bd.acres + '; ' + (rule ? 'acre #' + (v.acresOwned + acres) + ' is past #' + cap : 'no land rule') + ')' };
    const per = (bd.build_items ?? []).find((i) => i.item === v.idI('Iron Frame'))?.amount ?? 0, keep = W.corePlan._ifNeed(v, null), frames = v.has('Iron Frame');
    if (frames < keep + per) return { want: true, note: 'second Lab waits: Iron Frame ' + Math.floor(frames) + ' < ' + (keep + per) + ' (' + keep + ' kept for the unlocks + ' + per + ')' };
    let land = 0;
    for (let i = 0; i < acres; i++) land += W.corePlan._acrePriceCents(v.landBought + i);
    const price = W.idleCore.planner.price(bd.cost, v.ownedAll('Manufacturing Lab'), 0);
    const mw = bd.draws?.power ?? 0, bill = W.corePlan._billNeed(v, mw);
    const landTxt = acres ? acres + ' acre(s) ' + usd(land) + ' + ' : '';
    if (v.money < floor + land + price + bill) return { want: true, note: 'second Lab waits: cash ' + usd(v.money) + ' < ' + usd(floor + land + price + bill) + ' (money floor + ' + landTxt + 'Lab ' + usd(price) + ' + ' + mw + ' MW bills)' };
    const g = v.groups.find((x) => x.building === lab), steps = W.corePlan._buySteps(v, lab, acres, g, 'Manufacturing Lab', (v.pool[lab] ?? 0) + 1);
    const text = 'second Manufacturing Lab: buy ' + landTxt + usd(price) + (g ? ' into ' + groupLabel(v, g) : ' (new group)');
    return { want: true, note: text, action: { id: 'lab:buy:' + owned, text, steps, hold: true } };
  }

  // Adopt a Lab result (plan D1). A claimed Process / Quality result is a new recipe in st.recipes; a group adopts it with SetRecipe. Only
  // when it is strictly better than the running furniture group's recipe, per unit made: no more ticks, no input it lacks or more of one,
  // and higher quality (no more Planks) or fewer Planks (no lower quality). Floors belong to a recipe, so the group's floor is first copied
  // to the new recipe (EditLayout: no building runs it yet, so nothing is charged), and the switch waits until that floor runs at least
  // the old rate. One message per step; a paused group (the user's) is left alone. Pure: { action?, note }.
  function adoptStep(v, ctx = {}) {
    const ws = v.idB('Workshop'), pl = v.idI('Planks'), furn = FURNITURE.map((n) => v.idR(n)).filter((x) => x != null);
    const recOf = (id) => v.st.recipes?.[id] ?? v.C.recipes[id] ?? null;
    const per = (r) => { const o = r.outputs?.[0]?.amount || 1, inp = {}; for (const i of r.inputs ?? []) inp[i.item] = (inp[i.item] ?? 0) + i.amount / o; return { t: r.ticks / o, inp, q: r.quality ?? 0, pl: inp[pl] ?? 0 }; };
    const better = (c, cur) => {
      const a = per(c), b = per(cur), eps = 1e-9;
      if (c.building !== cur.building || c.outputs?.[0]?.item !== cur.outputs?.[0]?.item || a.t > b.t + eps) return false;
      if (Object.entries(a.inp).some(([i, x]) => !(i in b.inp) || x > b.inp[i] + eps)) return false;
      return (a.q > b.q && a.pl <= b.pl + eps) || (a.pl < b.pl - eps && a.q >= b.q);
    };
    const notes = [];
    for (const g of v.groups.filter((x) => x.building === ws && x.count > 0 && !x.paused && furn.includes(x.recipe)).sort((a, b) => b.count - a.count)) {
      const curId = g.process ?? g.recipe, cur = recOf(curId);
      if (!cur) continue;
      const cands = Object.values(v.st.recipes ?? {}).filter((c) => c.id !== curId && better(c, cur)).sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || per(a).pl - per(b).pl);
      const c = cands[0];
      if (!c) continue;
      const label = c.name + ' on ' + groupLabel(v, g) + ' (quality ' + (c.quality ?? 0) + ' vs ' + (cur.quality ?? 0) + ', Planks ' + +per(c).pl.toFixed(2) + ' vs ' + +per(cur).pl.toFixed(2) + ' per unit)';
      const floor = v.st.layouts?.[curId], has = v.st.layouts?.[c.id];
      if (!floor?.cells) { notes.push('adopt ' + label + ': waits, the group runs no saved floor to copy'); continue; }
      if (!has) {   // the shared floor wrapper: an EditLayout the server did not apply waits cfg.floorRetryMin (no fail-stop loop)
        const fa = W.corePlan._floorAction(ctx, LAB, 'adopt:' + c.id, c, floor.cells, 'adopt ' + label + ': the server did not apply the floor copy', { id: 'lab:adopt:floor:' + c.id, text: 'adopt Lab result: copy the floor of ' + cur.name + ' to ' + c.name });
        if (fa.action) return { note: 'adopt ' + label + ': copy its floor first', action: fa.action };
        notes.push(fa.wait); continue;
      }
      if ((has.fx?.rate ?? 1) < (floor.fx?.rate ?? 1)) { notes.push('adopt ' + label + ': waits, its floor runs at x' + (has.fx?.rate ?? 1) + ' < x' + (floor.fx?.rate ?? 1)); continue; }
      return { note: 'adopt ' + label, action: { id: 'lab:adopt:' + g.id + ':' + c.id, text: 'adopt Lab result ' + label,
        steps: [{ msg: { type: 'SetRecipe', group: g.id, recipe: c.id }, until: (x) => x.st.groups?.[g.id]?.recipe === c.id }] } };
    }
    return { note: notes.join('; ') || 'no Lab result beats a furniture recipe' };
  }

  const pendingInvest = (v, ctx, rule, stage) => (labBuy(v, ctx, W.corePlan.cfg, rule, stage).want ? [{ what: 'second Manufacturing Lab', paybackH: null }] : []);

  W.corePlan.addDirector({
    name: LAB, order: 55,
    defaults: W.idleCore.plans.copy(PD.defaults),
    // E5: the second Lab is an investment still to make while it is wanted and not bought.
    pendingInvest,
    context(v, ctx) {
      // A refusal mark lasts while the runner stays a dry run; once it stops or goes live, the preset may try again.
      const lr = ctx.mods?.labRunner;
      if (lr && marks.get(lr)?.refused && !(lr.running && lr.cfg?.dryRun)) mark(lr, { refused: false });
    },
    decide(v, ctx, out) {
      const cfg = W.corePlan.cfg;
      const readout = {};
      const waits = [];
      const actions = [];
      const lab = v.idB('Manufacturing Lab');

      // 0. Second Lab.
      const buy = labBuy(v, ctx, cfg, out?.rule, out?.stage);
      readout.secondLab = buy.note;
      if (buy.action) actions.push(buy.action);

      // 1. Lab group.
      const labGroup = lab != null && v.groups.find((g) => g.building === lab);
      const inPool = lab != null ? v.pool[lab] ?? 0 : 0;
      if (cfg.labGroup && lab != null && !labGroup && inPool > 0) {
        actions.push({ id: 'lab:group', text: 'create a group for the ' + inPool + ' Manufacturing Lab' + (inPool > 1 ? 's' : '') + ' in the pool',
          steps: [{ msg: { type: 'CreateGroup', building: lab, amount: inPool, name: 'Manufacturing Lab', region: REGION }, until: (x) => x.groups.some((g) => g.building === lab) }] });
      } else if (cfg.labGroup && labGroup && inPool > 0) {   // a bought Lab whose assign did not land joins the group
        const c0 = labGroup.count;
        actions.push({ id: 'lab:assign', text: 'assign the ' + inPool + ' Manufacturing Lab' + (inPool > 1 ? 's' : '') + ' in the pool to ' + groupLabel(v, labGroup),
          steps: [{ msg: { type: 'AssignBuildings', group: labGroup.id, amount: inPool }, until: (x) => (x.groups.find((g) => g.id === labGroup.id)?.count ?? 0) >= c0 + inPool }] });
      }
      readout.labGroup = labGroup ? groupLabel(v, labGroup) : inPool ? inPool + ' Lab in the pool, no group' : 'no Manufacturing Lab';

      // 2. Lab preset.
      const p = presetStep(v, ctx, cfg);
      readout.preset = p.note;
      if (p.alert) { readout.alert = p.alert; waits.push(p.alert); }
      if (p.action) actions.push(p.action);

      // 3. Modules: Auto modules owns every socket (src/auto-modules.js), so the two never fight over a module.
      readout.modules = [W.autoModules ? 'Auto modules ' + W.autoModules.status() : 'Auto modules not loaded'];

      // 4. Adopt Lab results that are strictly better (plan D1).
      if (cfg.labAdopt) {
        const ad = adoptStep(v, ctx);
        readout.adopt = ad.note;
        if (ad.action) actions.push(ad.action);
      } else readout.adopt = 'off (cfg.labAdopt)';

      // Manual work: no "adopt process" message exists in the protocol, and the Module Exchange spends money on unverified rows.
      const furn = FURNITURE.map((n) => v.idR(n)).filter((x) => x != null);
      const qg = v.groups.filter((g) => furn.includes(g.recipe)), pg = v.groups.filter((g) => g.recipe != null && g.recipe === v.idR('Saw Planks'));
      const results = (v.st.pending_results ?? []).length;
      readout.manual = [
        'adopt by hand: Quality engineering results that are not strictly better (more Planks or time) on ' + (qg.length ? qg.map((g) => groupLabel(v, g)).join(', ') : 'the furniture groups, none yet'),
        'adopt by hand: Process study results for Planks on ' + (pg.length ? pg.map((g) => groupLabel(v, g)).join(', ') : 'the Planks group, none yet') + ' if output per acre-second rises >= 3%',
        'Module Exchange: search "overclock" and buy modules for free Fell Wood sockets by hand',
        ...(results ? [results + ' Lab result' + (results > 1 ? 's' : '') + ' waiting to be claimed'] : []),
      ];
      if (out) out.labAlert = readout.alert ?? null;
      // One action per step: the first is the one the runner sends; the rest show up as waits so the readout says what comes next.
      return { action: actions[0], wait: [...actions.slice(1).map((a) => 'next: ' + a.text), ...waits].join(' | ') || undefined, readout };
    },
    duties: () => [
      { duty: 'Lab: Tier I list re-armed live after each reload', owner: 'Core plan', done: true },
      { duty: 'modules: arranged over the group sockets for the most value', owner: 'Auto modules', done: true },
    ],
  });
  W.corePlan._lab = { freeModules, presetList, adoptStep, timing, labBuy, pendingInvest };
})();
} catch (e) { console.error('[IdleCorp] cp-lab failed to load:', e); }
// @@END cp-lab