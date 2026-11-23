import React, { useEffect, useMemo, useState } from 'react';
import {
  Stack, Inline, Box, Text, Strong, Button, ButtonGroup, DynamicTable, Select, Textfield, Checkbox,
  Lozenge, Link, SectionMessage, User, xcss,
} from '@forge/react';
import { call } from './api.js';
import { CsvModal, ErrorMessage, FieldLabel, Section } from './ui.jsx';
import { RequestModal } from './RequestModal.jsx';
import { formatBytes, formatDate, formatNumber } from '../../shared/format.js';

export const FINDING_OPTIONS = [
  { label: 'All attachments', value: 'all' },
  { label: 'Unused (not shown on any page)', value: 'unused' },
  { label: 'Orphaned (page deleted or missing)', value: 'orphaned' },
  { label: 'Probable duplicates', value: 'duplicates' },
  { label: 'Many old versions', value: 'versions' },
  { label: 'On stale pages', value: 'stale' },
  { label: 'Large files', value: 'large' },
  { label: 'In trash', value: 'trash' },
];

const CATEGORY_OPTIONS = [
  { label: 'Any type', value: '' },
  { label: 'Images', value: 'image' },
  { label: 'Video', value: 'video' },
  { label: 'Audio', value: 'audio' },
  { label: 'PDF', value: 'pdf' },
  { label: 'Office documents', value: 'office' },
  { label: 'Archives', value: 'archive' },
  { label: 'Design / CAD', value: 'design' },
  { label: 'Diagrams', value: 'diagram' },
  { label: 'Text / data', value: 'text' },
  { label: 'Executables', value: 'executable' },
  { label: 'Other', value: 'other' },
];

const AGE_OPTIONS = [
  { label: 'Any age', value: 0 },
  { label: 'Unchanged for 3+ months', value: 90 },
  { label: 'Unchanged for 1+ year', value: 365 },
  { label: 'Unchanged for 2+ years', value: 730 },
  { label: 'Unchanged for 3+ years', value: 1095 },
];

const SORT_OPTIONS = [
  { label: 'Largest first', value: 'size_desc' },
  { label: 'Smallest first', value: 'size_asc' },
  { label: 'Oldest change first', value: 'modified_asc' },
  { label: 'Newest change first', value: 'modified_desc' },
  { label: 'Most versions first', value: 'versions_desc' },
  { label: 'Name A–Z', value: 'title_asc' },
];

const STATUS_OPTIONS = [
  { label: 'Live (not in trash)', value: 'live' },
  { label: 'In trash', value: 'trashed' },
  { label: 'Any status', value: 'any' },
];

const PAGE_SIZE = 50;
const find = (options, value) => options.find((o) => o.value === value) || options[0];
const filterBar = xcss({ paddingBottom: 'space.100' });

function flags(row) {
  const out = [];
  if (row.status === 'trashed' || row.containerStatus === 'trashed') out.push(<Lozenge key="t" appearance="removed">trash</Lozenge>);
  if (row.orphanReason) out.push(<Lozenge key="o" appearance="moved">orphaned</Lozenge>);
  if (row.referenced === false) out.push(<Lozenge key="u" appearance="new">unused</Lozenge>);
  if (row.versions > 1) out.push(<Lozenge key="v">{`${row.versions} versions`}</Lozenge>);
  return out.length ? <Inline space="space.050">{out}</Inline> : null;
}

/**
 * Searchable, filterable list of attachments with selection and review-queue actions.
 * mode: 'admin' (site-wide, space filter available) or 'space' (scoped on the server).
 */
