/**
 * Sidebar check for Manager, Agent and Client.
 *
 * Those three are separate portals with their own credentials and their
 * passwords are bcrypt-hashed, so a test run cannot log into them.
 *
 * Rather than rebuild their markup, this loads each REAL panel page. Every
 * panel guards itself with an inline script that (a) reads ms_token / ms_role
 * from sessionStorage and (b) confirms the role with GET /api/me. Both are
 * satisfied here: sessionStorage is seeded before the panel's own script runs,
 * and /api/me is answered with the role the panel expects.
 *
 * The page then renders its genuine sidebar, genuine top bar and genuine
 * stylesheets, and the real /api.js QTNav drives them. Data is absent, so this
 * proves the SIDEBAR MECHANISM only — it is not a login, permission or data
 * test. Those are covered on Admin and Management by
 * verify-sidebar-behavior.mjs, which logs in for real.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:4901';

let pass = 0, fail = 0; const fails = [];
function check(n, c, d) {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   (' + d + ')' : '')); }
  else { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log('  FAIL  ' + n + (d ? '   (' + d + ')' : '')); }
}

const HAM = '.hamburger,.mgr-mobile-menu,.mgr-topbar-menu,[data-qt-sb-toggle]';
const NAV = '#sidebar,#rail,.appbar,.rail,.sidebar';

const browser = await chromium.launch();

// One real login, purely to obtain a validly-formed token for the storage guard.
let token = '';
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(BASE + '/panel-login?cb=' + Date.now(), { waitUntil: 'networkidle' });
  await p.fill('#username', 'vibepk');
  await p.fill('#password', 'vibepk123');
  const c = await p.textContent('#captchaText');
  await p.fill('#captcha', String(eval(c.replace('+', '+'))));
  await p.click('button[type=submit]');
  await p.waitForTimeout(2500);
  token = await p.evaluate(() => sessionStorage.getItem('ms_token') || localStorage.getItem('ms_token') || '');
  await ctx.close();
}
if (!token) { console.log('  could not obtain a token — aborting'); process.exit(1); }

const panels = [
  { url: '/manager.html', role: 'manager', label: 'Manager' },
  { url: '/agent.html',   role: 'agent',   label: 'Agent' },
  { url: '/client.html',  role: 'client',  label: 'Client' },
];

console.log('=== SIDEBAR — Manager / Agent / Client (real pages, stubbed /api/me) ===');

for (const pan of panels) {
  for (const vp of [{ w: 1440, h: 900, n: 'desktop' }, { w: 390, h: 844, n: 'mobile' }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));

    // seed storage before any panel script runs
    await page.addInitScript(([t, r]) => {
      try {
        sessionStorage.setItem('ms_token', t); sessionStorage.setItem('ms_role', r);
        sessionStorage.setItem('ms_user', 'harness'); sessionStorage.setItem('ms_name', 'harness');
      } catch (e) {}
    }, [token, pan.role]);

    await page.route('**/api/me', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ id: 1, username: 'harness', role: pan.role, name: 'harness' })
    }));

    await page.goto(BASE + pan.url + '?cb=' + Date.now(), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2600);
    // Client shows a full-screen welcome overlay on first visit; it would
    // swallow every tap. Dismiss it so the sidebar can be exercised.
    await page.evaluate(() => {
      ['#clientWelcome', '.client-welcome-overlay', '.welcome-overlay'].forEach(sel => {
        const el = document.querySelector(sel);
        if (el) { try { if (typeof el.click === 'function') el.click(); } catch (e) {} el.remove(); }
      });
    });

    const url = page.url();
    if (url.includes('panel-login')) {
      check(pan.label + ' ' + vp.n + ': page loaded', false, 'redirected to login');
      await ctx.close(); continue;
    }

    const st = () => page.evaluate((NAV) => {
      const n = document.querySelector(NAV);
      if (!n) return null;
      const r = n.getBoundingClientRect(); const cs = getComputedStyle(n);
      return { x: Math.round(r.x), w: Math.round(r.width), disp: cs.display, vis: cs.visibility,
               sel: n.tagName + (n.id ? '#' + n.id : '') + '.' + String(n.className).split(' ')[0],
               open: document.body.classList.contains('qt-sb-open'),
               collapsed: document.body.classList.contains('qt-sb-collapsed') };
    }, NAV);
    const vis = s => s && s.disp !== 'none' && s.vis !== 'hidden' && s.w > 0 && s.x >= -1;

    const s0 = await st();
    if (!s0) { check(pan.label + ' ' + vp.n + ': sidebar found', false); await ctx.close(); continue; }

    if (vp.n === 'desktop') check(pan.label + ' desktop: sidebar open by default', vis(s0), s0.sel + ' x=' + s0.x);
    else check(pan.label + ' mobile: drawer open on load', vis(s0), s0.sel + ' x=' + s0.x);

    // Several panels declare more than one menu button (Manager has both
    // .mgr-mobile-menu, display:none, and .mgr-topbar-menu). QTNav wires them
    // all; the one a user can actually press is the visible one.
    const ham = await page.evaluateHandle((HAM) => {
      const all = [...document.querySelectorAll(HAM)];
      return all.find(b => {
        const cs = getComputedStyle(b);
        const r = b.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      }) || null;
    }, HAM);
    if (!ham.asElement()) { check(pan.label + ' ' + vp.n + ': hamburger found', false); await ctx.close(); continue; }

    await ham.click(); await page.waitForTimeout(650);
    const s1 = await st();
    check(pan.label + ' ' + vp.n + ': hamburger hides sidebar', !vis(s1), 'x=' + s1.x);

    await ham.click(); await page.waitForTimeout(650);
    const s2 = await st();
    check(pan.label + ' ' + vp.n + ': hamburger shows sidebar', vis(s2), 'x=' + s2.x);

    if (vp.n === 'mobile') {
      // Identify the parent + submenu, then click and MEASURE IN A SEPARATE STEP.
      // Reading getBoundingClientRect() in the same evaluate as the click
      // returns the pre-transition height (0) and looks like a failure.
      const found = await page.evaluate(() => {
        const par = [...document.querySelectorAll('.nav-item,.ritem,.navtab')]
          .find(e => /toggle(Sub|Rsub|Drop|Nav)\s*\(/i.test(e.getAttribute('onclick') || ''));
        if (!par) return null;
        const SUB = '.submenu,.rsub,.dropmenu,.dropdown-menu';
        let sub = par.parentElement ? par.parentElement.querySelector(SUB) : null;
        if (!sub) { let n = par.nextElementSibling; while (n && !n.matches(SUB)) n = n.nextElementSibling; sub = n; }
        if (sub) sub.setAttribute('data-harness-sub', '1');
        const before = sub ? Math.round(sub.getBoundingClientRect().height) : -1;
        par.click();
        return { before, label: (par.textContent || '').trim().slice(0, 18) };
      });
      await page.waitForTimeout(700);
      const res = found ? await page.evaluate(() => {
        const sub = document.querySelector('[data-harness-sub]');
        const n = document.querySelector('#sidebar,#rail,.appbar,.rail,.sidebar');
        return { after: sub ? Math.round(sub.getBoundingClientRect().height) : -1,
                 x: Math.round(n.getBoundingClientRect().x),
                 open: document.body.classList.contains('qt-sb-open') };
      }).then(r => ({ ...found, ...r })) : null;
      if (res) {
        check(pan.label + ' mobile: dropdown "' + res.label + '" expands', res.after > 0 && res.after !== res.before,
              'h ' + res.before + ' -> ' + res.after);
        check(pan.label + ' mobile: drawer STAYS OPEN on dropdown tap', res.x >= -1 && res.open, 'x=' + res.x);
      } else {
        // Not every panel has one. Client's sidebar is a flat menu: zero
        // .submenu/.rsub/.dropmenu elements, so there is nothing to expand and
        // nothing for the "dropdown keeps the drawer open" rule to apply to.
        const noSubs = await page.evaluate(() =>
          document.querySelectorAll('.submenu,.rsub,.dropmenu,.dropdown-menu').length === 0);
        if (noSubs) console.log('  N/A   ' + pan.label + ' mobile: no dropdown groups in this panel (flat menu)');
        else check(pan.label + ' mobile: dropdown parent found', false, 'no item with a toggle onclick');
      }
    }
    check(pan.label + ' ' + vp.n + ': no page errors', errs.length === 0, errs.slice(0, 1).join('').slice(0, 90));
    await ctx.close();
  }
}

console.log('\n=== SUMMARY ===');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (fails.length) { console.log('\n  Failures:'); fails.forEach(f => console.log('   - ' + f)); }
await browser.close();
process.exit(fail ? 1 : 0);
