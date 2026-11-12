// Claude worker routing (吏部选才): capability tier → requested candidate, a local per-user
// routing profile, a per-run frozen snapshot, and an advisory outcome ledger.
//
// Vocabulary kept strictly apart:
//   capability tier  haiku | sonnet | opus (low / normal / hard work; NOT a model name)
//   candidate        what is REQUESTED from Claude Code: an Agent-tool alias, or a packaged
//                    named agent whose frontmatter pins a full model ID and an effort
//   actual model     never observed by this helper; never recorded as known
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './state.mjs';
import { CLAUDE_ALIASES, CLAUDE_TIERS, MODEL_ID, cacheDir } from './models.mjs';
import { TTL_MS, tryLock } from './discovery.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEY = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const TIER_ALIAS = { low: 'haiku', medium: 'sonnet', normal: 'sonnet', high: 'opus', hard: 'opus' };
// Highest capability tier a known family may serve (official guidance on what each family is for;
// a family is never ranked by its version number). Unknown families need explicit `tiers`.
const FAMILY_CEILING = { haiku: 0, sonnet: 1, opus: 2, fable: 2 };
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_LEDGER_RUNS = 200;
const MAX_TURNAROUND_MS = 6 * 3600 * 1000;
export const MIN_SAMPLES = 3;
export const MIN_SPEEDUP = 0.2;
export const CAVEAT = 'Requested, not observed: the helper never sees which model actually ran. Published docs are not an account list; availability for your account/provider is unverified.';
export const PREFERENCE_NOTE = 'User policy: hard work prefers Fable 5.2 at high effort, with Opus 5.5 at xhigh effort as the declared fallback. This is a user preference, not a benchmark result.';

/** Built-in default = the user's stated preference. Kept identical to policy/routing.sample.json (tested). */
export const DEFAULT_PROFILE = {
  schema: 1,
  name: 'fable-high-preferred',
  note: PREFERENCE_NOTE,
  candidates: {
    haiku: { alias: 'haiku', tiers: ['haiku'] },
    sonnet: { alias: 'sonnet', tiers: ['sonnet'] },
    'opus-alias': { alias: 'opus', tiers: ['opus'] },
    'fable-alias': { alias: 'fable', tiers: ['opus'] },
    'fable-5.2-high': { agent: 'fable-worker', tiers: ['opus'] },
    'opus-5.5-xhigh': { agent: 'opus-worker', tiers: ['opus'] },
  },
  routes: {
    haiku: { primary: 'haiku', fallback: null },
    sonnet: { primary: 'sonnet', fallback: null },
    opus: { primary: 'fable-5.2-high', fallback: 'opus-5.5-xhigh' },
  },
  baselines: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus-5.5-xhigh' },
  overrides: { opus: 'opus-5.5-xhigh', fable: 'fable-5.2-high' },
};

export const profileFile = () => path.join(cacheDir(), 'routing.json');
export const ledgerFile = () => path.join(cacheDir(), 'outcomes.json');
const rank = (tier) => CLAUDE_TIERS.indexOf(tier);
const topTier = (tiers) => [...tiers].sort((a, b) => rank(b) - rank(a))[0];

// ------------------------------------------------------------------ packaged agents

/** Named agents shipped in <plugin>/agents/*.md. Their frontmatter is the only source of full model IDs. */
export function listAgents(root = PLUGIN_ROOT) {
  const out = {};
  let plugin = 'concord';
  try { plugin = readJson(path.join(root, '.claude-plugin', 'plugin.json')).name || plugin; } catch { /* default */ }
  let names = [];
  try { names = fs.readdirSync(path.join(root, 'agents')).filter((n) => n.endsWith('.md')).sort(); } catch { /* none */ }
  for (const n of names) {
    const m = fs.readFileSync(path.join(root, 'agents', n), 'utf8').match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = Object.fromEntries(m[1].split('\n').map((l) => l.match(/^([A-Za-z]+):\s*(.*?)\s*$/)).filter(Boolean).map((x) => [x[1], x[2]]));
    const name = n.slice(0, -3);
    if (fm.name !== name || !KEY.test(name) || !MODEL_ID.test(fm.model ?? '') || !/^claude-/.test(fm.model) || !EFFORTS.includes(fm.effort)) continue;
    out[name] = { subagent_type: `${plugin}:${name}`, model: fm.model, effort: fm.effort };
  }
  return out;
}

