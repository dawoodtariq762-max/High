/**
 * Reduced (essential-records) backup builder for ZOOM SMS.
 * =============================================================================
 * WHY THIS EXISTS
 *   The previous backup was `VACUUM INTO`, i.e. a byte-complete copy of the
 *   whole database, taken every BACKUP_INTERVAL_HOURS and kept for
 *   BACKUP_RETENTION_DAYS. At 3h/30d that is ~240 concurrent full copies;
 *   on a ~380 MB database that is the ~91 GB that filled the VPS disk.
 *
 *   Business continuity does not need all of it. It needs users, SMS records
 *   (for counts by number / range / account / date, and historical payout
 *   inputs) and the payment history. Everything else — chat, API, SMPP,
 *   providers, the numbers/ranges master inventory, logs — is either
 *   reconstructible, operational, or explicitly out of scope.
 *
 * HOW IT WORKS (and why it is safe on a nearly-full disk)
 *   This does NOT use VACUUM INTO and does NOT make a second copy of the
 *   source database. It ATTACHes a brand-new, empty database file and copies
 *   only the chosen columns with `INSERT ... SELECT`, streaming rows straight
 *   to disk. Peak extra disk use is the size of the reduced output, not the
 *   size of the live database.
 *
 * CONSISTENCY
 *   All reads run inside a single transaction on the source, so the copy is a
 *   consistent snapshot even while SMS ingestion and provider sync are
 *   writing. WAL is checkpointed first so the snapshot starts from a clean
 *   state.
 *
 * SAFETY
 *   - Writes to <file>.tmp, validates, then atomically renames.
 *   - The live database is only ever read. Nothing here can modify it.
 *   - The output carries a `backup_meta` table marking it as format
 *     "reduced". backend/backup.js refuses to restore such a file over the
 *     live database, because a reduced backup has no numbers/ranges/providers
 *     and would destroy a running system.
 * =============================================================================
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/* Bump FORMAT_VERSION whenever INCLUDED_TABLES, a column list or the DDL below
   changes, so a restore/verify tool can tell generations apart. */
const FORMAT = 'reduced';
const FORMAT_VERSION = 1;

/* -----------------------------------------------------------------------------
 * Single source of truth: what is copied and what is deliberately left out.
 *
 * `ddl`     - the table as it is created in the backup.
 * `select`  - the exact column list read from the source (order must match ddl).
 * `from`    - source table.
 * `where`   - optional row filter.
 * `indexes` - optional, created after the copy so the archive is reportable.
 * -------------------------------------------------------------------------- */
