import type { AppState } from '../core';
import type { KnowledgeReference } from './types';

/** Private source snapshot. The binding can contain provider and device identity data. */
export type KnowledgeReferenceChoiceOption = Readonly<{
  reference: KnowledgeReference;
  label: string;
  binding: string;
}>;

/** Safe reference shape returned to a cloud client. Device events are always historicalized. */
export type KnowledgeSourceChoiceReference = Exclude<KnowledgeReference, { kind: 'device_calendar_event' }>;

function accountIdentityKey(account: AppState['accounts'][number]) {
  const identity = account.identity;
  if (!account.connected || account.authStatus !== 'connected' || account.provider === 'local' ||
      !identity?.providerNamespace || identity.providerNamespace !== account.provider ||
      !identity.clientId || !identity.subject ||
      (account.provider === 'microsoft' && !identity.resourceUserId)) return undefined;
  return [identity.providerNamespace, identity.clientId, identity.subject, identity.resourceUserId ?? ''].join(':');
}

function friendlyDocumentName(path: string) {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
}

/**
 * Builds the exact live-reference set used by native knowledge editors.
 * `now` is injectable so device-event freshness has deterministic boundaries.
 */
export function buildKnowledgeReferenceOptions(state: AppState, now = Date.now()): KnowledgeReferenceChoiceOption[] {
  const structuredNarrativePaths = new Set([
    ...state.knowledge.people.map((entity) => entity.narrativePath),
    ...state.knowledge.projects.map((entity) => entity.narrativePath),
  ]);
  const references: KnowledgeReferenceChoiceOption[] = [
    ...state.notes.filter((note) => note.origin !== 'assistant_chat').map((note) => ({ reference: { kind: 'note' as const, id: note.id }, label: `Note · ${(note.transcript || 'Untitled note').slice(0, 70)}`, binding: JSON.stringify(['note', note]) })),
    ...state.tasks.map((task) => ({ reference: { kind: 'task' as const, id: task.id }, label: `Task · ${task.title}`, binding: JSON.stringify(['task', task]) })),
    ...state.documents.filter((document) => !structuredNarrativePaths.has(document.path)).map((document) => ({ reference: { kind: 'document' as const, id: document.path }, label: `Document · ${friendlyDocumentName(document.path)}`, binding: JSON.stringify(['document', document]) })),
    ...state.knowledge.people.filter((person) => !person.archivedAt).map((person) => ({ reference: { kind: 'person' as const, id: person.id }, label: `Person · ${person.name}${person.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}`, binding: JSON.stringify(['person', person]) })),
    ...state.knowledge.projects.filter((project) => !project.archivedAt).map((project) => ({ reference: { kind: 'project' as const, id: project.id }, label: `Project · ${project.name}${project.importOrigin?.kind === 'backup_knowledge' ? ' · Imported copy' : ''}`, binding: JSON.stringify(['project', project]) })),
  ];
  for (const message of state.mailbox) {
    const account = state.accounts.find((item) => item.id === message.accountId);
    const identityKey = account && accountIdentityKey(account);
    if (!account || !identityKey || !account.capabilities?.includes('mail.read') ||
        typeof message.connectionGeneration !== 'number' || message.providerDeletedAt ||
        message.verifiedIdentityKey !== identityKey || message.identityKey !== `${identityKey}:${message.providerMessageId}` ||
        message.connectionGeneration !== account.connectionGeneration) continue;
    references.push({ reference: { kind: 'mail', id: message.providerMessageId, identityKey, connectionGeneration: message.connectionGeneration }, label: `Saved mail · ${message.subject || message.from || 'No subject'}`, binding: JSON.stringify(['mail', account, message]) });
  }
  for (const event of state.calendarEvents) {
    const account = state.accounts.find((item) => item.id === event.accountId);
    const identityKey = account && accountIdentityKey(account);
    if (!account || !identityKey || !account.capabilities?.includes('calendar.read') ||
        typeof event.connectionGeneration !== 'number' || event.providerDeletedAt ||
        event.verifiedIdentityKey !== identityKey || event.connectionGeneration !== account.connectionGeneration) continue;
    const calendar = state.calendars.find((item) => item.id === event.calendarId && item.accountId === event.accountId && item.connected);
    if (!calendar) continue;
    references.push({ reference: { kind: 'calendar', id: event.providerEventId, calendarId: calendar.providerId ?? calendar.id, identityKey, connectionGeneration: event.connectionGeneration }, label: `Saved calendar item · ${event.subject || 'Untitled event'}`, binding: JSON.stringify(['calendar', account, calendar, event]) });
  }
  if (state.deviceCalendars.enabled && state.deviceCalendarAccess.status === 'full_access') {
    for (const event of state.deviceCalendars.events) {
      const calendar = state.deviceCalendars.calendars.find((item) => item.localId === event.calendarId);
      const age = now - Date.parse(event.observedAt);
      if (!calendar || event.cancelled || event.generation !== state.deviceCalendars.generation ||
          !state.deviceCalendars.selectedCalendarIds.includes(event.calendarId) || !Number.isFinite(age) || age < 0 || age > 15 * 60_000) continue;
      references.push({
        reference: { kind: 'device_calendar_event', installationId: state.deviceCalendars.installationId, generation: event.generation,
          calendarId: event.calendarId, eventId: event.nativeEventId, occurrenceStart: event.occurrenceStart },
        label: `On this iPhone · ${calendar.title} · ${event.title || 'Untitled event'}`,
        binding: JSON.stringify(['device_calendar_event', state.deviceCalendars.installationId, state.deviceCalendars.generation,
          state.deviceCalendars.enabled, state.deviceCalendars.selectedCalendarIds, state.deviceCalendarAccess.status, calendar, event]),
      });
    }
  }
  return references;
}

/** Rechecks a previously selected private binding against the exact live source in fresh state. */
export function knowledgeReferenceBindingIsCurrent(state: AppState, binding: string, reference: KnowledgeReference): boolean {
  return buildKnowledgeReferenceOptions(state).some((option) => option.binding === binding && JSON.stringify(option.reference) === JSON.stringify(reference));
}

/** Projects reference data that is safe to send to a cloud client. */
export function projectKnowledgeSourceChoiceReference(reference: KnowledgeReference): KnowledgeSourceChoiceReference {
  switch (reference.kind) {
    case 'note': case 'task': case 'document': case 'person': case 'project':
      return { kind: reference.kind, id: reference.id };
    case 'mail':
      return { kind: 'mail', id: reference.id, identityKey: reference.identityKey, connectionGeneration: reference.connectionGeneration };
    case 'calendar':
      return { kind: 'calendar', id: reference.id, calendarId: reference.calendarId, identityKey: reference.identityKey, connectionGeneration: reference.connectionGeneration };
    case 'device_calendar_event':
      return { kind: 'historical', label: `Device calendar event (${reference.occurrenceStart})`, originalKind: 'device_calendar_event' };
    case 'historical':
      return { kind: 'historical', label: reference.label, originalKind: reference.originalKind };
  }
}
