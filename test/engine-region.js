// Full Core plan loop in the real engine across every region (scripts/multi-region-plan.md): buildout, retail and expand directors, the
// first action of each Core plan step sent one message a tick (each step waits for its `until`), and Auto utilities on its own 2 s cycle
// over every region it lists (as engine-expand-test's auCycle). Shared by engine-region-test.js and the plan's probes.
//   const R = await require('./engine-region.js').load();  // null offline
//   R.run({ hours, expand: 'off' | 'ask' | 'auto', edit(snap, mem), seed, per })
//     -> { perH(h), money[], ids[], snap, mem, log }
const F = require('./cp-fixtures');
const FX = require('./live-2026-11-28.json');
const fs = require('fs');
const path = require('path');

async function load() {
  const eng = await require('./engine.js').load();
  if (!eng) return null;
  const cat = eng.catalog();
  F.load(['cp-buildout', 'cp-retail', 'utilities', ...(F.full().includes('// @@MODULE cp-expand\n') ? ['cp-expand'] : [])]);
  if (!globalThis.corePlan._expand) (0, eval)(F.slice(fs.readFileSync(path.join(__dirname, '..', 'src', 'cp-expand.js'), 'utf8'), 'cp-expand'));
  const cp = globalThis.corePlan, au = globalThis.autoUtil;
  const H = 7200, T0 = 1.8e12;
  const id = (n) => cat.items.find((i) => i.name === n).id;
  const bid = (n) => cat.buildings.find((b) => b.name === n).id;

  function run({ hours = 4, expand = 'off', edit = () => {}, seed = false, per = 300, snap: snapIn = null, mem: memIn = null, cfg = {} } = {}) {
    const fx = F.clone(FX), m = memIn ? F.clone(memIn) : {}, mem = (n) => ({ get: () => m[n] ?? {}, set: (p) => (m[n] = { ...(m[n] ?? {}), ...p }) });
    if (snapIn) fx.snap = F.clone(snapIn);
    if (!memIn) mem('buildout').set({ ftMine: [3] });   // the 11 paused Frame Timber Workshops were paused by Core plan's Wooden Frame gate
    if (seed) Object.assign(fx.snap.stock[0], { [id('Iron Frame')]: 40, [id('Concrete')]: 100, [id('Glass')]: 100 });
    edit(fx.snap, mem);
    const saved = { ...cp.cfg };
    Object.assign(cp.cfg, { expand }, cfg);
    au.conf.power.on = true;
    const e = new eng.Engine(fx.snap.ssi.corp_id);
    e.load(fx.snap); e.setRetail(fx.retail); e.setMarket(fx.market); e.setContracts(fx.contracts);
    e.tickAt(Math.max(1, fx.snap.courier_ready_at ?? 0) + 1);   // the engine's counter starts at 1: align it or the courier looks busy
    let tick = e.tick([]).tick, ran = 0, snap = e.snapshot();
    const r = { money: [snap.items[0]], ids: [], waits: [], over: 0 };
    const samples = {}, first = {};
    const measure = (reg) => au._measure('power', reg, snap, cat, tick, fx.contracts);
    const step = (msgs = []) => {
      const d = e.tick(msgs); if (d?.tick) tick = d.tick; ran++; snap = e.snapshot();
      if (ran % H === 0) r.money.push(snap.items[0]);
    };
    function auCycle() {   // Auto utilities' tend(): the want, the hold window's peak, the bill timing, then _decide
      for (const reg of au._regionsOf('power', snap)) {
        const x = measure(reg), spare = au.conf.power.spare;
        if (x.load > x.have + x.imported + x.gen + 1e-9) r.over++;
        const { want } = au._want(x, spare), urgent = au._want({ ...x, need: x.need - x.waiting - x.ending }, spare).want;
        const s = (samples[reg] ??= []); first[reg] ??= tick;
        s.push({ t: tick, want });
        while (s.length > 1 && s[0].t < tick - au.conf.holdMin * 120) s.shift();
        const d = au._decide({ util: 'power', have: x.have, want, peak: Math.max(...s.map((y) => y.want)), observedMs: (tick - first[reg]) * 500, holdMs: au.conf.holdMin * 60000,
          money: snap.items[0], bills: 0, ticksToBill: 1200 - (tick % 1200), canLower: true, urgent });
        if (d.kind === 'raise' || d.kind === 'lower') step([{ type: 'SetSubscription', region: reg, utility: 'power', level: d.level }]);
      }
    }
    try {
      while (ran < hours * H) {
        const ctx = F.ctxOf({ retailBoard: fx.retail, mem, now: T0 + ran * 500, tick, contracts: fx.contracts, mods: { autoUtil: au }, live: true });
        const out = cp._decide(cp._view(snap, cat, []), ctx);
        const a = out.actions[0];
        const w = out.waits.find((x) => /^expand:/.test(x));
        if (w && r.waits[r.waits.length - 1] !== w.replace(/[\d,.]+/g, '#')) r.waits.push(w.replace(/[\d,.]+/g, '#'));
        if (a) {
          r.ids.push(Math.floor(ran / 120) + 'm ' + a.id);
          for (const st of a.steps) { step([st.msg]); for (let k = 0; k < 40 && !st.until(cp._view(snap, cat, [])); k++) step(); }
        }
        const to = Math.min(hours * H, (Math.floor(ran / per) + 1) * per);
        while (ran < to) { step(); if (ran % 4 === 0) auCycle(); }
      }
    } finally {
      for (const k of Object.keys(cp.cfg)) if (!(k in saved)) delete cp.cfg[k];
      Object.assign(cp.cfg, saved);
      au.conf.power.on = false;
    }
    r.snap = snap; r.mem = m;
    r.perH = (h) => (r.money[h] - r.money[h - 1]) / 100;
    r.log = '\nactions: ' + r.ids.join(', ') + '\nexpand waits: ' + r.waits.join(' | ') + '\n$/h: ' + r.money.slice(1).map((x, h) => Math.round(r.perH(h + 1))).join(', ') + '\nover supply ticks: ' + r.over;
    return r;
  }
  return { run, cp, au, cat, eng, FX, F, id, bid, H };
}
module.exports = { load };
