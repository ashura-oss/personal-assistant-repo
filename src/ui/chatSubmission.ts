export type AcceptedChatSubmission = Readonly<{
  kind: 'accepted';
  conversationId: string;
  turnId: string;
  jobId: string;
}>;

export function isAcceptedChatSubmission(value: unknown): value is AcceptedChatSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  return keys.length === 4 && keys.join(',') === 'conversationId,jobId,kind,turnId' &&
    result.kind === 'accepted' &&
    typeof result.conversationId === 'string' && result.conversationId.length > 0 &&
    typeof result.turnId === 'string' && result.turnId.length > 0 &&
    typeof result.jobId === 'string' && result.jobId.length > 0;
}

/** A swallowed App.run error/undefined value is never treated as durable acceptance. */
export async function runAcceptedChatSubmission(
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>,
  action: () => Promise<unknown>,
): Promise<AcceptedChatSubmission> {
  const result = await run(action);
  if (!isAcceptedChatSubmission(result)) {
    throw new Error('Chat submission could not be confirmed. Check saved messages and request status before sending again.');
  }
  return result;
}
