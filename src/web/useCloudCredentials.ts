import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ProviderCredentialStatus } from '../services/credentials';
import type { AuthenticatedSession } from './authClient';
import {
  CredentialCommandUnknownError,
  createWebProviderCredentialService,
  WebCredentialError,
  type CredentialCommandStatus,
  type WebCredentialKind,
  type WebCredentialMetadata,
} from './credentialClient';

export type CloudCredentialPresence = Readonly<{
  speech: boolean;
  openrouter: boolean;
}>;

export type CloudCredentialState = Readonly<{
  presence: CloudCredentialPresence | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  message: string | null;
  pendingCommandId: string | null;
}>;

export type CloudCredentialMutation = Readonly<{
  admitted: boolean;
  completion: Promise<void>;
}>;

export type CloudCredentialController = CloudCredentialState & Readonly<{
  ownerGeneration: number;
  refresh(): Promise<void>;
  save(kind: WebCredentialKind, value: string, onAdmitted?: () => void): CloudCredentialMutation;
  remove(kind: WebCredentialKind): CloudCredentialMutation;
  inspectPendingCommand(): Promise<void>;
}>;

type CredentialService = ReturnType<typeof createWebProviderCredentialService>;
type ActiveOwner = Readonly<{ id: symbol; service: CredentialService }>;
type SessionBinding = Readonly<{ workspaceId: string; privacyEpoch: number; csrfToken: string }>;
type AdmittedMutation = Readonly<{ ownerId: symbol; commandId: string }>;

const INITIAL: CloudCredentialState = Object.freeze({
  presence: null,
  loading: false,
  busy: false,
  error: null,
  message: null,
  pendingCommandId: null,
});

function presenceFromStatus(status: ProviderCredentialStatus): CloudCredentialPresence {
  return Object.freeze({ speech: status.speechConfigured, openrouter: status.openRouterConfigured === true });
}

function presenceFromMetadata(metadata: WebCredentialMetadata): CloudCredentialPresence {
  return Object.freeze({ speech: metadata.credentials.speech.configured, openrouter: metadata.credentials.openrouter.configured });
}

function fixedCredentialError(error: unknown): string {
  if (error instanceof CredentialCommandUnknownError) return 'The save could not be confirmed. Inspect its receipt before making another change.';
  if (error instanceof WebCredentialError) {
    switch (error.kind) {
      case 'busy': return 'A credential change is already waiting for review.';
      case 'disposed': return 'This session is no longer available. Sign in again.';
      case 'http': return error.status === 401 || error.status === 403
        ? 'This session could not update credentials. Sign in again and retry.'
        : 'The credential request could not be completed.';
      case 'network':
      case 'timeout': return 'The credential service could not be reached. Check the receipt before trying again.';
      case 'generation': return 'Credential status changed. Refresh it before trying again.';
      case 'malformed':
      case 'unsupported': return 'The credential request could not be completed.';
    }
  }
  return 'The credential request could not be completed.';
}

function successMessage(kind: WebCredentialKind, configured: boolean): string {
  const label = kind === 'speech' ? 'Azure Speech' : 'OpenRouter';
  return `${label} credential status confirmed · ${configured ? 'configured' : 'not configured'}.`;
}

function matchingAdmittedCommand(
  admittedRef: { current: AdmittedMutation | null },
  pendingRef: { current: string | null },
  originRef: { current: symbol | null },
  ownerId: symbol,
): string | null {
  const admitted = admittedRef.current;
  return admitted && admitted.ownerId === ownerId && pendingRef.current === admitted.commandId &&
    originRef.current === ownerId ? admitted.commandId : null;
}

