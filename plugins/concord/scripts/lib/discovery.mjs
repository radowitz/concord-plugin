// Advisory discovery of published Claude model aliases from the official model-config page.
// Bounded HTTPS (Node builtins), fixed URL, official-domain redirects only. The result is
// published documentation, NOT proof that an account or provider can use anything.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { readJson, writeJson } from './state.mjs';
import { cacheDir } from './models.mjs';

export const OFFICIAL_URL = 'https://code.claude.com/docs/en/model-config.md';
export const OFFICIAL_HOSTS = new Set(['code.claude.com', 'docs.claude.com', 'platform.claude.com', 'docs.anthropic.com', 'claude.com', 'www.claude.com', 'anthropic.com', 'www.anthropic.com']);
export const TOTAL_TIMEOUT_MS = 3000;
export const MAX_BYTES = 512 * 1024;
export const MAX_REDIRECTS = 3;
export const TTL_MS = 24 * 3600 * 1000;
const BACKOFF_BASE_MS = 15 * 60 * 1000;
const BACKOFF_MAX_MS = 6 * 3600 * 1000;
const LOCK_STALE_MS = 30000;

export const discoveryFile = () => path.join(cacheDir(), 'claude-models.json');
const disabled = () => ['off', '0', 'false'].includes(String(process.env.CONCORD_MODEL_DISCOVERY ?? '').toLowerCase());

export function safeRedirect(base, location) {
  let u;
  try { u = new URL(location, base); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !OFFICIAL_HOSTS.has(u.hostname)) return null;
  return u.toString();
}

/** One bounded GET. Total deadline covers redirects; body capped; only official https hosts. */
export function httpGet(url = OFFICIAL_URL, { timeoutMs = TOTAL_TIMEOUT_MS, maxBytes = MAX_BYTES, maxRedirects = MAX_REDIRECTS, request = https.get } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false; let req = null;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { req?.destroy(); } catch { /* gone */ } fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    const go = (u, left) => {
      if (Date.now() >= deadline) return done(reject, new Error('timed out'));
      req = request(u, { headers: { accept: 'text/markdown, text/plain;q=0.8', 'user-agent': 'node' } }, (res) => {
        const code = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(code)) {
          res.resume();
          const next = left > 0 && res.headers.location ? safeRedirect(u, res.headers.location) : null;
          return next ? go(next, left - 1) : done(reject, new Error(`unsafe or excessive redirect (${res.headers.location ?? 'none'})`));
        }
        if (code !== 200) { res.resume(); return done(reject, new Error(`HTTP ${code}`)); }
        const len = Number(res.headers['content-length']);
        if (Number.isFinite(len) && len > maxBytes) { res.resume(); return done(reject, new Error(`response too large (${len} bytes)`)); }
        const chunks = []; let n = 0;
        res.on('data', (c) => { n += c.length; if (n > maxBytes) done(reject, new Error(`response over ${maxBytes} bytes`)); else chunks.push(c); });
        res.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')));
        res.on('error', (e) => done(reject, e));
      });
      req.on('error', (e) => done(reject, e));
    };
    go(url, maxRedirects);
  });
}

/** Test seam: CONCORD_CLAUDE_DOCS_FIXTURE=<file> replaces HTTP; CONCORD_CLAUDE_DOCS_LOG=<file> logs each fetch. */
async function defaultFetch() {
  const fx = process.env.CONCORD_CLAUDE_DOCS_FIXTURE;
  if (fx) {
    if (process.env.CONCORD_CLAUDE_DOCS_LOG) fs.appendFileSync(process.env.CONCORD_CLAUDE_DOCS_LOG, 'fetch\n');
    return fs.readFileSync(fx, 'utf8');
  }
  return httpGet();
}

