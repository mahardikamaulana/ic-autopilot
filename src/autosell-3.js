// continues the autosell closure from autosell-2.js (same try / IIFE)
  // ---- load ---------------------------------------------------------------------------------------------------------------
  W.autoSell = {
    start, stop, jobs: listJobs, status, items, open: openMenu, cfg,
    get running() { return jobs.size > 0; },
    _decide: decide, _unitCost: unitCost, _order: jobOrder,
    _unload() { unloaded = true; jobs.clear(); wake?.(); if (mounted) unmountUi(); },
  };

  restore();
  if (HAS_DOM) (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    if (unloaded) return;
    mountUi();
    if (jobs.size) { core.ledger.add(TAG, 'info', 'resumed ' + jobs.size + ' auto ship job' + (jobs.size > 1 ? 's' : '') + ' from the last session'); loop(); }
    console.log('[autoSell] ready: "Auto ship" button on every bid in the Market table, or autoSell.start({ deal, total, keep })');
  })();
})();
} catch (e) { console.error('[IdleCorp] Auto ship failed to load:', e); }
// @@END autosell
