// Codex account model metadata (whitelisted, cached) and the per-tier routing table used ONLY by a
// consented Claude → Codex handoff. Nothing here runs inference: discovery is `codex debug models`
// (the CLI lists what the signed-in account can see), at most once per TTL, and only when a handoff
// is being prepared or the user runs `models --refresh`.
//
// Vocabulary: a Codex tier is low | normal | high (the task's capability class, mapped from the
// run's haiku | sonnet | opus tiers). It is never a model name and models are never ranked by
// version or by name. Picks come from an explicit per-tier override, else from the provider's own
// description text (a labelled heuristic), else no model is passed at all (provider default).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './proc.mjs';
import { readJson, writeJson } from './state.mjs';
import { MAX_BYTES, MODEL_ID, cacheDir } from './models.mjs';

export const CODEX_TIERS = ['low', 'normal', 'high'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh']; // the only efforts Concord ever passes
export const TTL_MS = 24 * 3600 * 1000;
export const SOURCE = 'local CLI: codex debug models';
export const CHATGPT_SCOPE = 'openai/chatgpt';
export const CHATGPT_ARGS = ['-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'];
export function chatgptEnv(env = process.env) {
  const out = { ...env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY']) delete out[key];
  return out;
}
export const HEURISTIC_NOTE = 'Heuristic from the provider\'s own model descriptions and declared reasoning levels. It is not a benchmark, not a ranking by version or name, and not proof that your account may use a model. Effort names are per model as declared by the provider; they are not comparable across model families or with Claude effort levels.';
const TIER_EFFORT = { low: 'low', normal: 'medium', high: 'high' };
const DISCOVERY_TIMEOUT_MS = 15000;
const MAX_MODELS = 100;

// Capability evidence is read from the DESCRIPTION only (never the slug or display name).
const EVIDENCE = {
  low: /\b(?:fast(?:er|est)?|efficient|affordable|lightweight|quick|easier|cheap(?:er)?)\b/gi,
  normal: /\b(?:workhorse|everyday|balanced|general[- ]purpose|day[- ]to[- ]day)\b/gi,
  high: /\b(?:frontier|demanding|most capable|most intelligent|hardest|flagship)\b/gi,
};
const SUPERSEDED = /\b(?:older|previous|legacy|deprecated|prior generation)\b/i;
const NOT_A_WRITER = /\b(?:auto[- ]?review|review model|internal)\b/i;

export const metadataFile = () => path.join(cacheDir(), 'codex-models.json');

const short = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) || null : null);
const token = (v) => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : null);

/**
 * Keep only the listed fields of each catalog entry. The real output also carries full base
 * instructions and other prompt text per model: none of that is ever stored, shown or forwarded.
 */
