import nodemailer from 'nodemailer';
import { config } from './config.js';
import { KNOWN_FIELDS } from './lead.js';
import { baseUrlFor, copyLink, mapsLink, telLink, whatsappLink } from './links.js';
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
 * Send email via Resend HTTP API (HTTPS port 443 - zero firewall port blocks on Render/Vercel/Railway).
 */
export async function sendViaResend({ from, to, cc, replyTo, subject, text, html, leadId }) {
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.resendApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from,
            to,
            cc: cc?.length ? cc : undefined,
            reply_to: replyTo || undefined,
            subject,
            text,
            html,
            headers: leadId ? { 'X-JustDial-Lead-Id': leadId } : undefined,
        }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(`Resend API error (${response.status}): ${data.message || JSON.stringify(data)}`);
    }

    return {
        messageId: data.id,
        accepted: to,
        rejected: [],
        response: `Resend ID: ${data.id}`,
        subject,
    };
}

/**
 * Boot-time SMTP / HTTP check. Returns { ok, message } - never throws.
 */
export async function verifyTransport() {
    if (config.dryRun) return { ok: true, message: 'DRY_RUN is on - email is not actually sent.' };

    if (config.resendApiKey) {
        return { ok: true, message: 'Email provider: Resend HTTP API (HTTPS port 443 - Render friendly)' };
    }

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

/**
 * The lead as one tidy block of text - this is what the "Copy all" button
 * puts on the clipboard, and what the plain-text email shows.
 */
export function leadAsText(lead) {
    const rows = [
        ['Lead ID', lead.leadId],
        ['Name', lead.fullName],
        ['Mobile', lead.mobile],
        ['Phone', lead.phone],
        ['Email', lead.email],
        ['Requirement', lead.category],
        ['Company', lead.company],
        ['Address', lead.address],
        ['Lead Type', lead.leadType],
        ['Received', receivedAtText(lead)],
    ].filter(([, value]) => String(value ?? '').trim().length > 0);

    const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);

    return rows.map(([key, value]) => `${key.padEnd(width)} : ${value}`).join('\n');
}

