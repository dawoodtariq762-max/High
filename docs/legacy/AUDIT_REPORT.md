> **Historical record (pre-rebrand).** This file documents the previous workspace and is kept unchanged for traceability. The brand names inside are the old ones.

# Galaxy SMS — Functionality Audit & Clean-Source Report

**Date:** 2026-10-08
**Scope:** the current working Galaxy SMS panel in this package (82 project files + this report + `Galaxy_SMS_README.md`) and its backend/database.
**Method:** every statement below comes from reading the actual code, the actual live/fixture SQLite schema, and the
actual HTTP surface — plus two mechanical cross-checks:

1. **Route inventory vs. usage:** all **229** registered routes (`backend/server.js` 210, `backend/chat.js` 18,
   `backend/creditNotes.js` 1) extracted with `file:line`, then matched against every path literal found in the panels,
   `api.js`, `assets/*.js`, backend modules, `tests/`, `scripts/`, `docs/` and `release/`.
2. **Front-end call check (reverse):** every `API.*(...)`, `fetch(...)`, `req('GET'|'POST', …)`, `href`/`action` and
   path literal in the panels/assets matched against the registered routes, to find UI that calls endpoints that no
   longer exist.

**Headline results:** 186 routes are referenced by the panel front-ends, **42 routes have no reference anywhere**
(intentionally-kept aliases/tools/diagnostics), and exactly **one front-end call family is genuinely broken**
(`/api/cli-limits` used by the three "SMS CLI Limit" pages).

---

## A. Working / keep (verified implemented and functional)

These were traced UI → panel JS → `api.js` → route → handler → SQL table. All of them are in active use.

