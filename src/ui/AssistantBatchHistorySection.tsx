import React from 'react';
import { Text, View } from 'react-native';
import type { AssistantBatchJobDTO } from '../services/openRouterBatchJobs';
import { AssistantBatchJobCard } from './AssistantBatchJobCard';
import { C, s } from './theme';

type Props = {
  jobs: readonly AssistantBatchJobDTO[];
  recoveryMessage?: string;
  busy?: boolean;
  blocked?: boolean;
  onCheck?: (jobId: string) => Promise<unknown> | unknown;
  onRetryCleanup?: (jobId: string) => Promise<unknown> | unknown;
};

/** Global, content-free queue and accounting view; it deliberately never renders job or note IDs. */
export function AssistantBatchHistorySection({
  jobs,
  recoveryMessage,
  busy = false,
  blocked = false,
  onCheck,
  onRetryCleanup,
}: Props) {
  const ordered = jobs
    .filter((job) => job.kind === 'note_assistance')
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return (
    <View style={styles.section}>
      <Text style={s.sectionTitle}>OpenRouter Batch history</Text>
      <Text style={s.disclaimer}>
        Check for replies only when you choose. Provider-reported usage is shown when available; no cost estimates are used.
      </Text>
      {recoveryMessage ? (
        <Text accessibilityRole="alert" style={styles.warning}>{recoveryMessage}</Text>
      ) : null}
      {ordered.length ? ordered.map((job) => (
        <AssistantBatchJobCard
          key={job.id}
          job={job}
          busy={busy}
          blocked={blocked}
          onCheck={onCheck}
          onRetryCleanup={onRetryCleanup}
        />
      )) : (
        <Text style={s.disclaimer}>No Batch requests have been recorded.</Text>
      )}
    </View>
  );
}

const styles = {
  section: { gap: 10, paddingTop: 8 },
  warning: { color: C.sage, fontSize: 13, lineHeight: 19 },
};
