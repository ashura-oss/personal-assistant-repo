import { describe, expect, it } from 'vitest';
import type { Note } from '../src/core';
import { findCurrentNativeDetailNote } from '../src/ui/nativeDetailSelection';

const selected: Note = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Voice note', transcript: 'Words', audioUri: 'file:///recording.m4a',
  durationSeconds: 4, createdAt: '2026-01-01T00:00:00.000Z', status: 'recorded', revision: 1,
};

describe('native note detail selection', () => {
  it('derives displayed recording availability from the current saved note after an attachment changes', () => {
    const current: Note = { ...selected, audioUri: undefined, revision: 2 };
    const displayed = findCurrentNativeDetailNote([current], selected);

    expect(displayed).toBe(current);
    expect(Boolean(displayed?.audioUri)).toBe(false);
  });
});
