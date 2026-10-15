import type { WorkspaceHttpAdmission } from './workspaceHttp.js';
import type { BackgroundPolicyDisplay, BackgroundPolicyReceipt } from './backgroundContracts.js';

export const BACKGROUND_POLICIES_PATH = '/api/workspace/background/policies';
export const BACKGROUND_POLICY_PAUSE_PATH = '/api/workspace/background/policies/pause';
export const BACKGROUND_POLICY_REVOKE_PATH = '/api/workspace/background/policies/revoke';

/** Named authenticated transport surface. It deliberately has no occurrence execution method. */
export interface BackgroundHttpApi {
  saveBackgroundPolicy(admission: WorkspaceHttpAdmission, envelope: unknown): BackgroundPolicyReceipt;
  pauseBackgroundPolicy(admission: WorkspaceHttpAdmission, envelope: unknown): BackgroundPolicyReceipt;
  revokeBackgroundPolicy(admission: WorkspaceHttpAdmission, envelope: unknown): BackgroundPolicyReceipt;
  listBackgroundPolicies(admission: WorkspaceHttpAdmission, input: Readonly<{ expectedPrivacyEpoch: number; afterPolicyId?: string; limit?: number }>): readonly BackgroundPolicyDisplay[];
  inspectBackgroundPolicyReceipt(admission: WorkspaceHttpAdmission, input: Readonly<{ commandId: string; expectedPrivacyEpoch: number }>): BackgroundPolicyReceipt | undefined;
}
