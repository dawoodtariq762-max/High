#!/usr/bin/env bash
# =============================================================================
# Q TECH SMS — install the 3-day backup retention job
# =============================================================================
#   cd /root/qtech-sms && sudo bash scripts/install-backup-retention.sh
#
# What it installs
#   1. A systemd timer that runs qtech-backup-retention.sh daily at 03:17
#      (creates a fresh snapshot, then deletes backups older than 3 days).
#   2. An on-boot run, so retention also applies after a reboot.
#   3. A cron fallback if systemd is unavailable (containers / minimal images).
#
# Idempotent — safe to run again. It never deletes the live database, chat
# uploads, exports, logs or application code.
#
# Override any value with an environment variable, e.g.
#   BACKUP_DIR=/mnt/backups/qtech BACKUP_RETENTION_DAYS=3 \
#     sudo -E bash scripts/install-backup-retention.sh
# =============================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-/root/qtech-sms-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-3}"
MIN_KEEP="${MIN_KEEP:-2}"
DB_FILE="${DB_FILE:-$APP_DIR/backend/data.sqlite}"
LOG_DIR="${QTECH_LOG_DIR:-/root/qtech-logs}"
RUN_SNAPSHOT="${RUN_SNAPSHOT:-1}"      # 1 = also create a daily snapshot here

grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
hdr() { echo; printf '\033[1m=== %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { red "Please run with sudo / as root."; exit 1; }

hdr "1/4  Preparing directories"
mkdir -p "$BACKUP_DIR" "$LOG_DIR"
chmod 700 "$BACKUP_DIR"
chmod +x "$APP_DIR/scripts/qtech-backup-retention.sh"
grn "  backup dir : $BACKUP_DIR"
grn "  log dir    : $LOG_DIR"

ARGS="--snapshot"
[ "$RUN_SNAPSHOT" = "1" ] || ARGS=""

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  hdr "2/4  Installing systemd service + timer"

  cat > /etc/systemd/system/qtech-backup-retention.service <<EOF
[Unit]
Description=Q TECH SMS backup retention (keep ${RETENTION_DAYS} days)
After=network.target

[Service]
Type=oneshot
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=BACKUP_DIR=$BACKUP_DIR
Environment=BACKUP_RETENTION_DAYS=$RETENTION_DAYS
Environment=MIN_KEEP=$MIN_KEEP
Environment=DB_FILE=$DB_FILE
Environment=QTECH_LOG_DIR=$LOG_DIR
ExecStart=/bin/bash $APP_DIR/scripts/qtech-backup-retention.sh $ARGS
EOF

  cat > /etc/systemd/system/qtech-backup-retention.timer <<EOF
[Unit]
Description=Q TECH SMS daily backup + ${RETENTION_DAYS}-day retention

[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true
OnBootSec=10min
RandomizedDelaySec=5min
Unit=qtech-backup-retention.service

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now qtech-backup-retention.timer >/dev/null 2>&1
  grn "  timer enabled (daily 03:17 + 10 min after boot)"
  systemctl list-timers qtech-backup-retention.timer --no-pager 2>/dev/null | sed -n '1,3p' | sed 's/^/  /'

  hdr "3/4  Running it once now (so you can see it work)"
  systemctl start qtech-backup-retention.service
  sleep 2
  tail -n 8 "$LOG_DIR/backup-retention.log" 2>/dev/null | sed 's/^/  /' || ylw "  no log output yet"

  hdr "4/4  Done"
  grn "  Retention: keep ${RETENTION_DAYS} days, always keep newest ${MIN_KEEP}"
  grn "  Logs     : $LOG_DIR/backup-retention.log"
  grn "  Manual   : systemctl start qtech-backup-retention.service"
  grn "  Dry run  : BACKUP_DIR=$BACKUP_DIR BACKUP_RETENTION_DAYS=$RETENTION_DAYS \\"
  grn "               bash $APP_DIR/scripts/qtech-backup-retention.sh --dry-run"
else
  hdr "2/4  systemd not available — installing cron fallback"
  CRON_LINE="17 3 * * * BACKUP_DIR=$BACKUP_DIR BACKUP_RETENTION_DAYS=$RETENTION_DAYS MIN_KEEP=$MIN_KEEP DB_FILE=$DB_FILE QTECH_LOG_DIR=$LOG_DIR /bin/bash $APP_DIR/scripts/qtech-backup-retention.sh $ARGS >> $LOG_DIR/backup-retention.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'qtech-backup-retention.sh' ; echo "$CRON_LINE" ) | crontab -
  grn "  cron installed: daily 03:17"
  echo "$CRON_LINE" | sed 's/^/  /'

  hdr "3/4  Running it once now"
  BACKUP_DIR="$BACKUP_DIR" BACKUP_RETENTION_DAYS="$RETENTION_DAYS" MIN_KEEP="$MIN_KEEP" \
  DB_FILE="$DB_FILE" QTECH_LOG_DIR="$LOG_DIR" \
    bash "$APP_DIR/scripts/qtech-backup-retention.sh" $ARGS 2>&1 | tail -5 | sed 's/^/  /'

  hdr "4/4  Done"
  ylw "  Note: cron does NOT run a missed job after reboot the way 'Persistent=true' does."
  ylw "  Add '@reboot' if you need that: crontab -e"
fi

echo
grn "Backups live in : $BACKUP_DIR"
grn "Logs live in    : $LOG_DIR/backup-retention.log"
echo
