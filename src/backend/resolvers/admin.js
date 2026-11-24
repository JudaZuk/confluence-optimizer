// Resolver for the site-wide console (confluence:globalSettings).
// Every call is checked: the caller must be a Confluence administrator.

import Resolver from '@forge/resolver';
import { query, queryOne } from '../db/sql.js';
import { toCsv } from '../lib/csv.js';
import { requireSiteAdmin } from '../auth.js';
import { getSettings, saveSettings } from '../settings.js';
import { startScan, cancelScan, getScanState } from '../scan.js';
import { getHistory, requestSummary } from '../summary.js';
import { decideRequest, stopRequest } from '../requests.js';
import { audit, AUDIT_EVENTS } from '../audit.js';
import { commonHandlers, safe, schemaReady, EXPORT_LIMIT } from './common.js';

const resolver = new Resolver();

async function adminScope(context) {
  await requireSiteAdmin(context);
  return { isAdmin: true, spaceId: null, accountId: context.accountId };
}

const handlers = {
  ...commonHandlers(adminScope),

  getSummary: async ({ payload, context }) => {
    await adminScope(context);
    if (!(await schemaReady())) return { notReady: true };
    if ((await getScanState()).status === 'never') return { notReady: true };
    const { summary, refreshing } = await requestSummary(null, Boolean(payload?.refresh));
    return summary ? { ...summary, refreshing } : { pending: true };
  },

  getHistory: async ({ context }) => {
    await adminScope(context);
    return getHistory(12);
  },

  listSpaces: async ({ context }) => {
    await adminScope(context);
    const rows = await query('SELECT id, space_key, name FROM spaces ORDER BY space_key LIMIT 10000');
    return rows.map((r) => ({ id: String(r.id), key: r.space_key, name: r.name }));
  },

  startScan: async ({ context }) => {
    await adminScope(context);
    return startScan(context.accountId);
  },

  cancelScan: async ({ context }) => {
    await adminScope(context);
    return cancelScan(context.accountId);
  },

  decideRequest: async ({ payload, context }) => {
    await adminScope(context);
    return decideRequest({ actor: context.accountId, id: payload?.id, approve: Boolean(payload?.approve), note: payload?.note });
  },

  stopRequest: async ({ payload, context }) => {
    await adminScope(context);
    return stopRequest({ actor: context.accountId, id: payload?.id });
  },

  listAudit: async ({ payload, context }) => {
    await adminScope(context);
    const { where, params } = auditWhere(payload);
    const size = Math.min(Math.max(parseInt(payload?.pageSize, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(payload?.page, 10) || 0, 0) * size;
    const rows = await query(
      `SELECT l.*, s.space_key FROM audit_log l LEFT JOIN spaces s ON s.id = l.space_id ${where}
       ORDER BY l.at DESC LIMIT ${size} OFFSET ${offset}`,
      params,
    );
    const total = await queryOne(`SELECT COUNT(*) AS n FROM audit_log l ${where}`, params);
    return { rows: rows.map(mapAudit), total: Number(total?.n) || 0 };
  },

  exportAudit: async ({ payload, context }) => {
    await adminScope(context);
    const { where, params } = auditWhere(payload);
    const rows = await query(
      `SELECT l.*, s.space_key FROM audit_log l LEFT JOIN spaces s ON s.id = l.space_id ${where}
       ORDER BY l.at DESC LIMIT ${EXPORT_LIMIT}`,
      params,
    );
    const csv = toCsv(rows.map(mapAudit), [
      { key: 'at', label: 'Time (UTC)' },
      { key: 'actor', label: 'Actor (account ID or rule)' },
      { key: 'event', label: 'Event' },
      { key: 'requestId', label: 'Request' },
      { key: 'objectId', label: 'Object ID' },
      { key: 'objectTitle', label: 'Object' },
      { key: 'spaceKey', label: 'Space' },
      { key: 'bytes', label: 'Bytes' },
      { key: 'details', label: 'Details' },
    ]);
    await audit({ actor: context.accountId, event: AUDIT_EVENTS.EXPORT, details: { report: 'audit', rows: rows.length } });
    return { csv, rows: rows.length, truncated: rows.length >= EXPORT_LIMIT };
  },

  getSettings: async ({ context }) => {
    await adminScope(context);
    return getSettings();
  },

  saveSettings: async ({ payload, context }) => {
    await adminScope(context);
    const before = await getSettings();
    const after = await saveSettings(payload?.settings || {});
    await audit({ actor: context.accountId, event: AUDIT_EVENTS.SETTINGS_CHANGED, details: { before, after } });
    return after;
  },
};

function auditWhere(payload) {
  const clauses = [];
  const params = [];
  if (payload?.event) {
    clauses.push('l.event LIKE ?');
    params.push(`${String(payload.event).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (payload?.requestId) {
    clauses.push('l.request_id = ?');
    params.push(String(payload.requestId));
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function mapAudit(r) {
  return {
    id: r.id, at: r.at, actor: r.actor, event: r.event, requestId: r.request_id, objectId: r.object_id,
    objectTitle: r.object_title, spaceKey: r.space_key, bytes: r.bytes === null ? null : Number(r.bytes), details: r.details,
  };
}

for (const [name, fn] of Object.entries(handlers)) resolver.define(name, safe(fn));

export const adminResolver = resolver.getDefinitions();
