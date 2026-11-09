#!/usr/bin/env node
// 贞观·政事堂 · Concord — native Claude Code plugin helper (Node builtins only).
// Short-lived commands; durable state in <git-common-dir>/concord/runs/<id>/.
// The current Claude Code session (or its native subagents) writes all code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, killAll, run as runProc, tail, which } from './lib/proc.mjs';
import { Normalizer, STREAMS, codexStreamResult, grokFormat, grokStreamResult, readLogRange, validStepId } from './lib/stream.mjs';
import { checkCoverage } from './lib/coverage.mjs';
import {
  ConcordError, acquireLock, dirtyEntries, fingerprint, formatEntry, gitlinks, listRuns, locate, newRunId,
  readJson, runDir, snapshotTrees, writeJson,
} from './lib/state.mjs';
import {
  CLAUDE_TIERS, DOCS, RISK, TTL_S, cachePath, catalogAge, loadCatalog, refreshCatalog, resolveExternal, routeTask,
} from './lib/models.mjs';
import * as W from './lib/workflow.mjs';
import { KIND_NOTE, classifyExplicit, discoverChecks } from './lib/checks.mjs';

const VERSION = '0.2.2';
const SELF = fileURLToPath(import.meta.url);
const OPEN = new Set(['active', 'awaiting_session', 'failed', 'validated']);
const LIMITS = { cli_timeout_s: [480, 30, 3600], test_timeout_s: [300, 10, 3600], max_repairs: [2, 0, 5] };
const DEFAULT_REVIEW_TIMEOUT_S = 1800; // per external role (Codex/Grok); 0 = no helper deadline (manual)
const MAX_REVIEW_TIMEOUT_S = 86400;
const SPEC_KEYS = new Set(['request', 'tests', 'tests_cwd', 'policy', 'models', 'limits', 'require_clean']);
const EXTERNAL = { proposal: 'codex', review: 'grok', plan: 'codex', qa: 'codex' };
const MAX_NOTE = 4000;
const MAX_DIFF = 150 * 1024;
const MAX_AMEND = 8000;
const MAX_AMENDMENTS = 20;
const heartbeatMs = () => Number(process.env.CONCORD_HEARTBEAT_MS) || 30000;

const HELP = `贞观·政事堂 · Concord ${VERSION} — Claude Code plugin helper (Node builtins only)

Usage: node concord.mjs <command> [options]

Commands (all short-lived; no daemon; state in <git-dir>/concord/runs/<id>):
  preflight [--repo P] [--json] [--require-clean]
                                      Local checks only: git, CLIs on PATH, model cache. A dirty tree is a
                                      warning (pre-existing work is recorded as the run baseline);
                                      --require-clean makes it a failure.
                                      Runs no model CLI, no inference, no networking.
  models [--refresh] [--json]         Show cached model catalog. --refresh asks local CLIs
                                      (codex debug models, grok models) for account-listed models.
  checks [--repo P] [--json]          Show the check command Concord would autodetect from package.json
                                      (nearest package from the cwd; scripts/packageManager/lockfiles).
  logs RUN [--step ID] [--attempt N] [--command N] [--stream stdout|stderr|events]
           [--offset BYTES] [--limit BYTES] [--json]
                                      Read-only, bounded view of a step's raw logs / normalised events
                                      (default: tail of the running or latest step). Works while a helper
                                      holds the lock. Use next_offset to follow incrementally.
  extend RUN --review-timeout S       Change the Codex/Grok wall-clock limit of a run (S seconds from the
                                      step's start; 0 = no helper deadline) - picked up by a live helper.
  start --spec FILE [--repo P]        Create a run from a JSON spec. A dirty checkout is allowed: its exact
                                      state is snapshotted as the baseline (spec require_clean:true refuses).
  advance RUN [--done STEP --revision N [--executor subagent|main] [--note-file F]]
              [--failed STEP --revision N --note-file F] [--retry] [--budget S] [--one-step]
                                      Execute helper-owned steps (Codex/Grok/tests/QA) until the
                                      session must act; prints the next action as JSON on stdout and
                                      progress/heartbeat lines on stderr. --one-step runs exactly one
                                      stage (use it with a background Bash task). --budget S bounds a
                                      foreground call (default: no budget).
  amend RUN --spec FILE [--writer-stopped]
                                      Record a mid-run user amendment ({"kind":"clarify|scope","text":...});
                                      bumps the revision and invalidates validation. Refused while a helper
                                      runs; --writer-stopped asserts no native writer is still editing.
  status [RUN|latest] [--json] [--light]
                                      Persisted status, roles, models, 政事堂议事 artifacts, revision,
                                      timeline, per-stage timing. --light skips the working-state fingerprint.
  list                                List runs in this repository.
  show RUN STEP                       Print one stored artifact (bounded).
  resume RUN                          Mark stale in-progress steps interrupted; print next action.
  interrupt RUN                       Stop the live helper's current stage (process groups killed) but keep the run
                                      OPEN: the stage is recorded interrupted; amend and/or continue afterwards.
  cancel RUN                          Stop a live helper for RUN and close the run (files untouched).
  (advance/resume/amend/extend/interrupt/approve/cancel only work from the worktree the run was started in;
   from another worktree of the same repository they fail with wrong_worktree.)
  approve RUN --decision approve|reject [--note-file F]
                                      Record the human decision bound to the validated state.
                                      Never merges, pushes or deploys.

Spec (JSON): {"request": str, "tests" (optional; autodetected when omitted): [["npm","test"]] | ["npm test"],
  "tests_cwd" (optional, explicit tests only): repo-relative dir the tests run in (default: the directory
  start was invoked from),
  "policy": "full"|"fast", "models": {"proposal","review","plan","qa": id|"account_default",
  "worker","repair": "haiku"|"sonnet"|"opus"}, "limits": {"cli_timeout_s","test_timeout_s","max_repairs",
  "review_timeout_s" (default 1800; 0 = manual, no deadline), "role_timeout_s": {"proposal|review|plan|qa": s}},
  "require_clean": false}
Test strings are split into argv (simple quotes only); shell operators are rejected. No shell is used.

Env: CONCORD_CODEX_BIN, CONCORD_GROK_BIN (CLI paths), CONCORD_STATE_DIR, CONCORD_CACHE_DIR,
     CONCORD_HEARTBEAT_MS (soft progress notice interval, default 30000; never stops a process).
${W.METAPHOR}`;

// ------------------------------------------------------------------ utilities

