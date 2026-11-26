// Confluence REST client for Forge with rate-limit handling.
//
// asApp()  - used by background scans and by approved cleanup jobs.
// asUser() - used for permission checks on behalf of the signed-in user.

import api, { route } from '@forge/api';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Confluence's per-app API quota is used up for now. Callers should pause and
 * try again after `retryAfterSec` instead of treating it as a failure.
 */
export class RateLimitError extends Error {
  constructor(retryAfterSec) {
    super(`Confluence API limit for apps reached; retry in ${retryAfterSec} s`);
    this.rateLimited = true;
    this.retryAfterSec = retryAfterSec;
    this.status = 429;
  }
}

// Waits up to this long inside a function; longer waits pause the job instead.
const MAX_INLINE_WAIT_MS = 30000;

export class ConfluenceError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(principal, path, options = {}) {
  const requester = principal === 'user' ? api.asUser() : api.asApp();
  for (let attempt = 0; ; attempt += 1) {
    const res = await requester.requestConfluence(path, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      // Points-based hourly quotas can ask for long waits: hand those back to
      // the job so it pauses (without failing) instead of sleeping here.
      if (res.status === 429 && (wait > MAX_INLINE_WAIT_MS || attempt >= 4)) {
        throw new RateLimitError(Math.max(60, Math.ceil(wait / 1000)));
      }
      if (attempt < 5) {
        await sleep(wait + Math.floor(Math.random() * 250));
        continue;
      }
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const msg = body?.errors?.[0]?.title || body?.message || `HTTP ${res.status}`;
      throw new ConfluenceError(res.status, msg, body);
    }
    return body;
  }
}

/** Extracts the opaque cursor from a v2 `_links.next` value. */
export function nextCursor(body) {
  const next = body?._links?.next;
  if (!next) return null;
  const match = /[?&]cursor=([^&]+)/.exec(next);
  return match ? decodeURIComponent(match[1]) : null;
}

// ------------------------------------------------------------------ v2 reads

export function getSpaces(cursor, status) {
  const q = new URLSearchParams({ limit: '250' });
  if (status) q.set('status', status);
  if (cursor) q.set('cursor', cursor);
  return request('app', route`/wiki/api/v2/spaces?${q}`);
}

/** Site-wide attachment listing, all statuses. 250 per call. */
export function getAttachments(cursor) {
  const q = new URLSearchParams({ limit: '250', status: 'current,archived,trashed' });
  if (cursor) q.set('cursor', cursor);
  return request('app', route`/wiki/api/v2/attachments?${q}`);
}

export function getAttachment(id) {
  const q = new URLSearchParams({ 'include-version': 'true' });
  return request('app', route`/wiki/api/v2/attachments/${id}?${q}`);
}

/** Pages or blog posts of a space. With `body`, the storage format body is included. */
export function getSpaceContent(kind, spaceId, { cursor, statuses, body, limit }) {
  const q = new URLSearchParams({ limit: String(limit || (body ? 50 : 250)), status: statuses.join(',') });
  if (body) q.set('body-format', 'storage');
  if (cursor) q.set('cursor', cursor);
  return kind === 'blogpost'
    ? request('app', route`/wiki/api/v2/spaces/${spaceId}/blogposts?${q}`)
    : request('app', route`/wiki/api/v2/spaces/${spaceId}/pages?${q}`);
}

// ------------------------------------------------------------------ v2/v1 writes (approved jobs only)

/** Moves an attachment to the space trash (reversible from the trash). */
export function trashAttachment(id) {
  return request('app', route`/wiki/api/v2/attachments/${id}`, { method: 'DELETE' });
}

/** Permanently deletes a trashed attachment. Cannot be undone. */
export function purgeAttachment(id) {
  const q = new URLSearchParams({ purge: 'true' });
  return request('app', route`/wiki/api/v2/attachments/${id}?${q}`, { method: 'DELETE' });
}

/** Permanently deletes a trashed page or blog post. Cannot be undone. */
export function purgeContent(kind, id) {
  const q = new URLSearchParams({ purge: 'true' });
  return kind === 'blogpost'
    ? request('app', route`/wiki/api/v2/blogposts/${id}?${q}`, { method: 'DELETE' })
    : request('app', route`/wiki/api/v2/pages/${id}?${q}`, { method: 'DELETE' });
}

/**
 * Deletes one historical version (REST v1). Later versions are renumbered,
 * so callers delete version 1 repeatedly to drop the oldest versions.
 */
export function deleteContentVersion(id, versionNumber) {
  return request('app', route`/wiki/rest/api/content/${id}/version/${String(versionNumber)}`, { method: 'DELETE' });
}

// ------------------------------------------------------------------ permission checks (as the user)

export function getCurrentUserOperations() {
  const q = new URLSearchParams({ expand: 'operations' });
  return request('user', route`/wiki/rest/api/user/current?${q}`);
}

/** REST v2: operations the signed-in user may perform on a space. */
export function getSpacePermittedOperations(spaceId) {
  return request('user', route`/wiki/api/v2/spaces/${spaceId}/operations`);
}

/** REST v1 fallback: the space with the user's operations expanded. */
export function getSpaceOperationsForUser(spaceKey) {
  const q = new URLSearchParams({ expand: 'operations' });
  return request('user', route`/wiki/rest/api/space/${spaceKey}?${q}`);
}
