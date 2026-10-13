import React, { useState } from "react";
import { Modal, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { ProactiveRecoveryPlan, ProactiveRecoveryStatus } from "../proactive/recovery";
import { Button, IconButton } from "./primitives";
import { C, s } from "./theme";

type Props = {
  visible: boolean;
  plan?: ProactiveRecoveryPlan;
  busy: boolean;
  actionsBlocked?: boolean;
  previewOnly?: boolean;
  error?: string;
  onPrepare: () => void;
  onConfirm: (operationId: string) => void;
  onCancel: (operationId?: string) => void;
  onClose: () => void;
};

export function shouldShowProactiveRecoverySection(input: {
  mailAlertRecovery: boolean;
  proactiveIntegrityError: boolean;
  recoveryUnknown: boolean;
  requiresRefresh: boolean;
  status?: ProactiveRecoveryStatus["status"];
}): boolean {
  return input.mailAlertRecovery || input.proactiveIntegrityError || input.recoveryUnknown ||
    input.requiresRefresh || input.status === "refresh_required";
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function countLabel(value: number | null, singular: string, plural: string): string {
  if (value === null) return "unavailable";
  return `${value} ${value === 1 ? singular : plural}`;
}

export function ProactiveRecoverySheet(props: Props) {
  const [confirmation, setConfirmation] = useState("");
  const plan = props.plan;
  const mailCleanupText = plan?.effects.mailCleanup === "pending"
    ? "Mail alert cancellation will be recorded for later reconciliation. Existing notifications may remain until checked."
    : plan?.effects.mailCleanup === "unavailable"
      ? "Mail alert cancellation status is unavailable; existing notifications are not confirmed removed."
      : "No mail alert cancellation is needed.";

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => {
      if (!props.busy) props.onClose();
    }}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.safe}>
          <ScrollView contentContainerStyle={[s.scroll, styles.content]} keyboardShouldPersistTaps="handled">
            <View style={s.modalHeader}>
              <IconButton name="chevron-back" label="Close recovery review" onPress={() => { if (!props.busy) props.onClose(); }} />
              <Text style={s.modalTitle}>Review attention recovery</Text>
              <View style={{ width: 46 }} />
            </View>
            {props.previewOnly ? <Text style={styles.sample}>SAMPLE · SIMULATED</Text> : null}
            <Text style={s.kicker}>LOCAL RECOVERY</Text>
            <Text style={s.h1Small}>Reset saved attention rules?</Text>
            <Text style={s.intro}>
              This clears the saved rules and local attention state so they can be rebuilt. It does not delete notes, accounts, or action history.
            </Text>

            {plan ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>What will change</Text>
                <Text style={styles.body}>• Saved proactive rules will be reset.</Text>
                <Text style={styles.body}>• Local attention cards and state will be reset.</Text>
                <Text style={styles.body}>• Dismissals and snoozes will be reset.</Text>
                <Text style={styles.body}>• Notes, accounts, and action history will be preserved.</Text>
                <Text style={styles.body}>• The original recovery copy stays private on this device and is omitted from portable exports.</Text>
                {plan.effects.mailConsentsToRevoke === null
                  ? <Text style={styles.meta}>Mail alert settings cannot be validated and will be preserved without change.</Text>
                  : <Text style={styles.body}>{countLabel(plan.effects.mailConsentsToRevoke, "mail alert consent", "mail alert consents")} will be revoked.</Text>}
                {plan.effects.mailReceiptsPreserved === null
                  ? <Text style={styles.meta}>Mail alert history cannot be validated and will be preserved without change.</Text>
                  : <Text style={styles.body}>{countLabel(plan.effects.mailReceiptsPreserved, "mail alert receipt", "mail alert receipts")} will be preserved.</Text>}
                <Text style={styles.meta}>{mailCleanupText}</Text>
                <Text style={styles.meta}>Private copy: {sizeLabel(plan.evidenceBytes)} · copies after reset: {plan.archiveCount} of 4.</Text>
                <Text style={styles.meta}>This review expires at {new Date(plan.expiresAt).toLocaleTimeString()}.</Text>
              </View>
            ) : (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Review before resetting</Text>
                <Text style={styles.body}>A private copy of the affected saved attention data will be retained on this device.</Text>
                <Text style={styles.meta}>No data changes until you prepare a review and separately confirm it.</Text>
              </View>
            )}

            {props.error ? <Text accessibilityRole="alert" style={styles.error}>{props.error}</Text> : null}
            {plan ? (
              <>
                <Text style={styles.label}>TYPE RESET RULES TO CONFIRM</Text>
                <TextInput
                  accessibilityLabel="Type RESET RULES to confirm recovery"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  editable={!props.busy}
                  value={confirmation}
                  onChangeText={setConfirmation}
                  placeholder="RESET RULES"
                  placeholderTextColor={C.muted}
                  style={styles.input}
                />
                <Button
                  label={props.busy ? "Applying recovery…" : "Reset rules and local attention"}
                  tone="danger"
                  disabled={props.busy || props.actionsBlocked || confirmation !== "RESET RULES"}
                  onPress={() => props.onConfirm(plan.operationId)}
                />
                <Button label="Cancel review" tone="quiet" disabled={props.busy} onPress={() => props.onCancel(plan.operationId)} />
              </>
            ) : (
              <>
                <Button label={props.busy ? "Preparing review…" : "Prepare recovery review"} disabled={props.busy || props.actionsBlocked} onPress={props.onPrepare} />
                <Button label="Close" tone="quiet" disabled={props.busy} onPress={props.onClose} />
              </>
            )}
            <Text style={styles.footer}>No provider or model request is made by this local recovery.</Text>
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = {
  safe: { flex: 1, backgroundColor: C.bg },
  content: { flexGrow: 1, paddingTop: 6, paddingBottom: 32 },
  card: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 15, gap: 9 },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: "700" as const },
  body: { color: C.text, fontSize: 14, lineHeight: 20 },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  label: { color: C.muted, fontSize: 11, fontWeight: "700" as const, letterSpacing: 0.7 },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: C.border, backgroundColor: C.input, color: C.text, paddingHorizontal: 14, fontSize: 16 },
  error: { color: C.red, fontSize: 13, lineHeight: 19 },
  sample: { color: C.sage, fontSize: 11, fontWeight: "700" as const, letterSpacing: 1.2 },
  footer: { color: C.muted, fontSize: 12, lineHeight: 18, textAlign: "center" as const, paddingTop: 5 },
};
