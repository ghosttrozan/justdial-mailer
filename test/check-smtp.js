/**
 * Checks the SMTP settings from .env without sending a lead.
 *
 *   npm run test:smtp
 *
 * For Gmail you must use a 16 character "App Password" (not your normal
 * password) and 2-Step Verification must be turned on for the account.
 */
import { config, validateConfig } from '../src/config.js';
import { verifyTransport } from '../src/mailer.js';

if (config.resendApiKey) {
    console.log('Email provider: Resend HTTP API');
    console.log(`  api key: ${config.resendApiKey.slice(0, 6)}... (length=${config.resendApiKey.length})`);
    console.log(`  from   : ${config.mail.from || 'onboarding@resend.dev (default)'}`);
    console.log(`  to     : ${config.mail.to.join(', ') || '(not set)'}`);
    console.log(`  dry run: ${config.dryRun}`);
} else {
    console.log('Email provider: SMTP');
    console.log(`  host   : ${config.smtp.host}:${config.smtp.port} (secure=${config.smtp.secure})`);
    console.log(`  user   : ${config.smtp.user || '(not set)'}`);
    console.log(`  pass   : ${config.smtp.pass ? '*'.repeat(config.smtp.pass.length) : '(not set)'}`);
    console.log(`  from   : ${config.mail.from || '(falls back to SMTP_USER)'}`);
    console.log(`  to     : ${config.mail.to.join(', ') || '(not set)'}`);
    console.log(`  dry run: ${config.dryRun}`);
}
console.log('');

const problems = validateConfig();
if (problems.length) {
    console.log('Configuration problems:');
    for (const problem of problems) console.log(`  - ${problem}`);
    console.log('');
}

const result = await verifyTransport();

if (result.ok) {
    console.log(`OK - ${result.message}`);
} else {
    console.log(`FAILED - ${result.message}`);
    console.log('');
    console.log('Gmail tips:');
    console.log('  1. Turn on 2-Step Verification for the Google account.');
    console.log('  2. Create an App Password: Google Account > Security > App passwords.');
    console.log('  3. Paste the 16 character password into SMTP_PASS (no spaces).');
    console.log('  4. SMTP_USER and MAIL_FROM must be that same Gmail address.');
    process.exitCode = 1;
}
