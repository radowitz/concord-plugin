// Focused check autodiscovery from real package.json metadata. Pure local file reads:
// no shell, no installs, no network, no workspace scanning. Never guesses a command.
import fs from 'node:fs';
import path from 'node:path';
import { which } from './proc.mjs';

const PMS = ['npm', 'pnpm', 'yarn', 'bun'];
// Preference order: real tests first, then static checks, then lint/build.
const PREFERRED = [['test', 'test'], ['check', 'check'], ['typecheck', 'typecheck'], ['lint', 'lint'], ['build', 'build']];
const LOCKS = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']];
export const KIND_NOTE = {
  custom: 'CUSTOM command specified by the user: Concord cannot verify that it executes behavioural tests (it may be a typecheck, lint or build)',
  test: 'runs the project test script',
  check: 'a generic "check" script; not necessarily behavioural tests',
  typecheck: 'TYPECHECK ONLY: verifies types, does not execute behavioural tests',
  lint: 'LINT ONLY: static analysis, does not execute behavioural tests',
  build: 'BUILD ONLY: verifies the project compiles, does not execute behavioural tests',
};

const PLACEHOLDER = /no test specified|^\s*(?:echo|printf|true|:|exit\s+0)\b[^&|;]*$|^\s*$/i;
const AUTOFIX = /(?:^|\s)--(?:fix|write)(?:\s|=|$)/;
const WATCH = /(?:^|\s)(?:--watch(?:All)?|-w)(?:\s|=|$)|\bnodemon\b|\bwatch\b/i;

export function scriptProblem(body) {
  if (typeof body !== 'string') return 'not a string';
  if (PLACEHOLDER.test(body)) return 'placeholder (does nothing / always fails or passes)';
  if (AUTOFIX.test(body)) return 'auto-fix/write flag (would mutate source during validation)';
  if (WATCH.test(body)) return 'watch mode (never terminates)';
  return null;
}

function readPkg(dir) {
  try { const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); return p && typeof p === 'object' ? p : null; } catch { return null; }
}

function detectPm(pkg, dir, repo) {
  const m = /^(npm|pnpm|yarn|bun)@/.exec(typeof pkg.packageManager === 'string' ? pkg.packageManager : '');
  if (m) return { pm: m[1], how: 'packageManager field' };
  const found = new Set(); const files = [];
  for (let d = dir; ; d = path.dirname(d)) {
    for (const [f, pm] of LOCKS) if (fs.existsSync(path.join(d, f))) { found.add(pm); files.push(path.relative(repo, path.join(d, f))); }
    if (found.size || d === repo || d === path.dirname(d)) break;
  }
  if (found.size > 1) return { error: `conflicting lockfiles (${files.join(', ')}) and no packageManager field` };
  if (found.size === 1) return { pm: [...found][0], how: `lockfile ${files[0]}` };
  return { pm: 'npm', how: 'no packageManager/lockfile; npm default' };
}

/** Conservative: only `<pm> test` / `<pm> run test` is a known test script; everything else is custom. */
export function classifyExplicit(argvList) {
  const known = argvList.length > 0 && argvList.every((a) => PMS.includes(a[0]) && ((a.length === 2 && a[1] === 'test') || (a.length === 3 && a[1] === 'run' && a[2] === 'test')));
  return known ? 'test' : 'custom';
}

/** Nearest package.json from cwd up to the repo root that yields a reliable script. */
export function discoverChecks(loc, env = process.env) {
  const repo = loc.repo; const cwd = loc.cwd || repo;
  const skipped = []; let sawPackage = false;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const pkg = readPkg(dir);
    const rel = path.relative(repo, dir) || '.';
    if (pkg) {
      sawPackage = true;
      const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
      const pm = detectPm(pkg, dir, repo);
      if (pm.error) skipped.push({ package: rel, reason: pm.error });
      else {
        for (const [name, kind] of PREFERRED) {
          if (!(name in scripts)) continue;
          const problem = scriptProblem(scripts[name]);
          if (problem) { skipped.push({ package: rel, script: name, reason: problem }); continue; }
          if (!which(pm.pm, env.PATH)) { skipped.push({ package: rel, script: name, reason: `${pm.pm} is not on PATH` }); continue; }
          return { selected: { argv: [pm.pm, 'run', name], cwd: rel === '.' ? '' : rel, kind, script: name, package_manager: pm.pm,
            source: `${rel === '.' ? '' : `${rel}/`}package.json scripts.${name} (${pm.how})`, note: KIND_NOTE[kind] }, skipped };
        }
      }
    }
    if (dir === repo || dir === path.dirname(dir)) break;
  }
  return { selected: null, skipped,
    reason: sawPackage ? 'package.json found but no reliable test/check/typecheck/lint/build script' : 'no package.json between the working directory and the repository root' };
}