const familyOf = (c) => (c.kind === 'alias' ? c.alias : (c.pinned_model.match(/^claude-([a-z]+)-/)?.[1] ?? null));

// ------------------------------------------------------------------ profile validation

const fail = (msg) => { throw new Error(`routing profile: ${msg}`); };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const tierName = (t) => (CLAUDE_TIERS.includes(t) ? t : TIER_ALIAS[t] ?? fail(`unknown capability tier ${JSON.stringify(t)} (use haiku|sonnet|opus or low|medium|high)`));

/**
 * Validate a user profile (an overlay on the built-in default) and return the full policy with
 * every candidate resolved to something Claude Code can be asked for. Nothing here accepts a free
 * model string: aliases come from the documented Agent-tool set (or a published alias the profile
 * explicitly marks host_compatible), full IDs only from packaged agents.
 */
export function buildPolicy(raw, { agents = listAgents(), discovered = [] } = {}) {
  if (!isObj(raw)) fail('must be a JSON object');
  for (const k of Object.keys(raw)) if (!['schema', 'name', 'note', 'candidates', 'routes', 'baselines', 'overrides'].includes(k)) fail(`unknown key ${k}`);
  if (raw.schema !== undefined && raw.schema !== 1) fail('schema must be 1');
  const text = (v, max, what) => { if (v !== undefined && (typeof v !== 'string' || v.length > max)) fail(`${what} must be a string (≤ ${max} chars)`); return v; };
  for (const k of ['candidates', 'routes', 'baselines', 'overrides']) if (raw[k] !== undefined && !isObj(raw[k])) fail(`${k} must be an object`);
  const merged = { ...DEFAULT_PROFILE.candidates, ...(raw.candidates ?? {}) };
  if (Object.keys(merged).length > 24) fail('too many candidates (max 24)');
  const candidates = {};
  for (const [key, c] of Object.entries(merged)) {
    if (!KEY.test(key)) fail(`invalid candidate key ${JSON.stringify(key)}`);
    if (!isObj(c)) fail(`candidate ${key} must be an object`);
    for (const k of Object.keys(c)) if (!['alias', 'agent', 'tiers', 'host_compatible'].includes(k)) fail(`candidate ${key}: unknown key ${k}`);
    if ((c.alias === undefined) === (c.agent === undefined)) fail(`candidate ${key} needs exactly one of "alias" or "agent"`);
    if (!Array.isArray(c.tiers) || !c.tiers.length) fail(`candidate ${key} needs "tiers": the capability tiers it may serve`);
    const tiers = [...new Set(c.tiers.map(tierName))].sort((a, b) => rank(a) - rank(b));
    let r;
    if (c.alias !== undefined) {
      if (typeof c.alias !== 'string' || !/^[a-z]{3,20}$/.test(c.alias)) fail(`candidate ${key}: alias must be a plain family alias`);
      if (!CLAUDE_ALIASES.includes(c.alias)) {
        if (!discovered.includes(c.alias)) fail(`candidate ${key}: "${c.alias}" is neither a documented Agent-tool alias (${CLAUDE_ALIASES.join('|')}) nor in the published-docs cache; full model IDs are only reachable through a packaged agent (${Object.keys(agents).join(', ') || 'none'})`);
        if (c.host_compatible !== true) fail(`candidate ${key}: alias "${c.alias}" is published but not a documented Agent-tool value; set "host_compatible": true only if your Claude Code accepts it`);
      }
      r = { key, kind: 'alias', alias: c.alias, subagent_type: 'general-purpose', pinned_model: null, effort: null, tiers, ...(CLAUDE_ALIASES.includes(c.alias) ? {} : { host_compatible: 'asserted by profile' }) };
    } else {
      const a = agents[c.agent];
      if (typeof c.agent !== 'string' || !a) fail(`candidate ${key}: "${c.agent}" is not a packaged agent (${Object.keys(agents).join(', ') || 'none'})`);
      r = { key, kind: 'agent', agent: c.agent, alias: null, subagent_type: a.subagent_type, pinned_model: a.model, effort: a.effort, tiers };
    }
    const ceil = FAMILY_CEILING[familyOf(r)];
    if (ceil !== undefined && rank(topTier(tiers)) > ceil) fail(`candidate ${key} (${familyOf(r)} family) may not serve the ${topTier(tiers)} capability tier: that would downgrade harder work`);
    candidates[key] = r;
  }
  const eligible = (key, tier, what) => {
    if (typeof key !== 'string' || !candidates[key]) fail(`${what} names unknown candidate ${JSON.stringify(key)}`);
    if (!candidates[key].tiers.includes(tier)) fail(`${what}: candidate ${key} is not eligible for the ${tier} tier (its tiers: ${candidates[key].tiers.join(', ')})`);
    return key;
  };
  const byTier = (obj) => Object.fromEntries(Object.entries(obj ?? {}).map(([t, v]) => [tierName(t), v]));
  const rawRoutes = { ...DEFAULT_PROFILE.routes, ...byTier(raw.routes) };
  const rawBase = { ...DEFAULT_PROFILE.baselines, ...byTier(raw.baselines) };
  const routes = {}; const baselines = {};
  for (const tier of CLAUDE_TIERS) {
    const rt = rawRoutes[tier];
    if (!isObj(rt)) fail(`routes.${tier} must be {primary, fallback}`);
    for (const k of Object.keys(rt)) if (!['primary', 'fallback'].includes(k)) fail(`routes.${tier}: unknown key ${k}`);
    const primary = eligible(rt.primary, tier, `routes.${tier}.primary`);
    const fallback = rt.fallback === null || rt.fallback === undefined ? null : eligible(rt.fallback, tier, `routes.${tier}.fallback`);
    if (fallback === primary) fail(`routes.${tier}: fallback must differ from primary`);
    routes[tier] = { primary, fallback };
    baselines[tier] = eligible(rawBase[tier], tier, `baselines.${tier}`);
  }
  const overrides = {};
  for (const [token, key] of Object.entries({ ...DEFAULT_PROFILE.overrides, ...(raw.overrides ?? {}) })) {
    if (!KEY.test(token)) fail(`invalid override token ${JSON.stringify(token)}`);
    if (typeof key !== 'string' || !candidates[key]) fail(`overrides.${token} names unknown candidate ${JSON.stringify(key)}`);
    overrides[token] = key;
  }
  return { schema: 1, name: text(raw.name, 80, 'name') ?? DEFAULT_PROFILE.name, note: text(raw.note, 500, 'note') ?? DEFAULT_PROFILE.note, candidates, routes, baselines, overrides };
}

