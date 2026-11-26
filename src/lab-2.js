// continues the lab closure from lab-1.js (same try / IIFE)
// ---- state access -----------------------------------------------------------------------------
class ConnError extends Error { }

function read(fresh = false) {
  const { ws, st, catalog } = core.walk(fresh);
  if (!st || !catalog) return null;
  return { st, catalog, mutTick: st.ssi?.last_user_mutation_tick ?? 0, wsOpen: ws?.readyState === 1, ws };
}
function mustRead(fresh = false) {
  const r = read(fresh);
  if (!r) throw new ConnError('game state not found');
  return r;
}
// Why Live must not run right now ('' = fine). Dry runs and the offline tests (no DOM) are never blocked.
function liveBlocked() {
  if (!HAS_DOM || cfg.dryRun) return '';
  const r = read(true);
  if (!r) return 'the game state was not found';
  const bad = checkGame(r.st, r.catalog);
  return bad.length ? 'the game data no longer looks like what this script expects (' + bad.join('; ') + ')' : '';
}

// ---- sending -----------------------------------------------------------------------------------
const sleep = core.sleep;
const jitter = () => {
  const lo = Math.max(0, cfg.jitterMinMs || 0), hi = Math.max(lo, cfg.jitterMaxMs || 0);
  return sleep(lo + Math.random() * (hi - lo));
};
// Sleep that stop() (or unload) ends at once.
let kick = null;
const nap = (ms) => new Promise((res) => {
  function done() { if (kick === done) kick = null; res(); }
  kick = done;
  sleep(ms).then(done);   // core.sleep: socket messages end it on time in a hidden tab
});
// Sends a command; returns the mutation-Diff count at send time.
function send(msg) {
  const r = mustRead(true);
  if (!r.wsOpen) throw new ConnError('socket not open');
  const d = core.markSend(r.mutTick);   // only a later mutation confirms this command
  r.ws.send(JSON.stringify(msg));
  return d;
}
// Waits until the server has applied a player command after this one was sent AND the state shows it.
const waitConfirm = (pred, d0) => core.waitConfirm({ read, pred, d0, timeoutMs: cfg.timeoutMs, closed: () => { throw new ConnError('socket closed while waiting'); } });
const confirmed = (a) => (a.kind === 'claim'
  ? (r) => !(r.st.pending_results ?? []).some((p) => p.tick === a.tick)
  : (r) => slotOf(r.st, a.region) != null);

// ---- run loop ----------------------------------------------------------------------------------
let running = false, active = false, stopReason = '', stopFailed = false, fails = 0, lastNote = '', wouldSig = '';
const cool = new Map();   // action key → { n, until }: an action the server didn't apply waits before it is tried again
const cooling = (key) => (cool.get(key)?.until ?? 0) > Date.now();
const sess = { started: 0, claimed: 0 };
const note = (line) => { if (line !== lastNote) { lastNote = line; console.log('[labRunner] ' + line); } };

const doneText = (a) => (a.kind === 'claim' ? 'claimed ' + a.label + (a.reward ? ': ' + a.reward : '') : `started ${a.label} in ${a.regionName} (${a.pct}% success)`);

// Dry run: say what would be sent, once per change.
function wouldSend(d) {
  const sig = d.actions.map((a) => JSON.stringify(a.msg)).join('|');
  if (sig === wouldSig) return;
  wouldSig = sig;
  for (const a of d.actions) {
    const line = 'would send ' + JSON.stringify(a.msg) + ' — ' + a.reason;
    console.log('[labRunner] ' + line);
    core.ledger.add(TAG, 'info', line);
  }
}

