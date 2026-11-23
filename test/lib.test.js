import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileExtension, typeCategory, baseName } from '../src/backend/lib/files.js';
import { computeHealth, gradeFor, describeMonths } from '../src/backend/lib/health.js';
import { buildAttachmentWhere, sortClause, paging } from '../src/backend/lib/filters.js';
import { toCsv } from '../src/backend/lib/csv.js';
import { toSqlDate, fromSqlDate, ageBand, daysAgo } from '../src/backend/lib/time.js';
import { formatBytes, countOf } from '../src/shared/format.js';

const GB = 1024 ** 3;

test('file extensions and categories', () => {
  assert.equal(fileExtension('Report.Final.PDF'), 'pdf');
  assert.equal(fileExtension('.bashrc'), '');
  assert.equal(fileExtension('noext'), '');
  assert.equal(typeCategory('movie.MOV'), 'video');
  assert.equal(typeCategory('blob', 'image/png'), 'image');
  assert.equal(typeCategory('data.weird', 'application/x-zip-compressed'), 'archive');
  assert.equal(typeCategory('x.unknown', 'application/octet-stream'), 'other');
  assert.equal(baseName('a.b.png'), 'a.b');
});

test('health score is 100 for a tidy site and drops with problems', () => {
  const tidy = computeHealth({
    totalBytes: 50 * GB, quotaBytes: 250 * GB, reclaimableBytes: 1 * GB, trashBytes: 0,
    pageCount: 1000, stalePageCount: 100, growthBytes30d: 0,
  });
  assert.equal(tidy.score, 100);
  assert.equal(tidy.grade, 'A');

  const messy = computeHealth({
    totalBytes: 240 * GB, quotaBytes: 250 * GB, reclaimableBytes: 120 * GB, trashBytes: 50 * GB,
    pageCount: 1000, stalePageCount: 800, growthBytes30d: 5 * GB,
  });
  assert.ok(messy.score < 20, `expected low score, got ${messy.score}`);
  assert.equal(messy.components.length, 5);
  assert.ok(messy.monthsLeft > 1 && messy.monthsLeft < 3);
  assert.equal(gradeFor(59), 'D');
});

test('forecasts read naturally', () => {
  assert.equal(describeMonths(0.4), 'less than a month');
  assert.equal(describeMonths(1), 'about 1 month');
  assert.equal(describeMonths(7.2), 'about 7 months');
  assert.equal(describeMonths(40), 'about 3 years');
  assert.equal(describeMonths(4931), 'more than 10 years');
});

test('health score handles an empty site', () => {
  const empty = computeHealth({ totalBytes: 0, quotaBytes: 250 * GB, pageCount: 0 });
  assert.equal(empty.score, 100);
  assert.equal(empty.monthsLeft, null);
});

test('filter builder binds every user value as a parameter', () => {
  const now = new Date('2026-11-23T00:00:00Z');
  const { where, params } = buildAttachmentWhere(
    { finding: 'unused', q: "50%_off'; DROP TABLE x;--", category: 'image', minSizeMb: 5, spaceId: 'ignored' },
    { spaceId: '42', now, exemptSpaceIds: ['7'] },
  );
  assert.ok(!where.includes('DROP'), 'no user text in SQL');
  assert.ok(where.includes('a.space_id = ?'));
  assert.ok(where.includes('a.is_referenced = 0'));
  assert.equal(params[0], '42', 'forced space scope wins over the filter');
  assert.ok(params.includes("%50\\%\\_off'; DROP TABLE x;--%"));
  assert.ok(params.includes('image'));
  assert.ok(params.includes(5 * 1024 * 1024));
  assert.ok(params.includes('7'));
  assert.equal((where.match(/\?/g) || []).length, params.length, 'placeholder count matches params');
});

test('every finding produces balanced SQL', () => {
  for (const finding of ['all', 'unused', 'orphaned' /* removed: falls back to all */, 'duplicates', 'versions', 'stale', 'large', 'trash', 'bogus']) {
    const { where, params } = buildAttachmentWhere({ finding }, { exemptSpaceIds: ['1', '2'] });
    assert.equal((where.match(/\?/g) || []).length, params.length, finding);
  }
  assert.equal(sortClause('nope'), sortClause('size_desc'));
  assert.deepEqual(paging(2, 500), { limit: 100, offset: 200 });
  assert.deepEqual(paging(-1, 'x'), { limit: 50, offset: 0 });
});

test('csv escapes quotes, newlines and formula injection', () => {
  const csv = toCsv(
    [{ a: 'x,"y"', b: '=HYPERLINK("evil")', c: -5 }, { a: 'line\nbreak', b: null, c: 0 }],
    [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
  );
  assert.equal(csv, 'A,B,C\r\n"x,""y""","\'=HYPERLINK(""evil"")",-5\r\n"line\nbreak",,0\r\n');
});

test('date helpers round-trip and bucket ages', () => {
  assert.equal(toSqlDate('2026-03-04T05:06:07.890Z'), '2026-03-04 05:06:07');
  assert.equal(toSqlDate('garbage'), null);
  assert.equal(fromSqlDate('2026-03-04 05:06:07').toISOString(), '2026-03-04T05:06:07.000Z');
  const now = new Date('2026-11-23T00:00:00Z');
  assert.equal(ageBand(daysAgo(10, now), now), 'lt30');
  assert.equal(ageBand(daysAgo(60, now), now), '30to90');
  assert.equal(ageBand(daysAgo(200, now), now), '90to365');
  assert.equal(ageBand(daysAgo(400, now), now), 'gt365');
});

test('byte formatting', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(250 * GB), '250.0 GB');
  assert.equal(countOf(1, 'page'), '1 page');
  assert.equal(countOf(3, 'page'), '3 pages');
  assert.equal(countOf(1204, 'file'), '1,204 files');
});
