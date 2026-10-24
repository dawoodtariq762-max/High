#!/usr/bin/env bash
# =============================================================================
# Q TECH SMS — backup retention (keep 3 days) + optional snapshot
# =============================================================================
# PURPOSE
#   An independent safety net alongside the in-app pruner in backend/backup.js
#   (which honours BACKUP_RETENTION_DAYS). If the app is down, crashed, or was
#   redeployed, the in-app pruner never runs — this cron job still does.
#
#   It can also CREATE a snapshot (--snapshot) so you have a schedule that does
#   not depend on the Node process at all.
#
# SAFETY — how this script avoids deleting live data
#   1. It only ever looks at ONE directory: BACKUP_DIR.
#   2. It only ever considers files matching the app's backup naming pattern:
#        qtech-sms-backup-*.sqlite   (current)
#        almada-sms-backup-*.sqlite  (legacy)
#        nova-sms-backup-*.sqlite    (legacy)
#   3. -maxdepth 1  -> never recurses into subdirectories.
#   4. -type f      -> never a directory, symlink or device.
#   5. MIN_KEEP     -> always keeps the newest N backups even if they are old.
#   6. Live data is NEVER touched: the database (data.sqlite), WAL/SHM files,
#      chat uploads, exports, logs and application code are all outside
#      BACKUP_DIR and are not matched by the pattern.
#   7. --dry-run prints exactly what would be deleted and deletes nothing.
#
# USAGE
#   bash scripts/qtech-backup-retention.sh                 # prune only
#   bash scripts/qtech-backup-retention.sh --dry-run       # show, delete nothing
#   bash scripts/qtech-backup-retention.sh --snapshot      # create backup, then prune
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
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-3}"
MIN_KEEP="${MIN_KEEP:-2}"                       # never go below this many
LOG_DIR="${QTECH_LOG_DIR:-/root/qtech-logs}"
LOG="$LOG_DIR/backup-retention.log"
DRY_RUN=0
DO_SNAPSHOT=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --snapshot) DO_SNAPSHOT=1 ;;
    -h|--help)  sed -n '2,40p' "$0"; exit 0 ;;
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
# 1. Optional snapshot, taken with SQLite's online backup so it is consistent
#    even while the panel is running. Requires sqlite3 CLI; skipped if absent.
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
# 2. Prune: delete only backup-named regular files older than RETENTION_DAYS
# ---------------------------------------------------------------------------
total=$(find "$BACKUP_DIR" -maxdepth 1 -type f \
          \( -name 'qtech-sms-backup-*.sqlite' \
          -o -name 'almada-sms-backup-*.sqlite' \
          -o -name 'nova-sms-backup-*.sqlite' \) 2>/dev/null | wc -l)

log "PRUNE start dir=$BACKUP_DIR keep=${RETENTION_DAYS}d min_keep=$MIN_KEEP found=$total dry_run=$DRY_RUN"

if [ "$total" -eq 0 ]; then
  log "PRUNE ok no backup files present — nothing to do"
  exit 0
fi

# Always protect the newest MIN_KEEP files regardless of age.
protected=$(find "$BACKUP_DIR" -maxdepth 1 -type f \
              \( -name 'qtech-sms-backup-*.sqlite' \
              -o -name 'almada-sms-backup-*.sqlite' \
              -o -name 'nova-sms-backup-*.sqlite' \) \
              -printf '%T@ %p\n' 2>/dev/null \
            | sort -rn | head -n "$MIN_KEEP" | cut -d' ' -f2-)

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

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] would delete: $base ($(du -h "$f" | cut -f1))"
    deleted=$((deleted + 1))
  else
    if rm -f "$f"; then
      log "DELETED $base (older than ${RETENTION_DAYS}d)"
      deleted=$((deleted + 1))
    else
      log "DELETE FAILED $base"
      failed=$((failed + 1))
    fi
  fi
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f \
           \( -name 'qtech-sms-backup-*.sqlite' \
           -o -name 'almada-sms-backup-*.sqlite' \
           -o -name 'nova-sms-backup-*.sqlite' \) \
           -mtime "+${RETENTION_DAYS}" -printf '%T@ %p\n' 2>/dev/null \
         | sort -n | cut -d' ' -f2-)

if [ "$failed" -gt 0 ]; then
  log "PRUNE done deleted=$deleted failed=$failed"
  exit 2
fi
log "PRUNE done deleted=$deleted remaining=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name '*-sms-backup-*.sqlite' | wc -l)"
exit 0
