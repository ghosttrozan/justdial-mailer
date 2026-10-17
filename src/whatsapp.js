import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { fillTemplate, tidyTemplate } from './lead.js';
import { normalisePhone } from './links.js';
import { log } from './logger.js';

/**
 * Sends the lead to the customer's own WhatsApp number.
 *
 * Two providers, chosen with WHATSAPP_PROVIDER:
 *
 *   openwa   the @open-wa/wa-automate library runs in this process, linked to
 *            your own WhatsApp once by scanning a QR code
 *   webhook  the message is POSTed as JSON to any WhatsApp HTTP gateway
 *            (WAHA, n8n, Make, your own bot ...)
 *
 * Nothing here can break the lead flow: every failure is caught, logged and
 * left in logs/outbox-whatsapp/ to be retried. The email always goes out.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
    status: config.whatsapp.enabled ? 'starting' : 'disabled',
    ready: false,
    client: null,
    readyPromise: null,
    connectedAt: null,
    lastError: null,
    qrFile: null,
    qrSavedAt: null,
    sent: 0,
    failed: 0,
    lastSendAt: null,
};

/* ------------------------------------------------------------------ *
 * Message
 * ------------------------------------------------------------------ */

/**
 * The WhatsApp text for a lead, with every {{placeholder}} filled in.
 */
export function renderWhatsappMessage(lead) {
    return tidyTemplate(fillTemplate(config.whatsapp.message, lead));
}

/* ------------------------------------------------------------------ *
 * Who to message, and who to skip
 * ------------------------------------------------------------------ */

function isFlagOn(value) {
    return ['1', 'true', 'yes', 'y', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

/** Blocklist entries may be a full number or just the last few digits. */
export function isBlocked(number) {
    for (const entry of config.whatsapp.blocklist) {
        const blocked = normalisePhone(entry);
        if (!blocked) continue;

        if (blocked.length >= 10 ? blocked === number : number.endsWith(blocked)) return true;
    }

    return false;
}

/**
 * Why this lead should NOT be WhatsApped, or null when it is fine to send.
 */
export function skipReason(lead) {
    if (!config.whatsapp.enabled) return 'WhatsApp sending is turned off';

    const number = normalisePhone(lead.mobile || lead.phone);
    if (!number || number.length < 10) return 'the lead has no usable mobile number';

    if (isBlocked(number)) return 'the number is on WHATSAPP_BLOCKLIST';

    if (!config.whatsapp.sendToLead && !config.whatsapp.teamNumbers.length) {
        return 'nothing is configured to receive the message';
    }

    if (config.whatsapp.respectDnc) {
        // JustDial flags numbers that must not be contacted - respect them.
        if (isFlagOn(lead.raw?.dncmobile)) return 'the JustDial DNC flag is set on the mobile number';
        if (isFlagOn(lead.raw?.dncphone)) return 'the JustDial DNC flag is set on the phone number';
    }

    return null;
}

/**
 * The numbers this lead should be sent to: the customer, plus any team numbers.
 */
export function recipientsFor(lead) {
    const numbers = [];

    if (config.whatsapp.sendToLead) {
        const leadNumber = normalisePhone(lead.mobile || lead.phone);
        if (leadNumber && leadNumber.length >= 10 && !isBlocked(leadNumber)) numbers.push(leadNumber);
    }

    for (const entry of config.whatsapp.teamNumbers) {
        const number = normalisePhone(entry);
        if (number && !isBlocked(number)) numbers.push(number);
    }

    return [...new Set(numbers)];
}

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

/**
 * Send one message. Throws on failure so the caller can queue a retry.
 */
export async function sendWhatsappText(number, text) {
    const chatId = `${number}@c.us`;

    if (config.dryRun) {
        log.info('DRY_RUN - WhatsApp message NOT sent', { to: number });
        log.info('DRY_RUN WhatsApp body\n' + text);
        state.sent += 1;
        state.lastSendAt = new Date().toISOString();
        return { to: number, chatId, dryRun: true };
    }

    try {
        const result = config.whatsapp.provider === 'webhook'
            ? await sendViaWebhook(number, text)
            : await sendViaOpenWa(number, text);

        state.sent += 1;
        state.lastSendAt = new Date().toISOString();

        return result;
    } catch (error) {
        state.failed += 1;
        state.lastError = String(error?.message || error);
        throw error;
    }
}

/** Convenience: render the message for a lead and send it to one number. */
export async function sendLeadWhatsapp(lead, number) {
    return sendWhatsappText(number, renderWhatsappMessage(lead));
}

async function sendViaWebhook(number, text) {
    const { webhookUrl, webhookToken } = config.whatsapp;

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(webhookToken ? { Authorization: `Bearer ${webhookToken}` } : {}),
        },
        body: JSON.stringify({
            chatId: `${number}@c.us`,
            phone: number,
            message: text,
            text,
        }),
        signal: AbortSignal.timeout(30000),
    });

    const body = await response.text();

    if (!response.ok) {
        throw new Error(`the WhatsApp webhook answered ${response.status}: ${body.slice(0, 200)}`);
    }

    return { to: number, via: 'webhook', status: response.status, body: body.slice(0, 300) };
}