const INCLUDED_TABLES = [
  {
    name: 'users',
    note: 'Accounts: IDs, username, bcrypt password hash, role, ownership (parent_id) and contact identity.',
    ddl: `CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            password TEXT NOT NULL,
            role TEXT NOT NULL,
            name TEXT DEFAULT '',
            email TEXT DEFAULT '',
            whatsapp TEXT DEFAULT '',
            contact TEXT DEFAULT '',
            skype TEXT DEFAULT '',
            parent_id INTEGER,
            active INTEGER DEFAULT 1,
            created_at TEXT,
            payment_type TEXT DEFAULT 'weekly',
            is_super_manager INTEGER DEFAULT 0
          )`,
    select: 'id, username, password, role, name, email, whatsapp, contact, skype, parent_id, active, created_at, payment_type, is_super_manager',
    from: 'users',
  },
  {
    name: 'range_ref',
    note: 'Minimal range identity so old SMS can still be reported by range name. Rates/config excluded.',
    ddl: `CREATE TABLE range_ref (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            prefix TEXT DEFAULT '',
            country TEXT DEFAULT '',
            provider TEXT DEFAULT '',
            currency TEXT DEFAULT 'USD',
            payment_type TEXT DEFAULT 'weekly'
          )`,
    select: 'id, name, prefix, country, provider, currency, payment_type',
    from: 'ranges',
  },
  {
    name: 'number_ref',
    note: 'Only numbers actually referenced by a retained SMS record — not the full inventory.',
    ddl: `CREATE TABLE number_ref (
            id INTEGER PRIMARY KEY,
            number TEXT NOT NULL,
            range_id INTEGER,
            prefix TEXT DEFAULT ''
          )`,
    select: 'id, number, range_id, prefix',
    from: 'numbers',
    where: 'id IN (SELECT DISTINCT number_id FROM sms_records WHERE number_id IS NOT NULL)',
  },
  {
    name: 'sms_records',
    note: 'SMS history. `message` and `otp_code` are intentionally NOT copied (see header).',
    ddl: `CREATE TABLE sms_records (
            id INTEGER PRIMARY KEY,
            number_id INTEGER,
            number TEXT,
            range_id INTEGER,
            cli TEXT DEFAULT '',
            sender_type TEXT DEFAULT '',
            is_otp INTEGER DEFAULT 1,
            client_id INTEGER,
            agent_id INTEGER,
            manager_id INTEGER,
            is_test INTEGER DEFAULT 0,
            test_batch_id TEXT DEFAULT '',
            source TEXT DEFAULT 'carrier',
            payout_rate TEXT DEFAULT '',
            payout_amount TEXT DEFAULT '',
            received_at TEXT,
            payment_type TEXT DEFAULT '',
            limit_reason TEXT DEFAULT ''
          )`,
    select: 'id, number_id, number, range_id, cli, sender_type, is_otp, client_id, agent_id, manager_id, is_test, test_batch_id, source, payout_rate, payout_amount, received_at, payment_type, limit_reason',
    from: 'sms_records',
    indexes: [
      'CREATE INDEX ix_sms_received_at ON sms_records(received_at)',
      'CREATE INDEX ix_sms_number ON sms_records(number)',
      'CREATE INDEX ix_sms_range ON sms_records(range_id)',
      'CREATE INDEX ix_sms_client ON sms_records(client_id)',
      'CREATE INDEX ix_sms_agent ON sms_records(agent_id)',
      'CREATE INDEX ix_sms_manager ON sms_records(manager_id)',
    ],
  },
  {
    name: 'sms_daily_stats',
    note: 'Pre-aggregated daily counts and payout sums — compact cross-check for reports.',
    ddl: `CREATE TABLE sms_daily_stats (
            stat_date TEXT NOT NULL,
            manager_id INTEGER NOT NULL DEFAULT -1,
            agent_id INTEGER NOT NULL DEFAULT -1,
            client_id INTEGER NOT NULL DEFAULT -1,
            cli TEXT NOT NULL DEFAULT '',
            sms_count INTEGER NOT NULL DEFAULT 0,
            payout_sum REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (stat_date, manager_id, agent_id, client_id, cli)
          )`,
    select: 'stat_date, manager_id, agent_id, client_id, cli, sms_count, payout_sum',
    from: 'sms_daily_stats',
  },
  {
    name: 'payment_ledger',
    note: 'Per-SMS earnings — the core financial history. Links to sms_records.id.',
    ddl: `CREATE TABLE payment_ledger (
            id INTEGER PRIMARY KEY,
            sms_record_id INTEGER,
            agent_id INTEGER NOT NULL,
            manager_id INTEGER,
            range_id INTEGER,
            payment_type TEXT NOT NULL,
            amount TEXT DEFAULT '0',
            earned_at TEXT DEFAULT '',
            cycle_key TEXT DEFAULT '',
            eligible_at TEXT DEFAULT '',
            status TEXT DEFAULT 'open',
            request_id INTEGER,
            created_at TEXT
          )`,
    select: 'id, sms_record_id, agent_id, manager_id, range_id, payment_type, amount, earned_at, cycle_key, eligible_at, status, request_id, created_at',
    from: 'payment_ledger',
    indexes: [
      'CREATE INDEX ix_pl_agent ON payment_ledger(agent_id)',
      'CREATE INDEX ix_pl_status ON payment_ledger(status)',
      'CREATE INDEX ix_pl_request ON payment_ledger(request_id)',
    ],
  },
  {
    name: 'payment_requests_v2',
    note: 'Payout requests: amounts, statuses, dates, references (txid).',
    ddl: `CREATE TABLE payment_requests_v2 (
            id INTEGER PRIMARY KEY,
            agent_id INTEGER NOT NULL,
            manager_id INTEGER,
            payment_type TEXT NOT NULL,
            amount TEXT DEFAULT '0',
            wallet_address TEXT NOT NULL,
            status TEXT DEFAULT 'Pending',
            requested_at TEXT,
            paid_at TEXT,
            rejected_at TEXT,
            processed_by INTEGER,
            txid TEXT DEFAULT '',
            screenshot_url TEXT DEFAULT '',
            admin_notes TEXT DEFAULT '',
            reject_reason TEXT DEFAULT '',
            created_at TEXT,
            binance_uid TEXT DEFAULT ''
          )`,
    select: 'id, agent_id, manager_id, payment_type, amount, wallet_address, status, requested_at, paid_at, rejected_at, processed_by, txid, screenshot_url, admin_notes, reject_reason, created_at, binance_uid',
    from: 'payment_requests_v2',
    indexes: ['CREATE INDEX ix_pr_agent ON payment_requests_v2(agent_id)'],
  },
  {
    name: 'payment_schedule',
    note: 'Payout cycle configuration (weekly/monthly windows).',
    ddl: `CREATE TABLE payment_schedule (
            payment_type TEXT PRIMARY KEY,
            weekly_start_dow INTEGER DEFAULT 1,
            weekly_pay_dow INTEGER DEFAULT 3,
            monthly_start_day INTEGER DEFAULT 1,
            monthly_delay_days INTEGER DEFAULT 45,
            updated_at TEXT,
            updated_by INTEGER
          )`,
    select: 'payment_type, weekly_start_dow, weekly_pay_dow, monthly_start_day, monthly_delay_days, updated_at, updated_by',
    from: 'payment_schedule',
  },
  {
    name: 'payment_v2_settings',
    note: 'Payment type labels, minimums and active flags.',
    ddl: `CREATE TABLE payment_v2_settings (
            payment_type TEXT PRIMARY KEY,
            label TEXT DEFAULT '',
            min_withdrawal TEXT DEFAULT '0',
            active INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            updated_at TEXT
          )`,
    select: 'payment_type, label, min_withdrawal, active, sort_order, updated_at',
    from: 'payment_v2_settings',
  },
  {
    name: 'agent_wallets',
    note: 'Payout destinations needed to interpret historical payment requests.',
    ddl: `CREATE TABLE agent_wallets (
            agent_id INTEGER PRIMARY KEY,
            wallet_address TEXT DEFAULT '',
            network TEXT DEFAULT 'USDT_TRC20',
            updated_at TEXT,
            binance_uid TEXT DEFAULT ''
          )`,
    select: 'agent_id, wallet_address, network, updated_at, binance_uid',
    from: 'agent_wallets',
  },
  {
    name: 'payment_audit_logs',
    note: 'Financial audit trail: who approved/paid/rejected what, and when.',
    ddl: `CREATE TABLE payment_audit_logs (
            id INTEGER PRIMARY KEY,
            actor_id INTEGER,
            actor_name TEXT DEFAULT '',
            actor_role TEXT DEFAULT '',
            action TEXT NOT NULL,
            request_id INTEGER,
            agent_id INTEGER,
            manager_id INTEGER,
            payment_type TEXT DEFAULT '',
            amount TEXT DEFAULT '',
            wallet_address TEXT DEFAULT '',
            status TEXT DEFAULT '',
            details TEXT DEFAULT '',
            created_at TEXT
          )`,
    select: 'id, actor_id, actor_name, actor_role, action, request_id, agent_id, manager_id, payment_type, amount, wallet_address, status, details, created_at',
    from: 'payment_audit_logs',
  },
  {
    name: 'provider_payments',
    note: 'Money paid to carriers. Financial ledger only — no provider credentials.',
    ddl: `CREATE TABLE provider_payments (
            id INTEGER PRIMARY KEY,
            provider_id INTEGER,
            provider_name TEXT NOT NULL,
            amount TEXT NOT NULL DEFAULT '0',
            currency TEXT DEFAULT 'USD',
            paid_at TEXT,
            created_by TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            prev_unpaid TEXT DEFAULT '0',
            remaining_unpaid TEXT DEFAULT '0',
            period TEXT DEFAULT ''
          )`,
    select: 'id, provider_id, provider_name, amount, currency, paid_at, created_by, notes, prev_unpaid, remaining_unpaid, period',
    from: 'provider_payments',
  },
];

