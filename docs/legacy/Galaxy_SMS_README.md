> **Historical record (pre-rebrand).** This file documents the previous workspace and is kept unchanged for traceability. The brand names inside are the old ones.

# Galaxy SMS — Complete Project README (handover document for a new developer / new AI)

**Document version:** 1.0 — written 2026-10-08
**Project version string in code:** `package.json` → `"name": "galaxy-sms-panel", "version": "1.0.0"`
**Code base described here:** the *current working Galaxy SMS panel* as it exists in this clean-source package
(the last frozen reference bundle was `Galaxy-SMS-Latest-OTP-Fix-Source-v7.zip`, 92 entries, sha256 `abdc5afa88573c0d62f221631d4ea197a1e8cb9037f935b0d267385f8bab914f`).
**Intended reader:** an AI/developer with **no previous history of this project**. Everything below was read from the actual code,
the actual live SQLite schema and the actual HTTP behaviour — nothing is guessed from file names.
**Scope of this document:** describe the project exactly as it is. It does **not** propose redesigns or new features.

Companion document in the same package: **`AUDIT_REPORT.md`** — which features work, which are broken/incomplete, what was
removed/abandoned, what is dead code, and what was excluded from this clean package and why.

> ⚠️ **Read section 39 ("Before you modify anything") and section 32 ("Do not touch casually") before changing a single line.**
> This system moves money (SMS payouts), stores OTP traffic, and runs one single-writer SQLite database. Several "obvious
> improvements" break production behaviour.

---

## Table of contents

