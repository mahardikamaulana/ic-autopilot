// ============================================================================
// 3c. AUTO WITHDRAW (window.autoWithdraw)
// ============================================================================
// An "Auto" switch next to Withdraw on every row of the Inventory page's Exchange table. While it is on, each time the
// courier is free the item's goods at that region's Exchange are withdrawn to the same region's inventory, with the same
// TransferStock the game's Withdraw dialog sends (courier, one free courier load per run). It runs until switched off.
//   autoWithdraw.start({ region, item, keep })   // keep: units left at the Exchange (default 0)
//   autoWithdraw.stop(key) / stop()              // key = 'region:item'; one job / every job
//   autoWithdraw.jobs() / status()
// Rules (autoWithdraw._decide is the pure version, used by the tests):
//   - only free units: the Exchange's units minus what the game's own Auto-deliver still has to deliver (deliveries_due) and
//     minus "keep". Goods listed for sale are escrowed in orders, not in units, so they are never pulled back
//   - one send per courier run, shared with Auto ship: a courier taken by someone else is a wait, not a failure
//   - every send must be confirmed (the Exchange units drop or a new shipment id); 5 unconfirmed sends in a row slow the job
//     to one try every 10 min
// Jobs are saved in this browser and resume after a reload.
// @@MODULE autowithdraw
try {
  (() => {
    const W = typeof window !== 'undefined' ? window : globalThis;
    const core = W.idleCore;
    if (!core) throw new Error('the shared core did not load');
    const HAS_DOM = typeof document !== 'undefined' && !!document.body;
    const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
    const KEY = 'autoWithdraw.v1';
    const TAG = 'AW';
    if (W.autoWithdraw?._unload) W.autoWithdraw._unload();
    let unloaded = false;
    const sleep = core.sleep;

    const REGION_NAMES = ['Heartland', 'Industrial Basin', 'Coastal Cities', 'Frontier'];
    const regionName = (r) => REGION_NAMES[r] ?? 'Region ' + r;
    const MAX_FAILS = 5;
    const cfg = { cycleMs: 1000, confirmMs: 10000, jitterMs: 450, backoffMs: 5000 };
    const num = (n) => Math.round(n).toLocaleString('en-US');
    const keyOf = (region, item) => region + ':' + item;
    const toInt = (v, min, max, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };

    const itemOf = (catalog, id) => (catalog?.items ?? []).find((i) => i.id === id);
    const nameOf = (r, id) => itemOf(r?.catalog, id)?.name ?? 'item ' + id;
    const loadOf = (it, st) => Math.floor((core.courierCU?.(st) ?? 10000) / Math.max(1, it?.cargo_weight || 1));
    const atExchange = (st, region, item) => st?.exchange?.[String(region)]?.[String(item)]?.units ?? 0;
    const dueOf = (st, region, item) => (st?.deliveries_due ?? []).find((d) => d.region === region && d.item === item)?.amount ?? 0;

    // ---- jobs: { region, item, keep, moved, fails, retryAt, status, tone } ----------------------------------------------
    const jobs = new Map();
    function clean(j) {
      if (!j || !Number.isFinite(+j.item)) return null;
      return { region: toInt(j.region, 0, 3, 0), item: +j.item, keep: toInt(j.keep, 0, 1e12, 0), moved: toInt(j.moved, 0, 1e15, 0), fails: 0, retryAt: 0, status: 'Starting', tone: '' };
    }
    function save() { try { store?.setItem(KEY, JSON.stringify({ jobs: [...jobs.values()].map(({ region, item, keep, moved }) => ({ region, item, keep, moved })) })); } catch { } }
    function restore() {
      try {
        const o = JSON.parse(store?.getItem(KEY) || 'null');
        for (const j of Array.isArray(o?.jobs) ? o.jobs : []) { const c = clean(j); if (c && jobs.size < 100) jobs.set(keyOf(c.region, c.item), c); }
      } catch { }
    }

    function read(fresh = false) {
      const { ws, st, catalog } = core.walk(fresh);
      if (!st || !catalog) return null;
      core.seeTick(st.ssi?.last_user_mutation_tick);
      return { st, catalog, ws, wsOpen: ws?.readyState === 1, tick: core.nowTick(), shipId: st.next_shipment_id ?? 0, mutTick: st.ssi?.last_user_mutation_tick ?? 0 };
    }

    // ---- the decision (pure) --------------------------------------------------------------------------------------------
    // r: { st, catalog, tick, now } -> { kind: 'send', n } | { kind: 'wait', why, tone }
    function decide(job, r) {
      const it = itemOf(r.catalog, job.item);
      const free = Math.floor(atExchange(r.st, job.region, job.item) - dueOf(r.st, job.region, job.item) - job.keep);
      const n = Math.min(free, loadOf(it, r.st));
      if (n < 1) return { kind: 'wait', why: 'nothing to withdraw at the ' + regionName(job.region) + ' Exchange' + (job.keep ? ' above ' + num(job.keep) : ''), tone: 'muted' };
      const ready = r.st.courier_ready_at ?? 0;
      if (r.tick && r.tick < ready) return { kind: 'wait', why: 'courier ready in ' + Math.max(1, Math.ceil((ready - r.tick) / 2)) + ' s', tone: 'good' };
      if (r.now != null && r.now < job.retryAt) return { kind: 'wait', why: 'retrying in ' + Math.ceil((job.retryAt - r.now) / 1000) + ' s', tone: 'warn' };
      return { kind: 'send', n };
    }

    // ---- the engine -------------------------------------------------------------------------------------------------------
    let loopOn = false, wake = null;
    class ConnError extends Error { }

    async function send(job, n) {
      const r = read(true);
      if (!r) throw new ConnError('game state not found');
      if (!r.wsOpen) throw new ConnError('socket not open');
      const id0 = r.shipId, u0 = atExchange(r.st, job.region, job.item);
      const d0 = core.markSend(r.mutTick);
      // the exact shape the game's Withdraw dialog sends (Exchange -> inventory of the same region)
      r.ws.send(JSON.stringify({ type: 'TransferStock', from: job.region, to: job.region, item: job.item, amount: n, courier: true, from_exchange: true, to_exchange: false, list_price: null }));
      const ok = await core.waitConfirm({
        read, d0, timeoutMs: cfg.confirmMs,
        pred: (x) => x.shipId > id0 || atExchange(x.st, job.region, job.item) < u0,
        closed: () => { throw new ConnError('socket closed while waiting'); },
      });
      if (!ok) {
        const after = read();
        if (after && after.st.courier_ready_at > after.tick) { job.status = 'Courier was taken: waiting'; job.tone = 'muted'; return false; }
        if (core.link().state !== 'open') { job.status = 'Waiting for the game connection'; job.tone = 'muted'; return false; }
        job.fails++;
        job.retryAt = Date.now() + Math.min(60000, cfg.backoffMs * 2 ** job.fails);
        core.ledger.add(TAG, 'fail', 'not confirmed: withdraw ' + num(n) + ' ' + nameOf(r, job.item) + ' (' + job.fails + '/' + MAX_FAILS + ')');
        if (job.fails >= MAX_FAILS) { job.fails = 0; job.retryAt = Date.now() + 600000; core.ledger.add(TAG, 'fail', 'the server did not apply ' + MAX_FAILS + ' withdrawals in a row: this job retries every 10 min'); }
        return false;
      }
      job.fails = 0; job.retryAt = 0; job.moved += n;
      save();
      core.ledger.add(TAG, 'action', 'auto withdraw ' + num(n) + ' ' + nameOf(r, job.item) + ' from the ' + regionName(job.region) + ' Exchange');
      return true;
    }

    async function cycle() {
      const r = read();
      if (!r) { for (const j of jobs.values()) { j.status = 'Waiting for the game'; j.tone = 'muted'; } return; }
      r.now = Date.now();
      let sent = false;
      for (const [key, job] of jobs) {
        if (unloaded || !jobs.has(key)) continue;
        const v = decide(job, r);
        if (v.kind === 'wait') { job.status = v.why.charAt(0).toUpperCase() + v.why.slice(1); job.tone = v.tone; continue; }
        if (sent) { job.status = 'Waiting for the courier'; job.tone = 'good'; continue; }
        if (cfg.jitterMs) await sleep(150 + Math.random() * cfg.jitterMs);
        if (unloaded || !jobs.has(key)) continue;
        job.status = 'Withdrawing ' + num(v.n); job.tone = 'good';
        renderAll();
        await send(job, v.n);
        sent = true;
        const x = read(true);
        if (x) { r.st = x.st; r.tick = x.tick; }
      }
    }

    async function loop() {
      if (loopOn) return;
      loopOn = true;
      try {
        while (!unloaded && jobs.size) {
          try { await cycle(); }
          catch (e) {
            if (!(e instanceof ConnError)) console.error('[autoWithdraw]', e);
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

    // ---- public control ---------------------------------------------------------------------------------------------------
    function start({ region = 0, item, keep = 0 } = {}) {
      const c = clean({ region, item, keep });
      if (!c) throw new Error('bad item');
      const key = keyOf(c.region, c.item), prev = jobs.get(key);
      if (prev) prev.keep = c.keep; else jobs.set(key, c);
      save();
      core.ledger.add(TAG, 'info', (prev ? 'updated' : 'started') + ' auto withdraw ' + nameOf(read(), c.item) + ' at the ' + regionName(c.region) + ' Exchange' + (c.keep ? ', keep ' + num(c.keep) : ''));
      loop(); wake?.();
      renderAll();
      return key;
    }
    function stop(key) {
      const list = key == null ? [...jobs.keys()] : [String(key)].filter((k) => jobs.has(k));
      for (const k of list) {
        const j = jobs.get(k);
        jobs.delete(k);
        core.ledger.add(TAG, 'info', 'auto withdraw ' + nameOf(read(), j.item) + ' stopped (' + num(j.moved) + ' withdrawn)');
      }
      if (list.length) save();
      renderAll();
      return list.length;
    }
    const listJobs = () => [...jobs.entries()].map(([key, j]) => ({ key, region: j.region, item: j.item, keep: j.keep, moved: j.moved, status: j.status }));
    const status = () => listJobs().map((j) => nameOf(read(), j.item) + ' @ ' + regionName(j.region) + ': ' + num(j.moved) + ' withdrawn, ' + j.status);

    // ---- DOM: an Auto switch in the Withdraw cell of the Inventory page's Exchange table -------------------------------------
    // The button goes inside the existing cell (a new <td> would break ICUX's Columns menu on that table).
    const h = core.h;
    let styleEl = null, obs = null, passTimer = 0, tickTimer = 0, mounted = false;
    const CSS = '.aw-btn{margin-right:6px}.aw-btn.on::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#3fb950;margin-right:6px;vertical-align:middle}.aw-jobs{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-top:.4rem;font-size:.85rem}.aw-job{display:inline-flex;align-items:center;gap:.35rem}';
    // The region the page shows: the game's region context (it writes idlecorp.region only after a render), else the saved one.
    const ctxRegion = (el) => { const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$')); for (let f = k && el[k]; f; f = f.return) { const v = f.memoizedProps?.value; if (v && typeof v.setRegion === 'function' && Number.isInteger(v.region)) return v.region; } return null; };
    const uiRegion = (el) => { const c = el && ctxRegion(el); if (c != null) return c; const n = Number(store?.getItem('idlecorp.region')); return Number.isInteger(n) && n >= 0 && n < 4 ? n : 0; };

    // Running jobs, every region, in the Exchange header next to the game's Auto-deliver switch: a job whose row is gone
    // (its Exchange is empty, or another region is shown) can still be seen and stopped. Rebuilt only when the set changes.
    let stripSig = '';
    function injectStrip() {
      const head = document.querySelector('.exchange-head');
      let strip = head?.querySelector(':scope > .aw-jobs');
      if (!head || !jobs.size) { strip?.remove(); stripSig = ''; return; }
      const sig = [...jobs.keys()].join(',');
      if (!strip || sig !== stripSig) {
        strip?.remove(); stripSig = sig;
        const r = read();
        strip = h('div', { class: 'aw-jobs' }, h('span', { class: 'muted' }, 'Auto withdraw:'),
          ...[...jobs.entries()].map(([k, j]) => h('span', { class: 'aw-job', 'data-key': k }, nameOf(r, j.item) + ' @ ' + regionName(j.region) + ' ',
            h('span', { class: 'badge aw-status' }), h('button', { type: 'button', class: 'mini', onclick: () => stop(k) }, 'Stop'))));
        head.append(strip);
      }
      for (const el of strip.querySelectorAll('.aw-job')) {
        const j = jobs.get(el.dataset.key), s = el.querySelector('.aw-status');
        if (!j || !s) continue;
        const t = num(j.moved) + ' withdrawn · ' + j.status;
        if (s.textContent !== t) s.textContent = t;
        const cls = 'badge aw-status' + (j.tone === 'good' ? ' good' : '');
        if (s.className !== cls) s.className = cls;
      }
    }

    function inject() {
      if (!HAS_DOM || unloaded) return;
      injectStrip();
      let region = null;
      for (const td of document.querySelectorAll('td.lift-wide')) {
        region ??= uiRegion(td);
        const item = Number(td.closest('tr')?.querySelector('button.item-link[data-item]')?.dataset.item);
        const withdraw = td.querySelector('button:not(.aw-btn)');
        let btn = td.querySelector(':scope > .aw-btn');
        if (!Number.isFinite(item) || !withdraw) { btn?.remove(); continue; }
        if (!btn) {
          btn = h('button', { type: 'button', class: 'mini aw-btn' }, 'Auto');
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const k = keyOf(+btn.dataset.region, +btn.dataset.item);
            if (jobs.has(k)) stop(k); else start({ region: +btn.dataset.region, item: +btn.dataset.item });
          });
          td.insertBefore(btn, withdraw);
        }
        btn.dataset.region = String(region); btn.dataset.item = String(item);
        const job = jobs.get(keyOf(region, item));
        btn.classList.toggle('on', !!job);
        btn.setAttribute('aria-pressed', String(!!job));
        const t = job ? 'Auto withdraw is on: ' + job.status + ' (' + num(job.moved) + ' withdrawn). Click to stop.'
          : 'Withdraw this item automatically: every time the courier is free, until you stop it';
        if (btn.title !== t) btn.title = t;
      }
    }
    const renderAll = () => { if (mounted && !unloaded) { clearTimeout(passTimer); passTimer = setTimeout(inject, 60); } };
    function mountUi() {
      mounted = true;
      styleEl = h('style', { id: 'aw-style' }, CSS);
      document.head.append(styleEl);
      obs = core.ui.onDom(renderAll);
      tickTimer = setInterval(inject, 1000);
      inject();
    }
    function unmountUi() {
      mounted = false;
      obs?.(); obs = null;
      clearInterval(tickTimer); clearTimeout(passTimer);
      styleEl?.remove(); styleEl = null;
      document.querySelectorAll('.aw-btn, .aw-jobs').forEach((b) => b.remove());
    }

    W.autoWithdraw = {
      start, stop, jobs: listJobs, status, cfg,
      get running() { return jobs.size > 0; },
      _decide: decide,
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
      if (jobs.size) { core.ledger.add(TAG, 'info', 'resumed ' + jobs.size + ' auto withdraw job' + (jobs.size > 1 ? 's' : '')); loop(); }
    })();
  })();
} catch (e) { console.error('[IdleCorp] Auto withdraw failed to load:', e); }
// @@END autowithdraw
