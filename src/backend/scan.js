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
//   finalize    per space: resolve cross-page references
//   dups        flag probable duplicates (same name and size)
//   cleanup     remove rows that were not seen in this scan
//   snapshot    compute the summary and health score
//   rules       turn retention rules into pending review requests

import { createHash } from 'node:crypto';
import * as cf from './confluence.js';
import { exec, query, queryOne, upsertMany, placeholders } from './db/sql.js';
import { schemaLooksComplete, SCHEMA_VERSION } from './db/schema.js';
import { extractReferences, isAttachmentReferenced } from './lib/refs.js';
import { fileExtension, typeCategory } from './lib/files.js';
import { toSqlDate, fromSqlDate } from './lib/time.js';
import { getSettings, getState, setState } from './settings.js';
import { scanQueue, migrateQueue, WORK_BUDGET_MS } from './queues.js';
import { auditSafe, AUDIT_EVENTS } from './audit.js';
import { takeSnapshot, runSummaryJob } from './summary.js';
import { applyRetentionRules } from './rules.js';

const STATE_KEY = 'scan:state';
const SYNC_CHUNK = 1000;
const SAVE_EVERY_MS = 15000;
const DUP_CHUNK = 2000;
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

/** True when the database is set up. Otherwise queues the setup and returns false. */
export async function ensureSchema() {
  if ((await getState('schema')) === SCHEMA_VERSION && (await schemaLooksComplete())) return true;
  await migrateQueue.push({ body: { reason: 'scan' } });
  return false;
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
  // The same queue also computes dashboard figures in the background.
  if (event?.body?.summary) {
    await runSummaryJob(event.body.summary);
    return;
  }
  const scanId = event?.body?.scanId;
  const started = Date.now();
  let state = await getScanState();
  if (!state || state.scanId !== scanId || state.status !== 'running') return; // stale or cancelled chain

  // The scan never changes the database structure itself (parallel DDL makes
  // index builds fail): it waits for the setup queue and tries again.
  if (!(await ensureSchema())) {
    state.phaseNote = 'waiting for database setup';
    await setState(STATE_KEY, { ...state, heartbeat: Date.now() });
    await scanQueue.push({ body: { scanId }, delayInSeconds: 120 });
    return;
  }
  const settings = await getSettings();

  // Progress is saved every SAVE_EVERY_MS rather than after every step, to keep
  // key-value store traffic low on large sites (thousands of steps per scan).
  // Steps are idempotent, so after a crash at most a few seconds are redone.
  let lastSave = Date.now();
  while (Date.now() - started < WORK_BUDGET_MS) {
    try {
      state = await step(state, settings);
      state.failures = 0;
    } catch (err) {
      state.failures = (state.failures || 0) + 1;
      state.lastError = `${state.phase}: ${err.message}`;
      console.error('scan step failed', state.phase, err);
      if (state.failures >= 5) {
        // A space whose content keeps failing is skipped, so one bad space
        // cannot stop the scan of the whole site. Other phases still fail.
        if (state.phase === 'content' && state.currentSpace) {
          console.error('skipping space after repeated errors', state.currentSpace.space_key, err.message);
          state.skipped = [...(state.skipped || []), { space: state.currentSpace.space_key, error: err.message.slice(0, 500) }].slice(-50);
          state.counters.skippedSpaces += 1;
          state.complete = { ...state.complete, partial: true };
          state.spaceCursor = String(state.currentSpace.id);
          state.currentSpace = null;
          state.pass = 0;
          state.cursor = null;
          state.failures = 0;
        } else {
          await fail(state, state.lastError);
          return;
        }
      } else {
        await new Promise((r) => setTimeout(r, 2000 * state.failures));
      }
    }
    if (state.status !== 'running' || Date.now() - lastSave >= SAVE_EVERY_MS) {
      // Re-read first, so a cancel from the UI is respected and not overwritten.
      const latest = await getScanState();
      if (latest.scanId !== scanId || latest.status !== 'running') return;
      state.heartbeat = Date.now();
      await setState(STATE_KEY, state);
      lastSave = Date.now();
      if (state.status !== 'running') return;
    }
  }
  state.heartbeat = Date.now();
  await setState(STATE_KEY, state);
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
    case 'dups':
      return stepDups(state);
    case 'missing': // phase of older versions; continue with its replacement
      return { ...state, phase: 'dups', dupCursor: '' };
    case 'cleanup':
      return stepCleanup(state);
    case 'snapshot': {
      await setState('summary:epoch', Date.now()); // cached space figures are now out of date
      await takeSnapshot(settings);
      return { ...state, phase: 'rules' };
    }
    case 'rules': {
      await applyRetentionRules(settings);
      const done = { ...state, status: 'done', phase: 'done', finishedAt: new Date().toISOString() };
      await auditSafe({ actor: 'app', event: AUDIT_EVENTS.SCAN_FINISHED, details: { scanId: state.scanId, counters: state.counters, skipped: state.skipped || [] } });
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
      size * Math.max(1, Number(a.version?.number) || 1),
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
    ['id', 'title', 'file_ext', 'type_category', 'media_type', 'file_size', 'version_number', 'stored_bytes', 'status', 'container_id',
      'container_kind', 'created_at', 'modified_at', 'modified_by', 'webui_link', 'download_link', 'dup_key',
      'trashed_seen_at', 'scan_id'],
    rows,
    ['title', 'file_ext', 'type_category', 'media_type', 'file_size', 'version_number', 'stored_bytes', 'container_id', 'container_kind',
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
  // Remember the space before any work, so repeated errors can skip exactly this one.
  if (space) state.currentSpace = space;
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

  await syncAttachmentsOfPages(items, space, pass, analysed);

  // Cross-page references, resolved in the finalize phase.
  if (!analysed.length) return;
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

const normDate = (v) => (v ? toSqlDate(fromSqlDate(v)) : null);
const normFlag = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Copies each page's space, status and last change onto its attachments and,
 * when the body was read, whether each file is referenced on the page.
 * Rows are read and written by primary key in small chunks, and only rows that
 * actually change are written: Forge SQL limits a single query to 16 MiB.
 */
async function syncAttachmentsOfPages(items, space, pass, analysed) {
  const pages = new Map(
    items.map((p) => [
      String(p.id),
      {
        spaceId: String(p.spaceId || space.id),
        status: p.status || pass.statuses[0],
        modified: toSqlDate(p.version?.createdAt || p.createdAt),
      },
    ]),
  );
  const refsByPage = new Map(analysed.map((a) => [a.id, a.refs]));
  const pageIds = [...pages.keys()];
  const changes = new Map(); // wanted values (JSON) -> attachment ids

  for (let after = ''; ; ) {
    const atts = await query(
      `SELECT id, title, container_id, is_referenced, space_id, container_status, container_modified_at
       FROM attachments WHERE container_id IN (${placeholders(pageIds.length)}) AND id > ?
       ORDER BY id LIMIT ${SYNC_CHUNK}`,
      [...pageIds, after],
    );
    for (const att of atts) {
      const page = pages.get(String(att.container_id));
      if (!page) continue;
      const refs = refsByPage.get(String(att.container_id));
      const referenced = refs ? (isAttachmentReferenced(att.title, refs) ? 1 : 0) : normFlag(att.is_referenced);
      const want = [page.spaceId, page.status, page.modified, referenced];
      const have = [att.space_id ? String(att.space_id) : null, att.container_status || null, normDate(att.container_modified_at), normFlag(att.is_referenced)];
      if (JSON.stringify(want) === JSON.stringify(have)) continue;
      const key = JSON.stringify(want);
      if (!changes.has(key)) changes.set(key, []);
      changes.get(key).push(String(att.id));
    }
    if (atts.length < SYNC_CHUNK) break;
    after = String(atts[atts.length - 1].id);
  }

  // Written as multi-row upserts (100 rows per statement) on the primary key.
  // scan_id 0 is only used if a row vanished meanwhile; such a stub is removed
  // in the cleanup phase.
  const rows = [];
  for (const [key, ids] of changes) {
    const [spaceId, status, modified, referenced] = JSON.parse(key);
    for (const id of ids) rows.push([id, spaceId, status, modified, referenced, 0]);
  }
  await upsertMany(
    'attachments',
    ['id', 'space_id', 'container_status', 'container_modified_at', 'is_referenced', 'scan_id'],
    rows,
    ['space_id', 'container_status', 'container_modified_at', 'is_referenced'],
  );
}

/**
 * Resolves cross-page references, a few hundred at a time per space, and marks
 * the files they point to as used.
 */
async function stepFinalize(state) {
  const space = state.finalizeSpace || (await nextSpace(state, state.spaceCursor));
  if (!space) return { ...state, phase: 'dups', spaceCursor: '', finalizeSpace: null, refCursor: '', dupCursor: '' };
  const sid = String(space.id);
  const refs = await query(
    'SELECT id FROM attachment_refs WHERE source_space_id = ? AND scan_id = ? AND id > ? ORDER BY id LIMIT 200',
    [sid, state.scanId, state.refCursor || ''],
  );
  if (!refs.length) return { ...state, finalizeSpace: null, spaceCursor: sid, refCursor: '' };
  const ids = refs.map((r) => String(r.id));
  const ph = placeholders(ids.length);
  await exec(
    `UPDATE attachment_refs r
       JOIN spaces s ON s.space_key = r.target_space_key
       JOIN contents c ON c.space_id = s.id AND c.title = r.target_title AND c.kind = r.target_kind
     SET r.resolved_target_id = c.id
     WHERE r.id IN (${ph}) AND r.target_kind IN ('page', 'blogpost')`,
    ids,
  );
  await exec(`UPDATE attachment_refs SET resolved_target_id = target_content_id WHERE id IN (${ph}) AND target_kind = 'id'`, ids);
  await exec(
    `UPDATE attachments a JOIN attachment_refs r ON r.resolved_target_id = a.container_id
     SET a.is_referenced = 1
     WHERE r.id IN (${ph}) AND (r.filename = a.title OR r.filename = '*') AND (a.is_referenced IS NULL OR a.is_referenced = 0)`,
    ids,
  );
  return { ...state, finalizeSpace: space, refCursor: ids[ids.length - 1] };
}

const LIVE = new Set(['current', 'archived']);

/**
 * Marks probable duplicates (same name and size). Walks the dup_key index in
 * order, so it never groups the whole table in one query. For each group of
 * live copies, the copy with the lowest id is kept and the others are extra.
 */
async function stepDups(state) {
  const rows = await query(
    `SELECT id, dup_key, status, dup_count, dup_keep FROM attachments
     WHERE dup_key > ? ORDER BY dup_key LIMIT ${DUP_CHUNK}`,
    [state.dupCursor || ''],
  );
  if (!rows.length) return { ...state, phase: 'cleanup', dupCursor: '' };

  let batch = rows;
  let nextCursor = String(rows[rows.length - 1].dup_key);
  if (rows.length === DUP_CHUNK) {
    const lastKey = nextCursor;
    batch = rows.filter((r) => r.dup_key !== lastKey);
    if (!batch.length) {
      // One name+size shared by thousands of files: handle that group on its own.
      await markHugeDupGroup(lastKey);
      return { ...state, dupCursor: lastKey };
    }
    nextCursor = String(batch[batch.length - 1].dup_key); // the last key is re-read whole next time
  }

  const groups = new Map();
  for (const r of batch) {
    if (!groups.has(r.dup_key)) groups.set(r.dup_key, []);
    groups.get(r.dup_key).push(r);
  }
  const changes = new Map();
  for (const members of groups.values()) {
    const live = members.filter((m) => LIVE.has(m.status));
    const keepId = live.map((m) => String(m.id)).sort()[0];
    for (const m of members) {
      const want = LIVE.has(m.status) ? [live.length, live.length > 1 && String(m.id) !== keepId ? 0 : 1] : [1, 1];
      if (Number(m.dup_count) === want[0] && Number(m.dup_keep) === want[1]) continue;
      const key = want.join('|');
      if (!changes.has(key)) changes.set(key, []);
      changes.get(key).push(String(m.id));
    }
  }
  const rowsOut = [];
  for (const [key, ids] of changes) {
    const [count, keep] = key.split('|').map(Number);
    for (const id of ids) rowsOut.push([id, count, keep, 0]);
  }
  await upsertMany('attachments', ['id', 'dup_count', 'dup_keep', 'scan_id'], rowsOut, ['dup_count', 'dup_keep']);
  return { ...state, dupCursor: nextCursor };
}

async function markHugeDupGroup(key) {
  const agg = await queryOne(
    "SELECT COUNT(*) AS n, MIN(id) AS keep_id FROM attachments WHERE dup_key = ? AND status IN ('current', 'archived')",
    [key],
  );
  const n = Number(agg?.n) || 0;
  await exec(
    "UPDATE attachments SET dup_count = ?, dup_keep = IF(id = ?, 1, 0) WHERE dup_key = ? AND status IN ('current', 'archived')",
    [Math.max(n, 1), agg?.keep_id || '', key],
  );
}

async function stepCleanup(state) {
  // Remove rows not seen in this scan, but only for phases that completed fully.
  const tables = [];
  if (state.complete.attachments) tables.push('attachments');
  if (state.complete.content && !state.complete.partial) tables.push('contents', 'attachment_refs');
  tables.push('spaces');
  for (const table of tables) {
    const n = await exec(`DELETE FROM ${table} WHERE scan_id < ? LIMIT 1000`, [state.scanId]);
    if (n >= 1000) return state; // more to delete; continue in the next step
  }
  return { ...state, phase: 'snapshot' };
}
