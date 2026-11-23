import React, { useEffect, useState } from 'react';
import { Stack, Inline, Text, Button, Textfield, Toggle, SectionMessage } from '@forge/react';
import { call } from './api.js';
import { ErrorMessage, FieldLabel, Loading, Section } from './ui.jsx';

function NumberField({ label, help, value, onChange }) {
  return (
    <Stack space="space.050">
      <FieldLabel>{label}</FieldLabel>
      <Textfield value={String(value ?? '')} onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))} />
      {help ? <Text>{help}</Text> : null}
    </Stack>
  );
}

function ToggleField({ label, help, value, onChange }) {
  return (
    <Stack space="space.050">
      <Inline space="space.100" alignBlock="center">
        <Toggle isChecked={Boolean(value)} onChange={() => onChange(!value)} />
        <FieldLabel>{label}</FieldLabel>
      </Inline>
      {help ? <Text>{help}</Text> : null}
    </Stack>
  );
}

export function SettingsPanel({ onSaved }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call('getSettings').then(setS).catch((err) => setError(err.message));
  }, []);

  if (!s) return error ? <ErrorMessage error={error} /> : <Loading />;
  const set = (patch) => { setS({ ...s, ...patch }); setSaved(false); };
  const setR = (patch) => set({ retention: { ...s.retention, ...patch } });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setS(await call('saveSettings', { settings: { ...s, exemptSpaceKeys: s.exemptSpaceKeysText ?? s.exemptSpaceKeys } }));
      setSaved(true);
      if (onSaved) onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack space="space.400">
      <ErrorMessage error={error} />
      {saved ? <SectionMessage appearance="success"><Text>Settings saved. Changes to thresholds show after the next scan or refresh.</Text></SectionMessage> : null}

      <Section title="Storage and thresholds">
        <NumberField label="Storage limit (GB)" help="250 GB on Confluence Cloud Standard. Used for the usage bar and the health score." value={s.storageQuotaGb} onChange={(v) => set({ storageQuotaGb: v })} />
        <NumberField label="Stale after (months without edits)" value={s.staleMonths} onChange={(v) => set({ staleMonths: v })} />
        <NumberField label="Unused files: minimum age (days)" help="Recently uploaded files are never flagged as unused." value={s.unusedMinAgeDays} onChange={(v) => set({ unusedMinAgeDays: v })} />
        <NumberField label="Versions to keep per file" help="Older versions beyond this count are shown as reclaimable." value={s.keepVersions} onChange={(v) => set({ keepVersions: v })} />
        <NumberField label="Large file threshold (MB)" value={s.largeFileMb} onChange={(v) => set({ largeFileMb: v })} />
        <Stack space="space.050">
          <FieldLabel>Exempt spaces (comma-separated space keys)</FieldLabel>
          <Textfield
            value={s.exemptSpaceKeysText ?? (s.exemptSpaceKeys || []).join(', ')}
            onChange={(e) => set({ exemptSpaceKeysText: e.target.value })}
          />
          <Text>Exempt spaces still count in reports but are never suggested for cleanup, including by retention rules.</Text>
        </Stack>
      </Section>

      <Section title="Scanning">
        <NumberField label="Automatic scan every (days)" help="0 turns automatic scans off. A daily check starts the scan when it is due." value={s.scanIntervalDays} onChange={(v) => set({ scanIntervalDays: v })} />
        <ToggleField
          label="Analyse page content to find unused attachments"
          help="Reads page bodies during the scan (nothing is stored). Turn off for very large sites if scans take too long."
          value={s.scanBodies}
          onChange={(v) => set({ scanBodies: v })}
        />
      </Section>

      <Section title="Delegation">
        <ToggleField
          label="Space admins can request cleanup for their space"
          help="Space admins find the app under Space settings. Their requests still need approval by a Confluence administrator."
          value={s.allowSpaceAdminRequests}
          onChange={(v) => set({ allowSpaceAdminRequests: v })}
        />
      </Section>

      <Section title="Retention rules">
        <SectionMessage appearance="information">
          <Text>Rules run after each scan and only create requests in the review queue. Nothing is deleted without approval. Set a value to 0 to turn a rule off.</Text>
        </SectionMessage>
        <NumberField
          label="Propose purging trash older than (days)"
          help="Counted from when the app first saw the item in the trash, so items are never purged before the grace period, even on the first scan."
          value={s.retention.purgeTrashAfterDays}
          onChange={(v) => setR({ purgeTrashAfterDays: v })}
        />
        <NumberField label="Propose deleting versions beyond the newest" value={s.retention.pruneVersionsKeep} onChange={(v) => setR({ pruneVersionsKeep: v })} />
        <NumberField label="Propose trashing unused files unchanged for (days)" value={s.retention.trashUnusedAfterDays} onChange={(v) => setR({ trashUnusedAfterDays: v })} />
      </Section>

      <Inline>
        <Button appearance="primary" onClick={save} isDisabled={busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
      </Inline>
    </Stack>
  );
}
