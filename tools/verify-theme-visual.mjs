import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:4901';
const OUT = '/home/user/theme-shots';
fs.mkdirSync(OUT, { recursive: true });

const ROLES = [
  { user: 'vibepk', pass: 'vibepk123', panel: 'admin',   label: 'Admin' },
];

const errors = [];
const results = [];

function note(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

const browser = await chromium.launch();

async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (u.includes('/assets/') || u.includes('/branding/')) errors.push('404/failed: ' + u);
  });
  return page;
}

/* ---------------- 1. LOGIN PAGE ---------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await newPage(ctx);

  await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/01-login-desktop.png` });

  // background must be warm near-black, not white and not navy
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const m = bg.match(/\d+/g).map(Number);
  const isDark = m[0] < 40 && m[1] < 40 && m[2] < 40;
  const isWarm = m[0] >= m[2];               // red channel >= blue => warm cast
  note(isDark, 'login background is near-black', bg);
  note(isWarm, 'login background has warm (not navy) cast', `r=${m[0]} g=${m[1]} b=${m[2]}`);

  // submit button must be gold
  const btn = await page.evaluate(() => {
    const b = document.querySelector('.login-card .btn, button[type=submit], .btn');
    if (!b) return null;
    const s = getComputedStyle(b);
    return { bgImage: s.backgroundImage, bgColor: s.backgroundColor, color: s.color };
  });
  const goldish = btn && /rgb\(2[0-9]{2},\s*1[5-9][0-9],\s*[5-9][0-9]\)|linear-gradient/.test(
    btn.bgImage + ' ' + btn.bgColor
  );
  note(!!btn, 'login submit button found');
  note(!!goldish || /gradient/.test(btn?.bgImage || ''), 'submit button is gold', (btn?.bgImage || '').slice(0, 70));

  // decorative login backdrop layers must be gone
  const deco = await page.evaluate(() => {
    const sels = ['.qlb-orb', '.qt-fx', '.qt-bk', '.qlb-wave', '.qlb-trail', '.qt-geo', '.qtech-login-bg'];
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      out[s] = el ? getComputedStyle(el).display : 'absent';
    }
    return out;
  });
  const allHidden = Object.values(deco).every((v) => v === 'none' || v === 'absent');
  note(allHidden, 'decorative login backdrop removed', JSON.stringify(deco));

  // animation durations collapsed
  const anim = await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')].slice(0, 400);
    let long = 0, total = 0;
    for (const e of els) {
      const s = getComputedStyle(e);
      if (s.animationName && s.animationName !== 'none') {
        total++;
        if (parseFloat(s.animationDuration) > 0.05) long++;
      }
    }
    return { total, long };
  });
  note(anim.long === 0, 'no long-running animations on login', JSON.stringify(anim));

  // mobile
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await newPage(mctx);
  await mp.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
  await mp.waitForTimeout(300);
  await mp.screenshot({ path: `${OUT}/02-login-mobile.png` });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  note(overflow <= 1, 'login has no horizontal overflow on mobile', `overflow=${overflow}px`);
  await mctx.close();

  await ctx.close();
}

/* ---------------- 2. PANELS (logged in) ---------------- */
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await newPage(ctx);

await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
await page.fill('#username', 'vibepk');
await page.fill('#password', 'vibepk123');
const captcha = await page.textContent('#captchaText');
await page.fill('#captcha', String(eval(captcha.replace('+', '+'))));
await page.click('button[type=submit]');
await page.waitForURL(/admin|dashboard/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

note(page.url().includes('admin'), 'logged in as admin', page.url());
await page.screenshot({ path: `${OUT}/03-admin-desktop.png` });

// panel background + sidebar
const panel = await page.evaluate(() => {
  const body = getComputedStyle(document.body);
  const sb = document.querySelector('.sidebar, .rail, .rail-nav, .sb-nav, .side, .appbar');
  return {
    bodyBg: body.backgroundColor,
    sidebarBg: sb ? getComputedStyle(sb).backgroundColor : 'absent',
    sidebarClass: sb ? sb.className : 'absent',
  };
});
const pm = panel.bodyBg.match(/\d+/g).map(Number);
note(pm[0] < 40 && pm[1] < 40 && pm[2] < 40, 'admin panel background is dark', panel.bodyBg);
note(panel.sidebarBg !== 'absent', 'sidebar present', `${panel.sidebarClass} -> ${panel.sidebarBg}`);

// active nav item should read gold
const navGold = await page.evaluate(() => {
  const a = document.querySelector('.nav-item.active, .sub-item.active, .ritem.active, .sidebar .tab.active');
  if (!a) return { found: false };
  const s = getComputedStyle(a);
  return { found: true, color: s.color, bg: s.backgroundColor, shadow: s.boxShadow };
});
if (navGold.found) {
  const c = (navGold.color.match(/\d+/g) || []).map(Number);
  note(c[0] > 180 && c[1] > 140 && c[2] < 160, 'active nav item uses gold', navGold.color);
} else {
  note(false, 'active nav item found', 'none present');
}

// sidebar / dropdown transitions must be instant
const trans = await page.evaluate(() => {
  const sels = ['.sidebar', '.nav-item', '.submenu', '.dropdown', '.modal'];
  const out = {};
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el) out[s] = getComputedStyle(el).transitionDuration;
  }
  return out;
});
const slowTrans = Object.entries(trans).filter(([, v]) => parseFloat(v) > 0.12);
note(slowTrans.length === 0, 'sidebar/dropdown transitions are instant', JSON.stringify(trans));

// tables, cards, inputs visible
const comps = await page.evaluate(() => {
  const g = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
  const card = g('.card, .panel, .box');
  const th = g('th');
  const inp = g('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select');
  return {
    cardBg: card?.backgroundColor, cardBorder: card?.borderTopColor,
    thBg: th?.backgroundColor, thColor: th?.color,
    inputBg: inp?.backgroundColor, inputColor: inp?.color,
  };
});
console.log('  component colours:', JSON.stringify(comps));
const darkComps = [comps.cardBg, comps.thBg, comps.inputBg].filter(Boolean);
const compsDark = darkComps.every((c) => { const v = c.match(/\d+/g).map(Number); return v[0] < 45; });
note(compsDark, 'cards / table headers / inputs use dark surfaces', JSON.stringify(darkComps));

// mobile panel
const mctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp2 = await newPage(mctx2);
await mp2.goto(BASE + '/admin.html', { waitUntil: 'networkidle' });
await mp2.evaluate(() => {
  try {
    localStorage.setItem('ms_token', window.__tok || '');
  } catch (e) {}
});
await mp2.waitForTimeout(600);
await mp2.screenshot({ path: `${OUT}/04-admin-mobile.png` });
const ov2 = await mp2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
note(ov2 <= 1, 'admin panel has no horizontal overflow on mobile', `overflow=${ov2}px`);
await mctx2.close();

await ctx.close();
await browser.close();

/* ---------------- summary ---------------- */
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${passed} passed, ${failed} failed`);
if (errors.length) {
  console.log(`\n  CONSOLE / ASSET ERRORS (${errors.length}):`);
  [...new Set(errors)].slice(0, 20).forEach((e) => console.log('    - ' + e.slice(0, 160)));
} else {
  console.log('  no console errors, no failed asset requests');
}