| # | Feature | Files | Routes | Tables | Evidence of "working" |
|---|---------|-------|--------|--------|-----------------------|
| A1 | Login (all 6 login pages) + role redirect | `login.html`, `*-login.html`, `api.js`, `auth.js`, `seed.js` | `POST /api/login`, `GET /api/me` | `users`, `audit_logs` | JWT issued, login audited, role dispatch present in every login page; `/api/login` under `loginRateLimit`. |
| A2 | Role hierarchy & scoping | `auth.js` (+ scope helpers in `server.js`) | all scoped routes | `users`, `numbers`, `sms_records`, `sms_daily_stats` | `descendantIds`/`scopeIds`/`numberScopeWhere`/`smsScopeWhere`/`statsScope` used consistently; allocation depth enforced in `handleAllocate`. |
| A3 | Dashboards (all panels) | `assets/dashboard-ui.js` + panel loaders | `GET /api/dashboard` | `sms_daily_stats`, `numbers` | reads the pre-aggregated table with UK dates; `reconcileStatsAtBoot()` keeps it consistent. |
| A4 | SMS Numbers inventory (list, filters, pagination, sums) | 4 panels' numbers pages | `GET /api/numbers` (2 variants), `/api/numbers/summary` | `numbers`, `ranges` | range/user/status filters + role caps + partial indexes. |
| A5 | Allocation / unallocation (one level down) | `handleAllocate` + numbers & bulk pages | `POST /api/numbers/allocate`, `/unallocate`, `/unallocate-by-range`, `/smart-divide` | `numbers`, `number_history`, `idempotency_keys`, `meta` | transactional temp-table batching, idempotency, history rows, `numbers_ver` bump. |
| A6 | Agent self-allocation (per-range opt-in) | `agent.html` self-allocate page | `GET /api/agent/self-allocate/ranges`, `POST /api/agent/self-allocate` | `ranges.self_alloc_*`, `numbers`, `number_history` | range-level enable + max/period enforced server-side. |
| A7 | Number delete / move-to-test / delete-filtered | admin numbers page | `POST /api/numbers/delete|delete-filtered|move-to-test`, `DELETE /api/numbers/all|range/:rangeId` | `numbers`, `number_history` | admin-gated; distinct semantics from unallocate. |
| A8 | Number import (CSV/XLSX, batch, jobs) | admin/management import pages | `POST /api/numbers/import|import-file`, `GET /api/numbers/import-jobs/:jobId`, `DELETE /api/number-import-batches/:batchId` | `numbers`, `number_import_batches`, `jobs` | multer + xlsx parsing, validation, batch inserts, progress job. |
| A9 | Ranges / Rate Card / bulk create / range import | manager `rateCard`, management `rates`/`import` | `GET /api/ranges`, `/api/rate-card`, `POST /api/ranges|bulk-create|import|import-file` | `ranges`, `numbers`, `range_test_numbers` | full CRUD with client rates + provider rates + limits settings. |
| A10 | SMS Report (list) with live filters | `smsReport` pages | `GET /api/sms/paged` | `sms_records` (+`ranges`,`numbers`) | shared `buildSmsPagedQuery`, streamed pages, role caps. |
| A11 | SMS Detailed Report / CDR (grouped, MY/CLIENT payout) | `smsDetail` pages | `GET /api/sms/report` | `sms_records`, `numbers`, `ranges` | 11 group dimensions with server-side role filtering + UK time buckets + totals. |
| A12 | Statistics pages (client/agent/manager/range/number) | `*Stats` pages | `GET /api/stats-summary/:by` | `sms_records` | same query builder; decimal payment strings. |
| A13 | CLI Search + suggestions | `cliSearch` pages (admin/manager/management) | `GET /api/cli-search`, `/api/cli-search/suggestions` | `sms_records` | suggestions + today/yesterday/last7/month + custom period + per-range breakdown. |
| A14 | Latest-OTP live refresh (P20) | `agent.html`, `client.html` | `GET /api/sms/paged?page=1&limit=1&sort=date&dir=desc&_gxr=` | `sms_records` | 8 s poll; refreshes only when newest id / scoped total changes; `_gxr` bypasses both caches. |
| A15 | Test panel + fake SMS injection + test numbers | `test.html`, test pages in every panel | `/api/test-panel/*`, `/api/test-numbers*` | `range_test_numbers`, `sms_records(is_test)` | same ingest path with `is_test=1`, excluded from reports/payout, purgeable. |
| A16 | Limits (live engine) | management `limitManagement` | `/api/limit-management/overview|range|cli|:id` | `daily_limit_rules`, `sms_records.limit_reason` | enforcement inside ingest (payout 0 + reason) verified in code. |
| A17 | Account Security PIN (agent payment unlock) + admin PIN management | `assets/chat.js`, `backend/chat.js` | `/api/chat/auth/*`, `/api/chat/admin/accounts*` | `chat_credentials` | 5-attempt/15-min lock, 12 h unlock token, `requireAgentChatUnlock` on payment routes. |
| A18 | Complaints / ticketing | complaint pages + `assets/chat.js` | `/api/complaints*`, `/api/chat/unread-count` | `complaints`, `complaint_replies` | create/list/detail/reply/status with role rules. |
| A19 | Payments (agent flow) | agent `payment` page | `/api/payment-v2/agent/*` | `payment_ledger`, `payment_requests_v2`, `agent_wallets`, `payment_notifications_v2` | balance/eligibility from the ledger, minimum withdrawal + PIN gate enforced. |
| A20 | Payments (admin flow) | `payment.html` | `/api/payment-v2/admin/*`, `/settings`, `/schedule` | `payment_requests_v2`, `payment_v2_settings`, `payment_schedule`, `payment_audit_logs` | pay/reject with txid/screenshot, audit trail, min-withdrawal settings. |
| A21 | Credit Notes (read-only live statements) | `assets/credit-notes.js` (5 panels) | `GET /api/payment-v2/credit-notes` | `payment_ledger` | BigInt decimal sums, cycle/maturity filters, role scope, never writes. |
| A22 | Panel Sharing (HTTP + SMPP forwarding) | `panel-sharing.html` | `/api/panel-sharing/*` | `sharing_users`, `sharing_forward_logs`, `smpp_outbox` | users/allocation/forwarding/logs + HTTP test endpoint; secrets masked in responses. |
| A23 | SMPP connections (client & server mode) | management/panel-sharing SMPP pages | `/api/smpp/connections*`, `/status`, `/logs` | `smpp_connections`, `smpp_seen`, `smpp_logs`, `smpp_outbox` | start/stop/restart/test/send, reconnect state, dedup on inbound. |
| A24 | Provider Sync (pull) + its management UI | `management.html` ("API Providers" page) | `/api/sync/providers|status|logs|run|reset` | `sync_providers`, `sync_seen`, `sync_logs` | **note:** this page is the *sync* module, not the removed integration module — it is working (env-gated). |
| A25 | Providers & provider payments | management `providers` | `/api/providers-info*` | `galaxy_providers`, `provider_payments` | CRUD + payment records with running unpaid balance. |
| A26 | Provider Summary (cost side) | admin `providerSummary` | `GET /api/provider-summary` | `ranges.provider_rate_*` | provider rate used from stored columns only; admin-scoped. |
| A27 | Carrier integration settings & test | management `carrierIntegration` | `/api/carrier-settings`, `/api/carrier-test`, `/api/carrier-webhook-logs`, `/api/carrier-lock-password` | `carrier_settings`, `activity_ips`, `webhook_logs` | lock-password gated; test endpoint present. |
| A28 | System logs & failed-SMS queue with retry | management `systemLogs` | `/api/logs/activity|number-history|webhooks`, `/api/failed-sms*` | `audit_logs`, `number_history`, `webhook_logs`, `failed_sms_queue` | admin-only readers + retry/dismiss. |
| A29 | Backups (create/list/download/restore/delete + auto) | management `backupManagement`, `backup.js` | `/api/backups*` | filesystem + `VACUUM INTO` | autostart every 3 h, retention 30 days, restore endpoint. |
| A30 | Users management (admin/manager scoped) | managers/agents/clients pages | `/api/users/:role`, `POST/PUT/DELETE /api/users…`, `/api/users/hierarchy-stats` | `users`, `audit_logs` | hierarchical creation rules + bcrypt hashing. |
| A31 | Profile, admin security code, carrier password, activity log | gear menu from `api.js` | `/api/profile`, `/api/admin-security-code`, `/api/carrier-lock-password`, `/api/activity-log`, `/api/logout` | `users`, `system_security`, `audit_logs` | admin password changes require the security code. |
| A32 | Legal/acceptable-use gate | first-load gate | `/api/legal/status`, `/api/legal/accept` | `users.legal_version/legal_accepted_at` | policy version `2026-09-13-v1` stored per user. |
| A33 | CSV exports as background jobs | export buttons in lists | `POST /api/exports`, `GET /api/jobs/:id`, `GET /api/exports/:id/download` | `jobs` + files in `EXPORT_DIR` | worker thread, progress, token+TTL download. |
| A34 | Copy-to-clipboard (per number + inline helpers) | `assets/number-copy.js` et al. | none (by design) | — | presentation-only, no network calls. |
| A35 | HTTP/SMPP ingest with dedup, limits, ledger, sharing | `server.js` ingest block, `smppService.js`, `providerSync.js` | `POST/GET /api/incoming-sms`, `POST /api/webhook/sms` | `sms_records`, `sms_daily_stats`, `webhook_logs`, `failed_sms_queue`, dedup tables, `payment_ledger` | single convergence point; tolerant payload/date parsing; ownership snapshot. |
| A36 | Optional FTS search | `backend/fts.js` | `/api/admin/fts-status`, `/api/admin/analyze` | FTS virtual table + `meta` | opt-in (`POWERX_FTS=1`), fallback to `LIKE`. |

