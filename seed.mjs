// Generates seed.sql (hashed codes + recordings) and codes.csv (plaintext codes to send out).
// Usage: node scripts/seed.mjs --attendees attendees.csv --recordings recordings.csv [--audio-dir ./audio] [--limit 20]
//   attendees.csv  : email,name
//   recordings.csv : slug,title,speaker,file     (file = mp3 filename; also the R2 key)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readCsv, csvCell } from './csv.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const limit = parseInt(args.limit || '20', 10);
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;

function genCode() {
  let out = '';
  while (out.length < 12) { const b = crypto.randomBytes(1)[0]; if (b < 248) out += ALPHABET[b % 31]; }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}
const hash = (code) => crypto.createHash('sha256').update(code.replace(/[^A-Z0-9]/g, '')).digest('hex');

const sql = [];
const codes = ['email,name,code'];

if (args.attendees) {
  for (const a of readCsv(args.attendees)) {
    if (!a.email) continue;
    const code = genCode();
    // INSERT OR IGNORE: existing emails keep their current code (their codes.csv line will not work).
    sql.push(`INSERT OR IGNORE INTO attendees (email, name, code_hash, downloads_left) VALUES (${q(a.email.toLowerCase())}, ${q(a.name)}, ${q(hash(code))}, ${limit});`);
    codes.push([a.email.toLowerCase(), a.name, code].map(csvCell).join(','));
  }
  fs.writeFileSync('codes.csv', codes.join('\n') + '\n');
  console.log(`codes.csv: ${codes.length - 1} attendees (keep this file private, never commit it)`);
}

if (args.recordings) {
  let sort = 0;
  for (const r of readCsv(args.recordings)) {
    if (!r.slug || !r.file) continue;
    let size = 'NULL';
    if (args['audio-dir']) {
      const p = path.join(args['audio-dir'], r.file);
      if (fs.existsSync(p)) size = fs.statSync(p).size; else console.warn(`warning: ${p} not found`);
    }
    sql.push(`INSERT INTO recordings (slug, title, speaker, r2_key, size, sort) VALUES (${q(r.slug)}, ${q(r.title)}, ${q(r.speaker)}, ${q(r.file)}, ${size}, ${sort++})
ON CONFLICT(slug) DO UPDATE SET title=excluded.title, speaker=excluded.speaker, r2_key=excluded.r2_key, size=excluded.size, sort=excluded.sort;`);
  }
}

fs.writeFileSync('seed.sql', sql.join('\n') + '\n');
console.log(`seed.sql: ${sql.length} statements. Apply with: npx wrangler d1 execute DB --remote --file seed.sql`);
