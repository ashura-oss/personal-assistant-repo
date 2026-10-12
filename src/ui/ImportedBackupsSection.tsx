import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Switch, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppController, ContextDocument } from "../core";
import type { ImportedBackupArchive } from "../backup";
import { Button, Field, IconButton } from "./primitives";
import { C, s } from "./theme";

export function ImportedBackupsSection({
  archives,
  currentDocuments,
  controller,
  busy,
  query,
}: {
  archives: ImportedBackupArchive[];
  currentDocuments: ContextDocument[];
  controller: AppController;
  busy: boolean;
  query: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ archiveId: string; documentId: string } | null>(null);
  const [selectedHistory, setSelectedHistory] = useState<{ archiveId: string; entryId: string } | null>(null);
  const [destinationPath, setDestinationPath] = useState("");
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [replaceConfirmationKey, setReplaceConfirmationKey] = useState("");
  const [digestResult, setDigestResult] = useState({ key: "", digest: "" });
  const [activationKey, setActivationKey] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [visibleDocumentCounts, setVisibleDocumentCounts] = useState<Record<string, number>>({});
  const [visibleHistoryCounts, setVisibleHistoryCounts] = useState<Record<string, number>>({});
  const activationRequest = useRef(0);
  const visibleSelectionKey = useRef("");
  const filter = query.trim().toLocaleLowerCase();
  const visibleArchives = useMemo(() => archives.flatMap((archive) => {
    const documents = archive.documents.filter((document) =>
      !filter || document.path.toLocaleLowerCase().includes(filter) || document.content.toLocaleLowerCase().includes(filter),
    );
    const history = archive.history.filter((entry) =>
      !filter || [entry.title, entry.status, entry.provider, entry.reference, entry.content]
        .some((value) => value?.toLocaleLowerCase().includes(filter)),
    );
    const metadataMatches = !filter || [archive.sourceFormat, archive.exportedAt]
      .some((value) => value.toLocaleLowerCase().includes(filter));
    return !filter || metadataMatches || documents.length > 0 || history.length > 0
      ? [{ archive, documents: filter ? documents : archive.documents, history: filter ? history : archive.history }]
      : [];
  }), [archives, filter]);
  const selectedArchive = selected ? archives.find((archive) => archive.id === selected.archiveId) : undefined;
  const selectedDocument = selectedArchive?.documents.find((document) => document.id === selected?.documentId);
  const selectedHistoryArchive = selectedHistory ? archives.find((archive) => archive.id === selectedHistory.archiveId) : undefined;
  const selectedHistoryEntry = selectedHistoryArchive?.history.find((entry) => entry.id === selectedHistory?.entryId);
  const existingDocument = destinationPath
    ? currentDocuments.find((document) => document.path === destinationPath.trim())
    : undefined;
  const confirmationContext = JSON.stringify({
    archiveId: selected?.archiveId,
    documentId: selectedDocument?.id,
    archivedContent: selectedDocument?.content,
    archivedContentDigest: digestResult.digest,
    destinationPath: destinationPath.trim(),
    currentRevision: existingDocument?.revision ?? null,
    currentContent: existingDocument?.content ?? null,
  });
  const replaceIsConfirmed = replaceConfirmed && replaceConfirmationKey === confirmationContext;
  const selectionKey = JSON.stringify({
    selected: selected ? [selected.archiveId, selected.documentId] : null,
    content: selectedDocument?.content,
    archivedRevision: selectedDocument?.revision,
    destinationPath: destinationPath.trim(),
    currentRevision: existingDocument?.revision,
    currentContent: existingDocument?.content,
  });
  useLayoutEffect(() => {
    if (visibleSelectionKey.current !== selectionKey) {
      visibleSelectionKey.current = selectionKey;
      activationRequest.current += 1;
    }
  }, [selectionKey]);
  const activating = Boolean(activationKey && activationKey === selectionKey);
  const digestKey = JSON.stringify({
    archiveId: selected?.archiveId,
    documentId: selectedDocument?.id,
    content: selectedDocument?.content,
  });
  const digest = digestResult.key === digestKey ? digestResult.digest : "";

  useEffect(() => {
    let active = true;
    if (selectedDocument) {
      void Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        selectedDocument.content,
        { encoding: Crypto.CryptoEncoding.HEX },
      ).then((value) => { if (active) setDigestResult({ key: digestKey, digest: value }); })
        .catch(() => { if (active) setError("Still could not prepare the document integrity check."); });
    }
    return () => { active = false; };
  }, [digestKey, selectedDocument]);

  const openDocument = (archive: ImportedBackupArchive, documentId: string) => {
    const document = archive.documents.find((item) => item.id === documentId);
    if (!document) return;
    setError("");
    setNotice("");
    setActivationKey("");
    activationRequest.current += 1;
    setSelected({ archiveId: archive.id, documentId });
    setDestinationPath(document.path);
    setDigestResult({ key: "", digest: "" });
    setReplaceConfirmed(false);
    setReplaceConfirmationKey("");
  };

  const closeDocument = () => {
    if (activating) return;
    activationRequest.current += 1;
    setActivationKey("");
    setSelected(null);
    setDigestResult({ key: "", digest: "" });
    setReplaceConfirmed(false);
    setReplaceConfirmationKey("");
    setError("");
    setNotice("");
    setReplaceConfirmed(false);
  };

  const activate = async () => {
    if (!selected || !selectedDocument || !digest || !destinationPath.trim() || activating || busy) return;
    if (existingDocument && existingDocument.content !== selectedDocument.content && !replaceIsConfirmed) return;
    const request = ++activationRequest.current;
    const requestKey = selectionKey;
    setActivationKey(requestKey);
    setError("");
    setNotice("");
    try {
      const result = await controller.activateImportedDocument({
        archiveId: selected.archiveId,
        documentId: selectedDocument.id,
        destinationPath: destinationPath.trim(),
        contentDigest: digest,
        ...(existingDocument ? { expectedCurrentRevision: existingDocument.revision } : {}),
        replaceConfirmed: Boolean(existingDocument && replaceIsConfirmed),
      });
      if (activationRequest.current === request && visibleSelectionKey.current === requestKey) {
        setNotice(result.status === "unchanged"
          ? "This exact document is already in your active context."
          : result.mirrorPending
            ? "Saved in your context. The local file mirror will retry later."
            : "Saved as an active context document.");
      }
    } catch (cause) {
      if (activationRequest.current === request && visibleSelectionKey.current === requestKey) {
        setError(messageOf(cause, "This document could not be activated. Refresh the library and review the current text before trying again."));
      }
    } finally {
      if (activationRequest.current === request) setActivationKey("");
    }
  };

  if (archives.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={s.sectionTitle}>Imported backups</Text>
      <Text style={styles.caption}>Imported history is an unverified, read-only record. It cannot approve, send, retry, or execute actions.</Text>
      {visibleArchives.length ? visibleArchives.map(({ archive, documents, history }) => {
        const isOpen = expanded.has(archive.id);
        const documentLimit = visibleDocumentCounts[archive.id] ?? 25;
        const historyLimit = visibleHistoryCounts[archive.id] ?? 25;
        const shownDocuments = documents.slice(0, documentLimit);
        const shownHistory = history.slice(0, historyLimit);
        const toggle = () => setExpanded((current) => {
          const next = new Set(current);
          if (next.has(archive.id)) next.delete(archive.id); else next.add(archive.id);
          return next;
        });
        return (
          <View key={archive.id} style={styles.archiveCard}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${isOpen ? "Hide" : "Show"} imported backup from ${new Date(archive.exportedAt).toLocaleDateString()}`} accessibilityState={{ expanded: isOpen }} onPress={toggle} style={styles.archiveHeader}>
              <View style={styles.archiveCopy}>
                <Text style={styles.archiveTitle}>Imported backup · {archive.sourceFormat === "voice-assistant-export-v1" ? "Legacy v1" : archive.sourceFormat === "still-backup-v2" ? "Still v2" : archive.sourceFormat === "still-backup-v3" ? "Still v3" : "Unknown backup version"}</Text>
                <Text style={styles.caption}>Exported {new Date(archive.exportedAt).toLocaleDateString()} · added {new Date(archive.importedAt).toLocaleDateString()}</Text>
                <Text style={styles.caption}>{archive.noteLinks.length} notes · {archive.taskLinks.length} tasks · {archive.documents.length} archived documents · {archive.history.length} historical records</Text>
              </View>
              <Text style={styles.chevron}>{isOpen ? "−" : "+"}</Text>
            </Pressable>
            {isOpen ? (
              <View style={styles.archiveBody}>
                <Text style={styles.notice}>Imported and unverified · active credentials and approvals were not restored.</Text>
                {archive.noteLinks.length ? <Text style={styles.subheading}>Notes are in your Library. Missing recordings are marked on each imported note.</Text> : null}
                {archive.taskLinks.length ? <Text style={styles.subheading}>Imported tasks are listed with their Imported label.</Text> : null}
                {archive.documents.length ? (
                  <View style={styles.subsection}>
                    <Text style={styles.subheading}>Archived documents</Text>
                    {shownDocuments.map((document) => (
                      <View key={document.id} style={styles.documentCard}>
                        <Text style={styles.documentPath}>{document.path}</Text>
                        <Text style={styles.caption}>Imported document · inactive until you choose to use it as context</Text>
                        {document.activatedPath ? <Text style={styles.caption}>Active context copy · {document.activatedPath}</Text> : null}
                        <Button label="Use as assistant context" tone="quiet" onPress={() => openDocument(archive, document.id)} />
                      </View>
                    ))}
                    {shownDocuments.length < documents.length ? (
                      <Button label={`Show ${Math.min(25, documents.length - shownDocuments.length)} more documents`} tone="quiet" onPress={() => setVisibleDocumentCounts((current) => ({ ...current, [archive.id]: documentLimit + 25 }))} />
                    ) : null}
                  </View>
                ) : null}
                {history.length ? (
                  <View style={styles.subsection}>
                    <Text style={styles.subheading}>Historical records · not independently verified</Text>
                    {shownHistory.map((entry) => (
                      <Pressable key={entry.id} accessibilityRole="button" accessibilityLabel={`Read imported historical record ${entry.title}`} onPress={() => setSelectedHistory({ archiveId: archive.id, entryId: entry.id })} style={styles.historyEntry}>
                        <Text style={styles.documentPath}>{entry.title}</Text>
                        <Text style={styles.caption}>{entry.status} · {entry.occurredAt ? new Date(entry.occurredAt).toLocaleString() : "Original time unavailable"}</Text>
                        {entry.provider ? <Text style={styles.caption}>Provider label · {entry.provider}</Text> : null}
                        {entry.reference ? <Text style={styles.caption}>Recorded reference · {entry.reference}</Text> : null}
                        <Text style={styles.caption}>Read unverified details</Text>
                      </Pressable>
                    ))}
                    {shownHistory.length < history.length ? (
                      <Button label={`Show ${Math.min(25, history.length - shownHistory.length)} more records`} tone="quiet" onPress={() => setVisibleHistoryCounts((current) => ({ ...current, [archive.id]: historyLimit + 25 }))} />
                    ) : null}
                  </View>
                ) : <Text style={styles.caption}>No historical records in this backup.</Text>}
              </View>
            ) : null}
          </View>
        );
      }) : <Text style={styles.caption}>No imported backup matches this search.</Text>}

      <Modal visible={Boolean(selectedDocument)} animationType="slide" onRequestClose={closeDocument} presentationStyle="fullScreen">
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <IconButton name="chevron-back" label="Close imported document review" onPress={closeDocument} />
            <Text style={styles.modalTitle}>Review context</Text>
            <View style={{ width: 46 }} />
          </View>
          <ScrollView contentContainerStyle={styles.modalContent} showsVerticalScrollIndicator={false}>
            {selectedDocument && selected ? <>
              <Text style={s.kicker}>IMPORTED DOCUMENT · INACTIVE</Text>
              <Text style={s.h1Small}>{selectedDocument.path}</Text>
              <Text selectable style={styles.documentText}>{selectedDocument.content}</Text>
              <Text style={styles.caption}>This content is kept as an inert archive until you explicitly choose a safe Markdown path for active assistant context.</Text>
              <Field label="Destination Markdown path" value={destinationPath} onChangeText={(value) => { setDestinationPath(value); setReplaceConfirmed(false); setError(""); setNotice(""); }} placeholder="memory/PROFILE.md" />
              {existingDocument ? (
                <View style={styles.diffCard}>
                  <Text style={styles.subheading}>{existingDocument.content === selectedDocument.content ? "Current document has identical content" : "Current context at this path"}</Text>
                  <Text style={styles.caption}>Current revision · {existingDocument.revision} · {existingDocument.path}</Text>
                  <Text selectable style={styles.diffText}>{existingDocument.content}</Text>
                  {existingDocument.content !== selectedDocument.content ? <>
                    <Text style={styles.subheading}>Imported replacement</Text>
                    <Text selectable style={styles.diffText}>{selectedDocument.content}</Text>
                    <View style={styles.switchRow}>
                  <Text style={styles.switchCopy}>Replace this active context document. Its current text remains in the imported archive.</Text>
                      <Switch value={replaceIsConfirmed} onValueChange={(value) => { setReplaceConfirmed(value); setReplaceConfirmationKey(value ? confirmationContext : ""); }} accessibilityLabel="Confirm replacing current context document" />
                    </View>
                  </> : null}
                </View>
              ) : <Text style={styles.caption}>No current document exists at this destination; the archived copy will be added only after you confirm.</Text>}
              <Text style={styles.disclaimer}>The selected text is not treated as trusted instructions until you activate it. The saved archive copy remains read-only.</Text>
              {notice ? <Text style={styles.notice}>{notice}</Text> : null}
              {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
              <Button label={activating ? "Saving context…" : existingDocument?.content === selectedDocument.content ? "Use existing context" : "Activate this document"}
                disabled={busy || activating || !digest || !destinationPath.trim() || Boolean(existingDocument && existingDocument.content !== selectedDocument.content && !replaceIsConfirmed)}
                onPress={() => void activate()} />
            </> : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
      <Modal visible={Boolean(selectedHistoryEntry)} animationType="slide" onRequestClose={() => setSelectedHistory(null)} presentationStyle="fullScreen">
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <IconButton name="chevron-back" label="Close historical record" onPress={() => setSelectedHistory(null)} />
            <Text style={styles.modalTitle}>Imported history</Text>
            <View style={{ width: 46 }} />
          </View>
          <ScrollView contentContainerStyle={styles.modalContent} showsVerticalScrollIndicator={false}>
            {selectedHistoryEntry ? <>
              <Text style={s.kicker}>UNVERIFIED · READ ONLY</Text>
              <Text style={s.h1Small}>{selectedHistoryEntry.title}</Text>
              <Text style={styles.caption}>{selectedHistoryEntry.status} · {selectedHistoryEntry.occurredAt ? new Date(selectedHistoryEntry.occurredAt).toLocaleString() : "Original time unavailable"}</Text>
              {selectedHistoryEntry.provider ? <Text style={styles.caption}>Provider label · {selectedHistoryEntry.provider}</Text> : null}
              {selectedHistoryEntry.reference ? <Text style={styles.caption}>Recorded reference · {selectedHistoryEntry.reference}</Text> : null}
              <Text selectable style={styles.documentText}>{selectedHistoryEntry.content}</Text>
              <Text style={styles.disclaimer}>This is a readable historical claim from an imported backup. It has no action or approval controls.</Text>
            </> : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

function messageOf(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

const styles = {
  section: { gap: 10, marginTop: 18 },
  caption: { color: C.muted, fontSize: 11, lineHeight: 17 },
  archiveCard: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 15, overflow: "hidden" as const },
  archiveHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, padding: 14, minHeight: 62 },
  archiveCopy: { flex: 1, gap: 3 },
  archiveTitle: { color: C.text, fontSize: 13, lineHeight: 18, fontWeight: "600" as const },
  chevron: { color: C.muted, fontSize: 22, minWidth: 24, textAlign: "center" as const },
  archiveBody: { borderTopWidth: 1, borderTopColor: C.border, padding: 13, gap: 12 },
  notice: { color: C.sage, fontSize: 12, lineHeight: 18 },
  subheading: { color: C.text, fontSize: 12, lineHeight: 17, fontWeight: "600" as const },
  subsection: { gap: 10 },
  documentCard: { backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 12, padding: 11, gap: 8 },
  documentPath: { color: C.text, fontSize: 12, lineHeight: 17, fontWeight: "600" as const },
  documentText: { color: C.text, fontSize: 12, lineHeight: 18, backgroundColor: C.bg, borderColor: C.border, borderWidth: 1, borderRadius: 10, padding: 11 },
  historyEntry: { borderLeftColor: C.border, borderLeftWidth: 2, paddingLeft: 10, gap: 4 },
  historyText: { color: C.muted, fontSize: 11, lineHeight: 17, paddingVertical: 5 },
  modalSafe: { flex: 1, backgroundColor: C.bg },
  modalHeader: { paddingHorizontal: 18, paddingVertical: 8, flexDirection: "row" as const, alignItems: "center" as const, borderBottomColor: C.border, borderBottomWidth: 1 },
  modalTitle: { color: C.text, fontSize: 16, fontWeight: "600" as const },
  modalContent: { paddingHorizontal: 24, paddingTop: 22, paddingBottom: 36, gap: 13, width: "100%" as const, maxWidth: 640, alignSelf: "center" as const },
  diffCard: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 15, padding: 12, gap: 10 },
  diffText: { color: C.text, fontSize: 11, lineHeight: 17, padding: 9, backgroundColor: C.bg, borderRadius: 8 },
  switchRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, justifyContent: "space-between" as const, paddingVertical: 5 },
  switchCopy: { color: C.text, fontSize: 12, lineHeight: 18, flex: 1 },
  disclaimer: { color: C.muted, fontSize: 11, lineHeight: 17 },
  error: { color: C.red, fontSize: 12, lineHeight: 18 },
};
