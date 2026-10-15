import React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { PendingCaptureReceipt, PendingCaptureSafeStatus } from '../audio/pendingCaptureService.types';
import { PendingRecordingRecoveryPanel } from '../components/PendingRecordingRecoveryPanel';
import { Button, Field, IconButton } from './primitives';
import { C, s } from './theme';
import type { WorkspaceActionCapability } from './workspaceCapabilities';

type WorkspaceNoteDTO = WorkspaceSnapshotDTO['state']['notes'][number];
type WorkspaceProposalDTO = WorkspaceSnapshotDTO['state']['proposals'][number];
type WorkspaceAccountDTO = WorkspaceSnapshotDTO['state']['accounts'][number];
export type WorkspaceProposalCardDisplay = Readonly<Pick<WorkspaceProposalDTO, 'id' | 'revision' | 'accountId' | 'status' | 'provenance' | 'kind' | 'title' | 'body' | 'lastError'>>;

/** Note card facts shared by native and cloud surfaces; local media paths stay with the coordinator. */
export type WorkspaceNoteCardDisplay = Readonly<Pick<WorkspaceNoteDTO,
  'id' | 'revision' | 'transcript' | 'capturedAt' | 'createdAt' | 'durationSeconds' | 'audioAttachment' | 'importOrigin' | 'status'
> & { recordingAvailable: boolean }>;

