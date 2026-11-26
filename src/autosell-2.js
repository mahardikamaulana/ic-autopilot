// continues the autosell closure from autosell-1.js (same try / IIFE)
  // ---- public control ----------------------------------------------------------------------------------------
  function start({ deal, total = null, keep = 0, fullLoads = false } = {}) {
    const r = read();
    const d = Array.isArray(r?.deals) ? r.deals.find((x) => x.id === +deal) : null;
    const prev = jobs.get(+deal);
    if (!d && !prev) throw new Error('bid ' + deal + ' not found (open the Market page)');
    const base = prev ?? clean({ deal: d.id, item: d.item, region: d.region, unit: d.price / d.amount, expiresAt: d.expires_at });
    if (!base) throw new Error('bad bid');
    if (d && d.side !== 'Sell') throw new Error('bid ' + deal + ' is an ask: auto ship sells into bids only');
    if (d) base.lot = d.amount;
    base.left = total == null ? null : toInt(total, 1, 1e9, null);
    base.keep = toInt(keep, 0, 1e12, 0);
    base.fullLoads = !!fullLoads;
    base.fails = 0; base.retryAt = 0;
    jobs.set(base.deal, base);
    save();
    core.ledger.add(TAG, 'info', (prev ? 'updated' : 'started') + ' auto ship ' + nameOf(r, base.item) + ' @ ' + usd(base.unit) + (base.left == null ? ', until stopped' : ', ' + num(base.left) + ' to sell') + (base.keep ? ', keeping ' + num(base.keep) : ''));
    loop();
    renderAll();
    return base.deal;
  }
  function stop(deal) {
    const list = deal == null ? [...jobs.values()] : [jobs.get(+deal)].filter(Boolean);
    for (const j of list) endJob(j, 'stopped');
    return list.length;
  }
  const publicJob = (j, r) => ({ deal: j.deal, from: j.from ?? null, item: j.item, region: j.region, unit: j.unit, unit0: j.unit0, left: j.left, sold: j.sold, keep: j.keep, fullLoads: j.fullLoads, status: j.status,
    revenue: j.revenue, cost: j.cogs, profit: profitOf(j), estProfit: estProfitOf(j, r) });   // cents
  const listJobs = () => { const r = read(); return [...jobs.values()].map((j) => publicJob(j, r)); };
  const status = () => listJobs().map((j) => nameOf(read(), j.item) + ' #' + j.deal + ': ' + num(j.sold) + ' sold, ' + (j.left == null ? 'until stopped' : num(j.left) + ' left') + ', profit ' + profitTxt(j.profit) + ' (est. ' + profitTxt(j.estProfit) + ') - ' + j.status).join('\n') || 'no jobs';
  const items = () => [...new Set([...jobs.values()].map((j) => j.item))];

  // ---- DOM: button, menu, jobs table ---------------------------------------------------------------------------------
  const h = core.h;
  const fiberKey = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); return k ? el[k]?.key : null; };
  let styleEl = null, modal = null, panelEl = null, panelSig = '', obs = null, passTimer = 0, tickTimer = 0;

  const CSS = '.as-btn{margin-right:6px}.as-btn.on::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#3fb950;margin-right:6px;vertical-align:middle}' +
    '.as-modal .as-note{margin-top:6px}.as-modal input[type=number]:disabled{opacity:.5}.as-neg{color:#f85149}.as-panel tfoot td{font-weight:600}';

  function dealRow(tr) {
    const id = +fiberKey(tr);
    return Number.isFinite(id) && tr.querySelector('.side-pill.bid') ? id : null;
  }
  function inject() {
    if (!HAS_DOM || unloaded) return;
    for (const tr of document.querySelectorAll('.market-table tbody tr')) {
      const id = dealRow(tr);
      let btn = tr.querySelector('.as-btn');
      if (id == null) { btn?.remove(); continue; }
      const td = tr.lastElementChild;
      if (!td) continue;
      if (!btn) {
        btn = h('button', { type: 'button', class: 'as-btn' }, 'Auto ship');
        btn.addEventListener('click', (e) => { e.stopPropagation(); openMenu(+btn.dataset.deal, btn); });
        td.insertBefore(btn, td.firstChild);
      }
      btn.dataset.deal = String(id);
      const on = jobs.has(id);
      btn.classList.toggle('on', on);
      const t = on ? 'Auto ship is running on this bid: click to edit or stop' : 'Sell this bid automatically: ships again every time the courier is free';
      if (btn.title !== t) btn.title = t;
    }
    injectPanel();
  }

  // The jobs table is rebuilt only when the set of jobs changes; the numbers and the status are updated in place,
  // so a click on Edit / Stop is never lost to a rebuild between mouse down and up.
  let panelRefs = new Map();
  function injectPanel() {
    const marketSection = document.querySelector('.market-table')?.closest('section.panel');
    if (!marketSection || !jobs.size) { panelEl?.remove(); panelEl = null; panelSig = ''; panelRefs.clear(); return; }
    const r = read();
    const sig = [...jobs.keys()].join(',');
    if (!panelEl?.isConnected || sig !== panelSig) {
      panelSig = sig;
      panelRefs = new Map();
      const tr = [...jobs.values()].map((j) => {
        const ref = { sold: h('td', { class: 'num' }), left: h('td', { class: 'num' }), est: h('td', { class: 'num' }), act: h('td', { class: 'num' }), badge: h('span', { class: 'badge' }) };
        panelRefs.set(j.deal, ref);
        return h('tr', {},
          h('td', {}, nameOf(r, j.item)),
          h('td', { class: 'muted' }, regionName(j.region)),
          h('td', { class: 'num muted' }, usd(j.unit)),
          ref.sold, ref.left, ref.est, ref.act,
          h('td', { class: 'nowrap' }, ref.badge),
          h('td', { class: 'num' }, h('span', { class: 'row-actions' },
            h('button', { type: 'button', onclick: () => openMenu(j.deal) }, 'Edit'),
            h('button', { type: 'button', onclick: () => stop(j.deal) }, 'Stop'))));
      });
      const tot = { est: h('td', { class: 'num' }), act: h('td', { class: 'num' }) };
      if (jobs.size > 1) panelRefs.set('tot', tot);
      panelEl?.remove();
      panelEl = h('section', { class: 'panel as-panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, 'Auto ship (IC Autopilot)'), h('span', { class: 'spacer' }), h('span', { class: 'muted as-count' })),
        h('div', { class: 'panel-body' },
          h('div', { class: 'table-bleed' }, h('table', { class: 'data-table steady autoship-table' },
            h('thead', {}, h('tr', {}, ...['Item', 'Route', 'Unit', 'Sold', 'Left', 'Est. profit', 'Actual profit', 'Status', ''].map((t, i) => h('th', { class: i >= 2 && i <= 6 ? 'num' : '', ...(i === 5 ? { title: 'What the job makes in the end: the actual profit so far plus the margin on what it still has to ship (the target, or the part of the bid that is still open)' } : i === 6 ? { title: 'What the units shipped so far earned, minus what they cost to make. Booked when a shipment is sent; the money lands with the shipment' } : {}) }, t)))),
            h('tbody', {}, ...tr),
            ...(jobs.size > 1 ? [h('tfoot', {}, h('tr', {}, h('td', { colspan: '5' }, 'Total'), tot.est, tot.act, h('td', {}), h('td', {})))] : []))),
          h('p', { class: 'panel-note' }, 'Ships from here, so it only works while this tab is open and online. The game\'s own auto-ship slot is not used. Cost of a unit is its recipe\'s inputs at base value (raw materials are free), so profit is an estimate.')));
    }
    if (panelEl.nextElementSibling !== marketSection) marketSection.parentNode.insertBefore(panelEl, marketSection);
    const set = (el, t) => { if (el.textContent !== t) el.textContent = t; };
    set(panelEl.querySelector('.as-count'), jobs.size + ' running · no slot limit');
    const money = (el, c) => { set(el, profitTxt(c)); const cls = c < 0 ? 'num as-neg' : 'num'; if (el.className !== cls) el.className = cls; };
    let totEst = 0, totAct = 0;
    for (const j of jobs.values()) {
      const ref = panelRefs.get(j.deal);
      if (!ref) continue;
      set(ref.sold, num(j.sold));
      set(ref.left, j.left == null ? 'Until stopped' : num(j.left));
      const est = estProfitOf(j, r), act = profitOf(j);
      totEst += est; totAct += act;
      money(ref.est, est); money(ref.act, act);
      set(ref.badge, j.status);
      const cls = 'badge ' + (j.tone === 'good' ? 'good' : '');
      if (ref.badge.className !== cls) ref.badge.className = cls;
    }
    const tot = panelRefs.get('tot');
    if (tot) { money(tot.est, totEst); money(tot.act, totAct); }
  }

  function closeMenu(restore = true) {
    if (!modal) return;
    const { el, from, onKey } = modal;
    removeEventListener('keydown', onKey, true);
    el.remove(); modal = null;
    if (restore && from?.isConnected) from.focus();
  }

  function openMenu(dealId, from = null) {
    if (!HAS_DOM || unloaded) return;
    closeMenu(false);
    const r = read();
    const live = Array.isArray(r?.deals) ? r.deals.find((d) => d.id === dealId) : null;
    const job = jobs.get(dealId);
    if (!live && !job) { core.toast('That bid is gone', 'error'); return; }
    const item = job?.item ?? live.item, region = job?.region ?? live.region;
    const lot = live?.amount ?? Math.max(job?.left ?? 1, 1);
    const unit = live ? live.price / live.amount : job.unit;
    const it = itemOf(r?.catalog, item);
    const name = it?.name ?? 'item ' + item;
    const load = loadOf(it, r?.st);
    const cpu = unitCost(r?.catalog, item);

    const total = h('input', { type: 'number', inputMode: 'numeric', min: '1', max: String(lot), value: String(job?.left ?? lot), 'aria-label': 'Total to sell' });
    const keep = h('input', { type: 'number', inputMode: 'numeric', min: '0', value: String(job?.keep ?? 0), 'aria-label': 'Keep in stock' });
    const untilStopped = h('input', { type: 'checkbox', checked: job ? job.left == null : true });
    const full = h('input', { type: 'checkbox', checked: !!job?.fullLoads });
    const clamp = (el, lo, hi) => { el.value = String(toInt(el.value, lo, hi, lo)); };
    const step = (el, d, lo, hi) => h('button', { type: 'button', onclick: () => { el.value = String(toInt(Number(el.value || 0) + d, lo, hi, lo)); sync(); } }, (d > 0 ? '+' : '−') + (Math.abs(d) >= 1000 ? Math.abs(d) / 1000 + 'k' : Math.abs(d)));
    const bulk = (el, lo, hi, maxLabel, maxVal) => h('div', { class: 'stepper-bulk' },
      ...[-10000, -1000, -100, 100, 1000, 10000].map((d) => step(el, d, lo, hi)),
      h('span', { class: 'stepper-scale' }, h('button', { type: 'button', title: maxLabel, onclick: () => { el.value = String(maxVal); sync(); } }, 'Max')));

    const recv = h('td', { class: 'num' }), estCell = h('td', { class: 'num' }), stockCell = h('td', { class: 'num' });
    const totalRow = h('div', { class: 'field' }, h('label', {}, 'Total to sell (lot of ' + num(lot) + ')'), total, bulk(total, 1, lot, 'Fill quantity to the lot', lot));
    function sync() {
      total.disabled = untilStopped.checked;
      totalRow.style.opacity = untilStopped.checked ? '.5' : '';
      const n = untilStopped.checked ? lot : toInt(total.value, 1, lot, lot);
      recv.textContent = (untilStopped.checked ? 'Up to ' : '') + usd(unit * n);
      estCell.textContent = (untilStopped.checked ? 'Up to ' : '') + profitTxt(Math.round((unit - cpu) * n));
      const x = read();
      stockCell.textContent = num(x?.st.stock?.[region]?.[item] ?? 0);
    }
    total.addEventListener('input', sync); untilStopped.addEventListener('change', sync);
    total.addEventListener('blur', () => { clamp(total, 1, lot); sync(); });
    keep.addEventListener('blur', () => { clamp(keep, 0, 1e12); });

    const confirm = h('button', { type: 'button', class: 'primary', 'data-modal-confirm': 'true', onclick: () => {
      try {
        start({ deal: dealId, total: untilStopped.checked ? null : toInt(total.value, 1, lot, lot), keep: toInt(keep.value, 0, 1e12, 0), fullLoads: full.checked });
        closeMenu();
      } catch (e) { core.toast(String(e.message || e), 'error'); }
    } }, job ? 'Update auto ship' : 'Start auto ship');

    const strip = job ? h('div', { class: 'autoship-strip' },
      h('span', { class: 'badge good' }, 'Auto-shipping'),
      h('span', { class: 'muted' }, num(job.sold) + ' sold · ' + profitTxt(profitOf(job)) + ' profit'),
      h('button', { type: 'button', onclick: () => { stop(dealId); closeMenu(); } }, 'Stop auto ship')) : null;

    const el = h('div', { class: 'modal-backdrop as-modal' },
      h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Auto ship ' + name },
        h('div', { class: 'modal-head' },
          h('button', { type: 'button', class: 'modal-x', title: 'Close', 'aria-label': 'Close', onclick: () => closeMenu() }, '×'),
          h('h3', {}, 'Auto ship ' + name)),
        h('div', { class: 'modal-body' },
          ...(strip ? [strip] : []),
          totalRow,
          h('div', { class: 'field check-row' },
            h('label', { class: 'inline-check' }, untilStopped, h('span', {}, 'Until stopped')),
            h('span', { class: 'hint' }, 'Ships again each time the courier is free. Waits for more when you run out of ' + name + '. Moves to the best bid for the same item in this region when this one is gone, and stops after 24 h with no bid.')),
          h('div', { class: 'field' }, h('label', {}, 'Keep in stock'), keep,
            h('div', { class: 'hint as-note' }, 'Never ships the last units of ' + name + ': they stay in stock.')),
          h('div', { class: 'field check-row' },
            h('label', { class: 'inline-check' }, full, h('span', {}, 'Full courier loads only')),
            h('span', { class: 'hint' }, 'Waits for ' + num(load) + ' ' + name + ' (one free courier run) instead of shipping what is there.')),
          h('table', { class: 'data-table stats' }, h('tbody', {},
            h('tr', {}, h('td', { class: 'muted' }, 'Unit price'), h('td', { class: 'num' }, usd(unit))),
            h('tr', {}, h('td', { class: 'muted' }, 'You receive in total'), recv),
            h('tr', {}, h('td', { class: 'muted', title: 'The inputs of the recipe that makes it, at base value. Raw materials cost nothing to extract.' }, 'Est. cost per unit'), h('td', { class: 'num' }, usd(cpu))),
            h('tr', {}, h('td', { class: 'muted' }, job ? 'Est. profit on the rest' : 'Est. profit in total'), estCell),
            ...(job ? [h('tr', {}, h('td', { class: 'muted' }, 'Actual profit so far'), h('td', { class: 'num' }, profitTxt(profitOf(job))))] : []),
            h('tr', {}, h('td', { class: 'muted' }, 'In stock'), stockCell),
            h('tr', {}, h('td', { class: 'muted' }, 'Region'), h('td', { class: 'num' }, regionName(region))),
            h('tr', {}, h('td', { class: 'muted' }, 'Cargo each'), h('td', { class: 'num' }, (it?.cargo_weight ?? '?') + ' CU')))),
          h('div', { class: 'hint' }, 'Goods leave in courier shipments. You are paid as each shipment is complete. The game\'s own auto-ship slot is not used.')),
        h('div', { class: 'modal-actions' }, h('button', { type: 'button', onclick: () => closeMenu() }, 'Cancel'), confirm)));
    el.addEventListener('mousedown', (e) => { if (e.target === el) closeMenu(); });
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenu(); } };
    addEventListener('keydown', onKey, true);
    modal = { el, from, onKey, deal: dealId };
    document.body.append(el);
    sync();
    (untilStopped.checked ? keep : total).focus();
  }

  let mounted = false;
  const renderAll = () => { if (mounted && !unloaded) { clearTimeout(passTimer); passTimer = setTimeout(inject, 60); } };

  function mountUi() {
    mounted = true;
    styleEl = h('style', { id: 'as-style' }, CSS);
    document.head.append(styleEl);
    obs = new MutationObserver(renderAll);
    obs.observe(document.body, { childList: true, subtree: true });
    tickTimer = setInterval(inject, 1000);
    inject();
  }
  function unmountUi() {
    mounted = false;
    obs?.disconnect(); obs = null;
    clearInterval(tickTimer); clearTimeout(passTimer);
    closeMenu(false);
    styleEl?.remove(); panelEl?.remove(); styleEl = panelEl = null;
    document.querySelectorAll('.as-btn').forEach((b) => b.remove());
  }