## B. Broken / incomplete (present but not functioning, or incomplete)

| # | Item | Evidence | Impact | Suggested (not executed) direction |
|---|------|----------|--------|------------------------------------|
| B1 | **"SMS CLI Limit" page** — `manager.html` + `management.html` (nav `cliLimit`, section `page-cliLimit`; `admin.html` keeps only the dead JS + router branch) | The pages call `GET/POST /api/cli-limits` and `DELETE /api/cli-limits/:id`. A case-insensitive search of the whole backend finds **no such route** (only the `cli_limits` table and one stale line in `backend/README.md:63`). `management.html` has the full control set, `manager.html` only the table. | The page always renders empty; "add/delete limit" fails with 404 alerts. Managers/admins may believe per-CLI limits are being set when they are not. In `admin.html` the leftover functions throw only if `/admin/cliLimit` is deep-linked (caught by the page router's try/catch). | Either re-point the page to `/api/limit-management/cli` (+ `DELETE /api/limit-management/:id`) and align its columns, or remove the page/nav entry. Requires explicit approval because it changes UI behaviour. |
| B1b | **Panel Sharing → Sharing Users → Create/Edit modal never opens** | `openUser()` → `onConnTypeChange()` dereferences `activityFields`, `httpFields`, `smppFields`; those ids **exist nowhere** in `panel-sharing.html` (markup uses `boxActivityConn`/`boxHttpConn`/`boxSmppConn`). The TypeError aborts `openUser()` before `userModal.classList.add('show')`. Also `suSmppConn` vs markup `suSmppSelect` (silently caught → empty SMPP dropdown; breaks the SMPP save branch), and `httpPreviewBody`/`btnTestHttp`/`httpTestResult` are absent → HTTP preview/test cannot work. | Creating or editing a Sharing User through the UI is impossible; the HTTP preview/test helpers are dead. Number filters (`numRangeFilter`, `allocUser`, `bulkUser`) look missing but are created at runtime by `window.renderSearchSelect` — not bugs. | Approved UI fix: align the JS ids with the markup (or restore the removed wrapper divs), then re-verify the sharing flows end-to-end. |
| B1c | **Management panel leftovers from removed admin views** | `management.html` runs the full `loadRates()` at init, which calls `renderAlloc()` → `allocLen`/`allocSearch`/`allocBody`/`allocInfo` are absent in that page → uncaught TypeError; helpers targeting `numbersBody`, `importBatchBody`, `rangeFile`, `managerSBody`, etc. are equally stale. | A console error on every Management load and skipped follow-up refreshes in flows that `await loadRates()` (e.g. after a range delete/import). Management's own pages (rates, import, limit management, carrier, providers, sync, SMPP, logs, backups) are unaffected. This is the "*Management known rendering error*" recorded in the 2026-09-28 workspace report — **still present, deliberately not fixed here**. | Approved fix: either guard the stale renderers (`if(!el) return;`) or delete them together with their call sites. |
| B2 | `backend/README.md` documents endpoints that no longer exist | Line 63 documents `GET/POST/DELETE /api/cli-limits`; other sections reference the removed assistant/chat modules. | Misleads a new developer/AI. | Documentation-only fix (safe), but keep the file until the new README is adopted everywhere. |
| B3 | Duplicate registration `POST /api/providers-info/assign-range` | Two identical registrations (`server.js` ≈5914 and ≈5927); the first wins, the second is unreachable. | Confusion only; both bodies look equivalent. | Remove the dead duplicate in an approved code change. |
| B4 | `/api/jobs` (list), `GET /api/admin/backfill-stats`, `POST /api/admin/analyze`, `/api/admin/fts-status`, `/api/smpp/outbox`, `PUT /api/payment-v2/admin/agents/:id/wallet`, `POST /api/payment-v2/agent/notifications/read-all`, `GET/POST /api/limit-management` (generic) | No caller found (panel/assets/tests/docs). | These are diagnostics/ops endpoints — they may still be used by external scripts/operators. **Incomplete rather than broken:** the UI for them is missing. | Decide per endpoint: expose in an ops page, document as ops-only, or remove in an approved cleanup. |
| B5 | Legacy `/api/stats/:by` and `GET /api/sms` (old list variant) | Referenced only by older code paths; superseded by `/api/stats-summary/:by` and `/api/sms/paged`. | Two implementations of similar reporting = maintenance risk of divergence. | Deprecate deliberately (log + document), never silently delete. |
| B6 | `GET /api/exports/:id/download` shows no guard in the route list | The route is registered without `authRequired`; it validates the job's random `token` + expiry instead. | Not a bug *if* tokens stay secret (they are random and short-lived), but it is the only unauthenticated data-download path. | Document; consider adding `authRequired` + token check together. |
| B7 | `POST /api/webhook/sms` has no auth at all | Bylines in code call it internal/testing; the project's own harnesses use it. | On a public host anyone who knows the path can inject SMS rows (which can create ledger entries!). | Block at nginx/firewall, or add a shared secret. **High-priority operational check.** |

## C. Removed / abandoned (deliberately gone — do not restore)

Source of truth: `release/obsolete-code-paths.txt` (plus file headers) and the 410 responses in `server.js`.

| Item | Evidence | Data left behind |
|------|----------|------------------|
| Standalone Chat app (conversations/messages/devices/channels) | `backend/chat.js` + `assets/chat.js` headers state it is discontinued and removed; no chat UI/route remains | 8 legacy tables retained: `chat_conversations`, `chat_messages`, `chat_message_deletions`, `chat_device_tokens`, `channel_posts`, `channel_reads`, `assistant_knowledge`, `assistant_settings` |
| AI Assistant (`backend/assistant.js`, `tests/assistant_ranges.*`) | File absent; listed in `obsolete-code-paths.txt` | assistant tables |
| Public email registration / password setup (`set-password.html`) | Listed in `obsolete-code-paths.txt` | — |
| Mobile app / APK (`mobile-app/`, `galaxy-chat-v1.apk`) | Listed in `obsolete-code-paths.txt` | — |
| Bench Toolkit + historical load/UI/crash harnesses (`bench-toolkit/`, many `tests/p19*-verify.js`) | Listed in `obsolete-code-paths.txt` | — |
| Panel-request flow (`public-request.html`, `backend/pubreq.js`) | Listed in `obsolete-code-paths.txt` | — |
| **API Integration module** (HTTP *pull* integrations UI + API) | `server.js`: `/api/api-integrations*` return **410 Gone**; boot code disables the poller ("HTTP incoming only") | `api_integrations`, `api_integration_seen`, `api_integration_logs` (seen table is still used for ingest dedup keys) |
| Old branding/theme files (`powerx-*`, `galaxy-light.css`, `galaxy-rebrand.css`, `visual-rebrand/`) | Listed in `obsolete-code-paths.txt`; only `galaxy.css` + `lamix-light.css` remain and are the ones linked by every page | — |
| Historical reports/audits in the repo root (P19/P20/P21 reports, `audit-results.json`, …) | Listed in `obsolete-code-paths.txt` | — |
| Duplicate/abandoned scripts (`scripts/panel-audit.py`, benchmark scripts, chat deploy script) | Listed in `obsolete-code-paths.txt` | — |

**Rule:** because these removals were deliberate and documented, a future cleanup must not "restore" any of them from an
older zip, nor drop their remaining tables (historical data + dedup keys + the PIN store).

## D. Unused / dead code (verified by reference analysis — kept, not deleted)

| # | Item | Verification | Recommendation |
|---|------|--------------|----------------|
| D1 | `backend/smppServer.js` | Grep: **zero** references in the project. The live SMPP implementation is `smppService.js`. | Remove only in an approved cleanup **together with** updating `release/source-manifest.json`. Harmless today (never required, never started). |
| D2 | `cli_limits` table | No route/UI calls it; the live engine is `daily_limit_rules`. | Keep the table (historical rows may exist on production), remove the broken page (see B1) instead. |
| D3 | 42 unreferenced routes | Full list in the README §10.3 and in the route audit output. Categories: page aliases (`.html`, `/:page`), legacy/duplicate API aliases (`/api/auth/pin/*`, `/api/account-pin/*`), ops/diagnostic endpoints, 410 stubs, legacy stats/list endpoints. | Keep. Each one is either a compatibility alias, an ops hook, or a deliberate 410. Removing them changes compatibility for little gain. |
| D4 | `chat_credentials.must_change_password`, `chat_credentials.last_login_at`, `users.chat_display_name`, `users.skype/contact/whatsapp/email` | Written/read only partially (UI uses `chat_enabled`, `failed_attempts`, `locked_until`, `password_set_at`; contact fields are shown in profile rarely). | Keep (columns are part of the DB contract; dropping columns is a data-loss risk). |
| D5 | `api_integrations` config columns (token, dt1/dt2, poll interval…) | No route uses them any more (module removed). | Keep for history; document. |
| D6 | Legacy `GET /api/sms`, `GET /api/stats/:by`, `POST /api/sync/test` | No current UI caller found. | Keep as documented legacy; consider deprecation notes. |
| D7 | `release/*.json` older records, `docs/FINAL-WORKSPACE.md` | Not executed by the app (records only). | Keep — they are the audit trail/rationale for the current state. |
| D8 | `scripts/*` ops scripts (`powerx-watchdog.sh`, `powerx-diskguard.sh`, `verify-setup.sh`, `install-service.sh`, `alert-check.js`, `add-crapi-provider.sh`) | Not called by the app. | Keep (ops tooling, documented in README §6.5). `add-crapi-provider.sh` is the weakest candidate — it is a dev helper. |
| D9 | `tools/sync-local-clone.py` | Not called by the app; used manually for local clone updates. | Keep (dry-run by default, safety-checked). |

## E. Files/folders excluded from the clean package, and why

The package contains **84 files** (82 project files + the README + this audit report); the only things left out are the **runtime database** and the **`.git` metadata**
(README Appendix C has the full table). Summary:

| Excluded | Reason |
|----------|--------|
| `backend/data.sqlite`, `data.sqlite-wal`, `data.sqlite-shm` | Runtime data: real users (35 rows on the reference DB), SMS traffic, payment records. `.gitignore` already excludes `*.sqlite*`. Shipping them would be a data/security leak and would corrupt any host they are copied onto. |
| `.git/` | VCS metadata (remote refs, worktree refs); not source. The archive is a source snapshot. |
| `node_modules/` (present on a live host) | Installed dependencies; native module must be rebuilt per host (`npm ci`). |
| `uploads/`, `exports/`, `backups/`, `*.log`, `.env` (host artifacts) | Runtime/secret paths, excluded by `.gitignore`; `.env.example` (included) documents every key. |
| Nested wrapper directory | The archive is intentionally **flat** (project files at the root) as requested. |

**Nothing else was removed.** Files that *look* like cleanup candidates (docs, deploy templates, scripts, tests, release
manifests, the dead `smppServer.js`) were kept because each is either referenced by documentation/tooling or belongs to
the project's own audit trail — see §D and README §32 (`release/source-manifest.json` includes `backend/smppServer.js`,
so removing it would silently invalidate that manifest).

