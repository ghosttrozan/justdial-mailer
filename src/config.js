import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(value, fallback = false) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(value, fallback) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value) {
    return String(value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * The default WhatsApp message sent to a new lead.
 *
 * {{name}} {{category}} {{city}} {{company}} {{business}} {{mobile}} and more
 * are replaced from the lead - see README section 10 for the full list.
 */
const DEFAULT_WHATSAPP_MESSAGE = [
    'Namaste {{name}} ji,',
    '',
    'Aapne JustDial par enquiry ki thi ({{category}}).',
    'Hum aapki puri madad kar sakte hain.',
    '',
    'Kya hum aapko ek call kar sakte hain?',
    '',
    '- {{business}}',
].join('\n');

/**
 * The default WhatsApp message sent to YOUR team - the lead itself.
 *
 * This is deliberately not the customer greeting: the team wants the enquiry
 * details, not a polite hello. Empty fields drop their whole line (see
 * renderTeamMessage), so a half-filled lead still reads cleanly.
 */
const DEFAULT_WHATSAPP_TEAM_MESSAGE = [
    '*New JustDial Lead*',
    '',
    '*Name:* {{fullname}}',
    '*Mobile:* {{mobile}}',
    '*Phone:* {{phone}}',
    '*Email:* {{email}}',
    '*Service:* {{category}}',
    '*Company:* {{company}}',
    '*Address:* {{address}}',
    '*Lead ID:* {{leadid}}',
    '*Received:* {{date}} {{time}}',
    '',
    'Source: JustDial',
].join('\n');

export const config = {
    rootDir,

    port: int(process.env.PORT, 3000),
    host: process.env.HOST || '0.0.0.0',

    endpointPath: (process.env.ENDPOINT_PATH || '/justdial/lead').replace(/\/+$/, '') || '/justdial/lead',
    pathSecret: (process.env.PATH_SECRET || '').trim(),
    healthPath: process.env.HEALTH_PATH || '/health',

    smtp: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: int(process.env.SMTP_PORT, 587),
        secure: bool(process.env.SMTP_SECURE, false),
        user: (process.env.SMTP_USER || '').trim(),
        pass: (process.env.SMTP_PASS || '').trim(),
    },

    resendApiKey: (process.env.RESEND_API_KEY || '').trim(),

    mail: {
        from: (process.env.MAIL_FROM || '').trim(),
        fromName: (process.env.MAIL_FROM_NAME || 'JustDial Leads').trim(),
        to: list(process.env.MAIL_TO),
        cc: list(process.env.MAIL_CC),
        subject: process.env.MAIL_SUBJECT || 'New JustDial Lead: {{name}} ({{mobile}})',
    },

    dryRun: bool(process.env.DRY_RUN, false),
    dedupeWindowSeconds: int(process.env.DEDUPE_WINDOW_SECONDS, 0),
    retryIntervalSeconds: int(process.env.RETRY_INTERVAL_SECONDS, 300),
    maxSendAttempts: int(process.env.MAX_SEND_ATTEMPTS, 10),

    // Used to stamp "received at" in the email.
    timezone: process.env.TIMEZONE || 'Asia/Kolkata',

    // Public base URL used to build the "Copy" links inside the email.
    // Leave empty and it is derived from the request that delivered the lead,
    // which is correct behind nginx/Cloudflare without any configuration.
    publicUrl: (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),

    // Path of the little "copy to clipboard" page the email buttons link to.
    copyPath: (process.env.COPY_PATH || '/copy').trim() || '/copy',

    // JustDial is India-only; 10 digit numbers get this prefixed for tel:/wa.me.
    countryCode: (process.env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '') || '91',

    // Pre-filled WhatsApp message when the "WhatsApp" button is tapped.
    whatsappGreeting: process.env.WHATSAPP_GREETING || 'Hello {{name}}, thank you for your enquiry on JustDial. How can we help you?',

    // Shown in the WhatsApp message as {{business}}. Set it in .env.
    businessName: (process.env.BUSINESS_NAME || '').trim(),

    // ------------------------------------------------------------------
    // WhatsApp sending (sends the lead to the customer's own number)
    // ------------------------------------------------------------------
    whatsapp: {
        enabled: bool(process.env.WHATSAPP_ENABLED, false),

        // 'wwjs'    = the whatsapp-web.js library, in this process. Keeps a real
        //             Chrome profile, so the link survives a restart.
        // 'openwa'  = the @open-wa/wa-automate library, in this process
        // 'webhook' = POST the message to any WhatsApp HTTP gateway
        provider: (process.env.WHATSAPP_PROVIDER || 'wwjs').trim().toLowerCase(),

        // --- provider: webhook ---
        webhookUrl: (process.env.WHATSAPP_WEBHOOK_URL || '').trim(),
        webhookToken: (process.env.WHATSAPP_WEBHOOK_TOKEN || '').trim(),

        // --- provider: openwa / wwjs ---
        sessionId: (process.env.WHATSAPP_SESSION_ID || 'justdial-mailer').trim(),
        sessionDir: path.isAbsolute(process.env.WHATSAPP_SESSION_DIR || '')
            ? process.env.WHATSAPP_SESSION_DIR
            : path.join(rootDir, process.env.WHATSAPP_SESSION_DIR || '.wa-session'),
        headless: bool(process.env.WHATSAPP_HEADLESS, true),
        chromePath: (process.env.WHATSAPP_CHROME_PATH || '').trim(),
        licenseKey: (process.env.WHATSAPP_LICENSE_KEY || '').trim(),

        // Escape hatch: extra open-wa options as JSON, merged last.
        extraOptions: (process.env.WHATSAPP_OPENWA_OPTIONS || '').trim(),

        // --- who gets messaged ---
        sendToLead: bool(process.env.WHATSAPP_SEND_TO_LEAD, true),
        teamNumbers: list(process.env.WHATSAPP_TEAM_NUMBERS),
        blocklist: list(process.env.WHATSAPP_BLOCKLIST),
        respectDnc: bool(process.env.WHATSAPP_RESPECT_DNC, true),

        // --- the message ---
        // To the lead (the customer). Only used when sendToLead is on.
        message: process.env.WHATSAPP_MESSAGE || DEFAULT_WHATSAPP_MESSAGE,

        // To your team numbers. This is the lead card.
        teamMessage: process.env.WHATSAPP_TEAM_MESSAGE || DEFAULT_WHATSAPP_TEAM_MESSAGE,

        // --- pacing, so WhatsApp never sees a burst ---
        minDelaySeconds: int(process.env.WHATSAPP_MIN_DELAY_SECONDS, 5),
        maxDelaySeconds: int(process.env.WHATSAPP_MAX_DELAY_SECONDS, 15),

        // --- retries ---
        maxAttempts: int(process.env.WHATSAPP_MAX_ATTEMPTS, 5),

        // How long a send waits for the WhatsApp client to come up before it
        // gives up and lets the retry loop try again later.
        startTimeoutSeconds: int(process.env.WHATSAPP_START_TIMEOUT_SECONDS, 120),

        // open-wa stops waiting for a scan after a few minutes, which leaves the
        // linking page dead just as somebody finally reaches for their phone.
        // Offer a fresh code instead of going quiet.
        startRetries: int(process.env.WHATSAPP_START_RETRIES, 10),
        startRetrySeconds: int(process.env.WHATSAPP_START_RETRY_SECONDS, 15),
    },

    logs: {
        dir: path.isAbsolute(process.env.LOG_DIR || '')
            ? process.env.LOG_DIR
            : path.join(rootDir, process.env.LOG_DIR || 'logs'),
    },
};

/**
 * The exact URL JustDial should be given.
 */
export function leadUrl(baseUrl = `http://localhost:${config.port}`) {
    const base = String(baseUrl).replace(/\/+$/, '');
    return config.pathSecret
        ? `${base}${config.endpointPath}/${config.pathSecret}`
        : `${base}${config.endpointPath}`;
}

/**
 * Called on boot. Warns (but never crashes) when something is missing.
 */
export function validateConfig() {
    const problems = [];

    if (!config.resendApiKey) {
        if (!config.smtp.user) problems.push('SMTP_USER is empty (or provide RESEND_API_KEY)');
        if (!config.smtp.pass) problems.push('SMTP_PASS is empty (or provide RESEND_API_KEY)');
        if (!config.mail.from && !config.smtp.user) problems.push('MAIL_FROM is empty');
    }

    if (!config.mail.to.length) problems.push('MAIL_TO is empty');

    if (config.whatsapp.enabled) {
        if (!['openwa', 'wwjs', 'webhook'].includes(config.whatsapp.provider)) {
            problems.push(`WHATSAPP_PROVIDER "${config.whatsapp.provider}" is not known (use wwjs, openwa or webhook)`);
        }

        if (config.whatsapp.provider === 'webhook' && !config.whatsapp.webhookUrl) {
            problems.push('WHATSAPP_WEBHOOK_URL is empty');
        }

        if (!config.whatsapp.sendToLead && !config.whatsapp.teamNumbers.length) {
            problems.push('WhatsApp is on but nothing would receive a message');
        }
    }

    return problems;
}
