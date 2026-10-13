export type ChatReplySnapshot = Readonly<{
  summary: string;
  answer: string;
  clarifications: readonly string[];
  completedAt: string;
  requestSha256: string;
  requestProfileVersion: 1 | 2;
}>;

export type ChatTurn = Readonly<{
  id: string;
  noteId: string;
  noteRevision: number;
  jobId: string;
  userText: string;
  createdAt: string;
  captureTimeZone: string;
  reply?: ChatReplySnapshot;
  replySha256?: string;
}>;

export type ChatConversation = Readonly<{
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: readonly ChatTurn[];
}>;

export type ReadonlyChatLedger = Readonly<{
  version: 1;
  conversations: readonly ChatConversation[];
}>;

export type ChatContextTurn = Readonly<{
  turnId: string;
  jobId: string;
  userText: string;
  assistantText: string;
}>;

export type SelectedChatContext = Readonly<{
  turns: readonly ChatContextTurn[];
  omittedTurnCount: number;
  includedBytes: number;
}>;

export type ChatTurnDTO = Readonly<{
  id: string;
  noteId: string;
  userText: string;
  createdAt: string;
  reply?: Pick<ChatReplySnapshot, 'summary' | 'answer' | 'clarifications' | 'completedAt'>;
  job?: import('../services/openRouterBatchJobs').AssistantBatchJobDTO;
}>;

export type ChatConversationDTO = Readonly<{
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: readonly ChatTurnDTO[];
}>;
