/**
 * Sidebar behaviour check — desktop and mobile, all panels.
 *
 * Measures what a user would actually see: the sidebar's on-screen position and
 * width, taken from getBoundingClientRect(), plus whether a submenu is expanded.
 * A sidebar "open" on a narrow screen means it has slid into view (x >= 0);
 * "closed" means it has been pushed off-canvas (x < 0) or hidden.
 *
 * Run with the dev server on 4901:
 *   node tools/verify-sidebar-behavior.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:4901';
const NAV = '#sidebar, #rail, header.appbar, .appbar';
const HAM = '.hamburger, .mgr-mobile-menu, .mgr-topbar-menu, [data-qt-sb-toggle]';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '   (' + detail + ')' : '')); }
  else { fail++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '   (' + detail + ')' : '')); }
}

/* Where is the sidebar on screen right now? */
async function sbState(page) {
  return page.evaluate((NAV) => {
    const n = document.querySelector(NAV);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    return {
      x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, visibility: cs.visibility, transform: cs.transform,
      body: document.body.className,
      collapsed: document.body.classList.contains('qt-sb-collapsed'),
      open: document.body.classList.contains('qt-sb-open'),
      narrow: window.matchMedia('(max-width:900px)').matches,
    };
  }, NAV);
}
/* x >= 0 and non-zero width == actually on screen */
const visible = s => s && s.display !== 'none' && s.visibility !== 'hidden' && s.w > 0 && s.x >= -1;

async function submenuState(page, label) {
  return page.evaluate((label) => {
    const item = [...document.querySelectorAll('.nav-item')]
      .find(el => (el.textContent || '').trim().startsWith(label));
    if (!item) return null;
    const sub = item.parentElement.querySelector('.submenu');
    if (!sub) return null;
    const cs = getComputedStyle(sub);
    return { h: Math.round(sub.getBoundingClientRect().height), display: cs.display, maxH: cs.maxHeight };
  }, label);
}

async function login(page, user, pass_) {
  await page.goto(BASE + '/panel-login?cb=' + Date.now(), { waitUntil: 'networkidle' });
  await page.fill('#username', user);
  await page.fill('#password', pass_);
  const c = await page.textContent('#captchaText');
  await page.fill('#captcha', String(eval(c.replace('+', '+'))));
  await page.click('button[type=submit]');
  await page.waitForTimeout(2600);
}

const browser = await chromium.launch();

/* =============================== DESKTOP =============================== */
async function testDesktop(page, errs, label, panel) {
  console.log('\n  ── DESKTOP 1440x900 · ' + label + ' ──');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(900);
  if (panel) { await page.goto(BASE + panel + '?cb=' + Date.now(), { waitUntil: 'networkidle' }); await page.waitForTimeout(1800); }

  let s = await sbState(page);
  check(label + ' desktop: sidebar visible after login', visible(s), 'x=' + s.x + ' w=' + s.w);

  let ham = await page.$(HAM);
  if (!ham) { check(label + ' desktop: hamburger exists', false); await ctx.close(); return; }

  await ham.click(); await page.waitForTimeout(700);
  let after = await sbState(page);
  check(label + ' desktop: hamburger collapses sidebar', !visible(after) || after.collapsed,
        'x=' + after.x + ' w=' + after.w + ' collapsed=' + after.collapsed);

  await ham.click(); await page.waitForTimeout(700);
  let back = await sbState(page);
  check(label + ' desktop: hamburger re-opens sidebar', visible(back), 'x=' + back.x + ' w=' + back.w);

  check(label + ' desktop: no page errors', errs.length === 0, errs.slice(0, 1).join(''));
}

