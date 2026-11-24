// End-to-end smoke test of the backend with in-memory stand-ins for Forge
// (see test/support). It runs a full scan against a fake Confluence site,
// then creates, approves and executes a cleanup request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createFakeDb } from './support/fake-db.js';

register('./support/forge-stub-loader.js', import.meta.url);
const forge = (await import('./support/stubs/state.js')).default;
const app = await import('../src/index.js');

const db = createFakeDb();
forge.sql = (q, p) => db.handle(q, p);

let currentUser = 'admin-1';
const BASE = 'https://example.atlassian.net/wiki';
const att = (id, title, pageId, extra = {}) => ({
  id, title, pageId, status: 'current', mediaType: 'application/pdf', fileSize: 1000,
  createdAt: '2024-01-01T00:00:00.000Z', version: { number: 2, createdAt: '2024-02-01T00:00:00.000Z', authorId: 'u9' },
  webuiLink: `/pages/viewpageattachments.action?pageId=${pageId}`, downloadLink: `/download/attachments/${pageId}/${title}`,
  ...extra,
});

const site = {
  spaces: [{ id: '100', key: 'ENG', name: 'Engineering', type: 'global', status: 'current' }],
  attachmentsPage1: [
    att('att1', 'used.png', '1', { mediaType: 'image/png' }),
    att('att2', 'unused.zip', '1', { mediaType: 'application/zip', fileSize: 5_000_000 }),
    att('att3', 'shared.pdf', '2'),
    att('att4', 'old.pdf', '1', { status: 'trashed' }),
  ],
  attachmentsPage2: [att('att5', 'lost.docx', '999'), att('att6', 'used.png', '2', { mediaType: 'image/png' })],
  pages: [
    {
      id: '1', title: 'One', spaceId: '100', status: 'current', createdAt: '2020-01-01T00:00:00Z',
      version: { number: 4, createdAt: '2021-01-01T00:00:00Z', authorId: 'u1' },
      body: {
        storage: {
          value:
            '<p><ac:image><ri:attachment ri:filename="used.png" /></ac:image></p>' +
            '<ac:link><ri:attachment ri:filename="shared.pdf"><ri:page ri:content-title="Two" /></ri:attachment></ac:link>',
        },
      },
    },
    {
      id: '2', title: 'Two', spaceId: '100', status: 'current', createdAt: '2020-01-01T00:00:00Z',
      version: { number: 1, createdAt: '2020-01-01T00:00:00Z', authorId: 'u1' }, body: { storage: { value: '<p>hi</p>' } },
    },
  ],
};

forge.confluence = async (path, options) => {
  const method = options.method || 'GET';
  const url = new URL(`https://x${path}`);
  const p = url.pathname;
  if (p === '/wiki/rest/api/user/current') {
    return { status: 200, body: { operations: currentUser.startsWith('admin') ? [{ operation: 'administer', targetType: 'application' }] : [] } };
  }
  if (p === '/wiki/api/v2/spaces/100/operations') {
    return { status: 200, body: { operations: currentUser === 'spaceadmin-2' ? [{ operation: 'administer', targetType: 'space' }] : [{ operation: 'read', targetType: 'space' }] } };
  }
  if (p === '/wiki/rest/api/space/ENG') {
    return { status: 200, body: { operations: currentUser === 'spaceadmin-1' ? [{ operation: 'administer', targetType: 'space' }] : [] } };
  }
  if (p === '/wiki/api/v2/spaces') {
    const archived = url.searchParams.get('status') === 'archived';
    return { status: 200, body: { results: archived ? [] : [...site.spaces, ...(site.extraSpaces || [])], _links: { base: BASE } } };
  }
  if (p === '/wiki/api/v2/attachments') {
    assert.equal(url.searchParams.get('status'), 'current,archived,trashed');
    if (url.searchParams.get('cursor') === 'abc') return { status: 200, body: { results: site.attachmentsPage2, _links: { base: BASE } } };
    return { status: 200, body: { results: site.attachmentsPage1, _links: { next: '/wiki/api/v2/attachments?cursor=abc&limit=250', base: BASE } } };
  }
  if (p === '/wiki/api/v2/spaces/100/pages') {
    const statuses = url.searchParams.get('status');
    if (statuses.includes('trashed')) return { status: 200, body: { results: [] } };
    assert.equal(url.searchParams.get('body-format'), 'storage');
    return { status: 200, body: { results: site.pages } };
  }
  if (p === '/wiki/api/v2/spaces/100/blogposts') return { status: 200, body: { results: [] } };
  if (p === '/wiki/api/v2/spaces/200/pages' || p === '/wiki/api/v2/spaces/200/blogposts') {
    return { status: 200, body: { results: [{ id: '201', title: 'Bad', spaceId: '200', status: 'current', body: { storage: { value: '' } } }] } };
  }
  if (p === '/wiki/api/v2/attachments/att2' && method === 'GET') {
    return { status: 200, body: { ...site.attachmentsPage1[1] } };
  }
  if (p === '/wiki/api/v2/attachments/att2' && method === 'DELETE') return { status: 204 };
  return { status: 404, body: { message: `unexpected ${method} ${p}` } };
};

