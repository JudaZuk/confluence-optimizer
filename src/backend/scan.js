// Site scan: builds the metadata index in Forge SQL.
//
// The scan runs as a chain of async events. Each invocation works for a fixed
// time budget, saves its position in the key-value store and queues the next
// invocation, so a scan of any size can finish and survive restarts.
//
// Phases
//   spaces      list every space
//   attachments list every attachment site-wide (current, archived, trashed)
//   content     per space: pages and blog posts (bodies -> reference analysis),
//               then trashed pages and blog posts
//   finalize    per space: attach space ids, orphan flags, cross-page references
//   missing     flag attachments whose page no longer exists
//   cleanup     remove rows that were not seen in this scan
//   snapshot    compute the summary and health score
//   rules       turn retention rules into pending review requests

import { createHash } from 'node:crypto';
import * as cf from './confluence.js';
import { exec, query, queryOne, upsertMany, placeholders } from './db/sql.js';
import { runMigrations, SCHEMA_VERSION } from './db/schema.js';
import { extractReferences, isAttachmentReferenced } from './lib/refs.js';
import { fileExtension, typeCategory } from './lib/files.js';
import { toSqlDate } from './lib/time.js';
import { getSettings, getState, setState } from './settings.js';
import { scanQueue, WORK_BUDGET_MS } from './queues.js';
import { auditSafe, AUDIT_EVENTS } from './audit.js';
import { takeSnapshot } from './summary.js';
import { applyRetentionRules } from './rules.js';

const STATE_KEY = 'scan:state';
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const nowSql = () => toSqlDate(new Date());

// Content passes per space, in order.
const CONTENT_PASSES = [
  { kind: 'page', statuses: ['current', 'archived'], body: true },
  { kind: 'blogpost', statuses: ['current'], body: true },
  { kind: 'page', statuses: ['trashed'], body: false },
  { kind: 'blogpost', statuses: ['trashed'], body: false },
];

export async function getScanState() {
  return getState(STATE_KEY, { status: 'never' });
}

export async function ensureSchema() {
  if ((await getState('schema')) === SCHEMA_VERSION) return;
  await runMigrations();
  await setState('schema', SCHEMA_VERSION);
}

/** Starts a scan unless one is already running. Returns the scan state. */
export async function startScan(actor) {
  const current = await getScanState();
  if (current.status === 'running' && Date.now() - (current.heartbeat || 0) < 30 * 60 * 1000) {
    return current;
  }
  const state = {
    scanId: Date.now(),
    status: 'running',
    phase: 'spaces',
    startedAt: new Date().toISOString(),
    startedBy: actor,
    heartbeat: Date.now(),
    cursor: null,
    spaceCursor: '',
    pass: 0,
    complete: { attachments: false, content: false },
    counters: { spaces: 0, attachments: 0, pages: 0, blogposts: 0, trashed: 0, refs: 0, skippedSpaces: 0 },
    failures: 0,
  };
  await setState(STATE_KEY, state);
  await auditSafe({ actor, event: AUDIT_EVENTS.SCAN_STARTED, details: { scanId: state.scanId } });
  await scanQueue.push({ body: { scanId: state.scanId } });
  return state;
}

export async function cancelScan(actor) {
  const state = await getScanState();
  if (state.status !== 'running') return state;
  const next = { ...state, status: 'cancelled', finishedAt: new Date().toISOString(), cancelledBy: actor };
  await setState(STATE_KEY, next);
  return next;
}

/** Async event consumer. */
export async function scanWorker(event) {
  const scanId = event?.body?.scanId;
  const started = Date.now();
  let state = await getScanState();
  if (!state || state.scanId !== scanId || state.status !== 'running') return; // stale or cancelled chain

  try {
    await ensureSchema();
  } catch (err) {
    await fail(state, `Database setup failed: ${err.message}`);
    return;
  }
  const settings = await getSettings();

  while (Date.now() - started < WORK_BUDGET_MS) {
    // Re-read so a cancel from the UI stops the loop promptly.
    const latest = await getScanState();
    if (latest.scanId !== scanId || latest.status !== 'running') return;
    try {
      state = await step(state, settings);
      state.failures = 0;
    } catch (err) {
      state.failures = (state.failures || 0) + 1;
      state.lastError = `${state.phase}: ${err.message}`;
      console.error('scan step failed', state.phase, err);
      if (state.failures >= 5) {
        await fail(state, state.lastError);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000 * state.failures));
    }
    state.heartbeat = Date.now();
    await setState(STATE_KEY, state);
    if (state.status !== 'running') return;
  }
  await scanQueue.push({ body: { scanId } });
}

