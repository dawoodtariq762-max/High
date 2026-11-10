#!/usr/bin/env node
/**
 * Build a populated fixture database for backup testing.
 *
 * The repo's own data/ui.sqlite has the right schema but almost no rows, which
 * makes backup parity tests trivially pass. This copies that schema and fills
 * it with realistic volumes — including bulk data in the tables the reduced
 * backup is supposed to EXCLUDE — so the size reduction and the financial
 * comparisons are actually meaningful.
 *
 *   node tools/make-backup-fixture.js [out.sqlite] [smsRows]
 *
 * Writes only to the output path. Reads data/ui.sqlite. Never touches a live DB.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const OUT = process.argv[2] || '/tmp/qtech-fixture.sqlite';
const SMS_ROWS = parseInt(process.argv[3] || '20000', 10);

const BASE = path.join(__dirname, '..', 'data', 'ui.sqlite');
if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
// data/ui.sqlite runs in WAL mode, so copying the file alone can miss commits
// still sitting in the -wal and yield a corrupt image. VACUUM INTO produces a
// clean, fully checkpointed copy instead.
{
  const baseDb = new Database(BASE, { readonly: true });
  baseDb.exec(`VACUUM INTO '${OUT.replace(/'/g, "''")}'`);
  baseDb.close();
}

const db = new Database(OUT);
db.pragma('journal_mode = WAL');

// deterministic PRNG so runs are comparable
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rnd() * a.length)];

const MONTHS = 8;
const now = Date.now();
const dayMs = 86400000;

console.log('building fixture: ' + OUT + '  (' + SMS_ROWS.toLocaleString() + ' SMS rows)');

db.exec('PRAGMA foreign_keys = OFF');

// Start from empty tables so ids and counts are deterministic.
for (const t of ['sms_records', 'payment_ledger', 'payment_requests_v2', 'sms_daily_stats',
                 'number_history', 'numbers', 'ranges', 'chat_messages', 'smpp_logs',
                 'api_request_logs', 'chat_credentials', 'chat_conversations']) {
  try { db.exec(`DELETE FROM ${t}`); } catch (e) { /* table absent in some schemas */ }
}
try { db.exec("DELETE FROM users WHERE username LIKE 'fx!_%' ESCAPE '!'"); } catch (e) { /* ignore */ }

