// continues the core-plan closure from core-plan-2.js (same try / IIFE)
  // ---- reading the game, sending, confirming ---------------------------------------------------------------------------------
  let pacer = core.pacer ? core.pacer({ cmdsPerMin: cfg.cmdsPerMin }) : null;
  function read(fresh = false) {
    const { ws, st, catalog, deals, engine } = core.walk(fresh);
    lastEngine = engine ?? lastEngine;
    if (!st || !catalog) return null;
    core.seeTick(st.ssi?.last_user_mutation_tick);
    return { st, catalog, ws, deals: deals ?? [], wsOpen: ws?.readyState === 1, mutTick: st.ssi?.last_user_mutation_tick ?? 0, v: view(st, catalog, deals ?? []) };
  }
  const cash = [];
  const pauseSent = new Map();   // group id -> when Core plan last sent SetPaused true for it (D7 reads it: a late confirm is not a bill pause)
  let lastEngine = null;
  const memOf = (name) => { const k = KEY + '.mem.' + name; let o = {}; try { o = JSON.parse(store?.getItem(k) || '{}') ?? {}; } catch {} return { get: () => o, set: (patch) => { o = { ...o, ...patch }; try { store?.setItem(k, JSON.stringify(o)); } catch {} return o; } }; };
  // Keeps one sample at least 60 min old, for E5's hourly trend. A gap over 5 min (stopped, tab asleep) drops the older samples, so the trend
  // is null until 60 min of contiguous samples (not 2 x the 30 s period: a hidden tab steps about once a minute).
  function trackCash(v, t = Date.now()) { if (cash.length && t - cash[cash.length - 1].t > 300000) cash.length = 0; if (!cash.length || t - cash[cash.length - 1].t >= 30000) cash.push({ t, m: v.money }); while (cash.length > 1 && t - cash[1].t >= 3600000) cash.shift(); }
  // Cash trend over the last 60 min in cents per hour; null until a sample is 60 min old.
  function cashTrend60(t = Date.now()) { const base = [...cash].reverse().find((c) => t - c.t >= 3600000), last = cash[cash.length - 1]; return base && last.t > base.t ? (last.m - base.m) * 3600000 / (last.t - base.t) : null; }
  function cashDelta10() { const t = Date.now(), base = [...cash].reverse().find((c) => t - c.t >= 600000); return base && cash.length ? cash[cash.length - 1].m - base.m : null; }
  function context(r) {
    const ap = W.earlyGame;
    let apRes = null; try { apRes = ap?.reserve?.() ?? null; } catch {}
    const others = core.reserves.merged();
    let floor = 0;
    for (const [n, x] of Object.entries(others?.by ?? {})) if (n !== 'corePlan') floor = Math.max(floor, x.moneyFloor ?? 0);
    return {
      planDone: apRes ? apRes.phase === 'done' : null,
      ap: ap?.cfg ? { neverSell: [...(ap.cfg.neverSell ?? [])], cdBooster: ap.cfg.cdBooster, running: !!ap.running } : null,
      apNextTech: apRes?.nextTech && ap?.busy ? apRes.nextTech : null,
      cashDelta10: cashDelta10(), floorCents: floor + cfg.cashReserve,
      // E5 net income (cents/h): the cash trend plus what CD Farm spent in the same hour (rates().spendH, dollars)
      netIncomeH: (() => { const c = cashTrend60(); if (c == null) return null; let s = 0; try { s = W.cdFarm?.rates?.()?.spendH ?? 0; } catch {} return c + s * 100; })(),
      retailOk: null,   // set by the retail director's checkpoint sampler (ctx is mutable for directors' context())
      tick: Math.max(core.nowTick(), r?.st?.ssi?.last_user_mutation_tick ?? 0),
      reserveItems: (() => { const o = {}; for (const [n, x] of Object.entries(others?.by ?? {})) if (n !== 'corePlan') for (const [i, k] of Object.entries(x.items ?? {})) o[i] = (o[i] ?? 0) + k; return o; })(),
      now: Date.now(), premium: !!r?.st?.premium, deals: r?.deals ?? [],
      retailBoard: (() => { try { const j = lastEngine?.retailJson?.(); return typeof j === 'string' ? JSON.parse(j) : j ?? null; } catch { return null; } })(),
      mem: memOf, live: running && !cfg.dryRun, dryRun: cfg.dryRun, pauseSent: Object.fromEntries(pauseSent),
      mods: { cdFarm: W.cdFarm ?? null, labRunner: W.labRunner ?? null, autoSell: W.autoSell ?? null, autoUtil: W.autoUtil ?? null, earlyGame: W.earlyGame ?? null },
    };
  }

  const ledgerNote = (kind, text) => core.ledger.add(TAG, kind, text);
  let running = false, stepping = false, loopTimer = 0, last = null, fails = 0, lastSig = '', lastWait = '', lastWouldAt = {}, stopReason = '';
  const holds = new Set();

  async function sendStep(st) {
    const r = read(true);
    if (!r || !r.wsOpen) return 'down';
    await pacer?.beforeCommand?.();
    const d0 = core.markSend(r.mutTick);
    r.ws.send(JSON.stringify(st.msg));
    const ok = await core.waitConfirm({ read, d0, timeoutMs: cfg.confirmMs, pred: (x) => st.until(x.v), closed: () => { throw new Error('socket closed while waiting'); } });
    pacer?.noteConfirm?.({ ok: !!ok, rtt: core.lastRtt() });
    return !!ok;
  }
  async function perform(a) {
    if (a.run) {
      const ok = await a.run();
      if (ok === true) ledgerNote('action', a.text);
      else if (ok === false) ledgerNote('fail', 'did not work: ' + a.text + ' (' + (fails + 1) + '/' + cfg.maxFails + ')');
      return ok;
    }
    if (a.patch) {
      if (!W.earlyGame?.tune) return false;
      const rep = W.earlyGame.tune(a.patch);
      ledgerNote('action', a.text + ' (' + rep.applied.join(', ') + (rep.skipped.length ? '; skipped ' + rep.skipped.join(', ') : '') + ')');
      return true;
    }
    if (a.hold) await core.reserves.holdAll('corePlan', 'corePlan');
    try {
      for (const st of a.steps) {
        if (st.msg?.type === 'SetPaused' && st.msg.paused) pauseSent.set(st.msg.group, Date.now());
        const ok = await sendStep(st);
        if (ok === 'down') return null;           // nothing was sent
        if (!ok) { ledgerNote('fail', 'not confirmed: ' + a.text + ' (' + (fails + 1) + '/' + cfg.maxFails + ')'); return false; }
      }
      ledgerNote('action', a.text);
      return true;
    } finally { if (a.hold) core.reserves.releaseAll('corePlan', 'corePlan'); }
  }

  const sigOf = (d) => [d.stage, ...d.S.map((c) => c.ok), ...d.E.map((c) => c.ok)].join('|');
  function report(d) {
    const sig = sigOf(d);
    if (sig === lastSig) return;
    lastSig = sig;
    ledgerNote('info', 'stage ' + (d.stage ?? '-') + ' | ' + d.S.map((c) => c.id + (c.ok === null ? '?' : c.ok ? '+' : '-')).join(' ') + ' | ' + d.E.map((c) => c.id + (c.ok ? '+' : '-')).join(' '));
  }

  async function step() {
    if (stepping || unloaded) return;
    stepping = true;
    try {
      const r = read(true);
      if (!r) { last = { waits: ['waiting for the game'] }; return; }
      trackCash(r.v);
      const d = decide(r.v, context(r));
      last = d; report(d);
      if (running && !cfg.dryRun) heartbeat();
      if (holds.size || !running) return;
      const a = d.actions[0];
      if (!a) { const w = d.waits.join(' | '), key = w.replace(/[\d,.$]+/g, '#'); if (key !== lastWait) { lastWait = key; ledgerNote('info', 'waiting: ' + w); } return; }   // amounts move every step: log a wait once per reason
      if (cfg.dryRun) { const t = Date.now(); if (!(lastWouldAt[a.id] > t - 60000)) { lastWouldAt[a.id] = t; ledgerNote('info', 'dry run, would: ' + a.text); } return; }
      const ok = await perform(a);
      if (ok === true) fails = 0;
      else if (ok === false && ++fails >= cfg.maxFails) { stopReason = 'the server did not apply ' + cfg.maxFails + ' actions in a row'; ledgerNote('fail', 'stopped: ' + stopReason); core.notify('CP', 'Core plan stopped', stopReason); stop(); }
    } catch (e) {
      ledgerNote('fail', 'error: ' + (e.message ?? e));
      if (/socket closed/.test(e.message ?? '')) return;
    } finally { stepping = false; }
  }

