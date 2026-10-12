import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

WebBrowser.maybeCompleteAuthSession();

export type OAuthProvider = 'google' | 'microsoft';
export type MicrosoftAuthority = 'common' | 'organizations' | 'consumers' | string;
export type AuthCapability = 'mail.read' | 'mail.draft' | 'mail.send' | 'calendar.read' | 'calendar.write';

export interface ProviderAuthConfig {
  provider: OAuthProvider;
  clientId: string;
  nativeRedirectUri: string;
  webRedirectUri: string;
  authority?: MicrosoftAuthority;
}

export interface AuthorizationCodeResult {
  provider: OAuthProvider;
  authorizationCode: string;
  codeVerifier: string;
  redirectUri: string;
  requestedScopes: string[];
  requestedCapabilities: AuthCapability[];
}

const googleScopes: Record<AuthCapability, string[]> = {
  'mail.read': ['https://www.googleapis.com/auth/gmail.readonly'],
  'mail.draft': ['https://www.googleapis.com/auth/gmail.compose'],
  'mail.send': ['https://www.googleapis.com/auth/gmail.send'],
  'calendar.read': ['https://www.googleapis.com/auth/calendar.readonly'],
  'calendar.write': ['https://www.googleapis.com/auth/calendar.events'],
};
const microsoftScopes: Record<AuthCapability, string[]> = {
  'mail.read': ['Mail.Read'],
  'mail.draft': ['Mail.ReadWrite'],
  'mail.send': ['Mail.Send'],
  'calendar.read': ['Calendars.Read'],
  'calendar.write': ['Calendars.ReadWrite'],
};

export function configuredProviderAuth(provider: OAuthProvider): ProviderAuthConfig {
  const googleClientId = Platform.OS === 'web' ? process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID : process.env.EXPO_PUBLIC_GOOGLE_NATIVE_CLIENT_ID;
  const microsoftClientId = Platform.OS === 'web' ? process.env.EXPO_PUBLIC_MICROSOFT_WEB_CLIENT_ID : process.env.EXPO_PUBLIC_MICROSOFT_NATIVE_CLIENT_ID;
  const clientId = provider === 'google' ? googleClientId?.trim() ?? '' : microsoftClientId?.trim() ?? '';
  const nativeRedirectUri = provider === 'google' ? process.env.EXPO_PUBLIC_GOOGLE_NATIVE_REDIRECT_URI?.trim() ?? '' : process.env.EXPO_PUBLIC_MICROSOFT_NATIVE_REDIRECT_URI?.trim() ?? '';
  const webRedirectUri = provider === 'google' ? process.env.EXPO_PUBLIC_GOOGLE_WEB_REDIRECT_URI?.trim() ?? '' : process.env.EXPO_PUBLIC_MICROSOFT_WEB_REDIRECT_URI?.trim() ?? '';
  const authority = provider === 'microsoft' ? process.env.EXPO_PUBLIC_MICROSOFT_AUTHORITY?.trim() || 'common' : undefined;
  return { provider, clientId, nativeRedirectUri, webRedirectUri, authority };
}

export function authorityUrl(value: MicrosoftAuthority): string {
  const segment = value.trim();
  if (!['common', 'organizations', 'consumers'].includes(segment) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) {
    throw new Error('Microsoft authority must be common, organizations, consumers, or a tenant UUID.');
  }
  return `https://login.microsoftonline.com/${segment}/oauth2/v2.0`;
}

export function scopesFor(provider: OAuthProvider, capabilities: AuthCapability[]): string[] {
  const map = provider === 'google' ? googleScopes : microsoftScopes;
  return [...new Set(['openid', 'email', 'profile', ...(provider === 'microsoft' ? ['offline_access', 'User.Read'] : []), ...capabilities.flatMap(capability => map[capability])])];
}

