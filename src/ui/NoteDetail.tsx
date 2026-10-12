import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import type { AssistIntent, Note, NoteAssistResult, Proposal } from "../core";
import type { KnowledgeChange, KnowledgeEntityKind, Person, Project } from "../knowledge/types";
import { Button, Field, IconButton } from "./primitives";
import { C, s } from "./theme";

function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).format();
    return Boolean(value.trim());
  } catch {
    return false;
  }
}

type Props = {
  note: Note;
  importedAudioMissing?: boolean;
  analysis?: NoteAssistResult;
  proposals: Proposal[];
  busy: boolean;
  preview: boolean;
  demoMode: boolean;
  providerReady: boolean;
  analysisStatusError?: string;
  analysisStatusChecking?: boolean;
  people?: Person[];
  projects?: Project[];
  onRetryStatus: () => void;
  onClose: () => void;
  onUpdate: (text: string) => void;
  onConfirmImportedTimeZone: (timeZone: string) => void;
  onAssist: (options: {
    intent: AssistIntent;
    question?: string;
    forceRefresh?: boolean;
    knowledgeSelection?: { kind: KnowledgeEntityKind; id: string }[];
  }) => void;
  onCreateMemorySuggestion: (input: { noteId: string; sourceId: string; quote: string; targetKind: KnowledgeEntityKind; targetId: string; change: KnowledgeChange }) => Promise<unknown>;
  onOpenProposals: () => void;
  onTranscribe: () => void;
  onAttachRecording: () => void;
  onPlay: () => void;
  onExportAudio: () => void;
  onDelete: () => void;
};

const intents: { key: AssistIntent; label: string }[] = [
  { key: "assist", label: "Assist" },
  { key: "summarize", label: "Summarize" },
  { key: "answer", label: "Answer" },
  { key: "extract", label: "Extract actions" },
];

