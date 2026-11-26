# Changelog

## 0.1.6 – 2026-11-26

- README: removed the background note at the top and simplified the roadmap heading

## 0.1.5 – 2026-11-26

- Fixed: a scan failed with "HTTP 429" when Confluence's per-app API quota (points per hour, enforced since March 2026) was used up. Scans and cleanup jobs now save their progress, pause for as long as Confluence asks, and continue by themselves. The app shows when a scan is paused and when it resumes
- A version cleanup interrupted part-way continues on retry instead of being skipped

## 0.1.4 – 2026-11-24

- Fixed: the Attachments list could hit the memory limit when filters matched only a few files (for example unused images over 20 MB, sorted by versions). Up to 5,000 matches are now fetched unsorted and sorted in code; larger result sets still use the index
- "Move all matching" requests use the same approach
- Background steps stop after 10 minutes instead of 12, leaving room for slow API back-off before Forge's 15-minute limit

## 0.1.3 – 2026-11-24

- Database setup runs one at a time (a lock in the key-value store) and only from the setup queue; the scan waits for it instead of changing the database itself. Parallel setups made an index build fail. Failed steps are retried and the database's reason is logged

## 0.1.2 – 2026-11-24

- Fixed: scans on large sites failed with "Unknown SQL execution error" (TiDB error 8175, query over Forge SQL's per-query memory limit). The scan and all reports now work in small chunks and never join or group the whole attachments table:
  - page status, last change and space are copied onto each file during the scan
  - probable duplicates are flagged during the scan (new "dups" phase) instead of grouped at query time
  - cross-page references are resolved a few hundred at a time
  - the attachment list looks up page titles and space keys by id
  - new indexes on `scan_id` make clean-up of old rows cheap
- Database setup is verified: the app checks that every migration was applied and that the new columns exist, and repairs an interrupted setup automatically instead of failing with "Unknown column"
- Large sites (tested in simulation with 2,550 spaces):
  - scan progress is saved every 15 seconds instead of after every step (far fewer key-value store writes)
  - file updates during the scan are written as 100-row upserts instead of one statement per page
  - Overview and space figures are calculated in the background queue and cached, so pages never wait on them (page requests have a 25-second limit); the page shows "Calculating figures" and updates itself
  - the space filter lists up to 10,000 spaces (was 2,000)
- Fixed: the Attachments list hit the same memory limit when sorting all files. It now reads 50 IDs from an index (new `stored_bytes` column) and loads only those rows. Sorting by name was removed because it cannot use an index
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
