/** Type contract for the generated bundle export, checked against the real factory by the root TypeScript build. */
export interface InitialWorkspaceProviderSettings {
  readonly mode: 'preview' | 'provider';
  readonly llmProvider?: 'azure' | 'openrouter';
  readonly openRouterModel?: 'openai/gpt-6-luna:batch';
  readonly openRouterReasoningEffort?: 'none' | 'low';
  readonly llmRequestContractVersion?: 1;
}
export declare function createInitialWorkspaceState(id: () => string, settings?: InitialWorkspaceProviderSettings): object;
