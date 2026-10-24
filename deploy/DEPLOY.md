# Deployment templates — review before use

The current authoritative procedure is [the legacy safe-update notes](../docs/legacy/SAFE-UPDATE.md)
plus the runbook in the project README. Do not run an automatic install/restart on an existing
VPS. Inventory the actual code, database, uploads, environment, services and backups first.
Verify a fresh recoverable backup, inspect the startup schema/data updates on a staging copy,
then obtain explicit deployment approval.

What is here:

| File | Purpose |
|---|---|
| `ecosystem.config.cjs` | PM2 model for the optional two-process split: `qtech-sms-api` (`ALMADA_ROLE=api`) and `qtech-sms-sync` (`ALMADA_ROLE=sync`). Fork mode, 1 instance each. |
| `nginx-qtech.conf` | Reverse-proxy template (rate limiting, gzip, 200 MB uploads). Rename placeholders (`qtech-sms.example.com`) before use. The commented block documents blocking the internal `/api/webhook/sms` ingest path at the edge. |
| `litestream/litestream.yml`, `litestream/qtech-litestream.service` | Continuous WAL shipping (S3-compatible + local replica). |
| `verify-backups.sh` | Monthly restore-and-integrity check (cron). |

Notes for operators coming from the previous deployment:

* Renamed units/scripts/env vars are listed in the README ("Naming changes from the previous
  panel"). If you keep old names on the host, keep them consistently (e.g. your own systemd
  units) — this template set uses the new names.
* The backup-file prefix changed to `qtech-sms-backup-*.sqlite`; the retention/listing code
  still accepts the legacy `nova-sms-backup-*.sqlite` files in the same directory, and the
  watchdog/diskguard/verification scripts glob both.
* Never use retired benchmark/crash tests on production. No capacity claim is supplied by this
  release.
