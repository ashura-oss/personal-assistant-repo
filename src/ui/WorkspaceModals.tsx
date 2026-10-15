import React from 'react';
import { NoteDetail, type NoteDetailProps } from './NoteDetail';

/**
 * Modal content assembled from safe display models and coordinator-owned ports.
 * The native coordinator still decides which exact note and capabilities are current.
 */
export function WorkspaceModals(props: NoteDetailProps) {
  return <NoteDetail {...props} />;
}
