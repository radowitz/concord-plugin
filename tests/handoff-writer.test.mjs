// Consented Claude → Codex handoff tests (node --test), v0.4.0: the Codex writer, drive, models, packaging and docs.
// Offline and deterministic: fake codex/grok CLIs, a fake model catalog with invented slugs, temporary git
// repositories. No real limit, no real model, no network. Nothing here proves real provider behaviour.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import * as CX from '../plugins/concord/scripts/lib/codex-routing.mjs';
import * as R from '../plugins/concord/scripts/lib/routing.mjs';
import * as HO from '../plugins/concord/scripts/lib/handoff.mjs';
import {
  CATALOG, CLI, LEVELS, LIMIT, PLUGIN, ROOT, WRITE_DONE, app, approve, arg, calls, cleanup, cli, cliIn, count, decide, edit, file, fresh, handoff, model, nextSeq, patchRun, pending, planOf, prepare, quota, roles, runDirOf, runJson, scenario, sh, start, task,
} from './fixtures/concord_plugin/handoff-helpers.mjs';

let t;
after(cleanup);
beforeEach(() => { t = fresh(); });

describe('handoff writer review regressions', () => {
  test('Git changes between approved coding steps require fresh consent before any further CLI calls', () => {
    for (const change of ['branch', 'index', 'head', 'stash']) {
      t = fresh();
      scenario({ ...planOf([task('T1'), task('T2', { depends_on: ['T1'] })]), codex_task: [{ $write: { 't1.txt': 'one\n' } }, WRITE_DONE] });
      const id = pending();
      handoff(id);
      assert.equal(cli('drive', id, '--one-step').json.action, 'continue');
      assert.equal(runJson(id).tasks[0].status, 'done');
      if (change === 'branch') sh(t.repo, 'checkout', '-qb', 'external-branch');
      if (change === 'index') { fs.writeFileSync(path.join(t.repo, 'human.txt'), 'human staged work\n'); sh(t.repo, 'add', 'human.txt'); }
      if (change === 'head') sh(t.repo, 'commit', '--allow-empty', '-qm', 'external commit');
      if (change === 'stash') { edit('human partial work\n'); sh(t.repo, 'stash', 'push', '-u', '-m', 'external stash'); }
      const state = HO.gitState(t.repo), status = sh(t.repo, 'status', '--porcelain'), n = calls().length;
      const result = cli('drive', id);
      assert.equal(result.json.status, 'paused', change);
      assert.equal(result.json.pause.kind, 'checkout_changed', change);
      assert.equal(runJson(id).handoff.status, 'invalidated');
      assert.equal(calls().length, n, 'drift is refused before auth, discovery or coding');
      assert.deepEqual(HO.gitState(t.repo), state, 'never reset user Git state');
      assert.equal(sh(t.repo, 'status', '--porcelain'), status);
      assert.equal(runJson(id).tasks[1].status, 'pending');
    }
  });

  test('subscription errors in stderr survive truncated streams and writer timeouts without a retry', () => {
    for (const timeout of [false, true]) {
      t = fresh();
      scenario({ codex_task: [{ $write: { 'app.txt': 'partial\n' }, $stderr: "You've hit your limit. Resets later.\n", ...(timeout ? { $hang: true } : { $mode: 'truncated' }) }] });
      const id = pending(timeout ? { limits: { role_timeout_s: { writer: 1 } } } : {});
      handoff(id);
      const result = cli('drive', id);
      assert.deepEqual([result.json.status, result.json.pause.kind], ['paused', 'codex_quota'], result.out);
      assert.equal(app(), 'partial\n');
      assert.equal(runJson(id).tasks[0].status, 'pending');
      assert.equal(runJson(id).repairs_used, 0);
      assert.equal(count('codex_task'), 1);
      assert.equal(cli('drive', id).json.action, 'paused');
      assert.equal(count('codex_task'), 1, 'no automatic retry');
    }
  });
});

// ============================================================================ writer and drive

