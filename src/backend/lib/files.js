// File type classification. Pure functions, unit tested.

export const TYPE_CATEGORIES = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'tif', 'tiff', 'heic', 'ico'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'flv'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'],
  pdf: ['pdf'],
  office: ['doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'csv', 'vsd', 'vsdx', 'one'],
  archive: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'dmg', 'jar', 'war'],
  design: ['psd', 'ai', 'sketch', 'fig', 'xd', 'indd', 'eps', 'dwg', 'dxf', 'blend', 'stl', 'step', 'stp'],
  diagram: ['drawio', 'gliffy', 'puml', 'bpmn'],
  text: ['txt', 'md', 'log', 'json', 'xml', 'yaml', 'yml', 'html', 'htm'],
  executable: ['exe', 'msi', 'apk', 'bin', 'deb', 'rpm', 'pkg'],
};

const EXT_TO_CATEGORY = new Map();
for (const [category, exts] of Object.entries(TYPE_CATEGORIES)) {
  for (const ext of exts) EXT_TO_CATEGORY.set(ext, category);
}

export const CATEGORY_LABELS = {
  image: 'Images',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF',
  office: 'Office documents',
  archive: 'Archives',
  design: 'Design / CAD',
  diagram: 'Diagrams',
  text: 'Text / data',
  executable: 'Executables / installers',
  other: 'Other',
};

/** Lower-case extension without the dot, or '' (max 16 chars). */
export function fileExtension(filename) {
  if (!filename) return '';
  const name = String(filename).trim();
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(ext) ? ext : '';
}

/** Category for a file, using the extension first and the media type as a fallback. */
export function typeCategory(filename, mediaType) {
  const ext = fileExtension(filename);
  if (ext && EXT_TO_CATEGORY.has(ext)) return EXT_TO_CATEGORY.get(ext);
  const mt = String(mediaType || '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt === 'application/pdf') return 'pdf';
  if (mt.includes('zip') || mt.includes('compressed') || mt.includes('x-tar')) return 'archive';
  if (mt.includes('officedocument') || mt.includes('msword') || mt.includes('ms-excel') || mt.includes('ms-powerpoint')) {
    return 'office';
  }
  if (mt.startsWith('text/')) return 'text';
  return 'other';
}

/** File name without its extension, used for loose reference matching (e.g. draw.io diagrams). */
export function baseName(filename) {
  const name = String(filename || '');
  const ext = fileExtension(name);
  return ext ? name.slice(0, -(ext.length + 1)) : name;
}
