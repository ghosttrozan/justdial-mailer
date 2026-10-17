/**
 * Offline checks for the WhatsApp pipeline.
 *
 * A real WhatsApp client needs a QR scan, which a test cannot do - so this
 * covers everything around it: the message template, who gets messaged, the
 * DNC / blocklist rules, and the webhook provider against a local echo server.
 *
 *   npm run test:whatsapp
 *
 * Nothing leaves this machine.
 */
import http from 'node:http';

const ECHO_PORT = 4319;

// These MUST be set before src/config.js is first imported. dotenv does not
// override variables that are already set, so these win over .env.
process.env.WHATSAPP_ENABLED = 'true';
process.env.WHATSAPP_PROVIDER = 'webhook';
process.env.WHATSAPP_WEBHOOK_URL = `http://127.0.0.1:${ECHO_PORT}/send`;
process.env.WHATSAPP_WEBHOOK_TOKEN = 'test-token';
process.env.WHATSAPP_SEND_TO_LEAD = 'true';
process.env.WHATSAPP_TEAM_NUMBERS = '9000000009';
process.env.WHATSAPP_BLOCKLIST = '9000000999';
process.env.WHATSAPP_RESPECT_DNC = 'true';
process.env.WHATSAPP_MIN_DELAY_SECONDS = '0';
process.env.WHATSAPP_MAX_DELAY_SECONDS = '0';
process.env.DRY_RUN = 'false';
process.env.BUSINESS_NAME = 'Alkaif Enterprises';
process.env.WHATSAPP_MESSAGE = [
    'Namaste {{name}} ji,',
    '',
    'JustDial par aapki enquiry aayi hai ({{category}}).',
    'Call kar sakte hain?',
    '',
    '- {{business}}',
].join('\n');

const { config } = await import('../src/config.js');
const { normalize } = await import('../src/lead.js');
const {
    isBlocked,
    recipientsFor,
    renderWhatsappMessage,
    sendWhatsappText,
    skipReason,
    startWhatsapp,
    whatsappStatus,
} = await import('../src/whatsapp.js');

/* ---------------------------------------------------------------- *
 * A tiny stand-in for a WhatsApp HTTP gateway
 * ---------------------------------------------------------------- */

const received = [];

const echo = http.createServer((req, res) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');

        if (req.url.startsWith('/fail')) {
            res.writeHead(500, { 'Content-Type': 'text/plain' }).end('nope');
            return;
        }

        received.push({
            url: req.url,
            method: req.method,
            headers: req.headers,
            json: (() => {
                try {
                    return JSON.parse(body);
                } catch {
                    return null;
                }
            })(),
        });

        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
});

await new Promise((resolve) => echo.listen(ECHO_PORT, '127.0.0.1', resolve));

/* ---------------------------------------------------------------- *
 * Checks
 * ---------------------------------------------------------------- */

const results = [];

async function check(name, fn) {
    try {
        const detail = await fn();
        const ok = detail === true || detail === undefined;

        results.push(ok);
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
    } catch (error) {
        results.push(false);
        console.log(`  FAIL  ${name}  -> ${error.message}`);
    }
}

function lead(overrides = {}) {
    return normalize({
        leadid: 'JD-WA-1',
        prefix: 'Mr',
        name: 'Ramesh Gupta',
        mobile: '9876501234',
        phone: '02224567890',
        category: 'Interior Designer',
        company: 'Sharma Interiors',
        area: 'Kothrud',
        city: 'Pune',
        pincode: '411038',
        date: '2026-10-17',
        time: '13:00:00',
        ...overrides,
    });
}

console.log('');
console.log('WhatsApp checks');
console.log('---------------');
console.log(`  provider : ${config.whatsapp.provider}`);
console.log(`  webhook  : ${config.whatsapp.webhookUrl}`);
console.log('');

await check('env overrides reached the config', async () => {
    if (config.whatsapp.enabled !== true) return 'WHATSAPP_ENABLED did not stick';
    if (config.whatsapp.provider !== 'webhook') return `provider is ${config.whatsapp.provider}`;
    return true;
});

await check('every {{placeholder}} is filled in', async () => {
    const text = renderWhatsappMessage(lead());

    for (const wanted of ['Namaste Ramesh Gupta ji', 'Interior Designer', 'Alkaif Enterprises']) {
        if (!text.includes(wanted)) return `missing "${wanted}" in:\n${text}`;
    }

    if (/\{\{\w+\}\}/.test(text)) return `a placeholder was left unfilled:\n${text}`;
    return true;
});

