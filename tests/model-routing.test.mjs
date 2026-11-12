// Model routing tests (node --test): published-alias discovery, routing profile, frozen per-run
// routing, packaged pinned agents, explicit fallback and the advisory outcome ledger.
// Offline and deterministic: fixtures and injected fetches only; never a real HTTP request or model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as D from '../plugins/concord/scripts/lib/discovery.mjs';
import * as R from '../plugins/concord/scripts/lib/routing.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '../plugins/concord');
const CLI = path.join(PLUGIN, 'scripts/concord.mjs');
const FAKE = path.join(HERE, 'fixtures/concord_plugin/fake-provider.mjs');
const DOCS = path.join(HERE, 'fixtures/concord_plugin/model-config.md');
const DOCS_TEXT = fs.readFileSync(DOCS, 'utf8');
const TEST_OK = [process.execPath, '-e', "process.exit(require('fs').readFileSync('app.txt','utf8').trim()==='done'?0:1)"];
const temps = [];
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

let t;

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'concord-routing-test-')));
  temps.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.invalid');
  sh(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'todo\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'init');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const p of ['codex', 'grok']) fs.writeFileSync(path.join(bin, p), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${p} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONCORD_CODEX_BIN: path.join(bin, 'codex'), CONCORD_GROK_BIN: path.join(bin, 'grok'),
    CONCORD_CACHE_DIR: path.join(root, 'cache'), CONCORD_MODEL_DISCOVERY: 'off', FAKE_CALLS: path.join(root, 'calls.jsonl'), FAKE_SCENARIO: path.join(root, 'scenario.json') };
  delete env.CONCORD_STATE_DIR; delete env.CONCORD_CLAUDE_DOCS_FIXTURE; delete env.CONCORD_CLAUDE_DOCS_LOG;
  return { root, repo, env };
}

function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: t.repo, env: t.env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const scenario = (obj) => { fs.writeFileSync(t.env.FAKE_SCENARIO, JSON.stringify(obj)); fs.rmSync(`${t.env.FAKE_SCENARIO}.count.json`, { force: true }); };
const write = (name, value) => { const f = path.join(t.root, name); fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value)); return f; };
const start = (spec = {}) => cli('start', '--spec', write(`spec-${Math.random().toString(16).slice(2)}.json`, { request: 'Make app.txt say done', tests: [TEST_OK], ...spec }));
const edit = (content = 'done\n') => fs.writeFileSync(path.join(t.repo, 'app.txt'), content);
const runFile = (id) => path.join(t.repo, '.git/concord/runs', id, 'run.json');
const runJson = (id) => JSON.parse(fs.readFileSync(runFile(id), 'utf8'));
const planOf = (risk = 'low', difficulty = 'low', extra = []) => ({ plan: [{ summary: 'p', tasks: [
  { id: 'T1', title: 'work', description: 'do it', files: ['app.txt'], depends_on: [], difficulty, risk }, ...extra] }] });
const cache = (name) => path.join(t.env.CONCORD_CACHE_DIR, name);
const fetchCount = () => { try { return fs.readFileSync(t.env.CONCORD_CLAUDE_DOCS_LOG, 'utf8').trim().split('\n').length; } catch { return 0; } };
/** Turn on discovery for CLI subprocesses, served from the offline fixture and counted in a log. */
const online = (fixture = DOCS) => Object.assign(t.env, { CONCORD_MODEL_DISCOVERY: 'on', CONCORD_CLAUDE_DOCS_FIXTURE: fixture, CONCORD_CLAUDE_DOCS_LOG: path.join(t.root, 'fetch.log') });

beforeEach(() => {
  t = sandbox();
  // In-process library calls use the same sandboxed cache; HTTP stays off unless a test injects a fetch.
  process.env.CONCORD_CACHE_DIR = t.env.CONCORD_CACHE_DIR;
  delete process.env.CONCORD_MODEL_DISCOVERY; delete process.env.CONCORD_CLAUDE_DOCS_FIXTURE; delete process.env.CONCORD_CLAUDE_DOCS_LOG;
});

// ------------------------------------------------------------------ discovery

