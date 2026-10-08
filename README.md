# Anniversary Recordings Download Site

Attendees enter a personal code, then download recordings from a private bucket.
Each code has a fixed download budget. When it runs out they request a new code,
you approve it with one click, and a fresh code is emailed to them.

- **Cloudflare Worker** serves the page and API (free tier is plenty)
- **R2** holds the MP3s privately. Real storage URLs are never exposed; files stream through short-lived `/d/<ticket>` links
- **D1** stores attendees (codes are stored hashed), recordings, and a download log
- **Brevo** sends the emails (free tier: 300/day; only needs one verified sender address, no domain)
- **GitHub Pages** hosts the page at `https://<you>.github.io/<repo>`; it calls the Worker API at `https://<worker>.<you>.workers.dev`
- **GitHub Actions** deploys both on every push to `main`

## One-time setup

1. Create a GitHub repo and push this folder to it (default branch `main`).
2. `npm install`, then log in: `npx wrangler login`
3. Create storage:
   ```
   npx wrangler d1 create anniversary-downloads     # copy the database_id into wrangler.toml
   npx wrangler r2 bucket create anniversary-recordings
   ```
4. Brevo (free): sign up, go to Senders & IP > Senders, add and verify your email address, then create an API key (SMTP & API > API Keys).
   `npx wrangler secret put BREVO_API_KEY` (this requires the Worker to exist; if it errors, run step 6 first, then come back)
5. Edit `wrangler.toml` vars: `FROM_EMAIL` (your verified Brevo sender), `ADMIN_EMAIL`, `DOWNLOAD_LIMIT`, and the two GitHub URLs (`SITE_URL`, `ALLOWED_ORIGIN`).
6. First Worker deploy: `npx wrangler deploy`. It prints your API address, `https://anniversary-downloads.<your-subdomain>.workers.dev`. (If this is your first Worker, Cloudflare asks you to pick the workers.dev subdomain.)
7. GitHub repo settings:
   - Secrets (Settings > Secrets and variables > Actions): `CLOUDFLARE_API_TOKEN` (permissions: Workers Scripts Edit, D1 Edit, R2 Edit) and `CLOUDFLARE_ACCOUNT_ID`
   - Variable: `API_BASE` = your workers.dev address from step 6 (no trailing slash)
   - Settings > Pages > Source: **GitHub Actions**
8. Push to `main`. The `Deploy` workflow updates the Worker and `Deploy site to GitHub Pages` publishes the page. Your attendees' address is `https://<you>.github.io/<repo>`.

The Worker also serves the same page at its own workers.dev address, so that works as a backup link.

## Load content

```
# put your mp3s in ./audio and list them in recordings.csv (see recordings.example.csv); attendees in attendees.csv
npm run migrate:remote
node scripts/upload.mjs --recordings recordings.csv --audio-dir ./audio
node scripts/seed.mjs --attendees attendees.csv --recordings recordings.csv --audio-dir ./audio --limit 20
npx wrangler d1 execute DB --remote --file seed.sql
```

`seed.mjs` writes `codes.csv` (plaintext codes, git-ignored). Email them out:

```
BREVO_API_KEY=xkeysib-xxx node scripts/send-codes.mjs --from you@gmail.com --name "Group Name" --site https://YOU.github.io/REPO            # dry run
BREVO_API_KEY=xkeysib-xxx node scripts/send-codes.mjs --from you@gmail.com --name "Group Name" --site https://YOU.github.io/REPO --send
```

Then delete `codes.csv`. Only hashes remain in the database.

## How the limits work

- One code per person, one shared budget (`DOWNLOAD_LIMIT`) across all recordings.
- Clicking Download spends one use and creates a 15-minute ticket. Resuming a broken download within that window is free.
- A download that fails completely and needs a fresh click costs another use. Top someone up with:
  `npx wrangler d1 execute DB --remote --command "UPDATE attendees SET downloads_left = downloads_left + 5 WHERE email='x@y.org'"`
- 10 wrong codes from one IP locks that IP out for 15 minutes.

## Requesting a new code

Attendee enters their email -> you get an email with an approve/deny link -> approving issues a **new** code
(the old one stops working) with a full budget and emails it to them. If email sending fails, the approve page
shows the code so you can send it yourself. The attendee always sees the same "request received" message,
whether or not they are on your list.

## Useful queries

```
# who downloaded what
npx wrangler d1 execute DB --remote --command "SELECT a.email, r.title, t.created_at FROM tickets t JOIN attendees a ON a.id=t.attendee_id JOIN recordings r ON r.id=t.recording_id ORDER BY t.created_at DESC"
# remaining downloads
npx wrangler d1 execute DB --remote --command "SELECT email, downloads_left FROM attendees"
```

## Local testing

```
npm run migrate:local
npx wrangler d1 execute DB --local --file seed.sql
npx wrangler r2 object put anniversary-recordings/opening.mp3 --file audio/opening.mp3 --local
npm run dev
```

## Email deliverability note

Without your own domain, Brevo sends from its servers on behalf of your Gmail address. Messages usually arrive, but
may land in spam for some attendees, so tell people to check spam and add the sender to contacts. Codes can also be
sent by text or handed out in person from `codes.csv`.
