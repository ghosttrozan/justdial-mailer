import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let stream = null;

function getStream() {
    if (stream) return stream;

    try {
        fs.mkdirSync(config.logs.dir, { recursive: true });
        const file = path.join(config.logs.dir, `app-${new Date().toISOString().slice(0, 10)}.log`);
        stream = fs.createWriteStream(file, { flags: 'a' });
    } catch (error) {
        // Logging must never take the service down.
        stream = null;
    }

    return stream;
}

function safeJson(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function write(level, message, meta) {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${meta ? ' ' + safeJson(meta) : ''}`;

    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    const out = getStream();
    if (out) out.write(line + '\n');
}

export const log = {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
};
