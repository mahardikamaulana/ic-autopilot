// continues the cd-farm closure from cd-farm-3.js (same try / IIFE)
  // ---- game UI -----------------------------------------------------------
  // The CD Farm panel, built from the shared parts in core-form.js (core.ui): Status (hero, rows, state), Settings (the same
  // groups, controls and Backup as the other panels), Log, and a footer with the plan and the start button. Styled with the
  // game's own CSS variables and button classes, so it reads as part of the app: a "CD Farm" tab in the sidebar, a chip in the
  // top bar, and a card that opens from either.

  const UI_KEY = 'cdFarm.ui';
  const ui = (() => { try { return { open: false, x: null, y: null, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch { return { open: false, x: null, y: null }; } })();
  const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };

  const ICON = '<svg class="nav-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="6" height="6" rx="1" fill="currentColor"></rect><rect x="11" y="11" width="6" height="6" rx="1"></rect><rect x="7" y="3" width="6" height="6" rx="1" style="stroke:var(--nav-accent)"></rect></svg>';

  const h = core.h;
  const K = core.ui;

  let P = null, chrome = null, timer = null, ctlTimer = null, discardUntil = 0;
  const refs = {};

  function tone() {
    if (running) return /waiting|reconnect/.test(phase) ? 'wait' : 'run';
    if (resumable || /^error/.test(stopReason)) return 'err';
    return '';
  }
  const stateText = () => (running ? phase + (stats.by ? ` · ${stats.by}` : '') : resumable ? 'Interrupted — resume available' : (isAuto() && cfg.autoStart && idleNote ? 'Auto: ' + idleNote : stopReason || 'Idle'));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // ---- settings form ----
  // Amounts accept "100k", "1.5m", "$100,000". Every change is checked against the live game state, problems show next
  // to the field they come from, and Start needs a second click after reading the plan summary.

  const MODES = [
    { id: 'floor', label: 'Keep a floor', desc: 'Spends money above the floor. At the floor it waits for income, then keeps going.' },
    { id: 'income', label: 'Income only', desc: 'Spends only money earned after you press Start. What you have at Start (or the floor, if higher) is kept.' },
    { id: 'reserve', label: 'Spend down', desc: 'Spends money above the floor once, then stops.' },
  ];

  const FIELDS = {
    minMoney: { kind: 'money', label: 'Money floor' },
    autoFloor: { kind: 'money', label: 'Extra money floor', min: 0 },
    targetCd: { kind: 'count', label: 'Target CD', optional: true, empty: 'No target' },
    batch: { kind: 'count', label: 'Buildings per cycle', min: 1, max: 100 },
    reserveAcres: { kind: 'count', label: 'Spare acres', min: 0 },
    maxSpendPerMin: { kind: 'money', label: 'Max spend per minute', optional: true, empty: 'No limit' },
  };
  const FLOOR_CHIPS = [50000, 100000, 250000, 1000000];
  const TARGET_STEPS = [1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6];
  const PACE_DESC = { thrifty: 'Cheapest CD, small batches, slow.', balanced: 'Bigger batches while the time saved is worth the cash.', fast: 'As fast as cash and free acres allow.' };
  const LAND_OFF = 'Never buys acres. Logs what more land would save.';
  const LAND_PLAN = 'Buys an acre only while acres limit the batch, the CD it saves is worth more than the acre, the price is under Autopilot\'s land price limit, and the cash floor holds.';
  const AUTO_BLD = 'Picks the cheapest CD source every cycle from what is unlocked, in surplus and affordable. Never buys materials.';
  const AMOUNTS = ['minMoney', 'autoFloor', 'targetCd', 'batch', 'reserveAcres', 'maxSpendPerMin'];
  const FLOOR_ITEMS = FLOOR_CHIPS.map((v) => [v, '$' + K.short(v)]);
  const targetItems = (r) => [...TARGET_STEPS.filter((v) => v > r.cd).slice(0, 5).map((v) => [v, K.short(v)]), [Infinity, 'None']];
  let confirmUntil = 0;

  function parseField(key, text) {
    const f = FIELDS[key];
    const s = text.trim();
    if (s === '') return f.optional ? { v: Infinity } : { err: 'Required.' };
    const v = K.parseAmount(s);
    if (v == null) return { err: f.kind === 'money' ? 'Use an amount like 100k, 1.5m or 100,000.' : 'Use a number like 20k or 20,000.' };
    if (f.min != null && v < f.min) return { err: `Must be at least ${fmt(f.min)}.` };
    if (f.max != null && v > f.max) return { err: `Must be at most ${fmt(f.max)}.` };
    return { v };
  }
  function setCfg(key, v) { cfg[key] = v; confirmUntil = 0; save(); render(); }
  // An amount field: a bad entry also drops the Start confirmation, so it never starts on a value you can't see.
  function amountOf(key, extra = []) {
    const f = FIELDS[key];
    return K.amountField({
      label: f.label, prefix: f.kind === 'money' ? '$' : '', placeholder: f.empty || '', extra,
      parse: (t) => { const p = parseField(key, t); if (p.err) confirmUntil = 0; return p; },
      format: (v) => (Number.isFinite(v) ? fmt(v) : ''), get: () => cfg[key], set: (v) => setCfg(key, v), def: DEFAULTS[key], redraw: render,
    });
  }

  // Floor the run would use if started now.
  const plannedFloor = (r) => r.moneyFloor;   // read() gives the floor a run started now would use
  const netPerCd = (r) => (campCost(r.ownedCamps, cfg.batch) - cfg.batch * unitRefund()) / cfg.batch;


  // [{ field, level: 'error' | 'warn', text }]. Errors block Start.
  function checkPlan(r) {
    const out = [];
    const floor = plannedFloor(r);
    if (Number.isFinite(cfg.targetCd) && cfg.targetCd <= r.cd) {
      out.push({ field: 'targetCd', level: 'error', text: `You already have ${fmt(r.cd)} CD. Pick a higher target.` });
    }
    const usable = Math.max(0, r.freeAcres - cfg.reserveAcres);
    const want = cfg.fullBatch ? cfg.batch : 1;
    if (usable < want) {
      out.push({ field: 'land', level: 'error', text: usable === 0
        ? `No free acres beyond the ${cfg.reserveAcres} spare (${r.freeAcres} free). Buy land or lower Spare acres in Advanced.`
        : `A full batch needs ${cfg.batch} free acres beyond the ${cfg.reserveAcres} spare; you have ${usable}. Buy ${cfg.batch - usable} acres, lower Spare acres, or turn off Full batches.` });
    }
    const batchCost = campCost(r.ownedCamps, want);
    const room = r.money - floor;
    if (cfg.budget === 'reserve' && room < batchCost) {
      out.push({ field: 'minMoney', level: 'error', text: `Only $${fmt(Math.max(0, room))} above the floor, and a batch costs $${fmt(batchCost)}. Spend down would stop right away.` });
    } else if (cfg.budget === 'floor' && room < batchCost) {
      out.push({ field: 'minMoney', level: 'warn', text: `It will wait until you earn $${fmt(batchCost - room)} more before the first batch.` });
    } else if (cfg.budget === 'income' && floor > r.money) {
      out.push({ field: 'minMoney', level: 'warn', text: `Money is below this floor; it will wait until money passes $${fmt(floor)}.` });
    }
    if (cfg.budget !== 'income' && floor < r.money * 0.1) {
      out.push({ field: 'minMoney', level: 'warn', text: `Low floor: up to $${fmt(r.money - floor)} of your $${fmt(r.money)} can be spent.` });
    }
    if (floor < cfg.minMoney) out.push({ field: 'minMoney', level: 'warn', text: `The default floor is capped at half your cash: $${fmt(floor)}. Set a floor to use your own.` });
    return out;
  }

  function planText(r) {
    const floor = plannedFloor(r);
    const per = netPerCd(r);
    const camps = `${cfg.fullBatch ? 'exactly' : 'up to'} ${cfg.batch} ${bld().plural}`;
    const parts = [cfg.budget === 'income'
      ? `Builds ${camps} at a time from new income only, keeping $${fmt(floor)}.`
      : `Builds ${camps} at a time while money is above $${fmt(floor)}.`];
    if (cfg.budget === 'reserve') parts.push(`Stops at the floor, about ${fmt(Math.max(0, Math.floor((r.money - floor) / per)))} CD from current cash.`);
    else parts.push('At the floor it waits for income.');
    if (Number.isFinite(cfg.targetCd) && cfg.targetCd > r.cd) {
      const left = cfg.targetCd - r.cd;
      parts.push(`Stops at ${fmt(cfg.targetCd)} CD: ${fmt(left)} more, about $${short(left * per)} net.`);
    } else if (!Number.isFinite(cfg.targetCd)) parts.push('No target: runs until you stop it.');
    return parts.join(' ');
  }

  const REGIONS = [{ id: 'auto', label: 'Auto' }, ...core.REGION_NAMES.map((label, id) => ({ id, label }))];
  function autoRows() {
    const ev = lastEval, c = ev?.c, m = core.measure.snapshot();
    const rows = [['Mode', `Auto · ${cap(cfg.pace)}${cfg.autoStart ? '' : ' · off'}`]];
    rows.push(['Why', cap(running ? phase : (idleNote || (ev?.idle ? ev.reason : '') || stopReason || 'idle'))]);
    if (ev?.need != null && c) rows.push(['Need', `${fmt(c.cd)} of ${fmt(ev.need)} CD${ev.next ? ' (' + ev.next.name + ')' : ''}`]);
    if (ev?.plan?.units?.length) rows.push(['Next cycle', `${unitsText(ev.plan.units)} · ${fmt(ev.plan.cdTotal)} CD · $${fmt(ev.plan.netCents / 100)} net`]);
    if (c) rows.push(['Free acres', `${c.freeAcres} of ${c.acresOwned} (${cfg.reserveAcres} spare)${c.region ? ' · ' + REGIONS[c.region + 1].label : ''}`]);
    if (ev?.floorC != null) rows.push(['Floor', `$${fmt(ev.floorC / 100)}`]);
    rows.push(['Cycles', `${fmt(stats.cycles)}${stats.built ? ` · +${fmt(stats.built)} CD` : ''}`], ['Net cost', stats.built ? `$${perCd()} / CD` : '—']);
    const rtt = m.rtt;
    rows.push(['Measured', rtt?.n ? `round trip ${Math.round(rtt.median)} ms (n=${rtt.n}) · cycle ${ev?.t ? ev.t.T.toFixed(1) : '—'} s · income $${fmt(Math.round((ev?.income ?? 0) / 100))}/h` : 'collecting samples…']);
    if (ev?.land?.note) rows.push(['Land', ev.land.note]);
    return rows;
  }
  function autoPlanText() {
    const ev = lastEval;
    const head = `Auto (${cap(cfg.pace)}): picks the cheapest CD source each cycle from what is unlocked, in surplus and affordable.`;
    if (!ev) return head;
    if (ev.idle) return `${head} Waiting: ${ev.reason}.`;
    if (ev.plan?.units.length) return `${head} Next: ${unitsText(ev.plan.units)} for $${fmt(ev.plan.netCents / 100)} net.`;
    return `${head} Waiting: ${ev.plan?.wait?.reason ?? 'nothing to build'}.`;
  }

  function onMain() {
    if (running) return stop();
    const arm = () => { if (cfg.building === 'auto' && !cfg.autoStart) { cfg.autoStart = true; save(); } };
    if (resumable) { arm(); return resume(); }
    if (Date.now() < confirmUntil) { confirmUntil = 0; arm(); return start(); }
    confirmUntil = Date.now() + 6000;
    render();
    setTimeout(render, 6100);
  }
  function onAlt() {
    if (Date.now() < confirmUntil) { confirmUntil = 0; return render(); }
    if (running || active) return;
    if (Date.now() < discardUntil) { discardUntil = 0; reset(); refs.main?.focus(); return; }   // second click: really do it; this button hides, so focus moves on
    discardUntil = Date.now() + 4000;
    render();
    setTimeout(render, 4100);
  }

  function buildPanel() {
    refs.badge = h('span', { class: 'idc-badge' });

    // ---- Status tab
    refs.hero = K.hero('Construction Data');
    refs.rows = K.rowList();
    refs.state = K.stateLine();
    const status = [refs.hero.el, refs.rows.el, refs.state.el];

    // ---- Settings tab
    refs.budget = K.segField('Budget', MODES, { get: () => cfg.budget, set: (id) => setCfg('budget', id), def: DEFAULTS.budget, describe: (v) => MODES.find((m) => m.id === v)?.desc || '' });
    refs.building = K.segField('Building', [{ id: 'auto', label: 'Auto' }, { id: 'cheapest', label: 'Cheaper' }, ...BUILDINGS.map((b) => ({ id: b.id, label: b.name }))], { get: () => cfg.building, set: (id) => setCfg('building', id), def: DEFAULTS.building });
    refs.region = K.segField('Region', REGIONS, { get: () => cfg.region, set: (id) => setCfg('region', id), def: DEFAULTS.region, describe: (v) => (v === 'auto' ? 'The region you hold with the most free acres; Heartland on a tie. Auto buys land only in Heartland.' : '') });
    refs.solo = K.toggleField('Run without Autopilot', 'With Autopilot and Core plan off and no Target CD, farms CD for the cheapest tech you can research next.', { get: () => cfg.solo, set: (v) => { cfg.solo = v; save(); render(); }, def: DEFAULTS.solo });
    refs.pace = K.segField('Pace', [{ id: 'thrifty', label: 'Thrifty' }, { id: 'balanced', label: 'Balanced' }, { id: 'fast', label: 'Fast' }], { get: () => cfg.pace, set: (id) => setCfg('pace', id), def: DEFAULTS.pace, describe: (v) => PACE_DESC[v] || '' });
    refs.land = K.segField('Buy land', [{ id: 'off', label: 'Off' }, { id: 'plan', label: 'Within the plan' }], { get: () => (cfg.land === 'off' ? 'off' : 'plan'), set: (id) => setCfg('land', id), def: DEFAULTS.land, describe: (v) => (v === 'off' ? LAND_OFF : LAND_PLAN) });
    refs.floorPicks = K.quickPicks((v) => setCfg('minMoney', v));
    refs.targetPicks = K.quickPicks((v) => setCfg('targetCd', v));
    refs.autoFloor = amountOf('autoFloor');
    refs.minMoney = amountOf('minMoney', [refs.floorPicks.el]);
    refs.targetCd = amountOf('targetCd', [refs.targetPicks.el]);
    refs.batch = amountOf('batch');
    refs.reserveAcres = amountOf('reserveAcres');
    refs.maxSpendPerMin = amountOf('maxSpendPerMin');
    refs.autoOn = K.toggleField('Run by itself', 'Starts whenever Autopilot needs CD. Pressing Stop turns it off.', { get: () => cfg.autoStart, set: (v) => { cfg.autoStart = v; save(); render(); }, def: DEFAULTS.autoStart });
    refs.auto = K.toggleField('Resume after reload', 'Continues an interrupted run when the page loads again.', { get: () => cfg.autoResume, set: (v) => { cfg.autoResume = v; save(); render(); }, def: DEFAULTS.autoResume });
    refs.full = K.toggleField('Full batches only', '', { get: () => cfg.fullBatch, set: (v) => setCfg('fullBatch', v), def: DEFAULTS.fullBatch });
    refs.landMsg = h('div', { class: 'idc-msg', hidden: true });
    refs.dryRunSwitch = K.toggleField('Dry run', 'Auto works out what it would build and writes it to the log, but sends nothing. Off: runs Live.', { get: () => !!ui.dryRunSwitch, set: (v) => { ui.dryRunSwitch = v; saveUi(); if (!running && !active) { cfg.dryRun = v; save(); } render(); }, def: false });
    refs.grpAuto = K.group('Auto', refs.autoOn.el, refs.solo.el, refs.pace.el, refs.land.el, refs.autoFloor.el);
    refs.grpBudget = K.group('Budget', refs.budget.el, refs.minMoney.el);
    refs.grpBatches = K.group('Batches', refs.full.el, refs.landMsg);
    const settings = K.settingsTab({
      lockText: 'Stop the farm to change settings.',
      tail: [K.group('Experimental', refs.dryRunSwitch.el)],
      groups: [K.group('Building', refs.building.el), refs.grpAuto, refs.grpBudget, K.group('Goal', refs.targetCd.el), refs.grpBatches],
      advanced: K.disclosure('Advanced', [K.group(null, refs.region.el, h('div', { class: 'idc-two' }, refs.batch.el, refs.reserveAcres.el), refs.maxSpendPerMin.el, refs.auto.el)],
        { open: !!ui.advOpen, onToggle: (o) => { ui.advOpen = o; saveUi(); } }),
      backup: { onExport: () => core.exportFile(), onImport: () => core.importFile(), onReset: () => K.resetSettings('CD Farm', { snapshot: exportCfg, reset: resetCfg, restore: importCfg }) },
    });
    refs.settings = settings;

    // ---- Log tab
    const logt = K.logTab({});
    refs.logv = logt.logv;

    // ---- Footer (always visible)
    refs.pilot = K.banner(null);
    refs.main = h('button', { class: 'primary', onclick: onMain });
    refs.alt = h('button', { onclick: onAlt });
    const foot = K.footer({ top: [refs.pilot.el], main: refs.main, alt: refs.alt });
    refs.plan = foot.plan;

    P = K.createPanel({
      id: 'cd', title: 'CD Farm', cls: 'cdf-panel', state: ui, save: saveUi, headExtra: [refs.badge], foot: foot.el,
      tabs: [{ id: 'status', label: 'Status', content: status }, { id: 'settings', label: 'Settings', content: settings.content }, { id: 'log', label: 'Log', content: logt.content }],
      onClose: () => panel(false), onTab: () => render(), opener: () => chrome?.opener,
      defaultPlace: () => ({ right: 20 }),
    });
  }

  function renderForm(r) {
    const busy = running || active;
    const auto = isAuto();
    refs.settings.sync(busy);
    refs.dryRunSwitch.input.disabled = busy;
    refs.grpAuto.hidden = !auto; refs.grpBudget.hidden = auto; refs.grpBatches.hidden = auto; refs.maxSpendPerMin.el.hidden = auto;
    const bldText = auto ? AUTO_BLD : r ? `${bld().name}: $${fmt(bld().base)} base, 1 CD and 1 acre each. You own ${r.ownedCamps}, so the next one costs $${fmt(campCost(r.ownedCamps, 1))} and each one you own adds $${fmt(bld().base / 20)}. Pick the one you own fewer of.` : undefined;

    // Which settings differ from the defaults: a reset button on each field, a dot on the tab.
    let changed = 0;
    const count = (m) => { if (m) changed++; };
    count(refs.building.sync(bldText)); count(refs.budget.sync()); count(refs.pace.sync()); count(refs.land.sync());
    count(refs.full.sync()); count(refs.auto.sync()); count(refs.autoOn.sync()); count(refs.solo.sync()); count(refs.region.sync());
    refs.floorPicks.sync(FLOOR_ITEMS, cfg.minMoney);
    if (r) refs.targetPicks.sync(targetItems(r), cfg.targetCd);
    const issues = r && !busy && !auto ? checkPlan(r) : [];
    const issueFor = (key) => issues.find((i) => i.field === key);
    for (const key of AMOUNTS) count(refs[key].sync(issueFor(key)));
    K.setMsg(refs.landMsg, issueFor('land'));
    refs.full.small.textContent = cfg.fullBatch
      ? `Always ${cfg.batch} ${bld().plural} per cycle; waits instead of building fewer.`
      : `Builds fewer than ${cfg.batch} when money or land is short.`;
    P.setTabBadge('settings', changed ? changed + ' setting' + (changed > 1 ? 's' : '') + ' changed from the defaults' : '');

    const blocking = AMOUNTS.some((k) => refs[k].error) || issues.some((i) => i.level === 'error');
    const confirming = !busy && !resumable && !blocking && Date.now() < confirmUntil;
    const pilot = window.earlyGame;
    refs.pilot.set(!busy && pilot?.busy ? 'Autopilot is running live. Starting pauses it after its current step; it goes on when the farm stops.' : '');
    refs.plan.set(blocking ? 'Fix the settings marked in red to start.' : auto ? autoPlanText() : r ? planText(r) : '',
      { hidden: busy || resumable || !r, hot: confirming, bad: blocking });
    refs.main.textContent = running ? 'Stop' : resumable ? 'Resume' : confirming ? 'Confirm start' : 'Start';
    refs.main.disabled = !running && (active || !r || (!resumable && blocking));
    refs.alt.hidden = !confirming && (running || !(resumable || stats.cycles));
    const arming = !confirming && Date.now() < discardUntil;
    refs.alt.textContent = confirming ? 'Cancel' : arming ? 'Click again to confirm' : resumable ? 'Discard run' : 'Clear stats';
    refs.alt.classList.toggle('danger', !confirming && (resumable || arming));
    refs.alt.classList.toggle('armed', arming);
  }

  const onResize = () => P?.place();

  function renderPanel(r, rt) {
    const t = tone();
    K.setTone(P.dot, t);
    refs.badge.textContent = isAuto() ? 'Auto' : bld().name;
    refs.badge.className = 'idc-badge' + (running ? ' live' : '');
    if (!r) {
      refs.hero.set('—', '', 0); refs.rows.set([]);
      refs.state.set(t, 'Waiting for the game to load…');
    } else {
      const hasTarget = Number.isFinite(cfg.targetCd);
      refs.hero.set(fmt(r.cd), hasTarget ? `of ${fmt(cfg.targetCd)}` : (stats.built ? `+${fmt(stats.built)} farmed` : 'no target'),
        hasTarget ? Math.min(100, (r.cd / cfg.targetCd) * 100) : 0);
      refs.rows.set(isAuto() ? autoRows() : [
        ['Money', `$${fmt(r.money)}`],
        ['Floor', `$${fmt(r.moneyFloor)}`],
        ['Next batch', r.nextBatch ? `${r.nextBatch} ${bld().plural} · $${fmt(r.nextBatchCost)}` : 'none affordable'],
        ['Free acres', `${r.freeAcres} of ${r.acresOwned} (${cfg.reserveAcres} spare)`],
        ['Cycles', `${fmt(stats.cycles)}${stats.built ? ` · +${fmt(stats.built)} CD` : ''}`],
        ['Net cost', stats.built ? `$${perCd()} / CD` : '—'],
        ['Rate', rt.cdh15 ?? rt.cdhAll ? `${fmtRate(rt.cdh15 ?? rt.cdhAll)} CD/h` : '—'],
        [`ETA ${fmt(rt.target)}`, etaText(rt)],
      ]);
      refs.state.set(t, cap(stateText()));
    }
    renderForm(r);
    K.syncLog(P, ui, refs.logv);
  }

  function render() {
    const r = read();
    const rt = rates(r);
    const t = tone();
    chrome?.setPill(!running ? 'Paused' : t === 'wait' ? 'Waiting' : (rt.etaH != null && !rt.capped ? fmtH(rt.etaH) : 'On'), t, !running && !resumable);
    chrome?.setChip(r ? `${fmt(r.cd)} CD` : 'CD Farm', t, `CD Farm · ${cap(stateText())}`);
    const open = !!P?.el.isConnected;
    chrome?.setOpen(open);
    if (open) renderPanel(r, rt);
  }

  function panel(show = true, opts = {}) {
    if (show) { if (!P) buildPanel(); P.mount(opts); } else P?.unmount();
    ui.open = !!show; saveUi();
    render();
  }

  function mountUi() {
    chrome = K.createChrome({
      label: 'CD Farm', navTitle: 'Build and demolish Lumber Camps or Farms for Construction Data', icon: ICON, navClass: 'cdf-tab', chipClass: 'cdf-chip',
      onToggle: () => K.togglePanel(P, ui, panel),
      chipInsert: (tools, el) => tools.insertBefore(el, tools.querySelector('.tip-anchor') || null),
    });
    if (!ui.dryRunSwitch && !running && !active) cfg.dryRun = false;   // Dry run is experimental: off by default, so runs start Live unless the switch is on.
    chrome.mount();
    timer = setInterval(render, 1000);
    if (ui.open) panel(true); else render();
    addEventListener('resize', onResize);
  }

  function unmountUi() {
    clearInterval(timer); timer = null;
    P?.unmount(); chrome?.unmount();
    P = chrome = null;
    removeEventListener('resize', onResize);
  }