export function WorkspaceNoteCard({ note, onPress }: { note: WorkspaceNoteCardDisplay; onPress: () => void }) {
  const date = new Date(note.capturedAt ?? note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const title = note.transcript.trim() || (note.recordingAvailable ? 'Voice note' : 'Untitled note');
  const accessibleTitle = title.length > 100 ? `${title.slice(0, 100)}…` : title;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open note ${accessibleTitle}`} onPress={onPress} style={({ pressed }) => [s.noteCard, pressed && s.pressed]}>
      <View style={s.noteTop}>
        <View style={s.noteGlyph}><Ionicons accessible={false} importantForAccessibility="no" name={note.recordingAvailable ? 'mic-outline' : 'document-text-outline'} size={16} color={C.muted} /></View>
        <Text style={s.noteDate}>{note.audioAttachment?.durationStatus === 'unknown' ? `${date} · duration unknown` : note.recordingAvailable ? `${date} · ${Math.max(1, Math.round(note.durationSeconds))} sec` : date}</Text>
        <Ionicons accessible={false} importantForAccessibility="no" name="chevron-forward" size={16} color={C.muted} />
      </View>
      <Text numberOfLines={2} style={s.noteTitle}>{title}</Text>
      <Text style={s.noteSub}>{note.importOrigin?.kind === 'backup_import'
        ? ['Imported', note.importOrigin.audioMissing ? 'recording not included' : 'unverified source', note.importOrigin.originalTimeZoneUnknown ? 'time zone unknown' : ''].filter(Boolean).join(' · ')
        : note.status === 'processed' ? 'Reviewed' : note.status === 'error' ? 'Needs attention' : note.transcript ? 'Transcript saved' : 'Audio saved · add a transcript when ready'}</Text>
    </Pressable>
  );
}

export type { WorkspaceActionCapability } from './workspaceCapabilities';

export type WorkspaceRecordDisplay = Readonly<{
  status: 'idle' | 'recording' | 'paused';
  canResume: boolean;
  statusLabel?: string;
  durationSeconds: number;
  meter: readonly number[];
  hasPending: boolean;
}>;
export type WorkspaceRecordingActions = Readonly<{
  start: () => void; pause: () => void; resume: () => void; stop: () => void; cancel: () => void;
  startDisabled?: boolean; savePendingDisabled?: boolean;
}>;
export type WorkspaceCaptureRecoveryActions = Readonly<{
  refresh: () => void; inspect: (receipt: PendingCaptureReceipt) => void; save: (receipt: PendingCaptureReceipt) => void;
  export: (receipt: PendingCaptureReceipt) => void; discard: (receipt?: PendingCaptureReceipt) => void; retryCleanup: () => void;
}>;

/** Same recording screen for both coordinators; native recording/recovery ports stay outside this view. */
export function RecordWorkspaceContent({ audio, recording, recovery, busy, recent, onOpenNote, onSeeAll, onWrite, storageHint = 'Your recording is saved locally before any optional processing.', unavailableTitle = 'Recording unavailable' }:
  { audio: WorkspaceRecordDisplay; recording: WorkspaceActionCapability<WorkspaceRecordingActions>; recovery: WorkspaceActionCapability<Readonly<{ status: PendingCaptureSafeStatus | null; loading: boolean; busy: boolean; error: string; actions: WorkspaceCaptureRecoveryActions }>>; busy: boolean; recent: readonly WorkspaceNoteCardDisplay[]; onOpenNote: (noteId: string, revision: number) => void; onSeeAll: () => void; onWrite: () => void; storageHint?: string; unavailableTitle?: string }) {
  const recordingActive = audio.status === 'recording' || audio.status === 'paused';
  const recoveryVisible = recovery.available && (recovery.action.loading || Boolean(recovery.action.status && recovery.action.status.kind !== 'empty'));
  const formatTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
  return <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
    <Text style={s.kicker}>RECORD</Text>
    <Text style={s.h1}>Make space{'\n'}for a thought.</Text>
    <Text style={s.intro}>Capture it first. Decide what to do with it later.</Text>
    <View style={s.recorder}>
      {!recording.available ? <>
        <View style={[s.micOuter, { opacity: 0.45 }]}><View style={s.micInner}><Ionicons accessible={false} name="mic-off-outline" size={28} color={C.bg} /></View></View>
        <Text style={s.micTitle}>{unavailableTitle}</Text>
        <Text style={s.micSub}>{recording.reason}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Write a note instead" onPress={onWrite} disabled={busy} style={s.writeInstead}><Ionicons accessible={false} name="create-outline" size={16} color={C.text} /><Text style={s.writeText}>Write a note instead</Text></Pressable>
      </> : recordingActive ? <>
        <View style={s.liveRow}><View style={[s.liveDot, audio.status === 'paused' && s.pausedDot]} /><Text style={s.liveText}>{audio.statusLabel ?? (audio.status === 'paused' ? 'Paused' : 'Recording')} · {formatTime(audio.durationSeconds)}</Text></View>
        <View style={s.wave} accessibilityLabel="Audio level meter">{audio.meter.map((value, index) => <View key={index} style={[s.waveBar, { height: 7 + value * 29 }]} />)}</View>
        <View style={s.recordControls}>
          <Button label={audio.status === 'paused' ? 'Resume' : 'Pause'} tone="quiet" disabled={busy || (audio.status === 'paused' && !audio.canResume)} onPress={audio.status === 'paused' ? recording.action.resume : recording.action.pause} icon={audio.status === 'paused' ? 'play' : 'pause'} />
          <Pressable accessibilityRole="button" accessibilityLabel="Stop and save recording" disabled={busy} onPress={recording.action.stop} style={s.stopButton}><View style={s.stopSquare} /></Pressable>
          <Button label="Discard" tone="danger" disabled={busy} onPress={recording.action.cancel} icon="trash-outline" />
        </View>
      </> : recoveryVisible ? <PendingRecordingRecoveryPanel status={recovery.action.status} loading={recovery.action.loading} busy={recovery.action.busy} error={recovery.action.error}
        onRefresh={recovery.action.actions.refresh} onInspect={recovery.action.actions.inspect} onSave={recovery.action.actions.save} onExport={recovery.action.actions.export} onDiscard={recovery.action.actions.discard} onRetryCleanup={recovery.action.actions.retryCleanup} />
        : audio.hasPending ? <>
          <Ionicons name="save-outline" size={29} color={C.sage} /><Text style={s.micTitle}>Recording ready to save</Text><Text style={s.micSub}>The audio is preserved. Retry if storage was unavailable.</Text>
          <Button label={busy ? 'Saving…' : 'Save recording'} disabled={busy || Boolean(recording.action.savePendingDisabled)} onPress={recording.action.stop} icon="save-outline" /><Button label="Discard recording" tone="danger" disabled={busy} onPress={recording.action.cancel} icon="trash-outline" />
        </> : <>
          <Pressable accessibilityRole="button" accessibilityLabel="Start recording a voice note" disabled={busy || Boolean(recording.action.startDisabled)} onPress={recording.action.start} style={s.micOuter}><View style={s.micInner}><Ionicons accessible={false} name="mic" size={30} color={C.bg} /></View></Pressable>
          <Text style={s.micTitle}>Tap to record</Text><Text style={s.micSub}>Nothing starts until you choose.</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Write a note instead" onPress={onWrite} disabled={busy} style={s.writeInstead}><Ionicons accessible={false} name="create-outline" size={16} color={C.text} /><Text style={s.writeText}>Write a note instead</Text></Pressable>
        </>}
      {recording.available && !recovery.available ? <Text style={s.micSub}>{recovery.reason}</Text> : null}
    </View>
    <View style={s.localHint}><Ionicons name="lock-closed-outline" size={15} color={C.sage} /><Text style={s.localHintText}>{storageHint}</Text></View>
    <View style={s.sectionHeader}><Text style={s.sectionTitle}>Recent notes</Text><Pressable accessibilityRole="button" onPress={onSeeAll}><Text style={s.seeAll}>See all</Text></Pressable></View>
    {recent.length ? recent.map((note) => <WorkspaceNoteCard key={note.id} note={note} onPress={() => onOpenNote(note.id, note.revision)} />)
      : <View style={s.emptySmall}><Text style={s.emptyTitle}>A little room to begin.</Text><Text style={s.emptyText}>Your recordings and handwritten notes will live here.</Text></View>}
  </ScrollView>;
}

export function WorkspaceProposalCard({ proposal, accounts, review }: { proposal: WorkspaceProposalCardDisplay; accounts: readonly Pick<WorkspaceAccountDTO, 'id' | 'provider'>[]; review: WorkspaceActionCapability<() => void> }) {
  const provider = accounts.find((account) => account.id === proposal.accountId)?.provider;
  const status = proposal.status === 'dispatching' ? 'In progress'
    : proposal.status === 'unknown' ? 'Outcome unknown'
      : proposal.status === 'failed' ? 'Needs attention'
        : proposal.status === 'simulated' ? 'Local preview'
          : proposal.status === 'accepted' ? `Accepted by ${provider === 'google' ? 'Gmail' : provider === 'microsoft' ? 'Microsoft' : 'provider'}`
            : proposal.status;
  return (
    <View style={s.proposalCard}>
      <View style={s.proposalHead}>
        <Text style={s.kind}>{proposal.provenance && 'kind' in proposal.provenance && proposal.provenance.kind === 'mail_reply' ? 'REPLY DRAFT' : proposal.kind.toUpperCase()}</Text>
        <Text style={s.status}>{status}</Text>
      </View>
      <Text style={s.proposalTitle}>{proposal.title}</Text>
      <Text style={s.proposalBody} numberOfLines={2}>{proposal.body}</Text>
      {proposal.lastError ? <Text style={s.errorText}>{proposal.lastError}</Text> : null}
      {review.available ? <Pressable accessibilityRole="button" onPress={review.action}><Text style={s.reviewLink}>Review details <Ionicons accessible={false} name="arrow-forward" size={13} color={C.text} /></Text></Pressable>
        : <Text style={s.noteSub}>{review.reason}</Text>}
    </View>
  );
}

export function WorkspaceInboxProposalList({ proposals, accounts, filter, onFilter, review, preview }:
  { proposals: readonly WorkspaceProposalCardDisplay[]; accounts: readonly Pick<WorkspaceAccountDTO, 'id' | 'provider'>[]; filter: 'pending' | 'done'; onFilter: (filter: 'pending' | 'done') => void; review: WorkspaceActionCapability<(proposalId: string, expectedRevision: number) => void>; preview?: boolean }) {
  return <>
    <Text style={s.kicker}>INBOX</Text><Text style={s.h1}>Review, when ready.</Text>
    <Text style={s.intro}>Messages and calendar changes wait for your approval.</Text>
    {preview ? <View style={s.previewBadge}><Ionicons accessible={false} name="sparkles-outline" size={14} color={C.sage} /><Text style={s.previewText}>Local preview · AI not connected</Text></View> : null}
    <View style={s.segment}>{(['pending', 'done'] as const).map((value) => <Pressable key={value} accessibilityRole="tab" accessibilityLabel={value === 'pending' ? 'To review proposals' : 'Saved actions'} accessibilityState={{ selected: filter === value }} onPress={() => onFilter(value)} style={[s.segmentOption, filter === value && s.segmentSelected]}><Text style={[s.segmentText, filter === value && s.segmentTextSelected]}>{value === 'pending' ? 'To review' : 'Saved actions'}</Text></Pressable>)}</View>
    {proposals.length ? proposals.map((proposal) => <WorkspaceProposalCard key={`${proposal.id}:${proposal.revision}`} proposal={proposal} accounts={accounts} review={review.available ? { available: true, action: () => review.action(proposal.id, proposal.revision) } : review} />)
      : <View style={s.empty}><Ionicons accessible={false} name="checkmark-circle-outline" size={28} color={C.sage} /><Text style={s.emptyTitle}>{filter === 'pending' ? 'All caught up.' : 'Nothing here yet.'}</Text><Text style={s.emptyText}>{filter === 'pending' ? 'Saved transcripts with possible next steps will appear here as editable drafts.' : 'Saved action receipts and dismissed proposals will appear here. Tasks have their own open/completed list in Library.'}</Text></View>}
  </>;
}

export function workspaceProposalCardDisplay(proposal: Pick<WorkspaceProposalDTO, 'id' | 'revision' | 'accountId' | 'status' | 'provenance' | 'kind' | 'title' | 'body' | 'lastError'>): WorkspaceProposalCardDisplay {
  return { id: proposal.id, revision: proposal.revision, ...(proposal.accountId ? { accountId: proposal.accountId } : {}), status: proposal.status,
    ...(proposal.provenance ? { provenance: proposal.provenance } : {}), kind: proposal.kind, title: proposal.title, body: proposal.body,
    ...(proposal.lastError ? { lastError: proposal.lastError } : {}) };
}

export function ManualNoteComposer({ onCancel, onSave, storageDescription = 'Saved on this device. Nothing is transcribed or processed until you choose.' }:
  { onCancel: () => void; onSave: (text: string) => void; storageDescription?: string }) {
  const [text, setText] = React.useState('');
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
      <View style={s.modalHeader}><IconButton name="chevron-back" label="Back to Record" onPress={onCancel} /><Text style={s.modalTitle}>Write a note</Text><View style={{ width: 46 }} /></View>
      <Text style={s.kicker}>LOCAL NOTE</Text><Text style={s.h1Small}>Put it into words.</Text><Text style={s.intro}>{storageDescription}</Text>
      <Field label="Your note" multiline value={text} onChangeText={setText} placeholder="What would you like to remember?" />
      <Button label="Save note" disabled={!text.trim()} onPress={() => onSave(text)} /><Button label="Cancel" tone="quiet" onPress={onCancel} />
    </ScrollView>
  </KeyboardAvoidingView>;
}

export function workspaceNoteCardDisplay(note: Pick<WorkspaceNoteDTO,
  'id' | 'revision' | 'transcript' | 'capturedAt' | 'createdAt' | 'durationSeconds' | 'audioAttachment' | 'importOrigin' | 'status'
> & { recordingAvailable: boolean }): WorkspaceNoteCardDisplay {
  return { id: note.id, revision: note.revision, transcript: note.transcript, ...(note.capturedAt ? { capturedAt: note.capturedAt } : {}), createdAt: note.createdAt,
    durationSeconds: note.durationSeconds, ...(note.audioAttachment ? { audioAttachment: note.audioAttachment } : {}), ...(note.importOrigin ? { importOrigin: note.importOrigin } : {}), status: note.status,
    recordingAvailable: note.recordingAvailable };
}
