// Deterministic stand-in for the codex / grok CLIs (no network, no models).
// Usage (via wrapper): node fake-provider.mjs <codex|grok> ...real CLI argv
// FAKE_SCENARIO: JSON file {role: [response, ...]}; a response is an output
// object, or {"$raw": text} | {"$exit": n} | {"$hang": true} | {"$touch": relpath}.
// FAKE_CALLS: JSONL log of every invocation.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [provider, ...argv] = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

const DEFAULTS = {
  proposal: { summary: 'Set app.txt to done', approach: 'Edit app.txt', risks: [], files: ['app.txt'] },
  review: { verdict: 'approve', summary: 'Looks right', concerns: [], required_changes: [] },
  plan: { summary: 'One task', tasks: [{ id: 'T1', title: 'Update app.txt', description: 'Write done into app.txt', files: ['app.txt'], depends_on: [], difficulty: 'low', risk: 'low' }] },
  qa: { verdict: 'pass', summary: 'All good', findings: [] },
};
DEFAULTS.proposal_plan = { proposal: DEFAULTS.proposal, plan: DEFAULTS.plan };

function log(entry) {
  if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, `${JSON.stringify(entry)}\n`);
}

function next(role) {
  const file = process.env.FAKE_SCENARIO;
  if (!file || !fs.existsSync(file)) return DEFAULTS[role];
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  const counterFile = `${file}.count.json`;
  const counts = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, 'utf8')) : {};
  const i = counts[role] ?? 0;
  counts[role] = i + 1;
  fs.writeFileSync(counterFile, JSON.stringify(counts));
  const list = scenario[role];
  return list && i < list.length ? list[i] : DEFAULTS[role];
}

function hang() {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (process.env.FAKE_GRANDCHILD) fs.writeFileSync(process.env.FAKE_GRANDCHILD, String(g.pid));
  setInterval(() => {}, 1000);
}

if (argv[0] === 'debug' && argv[1] === 'models') {
  log({ provider, argv, cwd: process.cwd() });
  // FAKE_CODEX_MODELS_BYTES pads each entry like the real catalog (long description and
  // base_instructions, capability fields) until the envelope reaches roughly that size.
  const target = Number(process.env.FAKE_CODEX_MODELS_BYTES || 0);
  const pad = target ? 'x'.repeat(Math.ceil(target / 6)) : undefined;
  const entry = (slug, extra = {}) => ({ slug, display_name: slug, visibility: 'list', ...extra,
    ...(pad ? { description: pad, base_instructions: pad, supported_reasoning_levels: [{ effort: 'low', description: 'fast' }] } : {}) });
  const body = JSON.stringify({ models: [entry('gpt-test-1'), entry('gpt-hidden', { visibility: 'hide' }), entry('gpt-test-2')] });
  fs.writeSync(1, body);
  process.exit(0);
}
if (argv[0] === 'models') {
  log({ provider, argv, cwd: process.cwd() });
  process.stdout.write('Grok CLI\nAvailable models:\n  * grok-test-a (default)\n  * grok-test-b\n\nMore text\n');
  process.exit(0);
}

const prompt = provider === 'codex' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg('--prompt-file'), 'utf8');
const id = prompt.match(/technical id: ([a-z_]+)/)?.[1];
const role = prompt.includes('Fast policy') ? 'proposal_plan' : id;
log({ provider, role, argv, cwd: process.cwd() });
const r = next(role);

if (r?.$hang) hang();
else if (r?.$exit !== undefined) { process.stderr.write('fake failure\n'); process.exit(r.$exit); }
else {
  if (r?.$touch) fs.appendFileSync(path.join(arg('-C') ?? process.cwd(), r.$touch), 'x');
  const body = r?.$raw ?? JSON.stringify(r?.$touch ? DEFAULTS[role] : r);
  if (provider === 'codex') fs.writeFileSync(arg('-o'), body);
  else process.stdout.write(JSON.stringify({ text: body }));
}
