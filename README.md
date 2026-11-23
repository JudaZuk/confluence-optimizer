# Confluence Optimizer & Attachment Manager

A **free, open-source** Forge app for **Confluence Cloud** that shows what fills your storage and helps you clean it up safely.

Confluence Cloud Standard has a 250 GB storage limit, and Atlassian offers no built-in way to see, site-wide, which files, old versions and trashed items use that space. This app indexes your site, scores its health, lists every attachment with filters, and turns cleanup into reviewed, audited batches.

> Based on the white paper *Confluence Optimizer and Attachment Manager* (Nov 2026). This repository implements the storage-cleanup core of that design; see [Roadmap](#roadmap) for the rest.

## What it does

| Area | What you get |
|---|---|
| **Overview** | Health score (0–100, A–F) with a transparent breakdown, storage used against your limit, months until the limit at the current growth rate, reclaimable storage, charts by file type, space and month, score history. |
| **Attachment dashboard** | Every attachment on the site in one table. Filter by space, type, age, size, name and finding; sort by size, age or versions; links to each file; CSV export. |
| **Findings** | Unused files (not referenced on any page), orphaned files (page trashed or gone), probable duplicates (same name and size), files with many old versions, files on stale pages, large files, trash. |
| **Trash storage report** | Trash size and share of storage, breakdown by space, file type and age, trashed pages with their attachment storage, and reviewed purges. |
| **Review queue** | Nothing changes until a Confluence administrator approves. Actions: move to trash, purge from trash, delete old versions, purge trashed pages. Each item is re-checked just before it is changed; jobs run in the background and can be stopped. |
| **Audit log** | Every request, decision, change, failure, export and settings change, with CSV export. |
| **Space admins** | A *Storage cleanup* page in each space's settings. Space admins see only their space and can request cleanup (admins approve). |
| **Retention rules** | Optional: propose purging trash after N days, keeping only the newest N versions, or trashing unused files. Rules only create *pending* requests. |

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

Then open **Confluence → Settings (gear) → Optimizer & Attachment Manager** and click **Scan now**.

Full instructions, including costs and troubleshooting: [docs/INSTALL.md](docs/INSTALL.md).

## Cost

The app itself is free (Apache 2.0). It runs on Atlassian's Forge platform, which has a monthly free usage allowance per app and charges for usage above it since January 2026. A typical Standard site stays well within the allowance; see [docs/INSTALL.md#cost](docs/INSTALL.md#cost).

## Documentation

- [Install and operate](docs/INSTALL.md)
- [Architecture](docs/ARCHITECTURE.md): scan pipeline, data model, review queue, how findings are computed
- [Security](SECURITY.md): permissions, scopes, reporting vulnerabilities
- [Contributing](CONTRIBUTING.md)

## Limitations (honest list)

- **Old version sizes are estimates.** The REST API does not report the size of earlier versions, so they are estimated as the same size as the current version.
- **Trash age.** The API does not say when an item was trashed. The trash report groups by *time since last change*; retention rules use *the time this app first saw the item in the trash*, which is conservative (nothing is purged early, even on the first scan).
- **Who deleted what** is only known for deletions made through this app (audit log).
- **Duplicates** are matched by file name and size, not by content.
- **Unused** cannot see links from outside Confluence (email, other tools, direct download links).
- **Deleting attachment versions** uses the REST v1 "delete content version" endpoint. Atlassian documents it for content versions; treat it as experimental for attachments and test on a few files first.
- **Restricted content:** the app only sees what the app user can read. Spaces it cannot read are skipped and reported.
- **CSV export** is shown as text to copy (UI Kit cannot trigger file downloads); it is limited to 5,000 rows per export.
- Atlassian's billed storage figure may differ slightly from the indexed total.

## Roadmap

Mapped to the white paper:

| White paper capability | Status |
|---|---|
| Central attachment dashboard, filters, preview links | ✅ |
| Unused and orphaned file detection | ✅ |
| Health score + history | ✅ storage-focused score |
| Bulk actions + review queue | ✅ trash, purge, version pruning, purge trashed pages |
| Audit log | ✅ |
| Trash storage report, purge, retention rules | ✅ (restore is done in Confluence's space trash) |
| Permission-aware / space-owner cleanup | ✅ space admins request, site admins approve |
| Reports + CSV export | ✅ storage by space, type, uploader, month; CSV |
| Bulk download | ⏳ CSV contains download links; ZIP download is not possible inside Forge UI |
| Stale page detection and page archiving | ⏳ stale pages are counted; archiving is planned |
| Duplicate *page* detection (AI-assisted) | ⏳ planned (Forge LLMs) |
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
