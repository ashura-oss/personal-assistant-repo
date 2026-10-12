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
import { Button, Field, IconButton } from "./primitives";
import { C, s } from "./theme";

type Props = {
  note: Note;
  analysis?: NoteAssistResult;
  proposals: Proposal[];
  busy: boolean;
  preview: boolean;
  providerReady: boolean;
  analysisStatusError?: string;
  analysisStatusChecking?: boolean;
  onRetryStatus: () => void;
  onClose: () => void;
  onUpdate: (text: string) => void;
  onAssist: (options: {
    intent: AssistIntent;
    question?: string;
    forceRefresh?: boolean;
  }) => void;
  onOpenProposals: () => void;
  onTranscribe: () => void;
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
  analysis,
  proposals,
  busy,
  preview,
  providerReady,
  analysisStatusError,
  analysisStatusChecking,
  onRetryStatus,
  onClose,
  onUpdate,
  onAssist,
  onOpenProposals,
  onTranscribe,
  onPlay,
  onExportAudio,
  onDelete,
}: Props) {
  const [text, setText] = useState(note.transcript);
  const [intent, setIntent] = useState<AssistIntent>(
    analysis?.intent ?? "assist",
  );
  const [question, setQuestion] = useState(analysis?.question ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [showCitations, setShowCitations] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const dirty = text !== note.transcript;
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
    !(effectiveIntent === "answer" && !question.trim());
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
          Captured{" "}
          {new Date(note.capturedAt ?? note.createdAt).toLocaleString(
            undefined,
            note.captureTimeZone
              ? { timeZone: note.captureTimeZone }
              : undefined,
          )}
          {note.captureTimeZone ? ` · ${note.captureTimeZone}` : ""}
        </Text>
        <Text style={s.h1Small}>A thought, kept.</Text>
        {note.audioUri ? (
          <>
            <Button
              label="Play recording"
              tone="quiet"
              icon="play-circle-outline"
              onPress={onPlay}
            />
            <Button
              label="Export audio"
              tone="quiet"
              icon="download-outline"
              onPress={onExportAudio}
            />
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
            <Text style={s.setupTitle}>Transcription requires Azure setup</Text>
            <Text style={s.setupBody}>
              You can add a transcript manually now. Configure Azure Speech when
              credentials are available.
            </Text>
            <Button
              label={
                providerReady
                  ? "Transcribe with Azure Speech"
                  : "Set up Azure Speech"
              }
              tone="quiet"
              icon="mic-outline"
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
                })
              }
            />
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
