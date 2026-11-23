// Server-side permission checks. The UI hides what a user may not do, but the
// resolvers never trust the UI: every call is checked here, as the user.

import { getCurrentUserOperations, getSpaceOperationsForUser } from './confluence.js';

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

/** True when the signed-in user administers the given space (or the site). */
export async function isSpaceAdmin(accountId, spaceKey) {
  if (!accountId || !spaceKey) return false;
  if (await isSiteAdmin(accountId)) return true;
  return cached(`space:${accountId}:${spaceKey}`, async () => {
    try {
      const space = await getSpaceOperationsForUser(spaceKey);
      return hasOp(space?.operations, 'administer', 'space');
    } catch {
      return false;
    }
  });
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
  if (!(await isSpaceAdmin(context.accountId, space.key))) {
    throw new ForbiddenError('Only space administrators can use storage cleanup for this space.');
  }
  return space;
}