## F. Important warnings for whoever works on this next

1. **Starting the app mutates the database** (`createTables()` migrations + `seed()` + stats reconciliation + optional
   ledger backfill). Never start it against an un-backed-up production DB, and always set `DB_FILE` explicitly so a fresh
   directory cannot create a new empty database that hides the real one.
2. **Single writer, single process.** PM2 must stay `fork` with `instances: 1`; two instances = double ingest/ledger
   writes, duplicated backups/syncs and conflicting SMPP binds.
3. **Money logic is frozen.** Payout rate precedence (number → range cycle rate), provider rate provenance (stored range
   columns only), zero-payout rules (provider 0 / daily limit / forceZero), decimal-string arithmetic, and
   `payment_ledger` semantics must not change without an approved, tested change.
4. **Time is Europe/London.** All day/cycle/limit boundaries are UK wall-clock over UTC timestamps. Adding a local
   timezone "fix" will shift reports, limits and payments.
5. **`JWT_SECRET` must be set in production** — the code falls back to a literal dev secret. `CARRIER_LOCK_PASSWORD` has
   a literal fallback `'Dawood'`. Admin seed credentials (`vibepk`/`vibepk123`) and `test`/`test123` are hardcoded.
6. **`/api/webhook/sms` is unauthenticated** (internal/test ingress) and `POST /api/exports/:id/download` is token-only.
   Confirm the proxy blocks/limits these on public hosts.