/** Active policy: the stored user profile when there is one, else the built-in default. Local files only. */
export function loadPolicy({ agents = listAgents(), discovered = [] } = {}) {
  let stored = null;
  try { stored = readJson(profileFile()); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`stored routing profile ${profileFile()} is unreadable (${e.message}); fix it or run \`models --reset-routing\``); }
  if (!stored) return { ...buildPolicy({}, { agents, discovered }), source: 'built-in default', stored_at: null };
  try {
    return { ...buildPolicy(stored.profile, { agents, discovered }), source: `user profile ${profileFile()}`, stored_at: stored.stored_at ?? null };
  } catch (e) {
    throw new Error(`stored ${e.message}. Re-apply a valid file with \`models --routing FILE\` or restore the default with \`models --reset-routing\``);
  }
}

export function storeProfile(file, opts = {}) {
  const st = fs.statSync(file);
  if (!st.isFile() || st.size > MAX_PROFILE_BYTES) fail(`${file} must be a regular file ≤ ${MAX_PROFILE_BYTES} bytes`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`invalid JSON: ${e.message}`); }
  const policy = buildPolicy(raw, opts); // throws before anything is written
  const stored_at = new Date().toISOString();
  writeJson(profileFile(), { schema: 1, stored_at, profile: raw });
  return { ...policy, source: `user profile ${profileFile()}`, stored_at };
}

