import { config } from './config.js';

/**
 * The public base URL used to build links inside the email.
 * Prefers PUBLIC_URL from .env, otherwise the host the lead actually arrived
 * on (so it is correct behind a proxy without any configuration).
 */
export function baseUrlFor(lead) {
    const raw = config.publicUrl || lead?.baseUrl || `http://localhost:${config.port}`;
    return String(raw).replace(/\/+$/, '');
}

/**
 * Link that opens a tiny page which copies `text` to the clipboard.
 *
 * This is how a "copy" button can work inside an email: every major mail
 * client strips JavaScript, so the copy has to happen on a real web page.
 */
export function copyLink(text, label, base) {
    const value = String(text ?? '').trim();
    if (!value) return null;

    const params = new URLSearchParams({ text: value.slice(0, 3000) });
    if (label) params.set('label', String(label).slice(0, 60));

    return `${base}${config.copyPath}?${params.toString()}`;
}

/** Digits only, with the country code prefixed when it is missing. */
export function normalisePhone(phone) {
    let digits = String(phone ?? '').replace(/\D/g, '');
    if (!digits) return '';

    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    if (digits.length === 10) return `${config.countryCode}${digits}`;

    return digits;
}

export function telLink(phone) {
    const value = normalisePhone(phone);
    return value ? `tel:+${value}` : null;
}

export function whatsappLink(phone, name) {
    const value = normalisePhone(phone);
    if (!value) return null;

    const message = String(config.whatsappGreeting || '')
        .replace(/\{\{\s*name\s*\}\}/gi, name || '')
        .trim();

    return message
        ? `https://wa.me/${value}?text=${encodeURIComponent(message)}`
        : `https://wa.me/${value}`;
}

export function mapsLink(address) {
    const value = String(address ?? '').trim();
    if (!value) return null;

    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`;
}
