// Browser harness for the userscript panels: loads ic-autopilot.user.js into headless Chrome on a fake game page
// (sidebar, top bar, a fake React tree with the saved live board) and takes screenshots / runs UI checks.
//   bun test/ui-harness.js shots <outDir> [width] [height]     # screenshots of all three panels (Autopilot, CD Farm, Lab), every tab
//   bun test/ui-harness.js check                                # DOM + keyboard + mount/unmount assertions
const fs = require('fs');
const path = require('path');
const { chromium } = (() => {
  for (const p of [process.env.PLAYWRIGHT_PATH, 'playwright', path.join(require('os').homedir(), '.bun/install/global/node_modules/playwright')]) {
    if (!p) continue;
    try { return require(p); } catch {}
  }
  throw new Error('playwright not found: install it (bun add -g playwright) or set PLAYWRIGHT_PATH');
})();
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'live-board.json'), 'utf8'));
const script = fs.readFileSync(process.env.USERSCRIPT || path.join(__dirname, '..', 'ic-autopilot.user.js'), 'utf8');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Idle Corp</title><style>
:root{--surface:#151517;--surface-2:#1d1d20;--surface-3:#27272a;--border:rgba(255,255,255,.09);--ink:#ededee;--ink-2:#b6b6ba;--muted:#808086;--accent:#5b8def;--accent-wash:rgba(91,141,239,.14);--status-good:#22b573;--status-warn:#f2a93b;--status-crit:#ef5b45;--nav-accent:#5b8def}
*{box-sizing:border-box}#root{display:flex;flex:1;min-width:0}body{margin:0;background:#0d0d0f;color:var(--ink);font:13px/1.5 system-ui,sans-serif;height:100vh;display:flex}
.primary-navigation{width:200px;padding:12px;display:flex;flex-direction:column;gap:2px;border-right:1px solid var(--border)}
.page-tab{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--ink-2);font:inherit;cursor:pointer}
.page-tab:hover{background:var(--surface-2)}
main{flex:1;display:flex;flex-direction:column}.topbar{height:44px;border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 16px}
.topbar-tools{margin-left:auto;display:flex;gap:8px;align-items:center}.tip-anchor{width:24px;height:24px;background:var(--surface-3);border-radius:50%}
button{font:inherit;color:var(--ink);background:var(--surface-3);border:1px solid var(--border);border-radius:6px;height:30px;padding:0 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:transparent;color:#fff}button:disabled{opacity:.5;cursor:default}
</style></head><body>
<div id="root"><nav class="primary-navigation"><button class="page-tab">Corp</button><button class="page-tab">Market</button></nav>
<main><div class="topbar"><div class="topbar-tools"><span class="tip-anchor"></span></div></div><div style="flex:1;padding:24px">Game content</div></main></div></body></html>`;

// The game's real layout (read from idlecorp.net on 2026-11-23): .shell > .app-sidebar (fixed 200px rail) + .chrome (sticky top bar,
// fixed to the bottom at <=700px) + .page-body. Panels dock beside it; the plain PAGE above has no .shell, so it covers the floating fallback.
const SHELL_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Idle Corp</title><style>
:root{--page:#0d0d0f;--surface:#151517;--surface-2:#1d1d20;--surface-3:#27272a;--border:rgba(255,255,255,.09);--ink:#ededee;--ink-2:#b6b6ba;--muted:#808086;--accent:#5b8def;--accent-dim:#2b4a86;--accent-wash:rgba(91,141,239,.14);--status-good:#22b573;--status-warn:#f2a93b;--status-crit:#ef5b45;--ring-off:rgba(255,255,255,.16);--shadow:0 1px 2px rgba(0,0,0,.35),0 4px 16px rgba(0,0,0,.18)}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 "Inter Variable",system-ui,-apple-system,"Segoe UI",sans-serif}
button,input,select{font:inherit;color:var(--ink);background:var(--surface-2);border:1px solid var(--border);border-radius:6px;height:30px;padding:0 .7rem}
button{cursor:pointer}button:hover:not(:disabled){background:var(--surface-3)}button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--accent);color:#fff;font-weight:500}button.primary:hover:not(:disabled){background:#6f9cf2}button.danger{border-color:rgba(208,59,59,.6);color:var(--status-crit)}
input:focus-visible,select:focus-visible{outline:none;border-color:var(--accent)}input[type=checkbox]{accent-color:var(--accent);height:auto}
.shell{display:block;min-height:100vh;padding-left:200px}
.app-sidebar{position:fixed;inset:0 auto 0 0;z-index:40;width:200px;display:flex;flex-direction:column;gap:1.25rem;padding:.7rem .75rem 1rem;overflow-y:auto;background:var(--page);border-right:1px solid var(--border)}
.sidebar-brand{display:flex;align-items:center;height:24px;padding:0 .6rem;font-weight:600}
.primary-navigation{display:flex;flex-direction:column;gap:2px}
.primary-navigation .page-tab{width:100%;height:34px;display:flex;align-items:center;justify-content:flex-start;gap:.65rem;padding:0 .6rem;border:none;border-radius:6px;background:none;color:var(--ink-2);font-size:13.5px;text-align:left}
.primary-navigation .page-tab .nav-icon{flex:0 0 auto;color:var(--muted)}
.primary-navigation .page-tab .nav-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.primary-navigation .page-tab:hover:not(:disabled){background:var(--surface);color:var(--ink)}
.primary-navigation .page-tab.active{background:var(--surface-2);color:var(--ink);font-weight:600}
.primary-navigation .page-tab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.chrome{position:sticky;top:0;z-index:40;background:rgba(13,13,13,.65);backdrop-filter:blur(10px)}
.topbar{display:flex;align-items:center;flex-wrap:wrap;gap:.6rem 1rem;padding:.7rem 1.5rem;border-bottom:1px solid var(--border)}
.topbar-context{display:flex;align-items:center;height:32px;padding:0 .8rem;border-radius:8px;background:var(--surface-2);font-weight:500}
.topbar-tools{display:flex;flex:1 1 auto;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:.6rem;min-width:0}
.tip-anchor{display:inline-flex}
.power-status,.shipments-chip{display:inline-flex;align-items:center;gap:.35rem;color:var(--ink-2);border:1px solid transparent;border-radius:999px;background:var(--surface-2);height:24px;line-height:22px;padding:0 .6rem;font-size:12.5px;white-space:nowrap}
.notice-bell{width:30px;height:30px;padding:0;border:0;border-radius:8px;background:none;color:var(--ink-2)}
.balance{font-size:15px;font-variant-numeric:tabular-nums}
.page-body{display:flex;flex-direction:column;gap:1.25rem;padding:1.5rem;max-width:1800px;margin:0 auto}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}
.panel-head{display:flex;align-items:center;gap:.75rem;padding:4px 4px 4px 1rem;min-height:40px;border-bottom:1px solid var(--border)}
.panel-head h2{font-size:15px;font-weight:600;letter-spacing:-.01em;margin:0}
.panel-body{padding:.75rem 1rem 1rem;display:flex;flex-direction:column;gap:.6rem}
.stat-strip{display:flex;flex-wrap:wrap;gap:.75rem 2.5rem}.stat-strip-value{font-size:24px;font-weight:500;letter-spacing:-.02em;line-height:1.2;font-variant-numeric:tabular-nums}.stat-strip-label{color:var(--muted);font-size:13px;margin-top:.15rem}
@media (max-width:900px){.shell{padding-left:0}.app-sidebar{display:none}.topbar{padding:.6rem 1rem}.page-body{padding:1rem}}
@media (max-width:700px){.chrome{position:fixed;inset:auto 0 0;background:rgba(13,13,13,.85)}.topbar{border-bottom:0;border-top:1px solid var(--border);padding:.5rem 1rem}.topbar-tools{order:-1;flex:1 0 100%;flex-wrap:nowrap;overflow-x:auto;justify-content:flex-start;scrollbar-width:none}.shell{padding-bottom:var(--chrome-h,120px)}}
</style></head><body>
<div id="root"><div class="shell">
<aside class="app-sidebar"><div class="sidebar-brand">IdleCorp</div><nav class="primary-navigation"><button class="page-tab active"><span class="nav-text">Corp</span></button><button class="page-tab"><span class="nav-text">Market</span></button></nav></aside>
<div class="chrome"><header class="topbar"><div class="topbar-context">Heartland</div><div class="topbar-tools"><span class="tip-anchor"><span class="power-status">11/11 MW</span></span><span class="shipments-chip">8 · 32s</span><span class="tip-anchor"></span></div><button class="notice-bell" aria-label="Notices">●</button><span class="balance">$1,775,058.39</span></header></div>
<div class="page-body"><div class="panel"><div class="panel-head"><h2>Overview</h2></div><div class="panel-body"><div class="stat-strip"><div><div class="stat-strip-value">$1,775,058</div><div class="stat-strip-label">Cash</div></div><div><div class="stat-strip-value">1,340</div><div class="stat-strip-label">Construction Data</div></div><div><div class="stat-strip-value">11/11 MW</div><div class="stat-strip-label">Power</div></div></div></div></div>
<div class="panel"><div class="panel-head"><h2>Operations</h2></div><div class="panel-body" style="height:900px;color:var(--ink-2)">Game content</div></div></div>
</div></div>
<script>new ResizeObserver(([e]) => document.documentElement.style.setProperty('--chrome-h', Math.round(e.borderBoxSize[0].blockSize) + 'px')).observe(document.querySelector('.chrome'));</script>
</body></html>`;

const INIT = (data) => {
  class FakeWS {
    constructor() { this.readyState = 1; this.sent = []; this.l = []; }
    addEventListener(t, f) { if (t === 'message') this.l.push(f); }
    removeEventListener(t, f) { this.l = this.l.filter((x) => x !== f); }
    send(m) { this.sent.push(m); }
    emit(o) { for (const f of this.l) f({ data: JSON.stringify(o) }); }   // a server frame
  }
  window.WebSocket = FakeWS;
  // CD Farm's Auto mode starts itself when the engine needs CD: keep it off in the fake page unless a test turns it on.
  try { if (!localStorage.getItem('cdFarm.v1')) localStorage.setItem('cdFarm.v1', JSON.stringify({ cfg: { autoStart: false, pace: 'balanced' } })); } catch {}
  const ws = new FakeWS();
  window.__ws = ws;
  const st = { ssi: { corp_id: 1, last_user_mutation_tick: 0 }, items: { 0: 5000000, 24: 1200, 111: 0 }, stock: { 0: {} }, groups: {}, building_pool: { 0: {} }, next_group_id: 0, research: null, research_queue: [], unlocked_buildings: [], land_bought: { 0: 0 } };
  const fiber = { memoizedState: { memoizedState: { current: ws }, next: { memoizedState: st, next: { memoizedState: data.deals.filter((d) => d.region === 0), next: null } } }, memoizedProps: { catalog: data.catalog }, child: null, sibling: null };
  window.__st = st;
  window.__raf = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { window.__raf++; return raf(cb); };
  window.__fiber = fiber;
};

async function open(width = 1280, height = 800, motion = false, shell = false) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: motion ? 'no-preference' : 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(INIT, { catalog: board.catalog, deals: board.deals });
  await page.route('https://idlecorp.test/', (r) => r.fulfill({ contentType: 'text/html', body: shell ? SHELL_PAGE : PAGE }));
  await page.goto('https://idlecorp.test/');
  await page.evaluate(() => { document.getElementById('root').__reactContainer$x = window.__fiber; });
  return { browser, page, errors };
}