// One look at the game: send the first thing that is due. Returns 'sent' (something went out, confirmed or not) or 'idle'.
async function pass() {
  const r = mustRead();
  if (!r.wsOpen) throw new ConnError('socket not open');
  const d = decide(r.st, r.catalog);
  if (cfg.dryRun) { wouldSend(d); return 'idle'; }
  if (!d.actions.some((x) => !cooling(x.key))) return 'idle';
  await jitter();
  if (!running) return 'idle';
  // The state may have moved during the wait: decide again on fresh state and send only what is still due.
  const r2 = mustRead(true);
  const a = decide(r2.st, r2.catalog).actions.find((x) => !cooling(x.key));
  if (!a) return 'idle';
  const d0 = send(a.msg);
  if (await waitConfirm(confirmed(a), d0)) {
    fails = 0;
    cool.delete(a.key);
    if (a.kind === 'claim') sess.claimed++;
    else {
      sess.started++;
      mem.counts[a.product] = (mem.counts[a.product] ?? 0) + 1;
      if (a.index != null) mem.next = (a.index + 1) % cfg.list.length;
    }
    save();
    console.log('[labRunner] ' + doneText(a));
    core.ledger.add(TAG, 'action', doneText(a));
    return 'sent';
  }
  // Not applied: back off on this action (30 s, doubling to 10 min) so it can't hold up the others.
  const c = cool.get(a.key) ?? { n: 0 };
  c.n++; c.until = Date.now() + Math.min(600000, 30000 * 2 ** (c.n - 1));
  cool.set(a.key, c);
  core.ledger.add(TAG, 'fail', `not confirmed: ${a.reason}; trying again in ${Math.round((c.until - Date.now()) / 1000)} s`);
  if (core.link().state === 'open' && ++fails >= MAX_FAILS) { fails = 0; core.ledger.add(TAG, 'fail', `${MAX_FAILS} commands in a row were not confirmed: the run goes on, each command on its own backoff`); }
  return 'sent';
}

async function loop() {
  active = true;
  let errors = 0;
  while (running) {
    let pause = cfg.intervalMs;
    try {
      if ((await pass()) === 'sent') pause = cfg.delayMs;
      errors = 0;
    } catch (e) {
      if (e instanceof ConnError) { note(e.message + ': waiting for the game connection'); pause = 2000; }
      else {
        console.warn('[labRunner]', e);
        core.ledger.add(TAG, 'fail', 'error: ' + e.message);
        if (++errors >= MAX_FAILS) { errors = 0; pause = 600000; core.ledger.add(TAG, 'fail', `${MAX_FAILS} errors in a row: the run pauses 10 min, then goes on`); }
      }
    }
    if (running) await nap(pause);
  }
  running = false; active = false;
  if (unloaded) return;
  save();
  console.log(`[labRunner] stopped: ${stopReason}`);
  core.ledger.add(TAG, stopFailed ? 'fail' : 'info', `stopped: ${stopReason}`);
  if (stopFailed) core.notify(TAG, 'Lab runner stopped', stopReason);
  render();
}

// ---- control -----------------------------------------------------------------------------------
function start(opts = {}) {
  if (running) return console.warn('[labRunner] already running');
  if (active) return console.warn('[labRunner] the previous run is still finishing its step; try again in a moment');
  for (const [k, v] of Object.entries(opts)) {
    const ok = k === 'dryRun' ? typeof v === 'boolean' : k in cfg && !!VALID[k]?.(v);
    if (ok) cfg[k] = take(k, v); else console.warn(`[labRunner] ignored ${k}: not a setting, or not a valid value for it`);
  }
  if (!cfg.dryRun) {
    const why = liveBlocked();
    if (why) {
      cfg.dryRun = true;
      console.warn('[labRunner] Live refused: ' + why + '. Starting as a dry run.');
      core.toast('Live refused: the game data changed. Started as a dry run (see the console).', 'error');
      core.ledger.add(TAG, 'fail', 'Live refused: ' + why);
    }
  }
  running = true; stopReason = ''; stopFailed = false; fails = 0; lastNote = ''; wouldSig = '';
  cool.clear(); sess.started = sess.claimed = 0;
  save();
  console.log(`[labRunner] start (${cfg.dryRun ? 'DRY RUN: start({ dryRun: false }) to send' : 'LIVE'})`);
  core.ledger.add(TAG, 'info', `started (${cfg.dryRun ? 'dry run' : 'live'}): ${cfg.mode === 'list' ? 'custom list' : cfg.mode === 'modules' ? 'module fabrication' : 'process study'}, ${cfg.tierMode === 'best' ? 'best value tier' : 'Tier ' + TIERS[cfg.tierMode - 1].name}, keeps ${fmt(cfg.mdReserve)} MD`);
  loop();
  render();
}

