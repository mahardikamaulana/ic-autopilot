// continues the autopilot closure from autopilot-4.js (same try / IIFE)
  // ---- game UI ----------------------------------------------------------------------
  // The Autopilot panel, built from the shared parts in core-form.js (core.ui): Status (hero, rows, state, banners,
  // checklist), Settings (the same groups, controls and Backup as the other panels), Log, and a footer with the run mode.
  // Nothing here runs without a DOM, so the offline simulator is unaffected.

  const UI_KEY = 'earlyGame.ui';
  const ui = (() => { try { return { open: true, x: null, y: null, ...JSON.parse(store?.getItem(UI_KEY) || '{}') }; } catch { return { open: true, x: null, y: null }; } })();
  const saveUi = () => { try { store?.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };

  const ICON = '<svg class="nav-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16h4v-4h4V8h4V4"></path><circle cx="15" cy="4" r="1.6" fill="currentColor" style="stroke:var(--nav-accent)"></circle></svg>';

  const mk = core.h;
  const K = core.ui;
  let P = null, chrome = null, uiTimer = null, unloaded = false;
  const refs = {};
  let confirmUntil = 0;

  const FIELDS = {
    workshops: { kind: 'count', label: 'Frame Timber Workshops', min: 0, max: 50 },
    sawmills: { kind: 'count', label: 'Sawmills (at least)', min: 0, max: 200 },
    ironMines: { kind: 'count', label: 'Iron Mines (at least)', min: 0, max: 100 },
    coalMines: { kind: 'count', label: 'Coal Mines (at least)', min: 0, max: 100 },
    goldMines: { kind: 'count', label: 'Gold Mines', min: 0, optional: true, empty: 'Auto' },
    ironFrameWorkshops: { kind: 'count', label: 'Iron Frame Workshops', min: 0, max: 50 },
    landPaybackHours: { kind: 'count', label: 'Land pays back within', min: 0, max: 1000, unit: 'h' },
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
    floorBuyMult: { kind: 'mult', label: 'Floor parts, max × base', min: 0, max: 100, unit: '×' },
    buyOrderMult: { kind: 'mult', label: 'Buy order price (× base)', min: 0.1, max: 100, unit: '×' },
    orderHoldHours: { kind: 'count', label: 'Order hold', min: 0, max: 720, unit: 'h' },
    maxActionsPerMin: { kind: 'count', label: 'Max actions per minute', min: 1, max: 60 },
    intervalMs: { kind: 'count', label: 'Check every', min: 500, max: 60000, unit: 'ms' },
    maxIdleMs: { kind: 'count', label: 'Slowest idle check', min: 500, max: 120000, unit: 'ms' },
    stallMinutes: { kind: 'count', label: 'Stall alert after', min: 0, max: 600, unit: 'min' },
  };
  const ADV_FIELDS = ['quarries', 'smelters', 'maxAcrePriceCritical', 'landCashShare', 'boosterAcres', 'woodReserve', 'sellKeepMinutes', 'maxBuyPrice', 'floorBuyMult', 'buyOrderMult', 'orderHoldHours', 'maxActionsPerMin', 'intervalMs', 'maxIdleMs', 'stallMinutes'];
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
  function setCfg(key, v) { cfg[key] = v; confirmUntil = 0; save(); render(); }
  const shownOf = (key, v) => (Number.isFinite(v) ? K.fmt(FIELDS[key]?.kind === 'pct' ? v * 100 : v) : '');

  function parseField(key, text) {
    const f = FIELDS[key];
    const str = text.trim();
    if (str === '') return f.optional ? { v: Infinity } : { err: 'Required.' };
    const decimal = f.kind === 'usd' || f.kind === 'mult' || f.kind === 'pct';
    let v;
    if (decimal) {
      v = /^[$]?\d*\.?\d+[%×x]?$/i.test(str.replace(/[,\s_]/g, '')) ? Number(str.replace(/[$,%×x\s_]/gi, '')) : null;
      if (v != null && f.kind === 'pct') v /= 100;
    } else v = K.parseAmount(str);
    if (v == null) return { err: decimal ? 'Use a number like 1 or 0.5.' : f.kind === 'money' ? 'Use an amount like 500, 20k or 1.5m.' : 'Use a whole number.' };
    const disp = (x) => K.fmt(f.kind === 'pct' ? x * 100 : x);
    if (f.min != null && v < f.min) return { err: `At least ${disp(f.min)}.` };
    if (f.max != null && v > f.max) return { err: `At most ${disp(f.max)}.` };
    return { v };
  }

  const signed = (c) => (c < 0 ? '−' : '+') + usd(Math.abs(c));

  function amountOf(key) {
    const f = FIELDS[key];
    return K.amountField({
      label: f.label, prefix: f.kind === 'money' || f.kind === 'usd' ? '$' : '', suffix: f.unit, placeholder: f.empty || '',
      parse: (t) => parseField(key, t), format: (v) => shownOf(key, v),
      get: () => cfg[key], set: (v) => setCfg(key, v), def: DEFAULTS[key], redraw: render,
    });
  }

  function buildPanel() {
    refs.badge = mk('span', { class: 'idc-badge' });
    refs.fields = {};
    const amount = (...keys) => keys.map((k) => (refs.fields[k] = amountOf(k)).el);
    refs.toggles = {};
    for (const [key, label] of [...CHECKS, ...ADV_CHECKS]) refs.toggles[key] = K.toggleField(label, '', { get: () => cfg[key], set: (v) => setCfg(key, v), def: DEFAULTS[key] });
    const tog = (key) => refs.toggles[key].el;

    // ---- Status tab
    refs.hero = K.hero('Early-game plan');
    refs.rows = K.rowList();
    refs.state = K.stateLine();
    refs.cdNote = K.banner(() => W.cdFarm?.panel?.(true), 'Open CD Farm');
    refs.live = K.banner(() => { liveCountdownUntil = 0; W.corePlan?.cancelResume?.(); render(); }, 'Cancel: resume as a dry run');   // both countdowns: one Cancel
    refs.stall = K.banner(() => { stalled = ''; core.setBadge('AP', ''); prog.at = nowMs(); prog.acts = 0; render(); }, 'Snooze');
    refs.check = K.rowList();
    refs.log = mk('div', { class: 'idc-recent', 'aria-live': 'polite' });
    const checkSec = K.disclosure('Checklist', [refs.check.el], { open: !!ui.checkOpen, onToggle: (o) => { ui.checkOpen = o; saveUi(); } });
    const status = [refs.hero.el, refs.rows.el, refs.state.el, refs.cdNote.el, refs.live.el, refs.stall.el, refs.log, checkSec];

    // ---- Settings tab
    refs.hours = K.inputBox({ label: 'Hours offline', suffix: 'h' });
    refs.hours.input.value = '8';
    refs.billNow = mk('div', { class: 'idc-desc' });
    const offBtn = mk('button', { type: 'button', onclick: () => { const hrs = Number(refs.hours.input.value); if (hrs > 0) { offline(hrs); render(); } } }, 'Keep bills');
    refs.dryRunSwitch = K.toggleField('Dry run switch', 'Shows the Dry run / Live switch in the footer. Dry run works out every step and sends nothing.', { get: () => !!ui.dryRunSwitch, set: (v) => { ui.dryRunSwitch = v; saveUi(); if (!running && !active) cfg.dryRun = v; render(); }, def: false });
    refs.settings = K.settingsTab({
      lockText: 'Stop the live run to change settings.',
      tail: [K.group('Experimental', refs.dryRunSwitch.el)],
      groups: [
        K.group('Build targets', mk('div', { class: 'idc-two' }, ...amount('workshops', 'sawmills', 'ironMines', 'coalMines', 'goldMines', 'ironFrameWorkshops'))),
        K.group('Land price limits', mk('div', { class: 'idc-two' }, ...amount('landPaybackHours', 'maxAcrePriceEarly', 'maxAcrePrice')),
          mk('div', { class: 'idc-desc' }, 'Camps, farms and Gold Mines get land while it and the building pay back from their own income within this time; with no bid for what they make, the walls (most per acre, early on and later) apply.')),
        K.group('CD booster', mk('div', { class: 'idc-two' }, ...amount('boosterBatch', 'boosterMinCash', 'boosterKeepCash')), tog('cdBooster')),
        K.group('Automation', ...['sellAll', 'floorUpgrades', 'buyKits', 'postBuyOrders', 'dispatchOffice', 'autoResume'].map(tog)),
        K.group('Power bills', K.field('Going offline: keep power bills for', mk('div', { class: 'idc-inline' }, refs.hours.box, offBtn), refs.billNow)),
      ],
      advanced: K.disclosure('Advanced', [K.group(null, mk('div', { class: 'idc-two' }, ...amount(...ADV_FIELDS)), ...ADV_CHECKS.map(([key]) => tog(key)))],
        { open: !!ui.advOpen, onToggle: (o) => { ui.advOpen = o; saveUi(); } }),
      backup: { onExport: () => core.exportFile(), onImport: () => core.importFile(), onReset: () => K.resetSettings('Autopilot', { snapshot: exportCfg, reset: resetCfg, restore: importCfg }) },
    });

    // ---- Log tab
    refs.alertBtn = mk('button', { type: 'button', title: 'Notify me when Autopilot stops, stalls or changes phase while this tab is in the background', onclick: async () => { await core.askNotify(); render(); } }, 'Enable alerts');
    const logt = K.logTab({ extra: [refs.alertBtn] });
    refs.logv = logt.logv;

    // ---- Footer (always visible)
    refs.mode = K.runModeSeg(() => !!cfg.dryRun, (id) => { cfg.dryRun = id; confirmUntil = 0; render(); });
    refs.alt = mk('button', { onclick: () => { confirmUntil = 0; render(); } }, 'Cancel');
    refs.main = mk('button', { class: 'primary', onclick: onMain });
    const foot = K.footer({ top: [refs.mode.el], main: refs.main, alt: refs.alt });
    refs.plan = foot.plan;

    P = K.createPanel({
      id: 'ap', title: 'Autopilot', cls: 'egp-panel', state: ui, save: saveUi, headExtra: [refs.badge], foot: foot.el,
      tabs: [{ id: 'status', label: 'Status', content: status }, { id: 'settings', label: 'Settings', content: refs.settings.content }, { id: 'log', label: 'Log', content: logt.content }],
      onClose: () => panel(false), onTab: () => render(), opener: () => chrome?.opener,
      // Default: bottom-left of the page content, just right of the game's sidebar.
      defaultPlace: () => { const side = document.querySelector('.primary-navigation')?.getBoundingClientRect(); return { left: side && side.right < innerWidth / 2 ? Math.round(side.right + 16) : 20 }; },
    });
  }

  // The mode shown and started from the panel while idle: Dry run only with the experimental switch on. A run in progress shows what it really is.
  const viewDry = () => !!cfg.dryRun;   // the mode the panel shows and starts in: exactly what cfg says. Safety paths set it on purpose (refused Live, a reload resumed as a dry run), so the render never overrides it.
  // Core plan in this panel: once the plan is done (or the hand-off has stopped Autopilot) and whenever it runs; null otherwise.
  function cpOf(s) {
    let c = null; try { c = W.corePlan?.status?.() ?? null; } catch {}
    if (!c) return null;
    const p = s ? phaseOf(s) : null;
    c.handedOff &&= p === 'done' || p >= 4;   // the saved hand-off has no corp id: a new corp in this browser starts at Phase 1 again (4: a bill pause)
    return c.running || c.handedOff || p === 'done' ? c : null;
  }
  // Core plan has taken over (it runs, or the hand-off is done): the panel is Core plan's, with the early plan as one "done" row.
  const coreView = (cp) => !!cp && (cp.running || cp.handedOff);
  const STAGES = [['A', 'start'], ['B', 'Assembly Plant unlock'], ['C', 'Retail Store unlock'], ['D', 'Retail Store built']];
  const END_NAMES = { E1: 'money engine runs', E2: 'only endgame unlocks left', E3: 'CD on the Farm cycle', E4: 'land done', E5: 'cash in hand' };
  // Progress of the whole plan, so the bar never drops back at the hand-off: the early plan is the first fifth, then a fifth per stage A-D
  // (in Stage D, the share of end conditions E1-E5 that hold).
  function cpProgress(cp) {
    const i = STAGES.findIndex(([k]) => k === cp.stage);
    if (cp.stage === 'END') return 100;
    if (i < 0) return 100 / (STAGES.length + 1);   // starting: the early plan is done
    const ok = cp.end.filter((e) => / ok:/.test(e)).length;
    return ((1 + i + (cp.stage === 'D' && cp.end.length ? ok / cp.end.length : 0)) / (STAGES.length + 1)) * 100;
  }
  // Core plan's checklist: its stages, then the end conditions E1-E5 (the endgame gate; the log and corePlan.status() say why one is open).
  function cpChecklist(cp) {
    const i = cp.stage === 'END' ? STAGES.length : STAGES.findIndex(([k]) => k === cp.stage);
    return [
      ...STAGES.map(([k, what], j) => ['Stage ' + k + ' · ' + what, j < i ? '✓' : j === i ? 'now' : '·']),
      ...cp.end.map((e) => { const m = /^(E\d) (ok|NO):/.exec(e); return m ? [m[1] + ' · ' + (END_NAMES[m[1]] ?? ''), m[2] === 'ok' ? '✓' : '·'] : [e, '']; }),
    ];
  }
  const cpMode = (c) => (c.running ? (c.resumeIn ? 'resuming Live in ' + c.resumeIn + ' s' : c.dryRun ? 'dry run' : 'live') : 'stopped');
  function onMain() {
    const s = read(), cp = cpOf(s);
    // After Plan done one button runs both: Stop stops Autopilot and Core plan; Start starts Core plan alone once the hand-off is done.
    if (running || cp?.running) { if (cp?.running) W.corePlan.stop(); if (running) stop(); else render(); return; }
    const go = (dry) => { if (cp?.handedOff) { W.corePlan.start({ dryRun: dry }); render(); } else if (dry) start(); else start({ dryRun: false }); };
    if (viewDry()) return go(true);
    if (Date.now() < confirmUntil) { confirmUntil = 0; return go(false); }
    confirmUntil = Date.now() + 6000;
    render();
    setTimeout(render, 6100);
  }

  // 'run' | 'wait' | 'err' | ''
  function tone(cp) {
    if (running && stalled) return 'err';
    if (coreView(cp)) return cp.running ? (cp.dryRun ? 'wait' : 'run') : cp.stopReason ? 'err' : '';   // a short hold for a Core plan purchase is not a pause
    if (running) return heldReason() || cfg.dryRun ? 'wait' : 'run';
    if (cp?.running) return cp.dryRun || cp.holds.length ? 'wait' : 'run';
    if (cp?.stopReason) return 'err';
    if (stopReason && stopReason !== 'stopped by you') return 'err';
    return '';
  }

  function cdFarmNote(cv) {
    // Holds by CD Farm and Core plan are their own short steps; only a hold from the console needs the user.
    const mine = [...holds].filter((w) => w !== 'corePlan' && w !== 'CD Farm');
    const fi = farmInfo();
    if (cv) {
      // A non-Auto CD Farm run left interrupted blocks CD Farm Auto, which Core plan drives: that one needs the user.
      if (fi?.resumable) return { text: 'CD Farm has an interrupted run. Resume or discard it in CD Farm so it can farm CD for Core plan again.', btn: true };
      return mine.length ? { text: `Autopilot's selling and bill chores are paused from the console (${mine.join(', ')}). Run earlyGame.release() there to go on.`, btn: false } : null;
    }
    if (fi?.busy) return { text: `CD Farm is running${fi.f.stats?.by ? ` (${fi.f.stats.by})` : ''}. Autopilot waits until it stops.`, btn: true };
    if (fi?.resumable) return { text: 'CD Farm has an interrupted run. Its leftover camps are left alone, and no camps, farms or booster run until you resume or discard it there.', btn: true };
    if (mine.length) return { text: `Autopilot is paused from the console (${mine.join(', ')}). Run earlyGame.release() there to go on.`, btn: false };
    return null;
  }

  function renderPanel(s, ph, cp, t) {
    K.setTone(P.dot, t);
    const on = running || !!cp?.running, dry = running || !cp?.running ? viewDry() : cp.dryRun;
    refs.badge.textContent = dry ? 'Dry run' : 'Live';
    refs.badge.className = 'idc-badge' + (dry ? '' : ' live');
    if (!s) {
      refs.hero.set('—', '', 0); refs.rows.set([]); refs.check.set([]);
      refs.state.set(t, 'Waiting for the game to load…');
    } else {
      const cv = coreView(cp);
      const list = checklist(s);
      const marks = list.filter(([, v]) => /^(✓|·|researching|queued)/.test(v));
      if (cv) refs.hero.set(cp.stage === 'END' ? 'Done' : cp.stage ? 'Stage ' + cp.stage : 'Starting', cp.stage === 'END' ? 'end conditions met' : cp.stage ? 'of D' : '', cpProgress(cp), 'Core plan');
      else refs.hero.set(ph === 'done' ? 'Plan done' : `Phase ${ph}`, ph === 'done' ? '' : 'of 5',
        ph === 'done' ? 100 : marks.length ? (marks.filter(([, v]) => v.startsWith('✓')).length / marks.length) * 100 : 0, 'Early-game plan');   // done is full: optional rows (Gold Mines) never tick
      refs.rows.set([
        ...(cv ? [['Early-game plan', '✓ done']] : cp ? [['Core plan', (cp.stage ? 'stage ' + cp.stage + ' · ' : '') + cpMode(cp)]] : []),
        ...(cv && cp.resumeIn ? [['Core plan', cpMode(cp)]] : []),
        // Autopilot runs on after the hand-off only for its chores, until Auto power takes over the subscription
        ...(cv && running ? [['Autopilot chores', cfg.dryRun ? 'dry run, sends nothing' : s.autoPower ? 'selling, bill resume' : 'until Auto power is on']] : []),
        ['Money', cv ? usd(s.money) : `${usd(s.money)} · floor ${usd(moneyFloor(s))}`],
        ['CD', K.fmt(s.cd)],
        ['Acres', `${s.acresUsed} / ${s.acresOwned} · next ${usd(acrePrice(s.landBought))}`],
        // the subscription only (bought contracts are not in it): after the hand-off Auto utilities and Core plan's checks own power
        ...(cv ? [] : [['Power', `${s.powerHave} MW (need ${s.powerNeed})`]]),
        ['Courier', s.courierFree ? 'free' : `busy, ${courierEta(s)}`],
        ...(cv ? [] : [['Actions', `${actions} sent this session`]]),
        ...(cashRate() ? [['Cash change', `${signed(cashRate().perHour)}/h (last ${cashRate().mins} min)`]] : []),
        ...(rateScale < 1 ? [['Pace', `${Math.round(rateScale * 100)}% after an action the server did not apply`]] : []),
      ]);
      const skip = new Set(['Phase', 'Money', 'CD', 'Acres', 'Power', 'Courier']);
      refs.check.set(cv ? cpChecklist(cp) : list.filter(([k]) => !skip.has(k)).map(([k, v]) => [k, String(v)]));
      const held = running && heldReason();
      let next;
      try { const d = decide(s); next = d.wait ? 'Waiting: ' + d.wait : 'Next: ' + d.reason; } catch (e) { next = 'error: ' + e.message; }
      // Core plan's line once it runs (or Autopilot has stopped at Plan done): what it does next or waits for
      const cpLine = cp && (cp.running || !running) ? (cp.running ? (cp.dryRun ? 'Dry run. ' : '') + 'Core plan ' + (cp.next ? 'next: ' + cp.next : cp.waits[0] ? 'waiting: ' + cp.waits[0] : 'is reading the game…')
        : 'Core plan stopped' + (cp.stopReason ? ': ' + cp.stopReason : '') + '.') : '';
      refs.state.set(t, cv ? cpLine || 'Core plan stopped.'
        : held ? `Paused: ${held}`
        : cpLine ? cpLine
        : running ? (cfg.dryRun ? 'Dry run. ' : '') + next
        : (stopReason ? `Stopped: ${stopReason}. ` : 'Stopped. ') + next);
    }
    const cv = coreView(cp);
    const n = cdFarmNote(cv);
    refs.cdNote.set(n?.text ?? '', !!n?.btn && !!W.cdFarm?.panel);
    // Recent lines: Core plan's once it has taken over, Autopilot's before
    const recent = cv ? core.ledger.list().filter((e) => e.mod === 'CP').slice(-6).reverse().map((e) => new Date(e.t).toLocaleTimeString() + ' ' + e.text) : log;
    refs.log.replaceChildren(...recent.map((l) => mk('div', {}, l)));
    refs.live.set(liveCountdownUntil ? `Resuming Live after the reload in ${Math.max(0, Math.ceil((liveCountdownUntil - Date.now()) / 1000))} s. Cancel to resume as a dry run instead.`
      : cp?.resumeIn ? `Core plan resumes Live after the reload in ${cp.resumeIn} s. Cancel to keep it a dry run.` : '');
    refs.stall.set(stalled ? `Looks stalled: ${stalled}. Autopilot keeps running; check the log below.` : '');
    K.syncLog(P, ui, refs.logv);
    refs.alertBtn.hidden = core.notifyPerm() !== 'default';

    // Settings
    refs.settings.sync(running && !cfg.dryRun);
    let changed = 0;
    for (const f of Object.values(refs.fields)) if (f.sync()) changed++;
    for (const k of Object.keys(refs.toggles)) if (refs.toggles[k].sync()) changed++;
    P.setTabBadge('settings', changed ? changed + ' setting' + (changed > 1 ? 's' : '') + ' changed from the defaults' : '');
    refs.billNow.textContent = `Now ${cfg.billHours} h${s ? ` = ${usd(moneyFloor(s))} kept` : ''}. Back to 1 h on reload.`;

    // Footer
    // Dry run is experimental: off by default, so the panel runs Live unless the switch is on.
    refs.mode.el.hidden = !ui.dryRunSwitch;
    refs.dryRunSwitch.input.disabled = running || active;
    refs.mode.sync();
    refs.mode.btns.forEach((b) => { b.disabled = on || active; });
    const other = lockOwner() && lockOwner() !== TAB && !running;
    const confirming = !on && !viewDry() && Date.now() < confirmUntil;
    refs.plan.set(viewDry()
      ? 'Dry run: works out every step and writes it to the log, but sends nothing.'
      : `Live: sends actions to the game, one confirmed step at a time, and never spends below the power-bill floor${s ? ` (${usd(moneyFloor(s))})` : ''}.${confirming ? ' Click Confirm start to go.' : ''}`,
    { hidden: on, hot: confirming });
    refs.main.textContent = on ? 'Stop' : other ? 'Running in another tab' : active ? 'Stopping…' : viewDry() ? 'Start dry run' : confirming ? 'Confirm start' : 'Start live';
    refs.main.disabled = !on && (other || active || !s);
    refs.alt.hidden = !confirming;
  }

  const onResize = () => P?.place();

  function render() {
    if (!HAS_DOM || unloaded) return;
    const s = read();
    const cp = cpOf(s);
    const t = tone(cp);
    const ph = s ? (cp?.handedOff ? 'done' : phaseOf(s)) : null;   // after the hand-off the early plan stays done, even if Iron Frames dip
    const dry = running || !cp?.running ? viewDry() : cp.dryRun, stage = cp?.running && cp.stage;
    chrome?.setPill(!coreView(cp) && heldReason() ? 'Held' : dry ? 'Dry run' : ph === 'done' ? (stage ? 'Core ' + stage : 'Done') : `P${ph ?? '?'}`, t, !(running || cp?.running));
    chrome?.setChip(ph == null ? 'Autopilot' : ph === 'done' ? (stage ? 'Core plan ' + stage : 'Plan done') : `Phase ${ph}`, t,
      `Autopilot · ${running ? (heldReason() ? 'paused' : cfg.dryRun ? 'dry run' : 'live') : 'stopped'}` + (cp ? ' · Core plan · ' + cpMode(cp) : ''));
    const open = !!P?.el.isConnected;
    chrome?.setOpen(open);
    if (open) renderPanel(s, ph, cp, t);
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
    if (!ui.dryRunSwitch && !running && !active) cfg.dryRun = false;   // Dry run is experimental: off by default, so the panel starts Live unless the switch is on.
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