async function load(page) {
  await page.addScriptTag({ content: script });
  // attached, not visible: the game hides its sidebar below 900px (the tabs are still there for its mobile menu)
  for (const s of ['.egp-tab', '.cdf-tab', '.lab-tab']) await page.waitForSelector(s, { state: 'attached', timeout: 15000 });
}

let failed = 0;
let lastOk = Date.now();   // TEST_TIMES=1: milliseconds since the previous check, to find the slow ones
const ok = (cond, name, extra = '') => { if (!cond) failed++; const now = Date.now(); console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  ' + extra) + (process.env.TEST_TIMES ? '  [+' + (now - lastOk) + ' ms]' : '')); lastOk = now; };

// CD Farm Auto against a fake server (see below). Takes the page after load().
const count = (page, sel) => page.$$eval(sel, (e) => e.length);
// Wait for what the next check looks at, not for a guessed time. A timeout does not throw: the check after it reports the failure.
const until = (page, fn, arg, ms = 4000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 20 }).catch(() => {});

// CD Farm Auto: a fake server ... (see the comment inside); returns the helpers the Auto groups share.
async function autoSetup(page) {
  // CD Farm Auto: a fake server that charges the catalog price, gives CD, refunds half on demolish, sells land, and acknowledges
  // every command with a mutation Diff ~10 ms later (so round trips are measured). The page's own state is the game state.
  await page.evaluate(() => {
    const st = window.__st, ws = window.__ws, cat = window.__fiber.memoizedProps.catalog, B = Object.fromEntries(cat.buildings.map((b) => [b.id, b]));
    const sent = [];
    let tick = st.ssi.last_user_mutation_tick;
    const owned = (b) => (st.building_pool[0][b] ?? 0) + Object.values(st.groups).filter((g) => g.building === b).reduce((a, g) => a + g.count, 0);
    const price = (b, i) => Math.floor(B[b].cost * (20 + owned(b) + i) / 20);
    const orig = ws.send;
    const mode = { ackMs: 10, ignoreBuy: false, ignoreDemolishOnce: false, lateDemolishMs: 0, lateBuyMs: 0, priceMult: 1 };   // knobs for the failure tests
    ws.send = (m) => {
      const o = JSON.parse(m); sent.push(o);
      const pool = st.building_pool[0];
      if (o.type === 'BuyBuilding') {
        if (mode.ignoreBuy) return;
        const applyBuy = () => {
          let c = 0; for (let i = 0; i < o.amount; i++) c += price(o.building, i);
          st.items[0] -= Math.round(c * mode.priceMult); pool[o.building] = (pool[o.building] ?? 0) + o.amount; st.items[24] += o.amount * window.idleCore.planner.cdOf(cat, o.building);
        };
        if (mode.lateBuyMs) { const ms = mode.lateBuyMs; mode.lateBuyMs = 0; setTimeout(applyBuy, ms); return; }   // delivered after the client gave up
        applyBuy();
      } else if (o.type === 'DemolishBuilding') {
        if (mode.ignoreDemolishOnce) { mode.ignoreDemolishOnce = false; return; }
        const apply = () => { pool[o.building] = (pool[o.building] ?? 0) - o.amount; st.items[0] += Math.floor(B[o.building].cost / 2) * o.amount; };
        if (mode.lateDemolishMs) { const ms = mode.lateDemolishMs; mode.lateDemolishMs = 0; setTimeout(apply, ms); return; }   // applied after the client gave up
        apply();
      } else if (o.type === 'BuyLand') {
        for (let i = 0; i < o.amount; i++) { let p = 5000; for (let j = 0; j < st.land_bought[0]; j++) p = Math.floor(p * 41 / 40); st.items[0] -= p; st.land_bought[0]++; }
      }
      setTimeout(() => { tick += 4; st.ssi.last_user_mutation_tick = tick; ws.emit({ kind: 'Diff', diff: { ssi: { last_user_mutation_tick: tick } } }); }, mode.ackMs);
    };
    window.__fake = { sent, mode, restore: () => { ws.send = orig; } };
    window.cdFarm._setPacer(window.idleCore.pacer({ medianMs: { before: 3, step: 3, cycle: 3, poll: 10, reconnect: 10 }, minMs: 1, maxMs: 30, cmdsPerMin: 1e6, thinkP: 0 }));
    window.idleCore.tune.pollMs = 15;   // confirm polling: 100 ms by default, which would dominate a fake server that answers in 10 ms
  });
  const reset = (extra = '') => page.evaluate((x) => {
    const st = window.__st, cf = window.cdFarm;
    window.__fake.sent.length = 0;
    Object.assign(window.__fake.mode, { ackMs: 10, ignoreBuy: false, ignoreDemolishOnce: false, lateDemolishMs: 0, lateBuyMs: 0, priceMult: 1 });
    cf._hist.slopes = { money: 0, cd: 0 }; cf._waitMax(1200); cf._graceMs(2000);
    for (const k of Object.keys(cf._quarantine)) delete cf._quarantine[k];
    st.groups = {}; st.building_pool[0] = {}; st.items[0] = 5000000; st.items[24] = 1200; st.land_bought[0] = 0; st.stock[0] = {}; st.unlocked_buildings = [];
    Object.assign(cf.cfg, { building: 'auto', pace: 'fast', land: 'plan', targetCd: Infinity, reserveAcres: 0, autoStart: false, dryRun: false, timeoutMs: 8000 });
    cf.reset(); window.idleCore.ledger.clear();
    if (x) new Function('st', 'cf', x)(st, cf);
  }, extra);
  const logLines = () => page.evaluate(() => window.idleCore.ledger.list().map((e) => e.text ?? e.msg ?? JSON.stringify(e)));
  return { reset, logLines };
}

async function autoGroup1(page, { reset, logLines }) {
  // 1. a target: it builds and demolishes starter types only, ends exactly on the need, and says so
  await reset('cf.cfg.targetCd = 1212;');
  await page.evaluate(() => window.cdFarm.start({ by: 'test' }));
  let a1 = await page.evaluate(() => ({ sent: window.__fake.sent, pool: window.__st.building_pool[0], cd: window.__st.items[24], stats: { ...window.cdFarm.stats }, auto: window.cdFarm.cfg.autoStart }));
  ok(a1.sent.length > 0 && a1.sent.every((m) => ['BuyBuilding', 'DemolishBuilding'].includes(m.type) && [0, 10].includes(m.building)), 'Auto: only Lumber Camp / Farm buys and demolishes when nothing else is unlocked', JSON.stringify(a1.sent.slice(0, 4)));
  ok(a1.cd === 1212 && Object.values(a1.pool).every((n) => n === 0), 'Auto: stops exactly on the need and leaves nothing in the pool', JSON.stringify([a1.cd, a1.pool, await logLines()]));
  ok((await logLines()).some((t) => /no CD needed/.test(t)), 'Auto: the log says why it stopped (no CD needed)');
  ok(a1.stats.cycles >= 1 && Object.keys(a1.stats.byType).every((b) => [0, 10].includes(+b)), 'Auto: per-type stats are kept', JSON.stringify(a1.stats.byType));
  ok(await page.evaluate(() => window.idleCore.measure.get('rtt').n > 3 && window.idleCore.measure.get('rtt').median > 0), 'Auto: round trips are measured from send to the confirming Diff');

  // 2. a Mine unlocked with Wooden Frames in surplus and no running recipe using them: the Mine is the cheaper CD
  await reset('st.unlocked_buildings = [1]; st.stock[0] = { 41: 100 }; cf.cfg.targetCd = 1208;');
  await page.evaluate(() => window.cdFarm.start({ by: 'test' }));
  const a2 = await page.evaluate(() => window.__fake.sent.filter((m) => m.type === 'BuyBuilding'));
  ok(a2.length === 1 && a2[0].building === 1 && a2[0].amount === 1, 'Auto: picks the Mine (8 CD) when its Wooden Frames are in surplus', JSON.stringify(a2));

  // 3. items the economy uses are not free: once a running group eats Wooden Frames the Mine is not chosen, and the log says why
  const flip = await page.evaluate(() => {
    const st = window.__st, cf = window.cdFarm, cat = window.__fiber.memoizedProps.catalog;
    const rec = cat.recipes.find((r) => r.inputs.some((i) => i.item === 41));
    cf.cfg.targetCd = 1300;
    const before = cf.evaluate().plan.units[0]?.b;
    st.groups = { 1: { building: cat.buildings.find((b) => b.operations.some((o) => rec.op === o || true)).id, region: 0, count: 1, recipe: rec.id } };
    return { before, after: cf.evaluate().plan.units[0]?.b, rec: !!rec };
  });
  ok(flip.rec && flip.before === 1 && flip.after !== 1, 'Auto: a running group that eats Wooden Frames makes the Mine too dear', JSON.stringify(flip));
  ok((await logLines()).some((t) => /Wooden Frame is now worth/.test(t)), 'Auto: the log explains the change in item value');

  // 4. dry run sends nothing
  await reset('cf.cfg.targetCd = 1212;');
  await page.evaluate(() => window.cdFarm.start({ by: 'test', dryRun: true }));
  ok(await page.evaluate(() => window.__fake.sent.length) === 0 && (await logLines()).some((t) => /dry run: would build/.test(t)), 'Auto: a dry run logs the plan, sends nothing, and ends by itself');
  await reset('st.building_pool[0] = { 0: 25 }; cf.cfg.targetCd = 1203; cf._hist.slopes = { money: 5e7, cd: 0 };');
  await page.evaluate(() => window.cdFarm.start({ by: 'test', dryRun: true }));
  ok(await page.evaluate(() => window.__fake.sent.length === 0 && window.__st.land_bought[0] === 0), 'Auto: a dry run never buys land');

  // 5. no free acre: it buys land (inside Autopilot's land wall, income known) and then builds
  await reset('st.building_pool[0] = { 0: 25 }; cf.cfg.targetCd = 1203; cf._hist.slopes = { money: 5e7, cd: 0 }; cf._hist.at = Date.now() + 120000;');
  await page.evaluate(() => window.cdFarm.start({ by: 'test' }));
  const a5 = await page.evaluate(() => ({ sent: window.__fake.sent.map((m) => m.type), land: window.__st.land_bought[0], pool: window.__st.building_pool[0][0] }));
  ok(a5.sent[0] === 'BuyLand' && a5.land >= 1 && a5.sent.includes('BuyBuilding') && a5.pool === 25, 'Auto: with no free acre it buys land first, then builds, and the baseline camps stay', JSON.stringify(a5));
  await reset('st.building_pool[0] = { 0: 25 }; cf.cfg.targetCd = 1203; cf.cfg.land = "off"; cf._hist.slopes = { money: 5e7, cd: 0 }; cf._hist.at = Date.now() + 120000;');
  await page.evaluate(() => window.cdFarm.start({ by: 'test' }));
  ok(await page.evaluate(() => window.__fake.sent.length === 0 && window.__st.land_bought[0] === 0), 'Auto: Buy land = Off never buys land');

  // 6. pressing Stop on an Auto run switches Auto off; the controller starts it again when it is switched on
  await reset('cf.cfg.targetCd = 1260;');
  await page.evaluate(() => { setTimeout(() => window.cdFarm.stop(), 400); return window.cdFarm.start({ by: 'test' }); });
  ok(await page.evaluate(() => window.cdFarm.cfg.autoStart) === false, 'Auto: stopping a run switches Auto off');
  await reset('cf.cfg.targetCd = 1203; cf.cfg.autoStart = true; cf._skipWaits();');
  await page.waitForFunction(() => window.cdFarm.running || window.cdFarm.stats.cycles > 0, null, { timeout: 40000 });
  await page.waitForFunction(() => !window.cdFarm.running && !window.cdFarm.active, null, { timeout: 20000 });
  ok(await page.evaluate(() => window.__st.items[24] >= 1203), 'Auto: with Run by itself on, the controller starts a run when CD is needed');
}

