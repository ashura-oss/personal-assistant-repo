import type { AppState } from '../core';
import type { JsonValue } from '../../server/src/kernel.js';
import type { OwnedWorkspaceAdmission, OwnedWorkspaceRuntime } from './ownedWorkspaceRuntime.node';
import {
  canonicalWorkspaceCommand,
  canonicalKnowledgeDocumentParent,
  parseWorkspaceCommandEnvelope,
  parseWorkspaceCommandId,
  parseWorkspaceCommandReceipt,
  type WorkspaceCommand,
  type WorkspaceCommandEnvelope,
  type WorkspaceCommandResponse,
  type WorkspaceCommandStatus,
} from './workspaceCommands';
import { workspaceCommandKindFromJournal } from './workspaceCommandHistory';
import { withReminderSavePolicyCapture } from '../../server/src/reminderPolicyCapture.js';
import { resolveKnowledgeSourceChoice } from './knowledgeSourceChoices.node';
import type { OwnedWorkspaceIdentity } from '../../server/src/kernel.js';

export * from './workspaceCommands';

/** Execute only explicit safe controller calls through the owned command journal. */
export async function dispatchWorkspaceCommand(runtime: OwnedWorkspaceRuntime, admission: OwnedWorkspaceAdmission,
  untrustedEnvelope: unknown): Promise<WorkspaceCommandResponse> {
  const envelope = parseWorkspaceCommandEnvelope(untrustedEnvelope);
  const command = envelope.command;
  const commandInput = { ...admission, expectedRevision: envelope.expectedRevision, expectedPrivacyEpoch: envelope.expectedPrivacyEpoch,
    idempotencyKey: envelope.commandId, kind: command.kind.toLowerCase(), canonicalBody: canonicalWorkspaceCommand(envelope) };
  if (command.kind === 'notes.transcribe') {
    const result = await runtime.executeTranscriptionCommand(commandInput, { noteId: command.noteId, expectedNoteRevision: command.expectedNoteRevision });
    const expectation = expectedReceipt(envelope.commandId, command);
    if (result.admission.fresh) {
      const commandReceipt = parseWorkspaceCommandReceipt(result.result, expectation);
      return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', receipt: commandReceipt,
        ...(result.snapshot ? { snapshot: result.snapshot } : {}) });
    }
    const status = result.admission.status as WorkspaceCommandStatus;
    if (status === 'finished') {
      const commandReceipt = parseWorkspaceCommandReceipt(result.admission.receipt, expectation);
      return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status, receipt: commandReceipt,
        ...(result.snapshot ? { snapshot: result.snapshot } : {}) });
    }
    return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status });
  }
  const result = await runtime.executeCommand(commandInput, async (controller, identity) => {
    switch (command.kind) {
      case 'settings.update': {
        await controller.saveSettings({ ...command.patch, llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
        return receipt(envelope, command, { objectId: 'workspace-settings' });
      }
      case 'tasks.complete': return receipt(envelope, command, { objectId: (await controller.completeTask(command.taskId)).id });
      case 'tasks.reopen': return receipt(envelope, command, { objectId: (await controller.reopenTask(command.taskId)).id });
      case 'chat.create': return receipt(envelope, command, { objectId: (await controller.createChatConversation(command.title)).id });
      case 'chat.conversation.delete': {
        await controller.deleteChatConversation(command.conversationId);
        return receipt(envelope, command, { objectId: command.conversationId, conversationId: command.conversationId });
      }
      case 'backup.import.apply': {
        const archive = await controller.applyBackupImport({ sessionId: command.sessionId, planHash: command.planHash });
        return receipt(envelope, command, { objectId: archive.id, archiveId: archive.id, imported: true });
      }
      case 'backup.document.activate': {
        const result = await controller.activateImportedDocument({ archiveId: command.archiveId, documentId: command.documentId,
          destinationPath: command.destinationPath, contentDigest: command.contentDigest,
          ...(command.expectedCurrentRevision === undefined ? {} : { expectedCurrentRevision: command.expectedCurrentRevision }),
          replaceConfirmed: command.replaceConfirmed });
        return receipt(envelope, command, { objectId: result.document.path, archiveId: command.archiveId, documentId: command.documentId,
          documentRevision: result.document.revision, status: result.status, mirrorPending: result.mirrorPending });
      }
      case 'backup.knowledge.activate': {
        const result = await controller.activateImportedKnowledgeEntity({ sessionId: command.sessionId, planHash: command.planHash,
          ...(command.expectedDocumentRevision === undefined ? {} : { expectedDocumentRevision: command.expectedDocumentRevision }) });
        return receipt(envelope, command, { objectId: result.entity.id, documentPath: result.document.path, documentRevision: result.document.revision });
      }
      case 'backup.chat.delete': {
        await controller.deleteImportedChatConversation({ archiveId: command.archiveId, conversationId: command.conversationId });
        return receipt(envelope, command, { objectId: command.conversationId, archiveId: command.archiveId,
          conversationId: command.conversationId, deleted: true });
      }
      case 'notes.confirmImportedTimeZone': {
        const note = await controller.confirmImportedNoteTimeZone(command.noteId, {
          timeZone: command.timeZone, expectedRevision: command.expectedNoteRevision,
        });
        if (typeof note.captureTimeZone !== 'string') throw new Error('workspace_note_timezone_confirmation_unavailable');
        return receipt(envelope, command, { objectId: note.id, noteId: note.id, noteRevision: note.revision, timeZone: note.captureTimeZone });
      }
      case 'chat.transcript.prepare': {
        const plan = await controller.prepareChatFromTranscript({ noteId: command.noteId, expectedRevision: command.expectedNoteRevision });
        return receipt(envelope, command, { objectId: plan.noteId, noteId: plan.noteId, noteRevision: plan.noteRevision,
          planId: plan.planId, expiresAt: plan.expiresAt, capturedAt: plan.capturedAt, captureTimeZone: plan.captureTimeZone });
      }
      case 'chat.transcript.cancel': {
        await controller.cancelChatFromTranscript(command.planId);
        return receipt(envelope, command, { objectId: command.planId, planId: command.planId });
      }
      case 'chat.transcript.submit': {
        const result = await controller.submitChatFromTranscriptForCommand({ planId: command.planId, conversationId: command.conversationId });
        if (result.kind === 'not_submitted') return receipt(envelope, command, { objectId: command.conversationId,
          planId: command.planId, conversationId: command.conversationId, outcome: 'not_submitted', reason: result.reason });
        return receipt(envelope, command, { objectId: result.conversationId, planId: command.planId,
          conversationId: result.conversationId, outcome: 'submitted', turnId: result.turnId, jobId: result.jobId });
      }
      case 'notes.save': return receipt(envelope, command, { objectId: (await controller.saveNote({ transcript: command.transcript })).id });
      case 'notes.capture.adopt': return receipt(envelope, command, {
        objectId: (await controller.savePendingCapture({ id: command.captureId, revision: command.captureRevision })).id,
        captureId: command.captureId, captureRevision: command.captureRevision,
      });
      case 'accounts.installOAuth': {
        const account = await controller.installOAuthStage(command.stageId);
        return receipt(envelope, command, { objectId: account.id, stageId: command.stageId,
          accountGeneration: account.connectionGeneration ?? 0 });
      }
      case 'accounts.syncCalendars': {
        const result = await controller.syncCalendarsForCommand(command.accountId, { expectedConnectionGeneration: command.expectedConnectionGeneration, continue: command.continue });
        return receipt(envelope, command, { objectId: command.accountId, accountId: command.accountId, connectionGeneration: result.connectionGeneration,
          syncStatus: result.state.status, calendarsPartial: result.state.calendarsPartial });
      }
      case 'accounts.refreshMail': case 'accounts.continueMailBackfill': {
        const result = command.kind === 'accounts.refreshMail'
          ? await controller.refreshMailHeadForCommand(command.accountId, { expectedConnectionGeneration: command.expectedConnectionGeneration })
          : await controller.continueMailBackfillForCommand(command.accountId, { expectedConnectionGeneration: command.expectedConnectionGeneration });
        return receipt(envelope, command, { objectId: command.accountId, accountId: command.accountId, connectionGeneration: result.connectionGeneration,
          lane: result.result.lane, laneStatus: result.result.status, syncStatus: result.result.state.status });
      }
      case 'accounts.disconnect': {
        const result = await controller.disconnectAccountForCommand(command.accountId, { expectedConnectionGeneration: command.expectedConnectionGeneration });
        return receipt(envelope, command, { objectId: result.account.id, accountId: result.account.id,
          connectionGeneration: result.account.connectionGeneration ?? command.expectedConnectionGeneration + 1, connected: false, cleanup: result.cleanup });
      }
      case 'mail.source.loadText': {
        const result = await controller.loadMailReplyTextForCommand({ messageId: command.messageId, accountId: command.accountId,
          expectedConnectionGeneration: command.expectedConnectionGeneration, sourceDigest: command.sourceDigest });
        return receipt(envelope, command, { objectId: command.messageId, accountId: command.accountId,
          connectionGeneration: command.expectedConnectionGeneration, sourceDigest: command.sourceDigest, loadStatus: result.status,
          ...(result.snapshot?.textDigest ? { textDigest: result.snapshot.textDigest } : {}), ...(result.snapshot ? { bytes: result.snapshot.bytes } : {}) });
      }
      case 'mail.reply.create': {
        const proposal = await controller.createMailReplyProposalForCommand({ messageId: command.messageId, accountId: command.accountId,
          expectedConnectionGeneration: command.expectedConnectionGeneration, sourceDigest: command.sourceDigest, mode: command.mode,
          text: command.text, to: command.to, cc: command.cc });
        return receipt(envelope, command, { objectId: proposal.id, proposalId: proposal.id, proposalRevision: proposal.revision });
      }
      case 'mail.reply.derive': {
        const proposal = await controller.deriveManualMailReplyForCommand({ parentProposalId: command.parentProposalId,
          expectedParentRevision: command.expectedParentRevision,
          accountId: command.accountId, expectedConnectionGeneration: command.expectedConnectionGeneration, operation: command.operation });
        return receipt(envelope, command, { objectId: proposal.id, parentProposalId: command.parentProposalId,
          proposalId: proposal.id, proposalRevision: proposal.revision, operation: command.operation });
      }
      case 'mail.reply.promoteDraft': {
        const proposal = await controller.promoteAcceptedMailReplyDraftForCommand({ parentProposalId: command.parentProposalId,
          expectedParentRevision: command.expectedParentRevision, draftDispatchRecordId: command.draftDispatchRecordId,
          accountId: command.accountId, expectedConnectionGeneration: command.expectedConnectionGeneration });
        return receipt(envelope, command, { objectId: proposal.id, parentProposalId: command.parentProposalId,
          parentProposalRevision: command.expectedParentRevision, draftDispatchRecordId: command.draftDispatchRecordId,
          childProposalId: proposal.id, childProposalRevision: proposal.revision, accountId: command.accountId,
          connectionGeneration: command.expectedConnectionGeneration, operation: 'send' });
      }
      case 'proposals.edit': {
        const proposal = await controller.editProposalForCommand(command.proposalId, { expectedRevision: command.expectedProposalRevision,
          accountId: command.accountId, expectedConnectionGeneration: command.expectedConnectionGeneration, edit: command.edit });
        return receipt(envelope, command, { objectId: proposal.id, proposalId: proposal.id, proposalRevision: proposal.revision, proposalStatus: proposal.status });
      }
      case 'proposals.approve': {
        const proposal = await controller.approveProposal(command.proposalId, { expectedRevision: command.expectedProposalRevision });
        return receipt(envelope, command, { objectId: proposal.id, proposalId: proposal.id, proposalRevision: proposal.revision, proposalStatus: proposal.status });
      }
      case 'proposals.dismiss': {
        const proposal = await controller.dismissProposal(command.proposalId, { expectedRevision: command.expectedProposalRevision });
        return receipt(envelope, command, { objectId: proposal.id, proposalId: proposal.id, proposalRevision: proposal.revision, proposalStatus: proposal.status });
      }
      case 'proposals.execute': {
        const result = await controller.executeProposalForCommand(command.proposalId, { expectedRevision: command.expectedProposalRevision });
        const proposal = result.proposal;
        const execution = result.kind === 'invalidated' ? 'invalidated' : result.dispatch?.outcome ?? (result.simulated ? 'simulated' : result.localOutcome ?? 'failed');
        return receipt(envelope, command, { objectId: proposal.id, proposalId: proposal.id, proposalRevision: proposal.revision, proposalStatus: proposal.status,
          execution, ...(result.kind === 'settled' && result.dispatch ? { dispatchRecordId: result.dispatch.id, operation: result.dispatch.operation,
            ...(result.dispatch.outcomeAt ? { outcomeAt: result.dispatch.outcomeAt } : {}), ...(result.dispatch.remoteId ? { remoteId: result.dispatch.remoteId } : {}) } : {}) });
      }
      case 'dispatch.reconcile': {
        const { record, recordVersion } = await controller.reconcileDispatchForCommand(command.recordId, { expectedRecordVersion: command.expectedRecordVersion,
          disposition: command.disposition, note: command.note, ...(command.remoteId ? { remoteId: command.remoteId } : {}) });
        return receipt(envelope, command, { objectId: record.id, recordId: record.id, recordVersion, disposition: command.disposition,
          providerOutcome: record.outcome, ...(record.outcomeAt ? { providerOutcomeAt: record.outcomeAt } : {}) });
      }
      case 'mail.replyBatch.submit': {
        const job = await controller.submitMailReplyBatchForCommand({ accountId: command.accountId, expectedConnectionGeneration: command.expectedConnectionGeneration,
          messageId: command.messageId, sourceDigest: command.sourceDigest, textDigest: command.textDigest, mode: command.mode,
          to: [...command.to], cc: [...command.cc], brief: command.brief, composerRevision: command.composerRevision,
          ...(command.noteId ? { noteId: command.noteId, noteRevision: command.noteRevision } : {}),
          ...(command.contextSelectionIds ? { contextSelectionIds: command.contextSelectionIds } : {}),
          ...(command.contextExcerptSelectionIds ? { contextExcerptSelectionIds: command.contextExcerptSelectionIds } : {}) });
        return receipt(envelope, command, { objectId: job.id, jobId: job.id, jobStatus: job.status });
      }
      case 'mail.replyBatch.check': {
        const job = await controller.checkMailReplyBatchForCommand({ jobId: command.jobId, accountId: command.accountId,
          expectedConnectionGeneration: command.expectedConnectionGeneration });
        return receipt(envelope, command, { objectId: job.id, jobId: job.id, jobStatus: job.status });
      }
      case 'mail.replyBatch.review': {
        const plan = await controller.reviewMailReplyBatchForCommand({ jobId: command.jobId, accountId: command.accountId,
          expectedConnectionGeneration: command.expectedConnectionGeneration, operation: command.operation });
        return receipt(envelope, command, { objectId: command.jobId, jobId: command.jobId, planId: plan.planId, expiresAt: plan.expiresAt });
      }
      case 'mail.replyBatch.activate': {
        const result = await controller.activateMailReplyBatchForCommand({ planId: command.planId, jobId: command.jobId,
          accountId: command.accountId, expectedConnectionGeneration: command.expectedConnectionGeneration });
        return receipt(envelope, command, { objectId: result.proposalId, jobId: result.jobId, proposalId: result.proposalId });
      }
      case 'documents.save': {
        const document = await controller.saveDocument(command.path, command.content, {
          expectedRevision: command.expectedRevision ?? undefined, expectedEntityRevision: command.expectedEntityRevision,
        });
        const parent = canonicalKnowledgeDocumentParent(command.path);
        if (!parent) return receipt(envelope, command, { objectId: document.path, documentRevision: document.revision });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), parent.entityKind, parent.entityId);
        return receipt(envelope, command, { objectId: document.path, documentRevision: document.revision,
          entityKind: parent.entityKind, entityId: parent.entityId, entityRevision });
      }
      case 'knowledge.person.save': {
        const input = command.operation === 'create' ? { ...command.input, aliases: [...command.input.aliases] } : { ...command.input,
          aliases: [...command.input.aliases], expectedDocumentRevision: command.input.expectedDocumentRevision ?? undefined };
        const entity = await controller.savePerson(input);
        return receipt(envelope, command, { objectId: entity.id, entityKind: 'person', entityRevision: entity.revision });
      }
      case 'knowledge.project.save': {
        const input = command.operation === 'create' ? { ...command.input, aliases: [...command.input.aliases] } : { ...command.input,
          aliases: [...command.input.aliases], expectedDocumentRevision: command.input.expectedDocumentRevision ?? undefined };
        const entity = await controller.saveProject(input);
        return receipt(envelope, command, { objectId: entity.id, entityKind: 'project', entityRevision: entity.revision });
      }
      case 'knowledge.entity.archive': {
        const entity = await controller.setKnowledgeEntityArchived({ kind: command.entityKind, id: command.id,
          expectedRevision: command.expectedRevision, archived: command.archived });
        return receipt(envelope, command, { objectId: entity.id, entityKind: command.entityKind, entityRevision: entity.revision });
      }
      case 'knowledge.fact.save': {
        const item = await controller.saveKnowledgeFact({ entityKind: command.entityKind, entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, ...(command.itemId ? { itemId: command.itemId } : {}), statement: command.statement });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), command.entityKind, command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: command.entityKind, entityRevision, itemId: item.id });
      }
      case 'knowledge.fact.remove': {
        await controller.removeKnowledgeFact({ entityKind: command.entityKind, entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, itemId: command.itemId });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), command.entityKind, command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: command.entityKind, entityRevision, itemId: command.itemId });
      }
      case 'knowledge.contact.save': {
        const item = await controller.saveKnowledgeContact({ entityKind: 'person', entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, ...(command.itemId ? { itemId: command.itemId } : {}), address: command.address, label: command.label });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), 'person', command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: 'person', entityRevision, itemId: item.id });
      }
      case 'knowledge.contact.remove': {
        await controller.removeKnowledgeContact({ entityKind: 'person', entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, itemId: command.itemId });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), 'person', command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: 'person', entityRevision, itemId: command.itemId });
      }
      case 'knowledge.member.save': {
        const item = await controller.saveKnowledgeMember({ entityKind: 'project', entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, ...(command.itemId ? { itemId: command.itemId } : {}),
          personId: command.personId, personRevision: command.personRevision, role: command.role });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), 'project', command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: 'project', entityRevision, itemId: item.id });
      }
      case 'knowledge.member.remove': {
        await controller.removeKnowledgeMember({ entityKind: 'project', entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, itemId: command.itemId });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), 'project', command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: 'project', entityRevision, itemId: command.itemId });
      }
      case 'knowledge.sourceLink.save': {
        const current = controller.getSnapshot();
        const existing = command.itemId ? (command.entityKind === 'person'
          ? current.knowledge.people.find((entity) => entity.id === command.entityId)?.sourceLinks.find((link) => link.id === command.itemId)
          : current.knowledge.projects.find((entity) => entity.id === command.entityId)?.sourceLinks.find((link) => link.id === command.itemId)) : undefined;
        if (command.itemId && !existing) throw new Error('Source link was not found.');
        const selected = command.referenceChoiceId ? requiredSourceChoice(current, identity, command.referenceChoiceId) : undefined;
        const item = await controller.saveKnowledgeSourceLink({ entityKind: command.entityKind, entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, ...(command.itemId ? { itemId: command.itemId } : {}),
          reference: selected?.reference ?? existing!.reference, ...(selected ? { expectedSourceBinding: selected.binding } : {}), label: command.label });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), command.entityKind, command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: command.entityKind, entityRevision, itemId: item.id });
      }
      case 'knowledge.sourceLink.remove': {
        await controller.removeKnowledgeSourceLink({ entityKind: command.entityKind, entityId: command.entityId,
          expectedEntityRevision: command.expectedEntityRevision, itemId: command.itemId });
        const entityRevision = knowledgeEntityRevision(controller.getSnapshot(), command.entityKind, command.entityId);
        return receipt(envelope, command, { objectId: command.entityId, entityKind: command.entityKind, entityRevision, itemId: command.itemId });
      }
      case 'knowledge.suggestion.edit': {
        let change: import('../knowledge/types').KnowledgeChange;
        let expectedSourceBinding: string | undefined;
        if (command.change.type === 'add_source_link') {
          const selected = requiredSourceChoice(controller.getSnapshot(), identity, command.change.referenceChoiceId);
          expectedSourceBinding = selected.binding;
          const selectedReference = selected.reference;
          let currentRelatedRevision: number | undefined;
          if (selectedReference.kind === 'person') currentRelatedRevision = controller.getSnapshot().knowledge.people.find((item) => item.id === selectedReference.id)?.revision;
          else if (selectedReference.kind === 'project') currentRelatedRevision = controller.getSnapshot().knowledge.projects.find((item) => item.id === selectedReference.id)?.revision;
          const relatedRevision = command.change.referenceRevision ?? currentRelatedRevision;
          change = { type: 'add_source_link', entityKind: command.change.entityKind, entityId: command.change.entityId,
            reference: selected.reference, ...(relatedRevision !== undefined ? { referenceRevision: relatedRevision } : {}), label: command.change.label };
        } else change = command.change;
        const suggestion = await controller.editKnowledgeSuggestion(command.suggestionId, { expectedRevision: command.expectedSuggestionRevision,
          expectedTargetRevision: command.expectedTargetRevision, expectedSourceBinding, change, evidence: [...command.evidence] });
        return receipt(envelope, command, { objectId: suggestion.id, suggestionId: suggestion.id, suggestionRevision: suggestion.revision, status: 'pending' });
      }
      case 'knowledge.suggestion.review': {
        const currentSuggestion = controller.getSnapshot().knowledge.suggestions.find((item) => item.id === command.suggestionId);
        if (!currentSuggestion) throw new Error('Memory suggestion was not found.');
        if (currentSuggestion.change.type === 'add_member'
          ? command.memberPersonRevision !== currentSuggestion.change.personRevision
          : command.memberPersonRevision !== undefined) throw new Error('The selected project member changed. Refresh the suggestion before reviewing it.');
        const suggestion = await controller.reviewKnowledgeSuggestion(command.suggestionId, { expectedRevision: command.expectedSuggestionRevision,
          decision: command.decision, targetRevision: command.targetRevision, memberPersonRevision: command.memberPersonRevision });
        return receipt(envelope, command, { objectId: suggestion.id, suggestionId: suggestion.id, suggestionRevision: suggestion.revision, status: suggestion.status as 'accepted' | 'dismissed' });
      }
      case 'notes.updateTranscript': return receipt(envelope, command, {
        objectId: (await controller.updateTranscript(command.noteId, command.text, { expectedRevision: command.expectedNoteRevision })).id,
      });
      case 'assistant.batch.submitNote': {
        const job = await controller.submitNoteBatch(command.noteId, { intent: command.intent, question: command.question,
          knowledgeSelection: command.knowledgeSelection?.map(({ kind, id }) => ({ kind, id })) });
        return receipt(envelope, command, { objectId: command.noteId, jobId: job.id });
      }
      case 'assistant.batch.check': {
        await controller.refreshAssistantBatch(command.jobId);
        return receipt(envelope, command, { objectId: command.jobId });
      }
      case 'assistant.periodSummary.moreCompute.prepare': {
        const plan = await controller.preparePeriodSummaryMoreCompute({ jobId: command.jobId, effort: command.effort });
        return receipt(envelope, command, { objectId: command.jobId, jobId: command.jobId, plan });
      }
      case 'assistant.periodSummary.moreCompute.submit': {
        const job = await controller.submitPeriodSummaryMoreCompute({ planId: command.planId, jobId: command.jobId });
        return receipt(envelope, command, { objectId: command.jobId, jobId: command.jobId, jobStatus: job.status });
      }
      case 'assistant.periodSummary.moreCompute.cancel': {
        controller.cancelPeriodSummaryMoreCompute(command.planId);
        return receipt(envelope, command, { objectId: command.planId, planId: command.planId });
      }
      case 'assistant.periodSummary.application.prepare': {
        const prepared = await controller.preparePeriodSummaryApplication({ jobId: command.jobId });
        return receipt(envelope, command, { objectId: command.jobId, jobId: command.jobId,
          ...(prepared.kind === 'applied' ? { application: prepared } : { applicationPlan: prepared }) });
      }
      case 'assistant.periodSummary.application.cancel': {
        controller.cancelPeriodSummaryApplication(command.planId);
        return receipt(envelope, command, { objectId: command.planId, planId: command.planId });
      }
      case 'assistant.periodSummary.application.apply': {
        const applied = await controller.applyPeriodSummary({ planId: command.planId, jobId: command.jobId });
        return receipt(envelope, command, { objectId: command.jobId, jobId: command.jobId,
          path: applied.path, documentRevision: applied.documentRevision, appliedAt: applied.appliedAt });
      }
      case 'reminders.createDraft': {
        const record = await controller.createReminderDraftForCommand(command.payload);
        return receipt(envelope, command, { objectId: record.id, reminderId: record.id, reminderRevision: record.revision, reminderStatus: record.status });
      }
      case 'reminders.editDraft': {
        const record = await controller.updateReminderDraftForCommand(command.reminderId,
          { ...command.payload, expectedRevision: command.expectedReminderRevision });
        return receipt(envelope, command, { objectId: record.id, reminderId: record.id, reminderRevision: record.revision, reminderStatus: record.status });
      }
      case 'reminders.approve': {
        const record = await controller.approveReminderForCommand(command.reminderId, { expectedRevision: command.expectedReminderRevision });
        return receipt(envelope, command, { objectId: record.id, reminderId: record.id, reminderRevision: record.revision, reminderStatus: record.status });
      }
      case 'reminders.serverSave': {
        const record = await withReminderSavePolicyCapture({ canonicalCommandBody: canonicalWorkspaceCommand(envelope),
          commandId: envelope.commandId, reminderId: command.reminderId, expectedReminderRevision: command.expectedReminderRevision,
          deviceSelection: command.deviceSelection }, () => controller.saveApprovedReminderForCommand(command.reminderId,
          { expectedRevision: command.expectedReminderRevision }));
        return receipt(envelope, command, { objectId: record.id, reminderId: record.id, reminderRevision: record.revision, reminderStatus: record.status });
      }
      case 'reminders.cancel': {
        const record = await controller.cancelReminderForCommand(command.reminderId, { expectedRevision: command.expectedReminderRevision });
        return receipt(envelope, command, { objectId: record.id, reminderId: record.id, reminderRevision: record.revision, reminderStatus: record.status });
      }
      case 'reminders.complete': {
        const record = await controller.completeReminderForCommand(command.reminderId, { expectedRevision: command.expectedReminderRevision });
        return receipt(envelope, command, { objectId: record.id, reminderId: record.id, reminderRevision: record.revision, reminderStatus: record.status });
      }
      case 'reminders.delete': {
        const deleted = await controller.deleteReminderForCommand(command.reminderId, { expectedRevision: command.expectedReminderRevision });
        return receipt(envelope, command, { objectId: deleted.id, reminderId: deleted.id, reminderRevision: deleted.revision, deleted: true });
      }
      case 'chat.submit': {
        const accepted = await controller.submitChatTurn({ conversationId: command.conversationId, text: command.text,
          knowledgeSelection: command.knowledgeSelection?.map(({ kind, id }) => ({ kind, id })) });
        return receipt(envelope, command, { objectId: accepted.conversationId, turnId: accepted.turnId, jobId: accepted.jobId });
      }
      case 'chat.refine': {
        const accepted = await controller.refineChatTurn({ conversationId: command.conversationId, parentTurnId: command.parentTurnId, effort: command.effort });
        return receipt(envelope, command, { objectId: accepted.conversationId, parentTurnId: command.parentTurnId,
          turnId: accepted.turnId, jobId: accepted.jobId });
      }
      default: return assertNever(command);
    }
  }, (value): JsonValue => {
    const closed = parseWorkspaceCommandReceipt(value, expectedReceipt(envelope.commandId, command));
    return JSON.parse(JSON.stringify(closed)) as JsonValue;
  });

  const expectation = expectedReceipt(envelope.commandId, command);
  if (result.admission.fresh) {
    const commandReceipt = parseWorkspaceCommandReceipt(result.result, expectation);
    if (!result.snapshot) throw new Error('workspace_command_snapshot_unavailable');
    return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status: 'finished', receipt: commandReceipt, snapshot: result.snapshot });
  }

  const status = result.admission.status as WorkspaceCommandStatus;
  if (status === 'finished') {
    const commandReceipt = parseWorkspaceCommandReceipt(result.admission.receipt, expectation);
    return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status, receipt: commandReceipt,
      ...(result.snapshot ? { snapshot: result.snapshot } : {}) });
  }
  return Object.freeze({ schemaVersion: 1, commandId: envelope.commandId, status });
}

