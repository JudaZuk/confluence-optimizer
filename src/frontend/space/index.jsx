import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Stack, Text, Heading, Tabs, TabList, Tab, TabPanel, Box, SectionMessage, useProductContext } from '@forge/react';
import { call } from '../components/api.js';
import { ErrorMessage, Loading } from '../components/ui.jsx';
import { ScanStatus } from '../components/ScanStatus.jsx';
import { Overview } from '../components/Overview.jsx';
import { AttachmentExplorer } from '../components/AttachmentExplorer.jsx';
import { TrashReport } from '../components/TrashReport.jsx';
import { ReviewQueue } from '../components/ReviewQueue.jsx';

/** Space-level storage cleanup for space admins. Scope is enforced on the server. */
function SpaceApp() {
  const context = useProductContext();
  const [status, setStatus] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [tab, setTab] = useState(0);
  const [preset, setPreset] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const st = await call('getStatus');
        setStatus(st);
        if (st.ready) setSummary(await call('getSpaceSummary'));
      } catch (err) {
        if (err.forbidden) setForbidden(true);
        setError(err.message);
      }
    })();
  }, []);

  // Figures are calculated in the background; poll until they are current.
  const summaryBusy = Boolean(summary?.pending || summary?.refreshing);
  useEffect(() => {
    if (!summaryBusy) return undefined;
    const timer = setTimeout(async () => {
      const next = await call('getSpaceSummary').catch(() => null);
      if (next) setSummary(next);
    }, 10000);
    return () => clearTimeout(timer);
  }, [summaryBusy, summary]);

  if (forbidden) {
    return (
      <SectionMessage appearance="error" title="Space admins only">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!status) return error ? <ErrorMessage error={error} /> : <Loading />;
  if (!status.ready) return <Loading label="The app is still being set up. Try again in a minute." />;

  const canRequest = status.settings.allowSpaceAdminRequests;
  const review = (finding) => {
    setPreset({ finding, nonce: Date.now() });
    setTab(1);
  };

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Heading size="large">{`Storage cleanup – ${status.scope.spaceKey}`}</Heading>
        <Text>
          See what takes up storage in this space and request cleanup. A Confluence administrator approves every request
          before anything changes. Scans are started by your Confluence administrator.
        </Text>
      </Stack>
      <ScanStatus scan={status.scan} usage={status.usage} isAdmin={false} />
      <ErrorMessage error={error} />
      <Tabs id="coam-space-tabs" selected={tab} onChange={(i) => setTab(i)}>
        <TabList>
          <Tab>Overview</Tab>
          <Tab>Attachments</Tab>
          <Tab>Trash</Tab>
          <Tab>Requests</Tab>
        </TabList>
        <TabPanel>
          <Box padding="space.200">
            <Overview summary={summary} onReview={review} isSite={false} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box padding="space.200">
            <AttachmentExplorer mode="space" preset={preset} settings={status.settings} canRequest={canRequest} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box padding="space.200">
            {tab === 2 ? <TrashReport mode="space" summary={summary} settings={status.settings} canRequest={canRequest} /> : null}
          </Box>
        </TabPanel>
        <TabPanel>
          <Box padding="space.200">{tab === 3 ? <ReviewQueue mode="space" accountId={context?.accountId} /> : null}</Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <SpaceApp />
  </React.StrictMode>,
);
