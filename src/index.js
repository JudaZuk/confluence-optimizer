// Forge function entry points (see manifest.yml).

import { getSettings, getState } from './backend/settings.js';
import { setupDatabase, SCHEMA_VERSION } from './backend/db/schema.js';
import { migrateQueue, execQueue } from './backend/queues.js';
import { query } from './backend/db/sql.js';
import { toSqlDate } from './backend/lib/time.js';
import { getScanState, startScan } from './backend/scan.js';

export { adminResolver } from './backend/resolvers/admin.js';
export { spaceResolver } from './backend/resolvers/space.js';
export { scanWorker } from './backend/scan.js';
export { execWorker } from './backend/executor.js';

/** App installed or upgraded: create or update the database schema in the background. */
export async function lifecycle() {
  await migrateQueue.push({ body: { reason: 'lifecycle' } });
}

/** Async consumer with a 15 minute budget, as Forge recommends for migrations. */
export async function migrateWorker(event) {
  await setupDatabase(event?.body?.reason || 'queue');
}

/**
 * Daily housekeeping:
 *  - resume approved cleanup jobs whose worker chain was lost
 *  - restart a scan that stopped reporting progress
 *  - start a scan when the last one is older than the configured interval
 */
export async function daily() {
  if ((await getState('schema')) !== SCHEMA_VERSION) {
    await migrateQueue.push({ body: { reason: 'daily' } });
    return;
  }
  const stuck = await query(
    "SELECT id FROM requests WHERE status IN ('approved', 'running') AND (lease_until IS NULL OR lease_until < ?) LIMIT 20",
    [toSqlDate(new Date())],
  );
  for (const r of stuck) await execQueue.push({ body: { requestId: r.id } });

  const settings = await getSettings();
  const scan = await getScanState();
  if (scan.status === 'running') {
    await startScan('app:schedule'); // no-op unless the scan stopped sending heartbeats
    return;
  }
  if (!settings.scanIntervalDays) return;
  const last = scan.finishedAt ? Date.parse(scan.finishedAt) : 0;
  const due = !last || Date.now() - last >= settings.scanIntervalDays * 86400000 - 3600000;
  if (due) await startScan('app:schedule');
}
