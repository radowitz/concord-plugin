// Native tests for the Concord Claude Code plugin helper (node --test).
// Fake codex/grok CLIs, temporary git repos; no network, no real models.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { run as runProc } from '../plugins/concord/scripts/lib/proc.mjs';
import { routeTask, idsFromGrokText, MAX_BYTES } from '../plugins/concord/scripts/lib/models.mjs';
import { validatePlan, validateQA, trivialDocsRequest, isDocPath, Malformed } from '../plugins/concord/scripts/lib/workflow.mjs';
import { RISK } from '../plugins/concord/scripts/lib/models.mjs';
import { splitCommand } from '../plugins/concord/scripts/concord.mjs';
import { locate } from '../plugins/concord/scripts/lib/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '../plugins/concord');
const CLI = path.join(PLUGIN, 'scripts/concord.mjs');
const FAKE = path.join(HERE, 'fixtures/concord_plugin/fake-provider.mjs');
const TEST_OK = [process.execPath, '-e', "process.exit(require('fs').readFileSync('app.txt','utf8').trim()==='done'?0:1)"];
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

let t; // per-test sandbox

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'concord-plugin-test-')));
  temps.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.invalid');
  sh(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'todo\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Demo\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'init');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const p of ['codex', 'grok']) {
    fs.writeFileSync(path.join(bin, p), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${p} "$@"\n`, { mode: 0o755 });
  }
  // Fake package managers: log "<name> <cwd> <args>" and exit FAKE_PM_EXIT (default 0). Never touch the repo.
  for (const p of ['npm', 'pnpm', 'yarn']) {
    fs.writeFileSync(path.join(bin, p), `#!/bin/sh\necho "${p} $PWD $*" >> "$FAKE_PM_LOG"\nexit "\${FAKE_PM_EXIT:-0}"\n`, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_PM_LOG: path.join(root, 'pm.log'), CONCORD_CODEX_BIN: path.join(bin, 'codex'), CONCORD_GROK_BIN: path.join(bin, 'grok'),
    CONCORD_CACHE_DIR: path.join(root, 'cache'), FAKE_CALLS: path.join(root, 'calls.jsonl'), FAKE_SCENARIO: path.join(root, 'scenario.json') };
  delete env.CONCORD_STATE_DIR;
  return { root, repo, env };
}

