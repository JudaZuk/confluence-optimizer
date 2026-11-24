// Resolver handlers shared by the admin console and the space view.
// `scope` is decided on the server from the module context, never by the UI.

import { query, queryOne } from '../db/sql.js';
import { buildAttachmentWhere, sortClause, sortSpec, sortRows, paging, STORED_BYTES_SQL } from '../lib/filters.js';
import { toCsv } from '../lib/csv.js';
import { getSettings, getState, setState, deleteState } from '../settings.js';
import { getScanState } from '../scan.js';
import { computeTrashReport, exemptSpaceIds, requestSummary } from '../summary.js';
import { createRequest, listRequests, getRequest, cancelRequest, RequestError } from '../requests.js';
import { audit, AUDIT_EVENTS } from '../audit.js';
import { ForbiddenError } from '../auth.js';
import { SCHEMA_VERSION, schemaLooksComplete } from '../db/schema.js';
import { migrateQueue } from '../queues.js';

export const EXPORT_LIMIT = 5000;

/** Wraps a handler so expected errors reach the UI as { error }. */
export function safe(fn) {
  return async (req) => {
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof ForbiddenError) return { error: err.message, forbidden: true };
      if (err instanceof RequestError) return { error: err.message };
      console.error('resolver error', err);
      return { error: `Something went wrong: ${err.message}` };
    }
  };
}

// Verified at most every 10 minutes per warm function instance, so normal page
// loads stay cheap.
let schemaVerifiedAt = 0;
export function resetSchemaCheck() {
  schemaVerifiedAt = 0;
}

export async function schemaReady() {
  if ((await getState('schema')) === SCHEMA_VERSION) {
    if (Date.now() - schemaVerifiedAt < 10 * 60 * 1000) return true;
    if (await schemaLooksComplete()) {
      schemaVerifiedAt = Date.now();
      return true;
    }
    // Marked ready but columns are missing (an interrupted setup): repair it.
    console.error('schema marked ready but incomplete; re-running database setup');
    await deleteState('schema');
    await deleteState('schema:requestedAt');
  }
  // First use after install or upgrade: set up the database in the background.
  const pending = await getState('schema:requestedAt');
  if (!pending || Date.now() - pending > 5 * 60 * 1000) {
    await migrateQueue.push({ body: { reason: 'resolver' } });
    await setState('schema:requestedAt', Date.now());
  }
  return false;
}

// The list reads attachments only; page titles and space keys are looked up by
// id afterwards. A join against every page could exceed Forge SQL's 16 MiB
// per-query memory limit on large sites.
const ATTACHMENT_COLUMNS = `a.id, a.title, a.type_category, a.media_type, a.file_size, a.version_number,
  ${STORED_BYTES_SQL} AS stored_bytes, a.status, a.created_at, a.modified_at, a.modified_by,
  a.webui_link, a.download_link, a.is_referenced, a.orphan_reason, a.space_id, a.container_id,
  a.container_status, a.container_modified_at`;

async function lookupByIds(table, column, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = await query(`SELECT id, ${column} AS v FROM ${table} WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk);
    for (const r of rows) out.set(String(r.id), r.v);
  }
  return out;
}

/**
 * Sorted page of attachments in two steps. Step 1 sorts using only the id and
 * the sort columns, which keeps the data the database moves around small
 * (sorting full rows of a large table exceeded Forge SQL's 16 MiB per-query
 * memory limit). Step 2 fetches the full rows for those ids only.
 */
// Up to this many matches, the list fetches the matching IDs unsorted and sorts
// them in code. With few matches, an ORDER BY makes the database walk the sort
// index through every file to find them, which can exceed the memory limit.
// With many matches, the index walk finds a page of results quickly.
export const SORT_IN_CODE_LIMIT = 5000;

async function pageOfAttachments(where, params, sort, limit, offset, total) {
  let ids;
  if (total <= SORT_IN_CODE_LIMIT) {
    const spec = sortSpec(sort);
    const keys = await query(`SELECT a.id, a.${spec.column} FROM attachments a WHERE ${where} LIMIT ${SORT_IN_CODE_LIMIT + 1}`, params);
    ids = sortRows(keys, spec)
      .slice(offset, offset + limit)
      .map((r) => String(r.id));
  } else {
    ids = (
      await query(
        `SELECT a.id FROM attachments a WHERE ${where}
         ORDER BY ${sortClause(sort)} LIMIT ${limit} OFFSET ${offset}`,
        params,
      )
    ).map((r) => String(r.id));
  }
  const byId = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await query(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments a WHERE a.id IN (${chunk.map(() => '?').join(', ')})`, chunk);
    for (const r of rows) byId.set(String(r.id), r);
  }
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function withNames(rows) {
  const titles = await lookupByIds('contents', 'title', rows.map((r) => r.container_id));
  const keys = await lookupByIds('spaces', 'space_key', rows.map((r) => r.space_id));
  return rows.map((r) => ({ ...r, container_title: titles.get(String(r.container_id)) || null, space_key: keys.get(String(r.space_id)) || null }));
}

async function attachmentQuery(scope, filters) {
  const settings = await getSettings();
  const exempt = await exemptSpaceIds(settings);
  return {
    settings,
    ...buildAttachmentWhere(filters || {}, { spaceId: scope.spaceId, rules: settings, exemptSpaceIds: exempt }),
  };
}