async function fail(state, message) {
  const next = { ...state, status: 'failed', error: message, finishedAt: new Date().toISOString() };
  await setState(STATE_KEY, next);
  await auditSafe({ actor: 'app', event: AUDIT_EVENTS.SCAN_FAILED, details: { scanId: state.scanId, error: message } });
}

/** Performs one unit of work and returns the new state. */
async function step(state, settings) {
  switch (state.phase) {
    case 'spaces':
      return stepSpaces(state);
    case 'attachments':
      return stepAttachments(state);
    case 'content':
      return stepContent(state, settings);
    case 'finalize':
      return stepFinalize(state);
    case 'missing':
      return stepMissing(state);
    case 'cleanup':
      return stepCleanup(state);
    case 'snapshot': {
      await takeSnapshot(settings);
      return { ...state, phase: 'rules' };
    }
    case 'rules': {
      await applyRetentionRules(settings);
      const done = { ...state, status: 'done', phase: 'done', finishedAt: new Date().toISOString() };
      await auditSafe({ actor: 'app', event: AUDIT_EVENTS.SCAN_FINISHED, details: { scanId: state.scanId, counters: state.counters } });
      return done;
    }
    default:
      return { ...state, status: 'failed', error: `Unknown phase ${state.phase}` };
  }
}

// ------------------------------------------------------------------ phases

// Spaces are listed twice: with the default filter and explicitly archived ones,
// so attachments in archived spaces are never mistaken for orphans.
const SPACE_PASSES = [null, 'archived'];

async function stepSpaces(state) {
  const statusPass = state.spaceStatusPass || 0;
  const body = await cf.getSpaces(state.cursor, SPACE_PASSES[statusPass]);
  const rows = (body?.results || []).map((s) => [
    String(s.id), s.key, s.name || null, s.type || null, s.status || null, state.scanId,
  ]);
  await upsertMany('spaces', ['id', 'space_key', 'name', 'type', 'status', 'scan_id'], rows, ['space_key', 'name', 'type', 'status', 'scan_id']);
  state.counters.spaces += rows.length;
  if (body?._links?.base) await setState('baseUrl', body._links.base);
  const cursor = cf.nextCursor(body);
  if (cursor) return { ...state, cursor };
  if (statusPass + 1 < SPACE_PASSES.length) return { ...state, cursor: null, spaceStatusPass: statusPass + 1 };
  return { ...state, cursor: null, phase: 'attachments' };
}

async function stepAttachments(state) {
  const body = await cf.getAttachments(state.cursor);
  const scanNow = nowSql();
  const rows = (body?.results || []).map((a) => {
    const containerId = a.pageId || a.blogPostId || a.customContentId || null;
    const containerKind = a.pageId ? 'page' : a.blogPostId ? 'blogpost' : a.customContentId ? 'custom' : 'unknown';
    const size = Number(a.fileSize) || 0;
    const title = a.title || '';
    return [
      String(a.id),
      title.slice(0, 512),
      fileExtension(title),
      typeCategory(title, a.mediaType),
      (a.mediaType || '').slice(0, 255),
      size,
      Number(a.version?.number) || 1,
      a.status || 'current',
      containerId ? String(containerId) : null,
      containerKind,
      toSqlDate(a.createdAt),
      toSqlDate(a.version?.createdAt || a.createdAt),
      a.version?.authorId || null,
      (a.webuiLink || '').slice(0, 1024),
      (a.downloadLink || '').slice(0, 1024),
      sha1(`${title.toLowerCase()}|${size}`),
      a.status === 'trashed' ? scanNow : null,
      state.scanId,
    ];
  });
  await upsertMany(
    'attachments',
    ['id', 'title', 'file_ext', 'type_category', 'media_type', 'file_size', 'version_number', 'status', 'container_id',
      'container_kind', 'created_at', 'modified_at', 'modified_by', 'webui_link', 'download_link', 'dup_key',
      'trashed_seen_at', 'scan_id'],
    rows,
    ['title', 'file_ext', 'type_category', 'media_type', 'file_size', 'version_number', 'container_id', 'container_kind',
      'created_at', 'modified_at', 'modified_by', 'webui_link', 'download_link', 'dup_key', 'scan_id'],
    {
      // Keep the first time we saw an item in the trash; clear it when restored.
      trashed_seen_at: "IF(VALUES(status) = 'trashed', COALESCE(trashed_seen_at, VALUES(trashed_seen_at)), NULL)",
      status: 'VALUES(status)',
    },
  );
  state.counters.attachments += rows.length;
  if (body?._links?.base) await setState('baseUrl', body._links.base);
  const cursor = cf.nextCursor(body);
  if (cursor) return { ...state, cursor };
  return { ...state, cursor: null, phase: 'content', spaceCursor: '', pass: 0, complete: { ...state.complete, attachments: true } };
}

