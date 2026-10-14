import type { WorkspaceSnapshotDTO } from "../src/cloud/workspaceDto";
import type { ReminderDisplayRecord, ReminderIntentDisplay } from "../src/ui/reminderDisplay";

export function acceptsReminderDTO(record: WorkspaceSnapshotDTO["state"]["reminders"]["records"][number], intent: WorkspaceSnapshotDTO["state"]["reminders"]["intents"][number]) {
  const displayedRecord: ReminderDisplayRecord = record;
  const displayedIntent: ReminderIntentDisplay = intent;
  return { displayedRecord, displayedIntent };
}

type ExpectFalse<T extends false> = T;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
export type ReminderDisplayExcludesCurrentIntent = ExpectFalse<HasKey<ReminderDisplayRecord, "currentIntentId">>;
export type ReminderDisplayExcludesApprovedDigest = ExpectFalse<HasKey<ReminderDisplayRecord, "approvedPayloadDigest">>;
export type ReminderIntentDisplayExcludesIdentifier = ExpectFalse<HasKey<ReminderIntentDisplay, "identifier">>;
