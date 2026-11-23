import React from 'react';
import {
  Box, Stack, Inline, Heading, Text, Strong, SectionMessage, Spinner, Lozenge, xcss,
  Modal, ModalHeader, ModalTitle, ModalBody, ModalFooter, ModalTransition, Button, TextArea,
} from '@forge/react';
import { REQUEST_STATUS_APPEARANCE } from '../../shared/format.js';

const cardStyle = xcss({
  padding: 'space.200',
  borderRadius: 'border.radius',
  backgroundColor: 'color.background.neutral.subtle',
  borderColor: 'color.border',
  borderWidth: 'border.width',
  borderStyle: 'solid',
});

export function Card({ children }) {
  return <Box xcss={cardStyle}>{children}</Box>;
}

/** Key figure tile. */
export function Kpi({ label, value, detail }) {
  return (
    <Card>
      <Stack space="space.050">
        <Text>{label}</Text>
        <Heading size="medium">{value}</Heading>
        {typeof detail === 'string' ? <Text>{detail}</Text> : detail || null}
      </Stack>
    </Card>
  );
}

export function Section({ title, actions, children }) {
  return (
    <Stack space="space.150">
      <Inline spread="space-between" alignBlock="center">
        <Heading size="small">{title}</Heading>
        {actions || null}
      </Inline>
      {children}
    </Stack>
  );
}

export function Loading({ label = 'Loading…' }) {
  return (
    <Inline space="space.100" alignBlock="center">
      <Spinner size="medium" />
      <Text>{label}</Text>
    </Inline>
  );
}

export function ErrorMessage({ error }) {
  if (!error) return null;
  return (
    <SectionMessage appearance="error" title="Something went wrong">
      <Text>{error}</Text>
    </SectionMessage>
  );
}

export function StatusLozenge({ status }) {
  return <Lozenge appearance={REQUEST_STATUS_APPEARANCE[status] || 'default'}>{status}</Lozenge>;
}

export function FieldLabel({ children }) {
  return (
    <Text>
      <Strong>{children}</Strong>
    </Text>
  );
}

/** Shows exported CSV text so it can be copied into a file or spreadsheet. */
export function CsvModal({ csv, rows, truncated, onClose }) {
  return (
    <ModalTransition>
      {csv !== null && csv !== undefined ? (
        <Modal onClose={onClose} width="x-large">
          <ModalHeader>
            <ModalTitle>CSV export ({rows} rows)</ModalTitle>
          </ModalHeader>
          <ModalBody>
            <Stack space="space.100">
              <Text>
                Select all the text below (Ctrl/Cmd+A inside the box), copy it, and paste it into a .csv file or a spreadsheet.
              </Text>
              {truncated ? (
                <SectionMessage appearance="warning">
                  <Text>The export is limited to 5,000 rows. Narrow the filters to export the rest.</Text>
                </SectionMessage>
              ) : null}
              <TextArea value={csv} isReadOnly resize="vertical" minimumRows={16} />
            </Stack>
          </ModalBody>
          <ModalFooter>
            <Button onClick={onClose}>Close</Button>
          </ModalFooter>
        </Modal>
      ) : null}
    </ModalTransition>
  );
}
