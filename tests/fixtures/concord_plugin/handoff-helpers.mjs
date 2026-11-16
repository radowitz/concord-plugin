// Shared helpers for the handoff test files (not a test file itself): a temporary git repository, fake
// codex/grok CLIs, a fake Codex model catalog with invented slugs. No network, no real models, no real limits.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
export const PLUGIN = path.join(ROOT, 'plugins/concord');
export const CLI = path.join(PLUGIN, 'scripts/concord.mjs');
const FAKE = path.join(HERE, 'fake-provider.mjs');
export const TEST_OK = [process.execPath, '-e', "process.exit(require('fs').readFileSync('app.txt','utf8').trim()==='done'?0:1)"];
export const LIMIT = 'Claude usage limit reached. Your limit will reset at 3pm (UTC).';
const temps = [];
export const cleanup = () => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); };

// Shaped like real `codex debug models` output (including text that must never be cached); every slug is invented.
export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const model = (slug, description, priority, extra = {}) => ({ slug, display_name: slug.toUpperCase(), description, priority, visibility: 'list', default_reasoning_level: 'medium',
  supported_reasoning_levels: LEVELS.map((effort) => ({ effort, description: `${effort} reasoning` })), shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', tool_mode: 'code_mode_only',
  base_instructions: 'SECRET-BASE-INSTRUCTIONS you are a coding agent …', supported_in_api: true, ...extra });
export const CATALOG = { models: [
  model('cx-work', 'Latest workhorse model for coding and everyday work.', 1),
  model('cx-deep', 'Frontier intelligence for the most demanding work.', 2),
  model('cx-plain', 'A Codex model.', 3),
  model('cx-work-old', 'Previous generation workhorse model.', 4),
  model('cx-secret', 'Fast and affordable agentic coding model.', 5, { visibility: 'hide' }),
  model('cx-quick', 'Fast and affordable model for easier tasks.', 6),
  model('cx-quick-old', 'Older fast and efficient model.', 7),
  model('cx-auto-review', 'Automatic approval review model for Codex.', 8, { visibility: 'hide' }),
] };

let t; // the current sandbox (set by fresh())
let seq = 0;
export const nextSeq = () => seq++;

export function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** A fresh temporary repository + fake CLIs; becomes the sandbox every helper below acts on. */
export function fresh() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'concord-handoff-test-')));
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
  const catalog = path.join(root, 'catalog.json');
  fs.writeFileSync(catalog, JSON.stringify(CATALOG));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONCORD_CODEX_BIN: path.join(bin, 'codex'), CONCORD_GROK_BIN: path.join(bin, 'grok'),
    CONCORD_CACHE_DIR: path.join(root, 'cache'), CONCORD_MODEL_DISCOVERY: 'off', FAKE_CALLS: path.join(root, 'calls.jsonl'), FAKE_SCENARIO: path.join(root, 'scenario.json'),
    FAKE_CODEX_MODELS_FILE: catalog,
    // A key in the session must never reach a handoff call (and never be used for billing).
    OPENAI_API_KEY: 'sk-test-must-be-stripped', CODEX_API_KEY: 'sk-test-must-be-stripped' };
  for (const k of ['CONCORD_STATE_DIR', 'FAKE_CODEX_LOGIN', 'FAKE_CODEX_MODELS_FAIL', 'CONCORD_HEARTBEAT_MS']) delete env[k];
  t = { root, repo, env, catalog };
  return t;
}

export function cliIn(cwd, args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: t.env, encoding: 'utf8', ...opts });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
export const cli = (...args) => cliIn(t.repo, args);
export const calls = () => { try { return fs.readFileSync(t.env.FAKE_CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const roles = () => calls().map((c) => c.role);
export const count = (role) => roles().filter((x) => x === role).length;
export const scenario = (obj) => { fs.writeFileSync(t.env.FAKE_SCENARIO, JSON.stringify(obj)); fs.rmSync(`${t.env.FAKE_SCENARIO}.count.json`, { force: true }); };
export const file = (text, ext = 'txt') => { const f = path.join(t.root, `f-${seq++}.${ext}`); fs.writeFileSync(f, text); return f; };
export const runDirOf = (id) => path.join(t.repo, '.git/concord/runs', id);
export const runJson = (id) => JSON.parse(fs.readFileSync(path.join(runDirOf(id), 'run.json'), 'utf8'));
export const patchRun = (id, fn) => { const f = path.join(runDirOf(id), 'run.json'); const r = JSON.parse(fs.readFileSync(f, 'utf8')); fn(r); fs.writeFileSync(f, JSON.stringify(r)); };
export const app = () => fs.readFileSync(path.join(t.repo, 'app.txt'), 'utf8');
export const edit = (content = 'done\n') => fs.writeFileSync(path.join(t.repo, 'app.txt'), content);
export const arg = (argv, flag) => argv[argv.indexOf(flag) + 1];

export function start(spec = {}) {
  return cli('start', '--spec', file(JSON.stringify({ request: 'Make app.txt say done', tests: [TEST_OK], ...spec }), 'json'));
}
/** A run waiting for the Claude session to do its first native step. */
export function pending(spec) {
  const s = start(spec);
  assert.equal(s.code, 0, s.out);
  const a = cli('advance', s.json.run);
  assert.equal(a.json.action, 'implement', a.out);
  return s.json.run;
}
export const quota = (id, text = LIMIT, step = 'task-T1', rev = '1') => cli('quota', id, '--step', step, '--revision', rev, '--note-file', file(text));
export const prepare = (id, ...extra) => cli('takeover', id, '--writer-stopped', '--json', ...extra);
export const decide = (id, pid, decision, ...extra) => cli('takeover', id, '--proposal', pid, '--decision', decision, ...extra);
export const approve = (id, pid) => decide(id, pid, 'approve', '--writer-stopped');
/** Limit report → proposal → explicit consent. Returns the proposal. */
export function handoff(id, ...extra) {
  const p = prepare(id, ...extra);
  assert.equal(p.code, 0, p.out + p.err);
  const a = approve(id, p.json.proposal.id);
  assert.equal(a.json.consented, true, a.out + a.err);
  return p.json.proposal;
}
export const WRITE_DONE = { $write: { 'app.txt': 'done\n' } };
export const planOf = (tasks) => ({ plan: [{ summary: 'plan', tasks }] });
export const task = (id, extra = {}) => ({ id, title: `Task ${id}`, description: `Do ${id}`, files: ['app.txt'], depends_on: [], difficulty: 'low', risk: 'low', ...extra });
