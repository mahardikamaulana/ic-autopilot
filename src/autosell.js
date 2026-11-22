// ============================================================================
// 3b. AUTO SHIP (window.autoSell)
// ============================================================================
// An "Auto ship" button on every distributor bid in the Market table, left of Sell. It opens a menu
// like the game's own auto-ship menu, but the selling is done here: each time the courier is free it
// sends the same FillDeal the Sell dialog sends, straight down the game's WebSocket, so it is not
// limited to the game's single auto-ship slot (any number of bids can run together; they share the
// one courier). The game's own auto-ship (KeepFilling) is never touched.
//   autoSell.start({ deal, total, keep, fullLoads })   // deal = bid id; total: number | null (until stopped)
//   autoSell.stop(deal) / stop()                      // one job / every job
//   autoSell.jobs() / status() / items() / open(deal)
//
// Rules a job follows (autoSell._decide is the pure version of them, used by the tests):
//   - hire must be null, as the game's Sell dialog sends it: the server silently ignores hire:false
//   - one FillDeal per courier run: min(stock above "keep", one free courier load, what is left to sell, the lot)
//   - nothing is sent while the courier is busy, the stock is short, or the game's own auto-ship runs on that bid
//   - the job ends when the target is reached, or after 24 h with no bid that qualifies. When its bid is gone (filled,
//     withdrawn, expired) it moves to the best open bid for the same item in the same region (highest unit price, never
//     below the item's est. cost per unit, not one another job holds); with none it waits. A bid board that is not
//     loaded (Market page not open) never ends a job, it only waits
//   - every send must be confirmed by the server (next_shipment_id goes up); 5 unconfirmed sends in a row pause the job
// Profit: every job shows an estimated profit (what it makes if it runs to its target or until the bid is used up) and the
// actual profit so far. Cost of a unit = the inputs of the recipe that makes it, at catalog base value (cheapest recipe if
// several make it; raw materials cost nothing to extract, so they are pure profit). Actual profit = what the shipments
// sent so far are worth minus that cost; it is booked when a shipment is sent (the money lands with the shipment).
// Jobs are saved in this browser and resume after a reload (a job whose bid is gone moves on). Autopilot is not touched: if it
// sells the same item, pick "Keep in stock" so both leave enough. Alt+Shift+X stops every job.
// @@MODULE autosell
try {
(() => {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const core = W.idleCore;
  if (!core) throw new Error('the shared core did not load');
  const HAS_DOM = typeof document !== 'undefined' && !!document.body;
  const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
  const KEY = 'autoSell.v1';
  const TAG = 'AS';
  if (W.autoSell?._unload) W.autoSell._unload();
  let unloaded = false;
  const sleep = core.sleep;

  // ---- game facts ------------------------------------------------------------------------------
  const COURIER_CU = 10000;                 // free courier allowance per run (upgrades are ignored: shipping less is safe)
  const REGION_NAMES = ['Heartland', 'Industrial Basin', 'Coastal Cities', 'Frontier'];
  const regionName = (r) => REGION_NAMES[r] ?? 'Region ' + r;
  const MAX_FAILS = 5;
  const cfg = { cycleMs: 1000, confirmMs: 10000, jitterMs: 450, backoffMs: 5000, bidWaitMs: 24 * 3600 * 1000 };   // timings; the tests shorten them
  const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n) => Math.round(n).toLocaleString('en-US');
  const profitTxt = (c) => (c < 0 ? '−' : '') + usd(Math.abs(c));

  let catRef = null, itemMap = null;
  function itemOf(catalog, id) {
    if (catalog !== catRef) { catRef = catalog; itemMap = new Map((catalog?.items ?? []).map((i) => [i.id, i])); }
    return itemMap.get(id);
  }
  const loadOf = (it) => Math.floor(COURIER_CU / Math.max(1, it?.cargo_weight || 1));

  // Estimated cost of one unit, in cents: the inputs of the recipe that makes it, at catalog base value (the cheapest recipe
  // when several make it). A recipe with several outputs shares its inputs by the outputs' base value. Raw materials have no
  // inputs, so they cost 0 (pure profit); so does an item no catalog recipe makes.
  let recRef = null, costMap = null;
  function unitCost(catalog, id) {
    catalog = catalog ?? recRef;                 // game state briefly unreadable: keep using the last catalog, never read "no catalog" as "free"
    if (!catalog) return 0;
    if (catalog !== recRef) { recRef = catalog; costMap = new Map(); }
    if (costMap.has(id)) return costMap.get(id);
    const base = (i) => itemOf(catalog, i)?.base_value ?? 0;
    let best = null;
    for (const rc of catalog.recipes ?? []) {
      const out = (rc.outputs ?? []).find((o) => o.item === id);
      if (!out || !(out.amount > 0)) continue;
      const inCost = (rc.inputs ?? []).reduce((s, x) => s + x.amount * base(x.item), 0);
      const outValue = (rc.outputs ?? []).reduce((s, o) => s + o.amount * base(o.item), 0);
      const c = outValue > 0 ? inCost * base(id) / outValue : inCost / out.amount;
      if (best == null || c < best) best = c;
    }
    costMap.set(id, best ?? 0);
    return best ?? 0;
  }

  // ---- jobs --------------------------------------------------------------------------------------
  // job: { deal, item, region, unit (cents per unit), left (units still to sell, null = until stopped),
  //        sold, revenue + cogs (cents: what the sent units are worth, what they cost), lot (units the bid still wants, last seen),
  //        keep, fullLoads, expiresAt (tick), fails, retryAt, status, tone, last (ms of the last send),
//        from (the bid it moved from, or null), waitSince (ms since no bid qualified, 0 = not waiting for one) }
  const jobs = new Map();
  const toInt = (v, min, max, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
  function clean(j) {
    if (!j || !Number.isFinite(+j.deal) || !Number.isFinite(+j.item)) return null;
    return {
      deal: +j.deal, item: +j.item, region: toInt(j.region, 0, 99, 0), unit: Math.max(0, Number(j.unit) || 0),
      left: j.left == null ? null : toInt(j.left, 1, 1e9, null), sold: toInt(j.sold, 0, 1e12, 0), keep: toInt(j.keep, 0, 1e12, 0),
      fullLoads: !!j.fullLoads, expiresAt: Number.isFinite(+j.expiresAt) ? +j.expiresAt : 0,
      revenue: toInt(j.revenue, 0, 1e15, 0), cogs: toInt(j.cogs, 0, 1e15, 0), lot: toInt(j.lot, 0, 1e12, 0),
      from: Number.isFinite(j.from) ? j.from : null, waitSince: toInt(j.waitSince, 0, 1e15, 0),
      fails: 0, retryAt: 0, status: 'Starting', tone: '', last: 0,
    };
  }
  function save() {
    try { store?.setItem(KEY, JSON.stringify({ jobs: [...jobs.values()].map(({ deal, item, region, unit, left, sold, revenue, cogs, lot, keep, fullLoads, expiresAt, from, waitSince }) => ({ deal, item, region, unit, left, sold, revenue, cogs, lot, keep, fullLoads, expiresAt, from, waitSince })) })); } catch {}
  }
  function restore() {
    try {
      const o = JSON.parse(store?.getItem(KEY) || 'null');
      for (const j of Array.isArray(o?.jobs) ? o.jobs : []) { const c = clean(j); if (c && jobs.size < 50) jobs.set(c.deal, c); }
    } catch {}
  }

  // ---- reading the game ---------------------------------------------------------------------------
  function read(fresh = false) {
    const { ws, st, catalog, deals } = core.walk(fresh);
    if (!st || !catalog) return null;
    core.seeTick(st.ssi?.last_user_mutation_tick);
    return { st, catalog, deals, ws, wsOpen: ws?.readyState === 1, tick: core.nowTick(), shipId: st.next_shipment_id ?? 0, mutTick: st.ssi?.last_user_mutation_tick ?? 0 };
  }

  // ---- profit (cents) ---------------------------------------------------------------------------------------------------------
  const profitOf = (job) => job.revenue - job.cogs;                                       // actual, for what was sent so far
  // What the job makes in the end: the actual profit so far plus the margin on what it will still send (the target, or the
  // part of the bid that is still open when it runs until stopped).
  function estProfitOf(job, r) {
    const togo = Math.min(job.left ?? Infinity, job.lot || (job.left ?? 0));
    return Math.round(profitOf(job) + (job.unit - unitCost(r?.catalog, job.item)) * togo);
  }

  // ---- the decision (pure: no I/O) -------------------------------------------------------------------
  // r: { st, catalog, deals (array | null = board not loaded), tick, now }. Returns
  //   { kind: 'send', n, deal } | { kind: 'switch', deal } | { kind: 'wait', why, tone?, noBid? } | { kind: 'end', why }
  // r.taken (optional): ids of the bids other jobs hold. A 'switch' deal is the bid the job moves to.
  function decide(job, r) {
    if (job.left != null && job.left < 1) return { kind: 'end', why: 'target reached' };
    const tick = r.tick || 0;
    const floor = unitCost(r.catalog, job.item), name = nameOf(r, job.item);
    // No qualifying bid: wait, and give up once the job has waited cfg.bidWaitMs (cycle() keeps job.waitSince).
    const noBid = (why) => job.waitSince && r.now != null && r.now - job.waitSince >= cfg.bidWaitMs
      ? { kind: 'end', why: 'no ' + name + ' bid at ≥ ' + usd(floor) + ' for 24 h' }
      : { kind: 'wait', why, tone: 'muted', noBid: true };
    if (!Array.isArray(r.deals)) {
      if (tick && job.expiresAt && tick > job.expiresAt + 4) return noBid('bid expired: open the Market page so it can pick another bid');
      return { kind: 'wait', why: 'Market board not loaded (open the Market page once)' };
    }
    const deal = r.deals.find((d) => d.id === job.deal);
    if (!deal || deal.side !== 'Sell') {
      let best = null;
      for (const d of r.deals) {
        if (d.side !== 'Sell' || d.item !== job.item || d.region !== job.region || r.taken?.has(d.id) || r.st.standing_fills?.[d.id]) continue;
        if (!(d.amount > 0) || (tick && d.expires_at && d.expires_at <= tick) || d.price / d.amount < floor) continue;
        if (!best || d.price / d.amount > best.price / best.amount) best = d;
      }
      return best ? { kind: 'switch', deal: best } : noBid('waiting for a ' + name + ' bid at ≥ ' + usd(floor) + ' in ' + regionName(job.region));
    }
    if (r.st.standing_fills?.[job.deal]) return { kind: 'wait', why: "the game's own auto-ship is running on this bid" };
    const it = itemOf(r.catalog, deal.item);
    const load = loadOf(it);
    const stock = r.st.stock?.[deal.region]?.[deal.item] ?? 0;
    const spare = Math.floor(stock - job.keep);
    const want = Math.min(load, job.left ?? Infinity, deal.amount);
    const n = Math.min(want, spare);
    if (n < 1) return { kind: 'wait', why: 'waiting for ' + (it?.name ?? 'stock') + (job.keep ? ' above ' + num(job.keep) : '') + ' in stock', tone: 'muted' };
    if (job.fullLoads && n < want) return { kind: 'wait', why: 'waiting for a full load (' + num(n) + ' of ' + num(want) + ')', tone: 'muted' };
    const ready = r.st.courier_ready_at ?? 0;
    if (tick && tick < ready) return { kind: 'wait', why: 'courier ready in ' + Math.max(1, Math.ceil((ready - tick) / 2)) + ' s', tone: 'good' };
    if (r.now != null && r.now < job.retryAt) return { kind: 'wait', why: 'retrying in ' + Math.ceil((job.retryAt - r.now) / 1000) + ' s', tone: 'warn' };
    return { kind: 'send', n, deal };
  }

  // ---- the engine --------------------------------------------------------------------------------------
  let loopOn = false, wake = null;
  class ConnError extends Error {}
  const nameOf = (r, id) => itemOf(r?.catalog, id)?.name ?? 'item ' + id;

  function endJob(job, why, kind = 'info') {
    if (!jobs.delete(job.deal)) return;
    save();
    const name = nameOf(read(), job.item);
    core.ledger.add(TAG, kind, 'auto ship ' + name + ' ended: ' + why + ' (' + num(job.sold) + ' sold)' + (job.sold ? ', profit ' + profitTxt(profitOf(job)) : ''));
    core.toast('Auto ship ' + name + ' ended: ' + why, kind === 'fail' ? 'error' : 'info');
    renderAll();
  }

  // The job's bid is gone: the same job (sold, left, profit carry over) continues on bid d.
  function moveJob(job, d, r) {
    const old = job.deal, oldUnit = job.unit, name = nameOf(r, job.item);
    jobs.delete(old);
    Object.assign(job, { from: old, deal: d.id, unit: d.price / d.amount, lot: d.amount, expiresAt: d.expires_at, region: d.region, fails: 0, retryAt: 0, waitSince: 0 });
    jobs.set(d.id, job);
    save();
    core.ledger.add(TAG, 'info', 'auto ship ' + name + ' moved: bid #' + old + ' @ ' + usd(oldUnit) + ' → #' + d.id + ' @ ' + usd(job.unit));
    core.toast('Auto ship ' + name + ': moved to a bid at ' + usd(job.unit), 'info');
    if (modal && (modal.deal === old || modal.deal === d.id)) closeMenu(false);   // its Update / Stop / Start would act on the wrong job
    renderAll();
  }

  async function send(job, d, n) {
    const r = read(true);
    if (!r) throw new ConnError('game state not found');
    if (!r.wsOpen) throw new ConnError('socket not open');
    const id0 = r.shipId;
    const d0 = core.markSend(r.mutTick);
    const unit = d.price / d.amount;
    r.ws.send(JSON.stringify({ type: 'FillDeal', deal: d.id, amount: n >= d.amount ? null : n, hire: null, region: d.region, courier: true }));
    const ok = await core.waitConfirm({
      read, d0, timeoutMs: cfg.confirmMs,
      pred: (x) => x.shipId > id0,
      closed: () => { throw new ConnError('socket closed while waiting'); },
    });
    if (!ok) {
      // Lost the courier to someone else (Autopilot, the game's auto-ship, a click): not a failure, it goes again.
      const after = read();
      if (after && after.st.courier_ready_at > after.tick) { job.status = 'courier was taken: waiting'; job.tone = 'muted'; return false; }
      job.fails++;
      job.retryAt = Date.now() + Math.min(60000, cfg.backoffMs * 2 ** job.fails);
      core.ledger.add(TAG, 'fail', 'not confirmed: sell ' + num(n) + ' ' + nameOf(r, job.item) + ' (' + job.fails + '/' + MAX_FAILS + ')');
      if (job.fails >= MAX_FAILS) endJob(job, 'the server did not apply ' + MAX_FAILS + ' sends in a row', 'fail');
      return false;
    }
    job.fails = 0; job.retryAt = 0; job.last = Date.now();
    job.sold += n;
    if (job.left != null) job.left -= n;
    job.lot = Math.max(0, job.lot - n);       // what the bid still wants; the next cycle re-reads it
    const cost = unitCost(r.catalog, job.item) * n;
    job.revenue += Math.round(unit * n); job.cogs += Math.round(cost);
    save();
    core.ledger.add(TAG, 'action', 'auto ship ' + num(n) + ' ' + nameOf(r, job.item) + ' @ ' + usd(unit) + ' = ' + usd(unit * n) + (cost ? ', profit ' + profitTxt(unit * n - cost) : ''), { dMoney: Math.round(unit * n / 100) });
    return true;
  }

  async function cycle() {
    const r = read();
    if (!r) { for (const j of jobs.values()) { j.status = 'Waiting for the game'; j.tone = 'muted'; } return; }
    r.now = Date.now();
    // Least recently served first, so jobs share the courier.
    const order = [...jobs.values()].sort((a, z) => a.last - z.last || z.unit - a.unit);
    let sent = false;
    for (const job of order) {
      if (unloaded || !jobs.has(job.deal)) continue;
      const live = Array.isArray(r.deals) ? r.deals.find((d) => d.id === job.deal) : null;
      if (live?.side === 'Sell') job.lot = live.amount;
      r.taken = new Set([...jobs.keys()].filter((id) => id !== job.deal));
      const v = decide(job, r);
      const was = job.waitSince;
      job.waitSince = v.noBid ? (job.waitSince || r.now) : 0;
      if (!was !== !job.waitSince) save();   // so a reload does not restart the give-up clock
      if (v.kind === 'switch') { moveJob(job, v.deal, r); continue; }
      if (v.kind === 'end') { endJob(job, v.why); continue; }
      if (v.kind === 'wait') { job.status = v.why.charAt(0).toUpperCase() + v.why.slice(1); job.tone = v.tone || 'muted'; continue; }
      if (sent) { job.status = 'Waiting for the courier'; job.tone = 'good'; continue; }
      if (cfg.jitterMs) await sleep(150 + Math.random() * cfg.jitterMs);   // not the same millisecond every time
      if (unloaded || !jobs.has(job.deal)) continue;
      job.status = 'Shipping'; job.tone = 'good';
      renderAll();
      await send(job, v.deal, v.n);
      sent = true;
      const x = read(true);
      if (x) { r.st = x.st; r.tick = x.tick; r.deals = x.deals ?? r.deals; }
    }
  }

  async function loop() {
    if (loopOn) return;
    loopOn = true;
    try {
      while (!unloaded && jobs.size) {
        try { await cycle(); }
        catch (e) {
          if (!(e instanceof ConnError)) console.error('[autoSell]', e);
          for (const j of jobs.values()) { j.status = 'Connection lost: ' + (e.message || e); j.tone = 'warn'; }
          renderAll();
          await sleep(5000);
        }
        renderAll();
        await new Promise((res) => { wake = res; core.sleepWake(cfg.cycleMs).then(res); });
        wake = null;
      }
    } finally { loopOn = false; renderAll(); }
  }

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
  const publicJob = (j, r) => ({ deal: j.deal, from: j.from ?? null, item: j.item, region: j.region, unit: j.unit, left: j.left, sold: j.sold, keep: j.keep, fullLoads: j.fullLoads, status: j.status,
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
    const load = loadOf(it);
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

  // ---- load ---------------------------------------------------------------------------------------------------------------
  W.autoSell = {
    start, stop, jobs: listJobs, status, items, open: openMenu, cfg,
    get running() { return jobs.size > 0; },
    _decide: decide, _unitCost: unitCost,
    _unload() { unloaded = true; jobs.clear(); wake?.(); if (mounted) unmountUi(); },
  };

  restore();
  if (HAS_DOM) (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    if (unloaded) return;
    mountUi();
    if (jobs.size) { core.ledger.add(TAG, 'info', 'resumed ' + jobs.size + ' auto ship job' + (jobs.size > 1 ? 's' : '') + ' from the last session'); loop(); }
    console.log('[autoSell] ready: "Auto ship" button on every bid in the Market table, or autoSell.start({ deal, total, keep })');
  })();
})();
} catch (e) { console.error('[IdleCorp] Auto ship failed to load:', e); }
// @@END autosell
