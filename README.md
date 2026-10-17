# JustDial Mailer

A tiny standalone Node.js service that receives **JustDial leads** on a public
URL and **forwards each lead to email**. No CRM, no database — just a webhook
and an inbox.

```
JustDial  ──GET/POST──►  /justdial/lead  ──►  📧  your inbox
                              │
                              └──►  logs/leads-YYYY-MM-DD.jsonl   (permanent record)
```

- Replies with the plain text **`RECEIVED`** — instantly, never waiting on the mail server
- Accepts **GET, POST, JSON, form-urlencoded, form-data and query strings**
- Every lead is saved to disk **before** the reply, so nothing is ever lost
- If the mail server is down the lead waits in an **outbox** and is retried automatically
- Optional **WhatsApp message to the lead's own number**, with its own outbox
- Clean lead email with **Call / WhatsApp / Maps** buttons
- **Copy button on every field**, plus a **Copy all** button
- Optional duplicate window (JustDial retries on timeout)
- No framework in the core — just Node's `http`, `nodemailer` and `busboy`

---

## 1. Requirements

- **Node.js 18 or newer** (`node -v`)
- A Gmail account with **2-Step Verification** enabled (for the App Password)

---

## 2. Quick start

```bash
cd justdial-mailer
npm install
cp .env.example .env      # Windows:  copy .env.example .env
```

Now open `.env` and fill in at least these:

```ini
SMTP_USER=your-address@gmail.com
SMTP_PASS=xxxxxxxxxxxxxxxx     # 16-char Gmail App Password
MAIL_FROM=your-address@gmail.com
MAIL_TO=owner@yourcompany.com
PATH_SECRET=change-this-to-something-random
```

Start it:

```bash
npm start
```

You should see:

```
  JustDial Mailer
  ---------------
  Lead endpoint : http://localhost:3000/justdial/lead/change-this-to-something-random
  Health check  : http://localhost:3000/health
  Emails go to  : owner@yourcompany.com
  Mode          : LIVE
```

Check your setup any time:

```bash
npm run test:smtp     # verifies the Gmail login
npm run test:lead     # sends a fake lead through the whole flow
```

---

## 3. Gmail App Password (important)

A normal Gmail password **will not work**. Google requires an App Password:

1. Go to <https://myaccount.google.com/security>
2. Turn on **2-Step Verification** (required first)
3. Go to <https://myaccount.google.com/apppasswords>
4. Create a new app password (name it e.g. `JustDial Mailer`)
5. Copy the 16-character password and paste it into `SMTP_PASS` — **no spaces**

`SMTP_USER` and `MAIL_FROM` must both be that same Gmail address.

---

## 4. The URL to give JustDial

```
https://leads.yourcompany.com/justdial/lead/change-this-to-something-random
```

As a parameterised template:

```
https://leads.yourcompany.com/justdial/lead/YOUR_SECRET?leadid={LeadID}&prefix={Prefix}&name={Name}&mobile={Mobile}&phone={Phone}&email={Email}&category={Category}&company={Company}&city={City}&area={Area}&brancharea={BranchArea}&pincode={Pincode}&branchpin={BranchPin}&leadtype={LeadType}&date={Date}&time={Time}
```

Every parameter is **optional** and **case-insensitive** (`Area` and `area`
both work). If you leave `PATH_SECRET` empty the URL is simply
`https://your-domain/justdial/lead`.

> **HTTPS is required** — JustDial will not call a plain `http://` URL, and the
> port must be reachable from the internet (see Deployment below).

---

## 5. Testing

**Browser** (easiest):

```
http://localhost:3000/justdial/lead/YOUR_SECRET?leadid=JD-1&name=Test+Lead&mobile=9999999999&city=Delhi&category=Plumber
```

**curl:**

```bash
curl.exe -i "http://localhost:3000/justdial/lead/YOUR_SECRET?leadid=JD-2&name=Rahul&mobile=9876543210&city=Mumbai&category=Interior+Designer"
```

