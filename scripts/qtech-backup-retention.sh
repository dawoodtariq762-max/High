#!/usr/bin/env bash
# =============================================================================
# ZOOM SMS — backup retention (5 CALENDAR MONTHS) + optional full snapshot
# =============================================================================
# PURPOSE
#   An independent safety net alongside the in-app pruner in backend/backup.js.
#   If the app is down, crashed, or was redeployed, the in-app pruner never
#   runs — this cron job still does.
#
#   It can also CREATE a full snapshot (--snapshot) so you have a schedule that
#   does not depend on the Node process at all. NOTE: the in-app automatic
#   timer now produces small REDUCED backups; a --snapshot here is a FULL copy
#   of the database, so use it sparingly and never on a nearly-full disk.
#
# RETENTION IS CALENDAR-BASED
#   Default: delete backups older than 5 CALENDAR MONTHS, not "150 days".
#   5 calendar months before 31 Jul is 28 Feb (clamped); before 15 Oct it is
#   15 May. Day/month lengths are respected, including leap years.
#   This applies to every recognised backup file, including the large legacy
#   full backups written before the reduced format existed.
#
# SAFETY — how this script avoids deleting live data
#   1. It only ever looks at ONE directory: BACKUP_DIR.
#   2. It only ever considers files matching the app's backup naming pattern:
#        qtech-sms-backup-*.sqlite   (current)
#        almada-sms-backup-*.sqlite  (legacy)
#        nova-sms-backup-*.sqlite    (legacy)
#      A file whose name is not recognised is NEVER deleted — an unexpected
#      name is not proof that a file is a backup.
#   3. -maxdepth 1  -> never recurses into subdirectories.
#   4. -type f      -> never a directory, symlink or device.
#   5. MIN_KEEP     -> always keeps the newest N backups even if they are old.
#   6. Live data is NEVER touched: the database (data.sqlite), WAL/SHM files,
#      chat uploads, exports, logs and application code are all outside
#      BACKUP_DIR and are not matched by the pattern.
#   7. A file that is still being written (*.tmp, *-journal, *-wal, *-shm) is
#      never deleted while it is young enough to be in flight. Only debris
#      older than STALE_TMP_HOURS (default 24h) is cleared.
#   8. --dry-run prints exactly what would be deleted and deletes nothing.
#
# USAGE
#   bash scripts/qtech-backup-retention.sh                 # prune only
#   bash scripts/qtech-backup-retention.sh --dry-run       # show, delete nothing
#   bash scripts/qtech-backup-retention.sh --snapshot      # full snapshot, then prune
#
# EXIT CODES
#   0 ok (nothing to do, or pruned successfully)
#   1 configuration error (backup dir missing / not writable)
#   2 a prune failed
# =============================================================================
set -uo pipefail

# ---------------------------------------------------------------------------
# Configuration (override via environment; defaults match the project layout)
# ---------------------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-/root/qtech-sms-backups}"
RETENTION_MONTHS="${BACKUP_RETENTION_MONTHS:-5}"          # CALENDAR months
MIN_KEEP="${BACKUP_MIN_KEEP:-2}"                          # never go below this many
STALE_TMP_HOURS="${BACKUP_STALE_TMP_HOURS:-24}"           # .tmp newer than this may be live
LOG_DIR="${QTECH_LOG_DIR:-/root/qtech-logs}"
LOG="$LOG_DIR/backup-retention.log"
DRY_RUN=0
DO_SNAPSHOT=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --snapshot) DO_SNAPSHOT=1 ;;
    -h|--help)  sed -n '2,48p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

mkdir -p "$LOG_DIR" 2>/dev/null || true
log() {
  echo "$(date '+%F %T') $*" >> "$LOG" 2>/dev/null || true
  echo "$(date '+%F %T') $*"
}

# ---------------------------------------------------------------------------
# 0. Sanity checks — refuse to act on anything that is not a real backup dir
# ---------------------------------------------------------------------------
if [ ! -d "$BACKUP_DIR" ]; then
  log "ERROR backup dir does not exist: $BACKUP_DIR (nothing deleted)"
  exit 1
fi
if [ ! -w "$BACKUP_DIR" ]; then
  log "ERROR backup dir is not writable: $BACKUP_DIR (nothing deleted)"
  exit 1
fi

# Belt and braces: refuse to run if BACKUP_DIR looks like the app directory.
case "$BACKUP_DIR" in
  */backend|*/qtech-sms|*/qtech-sms/|/)
    log "ERROR refusing to run: BACKUP_DIR='$BACKUP_DIR' looks like application code (nothing deleted)"
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# 1. Optional FULL snapshot, taken with SQLite's online backup so it is
#    consistent even while the panel is running. Requires sqlite3 CLI.
#    This is a complete copy of the database — size it before scheduling it.
# ---------------------------------------------------------------------------
if [ "$DO_SNAPSHOT" -eq 1 ]; then
  DB_FILE="${DB_FILE:-/root/qtech-sms/backend/data.sqlite}"
  if [ ! -f "$DB_FILE" ]; then
    log "SNAPSHOT SKIPPED database not found: $DB_FILE"
  elif ! command -v sqlite3 >/dev/null 2>&1; then
    log "SNAPSHOT SKIPPED sqlite3 CLI not installed (apt install -y sqlite3)"
  else
    NEW="$BACKUP_DIR/qtech-sms-backup-$(date -u +%Y-%m-%dT%H-%M-%S).sqlite"
    if sqlite3 "$DB_FILE" ".backup '$NEW.tmp'" 2>>"$LOG"; then
      mv "$NEW.tmp" "$NEW"
      log "SNAPSHOT OK $(basename "$NEW") ($(du -h "$NEW" | cut -f1))"
    else
      rm -f "$NEW.tmp" 2>/dev/null || true
      log "SNAPSHOT FAILED could not back up $DB_FILE"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 2. Calendar-month cutoff.
