// Pure helpers for the usage guard (unit tested).

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7); // 'YYYY-MM', UTC

/** First moment of the next calendar month, UTC. */
export function nextMonthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/**
 * Pure: compares usage with the guard settings.
 * blocked = scans and background figures must not start (or must pause).
 */
export function evaluateBudget(usage, guard) {
  const limit = Math.max(1, Number(guard?.sqlRequestLimit) || 100000);
  const stopPercent = Math.min(100, Math.max(1, Number(guard?.stopAtPercent) || 90));
  const stopAt = Math.floor((limit * stopPercent) / 100);
  const used = Number(usage?.sqlRequests) || 0;
  const enabled = guard?.enabled !== false;
  return {
    enabled,
    month: usage?.month,
    used,
    limit,
    stopAt,
    stopPercent,
    percent: Math.round((used / limit) * 1000) / 10,
    warn: enabled && used >= stopAt * 0.8,
    blocked: enabled && used >= stopAt,
    resetsAt: usage?.resetsAt || nextMonthStart().toISOString(),
    correctedAt: usage?.correctedAt || null,
  };
}

