// ============================================================================
// 3c. AUTO UTILITIES (window.autoUtil)
// ============================================================================
// An "Auto" switch on the Load tile (power, Utilities page) and the Supply tile (water, Utilities > Water). While it is on, the
// grid service (power) or waterworks (water) subscription follows what the Corporation needs: it is raised at once when the groups
// need more than the capacity, and lowered when the load has stayed down. Nothing else is touched.
//   autoUtil.set('power', true) / autoUtil.set('water', false)   // the same switches, from the console
//   autoUtil.status() / autoUtil.stop()                          // what it does now / both switches off
//   autoUtil.cfg                                                 // timings; autoUtil.conf: spare per utility, hold minutes
//
// What it follows (the game's own page shows the same numbers, except that bought contracts count their capacity less any shortfall; autoUtil._measure is the pure version, used by the tests):
//   need = load (running groups' building draw + recipe draw) + power sold on contracts (the promised amount) + lines out + what stalled
//          groups wait for - self-generated (generators, at the day/night rate) - storage that can discharge (at most stored / ticks to
//          the bill it pays for) - bought on contracts - lines in (transmission lines, power)
//   The subscription is set to ceil(need) plus the spare you set (default 0), at most 200 MW / 500 kL, one region at a time.
// Money rules, from how the game bills (power $10 per MW, water $4 per kL, every 10 minutes):
//   - raising charges the extra level for the current period up front; lowering refunds nothing. So a raise is made at once (one that
//     only stalled groups need waits out the last 60 ticks before a bill, which would charge it again),
//     but a lower only when the highest need of the last "hold" minutes (default 10) is below the level, and only in the minute
//     before a bill, so the level never drops and has to be bought again inside one period. It never lowers the first hold minutes.
//   - cash must cover the raise now AND the next bill, which is for the higher level (every subscription is billed together): a raise
//     the cash cannot cover is cut to what it can, and nothing is sent when it cannot cover one unit.
//   - power has one owner: while Auto power is on, Autopilot stands down on power, so idle groups (unpaused, no work) are not paid for
//     and the two never undo each other.
//   - every change is confirmed by the subscription value in the game state; 3 unconfirmed sends in a row switch that utility off
//     (a closed game socket is waited out, it is not a failed send).
// World power events (core.powerEvent: NPC power x2, x1.5 or x0.5 for 2 h, worked out ahead from the server's seeds), only where Battery Banks are:
//   - the 2 h before a x2 / x1.5 event: stored power is not counted on and the level is not lowered, so the batteries keep and gain charge
//     at the normal price; a minute before it starts the plan switches to the event so a lower lands on the bill before it.
//   - during a x2 / x1.5 event: what is stored is spread over the rest of the event (not just to the next bill), so the batteries carry
//     the load and the subscription is not raised mid-event.
//   - during a x0.5 event: stored power is not counted on and the batteries' charge rate (until full) is added, so they fill cheaply.
//     Unverified: that a Battery Bank charges from spare grid service, not only from generators (the wiki says generated surplus).
//   The Load tile shows the next power event (or the one in force), whether Auto is on or not.
// The switches are saved in this browser. Alt+Shift+X switches them off with everything else.
// @@MODULE utilities
try {
  (() => {
    const W = typeof window !== 'undefined' ? window : globalThis;
    const core = W.idleCore;
    if (!core) throw new Error('the shared core did not load');
    const HAS_DOM = typeof document !== 'undefined' && !!document.body;
    const store = (() => { try { return W.localStorage ?? null; } catch { return null; } })();
    const KEY = 'autoUtil.v1';
    const TAG = 'AU';
    if (W.autoUtil?._unload) W.autoUtil._unload();
    let unloaded = false;
    const h = core.h;

    // ---- game facts (from the game's own bundle) -----------------------------------------------------------------
    // rate: cents per unit per 10-minute bill (power: times core.powerPriceMult() during an 'NPC power xN' event); tile: the label of
    // the tile the switch sits on. max: the client's own caps (constants in its bundle, not in the game state).
    const UTILS = {
      power: { unit: 'MW', rate: 1000, max: 200, tile: 'Load', noun: 'grid service' },
      water: { unit: 'kL', rate: 400, max: 500, tile: 'Supply', noun: 'waterworks' },
    };
    const NAMES = Object.keys(UTILS);
    const RATES = { power: 1000, water: 400, bandwidth: 1500 };   // cents per unit per bill: what the game bills together (ISP: st.isp, 15 per Mbps)
    const DAY = 28800, DAYLIGHT = 21600, NIGHT_PCT = 25;       // ticks; diurnal generators make 25% of their output at night
    const BILL_TICKS = 1200;                                   // a bill every 10 minutes at 2 ticks a second
    const PRE_EVENT_TICKS = 14400;                             // keep the batteries this long before a dear power event (a full Battery Bank charges in 10,800)
    const INTANGIBLE = new Set([0, 24, 25, 26, 106, 107, 108, 109, 110, 111]);   // items held in st.items, not in stock
    const MAX_FAILS = 3;
    const cfg = { cycleMs: 2000, confirmMs: 10000, backoffMs: 5000, lowerWindowTicks: 120, raiseHoldTicks: 60 };   // timings; the tests shorten them. raiseHoldTicks: a raise only stalled groups need waits for the bill this close to it
    const conf = { power: { on: false, spare: 0 }, water: { on: false, spare: 0 }, holdMin: 10 };
    const REGION_NAMES = ['Heartland', 'Industrial Basin', 'Coastal Cities', 'Frontier'];
    const regionName = (r) => REGION_NAMES[r] ?? 'Region ' + r;
    const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const toInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt; };

    // ---- saved switches ------------------------------------------------------------------------------------------------
    const persistable = () => ({ power: { ...conf.power }, water: { ...conf.water }, holdMin: conf.holdMin });
    function apply(o) {
      const applied = [], skipped = [];
      if (!o || typeof o !== 'object') return { applied, skipped: ['not an object'] };
      for (const u of NAMES) {
        const x = o[u];
        if (x == null) continue;
        if (typeof x !== 'object') { skipped.push(u); continue; }
        if (typeof x.on === 'boolean') { if (conf[u].on !== x.on) { conf[u].on = x.on; resetUtil(u); } applied.push(u + '.on'); } else if ('on' in x) skipped.push(u + '.on');
        if ('spare' in x) { const n = toInt(x.spare, 0, UTILS[u].max, null); if (n == null) skipped.push(u + '.spare'); else { conf[u].spare = n; applied.push(u + '.spare'); } }
      }
      if ('holdMin' in o) { const n = toInt(o.holdMin, 1, 120, null); if (n == null) skipped.push('holdMin'); else { conf.holdMin = n; applied.push('holdMin'); } }
      return { applied, skipped };
    }
    function save() { try { store?.setItem(KEY, JSON.stringify(persistable())); } catch { } }
    function restore() { try { apply(JSON.parse(store?.getItem(KEY) || 'null')); } catch { } }

    // ---- reading the game ----------------------------------------------------------------------------------------------
    function read(fresh = false) {
      const { ws, st, catalog, contracts, engine } = core.walk(fresh);
      if (!st || !catalog) return null;
      core.seeTick(st.ssi?.last_user_mutation_tick);
      const tick = core.nowTick();
      // Transmission lines: the client asks its engine for the flows (lineFlows, a BigInt tick) only when the state has lines.
      let flows = [];
      try { if ((st.lines ?? []).length && tick > 0 && typeof engine?.lineFlows === 'function') flows = JSON.parse(engine.lineFlows(BigInt(tick))) ?? []; } catch { flows = []; }
      return { st, catalog, contracts, flows, ws, wsOpen: ws?.readyState === 1, tick, mutTick: st.ssi?.last_user_mutation_tick ?? 0, priceMult: core.powerPriceMult?.() ?? 1, pev: core.powerEvent?.(engine, tick) ?? null };
    }

    const ixRef = new WeakMap();
    function idx(catalog) {
      let x = ixRef.get(catalog);
      if (!x) { x = { b: new Map((catalog.buildings ?? []).map((b) => [b.id, b])), r: new Map((catalog.recipes ?? []).map((r) => [r.id, r])) }; ixRef.set(catalog, x); }
      return x;
    }
    const diurnal = (p, tick) => (((tick % DAY) + DAY) % DAY < DAYLIGHT ? p : Math.floor(p * NIGHT_PCT / 100));

    // ---- what is needed (pure: no I/O) -----------------------------------------------------------------------------------
    // The page's numbers for one utility in one region. Returns what the groups draw, what is generated, stored or bought, what
    // stalled groups wait for, and need: the subscription that covers all of it (can be negative: the Corporation has a surplus).
    // flows: the engine's line flows [{ from, to, sent, delivered }] (power only): Lines in add supply, Lines out count as load, as on the page.
    // ev: the power event plan from eventPlan ({ mode: 'pre' | 'dear' | 'cheap', end }), or null; it counts only where storage is.
    function measure(util, region, st, catalog, tick, contracts, flows = [], ev = null) {
      const R = String(region), ix = idx(catalog);
      const have = st.subscriptions?.[R]?.[util] ?? 0;
      const groups = Object.values(st.groups ?? {}).filter((g) => (g.region ?? 0) === region);
      const stockOf = (item) => (INTANGIBLE.has(item) ? (st.items?.[item] ?? 0) : (st.stock?.[R]?.[item] ?? 0));
      let load = 0, gen = 0;
      for (const g of groups) {
        const work = g.work ?? [];
        if (work.length) load += (ix.b.get(g.building)?.draws?.[util] ?? 0) * g.count;
        for (const w of work) {
          const rc = ix.r.get(w.recipe);
          if (!rc) continue;
          load += (rc.draws?.[util] ?? 0) * w.runs;
          const p = (rc.generates?.[util] ?? 0) * w.runs;
          gen += rc.diurnal ? diurnal(p, tick) : p;
        }
      }
      const owned = (id) => (st.building_pool?.[R]?.[id] ?? 0) + groups.filter((g) => g.building === id).reduce((a, g) => a + g.count, 0);
      let dischargeCap = 0, chargeCap = 0, storeMax = 0;
      for (const b of catalog.buildings ?? []) {
        const s = b.storage?.[util], n = s ? owned(b.id) : 0;
        if (n) { dischargeCap += (s.discharge_limit ?? 0) * n; chargeCap += (s.charge_limit ?? 0) * n; storeMax += (s.max ?? 0) * n; }
      }
      // Stored is in MW-ticks (7,200 = 1 MWh): count only the rate it can keep up until the next bill, so a Battery Bank that would run
      // dry mid-period does not cut the subscription. Right after a bill that is stored / 1,200, and the hold window keeps that sample.
      const stored = st.stored?.[R]?.[util] ?? 0, toBill = tick > 0 ? BILL_TICKS - (tick % BILL_TICKS) : 0;
      // Power events: before a dear one and during a cheap one nothing stored is counted on (a cheap one also adds the charge rate until
      // full); during a dear one what is stored is spread to the event's end.
      const mode = util === 'power' && dischargeCap + chargeCap > 0 ? ev?.mode ?? null : null;
      const toUse = mode === 'dear' && ev.end > tick ? ev.end - tick : toBill;
      const discharge = mode === 'pre' || mode === 'cheap' ? 0 : Math.min(dischargeCap, stored, toUse ? stored / toUse : stored);
      const charge = mode === 'cheap' ? Math.min(chargeCap, Math.max(0, storeMax - stored)) : 0;
      const lines = util === 'power' && Array.isArray(flows) ? flows : [];
      const lineIn = lines.filter((f) => f.to === region).reduce((a, f) => a + (Number(f.delivered) || 0), 0);
      const lineOut = lines.filter((f) => f.from === region && f.delivered > 0).reduce((a, f) => a + (Number(f.sent) || 0), 0);
      const corp = st.ssi?.corp_id;
      // What is bought counts its capacity less any shortfall (core.bought); what is promised to others is owed, whatever has got through.
      const imported = core.bought(util, region, st, contracts);
      const sold = (contracts ?? []).filter((c) => c.utility === util && c.region === region && c.state === 'Active' && c.seller === corp).reduce((a, c) => a + (c.amount ?? 0), 0);
      // A group that could start but whose draw is more than the free capacity is stalled; it starts once that much more is free.
      // A group with no machines yet (equipped 0) cannot start whatever the power: the game calls it "unequipped", not stalled.
      const free = Math.max(0, have + gen + discharge + imported + lineIn - load - sold - lineOut);
      let waiting = 0;
      for (const g of groups) {
        if (g.paused || g.equipped === 0 || (g.work ?? []).length) continue;
        const draw = (ix.b.get(g.building)?.draws?.[util] ?? 0) * g.count;
        if (!(draw > 0) || draw <= free) continue;
        const rc = (g.recipe != null && (st.recipes?.[String(g.recipe)] ?? ix.r.get(g.recipe))) || null;
        if (!rc || !(rc.inputs ?? []).every((i) => stockOf(i.item) >= i.amount)) continue;
        waiting += draw;
      }
      return { util, region, have, load, sold, gen, discharge, charge, mode, imported, lineIn, lineOut, waiting, need: load + sold + lineOut + waiting + charge - gen - discharge - imported - lineIn };
    }

    // The plan for a power event (pev: core.powerEvent()) at tick: { mode, end, mult } or null. 'pre': the PRE_EVENT_TICKS before a dear
    // one, up to a minute (cfg.lowerWindowTicks) before it starts; 'dear' from then to its end; 'cheap' while a x0.5 one is in force, up to a
    // minute before its end, so the charge headroom is lowered on the bill at its end rather than paid for one more period.
    function eventPlan(pev, tick) {
      if (!pev || !(tick > 0) || !(pev.end > tick) || pev.mult === 1) return null;
      const mult = pev.mult, end = pev.end;
      if (pev.start <= tick) return mult > 1 ? { mode: 'dear', end, mult } : end - tick > cfg.lowerWindowTicks ? { mode: 'cheap', end, mult } : null;
      if (mult > 1 && pev.start - tick <= PRE_EVENT_TICKS) return { mode: pev.start - tick <= cfg.lowerWindowTicks ? 'dear' : 'pre', end, mult };
      return null;
    }
    const ticksText = (t) => { const m = Math.max(1, Math.ceil(t / 120)); return m >= 60 ? Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') : m + ' min'; };
    function eventLine(pev, tick) {
      if (!pev || !(tick > 0) || !(pev.end > tick)) return '';
      const x = 'NPC power x' + pev.mult + (pev.title ? ' (' + pev.title + ')' : '');
      return pev.start <= tick ? 'Event now: ' + x + ', ' + ticksText(pev.end - tick) + ' left' : 'Upcoming event: ' + x + ' in ' + ticksText(pev.start - tick);
    }

    // The level that covers a measurement: ceil(need) plus the spare (only when something needs it), over the cap flagged.
    function wantOf(m, spare = 0) {
      const u = UTILS[m.util];
      const raw = m.need > 0 ? Math.ceil(m.need - 1e-9) + spare : 0;
      return { want: Math.min(u.max, raw), over: raw > u.max ? raw : 0 };
    }

    // What the game bills at the next bill, all subscriptions together (cents).
    // mult: the NPC power price multiplier (never below 1 here, so a misread can only make it more careful).
    function billsOf(st, mult = 1) {
      let t = (st.isp ?? 0) * RATES.bandwidth;
      for (const o of Object.values(st.subscriptions ?? {})) for (const [k, l] of Object.entries(o ?? {})) t += (l ?? 0) * (RATES[k] ?? 0) * (k === 'power' ? Math.max(1, mult) : 1);
      return t;
    }

    // What to do about one level. peak: the highest want over the hold window; observedMs: how long it has been watched;
    // ticksToBill: ticks until the next bill (null: unknown); bills: what that bill is now. Returns { kind: 'ok' | 'raise' | 'lower' | 'hold' | 'broke', ... }.
    // urgent: the want without what stalled groups wait for (null: all of it is urgent). mult: the NPC power price multiplier.
    function decide({ util, have, want, peak, observedMs, holdMs, money, bills = 0, ticksToBill, canLower = true, lowerWindowTicks = cfg.lowerWindowTicks, urgent = null, mult = 1, raiseHoldTicks = cfg.raiseHoldTicks, keepWhy = null }) {
      const rate = UTILS[util].rate * (util === 'power' ? Math.max(1, mult) : 1);
      // A raise is charged up front for the period and the bill charges the level again: one only stalled groups need waits out the
      // last raiseHoldTicks before the bill instead of paying twice for a few seconds.
      if (want > have && urgent != null && urgent <= have && ticksToBill != null && ticksToBill < raiseHoldTicks) return { kind: 'hold', why: 'raising for stalled groups after the bill' };
      if (want > have) {
        // Each extra unit costs its rate now and again in the next bill: cash left after the bill as it is must pay both.
        const afford = have + Math.floor(Math.max(0, money - bills) / (2 * rate));
        const level = Math.min(want, afford);
        if (level <= have) return { kind: 'broke', level: want };
        return { kind: 'raise', level, partial: level < want };
      }
      if (peak < have) {
        if (!canLower) return { kind: 'hold', why: 'contracts not readable' };
        if (keepWhy) return { kind: 'hold', why: keepWhy };
        if (observedMs < holdMs) return { kind: 'hold', why: 'watching the load first' };
        if (ticksToBill != null && ticksToBill > lowerWindowTicks) return { kind: 'hold', why: 'lowering just before the next bill', level: peak };
        return { kind: 'lower', level: peak };
      }
      return { kind: 'ok' };
    }

    // ---- the engine --------------------------------------------------------------------------------------------------------
    const ctl = new Map();                 // util:region -> { samples: [{t, want}], first, fails, retryAt }
    const info = { power: [], water: [] }; // the last look, for the page
    let loopTimer = null, busy = false;
    const anyOn = () => NAMES.some((u) => conf[u].on);
    const unit = (u) => UTILS[u].unit;

    function resetUtil(util) { for (const k of [...ctl.keys()]) if (k.startsWith(util + ':')) ctl.delete(k); info[util] = []; }

    function regionsOf(util, st) {
      const s = new Set();
      for (const g of Object.values(st.groups ?? {})) s.add(g.region ?? 0);
      for (const [r, o] of Object.entries(st.subscriptions ?? {})) if ((o?.[util] ?? 0) > 0) s.add(Number(r));
      return [...s].sort((a, b) => a - b);
    }

    async function setLevel(util, region, level) {
      const r = read(true);
      if (!r || !r.wsOpen) return 'down';                         // nothing was sent: not a failed change
      const d0 = core.markSend(r.mutTick);
      r.ws.send(JSON.stringify({ type: 'SetSubscription', region, utility: util, level }));
      const ok = await core.waitConfirm({
        read, d0, timeoutMs: cfg.confirmMs,
        pred: (x) => (x.st.subscriptions?.[String(region)]?.[util] ?? 0) === level,
        closed: () => { throw new Error('socket closed while waiting'); },
      });
      return !!ok;
    }

    async function step(now = Date.now()) {
      if (busy || unloaded) return;
      busy = true;
      try {
        let r = read(true);
        for (const util of NAMES) {
          if (!conf[util].on) { info[util] = []; continue; }
          if (!r) { info[util] = [{ text: 'Waiting for the game', tone: 'muted' }]; continue; }
          const out = [];
          for (const region of regionsOf(util, r.st)) {
            if (unloaded || !conf[util].on) break;                    // switched off while an earlier change was being confirmed
            const row = await tend(util, region, r, now);
            out.push(row);
            if (row.sent) r = read(true) ?? r;                        // the cash and levels changed: the next one is decided on the new state
          }
          info[util] = conf[util].on ? out : [];
        }
        render();
      } catch (e) { console.error('[autoUtil]', e); }
      finally { busy = false; }
    }

    async function tend(util, region, r, now) {
      const key = util + ':' + region, u = UTILS[util];
      let c = ctl.get(key);
      if (!c) ctl.set(key, c = { samples: [], first: now, fails: 0, retryAt: 0 });
      const ev = util === 'power' ? eventPlan(r.pev, r.tick) : null;
      const m = measure(util, region, r.st, r.catalog, r.tick, r.contracts, r.flows, ev);
      if (c.mode !== m.mode) { c.mode = m.mode; c.samples = []; }      // a new event plan: the old peak does not hold the level
      const evNote = !m.mode ? '' : m.mode === 'pre' ? ' · keeping batteries for NPC power x' + ev.mult : m.mode === 'dear' ? ' · on batteries during NPC power x' + ev.mult : ' · filling batteries at NPC power x' + ev.mult;
      const { want, over } = wantOf(m, conf[util].spare);
      const urgent = wantOf({ ...m, need: m.need - m.waiting }, conf[util].spare).want;
      const mult = util === 'power' ? Math.max(1, r.priceMult ?? 1) : 1;
      const holdMs = conf.holdMin * 60000;
      c.samples.push({ t: now, want });
      while (c.samples.length > 1 && c.samples[0].t < now - holdMs) c.samples.shift();
      const peak = Math.max(...c.samples.map((s) => s.want));
      const money = r.st.items?.[0] ?? 0, bills = billsOf(r.st, r.priceMult ?? 1);
      const ticksToBill = r.tick > 0 ? BILL_TICKS - (r.tick % BILL_TICKS) : null;
      const d = decide({ util, have: m.have, want, peak, observedMs: now - c.first, holdMs, money, bills, ticksToBill, canLower: Array.isArray(r.contracts), urgent, mult, keepWhy: m.mode === 'pre' ? 'keeping spare for the batteries before NPC power x' + ev.mult : null });
      const where = regionName(region);
      const row = { region, util, have: m.have, need: m.need, want, kind: d.kind };
      if (d.kind === 'raise' || d.kind === 'lower') {
        if (now < c.retryAt) return { ...row, text: 'Retrying in ' + Math.ceil((c.retryAt - now) / 1000) + ' s', tone: 'warn' };
        const was = m.have;
        const res = await setLevel(util, region, d.level);
        if (res === 'down') return { ...row, text: 'Waiting for the game connection', tone: 'muted' };
        if (res === true) {
          c.fails = 0; c.retryAt = 0;
          const why = d.kind === 'raise' ? 'need ' + Math.ceil(m.need) + (d.partial ? ', cash pays for ' + d.level + ' only' : '') : 'highest need in the last ' + conf.holdMin + ' min: ' + peak;
          core.ledger.add(TAG, 'action', where + ' ' + util + ' ' + u.noun + ' ' + was + ' → ' + d.level + ' ' + unit(util) + ' (' + why + ')');
          return { ...row, have: d.level, sent: true, text: (d.kind === 'raise' ? 'Raised to ' : 'Lowered to ') + d.level + ' ' + unit(util) + evNote, tone: 'good' };
        }
        if (core.link().state !== 'open') return { ...row, text: 'Waiting for the game connection', tone: 'muted' };
        c.fails++;
        c.retryAt = now + Math.min(60000, cfg.backoffMs * 2 ** c.fails);
        core.ledger.add(TAG, 'fail', 'not confirmed: ' + util + ' to ' + d.level + ' ' + unit(util) + ' (' + c.fails + '/' + MAX_FAILS + ')');
        if (c.fails >= MAX_FAILS) {
          c.fails = 0; c.retryAt = now + 600000;
          core.ledger.add(TAG, 'fail', 'Auto ' + util + ': the server did not apply ' + MAX_FAILS + ' changes in a row; it retries every 10 min');
          renderAll();
        }
        return { ...row, sent: true, text: 'Change not confirmed (' + c.fails + '/' + MAX_FAILS + ')', tone: 'warn' };
      }
      c.fails = 0; c.retryAt = 0;                                   // nothing to send: earlier failures are not "in a row" any more
      const lowNote = m.need < 0 ? ' (surplus ' + Math.round(-m.need) + ')' : '';
      const boughtNote = m.imported > 0 ? ' + ' + m.imported + ' ' + unit(util) + ' bought' : '';
      if (d.kind === 'broke') return { ...row, text: 'Needs ' + want + ' ' + unit(util) + ' but cash cannot cover the upfront ' + usd((want - m.have) * u.rate * mult) + ' and the next bill' + (mult > 1 ? ' (NPC power x' + mult + ')' : ''), tone: 'warn' };
      if (over) return { ...row, text: 'Needs ' + Math.ceil(over) + ' ' + unit(util) + ', the cap is ' + u.max, tone: 'warn' };
      if (d.kind === 'hold') return { ...row, text: 'Holding ' + m.have + ' ' + unit(util) + boughtNote + ': ' + d.why, tone: 'muted' };
      return { ...row, text: 'Following the load: ' + m.have + ' ' + unit(util) + boughtNote + ' for ' + Math.max(0, Math.ceil(m.need + m.imported)) + ' needed' + lowNote + evNote, tone: 'muted' };
    }

    function ensureLoop() {
      if (anyOn() && !loopTimer && !unloaded) { loopTimer = core.every(cfg.cycleMs, step); }
      else if (!anyOn() && loopTimer) { loopTimer(); loopTimer = null; }
    }

    function set(util, on) {
      if (!UTILS[util]) throw new Error('utility must be one of ' + NAMES.join(', '));
      on = !!on;
      if (conf[util].on === on) return on;
      conf[util].on = on; save();
      resetUtil(util);
      core.ledger.add(TAG, 'info', 'Auto ' + util + (on ? ' on' : ' off'));
      ensureLoop();
      renderAll();
      return on;
    }
    function stop() { for (const u of NAMES) set(u, false); }
    function status() { return NAMES.map((u) => u + ': ' + (conf[u].on ? (info[u].map((x) => (x.region != null ? regionName(x.region) + ' ' : '') + x.text).join('; ') || 'on') : 'off')).join(' | '); }

    // ---- the page ------------------------------------------------------------------------------------------------------
    const CSS = '.au-host{position:relative}' +
      '.au-sw{position:absolute;top:8px;right:10px;display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ink-2,#b6b6ba);cursor:pointer;user-select:none}' +
      '.au-sw input{position:absolute;opacity:0;width:0;height:0}' +
      '.au-track{width:26px;height:14px;border-radius:7px;background:var(--surface-3,#27272a);border:1px solid var(--border,rgba(255,255,255,.18));position:relative;transition:background .15s}' +
      '.au-track::after{content:"";position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;background:var(--ink-2,#b6b6ba);transition:transform .15s}' +
      '.au-sw input:checked+.au-track{background:var(--status-good,#22b573);border-color:transparent}' +
      '.au-sw input:checked+.au-track::after{transform:translateX(12px);background:#fff}' +
      '.au-sw input:focus-visible+.au-track{outline:2px solid var(--accent,#5b8def);outline-offset:2px}' +
      '.au-note{margin-top:6px;font-size:11px;line-height:1.4;color:var(--muted,#808086)}.au-note.warn{color:var(--status-warn,#f2a93b)}.au-note.good{color:var(--status-good,#22b573)}' +
      '@media (prefers-reduced-motion:reduce){.au-track,.au-track::after{transition:none}}';

    let styleEl = null, obs = null, tickTimer = 0, passTimer = 0, mounted = false;
    const tileOf = (util) => [...document.querySelectorAll('.stat-grid > .tile')].find((t) => t.querySelector(':scope > .label')?.textContent.trim() === UTILS[util].tile);

    function inject() {
      if (!HAS_DOM || unloaded || !mounted) return;
      for (const util of NAMES) {
        const tile = tileOf(util);
        for (const el of document.querySelectorAll('[data-au="' + util + '"],[data-au-note="' + util + '"],[data-au-ev="' + util + '"]')) if (el.parentElement !== tile) el.remove();
        if (!tile) continue;
        tile.classList.add('au-host');
        let sw = tile.querySelector(':scope > [data-au="' + util + '"]'), note = tile.querySelector(':scope > [data-au-note="' + util + '"]');
        if (!sw) {
          const box = h('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Auto ' + UTILS[util].noun + ' (' + util + ')', onchange: (e) => set(util, e.target.checked) });
          sw = h('label', { class: 'au-sw', 'data-au': util, title: 'Keep the ' + UTILS[util].noun + ' subscription at what the groups need: up at once, down when the load has stayed low' },
            box, h('span', { class: 'au-track' }), h('span', {}, 'Auto'));
          tile.append(sw);
        }
        if (!note) { note = h('div', { class: 'au-note', 'data-au-note': util }); tile.append(note); }
        const box = sw.querySelector('input');
        if (box.checked !== conf[util].on) box.checked = conf[util].on;
        const rows = info[util];
        const text = !conf[util].on ? '' : (rows.length ? rows.map((x) => (rows.length > 1 && x.region != null ? regionName(x.region) + ': ' : '') + x.text).join(' · ') : 'Auto is on');
        const tone = rows.find((x) => x.tone === 'warn') ? 'warn' : rows.find((x) => x.tone === 'good') ? 'good' : '';
        if (note.textContent !== text) note.textContent = text;
        note.className = 'au-note' + (tone ? ' ' + tone : '');
        note.hidden = !text;
        if (util !== 'power') continue;
        let evEl = tile.querySelector(':scope > [data-au-ev="power"]');
        if (!evEl) { evEl = h('div', { class: 'au-note', 'data-au-ev': 'power' }); tile.append(evEl); }
        const evText = eventLine(core.powerEvent?.(), core.nowTick());
        if (evEl.textContent !== evText) evEl.textContent = evText;
        evEl.hidden = !evText;
      }
    }
    const render = () => { if (mounted && !unloaded) inject(); };
    const renderAll = () => { if (mounted && !unloaded) { clearTimeout(passTimer); passTimer = setTimeout(inject, 60); } };

    function mountUi() {
      mounted = true;
      styleEl = h('style', { id: 'au-style' }, CSS);
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
      document.querySelectorAll('[data-au],[data-au-note],[data-au-ev]').forEach((e) => e.remove());
      document.querySelectorAll('.au-host').forEach((e) => e.classList.remove('au-host'));
    }

    // ---- load --------------------------------------------------------------------------------------------------------------
    W.autoUtil = {
      set, stop, status, cfg, conf,
      get running() { return anyOn(); },
      exportCfg: () => ({ cfg: persistable() }),
      importCfg(o) { const r = apply(o?.cfg ?? o); save(); ensureLoop(); renderAll(); return r; },
      _measure: measure, _want: wantOf, _decide: decide, _eventPlan: eventPlan, _eventLine: eventLine, _step: step, _info: info,
      _unload() { unloaded = true; loopTimer?.(); loopTimer = null; if (mounted) unmountUi(); },
    };

    restore();
    if (anyOn()) ensureLoop();
    if (HAS_DOM) (async () => {
      for (; ;) {
        if (unloaded) return;
        if (document.querySelector('.primary-navigation') && read()) break;
        await core.sleep(500);
      }
      mountUi();
      if (anyOn()) core.ledger.add(TAG, 'info', 'resumed: Auto ' + NAMES.filter((u) => conf[u].on).join(' + ') + ' from the last session');
      console.log('[autoUtil] ready: "Auto" switch on the Load tile (power) and the Supply tile (water) of the Utilities pages, or autoUtil.set("power", true)');
    })();
  })();
} catch (e) { console.error('[IdleCorp] Auto utilities failed to load:', e); }
// @@END utilities