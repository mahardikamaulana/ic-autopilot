// ==UserScript==
// @name         IC Autopilot
// @namespace    idlecorp-toolkit
// @version      2.8.8
// @author       XPARAD0X
// @description  Early-game Autopilot, CD Farm (Construction Data by building and demolishing buildings; Auto picks the cheapest source itself), Lab runner (keeps the Manufacturing Labs researching), Auto ship (an "Auto ship" button on every distributor bid) and Auto utilities (an "Auto" switch that keeps the power and water subscriptions at what the groups need) for IdleCorp, each with a panel, menu or switch in the game UI.
// @homepageURL  https://github.com/mahardikamaulana/ic-autopilot
// @supportURL   https://github.com/mahardikamaulana/ic-autopilot/issues
// @updateURL    https://raw.githubusercontent.com/mahardikamaulana/ic-autopilot/main/ic-autopilot.user.js
// @downloadURL  https://raw.githubusercontent.com/mahardikamaulana/ic-autopilot/main/ic-autopilot.user.js
// @match        https://idlecorp.net/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==
//
// Generated from src/*.js by build.js: edit those, then run
//   bun build.js            (bun build.js --bump  raises @version first: Tampermonkey only updates when it goes up)
//
// Parts in one file; Core plan (window.corePlan, console only for now) reads the stage of the core game plan and sends its unlocks and early land.
// CD Farm and Autopilot talk through window.cdFarm and window.earlyGame,
// all of them use the shared core, and each part is wrapped separately.
//   0. Core      (window.idleCore)  one cached read of the game state, one socket listener, confirm
//                                   waiting, activity log, alerts, Alt+Shift+X stops everything,
//                                   settings export / import, UI kit (idleCore.ui: panel shell with
//                                   tabs, sidebar tab + chip, log view, toasts, one stylesheet)
//   1. CD Farm   (window.cdFarm)    sidebar tab "CD Farm"
//   2. Autopilot (window.earlyGame) sidebar tab "Autopilot"
//   3. Lab       (window.labRunner) sidebar tab "Lab": StartResearch whenever a Manufacturing Lab's
//                                   slot is free, ClaimResearch for finished results (dry run by default)
//   4. Auto ship (window.autoSell)  "Auto ship" button left of Sell on every distributor bid in the Market table:
//                                   a menu like the game's auto-ship menu, selling by FillDeal over the socket
//                                   (no slot limit), plus an "Auto ship" jobs table on the Market page
//   5. Auto utilities (window.autoUtil) an "Auto" switch on the Load tile (power) and the Supply tile (water) of the
//                                   Utilities pages: the grid service / waterworks subscription follows the load
// File order is core, CD Farm, Lab, Auto ship, Auto utilities, Autopilot: Autopilot stays last (the simulator evals it to the end of the file).
// This replaces the separate cd-farm.user.js and early-game.user.js: uninstall those two first, or both copies run side by side.