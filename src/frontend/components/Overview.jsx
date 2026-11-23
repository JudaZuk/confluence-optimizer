import React from 'react';
import {
  Stack, Inline, Text, Strong, Button, DynamicTable, ProgressBar, SectionMessage, Lozenge,
  BarChart, DonutChart, LineChart, HorizontalBarChart, User,
} from '@forge/react';
import { Kpi, Section, Card } from './ui.jsx';
import { formatBytes, formatNumber, formatPercent, bytesToGb, formatDate } from '../../shared/format.js';

const CATEGORY_LABELS = {
  image: 'Images', video: 'Video', audio: 'Audio', pdf: 'PDF', office: 'Office', archive: 'Archives',
  design: 'Design/CAD', diagram: 'Diagrams', text: 'Text/data', executable: 'Executables', other: 'Other',
};

const FINDING_ROWS = [
  { key: 'trash', label: 'In trash', hint: 'Deleted but still counted against storage until purged' },
  { key: 'versions', label: 'Old versions', hint: 'Versions beyond the number you keep (estimated size)' },
  { key: 'unused', label: 'Unused files', hint: 'Not referenced on any page' },
  { key: 'orphaned', label: 'Orphaned files', hint: 'Their page is in the trash or no longer exists' },
  { key: 'duplicates', label: 'Probable duplicates', hint: 'Same name and size; reclaimable = extra copies' },
  { key: 'stale', label: 'On stale pages', hint: 'Pages not edited for the stale threshold' },
  { key: 'large', label: 'Large files', hint: 'Above the large-file threshold' },
];

function gradeAppearance(grade) {
  return { A: 'success', B: 'success', C: 'inprogress', D: 'moved', F: 'removed' }[grade] || 'default';
}

/**
 * Dashboard. `summary` comes from getSummary (site) or getSpaceSummary (space).
 */
