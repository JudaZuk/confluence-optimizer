# Architecture

```
Confluence UI (UI Kit)                    Forge functions                         Storage
┌──────────────────────────┐   invoke   ┌──────────────────────────┐          ┌───────────────┐
│ Global settings: console │──────────▶ │ admin-resolver           │─────────▶│ Forge SQL     │
│ Space settings: cleanup  │──────────▶ │ space-resolver           │          │ (metadata)    │
└──────────────────────────┘            └──────────┬───────────────┘          ├───────────────┤
                                                   │ push                      │ Forge KVS     │
                                     ┌─────────────┼──────────────┐            │ settings,     │
                                     ▼             ▼              ▼            │ scan state    │
                              coam-scan      coam-exec      coam-migrate       └───────────────┘
                              scan-worker    exec-worker    migrate-worker
                                     │             │
                                     ▼             ▼
                          Confluence REST v2 (read)   v2/v1 (approved writes only)
```

Everything runs on Atlassian's infrastructure (Forge, "Runs on Atlassian"). There is no external server and no egress.

## Code layout

```
manifest.yml                 modules, queues, scopes
src/index.js                 function entry points
src/backend/
  confluence.js              REST client (rate-limit aware)
  scan.js                    resumable scan pipeline
  executor.js                runs approved requests
  requests.js                review queue
  rules.js                   retention rules -> pending requests
  summary.js                 storage summary, trash report, health snapshot
  auth.js                    site/space admin checks (as the user)
  audit.js                   audit log
  settings.js                settings in KVS
  db/schema.js, db/sql.js    migrations and SQL helpers
  lib/                       pure logic (unit tested): refs, filters, health, files, csv, time
  resolvers/                 admin, space, shared handlers
src/frontend/                UI Kit: admin/, space/, components/
src/shared/format.js         formatting shared by UI and backend
test/                        node:test unit tests and a backend smoke test with Forge stand-ins
```

## Scan pipeline

The scan is a chain of async events. Each invocation works for up to 12 minutes (function timeout 15), stores its position in KVS after every step and queues the next invocation. A cancelled or stuck scan is detected by its heartbeat; the daily trigger restarts it.

| Phase | Calls | Writes |
|---|---|---|
| spaces | `GET /wiki/api/v2/spaces` (default and archived) | `spaces` |
| attachments | `GET /wiki/api/v2/attachments?status=current,archived,trashed` (250 per call, site-wide) | `attachments` |
| content | per space: `GET /spaces/{id}/pages` and `/blogposts` with `body-format=storage` (50 per call), then trashed ones | `contents`, `attachment_refs`, `attachments.is_referenced` |
| finalize | SQL only, per space | space ids, resolved cross-page references |
| missing | SQL only | `orphan_reason = container_missing` |
| cleanup | SQL only | deletes rows not seen in this scan |
| snapshot | SQL only | KVS `summary`, `health_snapshots` |
| rules | SQL only | pending `requests` |

Rows carry the `scan_id` that last saw them; cleanup removes older rows only when the phase that writes them completed fully, so a partial scan never deletes valid data.

### Reference analysis

For each page body (storage format) `lib/refs.js` extracts:

- `<ri:attachment ri:filename="…"/>` without a target → used on the same page;
- `<ri:attachment>` with `<ri:page>`, `<ri:blog-post>` or `<ri:content-entity>` → cross-page reference, resolved after all spaces are read;
- Attachments / Gallery macros → every file on the page (or the target page) is used;
- loose match: the file name, or its base name when at least 4 characters long, appears anywhere in the decoded body.

An attachment is *unused* only if none of these match **and** it has not changed for `unusedMinAgeDays`.

## Data model (Forge SQL)

| Table | Purpose |
|---|---|
| `spaces` | id, key, name, type, status |
| `contents` | pages and blog posts: space, title, status, last change, flags; `trashed_seen_at` |
| `attachments` | file metadata, size, version number, status, page, links, `dup_key` (sha1 of lower-case name + size), `is_referenced`, `orphan_reason`, `trashed_seen_at` |
| `attachment_refs` | cross-page references found in page bodies |
| `requests`, `request_items` | review queue |
| `audit_log` | append-only audit trail |
| `health_snapshots` | one row per day: score and totals |

Stored size per attachment is estimated as `file_size × version_number` because earlier version sizes are not available from the API.

## Review queue

1. A user creates a request (ids or "all matching filters", max 5,000 items). The server re-reads the items from the index, applies the user's scope and keeps only items in the right state for the action.
2. A Confluence administrator approves or rejects it (`decideRequest`), which pushes an event to `coam-exec`.
3. `exec-worker` takes a lease on the request, processes items in batches of 25, re-checks each item against Confluence (still exists, same version) and performs the action as the app. Results are written per item, to the request counters and to the audit log.
4. The worker hands over to a new invocation when its time budget runs out. Admins can stop a running request.

| Action | Endpoint | Reversible |
|---|---|---|
| `trash_attachment` | `DELETE /wiki/api/v2/attachments/{id}` | yes, from the space trash |
| `purge_attachment` | `DELETE /wiki/api/v2/attachments/{id}?purge=true` | no |
| `prune_versions` | `DELETE /wiki/rest/api/content/{id}/version/1`, repeated | no |
| `purge_page` | `DELETE /wiki/api/v2/pages/{id}?purge=true` (or blogposts) | no |

## Health score

`lib/health.js`. Starts at 100 and subtracts bounded penalties:

| Area | Max | Full penalty at |
|---|---|---|
| Reclaimable share of storage | 35 | ≥ 40 % (none below 5 %) |
| Storage limit usage | 25 | ≥ 100 % (none below 60 %) |
| Trash share | 10 | ≥ 20 % (none below 2 %) |
| Stale pages share | 15 | ≥ 70 % (none below 20 %) |
| Growth: months until limit | 15 | ≤ 3 months (none beyond 24) |

Grades: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, F below.
