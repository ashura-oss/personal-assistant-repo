import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AppController, BackupImportPreview } from "../core";
import type { ImportedBackupArchive } from "../backup";
import { pickPortableBackup } from "../backupFiles";
import type { PrivacyAudioBoundary } from "../privacy/audioBoundary";
import { Button, IconButton } from "./primitives";
import { C, s } from "./theme";

export function BackupImportSheet({
  visible,
  controller,
  busy,
  sampleMode = false,
  privacyAudioBoundary,
  onClose,
  onImported,
}: {
  visible: boolean;
  controller: AppController;
  busy: boolean;
  sampleMode?: boolean;
  privacyAudioBoundary?: PrivacyAudioBoundary;
  onClose: () => void;
  onImported?: (archive: ImportedBackupArchive) => void;
}) {
  const [preview, setPreview] = useState<BackupImportPreview | null>(null);
  const [fileName, setFileName] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState<{
    archive: ImportedBackupArchive;
    notes: number;
    tasks: number;
    taskLinksRepaired: number;
    restored: boolean;
  } | null>(null);
  const sequence = useRef(0);
  const visibleRef = useRef(visible);

  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) {
      sequence.current += 1;
    }
  }, [visible]);

  const close = () => {
    sequence.current += 1;
    setPreview(null);
    setFileName("");
    setSelecting(false);
    setApplying(false);
    setError("");
    setComplete(null);
    onClose();
  };

  const chooseFile = async () => {
    const request = ++sequence.current;
    setSelecting(true);
    setError("");
    setPreview(null);
    setFileName("");
    setComplete(null);
    try {
      const file = await pickPortableBackup(privacyAudioBoundary);
      if (!file || request !== sequence.current || !visibleRef.current) return;
      const nextPreview = await controller.prepareBackupImport(file.bytes);
      if (request !== sequence.current || !visibleRef.current) return;
      setFileName(file.name);
      setPreview(nextPreview);
      setComplete(null);
      setError("");
    } catch (cause) {
      if (request === sequence.current && visibleRef.current) {
        setError(messageOf(cause, "Could not prepare this backup. Choose a valid local JSON file."));
      }
    } finally {
      if (request === sequence.current) setSelecting(false);
    }
  };

  const apply = async () => {
    if (!preview || applying || selecting || busy) return;
    const prepared = preview;
    const missingNotes = prepared.alreadyImported ? prepared.missingNoteCount : prepared.noteCount;
    const missingTasks = prepared.alreadyImported ? prepared.missingTaskCount : prepared.taskCount;
    const restorable = missingNotes > 0 || missingTasks > 0;
    if (prepared.alreadyImported && !restorable) return;
    const request = sequence.current;
    setApplying(true);
    setError("");
    try {
      const archive = await controller.applyBackupImport({
        sessionId: prepared.sessionId,
        planHash: prepared.planHash,
      });
      if (request !== sequence.current || !visibleRef.current) return;
      setComplete({
        archive,
        notes: missingNotes,
        tasks: missingTasks,
        taskLinksRepaired: prepared.alreadyImported ? prepared.taskLinkRepairCount : 0,
        restored: prepared.alreadyImported,
      });
      setPreview(null);
      onImported?.(archive);
    } catch (cause) {
      if (request === sequence.current && visibleRef.current) {
        setError(`${messageOf(cause, "The import could not be applied.")} Choose the file again to prepare a fresh preview if this one expired or changed.`);
      }
    } finally {
      if (request === sequence.current) setApplying(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close} presentationStyle="fullScreen">
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <IconButton name="chevron-back" label="Close backup import" onPress={close} />
          <Text style={styles.headerTitle}>Import a backup</Text>
          <View style={styles.spacer} />
        </View>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {sampleMode ? <Text style={styles.badge}>SAMPLE BACKUP · LOCAL ONLY</Text> : null}
          <Text style={s.kicker}>PORTABLE BACKUP</Text>
          <Text style={s.h1Small}>Review before importing.</Text>
          <Text style={styles.body}>Import merges notes, tasks, documents, and inert history. It never restores accounts, credentials, verified identities, approvals, or notification schedules. Imported action history is an unverified record, not something Still can execute.</Text>

          {complete ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{complete.restored ? "Missing content restored" : "Backup added"}</Text>
              <Text style={styles.body}>{complete.restored ? "Restored" : "Added"} {complete.notes} note{complete.notes === 1 ? "" : "s"} and {complete.tasks} task{complete.tasks === 1 ? "" : "s"}. Existing notes, tasks, documents, archives, and settings were kept. Imported history remains read-only.</Text>
              {complete.taskLinksRepaired ? <Text style={styles.body}>{complete.taskLinksRepaired} imported task source link{complete.taskLinksRepaired === 1 ? " was" : "s were"} repaired.</Text> : null}
              {(complete.archive.archivedKnowledge?.length ?? 0) > 0 ? <Text style={styles.body}>{complete.archive.archivedKnowledge!.length} knowledge cohort{complete.archive.archivedKnowledge!.length === 1 ? " remains" : "s remain"} archived. Review in Library → Memory to activate separate copies.</Text> : null}
              {!complete.restored && complete.archive.documents.length ? <Text style={styles.body}>{complete.archive.documents.length} document{complete.archive.documents.length === 1 ? "" : "s"} are archived. Review each before using it as assistant context.</Text> : null}
              <Button label="Done" onPress={close} />
            </View>
          ) : (
            <>
              <Button label={selecting ? "Opening local file…" : "Choose JSON backup"} icon="folder-open-outline" disabled={selecting || applying || busy} onPress={() => void chooseFile()} />
              {selecting ? (
                <View style={styles.selectionRow}>
                  <ActivityIndicator color={C.muted} />
                  <Button label="Cancel file selection" tone="quiet" onPress={() => {
                    sequence.current += 1;
                    setSelecting(false);
                    setError("");
                  }} />
                </View>
              ) : null}
              {fileName ? <Text style={styles.caption}>Selected file · {fileName}</Text> : null}
              {preview ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>{preview.sourceFormat === "voice-assistant-export-v1" ? "Legacy export · v1" : preview.sourceFormat === "still-backup-v2" ? "Still backup · v2" : preview.sourceFormat === "still-backup-v3" ? "Still backup · v3" : "Unknown backup version"}</Text>
                  <Text style={styles.caption}>Exported {new Date(preview.exportedAt).toLocaleString()}</Text>
                  <View style={styles.counts}>
                    <Text style={styles.count}>{preview.noteCount} notes</Text>
                    <Text style={styles.count}>{preview.taskCount} tasks</Text>
                    <Text style={styles.count}>{preview.documentCount} documents</Text>
                    <Text style={styles.count}>{preview.personCount} people</Text>
                    <Text style={styles.count}>{preview.projectCount} projects</Text>
                    <Text style={styles.count}>{preview.knowledgeCohortCount} knowledge cohorts</Text>
                    <Text style={styles.count}>{preview.historyCount} history records</Text>
                  </View>
                  {preview.missingAudioCount ? <Text style={styles.warning}>{preview.missingAudioCount} recording{preview.missingAudioCount === 1 ? " is" : "s are"} not included. Imported notes will show audio missing; no local audio path will be opened.</Text> : <Text style={styles.caption}>Audio is not included in this backup.</Text>}
                  {preview.documentConflicts.length ? (
                    <View style={styles.subsection}>
                      <Text style={styles.subheading}>Document paths to review</Text>
                      {preview.documentConflicts.map((conflict) => <Text key={conflict.path} style={styles.caption}>{conflict.path} · {conflict.identical ? "identical content" : "different current content; current document stays unchanged"}</Text>)}
                    </View>
                  ) : null}
                  {preview.warnings.map((warning, index) => <Text key={`${index}-${warning}`} style={styles.caption}>{warning}</Text>)}
                  {preview.ignoredFieldCount ? <Text style={styles.caption}>{preview.ignoredFieldCount} legacy authority or unsupported field{preview.ignoredFieldCount === 1 ? " was" : "s were"} ignored.</Text> : null}
                  {preview.alreadyImported && (preview.missingNoteCount > 0 || preview.missingTaskCount > 0 || preview.taskLinkRepairCount > 0) ? (
                    <View style={styles.subsection}>
                      <Text style={styles.warning}>This backup is already in your archive. You can restore only missing items; existing notes, tasks, documents, archives, and settings stay in place.</Text>
                      {preview.missingNoteCount ? <Text style={styles.caption}>{preview.missingNoteCount} missing note{preview.missingNoteCount === 1 ? "" : "s"}{preview.missingNoteLabels.length ? ` · ${preview.missingNoteLabels.join(", ")}` : ""}</Text> : null}
                      {preview.missingTaskCount ? <Text style={styles.caption}>{preview.missingTaskCount} missing task{preview.missingTaskCount === 1 ? "" : "s"}{preview.missingTaskLabels.length ? ` · ${preview.missingTaskLabels.join(", ")}` : ""}</Text> : null}
                      {preview.taskLinkRepairCount ? <Text style={styles.caption}>{preview.taskLinkRepairCount} task source link{preview.taskLinkRepairCount === 1 ? "" : "s"} can be repaired{preview.taskLinkRepairLabels.length ? ` · ${preview.taskLinkRepairLabels.join(", ")}` : ""}</Text> : null}
                    </View>
                  ) : preview.alreadyImported ? <Text style={styles.warning}>This backup has already been imported and nothing is missing.</Text> : null}
                  <Text style={styles.disclaimer}>Imported analyses and action history are historical claims. People and Projects remain in an archived knowledge cohort; nothing is activated or merged automatically. Review it in Library → Memory, where you can add a separate copy.</Text>
                  <Text style={styles.disclaimer}>Documents stay inactive until you review and choose to use them as context.</Text>
                  <Button label={applying ? preview.alreadyImported ? "Restoring missing items…" : "Adding backup…" : preview.alreadyImported ? preview.missingNoteCount + preview.missingTaskCount > 0 ? "Restore missing items" : "Already imported" : "Import this backup"} disabled={applying || busy || (preview.alreadyImported && preview.missingNoteCount + preview.missingTaskCount === 0)} onPress={() => void apply()} />
                </View>
              ) : null}
            </>
          )}
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <Text style={styles.disclaimer}>Choose a local JSON file. Still checks its size before reading, validates its contents, and shows a plan before any local changes are applied.</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const styles = {
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 18, paddingVertical: 8, flexDirection: "row" as const, alignItems: "center" as const, borderBottomColor: C.border, borderBottomWidth: 1 },
  headerTitle: { color: C.text, fontSize: 16, fontWeight: "600" as const },
  spacer: { width: 46 },
  content: { paddingHorizontal: 24, paddingTop: 22, paddingBottom: 36, gap: 14, width: "100%" as const, maxWidth: 640, alignSelf: "center" as const },
  body: { color: C.text, fontSize: 13, lineHeight: 20 },
  caption: { color: C.muted, fontSize: 11, lineHeight: 17 },
  card: { backgroundColor: C.card, borderColor: C.border, borderWidth: 1, borderRadius: 16, padding: 15, gap: 11 },
  cardTitle: { color: C.text, fontSize: 17, lineHeight: 23, fontWeight: "600" as const },
  counts: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
  count: { color: C.text, fontSize: 12, lineHeight: 18, backgroundColor: C.bg, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 12 },
  subsection: { borderTopWidth: 1, borderTopColor: C.border, paddingTop: 11, gap: 7 },
  subheading: { color: C.text, fontSize: 12, fontWeight: "600" as const },
  warning: { color: C.sage, fontSize: 12, lineHeight: 18 },
  disclaimer: { color: C.muted, fontSize: 11, lineHeight: 17 },
  error: { color: C.red, fontSize: 12, lineHeight: 18 },
  badge: { color: C.sage, fontSize: 10, fontWeight: "700" as const, letterSpacing: 1, textAlign: "center" as const, paddingVertical: 8 },
  selectionRow: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
};
