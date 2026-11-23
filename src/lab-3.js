// continues the lab closure from lab-2.js (same try / IIFE)
  // ---- game UI -------------------------------------------------------------------------------------
  // Same look as CD Farm (core.ui): a "Lab" tab in the sidebar, a chip in the top bar, and a card that
  // opens from either. Nothing here runs without a DOM, so the offline tests are unaffected.

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
  const parseErr = {};

  const MODES = [
    { id: 'process', label: 'Process study', desc: 'Process study on products your groups make: the one studied least so far, the pricier one on a tie.' },
    { id: 'modules', label: 'Modules', desc: 'Module fabrication (5 points less likely to succeed). Products picked the same way; if none of yours qualifies, the most valuable one.' },
    { id: 'list', label: 'Custom list', desc: 'Your own list, in order, round and round. Entries that are not Lab products are skipped.' },
  ];
  const TIER_OPTS = [{ id: 'best', label: 'Best' }, { id: 1, label: 'I' }, { id: 2, label: 'II' }, { id: 3, label: 'III' }];
  const TIER_DESC = {
    best: 'Best affordable: Tier III with 100,000 MD and a Catalyst in that region, else II (10,000 MD + 5 RD), else I (1,000 MD). The reserve stays untouched.',
    1: 'Tier I only (1,000 MD). Waits when it can\'t pay; never moves to another tier.',
    2: 'Tier II only (10,000 MD + 5 RD). Waits when it can\'t pay; never moves to another tier.',
    3: 'Tier III only (100,000 MD + a Catalyst in that region). Waits when it can\'t pay; never moves to another tier.',
  };
  const RESERVE_CHIPS = [0, 1000, 5000, 20000, 100000];
  const short = (x) => (x >= 1e6 ? `${+(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${+(x / 1e3).toFixed(1)}k` : String(Math.round(x)));
  const FIELDS = { mdReserve: { label: 'MD reserve', min: 0, max: 1e9 } };
  const parseAmount = (s) => {
    const m = String(s).trim().replace(/[$,\s_]/g, '').match(/^(\d*\.?\d+)([kmb])?$/i);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1));
  };
  function parseField(key, text) {
    const f = FIELDS[key], s = text.trim();
    if (s === '') return { err: 'Required.' };
    const v = parseAmount(s);
    if (v == null) return { err: 'Use a number like 5000, 5k or 50,000.' };
    if (v < f.min) return { err: `Must be at least ${fmt(f.min)}.` };
    if (v > f.max) return { err: `Must be at most ${fmt(f.max)}.` };
    return { v };
  }
  const shown = (key) => fmt(cfg[key]);
  function setCfg(key, v) { cfg[key] = v; confirmUntil = 0; save(); render(); }
  const setOn = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
  const chip = (text, onclick) => h('button', { type: 'button', onclick }, text);
  function setMsg(el, m) { el.hidden = !m; el.className = 'idc-msg ' + (m?.level || ''); el.textContent = m?.text || ''; }

  function textField(key) {
    const f = FIELDS[key];
    const { input, box } = K.inputBox({ label: f.label, suffix: 'MD' });
    const msg = h('div', { class: 'idc-msg', hidden: true });
    const revert = () => { delete parseErr[key]; input.value = shown(key); };
    input.addEventListener('input', () => {
      const p = parseField(key, input.value);
      if (p.err) { parseErr[key] = p.err; render(); } else { delete parseErr[key]; setCfg(key, p.v); }
    });
    input.addEventListener('blur', () => { revert(); render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { revert(); input.blur(); }
    });
    refs.fields[key] = { input, box, msg };
    return { box, msg };
  }

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
    const made = [...produced(r.st, ix)].map((id) => ix.products.get(id));
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
  function onMain() {
    if (running) return stop();
    if (cfg.dryRun) return start();
    if (Date.now() < confirmUntil) { confirmUntil = 0; return start(); }
    confirmUntil = Date.now() + 6000;
    render();
    setTimeout(render, 6100);
  }
  function doReset() {
    try {
      const snap = exportCfg();
      resetCfg();
      core.toast('Lab settings are back to their defaults', { undo: () => { if (unloaded) return; try { importCfg(snap); } catch (e) { core.toast(e.message, 'error'); } } });
    } catch (e) { core.toast(e.message, 'error'); }
  }

  function buildPanel() {
    refs.badge = h('span', { class: 'idc-badge' });

    // ---- Status tab
    refs.big = h('span', { class: 'idc-big' });
    refs.sub = h('span', { class: 'idc-label' });
    refs.bar = h('i');
    refs.rows = h('div', { class: 'idc-rows' });
    refs.successNote = h('div', { class: 'idc-desc' });
    refs.stateDot = h('span', { class: 'idc-dot' });
    refs.state = h('span');
    const status = [
      h('div', {}, h('div', { class: 'idc-label' }, 'Lab slots busy'), h('div', { class: 'idc-hero' }, refs.big, refs.sub), h('div', { class: 'idc-bar' }, refs.bar)),
      refs.rows, refs.successNote,
      h('div', { class: 'idc-state' }, refs.stateDot, refs.state)];

    // ---- Settings tab
    refs.fields = {};
    refs.mode = K.seg(MODES, () => cfg.mode, (id) => setCfg('mode', id), 'Research focus');
    refs.modeDesc = h('div', { class: 'idc-desc' });
    refs.tier = K.seg(TIER_OPTS, () => cfg.tierMode, (id) => setCfg('tierMode', id), 'Tier');
    // The shell is 340 px wide: the buttons carry short labels, the full names are the tooltip and the accessible name.
    const fullNames = (seg, names) => seg.btns.forEach((b, i) => { b.title = names[i]; b.setAttribute('aria-label', names[i]); });
    fullNames(refs.mode, ['Process study', 'Module fabrication', 'Custom list']);
    fullNames(refs.tier, ['Best affordable', 'Tier I', 'Tier II', 'Tier III']);
    refs.tierDesc = h('div', { class: 'idc-desc' });
    const reserve = textField('mdReserve');
    refs.reserveChips = RESERVE_CHIPS.map((v) => [v, chip(short(v), () => setCfg('mdReserve', v))]);
    refs.autoClaim = h('input', { type: 'checkbox', onchange: () => setCfg('autoClaim', refs.autoClaim.checked) });
    refs.autoLabel = K.check(refs.autoClaim, 'Claim finished results', 'Claims the oldest waiting result first, one per check.');
    refs.dry = h('input', { type: 'checkbox', onchange: () => { cfg.dryRun = refs.dry.checked; confirmUntil = 0; render(); } });
    refs.dryLabel = K.check(refs.dry, 'Dry run', 'Works out every step and logs "would send …", but sends nothing. Not remembered after a reload.');
    refs.fieldEl = {
      mode: K.field('Research focus', refs.mode.el, refs.modeDesc),
      tier: K.field('Tier', refs.tier.el, refs.tierDesc),
      mdReserve: K.field('MD reserve', reserve.box, h('div', { class: 'idc-quicks' }, ...refs.reserveChips.map(([, b]) => b)), reserve.msg),
    };
    refs.list = h('div', { class: 'idc-group' });
    refs.addBtn = h('button', { type: 'button', onclick: addEntry }, 'Add entry');
    refs.listNote = h('div', { class: 'idc-desc' });
    refs.listBox = K.group('Custom list', refs.list, h('div', { class: 'idc-tools' }, refs.addBtn), refs.listNote);
    const lockIcon = h('span', { 'aria-hidden': 'true' });
    lockIcon.innerHTML = K.ICONS.lock;
    refs.lock = h('div', { class: 'idc-lock' }, lockIcon, 'Stop the live run to change settings.');
    refs.fs = h('fieldset', { class: 'idc-form' },
      K.group('Research', refs.fieldEl.mode, refs.fieldEl.tier),
      refs.listBox,
      K.group('Spending', refs.fieldEl.mdReserve),
      K.group('Automation', refs.autoLabel, refs.dryLabel));
    refs.importBtn = h('button', { type: 'button', onclick: () => core.importFile() }, 'Import settings');
    refs.resetBtn = K.confirmBtn('Reset settings', doReset, 'Click again to reset');
    const backup = K.group('Backup', h('div', { class: 'idc-tools' }, h('button', { type: 'button', onclick: () => core.exportFile() }, 'Export settings'), refs.importBtn, refs.resetBtn));

    // ---- Log tab (this module's lines only)
    refs.logv = K.createLogView({ mod: TAG });
    const logTab = [
      refs.logv.el,
      h('div', { class: 'idc-tools' }, h('button', { type: 'button', onclick: () => core.ledger.copy() }, 'Copy log')),
      h('div', { class: 'idc-desc' }, 'Shows Lab lines only; Copy log copies every module\'s lines. Alt+Shift+X stops Autopilot, CD Farm and the Lab runner from anywhere on the page.')];

    // ---- Footer (always visible)
    refs.plan = h('div', { class: 'idc-plan' });
    refs.alt = h('button', { onclick: () => { confirmUntil = 0; render(); } }, 'Cancel');
    refs.main = h('button', { class: 'primary', onclick: onMain });
    const foot = h('div', { class: 'idc-foot' }, refs.plan, h('div', { class: 'idc-btns' }, refs.alt, refs.main));

    P = K.createPanel({
      id: 'lab', title: 'Lab', cls: 'lab-panel', state: ui, save: saveUi, headExtra: [refs.badge], foot,
      tabs: [{ id: 'status', label: 'Status', content: status }, { id: 'settings', label: 'Settings', content: [refs.lock, refs.fs, backup] }, { id: 'log', label: 'Log', content: logTab }],
      onClose: () => panel(false), onTab: () => render(), opener: () => chrome?.opener,
      defaultPlace: () => ({ right: 20 }),
    });
    refs.dot = P.dot;
  }

  function renderForm(r) {
    const locked = running && !cfg.dryRun;
    refs.fs.disabled = locked;
    refs.lock.hidden = !locked;
    refs.dry.disabled = running || active;   // Live is chosen before Start, behind its confirm step
    refs.importBtn.disabled = refs.resetBtn.disabled = locked;
    refs.mode.sync(); refs.tier.sync();
    refs.modeDesc.textContent = MODES.find((m) => m.id === cfg.mode)?.desc || '';
    refs.tierDesc.textContent = TIER_DESC[cfg.tierMode] || '';
    refs.listBox.hidden = cfg.mode !== 'list';
    for (const [key, f] of Object.entries(refs.fields)) {
      if (document.activeElement !== f.input) f.input.value = shown(key);
      setMsg(f.msg, parseErr[key] ? { level: 'error', text: parseErr[key] } : null);
      f.box.classList.toggle('bad', !!parseErr[key]);
    }
    for (const [v, b] of refs.reserveChips) setOn(b, cfg.mdReserve === v);
    refs.autoClaim.checked = !!cfg.autoClaim;
    refs.dry.checked = !!cfg.dryRun;
    if (cfg.mode === 'list') renderList(r);

    // Which settings differ from the defaults: a reset button on each field, a dot on the tab.
    let changed = 0;
    const mod = (el, differs, hint, reset) => { if (differs) changed++; K.setModified(el, differs, 'Reset to the default (' + hint + ')', reset); };
    mod(refs.fieldEl.mode, cfg.mode !== DEFAULTS.mode, MODES.find((m) => m.id === DEFAULTS.mode).label, () => setCfg('mode', DEFAULTS.mode));
    mod(refs.fieldEl.tier, cfg.tierMode !== DEFAULTS.tierMode, TIER_OPTS.find((o) => o.id === DEFAULTS.tierMode).label, () => setCfg('tierMode', DEFAULTS.tierMode));
    mod(refs.fieldEl.mdReserve, cfg.mdReserve !== DEFAULTS.mdReserve, fmt(DEFAULTS.mdReserve), () => { delete parseErr.mdReserve; setCfg('mdReserve', DEFAULTS.mdReserve); });
    const claimMod = !!cfg.autoClaim !== !!DEFAULTS.autoClaim;
    refs.autoLabel.classList.toggle('mod', claimMod); refs.autoLabel.title = claimMod ? 'Changed from the default' : '';
    if (claimMod) changed++;
    P.setTabBadge('settings', changed ? changed + ' setting' + (changed > 1 ? 's' : '') + ' changed from the defaults' : '');

    // Footer
    const confirming = !running && !cfg.dryRun && Date.now() < confirmUntil;
    refs.plan.hidden = running;
    refs.plan.classList.toggle('hot', confirming);
    refs.plan.textContent = cfg.dryRun
      ? 'Dry run: works out every step and writes "would send …" to the log, but sends nothing.'
      : `Live: starts research and claims results for you, one confirmed step at a time, keeping ${fmt(cfg.mdReserve)} MD.${confirming ? ' Click Confirm start to go.' : ''}`;
    refs.main.textContent = running ? 'Stop' : active ? 'Stopping…' : cfg.dryRun ? 'Start dry run' : confirming ? 'Confirm start' : 'Start live';
    refs.main.disabled = !running && (active || !r);
    refs.alt.hidden = !confirming;
  }

  const onResize = () => P?.place();

  function renderPanel(r, sum) {
    const t = tone();
    refs.dot.className = refs.stateDot.className = 'idc-dot ' + t;
    refs.badge.textContent = cfg.dryRun ? 'Dry run' : 'Live';
    refs.badge.className = 'idc-badge' + (cfg.dryRun ? '' : ' live');
    if (!sum) {
      refs.big.textContent = '—'; refs.sub.textContent = ''; refs.bar.style.width = '0%';
      refs.rows.replaceChildren(); refs.successNote.textContent = '';
      refs.state.textContent = 'Waiting for the game to load…';
    } else {
      const info = successInfo(r, sum), d = sum.d;
      refs.big.textContent = sum.total ? `${sum.busy} of ${sum.total}` : '—';
      refs.sub.textContent = sum.total ? (sum.total === 1 ? 'Lab' : 'Labs') : 'no Lab built yet';
      refs.bar.style.width = (sum.total ? (sum.busy / sum.total) * 100 : 0) + '%';
      const rows = [
        ...(sum.total ? sum.rows.map((x) => [x.name, x.text]) : [['Labs', 'none built yet']]),
        ['Results waiting', d.pending + (cfg.autoClaim ? '' : ' (auto-claim off)')],
        ['MD', `${fmt(d.md)} · keeps ${fmt(cfg.mdReserve)}`],
        ['RD', fmt(d.rd)],
        ['Catalyst', sum.total ? sum.rows.map((x) => `${x.name} ${fmt(x.catalyst)}`).join(' · ') : '—'],
        ['Success', info.text],
        ['This run', `${sess.started} started · ${sess.claimed} claimed`],
      ];
      refs.rows.replaceChildren(...rows.map(([k, v]) => K.row(k, v)));
      refs.successNote.textContent = info.note;
      refs.state.textContent = stateText(sum);
    }
    renderForm(r);
    if (ui.tab === 'log' && !ui.min) { refs.logv.render(); refs.logv.markSeen(); }
    const unseen = ui.tab === 'log' ? 0 : refs.logv.unseen();
    P.setTabBadge('log', unseen ? unseen + ' new problem' + (unseen > 1 ? 's' : '') : '', true);
  }

  function render() {
    if (!HAS_DOM || unloaded) return;
    const r = read();
    const sum = r ? summary(r) : null;
    const t = tone();
    chrome?.setPill(cfg.dryRun ? 'Dry run' : 'Live', t, !running);
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

