/**
 * Backup service for ZOOM SMS.
 * =============================================================================
 * TWO KINDS OF BACKUP
 *
 *   REDUCED  — createBackup(). The default, and the only kind produced by the
 *              automatic timer. A small archive of business records: users,
 *              SMS history and payments. Built by backend/backupReduced.js by
 *              copying selected columns into a fresh database, so peak extra
 *              disk use is the size of the output, never the size of the live
 *              database.
 *
 *   FULL     — createFullBackup(). A byte-complete `VACUUM INTO` snapshot, the
 *              only kind that can restore a running system. Manual/on-demand
 *              only, because a scheduled full backup is what filled the disk
 *              (~240 concurrent copies of a ~380 MB database ≈ 91 GB).
 *
 * A reduced backup is NOT a restorable application snapshot: it has no
 * numbers, ranges, providers, credentials or configuration. restoreBackup()
 * refuses one rather than let it be written over the live database.
 *
 * RETENTION
 *   Calendar months, default 5. Anything older than (today minus 5 calendar
 *   months) is deleted, including legacy full backups from before this change.
 *   Only files matching the known backup naming patterns inside BACKUP_DIR are
 *   ever considered; the live database is never touched.
 * =============================================================================
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const reduced = require('./backupReduced');

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
/* Backup file naming. New backups use "qtech-sms-backup-<ts>.sqlite".
   Backups created under earlier brands ("nova-sms-backup-*" and the intermediate
   "almada-sms-backup-*") are still listed, restorable and pruned by retention —
   only the prefix differs. */
const BACKUP_PREFIX = 'qtech-sms-backup-';
const LEGACY_BACKUP_PREFIXES = ['nova-sms-backup-', 'almada-sms-backup-'];
const ALL_PREFIXES = [BACKUP_PREFIX, ...LEGACY_BACKUP_PREFIXES];
const BACKUP_NAME_RE = /^(?:qtech|almada|nova)-sms-backup-\d{4}-\d{2}-\d{2}T[\w-]+\.sqlite$/; /* new = qtech, legacy almada/nova still honoured */
function isBackupFileName(base){ return BACKUP_NAME_RE.test(String(base||'')); }
function matchesBackupPrefix(base) {
  return ALL_PREFIXES.some(p => String(base || '').startsWith(p));
}
function getDbFile(db) {
  return db.getDbFile ? db.getDbFile() : path.join(__dirname, 'data.sqlite');
}
function getBackupDir(db) {
  return process.env.BACKUP_DIR
    || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'backups') : null)
    // VPS-safe default: outside the application folder, so backups survive accidental app deletion.
    || path.join(os.homedir(), 'qtech-sms-backups');
}
function ensureBackupDir(db) {
  const dir = getBackupDir(db);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function safeBackupName(name) {
  const base = path.basename(String(name || ''));
  if (!isBackupFileName(base)) {
    throw new Error('Invalid backup file name');
  }
  return base;
}
function backupPath(db, fileName) {
  return path.join(ensureBackupDir(db), safeBackupName(fileName));
}
function listBackups(db, opts = {}) {
  const dir = ensureBackupDir(db);
  const out = fs.readdirSync(dir)
    // Only ever files we recognise. Anything else in the folder is left alone,
    // even if it looks stale — an unexpected name is not proof it is a backup.
    .filter(f => f.endsWith('.sqlite') && matchesBackupPrefix(f))
    .map(file => {
      const fullPath = path.join(dir, file);
      const st = fs.statSync(fullPath);
      const row = {
        file,
        size: st.size,
        created_at: st.birthtime.toISOString(),
        modified_at: st.mtime.toISOString(),
      };
      // Opt-in only: reading the marker means opening every file, which is far
      // too slow to do on every listing now that retention spans months.
      if (opts.withFormat) {
        const m = reduced.readBackupMeta(fullPath);
        row.format = m ? (m.format || 'full') : 'full';
        row.format_version = m ? m.format_version : '';
      }
      return row;
    })
    .sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));
  return out;
}
/* Only one backup may run at a time in this process.
 *
 * Two overlapping runs both hold a transaction on the source database and both
 * commit a second (attached) database, so the loser fails with SQLITE_BUSY —
 * measured here as "database is locked" when a manual request raced the 15s
 * startup backup. Serialising them is cheaper and far safer than letting one
 * fail, and it also stops two full snapshots being written at once. */
let backupInProgress = false;
function withBackupLock(fn, what) {
  if (backupInProgress) {
    throw new Error(`A backup is already running in this process (${what}); not starting a second one.`);
  }
  backupInProgress = true;
  try { return fn(); } finally { backupInProgress = false; }
}