async function autoGroup2(page, { reset, logLines }) {
  // 7. measurement: the round trip follows the server's latency (send to the confirming Diff, sub-millisecond clock)
  await reset('cf.cfg.targetCd = 1210; window.idleCore.measure.get("rtt").load({ values: [] }); window.__fake.mode.ackMs = 40;');
  await page.evaluate(() => window.cdFarm.start({ by: 'test' }));
  const rtt = await page.evaluate(() => ({ n: window.idleCore.measure.get('rtt').n, med: window.idleCore.measure.get('rtt').median, t: window.cdFarm.evaluate().t }));
  ok(rtt.n >= 5 && rtt.med > 38 && rtt.med < 52, 'Auto: with a 40 ms server the measured round trip is about 40 ms', JSON.stringify(rtt));

  // 8. a server that ignores Buy: three unconfirmed commands open the breaker; it cleans up, waits, and Stop is honoured
  await reset('cf.cfg.targetCd = 1260; cf.cfg.timeoutMs = 250; window.__fake.mode.ignoreBuy = true;');
  await page.evaluate(() => { window.__run = window.cdFarm.start({ by: 'test' }); });
  await page.waitForFunction(() => window.idleCore.ledger.list().some((e) => /unconfirmed commands in a row/.test(e.text ?? e.msg ?? '')), null, { timeout: 30000 });
  ok(await page.evaluate(() => Object.values(window.__st.building_pool[0]).every((n) => n === 0) && /breaker/.test(window.cdFarm._debug().phase)), 'Auto: three unconfirmed commands open the breaker, nothing is left in the pool');
  await page.evaluate(() => window.cdFarm.stop());
  await page.waitForFunction(() => !window.cdFarm.running && !window.cdFarm.active, null, { timeout: 20000 });

  // 9. prices that do not match the catalog: skip that type, a second mismatch stops with an error, and the pool is cleaned
  await reset('cf.cfg.targetCd = 1260; cf._graceMs(300); window.__fake.mode.priceMult = 2;');
  await page.evaluate(() => window.cdFarm.start({ by: 'test' }));
  if (process.env.TEST_TIMES) console.log(JSON.stringify(await page.evaluate(() => window.idleCore.ledger.list().map((e) => [e.t % 100000, e.text.slice(0, 70)]))));
  const a9 = await page.evaluate(() => ({ pool: window.__st.building_pool[0], log: window.idleCore.ledger.list().map((e) => e.text ?? e.msg ?? ''), last: window.__fake.sent.at(-1)?.type }));
  ok(a9.log.some((t) => /did not match the catalog twice/.test(t) || /stopped: error: prices or CD/.test(t)) && Object.values(a9.pool).every((n) => n === 0) && a9.last === 'DemolishBuilding', 'Auto: a second price mismatch stops the run with an error and takes the batch down', JSON.stringify(a9));

  // 10. a lost Demolish is retried once, nothing is left behind
  await reset('cf.cfg.targetCd = 1203; cf.cfg.timeoutMs = 300; cf._graceMs(300); window.__fake.mode.ignoreDemolishOnce = true;');
  await page.evaluate(() => window.cdFarm.start({ by: 'test' }));
  const a10 = await page.evaluate(() => ({ pool: window.__st.building_pool[0], types: window.__fake.sent.map((m) => m.type).join() }));
  ok(Object.values(a10.pool).every((n) => n === 0) && /DemolishBuilding,DemolishBuilding/.test(a10.types), 'Auto: a Demolish the server ignored is retried and the pool ends empty', JSON.stringify(a10));

  // 11. what Autopilot reserves for Auto: money floor, items, and the next unlock with its CD cost and readiness
  const rsv = await page.evaluate(() => window.earlyGame.reserve());
  ok(rsv && typeof rsv.moneyFloor === 'number' && typeof rsv.items === 'object' && rsv.nextTech?.b === 4 && rsv.nextTech.cd === 5 && rsv.nextTech.prereqsMet === false, 'Autopilot: reserve() names the next unlock (Sawmill, 5 CD) and that its prototype is missing', JSON.stringify(rsv));

  // 12. a Demolish the server applies after the client gave up: the retry must wait, then find nothing left to take
  await reset('st.building_pool[0] = { 0: 25 }; cf.cfg.targetCd = 1203; cf.cfg.timeoutMs = 300; cf._graceMs(500); window.__fake.mode.lateDemolishMs = 500;');
  await page.evaluate(() => window.cdFarm.start({ by: 'test' }));
  const a12 = await page.evaluate(() => ({ camps: window.__st.building_pool[0][0], dem: window.__fake.sent.filter((m) => m.type === 'DemolishBuilding').length, buys: window.__fake.sent.filter((m) => m.type === 'BuyBuilding').length }));
  ok(a12.camps === 25 && a12.dem === a12.buys, 'Auto: a late-applied Demolish is not retried on top of your own buildings', JSON.stringify(a12));
}

async function autoGroup3(page, { reset, logLines }) {
  // 13. every type quarantined: the controller does not start a run that can only spin
  await reset('cf.cfg.targetCd = 1260; cf.cfg.autoStart = true; cf._skipWaits(); cf._quarantine[0] = Date.now() + 1800000; cf._quarantine[10] = Date.now() + 1800000;');
  await page.evaluate(async () => { for (let i = 0; i < 3; i++) await window.cdFarm._tick(); });
  ok(await page.evaluate(() => !window.cdFarm.running && window.__fake.sent.length === 0), 'Auto: with every type quarantined the controller stays idle');

  // 14b. a Buy the server delivers after the timeout: it is found and demolished, and the user's own camps stay
  await reset('st.building_pool[0] = { 0: 25 }; cf.cfg.targetCd = 1260; cf.cfg.timeoutMs = 250; window.__fake.mode.lateBuyMs = 600;');
  await page.evaluate(() => { setTimeout(() => window.cdFarm.stop(), 2000); return window.cdFarm.start({ by: 'test' }); });
  const a14 = await page.evaluate(() => ({ camps: window.__st.building_pool[0][0], farms: window.__st.building_pool[0][10] ?? 0 }));
  ok(a14.camps === 25 && a14.farms === 0, 'Auto: a Buy delivered after the timeout is demolished, your own camps stay', JSON.stringify(a14));

  // 14. a late Buy: the unit that arrives after the timeout is taken down, not left in the pool
  await reset('cf.cfg.targetCd = 1260; cf.cfg.timeoutMs = 250; window.__fake.mode.ackMs = 600;');
  await page.evaluate(() => { setTimeout(() => window.cdFarm.stop(), 1500); return window.cdFarm.start({ by: 'test' }); });
  ok(await page.evaluate(() => Object.values(window.__st.building_pool[0]).every((n) => n === 0)), 'Auto: nothing is left in the pool after a stop with late replies');

  // 15. the default path: no Target CD, Autopilot live. The controller starts by itself on Autopilot's next-tech need,
  // holds Autopilot for the run, stops on the tech cost, and lets Autopilot go.
  await page.evaluate(() => {
    const e = window.earlyGame, orig = { busy: Object.getOwnPropertyDescriptor(e, 'busy'), reserve: e.reserve, hold: e.hold, release: e.release };
    window.__egOrig = orig; window.__holds = { hold: 0, release: 0 };
    Object.defineProperty(e, 'busy', { get: () => true, configurable: true });
    e.reserve = () => ({ moneyFloor: 0, items: {}, nextTech: { b: 4, name: 'Sawmill', cd: 1208, prereqsMet: true, note: '' }, phase: 'early' });
    e.hold = async (w) => { window.__holds.hold++; return orig.hold.call(e, w); };
    e.release = (w) => { window.__holds.release++; return orig.release.call(e, w); };
    return true;
  });
  await reset('cf.cfg.autoStart = true; cf._skipWaits();');
  await page.waitForFunction(() => window.__st.items[24] >= 1208 && !window.cdFarm.running && !window.cdFarm.active, null, { timeout: 60000 });
  const a15 = await page.evaluate(() => ({ cd: window.__st.items[24], pool: window.__st.building_pool[0], holds: window.__holds, log: window.idleCore.ledger.list().map((e) => e.text ?? e.msg ?? '') }));
  ok(a15.cd === 1208 && Object.values(a15.pool).every((n) => n === 0) && a15.holds.hold >= 1 && a15.holds.hold === a15.holds.release && a15.log.some((t) => /no CD needed/.test(t)), 'Auto: with Autopilot live and no Target CD it starts by itself, stops on the next tech cost, and releases Autopilot', JSON.stringify(a15));
  await page.evaluate(() => { const e = window.earlyGame, o = window.__egOrig; if (o.busy) Object.defineProperty(e, 'busy', o.busy); else delete e.busy; e.reserve = o.reserve; e.hold = o.hold; e.release = o.release; window.cdFarm.cfg.autoStart = false; });

  // 16. Autopilot as a dry run is not live: Auto stays idle
  await reset('cf.cfg.autoStart = true; cf._skipWaits();');
  await page.evaluate(async () => { for (let i = 0; i < 3; i++) await window.cdFarm._tick(); });
  ok(await page.evaluate(() => !window.cdFarm.running && window.__fake.sent.length === 0), 'Auto: with Autopilot not live (dry run) and no Target CD it sends nothing');

  await page.evaluate(() => { window.__fake.restore(); const st = window.__st; st.groups = {}; st.building_pool[0] = {}; st.items[0] = 5000000; st.items[24] = 1200; st.land_bought[0] = 0; st.stock[0] = {}; st.unlocked_buildings = []; Object.assign(window.cdFarm.cfg, { targetCd: Infinity, autoStart: false, pace: 'balanced', land: 'plan', reserveAcres: 10 }); window.cdFarm.reset(); window.cdFarm._waitMax(600000); });
}

