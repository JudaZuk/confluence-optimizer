// Retention rules. They run after each scan and only ever create *pending*
// review requests: an administrator still has to approve every change.

import { query, queryOne } from './db/sql.js';
import { daysAgo } from './lib/time.js';
import { createRequest, RequestError, MAX_ITEMS_PER_REQUEST } from './requests.js';
import { exemptSpaceIds } from './summary.js';

async function hasOpenRequest(source) {
  const row = await queryOne(
    "SELECT COUNT(*) AS n FROM requests WHERE source = ? AND status IN ('pending', 'approved', 'running')",
    [source],
  );
  return Number(row?.n) > 0;
}

async function propose(source, input) {
  if (await hasOpenRequest(source)) return null; // do not pile up identical proposals
  try {
    return await createRequest({ ...input, actor: source, scope: 'site', source });
  } catch (err) {
    if (err instanceof RequestError) return null; // nothing matched
    throw err;
  }
}

function exemptClause(column, exempt) {
  if (!exempt.length) return { sql: '', params: [] };
  return { sql: ` AND (${column} IS NULL OR ${column} NOT IN (${exempt.map(() => '?').join(', ')}))`, params: exempt };
}

export async function applyRetentionRules(settings) {
  const r = settings.retention || {};
  const exempt = await exemptSpaceIds(settings);
  const created = [];

  if (r.purgeTrashAfterDays > 0) {
    // Uses the time the app first saw the item in the trash, so items are never
    // purged earlier than the configured grace period.
    const cutoff = daysAgo(r.purgeTrashAfterDays);
    const ex = exemptClause('space_id', exempt);
    const atts = await query(
      `SELECT id FROM attachments WHERE status = 'trashed' AND trashed_seen_at < ?${ex.sql} LIMIT ${MAX_ITEMS_PER_REQUEST}`,
      [cutoff, ...ex.params],
    );
    if (atts.length) {
      created.push(await propose('rule:purge-trash-attachments', {
        action: 'purge_attachment', selection: { ids: atts.map((a) => a.id) }, settings,
        note: `Retention rule: attachments in the trash for more than ${r.purgeTrashAfterDays} days.`,
      }));
    }
    const pages = await query(
      `SELECT id FROM contents WHERE status = 'trashed' AND trashed_seen_at < ?${ex.sql} LIMIT ${MAX_ITEMS_PER_REQUEST}`,
      [cutoff, ...ex.params],
    );
    if (pages.length) {
      created.push(await propose('rule:purge-trash-pages', {
        action: 'purge_page', selection: { ids: pages.map((p) => p.id) }, settings,
        note: `Retention rule: pages in the trash for more than ${r.purgeTrashAfterDays} days.`,
      }));
    }
  }

  if (r.pruneVersionsKeep > 0) {
    created.push(await propose('rule:prune-versions', {
      action: 'prune_versions', selection: { filters: { finding: 'versions' } }, params: { keep: r.pruneVersionsKeep },
      settings: { ...settings, keepVersions: r.pruneVersionsKeep },
      note: `Retention rule: keep only the newest ${r.pruneVersionsKeep} versions of each file.`,
    }));
  }

  if (r.trashUnusedAfterDays > 0) {
    created.push(await propose('rule:trash-unused', {
      action: 'trash_attachment', selection: { filters: { finding: 'unused' } },
      settings: { ...settings, unusedMinAgeDays: r.trashUnusedAfterDays },
      note: `Retention rule: attachments not referenced on any page and unchanged for ${r.trashUnusedAfterDays} days.`,
    }));
  }
  return created.filter(Boolean);
}
