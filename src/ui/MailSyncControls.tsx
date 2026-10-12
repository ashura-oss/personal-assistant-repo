import React from "react";
import { Text, View } from "react-native";
import type { AccountSyncState } from "../core";
import { Button } from "./primitives";
import { C } from "./theme";

type Props = {
  accountId: string;
  email: string;
  syncState?: AccountSyncState;
  busy: boolean;
  onRefresh: (accountId: string) => void;
  onContinue: (accountId: string) => void;
};

export function MailSyncControls({
  accountId,
  email,
  syncState,
  busy,
  onRefresh,
  onContinue,
}: Props) {
  const head = syncState?.mailHead;
  const backfill = syncState?.mailBackfill;
  const range = backfill?.coverage;
  const partial = backfill?.status === "partial";
  const laneBusy =
    syncState?.mailHead.status === "syncing" || backfill?.status === "syncing";
  const newerMailRemains = Boolean(
    backfill?.coverageNeededThrough &&
    (!range ||
      Date.parse(backfill.coverageNeededThrough) > Date.parse(range.through)),
  );
  const canContinue = Boolean(
    backfill?.activeWindow || newerMailRemains || partial,
  );

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>Mail</Text>
      {head?.lastPageCheckedAt ? (
        <Text style={styles.copy}>
          Recent page checked {formatDate(head.lastPageCheckedAt)}
          {head.status === "partial"
            ? "; more mail remains in this range."
            : "."}
        </Text>
      ) : (
        <Text style={styles.copy}>Recent mail has not been checked yet.</Text>
      )}
      {head?.lastError ? (
        <Text style={styles.error}>{head.lastError}</Text>
      ) : null}
      <Button
        label="Check recent mail"
        tone="quiet"
        disabled={busy || laneBusy}
        onPress={() => onRefresh(accountId)}
      />
      {range ? (
        <Text style={styles.copy}>
          Mail checked from {formatDate(range.from)} through{" "}
          {formatDate(range.through)}.
        </Text>
      ) : backfill?.activeWindow ? (
        <Text style={styles.copy}>
          Older mail scan is in progress; some pages have been checked.
        </Text>
      ) : backfill?.lastCompletedAt ? (
        <Text style={styles.copy}>
          Older mail scan completed {formatDate(backfill.lastCompletedAt)}
        </Text>
      ) : (
        <Text style={styles.copy}>Older mail has not been scanned yet.</Text>
      )}
      {backfill?.olderHistoryNotCheckedBefore ? (
        <Text style={styles.copy}>
          Current mail scans cover the last 14 days; older gaps were not checked
          in this scan.
        </Text>
      ) : null}
      {backfill?.lastError ? (
        <Text style={styles.error}>{backfill.lastError}</Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          label={canContinue ? "Continue mail scan" : "Load older mail"}
          tone="quiet"
          disabled={busy || laneBusy}
          onPress={() => onContinue(accountId)}
        />
        {newerMailRemains && backfill?.coverageNeededThrough ? (
          <Text style={styles.copy}>
            Newer mail remains to scan through{" "}
            {formatDate(backfill.coverageNeededThrough)}.
          </Text>
        ) : null}
      </View>
      <Text style={styles.caption}>Saved for {email}</Text>
    </View>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : value;
}

const styles = {
  wrap: {
    gap: 8,
    paddingTop: 10,
    borderTopWidth: 1,
    borderColor: C.border,
  },
  heading: { color: C.text, fontSize: 13, fontWeight: "600" as const },
  copy: { color: C.muted, fontSize: 12, lineHeight: 18 },
  caption: { color: C.muted, fontSize: 11 },
  error: { color: C.red, fontSize: 12, lineHeight: 18 },
  actions: { gap: 6 },
};
