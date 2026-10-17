import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Two independent outboxes.
 *
 *   email     logs/outbox/            a lead waiting to be emailed
 *   whatsapp  logs/outbox-whatsapp/   a lead waiting to be WhatsApped
 *
 * They are separate on purpose: if the mail server is down but WhatsApp is
 * fine, the email must be retried WITHOUT re-sending the WhatsApp message, and
 * the other way round.
 *
 * Nothing can be lost - not by a mail/WhatsApp outage, not by a crash - because
 * the lead is on disk before we answer JustDial.
 */
const QUEUE_DIRS = {
    email: 'outbox',
    whatsapp: 'outbox-whatsapp',
};

export function queueDir(kind = 'email') {
    return path.join(config.logs.dir, QUEUE_DIRS[kind] || QUEUE_DIRS.email);
}

/** Kept for backwards compatibility - this is the email outbox. */
export const outboxDir = queueDir('email');

export function ensureDirs() {
    fs.mkdirSync(config.logs.dir, { recursive: true });
    for (const kind of Object.keys(QUEUE_DIRS)) {
        fs.mkdirSync(queueDir(kind), { recursive: true });
    }
}

function dayStamp(date = new Date()) {
    return new Date(date).toISOString().slice(0, 10);
}

export function leadsFile(date = new Date()) {
    return path.join(config.logs.dir, `leads-${dayStamp(date)}.jsonl`);
}

export function serializeLead(lead) {
    return { ...lead, receivedAt: lead.receivedAt.toISOString() };
}

export function deserializeLead(data) {
    return { ...data, receivedAt: data.receivedAt ? new Date(data.receivedAt) : new Date() };
}

export function basename(file) {
    return String(file || '').split(/[\\/]/).pop();
}

/**
 * Append the lead to today's JSONL file. This is the permanent record of
 * everything JustDial ever sent us.
 */
export function appendLead(lead, meta = {}) {
    const record = {
        received_at: lead.receivedAt.toISOString(),
        lead_id: lead.leadId || null,
        name: lead.fullName,
        mobile: lead.mobile || null,
        phone: lead.phone || null,
        email: lead.email || null,
        company: lead.company || null,
        category: lead.category || null,
        city: lead.city || null,
        address: lead.address || null,
        lead_type: lead.leadType || null,
        lead_date: lead.date || null,
        lead_time: lead.time || null,
        ...meta,
        raw: lead.raw,
    };

    try {
        fs.appendFileSync(leadsFile(lead.receivedAt), JSON.stringify(record) + '\n');
        return true;
    } catch (error) {
        log.error('Could not write to the leads log file', { error: error.message });
        return false;
    }
}

/**
 * Put a lead in one of the outboxes. Returns { file, data } or null.
 * Any extra keys (for WhatsApp: the pending recipient list) are stored with it
 * so a retry knows exactly what is left to do.
 */
export function enqueue(kind, lead, extra = {}) {
    ensureDirs();

    const safeId = String(lead.leadId || 'noleadid').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 40);
    const file = path.join(queueDir(kind), `${Date.now()}-${safeId}-${crypto.randomUUID().slice(0, 8)}.json`);

    const data = {
        kind,
        queued_at: new Date().toISOString(),
        attempts: 0,
        delivered: false,
        gave_up: false,
        last_error: null,
        ...extra,
        lead: serializeLead(lead),
    };

    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return { file, data };
    } catch (writeError) {
        log.error(`Could not add the lead to the ${kind} outbox`, { error: writeError.message });
        return null;
    }
}

export function listQueued(kind = 'email') {
    ensureDirs();

    const dir = queueDir(kind);

    let files = [];
    try {
        files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
        return [];
    }

    const out = [];

    for (const name of files) {
        const file = path.join(dir, name);
        try {
            out.push({ file, data: JSON.parse(fs.readFileSync(file, 'utf8')) });
        } catch (error) {
            log.warn('Unreadable outbox file, skipping', { file: name, error: error.message });
        }
    }

    return out.sort((a, b) => String(a.data.queued_at).localeCompare(String(b.data.queued_at)));
}

export function updateQueued(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        log.error('Could not update the outbox file', { file: basename(file), error: error.message });
        return false;
    }
}

export function removeQueued(file) {
    try {
        fs.unlinkSync(file);
        return true;
    } catch {
        return false;
    }
}

export function countQueued(kind = 'email') {
    try {
        return fs.readdirSync(queueDir(kind)).filter((name) => name.endsWith('.json')).length;
    } catch {
        return 0;
    }
}
