// Builds data/channels.json from the iptv-org database.
//
//   node scripts/build-data.mjs                      # download the database
//   node scripts/build-data.mjs --from ./api-cache   # use already-downloaded *.json files
//   node scripts/build-data.mjs --probe probe.json   # apply results of scripts/probe.py
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_FILES, buildCatalog, fetchApi } from '../js/builder.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

let api;
if (opt('--from')) {
  api = {};
  for (const f of API_FILES) api[f] = JSON.parse(await readFile(join(opt('--from'), f + '.json'), 'utf8'));
} else {
  api = await fetchApi(fetch, (n, t, name) => console.log(`downloaded ${name} (${n}/${t})`));
}
const probe = opt('--probe') ? JSON.parse(await readFile(opt('--probe'), 'utf8')) : null;

const catalog = buildCatalog(api, probe);
await mkdir(join(root, 'data'), { recursive: true });
await writeFile(join(root, 'data', 'channels.json'), JSON.stringify(catalog));

const streams = catalog.channels.reduce((n, c) => n + c.s.length, 0);
const tally = {};
for (const c of catalog.channels) for (const s of c.s) tally[s[2]] = (tally[s[2]] || 0) + 1;
console.log(`${catalog.channels.length} channels, ${streams} streams`, tally);