/** Inspection does no controller load, command admission, or snapshot refresh. */
export function inspectWorkspaceCommand(runtime: OwnedWorkspaceRuntime, admission: OwnedWorkspaceAdmission,
  rawCommandId: unknown): WorkspaceCommandResponse {
  const commandId = parseWorkspaceCommandId(rawCommandId);
  const admissionResult = runtime.inspectCommandReceipt(admission, commandId);
  if (!admissionResult) return Object.freeze({ schemaVersion: 1, commandId, status: 'unverified' });
  const kind = workspaceCommandKindFromJournal(admissionResult.commandKind);
  if (!kind) throw new Error('workspace_command_unexposed');
  if (admissionResult.status === 'finished') {
    const commandReceipt = parseWorkspaceCommandReceipt(admissionResult.receipt, { commandId, kind });
    return Object.freeze({ schemaVersion: 1, commandId, status: 'finished', receipt: commandReceipt });
  }
  return Object.freeze({ schemaVersion: 1, commandId, status: admissionResult.status as WorkspaceCommandStatus });
}

function receipt(envelope: WorkspaceCommandEnvelope, command: WorkspaceCommand, fields: {
  readonly objectId: string; readonly jobId?: string; readonly turnId?: string; readonly parentTurnId?: string;
  readonly captureId?: string; readonly captureRevision?: string;
  readonly stageId?: string; readonly accountGeneration?: number;
  readonly documentRevision?: number; readonly entityKind?: 'person' | 'project'; readonly entityId?: string;
  readonly entityRevision?: number; readonly itemId?: string;
  readonly suggestionId?: string; readonly suggestionRevision?: number; readonly status?: 'pending' | 'accepted' | 'dismissed' | 'activated' | 'unchanged';
  readonly accountId?: string; readonly connectionGeneration?: number; readonly syncStatus?: string; readonly calendarsPartial?: boolean;
  readonly lane?: string; readonly laneStatus?: string; readonly connected?: false; readonly cleanup?: 'complete' | 'pending';
  readonly sourceDigest?: string; readonly textDigest?: string; readonly bytes?: number; readonly proposalId?: string; readonly proposalRevision?: number; readonly parentProposalId?: string;
  readonly parentProposalRevision?: number; readonly draftDispatchRecordId?: string; readonly childProposalId?: string; readonly childProposalRevision?: number;
  readonly loadStatus?: import('../core').MailReplyTextLoadResult['status'];
  readonly proposalStatus?: import('../core').Proposal['status']; readonly execution?: 'accepted' | 'unknown' | 'rejected' | 'simulated' | 'executed' | 'failed' | 'invalidated';
  readonly dispatchRecordId?: string; readonly operation?: 'draft' | 'send' | 'event'; readonly outcomeAt?: string; readonly remoteId?: string;
  readonly recordId?: string; readonly recordVersion?: string; readonly disposition?: import('../dispatch').DispatchReconciliation;
  readonly providerOutcome?: import('../dispatch').DispatchOutcome; readonly providerOutcomeAt?: string;
  readonly jobStatus?: import('../services/openRouterBatchJobs').AssistantBatchJobDTO['status']; readonly planId?: string; readonly expiresAt?: string;
  readonly noteId?: string; readonly noteRevision?: number; readonly timeZone?: string; readonly capturedAt?: string;
  readonly captureTimeZone?: string; readonly conversationId?: string;
  readonly outcome?: 'submitted' | 'not_submitted'; readonly reason?: 'plan_unavailable';
  readonly plan?: import('../core').PeriodSummaryMoreComputePlan;
  readonly applicationPlan?: import('../core').PeriodSummaryApplicationPlan;
  readonly application?: import('../core').PeriodSummaryApplicationReceipt;
  readonly path?: string; readonly appliedAt?: string;
  readonly reminderId?: string; readonly reminderRevision?: number; readonly reminderStatus?: import('../reminders').ReminderStatus;
  readonly archiveId?: string; readonly imported?: true; readonly documentId?: string; readonly documentPath?: string;
  readonly mirrorPending?: boolean;
  readonly deleted?: true;
}) {
  return parseWorkspaceCommandReceipt({ schemaVersion: 1, commandId: envelope.commandId, kind: command.kind, ...fields },
    expectedReceipt(envelope.commandId, command));
}