function createFullBackup(db, reason = 'manual-full') {
  return withBackupLock(() => createFullBackupInner(db, reason), 'full');
}
function createFullBackupInner(db, reason) {
  const dir = ensureBackupDir(db);
  if (db.save) db.save();
  const file = `${BACKUP_PREFIX}${ts()}.sqlite`;
  const fullPath = path.join(dir, file);
  const tmpPath = fullPath + '.tmp';
  // PHASE-2 MEMORY FIX: exportBuffer() was the sql.js-era whole-DB-in-a-Buffer
  // API — on a multi-GB database it allocated the entire file in RAM (1.86 GB
  // at 5M numbers) and got the process OOM-killed. VACUUM INTO writes the
  // same complete, restorable snapshot directly to disk with O(1) Node memory.
  let done = false;
  try {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
    db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    done = true;
  } catch (_) { /* fall back below */ }
  if (!done) {
    const buffer = db.exportBuffer ? db.exportBuffer() : fs.readFileSync(getDbFile(db));
    fs.writeFileSync(tmpPath, Buffer.from(buffer));
  }
  fs.renameSync(tmpPath, fullPath);
  return { file, size: fs.statSync(fullPath).size, reason, format: 'full', created_at: new Date().toISOString() };
}
/* The default backup: a small archive of business records.
   Writes to .tmp, validates integrity, then atomically renames. */
function createBackup(db, reason = 'manual') {
  return withBackupLock(() => createBackupInner(db, reason), 'reduced');
}
function createBackupInner(db, reason) {
  const dir = ensureBackupDir(db);
  if (db.save) db.save();
  const file = `${BACKUP_PREFIX}${ts()}.sqlite`;
  try {
    return reduced.createReducedBackup(db, dir, file, reason);
  } catch (e) {
    // A reduced backup must never fail open into a full one: that is exactly
    // the behaviour that filled the disk. Surface the failure instead.
    try { fs.unlinkSync(path.join(dir, file + '.tmp')); } catch (_) {}
    throw new Error('Reduced backup failed: ' + e.message);
  }
}

/* ---------------------------------------------------------------------------
 * Retention — 5 calendar months.
 *
 * Calendar arithmetic, not "days / 30": 5 calendar months before 31 Jul is
 * 28 Feb (clamped), not 3 Mar.
 * ------------------------------------------------------------------------ */
function subtractCalendarMonths(date, months) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  let ty = y;
  let tm = m - months;
  while (tm < 0) { tm += 12; ty -= 1; }
  // Clamp the day to the last day of the target month (31 Jul - 5mo -> 28 Feb).
  const lastDay = new Date(ty, tm + 1, 0).getDate();
  const td = Math.min(d, lastDay);
  return new Date(ty, tm, td, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}
function retentionCutoff(now = new Date()) {
  const months = Math.max(1, parseInt(process.env.BACKUP_RETENTION_MONTHS || '5', 10));
  return subtractCalendarMonths(now, months);
}
/* A .tmp file is a backup still being written, or debris from a crashed run.
   It is never a valid backup, so it is not covered by the 5-month rule — it
   is only removed once it is old enough that no write can still be in flight. */
