#!/usr/bin/env node
/**
 * JustDial Mailer
 * --------------
 * A tiny standalone service: JustDial calls the endpoint with the lead fields,
 * we reply with the plain text "RECEIVED" straight away, and forward the lead
 * to email - and optionally to the customer's own WhatsApp number - in the
 * background.
 *
 *   GET / POST  {ENDPOINT_PATH}          <- the lead endpoint
 *   GET         {HEALTH_PATH}            <- health / status
 *   GET         {COPY_PATH}              <- the "copy to clipboard" page
 *   GET         /whatsapp/qr/{secret}    <- the WhatsApp QR image
 *
 * Delivery guarantee:
 *   1. the lead is written to logs/leads-YYYY-MM-DD.jsonl
 *   2. the lead is written to logs/outbox/ and logs/outbox-whatsapp/ BEFORE we
 *      reply to JustDial
 *   3. we reply "RECEIVED"
 *   4. email and WhatsApp are sent in the background; a queue entry is removed
 *      on success and retried later on failure
 *
 * That means JustDial never waits on our mail server or on WhatsApp, and no
 * lead is lost even if either of them (or this process) goes down.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config, leadUrl, validateConfig } from './src/config.js';
import { collectInput, isUsable, normalize, parseMultipart } from './src/lead.js';
import { sendLead, verifyTransport } from './src/mailer.js';
import { renderCopyPage } from './src/copyPage.js';
import {
    appendLead,
    basename,
    countQueued,
    deserializeLead,
    ensureDirs,
    enqueue,
    listQueued,
    removeQueued,
    updateQueued,
} from './src/store.js';
import {
    recipientsFor,
    renderWhatsappMessage,
    sendWhatsappText,
    skipReason,
    startWhatsapp,
    stopWhatsapp,
    whatsappStatus,
} from './src/whatsapp.js';
import { log } from './src/logger.js';

const MAX_BODY_BYTES = 256 * 1024;

const leadPath = config.pathSecret
    ? `${config.endpointPath}/${config.pathSecret}`
    : config.endpointPath;

/** Outbox entries currently being emailed (never send one twice). */
const inFlight = new Set();

/** Same, for the WhatsApp outbox. */
const whatsappInFlight = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A random pause between two WhatsApp messages, so we never look like a burst. */
async function paceWhatsapp() {
    const min = Math.max(0, config.whatsapp.minDelaySeconds);
    const max = Math.max(min, config.whatsapp.maxDelaySeconds);
    const ms = (min + Math.random() * (max - min)) * 1000;

    if (ms > 0) await sleep(ms);
}

/** JustDial retries on timeout - optionally ignore the same lead id in a window. */
const recentSends = new Map();

function isDuplicate(lead) {
    if (config.dedupeWindowSeconds <= 0 || !lead.leadId) return false;

    const now = Date.now();
    const last = recentSends.get(lead.leadId);

    if (last && now - last < config.dedupeWindowSeconds * 1000) return true;

    recentSends.set(lead.leadId, now);

    if (recentSends.size > 5000) recentSends.clear();

    return false;
}

async function readBody(req) {
    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
        chunks.push(chunk);
    }

    return Buffer.concat(chunks).toString('utf8');
}

function reply(res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
}

/** The only answer JustDial understands. */
function received(res) {
    reply(res, 200, 'RECEIVED');
}

/**
 * The public URL this request came in on, so the "Copy" links inside the
 * email point at a host the recipient can actually reach. Honours the
 * X-Forwarded-* headers set by nginx / Cloudflare.
 */
function requestBaseUrl(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();

    const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
    const host = forwardedHost || req.headers.host || `localhost:${config.port}`;

    return `${proto}://${host}`;
}

/**
 * The page the email's "Copy" buttons open. The value travels in the URL and
 * is escaped on the way out, so nothing is stored and nothing leaks.
 */
function handleCopy(res, url) {
    const text = (url.searchParams.get('text') || '').slice(0, 4000);
    const label = (url.searchParams.get('label') || '').slice(0, 60);

    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    });

    res.end(renderCopyPage({ text, label }));
}

