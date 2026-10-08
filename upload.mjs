// Uploads every file listed in recordings.csv from --audio-dir to the private R2 bucket.
// Usage: node scripts/upload.mjs --recordings recordings.csv --audio-dir ./audio [--bucket anniversary-recordings]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readCsv } from './csv.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const bucket = args.bucket || 'anniversary-recordings';
for (const r of readCsv(args.recordings || 'recordings.csv')) {
  const file = path.join(args['audio-dir'] || './audio', r.file);
  console.log(`uploading ${r.file} ...`);
  const res = spawnSync('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/${r.file}`, '--file', file, '--content-type', 'audio/mpeg', '--remote'], { stdio: 'inherit' });
  if (res.status !== 0) { console.error(`failed: ${r.file}`); process.exit(1); }
}
