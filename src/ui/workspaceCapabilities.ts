/** A coordinator action that is either callable or explicitly unavailable with a user-facing reason. */
export type WorkspaceActionCapability<T> = Readonly<{ available: true; action: T }> | Readonly<{ available: false; reason: string }>;
export type WorkspaceCapabilityStatus = Readonly<{ available: true }> | Readonly<{ available: false; reason: string }>;
