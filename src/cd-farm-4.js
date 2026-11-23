// continues the cd-farm closure from cd-farm-3.js (same try / IIFE)
  // ---- game UI -----------------------------------------------------------
  // Styled with the game's own CSS variables and button classes so it reads as
  // part of the app: a "CD Farm" tab in the sidebar, a chip in the top bar, and
  // a card that opens from either.

  const UI_KEY = 'cdFarm.ui';
  const ui = (() => { try { return { open: false, x: null, y: null, ...JSON.parse(localStorage.getItem(UI_KEY) || '{}') }; } catch { return { open: false, x: null, y: null }; } })();
  const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };


  const ICON = '<svg class="nav-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="6" height="6" rx="1" fill="currentColor"></rect><rect x="11" y="11" width="6" height="6" rx="1"></rect><rect x="7" y="3" width="6" height="6" rx="1" style="stroke:var(--nav-accent)"></rect></svg>';

  const h = core.h;
  const K = core.ui;

  let P = null, chrome = null, timer = null, ctlTimer = null, discardUntil = 0;
  const refs = {};

  // 'run' | 'wait' | 'err' | '' for the status dot.
  function tone() {
    if (running) return /waiting|reconnect/.test(phase) ? 'wait' : 'run';
    if (resumable || /^error/.test(stopReason)) return 'err';
    return '';
  }
  const stateText = () => (running ? phase + (stats.by ? ` · ${stats.by}` : '') : resumable ? 'Interrupted — resume available' : (isAuto() && cfg.autoStart && idleNote ? 'Auto: ' + idleNote : stopReason || 'Idle'));
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ---- settings form ----
  // Amounts accept "100k", "1.5m", "$100,000". Every change is checked against
  // the live game state, problems show next to the field they come from, and
  // Start needs a second click after reading the plan summary.

  const parseAmount = (s) => {
    const m = String(s).trim().replace(/[$,\s_]/g, '').match(/^(\d*\.?\d+)([kmb])?$/i);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1));
  };
  const short = (x) => (x >= 1e6 ? `${+(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${+(x / 1e3).toFixed(1)}k` : String(Math.round(x)));

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

  const parseErr = {};
  let confirmUntil = 0;

  function parseField(key, text) {
    const f = FIELDS[key];
    const s = text.trim();
    if (s === '') return f.optional ? { v: Infinity } : { err: 'Required.' };
    const v = parseAmount(s);
    if (v == null) return { err: f.kind === 'money' ? 'Use an amount like 100k, 1.5m or 100,000.' : 'Use a number like 20k or 20,000.' };
    if (f.min != null && v < f.min) return { err: `Must be at least ${fmt(f.min)}.` };
    if (f.max != null && v > f.max) return { err: `Must be at most ${fmt(f.max)}.` };
    return { v };
  }
  const shown = (key) => (Number.isFinite(cfg[key]) ? fmt(cfg[key]) : '');
  function setCfg(key, v) { cfg[key] = v; confirmUntil = 0; save(); render(); }

  function textField(key) {
    const f = FIELDS[key];
    const { input, box } = K.inputBox({ label: f.label, prefix: f.kind === 'money' ? '$' : '', placeholder: f.empty || '' });
    const msg = h('div', { class: 'idc-msg', hidden: true });
    const revert = () => { delete parseErr[key]; input.value = shown(key); };
    input.addEventListener('input', () => {
      const p = parseField(key, input.value);
      if (p.err) { parseErr[key] = p.err; confirmUntil = 0; render(); } else { delete parseErr[key]; setCfg(key, p.v); }
    });
    input.addEventListener('blur', () => { revert(); render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { revert(); input.blur(); }
    });
    refs.fields[key] = { input, box, msg };
    return { box, msg };
  }

  const fieldBox = K.field;
  const same = Object.is;
  const setOn = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
  const chip = (text, onclick) => h('button', { type: 'button', onclick }, text);
  function setMsg(el, m) {
    el.hidden = !m;
    el.className = 'idc-msg ' + (m?.level || '');
    el.textContent = m?.text || '';
  }

  // Floor the run would use if started now.
  const plannedFloor = (r) => (cfg.budget === 'income' ? Math.max(cfg.minMoney, r.money) : cfg.minMoney);
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
    } else if (cfg.budget === 'income' && cfg.minMoney > r.money) {
      out.push({ field: 'minMoney', level: 'warn', text: `Money is below this floor; it will wait until money passes $${fmt(cfg.minMoney)}.` });
    }
    if (cfg.budget !== 'income' && cfg.minMoney < r.money * 0.1) {
      out.push({ field: 'minMoney', level: 'warn', text: `Low floor: up to $${fmt(r.money - cfg.minMoney)} of your $${fmt(r.money)} can be spent.` });
    }
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

  const bldLabel = (id) => (id === 'auto' ? 'Auto' : BUILDINGS.find((b) => b.id === id)?.name ?? '');
  function autoRows() {
    const ev = lastEval, c = ev?.c, m = core.measure.snapshot();
    const rows = [['Mode', `Auto · ${cap(cfg.pace)}${cfg.autoStart ? '' : ' · off'}`]];
    rows.push(['Why', cap(running ? phase : (idleNote || (ev?.idle ? ev.reason : '') || stopReason || 'idle'))]);
    if (ev?.need != null && c) rows.push(['Need', `${fmt(c.cd)} of ${fmt(ev.need)} CD${ev.ap?.nextTech ? ' (' + ev.ap.nextTech.name + ')' : ''}`]);
    if (ev?.plan?.units?.length) rows.push(['Next cycle', `${unitsText(ev.plan.units)} · ${fmt(ev.plan.cdTotal)} CD · $${fmt(ev.plan.netCents / 100)} net`]);
    if (c) rows.push(['Free acres', `${c.freeAcres} of ${c.acresOwned} (${cfg.reserveAcres} spare)`]);
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
  function doClearLog() {
    const snap = core.ledger.list();
    core.ledger.clear(); render();
    core.toast('Log cleared', { undo: () => { if (unloaded) return; core.ledger.restore(snap); render(); } });
  }

  function buildPanel() {
    // ---- Status tab
    refs.cd = h('span', { class: 'idc-big' });
    refs.target = h('span', { class: 'idc-label' });
    refs.bar = h('i');
    refs.rows = h('div', { class: 'idc-rows' });
    refs.state = h('span');
    refs.stateDot = h('span', { class: 'idc-dot' });
    const status = [
      h('div', {}, h('div', { class: 'idc-label' }, 'Construction Data'), h('div', { class: 'idc-hero' }, refs.cd, refs.target), h('div', { class: 'idc-bar' }, refs.bar)),
      refs.rows,
      h('div', { class: 'idc-state' }, refs.stateDot, refs.state)];

    // ---- Settings tab
    refs.fields = {};
    refs.fieldEl = {};
    refs.seg = K.seg(MODES, () => cfg.budget, (id) => setCfg('budget', id), 'Budget');
    refs.modeDesc = h('div', { class: 'idc-desc' });
    refs.bldSeg = K.seg([{ id: 'auto', label: 'Auto' }, ...BUILDINGS.map((b) => ({ id: b.id, label: b.name }))], () => cfg.building, (id) => setCfg('building', id), 'Building');
    refs.bldDesc = h('div', { class: 'idc-desc' });
    refs.paceSeg = K.seg([{ id: 'thrifty', label: 'Thrifty' }, { id: 'balanced', label: 'Balanced' }, { id: 'fast', label: 'Fast' }], () => cfg.pace, (id) => setCfg('pace', id), 'Pace');
    refs.paceDesc = h('div', { class: 'idc-desc' });
    refs.landSeg = K.seg([{ id: 'off', label: 'Off' }, { id: 'plan', label: 'Within the plan' }], () => (cfg.land === 'off' ? 'off' : 'plan'), (id) => setCfg('land', id), 'Buy land');
    refs.landDesc = h('div', { class: 'idc-desc' });
    const autoFloor = textField('autoFloor');
    refs.autoOn = h('input', { type: 'checkbox', onchange: () => { cfg.autoStart = refs.autoOn.checked; save(); render(); } });
    refs.autoOnLabel = K.check(refs.autoOn, 'Run by itself', 'Starts whenever Autopilot needs CD. Pressing Stop turns it off.');
    const floor = textField('minMoney');
    refs.floorChips = FLOOR_CHIPS.map((v) => [v, chip('$' + short(v), () => setCfg('minMoney', v))]);
    const target = textField('targetCd');
    refs.targetChips = h('div', { class: 'idc-quicks' });
    refs.targetKey = '';
    refs.full = h('input', { type: 'checkbox', onchange: () => setCfg('fullBatch', refs.full.checked) });
    refs.fullText = h('small');
    refs.fullLabel = h('label', { class: 'idc-check' }, refs.full, h('span', {}, 'Full batches only', refs.fullText));
    refs.landMsg = h('div', { class: 'idc-msg', hidden: true });
    const batch = textField('batch');
    const spare = textField('reserveAcres');
    const rate = textField('maxSpendPerMin');
    refs.auto = h('input', { type: 'checkbox', onchange: () => { cfg.autoResume = refs.auto.checked; save(); render(); } });
    refs.autoLabel = K.check(refs.auto, 'Resume after reload', 'Continues an interrupted run when the page loads again.');
    refs.fieldEl.building = fieldBox('Building', refs.bldSeg.el, refs.bldDesc);
    refs.fieldEl.pace = fieldBox('Pace', refs.paceSeg.el, refs.paceDesc);
    refs.fieldEl.land = fieldBox('Buy land', refs.landSeg.el, refs.landDesc);
    refs.fieldEl.autoFloor = fieldBox('Extra money floor', autoFloor.box, autoFloor.msg);
    refs.fieldEl.budget = fieldBox('Budget', refs.seg.el, refs.modeDesc);
    refs.fieldEl.minMoney = fieldBox('Money floor', floor.box, h('div', { class: 'idc-quicks' }, ...refs.floorChips.map(([, b]) => b)), floor.msg);
    refs.fieldEl.targetCd = fieldBox('Target CD', target.box, refs.targetChips, target.msg);
    refs.fieldEl.batch = fieldBox('Buildings per cycle', batch.box, batch.msg);
    refs.fieldEl.reserveAcres = fieldBox('Spare acres', spare.box, spare.msg);
    refs.fieldEl.maxSpendPerMin = fieldBox('Max spend per minute', rate.box, rate.msg);
    const lockIcon = h('span', { 'aria-hidden': 'true' });
    lockIcon.innerHTML = K.ICONS.lock;
    refs.lock = h('div', { class: 'idc-lock' }, lockIcon, 'Stop the farm to change settings.');
    refs.fs = h('fieldset', { class: 'idc-form' },
      K.group('Building', refs.fieldEl.building),
      refs.grpAuto = K.group('Auto', refs.autoOnLabel, refs.fieldEl.pace, refs.fieldEl.land, refs.fieldEl.autoFloor),
      refs.grpBudget = K.group('Budget', refs.fieldEl.budget, refs.fieldEl.minMoney),
      K.group('Goal', refs.fieldEl.targetCd),
      refs.grpBatches = K.group('Batches', refs.fullLabel, refs.landMsg),
      h('details', { class: 'idc-sub', open: !!ui.advOpen, ontoggle: (e) => { ui.advOpen = e.target.open; saveUi(); } }, h('summary', {}, 'Advanced'),
        K.group(null, h('div', { class: 'idc-two' }, refs.fieldEl.batch, refs.fieldEl.reserveAcres), refs.fieldEl.maxSpendPerMin, refs.autoLabel)));

    // ---- Log tab
    refs.logv = K.createLogView();
    const logTab = [
      refs.logv.el,
      h('div', { class: 'idc-tools' },
        h('button', { type: 'button', onclick: () => core.ledger.copy() }, 'Copy log'),
        h('button', { type: 'button', class: 'danger', onclick: doClearLog }, 'Clear log')),
      h('div', { class: 'idc-desc' }, 'Alt+Shift+X stops Autopilot, CD Farm and the Lab runner from anywhere on the page.')];

    // ---- Footer (always visible)
    refs.pilot = h('div', { class: 'idc-msg warn', hidden: true });
    refs.plan = h('div', { class: 'idc-plan' });
    refs.main = h('button', { class: 'primary', onclick: onMain });
    refs.alt = h('button', { onclick: onAlt });
    const foot = h('div', { class: 'idc-foot' }, refs.pilot, refs.plan, h('div', { class: 'idc-btns' }, refs.alt, refs.main));

    P = K.createPanel({
      id: 'cd', title: 'CD Farm', cls: 'cdf-panel', state: ui, save: saveUi, foot,
      tabs: [{ id: 'status', label: 'Status', content: status }, { id: 'settings', label: 'Settings', content: [refs.lock, refs.fs] }, { id: 'log', label: 'Log', content: logTab }],
      onClose: () => panel(false), onTab: () => render(), opener: () => chrome?.opener,
      defaultPlace: () => ({ right: 20 }),
    });
    refs.dot = P.dot;
  }

  function renderForm(r) {
    const busy = running || active;
    refs.fs.disabled = busy;
    refs.lock.hidden = !busy;
    refs.seg.sync();
    refs.bldSeg.sync(); refs.paceSeg.sync(); refs.landSeg.sync();
    const auto = isAuto();
    const show = (el, on) => { el.style.display = on ? '' : 'none'; };
    show(refs.grpAuto, auto); show(refs.grpBudget, !auto); show(refs.grpBatches, !auto); show(refs.fieldEl.maxSpendPerMin, !auto);
    refs.autoOn.checked = !!cfg.autoStart;
    refs.paceDesc.textContent = { thrifty: 'Cheapest CD, small batches, slow.', balanced: 'Bigger batches while the time saved is worth the cash.', fast: 'As fast as cash and free acres allow.' }[cfg.pace] || '';
    refs.landDesc.textContent = cfg.land === 'off' ? 'Never buys acres. Logs what more land would save.' : 'Buys an acre only while acres limit the batch, the CD it saves is worth more than the acre, the price is under Autopilot\'s land price limit, and the cash floor holds.';
    if (auto) refs.bldDesc.textContent = 'Picks the cheapest CD source every cycle from what is unlocked, in surplus and affordable. Never buys materials.';
    else if (r) refs.bldDesc.textContent = `${bld().name}: $${fmt(bld().base)} base, 1 CD and 1 acre each. You own ${r.ownedCamps}, so the next one costs $${fmt(campCost(r.ownedCamps, 1))} and each one you own adds $${fmt(bld().base / 20)}. Pick the one you own fewer of.`;
    refs.modeDesc.textContent = MODES.find((m) => m.id === cfg.budget)?.desc || '';
    for (const [key, f] of Object.entries(refs.fields)) if (document.activeElement !== f.input) f.input.value = shown(key);
    for (const [v, b] of refs.floorChips) setOn(b, cfg.minMoney === v);

    // Target chips: the next round numbers above the current CD, plus "None".
    if (r) {
      const steps = TARGET_STEPS.filter((v) => v > r.cd).slice(0, 5);
      const key = steps.join();
      if (key !== refs.targetKey) {
        refs.targetKey = key;
        refs.targetChips.replaceChildren(...steps.map((v) => chip(short(v), () => setCfg('targetCd', v))), chip('None', () => setCfg('targetCd', Infinity)));
      }
      const btns = [...refs.targetChips.children];
      steps.forEach((v, i) => setOn(btns[i], cfg.targetCd === v));
      setOn(btns[btns.length - 1], !Number.isFinite(cfg.targetCd));
    }

    const issues = r && !busy && !auto ? checkPlan(r) : [];
    const msgFor = (key) => (parseErr[key] ? { level: 'error', text: parseErr[key] } : issues.find((i) => i.field === key));
    for (const [key, f] of Object.entries(refs.fields)) {
      const m = msgFor(key);
      setMsg(f.msg, m);
      f.box.classList.toggle('bad', m?.level === 'error');
    }
    setMsg(refs.landMsg, msgFor('land'));
    refs.full.checked = !!cfg.fullBatch;
    refs.fullText.textContent = cfg.fullBatch
      ? `Always ${cfg.batch} ${bld().plural} per cycle; waits instead of building fewer.`
      : `Builds fewer than ${cfg.batch} when money or land is short.`;
    refs.auto.checked = !!cfg.autoResume;

    // Which settings differ from the defaults: a reset button on each field, a dot on the tab.
    let changed = 0;
    const defShown = (key) => (Number.isFinite(DEFAULTS[key]) ? fmt(DEFAULTS[key]) : FIELDS[key]?.empty || 'none');
    const mod = (key, hint) => {
      const m = !same(cfg[key], DEFAULTS[key]);
      if (m) changed++;
      K.setModified(refs.fieldEl[key], m, 'Reset to the default (' + hint + ')', () => { delete parseErr[key]; setCfg(key, DEFAULTS[key]); });
    };
    mod('building', bldLabel(DEFAULTS.building));
    mod('pace', 'Balanced');
    mod('land', 'Within the plan');
    mod('budget', MODES.find((m) => m.id === DEFAULTS.budget).label);
    for (const key of ['minMoney', 'autoFloor', 'targetCd', 'batch', 'reserveAcres', 'maxSpendPerMin']) mod(key, defShown(key));
    for (const [key, label] of [['fullBatch', refs.fullLabel], ['autoResume', refs.autoLabel], ['autoStart', refs.autoOnLabel]]) {
      const m = !!cfg[key] !== !!DEFAULTS[key];
      label.classList.toggle('mod', m); label.title = m ? 'Changed from the default' : '';
      if (m) changed++;
    }
    P.setTabBadge('settings', changed ? changed + ' setting' + (changed > 1 ? 's' : '') + ' changed from the defaults' : '');

    const blocking = Object.keys(parseErr).length > 0 || issues.some((i) => i.level === 'error');
    const confirming = !busy && !resumable && !blocking && Date.now() < confirmUntil;
    const pilot = window.earlyGame;
    refs.pilot.hidden = busy || !pilot?.busy;
    refs.pilot.textContent = 'Autopilot is running live. Starting pauses it after its current step; it goes on when the farm stops.';
    refs.plan.hidden = busy || resumable || !r;
    if (!refs.plan.hidden) refs.plan.textContent = blocking ? 'Fix the settings marked in red to start.' : auto ? autoPlanText() : planText(r);
    refs.plan.classList.toggle('hot', confirming);
    refs.plan.classList.toggle('bad', blocking);
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
    refs.dot.className = refs.stateDot.className = 'idc-dot ' + t;
    if (!r) {
      refs.cd.textContent = '—'; refs.target.textContent = ''; refs.rows.replaceChildren();
      refs.state.textContent = 'Waiting for the game to load…';
    } else {
      refs.cd.textContent = fmt(r.cd);
      const hasTarget = Number.isFinite(cfg.targetCd);
      refs.target.textContent = hasTarget ? `of ${fmt(cfg.targetCd)}` : (stats.built ? `+${fmt(stats.built)} farmed` : 'no target');
      refs.bar.style.width = hasTarget ? Math.min(100, (r.cd / cfg.targetCd) * 100) + '%' : '0%';
      const rows = isAuto() ? autoRows() : [
        ['Money', `$${fmt(r.money)}`],
        ['Floor', `$${fmt(r.moneyFloor)}`],
        ['Next batch', r.nextBatch ? `${r.nextBatch} ${bld().plural} · $${fmt(r.nextBatchCost)}` : 'none affordable'],
        ['Free acres', `${r.freeAcres} of ${r.acresOwned} (${cfg.reserveAcres} spare)`],
        ['Cycles', `${fmt(stats.cycles)}${stats.built ? ` · +${fmt(stats.built)} CD` : ''}`],
        ['Net cost', stats.built ? `$${perCd()} / CD` : '—'],
        ['Rate', rt.cdh15 ?? rt.cdhAll ? `${fmtRate(rt.cdh15 ?? rt.cdhAll)} CD/h` : '—'],
        [`ETA ${fmt(rt.target)}`, etaText(rt)],
      ];
      refs.rows.replaceChildren(...rows.map(([k, v]) => K.row(k, v)));
      refs.state.textContent = cap(stateText());
    }
    renderForm(r);
    if (ui.tab === 'log' && !ui.min) { refs.logv.render(); refs.logv.markSeen(); }
    const unseen = ui.tab === 'log' ? 0 : refs.logv.unseen();
    P.setTabBadge('log', unseen ? unseen + ' new problem' + (unseen > 1 ? 's' : '') : '', true);
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

