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
    assert.equal(manifest.version, '0.2.2');
    // Packaged helper runs standalone.
    assert.equal(spawnSync(process.execPath, [path.join(out, 'concord/scripts/concord.mjs'), '--version'], { encoding: 'utf8' }).stdout.trim(), '0.2.2');
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

// ====================================================================== v0.2.2

import { Normalizer, codexStreamResult, formatsFromHelp, grokStreamResult, readLogRange } from '../plugins/concord/scripts/lib/stream.mjs';
import { checkCoverage } from '../plugins/concord/scripts/lib/coverage.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runDirOf = (id) => path.join(t.repo, '.git/concord/runs', id);
const saveRun = (id, mut) => { const f = path.join(runDirOf(id), 'run.json'); const r = JSON.parse(fs.readFileSync(f, 'utf8')); mut(r); fs.writeFileSync(f, JSON.stringify(r)); };
const promptOf = (id, name) => fs.readFileSync(path.join(runDirOf(id), 'prompts', name), 'utf8');
const eventsOf = (id, file) => fs.readFileSync(path.join(runDirOf(id), 'logs', file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const writeSpec = (obj) => { const f = path.join(t.root, `amend-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const amend = (id, obj, ...extra) => cli('amend', id, '--spec', writeSpec(obj), ...extra);

/** Run the helper in the background (like a Claude Code background Bash task) collecting stderr. */
function bg(args, cwd = t.repo, env = t.env) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const h = { child, out: '', err: '', done: new Promise((res) => child.on('exit', (code) => res(code))) };
  child.stdout.on('data', (d) => { h.out += d; });
  child.stderr.on('data', (d) => { h.err += d; });
  return h;
}
async function until(fn, ms = 8000) {
  for (let i = 0; i < ms / 50; i++) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error('condition not reached in time');
}

describe('streaming process layer (v0.2.2)', () => {
  test('exact raw bytes are spooled; UTF-8 split across chunks is never corrupted; unterminated lines stay bounded', async () => {
    const out = path.join(t.root, 'raw.out');
    const script = `const b=Buffer.from('审议通过\\nline2\\n');process.stdout.write(b.subarray(0,4));setTimeout(()=>{process.stdout.write(b.subarray(4));process.stdout.write('x'.repeat(250))},80)`;
    const lines = []; const chunks = [];
    const r = await runProc([process.execPath, '-e', script], { stdoutPath: out, maxLine: 100, onLine: (l, m) => lines.push([l, m.partial]), onChunk: (c) => chunks.push(c) });
    assert.equal(r.code, 0);
    assert.equal(fs.readFileSync(out, 'utf8'), `审议通过\nline2\n${'x'.repeat(250)}`, 'raw file is byte-exact');
    assert.deepEqual(lines.slice(0, 2), [['审议通过', false], ['line2', false]]);
    assert.ok(lines.slice(2).every(([l]) => l.length <= 100), 'no line fragment exceeds the bound');
    assert.equal(lines.slice(2).map(([l]) => l).join(''), 'x'.repeat(250));
    assert.ok(chunks.join('').includes('审议通过'));
    assert.equal(r.stdoutBytes, Buffer.byteLength(`审议通过\nline2\n${'x'.repeat(250)}`));
  });

  test('output is on disk while the process is still running', async () => {
    const out = path.join(t.root, 'live.out');
    const p = runProc([process.execPath, '-e', "process.stdout.write('first\\n');setTimeout(()=>process.stdout.write('second\\n'),900)"], { stdoutPath: out });
    await until(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('first'), 3000);
    assert.equal(fs.readFileSync(out, 'utf8'), 'first\n', 'second chunk does not exist yet: the log was read before completion');
    assert.equal((await p).code, 0);
  });

  test('heartbeats are informational; a live deadline() can be raised and 0 means no limit', async () => {
    let limit = 500; const beats = [];
    setTimeout(() => { limit = 0; }, 300); // "extend": removed before the 500 ms mark
    const r = await runProc([process.execPath, '-e', 'setTimeout(()=>{},1400)'], { deadline: () => limit, heartbeatMs: 250, onHeartbeat: (h) => beats.push(h) });
    assert.equal(r.timedOut, false);
    assert.equal(r.code, 0);
    assert.ok(beats.length >= 3 && beats.every((b) => b.outputYet === false), `no-output heartbeats: ${beats.length}`);
    const cut = await runProc([process.execPath, '-e', 'setInterval(()=>{},1000)'], { deadline: () => 400 });
    assert.equal(cut.timedOut, true);
  });

  test('stream normalisers: Codex JSONL and Grok events; thoughts and unknown shapes never leak', () => {
    const c = new Normalizer('codex');
    const evs = ['{"type":"thread.started","thread_id":"x"}', '{"type":"turn.started"}', '{"type":"item.started","item":{"type":"reasoning","text":"PRIVATE"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}', '{"type":"turn.completed","usage":{"input_tokens":5}}', 'not json', '{"type":"error","message":"bad"}']
      .map((l) => c.push(l));
    assert.deepEqual(evs.map((e) => e.event.type), ['session.started', 'turn.started', 'item.started', 'message', 'turn.completed', 'non_json', 'error']);
    assert.ok(!JSON.stringify(evs).includes('PRIVATE'));
    assert.deepEqual(evs[4].event.usage, { input_tokens: 5 }, 'usage only as reported');
    const g = new Normalizer('grok');
    for (const l of ['{"type":"thought","data":"SECRET"}', '{"type":"text","data":"ab"}', '{"type":"text","data":"cd"}', '{"type":"tool_call","title":"T","kind":"k","status":"s"}', '{"type":"x.ai/lifecycle"}']) g.push(l);
    assert.equal(grokStreamResult(g).error.includes('terminal end'), true, 'no end event → rejected');
    g.push('{"type":"end","sessionId":"s"}');
    assert.deepEqual(grokStreamResult(g), { text: 'abcd' });
    assert.equal(g.counts.thought, 1);
    g.push('{"type":"error","message":"boom"}');
    assert.match(grokStreamResult(g).error, /boom/);
    assert.deepEqual(formatsFromHelp('--output-format <F>\n  Output [default: plain] [possible values: plain, json, streaming-json]'), ['plain', 'json', 'streaming-json']);
    assert.equal(formatsFromHelp('nothing here'), null);
  });
});

describe('Codex/Grok streaming steps (v0.2.2)', () => {
  const stepOf = (id, sid) => runJson(id).steps.find((s) => s.id === sid);

  test('Codex runs with --json (events + progress on stderr) while -o stays authoritative and stdout stays one JSON document', () => {
    const id = start().json.run;
    const a = cli('advance', id);
    assert.equal(a.json.action, 'implement', a.out);
    assert.notEqual(a.json, null, 'stdout is only the final next-action JSON');
    const c = calls().find((x) => x.provider === 'codex');
    assert.ok(c.argv.includes('--json'));
    assert.ok(c.argv.includes('-o'));
    assert.match(a.err, /\[concord \S+ proposal\] ▶ 中书省 · Codex 大脑 · codex — limit 1800s/);
    assert.match(a.err, /answer message received/);
    assert.match(a.err, /turn completed/);
    const ev = eventsOf(id, 'proposal.a1.events.jsonl');
    assert.deepEqual(ev.map((e) => e.type), ['session.started', 'turn.started', 'item.started', 'message', 'turn.completed']);
    const st = stepOf(id, 'proposal');
    assert.ok(st.pid > 0 && st.process_ms >= 0 && st.bytes.stdout > 0 && st.last_output_at);
    assert.equal(st.event_counts.message, 1);
    assert.equal(st.no_output, false);
    assert.equal(st.logs.events, 'logs/proposal.a1.events.jsonl');
  });

  test('a missing -o file fails the Codex step even when the stream completed', () => {
    scenario({ proposal: [{ $mode: 'no_last' }] });
    const id = start().json.run;
    const a = cli('advance', id);
    assert.equal(a.json.action, 'failed');
    assert.match(a.json.failure.error, /malformed proposal output: no final message file/);
    assert.equal(a.json.failure.kind, 'malformed');
  });

  test('Grok uses streaming-json with tools empty/plan/no-subagents, parses fragmented text events, hides thoughts', () => {
    scenario({ review: [{ verdict: 'approve', summary: '审议通过：看起来正确', concerns: [], required_changes: [], $split_bytes: true, $delay_ms: 20 }] });
    const id = start().json.run;
    const a = cli('advance', id);
    assert.equal(a.json.action, 'implement', a.out + a.err);
    const g = calls().find((x) => x.provider === 'grok').argv;
    assert.equal(g[g.indexOf('--output-format') + 1], 'streaming-json');
    assert.equal(g[g.indexOf('--tools') + 1], '');
    assert.equal(g[g.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(g.includes('--no-subagents') && g.includes('--disable-web-search'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDirOf(id), 'artifacts/review.json'), 'utf8')).summary, '审议通过：看起来正确', 'UTF-8 split mid-character survived');
    assert.ok(!a.err.includes('SECRET-INTERNAL-THOUGHT'), 'thought content is not rendered as progress');
    assert.match(a.err, /answer text streaming/);
    const ev = eventsOf(id, 'review.a1.events.jsonl');
    assert.ok(ev.some((e) => e.type === 'thought' && e.hidden) && !JSON.stringify(ev).includes('SECRET-INTERNAL-THOUGHT'));
    assert.deepEqual(ev.filter((e) => e.type === 'usage')[0].usage, { input_tokens: 3, output_tokens: 4 });
    assert.ok(fs.readFileSync(path.join(runDirOf(id), 'logs/review.a1.stdout.log'), 'utf8').includes('SECRET-INTERNAL-THOUGHT'), 'raw log keeps everything');
    assert.equal(stepOf(id, 'review').output_format, 'streaming-json');
    // Capability probe is cached; the --help call is not an inference call.
    assert.deepEqual(calls().map((c) => c.provider + ':' + c.role), ['codex:proposal', 'grok:review', 'codex:plan']);
    assert.ok(fs.existsSync(path.join(t.root, 'cache/grok-capabilities.json')));
  });

  for (const [mode, re, cls] of [['error', /grok stream failure/, 'stream'], ['no_end', /without a terminal end event/, 'stream'], ['malformed_final', /malformed review output/, 'malformed']]) {
    test(`Grok stream ${mode} is rejected as a transport/format failure, not a verdict`, () => {
      scenario({ review: [{ $mode: mode }] });
      const id = start().json.run;
      const a = cli('advance', id);
      assert.equal(a.json.action, 'failed', a.out);
      assert.match(a.json.failure.error, re);
      assert.equal(a.json.failure.kind, cls);
      assert.equal(a.json.failure.rejected_by_review, undefined);
      assert.equal(runJson(id).tasks.length, 0);
    });
  }

  test('older Grok without streaming-json falls back to --output-format json; whole-JSON from a streaming run is accepted as legacy', () => {
    t.env.FAKE_GROK_FORMATS = 'plain, json';
    const id = start().json.run;
    assert.equal(cli('advance', id).json.action, 'implement');
    const g = calls().find((x) => x.provider === 'grok').argv;
    assert.equal(g[g.indexOf('--output-format') + 1], 'json');
    assert.equal(stepOf(id, 'review').output_format, 'json');
    delete t.env.FAKE_GROK_FORMATS;
    fs.rmSync(path.join(t.root, 'cache'), { recursive: true, force: true });
    cli('cancel', id);
    scenario({ review: [{ verdict: 'approve', summary: 'legacy ok', concerns: [], required_changes: [], $mode: 'legacy' }] });
    const id2 = start().json.run;
    const b = cli('advance', id2);
    assert.equal(b.json.action, 'implement', b.out + b.err);
    assert.equal(stepOf(id2, 'review').legacy_whole_json, true);
  });

  test('Grok and Codex process failures stay distinct from a reject verdict', () => {
    scenario({ review: [{ $exit: 3 }] });
    const id = start().json.run;
    const a = cli('advance', id);
    assert.equal(a.json.failure.kind, 'exit');
    assert.equal(a.json.failure.rejected_by_review, undefined);
    assert.equal(runJson(id).models.review.model, 'account_default', 'model never silently changed');
  });
});

describe('waiting, logs and live control (v0.2.2)', () => {
  test('logs and status --light work while the helper is running; early reads precede completion; no duplicate advance', async () => {
    scenario({ review: [{ verdict: 'approve', summary: 'ok', concerns: [], required_changes: [], $hold_ms: 2500 }] });
    const id = start().json.run;
    const h = bg(['advance', id, '--one-step']);
    await h.done; // proposal
    const h2 = bg(['advance', id, '--one-step']); // review, held
    await until(() => (cli('logs', id, '--step', 'review', '--stream', 'events', '--json').json?.text ?? '').includes('turn') || (cli('logs', id, '--step', 'review', '--stream', 'stdout', '--json').json?.bytes > 0));
    const live = cli('logs', id, '--step', 'review', '--stream', 'stdout', '--json');
    assert.equal(live.json.running, true, 'step is still running while its log is being read');
    assert.equal(h2.child.exitCode, null, 'helper has not finished');
    assert.match(live.json.text, /SECRET-INTERNAL-THOUGHT|x\.ai\/session/);
    const dup = cli('advance', id);
    assert.equal(dup.json.error, 'locked');
    assert.match(dup.json.message, /do not start a duplicate/);
    const light = cli('status', id, '--json', '--light').json;
    assert.equal(light.working_state, null);
    assert.equal(light.working_state_check, 'not checked (--light)');
    assert.equal(light.running[0].step, 'review');
    assert.ok(light.running[0].pid > 0 && light.running[0].limit_s === 1800);
    assert.ok(light.helper_running > 0);
    // incremental reading with the byte cursor
    const first = cli('logs', id, '--step', 'review', '--stream', 'stdout', '--offset', '0', '--limit', '40', '--json').json;
    assert.equal(first.offset, 0);
    const second = cli('logs', id, '--step', 'review', '--stream', 'stdout', '--offset', String(first.next_offset), '--json').json;
    assert.equal(second.offset, first.next_offset);
    await h2.done;
    const all = fs.readFileSync(path.join(runDirOf(id), 'logs/review.a1.stdout.log'), 'utf8');
    assert.equal(first.text + second.text, all.slice(0, (first.text + second.text).length), 'cursor reads concatenate to the file');
    assert.match(h2.err, /still running|✓ passed/);
  });

  test('soft notice (heartbeat) with no output never kills or retries a long review', async () => {
    t.env.CONCORD_HEARTBEAT_MS = '250';
    scenario({ review: [{ verdict: 'approve', summary: 'late but fine', concerns: [], required_changes: [], $silent_ms: 1400 }] });
    const id = start({ limits: { review_timeout_s: 60 } }).json.run;
    const h = bg(['advance', id], t.repo, t.env);
    assert.equal(await h.done, 0);
    assert.match(h.err, /no output from grok yet \(process \d+ alive — waiting is normal; this notice does not stop it\)/);
    assert.match(h.err, /limit 60s/);
    assert.equal(calls().filter((c) => c.provider === 'grok').length, 1, 'not retried');
    const st = runJson(id).steps.find((s) => s.id === 'review');
    assert.equal(st.status, 'passed');
    assert.ok(st.first_output_ms >= 1300, 'first output arrived after the soft notices');
    assert.ok(recentTl(id).some((e) => e.type === 'heartbeat' && e.no_output === true));
  });
  const recentTl = (id) => fs.readFileSync(path.join(runDirOf(id), 'timeline.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  test('review_timeout_s: default 1800, 0 = manual, per-role override, legacy cli_timeout_s, validation', () => {
    const d = start().json;
    assert.equal(d.limits.review_timeout_s, 1800);
    assert.equal(d.next_stage.limit_s, 1800);
    assert.equal(d.next_stage.background.run_in_background, true);
    assert.equal(d.next_stage.background.timeout_ms, 1920000);
    assert.match(d.next_stage.background.description, /^Concord proposal · codex · \d{8}-\d{6}-[a-f0-9]{6}$/);
    cli('cancel', d.run);
    const m = start({ limits: { review_timeout_s: 0, role_timeout_s: { review: 90 } } }).json;
    assert.equal(m.next_stage.limit_s, 0);
    assert.equal(m.next_stage.background.timeout_ms, 7200000, 'manual wait uses the 2 h Claude Code cap');
    assert.deepEqual(runJson(m.run).limits.role_timeout_s, { review: 90 });
    cli('cancel', m.run);
    assert.equal(runJson(start({ limits: { cli_timeout_s: 100 } }).json.run).limits.review_timeout_s, 100, 'explicit legacy cli_timeout_s is honoured');
    assert.equal(start({ limits: { review_timeout_s: -1 } }).json.error, 'spec');
    assert.equal(start({ limits: { role_timeout_s: { deploy: 5 } } }).json.error, 'spec');
  });

  test('helper timeout is a distinct failure that kills the process group; retry reruns the same model', async () => {
    scenario({ review: [{ $hang: true }] });
    t.env.FAKE_GRANDCHILD = path.join(t.root, 'gc.pid');
    const id = start({ limits: { review_timeout_s: 1 } }).json.run;
    const a = cli('advance', id);
    assert.equal(a.json.action, 'failed', a.out);
    assert.equal(a.json.failure.kind, 'timeout');
    assert.match(a.json.failure.error, /CLI timeout: grok gave no final result within 1s; process group killed\. This is a helper timeout, not a review verdict/);
    assert.equal(a.json.failure.rejected_by_review, undefined);
    await sleep(150);
    assert.throws(() => process.kill(Number(fs.readFileSync(t.env.FAKE_GRANDCHILD, 'utf8')), 0), /ESRCH/);
    const retry = cli('advance', id, '--retry');
    assert.equal(retry.json.action, 'implement', retry.out);
    assert.equal(runJson(id).models.review.model, 'account_default');
  });

  test('extend raises the limit of a RUNNING step; too-short values are refused', async () => {
    scenario({ review: [{ verdict: 'approve', summary: 'ok', concerns: [], required_changes: [], $silent_ms: 3600 }] });
    const id = start({ limits: { review_timeout_s: 2 } }).json.run;
    cli('advance', id, '--one-step');
    const h = bg(['advance', id, '--one-step']);
    await until(() => runJson(id).steps.find((s) => s.id === 'review' && s.pid));
    await sleep(1300);
    const bad = cli('extend', id, '--review-timeout', '1');
    assert.equal(bad.json.error, 'usage');
    const ok = cli('extend', id, '--review-timeout', '30');
    assert.equal(ok.json.review_timeout_s, 30, ok.out);
    assert.ok(ok.json.live_helper > 0);
    assert.equal(await h.done, 0, h.err);
    const st = runJson(id).steps.find((s) => s.id === 'review');
    assert.equal(st.status, 'passed', 'survived past the original 2 s limit');
    assert.equal(st.timeout_s, 30);
    assert.equal(st.timeout_changes.length, 1);
    assert.match(h.err, /limit changed: limit 2s → limit 30s/);
  });

  test('--one-step runs exactly one labelled stage; default advance runs through to the session step', () => {
    const id = start().json.run;
    const a = cli('advance', id, '--one-step');
    assert.equal(a.json.action, 'continue');
    assert.equal(a.json.next_stage.step, 'review');
    assert.equal(calls().length, 1);
    assert.equal(a.json.timing.stages_run, 1);
    assert.ok(a.json.next.includes('--one-step'));
    const b = cli('advance', id);
    assert.equal(b.json.action, 'implement');
  });

  test('manual cancel mid-stage kills the stage process group and records cancellation', async () => {
    scenario({ review: [{ $hang: true }] });
    t.env.FAKE_GRANDCHILD = path.join(t.root, 'gc2.pid');
    const id = start({ limits: { review_timeout_s: 0 } }).json.run;
    cli('advance', id, '--one-step');
    const h = bg(['advance', id, '--one-step']);
    await until(() => fs.existsSync(t.env.FAKE_GRANDCHILD));
    const gpid = Number(fs.readFileSync(t.env.FAKE_GRANDCHILD, 'utf8'));
    assert.equal(cli('cancel', id).json.status, 'cancelled');
    await h.done; await sleep(150);
    assert.throws(() => process.kill(gpid, 0), /ESRCH/);
    assert.equal(runJson(id).steps.find((s) => s.id === 'review').status, 'cancelled');
  });

  test('logs are bounded, validated, and refuse traversal and symlink escapes', () => {
    const id = start().json.run;
    cli('advance', id);
    assert.equal(cli('logs', id, '--step', '../run').json.error, 'usage');
    assert.equal(cli('logs', id, '--step', 'review', '--stream', 'secret').json.error, 'usage');
    assert.equal(cli('logs', id, '--step', 'review', '--limit', '0').json.error, 'usage');
    assert.equal(cli('logs', id, '--step', 'review', '--limit', '70000').json.error, 'usage');
    assert.equal(cli('logs', id, '--step', 'review', '--offset', '-1').json.error, 'usage');
    assert.equal(cli('logs', id, '--step', 'nope').json.error, 'not_found');
    const def = cli('logs', id, '--json');
    assert.equal(def.json.step, 'plan', 'default: latest step with logs');
    assert.ok(def.json.bytes <= 8192);
    // symlink escape
    const secret = path.join(t.root, 'outside.txt'); fs.writeFileSync(secret, 'TOP-SECRET');
    const log = path.join(runDirOf(id), 'logs/review.a1.stdout.log');
    fs.rmSync(log); fs.symlinkSync(secret, log);
    const sym = cli('logs', id, '--step', 'review');
    assert.equal(sym.json.error, 'usage');
    assert.ok(!sym.out.includes('TOP-SECRET'));
    // tampered run.json path
    saveRun(id, (r) => { r.steps.find((s) => s.id === 'plan').logs.stdout = '../../../../outside.txt'; });
    const esc = cli('logs', id, '--step', 'plan');
    assert.equal(esc.json.error, 'usage');
    assert.throws(() => readLogRange(runDirOf(id), '/etc/passwd', { limit: 10 }), /unsafe/);
    // limit in a direct read is capped
    fs.writeFileSync(path.join(runDirOf(id), 'logs/big.log'), 'a'.repeat(200000));
    assert.equal(readLogRange(runDirOf(id), 'logs/big.log', { limit: 10 ** 9 }).bytes, 65536);
  });

  test('status carries stage timing, scans, timeline and per-step process facts', () => {
    const id = start().json.run;
    cli('advance', id); edit();
    const done = cli('advance', id, '--done', 'task-T1');
    assert.ok(done.json.timing.scans.fingerprint.count >= 2, JSON.stringify(done.json.timing));
    const s = cli('status', id, '--json').json;
    assert.equal(s.stage_stats.qa.attempts, 1);
    assert.equal(s.stage_stats.test.passed, 1);
    assert.ok(s.scans.fingerprint.count >= 2);
    assert.ok(s.timeline.some((e) => e.type === 'stage.end' && e.step === 'qa-1'));
    assert.equal(s.working_state_check, 'checked');
    assert.equal(s.validation.current, true);
    assert.match(cli('status', id).out, /stage time: .*qa 1×/);
  });
});

describe('worktree binding (v0.2.2)', () => {
  function twoWorktrees() {
    const id = start().json.run;
    const wt = path.join(t.root, 'wtB');
    sh(t.repo, 'worktree', 'add', '-q', wt, '-b', 'side');
    return { id, wt };
  }

  test('every mutating command from another worktree fails wrong_worktree before any write, signal or model call', () => {
    const { id, wt } = twoWorktrees();
    const runFile = path.join(runDirOf(id), 'run.json');
    const before = fs.readFileSync(runFile);
    fs.writeFileSync(path.join(wt, 'b-only.txt'), 'B work');
    const specFile = writeSpec({ kind: 'clarify', text: 'x' });
    for (const args of [['advance', id], ['advance', id, '--retry'], ['resume', id], ['cancel', id], ['approve', id, '--decision', 'reject'],
      ['amend', id, '--spec', specFile], ['extend', id, '--review-timeout', '10'], ['advance', 'latest']]) {
      const r = cliIn(wt, ...args);
      assert.equal(r.json?.error, 'wrong_worktree', `${args[0]}: ${r.out}`);
      assert.equal(r.code, 2);
      assert.match(r.json.message, new RegExp(`--repo ${t.repo.replace(/[/.]/g, '\\$&')}`));
      assert.equal(r.json.run_repo, t.repo);
    }
    assert.ok(before.equals(fs.readFileSync(runFile)), 'run.json byte-identical');
    assert.deepEqual(calls(), [], 'no model call');
    assert.equal(fs.existsSync(path.join(t.repo, '.git/concord/lock')), false, 'no lock taken');
    assert.equal(fs.readFileSync(path.join(wt, 'b-only.txt'), 'utf8'), 'B work');
    assert.equal(fs.readFileSync(path.join(t.repo, 'app.txt'), 'utf8'), 'todo\n');
    // the owner worktree still drives it, and next-action commands point at it
    const a = cli('advance', id);
    assert.equal(a.json.action, 'implement');
    assert.equal(a.json.done.at(-1), t.repo);
  });

  test('cancel from B never signals A\'s live helper', async () => {
    scenario({ proposal: [{ $hang: true }] });
    t.env.FAKE_GRANDCHILD = path.join(t.root, 'gc3.pid');
    const { id, wt } = twoWorktrees();
    const h = bg(['advance', id]);
    await until(() => fs.existsSync(t.env.FAKE_GRANDCHILD));
    const r = cliIn(wt, 'cancel', id);
    assert.equal(r.json.error, 'wrong_worktree');
    await sleep(300);
    assert.equal(h.child.exitCode, null, 'A\'s helper is untouched');
    assert.equal(cli('cancel', id).json.status, 'cancelled');
    await h.done;
  });

  test('read-only status/show/list/logs work from B but never validate B\'s files as the run', () => {
    const { id, wt } = twoWorktrees();
    cli('advance', id); edit();
    assert.equal(cli('advance', id, '--done', 'task-T1').json.status, 'validated');
    fs.writeFileSync(path.join(wt, 'app.txt'), 'something else\n');
    const s = cliIn(wt, 'status', id, '--json');
    assert.equal(s.json.worktree.foreign, true);
    assert.equal(s.json.working_state, null);
    assert.equal(s.json.validation.current, null, 'not falsely "invalid"');
    assert.match(s.json.validation.verification, /unavailable: run belongs to/);
    assert.match(cliIn(wt, 'status', id).out, /FOREIGN worktree/);
    assert.match(cliIn(wt, 'list').out, /\[worktree /);
    assert.match(cliIn(wt, 'show', id, 'plan').out, /tasks/);
    assert.equal(cliIn(wt, 'logs', id, '--step', 'qa-1', '--json').json.step, 'qa-1');
    assert.equal(cli('status', id, '--json').json.validation.current, true, 'A is still validated');
    assert.equal(cliIn(wt, 'approve', id, '--decision', 'approve').json.error, 'wrong_worktree');
    assert.equal(cli('approve', id, '--decision', 'approve').json.status, 'approved');
  });
});

describe('explicit check cwd (v0.2.2)', () => {
  const pkgDir = () => { fs.mkdirSync(path.join(t.repo, 'packages/api'), { recursive: true }); fs.writeFileSync(path.join(t.repo, 'packages/api/package.json'), JSON.stringify({ name: 'api', scripts: { typecheck: 'tsc --noEmit' } })); };
  const spec = (obj) => { const f = path.join(t.root, `s-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify({ request: 'Make app.txt say done', ...obj })); return f; };
  const WHERE = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify('PLACEHOLDER')},process.cwd()+'\\n')`];

  test('explicit and autodetected checks started in a subpackage share the intended cwd; the command really runs there', () => {
    pkgDir();
    const sub = path.join(t.repo, 'packages/api');
    const marker = path.join(t.root, 'where.txt');
    const cmd = [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)},process.cwd()+'\\n')`];
    const auto = cliIn(sub, 'start', '--spec', spec({}));
    assert.equal(auto.json.checks.cwd, 'packages/api');
    cli('cancel', auto.json.run);
    const exp = cliIn(sub, 'start', '--spec', spec({ tests: [cmd] }));
    assert.equal(exp.code, 0, exp.out);
    assert.equal(exp.json.checks.cwd, 'packages/api');
    assert.equal(exp.json.checks.cwd_source, 'invocation directory');
    const id = exp.json.run;
    cli('advance', id); edit();
    assert.equal(cli('advance', id, '--done', 'task-T1').json.status, 'validated');
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), fs.realpathSync(sub), 'process.cwd() of the check');
    const test1 = runJson(id).steps.find((s) => s.id === 'test-1');
    assert.equal(test1.cwd, 'packages/api');
    assert.equal(test1.commands[0].cwd, 'packages/api');
    assert.match(cli('status', id).out, /cwd packages\/api \(invocation directory\)/);
    assert.equal(cli('status', id, '--json').json.validation.check_cwd, 'packages/api');
  });

  test('tests_cwd selects a safe repo-relative dir (root commands from root docs); unsafe values are refused', () => {
    pkgDir();
    const sub = path.join(t.repo, 'packages/api');
    const marker = path.join(t.root, 'where2.txt');
    const cmd = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},process.cwd())`];
    const r = cliIn(sub, 'start', '--spec', spec({ tests: [cmd], tests_cwd: '.' }));
    assert.equal(r.code, 0, r.out);
    assert.equal(r.json.checks.cwd, '.');
    assert.equal(r.json.checks.cwd_source, 'spec.tests_cwd');
    cli('advance', r.json.run); edit();
    cli('advance', r.json.run, '--done', 'task-T1');
    assert.equal(fs.readFileSync(marker, 'utf8'), t.repo);
    cli('cancel', r.json.run);
    for (const bad of ['../outside', '/etc', 'nope/missing', 'packages/api/../../..', '']) {
      assert.equal(cliIn(sub, 'start', '--spec', spec({ tests: [cmd], tests_cwd: bad })).json.error, 'spec', bad);
    }
    fs.symlinkSync(os.tmpdir(), path.join(t.repo, 'escape'));
    assert.equal(cliIn(sub, 'start', '--spec', spec({ tests: [cmd], tests_cwd: 'escape' })).json.error, 'spec', 'symlink escape');
    assert.equal(cliIn(sub, 'start', '--spec', spec({ tests_cwd: '.' })).json.error, 'spec', 'tests_cwd without explicit tests');
    assert.equal(cliIn(sub, 'start', '--spec', spec({ tests: [cmd], tests_cwd: 'packages' })).json.checks.cwd, 'packages');
  });

  test('saved runs without cwd metadata keep the documented repository-root fallback and say so', () => {
    pkgDir();
    const id = cliIn(path.join(t.repo, 'packages/api'), 'start', '--spec', spec({ tests: [TEST_OK] })).json.run;
    saveRun(id, (r) => { delete r.test_selection.cwd; delete r.test_selection.cwd_source; });
    cli('advance', id); edit();
    assert.equal(cli('advance', id, '--done', 'task-T1').json.status, 'validated');
    const step = runJson(id).steps.find((s) => s.id === 'test-1');
    assert.equal(step.cwd, '.');
    assert.match(step.cwd_source, /repository root fallback/);
    assert.match(cli('status', id, '--json').json.checks.cwd_source, /repository root fallback/);
  });
});

describe('mid-run amendments (v0.2.2)', () => {
  const stage = (id) => { cli('advance', id); return id; };

  test('clarify: persisted, in every later prompt and worker action; stale results rejected; edits and plan kept', () => {
    const id = start().json.run;
    stage(id); edit();
    const refusal = amend(id, { kind: 'clarify', text: 'also keep the trailing newline' });
    assert.equal(refusal.json.error, 'writer_may_be_active', 'implement step pending: the native writer may still be running');
    assert.equal(runJson(id).revision, 1);
    const ok = amend(id, { kind: 'clarify', text: 'also keep the trailing newline' }, '--writer-stopped');
    assert.equal(ok.code, 0, ok.out);
    assert.equal(ok.json.amended.revision, 2);
    assert.equal(ok.json.action, 'implement', 'plan and tasks kept');
    assert.match(ok.json.request, /User amendments after the run started[\s\S]*2\. \[clarify\] also keep the trailing newline/);
    assert.equal(ok.json.revision, 2);
    assert.equal(ok.json.baseline_untouched, true);
    assert.equal(fs.readFileSync(path.join(t.repo, 'app.txt'), 'utf8'), 'done\n', 'edits not reverted');
    assert.equal(runJson(id).baseline.fingerprint, runJson(id).baseline.fingerprint);
    // stale and missing revisions
    const stale = cli('advance', id, '--done', 'task-T1', '--revision', '1');
    assert.equal(stale.json.error, 'stale_revision');
    assert.equal(cli('advance', id, '--done', 'task-T1').json.error, 'revision_required');
    assert.equal(runJson(id).steps.some((s) => s.id === 'task-T1'), false, 'nothing recorded for the stale result');
    assert.equal(cli('advance', id, '--done', 'task-T9', '--revision', '2').json.error, 'usage');
    const fin = cli('advance', id, '--done', 'task-T1', '--executor', 'subagent', '--revision', '2');
    assert.equal(fin.json.status, 'validated', fin.out);
    assert.match(promptOf(id, 'qa-1.a1.txt'), /<request>[\s\S]*2\. \[clarify\] also keep the trailing newline[\s\S]*<\/request>/);
    assert.equal(runJson(id).steps.find((s) => s.id === 'task-T1').revision, 2);
  });

  test('amending a validated run invalidates validation and re-tests/re-QAs against the clarified request', () => {
    const id = start().json.run;
    stage(id); edit();
    assert.equal(cli('advance', id, '--done', 'task-T1').json.status, 'validated');
    const a = amend(id, { kind: 'clarify', text: 'doc the change in the commit-free notes' });
    assert.equal(a.code, 0, a.out);
    assert.ok(a.json.effects.includes('previous validation invalidated'));
    const r = runJson(id);
    assert.equal(r.validation, null);
    assert.equal(r.invalidated.at(-1).reason, 'amended to revision 2');
    assert.equal(cli('approve', id, '--decision', 'approve').json.error, 'not_validated');
    const re = cli('advance', id);
    assert.equal(re.json.status, 'validated', re.out);
    assert.ok(runJson(id).steps.some((s) => s.id === 'qa-2'));
    assert.match(promptOf(id, 'qa-2.a1.txt'), /doc the change/);
    assert.equal(cli('approve', id, '--decision', 'approve').json.status, 'approved');
    assert.equal(amend(id, { kind: 'clarify', text: 'too late' }).json.error, 'not_open');
  });

  test('scope: structural change re-plans, lists completed tasks to the planner, keeps edits and baseline', () => {
    fs.writeFileSync(path.join(t.repo, 'mine.txt'), 'preexisting work');
    const id = start().json.run;
    stage(id); edit();
    const first = cli('advance', id, '--done', 'task-T1');
    assert.equal(first.json.status, 'validated');
    const T2 = { summary: 'two', tasks: [{ id: 'N1', title: 'Add extra.txt', description: 'create extra.txt', files: ['extra.txt'], depends_on: [], difficulty: 'low', risk: 'low' }] };
    scenario({ plan: [T2] });
    const a = amend(id, { kind: 'scope', text: 'also create extra.txt' });
    assert.equal(a.code, 0, a.out);
    assert.ok(a.json.effects.some((e) => /re-plan/.test(e)));
    assert.equal(a.json.phase, 'review', 'full policy: Grok reviews the revised scope before the re-plan');
    const baselineBefore = runJson(id).baseline;
    const n = cli('advance', id);
    assert.equal(n.json.action, 'implement', n.out);
    assert.equal(n.json.task.id, 'N1');
    const planPrompt = promptOf(id, 'plan.a2.txt');
    assert.match(planPrompt, /<already_completed_tasks>[\s\S]*"T1"/);
    assert.match(planPrompt, /also create extra\.txt/);
    assert.equal(fs.readFileSync(path.join(t.repo, 'app.txt'), 'utf8'), 'done\n', 'completed work kept');
    assert.deepEqual(runJson(id).baseline, baselineBefore);
    assert.equal(runJson(id).task_history[0].tasks[0].id, 'T1');
    fs.writeFileSync(path.join(t.repo, 'extra.txt'), 'x');
    const fin = cli('advance', id, '--done', 'task-N1', '--revision', '2');
    assert.equal(fin.json.status, 'validated', fin.out);
    assert.equal(fs.readFileSync(path.join(t.repo, 'mine.txt'), 'utf8'), 'preexisting work');
  });

  test('amend is refused while a helper is running (it would act on the old request); validated input only', async () => {
    scenario({ proposal: [{ $hang: true }] });
    t.env.FAKE_GRANDCHILD = path.join(t.root, 'gc4.pid');
    const id = start().json.run;
    const h = bg(['advance', id]);
    await until(() => fs.existsSync(t.env.FAKE_GRANDCHILD));
    const r = amend(id, { kind: 'clarify', text: 'x' });
    assert.equal(r.json.error, 'helper_busy');
    assert.equal(runJson(id).revision, 1);
    cli('cancel', id); await h.done;
    for (const bad of [{ kind: 'other', text: 'x' }, { kind: 'scope' }, { kind: 'scope', text: '' }, { kind: 'scope', text: 'a', extra: 1 }, { kind: 'scope', text: 'a'.repeat(9000) }]) {
      assert.equal(amend(id, bad).json.error, 'spec');
    }
  });

  test('before planning, an amendment flows into the plan prompt; legacy revision-less runs still accept --done', () => {
    const id = start().json.run;
    cli('advance', id, '--one-step'); // proposal only
    assert.equal(amend(id, { kind: 'clarify', text: 'use the LEGACYWORD' }).code, 0);
    cli('advance', id);
    assert.match(promptOf(id, 'review.a1.txt'), /LEGACYWORD/);
    assert.match(promptOf(id, 'plan.a1.txt'), /LEGACYWORD/);
    // legacy: no revision/amendments keys, --done without --revision and with --revision 1 both fine
    const id2 = (() => { cli('cancel', id); return start().json.run; })();
    saveRun(id2, (r) => { delete r.revision; delete r.amendments; });
    cli('advance', id2); edit();
    assert.equal(cli('advance', id2, '--done', 'task-T1', '--revision', '1').json.status, 'validated');
  });
});

describe('check coverage and repair routing (v0.2.2)', () => {
  const scaffold = () => {
    for (const d of ['packages/api', 'packages/web']) { fs.mkdirSync(path.join(t.repo, d), { recursive: true }); fs.writeFileSync(path.join(t.repo, d, 'package.json'), JSON.stringify({ name: d, scripts: { typecheck: 'tsc --noEmit' } })); }
    fs.writeFileSync(path.join(t.repo, 'package.json'), JSON.stringify({ name: 'root' }));
    sh(t.repo, 'add', '.'); sh(t.repo, 'commit', '-qm', 'pkgs');
  };
  const planOf = (files, risk = 'low', difficulty = 'low') => ({ plan: [{ summary: 'p', tasks: [{ id: 'T1', title: 'work', description: 'do it', files, depends_on: [], difficulty, risk }] }] });

  test('planned files outside the check cwd produce a persisted warning shown before implementation and in the final summary', () => {
    scaffold();
    scenario(planOf(['packages/web/src/x.ts', 'README.md']));
    const sub = path.join(t.repo, 'packages/api');
    const id = cliIn(sub, 'start', '--spec', (() => { const f = path.join(t.root, 'cov.json'); fs.writeFileSync(f, JSON.stringify({ request: 'Make app.txt say done' })); return f; })()).json.run;
    const a = cliIn(sub, 'advance', id);
    assert.equal(a.json.action, 'implement', a.out);
    assert.equal(a.json.check_coverage.status, 'warning');
    assert.equal(a.json.check_coverage.warnings[0].reason, 'outside_check_cwd');
    assert.deepEqual(a.json.check_coverage.warnings[0].files, ['packages/web/src/x.ts'], 'docs are not counted');
    assert.match(a.err, /⚠ check coverage: 1 planned\/changed file\(s\) lie outside the directory the check runs in \(packages\/api\)/);
    assert.match(a.json.coverage_note, /Do not add checks or ask new questions/);
    assert.equal(calls().length, 3, 'no extra model call or gate');
    fs.mkdirSync(path.join(t.repo, 'packages/web/src'), { recursive: true });
    fs.writeFileSync(path.join(t.repo, 'packages/web/src/x.ts'), 'export {}\n');
    const fin = cliIn(sub, 'advance', id, '--done', 'task-T1');
    assert.equal(fin.json.status, 'validated', fin.out);
    assert.match(fin.json.message, /CHECK COVERAGE WARNING.*packages\/web\/src\/x\.ts/);
    assert.equal(runJson(id).validation.check_coverage.status, 'warning');
    assert.match(cli('status', id).out, /⚠ check coverage/);
  });

  test('coverage never claims more than package metadata shows', () => {
    scaffold();
    const sel = (cwd, mode = 'auto') => ({ mode, cwd, kind: 'test' });
    const inside = checkCoverage(t.repo, ['packages/api/a.ts'], sel('packages/api'));
    assert.equal(inside.status, 'ok');
    assert.match(inside.basis, /not that the files are tested|script contents are not analysed/);
    const nested = checkCoverage(t.repo, ['packages/web/w.ts', 'top.js'], sel(''));
    assert.deepEqual(nested.warnings.map((w) => w.reason), ['nested_package_unknown'], 'root script may or may not reach a nested package');
    assert.equal(checkCoverage(t.repo, ['packages/web/w.ts'], sel('', 'explicit')).status, 'ok', 'explicit root command is the user\'s call');
    assert.equal(checkCoverage(t.repo, ['packages/web/w.ts'], sel('packages/api', 'explicit')).warnings[0].reason, 'outside_check_cwd');
    assert.equal(checkCoverage(t.repo, [], sel(''), ['T1']).warnings[0].reason, 'no_files_listed');
  });

  test('explicit user tests are preserved untouched by coverage analysis', () => {
    scaffold();
    scenario(planOf(['packages/web/x.ts']));
    const id = start().json.run;
    const a = cli('advance', id);
    assert.equal(a.json.check_coverage, undefined, 'explicit command from the root: nothing detectably outside');
    assert.deepEqual(runJson(id).tests, [TEST_OK]);
  });

  test('repair reuses the highest relevant task tier; low-risk stays sonnet; the repair override still wins', () => {
    const qaFail = { verdict: 'fail', summary: 'bad', findings: [{ blocking: true, file: 'app.txt', issue: 'wrong', fix: 'fix' }] };
    for (const [plan, over, want] of [[planOf(['app.txt'], 'high'), undefined, 'opus'], [planOf(['app.txt'], 'low'), undefined, 'sonnet'], [planOf(['app.txt'], 'high'), 'haiku', 'haiku']]) {
      scenario({ ...plan, qa: [qaFail] });
      fs.rmSync(`${t.env.FAKE_SCENARIO}.count.json`, { force: true });
      const id = start(over ? { models: { repair: over } } : {}).json.run;
      cli('advance', id); edit();
      const rep = cli('advance', id, '--done', 'task-T1');
      assert.equal(rep.json.action, 'repair', rep.out);
      assert.equal(rep.json.agent.model, want, `${JSON.stringify(plan.plan[0].tasks[0].risk)} override=${over}`);
      assert.equal(rep.json.tier, want);
      if (!over && want === 'opus') assert.match(rep.json.tier_reason, /inherits opus from task T1/);
      cli('cancel', id); edit('todo\n');
    }
  });

  test('a worker override does not leak into repair routing', () => {
    scenario({ ...planOf(['app.txt'], 'high'), qa: [{ verdict: 'fail', summary: 'bad', findings: [{ blocking: true, file: 'app.txt', issue: 'wrong', fix: 'fix' }] }] });
    const id = start({ models: { worker: 'haiku' } }).json.run;
    const a = cli('advance', id);
    assert.equal(a.json.tier, 'haiku');
    edit();
    assert.equal(cli('advance', id, '--done', 'task-T1').json.agent.model, 'opus', 'repair is routed by task risk, not by the worker override');
  });
});

describe('final review fixes (v0.2.2)', () => {
  const stepOf = (id, sid) => runJson(id).steps.find((x) => x.id === sid);

  test('Codex: a transient error recovered by turn.completed passes; turn.failed, an unrecovered error and a truncated stream fail even with exit 0 and a valid -o', () => {
    const PROP = { summary: 'Set app.txt', approach: 'Edit', risks: [], files: ['app.txt'] };
    scenario({ proposal: [{ ...PROP, $mode: 'recovered' }] });
    const ok = start().json.run;
    assert.equal(cli('advance', ok).json.action, 'implement');
    assert.equal(stepOf(ok, 'proposal').event_counts.error, 1, 'the transient error is still recorded');
    cli('cancel', ok);
    for (const [mode, re] of [['turn_failed', /codex turn failed: codex turn failed hard/], ['error', /unrecovered error: codex stream failure/], ['truncated', /without a successful turn\.completed/]]) {
      scenario({ proposal: [{ ...PROP, $mode: mode }] }); fs.rmSync(`${t.env.FAKE_SCENARIO}.count.json`, { force: true });
      const id = start().json.run;
      const a = cli('advance', id);
      assert.equal(a.json.action, 'failed', `${mode}: ${a.out}`);
      assert.match(a.json.failure.error, re);
      assert.equal(a.json.failure.kind, 'stream');
      assert.equal(fs.existsSync(path.join(runDirOf(id), 'artifacts/proposal.json')), false, 'the -o content was not accepted');
      cli('cancel', id);
    }
    assert.deepEqual(codexStreamResult(new Normalizer('codex')), {}, 'legacy: no recognised events → not judged');
    const n = new Normalizer('codex');
    for (const l of ['{"type":"turn.failed","error":{"message":"x"}}', '{"type":"turn.completed"}']) n.push(l);
    assert.match(codexStreamResult(n).error, /turn failed/, 'turn.failed is sticky');
  });

  test('scope amendment in full policy invalidates the old Grok approval: review r2 before any new plan; clarify keeps the plan', () => {
    const id = start().json.run;
    cli('advance', id); // proposal → review(r1, approve) → plan → implement
    edit();
    assert.deepEqual(calls().map((c) => c.role), ['proposal', 'review', 'plan']);
    const a = amend(id, { kind: 'scope', text: 'also create extra.txt' }, '--writer-stopped');
    assert.equal(a.json.phase, 'review', a.out);
    assert.equal(runJson(id).review_floor, 2);
    assert.ok(a.json.effects.some((e) => /earlier Grok approval no longer covers/.test(e)));
    assert.equal(calls().length, 3, 'amend itself does no model call');
    scenario({ plan: [{ summary: 'two', tasks: [{ id: 'N1', title: 'extra', description: 'extra.txt', files: ['extra.txt'], depends_on: [], difficulty: 'low', risk: 'low' }] }] });
    const n = cli('advance', id);
    assert.equal(n.json.action, 'implement', n.out);
    assert.deepEqual(calls().map((c) => c.role), ['proposal', 'review', 'plan', 'review', 'plan'], 'new Grok review precedes the new plan; no new proposal');
    assert.equal(stepOf(id, 'review').attempt, 1);
    const reviews = runJson(id).steps.filter((x) => x.id === 'review');
    assert.deepEqual(reviews.map((x) => x.revision), [1, 2]);
    assert.match(promptOf(id, 'review.a2.txt'), /also create extra\.txt/);
    assert.match(promptOf(id, 'review.a2.txt'), /already_changed_paths_in_working_tree>\napp\.txt/);
    assert.match(promptOf(id, 'review.a2.txt'), /scope_amendment_already_completed_tasks/);
    assert.equal(fs.readFileSync(path.join(t.repo, 'app.txt'), 'utf8'), 'done\n', 'edits kept');
  });

  test('before planning: scope sends a plan-phase run back to review; clarify keeps the review; the plan gate itself refuses a stale review', () => {
    const id = start().json.run;
    cli('advance', id, '--one-step'); cli('advance', id, '--one-step'); // proposal, review
    assert.equal(runJson(id).phase, 'plan');
    assert.equal(amend(id, { kind: 'clarify', text: 'detail' }).json.phase, 'plan', 'clarify keeps the approval');
    const s = amend(id, { kind: 'scope', text: 'bigger' });
    assert.equal(s.json.phase, 'review');
    // gate: even if phase is forced back to plan, no plan call happens without a current review
    saveRun(id, (r) => { r.phase = 'plan'; });
    cli('advance', id, '--one-step');
    assert.deepEqual(calls().map((c) => c.role), ['proposal', 'review'], 'the gate bounced to review without a model call');
    assert.equal(runJson(id).phase, 'review');
    assert.equal(cli('advance', id).json.action, 'implement');
    assert.deepEqual(calls().map((c) => c.role), ['proposal', 'review', 'review', 'plan']);
  });

  test('log cursor holds an incomplete UTF-8 tail even at the current EOF and completes it when the writer appends', () => {
    const dir = path.join(t.root, 'rd'); fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const f = path.join(dir, 'logs/live.log');
    const zhong = Buffer.from('中');
    fs.writeFileSync(f, Buffer.concat([Buffer.from('ab'), zhong.subarray(0, 2)]));
    const r1 = readLogRange(dir, 'logs/live.log', { offset: 0, limit: 100, final: false });
    assert.equal(r1.text, 'ab');
    assert.equal(r1.next_offset, 2, 'cursor stays at the character boundary');
    assert.equal(r1.held_incomplete_tail, true);
    assert.ok(!r1.text.includes('\ufffd'));
    fs.appendFileSync(f, zhong.subarray(2));
    const r2 = readLogRange(dir, 'logs/live.log', { offset: r1.next_offset, limit: 100, final: false });
    assert.equal(r2.text, '中');
    assert.equal(r2.next_offset, 5);
    assert.equal(r2.eof, true);
    // a finished log with a truly broken tail is not held forever
    fs.writeFileSync(f, Buffer.concat([Buffer.from('x'), zhong.subarray(0, 1)]));
    const fin = readLogRange(dir, 'logs/live.log', { offset: 0, limit: 100, final: true });
    assert.equal(fin.eof, true);
  });

  test('a limit smaller than the first character still advances (at most one character, 4 bytes); no infinite cursor', () => {
    const dir = path.join(t.root, 'rd2'); fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs/z.log'), '中a国');
    let off = 0; let text = ''; let n = 0;
    for (; n < 10; n++) {
      const r = readLogRange(dir, 'logs/z.log', { offset: off, limit: 1 });
      assert.ok(r.bytes <= 4);
      assert.ok(r.next_offset > off || r.eof, `progress at ${off}`);
      text += r.text; off = r.next_offset;
      if (r.eof) break;
    }
    assert.equal(text, '中a国');
    assert.ok(n <= 4);
  });

  test('interrupt stops a hung stage and its grandchildren but keeps the run OPEN; amend then resume revised work in the same run; cancel still closes', async () => {
    scenario({ proposal: [{ $hang: true }] });
    t.env.FAKE_GRANDCHILD = path.join(t.root, 'gc5.pid');
    const id = start().json.run;
    const wt = path.join(t.root, 'wtI'); sh(t.repo, 'worktree', 'add', '-q', wt, '-b', 'sideI');
    assert.equal(cli('interrupt', id).json.error, 'no_helper', 'nothing running yet');
    const h = bg(['advance', id]);
    await until(() => fs.existsSync(t.env.FAKE_GRANDCHILD));
    const gpid = Number(fs.readFileSync(t.env.FAKE_GRANDCHILD, 'utf8'));
    assert.equal(cliIn(wt, 'interrupt', id).json.error, 'wrong_worktree');
    await sleep(200);
    assert.equal(h.child.exitCode, null, 'wrong worktree: no signal was sent');
    const i = cli('interrupt', id);
    assert.equal(i.code, 0, i.out);
    await h.done; await sleep(150);
    assert.throws(() => process.kill(gpid, 0), /ESRCH/, 'process group killed');
    let r = runJson(id);
    assert.equal(r.status, 'failed');
    assert.equal(r.failure.interrupted, true); assert.equal(r.failure.by_user, true);
    assert.equal(r.steps[0].status, 'interrupted');
    assert.equal(fs.existsSync(path.join(t.repo, '.git/concord/lock')), false);
    const a = amend(id, { kind: 'clarify', text: 'REVISED-WORDING' });
    assert.equal(a.code, 0, a.out);
    assert.ok(a.json.effects.some((e) => /interrupted will run again/.test(e)));
    assert.equal(runJson(id).status, 'active');
    assert.equal(calls().length, 1, 'amend/resume ran no model call');
    const res = cli('resume', id);
    assert.equal(res.json.action, 'continue');
    assert.equal(res.json.next_stage.step, 'proposal');
    assert.equal(calls().length, 1);
    const go = cli('advance', id);
    assert.equal(go.json.action, 'implement', go.out);
    assert.match(promptOf(id, 'proposal.a2.txt'), /REVISED-WORDING/);
    assert.equal(runJson(id).revision, 2);
    assert.equal(cli('cancel', id).json.status, 'cancelled');
    assert.equal(amend(id, { kind: 'clarify', text: 'x' }).json.error, 'not_open');
  });

  test('an interrupted crash-style failure is not auto-cleared by amend; actions advertise one-step background handling after --done', () => {
    const id = start().json.run;
    const a = cli('advance', id);
    assert.ok(a.json.done.includes('--one-step'));
    assert.equal(a.json.after_done.step, 'test-1');
    assert.equal(a.json.after_done.background.timeout_ms, (300 + 120) * 1000);
    edit();
    const d = cli('advance', id, '--done', 'task-T1', '--revision', '1', '--one-step');
    assert.equal(d.json.action, 'continue', 'only the test stage ran');
    assert.equal(d.json.next_stage.step, 'qa-1');
    assert.equal(d.json.timing.stages_run, 1);
    assert.equal(cli('advance', id, '--one-step').json.status, 'validated');
  });
});
