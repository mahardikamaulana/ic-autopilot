// Keep online: the module is loaded from the built userscript and run against a stub document and a stub core.
//   bun test/keep-online-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const built = fs.readFileSync(path.join(__dirname, '..', 'ic-autopilot.user.js'), 'utf8');
const mod = built.slice(built.indexOf('// @@MODULE keep-online'), built.indexOf('// @@END keep-online'));
assert.ok(mod.length > 500, 'keep-online module found in the built file');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
}

// A document that natively reports hidden, the way a background tab does.
function setup({ storedOn } = {}) {
  class FakeDoc extends EventTarget { }
  const proto = Object.create(FakeDoc.prototype);
  Object.defineProperty(proto, 'hidden', { get: () => true, configurable: true });
  Object.defineProperty(proto, 'visibilityState', { get: () => 'hidden', configurable: true });
  const doc = new FakeDoc();
  Object.setPrototypeOf(doc, proto);
  doc.body = {};
  globalThis.Document = function() { };
  Document.prototype = proto;
  globalThis.document = doc;
  const disk = {};
  if (storedOn !== undefined) disk['idc.keepOnline'] = JSON.stringify({ on: storedOn });
  globalThis.localStorage = { getItem: (k) => disk[k] ?? null, setItem: (k, v) => { disk[k] = String(v); }, removeItem: (k) => { delete disk[k]; } };
  globalThis.idleCore = {
    settings: (k) => ({ load: () => JSON.parse(disk[k] ?? 'null'), save: (v) => { disk[k] = JSON.stringify(v); } }),
    sock: { textMsgs: 0, ws: null },
    every: () => () => { },
    link: () => ({ state: 'open' }),
    realHidden: () => Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get.call(document),
    ledger: { add: () => { } },
  };
  const seen = [];
  doc.addEventListener('visibilitychange', () => seen.push(doc.visibilityState));
  return { doc, disk, seen };
}
function load() { (0, eval)(mod); }
function unload() { globalThis.keepOnline?._unload(); delete globalThis.keepOnline; }

t('on by default: the game reads the tab as visible, the real state stays hidden', () => {
  const { doc, seen } = setup();
  load();
  assert.strictEqual(doc.hidden, false);
  assert.strictEqual(doc.visibilityState, 'visible');
  assert.strictEqual(idleCore.realHidden(), true, 'the core still sees the real state');
  assert.deepStrictEqual(seen, ['visible'], 'one visibilitychange goes out after install');
  unload();
});

t('a saved off stays off on load: no spoof, no event', () => {
  const { doc, seen } = setup({ storedOn: false });
  load();
  assert.strictEqual(doc.hidden, true);
  assert.strictEqual(doc.visibilityState, 'hidden');
  assert.deepStrictEqual(seen, []);
  unload();
});

t('set(false) restores the real state and tells listeners; set(true) spoofs again', () => {
  const { doc, seen, disk } = setup();
  load();
  keepOnline.set(false);
  assert.strictEqual(doc.hidden, true, 'native value back');
  assert.strictEqual(doc.visibilityState, 'hidden');
  assert.strictEqual(seen.at(-1), 'hidden', 'listeners re-read the real state');
  assert.strictEqual(JSON.parse(disk['idc.keepOnline']).on, false, 'saved');
  keepOnline.set(true);
  assert.strictEqual(doc.hidden, false);
  assert.strictEqual(seen.at(-1), 'visible');
  unload();
});

t('settings export and import carry the switch', () => {
  setup();
  load();
  assert.deepStrictEqual(keepOnline.exportCfg(), { on: true });
  assert.deepStrictEqual(keepOnline.importCfg({ on: false }), { applied: ['on'], skipped: [] });
  assert.strictEqual(keepOnline.on, false);
  assert.deepStrictEqual(keepOnline.importCfg({ on: 'yes' }), { applied: [], skipped: ['on'] }, 'a non-boolean is refused');
  unload();
});

console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
