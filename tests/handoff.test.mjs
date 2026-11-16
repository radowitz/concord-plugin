// Consented Claude → Codex handoff tests (node --test), v0.4.0: limit classification, model routing, quota, proposal and consent.
// Offline and deterministic: fake codex/grok CLIs, a fake model catalog with invented slugs, temporary git
// repositories. No real limit, no real model, no network. Nothing here proves real provider behaviour.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, beforeEach, describe, test } from 'node:test';

import * as CX from '../plugins/concord/scripts/lib/codex-routing.mjs';
import * as HO from '../plugins/concord/scripts/lib/handoff.mjs';
import { Normalizer, codexStreamResult } from '../plugins/concord/scripts/lib/stream.mjs';
import {
  CATALOG, CLI, LEVELS, LIMIT, PLUGIN, ROOT, WRITE_DONE, app, approve, arg, calls, cleanup, cli, cliIn, count, decide, edit, file, fresh, handoff, model, nextSeq, patchRun, pending, planOf, prepare, quota, roles, runDirOf, runJson, scenario, sh, start, task,
} from './fixtures/concord_plugin/handoff-helpers.mjs';

let t;
after(cleanup);
beforeEach(() => { t = fresh(); });

describe('handoff review regressions', () => {
  test('hidden:true overrides visible metadata and cannot become an automatic or explicit writer', () => {
    const list = CX.whitelistModels({ models: [model('cx-hidden', 'Fast and affordable frontier workhorse.', 0, { hidden: true })] });
    assert.equal(list[0].visibility, 'hide');
    assert.equal(CX.routeTiers(list).high.model, 'account_default');
    assert.throws(() => CX.routeTiers(list, { low: { model: 'cx-hidden', effort: 'low' } }), /hidden/);
  });

  test('a catalog from a different provider cannot be reused for a ChatGPT takeover', () => {
    const id = pending();
    const cache = path.join(t.env.CONCORD_CACHE_DIR, 'codex-models.json');
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    const foreign = () => fs.writeFileSync(cache, JSON.stringify({ schema: 1, fetched_at: new Date().toISOString(), scope: 'cli_default', source: 'custom provider', models: CX.whitelistModels({ models: [model('foreign-fast', 'Fast model.', 0)] }) }));
    foreign();
    const p = prepare(id);
    assert.equal(p.code, 0, p.out + p.err);
    assert.equal(p.json.proposal.catalog.scope, CX.CHATGPT_SCOPE);
    assert.equal(p.json.proposal.routes.low.model, 'cx-quick');
    const probe = calls().find((c) => c.role === 'debug_models');
    assert.deepEqual(probe.argv.slice(2), CX.CHATGPT_ARGS);
    assert.deepEqual([probe.has_openai_key, probe.has_codex_key], [false, false]);
    foreign(); t.env.FAKE_CODEX_MODELS_FAIL = '1';
    const offline = prepare(id);
    assert.equal(offline.json.proposal.routes.low.model, 'account_default', 'unscoped data is not a last-good ChatGPT list');
    assert.equal(offline.json.proposal.routes.low.verified, false);
    assert.equal(count('codex_task'), 0);
  });

  test('string provider errors retain quota evidence; only failures are classified', () => {
    const norm = new Normalizer('codex');
    norm.push(JSON.stringify({ type: 'error', error: "You've hit your limit. Resets later." }));
    assert.match(codexStreamResult(norm).error, /hit your limit/);
    assert.equal(HO.classifyCodexFailure({ events: norm.errors }), 'codex_quota');
    assert.equal(HO.classifyCodexFailure({ stderr: "You've hit your limit", exited: false }), 'codex_quota');
    assert.equal(HO.classifyCodexFailure({ stderr: 'TypeError: undefined field' }), null);
  });
});


// ============================================================================ pure units