7. **`cachedJson` (server) + `cachedGet` (client, ~30 s)** mean a "missing" row right after a write is usually cache.
   Bump the `meta` version key (e.g. `numbers_ver`) and/or use the `_gxr` cache-buster.
8. **Reports show snapshots.** `sms_records.manager_id/agent_id/client_id` are frozen at receipt, so unallocating or
   deleting a number never rewrites history. Any "consistency fix" that re-syncs those columns would corrupt financial
   reporting.
9. **Legacy naming is load-bearing:** `nova-sms-backups`, `powerx-exports`, `app name galaxy-sms`,
   `ms_token`/`ms_role`, `chat_credentials`, `chat_enabled`, `x-chat-unlock-token`, `api_integration_seen`. Renaming any of
   them breaks tooling, sessions or the PIN gate.
10. **The broken CLI-limit page (B1) is user-visible.** If managers rely on it, they currently set no limits at all —
    verify on staging whether real per-CLI limits are configured through the management Limit Management page.

## G. Uncertainties that need manual verification (cannot be answered from source alone)

| # | Uncertainty | How to verify |
|---|-------------|---------------|
| G1 | Exact production schema version & extra legacy tables/columns | Dump `sqlite_master` on a **copy** of the production DB and compare with `schema.js`. |
| G2 | Whether the production host sets `JWT_SECRET`, `CARRIER_LOCK_PASSWORD`, `DB_FILE`, `BACKUP_DIR`, `EXPORT_DIR` | Inspect the host `.env` (never commit it) and the running process env (`pm2 env`/systemd). |
| G3 | Whether `SYNC_ENABLED`/`POWERX_ROLE`/`SMPP_ENABLED` are actually on, and whether sync/SMPP rows exist | Check the environment + `sync_providers`/`smpp_connections` rows on production. |
| G4 | Whether the `test` account/panel is reachable from the internet | Try to reach `/test-login` from outside; if yes, decide whether to keep it. |
| G5 | Whether anything outside the repo calls the "no caller" routes (§D3) | Check nginx access logs for `/api/cli-limits`, `/api/jobs`, `/api/stats/`, `/api/smpp/outbox`, `/api/api-integrations`. |
| G6 | Whether the broken CLI-limit page is used by real managers | Ask the operators / check audit logs for `set_cli_limit`-style actions (none exist now) and `limit_management` actions. |
| G6b | Whether the Sharing-User modal / Management leftovers actually fail in the operator's browser | Open `panel-sharing.html` → Sharing Users → Create, and check the Management console. The null-dereferences are deterministic from the code, but confirm the practical impact (and any existing workaround) on a staging copy. |
| G7 | Real data volume (`sms_records` rows, DB size, WAL size) for capacity planning | `sqlite_master` counts + file sizes on production. |
| G8 | Whether backups are actually running and restorable | `GET /api/backups` + restore one into a scratch DB and boot with `DB_FILE` pointing at it. |