// Helpers every main-page section uses.
function mainCtx(page) {
  return {
    q: (sel) => page.$(sel),
    attr: (sel, a) => page.$eval(sel, (e, a) => e.getAttribute(a), a),
    count: (sel) => page.$$eval(sel, (n) => n.length),
    visible: (sel) => page.$eval(sel, (e) => !!(e.offsetWidth || e.offsetHeight)),
    ui: (k) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), k),
  };
}


// ---- shards of check ---------------------------------------------------------------------------------
// Each shard is independent (own browser page, own fake game) so the runner can run them side by side.
async function sectionChrome(page, { q, attr, count, visible, ui }) {
  // chrome
  ok(await count('.egp-tab') === 1 && await count('.cdf-tab') === 1 && await count('.lab-tab') === 1 && await count('.egp-chip') === 1 && await count('.cdf-chip') === 1 && await count('.lab-chip') === 1, 'sidebar tabs and top-bar chips mounted once each');
  const navOrder = (await page.$$eval('.primary-navigation .page-tab', (n) => n.map((e) => (e.querySelector('.nav-text') || e).textContent.trim().split(/\s/)[0]))).join();
  ok(navOrder === 'Corp,Market,Autopilot,CD,Lab', 'Autopilot tab sits above CD Farm tab, Lab tab below it', navOrder);
  const chipOrder = (await page.$$eval('.topbar-tools > *', (n) => n.map((e) => e.className.split(' ').find((c) => /^(egp|cdf|lab)-chip$|^tip-anchor$/.test(c)) || '?'))).join();
  ok(chipOrder === 'egp-chip,cdf-chip,lab-chip,tip-anchor', 'top-bar chips: Autopilot, CD Farm, Lab, then the game\'s own', chipOrder);

  // React re-renders the sidebar and top bar inside #root: the tab and chip must come back, once each, with the right label
  await page.evaluate(() => { document.querySelector('.egp-tab').remove(); document.querySelector('.cdf-chip').remove(); });
  await until(page, () => document.querySelectorAll('.egp-tab').length === 1 && document.querySelectorAll('.cdf-chip').length === 1);
  ok(await count('.egp-tab') === 1 && await count('.cdf-chip') === 1, 'removed sidebar tab and chip are re-inserted exactly once');
  ok((await page.$eval('.cdf-chip', (e) => e.textContent.trim())).endsWith('CD'), 'and come back already showing their current text');

  // No repaint loop: with a quiet page the chrome must not keep scheduling frames (the observer must not trigger itself)
  await page.waitForTimeout(300);
  const raf0 = await page.evaluate(() => window.__raf);
  await page.waitForTimeout(700);
  const raf1 = await page.evaluate(() => window.__raf);
  ok(raf1 - raf0 < 12, 'chrome does not re-trigger its own MutationObserver (frames requested in 0.7 s: a loop asks for ~40)', String(raf1 - raf0));

  // Autopilot opens by default: start from both closed
  ok(await count('.egp-panel') === 1 && await count('.cdf-panel') === 0, 'Autopilot opens by default, CD Farm does not');
  await page.evaluate(() => window.earlyGame.panel(false));

  // open via chip: focus moves in, aria-expanded flips
  await page.click('.egp-chip');
  ok(await visible('.egp-panel'), 'chip opens the Autopilot panel');
  ok(await page.evaluate(() => document.activeElement === document.querySelector('.egp-panel')), 'focus moves into the panel on open');
  ok(await attr('.egp-chip', 'aria-expanded') === 'true' && await attr('.egp-tab', 'aria-expanded') === 'true', 'chip and tab report expanded');

  // tabs: roles, keyboard
  ok(await count('.egp-panel [role=tab]') === 3 && await count('.egp-panel [role=tabpanel]') === 3, 'three tabs with tabpanels');
  await page.focus('.egp-panel .idc-tabbtn[aria-selected=true]');
  await page.keyboard.press('ArrowRight');
  ok(await attr('.egp-panel [id$="-t-settings"]', 'aria-selected') === 'true' && await visible('.egp-panel [id$="-p-settings"]') && !(await visible('.egp-panel [id$="-p-status"]')), 'ArrowRight moves to Settings and shows its pane');
  await page.keyboard.press('End');
  ok(await attr('.egp-panel [id$="-t-log"]', 'aria-selected') === 'true', 'End goes to the last tab');
  await page.keyboard.press('Home');
  ok(await attr('.egp-panel [id$="-t-status"]', 'aria-selected') === 'true', 'Home goes to the first tab');
  ok((await ui('earlyGame.ui')).tab === 'status', 'tab choice is saved');

  // sticky footer: the main button stays inside the viewport with Settings open and the body scrolled
  await page.click('.egp-panel [id$="-t-settings"]');
  await page.$eval('.egp-panel .idc-scroll', (e) => { e.scrollTop = e.scrollHeight; });
  const r = await page.evaluate(() => { const b = document.querySelector('.egp-panel .idc-foot .primary').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight }; });
  ok(r.top >= 0 && r.bottom <= r.h, 'Start button visible while Settings is scrolled to the end', JSON.stringify(r));

  // modified indicator + per-field reset + tab badge
  await page.fill('.egp-panel .idc-field input[aria-label="Sawmills (at least)"]', '9');
  ok(await count('.egp-panel .idc-rst:not([hidden])') === 1, 'changed field shows a reset button');
  ok(await page.$eval('.egp-panel [id$="-t-settings"] .idc-tabdot', (e) => !e.hidden), 'Settings tab shows a changed-settings dot');
  await page.click('.egp-panel .idc-field .idc-rst:not([hidden])');
  ok(await count('.egp-panel .idc-rst:not([hidden])') === 0, 'field reset puts it back to the default');
  ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Sawmills (at least)'), 'focus moves to the field when its reset button hides');
  ok(await page.$eval('.egp-panel [id$="-t-settings"] .idc-tabdot', (e) => e.hidden), 'dot clears once everything is default');

  // reset settings: two-step + undo toast
  await page.fill('.egp-panel .idc-field input[aria-label="Sawmills (at least)"]', '11');
  await page.click('.egp-panel [id$="-t-settings"]');
  const resetBtn = '.egp-panel [id$="-p-settings"] button.danger';
  await page.click(resetBtn);
  ok(await page.$eval(resetBtn, (e) => e.classList.contains('armed')), 'Reset settings arms on the first click');
  ok(await page.evaluate(() => window.earlyGame.cfg.sawmills) === 11, 'first click changes nothing');
  await page.click(resetBtn);
  const afterReset = await page.evaluate(() => window.earlyGame.cfg.sawmills);
  ok(afterReset !== 11, 'second click resets settings', String(afterReset));
  ok(await count('.idc-toast') === 1 && await visible('.idc-toast button'), 'reset toast offers Undo');
  await page.click('.idc-toast button');
  ok(await page.evaluate(() => window.earlyGame.cfg.sawmills) === 11, 'Undo brings the settings back');
  await page.evaluate(() => window.earlyGame.resetCfg());

  // segmented control: roving tabindex + arrows
  await page.click('.egp-panel [id$="-t-settings"]');
  await page.focus('.egp-panel .idc-foot .idc-seg button[aria-checked=true]');
  ok(await page.$$eval('.egp-panel .idc-foot .idc-seg button', (b) => b.map((x) => x.tabIndex).join()) === '0,-1', 'seg has a single tab stop');

  // log tab: filter + clear with undo
  await page.evaluate(() => { const L = window.idleCore.ledger; L.add('AP', 'action', 'built a thing'); L.add('AP', 'fail', 'it broke'); L.add('CD', 'alert', 'heads up'); });
  await page.click('.egp-panel [id$="-t-log"]');
  await until(page, () => document.querySelectorAll('.egp-panel .idc-ll').length === 3);
  ok(await count('.egp-panel .idc-ll') === 3, 'log shows the ledger lines');
  await page.click('.egp-panel .idc-quicks button:has-text("Problems")');
  ok(await count('.egp-panel .idc-ll') === 2 && await count('.egp-panel .idc-ll.k-fail') === 1, 'Problems filter keeps fail + alert only');
  await page.click('.egp-panel .idc-quicks button:has-text("Actions")');
  ok(await count('.egp-panel .idc-ll') === 1, 'Actions filter keeps actions only');
  await page.click('.egp-panel .idc-quicks button:has-text("All")');
  await page.click('.egp-panel button:has-text("Clear log")');
  ok(await count('.egp-panel .idc-ll') === 0, 'Clear log empties the view');
  await page.click('.idc-toast:last-child button');
  await until(page, () => document.querySelectorAll('.egp-panel .idc-ll').length === 3);
  ok(await count('.egp-panel .idc-ll') === 3, 'Undo restores the log');

  // log DOM is left alone when nothing new arrived (selection survives), and Undo keeps lines logged meanwhile
  await page.evaluate(() => { window.__row = document.querySelector('.egp-panel .idc-ll'); });
  await page.waitForTimeout(1100);   // one render tick (1 s) must pass for this to mean anything
  ok(await page.evaluate(() => window.__row === document.querySelector('.egp-panel .idc-ll')), 'log rows are not rebuilt while nothing new is logged');
  ok(await page.evaluate(() => !document.querySelector('.egp-panel [role=log]')), 'log list is not a live region');
  await page.click('.egp-panel button:has-text("Clear log")');
  await page.evaluate(() => window.idleCore.ledger.add('AP', 'info', 'logged during the undo window'));
  await page.click('.idc-toast:last-child button');
  await until(page, () => document.querySelectorAll('.egp-panel .idc-ll').length === 4);
  ok(await count('.egp-panel .idc-ll') === 4, 'Undo of Clear log keeps lines logged in between', String(await count('.egp-panel .idc-ll')));

  // unseen-problem dot on the Log tab while another tab is showing
  await page.click('.egp-panel [id$="-t-status"]');
  await page.evaluate(() => window.idleCore.ledger.add('AP', 'fail', 'new failure'));
  await until(page, () => { const d = document.querySelector('.egp-panel [id$="-t-log"] .idc-tabdot'); return d && !d.hidden; });
  ok(await page.$eval('.egp-panel [id$="-t-log"] .idc-tabdot', (e) => !e.hidden), 'Log tab flags a new problem');
  await page.click('.egp-panel [id$="-t-log"]'); await until(page, () => document.querySelector('.egp-panel [id$="-t-log"] .idc-tabdot')?.hidden);
  ok(await page.$eval('.egp-panel [id$="-t-log"] .idc-tabdot', (e) => e.hidden), 'and clears it once viewed');

  // toasts stack to 3
  await page.evaluate(() => { for (let i = 0; i < 5; i++) window.idleCore.toast('t' + i, i % 2 ? 'error' : 'success'); });
  ok(await count('.idc-toast') === 3, 'at most 3 toasts at once');

  // chip on a minimized panel expands it (does not close it)
  await page.click('.egp-panel button[aria-label="Minimize"]');
  await page.click('.egp-chip');
  ok(await visible('.egp-panel .idc-scroll') && await count('.egp-panel') === 1, 'chip click on a minimized panel expands it');

  // minimize / expand, persisted
  await page.click('.egp-panel button[aria-label="Minimize"]');
  ok(!(await visible('.egp-panel .idc-scroll')) && !(await visible('.egp-panel .idc-foot')) && (await ui('earlyGame.ui')).min === true, 'minimize hides body + footer and is saved');
  await page.dblclick('.egp-panel .idc-title');
  ok(await visible('.egp-panel .idc-scroll') && (await ui('earlyGame.ui')).min === false, 'double-clicking the header expands again');

  // drag: moves, is saved, stays on screen
  const hb = await (await q('.egp-panel .idc-head')).boundingBox();
  await page.mouse.move(hb.x + 40, hb.y + 12); await page.mouse.down(); await page.mouse.move(hb.x + 240, hb.y - 60, { steps: 5 }); await page.mouse.up();
  const u1 = await ui('earlyGame.ui');
  ok(u1.x != null && Math.abs(u1.x - (hb.x + 200)) < 4, 'dragging the header moves the panel and saves x/y', JSON.stringify(u1));
  const pb = await (await q('.egp-panel')).boundingBox();
  ok(pb.y >= 0 && pb.y + pb.height <= 800, 'dragged panel stays inside the viewport (max-height follows y)', JSON.stringify(pb));
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('earlyGame.ui')); s.x = null; s.y = null; localStorage.setItem('earlyGame.ui', JSON.stringify(s)); });

  // dragged low: header, tabs and footer still fit on screen
  await page.evaluate(() => {});
  const hb2 = await (await q('.egp-panel .idc-head')).boundingBox();
  await page.mouse.move(hb2.x + 40, hb2.y + 12); await page.mouse.down(); await page.mouse.move(hb2.x + 40, 760, { steps: 4 }); await page.mouse.up();
  const lowFoot = await page.evaluate(() => { const b = document.querySelector('.egp-panel .idc-foot .primary').getBoundingClientRect(); return { bottom: b.bottom, h: innerHeight }; });
  ok(lowFoot.bottom <= lowFoot.h, 'dragging the panel to the bottom still leaves the Start button on screen', JSON.stringify(lowFoot));
  await page.evaluate(() => {});

  // Escape closes (not while typing), focus returns
  await page.click('.egp-panel [id$="-t-settings"]');
  await page.focus('.egp-panel input[aria-label="Sawmills (at least)"]');
  await page.keyboard.press('Escape');
  ok(await visible('.egp-panel'), 'Escape inside a field only leaves the field');
  await page.focus('.egp-panel .idc-tabbtn[aria-selected=true]');
  await page.keyboard.press('Escape');
  ok(await count('.egp-panel') === 0, 'Escape closes the panel');
  ok(await page.evaluate(() => document.activeElement === document.querySelector('.egp-chip')), 'focus returns to the chip');
  ok(await attr('.egp-chip', 'aria-expanded') === 'false', 'chip reports collapsed');

  // dry run start/stop through the footer button; pill appears
  await page.click('.egp-chip');
  await page.click('.egp-panel .idc-foot .primary');
  await until(page, () => window.earlyGame.running && document.querySelector('.egp-tab .idc-pill'));
  ok(await page.evaluate(() => window.earlyGame.running), 'Start dry run starts');
  ok(await visible('.egp-tab .idc-pill'), 'sidebar pill shows while running');
  await page.click('.egp-panel .idc-foot .primary');
  await until(page, () => !window.earlyGame.running);
  ok(!(await page.evaluate(() => window.earlyGame.running)), 'Stop stops');
}

