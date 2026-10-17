import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * WhatsApp rotates the linking code every ~20 seconds, so saving a still image
 * is not much help. This turns the payload into a page that reloads itself,
 * which is what makes "open this URL and scan it" work on a machine you cannot
 * look at.
 *
 * The QR is drawn as inline SVG from the encoder that ships with open-wa
 * (qrcode-terminal is declared in package.json), so there is nothing extra to
 * install and nothing to download at runtime.
 */
function encoder() {
    try {
        const QRCode = require('qrcode-terminal/vendor/QRCode');
        const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

        return { QRCode, QRErrorCorrectLevel };
    } catch {
        // open-wa is optional (the webhook provider does not need it), so the
        // encoder may genuinely be missing. Callers fall back to the raw code.
        return null;
    }
}

/**
 * @returns {{modules: number, svg: string}|null}
 */
export function qrSvg(payload) {
    const found = encoder();
    if (!found) return null;

    const { QRCode, QRErrorCorrectLevel } = found;

    // "M" balances size against robustness; plenty for a phone reading a screen.
    const qr = new QRCode(-1, QRErrorCorrectLevel.M);
    qr.addData(payload);
    qr.make();

    const count = qr.getModuleCount();
    const quiet = 4;
    const total = count + quiet * 2;
    const rects = [];

    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            const dark = typeof qr.isDark === 'function'
                ? qr.isDark(row, col)
                : Boolean(qr.modules[row][col]);

            if (dark) {
                rects.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1"/>`);
            }
        }
    }

    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"`,
        ` width="${total}" height="${total}" shape-rendering="crispEdges"`,
        ' role="img" aria-label="WhatsApp linking code">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        `<g fill="#000000">${rects.join('')}</g>`,
        '</svg>',
    ].join('');

    return { modules: count, svg };
}

const STYLES = `
  * { box-sizing: border-box; }
  body { margin:0; padding:22px 16px 40px; background:#f6f7f9; color:#111;
         font:15px/1.55 system-ui, "Segoe UI", Roboto, Arial, sans-serif; text-align:center; }
  .card { max-width:560px; margin:0 auto; background:#fff; border-radius:16px;
          padding:22px 20px 26px;
          box-shadow:0 1px 3px rgba(16,24,40,.08), 0 12px 32px -12px rgba(16,24,40,.18); }
  h1 { font-size:19px; margin:0 0 4px; }
  .sub { color:#6b7280; font-size:13px; margin:0 0 18px; }
  .qr { width:100%; max-width:420px; margin:0 auto; background:#fff; padding:6px;
        border:1px solid #eceff3; border-radius:12px; }
  .qr svg { width:100%; height:auto; display:block; }
  ol { text-align:left; display:inline-block; margin:20px 0 0; padding-left:20px; color:#374151; }
  ol li { margin:4px 0; }
  .stamp { margin:18px 0 0; font-size:12px; color:#9ca3af; }
  .live { display:inline-block; width:7px; height:7px; border-radius:50%; background:#22c55e;
          margin-right:6px; vertical-align:middle; }
  .wait { display:inline-block; width:7px; height:7px; border-radius:50%; background:#f59e0b;
          margin-right:6px; vertical-align:middle; }
`;

function page({ title, body, refresh = 5 }) {
    return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<title>${title}</title>
<style>${STYLES}</style>
${body}
</html>`;
}

/**
 * A self-refreshing page for the linking code.
 *
 * @returns {string|null} null when the encoder is unavailable.
 */
export function renderQrHtml(payload) {
    const rendered = qrSvg(payload);
    if (!rendered) return null;

    const { modules, svg } = rendered;
    const stamp = new Date().toLocaleTimeString('en-IN');

    return page({
        title: 'Link WhatsApp - JustDial Mailer',
        body: `<div class="card">
  <h1>Link your WhatsApp</h1>
  <p class="sub">${modules}&times;${modules} code &middot; WhatsApp changes it every ~20s, this page follows</p>
  <div class="qr">${svg}</div>
  <ol>
    <li>Open <b>WhatsApp</b> on the phone that will send the leads</li>
    <li><b>Settings &rarr; Linked devices &rarr; Link a device</b></li>
    <li>Point the camera at the code above</li>
  </ol>
  <p class="stamp"><span class="live"></span>Live &middot; updated ${stamp}</p>
</div>`,
    });
}

/**
 * Shown between one linking attempt ending and the next QR arriving.
 *
 * Serving the previous code here would be worse than useless: it is already
 * dead, so a scan against it fails silently and looks like the page is broken.
 */
export function renderWaitingHtml(reason) {
    const stamp = new Date().toLocaleTimeString('en-IN');

    return page({
        title: 'Preparing WhatsApp link - JustDial Mailer',
        body: `<div class="card">
  <h1>Preparing a fresh code</h1>
  <p class="sub">This page reloads itself, so just leave it open.</p>
  <p class="sub">${reason || 'The previous code expired before it was scanned.'}</p>
  <ol>
    <li>Keep <b>WhatsApp</b> open on the sending phone</li>
    <li><b>Settings &rarr; Linked devices &rarr; Link a device</b></li>
    <li>Wait for the code to appear, then point the camera at it</li>
  </ol>
  <p class="stamp"><span class="wait"></span>Waiting &middot; checked ${stamp}</p>
</div>`,
    });
}
