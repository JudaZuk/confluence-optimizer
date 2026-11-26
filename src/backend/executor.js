// Executes approved review requests. Runs as an async event consumer so large
// batches can take as long as they need. Every item is re-checked against
// Confluence right before it is changed, and every result is audited.

import * as cf from './confluence.js';
import { exec, query, queryOne } from './db/sql.js';
import { toSqlDate } from './lib/time.js';
import { audit, auditSafe, AUDIT_EVENTS } from './audit.js';
import { execQueue, WORK_BUDGET_MS } from './queues.js';
import { markSummaryStale } from './requests.js';

const nowSql = () => toSqlDate(new Date());
const leaseUntil = () => toSqlDate(new Date(Date.now() + 16 * 60 * 1000));

class Skip extends Error {}

/** Acquires the request for this invocation. Returns the request row or null. */
async function acquire(requestId) {
  const n = await exec(
    `UPDATE requests SET status = 'running', started_at = COALESCE(started_at, ?), lease_until = ?
     WHERE id = ? AND status IN ('approved', 'running') AND (lease_until IS NULL OR lease_until < ?)`,
    [nowSql(), leaseUntil(), requestId, nowSql()],
  );
  if (!n) return null;
  return queryOne('SELECT * FROM requests WHERE id = ?', [requestId]);
}

async function release(requestId) {
  await exec('UPDATE requests SET lease_until = NULL WHERE id = ?', [requestId]);
}

