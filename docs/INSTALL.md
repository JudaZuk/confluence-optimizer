# Install and operate

## Who pays (read first)

Forge apps run on Atlassian's infrastructure. Since 1 January 2026 their usage is billed per **Developer Space**: the container in the Forge developer console that every app belongs to. The admins of that space are responsible for usage charges. Your Confluence subscription does not cover them.

- Each app has a monthly **free allowance**; most sites using this app are expected to stay inside it (see [Cost](#cost)).
- Charges above the allowance are made only to a payment method added to the Developer Space's billing account. Without one, Atlassian may interrupt the app if the allowance is exceeded.
- `forge register` asks which Developer Space to use (or creates one). **That choice decides who is responsible for any charges.**

### Deploying for a company

Use a Developer Space owned by the company, not a personal one:

1. Someone responsible for the company's Atlassian billing (for example IT) signs in to the developer console at <https://developer.atlassian.com/console/myapps/>, creates a **Developer Space** with the company's name, and decides whether to add a company payment method.
2. They add the people who will deploy the app under **Members**. The **Developer** role can create and deploy apps but has no access to billing.
3. The deployer runs `forge register` in this project and chooses the **company** Developer Space when asked.

If you already registered the app in a personal space, either register it again in the company space (simplest: `forge register` creates a new app; uninstall and delete the old one), or ask Atlassian support to transfer the app between spaces.

## Requirements

- A Confluence Cloud site where you are a **site admin** (Standard, Premium or Enterprise; built with Standard's 250 GB limit in mind).
- Node.js 22 or newer and npm.
- A free Atlassian account to use as a Forge developer account (it can be your normal account).

## 1. Install the Forge CLI and log in

```bash
npm install -g @forge/cli
forge login          # paste an Atlassian API token from id.atlassian.com/manage-profile/security/api-tokens
```

## 2. Get the code and register your copy

> **Before `forge register`:** decide which Developer Space the app belongs to. Its owner is responsible for usage charges. See [Who pays](#who-pays-read-first).

```bash
git clone https://github.com/<you>/confluence-optimizer.git
cd confluence-optimizer
npm install
forge register       # writes your own app id into manifest.yml
```

`forge register` changes `app.id` in `manifest.yml`. If you fork the repository publicly, it is fine to commit your app id; it is not a secret.

## 3. Deploy and install

```bash
forge lint                       # optional: validates manifest and scopes
forge deploy -e production
forge install -e production --product confluence --site <your-site>.atlassian.net
```

During `forge install` you are asked to approve the app's permissions (see [SECURITY.md](../SECURITY.md)).

Use `-e development` instead while trying changes; development installs show a "development" banner and can use `forge tunnel` for live reload.

## 4. First run

1. In Confluence, open **Settings (gear icon) → Confluence Optimizer** (in the left menu of Confluence administration).
2. The first time, the app sets up its database; this takes about a minute.
3. Open **Settings** in the app and check the storage limit (250 GB by default) and thresholds.
4. Click **Scan now**. You can close the page; the scan runs in the background. Rough guide: a few minutes for small sites, an hour or more for sites with hundreds of thousands of pages.
5. Review the **Overview**, then use **Review** next to a finding, select files and submit a request.
6. Approve the request in **Review queue**. Progress and results show in the request, and in the **Audit log**.

Space admins find **Storage cleanup** under **Space settings → Integrations** (location may vary with Confluence navigation updates).

## Recommended cleanup order

1. **Trash** – purge items that have been in the trash for a while. This frees storage immediately.
2. **Old versions** – files edited many times (designs, exports, spreadsheets) often hide most of the storage.
3. **Orphaned files** – files whose page is in the trash or gone.
4. **Large and unused files** – review with space owners, move to trash, purge after a grace period (a retention rule can propose that purge automatically).

## Updating

```bash
git pull
npm install
forge deploy -e production
```

Database migrations run automatically after an upgrade. If Forge reports that the new version needs new permissions, run `forge install --upgrade -e production --site <site>` and accept.

## Sharing with other sites

The person who deploys the app is its owner. To install it on another site without deploying again, use **Distribution** in the Forge developer console to create an installation link. Every site using your deployment counts toward *your* Forge usage (see Cost). Organisations can also each deploy their own copy.

## Cost

The code is free (Apache License 2.0). Forge apps run on Atlassian infrastructure, which has used consumption-based pricing since 1 January 2026, with a monthly free allowance per app. Relevant allowances at the time of writing (check Atlassian's *Forge platform pricing* page for current figures):

| Capability | Free per month | Used by this app for |
|---|---|---|
| Functions (GB-seconds) | 200,000 | scans, cleanup jobs, UI calls |
| Forge SQL storage | 730 GB-hours (≈1 GB stored all month) | the metadata index |
| Forge SQL compute | 1 hour, 100,000 requests | scans write in batches of 100 rows |
| Key-value store | 0.1 GB read, 0.1 GB written | settings and scan state (tiny) |

Approximate needs: the index takes around 1 KB per attachment and per page, so 200,000 attachments need roughly 0.2–0.3 GB. A weekly scan of a site that size makes a few tens of thousands of SQL requests. Most Standard sites stay inside the free allowance; above it, the overage on large sites is typically small. If cost matters, scan monthly (`Automatic scan every … days`) and turn off page content analysis for very large sites.

Forge SQL limits each installation's database to 1 GiB in production, which fits several million rows of metadata.

## Uninstalling

```bash
forge uninstall -e production --site <your-site>.atlassian.net
```

Forge deletes the app's stored data some days after uninstalling. Nothing in Confluence is changed by uninstalling.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "Setting up the app database" does not go away | Run `forge logs -e production` and look for `migrate` errors. Re-deploy to trigger the upgrade migration. |
| Scan failed | The error is shown on the page and in the audit log. Click **Scan now** to retry; the scan restarts. |
| Some spaces skipped | The app cannot read restricted spaces. Give the app access in the space permissions, or accept the gap. |
| A cleanup item failed with HTTP 403 | The app lacks permission for that content (for example page restrictions). |
| Version deletion fails | Confluence may refuse version deletion for some attachments. The item is reported as failed; nothing else is affected. |
| A space admin sees "Space admins only" | The check uses Confluence's own space permissions. Confirm the user has *Admin* on that space. |