export function NoteDetail({
  note,
  importedAudioMissing = false,
  analysis,
  proposals,
  busy,
  preview,
  demoMode,
  providerReady,
  analysisStatusError,
  analysisStatusChecking,
  people = [],
  projects = [],
  onRetryStatus,
  onClose,
  onUpdate,
  onConfirmImportedTimeZone,
  onAssist,
  onCreateMemorySuggestion,
  onOpenProposals,
  onTranscribe,
  onAttachRecording,
  onPlay,
  onExportAudio,
  onDelete,
}: Props) {
  const [text, setText] = useState(note.transcript);
  const [importedTimeZone, setImportedTimeZone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [intent, setIntent] = useState<AssistIntent>(
    analysis?.intent ?? "assist",
  );
  const [question, setQuestion] = useState(analysis?.question ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [showCitations, setShowCitations] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [knowledgeSelection, setKnowledgeSelection] = useState<{ kind: KnowledgeEntityKind; id: string }[]>(analysis?.knowledgeSelection ?? []);
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const [suggestionTargetKind, setSuggestionTargetKind] = useState<KnowledgeEntityKind>('person');
  const [suggestionTargetId, setSuggestionTargetId] = useState('');
  const [suggestionOperation, setSuggestionOperation] = useState<'add_fact' | 'add_contact' | 'add_source_link' | 'add_member'>('add_fact');
  const [suggestionQuote, setSuggestionQuote] = useState('');
  const [suggestionValue, setSuggestionValue] = useState('');
  const [suggestionLabel, setSuggestionLabel] = useState('');
  const [suggestionPersonId, setSuggestionPersonId] = useState('');
  const [suggestionRole, setSuggestionRole] = useState('');
  const [suggestionMessage, setSuggestionMessage] = useState('');
  const dirty = text !== note.transcript;
  const timeZoneUnconfirmed = note.importOrigin?.originalTimeZoneUnknown === true;
  const effectiveIntent: AssistIntent = question.trim() ? "answer" : intent;
  const includedContext =
    analysis?.includedSources.filter((source) => source.id !== "transcript") ??
    [];
  const omittedContextCount =
    analysis?.omittedSourceCount ?? analysis?.omittedSourceIds.length ?? 0;
  const analysisIsStale = Boolean(
    analysis &&
    (analysisStatusError ||
      analysisStatusChecking ||
      analysis.stale ||
      analysis.sourceRevision !== note.revision),
  );
  const canAssist =
    Boolean(text.trim()) &&
    !dirty &&
    !busy &&
      !timeZoneUnconfirmed &&
    !(effectiveIntent === "answer" && !question.trim());
  const availableEntities = [
    ...people.map((item) => ({ kind: 'person' as const, id: item.id, name: item.name, archived: Boolean(item.archivedAt), importedCopy: item.importOrigin?.kind === 'backup_knowledge' })),
    ...projects.map((item) => ({ kind: 'project' as const, id: item.id, name: item.name, archived: Boolean(item.archivedAt), importedCopy: item.importOrigin?.kind === 'backup_knowledge' })),
  ];
  const selectedSuggestionTarget = suggestionTargetKind === 'person'
    ? people.find((item) => item.id === suggestionTargetId)
    : projects.find((item) => item.id === suggestionTargetId);
  const exactQuote = Boolean(suggestionQuote.trim()) && note.transcript.includes(suggestionQuote.trim());
  const reviewableProposalCount = analysisIsStale
    ? 0
    : proposals.filter(
        (proposal) =>
          proposal.status === "draft" || proposal.status === "approved",
      ).length;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.modalHeader}>
          <IconButton
            name="chevron-back"
            label="Back to recordings"
            onPress={onClose}
          />
          <Text style={s.modalTitle}>
            {note.audioUri ? "Voice note" : "Note"}
          </Text>
          <IconButton
            name="trash-outline"
            label="Delete note"
            onPress={onDelete}
            color={C.red}
          />
        </View>
        <Text style={s.kicker}>SAVED LOCALLY</Text>
        <Text style={s.analysisSource}>
          {note.importOrigin?.originalTimeZoneUnknown
            ? `Imported timestamp ${note.capturedAt ?? note.createdAt} · original time zone unavailable`
            : `Captured ${new Date(note.capturedAt ?? note.createdAt).toLocaleString(
                undefined,
                note.captureTimeZone
                  ? { timeZone: note.captureTimeZone }
                  : undefined,
              )}${note.captureTimeZone ? ` · ${note.captureTimeZone}` : ""}`}
        </Text>
        <Text style={s.h1Small}>A thought, kept.</Text>
        {importedAudioMissing && !note.audioUri ? (
          <Text style={s.disclaimer}>
            Imported note · its original recording was not included in the backup.
          </Text>
        ) : null}
        {timeZoneUnconfirmed ? (
          <View style={s.analysisStale}>
            <Text style={s.analysisText}>
              The original capture time zone was not included. Confirm the IANA time zone before Still uses this note for date-sensitive assistance.
            </Text>
            <Field
              label="IANA capture time zone"
              value={importedTimeZone}
              onChangeText={setImportedTimeZone}
              placeholder="Asia/Singapore"
            />
            <Button
              label="Confirm capture time zone"
              disabled={busy || !validTimeZone(importedTimeZone)}
              onPress={() => onConfirmImportedTimeZone(importedTimeZone.trim())}
            />
          </View>
        ) : null}
        {importedAudioMissing && !note.audioUri ? (
          <View style={s.setupCard}>
            <Text style={s.setupTitle}>Add a replacement recording</Text>
            <Text style={s.setupBody}>
              The original recording is missing. A file you choose cannot be
              verified as the original, and your transcript will stay unchanged.
            </Text>
            <Button
              label={dirty ? "Save transcript before attaching" : "Attach a recording"}
              tone="quiet"
              icon="attach-outline"
              disabled={busy || dirty}
              onPress={onAttachRecording}
            />
          </View>
        ) : null}
        {note.audioAttachment ? (
          <View style={s.analysisStale}>
            <Text style={s.analysisText}>User-selected replacement recording</Text>
            <Text style={s.analysisSource}>
              Original match unverified · {note.audioAttachment.fileName} · {note.audioAttachment.format.toUpperCase()}
            </Text>
            {note.audioAttachment.durationStatus === "unknown" ? (
              <Text style={s.analysisSource}>
                Duration could not be measured. Transcription is unavailable for this recording.
              </Text>
            ) : null}
          </View>
        ) : null}
        {note.audioUri ? (
          <>
            <Button
              label={demoMode ? "Playback unavailable in sample preview" : "Play recording"}
              tone="quiet"
              icon="play-circle-outline"
              disabled={demoMode}
              onPress={onPlay}
            />
            <Button
              label={demoMode ? "Audio export unavailable in sample preview" : "Export audio"}
              tone="quiet"
              icon="download-outline"
              disabled={demoMode}
              onPress={onExportAudio}
            />
            {demoMode ? (
              <Text style={s.analysisSource}>
                This sample keeps attached audio in memory and does not create a playable production recording.
              </Text>
            ) : null}
          </>
        ) : null}
        <Field
          label="Transcript"
          multiline
          value={text}
          onChangeText={setText}
          placeholder="Add or edit a transcript by hand…"
        />
        {dirty ? (
          <Button
            label="Save transcript"
            disabled={busy || !text.trim()}
            onPress={() => onUpdate(text)}
          />
        ) : null}
        <Text style={s.localHintText}>
          Audio is never transcribed automatically. Your transcript stays
          editable.
        </Text>
        {note.audioUri && !text.trim() ? (
          <View style={s.setupCard}>
            <Text style={s.setupTitle}>
              {note.audioAttachment?.durationStatus === "unknown"
                ? "Transcription unavailable"
                : "Transcription requires Azure setup"}
            </Text>
            <Text style={s.setupBody}>
              {note.audioAttachment?.durationStatus === "unknown"
                ? "Still could not verify this recording’s duration, so it cannot be sent for transcription. You can write a transcript by hand."
                : "You can add a transcript manually now. Configure Azure Speech when credentials are available."}
            </Text>
            <Button
              label={
                providerReady
                  ? "Transcribe with Azure Speech"
                  : "Set up Azure Speech"
              }
              tone="quiet"
              icon="mic-outline"
              disabled={note.audioAttachment?.durationStatus === "unknown" || demoMode}
              onPress={onTranscribe}
            />
          </View>
        ) : null}

        {text.trim() ? (
          <View style={s.assistCard}>
            <Text style={s.sectionTitle}>Think it through</Text>
            <Text style={s.setupBody}>
              Get a summary, answer, decisions, and possible next steps from
              this saved note.
            </Text>
            {preview ? (
              <Text style={s.previewText}>
                Local preview · AI not connected
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                advanced ? "Hide assistance options" : "Show assistance options"
              }
              accessibilityState={{ expanded: advanced }}
              onPress={() => setAdvanced((value) => !value)}
              style={s.detailsToggle}
            >
              <Text style={s.detailsToggleText}>
                {advanced ? "Hide options" : "Ask a question or choose a focus"}
              </Text>
            </Pressable>
            {advanced ? (
              <>
                <View style={s.intentPills}>
                  {intents.map((item) => (
                    <Pressable
                      key={item.key}
                      accessibilityRole="radio"
                      accessibilityLabel={`${item.label} this note`}
                      accessibilityState={{ selected: intent === item.key }}
                      onPress={() => {
                        setIntent(item.key);
                        if (item.key !== "answer") setQuestion("");
                      }}
                      style={[
                        s.pill,
                        s.intentPill,
                        intent === item.key && s.pillActive,
                      ]}
                    >
                      <Text
                        style={[
                          s.pillText,
                          intent === item.key && s.pillTextActive,
                        ]}
                      >
                        {item.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {intent === "answer" ? (
                  <Field
                    label="Ask a question"
                    value={question}
                    onChangeText={setQuestion}
                    placeholder="What should I remember about this?"
                    multiline
                  />
                ) : null}
                <Text style={s.label}>Optional context · up to 5</Text>
                <Text style={s.knowledgeFootnote}>Still uses active people and projects by default. Select an item to include it explicitly; archived context is marked.</Text>
                {availableEntities.map((entity) => {
                  const chosen = knowledgeSelection.some((item) => item.kind === entity.kind && item.id === entity.id);
                  return <Pressable key={`${entity.kind}:${entity.id}`} accessibilityRole="checkbox" accessibilityState={{ checked: chosen }} disabled={!chosen && knowledgeSelection.length >= 5} onPress={() => setKnowledgeSelection((current) => chosen ? current.filter((item) => !(item.kind === entity.kind && item.id === entity.id)) : [...current, { kind: entity.kind, id: entity.id }])} style={s.knowledgeCard}>
                    <Text style={[s.knowledgeMeta, { flex: 1 }]}>{chosen ? '✓ ' : ''}{entity.name} · {entity.kind}{entity.importedCopy ? ' · Imported copy' : ''}{entity.archived ? ' · archived' : ''}</Text>
                  </Pressable>;
                })}
              </>
            ) : null}
            {analysisStatusError ? (
              <View style={s.analysisStale}>
                <Text style={s.analysisText}>{analysisStatusError}</Text>
                <Button
                  label="Check source status again"
                  tone="quiet"
                  onPress={onRetryStatus}
                />
              </View>
            ) : analysisStatusChecking ? (
              <View style={s.analysisStale}>
                <Text style={s.analysisText}>Checking saved sources…</Text>
              </View>
            ) : analysisIsStale ? (
              <View style={s.analysisStale}>
                <Text style={s.analysisText}>
                  Some sources changed since this response. Refresh when ready.
                </Text>
                <Text style={s.analysisSource}>
                  {preview
                    ? "A refreshed preview stays local. No refresh happens automatically."
                    : "Refreshing may use one provider request. No refresh happens automatically."}
                </Text>
              </View>
            ) : null}
            <Button
              label={
                analysisIsStale
                  ? "Refresh this response"
                  : "Assist with this note"
              }
              icon="sparkles-outline"
              disabled={!canAssist}
              onPress={() =>
                onAssist({
                  intent: effectiveIntent,
                  ...(question.trim() ? { question: question.trim() } : {}),
                  ...(analysisIsStale ? { forceRefresh: true } : {}),
                  ...(knowledgeSelection.length ? { knowledgeSelection } : {}),
                })
              }
            />
            <Button label="Suggest a memory connection" tone="quiet" icon="git-branch-outline" disabled={busy || dirty || !note.transcript.trim()} onPress={() => { setSuggestionQuote(''); setSuggestionValue(''); setSuggestionMessage(''); setSuggestionOpen(true); }} />
            {suggestionOpen ? <View style={s.setupCard}>
              <View style={s.sectionHeader}><Text style={s.setupTitle}>Ground it in this note</Text><IconButton name="close" label="Close memory suggestion form" onPress={() => setSuggestionOpen(false)} /></View>
              <Text style={s.knowledgeFootnote}>This saves a suggestion for review. It does not make another model request.</Text>
              <View style={s.knowledgeStatusRow}>{(['person', 'project'] as const).map((kind) => <Pressable key={kind} accessibilityRole="radio" accessibilityState={{ selected: suggestionTargetKind === kind }} onPress={() => { setSuggestionTargetKind(kind); setSuggestionTargetId(''); }} style={[s.knowledgeStatusChoice, suggestionTargetKind === kind && s.knowledgeStatusSelected]}><Text style={s.knowledgeMeta}>{kind === 'person' ? 'Person' : 'Project'}</Text></Pressable>)}</View>
              {(suggestionTargetKind === 'person' ? people : projects).map((entity) => <Pressable key={entity.id} accessibilityRole="radio" accessibilityState={{ selected: suggestionTargetId === entity.id }} onPress={() => setSuggestionTargetId(entity.id)} style={[s.knowledgeStatusChoice, suggestionTargetId === entity.id && s.knowledgeStatusSelected]}><Text style={s.knowledgeMeta}>{entity.name}{entity.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}{entity.archivedAt ? ' · archived' : ''}</Text></Pressable>)}
              <Text style={s.label}>Suggested change</Text>
              {(['add_fact', ...(suggestionTargetKind === 'person' ? ['add_contact'] : []), 'add_source_link', ...(suggestionTargetKind === 'project' ? ['add_member'] : [])] as (typeof suggestionOperation)[]).map((operation) => <Pressable key={operation} accessibilityRole="radio" accessibilityState={{ selected: suggestionOperation === operation }} onPress={() => { setSuggestionOperation(operation); setSuggestionValue(''); }} style={[s.knowledgeStatusChoice, suggestionOperation === operation && s.knowledgeStatusSelected]}><Text style={s.knowledgeMeta}>{operation === 'add_fact' ? 'Add fact' : operation === 'add_contact' ? 'Add contact claim' : operation === 'add_source_link' ? 'Link this note' : 'Add project member'}</Text></Pressable>)}
              {suggestionOperation === 'add_fact' ? <Field label="Proposed fact" value={suggestionValue} onChangeText={setSuggestionValue} multiline /> : null}
              {suggestionOperation === 'add_contact' ? <><Field label="Contact address claim · not verified" value={suggestionValue} onChangeText={setSuggestionValue} keyboardType="email-address" /><Field label="Label" value={suggestionLabel} onChangeText={setSuggestionLabel} placeholder="Email" /></> : null}
              {suggestionOperation === 'add_source_link' ? <Field label="Why this note belongs here" value={suggestionValue} onChangeText={setSuggestionValue} /> : null}
              {suggestionOperation === 'add_member' ? <><Text style={s.label}>Choose a person</Text>{people.filter((person) => !person.archivedAt).map((person) => <Pressable key={person.id} accessibilityRole="radio" accessibilityState={{ selected: suggestionPersonId === person.id }} onPress={() => setSuggestionPersonId(person.id)} style={[s.knowledgeStatusChoice, suggestionPersonId === person.id && s.knowledgeStatusSelected]}><Text style={s.knowledgeMeta}>{person.name}{person.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}</Text></Pressable>)}<Field label="Role" value={suggestionRole} onChangeText={setSuggestionRole} /></> : null}
              <Field label="Exact quote from this saved note" value={suggestionQuote} onChangeText={setSuggestionQuote} multiline placeholder="Copy an exact sentence from the transcript" />
              {!exactQuote && suggestionQuote.trim() ? <Text style={s.knowledgeError}>The quote must appear exactly in this saved transcript.</Text> : null}
              {suggestionMessage ? <Text accessibilityRole="alert" style={s.knowledgeError}>{suggestionMessage}</Text> : null}
              <Button label="Save for memory review" disabled={busy || !selectedSuggestionTarget || !exactQuote || (suggestionOperation === 'add_fact' && !suggestionValue.trim()) || (suggestionOperation === 'add_contact' && !suggestionValue.trim()) || (suggestionOperation === 'add_source_link' && !suggestionValue.trim()) || (suggestionOperation === 'add_member' && !suggestionPersonId)} onPress={() => {
                if (!selectedSuggestionTarget || !exactQuote) return;
                const entityKind = suggestionTargetKind;
                const entityId = suggestionTargetId;
                let change: KnowledgeChange;
                if (suggestionOperation === 'add_fact') change = { type: 'add_fact', entityKind, entityId, statement: suggestionValue.trim() };
                else if (suggestionOperation === 'add_contact' && entityKind === 'person') change = { type: 'add_contact', entityKind, entityId, address: suggestionValue.trim(), label: suggestionLabel.trim() || 'Contact' };
                else if (suggestionOperation === 'add_source_link') change = { type: 'add_source_link', entityKind, entityId, reference: { kind: 'note', id: note.id }, label: suggestionValue.trim() };
                else if (suggestionOperation === 'add_member' && entityKind === 'project') {
                  const member = people.find((person) => person.id === suggestionPersonId);
                  if (!member) return;
                  change = { type: 'add_member', entityKind, entityId, personId: member.id, personRevision: member.revision, role: suggestionRole.trim() };
                } else return;
                void onCreateMemorySuggestion({ noteId: note.id, sourceId: 'transcript', quote: suggestionQuote.trim(), targetKind: entityKind, targetId: entityId, change }).then((result) => {
                  if (result) { setSuggestionOpen(false); setSuggestionMessage(''); }
                  else setSuggestionMessage('The suggestion could not be saved. Check the notice and try again.');
                }).catch((error) => setSuggestionMessage(error instanceof Error ? error.message : 'The source changed. Reopen this note and try again.'));
              }} />
            </View> : null}
            {dirty ? (
              <Text style={s.disclaimer}>
                Save transcript edits before asking about this note.
              </Text>
            ) : null}
            {analysis ? (
              <View style={s.analysis}>
                {preview ? (
                  <Text style={s.previewText}>
                    Local preview · this response was not generated by AI
                  </Text>
                ) : null}
                <Text style={s.analysisSource}>
                  {analysis.answeredAsOf
                    ? `Answered as of ${new Date(analysis.answeredAsOf).toLocaleString(undefined, analysis.answerTimeZone ? { timeZone: analysis.answerTimeZone } : undefined)}${analysis.answerTimeZone ? ` · ${analysis.answerTimeZone}` : ""}`
                    : `Response prepared ${new Date(analysis.analyzedAt).toLocaleString()}`}
                </Text>
                {analysis.includedSources.length ? (
                  <>
                    {includedContext.length ? (
                      <>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={
                            showContext
                              ? "Hide source context"
                              : `Show ${analysis.includedSources.length} sources used, including ${includedContext.length} additional sources`
                          }
                          accessibilityState={{ expanded: showContext }}
                          onPress={() => setShowContext((value) => !value)}
                          style={s.detailsToggle}
                        >
                          <Text style={s.detailsToggleText}>
                            {`Context used · ${analysis.includedSources.length} source${analysis.includedSources.length === 1 ? "" : "s"} (${includedContext.length} additional)`}
                            {omittedContextCount
                              ? ` · ${omittedContextCount} not included`
                              : ""}
                          </Text>
                        </Pressable>
                        {showContext
                          ? includedContext.map((source) => (
                              <View key={source.id} style={s.contextSource}>
                                <Text style={s.contextSourceTitle}>
                                  {source.title}
                                </Text>
                                {source.excerpt ? (
                                  <Text style={s.analysisSource}>
                                    “{source.excerpt}”
                                  </Text>
                                ) : null}
                              </View>
                            ))
                          : null}
                      </>
                    ) : (
                      <Text style={s.analysisSource}>
                        {`Context used · 1 source (this note)${omittedContextCount ? ` · ${omittedContextCount} not included` : ""}`}
                      </Text>
                    )}
                  </>
                ) : null}
                <Text style={s.label}>SUMMARY</Text>
                <Text style={s.analysisText}>
                  {analysis.summary || "No summary was returned."}
                </Text>
                {analysis.answer ? (
                  <>
                    <Text style={s.label}>RESPONSE</Text>
                    <Text style={s.analysisText}>{analysis.answer}</Text>
                  </>
                ) : null}
                {analysis.decisions.length ? (
                  <>
                    <Text style={s.label}>EXTRACTED DECISIONS</Text>
                    {analysis.decisions.map((decision, index) => (
                      <View
                        key={`${index}-${decision.quote}`}
                        style={s.analysisBlock}
                      >
                        <Text style={s.analysisText}>{decision.text}</Text>
                        <Text style={s.analysisSource}>
                          “{decision.quote}” · {decision.source}
                        </Text>
                      </View>
                    ))}
                  </>
                ) : null}
                {analysis.clarifications.length ? (
                  <View style={s.clarificationBox}>
                    <Text style={s.label}>POSSIBLE CLARIFICATIONS</Text>
                    {analysis.clarifications.map((item, index) => (
                      <Text key={`${index}-${item}`} style={s.analysisText}>
                        • {item}
                      </Text>
                    ))}
                    <Text style={s.analysisSource}>
                      Review or edit the note yourself; no follow-up is sent
                      automatically.
                    </Text>
                  </View>
                ) : null}
                {analysis.citations.length ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        showCitations
                          ? "Hide cited passages"
                          : "Show cited passages"
                      }
                      accessibilityState={{ expanded: showCitations }}
                      onPress={() => setShowCitations((value) => !value)}
                      style={s.detailsToggle}
                    >
                      <Text style={s.detailsToggleText}>
                        {showCitations
                          ? "Hide cited passages"
                          : `View ${analysis.citations.length} cited passage${analysis.citations.length === 1 ? "" : "s"}`}
                      </Text>
                    </Pressable>
                    {showCitations
                      ? analysis.citations.map((citation, index) => (
                          <View
                            key={`${index}-${citation.source}`}
                            style={s.analysisBlock}
                          >
                            <Text style={s.evidenceQuote}>
                              “{citation.quote}”
                            </Text>
                            <Text style={s.analysisSource}>
                              {citation.source} · note revision{" "}
                              {analysis.sourceRevision}
                            </Text>
                          </View>
                        ))
                      : null}
                  </>
                ) : null}
                {reviewableProposalCount ? (
                  <Button
                    label={`Review ${reviewableProposalCount} suggested action${reviewableProposalCount === 1 ? "" : "s"}`}
                    tone="quiet"
                    onPress={onOpenProposals}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
        <Text style={s.disclaimer}>
          A proposal is a draft for your review. It cannot send or schedule
          anything by itself.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
