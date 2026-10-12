import React, { useState } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import type { Account, AppSettings, SavedProactiveRule } from "../core";
import type { ProactiveTrigger, QuietHours } from "../proactive";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Button, Field } from "./primitives";
import { C, s } from "./theme";

type RuleInput = Parameters<
  import("../core").AppController["saveProactiveRule"]
>[0];

type Props = {
  rules: SavedProactiveRule[];
  accounts: Account[];
  timezone: AppSettings["timezone"];
  busy: boolean;
  onSave: (input: RuleInput) => Promise<SavedProactiveRule | undefined>;
  onDelete: (
    id: string,
    expectedVersion: number,
  ) => Promise<boolean | undefined>;
};

type TriggerKind = ProactiveTrigger["type"];

const triggerChoices: { value: TriggerKind; label: string }[] = [
  { value: "unread_from", label: "Unread from" },
  { value: "keyword", label: "Keyword" },
  { value: "meeting_soon", label: "Meeting soon" },
  { value: "task_due", label: "Task due" },
];

function splitList(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
}

function describeTrigger(trigger: ProactiveTrigger) {
  switch (trigger.type) {
    case "unread_from":
      return `Unread from ${trigger.addresses.join(", ")}`;
    case "keyword":
      return `Keyword: ${trigger.keywords.join(", ")}`;
    case "meeting_soon":
      return `Meeting within ${trigger.minutes} minutes`;
    case "task_due":
      return `Task due within ${trigger.minutes} minutes`;
  }
}