/* Tables never copied. Documented so the exclusion is auditable, and asserted
   by tools/verify-backup-reduced.js. */
const EXCLUDED_TABLES = [
  ['chat_attachments', 'chat content'],
  ['chat_conversations', 'chat content'],
  ['chat_credentials', 'chat credentials / passwords'],
  ['chat_lock_prefs', 'chat state'],
  ['chat_messages', 'chat content'],
  ['chat_presence', 'chat state'],
  ['api_credentials', 'API tokens / secrets'],
  ['api_integrations', 'integration config'],
  ['api_integration_logs', 'integration logs'],
  ['api_integration_seen', 'integration state'],
  ['api_request_logs', 'API logs'],
  ['sync_providers', 'provider config'],
  ['sync_logs', 'provider sync logs'],
  ['sync_seen', 'provider sync state'],
  ['galaxy_providers', 'provider config'],
  ['carrier_settings', 'provider credentials'],
  ['smpp_connections', 'SMPP credentials'],
  ['smpp_logs', 'SMPP logs'],
  ['smpp_outbox', 'SMPP queue'],
  ['smpp_seen', 'SMPP state'],
  ['numbers', 'full number inventory (only referenced rows land in number_ref)'],
  ['ranges', 'full range config (only identity lands in range_ref)'],
  ['number_history', 'number history'],
  ['number_import_batches', 'import metadata'],
  ['range_test_numbers', 'test config'],
  ['cli_limits', 'limits'],
  ['daily_limit_rules', 'limits'],
  ['sharing_users', 'sharing config'],
  ['sharing_forward_logs', 'sharing logs'],
  ['complaints', 'complaints'],
  ['complaint_replies', 'complaints'],
  ['branding_settings', 'branding'],
  ['branding_users', 'branding'],
  ['app_settings', 'panel settings'],
  ['system_security', 'security config / PIN'],
  ['jobs', 'operational'],
  ['audit_logs', 'activity log'],
  ['activity_ips', 'activity log'],
  ['idempotency_keys', 'operational'],
  ['webhook_logs', 'debug log'],
  ['failed_sms_queue', 'operational queue'],
  ['meta', 'internal runtime state'],
];

