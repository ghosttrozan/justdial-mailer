#!/usr/bin/env node
/**
 * JustDial Mailer
 * --------------
 * A tiny standalone service: JustDial calls the endpoint with the lead fields,
 * we reply with the plain text "RECEIVED" straight away and forward the lead
 * to email in the background.
 *
 *   GET / POST  {ENDPOINT_PATH}          <- the lead endpoint
 *   GET         {HEALTH_PATH}            <- health / status
 *
 * Delivery guarantee:
 *   1. the lead is written to logs/leads-YYYY-MM-DD.jsonl
 *   2. the lead is written to logs/outbox/  (on disk, before we reply)
 *   3. we reply "RECEIVED" to JustDial
 *   4. the email is sent in the background; the outbox entry is removed on
 *      success and retried later on failure
 *
 * That means JustDial never waits on our mail server, and no lead is lost even
 * if the mail server (or this process) goes down.
 */
import http from 'node:http';
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
import { log } from './src/logger.js';

const MAX_BODY_BYTES = 256 * 1024;

const leadPath = config.pathSecret
    ? `${config.endpointPath}/${config.pathSecret}`
    : config.endpointPath;

/** Outbox entries currently being emailed (never send one twice). */
const inFlight = new Set();

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
    const queued = enqueue(lead);
    appendLead(lead, { outbox: queued ? basename(queued.file) : null });

    // Answer JustDial immediately - it must never wait on our mail server.
    received(res);

    if (queued) {
        deliverQueued(queued.file, queued.data).catch((error) => {
            log.error('Background delivery crashed', { error: error.message });
        });
    }

    return undefined;
}

function handleHealth(res) {
    const problems = validateConfig();
    const queued = listQueued();
    const waiting = queued.filter((item) => !item.data.delivered).length;

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
        outbox: {
            waiting,
            total: queued.length,
            inFlight: inFlight.size,
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

    if (path === leadPath && (req.method === 'GET' || req.method === 'POST')) {
        return handleLead(req, res);
    }

    if (path === leadPath) {
        return reply(res, 405, 'Method Not Allowed');
    }

    return reply(res, 404, 'Not Found');
}

/**
 * Try every outbox entry that has not been delivered yet.
 */
async function retryOutbox() {
    const items = listQueued();
    if (!items.length) return;

    const pending = items.filter(({ data }) => !data.delivered && !data.gave_up);

    if (!pending.length) return;

    log.info(`Retrying ${pending.length} lead email(s) from the outbox`);

    for (const { file, data } of pending) {
        await deliverQueued(file, data);
    }
}

async function main() {
    ensureDirs();

    console.log('');
    console.log('  JustDial Mailer');
    console.log('  ---------------');
    console.log(`  Lead endpoint : ${leadUrl()}`);
    console.log(`  Health check  : http://localhost:${config.port}${config.healthPath}`);
    console.log(`  Emails go to  : ${config.mail.to.join(', ') || '(none configured!)'}`);
    console.log(`  Mode          : ${config.dryRun ? 'DRY RUN (no email is sent)' : 'LIVE'}`);
    console.log('');

    const problems = validateConfig();
    if (problems.length) {
        log.warn('Configuration problems', { problems });
        console.warn('   -> Edit the .env file and restart.');
    }

    const smtp = await verifyTransport();
    if (smtp.ok) log.info(smtp.message);
    else log.error('SMTP check failed', { error: smtp.message });

    const queuedAtBoot = countQueued();

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

        // Recover anything the mail server refused while we were down.
        if (queuedAtBoot > 0) {
            setTimeout(() => {
                retryOutbox().catch((error) => log.error('Boot retry failed', { error: error.message }));
            }, 2000).unref();
        }
    });

    const shutdown = (signal) => {
        log.info(`Received ${signal} - shutting down`, { inFlight: inFlight.size });
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 8000).unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
    console.error('Fatal startup error:', error);
    process.exit(1);
});
