import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Stack, Text, Tabs, TabList, Tab, TabPanel, Box, SectionMessage, Button, Inline, useProductContext } from '@forge/react';
import { call } from '../components/api.js';
import { ErrorMessage, Loading } from '../components/ui.jsx';
import { ScanStatus } from '../components/ScanStatus.jsx';
import { Overview } from '../components/Overview.jsx';
import { AttachmentExplorer } from '../components/AttachmentExplorer.jsx';
import { TrashReport } from '../components/TrashReport.jsx';
import { ReviewQueue } from '../components/ReviewQueue.jsx';
import { AuditLog } from '../components/AuditLog.jsx';
import { SettingsPanel } from '../components/SettingsPanel.jsx';

const TAB_ATTACHMENTS = 1;

function AdminApp() {
  const context = useProductContext();
  const [status, setStatus] = useState(null);
  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const [error, setError] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [tab, setTab] = useState(0);
  const [preset, setPreset] = useState(null);

  const loadStatus = async () => {
    try {
      setStatus(await call('getStatus'));
    } catch (err) {
      if (err.forbidden) setForbidden(true);
      setError(err.message);
    }
  };

  const loadData = async (refresh = false) => {
    try {
      const [s, h, sp] = await Promise.all([call('getSummary', { refresh }), call('getHistory'), call('listSpaces')]);
      setSummary(s);
      setHistory(h || []);
      setSpaces(sp || []);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    loadStatus();
    loadData();
  }, []);

  // While a scan runs, poll its progress and reload figures when it ends.
  const running = status?.scan?.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(async () => {
      const next = await call('getStatus').catch(() => null);
      if (!next) return;
      setStatus(next);
      if (next.scan?.status !== 'running') loadData();
    }, 5000);
    return () => clearInterval(timer);
  }, [running]);

  // Figures are calculated in the background; poll until they are current.
  const summaryBusy = Boolean(summary?.pending || summary?.refreshing);
  useEffect(() => {
    if (!summaryBusy) return undefined;
    const timer = setTimeout(async () => {
      const next = await call('getSummary').catch(() => null);
      if (next) setSummary(next);
    }, 10000);
    return () => clearTimeout(timer);
  }, [summaryBusy, summary]);

  // Until the database exists (first minutes after install), check again.
  useEffect(() => {
    if (!status || status.ready) return undefined;
    const timer = setTimeout(() => { loadStatus(); loadData(); }, 10000);
    return () => clearTimeout(timer);
  }, [status]);

  if (forbidden) {
    return (
      <SectionMessage appearance="error" title="Administrators only">
        <Text>Only Confluence administrators can use this page. Space admins can find storage cleanup in their space settings.</Text>
      </SectionMessage>
    );
  }
  if (!status) return error ? <ErrorMessage error={error} /> : <Loading />;
  if (!status.ready) return <Loading label="Setting up the app database. This takes a minute after installing or upgrading…" />;

  const startScan = async () => {
    try {
      await call('startScan');
      await loadStatus();
    } catch (err) {
      setError(err.message);
    }
  };
  const cancelScan = async () => {
    await call('cancelScan').catch((err) => setError(err.message));
    await loadStatus();
  };
  const review = (finding) => {
    setPreset({ finding, nonce: Date.now() });
    setTab(TAB_ATTACHMENTS);
  };

  return (
    <Stack space="space.300">
      <Text>Find what fills your Confluence storage and clean it up safely: every change is reviewed, approved and logged.</Text>
      <ScanStatus scan={status.scan} isAdmin onStart={startScan} onCancel={cancelScan} />
      <ErrorMessage error={error} />
      <Tabs id="coam-admin-tabs" selected={tab} onChange={(i) => setTab(i)}>
        <TabList>
          <Tab>Overview</Tab>
          <Tab>Attachments</Tab>
          <Tab>Trash</Tab>
          <Tab>Review queue</Tab>
          <Tab>Audit log</Tab>
          <Tab>Settings</Tab>
        </TabList>
        <TabPanel>
          <Box padding="space.200">
            <Stack space="space.200">
              {status.summaryStale ? (
                <SectionMessage appearance="information">
                  <Inline space="space.100" alignBlock="center">
                    <Text>Cleanup jobs have finished since these figures were calculated.</Text>
                    <Button onClick={() => loadData(true)}>Refresh figures</Button>
                  </Inline>
                </SectionMessage>
              ) : null}
              <Overview summary={summary} history={history} onReview={review} isSite />
            </Stack>
          </Box>
        </TabPanel>
        <TabPanel>
          <Box padding="space.200">
            <AttachmentExplorer mode="admin" spaces={spaces} preset={preset} settings={status.settings} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box padding="space.200">
            {tab === 2 ? <TrashReport mode="admin" summary={summary} spaces={spaces} settings={status.settings} canRequest /> : null}
          </Box>
        </TabPanel>
        <TabPanel>
          <Box padding="space.200">
            {tab === 3 ? <ReviewQueue mode="admin" accountId={context?.accountId} /> : null}
          </Box>
        </TabPanel>
        <TabPanel>
          <Box padding="space.200">{tab === 4 ? <AuditLog /> : null}</Box>
        </TabPanel>
        <TabPanel>
          <Box padding="space.200">{tab === 5 ? <SettingsPanel onSaved={loadStatus} /> : null}</Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>,
);