describe('Codex writer and drive', () => {
  const THREE = planOf([task('T1'), task('T2', { depends_on: ['T1'], difficulty: 'medium', risk: 'medium' }), task('T3', { depends_on: ['T2'], difficulty: 'high' })]);

  test('whole remaining DAG without a Claude turn: Codex tasks → real check → bounded Codex repair → fresh QA → human approval', () => {
    // Pre-existing user work (staged and untracked) must survive untouched.
    fs.writeFileSync(path.join(t.repo, 'mine.txt'), 'user work\n');
    fs.writeFileSync(path.join(t.repo, 'staged.txt'), 'staged by user\n');
    sh(t.repo, 'add', 'staged.txt');
    const index0 = sh(t.repo, 'ls-files', '--stage');
    scenario({ ...THREE,
      codex_task: [{ $write: { 't2.txt': 'two\n' }, summary: 'wrote t2', files_changed: ['t2.txt'], status: 'completed', notes: '' }, { $write: { 'app.txt': 'almost\n' } }],
      codex_repair: [{ $write: { 'app.txt': 'done\n' } }, { $write: { 'app.txt': 'done\n', 'fix.txt': 'qa fix\n' } }],
      qa: [{ verdict: 'fail', summary: 'needs fix', findings: [{ blocking: true, file: 'app.txt', issue: 'missing fix.txt', fix: 'add it' }] }] });
    const id = pending();
    fs.writeFileSync(path.join(t.repo, 't1.txt'), 'one\n'); // Claude finished T1 natively
    const t2 = cli('advance', id, '--done', 'task-T1', '--executor', 'subagent', '--revision', '1');
    assert.deepEqual([t2.json.action, t2.json.step], ['implement', 'task-T2']);
    fs.writeFileSync(path.join(t.repo, 't2.txt'), 'partial by claude\n'); // T2 was half written when the limit hit
    quota(id, LIMIT, 'task-T2');
    const p = handoff(id);
    assert.deepEqual(p.remaining.done, ['T1']);
    assert.deepEqual(p.remaining.tasks.map((x) => x.id), ['T2', 'T3']);
    const d = cli('drive', id);
    assert.deepEqual([d.json.action, d.json.status], ['await_human', 'validated'], d.out + d.err);
    assert.equal(d.json.drive.stopped_because, 'await_human');
    const run = runJson(id);
    assert.deepEqual(run.steps.map((x) => `${x.id}:${x.role}:${x.status}`), ['proposal:proposal:passed', 'review:review:passed', 'plan:plan:passed', 'task-T1:task:passed',
      'task-T2:codex_task:passed', 'task-T3:codex_task:passed', 'test-1:test:tests_failed', 'repair-1:codex_repair:passed', 'test-2:test:passed', 'qa-1:qa:passed',
      'repair-2:codex_repair:passed', 'test-3:test:passed', 'qa-2:qa:passed']);
    assert.equal(run.repairs_used, 2);
    assert.equal(run.approval, null, 'drive never approves');
    // Tier routing: T2 normal → cx-work@medium, T3 high → cx-deep@high, repairs inherit the highest related tier.
    const w = calls().filter((c) => ['codex_task', 'codex_repair'].includes(c.role));
    assert.deepEqual(w.map((c) => `${c.role}:${arg(c.argv, '--model')}:${c.argv.find((a) => a.startsWith('model_reasoning_effort'))}`),
      ['codex_task:cx-work:model_reasoning_effort="medium"', 'codex_task:cx-deep:model_reasoning_effort="high"', 'codex_repair:cx-deep:model_reasoning_effort="high"', 'codex_repair:cx-deep:model_reasoning_effort="high"']);
    // Identity: native and Codex steps are told apart; no native model record is invented for Codex work.
    const s1 = run.steps.find((x) => x.id === 'task-T1'); const s2 = run.steps.find((x) => x.id === 'task-T2');
    assert.deepEqual([s1.provider, s1.executor, typeof s1.model], ['claude (native)', 'subagent', 'object']);
    assert.deepEqual([s2.provider, s2.executor, s2.model, s2.effort, s2.codex_tier, s2.sandbox], ['codex', 'codex_cli', 'cx-work', 'medium', 'normal', 'workspace-write']);
    assert.match(s2.note, /coding report only: not validation and not approval/);
    assert.deepEqual(run.tasks.map((x) => x.codex?.model ?? null), [null, 'cx-work', 'cx-deep']);
    // The writer prompt carries the request, the exact step, completed work, the partial edits and the prohibitions.
    const prompt = fs.readFileSync(path.join(runDirOf(id), 'prompts/task-T2.a1.txt'), 'utf8');
    for (const re of [/technical id: codex_task/, /Make app\.txt say done/, /revision 1/, /"id": "T2"/, /<completed_tasks>[\s\S]*"id": "T1"/, /pending_tasks_after_this_step_not_yours_now>[\s\S]*"id": "T3"/,
      /\+partial by claude/, /\+one/, /no commit, add\/stage, reset/, /Never touch Concord's own state/, /It is not validation and not approval/, /report status "blocked"/,
      /preexisting_uncommitted_state_at_start>[\s\S]*mine\.txt/, /after Claude reported a usage limit/]) assert.match(prompt, re);
    assert.doesNotMatch(prompt, /SECRET-BASE-INSTRUCTIONS|Frontier intelligence/, 'catalog text never reaches a prompt');
    const rprompt = fs.readFileSync(path.join(runDirOf(id), 'prompts/repair-1.a1.txt'), 'utf8');
    assert.match(rprompt, /technical id: codex_repair[\s\S]*<repair_cause>[\s\S]*"kind": "tests"/);
    assert.match(fs.readFileSync(path.join(runDirOf(id), 'prompts/repair-2.a1.txt'), 'utf8'), /"kind": "qa"[\s\S]*missing fix\.txt/);
    // Nothing published, nothing reset: HEAD, index and the user's files are exactly as before.
    assert.equal(sh(t.repo, 'log', '--oneline').trim().split('\n').length, 1, 'no commit');
    assert.equal(sh(t.repo, 'ls-files', '--stage'), index0, 'staged index untouched');
    assert.equal(sh(t.repo, 'stash', 'list'), '');
    assert.equal(fs.readFileSync(path.join(t.repo, 'mine.txt'), 'utf8'), 'user work\n');
    assert.equal(fs.readFileSync(path.join(t.repo, 't2.txt'), 'utf8'), 'two\n');
    const st = cli('status', id);
    for (const re of [/handoff: active — Codex CLI, ChatGPT login only/, /low → cx-quick @ low \[heuristic\]/, /high → cx-deep @ high/, /task-T2\s+六部 · Codex Workers \(handoff\) · codex:cx-work @ medium \[normal tier, handoff\]/,
      /WRITTEN BY Codex CLI cx-deep @ high \(handoff\)/, /frozen for this handoff/, /not an approval of the result/]) assert.match(st.out, re);
    // Final approval stays a separate, fingerprint-bound human decision; the handed-off run is never a Claude sample.
    fs.appendFileSync(path.join(t.repo, 'fix.txt'), 'late edit\n');
    assert.equal(cli('approve', id, '--decision', 'approve').json.error, 'stale_validation');
    assert.equal(cli('drive', id).json.status, 'validated', 're-validated after the late edit');
    const ap = cli('approve', id, '--decision', 'approve');
    assert.equal(ap.json.status, 'approved', ap.out);
    assert.equal(ap.json.approval.outcome_ledger.recorded, false);
    assert.match(ap.json.approval.outcome_ledger.reason, /Codex handoff record/);
    assert.equal(fs.existsSync(path.join(t.env.CONCORD_CACHE_DIR, 'outcomes.json')), false, 'no Claude ledger credit');
    assert.equal(sh(t.repo, 'log', '--oneline').trim().split('\n').length, 1);
  });

  test('the repair budget still binds Codex; an exhausted budget fails the run and nothing loops', () => {
    scenario({ codex_task: [{ $write: { 'app.txt': 'wrong\n' } }], codex_repair: [{ $write: { 'app.txt': 'wrong again\n' } }, { $write: { 'app.txt': 'done\n' } }] });
    const id = pending({ limits: { max_repairs: 1 } });
    quota(id);
    handoff(id);
    const d = cli('drive', id);
    assert.deepEqual([d.json.action, d.json.status], ['failed', 'failed'], d.out);
    assert.match(d.json.failure.error, /repair budget exhausted \(1\/1\)/);
    assert.equal(count('codex_repair'), 1);
    const n = calls().length;
    assert.equal(cli('drive', id).json.action, 'failed');
    assert.equal(calls().length, n, 'a failed run is not driven further');
    assert.equal(cli('advance', id, '--retry').json.error, 'usage');
    // A repair that changes nothing is still caught by the no-op guard.
    cli('cancel', id);
    scenario({ codex_task: [{ $write: { 'app.txt': 'wrong\n' } }], codex_repair: [{ summary: 'nothing to do', status: 'completed', files_changed: [], notes: '' }] });
    const id2 = pending();
    quota(id2);
    handoff(id2);
    const d2 = cli('drive', id2);
    assert.equal(d2.json.failure.noop_repair, true, d2.out);
    assert.equal(runJson(id2).repairs_used, 0);
  });

  test('an incomplete writer pauses with its partial edits: CLI error, failed or truncated stream, missing or malformed report, blocked', () => {
    const cases = [
      [{ $write: { 'app.txt': 'partial\n' }, $exit: 3 }, 'writer_incomplete', 'exit', /exit 3/],
      [{ $write: { 'app.txt': 'partial\n' }, $mode: 'turn_failed' }, 'writer_incomplete', 'stream', /codex turn failed/],
      [{ $write: { 'app.txt': 'partial\n' }, $mode: 'truncated' }, 'writer_incomplete', 'stream', /without a successful turn\.completed/],
      [{ $write: { 'app.txt': 'partial\n' }, $mode: 'error' }, 'writer_incomplete', 'stream', /unrecovered error/],
      [{ $write: { 'app.txt': 'partial\n' }, $mode: 'no_last' }, 'writer_incomplete', 'malformed', /no final message file/],
      [{ $write: { 'app.txt': 'partial\n' }, $pieces: ['plain text, no events\n'] }, 'writer_incomplete', 'stream', /final message file alone is not evidence/],
      [{ $write: { 'app.txt': 'partial\n' }, $raw: 'I finished everything!' }, 'writer_incomplete', 'malformed', /no JSON object/],
      [{ $write: { 'app.txt': 'partial\n' }, $raw: '{"status":"completed"}' }, 'writer_incomplete', 'malformed', /malformed Codex coding report rejected/],
      [{ $write: { 'app.txt': 'partial\n' }, $raw: '{"status":"done","summary":"x","files_changed":[],"notes":""}' }, 'writer_incomplete', 'malformed', /status must be completed\|blocked/],
      [{ $write: { 'app.txt': 'partial\n' }, status: 'blocked', summary: 'sandbox refused to write outside the workspace', files_changed: [], notes: '' }, 'writer_blocked', 'blocked', /could not complete task-T1 \(nothing was marked done\): sandbox refused/],
    ];
    // One run, one case after another: every further attempt needs an explicit `resume --retry-codex`.
    scenario({ codex_task: [...cases.map((c) => c[0]), WRITE_DONE] });
    const id = pending();
    quota(id);
    handoff(id);
    for (const [i, [resp, kind, cls, re]] of cases.entries()) {
      const label = JSON.stringify(resp).slice(0, 80);
      if (i > 0) {
        const r = cli('resume', id, '--retry-codex');
        assert.deepEqual([r.json.action, r.json.status, r.json.next_stage.model], ['continue', 'active', 'cx-quick'], label);
        assert.equal(count('codex_task'), i, 'resume itself runs nothing');
      }
      const d = cli('drive', id);
      assert.deepEqual([d.json.action, d.json.status, d.json.pause.kind, d.json.pause.class, d.json.pause.provider], ['paused', 'paused', kind, cls, 'codex'], `${label}: ${d.out}`);
      assert.match(d.json.pause.error, re, label);
      assert.deepEqual(d.json.pause.preserved.changed_paths, ['app.txt'], label);
      assert.equal(app(), 'partial\n', 'partial edit kept');
      const run = runJson(id);
      assert.deepEqual([run.tasks[0].status, run.repairs_used, run.failure, run.steps.at(-1).status, run.handoff.status], ['pending', 0, null, 'failed', 'active'], label);
      assert.equal(run.steps.some((x) => x.role === 'test'), false, 'no check ran on an incomplete step');
      // No automatic repeat: driving or advancing a paused run spawns nothing.
      assert.equal(cli('drive', id).json.action, 'paused');
      if (i === 0) { assert.equal(cli('advance', id).json.action, 'paused'); assert.equal(cli('advance', id, '--retry').json.error, 'paused'); }
      assert.equal(count('codex_task'), i + 1, label);
    }
    // Explicit retry of the last case: same frozen model, then the normal chain.
    assert.equal(cli('resume', id, '--retry-codex').json.action, 'continue');
    assert.equal(cli('drive', id).json.status, 'validated');
    assert.equal(runJson(id).steps.filter((x) => x.id === 'task-T1').map((x) => x.status).join(), [...cases.map(() => 'failed'), 'passed'].join());
    assert.match(fs.readFileSync(path.join(runDirOf(id), 'prompts/task-T1.a2.txt'), 'utf8'), /\+partial/, 'the retry sees the partial edit');
  });

  test('Codex quota, rate limit, auth and model errors pause and persist; no loop, no hidden fallback model', () => {
    const cases = [["You've hit your usage limit. Upgrade to Pro or try again in 3 hours.", 'codex_quota'], ['Rate limit reached for requests: 429', 'codex_rate_limit'],
      ['401 Unauthorized: token expired, please log in again', 'codex_auth'], ['The model `cx-quick` does not exist or you do not have access to it.', 'model_unavailable']];
    scenario({ codex_task: [...cases.map(([msg]) => ({ $error_event: msg })), WRITE_DONE] });
    const id = pending();
    quota(id);
    handoff(id);
    for (const [i, [, kind]] of cases.entries()) {
      if (i > 0) assert.equal(cli('resume', id, '--retry-codex').json.action, 'continue');
      const d = cli('drive', id);
      assert.deepEqual([d.json.action, d.json.pause.kind, d.json.pause.model], ['paused', kind, 'cx-quick'], d.out);
      assert.match(d.json.message, /no automatic retry and no fallback model/);
      assert.equal(cli('drive', id).json.action, 'paused');
      assert.equal(count('codex_task'), i + 1, `${kind}: one attempt per explicit retry`);
      assert.ok(calls().filter((c) => c.role === 'codex_task').every((c) => arg(c.argv, '--model') === 'cx-quick'), 'no other model was tried');
      assert.equal(runJson(id).pauses.at(-1).kind, kind);
    }
    assert.deepEqual([runJson(id).repairs_used, runJson(id).tasks[0].status], [0, 'pending']);
    // model_unavailable: re-consent to a different, explicitly shown table (the old consent stays until then).
    const bad = prepare(id, '--codex-routes', 'low=cx-made-up');
    assert.equal(bad.json.error, 'codex_route');
    assert.equal(runJson(id).handoff.routes.low.model, 'cx-quick');
    const p = prepare(id, '--codex-routes', 'low=cx-work@high');
    assert.deepEqual([p.json.proposal.routes.low.model, p.json.proposal.routes.low.effort, p.json.proposal.routes.low.source], ['cx-work', 'high', 'override']);
    assert.equal(runJson(id).handoff.routes.low.model, 'cx-quick', 'a proposal changes nothing by itself');
    assert.equal(approve(id, p.json.proposal.id).json.consented, true);
    assert.equal(cli('drive', id).json.status, 'validated');
    const last = calls().filter((c) => c.role === 'codex_task').at(-1).argv;
    assert.deepEqual([arg(last, '--model'), last.includes('model_reasoning_effort="high"')], ['cx-work', true]);
  });

  test('a writer that changes Git state (index, HEAD, stash) is paused and reported; nothing is reset', () => {
    for (const [git, re] of [[[['add', 'app.txt']], /staged index/], [[['add', 'app.txt'], ['commit', '-qm', 'sneaky']], /HEAD/], [[['stash']], /stash/]]) {
      t = fresh();
      scenario({ codex_task: [{ $write: { 'app.txt': 'done\n' }, $git: git }] });
      const id = pending();
      quota(id);
      handoff(id);
      const head0 = sh(t.repo, 'rev-parse', 'HEAD').trim();
      const d = cli('drive', id);
      assert.deepEqual([d.json.action, d.json.pause.kind], ['paused', 'git_state_changed'], d.out);
      assert.match(d.json.pause.error, re);
      assert.match(d.json.pause.error, /Nothing was reset or reverted/);
      assert.notDeepEqual(d.json.pause.git_before, d.json.pause.git_after);
      assert.equal(runJson(id).tasks[0].status, 'pending', 'a tampering writer is never marked done, even with a "completed" report');
      // Evidence is left in place for the human.
      if (git.length === 2) assert.notEqual(sh(t.repo, 'rev-parse', 'HEAD').trim(), head0);
      else if (git[0][0] === 'add') assert.match(sh(t.repo, 'status', '--porcelain'), /^M {2}app\.txt/);
      else assert.match(sh(t.repo, 'stash', 'list'), /stash@\{0\}/);
      assert.equal(cli('drive', id).json.action, 'paused');
      assert.equal(count('codex_task'), 1);
    }
  });

  test('routes stay frozen when new models appear; an amendment or re-plan invalidates consent until the user consents again', () => {
    scenario({ ...THREE, codex_task: [{ $write: { 't1.txt': '1\n' } }, { $write: { 't2.txt': '2\n' } }, WRITE_DONE, WRITE_DONE] });
    const id = pending();
    quota(id);
    handoff(id);
    assert.equal(cli('advance', id, '--one-step').json.next_stage.step, 'task-T2');
    // A better-looking model is published and the cache expires: the approved handoff does not move.
    fs.writeFileSync(t.catalog, JSON.stringify({ models: [model('cx-newer', 'Latest workhorse model for everyday work.', 0), ...CATALOG.models] }));
    const meta = path.join(t.env.CONCORD_CACHE_DIR, 'codex-models.json');
    const old = JSON.parse(fs.readFileSync(meta, 'utf8')); old.fetched_at = '2026-01-01T00:00:00.000Z'; fs.writeFileSync(meta, JSON.stringify(old));
    assert.equal(cli('advance', id, '--one-step').json.next_stage.step, 'task-T3');
    assert.equal(arg(calls().filter((c) => c.role === 'codex_task').at(-1).argv, '--model'), 'cx-work', 'T2 used the frozen normal route');
    assert.equal(count('debug_models'), 1, 'no discovery during an approved handoff');
    // Clarify: revision 2. Consent was for revision 1.
    const am = cli('amend', id, '--spec', file(JSON.stringify({ kind: 'clarify', text: 'Keep a trailing newline' }), 'json'));
    assert.equal(am.code, 0, am.out + am.err);
    assert.deepEqual([am.json.action, am.json.status, am.json.pause.kind], ['await_switch', 'paused', 'consent_required']);
    assert.ok(am.json.effects.some((e) => /Codex handoff consent invalidated/.test(e)));
    assert.equal(runJson(id).handoff.status, 'invalidated');
    const n = count('codex_task');
    assert.equal(cli('drive', id).json.action, 'await_switch');
    assert.equal(cli('resume', id, '--retry-codex').json.error, 'consent_required');
    assert.equal(count('codex_task'), n, 'Codex writes nothing without fresh consent');
    const p = handoff(id);
    assert.equal(p.revision, 2);
    assert.equal(p.routes.normal.model, 'cx-newer', 'a NEW proposal reads the refreshed list, and shows it before consent');
    assert.equal(count('debug_models'), 2);
    assert.equal(cli('advance', id, '--one-step').json.phase, 'test');
    assert.match(fs.readFileSync(path.join(runDirOf(id), 'prompts/task-T3.a1.txt'), 'utf8'), /Keep a trailing newline[\s\S]*revision 2/);
    // Scope: re-plan. The helper stages run without consent, the writer does not.
    const sc = cli('amend', id, '--spec', file(JSON.stringify({ kind: 'scope', text: 'Also write notes.txt' }), 'json'));
    assert.equal(sc.code, 0, sc.out + sc.err);
    assert.equal(runJson(id).handoff.status, 'invalidated');
    scenario({ plan: [{ summary: 'replan', tasks: [task('N1')] }], codex_task: [WRITE_DONE] });
    const d = cli('drive', id);
    assert.deepEqual([d.json.action, d.json.status, d.json.pause.kind], ['await_switch', 'paused', 'consent_required'], d.out);
    assert.deepEqual(runJson(id).tasks.map((x) => x.id), ['N1']);
    assert.equal(count('codex_task'), n + 1, 'only the consented T3 ran; nothing after the scope change');
    handoff(id);
    assert.equal(cli('drive', id).json.status, 'validated');
  });

  test('once Codex owns the work, late native reports and the native fallback are refused and no native action is exposed', () => {
    scenario({ plan: [{ summary: 'p', tasks: [task('T1', { difficulty: 'high' })] }] });
    const id = pending();
    quota(id);
    handoff(id);
    for (const extra of [['--done', 'task-T1', '--executor', 'subagent', '--revision', '1'], ['--failed', 'task-T1', '--revision', '1', '--note-file', file('x')],
      ['--use-fallback', 'task-T1', '--revision', '1', '--note-file', file('model unavailable')]]) {
      const r = cli('advance', id, ...extra);
      assert.equal(r.json.error, 'handoff_active', extra[0]);
    }
    assert.equal(quota(id).json.error, 'handoff_active');
    const run = runJson(id);
    assert.deepEqual([run.tasks[0].status, run.steps.some((x) => x.provider === 'claude (native)'), run.route_events ?? null], ['pending', false, null]);
    for (const view of [cli('status', id, '--json').json.next, cli('resume', id).json]) {
      assert.deepEqual([view.action, view.owner], ['continue', 'codex (approved handoff)']);
      for (const k of ['agent', 'done', 'fallback', 'main_session', 'route', 'on_limit']) assert.equal(view[k], undefined, k);
      assert.deepEqual([view.next_stage.model, view.next_stage.effort, view.next_stage.tier], ['cx-deep', 'high', 'high']);
    }
    assert.equal(count('codex_task'), 0);
  });

  test('--one-step runs exactly one stage; drive holds one lock for the whole loop and --max-steps bounds it', async () => {
    scenario({ codex_task: [{ $write: { 'app.txt': 'done\n' }, $hold_ms: 1200 }] });
    const id = pending();
    quota(id);
    handoff(id);
    const child = spawn(process.execPath, [CLI, 'drive', id, '--max-steps', '2'], { cwd: t.repo, env: t.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; });
    for (let i = 0; i < 100 && count('codex_task') === 0; i++) await new Promise((r) => setTimeout(r, 30));
    // While the writer runs: a second helper is refused, logs and light status are readable.
    assert.equal(cli('advance', id).json.error, 'locked');
    assert.equal(cli('drive', id).json.error, 'locked');
    assert.equal(cli('amend', id, '--spec', file(JSON.stringify({ kind: 'clarify', text: 'x' }), 'json')).json.error, 'helper_busy');
    const light = cli('status', id, '--light', '--json').json;
    assert.deepEqual([light.running[0].step, light.running[0].provider], ['task-T1', 'codex']);
    const lg = cli('logs', id, '--step', 'task-T1', '--stream', 'events', '--json');
    assert.equal(lg.json.running, true, lg.out);
    assert.match(lg.json.text, /session\.started/);
    await new Promise((r) => child.on('exit', r));
    const d = JSON.parse(out);
    assert.deepEqual([d.drive.iterations, d.drive.stopped_because, d.phase], [2, 'max_steps', 'qa']);
    const one = cli('drive', id, '--one-step');
    assert.deepEqual([one.json.drive.iterations, one.json.status], [1, 'validated']);
    assert.equal(cli('drive', id, '--max-steps', '0').json.error, 'usage');
    assert.equal(fs.existsSync(path.join(t.repo, '.git/concord/lock')), false);
  });

  test('interrupt, helper timeout, cancel and a dead helper: the writer is stopped as a process group and never restarted by itself', async () => {
    const hang = async (verb) => {
      t.env.FAKE_GRANDCHILD = path.join(t.root, `grandchild-${nextSeq()}.pid`);
      const child = spawn(process.execPath, [CLI, 'drive', verb.id], { cwd: t.repo, env: t.env, stdio: 'ignore' });
      for (let i = 0; i < 100 && !fs.existsSync(t.env.FAKE_GRANDCHILD); i++) await new Promise((r) => setTimeout(r, 50));
      const gpid = Number(fs.readFileSync(t.env.FAKE_GRANDCHILD, 'utf8'));
      const res = cli(verb.cmd, verb.id);
      await new Promise((r) => child.on('exit', r));
      await new Promise((r) => setTimeout(r, 200));
      assert.throws(() => process.kill(gpid, 0), /ESRCH/, 'grandchild killed with the group');
      return res;
    };
    scenario({ codex_task: [{ $write: { 'app.txt': 'partial\n' }, $hang: true }, WRITE_DONE] });
    const id = pending();
    quota(id);
    handoff(id);
    const i = await hang({ id, cmd: 'interrupt' });
    assert.deepEqual([i.json.action, i.json.failure.interrupted, i.json.failure.by_user], ['failed', true, true], i.out);
    assert.equal(app(), 'partial\n');
    assert.equal(cli('drive', id).json.action, 'failed', 'drive does not restart an interrupted writer');
    assert.equal(cli('resume', id).json.action, 'failed');
    assert.equal(prepare(id).json.error, 'not_recoverable', 'an interrupted writer is retried explicitly, not taken over again');
    assert.equal(count('codex_task'), 1);
    const re = cli('advance', id, '--retry');
    assert.equal(re.json.status, 'validated', re.out);
    assert.equal(count('codex_task'), 2);

    // Helper timeout (limits.role_timeout_s.writer): a pause, not a failure and not a verdict.
    t = fresh();
    scenario({ codex_task: [{ $write: { 'app.txt': 'partial\n' }, $hang: true }] });
    const id2 = pending({ limits: { role_timeout_s: { writer: 1 } } });
    quota(id2);
    handoff(id2);
    const d = cli('drive', id2);
    assert.deepEqual([d.json.action, d.json.pause.kind, d.json.pause.class], ['paused', 'writer_incomplete', 'timeout'], d.out);
    assert.match(d.json.pause.error, /Partial edits are kept[\s\S]*resume --retry-codex/);
    assert.equal(runJson(id2).steps.at(-1).timeout_s, 1);
    assert.equal(start({ limits: { role_timeout_s: { coder: 5 } } }).json.error, 'spec');

    // A helper that died mid-writer: reported as interrupted, not re-executed.
    patchRun(id2, (r) => { r.status = 'active'; r.pause = null; r.steps.push({ id: 'task-T1', attempt: 2, role: 'codex_task', label: 'x', provider: 'codex', status: 'running', started_at: new Date().toISOString() }); });
    const n = count('codex_task');
    const s = cli('drive', id2);
    assert.deepEqual([s.json.action, s.json.interrupted], ['failed', ['task-T1']], s.out);
    assert.equal(count('codex_task'), n);

    // Cancel during the writer closes the run; files stay.
    t = fresh();
    scenario({ codex_task: [{ $write: { 'app.txt': 'partial\n' }, $hang: true }] });
    const id3 = pending();
    quota(id3);
    handoff(id3);
    const c = await hang({ id: id3, cmd: 'cancel' });
    assert.equal(c.json.status, 'cancelled', c.out);
    assert.equal(app(), 'partial\n');
    assert.equal(cli('drive', id3).json.action, 'none');
  });

  test('resume --claude ends a paused handoff: the step returns to the Claude session and the run stays excluded from the ledger', () => {
    scenario({ codex_task: [{ $error_event: 'usage limit reached for your plan' }] });
    const id = pending();
    quota(id);
    handoff(id);
    assert.equal(cli('drive', id).json.pause.kind, 'codex_quota');
    assert.equal(cli('resume', id, '--claude', '--retry-codex').json.error, 'usage');
    const r = cli('resume', id, '--claude');
    assert.deepEqual([r.json.action, r.json.step, r.json.status], ['implement', 'task-T1', 'awaiting_session'], r.out);
    assert.deepEqual(r.json.agent, { subagent_type: 'general-purpose', model: 'haiku' });
    const h = runJson(id).handoff;
    assert.deepEqual([h.status, h.ended.reason], ['ended', 'the user resumed the pending step with Claude']);
    assert.equal(cli('drive', id).json.action, 'implement', 'drive stops at a step that belongs to the session');
    assert.equal(count('codex_task'), 1);
    edit();
    assert.equal(cli('advance', id, '--done', 'task-T1', '--executor', 'subagent', '--revision', '1').json.status, 'validated');
    const ap = cli('approve', id, '--decision', 'approve');
    assert.equal(ap.json.approval.outcome_ledger.recorded, false);
    assert.equal(R.outcomeSample(runJson(id)).sample, null);
  });
});

