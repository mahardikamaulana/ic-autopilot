// Module watch: the module is loaded from the built userscript and run against a stub core (no game, no DOM).
//   bun test/module-watch-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const built = fs.readFileSync(path.join(__dirname, '..', 'ic-autopilot.user.js'), 'utf8');
const mod = built.slice(built.indexOf('// @@MODULE module-watch'), built.indexOf('// @@END module-watch'));
assert.ok(mod.length > 500, 'module-watch module found in the built file');

let failed = 0;
const t = (name, fn) => {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
};

// Stub core: records what the module asks the socket to do, and feeds frames the way the real core does.
function setup({ corp = 1, tick = 1000, pathname = '/', disk = {}, sockOpen = true, boards = {} } = {}) {
  const sent = [], notes = [], toasts = [], frames = [];
  const sock = { ws: sockOpen ? { readyState: 1 } : null, boards: { ...boards } };
  globalThis.location = { pathname };
  globalThis.localStorage = { getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = String(v); }, removeItem: (k) => { delete disk[k]; } };
  globalThis.idleCore = {
    settings: (k) => ({ load: () => JSON.parse(disk[k] ?? 'null'), save: (v) => { disk[k] = JSON.stringify(v); } }),
    h: () => ({}),
    sock,
    walk: () => ({ st: { ssi: { corp_id: corp } } }),
    link: () => ({ state: sockOpen ? 'open' : 'closed' }),
    nowTick: () => tick,
    every: () => () => { },
    sleep: () => new Promise(() => { }),
    onFrame: (fn) => { frames.push(fn); return () => { const i = frames.indexOf(fn); if (i >= 0) frames.splice(i, 1); }; },
    sendBoardFilter: (board, filter) => {
      sent.push({ board, filter });
      sock.boards[board] = { filter, ours: true, at: Date.now() };
      return true;
    },
    notify: (mod, title, body) => notes.push({ mod, title, body }),
    notifyPerm: () => 'granted',
    askNotify: async () => 'granted',
    realHidden: () => false,
    toast: (text) => toasts.push(text),
    setBadge: () => { },
    ledger: { add: () => { } },
    ui: { onDom: () => () => { } },
  };
  const feed = (msg) => { for (const fn of [...frames]) fn(msg); };
  return { sent, notes, toasts, feed, sock, disk };
}
function load() { (0, eval)(mod); return globalThis.moduleWatch; }
function unload() { globalThis.moduleWatch?._unload(); delete globalThis.moduleWatch; }

// A module as the game lists it: overclock, six quirks (Mythic), Twinned at 12%.
const QUIRKS = [{ kind: 'Twinned', pct: 12 }, { kind: 'Loner', pct: 5 }, { kind: 'Specialist' }, { kind: 'Instrumented' }, { kind: 'BulkTuned', outputs_pct: 4 }, { kind: 'CornerTuned', elsewhere_pct: 30 }];
const listing = (over = {}, mod = {}) => ({
  id: 7, seller: 2, asking_price: 40000, expires_at: 5000, posted_at: 1,
  module: { id: 3, kind: 61, name: 'Mythic Overclock Module Mk12', quirks: QUIRKS, ...mod },
  ...over,
});

t('parse: the game words, with price in dollars and quirk rarity', () => {
  setup(); const { _parse: parse } = load(); unload();
  const p = parse('overclock mythic price <= 500');
  assert.deepStrictEqual(p.bad, []);
  assert.deepStrictEqual(p.f.kinds, [61]);
  assert.deepStrictEqual(p.f.nums, [{ field: 'quirks', op: '=', value: 6 }, { field: 'price', op: '<=', value: 500 }]);
});

t('parse: unknown and prototype words are refused, not taken as filters', () => {
  setup(); const { _parse: parse } = load(); unload();
  assert.deepStrictEqual(parse('overclok').bad, ['overclok']);
  assert.deepStrictEqual(parse('constructor').bad, ['constructor']);
  assert.deepStrictEqual(parse('toString').bad, ['tostring']);
  assert.ok(parse('').empty);
});

t('serverFilter: kinds as items, price in hundredths, quirk bounds as typed, like the game page', () => {
  setup(); const { _parse: parse, _serverFilter: sf } = load(); unload();
  const f = sf(parse('overclock twinned >= 10 price <= 500').f);
  assert.deepStrictEqual(f.items, [61]);
  assert.deepStrictEqual(f.quirks, [{ quirk: 'Twinned', op: 'Ge', value: 10 }]);
  assert.deepStrictEqual(f.nums, [{ field: 'Price', op: 'Le', value: 50000 }]);
});

t('matches: a Mythic Overclock at $400 matches "overclock mythic price <= 500" and not at $600', () => {
  setup(); const { _parse: parse, _matches: matches } = load(); unload();
  const f = parse('overclock mythic price <= 500').f;
  assert.ok(matches(f, listing()));
  assert.ok(!matches(f, listing({ asking_price: 60000 })));
});

