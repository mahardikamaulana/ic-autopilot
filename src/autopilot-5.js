// continues the autopilot closure from autopilot-4.js (same try / IIFE)
  // ---- game UI ----------------------------------------------------------------------
  // Same look as CD Farm (the game's CSS variables and button classes): an "Autopilot" tab in the
  // sidebar, a chip in the top bar, and a draggable card that opens bottom-left (CD Farm's card
  // opens bottom-right). Nothing here runs without a DOM, so the offline simulator is unaffected.

  const UI_KEY = 'earlyGame.ui';
  const ui = (() => { try { return { open: true, x: null, y: null, ...JSON.parse(store?.getItem(UI_KEY) || '{}') }; } catch { return { open: true, x: null, y: null }; } })();
  const saveUi = () => { try { store?.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };


  const ICON = '<svg class="nav-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16h4v-4h4V8h4V4"></path><circle cx="15" cy="4" r="1.6" fill="currentColor" style="stroke:var(--nav-accent)"></circle></svg>';

  const mk = core.h;
  const K = core.ui;
  const uiNum = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const parseAmount = (str) => {
    const m = String(str).trim().replace(/[$,\s_]/g, '').match(/^(\d*\.?\d+)([kmb])?$/i);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1));
  };

  let P = null, chrome = null, uiTimer = null, unloaded = false;
  const refs = {};
  let confirmUntil = 0;

  const FIELDS = {
    workshops: { kind: 'count', label: 'Frame Timber Workshops', min: 0, max: 50 },
    sawmills: { kind: 'count', label: 'Sawmills (at least)', min: 0, max: 200 },
    ironMines: { kind: 'count', label: 'Iron Mines', min: 0, max: 100 },
    coalMines: { kind: 'count', label: 'Coal Mines', min: 0, max: 100 },
    goldMines: { kind: 'count', label: 'Gold Mines', min: 0, optional: true, empty: 'No limit' },
    ironFrameWorkshops: { kind: 'count', label: 'Iron Frame Workshops', min: 0, max: 50 },
    maxAcrePriceEarly: { kind: 'money', label: 'Land wall, early', min: 0 },
    maxAcrePrice: { kind: 'money', label: 'Land wall, later', min: 0 },
    boosterBatch: { kind: 'count', label: 'Booster batch', min: 1, max: 100 },
    boosterMinCash: { kind: 'money', label: 'Booster starts above', min: 0 },
    boosterKeepCash: { kind: 'money', label: 'Booster keeps', min: 0 },
    // Advanced
    quarries: { kind: 'count', label: 'Limestone Quarries', min: 0, max: 50 },
    smelters: { kind: 'count', label: 'Smelters', min: 0, max: 50 },
    maxAcrePriceCritical: { kind: 'money', label: 'Land wall, plan buildings', min: 0 },
    landCashShare: { kind: 'pct', label: 'Land: share of cash', min: 0, max: 1, unit: '%' },
    boosterAcres: { kind: 'count', label: 'Booster acres kept free', min: 0, max: 100 },
    woodReserve: { kind: 'count', label: 'Wood never sold below', min: 0, max: 1000000 },
    sellKeepMinutes: { kind: 'count', label: 'Keep minutes of use', min: 0, max: 1440, unit: 'min' },
    maxBuyPrice: { kind: 'mult', label: 'Max buy price (× base)', min: 0.1, max: 100, unit: '×' },
    floorBuyUsd: { kind: 'usd', label: 'Floor parts, $ per unit', min: 0, max: 1000 },
    buyOrderUsd: { kind: 'usd', label: 'Buy order, $ per unit', min: 0.01, max: 1000 },
    orderHoldHours: { kind: 'count', label: 'Order hold', min: 0, max: 720, unit: 'h' },
    maxActionsPerMin: { kind: 'count', label: 'Max actions per minute', min: 1, max: 60 },
    intervalMs: { kind: 'count', label: 'Check every', min: 500, max: 60000, unit: 'ms' },
    maxIdleMs: { kind: 'count', label: 'Slowest idle check', min: 500, max: 120000, unit: 'ms' },
    stallMinutes: { kind: 'count', label: 'Stall alert after', min: 0, max: 600, unit: 'min' },
  };
  const ADV_FIELDS = ['quarries', 'smelters', 'maxAcrePriceCritical', 'landCashShare', 'boosterAcres', 'woodReserve', 'sellKeepMinutes', 'maxBuyPrice', 'floorBuyUsd', 'buyOrderUsd', 'orderHoldHours', 'maxActionsPerMin', 'intervalMs', 'maxIdleMs', 'stallMinutes'];
  const CHECKS = [
    ['sellAll', 'Sell spare full courier loads'],
    ['cdBooster', 'CD booster (build + demolish)'],
    ['floorUpgrades', 'Apply better floorplans'],
    ['buyKits', 'Buy kit parts the corp can\'t make'],
    ['postBuyOrders', 'Post buy orders when no one sells'],
    ['dispatchOffice', 'Also unlock the Dispatch Office'],
    ['autoResume', 'Resume after reload (as a dry run unless Live resume is on)'],
  ];
  const ADV_CHECKS = [
    ['liveResume', 'Live resume: after a reload in this tab, go Live again after a 60 s cancel window'],
    ['autoShipCotton', 'Auto-ship Cotton'],
    ['saveForCritical', 'Save for a ready plan building before buying camps/farms'],
    ['resumePaused', 'Resume groups paused by an unpaid bill'],
  ];
  const MODES = [
    { id: true, label: 'Dry run' },
    { id: false, label: 'Live' },
  ];

  function setCfg(key, v) { cfg[key] = v; confirmUntil = 0; save(); render(); }
  const shownOf = (key, v) => (Number.isFinite(v) ? uiNum(FIELDS[key]?.kind === 'pct' ? v * 100 : v) : '');
  const shown = (key) => shownOf(key, cfg[key]);
  const same = (a, b) => (Array.isArray(a) ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b));
  const parseErr = {};
  function parseField(key, text) {
    const f = FIELDS[key];
    const str = text.trim();
    if (str === '') return f.optional ? { v: Infinity } : { err: 'Required.' };
    const decimal = f.kind === 'usd' || f.kind === 'mult' || f.kind === 'pct';
    let v;
    if (decimal) {
      v = /^[$]?\d*\.?\d+[%×x]?$/i.test(str.replace(/[,\s_]/g, '')) ? Number(str.replace(/[$,%×x\s_]/gi, '')) : null;
      if (v != null && f.kind === 'pct') v /= 100;
    } else v = parseAmount(str);
    if (v == null) return { err: decimal ? 'Use a number like 1 or 0.5.' : f.kind === 'money' ? 'Use an amount like 500, 20k or 1.5m.' : 'Use a whole number.' };
    const disp = (x) => uiNum(f.kind === 'pct' ? x * 100 : x);
    if (f.min != null && v < f.min) return { err: `At least ${disp(f.min)}.` };
    if (f.max != null && v > f.max) return { err: `At most ${disp(f.max)}.` };
    return { v };
  }
  function textField(key) {
    const f = FIELDS[key];
    const { input, box } = K.inputBox({ label: f.label, prefix: f.kind === 'money' || f.kind === 'usd' ? '$' : '', suffix: f.unit, placeholder: f.empty || '' });
    const msg = mk('div', { class: 'idc-msg error', hidden: true });
    const revert = () => { delete parseErr[key]; input.value = shown(key); };
    input.addEventListener('input', () => {
      const p = parseField(key, input.value);
      if (p.err) { parseErr[key] = p.err; render(); } else { delete parseErr[key]; setCfg(key, p.v); }
    });
    input.addEventListener('blur', () => { revert(); render(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { revert(); input.blur(); } });
    const el = K.field(f.label, box, msg);
    refs.fields[key] = { input, box, msg, el };
    return el;
  }
  const row = K.row;
  const signed = (c) => (c < 0 ? '−' : '+') + usd(Math.abs(c));

  function doReset() {
    try {
      const snap = exportCfg();
      resetCfg();
      core.toast('Autopilot settings are back to their defaults', { undo: () => { if (unloaded) return; try { importCfg(snap); } catch (e) { core.toast(e.message, 'error'); } } });
    } catch (e) { core.toast(e.message, 'error'); }
  }
  function doClearLog() {
    const snap = core.ledger.list();
    core.ledger.clear(); render();
    core.toast('Log cleared', { undo: () => { if (unloaded) return; core.ledger.restore(snap); render(); } });
  }

  function buildPanel() {
    refs.badge = mk('span', { class: 'idc-badge' });

    // ---- Status tab
    refs.phase = mk('span', { class: 'idc-big' });
    refs.phaseOf = mk('span', { class: 'idc-label' });
    refs.bar = mk('i');
    refs.rows = mk('div', { class: 'idc-rows' });
    refs.stateDot = mk('span', { class: 'idc-dot' });
    refs.state = mk('span');
    refs.noteText = mk('span');
    refs.noteBtn = mk('button', { type: 'button', onclick: () => W.cdFarm?.panel?.(true) }, 'Open CD Farm');
    refs.note = mk('div', { class: 'idc-note', hidden: true }, refs.noteText, refs.noteBtn);
    refs.log = mk('div', { class: 'idc-recent', 'aria-live': 'polite' });
    const banner = (label, onclick) => { const text = mk('span'); const btn = mk('button', { type: 'button', onclick }, label); return { text, btn, el: mk('div', { class: 'idc-note', hidden: true }, text, btn) }; };
    refs.live = banner('Cancel: resume as a dry run', () => { liveCountdownUntil = 0; render(); });
    refs.stall = banner('Snooze', () => { stalled = ''; core.setBadge('AP', ''); prog.at = nowMs(); prog.acts = 0; render(); });
    refs.check = mk('div', { class: 'idc-rows' });
    const checklistSec = mk('details', { class: 'idc-sec', open: !!ui.checkOpen }, mk('summary', {}, 'Checklist'), refs.check);
    checklistSec.addEventListener('toggle', () => { ui.checkOpen = checklistSec.open; saveUi(); });
    const status = [
      mk('div', {}, mk('div', { class: 'idc-label' }, 'Early-game plan'), mk('div', { class: 'idc-hero' }, refs.phase, refs.phaseOf), mk('div', { class: 'idc-bar' }, refs.bar)),
      refs.rows,
      mk('div', { class: 'idc-state' }, refs.stateDot, refs.state),
      refs.note, refs.live.el, refs.stall.el, refs.log,
      checklistSec];

    // ---- Settings tab
    refs.fields = {};
    refs.checks = [...CHECKS, ...ADV_CHECKS].map(([key, label]) => {
      const input = mk('input', { type: 'checkbox', onchange: () => setCfg(key, input.checked) });
      return [key, input, K.check(input, label)];
    });
    const checkEl = (key) => refs.checks.find(([k]) => k === key)[2];
    refs.hours = mk('input', { type: 'text', inputMode: 'decimal', autocomplete: 'off', value: '8', 'aria-label': 'Hours offline' });
    refs.billNow = mk('div', { class: 'idc-desc' });
    const offBtn = mk('button', { type: 'button', onclick: () => { const hrs = Number(refs.hours.value); if (hrs > 0) { offline(hrs); render(); } } }, 'Keep bills');
    const lockIcon = mk('span', { 'aria-hidden': 'true' });
    lockIcon.innerHTML = K.ICONS.lock;
    refs.lock = mk('div', { class: 'idc-lock' }, lockIcon, 'Stop the live run to change settings.');
    refs.fs = mk('fieldset', { class: 'idc-form' },
      K.group('Build targets', mk('div', { class: 'idc-two' }, ...['workshops', 'sawmills', 'ironMines', 'coalMines', 'goldMines', 'ironFrameWorkshops'].map(textField))),
      K.group('Land price limits', mk('div', { class: 'idc-two' }, ...['maxAcrePriceEarly', 'maxAcrePrice'].map(textField)),
        mk('div', { class: 'idc-desc' }, 'The most per acre Autopilot will pay for land, early on and later.')),
      K.group('CD booster', mk('div', { class: 'idc-two' }, ...['boosterBatch', 'boosterMinCash', 'boosterKeepCash'].map(textField)), checkEl('cdBooster')),
      K.group('Automation', ...['sellAll', 'floorUpgrades', 'buyKits', 'postBuyOrders', 'dispatchOffice', 'autoResume'].map(checkEl)),
      K.group('Power bills', K.field('Going offline: keep power bills for',
        mk('div', { class: 'idc-inline' }, mk('div', { class: 'idc-inp' }, refs.hours, mk('span', {}, 'h')), offBtn), refs.billNow)),
      mk('details', { class: 'idc-sub', open: !!ui.advOpen, ontoggle: (e) => { ui.advOpen = e.target.open; saveUi(); } },
        mk('summary', {}, 'Advanced'),
        K.group(null, mk('div', { class: 'idc-two' }, ...ADV_FIELDS.map(textField)), ...ADV_CHECKS.map(([key]) => checkEl(key)))));
    refs.importBtn = mk('button', { type: 'button', onclick: () => core.importFile() }, 'Import settings');
    refs.resetBtn = K.confirmBtn('Reset settings', doReset, 'Click again to reset');
    const backup = K.group('Backup', mk('div', { class: 'idc-tools' }, mk('button', { type: 'button', onclick: () => core.exportFile() }, 'Export settings'), refs.importBtn, refs.resetBtn));
    const settings = [refs.lock, refs.fs, backup];

    // ---- Log tab
    refs.logv = K.createLogView();
    refs.alertBtn = mk('button', { type: 'button', title: 'Notify me when Autopilot stops, stalls or changes phase while this tab is in the background', onclick: async () => { await core.askNotify(); render(); } }, 'Enable alerts');
    const logTab = [
      refs.logv.el,
      mk('div', { class: 'idc-tools' },
        mk('button', { type: 'button', onclick: () => core.ledger.copy() }, 'Copy log'),
        mk('button', { type: 'button', class: 'danger', onclick: doClearLog }, 'Clear log'),
        refs.alertBtn),
      mk('div', { class: 'idc-desc' }, 'Alt+Shift+X stops Autopilot, CD Farm and the Lab runner from anywhere on the page.')];

    // ---- Footer (always visible)
    refs.mode = K.seg(MODES, () => !!cfg.dryRun, (id) => { cfg.dryRun = id; confirmUntil = 0; render(); }, 'Run mode');
    refs.plan = mk('div', { class: 'idc-plan' });
    refs.alt = mk('button', { onclick: () => { confirmUntil = 0; render(); } }, 'Cancel');
    refs.main = mk('button', { class: 'primary', onclick: onMain });
    const foot = mk('div', { class: 'idc-foot' }, refs.mode.el, refs.plan, mk('div', { class: 'idc-btns' }, refs.alt, refs.main));

    P = K.createPanel({
      id: 'ap', title: 'Autopilot', cls: 'egp-panel', state: ui, save: saveUi, headExtra: [refs.badge], foot,
      tabs: [{ id: 'status', label: 'Status', content: status }, { id: 'settings', label: 'Settings', content: settings }, { id: 'log', label: 'Log', content: logTab }],
      onClose: () => panel(false), onTab: () => render(), opener: () => chrome?.opener,
      // Default: bottom-left of the page content, just right of the game's sidebar.
      defaultPlace: () => { const side = document.querySelector('.primary-navigation')?.getBoundingClientRect(); return { left: side && side.right < innerWidth / 2 ? Math.round(side.right + 16) : 20 }; },
    });
    refs.dot = P.dot;
  }

  function onMain() {
    if (running) return stop();
    if (cfg.dryRun) return start();
    if (Date.now() < confirmUntil) { confirmUntil = 0; return start(); }
    confirmUntil = Date.now() + 6000;
    render();
    setTimeout(render, 6100);
  }

  // 'run' | 'wait' | 'err' | ''
  function tone() {
    if (running && stalled) return 'err';
    if (running) return heldReason() || cfg.dryRun ? 'wait' : 'run';
    if (stopReason && stopReason !== 'stopped by you') return 'err';
    return '';
  }

  function cdFarmNote() {
    const fi = farmInfo();
    if (fi?.busy) return { text: `CD Farm is running${fi.f.stats?.by ? ` (${fi.f.stats.by})` : ''}. Autopilot waits until it stops.`, btn: true };
    if (fi?.resumable) return { text: 'CD Farm has an interrupted run. Its leftover camps are left alone, and no camps, farms or booster run until you resume or discard it there.', btn: true };
    if (holds.size) return { text: `Held by ${[...holds].join(', ')}. earlyGame.release() to go on.`, btn: false };
    return null;
  }

  function renderPanel(s) {
    const t = tone();
    refs.dot.className = refs.stateDot.className = 'idc-dot ' + t;
    refs.badge.textContent = cfg.dryRun ? 'Dry run' : 'Live';
    refs.badge.className = 'idc-badge' + (cfg.dryRun ? '' : ' live');
    if (!s) {
      refs.phase.textContent = '—'; refs.phaseOf.textContent = ''; refs.rows.replaceChildren(); refs.check.replaceChildren();
      refs.state.textContent = 'Waiting for the game to load…';
    } else {
      const ph = phaseOf(s);
      refs.phase.textContent = ph === 'done' ? 'Plan done' : `Phase ${ph}`;
      refs.phaseOf.textContent = ph === 'done' ? '' : 'of 5';
      const list = checklist(s);
      const marks = list.filter(([, v]) => /^(✓|·|researching|queued)/.test(v));
      refs.bar.style.width = (marks.length ? (marks.filter(([, v]) => v.startsWith('✓')).length / marks.length) * 100 : 0) + '%';
      refs.rows.replaceChildren(
        row('Money', `${usd(s.money)} · floor ${usd(moneyFloor(s))}`),
        row('CD', uiNum(s.cd)),
        row('Acres', `${s.acresUsed} / ${s.acresOwned} · next ${usd(acrePrice(s.landBought))}`),
        row('Power', `${s.powerHave} MW (need ${s.powerNeed})`),
        row('Courier', s.courierFree ? 'free' : `busy, ${courierEta(s)}`),
        row('Actions', `${actions} sent this session`),
        ...(cashRate() ? [row('Cash change', `${signed(cashRate().perHour)}/h (last ${cashRate().mins} min)`)] : []),
        ...(rateScale < 1 ? [row('Pace', `${Math.round(rateScale * 100)}% after an action the server did not apply`)] : []));
      const skip = new Set(['Phase', 'Money', 'CD', 'Acres', 'Power', 'Courier']);
      refs.check.replaceChildren(...list.filter(([k]) => !skip.has(k)).map(([k, v]) => row(k, String(v))));
      const held = running && heldReason();
      let next;
      try { const d = decide(s); next = d.wait ? 'Waiting: ' + d.wait : 'Next: ' + d.reason; } catch (e) { next = 'error: ' + e.message; }
      refs.state.textContent = held ? `Paused: ${held}`
        : running ? (cfg.dryRun ? 'Dry run. ' : '') + next
        : (stopReason ? `Stopped: ${stopReason}. ` : 'Stopped. ') + next;
    }
    const n = cdFarmNote();
    refs.note.hidden = !n;
    if (n) { refs.noteText.textContent = n.text; refs.noteBtn.hidden = !n.btn || !W.cdFarm?.panel; }
    refs.log.replaceChildren(...log.map((l) => mk('div', {}, l)));
    refs.live.el.hidden = !liveCountdownUntil;
    if (liveCountdownUntil) refs.live.text.textContent = `Resuming Live after the reload in ${Math.max(0, Math.ceil((liveCountdownUntil - Date.now()) / 1000))} s. Cancel to resume as a dry run instead.`;
    refs.stall.el.hidden = !stalled;
    if (stalled) refs.stall.text.textContent = `Looks stalled: ${stalled}. Autopilot keeps running; check the log below.`;
    if (ui.tab === 'log' && !ui.min) { refs.logv.render(); refs.logv.markSeen(); }
    const unseen = ui.tab === 'log' ? 0 : refs.logv.unseen();
    P.setTabBadge('log', unseen ? unseen + ' new problem' + (unseen > 1 ? 's' : '') : '', true);
    refs.alertBtn.hidden = core.notifyPerm() !== 'default';

    // Settings
    const locked = running && !cfg.dryRun;
    refs.importBtn.disabled = refs.resetBtn.disabled = locked;
    refs.fs.disabled = locked;
    refs.lock.hidden = !locked;
    let changed = 0;
    for (const [key, f] of Object.entries(refs.fields)) {
      if (document.activeElement !== f.input) f.input.value = shown(key);
      f.msg.hidden = !parseErr[key]; f.msg.textContent = parseErr[key] || '';
      f.box.classList.toggle('bad', !!parseErr[key]);
      const mod = !same(cfg[key], DEFAULTS[key]);
      if (mod) changed++;
      K.setModified(f.el, mod, 'Reset to the default (' + (shownOf(key, DEFAULTS[key]) || FIELDS[key].empty || 'none') + ')', () => { delete parseErr[key]; setCfg(key, DEFAULTS[key]); });
    }
    for (const [key, input, label] of refs.checks) {
      input.checked = !!cfg[key];
      const mod = !!cfg[key] !== !!DEFAULTS[key];
      label.classList.toggle('mod', mod); label.title = mod ? 'Changed from the default' : '';
      if (mod) changed++;
    }
    P.setTabBadge('settings', changed ? changed + ' setting' + (changed > 1 ? 's' : '') + ' changed from the defaults' : '');
        refs.billNow.textContent = `Now ${cfg.billHours} h${s ? ` = ${usd(moneyFloor(s))} kept` : ''}. Back to 1 h on reload.`;

    // Footer
    refs.mode.sync();
    refs.mode.btns.forEach((b) => { b.disabled = running || active; });
    const other = lockOwner() && lockOwner() !== TAB && !running;
    const confirming = !running && !cfg.dryRun && Date.now() < confirmUntil;
    refs.plan.hidden = running;
    refs.plan.classList.toggle('hot', confirming);
    refs.plan.textContent = cfg.dryRun
      ? 'Dry run: works out every step and writes it to the log, but sends nothing.'
      : `Live: sends actions to the game, one confirmed step at a time, and never spends below the power-bill floor${s ? ` (${usd(moneyFloor(s))})` : ''}.${confirming ? ' Click Confirm start to go.' : ''}`;
    refs.main.textContent = running ? 'Stop' : other ? 'Running in another tab' : active ? 'Stopping…' : cfg.dryRun ? 'Start dry run' : confirming ? 'Confirm start' : 'Start live';
    refs.main.disabled = !running && (other || active || !s);
    refs.alt.hidden = !confirming;
  }

  const onResize = () => P?.place();

  function render() {
    if (!HAS_DOM || unloaded) return;
    const s = read();
    const t = tone();
    const ph = s ? phaseOf(s) : null;
    chrome?.setPill(heldReason() ? 'Held' : cfg.dryRun ? 'Dry run' : ph === 'done' ? 'Done' : `P${ph ?? '?'}`, t, !running);
    chrome?.setChip(ph == null ? 'Autopilot' : ph === 'done' ? 'Plan done' : `Phase ${ph}`, t,
      `Autopilot · ${running ? (heldReason() ? 'paused' : cfg.dryRun ? 'dry run' : 'live') : 'stopped'}`);
    const open = !!P?.el.isConnected;
    chrome?.setOpen(open);
    if (open) renderPanel(s);
  }

  function panel(show = true, opts = {}) {
    if (!HAS_DOM || unloaded) return;
    if (show) { if (!P) buildPanel(); P.mount(opts); } else P?.unmount();
    ui.open = !!show; saveUi();
    render();
  }

  function mountUi() {
    chrome = K.createChrome({
      label: 'Autopilot', navTitle: 'Early-game autopilot', icon: ICON, navClass: 'egp-tab', chipClass: 'egp-chip',
      onToggle: () => K.togglePanel(P, ui, panel),
      navInsert: (nav, el) => nav.insertBefore(el, nav.querySelector('.cdf-tab')),   // above CD Farm's tab
      chipInsert: (tools, el) => tools.insertBefore(el, tools.querySelector('.cdf-chip') || tools.querySelector('.tip-anchor') || null),
    });
    chrome.mount();
    uiTimer = setInterval(render, 1000);
    if (ui.open) panel(true); else render();
    addEventListener('resize', onResize);
  }
  function unmountUi() {
    clearInterval(uiTimer); uiTimer = null;
    P?.unmount(); chrome?.unmount();
    P = chrome = null;
    removeEventListener('resize', onResize);
  }

