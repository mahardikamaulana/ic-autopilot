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

const INIT = (data) => {
  class FakeWS { constructor() { this.readyState = 1; this.sent = []; } addEventListener() {} removeEventListener() {} send(m) { this.sent.push(m); } }
  window.WebSocket = FakeWS;
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

async function open(width = 1280, height = 800, motion = false) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: motion ? 'no-preference' : 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(INIT, { catalog: board.catalog, deals: board.deals });
  await page.route('https://idlecorp.test/', (r) => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto('https://idlecorp.test/');
  await page.evaluate(() => { document.getElementById('root').__reactContainer$x = window.__fiber; });
  return { browser, page, errors };
}


async function load(page) {
  await page.addScriptTag({ content: script });
  await page.waitForSelector('.egp-tab', { timeout: 15000 });
  await page.waitForSelector('.cdf-tab', { timeout: 15000 });
  await page.waitForSelector('.lab-tab', { timeout: 15000 });
}

let failed = 0;
const ok = (cond, name, extra = '') => { if (!cond) failed++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)); };

async function checks() {
  const { browser, page, errors } = await open(1280, 800);
  await load(page);
  const q = (sel) => page.$(sel);
  const attr = (sel, a) => page.$eval(sel, (e, a) => e.getAttribute(a), a);
  const count = (sel) => page.$$eval(sel, (n) => n.length);
  const visible = (sel) => page.$eval(sel, (e) => !!(e.offsetWidth || e.offsetHeight));
  const ui = (k) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), k);

  // chrome
  ok(await count('.egp-tab') === 1 && await count('.cdf-tab') === 1 && await count('.lab-tab') === 1 && await count('.egp-chip') === 1 && await count('.cdf-chip') === 1 && await count('.lab-chip') === 1, 'sidebar tabs and top-bar chips mounted once each');
  const navOrder = (await page.$$eval('.primary-navigation .page-tab', (n) => n.map((e) => (e.querySelector('.nav-text') || e).textContent.trim().split(/\s/)[0]))).join();
  ok(navOrder === 'Corp,Market,Autopilot,CD,Lab', 'Autopilot tab sits above CD Farm tab, Lab tab below it', navOrder);
  const chipOrder = (await page.$$eval('.topbar-tools > *', (n) => n.map((e) => e.className.split(' ').find((c) => /^(egp|cdf|lab)-chip$|^tip-anchor$/.test(c)) || '?'))).join();
  ok(chipOrder === 'egp-chip,cdf-chip,lab-chip,tip-anchor', 'top-bar chips: Autopilot, CD Farm, Lab, then the game\'s own', chipOrder);

  // React re-renders the sidebar and top bar inside #root: the tab and chip must come back, once each, with the right label
  await page.evaluate(() => { document.querySelector('.egp-tab').remove(); document.querySelector('.cdf-chip').remove(); });
  await page.waitForTimeout(300);
  ok(await count('.egp-tab') === 1 && await count('.cdf-chip') === 1, 'removed sidebar tab and chip are re-inserted exactly once');
  ok((await page.$eval('.cdf-chip', (e) => e.textContent.trim())).endsWith('CD'), 'and come back already showing their current text');

  // No repaint loop: with a quiet page the chrome must not keep scheduling frames (the observer must not trigger itself)
  await page.waitForTimeout(1500);
  const raf0 = await page.evaluate(() => window.__raf);
  await page.waitForTimeout(2500);
  const raf1 = await page.evaluate(() => window.__raf);
  ok(raf1 - raf0 < 20, 'chrome does not re-trigger its own MutationObserver (frames requested in 2.5 s)', String(raf1 - raf0));

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
  await page.waitForTimeout(1200);
  ok(await count('.egp-panel .idc-ll') === 3, 'log shows the ledger lines');
  await page.click('.egp-panel .idc-quicks button:has-text("Problems")');
  ok(await count('.egp-panel .idc-ll') === 2 && await count('.egp-panel .idc-ll.k-fail') === 1, 'Problems filter keeps fail + alert only');
  await page.click('.egp-panel .idc-quicks button:has-text("Actions")');
  ok(await count('.egp-panel .idc-ll') === 1, 'Actions filter keeps actions only');
  await page.click('.egp-panel .idc-quicks button:has-text("All")');
  await page.click('.egp-panel button:has-text("Clear log")');
  ok(await count('.egp-panel .idc-ll') === 0, 'Clear log empties the view');
  await page.click('.idc-toast:last-child button');
  await page.waitForTimeout(1200);
  ok(await count('.egp-panel .idc-ll') === 3, 'Undo restores the log');

  // log DOM is left alone when nothing new arrived (selection survives), and Undo keeps lines logged meanwhile
  await page.evaluate(() => { window.__row = document.querySelector('.egp-panel .idc-ll'); });
  await page.waitForTimeout(1300);
  ok(await page.evaluate(() => window.__row === document.querySelector('.egp-panel .idc-ll')), 'log rows are not rebuilt while nothing new is logged');
  ok(await page.evaluate(() => !document.querySelector('.egp-panel [role=log]')), 'log list is not a live region');
  await page.click('.egp-panel button:has-text("Clear log")');
  await page.evaluate(() => window.idleCore.ledger.add('AP', 'info', 'logged during the undo window'));
  await page.click('.idc-toast:last-child button');
  await page.waitForTimeout(1300);
  ok(await count('.egp-panel .idc-ll') === 4, 'Undo of Clear log keeps lines logged in between', String(await count('.egp-panel .idc-ll')));

  // unseen-problem dot on the Log tab while another tab is showing
  await page.click('.egp-panel [id$="-t-status"]');
  await page.evaluate(() => window.idleCore.ledger.add('AP', 'fail', 'new failure'));
  await page.waitForTimeout(1200);
  ok(await page.$eval('.egp-panel [id$="-t-log"] .idc-tabdot', (e) => !e.hidden), 'Log tab flags a new problem');
  await page.click('.egp-panel [id$="-t-log"]'); await page.waitForTimeout(1200);
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
  await page.waitForTimeout(1500);
  ok(await page.evaluate(() => window.earlyGame.running), 'Start dry run starts');
  ok(await visible('.egp-tab .idc-pill'), 'sidebar pill shows while running');
  await page.click('.egp-panel .idc-foot .primary');
  await page.waitForTimeout(800);
  ok(!(await page.evaluate(() => window.earlyGame.running)), 'Stop stops');

  // CD Farm: modified + reset, advanced persisted
  await page.click('.cdf-chip');
  await page.click('.cdf-panel [id$="-t-settings"]');
  await page.fill('.cdf-panel input[aria-label="Money floor"]', '75k');
  ok(await count('.cdf-panel .idc-rst:not([hidden])') === 1, 'CD Farm: changed floor shows a reset button');
  await page.click('.cdf-panel .idc-field .idc-rst:not([hidden])');
  ok(await page.evaluate(() => window.cdFarm.cfg.minMoney) === 30000, 'CD Farm: reset restores the default floor');
  await page.click('.cdf-panel .idc-seg button:has-text("Income only")');
  ok(await page.evaluate(() => window.cdFarm.cfg.budget) === 'income', 'CD Farm: seg picks a budget mode');
  await page.focus('.cdf-panel .idc-seg button[aria-checked=true]');
  await page.keyboard.press('ArrowRight');
  ok(await page.evaluate(() => window.cdFarm.cfg.budget) === 'reserve', 'CD Farm: arrow key moves the seg');
  await page.evaluate(() => { window.cdFarm.cfg.budget = 'reserve'; });

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
  await page.waitForTimeout(1200);
  const rowsOf = () => page.$$eval('.lab-panel [id$="-p-status"] .idc-row', (r) => r.map((e) => e.textContent));
  let rows = await rowsOf();
  ok((await page.$eval('.lab-chip', (e) => e.textContent.trim())) === 'Lab 0/1' && (await page.$eval('.lab-panel .idc-big', (e) => e.textContent)) === '0 of 1', 'Lab: chip and hero count busy Labs');
  ok(rows.some((t) => t === 'Heartlandready: Iron Frame · Process study · Tier I'), 'Lab: Status shows the free Heartland Lab and the project it would start', JSON.stringify(rows));
  ok(rows.includes('MD36,000 · keeps 5,000') && rows.includes('RD3') && rows.includes('Results waiting0'), 'Lab: Status shows MD, RD and waiting results', JSON.stringify(rows));
  ok((await page.$eval('.lab-panel .idc-badge', (e) => e.textContent)) === 'Dry run', 'Lab: header badge says Dry run');
  await page.evaluate(() => { window.__st.mfg_research = { 0: { product: 9, context: 0, tier: 0, remaining: 3840 } }; window.__st.pending_results = [{ tick: 5, product: 41, context: 1, tier: 1, reward: 'x' }]; });
  await page.waitForTimeout(1200);
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
  await page.waitForTimeout(1300);
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
  await page.waitForTimeout(1500);
  ok(await page.evaluate(() => window.labRunner.running) && (await page.$eval('.lab-tab .idc-pill', (e) => e.textContent)) === 'Dry run' && (await page.evaluate(() => window.__ws.sent.length)) === before, 'Lab: a dry run runs and sends nothing');
  await page.click('.lab-panel [id$="-t-log"]');
  await page.evaluate(() => window.idleCore.ledger.add('CD', 'action', 'a farm line, not the Lab\'s'));
  await page.waitForTimeout(1200);
  const lines = await page.$$eval('.lab-panel .idc-ll', (r) => r.map((e) => [e.querySelector('.idc-tag').textContent, e.textContent]));
  ok(lines.length > 0 && lines.every(([tag]) => tag === 'LAB') && lines.some(([, t]) => /would send/.test(t)) && lines.some(([, t]) => /started \(live\)/.test(t)), 'Lab: the Log tab shows Lab lines only, dry-run and live', JSON.stringify(lines));
  await page.click(main);
  await page.waitForFunction(() => !window.labRunner.active, null, { timeout: 5000 });

  // Reset settings (two-step, with Undo) and Escape
  await page.click('.lab-panel [id$="-t-settings"]');
  await page.evaluate(() => { window.labRunner.cfg.mdReserve = 7777; });
  await page.waitForTimeout(1200);
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
    await n.page.waitForTimeout(700);
    ok(await n.page.$$eval('.idc-ghost', (p) => p.length) === 0 && await n.page.$$eval('.idc-panel', (p) => p.length) === 1, 'motion: the fading copy is removed afterwards');
    ok(n.errors.length === 0, 'no errors with motion on', JSON.stringify(n.errors));
    await n.browser.close();
  }

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

  // unload leaves nothing behind
  await page.evaluate(() => { window.earlyGame._unload(); window.cdFarm._unload(); window.labRunner._unload(); window.autoUtil._unload(); window.idleCore._unload(); });
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => !document.querySelector('.idc-panel, .idc-chip, .idc-tab, .idc-toasts, #idc-style, .au-sw, .au-note, #au-style')), 'unload removes panels, chrome, toasts and the stylesheet');

  ok(errors.length === 0, 'no console / page errors', JSON.stringify(errors));
  await browser.close();
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
  if (mode === 'check') return checks();
  if (mode === 'shots') {
    const out = process.argv[3]; const w = +process.argv[4] || 1280, hgt = +process.argv[5] || 800;
    fs.mkdirSync(out, { recursive: true });
    const { browser, page, errors } = await open(w, hgt);
    await load(page);
    await page.screenshot({ path: path.join(out, 'closed.png') });
    await page.evaluate(() => { window.earlyGame.panel(true); window.cdFarm.panel(true); });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(out, 'both-open.png') });
    for (const [name, sel] of [['autopilot', '.egp-panel'], ['cdfarm', '.cdf-panel']]) {
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
