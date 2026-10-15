import React, { useState } from 'react';
import { Text, View } from 'react-native';
import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import type { CloudMailCoordinator } from './cloudMailCoordinator';
import { useCloudMail } from './useCloudMail';
import { Button, Field } from '../ui/primitives';
import { formatReportedBatchCost } from '../ui/assistantBatchJobPresentation';
import { C } from '../ui/theme';

type Props = Readonly<{ coordinator?: CloudMailCoordinator; snapshot: WorkspaceSnapshotDTO; busy: boolean; blocked: boolean }>;

/** Browser mail/calendar surface. It only renders saved DTOs and calls session-owned capabilities. */
export function CloudMailWorkspace({ coordinator, snapshot, busy, blocked }: Props) {
  const state = useCloudMail(coordinator);
  const dto = snapshot.state;
  const [dispatchNote, setDispatchNote] = useState('');
  const [remoteId, setRemoteId] = useState('');
  const [visibleMessageCount, setVisibleMessageCount] = useState(10);
  const selectedAccount = dto.accounts.find((account) => account.id === state.selectedAccountId && account.connected && account.authStatus === 'connected');
  const selectedGeneration = selectedAccount?.connectionGeneration;
  const mutationBlocked = busy || blocked;
  const accounts = dto.accounts.filter((account) => account.connected && account.authStatus === 'connected' && Number.isSafeInteger(account.connectionGeneration));
  const allMessages = selectedAccount ? dto.mailbox.filter((message) => message.accountId === selectedAccount.id &&
    message.connectionGeneration === selectedGeneration && !message.providerDeletedAt && Boolean(message.verifiedIdentityKey))
    .sort((a, b) => (b.receivedAt ?? b.observedAt ?? '').localeCompare(a.receivedAt ?? a.observedAt ?? '')) : [];
  const messages = allMessages.slice(0, visibleMessageCount);
  const selectedProposal = state.proposalReview?.proposal;
  const snapshotProposal = selectedProposal ? dto.proposals.find((proposal) => proposal.id === selectedProposal.id && proposal.revision === selectedProposal.revision) : undefined;
  const proposalDraft = selectedProposal ? state.proposalDrafts?.[selectedProposal.id] : undefined;
  const canEditProposal = Boolean(selectedProposal && ['draft', 'failed', 'approved'].includes(selectedProposal.status) && selectedProposal.editPolicy !== 'read_only');
  const proposalConflict = Boolean(selectedProposal && proposalDraft && proposalDraft.baseRevision !== selectedProposal.revision);
  const proposalDirty = proposalDraft?.dirty === true;
  const proposalSaving = Boolean(selectedProposal && state.proposalSavingId === selectedProposal.id);
  const accountForProposal = selectedProposal?.accountId ? accounts.find((account) => account.id === selectedProposal.accountId) : undefined;
  const writableCalendars = selectedProposal?.accountId ? dto.calendars.filter((calendar) => calendar.accountId === selectedProposal.accountId && calendar.connected && calendar.writable) : [];
  const proposalCalendar = proposalDraft?.calendarId ? dto.calendars.find((calendar) => calendar.id === proposalDraft.calendarId &&
    calendar.accountId === selectedProposal?.accountId && calendar.connected && calendar.writable) : undefined;
  const updateProposal = () => {
    if (!coordinator || !selectedProposal || !proposalDraft || !accountForProposal || mutationBlocked || proposalConflict || proposalSaving || !proposalDirty) return;
    const edit = selectedProposal.editPolicy === 'event_fields' && selectedProposal.event && proposalCalendar ? { kind: 'event' as const, calendarId: proposalCalendar.id, title: proposalDraft.eventTitle, description: proposalDraft.eventDescription,
      start: proposalDraft.eventStart, end: proposalDraft.eventEnd, timeZone: proposalDraft.eventTimeZone, attendees: splitAddresses(proposalDraft.eventAttendees), invitePolicy: proposalDraft.eventInvite }
      : selectedProposal.email && ['email_fields', 'source_reply_fields'].includes(selectedProposal.editPolicy) ? { kind: 'email' as const,
        operation: selectedProposal.editPolicy === 'source_reply_fields' ? 'draft' as const : (selectedProposal.email.operation ?? 'draft' as const),
        to: splitAddresses(proposalDraft.to), cc: splitAddresses(proposalDraft.cc),
        bcc: selectedProposal.editPolicy === 'source_reply_fields' ? selectedProposal.email.bcc : splitAddresses(proposalDraft.bcc),
        subject: selectedProposal.editPolicy === 'source_reply_fields' ? selectedProposal.email.subject : proposalDraft.subject, text: proposalDraft.text } : undefined;
    if (!edit) return;
    void coordinator.editProposal(selectedProposal.id, accountForProposal.id, accountForProposal.connectionGeneration!, edit);
  };

  return <View style={{ paddingTop: 8, gap: 8 }}>
    <Text style={styles.heading}>Mail and calendar</Text>
    <Text style={styles.meta}>Saved mail is checked only when you ask. Sending, calendar changes, and proposal approval are separate steps.</Text>
    {state.notice ? <Text accessibilityRole="alert" style={styles.notice}>{state.notice}</Text> : null}
    {state.replyHeldCommand ? <View style={styles.card}><Text style={styles.meta}>A mail command is awaiting its exact receipt. It will not be sent again.</Text>
      <Button label="Inspect exact mail command" tone="quiet" disabled={busy} onPress={() => { void coordinator?.inspectHeldCommand(); }} /></View> : null}

    <Text style={styles.section}>Choose a connected account</Text>
    {accounts.length ? accounts.map((account) => <View key={account.id} style={styles.card}>
      <Text style={styles.title}>{account.displayName || account.provider}</Text>
      <Text style={styles.meta}>{account.email || 'Email not provided'} · {account.provider}</Text>
      <Text style={styles.meta}>Access · {account.capabilities?.join(', ') || 'not listed'}</Text>
      <Button label={state.selectedAccountId === account.id ? 'Selected account' : `Use ${account.displayName || account.email || account.provider}`}
        tone={state.selectedAccountId === account.id ? 'quiet' : 'light'} disabled={!coordinator || mutationBlocked || state.selectedAccountId === account.id}
        onPress={() => coordinator?.selectAccount(account.id)} />
      {state.selectedAccountId === account.id ? <>
        <Button label="Check recent mail" tone="quiet" disabled={!coordinator || mutationBlocked} onPress={() => { void coordinator?.runAccountAction(account.id, 'accounts.refreshMail'); }} />
        <Button label="Continue older mail" tone="quiet" disabled={!coordinator || mutationBlocked} onPress={() => { void coordinator?.runAccountAction(account.id, 'accounts.continueMailBackfill'); }} />
        <Button label="Sync calendars" tone="quiet" disabled={!coordinator || mutationBlocked} onPress={() => { void coordinator?.runAccountAction(account.id, 'accounts.syncCalendars'); }} />
        <Button label="Disconnect account" tone="danger" disabled={!coordinator || mutationBlocked} onPress={() => { void coordinator?.runAccountAction(account.id, 'accounts.disconnect'); }} />
        <Text style={styles.meta}>Mail sync · {dto.syncStates[account.id]?.status ?? 'not checked'}{dto.syncStates[account.id]?.lastError ? ` · ${dto.syncStates[account.id]?.lastError}` : ''}</Text>
      </> : null}
    </View>) : <Text style={styles.meta}>No connected account is available. Open Settings → Connections to add one.</Text>}

    {selectedAccount ? <>
      <Text style={styles.section}>Recent saved mail</Text>
      {messages.length ? messages.map((message) => <View key={`${message.accountId}:${message.connectionGeneration}:${message.id}`} style={styles.card}>
        <Text style={styles.title}>{message.subject || '(no subject)'}</Text>
        <Text style={styles.meta}>{message.from || 'Sender unavailable'} · {message.receivedAt ? new Date(message.receivedAt).toLocaleString() : 'Date unavailable'}</Text>
        {message.snippet ? <Text style={styles.body}>{message.snippet}</Text> : null}
        <Button label="Reply" disabled={!coordinator || mutationBlocked || message.replyMetadataComplete !== true} onPress={() => { void coordinator?.openReply(message.id); }} />
        {message.replyMetadataComplete !== true ? <Text style={styles.meta}>Reply details are not complete for this saved message.</Text> : null}
      </View>) : <Text style={styles.meta}>No recent saved mail for this account. Check recent mail when you are ready.</Text>}
      {messages.length < allMessages.length ? <Button label={`Show more saved mail (${allMessages.length - messages.length} remaining)`} tone="quiet"
        onPress={() => setVisibleMessageCount((count) => Math.min(allMessages.length, count + 10))} /> : null}

      <Text style={styles.section}>Connected calendars</Text>
      {dto.calendars.filter((calendar) => calendar.accountId === selectedAccount.id && calendar.connected).map((calendar) => <View key={calendar.id} style={styles.card}>
        <Text style={styles.title}>{calendar.name}</Text><Text style={styles.meta}>{calendar.writable ? 'Can create events' : 'Read only'} · {calendar.providerId ?? 'Calendar identifier unavailable'}</Text>
      </View>)}
      {!dto.calendars.some((calendar) => calendar.accountId === selectedAccount.id && calendar.connected) ? <Text style={styles.meta}>No connected calendars are saved for this account. Sync calendars when you are ready.</Text> : null}
    </> : <View style={styles.card}><Text style={styles.meta}>Choose an account above to see its saved mail and calendars. The workspace will not choose an account for you.</Text></View>}

    {state.replyDraft ? <View style={styles.card}>
      <View style={styles.row}><Text style={styles.title}>Reply</Text><Button label="Close reply" tone="quiet" onPress={() => coordinator?.closeReply()} /></View>
      {state.replyBusy === 'opening' ? <Text style={styles.meta}>Loading saved message details…</Text> : null}
      {state.replyBusy === 'loading_text' ? <Text style={styles.meta}>Loading saved message text…</Text> : null}
      {state.replySource?.source ? <>
        <Text style={styles.meta}>From {state.replySource.source.from ?? state.replySource.source.senderEmail ?? 'sender unavailable'} · {state.replySource.source.accountId}</Text>
        <Text style={styles.meta}>Subject · {state.replySource.source.subject} · checked {state.replySource.source.observedAt}</Text>
        <Text style={styles.meta}>Message text · {state.replyText?.snapshot?.completeness ?? state.replySource.bodyCache.completeness ?? 'not available'} · {state.replyText?.snapshot?.representation ?? state.replySource.bodyCache.representation ?? 'not loaded'}</Text>
        {state.replyNeedsRebind ? <View style={styles.card}><Text style={styles.notice}>The saved message changed since this draft was opened. Your text is preserved. Confirm the current recipients before saving or queueing assistance.</Text>
          <Button label="Use current message and recipients" tone="quiet" disabled={!coordinator} onPress={() => coordinator?.confirmReplyRebind()} /></View> : null}
        {state.replyText?.snapshot?.text ? <Text style={styles.body}>{state.replyText.snapshot.text}</Text> : null}
        <Button label="Load message text from account" tone="quiet" disabled={!coordinator || mutationBlocked || state.replyBusy !== undefined} onPress={() => { void coordinator?.loadMessageText(); }} />
        <Text style={styles.meta}>Reply mode · {state.replyDraft.mode === 'reply' ? 'Reply' : 'Reply all'}</Text>
        <View style={styles.row}>
          <Button label="Reply" tone={state.replyDraft.mode === 'reply' ? 'light' : 'quiet'} disabled={state.replyDraft.mode === 'reply'} onPress={() => coordinator?.updateReplyMode('reply')} />
          <Button label="Reply all" tone={state.replyDraft.mode === 'reply_all' ? 'light' : 'quiet'} disabled={state.replyDraft.mode === 'reply_all'} onPress={() => coordinator?.updateReplyMode('reply_all')} />
        </View>
        <Field label="To" value={state.replyDraft.to} onChangeText={(to) => coordinator?.updateReplyDraft({ to })} />
        <Field label="Cc" value={state.replyDraft.cc} onChangeText={(cc) => coordinator?.updateReplyDraft({ cc })} />
        <Field label="Reply text" value={state.replyDraft.text} onChangeText={(text) => coordinator?.updateReplyDraft({ text })} multiline />
        <Button label="Save reply for review" disabled={!coordinator || mutationBlocked || state.replyNeedsRebind || !state.replyDraft.text.trim() || state.replyBusy !== undefined} onPress={() => { void coordinator?.saveReply(); }} />
        <Text style={styles.section}>Optional delayed reply assistance</Text>
        <Field label="What should the reply cover?" value={state.replyDraft.brief} onChangeText={(brief) => coordinator?.updateReplyDraft({ brief })} multiline />
        <Button label={state.replyDraft.useSavedText ? 'Use saved message text for this request' : 'Include saved message text'} tone="quiet"
          disabled={!state.replyText?.snapshot?.textDigest} onPress={() => coordinator?.updateReplyDraft({ useSavedText: !state.replyDraft?.useSavedText })} />
        <Button label="Queue delayed reply request" tone="quiet" disabled={!coordinator || mutationBlocked || state.replyNeedsRebind || state.replyBusy !== undefined || !state.replyDraft.useSavedText || !state.replyDraft.brief.trim()}
          onPress={() => { void coordinator?.submitReplyBatch(); }} />
        {dto.assistantBatchJobs.filter((job) => job.kind === 'mail_reply' && job.mailMessageId === state.replyDraft?.messageId).map((job) => <View key={job.id} style={styles.card}>
          <Text style={styles.meta}>Reply request · {job.status === 'processing' && job.resultObservedAt ? 'provider finished; result storage awaits confirmation' : job.status} · provider-reported usage {job.promptTokens !== undefined || job.completionTokens !== undefined ? `${job.promptTokens ?? 'unknown'} input · ${job.completionTokens ?? 'unknown'} output tokens` : 'not reported'}</Text>
          {job.costStatus === 'reported' ? <Text style={styles.meta}>{job.billingScope === 'byok_fee_only' ? 'OpenRouter-reported BYOK fee' : 'OpenRouter-reported cost'} · {formatReportedBatchCost(job.providerReportedCostUsd) ?? 'amount unavailable'}</Text>
            : job.costStatus === 'waiting' ? <Text style={styles.meta}>Provider-reported usage is not available yet.</Text>
              : job.costStatus === 'unavailable' ? <Text style={styles.meta}>The provider did not report a cost for this request.</Text>
                : <Text style={styles.meta}>Provider-reported cost is not available.</Text>}
          <Button label="Check reply request" tone="quiet" disabled={!coordinator || mutationBlocked} onPress={() => { void coordinator?.checkReplyBatch(job.id); }} />
          {job.canReviewMailReply ? <><Button label="Prepare draft proposal for review" tone="quiet" disabled={!coordinator || mutationBlocked} onPress={() => { void coordinator?.prepareReplyBatchReview(job.id, 'draft'); }} />
            <Button label="Prepare send proposal for review" tone="quiet" disabled={!coordinator || mutationBlocked} onPress={() => { void coordinator?.prepareReplyBatchReview(job.id, 'send'); }} /></> : null}
        </View>)}
      {state.batchReview?.plan ? <View style={styles.card}>
        <Text style={styles.title}>Review delayed reply result</Text>
        <Text style={styles.meta}>Account · {accounts.find((account) => account.id === state.batchReview?.plan?.accountId)?.displayName || 'saved connected account'}</Text>
        <Text style={styles.meta}>Operation · {state.batchReview.plan.operation} · {state.batchReview.plan.mode} · expires {new Date(state.batchReview.plan.expiresAt).toLocaleString()}</Text>
        <Text style={styles.meta}>To · {state.batchReview.plan.to.join(', ') || 'none'} · Cc · {state.batchReview.plan.cc.join(', ') || 'none'}</Text>
        <Text style={styles.meta}>Subject · {state.batchReview.plan.subject}</Text>
        <Text style={styles.body}>{state.batchReview.plan.text}</Text>
        {state.batchReview.plan.contextMessages?.map((context) => <Text style={styles.meta} key={context.selectionId}>
          Context · {context.subject} · {context.representation} · {context.completeness}{context.omissionReasons.length ? ` · ${context.omissionReasons.join(', ')}` : ''}
        </Text>)}
        <Button label="Activate reviewed reply proposal" disabled={!coordinator || mutationBlocked}
          onPress={() => { void coordinator?.activateReplyBatch(); }} />
      </View> : null}
      </> : null}
    </View> : null}

    {selectedProposal ? <View style={styles.card}>
      <View style={styles.row}><Text style={styles.title}>Review proposal</Text><Button label="Close review" tone="quiet" onPress={() => coordinator?.closeProposal()} /></View>
      <Text style={styles.meta}>Status · {selectedProposal.status} · revision {selectedProposal.revision}{selectedProposal.lastError ? ` · ${selectedProposal.lastError}` : ''}</Text>
      {proposalConflict ? <View style={styles.card}><Text accessibilityRole="alert" style={styles.notice}>The saved proposal changed while these fields were open. Your edits are preserved. Reload the current review before saving or approving.</Text>
        <Button label="Reload saved proposal" tone="quiet" disabled={!coordinator || busy} onPress={() => { void coordinator?.openProposal(selectedProposal.id).then(() => coordinator.reloadProposalDraft(selectedProposal.id)); }} /></View> : null}
      {selectedProposal.email ? <>
        {selectedProposal.editPolicy === 'source_reply_fields' ? <Text style={styles.meta}>This reply is bound to its saved source. Its subject, Bcc, attachments, and operation are fixed. You can revise recipients and message text.</Text> : null}
        {selectedProposal.editPolicy === 'read_only' ? <Text style={styles.meta}>This saved reply cannot be edited. Review its contents and use the separate approval and execution steps when available.</Text> : null}
        {canEditProposal && proposalDraft ? <>
          <Field label="To" value={proposalDraft.to} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { to: value })} /><Field label="Cc" value={proposalDraft.cc} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { cc: value })} />
          {selectedProposal.editPolicy === 'source_reply_fields' ? <><Text style={styles.meta}>Subject · {selectedProposal.email.subject}</Text><Text style={styles.meta}>Bcc · {selectedProposal.email.bcc.join(', ') || 'none'}</Text>
            <Text style={styles.meta}>Operation · {selectedProposal.email.operation ?? 'draft'}</Text></> : <><Field label="Bcc" value={proposalDraft.bcc} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { bcc: value })} /><Field label="Subject" value={proposalDraft.subject} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { subject: value })} /></>}
          <Field label="Message" value={proposalDraft.text} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { text: value })} multiline />
        </> : <><Text style={styles.meta}>To · {selectedProposal.email.to.join(', ') || 'none'} · Cc · {selectedProposal.email.cc.join(', ') || 'none'}</Text>
          <Text style={styles.meta}>Subject · {selectedProposal.email.subject}</Text><Text style={styles.body}>{selectedProposal.email.text}</Text></>}
        {selectedProposal.email.attachments.map((attachment, index) => <Text style={styles.meta} key={`${attachment.fileName}:${index}`}>Attachment · {attachment.fileName} · {attachment.mimeType} · {attachment.sizeBytes} bytes</Text>)}
      </> : selectedProposal.event ? <>
        <Text style={styles.meta}>Calendar · {proposalCalendar?.name ?? (selectedProposal.calendarId ? 'Saved calendar is not in the connected writable list.' : 'Choose a connected writable calendar for this account.')}</Text>
        {canEditProposal && proposalDraft && writableCalendars.length ? <View style={styles.row}>{writableCalendars.map((calendar) => <Button key={calendar.id} label={calendar.name}
          tone={proposalDraft.calendarId === calendar.id ? 'light' : 'quiet'} disabled={proposalDraft.calendarId === calendar.id}
          onPress={() => coordinator?.updateProposalDraft(selectedProposal.id, { calendarId: calendar.id })} />)}</View>
          : canEditProposal ? <Text style={styles.meta}>No connected writable calendars are available for the proposal account.</Text> : null}
        {canEditProposal && proposalDraft ? <>
          <Field label="Event title" value={proposalDraft.eventTitle} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { eventTitle: value })} /><Field label="Description" value={proposalDraft.eventDescription} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { eventDescription: value })} multiline />
          <Field label="Starts (ISO date/time)" value={proposalDraft.eventStart} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { eventStart: value })} /><Field label="Ends (ISO date/time)" value={proposalDraft.eventEnd} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { eventEnd: value })} />
          <Field label="Time zone" value={proposalDraft.eventTimeZone} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { eventTimeZone: value })} /><Field label="Attendees" value={proposalDraft.eventAttendees} onChangeText={(value) => coordinator?.updateProposalDraft(selectedProposal.id, { eventAttendees: value })} />
        </> : <><Text style={styles.meta}>{selectedProposal.event.title ?? selectedProposal.title}</Text><Text style={styles.body}>{selectedProposal.event.description ?? selectedProposal.body}</Text>
          <Text style={styles.meta}>{selectedProposal.event.start} – {selectedProposal.event.end} · {selectedProposal.event.timeZone}</Text></>}
        <Text style={styles.meta}>Invitation behavior · {selectedProposal.event.invitePolicy === 'send' ? 'Send invitations after the separate execute step' : 'Do not send invitations'}</Text>
        {canEditProposal && proposalDraft ? <View style={styles.row}><Button label="No invitations" tone={proposalDraft.eventInvite === 'none' ? 'light' : 'quiet'} disabled={proposalDraft.eventInvite === 'none'} onPress={() => coordinator?.updateProposalDraft(selectedProposal.id, { eventInvite: 'none' })} />
          <Button label="Send invitations" tone={proposalDraft.eventInvite === 'send' ? 'light' : 'quiet'} disabled={proposalDraft.eventInvite === 'send'} onPress={() => coordinator?.updateProposalDraft(selectedProposal.id, { eventInvite: 'send' })} /></View> : null}
      </> : <View style={{ gap: 7 }}>
        <Text style={styles.title}>{selectedProposal.title}</Text>
        <Text style={styles.meta}>{selectedProposal.kind} · saved revision {selectedProposal.revision}</Text>
        <Text style={styles.body}>{selectedProposal.body}</Text>
        {selectedProposal.recipients.length ? <Text style={styles.meta}>Recipients · {selectedProposal.recipients.join(', ')}</Text> : null}
        {selectedProposal.dueAt ? <Text style={styles.meta}>Due · {new Date(selectedProposal.dueAt).toLocaleString()}</Text> : null}
        {snapshotProposal?.noteId ? <Text style={styles.meta}>Source note · {dto.notes.find((note) => note.id === snapshotProposal.noteId)?.title ?? 'Saved note'}{snapshotProposal.sourceRevision ? ` · revision ${snapshotProposal.sourceRevision}` : ''}</Text> : null}
        {snapshotProposal?.evidence.length ? <View style={{ gap: 4 }}><Text style={styles.meta}>Saved supporting details</Text>
          {snapshotProposal.evidence.map((evidence, index) => <Text style={styles.meta} key={`${index}:${evidence.source ?? ''}`}>{evidence.quote}{evidence.source ? ` · ${evidence.source}` : ''}</Text>)}
        </View> : null}
      </View>}
      {proposalDirty ? <><Text style={styles.notice}>These fields have unsaved changes. Save them before approval or execution.</Text>
        <Button label="Discard edits and reload saved proposal" tone="quiet" disabled={!coordinator || proposalSaving} onPress={() => { coordinator?.reloadProposalDraft(selectedProposal.id); }} /></> : null}
      <Button label={proposalSaving ? 'Saving proposal…' : 'Save proposal changes'} tone="quiet" disabled={!coordinator || mutationBlocked || proposalConflict || proposalSaving || !proposalDirty || !accountForProposal || (selectedProposal.kind === 'event' && !proposalCalendar)} onPress={updateProposal} />
      {selectedProposal.status === 'draft' || selectedProposal.status === 'failed' ? <Button label="Approve this revision" disabled={!coordinator || mutationBlocked || proposalConflict || proposalDirty || proposalSaving} onPress={() => { void coordinator?.approveProposal(selectedProposal.id); }} /> : null}
      {selectedProposal.status === 'approved' ? <Button label="Execute approved action" tone="danger" disabled={!coordinator || mutationBlocked || proposalConflict || proposalDirty || proposalSaving || (selectedProposal.kind === 'event' && !proposalCalendar)} onPress={() => { void coordinator?.executeProposal(selectedProposal.id); }} /> : null}
      {['draft', 'failed', 'approved'].includes(selectedProposal.status) ? <Button label="Dismiss proposal" tone="quiet" disabled={!coordinator || mutationBlocked || proposalConflict || proposalDirty || proposalSaving} onPress={() => { void coordinator?.dismissProposal(selectedProposal.id); }} /> : null}
    </View> : null}

    <Text style={styles.section}>Saved dispatch history</Text>
    {dto.dispatchRecords.map((record) => <View key={record.id} style={styles.card}>
      <Text style={styles.title}>{record.title}</Text><Text style={styles.meta}>{record.operation} · {record.outcome} · {record.dispatchStartedAt}</Text>
      <Button label="Inspect saved dispatch" tone="quiet" disabled={!coordinator || busy} onPress={() => { void coordinator?.openDispatch(record.id); }} />
    </View>)}
    {state.dispatchReview?.record ? <View style={styles.card}>
      <View style={styles.row}><Text style={styles.title}>Saved dispatch review</Text><Button label="Close dispatch" tone="quiet" onPress={() => coordinator?.closeDispatch()} /></View>
      <Text style={styles.meta}>{state.dispatchReview.record.account.displayName} · {state.dispatchReview.record.account.email} · {state.dispatchReview.record.operation} · {state.dispatchReview.record.outcome}</Text>
      <Text style={styles.body}>{state.dispatchReview.record.title} — {state.dispatchReview.record.body}</Text>
      {state.dispatchReview.record.payload.kind === 'email' ? <><Text style={styles.meta}>To · {state.dispatchReview.record.payload.to.join(', ')}</Text>
        {state.dispatchReview.record.payload.cc.length ? <Text style={styles.meta}>Cc · {state.dispatchReview.record.payload.cc.join(', ')}</Text> : null}
        {state.dispatchReview.record.payload.bcc.length ? <Text style={styles.meta}>Bcc · {state.dispatchReview.record.payload.bcc.join(', ')}</Text> : null}
        <Text style={styles.body}>{state.dispatchReview.record.payload.text}</Text></> : <>
        <Text style={styles.meta}>Calendar · {state.dispatchReview.record.calendar?.name ?? 'unavailable'} · {state.dispatchReview.record.payload.timeZone}</Text>
        <Text style={styles.meta}>{state.dispatchReview.record.payload.start} – {state.dispatchReview.record.payload.end} · invitations {state.dispatchReview.record.payload.invitePolicy}</Text>
        <Text style={styles.meta}>Attendees · {state.dispatchReview.record.payload.attendees.join(', ') || 'none'}</Text></>}
      {state.dispatchReview.record.outcome === 'unknown' ? <>
        <Field label="Reconciliation note" value={dispatchNote} onChangeText={setDispatchNote} />
        <Field label="Remote identifier (if known)" value={remoteId} onChangeText={setRemoteId} />
        <Button label="Confirm present" tone="quiet" disabled={!coordinator || mutationBlocked || !state.dispatchReview.recordVersion || !dispatchNote.trim()} onPress={() => { void coordinator?.reconcileDispatch(state.dispatchReview!.record!.id, { disposition: 'confirmed_present', note: dispatchNote, ...(remoteId ? { remoteId } : {}) }); }} />
        <Button label="Record not found" tone="quiet" disabled={!coordinator || mutationBlocked || !state.dispatchReview.recordVersion || !dispatchNote.trim()} onPress={() => { void coordinator?.reconcileDispatch(state.dispatchReview!.record!.id, { disposition: 'not_found', note: dispatchNote }); }} />
        <Text style={styles.meta}>A not-found result does not resend the original action.</Text>
      </> : null}
    </View> : null}
  </View>;
}

function splitAddresses(value: string): string[] { return value.split(/[\n,;]/).map((part) => part.trim()).filter(Boolean); }

const styles = {
  heading: { color: C.text, fontSize: 20, fontWeight: '700' as const, marginBottom: 6 },
  section: { color: C.text, fontSize: 16, fontWeight: '600' as const, marginTop: 14, marginBottom: 7 },
  card: { gap: 8, padding: 13, marginBottom: 9, borderRadius: 15, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  title: { color: C.text, fontSize: 14, fontWeight: '600' as const },
  meta: { color: C.muted, fontSize: 12, lineHeight: 18 },
  body: { color: C.text, fontSize: 13, lineHeight: 19 },
  notice: { color: C.sage, fontSize: 12, lineHeight: 18, marginVertical: 8 },
  row: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, gap: 7 },
};