/**
 * The WhatsApp QR image, so it can be scanned from another device.
 *
 * Guarded by PATH_SECRET on purpose: anybody who could read this could link
 * their own WhatsApp to this session.
 */
function handleQr(res) {
    const status = whatsappStatus();
    const file = status.qrFile ? path.join(config.logs.dir, status.qrFile) : null;

    if (!file || !fs.existsSync(file)) {
        return reply(res, 404, 'No QR code is waiting. See /health for the WhatsApp status.');
    }

    if (path.extname(file).toLowerCase() !== '.png') {
        return reply(res, 200, fs.readFileSync(file, 'utf8'));
    }

    const image = fs.readFileSync(file);

    res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': image.length,
        'Cache-Control': 'no-store',
    });
    res.end(image);

    return undefined;
}

/**
 * Email one outbox entry. On success the entry is removed; on failure it stays
 * put with an extra attempt recorded so the retry loop can try again.
 */
async function deliverQueued(file, data) {
    if (inFlight.has(file)) return false;

    inFlight.add(file);

    try {
        const lead = deserializeLead(data.lead);
        const info = await sendLead(lead);

        removeQueued(file);

        log.info('Lead email sent', {
            leadId: lead.leadId,
            to: config.mail.to,
            attempts: Number(data.attempts || 0) + 1,
            messageId: info.messageId || '(dry run)',
        });

        return true;
    } catch (error) {
        const attempts = Number(data.attempts || 0) + 1;

        updateQueued(file, {
            ...data,
            attempts,
            last_error: String(error.message || error),
            last_attempt_at: new Date().toISOString(),
            gave_up: attempts >= config.maxSendAttempts,
        });

        log.error('Lead email FAILED - kept in the outbox', {
            leadId: data.lead?.leadId,
            attempts,
            maxAttempts: config.maxSendAttempts,
            error: error.message,
        });

        return false;
    } finally {
        inFlight.delete(file);
    }
}

/**
 * Send the WhatsApp message(s) for one outbox entry.
 *
 * The entry keeps a `pending` list of numbers and a `sent_to` list, so a retry
 * never re-messages somebody who already got it.
 */
async function deliverWhatsappQueued(file, data) {
    if (whatsappInFlight.has(file)) return false;

    whatsappInFlight.add(file);

    try {
        const lead = deserializeLead(data.lead);

        const entry = {
            ...data,
            attempts: Number(data.attempts || 0) + 1,
            sent_to: Array.isArray(data.sent_to) ? [...data.sent_to] : [],
            pending: Array.isArray(data.pending) ? [...data.pending] : [],
        };

        if (!entry.pending.length) {
            removeQueued(file);
            return true;
        }

        const text = renderWhatsappMessage(lead);
        let lastError = null;

        while (entry.pending.length) {
            const number = entry.pending[0];

            try {
                await sendWhatsappText(number, text);
            } catch (error) {
                lastError = error;
                break; // keep this number for the next attempt
            }

            entry.sent_to.push(number);
            entry.pending.shift();

            log.info('WhatsApp message sent', {
                leadId: lead.leadId || null,
                to: number,
                remaining: entry.pending.length,
            });

            if (entry.pending.length) await paceWhatsapp();
        }

        entry.last_error = lastError ? String(lastError.message || lastError) : null;

        if (!entry.pending.length) {
            removeQueued(file);

            log.info('WhatsApp delivery complete', {
                leadId: lead.leadId || null,
                to: entry.sent_to,
            });

            return true;
        }

        entry.gave_up = entry.attempts >= config.whatsapp.maxAttempts;
        updateQueued(file, entry);

        log.error('WhatsApp message FAILED - kept in the outbox', {
            leadId: lead.leadId || null,
            to: entry.pending,
            attempts: entry.attempts,
            maxAttempts: config.whatsapp.maxAttempts,
            error: entry.last_error,
        });

        return false;
    } finally {
        whatsappInFlight.delete(file);
    }
}

/**
 * Queue the WhatsApp message for a lead, or explain why it is skipped.
 */
