# Q TECH SMS

Multi-level SMS / OTP platform for **Admin › Manager › Agent › Client** (plus a Test panel and
a Payment panel). One Express + SQLite backend, plain HTML panels, no build step.

> Brand: **Q TECH SMS** (exact spelling — do not use any previous panel name).
> The official logo is `assets/qtech-logo.png` (the supplied asset, used unmodified);
> the sidebar/login logo `assets/qtech-logo-square.png` and the favicon
> `assets/qtech-favicon.png` (128×128) are technical conversions of the same file.

---

## 1. What is in the box

| Area | Where |
|---|---|
| Backend API (all logic) | `backend/server.js` (routes, ingest, allocation, rates, limits, payments, providers, backups) |
| Database schema + migrations | `backend/schema.js` (SQLite, created/migrated idempotently on boot) |
| Auth / JWT helpers | `backend/auth.js` |
| SQLite layer | `backend/db.js` (WAL, `foreign_keys=ON`, prepared-statement helpers, batch mode) |
| Panels (13 HTML pages) | `login.html`, `admin.html`, `manager.html`, `agent.html`, `client.html`, `management.html`, `panel-sharing.html`, `payment.html`, `test.html` + 4 portal login pages + `test-login.html` |
| Shared front-end helpers | `api.js` (auth/guard, cached GET, idle logout, gear menu), `assets/qtech.js` (`window.GX` helpers), `assets/dashboard-ui.js` (GXDashboard + QTDashboard), `assets/credit-notes.js`, `assets/number-copy.js` |
| Theme CSS | `assets/qtech.css` (structural + dashboard components), `assets/qtech-light.css` (light theme layers) |
| Optional modules | `backend/fts.js` (FTS5 trigram search, `ALMADA_FTS=1`), `backend/providerSync.js` (provider pull sync), `backend/smppService.js` (SMPP client/server), `backend/backup.js` (snapshots), `backend/exportWorker.js` (CSV export worker) |
| Ops | `scripts/` (install-service, verify-setup, watchdog, diskguard, alert-check, add-crapi-provider), `deploy/` (PM2 split, nginx, litestream, backup verification) |
| Tests | `tests/credit-notes.test.js`, `tests/verify-qtech-cleanup-and-security.js`, `tests/ui-theme.test.js`, `scripts/check-html-scripts.js` (inline-script syntax check for any HTML file) |
| Historical records | `docs/legacy/` — pre-rebrand audit report, workspace notes and the full legacy README, kept unchanged for traceability |
| Release records | `release/*.json`, `release/obsolete-code-paths.txt` — dated change/asset records from the previous codebase (audit trail; not executed by the app) |
| Local tooling | `tools/sync-local-clone.py` (dry-run source copier), `add-provider.sh`, `scripts/*.sh` (ops templates) |

Retired (deliberately removed, do not restore): public email registration, AI Assistant,
Bench Toolkit, historical load/crash harnesses, mobile app/APK, panel-request flow, the
API-Integration pull UI (`/api/api-integrations*` answers **410 Gone**), and the standalone
Chat app (its tables/PIN store remain — they back the payment PIN gate).

---

## 2. Quick start (staging / local)

```bash
node -v                 # requires Node >= 20
npm ci                  # installs better-sqlite3, express, ...
cp .env.example .env    # then set JWT_SECRET, DB_FILE, BACKUP_DIR, ...
node backend/server.js  # http://localhost:4000
```

* On first boot the database is created and seeded: admin `vibepk` / `vibepk123` and the
  Test panel `test` / `test123`. **Change these immediately on any reachable host.**
* Database resolution order: `DB_FILE` → `DATA_DIR/data.sqlite` → `backend/data.sqlite`.
  Always set `DB_FILE` explicitly — a fresh code directory must never silently create a new
  empty database that hides the real one.
* Starting the app mutates the database (`createTables()` migrations + `seed()` + stats
  reconciliation + optional ledger backfill). There is no separate migration command; never
  start the app against an un-backed-up production file.
* The distributable source excludes runtime files (databases, `uploads/`, `exports/`,
  `backups/`, logs, `.env`) — `.gitignore` lists them.

