// Thin wrapper over @forge/sql with retries for rate limits and bulk upserts.

import { sql } from '@forge/sql';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  const text = `${err?.code || ''} ${err?.message || ''}`.toUpperCase();
  return text.includes('RATE') || text.includes('TOO_MANY') || text.includes('429') || text.includes('TIMEOUT');
}

async function run(query, params) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      let stmt = sql.prepare(query);
      if (params && params.length) stmt = stmt.bindParams(...params);
      return await stmt.execute();
    } catch (err) {
      if (attempt >= 3 || !isRetryable(err)) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
}

/** SELECT -> array of row objects. */
export async function query(text, params = []) {
  const result = await run(text, params);
  return Array.isArray(result?.rows) ? result.rows : [];
}

export async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

/** INSERT/UPDATE/DELETE -> affected row count. */
export async function exec(text, params = []) {
  const result = await run(text, params);
  return Number(result?.rows?.affectedRows ?? 0);
}

/**
 * Multi-row INSERT ... ON DUPLICATE KEY UPDATE, chunked to keep each request
 * well below the 1 MiB request limit.
 *
 * @param {string} table
 * @param {string[]} columns
 * @param {Array<Array<any>>} rows       values in column order
 * @param {string[]} updateColumns       columns overwritten on conflict
 * @param {object} [extraUpdates]        column -> raw SQL expression for conflicts
 */
export async function upsertMany(table, columns, rows, updateColumns, extraUpdates = {}, chunkSize = 100) {
  if (!rows.length) return 0;
  const rowSql = `(${columns.map(() => '?').join(', ')})`;
  const updates = [
    ...updateColumns.map((c) => `${c} = VALUES(${c})`),
    ...Object.entries(extraUpdates).map(([c, expr]) => `${c} = ${expr}`),
  ].join(', ');
  let affected = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const text =
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => rowSql).join(', ')}` +
      (updates ? ` ON DUPLICATE KEY UPDATE ${updates}` : '');
    affected += await exec(text, chunk.flat());
  }
  return affected;
}

export const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ');