function staleTmpCutoffHours() {
  return Math.max(1, parseInt(process.env.BACKUP_STALE_TMP_HOURS || '24', 10));
}
function cleanupOldBackups(db, opts = {}) {
  if (backupInProgress) {
    return { deleted: [], skipped: ['a backup is currently in progress'], cutoff: '', months: 0 };
  }
  const dryRun = !!(opts && opts.dryRun);
  const minKeep = Math.max(0, parseInt(process.env.BACKUP_MIN_KEEP || '2', 10));
  const cutoff = retentionCutoff(new Date());
  const cutoffMs = cutoff.getTime();
  const staleMs = staleTmpCutoffHours() * 3600 * 1000;
  const nowMs = Date.now();

  const dir = ensureBackupDir(db);
  const entries = fs.readdirSync(dir);
  const backups = listBackups(db);   // name-filtered, newest first
  const deleted = [];
  const skipped = [];

  // The newest minKeep backups are protected regardless of age, so a lone old
  // backup is never swept away leaving nothing.
  const protectedFiles = new Set(backups.slice(0, minKeep).map(b => b.file));

  for (const b of backups) {
    if (protectedFiles.has(b.file)) { skipped.push(b.file + ' (min-keep)'); continue; }
    if (new Date(b.modified_at).getTime() >= cutoffMs) continue;
    const fullPath = path.join(dir, path.basename(b.file));
    // Final belt-and-braces re-check: we only ever unlink inside BACKUP_DIR,
    // and only a name we generated or inherited from a known prefix.
    if (!matchesBackupPrefix(path.basename(fullPath))) { skipped.push(b.file + ' (unexpected name)'); continue; }
    if (dryRun) { deleted.push(b.file + ' (dry-run)'); continue; }
    try { fs.unlinkSync(fullPath); deleted.push(b.file); }
    catch (e) { skipped.push(b.file + ' (delete failed: ' + e.message + ')'); }
  }

  // Stale in-flight debris only. Never anything young enough to be live.
  for (const f of entries) {
    if (!/\.sqlite\.(tmp|tmp-journal|tmp-wal|tmp-shm|-journal|-wal|-shm)$/.test(f)) continue;
    if (!matchesBackupPrefix(f)) continue;
    const fullPath = path.join(dir, f);
    let st;
    try { st = fs.statSync(fullPath); } catch (_) { continue; }
    if (!st.isFile()) continue;
    if (nowMs - st.mtimeMs < staleMs) { skipped.push(f + ' (recent, may be in flight)'); continue; }
    if (dryRun) { deleted.push(f + ' (dry-run, stale tmp)'); continue; }
    try { fs.unlinkSync(fullPath); deleted.push(f + ' (stale tmp)'); }
    catch (e) { skipped.push(f + ' (delete failed: ' + e.message + ')'); }
  }

  return { deleted, skipped, cutoff: cutoff.toISOString(), months: Math.max(1, parseInt(process.env.BACKUP_RETENTION_MONTHS || '5', 10)) };
}
function deleteBackup(db, fileName) {
  const fullPath = backupPath(db, fileName);
  if (!fs.existsSync(fullPath)) throw new Error('Backup not found');
  fs.unlinkSync(fullPath);
  return true;
}
function getLatestBackup(db) {
  return listBackups(db)[0] || null;
}
function restoreBackup(db, fileName) {
  const fullPath = backupPath(db, fileName);
  if (!fs.existsSync(fullPath)) throw new Error('Backup not found');
  // A reduced backup has no numbers, ranges, providers or configuration.
  // Restoring it over the live database would destroy the running system, so
  // refuse here rather than rely on the operator noticing.
  const meta = reduced.readBackupMeta(fullPath);
  if (meta && meta.format === reduced.FORMAT) {
    throw new Error(
      'This is a reduced business-records archive (format "' + reduced.FORMAT + '"), not a ' +
      'restorable application snapshot. Restoring it would erase numbers, ranges, providers ' +
      'and configuration. Use a full backup (create one via POST /api/backups/create-full) to restore.'
    );
  }
  // Always create a safety snapshot before restore — and it must be a FULL one,
  // because it is the only thing that can put the system back if this goes wrong.
  const safety = createFullBackup(db, 'pre-restore-safety');
  if (!db.replaceWithFile) throw new Error('Database restore is not supported by db layer');
  db.replaceWithFile(fullPath);
  return { ok: true, restored_from: path.basename(fileName), safety_backup: safety.file };
}
function startAutomaticBackups(db, logger = console) {
  const enabled = String(process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logger.log('• Automatic backups disabled');
    return null;
  }
  // Interval unchanged: the reduced backup is small enough that the existing
  // cadence is no longer a disk risk.
  const hours = Math.max(1, parseFloat(process.env.BACKUP_INTERVAL_HOURS || '3'));
  const ms = hours * 60 * 60 * 1000;
  if (process.env.BACKUP_RETENTION_DAYS) {
    logger.log('• Note: BACKUP_RETENTION_DAYS is deprecated and ignored; retention is ' +
               Math.max(1, parseInt(process.env.BACKUP_RETENTION_MONTHS || '5', 10)) + ' calendar month(s).');
  }
  // Create a startup backup shortly after boot, then schedule interval.
  setTimeout(() => {
    try { createBackup(db, 'startup'); cleanupOldBackups(db); logger.log('✓ Startup backup created'); }
    catch (e) { logger.error('Backup error:', e.message); }
  }, 15000);
  const timer = setInterval(() => {
    try { const b = createBackup(db, 'auto'); cleanupOldBackups(db); logger.log('✓ Auto backup created:', b.file); }
    catch (e) { logger.error('Backup error:', e.message); }
  }, ms);
  if (timer.unref) timer.unref();
  logger.log(`• Automatic backups enabled: every ${hours} hour(s), reduced format, dir: ${getBackupDir(db)}`);
  return timer;
}
module.exports = {
  getBackupDir,
  listBackups,
  createBackup,
  createFullBackup,
  cleanupOldBackups,
  deleteBackup,
  getLatestBackup,
  restoreBackup,
  backupPath,
  startAutomaticBackups,
  subtractCalendarMonths,
  retentionCutoff,
  isReducedBackupFile: reduced.isReducedBackupFile,
  readBackupMeta: reduced.readBackupMeta,
};
