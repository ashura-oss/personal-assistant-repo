import React, { useEffect, useRef, useState } from 'react';
import { Modal, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ContextDocument } from '../core';
import type { WorkspaceActionCapability } from './workspaceCapabilities';
import { Button, IconButton } from './primitives';
import { C, s } from './theme';

export type EditableWorkspaceDocument = Pick<ContextDocument, 'path' | 'content'> & Readonly<{ revision?: number }>;
export type WorkspaceDocumentSaveResult = Readonly<{ revision?: number; snapshotUpdated: boolean }>;
export type WorkspaceDocumentSaveAction = (input: Readonly<{ path: string; content: string; expectedRevision: number | null }>) => Promise<WorkspaceDocumentSaveResult>;

type Props = Readonly<{
  visible: boolean;
  document?: EditableWorkspaceDocument;
  currentDocuments: readonly EditableWorkspaceDocument[];
  busy: boolean;
  saveAction: WorkspaceActionCapability<WorkspaceDocumentSaveAction>;
  onClose: () => void;
}>;

export function WorkspaceDocumentEditor({ visible, document, currentDocuments, busy, saveAction, onClose }: Props) {
  const [draft, setDraft] = useState(() => document?.content ?? '');
  const [baselineRevision, setBaselineRevision] = useState<number | null>(() => document?.revision ?? null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const operation = useRef<object | undefined>(undefined);
  const path = document?.path ?? '';
  const current = currentDocuments.find((item) => item.path === path);
  const latestRevision = current?.revision ?? null;
  const currentChanged = Boolean(document && latestRevision !== baselineRevision);

  useEffect(() => () => { operation.current = undefined; }, []);

  const close = () => {
    operation.current = undefined;
    setSaving(false);
    onClose();
  };

  const reload = () => {
    if (!document || !current) {
      setMessage('This document is no longer in the workspace. Close it and create a new document if needed.');
      return;
    }
    setDraft(current.content);
    setBaselineRevision(current.revision ?? null);
    setConflicted(false);
    setMessage('Loaded the saved version.');
  };

  const save = async () => {
    if (!saveAction.available || !document || busy || saving || operation.current || conflicted || currentChanged || !path) return;
    const token = {};
    operation.current = token;
    setSaving(true);
    setMessage('');
    try {
      const result = await saveAction.action({ path, content: draft, expectedRevision: baselineRevision });
      if (operation.current !== token) return;
      if (result.revision !== undefined) setBaselineRevision(result.revision);
      setConflicted(false);
      setMessage(result.snapshotUpdated ? 'Document saved.' : 'Document saved. Refresh the workspace to load its current version.');
    } catch (error) {
      if (operation.current !== token) return;
      const latest = currentDocuments.find((item) => item.path === path);
      if ((latest?.revision ?? null) !== baselineRevision) setConflicted(true);
      setMessage(error instanceof Error ? error.message : 'The document could not be confirmed. Inspect the workspace before trying again.');
    } finally {
      if (operation.current === token) {
        operation.current = undefined;
        setSaving(false);
      }
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <SafeAreaView style={s.modalSafe}>
        <View style={s.modalHeader}>
          <IconButton name="chevron-back" label="Back to library" onPress={close} />
          <Text style={s.modalTitle}>{document?.path ?? 'Document'}</Text>
          <Button label={saving ? 'Saving…' : 'Save'} onPress={() => { void save(); }} disabled={!saveAction.available || !document || busy || saving || conflicted || currentChanged} />
        </View>
        {currentChanged || conflicted ? <View style={s.analysisStale}>
          <Text style={s.analysisText}>The saved version changed while this document was open. Your draft is still here. Reload the saved version before making another change.</Text>
          <Button label="Reload saved document" tone="quiet" onPress={reload} disabled={busy || saving || !current} />
        </View> : null}
        <TextInput
          multiline
          value={draft}
          onChangeText={setDraft}
          editable={!busy && !saving}
          style={{ ...s.input, ...s.docEditor }}
          placeholder="Write a note or personal rule…"
          placeholderTextColor={C.muted}
          accessibilityLabel="Document content"
        />
        {!saveAction.available ? <Text style={s.noteSub}>{saveAction.reason}</Text> : null}
        {message ? <Text accessibilityRole="alert" style={s.knowledgeError}>{message}</Text> : null}
      </SafeAreaView>
    </Modal>
  );
}