describe('limit classification (conservative, bounded)', () => {
  test('only a line that IS a limit statement counts; usage window and temporary rate limit stay apart', () => {
    for (const text of [LIMIT, 'Claude AI usage limit reached|1731625200', "You've hit your usage limit. Upgrade or try again later.", 'You’ve reached your weekly limit',
      '5-hour limit reached ∙ resets 3pm', 'Weekly limit reached', 'Opus weekly limit reached · resets Mon 9am', 'Limit reached · resets 3pm', "You're out of extra usage · resets 4pm",
      'Error: Claude usage limit reached', '  ⎿ API Error: You have exceeded your subscription limit', 'Your subscription usage limit has been reached']) {
      assert.equal(HO.classifyLimit(text).class, 'usage_window', text);
    }
    for (const text of ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}', '429 Too Many Requests',
      'Error: rate limit exceeded', 'Too many requests', 'You have been rate-limited', '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}']) {
      assert.equal(HO.classifyLimit(text).class, 'rate_limit', text);
    }
    assert.equal(HO.classifyLimit(`${LIMIT}\nAPI Error: 429 rate_limit_error`).class, 'usage_window', 'a usage statement wins over a co-reported 429');
  });

  test('auth, timeouts, connection errors, malformed output and failing work are never a limit', () => {
    const cases = { auth: ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'Not logged in. Please run /login', 'OAuth token has expired', 'Credit balance is too low'],
      timeout: ['Request timed out', 'Error: connect ECONNREFUSED 127.0.0.1:443', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', 'fetch failed', 'Connection error.'],
      unknown: ['', '   ', 'SyntaxError: Unexpected token } in JSON at position 4', '3 tests failed: expected done, got todo', 'The agent stopped.', 'Agent type concord:fable-worker not found'] };
    for (const [cls, list] of Object.entries(cases)) for (const text of list) assert.equal(HO.classifyLimit(text).class, cls, text);
  });

  test('a mention inside a task, sentence or code string is not provider evidence; parsing is bounded', () => {
    for (const text of ['Implement a banner that says "Claude usage limit reached" when the API returns 429', 'The worker said the usage limit reached message should be translated',
      'throw new Error("usage limit reached")', 'const MSG = `You\'ve hit your usage limit`;', 'if (err.type === "rate_limit_error") retry()', 'TODO: handle rate limit exceeded errors in fetchUser()',
      'Rate limit the signup endpoint to 5 requests per minute', 'Add a test for the 5-hour limit reached screen', 'docs: explain what "weekly limit reached" means']) {
      const c = HO.classifyLimit(text).class;
      assert.ok(!['usage_window', 'rate_limit'].includes(c), `${text} → ${c}`);
    }
    assert.equal(HO.classifyLimit(`${'noise line\n'.repeat(60)}${LIMIT}`).class, 'unknown', 'only the first 40 lines are examined');
    assert.equal(HO.classifyLimit(`${'x'.repeat(500)} ${LIMIT}`).class, 'unknown');
    assert.equal(HO.classifyLimit(undefined).class, 'unknown');
  });

  test('Codex writer failures are classified from provider error events; stderr counts only when the process failed', () => {
    assert.equal(HO.classifyCodexFailure({ events: ["You've hit your usage limit. Try again in 3 hours."] }), 'codex_quota');
    assert.equal(HO.classifyCodexFailure({ events: ['429 Too Many Requests'] }), 'codex_rate_limit');
    assert.equal(HO.classifyCodexFailure({ events: ['401 Unauthorized'] }), 'codex_auth');
    assert.equal(HO.classifyCodexFailure({ events: ['The model `cx-gone` does not exist or you do not have access to it.'] }), 'model_unavailable');
    assert.equal(HO.classifyCodexFailure({ events: ['stream disconnected'] }), null);
    assert.equal(HO.classifyCodexFailure({ events: [], stderr: 'usage limit', exited: false }), 'codex_quota', 'a failed stream may exit 0 while stderr carries the provider error');
    assert.equal(HO.classifyCodexFailure({ events: [], stderr: 'error: usage limit reached', exited: true }), 'codex_quota');
  });

  test('consent answers: only the literal words count; EOF, empty, yes and y are no decision', async () => {
    for (const [line, want] of [['approve', 'approve'], ['  APPROVE \r', 'approve'], ['decline', 'decline'], ['', null], ['y', null], ['yes', null], ['ok approve', null], ['approved', null], [undefined, null]]) {
      assert.equal(HO.parseConsentAnswer(line), want, JSON.stringify(line));
    }
    const ask = (feed) => { const input = new PassThrough(); const output = new PassThrough(); const p = HO.askConsent('? ', { input, output }); feed(input); return p; };
    assert.equal(await ask((i) => i.end()), null, 'EOF');
    assert.equal(await ask((i) => i.end('\n')), null, 'empty line');
    assert.equal(await ask((i) => i.end('yes\napprove\n')), null, 'only the first line is read');
    assert.equal(await ask((i) => i.end('approve\n')), 'approve');
  });
});

