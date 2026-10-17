/**
 * Send ONE real WhatsApp message, to prove a WhatsApp setup actually works.
 *
 *   npm run send:whatsapp -- 9876543210
 *   npm run send:whatsapp -- 9876543210 "custom text"
 *   npm run send:whatsapp -- 9876543210 "custom text" --to 9000000009
 *
 * It uses exactly the same provider as the live service, so whatever the lead
 * flow would do, this does too. For "openwa" the WhatsApp client is started
 * here, which means a missing QR scan shows up immediately.
 */
import { config } from '../src/config.js';
import { normalize } from '../src/lead.js';
import { sendWhatsappText, startWhatsapp, whatsappStatus } from '../src/whatsapp.js';

const argv = process.argv.slice(2);
const flags = argv.filter((arg) => arg.startsWith('--'));

const toIndex = flags.indexOf('--to');
const overrideTo = toIndex >= 0 ? argv[argv.indexOf('--to') + 1] : null;

const positional = argv.filter((arg, index) => {
    if (arg.startsWith('--')) return false;
    if (toIndex >= 0 && index === argv.indexOf('--to') + 1) return false;
    return true;
});

const number = positional[0] || overrideTo;
const message = positional[1] || null;

if (!number) {
    console.error('');
    console.error('Which number should the message go to?');
    console.error('');
    console.error('  npm run send:whatsapp -- 9876543210');
    console.error('');
    process.exit(1);
}

const sample = normalize({
    leadid: `JD-TEST-${Date.now()}`,
    prefix: 'Mr',
    name: 'Test Lead',
    mobile: number,
    category: 'Test Enquiry',
    city: 'Mumbai',
    date: new Date().toISOString().slice(0, 10),
});

console.log('');
console.log('  WhatsApp test send');
console.log('  ------------------');
console.log(`  Provider : ${config.whatsapp.provider}`);
console.log(`  To       : ${number}`);
console.log(`  Dry run  : ${config.dryRun}`);
console.log('');

if (config.whatsapp.provider === 'openwa') {
    console.log('  Starting the WhatsApp client (the first run needs a QR scan)...');

    await startWhatsapp();

    const status = whatsappStatus();

    if (!status.ready) {
        console.error(`  WhatsApp is NOT connected: ${status.lastError || status.status}`);
        console.error(status.qrFile ? `  Scan the QR at logs/${status.qrFile}` : '');
        process.exit(1);
    }

    console.log('  WhatsApp client is connected.');
}

const { renderWhatsappMessage } = await import('../src/whatsapp.js');
const text = message || renderWhatsappMessage(sample);

console.log('  Message:');
console.log(text.split('\n').map((line) => `    | ${line}`).join('\n'));
console.log('');

try {
    const result = await sendWhatsappText(number, text);
    console.log(`  SENT  ${JSON.stringify(result)}`);
    process.exit(0);
} catch (error) {
    console.error(`  FAILED  ${error.message}`);
    process.exit(1);
}
