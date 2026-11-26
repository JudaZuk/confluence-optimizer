import React from 'react';
import { Inline, Stack, Text, Strong, Button, Lozenge, SectionMessage } from '@forge/react';
import { Card } from './ui.jsx';
import { formatDate, formatNumber, countOf } from '../../shared/format.js';

const PHASE_LABELS = {
  spaces: 'Listing spaces',
  attachments: 'Listing attachments',
  content: 'Reading pages and checking references',
  finalize: 'Resolving links between pages',
  dups: 'Looking for duplicate files',
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
        {running && scan.pausedUntil && Date.parse(scan.pausedUntil) > Date.now() ? (
          <SectionMessage appearance="information" title="Paused by Confluence's API limit">
            <Text>
              {`Confluence limits how much an app may request per hour. The scan saved its progress and continues by itself at about ${new Date(scan.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Nothing needs to be done.`}
            </Text>
          </SectionMessage>
        ) : null}
        {running ? (
          <Text>
            {`${PHASE_LABELS[scan.phase] || scan.phase}… ${formatNumber(c.spaces)} spaces, ${formatNumber(c.attachments)} attachments, ${formatNumber(c.pages)} pages, ${formatNumber(c.blogposts)} blog posts so far. You can leave this page.`}
          </Text>
        ) : null}
        {scan?.status === 'done' && c.skippedSpaces ? (
          <SectionMessage appearance="warning">
            <Stack space="space.050">
              <Text>{`${countOf(c.skippedSpaces, 'space')} could not be scanned and ${c.skippedSpaces === 1 ? 'was' : 'were'} skipped. Results for ${c.skippedSpaces === 1 ? 'it' : 'them'} may be incomplete.`}</Text>
              {(scan.skipped || []).slice(0, 10).map((s) => (
                <Text key={s.space}>{`${s.space}: ${s.error}`}</Text>
              ))}
            </Stack>
          </SectionMessage>
        ) : null}
        {scan?.status === 'failed' ? (
          <SectionMessage appearance="error"><Text>{scan.error || scan.lastError}</Text></SectionMessage>
        ) : null}
        {running && scan.lastError ? <Text>{`Retrying after an error: ${scan.lastError}`}</Text> : null}
      </Stack>
    </Card>
  );
}
