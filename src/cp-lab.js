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
//   3. Modules: each free module (in no group, not in the fleet) goes by the install table: Overclock (kind 61) -> Fell Wood,
//      Refiner (kind 62) -> furniture Workshops (never an Overclock on a Workshop: it raises plank use), Insightful quirk -> Lab.
//      A quirk that names a cell (e.g. CornerTuned "1,-1") is installed only in that cell. Stacking is unverified (risk R2), so
//      after the first module of a kind on a group no second one goes there until cfg.modulesStackOk is true.
// Manual only (no message in the protocol, or spends money on the market): adopting Process / Quality results, Module Exchange.
// @@MODULE cp-lab
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (!W.corePlan?.addDirector) throw new Error('Core plan did not load');
  const REGION = 0, SOCKETS = 6, ACRE_CAP = 360;
  const CELLS = ['0,-1', '1,-1', '-1,0', '1,0', '-1,1', '0,1'];
  const OVERCLOCK = 61, REFINER = 62;
  const KIND_NAME = { [OVERCLOCK]: 'Overclock', [REFINER]: 'Refiner' };
  const FURNITURE = ['Make Bookshelf', 'Make Table', 'Make Chair', 'Make Bench'];
  // wiki 10 step 1: product name, focus (0 Process study, 2 Quality engineering), Tier I pinned.
  const PRESET = [['Bookshelf', 2], ['Planks', 0], ['Table', 2], ['Chair', 2]];
  const PRESET_BACKOFF = 10 * 60000;   // after a failed preset, leave the Lab runner alone this long (so modules still get their turn)
  const LAB = 'lab';

  // A socket holds a module id (a number, possibly 0) or an object with an id.
  const modId = (m) => (m != null && typeof m === 'object' ? m.id : m);
  const same = (a, b) => a != null && b != null && String(a) === String(b);
  const fleetIds = (st) => {
    const f = st.fleet_modules;
    if (f == null) return [];
    const vals = Array.isArray(f) ? f : Object.values(f);
    return vals.map(modId).filter((x) => x != null);
  };
  const usedCells = (g) => Object.entries(g.modules ?? {}).filter(([, m]) => modId(m) != null);
  const defOf = (v, id) => v.st.module_defs?.[id] ?? Object.values(v.st.module_defs ?? {}).find((d) => same(d.id, id)) ?? null;
  const modName = (d) => d.name ?? (KIND_NAME[d.kind] ?? 'kind ' + d.kind) + ' module #' + d.id;

  // Free modules: defined, in no group's sockets (any region) and not in a fleet socket.
  function freeModules(v) {
    const used = new Set(fleetIds(v.st).map(String));
    for (const g of Object.values(v.st.groups ?? {})) for (const [, m] of usedCells(g)) used.add(String(modId(m)));
    return Object.values(v.st.module_defs ?? {}).filter((d) => d?.id != null && !used.has(String(d.id))).sort((a, b) => a.id - b.id);
  }
  const groupLabel = (v, g) => 'group ' + g.id + ' (' + (g.name || v.bld(g.building).name) + ')';

  // The groups a module may go to, by the install table, and the reason when none qualifies.
  function targetsFor(v, d) {
    const lab = v.idB('Manufacturing Lab'), ws = v.idB('Workshop'), camp = v.idB('Lumber Camp'), fell = v.idR('Fell Wood');
    const furn = FURNITURE.map((n) => v.idR(n)).filter((x) => x != null);
    if ((d.quirks ?? []).some((q) => q?.kind === 'Insightful')) return { kind: 'Lab', groups: v.groups.filter((g) => g.building === lab && lab != null) };
    if (d.kind === OVERCLOCK) return { kind: 'Fell Wood', groups: v.groups.filter((g) => g.building === camp && g.recipe === fell && camp != null && fell != null) };
    if (d.kind === REFINER) return { kind: 'furniture Workshop', groups: v.groups.filter((g) => g.building === ws && ws != null && furn.includes(g.recipe)) };
    return null;
  }

  // The next install, or the reasons nothing can be installed. Pure.
  function planInstall(v, cfg) {
    const ws = v.idB('Workshop');
    const notes = [];
    for (const d of freeModules(v)) {
      const t = targetsFor(v, d);
      const name = modName(d);
      if (!t) { notes.push('manual: ' + name + ' (kind ' + d.kind + ') has no rule in the install table, install it by hand'); continue; }
      const cellQ = (d.quirks ?? []).find((q) => q && typeof q.cell === 'string' && CELLS.includes(q.cell));
      const why = [];
      const ok = [];
      for (const g of t.groups) {
        if (!(g.count > 0)) continue;
        if (d.kind === OVERCLOCK && g.building === ws) continue;   // never: an Overclock on a Workshop raises plank use
        const cells = usedCells(g);
        if (cells.length >= SOCKETS) { why.push(groupLabel(v, g) + ' has all ' + SOCKETS + ' sockets full'); continue; }
        const stacked = cells.some(([, m]) => defOf(v, modId(m))?.kind === d.kind);
        if (stacked && !cfg.modulesStackOk) { why.push(groupLabel(v, g) + ' already has a ' + (KIND_NAME[d.kind] ?? 'kind ' + d.kind) + ': stacking is unverified, read its speed, then corePlan.importCfg({ modulesStackOk: true })'); continue; }
        const taken = new Set(cells.map(([c]) => c));
        const cell = cellQ ? (taken.has(cellQ.cell) ? null : cellQ.cell) : CELLS.find((c) => !taken.has(c));
        if (cell == null) { why.push(groupLabel(v, g) + ': cell ' + cellQ.cell + ' (' + cellQ.kind + ') is taken'); continue; }
        ok.push({ g, cell });
      }
      if (!ok.length) { notes.push(name + ': ' + (why.length ? why.join('; ') : 'no ' + t.kind + ' group yet')); continue; }
      ok.sort((a, b) => b.g.count - a.g.count || a.g.id - b.g.id);   // a module is worth more on a bigger group
      const { g, cell } = ok[0];
      return { install: { d, g, cell, name, text: 'install ' + name + ' in ' + groupLabel(v, g) + ' cell ' + cell + (cellQ ? ' (' + cellQ.kind + ')' : '') }, notes };
    }
    return { install: null, notes };
  }

  // The Tier I list with ids by name; null when a name is missing (the preset is then off, with a readout).
  function presetList(v) {
    const list = PRESET.map(([n, focus]) => ({ product: v.idI(n), focus, tier: 1 }));
    return list.some((e) => e.product == null) ? null : list;
  }
  const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((e, i) => e && e.product === b[i].product && e.focus === b[i].focus && e.tier === b[i].tier);

  // Lab preset: what to do with the Lab runner. Returns { action?, alert?, note }.
  // Rule: a live Lab runner is never touched (whatever its setting: the list is yours to edit, wiki 10 step 2).
  // Only a dry run or a reload (stopped, no stop reason) is (re)started live.
  function presetStep(v, ctx, cfg) {
    const lr = ctx.mods?.labRunner;
    if (!cfg.labPreset) return { note: 'preset off (cfg.labPreset)', alert: lr && lr.running && lr.cfg?.dryRun && ctx.live ? 'ALERT: the Lab runner is a dry run while Core plan is live, the Lab sends nothing' : null };
    if (!lr) return { note: 'Lab runner not loaded' };
    if (v.owned('Manufacturing Lab') < 1) return { note: 'no Manufacturing Lab yet' };
    const list = presetList(v);
    if (!list) return { note: 'preset off: an item of the Tier I list is missing from the catalog', alert: 'ALERT: Lab preset items not found by name' };
    const c = lr.cfg ?? {};
    if (lr.running && !c.dryRun) return { note: c.mode === 'list' && sameList(c.list, list) ? 'Lab runner live on the Tier I list' : 'Lab runner live on your own setting (' + (c.mode ?? '?') + '): left alone' };
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
    const text = own ? 'Lab runner: ' + verb + ' live on your own setting (' + (c.mode ?? '?') + ')' : 'Lab runner: ' + verb + ' live on the Tier I list (Bookshelf, Planks, Table, Chair)';
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

  // Second Lab (wiki 10 "build one", plan D2), only while one is owned and cfg.labTarget asks for 2 (never more). Pure. Gates: the Iron Frames the
  // unlocks still need (ifNeed) stay back; acres above the CD-farm buffer, else its own acres bought in the same action while the land rule is
  // open (as buildout Stage C-D: acresOwned + acres <= min(rule.lastAcre, 360)); cash for the money floor + land + the Lab + its bill floor.
  // No free acre and the rule closed: not wanted, so E5 is never held by a Lab that cannot be placed.
  function labBuy(v, ctx, cfg, rule, stage) {
    const lab = v.idB('Manufacturing Lab');
    if (lab == null) return { note: 'no Manufacturing Lab in the catalog' };
    const owned = v.owned('Manufacturing Lab');
    if (owned !== 1 || cfg.labTarget < 2) return { note: owned + ' Manufacturing Lab' + (owned === 1 ? '' : 's') + ' (target ' + cfg.labTarget + ')' };
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

  const pendingInvest = (v, ctx, rule, stage) => (labBuy(v, ctx, W.corePlan.cfg, rule, stage).want ? [{ what: 'second Manufacturing Lab', paybackH: null }] : []);

  W.corePlan.addDirector({
    name: LAB, order: 55,
    defaults: { labPreset: true, labGroup: true, labModules: true, modulesStackOk: false, labTarget: 2 },
    // E5: the second Lab is an investment still to make while it is wanted and not bought.
    pendingInvest,
    // Records every installed module once (group, kind, cell, first seen) for the readout. Stacking (R2) is not measured here:
    // what group.work fields mean is unverified, so you read the group's speed and set modulesStackOk.
    context(v, ctx) {
      // A refusal mark lasts while the runner stays a dry run; once it stops or goes live, the preset may try again.
      const lr = ctx.mods?.labRunner;
      if (lr && marks.get(lr)?.refused && !(lr.running && lr.cfg?.dryRun)) mark(lr, { refused: false });
      const mem = ctx.mem?.(LAB);
      if (!mem) return;
      const seen = mem.get().installs ?? [];
      const add = [];
      for (const g of v.groups) for (const [cell, m] of usedCells(g)) {
        const id = modId(m);
        if (seen.some((x) => same(x.module, id) && x.group === g.id)) continue;
        add.push({ module: id, group: g.id, kind: defOf(v, id)?.kind ?? null, cell, at: ctx.now });
      }
      if (add.length) mem.set({ installs: [...seen, ...add] });
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

      // 3. Modules.
      if (cfg.labModules) {
        const { install, notes } = planInstall(v, cfg);
        readout.modules = notes;
        if (install) {
          const { d, g, cell } = install;
          actions.push({ id: 'lab:module:' + d.id, text: install.text,
            steps: [{ msg: { type: 'InstallModule', group: g.id, cell, module: d.id }, until: (x) => same(modId(x.groups.find((y) => y.id === g.id)?.modules?.[cell]), d.id) }] });
        } else if (notes.length) waits.push('modules: ' + notes[0]);
        readout.installs = (ctx.mem?.(LAB)?.get?.().installs ?? []).map((x) => {
          const d = defOf(v, x.module);
          // formulas.md: Overclock speed +25% - ticks_bonus, Refiner -10% - ticks_bonus (raw ticks_bonus shown: its unit is unverified).
          const exp = d?.kind === OVERCLOCK ? ' (expected speed +25% - ticks_bonus ' + d.ticks_bonus + ')' : d?.kind === REFINER ? ' (expected speed -10% - ticks_bonus ' + d.ticks_bonus + ')' : '';
          return (KIND_NAME[x.kind] ?? 'kind ' + x.kind) + ' #' + x.module + ' on group ' + x.group + ' cell ' + x.cell + exp;
        });
      } else readout.modules = ['module installer off (cfg.labModules)'];

      // Manual work: no "adopt process" message exists in the protocol, and the Module Exchange spends money on unverified rows.
      const furn = FURNITURE.map((n) => v.idR(n)).filter((x) => x != null);
      const qg = v.groups.filter((g) => furn.includes(g.recipe)), pg = v.groups.filter((g) => g.recipe != null && g.recipe === v.idR('Saw Planks'));
      const results = (v.st.pending_results ?? []).length;
      readout.manual = [
        'adopt by hand: Quality engineering results on ' + (qg.length ? qg.map((g) => groupLabel(v, g)).join(', ') + ' (one group first)' : 'the furniture groups, none yet'),
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
      { duty: 'modules: install free modules by the wiki 10 table', owner: 'Core plan', done: true },
      { duty: 'confirm module stacking (R2): read the group speed after the first Overclock, then corePlan.importCfg({ modulesStackOk: true })', owner: 'you', done: false },
    ],
  });
  W.corePlan._lab = { freeModules, planInstall, presetList, CELLS, timing, labBuy, pendingInvest };
})();
} catch (e) { console.error('[IdleCorp] cp-lab failed to load:', e); }
// @@END cp-lab