const META_DDL = `CREATE TABLE backup_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT
                  )`;

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/* The db handle passed in is NOT always the same shape, and this bit us once:
 *
 *   backend/db.js wrapper  -> exec(), get(), all(), run(), iterate(),
 *                             inTransaction(), beginBatch(). NO prepare().
 *   raw better-sqlite3     -> exec(), prepare(), transaction(), inTransaction.
 *                             NO get()/all()/run().
 *
 * The only method common to both is exec(), so everything else goes through
 * this adapter. Detect the shape once and adapt. */
function makeAdapter(db) {
  if (typeof db.prepare === 'function') {
    return {
      one(sql, params = []) {
        const r = db.prepare(sql).get(...params);
        return r === undefined ? null : r;
      },
      all(sql, params = []) { return db.prepare(sql).all(...params); },
      txn(fn) { db.transaction(fn)(); },
      inTxn() { return !!db.inTransaction; },
    };
  }
  if (typeof db.get === 'function') {
    return {
      one(sql, params = []) {
        const r = db.get(sql, params);
        return r == null ? null : r;
      },
      all(sql, params = []) { return db.all(sql, params) || []; },
      txn(fn) {
        // Never steal a transaction the caller already opened.
        const open = typeof db.inTransaction === 'function' ? db.inTransaction() : !!db.inTransaction;
        if (open) { fn(); return; }
        db.exec('BEGIN');
        try { fn(); db.exec('COMMIT'); }
        catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ } throw e; }
      },
      inTxn() { return typeof db.inTransaction === 'function' ? db.inTransaction() : !!db.inTransaction; },
    };
  }
  throw new Error('Unsupported db handle: needs either prepare() or get()');
}

/* The connection is shared and long-lived in the running server. If a previous
 * run died mid-flight it can leave its ATTACHed alias behind, and DETACH is
 * refused while a transaction is open — which then makes every later backup
 * fail with "database bk is already in use". Two defences:
 *   1. every run uses a unique alias, so a leftover can never block a new one
 *   2. any leftover alias is detached up-front, after rolling back
 */