function cli(...args) { return cliIn(t.repo, ...args); }
function cliIn(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: t.env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

function calls() {
  try { return fs.readFileSync(t.env.FAKE_CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

function scenario(obj) { fs.writeFileSync(t.env.FAKE_SCENARIO, JSON.stringify(obj)); }

function start(spec = {}) {
  const file = path.join(t.root, `spec-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ request: 'Make app.txt say done', tests: [TEST_OK], ...spec }));
  return cli('start', '--spec', file);
}

const edit = (content = 'done\n') => fs.writeFileSync(path.join(t.repo, 'app.txt'), content);
const runJson = (id) => JSON.parse(fs.readFileSync(path.join(t.repo, '.git/concord/runs', id, 'run.json'), 'utf8'));

beforeEach(() => { t = sandbox(); });

describe('local commands', () => {
  test('--help and preflight execute no model CLI and need no network', () => {
    const help = cli('--help');
    assert.equal(help.code, 0);
    assert.match(help.out, /no inference, no networking/);
    const pre = cli('preflight', '--json');
    assert.equal(pre.code, 0, pre.out);
    assert.equal(pre.json.ok, true);
    assert.equal(pre.json.checks.codex_on_path.value, t.env.CONCORD_CODEX_BIN);
    fs.writeFileSync(path.join(t.repo, 'scratch.txt'), 'mine');
    const dirty = cli('preflight', '--json');
    assert.equal(dirty.code, 0, 'dirty tree is a warning by default');
    assert.equal(dirty.json.ok, true);
    assert.deepEqual(dirty.json.warnings, ['clean_checkout', 'test_command'], 'no package.json: no autodetected check is only a warning');
    assert.match(dirty.json.checks.clean_checkout.value[0], /scratch\.txt/);
    const strict = cli('preflight', '--json', '--require-clean');
    assert.equal(strict.code, 1);
    assert.equal(strict.json.checks.clean_checkout.ok, false);
    assert.deepEqual(calls(), []);
  });

  test('models --refresh caches account-listed ids with source and timestamp', () => {
    assert.match(cli('models').out, /No model cache/);
    const r = cli('models', '--refresh', '--json');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.providers.codex.status, 'account-listed');
    assert.deepEqual(r.json.providers.codex.models, ['gpt-test-1', 'gpt-test-2']); // hidden excluded
    assert.deepEqual(r.json.providers.grok.models, ['grok-test-a', 'grok-test-b']);
    assert.match(r.json.providers.codex.source, /codex debug models/);
    assert.ok(Date.parse(r.json.providers.grok.observed_at));
    assert.deepEqual(r.json.providers.claude.models, ['haiku', 'sonnet', 'opus']);
    assert.equal(r.json.providers.claude.status, 'aliases');
    // Overrides must be account-listed once a list is cached; account_default always allowed.
    const bad = start({ models: { qa: 'gpt-made-up' } });
    assert.equal(bad.code, 2);
    assert.match(bad.json.message, /not in the account list/);
    const good = start({ models: { qa: 'gpt-test-2', worker: 'opus' } });
    assert.equal(good.code, 0, good.out);
    assert.equal(runJson(good.json.run).models.qa.model, 'gpt-test-2');
  });
});

describe('start guards', () => {
  test('strict require_clean refuses a dirty checkout and leaves user work untouched', () => {
    fs.writeFileSync(path.join(t.repo, 'mine.txt'), 'user work');
    edit('user edit\n');
    const r = start({ require_clean: true });
    assert.equal(r.code, 2);
    assert.equal(r.json.error, 'dirty');
    assert.equal(fs.readFileSync(path.join(t.repo, 'mine.txt'), 'utf8'), 'user work');
    assert.equal(fs.readFileSync(path.join(t.repo, 'app.txt'), 'utf8'), 'user edit\n');
    assert.equal(sh(t.repo, 'stash', 'list'), '');
    assert.equal(start({ require_clean: 'yes' }).json.error, 'spec');
  });

  test('requires real tests, rejects shell syntax and unknown keys', () => {
    assert.equal(start({ tests: [] }).json.error, 'no_tests');
    assert.match(start({ tests: ['npm test && rm -rf /'] }).json.message, /shell syntax/);
    assert.match(start({ deploy: true }).json.message, /unknown spec key/);
    assert.deepEqual(splitCommand("python3 -m pytest -q 'tests/a b.py'"), ['python3', '-m', 'pytest', '-q', 'tests/a b.py']);
    assert.throws(() => splitCommand('echo $(id)'), /shell syntax/);
  });

  test('hostile request text never reaches a shell', () => {
    const hostile = "x'; touch pwned; $(touch pwned2) `touch pwned3`";
    const r = start({ request: hostile });
    assert.equal(r.code, 0, r.out);
    cli('advance', r.json.run);
    assert.equal(fs.existsSync(path.join(t.repo, 'pwned')), false);
    assert.equal(fs.existsSync(path.join(t.repo, 'pwned2')), false);
    assert.equal(runJson(r.json.run).request, hostile);
  });
});

describe('full policy', () => {
  test('proposal → review → plan → native implementation → tests → QA → validated → approval record', () => {
    const s = start();
    assert.equal(s.code, 0, s.out);
    const id = s.json.run;
    assert.match(s.json.state_dir, /\.git\/concord\/runs\//);
    const a1 = cli('advance', id);
    assert.equal(a1.json.action, 'implement', a1.out);
    assert.equal(a1.json.step, 'task-T1');
    assert.equal(a1.json.tier, 'haiku'); // low difficulty, low risk
    assert.equal(a1.json.agent.model, 'haiku');
    const c = calls();
    assert.deepEqual(c.map((x) => `${x.provider}:${x.role}`), ['codex:proposal', 'grok:review', 'codex:plan']);
    const codexArgs = c[0].argv;
    assert.equal(codexArgs[codexArgs.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(!codexArgs.includes('--model'), 'account default passes no --model');
    assert.notEqual(c[1].cwd, t.repo, 'grok reviews from an empty temp dir');
    assert.equal(c[1].argv[c[1].argv.indexOf('--permission-mode') + 1], 'plan');
    // Concord's own state is git-internal: only the session's edit shows up.
    assert.equal(sh(t.repo, 'status', '--porcelain'), '');
    // Re-advancing without --done is idempotent (no new CLI calls).
    assert.equal(cli('advance', id).json.step, 'task-T1');
    assert.equal(calls().length, 3);

    edit();
    const wrong = cli('advance', id, '--done', 'task-T9');
    assert.equal(wrong.code, 2);
    const a2 = cli('advance', id, '--done', 'task-T1', '--executor', 'subagent');
    assert.equal(a2.json.action, 'await_human', a2.out);
    assert.equal(a2.json.status, 'validated');
    const run = runJson(id);
    const task = run.steps.find((x) => x.id === 'task-T1');
    assert.equal(task.model.requested_alias, 'haiku');
    assert.match(task.model.actual, /not observed/);
    const test1 = run.steps.find((x) => x.id === 'test-1');
    const qa1 = run.steps.find((x) => x.id === 'qa-1');
    assert.equal(test1.status, 'passed');
    assert.equal(test1.fingerprint, qa1.fingerprint);
    assert.equal(run.validation.fingerprint, test1.fingerprint);

    const st = cli('status', id);
    for (const label of ['中书省 · Codex 大脑', '门下省 · Grok 审议', '尚书省 · Codex 编排', '六部 · Claude Workers', '御史台 · Codex QA', '政事堂议事']) {
      assert.ok(st.out.includes(label), label);
    }
    const sj = cli('status', id, '--json').json;
    assert.equal(sj.discussion.review.verdict, 'approve');
    assert.equal(sj.discussion.plan.tasks[0].id, 'T1');
    assert.match(sj.note, /organizational metaphor/);
    assert.match(cli('show', id, 'review').out, /"verdict": "approve"/);
    assert.equal(cli('show', id, '../run').code, 2);

    const ap = cli('approve', id, '--decision', 'approve');
    assert.equal(ap.json.status, 'approved', ap.out);
    assert.equal(ap.json.approval.fingerprint, run.validation.fingerprint);
    assert.match(ap.json.approval.effect, /no commit, merge, push or deployment/);
    assert.equal(sh(t.repo, 'log', '--oneline').trim().split('\n').length, 1, 'nothing committed');
  });

  test('code change after validation invalidates it; approval refused until re-validated', () => {
    const id = start().json.run;
    cli('advance', id); edit();
    assert.equal(cli('advance', id, '--done', 'task-T1').json.status, 'validated');
    fs.writeFileSync(path.join(t.repo, 'new-untracked.txt'), 'later edit');
    const ap = cli('approve', id, '--decision', 'approve');
    assert.equal(ap.json.error, 'stale_validation');
    const again = cli('advance', id);
    assert.equal(again.json.status, 'validated');
    const run = runJson(id);
    assert.equal(run.invalidated.length, 1);
    assert.ok(run.steps.some((x) => x.id === 'qa-2'));
    assert.equal(cli('approve', id, '--decision', 'approve').json.status, 'approved');
  });

  test('blocking QA findings require a bounded Claude repair, then re-test and re-QA', () => {
    scenario({ qa: [{ verdict: 'pass', summary: 'mislabelled', findings: [{ blocking: true, file: 'app.txt', issue: 'missing newline', fix: 'add it' }] }] });
    const id = start().json.run;
    cli('advance', id); edit();
    const rep = cli('advance', id, '--done', 'task-T1');
    assert.equal(rep.json.action, 'repair', rep.out);
    assert.equal(rep.json.step, 'repair-1');
    assert.equal(rep.json.cause.kind, 'qa');
    assert.equal(rep.json.cause.inconsistent_verdict, true);
    assert.equal(rep.json.cause.findings[0].issue, 'missing newline');
    edit('done\n\n');
    const fin = cli('advance', id, '--done', 'repair-1', '--executor', 'main');
    assert.equal(fin.json.status, 'validated', fin.out);
    const r = runJson(id);
    assert.equal(r.repairs_used, 1);
    assert.match(r.steps.find((x) => x.id === 'repair-1').model.actual, /inherited from the main session/);
  });

  test('failing tests never pass; repair rounds are bounded and failure persists', () => {
    const id = start({ limits: { max_repairs: 1 } }).json.run;
    cli('advance', id);
    edit('wrong\n');
    const rep = cli('advance', id, '--done', 'task-T1');
    assert.equal(rep.json.action, 'repair');
    assert.equal(rep.json.cause.kind, 'tests');
    assert.equal(rep.json.cause.failures[0].code, 1);
    edit('still wrong\n'); // a real (but insufficient) repair
    const fail = cli('advance', id, '--done', 'repair-1');
    assert.equal(fail.json.action, 'failed');
    assert.match(fail.json.failure.error, /repair budget exhausted/);
    assert.equal(calls().filter((c) => c.role === 'qa').length, 0, 'QA never runs on failing tests');
    assert.equal(cli('advance', id, '--retry').code, 2);
    assert.equal(runJson(id).status, 'failed');
  });

  test('tests that dirty the working state cannot validate it', () => {
    const id = start({ tests: [[process.execPath, '-e', "require('fs').writeFileSync('out.log','x')"]] }).json.run;
    cli('advance', id); edit();
    const r = cli('advance', id, '--done', 'task-T1');
    assert.equal(r.json.action, 'failed');
    assert.match(r.json.failure.error, /tests modified/);
  });

  test('malformed plan is rejected and persisted; only an explicit --retry re-runs it', () => {
    scenario({ plan: [{ summary: 'cyclic', tasks: [
      { id: 'A', title: 'a', description: 'a', files: ['a'], depends_on: ['B'], difficulty: 'low', risk: 'low' },
      { id: 'B', title: 'b', description: 'b', files: ['b'], depends_on: ['A'], difficulty: 'low', risk: 'low' }] }] });
    const id = start().json.run;
    const r = cli('advance', id);
    assert.equal(r.json.action, 'failed');
    assert.match(r.json.failure.error, /cycle/);
    assert.ok(fs.existsSync(path.join(t.repo, '.git/concord/runs', id, 'artifacts/plan.rejected.a1.json')));
    const n = calls().length;
    assert.equal(cli('advance', id).json.action, 'failed');
    assert.equal(calls().length, n, 'no automatic re-execution');
    const retry = cli('advance', id, '--retry');
    assert.equal(retry.json.action, 'implement', retry.out);
    assert.equal(runJson(id).steps.filter((x) => x.id === 'plan').length, 2);
  });

  test('Grok rejection stops the run before any implementation', () => {
    scenario({ review: [{ verdict: 'reject', summary: 'unsafe', concerns: ['x'], required_changes: [] }] });
    const id = start().json.run;
    const r = cli('advance', id);
    assert.equal(r.json.action, 'failed');
    assert.match(r.json.failure.error, /rejected the proposal/);
    assert.equal(calls().filter((c) => c.role === 'plan').length, 0);
  });

  test('CLI failure exit is recorded with stderr', () => {
    scenario({ proposal: [{ $exit: 3 }] });
    const id = start().json.run;
    const r = cli('advance', id);
    assert.equal(r.json.action, 'failed');
    assert.match(r.json.failure.error, /exit 3: fake failure/);
  });

  test('working-state change during read-only QA refuses validation', () => {
    scenario({ qa: [{ $touch: 'app.txt' }] });
    const id = start().json.run;
    cli('advance', id); edit();
    const r = cli('advance', id, '--done', 'task-T1');
    assert.equal(r.json.action, 'failed');
    assert.match(r.json.failure.error, /changed during read-only QA/);
  });
});

describe('fast policy', () => {
  test('trivial docs fix: combined Codex call, Grok skipped with recorded reason', () => {
    scenario({ proposal_plan: [{ proposal: { summary: 'fix typo', approach: 'edit', risks: [], files: ['README.md'] },
      plan: { summary: 'one', tasks: [{ id: 'D1', title: 'typo', description: 'fix typo', files: ['README.md'], depends_on: [], difficulty: 'low', risk: 'low' }] } }] });
    const s = start({ request: 'Fix the typo in README.md', policy: 'fast', tests: [[process.execPath, '-e', '']] });
    assert.equal(s.json.policy, 'fast');
    const r = cli('advance', s.json.run);
    assert.equal(r.json.step, 'task-D1', r.out);
    assert.deepEqual(calls().map((c) => `${c.provider}:${c.role}`), ['codex:proposal_plan']);
    const review = runJson(s.json.run).steps.find((x) => x.id === 'review');
    assert.equal(review.status, 'skipped');
    assert.match(review.reason, /trivial docs-only/);
  });

  test('fast on a non-trivial request falls back to full policy with a reason', () => {
    const s = start({ request: 'Rewrite the auth flow', policy: 'fast' });
    assert.equal(s.json.policy, 'full');
    assert.match(s.json.policy_notes[0], /not a narrow trivial docs fix/);
  });

  test('fast plan touching code reverts to Grok review and re-plan', () => {
    const s = start({ request: 'Fix the typo in README.md', policy: 'fast' });
    const r = cli('advance', s.json.run);
    assert.equal(r.json.action, 'implement');
    assert.deepEqual(calls().map((c) => `${c.provider}:${c.role}`), ['codex:proposal_plan', 'grok:review', 'codex:plan']);
    assert.match(runJson(s.json.run).policy_notes.join(' '), /reverted to full/);
  });
});

describe('interruption, cancellation and locking', () => {
  test('stale in-progress step is reported as interrupted, not re-executed', () => {
    const id = start().json.run;
    const file = path.join(t.repo, '.git/concord/runs', id, 'run.json');
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    run.steps.push({ id: 'proposal', attempt: 1, role: 'proposal', label: 'x', provider: 'codex', status: 'running', started_at: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(run));
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    fs.writeFileSync(path.join(t.repo, '.git/concord/lock'), JSON.stringify({ pid: Number(dead), host: os.hostname(), run: id }));
    const r = cli('resume', id);
    assert.deepEqual(r.json.interrupted, ['proposal']);
    assert.equal(r.json.action, 'failed');
    assert.equal(calls().length, 0);
    assert.equal(runJson(id).steps[0].status, 'interrupted');
    assert.equal(cli('advance', id, '--retry').json.action, 'implement');
  });

  test('a live lock blocks a second helper', () => {
    const id = start().json.run;
    fs.writeFileSync(path.join(t.repo, '.git/concord/lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), run: id }));
    const r = cli('advance', id);
    assert.equal(r.json.error, 'locked');
    fs.unlinkSync(path.join(t.repo, '.git/concord/lock'));
  });

  test('only one open run per checkout', () => {
    start();
    const second = start();
    assert.equal(second.json.error, 'open_run');
  });

  test('SIGTERM during a hung CLI kills its process group and persists the cancellation', async () => {
    scenario({ proposal: [{ $hang: true }] });
    t.env.FAKE_GRANDCHILD = path.join(t.root, 'grandchild.pid');
    const id = start().json.run;
    const child = spawn(process.execPath, [CLI, 'advance', id], { cwd: t.repo, env: t.env, stdio: 'ignore' });
    for (let i = 0; i < 100 && !fs.existsSync(t.env.FAKE_GRANDCHILD); i++) await new Promise((r) => setTimeout(r, 50));
    const gpid = Number(fs.readFileSync(t.env.FAKE_GRANDCHILD, 'utf8'));
    const res = cli('cancel', id);
    assert.equal(res.json.status, 'cancelled', res.out);
    await new Promise((r) => child.on('exit', r));
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(gpid, 0), /ESRCH/, 'grandchild was killed with the group');
    const run = runJson(id);
    assert.equal(run.steps[0].status, 'cancelled');
    assert.equal(run.status, 'cancelled');
    assert.equal(fs.existsSync(path.join(t.repo, '.git/concord/lock')), false);
  });
});

describe('units', () => {
  test('timeout kills the whole process group', async () => {
    const pidFile = path.join(t.root, 'gc.pid');
    const script = `const g=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setInterval(()=>{},1000)`;
    const r = await runProc([process.execPath, '-e', script], { timeoutMs: 700 });
    assert.equal(r.timedOut, true);
    await new Promise((res) => setTimeout(res, 100));
    assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0), /ESRCH/);
    const missing = await runProc(['concord-no-such-binary']);
    assert.match(missing.error, /command not found/);
  });

  test('吏部选才 routing by difficulty/risk with overrides', () => {
    const base = { title: 't', description: 'd', files: ['a.js'] };
    assert.equal(routeTask({ ...base, difficulty: 'low', risk: 'low' }).tier, 'haiku');
    assert.equal(routeTask({ ...base, difficulty: 'medium', risk: 'low' }).tier, 'sonnet');
    assert.equal(routeTask({ ...base, difficulty: 'low', risk: 'high' }).tier, 'opus');
    assert.equal(routeTask({ ...base, description: 'touch auth tokens', difficulty: 'low', risk: 'low' }).tier, 'opus');
    assert.equal(routeTask({ ...base, difficulty: 'high', risk: 'high' }, 'haiku').tier, 'haiku');
    assert.throws(() => routeTask(base, 'claude-made-up'), /invalid Claude tier/);
  });

  test('plan / QA validation and docs allowlist', () => {
    const task = { id: 'A', title: 'a', description: 'a', files: ['x.js'], depends_on: [], difficulty: 'low', risk: 'low' };
    assert.throws(() => validatePlan({ summary: 's', tasks: [{ ...task, files: ['../escape'] }] }), Malformed);
    assert.throws(() => validatePlan({ summary: 's', tasks: [task, task] }), /duplicate/);
    assert.throws(() => validatePlan({ summary: 's', tasks: [{ ...task, depends_on: ['Z'] }] }), /unknown dependency/);
    const order = validatePlan({ summary: 's', tasks: [{ ...task, id: 'B', depends_on: ['A'] }, task] });
    assert.deepEqual(order.map((x) => x.id), ['A', 'B']);
    assert.equal(validateQA({ verdict: 'pass', summary: 's', findings: [{ blocking: false, file: '', issue: 'nit', fix: '' }] }).passed, true);
    assert.throws(() => validateQA({ verdict: 'pass', summary: 's' }), Malformed);
    assert.equal(trivialDocsRequest('Fix the typo in README.md', RISK), true);
    assert.equal(trivialDocsRequest('修正 README.md 中的错别字', RISK), true);
    assert.equal(trivialDocsRequest('Fix the typo in README.md and deploy', RISK), false);
    assert.equal(trivialDocsRequest('Fix the typo in src/app.js', RISK), false);
    assert.deepEqual(idsFromGrokText('Available models:\n- grok-x\n'), ['grok-x']);
    assert.deepEqual(idsFromGrokText('Try grok-advertised today'), []);
  });
});

describe('packaging', () => {
  test('standalone package holds marketplace, LICENSE and only plugin assets', () => {
    const out = path.join(t.root, 'dist');
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/package.mjs'), '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const market = JSON.parse(fs.readFileSync(path.join(out, '.claude-plugin/marketplace.json'), 'utf8'));
    assert.equal(market.plugins[0].name, 'concord');
    assert.equal(market.plugins[0].source, './concord');
    const files = spawnSync('find', [out, '-type', 'f'], { encoding: 'utf8' }).stdout.trim().split('\n').map((f) => path.relative(out, f)).sort();
    assert.ok(files.includes('concord/LICENSE'));
    assert.ok(files.includes('concord/scripts/concord.mjs'));
    assert.ok(files.includes('concord/skills/run/SKILL.md'));
    assert.ok(files.every((f) => !/\.py$|agentflow|tests?\//.test(f)), files.join('\n'));
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'concord/.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(manifest.version, '0.2.1');
    // Packaged helper runs standalone.
    assert.equal(spawnSync(process.execPath, [path.join(out, 'concord/scripts/concord.mjs'), '--version'], { encoding: 'utf8' }).stdout.trim(), '0.2.1');
  });
});

describe('review follow-up regressions', () => {
  const DOCS_PLAN = { proposal_plan: [{ proposal: { summary: 'typo', approach: 'edit', risks: [], files: ['README.md'] },
    plan: { summary: 'one', tasks: [{ id: 'D1', title: 'typo', description: 'fix typo', files: ['README.md'], depends_on: [], difficulty: 'low', risk: 'low' }] } }] };

  test('Grok runs tool-less, single turn, with full inline context', () => {
    const id = start().json.run;
    cli('advance', id);
    const g = calls().find((c) => c.provider === 'grok').argv;
    assert.equal(g[g.indexOf('--tools') + 1], '');
    assert.equal(g[g.indexOf('--max-turns') + 1], '1');
    assert.ok(g.includes('--json-schema'));
    const prompt = fs.readFileSync(path.join(t.repo, '.git/concord/runs', id, 'prompts/review.a1.txt'), 'utf8');
    for (const tag of ['<request>', '<proposal>', '<configured_tests>', '<policy_notes>', '<repository_files>']) assert.ok(prompt.includes(tag), tag);
    assert.match(prompt, /app\.txt/);
  });

  test('docs allowlist admits only README/CHANGELOG and docs/ prose', () => {
    for (const ok of ['README.md', 'CHANGELOG', 'src/README.rst', 'docs/guide.md', 'docs/a/b.txt']) assert.equal(isDocPath(ok), true, ok);
    for (const bad of ['docs/a.js', 'AGENTS.md', 'CLAUDE.md', 'docs/AGENTS.md', 'skills/run/SKILL.md', 'plugins/x/README.md',
      '.claude/README.md', '.github/workflows/ci.yml', 'package-lock.json', 'notes.md', 'docs/config.json', 'app.txt']) assert.equal(isDocPath(bad), false, bad);
  });

  test('fast run fails closed when ACTUAL changes leave safe docs; retry goes to full review/replan', () => {
    scenario(DOCS_PLAN);
    const id = start({ request: 'Fix the typo in README.md', policy: 'fast', tests: [TEST_OK] }).json.run;
    assert.equal(cli('advance', id).json.step, 'task-D1');
    edit(); // the "docs" task actually changed app.txt
    const r = cli('advance', id, '--done', 'task-D1');
    assert.equal(r.json.action, 'failed', r.out);
    assert.equal(r.json.failure.fast_gate, true);
    assert.deepEqual(r.json.failure.paths, ['app.txt']);
    assert.equal(fs.readFileSync(path.join(t.repo, 'app.txt'), 'utf8'), 'done\n', 'files preserved');
    const run = runJson(id);
    assert.equal(run.steps.find((s) => s.id === 'review').status, 'invalidated');
    assert.equal(run.validation, null);
    assert.equal(calls().filter((c) => c.role === 'qa').length, 0);
    assert.equal(cli('advance', id).json.action, 'failed', 'no silent continuation');
    const retry = cli('advance', id, '--retry');
    assert.equal(retry.json.action, 'implement', retry.out);
    assert.equal(retry.json.policy, 'full');
    assert.deepEqual(calls().map((c) => c.role), ['proposal_plan', 'review', 'plan']);
    // attempt 2: the invalidated skipped review is attempt 1
    const prompt = fs.readFileSync(path.join(t.repo, '.git/concord/runs', id, 'prompts/review.a2.txt'), 'utf8');
    assert.match(prompt, /<already_changed_paths_in_working_tree>\napp\.txt/);
  });

  test('fast run touching only README validates', () => {
    scenario(DOCS_PLAN);
    const id = start({ request: 'Fix the typo in README.md', policy: 'fast', tests: [[process.execPath, '-e', '']] }).json.run;
    cli('advance', id);
    fs.writeFileSync(path.join(t.repo, 'README.md'), '# Demo fixed\n');
    assert.equal(cli('advance', id, '--done', 'task-D1').json.status, 'validated');
  });

  test('a repair that changes nothing stops with a persisted failure and no extra tests/QA', () => {
    scenario({ qa: [{ verdict: 'fail', summary: 'bad', findings: [{ blocking: true, file: 'app.txt', issue: 'x', fix: 'y' }] }] });
    const id = start().json.run;
    cli('advance', id); edit();
    assert.equal(cli('advance', id, '--done', 'task-T1').json.step, 'repair-1');
    const before = runJson(id).steps.length;
    const r = cli('advance', id, '--done', 'repair-1');
    assert.equal(r.json.action, 'failed', r.out);
    assert.equal(r.json.failure.noop_repair, true);
    const run = runJson(id);
    assert.equal(run.steps.length, before + 1, 'no test/QA step was added');
    assert.equal(run.repairs_used, 0);
    assert.equal(calls().filter((c) => c.role === 'qa').length, 1);
    assert.equal(cli('advance', id, '--retry').json.step, 'repair-1');
    edit('done\n\n');
    assert.equal(cli('advance', id, '--done', 'repair-1').json.status, 'validated');
    assert.equal(runJson(id).steps.filter((s) => s.id === 'repair-1').map((s) => s.attempt).join(), '1,2');
  });

  test('submodules (gitlinks) and nested repos are refused, not falsely validated', () => {
    const head = sh(t.repo, 'rev-parse', 'HEAD').trim();
    sh(t.repo, 'update-index', '--add', '--cacheinfo', `160000,${head},vendor/sub`);
    sh(t.repo, 'commit', '-qm', 'gitlink');
    const pre = cli('preflight', '--json');
    assert.equal(pre.json.checks.no_submodules.ok, false);
    assert.equal(start().json.error, 'submodule');
    t = sandbox();
    sh(path.join(t.repo), 'init', '-q', 'nested');
    assert.equal(start().json.error, 'submodule');
  });

  test('locate resolves subdirectories and linked worktrees to the shared git-common-dir', () => {
    fs.mkdirSync(path.join(t.repo, 'web/deep'), { recursive: true });
    const sub = locate(path.join(t.repo, 'web/deep'));
    assert.equal(sub.repo, t.repo);
    assert.equal(sub.stateRoot, path.join(t.repo, '.git/concord'));
    const wt = path.join(t.root, 'wt');
    sh(t.repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    const linked = locate(wt);
    assert.equal(linked.repo, wt);
    assert.equal(linked.stateRoot, path.join(t.repo, '.git/concord'));
  });
});

describe('real CLI compatibility', () => {
  test('codex catalog larger than 512 KiB parses; over the 32 MiB cap is rejected', () => {
    t.env.FAKE_CODEX_MODELS_BYTES = String(700 * 1024); // real `codex debug models` ≈ 630 KiB
    const ok = cli('models', '--refresh', '--json');
    assert.equal(ok.json.providers.codex.status, 'account-listed', JSON.stringify(ok.json.providers.codex));
    assert.deepEqual(ok.json.providers.codex.models, ['gpt-test-1', 'gpt-test-2']);
    assert.equal(ok.json.providers.grok.status, 'account-listed');
    t.env.FAKE_CODEX_MODELS_BYTES = String(MAX_BYTES.codex + 1024 * 1024);
    const big = cli('models', '--refresh', '--json');
    assert.equal(big.json.providers.codex.status, 'unavailable');
    assert.match(big.json.providers.codex.error, /output too large/);
    assert.deepEqual(big.json.providers.codex.models, []);
  });
});

describe('dirty baseline (v0.2.1)', () => {
  const idx = () => fs.readFileSync(path.join(t.repo, '.git/index'));
  const DOCS = { proposal_plan: [{ proposal: { summary: 'typo', approach: 'edit', risks: [], files: ['README.md'] },
    plan: { summary: 'one', tasks: [{ id: 'D1', title: 'typo', description: 'fix typo', files: ['README.md'], depends_on: [], difficulty: 'low', risk: 'low' }] } }] };
  const qaPrompt = (id, n = 1) => fs.readFileSync(path.join(t.repo, '.git/concord/runs', id, `prompts/qa-${n}.a1.txt`), 'utf8');

  test('untracked .vscode/extensions.json does not block a real CLI start; bytes, status and index unchanged', () => {
    fs.mkdirSync(path.join(t.repo, '.vscode'));
    const ext = '{"recommendations": ["a.b"]}\n';
    fs.writeFileSync(path.join(t.repo, '.vscode/extensions.json'), ext);
    const indexBefore = idx(); const status = sh(t.repo, 'status', '--porcelain'); const head = sh(t.repo, 'rev-parse', 'HEAD');
    const s = start();
    assert.equal(s.code, 0, s.out + s.err);
    assert.equal(s.json.baseline.clean, false);
    assert.deepEqual(s.json.baseline.entries, ['?? .vscode/extensions.json']);
    assert.ok(cli('advance', s.json.run).json.baseline.count === 1);
    assert.equal(fs.readFileSync(path.join(t.repo, '.vscode/extensions.json'), 'utf8'), ext);
    assert.equal(sh(t.repo, 'status', '--porcelain'), status);
    assert.equal(sh(t.repo, 'rev-parse', 'HEAD'), head, 'no commit');
    assert.ok(idx().equals(indexBefore), 'real index byte-for-byte unchanged');
    assert.equal(sh(t.repo, 'stash', 'list'), '');
    assert.equal(sh(t.repo, 'branch', '--list').trim(), '* main');
    assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('concord-index-') && fs.existsSync(path.join(os.tmpdir(), n, 'index'))).length, 0, 'temp index cleaned');
    const b = runJson(s.json.run).baseline;
    assert.equal(b.clean, false);
    assert.match(b.work_tree, /^[0-9a-f]{40,64}$/);
    assert.equal(sh(t.repo, 'ls-tree', '-r', '--name-only', b.work_tree).includes('.vscode/extensions.json'), true);
  });

  test('preexisting staged/unstaged/deleted/renamed/space-named work is baseline, not QA diff; later changes are visible', () => {
    fs.writeFileSync(path.join(t.repo, 'staged.txt'), 's1\n'); fs.writeFileSync(path.join(t.repo, 'gone.txt'), 'g\n'); sh(t.repo, 'add', '.'); sh(t.repo, 'commit', '-qm', 'more');
    fs.unlinkSync(path.join(t.repo, 'gone.txt')); // unstaged deletion
    fs.writeFileSync(path.join(t.repo, 'staged.txt'), 's2\n'); sh(t.repo, 'add', 'staged.txt'); // staged
    fs.writeFileSync(path.join(t.repo, 'staged.txt'), 's3\n'); // + further unstaged (MM)
    fs.writeFileSync(path.join(t.repo, 'README.md'), '# Demo user edit\n'); // unstaged
    sh(t.repo, 'mv', 'app.txt', 'moved app.txt'); // staged rename (but TEST_OK reads app.txt, restored below)
    fs.copyFileSync(path.join(t.repo, 'moved app.txt'), path.join(t.repo, 'app.txt')); // keep tests runnable; app.txt now untracked
    fs.writeFileSync(path.join(t.repo, 'my notes.txt'), 'untracked with space\n');
    const indexBefore = idx();
    const s = start({ tests: [[process.execPath, '-e', '']] });
    assert.equal(s.code, 0, s.out + s.err);
    const b = runJson(s.json.run).baseline;
    const xy = Object.fromEntries(b.dirty.map((e) => [e.path, e.xy]));
    assert.equal(xy['staged.txt'], 'MM');
    assert.equal(xy['README.md'], ' M');
    assert.equal(xy['my notes.txt'], '??');
    assert.equal(xy['gone.txt'], ' D');
    assert.equal(xy['moved app.txt'], 'R ');
    assert.equal(b.dirty.find((e) => e.path === 'moved app.txt').orig, 'app.txt');
    assert.notEqual(b.index_tree, b.work_tree, 'staged and on-disk states are distinct');
    assert.equal(sh(t.repo, 'show', `${b.index_tree}:staged.txt`), 's2\n');
    assert.equal(sh(t.repo, 'show', `${b.work_tree}:staged.txt`), 's3\n');
    assert.equal(sh(t.repo, 'show', `${b.work_tree}:my notes.txt`), 'untracked with space\n');

    cli('advance', s.json.run);
    fs.writeFileSync(path.join(t.repo, 'later.txt'), 'new work\n');
    fs.writeFileSync(path.join(t.repo, 'README.md'), '# Demo user edit + worker\n');
    const r = cli('advance', s.json.run, '--done', 'task-T1');
    assert.equal(r.json.status, 'validated', r.out);
    const p = qaPrompt(s.json.run);
    const diff = p.slice(p.indexOf('<diff_against_start_baseline>'));
    assert.match(diff, /later\.txt/);
    assert.match(diff, /\+# Demo user edit \+ worker/);
    assert.doesNotMatch(diff, /staged\.txt|my notes|s3|moved app|gone\.txt/, 'pre-existing work is not in the QA diff');
    assert.match(p, /<preexisting_uncommitted_state_at_start>[\s\S]*my notes\.txt/);
    assert.match(p, /<new_untracked_files_since_start>\nlater\.txt\n<\/new_untracked_files_since_start>/);
    assert.ok(idx().equals(indexBefore), 'real index byte-for-byte unchanged through the run');
    assert.equal(fs.readFileSync(path.join(t.repo, 'my notes.txt'), 'utf8'), 'untracked with space\n');
    assert.equal(fs.readFileSync(path.join(t.repo, 'staged.txt'), 'utf8'), 's3\n');
  });

  test('worker/repair actions carry the baseline summary and the preserve rule', () => {
    fs.writeFileSync(path.join(t.repo, 'mine.txt'), 'x');
    const id = start().json.run;
    const a = cli('advance', id).json;
    assert.deepEqual(a.baseline.entries, ['?? mine.txt']);
    assert.match(a.rules, /Preserve pre-existing uncommitted edits/);
    assert.match(fs.readFileSync(path.join(t.repo, '.git/concord/runs', id, 'prompts/proposal.a1.txt'), 'utf8'), /preexisting_uncommitted_state_at_start>\n\?\? mine\.txt/);
    edit('wrong\n');
    const rep = cli('advance', id, '--done', 'task-T1').json;
    assert.equal(rep.action, 'repair');
    assert.match(rep.rules, /Preserve pre-existing/);
    assert.equal(rep.baseline.count, 1);
  });

  test('fast docs task validates with unrelated dirty files; fast code edits are still blocked', () => {
    fs.mkdirSync(path.join(t.repo, '.vscode'));
    fs.writeFileSync(path.join(t.repo, '.vscode/extensions.json'), '{}');
    edit('user wip\n'); // tracked, non-doc, dirty BEFORE start
    scenario(DOCS);
    const id = start({ request: 'Fix the typo in README.md', policy: 'fast', tests: [[process.execPath, '-e', '']] }).json.run;
    cli('advance', id);
    fs.writeFileSync(path.join(t.repo, 'README.md'), '# Demo fixed\n');
    const ok = cli('advance', id, '--done', 'task-D1');
    assert.equal(ok.json.status, 'validated', ok.out);
    assert.equal(runJson(id).steps.find((x) => x.id === 'review').status, 'skipped');
    // post-validation change (even to a preexisting dirty file) still invalidates
    edit('user wip 2\n');
    assert.equal(cli('approve', id, '--decision', 'approve').json.error, 'stale_validation');
    // ...and now the ACTUAL change is a non-doc file relative to baseline: fast gate fails closed
    const again = cli('advance', id);
    assert.equal(again.json.failure.fast_gate, true, again.out);
    assert.deepEqual(again.json.failure.paths, ['app.txt']);
    assert.equal(fs.readFileSync(path.join(t.repo, '.vscode/extensions.json'), 'utf8'), '{}');
  });

  test('fast new code edit blocked even when other work was dirty at start', () => {
    fs.writeFileSync(path.join(t.repo, 'notes.md'), 'wip');
    scenario(DOCS);
    const id = start({ request: 'Fix the typo in README.md', policy: 'fast', tests: [[process.execPath, '-e', '']] }).json.run;
    cli('advance', id);
    edit();
    const r = cli('advance', id, '--done', 'task-D1');
    assert.equal(r.json.failure.fast_gate, true);
    assert.deepEqual(r.json.failure.paths, ['app.txt']);
  });

  test('v0.2.0 persisted run (head-only clean baseline) still resumes and validates', () => {
    const id = start().json.run;
    const file = path.join(t.repo, '.git/concord/runs', id, 'run.json');
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    run.baseline = { head: run.baseline.head, fingerprint: run.baseline.fingerprint, clean: true };
    run.version = '0.2.0';
    fs.writeFileSync(file, JSON.stringify(run));
    assert.equal(cli('resume', id).json.action, 'continue');
    const a = cli('advance', id);
    assert.equal(a.json.step, 'task-T1');
    assert.equal(a.json.baseline.clean, true);
    edit();
    assert.equal(cli('advance', id, '--done', 'task-T1').json.status, 'validated');
    assert.match(qaPrompt(id), /diff_against_start_baseline>\n[\s\S]*\+done/);
    assert.match(cli('status', id).out, /validated/);
  });

  test('status reports preserved baseline; strict start on untracked-only dirt still refuses', () => {
    fs.writeFileSync(path.join(t.repo, 'u.txt'), '1');
    const strict = start({ require_clean: true });
    assert.equal(strict.json.error, 'dirty');
    assert.match(strict.json.message, /\?\? u\.txt/);
    const id = start().json.run;
    assert.match(cli('status', id).out, /baseline: 1 pre-existing uncommitted entry preserved \(\?\? u\.txt\)/);
    assert.equal(cli('status', id, '--json').json.baseline_state.count, 1);
  });
});

describe('check autodiscovery (v0.2.1)', () => {
  const pkg = (dir, obj) => { fs.mkdirSync(path.join(t.repo, dir), { recursive: true }); fs.writeFileSync(path.join(t.repo, dir, 'package.json'), JSON.stringify(obj)); };
  const touch = (f, c = '') => { fs.mkdirSync(path.dirname(path.join(t.repo, f)), { recursive: true }); fs.writeFileSync(path.join(t.repo, f), c); };
  const pmLog = () => { try { return fs.readFileSync(t.env.FAKE_PM_LOG, 'utf8').trim().split('\n'); } catch { return []; } };
  const noTests = (extra = {}) => start({ tests: undefined, ...extra });
  const qaPrompt = (id) => fs.readFileSync(path.join(t.repo, '.git/concord/runs', id, 'prompts/qa-1.a1.txt'), 'utf8');

  test('npm from scripts.test + package-lock; start without spec.tests runs it via argv and validates', () => {
    pkg('.', { name: 'x', scripts: { test: 'node t.js', lint: 'eslint .' } });
    touch('package-lock.json', '{}');
    const c = cli('checks', '--json').json;
    assert.deepEqual(c.selected.argv, ['npm', 'run', 'test']);
    assert.equal(c.selected.kind, 'test');
    assert.match(c.selected.source, /package\.json scripts\.test \(lockfile package-lock\.json\)/);
    const s = noTests();
    assert.equal(s.code, 0, s.out + s.err);
    assert.equal(s.json.checks.mode, 'auto');
    assert.equal(s.json.checks.behavioural_tests, true);
    const id = s.json.run;
    cli('advance', id); edit();
    const r = cli('advance', id, '--done', 'task-T1');
    assert.equal(r.json.status, 'validated', r.out);
    assert.deepEqual(runJson(id).tests, [['npm', 'run', 'test']]);
    assert.equal(runJson(id).test_selection.script, 'test');
    assert.equal(pmLog().length >= 1 && pmLog()[0], `npm ${t.repo} run test`);
    assert.match(cli('status', id).out, /checks: npm run test \[auto, test\]/);
  });

  test('pnpm via packageManager/lockfile; nearest package from cwd; typecheck reported truthfully', () => {
    pkg('.', { name: 'root', packageManager: 'pnpm@9.1.0', scripts: { test: 'vitest run' } });
    pkg('packages/api', { name: '@x/api', scripts: { typecheck: 'tsc --noEmit', build: 'tsc' } });
    touch('pnpm-lock.yaml'); touch('package-lock.json', '{}'); // packageManager would win at root; lock picks pnpm for api too? conflicting -> see below
    // api has no packageManager and two lockfiles up-tree: ambiguous, so nothing is selected there; the root package takes over.
    const amb = cliIn(path.join(t.repo, 'packages/api'), 'checks', '--json').json;
    assert.deepEqual(amb.selected.argv, ['pnpm', 'run', 'test']);
    assert.ok(amb.skipped.some((x) => /conflicting lockfiles/.test(x.reason)));
    fs.unlinkSync(path.join(t.repo, 'package-lock.json'));
    const c = cliIn(path.join(t.repo, 'packages/api'), 'checks', '--json').json;
    assert.deepEqual(c.selected.argv, ['pnpm', 'run', 'typecheck']);
    assert.equal(c.selected.cwd, 'packages/api');
    assert.equal(c.selected.kind, 'typecheck');
    assert.equal(c.behavioural_tests, false);
    assert.deepEqual(cli('checks', '--json').json.selected.argv, ['pnpm', 'run', 'test'], 'root cwd → root package');
    const s = cliIn(path.join(t.repo, 'packages/api'), 'start', '--spec', (() => { const f = path.join(t.root, 'spec-tc.json'); fs.writeFileSync(f, JSON.stringify({ request: 'Make app.txt say done' })); return f; })());
    assert.equal(s.code, 0, s.out + s.err);
    assert.equal(s.json.checks.behavioural_tests, false);
    const id = s.json.run;
    cli('advance', id); edit();
    const r = cli('advance', id, '--done', 'task-T1');
    assert.equal(r.json.status, 'validated', r.out);
    assert.match(r.json.message, /Validation gate was typecheck: TYPECHECK ONLY/);
    assert.equal(pmLog()[0], `pnpm ${path.join(t.repo, 'packages/api')} run typecheck`, 'runs in the package dir');
    assert.equal(runJson(id).validation.check_kind, 'typecheck');
    assert.match(qaPrompt(id), /NOTE \(kind=typecheck\): TYPECHECK ONLY[\s\S]*NOT evidence that behaviour was tested/);
    assert.match(cli('status', id).out, /\[auto, typecheck — TYPECHECK ONLY/);
  });

  test('yarn/bun selection by lockfile; preference test > check > typecheck > lint > build', () => {
    pkg('.', { scripts: { build: 'tsc', lint: 'eslint .', typecheck: 'tsc --noEmit', check: 'node check.js' } });
    touch('yarn.lock');
    assert.deepEqual(cli('checks', '--json').json.selected.argv, ['yarn', 'run', 'check']);
    pkg('.', { scripts: { build: 'tsc', lint: 'eslint .' } });
    assert.deepEqual(cli('checks', '--json').json.selected.argv, ['yarn', 'run', 'lint']);
    fs.unlinkSync(path.join(t.repo, 'yarn.lock')); touch('bun.lockb');
    const bun = cli('checks', '--json').json; // bun is not on PATH in the sandbox → not selected, reason recorded
    assert.equal(bun.selected, null);
    assert.ok(bun.skipped.some((x) => /bun is not on PATH/.test(x.reason)));
  });

  test('placeholder / watch / missing scripts fall through; nothing reliable → ask, never a false pass', () => {
    pkg('.', { scripts: { test: 'echo "Error: no test specified" && exit 1', typecheck: 'tsc --watch', lint: 'echo ok' } });
    let c = cli('checks', '--json').json;
    assert.equal(c.selected, null);
    assert.deepEqual(c.skipped.map((x) => x.script), ['test', 'typecheck', 'lint']);
    assert.match(c.skipped[0].reason, /placeholder/);
    assert.match(c.skipped[1].reason, /watch/);
    const s = noTests();
    assert.equal(s.code, 2);
    assert.equal(s.json.error, 'no_tests');
    assert.match(s.json.message, /Ask the user which command gates the run/);
    assert.deepEqual(fs.existsSync(path.join(t.repo, '.git/concord/runs')) ? fs.readdirSync(path.join(t.repo, '.git/concord/runs')) : [], [], 'no run created');
    pkg('.', { scripts: { test: 'jest --watchAll', build: 'tsc -p .' } });
    c = cli('checks', '--json').json;
    assert.deepEqual(c.selected.argv, ['npm', 'run', 'build']);
    assert.equal(c.selected.kind, 'build');
    assert.match(c.selected.note, /BUILD ONLY/);
    fs.rmSync(path.join(t.repo, 'package.json'));
    assert.equal(cli('checks', '--json').json.selected, null);
    assert.equal(noTests().json.error, 'no_tests');
    assert.match(cli('checks').out, /no reliable check command detected/);
  });

  test('explicit tests override autodetection; the original pnpm --filter spec stays valid; empty list still refused', () => {
    pkg('.', { scripts: { test: 'node t.js' } });
    const s = start({ tests: [[process.execPath, '-e', '']] });
    assert.equal(s.json.checks.mode, 'explicit');
    assert.deepEqual(runJson(s.json.run).tests, [[process.execPath, '-e', '']]);
    cli('cancel', s.json.run);
    const orig = path.join(t.root, 'orig-spec.json');
    fs.writeFileSync(orig, '{"request": "对我这个xddq_v2项目做一下安全审计", "tests": [["pnpm", "--filter", "@xddq/api", "typecheck"]]}');
    const o = cli('start', '--spec', orig);
    assert.equal(o.code, 0, o.out + o.err);
    assert.deepEqual(runJson(o.json.run).tests, [['pnpm', '--filter', '@xddq/api', 'typecheck']]);
    cli('cancel', o.json.run);
    assert.equal(start({ tests: [] }).json.error, 'no_tests');
  });

  test('autodetect with a dirty baseline: untracked .vscode preserved, index unchanged, QA told about baseline defects', () => {
    touch('.vscode/extensions.json', '{"recommendations":[]}\n');
    pkg('.', { scripts: { test: 'node t.js' } });
    const indexBefore = fs.readFileSync(path.join(t.repo, '.git/index'));
    const s = noTests();
    assert.equal(s.code, 0, s.out + s.err);
    assert.ok(s.json.baseline.entries.includes('?? .vscode/extensions.json'));
    const id = s.json.run;
    cli('advance', id); edit();
    assert.equal(cli('advance', id, '--done', 'task-T1').json.status, 'validated');
    assert.equal(fs.readFileSync(path.join(t.repo, '.vscode/extensions.json'), 'utf8'), '{"recommendations":[]}\n');
    assert.ok(fs.readFileSync(path.join(t.repo, '.git/index')).equals(indexBefore));
    const p = qaPrompt(id);
    assert.match(p, /do not report unchanged pre-existing edits as defects\. EXCEPTION: .*baseline.*requested outcome/);
    const diff = p.slice(p.indexOf('<diff_against_start_baseline>'));
    assert.doesNotMatch(diff, /extensions\.json|package\.json/);
  });

  test('strict mode still refuses a dirty start when tests are autodetected', () => {
    pkg('.', { scripts: { test: 'node t.js' } });
    const r = noTests({ require_clean: true });
    assert.equal(r.json.error, 'dirty');
  });

  test('explicit non-test commands are custom, never called behavioural tests (status, QA, await_human)', () => {
    const orig = path.join(t.root, 'orig-spec.json');
    fs.writeFileSync(orig, '{"request": "Make app.txt say done", "tests": [["pnpm", "--filter", "@xddq/api", "typecheck"]]}');
    const s = cli('start', '--spec', orig);
    assert.equal(s.json.checks.kind, 'custom');
    assert.equal(s.json.checks.behavioural_tests, false);
    assert.match(s.json.checks.note, /CUSTOM command/);
    const id = s.json.run;
    cli('advance', id); edit();
    const r = cli('advance', id, '--done', 'task-T1');
    assert.equal(r.json.status, 'validated', r.out);
    assert.match(r.json.message, /Validation gate was custom: CUSTOM command/);
    assert.match(cli('status', id).out, /\[explicit, custom — CUSTOM command/);
    assert.equal(cli('status', id, '--json').json.checks.behavioural_tests, false);
    assert.match(qaPrompt(id), /NOTE \(kind=custom\): CUSTOM command[\s\S]*NOT evidence/);
    // saved run without metadata must not claim tests either
    const file = path.join(t.repo, '.git/concord/runs', id, 'run.json');
    const run = JSON.parse(fs.readFileSync(file, 'utf8')); delete run.test_selection; fs.writeFileSync(file, JSON.stringify(run));
    assert.equal(cli('status', id, '--json').json.checks.kind, 'custom');
    // only <pm> test counts as a known test script
    cli('cancel', id);
    assert.equal(start({ tests: [['npm', 'test']] }).json.checks.behavioural_tests, true);
  });

  test('autodetect skips --fix/--write scripts that would mutate source', () => {
    pkg('.', { scripts: { test: 'eslint . --fix', check: 'prettier --write .', lint: 'eslint . --max-warnings=0', build: 'tsc' } });
    const c = cli('checks', '--json').json;
    assert.deepEqual(c.selected.argv, ['npm', 'run', 'lint']);
    assert.deepEqual(c.skipped.map((x) => x.script), ['test', 'check']);
    assert.match(c.skipped[0].reason, /auto-fix/);
    pkg('.', { scripts: { lint: 'eslint . --fix' } });
    assert.equal(cli('checks', '--json').json.selected, null);
  });
});
