# Changelog

## 0.1.2 – 2026-11-24

- Fixed: scans on large sites failed with "Unknown SQL execution error" (TiDB error 8175, query over Forge SQL's per-query memory limit). The scan and all reports now work in small chunks and never join or group the whole attachments table:
  - page status, last change and space are copied onto each file during the scan
  - probable duplicates are flagged during the scan (new "dups" phase) instead of grouped at query time
  - cross-page references are resolved a few hundred at a time
  - the attachment list looks up page titles and space keys by id
  - new indexes on `scan_id` make clean-up of old rows cheap
- SQL errors now show the database's own reason (Forge SQL only reports "Unknown SQL execution error" by default), in the UI and in `forge logs`
- A space whose content keeps failing during a scan is skipped and listed, instead of failing the whole scan

## 0.1.1 – 2026-11-23

Fixes from the first test on a developer site:

- "Could be reclaimed" counts each file once (it double-counted files that matched several findings), which also corrects the health score
- Removed the "Orphaned files" finding: on Confluence Cloud, files on deleted pages go to the trash with the page and are reported under Trash
- Files in the trash show only a trash flag, not "unused" or other cleanup flags
- Long forecasts read "more than 10 years" instead of e.g. "4931 months"
- Removed the duplicate page heading in the admin console
- Space admins who are not site admins could be refused: the space admin check now asks Confluence's REST v2 "permitted operations" first (v1 as fallback) and logs the reason when it refuses
- Correct singular and plural wording ("1 page", "3 pages")
- Deleting old attachment versions is no longer marked experimental (tested on a developer site)

## 0.1.0 – 2026-11-23

First public version.

- Site-wide, resumable scan of spaces, pages, blog posts and attachments into Forge SQL
- Overview with storage health score, limit usage, growth forecast and charts
- Attachment dashboard with findings: unused, orphaned, probable duplicates, old versions, stale, large, trash
- Trash storage report with purge of trashed attachments and pages
- Review queue with approval, background execution, per-item re-checks and stop
- Audit log and CSV exports
- Space admin view with scoped requests
- Retention rules that propose (never execute) cleanup