/* =============================== MOBILE ================================ */
async function testMobile(page, errs, label, panel) {
  console.log('\n  ── MOBILE 390x844 · ' + label + ' ──');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(900);
  if (panel) { await page.goto(BASE + panel + '?cb=' + Date.now(), { waitUntil: 'networkidle' }); await page.waitForTimeout(1800); }

  let ham = await page.$(HAM);
  if (!ham) { check(label + ' mobile: hamburger exists', false); await ctx.close(); return; }

  // reload so the panel initialises at mobile width, exactly as a phone would.
  // The reload detaches every handle taken before it, so re-acquire the button.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const hamR = await page.$(HAM);
  if (hamR) ham = hamR;

  // the drawer must be OPEN as soon as the panel loads (i.e. right after login)
  let initial = await sbState(page);
  check(label + ' mobile: sidebar OPEN on first load', visible(initial), 'x=' + initial.x + ' w=' + initial.w);

  // make sure we start from a known-open sidebar
  let s = await sbState(page);
  if (!visible(s)) { await ham.click(); await page.waitForTimeout(700); s = await sbState(page); }
  check(label + ' mobile: sidebar can be open', visible(s), 'x=' + s.x + ' w=' + s.w);

  // hamburger closes
  await ham.click(); await page.waitForTimeout(700);
  let closed = await sbState(page);
  check(label + ' mobile: hamburger closes sidebar', !visible(closed), 'x=' + closed.x + ' w=' + closed.w);

  // hamburger re-opens
  await ham.click(); await page.waitForTimeout(700);
  let reopened = await sbState(page);
  check(label + ' mobile: hamburger re-opens sidebar', visible(reopened), 'x=' + reopened.x + ' w=' + reopened.w);

  // ---- dropdown parent: must expand submenu AND keep the sidebar open ----
  const parent = await page.evaluateHandle(() => {
    const el = [...document.querySelectorAll('.nav-item')].find(
      e => /toggleSub|toggleRsub|toggleDrop|toggleNav/i.test(e.getAttribute('onclick') || '')
    );
    return el || null;
  });
  const parentEl = parent.asElement();
  if (!parentEl) {
    check(label + ' mobile: dropdown parent found', false);
  } else {
    const pTxt = (await parentEl.textContent() || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    const label2 = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.nav-item')].find(
        e => /toggleSub|toggleRsub|toggleDrop|toggleNav/i.test(e.getAttribute('onclick') || '')
      );
      const sub = el.parentElement.querySelector('.submenu');
      return sub ? sub.id || 'sub' : null;
    });
    const before = await submenuState(page, pTxt.split(' ')[0]);
    await parentEl.click(); await page.waitForTimeout(700);
    const afterSub = await submenuState(page, pTxt.split(' ')[0]);
    const afterSb = await sbState(page);

    check(label + ' mobile: dropdown "' + pTxt + '" expands',
          afterSub && afterSub.h > 0 && (!before || before.h === 0 || afterSub.h !== before.h),
          'submenu h ' + (before ? before.h : '?') + ' -> ' + (afterSub ? afterSub.h : '?'));
    check(label + ' mobile: sidebar STAYS OPEN after dropdown tap', visible(afterSb),
          'x=' + afterSb.x + ' w=' + afterSb.w);

    // ---- real submenu link: navigate + close ----
    const subLink = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.nav-item')].find(
        e => /toggleSub|toggleRsub|toggleDrop|toggleNav/i.test(e.getAttribute('onclick') || '')
      );
      const sub = el.parentElement.querySelector('.submenu');
      const a = sub && sub.querySelector('.sub-item, a, .nav-item');
      return a ? (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22) : null;
    });
    if (subLink) {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('.nav-item')].find(
          e => /toggleSub|toggleRsub|toggleDrop|toggleNav/i.test(e.getAttribute('onclick') || '')
        );
        const sub = el.parentElement.querySelector('.submenu');
        const a = sub && sub.querySelector('.sub-item, a, .nav-item');
        if (a) a.click();
      });
      await page.waitForTimeout(1200);
      const s2 = await sbState(page);
      check(label + ' mobile: submenu item "' + subLink + '" closes sidebar', !visible(s2),
            'x=' + s2.x + ' w=' + s2.w);
      // reopen after navigation
      const ham2 = await page.$(HAM);
      await ham2.click(); await page.waitForTimeout(700);
      const s3 = await sbState(page);
      check(label + ' mobile: sidebar reopens after submenu navigation', visible(s3), 'x=' + s3.x);
    } else {
      check(label + ' mobile: submenu link found', false);
    }

    // ---- standalone item: navigate + close ----
    const ham3 = await page.$(HAM);
    if (!(await sbState(page)).narrow ? true : true) { /* noop */ }
    let st = await sbState(page);
    if (!visible(st)) { await ham3.click(); await page.waitForTimeout(600); }
    const standalone = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.nav-item')].filter(e =>
        !/toggleSub|toggleRsub|toggleDrop|toggleNav/i.test(e.getAttribute('onclick') || ''));
      const dash = items.find(e => /dashboard/i.test(e.textContent || ''));
      const el = dash || items[0];
      return el ? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22) : null;
    });
    if (standalone) {
      await page.evaluate(() => {
        const items = [...document.querySelectorAll('.nav-item')].filter(e =>
          !/toggleSub|toggleRsub|toggleDrop|toggleNav/i.test(e.getAttribute('onclick') || ''));
        const dash = items.find(e => /dashboard/i.test(e.textContent || ''));
        const el = dash || items[0];
        if (el) el.click();
      });
      await page.waitForTimeout(1200);
      const s4 = await sbState(page);
      check(label + ' mobile: standalone "' + standalone + '" closes sidebar', !visible(s4),
            'x=' + s4.x + ' w=' + s4.w);
    } else {
      check(label + ' mobile: standalone item found', false);
    }
  }

  check(label + ' mobile: no page errors', errs.length === 0, errs.slice(0, 1).join(''));
}

console.log('=== SIDEBAR BEHAVIOUR (current state) ===');
const targets = process.env.PANELS
  ? process.env.PANELS.split(',').map(s => { const [u, p, l, url] = s.split('|'); return { u, p, l, url: url || null }; })
  : [{ u: 'vibepk', p: 'vibepk123', l: 'Admin', url: null },
     { u: 'vibepk', p: 'vibepk123', l: 'Management', url: '/management.html' }];
for (const t of targets) {
  // ONE login per panel: the server allows only 10 logins / 5 min per IP, so
  // each panel opens a single session and the viewport is resized to test
  // desktop, then mobile, on that same session.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await login(page, t.u, t.p);
  await testDesktop(page, errs, t.l, t.url);
  await testMobile(page, errs, t.l, t.url);
  await ctx.close();
}

console.log('\n=== SUMMARY ===');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (fails.length) { console.log('\n  Failures:'); fails.forEach(f => console.log('   - ' + f)); }
await browser.close();
process.exit(fail ? 1 : 0);
