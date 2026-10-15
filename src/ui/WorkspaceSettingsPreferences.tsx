import React from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { Field, Button } from './primitives';
import { OPENROUTER_SPEECH_DEFAULT_MODEL } from '../transcription/openRouterSpeechProfiles';
import { C, s } from './theme';
import type { WorkspaceActionCapability } from './workspaceCapabilities';

export type WorkspaceSettingsDraft = Readonly<{
  providerEnabled: boolean;
  speechEnabled: boolean;
  speechProvider: 'azure' | 'openrouter';
  speechEndpoint: string;
  effort: 'none' | 'low';
  maxAudioSeconds: string;
  retention: 'keep' | 'delete_after_transcription';
}>;

export type WorkspaceSettingsPreferenceUpdate = WorkspaceActionCapability<(patch: Partial<WorkspaceSettingsDraft>) => void>;
export type WorkspaceSettingsPreferenceSave = WorkspaceActionCapability<() => Promise<unknown>>;

export function WorkspaceSettingsPreferences({ draft, update, save, busy, demoMode, description }:
  { draft: WorkspaceSettingsDraft; update: WorkspaceSettingsPreferenceUpdate; save: WorkspaceSettingsPreferenceSave; busy: boolean; demoMode: boolean; description?: string }) {
  const canEdit = update.available && !demoMode;
  const apply = (patch: Partial<WorkspaceSettingsDraft>) => { if (canEdit) update.action(patch); };
  return <View style={{ gap: 13 }}>
    <View style={s.providerToggle}>
      <View style={{ flex: 1 }}>
        <Text style={s.accountName}>Enable provider analysis</Text>
        <Text style={s.accountSub}>New text requests use delayed OpenRouter Batch. Nothing is sent until you submit a request.</Text>
      </View>
      <Switch accessibilityLabel="Enable provider analysis" value={draft.providerEnabled} onValueChange={(value) => apply({ providerEnabled: value })} disabled={!canEdit} trackColor={{ false: C.border, true: C.sage }} thumbColor={C.text} />
    </View>
    <View style={s.providerToggle}>
      <View style={{ flex: 1 }}>
        <Text style={s.accountName}>Enable {draft.speechProvider === 'azure' ? 'Azure' : 'OpenRouter'} transcription</Text>
        <Text style={s.accountSub}>Separate from AI analysis. A saved recording is uploaded only after you choose Transcribe.</Text>
      </View>
      <Switch accessibilityLabel={`Enable ${draft.speechProvider === 'azure' ? 'Azure' : 'OpenRouter'} transcription`} value={draft.speechEnabled} onValueChange={(value) => apply({ speechEnabled: value })} disabled={!canEdit} trackColor={{ false: C.border, true: C.sage }} thumbColor={C.text} />
    </View>
    <Text style={s.sectionTitle}>Speech provider</Text>
    <View style={s.pills}>{(['azure', 'openrouter'] as const).map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`Use ${value === 'azure' ? 'Azure Speech' : 'OpenRouter Speech'}`} accessibilityState={{ checked: draft.speechProvider === value }} disabled={!canEdit} onPress={() => apply({ speechProvider: value })} style={[s.pill, draft.speechProvider === value && s.pillActive, !canEdit && s.disabled]}><Text style={[s.pillText, draft.speechProvider === value && s.pillTextActive]}>{value === 'azure' ? 'Azure Speech' : 'OpenRouter'}</Text></Pressable>)}</View>
    {draft.speechProvider === 'openrouter' ? <View style={s.analysisStale}><Text style={s.accountName}>OpenRouter transcription model</Text><Text style={s.analysisText}>{OPENROUTER_SPEECH_DEFAULT_MODEL}</Text><Text style={s.disclaimer}>Choose Transcribe on a saved recording to upload it to OpenRouter. Usage appears only when reported; no cost is estimated. This does not use Batch.</Text></View> : <Field label="Speech endpoint" value={draft.speechEndpoint} onChangeText={(value) => apply({ speechEndpoint: value })} placeholder="Speech resource endpoint" keyboardType="url" editable={canEdit} />}
    <Text style={s.sectionTitle}>Text provider</Text>
    <View style={s.analysisStale}><Text style={s.accountName}>OpenRouter Batch · openai/gpt-6-luna:batch</Text><Text style={s.disclaimer}>Requests may take up to 24 hours. OpenRouter retains batch inputs and results for 30 days or until the batch is deleted. Provider cost appears only when reported; no cost is estimated.</Text></View>
    <Text style={s.label}>Reasoning effort</Text>
    <View style={s.pills}>{(['none', 'low'] as const).map((effort) => <Pressable key={effort} accessibilityRole="radio" accessibilityState={{ checked: draft.effort === effort }} disabled={!canEdit} onPress={() => apply({ effort })} style={[s.pill, draft.effort === effort && s.pillActive, !canEdit && s.disabled]}><Text style={[s.pillText, draft.effort === effort && s.pillTextActive]}>{effort}</Text></Pressable>)}</View>
    <Text style={s.sectionTitle}>Recording limits & retention</Text>
    <Field label="Maximum recording length · seconds" value={draft.maxAudioSeconds} onChangeText={(value) => apply({ maxAudioSeconds: value })} keyboardType="numeric" editable={canEdit} />
    <Text style={s.label}>Audio retention</Text>
    <View style={s.pills}>{(['keep', 'delete_after_transcription'] as const).map((retention) => <Pressable key={retention} accessibilityRole="radio" accessibilityState={{ checked: draft.retention === retention }} disabled={!canEdit} onPress={() => apply({ retention })} style={[s.pill, draft.retention === retention && s.pillActive, !canEdit && s.disabled]}><Text style={[s.pillText, draft.retention === retention && s.pillTextActive]}>{retention === 'keep' ? 'Keep until deleted' : 'Delete after transcription'}</Text></Pressable>)}</View>
    {description ? <Text style={s.disclaimer}>{description}</Text> : null}
    {!update.available ? <Text style={s.disclaimer}>{update.reason}</Text> : null}
    <Button label="Save provider and recording settings" disabled={busy || demoMode || !save.available} onPress={() => { if (save.available) void save.action(); }} />
    {!save.available ? <Text style={s.disclaimer}>{save.reason}</Text> : null}
  </View>;
}
