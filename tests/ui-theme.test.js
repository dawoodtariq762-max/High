'use strict';
// Presentation contract checks. No server, database, credentials or network.
// Run: node tests/ui-theme.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
let total = 0;
function test(name, fn) { fn(); total++; console.log('PASS',name); }
for (const role of ['admin','manager','agent','client','management','panel-sharing','payment','test']) {
  test(role+' common non-login light theme',()=>{
    const s=read(role+'.html');
    /* the opt-in "qd" class enables the design system (assets/qtech-ds.css) */
    assert.match(s, /<body class="gx-light gx-qtech( qd)?">/);
    assert.equal((s.match(/href="\/assets\/qtech-light\.css/g)||[]).length,1);
    assert.match(s,/assets\/qtech-logo-square\.png/);
    assert.match(s,/assets\/qtech-favicon\.png/);
    assert.doesNotMatch(s,/almada|gx-lamix/i); /* provider-clone placeholder names (e.g. a CR-API provider) are data, not panel branding */
    assert.doesNotMatch(s, /data-page=["']bonus["']|href=["'][^"']*\/bonus["']/i);
  });
}
for (const name of ['login','management-login','panel-sharing-login','payment-login','test-login']) {
  test(name+' stays outside new theme and dashboard runtime',()=>{
    const s=read(name+'.html');assert.doesNotMatch(s,/qtech-light|dashboard-ui|gx-qtech/);
    assert.match(s,/\/api\/login/);
    assert.match(s,/Q TECH SMS/);
  });
}
for(const role of ['admin','manager','agent','client']) {
  test(role+' dashboard uses the reference-style components on real API data',()=>{
    const s=read(role+'.html');
    assert.match(s,/const d=await API\.get\('\/dashboard'\)/);
    assert.match(s,/QTDashboard\.kpiRow\('qtSmsCards',/);
    assert.match(s,/QTDashboard\.areaChart\('qtSmsChart',/);
    assert.ok(s.includes("GXDashboard.refreshExtras('"+role+"')"));
    assert.match(s,/GXDashboard\.error\(\)/);
    /* removed widgets stay removed */
    assert.doesNotMatch(s,/gxMap|GX\.map|gx-shortcuts/);
    assert.doesNotMatch(s,/class="chip">Live/);
    /* no banned explanatory subtitles on the dashboard cards/charts */
    for (const banned of ['Rolling 7 UK days','Month to date','Monday-start UK week','Europe/London reporting days','Recorded in the payment ledger ·']) {
      assert.ok(!s.includes(banned), role+' must not show the banned subtitle: '+banned);
    }
  });
}
test('KPI row titles are the required SMS statistic cards',()=>{
  for (const role of ['admin','manager','agent']) {
    const s=read(role+'.html');
    for (const label of ["label:'Today'","label:'Yesterday'","label:'Last 7 Days'","label:'This Month'"]) {
      assert.ok(s.includes(label), role+' KPI row must contain '+label);
    }
  }
  const c=read('client.html');
  for (const label of ["label:'Today'","label:'Yesterday'","label:'Last 7 Days'","label:'This Month Payout'"]) {
    assert.ok(c.includes(label), 'client KPI row must contain '+label);
  }
  assert.ok(!c.includes("label:'Earning Today'"),'client must not show earning cards');
});
/* Phase-5 §3A/§4A: the Earnings SUMMARY SECTION (heading + its four cards) is removed
   from Admin and Manager, while the Earnings 7-day graph, Payouts and (admin only)
   Provider Cost stay. §5A: the Agent group is relabelled "Payout" — same endpoint,
   same four values, only the displayed heading text changed. */
test('Phase-5 §3A/§4A: Earnings summary section removed from Admin and Manager, graph kept',()=>{
  for (const role of ['admin','manager']) {
    const s=read(role+'.html');
    assert.ok(!/statGroup\('qtEarnings','Earnings'/.test(s), role+' must not render the Earnings summary group');
    for (const label of ['Earning Today','Earning This Week','Earning This Month','Real Earning']) {
      assert.ok(!s.includes("label:'"+label+"'"), role+' must not render the earning card '+label);
    }
    assert.ok(s.includes("title:'Earning Last 7 Days'"), role+' must keep the Earnings 7-day graph');
    assert.match(s,/QTDashboard\.statGroup\('qtPayouts','Payouts',/);
  }
  /* the underlying calculations were not deleted with the cards */
  const a=read('admin.html');
  assert.match(a,/\/earnings-summary/);
  assert.match(a,/label:'Real Provider Cost Today'/);
  const m=read('manager.html');
  assert.ok(!m.includes('Real Provider Cost'),'provider cost stays admin-only');
});
test('Phase-5 §5A: the Agent earning group heading is Payout, values unchanged',()=>{
  const s=read('agent.html');
  assert.match(s,/QTDashboard\.statGroup\('qtEarnings','Payout',/);
  assert.ok(!/statGroup\('qtEarnings','Earnings'/.test(s),'the old Earnings heading must be gone');
  for (const label of ['Earning Today','Earning This Week','Earning This Month','Real Earning']) {
    assert.ok(s.includes("label:'"+label+"'"), 'agent must keep the value card '+label);
  }
  assert.ok(s.includes("title:'Earning Last 7 Days'"), 'agent must keep the earning graph title');
  assert.match(s,/API\.get\('\/earnings-summary'\)/);
});
test('Payout cards: four required periods, money-formatted, no subtitles',()=>{
  for (const role of ['admin','manager']) {
    const s=read(role+'.html');
    for (const label of ['Payout Today','Payout This Week','Payout Last 7 Days','Payout This Month']) {
      assert.ok(s.includes("label:'"+label+"'"), role+' must contain the payout card '+label);
    }
    assert.match(s,/QTDashboard\.statGroup\('qtPayouts','Payouts',/);
    assert.ok(s.includes('d.payout_today||0'), role+' must read the real payout_today API value');
  }
  const m=read('manager.html');
  assert.ok(!m.includes('Real Provider Cost'),'provider cost stays admin-only');
  assert.ok(!m.includes('provider_cost_'),'provider cost stays admin-only');
});
test('Admin inventory & account statistics + provider cost (admin-only, no yearly card)',()=>{
  const s=read('admin.html');
  /* Phase-5 §3A: these three cards are removed on purpose; the rest is kept */
  for (const label of ['Total Numbers in Inventory','Total Managers','Active Managers','Total Agents']) {
    assert.ok(s.includes("label:'"+label+"'"), 'admin must contain the inventory card '+label);
  }
  for (const removed of ['Active Agents','Overall Number Today','Overall Number This Week']) {
    assert.ok(!s.includes("label:'"+removed+"'"), 'Phase-5 §3A removed the card '+removed);
  }
  for (const label of ['Real Provider Cost Today','Real Provider Cost This Week','Real Provider Cost This Month']) {
    assert.ok(s.includes("label:'"+label+"'"), 'admin must contain the provider-cost card '+label);
  }
  assert.match(s,/QTDashboard\.statGroup\('qtInventory','Inventory & Accounts',/);
  assert.ok(s.includes('d.active_managers||0'),'admin must read the active manager count from the API');
  assert.ok(!s.includes('provider_cost_year'),'the yearly provider-cost card is removed');
  assert.ok(!s.includes('Year to date'),'no yearly wording remains');
});
test('Charts are titled per the spec and fed from the real API rows',()=>{
  for (const role of ['admin','manager','agent','client']) {
    const s=read(role+'.html');
    assert.ok(s.includes("title:'SMS Last 7 Days'"), role+' must contain the SMS chart');
    assert.ok(s.includes('rows:d.daily7'), role+' SMS chart must use /api/dashboard daily7');
  }
  for (const role of ['admin','manager','agent']) {
    const s=read(role+'.html');
    assert.ok(s.includes('rows:es.daily7'), role+' earning chart must use /api/earnings-summary daily7');
  }
});
const js=read('assets/dashboard-ui.js');
test('Dashboard module parses, exposes presentation-only entry points',()=>{
  const context={window:{}};vm.runInNewContext(js,context);
  for (const fn of ['cards','render','renderEarnings','refreshExtras','error']) {
    assert.equal(typeof context.window.GXDashboard[fn],'function', 'GXDashboard.'+fn);
  }
  assert.ok(Object.isFrozen(context.window.GXDashboard));
  for (const fn of ['kpiRow','statGroup','areaChart','money']) {
    assert.equal(typeof context.window.QTDashboard[fn],'function', 'QTDashboard.'+fn);
  }
  assert.ok(Object.isFrozen(context.window.QTDashboard));
});
test('No write APIs, storage, timers, new security or bonus behavior',()=>{
  assert.doesNotMatch(js,/API\.(post|put|del|upload)\(|localStorage|sessionStorage|setInterval\(|fetch\(/);
  assert.doesNotMatch(js,/\/bonus|\/notifications|\/agent\/self-allocate/);
  assert.match(js,/API.get\('\/stats-summary\//);
  assert.match(js,/API.get\('\/number-import-batches'\)/);
});
test('Ranking cards use scoped dimensions and real report links only',()=>{
  assert.doesNotMatch(js,/\/client\/(selfAllocate|clients|creditNotes)/);
  /* §3.2: the Admin panel's second ranking is Top Ranges (real range-level SMS
     activity), not Top Clients. Client/Agent panels keep their approved dims. */
  assert.match(js,/role === 'client' \? \['range'\] : role === 'admin' \? \['manager', 'range'\] : role === 'manager' \? \['agent', 'client'\] : \['client', 'range'\]/);
  assert.match(js,/API\.get\('\/stats-summary\/' \+ dim/);
  assert.doesNotMatch(js,/Not available for Client|lm-unavailable/);
});
test('QTDashboard formats money with the existing 3-decimal formatter',()=>{
  assert.match(js,/function pay3\(v\)/);
  assert.match(js,/typeof window\.pay3 === 'function'/);
  assert.match(js,/function money\(v\) \{ return v == null \|\| v === '' \? '—' : '\$ ' \+ pay3\(v\); \}/);
  assert.match(js,/QTDashboard\.money/);
  /* no hardcoded chart values */
  assert.doesNotMatch(js,/\[\{ ?date: ?'20/);
  assert.doesNotMatch(js,/hardcod|dummy/i);
});
test('QTDashboard renders the reference-style card/chart structure',()=>{
  assert.match(js,/function kpiRow\(containerId, items\)/);
  assert.match(js,/qt-card qt-' \+ esc\(it\.tone \|\| 'indigo'\)/);
  assert.match(js,/function statGroup\(containerId, title, items\)/);
  assert.match(js,/qt-group-title/);
  assert.match(js,/function areaChart\(containerId, opts\)/);
  assert.match(js,/qt-chart-card/);
  assert.match(js,/qt-legend/);
  assert.match(js,/linearGradient/);
  assert.match(js,/qt-tip/);
  assert.match(js,/aria-label=/);
  assert.match(js,/No data available\./);
});
test('Numbers pages load the per-number copy control; logins do not',()=>{
  for(const role of ['admin','manager','agent','client']){
    const s=read(role+'.html');
    assert.equal((s.match(/src="\/assets\/number-copy\.js/g)||[]).length,1);
  }
  for (const name of ['login','management-login','panel-sharing-login','payment-login','test-login']) {
    assert.doesNotMatch(read(name+'.html'),/number-copy/);
  }
});
const copyJs=read('assets/number-copy.js');
test('Copy control is frontend-only, reads the rendered row and never mutates data',()=>{
  assert.match(copyJs,/'numBody', 'numbersBody'/);
  assert.match(copyJs,/digitsOf\(probe\) >= 7/);
  assert.match(copyJs,/found\.host\.appendChild/);
  assert.match(copyJs,/navigator\.clipboard/);
  assert.match(copyJs,/execCommand\('copy'\)/);
  assert.match(copyJs,/dataset\.copy/);
  assert.match(copyJs,/:is-copied|is-copied/);
  assert.match(copyJs,/aria-live/);
  assert.match(copyJs,/stopPropagation/);
  assert.doesNotMatch(copyJs,/fetch\(|XMLHttpRequest|API\.(get|post|put|del|upload)|localStorage|sessionStorage/);
  assert.doesNotMatch(copyJs,/\/api\//);
  assert.doesNotMatch(copyJs,/(cell|source|row)\.(innerHTML|textContent|dataset\.copy)\s*=/);
  assert.match(copyJs,/btn\.innerHTML = GLYPH_COPY/);
});
test('Blue sidebar and top bar tokens plus muted card accents are scoped',()=>{
  const css=read('assets/qtech-light.css');
  assert.match(css,/#155177/);assert.match(css,/#0b2f4c/);
  assert.match(css,/linear-gradient\(#ffffff 0%,#eef6fb 100%\)/);
  for(let n=1;n<=6;n++)assert.ok(css.includes('.lm-acc-'+n),'lm-acc-'+n);
  assert.match(css,/\.gx-copy-inline/);
  assert.doesNotMatch(css,/gx-login|gx-portal-login/);
  assert.doesNotMatch(css,/gx-lamix/);
});
test('Reference-style dashboard components are styled and responsive',()=>{
  const css=read('assets/qtech.css');
  assert.match(css,/\.qt-cards\{display:grid;grid-template-columns:repeat\(4,1fr\)/);
  for (const tone of ['.qt-card.qt-indigo','.qt-card.qt-pink','.qt-card.qt-purple','.qt-card.qt-orange']) {
    assert.ok(css.includes(tone), 'gradient card tone '+tone);
    assert.match(css, new RegExp(tone.replace('.','\\.')+'\\{background:linear-gradient\\(135deg'));
  }
  assert.match(css,/\.qt-wcard\{/);
  assert.match(css,/\.qt-chart-card\{/);
  assert.match(css,/\.qt-tip\{/);
  assert.match(css,/@media \(max-width:1100px\)\{\s*\.qt-cards,\.qt-wcards\{grid-template-columns:repeat\(2,1fr\)\}/);
  assert.match(css,/@media \(max-width:600px\)\{\s*\.qt-cards,\.qt-wcards\{grid-template-columns:1fr\}/);
  /* white text on the gradient cards keeps the contrast */
  assert.match(css,/\.qt-card\{[^}]*color:#fff/);
});
test('Responsive rules remain scoped and provide focus/overflow treatment',()=>{
  const css=read('assets/qtech-light.css');
  const layout=read('assets/qtech-layout.css');
  const layoutCode=layout.replace(/\/\*[\s\S]*?\*\//g,'');
  assert.match(css,/body.gx-light.gx-qtech/);assert.match(css,/:focus-visible/);
  /* Phase-5 §2C: geometry (overflow, breakpoints, focus ring width) now lives in the
     shared theme-neutral sheet, colours stay in the light sheet */
  assert.match(layout,/overflow-x:auto/);assert.match(layout,/@media\(max-width:600px\)/);
  assert.match(layout,/:focus-visible/);
  assert.doesNotMatch(css,/gx-login|gx-portal-login/);
  /* the sheet's header comment documents that login pages are out of scope */
  assert.doesNotMatch(layoutCode,/gx-login|gx-portal-login/);
});
/* ---------------- Phase-5 shared theme/layout contract ---------------- */
test('Phase-5 §2C: one shared geometry sheet, no colour in it, no geometry left in the light sheet',()=>{
  const layout=read('assets/qtech-layout.css');
  const light=read('assets/qtech-light.css');
  const code=layout.replace(/\/\*[\s\S]*?\*\//g,'');
  assert.doesNotMatch(code,/(^|[;{\s])(color|background|background-image|border-color|box-shadow|fill|stroke|opacity|accent-color|outline-color|text-shadow|filter)\s*:/m);
  assert.ok(!/body\.gx-light/.test(code),'the shared sheet must not be light-only');
  assert.ok((code.match(/:is\(\.gx-light,\.gx-dark\)/g)||[]).length>100,'every shared rule must match both themes');
  const lightCode=light.replace(/\/\*[\s\S]*?\*\//g,'');
  assert.doesNotMatch(lightCode,/(^|[;{\s])(width|height|min-height|max-width|padding|margin|gap|display|flex-direction|grid-template-columns|font-size|line-height|letter-spacing|border-radius|overflow|position|z-index)\s*:/m);
  assert.doesNotMatch(light,/gx-dark/);
  for (const role of ['admin','manager','agent','client','management']) {
    const s=read(role+'.html');
    const order=['/assets/qtech.css','/assets/qtech-light.css','/assets/qtech-layout.css','/assets/qtech-chrome.css'].map(h=>s.indexOf(h));
    assert.ok(order.every(i=>i>-1), role+' must load all four style layers');
    assert.ok(order.every((v,i)=>i===0||v>order[i-1]), role+' must load them in cascade order');
  }
});
test('Phase-5 §2A/§2B: one shared hamburger + sun/moon toggle, no dead Settings gear',()=>{
  const js=read('api.js');
  assert.match(js,/window\.QTNav = QTNav/);
  assert.match(js,/qt-sb-collapsed/);assert.match(js,/qt-sb-open/);
  assert.match(js,/openSidebar:'open'/);assert.match(js,/toggleRail:'toggle'/);
  assert.match(js,/toggleManagerSidebar:'toggle'/);assert.match(js,/closeSb:'close'/);
  assert.match(js,/initThemeToggles/);assert.match(js,/QT_SUN/);assert.match(js,/QT_MOON/);
  assert.match(js,/qt-theme-toggle/);
  assert.match(js,/openSettings,/,'API.openSettings must stay available');
  const chrome=read('assets/qtech-chrome.css');
  for (const n of ['qt-sb-collapsed','qt-sb-open','.qt-sb-overlay','.qt-theme-toggle','.mgr-topbar-menu','.qt-legal-card']) {
    assert.ok(chrome.includes(n),'chrome css must define '+n);
  }
  /* the dashboard/inventory stat cards need a dark surface too (§2B "cards") */
  assert.match(chrome,/body\.gx-dark :is\(\.stat-card,\.dash-metric,\.metric\)\{background:#111c2e/);
  assert.match(chrome,/body\.gx-dark :is\(\.stat-info p,\.stat-info span,\.metric p\)\{color:#94a3b8/);
  assert.match(chrome,/body\.gx-dark \.dash-go\{/);
  /* every component class the Agent self-allocation box uses must be styled */
  const ag=read('agent.html');
  const used=[...new Set((ag.match(/qt-sa-[a-z]+/g)||[]))];
  assert.ok(used.length>=3,'the self-allocation alert classes must be in use: '+used.join(','));
  for (const c of used) assert.ok(chrome.includes('.'+c),'§5B the class .'+c+' must be styled in both themes');
  assert.match(chrome,/body\.gx-qtech \.qt-sa-alert\{display:none/);
  assert.match(chrome,/body\.gx-dark\.gx-qtech \.qt-sa-danger\{/);
  assert.match(chrome,/body\.gx-qtech \.ps-group-row>td\{/,'§3F provider group row');
  assert.match(chrome,/body\.gx-dark\.gx-qtech \.ps-group-row>td\{/);
  assert.match(chrome,/body\.gx-dark \.sd-option/,'dark paint for the searchable dropdown widget');
  const qjs=read('assets/qtech.js');
  assert.ok(!/GX\.theme = \{ apply\(\)\{document\.body\.classList\.add\('gx-light'\)/.test(qjs),'qtech.js must not force Light any more');
  assert.match(qjs,/KEY: 'qtech_theme'/);
  assert.match(qjs,/gx-portal-login/,'login pages stay Light');
});
test('Phase-5 §2D/§2E: heading contrast for both themes and one shared Terms dialog',()=>{
  const chrome=read('assets/qtech-chrome.css');
  assert.match(chrome,/body\.gx-qtech :is\(\.page-head,\.head\) :is\(h1,h2,h3\)/);
  assert.match(chrome,/body\.gx-dark\.gx-qtech :is\(\.page-head,\.head\) :is\(h1,h2,h3\)/);
  assert.match(chrome,/\.qt-legal-title/);assert.match(chrome,/\.qt-legal-agree/);
  const js=read('api.js');
  assert.match(js,/Terms and Conditions/);
  assert.match(js,/qt-legal-overlay/);
  assert.match(js,/req\('GET','\/legal\/status'\)/);
  assert.match(js,/req\('POST','\/legal\/accept',\{version:st\.version\}\)/);
  assert.ok(!js.includes("href='/agent/payment'"),'the dead route link must be gone');
  for (const role of ['admin','manager']) {
    const s=read(role+'.html');
    assert.ok(!/can allocate number to only assigned agents/i.test(s),'§2D note removed from '+role);
  }
});
test('Phase-5 §3C/§3D/§3E: admin delete-range, page-only selection and recipient scope',()=>{
  const s=read('admin.html');
  assert.match(s,/renderAdminNumbersDeleteRangeFilter\(\)/);
  assert.match(s,/async function deleteNumbersByRange\(\)[\s\S]{0,700}getElementById\('deleteRangeSelect'\)/);
  assert.match(s,/DELETE RANGE NUMBERS/);
  assert.ok(!/selAllFiltered|selAllIds/.test(s),'the cross-page select-all path must be gone');
  assert.match(s,/function toggleAll\(cb\)/);
  assert.match(s,/selected on this page/);
  assert.ok(!s.includes('aaClient'),'§3E the Client recipient control is removed');
  assert.match(s,/id:'aaTarget'/);
  assert.match(s,/Select Manager \/ Agent/);
  assert.ok(!/users\/client'[\s\S]{0,200}aaTarget/.test(s));
});
test('Phase-5 §4B/§4D/§5B/§5D/§5E/§6B: panel-specific fixes',()=>{
  const m=read('manager.html');
  assert.match(m,/function managerAllocTargets\(\)/);
  assert.match(m,/id: 'aaAgent'/);
  assert.ok(!/openAllocAll[\s\S]{0,1200}clientsData/.test(m.slice(m.indexOf('async function openAllocAll'))),'§4B no client recipients');
  assert.equal((m.match(/async function loadAgents\(/g)||[]).length,1,'§4D one loadAgents definition');
  assert.equal((m.match(/async function loadClients\(/g)||[]).length,1,'§4D one loadClients definition');
  assert.equal((m.match(/function loadManagerPageData\(/g)||[]).length,1,'§4D one page loader');
  assert.match(m,/function mgrOnce\(/);assert.match(m,/mgrTableLoading/);assert.match(m,/mgrTableError/);
  assert.match(m,/mgrLoadSeq/,'§4D stale-response guard');

  const a=read('agent.html');
  assert.ok(!a.includes('<h3>Self Allocation</h3>'),'§5B duplicate section removed');
  assert.ok(!/>View All</.test(a),'§5B no View All link');
  assert.ok((a.match(/openSelfAlloc\(/g)||[]).length>=3,'§5B self-allocation actions kept');
  assert.match(a,/No ranges available for self-allocation yet\./,'§5B concise empty state');
  assert.match(a,/No range is available for self-allocation yet/,'§5B concise modal message');
  assert.equal((a.match(/async function loadClients\(/g)||[]).length,1,'§5D one loadClients definition');
  assert.match(a,/function agtOnce\(/);assert.match(a,/agtLoadClientsPage/);assert.match(a,/agtLoadSeq/);
  assert.match(a,/window\.qtGotoPaymentPage/,'§5E in-panel navigation hook');

  const c=read('client.html');
  assert.ok(!c.includes('Default = today (UK date)'),'§6B hint removed');
  for (const id of ['stGb_day','stGb_month','stGb_range','stGb_number','stGb_cli','stGb_currency']) {
    assert.ok(c.includes(id),'§6B Group By option kept: '+id);
  }

  const cn=read('assets/credit-notes.js');
  assert.match(cn,/cnRefresh/,'§5E explicit refresh control');
  assert.match(cn,/qtGotoPaymentPage/);
  assert.ok(!cn.includes("href='/agent/payment'"));
  assert.match(cn,/read_only|credit-notes\?/);
});
test('Phase-5 §6C: one professional login surface for every entry point',()=>{
  const css=read('assets/qtech.css');
  assert.match(css,/body\.gx-light:is\(\.gx-login,\.gx-portal-login\)/);
  assert.match(css,/linear-gradient\(165deg,#0b1f3d/);
  assert.match(css,/gx-login \.shell\{[^}]*background:#fff/);
  assert.match(css,/login-head h2\{[^}]*color:#0f172a/);
  assert.match(css,/linear-gradient\(180deg,#2563eb,#1d4ed8\)/);
  assert.ok(!css.includes('background:#eaf0fa'),'the old pale card is gone');
  assert.ok(!css.includes('#57b846'),'the old green button is gone');
  const login=read('login.html');
  assert.ok(!login.includes('qtech-layout')&&!login.includes('qtech-chrome')&&!login.includes('gx-qtech'));
  assert.match(login,/class="gx-light gx-login"/);
  assert.match(login,/fetch\('\/api\/login'/);
  assert.match(login,/captchaAnswer/);
});
test('Dark theme layer exists and mirrors every light component family',()=>{
  const css=read('assets/qtech.css');
  assert.match(css,/body\.gx-dark\{/);
  assert.match(css,/--bg:#0b1220;--bg2:#0f172a;--panel:#111c2e/);
  assert.match(css,/body\.gx-dark\.gx-qtech :is\(\.sidebar,\.rail,\.side,\.appbar\)\{background:linear-gradient\(180deg,#0d1728/);
  assert.match(css,/body\.gx-dark\.gx-qtech :is\([^)]*\.sub-item[^)]*\)\.active\{background:#1d4ed8/);
  assert.match(css,/body\.gx-dark \[data-tip\]:hover::after\{background:#e2e8f0!important;color:#0b1220/);
  assert.match(css,/body\.gx-dark :is\(\.btn-blue,\.btn\.blue,\.gx-blue\)/);
  assert.match(css,/body\.gx-dark\.gx-login/);
  /* the light layer must stay light-only so the two themes never fight */
  const light=read('assets/qtech-light.css');
  assert.ok(!/gx-dark/.test(light));
});
test('Appearance switcher is wired in api.js and persists without server writes',()=>{
  const js=read('api.js');
  assert.match(js,/const THEME_KEY='qtech_theme'/);
  assert.match(js,/window\.qtechSetTheme = applyTheme/);
  assert.match(js,/data-theme-btn/);
  assert.match(js,/localStorage\.setItem\(THEME_KEY/);
  assert.doesNotMatch(js,/API\.(post|put)\('\/theme|fetch\('\/api\/theme/);
});
test('Circular logo + button variants + tooltip contrast + button alignment',()=>{
  const css=read('assets/qtech.css');
  assert.match(css,/body :is\(\.sb-logo,\.brand \.logo,\.rail \.logo,\.sb-brand \.logo,\.brand-logo \.logo\)\{border-radius:50%!important;overflow:hidden!important;\}/);
  assert.match(css,/body\.gx-light :is\(\.btn-blue,\.btn\.blue,\.gx-blue\)\{background:linear-gradient/);
  assert.match(css,/body\.gx-light :is\(\.btn-purple,\.btn\.purple,\.gx-purple\)\{background:linear-gradient/);
  assert.match(css,/\[data-tip\]:hover::after\{background:#111827!important;color:#fff!important/);
  assert.match(css,/\.btn\{display:inline-flex;align-items:center;justify-content:center;text-align:center/);
  assert.match(css,/\.exp-btns\{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;\}/);
});
test('SMS CLI Limit page uses the Q TECH component classes (ids/handlers untouched)',()=>{
  const m=read('management.html');
  assert.match(m,/class="card qt-cli-form"/);
  assert.match(m,/class="qt-cli-row"/);
  assert.match(m,/id="climCli"/);assert.match(m,/id="climLimit"/);
  assert.match(m,/onclick="addCliLimit\(\)"/);
  assert.match(m,/id="climBody"/);assert.match(m,/id="climInfo"/);
  /* C3: the explanatory note below the form was removed on request — the
     wording is now the concise UK-time reset sentence in the card subtitle. */
  assert.ok(!m.includes('class="qt-note"'));
  assert.ok(!/UK day boundary/i.test(m));
  assert.match(m,/Daily limit resets at the start of each new day \(UK time\)/);
  const css=read('assets/qtech.css');
  assert.match(css,/\.qt-cli-row\{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;\}/);
  assert.match(css,/@media \(max-width:767px\)\{\s*\.qt-cli-row\{flex-direction:column;align-items:stretch;\}/);
});
test('GCM import page: explanatory lines removed, functionality labels kept',()=>{
  const m=read('management.html');
  assert.ok(!m.includes('Select multiple .txt files. Each file name is used as Range Name'));
  assert.ok(!m.includes('Range is provider se link hogi'));
  assert.ok(!m.includes('Provider (is batch ki sab ranges)'));
  assert.match(m,/id="bulkTxtFiles"[^>]*multiple/);
  assert.match(m,/id="bulkCreateMissingRanges"/);
  assert.match(m,/id="importProvider"/);assert.match(m,/id="bulkImportProvider"/);
  assert.match(m,/onclick="bulkImportTxtFiles\(\)"/);
  /* §3 keep-lines must still be present */
  assert.match(m,/Enter one range name per line\. Existing ranges will be skipped automatically\./);
  assert.match(m,/Nothing is saved until the whole file is validated\./);
  assert.match(m,/Required column: <b>Range Name<\/b>/);
});
console.log(total+' UI presentation contract checks passed.');
