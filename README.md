# IC Autopilot

Userscript for [idlecorp.net](https://idlecorp.net/): an early-game Autopilot, CD Farm, Lab runner, Auto ship (with estimated and actual profit) and Auto utilities (power and water subscriptions that follow the load), each with a panel, menu or switch in the game UI.

## Install (and auto-update)

1. Install a userscript manager (Tampermonkey, Violentmonkey).
2. Open the raw file: <https://raw.githubusercontent.com/mahardikamaulana/ic-autopilot/main/ic-autopilot.user.js>. The manager offers to install it.
3. That is all. The script's `@updateURL` / `@downloadURL` point at the same file, so the manager checks it on its own schedule (Tampermonkey: daily by default; use *Check for userscript updates* to force it) and installs it whenever `@version` is higher.

If you ran an older copy of this toolkit (including the separate `cd-farm` and `early-game` scripts), remove it first, or both run side by side. The name and namespace are unchanged, so installing over an older "IC Autopilot" replaces it.

## Layout

| Path | What |
|---|---|
| `ic-autopilot.user.js` | **Built file, committed.** This is what auto-update downloads. Never edit it by hand. |
| `src/` | The sources: `header.js` (metadata, version), `core-*.js`, `cd-farm-*.js`, `lab-*.js`, `autosell-*.js`, `utilities.js`, `core-plan-*.js`, `cp-buildout-*.js`, `cp-cadence-*.js`, `autopilot-*.js` (a module split into numbered fragments continues the same closure) |
| `build.js` | Joins `src/` into the userscript |
| `test/` | Offline sim, headless tests, browser UI harness, saved game board used by them |

## Auto utilities

On the Utilities pages the **Load** tile (power) and the **Supply** tile (water) get an **Auto** switch. While it is on, the grid service / waterworks subscription follows what the groups need (their draw, minus what you generate or have stored, plus anything stalled groups wait for). It raises at once and lowers only after the load has stayed down for a while (default 10 minutes, and only in the minute before a bill), because the game charges the extra level up front on a raise and refunds nothing on a lower. It never spends cash it does not have, and while Autopilot runs it never lowers power below what Autopilot itself subscribes. Both switches are off by default and are saved in the browser.

From the console: `autoUtil.set('power', true)`, `autoUtil.status()`, `autoUtil.conf.power.spare = 2` (extra MW above the need), `autoUtil.conf.holdMin = 15`.

## Module watch

On the Module Exchange page a **Watch** button opens a list of filters in the game's own words (`overclock`, `refiner`, `mythic`, `twinned >= 10`, `price <= 500`). A listing that matches a filter alerts you once: a toast while the tab is visible, a desktop notification while it is hidden, and a tab-title badge until you open the Module Exchange. It never buys. With the page closed, it asks the server for the watched listings itself, one filter at a time. Watches are saved in this browser: `moduleWatch.add('overclock mythic price <= 500')`, `moduleWatch.status()`.

## Auto modules

On the Modules page an **Auto modules** switch (on by default) arranges your modules, free and installed, over the group sockets for the most value per hour: the best set on each group, in the best socket order, the strongest modules where they are worth the most. It scores each layout with the game engine's own module report (every quirk, neighbor bonus and coupling included) at catalog prices, and only changes the setup when that adds at least 2%. Each move is one Remove then one Install, confirmed in the game state before the next. Efficiency counts the power and water it saves (Auto utilities lowers the subscription to match), Calibrator the retail price its quality adds, and Instrumented (Manufacturing Data) and Insightful (Lab success, so less MD per result) count in MD, which only breaks ties: dollars always win. Only modules of an unknown kind stay put; fleet sockets and paused groups are left alone. From the console: `autoModules.status()`, `autoModules.plan()`, `autoModules.set(false)`.

## Develop

Needs [bun](https://bun.sh).

```sh
bun build.js                     # build ic-autopilot.user.js from src/
bun build.js --check             # fails if the built file is out of date
bun test/toolkit-test.js         # headless checks (core, Lab, Auto ship, Auto utilities, Autopilot guards)
bun test/early-game-sim.js all 44   # offline early-game simulation, every scenario
bun test/ui-harness.js check     # browser checks (Playwright + local Chrome; set PLAYWRIGHT_PATH / CHROME_PATH if needed)
```

The tests and the sim read the built file, so build first.

## Release

Userscript managers only update when `@version` goes up, so every release is:

```sh
bun build.js --bump              # patch; or: --bump minor / --bump major. Raises @version in src/header.js and rebuilds
bun run test
git commit -am "Release x.y.z" && git push
```

GitHub serves raw files through a cache of a few minutes, so an update can take that long to become visible. CI (`.github/workflows/check.yml`) fails when the committed built file does not match `src/`.

## Notes

- It talks to the game through the page's own WebSocket and only works while the tab is open. Everything runs live by default: Autopilot, Core plan, Lab and CD Farm resume live after a reload (Core plan after its 60 s cancel window); Dry run is still available through its switch.
- **Keep online** (Autopilot settings, Connection): the game's socket watchdog only runs while the tab reports itself visible, so the script makes the page report visible. Nothing is sent to the server. Turn it off with the switch or `keepOnline.set(false)`.
- Connection problems pause a feature instead of stopping it: unconfirmed commands while the socket is resyncing are not counted; after repeated real rejections Lab, Auto utilities and Auto ship retry every 10 minutes, and CD Farm's Auto cooldown retries after its wait. Only Alt+Shift+X and each feature's own Stop stay stopped.
- If the repository is renamed or moved, update the four URLs in `src/header.js` (`@homepageURL`, `@supportURL`, `@updateURL`, `@downloadURL`) and rebuild.