const cell = (s) => s.replace(/`/g, '').replace(/\*\*/g, '').trim();
const rowCells = (line) => (line.trim().startsWith('|') ? line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()) : null);

/**
 * Conservative table parse. An alias row is `| **`name`** | Uses the ... <Name> ... |` with a plain
 * lowercase name: special modes (opusplan), expressions (best), `[1m]` variants and `default` never match.
 */
export function parseModelDocs(md) {
  if (typeof md !== 'string' || !md.includes('Model alias')) throw new Error('not the model-config page (no alias table)');
  const lines = md.split('\n');
  const aliases = [];
  let inTable = false;
  for (const line of lines) {
    const c = rowCells(line);
    if (!c) { inTable = false; continue; }
    if (c.length >= 2 && /^model alias$/i.test(cell(c[0]))) { inTable = true; continue; }
    if (!inTable || c.length !== 2) continue;
    const name = cell(c[0]); const behavior = cell(c[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    if (!/^[a-z]{3,20}$/.test(name) || ['default', 'best'].includes(name)) continue;
    if (!/^Uses the /.test(behavior) || /same model as|special|\bmode\b|\bplan\b/i.test(behavior)) continue;
    if (!new RegExp(`\\b${name}\\b`, 'i').test(behavior)) continue;
    if (!aliases.some((a) => a.alias === name)) aliases.push({ alias: name, behavior: behavior.slice(0, 200) });
  }
  if (!aliases.length) throw new Error('no alias rows recognised');
  // Published Anthropic API mapping only (other providers differ); strings must look like "Opus 5.5".
  let api = null; let head = null;
  for (const line of lines) {
    const c = rowCells(line);
    if (!c) { head = null; continue; }
    if (/^provider$/i.test(cell(c[0]))) { head = c.slice(1).map(cell); continue; }
    if (head && cell(c[0]) === 'Anthropic API') {
      api = {};
      head.forEach((h, i) => { const v = cell(c[i + 1] ?? ''); if (/^[a-z]{3,20}$/.test(h) && /^[A-Z][a-z]+ \d+(\.\d+)?$/.test(v)) api[h] = v; });
    }
  }
  return { aliases, anthropic_api_resolution: api && Object.keys(api).length ? api : null };
}

export function loadDiscovery() {
  try { const c = readJson(discoveryFile()); return c?.schema === 1 ? c : null; } catch { return null; }
}

export function tryLock(file) {
  const lock = `${file}.lock`;
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return () => { try { fs.unlinkSync(lock); } catch { /* gone */ } }; } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock); else return null; } catch { /* raced */ }
    }
  }
  return null;
}

function cleanup(file) {
  const dir = path.dirname(file); const base = path.basename(file);
  try {
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith(`${base}.`) && n.endsWith('.tmp')) { const p = path.join(dir, n); if (Date.now() - fs.statSync(p).mtimeMs > 3600000) fs.unlinkSync(p); }
    }
  } catch { /* best effort */ }
}

/**
 * Refresh the advisory alias list. Daily TTL; failure keeps the last good data and backs off.
 * Returns {state, cache}: state is skipped:<why> | refreshed | failed.
 */
export async function ensureDiscovery({ force = false, now = Date.now(), fetchImpl = defaultFetch } = {}) {
  if (disabled()) return { state: 'skipped:disabled', cache: loadDiscovery() };
  const cache = loadDiscovery();
  if (!force && cache?.fetched_at && now - Date.parse(cache.fetched_at) < TTL_MS) return { state: 'skipped:fresh', cache };
  if (!force && cache?.next_retry_at && now < Date.parse(cache.next_retry_at)) return { state: 'skipped:backoff', cache };
  const file = discoveryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = tryLock(file);
  if (!release) return { state: 'skipped:busy', cache };
  try {
    cleanup(file);
    const again = loadDiscovery(); // another process may have just finished
    if (!force && again?.fetched_at && now - Date.parse(again.fetched_at) < TTL_MS) return { state: 'skipped:fresh', cache: again };
    const at = new Date(now).toISOString();
    try {
      const text = await fetchImpl();
      const parsed = parseModelDocs(text);
      const next = { schema: 1, fetched_at: at, source: OFFICIAL_URL, ...parsed, failures: 0, last_failure: null, next_retry_at: null };
      writeJson(file, next);
      return { state: 'refreshed', cache: next };
    } catch (e) {
      const failures = (again?.failures ?? 0) + 1;
      const next = { schema: 1, ...(again ?? { fetched_at: null, source: OFFICIAL_URL, aliases: [], anthropic_api_resolution: null }), failures,
        last_failure: { at, error: String(e.message).slice(0, 200) }, next_retry_at: new Date(now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))).toISOString() };
      writeJson(file, next);
      return { state: 'failed', error: e.message, cache: next };
    }
  } finally { release(); }
}
