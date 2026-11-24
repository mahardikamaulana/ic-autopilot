// continues the core closure from core-2.js (same try / IIFE)
// ---- shared panel parts ------------------------------------------------------------------------------------------
// Every floating panel (Autopilot, CD Farm, Lab) is built from these, so the layout and the controls match:
// status (hero, rows, state line, banners), settings (amount, toggle, choice and quick-pick fields, Advanced, Backup),
// a footer (run mode, plan sentence, Cancel and the main action) and a log tab. A module keeps its own state, rules
// and wording; it does not build these controls itself. Nothing here touches the DOM until a builder is called.

const fmt = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });
const short = (x) => (x >= 1e6 ? `${+(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${+(x / 1e3).toFixed(1)}k` : String(Math.round(x)));
// "100k", "1.5m", "$100,000" -> whole number, or null when it is not an amount.
function parseAmount(s) {
  const m = String(s).trim().replace(/[$,\s_]/g, '').match(/^(\d*\.?\d+)([kmb])?$/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] || 1));
}
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const setOn = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
// A message under a field or block: { level: 'error' | 'warn' | '', text }.
function setMsg(el, m) { el.hidden = !m; el.className = 'idc-msg ' + (m?.level || ''); el.textContent = m?.text || ''; }
// The status dot: tone is '' | 'run' | 'wait' | 'err'.
const setTone = (el, tone) => { el.className = 'idc-dot ' + tone; };

// ---- status tab ----
// Hero: a label, the big figure with a short qualifier, and a progress bar (pct 0-100).
function hero(label) {
  const big = h('span', { class: 'idc-big' }), sub = h('span', { class: 'idc-label' }), bar = h('i');
  return {
    el: h('div', {}, h('div', { class: 'idc-label' }, label), h('div', { class: 'idc-hero' }, big, sub), h('div', { class: 'idc-bar' }, bar)),
    set(b, s, pct) { setText(big, b); setText(sub, s); bar.style.width = pct + '%'; },
  };
}
// Key / value rows: set([[label, value], ...]).
function rowList() {
  const el = h('div', { class: 'idc-rows' });
  return { el, set(pairs) { el.replaceChildren(...pairs.map(([k, v]) => row(k, v))); } };
}
// The one-line state under the rows: a dot and a sentence.
function stateLine() {
  const dot = h('span', { class: 'idc-dot' }), text = h('span');
  return { el: h('div', { class: 'idc-state' }, dot, text), set(tone, msg) { setTone(dot, tone); setText(text, msg); } };
}
// A banner: a sentence and an optional button. Hidden when the sentence is empty.
function banner(onButton, label = '') {
  const text = h('span');
  const btn = h('button', { type: 'button', onclick: () => onButton?.() }, label);
  const el = h('div', { class: 'idc-note', hidden: true }, text, btn);
  return { el, set(msg, showBtn = !!onButton) { el.hidden = !msg; setText(text, msg || ''); btn.hidden = !showBtn; } };
}
// A collapsible block (Checklist, Advanced). onToggle(open) remembers the state.
function disclosure(title, kids, { open = false, onToggle } = {}) {
  const d = h('details', { class: 'idc-sec', open }, h('summary', {}, title), ...kids);
  if (onToggle) d.addEventListener('toggle', () => onToggle(d.open));
  return d;
}

