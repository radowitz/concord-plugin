// Provider stream handling: normalise Codex JSONL / Grok streaming-json lines into small
// events, collect the Grok answer text, probe Grok output-format support, and read run logs
// safely. Pure functions plus a cached `--help` probe; no network, no model calls.
import fs from 'node:fs';
import path from 'node:path';
import { run as runProc } from './proc.mjs';
import { ConcordError, SAFE_ID, readJson, writeJson } from './state.mjs';

const MAX_TEXT = 4 * 1024 * 1024; // collected Grok answer text cap
const clip = (s, n = 300) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * One normaliser per provider step. `push(line)` returns {event, progress}: a compact event
 * (persisted in events.jsonl) and an optional human progress string (stderr). Thought /
 * reasoning content is never rendered as progress and never copied into events (it stays
 * only in the raw stdout log).
 */
export class Normalizer {
  constructor(provider) {
    this.provider = provider;
    this.counts = {};
    this.text = '';
    this.textBytes = 0;
    this.recognized = 0;
    this.ended = false;
    this.errors = [];
    this.failed = null; // Codex turn.failed (terminal, sticky)
    this.unrecovered = null; // last error event not followed by turn.completed
    this.overflow = false;
    this.lastProgress = new Map();
  }

  bump(type) { this.counts[type] = (this.counts[type] ?? 0) + 1; }

  push(line, { partial = false } = {}) {
    if (partial) { this.bump('oversize_fragment'); return { event: { type: 'oversize_fragment', bytes: line.length } }; }
    const trimmed = line.trim();
    if (!trimmed) return {};
    let o;
    try { o = JSON.parse(trimmed); } catch { this.bump('non_json'); return { event: { type: 'non_json', bytes: line.length } }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) { this.bump('non_event'); return { event: { type: 'non_event' } }; }
    const r = this.provider === 'codex' ? this.codex(o) : this.grok(o);
    this.bump(r.event.type);
    return r;
  }

  // ---- Codex `exec --json` (thread.started / turn.started / item.* / turn.completed / error)
  codex(o) {
    const t = o.type;
    if (t === 'thread.started') { this.recognized++; return { event: { type: 'session.started' }, progress: 'session started' }; }
    if (t === 'turn.started') { this.recognized++; return { event: { type: 'turn.started' }, progress: 'turn started' }; }
    if (t === 'item.started' || t === 'item.completed') {
      this.recognized++;
      const it = o.item ?? {};
      const kind = typeof it.type === 'string' ? it.type : 'unknown';
      if (kind === 'reasoning') return { event: { type: t, item: 'reasoning' } }; // content never shown
      if (t === 'item.completed' && kind === 'agent_message') {
        const n = typeof it.text === 'string' ? it.text.length : 0;
        return { event: { type: 'message', chars: n }, progress: `answer message received (${n} chars)` };
      }
      const label = clip(it.command ?? it.title ?? it.name ?? '', 120);
      return { event: { type: t, item: kind, ...(label ? { label } : {}) }, progress: `${kind} ${t === 'item.started' ? 'started' : 'done'}${label ? `: ${label}` : ''}` };
    }
    if (t === 'turn.completed') {
      this.recognized++; this.ended = true; this.unrecovered = null; // a transient error is recovered by a later success
      const usage = o.usage && typeof o.usage === 'object' ? o.usage : undefined; // as reported, never estimated
      return { event: { type: 'turn.completed', ...(usage ? { usage } : {}) }, progress: 'turn completed' };
    }
    if (t === 'turn.failed' || t === 'error') {
      this.recognized++;
      const msg = clip(o.message ?? o.error?.message ?? 'provider reported an error', 500);
      this.errors.push(msg);
      if (t === 'turn.failed') this.failed = msg; else this.unrecovered = msg;
      return { event: { type: 'error', message: msg }, progress: `provider error: ${msg}` };
    }
    return { event: { type: 'other', raw_type: clip(String(t), 60) } };
  }

