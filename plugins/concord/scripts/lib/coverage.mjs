// Conservative check-coverage warnings. Compares the files a plan (or the actual change) touches
// with the directory the selected check runs in and with package.json boundaries. It reads only
// "does a package.json exist here" metadata: script contents are NOT analysed, so Concord never
// claims a check covers something; it only says what it cannot show.
import fs from 'node:fs';
import path from 'node:path';
import { isDocPath } from './workflow.mjs';

const MAX_FILES = 12;

/** Nearest ancestor directory (repo-relative, '' = root) that holds a package.json; null if none. */
function packageDir(repo, file) {
  let dir = path.posix.dirname(file);
  for (;;) {
    const d = dir === '.' ? '' : dir;
    if (fs.existsSync(path.join(repo, d, 'package.json'))) return d;
    if (d === '') return null;
    dir = path.posix.dirname(dir);
  }
}

const within = (file, dir) => dir === '' || file === dir || file.startsWith(`${dir}/`);

/**
 * @param repo        absolute repo root
 * @param files       repo-relative files the plan/changes touch
 * @param selection   run.test_selection ({mode, cwd, kind, ...}) or null for legacy runs
 */
export function checkCoverage(repo, files, selection, taskIds = []) {
  const cwd = (selection?.cwd || '').replace(/\\/g, '/').replace(/^\.\/?$/, '');
  const explicit = !selection || selection.mode === 'explicit';
  const outside = []; const unknown = [];
  const code = [...new Set(files)].filter((f) => typeof f === 'string' && f && !isDocPath(f));
  for (const f of code) {
    if (!within(f, cwd)) { outside.push(f); continue; }
    if (explicit) continue; // user-chosen command: only the directory is checkable
    const pkg = packageDir(repo, f);
    // An auto-selected `<pm> run <script>` belongs to the package in `cwd`. A file owned by a different, deeper
    // package may or may not be reached by that script; script metadata cannot prove it.
    if (pkg !== null && pkg !== cwd) unknown.push(f);
  }
  const warnings = [];
  if (outside.length) {
    warnings.push({ reason: 'outside_check_cwd', files: outside.slice(0, MAX_FILES), count: outside.length,
      message: `${outside.length} planned/changed file(s) lie outside the directory the check runs in (${cwd || '.'}); that check cannot be shown to cover them.` });
  }
  if (unknown.length) {
    warnings.push({ reason: 'nested_package_unknown', files: unknown.slice(0, MAX_FILES), count: unknown.length,
      message: `${unknown.length} file(s) belong to a nested package; whether the selected script reaches them cannot be determined from package metadata.` });
  }
  if (!code.length && !files.length && taskIds.length) {
    warnings.push({ reason: 'no_files_listed', files: [], count: 0, message: 'The plan lists no files, so check coverage is unknown.' });
  }
  return {
    status: warnings.length ? 'warning' : 'ok',
    check: { cwd: cwd || '.', mode: selection?.mode ?? 'explicit', kind: selection?.kind ?? 'custom' },
    warnings,
    basis: 'file paths vs check directory and package.json boundaries; script contents are not analysed, so "ok" means no gap was detected, not that the files are tested',
  };
}
