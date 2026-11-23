import React, { useState } from 'react';
import { Stack, Inline, Text, Strong, Button, DynamicTable, Checkbox, SectionMessage, BarChart, DonutChart } from '@forge/react';
import { call, useLoad } from './api.js';
import { Card, ErrorMessage, Kpi, Loading, Section } from './ui.jsx';
import { RequestModal } from './RequestModal.jsx';
import { AttachmentExplorer } from './AttachmentExplorer.jsx';
import { formatBytes, formatNumber, formatDate, bytesToGb } from '../../shared/format.js';

/** Trash storage report: hidden storage in space trash, with reviewed purges. */
export function TrashReport({ mode, summary, spaces, settings, canRequest }) {
  const report = useLoad('getTrashReport', {});
  const [selected, setSelected] = useState({});
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  if (report.loading && !report.data) return <Loading />;
  const r = report.data;
  const t = summary?.totals;
  const selectedIds = Object.keys(selected).filter((k) => selected[k]);

  const confirm = async ({ note }) => {
    try {
      const res = await call('createRequest', { action: 'purge_page', selection: { ids: selectedIds }, note });
      setNotice(`Request created: ${res.title}. It is waiting for approval in the review queue.`);
      setSelected({});
    } catch (err) {
      setError(err.message);
    }
    setPending(null);
  };

  return (
    <Stack space="space.300">
      <ErrorMessage error={report.error || error} />
      {notice ? <SectionMessage appearance="success"><Text>{notice}</Text></SectionMessage> : null}
      <SectionMessage appearance="information">
        <Text>
          Deleted pages and files stay in each space's trash, and keep counting against your storage, until they are purged.
          Purging cannot be undone, so it always goes through the review queue.
        </Text>
      </SectionMessage>

      {t ? (
        <Inline space="space.200" shouldWrap>
          <Kpi label="Trash size" value={formatBytes(t.trashBytes)} detail={t.storedBytes ? `${((t.trashBytes / t.storedBytes) * 100).toFixed(1)}% of all storage` : ''} />
          <Kpi label="Files in trash" value={formatNumber(t.trashCount)} detail="Includes files on trashed pages" />
          <Kpi label="Pages in trash" value={formatNumber(t.trashedPages)} />
        </Inline>
      ) : null}

      {r ? (
        <Inline space="space.300" shouldWrap>
          <Card>
            <BarChart
              data={r.byAge.map((b) => ({ band: b.label, gb: bytesToGb(b.bytes) }))}
              xAccessor="band"
              yAccessor="gb"
              title="Trash by time since last change (GB)"
            />
          </Card>
          {r.byType.length ? (
            <Card>
              <DonutChart data={r.byType.map((x) => ({ type: x.category, gb: bytesToGb(x.bytes) }))} colorAccessor="type" labelAccessor="type" valueAccessor="gb" title="Trash by file type (GB)" />
            </Card>
          ) : null}
        </Inline>
      ) : null}

      {mode === 'admin' && r?.bySpace?.length ? (
        <Section title="Trash by space">
          <DynamicTable
            head={{ cells: [{ key: 's', content: 'Space' }, { key: 'n', content: 'Files' }, { key: 'b', content: 'Size' }] }}
            rows={r.bySpace.map((s) => ({
              key: s.spaceId || s.key,
              cells: [
                { key: 's', content: <Text><Strong>{s.key}</Strong> {s.name}</Text> },
                { key: 'n', content: <Text>{formatNumber(s.count)}</Text> },
                { key: 'b', content: <Text>{formatBytes(s.bytes)}</Text> },
              ],
            }))}
          />
        </Section>
      ) : null}

      {r ? (
        <Section
          title="Pages and blog posts in trash"
          actions={
            canRequest ? (
              <Button appearance="danger" isDisabled={!selectedIds.length} onClick={() => setPending({ action: 'purge_page', count: selectedIds.length, label: `${selectedIds.length} page(s) and their attachments` })}>
                Purge selected pages…
              </Button>
            ) : null
          }
        >
          <DynamicTable
            head={{
              cells: [
                { key: 'sel', content: '' },
                { key: 't', content: 'Title' },
                ...(mode === 'admin' ? [{ key: 's', content: 'Space' }] : []),
                { key: 'a', content: 'Attachments' },
                { key: 'b', content: 'Attachment storage' },
                { key: 'm', content: 'Last change' },
                { key: 'seen', content: 'First seen in trash' },
              ],
            }}
            rows={r.pages.map((p) => ({
              key: p.id,
              cells: [
                { key: 'sel', content: <Checkbox isChecked={Boolean(selected[p.id])} onChange={() => setSelected({ ...selected, [p.id]: !selected[p.id] })} label="" /> },
                { key: 't', content: <Text>{p.title}{p.kind === 'blogpost' ? ' (blog)' : ''}</Text> },
                ...(mode === 'admin' ? [{ key: 's', content: <Text>{p.spaceKey}</Text> }] : []),
                { key: 'a', content: <Text>{formatNumber(p.attachments)}</Text> },
                { key: 'b', content: <Text>{formatBytes(p.bytes)}</Text> },
                { key: 'm', content: <Text>{formatDate(p.modifiedAt)}</Text> },
                { key: 'seen', content: <Text>{formatDate(p.trashedSeenAt)}</Text> },
              ],
            }))}
            emptyView={<Text>No pages in the trash.</Text>}
          />
          <Text>Showing up to 200 trashed pages, largest first. Restore pages from the space's trash in Confluence.</Text>
        </Section>
      ) : null}

      <AttachmentExplorer mode={mode} spaces={spaces} settings={settings} preset={{ finding: 'trash', nonce: 'trash' }} canRequest={canRequest} />

      {pending ? <RequestModal request={pending} isAdmin={mode === 'admin'} onConfirm={confirm} onClose={() => setPending(null)} /> : null}
    </Stack>
  );
}
