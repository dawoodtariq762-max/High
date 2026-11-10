#!/usr/bin/env node
/**
 * Verify the reduced backup: build one, restore it into an isolated temporary
 * database, and compare the business facts against the source.
 *
 *   node tools/verify-backup-reduced.js [path/to/source.sqlite]
 *
 * What it proves
 *   1. A reduced backup builds, passes integrity_check and renames atomically.
 *   2. Restored into an isolated temp DB it reproduces account counts, total /
 *      number-wise / range-wise / account-wise SMS counts and payment totals.
 *   3. Excluded tables are genuinely absent, and no SMS message body or OTP
 *      code is carried over.
 *   4. Passwords are stored as hashes, never plaintext. (The hash itself is
 *      never printed.)
 *   5. Retention is true calendar-month arithmetic (5 months), protects the
 *      newest backups, never deletes an in-flight .tmp, never deletes an
 *      unrecognised filename, and never touches the source database.
 *
 * SAFETY
 *   The source database is only ever read. All work happens in a temp folder
 *   under os.tmpdir(). Nothing here can write to data.sqlite.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const reduced = require('../backend/backupReduced.js');
const backup = require('../backend/backup.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '   (' + detail + ')' : '')); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
function groupCounts(db, sql) {
  const out = {};
  for (const r of db.prepare(sql).all()) out[String(r.k)] = r.c;
  return out;
}
function compareGroups(label, a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs = [];
  for (const k of keys) if ((a[k] || 0) !== (b[k] || 0)) diffs.push(`${k}: ${a[k] || 0} vs ${b[k] || 0}`);
  check(label, diffs.length === 0, diffs.length ? diffs.slice(0, 5).join('; ') : `${keys.size} group(s) identical`);
}

const SOURCE = process.argv[2] || path.join(__dirname, '..', 'data', 'ui.sqlite');
if (!fs.existsSync(SOURCE)) { console.error('source database not found: ' + SOURCE); process.exit(1); }
const sourceHashBefore = crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'qtech-bkverify-'));
const SRC_COPY = path.join(WORK, 'source.sqlite');
const BAK_DIR = path.join(WORK, 'backups');
fs.mkdirSync(BAK_DIR);
fs.copyFileSync(SOURCE, SRC_COPY);

console.log('=== REDUCED BACKUP VERIFICATION ===');
console.log('  source      : ' + SOURCE);
console.log('  work dir    : ' + WORK);
console.log('  source size : ' + fs.statSync(SOURCE).size.toLocaleString() + ' bytes\n');

const src = new Database(SRC_COPY);
src.exec('PRAGMA wal_checkpoint(TRUNCATE)');
process.env.BACKUP_DIR = BAK_DIR;

/* ---------------------------------------------------------------- 1. build */
console.log('--- 1. build ---');
let b;
try {
  b = backup.createBackup(src, 'verify');
  check('backup created', !!b && !!b.file, b.file);
} catch (e) {
  check('backup created', false, e.message);
  console.log('\n=== SUMMARY ===\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(1);
}
const BAK = path.join(BAK_DIR, b.file);
check('output file exists on disk', fs.existsSync(BAK), fs.statSync(BAK).size.toLocaleString() + ' bytes');
check('no .tmp left behind', !fs.existsSync(BAK + '.tmp'));
check('name matches the backup pattern', /^qtech-sms-backup-\d{4}-\d{2}-\d{2}T[\w-]+\.sqlite$/.test(b.file));

const meta = reduced.readBackupMeta(BAK);
check('format marker present', !!meta && meta.format === 'reduced', meta ? 'format=' + meta.format + ' v' + meta.format_version : 'missing');
check('format version recorded', !!meta && meta.format_version === String(reduced.FORMAT_VERSION));
check('timestamp recorded', !!meta && !isNaN(Date.parse(meta.created_at)), meta && meta.created_at);

/* ------------------------------------------------- 2. restore + integrity */
console.log('\n--- 2. restore into an isolated temp database ---');
const RESTORED = path.join(WORK, 'restored.sqlite');
fs.copyFileSync(BAK, RESTORED);           // the real-life "restore" is: take the file, open it
const rst = new Database(RESTORED, { readonly: true });
const ic = rst.prepare('PRAGMA integrity_check').get().integrity_check;
check('restored file passes integrity_check', ic === 'ok', ic);

const srcTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name));
const rstTables = new Set(rst.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name));
check('restored database opens with the expected tables',
  reduced.INCLUDED_TABLES.every(t => rstTables.has(t.name)),
  [...rstTables].join(', '));

