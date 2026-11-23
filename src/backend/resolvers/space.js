// Resolver for the space view (confluence:spaceSettings). The space always
// comes from the module context and the caller must administer that space.
// Space admins can look and request; only Confluence administrators approve.

import Resolver from '@forge/resolver';
import { queryOne } from '../db/sql.js';
import { requireSpaceAdmin } from '../auth.js';
import { commonHandlers, safe } from './common.js';

const resolver = new Resolver();

async function spaceScope(context) {
  const space = await requireSpaceAdmin(context);
  let spaceId = space.id ? String(space.id) : null;
  if (!spaceId) {
    const row = await queryOne('SELECT id FROM spaces WHERE space_key = ?', [space.key]);
    spaceId = row ? String(row.id) : '__unknown__';
  }
  return { isAdmin: false, spaceId, spaceKey: space.key, accountId: context.accountId };
}

for (const [name, fn] of Object.entries(commonHandlers(spaceScope))) resolver.define(name, safe(fn));

export const spaceResolver = resolver.getDefinitions();