function buildText(lead) {
    const extra = leadAsText(lead);

    const lines = [
        'NEW JUSTDIAL LEAD',
        '='.repeat(40),
        '',
        extra,
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

/* ------------------------------------------------------------------ *
 * HTML email
 * ------------------------------------------------------------------ */

function button(label, href, background, colour) {
    if (!href) return '';

    return `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;background:${background};color:${colour};font-size:13px;font-weight:700;text-decoration:none;border-radius:9px;">${escapeHtml(label)}</a>`;
}

function copyPill(url, compact = true) {
    if (!url) return '';

    const padding = compact ? '5px 10px' : '7px 13px';
    const size = compact ? '11px' : '12px';

    return `<a href="${escapeHtml(url)}" style="display:inline-block;padding:${padding};background:#f1f5f9;border:1px solid #dfe5ec;border-radius:7px;color:#475569;font-size:${size};font-weight:700;text-decoration:none;white-space:nowrap;">Copy</a>`;
}

function fieldRow({ label, value, href, copy, last }) {
    if (!String(value ?? '').trim()) return '';

    const border = last ? 'none' : '1px solid #eef1f5';
    const shown = href
        ? `<a href="${escapeHtml(href)}" style="color:#1554d6;text-decoration:none;font-weight:600;">${escapeHtml(value)}</a>`
        : escapeHtml(value);

    return `
            <tr>
                <td width="118" valign="top" style="padding:11px 12px 11px 0;border-bottom:${border};color:#64748b;font-size:13px;line-height:1.45;">${escapeHtml(label)}</td>
                <td valign="top" style="padding:11px 10px 11px 0;border-bottom:${border};color:#0f172a;font-size:14px;font-weight:600;line-height:1.5;word-break:break-word;">${shown}</td>
                <td width="64" valign="top" align="right" style="padding:11px 0;border-bottom:${border};">${copyPill(copy)}</td>
            </tr>`;
}

function buildHtml(lead) {
    const base = baseUrlFor(lead);

    const call = telLink(lead.mobile || lead.phone);
    const whatsapp = whatsappLink(lead.mobile || lead.phone, lead.fullName);
    const maps = mapsLink(lead.address);

    const copyAll = copyLink(leadAsText(lead), `${lead.fullName} - JustDial lead`, base);
    const copyPhone = copyLink(lead.displayPhone, 'Mobile', base);

    const known = new Set(KNOWN_FIELDS.map(([key]) => key));

    const rows = [
        { label: 'Lead ID', value: lead.leadId, copy: copyLink(lead.leadId, 'Lead ID', base) },
        { label: 'Name', value: lead.fullName, copy: copyLink(lead.fullName, 'Name', base) },
        { label: 'Mobile', value: lead.mobile, href: telLink(lead.mobile), copy: copyLink(lead.mobile, 'Mobile', base) },
        { label: 'Phone', value: lead.phone, href: telLink(lead.phone), copy: copyLink(lead.phone, 'Phone', base) },
        { label: 'Email', value: lead.email, href: lead.email && lead.email.includes('@') ? `mailto:${lead.email}` : null, copy: copyLink(lead.email, 'Email', base) },
        { label: 'Requirement', value: lead.category, copy: copyLink(lead.category, 'Requirement', base) },
        { label: 'Company', value: lead.company, copy: copyLink(lead.company, 'Company', base) },
        { label: 'Address', value: lead.address, href: maps, copy: copyLink(lead.address, 'Address', base) },
        { label: 'Lead Type', value: lead.leadType, copy: copyLink(lead.leadType, 'Lead Type', base) },
        { label: 'Lead Date', value: [lead.date, lead.time].filter(Boolean).join(' '), copy: null },
    ].filter((row) => String(row.value ?? '').trim().length > 0);

    const extraRows = Object.entries(lead.raw)
        .filter(([key]) => !known.has(key.toLowerCase()))
        .map(([key, value], index, all) => fieldRow({
            label: key,
            value,
            copy: copyLink(value, key, base),
            last: index === all.length - 1,
        }))
        .join('');

    const fieldRows = rows
        .map((row, index) => fieldRow({ ...row, last: index === rows.length - 1 }))
        .join('');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>New JustDial Lead</title>
</head>
<body style="margin:0;padding:0;background:#eef1f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1f5;">
    <tr>
        <td align="center" style="padding:26px 12px;">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 24px rgba(16,24,40,.10);font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

                <!-- header -->
                <tr>
                    <td style="background:#1554d6;padding:22px 24px 20px;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                                <td style="color:#c7dbff;font-size:11px;font-weight:800;letter-spacing:.11em;text-transform:uppercase;">New JustDial Lead</td>
                                <td align="right">${copyPill(copyAll, false)}</td>
                            </tr>
                        </table>
                        <div style="margin-top:10px;color:#ffffff;font-size:24px;font-weight:700;line-height:1.25;">${escapeHtml(lead.fullName)}</div>
                        ${lead.displayPhone ? `<div style="margin-top:8px;"><a href="${escapeHtml(call || '#')}" style="color:#ffffff;font-size:17px;font-weight:700;text-decoration:none;">&#128222; ${escapeHtml(lead.displayPhone)}</a></div>` : ''}
                    </td>
                </tr>

                <!-- quick actions -->
                ${(call || whatsapp || maps)
                    ? `<tr>
                    <td style="padding:18px 24px 10px;">
                        ${button('Call', call, '#1554d6', '#ffffff')}
                        ${button('WhatsApp', whatsapp, '#1faa53', '#ffffff')}
                        ${button('Open in Maps', maps, '#eef1f5', '#0f172a')}
                        ${copyPhone ? `<a href="${escapeHtml(copyPhone)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;background:#eef1f5;color:#0f172a;font-size:13px;font-weight:700;text-decoration:none;border-radius:9px;">Copy number</a>` : ''}
                    </td>
                </tr>`
                    : ''}

                <!-- fields -->
                <tr>
                    <td style="padding:8px 24px 22px;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                            ${fieldRows}
                        </table>
                    </td>
                </tr>

                ${extraRows
                    ? `<!-- extra fields -->
                <tr>
                    <td style="padding:0 24px 8px;">
                        <div style="color:#94a3b8;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;">Additional fields</div>
                    </td>
                </tr>
                <tr>
                    <td style="padding:8px 24px 22px;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                            ${extraRows}
                        </table>
                    </td>
                </tr>`
                    : ''}

                <!-- footer -->
                <tr>
                    <td style="padding:16px 24px 20px;border-top:1px solid #eef1f5;color:#98a2b3;font-size:12px;line-height:1.6;">
                        Received ${escapeHtml(receivedAtText(lead))} &middot; ${escapeHtml(config.mail.fromName)}
                        <br>Copy buttons open a small page that puts the value on your clipboard.
                    </td>
                </tr>
            </table>

            <div style="max-width:600px;margin:14px auto 0;color:#94a3b8;font-size:11px;text-align:center;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                JustDial Mailer &middot; lead ${escapeHtml(lead.leadId || '')}
            </div>
        </td>
    </tr>
</table>
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
    const listUnsubscribe = `<mailto:${config.mail.from || config.smtp.user}?subject=unsubscribe>`;

    if (config.dryRun) {
        log.info('DRY_RUN - email NOT sent', { to: config.mail.to, subject });
        log.info('DRY_RUN email body\n' + text);
        return { dryRun: true, subject };
    }

    if (config.resendApiKey) {
        const fromAddress = config.mail.from || 'onboarding@resend.dev';
        const from = `"${config.mail.fromName}" <${fromAddress}>`;

        return sendViaResend({
            from,
            to: config.mail.to,
            cc: config.mail.cc.length ? config.mail.cc : undefined,
            replyTo: lead.email && lead.email.includes('@') ? lead.email : undefined,
            subject,
            text,
            html,
            leadId: lead.leadId,
        });
    }

    const info = await getTransporter().sendMail({
        from: `"${config.mail.fromName}" <${config.mail.from || config.smtp.user}>`,
        to: config.mail.to.join(', '),
        cc: config.mail.cc.length ? config.mail.cc.join(', ') : undefined,
        replyTo: lead.email && lead.email.includes('@') ? lead.email : undefined,
        subject,
        text,
        html,
        headers: {
            'X-JustDial-Lead-Id': lead.leadId || '',
            'List-Unsubscribe': listUnsubscribe,
        },
    });

    return {
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
        subject,
    };
}

export { renderSubject, buildText, buildHtml, receivedAtText };
