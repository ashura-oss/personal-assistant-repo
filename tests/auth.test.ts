import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorityUrl, authorizeWithBrowser, scopesFor, type ProviderAuthConfig } from '../src/auth/browser';

const browser = vi.hoisted(() => ({ openAuthSessionAsync: vi.fn() }));
vi.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: vi.fn(), openAuthSessionAsync: browser.openAuthSessionAsync }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'state-from-native-crypto' }));
vi.mock('expo-auth-session', () => ({
  ResponseType: { Code: 'code' },
  CodeChallengeMethod: { S256: 'S256' },
  makeRedirectUri: ({ native }: { native: string }) => native,
  AuthRequest: class {
    state: string;
    codeVerifier = 'pkce-verifier';
    constructor(config: { state: string }) { this.state = config.state; }
    async makeAuthUrlAsync() { return 'https://provider.example/authorize'; }
  },
}));

const google: ProviderAuthConfig = {
  provider: 'google', clientId: '123.apps.googleusercontent.com', nativeRedirectUri: 'com.googleusercontent.apps.123:/oauth2redirect',
  webRedirectUri: 'https://still.example/auth/callback?registration=web',
};
const microsoft: ProviderAuthConfig = {
  provider: 'microsoft', clientId: 'microsoft-public-client', nativeRedirectUri: 'com.still.voiceassistant.microsoft:/oauth2redirect',
  webRedirectUri: 'https://still.example/auth/callback?registration=web', authority: 'common',
};

describe('OAuth setup bridge', () => {
  beforeEach(() => browser.openAuthSessionAsync.mockReset());

  it('uses allowlisted Microsoft authorities and the OAuth2 v2 endpoint root', () => {
    expect(authorityUrl('organizations')).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0');
    expect(authorityUrl('a4a5b6c7-d8e9-4123-8abc-123456789abc')).toContain('/a4a5b6c7-d8e9-4123-8abc-123456789abc/oauth2/v2.0');
    expect(() => authorityUrl('tenant/../../evil')).toThrow(/authority/);
  });

  it('requests only the selected capabilities and keeps mail send separate', () => {
    expect(scopesFor('google', ['mail.read'])).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopesFor('google', ['mail.read'])).not.toContain('https://www.googleapis.com/auth/gmail.send');
    expect(scopesFor('microsoft', ['mail.draft'])).toContain('Mail.ReadWrite');
    expect(scopesFor('microsoft', ['mail.draft'])).not.toContain('Mail.Send');
    expect(scopesFor('microsoft', ['calendar.write'])).not.toContain('Calendars.Read');
  });

  it('returns only the auth code after validating PKCE state and the exact web callback', async () => {
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'https://still.example/auth/callback?registration=web&code=returned-code&state=state-from-native-crypto' });
    const result = await authorizeWithBrowser(microsoft, ['mail.read']);
    expect(result).toEqual({ provider: 'microsoft', authorizationCode: 'returned-code', codeVerifier: 'pkce-verifier', redirectUri: microsoft.webRedirectUri, requestedScopes: expect.arrayContaining(['openid', 'email', 'profile', 'offline_access', 'User.Read']), requestedCapabilities: ['mail.read'] });
  });

  it('rejects duplicate or mismatched state/code callback values', async () => {
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'https://still.example/auth/callback?registration=web&code=one&code=two&state=state-from-native-crypto' });
    await expect(authorizeWithBrowser(microsoft, ['mail.read'])).rejects.toThrow(/state or PKCE/);
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'https://still.example/auth/callback?registration=wrong&code=one&state=state-from-native-crypto' });
    await expect(authorizeWithBrowser(microsoft, ['mail.read'])).rejects.toThrow(/preserve/);
  });

  it('does not expose provider error text that may contain sensitive values', async () => {
    browser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'https://still.example/auth/callback?registration=web&error=access_denied&error_description=private-token-value' });
    await expect(authorizeWithBrowser(microsoft, ['mail.read'])).rejects.not.toThrow(/private-token-value/);
  });

  it('blocks Google web auth before opening a browser session', async () => {
    await expect(authorizeWithBrowser(google, ['mail.read'])).rejects.toThrow(/Use the iOS build/);
    expect(browser.openAuthSessionAsync).not.toHaveBeenCalled();
  });
});
