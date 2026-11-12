#!/usr/bin/env node
// Build a self-contained local marketplace: <out>/.claude-plugin/marketplace.json
// + <out>/concord/{plugin assets, LICENSE}. Node builtins only; no backend copied.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = ['.claude-plugin/plugin.json', 'README.md', 'README.zh-CN.md', 'skills', 'agents', 'policy', 'scripts/concord.mjs', 'scripts/lib'];

const i = process.argv.indexOf('--out');
if (i < 0 || !process.argv[i + 1]) {
  process.stderr.write('usage: node package.mjs --out <empty-or-new-dir>\n');
  process.exit(2);
}
const out = path.resolve(process.argv[i + 1]);
if (fs.existsSync(out) && fs.readdirSync(out).length) {
  process.stderr.write(`refusing to write into non-empty ${out}\n`);
  process.exit(2);
}
const license = [path.join(PLUGIN, 'LICENSE'), path.join(PLUGIN, '..', '..', 'LICENSE')].find((p) => fs.existsSync(p));
if (!license) { process.stderr.write('LICENSE not found\n'); process.exit(2); }

const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'));
const dest = path.join(out, manifest.name);
for (const rel of ASSETS) {
  fs.cpSync(path.join(PLUGIN, rel), path.join(dest, rel), { recursive: true, filter: (src) => !/\.(py|pyc)$|__pycache__|\.DS_Store$/.test(src) });
}
fs.copyFileSync(license, path.join(dest, 'LICENSE'));
fs.chmodSync(path.join(dest, 'scripts/concord.mjs'), 0o755);
fs.mkdirSync(path.join(out, '.claude-plugin'), { recursive: true });
fs.writeFileSync(path.join(out, '.claude-plugin/marketplace.json'), `${JSON.stringify({
  name: 'concord-local',
  owner: manifest.author,
  metadata: { description: 'Local marketplace for the 贞观·政事堂 · Concord Claude Code plugin', version: manifest.version },
  plugins: [{ name: manifest.name, source: `./${manifest.name}`, description: manifest.description, version: manifest.version }],
}, null, 2)}\n`);
process.stdout.write(`packaged ${manifest.name} ${manifest.version} → ${out}\n  claude plugin marketplace add ${out}\n  claude plugin install ${manifest.name}@concord-local\n`);