async function sectionCdFarm(page, { q, attr, count, visible, ui }) {
  // CD Farm: modified + reset, advanced persisted
  await page.click('.cdf-chip');
  await page.click('.cdf-panel [id$="-t-settings"]');
  ok(await visible('.cdf-panel input[aria-label="Extra money floor"]') && !(await visible('.cdf-panel input[aria-label="Money floor"]')), 'CD Farm: Auto is the default and shows the Auto settings, not the budget modes');
  await page.click('.cdf-panel .idc-seg button:has-text("Lumber Camp")');
  ok(await page.evaluate(() => window.cdFarm.cfg.building) === 0, 'CD Farm: Building seg picks Lumber Camp');
  await page.fill('.cdf-panel input[aria-label="Money floor"]', '75k');
  const floorRst = '.cdf-panel .idc-field:has(input[aria-label="Money floor"]) .idc-rst:not([hidden])';
  ok(await count(floorRst) === 1, 'CD Farm: changed floor shows a reset button');
  await page.click(floorRst);
  ok(await page.evaluate(() => window.cdFarm.cfg.minMoney) === 30000, 'CD Farm: reset restores the default floor');
  await page.click('.cdf-panel .idc-seg button:has-text("Income only")');
  ok(await page.evaluate(() => window.cdFarm.cfg.budget) === 'income', 'CD Farm: seg picks a budget mode');
  await page.focus('.cdf-panel .idc-seg:has(button:has-text("Income only")) button[aria-checked=true]');
  await page.keyboard.press('ArrowRight');
  ok(await page.evaluate(() => window.cdFarm.cfg.budget) === 'reserve', 'CD Farm: arrow key moves the seg');
  await page.evaluate(() => { window.cdFarm.cfg.budget = 'reserve'; });
  await page.click('.cdf-panel .idc-seg button:has-text("Farm")');
  ok(await page.evaluate(() => window.cdFarm.cfg.building === 10 && window.cdFarm.building === 10), 'CD Farm: Building seg picks Farm');
  ok(await count('.cdf-panel .idc-rst:not([hidden])') === 1, 'CD Farm: a changed building shows a reset button');
  ok((await page.$eval('.cdf-panel', (e) => e.textContent)).includes('Builds up to 10 farms'), 'CD Farm: the plan names the chosen building');
  await page.click('.cdf-panel .idc-field .idc-rst:not([hidden])');
  ok(await page.evaluate(() => window.cdFarm.cfg.building) === 'auto', 'CD Farm: reset restores Auto');
  await page.evaluate(() => window.cdFarm.panel(false)); // the taller panel would sit over the Lab chip

  // CD Farm engine: with Building = Farm it buys and demolishes Farms only, on the Farm's own price curve.
  const farm = await page.evaluate(async () => {
    const st = window.__st, ws = window.__ws, cf = window.cdFarm, sent = [], orig = ws.send, keep = { ...cf.cfg };
    st.groups = { 1: { building: 10, region: 0, count: 4, recipe: 0 } };   // 4 Farms at work: they raise the price of the next one
    st.items[0] = 5000000; st.building_pool[0] = { 0: 2 };                 // and 2 idle Lumber Camps the run must not touch
    ws.send = (m) => {
      const o = JSON.parse(m); sent.push(o);
      const pool = st.building_pool[o.region];
      if (o.type === 'BuyBuilding') { pool[o.building] = (pool[o.building] ?? 0) + o.amount; st.items[24] += o.amount; }
      if (o.type === 'DemolishBuilding') pool[o.building] = (pool[o.building] ?? 0) - o.amount;
      st.ssi.last_user_mutation_tick += 4;
    };
    cf._setPacer(window.idleCore.pacer({ medianMs: { before: 3, step: 3, cycle: 3, poll: 10, reconnect: 10 }, minMs: 1, maxMs: 30, cmdsPerMin: 1e6, thinkP: 0 }));
    await cf.start({ building: 10, batch: 3, cycles: 2, fullBatch: true, budget: 'floor', minMoney: 1000, reserveAcres: 0 });
    ws.send = orig;
    const out = { sent, stats: { ...cf.stats }, pool: { ...st.building_pool[0] }, runBuilding: cf.stats.building };
    Object.assign(cf.cfg, keep); cf.cfg.cycles = Infinity; cf.cfg.maxSpend = Infinity;
    out.cfgBuilding = cf.cfg.building;
    st.groups = {}; st.building_pool[0] = {}; st.items[24] = 1200;
    cf.reset();
    return out;
  });
  ok(farm.sent.length === 4 && farm.sent.every((m) => m.building === 10), 'CD Farm: Building = Farm sends only Farm (id 10) buys and demolishes', JSON.stringify(farm.sent));
  ok(farm.sent.map((m) => m.type).join() === 'BuyBuilding,DemolishBuilding,BuyBuilding,DemolishBuilding', 'CD Farm: each cycle buys a batch, then demolishes it', farm.sent.map((m) => m.type).join());
  ok(farm.pool[10] === 0 && farm.pool[0] === 2, 'CD Farm: the Farm batch is gone and the idle Lumber Camps were left alone', JSON.stringify(farm.pool));
  ok(Math.abs(farm.stats.spent - 2 * 41 * (24 + 25 + 26) / 20) < 0.01, 'CD Farm: price follows the Farms owned (4 at work), not the camps', String(farm.stats.spent));
  ok(farm.runBuilding === 10 && farm.cfgBuilding === 'auto', 'CD Farm: the run kept its building; the setting is back to Auto afterwards', JSON.stringify([farm.runBuilding, farm.cfgBuilding]));
}