function detachLeftovers(db, A) {
  let rows = [];
  try { rows = A.all('PRAGMA database_list'); } catch (_) { return; }
  for (const r of rows || []) {
    if (!r.name || !/^bk/.test(r.name)) continue;
    // No ROLLBACK here: this handle may belong to a caller with live work in an
    // open transaction, and rolling it back would destroy that work.
    try { db.exec(`DETACH DATABASE ${r.name}`); } catch (_) { /* best effort */ }
  }
}

function newAlias() {
  return 'bk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* Source tables are checked before each copy: a deployment missing an optional
   table (provider_payments, say) must still get a backup of everything else
   rather than failing as a whole. */
function tableExists(A, name) {
  return !!A.one("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", [name]);
}

/* Indexes make the archive directly reportable but cost roughly a third of the
   output (measured on a 20k-SMS fixture). Set BACKUP_REDUCED_INDEXES=0 to ship
   the smallest possible file. */
function indexesEnabled() {
  return String(process.env.BACKUP_REDUCED_INDEXES || '1').toLowerCase() !== '0';
}

/**
 * Build the reduced database at `tmpPath` using `conn`.
 *
 * `conn` MUST be a connection this function owns. Do NOT pass the application's
 * live connection: this opens a transaction on it, and if the caller already
 * had one open, committing or rolling back here would silently discard the
 * application's work. (That happened once — the backup reported 20,000 rows
 * while writing a 12 KB file, because a ROLLBACK in the cleanup path threw away
 * a transaction the caller owned.)
 *
 * Returns per-table row counts. Throws on failure; the caller deletes the temp
 * file and the previous good backup stays in place.
 */
function buildReduced(conn, tmpPath) {
  const A = makeAdapter(conn);
  detachLeftovers(conn, A);
  const BK = newAlias();
  conn.exec(`ATTACH DATABASE ${sqlQuote(tmpPath)} AS ${BK}`);
  const counts = {};
  let dirty = false;
  try {
    // One transaction around every copy => one consistent snapshot, even while
    // SMS ingestion and provider sync are writing to the source. WAL mode lets
    // this reader run alongside the app's writer without blocking it.
    A.txn(() => {
      dirty = true;
      for (const spec of INCLUDED_TABLES) {
        if (!tableExists(A, spec.from)) { counts[spec.name] = null; continue; }
        conn.exec(spec.ddl.replace('CREATE TABLE ', `CREATE TABLE ${BK}.`));
        const where = spec.where ? ` WHERE ${spec.where}` : '';
        conn.exec(
          `INSERT INTO ${BK}.${spec.name} (${spec.select})
           SELECT ${spec.select} FROM main.${spec.from}${where}`
        );
        counts[spec.name] = A.one(`SELECT COUNT(*) AS c FROM ${BK}.${spec.name}`).c;
      }
    });

    // Indexes after the data load — faster, and they land in the same file.
    // They make the archive directly reportable (group by number / range /
    // account / date), but measured on a 20k-SMS fixture they cost roughly a
    // THIRD of the output. Set BACKUP_REDUCED_INDEXES=0 for the smallest
    // possible file; the indexes can be recreated later with the CREATE INDEX
    // statements listed in INCLUDED_TABLES.
    if (indexesEnabled()) {
      A.txn(() => {
        for (const spec of INCLUDED_TABLES) {
          if (!spec.indexes || counts[spec.name] == null) continue;
          for (const ix of spec.indexes) conn.exec(ix.replace('CREATE INDEX ', `CREATE INDEX ${BK}.`));
        }
      });
    }
  } finally {
    // Only ever clean up OUR transaction. A.txn() rolls back on its own error,
    // so by here nothing of ours is open — never issue a bare ROLLBACK, which
    // would destroy a transaction belonging to someone else.
    try { conn.exec(`DETACH DATABASE ${BK}`); } catch (_) { /* ignore */ }
    if (!dirty) { try { conn.exec('ROLLBACK'); } catch (_) { /* nothing open */ } }
  }
  return counts;
}

/* Resolve the source file from either handle shape. */
function sourceFile(db) {
  if (db && typeof db.getDbFile === 'function') { try { return db.getDbFile(); } catch (_) { /* fall through */ } }
  return db && db.name ? db.name : null;
}

/**
 * Create a reduced backup of `db` inside `dir`.
 *
 * Opens its OWN connection to the source file rather than using the caller's,
 * so a backup can never disturb an in-flight application transaction, and a
 * leftover ATTACH can never accumulate on the live connection.
 *
 * Writes to <file>.tmp, validates integrity, then atomically renames.
 */
function createReducedBackup(db, dir, fileName, reason = 'auto') {
  const fullPath = path.join(dir, fileName);
  const tmpPath = fullPath + '.tmp';

  // Clear any debris from a previous crashed run before we start.
  for (const suffix of ['', '-journal', '-wal', '-shm', '-mj']) {
    try { fs.unlinkSync(tmpPath + suffix); } catch (_) { /* nothing there */ }
  }

  const srcFile = sourceFile(db);
  if (!srcFile || !fs.existsSync(srcFile)) {
    throw new Error('Cannot locate the source database file to back up');
  }

  let conn;
  try {
    // Deliberately NOT readonly: a readonly main connection may not ATTACH a
    // writable database. This connection only ever SELECTs from `main`.
    conn = new Database(srcFile);
  } catch (e) {
    throw new Error('Cannot open the source database: ' + e.message);
  }

  let counts;
  try {
    conn.pragma('busy_timeout = 30000');
    // No wal_checkpoint needed: our own transaction already gives a consistent
    // snapshot, and checkpointing would briefly contend with the live writer.
    counts = buildReduced(conn, tmpPath);
  } finally {
    try { conn.close(); } catch (_) { /* ignore */ }
  }

  const meta = {
    format: FORMAT,
    format_version: String(FORMAT_VERSION),
    created_at: new Date().toISOString(),
    generator: 'backend/backupReduced.js',
    reason,
    source_db_file: srcFile,
    app: 'qtech-sms',
    /* Recorded so a verifier can cross-check without re-deriving everything. */
    table_counts: JSON.stringify(counts),
    indexes_included: indexesEnabled() ? '1' : '0',
    note: 'Reduced archive of business records. NOT a restorable application snapshot: numbers, ranges, providers, credentials and configuration are deliberately absent.',
  };
  writeMeta(tmpPath, meta);

  // Validate before the file becomes visible to retention, download or restore.
  const check = new Database(tmpPath, { readonly: true });
  try {
    const ic = check.prepare('PRAGMA integrity_check').get().integrity_check;
    if (ic !== 'ok') throw new Error('backup failed integrity_check: ' + ic);
    const fmt = check.prepare("SELECT value FROM backup_meta WHERE key='format'").get();
    if (!fmt || fmt.value !== FORMAT) throw new Error('backup_meta format marker missing');
    // Guard against the silent-empty-file failure this module hit once: the
    // counts must match what is actually stored in the finished file.
    const stored = JSON.parse(meta.table_counts);
    const bad = Object.entries(stored).filter(([t, n]) => {
      if (n == null) return false;
      const got = check.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
      return got !== n;
    });
    if (bad.length) {
      throw new Error('row counts lost before rename: ' + bad.map(([t, n]) => `${t} expected ${n}`).join(', '));
    }
  } finally { check.close(); }

  fs.renameSync(tmpPath, fullPath);
  return { file: fileName, size: fs.statSync(fullPath).size, reason, counts, format: FORMAT };
}

function writeMeta(filePath, meta) {
  const out = new Database(filePath);
  try {
    out.exec(META_DDL);
    const ins = out.prepare('INSERT OR REPLACE INTO backup_meta (key, value) VALUES (?, ?)');
    const put = out.transaction((obj) => {
      for (const [k, v] of Object.entries(obj)) ins.run(k, String(v));
    });
    put(meta);
  } finally { out.close(); }
}

function readBackupMeta(filePath) {
  let d;
  try { d = new Database(filePath, { readonly: true }); } catch (_) { return null; }
  try {
    const A = makeAdapter(d);   // tableExists() takes an adapter, not a handle
    if (!tableExists(A, 'backup_meta')) return null;
    const rows = d.prepare('SELECT key, value FROM backup_meta').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch (_) { return null; } finally { d.close(); }
}

function isReducedBackupFile(filePath) {
  const m = readBackupMeta(filePath);
  return !!(m && m.format === FORMAT);
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  INCLUDED_TABLES,
  EXCLUDED_TABLES,
  createReducedBackup,
  readBackupMeta,
  isReducedBackupFile,
};