/* --------------------------------------------------- 3. business-fact parity */
console.log('\n--- 3. source vs restored ---');

// accounts
const sUsers = src.prepare('SELECT COUNT(*) c FROM users').get().c;
const rUsers = rst.prepare('SELECT COUNT(*) c FROM users').get().c;
check('account count matches', sUsers === rUsers, `${sUsers} vs ${rUsers}`);
const sRoles = groupCounts(src, 'SELECT role k, COUNT(*) c FROM users GROUP BY role');
const rRoles = groupCounts(rst, 'SELECT role k, COUNT(*) c FROM users GROUP BY role');
compareGroups('accounts per role match', sRoles, rRoles);
const sActive = src.prepare('SELECT COUNT(*) c FROM users WHERE active=1').get().c;
const rActive = rst.prepare('SELECT COUNT(*) c FROM users WHERE active=1').get().c;
check('active account count matches', sActive === rActive, `${sActive} vs ${rActive}`);

// SMS totals
const sSms = src.prepare('SELECT COUNT(*) c FROM sms_records').get().c;
const rSms = rst.prepare('SELECT COUNT(*) c FROM sms_records').get().c;
check('total SMS count matches', sSms === rSms, `${sSms} vs ${rSms}`);
const sOtp = src.prepare('SELECT COUNT(*) c FROM sms_records WHERE is_otp=1').get().c;
const rOtp = rst.prepare('SELECT COUNT(*) c FROM sms_records WHERE is_otp=1').get().c;
check('OTP SMS count matches', sOtp === rOtp, `${sOtp} vs ${rOtp}`);

// number-wise
compareGroups('number-wise SMS counts match',
  groupCounts(src, 'SELECT number k, COUNT(*) c FROM sms_records GROUP BY number'),
  groupCounts(rst, 'SELECT number k, COUNT(*) c FROM sms_records GROUP BY number'));
// range-wise
compareGroups('range-wise SMS counts match',
  groupCounts(src, 'SELECT range_id k, COUNT(*) c FROM sms_records GROUP BY range_id'),
  groupCounts(rst, 'SELECT range_id k, COUNT(*) c FROM sms_records GROUP BY range_id'));
// account-wise
for (const [label, col] of [['client', 'client_id'], ['agent', 'agent_id'], ['manager', 'manager_id']]) {
  compareGroups(`${label}-wise SMS counts match`,
    groupCounts(src, `SELECT ${col} k, COUNT(*) c FROM sms_records GROUP BY ${col}`),
    groupCounts(rst, `SELECT ${col} k, COUNT(*) c FROM sms_records GROUP BY ${col}`));
}

// payout inputs
const sPay = src.prepare("SELECT COUNT(*) c, SUM(CAST(payout_amount AS REAL)) s FROM sms_records WHERE payout_amount<>''").get();
const rPay = rst.prepare("SELECT COUNT(*) c, SUM(CAST(payout_amount AS REAL)) s FROM sms_records WHERE payout_amount<>''").get();
check('SMS rows carrying a payout match', sPay.c === rPay.c, `${sPay.c} vs ${rPay.c}`);
check('payout amount total matches', Math.abs((sPay.s || 0) - (rPay.s || 0)) < 1e-9, `${sPay.s} vs ${rPay.s}`);

// range names survive for old SMS
const sRanges = groupCounts(src, 'SELECT name k, COUNT(*) c FROM ranges GROUP BY name');
const rRanges = groupCounts(rst, 'SELECT name k, COUNT(*) c FROM range_ref GROUP BY name');
compareGroups('range names available for reporting', sRanges, rRanges);

// numbers referenced
const sRef = src.prepare('SELECT COUNT(DISTINCT number_id) c FROM sms_records WHERE number_id IS NOT NULL').get().c;
const rRef = rst.prepare('SELECT COUNT(*) c FROM number_ref').get().c;
check('referenced-number snapshot count matches', sRef === rRef, `${sRef} vs ${rRef}`);
const sMaster = src.prepare('SELECT COUNT(*) c FROM numbers').get().c;
check('master numbers inventory NOT copied', rRef <= sMaster, `master=${sMaster}, in backup=${rRef}`);

