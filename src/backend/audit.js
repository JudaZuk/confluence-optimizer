// Append-only audit log. Every request, decision, execution result, export and
// settings change is written here.

import { randomUUID } from 'node:crypto';
import { exec } from './db/sql.js';

const now3 = () => new Date().toISOString().replace('T', ' ').replace('Z', '');

export const AUDIT_EVENTS = {
  REQUEST_CREATED: 'request.created',
  REQUEST_APPROVED: 'request.approved',
  REQUEST_REJECTED: 'request.rejected',
  REQUEST_CANCELLED: 'request.cancelled',
  REQUEST_FINISHED: 'request.finished',
  ITEM_TRASHED: 'attachment.trashed',
  ITEM_PURGED: 'attachment.purged',
  VERSIONS_DELETED: 'attachment.versions_deleted',
  PAGE_PURGED: 'page.purged',
  ITEM_FAILED: 'item.failed',
  SCAN_STARTED: 'scan.started',
  SCAN_FINISHED: 'scan.finished',
  SCAN_FAILED: 'scan.failed',
  EXPORT: 'report.exported',
  SETTINGS_CHANGED: 'settings.changed',
};

/**
 * @param {object} e
 * @param {string} e.actor   accountId, or 'app' / 'rule:<name>' for automation
 * @param {string} e.event   one of AUDIT_EVENTS
 */
export async function audit(e) {
  await exec(
    `INSERT INTO audit_log (id, at, actor, event, request_id, object_id, object_title, space_id, bytes, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      now3(),
      String(e.actor || 'app').slice(0, 128),
      e.event,
      e.requestId || null,
      e.objectId ? String(e.objectId) : null,
      e.objectTitle ? String(e.objectTitle).slice(0, 512) : null,
      e.spaceId ? String(e.spaceId) : null,
      Number.isFinite(e.bytes) ? e.bytes : null,
      e.details ? JSON.stringify(e.details).slice(0, 60000) : null,
    ],
  );
}

/** Never let an audit failure hide the real error, but do surface it in logs. */
export async function auditSafe(e) {
  try {
    await audit(e);
  } catch (err) {
    console.error('audit write failed', e.event, err?.message);
  }
}