The reply should be `RECEIVED` and an email should land in `MAIL_TO`.

**No SMTP yet?** Set `DRY_RUN=true` and the email content is printed to the
console instead of being sent — perfect for a first run.

**Heads up:** `npm run test:smoke` pushes real leads through the endpoint, and
the **server** is what sends the emails. The test asks the server first and
refuses to run while it is sending real mail:

```bash
npm run test:smoke -- --yes     # run it anyway (sends real emails)
```

To exercise everything without touching an inbox, start the server with
`DRY_RUN=true` and then run the smoke test normally.

**Preview the email design without sending anything:**

```bash
npm run preview          # writes logs/preview.html
```

**Health check** (good for uptime monitors):

```
GET https://leads.yourcompany.com/health
```

It returns JSON with the service status, the recipient list and how many leads
are waiting in the outbox.

---

## 6. Deployment

The service only needs to be reachable over HTTPS. Any of these work.

### Option A — pm2 (simplest on a VPS)

```bash
npm install -g pm2
pm2 start server.js --name justdial-mailer
pm2 save
pm2 startup
```

### Option B — systemd

`/etc/systemd/system/justdial-mailer.service`:

```ini
[Unit]
Description=JustDial Mailer
After=network.target

[Service]
WorkingDirectory=/opt/justdial-mailer
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now justdial-mailer
```

### Option C — nginx reverse proxy (with free HTTPS)

