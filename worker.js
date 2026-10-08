// Anniversary recordings: code-gated downloads with a per-code download budget.
// Storage URLs are never exposed: files are streamed from a private R2 bucket
// through short-lived /d/<ticket> URLs.

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
const TICKET_TTL_SEC = 15 * 60;
const MAX_FAILED_ATTEMPTS = 10;       // per IP per 15 minutes
const MAX_REQUESTS_PER_HOUR = 5;      // code requests per IP

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      if (request.method === 'POST' && path === '/api/session') res = await apiSession(request, env);
      else if (request.method === 'POST' && path === '/api/ticket') res = await apiTicket(request, env);
      else if (request.method === 'POST' && path === '/api/request') res = await apiRequest(request, env, url);
      else if (request.method === 'GET' && path.startsWith('/d/')) return await download(request, env, path.slice(3));
      else if (path.startsWith('/admin/r/')) return await adminRequest(request, env, path.slice(9));
      else res = json({ error: 'Not found' }, 404);
    } catch (e) {
      console.error(e);
      res = json({ error: 'Server error' }, 500);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

// ---------- helpers ----------

// Lets the GitHub Pages site (env.ALLOWED_ORIGIN) call this API from the browser.
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function html(body, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex"><body style="font:16px system-ui;max-width:560px;margin:40px auto;padding:0 16px">${body}`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ip = (req) => req.headers.get('CF-Connecting-IP') || 'local';
const nowSec = () => Math.floor(Date.now() / 1000);

function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateCode() {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < 12) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    for (const b of bytes) {
      if (b < limit && out.length < 12) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

function randomToken(bytes = 24) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

async function sendEmail(env, { to, subject, text }) {
  if (!env.BREVO_API_KEY) return false;
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: env.FROM_NAME || env.SITE_NAME, email: env.FROM_EMAIL },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Returns attendee row, or a Response (error) if blocked / invalid.
async function authenticate(env, request, rawCode) {
  const addr = ip(request);
  const since = nowSec() - 15 * 60;
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE ip = ? AND at > ?').bind(addr, since).first();
  if (n >= MAX_FAILED_ATTEMPTS) return json({ error: 'Too many attempts. Please wait 15 minutes and try again.' }, 429);

  const code = normalizeCode(rawCode);
  if (code.length !== 12) {
    await env.DB.prepare('INSERT INTO attempts (ip, at) VALUES (?, ?)').bind(addr, nowSec()).run();
    return json({ error: 'That code was not recognized.' }, 401);
  }
  const hash = await sha256Hex(code);
  const row = await env.DB.prepare('SELECT * FROM attendees WHERE code_hash = ?').bind(hash).first();
  if (!row) {
    await env.DB.prepare('INSERT INTO attempts (ip, at) VALUES (?, ?)').bind(addr, nowSec()).run();
    return json({ error: 'That code was not recognized.' }, 401);
  }
  return row;
}

// ---------- API ----------

async function apiSession(request, env) {
  const { code } = await readJson(request);
  const who = await authenticate(env, request, code);
  if (who instanceof Response) return who;
  const { results } = await env.DB.prepare('SELECT slug, title, speaker, size FROM recordings ORDER BY sort, id').all();
  return json({ name: who.name, downloads_left: who.downloads_left, recordings: results });
}

async function apiTicket(request, env) {
  const { code, slug } = await readJson(request);
  const who = await authenticate(env, request, code);
  if (who instanceof Response) return who;

  const rec = await env.DB.prepare('SELECT id FROM recordings WHERE slug = ?').bind(String(slug || '')).first();
  if (!rec) return json({ error: 'Recording not found.' }, 404);

  // Atomic spend: only succeeds if a download remains.
  const spend = await env.DB.prepare('UPDATE attendees SET downloads_left = downloads_left - 1 WHERE id = ? AND downloads_left > 0').bind(who.id).run();
  if (!spend.meta.changes) {
    return json({ error: 'No downloads remaining on this code. Please request a new one.', downloads_left: 0 }, 403);
  }
  const token = randomToken();
  await env.DB.prepare('INSERT INTO tickets (token, attendee_id, recording_id, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, who.id, rec.id, nowSec() + TICKET_TTL_SEC).run();
  return json({ url: `/d/${token}`, downloads_left: who.downloads_left - 1 });
}

async function apiRequest(request, env, url) {
  const { email } = await readJson(request);
  const addr = ip(request);
  const generic = json({ ok: true, message: 'Request received. You will get an email if it is approved.' });

  const clean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean) || clean.length > 254) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE ip = ? AND created_at > datetime('now','-1 hour')").bind(addr).first();
  if (n >= MAX_REQUESTS_PER_HOUR) return json({ error: 'Too many requests. Please try again later.' }, 429);

  const dup = await env.DB.prepare("SELECT 1 FROM requests WHERE email = ? AND status = 'pending'").bind(clean).first();
  if (dup) return generic;

  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO requests (email, token, ip) VALUES (?, ?, ?)').bind(clean, token, addr).run();
  await sendEmail(env, {
    to: env.ADMIN_EMAIL,
    subject: `Code request: ${clean}`,
    text: `${clean} requested a download code.\n\nReview and approve or deny:\n${url.origin}/admin/r/${token}\n`,
  });
  return generic;
}

// ---------- download (streams from private R2) ----------

async function download(request, env, token) {
  const t = await env.DB.prepare(
    'SELECT t.expires_at, r.r2_key, r.title FROM tickets t JOIN recordings r ON r.id = t.recording_id WHERE t.token = ?'
  ).bind(token).first();
  if (!t || t.expires_at < nowSec()) {
    return html('<h2>Link expired</h2><p>Please go back to the download page and try again.</p>', 410);
  }
  const object = await env.BUCKET.get(t.r2_key, { range: request.headers, onlyIf: request.headers });
  if (!object) return html('<h2>File unavailable</h2>', 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, no-store');
  headers.set('content-type', 'audio/mpeg');
  const filename = `${t.title.replace(/[^\w .()-]+/g, '').trim() || 'recording'}.mp3`;
  headers.set('content-disposition', `attachment; filename="${filename}"`);

  let status = 200;
  if (object.range && request.headers.get('range')) {
    status = 206;
    const { offset, length } = object.range;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
  } else if (object.body) {
    headers.set('content-length', String(object.size));
  }
  if (!object.body) status = 304;
  return new Response(object.body ?? null, { status, headers });
}

// ---------- admin approve / deny (link is the secret) ----------

async function adminRequest(request, env, token) {
  const req = await env.DB.prepare('SELECT * FROM requests WHERE token = ?').bind(token).first();
  if (!req) return html('<h2>Not found</h2>', 404);

  if (request.method === 'GET') {
    if (req.status !== 'pending') return html(`<h2>Already ${esc(req.status)}</h2><p>${esc(req.email)}</p>`);
    const known = await env.DB.prepare('SELECT 1 FROM attendees WHERE email = ?').bind(req.email).first();
    return html(
      `<h2>Code request</h2><p><b>${esc(req.email)}</b><br>${known ? 'Existing attendee: approving issues a NEW code (old one stops working) and resets downloads.' : 'Not on your attendee list: approving adds them.'}</p>` +
        `<form method="post"><button name="action" value="approve" style="padding:10px 18px;font-size:16px">Approve &amp; email new code</button> ` +
        `<button name="action" value="deny" style="padding:10px 18px;font-size:16px">Deny</button></form>`
    );
  }
  if (request.method !== 'POST') return html('<h2>Method not allowed</h2>', 405);
  if (req.status !== 'pending') return html(`<h2>Already ${esc(req.status)}</h2>`);

  const form = await request.formData();
  if (form.get('action') === 'deny') {
    await env.DB.prepare("UPDATE requests SET status = 'denied' WHERE id = ?").bind(req.id).run();
    return html(`<h2>Denied</h2><p>${esc(req.email)}</p>`);
  }

  const code = generateCode();
  const hash = await sha256Hex(normalizeCode(code));
  const limit = parseInt(env.DOWNLOAD_LIMIT, 10) || 20;
  await env.DB.prepare(
    `INSERT INTO attendees (email, code_hash, downloads_left) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, downloads_left = excluded.downloads_left`
  ).bind(req.email, hash, limit).run();
  await env.DB.prepare("UPDATE requests SET status = 'approved' WHERE id = ?").bind(req.id).run();

  const site = env.SITE_URL || new URL(request.url).origin;
  const sent = await sendEmail(env, {
    to: req.email,
    subject: `Your download code - ${env.SITE_NAME}`,
    text: `Here is your new code:\n\n    ${code}\n\nIt allows ${limit} downloads. Enter it at ${site}\n`,
  });
  return html(
    sent
      ? `<h2>Approved</h2><p>New code emailed to ${esc(req.email)}.</p>`
      : `<h2>Approved, but the email failed to send</h2><p>Send this code to ${esc(req.email)} yourself:</p><p style="font:20px monospace">${esc(code)}</p>`
  );
}
