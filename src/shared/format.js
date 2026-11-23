// Formatting helpers shared by backend and UI. No platform imports here.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Human readable byte size, base 1024 (matches how Atlassian reports storage). */
export function formatBytes(bytes, digits = 1) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const value = n / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : digits)} ${UNITS[exp]}`;
}

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;

export function bytesToGb(bytes) {
  return Math.round(((Number(bytes) || 0) / GB) * 100) / 100;
}

export function formatPercent(fraction, digits = 1) {
  const f = Number(fraction) || 0;
  return `${(f * 100).toFixed(digits)}%`;
}

export function formatNumber(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

/** 'YYYY-MM-DD' from an ISO or SQL datetime string. */
export function formatDate(value) {
  if (!value) return '';
  const s = String(value);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export const REQUEST_STATUS_APPEARANCE = {
  pending: 'new',
  approved: 'inprogress',
  running: 'inprogress',
  done: 'success',
  partial: 'moved',
  failed: 'removed',
  rejected: 'removed',
  cancelled: 'default',
};

export const ACTION_LABELS = {
  trash_attachment: 'Move attachments to trash',
  purge_attachment: 'Purge attachments from trash',
  prune_versions: 'Delete old attachment versions',
  purge_page: 'Purge pages from trash',
};

/** Actions that cannot be undone. The UI warns harder and the audit log flags them. */
export const IRREVERSIBLE_ACTIONS = new Set(['purge_attachment', 'prune_versions', 'purge_page']);
