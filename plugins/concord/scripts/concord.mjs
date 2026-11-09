#!/usr/bin/env node
// 贞观·政事堂 · Concord — native Claude Code plugin helper (Node builtins only).
// Short-lived commands; durable state in <git-common-dir>/concord/runs/<id>/.
// The current Claude Code session (or its native subagents) writes all code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, killAll, run as runProc, tail, which } from './lib/proc.mjs';
import {
  ConcordError, acquireLock, dirtyEntries, fingerprint, gitlinks, listRuns, locate, newRunId,
  readJson, runDir, writeJson,
} from './lib/state.mjs';
import {
  CLAUDE_TIERS, DOCS, RISK, TTL_S, cachePath, catalogAge, loadCatalog, refreshCatalog, resolveExternal, routeTask,
} from './lib/models.mjs';
import * as W from './lib/workflow.mjs';

const VERSION = '0.2.0';
const SELF = fileURLToPath(import.meta.url);
const OPEN = new Set(['active', 'awaiting_session', 'failed', 'validated']);
const LIMITS = { cli_timeout_s: [480, 30, 3600], test_timeout_s: [300, 10, 3600], max_repairs: [2, 0, 5] };
const SPEC_KEYS = new Set(['request', 'tests', 'policy', 'models', 'limits']);
const EXTERNAL = { proposal: 'codex', review: 'grok', plan: 'codex', qa: 'codex' };
const MAX_NOTE = 4000;
const MAX_DIFF = 150 * 1024;

const HELP = `贞观·政事堂 · Concord ${VERSION} — Claude Code plugin helper (Node builtins only)

Usage: node concord.mjs <command> [options]

Commands (all short-lived; no daemon; state in <git-dir>/concord/runs/<id>):
  preflight [--repo P] [--json]       Local checks only: git, clean tree, CLIs on PATH, model cache.
                                      Runs no model CLI, no inference, no networking.
  models [--refresh] [--json]         Show cached model catalog. --refresh asks local CLIs
                                      (codex debug models, grok models) for account-listed models.
  start --spec FILE [--repo P]        Create a run from a JSON spec (requires clean checkout).
  advance RUN [--done STEP [--executor subagent|main] [--note-file F]]
              [--failed STEP --note-file F] [--retry] [--budget S]
                                      Execute helper-owned steps (Codex/Grok/tests/QA) until the
                                      session must act; prints the next action as JSON.
  status [RUN|latest] [--json]        Persisted status, roles, models, 政事堂议事 artifacts.
  list                                List runs in this repository.
  show RUN STEP                       Print one stored artifact (bounded).
  resume RUN                          Mark stale in-progress steps interrupted; print next action.
  cancel RUN                          Stop a live helper for RUN and close the run (files untouched).
  approve RUN --decision approve|reject [--note-file F]
                                      Record the human decision bound to the validated state.
                                      Never merges, pushes or deploys.

Spec (JSON): {"request": str, "tests": [["npm","test"]] | ["npm test"],
  "policy": "full"|"fast", "models": {"proposal","review","plan","qa": id|"account_default",
  "worker","repair": "haiku"|"sonnet"|"opus"}, "limits": {"cli_timeout_s","test_timeout_s","max_repairs"}}
Test strings are split into argv (simple quotes only); shell operators are rejected. No shell is used.

Env: CONCORD_CODEX_BIN, CONCORD_GROK_BIN (CLI paths), CONCORD_STATE_DIR, CONCORD_CACHE_DIR.
${W.METAPHOR}`;

// ------------------------------------------------------------------ utilities

