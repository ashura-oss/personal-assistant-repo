import React, { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import type { Account, AccountCapability, AccountSyncState } from "../core";
import { MailSyncControls } from "./MailSyncControls";
import {
  configuredProviderAuth,
  scopesFor,
  type AuthCapability,
  type OAuthProvider,
} from "../auth/browser";

const colors = {
  card: "#191B1E",
  border: "#2B2D31",
  text: "#F2F1EE",
  muted: "#969A9F",
  sage: "#879589",
};
const options: { id: AuthCapability; title: string; description: string }[] = [
  {
    id: "mail.read",
    title: "Read mail",
    description: "Allow Still to read selected inbox messages.",
  },
  {
    id: "mail.draft",
    title: "Create drafts",
    description: "Prepare email drafts for your approval.",
  },
  {
    id: "mail.send",
    title: "Send email",
    description: "Request send permission separately from drafting.",
  },
  {
    id: "calendar.read",
    title: "Read calendars",
    description: "View calendars and existing events.",
  },
  {
    id: "calendar.write",
    title: "Create calendar events",
    description: "Request event write permission separately.",
  },
];

type ConnectionsProps = {
  accounts: Account[];
  syncStates: Record<string, AccountSyncState>;
  busy: boolean;
  demoMode: boolean;
  onConnect: (
    provider: OAuthProvider,
    capabilities: AccountCapability[],
    accountId?: string,
  ) => Promise<void>;
  onDisconnect: (accountId: string) => Promise<void>;
  onSync: (accountId: string, continueSync: boolean) => Promise<void>;
  onRefreshMail: (accountId: string) => void;
  onContinueMail: (accountId: string) => void;
};

export function ConnectionsSection({
  accounts,
  syncStates,
  busy,
  demoMode,
  onConnect,
  onDisconnect,
  onSync,
  onRefreshMail,
  onContinueMail,
}: ConnectionsProps) {
  const [selected, setSelected] = useState<
    Record<OAuthProvider, AuthCapability[]>
  >({
    google: ["mail.read", "calendar.read"],
    microsoft: ["mail.read", "calendar.read"],
  });
  const [details, setDetails] = useState<Record<OAuthProvider, boolean>>({
    google: false,
    microsoft: false,
  });
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.sectionTitle}>Connections</Text>
      <Text style={styles.intro}>
        Choose access separately for each provider. Setup values are public
        client IDs and exact redirect URLs; never add a client secret to this
        app.
      </Text>
      {(["google", "microsoft"] as const).map((provider) => {
        const config = configuredProviderAuth(provider);
        const configuredAccounts = accounts.filter(
          (account) => account.provider === provider,
        );
        const callback =
          Platform.OS === "web"
            ? config.webRedirectUri
            : config.nativeRedirectUri;
        const googleWeb = provider === "google" && Platform.OS === "web";
        const ready = !googleWeb && Boolean(config.clientId && callback);
        return (
          <View key={provider} style={styles.card}>
            <Text style={styles.provider}>
              {provider === "google" ? "Google" : "Microsoft"}
            </Text>
            <Text style={styles.copy}>
              {demoMode
                ? "Account authorization is disabled in the local sample."
                : googleWeb
                  ? "Connect Google from the iOS app."
                  : ready
                    ? "App registration configured for this platform."
                    : `Not configured · add a public ${Platform.OS === "web" ? "web" : "native"} OAuth client ID and exact redirect URI to the build environment.`}
            </Text>
            <Text style={styles.scopeHeading}>Requested access</Text>
            {options.map((option) => {
              const checked = selected[provider].includes(option.id);
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`${provider} ${option.title}`}
                  accessibilityState={{ checked }}
                  disabled={demoMode}
                  onPress={() =>
                    setSelected((current) => {
                      let values = checked
                        ? current[provider].filter(
                            (value) => value !== option.id,
                          )
                        : [...current[provider], option.id];
                      if (
                        option.id === "calendar.write" &&
                        !checked &&
                        !values.includes("calendar.read")
                      )
                        values = [...values, "calendar.read"];
                      if (option.id === "calendar.read" && checked)
                        values = values.filter(
                          (value) => value !== "calendar.write",
                        );
                      return { ...current, [provider]: values };
                    })
                  }
                  style={styles.scopeRow}
                >
                  <View style={[styles.checkbox, checked && styles.checkboxOn]}>
                    <Text style={styles.check}>{checked ? "✓" : ""}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.scopeTitle}>{option.title}</Text>
                    <Text style={styles.detail}>{option.description}</Text>
                  </View>
                </Pressable>
              );
            })}
            {selected[provider].includes("calendar.write") ? (
              <Text style={styles.notice}>
                Create events includes calendar read access so you can choose
                the destination calendar.
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${provider} OAuth registration details`}
              accessibilityState={{ expanded: details[provider] }}
              disabled={demoMode}
              onPress={() =>
                setDetails((current) => ({
                  ...current,
                  [provider]: !current[provider],
                }))
              }
              style={styles.detailsToggle}
            >
              <Text style={styles.detailsToggleText}>
                {details[provider]
                  ? "Hide registration details"
                  : "Registration details"}
              </Text>
            </Pressable>
            {details[provider] ? (
              <View style={styles.detailsBox}>
                <Text style={styles.detail}>
                  Client ID: {config.clientId || "Not set"}
                </Text>
                <Text style={styles.detail}>
                  Native callback:{" "}
                  {config.nativeRedirectUri ||
                    "Not set · rebuild required after registration"}
                </Text>
                <Text style={styles.detail}>
                  Web callback:{" "}
                  {config.webRedirectUri ||
                    "Not set · register a separate web callback"}
                </Text>
                {googleWeb ? (
                  <Text style={styles.detail}>
                    Google web code exchange needs a confidential backend, which
                    is not included. Use the iOS app for Google sign-in.
                  </Text>
                ) : null}
                {provider === "microsoft" ? (
                  <Text style={styles.detail}>
                    Authority: {config.authority ?? "common"} · allowed: common,
                    organizations, consumers, or tenant UUID
                  </Text>
                ) : null}
                <Text style={styles.detail}>
                  Requested scopes:{" "}
                  {scopesFor(provider, selected[provider]).join(" · ")}
                </Text>
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Add ${provider} account`}
              accessibilityState={{
                disabled:
                  demoMode || busy || !ready || selected[provider].length === 0,
              }}
              disabled={
                demoMode || busy || !ready || selected[provider].length === 0
              }
              onPress={() => onConnect(provider, selected[provider])}
              style={[
                styles.connectButton,
                (demoMode ||
                  busy ||
                  !ready ||
                  selected[provider].length === 0) &&
                  styles.connectButtonDisabled,
              ]}
            >
              <Text style={styles.connectButtonText}>
                Add {provider} account
              </Text>
            </Pressable>
            {demoMode ? (
              <Text style={styles.notice}>
                Sample account only · sign-in and credential entry are disabled.
              </Text>
            ) : !ready ? (
              <Text style={styles.notice}>
                {demoMode
                  ? "Sample account only · sign-in and credential entry are disabled."
                  : googleWeb
                    ? "Google connection is available in the iOS build."
                    : "Add setup values to enable sign-in. This does not connect an account."}
              </Text>
            ) : null}
            {configuredAccounts.map((account) => (
              <View key={account.id} style={styles.accountRow}>
                <Text style={styles.accountEmail}>
                  {demoMode
                    ? `Sample account · ${account.email}`
                    : `${account.displayName || account.email} · ${account.email}`}
                </Text>
                <Text style={styles.detail}>
                  {demoMode && account.connected
                    ? "Sample connection · read only"
                    : account.connected
                      ? `Verified${account.lastSyncedAt ? ` · synced ${new Date(account.lastSyncedAt).toLocaleString()}` : " · not synced yet"}`
                      : account.authStatus === "reauth_required"
                        ? "Reconnect required"
                        : "Configured · not connected"}
                </Text>
                {account.connected ? (
                  <View style={styles.accountActions}>
                    {account.capabilities?.includes("calendar.read") ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Sync calendars for ${account.email}`}
                        accessibilityState={{ disabled: busy }}
                        disabled={busy}
                        onPress={() => onSync(account.id, false)}
                        style={styles.actionButton}
                      >
                        <Text style={styles.actionText}>Sync calendars</Text>
                      </Pressable>
                    ) : null}
                    {account.capabilities?.includes("calendar.read") &&
                    syncStates[account.id]?.status === "partial" ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Continue calendar sync for ${account.email}`}
                        accessibilityState={{ disabled: busy }}
                        disabled={busy}
                        onPress={() => onSync(account.id, true)}
                        style={styles.actionButton}
                      >
                        <Text style={styles.actionText}>
                          Continue calendars
                        </Text>
                      </Pressable>
                    ) : null}
                    {!demoMode ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Reconnect ${account.email}`}
                        accessibilityState={{ disabled: busy || !ready }}
                        disabled={busy || !ready}
                        onPress={() =>
                          onConnect(provider, selected[provider], account.id)
                        }
                        style={styles.actionButton}
                      >
                        <Text style={styles.actionText}>Reconnect</Text>
                      </Pressable>
                    ) : null}
                    {!demoMode ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Disconnect ${account.email}`}
                        accessibilityState={{ disabled: busy }}
                        disabled={busy}
                        onPress={() => onDisconnect(account.id)}
                        style={styles.actionButton}
                      >
                        <Text style={styles.actionText}>Disconnect</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
                {account.connected &&
                account.capabilities?.includes("mail.read") ? (
                  <MailSyncControls
                    accountId={account.id}
                    email={account.email}
                    syncState={syncStates[account.id]}
                    busy={busy}
                    onRefresh={onRefreshMail}
                    onContinue={onContinueMail}
                  />
                ) : null}
                {account.syncStatus === "partial" ? (
                  <Text style={styles.notice}>
                    Some items remain to sync. Continue resumes from the saved
                    cursor.
                  </Text>
                ) : null}
                {account.syncStatus === "error" ? (
                  <Text style={styles.notice}>
                    Sync needs attention. Reconnect or try again.
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        );
      })}
      <Text style={styles.notice}>
        {demoMode
          ? "Provider sign-in, credential entry, and account changes are disabled in this sample. Mail shown here comes only from a local fixture."
          : "Browser access and credentials are memory-only. Native tokens will use Keychain/Keystore only after the connector verifies the account against the provider resource. Request only the access you intend to use."}
      </Text>
    </View>
  );
}

const styles = {
  sectionTitle: {
    color: colors.text,
    fontSize: 19,
    fontWeight: "600" as const,
    marginTop: 13,
  },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 17,
    padding: 16,
    gap: 10,
  },
  provider: { color: colors.text, fontSize: 17, fontWeight: "600" as const },
  copy: { color: colors.text, fontSize: 13, lineHeight: 19 },
  detail: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  scopeHeading: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600" as const,
    marginTop: 4,
  },
  scopeRow: {
    minHeight: 52,
    flexDirection: "row" as const,
    gap: 10,
    alignItems: "center" as const,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  checkboxOn: { backgroundColor: colors.sage, borderColor: colors.sage },
  check: { color: "#101113", fontSize: 15, fontWeight: "700" as const },
  scopeTitle: { color: colors.text, fontSize: 13, fontWeight: "500" as const },
  connectButton: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: "#F2F1EE",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginTop: 4,
  },
  connectButtonDisabled: { opacity: 0.42 },
  connectButtonText: {
    color: "#101113",
    fontSize: 14,
    fontWeight: "600" as const,
  },
  detailsToggle: { minHeight: 44, justifyContent: "center" as const },
  detailsToggleText: { color: colors.muted, fontSize: 12 },
  detailsBox: {
    gap: 5,
    backgroundColor: "#151719",
    borderRadius: 11,
    padding: 10,
  },
  notice: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  accountRow: {
    borderTopWidth: 1,
    borderColor: colors.border,
    paddingTop: 10,
    gap: 4,
  },
  accountEmail: { color: colors.text, fontSize: 13 },
  accountActions: {
    flexDirection: "row" as const,
    flexWrap: "wrap" as const,
    gap: 8,
    marginTop: 5,
  },
  actionButton: {
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: "center" as const,
  },
  actionText: { color: colors.text, fontSize: 12, fontWeight: "600" as const },
};