describe('published-alias parser', () => {
  test('takes plain family rows from the alias table only; rejects special modes, expressions, [1m] and prose', () => {
    const p = D.parseModelDocs(DOCS_TEXT);
    assert.deepEqual(p.aliases.map((a) => a.alias), ['fable', 'sonnet', 'opus', 'haiku']);
    assert.deepEqual(p.anthropic_api_resolution, { opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5' });
    for (const junk of ['default', 'best', 'opusplan', 'sonnet[1m]', 'mythos', 'claude-mythos-9']) assert.ok(!p.aliases.some((a) => a.alias === junk), junk);
  });

  test('a newly published family row is discovered as a candidate; junk pages are rejected', () => {
    const withNew = DOCS_TEXT.replace('| **`sonnet`** |', '| **`mythos`** | Uses the Mythos model for research tasks |\n| **`sonnet`** |');
    assert.ok(D.parseModelDocs(withNew).aliases.some((a) => a.alias === 'mythos'));
    // A row whose text does not describe its own family, or that points at another alias, is not accepted.
    const odd = DOCS_TEXT.replace('| **`sonnet`** |', '| **`turbo`** | Uses the same model as `opus` |\n| **`zippy`** | Uses the fastest thing available |\n| **`sonnet`** |');
    assert.deepEqual(D.parseModelDocs(odd).aliases.map((a) => a.alias), ['fable', 'sonnet', 'opus', 'haiku']);
    assert.throws(() => D.parseModelDocs('<html>login required</html>'), /not the model-config page/);
    assert.throws(() => D.parseModelDocs('| Model alias | Behavior |\n| - | - |\n| **`default`** | Special value |\n'), /no alias rows/);
    assert.throws(() => D.parseModelDocs(undefined), /not the model-config page/);
  });
});

function fakeRequest(script) {
  const seen = [];
  const fn = (url, _opts, cb) => {
    seen.push(String(url));
    const req = new EventEmitter(); req.destroy = () => {};
    const r = script(String(url), seen.length);
    if (!r.hang) {
      setImmediate(() => {
        const res = new EventEmitter(); res.statusCode = r.status; res.headers = r.headers ?? {}; res.resume = () => {};
        cb(res);
        if (r.status === 200) { for (const c of r.chunks ?? [Buffer.from(r.body ?? '')]) res.emit('data', c); res.emit('end'); }
      });
    }
    return req;
  };
  fn.seen = seen;
  return fn;
}

describe('bounded HTTPS fetch', () => {
  test('redirects: official https hosts only, limited count', async () => {
    assert.equal(D.safeRedirect(D.OFFICIAL_URL, '/docs/en/model-config'), 'https://code.claude.com/docs/en/model-config');
    assert.equal(D.safeRedirect(D.OFFICIAL_URL, 'https://docs.claude.com/x.md'), 'https://docs.claude.com/x.md');
    for (const bad of ['http://code.claude.com/x', 'https://evil.example/x', 'https://code.claude.com.evil.example/x', 'https://user:pw@code.claude.com/x', 'https://code.claude.com:8443/x', 'file:///etc/passwd']) {
      assert.equal(D.safeRedirect(D.OFFICIAL_URL, bad), null, bad);
    }
    const ok = fakeRequest((u, n) => (n === 1 ? { status: 302, headers: { location: 'https://docs.claude.com/moved.md' } } : { status: 200, body: 'hello' }));
    assert.equal(await D.httpGet(D.OFFICIAL_URL, { request: ok }), 'hello');
    assert.deepEqual(ok.seen, [D.OFFICIAL_URL, 'https://docs.claude.com/moved.md']);
    const evil = fakeRequest(() => ({ status: 301, headers: { location: 'https://evil.example/model-config.md' } }));
    await assert.rejects(D.httpGet(D.OFFICIAL_URL, { request: evil }), /unsafe or excessive redirect/);
    assert.equal(evil.seen.length, 1, 'the unsafe target is never requested');
    const loop = fakeRequest(() => ({ status: 302, headers: { location: 'https://code.claude.com/again' } }));
    await assert.rejects(D.httpGet(D.OFFICIAL_URL, { request: loop }), /unsafe or excessive redirect/);
    assert.equal(loop.seen.length, D.MAX_REDIRECTS + 1);
  });

  test('size cap, non-200 and total timeout', async () => {
    assert.equal(D.MAX_BYTES, 512 * 1024);
    assert.ok(D.TOTAL_TIMEOUT_MS <= 3000);
    await assert.rejects(D.httpGet(D.OFFICIAL_URL, { request: fakeRequest(() => ({ status: 200, headers: { 'content-length': String(D.MAX_BYTES + 1) } })) }), /too large/);
    await assert.rejects(D.httpGet(D.OFFICIAL_URL, { maxBytes: 10, request: fakeRequest(() => ({ status: 200, chunks: [Buffer.alloc(8), Buffer.alloc(8)] })) }), /over 10 bytes/);
    await assert.rejects(D.httpGet(D.OFFICIAL_URL, { request: fakeRequest(() => ({ status: 503 })) }), /HTTP 503/);
    const t0 = Date.now();
    await assert.rejects(D.httpGet(D.OFFICIAL_URL, { timeoutMs: 60, request: fakeRequest(() => ({ hang: true })) }), /timed out/);
    assert.ok(Date.now() - t0 < 1500);
  });
});

describe('discovery cache', () => {
  const DAY = 24 * 3600 * 1000;
  test('daily TTL: no repeated fetch while fresh; refetch when a day old; force refetches', async () => {
    let n = 0; const fetchImpl = async () => { n += 1; return DOCS_TEXT; };
    const now = Date.parse('2026-11-12T00:00:00Z');
    const a = await D.ensureDiscovery({ fetchImpl, now });
    assert.equal(a.state, 'refreshed');
    assert.equal(a.cache.source, D.OFFICIAL_URL);
    assert.equal((await D.ensureDiscovery({ fetchImpl, now: now + DAY - 1000 })).state, 'skipped:fresh');
    assert.equal(n, 1);
    assert.equal((await D.ensureDiscovery({ fetchImpl, now: now + DAY + 1000 })).state, 'refreshed');
    assert.equal(n, 2);
    assert.equal((await D.ensureDiscovery({ fetchImpl, now: now + DAY + 2000, force: true })).state, 'refreshed');
    assert.equal(n, 3);
    assert.deepEqual(fs.readdirSync(t.env.CONCORD_CACHE_DIR).filter((f) => /\.tmp$|\.lock$/.test(f)), [], 'no temp or lock files left behind');
  });

  test('failure keeps the last good list, backs off, then retries; parse failures count as failures', async () => {
    let n = 0; let mode = 'ok';
    const fetchImpl = async () => { n += 1; if (mode === 'down') throw new Error('ENOTFOUND'); return mode === 'junk' ? '<html>captive portal</html>' : DOCS_TEXT; };
    const now = Date.parse('2026-11-12T00:00:00Z');
    await D.ensureDiscovery({ fetchImpl, now });
    mode = 'down';
    const f1 = await D.ensureDiscovery({ fetchImpl, now: now + DAY + 1 });
    assert.equal(f1.state, 'failed');
    assert.deepEqual(f1.cache.aliases.map((a) => a.alias), ['fable', 'sonnet', 'opus', 'haiku'], 'last good data retained');
    assert.equal(f1.cache.fetched_at, new Date(now).toISOString(), 'the timestamp still says when the data was really fetched');
    assert.match(f1.cache.last_failure.error, /ENOTFOUND/);
    assert.equal((await D.ensureDiscovery({ fetchImpl, now: now + DAY + 60000 })).state, 'skipped:backoff');
    assert.equal(n, 2, 'no fetch during backoff');
    mode = 'junk';
    const f2 = await D.ensureDiscovery({ fetchImpl, now: Date.parse(f1.cache.next_retry_at) + 1 });
    assert.equal(f2.state, 'failed');
    assert.equal(f2.cache.failures, 2);
    assert.ok(Date.parse(f2.cache.next_retry_at) - Date.parse(f2.cache.last_failure.at) > Date.parse(f1.cache.next_retry_at) - Date.parse(f1.cache.last_failure.at), 'backoff grows');
    mode = 'ok';
    const ok = await D.ensureDiscovery({ fetchImpl, now: Date.parse(f2.cache.next_retry_at) + 1 });
    assert.equal(ok.state, 'refreshed');
    assert.equal(ok.cache.failures, 0);
  });

  test('first-ever failure leaves a usable empty cache; a live lock skips; the off switch never fetches', async () => {
    let n = 0;
    const down = async () => { n += 1; throw new Error('offline'); };
    const f = await D.ensureDiscovery({ fetchImpl: down });
    assert.equal(f.state, 'failed');
    assert.deepEqual(f.cache.aliases, []);
    fs.rmSync(D.discoveryFile());
    fs.writeFileSync(`${D.discoveryFile()}.lock`, '1');
    assert.equal((await D.ensureDiscovery({ fetchImpl: down })).state, 'skipped:busy');
    fs.rmSync(`${D.discoveryFile()}.lock`);
    process.env.CONCORD_MODEL_DISCOVERY = 'off';
    assert.equal((await D.ensureDiscovery({ fetchImpl: down, force: true })).state, 'skipped:disabled');
    assert.equal(n, 1);
  });
});

describe('network timing of commands', () => {
  test('help, preflight, models, status and advance never fetch; start fetches once per day, only after it is admitted', () => {
    online();
    for (const args of [['--help'], ['preflight', '--json'], ['models'], ['models', '--observations'], ['list']]) assert.equal(cli(...args).code, 0, args.join(' '));
    assert.equal(fetchCount(), 0);
    // Cheap rejections come first: bad spec, bad override, not a repository.
    assert.equal(start({ bogus: 1 }).json.error, 'spec');
    assert.equal(start({ models: { worker: 'claude-opus-5-5' } }).json.error, 'spec');
    assert.equal(cli('start', '--spec', write('s.json', { request: 'x', tests: [TEST_OK] }), '--repo', t.root).json.error, 'not_git');
    assert.equal(fetchCount(), 0);
    const s = start();
    assert.equal(s.code, 0, s.out);
    assert.equal(fetchCount(), 1);
    assert.equal(s.json.routing.published_docs.refresh, 'refreshed');
    assert.deepEqual(s.json.routing.published_docs.aliases, ['fable', 'sonnet', 'opus', 'haiku']);
    assert.equal(start().json.error, 'open_run', 'an open run is refused');
    cli('advance', s.json.run); cli('status', s.json.run, '--json'); cli('resume', s.json.run); cli('preflight');
    assert.equal(fetchCount(), 1, 'refused start, advance, status, resume and preflight are network-free');
    cli('cancel', s.json.run);
    const again = start();
    assert.equal(again.json.routing.published_docs.refresh, 'skipped:fresh');
    assert.equal(fetchCount(), 1, 'fresh cache: no second fetch the same day');
    assert.equal(cli('models', '--refresh', '--json').json.claude_docs_refresh.state, 'refreshed');
    assert.equal(fetchCount(), 2, 'explicit refresh always fetches');
  });

  test('an unreachable docs page never blocks a start: last good cache is kept and the failure is shown', () => {
    online();
    cli('models', '--refresh');
    const c = JSON.parse(fs.readFileSync(cache('claude-models.json'), 'utf8'));
    c.fetched_at = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(cache('claude-models.json'), JSON.stringify(c));
    online(path.join(t.root, 'missing.md'));
    const s = start();
    assert.equal(s.code, 0, s.out);
    assert.equal(s.json.routing.published_docs.refresh, 'failed');
    assert.equal(s.json.routing.published_docs.stale, true);
    assert.deepEqual(s.json.routing.published_docs.aliases, ['fable', 'sonnet', 'opus', 'haiku']);
    assert.equal(s.json.routing.tiers.opus.primary, 'fable-5.2-high', 'routing does not depend on the fetch');
    cli('cancel', s.json.run);
    const n = fetchCount();
    assert.equal(start().json.routing.published_docs.refresh, 'skipped:backoff');
    assert.equal(fetchCount(), n, 'backoff: no immediate retry');
    assert.match(cli('models').out, /last refresh failure .*last good data kept/);
  });
});

// ------------------------------------------------------------------ routing

describe('default routing (user policy: Fable 5.2/high for hard work)', () => {
  test('low → haiku alias, normal → sonnet alias, hard → pinned Fable agent with NO model parameter and Opus xhigh as declared fallback', () => {
    scenario(planOf('low', 'low', [
      { id: 'T2', title: 'more', description: 'x', files: ['app.txt'], depends_on: ['T1'], difficulty: 'medium', risk: 'low' },
      { id: 'T3', title: 'hard', description: 'x', files: ['app.txt'], depends_on: ['T2'], difficulty: 'high', risk: 'low' }]));
    const id = start().json.run;
    const a1 = cli('advance', id).json;
    assert.equal(a1.tier, 'haiku');
    assert.deepEqual(a1.agent, { subagent_type: 'general-purpose', model: 'haiku' });
    assert.equal(a1.fallback.available, false);
    assert.equal(a1.main_session.allowed, true, 'only a low-tier task on the policy alias may be done by the session itself');
    edit('1\n');
    const a2 = cli('advance', id, '--done', 'task-T1', '--executor', 'subagent').json;
    assert.equal(a2.tier, 'sonnet');
    assert.deepEqual(a2.agent, { subagent_type: 'general-purpose', model: 'sonnet' });
    assert.equal(a2.main_session.allowed, false);
    edit('2\n');
    const a3 = cli('advance', id, '--done', 'task-T2', '--executor', 'subagent').json;
    assert.equal(a3.tier, 'opus', 'capability tier stays the classic name');
    assert.deepEqual(a3.agent, { subagent_type: 'concord:fable-worker' }, 'no model key: it would override the pinned frontmatter');
    assert.match(a3.agent_note, /NO model parameter/);
    assert.equal(a3.main_session.allowed, false);
    assert.match(a3.main_session.note, /bypass the requested model/);
    assert.equal(a3.route.candidate, 'fable-5.2-high');
    assert.equal(a3.route.pinned_model, 'claude-fable-5-2');
    assert.equal(a3.route.effort, 'high');
    assert.equal(a3.route.actual, 'not observed by the helper');
    assert.match(a3.route.caveat, /never sees which model actually ran/);
    assert.match(a3.route.reason, /built-in default: opus capability tier → fable-5\.2-high/);
    assert.equal(a3.fallback.candidate, 'opus-5.5-xhigh');
    assert.match(a3.fallback.requested, /claude-opus-5-5 · effort xhigh/);
    assert.ok(a3.fallback.switch.includes('--use-fallback'));
    assert.equal(a3.task.route, undefined, 'the task JSON handed to the worker carries no routing internals');
    const run = runJson(id);
    assert.equal(run.tasks[2].tier, 'opus');
    assert.equal(run.tasks[2].route.candidate, 'fable-5.2-high');
    assert.match(run.routing.policy.note, /user preference, not a benchmark/);
    const st = cli('status', id);
    assert.match(st.out, /routing: policy "fable-high-preferred" \(built-in default\)/);
    assert.match(st.out, /requested claude-fable-5-2 · effort high/);
    assert.match(st.out, /requested haiku \[subagent; actual not observed\]/);
  });

  test('recorded steps keep requested vs actual apart; main-session work is inherited/unknown', () => {
    scenario(planOf('high'));
    const id = start().json.run;
    cli('advance', id); edit();
    cli('advance', id, '--done', 'task-T1', '--executor', 'main');
    const m = runJson(id).steps.find((s) => s.id === 'task-T1').model;
    assert.equal(m.requested, 'fable-5.2-high');
    assert.equal(m.pinned_model, 'claude-fable-5-2');
    assert.match(m.actual, /inherited from the main session.*NOT used/);
    assert.equal(runJson(id).steps.find((s) => s.id === 'task-T1').turnaround_ms, undefined);
  });
});

describe('skill instructions', () => {
  test('the run skill limits main-session work to tiny low-tier alias tasks and never tells the host to add a model to a packaged agent', () => {
    const skill = fs.readFileSync(path.join(PLUGIN, 'skills/run/SKILL.md'), 'utf8');
    assert.match(skill, /`--executor main`\) is allowed only when the action says `main_session\.allowed: true`/);
    assert.match(skill, /Never do it for\s+a packaged agent[\s\S]*explicit `--tier` choice[\s\S]*fallback[\s\S]*normal or hard-tier\s+task[\s\S]*any `repair`/);
    assert.match(skill, /not something the helper can enforce/);
    assert.match(skill, /Never add a `model` to a packaged agent/);
    assert.doesNotMatch(skill, /For a tiny step you may edit it yourself/);
  });
});

describe('explicit overrides', () => {
  test('opus → pinned Opus 5.5/xhigh, fable → pinned Fable 5.2/high, *-alias → host-resolved alias; no fallback on an override', () => {
    for (const [token, agent, effort] of [['opus', { subagent_type: 'concord:opus-worker' }, 'xhigh'], ['fable', { subagent_type: 'concord:fable-worker' }, 'high'],
      ['opus-5.5-xhigh', { subagent_type: 'concord:opus-worker' }, 'xhigh'], ['opus-alias', { subagent_type: 'general-purpose', model: 'opus' }, null],
      ['fable-alias', { subagent_type: 'general-purpose', model: 'fable' }, null], ['sonnet', { subagent_type: 'general-purpose', model: 'sonnet' }, null]]) {
      scenario(planOf('low'));
      const id = start({ models: { worker: token } }).json.run;
      const a = cli('advance', id).json;
      assert.deepEqual(a.agent, agent, token);
      assert.equal(a.route.effort, effort, token);
      assert.equal(a.route.source, 'override');
      assert.equal(a.fallback.available, false);
      assert.equal(a.tier_reason, 'per-role override');
      assert.equal(a.main_session.allowed, false, `an explicit choice is never replaced by the main session (${token})`);
      const fb = cli('advance', id, '--use-fallback', 'task-T1', '--note-file', write('e.txt', 'model unavailable'));
      assert.equal(fb.json.error, 'no_fallback', fb.out);
      cli('cancel', id);
    }
  });

  test('full model IDs, inherit and unknown strings are rejected before a run exists', () => {
    for (const bad of ['claude-opus-5-5', 'claude-fable-5-2', 'inherit', 'gpt-5', 'best', 'opusplan', 'mythos']) {
      const r = start({ models: { worker: bad } });
      assert.equal(r.json.error, 'spec', bad);
      assert.match(r.json.message, /not a routable worker choice|must be haiku/);
    }
    assert.equal(start({ models: { repair: 'Opus; rm -rf' } }).json.error, 'spec');
    assert.match(cli('list').out, /no runs/);
  });

  test('repair: the capability floor comes from the task risk; a repair override wins; neither leaks into the other', () => {
    const qaFail = { verdict: 'fail', summary: 'bad', findings: [{ blocking: true, file: 'app.txt', issue: 'wrong', fix: 'fix' }] };
    scenario({ ...planOf('high'), qa: [qaFail] });
    let id = start({ models: { worker: 'haiku' } }).json.run;
    cli('advance', id); edit();
    let rep = cli('advance', id, '--done', 'task-T1').json;
    assert.equal(rep.action, 'repair');
    assert.equal(rep.tier, 'opus');
    assert.deepEqual(rep.agent, { subagent_type: 'concord:fable-worker' });
    assert.equal(rep.fallback.candidate, 'opus-5.5-xhigh');
    assert.equal(rep.main_session.allowed, false, 'repairs always go to the requested model');
    assert.equal(runJson(id).tasks[0].computed_tier, 'opus', 'the task keeps its computed capability tier next to the override');
    cli('cancel', id); edit('todo\n');
    scenario({ ...planOf('high'), qa: [qaFail] });
    id = start({ models: { repair: 'opus' } }).json.run;
    cli('advance', id); edit();
    rep = cli('advance', id, '--done', 'task-T1').json;
    assert.deepEqual(rep.agent, { subagent_type: 'concord:opus-worker' });
    assert.equal(rep.route.source, 'override');
  });
});

describe('explicit fallback switch', () => {
  test('needs the host error, is recorded, never claims the primary ran, and excludes the run from evidence', () => {
    scenario(planOf('high'));
    const id = start().json.run;
    const a = cli('advance', id).json;
    assert.equal(a.route.candidate, 'fable-5.2-high');
    assert.equal(cli('advance', id, '--use-fallback', 'task-T1').json.error, 'usage', 'no silent switch without the error text');
    assert.equal(cli('advance', id, '--use-fallback', 'task-T9', '--note-file', write('e.txt', 'x')).json.error, 'usage');
    assert.equal(runJson(id).tasks[0].route.candidate, 'fable-5.2-high', 'refused switches change nothing');
    const sw = cli('advance', id, '--use-fallback', 'task-T1', '--note-file', write('e.txt', 'Agent error: model claude-fable-5-2 is not available for this account'), '--one-step').json;
    assert.equal(sw.action, 'implement');
    assert.deepEqual(sw.agent, { subagent_type: 'concord:opus-worker' });
    assert.equal(sw.route.fallback_used, true);
    assert.equal(sw.route.primary, 'fable-5.2-high');
    assert.equal(sw.tier, 'opus', 'capability tier is untouched by the switch');
    assert.equal(sw.fallback.available, false);
    assert.equal(cli('advance', id, '--use-fallback', 'task-T1', '--note-file', write('e.txt', 'again')).json.error, 'no_fallback');
    const run = runJson(id);
    assert.equal(run.route_events.length, 1);
    assert.match(run.route_events[0].reason, /not available for this account/);
    assert.match(run.policy_notes.at(-1), /primary was NOT used/);
    edit();
    assert.equal(cli('advance', id, '--done', 'task-T1', '--executor', 'subagent').json.status, 'validated');
    const step = runJson(id).steps.find((s) => s.id === 'task-T1');
    assert.equal(step.model.requested, 'opus-5.5-xhigh');
    assert.equal(step.model.fallback_used, true);
    assert.match(cli('status', id).out, /task-T1: fable-5\.2-high → opus-5\.5-xhigh \(fallback\)/);
    const ap = cli('approve', id, '--decision', 'approve').json;
    assert.deepEqual(ap.approval.outcome_ledger, { recorded: false, reason: 'a fallback switch happened' });
  });

  test('--use-fallback, --done and --failed are mutually exclusive and rejected before any side effect', () => {
    scenario(planOf('high'));
    const id = start().json.run;
    cli('advance', id);
    edit();
    const before = fs.readFileSync(runFile(id), 'utf8');
    const note = write('e.txt', 'model unavailable');
    for (const args of [['--use-fallback', 'task-T1', '--done', 'task-T1', '--executor', 'subagent'], ['--use-fallback', 'task-T1', '--failed', 'task-T1'],
      ['--done', 'task-T1', '--failed', 'task-T1'], ['--done', 'task-T1', '--failed', 'task-T1', '--use-fallback', 'task-T1']]) {
      const r = cli('advance', id, ...args, '--note-file', note);
      assert.equal(r.json.error, 'usage', args.join(' '));
      assert.match(r.json.message, /cannot be combined; nothing was changed/);
      assert.equal(fs.readFileSync(runFile(id), 'utf8'), before, `run.json untouched by: ${args.join(' ')}`);
    }
    const run = runJson(id);
    assert.equal(run.route_events, undefined);
    assert.equal(run.steps.filter((s) => s.role === 'task').length, 0);
    assert.equal(run.issued.step, 'task-T1'); assert.equal(run.issued.reissued, undefined);
    assert.equal(run.phase, 'implement'); assert.equal(run.tasks[0].route.candidate, 'fable-5.2-high');
    // Each action still works on its own afterwards.
    assert.equal(cli('advance', id, '--use-fallback', 'task-T1', '--note-file', note).json.route.fallback_used, true);
    assert.equal(cli('advance', id, '--done', 'task-T1', '--executor', 'subagent').json.status, 'validated');
  });

  test('a repair step can switch too, and keeps its capability tier', () => {
    scenario({ ...planOf('high'), qa: [{ verdict: 'fail', summary: 'bad', findings: [{ blocking: true, file: 'app.txt', issue: 'wrong', fix: 'fix' }] }] });
    const id = start({ models: { worker: 'opus' } }).json.run;
    cli('advance', id); edit();
    assert.equal(cli('advance', id, '--done', 'task-T1').json.route.candidate, 'fable-5.2-high');
    const sw = cli('advance', id, '--use-fallback', 'repair-1', '--note-file', write('e.txt', 'effort high unsupported by this Claude Code')).json;
    assert.equal(sw.action, 'repair');
    assert.deepEqual(sw.agent, { subagent_type: 'concord:opus-worker' });
    assert.equal(sw.tier, 'opus');
  });
});

describe('routing profile', () => {
  const store = (profile) => cli('models', '--routing', write(`profile-${Math.random().toString(16).slice(2)}.json`, profile), '--json');

  test('unsafe or unknown entries are refused and nothing is stored', () => {
    for (const [profile, re] of [
      [{ routes: { opus: { primary: 'sonnet' } } }, /sonnet is not eligible for the opus tier/],
      [{ candidates: { haiku: { alias: 'haiku', tiers: ['opus'] } } }, /may not serve the opus capability tier/],
      [{ candidates: { cheap: { alias: 'sonnet', tiers: ['high'] } }, routes: { high: { primary: 'cheap' } } }, /may not serve the opus capability tier/],
      [{ candidates: { pin: { alias: 'claude-opus-5-5', tiers: ['opus'] } } }, /plain family alias/],
      [{ candidates: { x: { alias: 'mythos', tiers: ['opus'] } } }, /neither a documented Agent-tool alias/],
      [{ candidates: { x: { agent: 'evil-worker', tiers: ['opus'] } } }, /not a packaged agent/],
      [{ candidates: { x: { agent: 'fable-worker', alias: 'fable', tiers: ['opus'] } } }, /exactly one of/],
      [{ candidates: { x: { agent: 'fable-worker', tiers: ['opus'], model: 'claude-anything' } } }, /unknown key model/],
      [{ routes: { opus: { primary: 'fable-5.2-high', fallback: 'fable-5.2-high' } } }, /fallback must differ/],
      [{ routes: { opus: { primary: 'nope' } } }, /unknown candidate/],
      [{ overrides: { opus: 'nope' } }, /unknown candidate/],
      [{ auto_promotion: true }, /unknown key auto_promotion/],
      [[], /must be a JSON object/],
    ]) {
      const r = store(profile);
      assert.equal(r.json.error, 'routing_policy', JSON.stringify(profile));
      assert.match(r.json.message, re);
    }
    assert.equal(fs.existsSync(cache('routing.json')), false);
    assert.equal(cli('models', '--routing', write('bad.json', '{not json')).json.error, 'routing_policy');
  });

  test('a stored profile changes later runs; --reset-routing restores the default; the profile survives sessions as a file', () => {
    const r = store({ name: 'opus-first', routes: { high: { primary: 'opus-5.5-xhigh', fallback: 'fable-5.2-high' } }, overrides: { fable: 'fable-alias' } });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.json.routing.policy.routes.opus.primary, 'opus-5.5-xhigh');
    assert.match(r.json.routing.policy.source, /user profile/);
    assert.match(cli('preflight').out, /policy "opus-first"/);
    scenario(planOf('high'));
    let id = start().json.run;
    let a = cli('advance', id).json;
    assert.deepEqual(a.agent, { subagent_type: 'concord:opus-worker' });
    assert.equal(a.fallback.candidate, 'fable-5.2-high');
    assert.match(a.route.reason, /user profile/);
    cli('cancel', id);
    scenario(planOf('low'));
    id = start({ models: { worker: 'fable' } }).json.run;
    assert.deepEqual(cli('advance', id).json.agent, { subagent_type: 'general-purpose', model: 'fable' }, 'the profile remapped the fable shorthand to the alias');
    cli('cancel', id);
    const reset = cli('models', '--reset-routing', '--json').json;
    assert.equal(reset.routing_reset.removed, true);
    assert.equal(reset.routing.policy.source, 'built-in default');
    scenario(planOf('high'));
    id = start().json.run;
    assert.deepEqual(cli('advance', id).json.agent, { subagent_type: 'concord:fable-worker' });
  });

  test('a published but undocumented family needs the docs cache AND an explicit host_compatible flag', () => {
    const mythos = { candidates: { mythos: { alias: 'mythos', tiers: ['opus'], host_compatible: true } }, routes: { opus: { primary: 'mythos', fallback: 'opus-5.5-xhigh' } } };
    assert.match(store(mythos).json.message, /neither a documented Agent-tool alias/);
    const docs = write('docs.md', DOCS_TEXT.replace('| **`sonnet`** |', '| **`mythos`** | Uses the Mythos model for research tasks |\n| **`sonnet`** |'));
    online(docs);
    cli('models', '--refresh');
    assert.match(cli('models').out, /published but not in the policy \(candidate only; needs host compatibility \+ an explicit profile entry\): mythos/);
    scenario(planOf('high'));
    let id = start().json.run;
    assert.deepEqual(cli('advance', id).json.agent, { subagent_type: 'concord:fable-worker' }, 'a discovered family is never selected on its own');
    cli('cancel', id);
    assert.match(store({ candidates: { mythos: { alias: 'mythos', tiers: ['opus'] } } }).json.message, /host_compatible/);
    assert.equal(store(mythos).code, 0);
    scenario(planOf('high'));
    id = start().json.run;
    const a = cli('advance', id).json;
    assert.deepEqual(a.agent, { subagent_type: 'general-purpose', model: 'mythos' });
    assert.match(a.route.readiness, /host compatibility asserted by the profile only/);
  });

  test('a stored profile that became invalid stops start with a clear way out', () => {
    fs.mkdirSync(t.env.CONCORD_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cache('routing.json'), JSON.stringify({ schema: 1, profile: { candidates: { x: { agent: 'gone-worker', tiers: ['opus'] } } } }));
    const s = start();
    assert.equal(s.json.error, 'routing_policy');
    assert.match(s.json.message, /models --reset-routing/);
    assert.equal(cli('preflight', '--json').json.checks.claude_routing.ok, false);
    cli('models', '--reset-routing');
    assert.equal(start().code, 0);
  });

  test('library: sample profile equals the built-in default; packaged agents carry the pins', () => {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(PLUGIN, 'policy/routing.sample.json'), 'utf8')), R.DEFAULT_PROFILE);
    assert.deepEqual(R.listAgents(), {
      'fable-worker': { subagent_type: 'concord:fable-worker', model: 'claude-fable-5-2', effort: 'high' },
      'opus-worker': { subagent_type: 'concord:opus-worker', model: 'claude-opus-5-5', effort: 'xhigh' },
    });
    const p = R.buildPolicy({});
    assert.deepEqual(p.routes, { haiku: { primary: 'haiku', fallback: null }, sonnet: { primary: 'sonnet', fallback: null }, opus: { primary: 'fable-5.2-high', fallback: 'opus-5.5-xhigh' } });
    assert.deepEqual(R.agentCall(R.routeForTier({ policy: { ...p, source: 'x' } }, 'opus')), { subagent_type: 'concord:fable-worker' });
  });
});

