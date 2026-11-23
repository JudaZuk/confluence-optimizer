import React, { useState } from 'react';
import {
  Modal, ModalHeader, ModalTitle, ModalBody, ModalFooter, ModalTransition,
  Button, Stack, Text, Strong, TextArea, Textfield, SectionMessage,
} from '@forge/react';
import { ACTION_LABELS, IRREVERSIBLE_ACTIONS, formatBytes, countOf } from '../../shared/format.js';
import { FieldLabel } from './ui.jsx';

const EXPLANATIONS = {
  trash_attachment:
    'Files move to the space trash, where space admins can restore them. Storage is freed only when the trash is purged, for example by a purge request or a retention rule.',
  purge_attachment: 'Files are permanently deleted from the trash. This cannot be undone.',
  prune_versions:
    'Older versions of each file are permanently deleted and only the newest versions are kept. The file itself stays on its page. This cannot be undone.',
  purge_page: 'Pages and blog posts are permanently deleted from the trash, together with their attachments. This cannot be undone.',
};

/**
 * Confirmation dialog for a new cleanup request.
 * The request goes to the review queue; nothing changes until an admin approves it.
 */
export function RequestModal({ request, isAdmin, onConfirm, onClose }) {
  const [note, setNote] = useState('');
  const [keep, setKeep] = useState(String(request?.keep || 3));
  const [busy, setBusy] = useState(false);
  if (!request) return <ModalTransition>{null}</ModalTransition>;
  const irreversible = IRREVERSIBLE_ACTIONS.has(request.action);

  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm({ note, params: request.action === 'prune_versions' ? { keep: parseInt(keep, 10) || 1 } : {} });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalTransition>
      <Modal onClose={onClose}>
        <ModalHeader>
          <ModalTitle appearance={irreversible ? 'danger' : undefined}>{ACTION_LABELS[request.action]}</ModalTitle>
        </ModalHeader>
        <ModalBody>
          <Stack space="space.150">
            <Text>
              <Strong>{request.label}</Strong>
              {request.bytes ? ` · about ${formatBytes(request.bytes)}` : ''}
              {request.count ? ` · ${countOf(request.count, 'item')}` : ''}
            </Text>
            <SectionMessage appearance={irreversible ? 'warning' : 'information'}>
              <Text>{EXPLANATIONS[request.action]}</Text>
            </SectionMessage>
            <Text>
              This creates a request in the review queue.{' '}
              {isAdmin
                ? 'Nothing changes until it is approved in the Review queue tab.'
                : 'A Confluence administrator must approve it before anything changes.'}{' '}
              Every item is checked again right before it is changed, and every change is written to the audit log.
            </Text>
            {request.action === 'prune_versions' ? (
              <Stack space="space.050">
                <FieldLabel>Versions to keep per file</FieldLabel>
                <Textfield value={keep} onChange={(e) => setKeep(e.target.value.replace(/[^0-9]/g, ''))} />
              </Stack>
            ) : null}
            <Stack space="space.050">
              <FieldLabel>Reason (shown to the approver and kept in the audit log)</FieldLabel>
              <TextArea value={note} onChange={(e) => setNote(e.target.value)} />
            </Stack>
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button appearance="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button appearance={irreversible ? 'danger' : 'primary'} onClick={submit} isDisabled={busy}>
            {busy ? 'Submitting…' : 'Submit for review'}
          </Button>
        </ModalFooter>
      </Modal>
    </ModalTransition>
  );
}