const call = (resolver, functionKey, payload = {}, context = {}) =>
  resolver({ call: { functionKey }, payload, context: { accountId: currentUser, ...context } });

async function drain(queue, worker) {
  for (let guard = 0; guard < 50; guard += 1) {
    const idx = forge.pushed.findIndex((e) => e.queue === queue);
    if (idx < 0) return;
    const [event] = forge.pushed.splice(idx, 1);
    await worker(event);
  }
  throw new Error(`queue ${queue} did not drain`);
}

test('database is set up on install', async () => {
  await app.lifecycle();
  await drain('coam-migrate', app.migrateWorker);
  assert.ok(forge.kv.get('schema'), 'schema version stored');
});

test('non-admins are refused by the admin console', async () => {
  currentUser = 'user-1';
  const res = await call(app.adminResolver, 'startScan');
  assert.equal(res.forbidden, true);
  currentUser = 'admin-1';
});

test('a full scan indexes the site and analyses references', async () => {
  const started = await call(app.adminResolver, 'startScan');
  assert.equal(started.status, 'running');
  await drain('coam-scan', app.scanWorker);

  const state = forge.kv.get('scan:state');
  assert.equal(state.status, 'done', JSON.stringify(state));
  assert.equal(state.counters.attachments, 6);
  assert.equal(state.counters.pages, 2);

  const atts = db.table('attachments');
  assert.equal(atts.get('att1').is_referenced, 1, 'image shown on its page is used');
  assert.equal(atts.get('att2').is_referenced, 0, 'zip not referenced anywhere is unused');
  assert.equal(atts.get('att1').type_category, 'image');
  assert.ok(atts.get('att4').trashed_seen_at, 'trashed attachment gets a first-seen time');
  assert.equal(atts.get('att1').space_id, '100', 'space copied from the page');
  assert.equal(atts.get('att1').container_status, 'current', 'page status copied to the file');
  assert.equal(atts.get('att6').dup_count, 2, 'same name and size on two pages');
  assert.equal(atts.get('att1').dup_keep, 1, 'lowest id is the copy kept');
  assert.equal(atts.get('att6').dup_keep, 0, 'the other copy is an extra');
  const sqlText = forge.sqlLog.map((l) => l.query).join('\n');
  assert.ok(!/attachments a\s+LEFT JOIN contents/i.test(sqlText), 'no attachment-wide join with pages');
  assert.ok(!/GROUP BY d?\.?dup_key/i.test(sqlText), 'no GROUP BY over all duplicate keys');

  const refs = [...db.table('attachment_refs').values()];
  assert.equal(refs.length, 1);
  assert.equal(refs[0].target_title, 'Two');
  assert.equal(refs[0].target_space_key, 'ENG', 'missing space key defaults to the source space');

  assert.equal(forge.kv.get('baseUrl'), BASE);
  assert.ok(forge.kv.get('summary'), 'summary snapshot stored');
  const events = [...db.table('audit_log').values()].map((r) => r.event);
  assert.ok(events.includes('scan.started') && events.includes('scan.finished'));
});

test('a request is created, approved and executed with an audit trail', async () => {
  const created = await call(app.adminResolver, 'createRequest', {
    action: 'trash_attachment', selection: { ids: ['att2', 'att4'] }, note: 'cleanup',
  });
  assert.equal(created.error, undefined, created.error);
  assert.equal(created.itemCount, 1, 'trashed att4 is filtered out for a trash action');

  const decided = await call(app.adminResolver, 'decideRequest', { id: created.id, approve: true });
  assert.equal(decided.status, 'approved');
  await drain('coam-exec', app.execWorker);

  const req = db.table('requests').get(created.id);
  assert.equal(req.status, 'done');
  assert.equal(db.table('attachments').get('att2').status, 'trashed');
  const deletes = forge.confluenceLog.filter((c) => c.method === 'DELETE');
  assert.deepEqual(deletes.map((d) => d.path), ['/wiki/api/v2/attachments/att2']);
  assert.ok(deletes.every((d) => d.principal === 'app'));

  const events = [...db.table('audit_log').values()].map((r) => r.event);
  for (const e of ['request.created', 'request.approved', 'attachment.trashed', 'request.finished']) {
    assert.ok(events.includes(e), `audit has ${e}`);
  }
});