function parseParams(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** Performs one item. Returns { freed, event, message }. Throws Skip for safe no-ops. */
async function runItem(req, item, params) {
  const id = item.item_id;
  switch (req.action) {
    case 'trash_attachment': {
      let att;
      try {
        att = await cf.getAttachment(id);
      } catch (err) {
        if (err.status === 404) throw new Skip('Not found (already deleted or no longer visible).');
        throw err;
      }
      if (att.status === 'trashed') throw new Skip('Already in the trash.');
      if (item.expected_version && Number(att.version?.number) !== Number(item.expected_version)) {
        throw new Skip('Changed since the request was made; skipped for safety.');
      }
      await cf.trashAttachment(id);
      await exec("UPDATE attachments SET status = 'trashed', trashed_seen_at = COALESCE(trashed_seen_at, ?) WHERE id = ?", [nowSql(), id]);
      return { freed: 0, event: AUDIT_EVENTS.ITEM_TRASHED, message: 'Moved to trash' };
    }
    case 'purge_attachment': {
      try {
        await cf.purgeAttachment(id);
      } catch (err) {
        if (err.status === 404) throw new Skip('Not found (already purged or restored elsewhere).');
        throw err;
      }
      await exec('DELETE FROM attachments WHERE id = ?', [id]);
      return { freed: Number(item.bytes) || 0, event: AUDIT_EVENTS.ITEM_PURGED, message: 'Purged' };
    }
    case 'prune_versions': {
      const keep = Math.max(1, Number(params.keep) || 1);
      let att;
      try {
        att = await cf.getAttachment(id);
      } catch (err) {
        if (err.status === 404) throw new Skip('Not found.');
        throw err;
      }
      const current = Number(att.version?.number) || 1;
      if (item.expected_version && current !== Number(item.expected_version)) {
        throw new Skip('A new version was uploaded since the request was made; skipped for safety.');
      }
      const toDelete = current - keep;
      if (toDelete <= 0) throw new Skip('Nothing to prune.');
      let deleted = 0;
      try {
        // Deleting version 1 renumbers the rest, so always delete the oldest.
        for (; deleted < toDelete; deleted += 1) await cf.deleteContentVersion(id, 1);
      } finally {
        if (deleted > 0) {
          await exec('UPDATE attachments SET version_number = ?, stored_bytes = file_size * ? WHERE id = ?', [current - deleted, current - deleted, id]);
          // If interrupted part-way (for example by a rate limit), the item is
          // retried later: expect the new version number so it is not skipped.
          await exec('UPDATE request_items SET expected_version = ? WHERE request_id = ? AND item_id = ?', [current - deleted, item.request_id, id]);
        }
      }
      const size = Number(att.fileSize) || 0;
      return { freed: size * deleted, event: AUDIT_EVENTS.VERSIONS_DELETED, message: `Deleted ${deleted} old version${deleted === 1 ? '' : 's'}`, details: { deleted, kept: keep } };
    }
    case 'purge_page': {
      try {
        await cf.purgeContent(item.item_kind === 'blogpost' ? 'blogpost' : 'page', id);
      } catch (err) {
        if (err.status === 404) throw new Skip('Not found (already purged or restored).');
        throw err;
      }
      await exec('DELETE FROM attachments WHERE container_id = ?', [id]);
      await exec('DELETE FROM contents WHERE id = ?', [id]);
      return { freed: Number(item.bytes) || 0, event: AUDIT_EVENTS.PAGE_PURGED, message: 'Purged' };
    }
    default:
      throw new Error(`Unsupported action ${req.action}`);
  }
}

/** Async event consumer for approved requests. */
export async function execWorker(event) {
  const requestId = event?.body?.requestId;
  if (!requestId) return;
  const started = Date.now();
  const req = await acquire(requestId);
  if (!req) return; // not approved, finished, or another invocation holds it
  const params = parseParams(req.params);

  try {
    while (Date.now() - started < WORK_BUDGET_MS) {
      // Stop promptly if an admin cancelled the request meanwhile.
      const live = await queryOne('SELECT status FROM requests WHERE id = ?', [requestId]);
      if (live?.status !== 'running') return;

      const items = await query(
        "SELECT * FROM request_items WHERE request_id = ? AND status = 'pending' ORDER BY item_id LIMIT 25",
        [requestId],
      );
      if (!items.length) {
        await finish(req);
        return;
      }
      for (const item of items) {
        let status = 'done';
        let message = '';
        let freed = 0;
        try {
          const result = await runItem(req, item, params);
          freed = result.freed;
          message = result.message;
          await audit({
            actor: req.decided_by || 'app', event: result.event, requestId, objectId: item.item_id,
            objectTitle: item.title, spaceId: item.space_id, bytes: freed || Number(item.bytes) || 0,
            details: { requestedBy: req.requested_by, approvedBy: req.decided_by, ...(result.details || {}) },
          });
        } catch (err) {
          if (err.rateLimited) {
            // Leave this item pending and pause the whole job.
            const waitSec = Math.min(Math.max(err.retryAfterSec || 300, 60), 900);
            console.warn(`cleanup ${requestId} paused by Confluence rate limit for ${waitSec} s`);
            await release(requestId);
            await execQueue.push({ body: { requestId }, delayInSeconds: waitSec });
            return;
          }
          if (err instanceof Skip) {
            status = 'skipped';
            message = err.message;
          } else {
            status = 'failed';
            message = `${err.status ? `HTTP ${err.status}: ` : ''}${err.message}`.slice(0, 1000);
            await auditSafe({
              actor: req.decided_by || 'app', event: AUDIT_EVENTS.ITEM_FAILED, requestId, objectId: item.item_id,
              objectTitle: item.title, spaceId: item.space_id, details: { error: message, action: req.action },
            });
          }
        }
        await exec(
          'UPDATE request_items SET status = ?, message = ?, processed_at = ? WHERE request_id = ? AND item_id = ?',
          [status, message.slice(0, 1024), nowSql(), requestId, item.item_id],
        );
        await exec(
          `UPDATE requests SET done_count = done_count + ?, failed_count = failed_count + ?,
             skipped_count = skipped_count + ?, freed_bytes = freed_bytes + ?, lease_until = ? WHERE id = ?`,
          [status === 'done' ? 1 : 0, status === 'failed' ? 1 : 0, status === 'skipped' ? 1 : 0, freed, leaseUntil(), requestId],
        );
      }
    }
    // Out of time: hand over to a fresh invocation.
    await release(requestId);
    await execQueue.push({ body: { requestId } });
  } catch (err) {
    console.error('exec worker error', err);
    await release(requestId);
    await execQueue.push({ body: { requestId }, delayInSeconds: 60 });
  }
}

async function finish(req) {
  const counts = await queryOne(
    `SELECT SUM(status = 'done') AS done, SUM(status = 'failed') AS failed, SUM(status = 'skipped') AS skipped
     FROM request_items WHERE request_id = ?`,
    [req.id],
  );
  const done = Number(counts?.done) || 0;
  const failed = Number(counts?.failed) || 0;
  const status = failed === 0 ? 'done' : done === 0 ? 'failed' : 'partial';
  await exec('UPDATE requests SET status = ?, finished_at = ?, lease_until = NULL WHERE id = ?', [status, nowSql(), req.id]);
  const final = await queryOne('SELECT freed_bytes FROM requests WHERE id = ?', [req.id]);
  await auditSafe({
    actor: req.decided_by || 'app', event: AUDIT_EVENTS.REQUEST_FINISHED, requestId: req.id, spaceId: req.space_id,
    bytes: Number(final?.freed_bytes) || 0, details: { status, done, failed, skipped: Number(counts?.skipped) || 0, action: req.action },
  });
  await markSummaryStale();
}
