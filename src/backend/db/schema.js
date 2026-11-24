// Forge SQL schema. Migrations are append-only: never edit a migration that has
// shipped, add a new one instead. Each statement must be idempotent.
//
// "Index, don't copy": we store metadata and links only, never file contents
// or page bodies.

import { migrationRunner } from '@forge/sql';
import { randomUUID } from 'node:crypto';
import { kvs } from '@forge/kvs';
import { query } from './sql.js';

export const MIGRATIONS = [
  [
    'v001_spaces',
    `CREATE TABLE IF NOT EXISTS spaces (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      space_key VARCHAR(255) NOT NULL,
      name VARCHAR(512) NULL,
      type VARCHAR(32) NULL,
      status VARCHAR(16) NULL,
      scan_id BIGINT NOT NULL,
      KEY idx_spaces_key (space_key)
    )`,
  ],
  [
    'v002_contents',
    `CREATE TABLE IF NOT EXISTS contents (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      kind VARCHAR(16) NOT NULL,
      space_id VARCHAR(32) NULL,
      title VARCHAR(512) NULL,
      status VARCHAR(16) NULL,
      created_at DATETIME NULL,
      modified_at DATETIME NULL,
      modified_by VARCHAR(128) NULL,
      version_number INT NULL,
      body_scanned TINYINT NOT NULL DEFAULT 0,
      lists_all TINYINT NOT NULL DEFAULT 0,
      trashed_seen_at DATETIME NULL,
      scan_id BIGINT NOT NULL,
      KEY idx_contents_space_title (space_id, title(128)),
      KEY idx_contents_modified (modified_at),
      KEY idx_contents_status (status)
    )`,
  ],
  [
    'v003_attachments',
    `CREATE TABLE IF NOT EXISTS attachments (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      title VARCHAR(512) NULL,
      file_ext VARCHAR(16) NULL,
      type_category VARCHAR(16) NULL,
      media_type VARCHAR(255) NULL,
      file_size BIGINT NOT NULL DEFAULT 0,
      version_number INT NOT NULL DEFAULT 1,
      status VARCHAR(16) NULL,
      container_id VARCHAR(32) NULL,
      container_kind VARCHAR(16) NULL,
      space_id VARCHAR(32) NULL,
      created_at DATETIME NULL,
      modified_at DATETIME NULL,
      modified_by VARCHAR(128) NULL,
      webui_link VARCHAR(1024) NULL,
      download_link VARCHAR(1024) NULL,
      dup_key CHAR(40) NULL,
      is_referenced TINYINT NULL,
      orphan_reason VARCHAR(32) NULL,
      trashed_seen_at DATETIME NULL,
      scan_id BIGINT NOT NULL,
      KEY idx_att_space (space_id),
      KEY idx_att_container (container_id),
      KEY idx_att_status (status),
      KEY idx_att_size (file_size),
      KEY idx_att_modified (modified_at),
      KEY idx_att_dup (dup_key),
      KEY idx_att_type (type_category),
      KEY idx_att_author (modified_by)
    )`,
  ],
  [
    'v004_attachment_refs',
    `CREATE TABLE IF NOT EXISTS attachment_refs (
      id CHAR(40) NOT NULL PRIMARY KEY,
      source_id VARCHAR(32) NOT NULL,
      source_space_id VARCHAR(32) NULL,
      filename VARCHAR(512) NOT NULL,
      target_kind VARCHAR(16) NOT NULL,
      target_title VARCHAR(512) NULL,
      target_space_key VARCHAR(255) NULL,
      target_content_id VARCHAR(32) NULL,
      resolved_target_id VARCHAR(32) NULL,
      scan_id BIGINT NOT NULL,
      KEY idx_refs_target (resolved_target_id),
      KEY idx_refs_source_space (source_space_id)
    )`,
  ],
  [
    'v005_requests',
    `CREATE TABLE IF NOT EXISTS requests (
      id CHAR(36) NOT NULL PRIMARY KEY,
      created_at DATETIME NOT NULL,
      requested_by VARCHAR(128) NOT NULL,
      scope VARCHAR(16) NOT NULL,
      space_id VARCHAR(32) NULL,
      action VARCHAR(32) NOT NULL,
      params TEXT NULL,
      title VARCHAR(512) NOT NULL,
      note TEXT NULL,
      source VARCHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL,
      item_count INT NOT NULL DEFAULT 0,
      total_bytes BIGINT NOT NULL DEFAULT 0,
      decided_by VARCHAR(128) NULL,
      decided_at DATETIME NULL,
      decision_note TEXT NULL,
      started_at DATETIME NULL,
      finished_at DATETIME NULL,
      done_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      skipped_count INT NOT NULL DEFAULT 0,
      freed_bytes BIGINT NOT NULL DEFAULT 0,
      lease_until DATETIME NULL,
      KEY idx_req_status (status),
      KEY idx_req_created (created_at),
      KEY idx_req_space (space_id)
    )`,
  ],
  [
    'v006_request_items',
    `CREATE TABLE IF NOT EXISTS request_items (
      request_id CHAR(36) NOT NULL,
      item_id VARCHAR(32) NOT NULL,
      item_kind VARCHAR(16) NOT NULL,
      title VARCHAR(512) NULL,
      space_id VARCHAR(32) NULL,
      bytes BIGINT NOT NULL DEFAULT 0,
      expected_version INT NULL,
      status VARCHAR(16) NOT NULL,
      message VARCHAR(1024) NULL,
      processed_at DATETIME NULL,
      PRIMARY KEY (request_id, item_id),
      KEY idx_items_status (request_id, status)
    )`,
  ],
  [
    'v007_audit_log',
    `CREATE TABLE IF NOT EXISTS audit_log (
      id CHAR(36) NOT NULL PRIMARY KEY,
      at DATETIME(3) NOT NULL,
      actor VARCHAR(128) NOT NULL,
      event VARCHAR(64) NOT NULL,
      request_id CHAR(36) NULL,
      object_id VARCHAR(32) NULL,
      object_title VARCHAR(512) NULL,
      space_id VARCHAR(32) NULL,
      bytes BIGINT NULL,
      details TEXT NULL,
      KEY idx_audit_at (at),
      KEY idx_audit_event (event),
      KEY idx_audit_request (request_id)
    )`,
  ],
  [
    'v008_health_snapshots',
    `CREATE TABLE IF NOT EXISTS health_snapshots (
      id CHAR(36) NOT NULL PRIMARY KEY,
      taken_at DATETIME NOT NULL,
      score INT NOT NULL,
      total_bytes BIGINT NOT NULL,
      reclaimable_bytes BIGINT NOT NULL,
      trash_bytes BIGINT NOT NULL,
      attachment_count BIGINT NOT NULL,
      summary TEXT NOT NULL,
      KEY idx_snap_taken (taken_at)
    )`,
  ],
  // v0.1.2: per-file copies of the page's status and last change, and duplicate
  // flags computed during the scan, so no query has to join or group the whole
  // attachments table (Forge SQL limits each query to 16 MiB of memory).
  ['v009_att_container_status', 'ALTER TABLE attachments ADD COLUMN IF NOT EXISTS container_status VARCHAR(16) NULL'],
  ['v010_att_container_modified', 'ALTER TABLE attachments ADD COLUMN IF NOT EXISTS container_modified_at DATETIME NULL'],
  ['v011_att_dup_count', 'ALTER TABLE attachments ADD COLUMN IF NOT EXISTS dup_count INT NOT NULL DEFAULT 1'],
  ['v012_att_dup_keep', 'ALTER TABLE attachments ADD COLUMN IF NOT EXISTS dup_keep TINYINT NOT NULL DEFAULT 1'],
  ['v013_att_scan_idx', 'CREATE INDEX IF NOT EXISTS idx_att_scan ON attachments (scan_id)'],
  ['v014_contents_scan_idx', 'CREATE INDEX IF NOT EXISTS idx_contents_scan ON contents (scan_id)'],
  ['v015_refs_scan_idx', 'CREATE INDEX IF NOT EXISTS idx_refs_scan ON attachment_refs (scan_id)'],
  // Stored size (incl. versions) as a real, indexed column, so "largest first"
  // reads the index in order instead of sorting every file.
  ['v016_att_stored_bytes', 'ALTER TABLE attachments ADD COLUMN IF NOT EXISTS stored_bytes BIGINT NOT NULL DEFAULT 0'],
  ['v017_att_stored_idx', 'CREATE INDEX IF NOT EXISTS idx_att_stored ON attachments (stored_bytes)'],
  ['v018_att_versions_idx', 'CREATE INDEX IF NOT EXISTS idx_att_versions ON attachments (version_number)'],
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1][0];

