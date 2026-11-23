// continues the core closure from core-2.js (same try / IIFE)
  // ---- reserves: what each spending module keeps back, shared by CD Farm Auto --------------------------------------
  // A provider is { reserve(): { moneyFloor (cents), items: {id: n}, nextTech, phase } | null, busy(): bool, hold?(who): Promise, release?(who) }.
  // Autopilot registers itself; Core plan registers its own. CD Farm reads the merged view instead of asking Autopilot alone:
  // money floor = the highest, item reserves add up (Infinity stays Infinity), the first provider with a next unlock wins.
  const reserveProviders = new Map();
  const reserves = {
    register(name, p) { reserveProviders.set(String(name), p); return () => { if (reserveProviders.get(String(name)) === p) reserveProviders.delete(String(name)); }; },
    unregister(name) { reserveProviders.delete(String(name)); },
    names: () => [...reserveProviders.keys()],
    anyBusy() { for (const p of reserveProviders.values()) { try { if (p.busy?.()) return true; } catch (e) { console.error(e); } } return false; },
    merged() {
      let any = false, moneyFloor = 0, nextTech = null, phase = null;
      const items = {}, by = {};
      for (const [name, p] of reserveProviders) {
        let r = null;
        try { r = p.reserve?.() ?? null; } catch (e) { console.error(e); }
        if (!r) continue;
        any = true; by[name] = r;
        moneyFloor = Math.max(moneyFloor, r.moneyFloor ?? 0);
        for (const [i, n] of Object.entries(r.items ?? {})) items[i] = (items[i] ?? 0) + n;
        nextTech ||= r.nextTech ?? null;
        if (phase == null && r.phase != null) phase = r.phase;
      }
      return any ? { moneyFloor, items, nextTech, phase, by } : null;
    },
    // Every provider pauses after its current step (CD Farm takes its baseline of unassigned buildings after this).
    // `except` names a provider that must not be held (a module holding the others while it spends must not wait for itself).
    async holdAll(who, except) { await Promise.all([...reserveProviders].filter(([n]) => n !== except).map(async ([, p]) => { try { await p.hold?.(who); } catch (e) { console.error(e); } })); },
    releaseAll(who, except) { for (const [n, p] of reserveProviders) { if (n === except) continue; try { p.release?.(who); } catch (e) { console.error(e); } } },
  };

  // ---- saved floor designs shared by Autopilot (floor upgrades) and Core plan (furniture floors) --------------------------
  // "x,y:item:rot" cells. Scored with the game's engine.evaluateLayout on 2026-11-22: Workshop v1 = x5 on Frame Timber, Make Bookshelf,
  // Make Table, Make Chair (one input); Rivet x3 = x3 on Rivet Iron Frame, Make Bench, Make Desk (two inputs).
  // mineX3 = x3 merge on a 5x2 Mine (Extract, no inputs; proven max), smeltX3 = Smelt x3 on the Smelter: both moved from Autopilot's floor library.
  const floorDesigns = Object.freeze({
    workshopV1: '0,0:114:0 0,1:114:0 0,2:114:0 0,3:114:0 0,4:114:0 10,1:123:0 10,2:116:2 10,4:123:0 11,0:123:0 11,1:126:0 11,4:123:0 12,0:123:0 12,1:123:0 12,4:123:0 13,0:123:0 13,1:126:0 13,2:123:1 13,3:123:2 13,4:123:0 14,0:123:0 14,1:123:1 14,2:123:0 14,4:123:0 15,0:116:0 15,2:116:0 15,4:123:0 16,4:123:0 17,4:123:0 2,0:123:0 2,1:123:0 2,2:123:0 2,3:123:0 2,4:123:0 3,0:123:0 3,1:123:1 3,2:127:0 3,3:123:3 3,4:123:0 4,0:116:0 4,2:123:0 4,3:116:0 5,2:123:0 6,2:123:0 7,0:123:0 7,1:123:0 7,2:123:3 7,3:123:0 8,0:123:1 8,1:128:0 8,2:123:1 8,3:127:1 8,4:123:0 9,1:123:0 9,3:123:1 9,4:127:0',
    rivetX3: '0,0:123:0 0,1:123:1 0,2:123:1 0,3:123:1 0,4:123:0 1,0:123:0 1,4:123:0 10,1:123:0 10,2:123:0 10,4:123:0 11,1:123:0 11,2:123:0 11,4:123:0 12,1:123:0 12,2:116:0 12,4:123:0 13,1:123:0 13,4:123:0 14,1:123:0 14,4:123:0 15,0:116:0 15,2:123:0 15,3:116:0 16,2:123:0 17,2:123:0 2,0:126:0 2,1:123:1 2,2:126:1 2,3:123:0 2,4:123:0 3,0:123:0 3,2:123:0 3,3:114:0 3,4:123:0 4,0:114:0 4,2:114:0 4,4:123:0 5,3:123:0 5,4:123:0 6,0:123:0 6,2:123:0 6,3:127:0 6,4:123:3 7,0:123:1 7,1:123:1 7,2:127:0 7,3:123:3 8,2:123:0 9,1:123:0 9,2:126:0 9,3:123:1 9,4:123:0',
    mineX3: '0,0:121:0 0,1:121:0 1,0:123:0 1,1:123:0 2,0:127:0 2,1:123:3 3,0:123:0 4,0:123:0 4,1:121:0',
    smeltX3: '0,0:123:1 0,1:127:1 0,2:123:1 0,3:123:0 1,0:113:0 1,2:123:3 1,3:126:0 2,3:123:0 3,0:123:0 3,2:123:0 3,3:126:0 4,0:123:0 4,1:113:0 4,3:123:0 5,0:123:0 5,3:123:0 6,0:123:0 6,1:123:0 6,2:113:0 7,0:123:0 7,1:123:0 8,0:123:0 8,1:123:0 8,2:123:0 9,0:114:0 9,1:114:0 9,2:114:0',
  });

  const ui = { ensureStyle, ICONS, row, group, field, setModified, inputBox, check, seg, confirmBtn, createPanel, createChrome, createLogView, togglePanel };

  const titleTimer = HAS_DOM ? setInterval(applyTitle, 2000) : 0;
  addEventListener?.('pagehide', flushLedger);

  W.idleCore = {
    version: 1,
    walk, sleep, sleepWake, waitConfirm, tune, markSend, lastRtt, nowTick, seeTick, sock,
    h, makeDraggable, toast, ledger: ledgerApi, ui,
    setBadge, notify, askNotify, notifyPerm, stopAll, reserves, floorDesigns,
    exportConfig, importConfig, exportFile, importFile, missingFields,
    _unload() {
      unloaded = true;
      sock.ws?.removeEventListener('message', onMessage); sock.ws = null;
      if (HAS_DOM) removeEventListener('keydown', onKey, true);
      clearInterval(titleTimer);
      flushLedger();
      if (HAS_DOM) { uiStyleEl?.remove(); toastBox?.remove(); uiStyleEl = toastBox = null; dockObs?.disconnect(); dockObs = null; }
    },
  };
})();
} catch (e) { console.error('[IdleCorp] shared core failed to load:', e); }
// @@END core