describe('frozen per-run routing and legacy runs', () => {
  test('a profile or catalog change after start never reaches the open run', () => {
    scenario(planOf('high'));
    const id = start().json.run;
    const frozen = runJson(id).routing;
    assert.equal(frozen.policy.routes.opus.primary, 'fable-5.2-high');
    // Planning happens AFTER these changes, and still uses the snapshot.
    assert.equal(cli('models', '--routing', write('p.json', { name: 'later', routes: { opus: { primary: 'opus-alias', fallback: null } } })).code, 0);
    online(); cli('models', '--refresh');
    const a = cli('advance', id).json;
    assert.deepEqual(a.agent, { subagent_type: 'concord:fable-worker' });
    assert.equal(a.route.policy.name, 'fable-high-preferred');
    assert.deepEqual(runJson(id).routing, frozen);
    assert.match(cli('status', id).out, /routing: policy "fable-high-preferred" \(built-in default\) frozen/);
    cli('cancel', id);
    scenario(planOf('high'));
    assert.deepEqual(cli('advance', start().json.run).json.agent, { subagent_type: 'general-purpose', model: 'opus' }, 'the next run uses the new profile');
  });

  test('a run saved before routing snapshots keeps alias-per-tier routing and gives no ledger sample', () => {
    scenario(planOf('high'));
    const id = start({ models: { repair: 'opus' } }).json.run;
    const run = runJson(id);
    delete run.routing;
    fs.writeFileSync(runFile(id), JSON.stringify(run));
    const a = cli('advance', id).json;
    assert.equal(a.tier, 'opus');
    assert.deepEqual(a.agent, { subagent_type: 'general-purpose', model: 'opus' });
    assert.equal(a.route, undefined);
    assert.equal(a.fallback, undefined);
    assert.equal(cli('advance', id, '--use-fallback', 'task-T1', '--note-file', write('e.txt', 'x')).json.error, 'no_fallback');
    assert.match(cli('status', id).out, /routing: Run saved before routing snapshots/);
    edit();
    assert.equal(cli('advance', id, '--done', 'task-T1', '--executor', 'subagent').json.status, 'validated');
    assert.equal(runJson(id).steps.find((s) => s.id === 'task-T1').model.requested_alias, 'opus');
    assert.equal(cli('approve', id, '--decision', 'approve').json.approval.outcome_ledger.reason, 'legacy run without frozen routing');
  });
});