export function resetProfile() {
  try { fs.unlinkSync(profileFile()); return true; } catch { return false; }
}

// ------------------------------------------------------------------ routes

export const candidateLabel = (c) => (c.kind === 'agent'
  ? `${c.pinned_model} · effort ${c.effort} (packaged agent ${c.subagent_type})`
  : `alias ${c.alias} (version resolved by Claude Code)`);

export function readiness(c, catalog) {
  if (c.kind === 'agent') return `pinned full ID ${c.pinned_model} at effort ${c.effort} in the packaged agent ${c.subagent_type}; a pin does not move when newer models are published; needs a Claude Code version and account that support this model and effort (not verified)`;
  const pub = catalog?.aliases?.includes(c.alias);
  return `${CLAUDE_ALIASES.includes(c.alias) ? 'documented Agent-tool alias' : 'published alias, host compatibility asserted by the profile only'}; ${catalog?.fetched_at ? (pub ? `listed in the published docs fetched ${catalog.fetched_at}` : `not in the published docs fetched ${catalog.fetched_at}`) : 'no published-docs cache'}; Claude Code resolves the version; account availability not verified`;
}

function mkRoute(routing, key, extra) {
  const c = routing.policy.candidates[key];
  return { candidate: key, kind: c.kind, subagent_type: c.subagent_type, model: c.alias, pinned_model: c.pinned_model, effort: c.effort, label: candidateLabel(c), fallback: null, ...extra };
}

/** Policy route for a capability tier (primary + declared fallback). */
export function routeForTier(routing, tier) {
  const rt = routing.policy.routes[tier];
  return mkRoute(routing, rt.primary, { source: 'policy', fallback: rt.fallback,
    reason: `${routing.policy.source}: ${tier} capability tier → ${rt.primary}${rt.fallback ? ` (declared fallback ${rt.fallback})` : ''}` });
}

/** Resolve a worker/repair override token (shorthand or candidate key). Throws on anything not in the policy. */
export function resolveOverride(policy, token) {
  const key = typeof token === 'string' ? (policy.overrides[token] ?? token) : null;
  if (!key || !policy.candidates[key]) {
    throw new Error(`${JSON.stringify(token)} is not a routable worker choice. Use one of: ${[...new Set([...Object.keys(policy.overrides), ...Object.keys(policy.candidates)])].join(', ')}. ` +
      'Full model IDs cannot be passed to the Agent tool; they are only reachable through a packaged agent registered in the routing profile');
  }
  return key;
}

/** Explicit override: the user's choice, no fallback (a failure is reported, never papered over). */
export function routeForOverride(routing, token, role) {
  const key = resolveOverride(routing.policy, token);
  const c = routing.policy.candidates[key];
  return { tier: topTier(c.tiers), route: mkRoute(routing, key, { source: 'override', reason: `per-role override (models.${role}=${token})` }) };
}

export function fallbackRoute(routing, route, why) {
  if (!route?.fallback) return null;
  return mkRoute(routing, route.fallback, { source: 'fallback', primary: route.candidate, fallback_used: true, fallback_reason: why,
    reason: `declared fallback for ${route.candidate}, switched explicitly after a reported host/model error` });
}

/** Exactly what to pass to the Agent tool. A packaged agent pins its model: passing `model` would override the pin. */
export const agentCall = (route) => (route.kind === 'agent' ? { subagent_type: route.subagent_type } : { subagent_type: 'general-purpose', model: route.model });