export function whitelistModels(value) {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? (value.models ?? value.data ?? value.result) : null;
  if (!Array.isArray(list)) return [];
  const out = []; const seen = new Set();
  for (const m of list) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    const slug = m.slug ?? m.id ?? m.model;
    if (typeof slug !== 'string' || !MODEL_ID.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const levels = Array.isArray(m.supported_reasoning_levels)
      ? [...new Set(m.supported_reasoning_levels.map((l) => token(typeof l === 'string' ? l : l?.effort)).filter(Boolean))].slice(0, 12) : [];
    out.push({ slug, display_name: short(m.display_name, 80), description: short(m.description, 240),
      priority: Number.isFinite(m.priority) ? m.priority : null, visibility: m.hidden === true ? 'hide' : token(m.visibility),
      default_reasoning_level: token(m.default_reasoning_level), supported_reasoning_levels: levels,
      shell_type: token(m.shell_type), apply_patch_tool_type: token(m.apply_patch_tool_type), tool_mode: token(m.tool_mode) });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

export function loadMetadata() {
  try { const c = readJson(metadataFile()); return c?.schema === 1 && Array.isArray(c.models) ? c : null; } catch { return null; }
}

function store(models, at, scope) {
  const c = { schema: 1, fetched_at: at, source: SOURCE, scope, models, last_failure: null };
  writeJson(metadataFile(), c);
  return c;
}

/** Cache metadata from raw `codex debug models` output (also fed by `models --refresh`). Throws when nothing is recognised. */
export function storeFromRaw(text, at = new Date().toISOString(), scope = 'cli_default') {
  const models = whitelistModels(JSON.parse(text));
  if (!models.length) throw new Error('no model list recognised in CLI output');
  return store(models, at, scope);
}

/**
 * Fresh-enough metadata for a handoff proposal. Within the TTL the cache is used as is (no CLI call).
 * Otherwise one bounded `codex debug models`; a failure keeps the last good cache and reports it as
 * stale, so the caller must show that before asking for consent.
 * Returns {state: fresh|refreshed|failed, cache, stale, error?}.
 */
export async function ensureMetadata(bin, { now = Date.now(), env = process.env, tmpDir = path.join(os.tmpdir(), `concord-codexmeta-${process.pid}`) } = {}) {
  // A catalog obtained with the user's arbitrary default provider is not an OpenAI/ChatGPT catalog.
  const loaded = loadMetadata();
  const cache = loaded?.scope === CHATGPT_SCOPE ? loaded : null;
  if (cache?.fetched_at && now - Date.parse(cache.fetched_at) < TTL_MS) return { state: 'fresh', cache, stale: false };
  const at = new Date(now).toISOString();
  fs.mkdirSync(tmpDir, { recursive: true });
  const outFile = path.join(tmpDir, 'codex-models.out');
  let error = null; let fresh = null;
  try {
    const r = await run([bin, 'debug', 'models', ...CHATGPT_ARGS], { timeoutMs: DISCOVERY_TIMEOUT_MS, stdoutPath: outFile, env: chatgptEnv(env) });
    error = r.error || (r.timedOut ? 'timed out' : r.code !== 0 ? `exit ${r.code ?? r.signal}` : null);
    if (!error) {
      const size = fs.statSync(outFile).size;
      if (size > MAX_BYTES.codex) throw new Error(`output too large (${size} bytes > ${MAX_BYTES.codex})`);
      fresh = storeFromRaw(fs.readFileSync(outFile, 'utf8'), at, CHATGPT_SCOPE);
    }
  } catch (e) { error = `unparseable output: ${e.message}`; }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* none */ }
  if (fresh) return { state: 'refreshed', cache: fresh, stale: false };
  const kept = cache ? { ...cache, last_failure: { at, error: String(error).slice(0, 200) } } : null;
  if (kept) { try { writeJson(metadataFile(), kept); } catch { /* cache is optional */ } }
  return { state: 'failed', error: String(error).slice(0, 200), cache: kept, stale: true };
}

/** Compact, displayable facts about where the routing table came from. */
export function catalogInfo(res, now = Date.now()) {
  const c = res?.cache;
  return { source: c?.source ?? SOURCE, scope: c?.scope ?? null, fetched_at: c?.fetched_at ?? null, refresh: res?.state ?? 'not attempted', stale: res ? res.stale === true : !c?.fetched_at || now - Date.parse(c.fetched_at) >= TTL_MS,
    error: res?.error ?? null, listed_models: c ? c.models.filter((m) => m.visibility === 'list').length : 0,
    ...(c ? {} : { note: 'no Codex model list is available: nothing can be verified against the account' }) };
}

// ------------------------------------------------------------------ routing

/** `low=<model>[@effort],normal=…,high=…` → {tier: {model, effort|null}}. Throws on anything else. */
export function parseRouteOverrides(text) {
  const out = {};
  if (text === undefined || text === null || text === '') return out;
  if (typeof text !== 'string' || text.length > 600) throw new Error('--codex-routes must be low=<model>[@effort],normal=…,high=…');
  for (const part of text.split(',')) {
    const m = /^(low|normal|high)=([^@=,\s]+)(?:@([a-z]+))?$/.exec(part.trim());
    if (!m) throw new Error(`--codex-routes: cannot read ${JSON.stringify(part)}; use low=<model>[@effort],normal=…,high=… (effort: ${EFFORTS.join('|')})`);
    const [, tier, model, effort] = m;
    if (out[tier]) throw new Error(`--codex-routes: ${tier} is given twice`);
    if (!MODEL_ID.test(model)) throw new Error(`--codex-routes: invalid model id ${JSON.stringify(model)}`);
    if (effort && !EFFORTS.includes(effort)) throw new Error(`--codex-routes: effort ${JSON.stringify(effort)} is not one of ${EFFORTS.join('|')}`);
    out[tier] = { model, effort: effort ?? null };
  }
  return out;
}

const eligible = (m) => m.visibility === 'list' && !NOT_A_WRITER.test(m.description ?? '');
const words = (m, tier) => [...new Set(((m.description ?? '').match(EVIDENCE[tier]) ?? []).map((w) => w.toLowerCase()))];

/** Effort for a tier: the tier's usual effort only when the model DECLARES it, else its declared default, else none. */
function pickEffort(m, tier) {
  const want = TIER_EFFORT[tier]; const sup = m.supported_reasoning_levels ?? [];
  if (sup.includes(want)) return { effort: want, effort_basis: `"${want}" is declared supported for this model` };
  const def = m.default_reasoning_level;
  if (def && EFFORTS.includes(def) && sup.includes(def)) return { effort: def, effort_basis: `"${want}" is not declared for this model; using its declared default "${def}"` };
  return { effort: null, effort_basis: 'no usable declared effort; none is passed (the CLI default applies)' };
}

function overrideRoute(tier, ov, models) {
  const base = { tier, model: ov.model, source: 'override' };
  if (!models?.length) {
    return { ...base, effort: ov.effort, verified: false, basis: 'explicit per-tier override; NOT verified (no Codex model list is available)',
      effort_basis: ov.effort ? 'explicit override; not verified' : 'none passed (the CLI default applies)' };
  }
  const m = models.find((x) => x.slug === ov.model);
  const listed = models.filter(eligible).map((x) => x.slug);
  if (!m) throw new Error(`Codex model ${ov.model} (${tier} tier) is not in the account list; listed: ${listed.join(', ') || 'none'}`);
  if (!eligible(m)) throw new Error(`Codex model ${ov.model} (${tier} tier) is hidden, internal or review-only in the account list and cannot be used as a writer`);
  if (ov.effort && !(m.supported_reasoning_levels ?? []).includes(ov.effort)) {
    throw new Error(`Codex model ${ov.model} does not declare effort "${ov.effort}" (declared: ${(m.supported_reasoning_levels ?? []).join(', ') || 'none'})`);
  }
  const e = ov.effort ? { effort: ov.effort, effort_basis: `explicit override; "${ov.effort}" is declared supported for this model` } : pickEffort(m, tier);
  return { ...base, ...e, verified: true, priority: m.priority, basis: 'explicit per-tier override, present in the account list' };
}

/**
 * One route per tier: {tier, model, effort, source: override|heuristic|provider_default, verified, basis, effort_basis}.
 * `model: "account_default"` means no --model is passed. Throws only for an invalid override.
 */
export function routeTiers(models, overrides = {}) {
  const pool = (models ?? []).map((m, i) => ({ m, i })).filter((x) => eligible(x.m));
  const routes = {};
  for (const tier of CODEX_TIERS) {
    if (overrides[tier]) { routes[tier] = overrideRoute(tier, overrides[tier], models); continue; }
    const scored = pool.map((x) => ({ ...x, hit: words(x.m, tier), other: CODEX_TIERS.filter((t) => t !== tier && words(x.m, t).length).length, old: SUPERSEDED.test(x.m.description ?? '') ? 1 : 0 }))
      .filter((x) => x.hit.length);
    if (!scored.length) {
      routes[tier] = { tier, model: 'account_default', effort: null, source: 'provider_default', verified: false,
        basis: models?.length
          ? `no listed model description gives evidence for ${tier}-tier work; no --model is passed, so Codex uses its own configured default (not chosen by Concord)`
          : 'no Codex model list is available; no --model is passed, so Codex uses its own configured default (not chosen or verified by Concord)',
        effort_basis: 'none passed (the CLI default applies)' };
      continue;
    }
    // Current before superseded, single-purpose before ambiguous, then provider priority (lower first) and catalog order. Never by name.
    const prio = (x) => (x.m.priority === null ? Number.MAX_SAFE_INTEGER : x.m.priority);
    scored.sort((a, b) => a.old - b.old || a.other - b.other || prio(a) - prio(b) || a.i - b.i);
    const best = scored[0];
    routes[tier] = { tier, model: best.m.slug, ...pickEffort(best.m, tier), source: 'heuristic', verified: true, priority: best.m.priority,
      basis: `heuristic: the provider description mentions ${best.hit.map((w) => `"${w}"`).join(', ')}${best.old ? ' (and describes the model as older/previous; nothing current matched)' : ''}` +
        `${scored.length > 1 ? `; ${scored.length} listed models matched, ordered by provider priority, never by version or name` : ''}`,
      considered: scored.slice(0, 6).map((x) => x.m.slug) };
  }
  return routes;
}

export const routeLabel = (r) => `${r.model === 'account_default' ? 'Codex default model (no --model)' : r.model}${r.effort ? ` @ ${r.effort}` : ' @ CLI default effort'}`;

/** Plain-text table of the three routes, exactly as frozen. */
export function routeLines(routes) {
  return CODEX_TIERS.map((t) => `  ${t.padEnd(6)} → ${routeLabel(routes[t])}  [${routes[t].source}${routes[t].verified ? '' : ', UNVERIFIED'}] ${routes[t].basis}; effort: ${routes[t].effort_basis}`);
}