export function ProactiveRulesSection({
  rules,
  accounts,
  timezone,
  busy,
  onSave,
  onDelete,
}: Props) {
  const [editing, setEditing] = useState<SavedProactiveRule | undefined>();
  const [name, setName] = useState("");
  const [triggerKind, setTriggerKind] = useState<TriggerKind>("unread_from");
  const [addresses, setAddresses] = useState("");
  const [keywords, setKeywords] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [minutes, setMinutes] = useState("30");
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState("22:00");
  const [quietEnd, setQuietEnd] = useState("08:00");
  const [formError, setFormError] = useState("");

  const reset = () => {
    setEditing(undefined);
    setName("");
    setTriggerKind("unread_from");
    setAddresses("");
    setKeywords("");
    setUnreadOnly(true);
    setMinutes("30");
    setAccountIds([]);
    setQuietEnabled(false);
    setQuietStart("22:00");
    setQuietEnd("08:00");
    setFormError("");
  };

  const beginEdit = (rule: SavedProactiveRule) => {
    setEditing(rule);
    setName(rule.name);
    setTriggerKind(rule.trigger.type);
    setAddresses(
      rule.trigger.type === "unread_from"
        ? rule.trigger.addresses.join("\n")
        : "",
    );
    setKeywords(
      rule.trigger.type === "keyword" ? rule.trigger.keywords.join("\n") : "",
    );
    setUnreadOnly(
      rule.trigger.type !== "keyword" || rule.trigger.unreadOnly !== false,
    );
    setMinutes(
      rule.trigger.type === "meeting_soon" || rule.trigger.type === "task_due"
        ? String(rule.trigger.minutes)
        : "30",
    );
    setAccountIds(rule.accountIds);
    setQuietEnabled(Boolean(rule.quietHours));
    setQuietStart(rule.quietHours?.start ?? "22:00");
    setQuietEnd(rule.quietHours?.end ?? "08:00");
    setFormError("");
  };

  const submit = async () => {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 80) {
      setFormError("Add a name up to 80 characters.");
      return;
    }
    let trigger: ProactiveTrigger;
    if (triggerKind === "unread_from") {
      const parsed = splitList(addresses);
      if (
        !parsed.length ||
        parsed.length > 20 ||
        parsed.some(
          (address) => !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address),
        )
      ) {
        setFormError(
          "Enter 1–20 email addresses, separated by commas or new lines.",
        );
        return;
      }
      trigger = { type: "unread_from", addresses: parsed };
    } else if (triggerKind === "keyword") {
      const parsed = splitList(keywords);
      if (
        !parsed.length ||
        parsed.length > 10 ||
        parsed.some((keyword) => keyword.length > 128)
      ) {
        setFormError("Enter 1–10 keywords, each up to 128 characters.");
        return;
      }
      trigger = { type: "keyword", keywords: parsed, unreadOnly };
    } else {
      const amount = Number(minutes);
      if (!Number.isInteger(amount) || amount < 1 || amount > 10_080) {
        setFormError("Choose a time from 1 to 10,080 minutes.");
        return;
      }
      trigger = { type: triggerKind, minutes: amount };
    }
    let quietHours: QuietHours | undefined;
    if (quietEnabled) {
      if (
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(quietStart) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(quietEnd)
      ) {
        setFormError("Quiet hours need valid 24-hour times in HH:mm.");
        return;
      }
      if (quietStart === quietEnd) {
        setFormError(
          "Start and end times must differ; equal times would disable quiet hours.",
        );
        return;
      }
      quietHours = { start: quietStart, end: quietEnd };
    }
    setFormError("");
    const saved = await onSave({
      ...(editing ? { id: editing.id, expectedVersion: editing.version } : {}),
      name: cleanName,
      enabled: editing?.enabled ?? true,
      accountIds: triggerKind === "task_due" ? [] : accountIds,
      trigger,
      ...(quietHours ? { quietHours } : {}),
    });
    if (saved) reset();
  };

  const requestDelete = (rule: SavedProactiveRule) => {
    const remove = () => {
      void onDelete(rule.id, rule.version);
    };
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      if (
        window.confirm(
          `Delete “${rule.name}”? This removes only the local rule.`,
        )
      )
        remove();
    } else {
      Alert.alert(
        "Delete local rule?",
        `Delete “${rule.name}”? This removes only the local rule.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: remove },
        ],
      );
    }
  };

  const saveEnabled = (rule: SavedProactiveRule, enabled: boolean) => {
    void onSave({
      id: rule.id,
      expectedVersion: rule.version,
      name: rule.name,
      enabled,
      accountIds: rule.accountIds,
      trigger: rule.trigger,
      ...(rule.quietHours ? { quietHours: rule.quietHours } : {}),
    });
  };

  return (
    <View style={styles.sectionCard}>
      <Text style={s.sectionTitle}>Attention rules</Text>
      <Text style={s.disclaimer}>
        Local checks over saved mail, calendar details, and open tasks. No
        messages are sent and no notifications are pushed.
      </Text>
      {rules.length ? (
        rules.map((rule) => (
          <View key={rule.id} style={styles.ruleRow}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.accountName}>{rule.name}</Text>
              <Text style={s.accountSub}>{describeTrigger(rule.trigger)}</Text>
            </View>
            <Switch
              accessibilityLabel={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
              value={rule.enabled}
              disabled={busy}
              onValueChange={(value) => saveEnabled(rule, value)}
              trackColor={{ false: C.border, true: C.sage }}
              thumbColor={C.text}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${rule.name}`}
              disabled={busy}
              onPress={() => beginEdit(rule)}
              style={styles.smallIcon}
            >
              <Ionicons
                accessible={false}
                name="create-outline"
                size={18}
                color={C.text}
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${rule.name}`}
              disabled={busy}
              onPress={() => requestDelete(rule)}
              style={styles.smallIcon}
            >
              <Ionicons
                accessible={false}
                name="trash-outline"
                size={18}
                color={C.red}
              />
            </Pressable>
          </View>
        ))
      ) : (
        <Text style={s.emptyText}>No attention rules yet.</Text>
      )}

      <View style={styles.formHeader}>
        <Text style={s.label}>
          {editing ? `Edit ${editing.name}` : "Create a rule"}
        </Text>
        {editing ? (
          <Button
            label="Cancel edit"
            tone="quiet"
            onPress={reset}
            disabled={busy}
          />
        ) : null}
      </View>
      <Field
        label="Rule name"
        value={name}
        onChangeText={(value) => setName(value.slice(0, 80))}
        placeholder="People to follow up with"
      />
      <Text style={s.label}>When should it match?</Text>
      <View style={styles.choiceGrid}>
        {triggerChoices.map((choice) => (
          <Pressable
            key={choice.value}
            accessibilityRole="radio"
            accessibilityState={{ selected: triggerKind === choice.value }}
            onPress={() => setTriggerKind(choice.value)}
            style={[
              styles.choice,
              triggerKind === choice.value && styles.choiceSelected,
            ]}
          >
            <Text
              style={[
                s.pillText,
                triggerKind === choice.value && s.pillTextActive,
              ]}
            >
              {choice.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {triggerKind === "unread_from" ? (
        <Field
          label="Sender addresses"
          value={addresses}
          onChangeText={setAddresses}
          multiline
          placeholder={"morgan@example.com\nteam@example.com"}
        />
      ) : null}
      {triggerKind === "keyword" ? (
        <>
          <Field
            label="Literal keywords"
            value={keywords}
            onChangeText={setKeywords}
            multiline
            placeholder={"project\napproval"}
          />
          <View style={styles.switchRow}>
            <Text style={s.accountName}>Unread mail only</Text>
            <Switch
              accessibilityLabel="Match unread messages only"
              value={unreadOnly}
              onValueChange={setUnreadOnly}
              trackColor={{ false: C.border, true: C.sage }}
              thumbColor={C.text}
            />
          </View>
        </>
      ) : null}
      {triggerKind === "meeting_soon" || triggerKind === "task_due" ? (
        <Field
          label="Within · minutes"
          value={minutes}
          onChangeText={setMinutes}
          keyboardType="numeric"
        />
      ) : null}
      {triggerKind === "task_due" ? (
        <Text style={s.disclaimer}>
          Task rules apply to local open tasks, so no account selection is
          needed.
        </Text>
      ) : (
        <>
          <Text style={s.label}>Where should it look?</Text>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: accountIds.length === 0 }}
            onPress={() => setAccountIds([])}
            style={[
              s.accountChoice,
              accountIds.length === 0 && s.accountChoiceSelected,
            ]}
          >
            <Text style={s.accountName}>
              All sources, including local tasks
            </Text>
          </Pressable>
          {accounts
            .filter((account) => account.provider !== "local")
            .map((account) => {
              const selected = accountIds.includes(account.id);
              return (
                <Pressable
                  key={account.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected }}
                  onPress={() =>
                    setAccountIds(
                      selected
                        ? accountIds.filter((id) => id !== account.id)
                        : [...accountIds, account.id],
                    )
                  }
                  style={[s.accountChoice, selected && s.accountChoiceSelected]}
                >
                  <Text style={s.accountName}>
                    {account.displayName || account.email}
                  </Text>
                  <Text style={s.accountSub}>
                    {account.email} ·{" "}
                    {account.connected ? "Connected" : "Configured"}
                  </Text>
                </Pressable>
              );
            })}
        </>
      )}
      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.accountName}>Quiet hours</Text>
          <Text style={s.accountSub}>
            Uses {timezone} and only defers in-app attention.
          </Text>
        </View>
        <Switch
          accessibilityLabel="Enable quiet hours"
          value={quietEnabled}
          onValueChange={setQuietEnabled}
          trackColor={{ false: C.border, true: C.sage }}
          thumbColor={C.text}
        />
      </View>
      {quietEnabled ? (
        <View style={styles.timeRow}>
          <View style={{ flex: 1 }}>
            <Field
              label="Quiet starts · HH:mm"
              value={quietStart}
              onChangeText={setQuietStart}
              placeholder="22:00"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label="Quiet ends · HH:mm"
              value={quietEnd}
              onChangeText={setQuietEnd}
              placeholder="08:00"
            />
          </View>
        </View>
      ) : null}
      {quietEnabled && quietStart === quietEnd ? (
        <Text style={s.disclaimer}>
          Equal start and end times turn quiet hours off; choose different
          times.
        </Text>
      ) : null}
      {formError ? (
        <Text accessibilityRole="alert" style={s.errorText}>
          {formError}
        </Text>
      ) : null}
      <Button
        label={editing ? "Save rule changes" : "Create attention rule"}
        onPress={() => void submit()}
        disabled={busy}
      />
      <Text style={s.disclaimer}>
        Rules only organize local attention. They do not grant authority to
        send, schedule, or reply.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionCard: {
    backgroundColor: C.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    gap: 12,
  },
  ruleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingVertical: 12,
  },
  smallIcon: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
  },
  formHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 16,
  },
  choiceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    minHeight: 44,
    minWidth: "46%",
    paddingHorizontal: 12,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  choiceSelected: { borderColor: C.sage, backgroundColor: "#202522" },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
  },
  timeRow: { flexDirection: "row", gap: 10 },
});
