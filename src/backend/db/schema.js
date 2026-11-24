// Forge SQL schema. Migrations are append-only: never edit a migration that has
// shipped, add a new one instead. Each statement must be idempotent.
//
// "Index, don't copy": we store metadata and links only, never file contents
// or page bodies.

import { migrationRunner } from '@forge/sql';

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
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1][0];

/** Runs every pending migration. Safe to call repeatedly. */
export async function runMigrations() {
  let runner = migrationRunner;
  for (const [name, ddl] of MIGRATIONS) runner = runner.enqueue(name, ddl);
  return runner.run();
}