/** Session-owned, metadata-only browser credential controls. */
export function useCloudCredentials(session: AuthenticatedSession | null): CloudCredentialController {
  const [state, setState] = useState<CloudCredentialState>(INITIAL);
  const [ownerGeneration, setOwnerGeneration] = useState(0);
  const activeRef = useRef<ActiveOwner | null>(null);
  const busyRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const pendingOriginRef = useRef<symbol | null>(null);
  const admittedMutationRef = useRef<AdmittedMutation | null>(null);
  const onAdmittedRef = useRef<(() => void) | null>(null);
  const bindingRef = useRef<SessionBinding | null>(null);
  const authenticated = session?.authenticated === true;
  const workspaceId = authenticated ? session.workspaceId : undefined;
  const privacyEpoch = authenticated ? session.privacyEpoch : undefined;
  const csrfToken = authenticated ? session.csrfToken : undefined;

  const isActive = useCallback((owner: ActiveOwner) => activeRef.current === owner, []);

  useLayoutEffect(() => {
    const previous = bindingRef.current;
    const workspaceChanged = !authenticated || !previous || previous.workspaceId !== workspaceId ||
      previous.privacyEpoch !== privacyEpoch;
    const ownerChanged = workspaceChanged || previous?.csrfToken !== csrfToken;
    bindingRef.current = authenticated && workspaceId !== undefined && privacyEpoch !== undefined && csrfToken !== undefined
      ? Object.freeze({ workspaceId, privacyEpoch, csrfToken })
      : null;
    if (ownerChanged) {
      if (workspaceChanged) {
        pendingRef.current = null;
        pendingOriginRef.current = null;
        admittedMutationRef.current = null;
      }
      busyRef.current = false;
      setOwnerGeneration((current) => current + 1);
      if (workspaceChanged) setState(INITIAL);
    }
    if (!authenticated || workspaceId === undefined || privacyEpoch === undefined || csrfToken === undefined) {
      activeRef.current = null;
      busyRef.current = false;
      pendingRef.current = null;
      pendingOriginRef.current = null;
      return;
    }

    let service: CredentialService;
    const ownerId = Symbol('cloud-credentials-owner');
    let owner: ActiveOwner | null = null;
    try {
      const boundSession: AuthenticatedSession = Object.freeze({ authenticated: true, workspaceId, privacyEpoch, csrfToken });
      service = createWebProviderCredentialService(boundSession, () => csrfToken, {
        onMutationAdmitted(commandId) {
          if (!owner || !isActive(owner)) return;
          pendingRef.current = commandId;
          pendingOriginRef.current = owner.id;
          admittedMutationRef.current = Object.freeze({ ownerId: owner.id, commandId });
          onAdmittedRef.current?.();
          onAdmittedRef.current = null;
          setState((current) => ({ ...current, pendingCommandId: commandId, error: null, message: null }));
        },
      });
    } catch {
      setState({ ...INITIAL, error: 'Credential settings could not be opened for this session.' });
      return;
    }
    const activeOwner: ActiveOwner = Object.freeze({ id: ownerId, service });
    owner = activeOwner;
    activeRef.current = activeOwner;
    busyRef.current = true;
    setState((current) => ({
      ...current,
      loading: true,
      busy: true,
      error: null,
      message: null,
      pendingCommandId: pendingRef.current,
    }));

    void service.getCredentials().then((status) => {
      if (!isActive(activeOwner)) return;
      setState((current) => ({ ...current, presence: presenceFromStatus(status), error: null }));
    }).catch((error: unknown) => {
      if (!isActive(activeOwner)) return;
      setState((current) => ({ ...current, error: fixedCredentialError(error) }));
    }).finally(() => {
      if (!isActive(activeOwner)) return;
      busyRef.current = false;
      setState((current) => ({ ...current, loading: false, busy: false }));
    });

    return () => {
      if (activeRef.current === activeOwner) activeRef.current = null;
      service.dispose();
    };
  }, [authenticated, workspaceId, privacyEpoch, csrfToken, isActive]);

  const currentOwner = (): ActiveOwner | null => activeRef.current;
  const publishBusy = useCallback((owner: ActiveOwner, busy: boolean) => {
    if (!isActive(owner)) return;
    busyRef.current = busy;
    setState((current) => ({ ...current, busy, loading: false, pendingCommandId: pendingRef.current }));
  }, [isActive]);

  const refresh = useCallback(async () => {
    const owner = currentOwner();
    if (!owner || busyRef.current || pendingRef.current) return;
    busyRef.current = true;
    setState((current) => ({ ...current, loading: true, busy: true, error: null, message: null }));
    try {
      const status = await owner.service.getCredentials();
      if (!isActive(owner)) return;
      setState((current) => ({ ...current, presence: presenceFromStatus(status), error: null }));
    } catch (error) {
      if (!isActive(owner)) return;
      setState((current) => ({ ...current, error: fixedCredentialError(error) }));
    } finally {
      if (isActive(owner)) {
        busyRef.current = false;
        setState((current) => ({ ...current, loading: false, busy: false, pendingCommandId: pendingRef.current }));
      }
    }
  }, [isActive]);

  const mutate = useCallback((kind: WebCredentialKind, value?: string, onAdmitted?: () => void): CloudCredentialMutation => {
    const owner = currentOwner();
    if (!owner || busyRef.current || pendingRef.current) return { admitted: false, completion: Promise.resolve() };
    const normalizedValue = value?.trim();
    if (value !== undefined && (!normalizedValue || normalizedValue.length > 512)) {
      setState((current) => ({ ...current, error: 'Enter a credential of 1 to 512 characters.', message: null }));
      return { admitted: false, completion: Promise.resolve() };
    }
    busyRef.current = true;
    const admittedHandler = onAdmitted ?? null;
    onAdmittedRef.current = admittedHandler;
    setState((current) => ({ ...current, busy: true, loading: false, error: null, message: null }));
    const completion = (async () => {
      try {
        const status = value === undefined
          ? await owner.service.deleteCredentials(kind)
          : await owner.service.setCredentials(kind === 'speech'
            ? { speechSubscriptionKey: normalizedValue }
            : { openRouterApiKey: normalizedValue });
        if (!isActive(owner)) return;
        const admittedCommandId = matchingAdmittedCommand(admittedMutationRef, pendingRef, pendingOriginRef, owner.id);
        if (admittedCommandId) {
          pendingRef.current = null;
          pendingOriginRef.current = null;
          admittedMutationRef.current = null;
        }
        const presence = presenceFromStatus(status);
        setState((current) => ({
          ...current,
          presence,
          error: null,
          message: value === undefined
            ? (!presence[kind] ? `${kind === 'speech' ? 'Azure Speech' : 'OpenRouter'} credential removed.` : successMessage(kind, presence[kind]))
            : (presence[kind] ? `${kind === 'speech' ? 'Azure Speech' : 'OpenRouter'} credential saved.` : successMessage(kind, presence[kind])),
        }));
      } catch (error) {
        if (!isActive(owner)) return;
        if (error instanceof CredentialCommandUnknownError) {
          pendingRef.current = error.commandId;
          pendingOriginRef.current = owner.id;
          admittedMutationRef.current = Object.freeze({ ownerId: owner.id, commandId: error.commandId });
        } else {
          const admittedCommandId = matchingAdmittedCommand(admittedMutationRef, pendingRef, pendingOriginRef, owner.id);
          if (admittedCommandId) {
            pendingRef.current = null;
            pendingOriginRef.current = null;
            admittedMutationRef.current = null;
          }
        }
        setState((current) => ({
          ...current,
          error: fixedCredentialError(error),
          message: null,
          pendingCommandId: pendingRef.current,
        }));
      } finally {
        if (isActive(owner) && onAdmittedRef.current === admittedHandler) onAdmittedRef.current = null;
        publishBusy(owner, false);
      }
    })();
    return { admitted: true, completion };
  }, [isActive, publishBusy]);

  const inspectPendingCommand = useCallback(async () => {
    const owner = currentOwner();
    const commandId = pendingRef.current;
    if (!owner || !commandId || busyRef.current) return;
    busyRef.current = true;
    setState((current) => ({ ...current, busy: true, error: null, message: null, pendingCommandId: commandId }));
    try {
      const receipt: CredentialCommandStatus = await owner.service.checkCredentialCommand(commandId);
      if (!isActive(owner)) return;
      if (receipt.status !== 'finished') {
        setState((current) => ({ ...current, message: 'The credential change is still being checked. No new change was sent.' }));
        return;
      }
      // Only the service that admitted the command upgrades finished receipt
      // metadata to a fresh metadata read. A replacement service sees history.
      const originalService = pendingOriginRef.current === owner.id;
      const presence = originalService && receipt.metadata
        ? presenceFromMetadata(receipt.metadata)
        : presenceFromStatus(await owner.service.getCredentials());
      if (!isActive(owner)) return;
      pendingRef.current = null;
      pendingOriginRef.current = null;
      setState((current) => ({ ...current, presence, pendingCommandId: null, error: null, message: 'The saved credential status is confirmed.' }));
    } catch (error) {
      if (!isActive(owner)) return;
      setState((current) => ({ ...current, error: fixedCredentialError(error), pendingCommandId: pendingRef.current, message: null }));
    } finally {
      publishBusy(owner, false);
    }
  }, [isActive, publishBusy]);

  return {
    ...state,
    ownerGeneration,
    pendingCommandId: state.pendingCommandId,
    refresh,
    save: (kind, value, onAdmitted) => mutate(kind, value, onAdmitted),
    remove: (kind) => mutate(kind),
    inspectPendingCommand,
  };
}
