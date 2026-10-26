'use strict';
/* ============================================================================
   Inject the ZOOM SMS dark+gold theme and the motion-off sheet into every page.
   ----------------------------------------------------------------------------
   Both files MUST be the last stylesheets in the document so they win the
   cascade against qtech.css, qtech-light.css, qtech-layout.css and the
   generated /branding/runtime.css.

   The injector is idempotent: running it twice will not add the links twice.
   It never rewrites or removes anything that is already in the page.

   Run: node tools/inject-zoom-theme.js
   ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  /* panels */
  'admin.html', 'management.html', 'manager.html', 'agent.html', 'client.html',
  'payment.html', 'panel-sharing.html', 'branding.html', 'chat.html',
  /* logins */
  'login.html', 'management-login.html', 'payment-login.html',
  'panel-sharing-login.html', 'test-login.html', 'branding-login.html',
];

const THEME_TAG =
  '<link rel="stylesheet" href="/assets/zoom-theme.css?v=zoom-20261026"/>';
const MOTION_TAG =
  '<link rel="stylesheet" href="/assets/zoom-motion-off.css?v=zoom-20261026"/>';

let changed = 0;
let skipped = 0;

for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log('  MISSING  ' + f); continue; }

  let html = fs.readFileSync(p, 'utf8');
  const before = html;

  /* Drop any previous injection so the tags land in the right place even if
     this script has run before with a different cache-buster. */
  html = html.replace(/\s*<link[^>]*href="\/assets\/zoom-theme\.css[^"]*"\s*\/?>/g, '');
  html = html.replace(/\s*<link[^>]*href="\/assets\/zoom-motion-off\.css[^"]*"\s*\/?>/g, '');

  const injection = '\n' + THEME_TAG + '\n' + MOTION_TAG;

  /* Prefer to insert immediately after the branding runtime sheet, which is
     the last stylesheet on every page. Fall back to the last <link> in <head>,
     then to </head>. */
  let done = false;

  const runtimeRe = /<link[^>]*href="\/branding\/runtime\.css[^"]*"[^>]*>/i;
  if (runtimeRe.test(html)) {
    html = html.replace(runtimeRe, (m) => m + injection);
    done = true;
  }

  if (!done) {
    const links = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*>/gi)];
    if (links.length) {
      const last = links[links.length - 1];
      html = html.slice(0, last.index + last[0].length) + injection + html.slice(last.index + last[0].length);
      done = true;
    }
  }

  if (!done) {
    const headClose = html.search(/<\/head>/i);
    if (headClose > -1) {
      html = html.slice(0, headClose) + injection + '\n' + html.slice(headClose);
      done = true;
    }
  }

  if (!done) { console.log('  NO HEAD  ' + f); continue; }

  if (html === before) { skipped++; console.log('  up to date  ' + f); continue; }

  fs.writeFileSync(p, html);
  changed++;
  console.log('  injected    ' + f);
}

console.log('\n  %d file(s) updated, %d already current.', changed, skipped);
