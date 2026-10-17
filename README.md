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
- Clean lead email with **Call / WhatsApp / Maps** buttons
- **Copy button on every field**, plus a **Copy all** button
- Optional duplicate window (JustDial retries on timeout)
- Zero frameworks — just Node's `http`, `nodemailer` and `busboy`

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

`MAIL_SUBJECT` placeholders: `{{name}}`, `{{mobile}}`, `{{phone}}`, `{{company}}`,
`{{city}}`, `{{category}}`, `{{area}}`, `{{leadid}}`.

---

## 9. The buttons in the lead email

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

## 10. Troubleshooting

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

## 11. Local smoke test without Gmail

```ini
DRY_RUN=true
```

```bash
npm start
npm run test:lead
```

The console prints the exact email that *would* have been sent, and
`logs/leads-*.jsonl` gets a new line.