### Going live (PM2, single writer)

```bash
pm2 start ecosystem.config.js   # name: qtech-sms, fork, 1 instance — never cluster
bash scripts/verify-setup.sh    # post-install checks
```

`deploy/ecosystem.config.cjs` splits the process (optional): `qtech-sms-api`
(`ALMADA_ROLE=api`, web only) + `qtech-sms-sync` (`ALMADA_ROLE=sync`, timers only).
Unset `ALMADA_ROLE` (or `all`) runs everything in one process — correct for small VPSes.

---

## 3. Panels and roles

| Panel | Entry | Notes |
|---|---|---|
| Main login | `/panel-login` | role dispatch to the right panel (math captcha) |
| Admin | `/admin` | full tree, ranges/rates, numbers, allocation, providers, exports, backups |
| Manager | `/manager` | agents/clients, allocation down one level, rate card (view), reports |
| Agent | `/agent` | clients, numbers, reports, payments (PIN-gated), self-allocate |
| Client | `/client` | own numbers + SMS/OTP reports, latest-OTP live refresh |
| Management | `/management` | rate management, imports, limit management, carrier, providers, sync, SMPP, logs, backups |
| Panel Sharing | `/panel-sharing` | external panel forwarding (Activity URL / HTTP mapping / SMPP link) |
| Payment | `/payment` | admin payment workspace (approve/reject, credit notes) |
| Test | `/test` | fake SMS injection + test numbers (excluded from reports/payout) |

Role scoping, allocation depth (one level down), rate/payout rules, payment ledger semantics
and the UK (Europe/London) day boundary are **frozen contracts** — see `docs/legacy/AUDIT_REPORT.md` §F.

---

## 4. Key API areas

`POST /api/login`, `GET /api/me` · `/api/users/*` (hierarchy) · `/api/ranges`, `/api/rate-card` ·
`/api/numbers/*` (list/summary/allocate/unallocate/delete/import + jobs) · `/api/sms/paged`,
`/api/sms/report` (grouped CDR), `/api/stats-summary/:by` · `/api/cli-search` ·
`/api/limit-management/*` (range/number/CLI daily limits) · `/api/panel-sharing/*` ·
`/api/payment-v2/*` + `/api/chat/*` (PIN) · `/api/providers-info/*`, `/api/provider-summary` ·
`/api/sync/*` (API providers), `/api/smpp/*` · `/api/carrier-settings`, `/api/incoming-sms`,
`/api/webhook/sms` (ingest) · `/api/exports/*` + `/api/jobs/:id` · `/api/backups/*` ·
`/api/logs/*`, `/api/failed-sms/*`.

Ingest paths converge in one place (`processIncomingSmsPayload`): carrier HTTP
(`POST /api/incoming-sms`, IP allow-list + lock password), the internal webhook
(`POST /api/webhook/sms`), provider sync pull, and SMPP. Dedup, daily limits, ledger rows,
sharing forward and ownership snapshots all happen there.

---

## 5. Tests

```bash
node tests/credit-notes.test.js                    # in-memory DB
node tests/verify-qtech-cleanup-and-security.js   # fixture DB, mocked auth
node tests/ui-theme.test.js                        # theme asset contract
node scripts/check-html-scripts.js manager.html    # inline <script> syntax check (any page)
```

---

## 6. Operations notes (read before deploying)

* **Single writer**: PM2 must stay `fork` + `instances: 1`. Two API processes = duplicate
  ingest/ledger writes, duplicate backups, conflicting SMPP binds.
* **Backups**: `backend/backup.js` writes `qtech-sms-backup-<ts>.sqlite` (default dir
  `~/qtech-sms-backups`, override with `BACKUP_DIR`) every `BACKUP_INTERVAL_HOURS`.
  Snapshots made under earlier brands (`nova-sms-backup-*.sqlite`, `almada-sms-backup-*.sqlite`)
  are still listed, restorable and retention-pruned — only the prefix differs.