t('matches: kinds are any-of, quirk bounds use the quirk value (elsewhere_pct for Corner-tuned)', () => {
  setup(); const { _parse: parse, _matches: matches } = load(); unload();
  assert.ok(matches(parse('refiner overclock').f, listing()), 'overclock is one of the two kinds');
  assert.ok(!matches(parse('refiner').f, listing()));
  assert.ok(matches(parse('twinned >= 10').f, listing()));
  assert.ok(!matches(parse('twinned >= 13').f, listing()));
  assert.ok(matches(parse('corner-tuned = 30').f, listing()));
  assert.ok(!matches(parse('loner >= 6').f, listing()));
  assert.ok(!matches(parse('quirks >= 7').f, listing()));
});

t('frames: a matching listing alerts once; a repeat and a ListingUpdate of it do not', () => {
  const env = setup({});
  const mw = load();
  mw.add('overclock mythic price <= 500');
  env.feed({ kind: 'Listings', listings: [listing()], truncated: false, tick: 1000 });
  assert.strictEqual(env.notes.length, 1);
  env.feed({ kind: 'Listings', listings: [listing()], truncated: false, tick: 1000 });
  env.feed({ kind: 'ListingUpdate', changed: [listing()], removed: [], tick: 1000 });
  assert.strictEqual(env.notes.length, 1, 'no second alert for the same listing');
  unload();
});

t('frames: own listings and expired ones never alert', () => {
  const env = setup({ corp: 2, tick: 1000 });
  const mw = load();
  mw.add('overclock');
  env.feed({ kind: 'Listings', listings: [listing({ seller: 2 }), listing({ id: 8, expires_at: 900 })], truncated: false });
  assert.strictEqual(env.notes.length, 0);
  unload();
});

t('frames: one alert per watch per reply, cheapest first, with the count', () => {
  const env = setup({});
  const mw = load();
  mw.add('overclock mythic');
  env.feed({ kind: 'Listings', listings: [listing({ id: 1, asking_price: 90000 }), listing({ id: 2, asking_price: 30000 })], truncated: false });
  assert.strictEqual(env.notes.length, 1);
  assert.match(env.notes[0].title, /2 new listings/);
  assert.match(env.notes[0].body, /\$300/);
  unload();
});

t('ownership: with a watch on and the page closed, the watch sends its own filter once', () => {
  const env = setup({});
  const mw = load();
  mw.add('overclock');
  mw._tick();
  mw._tick();
  assert.strictEqual(env.sent.length, 1);
  assert.strictEqual(env.sent[0].board, 'ModuleListings');
  assert.deepStrictEqual(env.sent[0].filter.items, [61]);
  unload();
});

t('ownership: the game page owns the board: nothing is sent on the Exchange page, or while the game filter is set', () => {
  const onPage = setup({ pathname: '/market/exchange' });
  const mwA = load(); mwA.add('overclock'); mwA._tick();
  assert.strictEqual(onPage.sent.length, 0, 'on the Exchange page');
  unload();

  const theirs = setup({ boards: { ModuleListings: { filter: { items: [] }, ours: false, at: 1 } } });
  const mwB = load(); mwB.add('overclock'); mwB._tick();
  assert.strictEqual(theirs.sent.length, 0, 'the game set its own filter');
  unload();
});

t('ownership: removing the last watch releases the filter we set, once', () => {
  const env = setup({});
  const mw = load();
  const id = mw.add('overclock').id;
  mw._tick();
  mw.remove(id);
  mw._tick();
  assert.strictEqual(env.sent.length, 2);
  assert.strictEqual(env.sent[1].filter, null);
  mw._tick();
  assert.strictEqual(env.sent.length, 2, 'released once, not again');
  unload();
});

t('ownership: several watches take turns, one filter at a time', () => {
  const env = setup({});
  const mw = load();
  mw.add('overclock'); mw.add('refiner');
  const realNow = Date.now;
  try {
    let now = 1e12; Date.now = () => now;
    mw._tick();
    now += 21000; mw._tick();
    assert.deepStrictEqual(env.sent.map((s) => s.filter.items), [[61], [62]]);
  } finally { Date.now = realNow; }
  unload();
});

t('persistence: watches and seen listings survive a reload, so a listing is not alerted twice', () => {
  const env = setup({});
  const mw = load();
  mw.add('overclock mythic');
  env.feed({ kind: 'Listings', listings: [listing()], truncated: false });
  assert.strictEqual(env.notes.length, 1);
  unload();
  const again = setup({ disk: env.disk });
  const mw2 = load();
  assert.deepStrictEqual(mw2.list().map((w) => w.q), ['overclock mythic']);
  again.feed({ kind: 'Listings', listings: [listing()], truncated: false });
  assert.strictEqual(again.notes.length, 0);
  unload();
});

t('settings: export and import carry the watches; a bad word is skipped, not applied', () => {
  setup({});
  const mw = load();
  mw.add('overclock');
  assert.deepStrictEqual(mw.exportCfg(), { watches: [{ q: 'overclock', on: true }] });
  const r = mw.importCfg({ watches: [{ q: 'refiner', on: false }, { q: 'nonsense' }] });
  assert.deepStrictEqual(r.applied, ['refiner']);
  assert.deepStrictEqual(r.skipped, ['nonsense']);
  assert.deepStrictEqual(mw.list().map((w) => [w.q, w.on]), [['overclock', true], ['refiner', false]]);
  unload();
});

console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
