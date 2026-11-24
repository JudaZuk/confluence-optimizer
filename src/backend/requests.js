// Review queue: cleanup requests, approval decisions and listing.
//
// Nothing in this app changes Confluence content unless a request has been
// approved by a Confluence administrator.

import { randomUUID } from 'node:crypto';
import { exec, query, queryOne, upsertMany, placeholders } from './db/sql.js';
import { buildAttachmentWhere, STORED_BYTES_SQL } from './lib/filters.js';
import { toSqlDate } from './lib/time.js';
import { ACTION_LABELS } from '../shared/format.js';
import { audit, AUDIT_EVENTS } from './audit.js';
import { execQueue } from './queues.js';
import { exemptSpaceIds } from './summary.js';
import { setState } from './settings.js';

export const MAX_ITEMS_PER_REQUEST = 5000;
export const ACTIONS = Object.keys(ACTION_LABELS);

const nowSql = () => toSqlDate(new Date());

export class RequestError extends Error {}

/**
 * Resolves the attachments or pages a request will act on. Items are always
 * re-read from the index, filtered by scope and by the status the action needs,
 * so the UI cannot smuggle in items outside the user's space.
 */
async function resolveItems({ action, selection, spaceId, settings, keep }) {
  const ids = Array.isArray(selection?.ids) ? selection.ids.map(String).slice(0, MAX_ITEMS_PER_REQUEST) : null;

  if (action === 'purge_page') {
    if (!ids?.length) throw new RequestError('Select the pages to purge.');
    const rows = await query(
      `SELECT c.id, c.kind, c.title, c.space_id, c.version_number,
              COALESCE(SUM(x.file_size * GREATEST(x.version_number, 1)), 0) AS bytes
       FROM contents c LEFT JOIN attachments x ON x.container_id = c.id
       WHERE c.status = 'trashed' AND c.id IN (${placeholders(ids.length)})${spaceId ? ' AND c.space_id = ?' : ''}
       GROUP BY c.id, c.kind, c.title, c.space_id, c.version_number`,
      [...ids, ...(spaceId ? [String(spaceId)] : [])],
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, spaceId: r.space_id, bytes: Number(r.bytes) || 0, version: r.version_number }));
  }

  const statusClause = {
    trash_attachment: "a.status IN ('current', 'archived')",
    purge_attachment: "a.status = 'trashed'",
    prune_versions: "a.status IN ('current', 'archived') AND a.version_number > ?",
  }[action];
  const statusParams = action === 'prune_versions' ? [keep] : [];
  const bytesExpr = action === 'prune_versions' ? 'a.file_size * (a.version_number - ?)' : STORED_BYTES_SQL;
  const bytesParams = action === 'prune_versions' ? [keep] : [];

  let where;
  let params;
  if (ids) {
    if (!ids.length) throw new RequestError('Nothing selected.');
    where = `a.id IN (${placeholders(ids.length)})${spaceId ? ' AND a.space_id = ?' : ''}`;
    params = [...ids, ...(spaceId ? [String(spaceId)] : [])];
  } else if (selection?.filters) {
    const exempt = await exemptSpaceIds(settings);
    ({ where, params } = buildAttachmentWhere(selection.filters, { spaceId, rules: settings, exemptSpaceIds: exempt }));
  } else {
    throw new RequestError('Nothing selected.');
  }

  const rows = await query(
    `SELECT a.id, a.title, a.space_id, a.version_number, ${bytesExpr} AS bytes
     FROM attachments a
     WHERE ${where} AND ${statusClause}
     ORDER BY a.file_size DESC LIMIT ${MAX_ITEMS_PER_REQUEST}`,
    [...bytesParams, ...params, ...statusParams],
  );
  return rows.map((r) => ({ id: r.id, kind: 'attachment', title: r.title, spaceId: r.space_id, bytes: Number(r.bytes) || 0, version: r.version_number }));
}

/**
 * @param {object} input
 * @param {string} input.actor        accountId or 'rule:<name>'
 * @param {'site'|'space'} input.scope
 * @param {string} [input.spaceId]    required for space scope
 * @param {string} input.action
 * @param {object} input.selection    { ids: [...] } or { filters: {...} }
 * @param {object} [input.params]     { keep } for prune_versions
 */