// ------------------------------------------------------------------ outcome ledger

describe('outcome ledger (advisory)', () => {
  const ledger = () => { try { return JSON.parse(fs.readFileSync(cache('outcomes.json'), 'utf8')); } catch { return null; } };
  const finish = (id, executor = 'subagent') => { cli('advance', id); edit(); return cli('advance', id, '--done', 'task-T1', '--executor', executor).json; };

  test('a clean approved native run records one sample with measured turnaround and its cohort', () => {
    scenario(planOf('high', 'medium'));
    const id = start().json.run;
    assert.equal(finish(id).status, 'validated');
    assert.equal(ledger(), null, 'nothing is recorded before the human approves');
    const ap = cli('approve', id, '--decision', 'approve').json;
    assert.deepEqual(ap.approval.outcome_ledger, { recorded: true, candidate: 'fable-5.2-high', tasks: 1 });
    const l = ledger();
    assert.equal(l.runs.length, 1);
    const s = l.runs[0];
    assert.equal(s.run, id);
    assert.deepEqual(s.requested, { kind: 'agent', alias: null, subagent_type: 'concord:fable-worker', pinned_model: 'claude-fable-5-2', effort: 'high' });
    assert.equal(s.tasks[0].tier, 'opus');
    assert.equal(s.tasks[0].difficulty, 'medium');
    assert.equal(s.tasks[0].risk, 'high');
    const step = runJson(id).steps.find((x) => x.id === 'task-T1');
    assert.equal(s.tasks[0].turnaround_ms, step.turnaround_ms);
    assert.ok(step.turnaround_ms > 0 && Date.parse(step.at) - Date.parse(step.issued_at) >= 0);
    const o = cli('models', '--observations', '--json').json;
    assert.equal(o.cohorts[0].cohort, 'opus/medium/high');
    assert.equal(o.cohorts[0].candidates[0].verdict, 'no_qualifying_evidence');
    assert.match(o.note, /not a controlled benchmark and not evidence of which model actually ran/);
    assert.equal(cli('models', '--reset-observations', '--json').json.observations_reset.removed, true);
    assert.equal(ledger(), null);
  });

  test('no credit for: rejection, cancel, main session, repair, amendment, re-issued step', () => {
    const none = (why) => assert.equal(ledger(), null, why);
    // rejected by the human
    let id = start().json.run; finish(id);
    assert.equal(cli('approve', id, '--decision', 'reject').json.approval.outcome_ledger.reason, 'not an approval');
    none('reject'); edit('todo\n');
    // cancelled
    id = start().json.run; cli('advance', id); cli('cancel', id); none('cancel');
    // main session (inherited model)
    id = start().json.run; finish(id, 'main');
    assert.match(cli('approve', id, '--decision', 'approve').json.approval.outcome_ledger.reason, /main-session/);
    none('main'); edit('todo\n');
    // QA failure → repair → pass
    scenario({ qa: [{ verdict: 'fail', summary: 'bad', findings: [{ blocking: true, file: 'app.txt', issue: 'wrong', fix: 'fix' }] }] });
    id = start().json.run; cli('advance', id); edit();
    assert.equal(cli('advance', id, '--done', 'task-T1', '--executor', 'subagent').json.action, 'repair');
    edit('done\n\n');
    assert.equal(cli('advance', id, '--done', 'repair-1', '--executor', 'subagent').json.status, 'validated');
    assert.equal(cli('approve', id, '--decision', 'approve').json.approval.outcome_ledger.reason, 'run needed a repair');
    none('repair'); edit('todo\n');
    // amended mid-run
    scenario({});
    id = start().json.run; cli('advance', id);
    assert.equal(cli('amend', id, '--spec', write('am.json', { kind: 'clarify', text: 'keep the newline' }), '--writer-stopped').code, 0);
    edit();
    assert.equal(cli('advance', id, '--done', 'task-T1', '--executor', 'subagent', '--revision', '2').json.status, 'validated');
    assert.equal(cli('approve', id, '--decision', 'approve').json.approval.outcome_ledger.reason, 'amended run');
    none('amend'); edit('todo\n');
    // the same step handed out twice (e.g. a resumed session): timing is dropped, so no sample
    id = start().json.run; cli('advance', id); cli('resume', id); edit();
    cli('advance', id, '--done', 'task-T1', '--executor', 'subagent');
    assert.equal(runJson(id).steps.find((s) => s.id === 'task-T1').turnaround_ms, undefined);
    assert.equal(cli('approve', id, '--decision', 'approve').json.approval.outcome_ledger.reason, 'no measured assignment turnaround');
    none('reissued');
  });

  const reqOf = (policy, key) => { const c = policy.candidates[key]; return { kind: c.kind, alias: c.alias, subagent_type: c.subagent_type, pinned_model: c.pinned_model, effort: c.effort }; };
  const fakeRun = (id, over = {}) => {
    const route = { candidate: 'fable-5.2-high', kind: 'agent', model: null, subagent_type: 'concord:fable-worker', pinned_model: 'claude-fable-5-2', effort: 'high', source: 'policy' };
    return { id, routing: {}, status: 'approved', validation: {}, revision: 1, amendments: [], repairs_used: 0, approval: { at: 'now' },
      tasks: [{ id: 'T1', tier: 'opus', computed_tier: 'opus', difficulty: 'high', risk: 'high', route }],
      steps: [{ id: 'proposal', role: 'proposal', status: 'passed' }, { id: 'task-T1', role: 'task', status: 'passed', executor: 'subagent', model: { requested: 'fable-5.2-high' }, turnaround_ms: 1000 }], ...over };
  };

  test('library: strict exclusions, run-id dedup, bounded history', () => {
    assert.ok(R.outcomeSample(fakeRun('a')).sample);
    const two = fakeRun('m');
    two.tasks.push({ ...two.tasks[0], id: 'T2', route: { ...two.tasks[0].route, candidate: 'opus-5.5-xhigh' } });
    two.steps.push({ id: 'task-T2', role: 'task', status: 'passed', executor: 'subagent', model: { requested: 'opus-5.5-xhigh' }, turnaround_ms: 5 });
    assert.equal(R.outcomeSample(two).reason, 'mixed requested models in one run');
    const low = fakeRun('d'); low.tasks[0].tier = 'haiku';
    assert.equal(R.outcomeSample(low).reason, 'override below the task capability tier');
    assert.equal(R.outcomeSample(fakeRun('i', { invalidated: [{}] })).reason, 'validation was invalidated during the run');
    assert.equal(R.outcomeSample(fakeRun('v', { status: 'validated' })).reason, 'not an approved validated run');
    const failed = fakeRun('f'); failed.steps.push({ id: 'qa-1', role: 'qa', status: 'failed' });
    assert.match(R.outcomeSample(failed).reason, /failed, interrupted or invalidated step/);
    const slow = fakeRun('s'); slow.steps[1].turnaround_ms = 7 * 3600 * 1000;
    assert.equal(R.outcomeSample(slow).reason, 'no measured assignment turnaround', 'an implausible wait is not a speed sample');
    assert.equal(R.recordOutcome(fakeRun('20260101-000000-aaaaaa')).recorded, true);
    assert.deepEqual(R.recordOutcome(fakeRun('20260101-000000-aaaaaa')), { recorded: false, reason: 'run already recorded' });
    for (let i = 0; i < 205; i++) R.recordOutcome(fakeRun(`r${i}`));
    const l = R.loadLedger();
    assert.equal(l.runs.length, 200);
    assert.equal(l.runs.at(-1).run, 'r204');
    assert.deepEqual(fs.readdirSync(t.env.CONCORD_CACHE_DIR).filter((f) => /\.tmp$|\.lock$/.test(f)), []);
  });

  test('advisory comparison: ≥3 samples on both sides in the SAME cohort and ≥20% faster; never changes routing', () => {
    const policy = R.buildPolicy({});
    const mk = (candidate, ms, cohort = ['opus', 'high', 'high']) => ({ run: `${candidate}-${ms}-${cohort.join('')}`, candidate, requested: reqOf(policy, candidate), tasks: [{ id: 'T1', tier: cohort[0], difficulty: cohort[1], risk: cohort[2], turnaround_ms: ms }] });
    const verdict = (runs, cand = 'fable-5.2-high', cohort = 'opus/high/high') => R.compareOutcomes({ runs }, policy).cohorts.find((c) => c.cohort === cohort).candidates.find((c) => c.candidate === cand);
    const base3 = [100, 100, 100].map((ms, i) => mk('opus-5.5-xhigh', ms + i));
    assert.equal(verdict([...base3, mk('fable-5.2-high', 10), mk('fable-5.2-high', 11)]).verdict, 'no_qualifying_evidence', '2 candidate samples');
    assert.equal(verdict([base3[0], base3[1], ...[10, 11, 12].map((ms) => mk('fable-5.2-high', ms))]).verdict, 'no_qualifying_evidence', '2 baseline samples');
    const fast = verdict([...base3, ...[70, 75, 79].map((ms) => mk('fable-5.2-high', ms))]);
    assert.equal(fast.verdict, 'advisory_faster');
    assert.ok(fast.speedup >= 0.2);
    assert.equal(verdict([...base3, ...[85, 90, 95].map((ms) => mk('fable-5.2-high', ms))]).verdict, 'no_clear_improvement', '<20%');
    // Samples from another cohort (different risk) never count toward this one.
    assert.equal(verdict([...base3, mk('fable-5.2-high', 10), mk('fable-5.2-high', 11), mk('fable-5.2-high', 12, ['opus', 'high', 'medium'])]).verdict, 'no_qualifying_evidence');
    // A candidate that is not eligible for the tier is never recommended, however fast.
    assert.equal(verdict([...base3, ...[1, 2, 3].map((ms) => mk('haiku', ms))], 'haiku').verdict, 'not_eligible_for_tier');
    assert.equal(verdict(base3, 'opus-5.5-xhigh').role, 'baseline');
    // Even a "faster" baseline never displaces the user's primary: routing is read from the profile only.
    const opusRoute = { candidate: 'opus-5.5-xhigh', ...reqOf(policy, 'opus-5.5-xhigh'), model: null, source: 'policy' };
    for (const ms of [10, 11, 12]) R.recordOutcome({ ...fakeRun(`o${ms}`), tasks: [{ ...fakeRun('x').tasks[0], route: opusRoute }], steps: [{ id: 'task-T1', role: 'task', status: 'passed', executor: 'subagent', model: { requested: 'opus-5.5-xhigh' }, turnaround_ms: ms }] });
    for (const ms of [900, 910, 920]) R.recordOutcome({ ...fakeRun(`f${ms}`), steps: [{ id: 'task-T1', role: 'task', status: 'passed', executor: 'subagent', model: { requested: 'fable-5.2-high' }, turnaround_ms: ms }] });
    scenario(planOf('high', 'high'));
    assert.deepEqual(cli('advance', start().json.run).json.agent, { subagent_type: 'concord:fable-worker' });
    const obs = cli('models', '--observations', '--json').json;
    assert.equal(obs.cohorts.find((c) => c.cohort === 'opus/high/high').candidates.find((c) => c.candidate === 'fable-5.2-high').verdict, 'no_clear_improvement');
    assert.deepEqual(obs.excluded, { missing_identity: 0, unknown_candidate: 0, obsolete_identity: 0 });
    assert.match(cli('models', '--observations').out, /Advisory only; routing never changes automatically/);
  });

  test('evidence is bound to the requested configuration, not to the candidate key: a reassigned key starts from zero', () => {
    const policy = R.buildPolicy({});
    const mk = (candidate, ms, requested = reqOf(policy, candidate)) => ({ run: `${candidate}-${ms}`, candidate, requested, tasks: [{ id: 'T1', tier: 'opus', difficulty: 'high', risk: 'high', turnaround_ms: ms }] });
    const runs = [...[100, 101, 102].map((ms) => mk('opus-5.5-xhigh', ms)), ...[50, 51, 52].map((ms) => mk('fable-5.2-high', ms))];
    const row = (pol, key = 'fable-5.2-high', all = runs) => { const c = R.compareOutcomes({ runs: all }, pol); return { c, row: c.cohorts[0]?.candidates.find((x) => x.candidate === key) }; };
    assert.equal(row(policy).row.verdict, 'advisory_faster', 'same identity: counted');
    assert.equal(row(policy).c.runs_compared, 6);
    // The same key now names the host-resolved alias instead of the pinned agent.
    const asAlias = R.buildPolicy({ candidates: { 'fable-5.2-high': { alias: 'fable', tiers: ['opus'] } } });
    let r = row(asAlias);
    assert.equal(r.row, undefined, 'old pinned-agent samples are not credited to the alias');
    assert.deepEqual(r.c.excluded, { missing_identity: 0, unknown_candidate: 0, obsolete_identity: 3 });
    assert.equal(r.c.runs, 6); assert.equal(r.c.runs_compared, 3);
    // The same key now names another packaged model/effort.
    r = row(R.buildPolicy({ candidates: { 'fable-5.2-high': { agent: 'opus-worker', tiers: ['opus'] } } }));
    assert.equal(r.row, undefined);
    assert.equal(r.c.excluded.obsolete_identity, 3);
    // Any single differing field makes a record obsolete (here: effort); new matching samples count from zero.
    const stale = [50, 51, 52].map((ms) => mk('fable-5.2-high', ms, { ...reqOf(policy, 'fable-5.2-high'), effort: 'max' }));
    r = row(policy, 'fable-5.2-high', [...runs.slice(0, 3), ...stale, mk('fable-5.2-high', 60)]);
    assert.equal(r.row.samples, 1);
    assert.equal(r.row.verdict, 'no_qualifying_evidence');
    assert.equal(r.c.excluded.obsolete_identity, 3);
    // Records without an identity, or for a key the policy no longer has, are skipped and counted.
    const { requested: _drop, ...bare } = mk('fable-5.2-high', 1);
    r = row(policy, 'fable-5.2-high', [...runs, { ...bare, run: 'bare' }, mk('retired-key', 1, reqOf(policy, 'haiku'))]);
    assert.deepEqual(r.c.excluded, { missing_identity: 1, unknown_candidate: 1, obsolete_identity: 0 });
    assert.equal(r.row.samples, 3);
    // End to end: real ledger records, then the profile reassigns the key.
    for (const ms of [100, 101, 102]) R.recordOutcome({ ...fakeRun(`b${ms}`), tasks: [{ ...fakeRun('x').tasks[0], route: { candidate: 'opus-5.5-xhigh', ...reqOf(policy, 'opus-5.5-xhigh'), model: null, source: 'policy' } }],
      steps: [{ id: 'task-T1', role: 'task', status: 'passed', executor: 'subagent', model: { requested: 'opus-5.5-xhigh' }, turnaround_ms: ms }] });
    for (const ms of [50, 51, 52]) R.recordOutcome({ ...fakeRun(`c${ms}`), steps: [{ id: 'task-T1', role: 'task', status: 'passed', executor: 'subagent', model: { requested: 'fable-5.2-high' }, turnaround_ms: ms }] });
    const cand = (o) => o.cohorts[0].candidates.find((x) => x.candidate === 'fable-5.2-high');
    assert.equal(cand(cli('models', '--observations', '--json').json).verdict, 'advisory_faster');
    assert.equal(cli('models', '--routing', write('reassign.json', { candidates: { 'fable-5.2-high': { alias: 'fable', tiers: ['opus'] } } })).code, 0);
    const after = cli('models', '--observations', '--json').json;
    assert.equal(cand(after), undefined);
    assert.equal(after.excluded.obsolete_identity, 3);
    assert.match(cli('models', '--observations').out, /excluded from comparison: 3 obsolete_identity/);
    assert.equal(R.loadLedger().runs.length, 6, 'nothing is deleted; run-id dedup is unchanged');
    assert.deepEqual(R.recordOutcome(fakeRun('c50')), { recorded: false, reason: 'run already recorded' });
  });
});