async function sendViaOpenWa(number, text) {
    if (!state.client) await waitForClient();

    if (!state.client) {
        throw new Error(state.lastError || 'the WhatsApp client is not connected yet');
    }

    for (const method of ['sendText', 'sendMessage']) {
        if (typeof state.client[method] === 'function') {
            return state.client[method](`${number}@c.us`, text);
        }
    }

    throw new Error('the WhatsApp client has no sendText() method - is the open-wa version supported?');
}

/* ------------------------------------------------------------------ *
 * The open-wa provider
 * ------------------------------------------------------------------ */

let openwaModule = null;

/**
 * Load @open-wa/wa-automate lazily, and turn any failure into a message that
 * says exactly what to do about it.
 */
async function loadOpenWa() {
    if (openwaModule) return openwaModule;

    try {
        const loaded = await import('@open-wa/wa-automate');
        const api = loaded && typeof loaded.create === 'function' ? loaded : loaded?.default;

        if (!api || typeof api.create !== 'function') {
            throw new Error('the module loaded but does not export create()');
        }

        openwaModule = api;
        return api;
    } catch (error) {
        throw new Error(
            'The open-wa library could not be loaded (' + (error?.message || error) + '). '
            + 'Fix it with: npm install @open-wa/wa-automate'
            + ' - on Linux you may also need: apt-get install -y zstd',
        );
    }
}

/** open-wa hands the QR to its "output sink" - we intercept it and save a PNG. */
function installQrSink(api) {
    if (typeof api.setCliOutputSink !== 'function' || typeof api.createConsoleOutputSink !== 'function') {
        log.warn('open-wa does not expose its output sink - the QR will only show in the console');
        return;
    }

    const base = api.createConsoleOutputSink();

    const sink = {
        write: (entry) => base.write(entry),
        status: (update) => {
            if (update?.phase === 'auth.qr') state.status = 'qr';
            return base.status(update);
        },
        qr: (payload) => {
            try {
                base.qr(payload);
            } catch {
                /* the console sink is best effort */
            }
            saveQr(payload);
        },
    };

    if (typeof base.promptChoice === 'function') {
        sink.promptChoice = (question, choices) => base.promptChoice(question, choices);
    }

    api.setCliOutputSink(sink);
}

function saveQr(payload) {
    const qr = payload?.qr;
    if (!qr) return;

    try {
        const base64 = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(qr);
        const file = path.join(config.logs.dir, base64 ? 'whatsapp-qr.png' : 'whatsapp-qr.txt');

        if (base64) fs.writeFileSync(file, Buffer.from(base64[1], 'base64'));
        else fs.writeFileSync(file, qr);

        state.qrFile = file;
        state.qrSavedAt = new Date().toISOString();
        state.status = 'qr';

        log.warn('WhatsApp is not linked yet - scan the QR to connect', { qr: file });
    } catch (error) {
        log.error('Could not save the WhatsApp QR code', { error: error.message });
    }
}