export function Overview({ summary, history = [], onReview, isSite }) {
  if (!summary || summary.notReady) {
    return (
      <SectionMessage appearance="information" title="No data yet">
        <Text>Run a scan to build the index. Large sites can take a while; you can leave this page while it runs.</Text>
      </SectionMessage>
    );
  }
  const t = summary.totals;
  const usage = summary.quotaBytes ? t.storedBytes / summary.quotaBytes : 0;

  const findingRows = FINDING_ROWS.map((f) => {
    const v = summary.findings[f.key] || { count: 0, bytes: 0 };
    const reclaim = f.key === 'duplicates' ? v.reclaimableBytes : v.bytes;
    return {
      key: f.key,
      cells: [
        { key: 'what', content: <Stack space="space.0"><Text><Strong>{f.label}</Strong></Text><Text>{f.hint}</Text></Stack> },
        { key: 'count', content: <Text>{formatNumber(v.count)}</Text> },
        { key: 'bytes', content: <Text>{formatBytes(reclaim)}</Text> },
        { key: 'act', content: v.count ? <Button onClick={() => onReview(f.key)}>Review</Button> : <Text>—</Text> },
      ],
    };
  });

  const healthRows = summary.health.components.map((c) => ({
    key: c.key,
    cells: [
      { key: 'area', content: <Text>{c.label}</Text> },
      { key: 'detail', content: <Text>{c.detail}</Text> },
      { key: 'pen', content: <Text>{c.penalty > 0 ? `−${c.penalty}` : '0'}</Text> },
    ],
  }));

  const typeData = summary.byType.filter((r) => r.bytes > 0).map((r) => ({ type: CATEGORY_LABELS[r.category] || r.category, gb: bytesToGb(r.bytes) }));
  const spaceData = (summary.bySpace || []).slice(0, 10).map((r) => ({ space: r.key, gb: bytesToGb(r.bytes) }));
  const monthData = (summary.byMonth || []).map((r) => ({ month: r.month, gb: bytesToGb(r.bytes) }));
  const historyData = history.map((h) => ({ date: formatDate(h.takenAt), score: h.score, series: 'Health score' }));

  return (
    <Stack space="space.300">
      <Inline space="space.200" shouldWrap>
        <Kpi
          label="Health score"
          value={`${summary.health.score} / 100`}
          detail={<Lozenge appearance={gradeAppearance(summary.health.grade)} isBold>{`Grade ${summary.health.grade}`}</Lozenge>}
        />
        <Kpi
          label={isSite ? 'Storage indexed' : 'Storage in this space'}
          value={formatBytes(t.storedBytes)}
          detail={isSite ? `${formatPercent(usage)} of ${formatBytes(summary.quotaBytes, 0)} limit` : `${formatNumber(t.attachments)} attachments`}
        />
        <Kpi label="Could be reclaimed (est.)" value={formatBytes(t.reclaimableBytes)} detail="Trash, old versions, unused, orphaned, duplicate copies" />
        <Kpi label="In trash" value={formatBytes(t.trashBytes)} detail={`${formatNumber(t.trashCount)} files · ${formatNumber(t.trashedPages)} pages`} />
      </Inline>

      {isSite ? (
        <Card>
          <Stack space="space.100">
            <Text>
              <Strong>Storage limit</Strong> · {formatBytes(t.storedBytes)} of {formatBytes(summary.quotaBytes, 0)}
              {summary.health.monthsLeft !== null && summary.health.monthsLeft !== undefined
                ? ` · limit reached in about ${Math.max(0, Math.round(summary.health.monthsLeft))} months at the current rate`
                : ''}
            </Text>
            <ProgressBar value={Math.min(1, usage)} />
            <Text>
              Old versions account for about {formatBytes(t.oldVersionBytes)} (estimated as earlier versions the same size as the current one).
              The figure Atlassian bills may differ slightly: it also counts content this app cannot read.
            </Text>
          </Stack>
        </Card>
      ) : null}

      <Section title="What you can clean up">
        <DynamicTable
          head={{ cells: [{ key: 'what', content: 'Finding' }, { key: 'count', content: 'Files' }, { key: 'bytes', content: 'Reclaimable' }, { key: 'act', content: '' }] }}
          rows={findingRows}
        />
      </Section>

      <Inline space="space.300" shouldWrap>
        {typeData.length ? (
          <Card>
            <DonutChart data={typeData} colorAccessor="type" labelAccessor="type" valueAccessor="gb" title="Storage by file type (GB)" />
          </Card>
        ) : null}
        {isSite && spaceData.length ? (
          <Card>
            <HorizontalBarChart data={spaceData} xAccessor="gb" yAccessor="space" title="Largest spaces (GB)" />
          </Card>
        ) : null}
      </Inline>

      {monthData.length ? (
        <Card>
          <BarChart data={monthData} xAccessor="month" yAccessor="gb" title="Uploads per month, last 12 months (GB, files still present)" />
        </Card>
      ) : null}

      {isSite && historyData.length > 1 ? (
        <Card>
          <LineChart data={historyData} xAccessor="date" yAccessor="score" colorAccessor="series" title="Health score over time" />
        </Card>
      ) : null}

      <Section title="How the health score is calculated">
        <DynamicTable
          head={{ cells: [{ key: 'area', content: 'Area' }, { key: 'detail', content: 'Now' }, { key: 'pen', content: 'Points' }] }}
          rows={healthRows}
        />
      </Section>

      {summary.byUploader?.length ? (
        <Section title="Who uploads the most (by last version)">
          <DynamicTable
            head={{ cells: [{ key: 'u', content: 'Person' }, { key: 'n', content: 'Files' }, { key: 'b', content: 'Storage' }] }}
            rows={summary.byUploader.map((u) => ({
              key: u.accountId,
              cells: [
                { key: 'u', content: <User accountId={u.accountId} /> },
                { key: 'n', content: <Text>{formatNumber(u.count)}</Text> },
                { key: 'b', content: <Text>{formatBytes(u.bytes)}</Text> },
              ],
            }))}
          />
        </Section>
      ) : null}

      <Text>Figures computed {formatDate(summary.computedAt)} from the latest scan.</Text>
    </Stack>
  );
}
