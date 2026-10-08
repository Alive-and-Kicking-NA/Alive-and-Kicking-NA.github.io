// Emails each attendee their code from codes.csv via Brevo. Dry run unless --send is passed.
// Usage: BREVO_API_KEY=... node scripts/send-codes.mjs --from you@gmail.com --name "Group Name" --site https://downloads.yourdomain.org [--limit 20] [--send]
import fs from 'node:fs';
import { readCsv } from './csv.mjs';

const argv = process.argv.slice(2);
const get = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const send = argv.includes('--send');
const from = get('from'), fromName = get('name') || 'Anniversary Recordings', site = get('site'), limit = get('limit') || '20';
if (!from || !site) { console.error('--from and --site are required'); process.exit(1); }
if (send && !process.env.BREVO_API_KEY) { console.error('Set BREVO_API_KEY'); process.exit(1); }

for (const a of readCsv('codes.csv')) {
  const text = `Hi${a.name ? ' ' + a.name : ''},\n\nHere is your personal code for the anniversary speaker recordings:\n\n    ${a.code}\n\nIt allows ${limit} downloads. Go to ${site} and enter it. If you run out, use the "Request a new code" box on the same page.\n`;
  if (!send) { console.log(`[dry run] would email ${a.email}`); continue; }
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ sender: { name: fromName, email: from }, to: [{ email: a.email }], subject: 'Your anniversary recordings download code', textContent: text }),
  });
  console.log(`${r.ok ? 'sent' : 'FAILED ' + r.status} ${a.email}`);
  await new Promise((res) => setTimeout(res, 600)); // stay under rate limits
}