async function sectionLab(page, { q, attr, count, visible, ui }) {
  // Lab runner: panel, status, settings, custom list editor, dry run / live start. The game is fake: nothing leaves this page.
  ok(await page.evaluate(() => window.labRunner.cfg.dryRun === true && !window.labRunner.running) && await count('.lab-panel') === 0, 'Lab: starts as a dry run, not running, panel closed');
  await page.evaluate(() => {   // a Heartland Lab; groups making Planks, Iron Frame and Wood; 36,000 MD, 3 RD
    const st = window.__st;
    st.items[25] = 36000; st.items[26] = 3; st.building_pool[0][14] = 1;
    st.groups = { 1: { building: 4, region: 0, count: 2, recipe: 8 }, 2: { building: 8, region: 0, count: 1, recipe: 38 }, 3: { building: 0, region: 0, count: 5, recipe: 0 } };
    st.mfg_research = {}; st.pending_results = [];
  });
  await page.click('.lab-chip');
  ok(await visible('.lab-panel') && await count('.lab-panel [role=tab]') === 3 && await count('.lab-panel [role=tabpanel]') === 3, 'Lab: the chip opens a panel with three tabs');
  ok(await attr('.lab-chip', 'aria-expanded') === 'true' && await attr('.lab-tab', 'aria-expanded') === 'true', 'Lab: chip and tab report expanded');
  await until(page, () => document.querySelectorAll('.lab-panel [id$="-p-status"] .idc-row').length > 2);
  const rowsOf = () => page.$$eval('.lab-panel [id$="-p-status"] .idc-row', (r) => r.map((e) => e.textContent));
  let rows = await rowsOf();
  ok((await page.$eval('.lab-chip', (e) => e.textContent.trim())) === 'Lab 0/1' && (await page.$eval('.lab-panel .idc-big', (e) => e.textContent)) === '0 of 1', 'Lab: chip and hero count busy Labs');
  ok(rows.some((t) => t === 'Heartlandready: Iron Frame · Process study · Tier I'), 'Lab: Status shows the free Heartland Lab and the project it would start', JSON.stringify(rows));
  ok(rows.includes('MD36,000 · keeps 5,000') && rows.includes('RD3') && rows.includes('Results waiting0'), 'Lab: Status shows MD, RD and waiting results', JSON.stringify(rows));
  ok((await page.$eval('.lab-panel .idc-badge', (e) => e.textContent)) === 'Dry run', 'Lab: header badge says Dry run');
  await page.evaluate(() => { window.__st.mfg_research = { 0: { product: 9, context: 0, tier: 0, remaining: 3840 } }; window.__st.pending_results = [{ tick: 5, product: 41, context: 1, tier: 1, reward: 'x' }]; });
  await until(page, () => [...document.querySelectorAll('.lab-panel [id$="-p-status"] .idc-row')].some((e) => /32m left/.test(e.textContent)));
  rows = await rowsOf();
  ok(rows.includes('HeartlandPlanks · Process study · Tier I · 32m left') && rows.includes('Results waiting1') && (await page.$eval('.lab-panel .idc-big', (e) => e.textContent)) === '1 of 1', 'Lab: a running project shows product, focus, tier and time left', JSON.stringify(rows));
  await page.evaluate(() => { window.__st.mfg_research = {}; window.__st.pending_results = []; });

  await page.click('.lab-panel [id$="-t-settings"]');
  ok(await count('.lab-panel [id$="-p-settings"] .idc-seg') === 2, 'Lab: focus and tier segmented controls');
  ok(!(await page.isVisible('.lab-panel h4:has-text("Custom list")')), 'Lab: the list editor stays hidden until Custom list is picked');
  await page.click('.lab-panel .idc-seg button:has-text("Custom list")');
  ok((await page.evaluate(() => window.labRunner.cfg.mode)) === 'list' && await page.isVisible('.lab-panel h4:has-text("Custom list")'), 'Lab: Custom list shows the list editor');
  await page.click('.lab-panel button:has-text("Add entry")');
  await page.click('.lab-panel button:has-text("Add entry")');
  const l1 = await page.evaluate(() => window.labRunner.cfg.list);
  ok(await count('.lab-panel .idc-lrow') === 2 && l1.length === 2 && l1[0].product === 42 && l1[0].focus === 0 && l1[0].tier === 'default', 'Lab: Add entry appends the dearest product the groups make, Process study, default tier', JSON.stringify(l1));
  await page.evaluate(() => { window.__sel = document.querySelector('.lab-panel select[aria-label="Focus, entry 2"]'); });
  await page.selectOption('.lab-panel select[aria-label="Focus, entry 2"]', '2');
  await page.selectOption('.lab-panel select[aria-label="Tier, entry 2"]', '3');
  await page.selectOption('.lab-panel select[aria-label="Product, entry 2"]', { label: 'Planks' });
  await page.waitForTimeout(1100);   // one render tick (1 s): the next check is that it did not rebuild the select under you
  const l2 = await page.evaluate(() => window.labRunner.cfg.list);
  ok(JSON.stringify(l2[1]) === JSON.stringify({ product: 9, focus: 2, tier: 3 }) && JSON.stringify(l2[0]) === JSON.stringify(l1[0]), 'Lab: each row\'s selects edit that entry only', JSON.stringify(l2));
  ok(await page.evaluate(() => window.__sel === document.querySelector('.lab-panel select[aria-label="Focus, entry 2"]')), 'Lab: rows are not rebuilt while you choose in a select');
  await page.click('.lab-panel .idc-lrow:nth-child(2) button[aria-label="Move up"]');
  ok(await page.evaluate(() => window.labRunner.cfg.list.map((e) => e.product).join()) === '9,42', 'Lab: Move up swaps the entries');
  ok(await page.evaluate(() => { const a = document.activeElement; return !!a.closest('.lab-panel') && a !== document.querySelector('.lab-panel') && a.tagName !== 'BODY'; }), 'Lab: focus stays in the list after a move');
  await page.click('.lab-panel .idc-lrow:nth-child(1) button[aria-label="Remove entry"]');
  ok(await page.evaluate(() => window.labRunner.cfg.list.map((e) => e.product).join()) === '42' && await count('.lab-panel .idc-lrow') === 1, 'Lab: Remove entry drops that entry');
  await page.click('.lab-panel .idc-seg button:has-text("Process study")');
  ok(!(await page.isVisible('.lab-panel h4:has-text("Custom list")')) && (await page.evaluate(() => window.labRunner.cfg.list.length)) === 1, 'Lab: leaving list mode hides the editor and keeps the list');

  const reserve = '.lab-panel input[aria-label="MD reserve"]';
  await page.fill(reserve, '10k');
  ok(await page.evaluate(() => window.labRunner.cfg.mdReserve) === 10000 && await count('.lab-panel .idc-field:has(input[aria-label="MD reserve"]) .idc-rst:not([hidden])') === 1, 'Lab: MD reserve takes 10k and shows its reset button');
  await page.fill(reserve, 'lots');
  ok(await count('.lab-panel .idc-inp.bad') === 1 && await page.evaluate(() => window.labRunner.cfg.mdReserve) === 10000, 'Lab: a bad reserve is flagged and not applied');
  await page.keyboard.press('Escape');
  ok(await count('.lab-panel') === 1 && await count('.lab-panel .idc-inp.bad') === 0, 'Lab: Escape in the field reverts it and leaves the panel open');
  await page.click('.lab-panel .idc-field:has(input[aria-label="MD reserve"]) .idc-rst');
  ok(await page.evaluate(() => window.labRunner.cfg.mdReserve) === 5000, 'Lab: reset puts the reserve back to 5,000');
  await page.click('.lab-panel .idc-seg button:text-is("III")');
  ok(await page.evaluate(() => window.labRunner.cfg.tierMode) === 3 && /Tier III only/.test(await page.$eval('.lab-panel [id$="-p-settings"]', (e) => e.textContent)), 'Lab: the tier seg picks Tier III and explains it');
  await page.click('.lab-panel .idc-seg button:text-is("I")');
  ok(await page.evaluate(() => window.labRunner.cfg.tierMode) === 1, 'Lab: the tier seg picks Tier I');
  ok(await page.$eval('.lab-panel [id$="-t-settings"] .idc-tabdot', (e) => !e.hidden), 'Lab: Settings tab shows a changed-settings dot');

  // dry run vs live: the footer button, the confirm step, what is sent
  const main = '.lab-panel .idc-foot .primary';
  ok(await page.isChecked('.lab-panel .idc-check:has-text("Dry run") input') && (await page.$eval(main, (e) => e.textContent)) === 'Start dry run', 'Lab: Dry run is ticked and the footer offers Start dry run');
  await page.uncheck('.lab-panel .idc-check:has-text("Dry run") input');
  ok(await page.evaluate(() => window.labRunner.cfg.dryRun) === false && (await page.$eval('.lab-panel .idc-badge', (e) => e.textContent)) === 'Live' && (await page.$eval(main, (e) => e.textContent)) === 'Start live', 'Lab: unticking Dry run switches to Live: badge and button say so');
  await page.click(main);
  ok((await page.$eval(main, (e) => e.textContent)) === 'Confirm start' && !(await page.evaluate(() => window.labRunner.running)), 'Lab: Live needs a second click');
  await page.click('.lab-panel .idc-foot button:has-text("Cancel")');
  ok((await page.$eval(main, (e) => e.textContent)) === 'Start live' && !(await page.evaluate(() => window.labRunner.running)), 'Lab: Cancel backs out');
  await page.evaluate(() => { window.labRunner.cfg.timeoutMs = 500; });
  await page.click(main); await page.click(main);
  await page.waitForFunction(() => window.__ws.sent.length >= 1, null, { timeout: 5000 });
  const sent = await page.evaluate(() => window.__ws.sent.map((s) => JSON.parse(s)));
  ok(JSON.stringify(sent[0]) === JSON.stringify({ type: 'StartResearch', product: 42, context: 0, tier: 0, region: 0 }), 'Lab: Live sends StartResearch for the dearest produced product, Tier I, Heartland', JSON.stringify(sent));
  ok(sent.every((m) => m.type === 'StartResearch' || m.type === 'ClaimResearch'), 'Lab: only StartResearch / ClaimResearch go out', JSON.stringify(sent));
  ok(await page.evaluate(() => window.labRunner.running) && await visible('.lab-tab .idc-pill') && (await page.$eval('.lab-tab .idc-pill', (e) => e.textContent)) === 'Live', 'Lab: running live: sidebar pill says Live');
  ok(await page.$eval('.lab-panel fieldset.idc-form', (e) => e.disabled) && await visible('.lab-panel .idc-lock'), 'Lab: settings lock during a live run');
  await page.click(main);
  await page.waitForFunction(() => !window.labRunner.active, null, { timeout: 5000 });
  ok(!(await page.evaluate(() => window.labRunner.running)) && (await page.$eval(main, (e) => e.textContent)) === 'Start live', 'Lab: Stop stops');
  await page.check('.lab-panel .idc-check:has-text("Dry run") input');
  const before = await page.evaluate(() => window.__ws.sent.length);
  await page.click(main);
  await until(page, () => window.labRunner.running && document.querySelector('.lab-tab .idc-pill')?.textContent === 'Dry run');
  await page.waitForTimeout(150);   // a dry run that sent something would have by now
  ok(await page.evaluate(() => window.labRunner.running) && (await page.$eval('.lab-tab .idc-pill', (e) => e.textContent)) === 'Dry run' && (await page.evaluate(() => window.__ws.sent.length)) === before, 'Lab: a dry run runs and sends nothing');
  await page.click('.lab-panel [id$="-t-log"]');
  await page.evaluate(() => window.idleCore.ledger.add('CD', 'action', 'a farm line, not the Lab\'s'));
  await until(page, () => [...document.querySelectorAll('.lab-panel .idc-ll')].some((e) => /started \(live\)/.test(e.textContent)));
  const lines = await page.$$eval('.lab-panel .idc-ll', (r) => r.map((e) => [e.querySelector('.idc-tag').textContent, e.textContent]));
  ok(lines.length > 0 && lines.every(([tag]) => tag === 'LAB') && lines.some(([, t]) => /would send/.test(t)) && lines.some(([, t]) => /started \(live\)/.test(t)), 'Lab: the Log tab shows Lab lines only, dry-run and live', JSON.stringify(lines));
  await page.click(main);
  await page.waitForFunction(() => !window.labRunner.active, null, { timeout: 5000 });

  // Reset settings (two-step, with Undo) and Escape
  await page.click('.lab-panel [id$="-t-settings"]');
  await page.evaluate(() => { window.labRunner.cfg.mdReserve = 7777; });
  await page.waitForTimeout(1100);   // one render tick (1 s) shows the new value in the panel
  const labReset = '.lab-panel [id$="-p-settings"] button.danger';
  await page.click(labReset);
  ok(await page.$eval(labReset, (e) => e.classList.contains('armed')) && (await page.evaluate(() => window.labRunner.cfg.mdReserve)) === 7777, 'Lab: Reset settings arms on the first click');
  await page.click(labReset);
  ok((await page.evaluate(() => window.labRunner.cfg.mdReserve)) === 5000 && (await page.evaluate(() => window.labRunner.cfg.list.length)) === 0, 'Lab: second click resets the settings, list included');
  await page.click('.idc-toast:last-child button');
  ok((await page.evaluate(() => window.labRunner.cfg.mdReserve)) === 7777 && (await page.evaluate(() => window.labRunner.cfg.list.length)) === 1, 'Lab: Undo brings the settings and the list back');
  await page.evaluate(() => window.labRunner.resetCfg());
  await page.focus('.lab-panel .idc-tabbtn[aria-selected=true]');
  await page.keyboard.press('Escape');
  ok(await count('.lab-panel') === 0 && await page.evaluate(() => document.activeElement === document.querySelector('.lab-chip')), 'Lab: Escape closes the panel and focus returns to the chip');
}