/** Snapshot stored in run.json at admission; later profile/catalog changes never reach this run. */
export function freezeRouting(policy, discovery, state, now = Date.now()) {
  const catalog = discovery?.fetched_at
    ? { source: discovery.source, fetched_at: discovery.fetched_at, aliases: discovery.aliases.map((a) => a.alias), anthropic_api_resolution: discovery.anthropic_api_resolution ?? null,
      stale: now - Date.parse(discovery.fetched_at) > TTL_MS, last_failure: discovery.last_failure ?? null }
    : { source: discovery?.source ?? null, fetched_at: null, aliases: [], stale: true, last_failure: discovery?.last_failure ?? null };
  return { schema: 1, frozen_at: new Date(now).toISOString(), policy, catalog: { ...catalog, refresh: state },
    caveat: CAVEAT, note: 'Frozen at start: models --refresh / --routing / --reset-routing affect only later runs.' };
}

// ------------------------------------------------------------------ outcome ledger (advisory)

export function loadLedger() {
  try { const l = readJson(ledgerFile()); return l?.schema === 1 && Array.isArray(l.runs) ? l : { schema: 1, runs: [] }; } catch { return { schema: 1, runs: [] }; }
}

/**
 * Strict eligibility: only a human-approved, validated run whose every task ran once in a native
 * subagent on ONE requested candidate, with no repair, amendment, fallback, failure or interruption.
 * Anything else is excluded (never counted for or against a model).
 */
export function outcomeSample(run) {
  const no = (reason) => ({ sample: null, reason });
  if (!run.routing) return no('legacy run without frozen routing');
  if (run.status !== 'approved' || !run.validation) return no('not an approved validated run');
  if ((run.revision ?? 1) !== 1 || run.amendments?.length) return no('amended run');
  if (run.repairs_used > 0 || run.steps.some((s) => s.role === 'repair')) return no('run needed a repair');
  if (run.invalidated?.length) return no('validation was invalidated during the run');
  if (run.route_events?.length) return no('a fallback switch happened');
  if (run.steps.some((s) => ['failed', 'tests_failed', 'interrupted', 'cancelled', 'invalidated'].includes(s.status))) return no('run had a failed, interrupted or invalidated step');
  const native = run.steps.filter((s) => s.role === 'task');
  if (!run.tasks.length || native.length !== run.tasks.length) return no('task steps do not match tasks one-to-one');
  if (native.some((s) => s.executor !== 'subagent')) return no('main-session execution (inherited, unknown model)');
  const keys = new Set(run.tasks.map((t) => t.route?.candidate));
  if (keys.size !== 1 || keys.has(undefined)) return no('mixed requested models in one run');
  if (run.tasks.some((t) => rank(t.tier) < rank(t.computed_tier))) return no('override below the task capability tier');
  const tasks = [];
  for (const t of run.tasks) {
    const s = native.find((x) => x.id === `task-${t.id}`);
    if (!s || s.model?.requested !== t.route.candidate) return no('step/route mismatch');
    if (Number.isInteger(s.turnaround_ms) && s.turnaround_ms > 0 && s.turnaround_ms <= MAX_TURNAROUND_MS) {
      tasks.push({ id: t.id, tier: t.computed_tier, difficulty: t.difficulty, risk: t.risk, turnaround_ms: s.turnaround_ms });
    }
  }
  if (!tasks.length) return no('no measured assignment turnaround');
  const r0 = run.tasks[0].route;
  return { reason: null, sample: { run: run.id, approved_at: run.approval?.at ?? null, candidate: r0.candidate,
    requested: { kind: r0.kind, alias: r0.model, subagent_type: r0.subagent_type, pinned_model: r0.pinned_model, effort: r0.effort }, source: r0.source, tasks } };
}