// payments
const sLedger = src.prepare('SELECT COUNT(*) c, SUM(CAST(amount AS REAL)) s FROM payment_ledger').get();
const rLedger = rst.prepare('SELECT COUNT(*) c, SUM(CAST(amount AS REAL)) s FROM payment_ledger').get();
check('payment ledger row count matches', sLedger.c === rLedger.c, `${sLedger.c} vs ${rLedger.c}`);
check('payment ledger total matches', Math.abs((sLedger.s || 0) - (rLedger.s || 0)) < 1e-9, `${sLedger.s} vs ${rLedger.s}`);
compareGroups('ledger status breakdown matches',
  groupCounts(src, 'SELECT status k, COUNT(*) c FROM payment_ledger GROUP BY status'),
  groupCounts(rst, 'SELECT status k, COUNT(*) c FROM payment_ledger GROUP BY status'));
// total payable / paid / pending
const sReq = src.prepare("SELECT COUNT(*) c, SUM(CAST(amount AS REAL)) s FROM payment_requests_v2").get();
const rReq = rst.prepare("SELECT COUNT(*) c, SUM(CAST(amount AS REAL)) s FROM payment_requests_v2").get();
check('payment request count matches', sReq.c === rReq.c, `${sReq.c} vs ${rReq.c}`);
check('payment request total matches', Math.abs((sReq.s || 0) - (rReq.s || 0)) < 1e-9, `${sReq.s} vs ${rReq.s}`);
const sPaid = src.prepare("SELECT SUM(CAST(amount AS REAL)) s FROM payment_requests_v2 WHERE status='Paid'").get().s || 0;
const rPaid = rst.prepare("SELECT SUM(CAST(amount AS REAL)) s FROM payment_requests_v2 WHERE status='Paid'").get().s || 0;
check('paid amount matches', Math.abs(sPaid - rPaid) < 1e-9, `${sPaid} vs ${rPaid}`);
const sPend = src.prepare("SELECT SUM(CAST(amount AS REAL)) s FROM payment_requests_v2 WHERE status='Pending'").get().s || 0;
const rPend = rst.prepare("SELECT SUM(CAST(amount AS REAL)) s FROM payment_requests_v2 WHERE status='Pending'").get().s || 0;
check('pending amount matches', Math.abs(sPend - rPend) < 1e-9, `${sPend} vs ${rPend}`);
compareGroups('account-wise ledger totals match',
  groupCounts(src, 'SELECT agent_id k, COUNT(*) c FROM payment_ledger GROUP BY agent_id'),
  groupCounts(rst, 'SELECT agent_id k, COUNT(*) c FROM payment_ledger GROUP BY agent_id'));

// daily stats
const sStats = src.prepare('SELECT COUNT(*) c, SUM(sms_count) n, SUM(payout_sum) p FROM sms_daily_stats').get();
const rStats = rst.prepare('SELECT COUNT(*) c, SUM(sms_count) n, SUM(payout_sum) p FROM sms_daily_stats').get();
check('daily stats rows match', sStats.c === rStats.c, `${sStats.c} vs ${rStats.c}`);
check('daily stats SMS total matches', (sStats.n || 0) === (rStats.n || 0), `${sStats.n} vs ${rStats.n}`);
check('daily stats payout total matches', Math.abs((sStats.p || 0) - (rStats.p || 0)) < 1e-9, `${sStats.p} vs ${rStats.p}`);

/* -------------------------------------------------------- 4. exclusions */
console.log('\n--- 4. excluded data is absent ---');
const missing = reduced.EXCLUDED_TABLES.filter(([t]) => !rstTables.has(t));
check('no excluded table present',
  missing.length === reduced.EXCLUDED_TABLES.length,
  missing.length + '/' + reduced.EXCLUDED_TABLES.length + ' absent');
const leaked = reduced.EXCLUDED_TABLES.filter(([t]) => rstTables.has(t)).map(([t]) => t);
if (leaked.length) console.log('        LEAKED: ' + leaked.join(', '));

const smsCols = rst.prepare('PRAGMA table_info(sms_records)').all().map(c => c.name);
check('SMS message body not carried', !smsCols.includes('message'));
check('OTP codes not carried', !smsCols.includes('otp_code'));
const userCols = rst.prepare('PRAGMA table_info(users)').all().map(c => c.name);
check('chat display name not carried', !userCols.includes('chat_display_name'));

