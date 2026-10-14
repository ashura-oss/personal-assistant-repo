import type { Note } from "../core";

/** Find the current saved native note represented by a detail selection. */
export function findCurrentNativeDetailNote(notes: readonly Note[], detail: Note | null): Note | undefined {
  return detail ? notes.find((note) => note.id === detail.id) : undefined;
}