describe('Codex model metadata and tier routing', () => {
  test('whitelist keeps only declared fields: never base instructions or other prompt text', () => {
    const list = CX.whitelistModels({ models: [...CATALOG.models, { slug: 'bad id!' }, null, 'string', { slug: 'cx-work' }] });
    assert.deepEqual(list.map((m) => m.slug), CATALOG.models.map((m) => m.slug), 'invalid and duplicate entries dropped');
    assert.deepEqual(Object.keys(list[0]).sort(), ['apply_patch_tool_type', 'default_reasoning_level', 'description', 'display_name', 'priority', 'shell_type', 'slug', 'supported_reasoning_levels', 'tool_mode', 'visibility']);
    assert.deepEqual(list[0].supported_reasoning_levels, LEVELS);
    assert.doesNotMatch(JSON.stringify(list), /SECRET-BASE-INSTRUCTIONS|supported_in_api/);
    assert.equal(CX.whitelistModels({ models: [model('cx-long', 'x'.repeat(5000), 1)] })[0].description.length, 240);
    assert.deepEqual(CX.whitelistModels('nope'), []);
  });

  test('heuristic routes: description evidence, provider priority as tiebreak only, hidden/review/older entries not preferred, never by name', () => {
    const models = CX.whitelistModels(CATALOG);
    const r = CX.routeTiers(models);
    assert.deepEqual([r.low.model, r.normal.model, r.high.model], ['cx-quick', 'cx-work', 'cx-deep']);
    assert.deepEqual([r.low.effort, r.normal.effort, r.high.effort], ['low', 'medium', 'high']);
    for (const k of CX.CODEX_TIERS) { assert.equal(r[k].source, 'heuristic'); assert.match(r[k].basis, /^heuristic: the provider description mentions/); assert.match(r[k].effort_basis, /declared supported/); }
    assert.ok(!Object.values(r).some((x) => ['cx-secret', 'cx-auto-review', 'cx-plain', 'cx-quick-old', 'cx-work-old'].includes(x.model)));
    // Same descriptions, names chosen so that any name/version ordering would pick the other one: priority decides.
    const two = CX.whitelistModels({ models: [model('zz-1', 'Fast and affordable model.', 2), model('aa-99', 'Fast and affordable model.', 1)] });
    assert.equal(CX.routeTiers(two).low.model, 'aa-99');
    assert.equal(CX.routeTiers(CX.whitelistModels({ models: [model('aa-99', 'Fast and affordable model.', 9), model('zz-1', 'Fast and affordable model.', 3)] })).low.model, 'zz-1');
    // Only an "older" model has evidence: it is used, and labelled.
    const old = CX.routeTiers(CX.whitelistModels({ models: [model('cx-quick-old', 'Older fast and efficient model.', 1)] }));
    assert.equal(old.low.model, 'cx-quick-old');
    assert.match(old.low.basis, /older\/previous/);
  });

  test('no evidence → provider default with no --model; effort only when the model declares it', () => {
    const none = CX.routeTiers(CX.whitelistModels({ models: [model('cx-plain', 'A Codex model.', 1)] }));
    for (const k of CX.CODEX_TIERS) assert.deepEqual([none[k].model, none[k].effort, none[k].source, none[k].verified], ['account_default', null, 'provider_default', false]);
    assert.match(none.high.basis, /not chosen by Concord/);
    assert.equal(CX.routeTiers(null).low.source, 'provider_default');
    const narrow = (levels, def) => CX.routeTiers(CX.whitelistModels({ models: [model('cx-deep', 'Frontier model for demanding work.', 1, { supported_reasoning_levels: levels.map((effort) => ({ effort })), default_reasoning_level: def })] })).high;
    assert.equal(narrow(['low', 'medium'], 'medium').effort, 'medium', 'tier effort "high" not declared → the declared default');
    assert.match(narrow(['low', 'medium'], 'medium').effort_basis, /not declared for this model/);
    assert.equal(narrow(['ultra'], 'ultra').effort, null, 'an effort outside low|medium|high|xhigh is never passed');
    assert.equal(narrow([], null).effort, null);
  });

  test('manual overrides are validated against the list; without a list they are accepted as UNVERIFIED', () => {
    const models = CX.whitelistModels(CATALOG);
    const ov = CX.parseRouteOverrides('low=cx-work@low, high=cx-deep@xhigh');
    assert.deepEqual(ov, { low: { model: 'cx-work', effort: 'low' }, high: { model: 'cx-deep', effort: 'xhigh' } });
    const r = CX.routeTiers(models, ov);
    assert.deepEqual([r.low.model, r.low.effort, r.low.source, r.low.verified], ['cx-work', 'low', 'override', true]);
    assert.deepEqual([r.high.model, r.high.effort], ['cx-deep', 'xhigh']);
    assert.equal(r.normal.source, 'heuristic', 'tiers without an override keep the heuristic');
    assert.throws(() => CX.routeTiers(models, { low: { model: 'cx-made-up', effort: null } }), /not in the account list/);
    assert.throws(() => CX.routeTiers(models, { low: { model: 'cx-secret', effort: null } }), /hidden, internal or review-only/);
    assert.throws(() => CX.routeTiers(models, { low: { model: 'cx-auto-review', effort: null } }), /hidden, internal or review-only/);
    const few = CX.whitelistModels({ models: [model('cx-few', 'Fast model.', 1, { supported_reasoning_levels: [{ effort: 'low' }] })] });
    assert.throws(() => CX.routeTiers(few, { low: { model: 'cx-few', effort: 'xhigh' } }), /does not declare effort "xhigh"/);
    for (const bad of ['low', 'mid=cx-work', 'low=cx-work@ultra', 'low=cx-work@max', 'low=a,low=b', 'low=bad id', 'low=', 'x'.repeat(700)]) assert.throws(() => CX.parseRouteOverrides(bad), /--codex-routes/, bad);
    const blind = CX.routeTiers(null, { high: { model: 'cx-anything', effort: 'high' } });
    assert.deepEqual([blind.high.model, blind.high.verified], ['cx-anything', false]);
    assert.match(blind.high.basis, /NOT verified/);
  });

  test('discovery: 24 h TTL without a CLI call, bounded refresh, last good kept and flagged stale on failure', async () => {
    const saved = { ...process.env };
    try {
      process.env.CONCORD_CACHE_DIR = t.env.CONCORD_CACHE_DIR;
      const bin = t.env.CONCORD_CODEX_BIN; const now = Date.parse('2026-11-16T00:00:00Z');
      const first = await CX.ensureMetadata(bin, { env: t.env, now });
      assert.equal(first.state, 'refreshed');
      assert.equal(first.cache.models.length, CATALOG.models.length);
      assert.equal(first.cache.source, 'local CLI: codex debug models');
      assert.doesNotMatch(fs.readFileSync(CX.metadataFile(), 'utf8'), /SECRET-BASE-INSTRUCTIONS/);
      assert.equal((await CX.ensureMetadata(bin, { env: t.env, now: now + CX.TTL_MS - 1000 })).state, 'fresh');
      assert.equal(count('debug_models'), 1, 'within the TTL the cache is used without a CLI call');
      const failed = await CX.ensureMetadata(bin, { env: { ...t.env, FAKE_CODEX_MODELS_FAIL: '1' }, now: now + CX.TTL_MS + 1000 });
      assert.deepEqual([failed.state, failed.stale], ['failed', true]);
      assert.equal(failed.cache.models.length, CATALOG.models.length, 'last good list kept');
      assert.equal(failed.cache.fetched_at, first.cache.fetched_at);
      assert.match(failed.cache.last_failure.error, /exit 1/);
      const info = CX.catalogInfo(failed);
      assert.deepEqual([info.stale, info.refresh, info.listed_models], [true, 'failed', 6]);
      fs.rmSync(CX.metadataFile());
      const none = await CX.ensureMetadata(bin, { env: { ...t.env, FAKE_CODEX_MODELS_FAIL: '1' }, now });
      assert.deepEqual([none.state, none.cache, none.stale], ['failed', null, true]);
      assert.match(CX.catalogInfo(none).note, /nothing can be verified/);
      fs.writeFileSync(t.catalog, '{"models": "garbage"}');
      assert.match((await CX.ensureMetadata(bin, { env: t.env, now })).error, /no model list recognised/);
    } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  });
});

