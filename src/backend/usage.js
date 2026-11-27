// Usage guard: the app counts its own Forge SQL requests per calendar month
// (UTC) and stops starting expensive work (scans, background figures) before
// the Forge free allowance is used up.
//
// Forge offers apps no way to read their own billing usage, so this is the
// app's own count: close, but not identical to the developer console. Admins
// can correct it in Settings from the figure the developer console shows.

import { kvs } from '@forge/kvs';
import { monthKey, nextMonthStart, evaluateBudget } from './lib/budget.js';

export { monthKey, nextMonthStart, evaluateBudget };

const FLUSH_EVERY = 250; // write the counter to the key-value store every N requests
const pending = { sql: 0, ms: 0 };
const storeKey = (month) => `usage:${month}`;

/** Called by the SQL wrapper after every statement. */
export async function recordSql(ms) {
  pending.sql += 1;
  pending.ms += Math.max(0, Number(ms) || 0);
  if (pending.sql >= FLUSH_EVERY) await flushUsage();
}

/** Adds this function instance's uncounted requests to the monthly total. */
export async function flushUsage() {
  if (!pending.sql) return;
  const add = { sql: pending.sql, ms: pending.ms };
  pending.sql = 0;
  pending.ms = 0;
  try {
    const key = storeKey(monthKey());
    const current = (await kvs.get(key)) || { sqlRequests: 0, sqlMs: 0 };
    current.sqlRequests += add.sql;
    current.sqlMs += add.ms;
    current.updatedAt = new Date().toISOString();
    await kvs.set(key, current);
  } catch (err) {
    // Keep the numbers for the next attempt rather than losing them.
    pending.sql += add.sql;
    pending.ms += add.ms;
    console.error('usage flush failed', err?.message);
  }
}

export async function getUsage() {
  const month = monthKey();
  const stored = (await kvs.get(storeKey(month))) || { sqlRequests: 0, sqlMs: 0 };
  return {
    month,
    sqlRequests: (Number(stored.sqlRequests) || 0) + pending.sql,
    sqlMs: (Number(stored.sqlMs) || 0) + pending.ms,
    correctedAt: stored.correctedAt || null,
    resetsAt: nextMonthStart().toISOString(),
  };
}

/** Sets this month's count to the figure from the developer console. */
export async function correctUsage(sqlRequests) {
  await flushUsage();
  const key = storeKey(monthKey());
  const current = (await kvs.get(key)) || { sqlRequests: 0, sqlMs: 0 };
  current.sqlRequests = Math.max(0, parseInt(sqlRequests, 10) || 0);
  current.correctedAt = new Date().toISOString();
  await kvs.set(key, current);
  return getUsage();
}

export async function budgetStatus(settings) {
  return evaluateBudget(await getUsage(), settings?.usageGuard);
}

/** Wraps a Forge function so its uncounted SQL requests are saved at the end. */
export function withUsageFlush(fn) {
  const wrapped = async (...args) => {
    try {
      return await fn(...args);
    } finally {
      await flushUsage();
    }
  };
  return Object.assign(wrapped, fn); // keep properties of the wrapped handler
}