#    Subtract RETENTION_MONTHS from today's year/month, then clamp the day to
#    the last day of that month so e.g. 31 Jul - 5 months = 28 Feb, not 3 Mar.
# ---------------------------------------------------------------------------
now_y=$(date +%Y)
now_m=$(date +%-m)
now_d=$(date +%-d)

ty=$now_y
tm=$(( now_m - RETENTION_MONTHS ))
while [ "$tm" -le 0 ]; do
  tm=$(( tm + 12 ))
  ty=$(( ty - 1 ))
done

last_day=$(date -d "${ty}-${tm}-01 +1 month -1 day" +%-d 2>/dev/null)
if [ -z "$last_day" ]; then
  log "ERROR could not compute last day of ${ty}-${tm} (nothing deleted)"
  exit 1
fi
if [ "$now_d" -gt "$last_day" ]; then td=$last_day; else td=$now_d; fi

CUTOFF=$(date -d "${ty}-${tm}-${td} 00:00:00" +%s 2>/dev/null)
if [ -z "$CUTOFF" ]; then
  log "ERROR could not compute cutoff date (nothing deleted)"
  exit 1
fi
CUTOFF_HUMAN=$(date -d "@${CUTOFF}" '+%F')

list_backups() {
  find "$BACKUP_DIR" -maxdepth 1 -type f \
       \( -name 'qtech-sms-backup-*.sqlite' \
       -o -name 'almada-sms-backup-*.sqlite' \
       -o -name 'nova-sms-backup-*.sqlite' \) 2>/dev/null
}

total=$(list_backups | wc -l)
log "PRUNE start dir=$BACKUP_DIR keep=${RETENTION_MONTHS} calendar months (older than ${CUTOFF_HUMAN}) min_keep=$MIN_KEEP found=$total dry_run=$DRY_RUN"

if [ "$total" -eq 0 ]; then
  log "PRUNE ok no backup files present — nothing to do"
  exit 0
fi

# Always protect the newest MIN_KEEP files regardless of age.
protected=$(list_backups -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n "$MIN_KEEP" | cut -d' ' -f2-)

deleted=0
failed=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  # skip protected (newest MIN_KEEP)
  skip=0
  while IFS= read -r p; do
    [ "$f" = "$p" ] && skip=1 && break
  done <<< "$protected"
  [ "$skip" -eq 1 ] && continue

  # final safety re-check of the filename pattern before any deletion
  base=$(basename "$f")
  case "$base" in
    qtech-sms-backup-*.sqlite|almada-sms-backup-*.sqlite|nova-sms-backup-*.sqlite) ;;
    *) log "SKIP refusing to delete non-backup file: $base"; continue ;;
  esac
  [ -f "$f" ] || continue

  mtime=$(stat -c %Y "$f" 2>/dev/null)
  [ -z "$mtime" ] && continue
  [ "$mtime" -ge "$CUTOFF" ] && continue   # still inside the retention window

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] would delete: $base ($(du -h "$f" | cut -f1), $(date -d "@${mtime}" '+%F'))"
    deleted=$((deleted + 1))
  else
    if rm -f "$f"; then
      log "DELETED $base (older than ${CUTOFF_HUMAN})"
      deleted=$((deleted + 1))
    else
      log "DELETE FAILED $base"
      failed=$((failed + 1))
    fi
  fi
done < <(list_backups -printf '%T@ %p\n' 2>/dev/null | sort -n | cut -d' ' -f2-)

# ---------------------------------------------------------------------------
# 3. Clear in-flight debris — only if old enough that no write can be live.
# ---------------------------------------------------------------------------
stale_secs=$(( STALE_TMP_HOURS * 3600 ))
now_epoch=$(date +%s)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  base=$(basename "$f")
  case "$base" in
    qtech-sms-backup-*|almada-sms-backup-*|nova-sms-backup-*) ;;
    *) continue ;;
  esac
  mtime=$(stat -c %Y "$f" 2>/dev/null)
  [ -z "$mtime" ] && continue
  age=$(( now_epoch - mtime ))
  [ "$age" -lt "$stale_secs" ] && { log "SKIP recent in-flight file: $base"; continue; }
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] would delete stale tmp: $base"
  else
    rm -f "$f" && log "DELETED stale tmp $base"
  fi
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
              \( -name 'qtech-sms-backup-*.sqlite.tmp*' \
              -o -name '*-sms-backup-*.sqlite-journal' \
              -o -name '*-sms-backup-*.sqlite-wal' \
              -o -name '*-sms-backup-*.sqlite-shm' \) 2>/dev/null)

if [ "$failed" -gt 0 ]; then
  log "PRUNE done deleted=$deleted failed=$failed"
  exit 2
fi
log "PRUNE done deleted=$deleted remaining=$(list_backups | wc -l)"
exit 0
