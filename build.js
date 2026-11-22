// Builds ic-autopilot.user.js from src/*.js (header, core, pacer, planner, cd-farm, lab, autosell, utilities, autopilot, in that order).
//
//   bun build.js                          # write the userscript
//   bun build.js --check                  # exit 1 if the userscript differs from what the sources build
//   bun build.js --force                  # overwrite even if the userscript was edited by hand
//   bun build.js --bump [patch|minor|major]   # raise @version in src/header.js first (default patch), then build
//
// The sim and the tests read the built file, so rebuild before running them. If the userscript was edited
// by hand since the last build, the build stops instead of overwriting those edits: move them into
// src/ (or pass --force).
// Autopilot stays last: the offline simulator and the tests eval it from its "@@MODULE early-game" marker to the end of the file.
// Auto-update: the header's @updateURL / @downloadURL point at this file on GitHub; a userscript manager only installs an
// update when @version is higher than what it has, so every release is: bun build.js --bump, commit, push.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'ic-autopilot.user.js');
const STAMP = path.join(SRC, '.built-sha');          // local only (git-ignored): the hash of the last build, to spot hand edits
const PARTS = ['header.js', 'core.js', 'pacer.js', 'planner.js', 'cd-farm.js', 'lab.js', 'autosell.js', 'utilities.js', 'autopilot.js'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const args = process.argv.slice(2);

if (args.includes('--bump')) {
  const kind = ['patch', 'minor', 'major'].find((k) => k === args[args.indexOf('--bump') + 1]) ?? 'patch';
  const file = path.join(SRC, 'header.js');
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^(\/\/ @version\s+)(\d+)\.(\d+)\.(\d+)\s*$/m);
  if (!m) { console.error('no "// @version x.y.z" line in src/header.js'); process.exit(1); }
  const [maj, min, pat] = [+m[2], +m[3], +m[4]];
  const next = kind === 'major' ? [maj + 1, 0, 0] : kind === 'minor' ? [maj, min + 1, 0] : [maj, min, pat + 1];
  fs.writeFileSync(file, text.replace(m[0], () => m[1] + next.join('.')));
  console.log('version ' + [maj, min, pat].join('.') + ' -> ' + next.join('.'));
}

const built = PARTS.map((p) => fs.readFileSync(path.join(SRC, p), 'utf8')).join('');
const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;

if (args.includes('--check')) {
  if (have === built) { console.log('ic-autopilot.user.js is up to date with src'); process.exit(0); }
  console.error('ic-autopilot.user.js differs from what src builds (run bun build.js)');
  process.exit(1);
}
if (have != null && have !== built && !args.includes('--force')) {
  const last = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8').trim() : null;
  if (last && sha(have) !== last) {
    console.error('ic-autopilot.user.js was edited by hand since the last build: not overwriting it.');
    console.error('Move those edits into src/*.js, or run with --force to discard them.');
    process.exit(1);
  }
}
fs.writeFileSync(OUT, built);
fs.writeFileSync(STAMP, sha(built) + '\n');
console.log('built ' + path.relative(process.cwd(), OUT) + ' (' + built.split('\n').length + ' lines) from ' + PARTS.length + ' parts');