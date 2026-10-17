/**
 * End-to-end smoke test: fires a lead at a running instance using every
 * format JustDial (or Postman) might send, and checks each one is accepted
 * with the plain text "RECEIVED".
 *
 *   npm start          (in one terminal)
 *   npm run test:smoke (in another)
 *
 *   node test/smoke.js https://leads.yourcompany.com
 */
import { config, leadUrl } from '../src/config.js';

const argv = process.argv.slice(2);
const flags = argv.filter((arg) => arg.startsWith('--'));
const base = argv.find((arg) => !arg.startsWith('--')) || `http://localhost:${config.port}`;
const confirmed = flags.includes('--yes');

/**
 * This test pushes real leads through the real endpoint, so with DRY_RUN=false
 * it sends REAL emails. Make that explicit before it happens.
 */
if (!config.dryRun && config.mail.to.length && !confirmed) {
    console.log('');
    console.log('STOP - this smoke test would send REAL emails.');
    console.log(`  Recipient : ${config.mail.to.join(', ')}`);
    console.log('  It fires one lead per input format, so you get several messages.');
    console.log('');
    console.log('  To run it:');
    console.log('    npm run test:smoke -- --yes       (send for real)');
    console.log('    $env:DRY_RUN="true"; npm run test:smoke   (send nothing)');
    console.log('');
    process.exit(1);
}

const target = leadUrl(base);
const stamp = Date.now();
const results = [];

async function check(label, fn) {
    try {
        const body = String(await fn()).trim();
        const ok = body === 'RECEIVED';
        results.push({ label, ok, detail: ok ? '' : `got: ${body.slice(0, 80).replace(/\s+/g, ' ')}` });
    } catch (error) {
        results.push({ label, ok: false, detail: error.message });
    }
}

console.log(`Target: ${target}`);
console.log('');

await check('GET + query string', async () => {
    const url = `${target}?leadid=SMOKE-GET-${stamp}&name=Get+User&mobile=9000000001&city=Delhi&category=Plumber`;
    return (await fetch(url)).text();
});

await check('POST application/json', async () => {
    const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            leadid: `SMOKE-JSON-${stamp}`,
            name: 'Json User',
            mobile: '9000000002',
            city: 'Pune',
            category: 'Carpenter',
        }),
    });
    return res.text();
});

await check('POST text/plain containing JSON', async () => {
    const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ leadid: `SMOKE-TEXT-${stamp}`, name: 'Text User', mobile: '9000000003' }),
    });
    return res.text();
});

await check('POST form-urlencoded', async () => {
    const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            leadid: `SMOKE-FORM-${stamp}`,
            name: 'Form User',
            mobile: '9000000004',
            city: 'Mumbai',
        }).toString(),
    });
    return res.text();
});

await check('POST multipart/form-data', async () => {
    const form = new FormData();
    form.append('leadid', `SMOKE-MULTI-${stamp}`);
    form.append('name', 'Multipart User');
    form.append('mobile', '9000000005');
    form.append('city', 'Nagpur');

    const res = await fetch(target, { method: 'POST', body: form });
    return res.text();
});

await check('POST shell-escaped JSON', async () => {
    const body = `{\\"leadid\\":\\"SMOKE-ESCAPED-${stamp}\\",\\"name\\":\\"Escaped User\\",\\"mobile\\":\\"9000000006\\"}`;
    const res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });
    return res.text();
});

await check('GET mixed casing + stray ">>"', async () => {
    const url = `${target}?LeadID=SMOKE-CASE-${stamp}&Name=Case+User&Mobile=9000000007&CITY=Indore>>`;
    return (await fetch(url)).text();
});

await check('GET with no fields at all', async () => {
    return (await fetch(target)).text();
});

await check('copy page renders the value', async () => {
    const res = await fetch(`${base}${config.copyPath}?label=Mobile&text=9876543210`);
    const html = await res.text();
    return res.status === 200 && html.includes('9876543210') ? 'RECEIVED' : `status ${res.status}`;
});

await check('copy page escapes injected html', async () => {
    const res = await fetch(`${base}${config.copyPath}?text=${encodeURIComponent('<script>alert(1)</script>')}`);
    const html = await res.text();
    const leaked = html.includes('<script>alert(1)</script>');
    return !leaked && html.includes('&lt;script&gt;') ? 'RECEIVED' : 'value was not escaped';
});

await check('health endpoint returns JSON', async () => {
    const res = await fetch(`${base}${config.healthPath}`);
    const json = await res.json();
    return json.status ? 'RECEIVED' : 'bad payload';
});

await check('unknown path is 404', async () => {
    const res = await fetch(`${base}/nope`);
    return res.status === 404 ? 'RECEIVED' : `status ${res.status}`;
});

console.log('Smoke test results:');
for (const result of results) {
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.detail ? `  -> ${result.detail}` : ''}`);
}

const failed = results.filter((result) => !result.ok).length;

console.log('');
console.log(failed ? `${failed} check(s) FAILED` : `All ${results.length} checks passed`);
console.log(`Leads were written to: ${config.logs.dir}`);

process.exitCode = failed ? 1 : 0;