function enqueueWhatsapp(lead) {
    if (!config.whatsapp.enabled) return null;

    const reason = skipReason(lead);

    if (reason) {
        log.info('WhatsApp skipped for this lead', { leadId: lead.leadId || null, reason });
        return null;
    }

    const pending = recipientsFor(lead);

    if (!pending.length) {
        log.info('WhatsApp skipped for this lead', { leadId: lead.leadId || null, reason: 'no recipients' });
        return null;
    }

    const queued = enqueue('whatsapp', lead, { pending });

    if (queued) {
        log.info('WhatsApp message queued', { leadId: lead.leadId || null, pending });
    }

    return queued;
}

async function handleLead(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const contentType = req.headers['content-type'] || '';

    let raw = '';
    let multipart = null;

    if (contentType.toLowerCase().includes('multipart/form-data')) {
        multipart = await parseMultipart(req);
    } else {
        raw = await readBody(req);
    }

    const data = collectInput({ url, raw, contentType, multipart });
    const lead = normalize(data);
    lead.baseUrl = config.publicUrl || requestBaseUrl(req);

    log.info('JustDial lead received', {
        method: req.method,
        contentType: contentType || '(none)',
        leadId: lead.leadId || null,
        fields: Object.keys(data).length,
    });

    if (!isUsable(lead)) {
        log.warn('JustDial call had no usable fields - nothing forwarded', {
            contentType: contentType || '(none)',
            raw: raw.slice(0, 400),
        });
        return received(res);
    }

    if (isDuplicate(lead)) {
        log.info('JustDial lead ignored by the duplicate window', {
            leadId: lead.leadId,
            windowSeconds: config.dedupeWindowSeconds,
        });
        appendLead(lead, { dedupe_skipped: true });
        return received(res);
    }

    // Safe on disk BEFORE we answer, so a crash cannot lose the lead.
    const queuedEmail = enqueue('email', lead);
    const queuedWhatsapp = enqueueWhatsapp(lead);

    appendLead(lead, {
        outbox: queuedEmail ? basename(queuedEmail.file) : null,
        whatsapp_outbox: queuedWhatsapp ? basename(queuedWhatsapp.file) : null,
    });

    // Answer JustDial immediately - it must never wait on our mail server.
    received(res);

    if (queuedEmail) {
        deliverQueued(queuedEmail.file, queuedEmail.data).catch((error) => {
            log.error('Background email delivery crashed', { error: error.message });
        });
    }

    if (queuedWhatsapp) {
        deliverWhatsappQueued(queuedWhatsapp.file, queuedWhatsapp.data).catch((error) => {
            log.error('Background WhatsApp delivery crashed', { error: error.message });
        });
    }

    return undefined;
}

function handleHealth(res) {
    const problems = validateConfig();

    const emailQueue = listQueued('email');
    const emailWaiting = emailQueue.filter((item) => !item.data.delivered && !item.data.gave_up).length;

    const whatsappQueue = config.whatsapp.enabled ? listQueued('whatsapp') : [];
    const whatsappWaiting = whatsappQueue.filter((item) => !item.data.delivered && !item.data.gave_up).length;

    reply(res, 200, JSON.stringify({
        service: 'justdial-mailer',
        status: problems.length && !config.dryRun ? 'degraded' : 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        dryRun: config.dryRun,
        endpoint: config.pathSecret ? `${config.endpointPath}/***` : config.endpointPath,
        dedupeWindowSeconds: config.dedupeWindowSeconds,
        mail: {
            to: config.mail.to,
            from: config.mail.from || config.smtp.user,
            smtpHost: config.smtp.host,
            smtpPort: config.smtp.port,
        },
        whatsapp: whatsappStatus(),
        outbox: {
            waiting: emailWaiting,
            total: emailQueue.length,
            inFlight: inFlight.size,
        },
        whatsappOutbox: {
            waiting: whatsappWaiting,
            total: whatsappQueue.length,
            inFlight: whatsappInFlight.size,
        },
        problems,
        time: new Date().toISOString(),
    }, null, 2), 'application/json; charset=utf-8');
}

