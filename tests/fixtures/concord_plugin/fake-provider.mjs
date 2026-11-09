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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const write = (text) => fs.writeSync(1, text);
const line = (o) => write(`${JSON.stringify(o)}\n`);

if (provider === 'grok' && argv.includes('--help')) {
  // Same shape as the real CLI's help; FAKE_GROK_FORMATS lets tests simulate an older CLI without streaming-json.
  const formats = process.env.FAKE_GROK_FORMATS || 'plain, json, streaming-json, streaming-messages-json';
  process.stdout.write(`Grok Build TUI\n\nOptions:\n      --output-format <OUTPUT_FORMAT>\n          Output format for headless mode [default: plain] [possible values: ${formats}]\n`);
  process.exit(0);
}

const prompt = provider === 'codex' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg('--prompt-file'), 'utf8');
const id = prompt.match(/technical id: ([a-z_]+)/)?.[1];
const role = prompt.includes('Fast policy') ? 'proposal_plan' : id;
log({ provider, role, argv, cwd: process.cwd() });
const r = next(role);

// Optional scenario controls: $silent_ms (no output at first), $hold_ms (pause after the first event so a
// reader can observe a live log), $mode (grok stream shape), $pieces (raw stdout writes), $delay_ms.
if (r?.$silent_ms) await sleep(r.$silent_ms);
if (r?.$hang) hang();
else if (r?.$exit !== undefined) { process.stderr.write('fake failure\n'); process.exit(r.$exit); }
else {
  if (r?.$touch) fs.appendFileSync(path.join(arg('-C') ?? process.cwd(), r.$touch), 'x');
  const body = r?.$raw ?? JSON.stringify(r?.$touch ? DEFAULTS[role] : r);
  const hold = async () => { if (r?.$hold_ms) await sleep(r.$hold_ms); };
  if (r?.$pieces) {
    for (const p of r.$pieces) { fs.writeSync(1, typeof p === 'string' ? Buffer.from(p) : Buffer.from(p.hex, 'hex')); await sleep(r.$delay_ms ?? 30); }
    if (provider === 'codex' && !r.$no_last) fs.writeFileSync(arg('-o'), body);
  } else if (provider === 'codex') {
    if (argv.includes('--json')) {
      line({ type: 'thread.started', thread_id: 't-fake' });
      line({ type: 'turn.started' });
      line({ type: 'item.started', item: { id: 'i1', type: 'reasoning' } });
      await hold();
      line({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: body } });
      // $mode: error = unrecovered trailing error; turn_failed = terminal turn.failed; truncated = no terminal event;
      // recovered = a transient error followed by a successful turn.completed.
      if (r?.$mode === 'error') line({ type: 'error', message: 'codex stream failure' });
      else if (r?.$mode === 'turn_failed') line({ type: 'turn.failed', error: { message: 'codex turn failed hard' } });
      else if (r?.$mode === 'truncated') { /* stream just stops */ }
      else {
        if (r?.$mode === 'recovered') line({ type: 'error', message: 'transient reconnect' });
        line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
      }
    }
    if (r?.$mode !== 'no_last') fs.writeFileSync(arg('-o'), body);
  } else {
    const fmtName = arg('--output-format');
    if (fmtName === 'streaming-json' && r?.$mode !== 'legacy') {
      line({ type: 'x.ai/session', phase: 'started' });
      line({ type: 'thought', data: 'SECRET-INTERNAL-THOUGHT' });
      await hold();
      const third = Math.ceil(body.length / 3);
      const chunks = [body.slice(0, third), body.slice(third, 2 * third), body.slice(2 * third)];
      if (r?.$mode === 'malformed_final') chunks.splice(0, chunks.length, 'this is {not valid json');
      for (const [i, c] of chunks.entries()) {
        const l = `${JSON.stringify({ type: 'text', data: c })}\n`;
        if (r?.$split_bytes && i === 0) {
          const buf = Buffer.from(l); const cut = buf.indexOf(0xe5) >= 0 ? buf.indexOf(0xe5) + 1 : Math.floor(buf.length / 2);
          fs.writeSync(1, buf.subarray(0, cut)); await sleep(60); fs.writeSync(1, buf.subarray(cut));
        } else write(l);
        await sleep(r?.$delay_ms ?? 5);
      }
      line({ type: 'tool_call', title: 'noop', kind: 'other', status: 'completed' });
      line({ type: 'usage', input_tokens: 3, output_tokens: 4 });
      if (r?.$mode === 'error') line({ type: 'error', message: 'grok stream failure' });
      else if (r?.$mode !== 'no_end') line({ type: 'end', sessionId: 'fake-session' });
    } else if (fmtName === 'streaming-json' || fmtName === 'json') {
      await hold();
      process.stdout.write(JSON.stringify({ text: body }));
    } else process.stdout.write(body);
  }
}