function parseArgs(argv) {
  const pos = []; const opt = {};
  const flags = new Set(['--json', '--refresh', '--retry', '--help', '-h', '--version']);
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
  if (!Array.isArray(spec.tests) || spec.tests.length === 0 || spec.tests.length > 10) {
    throw new ConcordError('spec.tests needs 1..10 test commands; Concord never passes without real tests', 'no_tests');
  }
  const tests = spec.tests.map((t) => {
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
  for (const k of Object.keys(spec.limits ?? {})) if (!(k in LIMITS)) throw new ConcordError(`unknown limits key: ${k}`, 'spec');
  return { request: spec.request, tests, policy, models: m, limits };
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

function beginStep(store, id, role, extra = {}) {
  const r = store.run;
  const attempt = r.steps.filter((s) => s.id === id).length + 1;
  const step = { id, attempt, role, label: W.ROLES[role].label, provider: W.ROLES[role].provider, status: 'running', started_at: now(), ...extra };
  r.steps.push(step); store.save();
  current = { store, step };
  return step;
}

function endStep(store, step, status, extra = {}) {
  Object.assign(step, { status, ended_at: now(), ms: Date.parse(now()) - Date.parse(step.started_at) }, extra);
  if (status === 'failed' || status === 'cancelled') {
    store.run.status = 'failed';
    store.run.failure = { step: step.id, attempt: step.attempt, error: step.error, at: step.ended_at };
  }
  store.save();
  current = null;
}

/** Mark steps left `running` by a dead helper as interrupted (never auto re-run). */
function markStale(store) {
  const stale = store.run.steps.filter((s) => s.status === 'running');
  for (const s of stale) {
    Object.assign(s, { status: 'interrupted', ended_at: now(), error: 'helper exited while this step was running; not re-executed automatically' });
  }
  if (stale.length) {
    store.run.status = 'failed';
    store.run.failure = { step: stale[0].id, attempt: stale[0].attempt, error: stale[0].error, at: now(), interrupted: true };
    store.save();
  }
  return stale.map((s) => s.id);
}

// ------------------------------------------------------------------ external CLI steps

async function runCli(store, stepId, role, prompt, schema) {
  const r = store.run;
  const route = r.models[stepId.replace(/-\d+$/, '')]; // proposal | review | plan | qa
  const step = beginStep(store, stepId, role, { provider: W.ROLES[role].provider, model: route.model, model_evidence: route.evidence });
  const a = step.attempt;
  const promptFile = store.p('prompts', `${stepId}.a${a}.txt`);
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  const schemaFile = store.p('prompts', `${stepId}.schema.json`);
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const out = store.p('logs', `${stepId}.a${a}.stdout.log`);
  const err = store.p('logs', `${stepId}.a${a}.stderr.log`);
  const modelArgs = route.model === 'account_default' ? [] : ['--model', route.model];
  const b = bins();
  let argv; let cwd = store.loc.repo; let stdinPath = null; let tmp = null;
  const last = store.p('logs', `${stepId}.a${a}.last.txt`);
  if (W.ROLES[role].provider === 'codex') {
    argv = [b.codex, 'exec', '--sandbox', 'read-only', '--ephemeral', '--color', 'never', '-C', store.loc.repo,
      '--output-schema', schemaFile, '-o', last, ...modelArgs, '-'];
    stdinPath = promptFile;
  } else {
    // Independent review: empty temp cwd, no tools at all (`--tools ""`), a single turn;
    // the prompt carries all context. Schema and wall-clock timeout still apply.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-review-'));
    cwd = tmp;
    argv = [b.grok, '--prompt-file', promptFile, '--output-format', 'json', '--cwd', tmp, '--permission-mode', 'plan',
      '--tools', '', '--no-subagents', '--disable-web-search', '--max-turns', '1', '--json-schema', JSON.stringify(schema), ...modelArgs];
  }
  step.argv = argv.map((x) => (x === promptFile ? '<prompt-file>' : x.length > 200 ? `<${x.length} chars>` : x));
  store.save();
  const res = await runProc(argv, { cwd, env: process.env, timeoutMs: r.limits.cli_timeout_s * 1000, stdoutPath: out, stderrPath: err, stdinPath });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  const logs = { stdout: path.relative(store.dir, out), stderr: path.relative(store.dir, err) };
  if (res.error || res.timedOut || res.code !== 0) {
    const why = res.error || (res.timedOut ? `timed out after ${r.limits.cli_timeout_s}s (process group killed)` : `exit ${res.code ?? res.signal}`);
    endStep(store, step, 'failed', { error: `${why}: ${tail(err, 600).trim()}`.trim(), logs });
    return null;
  }
  const text = W.ROLES[role].provider === 'codex' ? (fs.existsSync(last) ? fs.readFileSync(last, 'utf8') : '') : fs.readFileSync(out, 'utf8');
  try {
    const parsed = W.ROLES[role].provider === 'grok' ? W.unwrapGrok(text) : W.extractJson(text);
    return { step, parsed, logs };
  } catch (e) {
    endStep(store, step, 'failed', { error: `malformed ${role} output: ${e.message}`, logs });
    return null;
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
      plan: proposal?.plan ?? null, changed: changed.length ? changed.join('\n') : null,
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
    const before = fingerprint(store.loc);
    const step = beginStep(store, id, 'test', { fingerprint: before.sha256, commands: [] });
    let ok = true;
    for (const [i, argv] of r.tests.entries()) {
      const out = store.p('logs', `${id}.${i + 1}.stdout.log`);
      const err = store.p('logs', `${id}.${i + 1}.stderr.log`);
      const res = await runProc(argv, { cwd: store.loc.repo, env: { ...process.env, CONCORD_RUN_ID: r.id }, timeoutMs: r.limits.test_timeout_s * 1000, stdoutPath: out, stderrPath: err });
      const passed = !res.error && !res.timedOut && res.code === 0;
      step.commands.push({ argv, code: res.code, signal: res.signal, timed_out: res.timedOut, error: res.error, ms: res.ms, passed,
        logs: { stdout: path.relative(store.dir, out), stderr: path.relative(store.dir, err) } });
      store.save();
      if (!passed) { ok = false; break; }
    }
    const after = fingerprint(store.loc);
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
    const fp = fingerprint(store.loc).sha256;
    if (!lastTest || lastTest.status !== 'passed' || lastTest.fingerprint !== fp) {
      r.phase = 'test'; r.policy_notes.push(`${now()}: working state changed after tests; re-running tests before QA.`); store.save(); return;
    }
    const n = r.steps.filter((s) => s.role === 'qa').length + 1;
    const diffAll = git(store.loc.repo, ['diff', '--no-color', '--no-ext-diff', r.baseline.head]);
    const diff = diffAll.length > MAX_DIFF ? `${diffAll.slice(0, MAX_DIFF)}\n…[diff truncated at ${MAX_DIFF} bytes; inspect files directly]` : diffAll || '(no tracked changes)';
    const untracked = git(store.loc.repo, ['ls-files', '--others', '--exclude-standard']).trim();
    const tests = lastTest.commands.map((c) => `- ${JSON.stringify(c.argv)} exit ${c.code}`).join('\n');
    const plan = { summary: store.readArtifact('plan')?.summary, tasks: r.tasks.map(({ id, title, files, status }) => ({ id, title, files, status })) };
    const res = await runCli(store, `qa-${n}`, 'qa', W.qaPrompt(r, { plan, tests, diff, untracked }), W.SCHEMAS.qa);
    if (!res) return;
    const qa = accept(store, res, W.validateQA, `qa-${n}`);
    if (!qa) return;
    const after = fingerprint(store.loc).sha256;
    Object.assign(res.step, { fingerprint: fp, verdict: qa.verdict, blocking: qa.blocking, inconsistent: qa.inconsistent });
    if (after !== fp) {
      res.step.status = 'failed'; res.step.error = 'working state changed during read-only QA; validation refused';
      r.status = 'failed'; r.failure = { step: res.step.id, error: res.step.error, at: now() }; store.save(); return;
    }
    if (qa.passed) {
      if (!fastGate(store, res.step.id)) return; // never validate a fast run with non-docs changes
      r.validation = { fingerprint: fp, tests_step: lastTest.id, qa_step: res.step.id, at: now() };
      r.status = 'validated'; r.phase = 'done'; store.save(); return;
    }
    store.save();
    needRepair(store, { kind: 'qa', step: res.step.id, summary: qa.summary, inconsistent_verdict: qa.inconsistent,
      findings: qa.findings.filter((f) => f.blocking || qa.verdict === 'fail') });
  },
};

/** Modified/added/deleted tracked paths (staged or not) plus new untracked paths vs the baseline. */
function changedPaths(store) {
  const { repo, stateRoot } = store.loc;
  const own = path.relative(repo, stateRoot);
  const tracked = git(repo, ['diff', '--name-only', '--no-renames', '-z', store.run.baseline.head]).split('\0');
  const untracked = git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0');
  return [...new Set([...tracked, ...untracked].filter((p) => p && !(own && !own.startsWith('..') && p.startsWith(`${own}/`))))].sort();
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

function cmdFor(store, ...args) {
  return ['node', SELF, ...args, '--repo', store.loc.repo];
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
    return { ...base, action: 'await_human', validation: r.validation,
      message: '天子决之 · 人工审批: validated. The human reviews the working tree; an approval only records review bound to this exact state. Nothing is committed, pushed or deployed.' };
  }
  if (r.phase === 'implement') {
    const done = new Set(r.tasks.filter((t) => t.status === 'done').map((t) => t.id));
    const t = r.tasks.find((x) => x.status !== 'done' && x.depends_on.every((d) => done.has(d)));
    const id = `task-${t.id}`;
    return { ...base, action: 'implement', step: id, task: t, tier: t.tier, tier_reason: t.tier_reason,
      agent: { subagent_type: 'general-purpose', model: t.tier },
      rules: 'Edit only what this task needs in the current checkout. Do not commit, stash, reset, push or run destructive git commands. Do not run the configured tests as a substitute for Concord validation.',
      done: cmdFor(store, 'advance', r.id, '--done', id, '--executor', 'subagent|main'),
      progress: `${done.size}/${r.tasks.length} tasks done` };
  }
  if (r.phase === 'repair') {
    const id = `repair-${r.repairs_used + 1}`;
    return { ...base, action: 'repair', step: id, round: r.repairs_used + 1, max_rounds: r.limits.max_repairs, cause: r.repair_cause,
      agent: { subagent_type: 'general-purpose', model: r.models.repair_override || 'sonnet' },
      rules: 'Fix only the reported failures/findings in the current checkout. Do not commit, stash, reset or push.',
      done: cmdFor(store, 'advance', r.id, '--done', id, '--executor', 'subagent|main') };
  }
  return { ...base, action: 'continue', message: 'Helper-owned steps remain; run advance again.', next: cmdFor(store, 'advance', r.id) };
}

// ------------------------------------------------------------------ commands

function withLock(loc, runId, fn) {
  const lock = acquireLock(loc, runId);
  const onSignal = (sig) => {
    killAll();
    if (current) {
      try { endStep(current.store, current.step, 'cancelled', { error: `cancelled by ${sig}; child process group killed` }); } catch { /* best effort */ }
    }
    lock.release();
    process.exit(130);
  };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  return Promise.resolve().then(() => fn(lock)).finally(() => {
    lock.release(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  });
}

async function cmdStart(loc, opt) {
  if (!opt.spec) throw new ConcordError('start needs --spec FILE (write it with the Write tool)', 'usage');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.resolve(opt.spec), 'utf8')); } catch (e) { throw new ConcordError(`cannot read spec: ${e.message}`, 'spec'); }
  const spec = validateSpec(raw);
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
    if (dirty.length) {
      throw new ConcordError(`checkout is not clean; Concord will not stash, reset, commit or overwrite your work. Commit or set aside these first:\n  ${dirty.slice(0, 20).join('\n  ')}`, 'dirty');
    }
    const headR = git(loc.repo, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
    if (headR.status !== 0) throw new ConcordError('repository has no commits; create an initial commit first', 'no_head');
    const id = newRunId();
    const store = new Store(loc, id);
    const notes = [];
    let policy = spec.policy;
    if (policy === 'fast' && !W.trivialDocsRequest(spec.request, RISK)) {
      policy = 'full';
      notes.push('fast policy requested but the request is not a narrow trivial docs fix; using full policy (Codex proposal → Grok review → Codex plan).');
    } else if (policy === 'fast') notes.push('fast policy: request matches the trivial docs allowlist; Codex proposal+plan combined.');
    store.run = {
      schema: 1, id, version: VERSION, created_at: now(), repo: loc.repo, request: spec.request, tests: spec.tests,
      requested_policy: spec.policy, policy, policy_notes: notes, limits: spec.limits, models,
      catalog: catalog ? { refreshed_at: catalog.refreshed_at, source: cachePath() } : null,
      baseline: { head: headR.stdout.trim(), fingerprint: fingerprint(loc).sha256, clean: true },
      status: 'active', phase: 'proposal', steps: [], tasks: [], repairs_used: 0, validation: null, approval: null, failure: null,
      execution: 'serial in the current checkout (parallel subagents are not supported in v0.2)',
    };
    store.save();
    writeJson(store.p('spec.json'), raw);
    return { run: id, status: 'active', policy, policy_notes: notes, state_dir: store.dir, next: cmdFor(store, 'advance', id) };
  });
}