/* ---------------------------------------------------------------- ranges */
const insRange = db.prepare(
  `INSERT INTO ranges (id, name, prefix, currency, country, provider, payment_type, rate_1_1, memo, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);
const RANGE_IDS = [];
db.transaction(() => {
  for (let i = 1; i <= 10; i++) {
    RANGE_IDS.push(i);
    insRange.run(i, `Range ${i} (${['UK', 'US', 'DE', 'FR', 'ES'][i % 5]})`, `+44${i}`, 'USD',
      pick(['UK', 'US', 'DE', 'FR', 'ES']), `Provider ${(i % 3) + 1}`, i % 2 ? 'weekly' : 'monthly',
      '0.030', 'fixture range', '2026-01-01 00:00:00');
  }
})();

/* --------------------------------------------------------------- numbers */
const NUMBER_COUNT = 500;
const insNum = db.prepare(
  `INSERT INTO numbers (id, range_id, number, prefix, payout, manager_rate, agent_rate, client_rate,
                        manager_id, agent_id, client_id, payterm, imported_at, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
const NUMBER_IDS = [];
db.transaction(() => {
  for (let i = 1; i <= NUMBER_COUNT; i++) {
    NUMBER_IDS.push(i);
    insNum.run(i, RANGE_IDS[i % RANGE_IDS.length], `4477${String(10000000 + i)}`, `+44${i % 10}`,
      (0.008 + (i % 7) * 0.001).toFixed(4), '0.030', '0.020', '0.011',
      23, 24, 25, 'Weekly', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
  }
})();

/* ----------------------------------------------------------------- users */
const insUser = db.prepare(
  `INSERT INTO users (id, username, password, role, name, email, contact, parent_id, active, created_at, payment_type)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`
);
const BCRYPT = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const CLIENT_IDS = [], AGENT_IDS = [], MANAGER_IDS = [];
let uid = 1000;
db.transaction(() => {
  for (let i = 0; i < 5; i++) { MANAGER_IDS.push(uid); insUser.run(uid, `fx_manager_${i}`, BCRYPT, 'manager', `Manager ${i}`, `m${i}@fx.test`, '0300000000', null, 1, '2026-01-01 00:00:00', 'weekly'); uid++; }
  for (let i = 0; i < 15; i++) { AGENT_IDS.push(uid); insUser.run(uid, `fx_agent_${i}`, BCRYPT, 'agent', `Agent ${i}`, `a${i}@fx.test`, '0300000000', MANAGER_IDS[i % 5], 1, '2026-01-01 00:00:00', 'weekly'); uid++; }
  for (let i = 0; i < 40; i++) { CLIENT_IDS.push(uid); insUser.run(uid, `fx_client_${i}`, BCRYPT, 'client', `Client ${i}`, `c${i}@fx.test`, '0300000000', AGENT_IDS[i % 15], i % 9 === 0 ? 0 : 1, '2026-01-01 00:00:00', 'weekly'); uid++; }
})();

/* ----------------------------------------------------------- sms_records */
const insSms = db.prepare(
  `INSERT INTO sms_records (number_id, number, range_id, cli, sender_type, message, otp_code, is_otp,
                            client_id, agent_id, manager_id, is_test, source, payout_rate, payout_amount,
                            received_at, payment_type, limit_reason)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
// A realistic OTP SMS body — this is the bulk the reduced backup drops.
const MSG = 'Your verification code is 482913. It expires in 10 minutes. Do not share this code with anyone, including our support team. If you did not request this, please ignore this message.';
const statsMap = new Map();
db.transaction(() => {
  for (let i = 0; i < SMS_ROWS; i++) {
    const nid = NUMBER_IDS[Math.floor(rnd() * NUMBER_IDS.length)];
    const rid = RANGE_IDS[nid % RANGE_IDS.length];
    const num = `4477${String(10000000 + nid)}`;
    const cli = pick(['QATEST', 'ZOOM', 'ACME', 'BANK', 'SHOP']);
    const agent = AGENT_IDS[Math.floor(rnd() * AGENT_IDS.length)];
    const client = CLIENT_IDS[Math.floor(rnd() * CLIENT_IDS.length)];
    const manager = MANAGER_IDS[AGENT_IDS.indexOf(agent) % MANAGER_IDS.length];
    const rate = (0.008 + (nid % 7) * 0.001).toFixed(4);
    const when = new Date(now - Math.floor(rnd() * MONTHS * 30 * dayMs));
    const dateStr = when.toISOString().slice(0, 19).replace('T', ' ');
    const test = rnd() < 0.02 ? 1 : 0;
    insSms.run(nid, num, rid, cli, 'alphanumeric_sender', MSG, String(100000 + Math.floor(rnd() * 899999)), 1,
      client, agent, manager, test, 'carrier', rate, rate, dateStr, 'weekly', '');
    const key = `${when.toISOString().slice(0, 10)}|${manager}|${agent}|${client}|${cli}`;
    const cur = statsMap.get(key) || { n: 0, p: 0 };
    cur.n += 1; cur.p += Number(rate);
    statsMap.set(key, cur);
  }
})();
console.log('  sms_records: ' + SMS_ROWS.toLocaleString());

/* -------------------------------------------------------- payment ledger */
const smsIds = db.prepare('SELECT id, agent_id, manager_id, range_id, payout_amount, received_at FROM sms_records').all();
const insLedger = db.prepare(
  `INSERT INTO payment_ledger (sms_record_id, agent_id, manager_id, range_id, payment_type, amount,
                               earned_at, cycle_key, eligible_at, status, request_id, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
);
db.transaction(() => {
  for (const r of smsIds) {
    insLedger.run(r.id, r.agent_id, r.manager_id, r.range_id, 'weekly', r.payout_amount,
      r.received_at, r.received_at.slice(0, 10), r.received_at,
      rnd() < 0.6 ? 'paid' : (rnd() < 0.5 ? 'open' : 'requested'),
      null, r.received_at);
  }
})();
console.log('  payment_ledger: ' + smsIds.length.toLocaleString());

/* ---------------------------------------------------- payment requests */
const insReq = db.prepare(
  `INSERT INTO payment_requests_v2 (agent_id, manager_id, payment_type, amount, wallet_address, status,
                                    requested_at, paid_at, rejected_at, processed_by, txid, created_at, binance_uid)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
const STATUSES = ['Paid', 'Pending', 'Rejected'];
let paid = 0, pending = 0, rejected = 0;
db.transaction(() => {
  for (let i = 0; i < 60; i++) {
    const st = STATUSES[i % 3];
    const amt = (50 + rnd() * 950).toFixed(2);
    if (st === 'Paid') paid += Number(amt);
    else if (st === 'Pending') pending += Number(amt);
    else rejected += Number(amt);
    const when = new Date(now - Math.floor(rnd() * MONTHS * 30 * dayMs)).toISOString().slice(0, 19).replace('T', ' ');
    insReq.run(AGENT_IDS[i % AGENT_IDS.length], MANAGER_IDS[i % 5], 'weekly', amt,
      'TQn9' + String(1000000000 + i), st, when,
      st === 'Paid' ? when : null, st === 'Rejected' ? when : null,
      st === 'Pending' ? null : 1, st === 'Paid' ? '0x' + String(100000 + i) : '', when, '');
  }
})();
console.log(`  payment_requests_v2: 60  (paid=${paid.toFixed(2)} pending=${pending.toFixed(2)} rejected=${rejected.toFixed(2)})`);

/* ------------------------------------------------------- daily stats */
const insStats = db.prepare(
  `INSERT OR REPLACE INTO sms_daily_stats (stat_date, manager_id, agent_id, client_id, cli, sms_count, payout_sum)
   VALUES (?,?,?,?,?,?,?)`
);
db.transaction(() => {
  for (const [key, v] of statsMap) {
    const [d, m, a, c, cli] = key.split('|');
    insStats.run(d, Number(m), Number(a), Number(c), cli, v.n, v.p);
  }
})();
console.log('  sms_daily_stats: ' + statsMap.size.toLocaleString());

/* ------------------------------------------------- bulk in EXCLUDED tables */
// Realistic bulk in tables the reduced backup must drop. This is what makes the
// size comparison meaningful rather than an artefact of an empty database.
const insChat = db.prepare(
  `INSERT INTO chat_messages (id, conversation_id, sender_id, body, created_at) VALUES (?,?,?,?,?)`
);
const CHAT_MSG = 'Thanks, the batch looks good. Please confirm the allocation for range 4 when you get a moment and let me know if any numbers failed.';
db.transaction(() => {
  for (let i = 0; i < 20000; i++) {
    insChat.run(i + 100, 1, 1000 + (i % 60), CHAT_MSG + ' #' + i, new Date(now - Math.floor(rnd() * MONTHS * 30 * dayMs)).toISOString());
  }
})();
console.log('  chat_messages: 20,000 (excluded bulk)');

const insSmpp = db.prepare(
  `INSERT INTO smpp_logs (id, connection_id, connection_name, event, level, detail, peer, created_at)
   VALUES (?,?,?,?,?,?,?,?)`
);
db.transaction(() => {
  for (let i = 0; i < 20000; i++) {
    insSmpp.run(i + 100, 1, 'fx-conn', pick(['bind', 'submit', 'deliver', 'error', 'reconnect']),
      pick(['info', 'info', 'warn', 'error']),
      'sequence_number=12345 source_addr=447700900001 destination_addr=447700900002 short_message=fixture log entry number ' + i,
      '10.0.0.1:2775', new Date(now - Math.floor(rnd() * MONTHS * 30 * dayMs)).toISOString());
  }
})();
console.log('  smpp_logs: 20,000 (excluded bulk)');

const insApi = db.prepare(
  `INSERT INTO api_request_logs (id, credential_id, user_id, endpoint, ip, status_code, error, created_at)
   VALUES (?,?,?,?,?,?,?,?)`
);
db.transaction(() => {
  for (let i = 0; i < 10000; i++) {
    insApi.run(i + 100, 1, AGENT_IDS[i % AGENT_IDS.length], '/api/v1/numbers',
      '10.0.0.' + (i % 254), 200, '', new Date(now - Math.floor(rnd() * MONTHS * 30 * dayMs)).toISOString());
  }
})();
console.log('  api_request_logs: 10,000 (excluded bulk)');

const insNumberHistory = db.prepare(
  `INSERT INTO number_history (number_id, number, action, from_owner, to_owner, details, user_id, created_at)
   VALUES (?,?,?,?,?,?,?,?)`
);
db.transaction(() => {
  for (let i = 0; i < 20000; i++) {
    insNumberHistory.run(NUMBER_IDS[i % NUMBER_IDS.length], `4477${String(10000000 + (i % NUMBER_IDS.length))}`,
      'allocate', 'admin', 'agent', 'fixture allocation event ' + i, 1,
      new Date(now - Math.floor(rnd() * MONTHS * 30 * dayMs)).toISOString());
  }
})();
console.log('  number_history: 20,000 (excluded bulk)');

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
db.close();

console.log('\nfixture ready: ' + OUT);
console.log('  size: ' + fs.statSync(OUT).size.toLocaleString() + ' bytes');
console.log('\nverify with:');
console.log('  node tools/verify-backup-reduced.js ' + OUT);