async function nextSpace(state, after) {
  return queryOne('SELECT id, space_key FROM spaces WHERE scan_id = ? AND id > ? ORDER BY id LIMIT 1', [state.scanId, after]);
}

async function stepContent(state, settings) {
  // Pick the current space (first one after spaceCursor).
  const space = state.currentSpace || (await nextSpace(state, state.spaceCursor));
  if (!space) {
    return { ...state, phase: 'finalize', currentSpace: null, spaceCursor: '', complete: { ...state.complete, content: true } };
  }
  const pass = CONTENT_PASSES[state.pass];
  const withBody = pass.body && settings.scanBodies;
  let body;
  try {
    body = await cf.getSpaceContent(pass.kind, space.id, { cursor: state.cursor, statuses: pass.statuses, body: withBody });
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      // The app cannot read this space (for example restricted). Skip it.
      state.counters.skippedSpaces += 1;
      return { ...state, currentSpace: null, spaceCursor: space.id, pass: 0, cursor: null, complete: { ...state.complete, partial: true } };
    }
    throw err;
  }
  const items = body?.results || [];
  await processContentBatch(state, space, pass, items, withBody);

  const cursor = cf.nextCursor(body);
  if (cursor) return { ...state, currentSpace: space, cursor };
  if (state.pass + 1 < CONTENT_PASSES.length) return { ...state, currentSpace: space, cursor: null, pass: state.pass + 1 };
  return { ...state, currentSpace: null, spaceCursor: space.id, cursor: null, pass: 0 };
}

async function processContentBatch(state, space, pass, items, withBody) {
  if (!items.length) return;
  const scanNow = nowSql();
  const analysed = [];
  const rows = items.map((p) => {
    const refs = withBody ? extractReferences(p.body?.storage?.value || '') : null;
    if (refs) analysed.push({ id: String(p.id), refs });
    return [
      String(p.id),
      pass.kind,
      String(p.spaceId || space.id),
      (p.title || '').slice(0, 512),
      p.status || pass.statuses[0],
      toSqlDate(p.createdAt),
      toSqlDate(p.version?.createdAt || p.createdAt),
      p.version?.authorId || null,
      Number(p.version?.number) || null,
      refs ? 1 : 0,
      refs?.listsAllAttachments ? 1 : 0,
      p.status === 'trashed' ? scanNow : null,
      state.scanId,
    ];
  });
  await upsertMany(
    'contents',
    ['id', 'kind', 'space_id', 'title', 'status', 'created_at', 'modified_at', 'modified_by', 'version_number',
      'body_scanned', 'lists_all', 'trashed_seen_at', 'scan_id'],
    rows,
    ['kind', 'space_id', 'title', 'created_at', 'modified_at', 'modified_by', 'version_number', 'body_scanned', 'lists_all', 'scan_id'],
    {
      trashed_seen_at: "IF(VALUES(status) = 'trashed', COALESCE(trashed_seen_at, VALUES(trashed_seen_at)), NULL)",
      status: 'VALUES(status)',
    },
  );
  if (pass.statuses.includes('trashed')) state.counters.trashed += items.length;
  else state.counters[pass.kind === 'page' ? 'pages' : 'blogposts'] += items.length;

  if (!analysed.length) return;

  // Same-page references: compare each page body with that page's attachments.
  const ids = analysed.map((a) => a.id);
  const atts = await query(`SELECT id, title, container_id FROM attachments WHERE container_id IN (${placeholders(ids.length)})`, ids);
  const byPage = new Map(analysed.map((a) => [a.id, a.refs]));
  const used = [];
  for (const att of atts) {
    const refs = byPage.get(String(att.container_id));
    if (refs && isAttachmentReferenced(att.title, refs)) used.push(String(att.id));
  }
  await exec(`UPDATE attachments SET is_referenced = 0 WHERE container_id IN (${placeholders(ids.length)})`, ids);
  for (let i = 0; i < used.length; i += 500) {
    const chunk = used.slice(i, i + 500);
    await exec(`UPDATE attachments SET is_referenced = 1 WHERE id IN (${placeholders(chunk.length)})`, chunk);
  }

  // Cross-page references, resolved in the finalize phase.
  const refRows = [];
  for (const { id, refs } of analysed) {
    for (const r of refs.crossRefs) {
      const targetSpaceKey = r.kind === 'id' ? null : r.spaceKey || space.space_key;
      const key = `${id}|${r.filename}|${r.kind}|${r.title || ''}|${targetSpaceKey || ''}|${r.contentId || ''}`;
      refRows.push([
        sha1(key), id, String(space.id), String(r.filename).slice(0, 512), r.kind,
        r.title ? String(r.title).slice(0, 512) : null, targetSpaceKey, r.contentId || null, state.scanId,
      ]);
    }
  }
  if (refRows.length) {
    await upsertMany(
      'attachment_refs',
      ['id', 'source_id', 'source_space_id', 'filename', 'target_kind', 'target_title', 'target_space_key', 'target_content_id', 'scan_id'],
      refRows,
      ['scan_id'],
    );
    state.counters.refs += refRows.length;
  }
}

