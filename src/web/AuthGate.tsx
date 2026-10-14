import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AuthClientError,
  getAuthSession,
  loginWithPassword,
  logoutSession,
  type AuthenticatedSession,
  type AuthSession,
} from './authClient';

type Props = {
  renderWorkspace: (session: AuthenticatedSession, onLogout: () => void) => React.ReactNode;
};

type Screen = 'loading' | 'guest' | 'authenticated' | 'submitting' | 'checking' | 'loggingOut' | 'blocked';
type RequestTicket = Readonly<{
  kind: 'initial' | 'check' | 'login' | 'logout';
  controller: AbortController;
  generation: number;
}>;

function safeErrorMessage(error: unknown): string {
  return error instanceof AuthClientError
    ? error.message
    : 'The sign-in response could not be confirmed. Check session.';
}

export function AuthGate({ renderWorkspace }: Props) {
  const [screen, setScreen] = useState<Screen>('loading');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [message, setMessage] = useState('');
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const requestRef = useRef<RequestTicket | null>(null);

  const admitRequest = useCallback((kind: RequestTicket['kind']) => {
    if (!mountedRef.current || requestRef.current) return null;
    const controller = new AbortController();
    generationRef.current += 1;
    const ticket = { kind, controller, generation: generationRef.current };
    requestRef.current = ticket;
    return ticket;
  }, []);

  const isCurrent = useCallback((ticket: RequestTicket) => (
    mountedRef.current && requestRef.current === ticket && generationRef.current === ticket.generation
  ), []);

  const finishRequest = useCallback((ticket: RequestTicket) => {
    if (isCurrent(ticket)) requestRef.current = null;
  }, [isCurrent]);

  const acceptSession = useCallback((next: AuthSession) => {
    setCsrfToken(next.csrfToken);
    setSession(next);
    setMessage('');
    if (next.authenticated) {
      setPassword('');
      setScreen('authenticated');
    } else {
      setScreen('guest');
    }
  }, []);

  const checkSession = useCallback(async () => {
    const ticket = admitRequest('check');
    if (!ticket) return;
    setScreen('checking');
    setMessage('');
    try {
      const current = await getAuthSession(ticket.controller.signal);
      if (!isCurrent(ticket)) return;
      acceptSession(current);
    } catch (error) {
      if (!isCurrent(ticket)) return;
      setSession(null);
      setScreen('blocked');
      setMessage(safeErrorMessage(error));
    } finally {
      finishRequest(ticket);
    }
  }, [acceptSession, admitRequest, finishRequest, isCurrent]);

  useEffect(() => {
    mountedRef.current = true;
    const ticket = admitRequest('initial');
    if (ticket) {
      void getAuthSession(ticket.controller.signal).then((initial) => {
        if (isCurrent(ticket)) acceptSession(initial);
      }).catch((error: unknown) => {
        if (!isCurrent(ticket)) return;
        setSession(null);
        setScreen('blocked');
        setMessage(safeErrorMessage(error));
      }).finally(() => finishRequest(ticket));
    }
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      requestRef.current?.controller.abort();
      requestRef.current = null;
    };
  }, [acceptSession, admitRequest, finishRequest, isCurrent]);

  const submitPassword = useCallback(async () => {
    if (screen !== 'guest' || !csrfToken || password.length === 0) return;
    const ticket = admitRequest('login');
    if (!ticket) return;
    const submittedPassword = password;
    setPassword('');
    setPasswordVisible(false);
    setMessage('');
    setScreen('submitting');
    try {
      const result = await loginWithPassword(submittedPassword, csrfToken, ticket.controller.signal);
      if (!isCurrent(ticket)) return;
      if (!result.authenticated) {
        acceptSession(result);
        setMessage('Sign-in did not open a workspace. Try again.');
        return;
      }
      acceptSession(result);
    } catch (error) {
      if (!isCurrent(ticket)) return;
      setSession(null);
      setMessage(safeErrorMessage(error));
      // Login consumes the guest challenge before password verification, so every
      // failed POST requires a deliberate GET to obtain the next challenge.
      setScreen('blocked');
    } finally {
      finishRequest(ticket);
    }
  }, [acceptSession, admitRequest, csrfToken, finishRequest, isCurrent, password, screen]);

  const logout = useCallback(async () => {
    if (screen !== 'authenticated' || !session?.authenticated) return;
    const ticket = admitRequest('logout');
    if (!ticket) return;
    const csrfToken = session.csrfToken;
    setSession(null);
    setPassword('');
    setPasswordVisible(false);
    setMessage('');
    setScreen('loggingOut');
    try {
      const result = await logoutSession(csrfToken, ticket.controller.signal);
      if (!isCurrent(ticket)) return;
      if (result.authenticated) {
        setScreen('blocked');
        setMessage('Sign-out could not be confirmed. Check session.');
        return;
      }
      acceptSession(result);
    } catch {
      if (!isCurrent(ticket)) return;
      setSession(null);
      setScreen('blocked');
      setMessage('Sign-out could not be confirmed. Check session.');
    } finally {
      finishRequest(ticket);
    }
  }, [acceptSession, admitRequest, finishRequest, isCurrent, screen, session]);

  const requestLogout = useCallback(() => { void logout(); }, [logout]);

  if (screen === 'authenticated' && session?.authenticated) {
    // This render prop receives the callback for a later user action; it is not invoked during render.
    // eslint-disable-next-line react-hooks/refs
    return <>{renderWorkspace(session, requestLogout)}</>;
  }

  const busy = screen === 'loading' || screen === 'submitting' || screen === 'checking' || screen === 'loggingOut';
  const canCheckSession = screen === 'blocked';
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.brand}>STILL</Text>
            <Text style={styles.title}>{screen === 'loggingOut' ? 'Signing out' : 'Sign in to Still'}</Text>
            <Text style={styles.subtitle}>
              {screen === 'loading' || screen === 'checking'
                ? 'Checking your session…'
                : screen === 'loggingOut'
                  ? 'Your workspace is closed while sign-out is confirmed.'
                  : canCheckSession
                    ? 'Your workspace is closed until the current session is checked.'
                    : 'Enter your workspace password to continue.'}
            </Text>
            {message ? <Text style={styles.error} accessibilityRole="alert">{message}</Text> : null}

            {busy ? (
              <View style={styles.status} accessibilityRole="progressbar" accessibilityLabel={screen === 'submitting' ? 'Signing in' : 'Checking session'}>
                <ActivityIndicator color="#a9b99b" />
                <Text style={styles.statusText}>{screen === 'submitting' ? 'Signing in…' : screen === 'loggingOut' ? 'Signing out…' : 'Please wait…'}</Text>
              </View>
            ) : canCheckSession ? (
              <Pressable style={styles.primaryButton} accessibilityRole="button" onPress={() => { void checkSession(); }}>
                <Text style={styles.primaryText}>Check session</Text>
              </Pressable>
            ) : (
              <>
                <Text style={styles.label}>Password</Text>
                <View style={styles.passwordRow}>
                  <TextInput
                    style={styles.input}
                    value={password}
                    onChangeText={setPassword}
                    onSubmitEditing={() => { void submitPassword(); }}
                    placeholder="Workspace password"
                    placeholderTextColor="#8a8c89"
                    secureTextEntry={!passwordVisible}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="current-password"
                    textContentType="password"
                    returnKeyType="go"
                    accessibilityLabel="Workspace password"
                    editable={screen === 'guest'}
                  />
                  <Pressable
                    style={styles.visibilityButton}
                    accessibilityRole="button"
                    accessibilityLabel={passwordVisible ? 'Hide password' : 'Show password'}
                    accessibilityState={{ selected: passwordVisible }}
                    onPress={() => setPasswordVisible((visible) => !visible)}
                  >
                    <Text style={styles.visibilityText}>{passwordVisible ? 'Hide' : 'Show'}</Text>
                  </Pressable>
                </View>
                <Pressable
                  style={[styles.primaryButton, (!password || !csrfToken) && styles.disabledButton]}
                  accessibilityRole="button"
                  disabled={!password || !csrfToken}
                  onPress={() => { void submitPassword(); }}
                >
                  <Text style={styles.primaryText}>Sign in</Text>
                </Pressable>
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#101113' },
  keyboard: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32 },
  card: { width: '100%', maxWidth: 440, alignSelf: 'center', padding: 28, borderRadius: 22, backgroundColor: '#181a1b', borderWidth: 1, borderColor: '#292c2b' },
  brand: { color: '#a9b99b', fontSize: 13, fontWeight: '700', letterSpacing: 3, marginBottom: 20 },
  title: { color: '#f2f2ed', fontSize: 28, lineHeight: 36, fontWeight: '600' },
  subtitle: { color: '#b6b8b3', fontSize: 16, lineHeight: 24, marginTop: 10, marginBottom: 26 },
  label: { color: '#e5e6e0', fontSize: 14, fontWeight: '600', marginBottom: 9 },
  passwordRow: { flexDirection: 'row', alignItems: 'center', minHeight: 52, borderWidth: 1, borderColor: '#3a3d3a', borderRadius: 12, backgroundColor: '#101113', marginBottom: 18 },
  input: { flex: 1, color: '#f2f2ed', fontSize: 16, minHeight: 50, paddingHorizontal: 14 },
  visibilityButton: { minWidth: 56, minHeight: 48, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' },
  visibilityText: { color: '#b8c8a9', fontSize: 14, fontWeight: '600' },
  primaryButton: { minHeight: 48, borderRadius: 12, backgroundColor: '#a9b99b', paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#171a15', fontSize: 16, fontWeight: '700' },
  disabledButton: { opacity: 0.45 },
  error: { color: '#f0a9a4', fontSize: 14, lineHeight: 20, marginTop: -12, marginBottom: 18 },
  status: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusText: { color: '#c8cbc4', fontSize: 15 },
});
