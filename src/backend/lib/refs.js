// Attachment reference analysis for Confluence storage format (XHTML).
//
// Goal: decide whether an attachment is still used by its page, or by another page.
// We err on the side of "referenced": a false "unused" could get a needed file
// trashed, a false "used" only means a file is not suggested for cleanup.

import { baseName } from './files.js';

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  if (!text) return '';
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    const v = ENTITY_MAP[code.toLowerCase()];
    return v === undefined ? match : v;
  });
}

function parseAttrs(fragment) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(fragment)) !== null) attrs[m[1]] = decodeEntities(m[2]);
  return attrs;
}

/** Reads the first <ri:page>, <ri:blog-post> or <ri:content-entity> target inside a fragment. */
function parseTarget(fragment) {
  if (!fragment) return null;
  const page = /<ri:page\b([^>]*)\/?>/.exec(fragment);
  if (page) {
    const a = parseAttrs(page[1]);
    if (a['ri:content-title']) return { kind: 'page', title: a['ri:content-title'], spaceKey: a['ri:space-key'] || null };
  }
  const blog = /<ri:blog-post\b([^>]*)\/?>/.exec(fragment);
  if (blog) {
    const a = parseAttrs(blog[1]);
    if (a['ri:content-title']) return { kind: 'blogpost', title: a['ri:content-title'], spaceKey: a['ri:space-key'] || null };
  }
  const entity = /<ri:content-entity\b([^>]*)\/?>/.exec(fragment);
  if (entity) {
    const a = parseAttrs(entity[1]);
    if (a['ri:content-id']) return { kind: 'id', contentId: a['ri:content-id'] };
  }
  return null;
}

// Macros that show every attachment of a page (theirs or another page's).
const LIST_ALL_MACROS = new Set(['attachments', 'gallery']);

/**
 * Extracts attachment references from a storage-format body.
 *
 * @returns {{
 *   ownFilenames: Set<string>,      // files referenced on the same page
 *   crossRefs: Array<{filename: string, kind: string, title?: string, spaceKey?: string|null, contentId?: string}>,
 *   listsAllAttachments: boolean,   // an attachments/gallery macro lists this page's files
 *   text: string                    // decoded, lower-cased body for loose matching
 * }}
 * filename '*' in crossRefs means "all attachments of the target".
 */
export function extractReferences(storageBody) {
  const body = String(storageBody || '');
  const ownFilenames = new Set();
  const crossRefs = [];
  let listsAllAttachments = false;

  const attRe = /<ri:attachment\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ri:attachment>)/g;
  let m;
  while ((m = attRe.exec(body)) !== null) {
    const attrs = parseAttrs(m[1]);
    const filename = attrs['ri:filename'];
    if (!filename) continue;
    const target = parseTarget(m[2]);
    if (target) crossRefs.push({ filename, ...target });
    else ownFilenames.add(filename);
  }

  const macroRe = /<ac:structured-macro\b([^>]*)>([\s\S]*?)<\/ac:structured-macro>/g;
  while ((m = macroRe.exec(body)) !== null) {
    const name = (parseAttrs(m[1])['ac:name'] || '').toLowerCase();
    if (!LIST_ALL_MACROS.has(name)) continue;
    const inner = m[2];
    const pageParam = /<ac:parameter\b[^>]*ac:name="page"[^>]*>([\s\S]*?)<\/ac:parameter>/.exec(inner);
    const target = pageParam ? parseTarget(pageParam[1]) : null;
    if (target) {
      crossRefs.push({ filename: '*', ...target });
    } else if (pageParam && decodeEntities(pageParam[1]).trim()) {
      // Plain-text page parameter we cannot resolve reliably: be conservative.
      listsAllAttachments = true;
    } else {
      listsAllAttachments = true;
    }
  }
  // Self-closing macro form <ac:structured-macro ac:name="attachments" ... />
  const selfClosing = /<ac:structured-macro\b([^>]*)\/>/g;
  while ((m = selfClosing.exec(body)) !== null) {
    const name = (parseAttrs(m[1])['ac:name'] || '').toLowerCase();
    if (LIST_ALL_MACROS.has(name)) listsAllAttachments = true;
  }

  return { ownFilenames, crossRefs, listsAllAttachments, text: decodeEntities(body).toLowerCase() };
}

/**
 * True when an attachment of this page should be treated as used.
 * Explicit references, list-all macros, and loose text matches (for third-party
 * macros such as draw.io or Gliffy that refer to files by name) all count.
 */
export function isAttachmentReferenced(filename, refs) {
  if (!filename) return false;
  if (refs.listsAllAttachments) return true;
  if (refs.ownFilenames.has(filename)) return true;
  const lower = String(filename).toLowerCase();
  if (refs.text.includes(lower)) return true;
  const base = baseName(filename).toLowerCase();
  if (base.length >= 4 && base !== lower && refs.text.includes(base)) return true;
  return false;
}