1. [What Galaxy SMS is](#1-what-galaxy-sms-is)
2. [What it is used for (business purpose)](#2-what-it-is-used-for-business-purpose)
3. [Tech stack](#3-tech-stack)
4. [High-level architecture](#4-high-level-architecture)
5. [Folder / file structure](#5-folder--file-structure)
6. [Purpose of every file](#6-purpose-of-every-file)
7. [Database: tables, columns, relationships](#7-database-tables-columns-relationships)
8. [Users, roles, hierarchy and permissions](#8-users-roles-hierarchy-and-permissions)
9. [Every major feature and how it works](#9-every-major-feature-and-how-it-works)
10. [API endpoints (complete index)](#10-api-endpoints-complete-index)
11. [Frontend routes and pages per panel](#11-frontend-routes-and-pages-per-panel)
12. [Login / session / authentication flow](#12-login--session--authentication-flow)
13. [SMS processing flow (ingest → storage → report)](#13-sms-processing-flow-ingest--storage--report)
14. [Number allocation flow (incl. Range Allocation)](#14-number-allocation-flow-incl-range-allocation)
15. [Reporting flow](#15-reporting-flow)
16. [Payment flow (payment-v2)](#16-payment-flow-payment-v2)
17. [Provider / SMSC flow](#17-provider--smsc-flow)
18. [Business logic: rates, cycles and money calculations](#18-business-logic-rates-cycles-and-money-calculations)
19. [Filters, search and pagination](#19-filters-search-and-pagination)
20. [Export / download](#20-export--download)
21. [Copy-to-clipboard features](#21-copy-to-clipboard-features)
22. [Background / scheduled work](#22-background--scheduled-work)
23. [Webhooks and machine-to-machine integrations](#23-webhooks-and-machine-to-machine-integrations)
24. [Environment variables (complete list)](#24-environment-variables-complete-list)
25. [Installation and local run](#25-installation-and-local-run)
26. [Database setup, migrations and seeding](#26-database-setup-migrations-and-seeding)
27. [Build / start commands](#27-build--start-commands)
28. [Production / VPS requirements](#28-production--vps-requirements)
29. [Known limitations](#29-known-limitations)
30. [Known bugs / known-broken behaviour](#30-known-bugs--known-broken-behaviour)
31. [Intentionally removed / disabled features](#31-intentionally-removed--disabled-features)
32. [Do not touch casually (fragile areas)](#32-do-not-touch-casually-fragile-areas)
33. [Feature dependencies (what breaks if you change X)](#33-feature-dependencies-what-breaks-if-you-change-x)
34. [Security model and considerations](#34-security-model-and-considerations)
35. [Data-loss risks](#35-data-loss-risks)
36. [Performance-sensitive areas](#36-performance-sensitive-areas)
37. [SQLite limits and capacity](#37-sqlite-limits-and-capacity)
38. [Hardcoded values that affect behaviour](#38-hardcoded-values-that-affect-behaviour)
39. [Before you modify anything (checklist)](#39-before-you-modify-anything-checklist)
40. [Feature trace registry: UI → frontend → API → backend → DB](#40-feature-trace-registry-ui--frontend--api--backend--db)
41. [Conventions and gotchas](#41-conventions-and-gotchas)
42. [Quick reference card](#42-quick-reference-card)
- [Appendix A — every registered route](#appendix-a--every-registered-route)
- [Appendix B — table list with row-count context](#appendix-b--table-list)
- [Appendix C — files NOT in this clean package, and why](#appendix-c--files-not-in-this-clean-package-and-why)
- [Appendix D — evidence and verification used for this document](#appendix-d--evidence-and-verification-used-for-this-document)

---

## 1. What Galaxy SMS is

Galaxy SMS is a **multi-tenant, multi-role SMS/OTP aggregation panel**. It is not an SMS *gateway* itself and it does not
send bulk SMS out to end users as its primary job. Its job is:

1. To **receive incoming SMS/OTP traffic** from upstream providers (carriers/SMPP/HTTP partners) into many phone numbers
   that the panel owns and has allocated to its users.
2. To **attribute that traffic** to a hierarchy of users (Admin → Manager → Agent → Client), count it, price it,
   and pay out earnings to the hierarchy according to rate cards.
3. To **let each role see its own slice** of numbers, traffic, earnings, limits and payments through a browser panel,
   and to let Admin control everything (numbers, ranges, providers, users, limits, payments, sharing, monitoring).
4. To optionally **share/re-forward** that same incoming traffic to *external* panels (partner "Panel Sharing"
   users) over HTTP or SMPP.

Single Node.js process + single SQLite file (`better-sqlite3`). No build step, no bundler, no framework — plain HTML
pages with inline JavaScript plus a shared `api.js` helper. That simplicity is deliberate (see `backend/db.js` header:
the project migrated *from* sql.js *to* better-sqlite3 for memory/disk reasons — do not migrate back).

**Branding:** UI shows "GALAXY SMS" with `assets/galaxy-logo.png` / `galaxy-favicon.png`. Some backend files and DB
names still say "Power X"/"powerx"/"nova" (e.g. `ecosystem.config.js`, backup folder default `~/nova-sms-backups`,
`deploy/nginx-powerx.conf`, `scripts/powerx-*.sh`, tables `sync_providers`). **This is intentional legacy naming kept
for compatibility — do not rename it.** (Backups and DB files are found by their *names*.)

## 2. What it is used for (business purpose)

Concretely, a Galaxy SMS installation serves a group of people who each get a share of incoming OTP traffic:

* **Admin** owns the whole system: ranges of numbers, providers, users, limits, payments, master tools, monitoring.
* **Manager** sells/allocates numbers to Agents and Clients, watches their traffic, and receives a payout per OTP.
* **Agent** sells/allocates numbers to Clients, watches traffic, and receives a payout per OTP; agents are also the
  people who request money (payment-v2) and who hold a Binance UID for receiving it.
* **Client** receives OTP traffic on allocated numbers and is billed/priced by the client-side rate.
* **Panel Sharing user** (not a `users.role` — a separate `sharing_users` table) is an external partner panel or an
  SMPP/HTTP link that receives forwarded OTP traffic from shared numbers.
* **Test user** (`role='test'`) exists so incoming traffic can be validated in a sandbox (`/test` panel, "fake SMS"
  injection, test numbers) without touching real earnings.

The commercial logic is therefore: *numbers in → OTPs counted → per-OTP payout computed from a rate card → payouts
matured on a cycle → payment requests settled by Admin → optional forwarding of the same traffic to partners.*

## 3. Tech stack

| Layer | What is used | Notes |
|-------|--------------|-------|
| Runtime | **Node.js ≥ 20** (`package.json` `engines.node`) | verified running on Node 20.20.2 |
| HTTP server | **Express 4.21** (`express`) | all routes in `backend/server.js` + `backend/chat.js` + `backend/creditNotes.js` |
| Database | **better-sqlite3 11.x**, single file, WAL mode | see `backend/db.js`; `synchronous=NORMAL`, `busy_timeout=10s`, 256 MB cache, 1 GB mmap, `case_sensitive_like=ON` |
| Auth | **jsonwebtoken 9** (HS256, 12 h expiry) + **bcryptjs 3** | `backend/auth.js`, edge: PIN/unlock tokens are a *second* JWT type |
| File upload | **multer 1.4** | range/number import (CSV/XLSX) |
| Excel/CSV | **xlsx 0.18** | server-side parse of imported files and (client-side) some exports |
| SMPP | **smpp 0.6.0-rc.4** | `backend/smppService.js` — client (ESME) *and* server (SMSC) mode |
| Config | **dotenv 16** | `.env` in project root; `.env.example` documents every key |
| CORS | **cors 2.8** | `app.use(cors())` — open CORS on the API |
| Frontend | **Plain HTML + inline JS + `api.js`**, CSS in `assets/*.css` | no React/Vue/build tools; each panel is one big `.html` file |
| Process manager | **PM2** (`ecosystem.config.js`, `deploy/ecosystem.config.cjs`) | **must be `fork` mode, `instances: 1`** (single SQLite writer) |
| Replication/backup (optional) | **Litestream** templates in `deploy/litestream/` | plus built-in `VACUUM INTO` backups in `backend/backup.js` |

There is **no test framework** (no jest/mocha). Tests are plain Node scripts under `tests/`.

## 4. High-level architecture

```
                 ┌──────────────────────────────────────────────────────────┐
   Carrier /     │                 Node.js process (PM2 fork, 1 instance)   │
   provider  ──► │                                                          │
   (HTTP push)   │  Express app (backend/server.js, 6.8k lines)             │
                 │   ├── /api/... (~229 routes incl. chat + creditNotes)    │
   Provider  ◄── │   ├── static file serving of ./  (all *.html, api.js,    │
   REST API      │   │      assets/) + SPA catch-all  /<panel>/:page         │
   (HTTP pull)   │   ├── require('./chat')       → PIN + Complaints         │
   ◄── providerSync.js (only if POWERX_ROLE includes 'sync')                │
                 │   └── require('./creditNotes') → read-only statements    │
   SMPP partner  │                                                          │
   (ESME/SMSC) ──┤  smppService.js  (client bind out / server bind in)      │
                 │                                                          │
   Browser ──────┤  static HTML panels + api.js + assets/*.js               │
   (panels)      │                                                          │
                 │  worker_threads: exportWorker.js (CSV exports)           │
                 │  background: retention sweep, backup, sync, SMPP, FTS    │
                 └───────────────────────────┬──────────────────────────────┘
                                             │ better-sqlite3 (single writer, WAL)
                                     backend/data.sqlite  (+ -wal / -shm)
```

Everything converges on **one ingestion function** (`processIncomingSmsPayload`) regardless of the transport:

```
HTTP push  (POST/GET /api/incoming-sms)   ┐
HTTP test  (POST /api/webhook/sms)        ├─► processIncomingSmsPayload() ─► sms_records + sms_daily_stats
SMPP       (smppService.js inbound)       ┘                                    + payment_ledger
                                                                               + webhook_logs / failed_sms_queue
                                                                               + sharing forward (HTTP/SMPP)
```

Panels never call provider APIs; they only read the local DB. Only `providerSync.js` talks to provider REST APIs
(and it is disabled unless `SYNC_ENABLED` / `POWERX_ROLE` says otherwise).

## 5. Folder / file structure

```
<project root>
├── *.html                    13 HTML pages: 8 panels + 5 logins (see §11)
├── api.js                    shared front-end API helper (fetch wrapper, jwt storage, modal, pager, settings menu)
├── assets/                   galaxy.css, lamix-light.css, galaxy.js, dashboard-ui.js, number-copy.js,
│                             credit-notes.js, chat.js, galaxy-logo.png, galaxy-favicon.png, world.svg
├── backend/
│   ├── server.js             THE application: 6 791 lines, 210 app.* routes, all business logic
│   ├── db.js                 better-sqlite3 wrapper: open/pragma/helpers (get, all, run, tx, getDbFile)
│   ├── schema.js             868 lines — creates/migrates all tables & indexes (idempotent, runs at boot)
│   ├── seed.js               creates admin + test account if missing
│   ├── auth.js               JWT sign/verify, authRequired, chatAuthRequired, requireRole, descendantIds, rate limit
│   ├── chat.js               Account Security PIN + Complaints/Ticketing (registers routes on the app)
│   ├── creditNotes.js        read-only Credit Notes (settlement statements) endpoint
│   ├── backup.js             VACUUM INTO / buffer-write backups + retention
│   ├── exportWorker.js       worker_thread CSV exporter (numbers / sms)
│   ├── fts.js                OPTIONAL FTS5 trigram index over sms_records.message (POWERX_FTS=1)
│   ├── providerSync.js       background pull-sync from provider REST APIs (741 lines)
│   ├── smppService.js        SMPP client + server service (964 lines)
│   ├── smppServer.js         ⚠ stub kept for compatibility — referenced by nothing (see AUDIT_REPORT §D)
│   ├── e164-country.json     prefix → country data used by the UI/GX.E164
│   ├── README.md             older backend notes (some endpoint names in it are stale — see AUDIT_REPORT)
│   ├── PROVIDER-SYNC.md      provider sync documentation
│   └── data.sqlite (+ -wal, -shm)   RUNTIME DATABASE — NOT included in this package
├── deploy/                   DEPLOY.md, DEPLOY-URDU.md, ecosystem.config.cjs, nginx-powerx.conf,
│                             litestream/{install-litestream.sh, litestream.yml, powerx-litestream.service},
│                             verify-backups.sh
├── docs/                     FINAL-WORKSPACE.md, SAFE-UPDATE.md, SMPP-GUIDE.md, UI-THEME-IMPLEMENTATION.md
├── release/                  change manifests / verification records (JSON) + obsolete-code-paths.txt
├── scripts/                  ops scripts: install-service.sh, alert-check.js, powerx-watchdog.sh,
│                             powerx-diskguard.sh, verify-setup.sh, check-html-scripts.js, add-crapi-provider.sh
├── tests/                    credit-notes.test.js, ui-theme.test.js, verify-galaxy-cleanup-and-security.js
├── tools/                    sync-local-clone.py (local-only source sync helper, dry-run by default)
├── package.json / package-lock.json   dependencies (no dev dependencies, no build scripts beyond start/dev)
├── ecosystem.config.js       PM2 config at root (mirrors deploy/ecosystem.config.cjs)
├── deploy.sh                 small helper that runs `npm ci` (used by the deploy guide)
├── add-provider.sh           provider onboarding helper script
├── .env.example              every supported environment variable, documented
└── .gitignore                ignores node_modules, *.sqlite*, backups, exports, .env, secrets, *.zip
```

**File counts:** 84 files in this package = **82 project files** + this `Galaxy_SMS_README.md` + `AUDIT_REPORT.md`
(85 files in the original working copy = those 82 + `backend/data.sqlite`,
`data.sqlite-shm`, `data.sqlite-wal`). The `.git` directory of the working copy is VCS metadata and is not part of the package.

## 6. Purpose of every file

### 6.1 Front-end pages (root HTML)

| File | Lines / size | Role it serves | What it is |
|------|--------------|----------------|------------|
| `login.html` | 12.3 KB | public | Single login page used by `/panel-login`, `/login` and `/`. Posts to `/api/login`, stores token, then redirects **by role** to `/admin`, `/manager`, `/agent`, `/client`, `/test`. |
| `management-login.html` | 3.8 KB | admin | Login page for the **Management** (master tools) panel; rejects non-admin client-side after login. |
| `payment-login.html` | 2.7 KB | admin | Login page for the **Payment** panel (payment-v2). Admin-only. |
| `panel-sharing-login.html` | 2.8 KB | admin | Login page for the **Panel Sharing** panel. Admin-only. |
| `test-login.html` | 3.8 KB | test | Login page for the **Test** panel. |
| `admin.html` | 3 438 lines / 290 KB | admin | Largest panel: dashboard, allocation, numbers, test panel, payment mgmt, chat/PIN accounts, complaints, managers/agents/clients CRUD, SMS report, CLI search, SMS detail (CDR), 5 stat pages, provider summary, credit notes. |
| `manager.html` | 1 579 lines / 166 KB | manager | Dashboard, rate card, numbers, bulk allocation, agents, clients, SMS report, SMS detail, stats, CLI search, test panel, credit, complaints, CLI limit (⚠ broken, §30), credit notes. |
| `agent.html` | 2 089 lines / 179 KB | agent | Dashboard, rate card, self-allocation, numbers, test panel, bulk allocation, complaints, clients, SMS report, SMS detail, client/range/number stats, payment, credit notes. |
| `client.html` | 841 lines / 75 KB | client | Dashboard, numbers, stats, complaints, test panel (smallest panel). |
| `management.html` | 3 351 lines / 273 KB | admin | "Master tools": import, rates, CLI limit (⚠ broken), limit management (working), carrier integration, providers, API providers (⚠ dead module), SMPP connections, system logs, backup management. |
| `payment.html` | 58 lines / 11 KB | admin | Thin shell page: mostly loads `api.js`, `assets/credit-notes.js` and payment sections from `api.js` helpers; sections: dashboard, requests, settings, audit, credit notes. |
| `panel-sharing.html` | 1 739 lines / 82 KB | admin | SMPP/HTTP sharing: dashboard, numbers, bulk allocation, sharing users, forward logs, SMPP connections (with embedded SMPP client/server guide text). |
| `test.html` | 226 lines / 17 KB | test | Sandbox: dashboard, numbers, test-send/receive page with fake-SMS injection. |

All panels include, in this order: `assets/galaxy.css`, `assets/lamix-light.css` (except the login pages which use only
`galaxy.css`), then `api.js`, then (per panel) `assets/galaxy.js`, `assets/dashboard-ui.js`, `assets/number-copy.js`,
`assets/chat.js`, `assets/credit-notes.js`.

### 6.2 `api.js` (742 lines) — the front-end/back-end contract

* Token storage: `sessionStorage` first, then `localStorage`, key `ms_token`; role in `ms_role`. `API.logout()` clears all.
* `req(method, path, body, opts)` → `fetch('/api' + path, {...})` with `Authorization: Bearer <token>`;
  parses JSON, throws `Error(message)` on non-2xx so panels can `catch(e){alert(e.message)}`.
* Convenience wrappers: `API.get/post/put/del/delete/upload` (upload uses `FormData` for multer routes).
* **`cachedGet(path)`** — client-side GET cache (~30 s) that the panels use for read-heavy lists. Anything that must be
  fresh bypasses it by appending a cache-buster query (e.g. the P20 live-refresh uses `_gxr=<ms>`).
* UI helpers used by every panel: top-bar **settings menu** (profile, admin security code, carrier password, activity log),
  **modal** open/close (`.modal-overlay.show`), `buildPager()` / pagination rendering, table **column visibility**,
  CSV download helper, and `API.logout()`.
* **Rule:** panels must never `fetch()` a backend URL by hand; always go through `API.*` so the token header, error shape
  and cache-bypass stay consistent.

### 6.3 `assets/*`

| File | Lines | Purpose |
|------|-------|---------|
| `galaxy.css` | 408 | Light-only structural theme (layout, cards, tables, tags, buttons, toast, mobile card-table). Used by all pages. |
| `lamix-light.css` | 265 | Approved cross-panel look for `body.gx-light.gx-lamix`; deliberately **scoped away from login pages**. Contains no permission logic. |
| `galaxy.js` | 553 | `window.GX` helpers: icon set, tooltips, **E.164 country resolution**, dashboard world map (uses `world.svg`), error/empty states, mobile card tables. No business logic, no writes. |
| `dashboard-ui.js` | 181 | Presentation layer for the dashboard: consumes the existing role-scoped `/api/dashboard` response and renders KPIs/charts/rankings. Must not re-label provider cost as earning. Adds a `Credit Notes` shortcut link into the nav it receives. |
| `number-copy.js` | 128 | Per-number **copy control** for numbers tables (`numBody`, `numbersBody`). Pure front-end: reads the rendered row, no API calls, no data change. |
| `credit-notes.js` | 50 | Renders the Credit Notes page inside `payment.html` / admin / manager / agent / payment by calling `GET /api/payment-v2/credit-notes` with filters (cycle from/to, agent, payment type, maturity, page). Read-only. |
| `chat.js` | 230 | Complaints & Ticketing UI **and** the Security-PIN unlock modal. Despite the name, the standalone chat app is gone; this file is what makes `backend/chat.js` routes usable. |
| `galaxy-logo.png`, `galaxy-favicon.png` | — | Branding used by all pages; favicon referenced with `?v=light-20260928` cache-buster. |
| `world.svg` | — | Map used by the dashboard UI (loaded by `galaxy.js`). |

### 6.4 `backend/*`

| File | Lines | Purpose / key exports |
|------|-------|----------------------|
| `server.js` | 6 791 | Everything: middleware, rate limits, static serving, 210 routes, allocation engine, ingest, reporting, payment, sharing, SMPP admin routes, boot sequence. |
| `db.js` | 358 | Opens `DB_FILE`/`DATA_DIR`/`backend/data.sqlite`, sets pragmas, exposes `get/all/run/exec/tx`, `getDbFile()`, tiny prepared-statement cache. |
| `schema.js` | 868 | `createTables()` — creates/extends all tables + indexes; contains column-level migrations (ADD COLUMN when missing). Runs on every boot. |
| `seed.js` | ~40 | Creates `admin` (`vibepk` / `vibepk123` by default, `SEED_ADMIN_USERNAME/PASSWORD` override) and the `test` account (`test`/`test123`) if they do not exist. |
| `auth.js` | ~120 | `sign(user)` → 12 h JWT; `authRequired`, `chatAuthRequired` (rejects chat-scoped tokens), `requireRole(...)`, `descendantIds(user)`, `scopeIds(user)`, per-user API rate limit (1200/min). |
| `chat.js` | 302 | Mounts PIN + complaints routes (see §9.10). |
| `creditNotes.js` | 97 | `mount()`, `statements()`, `addDecimal()` — read-only ledger statements with BigInt decimal maths. |
| `backup.js` | 142 | `runBackup()` etc.: `VACUUM INTO` (fallback: db export buffer), atomic write, retention by days, default dir `~/nova-sms-backups`. |
| `exportWorker.js` | 109 | Worker thread: streams `numbers` or `sms` CSV to `EXPORT_DIR` using keyset batches (20 000 rows), posts progress back. |
| `fts.js` | 108 | Optional FTS5 trigram search index (`POWERX_FTS=1`): `init()`, `startBackfill()`, `matchClause()`, `status()`. |
| `providerSync.js` | 741 | Background provider REST pull-sync; writes `sync_providers`, `sync_seen`, `sync_logs`; feeds the same ingest path. |
| `smppService.js` | 964 | SMPP client (bind to provider) and SMPP server (accept carrier bind) using `smpp`; writes `smpp_connections`, `smpp_seen`, `smpp_logs`, `smpp_outbox`; calls the same ingest function. |
| `smppServer.js` | stub | Legacy stub; **referenced by nothing** — kept only because the release manifest lists it (see AUDIT_REPORT §D). |
| `e164-country.json` | data | Country/prefix table used by `GX.E164` / backend helper for CLI→country display. |
| `backend/README.md`, `backend/PROVIDER-SYNC.md` | docs | Developer notes. **Stale parts exist** (e.g. it documents `GET/POST/DELETE /api/cli-limits`, which no longer exists — §30). |

### 6.5 Operational files

* `deploy/DEPLOY.md` (English) and `deploy/DEPLOY-URDU.md` (Urdu) — VPS deployment steps.
* `deploy/ecosystem.config.cjs` and root `ecosystem.config.js` — PM2 apps: `galaxy-sms` **fork mode, instances 1**.
* `deploy/nginx-powerx.conf` — nginx reverse-proxy template (keep the proxy's IP forwarding headers for rate limits and
  `source_ip` logging to stay meaningful).
* `deploy/litestream/*` — optional continuous SQLite replication to object storage.
* `deploy/verify-backups.sh`, `scripts/alert-check.js` — backup/monitoring checks (`ALERT_URL`, `TELEGRAM_*`).
* `scripts/install-service.sh` (systemd/pm2 install), `scripts/powerx-watchdog.sh` (process watchdog),
  `scripts/powerx-diskguard.sh` (disk-space guard), `scripts/verify-setup.sh`, `scripts/check-html-scripts.js`
  (**per-file** inline-JS syntax check — takes an HTML file as its argument, e.g. `node scripts/check-html-scripts.js admin.html`;
  run it once per edited page, a genuinely useful pre-flight check), `scripts/add-crapi-provider.sh`
  (dev helper for provider presets).
* `docs/FINAL-WORKSPACE.md` (workspace/cleanup record), `docs/SAFE-UPDATE.md` (safe local update + VPS deploy guide),
  `docs/SMPP-GUIDE.md` (SMPP setup), `docs/UI-THEME-IMPLEMENTATION.md` (theme pass record).
* `release/*.json` — machine-readable change records (what each approved change touched, with hashes) plus
  `release/source-manifest.json` (the distributable file list used by `tools/sync-local-clone.py`) and
  `release/obsolete-code-paths.txt` (**the explicit list of files that were deliberately removed earlier — never
  re-create them**).
* `tests/*` — see §39.4.
* `tools/sync-local-clone.py` — copies exactly the files in `release/source-manifest.json` into a *separate* local clone
  and deletes exactly the paths in `release/obsolete-code-paths.txt`; dry-run unless `--apply --confirm-local-clone`.
  It refuses: `.git`, `node_modules`, `data/`, `backups`, `exports`, `.env*`, `*.sqlite*`, keys, absolute paths, `..`.

---

## 7. Database: tables, columns, relationships

**Engine:** SQLite via `better-sqlite3`. **File resolution order:** `DB_FILE` → `DATA_DIR/data.sqlite` → `backend/data.sqlite`.
The runtime file plus `-wal` and `-shm` are **never** part of a source package (`.gitignore` covers `*.sqlite*`).

**Pragmas set in `backend/db.js`:** `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=10000`,
`cache_size=-262144` (≈256 MB), `mmap_size=1073741824` (1 GB), `case_sensitive_like=ON`, foreign keys **not** enforced
(there are no `FOREIGN KEY` clauses in the schema — referential integrity is enforced in code).

**Counts:** a fresh database created by `schema.js` (verified by booting this package on an empty file) contains
**43 application tables** and **74 explicit indexes** (SQLite adds its own auto-indexes for PK/UNIQUE constraints on top).
An older production database (verified: a real one in the working copy) contains **51 application tables** because 8 tables from
removed features are deliberately kept and **never dropped**:
`chat_conversations`, `chat_messages`, `chat_message_deletions`, `chat_device_tokens`, `channel_posts`, `channel_reads`,
`assistant_knowledge`, `assistant_settings`. Do not drop them silently — they are historical data (§31, §35).

### 7.1 Table groups and key relationships

**Identity / hierarchy**

| Table | Key columns | Purpose & relationships |
|-------|-------------|-------------------------|
| `users` | `id` PK, `username` (unique in practice), `password` (bcrypt), `role` ∈ `admin|manager|agent|client|test`, `parent_id`, `active`, `payment_type`, `is_super_manager`, `legal_version`, `legal_accepted_at` | The hierarchy is a **self-referencing tree** via `parent_id`: admin → manager → agent → client (a manager's parent is the admin; agent's parent is a manager *or* the admin; client's parent can be manager/agent/admin). `descendantIds()`/`scopeIds()` walk this tree. |
| `chat_credentials` | `user_id` PK → `users.id`, `chat_password_hash`, `chat_enabled`, `failed_attempts`, `locked_until` | Per-user **Account Security PIN** (legacy name from the removed chat app). Also used to gate the agent payment section. |
| `system_security` | `id=1`, `admin_security_code`, `carrier_lock_password` | Admin "security code" required for admin password changes + carrier integration lock password. |
| `activity_ips` | `provider_name`, `ip`, `enabled` | Allow-list of provider IPs (used by carrier integration checks in the UI/logs). |
| `audit_logs` | `user_id`, `username`, `role`, `action`, `module`, `details`, `ip` | Written by `logAction()` on nearly every mutation; surfaced in the UI "Activity Log". |

**Numbers / ranges**

| Table | Key columns | Purpose & relationships |
|-------|-------------|-------------------------|
| `ranges` | `id`, `name`, `prefix`, `currency`, `provider`, `country`, `rate_1_1/7_1/7_7/30_45` (client-side cycle rates), `provider_rate_1_1/7_1/7_7/30_45` (provider cost), `payment_type`, `cli_limit`, `range_start`, `range_end`, `status`, `deleted_at`, `self_alloc_enabled`, `self_alloc_max`, `self_alloc_periods`, `pattern` | A range is the "product": a block of numbers + its rate card + optional provider link + per-range daily limits. `numbers.range_id` → `ranges.id`. Provider name here is what the Provider Summary uses. |
| `numbers` | `id`, `range_id`, `number` (unique index), `prefix`, `rate`, `payterm`, `payout`, `manager_rate`, `agent_rate`, `client_rate`, `manager_id`, `agent_id`, `client_id`, `sd_limit`, `sw_limit`, `import_batch_id`, `import_source`, `imported_by`, `imported_at`, `alloc_source`, `pattern` | The central inventory row. **Ownership = three nullable FK columns** to `users` (manager/agent/client). `rate` overrides the range rate for this number; `payterm` overrides the cycle; `payout` is the **client-side rate** used for the CDR "CLIENT PAYOUT" column. `alloc_source` records how it was allocated (`manual`, `bulk`, `self`, `sharing`, …). |
| `number_history` | `number_id`, `number`, `action`, `from_owner`, `to_owner`, `details`, `user_id` | Audit trail of allocation/unallocation/delete/move. |
| `number_import_batches` | `batch_id`, `range_id`, `file_name`, `total`, `inserted`, `skipped`, `status`, `error`, `deleted_at` | One row per import; `numbers.import_batch_id` links rows back so an import can be undone as a batch. |
| `range_test_numbers` | `range_id`, `test_number`, `label`, `active` | Numbers used by the Test panel for a range. |
| `cli_limits` | `cli`, `type` (`overall|specific`), `manager_id`, `limit_val`, `used` | **Legacy** per-CLI limit table. The *live* limit engine uses `daily_limit_rules`; `cli_limits` has no working API any more (§30). |

**SMS records / statistics**

| Table | Key columns | Purpose & relationships |
|-------|-------------|-------------------------|
| `sms_records` | `id`, `number_id`, `number`, `range_id`, `cli`, `sender_type`, `message`, `otp_code`, `is_otp`, `client_id`, `agent_id`, `manager_id`, `is_test`, `test_batch_id`, `source`, `payout_rate`, `payout_amount`, `received_at` (UTC), `payment_type`, `limit_reason` | The traffic table: one row per received SMS. `manager_id/agent_id/client_id` are **snapshots of ownership at receipt time** — that is why unallocating a number does not change old reports. `payout_amount` is the authoritative earned amount for that row (may be `0` when a limit rule zeroed it — see `limit_reason`). |
| `sms_daily_stats` | PK `(stat_date, manager_id, agent_id, client_id, cli)`, `sms_count`, `payout_sum` | Pre-aggregated counters, incrementally maintained by ingest and reconciled at boot; the dashboard reads **this** table, never `sms_records` (§15, §36). |
| `webhook_logs` | `status`, `number`, `matched_number`, `cli`, `message`, `raw_payload`, `error`, `source_ip` | Every ingest attempt (accepted, unmatched, duplicate, error). |
| `failed_sms_queue` | `number`, `cli`, `message`, `raw_payload`, `error`, `status`, `retry_count` | Ingest rows that could not be stored/matched; admin can retry/dismiss. |
| `meta` | `key` PK, `value` | Internal bookkeeping: `numbers_ver` (cache-busting version for number caches), `stats_backfill_*`, `p19k_stats_reconciled`, FTS keys, etc. |

**Payment / earnings**

| Table | Key columns | Purpose & relationships |
|-------|-------------|-------------------------|
| `payment_ledger` | `sms_record_id`, `agent_id`, `manager_id`, `range_id`, `payment_type`, `amount` (decimal string), `earned_at`, `cycle_key`, `eligible_at`, `status`, `request_id` | One earning entry per SMS payout that is owed to an agent (or manager, depending on configuration). `cycle_key` groups by cycle, `eligible_at` = maturity date; `status` ∈ `pending|requested|paid|…`; `request_id` → `payment_requests_v2.id`. |
| `payment_requests_v2` | `agent_id`, `manager_id`, `payment_type`, `amount`, `wallet_address`, `binance_uid`, `status`, `requested_at`, `paid_at`, `rejected_at`, `processed_by`, `txid`, `screenshot_url`, `admin_notes`, `reject_reason` | Agent withdrawal requests and Admin processing. |
| `agent_wallets` | `agent_id` PK, `wallet_address`, `network`, `binance_uid` | Where an agent wants to be paid (BINANCE UID model). |
| `payment_v2_settings` | `payment_type` PK, `label`, `min_withdrawal`, `active`, `sort_order` | Per-cycle **minimum withdrawal** and enable/disable switches. |
| `payment_schedule` | `payment_type` PK, `weekly_start_dow`, `weekly_pay_dow`, `monthly_start_day`, `monthly_delay_days` | When cycles start and when they are payable (UK wall-clock semantics). |
| `payment_audit_logs` | `actor_id/name/role`, `action`, `request_id`, `agent_id`, `amount`, `wallet_address`, `status`, `details` | Every payment action by an admin/manager. |
| `payment_notifications_v2` | `agent_id`, `request_id`, `event`, `message`, `read_at` | In-panel notifications for the agent. |

**Sharing / SMPP / providers / integration**

| Table | Key columns | Purpose & relationships |
|-------|-------------|-------------------------|
| `sharing_users` | `agent_user_id`, `panel_name`, `user_name`, `username`, `attribute_url`, `active`, `connection_type` (`http|smpp`), `http_config` (JSON), `smpp_connection_id` | External partner "panel sharing" accounts. `connection_type` decides whether forwarding happens over HTTP or through an SMPP connection. `http_config` holds URL/auth data and is **masked in API responses** (`sharingPublic()`). |
| `sharing_forward_logs` | `sharing_user_id`, `sms_record_id`, `url`, `status`, `error`, `response_preview`, `connection_type` | Result of each forward attempt. |
| `smpp_connections` | 29 columns: `mode` (`client|server`), `host`, `port`, `system_id`, `password`, `bind_type`, `listen_port`, `allowed_ips`, `enquire_link_seconds`, `reconnect_seconds`, timeouts, `default_source_addr`, counters (`total_received`, `total_sent`), `status`, `last_error` | SMPP link configuration + runtime state. |
| `smpp_seen` / `smpp_outbox` / `smpp_logs` | `(connection_id, dedup_key)` unique / outbound queue / event log | Dedup, outbound MT queue (used by `/api/smpp/connections/:id/send`), diagnostics. |
| `api_integrations`, `api_integration_seen`, `api_integration_logs` | integration config / dedup / logs | **Removed module** (HTTP *pull* integrations). Routes return **410 Gone**; tables are retained for dedup keys and history. HTTP *push* ingestion (`/api/incoming-sms`) remains fully active. |
| `galaxy_providers` | `name`, `payment_term`, `currency`, `rate`, `payment_method`, `status`, `conn_type` | Provider master list used by the Providers page and Provider Summary. |
| `provider_payments` | `provider_id`, `provider_name`, `amount`, `currency`, `paid_at`, `prev_unpaid`, `remaining_unpaid`, `period` | Payments made *to* the provider (cost side). |
| `sync_providers`, `sync_seen`, `sync_logs` | connector config / dedup / run logs | Background pull-sync bookkeeping (`providerSync.js`). |
| `carrier_settings` | `integration_status`, `carrier_ip`, `http_callback_url`, `api_key`, `auth_token`, `notes`, `retention_days` | Carrier (upstream) settings for the HTTP ingress + carrier lock. |
| `daily_limit_rules` | `limit_type` ∈ `range|range_number|cli|number`, `range_id`, `cli`, `number`, `daily_limit`, `active` | The **live** OTP limit engine: when today's (UK date) count for the rule's target reaches `daily_limit`, further OTPs get `payout_amount = 0` and a `limit_reason`. |
| `jobs` | `id` (`EXP-…`), `type`, `status`, `progress`, `processed`, `total`, `payload_json`, `result_json`, `error`, `created_by` | Background jobs (currently: CSV exports). |
| `idempotency_keys` | `key` PK, `user_id`, `endpoint`, `response_json`, `expires_at` (7 days) | Makes allocate/import style POSTs safely retryable. |
| `complaints`, `complaint_replies` | `sender_id`, `subject`, `body`, `status`, `status_updated_by` / `complaint_id`, `sender_id`, `body` | Complaints/ticketing (manager/agent/client → admin). |

### 7.2 Relationship summary (the ones that matter)

```
users(parent_id) ──┬─► numbers.manager_id / agent_id / client_id      (current ownership)
                   ├─► sms_records.manager_id / agent_id / client_id  (ownership snapshot per SMS)
                   ├─► sms_daily_stats.manager_id / agent_id / client_id
                   └─► payment_ledger.agent_id / manager_id

ranges ──┬─► numbers.range_id        ranges.provider ⟶ galaxy_providers.name (soft link)
         ├─► sms_records.range_id
         ├─► daily_limit_rules.range_id
         └─► range_test_numbers.range_id

sms_records ──► payment_ledger.sms_record_id        (earning created by ingest)
payment_ledger ──► payment_requests_v2.request_id   (ledger rows claimed by a withdrawal request)
numbers.import_batch_id ──► number_import_batches.batch_id
sharing_users.smpp_connection_id ──► smpp_connections.id
```

There are **no database-level foreign keys**; a deleted user/range leaves orphan-pattern rows in reports by design
(reports use the *stored snapshot columns*, so history keeps working). Any "cleanup" that deletes history rows destroys
financial evidence — see §35.

---

## 8. Users, roles, hierarchy and permissions

### 8.1 The five roles

| Role | Can open panel | Scope of data it can see | Notes |
|------|----------------|--------------------------|-------|
| `admin` | `/admin`, `/management`, `/payment`, `/panel-sharing`, `/test` | Everything | Only role that can use Management/Payment/Sharing panels (enforced **server-side** with `requireRole('admin')` on those APIs, and client-side by a redirect after login). |
| `manager` | `/manager` | Own allocated numbers + everything below (`agent`, `client` in its subtree) | Payout rate = cycle rate from its allocation; can allocate/return numbers to agents/clients, see manager-level stats/payments. |
| `agent` | `/agent` | Own allocated numbers + client subtree | Agent is the *earning* role: `payment_ledger.agent_id`, withdrawal requests, Binance UID, Security-PIN gate on the payment section. |
| `client` | `/client` | Only the numbers allocated to it, its own stats | Read-only traffic view; owns no allocation powers. |
| `test` | `/test` | Only test numbers / test SMS (`is_test=1`) | Sandbox account created by `seed.js` (`test`/`test123`). Test traffic is excluded from payouts and normal reports. |

### 8.2 Hierarchy mechanics

* `users.parent_id` builds the tree: `admin → manager → agent → client` (a client's parent may be an agent, a manager or the admin).
* `backend/auth.js` exposes:
  * `descendantIds(user)` — every user id in the subtree below the caller.
  * `scopeIds(user)` — the caller plus descendants (used by list filters).
  * `requireRole(...roles)` — route guard used on ~most routes (see Appendix A for each route's guard).
* **Allocation depth rule (enforced in `handleAllocate`):** a user may allocate numbers only **one level down**
  (admin → manager/agent/client, manager → agent/client, agent → client). Self-allocation for agents is a separate,
  opt-in feature controlled per range (`self_alloc_enabled`, `self_alloc_max`, `self_alloc_periods`).
* **Scope enforcement in queries:** `numberScopeWhere(user)` and `smsScopeWhere(user)` translate the caller's role into
  `manager_id=?` / `agent_id=?` / `client_id=?` clauses; `statsScope(user)` does the same for `sms_daily_stats`.
  Any new endpoint that returns numbers or SMS **must** use these helpers (or an equivalent) — this is the core of the
  permission model.
* `is_super_manager` (users column) marks a manager that may see/act across the admin's whole tree in specific
  manager-panel features.
* `active=0` blocks login (`/api/login` → 403) but keeps history.

### 8.3 Account states / additional gates

| Gate | Where | Behaviour |
|------|-------|-----------|
| Account disabled | `users.active=0` | Login refused (403). |
| Legal acceptance | `users.legal_version`, `legal_accepted_at` + `/api/legal/status`, `/api/legal/accept` | Policy version hardcoded `2026-09-13-v1`; the UI shows an acceptance gate; server stores the version the user accepted. |
| Security PIN (agents) | `chat_credentials` + `requireAgentChatUnlock` | Agent payment endpoints and Credit Notes return **403 `{locked:true}`** until the front-end sends a valid `x-chat-unlock-token` (12 h JWT issued by `POST /api/chat/auth/verify-lock`). 5 wrong attempts → 15-minute lock (`locked_until`). |
| Admin security code | `system_security.admin_security_code` | Required by `/api/profile` when an **admin** changes its own password, and settable via `PUT /api/admin-security-code`. |
| Carrier lock password | `system_security.carrier_lock_password` | Gates carrier integration changes (`PUT /api/carrier-lock-password` + carrier settings routes). |
| Login rate limit | `loginRateLimit` | 10 attempts / 5 min / IP → HTTP 429 with `Retry-After`. |
| API rate limits | `apiRateLimit`, `heavyWriteLimit`, `smsIngestLimit` | 1200/min/IP general (excl. `/api/health`, `/api/login`, `/api/incoming-sms*`), 120/min/IP for non-GET `/api/numbers*`, 12000/min/IP for the carrier ingress. |

## 9. Every major feature and how it works

Each feature below gives: **where it lives (files)** → **routes** → **tables** → **flow** → **what must not break**.

### 9.1 Login, role routing and panel shells

* **Files:** `login.html`, `*-login.html`, `api.js`, `backend/server.js` (`/api/login`, `/api/me`), `backend/auth.js`.
* **Routes:** `POST /api/login` (loginRateLimit) → `{token, user}`; `GET /api/me` (authRequired).
* **Tables:** `users`, `audit_logs` (login is logged).
* **Flow:** panel posts username/password → server compares bcrypt hash → signs a 12 h JWT `{id, username, role}` → front-end
  stores it under `ms_token`/`ms_role` and redirects: admin → `/admin`, manager → `/manager`, agent → `/agent`,
  client → `/client`, test → `/test`. The four special panels do a client-side role check after login and bounce
  non-admins back to `/panel-login`.
* **Must not break:** token payload shape (panels decode `ms_token` client-side in `assets/chat.js` to learn the user id/role!),
  the `{token,user}` response keys, and the role→panel mapping.

### 9.2 Dashboards

* **Files:** each panel's `loadDashboard()` + `assets/dashboard-ui.js` + `backend/server.js` `/api/dashboard`.
* **Routes:** `GET /api/dashboard` (authRequired, role-scoped, `cachedJson` 10 s, cache key versioned by meta `numbers_ver`).
* **Tables:** `sms_daily_stats` (primary), `numbers` (counters).
* **Flow:** the endpoint computes today / yesterday / last-7-days / month counts and payout sums from `sms_daily_stats`
  using **UK dates** (`ukTodayDateStr`, `Europe/London`) plus number counters, and returns one object; `dashboard-ui.js`
  only *renders* it. Provider cost is never re-labelled as earning.
* **Must not break:** the response's existing keys (dashboard-ui maps them), the `sms_daily_stats` aggregation contract,
  and the cache version key (`numbers_ver` must be bumped when number state changes materially — the delete/allocate
  paths already do this).

### 9.3 SMS Numbers inventory (list / filter / allocate / return / delete / move / import / export)

* **Files:** `admin.html`, `manager.html`, `agent.html`, `client.html` (numbers tables: `numBody`, `numbersBody`),
  `assets/number-copy.js`, backend `handleAllocate` + `/api/numbers*`.
* **Routes (main):** `GET /api/numbers` (two variants — legacy/public-ish and scoped; see Appendix A), `GET /api/numbers/summary`,
  `POST /api/numbers/allocate`, `POST /api/numbers/unallocate`, `POST /api/numbers/delete`, `POST /api/numbers/move-to-test`,
  `POST /api/numbers/delete-filtered`, `DELETE /api/numbers/all`, `DELETE /api/numbers/range/:rangeId`,
  `POST /api/numbers/unallocate-by-range`, `POST /api/numbers/smart-divide`, `POST /api/numbers/import`,
  `POST /api/numbers/import-file` (multer), `GET /api/numbers/import-jobs/:jobId`, `GET /api/number-import-batches`,
  `DELETE /api/number-import-batches/:batchId`, `DELETE /api/numbers/imported-all`, `GET /api/number-jobs/:jobId`.
* **Tables:** `numbers`, `number_history`, `number_import_batches`, `meta`, `idempotency_keys`.
* **Flow (allocation):** request `{range_id|range, ids[]|count|pattern, to_user_id|to_role, force?}` →
  `handleAllocate` (one big transaction): validate caller scope → resolve target user (one level down) →
  select candidate numbers with a temp-table id batch → update `manager_id/agent_id/client_id` (+`alloc_source`) →
  write `number_history` → bump `meta.numbers_ver` → respond with counts. Idempotency keys (`idempotency_keys`, 7-day TTL)
  make retries safe. `force` allows taking over numbers already owned below the caller when the UI asks for it.
* **Return/unallocate:** clears ownership **downward** from the caller's level only, never touches old `sms_records`
  snapshots. **Delete** is admin-only (`requireRole('admin')`) and different from unallocate — never conflate them.
* **Import:** CSV/XLSX → header mapping → validation (prefix/range/duplicates) → batched inserts (`IMPORT_BATCH_SIZE`) →
  `number_import_batches` record; large files can run as jobs with progress (`/api/numbers/import-jobs/:jobId`).
* **Must not break:** the ownership columns and their scope filters, `number_history` writing, `numbers_ver` bumping,
  and the distinction unallocate / move-to-test / delete.

### 9.4 Range Allocation, rate cards and range management

* **Files:** Ranges pages in `manager.html` (rateCard), `management.html` (rates/import), `admin.html`.
* **Routes:** `GET /api/ranges`, `GET /api/rate-card`, `POST /api/ranges`, `POST /api/ranges/bulk-create`,
  `POST /api/ranges/import`, `POST /api/ranges/import-file`, `GET /api/range-import-batches`, plus
  `POST /api/providers-info/assign-range` (attach a provider to a range).
* **Tables:** `ranges`, `range_test_numbers`, `numbers` (via `range_id`), `daily_limit_rules`.
* **Flow:** a range = prefix + rate card (`rate_1_1`, `rate_7_1`, `rate_7_7`, `rate_30_45` for the client side and
  `provider_rate_*` for provider cost) + optional provider + optional limits. Bulk-create/import creates many ranges at
  once from a file. **Range allocation** in the UI means allocating *the numbers of a range* to a user (see 9.3) — the
  range itself is never "given away".
* **Must not break:** rate columns (money), `ranges.payment_type` default cycle, `ranges.provider` naming used by
  Provider Summary, and the numbers↔range link.

### 9.5 Number-level settings (rate override, payterm, limits, copy)

* **Routes:** `GET /api/numbers` (per-row fields), `POST /api/numbers/update`-style writes inside the numbers pages,
  `GET /api/logs/number-history`.
* **Tables:** `numbers.rate` (override of the range cycle rate), `numbers.payterm` (per-number cycle override),
  `numbers.payout` (client-side rate shown as "CLIENT PAYOUT"), `numbers.sd_limit` / `sw_limit` (per-number daily/weekly caps).
* **Flow:** the numbers grid renders values; per-number edits go through scoped endpoints and are logged.
  `assets/number-copy.js` adds a pure front-end copy button to the number cell (no API, no write).
* **Must not break:** the precedence rules in §18 (number override → user default → range default) and the fact that
  `payout` is a **client-side rate**, never a provider cost.

### 9.6 Reports: SMS list, Detailed Report (CDR), statistics pages

* **Files:** `admin.html`/`manager.html`/`agent.html`/`client.html` report pages (`smsReport`, `smsDetail`, `*Stats`,
  `dashboard-ui.js`), backend `/api/sms/paged`, `/api/sms/report`, `/api/stats-summary/:by`, `/api/sms/clis`,
  `/api/sms/numbers`, `/api/sms` (legacy list), `/api/stats/:by` (legacy).
* **Tables:** `sms_records` (source), `sms_daily_stats` (aggregates), `ranges`, `numbers`.
* **Flow (list):** `buildSmsPagedQuery(user, query)` builds ONE SQL fragment used by every report endpoint: role scope +
  all filters (date/time window, CLI, number, range, manager/agent/client, provider [admin only], message search,
  `number_like`/`cli_like`) + ordering `s.received_at DESC, s.id DESC` (`smsPagedOrderSql`). Paged responses are streamed
  (`sendPagedStreaming`) so large pages do not blow memory. Row caps: `ROLE_PAGE_MAX = {admin:100000, manager:5000,
  agent:5000, client:500, test:500}`, `'All'` only for admin (200 000).
* **Flow (CDR/SMS Detail):** `GET /api/sms/report?group=day,range,cli,…` groups by any of
  Hour/Day/Month/Range/Number/CLI/Client/Agent/Manager/Currency/Provider, returns SMS count + MY PAYOUT
  (`sms_records.payout_amount`) + CLIENT PAYOUT (`numbers.payout`) + totals + server-side pagination. Dimensions the
  caller's role may not aggregate (provider/manager → admin only; agent → admin+manager; client → admin+manager+agent)
  are **silently dropped server-side**.
* **Time buckets:** all date bucketing uses **Europe/London wall-clock** (`ukDateExpr*`, `ukOffsetSegments`) because SMS
  timestamps are stored UTC. DST transitions are handled by splitting the window into offset segments.
* **P20 live refresh:** Agent + Client CDR/Detail views poll `GET /api/sms/paged?page=1&limit=1&sort=date&dir=desc`
  every **8 s**, and only refresh when the newest id or the scoped total changes. The poll appends `_gxr=<ms>` to bypass
  both the front-end `cachedGet` and the backend `cachedJson`.
* **Must not break:** `buildSmsPagedQuery` (single source of truth for filters/scope), the `received_at DESC, id DESC`
  ordering, the role caps, the UK-time conversion, and the P20 cache-buster pattern.

### 9.7 CLI Search (analytics per CLI)

* **Routes:** `GET /api/cli-search/suggestions?q=`, `GET /api/cli-search?cli=&from=&to=`.
* **Tables:** `sms_records`, scoped by `cli` + role.
* **Flow:** type-ahead suggestions (source CLI list) then a summary per CLI: today / yesterday / last 7 / month, or a
  custom period (`custom_date` flag), plus a per-range breakdown. Agent CLI search is limited to the agent's own CLIs.
* **Must not break:** the query-parameter names (`cli`, `from`, `to`) and the response keys
  (`summary.{today,yesterday,last7,month,selected_period}`, `ranges[]`, `custom_date`) — three panels parse them.

### 9.8 Test panel and test traffic

* **Routes:** `GET /api/test-panel/dashboard`, `GET /api/test-panel/sms`, `POST /api/test-panel/fake/default`,
  `POST /api/test-panel/fake/custom`, `DELETE /api/test-panel/fake`, `GET/POST/DELETE /api/test-numbers*`,
  `POST /api/test-numbers/import`, `POST /api/test-numbers/delete`, `POST /api/test-numbers/move-to-numbers`.
* **Tables:** `range_test_numbers`, `numbers`, `sms_records` (with `is_test=1`, `test_batch_id`).
* **Flow:** test numbers belong to a range; the test page can inject a fake SMS (default or custom payload) which flows
  through the *same* ingest function but is stored with `is_test=1`, excluded from real reports and from payout
  calculations, and can be purged (`DELETE /api/test-panel/fake`). Test numbers can be promoted into real numbers.
* **Must not break:** the `is_test` filter everywhere (reports, dashboard, payout) and the purge semantics.

### 9.9 Providers (cost side) and Provider Summary

* **Routes:** `GET/POST /api/providers-info`, `PUT/DELETE /api/providers-info/:id`,
  `POST/GET /api/providers-info/:id/payments`, `POST /api/providers-info/assign-range`,
  `GET /api/provider-summary`, `GET /api/rate-card`.
* **Tables:** `galaxy_providers`, `provider_payments`, `ranges.provider`, `ranges.provider_rate_*`.
* **Flow:** providers are records (name, payment term, currency, rate, method, status); ranges are assigned to a provider;
  provider payments record money paid to the provider. `GET /api/provider-summary` aggregates, per provider, the number of
  SMS and the **provider rate taken from the stored range columns only** — never derived from payouts — and is scoped to
  admin (provider data is not exposed to lower roles).
* **Must not break:** provider rate provenance (stored columns only), role restriction on provider data, and the
  separation between *provider cost* and *user payout*.

### 9.10 Account Security PIN + Complaints (the "chat" module that is not a chat app)

* **Files:** `backend/chat.js`, `assets/chat.js`; UI appears in admin (chatAccounts, complaints), manager/agent/client (complaints).
* **Routes (canonical + legacy aliases):** `GET /api/chat/auth/lock-status` ≡ `GET /api/auth/pin/status`;
  `POST /api/chat/auth/verify-lock` ≡ `POST /api/auth/pin/verify`; `GET /api/chat/admin/accounts` ≡
  `GET /api/account-pin/accounts`; `POST …/:userId/password`, `POST …/:userId/toggle`, `POST …/init-all`;
  `GET /api/chat/unread-count`; complaints: `POST /api/complaints`, `GET /api/complaints`, `GET /api/complaints/:id`,
  `POST /api/complaints/:id/status` (admin), `POST /api/complaints/:id/replies`.
* **Tables:** `chat_credentials`, `complaints`, `complaint_replies`.
* **Flow (PIN):** agent opens the payment section → front-end calls lock-status → if locked, it asks for the PIN →
  verify-lock issues a 12 h `type:'chat_unlocked'` JWT → every payment request then sends it as `x-chat-unlock-token`.
  Admin manages PINs of other users (set/toggle/init-all) but can never disable its own PIN; admin's own unlock uses the
  master account password.
* **Flow (complaints):** any role below admin creates a complaint; admin replies/changes status; badges come from
  `/api/chat/unread-count`.
* **Must not break:** `chatAuthRequired` behaviour (it **rejects** chat-scoped tokens on normal routes), the unlock token
  type strings (`chat_unlocked` / `account_pin_unlocked`), and the legacy route aliases (the current UI calls the
  `/api/chat/...` names, but older bookmarks/scripts may use the aliases).

### 9.11 Payment v2 (agent earnings, withdrawals, admin processing, credit notes)

* **Files:** `payment.html` (+ payment sections inside `admin.html`/`agent.html`), `assets/credit-notes.js`,
  `backend/server.js` (payment block, lines ≈4790-4940), `backend/creditNotes.js`.
* **Routes:** agent → `GET /api/payment-v2/agent/summary|wallet|requests|notifications`,
  `PUT /api/payment-v2/agent/wallet`, `POST /api/payment-v2/agent/request`,
  `POST /api/payment-v2/agent/notifications/read-all`; manager → `GET /api/payment-v2/manager/agents`;
  admin → `GET /api/payment-v2/settings|schedule`, `PUT /api/payment-v2/settings|schedule`,
  `GET /api/payment-v2/admin/summary|requests|audit-logs`, `POST /api/payment-v2/admin/requests/:id/pay|reject`,
  `PUT /api/payment-v2/admin/agents/:id/wallet`; all roles (admin/manager/agent) → `GET /api/payment-v2/credit-notes`.
* **Tables:** `payment_ledger`, `payment_requests_v2`, `agent_wallets`, `payment_v2_settings`, `payment_schedule`,
  `payment_audit_logs`, `payment_notifications_v2`.
* **Flow:** every accepted OTP creates a `payment_ledger` row for the earning agent with `cycle_key` + `eligible_at`;
  the agent sees the eligible balance (`agentPaymentSummary`), places a request (validated against the per-type
  `min_withdrawal`, wallet/Binance UID, and the Security PIN), admin pays (txid/screenshot) or rejects with a reason;
  each action writes an audit row and a notification.
* **Credit Notes:** `GET /api/payment-v2/credit-notes` is a **read-only live settlement statement** grouped by
  (agent, payment_type, cycle_key, eligible_at) with BigInt decimal sums, filters (cycle from/to, agent, payment type,
  maturity, page ≤ 100/page 25) and role scope (agent = self, manager = direct agents, admin = all). It never writes.
* **Must not break:** the ledger as the single source of earnings, `requireAgentChatUnlock` on all agent payment routes,
  cycle/maturity maths (§18), minimum-withdrawal enforcement, and the read-only nature of Credit Notes.

### 9.12 Panel Sharing (forwarding traffic to external partners)

* **Files:** `panel-sharing.html`, backend sharing block (≈5030-5770), `smppService.js` for SMPP-linked sharing.
* **Routes:** `GET /api/panel-sharing/dashboard|users|ranges|numbers|forward-logs`,
  `POST /api/panel-sharing/users`, `PUT/DELETE /api/panel-sharing/users/:id`,
  `POST /api/panel-sharing/allocate|bulk-allocate`, `POST /api/panel-sharing/http/test`.
* **Tables:** `sharing_users`, `sharing_forward_logs`, `numbers` (shared numbers are normal numbers allocated to the
  sharing-user's owning account), `smpp_connections` / `smpp_outbox` when `connection_type='smpp'`.
* **Flow:** admin creates a sharing user (HTTP config with URL/token or an SMPP connection), allocates numbers to it;
  when an OTP arrives on one of those numbers, ingest forwards the payload (HTTP POST or SMPP submit_sm) and logs the
  attempt in `sharing_forward_logs`. `sharingPublic()` masks `password`/token fields in API responses.
* **Must not break:** secret masking, the forwarding log, dedup keys, and that sharing is *additional* to normal storage
  (forwarding must never replace the local record).

### 9.13 SMPP connections (client + server)

* **Files:** `management.html` (SMPP page), `panel-sharing.html` (SMPP page + guide text), `backend/smppService.js`.
* **Routes:** `GET/POST /api/smpp/connections`, `PUT/DELETE /api/smpp/connections/:id`,
  `POST /api/smpp/connections/:id/start|stop|restart|test|send`, `GET /api/smpp/status|logs|outbox`.
* **Tables:** `smpp_connections`, `smpp_seen`, `smpp_logs`, `smpp_outbox`.
* **Flow:** a connection is `mode='client'` (we bind to a provider's SMSC; `host/port/system_id/password/bind_type`) or
  `mode='server'` (we listen on `listen_port`, allowed IPs, and carriers bind to us). Inbound messages go through the same
  ingest function with dedup in `smpp_seen`; outbound MT uses `smpp_outbox`.
* **Must not break:** the single-ingest convergence, dedup keys, reconnect/backoff columns, and `SMPP_ENABLED` semantics.

### 9.14 Limits (daily OTP limits)

* **Working feature:** `management.html` → Limit Management page → `GET /api/limit-management/overview`,
  `POST /api/limit-management/range` (per-range daily + per-number limits), `POST /api/limit-management/cli`,
  `DELETE /api/limit-management/:id`. Enforcement happens in ingest via `daily_limit_rules`; when a rule is hit the
  stored payout is `0` and `sms_records.limit_reason` explains why. `GET /api/limit-management` (list) and
  `POST /api/limit-management` (generic upsert) exist but no UI calls them.
* **Broken feature (documented, not fixed):** the "SMS CLI Limit" page in `admin.html`, `manager.html` and
  `management.html` (`data-page="cliLimit"`) calls `GET/POST /api/cli-limits` and `DELETE /api/cli-limits/:id`.
  **Those routes do not exist** (only `cli_limits` table + `backend/README.md` mention remain), so that page loads empty
  and writes fail. See `AUDIT_REPORT.md` §B.
* **Must not break:** the limit engine's effect on `payout_amount` + `limit_reason`, and `daily_limit_rules` semantics
  (UK-day counting).

### 9.15 HTTP ingress, carrier settings, failed-SMS queue and logs

* **Routes:** `POST /api/incoming-sms` and `GET /api/incoming-sms` (carrier; guarded by `smsIngestLimit` + carrier/IP checks
  and `carrier_settings`), `POST /api/webhook/sms` (open internal/testing endpoint used by the project's own harnesses),
  `GET /api/carrier-settings`, `PUT /api/carrier-settings`, `POST /api/carrier-test`, `GET /api/carrier-webhook-logs`,
  `DELETE /api/carrier-webhook-logs`, `GET /api/logs/activity|number-history|webhooks`, `GET /api/failed-sms`,
  `POST /api/failed-sms/:id/retry`, `DELETE /api/failed-sms/:id`.
* **Tables:** `webhook_logs`, `failed_sms_queue`, `carrier_settings`, `sms_records`, `sms_daily_stats`, `activity_ips`.
* **Flow:** payload → `processIncomingSmsPayload` (see §13) → stored or queued as failed. Admin UI (management.html →
  Carrier Integration / System Logs) reads settings, tests the endpoint, and inspects/retries failures.
* **Must not break:** payload parsing tolerance (see §13), the `failed_sms_queue` retry path, and the log retention.

### 9.16 Backups

* **Files:** `backend/backup.js`, `management.html` (Backup Management page), `scripts/alert-check.js`, `deploy/verify-backups.sh`.
* **Routes:** `GET /api/backups`, `POST /api/backups/create`, `GET /api/backups/latest/download`,
  `GET /api/backups/:file/download`, `POST /api/backups/:file/restore`, `DELETE /api/backups/:file`.
* **Flow:** backups are written with `VACUUM INTO` (consistent snapshot while the DB is live) into `BACKUP_DIR`
  (default `~/nova-sms-backups`), retained `BACKUP_RETENTION_DAYS`, and can be downloaded/restored from the panel.
  Automatic backup runs when `BACKUP_AUTO=1` / on the configured interval.
* **Must not break:** the default directory name (**`nova-` prefix is legacy and must stay**, monitoring/scripts look for it),
  retention logic, and the restore path's safety.

### 9.17 User management (Admin)

* **Routes:** `GET /api/users/:role`, `POST /api/users`, `PUT /api/users/:id`, `DELETE /api/users/:id`,
  `GET /api/users/hierarchy-stats`.
* **Tables:** `users`, `audit_logs`, `chat_credentials` (created on demand).
* **Flow:** admin/manager create users of the allowed roles with a `parent_id` in their own subtree; passwords are bcrypt
  hashed (`insertUserAccount` helper); deactivate vs delete semantics are distinct (deleting a user with history must be
  considered carefully — see §35).
* **Must not break:** the parent/child validation (no cross-subtree creation), bcrypt hashing, and role strings.

### 9.18 Exports (CSV) and jobs

See §20.

### 9.19 Optional full-text search (FTS)

* **Files:** `backend/fts.js`; enabled with `POWERX_FTS=1`.
* **Routes:** `GET /api/admin/fts-status`, `POST /api/admin/analyze`, plus `message` filtering in report endpoints when
  the index is ready.
* **Flow:** creates an FTS5 trigram virtual table + triggers and backfills history in batches; ingest path untouched.
  When the index is not ready the code falls back to `LIKE '%term%'` scans.
* **Must not break:** the opt-in default (**off**), the fallback path, and `meta` backfill bookkeeping.

### 9.20 Profile, security code and activity log (the gear menu in `api.js`)

* **Routes:** `GET/PUT /api/profile`, `PUT /api/admin-security-code`, `PUT /api/carrier-lock-password`,
  `GET /api/activity-log`, `POST /api/logout`.
* **Flow:** the settings menu is rendered by `api.js` on every panel; username changes and password changes (admin needs
  the security code) are handled here; logout clears token storage client-side and logs the action server-side.
* **Must not break:** the admin security-code requirement and the `logAction` audit writes.

---

## 10. API endpoints (complete index)

**All 229 registered routes are listed with their method, path, guard chain and source line in
[Appendix A](#appendix-a--every-registered-route).** This section explains the conventions and the route groups.

### 10.1 Conventions

* Every API path starts with `/api`. The front-end never hardcodes the host: `api.js` does `fetch('/api' + path, …)`.
* JSON in / JSON out (`express.json`, 2 MB limit; also `urlencoded`, `text/*` for carrier payloads).
* Errors: `{error: 'message'}` with a meaningful HTTP status (400 validation, 401 auth, 403 permission/PIN,
  404 missing, 409 conflict/duplicate, 410 removed module, 429 rate-limited, 500 unexpected).
* Auth: `Authorization: Bearer <jwt>`; special cases use extra headers:
  `x-chat-unlock-token` / `x-pin-unlock-token` (agent payment), carrier auth inside the payload/params.
* Pagination: query params `page`, `limit`, `sort`, `dir`; responses vary per endpoint (some return an array, some
  `{rows,total,page,limit}`, paged SMS responses are streamed) — **always check the panel code before changing a shape**.
* Idempotency: heavy POSTs (allocation/import) accept an idempotency key; repeated calls return the stored response
  (`idempotency_keys`, 7-day TTL).
* Cache: `cachedJson(req,res,ttlMs,fn,verKey)` — GET responses can be served from an in-process cache keyed by URL+user,
  versioned by a `meta` key (e.g. `numbers_ver`). Endpoints that must be live are called with a cache-buster query
  (`_gxr=<ms>`).

### 10.2 Route groups (counts from Appendix A)

| Group | Count | Notes |
|-------|-------|-------|
| Pages & static HTML | 38 | clean URLs + `.html` aliases + SPA `/:page` catch-alls |
| SMS / Reports / Dashboard / Exports / Logs | 40 | `/api/sms*`, `/api/stats*`, `/api/dashboard`, `/api/exports*`, `/api/jobs*`, `/api/logs*`, `/api/failed-sms*` |
| Numbers, Ranges, Rates, Test panel | 55 | the allocation engine + imports + test numbers |
| Providers | 9 | `galaxy_providers`, provider payments, provider summary |
| Provider Sync | 7 | `sync_providers`, `sync_seen`, `sync_logs`, `/api/sync/test` |
| SMPP | 13 | connections + status/logs/outbox |
| Panel Sharing | 12 | users/numbers/allocation/forward logs/http test |
| Payments (payment-v2 + credit notes) | 19 | agent/manager/admin flows + read-only credit notes |
| Limits | 6 | `limit-management/*` (the live limit engine) |
| Ingest (webhooks) | 4 | `/api/incoming-sms` (POST/GET), `/api/webhook/sms`, legal-independent |
| Users / Account / Security / Complaints | 30 | users CRUD, profile, PIN (`chat`+aliases), complaints, legal, backups, api-integrations (410) |
| Ops / Carrier / Security | 8 | carrier settings/test/webhook logs, activity IPs, security code, carrier lock |
| Other API | 4 | `/api/me`, `/api/health`, legacy `/api/stats/:by`, etc. |

### 10.3 Routes with **no caller found anywhere in the project** (verified 2026-10-08)

These 42 routes exist in code but nothing in the panels/assets/tests/docs references them. They are **kept** (see
`AUDIT_REPORT.md` §D for the reasoning) — do not "clean" them without deciding each one explicitly:

*Legitimate but unused-by-UI:* `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/smpp/outbox`, `GET /health`,
`POST /api/webhook/sms` (used by the project's external test harnesses), `POST /api/admin/analyze`,
`GET /api/admin/fts-status`, `GET /api/admin/backfill-stats`, `POST /api/admin/backfill-stats`,
`PUT /api/payment-v2/admin/agents/:id/wallet`, `POST /api/payment-v2/agent/notifications/read-all`,
`GET /api/limit-management`, `POST /api/limit-management`, `GET /api/stats/:by` (legacy; superseded by stats-summary).

*Deliberate 410 stubs:* `GET/POST /api/api-integrations`, `PUT/DELETE /api/api-integrations/:id`,
`POST /api/api-integrations/:id/fetch`, `GET /api/api-integration-logs`.

*Legacy duplicate aliases (kept for compatibility):* `GET /api/auth/pin/status`, `POST /api/auth/pin/verify`,
`GET /api/account-pin/accounts`, `POST /api/account-pin/accounts/:userId/password|toggle|init-all`.

*Page aliases / catch-alls:* `/`, `/login`, `/login.html`, `/admin.html`, `/manager.html`, `/agent.html`,
`/client.html`, `/test.html`, `/management.html`, `/payment.html`, `/panel-sharing.html`, every `*-login.html`,
`/management-login`, `/test/:page`, `/payment/:page`.

## 11. Frontend routes and pages per panel

Each panel is one HTML file; pages are `<section id="page-X">` blocks toggled by `data-page="X"` nav items.
**These page names are also used in the URL** (`/admin/<page>` style routes served by the SPA catch-alls) — after the
page loads, JS switches to the requested page.

| Panel (URL) | File | Pages (nav ids, in menu order) | Page containers that exist |
|---|---|---|---|
| `/admin` | `admin.html` | dashboard, allocation, numbers, test, payMgmt, chatAccounts, complaints, managers, agents, clients, smsReport, cliSearch, smsDetail, clientStats, agentStats, managerStats, rangeStats, numberStats, providerSummary, creditNotes | same (the old `cliLimit` section was removed from this panel; its JS remains — see §30 item 1) |
| `/manager` | `manager.html` | dashboard, rateCard, numbers, bulkAlloc, agents, clients, smsReport, smsDetail, clientStats, agentStats, rangeStats, numberStats, cliSearch, test, credit, complaints, cliLimit ⚠, creditNotes | same (`cliLimit` renders empty — its API is missing, §30 item 1) |
| `/agent` | `agent.html` | dashboard, rateCard, numbers, selfAllocate, bulkAlloc, test, complaints, clients, smsReport, smsDetail, clientStats, rangeStats, numberStats, payment, creditNotes | same |
| `/client` | `client.html` | dashboard, numbers, stats, test, complaints | same |
| `/management` | `management.html` | import, rates, cliLimit ⚠, limitManagement, carrierIntegration, providers, apiProviders, smppConnections, systemLogs, backupManagement | + dashboard, testImport, managers, agents, clients, cliSearch, smsReport, smsDetail, clientStats, agentStats, managerStats, rangeStats, numberStats, test — **note:** several of these extra containers are gone from the markup while their renderers remain in the JS (§30 item 4) |
| `/payment` | `payment.html` | dashboard, requests, settings, audit, creditNotes | same |
| `/panel-sharing` | `panel-sharing.html` | dashboard, numbers, bulk, users, smpp, logs | same |
| `/test` | `test.html` | dashboard, numbers, test | same |

Logins: `/panel-login` (`login.html`) → role redirect; `/management-login`, `/payment-login`, `/panel-sharing-login`,
`/test-login` → dedicated shells that post to the *same* `/api/login` and then verify the role client-side.

## 12. Login / session / authentication flow

1. **Login page →** `POST /api/login {username,password}` (rate-limited 10/5 min/IP).
2. **Server:** username matched case-insensitively → `active` check → `bcrypt.compareSync` → `sign(user)`:
   HS256 JWT, payload `{id, username, role}`, **12 h expiry**, secret `JWT_SECRET` (`backend/auth.js`).
   Login is written to `audit_logs`.
3. **Client:** token in `sessionStorage`/`localStorage` key `ms_token`, role in `ms_role`; redirect by role.
   Note: `assets/chat.js` **decodes the JWT client-side** to read the user id/role → the payload must keep those fields.
4. **Every API call:** `api.js` adds `Authorization: Bearer <token>`; `authRequired` verifies and attaches `req.user`;
   `chatAuthRequired` additionally rejects tokens of type `chat_unlocked`; `requireRole(...)` enforces the role.
5. **PIN unlock (second factor for agents):** `POST /api/chat/auth/verify-lock` → 12 h `chat_unlocked` JWT →
   sent as `x-chat-unlock-token` on payment routes (`requireAgentChatUnlock` = 403 `{locked:true}` when missing/invalid).
6. **Logout:** `POST /api/logout` (+ client-side storage clearing). Tokens are stateless — server-side logout is a log
   entry only; to revoke a token you must change `JWT_SECRET` (which logs everyone out) or disable the account.
7. **Failure modes:** expired/invalid token → 401 → `api.js` clears storage; the panels then show the login redirect.
   Disabled account → 403 at login; a *already issued* token keeps working until it expires (12 h) — a known limitation (§29).

## 13. SMS processing flow (ingest → storage → report)

**Entry points (all converge on `processIncomingSmsPayload`):**

| Transport | Route / module | Notes |
|-----------|----------------|-------|
| Carrier HTTP push | `POST /api/incoming-sms`, `GET /api/incoming-sms` | `smsIngestLimit` (12 000/min/IP), carrier settings (IP/auth) checks, tolerant body parsing (JSON, form, text). |
| Internal/testing HTTP push | `POST /api/webhook/sms` | Open endpoint used by the project's own harnesses (`/home/user/galaxy-ui-work/*.cjs` in the development environment). |
| SMPP inbound | `backend/smppService.js` | Both client and server mode feed the same function; dedup via `smpp_seen`. |
| Provider pull-sync | `backend/providerSync.js` | Rebuilds each poll window; dedup via `sync_seen`; disabled unless enabled by env. |
| Test panel | `POST /api/test-panel/fake/*` | Same path with `is_test=1`. |

**Inside the ingest function (order matters):**

1. **Normalise** the payload: find the number and message (`number`, `cli`, `message`, sender).
2. **Match the number** through `cleanPhone()` / the `idx_numbers_clean_phone` index (so `+92…`, spaces, dashes and
   `_` all match the stored number).
3. **Extract OTP** (`otp_code`, `is_otp`) and classify the sender (`sender_type`).
4. **Duplicate detection:** a duplicate key is built from (number, cli, message, provider id/timestamp) and checked in
   `api_integration_seen` / `smpp_seen` — duplicates are logged but **not** stored/paid twice.
5. **Ownership snapshot:** the number's current `manager_id/agent_id/client_id` are copied onto the record, so later
   re-allocations never rewrite history.
6. **Limits:** `daily_limit_rules` (range / range_number / cli / number) are evaluated against today's **UK date** count;
   when exceeded → stored with `payout_amount=0` and a `limit_reason` (also zero when the provider payout is 0 or
   `forceZeroPayout` applies).
7. **Payout:** compute `payout_rate` + `payout_amount` (§18) and insert the row into `sms_records`.
8. **Statistics:** increment `sms_daily_stats` for (stat_date, manager, agent, client, cli) — the only aggregate the
   dashboards read.
9. **Ledger:** create the `payment_ledger` entry for the earning agent (cycle + eligibility).
10. **Sharing:** if the number belongs to a sharing user, forward the payload (HTTP or SMPP) and log the result.
11. **Logging:** `webhook_logs` for every attempt; `failed_sms_queue` when the payload cannot be processed.

**Dates:** `parseIncomingDate` accepts epoch seconds/ms, `YYYY-MM-DD HH:MM:SS` (UTC), date-only, and ISO strings;
**everything is stored in UTC** (`received_at`) and converted to **Europe/London** only for display/aggregation.
Reports order by `received_at DESC, id DESC`.

**Must not break:** the number-matching normalisation, dedup keys, ownership snapshotting, the order of
limit→payout→stats→ledger, and the UTC storage + UK display convention.

## 14. Number allocation flow (incl. Range Allocation)

**Actors and depth:** admin → (manager | agent | client); manager → (agent | client); agent → client. `handleAllocate`
enforces this and refuses cross-subtree targets. `force` allows taking numbers already owned *below* the caller.

**Standard flow (UI → API → DB):**

1. UI (admin/manager/agent Numbers or Bulk Allocation page) sends
   `POST /api/numbers/allocate` with `{range_id|range, ids[]|count|pattern, to_user_id|to_role, force?, idem_key?}`.
2. `handleAllocate` opens a transaction, validates scope and target, builds a temp-table batch of candidate `numbers.id`
   (`idx_numbers_unallocated`, `idx_numbers_mgr_avail` partial indexes make this fast), updates
   `manager_id/agent_id/client_id` (+`alloc_source`: `manual|bulk|self|sharing`) and returns `{allocated, skipped}`.
3. `number_history` gets one row per affected number (action, from→to owner, actor).
4. `meta.numbers_ver` is bumped → number caches (`cachedJson` version key) invalidate immediately.
5. Idempotent retry returns the stored response instead of allocating twice.

**Unallocate / Return:** clears ownership **at the caller's level and below**; old `sms_records` snapshots stay intact.
**Delete:** admin-only, removes inventory rows (`DELETE /api/numbers/all`, `/api/numbers/range/:rangeId`,
`POST /api/numbers/delete`, `delete-filtered`) with history rows still referencing the numbers by value.
**Move to test:** `POST /api/numbers/move-to-test` re-homes a number into the test pool (different from delete/return —
never treat them as synonyms).
**Smart divide:** `POST /api/numbers/smart-divide` distributes a range's numbers across targets evenly.
**Range Allocation page** = the same engine driven by range + pattern/count, optionally producing an import-like batch.

**Must not break:** the one-level-down rule, the transaction + temp-table batching, `alloc_source` values,
`number_history` completeness, `numbers_ver` bumping, and the unallocate ≠ delete distinction.

## 15. Reporting flow

```
sms_records ──(ingest increments)──► sms_daily_stats ──► /api/dashboard        (fast KPI cards, 10s cache)
sms_records ──buildSmsPagedQuery──► /api/sms/paged       (list view, streamed pages, role caps)
sms_records ──same query builder──► /api/sms/report      (grouped CDR: hour/day/month/range/number/cli/…)
sms_records ──same query builder──► /api/stats-summary/:by (per-dimension SMS + payment totals)
```

* **`buildSmsPagedQuery(user, query)`** is the single filter/scope builder used by all of the above: role scope
  (`smsScopeWhere`) + date/time window (UK semantics) + CLI/number/range/user filters + message search + provider
  (admin only) + `number_like`/`cli_like`. **Adding a filter = add it here once.**
* **Dashboard** never scans `sms_records`: it sums `sms_daily_stats` for today/yesterday/7 days/month plus totals, using
  UK dates. `reconcileStatsAtBoot()` (meta key `p19k_stats_reconciled`) rebuilds any missing/incorrect stat rows at
  startup.
* **Statistics pages** (`clientStats`, `agentStats`, `managerStats`, `rangeStats`, `numberStats`, plus CLI search)
  call `GET /api/stats-summary/:by` with the same filters and get `{rows:[{key,sms,payment}], totalSms, totalPayment}`
  (payment as a decimal **string**, normalised by `normalizeDecimalString`).
* **CDR / SMS Detailed Report** uses `GET /api/sms/report` and returns per-group rows with SMS count, MY PAYOUT and
  CLIENT PAYOUT plus totals, server-side paginated.
* **Live refresh (P20):** Agent and Client detail views poll the newest row every 8 s
  (`/api/sms/paged?page=1&limit=1&sort=date&dir=desc&_gxr=<ms>`), and only re-render when the newest id or the scoped
  total changes. `_gxr` bypasses `cachedGet` (client) and `cachedJson` (server).
* **Must not break:** `sms_daily_stats` accuracy (it *is* the dashboard), `smsPagedOrderSql` ordering, UK time buckets,
  role page caps, and the `_gxr` cache-bypass used by the live views.

## 16. Payment flow (payment-v2)

```
OTP accepted ─► payout_amount computed ─► payment_ledger row (agent_id, payment_type, amount, cycle_key, eligible_at)
                                             │
              agent panel: /api/payment-v2/agent/summary   → eligible balance per cycle
              agent places:  POST /api/payment-v2/agent/request (min_withdrawal, wallet/Binance UID, Security PIN)
                                             │
              admin panel:   GET /api/payment-v2/admin/requests → POST …/:id/pay | /:id/reject
                                             │
              audit + notification + request status on the ledger rows
              every role:    GET /api/payment-v2/credit-notes  (read-only live statement, BigInt sums)
```

* **Cycle maths** is UK-time based: weekly cycles use `payment_schedule.weekly_start_dow` / `weekly_pay_dow`;
  monthly uses `monthly_start_day` + `monthly_delay_days`; `payment_type` ∈ `daily | weekly_7_1 | monthly_30x45`.
  `payment_ledger.eligible_at` is the maturity timestamp; `cycle_key` the cycle label (e.g. `2026-W40`, `2026-10`).
* **Rates:** the payout amount per SMS is derived from the *range cycle rate* (or number override) and stored on the SMS
  row; ledger entries exist only for rows with a non-zero payout (a limit-zeroed OTP earns nothing).
* **Settings:** each payment type has `min_withdrawal`, `active`, `sort_order` (`payment_v2_settings`).
* **Wallets:** the modern flow is **Binance UID** (`agent_wallets.binance_uid` + legacy `wallet_address`/`network`).
* **Admin adjustments:** `PUT /api/payment-v2/admin/agents/:id/wallet` exists (no UI caller) — treat as an admin tool.
* **Must not break:** ledger immutability, eligibility/maturity maths, minimums, the PIN gate, and the read-only
  guarantee of credit notes.

## 17. Provider / SMSC flow

Two independent directions:

* **Inbound traffic (income side):** carrier/provider pushes SMS to `/api/incoming-sms`, or `providerSync.js` pulls from
  a provider REST API on a schedule, or an SMPP link delivers them. All go through the same ingest.
* **Provider cost side:** each `ranges` row can name a `provider` and carry `provider_rate_1_1/7_1/7_7/30_45`.
  `GET /api/provider-summary` (admin) aggregates per range/provider: SMS count and **provider rate from those stored
  columns only** (never derived from payouts, never exposed to non-admin roles). `provider_payments` records payments
  made to providers with running unpaid balances.

**providerSync details:** `sync_providers` holds connector config (`connector`, `config_json`, `interval_seconds`,
`overlap_seconds`); each run fetches a window with overlap, dedups through `sync_seen (provider_id, provider_ref)`,
writes `sync_logs` (fetched/inserted/duplicates/failed/duration), and calls the same ingest for each new record.
It runs only when `SYNC_ENABLED=1` **and** `POWERX_ROLE` is `all` or `sync` (see `.env.example` and
`backend/PROVIDER-SYNC.md`).

**SMPP details:** `smpp_connections.mode='client'` binds out to a provider (ESME); `mode='server'` listens for a carrier
(SMSC) with `allowed_ips`. Runtime state (status, failures, counters, last error) is stored per connection; admin routes
start/stop/restart/test/send; inbound messages are deduped in `smpp_seen`; outbound MT sits in `smpp_outbox`.

**Must not break:** provider rate provenance, admin-only provider visibility, dedup tables, and the single-ingest rule.

## 18. Business logic: rates, cycles and money calculations

**Rate precedence (per SMS payout):**

1. `numbers.rate` (per-number override), else
2. the **cycle rate** on the range for the applicable period: `ranges.rate_1_1` (daily / 1-day-1-hour style),
   `ranges.rate_7_1`, `ranges.rate_7_7`, `ranges.rate_30_45` (monthly).

**Cycle (`payment_type`) precedence:** `numbers.payterm` → user default (`users.payment_type`) → range
`ranges.payment_type` → fallback `weekly_7_1`.

**Provider rate precedence:** `ranges.provider_rate_*` **only** (there is no per-number provider override; the provider
rate is never derived from payout/commission).

**Zero-payout cases (stored as `payout_amount='0'` with `limit_reason`):**
(a) provider payout is 0 for that range/period; (b) a `daily_limit_rules` rule hit (`range`, `range_number`, `cli`,
`number`); (c) `forceZeroPayout` conditions inside ingest (e.g. test traffic, unmatched sender).
Test traffic (`is_test=1`) never earns.

**Amounts are stored as decimal strings** (`payment_ledger.amount`, `payment_requests_v2.amount`,
`sms_daily_stats.payout_sum`); totals are summed with `decimalAdd`/BigInt and normalised by `normalizeDecimalString`
before being returned to the UI. **Never re-add them with floating point.**

**"CLIENT PAYOUT" vs "MY PAYOUT"** in the CDR: MY PAYOUT = `sms_records.payout_amount` (the authoritative stored value);
CLIENT PAYOUT = `numbers.payout` (the client-side rate of that number) and is shown only for rows with a `client_id`.

**Maturity:** `payment_ledger.eligible_at` drives the credit-notes maturity filter (`matured` / `upcoming` / `unknown`)
and the UI balance split. Changing cycle maths changes real payments — treat as frozen logic.

**Must not break:** the precedence chains above, decimal-string handling, and `limit_reason` reporting.

---

## 19. Filters, search and pagination

**Filters (shared by list + CDR + stats endpoints, implemented once in `buildSmsPagedQuery`):**

| Filter | Query param | Notes |
|--------|-------------|-------|
| Date/time window | `from`, `to` (and `date`/`time` variants) | Interpreted as UK wall-clock; converted to UTC ranges. |
| CLI | `cli` | Exact match (case-insensitive in the limit engine, exact in the query builder). |
| Number | `number`, `number_like` | `*_like` variants use `LIKE` (FTS index used when `POWERX_FTS=1` and ready). |
| CLI like | `cli_like` | Partial CLI search. |
| Range | `range` | Range **name**. |
| Manager / Agent / Client | `manager`, `agent`, `client` | Names, not ids; silently ignored/dropped when the role may not see that dimension. |
| Provider | `provider` | **Admin only** — dropped for everyone else. |
| Message search | `search`/`q` (message text) | Exact/`LIKE`/FTS depending on availability. |
| Test traffic | `is_test` / dedicated test pages | Real reports exclude test rows. |

**Pagination conventions:**

* SMS list and CDR: `page` + `limit`; the backend clamps `limit` by role
  (`ROLE_PAGE_MAX = {admin:100000, manager:5000, agent:5000, client:500, test:500}`), `limit=all` is admin-only
  (200 000 max). Paged SMS responses are streamed to keep memory flat.
* Number lists: `NUMBER_PAGE_MAX` (default 1000) / `NUMBER_PAGE_MAX_ADMIN` (default 5000).
* Credit notes: fixed page size 25 (max 100), page clamped to `totalPages`.
* Client-side, `api.js` renders the pager (`buildPager`) and the panels keep their own state objects for the current page
  and total.

**Search vs. filter order:** scope (role) → filters → group/order → pagination. The scope is applied by SQL, never by
hiding UI controls only.

## 20. Export / download

* **Trigger:** `POST /api/exports {type:'numbers'|'sms', search, range, provider, allocation, from, to, …}` (roles
  admin/manager/agent). Runs in a **worker thread** (`backend/exportWorker.js`): its own read-only SQLite connection,
  keyset pagination (20 000 rows/batch), progress written to `jobs`.
* **Progress/poll:** `GET /api/jobs` and `GET /api/jobs/:id` (the panel polls a specific job id).
* **Download:** `GET /api/exports/:id/download` — the job's `result_json` holds a random `token` + `expires_at`
  (`EXPORT_TTL_HOURS`, default 24 h). Files live in `EXPORT_DIR` (default `~/powerx-exports`).
* **Concurrency:** `EXPORT_MAX_CONCURRENT` (default 2) — over the limit returns "Export already running".
* **Other download paths:** backups (`/api/backups/…/download`) and CSV built client-side by some tables
  (`data:text/csv` links in the panels).
* **Must not break:** the export worker's read-only connection (never writes), the token/expiry check, and the file
  naming (`EXP-…csv`).

## 21. Copy-to-clipboard features

* **Per-number copy:** `assets/number-copy.js` adds a copy button to the number cell of the `numBody`/`numbersBody`
  tables (Admin, Manager, Agent, Client). It reads the rendered cell, uses `navigator.clipboard` with a `textarea`
  fallback, shows a tick for ~1 s, and makes **no network requests**. Cap: it stops after 20 000 rows.
* **Copy helpers elsewhere:** several panels use small inline `copyText()` helpers (CLI/OTP cells, wallet addresses,
  txid). They are front-end-only.
* **Must not break:** no API calls from these helpers (they must stay presentation-only), and the table ids
  (`numBody`, `numbersBody`) that `number-copy.js` binds to.

## 22. Background / scheduled work

| Task | Where started | Trigger / interval | What it does |
|------|---------------|--------------------|--------------|
| Retention sweep | `server.js` boot | `setTimeout(90 s)` then every 24 h | Deletes old `sms_records` only if `SMS_RETENTION_DAYS > 0` (default **0 = keep forever**), old `number_history` (`HISTORY_RETENTION_DAYS`, 90), old `failed_sms_queue` (`FAILED_SMS_RETENTION_DAYS`, 7), trims webhook/carrier logs. |
| Stats reconciliation | boot (`reconcileStatsAtBoot`) | once per boot (meta `p19k_stats_reconciled`) | Rebuilds/fills `sms_daily_stats` so the dashboard is correct after restores/imports. |
| Automatic backup | `backup.js` autostart | `BACKUP_ENABLED` (default true) every `BACKUP_INTERVAL_HOURS` (3) | `VACUUM INTO` snapshot + retention `BACKUP_RETENTION_DAYS` (30). |
| Provider sync | `providerSync.js` | `SYNC_ENABLED` + `POWERX_ROLE` (`all|sync|api`), interval `SYNC_INTERVAL_SECONDS`/`SYNC_INTERVAL_SECONDS` (12 s) | Pull provider REST APIs → ingest. |
| SMPP service | `smppService.js` | `SMPP_ENABLED` (default true) | Connects/listens per `smpp_connections` row (client/server), auto-reconnect with backoff, enquire-link keepalive. |
| FTS backfill | `fts.js` | only when `POWERX_FTS=1` | Builds the FTS5 trigram index over `sms_records.message` in batches. |
| API-integration poller | **disabled on purpose** | — | The HTTP *pull* integration module was removed; only HTTP incoming remains. |
| Export jobs | on demand | per request | Worker threads (see §20). |

Single-process assumption: **all of the above run inside one Node process**. Running two instances (or PM2 cluster mode)
means two writers, double sync/backup jobs and duplicated SMPP binds — see §28/§37.

## 23. Webhooks and machine-to-machine integrations

| Integration | Direction | Endpoint | Auth | Payload handling |
|-------------|-----------|----------|------|------------------|
| Carrier/provider HTTP push | in | `POST /api/incoming-sms` (also `GET`) | Carrier settings: expected source IP (`carrier_settings.carrier_ip` / `activity_ips`), optional key/token; rate limited 12 000/min/IP | Accepts JSON, form-encoded, plain text; `parseIncomingDate` tolerant; dedup + limits + payout + stats + ledger. |
| Internal/test push | in | `POST /api/webhook/sms` | **Open** — no auth (used by the project's own test harnesses). If this instance is internet-exposed, restrict it at the proxy/firewall. | Same ingest function. |
| Outbound sharing (HTTP) | out | configured per `sharing_users.http_config.url` | token/password in the config (masked in API responses) | One HTTP POST per received OTP; result in `sharing_forward_logs`. |
| Outbound sharing (SMPP) | out | through an `smpp_connections` row | SMPP bind credentials | `smpp_outbox` + logs. |
| SMPP inbound | in | `smppService.js` (server mode) | system_id/password + `allowed_ips` | Same ingest; dedup in `smpp_seen`. |
| Provider REST pull | out | `providerSync.js` connectors | `config_json` per provider | Overlap window + `sync_seen` dedup. |
| Backup replication | out | Litestream templates | object-storage credentials (outside the app) | Optional, deploy-level. |
| Alerting | out | `scripts/alert-check.js` | — | Reads `GET /api/health` and posts to `ALERT_URL` / Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). |

**Retired integrations:** `/api/api-integrations*` returns **410 Gone** (module removed); the tables stay for history.

## 24. Environment variables (complete list)

`.env.example` documents the essential production set; the code additionally reads the keys below. Default in brackets.

**Core**

| Key | Purpose | Default |
|-----|---------|---------|
| `PORT` | HTTP port | `4000` |
| `NODE_ENV` | conventional; not used for logic branches | — |
| `JWT_SECRET` | HS256 secret for panel tokens **and** PIN unlock tokens | dev fallback in `auth.js` — **must be set in production** |
| `DB_FILE` | explicit SQLite path | — |
| `DATA_DIR` | directory whose `data.sqlite` is used when `DB_FILE` is unset | — |
| `SMPP_ENABLED` | start SMPP service at boot | `true` |
| `SYNC_ENABLED` / `SYNC_INTERVAL_SECONDS` | provider sync on/off + interval (seconds) | `true` / `12` |
| `POWERX_ROLE` | which services this process runs: `all` \| `api` \| `sync` | `all` |
| `POWERX_FTS` | enable the optional FTS5 index | off |

**Limits & performance**

| Key | Purpose | Default |
|-----|---------|---------|
| `API_RATE_PER_MIN` | per-IP and per-user API limit / minute | `1200` |
| `INCOMING_SMS_RATE_PER_MIN` | carrier ingest limit / minute / IP | `12000` |
| `HEAVY_WRITE_RATE_PER_MIN` | non-GET `/api/numbers*` writes / minute / IP | `120` |
| `SQLITE_CACHE_MB` | page cache size | `256` |
| `SQLITE_MMAP_BYTES` | mmap window | `1073741824` |
| `SLOW_QUERY_MS` | log queries slower than this | `200` |
| `SMS_SCOPE_ROW_CAP` | hard row cap for scoped SMS queries | `5000` |
| `NUMBER_PAGE_MAX` / `NUMBER_PAGE_MAX_ADMIN` | number list page sizes | `1000` / `5000` |
| `IMPORT_BATCH_SIZE` | rows per insert batch during number import | `1000` |
| `RANGE_IMPORT_MAX_ROWS` | max rows accepted in a range import | `5000` |

**Retention**

| Key | Purpose | Default |
|-----|---------|---------|
| `SMS_RETENTION_DAYS` | delete `sms_records` older than N days (**0 = never delete**) | `0` |
| `HISTORY_RETENTION_DAYS` | `number_history` retention | `90` |
| `FAILED_SMS_RETENTION_DAYS` | `failed_sms_queue` retention | `7` |
| `API_INTEGRATION_LOG_LIMIT` | trim size of the (retained) api-integration logs | `20000` |

**Backups & exports**

| Key | Purpose | Default |
|-----|---------|---------|
| `BACKUP_ENABLED` | automatic backups | `true` |
| `BACKUP_INTERVAL_HOURS` | interval | `3` |
| `BACKUP_RETENTION_DAYS` | keep backups N days | `30` |
| `BACKUP_DIR` | backup folder (keep the `nova-sms-backups` naming if you want existing tooling to find it) | `~/nova-sms-backups` |
| `EXPORT_DIR` | CSV export folder | `~/powerx-exports` |
| `EXPORT_TTL_HOURS` | export link validity | `24` |
| `EXPORT_MAX_CONCURRENT` | simultaneous export workers | `2` |

**Security & misc**

| Key | Purpose | Default |
|-----|---------|---------|
| `CARRIER_LOCK_PASSWORD` | carrier integration unlock password (fallback literal exists in code — set it!) | `Dawood` (code fallback) |
| `PAYMENT_LEDGER_BACKFILL_ON_STARTUP` | one-shot ledger backfill | `false` |
| `ALERT_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | alerting used by `scripts/alert-check.js` | — |

**Not environment-driven (hardcoded):** admin seed credentials (`vibepk`/`vibepk123` in `backend/seed.js`),
test account (`test`/`test123`), legal policy version `2026-09-13-v1`, role page caps, cycle fallback `weekly_7_1`.

## 25. Installation and local run

```bash
# 0) prerequisites: Node.js 20+ (tested on 20.20.2), npm, build tools for better-sqlite3
node -v

# 1) install dependencies exactly as locked (native build for better-sqlite3)
npm ci            # or: npm install

# 2) configuration — ALWAYS use a non-production database and secrets locally
cp .env.example .env
#    set: JWT_SECRET=(openssl rand -hex 32), DB_FILE=backend/data.local.sqlite, PORT=4000
#    for a sandbox: SYNC_ENABLED=false, SMPP_ENABLED=false, BACKUP_ENABLED=false

# 3) start (schema + seed + services run at boot)
npm start         # = node backend/server.js      (npm run dev is the same command)

# 4) open the panel
#    http://localhost:4000/panel-login   → login → role redirect
#    first login: vibepk / vibepk123  (change it immediately)   test panel: test / test123
```

**Boot sequence (what `npm start` actually does — `server.js` lines ≈6660-6791):**
set `PORT` → `createTables()` (creates/migrates the schema **every boot**) → `seed()` (admin/test accounts if missing) →
optional FTS init → `reconcileStatsAtBoot()` (fills `sms_daily_stats`, sets meta) → start provider sync if enabled and
`POWERX_ROLE` allows → start SMPP service if enabled → start backup service if enabled → schedule the retention sweep →
`app.listen(PORT)` (0.0.0.0). Console logs each step (`[SYNC]`, `[SMPP]`, `[BACKUP]`, `[STATS-RECONCILE]`).

> ⚠️ Starting the app **writes to the database** (schema migrations, seed, stats reconciliation, possibly a ledger
> backfill). Never start the app against a production DB you have not backed up, and never against a copy you care about.
> A fresh code directory with no `DB_FILE` will silently create `backend/data.sqlite` — always point it explicitly.

**Smoke checks after starting**

```bash
curl -sS http://127.0.0.1:4000/api/health          # → {"ok":true,...} (public, rate-limit exempt)
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/panel-login   # 200
node scripts/check-html-scripts.js admin.html       # per-file inline-JS syntax check (pass each edited page)
```

## 26. Database setup, migrations and seeding

* There is **no migration framework and no CLI**. `createTables()` in `backend/schema.js` runs at every boot and:
  * creates any missing table/index,
  * adds missing columns (`ALTER TABLE … ADD COLUMN`) for older databases,
  * performs specific data fixes/backfills.
  This is idempotent and safe to run repeatedly, but it does mean **starting the app is a schema operation**.
* `seed.js` inserts the admin account only when `users` is empty, and always ensures the `test` account exists.
  It never creates demo managers/agents/ranges/numbers.
* A **fresh empty database is fully functional**: log in as admin, create a range, import numbers, create users.
* Older production databases keep 8 legacy chat/assistant/channel tables and legacy columns (e.g. `cli_limits`,
  `chat_credentials.chat_*`, `users.chat_display_name`). **Do not drop them** — `chat_credentials` is still the PIN
  store and the others are historical data.
* Backups: prefer the built-in backup endpoints or `VACUUM INTO`; a plain `cp` of a live WAL database is **not** a
  consistent snapshot (copy the file *and* `-wal`/`-shm`, or stop the app first).

## 27. Build / start commands

| Command | What it does |
|---------|--------------|
| `npm ci` | reproducible dependency install (native build of better-sqlite3) |
| `npm install` | same, non-locked |
| `npm start` | `node backend/server.js` — production start (what PM2 runs) |
| `npm run dev` | identical to `npm start` (no watch/reload) |
| `node scripts/check-html-scripts.js <page>.html` | syntax-checks the inline JS blocks of **one** HTML page (run per edited page before shipping) |
| `node tests/credit-notes.test.js` | standalone credit-notes test (in-memory DB) |
| `node tests/verify-galaxy-cleanup-and-security.js` | security/cleanup regression (temporary fixture DB, mocked auth) |
| `node tests/ui-theme.test.js` | UI theme contract checks |
| `pm2 start ecosystem.config.js --env production` | production process (fork, 1 instance) |
| `pm2 logs galaxy-sms` | live logs |

There is **no bundler/build step** for the front end: the HTML/CSS/JS files are served as-is. Editing a panel file
requires only a browser refresh (or a hard refresh if a `?v=` cache-buster is involved — several pages pin
`?v=light-20260928`).

## 28. Production / VPS requirements

**Minimum:** 2 vCPU, 2 GB RAM, 20 GB SSD, Ubuntu 22.04/24.04, Node.js 20 LTS, a reverse proxy (nginx) with TLS.
Comfortable for millions of SMS rows: 4 vCPU / 4–8 GB RAM, SSD/NVMe (latency matters more than size), and a backup target
outside the VPS.

**Process model (critical):** one process, **fork mode**, `instances: 1`. `ecosystem.config.js` and
`deploy/ecosystem.config.cjs` already do this. Reasons: SQLite has a single writer; the sync/SMPP/backup/retention jobs
have no distributed lock and would double-run in cluster mode.

**nginx:** use `deploy/nginx-powerx.conf` as the template — keep `proxy_set_header X-Forwarded-For`,
`X-Forwarded-Proto`, `Host`, generous `client_max_body_size` for imports (file uploads go through Express/multer), and
timeouts long enough for big exports/imports. WebSocket is not needed (the UI polls).

**systemd/PM2:** `scripts/install-service.sh` or PM2 (`pm2 startup` + `pm2 save`). Health for monitoring: `/api/health`
and `/health` (public, not rate-limited); `scripts/alert-check.js` can drive an external alert.

**Disk/monitoring:** `scripts/powerx-watchdog.sh` (process) and `scripts/powerx-diskguard.sh` (disk) exist for cron.
Watch: DB file growth (`sms_records` is the big table), `-wal` size, export dir growth, backup dir retention, free space.

**Deployment checklist:** back up the DB → `npm ci` → copy code → restart → check logs for `createTables`/seed/sync/SMPP
lines → smoke the panels → verify `/api/health`. See `docs/SAFE-UPDATE.md` and `deploy/DEPLOY.md` for the long version.
**Never deploy this app in a way that starts two instances at once** (e.g. old PM2 process still alive during a deploy).

---

## 29. Known limitations

1. **Single writer / single process.** SQLite + in-process schedulers mean one instance only (fork, 1). Horizontal scaling
   is not supported without re-architecting.
2. **Stateless JWTs with no revocation list.** Logout is client-side; a stolen token stays valid up to 12 h. Disabling a
   user does not kill their existing token before expiry.
3. **No CSRF tokens** — safe *because* the token lives in JS storage and is sent as a header (not a cookie), but any
   change that moves auth into cookies would introduce CSRF risk.
4. **Open CORS** (`app.use(cors())`): any origin can call the API, but needs a valid bearer token. Do not treat CORS as a
   security boundary.
5. **No automated migration tooling/rollback.** Schema changes happen at boot; rolling back code does not roll back the DB.
6. **UK-time business semantics are hardcoded** (`Europe/London`) for dates, cycles, limits and DST handling. Serving a
   different country/timezone requires code changes (not just a setting).
7. **Money is stored as decimal strings and cast to REAL in some aggregates** (`CAST(... AS REAL)` in stats/stats-summary).
   Rounding at very large magnitudes is a known trade-off; the ledger and credit notes use BigInt decimal sums.
8. **Flat files for exports/backups** — no object storage integration except the optional Litestream templates.
9. **Front-end is duplicated logic.** Each panel re-implements its own tables/filters; there is no shared component layer
   beyond `api.js` and `assets/*.js`. A change in one panel usually must be repeated in the others.
10. **No i18n framework** — some strings are Urdu/roman-Urdu (e.g. `deploy/DEPLOY-URDU.md`, several alerts).
11. **`/api/webhook/sms` is unauthenticated** by design (internal/testing). It must be blocked at the proxy/firewall on a
    public host.
12. **Report row caps** (role page maxima, `SMS_SCOPE_ROW_CAP`) mean "show everything" is intentionally limited per role.
13. **No WebSocket/SSE** — freshness comes from polling (dashboard 10 s cache, P20 live views 8 s poll).

## 30. Known bugs / known-broken behaviour

**Verified on 2026-10-08 by reading the code and matching every front-end call against the registered routes.
The only front-end call with no matching backend route is the CLI-Limit family below.**

1. **`SMS CLI Limit` page is broken (manager + management panels; dead JS left in admin).**
   * `manager.html` and `management.html` both have a `cliLimit` nav item + `page-cliLimit` section, and their JS calls
     `GET /api/cli-limits`, `POST /api/cli-limits`, `DELETE /api/cli-limits/:id`.
   * **No such routes exist** anywhere in `backend/*.js` (case-insensitive grep-verified). Result: the page lists
     "No limits set yet" forever and any add/delete attempt fails (404 → error alert).
     `management.html` still has all the input controls for the page; `manager.html` only has the (always empty) table.
   * `admin.html` no longer has the page section or nav item, but the router branch (`page==='cliLimit'`) and the
     `loadCliLimits()/renderCliLimit()/addCliLimit()/delCliLimit()/climTypeChange()` functions remain → a deep link to
     `/admin/cliLimit` throws inside `loadAdminPageData()`'s try/catch (console warning only).
   * The `cli_limits` table still exists (empty in the reference DB) and `backend/README.md:63` still documents the
     removed endpoints (documentation drift). Its **only** live reference in the backend is `server.js:1253`, which deletes
     a manager's rows when that manager is deleted — nothing in the codebase ever *inserts* into it.
   * The **working** equivalent is the management panel's **Limit Management** page (`/api/limit-management/*`) backed by
     `daily_limit_rules`, which is what ingest actually enforces.
   * **Do not "fix" this by inventing new endpoints as part of a cleanup.** Either wire the page to
     `/api/limit-management/cli` + `/api/limit-management/:id`, or remove the page from the nav — decide explicitly.
2. **Unused-but-present routes** (42 of them, fully listed in §10.3): `/api/jobs` (list), `/api/smpp/outbox`,
   `/health`, `/api/admin/analyze`, `/api/admin/fts-status`, `/api/admin/backfill-stats` (GET/POST),
   `PUT /api/payment-v2/admin/agents/:id/wallet`, `POST /api/payment-v2/agent/notifications/read-all`,
   `GET/POST /api/limit-management` (generic variants), `GET /api/stats/:by` (legacy duplicate of `stats-summary`),
   the alias families, and the page aliases. They are harmless, but do not assume they are exercised by tests.
3. **`backend/smppServer.js` is a dead stub** (referenced by nothing; the live SMPP implementation is `smppService.js`).
4. **`GET /api/sms` (legacy list)** and `GET /api/stats/:by` are legacy siblings of the newer endpoints; keep the newer
   ones in sync if you touch reporting.
5. **Duplicate route registration:** `POST /api/providers-info/assign-range` is registered twice (same path, same file,
   lines ≈5914 and ≈5927) — the first definition wins. Harmless but confusing.
6. **Mixed branding strings** ("Power X", "nova-", "powerx-") in backend comments, backup folder defaults, PM2 app name
   and nginx template — cosmetic, but they are *used as identifiers* by ops scripts, so renaming breaks tooling.
7. **`api.js` client cache (~30 s)** means a stale list can appear if a page forgets a cache-buster after a write;
   the P20 fix added `_gxr` for the live views, but other pages rely on explicit reloads.
8. **Panel Sharing → Sharing Users → "Create / Edit Sharing User" modal cannot open** (verified by code reading).
   `openUser(id)` calls `onConnTypeChange()` (no try/catch), which does
   `document.getElementById('activityFields'|'httpFields'|'smppFields').style…`. Those three ids **do not exist** in
   `panel-sharing.html` — the markup now uses the boxes `boxActivityConn` / `boxHttpConn` / `boxSmppConn`
   (grep confirms the old names appear only in that one function). The resulting TypeError aborts the rest of
   `openUser()`, including `userModal.classList.add('show')`, so the modal never appears.
   Related mismatches in the same file: `suSmppConn` (markup has `suSmppSelect`) used by `loadSmppSelect()` (inside a
   try/catch, so it fails silently → the SMPP-connection dropdown stays empty) and by `saveUser()` for SMPP-type users;
   `httpPreviewBody`, `btnTestHttp`, `httpTestResult` are also absent, so `updateHttpPreview()`/the HTTP "test" button
   cannot work even if the modal is opened another way. **Do not patch this inside a cleanup** — it is a UI-logic change
   that needs its own approved fix (rename the ids in JS to the markup names, or restore the old wrappers).
   *Note:* `numRangeFilter`/`allocUser`/`bulkUser` look missing too but are **created at runtime** by
   `window.renderSearchSelect(...)` and are read with optional chaining — those are fine.
9. **`management.html` still contains admin-style renderers whose markup was removed** — e.g. `renderAlloc()` dereferences
   `allocLen`/`allocSearch`/`allocBody`/`allocInfo`, none of which exist in this page, and it is called from the full
   `loadRates()`, which the panel runs at init and after imports/rate edits. Effect: an uncaught TypeError inside
   `loadRates()` (console error), and any code that runs *after* the failing call in that flow — e.g. the follow-up
   `refreshNumberDependentViews()` after a delete-range/import flow — is skipped. `loadImportBatches()`,
   `loadNumberSummary()`-style helpers that target `numbersBody`/`importBatchBody` are likewise stale. The Management
   panel's own pages (rates, import, limit management, carrier, providers, sync/API providers, SMPP, logs, backups) have
   their markup and work; the leftovers are the "admin views inside Management" that were intentionally dropped.
   (This is the pre-existing "*Management known rendering error*" already recorded in the 2026-09-28 workspace report —
   it still reproduces.)
10. **Two `doBulk()` / two `loadRates()` / two `rebuildAllocData()` definitions** exist in `manager.html` and
    `management.html` (and the older copies are dead). JS keeps the last definition, so the dead copies are harmless but
    dangerous to edit by mistake — always grep for duplicate function names before editing a panel.
11. **Dynamic ids are normal in these panels** (`buildEntityStats`, `window.renderSearchSelect`, `paginateRows` create
    elements at runtime). A static "missing id" report will show false positives such as `agentFMgr`, `clientFAgt`,
    `baRange`, `numRangeFilter` — verify with a live page before declaring an id bug.

## 31. Intentionally removed / disabled features

| Feature | State | Evidence |
|---------|-------|----------|
| Standalone **Chat application** (conversations, messages, device tokens, channels) | **Removed**; UI/API gone, DB tables retained | `backend/chat.js` + `assets/chat.js` headers ("The separate Chat System / Chat App has been discontinued and removed"); 8 orphan tables still exist |
| **AI Assistant** (backend/assistant.js) | **Removed** | file absent, listed in `release/obsolete-code-paths.txt`; tables retained |
| Public **email registration / password setup** | **Removed** | absent files; `README.md` states it is retired |
| **Mobile app / APK** (`mobile-app/`, `galaxy-chat-v1.apk`) | **Removed** | listed in `release/obsolete-code-paths.txt` |
| **Bench Toolkit**, historical load/crash/UI harnesses (`bench-toolkit/`) | **Removed** | same list |
| **API Integration module** (HTTP *pull* integrations UI/API) | **Removed, routes return 410 Gone**; tables + HTTP *push* ingest retained | `server.js:6493-6518` (`410 … module removed`) |
| Old **branding assets** (powerx/galaxy-light/galaxy-rebrand CSS + powerx logos) | **Removed** | `release/obsolete-code-paths.txt` |
| `public-request.html`, `set-password.html`, `backend/pubreq.js` (panel-request flow) | **Removed** | same list |
| API-integration **poller** | **Disabled at boot** ("HTTP incoming only") | boot block in `server.js` |
| **FTS search** | Optional, off by default (`POWERX_FTS=1`) | `backend/fts.js` |
| `SMS_RETENTION_DAYS` deletion | Off by default (0 = keep forever) | retention sweep |
| Historical duplicate UI/theme passes | Removed (single light theme now) | `release/obsolete-code-paths.txt` |

**Rule:** files listed in `release/obsolete-code-paths.txt` were removed *deliberately*. Do not recreate them, and do not
"restore" the features by pulling from an old zip.

## 32. Do not touch casually (fragile areas)

| Area | Why it is fragile |
|------|-------------------|
| `backend/schema.js` migrations | Runs on every boot; a wrong `ALTER`/`CREATE` can corrupt or block startup on a large production DB. |
| `handleAllocate` + number scope helpers | Ownership correctness; a mistake moves numbers between users or loses `number_history`. |
| `processIncomingSmsPayload` + `parseIncomingDate` + dedup keys | Ingestion correctness; duplicates = double payments, misses = lost traffic. |
| Payout/rate/cycle maths (`§18`) and `payment_ledger` writes | Real money. Never change precedence, never re-price history. |
| `requireAgentChatUnlock` / PIN flow | Protects the payment section; weakening it exposes agent payment actions. |
| `sms_daily_stats` maintenance + `reconcileStatsAtBoot` | Dashboards read only this table; drift shows wrong money. |
| `smsPagedOrderSql` / `received_at DESC, id DESC` | The P20 live-refresh relies on "newest first"; other ordering breaks it (and pagination). |
| `cachedJson` ver keys (`numbers_ver`) | Stale caches after writes look like data loss to users. |
| UK-time helpers (`ukDateExpr*`, `ukOffsetSegments`) | DST bugs shift reports by an hour or duplicate/miss rows. |
| `sharingPublic()` masking + sharing forward path | Leaks credentials if changed; double-sends if made "retry-happy". |
| Single-process assumptions (PM2 fork/1, sync/SMPP/backup autostart) | Cluster mode = double writes and double sends. |
| `ecosystem.config.js`, nginx template, backup dir naming | Ops tooling (`powerx-watchdog`, `alert-check`, exports) depends on these names. |
| `api.js` `cachedGet` and the token storage keys (`ms_token`, `ms_role`) | Every panel depends on them; changing keys logs everyone out / breaks PIN UI. |
| The HTML panels' element ids (`numBody`, `page-*`, `data-page`) | `assets/*.js` bind to them by id; renames silently disable copy/dashboard/credit-notes features. |

## 33. Feature dependencies (what breaks if you change X)

| If you change… | These break |
|---|---|
| `users.parent_id` semantics | allocation depth rules, `descendantIds`/`scopeIds`, every role-scoped list and payment scope |
| `numbers.manager_id/agent_id/client_id` columns or their partial indexes | number lists, allocation, ingest attribution, stats, exports |
| `sms_records` column names (`received_at`, `payout_amount`, `payout_rate`, `is_test`, `limit_reason`) | all reports, CDR, stats-summary, dashboard (via stats), ledger creation |
| `sms_daily_stats` shape | `/api/dashboard`, stats pages, `reconcileStatsAtBoot` |
| `buildSmsPagedQuery` | SMS list, CDR report, stats-summary, exports (sms) — all four share it |
| `payment_ledger` columns (`cycle_key`, `eligible_at`, `status`, `amount`) | agent balances, withdrawal validation, credit notes, admin payment pages |
| `payment_schedule` / `payment_type` values | eligibility dates, credit-note maturity filter, minimum-withdrawal per type |
| `chat_credentials` (rename/drop) | PIN unlock + agent payment gate + admin PIN management + the cleanup test |
| PIN token type strings (`chat_unlocked`/`account_pin_unlocked`) | `requireAgentChatUnlock`, `handleLockStatus` (URL-level 403s) |
| `ranges.rate_*` / `provider_rate_*` semantics | payouts, provider summary, CDR money columns |
| `daily_limit_rules` semantics | ingest zeroing (`payout_amount`, `limit_reason`) and the Limit Management page |
| `sharing_users.connection_type` / `http_config` | Panel Sharing forwards; if SMPP is selected, `smpp_connections` must exist |
| `smpp_connections` columns used by `smppService` | SMPP client/server sessions; reconnect state |
| `meta` keys (`numbers_ver`, `p19k_stats_reconciled`, FTS keys) | cache invalidation and boot reconciliation |
| `assets/*.js` table ids / page ids | copy button, dashboard rendering, credit-notes page mounting |
| `api.js` path prefix (`/api`) or error shape | every panel's error handling and alerts |

## 34. Security model and considerations

**Model:** bearer JWT (12 h) + role guard + SQL scope + secondary PIN for agent payments + rate limits + audit logging.
Secrets live in `.env` (never in the repo); `system_security` holds the admin security code and carrier lock password.

**Strengths:** scoping is enforced in SQL by role (not just hidden in the UI); destructive number operations are
admin-gated or scope-checked; allocation/imports are idempotent; provider/SMPP secrets are masked in API responses;
login and mutations are audited; ingest is IP/credential-gated for carriers.

**Weak points / things to verify in production:**

1. **`JWT_SECRET` fallback.** `backend/auth.js` falls back to a literal dev secret if the env var is missing. On a
   production host, an unset `JWT_SECRET` means anyone who knows the (public, in-repo) fallback can mint admin tokens.
   **Always set `JWT_SECRET`** (64+ hex chars) and consider failing fast when it is missing.
2. **`CARRIER_LOCK_PASSWORD` fallback** (`'Dawood'` in code) — set it in `.env` or the carrier-lock is guessable.
3. **Admin seed credentials are hardcoded** (`vibepk`/`vibepk123` in `backend/seed.js`) and the test account is
   `test`/`test123`. Change the admin password on first login; disable or delete the `test` account in production if the
   `/test` panel must not be reachable.
4. **`/api/webhook/sms` is unauthenticated** (internal/test ingress). Block it at nginx/firewall on public hosts.
5. **CORS is open** — acceptable only because tokens are header-based (not cookies). Do not add cookie auth without CSRF
   protection.
6. **No token revocation**: a leaked token is valid until expiry (12 h); to force-logout everyone, rotate `JWT_SECRET`.
7. **`users.password` is bcrypt** (cost 10) — keep it that way; PIN hashes live in `chat_credentials` and share bcrypt.
8. **Unlock tokens** (`chat_unlocked`) are 12 h and are accepted by `requireAgentChatUnlock`; they are *not* valid for
   normal APIs (`chatAuthRequired` rejects them there) — do not "simplify" that distinction.
9. **Uploads/imports** are parsed in-process (xlsx/multer, 2 MB body limit). Treat uploaded files as untrusted; the code
   validates sizes/rows (`RANGE_IMPORT_MAX_ROWS`, batch sizes).
10. **Rate limits are per IP** (plus a per-user limit in `auth.js`). Behind a proxy, ensure `X-Forwarded-For` is set,
    otherwise all users share one bucket (and `source_ip` logs become useless).
11. **Backups contain all data** (including hashes and PIN hashes) — store them encrypted/access-controlled; they are
    downloadable by any admin via the panel.
12. **Exports** are downloadable by URL token for `EXPORT_TTL_HOURS` — treat the export directory as sensitive.
13. **Legal gate** stores the accepted policy version (`2026-09-13-v1`); changing the version forces re-acceptance for
    every user on next login page view.

## 35. Data-loss risks

| Risk | Description | Mitigation |
|------|-------------|------------|
| **Starting the app on a wrong DB path** | `DB_FILE` unset in a fresh directory → a new empty `backend/data.sqlite` is created and seeded, hiding the real data | Always set `DB_FILE` explicitly in `.env`; verify `/api/health` and the dashboard totals after any start |
| **Copying a live DB without `-wal`/`-shm`** | WAL contains committed transactions not yet in the main file; a plain `cp` loses them | Use the backup endpoints/`VACUUM INTO`, or copy file+wal+shm together, or stop the app |
| **`SMS_RETENTION_DAYS > 0`** | Permanently deletes old `sms_records` (and thus the evidence behind payments) | Default is 0; only enable with a policy decision + verified backups |
| **`POST /api/backups/:file/restore`** | Replaces the live database; a wrong file = data loss | Only ever run with a fresh backup taken immediately before |
| **`DELETE /api/numbers/all`, `/api/numbers/range/:rangeId`, `number-import-batches/:batchId`, `numbers/imported-all`** | Bulk inventory deletion (admin) — irreversible without a backup; reports keep working because they store snapshots, so the loss is silent for reports | Confirm the exact filter, take a backup, prefer unallocate over delete |
| **Dropping legacy tables** (`chat_conversations`, `assistant_*`, `channel_*`, …) | Removes historical data that no feature serves but that is still evidence | Never drop; the cleanup test asserts these tables still exist |
| **Deleting `release/` manifests or `obsolete-code-paths.txt`** | Loses the record of which paths were deliberately removed (and the sync tool stops working) | Keep them (they are in this package) |
| **Editing schema.js to "clean up" columns** | Old databases keep those columns physically; `SELECT *` callers and migrations can break | Additive changes only |
| **Two app instances** | Double ingest/ledger writes and duplicated outbound sharing | PM2 fork/1 is mandatory |
| **Deleting `meta` keys** | Cache versioning and boot reconciliation state lost (stale caches, re-backfill) | Treat `meta` as part of the data |

## 36. Performance-sensitive areas

| Area | Sensitivity | Why / what to know |
|------|-------------|--------------------|
| `sms_records` (largest table) | every report scans it under filters | 15+ composite indexes exist (`(scope, cli, received_at)`, `(scope, received_at)`, `(received_at DESC, id)`, `(is_test, received_at)`); always filter with scoped columns so an index is usable |
| `sms_daily_stats` | dashboard must stay O(days) | ingest increments it; the dashboard must never be changed to scan `sms_records` |
| Paged SMS responses | memory | streamed (`sendPagedStreaming`) with role caps; do not return an unbounded array |
| Ingest path | latency-critical at 50–70 SMS/s | dedup lookups use unique indexes (`smpp_seen`, `api_integration_seen`); keep the ingest transaction short; FTS must stay opt-in |
| Allocation/import | write-heavy | temp-table batching + `IMPORT_BATCH_SIZE`; heavy-write rate limit 120/min/IP; imports can run as jobs |
| Exports | CPU/IO heavy | worker threads with their own read-only connection, max 2 concurrent |
| `cachedJson` | reduces DB pressure | used for dashboard (10 s), stats-summary (1.5 s), SMS report (1.2 s); keep TTLs sensible and bump ver keys |
| Retention sweep | long-running deletes | runs 24 h apart with `SMS_RETENTION_DAYS=0` = no-op by default |
| `VACUUM INTO` backups | IO spike | every 3 h by default; size the disk for it |
| `LIKE '%x%'` message search | full scan without FTS | `POWERX_FTS=1` provides the trigram index; keep the fallback path |
| Number scope queries | partial indexes | `idx_numbers_unallocated*`, `idx_numbers_mgr_avail` are partial — changing the scope predicates can silently drop their use |

## 37. SQLite limits and capacity

* **Writers:** one. Readers (worker thread + WAL) can read concurrently. Anything that must write (imports, exports
  writing to `jobs`, ingest) goes through the single Node process.
* **Practical capacity:** comfortably handles millions of `sms_records` rows on SSD with the existing indexes
  (the project's own history notes a ~325 k/176 MB sql.js crash that motivated the better-sqlite3 migration; the current
  design targets multi-million row tables). `cache_size` 256 MB and `mmap_size` 1 GB are tuned for VPS hardware — raise
  `SQLITE_CACHE_MB` only if the host has RAM to spare.
* **File growth:** `sms_records` + `number_history` + `webhook_logs` dominate. WAL file can grow during long
  transactions — watch it. `VACUUM INTO` backups need free space ≈ DB size.
* **Locking:** `busy_timeout=10000` (10 s) means a long write transaction blocks others up to 10 s — keep writes short.
* **`case_sensitive_like=ON`** is deliberate (usernames/CLI comparisons in places depend on it). Turning it off changes
  search behaviour.
* **No sharding/partitioning.** Archival (if ever needed) must be a deliberate, approved retention policy — not a
  cleanup.

## 38. Hardcoded values that affect functionality

| Value | Where | Effect |
|-------|-------|--------|
| Admin seed `vibepk` / `vibepk123`, test `test` / `test123` | `backend/seed.js` | First-login credentials (constants, not env) |
| `JWT_SECRET` dev fallback | `backend/auth.js` | Tokens can be forged if the env var is missing |
| `CARRIER_LOCK_PASSWORD` fallback `'Dawood'` | `server.js:5740` | Carrier integration unlock |
| JWT expiry `12h` | `auth.js` (`sign`, PIN unlock) | Session + unlock lifetime |
| PIN lock policy: 5 attempts → 15 min | `backend/chat.js` | Agent payment PIN lockout |
| `UK` timezone (`Europe/London`) everywhere | `ukDateExpr*`, `ukOffsetSegments`, limits, cycles | Report/limit/cycle boundaries |
| Cycle fallback `weekly_7_1` | payout/cycle resolution | If neither number, user nor range defines a cycle |
| `ROLE_PAGE_MAX {admin:100000, manager:5000, agent:5000, client:500, test:500}`, `ROLE_ALL_MAX {admin:200000}` | `server.js:2724` | Report page ceilings |
| Default rate-limit numbers (1200/12000/120, login 10/5 min) | `server.js` | Abuse protection |
| Activity-log retention: `HISTORY_RETENTION_DAYS 90`, `FAILED_SMS_RETENTION_DAYS 7`, `SMS_RETENTION_DAYS 0` | `server.js` | What gets deleted automatically |
| Backup defaults: enabled, 3 h, 30 days, `~/nova-sms-backups` | `backend/backup.js` | Backup timing/paths |
| Export defaults: TTL 24 h, 2 concurrent, `~/powerx-exports` | `server.js` | Export lifecycle |
| Legal policy version `2026-09-13-v1` | `server.js` | Re-acceptance trigger |
| SMS stats start date / UK date helpers | `server.js` | Which "today" the dashboard/limits use |
| `test` account always recreated if missing | `seed.js` | The test panel cannot be permanently removed by deleting the account alone |
| `?v=…` asset cache-busters (`light-20260928`, `20260728-agent-manager-allocation-final`) | every HTML page | Bumping them is the supported way to force a client refresh |
| Number-matching normalization (strip `+`, spaces, `-`, `_`) | `cleanPhone` + indexes | How carrier numbers map to inventory numbers |

## 39. Before you modify anything (checklist)

1. **Read, don't guess.** Trace the feature UI → panel JS → `api.js` → route in `server.js` → SQL → table **before** editing.
2. **Never point a test at production.** Use a copy of the DB (`DB_FILE`), a non-production `JWT_SECRET`,
   `SYNC_ENABLED=false`, `SMPP_ENABLED=false`, `BACKUP_ENABLED=false`.
3. **Back up first** (`POST /api/backups/create` or `VACUUM INTO`) and keep backups off the machine.
4. **Respect the frozen contracts** listed in §32/§33 (rate precedence, ledger, scope helpers, ordering, ids, route paths).
5. **Keep the single-process model** (PM2 fork/1); never run two instances.
6. **Additive only** in `schema.js`; never drop/rename columns or tables.
7. **Preserve API compatibility**: no renamed paths, no changed response keys for endpoints a panel uses,
   no removed query params.
8. **Preserve role behaviour**: any new endpoint must use `authRequired` + `requireRole` (and `requireAgentChatUnlock`
   for payment) and the existing scope helpers.
9. **Run the checks below** before claiming success.
10. **Keep documents in sync**: this README, `AUDIT_REPORT.md`, and (if you change deploy behaviour) `docs/*.md`.

### 39.1 Verification commands that exist in this package

```bash
for f in *.html; do node scripts/check-html-scripts.js "$f"; done   # inline-JS syntax check, per page
node tests/credit-notes.test.js                        # credit-notes module (in-memory DB)
node tests/verify-galaxy-cleanup-and-security.js        # security + cleanup assertions (fixture DB, mocked auth)
node tests/ui-theme.test.js                            # theme/UI contract checks
curl -sS http://127.0.0.1:4000/api/health               # server alive
```

### 39.2 What the project's own history proved must be tested manually

The project's approved change reports (in `release/`) show the working style used for every previous change:
**live HTTP/DB verification on a fixture copy, panel-by-panel UI checks, and a written PASS/FAIL list**. Since there is no
CI in this repository, any change to the areas in §32 should be verified the same way: start the app on a fixture DB, log
in as each role, exercise the affected pages, and check the DB rows and payout/ledger values afterwards.

### 39.3 Known-good baseline for comparison

* Frozen source bundle: `Galaxy-SMS-Latest-OTP-Fix-Source-v7.zip`
  (92 entries, sha256 `abdc5afa88573c0d62f221631d4ea197a1e8cb9037f935b0d267385f8bab914f`).
* Previous frozen bundle: `Galaxy-SMS-P19k-Source-v6.zip`
  (91 entries / 698 888 B, sha256 `3944d614…b38`).
* `release/p20-latest-otp-2026-10-04.json` records the last change (agent.html + client.html, 6 hunks each) with file
  hashes — use it as a diff reference.

### 39.4 Test files in this package

| File | What it asserts |
|------|-----------------|
| `tests/credit-notes.test.js` | credit-notes grouping/derivation/filters against an in-memory DB |
| `tests/verify-galaxy-cleanup-and-security.js` | removed modules are gone, legacy tables are still present, PIN/auth routes behave, no obvious secret leakage |
| `tests/ui-theme.test.js` | UI theme/asset contract (light-only theme, required asset links) |

## 40. Feature trace registry: UI → frontend → API → backend → DB

| # | Feature (UI) | Frontend | API route(s) | Backend | Tables |
|---|--------------|----------|--------------|---------|--------|
| 1 | Login + role redirect | `login.html`, `api.js` | `POST /api/login`, `GET /api/me` | `server.js` auth block, `auth.js` | `users`, `audit_logs` |
| 2 | Dashboard KPIs | all panels + `dashboard-ui.js` | `GET /api/dashboard` | `server.js` (statsScope) | `sms_daily_stats`, `numbers` |
| 3 | Numbers list + filters | `admin/manager/agent/client.html` | `GET /api/numbers`, `/api/numbers/summary` | `numberScopeWhere` queries | `numbers`, `ranges` |
| 4 | Allocate / unallocate | Numbers & Bulk Allocation pages | `POST /api/numbers/allocate|unallocate|smart-divide|unallocate-by-range` | `handleAllocate` (+ tx, temp tables, idempotency) | `numbers`, `number_history`, `idempotency_keys`, `meta` |
| 5 | Delete / move to test | admin Numbers page | `POST /api/numbers/delete|delete-filtered|move-to-test`, `DELETE /api/numbers/all|range/:rangeId` | admin-gated handlers | `numbers`, `number_history` |
| 6 | Number import | management/admin Import pages | `POST /api/numbers/import|import-file`, `GET /api/numbers/import-jobs/:jobId`, `DELETE /api/number-import-batches/:batchId` | multer + xlsx parse + batch insert | `numbers`, `number_import_batches`, `jobs`, `meta` |
| 7 | Ranges / Rate Card | manager `rateCard`, management `rates` | `GET /api/ranges`, `/api/rate-card`, `POST /api/ranges|bulk-create|import|import-file` | range CRUD + import | `ranges`, `numbers`, `range_test_numbers` |
| 8 | SMS report (list) | `smsReport` pages | `GET /api/sms/paged` | `buildSmsPagedQuery` + streamed paging | `sms_records`, `ranges`, `numbers` |
| 9 | SMS Detail / CDR | `smsDetail` pages | `GET /api/sms/report` | grouped query incl. UK buckets + role dims | `sms_records`, `numbers`, `ranges` |
| 10 | Stats pages | `*Stats` pages | `GET /api/stats-summary/:by` | same query builder, GROUP BY dim | `sms_records` |
| 11 | CLI search | `cliSearch` pages | `GET /api/cli-search`, `/api/cli-search/suggestions` | scoped analytics | `sms_records` |
| 12 | Live "latest OTP" refresh | `agent.html`, `client.html` | `GET /api/sms/paged?page=1&limit=1&sort=date&dir=desc&_gxr=` | 8 s poll + order by `received_at DESC, id DESC` | `sms_records` |
| 13 | Test panel + fake SMS | `test.html` (+ test page in every panel) | `/api/test-panel/*`, `/api/test-numbers*` | `is_test` path of ingest | `range_test_numbers`, `sms_records` (`is_test=1`) |
| 14 | Limits | management `limitManagement` | `/api/limit-management/overview|range|cli|:id` | rule writer + ingest enforcement | `daily_limit_rules`, `sms_records.limit_reason` |
| 15 | Legacy CLI limit | `cliLimit` pages | `/api/cli-limits*` ⚠ **route missing** | — | `cli_limits` (unused) |
| 16 | Security PIN | PIN modal in `assets/chat.js` | `/api/chat/auth/lock-status|verify-lock` (+ aliases) | `backend/chat.js` | `chat_credentials` |
| 17 | PIN administration | admin `chatAccounts` | `/api/chat/admin/accounts*` (+ aliases) | `backend/chat.js` | `chat_credentials`, `users` |
| 18 | Complaints | complaints pages + `assets/chat.js` | `/api/complaints*`, `/api/chat/unread-count` | `backend/chat.js` | `complaints`, `complaint_replies` |
| 19 | Payment (agent) | agent `payment` page | `/api/payment-v2/agent/*` (`requireAgentChatUnlock`) | payment block | `payment_ledger`, `payment_requests_v2`, `agent_wallets`, `payment_notifications_v2` |
| 20 | Payment (admin) | `payment.html` | `/api/payment-v2/admin/*`, `/api/payment-v2/settings|schedule` | payment block | `payment_requests_v2`, `payment_v2_settings`, `payment_schedule`, `payment_audit_logs` |
| 21 | Credit notes | `assets/credit-notes.js` (5 panels) | `GET /api/payment-v2/credit-notes` | `backend/creditNotes.js` | `payment_ledger` |
| 22 | Panel sharing | `panel-sharing.html` | `/api/panel-sharing/*` | sharing block + `smppService` | `sharing_users`, `sharing_forward_logs`, `smpp_outbox` |
| 23 | SMPP manager | management + panel-sharing SMPP pages | `/api/smpp/*` | `smppService.js` | `smpp_connections`, `smpp_seen`, `smpp_logs`, `smpp_outbox` |
| 24 | Provider sync UI | management `apiProviders` | `/api/sync/providers|status|logs|run|reset` | `providerSync.js` | `sync_providers`, `sync_seen`, `sync_logs` |
| 25 | Providers + payments | management `providers` | `/api/providers-info*`, `/api/provider-summary` | provider block | `galaxy_providers`, `provider_payments`, `ranges.provider_rate_*` |
| 26 | Carrier integration | management `carrierIntegration` | `/api/carrier-settings|carrier-test|carrier-webhook-logs` | carrier block (+lock password) | `carrier_settings`, `activity_ips`, `webhook_logs` |
| 27 | System logs | management `systemLogs` | `/api/logs/activity|number-history|webhooks`, `/api/failed-sms*` | log readers + retry | `audit_logs`, `number_history`, `webhook_logs`, `failed_sms_queue` |
| 28 | Backups | management `backupManagement` | `/api/backups*` | `backend/backup.js` | filesystem (+ DB snapshot) |
| 29 | Users CRUD | managers/agents/clients pages | `GET /api/users/:role`, `POST/PUT/DELETE /api/users…` | scoped user CRUD | `users`, `audit_logs` |
| 30 | Profile / security code / activity | gear menu from `api.js` | `/api/profile`, `/api/admin-security-code`, `/api/carrier-lock-password`, `/api/activity-log` | profile block | `users`, `system_security`, `audit_logs` |
| 31 | Legal gate | login/first-load gate | `/api/legal/status|accept` | legal block | `users.legal_version/legal_accepted_at` |
| 32 | Exports | export buttons in lists | `POST /api/exports`, `GET /api/jobs/:id`, `GET /api/exports/:id/download` | `exportWorker.js` | `jobs`, CSV files |
| 33 | Copy to clipboard | `assets/number-copy.js` + inline helpers | — (none) | — | — |
| 34 | Ingress (carrier/SMPP/test) | — | `POST/GET /api/incoming-sms`, `POST /api/webhook/sms`, SMPP | `processIncomingSmsPayload` | `sms_records`, `sms_daily_stats`, `webhook_logs`, `failed_sms_queue`, dedup tables, `payment_ledger` |

## 41. Conventions and gotchas

* **Time:** store UTC (`received_at`), think in **Europe/London** for days/cycles/limits; never use naive local time.
* **Money:** decimal strings; sum with the provided helpers (`decimalAdd`, `normalizeDecimalString`), never floats.
* **Roles:** scope in SQL via `numberScopeWhere`/`smsScopeWhere`/`statsScope`; UI hiding is not security.
* **Cache:** `cachedJson` server-side, `cachedGet` client-side; version with `meta` keys; bypass with `_gxr`.
* **Ordering:** reports use `received_at DESC, id DESC` — keep it (pagination + live refresh depend on it).
* **Idempotency:** allocate/import style POSTs should carry/accept idempotency keys.
* **Errors:** fail with `{error}` + proper status; panels `alert(e.message)` so keep messages user-readable.
* **Route aliases:** several endpoints have legacy twins (chat/auth aliases, `.html` page aliases, `/api/stats/:by`).
  Keep both or migrate the UI deliberately — never delete one silently.
* **Naming:** `vibepk`/`powerx`/`nova`/`ms_*` prefixes are legacy identifiers, not typos.
* **Front-end:** one HTML file per panel, inline JS, element-id contracts with `assets/*.js`; add new features as a new
  `data-page` section + a loader function called from the panel's `page()` router.
* **Comments:** the codebase mixes English and roman-Urdu comments; they explain *why* (e.g. "P19d", "P20 CDR REBUILD"
  tags mark approved change rounds). `release/*.json` maps those tags to what changed.

## 42. Quick reference card

```
Panels        /panel-login  /admin  /manager  /agent  /client  /test  /management  /payment  /panel-sharing
Logins        admin: vibepk / vibepk123    test: test / test123     (change in production!)
Port          PORT=4000 (default)
Health        GET /api/health   GET /health
Start         npm ci  →  npm start          PM2: pm2 start ecosystem.config.js (fork, 1 instance)
DB            DB_FILE / DATA_DIR/data.sqlite / backend/data.sqlite  (WAL; single writer)
Backups       ~/nova-sms-backups   (BACKUP_ENABLED, BACKUP_INTERVAL_HOURS=3, BACKUP_RETENTION_DAYS=30)
Exports       ~/powerx-exports     (EXPORT_TTL_HOURS=24, EXPORT_MAX_CONCURRENT=2)
Roles         admin > manager > agent > client   (+ test sandbox)
Money         per-OTP payout → payment_ledger → payment_requests_v2 → credit notes (read-only)
Rates         numbers.rate → ranges.rate_1_1/7_1/7_7/30_45 ; provider = ranges.provider_rate_* only
Cycles        numbers.payterm → users.payment_type → ranges.payment_type → weekly_7_1
Time          stored UTC, reported/limited in Europe/London
Limits        daily_limit_rules (range | range_number | cli | number) → payout 0 + limit_reason
Ingest        /api/incoming-sms (carrier) · /api/webhook/sms (internal) · SMPP · providerSync → processIncomingSmsPayload
Reports       /api/sms/paged · /api/sms/report (CDR) · /api/stats-summary/:by · /api/dashboard
Live refresh  agent+client CDR poll /api/sms/paged?page=1&limit=1&sort=date&dir=desc every 8 s (_gxr cache-buster)
PIN gate      /api/chat/auth/verify-lock → x-chat-unlock-token → agent payment routes (403 locked otherwise)
Broken        cliLimit page (route /api/cli-limits missing) · Sharing-User modal ids (Panel Sharing) ·
              Management leftovers (renderAlloc null-deref) — all three in §30, deliberately not fixed here
Removed       Chat app, AI assistant, mobile app, bench toolkit, panel-request flow, API-integration module (410)
Frozen rule   never change rate/ledger/scope/ordering/route-contract behaviour without an approved, tested change
```

---

## Appendix A — every registered route

229 routes registered by `app.<method>()` in `backend/server.js` (210), `backend/chat.js` (18) and
`backend/creditNotes.js` (1). The **Guards** column is extracted from the route's middleware chain on that line (or the
immediately following lines); where a chain is implemented inside the handler (e.g. `handleAllocate` enforces the
one-level-down rule and scope, `authRequired`-only routes like `/api/numbers/allocate`), the guard column cannot show it —
**the code is always the authority**. `Defined at` gives `file:line` for direct lookup.

| # | Method | Path | Guards / role | Defined at |
|---|--------|------|---------------|------------|
| | | **Pages & static (HTML panels)** (38) | | |
| 1 | GET | `/` | — (public) | server.js:393 |
| 2 | GET | `/panel-login` | — (public) | server.js:394 |
| 3 | GET | `/panel-login.html` | — (public) | server.js:395 |
| 4 | GET | `/login` | — (public) | server.js:396 |
| 5 | GET | `/login.html` | — (public) | server.js:397 |
| 6 | GET | `/admin` | — (public) | server.js:398 |
| 7 | GET | `/admin.html` | — (public) | server.js:399 |
| 8 | GET | `/admin/:page` | — (public) | server.js:400 |
| 9 | GET | `/panel-sharing-login` | — (public) | server.js:401 |
| 10 | GET | `/panel-sharing-login.html` | — (public) | server.js:402 |
| 11 | GET | `/panel-sharing` | — (public) | server.js:403 |
| 12 | GET | `/panel-sharing.html` | — (public) | server.js:404 |
| 13 | GET | `/panel-sharing/:page` | — (public) | server.js:405 |
| 14 | GET | `/payment-login` | — (public) | server.js:406 |
| 15 | GET | `/payment-login.html` | — (public) | server.js:407 |
| 16 | GET | `/payment` | — (public) | server.js:408 |
| 17 | GET | `/payment.html` | — (public) | server.js:409 |
| 18 | GET | `/payment/:page` | — (public) | server.js:410 |
| 19 | GET | `/management-login` | — (public) | server.js:411 |
| 20 | GET | `/management-login.html` | — (public) | server.js:412 |
| 21 | GET | `/management` | — (public) | server.js:413 |
| 22 | GET | `/management.html` | — (public) | server.js:414 |
| 23 | GET | `/management/:page` | — (public) | server.js:415 |
| 24 | GET | `/manager` | — (public) | server.js:416 |
| 25 | GET | `/manager.html` | — (public) | server.js:417 |
| 26 | GET | `/manager/:page` | — (public) | server.js:418 |
| 27 | GET | `/agent` | — (public) | server.js:419 |
| 28 | GET | `/agent.html` | — (public) | server.js:420 |
| 29 | GET | `/agent/:page` | — (public) | server.js:421 |
| 30 | GET | `/client` | — (public) | server.js:422 |
| 31 | GET | `/client.html` | — (public) | server.js:423 |
| 32 | GET | `/client/:page` | — (public) | server.js:424 |
| 33 | GET | `/test-login` | — (public) | server.js:425 |
| 34 | GET | `/test-login.html` | — (public) | server.js:426 |
| 35 | GET | `/test` | — (public) | server.js:427 |
| 36 | GET | `/test.html` | — (public) | server.js:428 |
| 37 | GET | `/test/:page` | — (public) | server.js:429 |
| 38 | GET | `/health` | — (public) | server.js:783 |
| | | **SMS / Reports / Dashboard / Exports / Logs** (21) | | |
| 39 | POST | `/api/exports` | authRequired, requireRole('admin','manager','agent') | server.js:290 |
| 40 | GET | `/api/jobs` | authRequired | server.js:309 |
| 41 | GET | `/api/jobs/:id` | authRequired | server.js:316 |
| 42 | GET | `/api/exports/:id/download` | — (public) | server.js:324 |
| 43 | GET | `/api/sms/paged` | authRequired | server.js:3966 |
| 44 | GET | `/api/sms/paged` | authRequired | server.js:4000 |
| 45 | GET | `/api/stats-summary/:by` | authRequired | server.js:4036 |
| 46 | GET | `/api/sms/report` | authRequired | server.js:4122 |
| 47 | GET | `/api/sms` | authRequired | server.js:4191 |
| 48 | GET | `/api/sms/clis` | authRequired | server.js:4196 |
| 49 | GET | `/api/sms/numbers` | authRequired | server.js:4211 |
| 50 | GET | `/api/stats/:by` | authRequired | server.js:4227 |
| 51 | GET | `/api/cli-search/suggestions` | authRequired, requireRole('admin','manager') | server.js:4295 |
| 52 | GET | `/api/cli-search` | authRequired, requireRole('admin','manager') | server.js:4307 |
| 53 | GET | `/api/dashboard` | authRequired | server.js:4390 |
| 54 | GET | `/api/logs/activity` | authRequired, requireRole('admin') | server.js:5983 |
| 55 | GET | `/api/logs/number-history` | authRequired, requireRole('admin') | server.js:5986 |
| 56 | GET | `/api/logs/webhooks` | authRequired, requireRole('admin') | server.js:5989 |
| 57 | GET | `/api/failed-sms` | authRequired, requireRole('admin') | server.js:5992 |
| 58 | POST | `/api/failed-sms/:id/retry` | authRequired, requireRole('admin') | server.js:5995 |
| 59 | DELETE | `/api/failed-sms/:id` | authRequired, requireRole('admin') | server.js:6018 |
| | | **Numbers, Ranges, Rates, Test panel** (42) | | |
| 60 | GET | `/api/ranges` | authRequired | server.js:1471 |
| 61 | GET | `/api/rate-card` | authRequired | server.js:1518 |
| 62 | POST | `/api/ranges` | authRequired, requireRole('admin') | server.js:1527 |
| 63 | POST | `/api/ranges/bulk-create` | authRequired, requireRole('admin') | server.js:1561 |
| 64 | POST | `/api/ranges/import-test-bulk` | authRequired, requireRole('admin') | server.js:1703 |
| 65 | POST | `/api/ranges/import` | authRequired, requireRole('admin') | server.js:1741 |
| 66 | POST | `/api/ranges/import-file` | authRequired, requireRole('admin') | server.js:1978 |
| 67 | GET | `/api/ranges/import-sample` | authRequired, requireRole('admin') | server.js:2093 |
| 68 | PUT | `/api/ranges/:id` | authRequired, requireRole('admin') | server.js:2133 |
| 69 | DELETE | `/api/ranges/:id` | authRequired, requireRole('admin') | server.js:2149 |
| 70 | GET | `/api/test-numbers` | authRequired | server.js:2180 |
| 71 | POST | `/api/test-numbers/import` | authRequired, requireRole('admin') | server.js:2209 |
| 72 | POST | `/api/test-numbers` | authRequired, requireRole('admin') | server.js:2234 |
| 73 | DELETE | `/api/test-numbers/:id` | authRequired, requireRole('admin') | server.js:2253 |
| 74 | POST | `/api/test-numbers/delete` | authRequired, requireRole('admin') | server.js:2279 |
| 75 | POST | `/api/test-numbers/move-to-numbers` | authRequired, requireRole('admin') | server.js:2306 |
| 76 | GET | `/api/test-panel/dashboard` | authRequired, requireRole('admin','manager','agent','client','test') | server.js:2336 |
| 77 | GET | `/api/test-panel/sms` | authRequired, requireRole('admin','manager','agent','client','test') | server.js:2347 |
| 78 | POST | `/api/test-panel/fake/default` | authRequired, requireRole('admin') | server.js:2449 |
| 79 | POST | `/api/test-panel/fake/custom` | authRequired, requireRole('admin') | server.js:2454 |
| 80 | DELETE | `/api/test-panel/fake` | authRequired, requireRole('admin') | server.js:2464 |
| 81 | GET | `/api/numbers/summary` | authRequired | server.js:2637 |
| 82 | GET | `/api/numbers` | authRequired | server.js:2756 |
| 83 | GET | `/api/numbers` | authRequired | server.js:2799 |
| 84 | POST | `/api/numbers/allocate` | authRequired | server.js:3035 |
| 85 | GET | `/api/agent/self-allocate/ranges` | authRequired, requireRole("agent") | server.js:3042 |
| 86 | POST | `/api/agent/self-allocate` | authRequired, requireRole("agent") | server.js:3126 |
| 87 | POST | `/api/numbers/unallocate` | authRequired | server.js:3338 |
| 88 | POST | `/api/numbers/delete` | authRequired, requireRole('admin') | server.js:3583 |
| 89 | POST | `/api/numbers/move-to-test` | authRequired, requireRole('admin') | server.js:3595 |
| 90 | POST | `/api/numbers/delete-filtered` | authRequired, requireRole('admin') | server.js:3633 |
| 91 | DELETE | `/api/numbers/all` | authRequired, requireRole('admin') | server.js:3641 |
| 92 | DELETE | `/api/numbers/range/:rangeId` | authRequired, requireRole('admin') | server.js:3648 |
| 93 | POST | `/api/numbers/unallocate-by-range` | authRequired | server.js:3659 |
| 94 | GET | `/api/number-jobs/:jobId` | authRequired | server.js:3816 |
| 95 | POST | `/api/numbers/smart-divide` | authRequired | server.js:3825 |
| 96 | POST | `/api/numbers/import-file` | authRequired, requireRole('admin'), heavyWriteLimit | server.js:4661 |
| 97 | POST | `/api/numbers/import` | authRequired, requireRole('admin') | server.js:4753 |
| 98 | GET | `/api/numbers/import-jobs/:jobId` | authRequired, requireRole('admin') | server.js:4762 |
| 99 | GET | `/api/number-import-batches` | authRequired, requireRole('admin') | server.js:4769 |
| 100 | DELETE | `/api/number-import-batches/:batchId` | authRequired, requireRole('admin') | server.js:4774 |
| 101 | DELETE | `/api/numbers/imported-all` | authRequired, requireRole('admin') | server.js:4780 |
| | | **Providers** (9) | | |
| 102 | GET | `/api/provider-summary` | authRequired, requireRole('admin') | server.js:2667 |
| 103 | GET | `/api/providers-info` | authRequired, requireRole('admin') | server.js:5803 |
| 104 | POST | `/api/providers-info` | authRequired, requireRole('admin') | server.js:5856 |
| 105 | PUT | `/api/providers-info/:id` | authRequired, requireRole('admin') | server.js:5867 |
| 106 | DELETE | `/api/providers-info/:id` | authRequired, requireRole('admin') | server.js:5884 |
| 107 | POST | `/api/providers-info/:id/payments` | authRequired, requireRole('admin') | server.js:5891 |
| 108 | GET | `/api/providers-info/:id/payments` | authRequired, requireRole('admin') | server.js:5909 |
| 109 | POST | `/api/providers-info/assign-range` | authRequired, requireRole('admin') | server.js:5914 |
| 110 | POST | `/api/providers-info/assign-range` | authRequired, requireRole('admin') | server.js:5927 |
| | | **Provider Sync** (9) | | |
| 111 | GET | `/api/sync/providers` | authRequired, requireRole('admin') | server.js:445 |
| 112 | POST | `/api/sync/providers` | authRequired, requireRole('admin') | server.js:455 |
| 113 | PUT | `/api/sync/providers/:id` | authRequired, requireRole('admin') | server.js:476 |
| 114 | DELETE | `/api/sync/providers/:id` | authRequired, requireRole('admin') | server.js:500 |
| 115 | POST | `/api/sync/providers/:id/run` | authRequired, requireRole('admin') | server.js:510 |
| 116 | POST | `/api/sync/providers/:id/reset` | authRequired, requireRole('admin') | server.js:522 |
| 117 | POST | `/api/sync/test` | authRequired, requireRole('admin') | server.js:533 |
| 118 | GET | `/api/sync/logs` | authRequired, requireRole('admin') | server.js:563 |
| 119 | GET | `/api/sync/status` | authRequired, requireRole('admin') | server.js:571 |
| | | **SMPP** (12) | | |
| 120 | GET | `/api/smpp/connections` | authRequired, requireRole('admin') | server.js:631 |
| 121 | POST | `/api/smpp/connections` | authRequired, requireRole('admin') | server.js:635 |
| 122 | PUT | `/api/smpp/connections/:id` | authRequired, requireRole('admin') | server.js:649 |
| 123 | DELETE | `/api/smpp/connections/:id` | authRequired, requireRole('admin') | server.js:675 |
| 124 | POST | `/api/smpp/connections/:id/start` | authRequired, requireRole('admin') | server.js:687 |
| 125 | POST | `/api/smpp/connections/:id/stop` | authRequired, requireRole('admin') | server.js:696 |
| 126 | POST | `/api/smpp/connections/:id/restart` | authRequired, requireRole('admin') | server.js:705 |
| 127 | POST | `/api/smpp/connections/:id/test` | authRequired, requireRole('admin') | server.js:715 |
| 128 | GET | `/api/smpp/status` | authRequired, requireRole('admin') | server.js:740 |
| 129 | GET | `/api/smpp/logs` | authRequired, requireRole('admin') | server.js:750 |
| 130 | POST | `/api/smpp/connections/:id/send` | authRequired, requireRole('admin') | server.js:759 |
| 131 | GET | `/api/smpp/outbox` | authRequired, requireRole('admin') | server.js:775 |
| | | **Panel Sharing (SMPP/HTTP sharing)** (11) | | |
| 132 | GET | `/api/panel-sharing/dashboard` | authRequired, requireRole('admin') | server.js:5039 |
| 133 | GET | `/api/panel-sharing/users` | authRequired, requireRole('admin') | server.js:5045 |
| 134 | POST | `/api/panel-sharing/users` | authRequired, requireRole('admin') | server.js:5049 |
| 135 | PUT | `/api/panel-sharing/users/:id` | authRequired, requireRole('admin') | server.js:5063 |
| 136 | DELETE | `/api/panel-sharing/users/:id` | authRequired, requireRole('admin') | server.js:5088 |
| 137 | GET | `/api/panel-sharing/ranges` | authRequired, requireRole('admin') | server.js:5095 |
| 138 | GET | `/api/panel-sharing/numbers` | authRequired, requireRole('admin') | server.js:5109 |
| 139 | POST | `/api/panel-sharing/allocate` | authRequired, requireRole('admin') | server.js:5123 |
| 140 | POST | `/api/panel-sharing/bulk-allocate` | authRequired, requireRole('admin') | server.js:5300 |
| 141 | POST | `/api/panel-sharing/http/test` | authRequired, requireRole('admin') | server.js:5524 |
| 142 | GET | `/api/panel-sharing/forward-logs` | authRequired, requireRole('admin') | server.js:5605 |
| | | **Payments (payment-v2 + credit notes)** (19) | | |
| 143 | GET | `/api/payment-v2/credit-notes` | authRequired, requireRole('admin','manager','agent'), requireAgentChatUnlock | creditNotes.js:91 |
| 144 | GET | `/api/payment-v2/settings` | authRequired, requireRole('admin') | server.js:4800 |
| 145 | GET | `/api/payment-v2/schedule` | authRequired, requireRole('admin') | server.js:4808 |
| 146 | PUT | `/api/payment-v2/schedule` | authRequired, requireRole('admin') | server.js:4813 |
| 147 | PUT | `/api/payment-v2/settings` | authRequired, requireRole('admin') | server.js:4830 |
| 148 | GET | `/api/payment-v2/agent/summary` | authRequired, requireRole('agent'), requireAgentChatUnlock | server.js:4860 |
| 149 | GET | `/api/payment-v2/agent/wallet` | authRequired, requireRole('agent'), requireAgentChatUnlock | server.js:4861 |
| 150 | PUT | `/api/payment-v2/agent/wallet` | authRequired, requireRole('agent'), requireAgentChatUnlock | server.js:4862 |
| 151 | PUT | `/api/payment-v2/admin/agents/:id/wallet` | authRequired, requireRole('admin') | server.js:4878 |
| 152 | POST | `/api/payment-v2/agent/request` | authRequired, requireRole('agent'), requireAgentChatUnlock | server.js:4889 |
| 153 | GET | `/api/payment-v2/agent/requests` | authRequired, requireRole('agent'), requireAgentChatUnlock | server.js:4903 |
| 154 | GET | `/api/payment-v2/agent/notifications` | authRequired, requireRole('agent'), requireAgentChatUnlock | server.js:4904 |
| 155 | POST | `/api/payment-v2/agent/notifications/read-all` | authRequired, requireRole('agent'), requireAgentChatUnlock | server.js:4905 |
| 156 | GET | `/api/payment-v2/manager/agents` | authRequired, requireRole('manager') | server.js:4906 |
| 157 | GET | `/api/payment-v2/admin/summary` | authRequired, requireRole('admin') | server.js:4910 |
| 158 | GET | `/api/payment-v2/admin/requests` | authRequired, requireRole('admin') | server.js:4915 |
| 159 | POST | `/api/payment-v2/admin/requests/:id/reject` | authRequired, requireRole('admin') | server.js:4920 |
| 160 | POST | `/api/payment-v2/admin/requests/:id/pay` | authRequired, requireRole('admin') | server.js:4924 |
| 161 | GET | `/api/payment-v2/admin/audit-logs` | authRequired, requireRole('admin') | server.js:4929 |
| | | **Limits** (6) | | |
| 162 | GET | `/api/limit-management` | authRequired, requireRole('admin') | server.js:4945 |
| 163 | GET | `/api/limit-management/overview` | authRequired, requireRole('admin') | server.js:4949 |
| 164 | POST | `/api/limit-management` | authRequired, requireRole('admin') | server.js:4968 |
| 165 | POST | `/api/limit-management/range` | authRequired, requireRole('admin') | server.js:4990 |
| 166 | POST | `/api/limit-management/cli` | authRequired, requireRole('admin') | server.js:5003 |
| 167 | DELETE | `/api/limit-management/:id` | authRequired, requireRole('admin') | server.js:5013 |
| | | **Ingest (webhooks)** (3) | | |
| 168 | POST | `/api/webhook/sms` | — (public) | server.js:6290 |
| 169 | POST | `/api/incoming-sms` | smsIngestLimit | server.js:6315 |
| 170 | GET | `/api/incoming-sms` | smsIngestLimit | server.js:6321 |
| | | **Users / Account / Security / Complaints** (41) | | |
| 171 | GET | `/api/chat/auth/lock-status` | authRequired | chat.js:60 |
| 172 | GET | `/api/auth/pin/status` | authRequired | chat.js:61 |
| 173 | POST | `/api/chat/auth/verify-lock` | authRequired | chat.js:109 |
| 174 | POST | `/api/auth/pin/verify` | authRequired | chat.js:110 |
| 175 | GET | `/api/chat/admin/accounts` | requireRole('admin') | chat.js:129 |
| 176 | GET | `/api/account-pin/accounts` | requireRole('admin') | chat.js:130 |
| 177 | POST | `/api/chat/admin/accounts/:userId/password` | requireRole('admin') | chat.js:151 |
| 178 | POST | `/api/account-pin/accounts/:userId/password` | requireRole('admin') | chat.js:152 |
| 179 | POST | `/api/chat/admin/accounts/:userId/toggle` | requireRole('admin') | chat.js:174 |
| 180 | POST | `/api/account-pin/accounts/:userId/toggle` | requireRole('admin') | chat.js:175 |
| 181 | POST | `/api/chat/admin/accounts/init-all` | requireRole('admin') | chat.js:194 |
| 182 | POST | `/api/account-pin/accounts/init-all` | requireRole('admin') | chat.js:195 |
| 183 | GET | `/api/chat/unread-count` | — (public) | chat.js:200 |
| 184 | POST | `/api/complaints` | — (public) | chat.js:217 |
| 185 | GET | `/api/complaints` | — (public) | chat.js:226 |
| 186 | GET | `/api/complaints/:id` | — (public) | chat.js:252 |
| 187 | POST | `/api/complaints/:id/status` | requireRole('admin') | chat.js:280 |
| 188 | POST | `/api/complaints/:id/replies` | — (public) | chat.js:291 |
| 189 | GET | `/api/legal/status` | authRequired | server.js:1133 |
| 190 | POST | `/api/legal/accept` | authRequired | server.js:1138 |
| 191 | GET | `/api/users/:role` | authRequired | server.js:1148 |
| 192 | POST | `/api/users` | authRequired | server.js:1178 |
| 193 | PUT | `/api/users/:id` | authRequired | server.js:1222 |
| 194 | DELETE | `/api/users/:id` | authRequired | server.js:1237 |
| 195 | GET | `/api/users/hierarchy-stats` | authRequired, requireRole('admin','manager') | server.js:4359 |
| 196 | GET | `/api/api-integrations` | authRequired, requireRole('admin') | server.js:6496 |
| 197 | POST | `/api/api-integrations` | authRequired, requireRole('admin') | server.js:6499 |
| 198 | PUT | `/api/api-integrations/:id` | authRequired, requireRole('admin') | server.js:6506 |
| 199 | DELETE | `/api/api-integrations/:id` | authRequired, requireRole('admin') | server.js:6513 |
| 200 | POST | `/api/api-integrations/:id/fetch` | authRequired, requireRole('admin') | server.js:6514 |
| 201 | GET | `/api/api-integration-logs` | authRequired, requireRole('admin') | server.js:6518 |
| 202 | GET | `/api/backups` | authRequired, requireRole('admin') | server.js:6535 |
| 203 | POST | `/api/backups/create` | authRequired, requireRole('admin') | server.js:6540 |
| 204 | GET | `/api/backups/latest/download` | authRequired, requireRole('admin') | server.js:6548 |
| 205 | GET | `/api/backups/:file/download` | authRequired, requireRole('admin') | server.js:6555 |
| 206 | POST | `/api/backups/:file/restore` | authRequired, requireRole('admin') | server.js:6561 |
| 207 | DELETE | `/api/backups/:file` | authRequired, requireRole('admin') | server.js:6570 |
| 208 | GET | `/api/profile` | authRequired | server.js:6579 |
| 209 | PUT | `/api/profile` | authRequired | server.js:6585 |
| 210 | POST | `/api/logout` | authRequired | server.js:6649 |
| 211 | GET | `/api/activity-log` | authRequired | server.js:6654 |
| | | **Ops / Carrier / Security** (11) | | |
| 212 | GET | `/api/activity-ips` | authRequired, requireRole('admin') | server.js:5774 |
| 213 | POST | `/api/activity-ips` | authRequired, requireRole('admin') | server.js:5777 |
| 214 | PUT | `/api/activity-ips/:id` | authRequired, requireRole('admin') | server.js:5788 |
| 215 | DELETE | `/api/activity-ips/:id` | authRequired, requireRole('admin') | server.js:5795 |
| 216 | GET | `/api/carrier-settings` | authRequired, requireRole('admin') | server.js:5939 |
| 217 | PUT | `/api/carrier-settings` | authRequired, requireRole('admin') | server.js:5944 |
| 218 | POST | `/api/carrier-test` | authRequired, requireRole('admin') | server.js:5958 |
| 219 | GET | `/api/carrier-webhook-logs` | authRequired, requireRole('admin') | server.js:5967 |
| 220 | DELETE | `/api/carrier-webhook-logs` | authRequired, requireRole('admin') | server.js:5972 |
| 221 | PUT | `/api/admin-security-code` | authRequired, requireRole('admin') | server.js:6617 |
| 222 | PUT | `/api/carrier-lock-password` | authRequired, requireRole('admin') | server.js:6633 |
| | | **Other API** (7) | | |
| 223 | GET | `/api/health` | — (public) | server.js:784 |
| 224 | POST | `/api/admin/analyze` | authRequired, requireRole('admin') | server.js:804 |
| 225 | GET | `/api/admin/fts-status` | authRequired, requireRole('admin') | server.js:810 |
| 226 | GET | `/api/admin/backfill-stats` | authRequired, requireRole('admin') | server.js:811 |
| 227 | POST | `/api/admin/backfill-stats` | authRequired, requireRole('admin') | server.js:812 |
| 228 | POST | `/api/login` | loginRateLimit | server.js:1114 |
| 229 | GET | `/api/me` | authRequired | server.js:1126 |
## Appendix B — table list

**43 tables created by `backend/schema.js`** (row counts below are from a *fixture/reference* database used for
verification — never treat them as production numbers). **74 indexes** exist; the most important ones for performance are
listed in §36. A real production database may additionally contain 8 legacy tables from removed features
(§7, §31) — 51 application tables was the count observed on the reference production DB.

| Table | Rows (fixture) | Purpose |
|-------|---------------|---------|
| `users` | 8 | accounts + hierarchy (`parent_id`) + role + payment_type + legal acceptance |
| `chat_credentials` | 6 | Account Security PIN / `chat_enabled` / lock state (legacy name, live feature) |
| `system_security` | 1 | admin security code + carrier lock password |
| `activity_ips` | 0 | provider IP allow-list entries |
| `audit_logs` | 2 | every `logAction()` audit entry |
| `ranges` | 3 | range/product master with rate cards + provider + limits settings |
| `range_test_numbers` | 62 | test numbers per range |
| `numbers` | 35 | number inventory + ownership + per-number overrides |
| `number_history` | 0 | allocation/ownership audit trail per number |
| `number_import_batches` | 0 | import batch records (undo/delete by batch) |
| `cli_limits` | 0 | **legacy** per-CLI limits (no working API) |
| `sms_records` | 149 | received SMS/OTP rows (the traffic table) |
| `sms_daily_stats` | 7 | pre-aggregated daily counters used by the dashboard |
| `webhook_logs` | 0 | ingest attempt log |
| `failed_sms_queue` | 0 | ingest failures with retry state |
| `meta` | 4 | internal keys (`numbers_ver`, stats reconciliation, FTS state) |
| `payment_ledger` | 0 | per-OTP earning entries (cycle + eligibility) |
| `payment_requests_v2` | 0 | agent withdrawal requests |
| `agent_wallets` | 0 | agent payout wallet / Binance UID |
| `payment_v2_settings` | 3 | minimum withdrawal + active flag per payment type |
| `payment_schedule` | 3 | cycle start/pay days (UK semantics) |
| `payment_audit_logs` | 0 | admin/manager payment actions |
| `payment_notifications_v2` | 0 | agent notifications |
| `sharing_users` | 0 | external panel-sharing accounts (HTTP/SMPP) |
| `sharing_forward_logs` | 0 | forwarding attempt results |
| `smpp_connections` | 0 | SMPP client/server link config + runtime state |
| `smpp_seen` | 0 | SMPP inbound dedup |
| `smpp_outbox` | 0 | SMPP MT queue |
| `smpp_logs` | 0 | SMPP event log |
| `api_integrations` | 0 | **retained** config table of the removed pull-integration module |
| `api_integration_seen` | 0 | dedup keys (still used by ingest dedup logic) |
| `api_integration_logs` | 0 | retained logs of the removed module |
| `galaxy_providers` | 3 | provider master (rate, terms, method, status) |
| `provider_payments` | 0 | payments made to providers |
| `sync_providers` | 0 | provider REST pull-sync config |
| `sync_seen` | 0 | pull-sync dedup |
| `sync_logs` | 0 | pull-sync run results |
| `carrier_settings` | 1 | carrier integration settings (IP, auth, retention) |
| `daily_limit_rules` | 0 | **live** OTP limit rules (range/range_number/cli/number) |
| `jobs` | 0 | background jobs (CSV exports) with progress/result |
| `idempotency_keys` | 0 | 7-day idempotent response store |
| `complaints` | 0 | complaints/tickets |
| `complaint_replies` | 0 | replies to complaints |

*(43 rows = the 43 tables; `meta` holds 4 keys, `system_security` and `carrier_settings` 1 row each. Counts were taken from a
fixture DB — production numbers will differ.)*

## Appendix C — files NOT in this clean package, and why

This package contains **84 files** (82 project files + `Galaxy_SMS_README.md` + `AUDIT_REPORT.md`): everything in the working
project **except** the three runtime database files and the
`.git` metadata directory. Nothing else was removed, because every remaining file is either part of the working panel, a
dependency manifest, or documentation/ops tooling referenced by the panel's own documentation.

| Excluded | Why | Where it lives instead |
|----------|-----|------------------------|
| `backend/data.sqlite`, `backend/data.sqlite-wal`, `backend/data.sqlite-shm` | **Runtime data, not source.** Contains real users (35 on the reference DB), SMS traffic and money records; also a security risk to ship. `.gitignore` already excludes `*.sqlite*`. | The production host's `DB_FILE` (or `DATA_DIR`/`backend/`). Back it up with the built-in backup endpoints. |
| `.git/` (repository metadata + worktree refs) | VCS metadata, not project source; the archive is a source snapshot. Also contains remote refs/HOOKS that must never be copied between hosts. | Your Git host / working copy. (`release/source-manifest.json` is the project's own distributable list.) |
| `node_modules/` | Installed dependencies (never part of source, excluded by `.gitignore`); `better-sqlite3` is a native module that must be rebuilt per host. | `npm ci` |
| `uploads/`, `exports/`, `backups/`, `logs/`, `.env` (if present on a host) | Runtime/secret paths, covered by `.gitignore`; `.env.example` (included) documents the keys. | Host filesystem |
| Nested wrapper folder (e.g. `Galaxy-Sms/…` at the archive root) | The task explicitly requires the archive to open **directly** on the real project files. The earlier bundles (v6/v7) had this wrapper; this one does not. | — |

**Everything else was deliberately KEPT**, including items that may look removable but are not safe to drop without a
decision (each one is referenced by documentation or ops tooling):

| Kept | Reason |
|------|--------|
| `docs/*.md`, `deploy/*`, `scripts/*`, `ecosystem.config.js`, `deploy.sh`, `add-provider.sh` | Operational/deployment material referenced by the project README and used to run the panel in production. |
| `release/*.json` + `release/obsolete-code-paths.txt` | Change records with hashes; `obsolete-code-paths.txt` is the authoritative list of what was removed on purpose (and is consumed by `tools/sync-local-clone.py`). |
| `tests/*` | The only automated checks in the repository. |
| `tools/sync-local-clone.py` | Local-only source sync helper referenced by the README (dry-run by default). |
| `backend/smppServer.js` | Dead stub, but it appears in `release/source-manifest.json`; removing it would silently change that manifest. Documented in `AUDIT_REPORT.md` §D as a removal candidate **for a later, explicitly approved cleanup**. |
| `backend/data.sqlite*` were the *only* files removed from the working tree for this package | — |

Per-category classification (working / broken / removed / dead code) is in `AUDIT_REPORT.md`.

## Appendix D — evidence and verification used for this document

Everything in this README was derived from direct inspection on **2026-10-08**:

1. **Full source read** of `backend/db.js`, `auth.js`, `seed.js`, `chat.js` (in full), `creditNotes.js`, `schema.js`
   (structure + migrations), `exportWorker.js`, `fts.js`, `backup.js`, `providerSync.js` / `smppService.js` headers and
   exports, and the key regions of `server.js` (middleware/rate limits, exports, users, allocation engine, reporting,
   limits, ingest, payment, boot sequence, plus every route registration).
2. **Route inventory:** all 229 `app.<method>()` registrations extracted with file+line, grouped, and each one matched
   against every path literal in the panels, `api.js`, `assets/*.js`, `backend/*.js`, `tests/`, `scripts/`, `docs/` and
   `release/`. Result: **42 routes with no reference found** (listed in §10.3) and **1 genuinely broken front-end call
   family** (`/api/cli-limits`, §30).
3. **Front-end → backend call check:** every `API.*(...)`, `fetch(...)`, `req('GET'|'POST', ...)`, `href=/action=` and
   path literal in the panels/assets was matched against the route list. Apart from the CLI-limit family, all remaining
   non-matches were static assets, `#` anchors and `data:` URLs (verified false positives).
4. **Live schema dump:** all tables, columns, row counts and 74 indexes read from a reference database with
   `better-sqlite3`; compared against a second database to confirm which tables are legacy-only.
5. **Panel inventory:** `data-page` nav ids and `id="page-*"` containers extracted per panel; asset usage per panel
   (which panels load `chat.js`, `credit-notes.js`, `number-copy.js`, `dashboard-ui.js`) verified by grep.
6. **Environment variables:** all `process.env.*` reads collected with their defaults and compared with `.env.example`.
7. **HTTP/boot behaviour:** boot sequence, rate limiters, static serving + SPA catch-alls, cache TTLs, role page caps and
   the P20 live-refresh mechanism read from code (and cross-checked against the frozen v7 bundle's recorded hashes).

**Known uncertainties (verify on a staging copy before touching production):** the exact production schema version
(extra legacy tables/columns), whether provider sync and SMPP are actually enabled on the live host (env-dependent), the
live `BACKUP_DIR`/`EXPORT_DIR` values, the real production `JWT_SECRET`/`CARRIER_LOCK_PASSWORD` presence, and whether the
`test` account/panel is reachable from the public internet on that host.

*End of handover README.*