test('dashboard figures are served from cache and recalculated in the background', async () => {
  currentUser = 'admin-1';
  // A cleanup job finished in the previous test, so the cached figures are stale.
  const first = await call(app.adminResolver, 'getSummary');
  assert.ok(first.totals, 'cached figures are returned at once');
  assert.equal(first.refreshing, true);
  assert.ok(forge.pushed.some((e) => e.queue === 'coam-scan' && e.body.summary === 'site'), 'recalculation queued');
  await drain('coam-scan', app.scanWorker);
  const second = await call(app.adminResolver, 'getSummary');
  assert.equal(second.refreshing, false);

  currentUser = 'spaceadmin-1';
  const ctx = { extension: { space: { key: 'ENG', id: '100' } } };
  const pending = await call(app.spaceResolver, 'getSpaceSummary', {}, ctx);
  assert.equal(pending.pending, true, 'no cached space figures yet');
  await drain('coam-scan', app.scanWorker);
  const ready = await call(app.spaceResolver, 'getSpaceSummary', {}, ctx);
  assert.ok(ready.totals);
  assert.equal(ready.refreshing, false);
  currentUser = 'admin-1';
});

test('a request cannot be approved twice', async () => {
  const created = await call(app.adminResolver, 'createRequest', { action: 'trash_attachment', selection: { ids: ['att1'] } });
  await call(app.adminResolver, 'decideRequest', { id: created.id, approve: false });
  const again = await call(app.adminResolver, 'decideRequest', { id: created.id, approve: true });
  assert.match(again.error, /already rejected/);
});

test('space admins are scoped to their space and cannot approve', async () => {
  currentUser = 'spaceadmin-1';
  const ctx = { extension: { space: { key: 'ENG', id: '100' } } };
  const status = await call(app.spaceResolver, 'getStatus', {}, ctx);
  assert.equal(status.scope.spaceKey, 'ENG');
  assert.equal(status.scope.isAdmin, false);
  const list = await call(app.spaceResolver, 'listAttachments', { filters: { spaceId: '999' } }, ctx);
  assert.equal(list.error, undefined);
  const lastSelect = forge.sqlLog.filter((l) => l.query.includes('FROM attachments a')).at(-1);
  assert.equal(lastSelect.params[0], '100', 'space scope comes from context, not from the payload');
  assert.equal(app.spaceResolver.defs.decideRequest, undefined, 'no approve endpoint in the space resolver');

  currentUser = 'spaceadmin-2'; // only the v2 permitted-operations endpoint reports admin
  const viaV2 = await call(app.spaceResolver, 'getStatus', {}, ctx);
  assert.equal(viaV2.error, undefined, viaV2.error);

  currentUser = 'user-2';
  const denied = await call(app.spaceResolver, 'getStatus', {}, ctx);
  assert.equal(denied.forbidden, true);
});

test('a space whose content keeps failing is skipped with the real SQL reason, and the scan finishes', async () => {
  currentUser = 'admin-1';
  site.extraSpaces = [{ id: '200', key: 'BAD', name: 'Broken', type: 'global', status: 'current' }];
  const realSql = forge.sql;
  forge.sql = async (q, p) => {
    if (q.startsWith('INSERT INTO contents') && p.includes('201')) {
      const err = new Error('Unknown SQL execution error');
      err.code = 'SQL_EXECUTION_ERROR';
      err.context = { debug: { code: 'ER_DATA_TOO_LONG', message: "Data too long for column 'title' at row 1" } };
      throw err;
    }
    return realSql(q, p);
  };
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realTimeout(fn, 0); // skip retry back-off in the test
  try {
    await call(app.adminResolver, 'startScan');
    await drain('coam-scan', app.scanWorker);
  } finally {
    globalThis.setTimeout = realTimeout;
    forge.sql = realSql;
    site.extraSpaces = [];
  }
  const state = forge.kv.get('scan:state');
  assert.equal(state.status, 'done', JSON.stringify(state).slice(0, 500));
  assert.equal(state.counters.skippedSpaces, 1);
  assert.equal(state.skipped[0].space, 'BAD');
  assert.match(state.skipped[0].error, /ER_DATA_TOO_LONG: Data too long/);
});
