import React from "react";
import { Pressable, Text, View } from "react-native";
import type { MailboxSnapshotMessage } from "../core";
import { C } from "./theme";
import type { WorkspaceActionCapability } from "./workspaceCapabilities";
import type { DeepReadonly } from "../cloud/workspaceDto";
import type { InboxAccountDisplay } from "./InboxWorkspaceContent";

export function MailboxSection({
  messages,
  accounts,
  onReply,
}: {
  messages: readonly DeepReadonly<MailboxSnapshotMessage>[];
  accounts: readonly DeepReadonly<InboxAccountDisplay>[];
  onReply: WorkspaceActionCapability<(messageId: string) => void>;
}) {
  const activeAccounts = accounts.filter(
    (account) =>
      account.connected &&
      account.authStatus === "connected" &&
      account.connectionGeneration !== undefined,
  );
  const recent = [...messages]
    .filter((message) => {
      if (message.providerDeletedAt || !message.verifiedIdentityKey)
        return false;
      const account = activeAccounts.find(
        (candidate) => candidate.id === message.accountId,
      );
      return Boolean(
        account &&
        message.connectionGeneration === (account.connectionGeneration ?? 0),
      );
    })
    .sort((left, right) =>
      (right.receivedAt ?? right.observedAt ?? "").localeCompare(
        left.receivedAt ?? left.observedAt ?? "",
      ),
    )
    .slice(0, 5);

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Recent saved mail</Text>
      {recent.length ? (
        recent.map((message) => {
          const account = activeAccounts.find(
            (candidate) => candidate.id === message.accountId,
          );
          return (
            <View key={message.id} style={styles.message}>
              <View style={styles.topLine}>
                <Text style={styles.subject} numberOfLines={1}>
                  {message.subject || "(no subject)"}
                </Text>
                {message.receivedAt ? (
                  <Text style={styles.date}>
                    {new Date(message.receivedAt).toLocaleDateString(
                      undefined,
                      {
                        month: "short",
                        day: "numeric",
                      },
                    )}
                  </Text>
                ) : null}
                {message.isRead === false ? (
                  <Text style={styles.unread}>Unread</Text>
                ) : null}
              </View>
              <Text style={styles.meta} numberOfLines={1}>
                {message.from || "Sender unavailable"}
                {account ? ` · ${account.email}` : ""}
              </Text>
              {message.snippet ? (
                <Text style={styles.snippet} numberOfLines={2}>
                  {message.snippet}
                </Text>
              ) : null}
              {message.observedAt ? (
                <Text style={styles.observed}>
                  Checked {new Date(message.observedAt).toLocaleString()}
                </Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Reply to ${message.subject || "message"}`}
                accessibilityState={{
                    disabled: message.replyMetadataComplete !== true || !onReply.available,
                }}
                disabled={message.replyMetadataComplete !== true || !onReply.available}
                onPress={() => { if (onReply.available) onReply.action(message.id); }}
                style={[
                  styles.replyButton,
                  (message.replyMetadataComplete !== true || !onReply.available) && styles.replyDisabled,
                ]}
              >
                <Text style={styles.replyText}>Reply</Text>
              </Pressable>
              {message.replyMetadataComplete !== true || !onReply.available ? (
                <Text style={styles.replyHint}>
                  {[message.replyMetadataComplete !== true ? "Reply details are unavailable for this saved message." : "", !onReply.available ? onReply.reason : ""].filter(Boolean).join(" ")}
                </Text>
              ) : null}
            </View>
          );
        })
      ) : (
        <Text style={styles.empty}>
          Recent saved mail from connected read-only accounts will appear here.
        </Text>
      )}
    </View>
  );
}

const styles = {
  section: { gap: 8 },
  heading: {
    color: C.text,
    fontSize: 17,
    fontWeight: "600" as const,
    marginTop: 12,
  },
  message: {
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 13,
    paddingVertical: 11,
    gap: 4,
  },
  topLine: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: 8,
  },
  subject: { color: C.text, fontSize: 13, fontWeight: "600" as const, flex: 1 },
  date: { color: C.muted, fontSize: 11 },
  unread: { color: C.sage, fontSize: 10, fontWeight: "600" as const },
  meta: { color: C.muted, fontSize: 11 },
  snippet: { color: C.text, fontSize: 12, lineHeight: 17 },
  observed: { color: C.muted, fontSize: 10 },
  replyButton: {
    alignSelf: "flex-start" as const,
    minHeight: 44,
    minWidth: 72,
    justifyContent: "center" as const,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: C.text,
    marginTop: 4,
  },
  replyDisabled: { opacity: 0.45 },
  replyText: { color: C.bg, fontSize: 12, fontWeight: "600" as const },
  replyHint: { color: C.muted, fontSize: 10, lineHeight: 15 },
  empty: { color: C.muted, fontSize: 12, lineHeight: 18 },
};