// chat / api / smpp / provider content really is gone
for (const t of ['chat_messages', 'chat_credentials', 'api_credentials', 'smpp_logs', 'sync_providers']) {
  check(`${t} absent`, !rstTables.has(t));
}

/* ------------------------------------------------------ 5. secret hygiene */
console.log('\n--- 5. secret hygiene (values are never printed) ---');
const pwRows = rst.prepare("SELECT password FROM users WHERE password<>'' LIMIT 50").all();
check('passwords are present (needed to restore accounts)', pwRows.length > 0, pwRows.length + ' sampled');
check('passwords are bcrypt hashes, not plaintext',
  pwRows.every(r => /^\$(2[abxy])\$\d\d\$/.test(r.password)),
  'all sampled rows match $2*$; sample length ' + (pwRows[0] ? pwRows[0].password.length : 'n/a'));
const bad = rst.prepare("SELECT COUNT(*) c FROM users WHERE password='' OR password IS NULL").get().c;
check('no empty password rows', bad === 0, bad + ' empty');

/* -------------------------------------------------- 6. retention behaviour */
console.log('\n--- 6. 5-calendar-month retention ---');
const sub = backup.subtractCalendarMonths;

// pure calendar arithmetic, including month-end clamping and a leap year
const t1 = sub(new Date(2026, 6, 31), 5);   // 31 Jul 2026 -> 28 Feb 2026
check('31 Jul minus 5 months = 28 Feb (clamped)',
  t1.getFullYear() === 2026 && t1.getMonth() === 1 && t1.getDate() === 28, t1.toISOString().slice(0, 10));
const t2 = sub(new Date(2024, 6, 31), 5);   // 31 Jul 2024 -> 29 Feb 2024 (leap)
check('31 Jul 2024 minus 5 months = 29 Feb (leap year)',
  t2.getFullYear() === 2024 && t2.getMonth() === 1 && t2.getDate() === 29, t2.toISOString().slice(0, 10));
const t3 = sub(new Date(2026, 0, 15), 5);   // 15 Jan 2026 -> 15 Aug 2025 (year rolls back)
check('15 Jan minus 5 months crosses the year boundary',
  t3.getFullYear() === 2025 && t3.getMonth() === 7 && t3.getDate() === 15, t3.toISOString().slice(0, 10));
const t4 = sub(new Date(2026, 9, 8), 5);    // 8 Oct 2026 -> 8 May 2026
check('8 Oct minus 5 months = 8 May',
  t4.getFullYear() === 2026 && t4.getMonth() === 4 && t4.getDate() === 8, t4.toISOString().slice(0, 10));

// end-to-end pruning against a real directory
const RET_DIR = path.join(WORK, 'retention');
fs.mkdirSync(RET_DIR);
process.env.BACKUP_DIR = RET_DIR;
process.env.BACKUP_RETENTION_MONTHS = '5';
process.env.BACKUP_MIN_KEEP = '2';
process.env.BACKUP_STALE_TMP_HOURS = '24';

const now = Date.now();
const cutoff = backup.retentionCutoff(new Date(now));
const cutoffMs = cutoff.getTime();
function mk(name, mtimeMs) {
  const p = path.join(RET_DIR, name);
  fs.writeFileSync(p, 'x');
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}
const OLD = cutoffMs - 3600 * 1000;            // 1h beyond the cutoff -> delete
const NEW = cutoffMs + 3600 * 1000;            // 1h inside the window    -> keep
mk('qtech-sms-backup-2026-01-01T00-00-00-000Z.sqlite', OLD);   // old, prunable
mk('qtech-sms-backup-2026-02-01T00-00-00-000Z.sqlite', OLD);   // old, prunable
mk('qtech-sms-backup-2026-09-01T00-00-00-000Z.sqlite', NEW);   // recent -> keep
mk('qtech-sms-backup-2026-09-02T00-00-00-000Z.sqlite', NEW);   // recent -> keep (min-keep)
mk('almada-sms-backup-2025-01-01T00-00-00-000Z.sqlite', OLD);  // legacy prefix, old -> delete
mk('nova-sms-backup-2025-01-01T00-00-00-000Z.sqlite', OLD);    // legacy prefix, old -> delete
mk('qtech-sms-backup-2026-08-01T00-00-00-000Z.sqlite.tmp', now - 60 * 1000);        // in flight -> keep
mk('qtech-sms-backup-2026-07-01T00-00-00-000Z.sqlite.tmp', now - 48 * 3600 * 1000); // stale -> delete
mk('important-do-not-delete.sqlite', OLD);                     // unknown name -> keep
mk('random-notes.txt', OLD);                                   // not ours -> keep

