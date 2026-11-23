// Server-side permission checks. The UI hides what a user may not do, but the
// resolvers never trust the UI: every call is checked here, as the user.

import { queryOne } from './db/sql.js';
import { getCurrentUserOperations, getSpaceOperationsForUser, getSpacePermittedOperations } from './confluence.js';

export class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.forbidden = true;
  }
}

// Small per-instance cache; Forge reuses warm function instances.
const cache = new Map();
const TTL_MS = 60 * 1000;

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + TTL_MS });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

const hasOp = (ops, operation, targetType) =>
  Array.isArray(ops) && ops.some((o) => o?.operation === operation && o?.targetType === targetType);

/** True when the signed-in user is a Confluence administrator. */
export async function isSiteAdmin(accountId) {
  if (!accountId) return false;
  return cached(`site:${accountId}`, async () => {
    try {
      const user = await getCurrentUserOperations();
      return hasOp(user?.operations, 'administer', 'application');
    } catch {
      return false;
    }
  });
}

/**
 * True when the signed-in user administers the given space (or the site).
 * Asks Confluence as the user: REST v2 permitted operations first, REST v1 as a
 * fallback. The outcome is logged (without personal data) to help diagnose
 * permission problems with `forge logs`.
 */
export async function isSpaceAdmin(accountId, spaceKey, spaceId) {
  if (!accountId || !spaceKey) return false;
  if (await isSiteAdmin(accountId)) return true;
  return cached(`space:${accountId}:${spaceKey}`, async () => {
    const attempts = [];
    if (spaceId) {
      try {
        const res = await getSpacePermittedOperations(spaceId);
        const ops = res?.operations || res?.results || [];
        attempts.push(`v2: ${ops.map((o) => `${o.operation}/${o.targetType}`).join(',') || 'none'}`);
        if (hasOp(ops, 'administer', 'space')) return true;
      } catch (err) {
        attempts.push(`v2 failed: ${err.status || ''} ${err.message}`);
      }
    }
    try {
      const space = await getSpaceOperationsForUser(spaceKey);
      const ops = space?.operations || [];
      attempts.push(`v1: ${ops.map((o) => `${o.operation}/${o.targetType}`).join(',') || 'none'}`);
      if (hasOp(ops, 'administer', 'space')) return true;
    } catch (err) {
      attempts.push(`v1 failed: ${err.status || ''} ${err.message}`);
    }
    console.warn(`space admin check denied for space ${spaceKey}: ${attempts.join(' | ')}`);
    return false;
  });
}

async function spaceIdForKey(spaceKey) {
  try {
    const row = await queryOne('SELECT id FROM spaces WHERE space_key = ?', [spaceKey]);
    return row ? String(row.id) : null;
  } catch {
    return null;
  }
}

export async function requireSiteAdmin(context) {
  if (!(await isSiteAdmin(context?.accountId))) {
    throw new ForbiddenError('Only Confluence administrators can use this page.');
  }
}

/** Returns the space from the module context after checking the user administers it. */
export async function requireSpaceAdmin(context) {
  const space = context?.extension?.space;
  if (!space?.key) throw new ForbiddenError('No space in context.');
  if (!(await isSpaceAdmin(context.accountId, space.key, space.id ? String(space.id) : await spaceIdForKey(space.key)))) {
    throw new ForbiddenError('Only space administrators can use storage cleanup for this space.');
  }
  return space;
}
