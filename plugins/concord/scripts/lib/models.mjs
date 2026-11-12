// Model catalog (explicit, cached discovery through local CLI commands only)
// and deterministic Claude capability-tier computation (吏部选才). No inference, no HTTP here:
// the published Claude alias list is handled in discovery.mjs, routing policy in routing.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './proc.mjs';
import { readJson, writeJson } from './state.mjs';

export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const CLAUDE_TIERS = ['haiku', 'sonnet', 'opus']; // CAPABILITY tiers (not model names, not a version ranking)
export const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus', 'fable']; // Agent-tool per-call model values (sub-agents docs)
export const TTL_S = 7 * 86400;
const DISCOVERY_TIMEOUT_MS = 15000;
// Per-provider output caps. `codex debug models` embeds full model capabilities and
// base instructions (~630 KiB observed for 10 models), so it needs a larger bound.
export const MAX_BYTES = { codex: 32 * 1024 * 1024, grok: 512 * 1024 };
export const DOCS = {
  // Reference pages. Codex/Grok pages are shown, never fetched; the Claude page is read only by discovery.mjs.
  codex: 'https://learn.chatgpt.com/docs/models.md',
  grok: 'https://docs.x.ai/developers/models',
  claude: 'https://code.claude.com/docs/en/model-config.md',
};
export const RISK = /payment|billing|auth|security|migration|concurren|credential|secret|permission|deploy|production|delete|destruct|database|crypto|数据库|删除|凭据|密钥|权限|部署|支付|账单|认证|鉴权|授权|安全|迁移|并发/i;

export function cacheDir() {
  return process.env.CONCORD_CACHE_DIR
    || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'concord');
}

export function cachePath() { return path.join(cacheDir(), 'models.json'); }

export function loadCatalog() {
  try {
    const c = readJson(cachePath());
    return c && c.schema === 1 && c.providers ? c : null;
  } catch { return null; }
}

/** Extract model IDs from a CLI JSON envelope without guessing from prose. */
export function idsFromJson(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (typeof item === 'string') out.push(item);
      else if (item && typeof item === 'object') {
        if (item.visibility === 'hide' || item.hidden === true) continue;
        const id = item.slug ?? item.id ?? item.model;
        if (typeof id === 'string') out.push(id);
      }
    }
    return [...new Set(out.filter((x) => MODEL_ID.test(x)))].sort();
  }
  if (value && typeof value === 'object') {
    for (const k of ['models', 'data', 'result']) if (k in value) return idsFromJson(value[k]);
  }
  return [];
}

/** Grok CLI prints a titled bullet list; accept only exact rows under it. */
export function idsFromGrokText(text) {
  try { return idsFromJson(JSON.parse(text)); } catch { /* not JSON */ }
  const header = 'Available models:';
  if (!text.includes(header)) return [];
  const found = [];
  for (const line of text.split(header)[1].split('\n')) {
    const m = line.match(/^\s*[*-]\s+([A-Za-z0-9][A-Za-z0-9._:-]*)(?:\s+\(default\))?\s*$/);
    if (m) found.push(m[1]);
    else if (found.length && line.trim()) break;
  }
  return [...new Set(found)].sort();
}

const DISCOVERY = {
  codex: { argv: ['codex', 'debug', 'models'], parse: (t) => idsFromJson(JSON.parse(t)), maxBytes: MAX_BYTES.codex },
  grok: { argv: ['grok', 'models'], parse: idsFromGrokText, maxBytes: MAX_BYTES.grok },
};

/**
 * Explicit refresh only (never implicit per stage). Each provider CLI lists the
 * models visible to the signed-in account; the CLI may contact its provider to
 * do so, but no prompt or inference request is sent.
 */