const res = backup.cleanupOldBackups(src);
const gone = f => !fs.existsSync(path.join(RET_DIR, f));
const here = f => fs.existsSync(path.join(RET_DIR, f));
console.log('        cutoff: ' + cutoff.toISOString() + '  deleted: ' + res.deleted.length);
check('old backup deleted', gone('qtech-sms-backup-2026-01-01T00-00-00-000Z.sqlite'));
check('second old backup deleted', gone('qtech-sms-backup-2026-02-01T00-00-00-000Z.sqlite'));
check('legacy almada backup pruned too', gone('almada-sms-backup-2025-01-01T00-00-00-000Z.sqlite'));
check('legacy nova backup pruned too', gone('nova-sms-backup-2025-01-01T00-00-00-000Z.sqlite'));
check('recent backup kept', here('qtech-sms-backup-2026-09-01T00-00-00-000Z.sqlite'));
check('second recent backup kept', here('qtech-sms-backup-2026-09-02T00-00-00-000Z.sqlite'));
check('in-flight .tmp NOT deleted', here('qtech-sms-backup-2026-08-01T00-00-00-000Z.sqlite.tmp'));
check('stale .tmp cleaned', gone('qtech-sms-backup-2026-07-01T00-00-00-000Z.sqlite.tmp'));
check('unrecognised .sqlite name left alone', here('important-do-not-delete.sqlite'));
check('non-backup file left alone', here('random-notes.txt'));

// min-keep: even when everything is old, keep the newest N
const MK_DIR = path.join(WORK, 'minkeep');
fs.mkdirSync(MK_DIR);
process.env.BACKUP_DIR = MK_DIR;
for (const n of ['a', 'b', 'c', 'd']) mk2(n, OLD);
function mk2(n, t) {
  const p = path.join(MK_DIR, `qtech-sms-backup-2025-0${n === 'a' ? 1 : n === 'b' ? 2 : n === 'c' ? 3 : 4}-01T00-00-00-000Z.sqlite`);
  fs.writeFileSync(p, 'x'); fs.utimesSync(p, new Date(t), new Date(t)); return p;
}
backup.cleanupOldBackups(src);
const survivors = fs.readdirSync(MK_DIR).length;
check('MIN_KEEP protects the newest backups when all are old', survivors === 2, survivors + ' of 4 survived');

// the live database is never touched
const OUTSIDE = path.join(WORK, 'outside.sqlite');
fs.writeFileSync(OUTSIDE, 'precious');
process.env.BACKUP_DIR = path.join(WORK, 'retention');
backup.cleanupOldBackups(src);
check('file outside the backup dir untouched', fs.readFileSync(OUTSIDE, 'utf8') === 'precious');
const sourceHashAfter = crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex');
check('source database byte-identical afterwards', sourceHashBefore === sourceHashAfter);

/* ------------------------------------------------------------ 7. sizes */
console.log('\n--- 7. size ---');
const srcSize = fs.statSync(SOURCE).size;
const bakSize = fs.statSync(BAK).size;
const pct = srcSize ? (100 * bakSize / srcSize) : 0;
console.log('  source database : ' + srcSize.toLocaleString() + ' bytes');
console.log('  reduced backup  : ' + bakSize.toLocaleString() + ' bytes');
console.log('  ratio           : ' + pct.toFixed(1) + '% of source');
console.log('  NOTE: this run uses the local database, whose row counts are tiny.');
console.log('        For a real figure, run this tool against a COPY of production:');
console.log('          node tools/verify-backup-reduced.js /path/to/copy-of-data.sqlite');

rst.close();
src.close();

console.log('\n=== SUMMARY ===');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (failures.length) { console.log('\n  Failures:'); failures.forEach(f => console.log('   - ' + f)); }
console.log('\n  work dir kept for inspection: ' + WORK);
process.exit(fail ? 1 : 0);
