# Q TECH SMS — Backend

Node.js + Express + SQLite (`better-sqlite3`) backend for the Q TECH SMS panel.
JWT authentication, role hierarchy (Admin › Manager › Agent › Client), one Express file for
the whole HTTP surface (`server.js`), one schema file, one SQLite database.

> Note: some parts of this folder previously documented routes that no longer exist
> (`/api/cli-limits`, `/api/news`, the assistant/chat modules). They were removed from the
> code long ago; this file now matches the actual route table.

---

## Run (local / staging)

```bash
node -v                 # >= 20
npm ci                  # from the project root (installs better-sqlite3, express, ...)
cp ../.env.example ../.env
DB_FILE=../data/staging.sqlite PORT=4000 node server.js
```

First boot creates + migrates every table (`schema.js`) and seeds the admin account
(`vibepk` / `vibepk123`) plus the Test panel (`test` / `test123`). **Change both before any
host is reachable.** The 13 HTML panels and `assets/` are served from the project root by the
same process.

Boot order: `db.init()` → `createTables()` → `seed()` → optional FTS init, backup/sync timers
(`ALMADA_ROLE`), SMPP service, retention sweep, stats backfill/reconcile → `app.listen(PORT)`.

`ALMADA_ROLE` selects the process mode: `all` (default, everything), `api` (HTTP only, no
timers), `sync` (timers only, no HTTP listen / no SMPP). See `deploy/ecosystem.config.cjs`.

---

## Route map (grouped)

| Area | Routes |
|---|---|
| Auth / session | `POST /api/login`, `GET /api/me`, `POST /api/logout`, `/api/profile` |
| Users & hierarchy | `GET /api/users/:role`, `/api/users/hierarchy-stats`, `POST/PUT/DELETE /api/users*` |
| Ranges / rates | `GET /api/ranges`, `/api/rate-card`, `POST /api/ranges`, `/api/ranges/import`, `/api/ranges/bulk-create`, `/api/ranges/import-file` |
| Numbers | `GET /api/numbers` (paged & ids-only/streamed), `/api/numbers/summary`, `POST /api/numbers/allocate`, `/unallocate`, `/unallocate-by-range`, `/smart-divide`, `/delete`, `/delete-filtered`, `/move-to-test`, `DELETE /api/numbers/all`, `/api/numbers/range/:id`, import + `GET /api/numbers/import-jobs/:jobId`, `/api/number-import-batches*` |
| SMS / reports | `GET /api/sms` (legacy list), `/api/sms/paged`, `/api/sms/report` (grouped CDR), `/api/sms/clis`, `/api/stats-summary/:by`, `GET /api/stats/:by` (legacy), `/api/cli-search`, `/api/cli-search/suggestions` |
| Daily limits | `/api/limit-management` (list + generic create), `/api/limit-management/overview`, `/range`, `/cli`, `DELETE /api/limit-management/:id` |
| Providers (cost) | `/api/providers-info*` (incl. `/assign-range`, `/payments`), `/api/provider-summary` |
| Provider sync (pull) | `/api/sync/providers*`, `/api/sync/status`, `/api/sync/logs`, `/api/sync/providers/:id/run`, `/reset` |
| SMPP | `/api/smpp/connections*`, `/status`, `/logs`, `/test`, `/send` |
| Carrier / ingest | `/api/carrier-settings`, `/carrier-test`, `/carrier-webhook-logs`, `/carrier-lock-password`, `POST/GET /api/incoming-sms`, `POST /api/webhook/sms` |
| Panel sharing | `/api/panel-sharing/users*`, `/dashboard`, `/allocate`, `/logs`, `/http/test` |
| Payments | `/api/payment-v2/*` (settings, schedule, agent flows, admin flows, credit notes), `/api/chat/*` (PIN gate) |
| Complaints | `/api/complaints*` |
| Exports / jobs | `POST /api/exports`, `GET /api/jobs/:id`, `GET /api/exports/:id/download` |
| Backups | `/api/backups*` (list/create/download/restore/delete) |
| Logs / maintenance | `/api/logs/activity`, `/api/logs/number-history`, `/api/logs/webhooks`, `/api/failed-sms*`, `/api/activity-log`, `/api/legal/status|accept`, `/api/admin/fts-status`, `/api/admin/analyze` |

Removed on purpose: `/api/api-integrations*` returns **410 Gone**; `/api/cli-limits` and
`/api/news` do not exist (CLI limits live in `daily_limit_rules` through `/api/limit-management`).

---

## Frozen contracts (do not "fix" these)

1. **Money**: payout rate precedence = `numbers.rate` → range cycle rate (`ranges.rate_*`);
   provider rate comes only from stored `ranges.provider_rate_*`; decimal-string arithmetic;
   `payment_ledger` rows only when an agent is involved and payout > 0.
2. **Scoping**: every list/report is filtered by `scopeIds`/`numberScopeWhere`/`smsScopeWhere`;
   allocation moves one level down only.
3. **Time**: Europe/London wall-clock boundaries over UTC timestamps.
4. **Snapshots**: `sms_records.manager_id/agent_id/client_id` are frozen at receipt; never
   re-sync them from current allocation.
5. **Ingest convergence**: all four ingest paths meet in `processIncomingSmsPayload`
   (dedup → limits → zero-payout rules → ledger → sharing).
6. **Single writer**: one process owns writes (PM2 fork/1, WAL).

## Operational security notes

* `POST /api/webhook/sms` is an internal ingest hook, open by default. Set `WEBHOOK_SECRET`
  to require a shared secret. Block it at the proxy if the host is public.
* `GET /api/exports/:id/download` authenticates with the job's random token + TTL (capability
  URL used by the panel download button).
* Default fallbacks exist for `JWT_SECRET` and `CARRIER_LOCK_PASSWORD` — always set both in
  production.
* `CARRIER_LOCK_PASSWORD` gates the carrier-settings API (`x-carrier-lock` header or
  `?carrier_lock=` query).