```nginx
server {
    listen 443 ssl;
    server_name leads.yourcompany.com;

    ssl_certificate     /etc/letsencrypt/live/leads.yourcompany.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/leads.yourcompany.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then set `HOST=127.0.0.1` in `.env` so only nginx can reach the service.

Ports 80/443 already in use by something else (e.g. Apache)? Use nginx on a
different port and forward, or put this behind your existing web server.

---

## 7. Logs and the outbox

| Path | What it is |
|---|---|
| `logs/app-YYYY-MM-DD.log` | Everything the service did |
| `logs/leads-YYYY-MM-DD.jsonl` | One JSON line per lead received (permanent record) |
| `logs/outbox/*.json` | Leads waiting to be emailed — retried automatically |

Every lead is written to the outbox **before** JustDial gets its `RECEIVED`
reply, so a lead cannot be lost when the mail server is down or the process
restarts. An entry is deleted the moment the email is accepted; otherwise it is
retried every `RETRY_INTERVAL_SECONDS` until it succeeds or reaches
`MAX_SEND_ATTEMPTS`.

```bash
# see what is still waiting to be emailed
ls logs/outbox

# inspect one
cat logs/outbox/1699999999999-JD-123-ab12cd34.json
```

On startup the service immediately retries anything left in the outbox.

---

## 8. Configuration reference

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | `127.0.0.1` when behind a reverse proxy |
| `ENDPOINT_PATH` | `/justdial/lead` | Lead endpoint path |
| `PATH_SECRET` | *(empty)* | Secret appended to the path — **set this** |
| `HEALTH_PATH` | `/health` | Health check path |
| `SMTP_HOST` | `smtp.gmail.com` | Mail server |
| `SMTP_PORT` | `587` | `587` = STARTTLS, `465` = SSL |
| `SMTP_SECURE` | `false` | `true` for port `465` |
| `SMTP_USER` | — | Gmail address |
| `SMTP_PASS` | — | Gmail **App Password** |
| `MAIL_FROM` | falls back to `SMTP_USER` | Sender address |
| `MAIL_FROM_NAME` | `JustDial Leads` | Sender display name |
| `MAIL_TO` | — | Recipients (comma separated) |
| `MAIL_CC` | *(empty)* | CC recipients |
| `MAIL_SUBJECT` | `New JustDial Lead: {{name}} ({{mobile}})` | Subject template |
| `DRY_RUN` | `false` | `true` = print instead of send |
| `DEDUPE_WINDOW_SECONDS` | `0` | Ignore the same lead id within N seconds |
| `RETRY_INTERVAL_SECONDS` | `300` | How often to retry failed emails |
| `MAX_SEND_ATTEMPTS` | `10` | Give up after N tries |
| `TIMEZONE` | `Asia/Kolkata` | Timezone used in the email timestamp |
| `LOG_DIR` | `logs` | Where logs live |
| `PUBLIC_URL` | auto-detected | Base URL used for the copy links |
| `COPY_PATH` | `/copy` | Path of the copy-to-clipboard page |
| `DEFAULT_COUNTRY_CODE` | `91` | Prefixed to bare 10 digit numbers for Call / WhatsApp |
| `WHATSAPP_GREETING` | see `.env.example` | Pre-filled WhatsApp text (`{{name}}` allowed) |
| `WHATSAPP_ENABLED` | `false` | Also send the lead to WhatsApp |
| `WHATSAPP_PROVIDER` | `wwjs` | `wwjs` / `openwa` (in process) or `webhook` |
| `WHATSAPP_WEBHOOK_URL` | *(empty)* | Gateway URL for the `webhook` provider |
| `WHATSAPP_SESSION_DIR` | `.wa-session` | Where the WhatsApp login is kept |
| `WHATSAPP_SEND_TO_LEAD` | `true` | Also greet the lead's own number |
| `WHATSAPP_TEAM_NUMBERS` | *(empty)* | Your team's numbers - they get the lead card |
| `WHATSAPP_BLOCKLIST` | *(empty)* | Numbers to never message |
| `WHATSAPP_RESPECT_DNC` | `true` | Honour JustDial's DNC flag |
| `WHATSAPP_TEAM_MESSAGE` | built-in lead card | Template for your team |
| `WHATSAPP_MESSAGE` | built-in greeting | Template for the lead |
| `BUSINESS_NAME` | *(empty)* | Fills `{{business}}` |

`MAIL_SUBJECT` placeholders: `{{name}}`, `{{mobile}}`, `{{phone}}`, `{{company}}`,
`{{city}}`, `{{category}}`, `{{area}}`, `{{leadid}}`.

---

## 9. Sending the lead to WhatsApp

With `WHATSAPP_ENABLED=true` every new lead is also sent as a WhatsApp message.
**Your own numbers always get the lead itself** - name, mobile, service, city,
lead id - so the enquiry reaches your team the moment JustDial sends it:

```
*New JustDial Lead*

*Name:* Mr Ramesh Gupta
*Mobile:* 9876501234
*Service:* Interior Designer
*City:* Pune
*Lead ID:* JD-123456

Source: JustDial
```

`WHATSAPP_SEND_TO_LEAD=true` additionally sends the *customer* a polite greeting
(`WHATSAPP_MESSAGE`). Turn it off when you only want the enquiry forwarded
inward. A number that is both yours and the lead's gets the lead card.

It is completely independent of email: if WhatsApp is down the email still goes
out, and the other way round. A failed WhatsApp message waits in
`logs/outbox-whatsapp/` and is retried - and a retry **never re-messages somebody
who already received it**.

### Pick a provider

| `WHATSAPP_PROVIDER` | What it does |
|---|---|
| `wwjs` *(default)* | Runs [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js). You link it to your own WhatsApp once by scanning a QR code. It keeps a real Chrome profile on disk, so the link survives restarts. |
| `openwa` | Runs [open-wa](https://github.com/open-wa/wa-automate-nodejs). Same idea, but its v5 session file is written from an in-page patch that is often missing, so it usually asks for a QR code again after a restart. |
| `webhook` | POSTs the message as JSON to any WhatsApp gateway you already have - [WAHA](https://waha.devlike.pro/), n8n, Make, your own bot. Nothing extra to install. |

### Linking it once (`wwjs` and `openwa`)

```bash
npm install                    # whatsapp-web.js is already in package.json
```

Set `WHATSAPP_ENABLED=true` and start the service. It prints the code in the
terminal, writes the raw value to `logs/whatsapp-qr.txt`, and serves a scannable
page here:

```
https://your-domain.com/whatsapp/qr/YOUR_PATH_SECRET
```

Open that page, then on your phone go to
WhatsApp → **Settings → Linked devices → Link a device** and point the camera at
the screen. (On a local install the same page is at
`http://localhost:3000/whatsapp/qr/YOUR_PATH_SECRET`.)

> That URL is guarded by `PATH_SECRET` on purpose - anybody who could read it
> could link their own WhatsApp to your session.

WhatsApp changes the code every ~20 seconds, so the page reloads itself and you
are always scanning the current one. If a code goes unscanned, the service
offers a fresh one rather than going quiet - see `WHATSAPP_START_RETRIES`.

**That scan is the only one.** The link is remembered in `WHATSAPP_SESSION_DIR`
(`.wa-session/`):

| Provider | What is stored | Survives a hard kill? |
|---|---|---|
| `wwjs` | a full Chrome profile in `session-<WHATSAPP_SESSION_ID>/` | **yes** - written as you go |
| `openwa` | `<WHATSAPP_SESSION_ID>.data.json` | no - written only on a clean shutdown |

Keep that folder private, back it up, and delete it to unlink. To move the link
to another machine, copy the whole `.wa-session/` folder along with the rest of
the service.

To reconnect on demand - handy after editing code, and a quick way to prove the
session is on disk - ask the service to cycle the client:

```bash
curl -X POST https://your-domain.com/whatsapp/reload/YOUR_PATH_SECRET
```

It answers `202` at once, then closes and reopens the WhatsApp client in the
background. `/health` goes back to `ready: true` **without a QR code**, because
it re-reads the session from disk. (With `openwa` this is also what saves the
session, so prefer it over killing the process.)

**It also needs:**

- A Chrome or Chromium on the machine - set `WHATSAPP_CHROME_PATH` if it lives
  somewhere unusual
- On Linux with `openwa`, the `zstd` binary: `apt-get install -y zstd`

If either is missing, the service says exactly what is wrong and **keeps
working** - leads still go out by email, and the WhatsApp message stays queued.

### Provider `webhook`

Point `WHATSAPP_WEBHOOK_URL` at your gateway. It receives:

```http
POST /your-endpoint
Authorization: Bearer <WHATSAPP_WEBHOOK_TOKEN>
Content-Type: application/json

{
  "chatId": "919876543210@c.us",
  "phone": "919876543210",
  "message": "Namaste Ramesh Gupta ji, ...",
  "text": "Namaste Ramesh Gupta ji, ..."
}
```

Any non-2xx answer counts as a failure, so the message is queued and retried.

### The message

Two templates, same placeholders:

| Variable | Goes to | Default |
|---|---|---|
| `WHATSAPP_TEAM_MESSAGE` | `WHATSAPP_TEAM_NUMBERS` - your team | the lead card shown above |
| `WHATSAPP_MESSAGE` | the customer's number, when `WHATSAPP_SEND_TO_LEAD=true` | a Hinglish greeting |

Every placeholder is filled from the lead:

| Placeholder | Becomes |
|---|---|
| `{{name}}` | the person's name, without the prefix |
| `{{fullname}}` | with the prefix - `Mr Ramesh Gupta` |
| `{{mobile}}` `{{phone}}` | the numbers JustDial sent |
| `{{email}}` | the email address, if any |
| `{{category}}` `{{company}}` | what the enquiry is about |
| `{{city}}` `{{area}}` `{{address}}` `{{pincode}}` | where it is |
| `{{leadid}}` `{{leadtype}}` `{{date}}` `{{time}}` | JustDial's own metadata |
| `{{business}}` | `BUSINESS_NAME` from your `.env` |

A placeholder with no value disappears, together with the brackets around it, so
`enquiry ki thi ({{category}}).` still reads properly when the category is empty.
A whole `*Label:*` line whose value is empty is dropped as well, so a half-filled
lead never arrives as a column of blank labels.

A custom team card, for example:

```
WHATSAPP_TEAM_MESSAGE="*Nayi enquiry* 🔔\n\nNaam: {{fullname}}\nMobile: {{mobile}}\nKaam: {{category}}\nJagah: {{city}}\n\nCall kar lena."
```

(`\n` works inside a `.env` value - keep the whole thing on one line, in quotes.)

### Test it

```bash
npm run test:whatsapp                  # offline: template, DNC, webhook. Sends nothing.
npm run send:whatsapp -- 9876543210    # sends ONE real message, through the live provider
```

### Stay out of trouble

WhatsApp dislikes automation, and a number that behaves like a bulk sender gets
banned. This is built for low volume - a JustDial lead now and then - and does
this to stay safe:

- `WHATSAPP_RESPECT_DNC=true` skips anything JustDial flagged as DNC
- `WHATSAPP_BLOCKLIST` leaves specific numbers alone
- a random 5-15 second pause between messages to different numbers
- at most one message per lead, so a retry never duplicates
- `DEDUPE_WINDOW_SECONDS` stops a second message when JustDial retries a call

Keep the volume low and only message people who actually enquired.

---

## 10. The buttons in the lead email

Mail clients strip JavaScript, so a copy button **cannot** copy on its own.
Instead each copy button is an ordinary link to a tiny page on your own
`PUBLIC_URL` (`/copy`), which puts the value on the clipboard — one tap, works
in Gmail, Outlook and on mobile.

The header carries a **Copy all** button that copies the whole lead as tidy
text, ready to paste into WhatsApp or your CRM:

```
Lead ID    : JD-UI-20261017134611
Name       : Mr Ramesh Gupta
Mobile     : 9876501234
Phone      : 02224567890
Email      : ramesh.gupta@example.com
Requirement: Interior Designer
Company    : Sharma Interiors & Decor
Address    : Kothrud, Baner, Pune, 411038
Received   : 17 Oct 2026, 1:46 pm
```

The other buttons need no configuration:

| Button | Opens |
|---|---|
| **Call** | `tel:+91...` — dials from the phone |
| **WhatsApp** | `wa.me/91...` with a pre-filled greeting |
| **Open in Maps** | Google Maps search for the lead's address |

> The copy links point at whatever host the lead arrived on. Behind
> nginx/Cloudflare that is automatic. If your email must show a specific
> domain, set `PUBLIC_URL`.

`MAIL_SUBJECT` placeholders: `{{name}}`, `{{mobile}}`, `{{phone}}`, `{{company}}`,
`{{city}}`, `{{category}}`, `{{area}}`, `{{leadid}}`.

---

## 11. Troubleshooting

**`RECEIVED` but no email**
Run `npm run test:smtp`. Usually a normal Gmail password was used instead of an
App Password, or `MAIL_TO` is empty. Check the service console — a failed send
is logged with the real SMTP error and parked in `logs/outbox/`.

**`Invalid login: 535-5.7.8 Username and Password not accepted`**
That is Google rejecting the credentials → create an App Password (section 3).

**JustDial says the URL failed**
JustDial needs **HTTPS on port 443** (or 80) and a public hostname. Confirm the
endpoint is reachable from outside:

```bash
curl -i "https://leads.yourcompany.com/justdial/lead/YOUR_SECRET?leadid=JD-1&name=Test&mobile=9999999999"
```

**Duplicate emails**
JustDial retries when it does not get a reply quickly. Set
`DEDUPE_WINDOW_SECONDS=30` to collapse those into one email.

**Nothing arrives at all**
Make sure `PATH_SECRET` in `.env` matches the secret in the URL you gave
JustDial, and that the URL is not missing it.

---

## 12. Local smoke test without Gmail

```ini
DRY_RUN=true
```

```bash
npm start
npm run test:lead
```

The console prints the exact email that *would* have been sent, and
`logs/leads-*.jsonl` gets a new line.
