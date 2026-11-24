// A deliberately small fake of Forge SQL for the smoke test. It stores rows
// written with INSERT and answers the handful of queries the scan and the
// review queue depend on. Every other statement is accepted and returns
// nothing, which is enough to execute (and type-check) the code paths.

export function createFakeDb() {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const keyOf = (name, row) => (name === 'request_items' ? `${row.request_id}|${row.item_id}` : String(row.id));

  function insert(query, params) {
    const m = /INSERT INTO (\w+) \(([^)]+)\) VALUES/.exec(query);
    const name = m[1];
    const cols = m[2].split(',').map((c) => c.trim());
    const literalStatus = /'pending', \?, \?\)$/m.test(query.trim()) && name === 'requests';
    const per = literalStatus ? cols.length - 1 : cols.length;
    const t = table(name);
    for (let i = 0; i < params.length; i += per) {
      const values = params.slice(i, i + per);
      const row = {};
      let vi = 0;
      for (const c of cols) {
        if (literalStatus && c === 'status') row[c] = 'pending';
        else row[c] = values[vi++];
      }
      const existing = t.get(keyOf(name, row));
      if (!existing) {
        t.set(keyOf(name, row), row);
        continue;
      }
      // Like MySQL: on a duplicate key only the listed columns change.
      const updates = [...query.matchAll(/(\w+) = VALUES\(\1\)/g)].map((x) => x[1]);
      for (const c of updates) existing[c] = row[c];
      if ('trashed_seen_at' in row) {
        existing.trashed_seen_at = row.status === 'trashed' ? existing.trashed_seen_at || row.trashed_seen_at : null;
      }
    }
    return { rows: { affectedRows: params.length / per } };
  }

  async function handle(query, params) {
    const q = query.replace(/\s+/g, ' ').trim();
    if (q.startsWith('INSERT INTO')) return insert(q, params);

    if (q.startsWith('SELECT id, space_key FROM spaces WHERE scan_id = ? AND id > ?')) {
      const rows = [...table('spaces').values()]
        .filter((r) => r.scan_id === params[0] && String(r.id) > String(params[1]))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return { rows: rows.slice(0, 1) };
    }
    if (q.startsWith('SELECT id, title, container_id, is_referenced, space_id, container_status, container_modified_at FROM attachments WHERE container_id IN')) {
      const after = params[params.length - 1];
      const ids = params.slice(0, -1);
      const rows = [...table('attachments').values()]
        .filter((r) => ids.includes(r.container_id) && String(r.id) > String(after))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return { rows: rows.slice(0, 1000) };
    }
    if (q.startsWith('UPDATE attachments SET space_id = ?, container_status = ?, container_modified_at = ?, is_referenced = ?')) {
      const [spaceId, status, modified, referenced, ...ids] = params;
      for (const r of table('attachments').values()) {
        if (ids.includes(r.id)) Object.assign(r, { space_id: spaceId, container_status: status, container_modified_at: modified, is_referenced: referenced });
      }
      return { rows: { affectedRows: ids.length } };
    }
    if (q.startsWith('SELECT id, dup_key, status, dup_count, dup_keep FROM attachments')) {
      const rows = [...table('attachments').values()]
        .filter((r) => String(r.dup_key) > String(params[0]))
        .sort((a, b) => String(a.dup_key).localeCompare(String(b.dup_key)));
      return { rows: rows.slice(0, 2000) };
    }
    if (q.startsWith('UPDATE attachments SET dup_count = ?, dup_keep = ?')) {
      const [count, keep, ...ids] = params;
      for (const r of table('attachments').values()) if (ids.includes(r.id)) Object.assign(r, { dup_count: count, dup_keep: keep });
      return { rows: { affectedRows: ids.length } };
    }
    if (q.startsWith('SELECT id, title, container_id FROM attachments WHERE container_id IN')) {
      return { rows: [...table('attachments').values()].filter((r) => params.includes(r.container_id)) };
    }
    if (q.startsWith('UPDATE attachments SET is_referenced = 0 WHERE container_id IN')) {
      for (const r of table('attachments').values()) if (params.includes(r.container_id)) r.is_referenced = 0;
      return { rows: { affectedRows: 1 } };
    }
    if (q.startsWith('UPDATE attachments SET is_referenced = 1 WHERE id IN')) {
      for (const r of table('attachments').values()) if (params.includes(r.id)) r.is_referenced = 1;
      return { rows: { affectedRows: 1 } };
    }
    if (q.startsWith('SELECT a.id, a.title, a.space_id, a.version_number')) {
      // Review queue item resolution (selection by ids).
      return {
        rows: [...table('attachments').values()]
          .filter((r) => params.includes(r.id) && ['current', 'archived'].includes(r.status))
          .map((r) => ({ ...r, bytes: r.file_size * r.version_number })),
      };
    }
    if (q.startsWith('SELECT * FROM requests WHERE id = ?') || q.startsWith('SELECT status FROM requests WHERE id = ?') ||
        q.startsWith('SELECT freed_bytes FROM requests WHERE id = ?')) {
      const r = table('requests').get(params[0]);
      return { rows: r ? [r] : [] };
    }
    if (q.startsWith('UPDATE requests SET status = ?, decided_by')) {
      const r = table('requests').get(params[4]);
      if (!r || r.status !== 'pending') return { rows: { affectedRows: 0 } };
      Object.assign(r, { status: params[0], decided_by: params[1] });
      return { rows: { affectedRows: 1 } };
    }
    if (q.startsWith("UPDATE requests SET status = 'running'")) {
      const r = table('requests').get(params[2]);
      if (!r || !['approved', 'running'].includes(r.status)) return { rows: { affectedRows: 0 } };
      r.status = 'running';
      return { rows: { affectedRows: 1 } };
    }
    if (q.startsWith('UPDATE requests SET status = ?, finished_at')) {
      const r = table('requests').get(params[2]);
      r.status = params[0];
      return { rows: { affectedRows: 1 } };
    }
    if (q.startsWith("SELECT * FROM request_items WHERE request_id = ? AND status = 'pending'")) {
      return { rows: [...table('request_items').values()].filter((i) => i.request_id === params[0] && i.status === 'pending') };
    }
    if (q.startsWith('UPDATE request_items SET status = ?')) {
      const item = table('request_items').get(`${params[3]}|${params[4]}`);
      Object.assign(item, { status: params[0], message: params[1] });
      return { rows: { affectedRows: 1 } };
    }
    if (q.startsWith("SELECT SUM(status = 'done')")) {
      const items = [...table('request_items').values()].filter((i) => i.request_id === params[0]);
      const count = (s) => items.filter((i) => i.status === s).length;
      return { rows: [{ done: count('done'), failed: count('failed'), skipped: count('skipped') }] };
    }
    if (q.startsWith("UPDATE attachments SET status = 'trashed'")) {
      const r = table('attachments').get(params[1]);
      if (r) r.status = 'trashed';
      return { rows: { affectedRows: 1 } };
    }
    if (q.startsWith('SELECT')) return { rows: q.includes('COUNT(*)') ? [{ n: 0 }] : [] };
    return { rows: { affectedRows: 0 } };
  }

  return { tables, table, handle };
}
