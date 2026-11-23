import React from 'react';
import { Inline, Stack, Text, Strong, Button, Lozenge, SectionMessage } from '@forge/react';
import { Card } from './ui.jsx';
import { formatDate, formatNumber } from '../../shared/format.js';

const PHASE_LABELS = {
  spaces: 'Listing spaces',
  attachments: 'Listing attachments',
  content: 'Reading pages and checking references',
  finalize: 'Linking files to pages',
  missing: 'Checking for files on missing pages',
  cleanup: 'Removing deleted items from the index',
  snapshot: 'Calculating the health score',
  rules: 'Applying retention rules',
};

export function ScanStatus({ scan, isAdmin, onStart, onCancel }) {
  const c = scan?.counters || {};
  const running = scan?.status === 'running';
  return (
    <Card>
      <Stack space="space.100">
        <Inline spread="space-between" alignBlock="center">
          <Inline space="space.100" alignBlock="center">
            <Text><Strong>Index</Strong></Text>
            {running ? <Lozenge appearance="inprogress">scanning</Lozenge> : null}
            {scan?.status === 'done' ? <Lozenge appearance="success">up to date as of {formatDate(scan.finishedAt)}</Lozenge> : null}
            {scan?.status === 'failed' ? <Lozenge appearance="removed">last scan failed</Lozenge> : null}
            {scan?.status === 'cancelled' ? <Lozenge>last scan cancelled</Lozenge> : null}
            {!scan || scan.status === 'never' ? <Lozenge appearance="new">not scanned yet</Lozenge> : null}
          </Inline>
          {isAdmin ? (
            running ? (
              <Button onClick={onCancel}>Cancel scan</Button>
            ) : (
              <Button appearance="primary" onClick={onStart}>Scan now</Button>
            )
          ) : null}
        </Inline>
        {running ? (
          <Text>
            {`${PHASE_LABELS[scan.phase] || scan.phase}… ${formatNumber(c.spaces)} spaces, ${formatNumber(c.attachments)} attachments, ${formatNumber(c.pages)} pages, ${formatNumber(c.blogposts)} blog posts so far. You can leave this page.`}
          </Text>
        ) : null}
        {scan?.status === 'done' && c.skippedSpaces ? (
          <Text>{`${c.skippedSpaces} space(s) could not be read by the app (restricted) and were skipped.`}</Text>
        ) : null}
        {scan?.status === 'failed' ? (
          <SectionMessage appearance="error"><Text>{scan.error || scan.lastError}</Text></SectionMessage>
        ) : null}
        {running && scan.lastError ? <Text>{`Retrying after an error: ${scan.lastError}`}</Text> : null}
      </Stack>
    </Card>
  );
}
