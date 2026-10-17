function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The page a "Copy" button in the email opens.
 *
 * It is deliberately tiny and self contained: the value travels in the URL, so
 * nothing needs to be stored and nothing leaks between leads.
 */
export function renderCopyPage({ text, label }) {
    const value = String(text ?? '');
    const hasValue = value.trim().length > 0;
    const safeValue = escapeHtml(value);
    const safeLabel = escapeHtml(label || 'Value');

    const body = hasValue
        ? `<div class="value" id="value">${safeValue}</div>
        <button id="copy" type="button">Copy</button>
        <p id="msg"></p>`
        : `<div class="value empty">Nothing to copy - the value was empty.</div>`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Copy ${safeLabel} | JustDial Mailer</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px 16px; background: #eef1f5; color: #0f172a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .card {
    width: 100%; max-width: 540px; background: #fff; border-radius: 16px;
    box-shadow: 0 10px 34px rgba(16,24,40,.12); padding: 26px 24px 24px;
  }
  .label {
    display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: .1em;
    text-transform: uppercase; color: #1554d6; background: #e8efff;
    padding: 5px 11px; border-radius: 999px;
  }
  h1 { margin: 16px 0 6px; font-size: 19px; letter-spacing: -.01em; }
  p.hint { margin: 0 0 18px; font-size: 13px; color: #64748b; }
  .value {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 17px; font-weight: 600; line-height: 1.55;
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;
    padding: 16px; word-break: break-word; white-space: pre-wrap;
    max-height: 46vh; overflow: auto; cursor: text;
  }
  .value.empty { color: #b42318; font-weight: 700; }
  button {
    width: 100%; margin-top: 16px; padding: 15px 18px; border: 0; border-radius: 12px;
    background: #1554d6; color: #fff; font-size: 16px; font-weight: 700;
    font-family: inherit; cursor: pointer; transition: background .15s ease;
  }
  button:hover { background: #1246b4; }
  button.ok { background: #12a150; }
  #msg { margin: 12px 0 0; min-height: 18px; font-size: 13px; font-weight: 600; color: #12a150; }
</style>
</head>
<body>
  <div class="card">
    <span class="label">${safeLabel}</span>
    <h1>Copy to clipboard</h1>
    <p class="hint">Value par click karke manually bhi select kar sakte ho.</p>
    ${body}
  </div>
  <script>
  (function () {
    var el = document.getElementById('value');
    var btn = document.getElementById('copy');
    var msg = document.getElementById('msg');
    if (!el || !btn) return;

    function selectAll() {
      try {
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) { /* ignore */ }
    }

    function legacyCopy() {
      try { selectAll(); return document.execCommand('copy'); } catch (e) { return false; }
    }

    function done() {
      btn.textContent = 'Copied!';
      btn.classList.add('ok');
      msg.textContent = 'Clipboard me copy ho gaya. Ye tab band kar sakte ho.';
    }

    function fallback() {
      selectAll();
      msg.textContent = 'Text select kar liya - Ctrl+C (Mac par Cmd+C) dabayein.';
    }

    function copy(quiet) {
      var text = el.textContent;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {
          if (quiet) return;
          if (legacyCopy()) done(); else fallback();
        });
        return;
      }

      if (legacyCopy()) { if (!quiet) done(); }
      else if (!quiet) fallback();
    }

    btn.addEventListener('click', function () { copy(false); });
    el.addEventListener('click', selectAll);
    window.addEventListener('load', function () { setTimeout(function () { copy(true); }, 150); });
  })();
  </script>
</body>
</html>`;
}