export function AttachmentExplorer({ mode, spaces = [], preset, settings, canRequest = true }) {
  const [filters, setFilters] = useState({ finding: 'all', status: 'live', category: '', olderThanDays: 0, minSizeMb: '', q: '', spaceId: '' });
  const [sort, setSort] = useState('size_desc');
  const [page, setPage] = useState(0);
  const [data, setData] = useState({ rows: [], total: 0, totalBytes: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState({});
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null);
  const [csv, setCsv] = useState(null);

  // Apply a preset coming from the overview ("Review" buttons).
  useEffect(() => {
    if (preset?.finding) {
      setFilters((f) => ({ ...f, finding: preset.finding }));
      setPage(0);
    }
  }, [preset?.finding, preset?.nonce]);

  const query = useMemo(
    () => ({
      ...filters,
      minSizeMb: filters.minSizeMb ? Number(filters.minSizeMb) : 0,
      spaceId: mode === 'admin' ? filters.spaceId || undefined : undefined,
    }),
    [filters, mode],
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await call('listAttachments', { filters: query, sort, page, pageSize: PAGE_SIZE }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Short debounce so typing in the text filters does not fire a query per key.
  useEffect(() => {
    const timer = setTimeout(load, 300);
    return () => clearTimeout(timer);
  }, [JSON.stringify(query), sort, page]);

  const update = (patch) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
    setSelected({});
  };

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const selectedBytes = data.rows.filter((r) => selected[r.id]).reduce((s, r) => s + r.storedBytes, 0);
  const allOnPage = data.rows.length > 0 && data.rows.every((r) => selected[r.id]);
  const inTrashView = filters.finding === 'trash' || (filters.finding === 'all' && filters.status === 'trashed');

  const toggleAll = () => {
    const next = { ...selected };
    for (const r of data.rows) next[r.id] = !allOnPage;
    setSelected(next);
  };

  const openRequest = (action, scopeAll) => {
    const count = scopeAll ? data.total : selectedIds.length;
    setPending({
      action,
      scopeAll,
      count,
      bytes: scopeAll ? data.totalBytes : selectedBytes,
      keep: settings?.keepVersions || 3,
      label: scopeAll ? `All ${formatNumber(count)} attachments matching the filters (max 5,000)` : `${count} selected attachment(s)`,
    });
  };

  const confirmRequest = async ({ note, params }) => {
    const selection = pending.scopeAll ? { filters: query } : { ids: selectedIds };
    try {
      const res = await call('createRequest', { action: pending.action, selection, note, params });
      setNotice(`Request created: ${res.title}. It is now waiting for approval in the review queue.`);
      setSelected({});
      setPending(null);
    } catch (err) {
      setPending(null);
      setError(err.message);
    }
  };

  const exportCsv = async () => {
    try {
      const res = await call('exportAttachments', { filters: query, sort });
      setCsv(res);
    } catch (err) {
      setError(err.message);
    }
  };

  const head = {
    cells: [
      { key: 'sel', content: <Checkbox isChecked={allOnPage} onChange={toggleAll} label="" /> , width: 3 },
      { key: 'file', content: 'File' },
      ...(mode === 'admin' ? [{ key: 'space', content: 'Space' }] : []),
      { key: 'page', content: 'Page' },
      { key: 'size', content: 'Size (all versions)' },
      { key: 'modified', content: 'Last change' },
      { key: 'by', content: 'By' },
      { key: 'flags', content: 'Flags' },
    ],
  };

  const rows = data.rows.map((r) => ({
    key: r.id,
    cells: [
      { key: 'sel', content: <Checkbox isChecked={Boolean(selected[r.id])} onChange={() => setSelected({ ...selected, [r.id]: !selected[r.id] })} label="" /> },
      { key: 'file', content: r.url ? <Link href={r.url} openNewTab>{r.title}</Link> : <Text>{r.title}</Text> },
      ...(mode === 'admin' ? [{ key: 'space', content: <Text>{r.spaceKey || '—'}</Text> }] : []),
      { key: 'page', content: <Text>{r.containerTitle || '—'}</Text> },
      { key: 'size', content: <Text>{formatBytes(r.storedBytes)}{r.versions > 1 ? ` (${formatBytes(r.size)} each)` : ''}</Text> },
      { key: 'modified', content: <Text>{formatDate(r.modifiedAt)}</Text> },
      { key: 'by', content: r.modifiedBy ? <User accountId={r.modifiedBy} /> : <Text>—</Text> },
      { key: 'flags', content: flags(r) },
    ],
  }));

  const spaceOptions = [{ label: 'All spaces', value: '' }, ...spaces.map((s) => ({ label: `${s.key} – ${s.name || ''}`, value: s.id }))];
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <Section
      title="Attachments"
      actions={<Button onClick={exportCsv}>Export CSV</Button>}
    >
      <Box xcss={filterBar}>
        <Inline space="space.150" shouldWrap>
          <Stack space="space.050">
            <FieldLabel>Show</FieldLabel>
            <Select options={FINDING_OPTIONS} value={find(FINDING_OPTIONS, filters.finding)} onChange={(o) => update({ finding: o.value })} />
          </Stack>
          {filters.finding === 'all' ? (
            <Stack space="space.050">
              <FieldLabel>Status</FieldLabel>
              <Select options={STATUS_OPTIONS} value={find(STATUS_OPTIONS, filters.status)} onChange={(o) => update({ status: o.value })} />
            </Stack>
          ) : null}
          {mode === 'admin' ? (
            <Stack space="space.050">
              <FieldLabel>Space</FieldLabel>
              <Select options={spaceOptions} value={find(spaceOptions, filters.spaceId)} onChange={(o) => update({ spaceId: o.value })} />
            </Stack>
          ) : null}
          <Stack space="space.050">
            <FieldLabel>Type</FieldLabel>
            <Select options={CATEGORY_OPTIONS} value={find(CATEGORY_OPTIONS, filters.category)} onChange={(o) => update({ category: o.value })} />
          </Stack>
          <Stack space="space.050">
            <FieldLabel>Age</FieldLabel>
            <Select options={AGE_OPTIONS} value={find(AGE_OPTIONS, filters.olderThanDays)} onChange={(o) => update({ olderThanDays: o.value })} />
          </Stack>
          <Stack space="space.050">
            <FieldLabel>Min size (MB)</FieldLabel>
            <Textfield value={filters.minSizeMb} onChange={(e) => update({ minSizeMb: e.target.value.replace(/[^0-9.]/g, '') })} />
          </Stack>
          <Stack space="space.050">
            <FieldLabel>File name contains</FieldLabel>
            <Textfield value={filters.q} onChange={(e) => update({ q: e.target.value })} />
          </Stack>
          <Stack space="space.050">
            <FieldLabel>Sort</FieldLabel>
            <Select options={SORT_OPTIONS} value={find(SORT_OPTIONS, sort)} onChange={(o) => { setSort(o.value); setPage(0); }} />
          </Stack>
        </Inline>
      </Box>

      {filters.finding === 'unused' ? (
        <SectionMessage appearance="information">
          <Text>
            "Unused" means the file is not referenced in its page body, by a list-all macro, or from another page, and has not
            changed for {settings?.unusedMinAgeDays ?? 30} days. Files used only from outside Confluence (direct links, other
            tools) cannot be detected, so always review before cleaning up.
          </Text>
        </SectionMessage>
      ) : null}
      {filters.finding === 'duplicates' ? (
        <SectionMessage appearance="information">
          <Text>Probable duplicates share the same file name and size. File contents are not compared.</Text>
        </SectionMessage>
      ) : null}
      {notice ? (
        <SectionMessage appearance="success">
          <Text>{notice}</Text>
        </SectionMessage>
      ) : null}
      <ErrorMessage error={error} />

      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Text>
          <Strong>{formatNumber(data.total)}</Strong> attachments · <Strong>{formatBytes(data.totalBytes)}</Strong> including versions
          {selectedIds.length ? ` · ${selectedIds.length} selected (${formatBytes(selectedBytes)})` : ''}
        </Text>
      </Inline>

      {canRequest ? (
        <ButtonGroup>
          {!inTrashView ? (
            <Button appearance="primary" isDisabled={!selectedIds.length} onClick={() => openRequest('trash_attachment', false)}>
              Move selected to trash…
            </Button>
          ) : (
            <Button appearance="danger" isDisabled={!selectedIds.length} onClick={() => openRequest('purge_attachment', false)}>
              Purge selected…
            </Button>
          )}
          {!inTrashView ? (
            <Button isDisabled={!data.total} onClick={() => openRequest('trash_attachment', true)}>
              Move all matching to trash…
            </Button>
          ) : (
            <Button isDisabled={!data.total} onClick={() => openRequest('purge_attachment', true)}>
              Purge all matching…
            </Button>
          )}
          {!inTrashView ? (
            <Button isDisabled={!selectedIds.length} onClick={() => openRequest('prune_versions', false)}>
              Delete old versions of selected…
            </Button>
          ) : null}
          {filters.finding === 'versions' ? (
            <Button isDisabled={!data.total} onClick={() => openRequest('prune_versions', true)}>
              Delete old versions of all matching…
            </Button>
          ) : null}
        </ButtonGroup>
      ) : (
        <SectionMessage appearance="information">
          <Text>Cleanup requests from space admins are turned off for this site.</Text>
        </SectionMessage>
      )}

      <DynamicTable
        head={head}
        rows={rows}
        isLoading={loading}
        emptyView={<Text>No attachments match these filters. Run a scan if you have not done so yet.</Text>}
      />

      <Inline space="space.100" alignBlock="center">
        <Button isDisabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
        <Text>
          Page {page + 1} of {pages}
        </Text>
        <Button isDisabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</Button>
      </Inline>

      {pending ? (
        <RequestModal
          key={`${pending.action}-${pending.scopeAll}`}
          request={pending}
          isAdmin={mode === 'admin'}
          onConfirm={confirmRequest}
          onClose={() => setPending(null)}
        />
      ) : null}
      <CsvModal csv={csv?.csv} rows={csv?.rows} truncated={csv?.truncated} onClose={() => setCsv(null)} />
    </Section>
  );
}
