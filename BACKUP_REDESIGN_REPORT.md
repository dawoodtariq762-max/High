# ZOOM SMS — Backup System Redesign

**Date:** 2026-10-08
**Commit:** `297ddf5` (branch `main`)
**Status:** implemented and tested locally. **Not deployed** — awaiting your approval.

---

## 1. What was wrong

`backend/backup.js` ran `VACUUM INTO` on every backup — a byte-complete copy of the
entire database. At the default `BACKUP_INTERVAL_HOURS=3` with `BACKUP_RETENTION_DAYS=30`,
that is roughly **240 concurrent full copies**.

The repo's own `scripts/qtech-diskguard.sh` already documented the arithmetic:

```
DB size     240 copies (3h / 30d default)
 400 MB  ->  93.8 GB          <-- VPS disk is 95.82 GB = FULL
```

That is the ~91 GB now filling the VPS.

Two independent retention paths also used day arithmetic rather than calendar months:
the in-app pruner in `backend/backup.js`, and `scripts/qtech-backup-retention.sh`
(cron, `find -mtime +N`).

---

## 2. Two things this change does NOT do

**It does not repair the 502.** You asked me to keep backup implementation and service
recovery separate, and I have. The backend is not listening on port 4000 and Nginx is
reporting `No space left on device`. Shrinking future backups will not bring the
service back — **the disk has to be cleared first**, and that is a separate step
requiring your approval.

**It cannot be deployed onto a full disk.** SQLite, PM2 and Nginx all need some free
space to operate. Free space before deploying (see §10).

---

## 3. Files changed

| File | Change |
|---|---|
| `backend/backupReduced.js` | **New.** Builds the reduced archive (schema, column lists, build, validate). |
| `backend/backup.js` | `createBackup()` → reduced; `createFullBackup()` added (manual only); retention → 5 calendar months; restore refuses reduced archives. |
| `backend/server.js` | Added `POST /api/backups/create-full` and `GET /api/backups/:file/info`. |
| `scripts/qtech-backup-retention.sh` | Retention rewritten to calendar months (was `-mtime +N` days). |
| `scripts/qtech-diskguard.sh` | Header comment corrected — it described the old `exportBuffer()` behaviour and was misleading. No logic change. |
| `.env.example` | `BACKUP_RETENTION_DAYS` → `BACKUP_RETENTION_MONTHS=5`; added `BACKUP_MIN_KEEP`, `BACKUP_STALE_TMP_HOURS`; documented reduced-vs-full. |
| `package.json` | Added `npm run backup:verify`, `npm run backup:fixture`. |
| `tools/verify-backup-reduced.js` | **New.** 64-check verification suite. |
| `tools/test-restore-guard.js` | **New.** 8-check restore-safety suite. |
| `tools/make-backup-fixture.js` | **New.** Builds a populated test database. |

**Not changed:** the backup interval (still `BACKUP_INTERVAL_HOURS`, default 3), the
PM2 process name, file naming, and all SMPP/provider settings.

---

## 4. What goes into the backup

### Included (12 tables + metadata)

| Table | Fields | Why |
|---|---|---|
| `users` | id, username, password (bcrypt hash), role, name, email, whatsapp, contact, skype, parent_id, active, created_at, payment_type, is_super_manager | Accounts and ownership. **No** `chat_display_name`, no `legal_*`. |
| `range_ref` | id, name, prefix, country, provider, currency, payment_type | Minimal range identity so old SMS still reports by range name. Rates/config excluded. |
| `number_ref` | id, number, range_id, prefix | **Only numbers actually referenced by a retained SMS row** — not the full inventory. |
| `sms_records` | id, number_id, number, range_id, cli, sender_type, is_otp, client_id, agent_id, manager_id, is_test, test_batch_id, source, payout_rate, payout_amount, received_at, payment_type, limit_reason | All counts and payout inputs. **`message` and `otp_code` deliberately omitted.** |
| `sms_daily_stats` | all 7 columns | Pre-aggregated counts/payout sums — compact cross-check. |
| `payment_ledger` | all 12 columns | Per-SMS earnings; the core financial history. |
| `payment_requests_v2` | all 17 columns | Total payable / paid / pending, dates, txid, statuses. |
| `payment_schedule` | all 7 | Payout cycle config. |
| `payment_v2_settings` | all 6 | Payment type labels, minimums. |
| `agent_wallets` | all 5 | Payout destinations needed to read historical requests. |
| `payment_audit_logs` | all 14 | Financial audit trail. |
| `provider_payments` | all 11 | Money paid to carriers (see §8 — judgment call). |
| `backup_meta` | key/value | `format`, `format_version`, `created_at`, `table_counts`, `indexes_included`. |

