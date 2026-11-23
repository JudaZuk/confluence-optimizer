import React, { useEffect, useState } from 'react';
import {
  Stack, Inline, Text, Button, DynamicTable, Select, TextArea, SectionMessage, ProgressBar, User,
  Modal, ModalHeader, ModalTitle, ModalBody, ModalFooter, ModalTransition,
} from '@forge/react';
import { call, useLoad } from './api.js';
import { ErrorMessage, FieldLabel, Loading, Section, StatusLozenge } from './ui.jsx';
import { formatBytes, formatDate, formatNumber, IRREVERSIBLE_ACTIONS } from '../../shared/format.js';

const STATUS_FILTERS = [
  { label: 'Open (pending, approved, running)', value: 'open' },
  { label: 'Pending approval', value: 'pending' },
  { label: 'Done', value: 'done' },
  { label: 'Partly done', value: 'partial' },
  { label: 'Failed', value: 'failed' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Cancelled', value: 'cancelled' },
  { label: 'All', value: 'all' },
];

function Requester({ id }) {
  if (!id) return <Text>—</Text>;
  if (id.startsWith('rule:') || id.startsWith('app')) return <Text>{`Retention rule (${id.replace('rule:', '')})`}</Text>;
  return <User accountId={id} />;
}

function RequestDetail({ id, mode, accountId, onClose, onChanged }) {
  const [req, setReq] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setReq(await call('getRequest', { id }));
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  // Poll while the job runs.
  useEffect(() => {
    if (!req || !['approved', 'running'].includes(req.status)) return undefined;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [req?.status]);

  const act = async (name, payload) => {
    setBusy(true);
    setError(null);
    try {
      await call(name, { id, ...payload });
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const processed = req ? req.done + req.failed + req.skipped : 0;
  const irreversible = req && IRREVERSIBLE_ACTIONS.has(req.action);

  return (
    <ModalTransition>
      <Modal onClose={onClose} width="x-large">
        <ModalHeader>
          <ModalTitle>{req ? req.title : 'Request'}</ModalTitle>
        </ModalHeader>
        <ModalBody>
          {!req ? (
            <Stack space="space.100">
              <ErrorMessage error={error} />
              {!error ? <Loading /> : null}
            </Stack>
          ) : (
            <Stack space="space.150">
              <ErrorMessage error={error} />
              <Inline space="space.100" alignBlock="center" shouldWrap>
                <StatusLozenge status={req.status} />
                <Text>Requested {formatDate(req.createdAt)} by</Text>
                <Requester id={req.requestedBy} />
                {req.spaceKey ? <Text>{`· space ${req.spaceKey}`}</Text> : <Text>· site-wide</Text>}
              </Inline>
              <Text>
                {formatNumber(req.itemCount)} items · about {formatBytes(req.totalBytes)}
                {req.params?.keep ? ` · keep newest ${req.params.keep} versions` : ''}
              </Text>
              {req.note ? <Text>{`Reason: ${req.note}`}</Text> : null}
              {req.decidedBy ? (
                <Inline space="space.100" alignBlock="center">
                  <Text>{req.status === 'rejected' ? 'Rejected' : 'Decided'} by</Text>
                  <User accountId={req.decidedBy} />
                  <Text>{`${formatDate(req.decidedAt)}${req.decisionNote ? ` – ${req.decisionNote}` : ''}`}</Text>
                </Inline>
              ) : null}
              {['running', 'approved', 'done', 'partial', 'failed'].includes(req.status) ? (
                <Stack space="space.050">
                  <ProgressBar value={req.itemCount ? processed / req.itemCount : 0} />
                  <Text>
                    {`${req.done} done · ${req.skipped} skipped · ${req.failed} failed · ${formatBytes(req.freedBytes)} freed`}
                  </Text>
                </Stack>
              ) : null}
              {req.status === 'pending' && mode === 'admin' && irreversible ? (
                <SectionMessage appearance="warning">
                  <Text>Approving this request permanently deletes data. It cannot be undone.</Text>
                </SectionMessage>
              ) : null}
              <DynamicTable
                head={{ cells: [{ key: 't', content: 'Item' }, { key: 's', content: 'Space' }, { key: 'b', content: 'Size' }, { key: 'st', content: 'Result' }] }}
                rows={req.items.map((i) => ({
                  key: i.id,
                  cells: [
                    { key: 't', content: <Text>{i.title || i.id}</Text> },
                    { key: 's', content: <Text>{i.spaceKey || '—'}</Text> },
                    { key: 'b', content: <Text>{formatBytes(i.bytes)}</Text> },
                    { key: 'st', content: <Text>{i.message ? `${i.status}: ${i.message}` : i.status}</Text> },
                  ],
                }))}
              />
              {req.itemCount > req.items.length ? <Text>{`Showing the ${req.items.length} largest of ${formatNumber(req.itemCount)} items.`}</Text> : null}
              {req.status === 'pending' && mode === 'admin' ? (
                <Stack space="space.050">
                  <FieldLabel>Decision note (optional)</FieldLabel>
                  <TextArea value={note} onChange={(e) => setNote(e.target.value)} />
                </Stack>
              ) : null}
            </Stack>
          )}
        </ModalBody>
        <ModalFooter>
          <Button appearance="subtle" onClick={onClose}>Close</Button>
          {req && req.status === 'pending' && mode === 'admin' ? (
            <Button isDisabled={busy} onClick={() => act('decideRequest', { approve: false, note })}>Reject</Button>
          ) : null}
          {req && req.status === 'pending' && mode === 'admin' ? (
            <Button appearance={irreversible ? 'danger' : 'primary'} isDisabled={busy} onClick={() => act('decideRequest', { approve: true, note })}>
              Approve and run
            </Button>
          ) : null}
          {req && ['approved', 'running'].includes(req.status) && mode === 'admin' ? (
            <Button appearance="warning" isDisabled={busy} onClick={() => act('stopRequest', {})}>Stop</Button>
          ) : null}
          {req && req.status === 'pending' && (mode === 'admin' || req.requestedBy === accountId) ? (
            <Button isDisabled={busy} onClick={() => act('cancelRequest', {})}>Cancel request</Button>
          ) : null}
        </ModalFooter>
      </Modal>
    </ModalTransition>
  );
}

/** The review queue: every cleanup goes through here. */
export function ReviewQueue({ mode, accountId }) {
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState(null);
  const list = useLoad('listRequests', { status, page });

  const rows = (list.data?.rows || []).map((r) => ({
    key: r.id,
    cells: [
      { key: 'c', content: <Text>{formatDate(r.createdAt)}</Text> },
      { key: 't', content: <Text>{r.title}</Text> },
      { key: 'by', content: <Requester id={r.requestedBy} /> },
      ...(mode === 'admin' ? [{ key: 's', content: <Text>{r.spaceKey || 'site'}</Text> }] : []),
      { key: 'b', content: <Text>{formatBytes(r.totalBytes)}</Text> },
      { key: 'st', content: <StatusLozenge status={r.status} /> },
      { key: 'o', content: <Button onClick={() => setOpenId(r.id)}>{r.status === 'pending' && mode === 'admin' ? 'Review' : 'Open'}</Button> },
    ],
  }));
  const total = list.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / 25));

  return (
    <Section
      title="Review queue"
      actions={
        <Inline space="space.100" alignBlock="center">
          <Select
            options={STATUS_FILTERS}
            value={STATUS_FILTERS.find((o) => o.value === status)}
            onChange={(o) => { setStatus(o.value); setPage(0); }}
          />
          <Button onClick={list.reload}>Refresh</Button>
        </Inline>
      }
    >
      <Text>
        {mode === 'admin'
          ? 'Requests from admins, space admins and retention rules. Nothing changes in Confluence until a request is approved here.'
          : 'Your space\'s cleanup requests. A Confluence administrator approves them before anything changes.'}
      </Text>
      <ErrorMessage error={list.error} />
      <DynamicTable
        head={{
          cells: [
            { key: 'c', content: 'Created' },
            { key: 't', content: 'Request' },
            { key: 'by', content: 'Requested by' },
            ...(mode === 'admin' ? [{ key: 's', content: 'Space' }] : []),
            { key: 'b', content: 'Size' },
            { key: 'st', content: 'Status' },
            { key: 'o', content: '' },
          ],
        }}
        rows={rows}
        isLoading={list.loading}
        emptyView={<Text>No requests here.</Text>}
      />
      <Inline space="space.100" alignBlock="center">
        <Button isDisabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
        <Text>{`Page ${page + 1} of ${pages}`}</Text>
        <Button isDisabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</Button>
      </Inline>
      {openId ? (
        <RequestDetail id={openId} mode={mode} accountId={accountId} onClose={() => setOpenId(null)} onChanged={list.reload} />
      ) : null}
    </Section>
  );
}