function stop() {
  if (running) { stopReason = 'stopped by you'; console.log('[labRunner] stopping'); }
  running = false;
  kick?.();
  render();
}

// Settings out and in (the toolkit's Export / Import). dryRun is never exported or imported.
function exportCfg() { return { cfg: persistable() }; }
function importCfg(o) {
  if (running && !cfg.dryRun) throw new Error('stop the live run first');
  const applied = [], skipped = [];
  for (const [k, v] of Object.entries(o?.cfg ?? {})) {
    if (k in cfg && !SESSION_ONLY.includes(k) && VALID[k]?.(v)) { cfg[k] = take(k, v); applied.push(k); } else skipped.push(k);
  }
  save(); render();
  return { applied, skipped };
}
function resetCfg() {
  if (running && !cfg.dryRun) throw new Error('stop the live run first');
  for (const k of Object.keys(DEFAULTS)) if (!SESSION_ONLY.includes(k)) cfg[k] = clone(DEFAULTS[k]);
  save(); render();
}

// ---- what the panel and status() show -------------------------------------------------------------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const slotLine = (ix, p) => `${pname(ix, p.product)} · ${focusName(p.context)} · ${tierLabel(p.tier)} · ` + (p.remaining != null ? fmtLeft(p.remaining) + ' left' : 'queued');

function summary(r) {
  const d = decide(r.st, r.catalog);
  const ix = index(r.catalog);
  const rows = d.regions.map((x) => ({ name: x.name, busy: !!x.slot, catalyst: x.catalyst, text: x.slot ? slotLine(ix, x.slot) : x.start ? 'ready: ' + x.start.label : x.wait }));
  return { d, ix, rows, busy: rows.filter((x) => x.busy).length, total: rows.length };
}
// Success chance for the current setting, as the client works it out (no Research Database bonus: the state doesn't say).
function successInfo(r, sum) {
  const d = sum.d;
  const p = cfg.mode === 'list' ? pick(r.st, sum.ix, cfg, mem.counts, mem.next) : null;
  const focus = p && !p.wait ? p.focus : cfg.mode === 'modules' ? 1 : 0;
  const setting = p && !p.wait && p.tier !== 'default' ? p.tier : cfg.tierMode;
  const pct = (t) => successPct(t, focus, d.bonus);
  const fixed = TIERS[setting - 1];
  return {
    text: fixed ? `${pct(setting - 1)}% (Tier ${fixed.name})` : 'Tier ' + TIERS.map((k, t) => `${k.name} ${pct(t)}%`).join(' · '),
    note: `${focusName(focus)}; bonus +${d.bonus}% (${d.labs} Lab${d.labs === 1 ? '' : 's'}${d.insight ? ` + ${d.insight}% Insightful` : ''}). Leaves out the Research Database megaproject bonus (+10).`,
  };
}
// 'run' | 'wait' | 'err' | '' for the status dot.
function tone() {
  if (running) return cfg.dryRun ? 'wait' : 'run';
  return stopFailed ? 'err' : '';
}
function stateText(sum) {
  if (running) {
    const d = sum?.d;
    const next = !d ? 'running' : d.actions.length ? 'next: ' + d.actions[0].reason : 'waiting: ' + d.wait;
    return (cfg.dryRun ? 'Dry run. ' : '') + cap(next);
  }
  return stopReason ? 'Stopped: ' + stopReason : 'Idle. Press Start.';
}

function status() {
  const r = read();
  if (!r) return console.error('[labRunner] game state not found');
  const sum = summary(r), info = successInfo(r, sum), t = {};
  if (sum.total) for (const x of sum.rows) t[x.name] = x.text; else t.Labs = 'none built yet';
  t['Results waiting'] = sum.d.pending + (cfg.autoClaim ? '' : ' (auto-claim off)');
  t.MD = `${fmt(sum.d.md)} (keeps ${fmt(cfg.mdReserve)})`;
  t.RD = fmt(sum.d.rd);
  t.Catalyst = sum.rows.map((x) => `${x.name} ${fmt(x.catalyst)}`).join(', ') || '-';
  t.Success = info.text + ' · ' + info.note;
  t.State = stateText(sum);
  console.table(t);
}

