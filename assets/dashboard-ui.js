/* Q TECH SMS dashboard presentation helpers.
 *
 * Presentation only: no writes, no storage, no auth change, no financial
 * calculation. Every value comes from an existing role-scoped GET response
 * (/dashboard or /earnings-summary) exactly as the backend returns it —
 * the module never adds, subtracts or re-labels a rate, cost or payout.
 *
 * Entry points used by admin.html / manager.html / agent.html / client.html:
 *   GXDashboard.cards(id, items)        -> KPI cards from real values
 *   GXDashboard.render(data, role)      -> volume chart + KPI state
 *   GXDashboard.renderEarnings(sum,role)-> earning cards + earning chart
 *   GXDashboard.refreshExtras(role)     -> rankings (+ admin import batches)
 *   GXDashboard.error()                 -> explicit error state
 */
(function () {
  'use strict';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icons = {
    volume: '<path d="M4 20V12h3v8M10 20V7h3v13M16 20V3h3v17"/>',
    numbers: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',
    clients: '<circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5"/>',
    report: '<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 16v-3M12 16v-6M16 16v-4"/>',
    ranges: '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>',
    money: '<circle cx="12" cy="12" r="9"/><path d="M15 8h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9M12 6v12"/>',
    batches: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="3"/>'
  };
  const svg = key => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[key] || icons.volume) + '</svg>';
  const count = value => value == null ? '—' : Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
  /* Existing formatter only — no new rounding/currency rule. */
  function money(value) {
    if (value == null || value === '') return '—';
    return '$ ' + (typeof window.pay3 === 'function' ? window.pay3(value) : String(value));
  }
  function node(tag, className, html) {
    const n = document.createElement(tag); n.className = className;
    if (html) n.innerHTML = html;
    return n;
  }

  /* ------------------------------- KPI cards ------------------------------- */
  function cards(containerId, items) {
    const host = document.getElementById(containerId);
    if (!host) return;
    host.innerHTML = (items || []).map(it => {
      const raw = it.value == null || it.value === '' ? '—' : it.value;
      const shown = it.kind === 'money' ? money(raw) : (/^-?[\d.]+$/.test(String(raw)) ? count(raw) : String(raw));
      const icon = svg(it.icon || (it.kind === 'money' ? 'money' : 'volume'));
      return '<div class="stat-card dash-metric"><div class="stat-info"><p>' + esc(it.label) +
        '</p><h3>' + esc(shown) + '</h3><span>' + esc(it.note || '') + '</span></div><div class="dash-go">' + icon + '</div></div>';
    }).join('');
  }

  /* ------------------------------ Line chart -------------------------------
     Same light card chart for SMS volume and for ledger earning; the caller
     passes the value key and the formatter, nothing else changes. */
  function lineChart(container, rows, opts) {
    const o = opts || {};
    const fmt = typeof o.format === 'function' ? o.format : count;
    const unit = o.unit || 'value';
    if (!container) return;
    const data = Array.isArray(rows) ? rows.filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date))) : [];
    if (!data.length) { container.innerHTML = '<p class="lm-chart-empty">' + esc(o.emptyMessage || 'No data available.') + '</p>'; return; }
    const vals = data.map(r => Number(r[o.valueKey || 'count']) || 0);
    const valid = vals.every(v => Number.isFinite(v) && v >= 0);
    if (!valid) { container.innerHTML = '<p class="lm-chart-empty">Data could not be displayed.</p>'; return; }
    const w = 720, h = 280, left = 62, right = 20, top = 18, bottom = 38;
    const maxVal = Math.max(...vals, 0);
    const step = maxVal <= 1 ? 0.25 : Math.max(1, Math.ceil(maxVal / 4));
    const max = maxVal <= 1 ? Math.max(1, maxVal) : step * 4;
    const x = i => left + i * (w - left - right) / Math.max(1, data.length - 1);
    const y = n => h - bottom - (Number(n) * (h - top - bottom)) / max;
    const points = vals.map((v, i) => x(i) + ',' + y(v)).join(' ');
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const value = max * i / 4, yy = y(value);
      grid += '<line x1="' + left + '" x2="' + (w - right) + '" y1="' + yy + '" y2="' + yy + '" stroke="#e6e6e6"/>' +
        '<text x="' + (left - 10) + '" y="' + (yy + 4) + '" text-anchor="end">' + esc(fmt(Number(value.toFixed(6)))) + '</text>';
    }
    const dots = data.map((r, i) => '<g><line x1="' + x(i) + '" x2="' + x(i) + '" y1="' + top + '" y2="' + (h - bottom) + '" stroke="#f0f0f0"/>' +
      '<circle cx="' + x(i) + '" cy="' + y(vals[i]) + '" r="4" fill="#348eae" tabindex="0" role="img" aria-label="' +
      esc(r.date + ': ' + fmt(vals[i]) + ' ' + unit) + '"><title>' + esc(r.date + ' · ' + fmt(vals[i]) + ' ' + unit) + '</title></circle>' +
      '<text x="' + x(i) + '" y="' + (h - 12) + '" text-anchor="middle">' + esc(String(r.date).slice(5)) + '</text></g>').join('');
    const total = o.total != null && o.total !== '' ? o.total : vals.reduce((a, b) => a + b, 0);
    container.innerHTML = '<div class="lm-volume-total"><strong>' + esc(o.totalText || fmt(total)) + '</strong> ' + esc(o.totalSuffix || unit) + '</div>' +
      '<svg class="lm-volume-svg" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(o.ariaLabel || (unit + ' for the last seven reporting days')) + '">' +
      '<title>' + esc(o.ariaLabel || (unit + '; daily values listed below')) + '</title>' + grid +
      '<polygon points="' + left + ',' + (h - bottom) + ' ' + points + ' ' + x(data.length - 1) + ',' + (h - bottom) + '" fill="#348eae" fill-opacity=".12"/>' +
      '<polyline points="' + points + '" fill="none" stroke="#348eae" stroke-width="2.5"/>' + dots + '</svg>' +
      '<details class="lm-chart-values"><summary>View daily values</summary><table><thead><tr><th>Date (UK)</th><th>' + esc(o.columnLabel || unit) + '</th></tr></thead><tbody>' +
      data.map((r, i) => '<tr><td>' + esc(r.date) + '</td><td>' + esc(fmt(vals[i])) + '</td></tr>').join('') + '</tbody></table></details>';
  }

  function clearError(root) {
    const status = root && root.querySelector('.lm-dashboard-status');
    if (status && status.dataset.gxError === '1') status.remove();
  }

  /* ------------------------------- Dashboard ------------------------------- */
  function render(data, role) {
    const root = document.getElementById('page-dashboard');
    if (!root || !['admin', 'manager', 'agent', 'client'].includes(role)) return;
    root.classList.add('lm-dashboard');
    clearError(root);
    lineChart(root.querySelector('#wk'), (data || {}).daily7, {
      valueKey: 'count', unit: 'SMS', columnLabel: 'SMS',
      total: (data || {}).sms_7d, totalText: count((data || {}).sms_7d), totalSuffix: 'SMS · rolling 7 days',
      ariaLabel: 'Received SMS for the last seven Europe/London reporting days',
      emptyMessage: 'No volume data available.'
    });
    root.querySelectorAll('.dash-metric .dash-go').forEach(el => {
      const card = el.closest('.dash-metric');
      const isMoney = /payout|earning/i.test(card && card.querySelector('.stat-info p') ? card.querySelector('.stat-info p').textContent : '');
      el.innerHTML = svg(isMoney ? 'money' : 'volume');
    });
  }

  /* Earnings: values are the ledger totals returned by /api/earnings-summary. */
  function renderEarnings(summary, role) {
    const root = document.getElementById('page-dashboard');
    if (!root || !summary) return;
    clearError(root);
    cards('gxEarnCards', [
      { label: 'Earning Today', value: summary.earning_daily, note: 'Recorded in the payment ledger today', kind: 'money', icon: 'money' },
      { label: 'Earning This Week', value: summary.earning_week, note: 'Monday-start UK week', kind: 'money', icon: 'money' },
      { label: 'Earning This Month', value: summary.earning_month, note: 'Month to date', kind: 'money', icon: 'money' },
      { label: 'Real Earning', value: summary.earning_all, note: 'Recorded in the payment ledger · all time', kind: 'money', icon: 'money' }
    ]);
    lineChart(root.querySelector('#earnChart'), summary.daily7, {
      valueKey: 'amount', unit: 'earning', columnLabel: 'Earning',
      format: money, total: summary.earning_7d, totalText: money(summary.earning_7d), totalSuffix: '· last 7 UK days',
      ariaLabel: 'Recorded earning for the last seven Europe/London reporting days',
      emptyMessage: 'No earning recorded in this window.'
    });
    void role;
  }

  /* ------------------------- Rankings / admin batches ---------------------- */
  function ensureGroup(root, selector) {
    let group = root.querySelector(selector);
    if (!group) { group = node('div', selector.replace('.', '')); root.append(group); }
    return group;
  }
  function refreshExtras(role) {
    const root = document.getElementById('page-dashboard');
    if (!root || !window.API || !['admin', 'manager', 'agent', 'client'].includes(role)) return;
    let group = root.querySelector('.lm-rankings');
    if (!group) { group = node('div', 'lm-rankings'); root.append(group); }
    const to = API.ukToday();
    const start = new Date(to + 'T00:00:00Z'); start.setUTCDate(start.getUTCDate() - 29);
    const from = start.toISOString().slice(0, 10);
    const dims = role === 'client' ? ['range'] : role === 'admin' ? ['manager', 'range'] : role === 'manager' ? ['agent', 'client'] : ['client', 'range'];
    for (const dim of dims) {
      let card = group.querySelector('[data-dimension="' + dim + '"]');
      if (!card) {
        card = node('section', 'card lm-ranking dash-note-card'); card.dataset.dimension = dim;
        const report = dim === 'range' ? 'rateCard' : dim === 'number' ? 'numbers' : 'stats';
        const href = role === 'client' ? '/client/' + report : '/' + role + '/' + report;
        card.innerHTML = '<div class="card-head"><div><h3>Top ' + (dim === 'client' ? 'Clients' : dim === 'range' ? 'Ranges' : dim === 'agent' ? 'Agents' : 'Managers') +
          ' · 30 Days</h3></div>' +
          '<a class="lm-report-link" href="' + href + '">View report →</a></div><div class="tscroll"><table><thead><tr><th>' +
          (dim === 'client' ? 'Client' : dim === 'range' ? 'Range' : dim === 'agent' ? 'Agent' : 'Manager') + '</th><th>SMS</th><th>Payout</th></tr></thead>' +
          '<tbody><tr><td colspan="3">Loading…</td></tr></tbody></table></div>';
        group.append(card);
      }
      // Part 3.2: Date text and UK Top 5 caption removed per spec — ranking preserved
      var subEl = card.querySelector('.sub'); if(subEl) subEl.remove();
      API.get('/stats-summary/' + dim + '?' + new URLSearchParams({ from, to, sort: 'sms', dir: 'desc' })).then(result => {
        const rows = Array.isArray(result.rows) ? result.rows.slice(0, 5) : [];
        card.querySelector('tbody').innerHTML = rows.map(r => '<tr><td>' + esc(r.key) + '</td><td>' + esc(count(r.sms)) + '</td><td title="' + esc(r.payment) + '">' + esc(money(r.payment)) + '</td></tr>').join('')
          || '<tr><td colspan="3" class="lm-empty">No SMS in this reporting period.</td></tr>';
      }).catch(() => { card.querySelector('tbody').innerHTML = '<tr><td colspan="3" class="lm-empty">Could not load this summary.</td></tr>'; });
    }
    if (role === 'admin') {
      const host = ensureGroup(root, '.lm-batches');
      let table = host.querySelector('tbody');
      if (!table) {
        host.className = 'card lm-batches dash-note-card';
        host.innerHTML = '<div class="card-head"><div><h3>Recent Import Batches</h3></div><a class="lm-report-link" href="/management/import">Manage imports →</a></div><div class="tscroll"><table><thead><tr><th>Batch</th><th>Range</th><th>Inserted</th><th>Skipped</th><th>Status</th></tr></thead><tbody><tr><td colspan="5">Loading…</td></tr></tbody></table></div>';
        table = host.querySelector('tbody');
      }
      API.get('/number-import-batches').then(rows => {
        table.innerHTML = (Array.isArray(rows) ? rows.slice(0, 5) : []).map(r => '<tr><td>' + esc(r.batch_id) + '</td><td>' + esc(r.range_name) + '</td><td>' + esc(count(r.inserted)) + '</td><td>' + esc(count(r.skipped)) + '</td><td>' + esc(r.status) + '</td></tr>').join('')
          || '<tr><td colspan="5" class="lm-empty">No import batches found.</td></tr>';
      }).catch(() => { table.innerHTML = '<tr><td colspan="5" class="lm-empty">Import history could not be loaded.</td></tr>'; });
    }
  }

  function error() {
    const root = document.getElementById('page-dashboard'); if (!root) return;
    let status = root.querySelector('.lm-dashboard-status');
    if (!status) { status = node('div', 'lm-dashboard-status'); root.prepend(status); }
    status.dataset.gxError = '1';
    status.setAttribute('role', 'alert');
    status.classList.add('is-error');
    status.textContent = 'Dashboard data could not be refreshed. Previously displayed values may be out of date. Reload to retry.';
  }
  window.GXDashboard = Object.freeze({ cards, render, renderEarnings, refreshExtras, error });
})();

