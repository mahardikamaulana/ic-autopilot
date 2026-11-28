// The real IdleCorp simulation engine (engine_bg-*.wasm) for tests. The client and server run the same engine (the client checks
// its state hash against the server's), so tick results here are the game's rules. Only the boards (retail, market, contracts,
// world-event clock) come from the server; tests pass them in.
//   const eng = await require('./engine.js').load();   // null when the wasm cannot be found or fetched (offline): skip the test
//   const e = new eng.Engine(corpId); e.load(snapshot); e.setRetail(board); e.tick([msg]); e.snapshot()
// The wasm is not committed: ENGINE_WASM=<path>, else test/.cache/engine_bg-*.wasm, else it is fetched once from idlecorp.net.
const fs = require('fs');
const path = require('path');
const CACHE = path.join(__dirname, '.cache');

async function wasmBytes() {
  if (process.env.ENGINE_WASM) return fs.readFileSync(process.env.ENGINE_WASM);
  const cached = fs.existsSync(CACHE) ? fs.readdirSync(CACHE).filter((f) => /^engine_bg-.*\.wasm$/.test(f)).sort() : [];
  if (cached.length && !process.env.ENGINE_REFRESH) return fs.readFileSync(path.join(CACHE, cached[cached.length - 1]));
  try {
    const html = await (await fetch('https://idlecorp.net/')).text();
    const bundle = html.match(/\/assets\/index-[^"']+\.js/)?.[0];
    const js = bundle && await (await fetch('https://idlecorp.net' + bundle)).text();
    const name = js && js.match(/engine_bg-[A-Za-z0-9_-]+\.wasm/)?.[0];
    if (!name) return null;
    const buf = Buffer.from(await (await fetch('https://idlecorp.net/assets/' + name)).arrayBuffer());
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(path.join(CACHE, name), buf);
    return buf;
  } catch { return null; }
}

function bind(bytes) {
  const mod = new WebAssembly.Module(bytes);
  let me;
  const dec = new TextDecoder(), enc = new TextEncoder();
  const u8 = () => new Uint8Array(me.memory.buffer);
  const str = (p, l) => dec.decode(u8().subarray(p >>> 0, (p >>> 0) + l));
  const put = (s) => { const b = enc.encode(s); const p = me.__wbindgen_malloc(b.length, 1) >>> 0; u8().set(b, p); return [p, b.length]; };
  // wasm-bindgen import names carry a build hash: match them by prefix so a re-built engine still binds
  const impl = {
    __wbg_Error_: (p, l) => Error(str(p, l)),
    __wbg___wbindgen_throw_: (p, l) => { throw new Error(str(p, l)); },
    __wbindgen_init_externref_table: () => { const t = me.__wbindgen_externrefs, s = t.grow(4); t.set(0, undefined); t.set(s, undefined); t.set(s + 1, null); t.set(s + 2, true); t.set(s + 3, false); },
  };
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    const key = Object.keys(impl).find((k) => imp.name.startsWith(k));
    if (!key) throw new Error('engine.js: unknown wasm import ' + imp.name + ' (the engine changed; extend impl)');
    (imports[imp.module] ??= {})[imp.name] = impl[key];
  }
  me = new WebAssembly.Instance(mod, imports).exports;
  me.__wbindgen_start?.();
  const err = (i) => { const v = me.__wbindgen_externrefs.get(i); me.__externref_table_dealloc(i); return v; };
  const ret = (r) => { try { return str(r[0], r[1]); } finally { me.__wbindgen_free(r[0], r[1], 1); } };
  class Engine {
    constructor(seed = 1) { this.p = me.localengine_new(BigInt(seed)); }
    _json(name) { return JSON.parse(ret(me['localengine_' + name](this.p))); }
    _set(name, ...strs) { const a = strs.flatMap((s) => put(typeof s === 'string' ? s : JSON.stringify(s))); const r = me['localengine_' + name](this.p, ...a); if (r[1]) throw err(r[0]); }
    snapshot() { return this._json('snapshot'); }
    retail() { return this._json('retailJson'); }
    market() { return this._json('marketJson'); }
    load(s) { this._set('loadSnapshot', s); }
    setRetail(b) { this._set('setRetail', b); }
    setMarket(m) { this._set('setMarket', m); }
    setWorldEvents(clock) { this._set('setWorldEvents', clock); }
    setContracts(list, nextId = 1) { const [p, l] = put(JSON.stringify(list)); const r = me.localengine_setContracts(this.p, p, l, nextId); if (r[1]) throw err(r[0]); }
    // tickAt jumps the clock and runs ONE tick (the client's heartbeat); it does not simulate the ticks in between
    tickAt(t) { me.localengine_tickAt(this.p, t); }
    // one tick, applying the player messages first; returns the state diff (has .tick)
    tick(msgs = []) { const [p, l] = put(JSON.stringify(msgs)); const r = me.localengine_tick(this.p, p, l); if (r[3]) throw err(r[2]); return JSON.parse(ret(r)); }
    worldEventAt(t) { return JSON.parse(ret(me.localengine_worldEventAt(this.p, t))); }
    hash() { return ret(me.localengine_stateHash(this.p)); }
    // the client's B_: the combined effect of a module layout on a group of this building (same call as engine.moduleReport in the page)
    moduleReport(building, json) { const [p, l] = put(json); return ret(me.localengine_moduleReport(this.p, building, p, l)); }
  }
  return { Engine, catalog: () => JSON.parse(ret(me.catalog_json())) };
}

let memo;
async function load() {
  if (memo !== undefined) return memo;
  const bytes = await wasmBytes();
  memo = bytes ? bind(bytes) : null;
  return memo;
}

module.exports = { load };

if (require.main === module) {
  // self-check: bun test/engine.js
  (async () => {
    const eng = await load();
    if (!eng) { console.log('skip: engine wasm not available (offline?)'); return; }
    const cat = eng.catalog();
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'live-2026-11-28.json'), 'utf8'));
    const e = new eng.Engine(fx.snap.ssi.corp_id);
    e.load(fx.snap); e.setRetail(fx.retail); e.setMarket(fx.market); e.setContracts(fx.contracts);
    const m0 = e.snapshot().items[0];
    for (let i = 0; i < 1200; i++) e.tick([]);
    const dm = (e.snapshot().items[0] - m0) / 100;
    console.assert(cat.items.length > 100, 'catalog has items');
    console.assert(dm > 5000, 'live fixture earns money in 10 min: ' + dm);
    console.log('engine ok: ' + cat.items.length + ' items, live fixture +$' + dm.toFixed(0) + ' in 1,200 ticks');
  })();
}