// ============================================================================ models, packaging, docs

describe('models, packaging and documentation', () => {
  test('help, preflight, status and models call no CLI; models --refresh caches whitelisted Codex metadata from the same single call', () => {
    const help = cli('--help');
    for (const re of [/quota RUN --step STEP/, /takeover RUN --writer-stopped/, /drive RUN/, /resume RUN \[--claude \| --retry-codex\]/, /"on_claude_limit": "ask"\|"stop"/, /Never consent by itself/]) assert.match(help.out, re);
    assert.equal(cli('--version').out.trim(), '0.4.0');
    cli('preflight', '--json');
    const m0 = cli('models', '--json');
    assert.deepEqual([m0.json.codex_handoff.fetched_at, m0.json.codex_handoff.routes.low.source], [null, 'provider_default']);
    assert.match(cli('models').out, /Codex handoff routing \(used only after an explicit takeover consent/);
    const id = pending();
    cli('status', id); cli('status', id, '--json');
    assert.deepEqual(roles().filter((x) => ['login_status', 'debug_models', 'codex_task'].includes(x)), []);
    const before = count('debug_models');
    const m = cli('models', '--refresh', '--json');
    assert.equal(m.code, 0, m.err);
    assert.equal(count('debug_models'), before + 1, 'one codex debug models call serves ids and metadata');
    assert.deepEqual(m.json.providers.codex.models, ['cx-deep', 'cx-plain', 'cx-quick', 'cx-quick-old', 'cx-work', 'cx-work-old'], 'existing id consumers unchanged; hidden excluded');
    assert.deepEqual(CX.CODEX_TIERS.map((k) => m.json.codex_handoff.routes[k].model), ['cx-quick', 'cx-work', 'cx-deep']);
    assert.match(m.json.codex_handoff.note, /not a benchmark/);
    const cached = fs.readFileSync(path.join(t.env.CONCORD_CACHE_DIR, 'codex-models.json'), 'utf8');
    assert.doesNotMatch(cached, /SECRET-BASE-INSTRUCTIONS/);
    assert.doesNotMatch(fs.readFileSync(path.join(t.env.CONCORD_CACHE_DIR, 'models.json'), 'utf8'), /SECRET-BASE-INSTRUCTIONS/);
  });

  test('a stale or missing model list is shown before consent and frozen as unverified', () => {
    const id = pending();
    quota(id);
    t.env.FAKE_CODEX_MODELS_FAIL = '1';
    const p = prepare(id);
    assert.equal(p.code, 0, p.out + p.err);
    assert.deepEqual([p.json.proposal.catalog.fetched_at, p.json.proposal.catalog.stale, p.json.proposal.catalog.refresh], [null, true, 'failed']);
    assert.deepEqual(CX.CODEX_TIERS.map((k) => `${p.json.proposal.routes[k].model}:${p.json.proposal.routes[k].verified}`), ['account_default:false', 'account_default:false', 'account_default:false']);
    assert.match(p.json.text, /Model list: NONE AVAILABLE — STALE \/ UNVERIFIED/);
    assert.match(p.json.text, /UNVERIFIED\] no Codex model list is available/);
    const o = prepare(id, '--codex-routes', 'high=cx-typed-by-user@xhigh');
    assert.deepEqual([o.json.proposal.routes.high.model, o.json.proposal.routes.high.verified], ['cx-typed-by-user', false]);
    // Last good list + failed refresh: used, flagged stale.
    delete t.env.FAKE_CODEX_MODELS_FAIL;
    fs.rmSync(path.join(t.env.CONCORD_CACHE_DIR, 'codex-models.json'), { force: true });
    prepare(id);
    const meta = path.join(t.env.CONCORD_CACHE_DIR, 'codex-models.json');
    const old = JSON.parse(fs.readFileSync(meta, 'utf8')); old.fetched_at = '2026-01-01T00:00:00.000Z'; fs.writeFileSync(meta, JSON.stringify(old));
    t.env.FAKE_CODEX_MODELS_FAIL = '1';
    const s = prepare(id);
    assert.deepEqual([s.json.proposal.catalog.fetched_at, s.json.proposal.catalog.stale, s.json.proposal.routes.low.model], ['2026-01-01T00:00:00.000Z', true, 'cx-quick']);
    assert.match(s.json.text, /2026-01-01T00:00:00\.000Z \[failed\] — STALE \/ UNVERIFIED/);
    scenario({ codex_task: [WRITE_DONE] });
    assert.equal(approve(id, s.json.proposal.id).json.consented, true, 'explicit consent to the displayed stale table');
    assert.equal(cli('drive', id).json.status, 'validated');
    assert.equal(runJson(id).handoff.catalog.stale, true);
  });

  test('the package ships the handoff modules and skills at 0.4.0; skills state the consent rules', () => {
    const out = path.join(t.root, 'dist');
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/package.mjs'), '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['scripts/lib/handoff.mjs', 'scripts/lib/codex-routing.mjs', 'skills/takeover/SKILL.md', 'skills/run/SKILL.md', 'README.md', 'README.zh-CN.md']) assert.ok(fs.existsSync(path.join(out, 'concord', f)), f);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, '.claude-plugin/marketplace.json'), 'utf8')).plugins[0].version, '0.4.0');
    assert.match(spawnSync(process.execPath, [path.join(out, 'concord/scripts/concord.mjs'), '--help'], { encoding: 'utf8' }).stdout, /takeover RUN --writer-stopped/);
    assert.equal(fs.existsSync(path.join(PLUGIN, 'hooks')), false, 'no hooks are registered in this iteration');
    const run = fs.readFileSync(path.join(PLUGIN, 'skills/run/SKILL.md'), 'utf8');
    for (const re of [/on_limit\.report/, /--on-claude-limit ask\|stop/, /await_switch/, /never consent|not consent/i, /claude_limit\.takeover_terminal/]) assert.match(run, re);
    const tk = fs.readFileSync(path.join(PLUGIN, 'skills/takeover/SKILL.md'), 'utf8');
    for (const re of [/AskUserQuestion|question UI/, /--proposal/, /--writer-stopped/, /Never (?:approve|decide) for/i, /not approval of the result|not final approval/i]) assert.match(tk, re);
    for (const f of ['README.md', 'README.zh-CN.md', 'plugins/concord/README.md', 'plugins/concord/README.zh-CN.md', 'CHANGELOG.md', 'CHANGELOG.zh-CN.md', 'docs/verification.md']) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.match(text, /takeover/, f);
      assert.match(text, /0\.4\.0/, f);
      assert.match(text, /v0\.3\.0/, `${f}: released 0.3.0 history kept`);
    }
  });
});
