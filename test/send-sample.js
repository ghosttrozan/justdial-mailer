/**
 * Sends a realistic JustDial lead to a running instance, so you can see the
 * whole flow (endpoint -> email) without waiting for JustDial.
 *
 *   npm start                 (in one terminal)
 *   npm run test:lead         (in another)
 *
 * Or point it at a deployed URL:
 *   node test/send-sample.js https://leads.yourcompany.com
 */
import { config, leadUrl } from '../src/config.js';

const base = process.argv[2] || `http://localhost:${config.port}`;
const target = leadUrl(base);

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');

const sample = {
    leadid: `JD-TEST-${now.getTime()}`,
    leadtype: 'category',
    prefix: 'Ms',
    name: 'HIRAL',
    mobile: '9820097546',
    phone: '02224100086',
    email: '',
    company: 'HIRAL Travels',
    category: 'Taxi Services',
    area: 'Dadar West',
    brancharea: 'Andheri East',
    city: 'Mumbai',
    pincode: '400028',
    branchpin: '400001',
    parentid: 'P123',
    dncmobile: '1',
    dncphone: '0',
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
};

const url = `${target}?${new URLSearchParams(sample).toString()}`;

console.log('Sending sample lead to:');
console.log(`  ${url}`);
console.log('');

try {
    const response = await fetch(url);
    const body = await response.text();

    console.log(`HTTP ${response.status}`);
    console.log(`Body: ${body}`);
    console.log('');

    if (body.trim() === 'RECEIVED') {
        console.log('OK - the service accepted the lead.');
        console.log(`Check the inbox at: ${config.mail.to.join(', ') || '(MAIL_TO not set)'}`);
        console.log('Also see: logs/leads-*.jsonl and the console output of the running service.');
    } else {
        console.log('Unexpected reply. Is the endpoint path / secret correct?');
        process.exitCode = 1;
    }
} catch (error) {
    console.error(`Could not reach ${target} - is the service running? (npm start)`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
}