function parseArgs(argv) {
  const pos = []; const opt = {};
  const flags = new Set(['--json', '--refresh', '--retry', '--help', '-h', '--version', '--require-clean', '--light', '--one-step', '--writer-stopped']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) opt[a.replace(/^-+/, '')] = true;
    else if (a.startsWith('--')) {
      if (i + 1 >= argv.length) throw new ConcordError(`${a} needs a value`, 'usage');
      opt[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

const now = () => new Date().toISOString();
const bins = () => ({ codex: process.env.CONCORD_CODEX_BIN || 'codex', grok: process.env.CONCORD_GROK_BIN || 'grok' });

/** Split a test command string into argv without a shell; reject shell syntax. */
export function splitCommand(s) {
  if (/[|&;<>`$(){}*?~\n\\]/.test(s.replace(/'[^']*'|"[^"]*"/g, ''))) {
    throw new ConcordError(`test command uses shell syntax; give an argv array instead: ${s}`, 'spec');
  }
  const out = []; const re = /'([^']*)'|"([^"]*)"|(\S+)/g; let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function readNote(file) {
  if (!file) return null;
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  return text.length > MAX_NOTE ? `${text.slice(0, MAX_NOTE)}…[truncated]` : text;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new ConcordError('spec must be a JSON object', 'spec');
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) throw new ConcordError(`unknown spec key: ${k}`, 'spec');
  if (typeof spec.request !== 'string' || !spec.request.trim() || spec.request.length > 20000) {
    throw new ConcordError('spec.request must be a non-empty string (≤ 20000 chars)', 'spec');
  }
  // tests omitted → autodiscovered in start; an explicit list (even empty) is never second-guessed.
  if (spec.tests !== undefined && (!Array.isArray(spec.tests) || spec.tests.length === 0 || spec.tests.length > 10)) {
    throw new ConcordError('spec.tests needs 1..10 test commands (or omit it to autodetect); Concord never passes without real checks', 'no_tests');
  }
  const tests = spec.tests?.map((t) => {
    const argv = typeof t === 'string' ? splitCommand(t) : t;
    if (!Array.isArray(argv) || !argv[0] || !argv.every((a) => typeof a === 'string' && !a.includes('\0'))) {
      throw new ConcordError(`invalid test command: ${JSON.stringify(t)}`, 'spec');
    }
    return argv;
  });
  const policy = spec.policy ?? 'full';
  if (!['full', 'fast'].includes(policy)) throw new ConcordError('spec.policy must be full or fast', 'spec');
  const m = spec.models ?? {};
  for (const k of Object.keys(m)) if (!(k in EXTERNAL) && k !== 'worker' && k !== 'repair') throw new ConcordError(`unknown models key: ${k}`, 'spec');
  for (const k of ['worker', 'repair']) if (m[k] !== undefined && !CLAUDE_TIERS.includes(m[k])) throw new ConcordError(`models.${k} must be one of ${CLAUDE_TIERS.join('|')}`, 'spec');
  const limits = {};
  for (const [k, [def, lo, hi]] of Object.entries(LIMITS)) {
    const v = spec.limits?.[k] ?? def;
    if (!Number.isInteger(v) || v < lo || v > hi) throw new ConcordError(`limits.${k} must be an integer in ${lo}..${hi}`, 'spec');
    limits[k] = v;
  }
  const secs = (v, name) => {
    if (!Number.isInteger(v) || v < 0 || v > MAX_REVIEW_TIMEOUT_S) throw new ConcordError(`${name} must be an integer in 0..${MAX_REVIEW_TIMEOUT_S} (0 = no helper deadline)`, 'spec');
    return v;
  };
  // Codex/Grok wall-clock limit: explicit review_timeout_s, else an explicit legacy cli_timeout_s, else 30 minutes.
  limits.review_timeout_s = spec.limits?.review_timeout_s !== undefined ? secs(spec.limits.review_timeout_s, 'limits.review_timeout_s')
    : spec.limits?.cli_timeout_s !== undefined ? limits.cli_timeout_s : DEFAULT_REVIEW_TIMEOUT_S;
  if (spec.limits?.role_timeout_s !== undefined) {
    const rt = spec.limits.role_timeout_s;
    if (!rt || typeof rt !== 'object' || Array.isArray(rt)) throw new ConcordError('limits.role_timeout_s must be an object', 'spec');
    limits.role_timeout_s = {};
    for (const [k, v] of Object.entries(rt)) {
      if (!(k in EXTERNAL)) throw new ConcordError(`unknown limits.role_timeout_s role: ${k}`, 'spec');
      limits.role_timeout_s[k] = secs(v, `limits.role_timeout_s.${k}`);
    }
  }
  for (const k of Object.keys(spec.limits ?? {})) if (!(k in LIMITS) && k !== 'review_timeout_s' && k !== 'role_timeout_s') throw new ConcordError(`unknown limits key: ${k}`, 'spec');
  if (spec.tests_cwd !== undefined) {
    if (spec.tests === undefined) throw new ConcordError('spec.tests_cwd only applies to explicit spec.tests (autodetected checks run in their package directory)', 'spec');
    if (typeof spec.tests_cwd !== 'string' || !spec.tests_cwd.trim() || spec.tests_cwd.includes('\0')) throw new ConcordError('spec.tests_cwd must be a repo-relative directory string', 'spec');
  }
  if (spec.require_clean !== undefined && typeof spec.require_clean !== 'boolean') throw new ConcordError('spec.require_clean must be a boolean', 'spec');
  return { request: spec.request, tests: tests ?? null, tests_cwd: spec.tests_cwd ?? null, policy, models: m, limits, require_clean: spec.require_clean === true };
}

// ------------------------------------------------------------------ run store

class Store {
  constructor(loc, id) { this.loc = loc; this.id = id; this.dir = runDir(loc, id); this.file = path.join(this.dir, 'run.json'); }
  load() {
    if (!fs.existsSync(this.file)) throw new ConcordError(`no such run: ${this.id}`, 'not_found');
    this.run = readJson(this.file); return this.run;
  }
  save() { this.run.updated_at = now(); writeJson(this.file, this.run); }
  p(...parts) { const f = path.join(this.dir, ...parts); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; }
  artifact(name, value) { writeJson(this.p('artifacts', `${name}.json`), value); return `artifacts/${name}.json`; }
  readArtifact(name) { try { return readJson(this.p('artifacts', `${name}.json`)); } catch { return null; } }
}

function resolveRunId(loc, arg) {
  if (!arg || arg === 'latest') {
    const ids = listRuns(loc);
    if (!ids.length) throw new ConcordError('no Concord runs in this repository', 'not_found');
    return ids[ids.length - 1];
  }
  runDir(loc, arg); // validates
  return arg;
}

let current = null; // {store, step} for signal-time failure persistence

// ---- observability: stderr progress, per-run timeline, scan counters

const perf = { fingerprint: { count: 0, ms: 0 }, snapshot: { count: 0, ms: 0 } };
const timed = (key, fn) => {
  const t = Date.now();
  try { return fn(); } finally { perf[key].count += 1; perf[key].ms += Date.now() - t; }
};
const fp = (loc) => timed('fingerprint', () => fingerprint(loc));
const fmtS = (ms) => (ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

function say(store, stepId, msg) {
  process.stderr.write(`[concord ${store.id}${stepId ? ` ${stepId}` : ''}] ${msg}\n`);
}

function timeline(store, entry) {
  try { fs.appendFileSync(store.p('timeline.jsonl'), `${JSON.stringify({ at: now(), ...entry })}\n`); } catch { /* informational */ }
}

function recentTimeline(store, n = 15) {
  try {
    const lines = fs.readFileSync(path.join(store.dir, 'timeline.jsonl'), 'utf8').trim().split('\n');
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Live control file (`extend`): read by the running helper's deadline timer, written by another process. */
let controlCache = { at: 0, dir: null, value: null };
function readControl(store, fresh = false) {
  const t = Date.now();
  if (!fresh && controlCache.dir === store.dir && t - controlCache.at < 400) return controlCache.value;
  let value = null;
  try { value = readJson(path.join(store.dir, 'control.json')); } catch { /* none */ }
  controlCache = { at: t, dir: store.dir, value };
  return value;
}

/** Effective wall-clock limit (seconds, 0 = none) for an external role: live extension > per-role > run-wide > legacy. */
function roleTimeoutS(store, key) {
  const r = store.run;
  const live = readControl(store)?.review_timeout_s;
  return Number.isInteger(live) ? live : r.limits.role_timeout_s?.[key] ?? r.limits.review_timeout_s ?? r.limits.cli_timeout_s;
}

const limitText = (s) => (s === 0 ? 'no limit (manual; cancel to stop)' : `limit ${s}s`);

function beginStep(store, id, role, extra = {}) {
  const r = store.run;
  const attempt = r.steps.filter((s) => s.id === id).length + 1;
  const step = { id, attempt, role, label: W.ROLES[role].label, provider: W.ROLES[role].provider, status: 'running', started_at: now(),
    revision: W.revisionOf(r), helper_pid: process.pid, ...extra };
  r.steps.push(step); store.save();
  current = { store, step };
  timeline(store, { type: 'stage.start', step: id, attempt, role, provider: step.provider, revision: step.revision });
  return step;
}

function endStep(store, step, status, extra = {}) {
  Object.assign(step, { status, ended_at: now(), ms: Date.parse(now()) - Date.parse(step.started_at) }, extra);
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') {
    store.run.status = 'failed';
    store.run.failure = { step: step.id, attempt: step.attempt, error: step.error, kind: step.failure_class, at: step.ended_at,
      ...(status === 'interrupted' ? { interrupted: true, by_user: true } : {}) };
  }
  store.save();
  timeline(store, { type: 'stage.end', step: step.id, attempt: step.attempt, status, ms: step.ms, ...(step.failure_class ? { failure_class: step.failure_class } : {}) });
  say(store, step.id, `${status === 'passed' ? '✓' : '✗'} ${status} after ${fmtS(step.ms)}${step.error ? ` — ${step.error.split('\n')[0].slice(0, 160)}` : ''}`);
  current = null;
}

/** A passed Grok review at or after the run's review floor (raised by scope amendments); revision-less steps are revision 1. */
const reviewCurrent = (r) => r.steps.some((x) => x.id === 'review' && x.status === 'passed' && (x.revision ?? 1) >= (r.review_floor ?? 1));

/** Mark steps left `running` by a dead helper as interrupted (never auto re-run). */
function markStale(store) {
  const stale = store.run.steps.filter((s) => s.status === 'running');
  for (const s of stale) {
    Object.assign(s, { status: 'interrupted', ended_at: now(), error: 'helper exited while this step was running; not re-executed automatically', failure_class: 'interrupted' });
  }
  if (stale.length) {
    store.run.status = 'failed';
    store.run.failure = { step: stale[0].id, attempt: stale[0].attempt, error: stale[0].error, at: now(), interrupted: true, kind: 'interrupted' };
    store.save();
  }
  return stale.map((s) => s.id);
}

// ------------------------------------------------------------------ external CLI steps

const EVENT_FILE_CAP = 2 * 1024 * 1024;

async function runCli(store, stepId, role, prompt, schema) {
  const r = store.run;
  const key = stepId.replace(/-\d+$/, ''); // proposal | review | plan | qa
  const route = r.models[key];
  const provider = W.ROLES[role].provider;
  const b = bins();
  let fmt = null;
  if (provider === 'grok') fmt = await grokFormat(b.grok, path.dirname(cachePath()), path.join(os.tmpdir(), `concord-grokcaps-${process.pid}`));
  const step = beginStep(store, stepId, role, { provider, model: route.model, model_evidence: route.evidence,
    ...(fmt ? { output_format: fmt.format, output_format_source: fmt.source } : {}) });
  const a = step.attempt;
  const promptFile = store.p('prompts', `${stepId}.a${a}.txt`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  const schemaFile = store.p('prompts', `${stepId}.schema.json`);
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const out = store.p('logs', `${stepId}.a${a}.stdout.log`);
  const err = store.p('logs', `${stepId}.a${a}.stderr.log`);
  const evf = store.p('logs', `${stepId}.a${a}.events.jsonl`);
  fs.writeFileSync(evf, '');
  const rel = (f) => path.relative(store.dir, f);
  const logs = { stdout: rel(out), stderr: rel(err), events: rel(evf) };
  const modelArgs = route.model === 'account_default' ? [] : ['--model', route.model];
  let argv; let cwd = store.loc.repo; let stdinPath = null; let tmp = null;
  const last = store.p('logs', `${stepId}.a${a}.last.txt`);
  if (provider === 'codex') {
    // --json streams JSONL events on stdout for progress/logs; the -o file stays the authoritative final message.
    argv = [b.codex, 'exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--color', 'never', '-C', store.loc.repo,
      '--output-schema', schemaFile, '-o', last, ...modelArgs, '-'];
    stdinPath = promptFile;
  } else {
    // Independent review: empty temp cwd, no tools at all (`--tools ""`), a single turn;
    // the prompt carries all context. Schema and wall-clock limit still apply.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-review-'));
    cwd = tmp;
    argv = [b.grok, '--prompt-file', promptFile, '--output-format', fmt.format, '--cwd', tmp, '--permission-mode', 'plan',
      '--tools', '', '--no-subagents', '--disable-web-search', '--max-turns', '1', '--json-schema', JSON.stringify(schema), ...modelArgs];
  }
  const timeoutS0 = roleTimeoutS(store, key);
  Object.assign(step, { logs, timeout_s: timeoutS0, timeout_changes: [],
    argv: argv.map((x) => (x === promptFile ? '<prompt-file>' : x.length > 200 ? `<${x.length} chars>` : x)) });
  store.save();

  const norm = new Normalizer(provider === 'codex' ? 'codex' : 'grok');
  const streaming = provider === 'codex' || fmt.format === 'streaming-json';
  const bytes = { stdout: 0, stderr: 0 }; let lastOutput = null; let evBytes = 0; let evSeq = 0; let evDropped = 0; let lastSave = 0;
  const activity = () => ({ last_output_at: lastOutput ? new Date(lastOutput).toISOString() : null, bytes: { ...bytes },
    event_counts: { ...norm.counts }, no_output: lastOutput === null });
  const persist = (force) => {
    const t = Date.now();
    if (!force && t - lastSave < 2000) return;
    lastSave = t; Object.assign(step, activity()); store.save();
  };
  say(store, step.id, `▶ ${step.label} · ${provider}${route.model === 'account_default' ? '' : `:${route.model}`} — ${limitText(timeoutS0)}; ` +
    `soft notices every ${Math.round(heartbeatMs() / 1000)}s never stop it. Follow: logs ${r.id} --step ${step.id}; cancel: cancel ${r.id}`);
  const res = await runProc(argv, {
    cwd, env: process.env, stdoutPath: out, stderrPath: err, stdinPath, heartbeatMs: heartbeatMs(),
    deadline: () => {
      const s = roleTimeoutS(store, key);
      if (s !== step.timeout_s) {
        step.timeout_changes.push({ at: now(), from_s: step.timeout_s, to_s: s });
        say(store, step.id, `limit changed: ${limitText(step.timeout_s)} → ${limitText(s)} (extend)`);
        step.timeout_s = s; store.save();
      }
      return s * 1000;
    },
    onSpawn: (pid) => { step.pid = pid; store.save(); },
    onChunk: (text, stream) => { bytes[stream] += Buffer.byteLength(text); lastOutput = Date.now(); persist(false); },
    onLine: (line, { stream, partial }) => {
      if (stream !== 'stdout' || !streaming) return;
      const { event, progress } = norm.push(line, { partial });
      if (event) {
        evSeq += 1;
        const text = `${JSON.stringify({ seq: evSeq, at: now(), ...event })}\n`;
        if (evBytes + text.length <= EVENT_FILE_CAP) { fs.appendFileSync(evf, text); evBytes += text.length; } else evDropped += 1;
      }
      if (progress) say(store, step.id, progress);
    },
    onHeartbeat: (h) => {
      const counts = Object.entries(norm.counts).map(([k, v]) => `${k}×${v}`).join(' ');
      say(store, step.id, h.outputYet
        ? `still running ${fmtS(h.elapsedMs)} (${limitText(Math.round(h.limitMs / 1000))}); last output ${fmtS(h.sinceOutputMs)} ago${counts ? `; events ${counts}` : ''}`
        : `still running ${fmtS(h.elapsedMs)} (${limitText(Math.round(h.limitMs / 1000))}); no output from ${provider} yet (process ${h.pid} alive — waiting is normal; this notice does not stop it)`);
      timeline(store, { type: 'heartbeat', step: step.id, elapsed_ms: h.elapsedMs, no_output: !h.outputYet });
      persist(true);
    },
  });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  Object.assign(step, activity(), { process_ms: res.ms, first_output_ms: res.firstOutputMs, pid: res.pid, events_dropped: evDropped || undefined });
  const fail = (cls, error) => { endStep(store, step, 'failed', { error, failure_class: cls, logs }); return null; };
  if (res.error) return fail('process_error', `${res.error}: ${tail(err, 600).trim()}`.trim());
  if (res.timedOut) {
    return fail('timeout', `CLI timeout: ${step.provider} gave no final result within ${step.timeout_s}s; process group killed. This is a helper timeout, not a ${role} verdict (nothing was approved or rejected, no model was changed). ` +
      `Retry with advance --retry, or raise limits.review_timeout_s / use extend (0 = manual wait). ${tail(err, 300).trim()}`.trim());
  }
  if (res.code !== 0) return fail('exit', `exit ${res.code ?? res.signal}: ${tail(err, 600).trim()}`.trim());
  try {
    let parsed;
    if (provider === 'codex') {
      if (!fs.existsSync(last)) throw new W.Malformed(`no final message file${norm.errors.length ? ` (stream error: ${norm.errors[0]})` : ''}`);
      const c = codexStreamResult(norm);
      if (c.error) return fail('stream', `malformed codex stream: ${c.error}`);
      parsed = W.extractJson(fs.readFileSync(last, 'utf8'));
    } else if (fmt.format === 'streaming-json' && norm.recognized > 0) {
      const g = grokStreamResult(norm);
      if (g.error) return fail('stream', `malformed grok stream: ${g.error}`);
      parsed = W.extractJson(g.text);
    } else {
      // Legacy `--output-format json` (or a streaming run that emitted a single whole-JSON object).
      const size = fs.statSync(out).size;
      if (size > 8 * 1024 * 1024) throw new W.Malformed('output too large');
      parsed = W.unwrapGrok(fs.readFileSync(out, 'utf8'));
      step.legacy_whole_json = true;
    }
    return { step, parsed, logs };
  } catch (e) {
    return fail('malformed', `malformed ${role} output: ${e.message}`);
  }
}

function accept(store, res, validate, artifactName) {
  try {
    const value = validate(res.parsed);
    endStep(store, res.step, 'passed', { logs: res.logs, artifact: store.artifact(artifactName, res.parsed) });
    return value;
  } catch (e) {
    store.artifact(`${artifactName}.rejected.a${res.step.attempt}`, res.parsed);
    endStep(store, res.step, 'failed', { error: `malformed ${res.step.role} output rejected: ${e.message}`, logs: res.logs });
    return null;
  }
}

function setTasks(store, tasks) {
  const ov = store.run.models.worker_override;
  store.run.tasks = tasks.map((t) => {
    const { tier, reason } = routeTask(t, ov);
    return { ...t, status: 'pending', tier, tier_reason: reason };
  });
  // Conservative: compare planned files with the directory the check runs in; never claims coverage it cannot show.
  const cov = checkCoverage(store.loc.repo, store.run.tasks.flatMap((t) => t.files), store.run.test_selection, store.run.tasks.map((t) => t.id));
  store.run.check_coverage = { ...cov, basis_of_files: 'planned task files', computed_at: now(), revision: W.revisionOf(store.run) };
  if (cov.status === 'warning') say(store, null, `⚠ check coverage: ${cov.warnings.map((w) => w.message).join(' ')}`);
  if (store.run.replan) { store.run.task_history = [...(store.run.task_history ?? []), { revision: store.run.replan.from_revision, tasks: store.run.replan.completed }]; store.run.replan = null; }
}

// ------------------------------------------------------------------ helper-owned stages

const STAGES = {
  async proposal(store) {
    const r = store.run;
    if (r.policy === 'fast') {
      const res = await runCli(store, 'proposal', 'proposal_plan', W.proposalPlanPrompt(r), W.SCHEMAS.proposal_plan);
      if (!res) return;
      let tasks;
      const ok = accept(store, res, (v) => {
        W.validateProposal(v?.proposal);
        tasks = W.validatePlan(v.plan);
        return v;
      }, 'proposal');
      if (!ok) return;
      store.artifact('plan', ok.plan);
      if (W.docsOnlyTasks(tasks)) {
        setTasks(store, tasks);
        r.steps.push({ id: 'review', attempt: 1, role: 'review', label: W.ROLES.review.label, provider: 'grok', status: 'skipped', at: now(),
          reason: 'fast policy: trivial docs-only request and every planned file is documentation' });
        r.policy_notes.push('Grok review skipped: trivial docs-only request; plan touches documentation files only.');
        r.phase = 'implement';
      } else {
        r.policy_notes.push('fast policy reverted to full: combined plan touches non-documentation files; Grok review and re-plan required.');
        r.policy = 'full';
        r.phase = 'review';
      }
      store.save();
      return;
    }
    const res = await runCli(store, 'proposal', 'proposal', W.proposalPrompt(r), W.SCHEMAS.proposal);
    if (res && accept(store, res, W.validateProposal, 'proposal')) { r.phase = 'review'; store.save(); }
  },
  async review(store) {
    const r = store.run;
    const proposal = store.readArtifact('proposal');
    const files = git(store.loc.repo, ['ls-files']).split('\n').filter(Boolean);
    const changed = changedPaths(store);
    const ctx = {
      files: files.length > 400 ? `${files.slice(0, 400).join('\n')}\n…(${files.length - 400} more)` : files.join('\n'),
      plan: proposal?.plan ?? null, changed: changed.length ? changed.join('\n') : null, replan: r.replan?.completed,
    };
    const res = await runCli(store, 'review', 'review', W.reviewPrompt(r, proposal?.proposal ?? proposal, ctx), W.SCHEMAS.review);
    if (!res) return;
    const review = accept(store, res, W.validateReview, 'review');
    if (!review) return;
    if (review.verdict === 'reject') {
      r.status = 'failed';
      r.failure = { step: 'review', error: `门下省 · Grok 审议 rejected the proposal: ${review.summary}`, at: now(), rejected_by_review: true };
    } else r.phase = 'plan';
    store.save();
  },
  async plan(store) {
    const r = store.run;
    // Full policy: planning needs a passed Grok review that is not older than the last scope amendment.
    if (r.policy === 'full' && !reviewCurrent(r)) {
      r.phase = 'review'; r.policy_notes.push(`${now()}: no Grok review covers revision ${W.revisionOf(r)}; reviewing before planning.`); store.save(); return;
    }
    const proposal = store.readArtifact('proposal');
    const res = await runCli(store, 'plan', 'plan', W.planPrompt(r, proposal?.proposal ?? proposal, store.readArtifact('review')), W.SCHEMAS.plan);
    if (!res) return;
    let tasks;
    if (accept(store, res, (v) => { tasks = W.validatePlan(v); return v; }, 'plan')) {
      setTasks(store, tasks); r.phase = 'implement'; store.save();
    }
  },
  async test(store) {
    const r = store.run;
    const n = r.steps.filter((s) => s.role === 'test').length + 1;
    const id = `test-${n}`;
    const before = fp(store.loc);
    const sel = r.test_selection;
    // Saved runs without cwd metadata keep the documented fallback: the repository root.
    const cwdRel = sel?.cwd || '';
    const cwdSource = sel?.cwd !== undefined ? (sel.cwd_source ?? (sel.mode === 'auto' ? 'package directory' : 'recorded at start')) : 'saved run without cwd metadata: repository root fallback';
    const testCwd = path.join(store.loc.repo, cwdRel);
    const step = beginStep(store, id, 'test', { fingerprint: before.sha256, commands: [], check_kind: describeChecks(r).kind, check_source: sel?.source ?? 'spec.tests',
      cwd: cwdRel || '.', cwd_source: cwdSource });
    say(store, id, `▶ ${step.label} — ${r.tests.length} command(s) in ${cwdRel || '.'}, ${r.limits.test_timeout_s}s limit each; follow: logs ${r.id} --step ${id}`);
    let ok = true;
    let dirOk = false;
    try { dirOk = fs.statSync(testCwd).isDirectory() && fs.realpathSync(testCwd).startsWith(store.loc.repo); } catch { /* missing */ }
    if (!dirOk) {
      endStep(store, step, 'failed', { error: `check directory ${cwdRel || '.'} does not exist inside the repository; commands were not run`, failure_class: 'cwd_missing' });
      return;
    }
    for (const [i, argv] of r.tests.entries()) {
      const out = store.p('logs', `${id}.${i + 1}.stdout.log`);
      const err = store.p('logs', `${id}.${i + 1}.stderr.log`);
      const clogs = { stdout: path.relative(store.dir, out), stderr: path.relative(store.dir, err) };
      step.logs = clogs; step.current_command = i + 1; store.save();
      const res = await runProc(argv, { cwd: testCwd, env: { ...process.env, CONCORD_RUN_ID: r.id }, timeoutMs: r.limits.test_timeout_s * 1000, stdoutPath: out, stderrPath: err,
        heartbeatMs: heartbeatMs(), onSpawn: (pid) => { step.pid = pid; store.save(); },
        onHeartbeat: (h) => say(store, id, `still running ${fmtS(h.elapsedMs)} (limit ${r.limits.test_timeout_s}s) ${h.outputYet ? `last output ${fmtS(h.sinceOutputMs)} ago` : 'no output yet'}`) });
      const passed = !res.error && !res.timedOut && res.code === 0;
      step.commands.push({ argv, code: res.code, signal: res.signal, timed_out: res.timedOut, error: res.error, ms: res.ms, passed, cwd: cwdRel || '.', pid: res.pid,
        bytes: { stdout: res.stdoutBytes, stderr: res.stderrBytes }, logs: clogs });
      store.save();
      if (!passed) { ok = false; break; }
    }
    const after = fp(store.loc);
    if (after.sha256 !== before.sha256) {
      endStep(store, step, 'failed', { error: 'tests modified tracked or non-ignored files, so no exact working state was validated; gitignore test outputs or fix the tests, then advance --retry' });
      return;
    }
    if (ok) { endStep(store, step, 'passed'); r.phase = 'qa'; store.save(); return; }
    endStep(store, step, 'tests_failed');
    needRepair(store, { kind: 'tests', step: id, failures: step.commands.filter((c) => !c.passed).map((c) => ({
      argv: c.argv, code: c.code, timed_out: c.timed_out, error: c.error,
      stdout_tail: tail(path.join(store.dir, c.logs.stdout), 2500), stderr_tail: tail(path.join(store.dir, c.logs.stderr), 2500),
    })) });
  },
  async qa(store) {
    const r = store.run;
    const lastTest = [...r.steps].reverse().find((s) => s.role === 'test');
    const fpr = fp(store.loc).sha256;
    if (!lastTest || lastTest.status !== 'passed' || lastTest.fingerprint !== fpr) {
      r.phase = 'test'; r.policy_notes.push(`${now()}: working state changed after tests; re-running tests before QA.`); store.save(); return;
    }
    const n = r.steps.filter((s) => s.role === 'qa').length + 1;
    const diffAll = git(store.loc.repo, ['diff-tree', '-p', '-r', '--no-color', '--no-ext-diff', '--no-textconv', baseTree(r), currentTree(store.loc)]);
    const diff = diffAll.length > MAX_DIFF ? `${diffAll.slice(0, MAX_DIFF)}\n…[diff truncated at ${MAX_DIFF} bytes; inspect files directly]` : diffAll || '(no changes since the run started)';
    const had = new Set((r.baseline.dirty ?? []).filter((e) => e.xy === '??').map((e) => e.path));
    const untracked = git(store.loc.repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter((p) => p && !had.has(p)).join('\n');
    const kind = KIND_NOTE[lastTest.check_kind] ? lastTest.check_kind : 'custom';
    const tests = `${lastTest.commands.map((c) => `- ${JSON.stringify(c.argv)} exit ${c.code}`).join('\n')}${kind === 'test' ? '' : `\nNOTE (kind=${kind}): ${KIND_NOTE[kind]}. Passing it is NOT evidence that behaviour was tested; verify behaviour by reading the code.`}`;
    const plan = { summary: store.readArtifact('plan')?.summary, tasks: r.tasks.map(({ id, title, files, status }) => ({ id, title, files, status })) };
    const res = await runCli(store, `qa-${n}`, 'qa', W.qaPrompt(r, { plan, tests, diff, untracked }), W.SCHEMAS.qa);
    if (!res) return;
    const qa = accept(store, res, W.validateQA, `qa-${n}`);
    if (!qa) return;
    const after = fp(store.loc).sha256;
    Object.assign(res.step, { fingerprint: fpr, verdict: qa.verdict, blocking: qa.blocking, inconsistent: qa.inconsistent });
    if (after !== fpr) {
      res.step.status = 'failed'; res.step.error = 'working state changed during read-only QA; validation refused';
      r.status = 'failed'; r.failure = { step: res.step.id, error: res.step.error, at: now() }; store.save(); return;
    }
    if (qa.passed) {
      if (!fastGate(store, res.step.id)) return; // never validate a fast run with non-docs changes
      const cov = checkCoverage(store.loc.repo, [...changedPaths(store), ...r.tasks.flatMap((t) => t.files)], r.test_selection, r.tasks.map((t) => t.id));
      r.validation = { fingerprint: fpr, tests_step: lastTest.id, qa_step: res.step.id, check_kind: kind, check_note: KIND_NOTE[kind], at: now(),
        revision: W.revisionOf(r), check_cwd: lastTest.cwd ?? '.', check_coverage: { ...cov, basis_of_files: 'actual changed paths + planned task files' } };
      r.status = 'validated'; r.phase = 'done'; store.save(); return;
    }
    store.save();
    needRepair(store, { kind: 'qa', step: res.step.id, summary: qa.summary, inconsistent_verdict: qa.inconsistent,
      findings: qa.findings.filter((f) => f.blocking || qa.verdict === 'fail') });
  },
};

/**
 * Tree to compare against: the exact starting working content (v0.2.1+), or HEAD for
 * persisted v0.2.0 runs (those always started clean, so HEAD was the baseline).
 */
const baseTree = (r) => r.baseline.work_tree || r.baseline.head;
const currentTree = (loc) => timed('snapshot', () => snapshotTrees(loc, { staged: false }).work_tree);

/** Paths added/modified/deleted since the START baseline (pre-existing dirty work excluded). */
function changedPaths(store) {
  const { repo } = store.loc;
  return git(repo, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', baseTree(store.run), currentTree(store.loc)])
    .split('\0').filter(Boolean).sort();
}

/**
 * Fast policy skipped Grok on the promise of docs-only work. Check the ACTUAL changes;
 * anything outside the safe docs allowlist invalidates the skip and fails closed
 * (files preserved; `advance --retry` switches to full Grok review + re-plan).
 */
function fastGate(store, step) {
  const r = store.run;
  if (r.policy !== 'fast') return true;
  const bad = changedPaths(store).filter((p) => !W.isDocPath(p));
  if (!bad.length) return true;
  const skip = r.steps.find((s) => s.id === 'review' && s.status === 'skipped');
  if (skip) Object.assign(skip, { status: 'invalidated', invalidated_at: now(), invalidated_reason: 'actual changes outside safe docs' });
  r.policy_notes.push(`${now()}: fast gate failed after ${step}: changed ${bad.slice(0, 10).join(', ')}; Grok skip invalidated.`);
  r.status = 'failed';
  r.failure = { step, at: now(), fast_gate: true, paths: bad,
    error: `fast policy gate: actual changes outside safe docs (${bad.slice(0, 10).join(', ')}); Grok skip invalidated. Files were left as they are; advance --retry runs the full Grok review and re-plan.` };
  store.save();
  return false;
}

function needRepair(store, cause) {
  const r = store.run;
  if (r.repairs_used >= r.limits.max_repairs) {
    r.status = 'failed';
    r.failure = { step: cause.step, error: `repair budget exhausted (${r.repairs_used}/${r.limits.max_repairs}); ${cause.kind === 'tests' ? 'tests still failing' : 'QA findings remain'}`, at: now(), cause };
  } else {
    r.phase = 'repair';
    r.repair_cause = cause;
  }
  store.save();
}

// ------------------------------------------------------------------ next action

function describeChecks(r) {
  const s = r.test_selection ?? { mode: 'explicit', kind: 'custom', source: 'spec.tests (saved run without check metadata)' };
  const kind = KIND_NOTE[s.kind] ? s.kind : 'custom';
  return { mode: s.mode, commands: r.tests, cwd: s.cwd || '.', cwd_source: s.cwd === undefined ? 'saved run without cwd metadata: repository root fallback' : s.cwd_source ?? (s.mode === 'auto' ? 'package directory' : 'recorded at start'),
    kind, source: s.source, note: KIND_NOTE[kind], behavioural_tests: kind === 'test' };
}

/** Mutating commands always address the run's own checkout, never whichever worktree the caller happens to be in. */
function cmdFor(store, ...args) {
  return ['node', SELF, ...args, '--repo', store.run?.repo ?? store.loc.repo];
}

/**
 * Repair tier: highest tier among the tasks the failure relates to (by finding files when QA named
 * some, else all tasks), floor sonnet. Computed from difficulty/risk, never from a worker override.
 * A repair override from the spec always wins.
 */
function repairRoute(r) {
  if (r.models.repair_override) return { tier: r.models.repair_override, reason: 'per-role override' };
  const files = new Set((r.repair_cause?.findings ?? []).map((f) => f.file).filter(Boolean));
  let pool = r.tasks;
  if (files.size) { const hit = r.tasks.filter((t) => t.files.some((f) => files.has(f))); if (hit.length) pool = hit; }
  let best = { tier: 'sonnet', reason: 'default repair tier (no higher-risk task involved)', rank: CLAUDE_TIERS.indexOf('sonnet') };
  for (const t of pool) {
    const { tier, reason } = routeTask(t, null);
    const rank = CLAUDE_TIERS.indexOf(tier);
    if (rank > best.rank) best = { tier, reason: `inherits ${tier} from task ${t.id} (${reason})`, rank };
  }
  return { tier: best.tier, reason: best.reason };
}

/** What `advance` will run next (helper-owned stage), with the limit and a suggested background-Bash setup. */
function stageInfo(store, phase) {
  const r = store.run;
  const ph = phase ?? r.phase;
  const m = { proposal: r.policy === 'fast' ? 'proposal_plan' : 'proposal', review: 'review', plan: 'plan', qa: 'qa', test: 'test' }[ph];
  if (!m) return null;
  const n = r.steps.filter((s) => s.role === ph).length + 1;
  const step = ph === 'qa' ? `qa-${n}` : ph === 'test' ? `test-${r.steps.filter((s) => s.role === 'test').length + 1}` : ph;
  const limit_s = m === 'test' ? r.limits.test_timeout_s * r.tests.length : roleTimeoutS(store, ph);
  const provider = W.ROLES[m].provider;
  const bashMs = limit_s === 0 ? 7200000 : Math.min(7200000, (limit_s + 120) * 1000);
  return { step, role: m, provider, label: W.ROLES[m].label, limit_s, limit: limit_s === 0 ? 'none (manual; cancel to stop)' : `${limit_s}s`,
    background: { run_in_background: true, timeout_ms: bashMs, description: `Concord ${step} · ${provider === 'local' ? 'tests' : provider} · ${r.id}`,
      note: bashMs === 7200000 && limit_s !== 0 && limit_s + 120 > 7200 ? 'Claude Code caps a background Bash timeout at 2 h; the helper limit is longer than that' : undefined } };
}

function nextAction(store) {
  const r = store.run;
  const base = { run: r.id, status: r.status, phase: r.phase, policy: r.policy };
  if (r.status === 'failed') {
    return { ...base, action: 'failed', failure: r.failure,
      message: 'Run failed and is persisted. Report it to the user. Retry only if they ask: advance --retry (re-runs the failed step).', retry: cmdFor(store, 'advance', r.id, '--retry') };
  }
  if (['cancelled', 'approved', 'rejected'].includes(r.status)) return { ...base, action: 'none', message: `Run is ${r.status}.` };
  if (r.status === 'validated') {
    const cov = r.validation?.check_coverage;
    return { ...base, action: 'await_human', validation: r.validation, revision: W.revisionOf(r),
      message: '天子决之 · 人工审批: validated. The human reviews the working tree; an approval only records review bound to this exact state. Nothing is committed, pushed or deployed.' +
        (r.validation?.check_kind && r.validation.check_kind !== 'test' ? ` Validation gate was ${r.validation.check_kind}: ${r.validation.check_note}.` : '') +
        (cov?.status === 'warning' ? ` CHECK COVERAGE WARNING (report this in your summary): ${cov.warnings.map((w) => `${w.message} [${w.files.join(', ')}]`).join(' ')}` : '') };
  }
  if (r.phase === 'implement') {
    const done = new Set(r.tasks.filter((t) => t.status === 'done').map((t) => t.id));
    const t = r.tasks.find((x) => x.status !== 'done' && x.depends_on.every((d) => done.has(d)));
    const id = `task-${t.id}`;
    const rev = W.revisionOf(r);
    return { ...base, action: 'implement', step: id, task: t, tier: t.tier, tier_reason: t.tier_reason,
      agent: { subagent_type: 'general-purpose', model: t.tier },
      revision: rev, request: W.effectiveRequest(r), amendments: W.amendmentsOf(r),
      ...(r.check_coverage?.status === 'warning' ? { check_coverage: r.check_coverage, coverage_note: 'Tell the user about this coverage warning before/while implementing. Do not add checks or ask new questions because of it.' } : {}),
      rules: `Edit only what this task needs in the current checkout. Do not commit, stash, reset, push or run destructive git commands. ${W.PRESERVE_RULE} Do not run the configured tests as a substitute for Concord validation. Work to the effective request (revision ${rev}), including every amendment.`,
      baseline: W.summarizeBaseline(r.baseline),
      done: cmdFor(store, 'advance', r.id, '--done', id, '--executor', 'subagent|main', '--revision', String(rev), '--one-step'),
      after_done: stageInfo(store, 'test'),
      progress: `${done.size}/${r.tasks.length} tasks done` };
  }
  if (r.phase === 'repair') {
    const id = `repair-${r.repairs_used + 1}`;
    const rev = W.revisionOf(r);
    const route = repairRoute(r);
    return { ...base, action: 'repair', step: id, round: r.repairs_used + 1, max_rounds: r.limits.max_repairs, cause: r.repair_cause,
      agent: { subagent_type: 'general-purpose', model: route.tier }, tier: route.tier, tier_reason: route.reason,
      revision: rev, request: W.effectiveRequest(r), amendments: W.amendmentsOf(r),
      rules: `Fix only the reported failures/findings in the current checkout. Do not commit, stash, reset or push. ${W.PRESERVE_RULE} Work to the effective request (revision ${rev}), including every amendment.`,
      baseline: W.summarizeBaseline(r.baseline),
      done: cmdFor(store, 'advance', r.id, '--done', id, '--executor', 'subagent|main', '--revision', String(rev), '--one-step'),
      after_done: stageInfo(store, 'test') };
  }
  const stage = stageInfo(store);
  return { ...base, action: 'continue', message: 'Helper-owned steps remain; run advance again.', next_stage: stage,
    next: cmdFor(store, 'advance', r.id, ...(stage ? ['--one-step'] : [])) };
}

// ------------------------------------------------------------------ commands

/**
 * Every mutating command is bound to the checkout the run was started in. Linked worktrees share
 * one run store, so without this a command from worktree B would fingerprint, test and edit B's
 * files as if they were A's run. Runs BEFORE any lock, write, signal or model call.
 */
function guardRepo(loc, id, verb) {
  let run;
  try { run = readJson(path.join(runDir(loc, id), 'run.json')); } catch { return; } // not_found surfaces later
  if (!run.repo) return;
  let saved = null; try { saved = fs.realpathSync(run.repo); } catch { /* gone */ }
  if (saved === loc.repo) return;
  if (saved === null && run.repo === loc.repo) return;
  if (saved === null && verb === 'cancel') return; // the original worktree is gone: closing the run is still allowed
  throw new ConcordError(`run ${id} was started in ${run.repo}; this command resolved to ${loc.repo}. Nothing was changed (no lock, write, signal or model call). ` +
    `${saved ? `Re-run it with --repo ${run.repo}` : 'That worktree no longer exists here; only cancel is possible from another worktree'}.`,
  'wrong_worktree', { run_repo: run.repo, current_repo: loc.repo, correct_repo_flag: `--repo ${run.repo}` });
}

/** `--revision` must match the run's current revision: a result produced for an older request is never accepted. */
function checkRevision(r, opt) {
  const cur = W.revisionOf(r);
  if (opt.revision === undefined) {
    if (cur > 1) throw new ConcordError(`run is at revision ${cur} (amended); pass --revision ${cur} so the result is tied to the current request`, 'revision_required');
    return;
  }
  if (!/^\d+$/.test(String(opt.revision)) || Number(opt.revision) !== cur) {
    throw new ConcordError(`stale result: it was produced for revision ${opt.revision}, but the run is now at revision ${cur}. Nothing was recorded; redo the step against the current effective request`, 'stale_revision');
  }
}

function withLock(loc, runId, fn) {
  const lock = acquireLock(loc, runId);
  const onSignal = (sig) => {
    killAll();
    if (current) {
      timeline(current.store, { type: 'signal', signal: sig, step: current.step.id });
      // SIGUSR1 = `interrupt`: stop the stage but leave the run open and retryable. SIGINT/SIGTERM = cancel.
      const user = sig === 'SIGUSR1';
      try {
        endStep(current.store, current.step, user ? 'interrupted' : 'cancelled', user
          ? { error: 'interrupted by the user (interrupt); child process group killed; run left open', failure_class: 'interrupted' }
          : { error: `cancelled by ${sig}; child process group killed` });
      } catch { /* best effort */ }
    }
    lock.release();
    process.exit(130);
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); process.on('SIGUSR1', onSignal);
  return Promise.resolve().then(() => fn(lock)).finally(() => {
    lock.release(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); process.off('SIGUSR1', onSignal);
  });
}

async function cmdStart(loc, opt) {
  if (!opt.spec) throw new ConcordError('start needs --spec FILE (write it with the Write tool)', 'usage');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.resolve(opt.spec), 'utf8')); } catch (e) { throw new ConcordError(`cannot read spec: ${e.message}`, 'spec'); }
  const spec = validateSpec(raw);
  let selection = null;
  if (!spec.tests) {
    const found = discoverChecks(loc);
    if (!found.selected) {
      throw new ConcordError(`no reliable check command could be detected (${found.reason}${found.skipped.length ? `; skipped: ${found.skipped.map((x) => `${x.package}${x.script ? `:${x.script}` : ''} ${x.reason}`).join('; ')}` : ''}). Ask the user which command gates the run and put it in spec.tests; Concord will not pass without a real check.`, 'no_tests');
    }
    const { argv, ...meta } = found.selected;
    spec.tests = [argv];
    selection = { mode: 'auto', ...meta, cwd_source: 'package directory', skipped: found.skipped };
  }
  if (!selection) {
    const kind = classifyExplicit(spec.tests);
    // Explicit checks run where the user started the run (same intent as an autodetected check in that
    // directory), unless spec.tests_cwd names another repo-relative directory (e.g. root commands from root docs).
    let cwd = path.relative(loc.repo, loc.cwd); let cwdSource = 'invocation directory';
    if (spec.tests_cwd) {
      const abs = path.resolve(loc.repo, spec.tests_cwd);
      let real = null; try { real = fs.realpathSync(abs); } catch { /* missing */ }
      if (path.isAbsolute(spec.tests_cwd) || spec.tests_cwd.split(/[\\/]/).includes('..') || !real || !fs.statSync(real).isDirectory()
        || (real !== loc.repo && !real.startsWith(`${loc.repo}${path.sep}`))) {
        throw new ConcordError(`spec.tests_cwd must be an existing directory inside the repository (repo-relative, no ..): ${spec.tests_cwd}`, 'spec');
      }
      cwd = path.relative(loc.repo, real); cwdSource = 'spec.tests_cwd';
    }
    selection = { mode: 'explicit', source: 'spec.tests (user-specified)', kind, cwd, cwd_source: cwdSource, note: KIND_NOTE[kind] };
  }
  const catalog = loadCatalog();
  const models = {};
  for (const [role, provider] of Object.entries(EXTERNAL)) {
    try { models[role] = resolveExternal(provider, spec.models[role], catalog); } catch (e) { throw new ConcordError(e.message, 'model'); }
  }
  models.worker_override = spec.models.worker ?? null;
  models.repair_override = spec.models.repair ?? null;
  return withLock(loc, 'start', () => {
    const open = listRuns(loc).map((id) => { try { return readJson(path.join(runDir(loc, id), 'run.json')); } catch { return null; } })
      .filter((r) => r && OPEN.has(r.status));
    if (open.length) throw new ConcordError(`run ${open[0].id} is still open (${open[0].status}); finish, approve/reject or cancel it first`, 'open_run');
    const links = gitlinks(loc);
    if (links.length) throw new ConcordError(`submodules/nested repositories are not supported (their contents are not fingerprinted): ${links.slice(0, 10).join(', ')}`, 'submodule');
    const dirty = dirtyEntries(loc);
    if (spec.require_clean && dirty.length) {
      throw new ConcordError(`require_clean is set and the checkout is not clean; Concord will not stash, reset, commit or overwrite your work. Commit or set aside these first:\n  ${dirty.slice(0, 20).map(formatEntry).join('\n  ')}`, 'dirty');
    }
    const headR = git(loc.repo, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
    if (headR.status !== 0) throw new ConcordError('repository has no commits; create an initial commit first', 'no_head');
    const id = newRunId();
    const store = new Store(loc, id);
    const trees = snapshotTrees(loc); // temp index copy only; the real index is not touched
    // Keep the snapshot reachable (private ref, not a branch) so gc cannot prune it mid-run.
    const baseRef = `refs/concord/baseline/${id}`;
    const pinned = git(loc.repo, ['update-ref', baseRef, trees.work_tree], { allowFail: true }).status === 0;
    const notes = [];
    let policy = spec.policy;
    if (policy === 'fast' && !W.trivialDocsRequest(spec.request, RISK)) {
      policy = 'full';
      notes.push('fast policy requested but the request is not a narrow trivial docs fix; using full policy (Codex proposal → Grok review → Codex plan).');
    } else if (policy === 'fast') notes.push('fast policy: request matches the trivial docs allowlist; Codex proposal+plan combined.');
    store.run = {
      schema: 1, id, version: VERSION, created_at: now(), repo: loc.repo, request: spec.request, revision: 1, amendments: [], tests: spec.tests,
      test_selection: selection, requested_policy: spec.policy, policy, policy_notes: notes, limits: spec.limits, models,
      catalog: catalog ? { refreshed_at: catalog.refreshed_at, source: cachePath() } : null,
      require_clean: spec.require_clean,
      baseline: { head: headR.stdout.trim(), fingerprint: fp(loc).sha256, clean: dirty.length === 0, dirty,
        index_tree: trees.index_tree, work_tree: trees.work_tree, ref: pinned ? baseRef : null },
      status: 'active', phase: 'proposal', steps: [], tasks: [], repairs_used: 0, validation: null, approval: null, failure: null,
      execution: 'serial in the current checkout (parallel subagents are not supported in v0.2)',
    };
    store.save();
    writeJson(store.p('spec.json'), raw);
    const baseline = W.summarizeBaseline(store.run.baseline);
    return { run: id, status: 'active', policy, policy_notes: notes, baseline, checks: describeChecks(store.run), limits: store.run.limits, state_dir: store.dir,
      next_stage: stageInfo(store), next: cmdFor(store, 'advance', id, '--one-step') };
  });
}

async function cmdAdvance(loc, id, opt) {
  return withLock(loc, id, async (lock) => {
    const store = new Store(loc, id); store.load();
    const r = store.run;
    if (opt.done || opt.failed) checkRevision(r, opt); // before anything is written
    const stale = markStale(store);
    if (lock.stale) r.policy_notes.push(`${now()}: replaced stale lock from pid ${lock.stale.pid}`);
    if (stale.length && !opt.retry) {
      return { ...nextAction(store), interrupted: stale, message: `Interrupted step(s) ${stale.join(', ')} were not re-executed. Use advance --retry to run them again.` };
    }
    if (['cancelled', 'approved', 'rejected'].includes(r.status)) return nextAction(store);
    if (opt.retry) {
      if (r.status !== 'failed') throw new ConcordError('nothing to retry: run has not failed', 'usage');
      if (r.failure?.error?.startsWith('repair budget exhausted')) throw new ConcordError('repair budget exhausted; start a new run or fix manually', 'usage');
      if (r.failure?.rejected_by_review) r.phase = 'review';
      if (r.failure?.fast_gate) {
        r.policy = 'full'; r.phase = 'review'; r.tasks = []; r.repair_cause = null;
        r.policy_notes.push(`${now()}: retry after fast gate failure: switching to full policy (Grok review of current changes, then re-plan).`);
      }
      r.policy_notes.push(`${now()}: explicit retry of ${r.failure?.step}`);
      r.status = 'active'; r.failure = null; store.save();
    }
    if (opt.failed) {
      const na = nextAction(store);
      if (na.step !== opt.failed) throw new ConcordError(`--failed ${opt.failed} does not match the pending step ${na.step ?? '(none)'}`, 'usage');
      r.steps.push({ id: opt.failed, attempt: 1, revision: W.revisionOf(r), role: na.action === 'repair' ? 'repair' : 'task', label: W.ROLES[na.action === 'repair' ? 'repair' : 'task'].label,
        provider: 'claude (native)', status: 'failed', at: now(), error: readNote(opt['note-file']) || 'session reported failure' });
      r.status = 'failed'; r.failure = { step: opt.failed, error: 'Claude session reported it could not complete this step', at: now() };
      store.save();
      return nextAction(store);
    }
    if (opt.done) recordDone(store, opt);
    if (r.status === 'validated' && fp(loc).sha256 !== r.validation.fingerprint) {
      r.policy_notes.push(`${now()}: working state changed after validation; validation invalidated, re-testing.`);
      r.invalidated = [...(r.invalidated ?? []), { ...r.validation, at: now() }];
      r.validation = null; r.status = 'active'; r.phase = 'test'; store.save();
    }
    // --budget S stops starting new stages once S seconds (plus the next stage's limit) would be exceeded; sized for
    // a foreground Bash call (cap 600 s). Default: unbounded. --one-step runs exactly one stage, so each background task maps to one labelled stage.
    const budget = Number(opt.budget ?? 0) * 1000;
    const started = Date.now(); let ran = 0;
    const perf0 = JSON.parse(JSON.stringify(perf));
    while (r.status === 'active' && STAGES[r.phase]) {
      const cost = (r.phase === 'test' ? r.tests.length * r.limits.test_timeout_s : roleTimeoutS(store, r.phase)) * 1000;
      if (ran && opt['one-step'] === true) break;
      if (ran && budget > 0 && Date.now() - started + cost > budget) break;
      await STAGES[r.phase](store); ran++;
    }
    if (r.status === 'active' && ['implement', 'repair'].includes(r.phase)) { r.status = 'awaiting_session'; store.save(); }
    const timing = { ms: Date.now() - started, stages_run: ran,
      scans: { fingerprint: { count: perf.fingerprint.count - perf0.fingerprint.count, ms: perf.fingerprint.ms - perf0.fingerprint.ms },
        snapshot: { count: perf.snapshot.count - perf0.snapshot.count, ms: perf.snapshot.ms - perf0.snapshot.ms } } };
    r.perf_total = Object.fromEntries(['fingerprint', 'snapshot'].map((k) => [k, { count: (r.perf_total?.[k]?.count ?? 0) + timing.scans[k].count, ms: (r.perf_total?.[k]?.ms ?? 0) + timing.scans[k].ms }]));
    store.save();
    return { ...nextAction(store), timing };
  });
}

function recordDone(store, opt) {
  const r = store.run;
  const na = nextAction(store);
  if (!['implement', 'repair'].includes(na.action) || na.step !== opt.done) {
    throw new ConcordError(`--done ${opt.done} does not match the pending step ${na.step ?? '(none)'}`, 'usage');
  }
  const executor = opt.executor ?? 'main';
  if (!['subagent', 'main'].includes(executor)) throw new ConcordError('--executor must be subagent or main', 'usage');
  const requested = na.agent?.model ?? na.tier;
  const model = executor === 'subagent'
    ? { requested_alias: requested, actual: 'alias resolved by Claude Code; exact model ID not observed' }
    : { requested_alias: requested, actual: 'inherited from the main session; actual model unknown to the helper (no switching performed)' };
  const fpNow = fp(store.loc).sha256;
  const prev = [...r.steps].reverse().find((s) => s.fingerprint)?.fingerprint ?? r.baseline.fingerprint;
  const role = na.action === 'repair' ? 'repair' : 'task';
  const step = { id: opt.done, attempt: r.steps.filter((s) => s.id === opt.done).length + 1, role, label: W.ROLES[role].label,
    provider: 'claude (native)', executor, model, status: 'passed', at: now(), fingerprint: fpNow, changed: fpNow !== prev, revision: W.revisionOf(r), note: readNote(opt['note-file']) };
  r.steps.push(step);
  if (role === 'repair' && fpNow === prev) {
    // A repair that changed nothing would only replay the same tests/QA: stop here.
    Object.assign(step, { status: 'failed', error: 'repair left the working state unchanged (same fingerprint as the failed validation)' });
    r.status = 'failed';
    r.failure = { step: opt.done, attempt: step.attempt, at: now(), noop_repair: true,
      error: `${opt.done} reported done but changed no files; tests/QA were not re-run. Make the fix, then advance --retry to get the repair step again.` };
    store.save();
    return;
  }
  if (!fastGate(store, opt.done)) return;
  if (na.action === 'implement') {
    r.tasks.find((t) => t.id === na.task.id).status = 'done';
    if (r.tasks.every((t) => t.status === 'done')) r.phase = 'test';
  } else {
    r.repairs_used += 1; r.repair_cause = null; r.phase = 'test';
  }
  r.status = 'active';
  store.save();
}

function summarizeDiscussion(store) {
  // 政事堂议事: only artifacts this run actually produced; missing ones are reported as such.
  const pick = (name) => store.readArtifact(name);
  const p = pick('proposal');
  return {
    proposal: p ? (p.proposal ?? p) : null,
    review: pick('review') ?? (store.run.steps.find((s) => s.id === 'review' && s.status === 'skipped') ? { skipped: true } : null),
    plan: pick('plan'),
  };
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** The live helper for this repository's lock, if its process still exists. */
function liveHelper(loc, runId) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(loc.stateRoot, 'lock'), 'utf8'));
    if (owner.run === runId && owner.host === os.hostname() && pidAlive(owner.pid)) return owner;
  } catch { /* none */ }
  return null;
}

/** Per-stage attempt counts and durations (running steps count their elapsed time so far). */
function stageStats(r) {
  const out = {};
  for (const s of r.steps) {
    const k = s.role;
    const e = (out[k] ??= { attempts: 0, passed: 0, failed: 0, total_ms: 0, max_ms: 0 });
    e.attempts += 1;
    if (s.status === 'passed') e.passed += 1;
    if (['failed', 'tests_failed', 'interrupted', 'cancelled'].includes(s.status)) e.failed += 1;
    const ms = s.ms ?? s.process_ms ?? (s.status === 'running' ? Date.now() - Date.parse(s.started_at) : 0);
    e.total_ms += ms; e.max_ms = Math.max(e.max_ms, ms);
  }
  return out;
}

function isForeign(loc, r) {
  if (!r.repo) return false;
  let saved = r.repo; try { saved = fs.realpathSync(r.repo); } catch { /* keep */ }
  return saved !== loc.repo;
}

function cmdStatus(loc, id, opt) {
  const store = new Store(loc, id); store.load();
  const r = store.run;
  const foreign = isForeign(loc, r);
  // The fingerprint is a full hash of the working tree: skipped with --light, and impossible to attribute
  // to a run that belongs to another worktree (that would validate the wrong files).
  const verification = foreign ? `unavailable: run belongs to ${r.repo} (use --repo ${r.repo})` : opt.light ? 'not checked (--light)' : 'checked';
  const fpNow = verification === 'checked' ? fp(loc).sha256 : null;
  const helper = liveHelper(loc, r.id);
  const running = r.steps.filter((s) => s.status === 'running').map((s) => ({ step: s.id, attempt: s.attempt, label: s.label, provider: s.provider, pid: s.pid ?? null, started_at: s.started_at,
    elapsed_s: Math.round((Date.now() - Date.parse(s.started_at)) / 1000), limit_s: s.timeout_s ?? null, last_output_at: s.last_output_at ?? null, no_output: s.no_output ?? null, bytes: s.bytes ?? null, events: s.event_counts ?? null }));
  const report = {
    run: r.id, status: r.status, phase: r.phase, policy: r.policy, policy_notes: r.policy_notes, repo: r.repo, revision: W.revisionOf(r),
    worktree: foreign ? { foreign: true, run_repo: r.repo, current_repo: loc.repo, note: 'read-only view; mutating commands must run with the run repo' } : { foreign: false },
    amendments: W.amendmentsOf(r).slice(-5),
    baseline: r.baseline.head, baseline_state: W.summarizeBaseline(r.baseline), working_state: fpNow, working_state_check: verification,
    validation: r.validation ? { ...r.validation, current: fpNow === null ? null : r.validation.fingerprint === fpNow, verification } : null,
    approval: r.approval, failure: r.failure, helper_running: helper ? helper.pid : null, running,
    steps: r.steps.map(({ id: sid, attempt, label, provider, model, status, ms, error, reason, executor, revision, pid, last_output_at, bytes, event_counts, no_output, process_ms, failure_class, logs, timeout_s, cwd, output_format }) =>
      ({ id: sid, attempt, label, provider, model, status, ms, error, reason, executor, revision, pid, last_output_at, bytes, event_counts, no_output, process_ms, failure_class, timeout_s, cwd, output_format, has_logs: !!logs })),
    tasks: r.tasks.map(({ id: tid, title, status, tier, tier_reason }) => ({ id: tid, title, status, tier, tier_reason })),
    checks: describeChecks(r), check_coverage: r.validation?.check_coverage ?? r.check_coverage ?? null,
    limits: { ...r.limits, effective_review_timeout_s: r.limits.review_timeout_s ?? r.limits.cli_timeout_s, live_override_s: readControl(store, true)?.review_timeout_s ?? null },
    repairs: `${r.repairs_used}/${r.limits.max_repairs}`, next: nextAction(store), state_dir: store.dir,
    stage_stats: stageStats(r), scans: r.perf_total ?? null, timeline: recentTimeline(store),
    discussion: summarizeDiscussion(store), note: W.METAPHOR,
  };
  if (opt.json) return report;
  const mark = { invalidated: '⊘', passed: '✓', failed: '✗', tests_failed: '✗', skipped: '–', running: '…', interrupted: '!', cancelled: '✗' };
  const lines = [
    `贞观·政事堂 · Concord ${r.id}  status=${r.status} phase=${r.phase} policy=${r.policy} revision=${report.revision}`,
    `repo ${r.repo}${foreign ? '  [FOREIGN worktree: read-only view]' : ''}  baseline ${r.baseline.head.slice(0, 10)}  working-state ${fpNow ? `${fpNow.slice(0, 12)}${r.validation ? (report.validation.current ? ' (validated)' : ' (CHANGED since validation)') : ''}` : verification}`,
    ...(r.baseline.dirty?.length ? [`baseline: ${r.baseline.dirty.length} pre-existing uncommitted entr${r.baseline.dirty.length === 1 ? 'y' : 'ies'} preserved (${report.baseline_state.entries.slice(0, 5).join('; ')}${r.baseline.dirty.length > 5 ? '; …' : ''})`] : []),
    `checks: ${r.tests.map((a) => a.join(' ')).join(' && ')} [${report.checks.mode}, ${report.checks.kind}${report.checks.behavioural_tests ? '' : ` — ${report.checks.note}`}] cwd ${report.checks.cwd} (${report.checks.cwd_source})`,
    ...(report.check_coverage?.status === 'warning' ? [`⚠ check coverage: ${report.check_coverage.warnings.map((w) => `${w.message} [${w.files.slice(0, 5).join(', ')}]`).join(' ')}`] : []),
    ...r.policy_notes.map((n) => `note: ${n}`),
    ...(report.amendments.length ? ['amendments:', ...report.amendments.map((a) => `  r${a.revision} [${a.kind}] ${a.text.split('\n')[0].slice(0, 160)}`)] : []),
    'steps:',
    ...r.steps.map((s) => {
      const model = typeof s.model === 'string' ? s.model : s.model ? `${s.model.requested_alias} [${s.executor}]` : '';
      const live = s.status === 'running' ? ` elapsed ${fmtS(Date.now() - Date.parse(s.started_at))}${s.timeout_s !== undefined ? `, ${limitText(s.timeout_s)}` : ''}${s.pid ? `, pid ${s.pid}` : ''}${s.no_output ? ', no output yet' : s.last_output_at ? `, last output ${s.last_output_at}` : ''}` : '';
      return `  ${mark[s.status] ?? '?'} ${s.id}${s.attempt > 1 ? `#${s.attempt}` : ''}  ${s.label} · ${s.provider}${model ? `:${model}` : ''}${s.ms ? ` ${(s.ms / 1000).toFixed(1)}s` : ''}${live}${s.reason ? ` — ${s.reason}` : ''}${s.error ? ` — ${s.error.split('\n')[0].slice(0, 200)}` : ''}`;
    }),
  ];
  if (r.tasks.length) lines.push('tasks:', ...r.tasks.map((t) => `  [${t.status}] ${t.id} ${t.title} → ${t.tier} (${t.tier_reason})`));
  const d = report.discussion;
  lines.push('政事堂议事 (run artifacts):',
    `  proposal: ${d.proposal ? d.proposal.summary : 'not produced'}`,
    `  review:   ${d.review ? (d.review.skipped ? 'skipped (see note)' : `${d.review.verdict} — ${d.review.summary}`) : 'not produced'}`,
    `  plan:     ${d.plan ? `${d.plan.tasks?.length ?? 0} task(s) — ${d.plan.summary}` : 'not produced'}`);
  const st = Object.entries(report.stage_stats);
  if (st.length) lines.push(`stage time: ${st.map(([k, v]) => `${k} ${v.attempts}× ${fmtS(v.total_ms)}`).join('; ')}${r.perf_total ? `; scans: fingerprint ${r.perf_total.fingerprint.count}× ${fmtS(r.perf_total.fingerprint.ms)}` : ''}`);
  if (report.timeline.length) lines.push('recent:', ...report.timeline.slice(-6).map((e) => `  ${e.at.slice(11, 19)} ${e.type}${e.step ? ` ${e.step}` : ''}${e.status ? ` ${e.status}` : ''}${e.ms ? ` ${fmtS(e.ms)}` : ''}`));
  if (r.failure) lines.push(`failure: ${r.failure.step}: ${r.failure.error}`);
  if (r.approval) lines.push(`approval: ${r.approval.decision} at ${r.approval.at} (record only; nothing deployed)`);
  lines.push(`next: ${report.next.action}${report.next.step ? ` ${report.next.step}` : ''}`, `state: ${store.dir}`);
  return lines.join('\n');
}

// ---- logs (read-only; never takes the lock, never fingerprints)

function cmdLogs(loc, id, opt) {
  const store = new Store(loc, id); store.load();
  const r = store.run;
  const stream = opt.stream ?? 'stdout';
  if (!STREAMS.includes(stream)) throw new ConcordError(`--stream must be one of ${STREAMS.join('|')}`, 'usage');
  const num = (v, name, lo, hi) => {
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(String(v)) || Number(v) < lo || Number(v) > hi) throw new ConcordError(`--${name} must be an integer in ${lo}..${hi}`, 'usage');
    return Number(v);
  };
  const offset = num(opt.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const limit = num(opt.limit, 'limit', 1, 65536) ?? 8192;
  const attempt = num(opt.attempt, 'attempt', 1, 1000);
  const command = num(opt.command, 'command', 1, 100);
  let step;
  const withLogs = r.steps.filter((s) => s.logs || s.commands?.length);
  if (opt.step !== undefined) {
    if (!validStepId(opt.step)) throw new ConcordError('--step must be a step id such as review, qa-1, test-1', 'usage');
    const same = r.steps.filter((s) => s.id === opt.step);
    if (!same.length) throw new ConcordError(`no step ${opt.step} in this run (steps: ${[...new Set(r.steps.map((s) => s.id))].join(', ') || 'none'})`, 'not_found');
    step = attempt ? same.find((s) => s.attempt === attempt) : same[same.length - 1];
    if (!step) throw new ConcordError(`step ${opt.step} has no attempt ${attempt}`, 'not_found');
  } else {
    step = [...withLogs].reverse().find((s) => s.status === 'running') ?? withLogs[withLogs.length - 1];
    if (!step) throw new ConcordError('this run has no step with logs yet', 'not_found');
  }
  let files = step.logs;
  if (command !== undefined) {
    files = step.commands?.[command - 1]?.logs;
    if (!files) throw new ConcordError(`step ${step.id} has no command ${command}`, 'not_found');
  }
  if (!files?.[stream]) throw new ConcordError(`step ${step.id} has no ${stream} log (native steps have none; ${stream === 'events' ? 'test steps have no events' : 'it may not have started'})`, 'not_found');
  const part = readLogRange(store.dir, files[stream], { offset, limit, final: step.status !== 'running' });
  const res = { run: r.id, step: step.id, attempt: step.attempt, step_status: step.status, running: step.status === 'running', stream, ...part,
    next: cmdFor(store, 'logs', r.id, '--step', step.id, '--attempt', String(step.attempt), '--stream', stream, '--offset', String(part.next_offset)) };
  if (opt.json) return res;
  return `[logs ${r.id} ${step.id}#${step.attempt} ${stream}: bytes ${part.offset}..${part.next_offset} of ${part.size}${part.truncated_head ? ' (older output omitted)' : ''}${res.running ? ', step still running' : ''}${part.eof ? ', end of file' : ''}]\n${part.text}`;
}

// ---- amend (mid-run goal change)

async function cmdAmend(loc, id, opt) {
  if (!opt.spec) throw new ConcordError('amend needs --spec FILE: {"kind":"clarify"|"scope","text":"..."} (write it with the Write tool)', 'usage');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.resolve(opt.spec), 'utf8')); } catch (e) { throw new ConcordError(`cannot read amendment spec: ${e.message}`, 'spec'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConcordError('amendment spec must be a JSON object', 'spec');
  for (const k of Object.keys(raw)) if (!['kind', 'text'].includes(k)) throw new ConcordError(`unknown amendment key: ${k}`, 'spec');
  if (!['clarify', 'scope'].includes(raw.kind)) throw new ConcordError('amendment kind must be clarify (same work, more detail) or scope (different/added/removed work)', 'spec');
  if (typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > MAX_AMEND) throw new ConcordError(`amendment text must be a non-empty string (≤ ${MAX_AMEND} chars)`, 'spec');
  try {
    return await withLock(loc, id, (lock) => {
      const store = new Store(loc, id); store.load();
      const r = store.run;
      if (lock.stale) r.policy_notes.push(`${now()}: replaced stale lock from pid ${lock.stale.pid}`);
      markStale(store);
      if (!OPEN.has(r.status)) throw new ConcordError(`run is ${r.status}; only an open run can be amended. Start a new run for new work`, 'not_open');
      if ((r.amendments?.length ?? 0) >= MAX_AMENDMENTS) throw new ConcordError(`amendment limit (${MAX_AMENDMENTS}) reached; start a new run`, 'usage');
      const writerPossible = r.status === 'awaiting_session' || (r.status === 'active' && ['implement', 'repair'].includes(r.phase));
      if (writerPossible && opt['writer-stopped'] !== true) {
        throw new ConcordError('a native writer (this session or an Agent subagent) may still be editing for the pending implement/repair step; the helper cannot see or stop it. ' +
          'Stop or await it first (TaskStop / wait for the Agent), then re-run amend with --writer-stopped. Edits it already made are kept.', 'writer_may_be_active');
      }
      const old = W.revisionOf(r); const rev = old + 1; const kind = raw.kind;
      const effects = [];
      r.revision = rev;
      r.amendments = [...(r.amendments ?? []), { revision: rev, kind, text: raw.text.trim(), at: now(), from_phase: r.phase, from_status: r.status, writer_stopped: opt['writer-stopped'] === true }];
      if (r.validation) {
        r.invalidated = [...(r.invalidated ?? []), { ...r.validation, at: now(), reason: `amended to revision ${rev}` }];
        r.validation = null; effects.push('previous validation invalidated');
      }
      const planned = r.tasks.length > 0 || ['implement', 'repair', 'test', 'qa', 'done'].includes(r.phase);
      if (kind === 'scope') r.review_floor = rev; // earlier Grok approvals no longer cover the request
      if (kind === 'scope' && !planned && r.policy === 'full' && r.phase === 'plan') { r.phase = 'review'; effects.push(`earlier Grok approval invalidated: reviewing revision ${rev} before planning`); }
      if (kind === 'scope' && planned) {
        const completed = r.tasks.filter((t) => t.status === 'done').map(({ id: tid, title, files }) => ({ id: tid, title, files }));
        r.replan = { from_revision: old, completed };
        r.tasks = []; r.repair_cause = null; r.check_coverage = null; r.repairs_used = 0;
        if (r.policy === 'fast') {
          const skip = r.steps.find((x) => x.id === 'review' && x.status === 'skipped');
          if (skip) Object.assign(skip, { status: 'invalidated', invalidated_at: now(), invalidated_reason: 'scope amendment after a fast (docs-only) skip' });
          r.policy = 'full'; r.phase = 'review'; effects.push('fast policy reverted to full: Grok review of the current state, then re-plan');
        } else { r.phase = 'review'; effects.push('structural scope change: the earlier Grok approval no longer covers the request; Grok reviews the revised request and current changes, then re-plan (completed tasks listed; edits kept)'); }
        r.status = 'active'; r.failure = null;
        effects.push('repair budget reset for the new scope');
      } else if (kind === 'clarify') {
        if (['test', 'qa', 'done'].includes(r.phase)) {
          r.phase = 'test'; if (r.status === 'validated') r.status = 'active';
          effects.push('tests and QA re-run against the clarified request');
        }
        effects.push('plan and completed tasks kept');
      }
      if (r.status === 'failed' && r.failure?.interrupted && r.failure?.by_user) {
        r.status = 'active'; r.failure = null;
        effects.push('the stage you interrupted will run again from the amended request when you continue (crashes are never retried automatically)');
      }
      if (r.status === 'validated') r.status = 'active';
      effects.push(`future Codex/Grok/QA prompts and worker actions carry revision ${rev}; stale --done results are rejected`);
      store.save();
      timeline(store, { type: 'amend', revision: rev, kind });
      return { run: id, amended: { revision: rev, kind, previous_revision: old }, effects, baseline_untouched: true, ...nextAction(store) };
    });
  } catch (e) {
    if (e.code === 'locked') throw new ConcordError(`a Concord helper is running this run right now (pid ${e.details?.helper_pid}); it would act on the old request. Wait for the current stage (logs/status --light), or run interrupt (the run stays open), then amend`, 'helper_busy', e.details);
    throw e;
  }
}

// ---- extend (live change of the Codex/Grok deadline)

function cmdExtend(loc, id, opt) {
  const store = new Store(loc, id); store.load();
  const r = store.run;
  if (!OPEN.has(r.status)) throw new ConcordError(`run is ${r.status}; nothing to extend`, 'not_open');
  const v = opt['review-timeout'];
  if (!/^\d+$/.test(String(v ?? '')) || Number(v) > MAX_REVIEW_TIMEOUT_S) throw new ConcordError(`--review-timeout must be an integer in 0..${MAX_REVIEW_TIMEOUT_S} seconds (0 = no helper deadline)`, 'usage');
  const secs = Number(v);
  const running = r.steps.find((s) => s.status === 'running' && s.timeout_s !== undefined);
  const helper = liveHelper(loc, r.id);
  if (running && helper && secs > 0 && secs * 1000 <= Date.now() - Date.parse(running.started_at)) {
    throw new ConcordError(`${secs}s is not beyond the ${Math.round((Date.now() - Date.parse(running.started_at)) / 1000)}s ${running.id} has already run; that would kill it. Pick a larger value, 0 to wait manually, or use cancel`, 'usage');
  }
  writeJson(path.join(store.dir, 'control.json'), { review_timeout_s: secs, set_at: now() });
  timeline(store, { type: 'extend', review_timeout_s: secs });
  return { run: id, review_timeout_s: secs, limit: secs === 0 ? 'none (manual; cancel to stop)' : `${secs}s from each Codex/Grok step's start`,
    live_helper: helper ? helper.pid : null, running_step: running?.id ?? null,
    applies_to: helper && running ? `the running step ${running.id} (picked up within about a second) and later Codex/Grok stages of this run` : 'later Codex/Grok stages of this run',
    note: 'Overrides spec limits for this run. Does not apply to local test commands.' };
}

async function cmdApprove(loc, id, opt) {
  if (!['approve', 'reject'].includes(opt.decision)) throw new ConcordError('--decision approve|reject is required', 'usage');
  return withLock(loc, id, () => {
    const store = new Store(loc, id); store.load();
    const r = store.run;
    const fpNow = fp(loc).sha256;
    if (opt.decision === 'approve') {
      if (r.status !== 'validated' || !r.validation) throw new ConcordError(`cannot approve: run is ${r.status}, not validated`, 'not_validated');
      if (r.validation.fingerprint !== fpNow) throw new ConcordError('cannot approve: working state changed since validation; run advance to re-validate', 'stale_validation');
    } else if (!OPEN.has(r.status)) throw new ConcordError(`run is already ${r.status}`, 'usage');
    r.approval = { decision: opt.decision, at: now(), fingerprint: fpNow, validation: r.validation, note: readNote(opt['note-file']),
      recorded_by: '天子决之 · 人工审批 (human decision recorded by helper)', effect: 'record only — no commit, merge, push or deployment' };
    r.status = opt.decision === 'approve' ? 'approved' : 'rejected';
    store.save();
    return { run: id, status: r.status, approval: r.approval };
  });
}

/** Like cancel's signalling, but SIGUSR1: the helper records the stage as interrupted and the run stays open. */
async function cmdInterrupt(loc, id) {
  const store = new Store(loc, id); store.load();
  const owner = liveHelper(loc, id);
  if (!owner || !store.run.steps.some((s) => s.status === 'running')) {
    throw new ConcordError('no helper stage is running for this run, so there is nothing to interrupt (use cancel to abandon the run)', 'no_helper');
  }
  const lockFile = path.join(loc.stateRoot, 'lock');
  process.kill(owner.pid, 'SIGUSR1');
  for (let i = 0; i < 50 && fs.existsSync(lockFile); i++) await new Promise((res) => setTimeout(res, 100));
  store.load();
  return { run: id, interrupted: owner.pid, ...nextAction(store), message: 'Stage interrupted; the run is still open. Amend it, or continue with advance --retry only when the user wants the stage run again.' };
}

async function cmdCancel(loc, id) {
  const store = new Store(loc, id); store.load();
  const lockFile = path.join(loc.stateRoot, 'lock');
  try {
    const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    // Signal only a helper that the lock and the run both say is mid-step.
    if (owner.run === id && owner.host === os.hostname() && store.run.steps.some((s) => s.status === 'running')) {
      process.kill(owner.pid, 'SIGTERM');
      for (let i = 0; i < 50 && fs.existsSync(lockFile); i++) await new Promise((res) => setTimeout(res, 100));
    }
  } catch { /* no live helper */ }
  return withLock(loc, id, () => {
    store.load(); markStale(store);
    if (!OPEN.has(store.run.status)) return { run: id, status: store.run.status, message: 'already closed' };
    store.run.status = 'cancelled'; store.run.cancelled_at = now(); store.save();
    return { run: id, status: 'cancelled', message: 'Run closed. Working-tree files were left exactly as they are.' };
  });
}

function cmdPreflight(loc, opt) {
  const catalog = loadCatalog();
  const age = catalogAge(catalog);
  const b = bins();
  const dirty = dirtyEntries(loc);
  const strict = opt['require-clean'] === true;
  const detected = discoverChecks(loc);
  const links = gitlinks(loc);
  const open = listRuns(loc).map((id) => { try { return readJson(path.join(runDir(loc, id), 'run.json')); } catch { return null; } })
    .filter((r) => r && OPEN.has(r.status)).map((r) => `${r.id} (${r.status})`);
  const head = git(loc.repo, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  const checks = {
    node: { ok: Number(process.versions.node.split('.')[0]) >= 18, value: process.versions.node },
    git_repo: { ok: true, value: loc.repo },
    has_commit: { ok: head.status === 0 },
    // Pre-existing work is allowed (it becomes the run baseline): a warning unless --require-clean.
    clean_checkout: { ok: !strict || dirty.length === 0, warn: dirty.length > 0, value: dirty.slice(0, 10).map(formatEntry),
      note: dirty.length ? (strict ? '--require-clean: checkout must be clean' : 'dirty checkout: pre-existing changes will be recorded as the baseline and preserved') : undefined },
    no_submodules: { ok: links.length === 0, value: links.slice(0, 10) },
    no_open_run: { ok: open.length === 0, value: open },
    test_command: { ok: true, warn: !detected.selected, value: detected.selected ? `${detected.selected.argv.join(' ')} [${detected.selected.kind}] from ${detected.selected.source}` : `none auto-detected (${detected.reason}); pass spec tests / --test` },
    codex_on_path: { ok: !!which(b.codex), value: which(b.codex) },
    grok_on_path: { ok: !!which(b.grok), value: which(b.grok) },
    model_cache: { ok: true, value: catalog ? `${cachePath()} refreshed ${catalog.refreshed_at}${age > TTL_S ? ' (stale; models --refresh)' : ''}` : 'none (account defaults will be used)' },
    state_dir: { ok: true, value: loc.stateRoot },
  };
  const ok = Object.values(checks).every((c) => c.ok);
  const warnings = Object.entries(checks).filter(([, c]) => c.ok && c.warn).map(([k]) => k);
  const out = { ok, warnings, checks, note: 'Local checks only: no model CLI was executed, no inference, no networking. Login state is not verified.' };
  if (!ok) process.exitCode = 1;
  if (opt.json) return out;
  return [`Concord ${VERSION} preflight: ${ok ? (warnings.length ? 'OK (with warnings)' : 'OK') : 'NOT READY'}`,
    ...Object.entries(checks).map(([k, c]) => `  ${c.ok ? (c.warn ? '⚠' : '✓') : '✗'} ${k}${c.value !== undefined && c.value !== true ? `: ${Array.isArray(c.value) ? c.value.join(', ') || '-' : c.value}` : ''}`),
    out.note].join('\n');
}

async function cmdModels(opt) {
  const catalog = opt.refresh ? await refreshCatalog(bins(), path.join(os.tmpdir(), `concord-models-${process.pid}`)) : loadCatalog();
  if (opt.json) return catalog ?? { providers: null, note: 'no cache; run models --refresh' };
  if (!catalog) return `No model cache at ${cachePath()}. External roles use each CLI's account default.\nRun \`models --refresh\` to list account models via local CLIs. Claude tiers: ${CLAUDE_TIERS.join(', ')} (Agent tool aliases).`;
  const age = catalogAge(catalog);
  const lines = [`Model catalog ${cachePath()} (refreshed ${catalog.refreshed_at}, ${Math.round(age / 3600)}h ago${age > TTL_S ? ', STALE' : ''})`];
  for (const [name, p] of Object.entries(catalog.providers)) {
    lines.push(`  ${name}: ${p.status} — source: ${p.source} @ ${p.observed_at}${p.error ? ` — ${p.error}` : ''}`);
    if (p.models.length) lines.push(`    ${p.models.join(', ')}`);
    if (p.note) lines.push(`    ${p.note}`);
    lines.push(`    official reference (not fetched): ${p.docs ?? DOCS[name]}`);
  }
  lines.push(catalog.note);
  return lines.join('\n');
}

function cmdShow(loc, id, step) {
  if (!step || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(step) || step.includes('..')) throw new ConcordError('show needs a safe artifact name (e.g. proposal, review, plan, qa-1)', 'usage');
  const store = new Store(loc, id); store.load();
  const f = path.join(store.dir, 'artifacts', `${step}.json`);
  if (!fs.existsSync(f)) throw new ConcordError(`artifact ${step} was not produced by this run`, 'not_found');
  const text = fs.readFileSync(f, 'utf8');
  return text.length > 65536 ? `${text.slice(0, 65536)}\n…[truncated]` : text.trimEnd();
}

async function main(argv) {
  const { pos, opt } = parseArgs(argv);
  const cmd = pos[0];
  if (opt.version || cmd === 'version') return VERSION;
  if (!cmd || opt.help || opt.h || cmd === 'help') return HELP;
  if (cmd === 'models') return cmdModels(opt);
  const loc = locate(opt.repo);
  switch (cmd) {
    case 'preflight': return cmdPreflight(loc, opt);
    case 'checks': {
      const d = discoverChecks(loc);
      if (opt.json) return { ...d, selected: d.selected && { ...d.selected, command: d.selected.argv }, behavioural_tests: d.selected?.kind === 'test' };
      return d.selected ? `${d.selected.argv.join(' ')}  (cwd ${d.selected.cwd || '.'}; ${d.selected.kind}: ${d.selected.note}; ${d.selected.source})`
        : `no reliable check command detected: ${d.reason}${d.skipped.map((x) => `\n  skipped ${x.package}${x.script ? `:${x.script}` : ''}: ${x.reason}`).join('')}`;
    }
    case 'start': return cmdStart(loc, opt);
    case 'advance': { const rid = resolveRunId(loc, pos[1]); guardRepo(loc, rid, cmd); return cmdAdvance(loc, rid, opt); }
    case 'amend': { const rid = resolveRunId(loc, pos[1]); guardRepo(loc, rid, cmd); return cmdAmend(loc, rid, opt); }
    case 'extend': { const rid = resolveRunId(loc, pos[1]); guardRepo(loc, rid, cmd); return cmdExtend(loc, rid, opt); }
    case 'interrupt': { const rid = resolveRunId(loc, pos[1]); guardRepo(loc, rid, cmd); return cmdInterrupt(loc, rid); }
    case 'logs': return cmdLogs(loc, resolveRunId(loc, pos[1]), opt);
    case 'resume': { const rid = resolveRunId(loc, pos[1]); guardRepo(loc, rid, cmd); return withLock(loc, rid, (lock) => {
      const store = new Store(loc, rid); store.load();
      if (lock.stale) { store.run.policy_notes.push(`${now()}: replaced stale lock from pid ${lock.stale.pid}`); store.save(); }
      const stale = markStale(store);
      return { ...nextAction(store), interrupted: stale, ...(stale.length ? { message: `Interrupted step(s) ${stale.join(', ')} recorded; not re-executed. advance --retry runs them again.` } : {}) };
    }); }
    case 'status': return cmdStatus(loc, resolveRunId(loc, pos[1]), opt);
    case 'list': return listRuns(loc).map((id) => {
      try { const r = readJson(path.join(runDir(loc, id), 'run.json')); return `${id}  ${r.status.padEnd(16)} ${r.phase.padEnd(10)} ${isForeign(loc, r) ? `[worktree ${r.repo}] ` : ''}${r.request.split('\n')[0].slice(0, 70)}`; } catch { return `${id}  (unreadable)`; }
    }).join('\n') || 'no runs';
    case 'show': return cmdShow(loc, resolveRunId(loc, pos[1]), pos[2]);
    case 'cancel': { const rid = resolveRunId(loc, pos[1]); guardRepo(loc, rid, cmd); return cmdCancel(loc, rid); }
    case 'approve': { const rid = resolveRunId(loc, pos[1]); guardRepo(loc, rid, cmd); return cmdApprove(loc, rid, opt); }
    default: throw new ConcordError(`unknown command: ${cmd} (see --help)`, 'usage');
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  main(process.argv.slice(2)).then((out) => {
    process.stdout.write(`${typeof out === 'string' ? out : JSON.stringify(out, null, 2)}\n`);
  }, (e) => {
    const code = e instanceof ConcordError ? e.code : 'internal';
    process.stderr.write(`concord: ${e.message}\n`);
    process.stdout.write(`${JSON.stringify({ error: code, message: e.message, ...(e.details ?? {}) })}\n`);
    process.exit(code === 'internal' ? 70 : 2);
  });
}
