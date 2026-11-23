import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReferences, isAttachmentReferenced, decodeEntities } from '../src/backend/lib/refs.js';

test('decodes named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#246; &#x00E9;'), 'a & b <c> ö é');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('finds same-page image and file references', () => {
  const body =
    '<p><ac:image><ri:attachment ri:filename="diagram one.png" ri:version-at-save="2" /></ac:image></p>' +
    '<ac:structured-macro ac:name="view-file"><ac:parameter ac:name="name">' +
    '<ri:attachment ri:filename="R&amp;D plan.pdf" /></ac:parameter></ac:structured-macro>';
  const refs = extractReferences(body);
  assert.ok(refs.ownFilenames.has('diagram one.png'));
  assert.ok(refs.ownFilenames.has('R&D plan.pdf'));
  assert.equal(refs.crossRefs.length, 0);
  assert.equal(refs.listsAllAttachments, false);
  assert.ok(isAttachmentReferenced('R&D plan.pdf', refs));
  assert.equal(isAttachmentReferenced('unused.zip', refs), false);
});

test('records references to attachments on other pages and blog posts', () => {
  const body =
    '<ac:link><ri:attachment ri:filename="budget.xlsx"><ri:page ri:space-key="FIN" ri:content-title="Budget 2026" />' +
    '</ri:attachment></ac:link>' +
    '<ac:image><ri:attachment ri:filename="hero.jpg"><ri:blog-post ri:content-title="Launch" ri:posting-day="2026/01/02" />' +
    '</ri:attachment></ac:image>' +
    '<ac:image><ri:attachment ri:filename="x.png"><ri:content-entity ri:content-id="12345" /></ri:attachment></ac:image>';
  const refs = extractReferences(body);
  assert.deepEqual(refs.crossRefs, [
    { filename: 'budget.xlsx', kind: 'page', title: 'Budget 2026', spaceKey: 'FIN' },
    { filename: 'hero.jpg', kind: 'blogpost', title: 'Launch', spaceKey: null },
    { filename: 'x.png', kind: 'id', contentId: '12345' },
  ]);
  assert.equal(refs.ownFilenames.size, 0);
});

test('attachments and gallery macros count as using every file', () => {
  assert.equal(extractReferences('<ac:structured-macro ac:name="attachments" ac:schema-version="1" />').listsAllAttachments, true);
  const gallery = extractReferences(
    '<ac:structured-macro ac:name="gallery"><ac:parameter ac:name="columns">3</ac:parameter></ac:structured-macro>',
  );
  assert.equal(gallery.listsAllAttachments, true);
  assert.ok(isAttachmentReferenced('anything.png', gallery));
});

test('attachments macro pointing at another page creates a wildcard cross reference', () => {
  const refs = extractReferences(
    '<ac:structured-macro ac:name="attachments"><ac:parameter ac:name="page">' +
      '<ac:link><ri:page ri:content-title="Shared files" /></ac:link></ac:parameter></ac:structured-macro>',
  );
  assert.equal(refs.listsAllAttachments, false);
  assert.deepEqual(refs.crossRefs, [{ filename: '*', kind: 'page', title: 'Shared files', spaceKey: null }]);
});

test('loose matching protects files used by third-party macros (draw.io style)', () => {
  const refs = extractReferences(
    '<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">Network Overview</ac:parameter></ac:structured-macro>',
  );
  assert.ok(isAttachmentReferenced('Network Overview', refs));
  assert.ok(isAttachmentReferenced('Network Overview.png', refs));
  assert.equal(isAttachmentReferenced('abc.png', refs), false, 'short base names are not matched loosely');
});