/** Append one run's sample (dedup by run id, bounded history, atomic write under a short file lock). */
export function recordOutcome(run) {
  const { sample, reason } = outcomeSample(run);
  if (!sample) return { recorded: false, reason };
  const file = ledgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let release = null;
  for (let i = 0; i < 40 && !(release = tryLock(file)); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  if (!release) return { recorded: false, reason: 'outcome ledger busy' };
  try {
    const l = loadLedger();
    if (l.runs.some((r) => r.run === sample.run)) return { recorded: false, reason: 'run already recorded' };
    l.runs = [...l.runs, sample].slice(-MAX_LEDGER_RUNS);
    writeJson(file, l);
    return { recorded: true, candidate: sample.candidate, tasks: sample.tasks.length };
  } finally { release(); }
}

export function resetLedger() {
  try { fs.unlinkSync(ledgerFile()); return true; } catch { return false; }
}

/**
 * Canonical identity of what was REQUESTED. A candidate key is only a local name: a profile can point
 * the same key at another alias or packaged model/effort, so evidence is bound to this, not to the key.
 * (An alias identity is still version-unobserved: Claude Code decides what the alias runs.)
 */
export const requestIdentity = (c) => (c && ['alias', 'agent'].includes(c.kind) && typeof c.subagent_type === 'string'
  ? [c.kind, c.alias ?? '', c.subagent_type, c.pinned_model ?? '', c.effort ?? ''].join('|') : null);

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

/**
 * Advisory comparison per cohort (capability tier + planned difficulty + risk). Never changes routing:
 * the profile is the only promotion gate. A candidate is "advisory_faster" only with ≥ 3 clean samples
 * for it AND for the tier's baseline in the same cohort, and a ≥ 20 % lower median turnaround.
 */
export function compareOutcomes(ledger, policy) {
  const cohorts = {};
  // Only samples whose recorded request still equals what the key means in the CURRENT policy are compared.
  const excluded = { missing_identity: 0, unknown_candidate: 0, obsolete_identity: 0 };
  let used = 0;
  for (const r of ledger.runs) {
    const then = requestIdentity(r.requested);
    const c = policy.candidates[r.candidate];
    if (!then) { excluded.missing_identity += 1; continue; }
    if (!c) { excluded.unknown_candidate += 1; continue; }
    if (then !== requestIdentity(c)) { excluded.obsolete_identity += 1; continue; }
    used += 1;
    for (const t of r.tasks) ((cohorts[`${t.tier}/${t.difficulty}/${t.risk}`] ??= {})[r.candidate] ??= []).push(t.turnaround_ms);
  }
  const out = [];
  for (const [cohort, by] of Object.entries(cohorts).sort()) {
    const tier = cohort.split('/')[0];
    const baseline = policy.baselines[tier];
    const base = by[baseline] ?? [];
    const candidates = Object.entries(by).sort().map(([key, ms]) => {
      const row = { candidate: key, samples: ms.length, median_ms: median(ms), role: key === baseline ? 'baseline' : 'candidate' };
      if (key === baseline) return row;
      if (!policy.candidates[key]?.tiers.includes(tier)) return { ...row, verdict: 'not_eligible_for_tier' };
      if (ms.length < MIN_SAMPLES || base.length < MIN_SAMPLES) return { ...row, verdict: 'no_qualifying_evidence', why: `needs ≥ ${MIN_SAMPLES} clean samples for both it (${ms.length}) and the baseline ${baseline} (${base.length})` };
      const speedup = (median(base) - row.median_ms) / median(base);
      return { ...row, speedup: Math.round(speedup * 1000) / 1000, verdict: speedup >= MIN_SPEEDUP ? 'advisory_faster' : 'no_clear_improvement' };
    });
    out.push({ cohort, baseline, baseline_samples: base.length, candidates });
  }
  return { cohorts: out, runs: ledger.runs.length, runs_compared: used, excluded,
    excluded_note: 'Excluded runs were recorded for a candidate key that is no longer in the policy, now means a different alias/agent/model/effort, or carry no request identity. They stay in the ledger but are never attributed to the current candidate.',
    note: `Advisory only; routing never changes automatically (edit the profile to promote). Timing is assignment turnaround (action issued → done recorded) of the REQUESTED candidate, a heuristic from your own approved runs, not a controlled benchmark and not evidence of which model actually ran. Thresholds: ≥ ${MIN_SAMPLES} samples per side, ≥ ${MIN_SPEEDUP * 100}% faster median.` };
}
