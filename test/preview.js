/**
 * Renders the lead email to logs/preview.html so you can look at the design in
 * a browser without sending anything.
 *
 *   npm run preview
 *
 * Open the printed path (on Windows: start logs\preview.html).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { normalize } from '../src/lead.js';
import { buildHtml, buildText } from '../src/mailer.js';
import { ensureDirs } from '../src/store.js';

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');

const sample = {
    leadid: 'JD-PREVIEW-0001',
    leadtype: 'category',
    prefix: 'Ms',
    name: 'HIRAL SHARMA',
    mobile: '9820097546',
    phone: '02224100086',
    email: 'hiral.sharma@example.com',
    company: 'HIRAL Travels & Tours',
    category: 'Taxi Services',
    area: 'Dadar West',
    brancharea: 'Andheri East',
    city: 'Mumbai',
    pincode: '400028',
    branchpin: '400001',
    parentid: 'P-8891',
    dncmobile: '1',
    dncphone: '0',
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
};

const lead = normalize(sample);
lead.receivedAt = now;
lead.baseUrl = config.publicUrl || `http://localhost:${config.port}`;

ensureDirs();

const htmlFile = path.join(config.logs.dir, 'preview.html');
const textFile = path.join(config.logs.dir, 'preview.txt');

fs.writeFileSync(htmlFile, buildHtml(lead));
fs.writeFileSync(textFile, buildText(lead));

console.log('Email preview written to:');
console.log(`  ${htmlFile}`);
console.log(`  ${textFile}`);
console.log('');
console.log(`Base URL used for copy links : ${lead.baseUrl}`);
console.log(`Dry run                      : ${config.dryRun}`);
