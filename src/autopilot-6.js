// continues the autopilot closure from autopilot-5.js (same try / IIFE)
  // ---- load ---------------------------------------------------------------------------

  W.earlyGame = {
    start, stop, plan, status, floors, offline, keepPaused, panel, read, decide, cfg, hold, release, reserve, tune, exportCfg, importCfg, resetCfg,
    get stalled() { return stalled; },
    get running() { return running; },
    get active() { return active; },
    get busy() { return isLive(); },   // sending live actions
    get held() { return heldReason(); },
    // Pure pieces for the offline simulator.
    _core: {
      checkGame, watchStall, stalledNow: () => stalled, resetWatch: () => { stalled = ''; prog.at = 0; lastPhase = null; },
      snapshot: fullSnapshot, normalize, decide, checklist, phaseOf, finish, observe, userPaused, billPaused, floorTable, bomOf, transferMsg,
      setClock: (fn) => { nowMs = fn; courierHoldUntil = 0; courierMisses = 0; cooldowns.clear(); successes.clear(); failures.clear(); for (const k in boosterLeft) delete boosterLeft[k]; },
    },
    _unload: () => {
      unloaded = true; running = false; holds.clear(); dropLock(); core.setBadge('AP', ''); core.reserves?.unregister('earlyGame');
      removeEventListener?.('pagehide', dropLock);
      if (HAS_DOM) unmountUi();
    },
  };

  // Calls go through the exported object so anything wrapping earlyGame.hold / release (tests, other scripts) still sees them.
  core.reserves?.register('earlyGame', {
    reserve: () => (W.earlyGame?.reserve ?? reserve)(),
    busy: () => (W.earlyGame ? W.earlyGame.busy : isLive()),
    hold: (w) => (W.earlyGame?.hold ?? hold)(w),
    release: (w) => (W.earlyGame?.release ?? release)(w),
  });

  // Wait for the game to render and connect before mounting or resuming.
  if (HAS_DOM) (async () => {
    while (!document.querySelector('.primary-navigation') || !read()) {
      if (unloaded) return;
      await sleep(500);
    }
    mountUi();
    console.log('[earlyGame] ready (dry run by default). Open "Autopilot" in the sidebar, or earlyGame.status() / earlyGame.plan() / earlyGame.start()');
    if (W.cdFarm?.running) console.warn('[earlyGame] CD Farm is running; Autopilot waits until it stops.');
    if (wasRunning && cfg.autoResume) {
      while (!read()?.wsOpen) { if (unloaded) return; await sleep(500); }
      await sleep(2000); // let the fresh snapshot land
      if (unloaded || running) return;
      // A crashed or discarded tab never released its lock (no pagehide): it expires 60 s after its last heartbeat. A live tab keeps
      // refreshing its lock, so this waits at most ~66 s for it to let go, then says so in the ledger instead of resuming.
      for (let w = 0; lockOwner() && lockOwner() !== TAB; w++) {
        if (w === 33) { core.ledger.add('AP', 'fail', 'not resumed: another tab is running Autopilot'); return; }
        await sleep(2000);
        if (unloaded || running) return;
      }
      let live = false;
      if (cfg.liveResume && liveFlag) { live = await liveCountdown(); if (unloaded || running) return; }
      cfg.dryRun = !live;
      console.log(live ? '[earlyGame] resuming the run from before the reload, LIVE (liveResume)'
        : '[earlyGame] resuming the run from before the reload (as a DRY RUN: switch to Live in the panel to send again)');
      start();
    }
  })();
})();
} catch (e) { console.error('[IdleCorp] Autopilot failed to load:', e); }
