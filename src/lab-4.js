// continues the lab closure from lab-3.js (same try / IIFE)
  // ---- load ----------------------------------------------------------------------------------------

  W.labRunner = {
    start, stop, status, panel, read, cfg, exportCfg, importCfg, resetCfg,
    get running() { return running; },
    get active() { return active; },        // a run is still executing (maybe finishing a step after stop())
    get stopReason() { return stopReason; },
    get mem() { return mem; },
    // Pure decision for the tests: no I/O, no side effects.
    _decide: decide,
    _unload: () => { unloaded = true; running = false; kick?.(); if (HAS_DOM) unmountUi(); },
  };

  // Wait for the game to render and connect before mounting.
  if (HAS_DOM) (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    if (unloaded) return;
    mountUi();
    if (cfg.keepLive && saved.live === true && !running) start({ dryRun: false });   // start() still refuses Live when the game data changed
    console.log('[labRunner] ready (dry run by default). Open "Lab" in the sidebar, or labRunner.status() / labRunner.start()');
  })();
})();
} catch (e) { console.error('[IdleCorp] Lab runner failed to load:', e); }
// @@END lab