async function cmdAdvance(loc, id, opt) {
  return withLock(loc, id, async (lock) => {
    const store = new Store(loc, id); store.load();
    const r = store.run;
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
      r.steps.push({ id: opt.failed, attempt: 1, role: na.action === 'repair' ? 'repair' : 'task', label: W.ROLES[na.action === 'repair' ? 'repair' : 'task'].label,
        provider: 'claude (native)', status: 'failed', at: now(), error: readNote(opt['note-file']) || 'session reported failure' });
      r.status = 'failed'; r.failure = { step: opt.failed, error: 'Claude session reported it could not complete this step', at: now() };
      store.save();
      return nextAction(store);
    }
    if (opt.done) recordDone(store, opt);
    if (r.status === 'validated' && fingerprint(loc).sha256 !== r.validation.fingerprint) {
      r.policy_notes.push(`${now()}: working state changed after validation; validation invalidated, re-testing.`);
      r.invalidated = [...(r.invalidated ?? []), { ...r.validation, at: now() }];
      r.validation = null; r.status = 'active'; r.phase = 'test'; store.save();
    }
    const budget = Number(opt.budget ?? 560) * 1000;
    const started = Date.now(); let ran = 0;
    while (r.status === 'active' && STAGES[r.phase]) {
      const cost = (r.phase === 'test' ? r.tests.length * r.limits.test_timeout_s : r.limits.cli_timeout_s) * 1000;
      if (ran && Date.now() - started + cost > budget) break;
      await STAGES[r.phase](store); ran++;
    }
    if (r.status === 'active' && ['implement', 'repair'].includes(r.phase)) { r.status = 'awaiting_session'; store.save(); }
    return nextAction(store);
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
  const fp = fingerprint(store.loc).sha256;
  const prev = [...r.steps].reverse().find((s) => s.fingerprint)?.fingerprint ?? r.baseline.fingerprint;
  const role = na.action === 'repair' ? 'repair' : 'task';
  const step = { id: opt.done, attempt: r.steps.filter((s) => s.id === opt.done).length + 1, role, label: W.ROLES[role].label,
    provider: 'claude (native)', executor, model, status: 'passed', at: now(), fingerprint: fp, changed: fp !== prev, note: readNote(opt['note-file']) };
  r.steps.push(step);
  if (role === 'repair' && fp === prev) {
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

function cmdStatus(loc, id, opt) {
  const store = new Store(loc, id); store.load();
  const r = store.run;
  const fp = fingerprint(loc).sha256;
  const lockFile = path.join(loc.stateRoot, 'lock');
  let lock = null; try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* none */ }
  const report = {
    run: r.id, status: r.status, phase: r.phase, policy: r.policy, policy_notes: r.policy_notes, repo: r.repo,
    baseline: r.baseline.head, working_state: fp,
    validation: r.validation ? { ...r.validation, current: r.validation.fingerprint === fp } : null,
    approval: r.approval, failure: r.failure, helper_running: lock?.run === r.id ? lock.pid : null,
    steps: r.steps.map(({ id: sid, attempt, label, provider, model, status, ms, error, reason, executor }) => ({ id: sid, attempt, label, provider, model, status, ms, error, reason, executor })),
    tasks: r.tasks.map(({ id: tid, title, status, tier, tier_reason }) => ({ id: tid, title, status, tier, tier_reason })),
    repairs: `${r.repairs_used}/${r.limits.max_repairs}`, next: nextAction(store), state_dir: store.dir,
    discussion: summarizeDiscussion(store), note: W.METAPHOR,
  };
  if (opt.json) return report;
  const mark = { invalidated: '⊘', passed: '✓', failed: '✗', tests_failed: '✗', skipped: '–', running: '…', interrupted: '!', cancelled: '✗' };
  const lines = [
    `贞观·政事堂 · Concord ${r.id}  status=${r.status} phase=${r.phase} policy=${r.policy}`,
    `repo ${r.repo}  baseline ${r.baseline.head.slice(0, 10)}  working-state ${fp.slice(0, 12)}${r.validation ? (report.validation.current ? ' (validated)' : ' (CHANGED since validation)') : ''}`,
    ...r.policy_notes.map((n) => `note: ${n}`),
    'steps:',
    ...r.steps.map((s) => {
      const model = typeof s.model === 'string' ? s.model : s.model ? `${s.model.requested_alias} [${s.executor}]` : '';
      return `  ${mark[s.status] ?? '?'} ${s.id}${s.attempt > 1 ? `#${s.attempt}` : ''}  ${s.label} · ${s.provider}${model ? `:${model}` : ''}${s.ms ? ` ${(s.ms / 1000).toFixed(1)}s` : ''}${s.reason ? ` — ${s.reason}` : ''}${s.error ? ` — ${s.error.split('\n')[0].slice(0, 200)}` : ''}`;
    }),
  ];
  if (r.tasks.length) lines.push('tasks:', ...r.tasks.map((t) => `  [${t.status}] ${t.id} ${t.title} → ${t.tier} (${t.tier_reason})`));
  const d = report.discussion;
  lines.push('政事堂议事 (run artifacts):',
    `  proposal: ${d.proposal ? d.proposal.summary : 'not produced'}`,
    `  review:   ${d.review ? (d.review.skipped ? 'skipped (see note)' : `${d.review.verdict} — ${d.review.summary}`) : 'not produced'}`,
    `  plan:     ${d.plan ? `${d.plan.tasks?.length ?? 0} task(s) — ${d.plan.summary}` : 'not produced'}`);
  if (r.failure) lines.push(`failure: ${r.failure.step}: ${r.failure.error}`);
  if (r.approval) lines.push(`approval: ${r.approval.decision} at ${r.approval.at} (record only; nothing deployed)`);
  lines.push(`next: ${report.next.action}${report.next.step ? ` ${report.next.step}` : ''}`, `state: ${store.dir}`);
  return lines.join('\n');
}

async function cmdApprove(loc, id, opt) {
  if (!['approve', 'reject'].includes(opt.decision)) throw new ConcordError('--decision approve|reject is required', 'usage');
  return withLock(loc, id, () => {
    const store = new Store(loc, id); store.load();
    const r = store.run;
    const fp = fingerprint(loc).sha256;
    if (opt.decision === 'approve') {
      if (r.status !== 'validated' || !r.validation) throw new ConcordError(`cannot approve: run is ${r.status}, not validated`, 'not_validated');
      if (r.validation.fingerprint !== fp) throw new ConcordError('cannot approve: working state changed since validation; run advance to re-validate', 'stale_validation');
    } else if (!OPEN.has(r.status)) throw new ConcordError(`run is already ${r.status}`, 'usage');
    r.approval = { decision: opt.decision, at: now(), fingerprint: fp, validation: r.validation, note: readNote(opt['note-file']),
      recorded_by: '天子决之 · 人工审批 (human decision recorded by helper)', effect: 'record only — no commit, merge, push or deployment' };
    r.status = opt.decision === 'approve' ? 'approved' : 'rejected';
    store.save();
    return { run: id, status: r.status, approval: r.approval };
  });
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
  const links = gitlinks(loc);
  const open = listRuns(loc).map((id) => { try { return readJson(path.join(runDir(loc, id), 'run.json')); } catch { return null; } })
    .filter((r) => r && OPEN.has(r.status)).map((r) => `${r.id} (${r.status})`);
  const head = git(loc.repo, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  const checks = {
    node: { ok: Number(process.versions.node.split('.')[0]) >= 18, value: process.versions.node },
    git_repo: { ok: true, value: loc.repo },
    has_commit: { ok: head.status === 0 },
    clean_checkout: { ok: dirty.length === 0, value: dirty.slice(0, 10) },
    no_submodules: { ok: links.length === 0, value: links.slice(0, 10) },
    no_open_run: { ok: open.length === 0, value: open },
    codex_on_path: { ok: !!which(b.codex), value: which(b.codex) },
    grok_on_path: { ok: !!which(b.grok), value: which(b.grok) },
    model_cache: { ok: true, value: catalog ? `${cachePath()} refreshed ${catalog.refreshed_at}${age > TTL_S ? ' (stale; models --refresh)' : ''}` : 'none (account defaults will be used)' },
    state_dir: { ok: true, value: loc.stateRoot },
  };
  const ok = Object.values(checks).every((c) => c.ok);
  const out = { ok, checks, note: 'Local checks only: no model CLI was executed, no inference, no networking. Login state is not verified.' };
  if (!ok) process.exitCode = 1;
  if (opt.json) return out;
  return [`Concord ${VERSION} preflight: ${ok ? 'OK' : 'NOT READY'}`,
    ...Object.entries(checks).map(([k, c]) => `  ${c.ok ? '✓' : '✗'} ${k}${c.value !== undefined && c.value !== true ? `: ${Array.isArray(c.value) ? c.value.join(', ') || '-' : c.value}` : ''}`),
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
    case 'start': return cmdStart(loc, opt);
    case 'advance': return cmdAdvance(loc, resolveRunId(loc, pos[1]), opt);
    case 'resume': return withLock(loc, resolveRunId(loc, pos[1]), (lock) => {
      const store = new Store(loc, resolveRunId(loc, pos[1])); store.load();
      if (lock.stale) { store.run.policy_notes.push(`${now()}: replaced stale lock from pid ${lock.stale.pid}`); store.save(); }
      const stale = markStale(store);
      return { ...nextAction(store), interrupted: stale, ...(stale.length ? { message: `Interrupted step(s) ${stale.join(', ')} recorded; not re-executed. advance --retry runs them again.` } : {}) };
    });
    case 'status': return cmdStatus(loc, resolveRunId(loc, pos[1]), opt);
    case 'list': return listRuns(loc).map((id) => {
      try { const r = readJson(path.join(runDir(loc, id), 'run.json')); return `${id}  ${r.status.padEnd(16)} ${r.phase.padEnd(10)} ${r.request.split('\n')[0].slice(0, 70)}`; } catch { return `${id}  (unreadable)`; }
    }).join('\n') || 'no runs';
    case 'show': return cmdShow(loc, resolveRunId(loc, pos[1]), pos[2]);
    case 'cancel': return cmdCancel(loc, resolveRunId(loc, pos[1]));
    case 'approve': return cmdApprove(loc, resolveRunId(loc, pos[1]), opt);
    default: throw new ConcordError(`unknown command: ${cmd} (see --help)`, 'usage');
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  main(process.argv.slice(2)).then((out) => {
    process.stdout.write(`${typeof out === 'string' ? out : JSON.stringify(out, null, 2)}\n`);
  }, (e) => {
    const code = e instanceof ConcordError ? e.code : 'internal';
    process.stderr.write(`concord: ${e.message}\n`);
    process.stdout.write(`${JSON.stringify({ error: code, message: e.message })}\n`);
    process.exit(code === 'internal' ? 70 : 2);
  });
}