function extraOpenWaOptions() {
    if (!config.whatsapp.extraOptions) return {};

    try {
        const parsed = JSON.parse(config.whatsapp.extraOptions);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        log.warn('WHATSAPP_OPENWA_OPTIONS is not valid JSON - ignoring it', { error: error.message });
        return {};
    }
}

async function createOpenWaClient() {
    const api = await loadOpenWa();

    installQrSink(api);

    const options = {
        sessionId: config.whatsapp.sessionId,
        sessionDataPath: config.whatsapp.sessionDir,
        headless: config.whatsapp.headless,
        multiDevice: true,
        // 0 = wait forever for a QR scan / an authenticated session.
        qrTimeout: 0,
        authTimeout: 0,
    };

    if (config.whatsapp.chromePath) options.executablePath = config.whatsapp.chromePath;
    if (config.whatsapp.licenseKey) options.licenseKey = config.whatsapp.licenseKey;

    Object.assign(options, extraOpenWaOptions());

    log.info('Starting the WhatsApp client - the first run shows a QR code to scan', {
        sessionId: options.sessionId,
        sessionDir: options.sessionDataPath,
        headless: options.headless,
    });

    return api.create(options);
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Wait for the WhatsApp client to come up. The first run needs a QR scan, so
 * this waits (bounded by WHATSAPP_START_TIMEOUT_SECONDS) and then gives up -
 * the retry loop will pick the message up again.
 */
async function waitForClient() {
    startWhatsapp(); // idempotent: returns the attempt already in flight

    const deadline = Date.now() + config.whatsapp.startTimeoutSeconds * 1000;

    while (!state.client && Date.now() < deadline) {
        await sleep(2000);
    }
}

/**
 * Bring the WhatsApp client up. Never rejects - check whatsappStatus().ready.
 */
export function startWhatsapp() {
    if (!config.whatsapp.enabled) {
        state.status = 'disabled';
        return Promise.resolve(null);
    }

    if (state.readyPromise) return state.readyPromise;

    state.status = 'starting';
    state.lastError = null;

    const attempt = (async () => {
        if (config.whatsapp.provider === 'webhook') {
            if (!config.whatsapp.webhookUrl) throw new Error('WHATSAPP_WEBHOOK_URL is empty');

            state.ready = true;
            state.status = 'ready';
            state.connectedAt = new Date().toISOString();

            log.info('WhatsApp is ready (webhook provider)', { url: config.whatsapp.webhookUrl });
            return null;
        }

        const client = await createOpenWaClient();

        state.client = client;
        state.ready = true;
        state.status = 'ready';
        state.connectedAt = new Date().toISOString();
        state.qrFile = null;

        log.info('WhatsApp is linked - leads are now messaged automatically', {
            sessionId: config.whatsapp.sessionId,
        });

        return client;
    })().catch((error) => {
        state.ready = false;
        state.status = 'error';
        state.lastError = String(error?.message || error);
        state.readyPromise = null; // allow a later retry

        log.error('WhatsApp could not start - leads still go out by email', { error: state.lastError });

        return null;
    });

    state.readyPromise = attempt;
    return attempt;
}

export async function stopWhatsapp() {
    const client = state.client;

    state.client = null;
    state.ready = false;
    state.readyPromise = null;

    if (!client) return;

    try {
        const close = client.close || client.kill || client.destroy;
        if (typeof close === 'function') await close.call(client);
    } catch (error) {
        log.warn('The WhatsApp client did not shut down cleanly', { error: error.message });
    }
}

export function whatsappStatus() {
    return {
        enabled: config.whatsapp.enabled,
        provider: config.whatsapp.provider,
        status: config.whatsapp.enabled ? state.status : 'disabled',
        ready: state.ready,
        sessionId: config.whatsapp.sessionId,
        connectedAt: state.connectedAt,
        qrFile: state.qrFile ? path.basename(state.qrFile) : null,
        qrSavedAt: state.qrSavedAt,
        lastError: state.lastError,
        sent: state.sent,
        failed: state.failed,
        lastSendAt: state.lastSendAt,
        sendToLead: config.whatsapp.sendToLead,
        teamNumbers: config.whatsapp.teamNumbers.length,
    };
}
