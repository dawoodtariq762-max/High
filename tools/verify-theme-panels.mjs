import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:4901';
const OUT = '/home/user/theme-shots';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const errors = [];
function note(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(page.url() + ' :: ' + m.text()); });
page.on('pageerror', (e) => errors.push(page.url() + ' :: pageerror: ' + e.message));
page.on('requestfailed', (r) => {
  const u = r.url();
  if (/(\/assets\/|\/branding\/)/.test(u)) errors.push('asset failed: ' + u);
});

/* log in once as admin */
await page.goto(BASE + '/login.html', { waitUntil: 'networkidle' });
await page.fill('#username', 'vibepk');
await page.fill('#password', 'vibepk123');
const cap = await page.textContent('#captchaText');
await page.fill('#captcha', String(eval(cap.replace('+', '+'))));
await page.click('button[type=submit]');
await page.waitForTimeout(2000);
const token = await page.evaluate(() => localStorage.getItem('ms_token') || sessionStorage.getItem('ms_token'));
note(!!token, 'admin login token obtained');

/* every panel reachable in this build */
const PANELS = [
  ['/admin/dashboard',   'Admin Dashboard'],
  ['/management.html',   'Management'],
  ['/manager.html',      'Manager'],
  ['/agent.html',        'Agent'],
  ['/client.html',       'Client'],
  ['/payment.html',      'Payment'],
  ['/panel-sharing.html','Panel Sharing'],
  ['/branding.html',     'Branding'],
  ['/chat.html',         'Chat'],
];

const LOGINS = [
  ['/login.html',                'Login'],
  ['/management-login.html',     'Management Login'],
  ['/payment-login.html',        'Payment Login'],
  ['/panel-sharing-login.html',  'Panel Sharing Login'],
];

function isDark(rgb) {
  const m = String(rgb).match(/\d+/g);
  if (!m) return false;
  if (m.length > 3 && Number(m[3]) === 0) return null;   // transparent
  return Number(m[0]) < 45 && Number(m[1]) < 45 && Number(m[2]) < 45;
}

console.log('\n  --- panels (logged in) ---');
for (const [url, label] of PANELS) {
  let ok = true, detail = '';
  try {
    const res = await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(700);
    const info = await page.evaluate(() => {
      const b = getComputedStyle(document.body);
      const html = getComputedStyle(document.documentElement);
      const card = document.querySelector('.card,.panel,.box,.qt-card,.qt-chart-card,table,form');
      return {
        bodyBg: b.backgroundColor, htmlBg: html.backgroundColor,
        accent: b.getPropertyValue('--accent').trim() || html.getPropertyValue('--accent').trim(),
        cardBg: card ? getComputedStyle(card).backgroundColor : 'absent',
        title: document.title,
      };
    });
    const bodyDark = isDark(info.bodyBg);
    const htmlDark = isDark(info.htmlBg);
    const themed = bodyDark === true || (bodyDark === null && htmlDark === true);
    const gold = /e0bc4f|d4af43|e9c869/i.test(info.accent);
    detail = `body=${info.bodyBg} html=${info.htmlBg} accent=${info.accent || '-'}`;
    ok = themed && gold;
    if (!themed) detail += '  [NOT DARK]';
    if (!gold) detail += '  [ACCENT NOT GOLD]';
  } catch (e) {
    ok = false; detail = 'load error: ' + e.message.split('\n')[0].slice(0, 70);
  }
  note(ok, label.padEnd(16) + ' themed', detail);
  await page.screenshot({ path: `${OUT}/panel-${label.replace(/\s+/g, '-').toLowerCase()}.png` });
}

console.log('\n  --- login pages (not logged in) ---');
const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
for (const [url, label] of LOGINS) {
  const lp = await anon.newPage();
  lp.on('pageerror', (e) => errors.push(url + ' :: ' + e.message));
  lp.on('console', (m) => { if (m.type() === 'error') errors.push(url + ' :: ' + m.text()); });
  let ok = true, detail = '';
  try {
    await lp.goto(BASE + url, { waitUntil: 'networkidle', timeout: 20000 });
    await lp.waitForTimeout(500);
    const info = await lp.evaluate(() => {
      const b = getComputedStyle(document.body);
      const html = getComputedStyle(document.documentElement);
      const btn = document.querySelector('button, .btn, input[type=submit]');
      return {
        bodyBg: b.backgroundColor, htmlBg: html.backgroundColor,
        btnImg: btn ? getComputedStyle(btn).backgroundImage.slice(0, 60) : 'absent',
        hasForm: !!document.querySelector('form'),
      };
    });
    const bodyDark = isDark(info.bodyBg);
    const htmlDark = isDark(info.htmlBg);
    const themed = bodyDark === true || (bodyDark === null && htmlDark === true);
    const gold = /212, 175, 67|233, 200, 105|224, 188, 79/.test(info.btnImg);
    detail = `html=${info.htmlBg} btn=${info.btnImg.slice(0, 42)}`;
    ok = themed && gold && info.hasForm;
    if (!themed) detail += ' [NOT DARK]';
    if (!gold) detail += ' [BTN NOT GOLD]';
  } catch (e) { ok = false; detail = 'load error: ' + e.message.split('\n')[0].slice(0, 60); }
  note(ok, label.padEnd(21) + ' themed', detail);
  await lp.close();
}

/* mobile sweep */
console.log('\n  --- mobile 390x844 ---');
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mp = await mctx.newPage();
mp.on('pageerror', (e) => errors.push('mobile :: ' + e.message));
for (const [url, label] of [['/login.html', 'Login'], ['/admin/dashboard', 'Admin'], ['/management.html', 'Mgmt']]) {
  await mp.goto(BASE + url, { waitUntil: 'networkidle', timeout: 20000 });
  await mp.waitForTimeout(600);
  const ov = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  note(ov <= 2, (label + ' mobile').padEnd(16) + ' no h-overflow', `overflow=${ov}px`);
  await mp.screenshot({ path: `${OUT}/mobile-${label.replace(/\s+/g, '-').toLowerCase()}.png` });
}

await browser.close();

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${passed} passed, ${failed} failed`);
if (errors.length) {
  console.log(`\n  CONSOLE / ASSET ERRORS (${errors.length}):`);
  [...new Set(errors)].slice(0, 15).forEach((e) => console.log('    - ' + e.slice(0, 150)));
} else {
  console.log('  no console errors, no failed asset requests');
}