  // ---- Grok `--output-format streaming-json`: text / tool_call / tool_call_update / usage / end / error
  grok(o) {
    const t = o.type;
    if (t === 'text') {
      this.recognized++;
      const d = typeof o.data === 'string' ? o.data : '';
      if (this.textBytes + d.length > MAX_TEXT) this.overflow = true;
      else { this.text += d; this.textBytes += d.length; }
      return { event: { type: 'text', chars: d.length }, progress: this.throttled('text', `answer text streaming (${this.textBytes} chars so far)`) };
    }
    if (t === 'tool_call' || t === 'tool_call_update') {
      this.recognized++;
      const title = clip(o.title ?? '', 120); const kind = o.kind; const status = o.status;
      return { event: { type: t, ...(title ? { title } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}) },
        progress: this.throttled(`tool:${title}:${status}`, `${t === 'tool_call' ? 'tool call' : 'tool update'}${title ? `: ${title}` : ''}${status ? ` (${status})` : ''}`, 0) };
    }
    if (t === 'usage') {
      this.recognized++;
      const { type: _t, ...rest } = o;
      return { event: { type: 'usage', usage: rest } }; // reported figures only
    }
    if (t === 'end') { this.recognized++; this.ended = true; return { event: { type: 'end', ...(o.sessionId ? { session: clip(String(o.sessionId), 80) } : {}) }, progress: 'stream ended' }; }
    if (t === 'error') {
      this.recognized++;
      const msg = clip(o.message ?? 'provider reported an error', 500);
      this.errors.push(msg);
      return { event: { type: 'error', message: msg }, progress: `provider error: ${msg}` };
    }
    if (typeof t === 'string' && /thought|thinking|reasoning/i.test(t)) {
      this.recognized++; return { event: { type: 'thought', hidden: true } }; // content stays only in the raw log
    }
    if (typeof t === 'string' && t.startsWith('x.ai/')) {
      this.recognized++; return { event: { type: 'lifecycle', name: clip(t, 80) } };
    }
    return { event: { type: 'other', raw_type: clip(String(t), 60) } };
  }

  /** Rate-limit repetitive progress lines (e.g. one per streamed text fragment). */
  throttled(key, text, everyMs = 10000) {
    const now = Date.now();
    if (everyMs && now - (this.lastProgress.get(key) ?? 0) < everyMs) return undefined;
    this.lastProgress.set(key, now);
    return text;
  }
}

/**
 * Codex stream verdict (the final CONTENT always comes from the -o file). A stream with no recognised
 * events is the documented legacy case and is not judged. Otherwise it must end in a successful turn:
 * turn.failed, an error not recovered by a later turn.completed, or a truncated stream is rejected.
 */
export function codexStreamResult(n) {
  if (n.recognized === 0) return {};
  if (n.failed) return { error: `codex turn failed: ${n.failed}` };
  if (n.unrecovered) return { error: `codex stream ended with an unrecovered error: ${n.unrecovered}` };
  if (!n.ended) return { error: 'codex stream ended without a successful turn.completed (truncated or interrupted output)' };
  return {};
}

/**
 * Final Grok answer from a finished stream. Returns {text} or {error}. A stream with no
 * recognised events at all is treated as legacy whole-JSON output by the caller.
 */
export function grokStreamResult(n) {
  if (n.errors.length) return { error: `provider error event: ${n.errors[0]}` };
  if (n.overflow) return { error: 'answer text exceeded the 4 MiB cap' };
  if (!n.ended) return { error: 'stream ended without a terminal end event (truncated or interrupted output)' };
  if (!n.text.trim()) return { error: 'stream ended without any answer text' };
  return { text: n.text };
}

// ------------------------------------------------------------ Grok capability probe

/** Parse `grok --help` for the --output-format possible values. */
export function formatsFromHelp(help) {
  const m = /--output-format[\s\S]*?possible values:\s*([^\]]*)\]/i.exec(help);
  if (!m) return null;
  return m[1].split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * Choose the Grok output format. Probes `grok --help` once (a local help screen: no inference,
 * no network) and caches the result per binary path+size+mtime. Streaming-json is preferred;
 * if help lists formats without it, legacy `json` is used; if the probe itself fails the
 * streaming format is attempted and the step fails visibly if it is unsupported.
 */
