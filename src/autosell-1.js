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
//   - one FillDeal per courier run: min(stock above "keep", one free courier load, what is left to sell, the lot). "keep" is at
//     least what Autopilot / Core plan reserve of that item (core.reserves); the courier load counts capacity upgrades
//   - when several jobs can ship, the one whose run is worth most goes first (unit price x units that run would carry)
//   - nothing is sent while the courier is busy, the stock is short, or the game's own auto-ship runs on that bid
//   - the job ends when the target is reached, or after 24 h with no bid that qualifies. When its bid is gone (filled,
//     withdrawn, expired) it moves to the best open bid for the same item in the same region (most money per courier run, never
//     below the item's est. cost per unit or 90% of the bid you picked, not one another job holds); with none it waits. A bid board that is not
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
    const { regionName } = core;
    const MAX_FAILS = 5;
    const cfg = { cycleMs: 1000, confirmMs: 10000, jitterMs: 450, backoffMs: 5000, bidWaitMs: 24 * 3600 * 1000, switchFloorPct: 90 };   // timings (the tests shorten them); switchFloorPct: a moved job never takes a bid below this % of the bid you picked
    const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const num = core.ui.num;
    const profitTxt = (c) => (c < 0 ? '−' : '') + usd(Math.abs(c));

    let catRef = null, itemMap = null;
    function itemOf(catalog, id) {
      if (catalog !== catRef) { catRef = catalog; itemMap = new Map((catalog?.items ?? []).map((i) => [i.id, i])); }
      return itemMap.get(id);
    }
    // One free courier run, with the capacity upgrades in st.courier_levels.
    const loadOf = (it, st) => Math.floor((core.courierCU?.(st) ?? 10000) / Math.max(1, it?.cargo_weight || 1));
    // What one courier run on a bid is worth (cents), the way jobs and replacement bids are ranked: a cheaper bid with a big lot
    // can beat a dearer one that takes only a few units.
    const runValue = (d, job, r) => (d.price / d.amount) * Math.min(loadOf(itemOf(r.catalog, d.item), r.st), d.amount, job.left ?? Infinity);

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
    const toInt = core.toInt;
    function clean(j) {
      if (!j || !Number.isFinite(+j.deal) || !Number.isFinite(+j.item)) return null;
      return {
        deal: +j.deal, item: +j.item, region: toInt(j.region, 0, 99, 0), unit: Math.max(0, Number(j.unit) || 0),
        unit0: Math.max(0, Number(j.unit0 ?? j.unit) || 0),   // unit price of the bid you picked: the floor for a move, kept through every move
        left: j.left == null ? null : toInt(j.left, 1, 1e9, null), sold: toInt(j.sold, 0, 1e12, 0), keep: toInt(j.keep, 0, 1e12, 0),
        fullLoads: !!j.fullLoads, expiresAt: Number.isFinite(+j.expiresAt) ? +j.expiresAt : 0,
        revenue: toInt(j.revenue, 0, 1e15, 0), cogs: toInt(j.cogs, 0, 1e15, 0), lot: toInt(j.lot, 0, 1e12, 0),
        from: Number.isFinite(j.from) ? j.from : null, waitSince: toInt(j.waitSince, 0, 1e15, 0),
        fails: 0, retryAt: 0, status: 'Starting', tone: '', last: 0,
      };
    }
    function save() {
      try { store?.setItem(KEY, JSON.stringify({ jobs: [...jobs.values()].map(({ deal, item, region, unit, unit0, left, sold, revenue, cogs, lot, keep, fullLoads, expiresAt, from, waitSince }) => ({ deal, item, region, unit, unit0, left, sold, revenue, cogs, lot, keep, fullLoads, expiresAt, from, waitSince })) })); } catch { }
    }
    function restore() {
      try {
        const o = JSON.parse(store?.getItem(KEY) || 'null');
        for (const j of Array.isArray(o?.jobs) ? o.jobs : []) { const c = clean(j); if (c && jobs.size < 50) jobs.set(c.deal, c); }
      } catch { }
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
      // A move never goes below cfg.switchFloorPct of the bid you picked (unit cost alone is 0 for raw goods).
      const floor = Math.max(unitCost(r.catalog, job.item), (job.unit0 ?? job.unit ?? 0) * cfg.switchFloorPct / 100), name = nameOf(r, job.item);
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
          const v = runValue(d, job, r), bv = best && runValue(best, job, r);
          if (!best || v > bv || (v === bv && d.price / d.amount > best.price / best.amount)) best = d;
        }
        return best ? { kind: 'switch', deal: best } : noBid('waiting for a ' + name + ' bid at ≥ ' + usd(floor) + ' in ' + regionName(job.region));
      }
      if (r.st.standing_fills?.[job.deal]) return { kind: 'wait', why: "the game's own auto-ship is running on this bid" };
      const it = itemOf(r.catalog, deal.item);
      const load = loadOf(it, r.st);
      const stock = r.st.stock?.[deal.region]?.[deal.item] ?? 0;
      // r.reserved: core.reserves.merged().items (cycle() reads it): what Autopilot / Core plan keep of each item is never sold.
      // Those reserves are Heartland stock: a bid in another region ships that region's stock and keeps only job.keep.
      const keep = Math.max(job.keep, deal.region === 0 ? Number(r.reserved?.[deal.item]) || 0 : 0);
      const spare = Math.floor(stock - keep);
      const want = Math.min(load, job.left ?? Infinity, deal.amount);
      const n = Math.min(want, spare);
      if (n < 1) return { kind: 'wait', why: 'waiting for ' + (it?.name ?? 'stock') + (keep ? ' above ' + num(keep) + (keep > job.keep ? ' (reserved)' : '') : '') + ' in stock', tone: 'muted' };
      if (job.fullLoads && n < want) return { kind: 'wait', why: 'waiting for a full load (' + num(n) + ' of ' + num(want) + ')', tone: 'muted' };
      const ready = r.st.courier_ready_at ?? 0;
      if (tick && tick < ready) return { kind: 'wait', why: 'courier ready in ' + Math.max(1, Math.ceil((ready - tick) / 2)) + ' s', tone: 'good' };
      if (r.now != null && r.now < job.retryAt) return { kind: 'wait', why: 'retrying in ' + Math.ceil((job.retryAt - r.now) / 1000) + ' s', tone: 'warn' };
      return { kind: 'send', n, deal };
    }

    // ---- the engine --------------------------------------------------------------------------------------
    let loopOn = false, wake = null;
    class ConnError extends Error { }
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
        if (core.link().state !== 'open') { job.status = 'waiting for the game connection'; job.tone = 'muted'; return false; }
        job.fails++;
        job.retryAt = Date.now() + Math.min(60000, cfg.backoffMs * 2 ** job.fails);
        core.ledger.add(TAG, 'fail', 'not confirmed: sell ' + num(n) + ' ' + nameOf(r, job.item) + ' (' + job.fails + '/' + MAX_FAILS + ')');
        if (job.fails >= MAX_FAILS) { job.fails = 0; job.retryAt = Date.now() + 600000; core.ledger.add(TAG, 'fail', 'the server did not apply ' + MAX_FAILS + ' sends in a row: this job retries every 10 min'); }
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

    // [[job, runValue]] -> jobs in send order: runs within 10% of the best first, least recently served (job.last) first among them.
    function jobOrder(runs) {
      const top = Math.max(0, ...runs.map(([, v]) => v)), band = (v) => top > 0 && v >= top * 0.9;
      return runs.sort((a, z) => band(z[1]) - band(a[1]) || (band(a[1]) ? a[0].last - z[0].last : z[1] - a[1]) || a[0].last - z[0].last).map(([j]) => j);
    }
    async function cycle() {
      const r = read();
      if (!r) { for (const j of jobs.values()) { j.status = 'Waiting for the game'; j.tone = 'muted'; } return; }
      r.now = Date.now();
      r.reserved = core.reserves?.merged?.()?.items ?? {};
      // The run worth most goes first (unit price x what one run carries); runs within 10% of the best: least recently served first,
      // so a job that can always ship does not starve the others.
      const runOf = (j) => {
        const d = Array.isArray(r.deals) ? r.deals.find((x) => x.id === j.deal) : null;
        return d?.side === 'Sell' && d.amount > 0 ? runValue(d, j, r) : 0;
      };
      const order = jobOrder([...jobs.values()].map((j) => [j, runOf(j)]));
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

