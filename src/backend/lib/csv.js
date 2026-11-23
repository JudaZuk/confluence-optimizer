// RFC 4180 CSV. Cells that start with = + - @ are prefixed with ' so that
// spreadsheet apps do not run them as formulas (CSV injection).

function cell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {Array<object>} rows
 * @param {Array<{key: string, label: string}>} columns
 */
export function toCsv(rows, columns) {
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