/* =========================================================================
 * QTDashboard — Q TECH SMS dashboard components (reference-style design).
 *
 * Presentation only: no writes, no storage, no auth change, no financial
 * calculation. Every value comes from an existing role-scoped GET response
 * (/dashboard or /earnings-summary) exactly as the backend returns it —
 * the module never adds, subtracts or re-labels a rate, cost or payout.
 *
 *   QTDashboard.kpiRow(id, items)          -> gradient KPI cards (label, value, sparkline)
 *   QTDashboard.statGroup(id, title, items)-> labelled row of white stat cards
 *   QTDashboard.areaChart(id, opts)        -> smooth area-chart card (real rows)
 *   QTDashboard.money(v)                   -> '$ ' + pay3(v)
 * ========================================================================= */
(function () {
  'use strict';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icons = {
    volume: '<path d="M4 20V12h3v8M10 20V7h3v13M16 20V3h3v17"/>',
    numbers: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',
    clients: '<circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5"/>',
    report: '<path d="M5 3h10l4 4v14H5zM14 3v5h5M8 16v-3M12 16v-6M16 16v-4"/>',
    ranges: '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6"/>',
    money: '<circle cx="12" cy="12" r="9"/><path d="M15 8h-4a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9M12 6v12"/>',
    batches: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="3"/>'
  };
  const svg = key => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[key] || icons.volume) + '</svg>';
  const count = value => value == null || value === '' ? '—' : (Number.isFinite(Number(value)) ? Number(value).toLocaleString() : String(value));
  /* Existing 3-decimal formatter (window.pay3 when the panel provides it). */
  function pay3(v) {
    if (typeof window.pay3 === 'function') return window.pay3(v);
    let s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    const m = s.match(/-?\d+(?:\.\d+)?/); if (!m) return '0';
    const p = m[0].split('.'); if (p.length < 2) return p[0];
    const d = p[1].slice(0, 3).replace(/0+$/, ''); return d ? p[0] + '.' + d : p[0];
  }
  function money(v) { return v == null || v === '' ? '—' : '$ ' + pay3(v); }
  /* Catmull-Rom -> cubic bezier smooth path (chart + sparkline lines). */
  function smooth(pts) {
    if (!pts.length) return '';
    if (pts.length === 1) return 'M' + pts[0].x + ',' + pts[0].y;
    let d = 'M' + pts[0].x.toFixed(2) + ',' + pts[0].y.toFixed(2);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C' + c1x.toFixed(2) + ',' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ',' + c2y.toFixed(2) + ' ' + p2.x.toFixed(2) + ',' + p2.y.toFixed(2);
    }
    return d;
  }
  function sparkSvg(vals) {
    const data = (vals || []).map(Number).filter(v => Number.isFinite(v) && v >= 0);
    if (!data.length) return '';
    const w = 96, h = 40, p = 4;
    const min = Math.min(...data), max = Math.max(...data), span = (max - min) || 1;
    const pts = data.map((v, i) => ({ x: p + i * (w - 2 * p) / Math.max(1, data.length - 1), y: h - p - ((v - min) / span) * (h - 2 * p) }));
    const line = smooth(pts);
    const area = line + ' L ' + pts[pts.length - 1].x.toFixed(2) + ',' + (h - p) + ' L ' + pts[0].x.toFixed(2) + ',' + (h - p) + ' Z';
    return '<svg class="qt-spark" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><path d="' + area + '" fill="#fff" fill-opacity=".18"/><path d="' + line + '" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
  }

  /* --------------------------- gradient KPI row --------------------------- */
  function kpiRow(containerId, items) {
    const host = document.getElementById(containerId); if (!host) return;
    host.className = 'qt-cards';
    host.innerHTML = (items || []).map(it => {
      const shown = it.money ? money(it.value) : count(it.value);
      return '<div class="qt-card qt-' + esc(it.tone || 'indigo') + '"><p class="qt-label">' + esc(it.label) +
        '</p><p class="qt-value">' + esc(shown) + '</p>' + (it.spark ? sparkSvg(it.spark) : '') + '</div>';
    }).join('');
  }

  /* --------------------------- white stat group --------------------------- */
  function statGroup(containerId, title, items) {
    const host = document.getElementById(containerId); if (!host) return;
    host.className = 'qt-group';
    const cards = (items || []).map((it, i) => {
      const shown = it.money ? money(it.value) : count(it.value);
      return '<div class="qt-wcard"><span class="qt-chip c' + ((i % 6) + 1) + '">' + svg(it.icon || 'volume') +
        '</span><span class="qt-wtxt"><p class="qt-label">' + esc(it.label) + '</p><p class="qt-value">' + esc(shown) + '</p></span></div>';
    }).join('');
    host.innerHTML = '<p class="qt-group-title">' + esc(title || '') + '</p><div class="qt-wcards">' + cards + '</div>';
  }

  /* --------------------------- area chart card ---------------------------- */
  function areaChart(containerId, opts) {
    const o = opts || {};
    const host = document.getElementById(containerId); if (!host) return;
    const fmt = o.money ? money : (typeof o.format === 'function' ? o.format : count);
    const color = o.color || '#6d5df6';
    const rows = (Array.isArray(o.rows) ? o.rows : []).filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)));
    const vals = rows.map(r => Number(r[o.valueKey || 'count']) || 0);
    const valid = vals.every(v => Number.isFinite(v) && v >= 0);
    const cardOpen = '<div class="qt-chart-card"><div class="qt-chart-head"><h3>' + esc(o.title || '') +
      '</h3><span class="qt-legend"><i style="background:' + esc(color) + '"></i>' + esc(o.series || '') + '</span></div><div class="qt-chart-body">';
    if (!rows.length || !valid) { host.innerHTML = cardOpen + '<p class="qt-chart-empty">No data available.</p></div></div>'; return; }
    const w = 720, h = 260, left = 58, right = 14, top = 12, bottom = 30;
    const maxVal = Math.max(...vals, 0);
    const step = maxVal <= 1 ? 0.25 : Math.max(1, Math.ceil(maxVal / 4));
    const max = maxVal <= 1 ? Math.max(1, maxVal) : step * 4;
    const X = i => left + i * (w - left - right) / Math.max(1, rows.length - 1);
    const Y = v => h - bottom - (Number(v) * (h - top - bottom)) / max;
    const pts = vals.map((v, i) => ({ x: X(i), y: Y(v) }));
    const line = smooth(pts);
    const area = line + ' L ' + pts[pts.length - 1].x.toFixed(2) + ',' + (h - bottom) + ' L ' + pts[0].x.toFixed(2) + ',' + (h - bottom) + ' Z';
    const gid = 'qtg' + Math.random().toString(36).slice(2, 8);
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const v = max * i / 4, y = Y(v);
      grid += '<line x1="' + left + '" x2="' + (w - right) + '" y1="' + y.toFixed(2) + '" y2="' + y.toFixed(2) + '" stroke="#e9edf3" stroke-dasharray="4 4"/>' +
        '<text x="' + (left - 8) + '" y="' + (y + 4).toFixed(2) + '" text-anchor="end" class="qt-ylab">' + esc(fmt(Number(v.toFixed(6)))) + '</text>';
    }
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const xlab = rows.map((r, i) => {
      const d = new Date(String(r.date) + 'T00:00:00Z');
      return '<text x="' + X(i).toFixed(2) + '" y="' + (h - 8) + '" text-anchor="middle" class="qt-xlab">' +
        esc(String(d.getUTCDate()).padStart(2, '0') + ' ' + (months[d.getUTCMonth()] || '')) + '</text>';
    }).join('');
    const dots = pts.map((p, i) => '<circle cx="' + p.x.toFixed(2) + '" cy="' + p.y.toFixed(2) + '" r="4" fill="#fff" stroke="' + esc(color) +
      '" stroke-width="2" data-i="' + i + '" tabindex="0"><title>' + esc(rows[i].date + ' · ' + fmt(vals[i])) + '</title></circle>').join('');
    host.innerHTML = cardOpen +
      '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(o.ariaLabel || (o.series || 'chart')) + '">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + esc(color) + '" stop-opacity=".28"/><stop offset="1" stop-color="' + esc(color) + '" stop-opacity="0"/></linearGradient></defs>' +
      grid + '<path d="' + area + '" fill="url(#' + gid + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + esc(color) + '" stroke-width="2.5" stroke-linecap="round"/>' +
      xlab + dots + '</svg><div class="qt-tip" role="tooltip"></div></div></div>';
    const tip = host.querySelector('.qt-tip');
    host.querySelectorAll('circle[data-i]').forEach(c => {
      c.addEventListener('mouseenter', () => {
        const i = +c.dataset.i;
        tip.textContent = rows[i].date + ' · ' + fmt(vals[i]);
        tip.style.left = (X(i) / w * 100) + '%';
        tip.style.top = (Y(vals[i]) / h * 100) + '%';
        tip.style.display = 'block';
      });
      c.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
  }

  window.QTDashboard = Object.freeze({ kpiRow, statGroup, areaChart, money });
})();
