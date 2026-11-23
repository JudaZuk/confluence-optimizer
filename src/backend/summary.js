// Storage summary, findings and health score, site-wide or for one space.

import { randomUUID } from 'node:crypto';
import { query, queryOne, exec } from './db/sql.js';
import { buildAttachmentWhere, STORED_BYTES_SQL, FINDINGS } from './lib/filters.js';
import { computeHealth } from './lib/health.js';
import { daysAgo, monthsAgo, toSqlDate, ageBandSql, ageBandParams, AGE_BANDS } from './lib/time.js';
import { GB } from '../shared/format.js';
import { getState, setState } from './settings.js';

const num = (v) => Number(v) || 0;
const FROM = 'FROM attachments a LEFT JOIN contents c ON c.id = a.container_id';

export async function exemptSpaceIds(settings) {
  const keys = settings.exemptSpaceKeys || [];
  if (!keys.length) return [];
  const rows = await query(
    `SELECT id FROM spaces WHERE space_key IN (${keys.map(() => '?').join(', ')})`,
    keys,
  );
  return rows.map((r) => String(r.id));
}

/** Count and bytes for one finding. */
async function findingTotals(finding, spaceId, settings, exempt, now) {
  const { where, params } = buildAttachmentWhere({ finding }, { spaceId, rules: settings, exemptSpaceIds: exempt, now });
  let bytesExpr = `SUM(${STORED_BYTES_SQL})`;
  if (finding === 'versions') {
    bytesExpr = 'SUM(a.file_size * (a.version_number - ?))';
    params.unshift(settings.keepVersions);
  }
  const row = await queryOne(`SELECT COUNT(*) AS n, ${bytesExpr} AS bytes ${FROM} WHERE ${where}`, params);
  return { count: num(row?.n), bytes: num(row?.bytes) };
}

/**
 * @param {object} settings
 * @param {string} [spaceId]  limit everything to one space
 */
