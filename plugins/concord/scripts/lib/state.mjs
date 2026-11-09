// Durable run state outside the tracked checkout: <git-common-dir>/concord/.
// Safe IDs, atomic JSON writes, a per-repo lock, and working-state fingerprints.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './proc.mjs';

export const RUN_ID = /^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export class ConcordError extends Error {
  constructor(message, code = 'error', details = undefined) { super(message); this.code = code; if (details) this.details = details; }
}

/** Resolve the repository top level and the state root (in git internals, never tracked). */
export function locate(repoArg) {
  const start = path.resolve(repoArg || process.cwd());
  const r = git(start, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { allowFail: true });
  if (r.status !== 0) throw new ConcordError(`not a git repository: ${start}`, 'not_git');
  const [top, common] = r.stdout.trim().split('\n');
  const stateRoot = process.env.CONCORD_STATE_DIR
    ? path.resolve(process.env.CONCORD_STATE_DIR)
    : path.join(common, 'concord');
  const repo = fs.realpathSync(top);
  let cwd = start; try { cwd = fs.realpathSync(start); } catch { /* keep */ }
  if (cwd !== repo && !cwd.startsWith(`${repo}${path.sep}`)) cwd = repo;
  return { repo, cwd, stateRoot, runsDir: path.join(stateRoot, 'runs') };
}

export function newRunId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export function runDir(loc, id) {
  if (typeof id !== 'string' || !RUN_ID.test(id)) throw new ConcordError(`invalid run id: ${JSON.stringify(id)}`, 'invalid_id');
  return path.join(loc.runsDir, id);
}

export function listRuns(loc) {
  try { return fs.readdirSync(loc.runsDir).filter((n) => RUN_ID.test(n)).sort(); } catch { return []; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Exclusive per-repo lock (one mutating helper at a time). A lock whose owner
 * process is gone is reported as stale and replaced; its run is not re-executed.
 */
export function acquireLock(loc, runId) {
  fs.mkdirSync(loc.stateRoot, { recursive: true });
  const file = path.join(loc.stateRoot, 'lock');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), run: runId, at: new Date().toISOString() });
  let stale = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      return { file, stale, release: () => { try { if (fs.readFileSync(file, 'utf8') === body) fs.unlinkSync(file); } catch { /* gone */ } } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* torn */ }
      if (owner && owner.host === os.hostname() && alive(owner.pid)) {
        throw new ConcordError(`another Concord helper (pid ${owner.pid}, run ${owner.run}) holds ${file}; do not start a duplicate: follow it with \`logs\`/\`status --light\`, or \`cancel\` it`, 'locked', { helper_pid: owner.pid, helper_run: owner.run });
      }
      stale = owner;
      try { fs.unlinkSync(file); } catch { /* raced */ }
    }
  }
  throw new ConcordError('could not acquire lock', 'locked');
}

/** Paths (tracked + untracked, honouring .gitignore) that make up the working state. */
function statePaths(loc) {
  const out = git(loc.repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const own = path.relative(loc.repo, loc.stateRoot);
  const ownInside = own && !own.startsWith('..') && !path.isAbsolute(own);
  return [...new Set(out.split('\0').filter(Boolean))]
    .filter((p) => !(ownInside && (p === own || p.startsWith(`${own}/`))))
    .sort();
}

/**
 * sha256 over (path, mode, content) of every tracked and non-ignored untracked
 * file. Excludes .git internals and Concord's own state. Deleted files count.
 */
export function fingerprint(loc) {
  const h = crypto.createHash('sha256');
  let files = 0;
  for (const rel of statePaths(loc)) {
    const abs = path.join(loc.repo, rel);
    h.update(rel); h.update('\0');
    let st;
    try { st = fs.lstatSync(abs); } catch { h.update('deleted\0'); continue; }
    if (st.isSymbolicLink()) h.update(`link:${fs.readlinkSync(abs)}\0`);
    else if (st.isFile()) {
      h.update(`${st.mode & 0o111 ? 'x' : '-'}:`);
      h.update(crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
      h.update('\0');
    } else {
      // Submodule/nested-repo contents are not hashed; never pretend to validate them.
      throw new ConcordError(`unsupported non-file entry in working state: ${rel} (submodules and nested repositories are not supported)`, 'submodule');
    }
    files++;
  }
  return { sha256: h.digest('hex'), files };
}

/** Gitlinks (mode 160000) and untracked nested repositories (`dir/` entries). */
export function gitlinks(loc) {
  const staged = git(loc.repo, ['ls-files', '-s', '-z']).split('\0').filter((l) => l.startsWith('160000 ')).map((l) => l.split('\t')[1]);
  const nested = git(loc.repo, ['ls-files', '-z', '--others', '--exclude-standard', '--directory']).split('\0')
    .filter((p) => p.endsWith('/') && fs.existsSync(path.join(loc.repo, p, '.git')));
  return [...staged, ...nested];
}

const inOwnState = (loc, p) => {
  const own = path.relative(loc.repo, loc.stateRoot);
  return own && !own.startsWith('..') && !path.isAbsolute(own) && (p === own || p.startsWith(`${own}/`));
};

/**
 * Parsed `git status --porcelain=v1 -z` entries {xy, path, orig?} for tracked + untracked
 * (non-ignored) changes. -z means names with spaces/unicode are never quoted or split.
 */
export function dirtyEntries(loc) {
  const f = git(loc.repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
  const out = [];
  for (let i = 0; i < f.length; i++) {
    if (f[i].length < 4) continue;
    const e = { xy: f[i].slice(0, 2), path: f[i].slice(3) };
    if (/[RC]/.test(e.xy)) e.orig = f[++i]; // rename/copy: next field is the source path
    if (!inOwnState(loc, e.path)) out.push(e);
  }
  return out;
}

export const formatEntry = (e) => `${e.xy} ${e.orig ? `${e.orig} -> ` : ''}${e.path}`;

/**
 * Exact content snapshot of the starting state as git TREE objects, built with a throwaway
 * copy of the index (GIT_INDEX_FILE). The user's real index is never written; nothing is
 * committed and no branch moves (only unreferenced blobs/trees are added to the object store).
 *   index_tree: what is staged (null if the index cannot be written as a tree, e.g. conflicts)
 *   work_tree:  tracked + non-ignored untracked files as they are on disk (excludes Concord state)
 */
export function snapshotTrees(loc, { staged = true } = {}) {
  const real = git(loc.repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-index-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    if (fs.existsSync(real)) {
      fs.copyFileSync(real, env.GIT_INDEX_FILE);
      // Backdate the copy: a fresh mtime would make git trust stale stat data ("racy git"), missing
      // same-size edits made within the timestamp granularity. Timestamp 1 (0 disables the check) forces every entry to be rehashed.
      fs.utimesSync(env.GIT_INDEX_FILE, 1, 1);
    }
    else git(loc.repo, ['read-tree', 'HEAD'], { env });
    let index_tree = null;
    if (staged) {
      const r = git(loc.repo, ['write-tree'], { env, allowFail: true });
      if (r.status === 0) index_tree = r.stdout.trim();
    }
    const own = path.relative(loc.repo, loc.stateRoot);
    const spec = own && !own.startsWith('..') && !path.isAbsolute(own) ? [`:(exclude,literal)${own}`] : [];
    git(loc.repo, ['add', '-A', '--', '.', ...spec], { env });
    return { index_tree, work_tree: git(loc.repo, ['write-tree'], { env }).trim() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