// ---- settings fields ----
// Amount or number text field. It checks every keystroke: a valid value is saved at once (set), an invalid one shows its
// message and is not saved. Blur or Escape puts the saved value back. `issue` (from a plan check) shows a message too.
// spec: { label, prefix, suffix, placeholder, extra: [el], parse(text) -> {v} | {err}, format(v) -> text, get(), set(v), def, redraw() }
function amountField({ label, prefix = '', suffix, placeholder = '', extra = [], parse, format, get, set, def, redraw }) {
  const { input, box } = inputBox({ label, prefix, suffix, placeholder });
  const msg = h('div', { class: 'idc-msg', hidden: true });
  const el = field(label, box, ...extra, msg);
  let typed = '';   // the parse error of what is typed now
  const revert = () => { typed = ''; input.value = format(get()); };
  input.addEventListener('input', () => {
    const p = parse(input.value);
    if (p.err) { typed = p.err; redraw(); } else { typed = ''; set(p.v); }
  });
  input.addEventListener('blur', () => { revert(); redraw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { revert(); input.blur(); }
  });
  return {
    el, input, box, msg,
    get error() { return typed; },
    // Returns true when the value differs from its default (the reset button shows then).
    sync(issue) {
      const m = typed ? { level: 'error', text: typed } : issue || null;
      setMsg(msg, m); box.classList.toggle('bad', m?.level === 'error');
      if (document.activeElement !== input) input.value = format(get());
      const modified = !Object.is(get(), def);
      setModified(el, modified, 'Reset to the default (' + (format(def) || placeholder || 'none') + ')', () => { typed = ''; set(def); });
      return modified;
    },
  };
}
// On / off setting with its own line of help. Changed-from-default is marked on the label.
function toggleField(text, hint, { get, set, def }) {
  const input = h('input', { type: 'checkbox', onchange: () => set(input.checked) });
  const small = h('small', {}, hint || '');
  const el = h('label', { class: 'idc-check' }, input, h('span', {}, text, ...(hint ? [small] : [])));
  return {
    el, input, small,
    sync() {
      input.checked = !!get();
      const m = !!get() !== !!def;
      el.classList.toggle('mod', m); el.title = m ? 'Changed from the default' : '';
      return m;
    },
  };
}
// One of several choices: a segmented control and a line describing the current one (describe(value), or text given to sync).
function segField(label, opts, { get, set, def, describe = () => '' }) {
  const sg = seg(opts, get, set, label);
  const desc = h('div', { class: 'idc-desc' });
  const el = field(label, sg.el, desc);
  const defLabel = opts.find((o) => Object.is(o.id, def))?.label ?? '';
  return {
    el, seg: sg, desc,
    sync(text) {
      sg.sync();
      setText(desc, text ?? describe(get()) ?? '');
      const m = !Object.is(get(), def);
      setModified(el, m, 'Reset to the default (' + defLabel + ')', () => set(def));
      return m;
    },
  };
}
// Quick picks under a field ("50k", "100k", ...): the one that equals the value is on. items: [[value, label]].
function quickPicks(onPick) {
  const el = h('div', { class: 'idc-quicks' });
  let key = '', btns = [];
  return {
    el,
    sync(items, current) {
      const k = items.map(([v, label]) => v + '=' + label).join('|');
      if (k !== key) { key = k; btns = items.map(([v, label]) => h('button', { type: 'button', onclick: () => onPick(v) }, label)); el.replaceChildren(...btns); }
      items.forEach(([v], i) => setOn(btns[i], Object.is(current, v)));
    },
  };
}
// Dry run / Live: the footer switch of every module that sends actions. Live needs the confirm step.
const runModeSeg = (get, set) => seg([{ id: true, label: 'Dry run' }, { id: false, label: 'Live' }], get, set, 'Run mode');