export async function createRequest({ actor, scope, spaceId, action, selection, note, params = {}, settings, source = 'manual' }) {
  if (!ACTIONS.includes(action)) throw new RequestError('Unknown action.');
  const keep = Math.max(1, parseInt(params.keep ?? settings.keepVersions, 10) || settings.keepVersions);
  const items = await resolveItems({ action, selection, spaceId: scope === 'space' ? spaceId : null, settings, keep });
  if (!items.length) throw new RequestError('None of the selected items can be used for this action (already handled, or outside your scope).');

  const id = randomUUID();
  const totalBytes = items.reduce((s, i) => s + i.bytes, 0);
  const title = `${ACTION_LABELS[action]}: ${items.length} item${items.length === 1 ? '' : 's'}`;
  await exec(
    `INSERT INTO requests (id, created_at, requested_by, scope, space_id, action, params, title, note, source, status, item_count, total_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [id, nowSql(), actor, scope, scope === 'space' ? String(spaceId) : null, action,
      JSON.stringify(action === 'prune_versions' ? { keep } : {}), title, note ? String(note).slice(0, 4000) : null,
      source, items.length, totalBytes],
  );
  await upsertMany(
    'request_items',
    ['request_id', 'item_id', 'item_kind', 'title', 'space_id', 'bytes', 'expected_version', 'status'],
    items.map((i) => [id, String(i.id), i.kind, (i.title || '').slice(0, 512), i.spaceId ? String(i.spaceId) : null, i.bytes, i.version ?? null, 'pending']),
    ['status'],
  );
  await audit({ actor, event: AUDIT_EVENTS.REQUEST_CREATED, requestId: id, spaceId, bytes: totalBytes, details: { action, items: items.length, note, source } });
  return { id, title, itemCount: items.length, totalBytes };
}

export async function decideRequest({ actor, id, approve, note }) {
  const req = await queryOne('SELECT * FROM requests WHERE id = ?', [id]);
  if (!req) throw new RequestError('Request not found.');
  if (req.status !== 'pending') throw new RequestError(`Request is already ${req.status}.`);
  const status = approve ? 'approved' : 'rejected';
  const changed = await exec(
    "UPDATE requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'",
    [status, actor, nowSql(), note ? String(note).slice(0, 4000) : null, id],
  );
  if (!changed) throw new RequestError('Request was changed by someone else. Reload and try again.');
  await audit({
    actor, event: approve ? AUDIT_EVENTS.REQUEST_APPROVED : AUDIT_EVENTS.REQUEST_REJECTED,
    requestId: id, spaceId: req.space_id, bytes: Number(req.total_bytes), details: { note, action: req.action },
  });
  if (approve) await execQueue.push({ body: { requestId: id } });
  return { id, status };
}

export async function cancelRequest({ actor, id, spaceId, isAdmin }) {
  const req = await queryOne('SELECT * FROM requests WHERE id = ?', [id]);
  if (!req) throw new RequestError('Request not found.');
  if (!isAdmin && (req.requested_by !== actor || String(req.space_id) !== String(spaceId))) {
    throw new RequestError('You can only cancel your own requests.');
  }
  const changed = await exec("UPDATE requests SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", [actor, nowSql(), id]);
  if (!changed) throw new RequestError('Only pending requests can be cancelled.');
  await audit({ actor, event: AUDIT_EVENTS.REQUEST_CANCELLED, requestId: id, spaceId: req.space_id });
  return { id, status: 'cancelled' };
}

/** Stops an approved or running request. Items not yet processed stay untouched. */
export async function stopRequest({ actor, id }) {
  const changed = await exec(
    "UPDATE requests SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('approved', 'running')",
    [nowSql(), id],
  );
  if (!changed) throw new RequestError('Only approved or running requests can be stopped.');
  await audit({ actor, event: AUDIT_EVENTS.REQUEST_CANCELLED, requestId: id, details: { stopped: true } });
  await markSummaryStale();
  return { id, status: 'cancelled' };
}

const mapRequest = (r) => ({
  id: r.id, createdAt: r.created_at, requestedBy: r.requested_by, scope: r.scope, spaceId: r.space_id,
  spaceKey: r.space_key || null, action: r.action, params: safeJson(r.params), title: r.title, note: r.note,
  source: r.source, status: r.status, itemCount: Number(r.item_count), totalBytes: Number(r.total_bytes),
  decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, startedAt: r.started_at,
  finishedAt: r.finished_at, done: Number(r.done_count), failed: Number(r.failed_count),
  skipped: Number(r.skipped_count), freedBytes: Number(r.freed_bytes),
});

function safeJson(s) {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

export async function listRequests({ status, spaceId, page = 0, pageSize = 25 }) {
  const clauses = [];
  const params = [];
  if (status && status !== 'all') {
    if (status === 'open') clauses.push("r.status IN ('pending', 'approved', 'running')");
    else {
      clauses.push('r.status = ?');
      params.push(String(status));
    }
  }
  if (spaceId) {
    clauses.push('r.space_id = ?');
    params.push(String(spaceId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(page, 10) || 0, 0) * size;
  const rows = await query(
    `SELECT r.*, s.space_key FROM requests r LEFT JOIN spaces s ON s.id = r.space_id ${where}
     ORDER BY r.created_at DESC LIMIT ${size} OFFSET ${offset}`,
    params,
  );
  const total = await queryOne(`SELECT COUNT(*) AS n FROM requests r ${where}`, params);
  return { rows: rows.map(mapRequest), total: Number(total?.n) || 0 };
}

export async function getRequest({ id, spaceId }) {
  const r = await queryOne('SELECT r.*, s.space_key FROM requests r LEFT JOIN spaces s ON s.id = r.space_id WHERE r.id = ?', [id]);
  if (!r) throw new RequestError('Request not found.');
  if (spaceId && String(r.space_id) !== String(spaceId)) throw new RequestError('Request not found.');
  const items = await query(
    `SELECT i.item_id, i.item_kind, i.title, i.space_id, s.space_key, i.bytes, i.status, i.message
     FROM request_items i LEFT JOIN spaces s ON s.id = i.space_id
     WHERE i.request_id = ? ORDER BY i.bytes DESC LIMIT 250`,
    [id],
  );
  return {
    ...mapRequest(r),
    items: items.map((i) => ({
      id: i.item_id, kind: i.item_kind, title: i.title, spaceKey: i.space_key, bytes: Number(i.bytes), status: i.status, message: i.message,
    })),
  };
}

export async function markSummaryStale() {
  await setState('summary:stale', true);
}