export async function grokFormat(bin, cacheDir, tmpDir) {
  let key = bin;
  try { const st = fs.statSync(bin); key = `${bin}|${st.size}|${st.mtimeMs}`; } catch { /* PATH name */ }
  const file = path.join(cacheDir, 'grok-capabilities.json');
  try {
    const c = readJson(file);
    if (c?.key === key && typeof c.format === 'string') return { format: c.format, source: 'cached --help probe', formats: c.formats };
  } catch { /* none */ }
  fs.mkdirSync(tmpDir, { recursive: true });
  const out = path.join(tmpDir, 'grok-help.out');
  const r = await runProc([bin, '--help'], { timeoutMs: 15000, stdoutPath: out });
  let help = ''; try { help = fs.readFileSync(out, 'utf8'); } catch { /* none */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* none */ }
  const formats = r.code === 0 ? formatsFromHelp(help) : null;
  if (!formats) return { format: 'streaming-json', source: 'help probe unavailable; assuming documented streaming-json', formats: null };
  const format = formats.includes('streaming-json') ? 'streaming-json' : formats.includes('json') ? 'json' : 'plain';
  try { writeJson(file, { key, format, formats, probed_at: new Date().toISOString() }); } catch { /* cache is optional */ }
  return { format, source: 'grok --help probe', formats };
}

// ------------------------------------------------------------ safe log reading

export const STREAMS = ['stdout', 'stderr', 'events'];
export const MAX_READ = 65536;

/** Bytes of an incomplete UTF-8 sequence at the end of buf (0..3). */
function incompleteTail(buf) {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const b = buf[buf.length - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte; keep looking for the lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/**
 * Read at most `limit` bytes of a run log from byte `offset` (default: the tail). The path must
 * be a regular file (not a symlink) whose realpath stays inside the run's logs directory.
 */
export function readLogRange(runDirPath, rel, { offset, limit, final = true }) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new ConcordError('unsafe log path', 'usage');
  const logsRoot = path.join(runDirPath, 'logs');
  const file = path.join(runDirPath, rel);
  let lst;
  try { lst = fs.lstatSync(file); } catch { throw new ConcordError('log file does not exist yet', 'not_found'); }
  if (lst.isSymbolicLink() || !lst.isFile()) throw new ConcordError('refusing to read a symlink or non-regular log file', 'usage');
  const real = fs.realpathSync(file); const rootReal = fs.realpathSync(logsRoot);
  if (!real.startsWith(`${rootReal}${path.sep}`)) throw new ConcordError('log path escapes the run logs directory', 'usage');
  const size = lst.size;
  const lim = Math.max(1, Math.min(MAX_READ, limit));
  const tailMode = offset === undefined;
  const start = tailMode ? Math.max(0, size - lim) : Math.min(offset, size);
  const fd = fs.openSync(real, 'r');
  try {
    // An incomplete UTF-8 tail is always held back (even at the current EOF while the writer is live, unless
    // `final`), so the cursor stays on a character boundary and the appended bytes complete the character later.
    const attempt = (n) => {
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, start);
      let from = 0;
      if (tailMode && start > 0) while (from < buf.length && (buf[from] & 0xc0) === 0x80) from++;
      let to = buf.length;
      if (!final || start + to < size) to -= incompleteTail(buf.subarray(from, to));
      return { buf, from, to };
    };
    let r = attempt(Math.min(lim, size - start));
    // A limit smaller than the first character would never advance: read up to one full character (<= 4 bytes) instead.
    if (r.to <= r.from && lim < 4 && size - start > lim) r = attempt(Math.min(4, size - start));
    const { buf, from, to } = r;
    return { file: rel, size, offset: start + from, next_offset: start + to, bytes: to - from, eof: start + to >= size,
      truncated_head: tailMode && start > 0, held_incomplete_tail: start + to < size, text: buf.subarray(from, to).toString('utf8') };
  } finally { fs.closeSync(fd); }
}

export const validStepId = (s) => typeof s === 'string' && SAFE_ID.test(s);