## H. Can this clean package serve as the base for a new SMS panel? — Verdict

**Yes, with conditions.**

**Why it is a good base**

* It is the **current working system, unchanged**: 82 project files, same routes, same schema, same permissions, same
  rate/payment logic. Nothing was redesigned, renamed or re-implemented for this package, so every previously verified
  behaviour (including the P20 latest-OTP fix in `agent.html`/`client.html`) still holds.
* The architecture is small and self-contained: one Express file for the API, one schema file, one DB file, plain HTML
  panels with a single shared `api.js` — a new panel can be added as a new `*.html` + a route block without touching the
  existing panels.
* The extension points are clean and documented: add a `data-page` section + loader in a panel, add routes with
  `authRequired` + `requireRole` + the existing scope helpers, add tables additively in `schema.js`.
* It ships with the documents a new developer needs (this README, `AUDIT_REPORT.md`, deploy/SMPP guides, change records)
  and with the three automated checks that exist.

**Conditions / prerequisites before building on it**

1. Stand it up on a **copy** of the production database (never the live file) and confirm boot logs
   (`createTables`, `seed`, stats reconcile, sync/SMPP/backup as intended).
2. Fix the environment first: `JWT_SECRET`, `CARRIER_LOCK_PASSWORD`, admin password change, disable/remove the `test`
   panel if the new panel is public, and block `/api/webhook/sms` at the proxy.
3. Decide explicitly what to do about the broken CLI-limit page (B1), the Sharing-User modal (B1b) and the Management
   leftovers (B1c) — *before* building, because a new panel may want to surface per-CLI limits and sharing configuration
   properly. All three are pre-existing and were deliberately left untouched here.
4. Keep the single-process rule (PM2 fork/1) and the frozen contracts (rates, ledger, scoping, ordering, UK time).
5. Treat the excluded database files as what they are: **runtime data lives outside the source package**, always
   backed up with the built-in backup endpoints.

With those conditions met, adding a new panel on top of this code is a normal, low-risk feature build: the new panel can
reuse `/api/login`, the JWT/role model, the scope helpers, the reporting query builder, the payment ledger and the ingest
path without modifying any of them.
