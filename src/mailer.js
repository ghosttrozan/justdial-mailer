import nodemailer from 'nodemailer';
import { config } from './config.js';
import { KNOWN_FIELDS } from './lead.js';
import { log } from './logger.js';

let transporter = null;

export function getTransporter() {
    if (transporter) return transporter;

    transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure, // false => STARTTLS (Gmail port 587)
        auth: config.smtp.user
            ? { user: config.smtp.user, pass: config.smtp.pass }
            : undefined,
        pool: true,
        maxConnections: 3,
        maxMessages: 50,
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 25000,
    });

    return transporter;
}

/**
 * Boot-time SMTP check. Returns { ok, message } - never throws.
 */
export async function verifyTransport() {
    if (config.dryRun) return { ok: true, message: 'DRY_RUN is on - email is not actually sent.' };

    try {
        await getTransporter().verify();
        return { ok: true, message: `SMTP login OK as ${config.smtp.user}` };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderSubject(template, lead) {
    const map = {
        name: lead.fullName,
        mobile: lead.displayPhone || '-',
        phone: lead.phone || '-',
        company: lead.company || '-',
        city: lead.city || '-',
        category: lead.category || '-',
        area: lead.area || '-',
        leadid: lead.leadId || '-',
    };

    return String(template).replace(/\{\{\s*(\w+)\s*\}\}/gi, (_match, key) => {
        return map[String(key).toLowerCase()] ?? '';
    });
}

function receivedAtText(lead) {
    try {
        return new Intl.DateTimeFormat('en-IN', {
            timeZone: config.timezone,
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(lead.receivedAt);
    } catch {
        return lead.receivedAt.toISOString();
    }
}

function buildText(lead) {
    const lines = [
        'NEW JUSTDIAL LEAD',
        '='.repeat(40),
        '',
        `Name       : ${lead.fullName}`,
        `Mobile     : ${lead.mobile || '-'}`,
        `Phone      : ${lead.phone || '-'}`,
        `Email      : ${lead.email || '-'}`,
        `Company    : ${lead.company || '-'}`,
        `Category   : ${lead.category || '-'}`,
        `Address    : ${lead.address || '-'}`,
        `Lead Type  : ${lead.leadType || '-'}`,
        `Lead ID    : ${lead.leadId || '-'}`,
        `Lead Date  : ${[lead.date, lead.time].filter(Boolean).join(' ') || '-'}`,
        '',
        `Received   : ${receivedAtText(lead)}`,
        '',
        '-'.repeat(40),
        'ALL RECEIVED FIELDS',
        '-'.repeat(40),
    ];

    const known = new Set(KNOWN_FIELDS.map(([key]) => key));

    for (const [key, label] of KNOWN_FIELDS) {
        if (lead.raw[key] !== undefined) lines.push(`${label.padEnd(14)}: ${lead.raw[key]}`);
    }

    for (const [key, value] of Object.entries(lead.raw)) {
        if (!known.has(key.toLowerCase())) lines.push(`${key.padEnd(14)}: ${value}`);
    }

    lines.push('', '-- ', `${config.mail.fromName} (JustDial Mailer)`);

    return lines.join('\n');
}

function row(label, value, href) {
    if (!value) return '';
    const cell = href
        ? `<a href="${escapeHtml(href)}" style="color:#0d6efd;text-decoration:none;">${escapeHtml(value)}</a>`
        : escapeHtml(value);

    return `
        <tr>
            <td style="padding:9px 14px;border-bottom:1px solid #eef0f3;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
            <td style="padding:9px 14px;border-bottom:1px solid #eef0f3;color:#111827;font-size:14px;font-weight:600;word-break:break-word;">${cell}</td>
        </tr>`;
}

function buildHtml(lead) {
    const known = new Set(KNOWN_FIELDS.map(([key]) => key));

    const extraRows = Object.entries(lead.raw)
        .filter(([key]) => !known.has(key.toLowerCase()))
        .map(([key, value]) => row(key, value))
        .join('');

    return `<!doctype html>
<html>
<body style="margin:0;padding:24px 12px;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 18px rgba(16,24,40,.08);">

        <div style="background:#0d6efd;padding:20px 22px;">
            <div style="color:#cfe2ff;font-size:12px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;">New JustDial Lead</div>
            <div style="color:#ffffff;font-size:22px;font-weight:700;margin-top:6px;">${escapeHtml(lead.fullName)}</div>
            ${lead.displayPhone ? `<div style="color:#e7f0ff;font-size:15px;margin-top:6px;">&#128222; <a href="tel:${escapeHtml(lead.displayPhone)}" style="color:#ffffff;text-decoration:none;font-weight:600;">${escapeHtml(lead.displayPhone)}</a></div>` : ''}
        </div>

        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
            ${row('Lead ID', lead.leadId)}
            ${row('Name', lead.fullName)}
            ${row('Mobile', lead.mobile, lead.mobile ? `tel:${lead.mobile}` : null)}
            ${row('Phone', lead.phone, lead.phone ? `tel:${lead.phone}` : null)}
            ${row('Email', lead.email, lead.email ? `mailto:${lead.email}` : null)}
            ${row('Requirement', lead.category)}
            ${row('Company', lead.company)}
            ${row('Address', lead.address)}
            ${row('Lead Type', lead.leadType)}
            ${row('Lead Date', [lead.date, lead.time].filter(Boolean).join(' '))}
        </table>

        ${extraRows ? `
        <div style="padding:14px 18px 4px;color:#6b7280;font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;">Additional fields</div>
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${extraRows}</table>
        ` : ''}

        <div style="padding:16px 22px 22px;color:#9aa2ad;font-size:12px;">
            Received ${escapeHtml(receivedAtText(lead))} &middot; ${escapeHtml(config.mail.fromName)}
        </div>
    </div>
</body>
</html>`;
}

/**
 * Send one lead. Throws on failure so the caller can queue a retry.
 */
export async function sendLead(lead) {
    const subject = renderSubject(config.mail.subject, lead);
    const text = buildText(lead);
    const html = buildHtml(lead);

    if (config.dryRun) {
        log.info('DRY_RUN - email NOT sent', { to: config.mail.to, subject });
        log.info('DRY_RUN email body\n' + text);
        return { dryRun: true, subject };
    }

    const info = await getTransporter().sendMail({
        from: `"${config.mail.fromName}" <${config.mail.from || config.smtp.user}>`,
        to: config.mail.to.join(', '),
        cc: config.mail.cc.length ? config.mail.cc.join(', ') : undefined,
        replyTo: lead.email && lead.email.includes('@') ? lead.email : undefined,
        subject,
        text,
        html,
    });

    return {
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
        subject,
    };
}

export { renderSubject, buildText, buildHtml };
