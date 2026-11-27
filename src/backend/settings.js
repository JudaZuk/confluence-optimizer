// App settings and small state documents, kept in the Forge key-value store.

import { kvs } from '@forge/kvs';
import { DEFAULT_RULES } from './lib/filters.js';

export const DEFAULT_SETTINGS = {
  storageQuotaGb: 250, // Confluence Cloud Standard limit
  ...DEFAULT_RULES, // staleMonths, unusedMinAgeDays, keepVersions, largeFileMb
  exemptSpaceKeys: [], // never suggested for cleanup
  scanBodies: true, // read page bodies to detect unused attachments
  scanIntervalDays: 30, // automatic rescan interval, 0 = manual only (monthly keeps large sites within the free allowance)
  allowSpaceAdminRequests: true, // space admins may queue cleanup for their space
  usageGuard: {
    enabled: true, // stop scans before the Forge free allowance is used up
    sqlRequestLimit: 100000, // Forge SQL requests included free per month
    stopAtPercent: 90, // no new scans or background figures from this point
  },
  retention: {
    purgeTrashAfterDays: 0, // 0 = off. Proposes a purge of items seen in trash longer than this
    pruneVersionsKeep: 0, // 0 = off. Proposes deleting versions beyond the newest N
    trashUnusedAfterDays: 0, // 0 = off. Proposes trashing unused attachments older than this
  },
};

const clampInt = (v, min, max, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

/** Validates and normalises settings coming from the UI. */
export function sanitizeSettings(input = {}) {
  const d = DEFAULT_SETTINGS;
  const r = input.retention || {};
  return {
    storageQuotaGb: clampInt(input.storageQuotaGb, 1, 1000000, d.storageQuotaGb),
    staleMonths: clampInt(input.staleMonths, 1, 240, d.staleMonths),
    unusedMinAgeDays: clampInt(input.unusedMinAgeDays, 0, 3650, d.unusedMinAgeDays),
    keepVersions: clampInt(input.keepVersions, 1, 1000, d.keepVersions),
    largeFileMb: clampInt(input.largeFileMb, 1, 100000, d.largeFileMb),
    exemptSpaceKeys: (Array.isArray(input.exemptSpaceKeys) ? input.exemptSpaceKeys : String(input.exemptSpaceKeys || '').split(','))
      .map((k) => String(k).trim())
      .filter((k) => /^[~A-Za-z0-9_-]{1,255}$/.test(k))
      .slice(0, 500),
    scanBodies: input.scanBodies !== false,
    scanIntervalDays: clampInt(input.scanIntervalDays, 0, 365, d.scanIntervalDays),
    allowSpaceAdminRequests: input.allowSpaceAdminRequests !== false,
    usageGuard: {
      enabled: (input.usageGuard || {}).enabled !== false,
      sqlRequestLimit: clampInt((input.usageGuard || {}).sqlRequestLimit, 1000, 100000000, d.usageGuard.sqlRequestLimit),
      stopAtPercent: clampInt((input.usageGuard || {}).stopAtPercent, 10, 100, d.usageGuard.stopAtPercent),
    },
    retention: {
      purgeTrashAfterDays: clampInt(r.purgeTrashAfterDays, 0, 3650, 0),
      pruneVersionsKeep: clampInt(r.pruneVersionsKeep, 0, 1000, 0),
      trashUnusedAfterDays: clampInt(r.trashUnusedAfterDays, 0, 3650, 0),
    },
  };
}

export async function getSettings() {
  const stored = (await kvs.get('settings')) || {};
  return sanitizeSettings({
    ...DEFAULT_SETTINGS,
    ...stored,
    retention: { ...DEFAULT_SETTINGS.retention, ...(stored.retention || {}) },
    usageGuard: { ...DEFAULT_SETTINGS.usageGuard, ...(stored.usageGuard || {}) },
  });
}

export async function saveSettings(input) {
  const clean = sanitizeSettings(input);
  await kvs.set('settings', clean);
  return clean;
}

export const getState = async (key, fallback = null) => (await kvs.get(key)) ?? fallback;
export const setState = (key, value) => kvs.set(key, value);
export const deleteState = (key) => kvs.delete(key);
