# Confluence Optimizer

A **free, open-source** Forge app for **Confluence Cloud** that shows what fills your storage and helps you clean it up safely.

Confluence Cloud Standard has a 250 GB storage limit, and Atlassian offers no built-in way to see, site-wide, which files, old versions and trashed items use that space. This app indexes your site, scores its health, lists every attachment with filters, and turns cleanup into reviewed, audited batches.

> [!WARNING]
> **Costs: read this before you deploy.** The app is free and open source, but it runs on Atlassian Forge, and since 1 January 2026 Forge usage is billed to the **owner of the Developer Space the app is registered in**. That is whoever runs `forge register`, **not** your Confluence subscription. Each app gets a monthly free allowance, and usage above it is charged once a payment method has been added (without one, Atlassian may interrupt the app).
>
> **Deploying for an organisation?** Register the app in a Developer Space owned by that organisation, not in your personal one. See [Who pays](docs/INSTALL.md#who-pays-read-first).

## What it does

| Area | What you get |
|---|---|
| **Overview** | Health score (0–100, A–F) with a transparent breakdown, storage used against your limit, months until the limit at the current growth rate, reclaimable storage, charts by file type, space and month, score history. |
| **Attachment dashboard** | Every attachment on the site in one table. Filter by space, type, age, size, name and finding; sort by size, age or versions; links to each file; CSV export. |
| **Findings** | Unused files (not referenced on any page), probable duplicates (same name and size), files with many old versions, files on stale pages, large files, trash (including files on deleted pages). |
| **Trash storage report** | Trash size and share of storage, breakdown by space, file type and age, trashed pages with their attachment storage, and reviewed purges. |
| **Review queue** | Nothing changes until a Confluence administrator approves. Actions: move to trash, purge from trash, delete old versions, purge trashed pages. Each item is re-checked just before it is changed; jobs run in the background and can be stopped. |
| **Audit log** | Every request, decision, change, failure, export and settings change, with CSV export. |
| **Space admins** | A *Storage cleanup* page in each space's settings. Space admins see only their space and can request cleanup (admins approve). |
| **Retention rules** | Optional: propose purging trash after N days, keeping only the newest N versions, or trashing unused files. Rules only create *pending* requests. |
| **Usage guard** | Counts the app's own Forge database requests per month and stops scans before the free allowance is used up. See [Cost and usage limit](#cost-and-usage-limit). |

## Safety principles

- **Reviewed:** every change goes through the review queue and needs approval by a Confluence administrator.
- **Reversible first:** "Move to trash" is the default. Permanent actions (purge, version deletion) are flagged and warned about.
- **Re-checked:** items that changed after the request was made (for example a new version was uploaded) are skipped.
- **Conservative detection:** a file counts as *used* if it appears anywhere in the page, in an Attachments or Gallery macro, or is referenced from another page. Third-party macros that refer to files by name (draw.io, Gliffy…) are covered by a loose name match.
- **Index, don't copy:** only metadata and links are stored. Page bodies are read during the scan but never stored, and file contents are never downloaded.
- **Permission-aware:** the admin console checks on every call that the user is a Confluence administrator; the space page checks that the user administers that space and limits all queries to it on the server.
- **Audited:** an append-only audit log records who requested, who approved and what happened.

## Install

You run the app under your own (free) Atlassian developer account and install it on your own site. Short version:

```bash
npm install -g @forge/cli
forge login
git clone https://github.com/<you>/confluence-optimizer.git && cd confluence-optimizer
npm install
forge register          # gives the app your own app id
forge deploy -e production
forge install -e production --product confluence --site <your-site>.atlassian.net
```

Then open **Confluence → Settings (gear) → Confluence Optimizer** and click **Scan now**.

Full instructions, including costs and troubleshooting: [docs/INSTALL.md](docs/INSTALL.md).

## Cost and usage limit

The app itself is free (Apache 2.0). Forge usage is billed to the owner of the Developer Space the app is registered in, with a monthly free allowance per app; see [Who pays](docs/INSTALL.md#who-pays-read-first) and [Cost](docs/INSTALL.md#cost). Atlassian does not stop an app at the free allowance, and Forge gives apps no way to read their own usage, so the app has its own brake.

### Usage guard (Settings → Monthly usage limit)

- The app counts every Forge SQL (database) request it makes per calendar month (UTC) and shows the total against the free allowance (100,000 requests at the time of writing).
- From 80% of the stop point it shows a warning. At the stop point (default **90%**):
  - new scans are refused, and the automatic scan is skipped;
  - a running scan pauses, keeps its position, and continues by itself on the 1st of the next month;
  - Overview and space figures are no longer recalculated (the last figures stay visible).
- Browsing results and approved clean-ups are **not** blocked, so you can always review and clean up. They are counted.
- The count is the app's own and can differ slightly from Atlassian's. Under **Correct the count**, enter the figure from the developer console (app → Usage and charges) to bring it in line. Entering a figure above the stop point blocks scans for the rest of the month.
- The limit, the stop percentage and the guard itself can be changed in Settings.

### What uses database requests

| Action | Database requests (approximate) |
|---|---|
| Opening the Attachments list, or changing a filter or page | 5–6 |
| Trash tab | 6–8 |
| Review queue or audit log page | 2 |
| Overview and space figures | almost none (served from a cache) |
| Clean-up, per file | 3–4 |
| Full scan of a large site (2,500+ spaces, 150,000+ files) | about 15,000–25,000 |

A scan is by far the largest cost, which is why the guard stops scans first and keeps the remaining 10% for browsing and clean-ups. On large sites, scan monthly (Settings → *Automatic scan every* = 30 days, the default for new installations).

Separately from the monthly allowance, Confluence limits how much an app may request per hour. When that limit is reached, scans and clean-ups pause and continue by themselves; this costs nothing.

## Documentation

- [Install and operate](docs/INSTALL.md)
- [Architecture](docs/ARCHITECTURE.md): scan pipeline, data model, review queue, how findings are computed
- [Security](SECURITY.md): permissions, scopes, reporting vulnerabilities
- [Contributing](CONTRIBUTING.md)

## Limitations (honest list)

- **Old version sizes are estimates.** The REST API does not report the size of earlier versions, so they are estimated as the same size as the current version.
- **Trash age.** The API does not say when an item was trashed. The trash report groups by *time since last change*; retention rules use *the time this app first saw the item in the trash*, which is conservative (nothing is purged early, even on the first scan).
- **Who deleted what** is only known for deletions made through this app (audit log).
- **Reclaimable storage** counts each file once, in the first category that applies: trash, unused, duplicate copy, old versions.
- **Duplicates** are matched by file name and size, not by content.
- **Unused** cannot see links from outside Confluence (email, other tools, direct download links).
- **Deleting attachment versions** uses the REST v1 "delete content version" endpoint (tested on Confluence Cloud: the oldest versions are removed, the file and its newest versions stay).
- **Restricted content:** the app only sees what the app user can read. Spaces it cannot read are skipped and reported.
- **CSV export** is shown as text to copy (UI Kit cannot trigger file downloads); it is limited to 5,000 rows per export.
- Atlassian's billed storage figure may differ slightly from the indexed total.

## Roadmap

| Capability | Status |
|---|---|
| Central attachment dashboard, filters, preview links | ✅ |
| Unused and orphaned file detection | ✅ (on Confluence Cloud, files on deleted pages go to the trash with the page, so they are reported under Trash) |
| Health score + history | ✅ storage-focused score |
| Bulk actions + review queue | ✅ trash, purge, version pruning, purge trashed pages |
| Audit log | ✅ |
| Trash storage report, purge, retention rules | ✅ (restore is done in Confluence's space trash) |
| Permission-aware / space-owner cleanup | ✅ space admins request, site admins approve |
| Reports + CSV export | ✅ storage by space, type, uploader, month; CSV |
| Bulk download | ⏳ CSV contains download links; ZIP download is not possible inside Forge UI |
| Stale page detection and page archiving | ⏳ stale pages are counted; archiving is planned |
| Label merging, macro hygiene | ⏳ planned |
| Migration readiness report, space retirement register | ⏳ planned |
| Owner notifications | ⏳ planned |
| Views-based staleness | ⏳ planned (analytics API) |

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
npm test          # unit tests + backend smoke test (no Atlassian account needed)
forge tunnel      # live-reload against your dev site
forge lint        # validate manifest and scopes
```

## License

[Apache License 2.0](LICENSE). Not affiliated with or endorsed by Atlassian. Confluence is a trademark of Atlassian.