/**
 * Runs every pending migration, then checks that all of them are recorded as
 * applied. Throws (with the missing names) if any is not, so callers never mark
 * the schema as ready when it is not. Safe to call repeatedly.
 */
export async function runMigrations() {
  let runner = migrationRunner;
  for (const [name, ddl] of MIGRATIONS) runner = runner.enqueue(name, ddl);
  const result = await runner.run();
  const applied = new Set(((await migrationRunner.list()) || []).map((m) => m.name));
  const missing = MIGRATIONS.map(([name]) => name).filter((name) => !applied.has(name));
  if (missing.length) {
    throw new Error(`Database setup incomplete, not applied yet: ${missing.join(', ')}`);
  }
  return result;
}

/** Cheap check that the newest columns exist (catches an interrupted setup). */
export async function schemaLooksComplete() {
  try {
    await query('SELECT stored_bytes, dup_count, dup_keep, container_status, container_modified_at FROM attachments LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_KEY = 'schema:lock';
const LOCK_TTL_MS = 14 * 60 * 1000;

function describe(err) {
  const debug = err?.cause?.context?.debug || err?.context?.debug || err?.cause?.debug;
  const reason = debug ? `${debug.code || ''} ${debug.message || ''}`.trim() : err?.cause?.message || '';
  return `${err?.message || err}${reason ? ` (${reason})` : ''}${err?.migrationName ? ` [${err.migrationName}]` : ''}`;
}

/**
 * Sets up or upgrades the database. Only one run at a time (lock in the
 * key-value store), because parallel DDL on the same table makes index builds
 * fail. Retries a few times, logs the database's own reason, and marks the
 * schema ready only when every migration is applied and the columns exist.
 * Returns 'ready', or 'busy' when another run holds the lock.
 */
export async function setupDatabase(reason = '') {
  const token = randomUUID();
  const held = await kvs.get(LOCK_KEY);
  if (held && Date.now() - held.at < LOCK_TTL_MS) return 'busy';
  await kvs.set(LOCK_KEY, { token, at: Date.now() });
  await sleep(1000);
  if ((await kvs.get(LOCK_KEY))?.token !== token) return 'busy'; // someone else won the race
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const applied = await runMigrations();
        console.log(`database setup done (${reason}); newly applied: ${JSON.stringify(applied)}`);
        break;
      } catch (err) {
        console.error(`database setup attempt ${attempt} failed: ${describe(err)}`);
        if (attempt >= 4) throw new Error(`Database setup failed: ${describe(err)}`);
        await sleep(15000 * attempt);
      }
    }
    if (!(await schemaLooksComplete())) throw new Error('Database columns are missing after setup');
    await kvs.set('schema', SCHEMA_VERSION);
    return 'ready';
  } finally {
    if ((await kvs.get(LOCK_KEY))?.token === token) await kvs.delete(LOCK_KEY);
  }
}
