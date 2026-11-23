// Site health score. Pure and unit tested so the formula is transparent.
//
// The score starts at 100 and loses points in five areas. Each area has a
// maximum penalty, so one bad area cannot hide improvements elsewhere.

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

/** Linear ramp: 0 at or below `start`, 1 at or above `end`. */
function ramp(value, start, end) {
  if (end <= start) return value >= end ? 1 : 0;
  return clamp01((value - start) / (end - start));
}

export const HEALTH_WEIGHTS = {
  reclaimable: 35, // share of storage that could be reclaimed
  quota: 25, // how close the site is to its storage limit
  trash: 10, // share of storage sitting in the trash
  stale: 15, // share of pages not edited for the stale threshold
  growth: 15, // months until the limit is reached at the current growth rate
};

/**
 * @param {object} m
 * @param {number} m.totalBytes        indexed storage incl. estimated old versions and trash
 * @param {number} m.quotaBytes        storage limit of the site (e.g. 250 GB on Standard)
 * @param {number} m.reclaimableBytes  trash + old versions + orphaned + unused + duplicate copies (deduplicated)
 * @param {number} m.trashBytes
 * @param {number} m.pageCount
 * @param {number} m.stalePageCount
 * @param {number} m.growthBytes30d    bytes added during the last 30 days
 */
export function computeHealth(m) {
  const total = Math.max(0, Number(m.totalBytes) || 0);
  const quota = Math.max(1, Number(m.quotaBytes) || 1);
  const reclaimShare = total > 0 ? clamp01((Number(m.reclaimableBytes) || 0) / total) : 0;
  const trashShare = total > 0 ? clamp01((Number(m.trashBytes) || 0) / total) : 0;
  const usage = total / quota;
  const staleShare = m.pageCount > 0 ? clamp01((Number(m.stalePageCount) || 0) / m.pageCount) : 0;
  const growthPerMonth = Math.max(0, Number(m.growthBytes30d) || 0);
  const headroom = Math.max(0, quota - total);
  const monthsLeft = growthPerMonth > 0 ? headroom / growthPerMonth : Infinity;

  const components = [
    {
      key: 'reclaimable',
      label: 'Reclaimable storage',
      detail: `${(reclaimShare * 100).toFixed(1)}% of storage could be freed`,
      penalty: HEALTH_WEIGHTS.reclaimable * ramp(reclaimShare, 0.05, 0.4),
    },
    {
      key: 'quota',
      label: 'Storage limit',
      detail: `${(usage * 100).toFixed(1)}% of the storage limit used`,
      penalty: HEALTH_WEIGHTS.quota * ramp(usage, 0.6, 1.0),
    },
    {
      key: 'trash',
      label: 'Trash',
      detail: `${(trashShare * 100).toFixed(1)}% of storage is in the trash`,
      penalty: HEALTH_WEIGHTS.trash * ramp(trashShare, 0.02, 0.2),
    },
    {
      key: 'stale',
      label: 'Stale content',
      detail: `${(staleShare * 100).toFixed(1)}% of pages are stale`,
      penalty: HEALTH_WEIGHTS.stale * ramp(staleShare, 0.2, 0.7),
    },
    {
      key: 'growth',
      label: 'Growth',
      detail: Number.isFinite(monthsLeft)
        ? `Limit reached in about ${monthsLeft < 1 ? 'less than a month' : `${Math.round(monthsLeft)} months`} at the current rate`
        : 'No measurable growth in the last 30 days',
      // Full penalty when the limit is less than 3 months away, none beyond 24 months.
      penalty: Number.isFinite(monthsLeft) ? HEALTH_WEIGHTS.growth * (1 - ramp(monthsLeft, 3, 24)) : 0,
    },
  ].map((c) => ({ ...c, penalty: Math.round(c.penalty * 10) / 10 }));

  const score = Math.max(0, Math.min(100, Math.round(100 - components.reduce((s, c) => s + c.penalty, 0))));
  return { score, grade: gradeFor(score), components, monthsLeft: Number.isFinite(monthsLeft) ? monthsLeft : null };
}

export function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}
