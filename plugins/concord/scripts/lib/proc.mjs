// Bounded child processes: argv arrays only (shell:false), own process group,
// wall-clock timeout, group kill on timeout/cancel, output spooled to files.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const live = new Set();
const GRACE_MS = 3000;

function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

/** Kill every live child group (used by the helper's SIGINT/SIGTERM handler). */
export function killAll() {
  for (const child of live) killGroup(child, 'SIGKILL');
}

/**
 * Run argv[0] with argv[1..] and no shell. stdout/stderr go to files (bounded
 * memory). Resolves {code, signal, timedOut, error, ms}; never rejects.
 */
export function run(argv, { cwd, env, timeoutMs, stdoutPath, stderrPath, stdinPath } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
    throw new TypeError('argv must be a non-empty array of strings');
  }
  const started = Date.now();
  return new Promise((resolve) => {
    const out = fs.openSync(stdoutPath ?? '/dev/null', 'w');
    const err = fs.openSync(stderrPath ?? '/dev/null', 'w');
    const inp = stdinPath ? fs.openSync(stdinPath, 'r') : 'ignore';
    let child;
    let timedOut = false;
    let timer;
    let killer;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killer);
      if (child) live.delete(child);
      for (const fd of [out, err, inp]) if (typeof fd === 'number') try { fs.closeSync(fd); } catch { /* closed */ }
      resolve({ ...result, timedOut, ms: Date.now() - started });
    };
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd, env, shell: false, detached: true, stdio: [inp, out, err],
      });
    } catch (e) {
      done({ code: null, signal: null, error: e.message });
      return;
    }
    live.add(child);
    child.on('error', (e) => done({ code: null, signal: null, error: e.code === 'ENOENT' ? `command not found: ${argv[0]}` : e.message }));
    child.on('exit', (code, signal) => {
      // Reap leftovers of the group (background grandchildren) as well.
      killGroup(child, 'SIGKILL');
      done({ code, signal, error: null });
    });
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, 'SIGTERM');
        killer = setTimeout(() => killGroup(child, 'SIGKILL'), GRACE_MS);
      }, timeoutMs);
    }
  });
}

/** Short synchronous git call (local, no network). Throws with stderr on failure. */
export function git(cwd, args, { allowFail = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, maxBuffer, timeout: 60000 });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return allowFail ? r : r.stdout;
}

/** Last `bytes` of a file as UTF-8 (for log tails), or '' if missing. */
export function tail(path, bytes = 4000) {
  try {
    const st = fs.statSync(path);
    const fd = fs.openSync(path, 'r');
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

/** Find an executable on PATH without running it (no network, no inference). */
export function which(name, envPath = process.env.PATH ?? '') {
  if (name.includes('/')) return isExec(name) ? name : null;
  for (const dir of envPath.split(':')) {
    if (dir && isExec(`${dir}/${name}`)) return `${dir}/${name}`;
  }
  return null;
}

function isExec(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}
