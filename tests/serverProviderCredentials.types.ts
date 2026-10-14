import type { ProviderCredentialService } from '../src/services/credentials';
import type { DurableKernel, OwnedWorkspaceIdentity } from '../server/src/kernel';
import type { SecretVault } from '../server/src/vault';
import { ServerProviderCredentialService } from '../server/src/providerCredentials';

declare const kernel: DurableKernel;
declare const vault: SecretVault;
declare const actorToken: string;
declare const identity: OwnedWorkspaceIdentity;

const providerCredentialService: ProviderCredentialService =
  new ServerProviderCredentialService(kernel, vault, actorToken, identity);

void providerCredentialService;
