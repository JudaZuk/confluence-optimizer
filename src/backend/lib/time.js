// Date helpers. Forge SQL takes and returns DATETIME values as strings.

const pad = (n) => String(n).padStart(2, '0');

/** ISO 8601 (or Date) -> 'YYYY-MM-DD HH:MM:SS' in UTC, or null. */
export function toSqlDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** SQL datetime string for `days` days before `now`. */
export function daysAgo(days, now = new Date()) {
  return toSqlDate(new Date(now.getTime() - Number(days) * 86400000));
}

export function monthsAgo(months, now = new Date()) {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - Number(months));
  return toSqlDate(d);
}

/** Parses a SQL datetime string (UTC) back into a Date. */
export function fromSqlDate(value) {
  if (!value) return null;
  const s = String(value).replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const AGE_BANDS = [
  { key: 'lt30', label: 'Under 30 days', maxDays: 30 },
  { key: '30to90', label: '30–90 days', maxDays: 90 },
  { key: '90to365', label: '90–365 days', maxDays: 365 },
  { key: 'gt365', label: 'Over a year', maxDays: Infinity },
];

export function ageBand(date, now = new Date()) {
  const d = date instanceof Date ? date : fromSqlDate(date);
  if (!d) return AGE_BANDS[AGE_BANDS.length - 1].key;
  const days = (now.getTime() - d.getTime()) / 86400000;
  return AGE_BANDS.find((b) => days < b.maxDays).key;
}

/** SQL CASE expression that maps a datetime column to an age band key. */
export function ageBandSql(column) {
  return (
    `CASE WHEN ${column} IS NULL THEN 'gt365' ` +
    `WHEN ${column} >= ? THEN 'lt30' ` +
    `WHEN ${column} >= ? THEN '30to90' ` +
    `WHEN ${column} >= ? THEN '90to365' ELSE 'gt365' END`
  );
}

export function ageBandParams(now = new Date()) {
  return [daysAgo(30, now), daysAgo(90, now), daysAgo(365, now)];
}
