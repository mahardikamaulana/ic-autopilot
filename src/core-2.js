// continues the core closure from core-1.js (same try / IIFE)
  // ---- UI kit (core.ui): one stylesheet, panel shell, tabs, sidebar tab + top-bar chip, log view -------------
  // Both modules build their panels from this; each keeps only its own content and settings.
  const UI_CSS = `
.idc-panel,.idc-toasts{--idc-muted:var(--muted,#808086);--idc-focus:var(--accent,#5b8def)}
.idc-panel{--kind:var(--accent,#5b8def)}.cdf-panel{--kind:#d9a637}.lab-panel{--kind:#8e6fd8}.cp-panel{--kind:#4fbf6a}
.idc-panel{position:fixed;z-index:9999;display:flex;flex-direction:column;width:var(--idc-w,340px);max-width:calc(100vw - 32px);max-height:calc(100vh - 40px);overflow:auto;background:var(--surface,#151517);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.5);color:var(--ink,#ededee);font:inherit;font-variant-numeric:tabular-nums}
.idc-panel.idc-docked{inset:0 0 0 auto;width:var(--idc-dock,360px);max-width:100vw;max-height:none;z-index:40;border-width:0 0 0 1px;border-radius:0;box-shadow:none;background:var(--page,#0d0d0f)}
.idc-docked .idc-head{cursor:default}
body:has(>.idc-docked:not(.idc-ghost)) .shell{padding-right:var(--idc-dock,360px)}
@media (max-width:700px){
.idc-panel.idc-docked{inset:auto 0 var(--chrome-h,120px) 0;width:auto;max-height:calc(100dvh - var(--chrome-h,120px) - 3rem);z-index:41;border-width:1px 0 0;border-radius:12px 12px 0 0}
body:has(>.idc-docked:not(.idc-ghost)) .shell{padding-right:0}
body:has(.shell)>.idc-panel{--idc-bottom:calc(var(--chrome-h,120px) + 8px)}
}
.idc-panel:focus{outline:none}
.idc-panel :focus-visible,.idc-chip:focus-visible,.idc-tab:focus-visible,.idc-toasts :focus-visible{outline:2px solid var(--idc-focus);outline-offset:1px}
.idc-panel [hidden],.idc-pill[hidden],.idc-toasts [hidden]{display:none!important}
.idc-head{flex:none;display:flex;align-items:center;gap:8px;min-height:40px;padding:4px 4px 4px 1rem;box-sizing:border-box;border-bottom:1px solid var(--border,rgba(255,255,255,.09));cursor:move;user-select:none}
.idc-panel.min .idc-head{border-bottom-color:transparent}
.idc-title{flex:1;font-size:15px;font-weight:600;letter-spacing:-.01em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.idc-panel button.idc-ib{flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--idc-muted)}
.idc-panel button.idc-ib:hover{background:rgba(255,255,255,.1);color:var(--ink,#ededee)}
.idc-badge{padding:0 7px;border-radius:999px;font-size:11px;line-height:18px;background:var(--surface-2,#1d1d20);color:var(--ink-2,#b6b6ba)}
.idc-badge.live{background:rgba(34,181,115,.14);color:var(--status-good,#22b573)}
.idc-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--muted,#808086)}
.idc-dot.run{background:var(--status-good,#22b573);box-shadow:0 0 0 3px rgba(34,181,115,.18)}
.idc-dot.wait{background:var(--status-warn,#f2a93b)}
.idc-dot.err{background:var(--status-crit,#ef5b45)}
@media (prefers-reduced-motion:no-preference){.idc-dot.run{animation:idc-pulse 2.4s ease-in-out infinite}}
@keyframes idc-pulse{50%{box-shadow:0 0 0 5px rgba(34,181,115,.06)}}
.idc-tabs{flex:none;display:flex;gap:0;padding:0 6px;border-bottom:1px solid var(--border,rgba(255,255,255,.09))}
.idc-panel.min .idc-tabs,.idc-panel.min .idc-scroll,.idc-panel.min .idc-foot{display:none}
.idc-panel button.idc-tabbtn{position:relative;display:inline-flex;align-items:center;gap:.4rem;height:auto;padding:.55rem .9rem;line-height:1.4;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--ink-2,#b6b6ba);font:inherit}
.idc-panel button.idc-tabbtn:hover{color:var(--ink,#ededee);background:transparent;border-bottom-color:var(--border,rgba(255,255,255,.09))}
.idc-panel button.idc-tabbtn[aria-selected="true"]{color:var(--ink,#ededee);font-weight:600;border-bottom-color:var(--accent,#5b8def)}
.idc-tl{display:inline-flex;flex-direction:column;align-items:center}
.idc-tl::after{content:attr(data-label);font-weight:600;height:0;overflow:hidden;visibility:hidden}
.idc-tabdot{min-width:6px;height:6px;border-radius:999px;background:var(--accent,#5b8def)}
.idc-tabdot.warn{background:var(--status-warn,#f2a93b)}
.idc-scroll{flex:1 1 auto;min-height:96px;overflow:auto;overscroll-behavior:contain}
.idc-pane{display:grid;gap:14px;align-content:start;padding:12px 16px 16px}
.idc-label{color:var(--idc-muted);font-size:13px}
.idc-hero{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.idc-big{font-size:24px;font-weight:500;letter-spacing:-.02em;line-height:1.2}
.idc-bar{height:6px;border-radius:999px;background:var(--ring-off,rgba(255,255,255,.16));overflow:hidden;margin:10px 0 0}
.idc-bar>i{display:block;height:100%;width:0;border-radius:999px;background:var(--kind);transition:width .4s}
.idc-rows{display:grid}
.idc-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--border,rgba(255,255,255,.09))}
.idc-row:last-child{border-bottom:0}
.idc-row>span:first-child{color:var(--idc-muted);flex:none}
.idc-row>span:last-child{text-align:right;min-width:0;overflow-wrap:anywhere}
.idc-state{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;background:var(--surface-2,#1d1d20);color:var(--ink-2,#b6b6ba);font-size:12.5px;line-height:1.45}
.idc-state .idc-dot{margin-top:5px}
.idc-note{display:grid;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid rgba(242,169,59,.35);font-size:12.5px;line-height:1.45;color:var(--ink,#ededee)}
.idc-note button{justify-self:start}
.idc-recent{display:grid;gap:2px;font-size:12px;line-height:1.4;color:var(--idc-muted)}
.idc-recent>div{overflow-wrap:anywhere}
.idc-group{display:grid;gap:10px;min-width:0}
.idc-group+.idc-group{padding-top:14px;border-top:1px solid var(--border,rgba(255,255,255,.09))}
.idc-gh{margin:0;font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--idc-muted)}
.idc-sub>summary,.idc-sec>summary{cursor:pointer;color:var(--ink-2,#b6b6ba);font-size:12.5px;list-style:none;display:flex;justify-content:space-between}
.idc-sub>summary::-webkit-details-marker,.idc-sec>summary::-webkit-details-marker{display:none}
.idc-sub>summary::after,.idc-sec>summary::after{content:"›";display:inline-block;transition:transform .15s}
.idc-sub[open]>summary::after,.idc-sec[open]>summary::after{transform:rotate(90deg)}
.idc-sub[open]>summary,.idc-sec[open]>summary{margin-bottom:12px}
.idc-sub>.idc-group{gap:12px}
fieldset.idc-form{border:0;margin:0;padding:0;min-width:0;display:grid;gap:14px}
fieldset.idc-form:disabled .idc-field,fieldset.idc-form:disabled .idc-check,fieldset.idc-form:disabled .idc-sub{opacity:.6}
.idc-lock{display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:8px;background:var(--surface-2,#1d1d20);font-size:12px;color:var(--ink-2,#b6b6ba)}
.idc-field{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;min-width:0}
.idc-fl{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:18px}
.idc-flabel{font-size:12px;color:var(--idc-muted)}
.idc-panel button.idc-rst{display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--idc-muted)}
.idc-panel button.idc-rst:hover{background:var(--surface-2,#1d1d20);color:var(--ink,#ededee)}
.idc-desc{font-size:12px;line-height:1.45;color:var(--idc-muted)}
.idc-seg{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:2px;padding:2px;border-radius:8px;background:var(--surface-2,#1d1d20)}
.idc-panel .idc-seg button{height:28px;padding:0 4px;border:0;border-radius:6px;background:transparent;color:var(--ink-2,#b6b6ba);font-size:12.5px;white-space:nowrap}
.idc-panel .idc-seg button:hover{background:var(--surface-3,#27272a);color:var(--ink,#ededee)}
.idc-panel .idc-seg button[aria-checked="true"]{background:var(--accent-wash,rgba(91,141,239,.14));color:var(--accent,#5b8def);font-weight:500}
.idc-panel .idc-seg button:disabled{opacity:.5;cursor:default}
.idc-inp{display:flex;align-items:center;gap:4px;height:30px;padding:0 9px;border-radius:6px;background:var(--surface-2,#1d1d20);border:1px solid var(--border,rgba(255,255,255,.09));box-sizing:border-box}
.idc-inp:focus-within{border-color:var(--accent,#5b8def);outline:1px solid var(--accent,#5b8def)}
.idc-inp.bad{border-color:var(--status-crit,#ef5b45)}
.idc-inp>span{color:var(--idc-muted)}
.idc-inp input{flex:1;min-width:0;width:0;height:100%;padding:0;border:0;outline:none;background:transparent;color:var(--ink,#ededee);font:inherit;font-size:13px;font-variant-numeric:tabular-nums}
.idc-inp input::placeholder{color:var(--idc-muted)}
.idc-msg{font-size:12px;line-height:1.4}
.idc-msg.error{color:var(--status-crit,#ef5b45)}
.idc-msg.warn{color:var(--status-warn,#f2a93b)}
.idc-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
.idc-check{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:var(--ink,#ededee);cursor:pointer}
.idc-check input{flex:none;margin:2px 0 0;accent-color:var(--accent,#5b8def)}
.idc-check.mod>span::after{content:"";display:inline-block;width:6px;height:6px;margin-left:6px;border-radius:50%;background:var(--accent,#5b8def);vertical-align:middle}
.idc-check small{display:block;margin-top:1px;font-size:12px;color:var(--idc-muted)}
.idc-inline{display:flex;gap:8px;align-items:center}
.idc-inline .idc-inp{flex:1}
.idc-quicks{display:flex;flex-wrap:wrap;gap:4px}
.idc-panel .idc-quicks button{height:22px;padding:0 9px;border-radius:999px;border:1px solid transparent;background:var(--surface-2,#1d1d20);color:var(--ink-2,#b6b6ba);font-size:11.5px;font-variant-numeric:tabular-nums}
.idc-panel .idc-quicks button:hover{border-color:var(--border,rgba(255,255,255,.09));color:var(--ink,#ededee)}
.idc-panel .idc-quicks button.on,.idc-panel .idc-quicks button[aria-pressed="true"]{background:var(--accent-wash,rgba(91,141,239,.14));color:var(--accent,#5b8def)}
.idc-sel{min-width:0;height:28px;padding:0 6px;border-radius:6px;border:1px solid var(--border,rgba(255,255,255,.09));background:var(--surface-2,#1d1d20);color:var(--ink,#ededee);font:inherit;font-size:12.5px;box-sizing:border-box}
.idc-lrow{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;padding:8px;border-radius:8px;border:1px solid var(--border,rgba(255,255,255,.09))}
.idc-lrow.skip{border-style:dashed;opacity:.75}
.idc-lrow .idc-two{gap:6px}
.idc-lrow .idc-two .idc-sel{width:100%}
.idc-lctl{display:flex;align-items:center;gap:4px;min-width:0}
.idc-lctl .idc-sel{flex:1 1 0}
.idc-tools{display:flex;flex-wrap:wrap;gap:6px}
.idc-panel button.danger{color:var(--status-crit,#ef5b45);border-color:rgba(208,59,59,.6)}
.idc-panel button.danger:hover:not(:disabled){background:rgba(239,91,69,.12)}
.idc-panel button.danger.armed{background:var(--status-crit,#ef5b45);border-color:transparent;color:#fff}
.idc-foot{flex:none;display:grid;gap:10px;padding:12px 14px 14px;border-top:1px solid var(--border,rgba(255,255,255,.09));background:inherit}
.idc-plan{padding:0 2px;border-radius:8px;border:1px solid transparent;font-size:12.5px;line-height:1.45;color:var(--idc-muted)}
.idc-plan.hot,.idc-plan.bad{padding:9px 10px}
.idc-plan.hot{border-color:var(--accent,#5b8def);background:var(--accent-wash,rgba(91,141,239,.14));color:var(--ink,#ededee)}
.idc-plan.bad{border-color:rgba(239,91,69,.4);color:var(--status-crit,#ef5b45)}
.idc-btns{display:flex;gap:8px}
.idc-btns button{flex:1}
.idc-pill{margin-left:auto;padding:0 .4rem;border:1px solid var(--accent,#5b8def);border-radius:999px;font-size:11px;font-weight:400;line-height:16px;color:var(--accent,#5b8def);font-variant-numeric:tabular-nums}
.idc-pill.wait{border-color:var(--status-warn,#f2a93b);color:var(--status-warn,#f2a93b)}
.primary-navigation .idc-tab[aria-expanded="true"]{background:var(--surface,#151517);color:var(--ink,#ededee)}
.primary-navigation .idc-tab[aria-expanded="true"] .nav-icon{color:var(--accent,#5b8def)}
.idc-chip{display:inline-flex;align-items:center;gap:.35rem;height:24px;padding:0 .6rem;border-radius:999px;border:1px solid transparent;background:var(--surface-2,#1d1d20);color:var(--ink-2,#b6b6ba);font:inherit;font-size:12.5px;line-height:22px;white-space:nowrap;font-variant-numeric:tabular-nums;cursor:pointer}
.idc-chip:hover{color:var(--ink,#ededee);background:var(--surface-2,#1d1d20)}
.idc-chip[aria-expanded="true"]{color:var(--ink,#ededee);border-color:var(--border,rgba(255,255,255,.09))}
.idc-led{display:grid;gap:1px;font-size:12px;line-height:1.4;color:var(--idc-muted)}
.idc-ll{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:6px;align-items:baseline;padding:3px 6px;border-radius:5px;border-left:2px solid transparent;overflow-wrap:anywhere}
.idc-ll.k-action{color:var(--ink-2,#b6b6ba)}
.idc-ll.k-fail{border-left-color:var(--status-crit,#ef5b45);background:rgba(239,91,69,.08);color:var(--ink,#ededee)}
.idc-ll.k-alert{border-left-color:var(--status-warn,#f2a93b);background:rgba(242,169,59,.08);color:var(--ink,#ededee)}
.idc-ll time{font-size:11px;white-space:nowrap}
.idc-tag{padding:0 5px;border-radius:4px;background:var(--surface-2,#1d1d20);font-size:10.5px;letter-spacing:.07em;color:var(--ink-2,#b6b6ba)}
.idc-empty{padding:14px 6px;text-align:center;color:var(--idc-muted);font-size:12px}
.idc-toasts{position:fixed;top:calc(var(--chrome-h,56px) + 12px);right:24px;z-index:2147483000;display:grid;gap:8px;justify-items:end;width:max-content;max-width:min(380px,calc(100vw - 32px));pointer-events:none}
body:has(>.idc-docked:not(.idc-ghost)) .idc-toasts{right:calc(var(--idc-dock,360px) + 24px)}
.idc-toast{display:flex;align-items:center;gap:.6rem;pointer-events:auto;padding:.5rem .5rem .5rem .75rem;border-radius:8px;background:var(--surface-2,#1d1d20);color:var(--ink,#ededee);border:1px solid var(--border,rgba(255,255,255,.09));font-size:13px;line-height:1.4;box-shadow:0 12px 32px rgba(0,0,0,.5)}
.idc-toast::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--accent,#5b8def)}
.idc-toast.k-success::before{background:var(--status-good,#22b573)}
.idc-toast.k-error::before{background:var(--status-crit,#ef5b45)}
@media (max-width:700px){.idc-toasts,body:has(>.idc-docked:not(.idc-ghost)) .idc-toasts{top:auto;bottom:calc(var(--chrome-h,120px) + 12px);left:16px;right:16px;width:auto;max-width:none;justify-items:center}}
.idc-toast button{height:24px;padding:0 8px;font-size:12px}
@media (prefers-reduced-motion:no-preference){.idc-toast{animation:idc-in .18s ease-out}@keyframes idc-in{from{opacity:0;transform:translateY(-6px)}}}
@keyframes idc-panel-in{from{opacity:0;transform:translateY(10px) scale(.97)}}
@keyframes idc-panel-out{to{opacity:0;transform:translateY(6px) scale(.97)}}
@keyframes idc-dock-in{from{opacity:0;transform:translateX(16px)}}
@keyframes idc-pane-in{from{opacity:0;transform:translateY(4px)}}
@media (prefers-reduced-motion:no-preference){
.idc-panel{animation:idc-panel-in .24s cubic-bezier(.2,.8,.2,1);transform-origin:50% 100%}
.idc-panel.idc-docked:not(.idc-ghost){animation-name:idc-dock-in}
.idc-panel.idc-ghost{animation:idc-panel-out .16s ease-in forwards;pointer-events:none}
.idc-pane{animation:idc-pane-in .22s cubic-bezier(.2,.8,.2,1)}
.idc-chip,.idc-tab{transition:background-color .15s,border-color .15s,color .15s}
.idc-panel button.idc-tabbtn{transition:color .15s,border-color .2s}
.idc-dot{transition:background-color .25s,box-shadow .25s}
.idc-pill{transition:background-color .2s,color .2s}
}
`;
  let uiStyleEl = null;
  function ensureStyle() {
    if (!HAS_DOM || unloaded) return;
    if (!uiStyleEl || !uiStyleEl.isConnected) { uiStyleEl = h('style', { id: 'idc-style' }, UI_CSS); document.head.append(uiStyleEl); }
  }
  const svg = (d) => '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const ICONS = {
    close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
    min: svg('<path d="M4 8h8"/>'),
    expand: svg('<path d="M4 10l4-4 4 4"/>'),
    reset: svg('<path d="M3 8a5 5 0 1 0 1.8-3.8M3 3v3h3"/>'),
    lock: svg('<rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7"/>'),
  };
  const iconBtn = (icon, label, onclick) => { const b = h('button', { type: 'button', class: 'idc-ib', title: label, 'aria-label': label, onclick }); b.innerHTML = ICONS[icon]; return b; };
  const isTyping = (t) => /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || '');

  // Small builders -------------------------------------------------------------------------------
  const row = (k, v) => h('div', { class: 'idc-row' }, h('span', {}, k), h('span', {}, v));
  const group = (title, ...kids) => h('div', { class: 'idc-group' }, ...(title ? [h('h4', { class: 'idc-gh' }, title)] : []), ...kids);
  function field(label, ...kids) {
    const rst = h('button', { type: 'button', class: 'idc-rst', hidden: true, 'aria-label': 'Reset ' + label + ' to its default' });
    rst.innerHTML = ICONS.reset;
    const el = h('div', { class: 'idc-field' }, h('div', { class: 'idc-fl' }, h('span', { class: 'idc-flabel' }, label), rst), ...kids);
    el._rst = rst;
    return el;
  }
  // Shows the per-field "back to default" button when the value differs from its default.
  function setModified(el, modified, hint, onReset) {
    if (!el?._rst) return;
    el._rst.hidden = !modified;
    if (modified) {
      el._rst.title = hint;
      // The button hides itself once the field is back at its default: hand focus to the field first.
      el._rst.onclick = () => { onReset(); (el.querySelector('input') || el.querySelector('.idc-seg button[aria-checked="true"]'))?.focus(); };
    }
  }
  function inputBox({ label, prefix, suffix, placeholder = '' }) {
    const input = h('input', { type: 'text', inputMode: 'decimal', autocomplete: 'off', spellcheck: false, placeholder, 'aria-label': label });
    const box = h('div', { class: 'idc-inp' }, ...(prefix ? [h('span', {}, prefix)] : []), input, ...(suffix ? [h('span', {}, suffix)] : []));
    return { input, box };
  }
  function check(input, text, hint) { return h('label', { class: 'idc-check' }, input, h('span', {}, text, ...(hint ? [h('small', {}, hint)] : []))); }
  // Segmented radio group with roving tabindex and arrow keys.
  function seg(opts, cur, onPick, label = '') {
    const btns = opts.map((o) => h('button', { type: 'button', role: 'radio', onclick: () => onPick(o.id) }, o.label));
    const el = h('div', { class: 'idc-seg', role: 'radiogroup', 'aria-label': label }, ...btns);
    el.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      const i = btns.indexOf(document.activeElement);
      if (!d || i < 0) return;
      for (let n = 1; n <= btns.length; n++) {
        const b = btns[(i + d * n + btns.length * n) % btns.length];
        if (!b.disabled) { e.preventDefault(); b.focus(); b.click(); return; }
      }
    });
    return { el, btns, sync() { opts.forEach((o, i) => { const on = cur() === o.id; btns[i].setAttribute('aria-checked', String(on)); btns[i].tabIndex = on ? 0 : -1; }); } };
  }
  // Two-step button for things you can't take back: first click arms it, the second does it.
  function confirmBtn(label, onConfirm, armed = 'Click again to confirm') {
    let t = 0;
    const b = h('button', { type: 'button', class: 'danger' }, label);
    const disarm = () => { clearTimeout(t); t = 0; b.textContent = label; b.classList.remove('armed'); };
    b.addEventListener('click', () => { if (t) { disarm(); onConfirm(); } else { b.textContent = armed; b.classList.add('armed'); t = setTimeout(disarm, 4000); } });
    b.addEventListener('blur', disarm);
    return b;
  }

  // A closed panel leaves a non-interactive copy that fades out, so switching menus cross-fades instead of popping.
  function fadeOut(ghost) {
    ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    ghost.removeAttribute('id'); ghost.inert = true; ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('idc-ghost'); ghost.style.zIndex = 9997;
    document.body.append(ghost);
    ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
    setTimeout(() => ghost.remove(), 500);
  }

  // Panel shell: sticky header (drag, minimize, close), tabs, scrolling body, sticky footer ----------
  const livePanels = new Set();
  // React can drop or bring back the game's layout: re-place the panels whose docked state no longer matches it.
  let dockObs = null;
  function watchDock() {
    if (dockObs) return;
    let queued = false;
    dockObs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; const can = !!document.querySelector('.shell'); for (const p of livePanels) if (!p.state.min && p.el.classList.contains('idc-docked') !== can) p.place(); });
    });
    dockObs.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
  }
  const motionOK = () => HAS_DOM && matchMedia('(prefers-reduced-motion: no-preference)').matches;
  const EASE = 'cubic-bezier(.2,.8,.2,1)';
  function createPanel(o) {
    const st = o.state, save = o.save || (() => {});
    const dot = h('span', { class: 'idc-dot' });
    const minBtn = iconBtn('min', 'Minimize', () => setMin(!st.min));
    const closeBtn = iconBtn('close', 'Close', () => o.onClose());
    const head = h('div', { class: 'idc-head' }, dot, h('span', { class: 'idc-title' }, o.title), ...(o.headExtra || []), minBtn, closeBtn);
    head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) setMin(!st.min); });

    const tabBtns = {}, panes = {}, order = o.tabs.map((t) => t.id);
    const tablist = h('div', { class: 'idc-tabs', role: 'tablist', 'aria-label': o.title + ' sections' });
    const scroll = h('div', { class: 'idc-scroll' });
    for (const t of o.tabs) {
      const badge = h('span', { class: 'idc-tabdot', hidden: true });
      const b = h('button', { type: 'button', class: 'idc-tabbtn', role: 'tab', id: 'idc-' + o.id + '-t-' + t.id, 'aria-controls': 'idc-' + o.id + '-p-' + t.id, onclick: () => setTab(t.id) }, h('span', { class: 'idc-tl', 'data-label': t.label }, t.label), badge);
      b._badge = badge;
      tabBtns[t.id] = b;
      panes[t.id] = h('div', { class: 'idc-pane', role: 'tabpanel', id: 'idc-' + o.id + '-p-' + t.id, 'aria-labelledby': b.id, hidden: true }, ...t.content);
      tablist.append(b); scroll.append(panes[t.id]);
    }
    tablist.addEventListener('keydown', (e) => {
      const i = order.indexOf(order.find((id) => tabBtns[id] === document.activeElement));
      const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: order.length - 1 }[e.key];
      if (i < 0 || j == null) return;
      e.preventDefault();
      const id = order[(j + order.length) % order.length];
      setTab(id); tabBtns[id].focus();
    });

    const el = h('div', { class: 'idc-panel ' + (o.cls || ''), role: 'dialog', 'aria-label': o.label || o.title, tabindex: '-1' }, head, tablist, scroll, ...(o.foot ? [o.foot] : []));
    if (o.width) el.style.setProperty('--idc-w', o.width + 'px');
    el.addEventListener('pointerdown', () => raise(), true);
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !isTyping(e.target)) { e.preventDefault(); o.onClose(); } });
    makeDraggable(head, () => el, st, place, save);

    // Two levels only (the one you used last is on top), so the panels never climb above the game's own dialogs.
    // A docked panel keeps the stylesheet's z-index (the game's sidebar level, under its modals and popovers).
    function raise() {
      for (const p of livePanels) if (p !== api) p.el.style.zIndex = p.el.classList.contains('idc-docked') ? '' : 9998;
      el.style.zIndex = el.classList.contains('idc-docked') ? '' : 9999;
    }
    function setTab(id) {
      if (!panes[id]) id = order[0];
      st.tab = id; save();
      for (const k of order) {
        const on = k === id;
        tabBtns[k].setAttribute('aria-selected', String(on)); tabBtns[k].tabIndex = on ? 0 : -1; panes[k].hidden = !on;
      }
      o.onTab?.(id);
    }
    function setMin(v, instant) {
      const from = !instant && el.isConnected && motionOK() ? el.offsetHeight : 0;
      st.min = !!v; save();
      el.classList.toggle('min', st.min);
      minBtn.innerHTML = ICONS[st.min ? 'expand' : 'min'];
      const lab = st.min ? 'Expand' : 'Minimize';
      minBtn.title = lab; minBtn.setAttribute('aria-label', lab); minBtn.setAttribute('aria-expanded', String(!st.min));
      place();
      if (from && el.offsetHeight !== from) el.animate({ height: [from + 'px', el.offsetHeight + 'px'], overflow: ['hidden', 'hidden'] }, { duration: 220, easing: EASE });
      if (!st.min) o.onTab?.(st.tab);
    }
    function place() {
      // Dock beside the game's layout root (.shell) like its own sidebar; minimized, or with no anchor, it floats as before.
      const dock = !st.min && !!document.querySelector('.shell');
      el.classList.toggle('idc-docked', dock);
      if (dock) {
        Object.assign(el.style, { left: '', right: '', top: '', bottom: '', maxHeight: '', zIndex: '' });
        for (const p of livePanels) if (p !== api && p.el.classList.contains('idc-docked')) p.setMin(true);   // one dock: the panel shown last takes it
        return;
      }
      if (st.x == null) {
        const d = o.defaultPlace?.() || { right: 20 };
        Object.assign(el.style, { left: d.left != null ? d.left + 'px' : 'auto', right: d.right != null ? d.right + 'px' : 'auto', top: 'auto', bottom: 'var(--idc-bottom,20px)', maxHeight: 'calc(100vh - 40px)' });
        return;
      }
      // Keep the header, tabs and footer on screen: the top can't be so low that they no longer fit.
      const fixed = head.offsetHeight + (st.min ? 0 : tablist.offsetHeight + (o.foot?.offsetHeight || 0) + 96);
      const x = Math.min(Math.max(8, st.x), innerWidth - 80);
      const y = Math.max(8, Math.min(st.y, innerHeight - Math.max(40, fixed) - 8));
      Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto', maxHeight: Math.max(160, innerHeight - y - 8) + 'px' });
    }
    // Two default-placed panels that would cover each other (narrow window): the one you opened last wins.
    function avoidOverlap() {
      if (st.x != null || st.min || el.classList.contains('idc-docked')) return;
      const a = el.getBoundingClientRect();
      for (const p of livePanels) {
        if (p === api || p.state.x != null || p.state.min) continue;
        const b = p.el.getBoundingClientRect();
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) p.setMin(true);
      }
    }
    const api = {
      el, dot, state: st, setTab, setMin, place,
      reveal() { if (st.min) setMin(false); raise(); el.focus({ preventScroll: true }); },
      setTabBadge(id, text, warn = false) {
        const b = tabBtns[id]?._badge; if (!b) return;
        b.hidden = !text; b.title = text || ''; b.classList.toggle('warn', warn);
        const btn = tabBtns[id], label = o.tabs.find((t) => t.id === id).label;
        if (text) btn.setAttribute('aria-label', label + ', ' + text); else btn.removeAttribute('aria-label');
      },
      mount({ focus = false } = {}) {
        ensureStyle();
        if (!el.isConnected) document.body.append(el);
        livePanels.add(api); watchDock();
        setTab(st.tab); setMin(st.min, true); raise();
        if (focus) { avoidOverlap(); el.focus({ preventScroll: true }); }
      },
      close() { o.onClose(); },
      unmount() {
        const had = el.contains(document.activeElement);
        const ghost = motionOK() && el.isConnected ? el.cloneNode(true) : null;
        el.remove(); livePanels.delete(api);
        if (ghost) fadeOut(ghost);
        if (had) o.opener?.()?.focus?.();
      },
    };
    return api;
  }

  // Header chip / sidebar tab click: opening (or revealing) a panel closes the other panels, like switching menus; clicking the open one closes it.
  function togglePanel(p, st, show) {
    const live = !!p?.el.isConnected;
    if (live && st.min) { closeOthers(p); p.reveal(); return; }
    if (!live) closeOthers(p);
    show(!live, { focus: true });
  }
  function closeOthers(except) { for (const p of [...livePanels]) if (p !== except) p.close(); }

  // Sidebar tab + top-bar chip. React re-renders those containers, so they are re-inserted when missing.
  function createChrome(o) {
    let navEl = null, chipEl = null, pillEl = null, chipDot = null, chipText = null, observer = null, dead = false;
    const view = { pill: { text: '', tone: '', hidden: true }, chip: { text: o.label, tone: '', title: o.label }, open: false };
    // Write text only when it changed: a rewrite replaces the text node, which the observer below would see as a mutation.
    const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
    function paint() {
      if (pillEl) { pillEl.hidden = view.pill.hidden; pillEl.className = 'idc-pill' + (view.pill.tone === 'run' ? '' : ' wait'); setText(pillEl, view.pill.text); }
      if (chipEl) { chipDot.className = 'idc-dot ' + view.chip.tone; setText(chipText, view.chip.text); chipEl.title = view.chip.title; }
      navEl?.setAttribute('aria-expanded', String(view.open)); chipEl?.setAttribute('aria-expanded', String(view.open));
    }
    function ensure() {
      if (unloaded || dead) return;   // a re-render queued just before unmount must not bring the tab back
      const nav = document.querySelector('.primary-navigation');
      if (nav && (!navEl || !nav.contains(navEl))) {
        pillEl = h('span', { class: 'idc-pill', hidden: true });
        navEl = h('button', { class: 'page-tab idc-tab ' + o.navClass, title: o.navTitle, onclick: () => o.onToggle() });
        navEl.innerHTML = o.icon;
        navEl.append(h('span', { class: 'nav-text' }, o.label), pillEl);
        (o.navInsert || ((n, e) => n.append(e)))(nav, navEl);
        paint();
      }
      const tools = document.querySelector('.topbar-tools');
      if (tools && (!chipEl || !tools.contains(chipEl))) {
        chipDot = h('span', { class: 'idc-dot' }); chipText = h('span');
        chipEl = h('button', { class: 'idc-chip ' + o.chipClass, onclick: () => o.onToggle() }, chipDot, chipText);
        (o.chipInsert || ((t, e) => t.append(e)))(tools, chipEl);
        paint();
      }
    }
    return {
      get opener() { return chipEl?.isConnected ? chipEl : navEl; },
      mount() {
        dead = false; ensureStyle(); ensure();
        let queued = false;
        observer = new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; ensure(); }); });
        observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
      },
      unmount() { dead = true; observer?.disconnect(); observer = null; navEl?.remove(); chipEl?.remove(); navEl = chipEl = pillEl = chipDot = chipText = null; },
      setPill(text, tone, hidden) { view.pill = { text, tone, hidden }; paint(); },
      setChip(text, tone, title) { view.chip = { text, tone, title }; paint(); },
      setOpen(b) { view.open = !!b; paint(); },
    };
  }

  // Log view: the shared ledger with kind tint, module tag and All / Actions / Problems filter; { mod } shows one module's lines only ----------
  function createLogView({ limit = 60, mod = null } = {}) {
    let filter = 'all', seenAt = Date.now();
    let lastSig = '';
    const list = h('div', { class: 'idc-led' });
    const FILTERS = [['all', 'All'], ['actions', 'Actions'], ['problems', 'Problems']];
    const chips = FILTERS.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(id === filter), onclick: () => { filter = id; render(); } }, label));
    const bar = h('div', { class: 'idc-quicks', role: 'group', 'aria-label': 'Filter log' }, ...chips);
    const bad = (e) => e.kind === 'fail' || e.kind === 'alert';
    const mine = (e) => !mod || e.mod === mod;
    const money = (e) => (e.dMoney != null ? ' (' + (e.dMoney < 0 ? '−' : '+') + '$' + Math.abs(e.dMoney).toLocaleString('en-US') + ')' : '');
    function render() {
      const sig = filter + '|' + ledgerApi.rev();
      if (sig === lastSig) return;   // nothing new: keep the DOM (and any text selection) as it is
      lastSig = sig;
      chips.forEach((b, i) => b.setAttribute('aria-pressed', String(FILTERS[i][0] === filter)));
      const all = ledgerApi.list().filter((e) => mine(e) && (filter === 'all' || (filter === 'actions' ? e.kind === 'action' : bad(e))));
      const rows = all.slice(-limit).reverse().map((e) => h('div', { class: 'idc-ll k-' + e.kind },
        h('time', { title: new Date(e.t).toLocaleString() }, new Date(e.t).toLocaleTimeString()),
        h('span', { class: 'idc-tag' }, e.mod),
        h('span', {}, e.text + money(e))));
      list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'idc-empty' }, filter === 'all' ? 'Nothing logged yet.' : 'Nothing here.')]));
    }
    return {
      el: h('div', { class: 'idc-group' }, bar, list), render,
      unseen: () => ledgerApi.list().filter((e) => mine(e) && e.t > seenAt && bad(e)).length,
      markSeen() { seenAt = Date.now(); },
    };
  }