async function stepFinalize(state) {
  const space = await nextSpace(state, state.spaceCursor);
  if (!space) return { ...state, phase: 'missing', spaceCursor: '' };
  const sid = String(space.id);

  // 1. Space of each attachment, from its page or blog post.
  await exec(
    `UPDATE attachments a JOIN contents c ON c.id = a.container_id
     SET a.space_id = c.space_id,
         a.orphan_reason = IF(c.status = 'trashed', 'container_trashed', NULL)
     WHERE c.space_id = ?`,
    [sid],
  );
  // 2. Resolve references made from this space to other pages and blog posts.
  await exec(
    `UPDATE attachment_refs r
       JOIN spaces s ON s.space_key = r.target_space_key
       JOIN contents c ON c.space_id = s.id AND c.title = r.target_title AND c.kind = r.target_kind
     SET r.resolved_target_id = c.id
     WHERE r.source_space_id = ? AND r.scan_id = ? AND r.target_kind IN ('page', 'blogpost')`,
    [sid, state.scanId],
  );
  await exec(
    `UPDATE attachment_refs SET resolved_target_id = target_content_id
     WHERE source_space_id = ? AND scan_id = ? AND target_kind = 'id'`,
    [sid, state.scanId],
  );
  // 3. Anything referenced from another page is in use.
  await exec(
    `UPDATE attachments a JOIN attachment_refs r ON r.resolved_target_id = a.container_id
     SET a.is_referenced = 1
     WHERE r.source_space_id = ? AND r.scan_id = ? AND (r.filename = a.title OR r.filename = '*')`,
    [sid, state.scanId],
  );
  return { ...state, spaceCursor: sid };
}

async function stepMissing(state) {
  // Only trust "missing" when every space was read completely.
  if (!state.complete.content || state.complete.partial) return { ...state, phase: 'cleanup' };
  const rows = await query(
    `SELECT a.id FROM attachments a LEFT JOIN contents c ON c.id = a.container_id
     WHERE c.id IS NULL AND a.container_kind IN ('page', 'blogpost') AND a.status <> 'trashed'
       AND (a.orphan_reason IS NULL OR a.orphan_reason <> 'container_missing')
     LIMIT 1000`,
  );
  if (!rows.length) return { ...state, phase: 'cleanup' };
  const ids = rows.map((r) => String(r.id));
  await exec(`UPDATE attachments SET orphan_reason = 'container_missing' WHERE id IN (${placeholders(ids.length)})`, ids);
  return state;
}

async function stepCleanup(state) {
  // Remove rows not seen in this scan, but only for phases that completed fully.
  const tables = [];
  if (state.complete.attachments) tables.push('attachments');
  if (state.complete.content && !state.complete.partial) tables.push('contents', 'attachment_refs');
  tables.push('spaces');
  for (const table of tables) {
    const n = await exec(`DELETE FROM ${table} WHERE scan_id < ? LIMIT 5000`, [state.scanId]);
    if (n >= 5000) return state; // more to delete; continue in the next step
  }
  return { ...state, phase: 'snapshot' };
}