export function exactRedirectUri(config: ProviderAuthConfig): string {
  const registered = Platform.OS === 'web' ? config.webRedirectUri : config.nativeRedirectUri;
  if (!registered) throw new Error(Platform.OS === 'web'
    ? `Set ${config.provider === 'google' ? 'EXPO_PUBLIC_GOOGLE' : 'EXPO_PUBLIC_MICROSOFT'}_WEB_REDIRECT_URI to the exact URL registered for this web client.`
    : `Set ${config.provider === 'google' ? 'EXPO_PUBLIC_GOOGLE' : 'EXPO_PUBLIC_MICROSOFT'}_NATIVE_REDIRECT_URI to the exact URI registered for this native client, then rebuild the app.`);
  if (Platform.OS !== 'web') {
    // `native` is returned verbatim by Expo AuthSession; this guards accidental normalization.
    const result = AuthSession.makeRedirectUri({ native: registered });
    if (result !== registered) throw new Error('Expo generated a redirect URI that differs from the registered native URI. Rebuild with the exact callback value.');
    let parsed: URL;
    try { parsed = new URL(result); } catch { throw new Error('The native redirect URI is malformed.'); }
    const nativeScheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(result)?.[1] ?? '';
    const allowedScheme = config.provider === 'google' ? /^com\.googleusercontent\.apps\.[a-z0-9.-]+$/i.test(nativeScheme) : /^com\.still\.voiceassistant(?:\.[a-z0-9-]+)+$/i.test(nativeScheme);
    const expectedGoogleScheme = `com.googleusercontent.apps.${config.clientId.replace(/\.apps\.googleusercontent\.com$/i, '')}`;
    if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(nativeScheme) || !allowedScheme || (config.provider === 'google' && nativeScheme.toLowerCase() !== expectedGoogleScheme.toLowerCase()) || parsed.search || parsed.hash || parsed.username || parsed.password || !parsed.pathname || ['http', 'https', 'exp'].includes(nativeScheme)) {
      throw new Error('The native callback scheme is not registered by this app configuration. Rebuild with the exact provider callback URI.');
    }
    return result;
  }
  let parsed: URL;
  try { parsed = new URL(registered); } catch { throw new Error('The registered web redirect must be an absolute HTTPS URL.'); }
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) || parsed.hash || parsed.username || parsed.password) throw new Error('The web redirect URI must use HTTPS outside localhost and contain no credentials or fragment.');
  return registered;
}

function discovery(config: ProviderAuthConfig): AuthSession.DiscoveryDocument {
  if (config.provider === 'google') return {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  };
  const issuer = authorityUrl(config.authority ?? 'common');
  return {
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
  };
}

/** Opens a system-browser PKCE authorization request and returns only the validated code handoff. */
export async function authorizeWithBrowser(config: ProviderAuthConfig, capabilities: AuthCapability[]): Promise<AuthorizationCodeResult> {
  if (Platform.OS === 'web' && config.provider === 'google') throw new Error('Google web sign-in is not enabled in this build because code exchange requires a confidential backend. Use the iOS build to connect Google.');
  if (!config.clientId) throw new Error(`Add the ${config.provider === 'google' ? 'Google' : 'Microsoft'} public client ID before connecting.`);
  const redirectUri = exactRedirectUri(config);
  const scopes = scopesFor(config.provider, capabilities);
  const request = new AuthSession.AuthRequest({
    clientId: config.clientId,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
    scopes,
    state: Crypto.randomUUID(),
    extraParams: config.provider === 'google' ? { access_type: 'offline', prompt: 'select_account' } : { prompt: 'select_account' },
  });
  const url = await request.makeAuthUrlAsync(discovery(config));
  const result = await WebBrowser.openAuthSessionAsync(url, redirectUri, Platform.OS === 'web' ? { windowFeatures: { width: 520, height: 760 } } : undefined);
  if (result.type !== 'success') throw new Error(result.type === 'cancel' ? 'Sign-in was cancelled.' : 'Sign-in did not return to Still. Confirm the registered redirect URI and rebuild if needed.');
  const returned = new URL(result.url);
  const registered = new URL(redirectUri);
  if (returned.protocol !== registered.protocol || returned.host !== registered.host || returned.pathname !== registered.pathname || returned.hash) {
    throw new Error('Sign-in returned to a different URI than the exact registered callback.');
  }
  for (const [key, value] of registered.searchParams) {
    const values = returned.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== value) throw new Error('Sign-in callback did not preserve the exact registered redirect query.');
  }
  const states = returned.searchParams.getAll('state');
  const codes = returned.searchParams.getAll('code');
  const returnedState = states[0];
  const code = codes[0];
  const providerError = returned.searchParams.getAll('error');
  if (providerError.length > 1 || providerError.length === 1) throw new Error('Sign-in was not completed by the provider. Try again or review the provider registration.');
  if (states.length !== 1 || codes.length !== 1 || !returnedState || returnedState !== request.state || !code || !request.codeVerifier) throw new Error('Sign-in response failed state or PKCE validation. Try again.');
  return { provider: config.provider, authorizationCode: code, codeVerifier: request.codeVerifier, redirectUri, requestedScopes: scopes, requestedCapabilities: [...capabilities] };
}
