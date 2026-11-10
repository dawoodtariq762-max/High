ZOOM SMS — BACKUP SYSTEM REDESIGN
=================================
Commit 297ddf5 (branch main). Built 2026-10-08.
NOT DEPLOYED. Read this before doing anything.


WHAT THIS IS
------------
Stops every backup from being a full copy of the database. Automatic backups
now write a small archive of business records (users, SMS history, payments).
Full database snapshots become a manual, on-demand action. Retention moves to
5 calendar months.

Before:  ~240 full copies of the database on disk  ->  ~91 GB  (disk full)
After:   small archives, 5-month retention


FILES IN THIS ZIP (mirror the repo layout — extract over /root/qtech-sms)
-------------------------------------------------------------------------
NEW
  backend/backupReduced.js          builds the reduced archive
  tools/verify-backup-reduced.js    64-check verification suite
  tools/test-restore-guard.js       8-check restore-safety suite
  tools/make-backup-fixture.js      builds a populated test database

MODIFIED
  backend/backup.js                 reduced default, manual full backup,
                                    5-calendar-month retention, restore guard
  backend/server.js                 + POST /api/backups/create-full
                                    + GET  /api/backups/:file/info
  scripts/qtech-backup-retention.sh  calendar-month pruning (was -mtime days)
  scripts/qtech-diskguard.sh         header comment corrected only
  .env.example                       BACKUP_RETENTION_MONTHS and friends
  package.json                       + npm run backup:verify / backup:fixture

DOCUMENTATION
  BACKUP_REDESIGN_REPORT.md         full report; read §8 (limitations) and §10


IMPORTANT — READ BEFORE DEPLOYING
---------------------------------
1. This does NOT repair the 502 / downed service. The disk is full. Nothing
   deploys onto a full disk. Free space FIRST (step 2 below).

2. A reduced backup CANNOT restore the running application. It holds no
   numbers, ranges, providers, credentials or configuration. The API refuses
   to restore one. For disaster recovery, use the panel's full-backup action
   (POST /api/backups/create-full).

3. Retention only deletes files OLDER THAN 5 CALENDAR MONTHS. If most of the
   91 GB is more recent than that, it will stay and you will need a separate,
   more aggressive one-time prune to reclaim the disk.

4. sms_records.message and sms_records.otp_code are NOT backed up (as agreed).
   All counts, dates, CLI and payout data are preserved, but you can no longer
   look up what an old SMS said.


INSTALL — RUN THESE IN ORDER
----------------------------
# 0. Back up what is there now
ssh root@<VPS_IP>
cd /root/qtech-sms
cp .env .env.bak.$(date +%F)
mkdir -p /root/rollback-$(date +%F)
cp backend/backup.js backend/server.js /root/rollback-$(date +%F)/
cp scripts/qtech-backup-retention.sh /root/rollback-$(date +%F)/

# 1. FREE DISK SPACE FIRST — preview, deletes nothing
BACKUP_DIR=/root/qtech-sms-backups BACKUP_RETENTION_MONTHS=5 \
  bash scripts/qtech-backup-retention.sh --dry-run
#    then, once you are happy with the list:
BACKUP_DIR=/root/qtech-sms-backups BACKUP_RETENTION_MONTHS=5 \
  bash scripts/qtech-backup-retention.sh
df -h /

# 2. Upload this zip and extract it over the project
#    (from your local machine:)
#      scp qtech-backup-redesign.zip root@<VPS_IP>:/root/
#    (then on the VPS:)
cd /root/qtech-sms
unzip -o /root/qtech-backup-redesign.zip
#    if the zip contains a top-level folder, use:
#      unzip -o /root/qtech-backup-redesign.zip -d /tmp/br
#      cp -r /tmp/br/qtech-backup-redesign/. /root/qtech-sms/

# 3. Dependencies (better-sqlite3 is already present; this is a no-op refresh)
cd /root/qtech-sms && npm install --omit=dev

# 4. Update .env — remove the deprecated day-based setting
cd /root/qtech-sms
sed -i '/^BACKUP_RETENTION_DAYS=/d' .env
grep -q '^BACKUP_RETENTION_MONTHS=' .env || echo 'BACKUP_RETENTION_MONTHS=5' >> .env
grep -q '^BACKUP_MIN_KEEP='         .env || echo 'BACKUP_MIN_KEEP=2'         >> .env
grep -E '^BACKUP_(RETENTION|MIN_KEEP|INTERVAL|DIR|ENABLED)' .env
#    Leave BACKUP_INTERVAL_HOURS as it is.

# 5. Restart PM2 *with --update-env* (a bare restart keeps the old environment)
pm2 restart qtech-sms --update-env
pm2 save


VERIFY AFTER INSTALLING
-----------------------
# Is anything listening on 4000?
ss -tlnp | grep ':4000' || echo "NOTHING LISTENING ON 4000"
curl -sS -o /dev/null -w 'direct -> HTTP %{http_code}\n' http://127.0.0.1:4000/

# Nginx
nginx -t
systemctl status nginx --no-pager -l

# PM2
pm2 list
pm2 logs qtech-sms --lines 60 --nostream

# A reduced backup should appear ~15 seconds after the restart
pm2 logs qtech-sms --nostream | grep -i backup
ls -lt /root/qtech-sms-backups | head -5

# Retention dry run (deletes nothing)
BACKUP_DIR=/root/qtech-sms-backups BACKUP_RETENTION_MONTHS=5 \
  bash /root/qtech-sms/scripts/qtech-backup-retention.sh --dry-run


TEST RESULTS (measured locally on a synthetic fixture)
------------------------------------------------------
  verify-backup-reduced.js   64/64 passed
  test-restore-guard.js        8/8  passed
  shell retention calendar-month test   passed

  Size on a 20,000-SMS fixture: 35.8 MB -> 7.9 MB (22%)
                                        -> 5.5 MB (15%) with BACKUP_REDUCED_INDEXES=0

  NOT measured against your production database — this build had no access to
  the VPS. Run this on the VPS to get the real figure:
      node tools/verify-backup-reduced.js /root/qtech-sms/backend/data.sqlite


ROLLBACK
--------
  cd /root/qtech-sms
  git revert 297ddf5          # or restore from /root/rollback-<date>/
  pm2 restart qtech-sms --update-env

  Backups already written stay readable either way.