async function sectionNarrow() {
  // header chips switch menus: opening a panel closes the other panels; clicking the open one closes it
  {
    const n = await open(760, 700);
    await load(n.page);
    await n.page.evaluate(() => window.earlyGame.panel(false));
    const openPanels = () => n.page.$$eval('.idc-panel', (p) => p.map((e) => e.classList.contains('egp-panel') ? 'egp' : e.classList.contains('cdf-panel') ? 'cdf' : 'lab'));
    await n.page.click('.egp-chip'); await n.page.click('.cdf-chip');
    ok(JSON.stringify(await openPanels()) === '["cdf"]', 'chip click switches: opening CD Farm closes Autopilot', JSON.stringify(await openPanels()));
    await n.page.click('.lab-chip');
    ok(JSON.stringify(await openPanels()) === '["lab"]', 'chip click switches: opening Lab closes CD Farm', JSON.stringify(await openPanels()));
    await n.page.click('.lab-chip');
    ok((await openPanels()).length === 0, 'clicking the open panel\'s chip closes it');
    await n.page.click('.cdf-chip');
    await n.page.click('.cdf-panel button[aria-label="Minimize"], .cdf-panel button[title="Minimize"]');
    await n.page.click('.egp-chip');
    ok(JSON.stringify(await openPanels()) === '["egp"]', 'switching away from a minimized panel closes it too', JSON.stringify(await openPanels()));
    ok(await n.page.evaluate(() => JSON.parse(localStorage.getItem('cdFarm.ui') || '{}').open === false), 'the closed panel is saved as closed');
    ok(n.errors.length === 0, 'no errors in the narrow window', JSON.stringify(n.errors));
    await n.browser.close();
  }
}

async function sectionDocked() {
  // On the game's real layout the open panel docks as a right rail (a sheet above the bottom bar on phones), like the game's own sidebar.
  for (const [w, hgt] of [[1440, 900], [390, 844]]) {
    const n = await open(w, hgt, false, true), p = n.page, tag = w + 'px: ';
    await load(p);
    await until(p, () => document.querySelector('.egp-panel.idc-docked'));
    const d = await p.evaluate(() => { const e = document.querySelector('.egp-panel'), r = e.getBoundingClientRect(); return { docked: e.classList.contains('idc-docked'), l: r.left, r: r.right, t: r.top, b: r.bottom, z: getComputedStyle(e).zIndex, pad: getComputedStyle(document.querySelector('.shell')).paddingRight, vw: innerWidth, vh: innerHeight, chromeTop: document.querySelector('.chrome').getBoundingClientRect().top }; });
    if (w > 700) ok(d.docked && Math.round(d.r) === d.vw && d.t === 0 && Math.round(d.b) === d.vh && d.pad === '360px' && d.z === '40', tag + 'Autopilot docks as a right rail at the game sidebar level and pushes the content over', JSON.stringify(d));
    else ok(d.docked && d.l === 0 && Math.round(d.r) === d.vw && d.b <= d.chromeTop + 1 && d.pad === '0px', tag + 'on a phone it docks as a sheet above the game bar', JSON.stringify(d));
    const onTop = (sel) => p.evaluate((s) => { const b = document.querySelector(s), r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }, sel);
    ok(await onTop('.egp-panel .idc-foot .primary'), tag + 'the Start button is not covered by anything');
    ok(await onTop('.egp-chip'), tag + 'the top-bar chip is not covered by the docked panel');
    await p.evaluate(() => window.idleCore.toast('hello', 'success'));
    const tov = await p.evaluate(() => { const t = document.querySelector('.idc-toast').getBoundingClientRect(), e = document.querySelector('.egp-panel').getBoundingClientRect(); return t.left < e.right && t.right > e.left && t.top < e.bottom && t.bottom > e.top; });
    if (w > 700) ok(!tov, tag + 'toasts sit beside the docked panel, not on it');
    // one dock: the panel shown last takes it and the other minimizes (floating); the chip brings it back docked
    await p.evaluate(() => window.cdFarm.panel(true));
    const one = await p.evaluate(() => ({ docked: [...document.querySelectorAll('.idc-panel.idc-docked')].map((e) => e.classList[1]), egpMin: document.querySelector('.egp-panel').classList.contains('min') }));
    ok(one.docked.join() === 'cdf-panel' && one.egpMin, tag + 'one docked panel at a time: the newest wins, the other minimizes', JSON.stringify(one));
    await p.click('.egp-chip');
    ok(await p.evaluate(() => document.querySelector('.egp-panel.idc-docked') && !document.querySelector('.cdf-panel')), tag + 'the chip expands the minimized panel back into the dock');
    // a docked header does not drag
    const hb = await (await p.$('.egp-panel .idc-head')).boundingBox();
    await p.mouse.move(hb.x + 60, hb.y + 12); await p.mouse.down(); await p.mouse.move(hb.x - 200, hb.y + 100, { steps: 4 }); await p.mouse.up();
    ok(await p.evaluate(() => JSON.parse(localStorage.getItem('earlyGame.ui')).x == null && !!document.querySelector('.egp-panel.idc-docked')), tag + 'dragging a docked header leaves it docked');
    // React swaps the layout out: the panel falls back to floating; the layout comes back: it docks again
    await p.evaluate(() => { window.__shell = document.querySelector('.shell'); window.__shell.remove(); });
    await until(p, () => !document.querySelector('.egp-panel.idc-docked'));
    const fl = await p.evaluate(() => { const e = document.querySelector('.egp-panel'), r = e.getBoundingClientRect(); return { docked: e.classList.contains('idc-docked'), h: r.height, z: getComputedStyle(e).zIndex }; });
    ok(!fl.docked && fl.h > 100 && fl.z === '9999', tag + 'without the game layout the panel floats as before', JSON.stringify(fl));
    await p.evaluate(() => document.getElementById('root').append(window.__shell));
    await until(p, () => document.querySelector('.egp-panel.idc-docked'));
    ok(await p.evaluate(() => !!document.querySelector('.egp-panel.idc-docked') && /^4[01]$/.test(getComputedStyle(document.querySelector('.egp-panel')).zIndex)), tag + 'when the layout comes back it docks again');
    // Escape still closes and hands focus back
    await p.focus('.egp-panel .idc-tabbtn[aria-selected=true]');
    await p.keyboard.press('Escape');
    ok(await count(p, '.egp-panel') === 0 && await p.evaluate(() => getComputedStyle(document.querySelector('.shell')).paddingRight) === '0px', tag + 'Escape closes the docked panel and the content gets its width back');
    ok(n.errors.length === 0, tag + 'no errors on the docked layout', JSON.stringify(n.errors));
    await n.browser.close();
  }
}
async function sectionMotion() {
  // motion on (the checks above run with reduced motion): panels fade in, closed ones leave a fading copy, minimize animates height
  {
    const n = await open(1280, 800, true);
    await load(n.page);
    await n.page.evaluate(() => window.earlyGame.panel(false));
    await n.page.click('.cdf-chip');
    ok(await n.page.$eval('.cdf-panel', (e) => e.getAnimations().some((a) => a.animationName === 'idc-panel-in')), 'motion: a panel fades in when it opens');
    await n.page.click('.cdf-panel .idc-tabbtn:nth-child(2)');
    ok(await n.page.$eval('.cdf-panel .idc-pane:not([hidden])', (e) => e.getAnimations().some((a) => a.animationName === 'idc-pane-in')), 'motion: the new tab fades in');
    await n.page.click('.cdf-panel button[aria-label="Minimize"], .cdf-panel button[title="Minimize"]');
    ok(await n.page.$eval('.cdf-panel', (e) => e.getAnimations().some((a) => !a.animationName)), 'motion: minimize animates the height');
    await n.page.click('.lab-chip');
    const live = await n.page.$$eval('.idc-panel:not(.idc-ghost)', (p) => p.length);
    const ghosts = await n.page.$$eval('.idc-ghost', (p) => p.length);
    ok(live === 1 && ghosts === 1, 'motion: switching leaves one live panel and one fading copy', live + '/' + ghosts);
    await until(n.page, () => document.querySelectorAll('.idc-ghost').length === 0, null, 2000);
    ok(await n.page.$$eval('.idc-ghost', (p) => p.length) === 0 && await n.page.$$eval('.idc-panel', (p) => p.length) === 1, 'motion: the fading copy is removed afterwards');
    ok(n.errors.length === 0, 'no errors with motion on', JSON.stringify(n.errors));
    await n.browser.close();
  }
}