### Excluded (42 tables)

Chat (6): `chat_attachments`, `chat_conversations`, `chat_credentials`, `chat_lock_prefs`, `chat_messages`, `chat_presence`
API (5): `api_credentials`, `api_integrations`, `api_integration_logs`, `api_integration_seen`, `api_request_logs`
Providers/SMPP (10): `sync_providers`, `sync_logs`, `sync_seen`, `galaxy_providers`, `carrier_settings`, `smpp_connections`, `smpp_logs`, `smpp_outbox`, `smpp_seen`, `provider_payments`→*included, see §8*
Inventory (4): `numbers` (only referenced rows kept), `ranges` (only identity kept), `number_history`, `number_import_batches`
Limits/routing/sharing (5): `cli_limits`, `daily_limit_rules`, `sharing_users`, `sharing_forward_logs`, `range_test_numbers`
Other (12): `complaints`, `complaint_replies`, `branding_settings`, `branding_users`, `app_settings`, `system_security`, `jobs`, `audit_logs`, `activity_ips`, `idempotency_keys`, `webhook_logs`, `failed_sms_queue`, `meta`

Plus, within included tables: `sms_records.message`, `sms_records.otp_code`, `users.chat_display_name`, `users.legal_version`, `users.legal_accepted_at`.

---

## 5. Size reduction

**Measured on a synthetic fixture** (built by `tools/make-backup-fixture.js`), because
the production database is not reachable from here.

| Fixture | Source DB | Reduced | Ratio |
|---|---|---|---|
| 20,000 SMS | 35.8 MB | **7.9 MB** | 22% |
| 20,000 SMS, no indexes | 35.8 MB | **5.5 MB** | 15% |
| 200,000 SMS | 215.7 MB | **71.7 MB** | 33% |

**Indexes are ~30% of the output.** They make the archive directly reportable
(group by number / range / account / date). Set `BACKUP_REDUCED_INDEXES=0` to drop
them and get the smallest file.

**⚠️ These are conservative and not a prediction for your data.** My fixture holds a
fixed amount of excluded bulk (chat, SMPP logs, API logs, number history) while SMS
rows scale, so the ratio *worsens* as SMS volume grows. On your server those excluded
tables also scale with traffic, and — more importantly — your `numbers` master table
is likely far larger relative to the numbers that ever receive an SMS, which is where
the biggest saving lies.

**To get the real number, run this on the VPS against a copy of production:**

```bash
cd /root/qtech-sms
cp --sparse=always backend/data.sqlite /tmp/measure.sqlite   # only if space allows
node tools/verify-backup-reduced.js /tmp/measure.sqlite | tail -8
```

If `/tmp` or the disk is too full for a copy, wait until §10 step 1 has freed space.

---

## 6. Validation results

### `tools/verify-backup-reduced.js` — 64/64 passed

Run against the 20,000-SMS fixture, restoring into an isolated temp database:

- **Build:** created, `integrity_check` = ok, no `.tmp` left, name matches pattern, format marker present.
- **Account parity:** 148 vs 148 users; identical per-role breakdown; identical active count.
- **SMS parity:** 20,000 vs 20,000 total; identical OTP count; **number-wise, range-wise, client-wise, agent-wise and manager-wise counts all identical**.
- **Payout inputs:** 20,000 rows carrying a payout; total `0.036` identical; payout sum identical.
- **Payments:** ledger 20,000 vs 20,000, total `220.468` identical, status breakdown identical; payment requests 60 vs 60, total `29054.82` identical; **paid `10458.96`, pending `10219.03` identical**; account-wise ledger totals identical.
- **Exclusions:** **42/42 excluded tables absent**; `message` and `otp_code` not carried; `chat_messages`, `chat_credentials`, `api_credentials`, `smpp_logs`, `sync_providers` absent.
- **Secrets:** 50 sampled passwords all match the bcrypt `$2*$` pattern; no empty passwords. **No hash, credential or token is ever printed.**
- **Retention:** see §7.
- **Safety:** a file outside the backup directory was untouched, and the source database was byte-identical (SHA-256) afterwards.

### `tools/test-restore-guard.js` — 8/8 passed

- Restoring a reduced archive is **refused** with a clear message.
- The live database is **not** replaced, and no snapshot is taken on a refused restore.
- A legacy backup with no `backup_meta` is still treated as full and **restores normally**.
- A full restore **does** take a full pre-restore safety snapshot first.

### End-to-end through the HTTP API

Against a running server using the real `backend/db.js` wrapper:

```
POST /api/backups/create      -> 200, 7,913,472 bytes, sms_records 20000, payment_ledger 20000
POST /api/backups/create (#2) -> 200, 7,913,472 bytes   (no leftover ATTACH)
GET  /api/backups/:f/info     -> format=reduced, restorable=false, version=1
POST /api/backups/:f/restore  -> HTTP 500, refused with explanation
POST /api/backups/create-full -> 200, 35,794,944 bytes  (== source size, format=full)
```

---

## 7. Five-calendar-month retention test

Calendar arithmetic, not `150 days`. Implemented identically in JS and bash, with
month-end clamping:

| Input | 5 months earlier | Result |
|---|---|---|
| 31 Jul 2026 | 28 Feb 2026 | ✅ clamped |
| 31 Jul 2024 | 29 Feb 2024 | ✅ leap year |
| 15 Jan 2026 | 15 Aug 2025 | ✅ year rolls back |
| 8 Oct 2026 | 8 May 2026 | ✅ |

Behaviour verified end-to-end (both the in-app pruner and the shell script):

- Backup older than the cutoff → **deleted**
- Backup newer than the cutoff → **kept**
- Legacy `almada-sms-backup-*` and `nova-sms-backup-*` → **pruned on the same rule**
- Newest `BACKUP_MIN_KEEP` (default 2) → **kept even when old** (4 old files → 2 survived)
- `.tmp` younger than 24h → **kept** (may be in flight)
- `.tmp` older than 24h → **deleted**
- Unrecognised filename (`important-do-not-delete.sqlite`) → **never deleted**
- Non-backup file (`random-notes.txt`) → **never deleted**
- File outside `BACKUP_DIR` → **never deleted**
- Live database → **never touched** (hash-verified)

Shell script safety guards also confirmed: it refuses to run on a missing directory,
a non-writable directory, or one that looks like application code.

---

## 8. Limitations and judgment calls

1. **A reduced backup cannot restore the running application.** It has no numbers,
   ranges, providers, credentials or configuration. It is a business-records archive
   for reporting and audit, not a disaster-recovery snapshot. `restoreBackup()`
   refuses one outright; use `POST /api/backups/create-full` for DR.

2. **`sms_records.message` and `otp_code` are not backed up** — your choice of
   "drop both". Every count, date, CLI and payout requirement you listed still works,
   but you can no longer look up what an old SMS said, or its OTP code. Reversible by
   adding the two columns to `INCLUDED_TABLES` in `backend/backupReduced.js`.

3. **`provider_payments` is included — please confirm.** Your exclusion list says
   "Providers, provider sync records and sync logs", but this table is a *financial
   ledger* of money paid to carriers, with no credentials. I read "Preserve complete
   financial history" as the stronger instruction. To drop it, remove its entry from
   `INCLUDED_TABLES`.

4. **`sms_daily_stats` is derived data** and technically redundant with `sms_records`,
   which already supports every required count. I kept it because it is compact
   (~43 bytes/row) and self-documenting, but it can be dropped if size matters more.

5. **`number_ref` holds only numbers referenced by retained SMS.** Number history is
   not preserved, per your exclusion list.

6. **Retention will not necessarily free all 91 GB.** It deletes anything older than
   5 calendar months. If most of the 91 GB is more recent than that, much of it will
   stay. You approved pruning everything older than 5 months; if you need the disk
   back faster, a one-time manual prune to a shorter window is a separate decision.

7. **This sandbox has no access to your VPS or your production database.** The code
   matches your environment exactly (`PORT=4000`, `DB_FILE=backend/data.sqlite`,
   PM2 `qtech-sms`, `/root/qtech-sms-backups`), but **I have not measured anything
   against your real data.** §5 gives you the one command that does.

---

## 9. Git — commit and push

> ⚠️ This workspace copy has **no git remote configured** (`git remote -v` is empty),
> so I cannot push from here. Run these on the VPS, or wherever your origin lives.

```bash
cd /root/qtech-sms
git status                      # confirm what is staged
git add -A
git commit -m "Replace full-DB backups with a reduced business-records archive"
git push origin main            # substitute your real branch if it isn't main
```

If the changes were made elsewhere and you are pulling them in:

```bash
cd /root/qtech-sms
git fetch origin
git log --oneline origin/main..HEAD      # what you have that origin doesn't
git push origin main
```

---

## 10. VPS deployment steps  — **NOT RUN, awaiting approval**

### Step 1 — free disk space first (prerequisite)

The service is down because the disk is full. Nothing else will work until there is
room. **This deletes backups older than 5 calendar months** — the policy you approved:

```bash
# Preview exactly what would go. Deletes nothing.
BACKUP_DIR=/root/qtech-sms-backups BACKUP_RETENTION_MONTHS=5 \
  bash /root/qtech-sms/scripts/qtech-backup-retention.sh --dry-run

# Then, once you are happy with the list:
BACKUP_DIR=/root/qtech-sms-backups BACKUP_RETENTION_MONTHS=5 \
  bash /root/qtech-sms/scripts/qtech-backup-retention.sh

df -h /
```

### Step 2 — upload the changes

```bash
# From your local machine (adjust user/host):
rsync -avz --exclude node_modules --exclude .git --exclude data.sqlite \
  /path/to/local/qtech-sms/ root@<VPS_IP>:/root/qtech-sms/

# Or, if the VPS has your git remote:
ssh root@<VPS_IP> 'cd /root/qtech-sms && git fetch origin && git checkout main && git pull origin main'
```

### Step 3 — install dependencies (only `better-sqlite3` matters; it is already there)

```bash
cd /root/qtech-sms && npm install --omit=dev
```

### Step 4 — update `.env`

```bash
cd /root/qtech-sms
cp .env .env.bak.$(date +%F)
# Remove the deprecated day-based setting and set calendar-month retention:
sed -i '/^BACKUP_RETENTION_DAYS=/d' .env
grep -q '^BACKUP_RETENTION_MONTHS=' .env || echo 'BACKUP_RETENTION_MONTHS=5' >> .env
grep -q '^BACKUP_MIN_KEEP='        .env || echo 'BACKUP_MIN_KEEP=2'          >> .env
grep -E '^BACKUP_(RETENTION|MIN_KEEP|INTERVAL|DIR|ENABLED)' .env
```

Leave `BACKUP_INTERVAL_HOURS` as it is.

### Step 5 — PM2 reload with the new environment

**Use `--update-env`, not a bare restart** — a bare restart reuses the old environment
and would keep the deprecated retention setting:

```bash
cd /root/qtech-sms
pm2 restart qtech-sms --update-env
pm2 save
```

---

## 11. Verification commands

### Port 4000, Nginx and application health

```bash
# Is anything listening on 4000?
ss -tlnp | grep ':4000' || echo "NOTHING LISTENING ON 4000"
curl -sS -o /dev/null -w 'direct  -> HTTP %{http_code}\n' http://127.0.0.1:4000/

# Nginx
nginx -t
systemctl status nginx --no-pager -l
curl -sS -o /dev/null -w 'via nginx -> HTTP %{http_code}\n' http://127.0.0.1/

# PM2
pm2 list
pm2 info qtech-sms | grep -E 'status|restarts|uptime|script path'
pm2 logs qtech-sms --lines 60 --nostream

# Disk — must not be at 100%
df -h /
du -sh /root/qtech-sms-backups
```

### Confirm the new reduced backup works

```bash
cd /root/qtech-sms

# Watch the startup backup appear ~15s after restart
pm2 logs qtech-sms --lines 40 --nostream | grep -i backup

# Then create one by hand and inspect it (needs an admin JWT; or use the
# Admin -> Database Backups page in the panel)
ls -lt /root/qtech-sms-backups | head -5

# Verify structure and contents of the newest file without restoring anything:
NEW=$(ls -t /root/qtech-sms-backups/*sms-backup-*.sqlite | head -1)
node tools/verify-backup-reduced.js "$(ls -t /root/qtech-sms/backend/data.sqlite)" | tail -12

# Prove the archive is NOT restorable (the API must refuse):
#   POST /api/backups/<file>/restore  ->  error, "reduced business-records archive"
```

### Confirm automatic retention

```bash
# Dry run from cron's point of view — deletes nothing
BACKUP_DIR=/root/qtech-sms-backups BACKUP_RETENTION_MONTHS=5 \
  bash /root/qtech-sms/scripts/qtech-backup-retention.sh --dry-run

# Confirm the in-app pruner uses calendar months too
pm2 logs qtech-sms --nostream | grep -i 'retention\|deprecated'

# Recommended cron entry (daily at 04:15), if not already present:
# 15 4 * * * BACKUP_DIR=/root/qtech-sms-backups BACKUP_RETENTION_MONTHS=5 \
#   /usr/bin/bash /root/qtech-sms/scripts/qtech-backup-retention.sh >> /root/qtech-logs/backup-cron.log 2>&1
```

---

## 12. Rollback

The reduced format is additive; reverting the code does not invalidate any backup
already written. To go back:

```bash
cd /root/qtech-sms
git revert 297ddf5
pm2 restart qtech-sms --update-env
```

Existing backups — reduced or full — remain readable either way.