// ============================================================================ quota report → paused

describe('Claude limit report (quota) and the paused state', () => {
  test('a usage limit pauses the run and offers the question; nothing is spawned, switched or retried', () => {
    const s = start();
    assert.equal(s.json.claude_limit.on_claude_limit, 'ask');
    assert.equal(s.json.claude_limit.takeover_terminal, `node ${CLI} takeover ${s.json.run} --writer-stopped --drive --repo ${t.repo}`, 'literal argv with the absolute helper path and --repo');
    const id = s.json.run;
    const a = cli('advance', id);
    assert.equal(a.json.on_limit.on_claude_limit, 'ask');
    assert.deepEqual(a.json.on_limit.report.slice(0, 7), ['node', CLI, 'quota', id, '--step', 'task-T1', '--revision']);
    edit('half written\n'); // the interrupted worker's partial edit
    const before = calls().length;
    const q = quota(id);
    assert.equal(q.code, 0, q.out + q.err);
    assert.deepEqual([q.json.action, q.json.status, q.json.offer_switch], ['await_switch', 'paused', true]);
    assert.deepEqual([q.json.pause.kind, q.json.pause.provider, q.json.pause.class, q.json.pause.source, q.json.pause.step], ['claude_limit', 'claude', 'usage_window', 'native_report', 'task-T1']);
    assert.equal(q.json.pause.report, LIMIT);
    assert.deepEqual(q.json.pause.preserved.changed_paths, ['app.txt']);
    assert.match(q.json.message, /ASK them/);
    assert.equal(q.json.agent, undefined, 'no native agent call is exposed while paused');
    assert.equal(q.json.done, undefined);
    const run = runJson(id);
    assert.deepEqual([run.status, run.repairs_used, run.failure, run.handoff ?? null], ['paused', 0, null, null]);
    // advance on a paused run: a human-control action, no spawn, no retry, no late native report.
    assert.equal(cli('advance', id).json.action, 'await_switch');
    assert.equal(cli('advance', id, '--one-step').json.status, 'paused');
    assert.equal(cli('drive', id).json.drive.stopped_because, 'await_switch');
    for (const extra of [['--done', 'task-T1', '--revision', '1'], ['--failed', 'task-T1', '--revision', '1', '--note-file', file('x')], ['--retry']]) {
      assert.equal(cli('advance', id, ...extra).json.error, 'paused', extra.join(' '));
    }
    assert.equal(calls().length, before, 'no CLI was called');
    assert.equal(app(), 'half written\n', 'partial edit left exactly as it was');
    assert.equal(sh(t.repo, 'stash', 'list'), '');
    const st = cli('status', id);
    assert.match(st.out, /PAUSED \(claude_limit\/usage_window; claude; source native_report\) at task-T1/);
    assert.match(st.out, new RegExp(`node ${CLI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} takeover ${id} --writer-stopped --drive --repo`));
    assert.equal(cli('quota', id, '--step', 'task-T1', '--revision', '1', '--note-file', file(LIMIT)).json.error, 'paused', 'already paused');
  });

  test('on_claude_limit: stop pauses without offering; it is validated; an explicit human takeover is still possible', () => {
    assert.equal(start({ on_claude_limit: 'auto' }).json.error, 'spec');
    assert.equal(start({ on_claude_limit: true }).json.error, 'spec');
    const id = pending({ on_claude_limit: 'stop' });
    assert.equal(runJson(id).on_claude_limit, 'stop');
    const q = quota(id);
    assert.deepEqual([q.json.action, q.json.offer_switch, q.json.status], ['paused', false, 'paused']);
    assert.match(q.json.message, /on_claude_limit: stop[\s\S]*Do not offer a switch/);
    assert.equal(runJson(id).handoff, undefined);
    const p = prepare(id);
    assert.equal(p.code, 0, p.out + p.err);
    assert.equal(p.json.consent, 'none');
    assert.equal(runJson(id).status, 'paused', 'a proposal is not consent');
  });

  test('a temporary rate limit pauses with wait/resume guidance and no offer; resume --claude hands the step back', () => {
    const id = pending();
    const q = quota(id, 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Please try again later."}}');
    assert.deepEqual([q.json.action, q.json.offer_switch, q.json.pause.class], ['paused', false, 'rate_limit']);
    assert.match(q.json.message, /temporary rate limit[\s\S]*wait, then resume_claude/);
    assert.equal(cli('resume', id, '--retry-codex').json.error, 'usage', 'not a Codex pause');
    const r = cli('resume', id, '--claude');
    assert.deepEqual([r.json.action, r.json.step, r.json.status], ['implement', 'task-T1', 'awaiting_session']);
    assert.equal(runJson(id).pause, null);
    assert.equal(cli('resume', id, '--claude').json.error, 'not_paused');
    edit();
    const fin = cli('advance', id, '--done', 'task-T1', '--executor', 'subagent', '--revision', '1');
    assert.equal(fin.json.status, 'validated', fin.out);
    const ap = cli('approve', id, '--decision', 'approve');
    assert.equal(ap.json.approval.outcome_ledger.recorded, false);
    assert.match(ap.json.approval.outcome_ledger.reason, /paused/, 'a run that hit a limit is never a clean Claude sample');
  });

  test('auth errors, timeouts, connection errors, malformed output and failing tests are refused: nothing is recorded', () => {
    const id = pending({ request: 'Show "Claude usage limit reached" in app.txt when the quota is exhausted' });
    assert.equal(runJson(id).status, 'awaiting_session', 'a usage-limit phrase in the request triggers nothing');
    for (const text of ['API Error: 401 authentication_error', 'Request timed out', 'connect ECONNREFUSED', 'SyntaxError: Unexpected end of JSON input', '2 tests failed', 'The subagent wrote: throw new Error("usage limit reached")', '']) {
      const q = quota(id, text);
      assert.equal(q.code, 2, text);
      assert.equal(q.json.error, text ? 'not_a_limit' : 'usage', text);
    }
    const run = runJson(id);
    assert.deepEqual([run.status, run.pause ?? null, run.pauses ?? null], ['awaiting_session', null, null]);
    assert.equal(cli('advance', id).json.action, 'implement');
  });

  test('quota is bound to the pending step, the revision, the worktree and the lock', () => {
    const id = pending();
    assert.equal(quota(id, LIMIT, 'task-T9').json.error, 'usage');
    assert.equal(quota(id, LIMIT, 'task-T1', '7').json.error, 'stale_revision');
    assert.equal(cli('quota', id, '--revision', '1', '--note-file', file(LIMIT)).json.error, 'usage');
    const other = path.join(t.root, 'wt');
    sh(t.repo, 'worktree', 'add', '-q', '-b', 'side', other);
    const before = fs.readFileSync(path.join(runDirOf(id), 'run.json'), 'utf8');
    for (const args of [['quota', id, '--step', 'task-T1', '--revision', '1', '--note-file', file(LIMIT)], ['takeover', id, '--writer-stopped', '--json'], ['takeover', id, '--proposal', 'hp-0123456789abcdef', '--decision', 'approve', '--writer-stopped'],
      ['drive', id], ['resume', id, '--claude']]) {
      assert.equal(cliIn(other, args).json.error, 'wrong_worktree', args.join(' '));
    }
    assert.equal(fs.readFileSync(path.join(runDirOf(id), 'run.json'), 'utf8'), before, 'nothing written from the wrong worktree');
    assert.deepEqual(roles().filter((x) => ['login_status', 'debug_models'].includes(x)), [], 'no login probe or model discovery from the wrong worktree');
    const lock = path.join(t.repo, '.git/concord/lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), run: id }));
    for (const args of [['quota', id, '--step', 'task-T1', '--revision', '1', '--note-file', file(LIMIT)], ['takeover', id, '--writer-stopped', '--json'], ['drive', id]]) {
      assert.equal(cli(...args).json.error, 'locked', args.join(' '));
    }
    fs.unlinkSync(lock);
    assert.deepEqual(roles().filter((x) => ['login_status', 'debug_models'].includes(x)), [], 'a live helper blocks the handoff before any CLI call');
    assert.equal(runJson(id).status, 'awaiting_session');
  });
});

// ============================================================================ proposal and consent

describe('takeover proposal and durable consent', () => {
  test('prepare shows the frozen table with source and time; without a terminal it never reads stdin; a proposal is not consent', () => {
    scenario(planOf([task('T1'), task('T2', { depends_on: ['T1'], difficulty: 'medium', risk: 'medium' }), task('T3', { depends_on: ['T2'], difficulty: 'high' })]));
    const id = pending();
    quota(id);
    // stdin carries "approve": it must be ignored (not a TTY), with and without --json.
    const p = cliIn(t.repo, ['takeover', id, '--writer-stopped'], { input: 'approve\napprove\n' });
    assert.equal(p.code, 0, p.out + p.err);
    assert.deepEqual([p.json.action, p.json.consent, p.json.status], ['await_switch', 'none', 'paused']);
    const pr = p.json.proposal;
    assert.match(pr.id, /^hp-[a-f0-9]{16}$/);
    assert.deepEqual(CX.CODEX_TIERS.map((k) => `${k}=${pr.routes[k].model}@${pr.routes[k].effort}`), ['low=cx-quick@low', 'normal=cx-work@medium', 'high=cx-deep@high']);
    assert.deepEqual(pr.remaining.tasks.map((x) => `${x.id}:${x.tier}:${x.model}`), ['T1:low:cx-quick', 'T2:normal:cx-work', 'T3:high:cx-deep']);
    assert.deepEqual([pr.catalog.source, pr.catalog.refresh, pr.catalog.stale], ['local CLI: codex debug models', 'refreshed', false]);
    assert.ok(Date.parse(pr.catalog.fetched_at));
    assert.deepEqual([pr.reason.source, pr.reason.class, pr.login.method], ['native_report', 'usage_window', 'chatgpt']);
    assert.deepEqual(pr.writer, { provider: 'codex', login: 'chatgpt', sandbox: 'workspace-write', approval_policy: 'never', network_access: false });
    assert.equal(pr.binding, undefined); assert.equal(pr.nonce, undefined);
    for (const re of [/Frozen Codex coding model table/, /low\s+→ cx-quick @ low\s+\[heuristic\]/, /not a benchmark|heuristic/, /It is not approval of the result/, /cannot see or stop a native Claude writer/, /not an operating-system guarantee/, /pattern-matched from the reported text, not verified/]) assert.match(p.json.text, re);
    assert.deepEqual(p.json.approve, ['node', CLI, 'takeover', id, '--proposal', pr.id, '--decision', 'approve', '--writer-stopped', '--repo', t.repo]);
    const run = runJson(id);
    assert.deepEqual([run.status, run.handoff.status, run.handoff.consent ?? null, run.handoff.proposal.status], ['paused', 'proposed', null, 'proposed']);
    assert.deepEqual(roles().slice(-2), ['login_status', 'debug_models']);
    assert.equal(count('codex_task'), 0);
    assert.equal(cli('drive', id).json.action, 'await_switch', 'drive never consents');
    assert.equal(count('codex_task'), 0);
    // A second prepare within the TTL reuses the cached list (no discovery call) and supersedes the first proposal.
    const p2 = prepare(id);
    assert.equal(count('debug_models'), 1);
    assert.equal(p2.json.proposal.catalog.refresh, 'fresh');
    assert.equal(approve(id, pr.id).json.error, 'stale_proposal', 'only the current proposal can be approved');
    assert.equal(runJson(id).handoff.consent ?? null, null);
  });

  test('the stopped-writer acknowledgement and a bound proposal id are required; nothing is inferred', () => {
    const id = pending();
    quota(id);
    assert.equal(cli('takeover', id, '--json').json.error, 'writer_may_be_active');
    assert.equal(count('login_status'), 0, 'refused before any CLI call');
    assert.equal(cli('takeover', id, '--decision', 'approve', '--writer-stopped').json.error, 'usage', 'approve without a proposal id');
    assert.equal(decide(id, 'hp-0123456789abcdef', 'approve', '--writer-stopped').json.error, 'stale_proposal', 'no proposal prepared');
    const p = prepare(id).json.proposal;
    assert.equal(decide(id, p.id, 'approve').json.error, 'writer_may_be_active');
    assert.equal(decide(id, p.id, 'yes', '--writer-stopped').json.error, 'usage');
    assert.equal(cli('takeover', id, '--proposal', p.id, '--writer-stopped').json.error, 'usage', 'a proposal id alone is not a decision');
    assert.equal(decide(id, 'hp-ffffffffffffffff', 'approve', '--writer-stopped').json.error, 'stale_proposal');
    assert.equal(decide(id, '../x', 'approve', '--writer-stopped').json.error, 'usage');
    const run = runJson(id);
    assert.deepEqual([run.status, run.handoff.status, run.handoff.consent ?? null], ['paused', 'proposed', null]);
    assert.equal(count('codex_task'), 0);
    const a = approve(id, p.id);
    assert.deepEqual([a.json.consented, a.json.action, a.json.status, a.json.owner], [true, 'continue', 'active', 'codex (approved handoff)']);
    assert.equal(a.json.agent, undefined); assert.equal(a.json.done, undefined);
    assert.deepEqual([a.json.next_stage.step, a.json.next_stage.role, a.json.next_stage.model, a.json.next_stage.effort], ['task-T1', 'codex_task', 'cx-quick', 'low']);
    assert.equal(a.json.drive_terminal, `node ${CLI} drive ${id} --repo ${t.repo}`);
    const h = runJson(id).handoff;
    assert.deepEqual([h.status, h.consent.proposal, h.consent.writer_stopped_ack, h.consent.by], ['active', p.id, true, 'explicit --decision on the command line']);
    assert.match(h.consent.note, /cannot tell who typed it and cannot verify that the native writer stopped/);
    assert.equal(count('codex_task'), 0, 'consent alone starts no writer');
    assert.equal(approve(id, p.id).json.error, 'stale_proposal', 'a proposal is decided once');
    assert.equal(prepare(id).json.error, 'handoff_active');
  });

  test('decline keeps the run open and paused; a declined proposal can never be approved; consent needs a new proposal', () => {
    const id = pending();
    quota(id);
    const p = prepare(id).json.proposal;
    const d = decide(id, p.id, 'decline');
    assert.deepEqual([d.json.consented, d.json.action, d.json.status, d.json.offer_switch], [false, 'paused', 'paused', false]);
    assert.match(d.json.message, /declined the Codex handoff/);
    assert.equal(approve(id, p.id).json.error, 'stale_proposal');
    assert.equal(cli('drive', id).json.action, 'paused');
    const run = runJson(id);
    assert.deepEqual([run.status, run.handoff.status, run.handoff.consent ?? null], ['paused', 'declined', null]);
    assert.equal(count('codex_task'), 0);
    assert.equal(cli('cancel', id).json.status, 'cancelled', 'the original run was not cancelled by declining; cancel is separate');
    const id2 = pending();
    quota(id2);
    decide(id2, prepare(id2).json.proposal.id, 'decline');
    scenario({ codex_task: [WRITE_DONE] });
    handoff(id2); // the user changes their mind: a NEW proposal, explicitly approved
    assert.equal(cli('drive', id2).json.status, 'validated');
  });

  test('approval is bound to the exact checkout, index, HEAD, revision and model table shown', () => {
    const id = pending();
    quota(id);
    const stale = (mutate, re) => {
      const p = prepare(id).json.proposal;
      mutate();
      const a = approve(id, p.id);
      assert.equal(a.json.error, 'stale_proposal', a.out);
      assert.match(a.json.message, re);
      const run = runJson(id);
      assert.deepEqual([run.handoff.proposal.status, run.handoff.consent ?? null, run.status], ['stale', null, 'paused']);
      assert.equal(approve(id, p.id).json.error, 'stale_proposal', 'a stale proposal stays stale');
    };
    stale(() => edit('changed after the proposal\n'), /checkout \(files, HEAD, branch, stash or staged index\) changed/);
    stale(() => sh(t.repo, 'add', 'app.txt'), /checkout/);
    stale(() => { fs.writeFileSync(path.join(t.repo, 'other.txt'), 'x'); sh(t.repo, 'add', 'other.txt'); sh(t.repo, 'commit', '-qm', 'user commit'); }, /checkout/);
    stale(() => patchRun(id, (r) => { r.handoff.proposal.routes.high.model = 'cx-swapped'; }), /model routes/);
    stale(() => patchRun(id, (r) => { r.tasks[0].files.push('extra.txt'); }), /task plan/);
    stale(() => { const am = cli('amend', id, '--spec', file(JSON.stringify({ kind: 'clarify', text: 'Use lower case' }), 'json')); assert.equal(am.code, 0, am.out + am.err); }, /is stale|revision|no longer/);
    assert.equal(count('codex_task'), 0);
    assert.equal(runJson(id).revision, 2);
    scenario({ codex_task: [WRITE_DONE] });
    handoff(id);
    const d = cli('drive', id);
    assert.equal(d.json.status, 'validated', d.out);
    assert.match(calls().find((c) => c.role === 'codex_task').argv.join(' '), /--model cx-quick/);
  });

  test('a checkout that changes after consent but before the first writer needs a fresh proposal: no spawn', () => {
    const id = pending();
    quota(id);
    handoff(id);
    edit('someone edited after consent\n');
    const d = cli('drive', id);
    assert.deepEqual([d.json.action, d.json.status, d.json.pause.kind], ['await_switch', 'paused', 'checkout_changed']);
    assert.equal(count('codex_task'), 0);
    assert.equal(runJson(id).handoff.status, 'invalidated');
    assert.equal(cli('resume', id, '--retry-codex').json.error, 'consent_required');
    assert.equal(cli('drive', id).json.action, 'await_switch');
    assert.equal(count('codex_task'), 0);
    scenario({ codex_task: [WRITE_DONE] });
    handoff(id);
    assert.equal(cli('drive', id).json.status, 'validated');
    assert.equal(count('codex_task'), 1);
  });

  test('a human can request a handoff from a terminal with no machine limit report (source user / human_report)', () => {
    const id = pending();
    const p = prepare(id);
    assert.equal(p.code, 0, p.out + p.err);
    assert.deepEqual([p.json.proposal.reason.source, p.json.proposal.reason.class, p.json.status], ['user', null, 'awaiting_session']);
    assert.match(p.json.text, /requested by you from the terminal \(no machine limit report\)/);
    const p2 = prepare(id, '--note-file', file('my Claude window says: limit reached, come back at 3pm'));
    assert.equal(p2.json.proposal.reason.source, 'human_report');
    assert.match(p2.json.proposal.reason.verified, /not machine-verified/);
    assert.match(p2.json.text, /your own report of the Claude error \(not machine-verified\)/);
    assert.equal(runJson(id).status, 'awaiting_session', 'still Claude\'s step until an explicit approve');
    assert.equal(cli('advance', id).json.action, 'implement');
    scenario({ codex_task: [WRITE_DONE] });
    assert.equal(approve(id, p2.json.proposal.id).json.consented, true);
    assert.equal(cli('drive', id).json.status, 'validated');
    assert.equal(runJson(id).handoff.reason.source, 'human_report');
  });

  test('takeover recovers only a pending native task/repair: not a review rejection, a spent repair budget or a dead helper stage', () => {
    scenario({ review: [{ verdict: 'reject', summary: 'unsafe', concerns: [], required_changes: [] }] });
    const rej = start().json.run;
    assert.equal(cli('advance', rej).json.action, 'failed');
    assert.equal(prepare(rej).json.error, 'not_recoverable');
    cli('cancel', rej);

    const id = pending({ limits: { max_repairs: 1 } });
    edit('wrong\n');
    assert.equal(cli('advance', id, '--done', 'task-T1', '--revision', '1').json.action, 'repair');
    edit('still wrong\n');
    assert.match(cli('advance', id, '--done', 'repair-1', '--revision', '1').json.failure.error, /repair budget exhausted/);
    const p = prepare(id);
    assert.equal(p.json.error, 'not_recoverable');
    assert.equal(count('login_status'), 0, 'refused before any CLI call');
    cli('cancel', id);

    // A helper stage left running by a dead helper: reported, not re-run, not taken over.
    const dead = start().json.run;
    patchRun(dead, (r) => { r.steps.push({ id: 'proposal', attempt: 1, role: 'proposal', label: 'x', provider: 'codex', status: 'running', started_at: new Date().toISOString() }); });
    const before = calls().length;
    const st = prepare(dead);
    assert.equal(st.json.error, 'stale_helper');
    assert.deepEqual(st.json.interrupted, ['proposal']);
    assert.equal(calls().length, before, 'the planner was not silently re-run');
    assert.equal(runJson(dead).steps.at(-1).status, 'interrupted');
    assert.equal(cli('drive', dead).json.action, 'failed', 'drive never retries by itself');
    assert.equal(calls().length, before);
    cli('cancel', dead);

    // A failure the Claude session itself reported for the pending step can be handed over.
    const nat = pending();
    assert.equal(cli('advance', nat, '--failed', 'task-T1', '--revision', '1', '--note-file', file('agent could not start')).json.action, 'failed');
    scenario({ codex_task: [WRITE_DONE] });
    handoff(nat);
    assert.deepEqual([runJson(nat).status, runJson(nat).failure], ['active', null]);
    assert.equal(cli('drive', nat).json.status, 'validated');
  });

  test('a run saved before 0.4.0 can be handed over explicitly without being reset', () => {
    const id = pending();
    patchRun(id, (r) => { r.version = '0.2.2'; delete r.on_claude_limit; delete r.routing; for (const x of r.tasks) { delete x.route; delete x.computed_tier; } });
    const stepsBefore = runJson(id).steps.length;
    scenario({ codex_task: [WRITE_DONE] });
    const p = handoff(id);
    assert.equal(p.reason.source, 'user');
    const d = cli('drive', id);
    assert.equal(d.json.status, 'validated', d.out);
    const run = runJson(id);
    assert.deepEqual([run.version, run.id, run.baseline.head, run.request], ['0.2.2', id, sh(t.repo, 'rev-parse', 'HEAD').trim(), 'Make app.txt say done']);
    assert.deepEqual(run.steps.slice(0, stepsBefore).map((x) => x.id), ['proposal', 'review', 'plan'], 'earlier stage history kept');
    assert.equal(cli('status', id, '--json').json.claude_limit.on_claude_limit, 'ask');
  });
});

// ============================================================================ Codex login and billing

describe('Codex login: ChatGPT only, never API billing', () => {
  test('login warning noise is ignored, but conflicting and nonzero status never grants access', () => {
    const id = pending();
    t.env.FAKE_CODEX_LOGIN = 'warning';
    assert.equal(prepare(id).code, 0, 'a harmless warning before the ChatGPT line must not block a proposal');
    for (const mode of ['conflict', 'nonzero']) {
      t.env.FAKE_CODEX_LOGIN = mode;
      assert.equal(prepare(id).json.error, 'codex_auth', mode);
    }
    assert.equal(count('codex_task'), 0, 'login checks never authorize coding');
  });
  test('API-key, missing and unrecognised logins are refused before a proposal exists; no key is stored', () => {
    const id = pending();
    quota(id);
    for (const [mode, re] of [['api', /API-key login/], ['none', /not logged in/], ['garbage', /no recognised answer/]]) {
      t.env.FAKE_CODEX_LOGIN = mode;
      const p = prepare(id);
      assert.deepEqual([p.code, p.json.error], [2, 'codex_auth'], mode);
      assert.match(p.json.message, re);
      assert.match(p.json.message, /API-key billing is never used/);
    }
    assert.equal(runJson(id).handoff, undefined);
    assert.equal(count('debug_models'), 0, 'no discovery after a refused login');
    assert.doesNotMatch(fs.readFileSync(path.join(runDirOf(id), 'run.json'), 'utf8'), /sk-fake|sk-test/);
  });

  test('every handoff call runs without API keys; the writer is workspace-write with approvals never, network off and ChatGPT forced; QA stays read-only', () => {
    const id = pending();
    quota(id);
    scenario({ codex_task: [WRITE_DONE] });
    handoff(id);
    assert.equal(cli('drive', id).json.status, 'validated');
    const c = calls();
    for (const x of c.filter((y) => ['login_status', 'debug_models', 'codex_task', 'qa'].includes(y.role))) assert.deepEqual([x.has_openai_key, x.has_codex_key], [false, false], x.role);
    const w = c.find((x) => x.role === 'codex_task').argv;
    assert.equal(arg(w, '--sandbox'), 'workspace-write');
    assert.equal(arg(w, '-C'), t.repo);
    const cfg = w.filter((_, i) => w[i - 1] === '-c');
    assert.deepEqual(cfg, ['approval_policy="never"', 'sandbox_workspace_write.network_access=false', 'forced_login_method="chatgpt"', 'model_provider="openai"', 'model_reasoning_effort="low"']);
    assert.deepEqual([arg(w, '--model'), w.at(-1), w.includes('--json'), w.includes('--output-schema')], ['cx-quick', '-', true, true]);
    for (const banned of ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', 'danger-full-access', '--approve-for-me', '--trust', '--add-dir', '--skip-git-repo-check']) assert.ok(!w.includes(banned), banned);
    const qa = c.find((x) => x.role === 'qa').argv;
    assert.deepEqual([arg(qa, '--sandbox'), qa.includes('--ephemeral')], ['read-only', true], 'QA permissions remain read-only');
    assert.deepEqual(qa.filter((_, i) => qa[i - 1] === '-c'), CX.CHATGPT_ARGS.filter((_, i) => i % 2 === 1), 'QA also forces ChatGPT/OpenAI; no API billing');
    assert.equal(c.find((x) => x.role === 'review').provider, 'grok');
    assert.ok(c.findIndex((x) => x.role === 'qa') > c.findIndex((x) => x.role === 'codex_task'), 'a fresh QA runs after the writer');
    assert.doesNotMatch(JSON.stringify(runJson(id)), /sk-test-must-be-stripped/);
  });

  test('a login that stops being ChatGPT after consent pauses before the writer is spawned', () => {
    const id = pending();
    quota(id);
    handoff(id);
    t.env.FAKE_CODEX_LOGIN = 'api';
    const d = cli('drive', id);
    assert.deepEqual([d.json.action, d.json.status, d.json.pause.kind, d.json.pause.class], ['paused', 'paused', 'codex_auth', 'auth']);
    assert.equal(count('codex_task'), 0);
    assert.equal(runJson(id).tasks[0].status, 'pending');
    delete t.env.FAKE_CODEX_LOGIN;
    scenario({ codex_task: [WRITE_DONE] });
    assert.equal(cli('drive', id).json.action, 'paused', 'no automatic retry once the login is fixed');
    assert.equal(count('codex_task'), 0);
    assert.equal(cli('resume', id, '--retry-codex').json.action, 'continue');
    assert.equal(cli('drive', id).json.status, 'validated');
  });
});