export async function computeSummary(settings, spaceId = null) {
  const now = new Date();
  const exempt = await exemptSpaceIds(settings);
  const spaceWhere = spaceId ? 'a.space_id = ?' : '1 = 1';
  const sp = spaceId ? [String(spaceId)] : [];

  const totals = await queryOne(
    `SELECT COUNT(*) AS n, SUM(a.file_size) AS current_bytes, SUM(${STORED_BYTES_SQL}) AS stored_bytes,
            SUM(a.file_size * (GREATEST(a.version_number, 1) - 1)) AS old_version_bytes
     FROM attachments a WHERE ${spaceWhere}`,
    sp,
  );
  const trash = await queryOne(
    `SELECT COUNT(*) AS n, SUM(${STORED_BYTES_SQL}) AS bytes ${FROM}
     WHERE ${spaceWhere} AND (a.status = 'trashed' OR c.status = 'trashed')`,
    sp,
  );
  const trashedPages = await queryOne(
    `SELECT COUNT(*) AS n FROM contents c WHERE c.status = 'trashed'${spaceId ? ' AND c.space_id = ?' : ''}`,
    sp,
  );
  const pages = await queryOne(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN c.modified_at < ? THEN 1 ELSE 0 END) AS stale
     FROM contents c WHERE c.kind = 'page' AND c.status IN ('current', 'archived')${spaceId ? ' AND c.space_id = ?' : ''}`,
    [monthsAgo(settings.staleMonths, now), ...sp],
  );
  const growth = await queryOne(
    `SELECT SUM(a.file_size) AS bytes FROM attachments a WHERE ${spaceWhere} AND a.modified_at >= ?`,
    [...sp, daysAgo(30, now)],
  );

  const findings = {};
  for (const key of Object.keys(FINDINGS)) {
    if (key === 'all') continue;
    findings[key] = await findingTotals(key, spaceId, settings, exempt, now);
  }
  // Duplicates: only the extra copies can be reclaimed.
  const dupExtra = await queryOne(
    `SELECT SUM((t.n - 1) * t.size) AS bytes FROM (
       SELECT a.dup_key, COUNT(*) AS n, MAX(a.file_size) AS size FROM attachments a
       WHERE ${spaceWhere} AND a.status IN ('current', 'archived') GROUP BY a.dup_key HAVING COUNT(*) > 1
     ) t`,
    sp,
  );
  findings.duplicates.reclaimableBytes = num(dupExtra?.bytes);

  const byType = await query(
    `SELECT a.type_category AS category, COUNT(*) AS n, SUM(${STORED_BYTES_SQL}) AS bytes
     FROM attachments a WHERE ${spaceWhere} GROUP BY a.type_category ORDER BY bytes DESC`,
    sp,
  );
  const byUploader = await query(
    `SELECT a.modified_by AS account_id, COUNT(*) AS n, SUM(${STORED_BYTES_SQL}) AS bytes
     FROM attachments a WHERE ${spaceWhere} AND a.modified_by IS NOT NULL
     GROUP BY a.modified_by ORDER BY bytes DESC LIMIT 10`,
    sp,
  );
  const byMonth = await query(
    `SELECT DATE_FORMAT(a.created_at, '%Y-%m') AS month, COUNT(*) AS n, SUM(a.file_size) AS bytes
     FROM attachments a WHERE ${spaceWhere} AND a.created_at >= ?
     GROUP BY DATE_FORMAT(a.created_at, '%Y-%m') ORDER BY month`,
    [...sp, monthsAgo(12, now)],
  );
  const bySpace = spaceId
    ? []
    : await query(
        `SELECT a.space_id, s.space_key, s.name, COUNT(*) AS n, SUM(${STORED_BYTES_SQL}) AS bytes
         FROM attachments a LEFT JOIN spaces s ON s.id = a.space_id
         GROUP BY a.space_id, s.space_key, s.name ORDER BY bytes DESC LIMIT 15`,
      );

  const totalBytes = num(totals?.stored_bytes);
  const trashBytes = num(trash?.bytes);
  const reclaimableBytes = Math.min(totalBytes, await reclaimableTotal(settings, spaceId, exempt, now));
  const quotaBytes = settings.storageQuotaGb * GB;
  const health = computeHealth({
    totalBytes,
    quotaBytes,
    reclaimableBytes,
    trashBytes,
    pageCount: num(pages?.n),
    stalePageCount: num(pages?.stale),
    growthBytes30d: num(growth?.bytes),
  });

  return {
    computedAt: new Date().toISOString(),
    spaceId,
    quotaBytes,
    totals: {
      attachments: num(totals?.n),
      currentBytes: num(totals?.current_bytes),
      storedBytes: totalBytes,
      oldVersionBytes: num(totals?.old_version_bytes),
      trashBytes,
      trashCount: num(trash?.n),
      trashedPages: num(trashedPages?.n),
      pages: num(pages?.n),
      stalePages: num(pages?.stale),
      growthBytes30d: num(growth?.bytes),
      reclaimableBytes,
    },
    findings,
    health,
    byType: byType.map((r) => ({ category: r.category || 'other', count: num(r.n), bytes: num(r.bytes) })),
    byUploader: byUploader.map((r) => ({ accountId: r.account_id, count: num(r.n), bytes: num(r.bytes) })),
    byMonth: byMonth.map((r) => ({ month: r.month, count: num(r.n), bytes: num(r.bytes) })),
    bySpace: bySpace.map((r) => ({
      spaceId: r.space_id, key: r.space_key || '(unknown)', name: r.name || '', count: num(r.n), bytes: num(r.bytes),
    })),
  };
}

/**
 * Storage that cleanup could free, counting every file once. Each file is put
 * in the first bucket that applies, so overlapping findings are not added twice:
 *   1. in the trash (or on a page in the trash)  -> all its storage
 *   2. unused                                     -> all its storage
 *   3. an extra copy of a probable duplicate      -> all its storage
 *   4. more versions than you keep               -> the old versions only
 */
async function reclaimableTotal(settings, spaceId, exempt, now) {
  const keep = Number(settings.keepVersions) || 1;
  const sp = spaceId ? [String(spaceId)] : [];
  const exemptSql = exempt.length ? ` AND (a.space_id IS NULL OR a.space_id NOT IN (${exempt.map(() => '?').join(', ')}))` : '';
  const row = await queryOne(
    `SELECT SUM(CASE
         WHEN a.status = 'trashed' OR c.status = 'trashed' THEN ${STORED_BYTES_SQL}
         WHEN a.is_referenced = 0 AND c.status IN ('current', 'archived') AND a.modified_at < ? THEN ${STORED_BYTES_SQL}
         WHEN d.keep_id IS NOT NULL THEN ${STORED_BYTES_SQL}
         WHEN a.version_number > ? THEN a.file_size * (a.version_number - ?)
         ELSE 0 END) AS bytes
     FROM attachments a
       LEFT JOIN contents c ON c.id = a.container_id
       LEFT JOIN (
         SELECT x.dup_key, MIN(x.id) AS keep_id FROM attachments x
         WHERE x.status IN ('current', 'archived')${spaceId ? ' AND x.space_id = ?' : ''}
         GROUP BY x.dup_key HAVING COUNT(*) > 1
       ) d ON d.dup_key = a.dup_key AND a.id <> d.keep_id AND a.status IN ('current', 'archived')
     WHERE ${spaceId ? 'a.space_id = ?' : '1 = 1'}${exemptSql}`,
    [daysAgo(settings.unusedMinAgeDays, now), keep, keep, ...sp, ...sp, ...exempt],
  );
  return num(row?.bytes);
}

/** Trash breakdown for the trash storage report. */
export async function computeTrashReport(spaceId = null) {
  const now = new Date();
  const spaceWhere = spaceId ? 'a.space_id = ?' : '1 = 1';
  const sp = spaceId ? [String(spaceId)] : [];
  const trashed = "(a.status = 'trashed' OR c.status = 'trashed')";

  const bySpace = spaceId
    ? []
    : await query(
        `SELECT a.space_id, s.space_key, s.name, COUNT(*) AS n, SUM(${STORED_BYTES_SQL}) AS bytes
         ${FROM} LEFT JOIN spaces s ON s.id = a.space_id
         WHERE ${trashed} GROUP BY a.space_id, s.space_key, s.name ORDER BY bytes DESC LIMIT 25`,
      );
  const byType = await query(
    `SELECT a.type_category AS category, COUNT(*) AS n, SUM(${STORED_BYTES_SQL}) AS bytes
     ${FROM} WHERE ${spaceWhere} AND ${trashed} GROUP BY a.type_category ORDER BY bytes DESC`,
    sp,
  );
  // Age is measured from the last change, the best signal the REST API offers.
  const byAge = await query(
    `SELECT t.band, COUNT(*) AS n, SUM(t.bytes) AS bytes FROM (
       SELECT ${ageBandSql('a.modified_at')} AS band, ${STORED_BYTES_SQL} AS bytes
       ${FROM} WHERE ${spaceWhere} AND ${trashed}
     ) t GROUP BY t.band`,
    [...ageBandParams(now), ...sp],
  );
  const pages = await query(
    `SELECT c.id, c.kind, c.title, c.space_id, s.space_key, c.modified_at, c.trashed_seen_at,
            COUNT(x.id) AS att_count, COALESCE(SUM(x.file_size * GREATEST(x.version_number, 1)), 0) AS att_bytes
     FROM contents c
       LEFT JOIN spaces s ON s.id = c.space_id
       LEFT JOIN attachments x ON x.container_id = c.id
     WHERE c.status = 'trashed'${spaceId ? ' AND c.space_id = ?' : ''}
     GROUP BY c.id, c.kind, c.title, c.space_id, s.space_key, c.modified_at, c.trashed_seen_at
     ORDER BY att_bytes DESC LIMIT 200`,
    sp,
  );
  const ageMap = new Map(byAge.map((r) => [r.band, r]));
  return {
    bySpace: bySpace.map((r) => ({ spaceId: r.space_id, key: r.space_key || '(unknown)', name: r.name || '', count: num(r.n), bytes: num(r.bytes) })),
    byType: byType.map((r) => ({ category: r.category || 'other', count: num(r.n), bytes: num(r.bytes) })),
    byAge: AGE_BANDS.map((b) => ({ key: b.key, label: b.label, count: num(ageMap.get(b.key)?.n), bytes: num(ageMap.get(b.key)?.bytes) })),
    pages: pages.map((p) => ({
      id: String(p.id), kind: p.kind, title: p.title, spaceId: p.space_id, spaceKey: p.space_key,
      modifiedAt: p.modified_at, trashedSeenAt: p.trashed_seen_at, attachments: num(p.att_count), bytes: num(p.att_bytes),
    })),
  };
}

/** Computes the site summary, stores it for the dashboard and records a history point. */
export async function takeSnapshot(settings) {
  const summary = await computeSummary(settings);
  await setState('summary', summary);
  await setState('summary:stale', false);
  // One history point per day is enough for the trend.
  await exec('DELETE FROM health_snapshots WHERE taken_at >= ?', [toSqlDate(new Date().toISOString().slice(0, 10))]);
  await exec(
    `INSERT INTO health_snapshots (id, taken_at, score, total_bytes, reclaimable_bytes, trash_bytes, attachment_count, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(), toSqlDate(new Date()), summary.health.score, summary.totals.storedBytes,
      summary.totals.reclaimableBytes, summary.totals.trashBytes, summary.totals.attachments,
      JSON.stringify({ findings: summary.findings, totals: summary.totals }),
    ],
  );
  return summary;
}

export async function getCachedSummary() {
  return getState('summary');
}

export async function getHistory(months = 12) {
  const rows = await query(
    `SELECT taken_at, score, total_bytes, reclaimable_bytes, trash_bytes, attachment_count
     FROM health_snapshots WHERE taken_at >= ? ORDER BY taken_at`,
    [monthsAgo(months)],
  );
  return rows.map((r) => ({
    takenAt: r.taken_at, score: num(r.score), totalBytes: num(r.total_bytes),
    reclaimableBytes: num(r.reclaimable_bytes), trashBytes: num(r.trash_bytes), attachments: num(r.attachment_count),
  }));
}
