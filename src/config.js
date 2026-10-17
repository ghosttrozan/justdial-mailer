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

    if (!config.smtp.user) problems.push('SMTP_USER is empty');
    if (!config.smtp.pass) problems.push('SMTP_PASS is empty');
    if (!config.mail.to.length) problems.push('MAIL_TO is empty');
    if (!config.mail.from && !config.smtp.user) problems.push('MAIL_FROM is empty');

    return problems;
}
