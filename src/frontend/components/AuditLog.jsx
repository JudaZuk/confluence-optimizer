import React, { useState } from 'react';
import { Inline, Text, Button, DynamicTable, Select, User } from '@forge/react';
import { call, useLoad } from './api.js';
import { CsvModal, ErrorMessage, Section } from './ui.jsx';
import { formatBytes } from '../../shared/format.js';

const EVENT_FILTERS = [
  { label: 'All events', value: '' },
  { label: 'Requests and decisions', value: 'request.' },
  { label: 'Attachment changes', value: 'attachment.' },
  { label: 'Page purges', value: 'page.' },
  { label: 'Failed items', value: 'item.' },
  { label: 'Scans', value: 'scan.' },
  { label: 'Exports', value: 'report.' },
  { label: 'Settings changes', value: 'settings.' },
];

function Actor({ id }) {
  if (!id) return <Text>—</Text>;
  if (id.startsWith('rule:') || id.startsWith('app')) return <Text>{id}</Text>;
  return <User accountId={id} />;
}

/** Append-only record of every request, decision, change, export and setting. */
export function AuditLog() {
  const [event, setEvent] = useState('');
  const [page, setPage] = useState(0);
  const [csv, setCsv] = useState(null);
  const [error, setError] = useState(null);
  const list = useLoad('listAudit', { event, page, pageSize: 50 });
  const total = list.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 50));

  const exportCsv = async () => {
    try {
      setCsv(await call('exportAudit', { event }));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Section
      title="Audit log"
      actions={
        <Inline space="space.100" alignBlock="center">
          <Select options={EVENT_FILTERS} value={EVENT_FILTERS.find((o) => o.value === event)} onChange={(o) => { setEvent(o.value); setPage(0); }} />
          <Button onClick={exportCsv}>Export CSV</Button>
        </Inline>
      }
    >
      <ErrorMessage error={list.error || error} />
      <DynamicTable
        head={{
          cells: [
            { key: 'at', content: 'Time (UTC)' },
            { key: 'who', content: 'Who' },
            { key: 'ev', content: 'Event' },
            { key: 'obj', content: 'Object' },
            { key: 'sp', content: 'Space' },
            { key: 'b', content: 'Size' },
          ],
        }}
        rows={(list.data?.rows || []).map((r) => ({
          key: r.id,
          cells: [
            { key: 'at', content: <Text>{String(r.at || '').slice(0, 19)}</Text> },
            { key: 'who', content: <Actor id={r.actor} /> },
            { key: 'ev', content: <Text>{r.event}</Text> },
            { key: 'obj', content: <Text>{r.objectTitle || r.objectId || (r.requestId ? `request ${r.requestId.slice(0, 8)}` : '—')}</Text> },
            { key: 'sp', content: <Text>{r.spaceKey || '—'}</Text> },
            { key: 'b', content: <Text>{r.bytes ? formatBytes(r.bytes) : '—'}</Text> },
          ],
        }))}
        isLoading={list.loading}
        emptyView={<Text>No audit events yet.</Text>}
      />
      <Inline space="space.100" alignBlock="center">
        <Button isDisabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
        <Text>{`Page ${page + 1} of ${pages}`}</Text>
        <Button isDisabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</Button>
      </Inline>
      <CsvModal csv={csv?.csv} rows={csv?.rows} truncated={csv?.truncated} onClose={() => setCsv(null)} />
    </Section>
  );
}