// ------------------------------------------------------------------ packaging

describe('packaging', () => {
  test('the package ships the pinned agents and the sample profile, and the packaged helper finds them', () => {
    const out = path.join(t.root, 'dist');
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/package.mjs'), '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['agents/fable-worker.md', 'agents/opus-worker.md', 'policy/routing.sample.json', 'scripts/lib/routing.mjs', 'scripts/lib/discovery.mjs', 'README.zh-CN.md']) {
      assert.ok(fs.existsSync(path.join(out, 'concord', f)), f);
    }
    const fm = fs.readFileSync(path.join(out, 'concord/agents/fable-worker.md'), 'utf8');
    assert.match(fm, /^---\nname: fable-worker\n[\s\S]*\nmodel: claude-fable-5-2\neffort: high\n---/);
    assert.match(fs.readFileSync(path.join(out, 'concord/agents/opus-worker.md'), 'utf8'), /\nmodel: claude-opus-5-5\neffort: xhigh\n---/);
    const m = spawnSync(process.execPath, [path.join(out, 'concord/scripts/concord.mjs'), 'models', '--json'], { encoding: 'utf8', env: t.env });
    assert.deepEqual(Object.keys(JSON.parse(m.stdout).routing.packaged_agents), ['fable-worker', 'opus-worker']);
    const applied = spawnSync(process.execPath, [path.join(out, 'concord/scripts/concord.mjs'), 'models', '--routing', path.join(out, 'concord/policy/routing.sample.json')], { encoding: 'utf8', env: t.env });
    assert.equal(applied.status, 0, applied.stdout);
  });
});