await check('a missing value leaves no empty brackets', async () => {
    const text = renderWhatsappMessage(lead({ category: '' }));

    if (text.includes('()')) return `empty brackets left in:\n${text}`;
    if (!text.includes('JustDial par aapki enquiry aayi hai.')) return `unexpected text:\n${text}`;
    return true;
});

await check('the lead number and the team number both get it', async () => {
    const numbers = recipientsFor(lead());
    const wanted = ['919876501234', '919000000009'];

    if (JSON.stringify(numbers) !== JSON.stringify(wanted)) {
        return `got ${JSON.stringify(numbers)}`;
    }
    return true;
});

await check('the team number alone is used when there is no mobile', async () => {
    const numbers = recipientsFor(lead({ mobile: '', phone: '' }));

    if (JSON.stringify(numbers) !== JSON.stringify(['919000000009'])) {
        return `got ${JSON.stringify(numbers)}`;
    }
    return true;
});

await check('a JustDial DNC flag stops the message', async () => {
    const reason = skipReason(lead({ dncmobile: '1' }));

    if (!reason || !reason.includes('DNC')) return `expected a DNC skip, got ${JSON.stringify(reason)}`;
    return true;
});

await check('a lead without DNC is not skipped', async () => {
    const reason = skipReason(lead({ dncmobile: '0' }));

    if (reason) return `unexpectedly skipped: ${reason}`;
    return true;
});

await check('the blocklist matches a full number', async () => {
    if (!isBlocked('919000000999')) return 'an exact blocklist entry did not match';
    return true;
});

await check('the blocklist can match just the last few digits', async () => {
    const original = config.whatsapp.blocklist;
    config.whatsapp.blocklist = ['9900'];

    try {
        if (!isBlocked('919999999900')) return 'a short blocklist entry did not match as a suffix';
        if (isBlocked('919999991111')) return 'a short blocklist entry matched a different number';
        return true;
    } finally {
        config.whatsapp.blocklist = original;
    }
});

await check('the webhook provider posts the message', async () => {
    received.length = 0;

    await startWhatsapp();
    await sendWhatsappText('919876501234', 'hello from the test');

    if (received.length !== 1) return `the echo server saw ${received.length} request(s)`;

    const [request] = received;

    if (request.method !== 'POST') return `method was ${request.method}`;
    if (request.json?.phone !== '919876501234') return `phone was ${JSON.stringify(request.json?.phone)}`;
    if (request.json?.chatId !== '919876501234@c.us') return `chatId was ${JSON.stringify(request.json?.chatId)}`;
    if (request.json?.message !== 'hello from the test') return 'the message body did not match';
    if (request.headers.authorization !== 'Bearer test-token') {
        return `authorization was ${JSON.stringify(request.headers.authorization)}`;
    }
    return true;
});

await check('a failing gateway throws, so the lead is queued', async () => {
    const original = config.whatsapp.webhookUrl;
    config.whatsapp.webhookUrl = `http://127.0.0.1:${ECHO_PORT}/fail`;

    try {
        await sendWhatsappText('919876501234', 'this one must fail');
        return 'the failure was swallowed instead of thrown';
    } catch (error) {
        if (!String(error.message).includes('500')) return `unhelpful error: ${error.message}`;
        return true;
    } finally {
        config.whatsapp.webhookUrl = original;
    }
});

await check('the health snapshot reports the WhatsApp state', async () => {
    const status = whatsappStatus();

    if (status.enabled !== true) return 'enabled is not true';
    if (status.provider !== 'webhook') return `provider is ${status.provider}`;
    if (status.ready !== true) return 'ready is not true';
    if (status.sent < 1) return `sent counter is ${status.sent}`;
    if (status.failed < 1) return `failed counter is ${status.failed}`;
    return true;
});

/* ---------------------------------------------------------------- */

echo.close();

const failed = results.filter((ok) => !ok).length;

console.log('');
console.log(failed === 0
    ? `All ${results.length} WhatsApp checks passed`
    : `${failed} of ${results.length} WhatsApp checks FAILED`);

// Use exitCode rather than process.exit() - exiting while the echo server is
// still closing trips a libuv assertion on Windows.
process.exitCode = failed === 0 ? 0 : 1;