async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === config.healthPath) {
        return handleHealth(res);
    }

    if (req.method === 'GET' && path === config.copyPath.replace(/\/+$/, '')) {
        return handleCopy(res, url);
    }

    if (req.method === 'GET' && config.pathSecret && path === `/whatsapp/qr/${config.pathSecret}`) {
        return handleQr(res);
    }

    if (path === leadPath && (req.method === 'GET' || req.method === 'POST')) {
        return handleLead(req, res);
    }

    if (path === leadPath) {
        return reply(res, 405, 'Method Not Allowed');
    }

    return reply(res, 404, 'Not Found');
}

/**
 * Try every queued entry that has not been delivered yet.
 */
async function retryOutbox() {
    await retryQueue('email', deliverQueued);

    if (config.whatsapp.enabled) {
        await retryQueue('whatsapp', deliverWhatsappQueued);
    }
}

async function retryQueue(kind, deliver) {
    const pending = listQueued(kind).filter(({ data }) => !data.delivered && !data.gave_up);

    if (!pending.length) return;

    log.info(`Retrying ${pending.length} queued ${kind} message(s)`);

    for (const { file, data } of pending) {
        await deliver(file, data);
    }
}

async function main() {
    ensureDirs();

    const whatsappLine = config.whatsapp.enabled
        ? [
            config.whatsapp.provider,
            config.whatsapp.sendToLead ? 'lead number' : null,
            config.whatsapp.teamNumbers.length ? `${config.whatsapp.teamNumbers.length} team number(s)` : null,
        ].filter(Boolean).join(' + ')
        : 'off';

    console.log('');
    console.log('  JustDial Mailer');
    console.log('  ---------------');
    console.log(`  Lead endpoint : ${leadUrl()}`);
    console.log(`  Health check  : http://localhost:${config.port}${config.healthPath}`);
    console.log(`  Emails go to  : ${config.mail.to.join(', ') || '(none configured!)'}`);
    console.log(`  WhatsApp      : ${whatsappLine}`);
    console.log(`  Mode          : ${config.dryRun ? 'DRY RUN (nothing is actually sent)' : 'LIVE'}`);
    console.log('');

    const problems = validateConfig();
    if (problems.length) {
        log.warn('Configuration problems', { problems });
        console.warn('   -> Edit the .env file and restart.');
    }

    const smtp = await verifyTransport();
    if (smtp.ok) log.info(smtp.message);
    else log.error('SMTP check failed', { error: smtp.message });

    const queuedAtBoot = countQueued('email') + (config.whatsapp.enabled ? countQueued('whatsapp') : 0);

    if (config.retryIntervalSeconds > 0) {
        setInterval(() => {
            retryOutbox().catch((error) => log.error('Retry loop crashed', { error: error.message }));
        }, config.retryIntervalSeconds * 1000).unref();
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
            log.error('Request handling failed', { error: error.message, url: req.url });

            // Never leave JustDial waiting.
            if (!res.headersSent) received(res);
            else res.end();
        });
    });

    server.headersTimeout = 20000;
    server.requestTimeout = 30000;

    server.listen(config.port, config.host, () => {
        log.info('Listening', { host: config.host, port: config.port });

        // Bring WhatsApp up in the background - it must never delay the endpoint.
        if (config.whatsapp.enabled) {
            startWhatsapp().then(() => {
                const status = whatsappStatus();

                if (status.ready) log.info('WhatsApp is ready to send');
                else log.warn('WhatsApp is not ready yet - see the error above', { status: status.status });
            });
        }

        // Recover anything the mail server refused while we were down.
        if (queuedAtBoot > 0) {
            setTimeout(() => {
                retryOutbox().catch((error) => log.error('Boot retry failed', { error: error.message }));
            }, 2000).unref();
        }
    });

    const shutdown = (signal) => {
        log.info(`Received ${signal} - shutting down`, {
            inFlight: inFlight.size,
            whatsappInFlight: whatsappInFlight.size,
        });

        Promise.race([stopWhatsapp(), sleep(5000)])
            .catch(() => {})
            .finally(() => {
                server.close(() => process.exit(0));
                setTimeout(() => process.exit(0), 8000).unref();
            });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
    console.error('Fatal startup error:', error);
    process.exit(1);
});
