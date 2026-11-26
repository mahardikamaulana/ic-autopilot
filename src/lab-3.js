// continues the lab closure from lab-2.js (same try / IIFE)
  // ---- game UI -------------------------------------------------------------------------------------
  // The Lab panel, built from the shared parts in core-form.js (core.ui): Status, Settings (research, custom list,
  // spending, automation, Backup), Log, and a footer with the run mode. Nothing here runs without a DOM, so the offline tests are unaffected.

  const UI_KEY = 'labRunner.ui';
  const ui = (() => { try { return { open: false, x: null, y: null, ...JSON.parse(store?.getItem(UI_KEY) || '{}') }; } catch { return { open: false, x: null, y: null }; } })();
  const saveUi = () => { try { store?.setItem(UI_KEY, JSON.stringify(ui)); } catch {} };

  const ICON = '<svg class="nav-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h4"></path><path d="M9 3v5.2L4.7 15.3a1.5 1.5 0 0 0 1.3 2.2h8a1.5 1.5 0 0 0 1.3-2.2L11 8.2V3"></path><path d="M6.6 13h6.8" style="stroke:var(--nav-accent)"></path></svg>';
  const svg16 = (d) => '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const ARROWS = { up: svg16('<path d="M4 10l4-4 4 4"/>'), down: svg16('<path d="M4 6l4 4 4-4"/>') };

  const h = core.h;
  const K = core.ui;
  let P = null, chrome = null, timer = null;
  const refs = {};
  let confirmUntil = 0;

  const MODES = [
    { id: 'process', label: 'Process study', desc: 'Process study on products your groups make: the one studied least so far, the pricier one on a tie.' },
    { id: 'modules', label: 'Modules', desc: 'Module fabrication (5 points less likely to succeed). Products picked the same way; if none of yours qualifies, the most valuable one.' },
    { id: 'list', label: 'Custom list', desc: 'Your own list, in order, round and round. Entries that are not Lab products are skipped.' },
  ];
  const MODE_OPTS = MODES.map((m) => (m.id === 'modules' ? { ...m, full: 'Module fabrication' } : m));
  const TIER_OPTS = [{ id: 'best', label: 'Best', full: 'Best value' }, { id: 1, label: 'I', full: 'Tier I' }, { id: 2, label: 'II', full: 'Tier II' }, { id: 3, label: 'III', full: 'Tier III' }];
  const TIER_DESC = {
    best: 'Best value: Tier I (1,000 MD), which gives the most results per MD. Tier II (10,000 MD + 5 RD) or III (100,000 MD + a Catalyst in that region) only when the MD left above the reserve after paying is at least 10 times its cost. The reserve stays untouched.',
    1: 'Tier I only (1,000 MD). Waits when it can\'t pay; never moves to another tier.',
    2: 'Tier II only (10,000 MD + 5 RD). Waits when it can\'t pay; never moves to another tier.',
    3: 'Tier III only (100,000 MD + a Catalyst in that region). Waits when it can\'t pay; never moves to another tier.',
  };
  const RESERVE_CHIPS = [0, 1000, 5000, 20000, 100000];
  const RESERVE_ITEMS = RESERVE_CHIPS.map((v) => [v, K.short(v)]);
  const FIELDS = { mdReserve: { label: 'MD reserve', min: 0, max: 1e9 } };
  function parseField(key, text) {
    const f = FIELDS[key], s = text.trim();
    if (s === '') return { err: 'Required.' };
    const v = K.parseAmount(s);
    if (v == null) return { err: 'Use a number like 5000, 5k or 50,000.' };
    if (v < f.min) return { err: `Must be at least ${fmt(f.min)}.` };
    if (v > f.max) return { err: `Must be at most ${fmt(f.max)}.` };
    return { v };
  }
  function setCfg(key, v) { cfg[key] = v; confirmUntil = 0; save(); render(); }

  // ---- custom list editor ----
  // The rows are rebuilt only when the list (or the product catalog) changes, never while you are choosing in a select.
  const listSig = (r) => (r ? index(r.catalog).products.size : 0) + '|' + JSON.stringify(cfg.list);
  function setList(list, rebuild = true) {
    cfg.list = list; confirmUntil = 0; save();
    if (!rebuild) refs.listSig = listSig(read());   // the controls already show it
    render();
  }
  function editEntry(i, patch) {
    if (!cfg.list[i]) return;
    setList(cfg.list.map((e, j) => (j === i ? { ...e, ...patch } : e)), false);
  }
  function moveEntry(i, d) {
    const j = i + d;
    if (j < 0 || j >= cfg.list.length) return;
    const l = cfg.list.slice();
    [l[i], l[j]] = [l[j], l[i]];
    refs.focusRow = [j, d < 0 ? 'up' : 'down'];
    setList(l);
  }
  function removeEntry(i) {
    refs.focusRow = [Math.min(i, cfg.list.length - 2), 'del'];
    setList(cfg.list.filter((_, j) => j !== i));
  }
  function addEntry() {
    const r = read();
    if (!r || cfg.list.length >= LIST_MAX) return;
    const ix = index(r.catalog);
    const made = [...produced(r.st, ix).keys()].map((id) => ix.products.get(id));
    const best = (made.length ? made : [...ix.products.values()]).sort((a, b) => b.base_value - a.base_value || a.id - b.id)[0];
    if (!best) return;
    refs.focusRow = [cfg.list.length, 'del'];
    setList([...cfg.list, { product: best.id, focus: 0, tier: 'default' }]);
  }
  function rowBtn(icon, label, act, onclick, disabled) {
    const b = h('button', { type: 'button', class: 'idc-ib', title: label, 'aria-label': label, onclick, disabled });
    b.setAttribute('data-act', act);
    b.innerHTML = icon;
    return b;
  }
  function listRow(ix, e, i, n) {
    const known = ix.products.has(e.product);
    const prod = h('select', { class: 'idc-sel', 'aria-label': `Product, entry ${i + 1}`, onchange: () => editEntry(i, { product: +prod.value }) },
      ...(known ? [] : [h('option', { value: String(e.product) }, `Not a Lab product (#${e.product})`)]),
      ...ix.byName.map((it) => h('option', { value: String(it.id) }, it.name)));
    prod.value = String(e.product);
    const foc = h('select', { class: 'idc-sel', 'aria-label': `Focus, entry ${i + 1}`, onchange: () => editEntry(i, { focus: +foc.value }) },
      ...FOCUS.map((f, k) => h('option', { value: String(k) }, f)));
    foc.value = String(e.focus);
    const tier = h('select', { class: 'idc-sel', 'aria-label': `Tier, entry ${i + 1}`, onchange: () => editEntry(i, { tier: tier.value === 'default' ? 'default' : +tier.value }) },
      h('option', { value: 'default' }, 'Default tier'), ...TIERS.map((k, t) => h('option', { value: String(t + 1) }, 'Tier ' + k.name)));
    tier.value = String(e.tier);
    return h('div', { class: 'idc-lrow' + (known ? '' : ' skip'), title: known ? '' : 'Skipped: not a product the Lab accepts' },
      h('div', { class: 'idc-lctl' }, prod,
        rowBtn(ARROWS.up, 'Move up', 'up', () => moveEntry(i, -1), i === 0),
        rowBtn(ARROWS.down, 'Move down', 'down', () => moveEntry(i, 1), i === n - 1),
        rowBtn(K.ICONS.close, 'Remove entry', 'del', () => removeEntry(i))),
      h('div', { class: 'idc-two' }, foc, tier));
  }
  function renderList(r) {
    const sig = listSig(r);
    if (sig !== refs.listSig) {
      refs.listSig = sig;
      const ix = r ? index(r.catalog) : null;
      refs.list.replaceChildren(...(ix ? cfg.list.map((e, i) => listRow(ix, e, i, cfg.list.length)) : []));
      if (refs.focusRow) {
        const [j, act] = refs.focusRow;
        const row = refs.list.children[j];
        (row?.querySelector(`[data-act="${act}"]:not(:disabled)`) ?? row?.querySelector('select') ?? refs.addBtn).focus();
      }
    }
    refs.focusRow = null;   // one-shot: only for the rebuild it was asked for
    const n = cfg.list.length;
    refs.addBtn.disabled = !r || n >= LIST_MAX;
    refs.listNote.textContent = !n ? 'The list is empty: nothing starts until you add an entry.'
      : `Cycles in order. Next up: #${(Number.isInteger(mem.next) ? mem.next % n : 0) + 1}.`;
  }

  // ---- panel ----
  // The mode shown and started from the panel while idle: Dry run only with the experimental switch on. A run in progress shows what it really is.
  const viewDry = () => !!cfg.dryRun;   // the mode the panel shows and starts in: exactly what cfg says. Safety paths set it on purpose (refused Live, a reload resumed as a dry run), so the render never overrides it.
  function onMain() {
    if (running) return stop();
    if (viewDry()) return start();
    if (Date.now() < confirmUntil) { confirmUntil = 0; return start({ dryRun: false }); }
    confirmUntil = Date.now() + 6000;
    render();
    setTimeout(render, 6100);
  }

  function buildPanel() {
    refs.badge = h('span', { class: 'idc-badge' });

    // ---- Status tab
    refs.hero = K.hero('Lab slots busy');
    refs.rows = K.rowList();
    refs.successNote = h('div', { class: 'idc-desc' });
    refs.state = K.stateLine();
    const status = [refs.hero.el, refs.rows.el, refs.successNote, refs.state.el];

    // ---- Settings tab
    refs.mode = K.segField('Research focus', MODE_OPTS, { get: () => cfg.mode, set: (id) => setCfg('mode', id), def: DEFAULTS.mode, describe: (v) => MODES.find((m) => m.id === v)?.desc || '' });
    refs.tier = K.segField('Tier', TIER_OPTS, { get: () => cfg.tierMode, set: (id) => setCfg('tierMode', id), def: DEFAULTS.tierMode, describe: (v) => TIER_DESC[v] || '' });
    refs.reserveChips = K.quickPicks((v) => setCfg('mdReserve', v));
    refs.reserve = K.amountField({
      label: FIELDS.mdReserve.label, suffix: 'MD', extra: [refs.reserveChips.el],
      parse: (t) => parseField('mdReserve', t), format: (v) => fmt(v), get: () => cfg.mdReserve, set: (v) => setCfg('mdReserve', v), def: DEFAULTS.mdReserve, redraw: render,
    });
    refs.autoClaim = K.toggleField('Claim finished results', 'Claims the oldest waiting result first, one per check.', { get: () => cfg.autoClaim, set: (v) => setCfg('autoClaim', v), def: DEFAULTS.autoClaim });
    refs.keepLive = K.toggleField('Stay Live after a reload', 'A Live run that is still going when the page reloads starts Live again (the same checks as Start live). Off: it stays stopped.', { get: () => cfg.keepLive, set: (v) => setCfg('keepLive', v), def: DEFAULTS.keepLive });
    refs.list = h('div', { class: 'idc-group' });
    refs.addBtn = h('button', { type: 'button', onclick: addEntry }, 'Add entry');
    refs.listNote = h('div', { class: 'idc-desc' });
    refs.listBox = K.group('Custom list', refs.list, h('div', { class: 'idc-tools' }, refs.addBtn), refs.listNote);
    refs.dryRunSwitch = K.toggleField('Dry run switch', 'Shows the Dry run / Live switch in the footer. Dry run works out every step and sends nothing.', { get: () => !!ui.dryRunSwitch, set: (v) => { ui.dryRunSwitch = v; saveUi(); if (!running && !active) cfg.dryRun = v; render(); }, def: false });
    const settings = K.settingsTab({
      lockText: 'Stop the live run to change settings.',
      tail: [K.group('Experimental', refs.dryRunSwitch.el)],
      groups: [K.group('Research', refs.mode.el, refs.tier.el), refs.listBox, K.group('Spending', refs.reserve.el), K.group('Automation', refs.autoClaim.el, refs.keepLive.el)],
      backup: { onExport: () => core.exportFile(), onImport: () => core.importFile(), onReset: () => K.resetSettings('Lab', { snapshot: exportCfg, reset: resetCfg, restore: importCfg }) },
    });
    refs.settings = settings;

    // ---- Log tab (this module's lines only)
    const logt = K.logTab({ mod: TAG, clearable: false });
    refs.logv = logt.logv;

    // ---- Footer (always visible)
    refs.run = K.runModeSeg(() => !!cfg.dryRun, (id) => { cfg.dryRun = id; confirmUntil = 0; render(); });
    refs.alt = h('button', { onclick: () => { confirmUntil = 0; render(); } }, 'Cancel');
    refs.main = h('button', { class: 'primary', onclick: onMain });
    const foot = K.footer({ top: [refs.run.el], main: refs.main, alt: refs.alt });
    refs.plan = foot.plan;

    P = K.createPanel({
      id: 'lab', title: 'Lab', cls: 'lab-panel', state: ui, save: saveUi, headExtra: [refs.badge], foot: foot.el,
      tabs: [{ id: 'status', label: 'Status', content: status }, { id: 'settings', label: 'Settings', content: settings.content }, { id: 'log', label: 'Log', content: logt.content }],
      onClose: () => panel(false), onTab: () => render(), opener: () => chrome?.opener,
      defaultPlace: () => ({ right: 20 }),
    });
  }

  function renderForm(r) {
    const locked = running && !cfg.dryRun;
    refs.settings.sync(locked);
    // Dry run is experimental: off by default, so the panel runs Live unless the switch is on.
    refs.run.el.hidden = !ui.dryRunSwitch;
    refs.dryRunSwitch.input.disabled = running || active;
    refs.run.sync();
    refs.run.btns.forEach((b) => { b.disabled = running || active; });   // Live is chosen before Start, behind its confirm step
    refs.listBox.hidden = cfg.mode !== 'list';
    refs.reserveChips.sync(RESERVE_ITEMS, cfg.mdReserve);
    if (cfg.mode === 'list') renderList(r);

    // Which settings differ from the defaults: a reset button on each field, a dot on the tab.
    let changed = 0;
    for (const m of [refs.mode.sync(), refs.tier.sync(), refs.reserve.sync(), refs.autoClaim.sync(), refs.keepLive.sync()]) if (m) changed++;
    P.setTabBadge('settings', changed ? changed + ' setting' + (changed > 1 ? 's' : '') + ' changed from the defaults' : '');

    // Footer
    const confirming = !running && !viewDry() && Date.now() < confirmUntil;
    refs.plan.set(viewDry()
      ? 'Dry run: works out every step and writes "would send …" to the log, but sends nothing.'
      : `Live: starts research and claims results for you, one confirmed step at a time, keeping ${fmt(cfg.mdReserve)} MD.${confirming ? ' Click Confirm start to go.' : ''}`,
    { hidden: running, hot: confirming });
    refs.main.textContent = running ? 'Stop' : active ? 'Stopping…' : viewDry() ? 'Start dry run' : confirming ? 'Confirm start' : 'Start live';
    refs.main.disabled = !running && (active || !r);
    refs.alt.hidden = !confirming;
  }

  const onResize = () => P?.place();

  function renderPanel(r, sum) {
    const t = tone();
    K.setTone(P.dot, t);
    refs.badge.textContent = viewDry() ? 'Dry run' : 'Live';
    refs.badge.className = 'idc-badge' + (viewDry() ? '' : ' live');
    if (!sum) {
      refs.hero.set('—', '', 0); refs.rows.set([]); refs.successNote.textContent = '';
      refs.state.set(t, 'Waiting for the game to load…');
    } else {
      const info = successInfo(r, sum), d = sum.d;
      refs.hero.set(sum.total ? `${sum.busy} of ${sum.total}` : '—', sum.total ? (sum.total === 1 ? 'Lab' : 'Labs') : 'no Lab built yet', sum.total ? (sum.busy / sum.total) * 100 : 0);
      refs.rows.set([
        ...(sum.total ? sum.rows.map((x) => [x.name, x.text]) : [['Labs', 'none built yet']]),
        ['Results waiting', d.pending + (cfg.autoClaim ? '' : ' (auto-claim off)')],
        ['MD', `${fmt(d.md)} · keeps ${fmt(cfg.mdReserve)}`],
        ['RD', fmt(d.rd)],
        ['Catalyst', sum.total ? sum.rows.map((x) => `${x.name} ${fmt(x.catalyst)}`).join(' · ') : '—'],
        ['Success', info.text],
        ['This run', `${sess.started} started · ${sess.claimed} claimed`],
      ]);
      refs.successNote.textContent = info.note;
      refs.state.set(t, stateText(sum));
    }
    renderForm(r);
    K.syncLog(P, ui, refs.logv);
  }

  function render() {
    if (!HAS_DOM || unloaded) return;
    const r = read();
    const sum = r ? summary(r) : null;
    const t = tone();
    chrome?.setPill(viewDry() ? 'Dry run' : 'Live', t, !running);
    chrome?.setChip(sum?.total ? `Lab ${sum.busy}/${sum.total}` : 'Lab', t, `Lab · ${stateText(sum)}`);
    const open = !!P?.el.isConnected;
    chrome?.setOpen(open);
    if (open) renderPanel(r, sum);
  }

  function panel(show = true, opts = {}) {
    if (!HAS_DOM || unloaded) return;
    if (show) { if (!P) buildPanel(); P.mount(opts); } else P?.unmount();
    ui.open = !!show; saveUi();
    render();
  }

  function mountUi() {
    chrome = K.createChrome({
      label: 'Lab', navTitle: 'Keep the Manufacturing Lab researching', icon: ICON, navClass: 'lab-tab', chipClass: 'lab-chip',
      onToggle: () => K.togglePanel(P, ui, panel),
      navInsert: (nav, el) => nav.insertBefore(el, nav.querySelector('.cdf-tab')?.nextSibling ?? null),   // below CD Farm's tab
      chipInsert: (tools, el) => tools.insertBefore(el, tools.querySelector('.tip-anchor') || null),
    });
    if (!ui.dryRunSwitch && !running && !active) cfg.dryRun = false;   // Dry run is experimental: off by default, so the panel starts Live unless the switch is on.
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