function expectedReceipt(commandId: string, command: WorkspaceCommand) {
  switch (command.kind) {
    case 'settings.update': return { commandId, kind: command.kind, objectId: 'workspace-settings' };
    case 'tasks.complete': case 'tasks.reopen': return { commandId, kind: command.kind, objectId: command.taskId };
    case 'chat.create': case 'notes.save': return { commandId, kind: command.kind };
    case 'chat.conversation.delete': return { commandId, kind: command.kind, objectId: command.conversationId, conversationId: command.conversationId };
    case 'backup.import.apply': return { commandId, kind: command.kind };
    case 'backup.document.activate': return { commandId, kind: command.kind, objectId: command.destinationPath,
      archiveId: command.archiveId, documentId: command.documentId };
    case 'backup.knowledge.activate': return { commandId, kind: command.kind };
    case 'backup.chat.delete': return { commandId, kind: command.kind, objectId: command.conversationId,
      archiveId: command.archiveId, conversationId: command.conversationId };
    case 'notes.confirmImportedTimeZone': return { commandId, kind: command.kind, objectId: command.noteId, noteId: command.noteId,
      noteRevision: command.expectedNoteRevision + 1, timeZone: command.timeZone };
    case 'chat.transcript.prepare': return { commandId, kind: command.kind, objectId: command.noteId, noteId: command.noteId,
      noteRevision: command.expectedNoteRevision };
    case 'chat.transcript.cancel': return { commandId, kind: command.kind, objectId: command.planId, planId: command.planId };
    case 'chat.transcript.submit': return { commandId, kind: command.kind, objectId: command.conversationId,
      conversationId: command.conversationId, planId: command.planId };
    case 'notes.capture.adopt': return { commandId, kind: command.kind, objectId: command.captureId,
      captureId: command.captureId, captureRevision: command.captureRevision };
    case 'accounts.installOAuth': return { commandId, kind: command.kind, stageId: command.stageId };
    case 'accounts.syncCalendars': case 'accounts.refreshMail': case 'accounts.continueMailBackfill': case 'accounts.disconnect':
      return { commandId, kind: command.kind, objectId: command.accountId, accountId: command.accountId };
    case 'mail.source.loadText': return { commandId, kind: command.kind, objectId: command.messageId, accountId: command.accountId,
      connectionGeneration: command.expectedConnectionGeneration, sourceDigest: command.sourceDigest };
    case 'mail.reply.create': return { commandId, kind: command.kind };
    case 'mail.reply.derive': return { commandId, kind: command.kind, parentProposalId: command.parentProposalId, operation: command.operation };
    case 'mail.reply.promoteDraft': return { commandId, kind: command.kind, parentProposalId: command.parentProposalId,
      parentProposalRevision: command.expectedParentRevision, draftDispatchRecordId: command.draftDispatchRecordId,
      accountId: command.accountId, connectionGeneration: command.expectedConnectionGeneration, operation: 'send' as const };
    case 'proposals.edit': case 'proposals.approve': case 'proposals.execute': case 'proposals.dismiss':
      return { commandId, kind: command.kind, objectId: command.proposalId, proposalId: command.proposalId };
    case 'dispatch.reconcile': return { commandId, kind: command.kind, objectId: command.recordId, recordId: command.recordId };
    case 'mail.replyBatch.submit': return { commandId, kind: command.kind };
    case 'mail.replyBatch.check': case 'mail.replyBatch.review': return { commandId, kind: command.kind, objectId: command.jobId, jobId: command.jobId };
    case 'mail.replyBatch.activate': return { commandId, kind: command.kind, jobId: command.jobId };
    case 'documents.save': {
      const parent = canonicalKnowledgeDocumentParent(command.path);
      return { commandId, kind: command.kind, objectId: command.path,
        ...(parent ? { entityKind: parent.entityKind, entityId: parent.entityId } : {}) };
    }
    case 'knowledge.person.save': return { commandId, kind: command.kind, entityKind: 'person' as const,
      ...(command.operation === 'update' ? { objectId: command.input.id } : {}) };
    case 'knowledge.project.save': return { commandId, kind: command.kind, entityKind: 'project' as const,
      ...(command.operation === 'update' ? { objectId: command.input.id } : {}) };
    case 'knowledge.entity.archive': return { commandId, kind: command.kind, objectId: command.id, entityKind: command.entityKind };
    case 'knowledge.fact.save': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: command.entityKind,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.fact.remove': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: command.entityKind, itemId: command.itemId };
    case 'knowledge.contact.save': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: 'person' as const,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.contact.remove': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: 'person' as const, itemId: command.itemId };
    case 'knowledge.member.save': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: 'project' as const,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.member.remove': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: 'project' as const, itemId: command.itemId };
    case 'knowledge.sourceLink.save': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: command.entityKind,
      ...(command.itemId ? { itemId: command.itemId } : {}) };
    case 'knowledge.sourceLink.remove': return { commandId, kind: command.kind, objectId: command.entityId, entityKind: command.entityKind, itemId: command.itemId };
    case 'knowledge.suggestion.edit': return { commandId, kind: command.kind, objectId: command.suggestionId, suggestionId: command.suggestionId,
      suggestionRevision: command.expectedSuggestionRevision + 1, status: 'pending' as const };
    case 'knowledge.suggestion.review': return { commandId, kind: command.kind, objectId: command.suggestionId, suggestionId: command.suggestionId,
      suggestionRevision: command.expectedSuggestionRevision + 1,
      status: command.decision === 'accept' ? 'accepted' as const : 'dismissed' as const };
    case 'notes.updateTranscript': return { commandId, kind: command.kind, objectId: command.noteId };
    case 'notes.transcribe': return { commandId, kind: command.kind, objectId: command.noteId, sourceRevision: command.expectedNoteRevision };
    case 'assistant.batch.submitNote': return { commandId, kind: command.kind, objectId: command.noteId };
    case 'assistant.batch.check': return { commandId, kind: command.kind, objectId: command.jobId };
    case 'assistant.periodSummary.moreCompute.prepare': return { commandId, kind: command.kind, objectId: command.jobId, jobId: command.jobId };
    case 'assistant.periodSummary.moreCompute.submit': return { commandId, kind: command.kind, objectId: command.jobId, jobId: command.jobId };
    case 'assistant.periodSummary.moreCompute.cancel': return { commandId, kind: command.kind, objectId: command.planId, planId: command.planId };
    case 'assistant.periodSummary.application.prepare': return { commandId, kind: command.kind, objectId: command.jobId, jobId: command.jobId };
    case 'assistant.periodSummary.application.cancel': return { commandId, kind: command.kind, objectId: command.planId, planId: command.planId };
    case 'assistant.periodSummary.application.apply': return { commandId, kind: command.kind, objectId: command.jobId, jobId: command.jobId };
    case 'reminders.createDraft': return { commandId, kind: command.kind };
    case 'reminders.editDraft': case 'reminders.approve': case 'reminders.serverSave':
    case 'reminders.cancel': case 'reminders.complete': case 'reminders.delete':
      return { commandId, kind: command.kind, objectId: command.reminderId };
    case 'chat.submit': return { commandId, kind: command.kind, objectId: command.conversationId };
    case 'chat.refine': return { commandId, kind: command.kind, objectId: command.conversationId, parentTurnId: command.parentTurnId };
    default: return assertNever(command);
  }
}

function requiredSourceChoice(state: AppState, identity: OwnedWorkspaceIdentity, choiceId: string) {
  const choice = resolveKnowledgeSourceChoice(state, identity.workspaceId, identity.privacyEpoch, choiceId);
  if (!choice) throw new Error('The selected source changed or is no longer available. Refresh the source choices.');
  return choice;
}

function assertNever(_value: never): never { throw new Error('workspace_command_unsupported'); }

function knowledgeEntityRevision(snapshot: AppState, kind: 'person' | 'project', id: string): number {
  const entity = kind === 'person' ? snapshot.knowledge.people.find((row) => row.id === id)
    : snapshot.knowledge.projects.find((row) => row.id === id);
  if (!entity) throw new Error('workspace_knowledge_entity_missing');
  return entity.revision;
}
