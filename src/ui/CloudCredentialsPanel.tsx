import React, { useEffect, useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { CloudCredentialController } from '../web/useCloudCredentials';
import type { WebCredentialKind } from '../web/credentialClient';
import { Button } from './primitives';
import { C, s } from './theme';

type RemovalChoice = WebCredentialKind | null;

function CredentialFields({ controller, blocked, onError }: { controller: CloudCredentialController; blocked: boolean; onError: (message: string) => void }) {
  const [hasOpenRouterKey, setHasOpenRouterKey] = useState(false);
  const [hasSpeechKey, setHasSpeechKey] = useState(false);
  const openRouterKey = useRef('');
  const speechKey = useRef('');
  const openRouterInput = useRef<React.ElementRef<typeof TextInput> | null>(null);
  const speechInput = useRef<React.ElementRef<typeof TextInput> | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState<RemovalChoice>(null);
  useEffect(() => () => {
    openRouterKey.current = '';
    speechKey.current = '';
    openRouterInput.current?.clear();
    speechInput.current?.clear();
  }, []);

  const submit = (kind: WebCredentialKind, value: string) => {
    if (value.trim().length === 0) return;
    const request = controller.save(kind, value, () => {
      if (kind === 'speech') {
        speechKey.current = '';
        speechInput.current?.clear();
        setHasSpeechKey(false);
      } else {
        openRouterKey.current = '';
        openRouterInput.current?.clear();
        setHasOpenRouterKey(false);
      }
    });
    if (!request.admitted) return;
    onError('');
    void request.completion.catch(() => onError('The credential request could not be completed.'));
  };

  const confirmDelete = (kind: WebCredentialKind) => {
    const request = controller.remove(kind);
    if (!request.admitted) return;
    onError('');
    setConfirmRemoval(null);
    void request.completion.catch(() => onError('The credential request could not be completed.'));
  };

  return <>
    <View style={styles.card}>
      <Text style={styles.heading}>OpenRouter</Text>
      <Text style={styles.copy}>Enter a key to save it to this workspace.</Text>
      <Text style={styles.label}>OpenRouter API key</Text>
      <TextInput
        ref={openRouterInput}
        accessibilityLabel="OpenRouter API key"
        defaultValue=""
        onChangeText={(value) => { openRouterKey.current = value; setHasOpenRouterKey(value.trim().length > 0); }}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={512}
        editable={!blocked}
        placeholder="Enter key"
        placeholderTextColor={C.muted}
        style={s.input}
      />
      <Button label="Save OpenRouter key" disabled={blocked || !hasOpenRouterKey} onPress={() => submit('openrouter', openRouterKey.current)} />
      {confirmRemoval === 'openrouter' ? <View style={styles.confirm}>
        <Text style={styles.copy}>Remove the saved OpenRouter key from this workspace?</Text>
        <Button label="Confirm remove OpenRouter key" tone="danger" disabled={blocked} onPress={() => confirmDelete('openrouter')} />
        <Button label="Keep OpenRouter key" tone="quiet" disabled={blocked} onPress={() => setConfirmRemoval(null)} />
      </View> : <Button label="Remove OpenRouter key" tone="danger" disabled={blocked || !controller.presence?.openrouter} onPress={() => setConfirmRemoval('openrouter')} />}
    </View>

    <View style={styles.card}>
      <Text style={styles.heading}>Azure Speech</Text>
      <Text style={styles.copy}>Enter a subscription key to save it to this workspace.</Text>
      <Text style={styles.label}>Azure Speech subscription key</Text>
      <TextInput
        ref={speechInput}
        accessibilityLabel="Azure Speech subscription key"
        defaultValue=""
        onChangeText={(value) => { speechKey.current = value; setHasSpeechKey(value.trim().length > 0); }}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={512}
        editable={!blocked}
        placeholder="Enter key"
        placeholderTextColor={C.muted}
        style={s.input}
      />
      <Button label="Save Azure Speech key" disabled={blocked || !hasSpeechKey} onPress={() => submit('speech', speechKey.current)} />
      {confirmRemoval === 'speech' ? <View style={styles.confirm}>
        <Text style={styles.copy}>Remove the saved Azure Speech key from this workspace?</Text>
        <Button label="Confirm remove Azure Speech key" tone="danger" disabled={blocked} onPress={() => confirmDelete('speech')} />
        <Button label="Keep Azure Speech key" tone="quiet" disabled={blocked} onPress={() => setConfirmRemoval(null)} />
      </View> : <Button label="Remove Azure Speech key" tone="danger" disabled={blocked || !controller.presence?.speech} onPress={() => setConfirmRemoval('speech')} />}
    </View>

  </>;
}

export function CloudCredentialsPanel({ controller }: { controller: CloudCredentialController }) {
  const [actionError, setActionError] = useState<Readonly<{ ownerGeneration: number; message: string }> | null>(null);
  const reportActionError = (message: string | null) => {
    setActionError(message ? { ownerGeneration: controller.ownerGeneration, message } : null);
  };
  const blocked = controller.busy || controller.pendingCommandId !== null;
  return <View style={{ gap: 13 }}>
    <Text style={s.modalTitle}>Provider credentials</Text>
    <Text style={styles.copy}>Keys are encrypted and stored on the server. They are never shown again in this browser. The Azure Speech endpoint is managed in workspace preferences.</Text>
    {controller.loading ? <Text accessibilityLiveRegion="polite" style={styles.status}>Loading saved credential status…</Text> : null}
    {controller.presence ? <View style={styles.card}>
      <Text style={styles.status}>OpenRouter · {controller.presence.openrouter ? 'configured' : 'not configured'}</Text>
      <Text style={styles.status}>Azure Speech · {controller.presence.speech ? 'configured' : 'not configured'}</Text>
    </View> : null}
    <Button label="Refresh saved status" tone="quiet" disabled={blocked || controller.loading} onPress={() => {
      reportActionError(null);
      void controller.refresh().catch(() => reportActionError('Credential status could not be refreshed.'));
    }} />
    <CredentialFields key={controller.ownerGeneration} controller={controller} blocked={blocked} onError={reportActionError} />
    {controller.pendingCommandId ? <View style={styles.pending}>
      <Text style={styles.copy}>A previous credential change needs an exact receipt check. This will not resend it.</Text>
      <Button label="Inspect pending credential change" disabled={controller.busy} onPress={() => {
        reportActionError(null);
        void controller.inspectPendingCommand().catch(() => reportActionError('The credential receipt could not be checked.'));
      }} />
    </View> : null}
    {actionError?.ownerGeneration === controller.ownerGeneration ? <Text accessibilityRole="alert" style={styles.error}>{actionError.message}</Text> : null}
    {controller.error ? <Text accessibilityRole="alert" style={styles.error}>{controller.error}</Text> : null}
    {controller.message ? <Text accessibilityLiveRegion="polite" style={styles.status}>{controller.message}</Text> : null}
  </View>;
}

const styles = {
  card: { gap: 8, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  confirm: { gap: 6, marginTop: 4 },
  heading: { color: C.text, fontSize: 15, fontWeight: '600' as const },
  copy: { color: C.muted, fontSize: 12, lineHeight: 18 },
  label: { color: C.muted, fontSize: 12 },
  status: { color: C.text, fontSize: 12, lineHeight: 18 },
  error: { color: C.red, fontSize: 13, lineHeight: 19, backgroundColor: '#241819', padding: 12, borderRadius: 11 },
  pending: { gap: 8, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 13 },
};