// ---- settings tab ----
// Backup: export and import the toolkit's settings, and reset this module's to the defaults (the second click confirms).
function backupGroup({ onExport, onImport, onReset }) {
  const importBtn = h('button', { type: 'button', onclick: () => onImport() }, 'Import settings');
  const resetBtn = confirmBtn('Reset settings', onReset, 'Click again to reset');
  return {
    el: group('Backup', h('div', { class: 'idc-tools' }, h('button', { type: 'button', onclick: () => onExport() }, 'Export settings'), importBtn, resetBtn)),
    sync(locked) { importBtn.disabled = resetBtn.disabled = locked; },
  };
}
// The settings tab: groups inside one fieldset (disabled while `locked`), a lock note with the caller's text, Advanced and Backup.
// content is the tab's children; sync(locked) shows the lock note and disables the groups.
function settingsTab({ groups, advanced = null, tail = [], backup, lockText }) {
  const lockIcon = h('span', { 'aria-hidden': 'true' });
  lockIcon.innerHTML = ICONS.lock;
  const lock = h('div', { class: 'idc-lock', hidden: true }, lockIcon, lockText);
  const fs = h('fieldset', { class: 'idc-form' }, ...groups, ...(advanced ? [advanced] : []), ...tail);
  const bk = backupGroup(backup);
  return {
    content: [lock, fs, bk.el],
    sync(locked) { lock.hidden = !locked; fs.disabled = locked; bk.sync(locked); },
  };
}

// ---- footer ----
// The plan sentence above the buttons: plain, hot (waiting for the confirm click) or bad (fix the settings first).
function planLine() {
  const el = h('div', { class: 'idc-plan' });
  return {
    el,
    set(text, { hidden = false, hot = false, bad = false } = {}) {
      el.hidden = hidden; el.classList.toggle('hot', hot); el.classList.toggle('bad', bad); setText(el, text);
    },
  };
}
// Footer: optional rows on top (run mode, a warning), the plan sentence, then Cancel and the main action.
function footer({ top = [], main, alt }) {
  const plan = planLine();
  return { el: h('div', { class: 'idc-foot' }, ...top, plan.el, h('div', { class: 'idc-btns' }, alt, main)), plan };
}

// ---- log tab ----
// The log view (this panel's lines when mod is set; all lines otherwise), Copy log (every module's lines), Clear log with
// Undo (all modules' lines: only where the panel already offered it), and the shared shortcut note.
function logTab({ mod = null, extra = [], clearable = true }) {
  const logv = createLogView({ mod });
  const clear = h('button', {
    type: 'button', class: 'danger', onclick: () => {
      const snap = ledgerApi.list();
      ledgerApi.clear(); logv.render();
      toast('Log cleared', { undo: () => { if (unloaded) return; ledgerApi.restore(snap); logv.render(); } });
    }
  }, 'Clear log');
  const note = (mod ? 'Shows this panel\'s lines only; Copy log copies every module\'s lines. ' : '') + 'Alt+Shift+X stops Autopilot, CD Farm and the Lab runner from anywhere on the page.';
  const tools = [h('button', { type: 'button', onclick: () => ledgerApi.copy() }, 'Copy log'), ...(clearable ? [clear] : []), ...extra];
  return {
    content: [logv.el, h('div', { class: 'idc-tools' }, ...tools), h('div', { class: 'idc-desc' }, note)],
    logv,
  };
}
// Keeps the log tab in step with its panel: drawn and marked seen while open; other tabs show a badge for new problems.
function syncLog(P, st, logv) {
  if (st.tab === 'log' && !st.min) { logv.render(); logv.markSeen(); }
  const unseen = st.tab === 'log' ? 0 : logv.unseen();
  P.setTabBadge('log', unseen ? unseen + ' new problem' + (unseen > 1 ? 's' : '') : '', true);
}
// Reset a module's settings to the defaults; the toast's Undo puts back what was there.
function resetSettings(name, { snapshot, reset, restore }) {
  try {
    const snap = snapshot();
    reset();
    toast(name + ' settings are back to their defaults', { undo: () => { if (unloaded) return; try { restore(snap); } catch (e) { toast(e.message, 'error'); } } });
  } catch (e) { toast(e.message, 'error'); }
}

const ui = {
  ensureStyle, ICONS, group, field, inputBox, createPanel, createChrome, createLogView, togglePanel,
  fmt, short, parseAmount, setOn, setMsg, setTone,
  hero, rowList, stateLine, banner, disclosure,
  amountField, toggleField, segField, quickPicks, runModeSeg,
  settingsTab, planLine, footer, logTab, syncLog, resetSettings,
};
