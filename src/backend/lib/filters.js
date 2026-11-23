// Builds parameterised SQL for the attachment explorer and the cleanup findings.
// Every value is bound as a parameter. Column names and sort orders come from
// whitelists only, never from user input.

import { TYPE_CATEGORIES } from './files.js';
import { daysAgo, monthsAgo } from './time.js';

export const LIVE_STATUSES = ['current', 'archived'];

export const FINDINGS = {
  all: { label: 'All attachments' },
  unused: { label: 'Unused (not referenced on any page)' },
  orphaned: { label: 'Orphaned (page deleted or missing)' },
  duplicates: { label: 'Probable duplicates (same name and size)' },
  versions: { label: 'Many old versions' },
  stale: { label: 'On stale pages' },
  large: { label: 'Large files' },
  trash: { label: 'In trash' },
};

export const SORTS = {
  size_desc: 'stored_bytes DESC, a.id',
  size_asc: 'stored_bytes ASC, a.id',
  modified_asc: 'a.modified_at ASC, a.id',
  modified_desc: 'a.modified_at DESC, a.id',
  title_asc: 'a.title ASC, a.id',
  versions_desc: 'a.version_number DESC, a.id',
};

/** Storage an attachment takes, including (estimated) earlier versions. */
export const STORED_BYTES_SQL = 'a.file_size * GREATEST(a.version_number, 1)';

export const DEFAULT_RULES = {
  staleMonths: 24,
  unusedMinAgeDays: 30,
  keepVersions: 3,
  largeFileMb: 50,
};

const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ');

/**
 * @param {object} filters   user filters from the UI
 * @param {object} options   { spaceId (forced scope), rules, exemptSpaceIds, now }
 * @returns {{ where: string, params: any[] }}  conditions for `attachments a LEFT JOIN contents c`
 */
export function buildAttachmentWhere(filters = {}, options = {}) {
  const rules = { ...DEFAULT_RULES, ...(options.rules || {}) };
  const now = options.now || new Date();
  const clauses = [];
  const params = [];
  const add = (sql, ...values) => {
    clauses.push(sql);
    params.push(...values);
  };

  // Scope: a space page can never look outside its own space.
  const spaceId = options.spaceId || filters.spaceId;
  if (spaceId) add('a.space_id = ?', String(spaceId));

  const finding = FINDINGS[filters.finding] ? filters.finding : 'all';

  // Status filter (ignored by findings that imply a status).
  if (finding === 'all') {
    if (filters.status === 'trashed') add("(a.status = 'trashed' OR c.status = 'trashed')");
    else if (filters.status !== 'any') add(`a.status IN (${placeholders(LIVE_STATUSES.length)})`, ...LIVE_STATUSES);
  }

  switch (finding) {
    case 'unused':
      add(`a.status IN (${placeholders(LIVE_STATUSES.length)})`, ...LIVE_STATUSES);
      add("c.status IN ('current', 'archived')");
      add('a.is_referenced = 0');
      add('a.modified_at < ?', daysAgo(rules.unusedMinAgeDays, now));
      break;
    case 'orphaned':
      add("a.status <> 'trashed'");
      add('a.orphan_reason IS NOT NULL');
      break;
    case 'duplicates':
      add(`a.status IN (${placeholders(LIVE_STATUSES.length)})`, ...LIVE_STATUSES);
      add(
        "a.dup_key IN (SELECT d.dup_key FROM attachments d WHERE d.status IN ('current', 'archived') " +
          'GROUP BY d.dup_key HAVING COUNT(*) > 1)',
      );
      break;
    case 'versions':
      add(`a.status IN (${placeholders(LIVE_STATUSES.length)})`, ...LIVE_STATUSES);
      add('a.version_number > ?', Number(rules.keepVersions) || 1);
      break;
    case 'stale':
      add(`a.status IN (${placeholders(LIVE_STATUSES.length)})`, ...LIVE_STATUSES);
      add('c.modified_at < ?', monthsAgo(rules.staleMonths, now));
      break;
    case 'large':
      add("a.status <> 'trashed'");
      add('a.file_size >= ?', Math.round(Number(rules.largeFileMb) * 1024 * 1024));
      break;
    case 'trash':
      add("(a.status = 'trashed' OR c.status = 'trashed')");
      break;
    default:
      break;
  }

  // Exempt spaces never show up in cleanup findings (they still count in reports).
  const exempt = (options.exemptSpaceIds || []).map(String).filter(Boolean);
  if (finding !== 'all' && exempt.length) {
    add(`(a.space_id IS NULL OR a.space_id NOT IN (${placeholders(exempt.length)}))`, ...exempt);
  }

  if (filters.q && String(filters.q).trim()) {
    const q = String(filters.q).trim().slice(0, 200).replace(/[\\%_]/g, (ch) => `\\${ch}`);
    add('a.title LIKE ?', `%${q}%`);
  }
  if (filters.category && TYPE_CATEGORIES[filters.category]) add('a.type_category = ?', filters.category);
  else if (filters.category === 'other') add("a.type_category = 'other'");
  if (Number(filters.minSizeMb) > 0) add('a.file_size >= ?', Math.round(Number(filters.minSizeMb) * 1024 * 1024));
  if (Number(filters.olderThanDays) > 0) add('a.modified_at < ?', daysAgo(Number(filters.olderThanDays), now));
  if (filters.modifiedBy) add('a.modified_by = ?', String(filters.modifiedBy));

  return { where: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
}

export function sortClause(sort) {
  return SORTS[sort] || SORTS.size_desc;
}

/** Clamp paging input coming from the UI. */
export function paging(page, pageSize, maxPageSize = 100) {
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), maxPageSize);
  const p = Math.max(parseInt(page, 10) || 0, 0);
  return { limit: size, offset: p * size };
}
