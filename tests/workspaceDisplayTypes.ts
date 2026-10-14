import type { WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { NoteDetailDisplayNote } from '../src/ui/NoteDetail';
import type { TaskDisplay } from '../src/ui/TasksSection';
import type { TranscriptionPanelAttempt } from '../src/ui/TranscriptionPanel';

type ExpectFalse<T extends false> = T;
type _NoteHasNoLocalAudioUri = ExpectFalse<'audioUri' extends keyof NoteDetailDisplayNote ? true : false>;
type _AttemptHasNoLeaseId = ExpectFalse<'leaseId' extends keyof TranscriptionPanelAttempt ? true : false>;
export const displaySafetyTypeChecks = {
  noteHasNoLocalAudioUri: false as _NoteHasNoLocalAudioUri,
  attemptHasNoLeaseId: false as _AttemptHasNoLeaseId,
};

// These assignments compile only when the server DTO's safe, deeply readonly values
// remain directly consumable by the display leaves.
export function noteDTOForDetail(note: WorkspaceSnapshotDTO['state']['notes'][number]): NoteDetailDisplayNote {
  return note;
}

export function transcriptionDTOForPanel(snapshot: WorkspaceSnapshotDTO): readonly TranscriptionPanelAttempt[] {
  return snapshot.state.transcription.attempts;
}

export function taskDTOForSection(snapshot: WorkspaceSnapshotDTO): readonly TaskDisplay[] {
  return snapshot.state.tasks;
}