export async function refreshCatalog(bins, tmpDir) {
  const at = new Date().toISOString();
  const providers = {};
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const [name, d] of Object.entries(DISCOVERY)) {
    const argv = [bins[name], ...d.argv.slice(1)];
    const source = `local CLI: ${d.argv.join(' ')}`;
    const outFile = path.join(tmpDir, `${name}-models.out`);
    const r = await run(argv, { timeoutMs: DISCOVERY_TIMEOUT_MS, stdoutPath: outFile, env: process.env });
    let models = [];
    let error = r.error || (r.timedOut ? 'timed out' : r.code !== 0 ? `exit ${r.code}` : null);
    if (!error) {
      try {
        const st = fs.statSync(outFile);
        if (st.size > d.maxBytes) throw new Error(`output too large (${st.size} bytes > ${d.maxBytes})`);
        models = d.parse(fs.readFileSync(outFile, 'utf8'));
        if (!models.length) error = 'no model list recognised in CLI output';
      } catch (e) { error = `unparseable output: ${e.message}`; }
    }
    try { fs.unlinkSync(outFile); } catch { /* none */ }
    providers[name] = error
      ? { status: 'unavailable', source, observed_at: at, error, models: [], docs: DOCS[name] }
      : { status: 'account-listed', source, observed_at: at, models, docs: DOCS[name] };
  }
  providers.claude = {
    status: 'aliases', source: 'Claude Code Agent tool model aliases', observed_at: at,
    models: [...CLAUDE_ALIASES], docs: DOCS.claude,
    note: 'Aliases resolve to whatever Claude Code currently maps them to; the exact model ID is not observed by this helper.',
  };
  const catalog = { schema: 1, refreshed_at: at, providers,
    note: 'Account-listed = reported by your local CLI for your account. Published Codex/Grok lists are not fetched; see docs URLs. Claude: see the routing policy and published-alias state below.' };
  writeJson(cachePath(), catalog);
  return catalog;
}

/** Validate an external-role model choice against the cache. Returns a routing record. */
export function resolveExternal(provider, requested, catalog) {
  if (requested === undefined || requested === null || requested === 'account_default') {
    return { provider, model: 'account_default', evidence: 'CLI account default (no --model flag passed)' };
  }
  if (typeof requested !== 'string' || !MODEL_ID.test(requested)) {
    throw new Error(`invalid ${provider} model id: ${JSON.stringify(requested)}`);
  }
  const p = catalog?.providers?.[provider];
  if (p?.status === 'account-listed') {
    if (!p.models.includes(requested)) {
      throw new Error(`${provider} model ${requested} is not in the account list from ${p.source} (${p.observed_at}); run \`models --refresh\` or choose a listed id`);
    }
    return { provider, model: requested, evidence: `account-listed via ${p.source} at ${p.observed_at}` };
  }
  return { provider, model: requested, evidence: 'unverified user override (no account list cached)' };
}

const RANK = { low: 0, medium: 1, high: 2 };

/** 吏部选才: deterministic Claude tier from task difficulty/risk, with overrides. */
export function routeTask(task, override) {
  if (override) {
    if (!CLAUDE_TIERS.includes(override)) throw new Error(`invalid Claude tier override: ${override}`);
    return { tier: override, reason: 'per-role override' };
  }
  const difficulty = RANK[task.difficulty] ?? 1;
  let risk = RANK[task.risk] ?? 1;
  const text = `${task.title} ${task.description} ${(task.files || []).join(' ')}`;
  const riskyText = RISK.test(text);
  if (riskyText) risk = 2;
  if (difficulty === 2 || risk === 2) {
    return { tier: 'opus', reason: `difficulty=${task.difficulty ?? 'medium'} risk=${task.risk ?? 'medium'}${riskyText ? ' (risk keyword)' : ''}` };
  }
  if (difficulty === 0 && risk === 0) return { tier: 'haiku', reason: 'low difficulty and low risk' };
  return { tier: 'sonnet', reason: `difficulty=${task.difficulty ?? 'medium'} risk=${task.risk ?? 'medium'}` };
}

export function catalogAge(catalog) {
  if (!catalog?.refreshed_at) return null;
  return Math.round((Date.now() - Date.parse(catalog.refreshed_at)) / 1000);
}