* **Locking down ingest**: `POST /api/webhook/sms` is internal and open by default. Set
  `WEBHOOK_SECRET` to require a shared secret (`x-webhook-secret` header, `?secret=` or a
  `secret` body field), and/or block the path at the proxy (see `deploy/nginx-qtech.conf`).
  Exports download with a random, short-lived token (`GET /api/exports/:id/download`).
* **Time**: all day/cycle/limit boundaries are UK wall-clock over UTC timestamps.
* **Secrets**: set `JWT_SECRET` and `CARRIER_LOCK_PASSWORD` in production; never rely on the
  code fallbacks.

### Naming changes from the previous panel (for existing deployments)

| Item | Previous | Now |
|---|---|---|
| PM2 app | `galaxy-sms` / `powerx` (intermediate: `almada-sms`) | `qtech-sms` (`deploy/ecosystem.config.cjs`: `qtech-sms-api`, `qtech-sms-sync`) |
| Process split env | `POWERX_ROLE` (intermediate: `ALMADA_ROLE`) | `ALMADA_ROLE` — kept unchanged for compatibility (`all` \| `api` \| `sync`) |
| FTS toggle | `POWERX_FTS` (intermediate: `ALMADA_FTS`) | `ALMADA_FTS` — kept unchanged for compatibility |
| Export dir default | `~/powerx-exports` (intermediate: `~/almada-exports`) | `~/qtech-exports` (`EXPORT_DIR` overrides) |
| Backup dir default | `~/nova-sms-backups` (intermediate: `~/almada-sms-backups`) | `~/qtech-sms-backups` (`BACKUP_DIR` overrides; legacy files still honoured) |
| Backup file prefix | `nova-sms-backup-` (intermediate: `almada-sms-backup-`) | `qtech-sms-backup-` (legacy prefixes still accepted) |
| Ops scripts / units | `powerx-*` (intermediate: `almada-*`) | `qtech-watchdog`, `qtech-diskguard`, `nginx-qtech.conf`, `qtech-litestream.service` |
| Panel asset files | `assets/galaxy.css`, `assets/galaxy.js`, `galaxy-logo.png`, `galaxy-favicon.png` (intermediate: `almada-*`, `lamix-light.css`) | `assets/qtech.css`, `assets/qtech.js`, `qtech-logo.png`, `qtech-logo-square.png`, `qtech-favicon.png` |

Keep the old values in your existing `.env` only if you adapt them: unset variables fall back
to defaults (`ALMADA_ROLE=all`, FTS off), which is safe but changes nothing else.

---

## 7. Status of this build

This revision is the **Q TECH SMS rebrand + dashboard redesign** phase (Phase 3):

* Rebranded end-to-end from ALMADA SMS to **Q TECH SMS** — UI, page titles, sidebar/login
  branding, the supplied logo + favicon, API response strings, generated filenames
  (exports, import sample, backups), ops scripts, deploy templates and docs.
  Load-bearing identifiers kept for compatibility: `ALMADA_ROLE` / `ALMADA_FTS` env vars,
  the `galaxy_providers` table, and the ops env vars `ALMADA_DB_FILE` / `ALMADA_BACKUP_DIR`.
* Dashboards (Admin / Manager / Agent / Client) rebuilt in the supplied reference style:
  gradient KPI cards (Today / Yesterday / Last 7 Days / This Month), reference-style area
  charts (SMS + Earning, real API data), earning / payout / provider-cost card groups,
  admin inventory & account statistics, no explanatory subtitles, no yearly provider card.
* `/api/dashboard` payout sums are normalised at the source (same as
  `/api/earnings-summary`) so payout cards never show raw float values; additive keys
  `payout_today`, `sms_week`, `active_managers`, `active_agents` were added.
* Detailed Report payout columns are role-correct: Admin "Manager Payout",
  Manager "Agent Payout", Agent "My Payout" + "Client Payout".
* Credit Notes: the ledger-generation status line and the export-instruction hint are gone;
  From/To, Payment Type and Status (Pending / Cleared / Paid) are unchanged.
* Earlier phases (kept in git history): Phase 1 rebrand to ALMADA SMS + bug fixes;
  Phase 2 panel UI redesign per the 19-section spec.
* **Not** part of this phase: the admin "logo update" setting (still not requested).
