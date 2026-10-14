import React, { useState } from "react";
import { Modal, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { DispatchRecoveryPlan, DispatchRecoveryStatus } from "../dispatch/recovery";
import { Button, IconButton } from "./primitives";
import { C, s } from "./theme";

type Props = {
  status?: DispatchRecoveryStatus;
  integrityMessage?: string;
  plan?: DispatchRecoveryPlan;
  open: boolean;
  busy: boolean;
  blocked: boolean;
  mutationBlocked: boolean;
  error: string;
  unknownOperationId?: string;
  refreshedOperationId?: string;
  reviewCurrentOperationId?: string;
  onOpen: () => void;
  onPrepare: () => void;
  onConfirm: (operationId: string) => void;
  onCancel: (operationId: string) => void;
  onClose: () => void;
  onRefresh: (operationId: string) => void;
  onInspect: (operationId: string) => void;
  onReviewCurrent: (previousOperationId: string) => void;
};

function count(value: number | null | undefined, singular: string, plural = singular): string {
  return value == null ? `${plural}: unavailable` : `${value} ${value === 1 ? singular : plural}`;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function DispatchRecoverySection(props: Props) {
  const status = props.status;
  const plan = props.plan ?? status?.plan;
  const persistentArchive = (status?.archiveCount ?? 0) > 0;
  const needed = Boolean(props.integrityMessage) || Boolean(status && status.status !== "not_needed") || persistentArchive || Boolean(props.unknownOperationId);
  const reviewKey = `${props.open}:${plan?.operationId ?? "none"}`;
  const [confirmationState, setConfirmationState] = useState({ key: reviewKey, value: "" });
  const confirmation = confirmationState.key === reviewKey ? confirmationState.value : "";
  const setConfirmation = (value: string) => setConfirmationState({ key: reviewKey, value });

  if (!needed) return null;
  return (
    <View style={styles.card}>
      <Text style={s.sectionTitle}>Damaged action history</Text>
      {props.integrityMessage ? <Text style={s.disclaimer}>{props.integrityMessage}</Text> : null}
      {persistentArchive ? (
        <Text style={styles.meta}>
          {count(status?.archiveCount, "private archive copy", "private archive copies")} · {count(status?.archiveBytes, "archived byte", "archived bytes")} · {count(status?.unresolvedReceiptCount, "record with unresolved outcomes", "records with unresolved outcomes")}
        </Text>
      ) : null}
      {props.unknownOperationId ? (
        <>
          <Text style={styles.body}>The retirement outcome is unresolved. No remote action will be retried. Refresh saved data, then inspect the saved receipt.</Text>
          <Button label="Refresh saved data" tone="quiet" disabled={props.blocked || props.busy} onPress={() => props.onRefresh(props.unknownOperationId!)} />
          <Button label="Inspect saved receipt" disabled={props.blocked || props.busy || props.refreshedOperationId !== props.unknownOperationId} onPress={() => props.onInspect(props.unknownOperationId!)} />
          {props.reviewCurrentOperationId === props.unknownOperationId && status?.status === "available" ? <>
            <Text style={styles.body}>The previous local retirement could not be verified. This starts a separate review of the current damaged history.</Text>
            <Button label="Review current damaged history" disabled={props.mutationBlocked || props.busy} onPress={() => props.onReviewCurrent(props.unknownOperationId!)} />
          </> : null}
        </>
      ) : status?.status === "refresh_required" ? (
        <Text style={styles.body}>Saved data must be refreshed before this review can continue.</Text>
      ) : (
        <>
          <Text style={styles.body}>Review a local-only retirement plan for damaged action history.</Text>
          {status?.status === "unavailable" || status?.status === "busy" ? <Text style={styles.meta}>Recovery review is currently unavailable.</Text> : null}
          {status?.status === "available" || status?.status === "prepared" ? <Button label="Review retirement" disabled={props.mutationBlocked || props.busy} onPress={props.onOpen} /> : null}
          {status?.status === "not_needed" && persistentArchive ? <Text style={styles.meta}>Archived action history is retained. No retirement action is pending.</Text> : null}
        </>
      )}
      {props.error ? <Text accessibilityRole="alert" style={styles.error}>{props.error}</Text> : null}

      <Modal visible={props.open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!props.busy) props.onClose(); }}>
        <SafeAreaProvider>
          <SafeAreaView style={styles.safe}>
            <ScrollView contentContainerStyle={[s.scroll, styles.content]} keyboardShouldPersistTaps="handled">
              <View style={s.modalHeader}>
                <IconButton name="chevron-back" label="Close action history recovery" onPress={() => { if (!props.busy) props.onClose(); }} />
                <Text style={s.modalTitle}>Retire damaged action history</Text>
                <View style={{ width: 46 }} />
              </View>
              <Text style={s.kicker}>LOCAL RECOVERY</Text>
              <Text style={s.intro}>This permanently retires every existing remote email and OAuth calendar proposal, including proposals with valid outcomes. OAuth remains connected. Your saved content and valid receipts are kept.</Text>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Before you continue</Text>
                <Text style={styles.body}>The original damaged evidence will be archived privately. Valid receipts and their original outcomes are preserved. Previously identified actions remain blocked from repeating.</Text>
                <Text style={styles.body}>Historical corrupt outcomes may remain unresolved. A later independently created action could overlap an attempt whose outcome cannot be identified. The app will never resend it automatically.</Text>
                <Text style={styles.body}>Some content cleanup may remain paused while historical outcomes are unresolved.</Text>
                <Text style={styles.meta}>This is a local operation. It makes no provider or model request.</Text>
              </View>
              {plan ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Planned changes</Text>
                  <Text style={styles.body}>{count(plan.effects.quarantinedReceiptCount, "damaged receipt will be archived", "damaged receipt records will be archived")}</Text>
                  <Text style={styles.body}>{count(plan.effects.preservedValidReceiptCount, "valid receipt will be preserved", "valid receipt records will be preserved")}</Text>
                  <Text style={styles.body}>{count(plan.effects.remoteProposalsRetired, "remote proposal will be made permanently read-only", "remote proposals will be made permanently read-only")}</Text>
                  <Text style={styles.body}>{count(plan.effects.sourceActionFencesAdded, "identified action will stay protected from repeating", "identified actions will stay protected from repeating")}</Text>
                  <Text style={styles.body}>{count(plan.effects.unresolvedReceiptCount, "record with unresolved outcomes", "records with unresolved outcomes")}</Text>
                  <Text style={styles.meta}>New private evidence: {size(plan.evidenceBytes)} · existing copies: {plan.archiveCount}; after retirement: {plan.archiveCount + 1}. Review expires {new Date(plan.expiresAt).toLocaleTimeString()}.</Text>
                </View>
              ) : <Text style={styles.meta}>Preparing a review does not change saved data. Confirming is a separate local action.</Text>}
              {props.error ? <Text accessibilityRole="alert" style={styles.error}>{props.error}</Text> : null}
              {plan ? <>
                <Text style={styles.label}>TYPE RETIRE ACTIONS TO CONFIRM</Text>
                <TextInput accessibilityLabel="Type RETIRE ACTIONS to confirm" autoCapitalize="characters" autoCorrect={false} editable={!props.busy} value={confirmation} onChangeText={setConfirmation} placeholder="RETIRE ACTIONS" placeholderTextColor={C.muted} style={styles.input} />
                <Button label={props.busy ? "Retiring action history…" : "Retire damaged action history"} tone="danger" disabled={props.mutationBlocked || props.busy || confirmation !== "RETIRE ACTIONS"} onPress={() => props.onConfirm(plan.operationId)} />
                <Button label="Cancel review" tone="quiet" disabled={props.busy} onPress={() => props.onCancel(plan.operationId)} />
              </> : <>
                <Button label={props.busy ? "Preparing review…" : "Prepare review"} disabled={props.mutationBlocked || props.busy} onPress={props.onPrepare} />
                <Button label="Close" tone="quiet" disabled={props.busy} onPress={props.onClose} />
              </>}
            </ScrollView>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </View>
  );
}

const styles = {
  safe: { flex: 1, backgroundColor: C.bg },
  content: { flexGrow: 1, paddingTop: 6, paddingBottom: 32, gap: 10 },
  card: { backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 14, gap: 9 },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: "700" as const },
  body: { color: C.text, fontSize: 14, lineHeight: 20 },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  label: { color: C.muted, fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.7 },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.input, color: C.text, paddingHorizontal: 14, fontSize: 16 },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
};
