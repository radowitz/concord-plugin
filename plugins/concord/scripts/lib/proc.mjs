// Bounded child processes: argv arrays only (shell:false), own process group,
// wall-clock timeout, group kill on timeout/cancel, output spooled to files as it arrives.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

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
 * Splits a decoded text stream into lines. UTF-8 is decoded by StringDecoder (a multi-byte
 * character split across chunks is never corrupted). A line longer than `maxLine` is emitted
 * as `partial` fragments, so an unterminated line can never grow without bound.
 */
class LineSplitter {
  constructor(stream, { onLine, onChunk, maxLine }) {
    Object.assign(this, { stream, onLine, onChunk, maxLine, pending: '', dec: new StringDecoder('utf8') });
  }
  write(buf) { this.feed(this.dec.write(buf)); }
  feed(text) {
    if (!text) return;
    this.onChunk?.(text, this.stream);
    let s = this.pending + text; let i;
    while ((i = s.indexOf('\n')) >= 0) {
      this.onLine?.(s.slice(0, i).replace(/\r$/, ''), { stream: this.stream, partial: false });
      s = s.slice(i + 1);
    }
    while (s.length > this.maxLine) {
      this.onLine?.(s.slice(0, this.maxLine), { stream: this.stream, partial: true });
      s = s.slice(this.maxLine);
    }
    this.pending = s;
  }
  end() {
    this.feed(this.dec.end());
    if (this.pending) this.onLine?.(this.pending, { stream: this.stream, partial: false });
    this.pending = '';
  }
}

/**
 * Run argv[0] with argv[1..] and no shell. stdout/stderr are piped, written byte-for-byte to
 * the given files as they arrive (so readers can follow a live process), and also delivered to
 * bounded onChunk/onLine callbacks. The wall-clock limit is `timeoutMs`, or the live value of
 * `deadline()` when given (re-read every tick; 0/undefined = no limit, e.g. manual waiting).
 * `onHeartbeat` fires every `heartbeatMs` and is informational only: it never kills anything.
 * Resolves {code, signal, timedOut, error, ms, pid, stdoutBytes, stderrBytes, lastOutputAt,
 * firstOutputMs}; never rejects.
 */
export function run(argv, {
  cwd, env, timeoutMs, deadline, stdoutPath, stderrPath, stdinPath,
  onLine, onChunk, onSpawn, onHeartbeat, heartbeatMs = 0, maxLine = 1024 * 1024, tickMs = 200,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
    throw new TypeError('argv must be a non-empty array of strings');
  }
  const started = Date.now();
  const limitMs = deadline ?? (() => timeoutMs || 0);
  return new Promise((resolve) => {
    const out = stdoutPath ? fs.openSync(stdoutPath, 'w') : null;
    const err = stderrPath ? fs.openSync(stderrPath, 'w') : null;
    const inp = stdinPath ? fs.openSync(stdinPath, 'r') : 'ignore';
    const fds = { stdout: out, stderr: err };
    const stats = { stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null, firstOutputMs: null };
    let child; let timedOut = false; let killer; let ticker; let fallback;
    let settled = false; let exited = null; let closed = false; let lastBeat = started;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker); clearTimeout(killer); clearTimeout(fallback);
      if (child) live.delete(child);
      for (const fd of [out, err, inp]) if (typeof fd === 'number') try { fs.closeSync(fd); } catch { /* closed */ }
      resolve({ ...result, timedOut, ms: Date.now() - started, pid: child?.pid ?? null, ...stats });
    };
    const settle = () => { if (exited && closed) finish({ ...exited, error: null }); };
    const splitters = {};
    for (const name of ['stdout', 'stderr']) {
      splitters[name] = new LineSplitter(name, { onLine, onChunk, maxLine });
    }
    const onData = (name) => (buf) => {
      const fd = fds[name];
      if (fd !== null) { try { fs.writeSync(fd, buf); } catch { /* disk full etc.: keep draining */ } }
      stats[`${name}Bytes`] += buf.length;
      stats.lastOutputAt = Date.now();
      if (stats.firstOutputMs === null) stats.firstOutputMs = stats.lastOutputAt - started;
      try { splitters[name].write(buf); } catch { /* a consumer bug must not wedge the child */ }
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached: true, stdio: [inp, 'pipe', 'pipe'] });
    } catch (e) {
      finish({ code: null, signal: null, error: e.message });
      return;
    }
    live.add(child);
    try { onSpawn?.(child.pid); } catch { /* informational */ }
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    child.on('error', (e) => finish({ code: null, signal: null, error: e.code === 'ENOENT' ? `command not found: ${argv[0]}` : e.message }));
    child.on('close', () => {
      for (const s of Object.values(splitters)) { try { s.end(); } catch { /* consumer */ } }
      closed = true; settle();
    });
    child.on('exit', (code, signal) => {
      // Reap leftovers of the group (background grandchildren) as well; that also closes inherited pipes.
      killGroup(child, 'SIGKILL');
      exited = { code, signal };
      fallback = setTimeout(() => { closed = true; settle(); }, 1500);
      settle();
    });
    ticker = setInterval(() => {
      const t = Date.now();
      const limit = limitMs();
      if (limit > 0 && !timedOut && t - started >= limit) {
        timedOut = true;
        killGroup(child, 'SIGTERM');
        killer = setTimeout(() => killGroup(child, 'SIGKILL'), GRACE_MS);
      }
      if (heartbeatMs > 0 && onHeartbeat && t - lastBeat >= heartbeatMs) {
        lastBeat = t;
        try {
          onHeartbeat({ elapsedMs: t - started, sinceOutputMs: stats.lastOutputAt ? t - stats.lastOutputAt : null,
            outputYet: stats.lastOutputAt !== null, pid: child.pid, limitMs: limit, timedOut, ...stats });
        } catch { /* informational */ }
      }
    }, tickMs);
  });
}

/** Short synchronous git call (local, no network). Throws with stderr on failure. */
export function git(cwd, args, { allowFail = false, maxBuffer = 64 * 1024 * 1024, env } = {}) {
  // GIT_OPTIONAL_LOCKS=0: read-only commands (status, diff) must never rewrite the user's real index.
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, maxBuffer, timeout: 120000,
    env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0' } });
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
