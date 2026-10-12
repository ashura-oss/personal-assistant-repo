import type { ConfigContext, ExpoConfig } from 'expo/config';

function schemeFromExactRedirect(provider: 'google' | 'microsoft', redirect: string, clientId: string): string | null {
  if (!redirect) return null;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(redirect);
  if (!match) throw new Error(`The ${provider} native redirect must be an exact registered URI using a custom scheme.`);
  const actual = match[1].toLowerCase();
  let parsed: URL;
  try { parsed = new URL(redirect); } catch { throw new Error(`The ${provider} native redirect URI is malformed.`); }
  const expected = provider === 'google'
    ? `com.googleusercontent.apps.${clientId.replace(/\.apps\.googleusercontent\.com$/i, '')}`.toLowerCase()
    : actual;
  const schemeIsAllowed = provider === 'google'
    ? actual === expected && /^com\.googleusercontent\.apps\.[a-z0-9.-]+$/.test(actual)
    : /^com\.still\.voiceassistant(?:\.[a-z0-9-]+)+$/.test(actual);
  if (!clientId || !schemeIsAllowed || parsed.protocol.slice(0, -1).toLowerCase() !== actual || !parsed.pathname || parsed.search || parsed.hash || parsed.username || parsed.password || ['http', 'https', 'exp'].includes(actual)) {
    throw new Error(`The ${provider} callback scheme does not match the expected registered client scheme. Confirm the provider registration before building.`);
  }
  return actual;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const schemes = new Set<string>(['still']);
  const google = schemeFromExactRedirect('google', process.env.EXPO_PUBLIC_GOOGLE_NATIVE_REDIRECT_URI ?? '', process.env.EXPO_PUBLIC_GOOGLE_NATIVE_CLIENT_ID ?? '');
  const microsoft = schemeFromExactRedirect('microsoft', process.env.EXPO_PUBLIC_MICROSOFT_NATIVE_REDIRECT_URI ?? '', process.env.EXPO_PUBLIC_MICROSOFT_NATIVE_CLIENT_ID ?? '');
  if (google) schemes.add(google);
  if (microsoft) schemes.add(microsoft);
  return {
    ...config,
    name: config.name ?? 'Still',
    slug: config.slug ?? 'still-voice-assistant',
    version: config.version ?? '0.1.0',
    scheme: [...schemes],
  } as ExpoConfig;
};