async function sectionUtilities(page, { q, attr, count, visible, ui }) {
  // Auto utilities: the "Auto" switch sits on the Load tile (power) and the Supply tile (water) of the Utilities pages
  {
    const gridHtml = (labels) => '<div class="stat-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">' + labels.map((l) => '<div class="tile" style="background:var(--surface-2);padding:12px;border-radius:8px"><div class="label">' + l + '</div><div class="value">0</div></div>').join('') + '</div>';
    const setPage = (html) => page.evaluate((x) => { document.querySelector('main > div:last-child').innerHTML = x; }, html);
    const count = (sel) => page.$$eval(sel, (e) => e.length);
    await page.evaluate(() => {
      const st = window.__st;
      st.groups = { 1: { building: 8, count: 4, recipe: 16, work: [{ recipe: 16, runs: 4, remaining: 9 }] } };   // 4 Workshops: 4 MW
      st.subscriptions = { 0: { power: 0 } };
      window.__fiber.memoizedProps.contracts = [];
      window.__sent = [];
      window.__ws.send = (m) => { window.__sent.push(JSON.parse(m)); const o = JSON.parse(m); if (o.type === 'SetSubscription') { st.subscriptions[o.region] = { ...st.subscriptions[o.region], [o.utility]: o.level }; st.ssi.last_user_mutation_tick += 4; } };
    });
    await setPage(gridHtml(['Load', 'Capacity', 'Storage', 'Grid service', 'Selling']));
    await page.waitForSelector('.au-sw[data-au="power"]', { timeout: 5000 });
    ok(await count('.au-sw[data-au="power"]') === 1 && await page.$eval('.stat-grid > .tile:first-child > .au-sw', () => true), 'Auto utilities: one switch on the Load tile');
    ok(await count('.au-sw[data-au="water"]') === 0, 'Auto utilities: no water switch on the power page');
    ok(await page.$eval('.au-sw[data-au="power"] input', (e) => !e.checked) && await page.$eval('[data-au-note="power"]', (e) => e.hidden), 'Auto utilities: off by default, no note');
    await page.click('.au-sw[data-au="power"]');
    ok(await page.evaluate(() => window.autoUtil.conf.power.on === true && window.autoUtil.running), 'Auto utilities: clicking the switch turns Auto power on');
    await page.evaluate(() => window.autoUtil._step());
    const sentU = await page.evaluate(() => window.__sent);
    ok(JSON.stringify(sentU) === JSON.stringify([{ type: 'SetSubscription', region: 0, utility: 'power', level: 4 }]), 'Auto utilities: it raises the subscription to the 4 MW the groups draw', JSON.stringify(sentU));
    const note = await page.$eval('[data-au-note="power"]', (e) => e.textContent);
    ok(/4 MW/.test(note) && !(await page.$eval('[data-au-note="power"]', (e) => e.hidden)), 'Auto utilities: the tile says what it did', note);
    // React draws the tile again: the switch comes back once, still on
    await setPage(gridHtml(['Load', 'Capacity', 'Storage', 'Grid service', 'Selling']));
    await page.waitForFunction(() => document.querySelectorAll('.au-sw[data-au="power"]').length === 1 && document.querySelector('.au-sw[data-au="power"] input').checked, null, { timeout: 5000 });
    ok(true, 'Auto utilities: after the page is drawn again the switch is back, once, and on');
    // keyboard: focus the box, Space turns it off
    await page.focus('.au-sw[data-au="power"] input');
    await page.keyboard.press('Space');
    ok(await page.evaluate(() => window.autoUtil.conf.power.on === false), 'Auto utilities: Space on the focused switch turns it off');
    // the water page: the switch is on the Supply tile, the power one is gone
    await setPage(gridHtml(['Supply', 'Storage', 'Draw', 'Waterworks']));
    await page.waitForSelector('.au-sw[data-au="water"]', { timeout: 5000 });
    ok(await count('.au-sw[data-au="power"]') === 0 && await count('.au-sw[data-au="water"]') === 1, 'Auto utilities: on the water page only the Supply tile has a switch');
    ok(await page.$eval('.stat-grid > .tile:first-child > .au-sw[data-au="water"]', () => true), 'Auto utilities: it is on the first (Supply) tile');
    const box = await page.$eval('.au-sw[data-au="water"]', (e) => { const r = e.getBoundingClientRect(), t = e.parentElement.getBoundingClientRect(); return r.right <= t.right && r.top >= t.top && r.width > 30; });
    ok(box, 'Auto utilities: the switch is inside its tile');
    await setPage('<div>Game content</div>');
    await page.waitForFunction(() => !document.querySelector('.au-sw'), null, { timeout: 5000 });
    ok(true, 'Auto utilities: leaving the Utilities page removes the switch');
    await page.evaluate(() => window.autoUtil.stop());
  }
}

async function sectionUnload(page, { q, attr, count, visible, ui }) {
  // unload leaves nothing behind
  await page.evaluate(() => { window.earlyGame._unload(); window.cdFarm._unload(); window.labRunner._unload(); window.autoUtil._unload(); window.idleCore._unload(); });
  await until(page, () => !document.querySelector('.idc-panel, .idc-chip, .idc-tab, .idc-toasts, #idc-style, .au-sw, .au-note, #au-style'));
  ok(await page.evaluate(() => !document.querySelector('.idc-panel, .idc-chip, .idc-tab, .idc-toasts, #idc-style, .au-sw, .au-note, #au-style')), 'unload removes panels, chrome, toasts and the stylesheet');
}

const SHARDS = {
  chrome: { main: [sectionChrome] },
  cdfarm: { main: [sectionCdFarm] },
  lab: { main: [sectionLab] },
  utilities: { main: [sectionUtilities, sectionUnload] },
  narrow: { own: sectionNarrow },
  docked: { own: sectionDocked },
  motion: { own: sectionMotion },
  'auto-a': { auto: autoGroup1 },
  'auto-b': { auto: autoGroup2 },
  'auto-c': { auto: autoGroup3 },
};

async function runShard(name) {
  const sh = SHARDS[name];
  if (!sh) throw new Error('unknown shard ' + name + ' (one of ' + Object.keys(SHARDS).join(', ') + ')');
  if (sh.own) return sh.own();
  const { browser, page, errors } = await open(1280, 800);
  try {
    await load(page);
    if (sh.auto) await sh.auto(page, await autoSetup(page));
    else { const h = mainCtx(page); for (const fn of sh.main) await fn(page, h); }
    ok(errors.length === 0, 'no console / page errors (' + name + ')', JSON.stringify(errors));
  } finally { await browser.close(); }
}

// Every shard one after another: the old "check", for a quick look without the runner.
async function checks(only) {
  for (const name of Object.keys(SHARDS).filter((n) => !only || n === only || n.startsWith(only + '-'))) await runShard(name);
  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
}



// Lab panel shots: its own pass, since its default place is CD Farm's (the CD Farm card would sit on top of it).
async function shotsLab(page, out) {
  await page.evaluate(() => {
    window.earlyGame.panel(false); window.cdFarm.panel(false);
    const st = window.__st;
    st.items[25] = 36000; st.items[26] = 3; st.building_pool[0][14] = 1; st.building_pool[1] = { 14: 1 }; st.stock[1] = { 63: 0 };
    st.groups = { 1: { building: 4, region: 0, count: 2, recipe: 8 }, 2: { building: 8, region: 0, count: 1, recipe: 38 }, 3: { building: 0, region: 0, count: 5, recipe: 0 } };
    st.mfg_research = { 0: { product: 9, context: 0, tier: 0, remaining: 3840 } };
    st.pending_results = [{ tick: 5, product: 41, context: 1, tier: 1, reward: 'Rare Overclock Mk2' }];
    window.labRunner.panel(true);
  });
  await page.waitForTimeout(1200);
  const el = await page.$('.lab-panel');
  const shot = async (name, tab) => {
    await (await page.$('.lab-panel .idc-tabbtn[id$="-t-' + tab + '"]')).click();
    await page.waitForTimeout(200);
    await el.screenshot({ path: path.join(out, name + '.png') });
  };
  await shot('lab-status', 'status');
  await shot('lab-settings', 'settings');
  await page.evaluate(() => { const c = window.labRunner.cfg; c.mode = 'list'; c.tierMode = 3; c.list = [{ product: 42, focus: 0, tier: 'default' }, { product: 41, focus: 1, tier: 2 }, { product: 9, focus: 2, tier: 'default' }]; });
  await page.waitForTimeout(1200);
  await shot('lab-settings-list', 'settings');
  await page.evaluate(() => { window.labRunner.cfg.mode = 'process'; window.labRunner.cfg.tierMode = 'best'; window.labRunner.start(); });
  await page.waitForTimeout(1500);
  await shot('lab-status-running', 'status');
  await shot('lab-log', 'log');
  await page.evaluate(() => window.labRunner.stop());
}

const mode = process.argv[2];
(async () => {
  if (mode === 'check') return checks(process.argv[3]);   // bun test/ui-harness.js check [shard]
  if (mode === 'auto') return checks('auto');                // the three Auto shards

  if (mode === 'shots') {
    const out = process.argv[3]; const w = +process.argv[4] || 1280, hgt = +process.argv[5] || 800;
    fs.mkdirSync(out, { recursive: true });
    const { browser, page, errors } = await open(w, hgt, false, true);
    await load(page);
    await page.screenshot({ path: path.join(out, 'closed.png') });
    await page.evaluate(() => { window.earlyGame.panel(true); window.cdFarm.panel(true); });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(out, 'both-open.png') });
    for (const [name, sel, mod] of [['autopilot', '.egp-panel', 'earlyGame'], ['cdfarm', '.cdf-panel', 'cdFarm']]) {
      await page.evaluate((m) => { window.earlyGame.panel(false); window.cdFarm.panel(false); window[m].panel(true); }, mod);
      const exp = await page.$(sel + ' button[aria-label="Expand"]');
      if (exp) await exp.click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(out, name + '-page.png') });
      if (name === 'autopilot') {
        await page.evaluate(() => { window.idleCore.toast('Settings reset', { kind: 'success', undo: () => {} }); window.idleCore.toast('Buy failed: not enough cash', 'error'); });
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(out, 'toasts.png') });
      }
      const el = await page.$(sel);
      for (const tab of ['status', 'settings', 'log']) {
        const btn = await page.$(sel + ' .idc-tabbtn[id$="-t-' + tab + '"]');
        if (!btn) { await el.screenshot({ path: path.join(out, name + '-panel.png') }); break; }
        await btn.click();
        await page.waitForTimeout(150);
        await el.screenshot({ path: path.join(out, name + '-' + tab + '.png') });
      }
    }
    await shotsLab(page, out);
    console.log('errors:', JSON.stringify(errors));
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