function mapAttachment(r, base) {
  return {
    id: String(r.id),
    title: r.title,
    category: r.type_category,
    mediaType: r.media_type,
    size: Number(r.file_size) || 0,
    versions: Number(r.version_number) || 1,
    storedBytes: Number(r.stored_bytes) || 0,
    status: r.status,
    createdAt: r.created_at,
    modifiedAt: r.modified_at,
    modifiedBy: r.modified_by,
    spaceKey: r.space_key,
    containerTitle: r.container_title,
    containerStatus: r.container_status,
    containerModifiedAt: r.container_modified_at,
    referenced: r.is_referenced === null || r.is_referenced === undefined ? null : Number(r.is_referenced) === 1,
    orphanReason: r.orphan_reason,
    url: r.webui_link ? `${base}${r.webui_link}` : null,
    downloadUrl: r.download_link ? `${base}${r.download_link}` : null,
  };
}

/** Handlers parameterised by a scope resolver: (context) => { spaceId, spaceKey, isAdmin, accountId }. */
export function commonHandlers(getScope) {
  return {
    getStatus: async ({ context }) => {
      const scope = await getScope(context);
      const ready = await schemaReady();
      const settings = await getSettings();
      return {
        ready,
        scope: { spaceId: scope.spaceId || null, spaceKey: scope.spaceKey || null, isAdmin: scope.isAdmin },
        scan: await getScanState(),
        summaryStale: Boolean(await getState('summary:stale')),
        settings: {
          storageQuotaGb: settings.storageQuotaGb,
          keepVersions: settings.keepVersions,
          staleMonths: settings.staleMonths,
          unusedMinAgeDays: settings.unusedMinAgeDays,
          largeFileMb: settings.largeFileMb,
          allowSpaceAdminRequests: settings.allowSpaceAdminRequests,
        },
      };
    },

    getSpaceSummary: async ({ payload, context }) => {
      const scope = await getScope(context);
      if (!scope.spaceId) throw new RequestError('No space in context.');
      if (!(await schemaReady())) return { notReady: true };
      if ((await getScanState()).status === 'never') return { notReady: true };
      const { summary, refreshing } = await requestSummary(scope.spaceId, Boolean(payload?.refresh));
      return summary ? { ...summary, refreshing } : { pending: true };
    },

    listAttachments: async ({ payload, context }) => {
      const scope = await getScope(context);
      const { where, params } = await attachmentQuery(scope, payload?.filters);
      const { limit, offset } = paging(payload?.page, payload?.pageSize);
      const totals = await queryOne(`SELECT COUNT(*) AS n, SUM(${STORED_BYTES_SQL}) AS bytes FROM attachments a WHERE ${where}`, params);
      const rows = await withNames(await pageOfAttachments(where, params, payload?.sort, limit, offset, Number(totals?.n) || 0));
      const base = (await getState('baseUrl')) || '';
      return { rows: rows.map((r) => mapAttachment(r, base)), total: Number(totals?.n) || 0, totalBytes: Number(totals?.bytes) || 0 };
    },

    exportAttachments: async ({ payload, context }) => {
      const scope = await getScope(context);
      const { where, params } = await attachmentQuery(scope, payload?.filters);
      const count = await queryOne(`SELECT COUNT(*) AS n FROM attachments a WHERE ${where}`, params);
      const rows = await withNames(await pageOfAttachments(where, params, payload?.sort, EXPORT_LIMIT, 0, Number(count?.n) || 0));
      const base = (await getState('baseUrl')) || '';
      const mapped = rows.map((r) => mapAttachment(r, base));
      const csv = toCsv(mapped, [
        { key: 'id', label: 'Attachment ID' },
        { key: 'title', label: 'File name' },
        { key: 'spaceKey', label: 'Space' },
        { key: 'containerTitle', label: 'Page' },
        { key: 'category', label: 'Type' },
        { key: 'size', label: 'Size (bytes)' },
        { key: 'versions', label: 'Versions' },
        { key: 'storedBytes', label: 'Stored incl. versions (bytes, est.)' },
        { key: 'status', label: 'Status' },
        { key: 'modifiedAt', label: 'Last modified (UTC)' },
        { key: 'modifiedBy', label: 'Last modified by (account ID)' },
        { key: 'referenced', label: 'Referenced on page' },
        { key: 'url', label: 'Link' },
        { key: 'downloadUrl', label: 'Download link' },
      ]);
      await audit({
        actor: context.accountId, event: AUDIT_EVENTS.EXPORT, spaceId: scope.spaceId,
        details: { report: 'attachments', rows: mapped.length, filters: payload?.filters || {} },
      });
      return { csv, rows: mapped.length, truncated: mapped.length >= EXPORT_LIMIT };
    },

    getTrashReport: async ({ context }) => {
      const scope = await getScope(context);
      return computeTrashReport(scope.spaceId || null);
    },

    createRequest: async ({ payload, context }) => {
      const scope = await getScope(context);
      const settings = await getSettings();
      if (!scope.isAdmin && !settings.allowSpaceAdminRequests) {
        throw new RequestError('Cleanup requests from space admins are turned off by your Confluence administrator.');
      }
      return createRequest({
        actor: context.accountId,
        scope: scope.spaceId ? 'space' : 'site',
        spaceId: scope.spaceId,
        action: payload?.action,
        selection: payload?.selection,
        note: payload?.note,
        params: payload?.params || {},
        settings,
      });
    },

    listRequests: async ({ payload, context }) => {
      const scope = await getScope(context);
      return listRequests({ status: payload?.status, spaceId: scope.spaceId, page: payload?.page });
    },

    getRequest: async ({ payload, context }) => {
      const scope = await getScope(context);
      return getRequest({ id: payload?.id, spaceId: scope.spaceId });
    },

    cancelRequest: async ({ payload, context }) => {
      const scope = await getScope(context);
      return cancelRequest({ actor: context.accountId, id: payload?.id, spaceId: scope.spaceId, isAdmin: scope.isAdmin && !scope.spaceId });
    },
  };
}

